# SPDX-License-Identifier: AGPL-3.0-or-later
"""Accounts: sign-in, sessions, roles, first-login password change, lockout — and, above all, that
one person can never read, overwrite, search or delete another person's notes."""
import uuid

import httpx
import pytest

from bookmind.services import accounts, gateway
from tests.conftest import ADMIN_PW


@pytest.fixture
async def people(monkeypatch):
    """Turn accounts on and hand out independent browsers (each with its own cookie jar and address)."""
    monkeypatch.setenv("BOOKMIND_AUTH_MODE", "accounts")
    monkeypatch.setenv("BOOKMIND_AUTH_PASSWORD", ADMIN_PW)
    app = gateway.app
    clients = []

    def browser(ip: str) -> httpx.AsyncClient:
        transport = httpx.ASGITransport(app=app, client=(ip, 4321))
        c = httpx.AsyncClient(transport=transport, base_url="https://test", headers={"X-BookMind": "1"})
        clients.append(c)
        return c

    async with app.router.lifespan_context(app):
        yield browser
    for c in clients:
        await c.aclose()


def uid(prefix: str) -> str:
    return f"{prefix}{uuid.uuid4().hex[:8]}"


async def sign_in(c, username, password):
    return await c.post("/api/v1/auth/login", json={"username": username, "password": password})


async def new_reader(admin, password="reader-pass-phrase-1"):
    """Create an account and finish its first sign-in. Returns (username, browser-ready password)."""
    name = uid("reader")
    created = await admin.post("/api/v1/admin/users", json={"username": name, "display_name": "Amina W."})
    assert created.status_code == 201, created.text
    return name, created.json()["temporary_password"], password


# ------------------------------------------------------------------ passwords

def test_passwords_are_salted_scrypt_hashes():
    a, b = accounts.hash_password("same phrase here"), accounts.hash_password("same phrase here")
    assert a != b and a.startswith("scrypt$") and "same phrase" not in a
    assert accounts.verify_password("same phrase here", a) and not accounts.verify_password("other phrase", a)
    assert not accounts.verify_password("x", "garbage")


def test_password_rules_follow_nist():
    assert accounts.password_problem("short") is not None
    assert accounts.password_problem("password123") is not None  # well known
    assert accounts.password_problem("aaaaaaaaaaaa") is not None  # repetitive
    assert accounts.password_problem("amina-reads-the-bill", "amina") is not None  # contains username
    assert accounts.password_problem("maji ya mvua ni baraka") is None  # a phrase is fine, no symbol rules
    assert accounts.password_problem(accounts.temporary_password()) is None


# ------------------------------------------------------------------ sign-in and sessions

async def test_sign_in_session_and_sign_out(people):
    c = people("10.1.0.1")
    assert (await c.get("/api/v1/auth/session")).json() == {"mode": "accounts", "user": None, "legacy_owner": "bookmind"}
    assert (await c.get("/api/v1/book")).json()["code"] == "auth_required"
    assert (await sign_in(c, "bookmind", "wrong-password-x")).status_code == 401
    ok = await sign_in(c, "BookMind", ADMIN_PW)  # usernames are case-insensitive
    assert ok.status_code == 200 and ok.json()["user"]["role"] == "admin"
    cookie = ok.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=lax" in cookie and "secure" in cookie
    assert (await c.get("/api/v1/book")).status_code == 200
    assert (await c.get("/api/v1/auth/session")).json()["user"]["username"] == "bookmind"
    await c.post("/api/v1/auth/logout")
    assert (await c.get("/api/v1/book")).status_code == 401


async def test_unsafe_requests_need_the_csrf_header(people):
    c = people("10.1.0.2")
    await sign_in(c, "bookmind", ADMIN_PW)
    r = await c.put(f"/api/v1/notes/{uid('n')}", json={"doc": "bill", "page": 1, "mode": "note", "selection": "x"},
                    headers={"X-BookMind": ""})
    assert r.status_code == 403 and r.json()["code"] == "csrf"


