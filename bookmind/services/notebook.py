# SPDX-License-Identifier: AGPL-3.0-or-later
"""Notebook service — owns notes (the CQRS write model) and publishes every change as an event.

Transactional outbox
  A note change and its event row are written in ONE SQLite transaction. A relay task then
  publishes outbox rows to the event bus and marks them sent. If the process dies between the
  commit and the publish, the row is still there and is published on restart — no dual-write
  bug where the DB says "saved" but downstream services never hear about it. (Debezium-style CDC
  tails the DB log to the same effect; an outbox table is the portable version for SQLite.)

Offline sync semantics
  Clients (the PWA) edit notes offline and replay changes later, so writes are idempotent upserts
  keyed by the client-generated note id, resolved last-writer-wins on `updated_at`. Deletes leave
  a tombstone, so a stale upsert from another device can't resurrect a deleted note.
"""
from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
import time
import uuid
from contextlib import asynccontextmanager, contextmanager
from typing import Literal

from fastapi import HTTPException, Path, Query
from pydantic import BaseModel, Field

from bookmind.common.config import get_settings
from bookmind.common.events import get_bus
from bookmind.common.service import create_service
from bookmind.common.telemetry import NOTES_WRITES, log

logger = logging.getLogger("bookmind.notebook")
TOPIC = "notebook.notes"
NOTE_ID = r"^[A-Za-z0-9_\-]{1,64}$"

SCHEMA = """
CREATE TABLE IF NOT EXISTS notes(
    id TEXT PRIMARY KEY, doc TEXT, page INTEGER, mode TEXT, selection TEXT, answer TEXT, ts INTEGER
);
CREATE TABLE IF NOT EXISTS tombstones(id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS outbox(
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT UNIQUE NOT NULL,
    topic TEXT NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at REAL NOT NULL,
    published_at REAL,
    attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS outbox_unpublished ON outbox(published_at, seq);
"""
# Columns added in v2. The v1 app created `notes` with only the first seven; migrate in place so
# an existing data/notebook.db keeps working.
V2_COLUMNS = {
    "doc_short": "TEXT",
    "status": "TEXT DEFAULT 'done'",
    "model": "TEXT",
    "source": "TEXT",
    "related": "TEXT DEFAULT '[]'",
    "created_at": "INTEGER",
    "updated_at": "INTEGER",
}
FIELDS = ["id", "doc", "doc_short", "page", "mode", "selection", "answer", "status", "model", "source", "related", "created_at", "updated_at"]


@contextmanager
def db():
    path = get_settings().db_path
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    try:
        yield conn
    finally:
        conn.close()


def migrate() -> None:
    with db() as conn:
        conn.executescript(SCHEMA)
        existing = {r["name"] for r in conn.execute("PRAGMA table_info(notes)")}
        for col, decl in V2_COLUMNS.items():
            if col not in existing:
                conn.execute(f"ALTER TABLE notes ADD COLUMN {col} {decl}")  # noqa: S608 — constant names
        conn.execute(
            "UPDATE notes SET created_at = COALESCE(created_at, ts * 1000), updated_at = COALESCE(updated_at, ts * 1000), "
            "doc_short = COALESCE(doc_short, doc), status = COALESCE(status, 'done') WHERE updated_at IS NULL"
        )
        conn.commit()


def row_to_note(row: sqlite3.Row) -> dict:
    note = {k: row[k] for k in FIELDS}
    try:
        note["related"] = json.loads(note["related"] or "[]")
    except ValueError:
        note["related"] = []
    return note


def _enqueue(conn: sqlite3.Connection, type_: str, payload: dict) -> None:
    conn.execute(
        "INSERT INTO outbox(event_id, topic, type, payload, created_at) VALUES (?,?,?,?,?)",
        (uuid.uuid4().hex, TOPIC, type_, json.dumps(payload), time.time()),
    )


class RelatedRef(BaseModel):
    id: str | None = Field(None, max_length=64)
    docShort: str = Field(..., max_length=40)
    page: int


class NoteIn(BaseModel):
    doc: str = Field(..., max_length=40)
    doc_short: str | None = Field(None, max_length=40)
    page: int = Field(..., ge=0, le=100_000)
    mode: Literal["research", "simplify"]
    selection: str = Field(..., max_length=5000)
    answer: str = Field("", max_length=50_000)
    status: Literal["pending", "done", "error"] = "done"
    model: str | None = Field(None, max_length=100)
    source: str | None = Field(None, max_length=40)
    related: list[RelatedRef] = Field(default_factory=list, max_length=20)
    created_at: int | None = None
    updated_at: int | None = None


