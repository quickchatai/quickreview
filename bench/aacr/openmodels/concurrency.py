#!/usr/bin/env python3
"""How much ran at once in an open-model benchmark arm.

  concurrency.py --runs-dir DIR --prefix P --sets s1,s2,... [--samples FILE]

PR level: the peak and the time spent at each count of review containers, from
the sampler log openbench.sh writes (`<epoch> <n>` every 10 s), plus the peak of
overlapping case windows (each case's first to last recorded message).
Lens level, per PR: the peak number of lens children running at once (each
child's first to last message timestamp in the launch_plan / subagent results),
and every child that ended in an error — a zero exit code alone proves nothing.
"""
import argparse, json
from collections import Counter
from pathlib import Path


def children(events: Path):
    """(agent, start_ms, end_ms, stopReason, errorMessage) for every lens child."""
    out = []
    for line in events.open():
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if e.get("type") != "tool_execution_end" or e.get("toolName") not in ("launch_plan", "subagent"):
            continue
        for r in ((e.get("result") or {}).get("details") or {}).get("results") or []:
            ts = [m.get("timestamp") for m in r.get("messages") or [] if isinstance(m, dict) and m.get("timestamp")]
            if ts:
                out.append((r.get("agent"), min(ts), max(ts), r.get("stopReason"), r.get("errorMessage")))
    return out


def peak(windows):
    edges = sorted([(s, 1) for s, _ in windows] + [(e, -1) for _, e in windows])
    cur = best = 0
    for _, d in edges:
        cur += d
        best = max(best, cur)
    return best


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs-dir", required=True, type=Path)
    ap.add_argument("--prefix", required=True)
    ap.add_argument("--sets", required=True)
    ap.add_argument("--samples", type=Path)
    a = ap.parse_args()

    case_windows, errors = [], []
    print(f"{'case':<48}{'lenses':>7}{'peak at once':>14}")
    for s in a.sets.split(","):
        for ev in sorted((a.runs_dir / f"{a.prefix}-{s}" / "cases").glob("*/pi-events.jsonl")):
            ch = children(ev)
            if not ch:
                continue
            case_windows.append((min(c[1] for c in ch), max(c[2] for c in ch)))
            # A lens whose last attempt failed (a retried, recovered one is not an error).
            final = {}
            for c in ch:
                final["--".join((c[0] or "").split("--")[:2])] = c
            errors += [(ev.parent.name, c[0], c[3], c[4]) for c in final.values() if c[3] in ("error", "aborted")]
            print(f"{ev.parent.name:<48}{len(ch):>7}{peak([(c[1], c[2]) for c in ch]):>14}")
    print(f"\nPRs reviewing at once (lens windows overlapping): peak {peak(case_windows)}")
    if a.samples and a.samples.is_file():
        counts = Counter(int(l.split()[1]) for l in a.samples.read_text().split("\n") if len(l.split()) == 2)
        if counts:
            mins = ", ".join(f"{n}: {c * 10 / 60:.0f} min" for n, c in sorted(counts.items(), reverse=True) if n)
            print(f"review containers sampled every 10 s: peak {max(counts)} — time at each count: {mins}")
    print(f"lenses whose final attempt failed: {len(errors)}")
    for e in errors:
        print(f"  {e[0]} {e[1]}: {e[2]} {e[3] or ''}")


if __name__ == "__main__":
    main()
