// SPDX-License-Identifier: AGPL-3.0-or-later
// BookMind reader — offline-first PWA front end.

import { api, HttpError, SyncEngine } from "./net.js";
import { escapeHtml, renderMD } from "./md.js";
import { excerpt, extractiveAnswer, searchNotes, searchPassages, tokenize } from "./search.js";
import * as store from "./store.js";

const $ = (id) => document.getElementById(id);
const mq = { nav: matchMedia("(min-width: 1024px)"), panel: matchMedia("(min-width: 1280px)"), coarse: matchMedia("(pointer: coarse)") };

const state = {
  chunks: [], docs: [], byId: {}, order: [],
  doc: null, idx: 0,
  notes: [],
  flags: { research_enabled: true, simplify_enabled: true, llm_enabled: true, notes_search_enabled: true },
  limits: { max_selection_chars: 2000, max_context_chars: 6000 },
  selection: "", selectionSentence: 0,
  returnTo: null,
};
let sync;

/* =========================================================== utilities */

let toastTimer;
function toast(msg, ms = 2600) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), ms);
}
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const rand = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, "0")).join("");
const timeAgo = (ms) => {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
};

/* =========================================================== book loading */

async function loadBook() {
  // The service worker answers this from cache when offline (and precaches it on install).
  const book = await api("/api/v1/book", { timeout: 20000 });
  state.chunks = book.chunks;
  state.docs = book.docs;
  state.order = book.docs.map((d) => d.id);
  state.byId = {};
  for (const d of book.docs) state.byId[d.id] = { ...d, chunks: book.chunks.filter((c) => c.doc === d.id) };
}

const DOC = () => state.byId[state.doc];
const docByShort = (short) => state.docs.find((d) => d.short.toLowerCase() === String(short).toLowerCase());

/* =========================================================== reader */

