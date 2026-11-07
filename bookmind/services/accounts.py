# SPDX-License-Identifier: AGPL-3.0-or-later
"""Accounts service — who may use BookMind, and with which role.

Owns the user table (its own SQLite database; one writer, like the notebook). The gateway calls it
to check a sign-in, then keeps the session itself; nothing else talks to it.

Passwords
  * Hashed with scrypt (memory-hard, in Python's standard library — no native dependency) with a
    random 16-byte salt per user; the parameters are stored with each hash so they can be raised
    later and old hashes still verify (and are upgraded on the next sign-in).
  * Rules follow NIST SP 800-63B: at least 10 characters, long passphrases welcome (up to 256), no
    composition rules, but refuse the username itself and well-known passwords.
  * Unknown usernames are checked against a dummy hash, so response time doesn't reveal which
    accounts exist.

Abuse
  * 10 failed attempts lock the account for 15 minutes (the gateway also rate-limits sign-ins per
    address). The lock is per account, so a guesser can't lock everyone out from one address
    faster than the gateway limit allows.

Roles
  * admin: manage accounts. reader: everything else. There is always at least one enabled admin.
  * The first admin is created from BOOKMIND_AUTH_USER / BOOKMIND_AUTH_PASSWORD(_FILE) when the
    table is empty, so an existing single-password deployment keeps its login.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import logging
import re
import secrets
import sqlite3
import time
from contextlib import asynccontextmanager, contextmanager
from typing import Literal

from fastapi import HTTPException, Path
from pydantic import BaseModel, Field

from bookmind.common.config import get_settings
from bookmind.common.service import create_service
from bookmind.common.telemetry import log

logger = logging.getLogger("bookmind.accounts")
USERNAME = r"^[a-z0-9][a-z0-9._-]{1,31}$"
MAX_FAILED = 10
LOCK_S = 15 * 60
SCRYPT = {"n": 2**14, "r": 8, "p": 1}
COMMON = frozenset(
    "password password1 password123 1234567890 12345678910 qwertyuiop 1q2w3e4r5t iloveyou123 letmein123 "
    "welcome123 bookmind123 administrator changeme123 kenya12345 nairobi123 0123456789 abcdefghij".split()
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS users(
    username TEXT PRIMARY KEY,
    display_name TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'reader')),
    disabled INTEGER NOT NULL DEFAULT 0,
    must_change INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    locked_until REAL NOT NULL DEFAULT 0,
    epoch INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER
);
"""


# ------------------------------------------------------------------ passwords

def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, dklen=32, maxmem=64 * 1024 * 1024, **SCRYPT)
    b64 = lambda b: base64.b64encode(b).decode()  # noqa: E731
    return f"scrypt${SCRYPT['n']}${SCRYPT['r']}${SCRYPT['p']}${b64(salt)}${b64(digest)}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, n, r, p, salt, digest = stored.split("$")
        if algo != "scrypt":
            return False
        expected = base64.b64decode(digest)
        got = hashlib.scrypt(password.encode(), salt=base64.b64decode(salt), n=int(n), r=int(r), p=int(p),
                             dklen=len(expected), maxmem=64 * 1024 * 1024)
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(got, expected)


def needs_rehash(stored: str) -> bool:
    return not stored.startswith(f"scrypt${SCRYPT['n']}${SCRYPT['r']}${SCRYPT['p']}$")


_DUMMY = hash_password(secrets.token_urlsafe(16))


def password_problem(password: str, username: str = "") -> str | None:
    """Why a new password is refused, or None (NIST SP 800-63B §5.1.1.2)."""
    if len(password) < 10:
        return "Use at least 10 characters — a short phrase is easiest to remember."
    if len(password) > 256:
        return "Use at most 256 characters."
    low = password.lower()
    if low in COMMON or len(set(low)) < 4:
        return "That password is too common or repetitive. Try a short phrase instead."
    if username and username.lower() in low:
        return "Don't include your username in your password."
    return None


def temporary_password() -> str:
    """Readable one-time password for a new account or a reset (the user must change it)."""
    words = "amani baraka dawa farasi jua kesho maji mlima mvua nyota pwani simba tembo upepo zuri".split()
    return "-".join(secrets.choice(words) for _ in range(3)) + f"-{secrets.randbelow(90) + 10}"


# ------------------------------------------------------------------ storage

