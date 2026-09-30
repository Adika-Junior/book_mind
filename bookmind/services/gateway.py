# SPDX-License-Identifier: AGPL-3.0-or-later
"""API gateway — the single public entry point (blueprint §1).

Responsibilities
  * Hosts the offline-first PWA (web/), with a strict Content-Security-Policy.
  * Authentication (optional HTTP Basic — applies to *everything*, static files included).
  * Rate limiting (token buckets, global when Redis is configured) and request-size limits.
  * Idempotency-Key handling for every mutation.
  * Routing + aggregation: one client call fans out to several services (search, status).
  * Graceful degradation: cached/stale book data, partial search results, saga compensation.

Behind it, in production: an edge reverse proxy doing TLS, WAF and caching (deploy/nginx or the
Kubernetes ingress, deploy/k8s), and optionally a CDN. See docs/ARCHITECTURE.md §1.
"""
from __future__ import annotations

import asyncio
import base64
import binascii
import json
import math
import secrets
import time
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import HTTPException, Path, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel, Field

from bookmind import __version__
from bookmind.common.cache import Cache
from bookmind.common.config import FeatureFlags, get_settings
from bookmind.common.idempotency import idempotent
from bookmind.common.kv import get_kv
from bookmind.common.resilience import CircuitOpenError
from bookmind.common.rpc import ClientError, ServiceClient, UpstreamError
from bookmind.common.saga import Saga, SagaFailed
from bookmind.common.service import create_service
from bookmind.common.telemetry import RATE_LIMITED

settings = get_settings()

catalog = ServiceClient("catalog", timeout_s=10)
search = ServiceClient("search", timeout_s=5)
# Generation can legitimately take a while on a CPU-only laptop.
research = ServiceClient("research", timeout_s=settings.ollama_timeout_s + 10, failure_threshold=3)
notebook = ServiceClient("notebook", timeout_s=5)
websearch = ServiceClient("websearch", timeout_s=12)
tts = ServiceClient("tts", timeout_s=30)
CLIENTS = {"catalog": catalog, "search": search, "research": research, "notebook": notebook, "websearch": websearch}

book_cache = Cache("book", ttl_s=300, stale_ttl_s=30 * 86400)
definitions_cache = Cache("definitions", ttl_s=3600, stale_ttl_s=30 * 86400)
flags = FeatureFlags(settings.flags_path, kv=get_kv() if settings.redis_url else None)

NOTE_ID = r"^[A-Za-z0-9_\-]{1,64}$"
PUBLIC_PATHS = {"/healthz", "/readyz", "/metrics"}
CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
    "connect-src 'self'; manifest-src 'self'; worker-src 'self'; font-src 'self'; "
    "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
)


# ----------------------------------------------------------------------------- middleware
# Registered innermost-first (see create_service): auth < rate limit < body limit < headers.


def client_ip(request: Request) -> str:
    if settings.trust_proxy_headers:
        # Only trust X-Real-IP when a proxy we control (deploy/nginx) sets it; never XFF from users.
        real = request.headers.get("x-real-ip")
        if real:
            return real.strip()
    return request.client.host if request.client else "unknown"


def _unauthorized() -> Response:
    return JSONResponse(
        {"detail": "Unauthorized"}, status_code=401, headers={"WWW-Authenticate": 'Basic realm="BookMind", charset="UTF-8"'}
    )


async def auth_middleware(request: Request, call_next):
    password = settings.auth_password
    if not password or request.url.path in PUBLIC_PATHS:
        return await call_next(request)
    header = request.headers.get("authorization", "")
    if not header.lower().startswith("basic "):
        return _unauthorized()
    try:
        user, _, pw = base64.b64decode(header[6:]).decode("utf-8").partition(":")
    except (binascii.Error, UnicodeDecodeError):
        return _unauthorized()
    ok_user = secrets.compare_digest(user.encode(), settings.auth_user.encode())
    ok_pw = secrets.compare_digest(pw.encode(), password.encode())
    if not (ok_user and ok_pw):
        return _unauthorized()
    return await call_next(request)


