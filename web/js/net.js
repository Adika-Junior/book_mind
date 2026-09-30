// SPDX-License-Identifier: AGPL-3.0-or-later
// Network layer: timeouts, W3C trace headers, and the offline sync engine.

import * as store from "./store.js";

const hex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");

export class HttpError extends Error {
  constructor(status, detail, headers) { super(detail || `HTTP ${status}`); this.status = status; this.headers = headers; }
}

/** fetch + timeout + traceparent (so a browser action is one trace across every service). */
export async function api(path, { method = "GET", body, timeout = 15000, idempotencyKey, headers = {} } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const h = { Accept: "application/json", traceparent: `00-${hex(16)}-${hex(8)}-01`, ...headers };
  if (body !== undefined) h["Content-Type"] = "application/json";
  if (idempotencyKey) h["Idempotency-Key"] = idempotencyKey;
  try {
    const res = await fetch(path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: h, signal: ctrl.signal, credentials: "same-origin" });
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) throw new HttpError(res.status, data && data.detail, res.headers);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export const isTransient = (err) => !(err instanceof HttpError) || err.status >= 500 || [408, 409, 425, 429].includes(err.status);

/** Replays queued note changes in order. Idempotency-Keys make replays safe if a response is
 *  lost; LWW `updated_at` on the server makes them safe across devices. */
export class SyncEngine {
  constructor({ onChange, onStatus }) {
    this.onChange = onChange;
    this.onStatus = onStatus;
    this.running = null;
    this.failures = 0;
    this.timer = null;
  }

  async pending() { return (await store.outbox()).length; }

  schedule(delayMs) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.run(), delayMs);
  }

  run() {
    if (!this.running) this.running = this._run().finally(() => { this.running = null; });
    return this.running;
  }

  async _run() {
    if (!navigator.onLine) { this.onStatus(await this.pending()); return; }
    try {
      await this.push();
      await this.pull();
      this.failures = 0;
    } catch (err) {
      if (!isTransient(err)) console.warn("sync", err);
      this.failures += 1;
      // Exponential backoff with full jitter, capped at 5 minutes.
      this.schedule(Math.random() * Math.min(300000, 2000 * 2 ** this.failures));
    }
    this.onStatus(await this.pending());
  }

  async push() {
    for (const op of await store.outbox()) {
      try {
        if (op.op === "put") {
          const res = await api(`/api/v1/notes/${encodeURIComponent(op.id)}`, { method: "PUT", body: op.payload, idempotencyKey: `put-${op.id}-${op.payload.updated_at}` });
          const local = await store.getNote(op.id);
          if (local && local.updated_at === op.payload.updated_at) {
            if (res.deleted) await store.deleteNote(op.id);
            else await store.putNote({ ...local, synced: res.applied || local.synced });
          }
        } else if (op.op === "delete") {
          await api(`/api/v1/notes/${encodeURIComponent(op.id)}?updated_at=${op.updated_at}`, { method: "DELETE", idempotencyKey: `del-${op.id}-${op.updated_at}` });
        }
        await store.dequeue(op.seq);
      } catch (err) {
        if (isTransient(err)) throw err; // keep order: stop and retry later
        console.warn("dropping unsyncable change", op, err); // 4xx: the change itself is invalid
        await store.dequeue(op.seq);
      }
    }
  }

  async pull() {
    const data = await api("/api/v1/notes?include_deleted=true", { timeout: 10000 });
    const queued = new Set((await store.outbox()).map((o) => o.id));
    let changed = false;
    for (const remote of data.notes || []) {
      if (queued.has(remote.id)) continue; // our unsent edit is newer by definition
      const local = await store.getNote(remote.id);
      if (!local || (remote.updated_at || 0) > (local.updated_at || 0)) {
        await store.putNote({ ...remote, synced: true });
        changed = true;
      }
    }
    for (const t of data.tombstones || []) {
      if (queued.has(t.id)) continue;
      const local = await store.getNote(t.id);
      if (local && t.updated_at >= (local.updated_at || 0)) { await store.deleteNote(t.id); changed = true; }
    }
    if (changed) this.onChange();
  }
}
