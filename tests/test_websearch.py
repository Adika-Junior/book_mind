# SPDX-License-Identifier: AGPL-3.0-or-later
"""Web search, with providers simulated by an httpx MockTransport (no internet needed)."""
import json
import uuid

import httpx
import pytest

from bookmind.services import websearch

SEEN_HOSTS: list[str] = []


def fake_upstream(request: httpx.Request) -> httpx.Response:
    SEEN_HOSTS.append(request.url.host)
    if request.url.host == "searxng.test":
        return httpx.Response(200, json={"results": [
            {"title": "Random <b>blog</b> on AI", "url": "https://someblog.example/post", "content": "Opinion &amp; commentary"},
            {"title": "The Artificial Intelligence Bill, 2026", "url": "https://www.parliament.go.ke/ai-bill", "content": "<i>Official</i> text"},
            {"title": "Unsafe", "url": "javascript:alert(1)", "content": "x"},
            {"title": "OECD AI Principles", "url": "https://oecd.ai/en/ai-principles", "content": "Intergovernmental standard"},
        ]})
    if request.url.host == "en.wikipedia.org":
        return httpx.Response(200, json={"query": {"search": [
            {"title": "Artificial intelligence in Kenya", "snippet": "<span class=\"searchmatch\">AI</span> in Kenya"},
        ]}})
    return httpx.Response(500)


@pytest.fixture
def fake_web(monkeypatch):
    SEEN_HOSTS.clear()
    monkeypatch.setenv("BOOKMIND_SEARXNG_URL", "http://searxng.test")
    monkeypatch.setenv("BOOKMIND_WEBSEARCH_PROVIDERS", "searxng,wikipedia")
    monkeypatch.setattr(websearch, "_client", httpx.AsyncClient(transport=httpx.MockTransport(fake_upstream)))
    for b in websearch.breakers.values():
        b.record_success()
    yield
    websearch._client = None


async def test_results_are_ranked_by_source_quality_and_sanitised(fake_web):
    data = await websearch.run_search(f"kenya ai bill {uuid.uuid4().hex[:4]}", 8)
    domains = [r["domain"] for r in data["results"]]
    assert domains[0] == "parliament.go.ke" and data["results"][0]["tier_label"] == "Official (Kenya)"
    assert domains.index("oecd.ai") < domains.index("en.wikipedia.org") < domains.index("someblog.example")
    assert all(r["url"].startswith("https://") for r in data["results"])  # javascript: dropped
    assert all("<" not in r["title"] + r["snippet"] for r in data["results"])  # markup stripped
    assert data["providers"] == {"searxng": "ok", "wikipedia": "ok"}
    assert set(SEEN_HOSTS) <= {"searxng.test", "en.wikipedia.org"}  # only configured providers are contacted


async def test_a_failing_provider_does_not_break_search(fake_web, monkeypatch):
    monkeypatch.setenv("BOOKMIND_SEARXNG_URL", "http://broken.test")
    data = await websearch.run_search(f"penalties {uuid.uuid4().hex[:4]}", 5)
    assert data["providers"]["searxng"] == "unavailable" and data["providers"]["wikipedia"] == "ok"
    assert [r["domain"] for r in data["results"]] == ["en.wikipedia.org"]


def test_classification():
    assert websearch.classify("https://new.kenyalaw.org/akn/ke")[1] == "Official (Kenya)"
    assert websearch.classify("https://www.ict.go.ke/")[1] == "Official (Kenya)"
    assert websearch.classify("https://arxiv.org/abs/1")[1] == "Academic"
    assert websearch.classify("https://nation.africa/kenya")[1] == "News"
    assert websearch.classify("https://example.com")[0] == 6


async def test_gateway_web_endpoint_and_kill_switch(client, fake_web, tmp_dir):
    r = await client.get("/api/v1/web", params={"q": f"oecd principles {uuid.uuid4().hex[:4]}"})
    assert r.status_code == 200 and r.json()["results"][0]["domain"] == "parliament.go.ke"
    from bookmind.services import gateway

    (tmp_dir / "flags.json").write_text(json.dumps({"web_search_enabled": False}))
    gateway.flags._checked_at = 0
    try:
        assert (await client.get("/api/v1/web", params={"q": "anything"})).status_code == 403
    finally:
        (tmp_dir / "flags.json").write_text("{}")
        gateway.flags._checked_at = 0


async def test_research_with_web_keeps_sources_separate_and_saves_them(client, fake_web):
    from test_api import research_body

    note_id = "w" + uuid.uuid4().hex[:12]
    body = research_body(mode="research", selection=f"regulatory sandbox {uuid.uuid4().hex[:4]}", web=True, save=True, note_id=note_id)
    data = (await client.post("/api/v1/research", json=body)).json()
    assert "## Beyond the documents (web)" in data["answer"]
    assert data["answer"].index("## What the documents say") < data["answer"].index("## Beyond the documents (web)")
    assert data["web"][0]["domain"] == "parliament.go.ke" and data["web"][0]["accessed_at"]
    assert data["note"]["web"][0]["url"] == "https://www.parliament.go.ke/ai-bill"
