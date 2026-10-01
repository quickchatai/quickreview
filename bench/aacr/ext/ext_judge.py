#!/usr/bin/env python3
"""The external benchmarks' judge endpoint: gpt-6.1-sol behind an
OpenAI-compatible Chat Completions route, for the Martian and SWE-PRBench
harnesses' OWN judge clients (bench/aacr/EXTERNAL-BENCHMARKS.md).

It is codex_bridge.py (the loopback bridge the OCR/OpenCode/PR-Agent arms
already use) with three differences, all about being a judge rather than an
agent's model:

  * it binds the address it is told (`--host`): the harness runs in ANOTHER
    container whose only network is an internal docker network shared with
    this one, so loopback would not reach it;
  * its gate is wide (`--max-inflight`, default 64): both harnesses wrap every
    call in a 30 s (Martian) / 120 s (SWE-PRBench) client timeout that starts
    before the request is sent, so a request queued behind the gate would
    time out unseen;
  * it records, once at start, whether the upstream accepts a sampling
    temperature (`--probe-temperature`): both harnesses ask for temperature 0,
    and the bridge drops it — the probe is the evidence for why.

What it keeps from codex_bridge, unchanged: the SYSTEM message goes through as
the Responses `instructions` (judge_shim.py, the AACR judge, sends only the
last user message — harmless there because AACR's judge sends no system
message, wrong for these two harnesses, which both do); the model and the
reasoning effort are forced and logged on every request; every dropped
request key (temperature, max_tokens, …) is logged; usage is logged per
request, so the judge's tokens are counted. Credentials: the sandbox's own
refresh-disabled copy of the pi login (codex_bridge.load_credentials refuses
anything else).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import codex_bridge as cb  # noqa: E402


def probe_temperature(bridge: "cb.Bridge") -> dict:
    """One tiny call WITH temperature 0, straight to the upstream: accepted or not."""
    body, _ = cb.chat_to_responses(
        {"messages": [{"role": "system", "content": "Answer with one word."},
                      {"role": "user", "content": "Say OK."}]},
        bridge.a.model, bridge.a.effort, bridge.a.verbosity)
    body["temperature"] = 0
    try:
        bridge.call(body)
        return {"probe": "temperature", "accepted": True}
    except cb.BridgeError as e:
        return {"probe": "temperature", "accepted": False, "status": e.status, "error": str(e)[:400]}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--model", default="gpt-6.1-sol")
    ap.add_argument("--effort", default="low")
    ap.add_argument("--verbosity", default="medium")
    ap.add_argument("--auth", default=os.path.join(os.environ.get("PI_CODING_AGENT_DIR", "/tmp/pi-agent"), "auth.json"))
    ap.add_argument("--upstream", default=cb.UPSTREAM)
    ap.add_argument("--log", default="")
    ap.add_argument("--max-inflight", type=int, default=64)
    ap.add_argument("--read-timeout", type=int, default=600)
    ap.add_argument("--probe-temperature", action="store_true")
    a = ap.parse_args()
    cb.load_credentials(a.auth)  # refuse to start on a wrong/real auth file
    bridge = cb.Bridge(a)
    if a.probe_temperature:
        row = probe_temperature(bridge)
        bridge.log({**row, "model": a.model, "effort": a.effort})
        print(f"ext-judge: {json.dumps(row)}", flush=True)
    srv = ThreadingHTTPServer((a.host, a.port), cb.make_handler(bridge))
    srv.daemon_threads = True
    print(f"ext-judge on {a.host}:{a.port} → {a.upstream} ({a.model}, effort {a.effort}, "
          f"max in flight {a.max_inflight}) {time.strftime('%FT%TZ', time.gmtime())}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
