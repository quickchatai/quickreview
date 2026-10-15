#!/usr/bin/env python3
"""required-passes.py — the posting route's required-pass check.

    required-passes.py <state.db> <round-progress-dir> <pr> <round_no>

Prints one line and exits:
  0  "complete" or "unknown: <why>"  — posting may go on
  3  "missing: <lens> (...)"         — a required pass failed and never
                                       completed; post NOTHING
The shell mirror of src/requiredpasses.ts (`requiredPassGap`): the required
rows are the round's recorded plan rows marked `required` by the plan builder
(pass-baseline and the risk passes), the evidence is the session's live
round-progress snapshot. Only positive evidence blocks: an unreadable plan or
snapshot, or a snapshot of another round, is unknown and never blocks.
tests/required-passes.test.ts runs this against the TypeScript rule.
"""
import json
import os
import re
import sqlite3
import sys

TIER_SUFFIX = re.compile(r"--(?:terra-med|sol-med|sol-high)$")


def lens_for_agent(agent):
    return TIER_SUFFIX.sub("", agent)


def load_plan(db, pr, round_no):
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=5)
        try:
            row = con.execute(
                "SELECT pass_plan FROM rounds WHERE pr = ? AND round_no = ? ORDER BY id DESC LIMIT 1",
                (pr, round_no),
            ).fetchone()
        finally:
            con.close()
    except Exception:
        return None
    if not row or not row[0]:
        return None
    try:
        plan = json.loads(row[0])
    except Exception:
        return None
    return plan if isinstance(plan, list) else None


def load_progress(progress_dir, pr):
    try:
        with open(os.path.join(progress_dir, f"pr-{pr}.json")) as fh:
            value = json.load(fh)
    except Exception:
        return None
    if not isinstance(value, dict) or value.get("pr") != pr or not isinstance(value.get("agents"), list):
        return None
    return value


def gap(plan, progress, round_no):
    required = {}
    for row in plan or []:
        if isinstance(row, dict) and row.get("required") is True and isinstance(row.get("lens"), str):
            required[row["lens"]] = required.get(row["lens"], 0) + 1
    if not required:
        return ("complete", None)
    if progress is None:
        return ("unknown", "no readable round-progress snapshot")
    if progress.get("round_no") != round_no:
        return ("unknown", f"round-progress snapshot is for round {progress.get('round_no', '?')}, not {round_no}")
    missing = []
    for lens, rows in required.items():
        runs = [
            a for a in progress["agents"]
            if isinstance(a, dict) and isinstance(a.get("agent"), str) and lens_for_agent(a["agent"]) == lens
        ]
        completed = sum(1 for a in runs if a.get("status") == "completed")
        failed = [a for a in runs if a.get("status") == "failed"]
        if failed and completed < rows:
            errors = "; ".join(a.get("error") or "failed" for a in failed)
            missing.append(f"{lens} ({completed}/{rows} completed, {len(failed)} failed: {errors})")
    return ("missing", ", ".join(missing)) if missing else ("complete", None)


def main(argv):
    if len(argv) != 5 or not argv[3].isdigit() or not argv[4].isdigit():
        print("unknown: usage: required-passes.py <state.db> <round-progress-dir> <pr> <round_no>")
        return 0
    db, progress_dir, pr, round_no = argv[1], argv[2], int(argv[3]), int(argv[4])
    state, detail = gap(load_plan(db, pr, round_no), load_progress(progress_dir, pr), round_no)
    print(state if detail is None else f"{state}: {detail}")
    return 3 if state == "missing" else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
