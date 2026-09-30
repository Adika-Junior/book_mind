# SPDX-License-Identifier: AGPL-3.0-or-later
"""Search service — the query side of CQRS.

* Passage index: hybrid retrieval over every page, built from the catalog service's data at startup —
  BM25 (exact words) fused with embedding similarity (meaning; bookmind/common/embed.py). Pages are
  embedded as overlapping ~60-word windows and a page scores by its best window, so one relevant
  paragraph isn't diluted by the rest of the page. Scores are fused as a weighted sum of
  max-normalised BM25 and min-max-normalised similarity (BOOKMIND_SEMANTIC_WEIGHT, default 0.7) — on
  our evaluation this kept every exact-term query in the top 3 while doubling top-3 hits for
  paraphrased questions (tests/test_semantic.py). Without an embedder it is plain BM25.
* Notes read model: a denormalised, search-optimised projection of the notebook, maintained by
  consuming `notebook.notes` events. The notebook service (write side) never gets query load.

The projection is eventually consistent and rebuildable: on startup it bootstraps from a
notebook snapshot, then applies events. Every update carries `updated_at`, and older updates
are ignored, so replays, duplicates and out-of-order delivery all converge to the same state.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import socket
import time
from contextlib import asynccontextmanager
from typing import Literal

import numpy as np
from fastapi import Query, Request, Response
from rank_bm25 import BM25Okapi

from bookmind.common.config import get_settings
from bookmind.common.embed import load_embedder
from bookmind.common.events import Event, get_bus
from bookmind.common.rpc import ServiceClient
from bookmind.common.service import create_service
from bookmind.common.telemetry import log
from bookmind.common.text import best_sentences, excerpt, tokenize

logger = logging.getLogger("bookmind.search")

catalog = ServiceClient("catalog", timeout_s=10)
notebook = ServiceClient("notebook", timeout_s=5)


def windows(text: str, size: int = 60, stride: int = 30) -> list[str]:
    """Overlapping word windows — roughly a paragraph each."""
    words = text.split()
    if len(words) <= size:
        return [" ".join(words)] if words else []
    return [" ".join(words[i : i + size]) for i in range(0, len(words) - size + stride, stride)]


class SemanticIndex:
    """Embedding vectors for every window of every page."""

    RETRY_S = 60

    def __init__(self, embedder):
        self.embedder = embedder
        self.vectors: np.ndarray | None = None
        self.owners: np.ndarray | None = None
        self.texts: list[str] = []
        self.pack: bytes | None = None
        self.version: str | None = None
        self._failed_at = 0.0
        self._lock = asyncio.Lock()

    @property
    def ready(self) -> bool:
        return self.vectors is not None

    async def _embed(self, texts: list[str]) -> np.ndarray:
        if hasattr(self.embedder, "aembed"):
            return await self.embedder.aembed(texts)
        return await asyncio.to_thread(self.embedder.embed, texts)

    async def build(self, chunks: list[dict], version: str | None) -> None:
        if self.embedder is None or (self.ready and self.version == version):
            return
        if time.monotonic() - self._failed_at < self.RETRY_S:
            return
        async with self._lock:
            if self.ready and self.version == version:
                return
            texts, owners = [], []
            for i, c in enumerate(chunks):
                for w in windows(c["text"]):
                    texts.append(w)
                    owners.append(i)
            started = time.monotonic()
            try:
                vectors = await self._embed(texts)
            except Exception as exc:  # noqa: BLE001 — model server down: keyword search still works
                self._failed_at = time.monotonic()
                log(logger, logging.WARNING, "semantic_index_unavailable", embedder=self.embedder.kind, error=repr(exc))
                return
            self.texts, self.owners, self.vectors, self.version = texts, np.asarray(owners), vectors, version
            self.pack = None
            if hasattr(self.embedder, "browser_pack"):
                pack = await asyncio.to_thread(
                    self.embedder.browser_pack, vectors, owners, [c["id"] for c in chunks], version or ""
                )
                self.pack = json.dumps(pack, separators=(",", ":")).encode()
            log(logger, logging.INFO, "semantic_index_built", embedder=self.embedder.kind, model=self.embedder.name,
                windows=len(texts), seconds=round(time.monotonic() - started, 2))

    def meaningful(self, q: str, vocabulary: set[str]) -> bool:
        """At least half the query's words are real words (known to the corpus or word-like to the
        model). Otherwise don't search by meaning — keyword results only."""
        words = re.findall(r"[a-z]{3,}", q.lower().replace("'s", ""))
        if not words or not hasattr(self.embedder, "wordlike"):
            return bool(words) or not hasattr(self.embedder, "wordlike")
        known = sum(1 for w in words if w in vocabulary or self.embedder.wordlike(w))
        return 2 * known >= len(words)

    async def query_vector(self, q: str, vocabulary: set[str] = frozenset()) -> np.ndarray | None:
        if not self.ready or not self.meaningful(q, vocabulary):
            return None
        try:
            return (await self._embed([q]))[0]
        except Exception as exc:  # noqa: BLE001
            log(logger, logging.WARNING, "semantic_query_failed", error=repr(exc))
            return None

    def page_scores(self, qvec: np.ndarray, n_pages: int) -> tuple[np.ndarray, np.ndarray]:
        """Best window similarity per page, and which window it was."""
        sims = self.vectors @ qvec
        best = np.full(n_pages, -1.0)
        np.maximum.at(best, self.owners, sims)
        best_window = np.full(n_pages, -1)
        for w in np.argsort(sims):  # ascending: the last write per page is its best window
            best_window[self.owners[w]] = w
        return best, best_window