async def test_new_account_must_choose_its_own_password(people):
    admin = people("10.1.0.3")
    await sign_in(admin, "bookmind", ADMIN_PW)
    name, temp, chosen = await new_reader(admin)
    me = people("10.1.0.4")
    first = await sign_in(me, name, temp)
    assert first.json()["user"]["must_change"] is True
    blocked = await me.get("/api/v1/book")
    assert blocked.status_code == 403 and blocked.json()["code"] == "password_change_required"
    weak = await me.post("/api/v1/auth/password", json={"current": temp, "new": "short"})
    assert weak.status_code == 422
    done = await me.post("/api/v1/auth/password", json={"current": temp, "new": chosen})
    assert done.status_code == 200 and done.json()["user"]["must_change"] is False
    assert (await me.get("/api/v1/book")).status_code == 200  # this device stays signed in


async def test_readers_cannot_manage_accounts(people):
    admin = people("10.1.0.5")
    await sign_in(admin, "bookmind", ADMIN_PW)
    name, temp, chosen = await new_reader(admin)
    me = people("10.1.0.6")
    await sign_in(me, name, temp)
    await me.post("/api/v1/auth/password", json={"current": temp, "new": chosen})
    assert (await me.get("/api/v1/admin/users")).status_code == 403
    assert (await me.post("/api/v1/admin/users", json={"username": uid("x")})).status_code == 403


async def test_disabling_or_resetting_ends_sessions_everywhere(people):
    admin = people("10.1.0.7")
    await sign_in(admin, "bookmind", ADMIN_PW)
    name, temp, chosen = await new_reader(admin)
    phone, laptop = people("10.1.0.8"), people("10.1.0.9")
    await sign_in(phone, name, temp)
    await phone.post("/api/v1/auth/password", json={"current": temp, "new": chosen})
    await sign_in(laptop, name, chosen)
    assert (await laptop.get("/api/v1/book")).status_code == 200
    await admin.patch(f"/api/v1/admin/users/{name}", json={"disabled": True})
    assert (await phone.get("/api/v1/book")).status_code == 401
    assert (await laptop.get("/api/v1/book")).status_code == 401
    assert (await sign_in(laptop, name, chosen)).status_code == 403  # disabled
    await admin.patch(f"/api/v1/admin/users/{name}", json={"disabled": False})
    reset = await admin.patch(f"/api/v1/admin/users/{name}", json={"reset_password": True})
    assert (await sign_in(laptop, name, reset.json()["temporary_password"])).json()["user"]["must_change"]


async def test_there_is_always_an_active_admin(people):
    admin = people("10.1.0.10")
    await sign_in(admin, "bookmind", ADMIN_PW)
    assert (await admin.patch("/api/v1/admin/users/bookmind", json={"disabled": True})).status_code == 409
    assert (await admin.delete("/api/v1/admin/users/bookmind")).status_code == 409


def test_repeated_wrong_passwords_lock_the_account(people):
    name = uid("lock")
    with accounts.db() as conn:
        conn.execute("INSERT INTO users(username, password_hash, role, created_at) VALUES (?,?,?,?)",
                     (name, accounts.hash_password("right-pass-phrase"), "reader", 0))
        conn.commit()
    for _ in range(accounts.MAX_FAILED):
        assert accounts.check_login(name, "wrong-pass-phrase")[0] == 401
    status, body = accounts.check_login(name, "right-pass-phrase")
    assert status == 423 and body["retry_after"] > 0  # even the right password waits out the lock


# ------------------------------------------------------------------ private notebooks

NOTE = {"doc": "bill", "doc_short": "Bill", "page": 11, "mode": "note", "chunk_id": "bill-10"}


