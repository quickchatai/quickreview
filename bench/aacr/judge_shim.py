#!/usr/bin/env python3
"""A local OpenAI-compatible judge endpoint backed by pi (ChatGPT/Codex OAuth).

The AACR harness judges semantic matches through an OpenAI chat-completions
client (evaluation/judge.py). The paper's judge is Qwen3-235B; when no such
endpoint is configured, this shim lets the SAME judge prompt run on the model
the shared pi login can reach. It is a stand-in, labelled as one in every
report — never silently equated with the published judge.

Only POST /v1/chat/completions (the last user message is the prompt) and
GET /health. Stdlib only; one `pi -p` per call, tools/extensions/skills/context
files all off, so the judge sees exactly the harness's prompt and nothing else.
The harness calls it sequentially; the lock keeps it that way regardless.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOCK = threading.Semaphore(2)


def ask(model: str, prompt: str, timeout: int) -> str:
    argv = [
        "pi", "-p", "--no-session", "--no-tools", "--no-extensions", "--no-skills",
        "--no-context-files", "--no-prompt-templates", "--no-themes", "--model", model, "--", prompt,
    ]
    last = ""
    for attempt in range(3):
        with LOCK:
            # cwd /tmp: no project .pi/, no context files — the judge sees the
            # harness's prompt and nothing else. The login is the shared one.
            env = {**os.environ, "PI_CODING_AGENT_DIR": os.environ.get("PI_CODING_AGENT_DIR", "/pi-agent")}
            r = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, cwd="/tmp", env=env)
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout.strip()
        last = (r.stderr or r.stdout).strip()[-500:]
        time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"pi judge call failed: {last}")


def make_handler(model: str, timeout: int):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):  # noqa: D401 - quiet access log
            pass

        def _send(self, code: int, obj: dict) -> None:
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == "/health":
                self._send(200, {"ok": True, "model": model})
            else:
                self._send(404, {"error": "not found"})

        def do_POST(self):
            if not self.path.rstrip("/").endswith("/chat/completions"):
                self._send(404, {"error": "not found"})
                return
            req = json.loads(self.rfile.read(int(self.headers.get("content-length", "0"))) or b"{}")
            users = [m for m in req.get("messages", []) if m.get("role") == "user"]
            prompt = users[-1]["content"] if users else ""
            if isinstance(prompt, list):
                prompt = "".join(p.get("text", "") for p in prompt if isinstance(p, dict))
            try:
                text = ask(model, prompt, timeout)
            except Exception as e:  # noqa: BLE001 - the harness scores an error as a non-match
                print(f"judge error: {e}", flush=True)
                self._send(502, {"error": {"message": str(e)}})
                return
            print(f"judge: {text[:60]!r}", flush=True)
            self._send(200, {
                "id": f"chatcmpl-shim-{int(time.time() * 1000)}",
                "object": "chat.completion",
                "created": int(time.time()),
                "model": model,
                "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
            })

    return Handler


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--model", required=True)
    ap.add_argument("--timeout", type=int, default=300)
    a = ap.parse_args()
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), make_handler(a.model, a.timeout))
    print(f"judge shim on 127.0.0.1:{a.port} → {a.model}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
