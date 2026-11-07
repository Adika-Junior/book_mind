# SPDX-License-Identifier: AGPL-3.0-or-later
import os
import tempfile
from pathlib import Path

import pytest

# Configure BEFORE importing bookmind: settings are read once at import.
_tmp = Path(tempfile.mkdtemp(prefix="bookmind-test-"))
os.environ["BOOKMIND_DB_PATH"] = str(_tmp / "notebook.db")
os.environ["BOOKMIND_ACCOUNTS_DB_PATH"] = str(_tmp / "accounts.db")
os.environ.pop("BOOKMIND_AUTH_MODE", None)
os.environ["BOOKMIND_FLAGS_PATH"] = str(_tmp / "flags.json")
os.environ["BOOKMIND_OLLAMA_URL"] = "http://127.0.0.1:9/api/chat"  # nothing listens: model "down"
os.environ["BOOKMIND_OLLAMA_TIMEOUT_S"] = "1"
os.environ["BOOKMIND_RATE_API_BURST"] = "10000"
os.environ["BOOKMIND_RATE_RESEARCH_BURST"] = "10000"
os.environ.pop("BOOKMIND_REDIS_URL", None)
os.environ.pop("BOOKMIND_AUTH_PASSWORD", None)

# Password of the first admin whenever a test turns accounts on (created once per test session).
ADMIN_PW = "admin-passphrase-for-tests"

import httpx  # noqa: E402

from bookmind import local  # noqa: E402,F401  (registers every service in-process)
from bookmind.services import gateway  # noqa: E402


@pytest.fixture(scope="session")
def tmp_dir() -> Path:
    return _tmp


@pytest.fixture
async def client():
    app = gateway.app
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app, client=("10.0.0.1", 1234))
        # The app sends X-BookMind: 1 on every API call (CSRF guard); so does this client.
        async with httpx.AsyncClient(transport=transport, base_url="http://test", headers={"X-BookMind": "1"}) as c:
            yield c
