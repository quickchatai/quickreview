#!/usr/bin/env python3
"""Score another judge's Qodo PR-Review-Bench matches on the published reviews, beside ours.

    python3 bench/aacr/recompute/qodo_scores.py --data <hf-dataset> --verdicts DIR --judge LABEL
        [--runs WORK|TOOL,...] [--gain WORK|TOOL,WORK|TOOL] [--json OUT]

(`uv run --no-project --with pyarrow python ...` when the tables are parquet.) No model call.

DIR holds your judge's answers as one table shaped like the published
`qodo_verdicts` (`qodo_verdicts.parquet` or `.jsonl`): per (work_dir, tool,
pr_url, issue_index) of the reviews you judged, `matched` and, for a match,
`comment_index` (the `index` of the comment in that review's
`qodo_reviews.comments`, which is exactly what our judge was sent). A `judge`
column is not needed: every row is labelled LABEL, a label no published row
carries. Matching is one to one (bench/aacr/ext/qodo_judge.py SYSTEM): a
comment credits at most one issue and an issue at most one comment, and the
script refuses a row that breaks it, names an issue or comment the PR does not
have, or a review the release does not ship.

The location rule is not the judge's: as qodo_judge.py does, a match is a hit
under the primary rule when the comment's file is the issue's and its lines
come within 5 of the issue's (`located()`), and under the sensitivities when
the file alone matches (_samefile) or with no location (_semantic). The script
computes `located_n5` and `located_same_file` from the comment itself (a value
you supply must agree). Then, per run, under your judge and under ours
(gpt-6.1-sol), claim_metrics.Qodo's numbers: hits, comments, comments per PR,
precision (hits / comments), recall (hits / the 580 issues), F1, recall on
functional issues and on rule violations, and the semantic-only precision,
recall and F1; and on the 31 held-out PRs (sets/qodo-heldout31.json, the
published set, never re-derived) heldout.py's precision, recall and F1. With
two runs in --gain (by default the two published builds,
final1-qodo-pr100|quickreview-frozen and ext-r6-qodo-pr100|quickreview-2026-10-02,
when both are scored) it adds the first's held-out recall gain over the
second with the papers' paired bootstrap.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Dict, List, Optional, Sequence, Tuple

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "ext"))
import claim_metrics as cm  # noqa: E402
import heldout as H  # noqa: E402
from qodo_judge import located  # noqa: E402
from tables import has_table, load_table, with_judge  # noqa: E402

OURS = H.QODO_JUDGE
BUILDS = ("final1-qodo-pr100|quickreview-frozen", "ext-r6-qodo-pr100|quickreview-2026-10-02")
METRICS = ("hits", "comments", "per_pr", "precision", "recall", "f1", "recall_functional", "recall_rule",
           "precision_semantic", "recall_semantic", "f1_semantic")
PCT = ("precision", "recall", "f1", "recall_functional", "recall_rule", "precision_semantic", "recall_semantic",
       "f1_semantic")


def verdict_rows(data: str, extra: str, judge: str) -> List[dict]:
    """The published qodo_verdicts plus your judge's, checked, with the location flags computed."""
    issues = {(i["pr_url"], i["issue_index"]): i for i in load_table(data, "qodo_issues")}
    reviews = {(r["work_dir"], r["tool"], r["pr_url"]): {c["index"]: c for c in (r["comments"] or [])}
               for r in load_table(data, "qodo_reviews")}
    rows = with_judge(load_table(data, "qodo_verdicts"), extra, "qodo_verdicts", judge)
    out, seen, used_c, used_i = [], set(), set(), set()
    runs = {k[:2] for k in reviews}
    for r in rows:
        if r["judge"] != judge:
            out.append(r)
            continue
        rk = (r.get("work_dir"), r.get("tool"), r.get("pr_url"))
        k = rk + (r.get("issue_index"),)
        if rk[:2] not in runs:
            continue  # a run whose reviews the release does not ship cannot be scored (nor is it)
        if rk not in reviews:
            raise SystemExit(f"a verdict for a review the release does not ship: {rk}")
        if (rk[2], k[3]) not in issues:
            raise SystemExit(f"a verdict for an issue the PR does not have: {k}")
        if k in seen:
            raise SystemExit(f"two verdicts for {k}")
        seen.add(k)
        row = dict(r, matched=bool(r.get("matched")))
        if row["matched"]:
            c = reviews[rk].get(r.get("comment_index"))
            if c is None:
                raise SystemExit(f"a match names comment {r.get('comment_index')!r}, which the review does not have: {k}")
            if rk + (c["index"],) in used_c:
                raise SystemExit(f"comment {c['index']} credits two issues (matching is one to one): {rk}")
            if k in used_i:
                raise SystemExit(f"issue credited twice: {k}")
            used_c.add(rk + (c["index"],))
            used_i.add(k)
            x = issues[(rk[2], k[3])]
            got = {"located_n5": located(c, x, 5), "located_same_file": located(c, x, float("inf"))}
        else:
            got = {"located_n5": False, "located_same_file": False}
        for f, v in got.items():
            if r.get(f) is not None and bool(r[f]) != v:
                raise SystemExit(f"{f} {r[f]} disagrees with the comment's location ({v}): {k}")
        out.append(dict(row, **got))
    return out


