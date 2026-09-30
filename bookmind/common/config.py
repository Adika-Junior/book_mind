# SPDX-License-Identifier: AGPL-3.0-or-later
"""Configuration, secrets and dynamic feature flags (blueprint §7).

* Static config comes from the environment (12-factor), optionally seeded by a `.env` file.
* Secrets use the `NAME_FILE` convention: when `BOOKMIND_AUTH_PASSWORD_FILE=/run/secrets/x` is set,
  the value is read from that file. This is how Docker secrets, Kubernetes Secret volumes, and
  the Vault Agent injector / External Secrets Operator all hand secrets to a process, so rotating
  a secret never needs a code change. Secrets are re-read on every call, so file-based rotation
  takes effect without a restart.
* Feature flags live in a JSON file that is hot-reloaded on change, with optional per-key
  overrides in the shared KV store (Redis hash `bm:flags`) so operators can flip a kill switch
  for every replica at once without redeploying.
"""
from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from urllib.parse import quote

try:  # optional: local convenience only; real env vars always win
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:  # pragma: no cover
    pass

ROOT_DIR = Path(__file__).resolve().parents[2]


def env(name: str, default: str | None = None) -> str | None:
    value = os.environ.get(name)
    return default if value is None or value == "" else value


def env_int(name: str, default: int) -> int:
    return int(env(name, str(default)))


def env_float(name: str, default: float) -> float:
    return float(env(name, str(default)))


def secret(name: str, default: str | None = None) -> str | None:
    """Read a secret from `<name>_FILE` if set (mounted secret), else from `<name>`."""
    path = os.environ.get(name + "_FILE")
    if path:
        try:
            return Path(path).read_text(encoding="utf-8").strip() or default
        except OSError:
            return default
    return env(name, default)


def _redis_url() -> str | None:
    """BOOKMIND_REDIS_URL, with the password injected from BOOKMIND_REDIS_PASSWORD(_FILE) if set,
    so the URL itself can live in plain config while the password stays a mounted secret."""
    url = secret("BOOKMIND_REDIS_URL")
    password = secret("BOOKMIND_REDIS_PASSWORD")
    if url and password and "@" not in url.split("://", 1)[-1]:
        scheme, rest = url.split("://", 1)
        url = f"{scheme}://:{quote(password, safe='')}@{rest}"
    return url


