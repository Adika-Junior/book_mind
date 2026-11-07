# SPDX-License-Identifier: AGPL-3.0-or-later
import json
import re

from bookmind.common.config import get_settings
from bookmind.common.structure import paragraphs
from bookmind.common.telemetry import parse_traceparent
from bookmind.common.text import extract_definitions, extractive_answer, located_sentences, tokenize


def chunks():
    return json.loads(get_settings().data_path.read_text(encoding="utf-8"))


def test_tokenize_drops_stopwords_and_short_words():
    assert tokenize("The Office shall be a body of AI") == ["office", "body"]


def test_definitions_come_from_the_bill():
    defs = {d["term"].lower(): d for d in extract_definitions(chunks())}
    assert "deployer" in defs and defs["deployer"]["docShort"] == "Bill"
    assert defs["high-risk artificial intelligence system"]["definition"].startswith("means")


def test_extractive_answer_is_cited_and_labelled():
    defs = extract_definitions(chunks())
    related = [{"docShort": "Bill", "page": 9, "text": "A deployer of a high-risk system shall conduct a risk assessment."}]
    md = extractive_answer("simplify", "the deployer", related, defs, "model down")
    assert "**deployer**" in md and "[Bill, p.9 ¶1]" in md and "model down" in md
    assert re.search(r"\*\*deployer\*\* .* \[Bill, p\.\d+ ¶\d+\]", md)  # definitions cite their paragraph too


def test_every_definition_cites_the_paragraph_that_contains_it():
    pages = {c["id"]: c for c in chunks()}
    for d in extract_definitions(chunks()):
        c = pages[d["chunk_id"]]
        para = paragraphs(c["text"], c["doc"])[d["para"] - 1]
        assert d["term"].lower() in para.lower(), d["term"]


def test_quoted_sentences_come_from_the_cited_paragraph():
    page = next(c for c in chunks() if c["id"] == "bill-10")
    paras = paragraphs(page["text"], "bill")
    picks = located_sentences("synthetic media using a person's voice without consent", page["text"], "bill", 2)
    assert picks
    for sentence, para in picks:
        assert sentence in " ".join(paras[para - 1].split())


def test_traceparent_parsing():
    tc = parse_traceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")
    assert tc.trace_id == "4bf92f3577b34da6a3ce929d0e0e4736" and tc.parent_span_id == "00f067aa0ba902b7"
    assert parse_traceparent("garbage") is None
    assert parse_traceparent("00-" + "0" * 32 + "-00f067aa0ba902b7-01") is None
