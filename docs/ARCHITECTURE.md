# BookMind 2 — Architecture

BookMind is an offline-first reader for Kenya's AI policy documents (Strategy, Roadmap, AI Bill,
Bill Digest). It offers read-aloud, cited "Research" and "Simplify" notes from a **local**
open-weight model, and a notebook that syncs across devices.

This document maps the seven-category production microservices blueprint onto this codebase.
For each category it shows **what is implemented, where, why this tool was chosen, and when to
move to the heavier industry tool**. The original design notes (ingestion, RAG, security
history) are in [`rag-digital-book-architecture.md`](rag-digital-book-architecture.md).

> **Design rule: right-size every building block.** Every pattern in the blueprint is
> implemented, but with the lightest tool that gives the real guarantee. For example, Redis
> Streams gives Kafka's consumer-group semantics without running a Kafka cluster for 260 pages.
> Each section names the upgrade path and the signal that says it's time to take it.

---

## 0. Topology

```
                         ┌──────────── browser / installed PWA (offline-first) ────────────┐
                         │ service worker cache · IndexedDB notes + outbox · JS BM25 search │
                         └──────────────────────────────┬───────────────────────────────────┘
                                          HTTPS / HTTP2 │  (optional CDN → WAF in front)
                                    ┌───────────────────▼───────────────────┐
                    §1 Edge         │ NGINX edge: TLS, rate limit, cache,   │
                                    │ request filtering, JSON access logs   │
                                    └───────────────────┬───────────────────┘
                                    ┌───────────────────▼───────────────────┐
                    §1 Gateway      │ gateway ×N  auth · rate limit · idem- │
                                    │ potency · routing · aggregation · saga│
                                    └──┬──────────┬──────────┬──────────┬───┘
                 §2 discovery by name  │          │          │          │   (JSON/HTTP, breakers,
                                ┌──────▼──┐ ┌─────▼────┐ ┌───▼──────┐ ┌─▼────────┐ retries, traceparent)
                                │ catalog │ │ search ×N│ │ research │ │ notebook │
                                │ (book)  │ │ (CQRS    │ │ (RAG +   │ │ (SQLite +│
                                │         │ │  query)  │ │ fallback)│ │  outbox) │
                                └─────────┘ └────▲─────┘ └───┬──────┘ └────┬─────┘
                                                 │ events     │ HTTP        │ outbox relay
                                     §3 ┌────────┴────────────┼─────────────▼───┐
                                        │ Redis: Streams (events, DLQ) · cache ·│
                                        │ idempotency keys · rate-limit buckets │
                                        └───────────────────────────────────────┘
                                                              │ internal network only
                                                        ┌─────▼─────┐
                                                        │  Ollama   │  local open-weight model
                                                        └───────────┘
```

| Service | Owns | Scales | Code |
|---|---|---|---|
| gateway | nothing (stateless edge logic) | horizontally | `bookmind/services/gateway.py` |
| catalog | book content (read-only, versioned by ETag) | horizontally | `bookmind/services/catalog.py` |
| search | passage index + notes read model | horizontally (each replica projects independently) | `bookmind/services/search.py` |
| research | nothing (cache in Redis) | horizontally; model is the bottleneck | `bookmind/services/research.py` |
| notebook | notes (SQLite), outbox | **one writer** (see §4 for the Postgres path) | `bookmind/services/notebook.py` |
| websearch | nothing (cache in Redis); the **only** app service with internet egress | horizontally | `bookmind/services/websearch.py` |

The same code runs in three shapes:

1. **Single process** (`python -m bookmind`): every service in one Python process. Discovery
   resolves to in-process ASGI apps; the bus and KV store are in memory. This is the laptop /
   Raspberry Pi mode.
2. **Docker Compose** (`deploy/docker-compose.yml`): one container per service, Redis, NGINX
   edge, segmented networks, secrets, optional observability and WAF profiles.
3. **Kubernetes** (`deploy/k8s`): Deployments/StatefulSets, HPA, PDBs, default-deny
   NetworkPolicies, Linkerd mTLS, ingress-nginx with ModSecurity.

---

