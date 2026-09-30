# SPDX-License-Identifier: AGPL-3.0-or-later
"""Web search service — looks beyond the four documents, with source quality made visible.

Providers (tried in the order of BOOKMIND_WEBSEARCH_PROVIDERS, results merged):
  * searxng    — a self-hosted SearXNG metasearch instance (free, open source, no tracking, no key).
                 Set BOOKMIND_SEARXNG_URL, e.g. http://searxng:8080 (deploy/docker-compose.yml).
  * wikipedia  — Wikipedia's open search API (free, no key). Useful background, never a primary source.
  * brave      — Brave Search API, only if BOOKMIND_BRAVE_API_KEY(_FILE) is set.

Best practice built in:
  * Privacy: the client asks before a query ever leaves the device; this service logs no query text.
  * Safety: requests go only to the configured provider endpoints — never to a URL a user supplied
    (no SSRF). Result snippets are stripped of markup and treated as untrusted text downstream.
  * Source quality: every result gets a tier (official Kenyan source, government, intergovernmental,
    academic, reference, news, other) and results are ranked by it, supporting lateral reading.
  * Resilience: per-provider circuit breakers, strict timeouts, 24 h cache with stale fallback.
"""
from __future__ import annotations

import asyncio
import html
import logging
import re
import time
from urllib.parse import urlsplit, urlunsplit

import httpx
from fastapi import Query

from bookmind import __version__
from bookmind.common.cache import Cache, cache_key
from bookmind.common.config import env, secret
from bookmind.common.resilience import CircuitBreaker, CircuitOpenError
from bookmind.common.service import create_service
from bookmind.common.telemetry import log

logger = logging.getLogger("bookmind.websearch")
USER_AGENT = f"BookMind/{__version__} (offline-first policy reader; +https://github.com/adika-junior/book_mind)"
TIMEOUT_S = float(env("BOOKMIND_WEBSEARCH_TIMEOUT_S", "6"))

# ------------------------------------------------------------------ source quality

TIERS = [
    # (tier, label, predicate on hostname)
    (1, "Official (Kenya)", lambda h: h.endswith(".go.ke") or h in {"kenyalaw.org", "new.kenyalaw.org", "www.kenyalaw.org"}),
    (2, "Government", lambda h: h.endswith(".gov") or ".gov." in h or h.endswith(".europa.eu") or h == "europa.eu"),
    (2, "Intergovernmental", lambda h: any(h == d or h.endswith("." + d) for d in (
        "oecd.org", "oecd.ai", "unesco.org", "un.org", "itu.int", "au.int", "worldbank.org", "who.int", "wipo.int", "unep.org",
    ))),
    (3, "Academic", lambda h: h.endswith(".edu") or ".ac." in h or any(h == d or h.endswith("." + d) for d in (
        "arxiv.org", "doi.org", "ssrn.com", "nature.com", "sciencedirect.com", "springer.com", "jstor.org", "researchgate.net",
    ))),
    (4, "Reference — verify with a primary source", lambda h: h.endswith("wikipedia.org")),
    (5, "News", lambda h: any(h == d or h.endswith("." + d) for d in (
        "nation.africa", "standardmedia.co.ke", "the-star.co.ke", "kbc.co.ke", "citizen.digital", "techcabal.com",
        "bbc.co.uk", "bbc.com", "reuters.com", "apnews.com", "theguardian.com", "aljazeera.com",
    ))),
]


def classify(url: str) -> tuple[int, str, str]:
    host = (urlsplit(url).hostname or "").lower()
    host = host[4:] if host.startswith("www.") else host
    for tier, label, test in TIERS:
        if test(host):
            return tier, label, host
    return 6, "Other — check who publishes it", host


_TAG = re.compile(r"<[^>]+>")


def clean(text: str, limit: int) -> str:
    text = html.unescape(_TAG.sub("", text or ""))
    text = re.sub(r"\s+", " ", text).strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def normalise_url(url: str) -> str | None:
    parts = urlsplit((url or "").strip())
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return None
    return urlunsplit((parts.scheme, parts.netloc.lower(), parts.path or "/", parts.query, ""))


# ------------------------------------------------------------------ providers


async def searxng(client: httpx.AsyncClient, q: str, k: int) -> list[dict]:
    base = env("BOOKMIND_SEARXNG_URL")
    if not base:
        raise LookupError("not configured")
    resp = await client.get(f"{base.rstrip('/')}/search", params={"q": q, "format": "json", "language": "en", "safesearch": 1})
    resp.raise_for_status()
    return [{"title": r.get("title", ""), "url": r.get("url", ""), "snippet": r.get("content", "")} for r in resp.json().get("results", [])[: k * 2]]


