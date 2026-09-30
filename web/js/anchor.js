// SPDX-License-Identifier: AGPL-3.0-or-later
// Exact-word highlights, anchored the way the W3C Web Annotation model does it: a text-quote
// selector (the quoted words plus a little context before and after). On each render we find that
// quote in the page again and wrap exactly those characters — even across sentences, list items
// or defined-term links. Whitespace is ignored when matching, because the page is re-flowed.
// https://www.w3.org/TR/annotation-model/#text-quote-selector

const CONTEXT = 32;
const squeeze = (s) => (s || "").replace(/\s+/g, "");

/** A flat, whitespace-free copy of the page text, with a map back to (text node, offset). */
function textIndex(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let flat = "";
  const map = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const t = node.nodeValue;
    for (let i = 0; i < t.length; i++) {
      if (!/\s/.test(t[i])) { flat += t[i]; map.push([node, i]); }
    }
  }
  return { flat, map };
}

/** Context around a selection inside `root`, to disambiguate repeated phrases later. */
export function captureAnchor(root, range) {
  try {
    const before = document.createRange();
    before.setStart(root, 0);
    before.setEnd(range.startContainer, range.startOffset);
    const after = document.createRange();
    after.setStart(range.endContainer, range.endOffset);
    after.setEnd(root, root.childNodes.length);
    return { prefix: squeeze(before.toString()).slice(-CONTEXT), suffix: squeeze(after.toString()).slice(0, CONTEXT) };
  } catch {
    return null;
  }
}

/** Index of the best match of `quote` in `flat`, preferring the one whose context matches. */
export function locate(flat, quote, anchor) {
  const q = squeeze(quote);
  if (!q) return -1;
  let best = -1, bestScore = -1;
  for (let i = flat.indexOf(q); i !== -1; i = flat.indexOf(q, i + 1)) {
    let score = 0;
    if (anchor && anchor.prefix) {
      const want = anchor.prefix.slice(-16);
      if (flat.slice(Math.max(0, i - want.length), i) === want) score += 2;
    }
    if (anchor && anchor.suffix) {
      const want = anchor.suffix.slice(0, 16);
      if (flat.slice(i + q.length, i + q.length + want.length) === want) score += 2;
    }
    if (score > bestScore) { best = i; bestScore = score; }
    if (score === 4) break;
  }
  return best;
}

function wrap(map, start, end, note) {
  // Group the matched characters by text node, then wrap each node's slice in a <mark>.
  const byNode = new Map();
  for (let k = start; k <= end; k++) {
    const [node, off] = map[k];
    const r = byNode.get(node) || [off, off];
    byNode.set(node, [Math.min(r[0], off), Math.max(r[1], off)]);
  }
  let first = null;
  for (const [node, [a, b]] of byNode) {
    if (!node.parentNode) continue;
    const range = document.createRange();
    range.setStart(node, a);
    range.setEnd(node, b + 1);
    const mark = document.createElement("mark");
    mark.className = `anchor ${note.mode === "note" ? "note" : "hl"}`;
    mark.dataset.note = note.id;
    mark.title = note.mode === "note" ? "Your note — tap to open" : "Your highlight — tap to open";
    range.surroundContents(mark);
    first = first || mark;
  }
  return first;
}

export function clearAnchors(root) {
  root.querySelectorAll("mark.anchor").forEach((m) => m.replaceWith(...m.childNodes));
  root.normalize();
}

/** Paint notes onto the page. Returns the notes that could not be located exactly. */
export function paintAnchors(root, notes) {
  clearAnchors(root);
  const missed = [];
  for (const n of notes) {
    const { flat, map } = textIndex(root); // rebuilt each time: wrapping splits text nodes
    const i = locate(flat, n.selection, n.anchor);
    if (i < 0) { missed.push(n); continue; }
    wrap(map, i, i + squeeze(n.selection).length - 1, n);
  }
  return missed;
}