## 1. Ingress & edge routing

| Building block | Implementation | Where |
|---|---|---|
| **API gateway** | Single public service: auth, per-client token-bucket rate limits (global via Redis), body-size limits, Idempotency-Key handling, request routing, **aggregation** (`/api/v1/search` fans out to passages + notes in parallel and returns partial results if one fails; `/api/v1/status` aggregates every service's readiness and breaker state), strict CSP and security headers, PWA hosting. | `services/gateway.py` |
| **Reverse proxy / load balancer** | NGINX (L7): TLS 1.2/1.3 termination, HTTP/2, keep-alive upstream pool, DNS re-resolution so every gateway replica is used, passive health (`max_fails`), retry of idempotent requests on another replica. In K8s, a Service (L4) plus ingress-nginx (L7). Inside the mesh, the RPC client also load-balances across instances (§2). | `deploy/nginx/nginx.conf`, `deploy/k8s/ingress.yaml` |
| **CDN** | The book payload is versioned by a content-hash ETag, and every static asset has explicit cache headers. The edge caches `/api/v1/book` (auth-aware cache key) and answers `If-None-Match` with 304. Put Cloudflare / CloudFront in front unchanged. The PWA's service worker acts as a per-device CDN: after one visit, zero bytes are needed to start the app. | `nginx.conf`, `sw.js` |
| **WAF** | Edge request filtering (methods, dotfiles, script extensions, internal endpoints blocked). Full **OWASP Core Rule Set** via ModSecurity: the `waf` compose profile, or `enable-owasp-core-rules` on ingress-nginx. | `docker-compose.yml` (profile `waf`), `ingress.yaml` |

**Why not Kong / Traefik?** The gateway's policies (idempotency tied to note ids, saga
orchestration, offline-aware degradation) are application-specific, so they live in ~400 lines
of Python. Kong or Traefik fit better once several teams or protocols need one shared gateway.

## 2. Service-to-service networking & discovery

| Building block | Implementation | Where |
|---|---|---|
| **Service discovery** | Services are addressed by name. `BOOKMIND_<NAME>_URL` resolves to Docker DNS (`http://search:8000`), Kubernetes CoreDNS, or Consul DNS; with no URL set, it resolves to an in-process app. | `common/rpc.py` (`resolve`) |
| **Client-side load balancing + outlier detection** | Several URLs per service are round-robined, with a **circuit breaker per instance**. Open instances are skipped (Envoy-style outlier detection). | `common/rpc.py` (`ServiceClient._pick`) |
| **Service mesh** | Kubernetes namespace annotated `linkerd.io/inject: enabled`: automatic **mTLS**, golden metrics, retries and traffic splitting with no code change. Beneath that: **default-deny NetworkPolicies** (each service may talk only to what it calls), and an **internal service token** checked by every internal service as defence in depth. | `deploy/k8s/namespace.yaml`, `networkpolicies.yaml`, `common/service.py` |
| **Inter-service RPC** | JSON over HTTP/1.1 keep-alive, typed with Pydantic, strict timeouts, W3C `traceparent` propagation. | `common/rpc.py` |

**Why not gRPC?** Payloads are small (a selection, 5 passages), call rates are human-paced,
and the browser needs JSON anyway, so JSON costs nothing measurable. gRPC would add a schema
toolchain and HTTP/2-only load-balancing concerns for no gain. Switch when service-to-service
calls exceed a few thousand/s or payloads become large and binary (e.g. embedding vectors):
`ServiceClient` is the single seam to change.

## 3. Asynchronous messaging & event-driven backbone

