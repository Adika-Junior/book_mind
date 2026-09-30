# SPDX-License-Identifier: AGPL-3.0-or-later
"""Fast key-value store used for caching, idempotency keys, rate limiting and flag overrides.

Two interchangeable backends:
  * MemoryKV — per-process, zero dependencies. Right for a laptop / single replica.
  * RedisKV  — shared across replicas, so rate limits, idempotency keys and caches are global.

Selected automatically from BOOKMIND_REDIS_URL.
"""
from __future__ import annotations

import math
import time
from typing import Protocol

from .config import get_settings


class KV(Protocol):
    async def get(self, key: str) -> str | None: ...
    async def set(self, key: str, value: str, ttl_s: float | None = None, nx: bool = False) -> bool: ...
    async def delete(self, key: str) -> None: ...
    async def hgetall(self, key: str) -> dict[str, str]: ...
    async def token_bucket(self, key: str, rate_per_s: float, capacity: int) -> tuple[bool, float]: ...
    async def ping(self) -> bool: ...


class MemoryKV:
    def __init__(self, max_keys: int = 50_000):
        self._data: dict[str, tuple[str, float | None]] = {}
        self._hashes: dict[str, dict[str, str]] = {}
        self._buckets: dict[str, tuple[float, float]] = {}
        self.max_keys = max_keys

    def _alive(self, key: str) -> bool:
        item = self._data.get(key)
        if item is None:
            return False
        if item[1] is not None and item[1] < time.monotonic():
            del self._data[key]
            return False
        return True

    def _evict(self) -> None:
        if len(self._data) < self.max_keys:
            return
        now = time.monotonic()
        for k in [k for k, (_, exp) in self._data.items() if exp is not None and exp < now]:
            del self._data[k]
        while len(self._data) >= self.max_keys:  # dicts keep insertion order => oldest first
            del self._data[next(iter(self._data))]

    async def get(self, key: str) -> str | None:
        return self._data[key][0] if self._alive(key) else None

    async def set(self, key: str, value: str, ttl_s: float | None = None, nx: bool = False) -> bool:
        if nx and self._alive(key):
            return False
        self._evict()
        self._data[key] = (value, time.monotonic() + ttl_s if ttl_s else None)
        return True

    async def delete(self, key: str) -> None:
        self._data.pop(key, None)

    async def hgetall(self, key: str) -> dict[str, str]:
        return dict(self._hashes.get(key, {}))

    async def hset(self, key: str, field: str, value: str) -> None:
        self._hashes.setdefault(key, {})[field] = value

    async def token_bucket(self, key: str, rate_per_s: float, capacity: int) -> tuple[bool, float]:
        now = time.monotonic()
        tokens, ts = self._buckets.get(key, (float(capacity), now))
        tokens = min(capacity, tokens + (now - ts) * rate_per_s)
        if tokens >= 1:
            self._buckets[key] = (tokens - 1, now)
            return True, 0.0
        self._buckets[key] = (tokens, now)
        if len(self._buckets) > self.max_keys:
            self._buckets.clear()  # crude but bounded; a full bucket is the safe default
        return False, (1 - tokens) / rate_per_s

    async def ping(self) -> bool:
        return True


# Atomic token bucket: read, refill, take, write in one round trip so concurrent replicas can't
# both spend the last token.
_TOKEN_BUCKET_LUA = """
local rate = tonumber(ARGV[1])
local cap = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local b = redis.call('HMGET', KEYS[1], 't', 'ts')
local tokens = tonumber(b[1]) or cap
local ts = tonumber(b[2]) or now
tokens = math.min(cap, tokens + math.max(0, now - ts) * rate)
local allowed = 0
local retry = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  retry = (1 - tokens) / rate
end
redis.call('HSET', KEYS[1], 't', tokens, 'ts', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(cap / rate * 1000) + 1000)
return {allowed, tostring(retry)}
"""


class RedisKV:
    def __init__(self, url: str):
        import redis.asyncio as redis  # imported lazily: optional dependency in laptop mode

        self.client = redis.from_url(url, decode_responses=True, health_check_interval=30)
        self._bucket = self.client.register_script(_TOKEN_BUCKET_LUA)

    async def get(self, key: str) -> str | None:
        return await self.client.get(key)

    async def set(self, key: str, value: str, ttl_s: float | None = None, nx: bool = False) -> bool:
        px = int(math.ceil(ttl_s * 1000)) if ttl_s else None
        return bool(await self.client.set(key, value, px=px, nx=nx))

    async def delete(self, key: str) -> None:
        await self.client.delete(key)

    async def hgetall(self, key: str) -> dict[str, str]:
        return await self.client.hgetall(key)

    async def hset(self, key: str, field: str, value: str) -> None:
        await self.client.hset(key, field, value)

    async def token_bucket(self, key: str, rate_per_s: float, capacity: int) -> tuple[bool, float]:
        allowed, retry = await self._bucket(keys=[key], args=[rate_per_s, capacity, time.time()])
        return bool(int(allowed)), float(retry)

    async def ping(self) -> bool:
        return bool(await self.client.ping())


_kv: KV | None = None


def get_kv() -> KV:
    global _kv
    if _kv is None:
        url = get_settings().redis_url
        _kv = RedisKV(url) if url else MemoryKV()
    return _kv


def set_kv(kv: KV | None) -> None:
    """Test hook / explicit wiring."""
    global _kv
    _kv = kv