async def rate_limit_middleware(request: Request, call_next):
    path = request.url.path
    if not path.startswith("/api/"):
        return await call_next(request)
    ip = client_ip(request)
    buckets = [("api", settings.rate_api_per_s, settings.rate_api_burst)]
    if path == "/api/v1/research" and request.method == "POST":
        buckets.append(("research", settings.rate_research_per_min / 60, settings.rate_research_burst))
    if path == "/api/v1/web":
        buckets.append(("web", 20 / 60, 10))  # be a polite client of upstream search providers
    kv = get_kv()
    for scope, rate, burst in buckets:
        try:
            allowed, retry_after = await kv.token_bucket(f"rl:{scope}:{ip}", rate, burst)
        except Exception:
            allowed, retry_after = True, 0.0  # fail open: a limiter outage shouldn't take the app down
        if not allowed:
            RATE_LIMITED.labels(scope).inc()
            return JSONResponse(
                {"detail": "Too many requests — slow down a little.", "scope": scope},
                status_code=429,
                headers={"Retry-After": str(max(1, math.ceil(retry_after)))},
            )
    return await call_next(request)


async def body_limit_middleware(request: Request, call_next):
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > settings.max_body_bytes:
        return JSONResponse({"detail": "Request body too large."}, status_code=413)
    return await call_next(request)


async def security_headers_middleware(request: Request, call_next):
    response = await call_next(request)
    h = response.headers
    h.setdefault("Content-Security-Policy", CSP)
    h.setdefault("X-Content-Type-Options", "nosniff")
    h.setdefault("Referrer-Policy", "no-referrer")
    h.setdefault("X-Frame-Options", "DENY")
    h.setdefault("Cross-Origin-Opener-Policy", "same-origin")
    h.setdefault("Cross-Origin-Resource-Policy", "same-origin")
    h.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()")
    if request.url.path.startswith("/api/") and "cache-control" not in h:
        h["Cache-Control"] = "no-store"
    return response


@asynccontextmanager
async def lifespan(_app):
    yield
    for client in CLIENTS.values():
        await client.aclose()


app = create_service(
    "gateway",
    lifespan=lifespan,
    internal=False,
    title="BookMind API",
    middlewares=(auth_middleware, rate_limit_middleware, body_limit_middleware, security_headers_middleware),
)
if settings.allowed_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.allowed_origins),
        allow_methods=["GET", "POST", "PUT", "DELETE"],
        allow_headers=["Content-Type", "Idempotency-Key", "Authorization", "traceparent"],
        allow_credentials=True,
    )


def degraded(detail: str, retry_after: float = 5) -> JSONResponse:
    return JSONResponse(
        {"detail": detail, "degraded": True}, status_code=503, headers={"Retry-After": str(max(1, math.ceil(retry_after)))}
    )


# ----------------------------------------------------------------------------- book content


async def _etag_json(request: Request, payload: dict, version: str, outcome: str) -> Response:
    etag = f'"{version}"'
    headers = {"ETag": etag, "Cache-Control": "no-cache", "X-Cache": outcome}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    return JSONResponse(payload, headers=headers)


@app.get("/api/v1/book")
async def get_book(request: Request):
    try:
        book, outcome = await book_cache.get_or_load("book", lambda: catalog.get("/v1/book"))
    except (UpstreamError, CircuitOpenError):
        return degraded("The book catalog is unavailable. Your offline copy still works.")
    return await _etag_json(request, book, book["version"], outcome)


@app.get("/api/v1/definitions")
async def get_definitions(request: Request):
    try:
        data, outcome = await definitions_cache.get_or_load("all", lambda: catalog.get("/v1/definitions"))
        book, _ = await book_cache.get_or_load("book", lambda: catalog.get("/v1/book"))
    except (UpstreamError, CircuitOpenError):
        return degraded("The glossary is unavailable right now.")
    return await _etag_json(request, data, "d-" + book["version"], outcome)


# ----------------------------------------------------------------------------- search (aggregation)


