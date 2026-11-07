# SPDX-License-Identifier: AGPL-3.0-or-later
"""Page structure and paragraph numbering — a faithful port of web/js/structure.js.

Citations point to a page *and a paragraph* ("[Bill, p.11 ¶3]"). For the server's citations to
land on the paragraph the reader sees, server and browser must cut a page into the same blocks,
so this mirrors structure.js rule for rule. tests/test_structure_parity.py runs both over every
page of data/chunks.json and fails on any difference. Change them together.

A *paragraph* is a body block — a paragraph, a list item (clause), or a contents listing —
numbered from 1 on each page. Headings and the Digest's questions are signposts, not paragraphs.
"""
from __future__ import annotations

import re

BULLET = re.compile("^[\uf09f\uf0b7\uf0a7\uf076•▪●‣⁃◦\\-–·]\\s+")  # incl. Symbol/Wingdings private-use bullets
MARKER = re.compile(r"^\(([a-z]{1,2}|[ivx]{1,5}|[0-9]{1,3})\)\s+")
PART = re.compile(r"^(PART|CHAPTER|SCHEDULE)\s+([IVXLC]+|[0-9]+)\b\s*[—–:-]?\s*(.*)$", re.I)
CLAUSE = re.compile(r"^CLAUSE\s+([0-9]+[A-Z]?)\s*[—–:-]?\s*(.*)$", re.I)
NUMBERED = re.compile(r"^((?:[0-9]{1,2}\.){1,4}[0-9]{0,2})\.?\s+([A-Z][\s\S]{2,110})$")
TERMINAL = re.compile(r"[.!?;:—–,]$")
ENDS_SENTENCE = re.compile(r"[.!?:][\"”’)]?$")
STARTS_SENTENCE = re.compile(r"^[A-Z“\"(]")
FURNITURE = re.compile(
    r"^([0-9]{1,3}\s+[|/]\s+[A-Za-z][^|/]{2,40}|[A-Za-z][^|/]{2,40}\s+[|/]\s+[0-9]{1,3}|page\s+[0-9]+(\s+of\s+[0-9]+)?)$", re.I
)
SMALL_WORDS = frozenset("a an and as at but by for from in into of on or the to under with within via per nor".split())
PARAGRAPH_TYPES = ("p", "item", "toc")
_WS = re.compile(r"[\s﻿]+")


def _squash(s: str) -> str:
    return _WS.sub(" ", s).strip(" ")


def _all_caps(s: str) -> bool:
    letters = re.sub(r"[^A-Za-z]", "", s)
    return len(letters) >= 4 and letters == letters.upper()


def _looks_like_toc(lines: list[str]) -> bool:
    if any(re.fullmatch(r"(table of )?contents", ln.strip(), re.I) for ln in lines):
        return True
    with_page_no = sum(1 for ln in lines if re.search(r"\s\.?\s?[0-9]{1,3}$", ln.strip()) and len(ln.strip()) < 90)
    return len(lines) >= 8 and with_page_no / len(lines) > 0.45


def _classify(line: str, doc: str) -> dict | None:
    if m := PART.match(line):
        name, *after = re.sub(r"^[—–:-]\s*", "", m[3] or "").split(": ")
        heading = {"type": "sec", "num": f"{m[1].title()} {m[2]}", "text": name or ""}
        if after:
            heading["trailing"] = ": ".join(after)
        return heading
    if m := CLAUSE.match(line):
        return {"type": "sec", "num": f"Clause {m[1]}", "text": m[2] or ""}
    if (m := NUMBERED.match(line)) and len(line) <= 110 and not TERMINAL.search(line) and not re.search(r"\s[0-9]{1,3}$", line):
        depth = len([p for p in m[1].rstrip(".").split(".") if p])
        return {"type": "sec" if depth <= 1 else "sub", "num": m[1].rstrip("."), "text": m[2].strip()}
    if doc == "digest" and line.endswith("?") and len(line) <= 160 and re.match(r"^[A-Z]", line):
        return {"type": "q", "text": line}
    if _all_caps(line) and len(line) <= 90 and not TERMINAL.search(line):
        return {"type": "sec", "text": line}
    return None


