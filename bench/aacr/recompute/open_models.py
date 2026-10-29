#!/usr/bin/env python3
"""The README's "Other models" rows, from the open-model run dirs alone.

    python3 bench/aacr/recompute/open_models.py --runs-dir <open-model runs> [--json OUT]

No model call. The arms are bench/aacr/final/arms-open-models.txt (NAME=run,run,...
over smoke10, dev10, holdout10, fresh10 and rest145: 185 PRs, 520 defects). Per arm,
compare.py's own scoring under the gpt-6.1-sol judge at high (judge/v<key>-gpt-6.1-sol-high/):
found at each severity (a partial find counts ½), PRs judged, mean list price per PR
(compare.py usd_and_minutes, pi's per-call price at DigitalOcean list rates), median
minutes. The same numbers as

    compare.py --runs-dir <open-model runs> --judge-model gpt-6.1-sol-high \\
        --cases smoke10+dev10+holdout10+fresh10+rest145 "$(sed -n 1p final/arms-open-models.txt)" ...

Then what the README says about how the runs were made, read from each case's own
`case-summary.json`:
  - effort: a case whose run fingerprint sets `effort.effort` to `low` ran at low
    reasoning effort; any other ran at the image's tiers (high and medium).
    The DeepSeek arm is a MIX. Its full run started at the default tiers, and
    DigitalOcean blocked the account part-way: on AACR only smoke10, dev10 and 22 of
    rest145 (42 PRs) were reviewed ok. The owner then ran the remaining PRs at low
    effort (`dsv41f-low-<set>-low`, sets of the PRs not yet reviewed ok). openmodels'
    low-dsv41f.sh merged both into `dsv41f-mix-<set>`. A case reviewed ok at the
    default tiers is kept. Every other case comes from the low run; when a case is in
    both, the low copy wins. smoke10 and dev10 are scored from `dsv41f-full-*` itself,
    since all 20 of their PRs finished at the default tiers. Hence "mostly low effort":
    143 of its 185 AACR PRs.
  - passes missing, as openmodels/gate.py fails a PR for them, split by kind: a planned
    pass whose transcript shows no run or a failed final attempt (openmodels/lensfinal.py)
    is LOST — a lens pass, or only the validator; a planned lens pass whose transcript
    shows a successful run but which the session's `executed_passes` lacks is
    UNRECORDED (gate.py's "missing passes" with no "lenses lost").
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
from collections import Counter
from pathlib import Path
from typing import Dict, List, Tuple

HERE = os.path.dirname(os.path.abspath(__file__))
AACR = os.path.dirname(HERE)
sys.path.insert(0, AACR)
sys.path.insert(0, os.path.join(AACR, "openmodels"))
import compare as C  # noqa: E402
from lensfinal import lens as lens_name, lost as lost_lenses  # noqa: E402

ARMS_FILE = os.path.join(AACR, "final", "arms-open-models.txt")
CASES = "smoke10+dev10+holdout10+fresh10+rest145"
JUDGE = "gpt-6.1-sol-high"
VALIDATOR = "pass-validate"


def read_arms(path: str) -> List[Tuple[str, List[str]]]:
    out = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line and "=" in line and not line.startswith("#"):
                name, runs = line.split("=", 1)
                out.append((name, runs.split(",")))
    return out


def arm_row(runs_dir: str, runs: List[str], cases: dict, judge: str = JUDGE) -> dict:
    """compare.score's numbers, structured: per PR the first run with a usable judgement is scored."""
    found, total = Counter(), Counter()
    usd, mins, judged, scored_in = [], [], 0, {}
    for iid, (_, sevs, version) in cases.items():
        for s in sevs.values():
            total[s] += 1
        for run in runs:
            j = C.judgement(runs_dir, run, iid, version, judge)
            if j is None:
                continue
            judged += 1
            scored_in[iid] = run
            v = {d["id"]: d["verdict"] for d in j["defects"]}
            for did, s in sevs.items():
                found[s] += {"found": 1, "partial": 0.5}.get(v.get(did, "missed"), 0)
            u, m = C.usd_and_minutes(os.path.join(runs_dir, run, "cases", iid))
            if u is not None:
                usd.append(u)
            if m:
                mins.append(m)
            break
    return {"found": {s: found[s] for s in ("high", "medium", "low")}, "total": {s: total[s] for s in ("high", "medium", "low")},
            "all": sum(found.values()), "defects": sum(total.values()), "judged": judged, "prs": len(cases),
            "usd_per_pr": statistics.mean(usd) if usd and len(usd) == judged else None,
            "median_min": statistics.median(mins) if mins else None, "scored_in": scored_in}


def effort(case_dir: Path) -> str:
    fp = (json.loads((case_dir / "case-summary.json").read_text()).get("fingerprint") or {})
    return "low" if (fp.get("effort") or {}).get("effort") == "low" else "default"


