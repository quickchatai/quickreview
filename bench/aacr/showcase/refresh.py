#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""Rebuild the showcase's generated data from the archived benchmark runs.

    QCR_BENCH_RUNS_DIR=<runs dir> uv run bench/aacr/showcase/refresh.py

Writes two files; make_charts.py reads them (and the hand-kept ones) and never
touches the runs:

  data/aacr.json   AACR defect benchmark, 185 PRs / 520 defects, the primary
                   judge. Every reviewer in aacr-arms.txt gets its per-defect
                   credit (1 found, 0.5 partly found, 0 missed — compare.py's
                   rule, so nothing here can disagree with the paper's tables),
                   its comment grades, cost and minutes. Every defect carries its
                   severity, kind and the PR's changed-line count, so a chart can
                   cut by any of them, or take unions and exclusive finds.
  data/qodo.json   Qodo PR-Review-Bench, 100 PRs / 580 issues: each tool's
                   scores.json row (all three location rules) as qodo_judge.py
                   wrote it, from the runs named in qodo-sources.txt.

Martian (data/martian.json) and the cost/time of the external runs
(data/manual.json) are kept by hand: their audited numbers are derived
elsewhere (martian_figs.py's martian-data.json, ext/RUNS.md) and each value
there names its source.
"""
import argparse, collections, json, os, statistics, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
AACR = os.path.dirname(HERE)
sys.path.insert(0, AACR)
import compare  # noqa: E402

CREDIT = {"found": 1.0, "partial": 0.5}


def read_specs(path):
    """`id=a,b,c` lines (comments and blanks skipped) -> [(id, [a, b, c])]."""
    out = []
    for ln in open(path):
        ln = ln.strip()
        if ln and not ln.startswith("#"):
            k, _, v = ln.partition("=")
            out.append((k.strip(), [x.strip() for x in v.split(",") if x.strip()]))
    return out


def changed_lines(runs_dir, arms, iid):
    """The PR's additions + deletions, from the first case summary that records its diff."""
    for _, runs in arms:
        for run in runs:
            p = os.path.join(runs_dir, run, "cases", iid, "case-summary.json")
            if os.path.exists(p):
                d = json.load(open(p)).get("diff") or {}
                if "additions" in d:
                    return d["additions"] + d.get("deletions", 0)
    return None


def aacr(runs_dir, arms, cases_spec, judge_model):
    cases = compare.cases_for(cases_spec)
    defects = []
    for iid, (s, sevs, _) in cases.items():
        truth = json.load(open(os.path.join(AACR, "defects", f"{s}.json")))["cases"][iid]
        size = changed_lines(runs_dir, arms, iid)
        for x in truth["defects"]:
            defects.append({"pr": iid, "id": x["id"], "severity": x["severity"], "kind": x.get("kind"),
                            "changed_lines": size, "credit": {}})
    by_key = {(d["pr"], d["id"]): d for d in defects}
    reviewers = {}
    for tool, runs in arms:
        grades, usd, mins, judged = collections.Counter(), [], [], 0
        for iid, (_, sevs, version) in cases.items():
            for run in runs:
                j = compare.judgement(runs_dir, run, iid, version, judge_model)
                if j is None:
                    continue
                judged += 1
                v = {x["id"]: x["verdict"] for x in j["defects"]}
                for did in sevs:
                    by_key[(iid, did)]["credit"][tool] = CREDIT.get(v.get(did, "missed"), 0.0)
                for c in j["comments"]:
                    grades[c["verdict"]] += 1
                u, m = compare.usd_and_minutes(os.path.join(runs_dir, run, "cases", iid))
                if u is not None:
                    usd.append(u)
                if m is not None:
                    mins.append(m)
                break
        reviewers[tool] = {
            "runs": runs, "prs_judged": judged, "comment_grades": dict(grades),
            "comments": sum(grades.values()),
            # An unpriced or untimed arm is unknown (null), never $0 or 0 minutes.
            "usd_mean": statistics.mean(usd) if usd else None,
            "usd_median": statistics.median(usd) if usd else None,
            "minutes_median": statistics.median(mins) if mins else None,
        }
    return {"benchmark": "AACR-Bench defect benchmark", "cases": len(cases), "cases_spec": cases_spec,
            "judge": judge_model, "defect_count": len(defects), "reviewers": reviewers, "defects": defects}


def qodo(runs_dir, sources):
    tools = {}
    for tool, (src,) in sources:
        run_dir, _, key = src.partition(":")
        d = json.load(open(os.path.join(runs_dir, run_dir, "scores.json")))
        tools[tool] = {"source": src, "prs": d["prs"], "issues": d["issues"], "rule_issues": d["rule_issues"],
                       "scores": d["scores"][key]}
    return {"benchmark": "Qodo PR-Review-Bench", "tools": tools}


def write_rows(path, obj, rows_key):
    """JSON with the big list one row per line, so a re-run's diff shows which defects moved."""
    head = {k: v for k, v in obj.items() if k != rows_key}
    text = json.dumps(head, indent=1, sort_keys=True)[:-2]
    rows = ",\n".join("  " + json.dumps(r, sort_keys=True) for r in obj[rows_key])
    open(path, "w").write(f'{text},\n "{rows_key}": [\n{rows}\n ]\n}}\n')


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--runs-dir", default=os.environ.get("QCR_BENCH_RUNS_DIR"))
    ap.add_argument("--cases", default="all30+fresh10+rest145")
    ap.add_argument("--judge-model", default="gpt-6-sol-high")
    a = ap.parse_args()
    if not a.runs_dir or not os.path.isdir(a.runs_dir):
        sys.exit("set QCR_BENCH_RUNS_DIR (or --runs-dir) to the benchmark runs directory")
    stamp = time.strftime("%Y-%m-%d")
    out = aacr(a.runs_dir, read_specs(os.path.join(HERE, "aacr-arms.txt")), a.cases, a.judge_model)
    out["generated"] = stamp
    write_rows(os.path.join(HERE, "data", "aacr.json"), out, "defects")
    q = qodo(a.runs_dir, read_specs(os.path.join(HERE, "qodo-sources.txt")))
    q["generated"] = stamp
    json.dump(q, open(os.path.join(HERE, "data", "qodo.json"), "w"), indent=1, sort_keys=True)
    # A one-screen check against the paper's tables.
    total = collections.Counter(d["severity"] for d in out["defects"])
    for tool, r in out["reviewers"].items():
        f = collections.Counter()
        for d in out["defects"]:
            f[d["severity"]] += d["credit"].get(tool, 0)
        usd = "?" if r["usd_mean"] is None else f"${r['usd_mean']:.2f}"
        print(f"{tool:22s} {sum(f.values()):6.1f}/{sum(total.values())}  high {f['high']:5.1f}/{total['high']}"
              f"  med {f['medium']:5.1f}  low {f['low']:5.1f}  {r['prs_judged']} PRs  {usd}/PR")
    for tool, t in q["tools"].items():
        s = t["scores"]["N=5"]
        print(f"qodo {tool:18s} R {s['recall']:.3f}  functional {s['recall_functional']:.3f}  F1 {s['f1']:.3f}")


if __name__ == "__main__":
    main()
