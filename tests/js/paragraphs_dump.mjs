// SPDX-License-Identifier: AGPL-3.0-or-later
// Driven by tests/test_structure_parity.py: prints each page's body paragraphs as cut by structure.js.
import fs from "node:fs";
import { paragraphs } from "../../web/js/structure.js";

const chunks = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
console.log(JSON.stringify(Object.fromEntries(chunks.map((c) => [c.id, paragraphs(c.text, c.doc)]))));
