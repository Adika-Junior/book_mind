# SPDX-License-Identifier: AGPL-3.0-or-later
"""Stand-in for Ollama's HTTP API (/api/chat, /api/tags), so the model path is tested end to end.

It answers in the shape the prompts ask for and echoes which sections it was given, so tests can
check that web sources reach the model only when the reader opted in.
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer


class H(BaseHTTPRequestHandler):
    def _send(self, body, status=200):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith("/api/tags"):
            return self._send({"models": [{"name": "llama3.2:latest"}]})
        self._send({"error": "not found"}, 404)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        prompt = body["messages"][-1]["content"]
        web = "<web_sources>" in prompt
        answer = (
            "## Plain-English explanation\nProviders and deployers of high-risk systems must assess risks first. [Bill, p.9]\n"
            "## Why it matters\nIt puts duties on those who build and use AI. [Digest, p.14]"
        )
        if web:
            answer += "\n## Beyond the documents\nThe Senate page lists the Bill. [Web: parliament.go.ke]"
        self._send({"model": body.get("model"), "message": {"role": "assistant", "content": answer}, "done": True})

    def log_message(self, *a):
        pass


HTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 11435), H).serve_forever()