async def two_people(people, ip):
    admin = people(f"10.2.{ip}.1")
    await sign_in(admin, "bookmind", ADMIN_PW)
    name, temp, chosen = await new_reader(admin)
    reader = people(f"10.2.{ip}.2")
    await sign_in(reader, name, temp)
    await reader.post("/api/v1/auth/password", json={"current": temp, "new": chosen})
    return admin, reader, name


async def test_notes_are_private_even_with_the_same_note_id(people):
    admin, reader, name = await two_people(people, 1)
    nid, secret = uid("shared"), uid("okapi")
    a = await admin.put(f"/api/v1/notes/{nid}", json={**NOTE, "selection": "admin's words", "comment": f"admin {secret}"})
    r = await reader.put(f"/api/v1/notes/{nid}", json={**NOTE, "selection": "reader's words", "comment": "mine"})
    assert a.json()["applied"] and r.json()["applied"]  # same id, two separate notes
    mine = {n["id"]: n for n in (await reader.get("/api/v1/notes")).json()["notes"]}
    theirs = {n["id"]: n for n in (await admin.get("/api/v1/notes")).json()["notes"]}
    assert mine[nid]["selection"] == "reader's words" and theirs[nid]["selection"] == "admin's words"
    assert all(n["owner"] == name for n in mine.values())
    # Deleting "it" as the reader removes only the reader's note.
    await reader.delete(f"/api/v1/notes/{nid}", params={"updated_at": 9_999_999_999_999})
    assert nid in {n["id"] for n in (await admin.get("/api/v1/notes")).json()["notes"]}
    assert nid not in {n["id"] for n in (await reader.get("/api/v1/notes")).json()["notes"]}
    # Search only ever looks in your own notebook.
    import asyncio

    for _ in range(50):
        if (await admin.get("/api/v1/search", params={"q": secret})).json()["notes"]:
            break
        await asyncio.sleep(0.05)
    assert (await admin.get("/api/v1/search", params={"q": secret})).json()["notes"]
    assert (await reader.get("/api/v1/search", params={"q": secret})).json()["notes"] == []


async def test_same_idempotency_key_from_two_people_never_crosses(people):
    admin, reader, _ = await two_people(people, 2)
    nid = uid("idem")
    key = {"Idempotency-Key": f"put-{nid}-1700000000000"}
    body = {**NOTE, "selection": "same request", "updated_at": 1700000000000}
    first = await admin.put(f"/api/v1/notes/{nid}", json=body, headers=key)
    second = await reader.put(f"/api/v1/notes/{nid}", json=body, headers=key)
    assert "idempotent-replayed" not in second.headers  # the reader's write really ran
    assert first.json()["note"]["owner"] != second.json()["note"]["owner"]


async def test_changes_queued_under_another_account_are_held_not_misfiled(people):
    admin, reader, name = await two_people(people, 3)
    r = await reader.put(f"/api/v1/notes/{uid('q')}", json={**NOTE, "selection": "x"}, headers={"X-BookMind-User": "bookmind"})
    assert r.status_code == 409 and r.json()["code"] == "user_mismatch"  # 409 = keep it queued, retry later


async def test_deleting_an_account_erases_its_notes(people):
    admin, reader, name = await two_people(people, 4)
    await reader.put(f"/api/v1/notes/{uid('gone')}", json={**NOTE, "selection": "to be erased"})
    out = await admin.delete(f"/api/v1/admin/users/{name}")
    assert out.status_code == 200 and out.json()["deleted_notes"] == 1
    assert (await reader.get("/api/v1/notes")).status_code == 401  # session ended
    from bookmind.services import notebook

    assert notebook.list_notes(owner=name, include_deleted=True, limit=10, session=None) == {"notes": [], "sessions": [], "tombstones": []}


async def test_single_user_mode_needs_no_sign_in(client):
    s = (await client.get("/api/v1/auth/session")).json()
    assert s["mode"] == "none" and s["user"]["username"] == "bookmind"
    assert (await client.get("/api/v1/notes")).status_code == 200
