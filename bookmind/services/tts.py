# SPDX-License-Identifier: AGPL-3.0-or-later
"""TTS service — read-aloud with Piper neural voices, on your own server.

Piper (https://github.com/OHF-Voice/piper1-gpl, GPL-3.0) is a fast, local neural text-to-speech
engine: a VITS voice model exported to ONNX plus espeak-ng phonemisation. It runs faster than real
time on a CPU (a Raspberry Pi 4 included), sends nothing to a third party, and sounds far more
natural than most built-in browser voices — which vary wildly by device and are sometimes cloud
voices in disguise. The browser's Web Speech voices remain the fallback when this service, or the
network, isn't available (see web/js/app.js).

Voices are files, not code: put `<id>.onnx` + `<id>.onnx.json` in BOOKMIND_VOICES_DIR (tools/voices.py
downloads vetted ones). An optional `<id>.card.json` carries what the UI and docs need to show —
display name, licence, source, and for a custom/cloned voice, the speaker's consent record
(see docs/VOICES.md). Voices whose card says `"consent": false` are refused.

Audio is WAV, synthesised per sentence (the client prefetches the next one), cached in memory by
(voice, text), and made cacheable by the browser/service worker so a page you've listened to plays
again offline.
"""
from __future__ import annotations

import asyncio
import hashlib
import io
import json
import logging
import re
import time
import wave
from collections import OrderedDict
from pathlib import Path

from fastapi import HTTPException, Query, Response

from bookmind.common.config import get_settings
from bookmind.common.service import create_service
from bookmind.common.telemetry import log

logger = logging.getLogger("bookmind.tts")
settings = get_settings()

_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")
_OLD_NAME = re.compile(r"^(?P<lang>[a-z]{2,3}[-_][a-zA-Z]{2,3})-(?P<name>.+?)-(?P<quality>x_low|low|medium|high)$")
VOICE_ID = r"^[A-Za-z0-9_.\-]{1,80}$"


def _meta(model: Path) -> dict | None:
    """Describe a voice from its Piper config (+ optional card). None if it isn't a usable voice."""
    config_path = model.with_suffix(".onnx.json")
    if not config_path.is_file():
        return None
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    vid = model.name[: -len(".onnx")]
    card_path = model.parent / f"{vid}.card.json"
    card = {}
    if card_path.is_file():
        try:
            card = json.loads(card_path.read_text(encoding="utf-8"))
        except ValueError:
            log(logger, logging.WARNING, "voice_card_invalid", voice=vid)
    # A custom (personal/professional) voice is someone's voice: no consent record, no voice.
    if card.get("consent") is False or (card.get("custom") and not isinstance(card.get("consent"), dict)):
        log(logger, logging.WARNING, "voice_refused_no_consent", voice=vid)
        return None
    lang = (config.get("language") or {}).get("code") or ""
    quality = (config.get("audio") or {}).get("quality") or ""
    name = config.get("dataset") or ""
    m = _OLD_NAME.match(vid)
    if m:  # older voices only encode this in the file name: en-us-lessac-low
        lang = lang or m["lang"]
        name = name or m["name"]
        quality = quality or m["quality"]
    lang = lang.replace("-", "_")
    if "_" in lang:
        a, b = lang.split("_", 1)
        lang = f"{a.lower()}_{b.upper()}"
    return {
        "id": vid,
        "name": card.get("name") or (name or vid).replace("_", " ").title(),
        "language": lang,
        "quality": quality,
        "sample_rate": (config.get("audio") or {}).get("sample_rate"),
        "speakers": config.get("num_speakers", 1),
        "license": card.get("license"),
        "source": card.get("source"),
        "attribution": card.get("attribution"),
        "custom": bool(card.get("custom")),
    }


