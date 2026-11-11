#!/usr/bin/env python3
"""Lens passes per PR of QuickReview's AACR arms, from the archive's case summaries.

    python3 bench/aacr/recompute/passes.py --archive <release>/archive --data <hf-dataset> \\
        [--work <scratch>] [--json OUT]

(`uv run --no-project --with pyarrow python ...` for the parquet tables.)

Each QuickReview case writes `runs/<run>/cases/<id>/case-summary.json` with the lenses the plan named
(`planned_lenses`, one entry per pass, `pass-<lens>--<tier>`) and the passes the round ran
(`executed_passes`, the validator included). For every judged review of an arm (the HF `reviews`
table names the run), this counts, per arm (the analysis tree's wp-data/passes.py):
  executed  mean, median, quartiles (statistics.quantiles, n=4), min and max passes per PR
  planned   mean planned passes per PR
  added     PRs whose executed passes differ in number from the planned ones (the session added passes)
  lens_share  per lens, the share of PRs (percent) on which it ran
and, between two arms on the same PRs, how many PRs have the same plan (the planned lenses with their
tiers stripped, as a multiset). No model call.
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import statistics
import sys
from pathlib import Path
from typing import Dict, List

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from archive import open_archive, read_json  # noqa: E402
from tables import load_table  # noqa: E402

ARMS = ("quickreview-default-sol", "quickreview-low-sol", "quickreview-default-g61", "quickreview-low-g61",
        "quickreview-frozen", "quickreview-luna", "quickreview-default-sol-rerun")
SAME_PLAN = (("quickreview-default-sol", "quickreview-default-g61"),)
ADDABLE = ("concurrency", "ask-human")  # never planned: only the session adds them, so a share of 0 is a measurement


def lens(p: str) -> str:
    return p.split("--")[0].removeprefix("pass-")


def summaries(root: Path, reviews: List[dict], arm: str) -> Dict[str, dict]:
    out = {}
    for r in reviews:
        if r["arm_id"] == arm and r["judged"]:
            f = root / "runs" / r["run"] / "cases" / r["instance_id"] / "case-summary.json"
            out[r["instance_id"]] = read_json(f)
    if not out:
        raise SystemExit(f"no judged reviews of arm {arm!r}")
    return out


def stats(summ: Dict[str, dict]) -> dict:
    ex = [len(d.get("executed_passes") or []) for d in summ.values()]
    pl = [len(d.get("planned_lenses") or []) for d in summ.values()]
    share = collections.Counter({k: 0 for k in ADDABLE})
    for d in summ.values():
        share.update({lens(x): 0 for x in d.get("planned_lenses") or []})
        share.update({lens(x) for x in d.get("executed_passes") or []})
    q = statistics.quantiles(ex, n=4)
    n = len(ex)
    return {"prs": n, "executed_mean": statistics.mean(ex), "executed_median": statistics.median(ex),
            "executed_q1": q[0], "executed_q3": q[2], "executed_min": min(ex), "executed_max": max(ex),
            "planned_mean": statistics.mean(pl), "added": sum(1 for d in summ.values()
                                                            if len(d.get("executed_passes") or []) != len(d.get("planned_lenses") or [])),
            "lens_share": {k: 100 * v / n for k, v in share.items()}}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--archive", required=True)
    ap.add_argument("--data", required=True)
    ap.add_argument("--work", default=os.path.join(os.environ.get("TMPDIR", "."), "passes"))
    ap.add_argument("--json")
    a = ap.parse_args()
    reviews = load_table(a.data, "reviews")
    runs = {r["unit"]: r for r in load_table(a.data, "runs")}
    vols = set()
    for r in reviews:
        if r["arm_id"] in ARMS and r["judged"]:
            vols.update(v.removeprefix("quickreview-runs-").removesuffix(".tar.zst")
                        for v in (runs.get(r["run"]) or {}).get("archive_volumes") or [])
    root = open_archive(a.archive, a.work, sorted(vols))
    summ = {arm: summaries(root, reviews, arm) for arm in ARMS}
    res = {arm: stats(s) for arm, s in summ.items()}
    res["same_plan"] = {}
    for x, y in SAME_PLAN:
        both = set(summ[x]) & set(summ[y])
        same = sum(1 for i in both if collections.Counter(map(lens, summ[x][i].get("planned_lenses") or []))
                   == collections.Counter(map(lens, summ[y][i].get("planned_lenses") or [])))
        res["same_plan"][f"{x} | {y}"] = {"prs": len(both), "same": same}
    print(json.dumps(res, indent=1))
    if a.json:
        Path(a.json).write_text(json.dumps(res, indent=1) + "\n")


if __name__ == "__main__":
    main()
