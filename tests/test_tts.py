# SPDX-License-Identifier: AGPL-3.0-or-later
"""Read-aloud with Piper: voice discovery, synthesis, caching, limits, and the consent rule."""
import io
import json
import os
import wave
from pathlib import Path

import httpx
import pytest

from bookmind.services import tts

ROOT = Path(__file__).resolve().parents[1]
VOICE = "en-us-lessac-low"
MODEL = Path(os.environ.get("BOOKMIND_VOICES_DIR", ROOT / "data" / "voices")) / f"{VOICE}.onnx"
needs_piper = pytest.mark.skipif(not (tts.engine_available() and MODEL.is_file()),
                                 reason="piper-tts or the test voice isn't installed (python tools/voices.py get en-us-lessac-low)")


@pytest.fixture
def voices_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(tts, "voices", tts.Voices(tmp_path))
    monkeypatch.setattr(tts, "cache", tts.AudioCache())
    return tmp_path


def link_voice(d: Path, vid: str, card: dict | None = None) -> None:
    (d / f"{vid}.onnx").symlink_to(MODEL)
    (d / f"{vid}.onnx.json").symlink_to(MODEL.with_suffix(".onnx.json"))
    if card is not None:
        (d / f"{vid}.card.json").write_text(json.dumps(card))


async def call(path, **params):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=tts.app), base_url="http://tts") as c:
        return await c.get(path, params=params)


@needs_piper
async def test_lists_voices_with_metadata_from_config_and_card(voices_dir):
    link_voice(voices_dir, VOICE, {"license": "research only"})
    data = (await call("/v1/voices")).json()
    assert data["engine"] == "piper"
    [v] = data["voices"]
    assert v["id"] == VOICE and v["language"] == "en_US" and v["quality"] == "low" and v["name"] == "Lessac"
    assert v["license"] == "research only" and v["sample_rate"] == 16000


@needs_piper
async def test_speaks_a_sentence_as_wav_and_caches_it(voices_dir):
    link_voice(voices_dir, VOICE)
    text = "The Commissioner shall publish the register within thirty days."
    first = await call("/v1/speak", voice=VOICE, text=text)
    assert first.status_code == 200 and first.headers["content-type"] == "audio/wav"
    assert first.headers["x-cache"] == "miss" and "immutable" in first.headers["cache-control"]
    with wave.open(io.BytesIO(first.content)) as w:
        seconds = w.getnframes() / w.getframerate()
    assert 2 < seconds < 10  # real speech, not silence or a stub
    again = await call("/v1/speak", voice=VOICE, text=text)
    assert again.headers["x-cache"] == "hit" and again.content == first.content
    faster = await call("/v1/speak", voice=VOICE, text=text, rate=1.5)
    with wave.open(io.BytesIO(faster.content)) as w:
        assert w.getnframes() / w.getframerate() < seconds


@needs_piper
async def test_rejects_unknown_voices_and_long_text(voices_dir):
    link_voice(voices_dir, VOICE)
    assert (await call("/v1/speak", voice="nobody", text="hello")).status_code == 404
    assert (await call("/v1/speak", voice=VOICE, text="x" * (tts.settings.tts_max_chars + 1))).status_code == 413
    assert (await call("/v1/speak", voice="../etc/passwd", text="hello")).status_code == 422


@needs_piper
async def test_custom_voice_without_consent_is_refused(voices_dir):
    link_voice(voices_dir, "en_KE-someone-medium", {"custom": True, "name": "Someone"})
    link_voice(voices_dir, "en_KE-amina-medium", {"custom": True, "name": "Amina", "consent": {
        "speaker": "Amina", "granted_to": "BookMind deployment", "scope": "read-aloud of the corpus",
        "date": "2026-09-01", "signature": "sha256:…", "revocation_contact": "voices@example.org"}})
    link_voice(voices_dir, "en_KE-revoked-medium", {"consent": False})
    ids = [v["id"] for v in (await call("/v1/voices")).json()["voices"]]
    assert ids == ["en_KE-amina-medium"]
    assert (await call("/v1/speak", voice="en_KE-someone-medium", text="hello")).status_code == 404


def test_audio_cache_is_bounded():
    c = tts.AudioCache(max_bytes=1000)
    for i in range(10):
        c.put(str(i), b"x" * 200)
    assert c.size <= 1000 and c.get("0") is None and c.get("9") is not None