function splitSentences(text) {
  const paras = text.split(/\n{2,}|\n(?=[A-Z(])/).map((p) => p.trim()).filter(Boolean);
  return paras.map((p) => (p.match(/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g) || [p]).map((s) => s.trim()).filter(Boolean));
}

function renderPage({ keepSpeech = false } = {}) {
  const d = DOC();
  const c = d.chunks[state.idx];
  $("pageDoc").textContent = d.title;
  $("pageNo").textContent = `Page ${state.idx + 1} of ${d.chunks.length} · ~${Math.max(1, Math.round((c.words || 200) / 220))} min read`;
  $("brandSub").textContent = `${d.short} · page ${state.idx + 1}`;
  $("pageInput").value = state.idx + 1;
  $("pageInput").max = d.chunks.length;
  $("pageTotal").textContent = `of ${d.chunks.length}`;

  const body = $("pageBody");
  body.textContent = "";
  let si = 0;
  for (const sents of splitSentences(c.text)) {
    const p = document.createElement("p");
    for (const s of sents) {
      const span = document.createElement("span");
      span.className = "sentence";
      span.dataset.si = String(si++);
      span.textContent = s + " ";
      p.appendChild(span);
    }
    body.appendChild(p);
  }
  const di = state.order.indexOf(state.doc);
  $("prevBtn").disabled = state.idx === 0 && di === 0;
  $("nextBtn").disabled = state.idx === d.chunks.length - 1 && di === state.order.length - 1;
  $("readerScroll").scrollTop = 0;

  store.prefs.set("pos", { doc: state.doc, idx: state.idx });
  const progress = store.prefs.get("progress", {});
  if ((progress[state.doc] ?? -1) < state.idx) { progress[state.doc] = state.idx; store.prefs.set("progress", progress); }
  renderNav();
  if (!keepSpeech) { tts.stop(); setStatus("Press play to hear this page."); }
  else tts.updateMedia();
}

function goTo(docId, idx, opts = {}) {
  if (!state.byId[docId]) return;
  if (opts.jump && state.doc && (docId !== state.doc || Math.abs(idx - state.idx) > 1)) {
    state.returnTo = { doc: state.doc, idx: state.idx };
  }
  state.doc = docId;
  state.idx = Math.max(0, Math.min(idx, state.byId[docId].chunks.length - 1));
  renderPage(opts);
}

function nextPage(opts) {
  const d = DOC();
  if (state.idx < d.chunks.length - 1) { goTo(state.doc, state.idx + 1, opts); return true; }
  const di = state.order.indexOf(state.doc);
  if (di < state.order.length - 1) { goTo(state.order[di + 1], 0, opts); return true; }
  return false;
}

function prevPage() {
  if (state.idx > 0) return goTo(state.doc, state.idx - 1);
  const di = state.order.indexOf(state.doc);
  if (di > 0) { const pd = state.byId[state.order[di - 1]]; goTo(pd.id, pd.chunks.length - 1); }
}

function highlightQuery(q) {
  const qt = new Set(tokenize(q));
  if (!qt.size) return;
  const need = Math.min(2, qt.size);
  let first = null;
  for (const span of $("pageBody").querySelectorAll(".sentence")) {
    const hits = tokenize(span.textContent).filter((w) => qt.has(w));
    if (new Set(hits).size >= need) { span.classList.add("hit"); first = first || span; }
  }
  if (first) first.scrollIntoView({ block: "center" });
}

/* =========================================================== navigation drawer */

function renderNav() {
  const list = $("docList");
  list.textContent = "";
  const progress = store.prefs.get("progress", {});
  for (const d of state.docs) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "doclink" + (d.id === state.doc ? " active" : "");
    const read = Math.min(100, Math.round((((progress[d.id] ?? -1) + 1) / d.pages) * 100));
    btn.innerHTML = `${escapeHtml(d.title)}<span class="meta"><span>${d.pages} pages</span><span>${read}% read</span></span><span class="progress"><span></span></span>`;
    btn.querySelector(".progress > span").style.width = read + "%";
    btn.addEventListener("click", () => {
      const pos = store.prefs.get("docpos", {});
      goTo(d.id, d.id === state.doc ? state.idx : (pos[d.id] ?? 0), { jump: true });
      if (!mq.nav.matches) closeNav();
    });
    if (d.id === state.doc) btn.setAttribute("aria-current", "true");
    list.appendChild(btn);
  }
  const docpos = store.prefs.get("docpos", {});
  if (state.doc) { docpos[state.doc] = state.idx; store.prefs.set("docpos", docpos); }

  const card = $("resumeCard");
  card.textContent = "";
  const r = state.returnTo;
  if (r && state.byId[r.doc] && !(r.doc === state.doc && r.idx === state.idx)) {
    const div = document.createElement("div");
    div.className = "resume-card";
    div.innerHTML = `Go back to<strong>${escapeHtml(state.byId[r.doc].short)}, page ${r.idx + 1}</strong>`;
    const b = document.createElement("button");
    b.type = "button"; b.className = "btn small"; b.textContent = "Return";
    b.addEventListener("click", () => { const t = state.returnTo; state.returnTo = null; goTo(t.doc, t.idx); if (!mq.nav.matches) closeNav(); });
    div.appendChild(b);
    card.appendChild(div);
  }
}

function setDrawer(el, btn, scrim, open, wide) {
  el.classList.toggle("open", open);
  btn.setAttribute("aria-expanded", String(open));
  scrim.classList.toggle("show", open && !wide);
}
const openNav = () => setDrawer($("nav"), $("navToggle"), $("navScrim"), true, mq.nav.matches);
const closeNav = () => setDrawer($("nav"), $("navToggle"), $("navScrim"), false, mq.nav.matches);
function openNotebook() {
  setDrawer($("notebook"), $("notebookBtn"), $("panelScrim"), true, mq.panel.matches);
  if (!mq.nav.matches) closeNav();
}
const closeNotebook = () => setDrawer($("notebook"), $("notebookBtn"), $("panelScrim"), false, mq.panel.matches);

/* =========================================================== read aloud (Web Speech API) */