@app.get("/api/v1/search")
async def unified_search(
    q: str = Query(..., min_length=1, max_length=500),
    k: int = Query(8, ge=1, le=25),
    mode: Literal["hybrid", "keyword", "semantic"] = "hybrid",
):
    want_notes = await flags.enabled("notes_search_enabled")

    async def notes():
        if not want_notes:
            return {"results": []}
        return await search.get("/v1/notes", params={"q": q, "k": k})

    passages_res, notes_res = await asyncio.gather(
        search.get("/v1/passages", params={"q": q, "k": k, "mode": mode}), notes(), return_exceptions=True
    )
    errors = [name for name, r in (("passages", passages_res), ("notes", notes_res)) if isinstance(r, Exception)]
    if len(errors) == 2:
        return degraded("Search is unavailable. Offline search still works in the app.")
    return {
        "query": q,
        "passages": [] if isinstance(passages_res, Exception) else passages_res["results"],
        "semantic": None if isinstance(passages_res, Exception) else passages_res.get("semantic"),
        "notes": [] if isinstance(notes_res, Exception) else notes_res["results"],
        "partial": bool(errors),
        "unavailable": errors,
    }


_semantic_pack: dict = {"at": 0.0, "body": None, "etag": None}


@app.get("/api/v1/semantic")
async def semantic_pack(request: Request):
    """Vectors that let the app search by meaning offline (≈2 MB; cached by the service worker).
    Held in gateway memory for 10 minutes rather than in the shared cache: it's large and immutable
    per book version."""
    now = time.monotonic()
    if _semantic_pack["body"] is None or now - _semantic_pack["at"] > 600:
        try:
            pack = await search.get("/v1/semantic-pack", timeout_s=60)
        except ClientError:
            return JSONResponse({"detail": "Meaning search isn't enabled on this server."}, status_code=404)
        except (UpstreamError, CircuitOpenError):
            return degraded("Search is unavailable right now.")
        body = json.dumps(pack, separators=(",", ":")).encode()
        _semantic_pack.update(at=now, body=body, etag=f'"sp-{pack["version"]}-{pack["model"]}"')
    headers = {"ETag": _semantic_pack["etag"], "Cache-Control": "no-cache"}
    if request.headers.get("if-none-match") == _semantic_pack["etag"]:
        return Response(status_code=304, headers=headers)
    return Response(_semantic_pack["body"], media_type="application/json", headers=headers)


# ----------------------------------------------------------------------------- read-aloud (Piper)


@app.get("/api/v1/tts/voices")
async def tts_voices():
    if not await flags.enabled("neural_voices_enabled"):
        return {"engine": None, "voices": [], "disabled": True}
    try:
        return await tts.get("/v1/voices", timeout_s=5, retries=1)
    except (UpstreamError, CircuitOpenError, ClientError):
        return {"engine": None, "voices": [], "unavailable": True}


@app.get("/api/v1/tts")
async def tts_speak(
    voice: str = Query(..., pattern=r"^[A-Za-z0-9_.\-]{1,80}$"),
    text: str = Query(..., min_length=1, max_length=2000),
    rate: float = Query(1.0, ge=0.5, le=2.0),
):
    """One sentence of audio. GET (not POST) so the browser and service worker can cache it: the
    same voice + text always produces the same audio, and cached pages replay offline."""
    if not await flags.enabled("neural_voices_enabled"):
        return JSONResponse({"detail": "Natural voices are switched off."}, status_code=404)
    try:
        audio, media = await tts.get("/v1/speak", params={"voice": voice, "text": text, "rate": rate}, timeout_s=30, retries=1, raw=True)
    except ClientError as exc:
        return JSONResponse({"detail": exc.detail}, status_code=exc.status)
    except (UpstreamError, CircuitOpenError):
        return degraded("The voice service is busy or unavailable — using your device's voice.")
    return Response(audio, media_type=media, headers={"Cache-Control": "private, max-age=31536000, immutable"})


# ----------------------------------------------------------------------------- research + saga


