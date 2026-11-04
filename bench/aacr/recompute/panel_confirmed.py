#!/usr/bin/env python3
"""pi-review's panel read with its confirmed findings only, from the run archive and the HF tables.

    python3 bench/aacr/recompute/panel_confirmed.py --archive <release>/archive --data <hf-dataset> \\
        [--arms a,b] [--work <scratch>] [--json OUT]

(`uv run --no-project --with pyarrow python ...` for the parquet tables.)

quickreview.tex §"What the vote does" and the panel comparison (tab:panel40). pi-review's panel clusters
its three reviewers' findings: a cluster two or more raised is CONFIRMED, one only one raised is an
ADVISORY (`cases/<id>/pireview-meta.json`: `confirmedClusters`, `advisories`). The harness posts every
cluster with text, right-side ones first, then those anchored on the base side; the judge numbers the
comments it saw C1.. in that order (the analysis tree's paper-data/confirmed_only.py). With that map,
the primary judge's published verdicts (HF `defect_verdicts`, `comment_verdicts`) are re-read:
  found          credit (found 1, partial ½) of the key defects at least one confirmed comment credits,
                 overall and by severity; `all` the arm's whole credit, `advisory_only` the credit no
                 confirmed comment shares;
  grades         per kind of comment (confirmed, advisory), how many the judge graded and how many it
                 graded correct (correct-valuable or correct-minor);
over all of an arm's judged PRs (`all`) and the 40 of the selection set (`s40`). No model call.
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from archive import open_archive, read_json, volumes_for  # noqa: E402
from tables import load_table  # noqa: E402

JUDGE = "gpt-6-sol-high"
CREDIT = {"found": 1.0, "partial": 0.5}
ARMS = ("pireview-panel-high-g61", "pireview-panel-sol-s40")


def _note(f: dict) -> str:
    parts = [(f.get("summary") or "").strip(), (f.get("details") or "").strip(),
             ("Recommendation: " + f["recommendation"].strip()) if (f.get("recommendation") or "").strip() else ""]
    return "\n\n".join(p for p in parts if p).strip()


def confirmed_ids(meta: dict) -> dict:
    """C<n> -> True (confirmed) / False (advisory), in the order the judge saw the comments."""
    byid = {sf["id"]: sf["finding"] for sf in meta.get("sourceFindings") or []}
    right, left = [], []
    for cl in (meta.get("confirmedClusters") or []) + (meta.get("advisories") or []):
        srcs = [byid[i] for i in cl.get("sourceFindingIds") or [] if i in byid]
        can = next((f for f in srcs if f.get("actionable")), srcs[0] if srcs else None)
        f = dict(can) if can else {"summary": cl.get("summary")}
        loc = (can or {}).get("location") or next((s.get("location") for s in srcs if s.get("location")), None)
        if not _note(f):
            continue
        (left if loc and loc.get("side") == "base" else right).append(bool(cl.get("confirmed")))
    return {f"C{i + 1}": conf for i, conf in enumerate(right + left)}


def compute(root: Path, data: str, arms) -> dict:
    prs = {p["instance_id"]: p for p in load_table(data, "prs")}
    sev = {(d["instance_id"], d["defect_id"]): d["severity"] for d in load_table(data, "defects")}
    reviews = [r for r in load_table(data, "reviews") if r["arm_id"] in arms and r["judged"]]
    dv = [v for v in load_table(data, "defect_verdicts") if v["arm_id"] in arms and v["judge"] == JUDGE]
    cv = [c for c in load_table(data, "comment_verdicts") if c["arm_id"] in arms and c["judge"] == JUDGE]
    ids = {}
    for r in reviews:
        meta = read_json(root / "runs" / r["run"] / "cases" / r["instance_id"] / "pireview-meta.json")
        ids[(r["arm_id"], r["instance_id"])] = confirmed_ids(meta)
    out = {}
    for arm in arms:
        out[arm] = {}
        for sel, keep in (("all", set(prs)), ("s40", {i for i, p in prs.items() if p["in_s40"]})):
            judged = {i for (a, i) in ids if a == arm and i in keep}
            if not judged:
                continue
            found = collections.Counter()
            conf = collections.Counter()
            adv_only = 0.0
            for v in dv:
                if v["arm_id"] != arm or v["instance_id"] not in judged:
                    continue
                c = CREDIT.get(v["verdict"], 0.0)
                s = sev[(v["instance_id"], v["defect_id"])]
                m = ids[(arm, v["instance_id"])]
                found[s] += c
                if c and any(m.get(x) for x in v["comment_ids"] or []):
                    conf[s] += c
                elif c and v["comment_ids"]:
                    adv_only += c
            grades = {"confirmed": collections.Counter(), "advisory": collections.Counter()}
            for c in cv:
                if c["arm_id"] == arm and c["instance_id"] in judged:
                    kind = "confirmed" if ids[(arm, c["instance_id"])].get(c["comment_id"]) else "advisory"
                    grades[kind]["graded"] += 1
                    grades[kind]["correct"] += c["grade"] in ("correct-valuable", "correct-minor")
            defects = sum(1 for k in sev if k[0] in judged)
            out[arm][sel] = {"prs": len(judged), "defects": defects, "found_all": sum(found.values()),
                             "found_confirmed": sum(conf.values()), "recall_confirmed": 100 * sum(conf.values()) / defects,
                             "confirmed_by_severity": dict(conf), "advisory_only": adv_only,
                             "grades": {k: {**dict(g), "correct_pct": 100 * g["correct"] / g["graded"] if g["graded"] else None}
                                        for k, g in grades.items()}}
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--archive", required=True)
    ap.add_argument("--data", required=True)
    ap.add_argument("--arms", default=",".join(ARMS))
    ap.add_argument("--work", default=os.path.join(os.environ.get("TMPDIR", "."), "panel-confirmed"))
    ap.add_argument("--json")
    a = ap.parse_args()
    arms = [x for x in a.arms.split(",") if x]
    runs = {r["run"] for r in load_table(a.data, "reviews") if r["arm_id"] in arms and r["judged"]}
    root = open_archive(a.archive, a.work, volumes_for(load_table(a.data, "runs"), sorted(runs)))
    res = compute(root, a.data, arms)
    print(json.dumps(res, indent=1))
    if a.json:
        Path(a.json).write_text(json.dumps(res, indent=1) + "\n")


if __name__ == "__main__":
    main()
