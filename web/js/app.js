// SPDX-License-Identifier: AGPL-3.0-or-later
// BookMind reader — offline-first PWA front end.

import { api, HttpError, SyncEngine } from "./net.js";
import { escapeHtml, renderMD } from "./md.js";
import { definitions, excerpt, extractiveAnswer, loadSemanticPack, searchNotes, searchPassages, semanticReady, tokenize } from "./search.js";
import { buildOutline, nextHeading, sectionAt, structure } from "./structure.js";
import { relatedElsewhere, relatedNotes, worthNoting } from "./insights.js";
import { captureAnchor, paintAnchors } from "./anchor.js";
import * as store from "./store.js";

const $ = (id) => document.getElementById(id);
const mq = { nav: matchMedia("(min-width: 1024px)"), panel: matchMedia("(min-width: 1280px)"), coarse: matchMedia("(pointer: coarse)") };

const state = {
  chunks: [], docs: [], byId: {}, order: [],
  doc: null, idx: 0,
  notes: [],
  flags: { research_enabled: true, simplify_enabled: true, llm_enabled: true, notes_search_enabled: true, web_search_enabled: true },
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
  // Heading levels never skip: sub-headings/questions are h4 only once a section (h3) has started.
  let inSection = false;
  for (const b of structure(chunk.text, docId)) {
    let el;
    if (b.type === "sec" || b.type === "sub") {
      // h1 = app, h2 = the page (screen-reader heading in the kicker), h3/h4 = the document's own.
      el = document.createElement(b.type === "sec" || !inSection ? "h3" : "h4");
      if (b.type === "sec") inSection = true;
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
      el = document.createElement(inSection ? "h4" : "h3");
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
  $("pageHeading").textContent = `${d.title}, page ${state.idx + 1}`;
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
  paintSavedHighlights();
  renderInsights(d, c);
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
    b.addEventListener("click", () => { goToHeading(d.id, item.idx, item.label.slice(0, 60)); if (!mq.nav.matches) closeNav(); });
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

/* =========================================================== read aloud (Piper neural voices + Web Speech API) */
// Two engines behind one player:
//  * Natural voices — Piper neural TTS on the BookMind server (bookmind/services/tts.py). Consistent
//    across devices, runs on the reader's own server, and a page you've heard replays offline (the
//    service worker caches each sentence's audio).
//  * Device voices — the browser's Web Speech API. Always the fallback: offline and not yet cached,
//    server busy, or natural voices switched off. Falling back is per sentence, so reading never stops.

const tts = {
  supported: "speechSynthesis" in window,
  voices: [], neural: [], neuralMaxChars: 600, playing: false, index: 0, gen: 0, wakeLock: null,
  audio: null, prefetched: new Map(), fellBack: false,

  async loadNeural() {
    try {
      const data = await api("/api/v1/tts/voices", { timeout: 5000 });
      this.neural = data.voices || [];
      this.neuralMaxChars = data.max_chars || 600;
    } catch { this.neural = []; }
    this.loadVoices();
  },
  loadVoices() {
    this.voices = this.supported ? speechSynthesis.getVoices() : [];
    const saved = store.prefs.get("voice");
    for (const sel of [$("voiceSelect"), $("voiceSelectM")]) {
      sel.textContent = "";
      if (this.neural.length) {
        const g = document.createElement("optgroup");
        g.label = "Natural voices (Piper)";
        for (const v of this.neural) g.appendChild(new Option(`${v.name} · ${v.language.replace("_", "-")}${v.quality ? " · " + v.quality : ""}`, `piper:${v.id}`));
        sel.appendChild(g);
      }
      const g = this.neural.length ? document.createElement("optgroup") : sel;
      if (this.neural.length) { g.label = "This device's voices"; sel.appendChild(g); }
      if (!this.voices.length) g.appendChild(new Option("Default device voice", ""));
      const sorted = [...this.voices].sort((a, b) => (b.lang.startsWith("en") - a.lang.startsWith("en")) || a.name.localeCompare(b.name));
      for (const v of sorted) g.appendChild(new Option(`${v.name} (${v.lang})`, v.voiceURI));
      const values = [...sel.options].map((o) => o.value);
      // Keep the reader's choice; otherwise prefer a natural English voice, then a Kenyan/British device voice.
      const neuralEn = this.neural.find((v) => v.language.startsWith("en"));
      const device = this.voices.find((v) => /^en[-_](KE|GB)/i.test(v.lang)) || this.voices.find((v) => v.lang.startsWith("en")) || this.voices[0];
      sel.value = values.includes(saved) ? saved : neuralEn ? `piper:${neuralEn.id}` : device ? device.voiceURI : values[0] || "";
    }
  },
  neuralId() { const v = $("voiceSelect").value || ""; return v.startsWith("piper:") ? v.slice(6) : null; },
  voice() { return this.voices.find((v) => v.voiceURI === $("voiceSelect").value); },
  spans() { return $("pageBody").querySelectorAll(".sentence"); },
  rate() { return parseFloat($("rateRange").value) || 1; },

  /** Split an over-long sentence at clause boundaries so each request stays under the server limit. */
  pieces(text) {
    const t = text.replace(/\s+/g, " ").trim();
    if (t.length <= this.neuralMaxChars) return [t];
    const out = [];
    let rest = t;
    while (rest.length > this.neuralMaxChars) {
      const window = rest.slice(0, this.neuralMaxChars);
      const cut = Math.max(window.lastIndexOf("; "), window.lastIndexOf(", "), window.lastIndexOf(" — "), window.lastIndexOf(" "));
      const at = cut > this.neuralMaxChars / 3 ? cut + 1 : this.neuralMaxChars;
      out.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest) out.push(rest);
    return out;
  },
  audioUrl(id, text) { return `/api/v1/tts?voice=${encodeURIComponent(id)}&text=${encodeURIComponent(text)}`; },
  /** Fetch one piece of audio as a blob (the service worker caches it for offline replays). */
  fetchAudio(id, text) {
    const url = this.audioUrl(id, text);
    if (!this.prefetched.has(url)) {
      const p = fetch(url, { credentials: "same-origin" }).then((r) => { if (!r.ok) throw new Error(`tts ${r.status}`); return r.blob(); });
      p.catch(() => this.prefetched.delete(url));
      this.prefetched.set(url, p);
      while (this.prefetched.size > 8) this.prefetched.delete(this.prefetched.keys().next().value);
    }
    return this.prefetched.get(url);
  },
  prefetch(i) {
    const id = this.neuralId(), span = this.spans()[i];
    if (id && span) this.fetchAudio(id, this.pieces(span.textContent)[0]).catch(() => {});
  },

  speakFrom(i) {
    if (!this.supported && !this.neuralId()) { toast("Read-aloud isn't supported in this browser."); return; }
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
    const next = () => { if (gen === this.gen && this.playing) this.speakFrom(i + 1); };
    setStatus(`Reading ${DOC().short}, page ${state.idx + 1}`);
    const id = this.neuralId();
    if (id) this.speakNeural(id, span.textContent, gen, next);
    else this.speakDevice(span.textContent, next);
  },
  async speakNeural(id, text, gen, next) {
    const parts = this.pieces(text);
    this.prefetch(this.index + 1); // fetch the next sentence while this one plays: no gaps
    try {
      for (const part of parts) {
        const blob = await this.fetchAudio(id, part);
        if (gen !== this.gen) return;
        await this.playBlob(blob, gen);
        if (gen !== this.gen) return;
      }
      this.fellBack = false;
      next();
    } catch {
      if (gen !== this.gen) return;
      // Offline and not cached, or the server can't synthesise: read this sentence with the device voice.
      if (!this.fellBack) toast("Natural voice unavailable right now — using this device's voice.");
      this.fellBack = true;
      if (this.supported) this.speakDevice(text, next);
      else this.stop("The natural voice is unavailable and this browser has no built-in voice.");
    }
  },
  playBlob(blob, gen) {
    return new Promise((resolve, reject) => {
      if (!this.audio) { this.audio = new Audio(); this.audio.preservesPitch = true; }
      const a = this.audio;
      const url = URL.createObjectURL(blob);
      const done = (fn) => () => { a.onended = a.onerror = null; URL.revokeObjectURL(url); fn(); };
      a.onended = done(resolve);
      a.onerror = done(() => reject(new Error("audio playback failed")));
      a.src = url;
      a.playbackRate = this.rate(); // speed changes tempo, not pitch
      a.play().catch((err) => { if (gen === this.gen) { a.onended = a.onerror = null; URL.revokeObjectURL(url); reject(err); } });
    });
  },
  speakDevice(text, next) {
    const u = new SpeechSynthesisUtterance(text);
    const v = this.voice();
    if (v) { u.voice = v; u.lang = v.lang; }
    u.rate = this.rate();
    u.onend = next;
    u.onerror = (e) => { if (e.error !== "interrupted" && e.error !== "canceled") next(); };
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  },
  silence() {
    if (this.supported) speechSynthesis.cancel();
    if (this.audio) { this.audio.onended = this.audio.onerror = null; this.audio.pause(); }
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
    this.silence();
    setPlayIcon(false);
    setStatus("Paused — press play to continue from the highlighted sentence.");
    this.releaseWakeLock();
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
  },
  stop(msg) {
    const was = this.playing;
    this.playing = false; this.gen++; this.index = 0;
    this.silence();
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
  state.selectionAnchor = captureAnchor($("pageBody"), sel.getRangeAt(0));
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

/* =========================================================== worth noting (on-device recommendations) */

function flashSentence(si) {
  const span = $("pageBody").querySelector(`.sentence[data-si="${si}"]`);
  if (!span) return;
  span.scrollIntoView({ block: "center", behavior: "smooth" });
  span.classList.add("hit");
  setTimeout(() => span.classList.remove("hit"), 2200);
}

function clausePage(clause) {
  const want = `clause ${clause.toLowerCase()}`;
  const target = outlineOf("bill").find((o) => o.label.toLowerCase() === want || o.label.toLowerCase().startsWith(want + " "));
  return target ? target.idx : -1;
}

/** Go to a page and land on a specific heading (a page can hold several clauses). */
function goToHeading(docId, idx, label) {
  goTo(docId, idx, { jump: true });
  const want = label.toLowerCase();
  const heading = [...$("pageBody").querySelectorAll("[data-label]")].find((h) => h.dataset.label.toLowerCase().startsWith(want));
  if (heading) {
    heading.scrollIntoView({ block: "start" });
    heading.classList.add("landed");
    setTimeout(() => heading.classList.remove("landed"), 1800);
  }
  updateDocProgress();
}

function jumpToClause(clause) {
  const idx = clausePage(clause);
  if (idx >= 0) goToHeading("bill", idx, `clause ${clause}`);
  else toast(`Couldn't find clause ${clause} in the Bill.`);
}

function renderInsights(d, c) {
  const box = $("insights");
  box.textContent = "";
  if (!store.prefs.get("insights", true)) { box.hidden = true; return; }
  const found = worthNoting($("pageBody"), d.id);
  const points = found.points;
  // Only references that lead somewhere else: skip clauses printed on this very page.
  const xrefs = found.xrefs.filter((x) => { const idx = clausePage(x.clause); return idx >= 0 && !(d.id === "bill" && idx === state.idx); });
  const related = relatedElsewhere(state.chunks, c, 3);
  const mine = relatedNotes(state.notes, c, state.idx + 1, 3);
  if (!points.length && !related.length && !xrefs.length && !mine.length) { box.hidden = true; return; }
  box.hidden = false;
  const details = document.createElement("details");
  details.open = store.prefs.get("insightsOpen", true);
  details.addEventListener("toggle", () => store.prefs.set("insightsOpen", details.open));
  const summary = document.createElement("summary");
  summary.innerHTML = `<span>Worth noting on this page</span><span class="count">${points.length + related.length + xrefs.length + mine.length}</span>`;
  details.appendChild(summary);

  const section = (title, items) => {
    if (!items.length) return;
    const h = document.createElement("h3");
    h.className = "ins-h";
    h.textContent = title;
    const ul = document.createElement("ul");
    items.forEach((li) => ul.appendChild(li));
    details.append(h, ul);
  };
  section("Key points", points.map((p) => {
    const li = document.createElement("li");
    li.className = `point kind-${p.kind}`;
    const tag = Object.assign(document.createElement("span"), { className: "kind", textContent: p.label });
    const go = Object.assign(document.createElement("button"), { type: "button", className: "linktext", textContent: excerpt(p.text, 180) });
    go.addEventListener("click", () => flashSentence(p.si));
    const keep = Object.assign(document.createElement("button"), { type: "button", className: "linkbtn keep", textContent: "Keep" });
    keep.title = "Save as a highlight in your notebook";
    keep.addEventListener("click", async () => {
      const note = newNote("highlight", p.text, { color: "accent" });
      state.notes.unshift(note);
      await saveNote(note);
      renderNotes();
      paintSavedHighlights();
      keep.textContent = "Kept ✓";
      keep.disabled = true;
    });
    li.append(tag, go, keep);
    return li;
  }));
  section("Cross-references", xrefs.map((x) => {
    const li = document.createElement("li");
    const b = Object.assign(document.createElement("button"), { type: "button", className: "chip-btn", textContent: `${x.label} →` });
    b.addEventListener("click", () => jumpToClause(x.clause));
    li.appendChild(b);
    return li;
  }));
  section("Related in the other documents", related.map((r) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.className = "linktext";
    b.innerHTML = `<strong>${escapeHtml(r.docShort)}, p.${r.page}</strong> — ${escapeHtml(r.snippet)}`;
    b.addEventListener("click", () => goTo(r.doc, r.page - 1, { jump: true }));
    li.appendChild(b);
    return li;
  }));
  section("From your notebook", mine.map((n) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.className = "linktext";
    b.innerHTML = `<strong>${escapeHtml((KIND[n.mode] || KIND.research).label)} · ${escapeHtml(n.doc_short)}, p.${n.page}</strong> — ${escapeHtml(excerpt(n.comment || n.selection, 160))}`;
    b.addEventListener("click", () => openNote(n.id));
    li.appendChild(b);
    return li;
  }));
  box.appendChild(details);
}

/* =========================================================== web search (opt-in) */

const webAllowed = () => state.flags.web_search_enabled !== false;
function ensureWebConsent() {
  if (!webAllowed()) { toast("Web search is switched off on this server."); return false; }
  if (!navigator.onLine) { toast("You're offline — web search needs a connection."); return false; }
  if (store.prefs.get("web_ok", false)) return true;
  // Best practice: be explicit before anything leaves the device.
  const ok = confirm(
    "Search the web?\n\nYour search words will be sent to this server's web search providers " +
    "(a private SearXNG instance and/or Wikipedia). Your notes and reading history are not sent.\n\n" +
    "Allow web search on this device? You can turn it off again in the Notebook.",
  );
  store.prefs.set("web_ok", ok);
  return ok;
}

const webRef = (w) => ({ title: w.title, url: w.url, domain: w.domain, tier_label: w.tier_label, accessed_at: w.accessed_at || Date.now() });
const tierClass = (label = "") => (/^(Official|Government|Intergovernmental|Academic)/.test(label) ? "good" : "check");

async function saveWebSource(w) {
  const note = newNote("web", `${w.title} — ${w.snippet || ""}`.slice(0, 1200), { web: [webRef(w)] });
  state.notes.unshift(note);
  await saveNote(note);
  renderNotes();
  toast(`Saved “${excerpt(w.title, 60)}”${filedIn()}`);
}

function webResultEl(w) {
  const el = document.createElement("div");
  el.className = "result web";
  el.innerHTML = `<div class="where"><a href="${escapeHtml(w.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(w.title)}</a></div>
    <div class="meta"><span class="tag tier ${tierClass(w.tier_label)}">${escapeHtml(w.tier_label)}</span> ${escapeHtml(w.domain)}</div>
    <div class="snippet">${escapeHtml(w.snippet || "")}</div>`;
  const row = document.createElement("div");
  row.className = "web-actions";
  const save = Object.assign(document.createElement("button"), { type: "button", className: "linkbtn", textContent: "Save to notebook" });
  save.addEventListener("click", () => { saveWebSource(w); save.textContent = "Saved ✓"; save.disabled = true; });
  row.appendChild(save);
  el.appendChild(row);
  return el;
}

async function searchWeb(q) {
  const box = $("webResults");
  if (!ensureWebConsent()) return;
  box.innerHTML = '<div class="thinking"><span class="spinner"></span> Searching the web…</div>';
  try {
    const res = await api(`/api/v1/web?q=${encodeURIComponent(q)}&k=8`, { timeout: 15000 });
    box.textContent = "";
    const h = document.createElement("h3");
    h.textContent = "On the web";
    box.appendChild(h);
    const note = document.createElement("p");
    note.className = "web-note";
    note.textContent = "Outside the four documents. Official and intergovernmental sources are listed first — check who published anything else before relying on it.";
    box.appendChild(note);
    if (!res.results.length) box.insertAdjacentHTML("beforeend", '<div class="empty">No web results. Search providers may be unavailable.</div>');
    for (const w of res.results) box.appendChild(webResultEl({ ...w, accessed_at: res.retrieved_at }));
  } catch (err) {
    box.innerHTML = `<div class="empty">${escapeHtml(err instanceof HttpError && err.status === 429 ? "Too many web searches — wait a minute." : "Web search is unavailable right now. The four documents are still fully searchable.")}</div>`;
  }
}

/* =========================================================== research workspace: notes, sessions, ask */

// Every saved item is a "note". Some are answered from the documents (research, simplify, ask);
// some are the reader's own (highlight, note). All can carry the reader's own words (comment) and
// be filed in a research session.
const KIND = {
  highlight: { label: "Highlight", group: "highlights" },
  note: { label: "My note", group: "mine" },
  research: { label: "Research", group: "research" },
  simplify: { label: "Simplified", group: "research" },
  ask: { label: "Question", group: "research" },
  web: { label: "Web source", group: "research" },
};
const nb = { filter: "all", query: "", order: "newest", editing: null };
const activeSession = () => store.prefs.get("session", "");

function sessionNames() {
  const set = new Set(store.prefs.get("sessions", []));
  for (const n of state.notes) if (n.session) set.add(n.session);
  return [...set].sort((a, b) => a.localeCompare(b));
}

const toServer = (n) => ({
  doc: n.doc, doc_short: n.doc_short, page: n.page, mode: n.mode, selection: n.selection, answer: n.answer || "",
  status: n.status, model: n.model, source: n.source, related: (n.related || []).slice(0, 20), created_at: n.created_at, updated_at: n.updated_at,
  comment: n.comment || "", session: n.session || "", color: n.color || null, chunk_id: n.chunk_id || null,
  web: (n.web || []).slice(0, 10), anchor: n.anchor || null,
});
async function queuePut(note) {
  await store.enqueue({ op: "put", id: note.id, payload: toServer(note) });
  requestBackgroundSync();
}
function requestBackgroundSync() {
  // Three layers, so a note reaches the server even if the app is closed right after writing it:
  //  1. Background Sync (Chromium): the browser wakes the service worker when connectivity returns
  //     — even with no BookMind tab open — and sw.js replays the outbox itself (sync-core.js);
  //  2. keepalive flush on pagehide/hidden (every browser): see SyncEngine.flushOnExit;
  //  3. the next time the app opens, SyncEngine replays whatever is still queued.
  sync && sync.track();
  navigator.serviceWorker?.ready.then((reg) => reg.sync && reg.sync.register("bookmind-sync")).catch(() => {});
}

async function registerPeriodicSync(reg) {
  // Periodic Background Sync (installed Chromium PWAs only): the browser occasionally wakes the
  // worker to push anything left over and pull notes made on other devices, so the notebook is
  // current the next time it's opened — even offline. The browser decides the real interval.
  try {
    if (!("periodicSync" in reg)) return;
    const perm = await navigator.permissions.query({ name: "periodic-background-sync" });
    if (perm.state === "granted") await reg.periodicSync.register("bookmind-refresh", { minInterval: 12 * 60 * 60 * 1000 });
  } catch { /* unsupported or not installed: the other layers still cover it */ }
}

function newNote(mode, selection, extra = {}) {
  const d = DOC();
  const c = d.chunks[state.idx];
  const now = Date.now();
  return {
    id: `n${now.toString(36)}${rand()}`, doc: d.id, doc_short: d.short, page: state.idx + 1, chunk_id: c.id, mode, selection,
    answer: "", comment: "", session: activeSession(), color: null, status: "done", model: null, source: null, related: [],
    web: [], created_at: now, updated_at: now, synced: false, ...extra,
  };
}

/** Persist locally first (works offline), then queue for the server. */
async function saveNote(note) {
  note.updated_at = Math.max(Date.now(), (note.updated_at || 0) + 1);
  note.synced = false;
  await store.putNote(note);
  await queuePut(note);
  sync.schedule(400);
}

function takeSelection() {
  let text = state.selection;
  hideToolbar();
  getSelection()?.removeAllRanges();
  if (text && text.length > state.limits.max_selection_chars) {
    text = text.slice(0, state.limits.max_selection_chars);
    toast("That's a long selection — using the first part.");
  }
  return text;
}

const filedIn = () => (activeSession() ? ` · filed in “${activeSession()}”` : "");

async function addHighlight() {
  const selection = takeSelection();
  if (!selection) return;
  const note = newNote("highlight", selection, { color: "accent", anchor: state.selectionAnchor });
  state.notes.unshift(note);
  await saveNote(note);
  renderNotes();
  paintSavedHighlights();
  toast(`Highlighted${filedIn() || " · saved to your notebook"}`);
}

async function addOwnNote() {
  const selection = takeSelection();
  if (!selection) return;
  const note = newNote("note", selection, { anchor: state.selectionAnchor });
  state.notes.unshift(note);
  await saveNote(note);
  nb.editing = note.id;
  nb.filter = "all";
  paintSavedHighlights();
  openNote(note.id);
}

async function research(mode, text) {
  const selection = text ?? takeSelection();
  if (!selection) return;
  const d = DOC();
  const c = d.chunks[state.idx];
  const note = newNote(mode, selection, { status: "pending" });
  state.notes.unshift(note);
  nb.filter = "all";
  renderNotes();
  openNotebook();

  const offline = (reason) => {
    Object.assign(note, extractiveAnswer(mode, selection, state.chunks, reason, mode === "ask" ? null : c.id), { status: "done", updated_at: Date.now(), synced: false, reason });
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
          context_text: c.text.slice(0, state.limits.max_context_chars), chunk_id: c.id, save: true, note_id: note.id, session: note.session,
          web: store.prefs.get("web_research", false) && webAllowed(),
        },
      });
      Object.assign(note, {
        answer: res.answer, model: res.model, source: res.source, related: res.related || [], web: res.web || [], reason: res.reason,
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

/* ---------------------------------------------------------------- notebook rendering */

function sourceTags(n) {
  const tags = [];
  if (n.source === "model") tags.push(`<span class="tag">${escapeHtml(n.model || "local model")}</span>`);
  else if (n.source === "extractive") tags.push('<span class="tag warn">Extractive</span>');
  else if (n.source === "offline") tags.push('<span class="tag warn">Offline</span>');
  if (!n.synced && n.status === "done") tags.push('<span class="tag">Not synced</span>');
  return tags.join("");
}

function visibleNotes() {
  const session = activeSession();
  const q = tokenize(nb.query);
  let list = state.notes.filter((n) => (!session || n.session === session) && (nb.filter === "all" || (KIND[n.mode] || KIND.research).group === nb.filter));
  if (q.length) {
    list = list.filter((n) => {
      const words = new Set(tokenize(`${n.selection} ${n.answer || ""} ${n.comment || ""}`));
      return q.every((w) => words.has(w));
    });
  }
  if (nb.order === "reading") {
    list = [...list].sort((a, b) => state.order.indexOf(a.doc) - state.order.indexOf(b.doc) || a.page - b.page || a.created_at - b.created_at);
  }
  return list;
}

function renderSessionControls() {
  const sel = $("sessionSelect");
  const current = activeSession();
  const counts = {};
  state.notes.forEach((n) => { if (n.session) counts[n.session] = (counts[n.session] || 0) + 1; });
  sel.textContent = "";
  sel.add(new Option(`All notes (${state.notes.length})`, ""));
  for (const name of sessionNames()) sel.add(new Option(`${name} (${counts[name] || 0})`, name));
  sel.value = current;
  $("sessionHint").textContent = current
    ? `New highlights, notes and answers are filed in “${current}”.`
    : "Showing everything. Pick or create a session to file new work under a topic.";
  const groups = { all: 0, highlights: 0, mine: 0, research: 0 };
  state.notes.forEach((n) => {
    if (current && n.session !== current) return;
    groups.all++;
    groups[(KIND[n.mode] || KIND.research).group]++;
  });
  document.querySelectorAll("#nbFilters button").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.f === nb.filter));
    b.querySelector(".n").textContent = groups[b.dataset.f];
  });
  $("nbOrder").textContent = nb.order === "newest" ? "Newest first" : "Reading order";
}