const tts = {
  supported: "speechSynthesis" in window,
  voices: [], playing: false, index: 0, gen: 0, wakeLock: null,

  loadVoices() {
    if (!this.supported) return;
    this.voices = speechSynthesis.getVoices();
    const saved = store.prefs.get("voice");
    for (const sel of [$("voiceSelect"), $("voiceSelectM")]) {
      sel.textContent = "";
      if (!this.voices.length) { sel.add(new Option("Default voice", "")); continue; }
      const sorted = [...this.voices].sort((a, b) => (b.lang.startsWith("en") - a.lang.startsWith("en")) || a.name.localeCompare(b.name));
      for (const v of sorted) sel.add(new Option(`${v.name} (${v.lang})`, v.voiceURI));
      const match = this.voices.find((v) => v.voiceURI === saved) || this.voices.find((v) => /^en[-_](KE|GB)/i.test(v.lang)) || this.voices.find((v) => v.lang.startsWith("en")) || this.voices[0];
      if (match) sel.value = match.voiceURI;
    }
  },
  voice() { return this.voices.find((v) => v.voiceURI === $("voiceSelect").value); },
  spans() { return $("pageBody").querySelectorAll(".sentence"); },

  speakFrom(i) {
    if (!this.supported) { toast("Read-aloud isn't supported in this browser."); return; }
    const spans = this.spans();
    if (i >= spans.length) {
      setStatus("Turning the page…");
      if (nextPage({ keepSpeech: true })) setTimeout(() => this.playing && this.speakFrom(0), 250);
      else this.stop("Finished — that's the end of the documents.");
      return;
    }
    const gen = ++this.gen;
    this.index = i;
    spans.forEach((s, k) => { s.classList.toggle("spoken", k < i); s.classList.remove("reading"); });
    const span = spans[i];
    span.classList.add("reading");
    if (!isElementVisible(span)) span.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    const u = new SpeechSynthesisUtterance(span.textContent);
    const v = this.voice();
    if (v) { u.voice = v; u.lang = v.lang; }
    u.rate = parseFloat($("rateRange").value) || 1;
    const next = () => { if (gen === this.gen && this.playing) this.speakFrom(i + 1); };
    u.onend = next;
    u.onerror = (e) => { if (e.error !== "interrupted" && e.error !== "canceled") next(); };
    setStatus(`Reading ${DOC().short}, page ${state.idx + 1}`);
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  },
  play(from = this.index) {
    this.playing = true;
    setPlayIcon(true);
    this.acquireWakeLock();
    this.updateMedia();
    this.speakFrom(from);
  },
  // Pause = cancel + remember the sentence. Native pause()/resume() is unreliable on Android and
  // some desktop engines; restarting at the current sentence works everywhere.
  pause() {
    this.playing = false; this.gen++;
    if (this.supported) speechSynthesis.cancel();
    setPlayIcon(false);
    setStatus("Paused — press play to continue from the highlighted sentence.");
    this.releaseWakeLock();
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
  },
  stop(msg) {
    const was = this.playing;
    this.playing = false; this.gen++; this.index = 0;
    if (this.supported) speechSynthesis.cancel();
    setPlayIcon(false);
    this.spans().forEach((s) => s.classList.remove("reading", "spoken"));
    if (msg || was) setStatus(msg || "Press play to hear this page.");
    this.releaseWakeLock();
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "none";
  },
  toggle() { this.playing ? this.pause() : this.play(); },
  updateMedia() {
    if (!("mediaSession" in navigator) || !state.doc) return;
    navigator.mediaSession.metadata = new MediaMetadata({ title: `${DOC().short} — page ${state.idx + 1}`, artist: "BookMind", album: DOC().title, artwork: [{ src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" }] });
    navigator.mediaSession.playbackState = this.playing ? "playing" : "paused";
  },
  async acquireWakeLock() {
    try { if ("wakeLock" in navigator && !this.wakeLock) { this.wakeLock = await navigator.wakeLock.request("screen"); this.wakeLock.addEventListener("release", () => { this.wakeLock = null; }); } } catch { /* not allowed: fine */ }
  },
  releaseWakeLock() { try { this.wakeLock && this.wakeLock.release(); } catch { /* ignore */ } this.wakeLock = null; },
};

function isElementVisible(el) {
  const r = el.getBoundingClientRect();
  const top = $("readerScroll").getBoundingClientRect().top + 20;
  return r.top >= top && r.bottom <= window.innerHeight - 90;
}
const setStatus = (t) => { $("audioStatus").textContent = t; };
const setPlayIcon = (playing) => {
  $("playIcon").setAttribute("href", playing ? "#i-pause" : "#i-play");
  $("playBtn").setAttribute("aria-label", playing ? "Pause reading" : "Read this page aloud");
};

/* =========================================================== selection → actions */

const toolbar = $("selToolbar");
function hideToolbar() { toolbar.classList.remove("show"); }

const onSelection = debounce(() => {
  const sel = getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount || !$("pageBody").contains(sel.anchorNode)) { hideToolbar(); return; }
  const text = sel.toString().replace(/\s+/g, " ").trim();
  if (text.length < 3) { hideToolbar(); return; }
  state.selection = text;
  const anchor = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement;
  const span = anchor && anchor.closest(".sentence");
  state.selectionSentence = span ? Number(span.dataset.si) : 0;
  $("btnResearch").hidden = !state.flags.research_enabled;
  $("btnSimplify").hidden = !state.flags.simplify_enabled;

  const rect = sel.getRangeAt(0).getBoundingClientRect();
  toolbar.classList.add("show");
  const tw = toolbar.offsetWidth, th = toolbar.offsetHeight;
  const topLimit = $("readerScroll").getBoundingClientRect().top + 6;
  // Touch devices draw their own copy/paste menu above the selection, so go below it there.
  let top = mq.coarse.matches ? rect.bottom + 14 : rect.top - th - 10;
  if (top < topLimit) top = rect.bottom + 14;
  if (top + th > window.innerHeight - 80) top = Math.max(topLimit, rect.top - th - 10);
  const left = Math.min(window.innerWidth - tw - 8, Math.max(8, rect.left + rect.width / 2 - tw / 2));
  toolbar.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}, 120);

/* =========================================================== research */

const toServer = (n) => ({
  doc: n.doc, doc_short: n.doc_short, page: n.page, mode: n.mode, selection: n.selection, answer: n.answer,
  status: n.status, model: n.model, source: n.source, related: (n.related || []).slice(0, 20), created_at: n.created_at, updated_at: n.updated_at,
});
async function queuePut(note) {
  await store.enqueue({ op: "put", id: note.id, payload: toServer(note) });
  requestBackgroundSync();
}
function requestBackgroundSync() {
  // Where supported, the browser wakes the service worker when connectivity returns, and it
  // tells any open tab to flush the outbox.
  navigator.serviceWorker?.ready.then((reg) => reg.sync && reg.sync.register("bookmind-sync")).catch(() => {});
}

async function research(mode) {
  let selection = state.selection;
  hideToolbar();
  getSelection()?.removeAllRanges();
  if (!selection) return;
  if (selection.length > state.limits.max_selection_chars) {
    selection = selection.slice(0, state.limits.max_selection_chars);
    toast("That's a long selection — using the first part.");
  }
  const d = DOC();
  const c = d.chunks[state.idx];
  const now = Date.now();
  const note = {
    id: `n${now.toString(36)}${rand()}`, doc: d.id, doc_short: d.short, page: state.idx + 1, mode, selection,
    answer: "", status: "pending", model: null, source: null, related: [], created_at: now, updated_at: now, synced: false,
  };
  state.notes.unshift(note);
  renderNotes();
  openNotebook();

  const offline = (reason) => {
    Object.assign(note, extractiveAnswer(mode, selection, state.chunks, reason, c.id), { status: "done", updated_at: Date.now(), synced: false, reason });
  };
  if (!navigator.onLine) offline("you're offline");
  else {
    try {
      const res = await api("/api/v1/research", {
        method: "POST",
        timeout: 180000,
        idempotencyKey: note.id,
        body: {
          mode, selection, doc: d.id, doc_title: d.title, doc_short: d.short, page: state.idx + 1,
          context_text: c.text.slice(0, state.limits.max_context_chars), chunk_id: c.id, save: true, note_id: note.id,
        },
      });
      Object.assign(note, {
        answer: res.answer, model: res.model, source: res.source, related: res.related || [], reason: res.reason,
        status: "done", updated_at: (res.note && res.note.updated_at) || Date.now(), synced: !!res.saved,
      });
    } catch (err) {
      if (err instanceof HttpError && err.status === 403) {
        Object.assign(note, { status: "error", answer: err.message, updated_at: Date.now() });
      } else if (err instanceof HttpError && err.status === 429) {
        offline("request limit reached — try again in a minute");
      } else {
        offline(err instanceof HttpError ? "research service unavailable" : "server unreachable");
      }
    }
  }
  if (note.status === "error") {
    state.notes = state.notes.filter((n) => n !== note);
    toast(note.answer || "That action is switched off right now.");
    renderNotes();
    return;
  }
  await store.putNote(note);
  if (!note.synced) await queuePut(note);
  renderNotes();
  sync.schedule(400);
}

/* =========================================================== notebook */

function sourceTags(n) {
  const tags = [];
  if (n.source === "model") tags.push(`<span class="tag">${escapeHtml(n.model || "local model")}</span>`);
  else if (n.source === "extractive") tags.push('<span class="tag warn">Extractive</span>');
  else if (n.source === "offline") tags.push('<span class="tag warn">Offline</span>');
  if (!n.synced && n.status === "done") tags.push('<span class="tag">Not synced</span>');
  return tags.join("");
}

function renderNotes() {
  const list = $("notesList");
  const count = state.notes.length;
  $("noteCount").hidden = !count;
  $("noteCount").textContent = count > 99 ? "99+" : String(count);
  $("exportBtn").disabled = !count;
  if (!count) {
    list.innerHTML = '<div class="empty">Select any passage in the book and choose <strong>Research</strong> or <strong>Simplify</strong>. Cited notes collect here — on this device first, then synced to your server.<br><br>No connection? You still get a grounded note quoted from the documents.</div>';
    return;
  }
  list.textContent = "";
  for (const n of state.notes) {
    const card = document.createElement("article");
    card.className = "note" + (n.mode === "simplify" ? " simplify" : "");
    card.id = "note-" + n.id;
    let html = `<div class="cite"><a href="#" class="goto">${escapeHtml(n.doc_short)}, p.${n.page}</a> · ${n.mode === "simplify" ? "Simplified" : "Research"} ${sourceTags(n)}</div>`;
    html += `<blockquote>${escapeHtml(excerpt(n.selection, 240))}</blockquote>`;
    if (n.status === "pending") html += '<div class="thinking"><span class="spinner"></span> Reading across the documents…</div>';
    else html += `<div class="answer">${renderMD(n.answer)}</div>`;
    html += `<div class="row"><span>${timeAgo(n.created_at || Date.now())}</span><button type="button" class="linkbtn remove">Remove</button></div>`;
    card.innerHTML = html;
    card.querySelector(".goto").addEventListener("click", (e) => {
      e.preventDefault();
      goTo(n.doc, n.page - 1, { jump: true });
      highlightQuery(n.selection);
      if (!mq.panel.matches) closeNotebook();
    });
    card.querySelector(".remove").addEventListener("click", () => removeNote(n));
    list.appendChild(card);
  }
}

async function removeNote(n) {
  state.notes = state.notes.filter((x) => x.id !== n.id);
  renderNotes();
  await store.deleteNote(n.id);
  await store.enqueue({ op: "delete", id: n.id, updated_at: Math.max(Date.now(), (n.updated_at || 0) + 1) });
  requestBackgroundSync();
  sync.schedule(300);
  toast("Note removed.");
}

function exportNotes() {
  let md = "# BookMind research notebook\n\n";
  for (const n of [...state.notes].reverse()) {
    if (n.status !== "done") continue;
    md += `## ${n.mode === "simplify" ? "Simplified" : "Research"} — ${n.doc_short}, p.${n.page}\n\n`;
    md += `> ${n.selection.replace(/\n/g, " ")}\n\n${n.answer}\n\n---\n\n`;
  }
  const url = URL.createObjectURL(new Blob([md], { type: "text/markdown" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: "bookmind-notebook.md" });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast("Notebook exported.");
}

async function reloadNotes() {
  state.notes = await store.allNotes();
  renderNotes();
}

/* =========================================================== search */

let searchSeq = 0;
const runSearch = debounce(async (q) => {
  const seq = ++searchSeq;
  const results = $("searchResults");
  if (q.trim().length < 2) { results.textContent = ""; $("searchMeta").textContent = "Type at least two letters."; return; }
  let passages, notes, where = "online";
  if (navigator.onLine) {
    try {
      const res = await api(`/api/v1/search?q=${encodeURIComponent(q)}&k=10`, { timeout: 5000 });
      passages = res.passages;
      notes = res.notes;
      if (res.partial) where = "partial";
    } catch { where = "offline"; }
  } else where = "offline";
  if (!passages || where === "offline") passages = searchPassages(state.chunks, q, 10);
  // Unsynced local notes aren't in the server's read model yet — always search them locally too.
  const local = searchNotes(state.notes, q, 10);
  const seen = new Set((notes || []).map((n) => n.id));
  notes = [...(notes || []).filter((n) => state.notes.some((x) => x.id === n.id)), ...local.filter((n) => !seen.has(n.id))];
  if (seq !== searchSeq) return;

  $("searchMeta").textContent = `${passages.length} passage${passages.length === 1 ? "" : "s"}, ${notes.length} note${notes.length === 1 ? "" : "s"}` +
    (where === "offline" ? " · searched on this device (offline)" : where === "partial" ? " · some results unavailable" : "");
  results.textContent = "";
  const group = (title, items, render) => {
    if (!items.length) return;
    const h = document.createElement("h3"); h.textContent = title; results.appendChild(h);
    for (const it of items) results.appendChild(render(it));
  };
  group("In the documents", passages, (p) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "result";
    b.innerHTML = `<div class="where">${escapeHtml(p.docShort)} · page ${p.page}</div><div class="snippet">${escapeHtml(p.snippet)}</div>`;
    b.addEventListener("click", () => { closeSearch(); goTo(p.doc, p.page - 1, { jump: true }); highlightQuery(q); });
    return b;
  });
  group("In your notebook", notes, (n) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "result";
    b.innerHTML = `<div class="where">${escapeHtml(n.docShort || n.doc)} · p.${n.page} · ${n.mode === "simplify" ? "Simplified" : "Research"}</div><div class="snippet">${escapeHtml(n.selection)}</div>`;
    b.addEventListener("click", () => {
      closeSearch(); openNotebook();
      const el = document.getElementById("note-" + n.id);
      if (el) el.scrollIntoView({ block: "start" });
    });
    return b;
  });
  if (!passages.length && !notes.length) results.innerHTML = '<div class="empty">Nothing found. Try a different word or a clause number.</div>';
}, 220);

function openSearch() {
  $("searchDialog").hidden = false;
  $("searchInput").focus();
  $("searchInput").select();
}
function closeSearch() { $("searchDialog").hidden = true; $("searchBtn").focus({ preventScroll: true }); }

/* =========================================================== connectivity, config, status */

async function updateNetChip(pending) {
  if (pending === undefined) pending = await sync.pending();
  const chip = $("netChip");
  chip.classList.toggle("offline", !navigator.onLine);
  if (!navigator.onLine) { chip.hidden = false; $("netText").textContent = pending ? `Offline · ${pending} to sync` : "Offline"; return; }
  chip.hidden = !pending;
  $("netText").textContent = `${pending} to sync`;
}

async function loadConfig() {
  let cfg = store.prefs.get("config");
  try { cfg = await api("/api/v1/config", { timeout: 5000 }); store.prefs.set("config", cfg); } catch { /* use last known */ }
  if (!cfg) return;
  Object.assign(state.flags, cfg.flags || {});
  Object.assign(state.limits, cfg.limits || {});
  const msg = cfg.maintenance_message;
  if (msg && store.prefs.get("dismissed_notice") !== msg) {
    $("noticeText").textContent = msg;
    $("noticeBanner").hidden = false;
  }
}

async function refreshStatus() {
  const ul = $("serviceList");
  const row = (name, st, label) => `<li><span>${escapeHtml(name)}</span><span class="st-${st}">${escapeHtml(label || st)}</span></li>`;
  if (!navigator.onLine) { ul.innerHTML = row("Network", "offline", "offline — reading from this device"); return; }
  try {
    const s = await api("/api/v1/status", { timeout: 6000 });
    let html = Object.entries(s.services).map(([n, st]) => row(n, st)).join("");
    if (s.model) html += row("model", s.model.reachable && s.model.model_installed !== false ? "ready" : "degraded", s.model.reachable ? s.model.configured_model : "not running");
    ul.innerHTML = html;
  } catch {
    ul.innerHTML = row("Server", "unavailable", "unreachable — offline mode");
  }
}

/* =========================================================== service worker & install */

let userRequestedReload = false;
async function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    const showUpdate = (worker) => {
      $("updateBanner").hidden = false;
      $("updateBtn").onclick = () => { userRequestedReload = true; worker.postMessage({ type: "SKIP_WAITING" }); };
    };
    if (reg.waiting && navigator.serviceWorker.controller) showUpdate(reg.waiting);
    reg.addEventListener("updatefound", () => {
      const w = reg.installing;
      w && w.addEventListener("statechange", () => { if (w.state === "installed" && navigator.serviceWorker.controller) showUpdate(w); });
    });
    navigator.serviceWorker.addEventListener("controllerchange", () => { if (userRequestedReload) location.reload(); });
    navigator.serviceWorker.addEventListener("message", (e) => { if (e.data && e.data.type === "SYNC") sync && sync.run(); });
    setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
  } catch (err) {
    console.warn("Service worker unavailable (needs HTTPS or localhost):", err);
  }
}

