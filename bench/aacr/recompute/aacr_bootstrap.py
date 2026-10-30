#!/usr/bin/env python3
"""AACR-Bench bootstrap intervals and paired differences, from the published tables.

    python3 bench/aacr/recompute/aacr_bootstrap.py --data <hf-dataset> [--arms a,b,...] [--seed N] [--json OUT]

(`uv run --no-project --with pyarrow python ...` when the tables are parquet.)

Recomputes, with no model call:
  - benchmark.tex / quickreview.tex Table tab:ci: per arm, recall, high-severity
    recall and weighted recall (high 3, medium 2, low 1) with a 95% interval,
    and list cost per defect found and per high-severity defect found;
  - every paired difference the papers and the README quote (the default over
    `low`, the panel, Claude Code ...; the frozen build over the panel and Codex
    CLI on high severity, on high + medium, and overall; README "+8.3 points
    [+1.9, +14.6] over the panel").

The method is the papers' (benchmark.tex, "Uncertainty"): 10,000 resamples of
the 185 PRs with replacement, drawn with `random.Random(20261001)` as
`rng.choice(ids)` once per PR over the PR ids SORTED, all resamples drawn before
any arm is scored (so every arm and every pair sees the same resamples: the
difference is paired). Per resample a recall is a ratio of sums — credit found
on the drawn PRs over the defects of the drawn PRs (a resample with no defect
of that kind divides by 1). The interval is the sorted values at index 250 and
9749. The earlier gpt-6-sol study's intervals (tab:ci-sol and its paired
differences) were drawn the same way with seed 20260928: `--seed 20260928`.
Credit is the published `defect_verdicts.credit` (found 1, partial ½) of
the primary judge, `gpt-6-sol-high`; a defect with no verdict row counts 0.

Inputs (configs of the Hugging Face dataset): `prs` (the 185 PR ids),
`defects` (severity), `defect_verdicts` (credit), `reviews` (cost_usd of the
judged review per PR, for the $ columns).
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sys
from collections import defaultdict
from typing import Dict, Iterable, List, Sequence, Tuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tables import load_table, percentile_ci  # noqa: E402

SEED = 20261001
RESAMPLES = 10_000
JUDGE = "gpt-6-sol-high"
WEIGHT = {"high": 3, "medium": 2, "low": 1}
# metric -> the severities it counts and whether it is weighted
METRICS = {
    "recall": (("high", "medium", "low"), False),
    "high": (("high",), False),
    "serious": (("high", "medium"), False),
    "weighted": (("high", "medium", "low"), True),
}
# The final comparison (bench/aacr/final/arms.txt, in the papers' row order) and the frozen build.
DEFAULT_ARMS = (
    "quickreview-frozen", "quickreview-default-g61", "quickreview-low-g61", "pireview-panel-high-g61",
    "claude-code-opus55", "ocr-high-g61", "codex-high-g61", "opencode-native-pr-g61", "pragent-g61",
)


def per_pr(prs: Sequence[str], defects: Iterable[dict], verdicts: Iterable[dict], arm: str,
           judge: str = JUDGE) -> Dict[str, Dict[str, Tuple[float, float]]]:
    """PR -> metric -> (found, of): the arm's credit and the key's size on that PR."""
    sev = {(d["instance_id"], d["defect_id"]): d["severity"] for d in defects}
    credit = {(v["instance_id"], v["defect_id"]): float(v["credit"] or 0)
              for v in verdicts if v["arm_id"] == arm and v["judge"] == judge}
    out = {i: {m: [0.0, 0.0] for m in METRICS} for i in prs}
    for (iid, did), s in sev.items():
        if iid not in out:
            continue
        c = credit.get((iid, did), 0.0)
        for m, (sevs, weighted) in METRICS.items():
            if s in sevs:
                w = WEIGHT[s] if weighted else 1
                out[iid][m][0] += w * c
                out[iid][m][1] += w
    return {i: {m: (v[0], v[1]) for m, v in ms.items()} for i, ms in out.items()}


def resamples(prs: Sequence[str], b: int = RESAMPLES, seed: int = SEED) -> List[List[str]]:
    ids = sorted(prs)
    rng = random.Random(seed)
    return [[rng.choice(ids) for _ in ids] for _ in range(b)]


def ratio(d: Dict[str, Dict[str, Tuple[float, float]]], ids: Iterable[str], m: str) -> float:
    ids = list(ids)
    return sum(d[i][m][0] for i in ids) / max(sum(d[i][m][1] for i in ids), 1)


def bootstrap(prs: Sequence[str], defects: List[dict], verdicts: List[dict], arms: Sequence[str],
              b: int = RESAMPLES, seed: int = SEED) -> dict:
    """{"intervals": arm -> metric -> {point, lo, hi}, "pairs": metric -> "x | y" -> {diff, lo, hi}}, in percent."""
    samples = resamples(prs, b, seed)
    per = {a: per_pr(prs, defects, verdicts, a) for a in arms}
    vals = {a: {m: [ratio(per[a], s, m) for s in samples] for m in METRICS} for a in arms}
    point = {a: {m: ratio(per[a], prs, m) for m in METRICS} for a in arms}
    out = {"resamples": b, "seed": seed, "prs": len(prs), "intervals": {}, "pairs": {m: {} for m in METRICS}}
    for a in arms:
        out["intervals"][a] = {}
        for m in METRICS:
            lo, hi = percentile_ci(vals[a][m])
            out["intervals"][a][m] = {"point": 100 * point[a][m], "lo": 100 * lo, "hi": 100 * hi}
    for m in METRICS:
        for x in arms:
            for y in arms:
                if x == y:
                    continue
                lo, hi = percentile_ci([p - q for p, q in zip(vals[x][m], vals[y][m])])
                out["pairs"][m][f"{x} | {y}"] = {"diff": 100 * (point[x][m] - point[y][m]),
                                                 "lo": 100 * lo, "hi": 100 * hi,
                                                 "excludes_zero": lo > 0 or hi < 0}
    return out


def costs(prs: Sequence[str], defects: List[dict], verdicts: List[dict], reviews: List[dict],
          arms: Sequence[str]) -> Dict[str, dict]:
    """Per arm: list cost of its judged reviews over the PRs, per PR, per defect found and per high found.
    None (unknown, never zero) when a judged review's cost is missing."""
    keep = set(prs)
    out = {}
    for a in arms:
        rows = [r for r in reviews if r["arm_id"] == a and r.get("judged") and r["instance_id"] in keep]
        if not rows or any(r.get("cost_usd") is None for r in rows):
            out[a] = None
            continue
        total = sum(r["cost_usd"] for r in rows)
        d = per_pr(prs, defects, verdicts, a)
        found = sum(v["recall"][0] for v in d.values())
        high = sum(v["high"][0] for v in d.values())
        out[a] = {"usd_total": total, "usd_per_pr": total / len(rows), "reviews": len(rows),
                  "usd_per_defect": total / found if found else None,
                  "usd_per_high_defect": total / high if high else None}
    return out