function noteCard(n) {
  const kind = KIND[n.mode] || KIND.research;
  const card = document.createElement("article");
  card.className = `note kind-${n.mode}`;
  card.id = "note-" + n.id;
  const sessionTag = n.session && !activeSession() ? `<span class="tag session">${escapeHtml(n.session)}</span>` : "";
  let html = `<div class="cite"><a href="#" class="goto">${escapeHtml(n.doc_short)}, p.${n.page}</a> · ${kind.label} ${sessionTag}${kind.group === "research" ? sourceTags(n) : (!n.synced ? '<span class="tag">Not synced</span>' : "")}</div>`;
  if (n.mode === "ask") html += `<p class="question">${escapeHtml(n.selection)}</p>`;
  else if (n.mode === "web" && n.web && n.web[0]) {
    const w = n.web[0];
    html += `<p class="question"><a href="${escapeHtml(w.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(w.title)}</a></p>` +
      `<div class="meta"><span class="tag tier ${tierClass(w.tier_label)}">${escapeHtml(w.tier_label)}</span> ${escapeHtml(w.domain)} · accessed ${new Date(w.accessed_at || n.created_at).toLocaleDateString()}</div>` +
      `<blockquote>${escapeHtml(excerpt(n.selection.replace(/^.*? — /, ""), 400))}</blockquote>`;
  } else html += `<blockquote>${escapeHtml(excerpt(n.selection, n.mode === "highlight" ? 600 : 260))}</blockquote>`;
  if (kind.group === "research" && n.mode !== "web") {
    html += n.status === "pending"
      ? '<div class="thinking"><span class="spinner"></span> Reading across the documents…</div>'
      : `<div class="answer">${renderMD(n.answer)}</div>`;
  }
  if (n.mode !== "web" && n.web && n.web.length) {
    html += `<div class="websrc"><span class="comment-label">Beyond the documents — consulted ${new Date(n.web[0].accessed_at || n.created_at).toLocaleDateString()}</span><ul>${n.web.map((w) =>
      `<li><a href="${escapeHtml(w.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(w.title)}</a> <span class="tag tier ${tierClass(w.tier_label)}">${escapeHtml(w.tier_label)}</span></li>`).join("")}</ul></div>`;
  }
  if (nb.editing === n.id) {
    html += `<div class="comment editing"><label class="comment-label" for="edit-${n.id}">Your note</label>
      <textarea id="edit-${n.id}" class="comment-edit" rows="4" placeholder="Your thoughts, questions, how this connects to other clauses…">${escapeHtml(n.comment || "")}</textarea>
      <div class="row"><span class="hint">Ctrl/⌘ + Enter to save</span><span><button type="button" class="linkbtn cancel">Cancel</button> <button type="button" class="btn small save">Save note</button></span></div></div>`;
  } else if (n.comment) {
    html += `<div class="comment"><span class="comment-label">Your note</span>${renderMD(n.comment)}</div>`;
  }
  const options = ['<option value="">No session</option>', ...sessionNames().map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`)].join("");
  html += `<div class="row"><span>${timeAgo(n.created_at || Date.now())}</span><span class="actions">
    ${nb.editing === n.id ? "" : `<button type="button" class="linkbtn edit">${n.comment ? "Edit note" : "Add your note"}</button>`}
    <select class="move" aria-label="File in session">${options}</select>
    <button type="button" class="linkbtn remove">Remove</button></span></div>`;
  card.innerHTML = html;
  card.querySelector(".move").value = n.session || "";

  card.querySelector(".goto").addEventListener("click", (e) => {
    e.preventDefault();
    goTo(n.doc, n.page - 1, { jump: true });
    if (n.mode !== "ask" && n.mode !== "web") highlightQuery(n.selection);
    if (!mq.panel.matches) closeNotebook();
  });
  card.querySelector(".remove").addEventListener("click", () => removeNote(n));
  card.querySelector(".move").addEventListener("change", async (e) => {
    n.session = e.target.value;
    await saveNote(n);
    renderNotes();
    toast(n.session ? `Filed in “${n.session}”.` : "Removed from its session.");
  });
  card.querySelector(".edit")?.addEventListener("click", () => { nb.editing = n.id; renderNotes(); focusEditor(n.id); });
  const save = async () => {
    n.comment = card.querySelector(".comment-edit").value.trim();
    nb.editing = null;
    await saveNote(n);
    renderNotes();
    paintSavedHighlights();
    toast("Note saved.");
  };
  card.querySelector(".save")?.addEventListener("click", save);
  card.querySelector(".cancel")?.addEventListener("click", () => {
    nb.editing = null;
    if (n.mode === "note" && !n.comment) removeNote(n); // an empty "Add note" that was abandoned
    else renderNotes();
  });
  card.querySelector(".comment-edit")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
    if (e.key === "Escape") { e.stopPropagation(); card.querySelector(".cancel").click(); }
  });
  return card;
}

function renderNotes() {
  const count = state.notes.length;
  $("noteCount").hidden = !count;
  $("noteCount").textContent = count > 99 ? "99+" : String(count);
  $("exportBtn").disabled = !count;
  renderSessionControls();
  const list = $("notesList");
  list.textContent = "";
  if (!count) {
    list.innerHTML = `<div class="empty"><strong>Your research notebook.</strong> Select any passage while reading, then:
      <ul><li><strong>Highlight</strong> to keep it,</li><li><strong>Note</strong> to write your own thoughts about it,</li>
      <li><strong>Research</strong> or <strong>Simplify</strong> for a cited explanation,</li></ul>
      or type a question in <strong>Ask the documents</strong> above. Group work into <strong>sessions</strong> (one per topic) and export a session as a research brief. Everything is saved on this device first, then synced.</div>`;
    return;
  }
  const shown = visibleNotes();
  if (!shown.length) {
    list.innerHTML = '<div class="empty">Nothing here matches. Try another filter or session.</div>';
    return;
  }
  for (const n of shown) list.appendChild(noteCard(n));
}

function focusEditor(id) {
  requestAnimationFrame(() => {
    const ta = document.getElementById(`edit-${id}`);
    if (ta) { ta.focus(); ta.scrollIntoView({ block: "center" }); }
  });
}

function openNote(id) {
  const n = state.notes.find((x) => x.id === id);
  if (!n) return;
  if (activeSession() && n.session !== activeSession()) store.prefs.set("session", "");
  nb.filter = "all";
  nb.query = "";
  $("nbQuery").value = "";
  renderNotes();
  openNotebook();
  requestAnimationFrame(() => {
    const el = document.getElementById("note-" + id);
    if (!el) return;
    el.scrollIntoView({ block: "start" });
    el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), 1600);
    if (nb.editing === id) focusEditor(id);
  });
}

async function removeNote(n) {
  state.notes = state.notes.filter((x) => x.id !== n.id);
  if (nb.editing === n.id) nb.editing = null;
  renderNotes();
  paintSavedHighlights();
  await store.deleteNote(n.id);
  await store.enqueue({ op: "delete", id: n.id, updated_at: Math.max(Date.now(), (n.updated_at || 0) + 1) });
  requestBackgroundSync();
  sync.schedule(300);
  toast("Removed from your notebook.");
}

/** Saved highlights and notes are shown on the page they came from; tap one to open it.
 *  Exact words where the quote can be found (text-quote anchoring); whole sentences otherwise. */
function paintSavedHighlights() {
  const body = $("pageBody");
  if (!body || !state.doc) return;
  body.querySelectorAll(".saved").forEach((el) => { el.classList.remove("saved", "saved-hl", "saved-note"); delete el.dataset.note; el.removeAttribute("title"); });
  const here = state.notes.filter((n) => (n.mode === "highlight" || n.mode === "note") && n.doc === state.doc && n.page === state.idx + 1);
  const missed = paintAnchors(body, here);
  if (!missed.length) return;
  const norm = (t) => t.replace(/\s+/g, " ").trim().toLowerCase();
  const spans = [...body.querySelectorAll(".sentence")];
  for (const n of missed) {
    const sel = norm(n.selection);
    for (const s of spans) {
      const t = norm(s.textContent);
      if (t.length < 3) continue;
      const hit = sel.includes(t) || t.includes(sel) || (sel.length >= 12 && (t.includes(sel.slice(0, 30)) || t.includes(sel.slice(-30))));
      if (!hit) continue;
      s.classList.add("saved", n.mode === "note" ? "saved-note" : "saved-hl");
      s.dataset.note = n.id;
      s.title = n.mode === "note" ? "Your note — tap to open" : "Your highlight — tap to open";
    }
  }
}

/** A research brief: questions, then highlights & notes in reading order, then answers, then references. */
function exportNotes() {
  const session = activeSession();
  const notes = state.notes.filter((n) => n.status === "done" && (!session || n.session === session));
  const inReadingOrder = (a, b) => state.order.indexOf(a.doc) - state.order.indexOf(b.doc) || a.page - b.page || a.created_at - b.created_at;
  const quote = (t) => `> ${t.replace(/\s+/g, " ").trim()}`;
  const yours = (n) => (n.comment ? `\n\n**My note:** ${n.comment}` : "");
  // Answers carry their own ## headings; nest them under the item's ### heading.
  const nested = (t) => (t || "").replace(/^#{1,4}\s+/gm, "#### ");
  let md = `# Research brief: ${session || "All notes"}\n\n_Exported ${new Date().toLocaleString()} from BookMind · ${notes.length} items._\n\n`;
  const asks = notes.filter((n) => n.mode === "ask").sort((a, b) => a.created_at - b.created_at);
  if (asks.length) {
    md += "## Questions\n\n";
    for (const n of asks) md += `### ${n.selection}\n\n${nested(n.answer)}${yours(n)}\n\n`;
  }
  const own = notes.filter((n) => n.mode === "highlight" || n.mode === "note").sort(inReadingOrder);
  if (own.length) {
    md += "## Highlights and notes (in reading order)\n\n";
    let lastDoc = null;
    for (const n of own) {
      if (n.doc !== lastDoc) { md += `### ${state.byId[n.doc]?.title || n.doc_short}\n\n`; lastDoc = n.doc; }
      md += `**p.${n.page}**\n\n${quote(n.selection)}${yours(n)}\n\n`;
    }
  }
  const answers = notes.filter((n) => n.mode === "research" || n.mode === "simplify").sort(inReadingOrder);
  if (answers.length) {
    md += "## Research notes\n\n";
    for (const n of answers) md += `### ${KIND[n.mode].label} — ${n.doc_short}, p.${n.page}\n\n${quote(n.selection)}\n\n${nested(n.answer)}${yours(n)}\n\n`;
  }
  const webNotes = notes.filter((n) => n.mode === "web");
  const webSeen = new Map();
  for (const n of notes) for (const w of n.web || []) if (!webSeen.has(w.url)) webSeen.set(w.url, w);
  if (webSeen.size) {
    md += "## Sources beyond the documents\n\n_Not part of the four documents. Verify before relying on them._\n\n";
    for (const w of webSeen.values()) md += `- [${w.title}](${w.url}) — ${w.domain} · ${w.tier_label} · accessed ${new Date(w.accessed_at || Date.now()).toISOString().slice(0, 10)}\n`;
    for (const n of webNotes) if (n.comment) md += `  - **My note on “${n.web[0]?.title || "source"}”:** ${n.comment}\n`;
    md += "\n";
  }
  const refs = {};
  for (const n of notes) {
    if (n.mode === "web") continue;
    (refs[n.doc] ||= new Set()).add(n.page);
    for (const r of n.related || []) { const d = docByShort(r.docShort); if (d) (refs[d.id] ||= new Set()).add(r.page); }
  }
  md += "## References\n\n";
  for (const id of state.order) if (refs[id]) md += `- ${state.byId[id].title} — pp. ${[...refs[id]].sort((a, b) => a - b).join(", ")}\n`;
  md += "\n## Verification checklist\n\n" + [
    "Every claim cites a document and page, e.g. [Bill, p.9].",
    "Claims about the law are checked against the Bill itself, not only the Digest or a summary.",
    "Web sources are official or intergovernmental where possible; anything else was checked by reading laterally (who publishes it? what do others say?).",
    "Dates are noted: the Bill is a 2026 draft and may have changed since.",
    "Extractive or offline answers were re-read in the source before quoting.",
  ].map((t) => `- [ ] ${t}`).join("\n") + "\n";
  const slug = (session || "notebook").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const url = URL.createObjectURL(new Blob([md], { type: "text/markdown" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `bookmind-${slug}.md` });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast(`Research brief exported (${notes.length} items).`);
}

async function reloadNotes() {
  state.notes = await store.allNotes();
  renderNotes();
  paintSavedHighlights();
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
    (where === "offline" ? ` · searched on this device (offline${semanticReady() ? ", by words and meaning" : ""})` : where === "partial" ? " · some results unavailable" : "");
  results.textContent = "";
  const group = (title, items, render) => {
    if (!items.length) return;
    const h = document.createElement("h3"); h.textContent = title; results.appendChild(h);
    for (const it of items) results.appendChild(render(it));
  };
  group("In the documents", passages, (p) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "result";
    // "Similar meaning": found by what the words mean, not because they appear on the page — say so,
    // so a reader isn't left hunting for a term that isn't there.
    const meaning = p.match === "meaning" ? ' · <span class="tag tag-meaning">Similar meaning</span>' : "";
    b.innerHTML = `<div class="where">${escapeHtml(p.docShort)} · page ${p.page}${meaning}</div><div class="snippet">${escapeHtml(p.snippet)}</div>`;
    b.addEventListener("click", () => { closeSearch(); goTo(p.doc, p.page - 1, { jump: true }); highlightQuery(q); });
    return b;
  });
  group("In your notebook", notes, (n) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "result";
    const kind = (KIND[n.mode] || KIND.research).label;
    b.innerHTML = `<div class="where">${escapeHtml(n.docShort || n.doc)} · p.${n.page} · ${kind}${n.session ? " · " + escapeHtml(n.session) : ""}</div>` +
      `<div class="snippet">${escapeHtml(n.selection)}</div>${n.comment ? `<div class="snippet"><em>My note:</em> ${escapeHtml(n.comment)}</div>` : ""}`;
    b.addEventListener("click", () => { closeSearch(); openNote(n.id); });
    return b;
  });
  if (!passages.length && !notes.length) results.innerHTML = '<div class="empty">Nothing found. Try a different word or a clause number.</div>';
}, 220);

