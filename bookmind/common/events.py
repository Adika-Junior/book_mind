# SPDX-License-Identifier: AGPL-3.0-or-later
"""Event backbone (blueprint §3): publish/subscribe with consumer groups, retries and a DLQ.

Backends
  * MemoryBus         — asyncio queues, single process. Laptop / tests.
  * RedisStreamBus    — Redis Streams consumer groups: durable, at-least-once, replayable,
                        load-balanced across replicas of the same consumer group. The same
                        semantics as Kafka consumer groups, with one less piece of infra to run
                        (Redis is already there for caching, rate limiting and idempotency).
                        See docs/ARCHITECTURE.md §3 for when to graduate to Kafka/RabbitMQ.

Delivery contract
  At-least-once. Handlers MUST be idempotent; `Subscriber` dedupes on event id as a second guard.
  A failing event is retried with backoff up to `max_attempts`, then parked on `<topic>.dlq`
  so one poisoned message never blocks the stream. Parked events can be inspected and replayed.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import socket
import time
import uuid
from collections import defaultdict
from collections.abc import Awaitable, Callable
from dataclasses import asdict, dataclass, field

from .config import get_settings
from .kv import get_kv
from .telemetry import (
    EVENTS_CONSUMED,
    EVENTS_PUBLISHED,
    current_trace,
    log,
    outgoing_trace_headers,
    parse_traceparent,
)

logger = logging.getLogger("bookmind.events")


@dataclass
class Event:
    topic: str
    type: str
    data: dict
    id: str = field(default_factory=lambda: uuid.uuid4().hex)
    occurred_at: float = field(default_factory=time.time)
    attempts: int = 0
    traceparent: str | None = None
    error: str | None = None

    def to_json(self) -> str:
        return json.dumps(asdict(self), separators=(",", ":"))

    @classmethod
    def from_json(cls, raw: str) -> Event:
        return cls(**json.loads(raw))


Handler = Callable[[Event], Awaitable[None]]


async def _run_handler(group: str, handler: Handler, event: Event) -> None:
    """Run a handler inside the publisher's trace, skipping already-processed event ids."""
    seen_key = f"evt:seen:{group}:{event.id}"
    kv = get_kv()
    try:
        if await kv.get(seen_key):
            EVENTS_CONSUMED.labels(event.topic, group, "duplicate").inc()
            return
    except Exception:
        pass
    token = current_trace.set(parse_traceparent(event.traceparent))
    try:
        await handler(event)
    finally:
        current_trace.reset(token)
    try:
        await kv.set(seen_key, "1", ttl_s=7 * 24 * 3600)
    except Exception:
        pass
    EVENTS_CONSUMED.labels(event.topic, group, "ok").inc()


class MemoryBus:
    def __init__(self, max_attempts: int = 5, base_backoff_s: float = 0.2):
        self.max_attempts = max_attempts
        self.base_backoff_s = base_backoff_s
        self._subs: dict[str, list[tuple[str, Handler]]] = defaultdict(list)
        self._queues: dict[tuple[str, str], asyncio.Queue] = {}
        self._tasks: list[asyncio.Task] = []
        self._dlq: dict[str, list[Event]] = defaultdict(list)
        self._started: set[tuple[str, str]] = set()

    def subscribe(self, topic: str, group: str, handler: Handler) -> None:
        self._subs[topic].append((group, handler))
        self._queues.setdefault((topic, group), asyncio.Queue())

    async def publish(self, topic: str, type_: str, data: dict, event_id: str | None = None) -> str:
        event = Event(topic, type_, data, traceparent=outgoing_trace_headers().get("traceparent"))
        if event_id:
            event.id = event_id
        for group, _ in self._subs.get(topic, []):
            await self._queues[(topic, group)].put(Event.from_json(event.to_json()))
        EVENTS_PUBLISHED.labels(topic).inc()
        return event.id

    async def _worker(self, topic: str, group: str, handler: Handler) -> None:
        queue = self._queues[(topic, group)]
        while True:
            event = await queue.get()
            try:
                await _run_handler(group, handler, event)
            except Exception as exc:  # noqa: BLE001 — any handler failure is retried/parked
                event.attempts += 1
                event.error = repr(exc)[:500]
                if event.attempts >= self.max_attempts:
                    self._dlq[topic].append(event)
                    EVENTS_CONSUMED.labels(topic, group, "dead_lettered").inc()
                    log(logger, logging.ERROR, "event_dead_lettered", topic=topic, group=group, event_id=event.id, error=event.error)
                else:
                    EVENTS_CONSUMED.labels(topic, group, "retry").inc()
                    asyncio.get_running_loop().call_later(
                        self.base_backoff_s * 2 ** (event.attempts - 1), queue.put_nowait, event
                    )
            finally:
                queue.task_done()

    async def start(self) -> None:
        # Idempotent: in single-process mode several services share this bus and each calls start().
        for topic, subs in self._subs.items():
            for group, handler in subs:
                if (topic, group) not in self._started:
                    self._started.add((topic, group))
                    self._tasks.append(asyncio.create_task(self._worker(topic, group, handler)))

    async def stop(self) -> None:
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()
        self._started.clear()
        # asyncio queues belong to the event loop that used them; start clean next time.
        self._queues = {key: asyncio.Queue() for key in self._queues}

    async def drain(self) -> None:
        """Test helper: wait until every queue is empty."""
        for q in self._queues.values():
            await q.join()

    async def dead_letters(self, topic: str) -> list[dict]:
        return [asdict(e) for e in self._dlq.get(topic, [])]

    async def ping(self) -> bool:
        return True