def _title_line(line: str, nxt: str) -> bool:
    if not nxt or len(line) > 70 or re.search(r"[.!?;:,]$", line) or re.search(r"[0-9]{2,}$", line):
        return False
    words = [w for w in line.split(" ") if re.search(r"[A-Za-z]", w)]
    if len(words) < 2 or len(words) > 10:
        return False
    content = [w for w in words if w.lower() not in SMALL_WORDS]
    capped = [w for w in content if re.match(r"^[A-Z“\"(]", w)]
    return bool(content) and len(capped) / len(content) >= 0.8


def blocks(text: str, doc: str = "") -> list[dict]:
    """Headings, paragraphs and list items of one page (same output shape as structure.js)."""
    raw_lines = text.replace("\r", "").split("\n")
    lines = [_squash(ln) for ln in raw_lines]
    content = [ln for ln in lines if ln]
    if _looks_like_toc(content):
        return [{"type": "toc", "text": "\n".join(ln.strip() for ln in raw_lines if ln.strip())}]
    lengths = sorted(len(ln) for ln in content)
    typical = (lengths[len(lengths) // 2] if lengths else 0) or 80
    out: list[dict] = []
    cur: dict | None = None
    last_heading_line = -2

    def flush():
        nonlocal cur
        if cur and cur["text"].strip():
            out.append(cur)
        cur = None

    for i, line in enumerate(lines):
        if not line or FURNITURE.match(line):
            continue
        nxt = next((ln for ln in lines[i + 1 :] if ln), "")
        heading = _classify(line, doc)
        if not heading and (not cur or ENDS_SENTENCE.search(cur["text"])) and _title_line(line, nxt):
            heading = {"type": "sub", "text": line}
        if heading and not (
            cur and cur["type"] == "item" and not TERMINAL.search(cur["text"]) and heading["type"] == "sec" and not heading.get("num")
        ):
            flush()
            prev = out[-1] if out else None
            prev_line = next((k for k in range(i - 1, -1, -1) if lines[k]), None)
            trailing = heading.pop("trailing", None)
            if prev and prev["type"] == heading["type"] and not prev.get("num") and not heading.get("num") and last_heading_line == prev_line:
                prev["text"] = f"{prev['text']} {heading['text']}"
            else:
                out.append(heading)
            if trailing:
                out.append({"type": "p", "text": trailing})
            last_heading_line = i
            continue
        if m := MARKER.match(line):
            flush()
            cur = {"type": "item", "marker": f"({m[1]})", "text": line[m.end() :]}
            continue
        if m := BULLET.match(line):
            flush()
            cur = {"type": "item", "marker": "•", "text": line[m.end() :]}
            continue
        if not cur:
            cur = {"type": "p", "text": line}
            continue
        prev_text = cur["text"]
        prev_last = (lines[i - 1] if i >= 1 else "") or (lines[i - 2] if i >= 2 else "")
        if ENDS_SENTENCE.search(prev_text) and len(prev_last) < typical * 0.72 and STARTS_SENTENCE.match(line):
            flush()
            cur = {"type": "p", "text": line}
            continue
        joined = re.search(r"[a-z]-$", prev_text) and re.match(r"^[a-z]", line)
        cur["text"] = prev_text + line if joined else f"{prev_text} {line}"
    flush()
    return out


def paragraphs(text: str, doc: str = "") -> list[str]:
    """Body paragraphs of a page; paragraph N (as cited, "¶N") is paragraphs(...)[N - 1]."""
    return [b["text"] for b in blocks(text, doc) if b["type"] in PARAGRAPH_TYPES]


def doc_of(chunk_id: str | None) -> str:
    """'bill-12' -> 'bill'."""
    return (chunk_id or "").rsplit("-", 1)[0]


def cite(doc_short: str, page: int, para: int | None = None) -> str:
    return f"[{doc_short}, p.{page} ¶{para}]" if para else f"[{doc_short}, p.{page}]"
