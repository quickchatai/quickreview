#!/usr/bin/env python3
"""Martian's scores (Core, Strict, All) from per-golden verdicts: another judge's, beside ours.

    python3 bench/aacr/recompute/martian_scores.py --data <hf-dataset> [--verdicts DIR --judge LABEL]
        [--runs WORK|TOOL,...] [--half martian-test30|martian-tune20] [--json OUT]
    python3 bench/aacr/recompute/martian_scores.py --data <hf-dataset> --judge LABEL
        --from-evaluations <work>.martian/results/<model>/evaluations.json --work WORK
        [--tool [WORK|]FROM=TO ...] [--save DIR] [...]

(`uv run --no-project --with pyarrow python ...` when the tables are parquet.) No model call.

Martian's step 3 judges, per PR, which golden comments a tool's review matched
and which of the review's extracted candidates matched none (its false
positives); its scorer (analysis.score_profiles) then counts per profile, over
the goldens of the PRs reviewed: tp = matched goldens, fp = unmatched
candidates, fn = goldens not matched, with Core leaving out the goldens Martian
categorises `style` and `speculative` and Strict also `doc_defect`, `test_gap`
and `perf`; precision, recall, F1 and F2 (beta 2). This script makes that count
from the published tables (claim_metrics.PROFILES), so it reproduces every
stored `martian_scores` row of our judge (gpt-6.1-sol) whose reviews ship
from `martian_verdicts` (per golden, `matched`), `martian_reviews` (per PR,
`fp`) and `martian_goldens` (`category`), names the stored rows it cannot
recompute (no `martian_reviews` rows: re-judged calibration dirs and
open-model smokes), and scores your judge's answers the same way.

DIR holds your judge's answers as two tables shaped like the published ones:
`martian_verdicts` (work_dir, tool, pr_url, golden_index, matched) and
`martian_reviews` (work_dir, tool, pr_url, fp: the PR's unmatched candidates;
other columns are ignored), each `<table>.parquet` or `.jsonl`. Every row is
labelled LABEL, a label no published row carries. A run's PRs are the PRs of
its `martian_reviews` rows; the script refuses a verdict on a golden the PR
does not have or on a PR the run has no fp for, a repeated row, and a run
whose review the release does not ship. Without DIR it recomputes our judge's
runs and checks them against the stored scores.

--from-evaluations reads our own judge's output instead: Martian's step 3
writes `results/<model>/evaluations.json` in a scoring dir (`ext.sh martian`,
with EXT_JUDGE_MODEL for another model), {pr_url: {tool: {true_positives:
[{golden_comment, ...}], false_positives, fp, ...}}}. It is mapped to the two
tables (evaluations_rows): per PR and tool, one `martian_verdicts` row per
golden of the PR in `martian_goldens`, matched when a true positive's
`golden_comment` is that golden's `comment` (a golden text the PR does not
have is refused), and one `martian_reviews` row whose `fp` is the entry's `fp`
(the number of its `false_positives` when it has none). Every row gets
`--work` as its `work_dir` (give both flags once per scoring dir, in the same
order, to score several), and `--tool [WORK|]FROM=TO` renames a tool to the
table's name, under one work dir or every one (the frozen build's
`quickreview` is `quickreview-frozen` under `final1-martian50`). `--save DIR`
also writes the mapped tables there, the `--verdicts` input heldout.py takes.

--half recounts on one half's PRs (a committed set file, as claim_metrics'
`WORK|TOOL~HALF` keys do). When your judge judged only some of the PRs ours
judged (a sample), our column is counted over your judge's PRs too, and the
header says how many of ours that is; --whole-run counts ours over all of its
PRs instead (so the two columns cover different PRs).
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
from typing import Dict, List, Optional, Set, Tuple

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from claim_metrics import PROFILES  # noqa: E402
from tables import has_table, load_table, with_judge  # noqa: E402

OURS = "gpt-6.1-sol"
SETS = os.path.join(os.path.dirname(HERE), "sets")
FIELDS = ("tp", "fp", "fn", "precision", "recall", "f1", "f2")


def verdict_rows(data: str, extra: str, judge: str) -> List[dict]:
    """The published martian_verdicts plus your judge's, checked (heldout.py reads this too)."""
    return _load(data, extra, judge)[0]


def fp_rows(data: str, extra: str, judge: str) -> List[dict]:
    return _load(data, extra, judge)[1]


