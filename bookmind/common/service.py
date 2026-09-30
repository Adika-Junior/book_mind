# SPDX-License-Identifier: AGPL-3.0-or-later
"""Service factory: every microservice gets the same operational surface for free.

  /healthz   liveness  — the process is up (Kubernetes restarts the pod if this fails)
  /readyz    readiness — dependencies are usable (Kubernetes stops routing traffic if this fails)
  /metrics   Prometheus scrape endpoint

plus request tracing, structured access logs, RED metrics, internal-token auth and a uniform
mapping of resilience errors to HTTP 503 + Retry-After.
"""
from __future__ import annotations

import logging
import math
import secrets
import time
from collections.abc import Awaitable, Callable

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest

from .config import get_settings
from .resilience import CircuitOpenError, OverloadedError
from .rpc import ClientError, UpstreamError
from .telemetry import (
    HTTP_LATENCY,
    HTTP_REQUESTS,
    current_service,
    current_trace,
    log,
    new_trace,
    parse_traceparent,
    setup_logging,
    setup_otel,
    trace_ids,
)

UNPROBED_PATHS = {"/healthz", "/readyz", "/metrics"}
ReadinessCheck = Callable[[], Awaitable[bool]]


def create_service(
    name: str,
    *,
    lifespan=None,
    internal: bool = True,
    title: str | None = None,
    middlewares: tuple = (),
) -> FastAPI:
    """Build a FastAPI app with the shared platform middleware.

    internal=True means the service is only meant to be called by other services: if
    BOOKMIND_INTERNAL_TOKEN is configured, callers must present it. This is defence in depth
    beneath the mesh's mTLS + NetworkPolicy (deploy/k8s), not a replacement for them.

    `middlewares` are extra HTTP middlewares, innermost first. They run *inside* the platform
    middleware, so requests they reject (401, 413, 429) are still traced, logged and counted.
    """
    settings = get_settings()
    setup_logging(settings.log_level)
    app = FastAPI(title=title or f"BookMind {name}", lifespan=lifespan, version="2.0.0")
    app.state.service_name = name
    app.state.readiness: dict[str, ReadinessCheck] = {}
    logger = logging.getLogger(f"bookmind.{name}")

    for mw in middlewares:
        app.middleware("http")(mw)

    @app.middleware("http")
    async def platform_middleware(request: Request, call_next):
        svc_token = current_service.set(name)
        tc = parse_traceparent(request.headers.get("traceparent")) or new_trace()
        trace_token = current_trace.set(tc)
        start = time.perf_counter()
        status = 500
        try:
            if internal and request.url.path not in UNPROBED_PATHS:
                expected = settings.internal_token
                presented = request.headers.get("x-internal-token", "")
                if expected and not secrets.compare_digest(presented, expected):
                    status = 401
                    return JSONResponse({"detail": "internal token required"}, status_code=401)
            response = await call_next(request)
            status = response.status_code
            trace_id, _ = trace_ids()
            if trace_id:
                response.headers["x-trace-id"] = trace_id
            return response
        finally:
            elapsed = time.perf_counter() - start
            route = request.scope.get("route")
            route_path = getattr(route, "path", None) or ("static" if status < 400 else "unmatched")
            if request.url.path not in UNPROBED_PATHS:
                HTTP_REQUESTS.labels(name, request.method, route_path, str(status)).inc()
                HTTP_LATENCY.labels(name, request.method, route_path).observe(elapsed)
                log(
                    logger,
                    logging.INFO if status < 500 else logging.ERROR,
                    "request",
                    method=request.method,
                    route=route_path,
                    status=status,
                    duration_ms=round(elapsed * 1000, 1),
                )
            current_trace.reset(trace_token)
            current_service.reset(svc_token)

    @app.exception_handler(CircuitOpenError)
    async def _circuit_open(_: Request, exc: CircuitOpenError):
        retry = max(1, math.ceil(exc.retry_after))
        return JSONResponse(
            {"detail": f"Dependency '{exc.name}' is temporarily unavailable.", "degraded": True},
            status_code=503,
            headers={"Retry-After": str(retry)},
        )

    @app.exception_handler(OverloadedError)
    async def _overloaded(_: Request, exc: OverloadedError):
        return JSONResponse(
            {"detail": str(exc), "degraded": True},
            status_code=503,
            headers={"Retry-After": str(max(1, math.ceil(exc.retry_after)))},
        )

    @app.exception_handler(UpstreamError)
    async def _upstream(_: Request, exc: UpstreamError):
        return JSONResponse({"detail": f"Dependency '{exc.service}' failed.", "degraded": True}, status_code=502)

    @app.exception_handler(ClientError)
    async def _client_error(_: Request, exc: ClientError):
        return JSONResponse({"detail": exc.detail}, status_code=exc.status)

    @app.get("/healthz", include_in_schema=False)
    async def healthz():
        return {"status": "ok", "service": name}

    @app.get("/readyz", include_in_schema=False)
    async def readyz():
        results = {}
        for check_name, check in app.state.readiness.items():
            try:
                results[check_name] = bool(await check())
            except Exception:
                results[check_name] = False
        ready = all(results.values())
        return JSONResponse({"ready": ready, "checks": results}, status_code=200 if ready else 503)

    @app.get("/metrics", include_in_schema=False)
    async def metrics():
        return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)

    setup_otel(app, f"bookmind-{name}", settings.otlp_endpoint)
    return app
