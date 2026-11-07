# SPDX-License-Identifier: AGPL-3.0-or-later
"""Notebook service — owns notes (the CQRS write model) and publishes every change as an event.

Transactional outbox
  A note change and its event row are written in ONE SQLite transaction. A relay task then
  publishes outbox rows to the event bus and marks them sent. If the process dies between the
  commit and the publish, the row is still there and is published on restart — no dual-write
  bug where the DB says "saved" but downstream services never hear about it. (Debezium-style CDC
  tails the DB log to the same effect; an outbox table is the portable version for SQLite.)

Ownership
  Every note belongs to one account (`owner`). The gateway authenticates the person and passes the
  username in `x-bookmind-user`; every query here is scoped to it, and note ids are unique per
  owner (primary key (owner, id)), so one person can never read, overwrite or delete another's
  notes — even by reusing an id. In single-user mode the owner is the local user.

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

from fastapi import Depends, Header, HTTPException, Path, Query
from pydantic import BaseModel, Field

from bookmind.common.config import get_settings
from bookmind.common.events import get_bus
from bookmind.common.service import create_service
from bookmind.common.telemetry import NOTES_WRITES, log

logger = logging.getLogger("bookmind.notebook")
TOPIC = "notebook.notes"
NOTE_ID = r"^[A-Za-z0-9_\-]{1,64}$"
OWNER = r"^[a-z0-9][a-z0-9._-]{1,31}$"

SCHEMA = """
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
    # v2.2 research workspace: your own words, the research session a note is filed under, a
    # highlight colour, and the exact page it anchors to.
    "comment": "TEXT DEFAULT ''",
    "session": "TEXT DEFAULT ''",
    "color": "TEXT",
    "chunk_id": "TEXT",
    "web": "TEXT DEFAULT '[]'",  # web sources consulted, with the date they were accessed
    # W3C Web Annotation style text-quote context, so the exact words can be re-found on the page.
    "anchor": "TEXT",
}
BASE_COLUMNS = "doc TEXT, page INTEGER, mode TEXT, selection TEXT, answer TEXT, ts INTEGER"
NOTES_DDL = (
    "CREATE TABLE {name}(owner TEXT NOT NULL, id TEXT NOT NULL, " + BASE_COLUMNS + ", "
    + ", ".join(f"{c} {d}" for c, d in V2_COLUMNS.items()) + ", PRIMARY KEY(owner, id))"
)
TOMBSTONES_DDL = "CREATE TABLE {name}(owner TEXT NOT NULL, id TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(owner, id))"
FIELDS = [
    "id", "doc", "doc_short", "page", "mode", "selection", "answer", "status", "model", "source", "related",
    "created_at", "updated_at", "comment", "session", "color", "chunk_id", "web", "anchor",
]
# research / simplify / ask are answered from the documents; highlight and note are the reader's own.
NoteMode = Literal["research", "simplify", "ask", "highlight", "note", "web"]


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


def _tables(conn) -> set[str]:
    return {r["name"] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}


def migrate() -> None:
    with db() as conn:
        conn.executescript(SCHEMA)
        tables = _tables(conn)
        if "notes" not in tables:
            conn.execute(NOTES_DDL.format(name="notes"))
        if "tombstones" not in tables:
            conn.execute(TOMBSTONES_DDL.format(name="tombstones"))
        existing = {r["name"] for r in conn.execute("PRAGMA table_info(notes)")}
        for col, decl in V2_COLUMNS.items():
            if col not in existing:
                conn.execute(f"ALTER TABLE notes ADD COLUMN {col} {decl}")  # noqa: S608 — constant names
        conn.execute(
            "UPDATE notes SET created_at = COALESCE(created_at, ts * 1000), updated_at = COALESCE(updated_at, ts * 1000), "
            "doc_short = COALESCE(doc_short, doc), status = COALESCE(status, 'done') WHERE updated_at IS NULL"
        )
        if "owner" not in {r["name"] for r in conn.execute("PRAGMA table_info(notes)")}:
            # v2.6: notes gain an owner. Rebuild both tables keyed by (owner, id); notes made before
            # accounts existed belong to the local user / first admin.
            owner = get_settings().local_owner
            cols = "id, " + ", ".join(c.split()[0] for c in BASE_COLUMNS.split(", ")) + ", " + ", ".join(V2_COLUMNS)
            conn.execute(NOTES_DDL.format(name="notes_v26"))
            conn.execute(f"INSERT INTO notes_v26(owner, {cols}) SELECT ?, {cols} FROM notes", (owner,))  # noqa: S608
            conn.execute(TOMBSTONES_DDL.format(name="tombstones_v26"))
            conn.execute("INSERT INTO tombstones_v26(owner, id, updated_at) SELECT ?, id, updated_at FROM tombstones", (owner,))
            conn.execute("DROP TABLE notes")
            conn.execute("DROP TABLE tombstones")
            conn.execute("ALTER TABLE notes_v26 RENAME TO notes")
            conn.execute("ALTER TABLE tombstones_v26 RENAME TO tombstones")
            log(logger, logging.INFO, "notes_assigned_owner", owner=owner)
        conn.execute("CREATE INDEX IF NOT EXISTS notes_owner_updated ON notes(owner, updated_at)")
        conn.commit()


