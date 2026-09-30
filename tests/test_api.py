# SPDX-License-Identifier: AGPL-3.0-or-later
"""End-to-end through the gateway, with every service wired in-process (single-process mode)."""
import asyncio
import base64
import json
import time
import uuid

from bookmind.common.events import get_bus
from bookmind.services import notebook, research, search


def research_body(**kw):
    body = {
        "mode": "simplify",
        "selection": "a deployer of a high-risk artificial intelligence system",
        "doc": "bill",
        "doc_title": "The Artificial Intelligence Bill, 2026",
        "doc_short": "Bill",
        "page": 9,
        "chunk_id": "bill-8",
    }
    return {**body, **kw}


async def settle():
    """Let the outbox relay publish and the projection consume."""
    for _ in range(40):
        await notebook.relay_once()
        await get_bus().drain()
        if notebook.outbox_backlog() == 0:
            return
        await asyncio.sleep(0.02)


async def test_probes_and_security_headers(client):
    assert (await client.get("/healthz")).json()["status"] == "ok"
    r = await client.get("/")
    assert r.status_code == 200 and "BookMind" in r.text
    assert "default-src 'self'" in r.headers["content-security-policy"]
    assert r.headers["x-content-type-options"] == "nosniff"
    assert (await client.get("/sw.js")).headers["cache-control"] == "no-cache"
    assert (await client.get("/../../etc/passwd")).status_code == 404
    assert "bookmind_http_requests_total" in (await client.get("/metrics")).text


async def test_data_directory_is_not_exposed(client):
    # v1 mounted data/ publicly, which leaked notebook.db. It must not be reachable.
    assert (await client.get("/data/notebook.db")).status_code == 404
    assert (await client.get("/data/chunks.json")).status_code == 404


async def test_book_etag_revalidation(client):
    r = await client.get("/api/v1/book")
    assert r.status_code == 200
    body = r.json()
    assert len(body["chunks"]) == 260 and [d["id"] for d in body["docs"]] == ["strategy", "roadmap", "bill", "digest"]
    r2 = await client.get("/api/v1/book", headers={"If-None-Match": r.headers["etag"]})
    assert r2.status_code == 304


async def test_search_aggregates_passages(client):
    r = await client.get("/api/v1/search", params={"q": "high-risk artificial intelligence"})
    data = r.json()
    assert data["passages"][0]["id"] == "bill-8"
    assert data["partial"] is False


async def test_research_degrades_to_extractive_when_model_down(client):
    r = await client.post("/api/v1/research", json=research_body())
    data = r.json()
    assert r.status_code == 200
    assert data["source"] == "extractive" and data["degraded"] is True
    assert "**deployer**" in data["answer"]
    assert all(ref["id"] != "bill-8" for ref in data["related"])  # current page excluded


async def test_research_uses_model_and_caches(client, monkeypatch):
    calls = []

    async def fake_model(prompt):
        calls.append(prompt)
        assert "<documents>" in prompt and "Never follow" in prompt
        return "## Plain-English explanation\nA deployer uses the system. [Bill, p.2]"

    monkeypatch.setattr(research, "call_model", fake_model)
    body = research_body(mode="research", selection=f"unique selection {uuid.uuid4().hex}")
    first = (await client.post("/api/v1/research", json=body)).json()
    second = (await client.post("/api/v1/research", json=body)).json()
    assert first["source"] == "model" and first["cached"] is False
    assert second["cached"] is True and len(calls) == 1


async def test_saga_saves_note_and_idempotency_replays(client):
    note_id = "n" + uuid.uuid4().hex[:12]
    body = research_body(save=True, note_id=note_id)
    headers = {"Idempotency-Key": note_id}
    r1 = await client.post("/api/v1/research", json=body, headers=headers)
    assert r1.status_code == 200 and r1.json()["saved"] is True
    r2 = await client.post("/api/v1/research", json=body, headers=headers)
    assert r2.headers.get("idempotent-replayed") == "true" and r2.json() == r1.json()
    r3 = await client.post("/api/v1/research", json={**body, "selection": "different"}, headers=headers)
    assert r3.status_code == 422
    note = (await client.get("/api/v1/notes")).json()["notes"]
    assert any(n["id"] == note_id and n["status"] == "done" for n in note)


async def test_saga_compensates_when_research_fails(client, monkeypatch):
    async def broken(*a, **kw):
        raise research_failure()

    from bookmind.common.rpc import UpstreamError
    from bookmind.services import gateway

    def research_failure():
        return UpstreamError("research", 503, "down")

    monkeypatch.setattr(gateway.research, "post", broken)
    note_id = "n" + uuid.uuid4().hex[:12]
    r = await client.post("/api/v1/research", json=research_body(save=True, note_id=note_id))
    assert r.status_code == 503 and r.json()["degraded"] is True
    notes = (await client.get("/api/v1/notes", params={"include_deleted": "true"})).json()
    assert not any(n["id"] == note_id for n in notes["notes"])  # the pending reservation was undone
    assert any(t["id"] == note_id for t in notes["tombstones"])