def upsert_note(note_id: str, note: NoteIn) -> dict:
    now = int(time.time() * 1000)
    updated_at = note.updated_at or now
    with db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        tomb = conn.execute("SELECT updated_at FROM tombstones WHERE id=?", (note_id,)).fetchone()
        if tomb and tomb["updated_at"] >= updated_at:
            conn.rollback()
            NOTES_WRITES.labels("upsert", "stale_deleted").inc()
            return {"applied": False, "deleted": True, "note": None}
        current = conn.execute("SELECT * FROM notes WHERE id=?", (note_id,)).fetchone()
        if current and (current["updated_at"] or 0) > updated_at:
            conn.rollback()
            NOTES_WRITES.labels("upsert", "stale").inc()
            return {"applied": False, "deleted": False, "note": row_to_note(current)}
        record = {
            "id": note_id,
            "doc": note.doc,
            "doc_short": note.doc_short or note.doc,
            "page": note.page,
            "mode": note.mode,
            "selection": note.selection,
            "answer": note.answer,
            "status": note.status,
            "model": note.model,
            "source": note.source,
            "related": json.dumps([r.model_dump() for r in note.related]),
            "created_at": (current["created_at"] if current else None) or note.created_at or now,
            "updated_at": updated_at,
        }
        conn.execute(
            f"INSERT OR REPLACE INTO notes({','.join(FIELDS)}, ts) VALUES ({','.join('?' * len(FIELDS))}, ?)",  # noqa: S608
            [record[f] for f in FIELDS] + [updated_at // 1000],
        )
        if tomb:
            conn.execute("DELETE FROM tombstones WHERE id=?", (note_id,))
        payload = {**record, "related": json.loads(record["related"])}
        _enqueue(conn, "note.upserted", payload)
        conn.commit()  # note + event commit atomically
    NOTES_WRITES.labels("upsert", "applied").inc()
    return {"applied": True, "deleted": False, "note": payload}


def delete_note(note_id: str, updated_at: int | None) -> dict:
    ts = updated_at or int(time.time() * 1000)
    with db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        current = conn.execute("SELECT updated_at FROM notes WHERE id=?", (note_id,)).fetchone()
        if current and (current["updated_at"] or 0) > ts:
            conn.rollback()
            NOTES_WRITES.labels("delete", "stale").inc()
            return {"applied": False}
        conn.execute("DELETE FROM notes WHERE id=?", (note_id,))
        conn.execute(
            "INSERT INTO tombstones(id, updated_at) VALUES (?,?) "
            "ON CONFLICT(id) DO UPDATE SET updated_at=MAX(updated_at, excluded.updated_at)",
            (note_id, ts),
        )
        _enqueue(conn, "note.deleted", {"id": note_id, "updated_at": ts})
        conn.commit()
    NOTES_WRITES.labels("delete", "applied").inc()
    return {"applied": True}


# ------------------------------------------------------------------ outbox relay

def _claim_batch(limit: int = 100) -> list[sqlite3.Row]:
    with db() as conn:
        return conn.execute(
            "SELECT seq, event_id, topic, type, payload FROM outbox WHERE published_at IS NULL ORDER BY seq LIMIT ?",
            (limit,),
        ).fetchall()


def _mark(seqs: list[int], failed: list[int]) -> None:
    now = time.time()
    with db() as conn:
        if seqs:
            conn.executemany("UPDATE outbox SET published_at=? WHERE seq=?", [(now, s) for s in seqs])
        if failed:
            conn.executemany("UPDATE outbox SET attempts=attempts+1 WHERE seq=?", [(s,) for s in failed])
        conn.execute("DELETE FROM outbox WHERE published_at IS NOT NULL AND published_at < ?", (now - 7 * 86400,))
        conn.commit()


async def relay_once() -> int:
    rows = await asyncio.to_thread(_claim_batch)
    sent, failed = [], []
    bus = get_bus()
    for row in rows:
        try:
            # event_id comes from the outbox row, so a re-publish after a crash carries the same
            # id and consumers dedupe it.
            await bus.publish(row["topic"], row["type"], json.loads(row["payload"]), event_id=row["event_id"])
            sent.append(row["seq"])
        except Exception as exc:  # noqa: BLE001 — broker down: keep the row, retry next tick
            failed.append(row["seq"])
            log(logger, logging.WARNING, "outbox_publish_failed", seq=row["seq"], error=repr(exc))
            break  # preserve ordering: don't publish later events before an earlier one
    if sent or failed:
        await asyncio.to_thread(_mark, sent, failed)
    return len(sent)


async def relay_forever(interval_s: float = 0.5) -> None:
    while True:
        try:
            await relay_once()
        except Exception as exc:  # noqa: BLE001
            log(logger, logging.ERROR, "outbox_relay_error", error=repr(exc))
        await asyncio.sleep(interval_s)


def outbox_backlog() -> int:
    with db() as conn:
        return conn.execute("SELECT COUNT(*) FROM outbox WHERE published_at IS NULL").fetchone()[0]


@asynccontextmanager
async def lifespan(_app):
    await asyncio.to_thread(migrate)
    await get_bus().start()
    task = asyncio.create_task(relay_forever())
    yield
    task.cancel()
    await get_bus().stop()


app = create_service("notebook", lifespan=lifespan)


def _ping_db() -> bool:
    with db() as conn:
        return conn.execute("SELECT 1 FROM outbox LIMIT 1").fetchall() is not None


async def _db_ready() -> bool:
    return await asyncio.to_thread(_ping_db)


app.state.readiness["database"] = _db_ready


@app.get("/v1/notes")
def list_notes(include_deleted: bool = False, limit: int = Query(500, ge=1, le=5000)):
    with db() as conn:
        rows = conn.execute("SELECT * FROM notes ORDER BY updated_at DESC LIMIT ?", (limit,)).fetchall()
        out: dict = {"notes": [row_to_note(r) for r in rows]}
        if include_deleted:
            out["tombstones"] = [dict(r) for r in conn.execute("SELECT id, updated_at FROM tombstones")]
    return out


@app.get("/v1/notes/{note_id}")
def get_note(note_id: str = Path(..., pattern=NOTE_ID)):
    with db() as conn:
        row = conn.execute("SELECT * FROM notes WHERE id=?", (note_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "No such note")
    return row_to_note(row)


@app.put("/v1/notes/{note_id}")
def put_note(note: NoteIn, note_id: str = Path(..., pattern=NOTE_ID)):
    return upsert_note(note_id, note)


@app.delete("/v1/notes/{note_id}")
def remove_note(note_id: str = Path(..., pattern=NOTE_ID), updated_at: int | None = None):
    return delete_note(note_id, updated_at)


@app.get("/v1/outbox")
def outbox_status():
    return {"backlog": outbox_backlog()}
