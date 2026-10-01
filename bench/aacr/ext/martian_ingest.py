#!/usr/bin/env python3
"""Martian step 1, for QuickReview: its review in the record Martian collects.

    python3 bench/aacr/ext/martian_ingest.py --run RUN_DIR --set SET.json \
        --published benchmark_data.json --out WORK/results/benchmark_data.json \
        [--rejudge qodo-extended-v2,cubic-v2,claude-code]

Martian's step1_download_prs.py builds, per golden PR, one review record per
tool from the tool's GitHub activity on its fork PR #1, through three `gh api`
calls WITHOUT pagination — so each endpoint returns GitHub's first page, at
most 30 items, in creation order:

  1. GET /pulls/1/comments  → inline comments  {path, line, body, created_at}
  2. GET /pulls/1/reviews   → each review BODY {path: None, line: None, ...}
  3. GET /issues/1/comments → top-level comments (QuickReview posts none)

QuickReview's production posting is ONE review: its body (review.md) and its
inline comments (comments.json, in the order posted). This writes exactly what
those three calls would have returned had it posted that review on the fork
PR: the first 30 inline comments, then the review body. A case that failed or
timed out posted nothing, so its record has no comments — every golden comment
of that PR counts as missed, as for a tool that stayed silent.

--rejudge copies the PUBLISHED review records of named tools (Martian's
committed results/benchmark_data.json) under new slugs `rejudged-<tool>`, so
the same judge scores them beside QuickReview. Their comments are copied
byte-for-byte; no tool is run.

Every other field of a record is the published one (golden comments, titles,
source file). Run-dir files are read without following symlinks (the run dir
was written by a review sandbox).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

GITHUB_PAGE = 30  # gh api without --paginate: GitHub's default per_page
TOOL = "quickreview"


def read_nofollow(p: Path) -> str | None:
    try:
        fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW)
    except (FileNotFoundError, OSError):
        return None
    with os.fdopen(fd, encoding="utf-8") as f:
        return f.read()


def quickreview_comments(case_dir: Path) -> tuple[list[dict], dict]:
    """The three endpoints' items for one case, and what was dropped."""
    outcome_raw = read_nofollow(case_dir / "outcome.json")
    summary_raw = read_nofollow(case_dir / "case-summary.json")
    summary = json.loads(summary_raw) if summary_raw else {}
    status = summary.get("status")
    if status != "ok" or outcome_raw is None:
        return [], {"status": status or "missing", "inline_total": 0, "inline_kept": 0, "body": False}
    outcome = json.loads(outcome_raw)
    when = outcome.get("finished_at") or ""
    inline = json.loads(read_nofollow(case_dir / "comments.json") or "[]")
    if not isinstance(inline, list):
        inline = []
    items = [
        {"path": c.get("path"), "line": c.get("line"), "body": c.get("body"), "created_at": when}
        for c in inline[:GITHUB_PAGE]
        if isinstance(c, dict) and c.get("body")
    ]
    body = (read_nofollow(case_dir / "review.md") or "").strip()
    if body:
        items.append({"path": None, "line": None, "body": body, "created_at": when})
    return items, {"status": status, "inline_total": len(inline), "inline_kept": min(len(inline), GITHUB_PAGE),
                   "body": bool(body), "verdict": outcome.get("verdict")}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--run", required=True, type=Path, help="the QuickReview run dir (cases/<id>/)")
    ap.add_argument("--set", required=True, type=Path)
    ap.add_argument("--published", required=True, type=Path, help="Martian's committed benchmark_data.json")
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--rejudge", default="")
    ap.add_argument("--no-quickreview", action="store_true", help="re-judged tools only (calibration)")
    args = ap.parse_args()

    published = json.loads(args.published.read_text())
    cases = json.loads(args.set.read_text())["cases"]
    rejudge = [t for t in args.rejudge.split(",") if t]
    out: dict = {}
    report = []
    for c in cases:
        url = c["pr_url"]
        if url not in published:
            sys.exit(f"{url}: not in the published benchmark data")
        pub = published[url]
        entry = {k: v for k, v in pub.items() if k != "reviews"}
        entry["reviews"] = []
        if not args.no_quickreview:
            items, info = quickreview_comments(args.run / "cases" / c["instance_id"])
            entry["reviews"].append({
                "tool": TOOL,
                "repo_name": c["instance_id"],
                "pr_url": f"{c['pr_url']} (QuickReview, bench run {args.run.name}; not posted)",
                "review_comments": items,
            })
            report.append({"pr": url, "instance_id": c["instance_id"], **info, "items": len(items)})
        for tool in rejudge:
            src = [r for r in pub["reviews"] if r["tool"] == tool]
            if len(src) != 1:
                sys.exit(f"{url}: {len(src)} published reviews by {tool}")
            entry["reviews"].append({**src[0], "tool": f"rejudged-{tool}"})
        out[url] = entry
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, indent=2) + "\n")
    (args.out.parent / "ingest-report.json").write_text(json.dumps(report, indent=1) + "\n")
    for r in report:
        print(f"{r['instance_id']}: {r['status']}, {r['inline_kept']}/{r['inline_total']} inline"
              f"{' + review body' if r['body'] else ''}")
    print(f"wrote {args.out}: {len(out)} PRs, tools {[TOOL] * (not args.no_quickreview) + [f'rejudged-{t}' for t in rejudge]}")


if __name__ == "__main__":
    main()