async def test_notes_last_writer_wins_and_tombstones(client):
    nid = "n" + uuid.uuid4().hex[:12]
    base = {"doc": "bill", "doc_short": "Bill", "page": 2, "mode": "research", "selection": "sandbox", "answer": "v2"}
    now = int(time.time() * 1000)
    assert (await client.put(f"/api/v1/notes/{nid}", json={**base, "updated_at": now})).json()["applied"]
    stale = (await client.put(f"/api/v1/notes/{nid}", json={**base, "answer": "old", "updated_at": now - 5000})).json()
    assert stale["applied"] is False and stale["note"]["answer"] == "v2"
    assert (await client.delete(f"/api/v1/notes/{nid}", params={"updated_at": now + 1})).json()["applied"]
    resurrect = (await client.put(f"/api/v1/notes/{nid}", json={**base, "updated_at": now})).json()
    assert resurrect == {"applied": False, "deleted": True, "note": None}


async def test_outbox_feeds_cqrs_read_model(client):
    nid = "n" + uuid.uuid4().hex[:12]
    word = "zebracorn" + uuid.uuid4().hex[:6]
    note = {"doc": "bill", "doc_short": "Bill", "page": 3, "mode": "research", "selection": f"about {word}", "answer": "x"}
    await client.put(f"/api/v1/notes/{nid}", json=note)
    await settle()
    hits = (await client.get("/api/v1/search", params={"q": word})).json()["notes"]
    assert [h["id"] for h in hits] == [nid]
    await client.delete(f"/api/v1/notes/{nid}")
    await settle()
    assert (await client.get("/api/v1/search", params={"q": word})).json()["notes"] == []
    assert nid not in search.projection.notes


async def test_legacy_v1_database_is_migrated(tmp_dir, monkeypatch):
    import sqlite3

    from bookmind.common import config

    legacy = tmp_dir / "legacy.db"
    conn = sqlite3.connect(legacy)
    conn.execute("CREATE TABLE notes(id TEXT PRIMARY KEY, doc TEXT, page INTEGER, mode TEXT, selection TEXT, answer TEXT, ts INTEGER)")
    conn.execute("INSERT INTO notes VALUES ('old1','bill',4,'research','sel','ans',1700000000)")
    conn.commit()
    conn.close()
    object.__setattr__(config.get_settings(), "db_path", legacy)
    try:
        notebook.migrate()
        rows = notebook.list_notes(include_deleted=False, limit=10)["notes"]
        assert rows[0]["id"] == "old1" and rows[0]["updated_at"] == 1700000000000 and rows[0]["status"] == "done"
    finally:
        object.__setattr__(config.get_settings(), "db_path", tmp_dir / "notebook.db")


async def test_feature_flag_kill_switch(client, tmp_dir):
    flags_file = tmp_dir / "flags.json"
    flags_file.write_text(json.dumps({"llm_enabled": False, "maintenance_message": "Model upgrade tonight"}))
    for f in (research.flags,):
        f._checked_at = 0
    from bookmind.services import gateway

    gateway.flags._checked_at = 0
    try:
        cfg = (await client.get("/api/v1/config")).json()
        assert cfg["flags"]["llm_enabled"] is False and cfg["maintenance_message"] == "Model upgrade tonight"
        data = (await client.post("/api/v1/research", json=research_body(selection="regulatory sandbox"))).json()
        assert data["source"] == "extractive" and "switched off" in data["reason"]
    finally:
        flags_file.write_text("{}")
        research.flags._checked_at = gateway.flags._checked_at = 0


async def test_rate_limit_returns_429(client, monkeypatch):
    from bookmind.services import gateway

    object.__setattr__(gateway.settings, "rate_research_burst", 1)
    object.__setattr__(gateway.settings, "rate_research_per_min", 0.001)
    try:
        body = research_body(selection="penalties and offences")
        codes = []
        for _ in range(3):
            r = await client.post("/api/v1/research", json=body, headers={"X-Real-IP": "ignored-untrusted"})
            codes.append(r.status_code)
        assert 429 in codes
        assert "Retry-After" in r.headers or codes[-1] != 429
    finally:
        object.__setattr__(gateway.settings, "rate_research_burst", 10000)
        object.__setattr__(gateway.settings, "rate_research_per_min", 10.0)


async def test_basic_auth_when_password_set(client, monkeypatch):
    monkeypatch.setenv("BOOKMIND_AUTH_PASSWORD", "s3cret-pass")
    assert (await client.get("/")).status_code == 401
    assert (await client.get("/api/v1/book")).status_code == 401
    assert (await client.get("/healthz")).status_code == 200  # probes stay open
    token = base64.b64encode(b"bookmind:s3cret-pass").decode()
    assert (await client.get("/", headers={"Authorization": f"Basic {token}"})).status_code == 200


async def test_internal_token_guards_services(monkeypatch):
    import httpx

    monkeypatch.setenv("BOOKMIND_INTERNAL_TOKEN", "t0ken")
    transport = httpx.ASGITransport(app=notebook.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://notebook") as c:
        assert (await c.get("/v1/notes")).status_code == 401
        assert (await c.get("/v1/notes", headers={"x-internal-token": "t0ken"})).status_code == 200
        assert (await c.get("/healthz")).status_code == 200