def run_scores(t: cm.Tables, run: str, judge: str) -> Dict[str, Optional[float]]:
    q = cm.Qodo(t)
    work, _, tool = run.partition("|")
    return {m: q.value(f"{work}|{tool}@{judge}:{m}") for m in METRICS}


def heldout(t: cm.Tables, run: str, judge: str, urls: Sequence[str]) -> dict:
    work, _, tool = run.partition("|")
    vs = [v for v in t("qodo_verdicts") if v["work_dir"] == work and v["tool"] == tool]
    rows = [r for r in t("qodo_reviews") if r["work_dir"] == work and r["tool"] == tool]
    return H.qodo_score(urls, tool, t("qodo_issues"), vs, rows, judge)


def gain(t: cm.Tables, x: str, y: str, judge: str, urls: Sequence[str], b: int) -> dict:
    """x's held-out recall minus y's: heldout.qodo_paired over the two runs' rows (each run its own tool)."""
    vs = []
    for run in (x, y):
        work, _, tool = run.partition("|")
        vs += [dict(v, tool=run) for v in t("qodo_verdicts") if v["work_dir"] == work and v["tool"] == tool]
    return H.qodo_paired(urls, x, y, t("qodo_issues"), vs, b=b, judge=judge)


def fmt(v: Optional[float], m: str) -> str:
    if v is None:
        return "unknown"
    if m in PCT:
        return f"{v:.1f}"
    return f"{v:.1f}" if m == "per_pr" else f"{v:g}"


def render(res: dict, judge: str) -> str:
    out = []
    for run, r in res["runs"].items():
        out += [f"{run}", f"| metric | {judge} | {OURS} |", "|---|---:|---:|"]
        out += [f"| {m} | {fmt(r[judge][m], m)} | {fmt(r[OURS][m], m)} |" for m in METRICS]
        for j in (judge, OURS):
            h = r["heldout"][j]
            out.append(f"held-out {res['heldout_set']} ({len(res['heldout_prs'])} PRs), {j}: {h['hits']}/{h['issues']} "
                       f"recall {fmt(h['recall'], 'recall')}  precision {fmt(h['precision'], 'precision')}  "
                       f"F1 {fmt(h['f1'], 'f1')}")
        out.append("")
    if res.get("gain"):
        g = res["gain"]
        for j in (judge, OURS):
            d = g[j]
            out.append(f"held-out recall gain, {g['x']} over {g['y']}, {j}: {d['diff']:+.1f} [{d['lo']:+.1f}, {d['hi']:+.1f}]")
    return "\n".join(out).rstrip()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", required=True, help="the Hugging Face dataset dir (or its data/ dir)")
    ap.add_argument("--verdicts", required=True, help="the dir holding your judge's qodo_verdicts")
    ap.add_argument("--judge", required=True, help="your judge's label (one no published row carries)")
    ap.add_argument("--runs", help="WORK|TOOL, comma-separated (default: every run your judge judged)")
    ap.add_argument("--gain", help="X,Y (two WORK|TOOL runs): X's held-out recall gain over Y")
    ap.add_argument("--sets-dir", default=H.SETS)
    ap.add_argument("--resamples", type=int, default=H.AB.RESAMPLES)
    ap.add_argument("--json", help="also write every number to this JSON file")
    a = ap.parse_args()
    if not has_table(a.verdicts, "qodo_verdicts"):
        sys.exit(f"{a.verdicts}: no qodo_verdicts.parquet or .jsonl")
    t = cm.Tables(a.data)
    t._t["qodo_verdicts"] = verdict_rows(a.data, a.verdicts, a.judge)
    have = sorted({f"{v['work_dir']}|{v['tool']}" for v in t("qodo_verdicts") if v["judge"] == a.judge})
    runs = [x for x in (a.runs.split(",") if a.runs else have) if x]
    missing = [x for x in runs if x not in have]
    if missing:
        sys.exit(f"no {a.judge} verdicts for run(s) {missing}")
    urls = H.set_urls(H.QODO_HELDOUT, a.sets_dir)
    res: dict = {"judge": a.judge, "heldout_set": f"sets/{H.QODO_HELDOUT}.json", "heldout_prs": urls, "runs": {}}
    for run in runs:
        r: Dict[str, dict] = {}
        for j in (a.judge, OURS):
            try:
                r[j] = run_scores(t, run, j)
            except cm.KeyError_:
                r[j] = {m: None for m in METRICS}  # ours never judged this run: unknown
        r["heldout"] = {j: heldout(t, run, j, urls) for j in (a.judge, OURS)}
        res["runs"][run] = r
    pair: Tuple[str, ...] = tuple(a.gain.split(",")) if a.gain else (BUILDS if all(b in runs for b in BUILDS) else ())
    if pair:
        if len(pair) != 2 or any(p not in runs for p in pair):
            sys.exit(f"--gain wants two of the scored runs {runs}, got {list(pair)}")
        res["gain"] = {"x": pair[0], "y": pair[1],
                       **{j: gain(t, pair[0], pair[1], j, urls, a.resamples) for j in (a.judge, OURS)}}
    print(render(res, a.judge))
    if a.json:
        with open(a.json, "w") as f:
            json.dump(res, f, indent=1)


if __name__ == "__main__":
    main()
