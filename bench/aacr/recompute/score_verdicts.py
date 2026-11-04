#!/usr/bin/env python3
"""Score another judge's AACR verdicts on QuickReview's published reviews, beside ours.

    python3 bench/aacr/recompute/score_verdicts.py --data <hf-dataset> --verdicts DIR --judge LABEL
        [--arms a,b,...] [--select SEL] [--json OUT]
    python3 bench/aacr/recompute/score_verdicts.py --data <hf-dataset> --judge LABEL
        --from-judgements ARM[,ARM...] --runs-dir RUNS [--runs-dir ...] --judge-dir NAME [--save DIR] [...]

(`uv run --no-project --with pyarrow python ...` when the tables are parquet.) No model call.

DIR holds your judge's answers as two tables shaped like the published ones,
`defect_verdicts` (arm_id, instance_id, defect_id, verdict: found | partial |
missed; credit optional) and, optionally, `comment_verdicts` (arm_id,
instance_id, comment_id, grade: correct-valuable | correct-minor |
partly-correct | incorrect | unverifiable; defect_id; new_defect), each as
`<table>.parquet` or `<table>.jsonl`. A `judge` column is not needed: every row
is labelled LABEL, which must be a label no published row carries. A review
your judge judged is any (arm, PR) with a row in DIR; the script adds LABEL to
that review's `reviews.judged_by`, so the agreement metrics pair it with ours.

It refuses a row the published data cannot place (an unknown arm, a defect not
in the PR's key, a comment id the review does not have, a verdict or grade
outside the vocabulary, a credit that is not the verdict's, a repeated row),
then prints per arm, under your judge and under the arm's own published judge
(`arms.judge`), the numbers the papers print from claim_metrics.Aacr: defects
found (partial 1/2) and recall, high-severity and weighted recall, comments
graded and the share graded correct (correct-valuable or correct-minor, the
papers' precision) or incorrect; and the two judges' agreement from
claim_metrics.Judges: on every key defect of the reviews both judged (no row =
missed; percent and Cohen's kappa) and on the comments both graded.
--select narrows the PRs as a claim's key does (claim_metrics.Aacr's SEL, `&`-joined):
`arm=copilot-2025-upstream` scores the 19 PRs of tab:copilot2025, `set=holdout10+fresh10`
the held-out sets; the review count and the agreement are over the same PRs. When
your judge judged only some of the PRs ours judged (a sample), both columns are
counted over your judge's PRs alone, and the header says how many of ours that is;
--whole-run counts every PR of the arm instead, where a PR your judge did not judge
counts as missed (so its numbers are not comparable with ours).
`aacr_bootstrap.py --verdicts DIR --judge LABEL` gives the intervals and
`heldout.py --verdicts DIR --judge LABEL --fixed-set` the held-out PRs.

--from-judgements reads our own judge's output instead (`bench.sh judge`, Tier
2 of bench/aacr/README.md, with another model and `--label NAME`): each run
dir's `judge/v<key version>-<NAME>/<instance>.r1.json` (its `defects`, each
id and verdict, and its `comments`, each id, verdict, defect and new_defect),
mapped to the two tables (judgements_rows). An arm's run dirs are `arms.runs`,
found under the first `--runs-dir` that holds each (the unpacked archive's
`runs/`, or your own runs dir); a PR is read from the first of them with a
judgement of it that is not an error, as compare.py scores an arm, and only
the arm's published PRs are read. `--save DIR` also writes the mapped tables
there, the `--verdicts` input aacr_bootstrap.py and heldout.py take.
"""
from __future__ import annotations

import argparse
import copy
import json
import os
import shutil
import sys
import tempfile
from typing import Dict, List, Optional, Sequence

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import claim_metrics as cm  # noqa: E402
from tables import has_table, load_table, with_judge  # noqa: E402

DEFECT_VERDICTS = ("found", "partial", "missed")  # src/bench/defects.ts DEFECT_VERDICTS
GRADES = ("correct-valuable", "correct-minor", "partly-correct", "incorrect", "unverifiable")
METRICS = (("found", "found"), ("defects", "defects"), ("recall", "recall"), ("high_rec", "high recall"),
           ("weighted", "weighted recall"), ("graded", "comments graded"), ("correct", "correct"),
           ("incorrect", "incorrect"), ("new_defects", "new defects"))
