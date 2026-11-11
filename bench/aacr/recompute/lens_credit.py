#!/usr/bin/env python3
"""Per-lens cost and credit of QuickReview's default on gpt-6-sol, from the run archive and the HF tables.

    python3 bench/aacr/recompute/lens_credit.py --archive <release>/archive --data <hf-dataset> \\
        [--arm quickreview-default-sol] [--work <scratch>] [--json OUT]

(`uv run --no-project --with pyarrow python ...` for the parquet tables.)

quickreview.tex §"Where the money goes" and tab:lenscost. For every judged review of the arm (the HF
`reviews` table names the run of each PR):
  cost      from the case's numbers-only extract `pi-events.pruned.jsonl`: the main session is every
            assistant message's recorded cost, a lens (or the validator) every subagent result's recorded
            cost under its agent name (`pass-<lens>--<tier>`, the tier dropped); shares of the run's total;
  credit    the primary judge's verdicts (`defect_verdicts`: verdict, `comment_ids`) against the comment
            list the judge saw, rebuilt as src/bench/defects.ts reviewForJudge does (C1.. over the non-empty
            rows of `results/all/<id>.json`, then the LEFT-side rows of `cases/<id>/comments.json`); a
            comment's lenses are its trailer's (`· lens pass-a, pass-b`), or, for one posted in the review
            body with no trailer, those of the posted finding at its site (`findings-record.json`). A defect the arm found or partly
            found is co-credited to every lens one of its crediting comments names (credit 1 or ½), and is
            UNIQUE to a lens when every crediting comment names that lens alone; `lenses_per_defect` counts,
            per credited defect (a partial find once), how many distinct lenses its comments name;
  validator the dispositions of every finding in `cases/<id>/findings-record.json` (posted, demoted,
            merged, killed, withheld, folded);
  misses    every key defect the arm missed outright (no credit), by what the review had at it: a posted
            comment within five lines of one of the defect's sites (credited to something else), else a
            finding at a site that was not posted (dropped), else a finding elsewhere in the defect's file,
            else nothing raised in the file.
No model call.
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from archive import iter_jsonl, open_archive, read_json, volumes_for  # noqa: E402
from tables import load_table  # noqa: E402
import lens_yield as LY  # noqa: E402  (bench/aacr/lens_yield.py: a case's root causes and their raisers)

JUDGE = "gpt-6-sol-high"
CREDIT = {"found": 1.0, "partial": 0.5}
TRAILER = re.compile(r"·\s*lens\s+([^\n]+?)_?\s*$", re.M)
TAG = re.compile(r"^\s*\[([a-z][a-z ]*)\]\s*", re.I)
FOOT = re.compile(r"\n*_P\d[^\n]*_\s*$")


def lens(agent: str) -> str:
    return agent.split("--")[0].removeprefix("pass-")


def trailer_lenses(text: str) -> frozenset:
    m = None
    for m in TRAILER.finditer(text or ""):
        pass
    if not m:
        return frozenset()
    return frozenset(lens(x) for x in re.findall(r"pass-[a-z][a-z-]*[a-z]", m.group(1)))


def judged_comments(case: Path, results: Path) -> list:
    """The comment list the judge saw: (id, lenses), C1.. as reviewForJudge numbers them. A comment with no
    lens trailer (a finding posted in the review body) takes the raisers of the posted root cause at its
    path within 3 lines (lens_yield.case_groups: the lead finding and every finding merged into it)."""
    rows_out = []
    rows = ((read_json(results).get("review") or {}).get("comments") if results.exists() else None) or []
    for r in rows:
        raw = r.get("content") if isinstance(r.get("content"), str) else ""
        if raw.strip():
            rows_out.append((raw, r.get("path"), r.get("start_line")))
    posted = read_json(case / "comments.json") if (case / "comments.json").exists() else []
    for r in posted if isinstance(posted, list) else []:
        if isinstance(r.get("side"), str) and r["side"].upper() == "LEFT":
            raw = r.get("body") if isinstance(r.get("body"), str) else ""
            if raw.strip():
                rows_out.append((raw, r.get("path"), r.get("line")))
    groups = None
    out = []
    for i, (raw, path, line) in enumerate(rows_out):
        names = trailer_lenses(raw)
        if not names and path is not None and line is not None:
            groups = LY.case_groups(case) if groups is None else groups
            near = [g for g in groups if g["posted"] and g["path"] == path and g["line"] is not None and abs(g["line"] - line) <= 3]
            if near:
                names = frozenset(lens(x) for x in min(near, key=lambda g: abs(g["line"] - line))["raisers"])
        out.append((f"C{i + 1}", names))
    return out


def case_cost(ev: Path) -> collections.Counter:
    cost = collections.Counter()
    for e in iter_jsonl(ev):
        if e.get("type") == "message_end" and (e.get("message") or {}).get("role") == "assistant":
            cost["main session"] += (((e["message"].get("usage") or {}).get("cost")) or {}).get("total") or 0
        elif e.get("type") == "tool_execution_end" and e.get("toolName") == "subagent":
            for r in ((e.get("result") or {}).get("details") or {}).get("results") or []:
                u = (r.get("usage") or {}).get("cost") or 0
                cost[lens(r.get("agent") or "?")] += u if isinstance(u, (int, float)) else (u.get("total") or 0)
    return cost


def _line(v):
    try:
        return int(str(v).split("-")[0])
    except (TypeError, ValueError):
        return None


def miss_class(root: Path, run: str, defect: dict, reviews) -> str:
    sites = [(s["path"], s.get("from_line") or 0, s.get("to_line") or s.get("from_line") or 0) for s in defect["sites"] or []]

    def near(path, line, k=5):
        return line is not None and any(path == p and f - k <= line <= t + k for p, f, t in sites)

    review = next(r for r in reviews if r["instance_id"] == defect["instance_id"])
    if any(near(c["path"], c["line"]) for c in review["comments"] or []):
        return "posted_near"
    case = root / "runs" / run / "cases" / defect["instance_id"]
    rec = read_json(case / "findings-record.json") if (case / "findings-record.json").exists() else {}
    found = [(f.get("path"), _line(f.get("line")), f.get("disposition")) for f in rec.get("findings") or []]
    if any(near(p, ln) and dsp not in ("posted", "downgraded") for p, ln, dsp in found):
        return "dropped_at_site"
    files = {p for p, _, _ in sites}
    return "elsewhere_in_file" if any(p in files for p, _, _ in found) else "nothing_in_file"


def compute(root: Path, data: str, arm: str) -> dict:
    reviews = [r for r in load_table(data, "reviews") if r["arm_id"] == arm and r["judged"]]
    sev = {(d["instance_id"], d["defect_id"]): d["severity"] for d in load_table(data, "defects")}
    verdicts = [v for v in load_table(data, "defect_verdicts") if v["arm_id"] == arm and v["judge"] == JUDGE]
    run_of = {r["instance_id"]: r["run"] for r in reviews}
    cost = collections.Counter()
    lenses_of = {}
    disp = collections.Counter()
    for iid, run in run_of.items():
        case = root / "runs" / run / "cases" / iid
        cost.update(case_cost(case / "pi-events.pruned.jsonl"))
        lenses_of[iid] = dict(judged_comments(case, root / "runs" / run / "results" / "all" / f"{iid}.json"))
        rec = read_json(case / "findings-record.json") if (case / "findings-record.json").exists() else {}
        for f in rec.get("findings") or []:
            disp[f.get("disposition") or "none"] += 1
    total = sum(cost.values())
    co, high, unique = collections.Counter(), collections.Counter(), collections.Counter()
    unique_sev = collections.defaultdict(collections.Counter)
    width = collections.Counter()
    credited = 0
    for v in verdicts:
        c = CREDIT.get(v["verdict"])
        if not c or v["instance_id"] not in lenses_of:
            continue
        credited += 1
        sets = [lenses_of[v["instance_id"]].get(cid, frozenset()) for cid in v["comment_ids"] or []]
        names = frozenset().union(*sets) if sets else frozenset()
        width[min(len(names), 6)] += 1
        for name in names:
            co[name] += c
            if sev[(v["instance_id"], v["defect_id"])] == "high":
                high[name] += c
        if len(names) == 1 and all(s == names for s in sets):
            unique[next(iter(names))] += c
            unique_sev[next(iter(names))][sev[(v["instance_id"], v["defect_id"])]] += c
    for name in set(cost) | set(co):  # a lens with no co-credit or unique find reads 0, not unknown
        if name != "main session":
            co[name] += 0
            high[name] += 0
            unique[name] += 0
            for sv in ("high", "medium", "low"):
                unique_sev[name][sv] += 0
    misses = collections.Counter()
    for d in load_table(data, "defects"):
        key = (d["instance_id"], d["defect_id"])
        if d["instance_id"] not in run_of or any(CREDIT.get(v["verdict"]) and (v["instance_id"], v["defect_id"]) == key for v in verdicts):
            continue
        misses[miss_class(root, run_of[d["instance_id"]], d, reviews)] += 1
    findings = sum(disp.values())
    return {"arm": arm, "prs": len(run_of), "usd_total": total,
            "cost_share": {k: 100 * v / total for k, v in cost.items()},
            "lens_share": 100 * sum(v for k, v in cost.items() if k not in ("main session", "validate")) / total,
            "credited_defects": credited, "co_credit": dict(co), "high": dict(high), "unique": dict(unique),
            "unique_by_severity": {k: dict(v) for k, v in unique_sev.items()},
            "lenses_per_defect": {("6+" if k == 6 else str(k)): v for k, v in sorted(width.items())},
            "validator": {"findings": findings, **dict(disp), "killed_pct": 100 * disp["killed"] / findings if findings else None},
            "misses": dict(misses)}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--archive", required=True)
    ap.add_argument("--data", required=True)
    ap.add_argument("--arm", default="quickreview-default-sol")
    ap.add_argument("--work", default=os.path.join(os.environ.get("TMPDIR", "."), "lens-credit"))
    ap.add_argument("--json")
    a = ap.parse_args()
    runs = {r["run"] for r in load_table(a.data, "reviews") if r["arm_id"] == a.arm and r["judged"]}
    root = open_archive(a.archive, a.work, volumes_for(load_table(a.data, "runs"), sorted(runs)))
    res = compute(root, a.data, a.arm)
    print(json.dumps(res, indent=1))
    if a.json:
        Path(a.json).write_text(json.dumps(res, indent=1) + "\n")


if __name__ == "__main__":
    main()
