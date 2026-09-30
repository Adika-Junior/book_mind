# SPDX-License-Identifier: AGPL-3.0-or-later
"""Single-process mode: every service in one Python process, wired in-process.

    python -m bookmind            # or: uvicorn bookmind.local:app

The same service code as the containerised deployment, but service discovery resolves each
name to an in-process ASGI app instead of a network address, and the event bus / KV store use
in-memory backends (unless BOOKMIND_REDIS_URL is set). No Docker, Redis or network needed —
this is the "runs on my laptop, offline, for free" mode.
"""
from __future__ import annotations

from contextlib import AsyncExitStack, asynccontextmanager

from bookmind.common.rpc import register_inproc
from bookmind.services import catalog, gateway, notebook, research, search

SERVICES = {"catalog": catalog.app, "search": search.app, "research": research.app, "notebook": notebook.app}

for _name, _app in SERVICES.items():
    register_inproc(_name, _app)

app = gateway.app
_gateway_lifespan = app.router.lifespan_context


@asynccontextmanager
async def _all_lifespans(asgi_app):
    # In-process calls don't trigger the sub-apps' ASGI lifespan, so run them here.
    async with AsyncExitStack() as stack:
        for sub in SERVICES.values():
            await stack.enter_async_context(sub.router.lifespan_context(sub))
        await stack.enter_async_context(_gateway_lifespan(asgi_app))
        yield


app.router.lifespan_context = _all_lifespans
