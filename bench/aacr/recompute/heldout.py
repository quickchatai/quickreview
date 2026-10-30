#!/usr/bin/env python3
"""The frozen build on the PRs kept out of its last tuning round, from the published tables.

    python3 bench/aacr/recompute/heldout.py --data <hf-dataset> [--json OUT]
    python3 bench/aacr/recompute/heldout.py --data <hf-dataset> --write-qodo-set   # regenerate sets/qodo-heldout31.json

(`uv run --no-project --with pyarrow python ...` when the tables are parquet.) No model call.
README.md "Tuning and held-out PRs" and benchmark.tex (Table tab:finalbuild, the Martian
audit, the Qodo caveats and "Development sets (disclosure)"):

AACR-Bench — holdout10 + fresh10 (sets/*.json), 20 PRs, 55 defects: the frozen build's
  found (partial ½) against every final-comparison arm, and its paired bootstrap lead over
  the default and the panel (the papers' bootstrap, aacr_bootstrap.py, over these 20 PRs).
Martian — test30 (sets/martian-test30.json; tune20 is sets/martian-tune20.json): real
  goldens found per tool under the gpt-6.1-sol judge. A golden is real when the audit put
  it in the `real` bucket (`martian_goldens.audit_bucket`); its half comes from the set
  files (`martian_goldens.audit_split` names the same half; the export fills it from the
  set files for the nine goldens the first audit round labelled).
Qodo — the 31 PRs in no mined or validation set: every PR of qodo-pr100 except
  (a) the PRs of the 59 "vendor-caught misses" — functional issues (no rule_name) that one
      of Qodo's nine published vendors matched and the 2026-10-02 build did not, by the
      judge's semantic match (`matched`, location not required): the misses the frozen
      build's changes were mined from;
  (b) the PRs of qodo-rules30, qodo-swift13, qodo-miss6, qodo-dv5, dedup5-qodo and
      qodo-smoke10, every Qodo set a decision was validated on.
  The set is committed as sets/qodo-heldout31.json; this script derives it again and fails
  when the two disagree. Scores use the benchmark's primary rule (qodo_judge.py, N=5): a
  hit is a semantic match whose comment lies within 5 lines of the issue; precision = hits
  / comments, recall = hits / issues, F1. The recall difference's interval is the papers'
  paired bootstrap over these 31 PRs (sorted URLs, Random(20261001), 10,000 resamples).
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sys
from typing import Dict, Iterable, List, Sequence

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import aacr_bootstrap as AB  # noqa: E402
from tables import load_table, percentile_ci  # noqa: E402

SETS = os.path.join(os.path.dirname(HERE), "sets")
QODO_VENDORS = ("qodo-exhaustive", "qodo-precise", "augment", "copilot", "cursor", "greptile",
                "codex", "coderabbit", "sentry")  # ext/qodo_judge.py VENDORS
QODO_VALIDATION_SETS = ("qodo-rules30", "qodo-swift13", "qodo-miss6", "qodo-dv5", "dedup5-qodo", "qodo-smoke10")
QODO_HELDOUT = "qodo-heldout31"
FROZEN_AACR, FROZEN_QODO, EARLIER_QODO = "quickreview-frozen", "quickreview-frozen", "quickreview-2026-10-02"
MARTIAN_JUDGE = QODO_JUDGE = "gpt-6.1-sol"


def set_cases(name: str, sets_dir: str = SETS) -> List[dict]:
    with open(os.path.join(sets_dir, f"{name}.json")) as f:
        return json.load(f)["cases"]


def set_urls(name: str, sets_dir: str = SETS) -> List[str]:
    return [c["pr_url"] for c in set_cases(name, sets_dir)]


# ---------------------------------------------------------------- AACR

def aacr(prs: Sequence[str], defects: List[dict], verdicts: List[dict], arms: Sequence[str],
         frozen: str = FROZEN_AACR, b: int = AB.RESAMPLES) -> dict:
    keep = sorted(prs)
    per = {a: AB.per_pr(keep, defects, verdicts, a) for a in arms}
    n = sum(v["recall"][1] for v in per[arms[0]].values())
    found = {a: sum(v["recall"][0] for v in per[a].values()) for a in arms}
    boot = AB.bootstrap(keep, defects, verdicts, arms, b=b)
    others = [a for a in arms if a != frozen]
    best = max(others, key=lambda a: found[a]) if others else None
    return {"prs": len(keep), "defects": n,
            "found": {a: {"found": found[a], "recall": 100 * found[a] / n if n else None} for a in arms},
            "next_best": best,
            "lead": {a: boot["pairs"]["recall"][f"{frozen} | {a}"] for a in others}}


# ---------------------------------------------------------------- Martian

def martian(goldens: List[dict], verdicts: List[dict], halves: Dict[str, Iterable[str]],
            judge: str = MARTIAN_JUDGE) -> dict:
    """Real goldens found per tool, overall and per half; `halves` maps a half's name to its PR urls."""
    half_of = {u: h for h, urls in halves.items() for u in urls}
    real = {(g["pr_url"], g["golden_index"]) for g in goldens if g.get("audit_bucket") == "real"}
    unplaced = sorted({u for u, _ in real if u not in half_of})
    if unplaced:
        raise SystemExit(f"real goldens on PRs in no half: {unplaced}")
    n = {h: sum(1 for u, _ in real if half_of[u] == h) for h in halves}
    hit: Dict[str, set] = {}
    for v in verdicts:
        if v["judge"] == judge and v["matched"] and (v["pr_url"], v["golden_index"]) in real:
            hit.setdefault(v["tool"], set()).add((v["pr_url"], v["golden_index"]))
    tools = sorted({v["tool"] for v in verdicts if v["judge"] == judge})
    return {"real": len(real), "real_by_half": n,
            "tools": {t: {"real_found": len(hit.get(t, ())),
                          **{h: sum(1 for u, _ in hit.get(t, ()) if half_of[u] == h) for h in halves}}
                      for t in tools}}


