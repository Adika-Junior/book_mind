# SPDX-License-Identifier: AGPL-3.0-or-later
import asyncio

import pytest

from bookmind.common.kv import MemoryKV
from bookmind.common.resilience import CircuitBreaker, CircuitOpenError, ConcurrencyLimiter, OverloadedError, retry_async


async def boom():
    raise RuntimeError("down")


async def ok():
    return "ok"


async def test_breaker_opens_then_half_opens_then_closes():
    b = CircuitBreaker("t", failure_threshold=2, recovery_timeout_s=0.05)
    for _ in range(2):
        with pytest.raises(RuntimeError):
            await b.call(boom)
    assert b.state == "open"
    with pytest.raises(CircuitOpenError):
        await b.call(ok)  # fails fast, never calls the dependency
    await asyncio.sleep(0.06)
    assert b.state == "half_open"
    assert await b.call(ok) == "ok"
    assert b.state == "closed"


async def test_failed_probe_reopens():
    b = CircuitBreaker("t", failure_threshold=1, recovery_timeout_s=0.01)
    with pytest.raises(RuntimeError):
        await b.call(boom)
    await asyncio.sleep(0.02)
    with pytest.raises(RuntimeError):
        await b.call(boom)
    assert b.state == "open"


async def test_client_errors_do_not_trip_breaker():
    b = CircuitBreaker("t", failure_threshold=1)
    with pytest.raises(ValueError):
        await b.call(lambda: _raise(ValueError()), is_failure=lambda e: not isinstance(e, ValueError))
    assert b.state == "closed"


async def _raise(exc):
    raise exc


async def test_retry_eventually_succeeds():
    calls = {"n": 0}

    async def flaky():
        calls["n"] += 1
        if calls["n"] < 3:
            raise ConnectionError()
        return "done"

    assert await retry_async(flaky, attempts=3, base_delay_s=0.001) == "done"
    assert calls["n"] == 3


def test_concurrency_limiter_sheds_load():
    lim = ConcurrencyLimiter("m", 1)
    with lim:
        with pytest.raises(OverloadedError):
            with lim:
                pass
    with lim:
        pass  # released


async def test_token_bucket():
    kv = MemoryKV()
    results = [(await kv.token_bucket("k", rate_per_s=1, capacity=3))[0] for _ in range(4)]
    assert results == [True, True, True, False]


async def test_memory_kv_nx_and_ttl():
    kv = MemoryKV()
    assert await kv.set("a", "1", nx=True)
    assert not await kv.set("a", "2", nx=True)
    await kv.set("b", "1", ttl_s=0.01)
    await asyncio.sleep(0.02)
    assert await kv.get("b") is None