let installEvent = null;
addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvent = e; $("installBtn").hidden = false; });
addEventListener("appinstalled", () => { $("installBtn").hidden = true; toast("BookMind installed."); });

/* =========================================================== theme & text size */

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  const dark = theme ? theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  $("themeIcon").setAttribute("href", dark ? "#i-sun" : "#i-moon");
  document.querySelector('meta[name="theme-color"]').content = dark ? "#150a06" : "#1e0f0a";
}
function applySize(px) {
  document.documentElement.style.setProperty("--reader-size", px + "px");
  $("sizeRange").value = px; $("sizeRangeM").value = px;
}

/* =========================================================== wiring */

function wire() {
  $("prevBtn").addEventListener("click", prevPage);
  $("nextBtn").addEventListener("click", () => nextPage());
  $("pageInput").addEventListener("change", (e) => { const n = parseInt(e.target.value, 10); if (n) goTo(state.doc, n - 1, { jump: true }); });

  $("navToggle").addEventListener("click", () => ($("nav").classList.contains("open") ? closeNav() : openNav()));
  $("navScrim").addEventListener("click", closeNav);
  $("notebookBtn").addEventListener("click", () => ($("notebook").classList.contains("open") ? closeNotebook() : openNotebook()));
  $("notebookClose").addEventListener("click", closeNotebook);
  $("panelScrim").addEventListener("click", closeNotebook);
  mq.nav.addEventListener("change", (e) => { e.matches ? openNav() : closeNav(); });
  mq.panel.addEventListener("change", () => { if ($("notebook").classList.contains("open")) openNotebook(); });

  $("themeBtn").addEventListener("click", () => {
    const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = cur === "dark" ? "light" : "dark";
    store.prefs.set("theme", next);
    applyTheme(next);
  });

  // Read aloud
  $("playBtn").addEventListener("click", () => tts.toggle());
  tts.loadVoices();
  if (tts.supported) speechSynthesis.onvoiceschanged = () => tts.loadVoices(); // voices load async on most browsers
  const syncControl = (a, b, key, apply) => {
    for (const [src, dst] of [[a, b], [b, a]]) {
      $(src).addEventListener("input", () => { $(dst).value = $(src).value; store.prefs.set(key, $(src).value); apply && apply($(src).value); });
    }
  };
  syncControl("rateRange", "rateRangeM", "rate", () => tts.playing && tts.play(tts.index));
  syncControl("sizeRange", "sizeRangeM", "size", (v) => applySize(v));
  for (const id of ["voiceSelect", "voiceSelectM"]) $(id).addEventListener("change", () => { const v = $(id).value; $("voiceSelect").value = v; $("voiceSelectM").value = v; store.prefs.set("voice", v); if (tts.playing) tts.play(tts.index); });
  $("rateRange").value = $("rateRangeM").value = store.prefs.get("rate", 1);
  $("audioMore").addEventListener("click", () => {
    const pop = $("audioPopover");
    pop.hidden = !pop.hidden;
    $("audioMore").setAttribute("aria-expanded", String(!pop.hidden));
  });
  if ("mediaSession" in navigator) {
    const ms = navigator.mediaSession;
    ms.setActionHandler("play", () => tts.play());
    ms.setActionHandler("pause", () => tts.pause());
    ms.setActionHandler("nexttrack", () => { nextPage({ keepSpeech: tts.playing }); if (tts.playing) tts.play(0); });
    ms.setActionHandler("previoustrack", () => { prevPage(); });
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") { if (tts.playing) tts.acquireWakeLock(); sync.run(); }
  });

  // Selection toolbar
  document.addEventListener("selectionchange", onSelection);
  toolbar.addEventListener("mousedown", (e) => e.preventDefault()); // keep the selection alive
  $("btnResearch").addEventListener("click", () => research("research"));
  $("btnSimplify").addEventListener("click", () => research("simplify"));
  $("btnReadHere").addEventListener("click", () => { const i = state.selectionSentence; hideToolbar(); getSelection()?.removeAllRanges(); tts.play(i); });
  $("readerScroll").addEventListener("scroll", () => { if (!mq.coarse.matches) hideToolbar(); else onSelection(); }, { passive: true });
  $("pageBody").addEventListener("click", (e) => {
    // Tap a sentence while listening to jump the voice there.
    const span = e.target.closest(".sentence");
    if (span && tts.playing && getSelection().isCollapsed) tts.play(Number(span.dataset.si));
  });

  // Swipe between pages on touch screens.
  let touch = null;
  $("readerScroll").addEventListener("touchstart", (e) => { if (e.touches.length === 1) touch = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() }; }, { passive: true });
  $("readerScroll").addEventListener("touchend", (e) => {
    if (!touch) return;
    const dx = e.changedTouches[0].clientX - touch.x, dy = e.changedTouches[0].clientY - touch.y, dt = Date.now() - touch.t;
    touch = null;
    if (dt < 600 && Math.abs(dx) > 70 && Math.abs(dy) < 45 && getSelection().isCollapsed) (dx < 0 ? nextPage() : prevPage());
  }, { passive: true });

  // Notebook
  $("exportBtn").addEventListener("click", exportNotes);
  $("syncBtn").addEventListener("click", async () => {
    if (!navigator.onLine) { toast("You're offline — notes will sync when you reconnect."); return; }
    await sync.run();
    toast((await sync.pending()) ? "Some notes couldn't sync yet — will retry." : "Notebook is up to date.");
  });
  $("notesList").addEventListener("click", (e) => {
    const ref = e.target.closest("a.ref");
    if (!ref) return;
    e.preventDefault();
    const d = docByShort(ref.dataset.short);
    if (!d) return;
    goTo(d.id, parseInt(ref.dataset.page, 10) - 1, { jump: true });
    if (!mq.panel.matches) closeNotebook();
  });

  // Search
  $("searchBtn").addEventListener("click", openSearch);
  $("searchClose").addEventListener("click", closeSearch);
  $("searchDialog").addEventListener("click", (e) => { if (e.target === $("searchDialog")) closeSearch(); });
  $("searchInput").addEventListener("input", (e) => runSearch(e.target.value));

  // Banners / install
  $("noticeClose").addEventListener("click", () => { store.prefs.set("dismissed_notice", $("noticeText").textContent); $("noticeBanner").hidden = true; });
  $("installBtn").addEventListener("click", async () => { if (!installEvent) return; installEvent.prompt(); await installEvent.userChoice; installEvent = null; $("installBtn").hidden = true; });

  // Connectivity
  addEventListener("online", () => { toast("Back online — syncing."); updateNetChip(); sync.run(); refreshStatus(); loadConfig(); });
  addEventListener("offline", () => { toast("You're offline. Reading, search and notes keep working."); updateNetChip(); refreshStatus(); });

  // Keyboard
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!$("searchDialog").hidden) return closeSearch();
      if (!$("audioPopover").hidden) { $("audioPopover").hidden = true; return; }
      hideToolbar();
      if (!mq.panel.matches) closeNotebook();
      if (!mq.nav.matches) closeNav();
      return;
    }
    const tag = document.activeElement && document.activeElement.tagName;
    if (["INPUT", "SELECT", "TEXTAREA"].includes(tag) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (!$("searchDialog").hidden) return;
    if (e.key === "ArrowRight") nextPage();
    else if (e.key === "ArrowLeft") prevPage();
    else if (e.key === " " && tag !== "BUTTON") { e.preventDefault(); tts.toggle(); }
    else if (e.key === "/") { e.preventDefault(); openSearch(); }
    else if (e.key === "n") $("notebookBtn").click();
  });
}

