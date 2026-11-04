#!/usr/bin/env python3
"""Refit a pairwise Elo run's ratings from its published judgments alone.

    python3 bench/aacr/recompute/elo_ratings.py <elo run dir> [--json OUT] [--chart-json OUT]
        [--runs-dir DIR ...] [--check-ratings]

`<elo run dir>` is one plan's directory as the run archive ships it (e.g.
`elo/martian-hard20-all-gpt`): `plan.json`, `units.jsonl` and
`judgments/<judge>.jsonl`. The archive leaves out `packs/` (whole files of the
reviewed repositories; `elo.py pack` regenerates them), so `elo.py report`,
which re-derives each unit's current prompt hash from the packs, cannot run on
it. This script reads only what ships and fits with the same code
(`bench/aacr/elo/elo_rating.py`, the plan's seed):

  - the rated judges are the plan's own (`judges`, in its order: gpt and opus
    for the published runs; elo_rating.rated_judges), so a third judge named
    in a plan is rated beside them with no code change;
  - a unit's CURRENT prompt is the prompt hash of its most recent `ok`
    judgment over the rated judges (every judge gets the identical prompt); a
    judgment at any other hash is stale, as `elo.py report` sets aside a
    judgment whose prompt changed since. Each judge's judgment of a unit is
    then its first `ok` row at the current hash (`Run.final`);
  - per judge, its table; the judges' agreement on the overall winner (per
    pair when there are more than two); and the "Combined" table, every unit
    every judge answered counted once per judge (`cmd_report`'s pooling), with
    every pair's gap interval and direct record.

With --check-ratings it compares the refit with the `ratings.json` the run's
`elo.py report` wrote and fails on any difference. With --runs-dir (the run
archive's runs/ dirs; repeatable) it also prices each configuration's reviews
of the plan's PRs (compare.py usd_and_minutes: mean and median $ per PR).
--chart-json writes the small file the README's Elo chart reads
(bench/aacr/showcase/data/elo-martian-hard20.json).
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
from typing import Dict, List, Optional, Sequence

HERE = os.path.dirname(os.path.abspath(__file__))
AACR = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(AACR, "elo"))
import elo_rating as R  # noqa: E402

CATEGORIES = ("recall", "precision", "finding_quality", "writing")  # elo_judge.CATEGORIES
SCORE = {"A": 1.0, "B": 0.0, "tie": 0.5}


def read_jsonl(path: str) -> List[dict]:
    if not os.path.exists(path):
        return []
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


def current_hashes(judgments: Dict[str, List[dict]]) -> Dict[str, str]:
    """unit id -> the prompt hash of its most recent ok judgment over every judge."""
    latest: Dict[str, dict] = {}
    for rows in judgments.values():
        for r in rows:
            if r.get("status") == "ok" and (r["id"] not in latest or r["at"] > latest[r["id"]]["at"]):
                latest[r["id"]] = r
    return {i: r["prompt_sha256"] for i, r in latest.items()}


def finals(judgments: Dict[str, List[dict]]) -> Dict[str, Dict[str, dict]]:
    """judge -> unit id -> its first ok judgment at the unit's current hash; and the stale count."""
    cur = current_hashes(judgments)
    out: Dict[str, Dict[str, dict]] = {}
    for j, rows in judgments.items():
        out[j] = {}
        for r in rows:
            if r.get("status") == "ok" and r.get("prompt_sha256") == cur.get(r["id"]) and r["id"] not in out[j]:
                out[j][r["id"]] = r
    return out


def stale_count(judgments: Dict[str, List[dict]]) -> Dict[str, int]:
    cur = current_hashes(judgments)
    return {j: sum(1 for r in rows if r.get("status") == "ok" and r.get("prompt_sha256") != cur.get(r["id"]))
            for j, rows in judgments.items()}


def games(final: Dict[str, dict], category: Optional[str] = None) -> List[tuple]:
    out = []
    for row in final.values():
        v = row["verdict"]
        w = (v["categories"][category] if category else v["overall"])["winner"]
        out.append((row["pr"], row["a"], row["b"], SCORE[w]))
    return out