def _load(data: str, extra: str, judge: str) -> Tuple[List[dict], List[dict]]:
    gold = {(g["pr_url"], g["golden_index"]) for g in load_table(data, "martian_goldens")}
    shipped = {(r["work_dir"], r["tool"], r["pr_url"]) for r in load_table(data, "martian_reviews")}
    vs = with_judge(load_table(data, "martian_verdicts"), extra, "martian_verdicts", judge)
    rs = with_judge(load_table(data, "martian_reviews"), extra, "martian_reviews", judge)
    fp_of: Dict[tuple, int] = {}
    for r in rs:
        if r["judge"] != judge:
            continue
        k = (r.get("work_dir"), r.get("tool"), r.get("pr_url"))
        if k not in shipped:
            raise SystemExit(f"an fp row for a review the release does not ship: {k}")
        if k in fp_of:
            raise SystemExit(f"two fp rows for {k}")
        if not isinstance(r.get("fp"), int) or r["fp"] < 0:
            raise SystemExit(f"fp must be a count of unmatched candidates, got {r.get('fp')!r}: {k}")
        fp_of[k] = r["fp"]
    seen: Set[tuple] = set()
    runs = {k[:2] for k in fp_of}
    for v in vs:
        if v["judge"] != judge:
            continue
        k = (v.get("work_dir"), v.get("tool"), v.get("pr_url"), v.get("golden_index"))
        # A run with no fp row at all cannot be scored (and is not); one that has fp rows must have the PR's.
        if k[:2] in runs and k[:3] not in fp_of:
            raise SystemExit(f"a verdict on a PR with no fp row (its martian_reviews row): {k}")
        if (k[2], k[3]) not in gold:
            raise SystemExit(f"a verdict on a golden the PR does not have: {k}")
        if k in seen:
            raise SystemExit(f"two verdicts for {k}")
        seen.add(k)
    return vs, rs


def evaluations_rows(data: str, path: str, work: str, tools: Dict[str, str]) -> Tuple[List[dict], List[dict]]:
    """Martian's evaluations.json as (martian_verdicts, martian_reviews) rows (the module docstring)."""
    golden: Dict[str, Dict[str, int]] = {}
    for g in load_table(data, "martian_goldens"):
        golden.setdefault(g["pr_url"], {})[g["comment"]] = g["golden_index"]
    shipped: Dict[str, Set[str]] = {}
    for r in load_table(data, "martian_reviews"):
        shipped.setdefault(r["work_dir"], set()).add(r["tool"])
    with open(path) as f:
        evals = json.load(f)
    verdicts, reviews = [], []
    for url in sorted(evals):
        if url not in golden:
            raise SystemExit(f"{path}: PR {url} is not in martian_goldens")
        for src, e in sorted((evals[url] or {}).items()):
            tool = tools.get(src, src)
            if work in shipped and tool not in shipped[work]:
                raise SystemExit(f"{path}: the release ships {work}'s reviews under {sorted(shipped[work])}, not "
                                 f"{tool!r}: name it with --tool '{work}|{src}=<one of those>'")
            hit = set()
            for tp in e.get("true_positives") or []:
                i = golden[url].get(tp.get("golden_comment"))
                if i is None:
                    raise SystemExit(f"{path}: {src} on {url} matched a golden comment the PR does not have in "
                                     f"martian_goldens: {str(tp.get('golden_comment'))[:80]!r}")
                hit.add(i)
            verdicts += [{"work_dir": work, "tool": tool, "pr_url": url, "golden_index": i, "matched": i in hit}
                         for i in sorted(golden[url].values())]
            fp = e.get("fp")
            reviews.append({"work_dir": work, "tool": tool, "pr_url": url,
                            "fp": fp if isinstance(fp, int) else len(e.get("false_positives") or [])})
    return verdicts, reviews


def counts(goldens: List[dict], verdicts: List[dict], reviews: List[dict], work: str, tool: str, judge: str,
           urls: Optional[Set[str]] = None) -> Dict[str, Tuple[int, int, int]]:
    """{profile: (tp, fp, fn)} of one run under one judge, over its PRs (or those of them in `urls`)."""
    rows = [r for r in reviews if r["work_dir"] == work and r["tool"] == tool and r["judge"] == judge
            and (urls is None or r["pr_url"] in urls)]
    if not rows:
        raise SystemExit(f"no {judge} fp rows (martian_reviews) for {work}|{tool}" + (" on that half" if urls else ""))
    prs = {r["pr_url"] for r in rows}
    cat = {(g["pr_url"], g["golden_index"]): g["category"] for g in goldens}
    hit = {(v["pr_url"], v["golden_index"]) for v in verdicts
           if v["work_dir"] == work and v["tool"] == tool and v["judge"] == judge and v["matched"] and v["pr_url"] in prs}
    fp = sum(r["fp"] or 0 for r in rows)
    out = {}
    for p, excluded in PROFILES.items():
        tp = sum(1 for k in hit if cat[k] not in excluded)
        out[p] = (tp, fp, sum(1 for k, c in cat.items() if k[0] in prs and c not in excluded) - tp)
    return out