@contextmanager
def db():
    path = get_settings().accounts_db_path
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    try:
        yield conn
    finally:
        conn.close()


def public(row: sqlite3.Row) -> dict:
    return {
        "username": row["username"], "display_name": row["display_name"] or row["username"], "role": row["role"],
        "disabled": bool(row["disabled"]), "must_change": bool(row["must_change"]), "epoch": row["epoch"],
        "created_at": row["created_at"], "last_login_at": row["last_login_at"],
        "locked": row["locked_until"] > time.time(),
    }


def migrate_and_bootstrap() -> None:
    s = get_settings()
    with db() as conn:
        conn.executescript(SCHEMA)
        if conn.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0 and s.auth_password:
            name = s.auth_user.strip().lower()
            if not re.fullmatch(USERNAME, name):
                raise SystemExit(f"BOOKMIND_AUTH_USER {s.auth_user!r} isn't a valid username ({USERNAME})")
            conn.execute(
                "INSERT INTO users(username, display_name, password_hash, role, created_at) VALUES (?,?,?,?,?)",
                (name, "Administrator", hash_password(s.auth_password), "admin", int(time.time() * 1000)),
            )
            log(logger, logging.INFO, "admin_bootstrapped", username=name)
        conn.commit()


def _get(conn, username: str) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM users WHERE username=?", (username.lower(),)).fetchone()


def _enabled_admins(conn) -> int:
    return conn.execute("SELECT COUNT(*) FROM users WHERE role='admin' AND disabled=0").fetchone()[0]


def check_login(username: str, password: str) -> tuple[int, dict]:
    """(status, body): 200 user · 401 wrong · 403 disabled · 423 locked."""
    with db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = _get(conn, username)
        if row is None:
            verify_password(password, _DUMMY)  # same work as a real check
            conn.rollback()
            return 401, {"detail": "Wrong username or password."}
        now = time.time()
        if row["locked_until"] > now:
            conn.rollback()
            return 423, {"detail": "Too many failed attempts. Try again in a few minutes.", "retry_after": int(row["locked_until"] - now) + 1}
        if not verify_password(password, row["password_hash"]):
            failed = row["failed"] + 1
            locked = now + LOCK_S if failed >= MAX_FAILED else 0
            conn.execute("UPDATE users SET failed=?, locked_until=? WHERE username=?", (0 if locked else failed, locked, row["username"]))
            conn.commit()
            if locked:
                log(logger, logging.WARNING, "account_locked", username=row["username"])
            return 401, {"detail": "Wrong username or password."}
        if row["disabled"]:
            conn.rollback()
            return 403, {"detail": "This account is disabled. Ask an administrator."}
        updates = {"failed": 0, "locked_until": 0, "last_login_at": int(now * 1000)}
        if needs_rehash(row["password_hash"]):
            updates["password_hash"] = hash_password(password)
        conn.execute(f"UPDATE users SET {', '.join(f'{k}=?' for k in updates)} WHERE username=?",  # noqa: S608 — fixed keys
                     [*updates.values(), row["username"]])
        conn.commit()
        return 200, public(_get(conn, row["username"]))


# ------------------------------------------------------------------ API (internal: gateway only)

@asynccontextmanager
async def lifespan(_app):
    await asyncio.to_thread(migrate_and_bootstrap)
    yield


app = create_service("accounts", lifespan=lifespan)


def _ping() -> bool:
    with db() as conn:
        return conn.execute("SELECT 1").fetchone() is not None


async def _ready() -> bool:
    return await asyncio.to_thread(_ping)


app.state.readiness["database"] = _ready


class Login(BaseModel):
    username: str = Field(..., min_length=1, max_length=64)
    password: str = Field(..., min_length=1, max_length=256)


class NewUser(BaseModel):
    username: str = Field(..., pattern=USERNAME)
    display_name: str = Field("", max_length=80)
    role: Literal["admin", "reader"] = "reader"
    password: str | None = Field(None, max_length=256)  # omitted -> a temporary one is generated


class UserPatch(BaseModel):
    display_name: str | None = Field(None, max_length=80)
    role: Literal["admin", "reader"] | None = None
    disabled: bool | None = None
    reset_password: bool = False  # issue a new temporary password


class PasswordChange(BaseModel):
    current: str = Field(..., max_length=256)
    new: str = Field(..., max_length=256)


