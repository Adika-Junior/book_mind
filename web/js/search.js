// SPDX-License-Identifier: AGPL-3.0-or-later
// Offline retrieval: the same BM25 + tokenizer as bookmind/common/text.py, running in the browser.
// Used when the network (or the search service) is unavailable, so search and grounded
// "research" keep working on a plane. Keep STOPWORDS and the token regex in sync with Python.

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

export function searchPassages(chunks, query, k = 8, excludeId = null) {
  const { bm25 } = buildIndex(chunks);
  const scores = bm25.scores(query);
  return scores
    .map((score, i) => ({ score, c: chunks[i] }))
    .filter((x) => x.score > 0 && x.c.id !== excludeId)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(({ score, c }) => ({
      id: c.id, doc: c.doc, docShort: c.docShort, docTitle: c.docTitle, page: c.page, score,
      snippet: excerpt(bestSentences(query, c.text, 2).join(" ") || c.text, 320), text: c.text,
    }));
}

export function searchNotes(notes, query, k = 8) {
  const q = new Set(tokenize(query));
  if (!q.size) return [];
  return notes
    .map((n) => {
      const toks = tokenize(`${n.selection} ${n.answer}`);
      const score = toks.filter((w) => q.has(w)).length / (1 + Math.sqrt(toks.length));
      return { n, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(({ n, score }) => ({ id: n.id, doc: n.doc, docShort: n.doc_short, page: n.page, mode: n.mode, selection: excerpt(n.selection, 200), score }));
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
