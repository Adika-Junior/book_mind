# SPDX-License-Identifier: AGPL-3.0-or-later
import pytest

from bookmind.common.events import MemoryBus
from bookmind.common.saga import Saga, SagaFailed


async def test_bus_retries_then_dead_letters():
    bus = MemoryBus(max_attempts=3, base_backoff_s=0.001)
    seen = []

    async def handler(event):
        seen.append(event.attempts)
        raise ValueError("poison")

    bus.subscribe("t", "g", handler)
    await bus.start()
    await bus.publish("t", "x", {"a": 1})
    for _ in range(100):
        if await bus.dead_letters("t"):
            break
        await __import__("asyncio").sleep(0.01)
    await bus.stop()
    assert seen == [0, 1, 2]
    dlq = await bus.dead_letters("t")
    assert len(dlq) == 1 and "poison" in dlq[0]["error"]


async def test_bus_dedupes_redelivered_event_ids():
    bus = MemoryBus()
    got = []

    async def handler(event):
        got.append(event.id)

    bus.subscribe("dedupe", "g", handler)
    await bus.start()
    await bus.publish("dedupe", "x", {}, event_id="same-id-1")
    await bus.publish("dedupe", "x", {}, event_id="same-id-1")
    await bus.drain()
    await bus.stop()
    assert got == ["same-id-1"]


async def test_saga_compensates_in_reverse():
    log = []

    def step(name, fail=False):
        async def action(ctx):
            log.append(name)
            if fail:
                raise RuntimeError(name)
            return name

        async def undo(ctx):
            log.append("undo-" + name)

        return action, undo

    saga = Saga("s")
    for name, fail in [("a", False), ("b", False), ("c", True)]:
        saga.step(name, *step(name, fail))
    with pytest.raises(SagaFailed) as info:
        await saga.run()
    assert info.value.step == "c" and info.value.compensated
    assert log == ["a", "b", "c", "undo-b", "undo-a"]