AGREEMENT = (("pairs", "defect pairs"), ("pct", "same verdict %"), ("kappa", "kappa"),
             ("c_pairs", "comment pairs"), ("c_pct", "same grade %"), ("c_kappa", "comment kappa"))


def defect_rows(data: str, extra: str, judge: str) -> List[dict]:
    """The published defect_verdicts plus your judge's (checked; credit from the verdict)."""
    key = {(d["instance_id"], d["defect_id"]) for d in load_table(data, "defects")}
    arms = {a["arm_id"] for a in load_table(data, "arms")}
    rows = with_judge(load_table(data, "defect_verdicts"), extra, "defect_verdicts", judge)
    seen = set()
    out = []
    for r in rows:
        if r["judge"] != judge:
            out.append(r)
            continue
        k = (r.get("arm_id"), r.get("instance_id"), r.get("defect_id"))
        if k[0] not in arms:
            raise SystemExit(f"defect verdict for an unknown arm: {k}")
        if k[1:] not in key:
            raise SystemExit(f"defect verdict for a defect not in the key: {k}")
        if r.get("verdict") not in DEFECT_VERDICTS:
            raise SystemExit(f"defect verdict {r.get('verdict')!r} is not one of {'|'.join(DEFECT_VERDICTS)}: {k}")
        credit = cm.CREDIT.get(r["verdict"], 0.0)
        if r.get("credit") is not None and float(r["credit"]) != credit:
            raise SystemExit(f"credit {r['credit']} is not the credit of {r['verdict']!r} ({credit}): {k}")
        if k in seen:
            raise SystemExit(f"two defect verdicts for {k}")
        seen.add(k)
        out.append(dict(r, credit=credit))
    return out


def comment_rows(data: str, extra: str, judge: str) -> List[dict]:
    """The published comment_verdicts plus your judge's (checked against the reviews' comment ids)."""
    rows = with_judge(load_table(data, "comment_verdicts"), extra, "comment_verdicts", judge, optional=True)
    ids = {(r["arm_id"], r["instance_id"]): {c["id"] for c in (r["comments"] or [])} for r in load_table(data, "reviews")}
    key = {(d["instance_id"], d["defect_id"]) for d in load_table(data, "defects")}
    seen = set()
    for r in rows:
        if r["judge"] != judge:
            continue
        k = (r.get("arm_id"), r.get("instance_id"), r.get("comment_id"))
        if k[:2] in ids and k[2] not in ids[k[:2]]:  # a review the tables do not ship is checked by the archive's
            raise SystemExit(f"comment verdict for a comment the review does not have: {k}")
        if r.get("grade") not in GRADES:
            raise SystemExit(f"comment grade {r.get('grade')!r} is not one of {'|'.join(GRADES)}: {k}")
        if r.get("defect_id") and (k[1], r["defect_id"]) not in key:
            raise SystemExit(f"comment verdict maps to a defect not in the key: {k} -> {r['defect_id']}")
        if k in seen:
            raise SystemExit(f"two comment verdicts for {k}")
        seen.add(k)
    return rows


def judgements_rows(data: str, arms: Sequence[str], runs_dirs: Sequence[str], judge_dir: str) -> Dict[str, List[dict]]:
    """Our AACR judge's per-PR files as defect_verdicts and comment_verdicts rows (the module docstring)."""
    version = {p["instance_id"]: p["key_version"] for p in load_table(data, "prs")}
    runs_of = {a["arm_id"]: list(a.get("runs") or []) for a in load_table(data, "arms")}
    published = {(r["arm_id"], r["instance_id"]) for t in ("reviews", "defect_verdicts") for r in load_table(data, t)}
    out: Dict[str, List[dict]] = {"defect_verdicts": [], "comment_verdicts": []}
    for arm in arms:
        if arm not in runs_of:
            raise SystemExit(f"--from-judgements: no arm {arm!r} in arms")
        dirs = []
        for run in runs_of[arm]:
            found = next((os.path.join(d, run) for d in runs_dirs if os.path.isdir(os.path.join(d, run))), None)
            if found is None:
                raise SystemExit(f"--from-judgements: arm {arm}'s run dir {run} is under no --runs-dir {list(runs_dirs)}")
            dirs.append(found)
        n = 0
        for iid in sorted(i for a, i in published if a == arm):
            sub = judge_dir if judge_dir.startswith("wpself-") else f"v{version.get(iid)}-{judge_dir}"
            for d in dirs:
                try:
                    with open(os.path.join(d, "judge", sub, f"{iid}.r1.json")) as f:
                        j = json.load(f)
                except (OSError, ValueError):
                    continue
                if not isinstance(j, dict) or j.get("error"):
                    continue
                n += 1
                out["defect_verdicts"] += [{"arm_id": arm, "instance_id": iid, "defect_id": x["id"],
                                            "verdict": x.get("verdict")} for x in j.get("defects") or []]
                out["comment_verdicts"] += [{"arm_id": arm, "instance_id": iid, "comment_id": c["id"],
                                             "grade": c.get("verdict"), "defect_id": c.get("defect"),
                                             "new_defect": c.get("new_defect")} for c in j.get("comments") or []]
                break
        if not n:
            raise SystemExit(f"--from-judgements: no judge/v<key>-{judge_dir}/ judgement of arm {arm} in its run dirs")
    return out


