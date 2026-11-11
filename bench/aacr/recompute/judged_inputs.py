#!/usr/bin/env python3
"""What a judge was given where it differs from what was posted, and how far one judge agrees with itself.

    python3 bench/aacr/recompute/judged_inputs.py --archive <release>/archive --data <hf-dataset> \\
        [--work <scratch>] [--json OUT]

(`uv run --no-project --with pyarrow python ...` for the HF tables.)

The dataset card's "Re-judge with your own judge" and docs/METHODOLOGY.md §6 disclose these, one
sentence each. Counts, no model call:

  aacr_double/<arm>    AACR: a deleted-line comment the review also lists re-anchored to the new side,
                       the same text (HF `reviews.comments`: `deleted_line`, `text`). The judge saw and
                       graded both copies.
  qodo_left/<run>      Qodo: the review's deleted-line comments (`cases/<id>/comments.json`, side LEFT)
                       and whether the judge was sent each one (`<run>.qodo/judgements.jsonl`, the
                       quickreview rows of pass 1, by body): `judged` (re-anchored to the new side,
                       the frozen build) or `left_out` (the 2026-10-02 build), and of those the ones
                       on a PR of the held-out set (`sets/qodo-heldout31.json`). Case dirs are named
                       by the replay head; `sets/qodo-pr100.json` maps them to the PR.
  martian_variants     Martian's posting-policy runs (`runs/*/VARIANT.json`): how many, and how many
                       also shorten each comment (`style` title or title+1, not full).
  sweprbench           SWE-PRBench eval100: PRs whose judged comments (the `.sweprbench` dir's
                       `quickreview-answers.json`) differ from the posted ones (`comments.json`), by
                       body, and how (`added`: the answer has a body the post does not; `dropped`: the
                       other way round).
  qodo_double_pass     Qodo's judge asked twice on ext-r6-qodo-smoke10 (every tool, both passes in its
                       `judgements.jsonl`): matches (comment, issue) in pass 1, in pass 2, in both, as
                       qodo_judge.py's own noise table counts them.
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
from archive import iter_jsonl, open_archive, read_json  # noqa: E402
from tables import load_table  # noqa: E402

SETS = Path(__file__).resolve().parent.parent / "sets"
QODO_RUNS = {"final1-qodo-pr100": "qodo-final", "ext-r6-qodo-pr100": "qodo-r6-and-vendors"}
DOUBLE_PASS = "ext-r6-qodo-smoke10"
SWEPR = "ext-r5-sweprbench-eval100"
VOLUMES = sorted(set(QODO_RUNS.values()) | {"martian-posting-variants", "sweprbench"})
SHORT_STYLES = ("title", "title+1")


def aacr_double(reviews) -> dict:
    out = collections.Counter()
    for r in reviews:
        cs = r.get("comments") or []
        for c in cs:
            if c.get("deleted_line") and any(d is not c and not d.get("deleted_line") and d.get("text") == c.get("text")
                                             for d in cs):
                out[r["arm_id"]] += 1
    return dict(out)


def qodo_left(root: Path, sets: Path) -> dict:
    pr_of = {c["instance_id"]: c["pr_url"] for c in read_json(sets / "qodo-pr100.json")["cases"]}
    held = {c["pr_url"] for c in read_json(sets / "qodo-heldout31.json")["cases"]}
    out = {}
    for run in QODO_RUNS:
        sent = {j["pr"]: {str(c.get("body") or "").strip() for c in j.get("comments") or []}
                for j in iter_jsonl(root / "runs" / f"{run}.qodo" / "judgements.jsonl")
                if j["tool"] == "quickreview" and j.get("pass", 1) == 1}
        n = collections.Counter()
        cases = sorted(glob.glob(str(root / "runs" / run / "cases" / "*" / "comments.json")))
        if not cases:
            raise SystemExit(f"no case comments for {run} in the archive")
        for f in cases:
            pr = pr_of.get(Path(f).parent.name)
            if pr not in sent:
                raise SystemExit(f"{run}: case {Path(f).parent.name} has no judged review")
            for c in read_json(Path(f)):
                if c.get("side") != "LEFT":
                    continue
                k = "judged" if str(c.get("body") or "").strip() in sent[pr] else "left_out"
                n["left"] += 1
                n[k] += 1
                n[k + "_heldout"] += pr in held
        out[run] = {k: n[k] for k in ("left", "judged", "judged_heldout", "left_out", "left_out_heldout")}
    return out


def martian_variants(root: Path) -> dict:
    files = sorted(glob.glob(str(root / "runs" / "*" / "VARIANT.json")))
    if not files:
        raise SystemExit("no posting-policy run (VARIANT.json) in the archive")
    styles = collections.Counter((read_json(Path(f)).get("policy") or {}).get("style") or "full" for f in files)
    return {"runs": len(files), "shortened": sum(styles[s] for s in SHORT_STYLES), "styles": dict(styles)}


def sweprbench(root: Path) -> dict:
    answers = read_json(root / "runs" / f"{SWEPR}.sweprbench" / "quickreview-answers.json")
    n = collections.Counter()
    for a in answers.values():
        posted = collections.Counter(c.get("body") for c in read_json(root / "runs" / SWEPR / "cases" / a["instance_id"] / "comments.json"))
        judged = collections.Counter(c.get("body") for c in a.get("comments") or [])
        n["prs"] += 1
        if posted != judged:
            n["judged_ne_posted"] += 1
            n["added"] += bool(judged - posted)
            n["dropped"] += bool(posted - judged)
    return {k: n[k] for k in ("prs", "judged_ne_posted", "added", "dropped")}


def double_pass(root: Path) -> dict:
    by = collections.defaultdict(dict)
    for j in iter_jsonl(root / "runs" / f"{DOUBLE_PASS}.qodo" / "judgements.jsonl"):
        by[(j["pr"], j["tool"])][j.get("pass", 1)] = {(m["comment"], m["issue"]) for m in j.get("matches") or []}
    n = collections.Counter()
    for passes in by.values():
        if 1 in passes and 2 in passes:  # only the doubled PRs, as qodo_judge.py's noise table
            n["pass1"] += len(passes[1])
            n["pass2"] += len(passes[2])
            n["both"] += len(passes[1] & passes[2])
            n["reviews"] += 1
    if not n["reviews"]:
        raise SystemExit(f"{DOUBLE_PASS}: no review judged twice")
    return {"run": DOUBLE_PASS, **{k: n[k] for k in ("reviews", "pass1", "pass2", "both")}}


def compute(root: Path, reviews, sets: Path = SETS) -> dict:
    return {"aacr_double": aacr_double(reviews), "qodo_left": qodo_left(root, sets),
            "martian_variants": martian_variants(root), "sweprbench": sweprbench(root),
            "qodo_double_pass": double_pass(root)}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--archive", required=True)
    ap.add_argument("--data", required=True)
    ap.add_argument("--work", default=os.path.join(os.environ.get("TMPDIR", "."), "judged-inputs"))
    ap.add_argument("--json")
    a = ap.parse_args()
    root = open_archive(a.archive, a.work, VOLUMES)
    res = compute(root, load_table(a.data, "reviews"))
    print(json.dumps(res, indent=1))
    if a.json:
        Path(a.json).write_text(json.dumps(res, indent=1) + "\n")


if __name__ == "__main__":
    main()
