#!/usr/bin/env python3
"""AACR-Bench's metric at a looser line gate, from the re-scored harness files in the run archive.

    python3 bench/aacr/recompute/line_gate.py --archive <release>/archive --data <hf-dataset> \\
        [--work <scratch>] [--json OUT]

(`uv run --no-project --with pyarrow python ...` for the parquet tables.)

benchmark.tex "The line-gate effect, measured". The harness pairs a review comment with a reference
only when it sits within k lines of it (k = 1 in the published evaluation), then asks its judge whether
the two say the same thing. The earlier gpt-6-sol study's seven reviewers were re-scored at k = 5 and
k = 999 (any line of the file), one judge round each; the archive's `analysis` volume holds those
files, `analysis/external-benchmarks-2026-10-02/wp-data/linek-runs/<run>/results/all-k5|all-k999/`,
beside each run's official k = 1 files, `runs/<run>/results/all/`. Per reviewer (the HF `arms` table's
runs, in order) a PR is scored from the first run whose official metrics files score it (the analysis
tree's wp-data/linek_plan.py). Per gate:
  found      references matched, summed over the PRs: per reference the share of the judge rounds
             that matched it (one round each, so 0 or 1; k = 1 is the official files' round 1);
  recall     found / the references of the 185 PRs (bench/aacr/references.json);
  precision  found / the review comments the harness scored (each run's results/all/<id>.json);
  f1;
and the shim logs' recorded judge calls of the re-scoring (`eval/judge-shim.log`, a line per call).
No model call.
"""
from __future__ import annotations

import argparse
import collections
import glob
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from archive import open_archive, read_json, volumes_for  # noqa: E402
from tables import load_table  # noqa: E402
import compare as C  # noqa: E402  (bench/aacr/compare.py: the reference list and its note key)

STUDY = ("quickreview-default-sol", "quickreview-low-sol", "ocr-medium-sol", "codex-medium-sol",
         "opencode-bridge-sol", "pireview-medium-sol", "claude-code-opus55")
LINEK = "analysis/external-benchmarks-2026-10-02/wp-data/linek-runs"
GATES = {"k1": "all", "k5": "all-k5", "k999": "all-k999"}


def metric_files(root: Path, run: str, sub: str):
    base = root / "runs" if sub == "all" else root / LINEK
    return [f for f in sorted(glob.glob(str(base / run / "results" / sub / "metrics_*_*.json"))) if "average" not in f]


def supplier(root: Path, runs):
    seen, out = set(), {}
    for run in runs:
        got = set()
        for f in metric_files(root, run, "all"):
            for inst in read_json(Path(f)).get("eval_res") or []:
                if inst["instance_id"] not in seen:
                    got.add(inst["instance_id"])
        if got:
            out[run] = sorted(got)
        seen |= got
    return out


def generated(root: Path, run: str, iid: str) -> int:
    f = root / "runs" / run / "results" / "all" / f"{iid}.json"
    rev = (read_json(f).get("review") if f.exists() else None) or {}
    return sum(1 for c in (rev.get("comments") if isinstance(rev, dict) else None) or [] if (c.get("content") or "").strip())


def score(root: Path, plan, gate: str, total: int) -> dict:
    sub = GATES[gate]
    found = 0.0
    gen = 0
    for run, iids in plan.items():
        fs = metric_files(root, run, sub)
        if gate == "k1":
            fs = [f for f in fs if f.endswith("round_1.json")][-1:]
        if not fs:
            raise SystemExit(f"no {sub} metrics files for {run}")
        votes = collections.defaultdict(list)
        keep = set(iids)
        for f in fs:
            for inst in read_json(Path(f)).get("eval_res") or []:
                if inst["instance_id"] in keep:
                    for c in inst.get("comments") or []:
                        votes[(inst["instance_id"], C.note_key(c["path"], c["from_line"], c["to_line"], c["note"]))].append(
                            1 if c.get("semantic_match") else 0)
        found += sum(sum(v) / len(v) for v in votes.values())
        gen += sum(generated(root, run, i) for i in iids)
    p, r = found / max(gen, 1), found / total
    return {"found": found, "recall": 100 * r, "precision": 100 * p, "f1": 100 * (2 * p * r / (p + r) if p + r else 0.0)}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--archive", required=True)
    ap.add_argument("--data", required=True)
    ap.add_argument("--work", default=os.path.join(os.environ.get("TMPDIR", "."), "line-gate"))
    ap.add_argument("--json")
    a = ap.parse_args()
    arms = {x["arm_id"]: list(x["runs"]) for x in load_table(a.data, "arms") if x["arm_id"] in STUDY}
    runs_rows = load_table(a.data, "runs")
    units = {r["unit"] for r in runs_rows}
    root = open_archive(a.archive, a.work, volumes_for(runs_rows, ["analysis"] + sorted(
        {run for rs in arms.values() for run in rs if run in units})))
    prs = [p["instance_id"] for p in load_table(a.data, "prs")]
    refs = C.ref_labels()
    total = sum(len(refs.get(i, {})) for i in prs)
    res = {"references": total, "arms": {}}
    for arm in STUDY:
        plan = supplier(root, arms[arm])
        res["arms"][arm] = {g: score(root, plan, g, total) for g in GATES}
        k1, k999 = res["arms"][arm]["k1"]["found"], res["arms"][arm]["k999"]["found"]
        res["arms"][arm]["gain_pct"] = 100 * (k999 / k1 - 1) if k1 else None
    for g in GATES:
        for m in ("recall", "f1"):
            vals = [res["arms"][x][g][m] for x in STUDY]
            res[f"{g}_{m}_min"], res[f"{g}_{m}_max"] = min(vals), max(vals)
    gains = [res["arms"][x]["gain_pct"] for x in STUDY]
    res["gain_min"], res["gain_max"] = min(gains), max(gains)
    res["shim_calls"] = sum(sum(1 for line in open(f, errors="replace") if line.startswith("judge:"))
                            for f in sorted(glob.glob(str(root / LINEK / "*" / "eval" / "judge-shim*.log"))))
    print(json.dumps(res, indent=1))
    if a.json:
        Path(a.json).write_text(json.dumps(res, indent=1) + "\n")


if __name__ == "__main__":
    main()
