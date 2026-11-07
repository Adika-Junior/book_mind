# SPDX-License-Identifier: AGPL-3.0-or-later
"""The model is given passages labelled [Doc, p.N ¶M] and told to copy those labels: each label must
name the paragraph whose text follows it, or citations would point readers to the wrong place."""
import json
import re
from pathlib import Path

from bookmind.common.structure import paragraphs
from bookmind.common.text import squash
from bookmind.services.research import GenerateRequest, build_prompt

ROOT = Path(__file__).resolve().parents[1]
CHUNKS = {c["id"]: c for c in json.loads((ROOT / "data" / "chunks.json").read_text(encoding="utf-8"))}
LABEL = re.compile(r"^- \[(\w+), p\.(\d+) ¶(\d+)\] (.+)$", re.M)


def test_every_prompt_label_names_the_paragraph_that_follows_it():
    here, other = CHUNKS["bill-10"], CHUNKS["digest-26"]
    req = GenerateRequest(mode="research", selection="offences and penalties for synthetic media", doc_title=here["docTitle"],
                          doc_short="Bill", page=here["page"], context_text=here["text"], chunk_id="bill-10")
    prompt = build_prompt(req, [{**other, "snippet": ""}])
    labels = LABEL.findall(prompt)
    assert {s for s, *_ in labels} == {"Bill", "Digest"}
    by_short = {"Bill": here, "Digest": other}
    for short, page, para, shown in labels:
        chunk = by_short[short]
        assert int(page) == chunk["page"]
        source = squash(paragraphs(chunk["text"], chunk["doc"])[int(para) - 1])
        assert source.startswith(shown.rstrip("…")[:60]), (short, page, para)
    assert "copied exactly" in prompt and "Never invent a label" in prompt