class ResearchRequest(BaseModel):
    mode: str = Field(..., pattern="^(research|simplify|ask)$")
    selection: str = Field(..., min_length=1, max_length=settings.max_selection_chars)
    doc: str = Field(..., max_length=40)
    doc_title: str = Field(..., max_length=200)
    doc_short: str = Field(..., max_length=40)
    page: int = Field(..., ge=0, le=100_000)
    context_text: str = Field("", max_length=settings.max_context_chars)
    chunk_id: str | None = Field(None, max_length=64)
    save: bool = False
    note_id: str | None = Field(None, pattern=NOTE_ID)
    session: str = Field("", max_length=80)
    web: bool = False


def _generate_payload(req: ResearchRequest) -> dict:
    return req.model_dump(include={"mode", "selection", "doc_title", "doc_short", "page", "context_text", "chunk_id", "web"})


def _note_payload(req: ResearchRequest, **extra) -> dict:
    return {
        "doc": req.doc,
        "doc_short": req.doc_short,
        "page": req.page,
        "mode": req.mode,
        "selection": req.selection,
        "session": req.session,
        "chunk_id": req.chunk_id,
        **extra,
    }


def research_and_save_saga(req: ResearchRequest) -> Saga:
    """reserve note (pending) -> generate -> complete note; undo the reservation on failure."""
    note_path = f"/v1/notes/{req.note_id}"

    async def reserve(ctx):
        ctx["reserved_at"] = int(time.time() * 1000)
        return await notebook.put(note_path, json=_note_payload(req, status="pending", answer="", updated_at=ctx["reserved_at"]))

    async def unreserve(ctx):
        # Tombstone at the reservation's own timestamp: anything newer (e.g. the client's offline
        # fallback note) still wins, but the orphaned "pending" note is gone.
        await notebook.delete(note_path, params={"updated_at": ctx["reserved_at"]})

    async def generate(_ctx):
        return await research.post("/v1/generate", json=_generate_payload(req))

    async def complete(ctx):
        g = ctx["generate"]
        return await notebook.put(
            note_path,
            json=_note_payload(
                req,
                status="done",
                answer=g["answer"],
                model=g.get("model"),
                source=g.get("source"),
                related=g.get("related", []),
                web=g.get("web", []),
                updated_at=max(int(time.time() * 1000), ctx["reserved_at"] + 1),
            ),
        )

    return Saga("research_and_save").step("reserve", reserve, unreserve).step("generate", generate).step("complete", complete)


@app.post("/api/v1/research")
async def research_endpoint(req: ResearchRequest, request: Request):
    current = await flags.all()
    if not current.get(f"{'research' if req.mode == 'ask' else req.mode}_enabled", True):
        raise HTTPException(403, f"'{req.mode}' is switched off right now.")
    if req.save and not req.note_id:
        raise HTTPException(422, "note_id is required when save=true")

    async def handler() -> Response:
        if not req.save:
            try:
                return JSONResponse(await research.post("/v1/generate", json=_generate_payload(req)))
            except (UpstreamError, CircuitOpenError):
                return degraded("The research service is unavailable. An offline note was made instead.")
        try:
            ctx = await research_and_save_saga(req).run()
        except SagaFailed as exc:
            if isinstance(exc.cause, ClientError):
                return JSONResponse({"detail": exc.cause.detail}, status_code=exc.cause.status)
            return degraded(f"Could not complete research ({exc.step} failed); nothing was left half-saved.")
        g = ctx["generate"]
        return JSONResponse({**g, "note": ctx["complete"]["note"], "saved": ctx["complete"]["applied"]})

    return await idempotent(request, "research", handler)


# ----------------------------------------------------------------------------- notebook


@app.get("/api/v1/notes")
async def list_notes(include_deleted: bool = False):
    try:
        return await notebook.get("/v1/notes", params={"include_deleted": str(include_deleted).lower()})
    except (UpstreamError, CircuitOpenError):
        return degraded("The notebook service is unavailable. Changes are kept on this device and will sync later.")


@app.put("/api/v1/notes/{note_id}")
async def put_note(request: Request, note_id: str = Path(..., pattern=NOTE_ID)):
    async def handler() -> Response:
        try:
            payload = json.loads(await request.body() or b"{}")
        except ValueError:
            return JSONResponse({"detail": "Body must be JSON."}, status_code=400)
        try:
            return JSONResponse(await notebook.put(f"/v1/notes/{note_id}", json=payload))
        except (UpstreamError, CircuitOpenError):
            return degraded("The notebook service is unavailable. The note is kept on this device and will sync later.")

    return await idempotent(request, "notes", handler)


