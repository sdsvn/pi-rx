#!/usr/bin/env python3
"""Serve the rendered HTML for live review. Stdlib only, localhost only.

Usage:
    live_review.py <page.html> <feedback.jsonl> [port]

GET  /            -> the page
GET  /version     -> the page's mtime (the browser polls this and reloads on change)
POST /feedback    -> appends the JSON body as one line to <feedback.jsonl>

Regenerate the page with render_html.py --live -o <page.html> whenever the
design changes; every open browser reloads itself within ~2s.
"""
import http.server
import os
import sys

DOC = sys.argv[1]
FEEDBACK = sys.argv[2]
PORT = int(sys.argv[3]) if len(sys.argv) > 3 else 8321


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/version":
            body, ctype = str(os.stat(DOC).st_mtime).encode(), "text/plain"
        else:
            body, ctype = open(DOC, "rb").read(), "text/html; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        with open(FEEDBACK, "a", encoding="utf-8") as f:
            f.write(self.rfile.read(n).decode() + "\n")
        self.send_response(204)
        self.end_headers()

    def log_message(self, format, *args):
        pass


if __name__ == "__main__":
    print(f"http://127.0.0.1:{PORT}", flush=True)
    http.server.HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
