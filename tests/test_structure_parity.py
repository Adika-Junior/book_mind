# SPDX-License-Identifier: AGPL-3.0-or-later
"""Server and browser must number paragraphs identically, or "[Bill, p.11 ¶3]" lands on the wrong one."""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from bookmind.common.structure import blocks, cite, doc_of, paragraphs

ROOT = Path(__file__).resolve().parents[1]
CHUNKS = json.loads((ROOT / "data" / "chunks.json").read_text(encoding="utf-8"))


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_every_page_has_the_same_paragraphs_in_python_and_javascript():
    out = subprocess.run(  # noqa: S603 — fixed argv, test-only
        [shutil.which("node"), str(ROOT / "tests/js/paragraphs_dump.mjs"), str(ROOT / "data/chunks.json")],
        check=True, capture_output=True, text=True, timeout=120,
    )
    browser = json.loads(out.stdout)
    mismatched = [c["id"] for c in CHUNKS if paragraphs(c["text"], c["doc"]) != browser[c["id"]]]
    assert not mismatched, f"{len(mismatched)} page(s) differ, e.g. {mismatched[:5]}"


def test_bill_clause_items_are_paragraphs_and_headings_are_not():
    page = next(c for c in CHUNKS if c["id"] == "bill-10")
    kinds = [b["type"] for b in blocks(page["text"], "bill")]
    paras = paragraphs(page["text"], "bill")
    assert "sec" in kinds and "item" in kinds
    assert not any(p.startswith("CLAUSE ") for p in paras)
    assert any("synthetic media" in p for p in paras)


def test_cite_and_doc_of():
    assert cite("Bill", 11, 3) == "[Bill, p.11 ¶3]" and cite("Bill", 11) == "[Bill, p.11]"
    assert doc_of("bill-12") == "bill" and doc_of(None) == ""
