# SPDX-License-Identifier: AGPL-3.0-or-later
"""Search service — the query side of CQRS.

* Passage index: BM25 over every page, built from the catalog service's data at startup.
* Notes read model: a denormalised, search-optimised projection of the notebook, maintained by
  consuming `notebook.notes` events. The notebook service (write side) never gets query load.

The projection is eventually consistent and rebuildable: on startup it bootstraps from a
notebook snapshot, then applies events. Every update carries `updated_at`, and older updates
are ignored, so replays, duplicates and out-of-order delivery all converge to the same state.
"""
from __future__ import annotations

import asyncio
import logging
import socket
from contextlib import asynccontextmanager

from fastapi import Query
from rank_bm25 import BM25Okapi

from bookmind.common.events import Event, get_bus
from bookmind.common.rpc import ServiceClient
from bookmind.common.service import create_service
from bookmind.common.telemetry import log
from bookmind.common.text import best_sentences, excerpt, tokenize

logger = logging.getLogger("bookmind.search")

catalog = ServiceClient("catalog", timeout_s=10)
notebook = ServiceClient("notebook", timeout_s=5)


class PassageIndex:
    def __init__(self):
        self.chunks: list[dict] = []
        self.bm25: BM25Okapi | None = None
        self.version: str | None = None
        self._lock = asyncio.Lock()

    @property
    def ready(self) -> bool:
        return self.bm25 is not None

    def load(self, payload: dict) -> None:
        chunks = payload["chunks"]
        self.bm25 = BM25Okapi([tokenize(c["text"]) or ["_"] for c in chunks])
        self.chunks = chunks
        self.version = payload.get("version")

    async def ensure(self) -> None:
        if self.ready:
            return
        async with self._lock:
            if not self.ready:
                self.load(await catalog.get("/v1/book"))
                log(logger, logging.INFO, "passage_index_built", chunks=len(self.chunks), version=self.version)

    def query(self, q: str, k: int = 5, exclude: str | None = None, doc: str | None = None, full: bool = False) -> list[dict]:
        tokens = tokenize(q)
        if not tokens or self.bm25 is None:
            return []
        scores = self.bm25.get_scores(tokens)
        ranked = sorted(range(len(self.chunks)), key=lambda i: scores[i], reverse=True)
        out = []
        for i in ranked:
            if scores[i] <= 0:
                break
            c = self.chunks[i]
            if (exclude and c["id"] == exclude) or (doc and c["doc"] != doc):
                continue
            hit = {
                "id": c["id"],
                "doc": c["doc"],
                "docShort": c["docShort"],
                "docTitle": c["docTitle"],
                "page": c["page"],
                "score": round(float(scores[i]), 3),
                "snippet": excerpt(" ".join(best_sentences(q, c["text"], 2)) or c["text"], 320),
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
            self.notes[nid] = {**note, "_tokens": tokenize(f"{note.get('selection', '')} {note.get('answer', '')}")}

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
                "score": round(s, 3),
            }
            for s, n in scored[:k]
        ]


index = PassageIndex()
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
):
    await index.ensure()
    return {"results": index.query(q, k, exclude, doc, full), "index_version": index.version}


@app.get("/v1/notes")
async def search_notes(q: str = Query(..., min_length=1, max_length=500), k: int = Query(10, ge=1, le=50)):
    return {"results": projection.query(q, k), "projection_size": len(projection.notes)}