def ratings(plan: dict, judgments: Dict[str, List[dict]]) -> dict:
    """The `ratings.json` structure elo.py report writes, refit from the judgments."""
    runs, seed = plan["runs"], int(plan.get("seed", 1))
    judges = R.rated_judges(plan)
    fin = finals(judgments)
    out: Dict[str, dict] = {}
    for j in judges:
        if not fin.get(j):
            continue
        out[j] = {"overall": R.table(runs, games(fin[j]), seed=seed),
                  "categories": {c: R.table(runs, games(fin[j], c), seed=seed) for c in CATEGORIES}}
    if len(judges) > 1 and all(fin.get(j) for j in judges):
        ag = R.judge_agreement(fin, judges, CATEGORIES)
        if ag:
            out["agreement"] = ag
        out["combined"] = {"overall": R.table(runs, R.pooled_games(fin, judges), seed=seed),
                           "categories": {c: R.table(runs, R.pooled_games(fin, judges, c), seed=seed)
                                          for c in CATEGORIES}}
    return out


def _same(a, b, path="") -> List[str]:
    """Differences between two JSON-like values (floats to 1e-9; NaN equals NaN)."""
    if isinstance(a, dict) and isinstance(b, dict):
        diffs = [f"{path}.{k}: only in {'refit' if k in a else 'ratings.json'}" for k in set(a) ^ set(b)]
        for k in set(a) & set(b):
            diffs += _same(a[k], b[k], f"{path}.{k}")
        return diffs
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            return [f"{path}: {len(a)} items against {len(b)}"]
        return [d for i, (x, y) in enumerate(zip(a, b)) for d in _same(x, y, f"{path}[{i}]")]
    if isinstance(a, float) or isinstance(b, float):
        if a != a and b != b:
            return []
        return [] if abs(float(a) - float(b)) <= 1e-9 else [f"{path}: {a} against {b}"]
    return [] if a == b else [f"{path}: {a!r} against {b!r}"]


def costs(plan: dict, runs_dirs: Sequence[str]) -> Dict[str, Optional[dict]]:
    """Per configuration, list price of its reviews of the plan's PRs (compare.py usd_and_minutes)."""
    sys.path.insert(0, AACR)
    import compare as C  # noqa: E402

    out: Dict[str, Optional[dict]] = {}
    for run in plan["runs"]:
        base = next((d for d in runs_dirs if os.path.isdir(os.path.join(d, run, "cases"))), None)
        if base is None:
            out[run] = None
            continue
        usd = [C.usd_and_minutes(os.path.join(base, run, "cases", pr))[0] for pr in plan["prs"]
               if os.path.isdir(os.path.join(base, run, "cases", pr))]
        priced = [u for u in usd if u is not None]
        out[run] = {"prs": len(usd), "priced": len(priced),
                    "usd_mean": statistics.mean(priced) if priced else None,
                    "usd_median": statistics.median(priced) if priced else None}
    return out


def chart(plan: dict, rat: dict) -> dict:
    t = rat["combined"]["overall"]
    labels = plan.get("labels") or {}
    return {
        "source": f"elo/{plan['name']} (refit by bench/aacr/recompute/elo_ratings.py; both judges pooled)",
        "games": t["games"], "prs": t["prs"],
        "agreement_overall": rat["agreement"]["overall"]["same_rate"],  # a two-judge plan's
        "rows": [{"run": r["player"], "label": labels.get(r["player"], r["player"]), "elo": r["elo"],
                  "lo": r["lo"], "hi": r["hi"], "w": r["w"], "t": r["t"], "l": r["l"]} for r in t["rows"]],
        "pairs": [{"upper": g["upper"], "lower": g["lower"], "gap": g["gap"], "lo": g["lo"], "hi": g["hi"],
                   "direct": g["direct"]} for g in t["pairs"]],
    }


