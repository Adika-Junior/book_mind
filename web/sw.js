// SPDX-License-Identifier: AGPL-3.0-or-later
// BookMind service worker — makes the app work offline and installable.
//
//   App shell (HTML/CSS/JS/icons)  precached, cache-first        -> instant, offline start
//   Book text + glossary           precached, stale-while-revalidate -> offline reading & search
//   Meaning-search vectors         cached on first use, stale-while-revalidate (≈3 MB, so not precached)
//   Read-aloud audio (Piper)       cache-first: same voice + text = same audio, so pages you've
//                                  listened to play again offline; bounded, oldest evicted first
//   Navigations                    network-first (3 s), cached shell as fallback
//   Everything else under /api/    network only (the page handles offline itself: notes are
//                                  queued in IndexedDB and replayed with Idempotency-Keys —
//                                  by the page, or by this worker when the app is closed)
//
// Bump VERSION whenever any file in SHELL changes; the page then offers a one-tap update.

const VERSION = "2.4.0-1";
const SHELL_CACHE = `bookmind-shell-${VERSION}`;
const DATA_CACHE = "bookmind-data-v1";
const AUDIO_CACHE = "bookmind-audio-v1";
const AUDIO_MAX_ENTRIES = 600; // ≈ 30–60 MB of sentences; oldest are dropped first
const SHELL = [
  "/",
  "/css/themes.css",
  "/css/app.css",
  "/fonts/literata-var.woff2",
  "/fonts/literata-var-italic.woff2",
  "/fonts/atkinson-400-normal.woff2",
  "/fonts/atkinson-700-normal.woff2",
  "/fonts/atkinson-400-italic.woff2",
  "/js/prefs-boot.js",
  "/js/app.js",
  "/js/structure.js",
  "/js/insights.js",
  "/js/anchor.js",
  "/js/md.js",
  "/js/net.js",
  "/js/search.js",
  "/js/store.js",
  "/js/sync-core.js",
  "/manifest.webmanifest",
  "/icons/icon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-512.png",
  "/icons/apple-touch-icon.png",
];
const DATA = ["/api/v1/book", "/api/v1/config"];
const SWR_PATHS = new Set(["/api/v1/book", "/api/v1/definitions", "/api/v1/semantic"]);

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    // cache: "reload" bypasses the HTTP cache so a new version never precaches stale files.
    await shell.addAll(SHELL.map((url) => new Request(url, { cache: "reload" })));
    const data = await caches.open(DATA_CACHE);
    await Promise.all(DATA.map(async (url) => {
      try {
        const res = await fetch(url, { cache: "no-cache" });
        if (res.ok) await data.put(url, res);
      } catch { /* offline during install: the page will fetch it later */ }
    }));
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, DATA_CACHE, AUDIO_CACHE]);
    for (const key of await caches.keys()) if (key.startsWith("bookmind-") && !keep.has(key)) await caches.delete(key);
    if (self.registration.navigationPreload) await self.registration.navigationPreload.enable();
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

// Notes sync while the app is closed. The browser wakes this worker for:
//   * "sync" (Background Sync) — once connectivity returns after a note was saved offline. If the
//     promise rejects (server down), the browser retries later with its own backoff.
//   * "periodicsync" (installed PWAs) — occasionally, to push leftovers and pull other devices' notes.
// The worker replays the IndexedDB outbox itself with the same code the page uses (sync-core.js),
// under a Web Lock so an open tab and the worker never replay concurrently. Open tabs are told to
// refresh their notebook afterwards.
importScripts("/js/sync-core.js");

async function backgroundSync({ pull }) {
  const { pushed, changed } = await self.BookMindSync.syncOnce(self.BookMindSync.idbStore, self.BookMindSync.request, { pull });
  if (pushed || changed) {
    for (const c of await self.clients.matchAll({ type: "window" })) c.postMessage({ type: "SYNCED", pushed, changed });
  }
}

self.addEventListener("sync", (event) => {
  if (event.tag !== "bookmind-sync") return;
  event.waitUntil(backgroundSync({ pull: true }));
});

self.addEventListener("periodicsync", (event) => {
  if (event.tag !== "bookmind-refresh") return;
  event.waitUntil(backgroundSync({ pull: true }).catch(() => {})); // periodic: just try again next time
});

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms));
}

async function networkFirstNavigation(event) {
  try {
    const preload = event.preloadResponse ? await event.preloadResponse : null;
    if (preload) return preload;
    const res = await Promise.race([fetch(event.request), timeout(3000)]);
    // Only the app itself is the shell — never cache e.g. /docs under "/".
    if (res.ok && new URL(event.request.url).pathname === "/") (await caches.open(SHELL_CACHE)).put("/", res.clone());
    return res;
  } catch {
    return (await caches.match("/", { cacheName: SHELL_CACHE })) || (await caches.match("/")) || Response.error();
  }
}

async function staleWhileRevalidate(event, cacheName) {
  const cache = await caches.open(cacheName);
  const url = new URL(event.request.url);
  const key = url.pathname; // ignore query/headers so one copy serves every variant
  const cached = await cache.match(key);
  const refresh = fetch(event.request)
    .then((res) => { if (res.ok) cache.put(key, res.clone()); return res; })
    .catch(() => null);
  if (cached) {
    event.waitUntil(refresh);
    return cached;
  }
  return (await refresh) || new Response(JSON.stringify({ detail: "Offline and not cached yet." }), { status: 503, headers: { "Content-Type": "application/json" } });
}

async function cacheFirst(request) {
  const cached = await caches.match(request, { ignoreSearch: true });
  if (cached) return cached;
  const res = await fetch(request);
  if (res.ok && res.type === "basic") (await caches.open(SHELL_CACHE)).put(request, res.clone());
  return res;
}

async function cachedAudio(event) {
  const cache = await caches.open(AUDIO_CACHE);
  const hit = await cache.match(event.request);
  if (hit) return hit;
  const res = await fetch(event.request);
  if (res.ok) {
    event.waitUntil((async () => {
      await cache.put(event.request, res.clone());
      const keys = await cache.keys(); // insertion order: oldest first
      for (const k of keys.slice(0, Math.max(0, keys.length - AUDIO_MAX_ENTRIES))) await cache.delete(k);
    })());
  }
  return res;
}

async function networkThenCache(request) {
  try {
    const res = await fetch(request);
    if (res.ok) { const copy = res.clone(); caches.open(DATA_CACHE).then((c) => c.put(request.url, copy)); }
    return res;
  } catch {
    return (await caches.match(request.url, { cacheName: DATA_CACHE })) || Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // mutations go straight to the network
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    if (url.pathname === "/") event.respondWith(networkFirstNavigation(event));
    return;
  }
  if (SWR_PATHS.has(url.pathname)) { event.respondWith(staleWhileRevalidate(event, DATA_CACHE)); return; }
  if (url.pathname === "/api/v1/config") {
    event.respondWith(fetch(request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(DATA_CACHE).then((c) => c.put("/api/v1/config", copy)); }
      return res;
    }).catch(async () => (await caches.match("/api/v1/config")) || Response.error()));
    return;
  }
  if (url.pathname === "/api/v1/tts") { event.respondWith(cachedAudio(event)); return; }
  if (url.pathname === "/api/v1/tts/voices") { event.respondWith(networkThenCache(request)); return; }
  if (url.pathname.startsWith("/api/") || ["/healthz", "/readyz", "/metrics"].includes(url.pathname)) return;
  event.respondWith(cacheFirst(request));
});
