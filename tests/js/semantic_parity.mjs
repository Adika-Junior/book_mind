// SPDX-License-Identifier: AGPL-3.0-or-later
// Driven by tests/test_semantic.py: ranks queries with the browser's offline search (search.js +
// the semantic pack) and prints the top page ids, so Python can compare them with the server.
import fs from "node:fs";
import { loadSemanticPack, searchPassages } from "../../web/js/search.js";

const [packPath, chunksPath, queriesPath] = process.argv.slice(2);
const chunks = JSON.parse(fs.readFileSync(chunksPath, "utf8"));
if (!loadSemanticPack(JSON.parse(fs.readFileSync(packPath, "utf8")))) throw new Error("pack not loaded");
const out = {};
for (const q of JSON.parse(fs.readFileSync(queriesPath, "utf8"))) {
  out[q] = searchPassages(chunks, q, 10).map((r) => [r.id, r.match]);
}
console.log(JSON.stringify(out));
