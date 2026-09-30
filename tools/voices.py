#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Manage Piper voices for BookMind's read-aloud (bookmind/services/tts.py).

    python tools/voices.py list                       # what's installed, and the recommended catalog
    python tools/voices.py get en_GB-cori-high        # download a catalog voice (+ its MODEL_CARD)
    python tools/voices.py get en-us-lessac-low       # legacy voices come from GitHub releases
    python tools/voices.py add --onnx my.onnx --config my.onnx.json --id en_KE-amina-medium \\
        --name "Amina" --license "Private: BookMind deployment only" --consent consent.json

Voices go to BOOKMIND_VOICES_DIR (default data/voices). Every voice gets a `<id>.card.json` that
records where it came from and under what licence — a voice model's licence is set by the recordings
it was trained on, not by Piper, and varies per voice (docs/VOICES.md). `add` installs a custom voice
(your own or a hired professional's) and refuses to do so without a signed consent record.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import urllib.request
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HF = "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0"
GH = "https://github.com/rhasspy/piper/releases/download/v0.0.2"

# Recommended voices. "note" is what we verified about the licence; always read the MODEL_CARD,
# which `get` downloads next to the model.
CATALOG = {
    "en_GB-cori-high": {"path": "en/en_GB/cori/high", "note": "British English, female; trained on public-domain LibriVox audiobook recordings"},
    "en_GB-alba-medium": {"path": "en/en_GB/alba/medium", "note": "Scottish English, female; check MODEL_CARD"},
    "en_GB-northern_english_male-medium": {"path": "en/en_GB/northern_english_male/medium", "note": "Northern English, male; check MODEL_CARD"},
    "en_US-ryan-high": {"path": "en/en_US/ryan/high", "note": "US English, male; check MODEL_CARD"},
    "en_US-lessac-medium": {"path": "en/en_US/lessac/medium",
                            "note": "US English, female; Blizzard 2013 dataset — research licence, NOT for commercial products"},
    "sw_CD-lanfrica-medium": {"path": "sw/sw_CD/lanfrica/medium", "note": "Swahili (Congo); check MODEL_CARD"},
    # Legacy (2023) voices on GitHub releases — useful where huggingface.co is unreachable.
    "en-us-lessac-low": {"legacy": "voice-en-us-lessac-low.tar.gz",
                         "note": "US English, female, 16 kHz; Blizzard 2013 research licence, NOT for commercial products"},
    "en-us-ryan-low": {"legacy": "voice-en-us-ryan-low.tar.gz", "note": "US English, male, 16 kHz; check MODEL_CARD"},
}


def voices_dir() -> Path:
    d = Path(os.environ.get("BOOKMIND_VOICES_DIR", ROOT / "data" / "voices"))
    d.mkdir(parents=True, exist_ok=True)
    return d


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def fetch(url: str, dest: Path) -> None:
    if not url.startswith("https://"):
        raise SystemExit(f"refusing non-HTTPS download: {url}")
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(url, timeout=120) as res, tmp.open("wb") as out:  # noqa: S310 — https only, checked above
        shutil.copyfileobj(res, out)
    tmp.replace(dest)


def write_card(d: Path, vid: str, card: dict) -> None:
    card["sha256"] = sha256(d / f"{vid}.onnx")
    (d / f"{vid}.card.json").write_text(json.dumps(card, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def get(vid: str) -> None:
    entry = CATALOG.get(vid)
    if not entry:
        raise SystemExit(f"unknown voice {vid!r}; see `python tools/voices.py list`")
    d = voices_dir()
    if "legacy" in entry:
        import tarfile

        archive = d / entry["legacy"]
        fetch(f"{GH}/{entry['legacy']}", archive)
        with tarfile.open(archive) as tar:
            members = [m for m in tar.getmembers() if m.isfile() and Path(m.name).name in {f"{vid}.onnx", f"{vid}.onnx.json", "MODEL_CARD"}]
            for m in members:  # extract by name only: no paths from the archive reach the filesystem
                target = d / (f"{vid}.MODEL_CARD" if Path(m.name).name == "MODEL_CARD" else Path(m.name).name)
                with tar.extractfile(m) as src, target.open("wb") as out:
                    shutil.copyfileobj(src, out)
        archive.unlink()
        source = f"{GH}/{entry['legacy']}"
    else:
        base = f"{HF}/{entry['path']}"
        fetch(f"{base}/{vid}.onnx", d / f"{vid}.onnx")
        fetch(f"{base}/{vid}.onnx.json", d / f"{vid}.onnx.json")
        try:
            fetch(f"{base}/MODEL_CARD", d / f"{vid}.MODEL_CARD")
        except OSError:
            pass
        source = base
    card_text = (d / f"{vid}.MODEL_CARD").read_text(encoding="utf-8") if (d / f"{vid}.MODEL_CARD").exists() else ""
    write_card(d, vid, {"source": source, "license": entry["note"], "model_card": card_text, "installed": date.today().isoformat()})
    print(f"installed {vid} in {d} — licence note: {entry['note']}")


def add(args) -> None:
    """Install a custom voice. Consent is mandatory (Kenya's AI Bill 2026 cl. 34(1)(i); DPA 2019 treats
    voice as biometric, i.e. sensitive, personal data)."""
    consent = json.loads(Path(args.consent).read_text(encoding="utf-8"))
    required = {"speaker", "granted_to", "scope", "date", "signature", "revocation_contact"}
    missing = required - consent.keys()
    if missing:
        raise SystemExit(f"consent record is missing {sorted(missing)} — see docs/VOICES.md §5")
    d = voices_dir()
    shutil.copyfile(args.onnx, d / f"{args.id}.onnx")
    shutil.copyfile(args.config, d / f"{args.id}.onnx.json")
    write_card(d, args.id, {
        "name": args.name, "custom": True, "license": args.license, "source": "custom (trained for this deployment)",
        "attribution": args.attribution, "consent": consent, "installed": date.today().isoformat(),
    })
    print(f"installed custom voice {args.id} ({args.name}) with consent from {consent['speaker']}")


def list_voices() -> None:
    d = voices_dir()
    installed = sorted(p.name[: -len(".onnx")] for p in d.glob("*.onnx"))
    print(f"Installed in {d}:")
    for vid in installed or ["(none)"]:
        card = d / f"{vid}.card.json"
        note = json.loads(card.read_text())["license"] if card.exists() else "no card — licence unknown"
        print(f"  {vid:<40} {note}")
    print("\nCatalog (python tools/voices.py get <id>):")
    for vid, e in CATALOG.items():
        print(f"  {vid:<40} {e['note']}")


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list")
    g = sub.add_parser("get")
    g.add_argument("voice")
    a = sub.add_parser("add")
    a.add_argument("--onnx", required=True)
    a.add_argument("--config", required=True)
    a.add_argument("--id", required=True, help="<lang>_<REGION>-<name>-<quality>, e.g. en_KE-amina-medium")
    a.add_argument("--name", required=True)
    a.add_argument("--license", required=True)
    a.add_argument("--attribution", default=None)
    a.add_argument("--consent", required=True, help="JSON consent record (docs/VOICES.md §5)")
    args = p.parse_args()
    if args.cmd == "list":
        list_voices()
    elif args.cmd == "get":
        get(args.voice)
    else:
        import re

        if not re.fullmatch(r"[A-Za-z0-9_.\-]{1,80}", args.id):
            raise SystemExit("voice id may contain letters, digits, _ . - only")
        add(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
