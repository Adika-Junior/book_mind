# BookMind — Architecture & Tech Stack
### A local-first RAG reader for PDFs and books, prototyped on the Kenya AI Strategy 2025–2030, its Implementation Roadmap, the AI Bill 2026, and the Senate Bill Digest

> **Update — local, free, private by default.** Everything below now describes a stack that
> runs entirely on your own machine: a free open-weight model via **Ollama** for generation,
> plain-Python **BM25** for retrieval, your OS/browser's built-in voices for TTS, and **SQLite**
> for storage. No API keys, no paid services, no data leaving your computer. A working build of
> this — `kenya-ai-policy-reader-local.zip` (the BookMind prototype) — is provided alongside
> this document; see §0.
>
> **Update 2 — hosting it.** Since you're planning to deploy this rather than only run it on
> `localhost`, §10 and §11 below add the system-design and security practices that matter once
> the app is reachable by more than just you on one machine: containerization, CI, auth, HTTPS,
> rate limiting, prompt-injection handling, secrets management, and backups.

---

## 0. The local build (what's actually running)

```
Your machine
├── Ollama (free, open source) ── runs a local model (Llama 3.2 / Qwen2.5 / Mistral / Phi-3.5…)
│                                   on http://localhost:11434 — no internet needed once pulled
├── FastAPI backend (app.py) ──── BM25 retrieval (rank_bm25, pure Python) over the 4 documents
│                                   + calls Ollama for "Research this" / "Simplify"
│                                   + SQLite (data/notebook.db) for saved notes
└── Browser UI (static/index.html) ── the book reader, paging, highlighting,
                                        Web Speech API for read-aloud (built into your OS/browser)
```

**Setup:** install Ollama → `ollama pull llama3.2` (or any free model) → `pip install -r requirements.txt`
→ `uvicorn app:app --reload` → open `http://localhost:8000`. Full steps are in the included `README.md`.

**Why this satisfies "local, private, free":**
- The model is **downloaded once and runs on your CPU/GPU** — no request ever leaves your machine, no per-use cost, works on a plane.
- Retrieval (BM25) needs no model download or GPU at all — it's ranking by word overlap, in pure Python.
- TTS is your browser/OS's own voice engine — already on your machine, already free.
- Storage is a SQLite file — you can open it, back it up, or delete it yourself.

**Trade-off to be upfront about:** a free 7–8B local model (Llama 3.2, Qwen2.5-7B, Mistral-7B) is noticeably less capable than a frontier hosted model at nuanced legal reasoning — it will sometimes be vaguer or need a second look on subtle cross-references. §4.4 below explains how to get the most out of a small local model, and how to size up (bigger local model, still free) if your machine can handle it.

> **Note on this conversation itself:** the chat you're having with me right now runs on Anthropic's servers, like any claude.ai conversation — that part isn't local. What *is* now fully local and free is the standalone app I built for you (§0), which you run yourself and which never calls Claude, or any other paid API, at all.

---

## 1. What you asked for, restated as a spec

1. **Ingest** arbitrary source documents (PDF, scanned or digital) and turn them into a **"digital book"** — clean, paginated, readable text with structure preserved (parts, clauses, sections).
2. **Read aloud** with a **selectable voice**, **pause/resume**, and **scroll-while-listening**, with the system **remembering where you left off** across sessions.
3. **Highlight → Research**: select any passage and get a well-presented, **cited** explanation — grounded in the four documents, not hallucinated.
4. **Jargon mode**: detect dense/legal/technical language and explain it simply, with analogies.
5. **Save** the research (a personal, citable notebook you can export).
6. Voices/providers should be swappable.

This is a **RAG-powered reading companion**, not a chatbot bolted onto a PDF viewer. The retrieval has two jobs: (a) ground TTS/book content in the *actual* source text, and (b) ground every "Research this" answer in citable passages — including passages the reader *isn't* currently looking at (cross-document linking, e.g. Bill Digest → actual Bill clause → Strategy pillar it implements).

---

## 2. What I built as a working prototype

There are two builds. **The local one (`kenya-ai-policy-reader-local.zip`) is the one that matches
what you asked for** — free, offline-capable, nothing sent anywhere — and is the one to actually use.
A browser-only version was built first and is kept below for context on the trade-off.

### 2a. Local build — `kenya-ai-policy-reader-local.zip` (recommended)

A small FastAPI app + browser UI, meant to run on your own computer (§0). It contains all 260
"pages" (~62,000 words) from the four documents, chunked page-by-page, with:
- A book-style reader (prev/next, keyboard arrows, progress bars per document)
- Browser/OS text-to-speech (any installed system voice, adjustable rate, sentence-level highlighting synced to speech, auto-turns the page and keeps reading) — same as before, and it was *already* fully local and free
- Resume-where-you-left-off, stored locally
- Highlight → **Research this** / **Simplify / define** — BM25 retrieval across all 260 chunks (in the Python backend), then a prompt sent to **your own Ollama model**, answering *using only the highlighted text + retrieved passages*, with citations like `[Bill, p.4]`
- A **Notebook** — saved to a local SQLite file, exportable to Markdown
- Light/dark mode, mobile-responsive

