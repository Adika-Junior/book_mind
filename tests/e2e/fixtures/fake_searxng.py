# SPDX-License-Identifier: AGPL-3.0-or-later
"""Stand-in for a SearXNG instance's JSON API, so web search can be tested without the internet.

Returns one result from each source tier the app ranks (official Kenyan, intergovernmental,
reference, unknown blog) in deliberately *wrong* order, so tests prove the app re-ranks them.
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

RESULTS = [
    {
        "title": "Commentary: what the AI Bill means",
        "url": "https://techblog.example/ai-bill",
        "content": "An opinion piece on <b>Kenya's</b> AI Bill.",
    },
    {
        "title": "The Artificial Intelligence Bill, 2026 — Senate of Kenya",
        "url": "https://www.parliament.go.ke/the-senate/ai-bill-2026",
        "content": "Senate Bills: The Artificial Intelligence Bill, 2026 (Senate Bill No. 4).",
    },
    {
        "title": "OECD AI Principles",
        "url": "https://oecd.ai/en/ai-principles",
        "content": "The OECD AI Principles promote use of AI that is innovative and trustworthy.",
    },
    {
        "title": "Artificial intelligence in Kenya",
        "url": "https://en.wikipedia.org/wiki/Artificial_intelligence_in_Kenya",
        "content": "Overview of AI policy and adoption in Kenya.",
    },
]


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        query = parse_qs(urlparse(self.path).query).get("q", [""])[0]
        data = json.dumps({"query": query, "results": RESULTS}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    HTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 8899), Handler).serve_forever()
