# SPDX-License-Identifier: AGPL-3.0-or-later
"""Idempotency engine (blueprint §5), following the IETF `Idempotency-Key` header draft.

A client that may retry — a phone on a flaky network, or the PWA replaying its offline queue —
sends the same `Idempotency-Key` on every attempt. The first request runs; later ones get the
stored response replayed (`Idempotent-Replayed: true`) instead of repeating side effects.

  * Same key, request still running        -> 409 + Retry-After
  * Same key, different request body/path  -> 422 (key reuse is a client bug)
  * First attempt failed with 5xx           -> key released so a retry can run for real
"""
from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Awaitable, Callable

from fastapi import Request
from fastapi.responses import JSONResponse, Response

from .kv import get_kv
from .telemetry import IDEMPOTENT_REPLAYS

_KEY_RE = re.compile(r"^[A-Za-z0-9_\-:.]{8,128}$")
PENDING_TTL_S = 120
DONE_TTL_S = 24 * 3600


async def idempotent(request: Request, scope: str, handler: Callable[[], Awaitable[Response]]) -> Response:
    key = request.headers.get("idempotency-key")
    if not key:
        return await handler()
    if not _KEY_RE.match(key):
        return JSONResponse({"detail": "Idempotency-Key must be 8-128 chars of [A-Za-z0-9_-:.]"}, status_code=400)

    body = await request.body()
    fingerprint = hashlib.sha256(request.method.encode() + b" " + request.url.path.encode() + b"\n" + body).hexdigest()
    store_key = f"idem:{scope}:{key}"
    kv = get_kv()

    claimed = await kv.set(store_key, json.dumps({"state": "pending", "fp": fingerprint}), ttl_s=PENDING_TTL_S, nx=True)
    if not claimed:
        raw = await kv.get(store_key)
        record = json.loads(raw) if raw else None
        if record is None:  # expired between our two calls; claim again
            claimed = await kv.set(store_key, json.dumps({"state": "pending", "fp": fingerprint}), ttl_s=PENDING_TTL_S, nx=True)
            if not claimed:
                return JSONResponse({"detail": "Request with this Idempotency-Key is in progress."}, status_code=409, headers={"Retry-After": "2"})
        elif record["fp"] != fingerprint:
            return JSONResponse({"detail": "Idempotency-Key was already used for a different request."}, status_code=422)
        elif record["state"] == "pending":
            return JSONResponse({"detail": "Request with this Idempotency-Key is in progress."}, status_code=409, headers={"Retry-After": "2"})
        else:
            IDEMPOTENT_REPLAYS.inc()
            return Response(
                content=record["body"].encode(),
                status_code=record["status"],
                media_type="application/json",
                headers={"Idempotent-Replayed": "true"},
            )

    try:
        response = await handler()
    except BaseException:
        await kv.delete(store_key)
        raise
    if response.status_code >= 500 or response.status_code in (408, 409, 429):
        await kv.delete(store_key)  # transient: let the client's retry actually run
        return response
    body_bytes = getattr(response, "body", b"") or b""
    await kv.set(
        store_key,
        json.dumps({"state": "done", "fp": fingerprint, "status": response.status_code, "body": body_bytes.decode()}),
        ttl_s=DONE_TTL_S,
    )
    return response
