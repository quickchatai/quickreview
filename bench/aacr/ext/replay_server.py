#!/usr/bin/env python3
"""SWE-PRBench's "agent model", replayed: QuickReview's finished review served
on an OpenAI-compatible Chat Completions route (bench/aacr/EXTERNAL-BENCHMARKS.md).

SWE-PRBench evaluates a model by sending it ONE request per (PR, context
config): the harness's fixed system prompt and the PR's packed context, and it
parses a JSON array of comments out of the answer. QuickReview is not a model
that answers a packed context — it reads the repository itself — so its review
is produced beforehand by the bench harness, exported to exactly that JSON
array (sweprbench_export.py), and this endpoint hands it back when the harness
asks about that PR.

The lookup key is the sha256 of the user message — the context's `rendered`
text, as the harness sends it — mapped to a task by the exporter, which reads
the same context files. It NEVER answers anything else:

  * an unknown context (another PR, a retry that appended text, a changed
    dataset) is refused with HTTP 404 and logged as a MISS — never forwarded to
    a live model, never guessed;
  * a system prompt other than the harness's own AGENT_SYSTEM_PROMPT is
    refused the same way (the replay stands in for a model under THAT prompt);
  * the table names its source run and the sha256 of its own content; both are
    logged at start.

Every request is logged as JSON lines (--log): ts, sha, task, config, hit.
Stdlib only, plus the harness's own module for the system prompt.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--table", help="replay table from sweprbench_export.py")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8790)
    ap.add_argument("--log", default="/tmp/replay.jsonl")
    ap.add_argument("--self-test", action="store_true", help="serve a one-entry table and probe it")
    a = ap.parse_args()

    from eval_harness.runner import AGENT_SYSTEM_PROMPT  # the harness's own prompt

    if a.self_test:
        ctx = "## Diff\n+x = 1\n"
        raw = json.dumps({"source_run": "self-test", "entries": {
            sha256(ctx): {"task_id": "t__1", "config": "config_A_diff_only", "content": "[]", "user": ctx}}})
        a.host, a.port = "127.0.0.1", 0
    else:
        if not a.table:
            ap.error("--table is required")
        raw = open(a.table, encoding="utf-8").read()
    table = json.loads(raw)
    entries: dict = table["entries"]
    want_system = sha256(AGENT_SYSTEM_PROMPT)
    lock = threading.Lock()
    logf = open(a.log, "a", encoding="utf-8")

    def log(row: dict) -> None:
        line = json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **row})
        with lock:
            logf.write(line + "\n")
            logf.flush()
        if not row.get("hit", True):
            print(f"replay MISS: {line}", flush=True)

    log({"event": "start", "table_sha256": sha256(raw), "source_run": table.get("source_run"),
         "entries": len(entries), "system_prompt_sha256": want_system, "hit": True})
    print(f"replay on {a.host}:{a.port}: {len(entries)} contexts from {table.get('source_run')}", flush=True)

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):  # noqa: D401 - the JSON log is the access log
            pass

        def _send(self, code: int, obj: dict) -> None:
            body = json.dumps(obj).encode("utf-8")
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == "/health":
                self._send(200, {"ok": True, "entries": len(entries)})
            else:
                self._send(404, {"error": {"message": "not found"}})

        def do_POST(self):
            if not self.path.split("?", 1)[0].rstrip("/").endswith("/chat/completions"):
                self._send(404, {"error": {"message": "no such route"}})
                return
            req = json.loads(self.rfile.read(int(self.headers.get("content-length", "0") or 0)) or b"{}")
            msgs = req.get("messages") or []
            system = "".join(m.get("content") or "" for m in msgs if m.get("role") == "system")
            users = [m.get("content") or "" for m in msgs if m.get("role") == "user"]
            key = sha256(users[-1]) if users else ""
            entry = entries.get(key)
            row = {"sha": key, "model": req.get("model"), "system_ok": sha256(system) == want_system}
            if not row["system_ok"]:
                log({**row, "hit": False, "why": "system prompt is not the harness's AGENT_SYSTEM_PROMPT"})
                self._send(404, {"error": {"message": "replay: unexpected system prompt"}})
                return
            if entry is None:
                log({**row, "hit": False, "why": "unknown context"})
                self._send(404, {"error": {"message": "replay: no recorded review for this context"}})
                return
            log({**row, "hit": True, "task": entry["task_id"], "config": entry["config"]})
            self._send(200, {
                "id": f"replay-{key[:16]}",
                "object": "chat.completion",
                "created": int(time.time()),
                "model": req.get("model"),
                "choices": [{"index": 0, "finish_reason": "stop",
                             "message": {"role": "assistant", "content": entry["content"]}}],
                "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
            })

    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    srv.daemon_threads = True
    if a.self_test:
        self_test(srv, AGENT_SYSTEM_PROMPT, entries)
        return
    srv.serve_forever()


def self_test(srv, system: str, entries: dict) -> None:
    """A recorded context is answered; an unknown one and a foreign system prompt are refused."""
    import urllib.error
    import urllib.request

    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{srv.server_address[1]}/v1/chat/completions"

    def post(sys_text: str, user: str) -> int:
        body = json.dumps({"model": "m", "messages": [{"role": "system", "content": sys_text},
                                                      {"role": "user", "content": user}]}).encode()
        try:
            with urllib.request.urlopen(urllib.request.Request(url, data=body, method="POST"), timeout=5) as r:
                return r.status
        except urllib.error.HTTPError as e:
            return e.code

    known = next(iter(entries.values()))
    assert post(system, known["user"]) == 200, "a recorded context must be answered"
    assert post(system, known["user"] + "\nReturn ONLY a valid JSON array.") == 404, "an unknown context must be refused"
    assert post("You are a helpful assistant.", known["user"]) == 404, "a foreign system prompt must be refused"
    print("replay self-test ok: hit answered, unknown context refused, foreign system prompt refused")
    srv.shutdown()


if __name__ == "__main__":
    main()
