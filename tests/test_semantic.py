# SPDX-License-Identifier: AGPL-3.0-or-later
"""Search that matches meaning: retrieval quality, nonsense gating, and browser/server parity.

The evaluation set is small and hand-labelled from the corpus (data/chunks.json): paraphrased
questions that deliberately avoid the documents' own words, plus exact-term queries that keyword
search already answers. It guards the fusion against regressions; it is not a benchmark.
"""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from bookmind.common.embed import find_static_model, load_embedder
from bookmind.services.search import PassageIndex, SemanticIndex

pytestmark = pytest.mark.skipif(find_static_model() is None, reason="wordllama (static embedding model) not installed")

ROOT = Path(__file__).resolve().parents[1]
CHUNKS = json.loads((ROOT / "data" / "chunks.json").read_text(encoding="utf-8"))

MEANING = [
    ("what happens if someone breaks the AI law", {"bill-10", "digest-26", "digest-27"}),
    ("punishment for misusing AI", {"bill-10", "digest-26", "digest-27"}),
    ("fake pictures of people made by computers", {"bill-11", "bill-1", "digest-24"}),
    ("will machines take people's work", {"strategy-73", "strategy-56", "strategy-72"}),
    ("where does the commissioner's money come from", {"digest-21", "bill-7"}),
    ("sorting systems by how dangerous they are", {"bill-7", "digest-23", "bill-8"}),
    ("unfair treatment of groups by algorithms", {"bill-10", "strategy-47", "strategy-48", "digest-24"}),
    ("who can be appointed to lead the AI office", {"bill-3", "digest-15", "digest-16"}),
    ("testing new AI products in a controlled environment", {"bill-9", "digest-24"}),
    ("teaching citizens digital skills", {"strategy-99", "strategy-100", "roadmap-238", "roadmap-198"}),
]
KEYWORD = [
    ("Konza technopolis data centre", {"roadmap-187", "strategy-62", "strategy-80"}),
    ("quorum of the advisory committee meetings", {"bill-6", "digest-20"}),
    ("oath of office schedule", {"bill-12"}),
    ("regulatory sandboxes", {"bill-9"}),
    ("high-risk artificial intelligence", {"bill-8"}),
    # Known miss: BM25 alone finds digest-17 at #3; hybrid ranks other Commissioner pages above it.
    ("Artificial Intelligence Commissioner functions", {"bill-4", "digest-17"}),
]
NONSENSE = ["xqzv blorf", "asdf qwer", "zzz jkl"]


@pytest.fixture(scope="module")
def built():
    embedder = load_embedder()
    semantic = SemanticIndex(embedder)
    index = PassageIndex(semantic)
    index.load({"chunks": CHUNKS, "version": "test"})
    import asyncio

    asyncio.run(semantic.build(index.chunks, "test"))
    assert semantic.ready and semantic.pack
    return index, semantic


def _hit_at(index, semantic, q, gold, mode, k=3):
    import asyncio

    qvec = asyncio.run(semantic.query_vector(q, index.vocabulary)) if mode != "keyword" else None
    return any(r["id"] in gold for r in index.query(q, k, qvec=qvec, mode=mode))


def test_meaning_search_finds_paraphrases_keyword_search_misses(built):
    index, semantic = built
    keyword = sum(_hit_at(index, semantic, q, g, "keyword") for q, g in MEANING)
    hybrid = sum(_hit_at(index, semantic, q, g, "hybrid") for q, g in MEANING)
    assert keyword <= 3
    assert hybrid >= 6, f"hybrid top-3 hits {hybrid}/10 (keyword {keyword}/10)"


def test_exact_terms_still_rank_first(built):
    index, semantic = built
    assert sum(_hit_at(index, semantic, q, g, "hybrid") for q, g in KEYWORD) >= len(KEYWORD) - 1
    assert all(_hit_at(index, semantic, q, g, "keyword") for q, g in KEYWORD)  # keyword mode is plain BM25


def test_table_of_contents_ranks_below_the_clause(built):
    import asyncio

    index, semantic = built
    q = "high-risk artificial intelligence"
    hits = index.query(q, 3, qvec=asyncio.run(semantic.query_vector(q, index.vocabulary)))
    assert hits[0]["id"] != "bill-0" and "bill-8" in [h["id"] for h in hits]


def test_results_say_when_they_matched_by_meaning_only(built):
    import asyncio

    index, semantic = built
    q = "punishment for misusing AI"
    hits = index.query(q, 3, qvec=asyncio.run(semantic.query_vector(q, index.vocabulary)))
    assert hits and hits[0]["match"] == "meaning"
    assert "offence" in hits[0]["snippet"].lower() or "penalt" in hits[0]["snippet"].lower()


@pytest.mark.parametrize("q", NONSENSE)
def test_nonsense_returns_nothing(built, q):
    import asyncio

    index, semantic = built
    assert asyncio.run(semantic.query_vector(q, index.vocabulary)) is None
    assert index.query(q, 5, qvec=None) == []


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_browser_offline_search_agrees_with_server(built, tmp_path):
    """search.js + the semantic pack (64-dim int8, greedy tokenizer) should rank like the server."""
    index, semantic = built
    queries = [q for q, _ in MEANING + KEYWORD] + NONSENSE
    (tmp_path / "pack.json").write_bytes(semantic.pack)
    (tmp_path / "chunks.json").write_text(json.dumps(CHUNKS))
    (tmp_path / "q.json").write_text(json.dumps(queries))
    args = [str(ROOT / "tests/js/semantic_parity.mjs")] + [str(tmp_path / f) for f in ("pack.json", "chunks.json", "q.json")]
    out = subprocess.run(  # noqa: S603 — fixed argv, test-only
        [shutil.which("node"), *args],
        check=True, capture_output=True, text=True, timeout=120,
    )
    browser = json.loads(out.stdout)
    gold = dict(MEANING + KEYWORD)
    hits = sum(any(i in gold[q] for i, _ in browser[q][:3]) for q, _ in MEANING)
    assert hits >= 6, f"browser top-3 hits {hits}/10"
    assert sum(any(i in g for i, _ in browser[q][:3]) for q, g in KEYWORD) >= len(KEYWORD) - 1
    assert all(browser[q] == [] for q in NONSENSE)
