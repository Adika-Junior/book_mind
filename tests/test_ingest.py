# SPDX-License-Identifier: AGPL-3.0-or-later
"""PDF ingestion, on real (generated) PDFs."""
import json
import sys
from pathlib import Path

import pytest

pytest.importorskip("pypdf")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import ingest  # noqa: E402


def write_pdf(path: Path, pages: list[list[str]]) -> None:
    """A minimal, valid PDF with one Helvetica text line per list item."""
    objs = ["<< /Type /Catalog /Pages 2 0 R >>", None, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    kids = []
    for lines in pages:
        esc = [ln.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)") for ln in lines]
        body = "BT /F1 11 Tf 72 740 Td " + " ".join(f"({t}) Tj 0 -16 Td" for t in esc) + " ET"
        objs.append(f"<< /Length {len(body)} >>\nstream\n{body}\nendstream")
        content = len(objs)
        objs.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {content} 0 R /Resources << /Font << /F1 3 0 R >> >> >>")
        kids.append(len(objs))
    objs[1] = f"<< /Type /Pages /Kids [{' '.join(f'{k} 0 R' for k in kids)}] /Count {len(kids)} >>"
    out, offsets = b"%PDF-1.4\n", []
    for i, obj in enumerate(objs, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n{obj}\nendobj\n".encode("latin-1")
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    out += b"".join(f"{o:010d} 00000 n \n".encode() for o in offsets)
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    path.write_bytes(out)


def page(n: int, *body: str) -> list[str]:
    return ["Kenya AI Strategy 2025-2030", *body, f"{n} / Kenya AI Strategy"]


@pytest.fixture
def manifest(tmp_path: Path) -> Path:
    write_pdf(tmp_path / "strategy.pdf", [
        page(1, "1. INTRODUCTION", "Kenya aims to become a leading AI hub in Africa by 2030."),
        page(2, "The strategy has three pillars: infrastructure, data and talent."),
        [],  # a scanned page: no text layer
        page(4, "Implementation will be coordinated by the Ministry."),
        page(5, "Progress will be reviewed every two years."),
    ])
    write_pdf(tmp_path / "bill.pdf", [
        ["CLAUSE 1 - SHORT TITLE", "This Act may be cited as the Artificial Intelligence Act, 2026."],
        ["CLAUSE 2 - INTERPRETATION", "(a) \"deployer\" means a person who puts an AI system into service;"],
    ])
    m = tmp_path / "docs.json"
    m.write_text(json.dumps([
        {"doc": "strategy", "title": "Kenya AI Strategy", "short": "Strategy", "pdf": "strategy.pdf"},
        {"doc": "bill", "title": "The AI Bill", "short": "Bill", "pdf": "bill.pdf"},
    ]))
    return m


def test_builds_pages_in_the_apps_format(manifest):
    chunks, reports = ingest.build(manifest)
    existing = json.loads((Path(__file__).resolve().parents[1] / "data" / "chunks.json").read_text())[0]
    assert set(chunks[0]) == set(existing)  # same schema the catalog serves today
    assert [c["id"] for c in chunks] == ["strategy-0", "strategy-1", "strategy-2", "strategy-3", "bill-4", "bill-5"]
    assert [c["page"] for c in chunks if c["doc"] == "bill"] == [1, 2]
    assert "leading AI hub" in chunks[0]["text"] and chunks[0]["words"] > 5


def test_removes_running_headers_and_numbered_footers(manifest):
    chunks, reports = ingest.build(manifest)
    strategy = [c["text"] for c in chunks if c["doc"] == "strategy"]
    assert not any("Kenya AI Strategy 2025-2030" in t for t in strategy)
    assert not any("/ Kenya AI Strategy" in t for t in strategy)
    assert len(reports[0]["running_lines"]) == 2


def test_flags_scanned_pages_instead_of_emitting_blank_ones(manifest):
    chunks, reports = ingest.build(manifest)
    assert reports[0]["scanned"] == [3] and reports[0]["kept"] == 4


def test_output_feeds_the_reader_structure(manifest, tmp_path):
    chunks, _ = ingest.build(manifest)
    out = tmp_path / "chunks.json"
    out.write_text(json.dumps(chunks))
    bill = [c for c in chunks if c["doc"] == "bill"]
    assert bill[0]["text"].startswith("CLAUSE 1")  # structure.js turns this into a clause heading


def test_clean_repairs_extraction_damage():
    assert ingest.clean("eﬃcient de­ployment\x07 of AI  \n\n\n\nNext") == "efficient deployment of AI\n\nNext"


def test_rejects_bad_manifests(tmp_path):
    m = tmp_path / "m.json"
    m.write_text(json.dumps([{"doc": "Bad Id", "title": "t", "short": "s", "pdf": "x.pdf"}]))
    with pytest.raises(SystemExit, match="doc id"):
        ingest.build(m)
    m.write_text(json.dumps([{"doc": "ok", "title": "t", "short": "s", "pdf": "missing.pdf"}]))
    with pytest.raises(SystemExit, match="not found"):
        ingest.build(m)
