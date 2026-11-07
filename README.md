# BookMind

**An offline-first reader for Kenya's AI policy documents.** It covers the AI Strategy
2025–2030, its Implementation Roadmap, the Artificial Intelligence Bill 2026 and the Senate
Bill Digest (260 pages). You can listen to them, highlight any passage for a cited explanation
from a **local, free, open-weight model**, and keep a notebook that syncs across your devices.

- 📱 **Every device.** Phone, tablet, laptop, desktop. Install it like an app.
- ✈️ **Works offline.** After one visit, reading, read-aloud, search and grounded notes all work
  with no connection. Notes sync when you're back — **even if you've closed the app** (the
  browser wakes BookMind's service worker to send them).
- 🗣️ **Natural voices.** Read-aloud uses **Piper** neural voices running on your own server, with
  the device's voices as automatic fallback. Pages you've listened to replay offline. You can add
  a **personal or professional custom voice** — how, and the consent it needs:
  **[docs/VOICES.md](docs/VOICES.md)**.
- 🧠 **Search that understands meaning.** "punishment for misusing AI" finds the Bill's
  *offences and penalties* clause even though the words differ. Keyword and meaning search are
  combined, on the server and offline on the device.
- 🔒 **Private and free.** No API keys, no cloud AI. The model runs on your own machine via Ollama.
- 🏗️ **Production architecture.** API gateway, service discovery, event streaming with a DLQ,
  transactional outbox, CQRS, saga, circuit breakers, idempotency, rate limiting, tracing,
  metrics, SLO alerts, secrets, Kubernetes, CI/CD. See
  **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

- 🎨 **Three palettes, your text style.** Golden Hour, Coastal Linen and Terracotta Garden
  (light and dark, every text pair contrast-checked), plus a choice of reading typeface
  (Literata, Atkinson Hyperlegible, …), size, line spacing, line length and dyslexia-friendly
  spacing. Why each default was chosen: **[docs/READING-DESIGN.md](docs/READING-DESIGN.md)**.
- 🔎 **Research workspace.** Highlight, write your own notes, *Ask the documents*, organise work
  into sessions, and export a research brief with references and a verification checklist.
- 💡 **Worth noting.** Each page lists its key obligations, penalties, deadlines and figures,
  cross-references you can jump to, related passages in the other documents, and your related
  notes — computed on the device, offline.
- 🌐 **Web search, responsibly.** Opt-in per device, via a private SearXNG instance and
  Wikipedia (no API keys, no tracking). Results are ranked and labelled by source quality
  (official Kenyan, intergovernmental, academic, reference, news, other), kept separate from the
  documents in answers, and saved with the date you accessed them.
- 👥 **Private notebooks.** Each person signs in and has their own notebook — on the server and
  on a shared device. Administrators add people, reset passwords and remove accounts (with
  their notes). On your own laptop it runs without any sign-in.
- 🧭 **Structure you can follow.** Real headings and clause lists rebuilt from the PDFs, a
  contents sidebar, a live "you are here" breadcrumb, time left, and an "Up next" signpost.

---

## Run it

### 1. On your own computer (simplest: one process, no Docker)

```bash
pip install -r requirements.txt
python -m bookmind                 # → http://localhost:8000
```

For **Research / Simplify** answers from a model, install [Ollama](https://ollama.com) and pull
a free model once:

```bash
ollama pull llama3.2               # or qwen2.5:7b-instruct, mistral, phi3.5 …
```

Without Ollama, everything still works: Research and Simplify give an *extractive* note built
from the Bill's own definitions and the best-matching cited sentences.

Settings live in `.env` (copy `.env.example`). This runs in **single-user mode**: no sign-in, one
notebook. To give several people their own notebooks, set an administrator password (see
[Accounts](#accounts)).

### 2. As separate services (Docker Compose)

```bash
./deploy/make-secrets.sh                                   # random secrets + self-signed TLS cert
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml exec ollama ollama pull llama3.2
open https://localhost                                     # sign in as bookmind with the password printed above
```

This starts the NGINX edge (TLS, HTTP/2, rate limits, caching), 2× gateway, catalog,
2× search, research, notebook, accounts, websearch, tts + a private SearXNG, Redis and Ollama, on segmented
internal networks. Only `websearch`/`searxng` (and Ollama, for model downloads) can reach the
internet. Turn web search off for everyone with `"web_search_enabled": false` in
`deploy/config/flags.json`; in single-process mode it uses Wikipedia unless you set
`BOOKMIND_SEARXNG_URL`.

Optional profiles:

```bash
docker compose -f deploy/docker-compose.yml --profile observability up -d
#   Grafana http://localhost:3000 · Prometheus :9090 · Alertmanager :9093 · Jaeger :16686
#   set OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318 to export traces
docker compose -f deploy/docker-compose.yml --profile waf up -d    # OWASP CRS WAF on :9443
```

### 3. On Kubernetes

```bash
kubectl create namespace bookmind
kubectl -n bookmind create secret generic bookmind-secrets \
  --from-literal=auth_password="$(openssl rand -base64 30)" \
  --from-literal=internal_token="$(openssl rand -base64 30)" \
  --from-literal=redis_password="$(openssl rand -base64 30)"
kubectl apply -k deploy/k8s          # edit the host in deploy/k8s/ingress.yaml first
```

It expects ingress-nginx, cert-manager and (optionally) Linkerd. For Vault-backed secrets see
`deploy/k8s/secrets.example.yaml`. Manifests are generated by `deploy/k8s/generate.py`.

### Using it on your phone

Offline mode needs HTTPS (browsers only allow service workers on HTTPS or `localhost`).

- **Deployed:** open the HTTPS URL, then use *Add to Home Screen* / *Install app*.
- **On your Wi-Fi:** run the compose stack and give it a locally trusted certificate with
  [mkcert](https://github.com/FiloSottile/mkcert). Write it to `secrets/tls.crt` and
  `secrets/tls.key`, then open `https://<your-computer>.local`.

---

## Using the reader

| Action | How |
|---|---|
| Turn pages | ← → buttons, arrow keys, swipe, type a page number, or jump from **Contents** in the sidebar |
| Change the look | **Aa**: palette, brightness, typeface, size, line spacing, line length, letter spacing, focus |
| Look up a term | Tap a dotted-underlined term for the Bill's own definition |
| Worth noting | Below each page: key points (tap to jump, **Keep** to save), cross-references, related passages elsewhere, your related notes. Toggle in **Aa → Reading aids**. |
| Web search | In search (`/`), **Search the web for "…"**. Or tick **Also consult the web** in the Notebook so Research and Ask include web sources (in a separate, labelled section). Asks once per device before anything is sent. |
| Listen | ▶ (Space). Choose voice / speed / text size in the bar (⚙ on phones): **Natural voices (Piper)** from your server, or this device's voices. Tap a sentence to jump there. Lock-screen controls work. |
| Highlight / note | Select text → **Highlight** to keep it, or **Note** to write your own thoughts about it. Your highlights show on the page; tap one to open it. |
| Research / Simplify | Select text → **Research** (cited explanation) or **Simplify** (plain-English definition), or **Read from here** |
| Ask the documents | **Notebook → Ask the documents**: type a question, get an answer citing `[Doc, p.N ¶M]` (document, page, paragraph) |
| Research sessions | **Notebook → New session** (e.g. "Penalties & enforcement"). New work is filed there; move any note with its session menu. |
| Review & export | Filter (All · Highlights · My notes · Research), search your notebook, sort newest or reading order, add *Your note* to any answer, **Export brief** (Markdown: questions, highlights & notes in reading order, research notes, references) |
| Search | 🔍 or `/`. Searches all four documents and your notes, online or offline, by words *and meaning*. Results found by meaning alone are tagged **Similar meaning**. |
| Notebook | **Notebook** button (top right) or `n`. |
| Citations | Every answer cites document, page and paragraph, e.g. **Bill, p.11 ¶3**. Tap one to land on that paragraph (it flashes). Each answer ends with **Sources**, quoting every cited paragraph. Paragraph numbers sit in the page margin (hide them in **Aa → Reading aids**). |
| Go back | After a search or citation jump, the sidebar offers **Return** to where you were. |

---

## Accounts

Turn accounts on by giving BookMind an administrator password — `BOOKMIND_AUTH_PASSWORD` (or
`BOOKMIND_AUTH_PASSWORD_FILE`); `deploy/make-secrets.sh` and the Kubernetes secret already do.
The first administrator is `bookmind` (change with `BOOKMIND_AUTH_USER`).

| Who | What they do |
|---|---|
| Administrator | Account menu (top right) → **Manage accounts**: add a person (they get a one-time password to share privately), reset a password, disable or re-enable, make admin or reader, delete an account together with its notes. |
| Everyone | Sign in once per device and stay signed in (30 days from last use). **Change password** and **Sign out** are in the account menu. A new account must choose its own password at first sign-in. |

- **Private.** Notes belong to their owner. Nobody else — administrators included — can read
  them through BookMind. On a shared device each person's notebook is stored separately.
- **Offline.** The last person signed in on a device keeps reading and taking notes offline. A
  change made offline is only ever sent as that person, even if someone else signs in first.
- **Security.** Passwords are hashed (scrypt), at least 10 characters (phrases welcome), and
  common ones are refused. Ten wrong attempts lock an account for 15 minutes; sign-ins are also
  rate-limited per address. Disabling an account or resetting its password signs it out everywhere.
- Scripts can call the API with HTTP Basic credentials; unsafe requests need `X-BookMind: 1`.
- **Lost the only administrator password?** Stop BookMind, set a new `BOOKMIND_AUTH_PASSWORD`,
  and move `data/accounts.db` aside (in Docker: the `accounts_data` volume). Start again and the
  administrator is recreated. Notes are not stored in that file, so nothing is lost: re-add the
  other people with the same usernames and their notebooks are theirs again.

## Voices for read-aloud

```bash
python tools/voices.py list                   # installed + recommended voices, with licence notes
python tools/voices.py get en_GB-cori-high    # public-domain-trained British English voice
# Compose: docker compose -f deploy/docker-compose.yml --profile tools run --rm tts-voices get en_GB-cori-high
```

Voice licences differ per voice (some are research-only); `tools/voices.py` records each one's
source and licence, and the app shows it. To make **your own or a professional voice actor's**
voice — recording script, recording tips, fine-tuning, and the consent the Kenyan AI Bill and
Data Protection Act require — see **[docs/VOICES.md](docs/VOICES.md)**.

## Updating or adding documents

When the Bill is amended, or to read other documents, rebuild the page data from PDFs:

```bash
pip install pypdf
cat > docs.json <<'JSON'
[
  {"doc": "strategy", "title": "Kenya Artificial Intelligence Strategy 2025-2030", "short": "Strategy", "pdf": "sources/strategy.pdf"},
  {"doc": "bill", "title": "The Artificial Intelligence Bill, 2026 (Senate Bill No. 4)", "short": "Bill", "pdf": "sources/bill.pdf"}
]
JSON
python tools/ingest.py docs.json --report report.json    # writes data/chunks.json
```

It repairs common PDF extraction damage, removes running headers and page-number footers, and
lists pages without a text layer (scans). Add `--ocr` to recognise those with Tesseract
(`apt install poppler-utils tesseract-ocr`). Structure (headings, clauses, lists) is rebuilt by the
reader automatically. Restart BookMind (or redeploy) to serve the new data; each device picks it
up on its next visit, and saved notes keep pointing at the same document and page.

## Project layout

```
bookmind/
  common/        platform library: config & flags, secrets, telemetry, resilience, KV/cache,
                 event bus (memory / Redis Streams), RPC + discovery, idempotency, saga
  services/      gateway (+ auth.py: sign-in & sessions) · accounts · catalog · search · research ·
                 notebook · websearch · tts   (one ASGI app each)
  local.py       single-process wiring        serve.py   container entrypoint (SERVICE=…)
tools/           ingest.py (PDFs → data/chunks.json) · themes.py (palettes → themes.css, contrast-checked)
                 voices.py (download / add Piper voices, with licence + consent records)
web/             offline-first PWA (no build step, no CDN): index.html, css/, js/, sw.js
data/chunks.json the four documents, page by page
deploy/          docker-compose, nginx edge, prometheus/alertmanager/grafana/promtail, k8s
tests/           unit + integration tests (Redis backends run when TEST_REDIS_URL is set)
tests/e2e/       browser tests (Playwright, desktop + phone, axe-core accessibility audit)
docs/            ARCHITECTURE.md (blueprint → implementation), original design notes
```

## Development

```bash
pip install -r requirements-dev.txt
ruff check . && pytest -q && node --test "tests/js/*.test.mjs"
(cd tests/e2e && npm ci && npx playwright install chromium && npx playwright test)   # browser tests
# already have a Chromium (e.g. from another Playwright version)? skip the install and use it:
#   PW_CHROMIUM_PATH=/path/to/chrome npx playwright test
python tools/themes.py            # regenerate web/css/themes.css after editing a palette
TEST_REDIS_URL=redis://localhost:6379/0 pytest -q     # also exercise the Redis backends
```

CI (`.github/workflows/ci.yml`) runs lint, tests against a real Redis, `pip-audit`, manifest
and alert-rule validation, then builds a scanned image. Tagged releases can roll out to
Kubernetes behind an approval gate.

## License

[AGPL-3.0-or-later](LICENSE). If you run a modified BookMind as a network service, you must
offer its source to its users.