# ---------------------------------------------------------------- Qodo

def qodo_hits(verdicts: List[dict], judge: str = QODO_JUDGE):
    """(tool, pr, issue) -> (semantic match, primary-rule hit)."""
    out = {}
    for v in verdicts:
        if v["judge"] != judge:
            continue
        k = (v["tool"], v["pr_url"], v["issue_index"])
        m, h = out.get(k, (False, False))
        out[k] = (m or bool(v["matched"]), h or bool(v["matched"] and v["located_n5"]))
    return out


def qodo_heldout_urls(all_urls: Sequence[str], issues: List[dict], verdicts: List[dict],
                      excluded_sets: Iterable[Iterable[str]], earlier: str = EARLIER_QODO,
                      vendors: Sequence[str] = QODO_VENDORS) -> dict:
    hits = qodo_hits(verdicts)
    misses = sorted((i["pr_url"], i["issue_index"]) for i in issues if i["functional"]
                    and any(hits.get((t, i["pr_url"], i["issue_index"]), (False,))[0] for t in vendors)
                    and not hits.get((earlier, i["pr_url"], i["issue_index"]), (False,))[0])
    out = {u for u, _ in misses}
    for s in excluded_sets:
        out |= set(s)
    return {"vendor_caught_misses": len(misses), "miss_prs": len({u for u, _ in misses}),
            "kept": sorted(u for u in all_urls if u not in out)}


