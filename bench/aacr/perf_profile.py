#!/usr/bin/env python3
"""Where one QuickReview benchmark review spends its wall time.

  bench/aacr/perf_profile.py $QCR_BENCH_RUNS_DIR/<run> [--json]

Reads each case's pi-events.jsonl (pi --mode json) and splits the session
into its serial phases. pi stamps every message with a time, so a phase is
the gap between the last message before a tool call and the first message
after it returns:

  prep      session start → the lens fan-out starts (reading the order, the diff)
  fan-out   the parallel lens subagents, from the session starting the tool
            call to its return, split into task_gen (the session generating
            every lens's task string — tool-call arguments are output tokens —
            before the first child starts) and lens_run (first child start to
            last child end); par = most children seen running at once
            (the slowest and the median lens are reported beside it)
  validate  the pass-validate subagent: val_gen (writing its task) + val_run
  between   the main session's own turns between the fan-out and the validator
  write     every turn after the validator: the session generating comments.json,
            review.md, findings-record.json and outcome.json (the model writes
            each file's whole content as output tokens)
  other     anything else (extra subagent calls, retries)

Container start-up, the lens-agent build and the deps fetch sit outside pi;
case-summary's duration_seconds is pi's own run, so they are reported from
the run's review.log when it has them. Read-only: writes nothing.
"""
from __future__ import annotations

import json
import statistics
import sys
from pathlib import Path


def messages_ts(d: dict) -> list[int]:
    m = d.get("message")
    if isinstance(m, dict) and isinstance(m.get("timestamp"), (int, float)):
        return [int(m["timestamp"])]
    return []


def child_windows(result: dict) -> list[tuple[str, int, int]]:
    """(agent, first ms, last ms) of each child of a subagent tool result, from
    the child's own message stamps (its pi start-up is outside them)."""
    out = []
    det = (result or {}).get("details") or {}
    for r in det.get("results") or []:
        ts = [m.get("timestamp") for m in r.get("messages") or [] if isinstance(m, dict) and isinstance(m.get("timestamp"), (int, float))]
        name = r.get("agent") or r.get("name") or "?"
        if len(ts) >= 2:
            out.append((str(name), int(min(ts)), int(max(ts))))
    return out


def child_spans(result: dict) -> list[tuple[str, float]]:
    """(agent, seconds) for each child of a subagent tool result."""
    return [(n, (b - a) / 1000) for n, a, b in child_windows(result)]


def max_overlap(windows: list[tuple[str, int, int]]) -> int:
    ev = sorted([(a, 1) for _, a, _ in windows] + [(b, -1) for _, _, b in windows])
    cur = best = 0
    for _, d in ev:
        cur += d
        best = max(best, cur)
    return best