/* =========================================================== boot */

async function boot() {
  applyTheme(store.prefs.get("theme"));
  applySize(store.prefs.get("size", 18));
  registerSW();
  store.requestPersistence();
  try {
    await loadBook();
  } catch (err) {
    $("bootMsg").textContent = navigator.onLine
      ? "The server didn't respond. If you're running BookMind yourself, start it with “python -m bookmind”."
      : "You're offline and this device hasn't saved a copy of the book yet. Open BookMind once while online and it will work offline from then on.";
    $("boot").hidden = false;
    $("bootRetry").onclick = () => location.reload();
    return;
  }
  sync = new SyncEngine({ onChange: reloadNotes, onStatus: (n) => updateNetChip(n) });
  const pos = store.prefs.get("pos");
  if (pos && state.byId[pos.doc]) { state.doc = pos.doc; state.idx = pos.idx; } else state.doc = state.order[0];
  wire();
  if (mq.nav.matches) openNav();
  renderPage();
  if (pos) setStatus(`Welcome back — ${DOC().short}, page ${state.idx + 1}. Press play to listen.`);
  await reloadNotes();
  updateNetChip();
  loadConfig();
  refreshStatus();
  sync.run();
  setInterval(() => navigator.onLine && sync.run(), 60000);
  setInterval(refreshStatus, 60000);
}

boot();
