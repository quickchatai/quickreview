#!/usr/bin/env python3
"""QuickReview's review → SWE-PRBench's agent answer, and the replay table.

    python3 bench/aacr/ext/sweprbench_export.py --run RUN_DIR --set SET.json \
        --data DATASET_DIR --out WORK/replay-table.json

SWE-PRBench collects, from every model it evaluates, one JSON array per PR:
`[{"body": "...", "file": "path or null", "line": 42 or null,
"severity": "P0|P1|P2"}]` (eval_harness/runner.py AGENT_SYSTEM_PROMPT); its
parser keeps the first 30 (MAX_AGENT_COMMENTS).

QuickReview's review is what it would post: the inline comments and the
findings it places in the review body (it posts those there when they have no
valid inline anchor). Those are exactly the comments of the bench's scored
result file (results/all/<id>.json, the harness's own conversion — the same
file AACR-Bench scores). Order: by the P-level QuickReview stamped, most
severe first — P0, P1, P2, then P3 and unstamped together — keeping posting
order (inline first, then body findings) within a level, so the harness's
30-comment cap can only ever drop the least severe. A comment anchored on a
DELETED line (side LEFT: its line number is an OLD-file line, which SWE-PRBench
would read as a new-file line) goes out with its file and `line: null`, the
schema's "no specific line", instead of being dropped: the scored result file
excludes left-side comments, so they are read back from the case's
comments.json (2026-10-03: effect#5952's only finding sat on a deleted line, so
the PR scored as an empty review, a hard zero). Each becomes one array item:

  body      the comment text, verbatim
  file      its path
  line      its line
  severity  the P-level QuickReview stamped on it (`_P1 · …` / `(P1/…`):
            P0/P1/P2 as is; P3 (QuickReview's nit level, below SWE-PRBench's
            scale) and an unstamped comment → null, i.e. "unspecified"

A case that failed or timed out answers `[]` (no comments — SWE-PRBench
scores that a hard zero, as for a model that tried nothing).

The replay table maps sha256(context `rendered`) — the exact user message the
harness sends for that PR and config — to that PR's array, for all three
context configs (QuickReview reads the repository itself, so its answer does
not depend on which packed context the harness would have shown a model).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from pathlib import Path

CONFIGS = {
    "config_A": "config_A_diff_only",
    "config_B": "config_B_with_file_content",
    "config_C": "config_C_full_context",
}
SEV = re.compile(r"(?:_|\()P([0-3])(?=[ ·/])")


def read_nofollow(p: Path) -> str | None:
    try:
        fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError:
        return None
    with os.fdopen(fd, encoding="utf-8") as f:
        return f.read()


def severity(body: str) -> str | None:
    m = SEV.search(body)
    if not m or m.group(1) == "3":
        return None
    return f"P{m.group(1)}"


def agent_array(run: Path, instance_id: str) -> tuple[list[dict], str]:
    raw = read_nofollow(run / "results" / "all" / f"{instance_id}.json")
    if raw is None:
        return [], "no result file"
    res = json.loads(raw)
    status = (res.get("qcr") or {}).get("status") or "unknown"
    items = []
    for c in (res.get("review") or {}).get("comments") or []:
        body = str(c.get("content") or "").strip()
        if not body:
            continue
        items.append({"body": body, "file": c.get("path") or None,
                      "line": c.get("start_line"), "severity": severity(body)})
    # A run made after the bench re-anchors deleted-line comments already
    # carries them (head side of their hunk); an older run excluded them, so
    # they are read back here. Never both: skip a body already exported.
    seen = {i["body"] for i in items}
    items += [i for i in left_side_comments(run, instance_id) if i["body"] not in seen]
    return order_by_severity(items), status


def left_side_comments(run: Path, instance_id: str) -> list[dict]:
    """Comments posted on deleted lines, which the scored result file excludes."""
    raw = read_nofollow(run / "cases" / instance_id / "comments.json")
    if raw is None:
        return []
    out = []
    for c in json.loads(raw):
        body = str(c.get("body") or "").strip()
        if c.get("side") == "LEFT" and body:
            out.append({"body": body, "file": c.get("path") or None, "line": None, "severity": severity(body)})
    return out


def order_by_severity(items: list[dict]) -> list[dict]:
    """P0, P1, P2, then everything else (P3 / unstamped), stable within a level."""
    rank = {"P0": 0, "P1": 1, "P2": 2}
    return sorted(items, key=lambda i: rank.get(i["severity"] or "", 3))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--run", required=True, type=Path)
    ap.add_argument("--set", required=True, type=Path)
    ap.add_argument("--data", required=True, type=Path, help="the dataset dir (contains contexts/)")
    ap.add_argument("--out", required=True, type=Path)
    args = ap.parse_args()
    cases = json.loads(args.set.read_text())["cases"]
    entries: dict = {}
    answers: dict = {}
    for c in cases:
        tid = c["task_id"]
        items, status = agent_array(args.run, c["instance_id"])
        content = json.dumps(items, ensure_ascii=False)
        answers[tid] = {"instance_id": c["instance_id"], "status": status, "comments": items}
        for sub, full in CONFIGS.items():
            ctx = json.loads((args.data / "contexts" / sub / f"{tid}.json").read_text())
            key = hashlib.sha256(str(ctx.get("rendered") or "").encode("utf-8")).hexdigest()
            if key in entries:
                # Two configs of ONE PR can render the same context (nothing to
                # add beyond the diff); two PRs never may.
                if entries[key]["task_id"] != tid:
                    raise SystemExit(f"{tid}/{sub}: context collides with {entries[key]['task_id']}")
                entries[key]["config"] += f"+{full}"
                continue
            entries[key] = {"task_id": tid, "config": full, "content": content}
        print(f"{tid} ({c['instance_id']}): {status}, {len(items)} comments "
              f"({sum(1 for i in items if i['severity'])} with a P0-P2 severity)")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps({"source_run": args.run.name, "entries": entries}, indent=1,
                                   ensure_ascii=False) + "\n")
    (args.out.parent / "quickreview-answers.json").write_text(
        json.dumps(answers, indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {args.out}: {len(entries)} contexts for {len(cases)} PRs")


if __name__ == "__main__":
    main()