def qodo_score(urls: Iterable[str], tool: str, issues: List[dict], verdicts: List[dict], reviews: List[dict]) -> dict:
    keep = set(urls)
    hits = qodo_hits(verdicts)
    n = sum(1 for i in issues if i["pr_url"] in keep)
    tp = sum(1 for i in issues if i["pr_url"] in keep and hits.get((tool, i["pr_url"], i["issue_index"]), (0, 0))[1])
    rows = [r for r in reviews if r["tool"] == tool and r["pr_url"] in keep]
    if len({r["pr_url"] for r in rows}) != len(keep) or any(r.get("n_comments") is None for r in rows):
        return {"tool": tool, "issues": n, "hits": tp, "comments": None, "precision": None,
                "recall": 100 * tp / n if n else None, "f1": None}
    c = sum(r["n_comments"] for r in rows)
    p, r_ = (tp / c if c else 0.0), (tp / n if n else 0.0)
    return {"tool": tool, "issues": n, "hits": tp, "comments": c, "precision": 100 * p, "recall": 100 * r_,
            "f1": 100 * (2 * p * r_ / (p + r_) if p + r_ else 0.0)}


def qodo_paired(urls: Sequence[str], x: str, y: str, issues: List[dict], verdicts: List[dict],
                b: int = AB.RESAMPLES, seed: int = AB.SEED) -> dict:
    """x's recall minus y's, with the papers' paired bootstrap over the PRs (sorted)."""
    ids = sorted(urls)
    hits = qodo_hits(verdicts)
    per = {t: {u: (sum(1 for i in issues if i["pr_url"] == u and hits.get((t, u, i["issue_index"]), (0, 0))[1]),
                   sum(1 for i in issues if i["pr_url"] == u)) for u in ids} for t in (x, y)}

    def rec(t, s):
        return sum(per[t][u][0] for u in s) / max(sum(per[t][u][1] for u in s), 1)
    rng = random.Random(seed)
    samples = [[rng.choice(ids) for _ in ids] for _ in range(b)]
    lo, hi = percentile_ci([rec(x, s) - rec(y, s) for s in samples])
    return {"diff": 100 * (rec(x, ids) - rec(y, ids)), "lo": 100 * lo, "hi": 100 * hi}


def heldout_set_doc(cases: List[dict], derived: dict, pr100: dict) -> dict:
    return {
        "name": QODO_HELDOUT,
        "dataset": pr100["dataset"],
        "rule": ("Held-out check of the frozen build (2026-10-04): the qodo-pr100 PRs in no mined or validation set — "
                 "not the PRs of the vendor-caught misses (functional issues one of Qodo's nine published vendors matched "
                 "and the 2026-10-02 build did not, by the judge's semantic match; "
                 f"{derived['vendor_caught_misses']} issues on {derived['miss_prs']} PRs), and none of "
                 + ", ".join(QODO_VALIDATION_SETS) + ". Derived by bench/aacr/recompute/heldout.py from the published "
                 "qodo_issues and qodo_verdicts tables; never mined, never validated on."),
        "references": None,
        "backups": 0,
        "cases": cases,
    }


# ---------------------------------------------------------------- main

