#!/usr/bin/env python3
"""The plan file behind bench/aacr/rerun-all.sh — read, check and estimate.

A plan (bench/aacr/plans/<name>.json):

  {"name": "freeze-validation", "image": "qcr-bench:fv1", "prefix": "fv1",
   "config": "models.default=…",            # arm.sh --config, the same for every set
   "sets": [{"set": "qodo-rules30", "scorer": "qodo"},
            {"set": "dev10-rep5", "scorer": "aacr", "repeat_of": "dev10"}]}

scorer is aacr | martian | qodo | swepr. `repeat_of` marks a set whose cases are
reviewed a SECOND time in the same run (the run-to-run variance floor); its
cases must be a subset of the named set's, which must be in the plan too.

  rerun_plan.py check PLAN SETS_DIR            exit 1 with the reason on a bad plan
  rerun_plan.py field PLAN KEY                 one top-level field (name/image/prefix/config)
  rerun_plan.py sets PLAN                      "set scorer" per line
  rerun_plan.py show PLAN SETS_DIR RUNS_DIR    the plan, and its estimated cost and time

The estimate prices each case from the latest stored review of the same PR
(case-summary.json usage at gpt-6.1-sol rates and its duration) and falls back
to the mean of the PRs it found; the wall time assumes the adaptive slots
(arm.sh) average SLOTS reviews at once, plus SCORE_MIN per set for scoring.
"""
from __future__ import annotations

import glob
import json
import os
import sys

SCORERS = {"aacr", "martian", "qodo", "swepr"}
# $ per million tokens, gpt-6.1-sol (src/bench/cost.ts CODEX_USD_PER_MTOK).
RATE = {"input": 2.0, "cacheRead": 0.1, "output": 10.0}
SLOTS = 14
SCORE_MIN = 12


def load(plan: str) -> dict:
    with open(plan) as f:
        return json.load(f)


def set_cases(sets_dir: str, name: str) -> list[str]:
    with open(os.path.join(sets_dir, f"{name}.json")) as f:
        return [c["instance_id"] for c in json.load(f)["cases"]]


def check(p: dict, sets_dir: str) -> list[str]:
    errs = []
    for k in ("name", "image", "prefix", "config", "sets"):
        if not p.get(k):
            errs.append(f"missing {k}")
    names = [s.get("set") for s in p.get("sets", [])]
    if len(set(names)) != len(names):
        errs.append("a set is listed twice (use a repeat_of set for a second review)")
    for s in p.get("sets", []):
        n = s.get("set")
        if s.get("scorer") not in SCORERS:
            errs.append(f"{n}: scorer must be one of {sorted(SCORERS)}")
        if not os.path.exists(os.path.join(sets_dir, f"{n}.json")):
            errs.append(f"{n}: no set file")
            continue
        r = s.get("repeat_of")
        if r:
            if r not in names:
                errs.append(f"{n}: repeat_of {r}, which the plan does not review")
            elif os.path.exists(os.path.join(sets_dir, f"{r}.json")) and not set(set_cases(sets_dir, n)) <= set(set_cases(sets_dir, r)):
                errs.append(f"{n}: repeat_of {r}, but its cases are not a subset of {r}'s")
    return errs


def latest_case(runs_dir: str) -> dict:
    """instance id -> (usd, seconds) of its most recently finished stored review."""
    seen: dict[str, tuple[float, float, float]] = {}
    for f in glob.glob(os.path.join(runs_dir, "*", "cases", "*", "case-summary.json")):
        try:
            d = json.load(open(f))
            u = d["usage"]
            usd = sum(float(u.get(k, 0)) * r for k, r in RATE.items()) / 1e6
            t = os.path.getmtime(f)
            iid = d["instance_id"]
            if iid not in seen or t > seen[iid][2]:
                seen[iid] = (usd, float(d.get("duration_seconds") or 0), t)
        except (OSError, KeyError, ValueError, TypeError):
            continue
    return {k: (v[0], v[1]) for k, v in seen.items()}


def estimate(p: dict, sets_dir: str, runs_dir: str) -> dict:
    known = latest_case(runs_dir) if runs_dir else {}
    mean = (sum(v[0] for v in known.values()) / len(known), sum(v[1] for v in known.values()) / len(known)) if known else (2.0, 900.0)
    rows, usd, sec, n = [], 0.0, 0.0, 0
    for s in p["sets"]:
        ids = set_cases(sets_dir, s["set"])
        hit = [known[i] for i in ids if i in known]
        su = sum(h[0] for h in hit) + mean[0] * (len(ids) - len(hit))
        ss = sum(h[1] for h in hit) + mean[1] * (len(ids) - len(hit))
        rows.append((s["set"], s["scorer"], len(ids), len(hit), su))
        usd += su; sec += ss; n += len(ids)
    wall_min = sec / 60 / max(1, min(SLOTS, n)) + SCORE_MIN * len(p["sets"])
    return {"rows": rows, "usd": usd, "cases": n, "wall_min": wall_min}


def main() -> int:
    cmd, plan = sys.argv[1], sys.argv[2]
    p = load(plan)
    if cmd == "check":
        errs = check(p, sys.argv[3])
        for e in errs:
            print(f"rerun plan {plan}: {e}", file=sys.stderr)
        return 1 if errs else 0
    if cmd == "field":
        print(p[sys.argv[3]])
        return 0
    if cmd == "sets":
        for s in p["sets"]:
            print(s["set"], s["scorer"])
        return 0
    if cmd == "show":
        e = estimate(p, sys.argv[3], sys.argv[4] if len(sys.argv) > 4 else "")
        print(f"plan {p['name']}: image {p['image']}, run prefix {p['prefix']}")
        print("| set | scorer | PRs | priced from a stored review | est. $ |")
        print("|---|---|---|---|---|")
        for set_, scorer, n, hit, usd in e["rows"]:
            print(f"| {set_} | {scorer} | {n} | {hit} | {usd:.2f} |")
        print(f"total: {e['cases']} reviews, about ${e['usd']:.0f}, about {e['wall_min']:.0f} min "
              f"({SLOTS} reviews at once, {SCORE_MIN} min scoring per set)")
        return 0
    print(f"unknown command {cmd}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