class WithJudge(cm.Tables):
    """The published tables with your judge's verdicts added and `judged_by` set from them."""

    def __init__(self, data: str, extra: str, judge: str):
        super().__init__(data)
        self._t["defect_verdicts"] = defect_rows(data, extra, judge)
        self._t["comment_verdicts"] = comment_rows(data, extra, judge)
        judged = {(r["arm_id"], r["instance_id"]) for t in ("defect_verdicts", "comment_verdicts")
                  for r in self._t[t] if r["judge"] == judge}
        # Some development arms' verdicts ship without their review rows (their reviews are in the
        # run archive): those take no judged_by, so they enter recall but no agreement pair.
        reviews = load_table(data, "reviews")
        self._t["reviews"] = [dict(r, judged_by=list(r["judged_by"] or []) + [judge])
                              if (r["arm_id"], r["instance_id"]) in judged else r for r in reviews]
        self.judged = judged


def judged_prs(tables: cm.Tables, arm: str, judge: str) -> set:
    """The PRs of an arm a judge has a defect or comment verdict on."""
    return {r["instance_id"] for t in ("defect_verdicts", "comment_verdicts") for r in tables(t)
            if r["arm_id"] == arm and r["judge"] == judge}


def only_judged_on(tables: WithJudge, judge: str, keep: set) -> cm.Tables:
    """The tables with `judge` left in `reviews.judged_by` only on the (arm, PR) reviews in `keep`, so the
    agreement pairs only those."""
    view = copy.copy(tables)
    view._t = dict(tables._t)
    view._t["reviews"] = [r if judge not in (r["judged_by"] or []) or (r["arm_id"], r["instance_id"]) in keep
                          else dict(r, judged_by=[j for j in r["judged_by"] if j != judge]) for r in tables("reviews")]
    return view


def score(tables: WithJudge, judge: str, arms: Sequence[str], select: str = "",
          whole_run: bool = False) -> Dict[str, dict]:
    aacr = cm.Aacr(tables)
    out = {}
    for arm in arms:
        ref = aacr.judge_of(arm)
        chosen = aacr.select(arm, select)[0] if select else None
        mine = {i for a, i in tables.judged if a == arm and (chosen is None or i in chosen)}
        ours = {i for i in judged_prs(tables, arm, ref) if chosen is None or i in chosen}
        # a sample: both columns over the PRs your judge judged, never yours over them and ours over all
        sample = not whole_run and bool(mine) and not ours <= mine
        sel = "&".join(x for x in (select, "pr=" + "+".join(sorted(mine)) if sample else "") if x)
        sel = f"~{sel}" if sel else ""
        row: Dict[str, dict] = {"reference_judge": ref, "reviews": len(mine), "reference_reviews": len(ours),
                                "sample": sample}
        for j in (judge, ref):
            row[j] = {m: aacr.value(f"{arm}@{j}{sel}:{m}") for m, _ in METRICS}
        judges = cm.Judges(only_judged_on(tables, judge, {(arm, i) for i in mine}))
        agree: Dict[str, Optional[float]] = {}
        for m, _ in AGREEMENT:
            try:
                agree[m] = judges.value(f"{ref}|{judge}|{arm}:{m}")
            except cm.KeyError_:
                agree[m] = None  # no review both judged: unknown, never zero
        row["agreement"] = agree
        out[arm] = row
    return out