This is the same **chunk → retrieve → augment prompt → generate → cite → persist** pipeline as any production RAG system — the difference from a cloud build is *where* each step runs (all four run on your machine) and *what* does the generating (a free model you downloaded, not a paid API).

### 2b. Browser-only build (kept for reference, not the local/free answer)

An earlier version ran entirely as a single HTML page and used Claude (via Anthropic's API) to
generate the research notes. That's a hosted, paid model — the opposite of what you asked for
here — so it's no longer the recommended build; §0 and §4 below describe the local replacement
in full. It's mentioned only because it illustrates the one real constraint: **a page published
to claude.ai cannot reach a local server on your computer** (browser sandboxing blocks
`localhost` requests from a hosted page), so genuine local-model inference has to be a small app
you run yourself, not something embedded in a claude.ai artifact link. That's exactly what §0's
zip is.

**What's simplified vs. a larger production build**, and why:
- **Retrieval is lexical (BM25/keyword overlap), not semantic (embeddings).** At 260 chunks this is fast, needs no model download, and no GPU. At the scale of "every Kenyan bill + every strategy doc," you'd add a free local embedding model — see §4.2.
- **The model is a free 7–8B local model**, not a frontier model — see §4.4 for what this trades off and how to size up while staying free.
- **Progress is stored in the browser** (localStorage) while **notes are stored server-side** (SQLite) — so notes survive clearing browser data, but "resume where I left off" is per-browser. See §6 for the multi-device version (still free, just more setup).
- **The scanned Bill PDF has no text layer**, so its text was transcribed from the page images already in this conversation rather than OCR'd — §3 below covers free local OCR (Tesseract) for documents like this in general.

---

## 3. Ingestion pipeline (PDF → structured "book")

```
                 ┌────────────┐
 Source PDFs ───▶│  Classify   │  has text layer? (pdffonts) → text extraction
 (strategy,      │  each file  │  scanned/no fonts?           → OCR
  roadmap,        └─────┬──────┘
  bill, digest)         │
                         ▼
                 ┌────────────┐
                 │  Extract    │  pdftotext -layout / PyMuPDF (fitz) for text PDFs
                 │  text +     │  Tesseract / AWS Textract / Google Document AI for scans
                 │  structure  │  (Textract & Document AI also recover tables & reading order)
                 └─────┬──────┘
                         ▼
                 ┌────────────┐
                 │  Structure  │  Detect headings/clauses via regex + layout cues
                 │  detection  │  ("CLAUSE 12—", "PART III", "4.2.1") → build a hierarchy:
                 │             │  Document → Part → Clause/Section → Paragraph
                 └─────┬──────┘
                         ▼
                 ┌────────────┐
                 │  Chunking   │  Chunk at the *semantic* boundary (clause/section), not a
                 │             │  fixed token window — legal/policy text loses meaning when
                 │             │  cut mid-clause. Target ~150–400 words/chunk, keep the clause
                 │             │  number + document + page as metadata on every chunk.
                 └─────┬──────┘
                         ▼
                 ┌────────────┐
                 │  Embed +    │  Vector per chunk (see §4) + full-text index (see §4.3)
                 │  Index      │  + store the original chunk text for citation/display
                 └─────┬──────┘
                         ▼
                 ┌────────────┐
                 │  "Book"     │  Render each chunk as a page in a paginated reader;
                 │  assembly   │  preserve the document's own table of contents as the nav.
                 └────────────┘
```

**Recommended tools per stage:**

| Stage | Library / service | Notes |
|---|---|---|
| Text-layer PDFs | `PyMuPDF` (fitz) or `pdfplumber` | Faster and more layout-aware than `pdftotext`; gives bounding boxes, which lets you highlight the *exact* words on the *original page image* later. |
| Scanned PDFs (like your Bill upload) | Google Document AI, AWS Textract, or `Tesseract` + `pytesseract` | Textract/Document AI also do table & form extraction, useful for the Roadmap's many figures/tables. |
| Structure detection | Rule-based first pass (regex on numbering patterns) + LLM cleanup pass | Legal/gazette documents have very regular numbering ("CLAUSE 12—", "(a)", "(i)") — regex gets you 90% of the way; use an LLM call only to resolve ambiguous headings. |
| Chunking | Custom, clause-aware (as above) | Off-the-shelf "semantic chunkers" (LangChain's `RecursiveCharacterTextSplitter`, LlamaIndex's `SentenceSplitter`) are fine for the narrative Strategy/Roadmap docs; the Bill and Digest deserve **clause-aware** chunking so each chunk is a complete legal unit (a full "commits an offence if…" clause never gets split across two chunks). |

---

## 4. The RAG core: retrieval — free & local

### 4.1 What the local build uses now
**BM25** (`rank_bm25`, pure Python) over the 260 page-chunks. No model download, no GPU, no
internet call, effectively instant at this corpus size. This is a real, well-established
retrieval algorithm (it's what full-text search engines used before embeddings existed) —
not a placeholder. It's *particularly* good at exactly the queries a legal/policy reader makes:
exact section numbers, defined terms, penalty amounts — the things pure semantic search
sometimes fuzzes over.

### 4.2 Free local embeddings, if/when you want semantic search too
BM25 alone can miss a highlight like *"what happens if the system is biased against a group"*
matching clause 26(1)(c), which never uses the word "bias" in that phrasing. If you want that
kind of conceptual match, add a **free, local** embedding model — no paid API required:

| Option | Notes |
|---|---|
| **Ollama embeddings** (`ollama pull nomic-embed-text` or `mxbai-embed-large`) | Simplest path if you already have Ollama installed for generation — same tool, one more `pull`, fully local. |
| **sentence-transformers** (`all-MiniLM-L6-v2`, ~80MB, or `bge-small-en-v1.5`) | Pure Python (`pip install sentence-transformers`), downloads the model weights once, then runs entirely offline on CPU. Free and open source (Apache/MIT licensed). |

Store the resulting vectors in **Chroma** (`pip install chromadb`) or plain **FAISS**
(`pip install faiss-cpu`) — both are free, open-source, embedded (no server process), and store
their index as local files. For a 260-chunk corpus either indexes in under a second and needs no
tuning.

### 4.3 Hybrid retrieval (still fully local, still free)
1. **BM25** for exact terms, section numbers, defined terms (already implemented).
2. **Local embedding search** (§4.2) for conceptual matches, once added.
3. **Reciprocal rank fusion** to merge the two ranked lists — a few lines of Python, no library needed.
4. **Cross-document boosting**: when the anchor passage is from the *Digest* (a summary), boost retrieval of the *matching Bill clause* it summarizes, and vice versa — this is the "search for similarities across documents" behavior you asked for. Resolve `digest_maps_to: bill.clause_26` links once at ingestion time (regex on "under section N" references) rather than relying on retrieval to find it by chance.
5. **Re-rank**, if you want to go further: `bge-reranker-base` via `sentence-transformers` — also free, local, CPU-friendly at this corpus size — to sharpen the top-5 that actually go in the prompt.

None of the above requires an internet connection once the (free) model weights are downloaded the first time.

### 4.4 Generation with a free local model (Ollama)
- **Model choice** (all free, all run via `ollama pull <name>`):

  | Model | Size | Good for |
  |---|---|---|
  | `llama3.2` | ~2GB (3B) | Fast, low-RAM machines, the default in the local build |
  | `qwen2.5:7b-instruct` | ~4.5GB | Strong instruction-following, good at the structured "## headings" format the prompts ask for |
  | `mistral` | ~4GB | Solid general-purpose 7B |
  | `llama3.1:8b` | ~4.7GB | A step up in reasoning if your machine has 16GB+ RAM |
  | `phi3.5` | ~2GB | Smallest/fastest, for modest hardware |

  Bigger free local models (e.g. `qwen2.5:32b`, `llama3.1:70b`) exist too if you have the RAM/VRAM — same `ollama pull`, same zero cost, just heavier on your machine. There's no ceiling imposed by the architecture, only by your hardware.
- The prompt sent to the model is built **only from the retrieved chunks + the highlighted passage**, with an explicit instruction to cite `[Document, page]` and to say "not found in these documents" rather than fill gaps from general knowledge — this matters *more* with a small local model, since smaller models are more prone to drifting off the provided context if not constrained.
- Two prompt templates, matching what's in the app:
  - **Research** → Plain-English explanation / Why it matters / Related provisions (cited) / Worth checking further.
  - **Simplify** → short glossary-style definition with an everyday analogy, for jargon/acronyms.
- **Getting more out of a small model, for free:** keep prompts short and structured (already done), lower `temperature` for factual/citation tasks (Ollama's `options: {temperature: 0.2}`), and consider a two-pass check for high-stakes reading — ask the same small model "does this answer cite only the passages given?" as a second call before showing the note. All still free, just slightly slower.
- Log every generation with its retrieved-chunk IDs (a one-line addition to `app.py`) — lets you audit "did the model actually use the Bill, or did it drift" later.

---

## 5. Reading experience: TTS, highlighting, pacing — free & local

| Need | What the local build uses | Notes |
|---|---|---|
| Selectable voice | Browser/OS `SpeechSynthesis` (Web Speech API) — whatever voices are installed on your system | Already free, already local, already offline — this doesn't change. Voice quality/selection depends on your OS (macOS/Windows ship several; Linux depends on `espeak-ng`/`festival` being installed). |
| Higher-quality *free* local voices, if you want them | **Piper TTS** (`pip install piper-tts`) — fast neural TTS, runs fully offline on CPU, many free downloadable voices, no account needed. Or **Coqui TTS** (`pip install TTS`) for even higher quality / voice cloning, heavier to run. | Both are open source and free. Swapping one in means the backend generates a `.wav` per sentence/chunk and the frontend plays it via `<audio>` instead of calling `SpeechSynthesis` — same architecture, different TTS call in `app.py`. |
| Sentence highlight while reading | JS splits chunk text into sentences, highlights the one currently being spoken | Piper can output phoneme/word timing info for tighter word-level sync, if you want to go further than sentence-level. |
| Pause / resume / scroll | Native `pause()`/`resume()` on the browser's utterance queue | Works today, no changes needed. |
| "Remember where I left off" | `localStorage`, per browser | Free and local as-is. For cross-device resume without any cloud service, see §6. |

*(Note: paid options like ElevenLabs, Amazon Polly, or Google Cloud TTS would give the widest voice selection and word-level timestamps out of the box — mentioned here only for completeness. They are not used or needed in the local build, and are not required to satisfy "free and local.")*

---

## 6. Persistence & accounts — still free & local, including across devices

```
notes.db (SQLite, one file, already implemented) ── NotebookEntry (id, doc, page, mode, selection, answer, ts)
reading_position (localStorage today) ── per-browser; see below for cross-device without the cloud
```

- **SQLite** (already in the local build) is genuinely enough for a single-user tool — it's a
  zero-config file, free, and you can open it directly (`sqlite3 data/notebook.db`) to inspect or
  back up your notes.
- **Cross-device resume, still without a paid cloud service:** point `data/` at a folder that syncs
  itself for free — a **Syncthing** folder (free, open source, peer-to-peer, no cloud account) or a
  free-tier personal cloud drive folder (Dropbox/Google Drive's free tier, iCloud) — and run the app
  from each device against that same synced folder. No code changes needed; this is purely a
  question of where `data/notebook.db` physically lives.
- **If you outgrow SQLite** (many users, concurrent writers): self-hosted **Postgres** is still free
  and open source — just a heavier install than a single file. Only worth it if this stops being a
  personal tool.
- **Export**: the app already renders notes to Markdown on demand. The same approach extends to
  DOCX/PDF via free local libraries (`python-docx`, `reportlab`/`weasyprint`) if you want a formatted
  report with a references section, with no paid service involved.

---

## 7. Recommended tech stack — 100% free & local

| Layer | Recommendation | Cost | Why |
|---|---|---|---|
| Frontend | Plain HTML/JS (as built), or **Next.js** if it grows | Free | No build step needed for a tool this size; Next.js only pays off once you're SSR-ing a much larger app. |
| Reading UI | Custom paginated renderer (as built) or **epub.js** (open source) | Free | Custom gives clause-level anchors for citations; EPUB.js is faster to ship if you convert the corpus to EPUB. |
| TTS | **Web Speech API** (built into every OS/browser) as the default; **Piper TTS** or **Coqui TTS** (open source) for higher-quality offline voices | Free | Satisfies "change voices as per my availability" — swap the voice list, or swap the whole TTS backend, without touching the RAG layer. |
| Backend / API | **FastAPI** (Python) — as built | Free | Natural fit given the PDF/OCR/retrieval tooling is mostly Python. |
| RAG orchestration | Hand-rolled retrieval module (as built, §4.3) | Free | Full control over clause-aware chunking and cross-reference boosting, which matter more here than a framework's convenience methods. |
| LLM | **Ollama** running a free open-weight model — `llama3.2`, `qwen2.5:7b-instruct`, `mistral`, or bigger if your hardware allows | Free | Runs on your machine, no API key, no per-token cost, works offline after the one-time download. |
| Embeddings (optional, §4.2) | **Ollama** (`nomic-embed-text`) or **sentence-transformers** (`all-MiniLM-L6-v2`, `bge-small-en`) | Free | Local, open source, small enough to run on CPU. |
| Vector store (optional) | **Chroma** or **FAISS** | Free | Embedded, file-based, no server to run. |
| Full-text search | **`rank_bm25`** (as built), or SQLite's built-in `FTS5` | Free | Zero dependencies beyond a `pip install`. |
| Database | **SQLite** (as built) | Free | One file, no server, easy to back up. |
| File/audio storage | Local disk, or a free-tier synced folder for cross-device (§6) | Free | No object storage service needed at this scale. |
| Hosting | Your own computer (`uvicorn app:app`) | Free | This is a personal tool — "hosting" is just running it. |
| Observability | Log retrieved-chunk IDs + prompt + response to a local file | Free | Still worth doing even for a personal tool, to catch when the small local model drifts off-source. |

**Nothing in this table has a subscription, API key, or usage-based bill.** The only one-time
"costs" are disk space (a few GB for the model weights) and the time to `pip install` and
`ollama pull` once.

---

## 8. Answering your specific asks directly

- **"Convert the document to a digital book"** → §3 ingestion pipeline; done for all 4 docs (260 pages), in `data/chunks.json`.
- **"Read out loud with the voice I've chosen, pause, scroll"** → §5; working now via your OS/browser's own voices — already free, already local, no change needed to satisfy "free."
- **"The AI/model should work locally and privately, for free"** → §0 and §4.4: Ollama running a free open-weight model on your own machine. No API key, no account, no data leaving your computer, no bill.
- **"Highlight and instruct research, well-presented like a book, with references"** → §4.4 + the Notebook panel; every answer is cited to `[Document, page]`, generated by your local model.
- **"Remind me where I left off"** → working now per-browser (free, local); §6 for cross-device without any paid cloud service.
- **"Change voices as per my availability"** → voice dropdown now (whatever's installed, free); swapping in Piper/Coqui for higher-quality offline voices is a config change, not a rewrite, since TTS is called from one place in the backend.
- **"Use free/available tools"** → every tool in §7 is free and open source; the one download required (a model via `ollama pull`) is also free.
- **"For jargon, search for similarities and give easy ways to explain"** → the **Simplify / define** mode + hybrid retrieval with cross-document boosting (§4.3) — this is exactly the "does the Bill Digest's plain-English gloss cover this Bill clause more simply" lookup.

---

## 9. Suggested next steps, staying free and local throughout

1. **Run it** (§0): install Ollama, pull `llama3.2`, `pip install -r requirements.txt`, `uvicorn app:app --reload`. Everything else below is optional polish.
2. **Try a couple of free models** for the generation step (`qwen2.5:7b-instruct` tends to follow the "## headings" format most reliably; `llama3.2` is fastest) and keep whichever gives you better research notes on this corpus.
3. Add **local embeddings** (§4.2, `nomic-embed-text` via Ollama or `sentence-transformers`) + **Chroma/FAISS** once BM25-only retrieval starts missing conceptual (non-keyword) matches you'd expect it to find.
4. Add the **cross-reference resolver** (Digest ↔ Bill ↔ Strategy links, §4.3.4) at ingestion time — this is what makes "jargon → easy explanation" and "related provisions" feel intelligent rather than keyword-coincidental, and it's pure Python (regex on "under section N"), no new tools needed.
5. If you want higher-quality offline voices than your OS's default, swap in **Piper TTS** (§5) — still free, still local, one function in `app.py` to change.
6. If you ever want this on more than one of your own devices, point `data/` at a free synced folder (§6) rather than reaching for a cloud database.

Every step above adds capability without adding a single dependency that costs money or calls out to the internet at runtime.

---

## 10. System design & engineering practices

These apply whether BookMind stays a personal tool or becomes something others use — they're what separates a script from a maintainable app, and they cost nothing to adopt.

### 10.1 Modularity / separation of concerns
Keep four layers distinct, each replaceable without touching the others:
```
ingest/     -- PDF/OCR -> chunks.json  (swap: pdftotext -> PyMuPDF, add Tesseract for scans)
retrieve/   -- BM25 (+ optional embeddings)  (swap: rank_bm25 -> Chroma, add reranking)
generate/   -- prompt building + Ollama call  (swap: model name, add a second provider)
storage/    -- SQLite notes, reading position  (swap: SQLite -> Postgres if multi-user)
```
`app.py` currently does all four in one file, which is fine at this size — but keep the *functions*
cleanly separated (`retrieve()`, `build_prompt()`, the Ollama call, the DB calls already are) so
splitting into modules later is a file move, not a rewrite.

### 10.2 API design
- Namespace and version the API now, before anyone else depends on it: `/api/v1/generate`, `/api/v1/notes` — costs nothing today, avoids breaking clients later.
- Use HTTP status codes meaningfully (already doing this: `503` when Ollama's unreachable, not a `200` with an error string buried in the body).
- Auto-generated docs are free with FastAPI — `http://localhost:8000/docs` gives you a Swagger UI with zero extra code, useful once you're not the only one calling the API.

### 10.3 Resilience & error handling
- **Already implemented**: Ollama-down returns a clear `503` with instructions, rather than a stack trace; the frontend shows an inline error in the note card rather than failing silently.
- **Add as it grows**: retry with backoff for transient Ollama timeouts (`tenacity` library, free); a request timeout on the frontend `fetch()` calls so a hung generation doesn't leave the UI stuck.
- **Degrade gracefully**: the book, TTS, and paging already work fully even if the backend or Ollama is down — keep that property as you add features. A RAG feature failing should never take down the reading experience.

### 10.4 Caching
- Cache `retrieve()` results and `generate()` responses keyed on `(chunk_id, selection_hash, mode)` — if you highlight the same passage twice, or reread a document, you shouldn't re-run BM25 or re-prompt the model. A simple `functools.lru_cache` or a `cache` table in SQLite is enough; no Redis needed at this scale.
- This also matters for hosting: it's the cheapest way to keep response times low and CPU load down if more than one person uses the instance.

### 10.5 Observability
- Structured logging (Python's `logging` module with a JSON formatter) instead of `print()` — include a request ID, the endpoint, latency, and (for `/generate`) the retrieved chunk IDs and which model answered. This is what lets you debug "why did it cite the wrong clause" after the fact.
- Rotate logs (`logging.handlers.RotatingFileHandler`) so a long-running hosted instance doesn't fill the disk.
- If it grows beyond personal use: a free-tier of **Grafana Cloud** or a local **Prometheus + Grafana** (both free, open source) for latency/error-rate dashboards. Overkill for now — mentioned so you know the free path exists when you need it.

### 10.6 Testing
- **Unit tests** (`pytest`, free): `retrieve()` returns the expected top chunk for a known query; `build_prompt()` includes the citation instruction; `clean()` in the chunking script strips control characters. Fast, no model or server needed.
- **Integration tests**: spin up the FastAPI app with `TestClient` (built into FastAPI, free) and hit `/api/health`, `/api/retrieve`, `/api/notes` — exactly the checks done manually in this conversation, turned into code that runs on every change.
- Mock the Ollama call in tests (a fixture returning a canned response) so the test suite doesn't need Ollama installed to run in CI.

### 10.7 CI/CD
- **GitHub Actions** (free for private repos, generous minutes) — a workflow that runs `pytest` and a linter (`ruff`, free) on every push/PR. A ~15-line YAML file; catches regressions before they reach your hosted instance.
- Pin dependency versions (already done in `requirements.txt`) so CI and your hosting environment install the exact same thing you tested.

### 10.8 Containerization
- A `Dockerfile` for the FastAPI app + a `docker-compose.yml` that also runs an `ollama/ollama` container (the official image, free) makes hosting reproducible: `docker compose up` gets you the whole stack — app, model runner, and a persistent volume for `data/` — on any machine, VPS included.
- This is the single highest-leverage thing to add before hosting: it removes "works on my machine" as a category of bug, and makes moving to a new server a non-event.

### 10.9 Configuration management
- **Already implemented**: `OLLAMA_URL`, `OLLAMA_MODEL`, auth, and CORS settings all read from environment variables (via `python-dotenv` + `.env`), never hardcoded — see `app.py` and `.env.example`.
- This is a "12-factor app" principle — config lives in the environment, not the code — and it's what lets the same Docker image run identically on your laptop and on a hosted server with different settings.

---

## 12. Security through history — what 125 years of attacks teach a small app

You asked for the broader security/cyber picture, not just today's checklist. Threats change shape every decade, but the underlying *lessons* repeat — and BookMind's design already reflects most of them. This section is that history, condensed, with each era's lesson mapped to something concrete in this project.

### 12.1 A condensed timeline

| Era | What happened | The lasting lesson |
|---|---|---|
| **1900s–1910s** | Wireless telegraphy arrives; Marconi's "unhackable" radio is publicly jammed and mocked live in 1903 by magician Nevil Maskelyne — the first recorded demonstration that a new communication medium is insecure by default. | **Security is not a side-effect of new technology — it has to be designed in.** |
| **1930s–40s** | Enigma and other rotor ciphers; Bletchley Park's codebreaking (Turing et al.) shows that even mathematically strong-looking systems fall to procedural weaknesses (reused keys, predictable message formats) as much as to raw cryptanalysis. | **Systems are broken through operational mistakes as often as through the algorithm itself** — key management matters as much as the cipher. |
| **1960s–70s** | "Phone phreaking" (Cap'n Crunch whistle exploiting AT&T's in-band signaling); early time-sharing systems get the first password files and the first password thefts. | **Any shared system needs authentication and separation between users from day one** — bolting it on later is always harder. |
| **1976–77** | Diffie–Hellman and RSA publish practical public-key cryptography. | Makes secure communication over an untrusted network (i.e., the internet) mathematically tractable — **the entire basis for HTTPS**, which is exactly what §11.2 puts in front of BookMind once hosted. |
| **1988** | The **Morris Worm** — the first major internet worm — spreads via a buffer overflow, weak/guessable passwords, and systems that implicitly trusted their network neighbors. Takes down ~10% of the internet. | **Validate input, never trust a peer by network position alone, and default credentials are a vulnerability, not a convenience.** Directly why Ollama in BookMind is never exposed to the network (§11.3) and why auth uses a real secret, not a hardcoded default (§11.1). |
| **1999–2001** | Macro viruses (Melissa) and email worms (ILOVEYOU) spread by getting a human to open a file and enable "just this once." Early web-app era brings **SQL injection** as attackers realize user input often reaches a database or interpreter unescaped. | **Untrusted input should never be treated as code**, whether it's a document a human opens or a string that reaches a query. This is why BookMind's SQLite calls use parameterized queries (`?` placeholders, never string-formatted SQL) — the same discipline that stops SQL injection. |
| **2001–2003** | Code Red, Nimda, SQL Slammer — self-propagating worms exploiting *unpatched* known vulnerabilities, spreading in minutes across the internet. | **Patch cadence is a security control, not housekeeping.** §11.8/Dependabot exists for exactly this reason. |
| **2010** | **Stuxnet** — a nation-state-grade worm targeting industrial control systems, delivered via USB (bridging an "air-gapped" network) and using multiple zero-days plus a stolen code-signing certificate. | **Supply chain and physical/removable media are attack surfaces too**, and "not connected to the internet" isn't the same as "secure." Relevant to any future feature letting people import PDFs from USB/email attachments — treat imported files as untrusted regardless of source. |
| **2013–2014** | Target (2013) and Heartbleed (2014) — a retailer breached via a *third-party HVAC vendor's* credentials; a critical flaw in OpenSSL, one of the most widely trusted crypto libraries on earth, silently leaking server memory for two years before discovery. | **Trust is transitive — your security is only as strong as every vendor/dependency you rely on**, and even foundational, widely-audited software has bugs. This is the case for pinned dependencies + `pip-audit`/Dependabot (§11.8) rather than "it's a popular library, it must be fine." |
| **2016** | The **Mirai botnet** — hundreds of thousands of IoT devices compromised via a hardcoded list of ~60 default username/password pairs nobody had changed. | **Never ship a real deployment with a default credential.** BookMind's auth is opt-in and off by default for pure local use, but the moment you set `BOOKMIND_AUTH_PASSWORD` for hosting, it must be a real, unique secret — never leave it as a placeholder. |
| **2017** | **WannaCry** and **NotPetya** — ransomware worms exploiting an *already-patched* Windows SMB flaw (EternalBlue), hitting organizations that simply hadn't applied the update yet. | **Backups are a security control, not a convenience feature** — the difference between a ransomware incident being a bad afternoon versus an existential loss is whether a recent, offline backup exists. §11.9's backup guidance for `notebook.db` is this lesson applied. |
| **2020** | **SolarWinds** — attackers compromised the *build pipeline* itself, so a trusted vendor's official, signed software update silently carried a backdoor to ~18,000 organizations. | **The build/dependency chain is part of your attack surface**, not just your own code. Pin exact versions, prefer official base images, and be deliberate about *when* you update, not just *whether*. |
| **2021** | **Log4Shell** — a ubiquitous Java logging library evaluated attacker-controlled strings found *inside log messages* as executable lookups, turning ordinary logging into remote code execution. | **Never let untrusted input reach any place that interprets it as code or a template** — including logs. It's why BookMind's markdown renderer HTML-escapes model output *before* formatting it (§11.6), and why structured logging should log user input as inert data, never format it into a command. |
| **2020s** | **AI-specific threats emerge**: prompt injection (instructions hidden in retrieved content trying to hijack a model), indirect prompt injection via documents/web pages an LLM reads, training-data poisoning, and increasingly convincing AI-generated phishing/deepfakes. | **The 1999 lesson ("a document is not just data, it can carry an attack") is back, aimed at LLMs instead of mail clients.** §11.6 treats every retrieved chunk as untrusted data the model should describe, never obey — this is the direct 2020s descendant of "don't let email attachments execute."
| **Constant across every era** | Social engineering — tricking a human rather than breaking a system — remains, per every major breach report from the 1970s to today, the single most common way in. | Technology can't fully fix this; keeping BookMind's trust boundary small (one admin credential, no complex user-management surface to social-engineer) is the practical mitigation available at this project's scale. |

### 12.2 What this changes in BookMind, concretely
Most of the above is already reflected in earlier sections — this table exists to show *why*, not to introduce brand-new controls. Two small additions worth calling out:

1. **Startup warning for the Mirai/default-credential lesson**: if the app is ever run bound to a public interface without `BOOKMIND_AUTH_PASSWORD` set, it should say so loudly in the logs at startup, rather than silently running open. (Added — see `app.py`.)
2. **Treat future file uploads like 1999-era email attachments**: if/when BookMind grows a "add your own PDF" feature, process uploads in a sandboxed step (a separate worker process or container with no network access) and disable any embedded-JavaScript execution in whatever PDF library parses them — PDFs are a decades-old, still-active malware delivery format for exactly the Melissa/Stuxnet reasons above.

### 12.3 The one-paragraph version
Nearly every major incident in this history reduces to one of a handful of repeated failures: **trusting input that turns out to be attacker-controlled, trusting a peer or vendor without verifying them, shipping a default that nobody changed, or not having a way back after something went wrong.** BookMind's design choices in §11 — parameterized queries, no default credentials, Ollama never network-exposed, escaped model output, pinned dependencies, and local backups — map directly onto avoiding each of those four, at a scale appropriate for a personal/small-hosted tool rather than an enterprise.

---

## 11. Security & hosting hardening

The local-only version was single-user, `localhost`-only, and trusted by definition — anyone who could reach it was already sitting at your keyboard. **The moment you host it, that assumption disappears**, so the following stop being optional.

### 11.1 Authentication
- At minimum: **HTTP Basic Auth** in front of every route, password from an environment variable, checked with `secrets.compare_digest` (constant-time comparison, avoids timing attacks) — a few lines with FastAPI's `HTTPBasic`, free.
- Better, if you want real accounts later: session-based auth with a hashed password (`passlib`/`bcrypt`, free) or a free auth provider (**Supabase Auth**, **Clerk**'s free tier).
- Simplest of all, and free: put **Caddy** or **Authelia** in front of the app as a reverse proxy doing the login, so `app.py` itself stays auth-agnostic. Recommended if you don't want to touch the app code for this.

### 11.2 Transport security (HTTPS)
- Never expose the app over plain HTTP once it's on the internet. **Caddy** (free, open source) gets you automatic HTTPS via Let's Encrypt with a two-line config file — the easiest free path. **nginx + certbot** is the more manual free alternative.
- Terminate TLS at the reverse proxy, keep the FastAPI app listening only on `localhost`/an internal Docker network — never bind Uvicorn directly to a public IP.

### 11.3 Network exposure
- **Ollama should never be reachable from the internet.** Keep it bound to `127.0.0.1` (its default) or, in Docker, on an internal network the FastAPI container can reach but the host's firewall doesn't expose. If someone else reaches your Ollama port directly, they get free, unauthenticated use of your compute.
- Firewall (`ufw` on most VPS providers, free): only ports 443 (and 22 for SSH) open to the world; everything else internal-only.

### 11.4 CORS
- FastAPI's `CORSMiddleware`, restricted to the exact origin(s) BookMind is served from — not `allow_origins=["*"]`. Prevents another website from making authenticated requests to your instance on a visitor's behalf.

### 11.5 Input validation & abuse limits
- Pydantic models (already in use for every request body) reject malformed input by default — keep this.
- Add explicit length caps on `selection` and `context_text` in `GenerateRequest` (e.g. 2,000 / 5,000 characters) — without this, someone could paste a huge block of text into a request and force a very slow/expensive generation.
- **Rate limiting**: `slowapi` (a free FastAPI-compatible port of Flask-Limiter) — cap `/api/generate` to something like 10 requests/minute per IP. This is as much about protecting *your own hardware* (a hosted local model is still your CPU/GPU doing the work) as about abuse.

### 11.6 Prompt injection (specific to RAG apps)
Retrieved document text — and, once you support user-uploaded books, *arbitrary text someone else chose* — ends up inside the prompt sent to the model. Treat it as **untrusted data, not instructions**:
- Keep the existing pattern of clearly delimiting sections in the prompt (`HIGHLIGHTED TEXT:`, `RELATED PASSAGES:`) and instructing the model that its job is to *answer about* that text, not *obey* anything inside it.
- Since BookMind's model output only ever becomes displayed text (no tool use, no code execution, no ability to act on the model's behalf), the blast radius of a successful injection is low — worst case, an odd or off-topic note, not data loss. Keep it that way: don't wire the model's output to trigger any action (deleting notes, hitting external URLs, etc.) without a human confirming.
- The **rendering** side matters more here than usual: `renderMD()` already HTML-escapes model output *before* applying markdown formatting, so even a maliciously crafted PDF or model response can't inject a `<script>` tag into the notebook — keep that escape-before-format order if you touch that function.

### 11.7 Secrets management
- `.env` file for `OLLAMA_MODEL`, the Basic Auth password, any future API keys — loaded via `python-dotenv`/`pydantic-settings`, **added to `.gitignore`**, never committed.
- If you accidentally commit a secret, rotate it — deleting the commit doesn't remove it from git history.

### 11.8 Dependency & container security
- `pip-audit` (free) or GitHub's built-in **Dependabot alerts** (free on both public and private repos) — flags known vulnerabilities in `requirements.txt` automatically.
- Pin versions (already done); update deliberately, not automatically, so a bad upstream release doesn't break a hosted instance unattended.
- If containerized (§10.8): use an official slim base image (`python:3.12-slim`), run as a non-root user in the Dockerfile, and rebuild periodically to pick up base-image security patches.

### 11.9 Data protection & backups
- `data/notebook.db` and `data/chunks.json` should be in `.gitignore` — your research notes and any books you add shouldn't end up in a public (or even private-but-shared) GitHub repo by accident.
- Back up `data/notebook.db` on a schedule (a cron job copying it to a synced folder, per §6 — free) since a hosted server can fail in ways your laptop doesn't.
- If the notes could ever contain sensitive material and the host isn't fully trusted (e.g. a shared VPS), consider `SQLCipher` (free, open source) for encryption at rest — likely unnecessary for a personal reading tool, worth knowing about if that changes.

### 11.10 Quick checklist before you actually expose this to the internet
- [ ] Auth in front of every route (§11.1)
- [ ] HTTPS via reverse proxy, Ollama/Uvicorn not directly internet-facing (§11.2, §11.3)
- [ ] CORS restricted to your real domain (§11.4)
- [ ] Length limits + rate limiting on `/api/generate` (§11.5)
- [ ] `.env`/secrets in `.gitignore`, not in the repo (§11.7)
- [ ] `data/` in `.gitignore` (§11.9)
- [ ] Dependabot or `pip-audit` enabled (§11.8)
- [ ] A backup of `data/notebook.db` exists somewhere other than the host itself (§11.9)

None of this costs money — it's entirely free, open-source tooling and about a day's worth of setup — but it's the difference between "runs on my machine" and "safe to put a URL on."
