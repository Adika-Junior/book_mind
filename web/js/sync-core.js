// SPDX-License-Identifier: AGPL-3.0-or-later
// Outbox replay shared by the page (net.js imports this file) and the service worker (sw.js loads it
// with importScripts). A classic script on purpose: module service workers aren't supported everywhere.
//
// Keeping one implementation means a note written offline is synced the same way whether the app is
// open (SyncEngine), or closed and the browser wakes the service worker (Background Sync / Periodic
// Background Sync). Safety across both paths:
//   * Web Locks: only one context replays the outbox at a time (page and worker never race);
//   * Idempotency-Keys derived from (note id, updated_at): a replay whose response was lost is
//     answered from the server's idempotency store instead of being applied twice;
//   * last-writer-wins `updated_at` on the server: stale replays can't overwrite newer edits;
//   * accounts: each account has its own database, and every replayed change says whose it is
//     (X-BookMind-User). If someone else is signed in, the server answers 409 and the change stays
//     queued for its owner instead of being filed under the wrong person.

(function (root) {
  "use strict";

  const DB_VERSION = 1;
  const LOCK = "bookmind-outbox";

  // Must stay identical to store.js (same database, same version, same upgrade).
  function upgrade(db) {
    if (!db.objectStoreNames.contains("notes")) db.createObjectStore("notes", { keyPath: "id" });
    if (!db.objectStoreNames.contains("outbox")) db.createObjectStore("outbox", { keyPath: "seq", autoIncrement: true });
  }

  function openDB(name) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(name, DB_VERSION);
      req.onupgradeneeded = () => upgrade(req.result);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("IndexedDB blocked"));
    });
  }

  /** Minimal IndexedDB adapter with the same shape as store.js (used inside the service worker). */
  function idbStore(name) {
    let dbp = null;
    const db = () => (dbp ||= openDB(name));
    const run = (storeName, mode, fn) => db().then((conn) => new Promise((resolve, reject) => {
      const t = conn.transaction(storeName, mode);
      const r = fn(t.objectStore(storeName));
      t.oncomplete = () => resolve(r && "result" in r ? r.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
    return {
      outbox: () => run("outbox", "readonly", (s) => s.getAll()).then((ops) => (ops || []).sort((a, b) => a.seq - b.seq)),
      getNote: (id) => run("notes", "readonly", (s) => s.get(id)),
      putNote: (note) => run("notes", "readwrite", (s) => { s.put(note); }),
      deleteNote: (id) => run("notes", "readwrite", (s) => { s.delete(id); }),
      dequeue: (seq) => run("outbox", "readwrite", (s) => { s.delete(seq); }),
      close: () => dbp && dbp.then((c) => c.close()).catch(() => {}),
    };
  }

  /** The account this device is signed in as (written by store.js), or null when signed out. */
  function activeAccount() {
    return new Promise((resolve) => {
      const req = indexedDB.open("bookmind-meta", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("kv");
      req.onerror = () => resolve(null);
      req.onsuccess = () => {
        const conn = req.result;
        try {
          const r = conn.transaction("kv").objectStore("kv").get("active");
          r.onsuccess = () => { conn.close(); resolve(r.result || null); };
          r.onerror = () => { conn.close(); resolve(null); };
        } catch { conn.close(); resolve(null); }
      };
    });
  }

  class HttpError extends Error {
    constructor(status, detail) { super(detail || `HTTP ${status}`); this.status = status; }
  }

  // 401/403: signed out, session expired or first-login password pending — keep the change queued
  // until its owner signs in. Only 400/404/413/422 mean the change itself is invalid.
  const isTransient = (err) => !(err && err.status) || err.status >= 500 || [401, 403, 408, 409, 425, 429].includes(err.status);

  /** A bare fetch-based requester for contexts without net.js (the service worker). */
  async function request(path, { method = "GET", body, idempotencyKey, keepalive = false, timeout = 15000, headers: extra = {} } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    const headers = { Accept: "application/json", "X-BookMind": "1", ...extra };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    try {
      const res = await fetch(path, {
        method, headers, keepalive, credentials: "same-origin", signal: ctrl.signal,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = res.status === 204 ? null : await res.json().catch(() => null);
      if (!res.ok) throw new HttpError(res.status, data && data.detail);
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  /** The HTTP call that replays one queued op (shared with the keepalive flush on page close). */
  function sendOp(op, send, extra = {}) {
    const id = encodeURIComponent(op.id);
    if (op.owner) extra = { ...extra, headers: { ...(extra.headers || {}), "X-BookMind-User": op.owner } };
    if (op.op === "put") {
      return send(`/api/v1/notes/${id}`, { method: "PUT", body: op.payload, idempotencyKey: `put-${op.id}-${op.payload.updated_at}`, ...extra });
    }
    return send(`/api/v1/notes/${id}?updated_at=${op.updated_at}`, { method: "DELETE", idempotencyKey: `del-${op.id}-${op.updated_at}`, ...extra });
  }

  /** Replay queued changes in order. Stops at the first transient failure (keeps order; retry later);
   *  drops a change the server rejects outright (4xx: the change itself is invalid). */
  async function pushOutbox(db, send) {
    let pushed = 0;
    for (const op of await db.outbox()) {
      try {
        const res = await sendOp(op, send);
        if (op.op === "put") {
          const local = await db.getNote(op.id);
          if (local && local.updated_at === op.payload.updated_at) {
            if (res && res.deleted) await db.deleteNote(op.id);
            else await db.putNote({ ...local, synced: (res && res.applied) || local.synced });
          }
        }
        await db.dequeue(op.seq);
        pushed += 1;
      } catch (err) {
        if (isTransient(err)) throw err;
        console.warn("dropping unsyncable change", op, err);
        await db.dequeue(op.seq);
      }
    }
    return pushed;
  }

  /** Bring server-side changes (other devices) into the local store. Returns true if anything changed. */
  async function pullNotes(db, send) {
    const data = await send("/api/v1/notes?include_deleted=true", { timeout: 10000 });
    const queued = new Set((await db.outbox()).map((o) => o.id));
    let changed = false;
    for (const remote of (data && data.notes) || []) {
      if (queued.has(remote.id)) continue; // our unsent edit is newer by definition
      const local = await db.getNote(remote.id);
      if (!local || (remote.updated_at || 0) > (local.updated_at || 0)) {
        await db.putNote({ ...remote, synced: true });
        changed = true;
      }
    }
    for (const t of (data && data.tombstones) || []) {
      if (queued.has(t.id)) continue;
      const local = await db.getNote(t.id);
      if (local && t.updated_at >= (local.updated_at || 0)) { await db.deleteNote(t.id); changed = true; }
    }
    return changed;
  }

  /** Run fn while holding the cross-context outbox lock (page tabs + service worker). */
  function withLock(fn) {
    const locks = root.navigator && root.navigator.locks;
    return locks ? locks.request(LOCK, fn) : fn();
  }

  /** One full sync round: push local changes, then pull remote ones. */
  function syncOnce(db, send = request, { pull = true } = {}) {
    return withLock(async () => {
      const pushed = await pushOutbox(db, send);
      const changed = pull ? await pullNotes(db, send) : false;
      return { pushed, changed };
    });
  }

  /** Background sync from the service worker: the signed-in account's queue, or nothing. */
  async function syncActiveAccount({ pull = true } = {}) {
    const who = await activeAccount();
    if (!who) return { pushed: 0, changed: false };
    const db = idbStore(`bookmind-${who}`);
    try {
      return await syncOnce(db, request, { pull });
    } finally {
      db.close();
    }
  }

  root.BookMindSync = { idbStore, activeAccount, syncActiveAccount, request, sendOp, pushOutbox, pullNotes, withLock, syncOnce, isTransient, HttpError };
})(typeof self !== "undefined" ? self : globalThis);
