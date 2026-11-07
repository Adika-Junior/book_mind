# SPDX-License-Identifier: AGPL-3.0-or-later
"""Sign-in, sessions and account administration — the gateway's identity layer.

How a request becomes a person
  * The app signs in with POST /api/v1/auth/login. The gateway checks the password with the
    accounts service and stores a session in the shared KV store (Redis in production, so any
    gateway replica recognises it). The browser only holds a random token in an HttpOnly,
    SameSite=Lax cookie (Secure over HTTPS) — scripts can't read it, other sites can't send it.
  * Scripts and tools may instead send HTTP Basic credentials on each request.
  * Sessions last BOOKMIND_SESSION_DAYS (30) from last use. Disabling an account, resetting its
    password or changing its role bumps the account's "epoch", which ends its sessions everywhere.
  * Unsafe API requests must carry `X-BookMind: 1`. Browsers won't add a custom header to a
    cross-site request without a CORS preflight the gateway refuses, so this blocks CSRF.

Single-user mode (BOOKMIND_AUTH_MODE=none, or no admin password configured): no sign-in, and every
request acts as the local user, so a personal laptop install keeps working exactly as before.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import json
import math
import secrets
import time

from fastapi import APIRouter, HTTPException, Path, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from bookmind.common.config import get_settings
from bookmind.common.kv import get_kv
from bookmind.common.resilience import CircuitOpenError
from bookmind.common.rpc import ClientError, ServiceClient, UpstreamError
from bookmind.common.telemetry import RATE_LIMITED

settings = get_settings()
accounts = ServiceClient("accounts", timeout_s=10)
notebook_admin = ServiceClient("notebook", timeout_s=30)

COOKIE = "bm_session"
CSRF_HEADER = "x-bookmind"
USERNAME = r"^[a-z0-9][a-z0-9._-]{1,31}$"
# Reachable without signing in: the app shell (so it can show the sign-in screen) and these.
PUBLIC_API = {"/api/v1/auth/login", "/api/v1/auth/session", "/api/v1/auth/logout", "/api/v1/config"}
# A user who must change a temporary password can only do that (and sign out).
FIRST_LOGIN_API = {"/api/v1/auth/password", "/api/v1/auth/session", "/api/v1/auth/logout"}
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
_basic_cache: dict[str, tuple[float, dict]] = {}

router = APIRouter()


# ------------------------------------------------------------------ sessions

def _key(token: str) -> str:
    return "sess:" + hashlib.sha256(token.encode()).hexdigest()  # the KV never holds a usable token


async def create_session(user: dict) -> str:
    token = secrets.token_urlsafe(32)
    record = {
        "username": user["username"], "display_name": user.get("display_name") or user["username"], "role": user["role"],
        "must_change": bool(user.get("must_change")), "epoch": user.get("epoch", 0), "seen": time.time(),
    }
    await get_kv().set(_key(token), json.dumps(record), ttl_s=settings.session_days * 86400)
    return token


async def end_sessions_of(username: str, epoch: int | str) -> None:
    """Make every session of `username` issued before `epoch` invalid (role/password/disabled change)."""
    await get_kv().set(f"uepoch:{username}", str(epoch), ttl_s=settings.session_days * 86400 + 3600)


async def read_session(token: str) -> dict | None:
    kv = get_kv()
    raw = await kv.get(_key(token))
    if not raw:
        return None
    record = json.loads(raw)
    current = await kv.get(f"uepoch:{record['username']}")
    if current is not None and current != str(record["epoch"]):
        await kv.delete(_key(token))
        return None
    if time.time() - record.get("seen", 0) > 3600:  # sliding expiry, refreshed at most hourly
        record["seen"] = time.time()
        await kv.set(_key(token), json.dumps(record), ttl_s=settings.session_days * 86400)
    return record


def _secure(request: Request) -> bool:
    if settings.trust_proxy_headers and request.headers.get("x-forwarded-proto") == "https":
        return True
    return request.url.scheme == "https"


def _set_cookie(response: Response, request: Request, token: str) -> None:
    response.set_cookie(COOKIE, token, max_age=settings.session_days * 86400, httponly=True, samesite="lax",
                        secure=_secure(request), path="/")


async def _basic_user(header: str) -> dict | None:
    try:
        username, _, password = base64.b64decode(header[6:]).decode("utf-8").partition(":")
    except (binascii.Error, UnicodeDecodeError):
        return None
    fp = hashlib.sha256(header.encode()).hexdigest()
    hit = _basic_cache.get(fp)
    if hit and hit[0] > time.monotonic():
        return hit[1]
    try:
        user = await accounts.post("/v1/verify", json={"username": username, "password": password}, retries=1)
    except (ClientError, UpstreamError, CircuitOpenError):
        return None
    if user.get("must_change"):
        return None  # finish first sign-in in the app
    if len(_basic_cache) > 1000:
        _basic_cache.clear()
    _basic_cache[fp] = (time.monotonic() + 300, user)  # scrypt is deliberately slow; don't pay it per request
    return user


async def resolve_user(request: Request) -> tuple[dict | None, str | None]:
    """(user, how) for this request: how is "session", "basic" or None."""
    token = request.cookies.get(COOKIE)
    if token and (record := await read_session(token)):
        return record, "session"
    header = request.headers.get("authorization", "")
    if header.lower().startswith("basic ") and (user := await _basic_user(header)):
        return user, "basic"
    return None, None


def local_user() -> dict:
    return {"username": settings.local_owner, "display_name": "You", "role": "admin", "must_change": False}


def owner_of(request: Request) -> str:
    return request.state.user["username"]


def _deny(status: int, detail: str, code: str) -> JSONResponse:
    # No WWW-Authenticate: a Basic challenge would make browsers pop up their own login box.
    return JSONResponse({"detail": detail, "code": code}, status_code=status)


async def auth_middleware(request: Request, call_next):
    path = request.url.path
    request.state.user = None
    if path.startswith("/api/") and request.method not in SAFE_METHODS and request.headers.get(CSRF_HEADER) != "1":
        return _deny(403, "Missing X-BookMind header.", "csrf")
    if settings.auth_mode == "none":
        request.state.user = local_user()
        return await call_next(request)
    if not path.startswith("/api/"):
        return await call_next(request)  # app shell, health and metrics carry no personal data
    user, _how = await resolve_user(request)
    request.state.user = user
    if path in PUBLIC_API:
        return await call_next(request)
    if user is None:
        return _deny(401, "Please sign in.", "auth_required")
    if user.get("must_change") and path not in FIRST_LOGIN_API:
        return _deny(403, "Choose a new password to finish signing in.", "password_change_required")
    claimed = request.headers.get("x-bookmind-user")
    if claimed and claimed != user["username"]:
        # A device queued changes while someone else was signed in: keep them queued (409 is
        # retried later), never file them under the wrong person.
        return _deny(409, "These changes belong to a different account.", "user_mismatch")
    return await call_next(request)


def require_admin(request: Request) -> dict:
    user = request.state.user
    if not user or user.get("role") != "admin":
        raise HTTPException(403, "Only administrators can manage accounts.")
    return user


async def _accounts(method: str, path: str, **kw):
    try:
        return await accounts.request(method, path, retries=1, **kw)
    except ClientError as exc:
        detail = exc.detail if isinstance(exc.detail, str) else (exc.detail or {}).get("detail", "Request refused.")
        raise HTTPException(exc.status, detail) from exc
    except (UpstreamError, CircuitOpenError) as exc:
        raise HTTPException(503, "Accounts are unavailable right now. Try again shortly.") from exc


def _public(user: dict) -> dict:
    return {k: user.get(k) for k in ("username", "display_name", "role", "must_change")}


# ------------------------------------------------------------------ sign-in

class Login(BaseModel):
    username: str = Field(..., min_length=1, max_length=64)
    password: str = Field(..., min_length=1, max_length=256)


class PasswordChange(BaseModel):
    current: str = Field(..., max_length=256)
    new: str = Field(..., max_length=256)


def client_ip(request: Request) -> str:
    if settings.trust_proxy_headers and (real := request.headers.get("x-real-ip")):
        return real.strip()
    return request.client.host if request.client else "unknown"


@router.get("/api/v1/auth/session")
async def session(request: Request):
    mode = settings.auth_mode
    user = request.state.user
    return {"mode": mode, "user": _public(user) if user else None, "legacy_owner": settings.local_owner}


@router.post("/api/v1/auth/login")
async def login(body: Login, request: Request):
    if settings.auth_mode == "none":
        return {"user": _public(local_user())}
    allowed, retry_after = await get_kv().token_bucket(f"rl:login:{client_ip(request)}", 10 / 60, 10)
    if not allowed:
        RATE_LIMITED.labels("login").inc()
        return JSONResponse({"detail": "Too many sign-in attempts. Wait a minute and try again."}, status_code=429,
                            headers={"Retry-After": str(max(1, math.ceil(retry_after)))})
    user = await _accounts("POST", "/v1/verify", json={"username": body.username.strip().lower(), "password": body.password})
    token = await create_session(user)
    response = JSONResponse({"user": _public(user)})
    _set_cookie(response, request, token)
    return response


@router.post("/api/v1/auth/logout")
async def logout(request: Request):
    if token := request.cookies.get(COOKIE):
        await get_kv().delete(_key(token))
    response = JSONResponse({"signed_out": True})
    response.delete_cookie(COOKIE, path="/")
    return response


@router.post("/api/v1/auth/password")
async def change_password(body: PasswordChange, request: Request):
    if settings.auth_mode == "none":
        raise HTTPException(400, "Single-user mode has no password to change.")
    me = request.state.user
    user = await _accounts("POST", f"/v1/users/{me['username']}/password", json=body.model_dump())
    await end_sessions_of(user["username"], user["epoch"])  # signs out every other device
    if token := request.cookies.get(COOKIE):
        await get_kv().delete(_key(token))
    response = JSONResponse({"user": _public(user)})
    _set_cookie(response, request, await create_session(user))  # ...but not this one
    return response


# ------------------------------------------------------------------ administration

class NewUser(BaseModel):
    username: str = Field(..., pattern=USERNAME)
    display_name: str = Field("", max_length=80)
    role: str = Field("reader", pattern="^(admin|reader)$")


class UserPatch(BaseModel):
    display_name: str | None = Field(None, max_length=80)
    role: str | None = Field(None, pattern="^(admin|reader)$")
    disabled: bool | None = None
    reset_password: bool = False


@router.get("/api/v1/admin/users")
async def list_users(request: Request):
    require_admin(request)
    return await _accounts("GET", "/v1/users")


@router.post("/api/v1/admin/users", status_code=201)
async def create_user(body: NewUser, request: Request):
    require_admin(request)
    if settings.auth_mode == "none":
        raise HTTPException(400, "Turn on accounts (set an admin password) before adding people.")
    return await _accounts("POST", "/v1/users", json=body.model_dump())


@router.patch("/api/v1/admin/users/{username}")
async def update_user(body: UserPatch, request: Request, username: str = Path(..., pattern=USERNAME)):
    me = require_admin(request)
    if username == me["username"] and (body.disabled or body.role == "reader"):
        raise HTTPException(409, "You can't disable or demote your own account — ask another administrator.")
    out = await _accounts("PATCH", f"/v1/users/{username}", json=body.model_dump(exclude_none=True))
    await end_sessions_of(username, out["user"]["epoch"])
    return out


@router.delete("/api/v1/admin/users/{username}")
async def delete_user(request: Request, username: str = Path(..., pattern=USERNAME)):
    me = require_admin(request)
    if username == me["username"]:
        raise HTTPException(409, "You can't delete your own account — ask another administrator.")
    await _accounts("GET", f"/v1/users/{username}")  # 404 before erasing anything
    try:
        erased = await notebook_admin.delete(f"/v1/owners/{username}", retries=1)
    except (UpstreamError, CircuitOpenError) as exc:
        raise HTTPException(503, "The notebook is unavailable, so nothing was deleted. Try again shortly.") from exc
    await _accounts("DELETE", f"/v1/users/{username}")
    await end_sessions_of(username, "deleted")
    return {"deleted": True, "deleted_notes": erased.get("deleted_notes", 0)}
