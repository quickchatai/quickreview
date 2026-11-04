#!/usr/bin/env python3
"""The missed-defect analysis behind QuickReview's levers, recounted from its labels in the run archive.

    python3 bench/aacr/recompute/missed_defects.py --archive <release>/archive --data <hf-dataset> \\
        [--work <scratch>] [--json OUT]

quickreview.tex's appendix on tuning and its introduction ("48 real defects across 30 PRs"). The
analysis read every defect of smoke10, dev10 and holdout10 that the seven normal-effort development
runs found less than half the time, and labelled each: `miss_class` (never raised by any pass, raised
then killed, ...) and `root_cause` (attention, external-library knowledge, ...). The labels are the
archive's `analysis/2026-09-26-missed-defects/miss-G<n>.json`, one file per analyst group; this counts
the defects and each label. No model call.
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
from archive import open_archive, read_json, volumes_for  # noqa: E402
from tables import load_table  # noqa: E402

DIR = "analysis/2026-09-26-missed-defects"


def compute(root: Path) -> dict:
    rows = [x for f in sorted(glob.glob(str(root / DIR / "miss-G*.json"))) for x in read_json(Path(f))]
    if not rows:
        raise SystemExit(f"no miss-G*.json labels under {root / DIR}")
    keys = {r["key"] for r in rows}
    if len(keys) != len(rows):
        raise SystemExit("a defect is labelled twice across the analyst groups")
    return {"defects": len(rows), "prs": len({k.split("#")[0] for k in keys}),
            "miss_class": dict(collections.Counter(r["miss_class"] for r in rows)),
            "root_cause": dict(collections.Counter(r["root_cause"] for r in rows))}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--archive", required=True)
    ap.add_argument("--data", required=True)
    ap.add_argument("--work", default=os.path.join(os.environ.get("TMPDIR", "."), "missed-defects"))
    ap.add_argument("--json")
    a = ap.parse_args()
    root = open_archive(a.archive, a.work, volumes_for(load_table(a.data, "runs"), ["analysis"]))
    res = compute(root)
    print(json.dumps(res, indent=1))
    if a.json:
        Path(a.json).write_text(json.dumps(res, indent=1) + "\n")


if __name__ == "__main__":
    main()
