# SPDX-License-Identifier: AGPL-3.0-or-later
"""Cache-aside with stale-on-error (blueprint §4 caching + §5 graceful degradation).

Each entry stores the value and a *soft* expiry. Past the soft expiry we try to refresh; if the
refresh fails (downstream down, circuit open) we serve the stale value for up to `stale_ttl_s`
more instead of failing the request. Backed by the shared KV store, so with Redis every replica
shares one cache.
"""
from __future__ import annotations

import hashlib
import json
import time
from collections.abc import Awaitable, Callable
from typing import Any

from .kv import KV, get_kv
from .telemetry import CACHE_REQUESTS


def cache_key(*parts: object) -> str:
    return hashlib.sha256("\x1f".join(str(p) for p in parts).encode()).hexdigest()[:40]


class Cache:
    def __init__(self, name: str, ttl_s: float, stale_ttl_s: float = 0.0, kv: KV | None = None):
        self.name = name
        self.ttl_s = ttl_s
        self.stale_ttl_s = stale_ttl_s
        self._kv = kv

    @property
    def kv(self) -> KV:
        return self._kv or get_kv()

    def _key(self, key: str) -> str:
        return f"cache:{self.name}:{key}"

    async def _read(self, key: str) -> dict | None:
        try:
            raw = await self.kv.get(self._key(key))
        except Exception:
            return None  # a cache outage must never fail the request
        return json.loads(raw) if raw else None

    async def set(self, key: str, value: Any) -> None:
        entry = {"v": value, "soft": time.time() + self.ttl_s}
        try:
            await self.kv.set(self._key(key), json.dumps(entry), ttl_s=self.ttl_s + self.stale_ttl_s)
        except Exception:
            pass

    async def get(self, key: str) -> Any | None:
        entry = await self._read(key)
        if entry and entry["soft"] > time.time():
            return entry["v"]
        return None

    async def get_or_load(
        self, key: str, loader: Callable[[], Awaitable[Any]], *, cacheable: Callable[[Any], bool] | None = None
    ) -> tuple[Any, str]:
        """Returns (value, outcome) where outcome is hit | miss | stale."""
        entry = await self._read(key)
        if entry and entry["soft"] > time.time():
            CACHE_REQUESTS.labels(self.name, "hit").inc()
            return entry["v"], "hit"
        try:
            value = await loader()
        except Exception:
            if entry is not None:
                CACHE_REQUESTS.labels(self.name, "stale").inc()
                return entry["v"], "stale"
            CACHE_REQUESTS.labels(self.name, "error").inc()
            raise
        CACHE_REQUESTS.labels(self.name, "miss").inc()
        if cacheable is None or cacheable(value):
            await self.set(key, value)
        return value, "miss"
