// SPDX-License-Identifier: AGPL-3.0-or-later
// Offline retrieval: the same BM25 + tokenizer as bookmind/common/text.py, running in the browser,
// plus search by meaning from a downloaded "semantic pack" (see loadSemanticPack). Used when the
// network (or the search service) is unavailable, so search and grounded "research" keep working on
// a plane. Keep STOPWORDS, the token regex and the fusion in sync with Python (services/search.py).

const STOPWORDS = new Set((
  "the a an of to in on for and or is are was were be by with as at from this that " +
  "shall which it its their they he she who whom will would may not no into within under over about " +
  "such other any all each per than then also has have had if but so these those subsection section clause"
).split(" "));

export function tokenize(text) {
  return ((text || "").toLowerCase().match(/[a-z][a-z-]{2,}/g) || []).filter((w) => !STOPWORDS.has(w));
}

export const squash = (t) => (t || "").replace(/\s+/g, " ").trim();
export const excerpt = (t, n) => { t = squash(t); return t.length <= n ? t : t.slice(0, n - 1).trimEnd() + "…"; };
export const sentences = (t) => (squash(t).match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) || []).map((s) => s.trim()).filter((s) => s.length > 2);

export class BM25 {
  constructor(docs, k1 = 1.5, b = 0.75) {
    this.k1 = k1; this.b = b;
    this.docs = docs.map((d) => tokenize(d));
    this.len = this.docs.map((d) => d.length);
    this.avg = this.len.reduce((a, x) => a + x, 0) / Math.max(1, this.len.length);
    this.tf = this.docs.map((d) => { const m = new Map(); for (const w of d) m.set(w, (m.get(w) || 0) + 1); return m; });
    const df = new Map();
    for (const m of this.tf) for (const w of m.keys()) df.set(w, (df.get(w) || 0) + 1);
    const n = this.docs.length;
    // rank_bm25's Okapi idf, including its epsilon floor for very common terms.
    this.idf = new Map();
    let sum = 0; const neg = [];
    for (const [w, f] of df) { const v = Math.log(n - f + 0.5) - Math.log(f + 0.5); this.idf.set(w, v); sum += v; if (v < 0) neg.push(w); }
    const eps = 0.25 * (sum / Math.max(1, df.size));
    for (const w of neg) this.idf.set(w, eps);
  }
  scores(query) {
    const q = tokenize(query);
    return this.tf.map((m, i) => {
      let s = 0;
      for (const w of q) {
        const f = m.get(w); if (!f) continue;
        s += (this.idf.get(w) || 0) * (f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + this.b * this.len[i] / this.avg));
      }
      return s;
    });
  }
}

let index = null;
export function buildIndex(chunks) {
  if (!index || index.chunks !== chunks) index = { chunks, bm25: new BM25(chunks.map((c) => c.text)) };
  return index;
}

export function bestSentences(query, text, n = 2) {
  const q = new Set(tokenize(query));
  return sentences(text)
    .map((s, i) => ({ s, i, o: tokenize(s).filter((w) => q.has(w)).length }))
    .filter((x) => x.o > 0)
    .sort((a, b) => b.o - a.o || a.i - b.i)
    .slice(0, n)
    .map((x) => x.s);
}

/* ------------------------------------------------------------------ search by meaning, offline
 * The server's static embedding model (WordLlama; bookmind/common/embed.py) is just a table of token
 * vectors: a text's embedding is the mean of its tokens' vectors. The pack carries that table for
 * ~23k alphanumeric tokens (64 dims, int8) and the vectors of every ~60-word window of every page, so
 * the browser can embed a query and rank pages by meaning with no server and no model runtime. */

let pack = null;
const b64ToInt8 = (b64) => { const bin = atob(b64); const out = new Int8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = (bin.charCodeAt(i) << 24) >> 24; return out; };

export function loadSemanticPack(p) {
  if (!p || !p.vocab) return false;
  const vocab = new Map(p.vocab.map((t, i) => [t, i]));
  let maxLen = 0;
  for (const t of p.vocab) maxLen = Math.max(maxLen, t.length);
  pack = {
    version: p.version, model: p.model, dim: p.dim, vocab, maxLen,
    tokens: b64ToInt8(p.tokens), tokenScale: Float32Array.from(p.token_scale),
    windows: b64ToInt8(p.windows), windowScale: Float32Array.from(p.window_scale),
    owners: Int32Array.from(p.owners), chunkIds: p.chunk_ids,
  };
  return true;
}
export const semanticReady = () => !!pack;
export const semanticModel = () => pack && pack.model;