class RedisStreamBus:
    def __init__(self, url: str, max_attempts: int = 5, base_backoff_s: float = 0.5, claim_idle_ms: int = 60_000):
        import redis.asyncio as redis

        self.client = redis.from_url(url, decode_responses=True, health_check_interval=30)
        self.max_attempts = max_attempts
        self.base_backoff_s = base_backoff_s
        self.claim_idle_ms = claim_idle_ms
        self.consumer = f"{socket.gethostname()}-{os.getpid()}"
        self._subs: list[tuple[str, str, Handler]] = []
        self._tasks: list[asyncio.Task] = []
        self._started: set[tuple[str, str]] = set()

    @staticmethod
    def stream(topic: str) -> str:
        return f"bm:events:{topic}"

    def subscribe(self, topic: str, group: str, handler: Handler) -> None:
        self._subs.append((topic, group, handler))

    async def publish(self, topic: str, type_: str, data: dict, event_id: str | None = None) -> str:
        event = Event(topic, type_, data, traceparent=outgoing_trace_headers().get("traceparent"))
        if event_id:
            event.id = event_id
        await self.client.xadd(self.stream(topic), {"event": event.to_json()}, maxlen=100_000, approximate=True)
        EVENTS_PUBLISHED.labels(topic).inc()
        return event.id

    async def _ensure_group(self, topic: str, group: str) -> None:
        try:
            # "0": a brand-new group replays retained history, so a fresh read model can rebuild
            # itself from the log (projections are idempotent upserts).
            await self.client.xgroup_create(self.stream(topic), group, id="0", mkstream=True)
        except Exception as exc:  # BUSYGROUP => already exists, which is fine
            if "BUSYGROUP" not in str(exc):
                raise

    async def _handle(self, topic: str, group: str, handler: Handler, msg_id: str, fields: dict) -> None:
        stream = self.stream(topic)
        try:
            event = Event.from_json(fields["event"])
        except (KeyError, ValueError, TypeError):
            await self.client.xadd(stream + ":dlq", {"event": json.dumps(fields), "error": "malformed"})
            await self.client.xack(stream, group, msg_id)
            EVENTS_CONSUMED.labels(topic, group, "malformed").inc()
            return
        try:
            await _run_handler(group, handler, event)
        except Exception as exc:  # noqa: BLE001
            event.attempts += 1
            event.error = repr(exc)[:500]
            if event.attempts >= self.max_attempts:
                await self.client.xadd(stream + ":dlq", {"event": event.to_json()}, maxlen=10_000, approximate=True)
                EVENTS_CONSUMED.labels(topic, group, "dead_lettered").inc()
                log(logger, logging.ERROR, "event_dead_lettered", topic=topic, group=group, event_id=event.id, error=event.error)
            else:
                await asyncio.sleep(self.base_backoff_s * 2 ** (event.attempts - 1))
                # Re-append with the attempt count so retries survive a crash of this worker.
                # Note: this goes to every group on the stream; other groups dedupe by event id.
                await self.client.xadd(stream, {"event": event.to_json()}, maxlen=100_000, approximate=True)
                EVENTS_CONSUMED.labels(topic, group, "retry").inc()
        await self.client.xack(stream, group, msg_id)

    async def _worker(self, topic: str, group: str, handler: Handler) -> None:
        stream = self.stream(topic)
        while True:
            try:
                await self._ensure_group(topic, group)
                # Recover messages a crashed replica read but never acknowledged.
                claimed = await self.client.xautoclaim(stream, group, self.consumer, self.claim_idle_ms, "0-0", count=20)
                for msg_id, fields in (claimed[1] if claimed else []):
                    if fields:
                        await self._handle(topic, group, handler, msg_id, fields)
                resp = await self.client.xreadgroup(group, self.consumer, {stream: ">"}, count=20, block=5000)
                for _, messages in resp or []:
                    for msg_id, fields in messages:
                        await self._handle(topic, group, handler, msg_id, fields)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — broker hiccup: back off, keep consuming
                log(logger, logging.WARNING, "event_consumer_error", topic=topic, group=group, error=repr(exc))
                await asyncio.sleep(2)

    async def start(self) -> None:
        for topic, group, handler in self._subs:
            if (topic, group) not in self._started:
                self._started.add((topic, group))
                self._tasks.append(asyncio.create_task(self._worker(topic, group, handler)))

    async def stop(self) -> None:
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()
        self._started.clear()

    async def dead_letters(self, topic: str) -> list[dict]:
        rows = await self.client.xrange(self.stream(topic) + ":dlq", count=100)
        return [json.loads(f["event"]) | {"dlq_id": i} for i, f in rows if "event" in f]

    async def ping(self) -> bool:
        return bool(await self.client.ping())


_bus = None


def get_bus():
    global _bus
    if _bus is None:
        url = get_settings().redis_url
        _bus = RedisStreamBus(url) if url else MemoryBus()
    return _bus


def set_bus(bus) -> None:
    global _bus
    _bus = bus
