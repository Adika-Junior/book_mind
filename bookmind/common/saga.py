# SPDX-License-Identifier: AGPL-3.0-or-later
"""Orchestrated saga (blueprint §4): a multi-service business transaction without 2PC.

Each step has an action and, optionally, a compensating action. If step N fails, the
compensations for steps N-1..1 run in reverse order, leaving the system consistent. The
orchestrator keeps the saga's state in one place (the caller), which is easier to reason about
and observe than choreography for a short, request-scoped flow like "research and save".
"""
from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from .resilience import retry_async
from .telemetry import SAGAS, log

logger = logging.getLogger("bookmind.saga")

Action = Callable[[dict], Awaitable[Any]]


class SagaFailed(RuntimeError):
    def __init__(self, saga: str, step: str, cause: BaseException, compensated: bool):
        super().__init__(f"saga '{saga}' failed at step '{step}': {cause!r}")
        self.saga = saga
        self.step = step
        self.cause = cause
        self.compensated = compensated


@dataclass
class _Step:
    name: str
    action: Action
    compensate: Action | None


@dataclass
class Saga:
    name: str
    steps: list[_Step] = field(default_factory=list)

    def step(self, name: str, action: Action, compensate: Action | None = None) -> Saga:
        self.steps.append(_Step(name, action, compensate))
        return self

    async def run(self, ctx: dict | None = None) -> dict:
        ctx = dict(ctx or {})
        done: list[_Step] = []
        for step in self.steps:
            try:
                ctx[step.name] = await step.action(ctx)
                done.append(step)
            except Exception as exc:
                compensated = await self._compensate(done, ctx, step.name)
                SAGAS.labels(self.name, "compensated" if compensated else "compensation_failed").inc()
                log(logger, logging.WARNING, "saga_failed", saga=self.name, step=step.name, error=repr(exc), compensated=compensated)
                raise SagaFailed(self.name, step.name, exc, compensated) from exc
        SAGAS.labels(self.name, "completed").inc()
        return ctx

    async def _compensate(self, done: list[_Step], ctx: dict, failed_step: str) -> bool:
        ok = True
        for step in reversed(done):
            if step.compensate is None:
                continue
            try:
                await retry_async(lambda s=step: s.compensate(ctx), attempts=3, base_delay_s=0.2)
            except Exception as exc:  # noqa: BLE001 — record and keep undoing the rest
                ok = False
                log(logger, logging.ERROR, "saga_compensation_failed", saga=self.name, step=step.name, failed_step=failed_step, error=repr(exc))
        return ok
