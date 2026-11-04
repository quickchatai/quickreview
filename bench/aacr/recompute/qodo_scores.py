#!/usr/bin/env python3
"""Score another judge's Qodo PR-Review-Bench matches on the published reviews, beside ours.

    python3 bench/aacr/recompute/qodo_scores.py --data <hf-dataset> --verdicts DIR --judge LABEL
        [--runs WORK|TOOL,...] [--gain WORK|TOOL,WORK|TOOL] [--json OUT]
    python3 bench/aacr/recompute/qodo_scores.py --data <hf-dataset> --judge LABEL
        --from-judgements <work dir>/judgements.jsonl --work WORK [--tool [WORK|]FROM=TO ...] [--save DIR] [...]

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

--from-judgements reads our own judge's output instead, `judgements.jsonl` of a
work dir `bench/aacr/ext/qodo_judge.py` wrote (`ext.sh qodo`, with
EXT_JUDGE_MODEL for another model), and maps it to that table
(judgements_rows): per PR and tool the first-pass row the judge's own scoring
reads (qodo_judge.effective), one verdict per issue of the PR in `qodo_issues`,
`matched` when a row of its `matches` names the issue and `comment_index` that
row's `comment`. Every row gets `--work` as its `work_dir` (give both flags
once per work dir, in the same order, to score several, such as the two
builds of the held-out gain), and `--tool [WORK|]FROM=TO` renames a tool to
the table's name, under one work dir or every one (the frozen build's
`quickreview` is `quickreview-frozen` under `final1-qodo-pr100`,
`quickreview-2026-10-02` under `ext-r6-qodo-pr100`). A judgement whose comments are not the published
review's (by path and lines, in order) is refused: its comment indices would
point at other comments. `--save DIR` also writes the mapped table there, the
`--verdicts` input heldout.py takes.

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

When your judge judged only some of a run's PRs (a sample), both columns,
the held-out PRs and the gain are counted over the PRs your judge judged
(its issues, its comments), and the header says how many; --whole-run keeps
every PR of the run, where a PR your judge did not judge has no hit (so its
numbers are not comparable with ours).
"""
from __future__ import annotations

import argparse
import copy
import json
import os
import shutil
import sys
import tempfile
from typing import Dict, List, Optional, Sequence, Tuple

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "ext"))
import claim_metrics as cm  # noqa: E402
import heldout as H  # noqa: E402
from qodo_judge import effective, located  # noqa: E402
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


def judgements_rows(data: str, path: str, work: str, tools: Dict[str, str]) -> List[dict]:
    """qodo_judge.py's judgements.jsonl as `qodo_verdicts` rows (the module docstring)."""
    issues: Dict[str, int] = {}
    for i in load_table(data, "qodo_issues"):
        issues[i["pr_url"]] = max(issues.get(i["pr_url"], 0), i["issue_index"] + 1)
    reviews = {(r["work_dir"], r["tool"], r["pr_url"]): r["comments"] or [] for r in load_table(data, "qodo_reviews")}
    with open(path) as f:
        got = effective(f)
    shipped: Dict[str, set] = {}
    for w, t, _ in reviews:
        shipped.setdefault(w, set()).add(t)
    out, skipped = [], 0
    for j in sorted(got, key=lambda x: (x["pr"], x["tool"])):
        url, tool = j["pr"], tools.get(j["tool"], j["tool"])
        if url not in issues:
            skipped += 1  # a PR the benchmark's answer key does not hold (the export skips it too)
            continue
        if work in shipped and tool not in shipped[work]:
            raise SystemExit(f"{path}: the release ships {work}'s reviews under {sorted(shipped[work])}, not "
                             f"{tool!r}: name it with --tool '{work}|{j['tool']}=<one of those>'")
        pub = reviews.get((work, tool, url))
        mine = [(c.get("path"), c.get("start"), c.get("end")) for c in j.get("comments") or []]
        if pub is not None and mine != [(c.get("path"), c.get("start"), c.get("end")) for c in pub]:
            raise SystemExit(f"{path}: the judgement of {work}|{tool} {url} is of other comments than the published "
                             f"review's ({len(mine)} against {len(pub)}): its comment indices would point elsewhere")
        by_issue = {m["issue"]: m for m in j.get("matches") or []}
        for i in range(issues[url]):
            m = by_issue.get(i)
            out.append({"work_dir": work, "tool": tool, "pr_url": url, "issue_index": i,
                        "matched": m is not None, "comment_index": m["comment"] if m else None})
    if skipped:
        print(f"{path}: {skipped} judgement(s) of PRs not in qodo_issues skipped", file=sys.stderr)
    return out