def render(plan: dict, rat: dict, fin_counts: Dict[str, int], stale: Dict[str, int]) -> str:
    labels = plan.get("labels") or {}
    out = [f"Pairwise Elo — {plan['name']}: " + ", ".join(f"{j} {fin_counts[j]} judgments ({stale.get(j, 0)} stale)"
                                                          for j in fin_counts)]
    judges = R.rated_judges(plan)
    if "agreement" in rat:
        pairs = {f"{judges[0]}|{judges[1]}": rat["agreement"]} if len(judges) == 2 else rat["agreement"]
        for pair, per in pairs.items():
            ag = per["overall"]
            who = "Judges" if len(judges) == 2 else f"Judges {pair.replace('|', ' and ')}"
            out.append(f"{who} pick the same overall winner on {ag['same']} of {ag['n']} units ({ag['same_rate']:.0%}).")
    for key in [j for j in judges if j in rat] + (["combined"] if "combined" in rat else []):
        t = rat[key]["overall"]
        out += ["", f"{key}: {t['games']} games over {t['prs']} PRs", "| configuration | Elo | 95% CI | W-T-L |",
                "|---|---:|---|---|"]
        for r in t["rows"]:
            out.append(f"| {labels.get(r['player'], r['player'])} | {r['elo']:.0f} | {r['lo']:.0f} – {r['hi']:.0f} | "
                       f"{r['w']}-{r['t']}-{r['l']} |")
    if "combined" in rat:
        out += ["", "combined, every pair (upper over lower): gap [95% CI], direct W-T-L"]
        for g in rat["combined"]["overall"]["pairs"]:
            d = g["direct"]
            out.append(f"  {labels.get(g['upper'], g['upper'])} over {labels.get(g['lower'], g['lower'])}: "
                       f"+{g['gap']:.0f} [{g['lo']:+.0f}, {g['hi']:+.0f}], {d['w']}-{d['t']}-{d['l']}")
    return "\n".join(out)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dir", help="one Elo plan's run directory (plan.json, units.jsonl, judgments/)")
    ap.add_argument("--json", help="write the refit ratings (ratings.json's structure) and costs here")
    ap.add_argument("--chart-json", help="write the README chart's data file here")
    ap.add_argument("--check-ratings", action="store_true", help="fail unless the refit equals the dir's ratings.json")
    ap.add_argument("--runs-dir", action="append", default=[], help="a runs/ dir holding the plan's review runs")
    a = ap.parse_args()
    with open(os.path.join(a.dir, "plan.json")) as f:
        plan = json.load(f)
    judges = R.rated_judges(plan)
    judgments = {j: read_jsonl(os.path.join(a.dir, "judgments", f"{j}.jsonl")) for j in judges}
    if not any(judgments.values()):
        sys.exit(f"{a.dir}: no judgments/{{{','.join(judges)}}}.jsonl")
    rat = ratings(plan, judgments)
    fin = finals(judgments)
    print(render(plan, rat, {j: len(v) for j, v in fin.items()}, stale_count(judgments)))
    res = {"ratings": rat}
    if a.runs_dir:
        res["costs"] = costs(plan, a.runs_dir)
        print("\n$ per PR (list price), mean / median over the plan's PRs:")
        for run, c in res["costs"].items():
            print(f"  {run}: " + ("unknown (no run dir)" if c is None or c["usd_mean"] is None else
                                  f"{c['usd_mean']:.2f} / {c['usd_median']:.2f} ({c['priced']} of {c['prs']} priced)"))
    if a.check_ratings:
        with open(os.path.join(a.dir, "ratings.json")) as f:
            diffs = _same(json.loads(json.dumps(rat)), json.load(f))
        if diffs:
            sys.exit("refit differs from ratings.json:\n  " + "\n  ".join(sorted(diffs)[:40]))
        print("\nrefit == ratings.json")
    if a.json:
        with open(a.json, "w") as f:
            json.dump(res, f, indent=1)
    if a.chart_json:
        with open(a.chart_json, "w") as f:
            f.write(json.dumps(chart(plan, rat), indent=1) + "\n")


if __name__ == "__main__":
    main()