def composition(runs_dir: str, scored_in: Dict[str, str]) -> dict:
    """effort -> PR count over the cases actually scored; and per run."""
    total, per_run = Counter(), {}
    for iid, run in scored_in.items():
        e = effort(Path(runs_dir) / run / "cases" / iid)
        total[e] += 1
        per_run.setdefault(run, Counter())[e] += 1
    return {"total": dict(total), "per_run": {r: dict(c) for r, c in sorted(per_run.items())}}


def missing_passes(case_dir: Path) -> Dict[str, List[str]]:
    """gate.py's two checks, apart: `lost` — planned passes whose transcript shows no run or a
    failed final attempt (lensfinal.py); `unrecorded` — planned passes the session's
    `executed_passes` lacks although their transcript shows a successful final attempt."""
    d = json.loads((case_dir / "case-summary.json").read_text())
    planned = d.get("planned_lenses") or []
    ran = {lens_name(p) for p in d.get("executed_passes") or []}
    lost = sorted({lens_name(p) for p, _ in lost_lenses(planned, case_dir / "pi-events.jsonl")})
    unrecorded = sorted({lens_name(p) for p in planned if lens_name(p) not in ran} - set(lost))
    return {"lost": lost, "unrecorded": unrecorded}


def degraded(runs_dir: str, scored_in: Dict[str, str]) -> dict:
    """The PRs gate.py fails for a pass, by kind: a lens pass lost, only the validator lost, or a
    lens pass that ran but is missing from the session's executed passes (gate.py's 'missing
    passes' with no 'lenses lost')."""
    cases = {}
    for iid, run in sorted(scored_in.items()):
        m = missing_passes(Path(runs_dir) / run / "cases" / iid)
        if m["lost"] or m["unrecorded"]:
            cases[iid] = m

    def lens(xs):
        return [x for x in xs if not x.startswith(VALIDATOR + "--")]
    return {"prs": len(cases),
            "lens_lost": sorted(i for i, m in cases.items() if lens(m["lost"])),
            "validator_only_lost": sorted(i for i, m in cases.items() if m["lost"] and not lens(m["lost"])),
            "lens_unrecorded_only": sorted(i for i, m in cases.items() if not m["lost"] and lens(m["unrecorded"])),
            "cases": cases}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--runs-dir", required=True, help="the open-model runs/ dir")
    ap.add_argument("--arms-file", default=ARMS_FILE)
    ap.add_argument("--cases", default=CASES)
    ap.add_argument("--judge-model", default=JUDGE)
    ap.add_argument("--json", help="also write every number to this JSON file")
    a = ap.parse_args()
    cases = C.cases_for(a.cases)
    res = {}
    print(f"{len(cases)} PRs, {sum(len(v[1]) for v in cases.values())} defects; judge {a.judge_model}\n")
    print("| QuickReview on | PRs judged | High | Medium | Low | All | $/PR | Median min |")
    print("|---|---|---|---|---|---|---|---|")
    for name, runs in read_arms(a.arms_file):
        r = arm_row(a.runs_dir, runs, cases, a.judge_model)
        r["effort"] = composition(a.runs_dir, r["scored_in"])
        r["degraded"] = degraded(a.runs_dir, r["scored_in"])
        res[name] = {k: v for k, v in r.items() if k != "scored_in"}
        cell = lambda s: f"{r['found'][s]:g}/{r['total'][s]} ({100 * r['found'][s] / r['total'][s]:.0f}%)"  # noqa: E731
        money = "unknown" if r["usd_per_pr"] is None else f"{r['usd_per_pr']:.2f}"
        mins = "unknown" if r["median_min"] is None else f"{r['median_min']:.1f}"
        print(f"| {name} | {r['judged']}/{r['prs']} | {cell('high')} | {cell('medium')} | {cell('low')} | "
              f"{r['all']:g}/{r['defects']} ({100 * r['all'] / r['defects']:.0f}%) | {money} | {mins} |")
    for name, r in res.items():
        e = r["effort"]
        print(f"\n{name}: effort over the scored PRs {e['total']}")
        for run, c in e["per_run"].items():
            print(f"  {run}: {c}")
        d = r["degraded"]
        print(f"  PRs the gate fails for a pass: {d['prs']} — a lens pass ran but is missing from the session's "
              f"executed passes on {len(d['lens_unrecorded_only'])}, a lens pass lost on {len(d['lens_lost'])}, "
              f"only the validator lost on {len(d['validator_only_lost'])}")
        for iid, m in d["cases"].items():
            print(f"    {iid}: " + "; ".join(f"{k} {', '.join(v)}" for k, v in m.items() if v))
    if a.json:
        with open(a.json, "w") as f:
            json.dump(res, f, indent=1)


if __name__ == "__main__":
    main()
