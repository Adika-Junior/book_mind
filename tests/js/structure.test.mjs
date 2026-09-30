// SPDX-License-Identifier: AGPL-3.0-or-later
// node --test tests/js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildOutline, nextHeading, sectionAt, structure, titleCase } from "../../web/js/structure.js";

const chunks = JSON.parse(readFileSync(new URL("../../data/chunks.json", import.meta.url), "utf8"));
const byId = Object.fromEntries(chunks.map((c) => [c.id, c]));

test("title-cases ALL-CAPS headings but keeps acronyms", () => {
  assert.equal(titleCase("OBLIGATIONS FOR HIGH-RISK ARTIFICIAL INTELLIGENCE SYSTEMS"), "Obligations for High-Risk Artificial Intelligence Systems");
  assert.equal(titleCase("THE ROLE OF ICT AND AI IN KENYA"), "The Role of ICT and AI in Kenya");
  assert.equal(titleCase("Already Mixed Case"), "Already Mixed Case");
});

test("a Bill clause becomes a heading plus hanging-indent items", () => {
  const blocks = structure(byId["bill-8"].text, "bill");
  assert.deepEqual(blocks[0], { type: "sec", num: "Clause 26", text: "Obligations for High-Risk Artificial Intelligence Systems" });
  const items = blocks.filter((b) => b.type === "item").map((b) => b.marker);
  assert.deepEqual(items.slice(0, 4), ["(1)", "(a)", "(b)", "(c)"]);
});

test("Digest questions become signposts", () => {
  const qs = structure(byId["digest-21"].text, "digest").filter((b) => b.type === "q");
  assert.ok(qs.length >= 3);
  assert.ok(qs.every((q) => q.text.endsWith("?")));
});

test("hard-wrapped Roadmap lines are reflowed into paragraphs", () => {
  const blocks = structure(byId["roadmap-119"].text, "roadmap");
  const paras = blocks.filter((b) => b.type === "p");
  const rawLines = byId["roadmap-119"].text.split("\n").filter((l) => l.trim()).length;
  assert.ok(paras.length < rawLines / 3, `expected reflow, got ${paras.length} paragraphs from ${rawLines} lines`);
  assert.ok(paras.some((p) => p.text.length > 300));
});

test("glyph bullets become list items and page furniture is dropped", () => {
  const blocks = structure(byId["roadmap-188"].text, "roadmap");
  assert.ok(blocks.filter((b) => b.type === "item" && b.marker === "•").length >= 5);
  const all = chunks.flatMap((c) => structure(c.text, c.doc));
  assert.ok(!all.some((b) => /^\d{1,3}\s*\/\s*Kenya AI Strategy$/.test(b.text)));
});

test("every page still renders all of its words (nothing lost in restructuring)", () => {
  for (const c of chunks) {
    // Case-insensitive (headings are re-cased); up to 3 words may go with a dropped page footer.
    const words = (t) => (t.toLowerCase().match(/[a-z]{4,}/g) || []);
    const bag = {};
    structure(c.text, c.doc).forEach((b) => words(`${b.num || ""} ${b.text}`).forEach((w) => { bag[w] = (bag[w] || 0) + 1; }));
    const lost = words(c.text).filter((w) => !(bag[w]-- > 0));
    assert.ok(lost.length <= 3, `${c.id} lost: ${lost.join(", ")}`);
  }
});

test("outline, section lookup and up-next agree", () => {
  const bill = chunks.filter((c) => c.doc === "bill");
  const outline = buildOutline(bill, "bill");
  assert.ok(outline.some((o) => o.label.startsWith("Part I — Preliminary")));
  const { sec } = sectionAt(outline.filter((o) => o.idx < 8), 8); // entering page 9 (bill-8)
  assert.match(sec.label, /^Clause 25/);
  assert.ok(nextHeading(outline, 8).idx > 8);
});