def profile_case(events: Path) -> dict | None:
    rows = []
    for line in events.open(encoding="utf8", errors="replace"):
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    start = None
    for d in rows:
        if d.get("type") == "session" and d.get("timestamp"):
            from datetime import datetime
            start = int(datetime.fromisoformat(d["timestamp"].replace("Z", "+00:00")).timestamp() * 1000)
            break
    # Walk the stream keeping the last message time seen; a tool batch opens at
    # its first tool_execution_start and closes at the next message after the
    # last tool_execution_end.
    last_ts = start
    phases: list[tuple[str, int, int, dict]] = []
    open_batch: dict | None = None
    for d in rows:
        t = d.get("type")
        for ts in messages_ts(d):
            if open_batch is not None and open_batch["pending"] == 0:
                phases.append((open_batch["kind"], open_batch["t0"], ts, open_batch))
                open_batch = None
            last_ts = ts
        if t == "tool_execution_start":
            args = d.get("args") or {}
            agents: list[str] = []
            if d.get("toolName") == "subagent":
                # one agent, or pi-subagents' parallel mode: a `tasks` list
                agents = [str(args["agent"])] if args.get("agent") else \
                    [str(x.get("agent")) for x in args.get("tasks") or [] if isinstance(x, dict)]
            if agents:
                kind = "validate" if all(a.startswith("pass-validate") for a in agents) else "lens"
            else:
                kind = str(d.get("toolName"))
            if open_batch is None:
                open_batch = {"kind": kind, "t0": last_ts, "pending": 0, "agents": [], "children": []}
            elif kind == "lens":
                open_batch["kind"] = "lens"
            open_batch["pending"] += 1
            open_batch["agents"] += agents
        elif t == "tool_execution_end" and open_batch is not None:
            open_batch["pending"] -= 1
            if d.get("toolName") == "subagent":
                open_batch["children"] += child_windows(d.get("result") or {})
    end = last_ts
    if start is None or end is None:
        return None
    out = {"total": (end - start) / 1000, "prep": 0.0, "fanout": 0.0, "validate": 0.0, "between": 0.0,
           "write": 0.0, "other": 0.0, "lenses": 0, "slowest_lens": 0.0, "median_lens": 0.0,
           "task_gen": 0.0, "lens_run": 0.0, "lens_par": 0, "val_gen": 0.0, "val_run": 0.0}
    fan = next((p for p in phases if p[0] == "lens"), None)
    val = next((p for p in phases if p[0] == "validate"), None)
    if fan:
        out["prep"] = (fan[1] - start) / 1000
        out["fanout"] = (fan[2] - fan[1]) / 1000
        wins = fan[3]["children"]
        spans = [(b - a) / 1000 for _, a, b in wins]
        out["lenses"] = len(fan[3]["agents"])
        if spans:
            out["slowest_lens"] = max(spans)
            out["median_lens"] = statistics.median(spans)
            first = min(a for _, a, _ in wins)
            # task_gen: the session writing the lens task strings (the tool
            # call's arguments are output tokens) before the first child runs.
            out["task_gen"] = (first - fan[1]) / 1000
            out["lens_run"] = (max(b for _, _, b in wins) - first) / 1000
            out["lens_par"] = max_overlap(wins)
    if val:
        out["validate"] = (val[2] - val[1]) / 1000
        if val[3]["children"]:
            a = min(x for _, x, _ in val[3]["children"])
            b = max(y for _, _, y in val[3]["children"])
            out["val_gen"] = (a - val[1]) / 1000
            out["val_run"] = (b - a) / 1000
        if fan:
            out["between"] = (val[1] - fan[2]) / 1000
        out["write"] = (end - val[2]) / 1000
    out["other"] = max(0.0, out["total"] - sum(out[k] for k in ("prep", "fanout", "validate", "between", "write")))
    return out


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) != 1:
        raise SystemExit(__doc__)
    run = Path(args[0])
    per = {}
    for c in sorted((run / "cases").iterdir()):
        ev = c / "pi-events.jsonl"
        if ev.exists():
            p = profile_case(ev)
            if p:
                per[c.name] = p
    if "--json" in sys.argv:
        print(json.dumps(per, indent=1))
        return
    keys = ["total", "prep", "fanout", "task_gen", "lens_run", "validate", "val_gen", "val_run", "between",
            "write", "other", "slowest_lens", "median_lens"]
    print(f"{'case':40s} " + " ".join(f"{k[:8]:>8s}" for k in keys) + "  lenses  par")
    for name, p in per.items():
        print(f"{name[:40]:40s} " + " ".join(f"{p[k]:8.0f}" for k in keys) + f"  {p['lenses']:6d} {p['lens_par']:4d}")
    if per:
        med = {k: statistics.median(p[k] for p in per.values()) for k in keys}
        tot = sum(p["total"] for p in per.values())
        print(f"{'median':40s} " + " ".join(f"{med[k]:8.0f}" for k in keys))
        share = {k: sum(p[k] for p in per.values()) / tot
                 for k in ("prep", "task_gen", "lens_run", "val_gen", "val_run", "between", "write")}
        share["rest"] = 1 - sum(share.values())
        print("share of summed wall time: " + ", ".join(f"{k} {v:.0%}" for k, v in share.items()))


if __name__ == "__main__":
    main()
