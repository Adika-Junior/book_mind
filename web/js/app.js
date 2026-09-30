// SPDX-License-Identifier: AGPL-3.0-or-later
// BookMind reader — offline-first PWA front end.

import { api, HttpError, SyncEngine } from "./net.js";
import { escapeHtml, renderMD } from "./md.js";
import { definitions, excerpt, extractiveAnswer, searchNotes, searchPassages, tokenize } from "./search.js";
import { buildOutline, nextHeading, sectionAt, structure } from "./structure.js";
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

const WPM = 230; // typical adult silent reading rate for non-fiction (Brysbaert 2019: ~238)
const outlines = {};
const outlineOf = (docId) => (outlines[docId] ||= buildOutline(state.byId[docId].chunks, docId));
const sentencesOf = (text) => (text.match(/[^.!?]+[.!?]+["”’)]?(\s+|$)|[^.!?]+$/g) || [text]).map((s) => s.trim()).filter(Boolean);
const minutes = (words) => Math.max(1, Math.round(words / WPM));

/* Defined terms from the Bill's interpretation clause, signalled on first use per page. */
let termRe = null;
const termByLower = new Map();
function termRegex() {
  if (termRe !== null) return termRe;
  const defs = definitions(state.chunks).filter((d) => d.term.length >= 4);
  defs.forEach((d) => termByLower.set(d.term.toLowerCase(), d));
  const alts = defs.map((d) => d.term).sort((a, b) => b.length - a.length).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  termRe = alts.length ? new RegExp(`\\b(${alts.join("|")})\\b`, "gi") : false;
  return termRe;
}

function appendWithTerms(target, text, seen) {
  const re = termRegex();
  if (!re) { target.append(text); return; }
  let last = 0, m;
  re.lastIndex = 0;
  while ((m = re.exec(text))) {
    const def = termByLower.get(m[0].toLowerCase());
    const onOwnPage = def && def.doc === state.doc && def.page === state.idx + 1;
    // Capitalised defined terms ("Office", "Commissioner") only match their capitalised use.
    if (!def || onOwnPage || seen.has(def.term) || (/[A-Z]/.test(def.term[0]) && !/[A-Z]/.test(m[0][0]))) continue;
    seen.add(def.term);
    target.append(text.slice(last, m.index));
    // An inline link (not a <button>) so a multi-word term can wrap across lines like normal text.
    const b = document.createElement("a");
    b.href = "#";
    b.setAttribute("role", "button");
    b.className = "term";
    b.textContent = m[0];
    b.dataset.term = def.term;
    b.setAttribute("aria-haspopup", "dialog");
    b.setAttribute("aria-expanded", "false");
    b.title = "Defined term — tap for the Bill's definition";
    target.append(b);
    last = m.index + m[0].length;
  }
  target.append(text.slice(last));
}

function appendSentences(el, text, counter, seen) {
  for (const s of sentencesOf(text)) {
    const span = document.createElement("span");
    span.className = "sentence";
    span.dataset.si = String(counter.n++);
    appendWithTerms(span, s + " ", seen);
    el.appendChild(span);
  }
}

function renderBlocks(body, chunk, docId) {
  body.textContent = "";
  body.classList.remove("has-current");
  const counter = { n: 0 };
  const seen = new Set();
  for (const b of structure(chunk.text, docId)) {
    let el;
    if (b.type === "sec" || b.type === "sub") {
      el = document.createElement(b.type === "sec" ? "h2" : "h3");
      el.className = b.type;
      const span = document.createElement("span");
      span.className = "sentence";
      span.dataset.si = String(counter.n++);
      if (b.num) {
        const n = document.createElement("span");
        n.className = "num";
        n.textContent = b.num;
        span.append(n, " ");
      }
      span.append(b.text || "");
      el.appendChild(span);
      el.dataset.level = b.type === "sec" ? "2" : "3";
      el.dataset.label = [b.num, b.text].filter(Boolean).join(" — ");
    } else if (b.type === "q") {
      el = document.createElement("h3");
      el.className = "q";
      el.dataset.level = "3";
      el.dataset.label = b.text;
      appendSentences(el, b.text, counter, seen);
    } else if (b.type === "item") {
      el = document.createElement("div");
      el.className = `item depth-${b.depth || 1}`;
      const marker = document.createElement("span");
      marker.className = "marker" + (b.marker === "•" ? " bullet" : "");
      marker.setAttribute("aria-hidden", b.marker === "•" ? "true" : "false");
      marker.textContent = b.marker;
      const text = document.createElement("div");
      appendSentences(text, b.text, counter, seen);
      el.append(marker, text);
    } else if (b.type === "toc") {
      const hint = document.createElement("p");
      hint.className = "note-hint";
      hint.textContent = "This is the document's own contents page. The Contents list in the sidebar jumps straight to each section.";
      body.appendChild(hint);
      el = document.createElement("div");
      el.className = "toc";
      el.textContent = b.text;
    } else {
      el = document.createElement("p");
      appendSentences(el, b.text, counter, seen);
    }
    body.appendChild(el);
  }
}

function renderKicker(d, c) {
  const wordsLeft = d.chunks.slice(state.idx).reduce((a, x) => a + (x.words || 200), 0);
  $("pageNo").textContent = `Page ${state.idx + 1} of ${d.chunks.length}`;
  $("timeLeft").textContent = `About ${minutes(c.words || 200)} min for this page · ${minutes(wordsLeft)} min left in ${d.short}`;
}

/* "You are here": the section you entered the page in, updated by the headings you scroll past. */
let lastCrumbs = "";
function updateCrumbs() {
  const d = DOC();
  if (!d) return;
  const outline = outlineOf(d.id);
  let { sec, sub } = sectionAt(outline.filter((o) => o.idx < state.idx), state.idx);
  let secLabel = sec && sec.label, subLabel = sub && sub.label;
  const scroller = $("readerScroll").getBoundingClientRect();
  const line = scroller.top + scroller.height * 0.35;
  for (const h of $("pageBody").querySelectorAll("[data-level]")) {
    if (h.getBoundingClientRect().top > line) break;
    if (h.dataset.level === "2") { secLabel = h.dataset.label; subLabel = null; } else subLabel = h.dataset.label;
  }
  const labels = [d.short, secLabel, subLabel].filter(Boolean);
  const key = labels.join("|");
  if (key === lastCrumbs) return;
  lastCrumbs = key;
  const crumbs = $("crumbs");
  crumbs.textContent = "";
  for (const label of labels) {
    const li = document.createElement("li");
    li.textContent = label;
    li.title = label;
    crumbs.appendChild(li);
  }
  markOutline(secLabel, subLabel);
  const short = (secLabel || `page ${state.idx + 1}`);
  $("brandSub").textContent = `${d.short} · ${short.length > 42 ? short.slice(0, 40) + "…" : short}`;
}

function renderUpNext(d) {
  const box = $("upNext");
  box.textContent = "";
  const outline = outlineOf(d.id);
  const upcoming = nextHeading(outline, state.idx);
  const di = state.order.indexOf(d.id);
  const nextDoc = state.idx === d.chunks.length - 1 && di < state.order.length - 1 ? state.byId[state.order[di + 1]] : null;
  const pct = Math.round(((state.idx + 1) / d.chunks.length) * 100);

  const label = document.createElement("div");
  label.className = "label";
  const title = document.createElement("div");
  title.className = "title";
  if (nextDoc) { label.textContent = "You've finished this document — up next"; title.textContent = nextDoc.title; }
  else if (upcoming) {
    const away = upcoming.idx - state.idx;
    label.textContent = away === 1 ? "Up next, on the next page" : `Up next, in ${away} pages`;
    title.textContent = upcoming.label;
  } else if (state.idx < d.chunks.length - 1) { label.textContent = "Up next"; title.textContent = `Page ${state.idx + 2} of ${d.short}`; }
  else { label.textContent = "The end"; title.textContent = "You've reached the end of all four documents."; }

  const meter = document.createElement("div");
  meter.className = "meter";
  meter.setAttribute("role", "img");
  meter.setAttribute("aria-label", `${pct}% of ${d.short} read`);
  const fill = document.createElement("span");
  fill.style.width = pct + "%";
  meter.appendChild(fill);

  const row = document.createElement("div");
  row.className = "row";
  const where = document.createElement("span");
  where.textContent = pct >= 100 ? `${d.short} complete` : `${pct}% of ${d.short} read`;
  row.appendChild(where);
  if (state.idx < d.chunks.length - 1 || nextDoc) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn small";
    btn.textContent = nextDoc ? `Start ${nextDoc.short}` : "Continue reading";
    btn.addEventListener("click", () => nextPage());
    row.appendChild(btn);
  }
  box.append(label, title, meter, row);
}

let progressRaf = 0;
function updateDocProgress() {
  cancelAnimationFrame(progressRaf);
  progressRaf = requestAnimationFrame(() => {
    const d = DOC();
    if (!d) return;
    const sc = $("readerScroll");
    const within = sc.scrollHeight > sc.clientHeight ? sc.scrollTop / (sc.scrollHeight - sc.clientHeight) : 1;
    const pct = Math.min(100, ((state.idx + within) / d.chunks.length) * 100);
    $("docProgressFill").style.width = pct.toFixed(2) + "%";
    $("docProgress").setAttribute("aria-valuenow", String(Math.round(pct)));
    updateCrumbs();
  });
}

function setCurrentBlock(node) {
  const body = $("pageBody");
  const block = node && node.closest && node.closest(".page-body > *");
  if (!block) return;
  body.querySelectorAll(":scope > .current").forEach((el) => el !== block && el.classList.remove("current"));
  block.classList.add("current");
  body.classList.add("has-current");
}

function renderPage({ keepSpeech = false } = {}) {
  const d = DOC();
  const c = d.chunks[state.idx];
  renderKicker(d, c);
  $("pageInput").value = state.idx + 1;
  $("pageInput").max = d.chunks.length;
  $("pageTotal").textContent = `of ${d.chunks.length}`;
  renderBlocks($("pageBody"), c, d.id);
  renderUpNext(d);
  closeTermPop();

  const di = state.order.indexOf(state.doc);
  $("prevBtn").disabled = state.idx === 0 && di === 0;
  $("nextBtn").disabled = state.idx === d.chunks.length - 1 && di === state.order.length - 1;
  $("readerScroll").scrollTop = 0;
  lastCrumbs = "";
  updateDocProgress();

  store.prefs.set("pos", { doc: state.doc, idx: state.idx });
  const progress = store.prefs.get("progress", {});
  if ((progress[state.doc] ?? -1) < state.idx) { progress[state.doc] = state.idx; store.prefs.set("progress", progress); }
  renderNav();
  if (!keepSpeech) { tts.stop(); setStatus("Press play to hear this page."); }
  else tts.updateMedia();
}

/* =========================================================== defined-term popover */

let termPop = null;
function closeTermPop() {
  if (!termPop) return;
  termPop.btn.setAttribute("aria-expanded", "false");
  termPop.el.remove();
  termPop = null;
}
function openTermPop(btn) {
  closeTermPop();
  const def = termByLower.get(btn.dataset.term.toLowerCase());
  if (!def) return;
  const el = document.createElement("div");
  el.className = "term-pop";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", `Definition of ${def.term}`);
  const strong = document.createElement("strong");
  strong.textContent = def.term;
  const body = document.createElement("span");
  body.textContent = " " + excerpt(def.definition, 420);
  const src = document.createElement("span");
  src.className = "src";
  const link = document.createElement("a");
  link.href = "#";
  link.className = "ref";
  link.textContent = `${def.docShort}, p.${def.page}`;
  link.addEventListener("click", (e) => { e.preventDefault(); closeTermPop(); goTo(def.doc, def.page - 1, { jump: true }); });
  src.append("Defined in ", link);
  el.append(strong, body, src);
  document.body.appendChild(el);
  const r = btn.getBoundingClientRect();
  const w = el.offsetWidth, h = el.offsetHeight;
  let top = r.bottom + 8;
  if (top + h > innerHeight - 80) top = Math.max(8, r.top - h - 8);
  el.style.top = `${Math.round(top)}px`;
  el.style.left = `${Math.round(Math.min(innerWidth - w - 12, Math.max(12, r.left + r.width / 2 - w / 2)))}px`;
  btn.setAttribute("aria-expanded", "true");
  termPop = { el, btn };
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

function renderOutline() {
  const ul = $("outline");
  ul.textContent = "";
  const d = DOC();
  $("outlineTitle").textContent = `Contents · ${d.short}`;
  const outline = outlineOf(d.id);
  const readUpTo = store.prefs.get("progress", {})[d.id] ?? -1;
  outline.forEach((item, i) => {
    const li = document.createElement("li");
    li.className = `lvl-${item.level}`;
    li.dataset.i = String(i);
    const nextStart = outline.slice(i + 1).find((o) => o.idx > item.idx);
    if (nextStart && nextStart.idx <= readUpTo) li.classList.add("done");
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = item.label;
    b.addEventListener("click", () => { goTo(d.id, item.idx, { jump: true }); if (!mq.nav.matches) closeNav(); });
    li.appendChild(b);
    ul.appendChild(li);
  });
}

/** Highlight the outline entries for the section you're in (same source of truth as the crumbs). */
function markOutline(secLabel, subLabel) {
  const d = DOC();
  const outline = outlineOf(d.id);
  const ul = $("outline");
  const find = (label, level) => {
    if (!label) return -1;
    // Nearest matching entry at or before this page (labels can repeat across a document).
    for (let i = outline.length - 1; i >= 0; i--) if (outline[i].idx <= state.idx && outline[i].level === level && outline[i].label.startsWith(label.slice(0, 80))) return i;
    return -1;
  };
  const secI = find(secLabel, 2), subI = find(subLabel, 3);
  let focus = null;
  ul.querySelectorAll("li").forEach((li) => {
    const i = Number(li.dataset.i);
    const isCur = i === (subI >= 0 ? subI : secI);
    li.classList.toggle("current", i === secI || i === subI);
    li.firstChild.toggleAttribute("aria-current", isCur);
    if (isCur) { li.firstChild.setAttribute("aria-current", "location"); focus = li; }
  });
  if (focus) ul.scrollTop = Math.max(0, focus.offsetTop - ul.offsetTop - ul.clientHeight / 2);
}

function renderNav() {
  renderOutline();
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
    setCurrentBlock(span);
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

const DEFAULT_PREFS = { palette: "golden", theme: "auto", font: "literata", size: 19, leading: 1.65, measure: 66, spacing: "normal", focus: "off" };
const pref = (k) => store.prefs.get(k, DEFAULT_PREFS[k]);

function applyPrefs() {
  const root = document.documentElement;
  root.dataset.palette = pref("palette");
  const theme = pref("theme");
  if (theme === "auto") delete root.dataset.theme; else root.dataset.theme = theme;
  root.dataset.font = pref("font");
  root.dataset.spacing = pref("spacing");
  root.dataset.focus = pref("focus");
  root.style.setProperty("--reader-size", `${pref("size")}px`);
  root.style.setProperty("--reader-leading", String(pref("leading")));
  root.style.setProperty("--reader-measure", `${pref("measure")}ch`);
  const dark = theme === "auto" ? matchMedia("(prefers-color-scheme: dark)").matches : theme === "dark";
  $("themeIcon").setAttribute("href", dark ? "#i-sun" : "#i-moon");
  // Browser/OS chrome (Android status bar, installed-app title bar) follows the palette too.
  requestAnimationFrame(() => {
    const chrome = getComputedStyle(root).getPropertyValue("--chrome").trim();
    if (chrome) document.querySelector('meta[name="theme-color"]').content = chrome;
  });
  // Reflect state in the settings panel.
  document.querySelectorAll("#paletteOpts .palette-opt").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === pref("palette"))));
  document.querySelectorAll("#settingsPanel .seg[data-pref]").forEach((seg) => {
    const current = String(pref(seg.dataset.pref));
    seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === current)));
  });
  $("sizeRange").value = pref("size");
  $("sizeOut").textContent = `${pref("size")}px`;
  updateDocProgress();
}

