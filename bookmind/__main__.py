# SPDX-License-Identifier: AGPL-3.0-or-later
"""`python -m bookmind [--host 127.0.0.1] [--port 8000]` — run everything in one process."""
import argparse

import uvicorn


def main() -> None:
    parser = argparse.ArgumentParser(description="Run BookMind (all services, single process).")
    parser.add_argument("--host", default="127.0.0.1", help="use 0.0.0.0 to reach it from your phone on the same Wi-Fi")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    uvicorn.run("bookmind.local:app", host=args.host, port=args.port, proxy_headers=False, access_log=False)


if __name__ == "__main__":
    main()
