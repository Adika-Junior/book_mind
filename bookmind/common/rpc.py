# SPDX-License-Identifier: AGPL-3.0-or-later
"""Service discovery + inter-service client (blueprint §2).

Discovery
  A service is addressed by *name* (`catalog`, `search`, ...), never by IP. Resolution order:
    1. BOOKMIND_<NAME>_URL — one or more comma-separated base URLs. In Docker Compose these are
       DNS names (`http://catalog:8000`); in Kubernetes a Service name resolved by CoreDNS
       (`http://catalog.bookmind.svc.cluster.local`), which load-balances across healthy pods;
       with Consul, `http://catalog.service.consul:8000`.
    2. An in-process ASGI app registered with `register_inproc()` — the single-process
       "laptop" mode, where every service runs in one Python process with no network hops.

Client-side load balancing
  With several URLs the client round-robins and keeps a circuit breaker *per instance*, skipping
  instances whose breaker is open — passive health checking (Envoy's "outlier detection").

Transport
  JSON over HTTP/1.1 with keep-alive and strict timeouts. See docs/ARCHITECTURE.md §2 for why
  this build does not use gRPC, and how to switch if payloads or call rates grow.
"""
from __future__ import annotations

import itertools
import logging
from typing import Any

import httpx

from .config import env, get_settings
from .resilience import CircuitBreaker, CircuitOpenError, retry_async
from .telemetry import UPSTREAM_CALLS, current_service, log, outgoing_trace_headers

logger = logging.getLogger("bookmind.rpc")

_inproc_apps: dict[str, Any] = {}


def register_inproc(name: str, app: Any) -> None:
    _inproc_apps[name] = app


def clear_inproc() -> None:
    _inproc_apps.clear()


def resolve(name: str) -> list[str]:
    raw = env(f"BOOKMIND_{name.upper()}_URL")
    if raw:
        return [u.strip().rstrip("/") for u in raw.split(",") if u.strip()]
    if name in _inproc_apps:
        return [f"inproc://{name}"]
    return []


class UpstreamError(RuntimeError):
    """A dependency failed (5xx, timeout, connection error). Counts against its breaker."""

    def __init__(self, service: str, status: int, detail: str):
        super().__init__(f"{service}: {status} {detail}")
        self.service = service
        self.status = status
        self.detail = detail


class ClientError(RuntimeError):
    """A 4xx from a dependency — the request was wrong, the dependency is healthy."""

    def __init__(self, service: str, status: int, detail: Any):
        super().__init__(f"{service}: {status}")
        self.service = service
        self.status = status
        self.detail = detail


class ServiceClient:
    def __init__(self, name: str, timeout_s: float = 5.0, failure_threshold: int = 5, recovery_timeout_s: float = 10.0):
        self.name = name
        self.timeout_s = timeout_s
        self.failure_threshold = failure_threshold
        self.recovery_timeout_s = recovery_timeout_s
        self._clients: dict[str, httpx.AsyncClient] = {}
        self._breakers: dict[str, CircuitBreaker] = {}
        self._rr = itertools.count()

    def _client(self, base: str) -> httpx.AsyncClient:
        if base not in self._clients:
            if base.startswith("inproc://"):
                transport = httpx.ASGITransport(app=_inproc_apps[self.name])
                self._clients[base] = httpx.AsyncClient(transport=transport, base_url=f"http://{self.name}")
            else:
                self._clients[base] = httpx.AsyncClient(
                    base_url=base,
                    limits=httpx.Limits(max_connections=100, max_keepalive_connections=20),
                )
        return self._clients[base]

    def _breaker(self, base: str) -> CircuitBreaker:
        if base not in self._breakers:
            label = self.name if base.startswith("inproc://") else f"{self.name}@{base.split('://', 1)[-1]}"
            self._breakers[base] = CircuitBreaker(label, self.failure_threshold, self.recovery_timeout_s)
        return self._breakers[base]

    def _pick(self) -> str:
        instances = resolve(self.name)
        if not instances:
            raise UpstreamError(self.name, 503, "no instances registered")
        start = next(self._rr)
        for i in range(len(instances)):
            base = instances[(start + i) % len(instances)]
            if self._breaker(base).state != CircuitBreaker.OPEN:
                return base
        # All open: fail fast with the soonest retry hint.
        soonest = min(self._breaker(b).retry_after() for b in instances)
        raise CircuitOpenError(self.name, soonest)

    def breakers(self) -> dict[str, dict]:
        return {b.name: b.snapshot() for b in self._breakers.values()}

    async def request(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        params: dict | None = None,
        headers: dict | None = None,
        timeout_s: float | None = None,
        retries: int | None = None,
    ) -> Any:
        """Call the service and return decoded JSON. GET/PUT/DELETE retry by default (idempotent)."""
        if retries is None:
            retries = 3 if method.upper() in {"GET", "HEAD", "PUT", "DELETE"} else 1
        hdrs = {**outgoing_trace_headers(), **(headers or {})}
        token = get_settings().internal_token
        if token:
            hdrs["x-internal-token"] = token

        async def attempt():
            base = self._pick()
            breaker = self._breaker(base)

            async def send():
                try:
                    resp = await self._client(base).request(
                        method, path, json=json, params=params, headers=hdrs, timeout=timeout_s or self.timeout_s
                    )
                except httpx.HTTPError as exc:
                    raise UpstreamError(self.name, 503, f"{type(exc).__name__}: {exc}") from exc
                if resp.status_code >= 500:
                    raise UpstreamError(self.name, resp.status_code, resp.text[:300])
                if resp.status_code >= 400:
                    try:
                        detail = resp.json().get("detail", resp.text)
                    except ValueError:
                        detail = resp.text
                    raise ClientError(self.name, resp.status_code, detail)
                return resp.json() if resp.content else None

            return await breaker.call(send, is_failure=lambda e: isinstance(e, UpstreamError))

        try:
            result = await retry_async(attempt, attempts=retries, retry_on=(UpstreamError,))
        except ClientError:
            UPSTREAM_CALLS.labels(current_service.get(), self.name, "client_error").inc()
            raise
        except CircuitOpenError:
            UPSTREAM_CALLS.labels(current_service.get(), self.name, "circuit_open").inc()
            raise
        except UpstreamError as exc:
            UPSTREAM_CALLS.labels(current_service.get(), self.name, "error").inc()
            log(logger, logging.WARNING, "upstream_error", target=self.name, status=exc.status, detail=exc.detail[:200])
            raise
        UPSTREAM_CALLS.labels(current_service.get(), self.name, "ok").inc()
        return result

    async def get(self, path: str, **kw) -> Any:
        return await self.request("GET", path, **kw)

    async def post(self, path: str, **kw) -> Any:
        return await self.request("POST", path, **kw)

    async def put(self, path: str, **kw) -> Any:
        return await self.request("PUT", path, **kw)

    async def delete(self, path: str, **kw) -> Any:
        return await self.request("DELETE", path, **kw)

    async def aclose(self) -> None:
        for c in self._clients.values():
            await c.aclose()
        self._clients.clear()
