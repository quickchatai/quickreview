#!/usr/bin/env python3
"""GitHub Copilot's 2025 reviews of AACR-Bench PRs, as harvested, recounted from the run archive.

    python3 bench/aacr/recompute/copilot_harvest.py --archive <release>/archive --data <hf-dataset> \\
        [--work <scratch>] [--json OUT]

(`uv run --no-project --with pyarrow python ...` for the HF tables.)

benchmark.tex §"Copilot 2025, harvested". bench/aacr/harvest_upstream.py wrote, for each PR Copilot had
reviewed, `runs/upstream-copilot2025-<set>/cases/<id>/case-summary.json`: whether the review was of
AACR's head commit (`reviewed_aacr_head`), the findings by source (inline comments, the collapsed
low-confidence block) and, for a finding from an earlier push, how its line was carried to the head
(`mapping`: `at-head`; `identical-file` or `identical-context`, the line kept; `dropped-line`, scored by
its path only). Counts: PRs, PRs reviewed at the head and at an earlier push, findings by source, and
the earlier-push findings whose line was kept or dropped. No model call.
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

PREFIX = "upstream-copilot2025-"
KEPT = ("identical-file", "identical-context")


def compute(root: Path) -> dict:
    files = sorted(glob.glob(str(root / "runs" / f"{PREFIX}*" / "cases" / "*" / "case-summary.json")))
    if not files:
        raise SystemExit(f"no {PREFIX}* case summaries in the archive")
    head = collections.Counter()
    source = collections.Counter()
    mapping = collections.Counter()
    for f in files:
        d = read_json(Path(f))
        head["at_head" if d.get("reviewed_aacr_head") else "earlier_push"] += 1
        for k, v in (d.get("by_source") or {}).items():
            source[k] += v
        for x in d.get("findings") or []:
            mapping[x.get("mapping")] += 1
    earlier = sum(v for k, v in mapping.items() if k != "at-head")
    return {"prs": len(files), **dict(head), "inline": source["inline"], "low_confidence": source["body-low-confidence"],
            "findings": sum(source.values()), "earlier_push_lines": earlier,
            "earlier_push_kept": sum(mapping[k] for k in KEPT), "earlier_push_path_only": mapping["dropped-line"]}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--archive", required=True)
    ap.add_argument("--data", required=True)
    ap.add_argument("--work", default=os.path.join(os.environ.get("TMPDIR", "."), "copilot-harvest"))
    ap.add_argument("--json")
    a = ap.parse_args()
    runs = [r["unit"] for r in load_table(a.data, "runs") if r["unit"].startswith(PREFIX) and "." not in r["unit"]]
    root = open_archive(a.archive, a.work, volumes_for(load_table(a.data, "runs"), runs))
    res = compute(root)
    print(json.dumps(res, indent=1))
    if a.json:
        Path(a.json).write_text(json.dumps(res, indent=1) + "\n")


if __name__ == "__main__":
    main()
