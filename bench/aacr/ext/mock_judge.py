#!/usr/bin/env python3
"""PLUMBING ONLY — a fake judge for wiring checks (ext.sh ... with EXT_JUDGE=mock).

Answers the Martian and SWE-PRBench judge prompts with well-formed, contentless
JSON (no issue matches, nothing confirmed), so the containers, the internal
network, the harness invocations and the report extraction can be exercised
with no model and no login. Its numbers mean nothing; every output dir of a
mock run is suffixed `-MOCK` by ext.sh.
"""
from __future__ import annotations

import argparse
import json
import re
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def answer(system: str, user: str) -> dict:
    if "extract code review issues" in system:
        first = re.sub(r"\s+", " ", user.split("Code Review Comment:", 1)[-1]).strip()[:120]
        return {"issues": [first] if first else []}
    if "group duplicate" in system:
        n = len(re.findall(r"(?m)^\d+\. ", user))
        return {"groups": [[i] for i in range(n)]}
    if "precise code review evaluator" in system:
        return {"reasoning": "mock", "match": False, "confidence": 0.0}
    if "assessing AI code review quality" in system:
        return {"agent_classifications": [], "human_comment_statuses": []}
    return {"mock": True}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8765)
    a = ap.parse_args()

    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass

        def _send(self, code: int, obj: dict) -> None:
            b = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)

        def do_GET(self):
            self._send(200, {"ok": True, "mock": True})

        def do_POST(self):
            req = json.loads(self.rfile.read(int(self.headers.get("content-length", "0") or 0)) or b"{}")
            msgs = req.get("messages") or []
            system = "".join(m.get("content") or "" for m in msgs if m.get("role") == "system")
            user = "".join(m.get("content") or "" for m in msgs if m.get("role") == "user")
            self._send(200, {"id": "mock", "object": "chat.completion", "created": int(time.time()),
                             "model": req.get("model"),
                             "choices": [{"index": 0, "finish_reason": "stop",
                                          "message": {"role": "assistant", "content": json.dumps(answer(system, user))}}],
                             "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}})

    srv = ThreadingHTTPServer((a.host, a.port), H)
    srv.daemon_threads = True
    print(f"MOCK judge on {a.host}:{a.port}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
