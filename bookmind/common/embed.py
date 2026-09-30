# SPDX-License-Identifier: AGPL-3.0-or-later
"""Text embeddings for search that matches meaning, not just words.

Two interchangeable embedders:

* StaticEmbedder (default) — WordLlama's "l2_supercat" model: a static table of 32k token vectors
  (256 dims) distilled from large language models' embedding layers. A text's embedding is the mean
  of its token vectors, so it runs on any CPU in milliseconds, needs no GPU and no network, and the
  same arithmetic can run in the browser (see `browser_pack`), which keeps meaning-search offline.
  The weights and tokenizer ship inside the `wordllama` wheel (MIT); we read those files directly
  and never download anything at runtime.
* OllamaEmbedder — a transformer embedding model served by Ollama (e.g. nomic-embed-text), for
  better quality when a model server is available. Server-side only.

Neither is a language model: they map text to vectors, they don't generate text.
"""
from __future__ import annotations

import base64
import logging
from pathlib import Path

import numpy as np

from bookmind.common.config import get_settings

logger = logging.getLogger("bookmind.embed")

BROWSER_DIM = 64  # Matryoshka-style prefix of the 256-dim vectors; retrieval quality holds at 64.


def _normalize(m: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(m, axis=-1, keepdims=True)
    return m / np.where(n == 0, 1, n)


def _quantize(m: np.ndarray) -> tuple[str, list[float]]:
    """Per-row symmetric int8 quantisation -> (base64 bytes, per-row scale)."""
    scale = np.abs(m).max(axis=1)
    scale = np.where(scale == 0, 1, scale) / 127
    q = np.round(m / scale[:, None]).clip(-127, 127).astype(np.int8)
    return base64.b64encode(q.tobytes()).decode(), [float(f"{s:.6g}") for s in scale]


class StaticEmbedder:
    kind = "static"
    min_similarity = 0.2  # calibrated on our queries: on-topic ≥ 0.26, off-topic ≤ 0.18

    def __init__(self, weights: Path, tokenizer: Path, name: str = "wordllama-l2-supercat"):
        from safetensors.numpy import load_file
        from tokenizers import Tokenizer

        self.table = load_file(str(weights))["embedding.weight"].astype(np.float32)
        self.tokenizer = Tokenizer.from_file(str(tokenizer))
        self.tokenizer.no_padding()
        self.tokenizer.no_truncation()
        self.name = name
        self.dim = self.table.shape[1]

    def embed(self, texts: list[str]) -> np.ndarray:
        out = np.empty((len(texts), self.dim), dtype=np.float32)
        for i, enc in enumerate(self.tokenizer.encode_batch(texts)):
            ids = np.clip(np.asarray(enc.ids, dtype=np.int64), 0, len(self.table) - 1)
            out[i] = self.table[ids].mean(axis=0) if len(ids) else 0
        return _normalize(out)

    def wordlike(self, word: str) -> bool:
        """Real words split into few, long tokens ("punishment" -> pun|ishment); keyboard mash
        shatters into 1–2 character pieces ("xqzv" -> x|q|z|v). Static vectors can't tell nonsense
        from meaning by similarity alone, so meaning-only matches are gated on this."""
        pieces = [t for t in self.tokenizer.encode(" " + word.lower(), add_special_tokens=False).tokens if t != "▁"]
        return bool(pieces) and len(word) / len(pieces) >= 3

    def browser_pack(self, windows: np.ndarray, owners: list[int], chunk_ids: list[str], version: str) -> dict:
        """Everything the browser needs to embed a query and rank pages offline.

        * vocab + tokens: the alphanumeric token vectors (case kept, like the tokenizer), truncated to
          BROWSER_DIM and int8-quantised (≈2.8 MB of JSON in all). search.js tokenises the query greedily (longest match) against this
          vocabulary — for these tokens that reproduces the BPE tokenisation closely (cosine ≈ 1.0
          to the full model on our evaluation queries).
        * windows: the passage-window vectors computed here with the full tokenizer, same truncation.
        """
        import re

        vocab = self.tokenizer.get_vocab()
        keep = sorted((tok, i) for tok, i in vocab.items() if re.fullmatch(r"▁?[A-Za-z0-9]+", tok))
        tokens, tscale = _quantize(self.table[[i for _, i in keep], :BROWSER_DIM])
        wins, wscale = _quantize(_normalize(windows[:, :BROWSER_DIM]))
        return {
            "model": f"{self.name}-{BROWSER_DIM}",
            "version": version,
            "dim": BROWSER_DIM,
            "vocab": [tok for tok, _ in keep],
            "tokens": tokens,
            "token_scale": tscale,
            "windows": wins,
            "window_scale": wscale,
            "owners": owners,
            "chunk_ids": chunk_ids,
        }


class OllamaEmbedder:
    kind = "ollama"
    min_similarity = 0.3  # transformer similarities run higher; tune per model

    def __init__(self, url: str, model: str):
        import httpx

        self.url, self.name, self.dim = url, model, None
        self.client = httpx.AsyncClient(timeout=60)

    async def aembed(self, texts: list[str]) -> np.ndarray:
        vecs = []
        for i in range(0, len(texts), 64):
            res = await self.client.post(self.url, json={"model": self.name, "input": texts[i : i + 64]})
            res.raise_for_status()
            vecs += res.json()["embeddings"]
        m = np.asarray(vecs, dtype=np.float32)
        self.dim = m.shape[1]
        return _normalize(m)


def find_static_model() -> tuple[Path, Path] | None:
    """Locate the WordLlama weights + tokenizer shipped in the installed wheel (no network)."""
    try:
        import wordllama
    except ImportError:
        return None
    pkg = Path(wordllama.__file__).parent
    weights = pkg / "weights" / "l2_supercat_256.safetensors"
    tokenizer = pkg / "tokenizers" / "l2_supercat_tokenizer_config.json"
    return (weights, tokenizer) if weights.is_file() and tokenizer.is_file() else None


def load_embedder():
    """The configured embedder, or None (keyword search only). Never raises."""
    s = get_settings()
    choice = (s.embedder or "auto").lower()
    if choice == "off":
        return None
    if choice == "ollama":
        return OllamaEmbedder(s.embed_url, s.embed_model)
    files = find_static_model()
    if files is None:
        if choice == "static":
            logger.warning("BOOKMIND_EMBEDDER=static but the wordllama package isn't installed")
        return None
    try:
        return StaticEmbedder(*files)
    except Exception:  # noqa: BLE001 — a broken model must not take search down
        logger.exception("could not load the static embedding model")
        return None