# Tables of contents mention every heading, so they match almost any query — by words and by
# meaning — while being the least useful page to land on. They rank below the pages they point to.
NAV_PAGE = re.compile(r"ARRANGEMENT OF (CLAUSES|SECTIONS)|TABLE OF CONTENTS|^\s*Contents\b", re.I)
NAV_PRIOR = 0.8


class PassageIndex:
    def __init__(self, semantic: SemanticIndex | None = None):
        self.chunks: list[dict] = []
        self.bm25: BM25Okapi | None = None
        self.version: str | None = None
        self.semantic = semantic
        self.vocabulary: set[str] = set()
        self.prior: np.ndarray | None = None
        self._lock = asyncio.Lock()

    @property
    def ready(self) -> bool:
        return self.bm25 is not None

    def load(self, payload: dict) -> None:
        chunks = payload["chunks"]
        docs = [tokenize(c["text"]) or ["_"] for c in chunks]
        self.bm25 = BM25Okapi(docs)
        self.vocabulary = {w for d in docs for w in d}
        self.prior = np.array([NAV_PRIOR if NAV_PAGE.search(" ".join(c["text"].split())[:300]) else 1.0 for c in chunks])
        self.chunks = chunks
        self.version = payload.get("version")

    async def ensure(self) -> None:
        if self.ready:
            return
        async with self._lock:
            if not self.ready:
                self.load(await catalog.get("/v1/book"))
                log(logger, logging.INFO, "passage_index_built", chunks=len(self.chunks), version=self.version)

    # A page with no shared words is only returned on meaning if it is close to the best match and
    # similar enough in absolute terms (the embedder's calibrated floor), so an off-topic query
    # returns nothing rather than noise.
    RELATIVE_SIMILARITY = 0.8

    def query(
        self,
        q: str,
        k: int = 5,
        exclude: str | None = None,
        doc: str | None = None,
        full: bool = False,
        qvec: np.ndarray | None = None,
        mode: str = "hybrid",
    ) -> list[dict]:
        tokens = tokenize(q)
        if self.bm25 is None or (not tokens and qvec is None):
            return []
        n = len(self.chunks)
        bm = self.bm25.get_scores(tokens) if tokens and mode != "semantic" else np.zeros(n)
        sem = best_window = None
        if qvec is not None and mode != "keyword" and self.semantic and self.semantic.ready:
            sem, best_window = self.semantic.page_scores(qvec, n)
        if sem is None:
            combined, eligible = bm, bm > 0
        else:
            w = 1.0 if mode == "semantic" else get_settings().semantic_weight
            bn = bm / bm.max() if bm.max() > 0 else bm
            sn = (sem - sem.min()) / (sem.max() - sem.min() + 1e-9)
            combined = w * sn + (1 - w) * bn
            top = float(sem.max())
            floor = getattr(self.semantic.embedder, "min_similarity", 0.2)
            eligible = (bm > 0) | ((sem >= floor) & (sem >= self.RELATIVE_SIMILARITY * top))
        combined = combined * self.prior
        ranked = np.argsort(-combined, kind="stable")
        out = []
        for i in ranked:
            i = int(i)
            if not eligible[i]:
                continue
            c = self.chunks[i]
            if (exclude and c["id"] == exclude) or (doc and c["doc"] != doc):
                continue
            words = " ".join(best_sentences(q, c["text"], 2))
            if not words and best_window is not None and best_window[i] >= 0:
                words = self.semantic.texts[best_window[i]]  # the paragraph that matched in meaning
            hit = {
                "id": c["id"],
                "doc": c["doc"],
                "docShort": c["docShort"],
                "docTitle": c["docTitle"],
                "page": c["page"],
                "score": round(float(combined[i]), 3),
                "match": "meaning" if bm[i] <= 0 else ("words" if sem is None else "both"),
                "snippet": excerpt(words or c["text"], 320),
            }
            if full:
                hit["text"] = c["text"]
            out.append(hit)
            if len(out) >= k:
                break
        return out