def owner_header(x_bookmind_user: str = Header(..., pattern=OWNER)) -> str:
    """The account the gateway authenticated. Internal-only service: callers hold the internal token."""
    return x_bookmind_user


def row_to_note(row: sqlite3.Row) -> dict:
    note = {k: row[k] for k in FIELDS}
    note["owner"] = row["owner"]
    for field in ("related", "web"):
        try:
            note[field] = json.loads(note[field] or "[]")
        except ValueError:
            note[field] = []
    try:
        note["anchor"] = json.loads(note["anchor"]) if note["anchor"] else None
    except ValueError:
        note["anchor"] = None
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


class WebRef(BaseModel):
    title: str = Field(..., max_length=300)
    url: str = Field(..., max_length=2000, pattern=r"^https?://")
    domain: str = Field("", max_length=200)
    tier_label: str = Field("", max_length=80)
    accessed_at: int | None = None


class Anchor(BaseModel):
    """Text-quote selector context (https://www.w3.org/TR/annotation-model/#text-quote-selector)."""

    prefix: str = Field("", max_length=64)
    suffix: str = Field("", max_length=64)


class NoteIn(BaseModel):
    doc: str = Field(..., max_length=40)
    doc_short: str | None = Field(None, max_length=40)
    page: int = Field(..., ge=0, le=100_000)
    mode: NoteMode
    selection: str = Field(..., max_length=5000)
    answer: str = Field("", max_length=50_000)
    status: Literal["pending", "done", "error"] = "done"
    model: str | None = Field(None, max_length=100)
    source: str | None = Field(None, max_length=40)
    related: list[RelatedRef] = Field(default_factory=list, max_length=20)
    created_at: int | None = None
    updated_at: int | None = None
    comment: str = Field("", max_length=10_000)
    session: str = Field("", max_length=80)
    color: str | None = Field(None, pattern=r"^[a-z]{1,12}$")
    chunk_id: str | None = Field(None, max_length=64)
    web: list[WebRef] = Field(default_factory=list, max_length=10)
    anchor: Anchor | None = None


