#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""Rebuild the data the v4 graphs need, into data/v4.json (v1-v3 data untouched).

    QCR_BENCH_RUNS_DIR=<runs dir> uv run bench/aacr/showcase/refresh_v4.py

v4 draws each benchmark the way its publisher draws it, with QuickReview added.
This file gathers the publishers' own numbers next to ours:

  martian  Martian's Code Review Bench, offline (50 PRs), exactly as its public
           leaderboard computes it: the dashboard file of the benchmark's repo
           snapshot (ext-data/martian-e616e84, offline/analysis/
           benchmark_dashboard.json) gives every listed tool's Core precision /
           recall / F1 / F2 under each of Martian's three judges; the judges'
           evaluations.json files give each tool's Core goldens matched by
           severity. QuickReview's row is the frozen build's Martian run
           (final1-martian50), graded by our gpt-6.1-sol judge, with Martian's
           own matcher and scorer. `calibration` holds the three tools graded
           by BOTH our judge and Martian's, so a chart can say which of
           Martian's judges ours tracks.

The runs directory is only read. Nothing here calls a model.
"""
import argparse, collections, json, os, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))

MARTIAN_SNAPSHOT = "ext-data/martian-e616e84/offline"  # under the runs directory's parent
MARTIAN_RUN = "final1-martian50.martian"  # QuickReview's frozen build, and the three re-judged tools
MARTIAN_JUDGES = {  # Martian's three judges, as its dashboard names them
    "openai_gpt-5.2": "GPT-5.2",
    "anthropic_claude-opus-4-5-20251101": "Claude Opus 4.5",
    "anthropic_claude-sonnet-4-5-20250929": "Claude Sonnet 4.5",
}
SEVERITIES = ["Critical", "High", "Medium", "Low"]
REJUDGED = {"rejudged-qodo-extended-v2": "qodo-extended-v2", "rejudged-cubic-v2": "cubic-v2",
            "rejudged-claude-code": "claude-code"}


def core_goldens(bench, core):
    """(pr url, golden text) -> severity, for the goldens of Martian's Core profile."""
    return {(u, g["comment"]): g.get("severity") for u, v in bench.items() for g in v["golden_comments"]
            if g.get("category") in core}


def matched_by_severity(evals, tool, goldens):
    n = collections.Counter()
    for u, per_tool in evals.items():
        for tp in ((per_tool.get(tool) or {}).get("true_positives") or []):
            sev = goldens.get((u, tp["golden_comment"]))
            if sev is not None:
                n[sev] += 1
    return {s: n[s] for s in SEVERITIES}


def row(m, by_sev, scale):
    """One tool's Core scores as fractions (the dashboard stores percents: scale 100)."""
    return {**{k: m[k] / scale for k in ("precision", "recall", "f1", "f2")},
            "tp": m["tp"], "fp": m["fp"], "fn": m["fn"], "by_severity": by_sev}


def martian(runs_dir, data_root):
    snap = os.path.join(data_root, MARTIAN_SNAPSHOT)
    dash = json.load(open(os.path.join(snap, "analysis", "benchmark_dashboard.json")))
    bench = json.load(open(os.path.join(snap, "results", "benchmark_data.json")))
    core = set(dash["profiles"]["core"]["categories"])
    goldens = core_goldens(bench, core)
    out = {"snapshot": MARTIAN_SNAPSHOT, "prs": len(bench), "profile": "core",
           "core_categories": sorted(core), "goldens": len(goldens),
           "goldens_by_severity": {s: sum(1 for v in goldens.values() if v == s) for s in SEVERITIES},
           "default_judge": dash["default_model"], "default_beta": dash["default_beta"],
           "display_names": dash["tool_display_names"], "judges": {}}
    for judge, label in MARTIAN_JUDGES.items():
        evals = json.load(open(os.path.join(snap, "results", judge, "evaluations.json")))
        tools = {}
        for t, m in dash["models"][judge]["overall_metrics"].items():
            r = row(m["core"], matched_by_severity(evals, t, goldens), 100)
            if sum(r["by_severity"].values()) != r["tp"]:  # our recount must be the dashboard's
                sys.exit(f"martian {judge} {t}: severity recount {sum(r['by_severity'].values())} != tp {r['tp']}")
            tools[t] = r
        out["judges"][judge] = {"label": label, "tools": tools}
    run = os.path.join(runs_dir, MARTIAN_RUN)
    ours = json.load(open(os.path.join(run, "martian-scores.json")))["this_run"]
    evals = json.load(open(os.path.join(run, "results", ours["judge"], "evaluations.json")))
    scored = {k: row(v["core"], matched_by_severity(evals, k, goldens), 1) for k, v in ours["scores"].items()}
    for k, r in scored.items():
        if sum(r["by_severity"].values()) != r["tp"]:
            sys.exit(f"martian {MARTIAN_RUN} {k}: severity recount != tp")
    out["quickreview"] = {"judge": ours["judge"], "run": MARTIAN_RUN.split(".")[0], **scored["quickreview"]}
    out["calibration"] = {tool: {"ours": scored[k], **{j: out["judges"][j]["tools"][tool] for j in MARTIAN_JUDGES}}
                          for k, tool in REJUDGED.items()}
    return out


BUILDERS = {"martian": martian}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--runs-dir", default=os.environ.get("QCR_BENCH_RUNS_DIR"))
    a = ap.parse_args()
    if not a.runs_dir or not os.path.isdir(a.runs_dir):
        sys.exit("set QCR_BENCH_RUNS_DIR (or --runs-dir) to the benchmark runs directory")
    data_root = os.path.dirname(os.path.abspath(a.runs_dir))
    out = {"generated": time.strftime("%Y-%m-%d")}
    for name, build in BUILDERS.items():
        out[name] = build(a.runs_dir, data_root)
        print("built", name)
    path = os.path.join(HERE, "data", "v4.json")
    json.dump(out, open(path, "w"), indent=1, sort_keys=True)
    m = out["martian"]
    for j, b in m["judges"].items():
        top = max(b["tools"].items(), key=lambda kv: kv[1]["recall"])
        print(f"martian {b['label']:18s} {len(b['tools'])} tools; top recall {top[0]} {top[1]['recall']:.3f}")
    q = m["quickreview"]
    print(f"martian QuickReview ({q['judge']}): P {q['precision']:.3f}  R {q['recall']:.3f}  F2 {q['f2']:.3f}")
    print("wrote", os.path.relpath(path))


if __name__ == "__main__":
    main()