@app.post("/v1/verify")
def verify(body: Login):
    with db() as conn:
        empty = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0
    if empty:
        migrate_and_bootstrap()  # the admin password may have been provided after start-up
    status, out = check_login(body.username.strip(), body.password)
    if status != 200:
        raise HTTPException(status, out)
    return out


@app.get("/v1/users")
def list_users():
    with db() as conn:
        return {"users": [public(r) for r in conn.execute("SELECT * FROM users ORDER BY role, username")]}


@app.get("/v1/users/{username}")
def get_user(username: str = Path(..., max_length=64)):
    with db() as conn:
        row = _get(conn, username)
    if row is None:
        raise HTTPException(404, "No such account.")
    return public(row)


@app.post("/v1/users", status_code=201)
def create_user(body: NewUser):
    password = body.password or temporary_password()
    if body.password and (problem := password_problem(password, body.username)):
        raise HTTPException(422, problem)
    with db() as conn:
        try:
            conn.execute(
                "INSERT INTO users(username, display_name, password_hash, role, must_change, created_at) VALUES (?,?,?,?,?,?)",
                (body.username, body.display_name.strip(), hash_password(password), body.role, 1, int(time.time() * 1000)),
            )
        except sqlite3.IntegrityError as exc:
            raise HTTPException(409, "That username is taken.") from exc
        conn.commit()
        user = public(_get(conn, body.username))
    log(logger, logging.INFO, "account_created", username=body.username, role=body.role)
    return {"user": user, "temporary_password": None if body.password else password}


@app.patch("/v1/users/{username}")
def update_user(body: UserPatch, username: str = Path(..., pattern=USERNAME)):
    temp = None
    with db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = _get(conn, username)
        if row is None:
            conn.rollback()
            raise HTTPException(404, "No such account.")
        sets: dict = {}
        if body.display_name is not None:
            sets["display_name"] = body.display_name.strip()
        if body.role is not None:
            sets["role"] = body.role
        if body.disabled is not None:
            sets["disabled"] = int(body.disabled)
        losing_admin = row["role"] == "admin" and not row["disabled"] and (sets.get("role") == "reader" or sets.get("disabled") == 1)
        if losing_admin and _enabled_admins(conn) <= 1:
            conn.rollback()
            raise HTTPException(409, "BookMind needs at least one active administrator.")
        if body.reset_password:
            temp = temporary_password()
            sets.update(password_hash=hash_password(temp), must_change=1, failed=0, locked_until=0)
        if body.disabled or body.reset_password or body.role:
            sets["epoch"] = row["epoch"] + 1  # ends this user's existing sessions
        if sets:
            conn.execute(f"UPDATE users SET {', '.join(f'{k}=?' for k in sets)} WHERE username=?",  # noqa: S608 — fixed keys
                         [*sets.values(), row["username"]])
        conn.commit()
        user = public(_get(conn, username))
    return {"user": user, "temporary_password": temp}


@app.post("/v1/users/{username}/password")
def change_password(body: PasswordChange, username: str = Path(..., pattern=USERNAME)):
    with db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = _get(conn, username)
        if row is None or not verify_password(body.current, row["password_hash"]):
            conn.rollback()
            raise HTTPException(403, "Your current password isn't right.")
        if problem := password_problem(body.new, username):
            conn.rollback()
            raise HTTPException(422, problem)
        if verify_password(body.new, row["password_hash"]):
            conn.rollback()
            raise HTTPException(422, "Choose a password different from the current one.")
        conn.execute("UPDATE users SET password_hash=?, must_change=0, epoch=epoch+1 WHERE username=?",
                     (hash_password(body.new), row["username"]))
        conn.commit()
        return public(_get(conn, username))


@app.delete("/v1/users/{username}")
def delete_user(username: str = Path(..., pattern=USERNAME)):
    with db() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = _get(conn, username)
        if row is None:
            conn.rollback()
            raise HTTPException(404, "No such account.")
        if row["role"] == "admin" and not row["disabled"] and _enabled_admins(conn) <= 1:
            conn.rollback()
            raise HTTPException(409, "BookMind needs at least one active administrator.")
        conn.execute("DELETE FROM users WHERE username=?", (row["username"],))
        conn.commit()
    log(logger, logging.INFO, "account_deleted", username=username)
    return {"deleted": True}
