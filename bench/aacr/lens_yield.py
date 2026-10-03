#!/usr/bin/env python3
"""Per-lens yield over stored benchmark runs (docs/duplicate-merge.md, decision 10).

Analysis only: reads run dirs, their scoring, and the benchmarks' keys; runs no
review and no judge.

For every lens:
  raised      root causes the lens raised (the findings record's lead entries —
              every disposition but merged/folded — whose lens list names it)
  posted      posted comments whose trailer lists the lens
  unique      posted comments the lens raised ALONE (trailer lists only it)
  unique_real unique comments that are REAL by the benchmark's own key
  cost_usd    the lens's subagent cost (pi-events tool results, usage.cost)
  usd_per_unique_real

REAL, per benchmark (a posted comment, matched by the benchmark's judge):
  aacr     judge/<label>/<case>.r1.json: the comment carries a key `defect`
  martian  the comment's extracted candidate is a judge TP on a golden the
           audit rated real (bench/aacr/ext/martian-tuning/golden-audit-full.json)
  qodo     <run>.qodo/judgements.jsonl (pass 1): the comment credits an issue
  swepr    <run>.sweprbench eval_results (config A): the comment is in a matched pair

  lens_yield.py --runs-dir DIR --run KIND:RUN [--run KIND:RUN ...] [--json OUT]
"""
from __future__ import annotations

import argparse
import collections
import glob
import json
import os
import re
from pathlib import Path

TRAILER = re.compile(r"·\s*lens\s+([^\n]+?)_?\s*$", re.M)
TIER = re.compile(r"--(terra|sol|luna)[-a-z]*$")


def lenses_of_text(body: str) -> list[str]:
    m = None
    for m in TRAILER.finditer(body or ""):
        pass
    if not m:
        return []
    return sorted(set(re.findall(r"pass-[a-z][a-z-]*[a-z]", m.group(1))))


def lens_list(v) -> list[str]:
    text = " ".join(map(str, v)) if isinstance(v, list) else str(v or "")
    return sorted(set(re.findall(r"pass-[a-z][a-z-]*[a-z]", text)))


def read_json(p):
    try:
        return json.load(open(p))
    except Exception:
        return None


def case_raised(case: Path) -> list[list[str]]:
    rec = read_json(case / "findings-record.json") or {}
    roots = []
    for e in rec.get("findings") or []:
        if not isinstance(e, dict) or e.get("disposition") in ("merged", "folded"):
            continue
        ls = lens_list(e.get("lens"))
        if ls:
            roots.append(ls)
    return roots


def case_cost(case: Path) -> dict[str, float]:
    out: dict[str, float] = collections.defaultdict(float)
    p = case / "pi-events.jsonl"
    if not p.exists():
        return out
    for line in open(p, errors="replace"):
        if '"tool_execution_end"' not in line or "results" not in line:
            continue
        try:
            d = json.loads(line)
        except Exception:
            continue
        det = ((d.get("result") or {}).get("details") or {})
        for r in det.get("results") or []:
            agent = TIER.sub("", str(r.get("agent") or ""))
            u = r.get("usage") or {}
            c = u.get("cost")
            if isinstance(c, dict):
                c = c.get("total")
            if agent.startswith("pass-") and isinstance(c, (int, float)):
                out[agent] += float(c)
    return out


# ---- benchmark adapters: (case dir, [(lenses, real)]) -------------------------

def aacr_comments(runs: Path, run: str):
    jdirs = sorted(glob.glob(str(runs / run / "judge" / "*")))
    jdir = Path(jdirs[-1]) if jdirs else None
    for res in sorted(glob.glob(str(runs / run / "results" / "all" / "*.json"))):
        iid = Path(res).stem
        d = read_json(res) or {}
        comments = ((d.get("review") or {}).get("comments")) or []
        j = read_json(jdir / f"{iid}.r1.json") if jdir else None
        real_ids = {c.get("id") for c in (j or {}).get("comments", []) if c.get("defect")}
        out = [(lenses_of_text(c.get("content", "")), f"C{i + 1}" in real_ids) for i, c in enumerate(comments)]
        yield runs / run / "cases" / iid, out


def qodo_comments(runs: Path, run: str, set_file: Path):
    by_pr = {c["pr_url"]: c["instance_id"] for c in json.load(open(set_file))["cases"]}
    for line in open(runs / f"{run}.qodo" / "judgements.jsonl"):
        j = json.loads(line)
        if j.get("tool") != "quickreview" or j.get("pass", 1) != 1:
            continue
        matched = {m["comment"] for m in j.get("matches") or []}
        out = [(lenses_of_text(c.get("body", "")), i in matched) for i, c in enumerate(j.get("comments") or [])]
        yield runs / run / "cases" / by_pr[j["pr"]], out


def swepr_comments(runs: Path, run: str, set_file: Path):
    by_task = {c["task_id"]: c["instance_id"] for c in json.load(open(set_file))["cases"]}
    base = glob.glob(str(runs / f"{run}.sweprbench" / "runs" / "*"))[0]
    for a in sorted(glob.glob(f"{base}/agent_outputs/*config_A*")):
        ao = read_json(a) or {}
        t = ao.get("task_id")
        # The harness's own credit: matched_pairs after its alignment (the
        # judge's raw CONFIRMED labels are only its first pass).
        ev = read_json(a.replace("agent_outputs", "eval_results").replace("_agent.json", "_eval.json")) or {}
        conf = {p.get("agent_comment_id") for p in ev.get("matched_pairs") or []}
        out = [(lenses_of_text(c.get("body", "")), c.get("comment_id") in conf) for c in ao.get("comments") or []]
        yield runs / run / "cases" / by_task[t], out