@dataclass(frozen=True)
class Settings:
    service_name: str = field(default_factory=lambda: env("BOOKMIND_SERVICE", "bookmind"))
    environment: str = field(default_factory=lambda: env("BOOKMIND_ENV", "local"))
    log_level: str = field(default_factory=lambda: env("BOOKMIND_LOG_LEVEL", "INFO"))

    data_path: Path = field(
        default_factory=lambda: Path(env("BOOKMIND_DATA_PATH", str(ROOT_DIR / "data" / "chunks.json")))
    )
    db_path: Path = field(
        default_factory=lambda: Path(env("BOOKMIND_DB_PATH", str(ROOT_DIR / "data" / "notebook.db")))
    )
    web_dir: Path = field(default_factory=lambda: Path(env("BOOKMIND_WEB_DIR", str(ROOT_DIR / "web"))))
    flags_path: Path = field(
        default_factory=lambda: Path(
            env("BOOKMIND_FLAGS_PATH", str(ROOT_DIR / "deploy" / "config" / "flags.json"))
        )
    )

    # Shared infrastructure. Unset => in-memory implementations (single-process / laptop mode).
    redis_url: str | None = field(default_factory=lambda: _redis_url())

    # Model runner (research service only).
    ollama_url: str = field(
        default_factory=lambda: env("BOOKMIND_OLLAMA_URL", "http://localhost:11434/api/chat")
    )
    ollama_model: str = field(default_factory=lambda: env("BOOKMIND_OLLAMA_MODEL", "llama3.2"))
    ollama_timeout_s: float = field(default_factory=lambda: env_float("BOOKMIND_OLLAMA_TIMEOUT_S", 120))
    max_concurrent_generations: int = field(
        default_factory=lambda: env_int("BOOKMIND_MAX_CONCURRENT_GENERATIONS", 2)
    )

    # Edge / gateway.
    auth_user: str = field(default_factory=lambda: env("BOOKMIND_AUTH_USER", "bookmind"))
    allowed_origins: tuple[str, ...] = field(
        default_factory=lambda: tuple(o for o in (env("BOOKMIND_ALLOWED_ORIGINS", "") or "").split(",") if o)
    )
    trust_proxy_headers: bool = field(
        default_factory=lambda: env("BOOKMIND_TRUST_PROXY", "false").lower() == "true"
    )
    max_selection_chars: int = field(default_factory=lambda: env_int("BOOKMIND_MAX_SELECTION_CHARS", 2000))
    max_context_chars: int = field(default_factory=lambda: env_int("BOOKMIND_MAX_CONTEXT_CHARS", 6000))
    max_body_bytes: int = field(default_factory=lambda: env_int("BOOKMIND_MAX_BODY_BYTES", 64_000))
    rate_api_per_s: float = field(default_factory=lambda: env_float("BOOKMIND_RATE_API_PER_S", 20))
    rate_api_burst: int = field(default_factory=lambda: env_int("BOOKMIND_RATE_API_BURST", 60))
    rate_research_per_min: float = field(
        default_factory=lambda: env_float("BOOKMIND_RATE_RESEARCH_PER_MIN", 10)
    )
    rate_research_burst: int = field(default_factory=lambda: env_int("BOOKMIND_RATE_RESEARCH_BURST", 5))

    # Semantic search (bookmind/common/embed.py). "auto" = the bundled static model if installed.
    embedder: str = field(default_factory=lambda: env("BOOKMIND_EMBEDDER", "auto"))
    embed_url: str = field(default_factory=lambda: env("BOOKMIND_EMBED_URL", "http://localhost:11434/api/embed"))
    embed_model: str = field(default_factory=lambda: env("BOOKMIND_EMBED_MODEL", "nomic-embed-text"))
    semantic_weight: float = field(default_factory=lambda: env_float("BOOKMIND_SEMANTIC_WEIGHT", 0.7))

    # Read-aloud with Piper neural voices (bookmind/services/tts.py).
    voices_dir: Path = field(
        default_factory=lambda: Path(env("BOOKMIND_VOICES_DIR", str(ROOT_DIR / "data" / "voices")))
    )
    tts_max_chars: int = field(default_factory=lambda: env_int("BOOKMIND_TTS_MAX_CHARS", 600))
    tts_concurrency: int = field(default_factory=lambda: env_int("BOOKMIND_TTS_CONCURRENCY", 2))

    # Telemetry.
    otlp_endpoint: str | None = field(default_factory=lambda: env("OTEL_EXPORTER_OTLP_ENDPOINT"))

    @property
    def auth_password(self) -> str | None:
        # A property, not a field: re-read on each request so a rotated secret file applies live.
        return secret("BOOKMIND_AUTH_PASSWORD")

    @property
    def internal_token(self) -> str | None:
        return secret("BOOKMIND_INTERNAL_TOKEN")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


DEFAULT_FLAGS: dict[str, object] = {
    "research_enabled": True,  # "Research this" in the reader
    "simplify_enabled": True,  # "Simplify / define" in the reader
    "llm_enabled": True,  # kill switch: false => extractive answers only, never call the model
    "notes_search_enabled": True,  # include your notebook in search results
    "web_search_enabled": True,  # allow opt-in web search (each device still has to opt in)
    "neural_voices_enabled": True,  # offer the server's Piper voices for read-aloud
    "maintenance_message": "",  # shown as a banner in every client when non-empty
}


class FeatureFlags:
    """File-backed flags with hot reload plus KV overrides. Cheap enough to call per request."""

    def __init__(self, path: Path, kv=None, check_interval_s: float = 2.0):
        self.path = path
        self.kv = kv
        self.check_interval_s = check_interval_s
        self._file_flags: dict[str, object] = {}
        self._mtime: float | None = None
        self._checked_at = 0.0

    def _reload_file(self) -> None:
        now = time.monotonic()
        if now - self._checked_at < self.check_interval_s and self._mtime is not None:
            return
        self._checked_at = now
        try:
            mtime = self.path.stat().st_mtime
        except OSError:
            self._file_flags, self._mtime = {}, 0.0
            return
        if mtime != self._mtime:
            try:
                self._file_flags = json.loads(self.path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                pass  # keep last good config rather than failing requests on a bad edit
            self._mtime = mtime

    async def all(self) -> dict[str, object]:
        self._reload_file()
        flags = {**DEFAULT_FLAGS, **self._file_flags}
        if self.kv is not None:
            try:
                overrides = await self.kv.hgetall("bm:flags")
            except Exception:
                overrides = {}
            for key, raw in overrides.items():
                try:
                    flags[key] = json.loads(raw)
                except ValueError:
                    flags[key] = raw
        return flags

    async def enabled(self, name: str) -> bool:
        return bool((await self.all()).get(name, False))