class NotesProjection:
    def __init__(self):
        self.notes: dict[str, dict] = {}
        self.versions: dict[str, int] = {}  # includes tombstones, so late upserts can't resurrect

    def apply(self, kind: str, note: dict) -> None:
        nid, version = note["id"], int(note.get("updated_at") or 0)
        if version < self.versions.get(nid, -1):
            return
        self.versions[nid] = version
        if kind == "deleted":
            self.notes.pop(nid, None)
        else:
            text = f"{note.get('selection', '')} {note.get('answer', '')} {note.get('comment', '')} {note.get('session', '')}"
            self.notes[nid] = {**note, "_tokens": tokenize(text)}

    def query(self, q: str, k: int = 10) -> list[dict]:
        qt = set(tokenize(q))
        if not qt:
            return []
        scored = []
        for n in self.notes.values():
            toks = n["_tokens"]
            score = sum(toks.count(t) for t in qt) / (1 + len(toks) ** 0.5)
            if score > 0:
                scored.append((score, n))
        scored.sort(key=lambda s: s[0], reverse=True)
        return [
            {
                "id": n["id"],
                "doc": n["doc"],
                "docShort": n.get("doc_short") or n["doc"],
                "page": n["page"],
                "mode": n["mode"],
                "selection": excerpt(n.get("selection", ""), 200),
                "comment": excerpt(n.get("comment") or "", 160),
                "session": n.get("session") or "",
                "score": round(s, 3),
            }
            for s, n in scored[:k]
        ]


embedder = load_embedder()
semantic = SemanticIndex(embedder)
index = PassageIndex(semantic)
projection = NotesProjection()


async def on_notes_event(event: Event) -> None:
    projection.apply("deleted" if event.type == "note.deleted" else "upserted", event.data)


# Each replica keeps its own in-memory projection, so each needs its own consumer group
# (fan-out), not a shared one (which would load-balance events across replicas).
get_bus().subscribe("notebook.notes", f"search-projection-{socket.gethostname()}", on_notes_event)


async def _bootstrap() -> None:
    for attempt in range(30):
        try:
            await index.ensure()
            await semantic.build(index.chunks, index.version)
            break
        except Exception as exc:  # noqa: BLE001 — catalog may still be starting
            log(logger, logging.WARNING, "passage_index_retry", attempt=attempt, error=repr(exc))
            await asyncio.sleep(min(10, 0.5 * 2**attempt))
    try:
        snapshot = await notebook.get("/v1/notes", params={"include_deleted": "true"})
        for n in snapshot.get("notes", []):
            projection.apply("upserted", n)
        for t in snapshot.get("tombstones", []):
            projection.apply("deleted", t)
    except Exception as exc:  # noqa: BLE001 — events will fill the projection in eventually
        log(logger, logging.WARNING, "notes_snapshot_unavailable", error=repr(exc))


@asynccontextmanager
async def lifespan(_app):
    task = asyncio.create_task(_bootstrap())
    await get_bus().start()
    yield
    task.cancel()
    await get_bus().stop()


app = create_service("search", lifespan=lifespan)


async def _index_ready() -> bool:
    return index.ready


app.state.readiness["passage_index"] = _index_ready


@app.get("/v1/passages")
async def passages(
    q: str = Query(..., min_length=1, max_length=2000),
    k: int = Query(5, ge=1, le=25),
    exclude: str | None = None,
    doc: str | None = None,
    full: bool = False,
    mode: Literal["hybrid", "keyword", "semantic"] = "hybrid",
):
    await index.ensure()
    if embedder is not None and not semantic.ready:
        await semantic.build(index.chunks, index.version)  # retried at most once a minute if it failed
    qvec = await semantic.query_vector(q, index.vocabulary) if mode != "keyword" else None
    return {
        "results": index.query(q, k, exclude, doc, full, qvec=qvec, mode=mode),
        "index_version": index.version,
        "semantic": {"enabled": qvec is not None, "model": getattr(embedder, "name", None)},
    }


@app.get("/v1/semantic-pack")
async def semantic_pack(request: Request):
    """Vectors for offline meaning-search in the browser (static embedder only)."""
    await index.ensure()
    await semantic.build(index.chunks, index.version)
    if semantic.pack is None:
        return Response(status_code=404)
    etag = f'"sp-{semantic.version}-{embedder.name}"'
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag})
    return Response(semantic.pack, media_type="application/json", headers={"ETag": etag})


@app.get("/v1/notes")
async def search_notes(q: str = Query(..., min_length=1, max_length=500), k: int = Query(10, ge=1, le=50)):
    return {"results": projection.query(q, k), "projection_size": len(projection.notes)}
