#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""Rebuild the extra data the v3 graphs need, into data/v3.json (v1/v2 data untouched).

    QCR_BENCH_RUNS_DIR=<runs dir> uv run bench/aacr/showcase/refresh_v3.py

  prs        per AACR PR: its set (smoke10, dev10, holdout10, fresh10, rest145),
             language, category, repository and changed lines, from the sets files.
  per_pr     per reviewer (aacr-arms.txt and aacr-arms-v3.txt) and PR: list-price
             cost and wall-clock minutes, as compare.py prices and times them, so a
             chart can use the mean ("average"), the median or the distribution.
  credit     per-defect credit for the arms of aacr-arms-v3.txt only (the fast
             option), keyed "<pr>|<defect id>" — the other arms' credits are in
             data/aacr.json already.
  comment_grades  per v3 arm, as in data/aacr.json.
  official   each benchmark scored by ITS OWN metric, not our defect key:
             aacr     AACR-Bench's reference-comment matching (compare.aacr, the
                      paper's code path): precision / recall / F1 per AACR arm;
             martian  Martian's Core precision / recall / F1, the tools of
                      martian-sources.txt (one gpt-6.1-sol judge for every row).
             (Qodo's own rule is already in data/qodo.json.)
  ideas      what the idea-* figures need beyond data/aacr.json, one entry per
             figure (ideas_v3_data.py: a builder each, documented there).
"""
import argparse, collections, json, os, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
AACR = os.path.dirname(HERE)
sys.path.insert(0, AACR)
sys.path.insert(0, HERE)
import compare  # noqa: E402
from refresh import CREDIT, read_specs  # noqa: E402
from ideas_v3_data import IDEAS  # noqa: E402


def pr_meta(cases):
    out = {}
    for iid, (s, _, _) in cases.items():
        for c in json.load(open(os.path.join(AACR, "sets", f"{s}.json")))["cases"]:
            if c["instance_id"] == iid:
                out[iid] = {"set": s, "language": c.get("language"), "category": c.get("pr_category"),
                            "repo": c.get("repo"), "changed_lines": c.get("change_line_count")}
                break
    return out


def arm(runs_dir, runs, cases, judge_model, with_credit):
    per_pr, credit, grades = {}, {}, collections.Counter()
    for iid, (_, sevs, version) in cases.items():
        for run in runs:
            j = compare.judgement(runs_dir, run, iid, version, judge_model)
            if j is None:
                continue
            u, m = compare.usd_and_minutes(os.path.join(runs_dir, run, "cases", iid))
            per_pr[iid] = {"usd": u, "minutes": m}  # null = unpriced / untimed, never 0
            if with_credit:
                v = {x["id"]: x["verdict"] for x in j["defects"]}
                for did in sevs:
                    credit[f"{iid}|{did}"] = CREDIT.get(v.get(did, "missed"), 0.0)
                for c in j["comments"]:
                    grades[c["verdict"]] += 1
            break
    out = {"runs": runs, "per_pr": per_pr}
    if with_credit:
        out["credit"] = credit
        out["comment_grades"] = dict(grades)
    return out


def aacr_official(runs_dir, runs, cases):
    refs, generated, scored, _ = compare.aacr(runs_dir, runs, cases)
    if not scored:  # AACR's own scorer never ran on these runs: unknown, never zero
        return None
    labels = compare.ref_labels()
    total = sum(len(labels.get(iid, {})) for iid in cases) or len(refs)
    found = sum(refs.values())
    r, p, f1 = compare.prf(found, total, generated)
    return {"found": found, "references": total, "comments": generated, "prs_scored": len(scored),
            "precision": p, "recall": r, "f1": f1}


def martian_official(runs_dir, sources):
    out = {}
    for tool, (src,) in sources:
        run_dir, _, key = src.partition(":")
        d = json.load(open(os.path.join(runs_dir, run_dir, "martian-scores.json")))["this_run"]
        out[tool] = {"source": src, "judge": d["judge"], **d["scores"][key]["core"]}
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--runs-dir", default=os.environ.get("QCR_BENCH_RUNS_DIR"))
    ap.add_argument("--cases", default="all30+fresh10+rest145")
    ap.add_argument("--judge-model", default="gpt-6-sol-high")
    a = ap.parse_args()
    if not a.runs_dir or not os.path.isdir(a.runs_dir):
        sys.exit("set QCR_BENCH_RUNS_DIR (or --runs-dir) to the benchmark runs directory")
    cases = compare.cases_for(a.cases)
    base = read_specs(os.path.join(HERE, "aacr-arms.txt"))
    extra = read_specs(os.path.join(HERE, "aacr-arms-v3.txt"))
    out = {"generated": time.strftime("%Y-%m-%d"), "judge": a.judge_model, "cases_spec": a.cases,
           "prs": pr_meta(cases), "arms": {}}
    for tool, runs in base:
        out["arms"][tool] = arm(a.runs_dir, runs, cases, a.judge_model, with_credit=False)
    for tool, runs in extra:
        out["arms"][tool] = arm(a.runs_dir, runs, cases, a.judge_model, with_credit=True)
    out["official"] = {
        "aacr": {tool: aacr_official(a.runs_dir, runs, cases) for tool, runs in base + extra},
        "martian": martian_official(a.runs_dir, read_specs(os.path.join(HERE, "martian-sources.txt"))),
    }
    ctx = argparse.Namespace(runs_dir=a.runs_dir, data_root=os.path.dirname(os.path.abspath(a.runs_dir)),
                             cases=cases, judge_model=a.judge_model, arms=dict(base + extra), aacr=AACR, here=HERE)
    out["ideas"] = {}
    for name, build in IDEAS.items():
        t0 = time.time()
        out["ideas"][name] = build(ctx)
        print(f"built {name} in {time.time() - t0:.1f}s")
    path = os.path.join(HERE, "data", "v3.json")
    json.dump(out, open(path, "w"), indent=1, sort_keys=True)
    for tool, r in out["arms"].items():
        us = [x["usd"] for x in r["per_pr"].values() if x["usd"] is not None]
        ms = [x["minutes"] for x in r["per_pr"].values() if x["minutes"] is not None]
        got = f"  found {sum(r['credit'].values()):.1f}" if "credit" in r else ""
        print(f"{tool:22s} {len(r['per_pr'])} PRs  ${sum(us) / max(len(us), 1):.2f}/PR mean  "
              f"{sum(ms) / max(len(ms), 1):.1f} min mean{got}")
    for bench, rows in out["official"].items():
        for tool, r in rows.items():
            print(f"official {bench:8s} {tool:22s} " + ("not scored" if r is None else
                  f"P {r['precision']:.3f}  R {r['recall']:.3f}  F1 {r['f1']:.3f}"))
    print("wrote", os.path.relpath(path))


if __name__ == "__main__":
    main()
