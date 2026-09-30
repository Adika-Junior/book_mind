#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Turn PDFs into BookMind's page data (data/chunks.json).

    python tools/ingest.py docs.json                  # build data/chunks.json from a manifest
    python tools/ingest.py docs.json --out /tmp/x.json --report report.json
    python tools/ingest.py docs.json --ocr            # OCR scanned pages (needs pdftoppm + tesseract)

Manifest (JSON), in reading order:

    [
      {"doc": "strategy", "title": "Kenya Artificial Intelligence Strategy 2025-2030",
       "short": "Strategy", "pdf": "sources/kenya-ai-strategy.pdf"},
      {"doc": "bill", "title": "The Artificial Intelligence Bill, 2026 (Senate Bill No. 4)",
       "short": "Bill", "pdf": "sources/ai-bill-2026.pdf", "skip_pages": [1]}
    ]

What it does to each page (docs/rag-digital-book-architecture.md §3):
  * extracts the text layer with pypdf (pure Python; never executes PDF JavaScript);
  * repairs common extraction damage: ligatures (ﬁ → fi), soft hyphens, control characters,
    non-breaking spaces, trailing whitespace;
  * removes running headers/footers — lines that repeat at the top or bottom of most pages,
    with page numbers normalised so "12 / Kenya AI Strategy" and "13 / Kenya AI Strategy" match;
  * flags pages with no usable text layer (scans) and, with --ocr, recognises them with Tesseract.
Structure (headings, clauses, lists) is rebuilt at read time by web/js/structure.js, so the text
here keeps its line breaks.

PDFs are untrusted input: size and page limits are enforced, and a page that fails to parse is
reported and skipped instead of aborting the whole build.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MAX_BYTES = 100 * 1024 * 1024
MAX_PAGES = 2000
MIN_TEXT_CHARS = 40  # below this a page is treated as a scan (no usable text layer)

LIGATURES = {"ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl", "ﬅ": "st", "ﬆ": "st"}
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_DIGITS = re.compile(r"\d+")


