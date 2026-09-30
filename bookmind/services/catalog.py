# SPDX-License-Identifier: AGPL-3.0-or-later
"""Catalog service — the single owner of book content (database-per-service).

Content is immutable per release, so it is served with a strong ETag: gateways, the CDN and the
PWA's service worker can all revalidate with `If-None-Match` and get a 304 for free.
"""
from __future__ import annotations

import hashlib
import json
from functools import lru_cache

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, Response

from bookmind.common.config import get_settings
from bookmind.common.service import create_service
from bookmind.common.text import extract_definitions

DOC_ORDER = ["strategy", "roadmap", "bill", "digest"]


@lru_cache(maxsize=1)
def book() -> dict:
    raw = get_settings().data_path.read_bytes()
    chunks = json.loads(raw)
    docs = []
    known = [d for d in DOC_ORDER if any(c["doc"] == d for c in chunks)]
    extra = sorted({c["doc"] for c in chunks} - set(known))
    for doc_id in known + extra:
        pages = [c for c in chunks if c["doc"] == doc_id]
        docs.append(
            {
                "id": doc_id,
                "title": pages[0]["docTitle"],
                "short": pages[0]["docShort"],
                "pages": len(pages),
                "words": sum(p.get("words", 0) for p in pages),
            }
        )
    etag = '"' + hashlib.sha256(raw).hexdigest()[:32] + '"'
    by_id = {c["id"]: c for c in chunks}
    return {
        "etag": etag,
        "docs": docs,
        "chunks": chunks,
        "by_id": by_id,
        "definitions": extract_definitions(chunks),
    }


app = create_service("catalog")
app.state.readiness["book_loaded"] = lambda: _ready()


async def _ready() -> bool:
    return bool(book()["chunks"])


def _cached_json(request: Request, payload: dict, etag: str) -> Response:
    headers = {"ETag": etag, "Cache-Control": "public, max-age=300, stale-while-revalidate=86400"}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    return JSONResponse(payload, headers=headers)


@app.get("/v1/book")
async def get_book(request: Request):
    b = book()
    return _cached_json(request, {"version": b["etag"].strip('"'), "docs": b["docs"], "chunks": b["chunks"]}, b["etag"])


@app.get("/v1/documents")
async def documents():
    return {"docs": book()["docs"]}


@app.get("/v1/chunks/{chunk_id}")
async def chunk(chunk_id: str):
    c = book()["by_id"].get(chunk_id)
    if c is None:
        raise HTTPException(404, "No such page")
    return c


@app.get("/v1/definitions")
async def definitions(request: Request):
    b = book()
    return _cached_json(request, {"definitions": b["definitions"]}, b["etag"])
