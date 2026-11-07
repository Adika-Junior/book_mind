// SPDX-License-Identifier: AGPL-3.0-or-later
// Local-first storage. Notes live in IndexedDB on the device (the source of truth while offline);
// pending server changes wait in an "outbox" store — the client-side twin of the server's
// transactional outbox — and are replayed with Idempotency-Keys when the network returns.
//
// Each account gets its own database ("bookmind-<username>"), so two people sharing a device never
// see each other's notes, and changes queued by one are never sent while the other is signed in.

const DB_VERSION = 1;
const LEGACY_DB = "bookmind"; // before accounts: one database per device
let DB_NAME = null;
let ACCOUNT = null;
let dbPromise = null;
let memoryFallback = null; // private mode / storage blocked: keep working, just not durably

export const dbNameFor = (username) => `bookmind-${username}`;
export const account = () => ACCOUNT;

/** Point storage at one account's database; records it for the service worker's background sync. */
export async function useAccount(username, { legacyOwner = null } = {}) {
  if (dbPromise) { try { (await dbPromise).close(); } catch { /* never opened */ } }
  dbPromise = null;
  memoryFallback = null;
  ACCOUNT = username;
  DB_NAME = dbNameFor(username);
  if (legacyOwner && username === legacyOwner) await adoptLegacyDatabase();
  await setActiveAccount(username);
}

/** The notebook from before accounts existed belongs to the local user / first admin: move it over once. */
async function adoptLegacyDatabase() {
  try {
    if (!indexedDB.databases || !(await indexedDB.databases()).some((d) => d.name === LEGACY_DB)) return;
    const legacy = await new Promise((resolve, reject) => { const r = indexedDB.open(LEGACY_DB); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const read = (name) => legacy.objectStoreNames.contains(name)
      ? new Promise((resolve) => { const r = legacy.transaction(name).objectStore(name).getAll(); r.onsuccess = () => resolve(r.result || []); r.onerror = () => resolve([]); })
      : Promise.resolve([]);
    const [notes, ops] = [await read("notes"), await read("outbox")];
    legacy.close();
    for (const n of notes) await putNote(n);
    for (const op of ops.sort((a, b) => a.seq - b.seq)) { const { seq, ...rest } = op; await tx("outbox", "readwrite", (s) => { s.put(rest); }); }
    indexedDB.deleteDatabase(LEGACY_DB);
  } catch { /* nothing to adopt */ }
}

/** Which account the device is signed in as — read by the service worker (it can't see localStorage). */
async function setActiveAccount(username) {
  try {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open("bookmind-meta", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("kv");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    await new Promise((resolve) => {
      const t = db.transaction("kv", "readwrite");
      if (username) t.objectStore("kv").put(username, "active"); else t.objectStore("kv").delete("active");
      t.oncomplete = t.onerror = () => resolve();
    });
    db.close();
  } catch { /* storage blocked: background sync just waits for the app */ }
}

/** Signed out: nothing syncs in the background until someone signs in again. Queued changes stay
 *  in that person's database and are sent the next time they sign in on this device. */
export async function signOutDevice() {
  if (dbPromise) { try { (await dbPromise).close(); } catch { /* ignore */ } }
  dbPromise = null;
  ACCOUNT = null;
  DB_NAME = null;
  await setActiveAccount(null);
}

function open() {
  if (dbPromise) return dbPromise;
  if (!DB_NAME) return Promise.reject(new Error("No account selected"));
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
    s.put({ ...op, owner: ACCOUNT, queued_at: Date.now() }); // replayed only as this account
  });
}

export async function dequeue(seq) {
  return tx("outbox", "readwrite", (s) => { s.delete(seq); });
}

// Small synchronous preferences stay in localStorage. Device settings (theme, voice, speed) are
// shared by everyone using the device; personal ones (where you were reading, your research
// sessions, your web-search consent) are kept per account.
const PERSONAL = new Set(["pos", "docpos", "progress", "session", "sessions", "web_ok", "web_research"]);
const prefKey = (key) => (PERSONAL.has(key) && ACCOUNT ? `bm_u:${ACCOUNT}:${key}` : "bm_" + key);
export const prefs = {
  get(key, fallback = null) {
    try { const v = localStorage.getItem(prefKey(key)); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(prefKey(key), JSON.stringify(value)); } catch { /* storage full or blocked */ }
  },
  remove(key) {
    try { localStorage.removeItem(prefKey(key)); } catch { /* ignore */ }
  },
  /** First sign-in of the pre-accounts owner: their old personal settings become theirs. */
  adoptLegacy() {
    try {
      for (const key of PERSONAL) {
        const old = localStorage.getItem("bm_" + key);
        if (old !== null && localStorage.getItem(prefKey(key)) === null) localStorage.setItem(prefKey(key), old);
        localStorage.removeItem("bm_" + key);
      }
    } catch { /* ignore */ }
  },
};

export async function requestPersistence() {
  // Ask the browser not to evict our offline data under storage pressure (best effort).
  try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch { /* ignore */ }
  return false;
}
