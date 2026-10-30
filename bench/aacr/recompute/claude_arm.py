#!/usr/bin/env python3
"""The Claude Code arm's harness facts, from its run files in the archive.

    python3 bench/aacr/recompute/claude_arm.py --archive <release>/archive --data <hf-dataset> \\
        [--work <scratch>] [--json OUT]

(`uv run --no-project --with pyarrow python ...` for the parquet tables.)

For every judged review of the arm `claude-code-opus55` (the HF `reviews` table names its run), reads
  runs/<run>/cases/<id>/claude-stdout.json   Claude Code's own result envelope: `permission_denials`
                                             lists the commands the harness's permission set denied;
  runs/<run>/results/all/<id>.json            `bench.claude_view.source` (where the review's comments
                                             came from: `prose`, parsed by src/bench/claudeprose.ts,
                                             or the findings tool) and `bench.claude_prose_parsed`
                                             (the parser's findings with a path and a line);
and every `claude: <id> ok — N finding(s)` line of the arm's runs' `<run>.review.log` (the harness's
count of structured findings per case). Counts: PRs with a denied command, logged cases and those
with 0 structured findings, reviews the parser read, its located findings (total, mean, median,
maximum, reviews with none), and the reviews that came back through the findings tool, with and
without findings. No model call.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import statistics
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from archive import open_archive, read_json  # noqa: E402
from tables import load_table  # noqa: E402

ARM = "claude-code-opus55"
LOGGED = re.compile(r"\bclaude: (\S+) \S+ — (\d+) finding\(s\)")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--archive", required=True)
    ap.add_argument("--data", required=True)
    ap.add_argument("--work", default=os.path.join(os.environ.get("TMPDIR", "."), "claude-arm"))
    ap.add_argument("--json")
    a = ap.parse_args()
    rows = [r for r in load_table(a.data, "reviews") if r["arm_id"] == ARM and r["judged"]]
    runs = {r["unit"]: r for r in load_table(a.data, "runs")}
    vols = sorted({v.removeprefix("quickreview-runs-").removesuffix(".tar.zst")
                   for r in rows for v in (runs.get(r["run"]) or {}).get("archive_volumes") or []})
    root = open_archive(a.archive, a.work, vols)
    denied = 0
    parsed = []
    tool = {"with_findings": 0, "empty": 0}
    for r in rows:
        case = root / "runs" / r["run"] / "cases" / r["instance_id"]
        out = read_json(case / "claude-stdout.json")
        denied += bool(out.get("permission_denials"))
        bench = read_json(root / "runs" / r["run"] / "results" / "all" / f"{r['instance_id']}.json").get("bench") or {}
        p = bench.get("claude_prose_parsed")
        if p is not None:
            parsed.append(p["findings"])
        else:
            n = (bench.get("claude_view") or {}).get("comments") or 0
            tool["with_findings" if n else "empty"] += 1
    logged = {}
    for run in sorted({r["run"] for r in rows}):
        f = root / "runs" / f"{run}.review.log"
        if f.exists():
            for m in LOGGED.finditer(f.read_text(errors="replace")):
                logged[m.group(1)] = int(m.group(2))
    res = {"reviews": len(rows), "denied_prs": denied,
           "logged_cases": len(logged), "logged_zero": sum(1 for v in logged.values() if v == 0),
           "parsed_reviews": len(parsed), "tool_reviews": len(rows) - len(parsed), "tool": tool,
           "parsed_findings": sum(parsed), "parsed_mean": statistics.mean(parsed), "parsed_median": statistics.median(parsed),
           "parsed_max": max(parsed), "parsed_none": sum(1 for x in parsed if x == 0)}
    print(json.dumps(res, indent=1))
    if a.json:
        Path(a.json).write_text(json.dumps(res, indent=1) + "\n")


if __name__ == "__main__":
    main()