class Voices:
    """Discovers voice files and keeps the most recently used models loaded (they're ~20–110 MB each)."""

    MAX_LOADED = 2

    def __init__(self, directory: Path):
        self.directory = directory
        self.catalog: dict[str, dict] = {}
        self.loaded: OrderedDict[str, object] = OrderedDict()
        self.scanned_at = 0.0

    def scan(self) -> dict[str, dict]:
        if time.monotonic() - self.scanned_at < 30 and self.catalog:
            return self.catalog
        found = {}
        if self.directory.is_dir():
            for model in sorted(self.directory.glob("*.onnx")):
                meta = _meta(model)
                if meta:
                    found[meta["id"]] = meta
        self.catalog, self.scanned_at = found, time.monotonic()
        return found

    def get(self, vid: str):
        if vid in self.loaded:
            self.loaded.move_to_end(vid)
            return self.loaded[vid]
        from piper import PiperVoice  # imported lazily: the service starts (and lists 0 voices) without it

        started = time.monotonic()
        voice = PiperVoice.load(self.directory / f"{vid}.onnx")
        self.loaded[vid] = voice
        while len(self.loaded) > self.MAX_LOADED:
            self.loaded.popitem(last=False)
        log(logger, logging.INFO, "voice_loaded", voice=vid, seconds=round(time.monotonic() - started, 2))
        return voice


def engine_available() -> bool:
    try:
        import piper  # noqa: F401
    except ImportError:
        return False
    return True


class AudioCache:
    """Byte-bounded LRU of synthesised audio."""

    def __init__(self, max_bytes: int = 48 * 1024 * 1024):
        self.max_bytes, self.size = max_bytes, 0
        self.items: OrderedDict[str, bytes] = OrderedDict()

    def get(self, key: str) -> bytes | None:
        data = self.items.get(key)
        if data is not None:
            self.items.move_to_end(key)
        return data

    def put(self, key: str, data: bytes) -> None:
        if len(data) > self.max_bytes // 4:
            return
        self.items[key] = data
        self.size += len(data)
        while self.size > self.max_bytes:
            _, old = self.items.popitem(last=False)
            self.size -= len(old)


voices = Voices(settings.voices_dir)
cache = AudioCache()
_slots = asyncio.Semaphore(max(1, settings.tts_concurrency))


def synthesize(vid: str, text: str, rate: float) -> bytes:
    from piper import SynthesisConfig

    voice = voices.get(vid)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        voice.synthesize_wav(text, wav, syn_config=SynthesisConfig(length_scale=1 / rate))
    return buf.getvalue()


app = create_service("tts")


async def _ready() -> bool:
    return engine_available()


app.state.readiness["engine"] = _ready


@app.get("/v1/voices")
async def list_voices():
    catalog = await asyncio.to_thread(voices.scan) if engine_available() else {}
    return {"engine": "piper" if engine_available() else None, "voices": list(catalog.values()), "max_chars": settings.tts_max_chars}


@app.get("/v1/speak")
async def speak(
    voice: str = Query(..., pattern=VOICE_ID),
    text: str = Query(..., min_length=1),
    rate: float = Query(1.0, ge=0.5, le=2.0),
):
    text = _CONTROL.sub(" ", text).strip()
    if not text:
        raise HTTPException(422, "Nothing to read.")
    if len(text) > settings.tts_max_chars:
        raise HTTPException(413, f"Send at most {settings.tts_max_chars} characters at a time.")
    if not engine_available():
        raise HTTPException(503, "Piper isn't installed on this server.")
    if voice not in await asyncio.to_thread(voices.scan):
        raise HTTPException(404, "Unknown voice.")
    key = hashlib.sha256(f"{voice}\x00{rate:.2f}\x00{text}".encode()).hexdigest()
    audio = cache.get(key)
    outcome = "hit"
    if audio is None:
        outcome = "miss"
        async with _slots:  # CPU-bound: bound concurrent syntheses so the service stays responsive
            started = time.monotonic()
            audio = await asyncio.to_thread(synthesize, voice, text, rate)
            log(logger, logging.INFO, "synthesized", voice=voice, chars=len(text), bytes=len(audio),
                seconds=round(time.monotonic() - started, 3))
        cache.put(key, audio)
    # Same voice + text + rate always gives the same audio, so it can be cached for a long time.
    return Response(audio, media_type="audio/wav", headers={
        "Cache-Control": "private, max-age=31536000, immutable", "ETag": f'"{key[:32]}"', "X-Cache": outcome,
    })