def on_prs(t: cm.Tables, urls: set) -> cm.Tables:
    """The tables with the Qodo issues, reviews and verdicts of `urls` alone."""
    view = copy.copy(t)
    view._t = dict(t._t)
    for name in ("qodo_issues", "qodo_reviews", "qodo_verdicts"):
        view._t[name] = [r for r in t(name) if r["pr_url"] in urls]
    return view


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
        head = f"{run}: {r['prs']} of its {r['run_prs']} PRs judged by {judge}"
        if r["sample"]:
            head += f"; both columns over those {r['prs']} PRs (--whole-run: every PR)"
        out += [head, f"| metric | {judge} | {OURS} |", "|---|---:|---:|"]
        out += [f"| {m} | {fmt(r[judge][m], m)} | {fmt(r[OURS][m], m)} |" for m in METRICS]
        for j in (judge, OURS):
            h = r["heldout"][j]
            out.append(f"held-out {res['heldout_set']} ({r['heldout_prs']} PRs), {j}: {h['hits']}/{h['issues']} "
                       f"recall {fmt(h['recall'], 'recall')}  precision {fmt(h['precision'], 'precision')}  "
                       f"F1 {fmt(h['f1'], 'f1')}")
        out.append("")
    if res.get("gain"):
        g = res["gain"]
        for j in (judge, OURS):
            d = g[j]
            out.append(f"held-out recall gain ({g['heldout_prs']} PRs), {g['x']} over {g['y']}, {j}: "
                       f"{d['diff']:+.1f} [{d['lo']:+.1f}, {d['hi']:+.1f}]")
    return "\n".join(out).rstrip()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", required=True, help="the Hugging Face dataset dir (or its data/ dir)")
    ap.add_argument("--verdicts", help="the dir holding your judge's qodo_verdicts")
    ap.add_argument("--from-judgements", action="append", default=[], metavar="JSONL",
                    help="instead of --verdicts: qodo_judge.py's judgements.jsonl, mapped to qodo_verdicts "
                         "(repeatable, each with its --work)")
    ap.add_argument("--work", action="append", default=[],
                    help="with --from-judgements: the work_dir its rows score (e.g. final1-qodo-pr100)")
    ap.add_argument("--tool", action="append", default=[], metavar="[WORK|]FROM=TO",
                    help="with --from-judgements: rename a tool to the table's name, under one work dir or all "
                         "(repeatable), e.g. final1-qodo-pr100|quickreview=quickreview-frozen")
    ap.add_argument("--save", help="with --from-judgements: also write the mapped qodo_verdicts.jsonl to this dir")
    ap.add_argument("--judge", required=True, help="your judge's label (one no published row carries)")
    ap.add_argument("--runs", help="WORK|TOOL, comma-separated (default: every run your judge judged)")
    ap.add_argument("--gain", help="X,Y (two WORK|TOOL runs): X's held-out recall gain over Y")
    ap.add_argument("--sets-dir", default=H.SETS)
    ap.add_argument("--resamples", type=int, default=H.AB.RESAMPLES)
    ap.add_argument("--whole-run", action="store_true",
                    help="count every PR of the run even when your judge judged only some (those have no hit)")
    ap.add_argument("--json", help="also write every number to this JSON file")
    a = ap.parse_args()
    if bool(a.verdicts) == bool(a.from_judgements):
        sys.exit("give your judge's answers once: --verdicts DIR or --from-judgements JSONL --work WORK")
    if a.from_judgements:
        if len(a.work) != len(a.from_judgements):
            sys.exit("give one --work (the work_dir its judgements score) per --from-judgements, in the same order")
        bad = [x for x in a.tool if "=" not in x]
        if bad:
            sys.exit(f"--tool wants [WORK|]FROM=TO, got {bad}")
        rename = [(x.split("=", 1)[0].rpartition("|"), x.split("=", 1)[1]) for x in a.tool]
        rows = []
        for path, work in zip(a.from_judgements, a.work):
            tools = {src: to for (w, _, src), to in rename if w in ("", work)}
            rows += judgements_rows(a.data, path, work, tools)
        a.verdicts = a.save or tempfile.mkdtemp(prefix="qodo-judgements-")
        os.makedirs(a.verdicts, exist_ok=True)
        with open(os.path.join(a.verdicts, "qodo_verdicts.jsonl"), "w") as f:
            f.writelines(json.dumps(r) + "\n" for r in rows)
    if not has_table(a.verdicts, "qodo_verdicts"):
        sys.exit(f"{a.verdicts}: no qodo_verdicts.parquet or .jsonl")
    t = cm.Tables(a.data)
    try:
        t._t["qodo_verdicts"] = verdict_rows(a.data, a.verdicts, a.judge)
    finally:
        if a.from_judgements and not a.save:
            shutil.rmtree(a.verdicts)
    have = sorted({f"{v['work_dir']}|{v['tool']}" for v in t("qodo_verdicts") if v["judge"] == a.judge})
    runs = [x for x in (a.runs.split(",") if a.runs else have) if x]
    missing = [x for x in runs if x not in have]
    if missing:
        sys.exit(f"no {a.judge} verdicts for run(s) {missing}")
    urls = H.set_urls(H.QODO_HELDOUT, a.sets_dir)
    # the PRs your judge judged: a run's sample both columns are counted over, unless it judged all its PRs
    mine = {run: {v["pr_url"] for v in t("qodo_verdicts") if f"{v['work_dir']}|{v['tool']}" == run
                  and v["judge"] == a.judge} for run in runs}
    whole = {run: {r["pr_url"] for r in t("qodo_reviews") if f"{r['work_dir']}|{r['tool']}" == run} for run in runs}
    scope = {run: mine[run] if not a.whole_run and not whole[run] <= mine[run] else None for run in runs}
    res: dict = {"judge": a.judge, "heldout_set": f"sets/{H.QODO_HELDOUT}.json", "heldout_prs": urls, "runs": {}}
    for run in runs:
        view = on_prs(t, scope[run]) if scope[run] is not None else t
        held = [u for u in urls if scope[run] is None or u in scope[run]]
        r: Dict[str, dict] = {"prs": len(mine[run]), "run_prs": len(whole[run]), "sample": scope[run] is not None,
                              "heldout_prs": len(held)}
        for j in (a.judge, OURS):
            try:
                r[j] = run_scores(view, run, j)
            except cm.KeyError_:
                r[j] = {m: None for m in METRICS}  # ours never judged this run: unknown
        r["heldout"] = {j: heldout(view, run, j, held) for j in (a.judge, OURS)}
        res["runs"][run] = r
    pair: Tuple[str, ...] = tuple(a.gain.split(",")) if a.gain else (BUILDS if all(b in runs for b in BUILDS) else ())
    if pair:
        if len(pair) != 2 or any(p not in runs for p in pair):
            sys.exit(f"--gain wants two of the scored runs {runs}, got {list(pair)}")
        both = set.intersection(*(scope[p] if scope[p] is not None else whole[p] for p in pair))
        sampled = any(scope[p] is not None for p in pair)
        view = on_prs(t, both) if sampled else t
        held = [u for u in urls if not sampled or u in both]
        res["gain"] = {"x": pair[0], "y": pair[1], "heldout_prs": len(held),
                       **{j: gain(view, pair[0], pair[1], j, held, a.resamples) for j in (a.judge, OURS)}}
    print(render(res, a.judge))
    if a.json:
        with open(a.json, "w") as f:
            json.dump(res, f, indent=1)


if __name__ == "__main__":
    main()