function updateWebButton(q) {
  const btn = $("webSearchBtn");
  const text = (q || "").trim();
  btn.hidden = text.length < 2 || !webAllowed();
  btn.lastChild.textContent = ` Search the web for “${excerpt(text, 40)}”`;
  $("webResults").textContent = "";
}

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
    navigator.serviceWorker.addEventListener("message", (e) => {
      const type = e.data && e.data.type;
      if (type === "SYNC") sync && sync.run();
      // The worker replayed the outbox (or pulled other devices' notes) in the background.
      if (type === "SYNCED" && sync) { reloadNotes(); updateNetChip(); }
    });
    registerPeriodicSync(reg);
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
    const saved = e.target.closest("mark.anchor, .saved");
    if (saved && !tts.playing && getSelection().isCollapsed) openNote(saved.dataset.note);
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
  tts.loadNeural();
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
    // "hidden" is the last event mobile browsers reliably deliver before a tab is discarded.
    else sync.flushOnExit();
  });
  addEventListener("pagehide", () => sync.flushOnExit());

  // Selection toolbar
  document.addEventListener("selectionchange", onSelection);
  toolbar.addEventListener("mousedown", (e) => e.preventDefault()); // keep the selection alive
  $("btnHighlight").addEventListener("click", addHighlight);
  $("btnNote").addEventListener("click", addOwnNote);
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
  $("sessionSelect").addEventListener("change", (e) => {
    store.prefs.set("session", e.target.value);
    renderNotes();
    if (e.target.value) toast(`Working in “${e.target.value}”.`);
  });
  $("newSessionBtn").addEventListener("click", () => {
    $("newSessionForm").hidden = !$("newSessionForm").hidden;
    if (!$("newSessionForm").hidden) $("newSessionName").focus();
  });
  $("newSessionForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("newSessionName").value.replace(/\s+/g, " ").trim().slice(0, 80);
    if (!name) return;
    store.prefs.set("sessions", [...new Set([...store.prefs.get("sessions", []), name])]);
    store.prefs.set("session", name);
    $("newSessionName").value = "";
    $("newSessionForm").hidden = true;
    renderNotes();
    toast(`Session “${name}” created — new work is filed there.`);
  });
  $("webToggle").checked = store.prefs.get("web_research", false);
  $("webToggle").addEventListener("change", (e) => {
    if (e.target.checked && !ensureWebConsent()) { e.target.checked = false; return; }
    store.prefs.set("web_research", e.target.checked);
    toast(e.target.checked ? "Research and Ask will also consult the web (labelled as outside the documents)." : "Research and Ask will use the four documents only.");
  });
  $("insightsToggle").checked = store.prefs.get("insights", true);
  $("insightsToggle").addEventListener("change", (e) => { store.prefs.set("insights", e.target.checked); renderPage({ keepSpeech: tts.playing }); });
  $("askForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = $("askInput").value.replace(/\s+/g, " ").trim();
    if (q.length < 4) { toast("Type a question first."); return; }
    $("askInput").value = "";
    research("ask", q.slice(0, state.limits.max_selection_chars));
  });
  $("askInput").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("askForm").requestSubmit(); } });
  $("nbFilters").addEventListener("click", (e) => { const b = e.target.closest("button[data-f]"); if (b) { nb.filter = b.dataset.f; renderNotes(); } });
  $("nbQuery").addEventListener("input", debounce((e) => { nb.query = e.target.value; renderNotes(); }, 150));
  $("nbOrder").addEventListener("click", () => { nb.order = nb.order === "newest" ? "reading" : "newest"; renderNotes(); });
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
  $("searchInput").addEventListener("input", (e) => { runSearch(e.target.value); updateWebButton(e.target.value); });
  $("webSearchBtn").addEventListener("click", () => searchWeb($("searchInput").value.trim()));

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

/** Download the vectors for offline search-by-meaning once the page is idle (≈2 MB, then cached by
 *  the service worker and revalidated with an ETag). Optional: without it, offline search is BM25. */
async function loadSemantic() {
  try {
    const data = await api("/api/v1/semantic", { timeout: 60000 });
    loadSemanticPack(data);
  } catch { /* not enabled on this server, or offline and never cached */ }
}

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
  (window.requestIdleCallback || ((fn) => setTimeout(fn, 1500)))(() => loadSemantic());
  setInterval(() => navigator.onLine && sync.run(), 60000);
  setInterval(refreshStatus, 60000);
}

boot();