def metrics(c: Dict[str, Tuple[int, int, int]]) -> Dict[str, float]:
    """Each profile's tp fp fn and precision, recall, F1, F2 (percent), as Martian's scorer computes them."""
    out: Dict[str, float] = {}
    for p, (tp, fp, fn) in c.items():
        pr = tp / (tp + fp) if tp + fp else 0.0
        rc = tp / (tp + fn) if tp + fn else 0.0
        out.update({f"{p}_tp": tp, f"{p}_fp": fp, f"{p}_fn": fn, f"{p}_precision": 100 * pr, f"{p}_recall": 100 * rc,
                    f"{p}_f1": 100 * (2 * pr * rc / (pr + rc) if pr + rc else 0.0),
                    f"{p}_f2": 100 * (5 * pr * rc / (4 * pr + rc) if pr + rc else 0.0)})
    return out


def stored(scores: List[dict], work: str, tool: str) -> Optional[Dict[str, float]]:
    """Our judge's stored martian_scores row of the run, in the same units (percent), or None."""
    rows = [s for s in scores if s["work_dir"] == work and s["tool"] == tool and s["judge"] == OURS]
    if len(rows) != 1:
        return None
    return {f"{p}_{f}": (100 * rows[0][f"{p}_{f}"] if f not in ("tp", "fp", "fn") else rows[0][f"{p}_{f}"])
            for p in PROFILES for f in FIELDS}


def fmt(v: Optional[float], key: str) -> str:
    if v is None:
        return "unknown"
    return f"{v:g}" if key.rsplit("_", 1)[1] in ("tp", "fp", "fn") else f"{v:.1f}"