| Building block | Implementation | Where |
|---|---|---|
| **Message broker / streaming** | **Redis Streams consumer groups**: durable, at-least-once, replayable, load-balanced within a group and fanned out across groups. New groups replay retained history, so a new read model rebuilds itself. Crash recovery via `XAUTOCLAIM` of unacknowledged messages. In-memory bus for single-process mode. | `common/events.py` |
| **Retries + DLQ** | Failed events are retried with exponential backoff up to `max_attempts`, then parked on `<topic>:dlq` with the error, so one poisoned message never blocks a stream. Malformed messages go straight to the DLQ. Consumers also **dedupe by event id**. An alert fires on any dead letter. | `common/events.py`, `deploy/prometheus/alerts.yml` |
| **Outbox pattern** | The notebook writes the note **and** its event row in one SQLite transaction; a relay publishes outbox rows in order, with the row's stable event id. No dual-write bug: a crash between commit and publish just means it publishes on restart. | `services/notebook.py` |
| **Client-side outbox** | The PWA queues note changes in IndexedDB and replays them with `Idempotency-Key`s when connectivity returns (Background Sync where supported). | `web/js/store.js`, `web/js/net.js` |

**Why not Kafka / RabbitMQ / Debezium?** Redis is already required for global rate limits,
idempotency and caching, and Streams gives the needed guarantees (ordering per stream, consumer
groups, replay, pending-entry recovery). Move to **Kafka** when you need long retention measured
in days of high volume, partition-level scaling, or many independent consumers. Move to
**Debezium CDC** when the notebook moves to Postgres (tail the WAL instead of polling an outbox
table). Event envelopes (`id`, `type`, `occurred_at`, `traceparent`) are already
broker-neutral.

## 4. Distributed data management & caching

| Building block | Implementation | Where |
|---|---|---|
| **Database per service** | catalog owns the book file; notebook owns SQLite; search owns its in-memory index and projection; research owns nothing durable. No service reads another's storage: data moves only via APIs and events. | services |
| **Distributed caching** | **Cache-aside** in Redis (generation results keyed by mode/selection/page/model; book and definitions at the gateway), with **stale-on-error**: past the soft TTL a failed refresh serves the stale value instead of an error. HTTP ETags + edge cache + service-worker cache form the outer tiers. | `common/cache.py` |
| **Saga** | **Orchestrated saga** for "research and save": reserve a pending note → generate → complete note. If a later step fails, the reservation is compensated with a tombstone at the reservation's own timestamp, so a newer offline copy still wins. | `common/saga.py`, `gateway.research_and_save_saga` |
| **CQRS** | notebook = write model (validation, LWW conflict resolution, tombstones). search = read model: a denormalised, search-optimised projection maintained from events, **idempotent and order-insensitive** (version check per note). | `notebook.py`, `search.py` |
| **Search & indexing** | BM25 over all 260 pages (server), and the **same algorithm in the browser** for offline search. | `search.py`, `web/js/search.js` |
| **Offline data sync** | Client-generated ids + last-writer-wins on `updated_at` + tombstones make sync safe across devices and retries. | `notebook.py`, `web/js/net.js` |

**Upgrade paths:**
- **Notebook → Postgres** once you have multiple writers or users. Then run the notebook with
  more than one replica and use Debezium for CDC.
- **Search → Meilisearch / OpenSearch** once corpora grow past about 10⁵ pages or need typo
  tolerance. Add **local embeddings** (Ollama `nomic-embed-text`) plus reciprocal rank fusion
  for conceptual matches (original doc §4.2–4.3).
- **Temporal** for sagas once they become long-running or multi-day.

## 5. Resilience & fault tolerance

