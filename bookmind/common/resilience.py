# SPDX-License-Identifier: AGPL-3.0-or-later
"""Resilience primitives (blueprint §5): circuit breaker, retry with jitter, load shedding.

These are deliberately small and dependency-free — the same semantics as Resilience4j /
Envoy outlier detection, sized for this app. Breaker state is per process, which is also how
Resilience4j and client-side Envoy behave: each caller protects itself.
"""
from __future__ import annotations

import asyncio
import random
import time
from collections.abc import Awaitable, Callable
from typing import TypeVar

from .telemetry import BREAKER_STATE, current_service

T = TypeVar("T")


class CircuitOpenError(RuntimeError):
    def __init__(self, name: str, retry_after: float):
        super().__init__(f"circuit '{name}' is open")
        self.name = name
        self.retry_after = retry_after


class OverloadedError(RuntimeError):
    def __init__(self, what: str, retry_after: float = 2.0):
        super().__init__(f"{what} is at capacity")
        self.retry_after = retry_after


class CircuitBreaker:
    """Closed -> (N consecutive failures) -> Open -> (cooldown) -> Half-open -> one probe.

    A successful probe closes the circuit; a failed probe re-opens it. While open, calls fail
    immediately instead of tying up a worker waiting on a dead dependency.
    """

    CLOSED, HALF_OPEN, OPEN = "closed", "half_open", "open"
    _GAUGE = {CLOSED: 0, HALF_OPEN: 1, OPEN: 2}

    def __init__(self, name: str, failure_threshold: int = 5, recovery_timeout_s: float = 15.0):
        self.name = name
        self.failure_threshold = failure_threshold
        self.recovery_timeout_s = recovery_timeout_s
        self.failures = 0
        self.opened_at = 0.0
        self._state = self.CLOSED
        self._probe_in_flight = False
        self._publish()

    def _publish(self) -> None:
        BREAKER_STATE.labels(current_service.get(), self.name).set(self._GAUGE[self._state])

    @property
    def state(self) -> str:
        if self._state == self.OPEN and time.monotonic() - self.opened_at >= self.recovery_timeout_s:
            self._state = self.HALF_OPEN
            self._probe_in_flight = False
            self._publish()
        return self._state

    def allow(self) -> bool:
        state = self.state
        if state == self.CLOSED:
            return True
        if state == self.HALF_OPEN and not self._probe_in_flight:
            self._probe_in_flight = True
            return True
        return False

    def retry_after(self) -> float:
        return max(0.0, self.recovery_timeout_s - (time.monotonic() - self.opened_at))

    def record_success(self) -> None:
        self.failures = 0
        self._probe_in_flight = False
        if self._state != self.CLOSED:
            self._state = self.CLOSED
            self._publish()

    def record_failure(self) -> None:
        self._probe_in_flight = False
        self.failures += 1
        if self._state == self.HALF_OPEN or self.failures >= self.failure_threshold:
            self._state = self.OPEN
            self.opened_at = time.monotonic()
            self._publish()

    async def call(self, fn: Callable[[], Awaitable[T]], is_failure: Callable[[BaseException], bool] | None = None) -> T:
        if not self.allow():
            raise CircuitOpenError(self.name, self.retry_after())
        try:
            result = await fn()
        except asyncio.CancelledError:
            self._probe_in_flight = False  # a cancelled probe proves nothing either way
            raise
        except Exception as exc:
            if is_failure is None or is_failure(exc):
                self.record_failure()
            else:
                self.record_success()
            raise
        self.record_success()
        return result

    def snapshot(self) -> dict:
        return {"state": self.state, "failures": self.failures, "retry_after_s": round(self.retry_after(), 1)}


async def retry_async(
    fn: Callable[[], Awaitable[T]],
    *,
    attempts: int = 3,
    base_delay_s: float = 0.1,
    max_delay_s: float = 2.0,
    retry_on: tuple[type[BaseException], ...] = (Exception,),
) -> T:
    """Exponential backoff with *full jitter* (AWS Architecture Blog) to avoid retry storms.

    Only use for idempotent operations — retries mean at-least-once execution.
    """
    for attempt in range(1, attempts + 1):
        try:
            return await fn()
        except CircuitOpenError:
            raise  # never hammer an open circuit
        except retry_on:
            if attempt == attempts:
                raise
            await asyncio.sleep(random.uniform(0, min(max_delay_s, base_delay_s * 2 ** (attempt - 1))))
    raise AssertionError("unreachable")


class ConcurrencyLimiter:
    """Bulkhead + load shedding: at most `limit` concurrent operations, reject the rest at once.

    Rejecting fast (instead of queueing without bound) keeps latency predictable under overload
    and protects a scarce resource — here, the CPU/GPU running the local model.
    """

    def __init__(self, name: str, limit: int):
        self.name = name
        self.limit = max(1, limit)
        self.in_flight = 0

    def __enter__(self):
        if self.in_flight >= self.limit:
            raise OverloadedError(self.name)
        self.in_flight += 1
        return self

    def __exit__(self, *exc):
        self.in_flight -= 1
        return False
