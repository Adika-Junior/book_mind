// SPDX-License-Identifier: AGPL-3.0-or-later
// "Worth noting" — on-device recommendations for the page you're reading. No network, no model.
//
//  * Key points: sentences that carry obligations, penalties, deadlines, figures, rights or
//    powers — what a careful reader of a law or a strategy would underline. Signalling the
//    important parts of a text improves learning (Mayer's signaling principle).
//  * Cross-references: "section 26" / "clause 5" become jump links to that clause.
//  * Related elsewhere: the passages in the *other* documents most similar to this page (e.g. the
//    Digest's plain-English summary of a Bill clause) — lateral reading inside the corpus.
//  * From your notebook: your own notes connected to this page.

import { excerpt, searchPassages, tokenize } from "./search.js";

const KINDS = [
  { kind: "penalty", label: "Penalty", re: /\b(offence|fine[sd]?|imprison\w*|penalt\w*|liable|sanction\w*|revok\w*|suspen\w*)\b/i, weight: 5 },
  { kind: "obligation", label: "Obligation", re: /\b(shall|must|is required to|are required to|obliged to|ensure that)\b/i, weight: 4 },
  { kind: "deadline", label: "Timeline", re: /\b(within \w+ (days?|weeks?|months?|years?)|not later than|at least \w+ (days?|months?|years?)|by (20\d\d|the end of)|(19|20)\d\d\s*[-–]\s*(19|20)\d\d|annual(ly)?|every \w+ years?)\b/i, weight: 3 },
  { kind: "figure", label: "Figure", re: /\b(KES|KSh|Ksh|shillings?|USD|US\$|\d+(\.\d+)?\s?(%|per ?cent|million|billion))\b/i, weight: 3 },
  { kind: "right", label: "Right / protection", re: /\b(right to|rights of|consent|protect\w*|redress|appeal|complain\w*|human rights|non-discriminat\w*)\b/i, weight: 3 },
  { kind: "power", label: "Power / role", re: /\b(may (issue|make|prescribe|appoint|establish|delegate)|shall (establish|appoint|prescribe)|responsible for|functions? of)\b/i, weight: 2 },
];
const XREF = /\b(section|clause|article)\s+(\d{1,3}[A-Z]?)(\(\d+\))?/gi;

/**
 * @param {HTMLElement} body  the rendered page body (sentences carry data-si)
 * @param {string} docId
 * @returns {{points: Array, xrefs: Array}}
 */
export function worthNoting(body, docId) {
  const scored = [];
  for (const span of body.querySelectorAll(".sentence")) {
    if (span.closest("h2, h3")) continue; // headings are already signposts
    const text = span.textContent.replace(/\s+/g, " ").trim();
    if (text.length < 40 || text.length > 600) continue;
    const kinds = KINDS.filter((k) => k.re.test(text));
    if (!kinds.length) continue;
    const top = kinds.sort((a, b) => b.weight - a.weight)[0];
    scored.push({ si: Number(span.dataset.si), text, kind: top.kind, label: top.label, score: kinds.reduce((a, k) => a + k.weight, 0) });
  }
  // Prefer variety: best of each kind first, then the next strongest, max 5.
  const byKind = new Map();
  for (const s of [...scored].sort((a, b) => b.score - a.score)) if (!byKind.has(s.kind)) byKind.set(s.kind, s);
  const picks = [...byKind.values()];
  for (const s of [...scored].sort((a, b) => b.score - a.score)) {
    if (picks.length >= 5) break;
    if (!picks.includes(s)) picks.push(s);
  }
  const points = picks.slice(0, 5).sort((a, b) => a.si - b.si);

  const xrefs = [];
  if (docId === "bill" || docId === "digest") {
    const seen = new Set();
    for (const m of body.textContent.matchAll(XREF)) {
      const n = m[2].toUpperCase();
      if (seen.has(n)) continue;
      seen.add(n);
      xrefs.push({ label: `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${n}`, clause: n });
      if (xrefs.length >= 6) break;
    }
  }
  return { points, xrefs };
}

// Distinctive terms of a page: frequent here, rare across the corpus (tf-idf).
let df = null;
function docFreq(chunks) {
  if (df && df.chunks === chunks) return df;
  const map = new Map();
  for (const c of chunks) for (const w of new Set(tokenize(c.text))) map.set(w, (map.get(w) || 0) + 1);
  df = { chunks, map, n: chunks.length };
  return df;
}

export function keyTerms(chunks, chunk, k = 8) {
  const { map, n } = docFreq(chunks);
  const tf = new Map();
  for (const w of tokenize(chunk.text)) tf.set(w, (tf.get(w) || 0) + 1);
  return [...tf.entries()]
    .map(([w, f]) => [w, f * Math.log(n / (1 + (map.get(w) || 0)))])
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([w]) => w);
}

/** Passages in the other documents most like this page. */
export function relatedElsewhere(chunks, chunk, k = 3) {
  const terms = keyTerms(chunks, chunk);
  if (!terms.length) return [];
  return searchPassages(chunks, terms.join(" "), 12, chunk.id)
    .filter((r) => r.doc !== chunk.doc)
    .slice(0, k)
    .map((r) => ({ ...r, snippet: excerpt(r.snippet, 200) }));
}

/** Your notes that belong to, or talk about, this page. */
export function relatedNotes(notes, chunk, page, k = 3) {
  const terms = new Set(keyTerms([chunk], chunk, 12));
  return notes
    .filter((n) => n.status === "done")
    .map((n) => {
      const cites = (n.related || []).some((r) => r.id === chunk.id);
      const overlap = tokenize(`${n.selection} ${n.comment || ""}`).filter((w) => terms.has(w)).length;
      return { n, score: (cites ? 3 : 0) + overlap };
    })
    // Notes made on this very page are already marked in the text, so they aren't repeated here.
    .filter((x) => x.score >= 3 && !(x.n.doc === chunk.doc && x.n.page === page))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((x) => x.n);
}
