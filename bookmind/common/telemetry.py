# SPDX-License-Identifier: AGPL-3.0-or-later
"""Observability (blueprint §6): distributed tracing, structured logs and metrics.

Tracing
  Every request carries a W3C `traceparent` header. If the caller sent one we continue that
  trace; otherwise we start a new one. Outgoing service calls get a child span id. Trace ids are
  written into every log line, so `trace_id=...` in Loki/ELK shows a request's full path.
  When OTEL_EXPORTER_OTLP_ENDPOINT is set and the OpenTelemetry packages are installed, real
  spans are exported (Jaeger / Tempo / any OTLP collector) and OTel does the propagation.

Logs
  One JSON object per line on stdout — the format Fluent Bit / Promtail / Logstash forward
  without parsing rules. User-supplied text is only ever a JSON *value*, never interpolated into
  a format string (the Log4Shell lesson in docs/rag-digital-book-architecture.md §12).

Metrics
  Prometheus client metrics, exposed by every service on /metrics.
"""
from __future__ import annotations

import contextvars
import json
import logging
import re
import secrets
import sys
import time
from dataclasses import dataclass

from prometheus_client import Counter, Gauge, Histogram

# ----------------------------------------------------------------------------- tracing

_TRACEPARENT_RE = re.compile(r"^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$")


@dataclass(frozen=True)
class TraceContext:
    trace_id: str
    span_id: str
    parent_span_id: str | None = None
    sampled: bool = True

    @property
    def traceparent(self) -> str:
        return f"00-{self.trace_id}-{self.span_id}-{'01' if self.sampled else '00'}"

    def child(self) -> TraceContext:
        return TraceContext(self.trace_id, secrets.token_hex(8), self.span_id, self.sampled)


def new_trace() -> TraceContext:
    return TraceContext(secrets.token_hex(16), secrets.token_hex(8))


def parse_traceparent(header: str | None) -> TraceContext | None:
    if not header:
        return None
    m = _TRACEPARENT_RE.match(header.strip().lower())
    if not m or m.group(1) == "0" * 32 or m.group(2) == "0" * 16:
        return None
    # The caller's span becomes our parent; we get a fresh span id for this hop.
    return TraceContext(m.group(1), secrets.token_hex(8), m.group(2), m.group(3) == "01")


current_trace: contextvars.ContextVar[TraceContext | None] = contextvars.ContextVar(
    "current_trace", default=None
)
current_service: contextvars.ContextVar[str] = contextvars.ContextVar("current_service", default="bookmind")

_otel_enabled = False


def otel_enabled() -> bool:
    return _otel_enabled


def trace_ids() -> tuple[str | None, str | None]:
    if _otel_enabled:
        from opentelemetry import trace as ot

        ctx = ot.get_current_span().get_span_context()
        if ctx.is_valid:
            return format(ctx.trace_id, "032x"), format(ctx.span_id, "016x")
    tc = current_trace.get()
    return (tc.trace_id, tc.span_id) if tc else (None, None)


def outgoing_trace_headers() -> dict[str, str]:
    """Headers to attach to a downstream call (only needed when OTel isn't doing it)."""
    if _otel_enabled:
        return {}
    tc = current_trace.get() or new_trace()
    return {"traceparent": tc.child().traceparent}


def setup_otel(app, service_name: str, endpoint: str | None) -> bool:
    """Enable OpenTelemetry export if configured and installed. Safe no-op otherwise."""
    global _otel_enabled
    if not endpoint:
        return False
    try:
        from opentelemetry import trace as ot
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
        from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
    except ImportError:
        logging.getLogger("bookmind").warning(
            "otel_unavailable", extra={"fields": {"hint": "pip install -r requirements-otel.txt"}}
        )
        return False
    if not isinstance(ot.get_tracer_provider(), TracerProvider):
        provider = TracerProvider(resource=Resource.create({"service.name": service_name}))
        provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
        ot.set_tracer_provider(provider)
        HTTPXClientInstrumentor().instrument()
    FastAPIInstrumentor.instrument_app(app, excluded_urls="healthz,readyz,metrics")
    _otel_enabled = True
    return True


# ----------------------------------------------------------------------------- logging

_RESERVED = set(logging.makeLogRecord({}).__dict__) | {"message", "asctime", "fields"}


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        trace_id, span_id = trace_ids()
        out = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created))
            + f".{int(record.msecs):03d}Z",
            "level": record.levelname.lower(),
            "service": current_service.get(),
            "logger": record.name,
            "msg": record.getMessage(),
        }
        if trace_id:
            out["trace_id"], out["span_id"] = trace_id, span_id
        fields = getattr(record, "fields", None)
        if isinstance(fields, dict):
            out.update(fields)
        for k, v in record.__dict__.items():
            if k not in _RESERVED and k not in out:
                out[k] = v
        if record.exc_info:
            out["exc"] = self.formatException(record.exc_info)
        return json.dumps(out, default=str, ensure_ascii=False)


_logging_ready = False


def setup_logging(level: str = "INFO") -> None:
    global _logging_ready
    if _logging_ready:
        return
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level.upper())
    # Our request middleware writes one structured access line per request; silence the duplicate.
    logging.getLogger("uvicorn.access").disabled = True
    logging.getLogger("httpx").setLevel(logging.WARNING)  # the rpc client logs calls itself
    _logging_ready = True


def log(logger: logging.Logger, level: int, msg: str, **fields) -> None:
    logger.log(level, msg, extra={"fields": fields})


# ----------------------------------------------------------------------------- metrics
# Defined once per process. In single-process mode every service shares this registry and the
# `service` label keeps their series apart.

HTTP_REQUESTS = Counter(
    "bookmind_http_requests_total", "HTTP requests handled", ["service", "method", "route", "status"]
)
HTTP_LATENCY = Histogram(
    "bookmind_http_request_duration_seconds",
    "HTTP request latency",
    ["service", "method", "route"],
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60),
)
UPSTREAM_CALLS = Counter(
    "bookmind_upstream_calls_total", "Service-to-service calls", ["caller", "target", "outcome"]
)
BREAKER_STATE = Gauge(
    "bookmind_circuit_breaker_state", "0=closed 1=half-open 2=open", ["service", "breaker"]
)
EVENTS_PUBLISHED = Counter("bookmind_events_published_total", "Events published", ["topic"])
EVENTS_CONSUMED = Counter(
    "bookmind_events_consumed_total", "Events consumed", ["topic", "group", "outcome"]
)
CACHE_REQUESTS = Counter("bookmind_cache_requests_total", "Cache lookups", ["cache", "outcome"])
RATE_LIMITED = Counter("bookmind_rate_limited_total", "Requests rejected by rate limiting", ["scope"])
IDEMPOTENT_REPLAYS = Counter("bookmind_idempotent_replays_total", "Responses replayed from idempotency store")
GENERATIONS = Counter(
    "bookmind_research_generations_total", "Research answers produced", ["mode", "source"]
)
NOTES_WRITES = Counter("bookmind_notes_writes_total", "Notebook writes", ["op", "result"])
SAGAS = Counter("bookmind_sagas_total", "Saga executions", ["saga", "outcome"])
