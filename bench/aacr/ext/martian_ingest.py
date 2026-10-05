#!/usr/bin/env python3
"""Martian step 1, for QuickReview: its review in the record Martian collects.

    python3 bench/aacr/ext/martian_ingest.py --run RUN_DIR --set SET.json \
        --published benchmark_data.json --out WORK/results/benchmark_data.json \
        [--rejudge qodo-extended-v2,cubic-v2,claude-code] [--arm qcr|pragent|opencode|…]

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

--arm names a third-party bench arm (PR-Agent, OpenCode, …; the run's
<run>.arm.json says which): its review is the one the AACR defect judge reads
for that arm — the located findings of `results/all/<id>.json` (`review.comments`,
the harness's OCR-shaped view every arm writes) as inline comments, then the
case's `review.md` (PR-Agent's own /review comment plus its unlocated
suggestions) as one body item when the arm wrote one. The same 30-item page
applies; a case whose summary is not `ok` posted nothing. The tool is recorded
under the arm's own name (ARM_TOOLS), beside the published tools.

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
# The tool name a bench arm's review is scored under (none collides with a
# published Martian tool: its "qodo" rows are Qodo's commercial reviewer).
ARM_TOOLS = {"qcr": TOOL, "pragent": "pr-agent", "opencode": "opencode", "codex": "codex-cli",
             "ocr": "open-code-review", "pireview": "pi-review", "claude": "claude-code-bench"}


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


def arm_comments(run: Path, instance_id: str) -> tuple[list[dict], dict]:
    """A third-party arm's review, as the defect judge reads it (module doc)."""
    case_dir = run / "cases" / instance_id
    summary_raw = read_nofollow(case_dir / "case-summary.json")
    summary = json.loads(summary_raw) if summary_raw else {}
    status = summary.get("status")
    result_raw = read_nofollow(run / "results" / "all" / f"{instance_id}.json")
    if status != "ok" or result_raw is None:
        return [], {"status": status or "missing", "inline_total": 0, "inline_kept": 0, "body": False}
    result = json.loads(result_raw)
    when = result.get("started_at") or ""
    inline = [c for c in ((result.get("review") or {}).get("comments") or [])
              if isinstance(c, dict) and str(c.get("content") or "").strip()]
    items = [
        {"path": c.get("path"), "line": c.get("end_line") or c.get("start_line"),
         "body": str(c["content"]).strip(), "created_at": when}
        for c in inline[:GITHUB_PAGE]
    ]
    body = (read_nofollow(case_dir / "review.md") or "").strip()
    if body:
        items.append({"path": None, "line": None, "body": body, "created_at": when})
    return items, {"status": status, "inline_total": len(inline), "inline_kept": min(len(inline), GITHUB_PAGE),
                   "body": bool(body)}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--run", required=True, type=Path, help="the QuickReview run dir (cases/<id>/)")
    ap.add_argument("--set", required=True, type=Path)
    ap.add_argument("--published", required=True, type=Path, help="Martian's committed benchmark_data.json")
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--rejudge", default="")
    ap.add_argument("--arm", default="qcr", choices=sorted(ARM_TOOLS),
                    help="the bench arm that reviewed (qcr = QuickReview's own case files)")
    ap.add_argument("--no-quickreview", action="store_true", help="re-judged tools only (calibration)")
    args = ap.parse_args()

    published = json.loads(args.published.read_text())
    cases = json.loads(args.set.read_text())["cases"]
    rejudge = [t for t in args.rejudge.split(",") if t]
    tool = ARM_TOOLS[args.arm]
    read = quickreview_comments if args.arm == "qcr" else (lambda d: arm_comments(args.run, d.name))
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
            items, info = read(args.run / "cases" / c["instance_id"])
            entry["reviews"].append({
                "tool": tool,
                "repo_name": c["instance_id"],
                "pr_url": f"{c['pr_url']} ({tool}, bench run {args.run.name}; not posted)",
                "review_comments": items,
            })
            report.append({"pr": url, "instance_id": c["instance_id"], **info, "items": len(items)})
        for other in rejudge:
            src = [r for r in pub["reviews"] if r["tool"] == other]
            if len(src) != 1:
                sys.exit(f"{url}: {len(src)} published reviews by {other}")
            entry["reviews"].append({**src[0], "tool": f"rejudged-{other}"})
        out[url] = entry
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, indent=2) + "\n")
    (args.out.parent / "ingest-report.json").write_text(json.dumps(report, indent=1) + "\n")
    for r in report:
        print(f"{r['instance_id']}: {r['status']}, {r['inline_kept']}/{r['inline_total']} inline"
              f"{' + review body' if r['body'] else ''}")
    print(f"wrote {args.out}: {len(out)} PRs, tools {[tool] * (not args.no_quickreview) + [f'rejudged-{t}' for t in rejudge]}")


if __name__ == "__main__":
    main()