def render(res: dict) -> str:
    a, m, q = res["aacr"], res["martian"], res["qodo"]
    out = [f"AACR-Bench, holdout10 + fresh10: {a['prs']} PRs, {a['defects']:g} defects (partial ½)"]
    for t, v in sorted(a["found"].items(), key=lambda kv: -kv[1]["found"]):
        lead = a["lead"].get(t)
        out.append(f"  {t}: {v['found']:g} ({v['recall']:.0f}%)"
                   + (f"   frozen lead {lead['diff']:+.1f} [{lead['lo']:+.1f}, {lead['hi']:+.1f}]" if lead else ""))
    out.append(f"  next best: {a['next_best']}")
    out += ["", f"Martian, real goldens ({m['real']}; " + ", ".join(f"{h} {n}" for h, n in m["real_by_half"].items()) + ")"]
    for t, v in sorted(m["tools"].items(), key=lambda kv: -kv[1]["test30"]):
        out.append(f"  {t}: {v['real_found']} — test30 {v['test30']}, tune20 {v['tune20']}")
    out += ["", f"Qodo, {QODO_HELDOUT}: {len(q['set'])} PRs ({q['derived']['vendor_caught_misses']} vendor-caught misses "
                f"on {q['derived']['miss_prs']} PRs excluded, and {', '.join(QODO_VALIDATION_SETS)})"]
    for s in q["scores"].values():
        p = "unknown" if s["precision"] is None else f"{s['precision']:.1f}"
        f1 = "unknown" if s["f1"] is None else f"{s['f1']:.1f}"
        out.append(f"  {s['tool']}: {s['hits']}/{s['issues']} recall {s['recall']:.1f}  precision {p}  F1 {f1}")
    d = q["recall_gain"]
    out.append(f"  recall gain, frozen over the 2026-10-02 build: {d['diff']:+.1f} [{d['lo']:+.1f}, {d['hi']:+.1f}]")
    return "\n".join(out)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", required=True, help="the Hugging Face dataset dir (or its data/ dir)")
    ap.add_argument("--sets-dir", default=SETS)
    ap.add_argument("--aacr-arms", default=",".join(AB.DEFAULT_ARMS))
    ap.add_argument("--resamples", type=int, default=AB.RESAMPLES)
    ap.add_argument("--json", help="also write every number to this JSON file")
    ap.add_argument("--write-qodo-set", action="store_true",
                    help=f"(re)write sets/{QODO_HELDOUT}.json from the derivation instead of checking it")
    a = ap.parse_args()
    D, S = a.data, a.sets_dir

    # AACR
    keep = {c["instance_id"] for s in ("holdout10", "fresh10") for c in set_cases(s, S)}
    prs = sorted(r["instance_id"] for r in load_table(D, "prs") if r["instance_id"] in keep)
    if len(prs) != len(keep):
        sys.exit(f"prs table lacks {sorted(keep - set(prs))}")
    arms = [x for x in a.aacr_arms.split(",") if x]
    res = {"aacr": aacr(prs, load_table(D, "defects"), load_table(D, "defect_verdicts"), arms, b=a.resamples)}

    # Martian
    halves = {"test30": set_urls("martian-test30", S), "tune20": set_urls("martian-tune20", S)}
    res["martian"] = martian(load_table(D, "martian_goldens"), load_table(D, "martian_verdicts"), halves)

    # Qodo
    issues, qv, qr = load_table(D, "qodo_issues"), load_table(D, "qodo_verdicts"), load_table(D, "qodo_reviews")
    pr100 = json.load(open(os.path.join(S, "qodo-pr100.json")))
    derived = qodo_heldout_urls([c["pr_url"] for c in pr100["cases"]], issues, qv,
                                [set_urls(s, S) for s in QODO_VALIDATION_SETS])
    path = os.path.join(S, f"{QODO_HELDOUT}.json")
    if a.write_qodo_set:
        cases = [c for c in pr100["cases"] if c["pr_url"] in set(derived["kept"])]
        doc = heldout_set_doc(cases, derived, pr100)
        doc["references"] = sum(1 for i in issues if i["pr_url"] in set(derived["kept"]))
        with open(path, "w") as f:
            f.write(json.dumps(doc, indent=1, ensure_ascii=False) + "\n")
        print(f"wrote {path}: {len(cases)} PRs")
    committed = set_urls(QODO_HELDOUT, S)
    if sorted(committed) != derived["kept"]:
        sys.exit(f"sets/{QODO_HELDOUT}.json disagrees with the derivation: only committed "
                 f"{sorted(set(committed) - set(derived['kept']))}, only derived {sorted(set(derived['kept']) - set(committed))}")
    tools = [FROZEN_QODO, EARLIER_QODO, "qodo-exhaustive", "augment"]
    res["qodo"] = {"set": sorted(committed), "derived": {k: v for k, v in derived.items() if k != "kept"},
                   "scores": {t: qodo_score(committed, t, issues, qv, qr) for t in tools},
                   "recall_gain": qodo_paired(committed, FROZEN_QODO, EARLIER_QODO, issues, qv, b=a.resamples)}
    print(render(res))
    if a.json:
        with open(a.json, "w") as f:
            json.dump(res, f, indent=1)


if __name__ == "__main__":
    main()