def clean(text: str) -> str:
    """Repair typical PDF text-extraction damage without changing the words."""
    for bad, good in LIGATURES.items():
        text = text.replace(bad, good)
    text = text.replace("­", "")  # soft hyphen
    text = text.replace(" ", " ").replace(" ", " ").replace(" ", " ").replace(" ", " ")
    text = _CONTROL.sub("", text)
    text = unicodedata.normalize("NFC", text)
    lines = [ln.rstrip() for ln in text.replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    # Collapse runs of blank lines to one; structure.js decides paragraphs.
    out, blank = [], False
    for ln in lines:
        if not ln.strip():
            if not blank and out:
                out.append("")
            blank = True
            continue
        out.append(ln)
        blank = False
    return "\n".join(out).strip()


def _signature(line: str) -> str:
    return _DIGITS.sub("#", line.strip().lower())


def strip_running_lines(pages: list[str], edge: int = 2, threshold: float = 0.5) -> tuple[list[str], list[str]]:
    """Remove lines that recur at the top/bottom of at least `threshold` of pages."""
    if len(pages) < 4:
        return pages, []
    counts: Counter[str] = Counter()
    for text in pages:
        lines = [ln for ln in text.split("\n") if ln.strip()]
        for sig in {_signature(ln) for ln in lines[:edge] + lines[-edge:]}:
            counts[sig] += 1
    running = {sig for sig, n in counts.items() if n / len(pages) >= threshold and len(sig) <= 80 and sig.strip("# ")}
    if not running:
        return pages, []
    cleaned = []
    for text in pages:
        lines = text.split("\n")
        idx = [i for i, ln in enumerate(lines) if ln.strip()]
        drop = {i for i in idx[:edge] + idx[-edge:] if _signature(lines[i]) in running}
        cleaned.append("\n".join(ln for i, ln in enumerate(lines) if i not in drop).strip())
    return cleaned, sorted(running)


def ocr_page(pdf: Path, page_number: int) -> str | None:
    """OCR one page with pdftoppm + tesseract (both free/open source). None if unavailable."""
    pdftoppm, tesseract = shutil.which("pdftoppm"), shutil.which("tesseract")
    if not (pdftoppm and tesseract):
        return None
    with tempfile.TemporaryDirectory() as tmp:
        prefix = Path(tmp) / "p"
        # Fixed argument lists, resolved executables, no shell: nothing from the PDF reaches a command line.
        subprocess.run(  # noqa: S603
            [pdftoppm, "-r", "300", "-f", str(page_number), "-l", str(page_number), "-png", str(pdf), str(prefix)],
            check=True, capture_output=True, timeout=120,
        )
        images = sorted(Path(tmp).glob("p*.png"))
        if not images:
            return None
        result = subprocess.run(  # noqa: S603
            [tesseract, str(images[0]), "-", "-l", "eng"], check=True, capture_output=True, timeout=120, text=True
        )
        return result.stdout


def extract(entry: dict, base: Path, use_ocr: bool) -> tuple[list[dict], dict]:
    from pypdf import PdfReader  # imported here so the rest of the module works without it

    pdf = (base / entry["pdf"]).resolve()
    report = {"doc": entry["doc"], "pdf": str(entry["pdf"]), "pages": 0, "kept": 0, "scanned": [], "ocr": [], "errors": [], "running_lines": []}
    if not pdf.is_file():
        raise SystemExit(f"{entry['doc']}: file not found: {pdf}")
    if pdf.stat().st_size > MAX_BYTES:
        raise SystemExit(f"{entry['doc']}: {pdf.name} is larger than {MAX_BYTES // 1_048_576} MB")
    reader = PdfReader(str(pdf))
    if reader.is_encrypted:
        try:
            reader.decrypt("")
        except Exception as exc:  # noqa: BLE001
            raise SystemExit(f"{entry['doc']}: {pdf.name} is encrypted") from exc
    n = len(reader.pages)
    if n > MAX_PAGES:
        raise SystemExit(f"{entry['doc']}: {n} pages exceeds the {MAX_PAGES}-page limit")
    report["pages"] = n
    skip = set(entry.get("skip_pages", []))

    texts, numbers = [], []
    for i, page in enumerate(reader.pages, start=1):
        if i in skip:
            continue
        try:
            text = clean(page.extract_text() or "")
        except Exception as exc:  # noqa: BLE001 — one bad page must not abort the build
            report["errors"].append({"page": i, "error": type(exc).__name__})
            continue
        if len(text) < MIN_TEXT_CHARS:
            recognised = ocr_page(pdf, i) if use_ocr else None
            if recognised and len(clean(recognised)) >= MIN_TEXT_CHARS:
                text = clean(recognised)
                report["ocr"].append(i)
            else:
                report["scanned"].append(i)
                continue
        texts.append(text)
        numbers.append(i)

    texts, report["running_lines"] = strip_running_lines(texts)
    chunks = []
    for page_index, text in enumerate(t for t in texts if t):
        chunks.append({
            "doc": entry["doc"],
            "docTitle": entry["title"],
            "docShort": entry["short"],
            "page": page_index + 1,
            "text": text,
            "words": len(re.findall(r"\w+", text)),
        })
    report["kept"] = len(chunks)
    report["source_pages"] = numbers
    return chunks, report


def build(manifest_path: Path, use_ocr: bool = False) -> tuple[list[dict], list[dict]]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    seen, chunks, reports = set(), [], []
    for entry in manifest:
        for key in ("doc", "title", "short", "pdf"):
            if not entry.get(key):
                raise SystemExit(f"manifest entry is missing '{key}': {entry}")
        if not re.fullmatch(r"[a-z][a-z0-9_-]{0,39}", entry["doc"]):
            raise SystemExit(f"doc id must be lowercase letters/digits/-/_ : {entry['doc']!r}")
        if entry["doc"] in seen:
            raise SystemExit(f"duplicate doc id {entry['doc']!r}")
        seen.add(entry["doc"])
        doc_chunks, report = extract(entry, manifest_path.parent, use_ocr)
        chunks += doc_chunks
        reports.append(report)
    # Ids follow the existing data/chunks.json scheme: "<doc>-<global index>".
    for i, c in enumerate(chunks):
        c["id"] = f"{c['doc']}-{i}"
    return chunks, reports


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("manifest", type=Path, help="JSON list of {doc, title, short, pdf[, skip_pages]}")
    parser.add_argument("--out", type=Path, default=ROOT / "data" / "chunks.json")
    parser.add_argument("--report", type=Path, help="write a JSON report (scanned pages, removed headers, …)")
    parser.add_argument("--ocr", action="store_true", help="OCR pages without a text layer (pdftoppm + tesseract)")
    args = parser.parse_args()

    chunks, reports = build(args.manifest, args.ocr)
    if not chunks:
        print("No text extracted — nothing written.", file=sys.stderr)
        return 1
    args.out.write_text(json.dumps(chunks, ensure_ascii=False, indent=1), encoding="utf-8")
    for r in reports:
        line = f"{r['doc']:<12} {r['kept']:>4}/{r['pages']:<4} pages kept"
        if r["running_lines"]:
            line += f" · {len(r['running_lines'])} running header/footer pattern(s) removed"
        if r["ocr"]:
            line += f" · OCR'd {len(r['ocr'])}"
        if r["scanned"]:
            line += f" · {len(r['scanned'])} scanned page(s) skipped (re-run with --ocr): {r['scanned'][:10]}"
        if r["errors"]:
            line += f" · {len(r['errors'])} page(s) failed to parse"
        print(line)
    if args.report:
        args.report.write_text(json.dumps(reports, indent=2), encoding="utf-8")
    print(f"wrote {len(chunks)} pages to {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
