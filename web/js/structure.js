// SPDX-License-Identifier: AGPL-3.0-or-later
// Turns raw extracted PDF text into readable structure: headings, paragraphs and list items.
//
// Why: extracted text arrives hard-wrapped (a line break every ~80 characters, sometimes a blank
// line after every line), with ALL-CAPS headings and glyph bullets. Readers scan headings and the
// first words of paragraphs (NN/g "layer-cake" pattern), learn more when structure is signalled
// (Mayer's signaling principle), and read ALL CAPS ~13% slower (Tinker & Paterson). So we rebuild
// paragraphs, promote real headings, give clauses a hanging indent, and set headings in title case.
// See docs/READING-DESIGN.md.

const BULLET = /^[•▪●‣⁃◦\-–·]\s+/;
const MARKER = /^\(([a-z]{1,2}|[ivx]{1,5}|\d{1,3})\)\s+/;
const PART = /^(PART|CHAPTER|SCHEDULE)\s+([IVXLC]+|\d+)\b\s*[—–:-]?\s*(.*)$/i;
const CLAUSE = /^CLAUSE\s+(\d+[A-Z]?)\s*[—–:-]?\s*(.*)$/i;
const NUMBERED = /^((?:\d{1,2}\.){1,4}\d{0,2})\.?\s+([A-Z][^]{2,110})$/;
const TERMINAL = /[.!?;:—–,]$/;
const SMALL_WORDS = new Set("a an and as at but by for from in into of on or the to under with within via per nor".split(" "));

function isAllCaps(s) {
  const letters = s.replace(/[^A-Za-z]/g, "");
  return letters.length >= 4 && letters === letters.toUpperCase();
}