async def wikipedia(client: httpx.AsyncClient, q: str, k: int) -> list[dict]:
    resp = await client.get(
        "https://en.wikipedia.org/w/api.php",
        params={"action": "query", "list": "search", "srsearch": q, "format": "json", "srlimit": min(k, 10), "utf8": 1},
    )
    resp.raise_for_status()
    return [
        {
            "title": r.get("title", ""),
            "url": "https://en.wikipedia.org/wiki/" + r.get("title", "").replace(" ", "_"),
            "snippet": r.get("snippet", ""),
        }
        for r in resp.json().get("query", {}).get("search", [])
    ]


async def brave(client: httpx.AsyncClient, q: str, k: int) -> list[dict]:
    key = secret("BOOKMIND_BRAVE_API_KEY")
    if not key:
        raise LookupError("not configured")
    resp = await client.get(
        "https://api.search.brave.com/res/v1/web/search",
        params={"q": q, "count": min(k * 2, 20)},
        headers={"X-Subscription-Token": key, "Accept": "application/json"},
    )
    resp.raise_for_status()
    hits = resp.json().get("web", {}).get("results", [])
    return [{"title": r.get("title", ""), "url": r.get("url", ""), "snippet": r.get("description", "")} for r in hits]


PROVIDERS = {"searxng": searxng, "wikipedia": wikipedia, "brave": brave}
breakers = {name: CircuitBreaker(f"web:{name}", failure_threshold=3, recovery_timeout_s=60) for name in PROVIDERS}
cache = Cache("web", ttl_s=24 * 3600, stale_ttl_s=7 * 24 * 3600)
_client: httpx.AsyncClient | None = None


def client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        # Never follow redirects to arbitrary hosts; providers answer directly.
        _client = httpx.AsyncClient(timeout=TIMEOUT_S, headers={"User-Agent": USER_AGENT}, follow_redirects=False)
    return _client


def enabled_providers() -> list[str]:
    names = [n.strip() for n in (env("BOOKMIND_WEBSEARCH_PROVIDERS", "searxng,wikipedia") or "").split(",")]
    return [n for n in names if n in PROVIDERS]


async def run_search(q: str, k: int) -> dict:
    status: dict[str, str] = {}

    async def one(name: str) -> list[dict]:
        try:
            return await breakers[name].call(lambda: PROVIDERS[name](client(), q, k), is_failure=lambda e: not isinstance(e, LookupError))
        except LookupError:
            status[name] = "not configured"
        except CircuitOpenError:
            status[name] = "paused after errors"
        except (httpx.HTTPError, ValueError) as exc:
            status[name] = "unavailable"
            log(logger, logging.WARNING, "web_provider_error", provider=name, error=type(exc).__name__)
        return []

    names = enabled_providers()
    batches = await asyncio.gather(*(one(n) for n in names))
    seen, results = set(), []
    for rank_offset, (name, batch) in enumerate(zip(names, batches, strict=True)):
        if name not in status:
            status[name] = "ok"
        for rank, r in enumerate(batch):
            url = normalise_url(r.get("url", ""))
            if not url or url in seen:
                continue
            seen.add(url)
            tier, label, domain = classify(url)
            results.append({
                "title": clean(r.get("title", ""), 200) or domain,
                "url": url,
                "snippet": clean(r.get("snippet", ""), 400),
                "domain": domain,
                "tier": tier,
                "tier_label": label,
                "provider": name,
                "_rank": rank + rank_offset * 0.5,
            })
    # Better sources first, then provider rank. Official and intergovernmental sources float up.
    results.sort(key=lambda r: (r["tier"], r["_rank"]))
    for r in results:
        r.pop("_rank")
    return {"query": q, "results": results[:k], "providers": status, "retrieved_at": int(time.time() * 1000)}


app = create_service("websearch")


@app.get("/v1/search")
async def search(q: str = Query(..., min_length=2, max_length=300), k: int = Query(8, ge=1, le=20)):
    q = re.sub(r"\s+", " ", q).strip()

    async def load():
        data = await run_search(q, k)
        if not data["results"] and all(v != "ok" for v in data["providers"].values()):
            raise RuntimeError("no provider available")  # don't cache an outage; serve stale if we have it
        return data

    try:
        data, outcome = await cache.get_or_load(cache_key(q.lower(), k), load)
    except RuntimeError:
        down = {n: "unavailable" for n in enabled_providers()}
        return {"query": q, "results": [], "providers": down, "retrieved_at": int(time.time() * 1000), "cached": False}
    return {**data, "cached": outcome != "miss"}


@app.get("/v1/providers")
async def providers():
    return {"providers": enabled_providers(), "breakers": {n: b.snapshot() for n, b in breakers.items()}}