function setPref(key, value) {
  store.prefs.set(key, value);
  applyPrefs();
}

function openSettings(open) {
  $("settingsPanel").hidden = !open;
  $("settingsBtn").setAttribute("aria-expanded", String(open));
  if (open) { $("audioPopover").hidden = true; ($("settingsPanel").querySelector('[aria-pressed="true"]') || $("sizeRange")).focus(); }
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

  // Reading settings
  $("settingsBtn").addEventListener("click", () => openSettings($("settingsPanel").hidden));
  $("paletteOpts").addEventListener("click", (e) => { const b = e.target.closest(".palette-opt"); if (b) setPref("palette", b.dataset.v); });
  document.querySelectorAll("#settingsPanel .seg[data-pref]").forEach((seg) => seg.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-v]");
    if (!b) return;
    const numeric = ["leading", "measure"].includes(seg.dataset.pref);
    setPref(seg.dataset.pref, numeric ? Number(b.dataset.v) : b.dataset.v);
  }));
  $("sizeRange").addEventListener("input", (e) => setPref("size", Number(e.target.value)));
  $("resetReading").addEventListener("click", () => {
    for (const k of Object.keys(DEFAULT_PREFS)) if (k !== "palette" && k !== "theme") store.prefs.set(k, DEFAULT_PREFS[k]);
    applyPrefs();
    toast("Text settings reset to the recommended defaults.");
  });
  document.addEventListener("click", (e) => {
    if (!$("settingsPanel").hidden && !e.target.closest("#settingsPanel, #settingsBtn")) openSettings(false);
    if (termPop && !e.target.closest(".term-pop, .term")) closeTermPop();
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyPrefs);

  // Structure: defined terms, focus mode, progress
  $("pageBody").addEventListener("click", (e) => {
    const term = e.target.closest(".term");
    if (term) { e.preventDefault(); e.stopPropagation(); termPop && termPop.btn === term ? closeTermPop() : openTermPop(term); return; }
    setCurrentBlock(e.target);
  });
  $("pageBody").addEventListener("pointerover", (e) => { if (!mq.coarse.matches && !tts.playing) setCurrentBlock(e.target); });
  $("readerScroll").addEventListener("scroll", () => { updateDocProgress(); closeTermPop(); }, { passive: true });

  $("themeBtn").addEventListener("click", () => {
    const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    setPref("theme", cur === "dark" ? "light" : "dark");
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
      if (termPop) return closeTermPop();
      if (!$("settingsPanel").hidden) { openSettings(false); $("settingsBtn").focus(); return; }
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
  applyPrefs();
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