/** Greedy longest-match tokenisation against the pack's vocabulary (≈ the model's BPE for words). */
function wordPieces(word) {
  const s = "▁" + word;
  const ids = [];
  for (let i = 0; i < s.length;) {
    let j = Math.min(s.length, i + pack.maxLen);
    for (; j > i; j--) { const id = pack.vocab.get(s.slice(i, j)); if (id !== undefined) { ids.push(id); break; } }
    i = j > i ? j : i + 1; // unknown character: skip it
  }
  return ids;
}

/** Same gate as SemanticIndex.meaningful: most words must be real words, not keyboard mash. */
function meaningful(words, corpusVocab) {
  if (!words.length) return false;
  const known = words.filter((w) => corpusVocab.has(w) || (() => { const n = wordPieces(w).length; return n && w.length / n >= 3; })()).length;
  return 2 * known >= words.length;
}

function embedQuery(query) {
  const words = (query.replace(/'s\b/g, "").match(/[A-Za-z0-9]+/g) || []); // case kept, like the model's tokenizer
  const v = new Float32Array(pack.dim);
  let n = 0;
  for (const w of words) for (const id of wordPieces(w)) {
    const scale = pack.tokenScale[id], off = id * pack.dim;
    for (let d = 0; d < pack.dim; d++) v[d] += pack.tokens[off + d] * scale;
    n++;
  }
  if (!n) return null;
  let norm = 0;
  for (let d = 0; d < pack.dim; d++) norm += v[d] * v[d];
  norm = Math.sqrt(norm) || 1;
  for (let d = 0; d < pack.dim; d++) v[d] /= norm;
  return v;
}

/** Best window similarity per chunk (aligned to `chunks`), or null if the pack doesn't fit. */
function semanticScores(chunks, query, corpusVocab) {
  if (!pack) return null;
  const words = (query.toLowerCase().replace(/'s\b/g, "").match(/[a-z]{3,}/g) || []);
  if (!meaningful(words, corpusVocab)) return null;
  const q = embedQuery(query);
  if (!q) return null;
  const pos = new Map(chunks.map((c, i) => [c.id, i]));
  const best = new Float32Array(chunks.length).fill(-1);
  const bestWin = new Int32Array(chunks.length).fill(-1);
  let hits = 0;
  for (let w = 0; w < pack.owners.length; w++) {
    const i = pos.get(pack.chunkIds[pack.owners[w]]);
    if (i === undefined) continue;
    hits++;
    let dot = 0; const off = w * pack.dim;
    for (let d = 0; d < pack.dim; d++) dot += pack.windows[off + d] * q[d];
    dot *= pack.windowScale[w];
    if (dot > best[i]) { best[i] = dot; bestWin[i] = w; }
  }
  return hits ? { best, bestWin } : null;
}

const SEMANTIC_WEIGHT = 0.7, MIN_SIMILARITY = 0.2, RELATIVE_SIMILARITY = 0.8;
// Tables of contents match everything and help least: rank them below what they point to (as the server does).
const NAV_PAGE = /ARRANGEMENT OF (CLAUSES|SECTIONS)|TABLE OF CONTENTS|^\s*Contents\b/i, NAV_PRIOR = 0.8;

export function searchPassages(chunks, query, k = 8, excludeId = null, { mode = "hybrid" } = {}) {
  const idx = buildIndex(chunks);
  const bm = mode === "semantic" ? chunks.map(() => 0) : idx.bm25.scores(query);
  if (!idx.vocab) idx.vocab = new Set(idx.bm25.docs.flat());
  if (!idx.prior) idx.prior = chunks.map((c) => (NAV_PAGE.test(squash(c.text).slice(0, 300)) ? NAV_PRIOR : 1));
  const sem = mode === "keyword" ? null : semanticScores(chunks, query, idx.vocab);
  let combined = bm, eligible = bm.map((s) => s > 0);
  if (sem) {
    const bmax = Math.max(...bm), smax = Math.max(...sem.best), smin = Math.min(...sem.best);
    const w = mode === "semantic" ? 1 : SEMANTIC_WEIGHT;
    combined = bm.map((b, i) => w * (sem.best[i] - smin) / (smax - smin + 1e-9) + (1 - w) * (bmax > 0 ? b / bmax : 0));
    eligible = bm.map((b, i) => b > 0 || (sem.best[i] >= MIN_SIMILARITY && sem.best[i] >= RELATIVE_SIMILARITY * smax));
  }
  return combined
    .map((score, i) => ({ score: score * idx.prior[i], i, c: chunks[i] }))
    .filter((x) => eligible[x.i] && x.c.id !== excludeId)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(({ score, i, c }) => {
      let words = bestSentences(query, c.text, 2).join(" ");
      if (!words && sem && sem.bestWin[i] >= 0) words = windowText(c.text, sem.bestWin[i]);
      return {
        id: c.id, doc: c.doc, docShort: c.docShort, docTitle: c.docTitle, page: c.page, score,
        match: bm[i] <= 0 ? "meaning" : sem ? "both" : "words",
        snippet: excerpt(words || c.text, 320), text: c.text,
      };
    });
}

/** Rebuild the matching window's text (same 60-word/30-stride windows as the server). */
function windowText(text, winIndex) {
  let first = winIndex;
  while (first > 0 && pack.owners[first - 1] === pack.owners[winIndex]) first--;
  const words = text.split(/\s+/).filter(Boolean);
  const start = (winIndex - first) * 30;
  return words.slice(start, start + 60).join(" ");
}

export function searchNotes(notes, query, k = 8) {
  const q = new Set(tokenize(query));
  if (!q.size) return [];
  return notes
    .map((n) => {
      const toks = tokenize(`${n.selection} ${n.answer || ""} ${n.comment || ""} ${n.session || ""}`);
      const score = toks.filter((w) => q.has(w)).length / (1 + Math.sqrt(toks.length));
      return { n, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(({ n, score }) => ({ id: n.id, doc: n.doc, docShort: n.doc_short, page: n.page, mode: n.mode, selection: excerpt(n.selection, 200), comment: excerpt(n.comment || "", 160), session: n.session || "", score }));
}

const DEF_RE = /[“"]([^”"]{2,60})[”"]\s+(means|has the meaning|includes)\s+([^;]{5,400})/g;
let defsCache = null;
export function definitions(chunks) {
  if (defsCache && defsCache.chunks === chunks) return defsCache.defs;
  const seen = new Set(); const defs = [];
  for (const c of chunks) {
    for (const m of c.text.matchAll(DEF_RE)) {
      const key = m[1].trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      defs.push({ term: m[1].trim(), definition: `${m[2]} ${squash(m[3])}`, docShort: c.docShort, page: c.page, doc: c.doc });
    }
  }
  defsCache = { chunks, defs };
  return defs;
}

/** Grounded answer without a model — same shape as the server's extractive fallback. */
export function extractiveAnswer(mode, selection, chunks, reason, excludeId = null) {
  const related = searchPassages(chunks, selection, 4, excludeId);
  const sel = selection.toLowerCase();
  const selTokens = new Set(tokenize(selection));
  const defs = definitions(chunks).filter((d) => {
    const t = tokenize(d.term);
    return sel.includes(d.term.toLowerCase()) || (t.length && t.every((w) => selTokens.has(w)));
  });
  const parts = [];
  if (defs.length) {
    parts.push("## Defined terms");
    for (const d of defs.slice(0, 6)) parts.push(`- **${d.term}** ${excerpt(d.definition, 360)} [${d.docShort}, p.${d.page}]`);
  }
  if (related.length) {
    parts.push(mode === "research" ? "## What the documents say" : "## Related wording elsewhere");
    for (const r of related) {
      const picks = bestSentences(selection, r.text, 2);
      if (picks.length) parts.push(`- ${excerpt(picks.join(" "), 420)} [${r.docShort}, p.${r.page}]`);
    }
  }
  if (!defs.length && !related.length) parts.push("No closely related passages or defined terms were found in these documents.");
  parts.push(`\n_Extractive note — quoted from the documents without a language model (${reason})._`);
  return {
    answer: parts.join("\n"),
    related: related.map((r) => ({ id: r.id, docShort: r.docShort, page: r.page })),
    source: "offline",
    model: null,
  };
}
