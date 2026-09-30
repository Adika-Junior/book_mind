# SPDX-License-Identifier: AGPL-3.0-or-later
"""Text utilities shared by search and research. Mirrored in web/js/search.js for offline use —
keep the tokenizer and stopword list identical on both sides so online and offline results agree.
"""
from __future__ import annotations

import re

STOPWORDS = frozenset(
    (
        "the a an of to in on for and or is are was were be by with as at from this that "
        "shall which it its their they he she who whom will would may not no into within under over about "
        "such other any all each per than then also has have had if but so these those subsection section clause"
    ).split()
)

_WORD = re.compile(r"[a-z][a-z\-]{2,}")
_DEFINITION = re.compile(
    r"[“\"]([^”\"]{2,60})[”\"]\s+(means|has the meaning|includes)\s+([^;]{5,400})"
)
_SENTENCE = re.compile(r"[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$")


def tokenize(text: str) -> list[str]:
    return [w for w in _WORD.findall(text.lower()) if w not in STOPWORDS]


def squash(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def excerpt(text: str, max_len: int) -> str:
    text = squash(text)
    return text if len(text) <= max_len else text[: max_len - 1].rstrip() + "…"


def sentences(text: str) -> list[str]:
    return [s.strip() for s in _SENTENCE.findall(squash(text)) if len(s.strip()) > 2]


def extract_definitions(chunks: list[dict]) -> list[dict]:
    """Pull statutory definitions ("x" means ...) out of the corpus — an offline glossary.

    The Bill's interpretation clause defines its own jargon; surfacing those definitions is the
    most faithful "simplify" possible without a model, because it is the law's own wording.
    """
    seen: set[str] = set()
    out: list[dict] = []
    for c in chunks:
        for term, verb, body in _DEFINITION.findall(c["text"]):
            key = term.strip().lower()
            if key in seen:
                continue
            seen.add(key)
            out.append(
                {
                    "term": term.strip(),
                    "definition": f"{verb} {squash(body)}".strip(),
                    "doc": c["doc"],
                    "docShort": c["docShort"],
                    "page": c["page"],
                    "chunk_id": c["id"],
                }
            )
    return out


def best_sentences(query: str, text: str, n: int = 2) -> list[str]:
    q = set(tokenize(query))
    scored = []
    for i, s in enumerate(sentences(text)):
        overlap = len(q & set(tokenize(s)))
        if overlap:
            scored.append((overlap, -i, s))
    scored.sort(reverse=True)
    return [s for *_, s in scored[:n]]


def extractive_answer(mode: str, selection: str, related: list[dict], definitions: list[dict], reason: str) -> str:
    """A grounded answer built only from the corpus — used when the model is unavailable.

    Same shape as the model's output (markdown with ## headings, [Doc, p.N] citations), so the
    notebook renders it identically. Mirrored client-side in web/js/research.js.
    """
    sel_lower = selection.lower()
    sel_tokens = set(tokenize(selection))
    matched_defs = [
        d
        for d in definitions
        if d["term"].lower() in sel_lower or (set(tokenize(d["term"])) and set(tokenize(d["term"])) <= sel_tokens)
    ]
    parts: list[str] = []
    if matched_defs:
        parts.append("## Defined terms")
        parts += [
            f"- **{d['term']}** {excerpt(d['definition'], 360)} [{d['docShort']}, p.{d['page']}]"
            for d in matched_defs[:6]
        ]
    if related:
        parts.append("## Related wording elsewhere" if mode == "simplify" else "## What the documents say")
        for r in related[:4]:
            picks = best_sentences(selection, r.get("text") or r.get("snippet", ""), 2)
            if picks:
                parts.append(f"- {excerpt(' '.join(picks), 420)} [{r['docShort']}, p.{r['page']}]")
    if not matched_defs and not related:
        parts.append("No closely related passages or defined terms were found in these documents.")
    parts.append(f"\n_Extractive note — quoted from the documents without a language model ({reason})._")
    return "\n".join(parts)
