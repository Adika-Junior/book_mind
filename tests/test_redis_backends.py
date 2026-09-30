# SPDX-License-Identifier: AGPL-3.0-or-later
"""Redis Streams bus + Redis KV. Runs when TEST_REDIS_URL is set (CI starts a Redis service)."""
import asyncio
import os
import uuid

import pytest

REDIS_URL = os.environ.get("TEST_REDIS_URL")
pytestmark = pytest.mark.skipif(not REDIS_URL, reason="TEST_REDIS_URL not set")


async def test_redis_token_bucket_is_shared_state():
    from bookmind.common.kv import RedisKV

    a, b = RedisKV(REDIS_URL), RedisKV(REDIS_URL)  # two "replicas"
    key = f"rl:test:{uuid.uuid4().hex}"
    results = [(await kv.token_bucket(key, 0.001, 3))[0] for kv in (a, b, a, b)]
    assert results == [True, True, True, False]
    await a.client.aclose()
    await b.client.aclose()


async def test_redis_idempotent_set_nx():
    from bookmind.common.kv import RedisKV

    kv = RedisKV(REDIS_URL)
    key = f"idem:test:{uuid.uuid4().hex}"
    assert await kv.set(key, "1", ttl_s=5, nx=True)
    assert not await kv.set(key, "2", ttl_s=5, nx=True)
    await kv.client.aclose()


async def test_redis_stream_bus_delivers_retries_and_dead_letters():
    from bookmind.common.events import RedisStreamBus

    topic = f"test.{uuid.uuid4().hex[:8]}"
    bus = RedisStreamBus(REDIS_URL, max_attempts=2, base_backoff_s=0.01)
    ok, attempts = [], []

    async def handler(event):
        if event.data.get("poison"):
            attempts.append(event.attempts)
            raise ValueError("bad")
        ok.append(event.data["n"])

    bus.subscribe(topic, "g1", handler)
    await bus.start()
    await bus.publish(topic, "x", {"n": 1})
    await bus.publish(topic, "x", {"poison": True})
    for _ in range(200):
        if ok and await bus.dead_letters(topic):
            break
        await asyncio.sleep(0.02)
    await bus.stop()
    dead = await bus.dead_letters(topic)
    await bus.client.aclose()
    assert ok == [1]
    assert attempts == [0, 1]
    assert dead[0]["error"].startswith("ValueError")