def fmt(v: Optional[float], m: str) -> str:
    if v is None:
        return "unknown"
    if m in ("recall", "high_rec", "weighted", "correct", "incorrect", "pct", "c_pct"):
        return f"{v:.1f}%"
    if m in ("kappa", "c_kappa"):
        return f"{v:.3f}"
    return f"{v:g}"


def render(res: Dict[str, dict], judge: str) -> str:
    out = []
    for arm, r in res.items():
        ref = r["reference_judge"]
        head = f"{arm}: {r['reviews']} reviews judged by {judge}, {r['reference_reviews']} by {ref}"
        if r["sample"]:
            head += f"; both columns over the {r['reviews']} PRs {judge} judged (--whole-run: every PR)"
        out += [head, f"| metric | {judge} | {ref} |", "|---|---:|---:|"]
        out += [f"| {name} | {fmt(r[judge][m], m)} | {fmt(r[ref][m], m)} |" for m, name in METRICS]
        out.append("agreement with " + ref + ": " + ", ".join(f"{name} {fmt(r['agreement'][m], m)}"
                                                            for m, name in AGREEMENT))
        out.append("")
    return "\n".join(out).rstrip()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", required=True, help="the Hugging Face dataset dir (or its data/ dir)")
    ap.add_argument("--verdicts", help="the dir holding your judge's defect_verdicts (and comment_verdicts)")
    ap.add_argument("--from-judgements", metavar="ARM[,ARM...]",
                    help="instead of --verdicts: our AACR judge's files in these arms' run dirs, mapped to the tables")
    ap.add_argument("--runs-dir", action="append", default=[],
                    help="with --from-judgements: a dir holding the arms' run dirs (repeatable, searched in order)")
    ap.add_argument("--judge-dir", help="with --from-judgements: the judge's label, its dirs judge/v<key>-<label>/")
    ap.add_argument("--save", help="with --from-judgements: also write the mapped tables (.jsonl) to this dir")
    ap.add_argument("--judge", required=True, help="your judge's label (one no published row carries)")
    ap.add_argument("--arms", help="arm ids, comma-separated (default: every arm your judge judged)")
    ap.add_argument("--select", default="", help="the PRs to score, a claim_metrics.Aacr selector "
                    "(arm=copilot-2025-upstream, set=a+b, pr=<id>; default: every PR of the arm)")
    ap.add_argument("--whole-run", action="store_true",
                    help="count every PR of the arm even when your judge judged only some (those count as missed)")
    ap.add_argument("--json", help="also write every number to this JSON file")
    a = ap.parse_args()
    if bool(a.verdicts) == bool(a.from_judgements):
        sys.exit("give your judge's answers once: --verdicts DIR or --from-judgements ARM --runs-dir RUNS --judge-dir NAME")
    tmp = None
    if a.from_judgements:
        if not (a.runs_dir and a.judge_dir):
            sys.exit("--from-judgements needs --runs-dir (where the arms' run dirs are) and --judge-dir (the judge's label)")
        rows = judgements_rows(a.data, [x for x in a.from_judgements.split(",") if x], a.runs_dir, a.judge_dir)
        a.verdicts = a.save or tempfile.mkdtemp(prefix="aacr-judgements-")
        tmp = None if a.save else a.verdicts
        os.makedirs(a.verdicts, exist_ok=True)
        for name, xs in rows.items():
            with open(os.path.join(a.verdicts, f"{name}.jsonl"), "w") as f:
                f.writelines(json.dumps(x) + "\n" for x in xs)
    if not has_table(a.verdicts, "defect_verdicts"):
        sys.exit(f"{a.verdicts}: no defect_verdicts.parquet or .jsonl")
    try:
        t = WithJudge(a.data, a.verdicts, a.judge)
    finally:
        if tmp:
            shutil.rmtree(tmp)
    have = sorted({arm for arm, _ in t.judged})
    arms = [x for x in (a.arms.split(",") if a.arms else have) if x]
    missing = [x for x in arms if x not in have]
    if missing:
        sys.exit(f"no {a.judge} verdicts for arm(s) {missing}")
    res = score(t, a.judge, arms, a.select, a.whole_run)
    print(render(res, a.judge))
    if a.json:
        with open(a.json, "w") as f:
            json.dump({"judge": a.judge, "select": a.select or "all", "arms": res}, f, indent=1)


if __name__ == "__main__":
    main()