def upsert_note(owner: str, note_id: str, note: NoteIn) -> dict:
    now = int(time.time() * 1000)
    updated_at = note.updated_at or now
    with db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        tomb = conn.execute("SELECT updated_at FROM tombstones WHERE owner=? AND id=?", (owner, note_id)).fetchone()
        if tomb and tomb["updated_at"] >= updated_at:
            conn.rollback()
            NOTES_WRITES.labels("upsert", "stale_deleted").inc()
            return {"applied": False, "deleted": True, "note": None}
        current = conn.execute("SELECT * FROM notes WHERE owner=? AND id=?", (owner, note_id)).fetchone()
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
            "comment": note.comment,
            "session": note.session.strip(),
            "color": note.color,
            "chunk_id": note.chunk_id,
            "web": json.dumps([w.model_dump() for w in note.web]),
            "anchor": json.dumps(note.anchor.model_dump()) if note.anchor else None,
        }
        conn.execute(
            f"INSERT OR REPLACE INTO notes(owner, {','.join(FIELDS)}, ts) VALUES (?, {','.join('?' * len(FIELDS))}, ?)",  # noqa: S608
            [owner] + [record[f] for f in FIELDS] + [updated_at // 1000],
        )
        if tomb:
            conn.execute("DELETE FROM tombstones WHERE owner=? AND id=?", (owner, note_id))
        payload = {
            **record,
            "owner": owner,
            "related": json.loads(record["related"]),
            "web": json.loads(record["web"]),
            "anchor": json.loads(record["anchor"]) if record["anchor"] else None,
        }
        _enqueue(conn, "note.upserted", payload)
        conn.commit()  # note + event commit atomically
    NOTES_WRITES.labels("upsert", "applied").inc()
    return {"applied": True, "deleted": False, "note": payload}


def delete_note(owner: str, note_id: str, updated_at: int | None) -> dict:
    ts = updated_at or int(time.time() * 1000)
    with db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        current = conn.execute("SELECT updated_at FROM notes WHERE owner=? AND id=?", (owner, note_id)).fetchone()
        if current and (current["updated_at"] or 0) > ts:
            conn.rollback()
            NOTES_WRITES.labels("delete", "stale").inc()
            return {"applied": False}
        conn.execute("DELETE FROM notes WHERE owner=? AND id=?", (owner, note_id))
        conn.execute(
            "INSERT INTO tombstones(owner, id, updated_at) VALUES (?,?,?) "
            "ON CONFLICT(owner, id) DO UPDATE SET updated_at=MAX(updated_at, excluded.updated_at)",
            (owner, note_id, ts),
        )
        _enqueue(conn, "note.deleted", {"owner": owner, "id": note_id, "updated_at": ts})
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
def list_notes(
    owner: str = Depends(owner_header),
    include_deleted: bool = False,
    limit: int = Query(500, ge=1, le=5000),
    session: str | None = None,
):
    with db() as conn:
        if session is not None:
            rows = conn.execute(
                "SELECT * FROM notes WHERE owner=? AND session=? ORDER BY updated_at DESC LIMIT ?", (owner, session, limit)
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM notes WHERE owner=? ORDER BY updated_at DESC LIMIT ?", (owner, limit)).fetchall()
        out: dict = {"notes": [row_to_note(r) for r in rows]}
        out["sessions"] = [
            {"name": r["session"], "count": r["n"]}
            for r in conn.execute(
                "SELECT session, COUNT(*) AS n FROM notes WHERE owner=? AND session != '' GROUP BY session ORDER BY session", (owner,)
            )
        ]
        if include_deleted:
            out["tombstones"] = [dict(r) for r in conn.execute("SELECT id, updated_at FROM tombstones WHERE owner=?", (owner,))]
    return out


@app.get("/v1/notes/{note_id}")
def get_note(note_id: str = Path(..., pattern=NOTE_ID), owner: str = Depends(owner_header)):
    with db() as conn:
        row = conn.execute("SELECT * FROM notes WHERE owner=? AND id=?", (owner, note_id)).fetchone()
    if row is None:
        raise HTTPException(404, "No such note")
    return row_to_note(row)


@app.put("/v1/notes/{note_id}")
def put_note(note: NoteIn, note_id: str = Path(..., pattern=NOTE_ID), owner: str = Depends(owner_header)):
    return upsert_note(owner, note_id, note)


@app.delete("/v1/notes/{note_id}")
def remove_note(note_id: str = Path(..., pattern=NOTE_ID), updated_at: int | None = None, owner: str = Depends(owner_header)):
    return delete_note(owner, note_id, updated_at)


@app.get("/v1/all-notes")
def all_notes(include_deleted: bool = True):
    """Every owner's notes — only for rebuilding the search service's read model (internal token)."""
    with db() as conn:
        out: dict = {"notes": [row_to_note(r) for r in conn.execute("SELECT * FROM notes")]}
        if include_deleted:
            out["tombstones"] = [dict(r) for r in conn.execute("SELECT owner, id, updated_at FROM tombstones")]
    return out


@app.delete("/v1/owners/{owner}")
def erase_owner(owner: str = Path(..., pattern=OWNER)):
    """Delete everything an account wrote (account deletion / right to erasure, DPA 2019 s.40).
    Each note's deletion is published, so the search read model forgets it too."""
    with db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        ids = [r["id"] for r in conn.execute("SELECT id FROM notes WHERE owner=?", (owner,))]
        now = int(time.time() * 1000)
        for note_id in ids:
            _enqueue(conn, "note.deleted", {"owner": owner, "id": note_id, "updated_at": now})
        conn.execute("DELETE FROM notes WHERE owner=?", (owner,))
        conn.execute("DELETE FROM tombstones WHERE owner=?", (owner,))
        conn.commit()
    log(logger, logging.INFO, "owner_erased", owner=owner, notes=len(ids))
    return {"deleted_notes": len(ids)}


@app.get("/v1/outbox")
def outbox_status():
    return {"backlog": outbox_backlog()}