def toks(s: str) -> set[str]:
    return set(re.findall(r"[a-z0-9_]{3,}", (s or "").lower()))


def martian_comments(runs: Path, run: str, audit: Path):
    real_golden = set()
    for a in json.load(open(audit)):
        f, s = a["first"]["verdict"], (a.get("second") or {}).get("verdict")
        REAL = {"REAL_DEFECT", "PARTLY_VALID"}
        if f in REAL and (s is None or s in REAL):
            real_golden.add((a["url"], a["golden"].strip()))
    res = runs / f"{run}.martian" / "results"
    cand = json.load(open(res / "gpt-6.1-sol" / "candidates.json"))
    ev = json.load(open(res / "gpt-6.1-sol" / "evaluations.json"))
    cases = {}
    for cd in glob.glob(str(runs / run / "cases" / "*")):
        cs = read_json(Path(cd) / "comments.json") or []
        cases[cd] = [(toks(c.get("body", "")), lenses_of_text(c.get("body", ""))) for c in cs]
    for pr, v in cand.items():
        qc = v.get("quickreview") or []
        e = (ev.get(pr) or {}).get("quickreview") or {}
        tp = collections.defaultdict(set)
        for t in e.get("true_positives") or []:
            tp[t["matched_candidate"].strip()].add(t["golden_comment"].strip())
        allt = toks(" ".join(c["text"] for c in qc))
        cd = max(cases, key=lambda k: len(allt & set().union(*[x[0] for x in cases[k]] or [set()])))
        items = cases[cd]
        real_idx = set()
        for c in qc:
            gs = tp.get(c["text"].strip(), set())
            if not any((pr, g) in real_golden for g in gs):
                continue
            ct = toks(c["text"])
            best = max(range(len(items)), key=lambda i: len(ct & items[i][0]) / max(1, len(ct | items[i][0])), default=None)
            if best is not None:
                real_idx.add(best)
        yield Path(cd), [(items[i][1], i in real_idx) for i in range(len(items))]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--runs-dir", default=os.environ.get("QCR_BENCH_RUNS_DIR", ""))
    ap.add_argument("--run", action="append", required=True, help="KIND:RUN, KIND in aacr|martian|qodo|swepr")
    ap.add_argument("--json")
    a = ap.parse_args()
    runs = Path(a.runs_dir)
    here = Path(__file__).resolve().parent
    stats = collections.defaultdict(lambda: collections.Counter())
    cost = collections.defaultdict(float)
    per_kind = collections.defaultdict(lambda: collections.defaultdict(collections.Counter))
    for spec in a.run:
        kind, run = spec.split(":", 1)
        if kind == "aacr":
            it = aacr_comments(runs, run)
        elif kind == "qodo":
            it = qodo_comments(runs, run, here / "sets" / "qodo-pr100.json")
        elif kind == "swepr":
            it = swepr_comments(runs, run, here / "sets" / "sweprbench-eval100.json")
        elif kind == "martian":
            it = martian_comments(runs, run, here / "ext" / "martian-tuning" / "golden-audit-full.json")
        else:
            raise SystemExit(f"unknown kind {kind}")
        for case, comments in it:
            for ls in case_raised(case):
                for l in ls:
                    stats[l]["raised"] += 1
                    per_kind[kind][l]["raised"] += 1
            for l, c in case_cost(case).items():
                cost[l] += c
                per_kind[kind][l]["cost_milli"] += int(c * 1000)
            for ls, real in comments:
                for l in ls:
                    stats[l]["posted"] += 1
                    per_kind[kind][l]["posted"] += 1
                if len(ls) == 1:
                    stats[ls[0]]["unique"] += 1
                    per_kind[kind][ls[0]]["unique"] += 1
                    if real:
                        stats[ls[0]]["unique_real"] += 1
                        per_kind[kind][ls[0]]["unique_real"] += 1
                if real:
                    for l in ls:
                        stats[l]["real"] += 1
                        per_kind[kind][l]["real"] += 1
    rows = []
    for l in sorted(set(stats) | set(cost)):
        s = stats[l]
        ur = s["unique_real"]
        rows.append({
            "lens": l, "raised": s["raised"], "posted": s["posted"], "real": s["real"],
            "unique": s["unique"], "unique_real": ur, "cost_usd": round(cost[l], 2),
            "usd_per_unique_real": round(cost[l] / ur, 2) if ur else None,
        })
    rows.sort(key=lambda r: (-r["unique_real"], -r["real"]))
    print("| lens | raised | posted | real | unique | unique real | cost $ | $ / unique real |")
    print("|---|---|---|---|---|---|---|---|")
    for r in rows:
        print(f"| {r['lens']} | {r['raised']} | {r['posted']} | {r['real']} | {r['unique']} | {r['unique_real']} | {r['cost_usd']} | {r['usd_per_unique_real'] if r['usd_per_unique_real'] is not None else '—'} |")
    if a.json:
        json.dump({"runs": a.run, "rows": rows,
                   "per_kind": {k: {l: dict(c) for l, c in v.items()} for k, v in per_kind.items()}},
                  open(a.json, "w"), indent=1)


if __name__ == "__main__":
    main()
