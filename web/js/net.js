// SPDX-License-Identifier: AGPL-3.0-or-later
// Network layer: timeouts, W3C trace headers, and the offline sync engine.

import * as store from "./store.js";
import "./sync-core.js"; // classic script shared with sw.js; defines self.BookMindSync

const core = self.BookMindSync;

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

export const isTransient = (err) => core.isTransient(err);

/** Replays queued note changes in order while the app is open (sync-core.js does the work; the
 *  service worker runs the same code when the app is closed). Idempotency-Keys make replays safe if
 *  a response is lost; LWW `updated_at` on the server makes them safe across devices. */
export class SyncEngine {
  constructor({ onChange, onStatus }) {
    this.onChange = onChange;
    this.onStatus = onStatus;
    this.running = null;
    this.failures = 0;
    this.timer = null;
    this.snapshot = [];
  }

  async pending() { return this.track(); }

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
    await core.withLock(() => core.pushOutbox(store, api));
  }

  async pull() {
    if (await core.withLock(() => core.pullNotes(store, api))) this.onChange();
  }

  /** Remember the queue so it can still be sent if the page is closed before the next sync. */
  async track() {
    this.snapshot = await store.outbox();
    return this.snapshot.length;
  }

  /** Page is being closed or hidden: hand queued changes to the browser with `keepalive`, which lets
   *  a request outlive the page (browsers without Background Sync — Firefox, Safari — rely on this).
   *  The outbox isn't cleared here; the next sync replays with the same Idempotency-Keys, so a
   *  change that already arrived is answered from the server's idempotency store, not applied twice.
   *  keepalive bodies share a 64 KiB budget per page, so stop before exceeding it. */
  flushOnExit() {
    if (!navigator.onLine || !this.snapshot || !this.snapshot.length) return 0;
    let budget = 60000, sent = 0;
    this.flushed = this.flushed || new Set();
    for (const op of this.snapshot) {
      const key = op.op === "put" ? `put-${op.id}-${op.payload.updated_at}` : `del-${op.id}-${op.updated_at}`;
      if (this.flushed.has(key)) continue; // hide → show → hide again: don't resend the same change
      const size = op.op === "put" ? JSON.stringify(op.payload).length : 0;
      if (size > budget) break;
      budget -= size;
      this.flushed.add(key);
      core.sendOp(op, core.request, { keepalive: true }).catch(() => {});
      sent += 1;
    }
    return sent;
  }
}