@app.delete("/api/v1/notes/{note_id}")
async def delete_note(request: Request, note_id: str = Path(..., pattern=NOTE_ID), updated_at: int | None = None):
    async def handler() -> Response:
        params = {"updated_at": updated_at} if updated_at else None
        try:
            return JSONResponse(await notebook.delete(f"/v1/notes/{note_id}", params=params))
        except (UpstreamError, CircuitOpenError):
            return degraded("The notebook service is unavailable. The deletion will sync later.")

    return await idempotent(request, "notes", handler)


# ----------------------------------------------------------------------------- web search


@app.get("/api/v1/web")
async def web_search(q: str = Query(..., min_length=2, max_length=300), k: int = Query(8, ge=1, le=20)):
    if not await flags.enabled("web_search_enabled"):
        raise HTTPException(403, "Web search is switched off on this server.")
    try:
        return await websearch.get("/v1/search", params={"q": q, "k": k}, retries=1)
    except (UpstreamError, CircuitOpenError):
        return degraded("Web search is unavailable right now. The four documents are still fully searchable.")


# ----------------------------------------------------------------------------- config & status


CLIENT_FLAGS = ("research_enabled", "simplify_enabled", "llm_enabled", "notes_search_enabled", "web_search_enabled", "neural_voices_enabled")


@app.get("/api/v1/config")
async def client_config():
    current = await flags.all()
    return {
        "version": __version__,
        "flags": {k: current.get(k, True) for k in CLIENT_FLAGS},
        "maintenance_message": current.get("maintenance_message") or "",
        "limits": {"max_selection_chars": settings.max_selection_chars, "max_context_chars": settings.max_context_chars},
    }


@app.get("/api/v1/status")
async def status():
    async def ready(name: str, client: ServiceClient):
        try:
            await client.get("/readyz", retries=1, timeout_s=2)
            return name, "ready"
        except ClientError:
            return name, "degraded"
        except Exception:  # noqa: BLE001
            return name, "unavailable"

    results = dict(await asyncio.gather(*(ready(n, c) for n, c in CLIENTS.items())))
    model = None
    if results.get("research") == "ready":
        try:
            model = await research.get("/v1/model", retries=1, timeout_s=4)
        except Exception:  # noqa: BLE001
            model = None
    breakers = {}
    for client in CLIENTS.values():
        breakers.update(client.breakers())
    return {
        "version": __version__,
        "services": results,
        "model": model,
        "breakers": breakers,
        "overall": "ok" if all(v == "ready" for v in results.values()) else "degraded",
    }


# ----------------------------------------------------------------------------- PWA hosting

NO_CACHE = {"index.html", "sw.js", "manifest.webmanifest"}


def _static(path: str) -> Response:
    web_dir = settings.web_dir.resolve()
    target = (web_dir / path).resolve()
    if web_dir not in target.parents and target != web_dir:
        raise HTTPException(404)
    if not target.is_file():
        raise HTTPException(404)
    # The service worker versions assets itself (and fetches with cache: "reload"), so a short
    # HTTP cache is enough; entry points are always revalidated so updates are noticed promptly.
    cache = "no-cache" if target.name in NO_CACHE else "public, max-age=604800, immutable" if target.suffix == ".woff2" else "public, max-age=3600"
    headers = {"Cache-Control": cache}
    if target.name == "sw.js":
        headers["Service-Worker-Allowed"] = "/"
    media = {".webmanifest": "application/manifest+json", ".woff2": "font/woff2"}.get(target.suffix)
    return FileResponse(target, headers=headers, media_type=media)


@app.api_route("/", methods=["GET", "HEAD"], include_in_schema=False)
async def index():
    return _static("index.html")


@app.api_route("/{path:path}", methods=["GET", "HEAD"], include_in_schema=False)
async def static_files(path: str):
    if path.startswith("api/"):
        raise HTTPException(404, "Unknown API route")
    return _static(path)