def render(res: dict, judge: str) -> str:
    out = []
    cols = [judge] + ([f"{OURS} (recomputed)", f"{OURS} (stored)"] if judge != OURS else ["stored"])
    for run, r in res["runs"].items():
        head = f"{run}" + (f" ~{res['half']}" if res["half"] else "") + f": {r['prs']} PRs judged by {judge}"
        if judge != OURS:
            head += f", {r['reference_prs']} by {OURS}"
        if r["sample"]:
            head += f"; both columns over the {r['prs']} PRs {judge} judged (--whole-run: all of ours)"
        out += [head,
                "| profile | " + " | ".join(cols) + " |", "|---|" + "---:|" * len(cols)]
        for p in PROFILES:
            for f in ("precision", "recall", "f1", "f2", "tp", "fp", "fn"):
                k = f"{p}_{f}"
                vals = [r[judge].get(k)] + ([(r.get(OURS) or {}).get(k)] if judge != OURS else []) \
                    + [(r.get("stored") or {}).get(k)]
                out.append(f"| {k} | " + " | ".join(fmt(v, k) for v in vals) + " |")
        if r.get("stored_equal") is not None:
            out.append(f"recomputed {OURS} == stored martian_scores: {r['stored_equal']}")
        out.append("")
    return "\n".join(out).rstrip()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", required=True, help="the Hugging Face dataset dir (or its data/ dir)")
    ap.add_argument("--verdicts", help="the dir holding your judge's martian_verdicts and martian_reviews (fp)")
    ap.add_argument("--from-evaluations", action="append", default=[], metavar="JSON",
                    help="instead of --verdicts: Martian's results/<model>/evaluations.json, mapped to the two "
                         "tables (repeatable, each with its --work)")
    ap.add_argument("--work", action="append", default=[],
                    help="with --from-evaluations: the work_dir its rows score (e.g. final1-martian50)")
    ap.add_argument("--tool", action="append", default=[], metavar="[WORK|]FROM=TO",
                    help="with --from-evaluations: rename a tool to the table's name, under one work dir or all "
                         "(repeatable), e.g. final1-martian50|quickreview=quickreview-frozen")
    ap.add_argument("--save", help="with --from-evaluations: also write the mapped tables (.jsonl) to this dir")
    ap.add_argument("--judge", help="your judge's label (one no published row carries)")
    ap.add_argument("--runs", help="WORK|TOOL, comma-separated (default: every run the judge judged)")
    ap.add_argument("--half", help="recount on one half's PRs: a set file name (martian-test30, martian-tune20)")
    ap.add_argument("--sets-dir", default=SETS)
    ap.add_argument("--whole-run", action="store_true",
                    help="count our judge over all its PRs even when yours judged only some")
    ap.add_argument("--json", help="also write every number to this JSON file")
    a = ap.parse_args()
    if a.verdicts and a.from_evaluations:
        sys.exit("give your judge's answers once: --verdicts DIR or --from-evaluations JSON --work WORK")
    tmp = None
    if a.from_evaluations:
        if len(a.work) != len(a.from_evaluations):
            sys.exit("give one --work (the work_dir its evaluations score) per --from-evaluations, in the same order")
        bad = [x for x in a.tool if "=" not in x]
        if bad:
            sys.exit(f"--tool wants [WORK|]FROM=TO, got {bad}")
        rename = [(x.split("=", 1)[0].rpartition("|"), x.split("=", 1)[1]) for x in a.tool]
        vs_new, rs_new = [], []
        for path, work in zip(a.from_evaluations, a.work):
            v, r = evaluations_rows(a.data, path, work, {src: to for (w, _, src), to in rename if w in ("", work)})
            vs_new += v
            rs_new += r
        a.verdicts = a.save or tempfile.mkdtemp(prefix="martian-evaluations-")
        tmp = None if a.save else a.verdicts
        os.makedirs(a.verdicts, exist_ok=True)
        for name, rows in (("martian_verdicts", vs_new), ("martian_reviews", rs_new)):
            with open(os.path.join(a.verdicts, f"{name}.jsonl"), "w") as f:
                f.writelines(json.dumps(x) + "\n" for x in rows)
    if bool(a.verdicts) != bool(a.judge):
        sys.exit("--verdicts (or --from-evaluations) and --judge go together: your judge's answers and its label")
    judge = a.judge or OURS
    goldens = load_table(a.data, "martian_goldens")
    if a.verdicts:
        for t in ("martian_verdicts", "martian_reviews"):
            if not has_table(a.verdicts, t):
                sys.exit(f"{a.verdicts}: no {t}.parquet or .jsonl")
        try:
            vs, rs = _load(a.data, a.verdicts, judge)
        finally:
            if tmp:
                shutil.rmtree(tmp)
    else:
        vs, rs = load_table(a.data, "martian_verdicts"), load_table(a.data, "martian_reviews")
    scores = load_table(a.data, "martian_scores")
    have = sorted({f"{r['work_dir']}|{r['tool']}" for r in rs if r["judge"] == judge})
    runs = [x for x in (a.runs.split(",") if a.runs else have) if x]
    missing = [x for x in runs if x not in have]
    if missing:
        sys.exit(f"no {judge} fp rows for run(s) {missing}")
    urls = None
    if a.half:
        with open(os.path.join(a.sets_dir, f"{a.half}.json")) as f:
            urls = {c["pr_url"] for c in json.load(f)["cases"]}
    res: dict = {"judge": judge, "half": a.half, "runs": {}}
    for run in runs:
        work, _, tool = run.partition("|")
        prs_of = lambda j: {x["pr_url"] for x in rs if x["work_dir"] == work and x["tool"] == tool  # noqa: E731
                            and x["judge"] == j and (urls is None or x["pr_url"] in urls)}
        mine, ours = prs_of(judge), prs_of(OURS)
        # a sample: ours over the PRs your judge judged, never yours over them and ours over all
        sample = judge != OURS and not a.whole_run and bool(ours) and not ours <= mine
        r: dict = {"prs": len(mine), "reference_prs": len(ours), "sample": sample}
        r[judge] = metrics(counts(goldens, vs, rs, work, tool, judge, urls))
        if judge != OURS:
            r[OURS] = (metrics(counts(goldens, vs, rs, work, tool, OURS, mine if sample else urls))
                       if ours and (not sample or mine & ours) else None)
        r["stored"] = stored(scores, work, tool) if urls is None and not sample else None
        mine = r[OURS] if judge != OURS else r[judge]
        if r["stored"] is not None and mine is not None:
            r["stored_equal"] = all(abs(mine[k] - r["stored"][k]) < 1e-6 for k in r["stored"])
        res["runs"][run] = r
    print(render(res, judge))
    if not a.verdicts and not a.half and not a.runs:
        gone = sorted({f"{x['work_dir']}|{x['tool']}" for x in scores if x["judge"] == OURS} - set(have))
        res["not_recomputed"] = gone
        print(f"\nrecomputed {len(runs)} stored {OURS} scores; {len(gone)} have no martian_reviews rows and are "
              "not recomputed: " + (", ".join(gone) or "none"))
    if not a.verdicts and not a.half:
        bad = [run for run, r in res["runs"].items() if r.get("stored_equal") is False]
        if bad:
            sys.exit(f"recomputed scores differ from the stored martian_scores: {bad}")
    if a.json:
        with open(a.json, "w") as f:
            json.dump(res, f, indent=1)


if __name__ == "__main__":
    main()