| Building block | Implementation | Where |
|---|---|---|
| **Circuit breakers** | Closed → open after N consecutive failures → half-open single probe → closed. Used per downstream instance, and around Ollama. 4xx responses don't trip breakers; cancellations don't count. State is exported as a metric. | `common/resilience.py` |
| **Retries** | Exponential backoff with **full jitter**. Only idempotent methods retry by default; never against an open circuit. | `common/resilience.py`, `common/rpc.py` |
| **Rate limiting** | Token buckets (atomic Lua script in Redis, so limits are global across gateway replicas; fail-open if Redis is down), a separate stricter bucket for research, and per-IP `limit_req` / `limit_conn` at the edge. | `common/kv.py`, `gateway.py`, `nginx.conf` |
| **Load shedding / bulkhead** | At most N concurrent generations; extra requests are shed immediately rather than queued. | `ConcurrencyLimiter`, `research.py` |
| **Idempotency engine** | `Idempotency-Key` on every mutation: the first request runs, retries replay the stored response, concurrent duplicates get 409, key reuse with a different body gets 422, and 5xx releases the key. Keys live in Redis. | `common/idempotency.py` |
| **Graceful degradation** | Model down, busy or switched off → **extractive answer** (the Bill's own definitions + best-matching cited sentences). Search partially down → partial results. Catalog down → stale cache / offline copy. Server unreachable → the whole app keeps working from the device. | `research.py`, `gateway.py`, `web/` |
| **Health model** | `/healthz` (liveness) vs `/readyz` (readiness, dependency checks); startup probes; preStop delay plus graceful shutdown for zero-drop rolling updates. | `common/service.py`, `deploy/k8s` |

## 6. Observability & telemetry

| Pillar | Implementation | Where |
|---|---|---|
| **Distributed tracing** | W3C `traceparent` accepted from the browser (the PWA sends one per action), continued across every hop and into **events**. With `OTEL_EXPORTER_OTLP_ENDPOINT` set, OpenTelemetry exports real spans to Jaeger / Tempo (Jaeger is included in the `observability` profile). | `common/telemetry.py`, `web/js/net.js` |
| **Structured logging** | One JSON object per line from every service **and the edge**, with `trace_id` on every line. Promtail ships container logs to Loki; Grafana links a `trace_id` in a log line to the trace. User text is only ever a JSON value, never a format string. | `telemetry.py`, `deploy/observability/promtail.yml` |
| **Metrics & dashboards** | RED metrics per service/route, breaker state, cache hit/stale/miss, events by outcome, DLQ, rate-limited, idempotent replays, saga outcomes, and answers by source (model vs extractive). Prometheus discovers every replica via DNS; a Grafana dashboard is provisioned. | `telemetry.py`, `deploy/prometheus`, `deploy/grafana` |
| **Alerting** | **SLO-based**: a multi-window burn-rate alert on a 99.5% availability SLO, p95 latency, breaker open 5 min, model degraded, any dead letter, target down. Alertmanager routes `page` vs `ticket` (plug in PagerDuty / Opsgenie). | `deploy/prometheus/alerts.yml`, `alertmanager.yml` |

## 7. Configuration, infrastructure & platform engineering

| Building block | Implementation | Where |
|---|---|---|
| **Dynamic configuration / feature flags** | Flags file hot-reloaded every few seconds, plus per-key overrides in Redis (`HSET bm:flags llm_enabled false`) applied to every replica at once. Flags: kill switch for the model, per-feature toggles, and a maintenance banner shown in every client. | `common/config.py`, `deploy/config/flags.json` |
| **Secrets management** | `NAME_FILE` convention everywhere: Docker secrets, Kubernetes Secret volumes, or **External Secrets Operator / Vault Agent** files. The auth password is re-read per request, so **rotation needs no restart**. Nothing secret is in env vars, images or git. Build-time proxy CAs are passed as BuildKit secrets. | `config.py`, `secrets/`, `deploy/k8s/secrets.example.yaml` |
| **Container orchestration** | One non-root, read-only-rootfs image for all services. Compose: healthchecks, restart policies, memory limits, log rotation, `cap_drop: ALL`, segmented internal networks. Kubernetes: restricted Pod Security, HPA, PDB, topology spread, startup/readiness/liveness probes, StatefulSets for stateful parts. | `Dockerfile`, `deploy/` |
| **CI/CD & deployment strategy** | GitHub Actions: lint → tests (including against a real Redis) → `pip-audit` → manifest drift check + kubeconform + promtool + compose validation → image build with SBOM/provenance → Trivy scan → gated deploy on tags. **Rolling updates** with `maxUnavailable: 0`, automatic `rollout undo` if pods never become ready, and a **canary** ingress example. Dependabot keeps pins current. | `.github/workflows/ci.yml`, `deploy/k8s/canary.example.yaml` |

---

## 8. Offline-first client (the "works offline, on every device" requirement)

- **Installable PWA**: manifest, maskable icons, standalone display, app shortcut.
- **Service worker**: precaches the app shell and the full book. Navigations are network-first
  with a 3 s timeout, falling back to the cached shell. Book and glossary are
  stale-while-revalidate. A versioned cache offers a one-tap "new version" reload.
- **Local-first notes**: IndexedDB is the source of truth on the device; an outbox replays
  changes with idempotency keys, and sync is last-writer-wins with tombstones. Storage
  persistence is requested so the browser doesn't evict it.
- **Offline intelligence**: JS BM25 search over all 260 pages, and offline "Research/Simplify"
  that returns the Bill's own definitions plus cited best-matching sentences. It uses the same
  logic as the server's fallback.
- **Every device**: mobile-first layout from 320 px phones to wide desktops. Drawers become
  side panels at 1024/1280 px. Safe-area insets for notched phones, 44 px touch targets,
  swipe to turn pages, and the selection toolbar sits *below* the selection on touch screens
  (where the OS menu is above). Keyboard shortcuts (← → space / n Esc), reduced-motion
  support, lock-screen media controls (Media Session), screen wake-lock while reading aloud,
  and print styles.
- **Palettes and typography**: three contrast-checked palettes (Golden Hour, Coastal Linen,
  Terracotta Garden) × light/dark, bundled open-licensed reading fonts, reader-controlled size,
  leading, measure and spacing, and structure rebuilt from the PDFs. The research and psychology
  behind every choice is in [READING-DESIGN.md](READING-DESIGN.md).

> Service workers require a **secure context**: HTTPS or `localhost`. On a phone reaching your
> laptop over Wi-Fi, use the compose edge with a trusted certificate (`mkcert`) or a real
> domain. Plain `http://192.168.x.x` works but can't go offline.

---

## 9. Security fixes carried over from v1

| v1 issue | Fix |
|---|---|
| `app.mount("/data", StaticFiles(...))` served `data/notebook.db` **to anyone, bypassing auth**. | The data directory is no longer served; book content comes from the catalog API. Test: `test_data_directory_is_not_exposed`. |
| Static files were not covered by Basic Auth. | Auth is middleware on the gateway, covering every route except probes. |
| `/api/health` hard-coded `localhost:11434`, so it was always "unreachable" in Docker. | `/v1/model` derives the URL from `BOOKMIND_OLLAMA_URL`. |
| Notes were saved under the doc you had navigated to *after* highlighting. | Notes carry their own doc and page from creation. |
| Read-aloud stopped after one sentence when it auto-turned the page. | Page turns during playback keep the speech session. |
| Pinned FastAPI pulled in Starlette 0.38 with published CVEs. | Upgraded; `pip-audit` runs in CI (currently clean). |
| Retrieved text was placed in the prompt without a boundary. | Documents are wrapped in `<documents>` with an instruction never to follow text inside them. |

---

## 10. Runbook

| Symptom | Check | Action |
|---|---|---|
| Notes say "Extractive" | App → Services → model; `GET /api/v1/status` | `docker compose exec ollama ollama pull llama3.2`; check `BOOKMIND_OLLAMA_MODEL`; the breaker closes by itself after 30 s. |
| `BookMindDeadLetters` | `XRANGE bm:events:notebook.notes:dlq - +` in Redis | Fix the consumer, then re-publish the event JSON with `XADD bm:events:notebook.notes * event '<json>'`. Consumers dedupe by id. |
| Search doesn't show a new note | `GET notebook /v1/outbox` backlog; search logs | Backlog > 0 means the broker is unreachable (the relay retries). Restarting a search replica rebuilds its projection from snapshot + stream. |
| Need to switch the model off now | — | `HSET bm:flags llm_enabled false` (all replicas, ≤2 s), or edit `flags.json`. |
| Rotate the login password | — | Overwrite `secrets/auth_password.txt` (or the Vault key). The next request uses it; no restart. |
| `BookMindServiceMissing` | `docker compose ps` / `kubectl -n bookmind get pods` | A service has no running instance. Start or roll back that service; readers keep the cached book meanwhile (stale-on-error). |
| Roll back a release | `kubectl -n bookmind rollout history deploy/gateway` | `kubectl -n bookmind rollout undo deploy/<name>`. |