/** "OBLIGATIONS FOR HIGH-RISK AI SYSTEMS" -> "Obligations for High-Risk AI Systems" (acronyms kept). */
export function titleCase(s) {
  if (!isAllCaps(s)) return s;
  return s.toLowerCase().split(/(\s+)/).map((word, i) => {
    if (/^\s+$/.test(word)) return word;
    const orig = s.split(/(\s+)/)[i] || word;
    const bare = orig.replace(/[^A-Za-z]/g, "");
    // Short all-caps tokens that aren't common words are acronyms (AI, ICT, KPI, ODPC).
    if (bare.length > 0 && bare.length <= 4 && !SMALL_WORDS.has(bare.toLowerCase()) && !["PART", "THE", "ACT", "BILL", "LAW", "DATA", "USE", "ROLE", "NEW", "KEY"].includes(bare)) return orig;
    if (i > 0 && SMALL_WORDS.has(word)) return word;
    return word.replace(/(^|[-/(])([a-z])/g, (_, p, c) => p + c.toUpperCase());
  }).join("");
}

function median(nums) {
  if (!nums.length) return 0;
  const a = [...nums].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}

function looksLikeToc(lines) {
  if (lines.some((l) => /^(table of )?contents$/i.test(l.trim()))) return true;
  const withPageNo = lines.filter((l) => /\s\.?\s?\d{1,3}$/.test(l.trim()) && l.trim().length < 90).length;
  return lines.length >= 8 && withPageNo / lines.length > 0.45;
}

function classify(line, docId) {
  let m;
  if ((m = line.match(PART))) {
    // "PART I — PRELIMINARY: 1—Short title. 2—…" (arrangement page): the part's name is the
    // heading; the clause list after the colon is kept as a paragraph beneath it.
    const [name, ...after] = (m[3] || "").replace(/^[—–:-]\s*/, "").split(/:\s/);
    const heading = { type: "sec", num: `${titleCase(m[1].toUpperCase())} ${m[2]}`, text: titleCase(name || "") };
    if (after.length) heading.trailing = after.join(": ");
    return heading;
  }
  if ((m = line.match(CLAUSE))) return { type: "sec", num: `Clause ${m[1]}`, text: titleCase(m[2] || "") };
  if ((m = line.match(NUMBERED)) && line.length <= 110 && !TERMINAL.test(line) && !/\s\d{1,3}$/.test(line)) {
    const depth = m[1].replace(/\.$/, "").split(".").filter(Boolean).length;
    return { type: depth <= 1 ? "sec" : "sub", num: m[1].replace(/\.$/, ""), text: titleCase(m[2].trim()) };
  }
  if (docId === "digest" && /\?$/.test(line) && line.length <= 160 && /^[A-Z]/.test(line)) return { type: "q", text: line };
  if (isAllCaps(line) && line.length <= 90 && !TERMINAL.test(line)) return { type: "sec", text: titleCase(line) };
  return null;
}

// Page furniture from the PDFs: "13 / Kenya AI Strategy", "Kenya AI Strategy | 13", "Page 4 of 20".
const FURNITURE = /^(\d{1,3}\s+[|/]\s+[A-Za-z][^|/]{2,40}|[A-Za-z][^|/]{2,40}\s+[|/]\s+\d{1,3}|page\s+\d+(\s+of\s+\d+)?)$/i;

/** A short Title Case line with no closing punctuation, followed by text, is a subheading. */
function isTitleLine(line, next) {
  if (!next || line.length > 70 || /[.!?;:,]$/.test(line) || /\d{2,}$/.test(line)) return false;
  const words = line.split(" ").filter((w) => /[A-Za-z]/.test(w));
  if (words.length < 2 || words.length > 10) return false;
  const content = words.filter((w) => !SMALL_WORDS.has(w.toLowerCase()));
  const capped = content.filter((w) => /^[A-Z“"(]/.test(w)).length;
  return content.length > 0 && capped / content.length >= 0.8;
}

/**
 * @param {string} text  raw page text
 * @param {string} docId strategy | roadmap | bill | digest
 * @returns {Array<{type:'sec'|'sub'|'q'|'p'|'item'|'toc', text:string, num?:string, marker?:string, depth?:number}>}
 */
export function structure(text, docId = "") {
  const rawLines = text.replace(/\r/g, "").split("\n");
  const lines = rawLines.map((l) => l.replace(/\s+/g, " ").trim());
  const content = lines.filter(Boolean);
  if (looksLikeToc(content)) {
    return [{ type: "toc", text: rawLines.map((l) => l.trim()).filter(Boolean).join("\n") }];
  }
  const typical = median(content.map((l) => l.length)) || 80;
  const blocks = [];
  let cur = null; // open paragraph or list item
  const flush = () => { if (cur && cur.text.trim()) blocks.push(cur); cur = null; };

  let lastHeadingLine = -2;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || FURNITURE.test(line)) continue;
    const next = lines.slice(i + 1).find(Boolean) || "";
    let heading = classify(line, docId);
    if (!heading && (!cur || /[.!?:]["”’)]?$/.test(cur.text)) && isTitleLine(line, next)) heading = { type: "sub", text: line };
    if (heading && !(cur && cur.type === "item" && !TERMINAL.test(cur.text) && heading.type === "sec" && !heading.num)) {
      flush();
      const prev = blocks[blocks.length - 1];
      // A title set over several lines ("KENYA ARTIFICIAL / INTELLIGENCE / STRATEGY") is one heading.
      const prevLine = lines.slice(0, i).map((l, k) => (l ? k : -1)).filter((k) => k >= 0).pop();
      const { trailing, ...head } = heading;
      if (prev && prev.type === head.type && !prev.num && !head.num && lastHeadingLine === prevLine) {
        prev.text = `${prev.text} ${head.text}`;
      } else {
        blocks.push(head);
      }
      if (trailing) blocks.push({ type: "p", text: trailing });
      lastHeadingLine = i;
      continue;
    }
    let m;
    if ((m = line.match(MARKER))) {
      flush();
      const marker = m[1];
      const depth = /^[ivx]+$/.test(marker) && marker !== "i" ? 2 : /^\d+$/.test(marker) ? 1 : (/^[a-z]{1,2}$/.test(marker) ? 1 : 1);
      cur = { type: "item", marker: `(${marker})`, depth, text: line.slice(m[0].length) };
      continue;
    }
    if ((m = line.match(BULLET))) {
      flush();
      cur = { type: "item", marker: "•", depth: 1, text: line.slice(m[0].length) };
      continue;
    }
    if (!cur) { cur = { type: "p", text: line }; continue; }
    // Continuation or new paragraph? A previous line that ends a sentence AND is clearly shorter
    // than the page's typical line was the last line of its paragraph.
    const prev = cur.text;
    const prevLastLine = lines[i - 1] || lines[i - 2] || "";
    const endedSentence = /[.!?:]["”’)]?$/.test(prev);
    const shortPrev = prevLastLine.length < typical * 0.72;
    if (endedSentence && shortPrev && /^[A-Z“"(]/.test(line)) {
      flush();
      cur = { type: "p", text: line };
      continue;
    }
    // A line ending in a hyphen here is almost always a real compound split at the margin
    // ("decision-/making", "real-/time"), so keep the hyphen and join without a space.
    cur.text = /[a-z]-$/.test(prev) && /^[a-z]/.test(line) ? prev + line : `${prev} ${line}`;
  }
  flush();
  return blocks;
}

/** Headings of a whole document, for the sidebar outline, breadcrumbs and "up next". */
export function buildOutline(chunks, docId) {
  const items = [];
  chunks.forEach((c, idx) => {
    for (const b of structure(c.text, docId)) {
      if (b.type !== "sec" && b.type !== "sub" && b.type !== "q") continue;
      const label = [b.num, b.text].filter(Boolean).join(" — ");
      if (!label || label.length < 3) continue;
      const prev = items[items.length - 1];
      if (prev && prev.label === label) continue; // running heads repeated on consecutive pages
      items.push({ idx, level: b.type === "sec" ? 2 : 3, label: label.length > 90 ? label.slice(0, 88) + "…" : label });
    }
  });
  return items;
}

/** The section(s) a page belongs to: nearest level-2 heading at or before it, and a level-3 under it. */
export function sectionAt(outline, idx) {
  let sec = null, sub = null;
  for (const it of outline) {
    if (it.idx > idx) break;
    if (it.level === 2) { sec = it; sub = null; } else sub = it;
  }
  return { sec, sub };
}

/** The first heading after the current page — the "up next" signpost. */
export function nextHeading(outline, idx) {
  return outline.find((it) => it.idx > idx && it.level === 2) || outline.find((it) => it.idx > idx) || null;
}
