// SPDX-License-Identifier: AGPL-3.0-or-later
// Local-first storage. Notes live in IndexedDB on the device (the source of truth while offline);
// pending server changes wait in an "outbox" store — the client-side twin of the server's
// transactional outbox — and are replayed with Idempotency-Keys when the network returns.

const DB_NAME = "bookmind";
const DB_VERSION = 1;
let dbPromise = null;
let memoryFallback = null; // private mode / storage blocked: keep working, just not durably

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!("indexedDB" in self)) { reject(new Error("IndexedDB unavailable")); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("notes")) db.createObjectStore("notes", { keyPath: "id" });
      if (!db.objectStoreNames.contains("outbox")) db.createObjectStore("outbox", { keyPath: "seq", autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("IndexedDB blocked"));
  }).catch((err) => {
    memoryFallback = { notes: new Map(), outbox: new Map(), seq: 1 };
    throw err;
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  try {
    const db = await open();
    return await new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      let result;
      Promise.resolve(fn(s)).then((r) => { result = r; });
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } catch (err) {
    if (!memoryFallback) memoryFallback = { notes: new Map(), outbox: new Map(), seq: 1 };
    return fn(memStore(store));
  }
}

function memStore(name) {
  // Same call shapes as an IDBObjectStore, answered synchronously from a Map.
  const m = memoryFallback[name];
  const done = (value) => ({ __mem: true, result: value });
  return {
    getAll: () => done([...m.values()]),
    get: (k) => done(m.get(k)),
    put: (v) => {
      if (name === "outbox" && v.seq == null) v.seq = memoryFallback.seq++;
      m.set(name === "notes" ? v.id : v.seq, v);
      return done(v);
    },
    delete: (k) => { m.delete(k); return done(undefined); },
  };
}

const req2promise = (r) => r.__mem ? Promise.resolve(r.result) : new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

export async function allNotes() {
  const notes = await tx("notes", "readonly", (s) => req2promise(s.getAll()));
  return (notes || []).sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
}

export async function getNote(id) {
  return tx("notes", "readonly", (s) => req2promise(s.get(id)));
}

export async function putNote(note) {
  return tx("notes", "readwrite", (s) => { s.put(note); });
}

export async function deleteNote(id) {
  return tx("notes", "readwrite", (s) => { s.delete(id); });
}

export async function outbox() {
  const ops = await tx("outbox", "readonly", (s) => req2promise(s.getAll()));
  return (ops || []).sort((a, b) => a.seq - b.seq);
}

/** Queue a change for the server. Earlier queued ops for the same note are dropped:
 *  writes are full-state, last-writer-wins upserts, so only the newest one matters. */
export async function enqueue(op) {
  const pending = await outbox();
  return tx("outbox", "readwrite", (s) => {
    for (const p of pending) if (p.id === op.id) s.delete(p.seq);
    s.put({ ...op, queued_at: Date.now() });
  });
}

export async function dequeue(seq) {
  return tx("outbox", "readwrite", (s) => { s.delete(seq); });
}

// Small synchronous preferences (theme, voice, position) stay in localStorage.
export const prefs = {
  get(key, fallback = null) {
    try { const v = localStorage.getItem("bm_" + key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem("bm_" + key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
  },
};

export async function requestPersistence() {
  // Ask the browser not to evict our offline data under storage pressure (best effort).
  try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch { /* ignore */ }
  return false;
}
