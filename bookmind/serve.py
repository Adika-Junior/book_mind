# SPDX-License-Identifier: AGPL-3.0-or-later
"""Container entrypoint: `SERVICE=<name> python -m bookmind.serve`.

One image, many services — the orchestrator decides which one a container runs. SERVICE=all
runs the single-process build (handy for a small VPS or a Raspberry Pi).
"""
import os

import uvicorn

SERVICES = {"gateway", "catalog", "search", "research", "notebook"}


def main() -> None:
    name = os.environ.get("SERVICE", "gateway")
    target = "bookmind.local:app" if name == "all" else f"bookmind.services.{name}:app"
    if name != "all" and name not in SERVICES:
        raise SystemExit(f"Unknown SERVICE={name!r}; expected one of {sorted(SERVICES | {'all'})}")
    uvicorn.run(
        target,
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "8000")),
        proxy_headers=False,  # client IPs come from the edge's X-Real-IP (BOOKMIND_TRUST_PROXY)
        access_log=False,  # structured access logs come from the platform middleware
        timeout_graceful_shutdown=20,  # finish in-flight requests on SIGTERM (rolling updates)
        timeout_keep_alive=30,
    )


if __name__ == "__main__":
    main()