def render(res: dict, cost: Dict[str, dict], arms: Sequence[str]) -> str:
    iv = res["intervals"]
    lines = [f"AACR-Bench, {res['prs']} PRs, judge {JUDGE}; {res['resamples']:,} resamples, seed {res['seed']}.", "",
             "| Arm | Recall [95% CI] | High [95% CI] | High+medium [95% CI] | Weighted [95% CI] | $/defect | $/high |",
             "|---|---|---|---|---|---|---|"]
    for a in arms:
        c = cost.get(a) or {}
        cells = [f"{iv[a][m]['point']:.1f}% [{iv[a][m]['lo']:.1f}, {iv[a][m]['hi']:.1f}]"
                 for m in ("recall", "high", "serious", "weighted")]
        money = [f"{c[k]:.2f}" if c.get(k) is not None else "unknown" for k in ("usd_per_defect", "usd_per_high_defect")]
        lines.append(f"| {a} | " + " | ".join(cells + money) + " |")
    for m in ("recall", "high", "serious"):
        lines += ["", f"Paired differences, {m} (row - column, points; * = interval excludes zero):", ""]
        for x in arms:
            for y in arms:
                if x != y and arms.index(x) < arms.index(y):
                    p = res["pairs"][m][f"{x} | {y}"]
                    lines.append(f"  {x} - {y}: {p['diff']:+.1f} [{p['lo']:+.1f}, {p['hi']:+.1f}]"
                                 f"{' *' if p['excludes_zero'] else ''}")
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", required=True, help="the Hugging Face dataset dir (or its data/ dir)")
    ap.add_argument("--arms", default=",".join(DEFAULT_ARMS), help="arm ids, comma-separated, in row order")
    ap.add_argument("--resamples", type=int, default=RESAMPLES)
    ap.add_argument("--seed", type=int, default=SEED, help="the resampling seed (the earlier study's: 20260928)")
    ap.add_argument("--json", help="also write every number to this JSON file")
    a = ap.parse_args()
    arms = [x for x in a.arms.split(",") if x]
    prs = sorted(r["instance_id"] for r in load_table(a.data, "prs"))
    defects = load_table(a.data, "defects")
    verdicts = load_table(a.data, "defect_verdicts")
    known = {v["arm_id"] for v in verdicts if v["judge"] == JUDGE}
    missing = [x for x in arms if x not in known]
    if missing:
        sys.exit(f"no {JUDGE} verdicts for arm(s) {missing}")
    res = bootstrap(prs, defects, verdicts, arms, b=a.resamples, seed=a.seed)
    res["costs"] = costs(prs, defects, verdicts, load_table(a.data, "reviews"), arms)
    print(render(res, res["costs"], arms))
    if a.json:
        with open(a.json, "w") as f:
            json.dump(res, f, indent=1)


if __name__ == "__main__":
    main()
