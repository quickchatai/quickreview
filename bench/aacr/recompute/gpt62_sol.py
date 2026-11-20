#!/usr/bin/env python3
"""The dataset's GPT-6.2 Sol comparison: `gpt62_sol/`, built, checked and recomputed. No model call.

    uv run --no-project --with pyarrow python bench/aacr/recompute/gpt62_sol.py --data <hf-dataset> [--json OUT]
    uv run --no-project --with pyarrow python bench/aacr/recompute/gpt62_sol.py build --runs-dir <runs> \\
        --elo-dir <elo> --data <hf-dataset> --repo <checkout> --out <dir>/gpt62_sol

The comparison puts QuickReview 1.6.0 on GPT-6.2 Sol with its quiet default on (`s62`) beside the build
frozen on 2026-10-04 on GPT-6.1 Sol with no quiet default (`final1`, the dataset's arm `quickreview-frozen`),
on all 185 AACR-Bench pull requests. It has two parts:

  - the answer key: s62's posted comments and the defect judge's verdicts on them (gpt-6.1-sol at high),
    beside final1's published ones (gpt-6-sol at high), which the dataset's tables already hold (`reviews`,
    `defect_verdicts`, `comment_verdicts` of `quickreview-frozen`, runs final1-*) and this folder does not
    repeat;
  - pairwise Elo: two judges (gpt-6.1-sol and deepseek-v4.1-flash, both at xhigh) read both reviews of a
    pull request and pick the better one per category, every pair in both A/B orders, over four plans
    (PLANS). Every attempt is in `elo_judgments`; the ratings are a Bradley-Terry fit per judge over every
    plan it judged, and one pooled with each judge weighted the same (the pooled report's rule: a judge's games
    repeat so every judge contributes the same number of games per unit judged).

checks() is what the export's validation.json and the claims verifier's release checks hold for it:

  - every file of `gpt62_sol/` is the committed manifest's (bench/aacr/hf/gpt62-sol.sha256);
  - every table has exactly its listed columns;
  - the rows are whole (whole_problems): s62 reviewed and was judged on the pull requests final1 has in
    the dataset, against the dataset's answer key at its version; every judged comment is a posted one;
    every Elo judgment is of a unit of its plan, between s62 and final1, numbered in its file's order;
  - README.md is readme() of numbers();
  - `elo_ratings`, `elo_gaps` and the `used_in_ratings` flags are the refit of `elo_judgments` (refit());
  - every number the write-up prints (POST), recomputed from the folder and the dataset's tables.

claim_metrics.Gpt62Sol gives numbers() by name to the claims verifier (`gpt62_sol` keys). Tables are
`.parquet` or `.jsonl` (the tests' fixtures).
"""
from __future__ import annotations

import argparse
import collections
import glob
import hashlib
import json
import math
import os
import re
import shutil
import statistics
import subprocess
import sys
from typing import Dict, List, Optional

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from tables import data_dir_of, load_table  # noqa: E402
import elo_ratings as ER  # noqa: E402  (its path holds bench/aacr/elo, for elo_rating)
import elo_rating as R  # noqa: E402

FOLDER = "gpt62_sol"
MANIFEST = os.path.join(os.path.dirname(HERE), "hf", "gpt62-sol.sha256")
SETS = ("smoke10", "dev10", "holdout10", "fresh10", "rest145")
NEW, OLD = "s62", "final1"
ARMS = (NEW, OLD)
OLD_ARM = "quickreview-frozen"  # final1 in the dataset's tables
NEW_JUDGE_DIR = "gpt-6.1-sol-high"  # the run dirs' judge/v<key version>-<label>/ for s62
# the four Elo plans, in the order the pooled report reads them
PLANS = ("aacr185-sol62-vs-final1", "aacr185-sol62-vs-final1-swap", "aacr185-sol62-vs-final1-ds3",
         "aacr185-sol62-vs-final1-ds4")
ROLES = {PLANS[0]: "pass 1: random A/B order, both judges",
         PLANS[1]: "pass 2: every unit of pass 1 with A and B swapped, both judges",
         PLANS[2]: "deepseek pass 3: the units of pass 1 again, same order",
         PLANS[3]: "deepseek pass 4: the units of pass 2 again, same order"}
# the plan keys the folder keeps; the rest (where the repositories and judges ran) are the operator's
PLAN_KEYS = ("benchmark", "sets", "runs", "max_prompt_tokens", "round0_prs", "per_pair_step", "cap", "seed", "note")
JUDGE_KEYS = ("model", "effort", "max_tokens", "timeout_s")
# a judgment file whose failed attempts were moved out before re-judging keeps the whole first file beside it
SET_ASIDE_SUFFIX = ".jsonl.pass1-with-errors.bak"
CATEGORIES = ER.CATEGORIES
SCOPES = ("gpt", "deepseek", "combined")
REPS = 2000  # the pooled report's bootstrap replicates (seed 1, elo_rating.table's)
NOT_CORRECT = ("incorrect", "partly-correct", "unverifiable")
SEVERITIES = ("high", "medium", "low")
# Where an image's pi came from when it is not the release its version names: the image's `qcr.pi.main` label
# (the pi main commit its pi packages were rebuilt from). s62's image runs pi rebuilt from main, which lists
# GPT-6.2 Sol, and reports itself as the release it was cut after, so the run's recorded `pi` alone does not
# say what ran. build() checks the label against this where the image is still on the machine.
PI_MAIN = {"sha256:0224d9578ad8afa4d027d603b1e3257c033f5a4d95be1bcca9c520d120eb3f42":
           "1e34c3b4c7df78e716a8f53ad0bcf3a00feceedc"}

TABLES: Dict[str, tuple] = {
    "arms": ("arm_id", "display_name", "dataset_arm", "image", "image_id", "config", "profile", "qcr_commit",
             "qcr_commit_on_public_main", "qcr_commit_match", "qcr_commit_dirty", "pi", "pi_source", "engine",
             "reviewer_model", "judge", "runs", "prs", "note"),
    "cases": ("arm_id", "instance_id", "set", "run", "status", "verdict", "usd", "minutes", "n_posted", "judged",
              "judge_input_tokens", "judge_output_tokens", "judge_cache_read_tokens"),
    "reviews": ("arm_id", "instance_id", "index", "inline", "path", "line", "side", "body", "comment_id"),
    "defect_verdicts": ("arm_id", "instance_id", "judge", "key_version", "defect_id", "verdict", "credit",
                        "comment_ids", "why"),
    "comment_verdicts": ("arm_id", "instance_id", "judge", "comment_id", "index", "grade", "defect_id", "new_defect",
                         "why"),
    "elo_plans": ("plan", "order", "role", "benchmark", "sets", "runs", "labels", "judges", "max_prompt_tokens",
                  "round0_prs", "per_pair_step", "cap", "seed", "note"),
    "elo_units": ("plan", "unit_id", "round", "pr", "a", "b"),
    "elo_judgments": ("plan", "judgment_file", "line", "set_aside", "unit_id", "round", "pr", "a", "b", "judge",
                      "judge_model", "effort", "at", "status", "prompt_sha256", "used_in_ratings", "turns",
                      "finish_reason", "http_attempts", "error", "raw", "input_tokens", "output_tokens",
                      "cached_tokens", "reasoning_tokens", "overall_winner", "overall_explanation",
                      "recall_winner", "recall_reasoning", "precision_winner", "precision_reasoning",
                      "finding_quality_winner", "finding_quality_reasoning", "writing_winner", "writing_reasoning"),
    "elo_ratings": ("scope", "category", "run", "label", "elo", "lo", "hi", "w", "t", "l", "games", "prs"),
    "elo_gaps": ("scope", "category", "upper", "lower", "gap", "lo", "hi", "separated", "p_win", "direct_w",
                 "direct_t", "direct_l", "games", "prs"),
}

# The numbers the write-up prints, each recomputed by numbers() (checks() compares). Elo is the gap of s62
# over final1 (negative: final1 ahead) with its 95% interval, rounded to whole Elo as the write-up prints
# them; shares are whole percentages, comments per PR one decimal, dollars cents, minutes one decimal.
POST: Dict[str, object] = {
    "prs": 185,
    "answer_key": {"defects": 520, "high": 90, "medium": 145, "low": 285,
                   NEW: {"all": 435.5, "high": 87.0, "medium": 135.0, "low": 213.5},
                   OLD: {"all": 461.0, "high": 87.5, "medium": 134.5, "low": 239.0}},
    "comments": {NEW: {"judged": 1501, "on_key": 499, "not_correct": 176, "not_correct_pct": 12, "per_pr": 8.1},
                 OLD: {"judged": 1278, "on_key": 507, "not_correct": 97, "not_correct_pct": 8, "per_pr": 6.9}},
    "cost": {NEW: {"usd_per_pr": 3.25, "minutes_median": 11.0}, OLD: {"usd_per_pr": 2.06, "minutes_median": 17.5}},
    "elo": {"gpt": {"overall": [37, -9, 82], "recall": [163, 122, 206], "precision": [-64, -105, -22],
                    "finding_quality": [-86, -122, -51], "writing": [-98, -140, -58]},
            "deepseek": {"overall": [-77, -122, -34], "recall": [68, 25, 111], "precision": [-145, -185, -107],
                         "finding_quality": [-68, -106, -33], "writing": [-113, -149, -79]},
            "combined": {"overall": [-17, -53, 18], "recall": [115, 78, 152], "precision": [-101, -139, -64],
                         "finding_quality": [-78, -111, -48], "writing": [-105, -142, -69]}},
    "elo_games": {"gpt": {"games": 370, "prs": 185}, "deepseek": {"games": 680, "prs": 180, "prs_never": 5},
                  "combined": {"games": 1420, "prs": 185}},
    "position": {"gpt": {"a_wins": 149, "decided": 349, "ties": 21, "b_pct": 57},
                 "deepseek": {"a_wins": 336, "decided": 662, "ties": 18, "a_pct": 51}},
    "order": {"gpt": {"pairs": 185, "same": 149, "flipped": 25, "with_tie": 11},
              "deepseek": {"pairs": 653, "same": 506, "flipped": 121, "with_tie": 26}},
    "agreement": {"units": 354, "same": 219, "opposite": 120, "one_tie": 15},
    "attempts": {"gpt": {"total": 370, "ok": 370, "not_ok": 0},
                 "deepseek": {"total": 991, "ok": 680, "not_ok": 311, "set_aside": 79}},
}


# ---------------------------------------------------------------------------------------------------- reading

def root_of(path: str) -> str:
    """The dataset root of a dataset dir, its data/ dir or the folder: the dir that holds data/ and gpt62_sol/."""
    p = os.path.abspath(path)
    if os.path.basename(p) == FOLDER:
        return os.path.dirname(p)
    d = os.path.abspath(data_dir_of(p))
    return os.path.dirname(d) if os.path.basename(d) == "data" else d


def folder_of(path: str) -> str:
    return os.path.join(root_of(path), FOLDER)


def read_manifest(path: str = MANIFEST) -> Dict[str, str]:
    """{path relative to the dataset root: sha256} from a `sha256sum` file."""
    out: Dict[str, str] = {}
    with open(path) as f:
        for line in f:
            if line.strip():
                sha, _, rel = line.rstrip("\n").partition("  ")
                out[rel.lstrip("*")] = sha
    return out


def manifest_problems(folder: str, manifest: Dict[str, str]) -> Dict[str, List[str]]:
    """The files of a `gpt62_sol` folder against the manifest: missing, extra and differing, each sorted."""
    have: Dict[str, str] = {}
    if os.path.isdir(folder):
        for root, _, files in os.walk(folder):
            for f in files:
                p = os.path.join(root, f)
                with open(p, "rb") as fh:
                    have[FOLDER + "/" + os.path.relpath(p, folder).replace(os.sep, "/")] = hashlib.sha256(fh.read()).hexdigest()
    return {"missing": sorted(set(manifest) - set(have)), "extra": sorted(set(have) - set(manifest)),
            "differs": sorted(p for p in set(have) & set(manifest) if have[p] != manifest[p])}


def write_manifest(root: str, path: str) -> None:
    """A `sha256sum` manifest of a dataset root's gpt62_sol/ (paths relative to the root), sorted."""
    rows = []
    for d, _, files in os.walk(os.path.join(root, FOLDER)):
        for f in files:
            p = os.path.join(d, f)
            with open(p, "rb") as fh:
                rows.append((os.path.relpath(p, root).replace(os.sep, "/"), hashlib.sha256(fh.read()).hexdigest()))
    with open(path, "w") as f:
        f.write("".join(f"{sha}  {rel}\n" for rel, sha in sorted(rows)))


def columns_of(d: str, name: str) -> List[str]:
    pq_path = os.path.join(d, f"{name}.parquet")
    if os.path.exists(pq_path):
        import pyarrow.parquet as pq
        return list(pq.read_schema(pq_path).names)
    cols: Dict[str, None] = {}
    for r in load_table(d, name):
        cols.update(dict.fromkeys(r))
    return list(cols)


def file_rows(root: str) -> List[tuple]:
    """(path under the dataset root, rows) of every table of the folder present."""
    folder = folder_of(root)
    out = []
    for t in TABLES:
        if os.path.exists(os.path.join(folder, f"{t}.parquet")):
            import pyarrow.parquet as pq
            out.append((f"{FOLDER}/{t}.parquet", pq.ParquetFile(os.path.join(folder, f"{t}.parquet")).metadata.num_rows))
        elif os.path.exists(os.path.join(folder, f"{t}.jsonl")):
            out.append((f"{FOLDER}/{t}.jsonl", len(load_table(folder, t))))
    return out


def tables_of(path: str) -> Dict[str, List[dict]]:
    """Every table of the folder (`path`: the dataset root, its data/ dir or the folder itself)."""
    d = path if any(os.path.exists(os.path.join(path, f"elo_plans.{x}")) for x in ("parquet", "jsonl")) else folder_of(path)
    return {n: load_table(d, n) for n in TABLES}


def _data(root: str, name: str, columns: tuple, arm: Optional[str] = None) -> List[dict]:
    """One table of the dataset's data/ beside the folder, only `columns` (and only `arm`'s rows)."""
    d = os.path.join(root_of(root), "data")
    pq_path = os.path.join(d, f"{name}.parquet")
    if os.path.exists(pq_path):
        import pyarrow.parquet as pq
        return pq.read_table(pq_path, columns=list(columns),
                             filters=[("arm_id", "=", arm)] if arm else None).to_pylist()
    return [{k: r.get(k) for k in columns} for r in load_table(d, name) if arm is None or r.get("arm_id") == arm]


def dataset_of(root: str) -> Dict[str, List[dict]]:
    """What the comparison reads from the dataset's tables: the answer key, and final1's arm, reviews and
    verdicts (arm quickreview-frozen)."""
    return {"defects": _data(root, "defects", ("instance_id", "defect_id", "severity", "key_version")),
            "old_arm": _data(root, "arms", ("arm_id", "runs", "judge", "model_billed"), OLD_ARM),
            "old_reviews": _data(root, "reviews", ("arm_id", "instance_id", "run", "n_comments", "cost_usd", "minutes"),
                                 OLD_ARM),
            "old_defect_verdicts": _data(root, "defect_verdicts", ("arm_id", "instance_id", "defect_id", "credit",
                                                                   "verdict"), OLD_ARM),
            "old_comment_verdicts": _data(root, "comment_verdicts", ("arm_id", "instance_id", "comment_id", "grade",
                                                                     "defect_id"), OLD_ARM)}


# ---------------------------------------------------------------------------------------------------- Elo

def _verdict(r: dict) -> dict:
    return {"overall": {"winner": r["overall_winner"]},
            "categories": {c: {"winner": r[f"{c}_winner"]} for c in CATEGORIES}}


def _plans(t: Dict[str, List[dict]]) -> List[dict]:
    return sorted(t["elo_plans"], key=lambda p: p["order"])


def finals(t: Dict[str, List[dict]]) -> Dict[str, Dict[str, Dict[str, dict]]]:
    """plan -> judge -> unit id -> the judgment the ratings use: per plan, each rated judge's first ok
    judgment of a unit (in its file's `line` order, set-aside rows left out) at the unit's current prompt,
    the prompt of its most recent ok judgment over the plan's judges (elo_ratings.finals, elo.py's rule)."""
    out: Dict[str, Dict[str, Dict[str, dict]]] = {}
    for p in _plans(t):
        js = {}
        for j in [x["judge"] for x in p["judges"]]:
            rows = sorted((r for r in t["elo_judgments"] if r["plan"] == p["plan"] and r["judgment_file"] == j
                           and not r["set_aside"]), key=lambda r: r["line"])
            js[j] = [dict(r, id=r["unit_id"], verdict=_verdict(r) if r["status"] == "ok" else None) for r in rows]
        out[p["plan"]] = {j: f for j, f in ER.finals(js).items() if f}
    return out


def _games(rows, category=None) -> List[tuple]:
    return [(r["pr"], r["a"], r["b"], ER.SCORE[R.winner(r["verdict"], category)]) for r in rows]


def refit(t: Dict[str, List[dict]], reps: int = REPS) -> dict:
    """The pooled report the published numbers came from, from the tables: per judge (in first-plan order) its table over every
    plan it judged, per category; the combined tables (each judge's games repeated to the least common
    multiple of the plan counts, so every judge weighs the same); position, order and agreement."""
    plans = _plans(t)
    runs = plans[0]["runs"] if plans else list(ARMS)
    fin = finals(t)
    by_judge: Dict[str, List[tuple]] = {}
    for p in plans:
        if list(p["runs"]) != list(runs):
            raise SystemExit(f"elo_plans: {p['plan']} rates {p['runs']}, not {runs}")
        for j, f in fin[p["plan"]].items():
            by_judge.setdefault(j, []).append((p["plan"], list(f.values())))
    out: dict = {"runs": list(runs), "judges": {}, "combined": {}, "agreement": {}}
    per = {}
    for j, parts in by_judge.items():
        rows = [r for _, rs in parts for r in rs]
        per[j] = (rows, len(parts))
        dec = [r for r in rows if R.winner(r["verdict"]) != "tie"]
        a_wins = sum(R.winner(r["verdict"]) == "A" for r in dec)
        by_id = collections.defaultdict(list)
        for _, rs in parts:
            for r in rs:
                by_id[(r["id"], r["pr"])].append(r)
        o = collections.Counter()
        for rs in by_id.values():
            for i in range(len(rs)):
                for k in range(i + 1, len(rs)):
                    x, y = rs[i], rs[k]
                    if (x["a"], x["b"]) != (y["b"], y["a"]):
                        continue
                    o["pairs"] += 1
                    wx, wy = _winner_name(x), _winner_name(y)
                    o["with_tie" if "tie" in (wx, wy) else "same" if wx == wy else "flipped"] += 1
        out["judges"][j] = {
            "overall": R.table(runs, _games(rows), reps=reps),
            **{c: R.table(runs, _games(rows, c), reps=reps) for c in CATEGORIES},
            "position": {"a_wins": a_wins, "decided": len(dec), "ties": len(rows) - len(dec)},
            "order": {k: o[k] for k in ("pairs", "same", "flipped", "with_tie")},
            "plans": len(parts), "units": rows}
    js = list(by_judge)
    for i in range(len(js)):
        for k in range(i + 1, len(js)):
            x = {(d, r["id"]): r for d, rs in by_judge[js[i]] for r in rs}
            y = {(d, r["id"]): r for d, rs in by_judge[js[k]] for r in rs}
            c = collections.Counter()
            both = sorted(set(x) & set(y))
            for key in both:
                wx, wy = _winner_name(x[key]), _winner_name(y[key])
                c["same" if wx == wy else ("one_tie" if "tie" in (wx, wy) else "opposite")] += 1
            out["agreement"][f"{js[i]}~{js[k]}"] = {"units": len(both), **{n: c[n] for n in ("same", "opposite", "one_tie")}}
    if len(per) > 1:
        lcm = 1
        for _, n in per.values():
            lcm = lcm * n // math.gcd(lcm, n)
        for c in (None,) + tuple(CATEGORIES):
            games = []
            for rows, n in per.values():
                games += _games(rows, c) * (lcm // n)
            out["combined"][c or "overall"] = R.table(runs, games, reps=reps)
    return out


def _winner_name(r: dict) -> str:
    return {"A": r["a"], "B": r["b"], "tie": "tie"}[R.winner(r["verdict"])]


def refit_rows(fit: dict, labels: Dict[str, str]) -> Dict[str, List[dict]]:
    """The elo_ratings and elo_gaps rows of a refit: one per scope (each judge, combined), category and
    configuration, and one per scope, category and pair."""
    rats, gaps = [], []
    for scope in [j for j in fit["judges"]] + (["combined"] if fit["combined"] else []):
        src = fit["combined"] if scope == "combined" else fit["judges"][scope]
        for cat in ("overall",) + tuple(CATEGORIES):
            tb = src[cat]
            for r in tb["rows"]:
                rats.append({"scope": scope, "category": cat, "run": r["player"], "label": labels.get(r["player"]),
                             "elo": r["elo"], "lo": r["lo"], "hi": r["hi"], "w": r["w"], "t": r["t"], "l": r["l"],
                             "games": tb["games"], "prs": tb["prs"]})
            for g in tb["pairs"]:
                gaps.append({"scope": scope, "category": cat, "upper": g["upper"], "lower": g["lower"],
                             "gap": g["gap"], "lo": g["lo"], "hi": g["hi"], "separated": g["separated"],
                             "p_win": g["p_win"], "direct_w": g["direct"]["w"], "direct_t": g["direct"]["t"],
                             "direct_l": g["direct"]["l"], "games": tb["games"], "prs": tb["prs"]})
    return {"elo_ratings": rats, "elo_gaps": gaps}


def _signed(tb: dict) -> tuple:
    """(gap, lo, hi) of s62 over final1 in a two-configuration table: negative when final1 is ahead."""
    g = tb["pairs"][0]
    if g["upper"] == NEW:
        return g["gap"], g["lo"], g["hi"]
    return -g["gap"], -g["hi"], -g["lo"]


# ---------------------------------------------------------------------------------------------------- numbers

def numbers(path: str) -> Dict[str, object]:
    """Every number of the comparison, by name, from the folder's tables and the dataset's (`path`: the
    dataset root, its data/ dir or the folder). Percentages are x100, money dollars, time minutes."""
    return numbers_of(tables_of(path), dataset_of(path))


def numbers_of(t: Dict[str, List[dict]], data: Dict[str, List[dict]], fit: Optional[dict] = None) -> Dict[str, object]:
    out: Dict[str, object] = {}
    cases = [r for r in t["cases"] if r["arm_id"] == NEW]
    prs = {r["instance_id"] for r in cases}
    out["prs"] = len(prs)
    out[f"prs.{OLD}"] = len({r["instance_id"] for r in data["old_reviews"]})
    out["prs.same"] = float(prs == {r["instance_id"] for r in data["old_reviews"]})

    # the answer key on these PRs, and the judge's credit by severity
    key = {(d["instance_id"], d["defect_id"]): d["severity"] for d in data["defects"] if d["instance_id"] in prs}
    out["key.defects"] = len(key)
    for s in SEVERITIES:
        out[f"key.{s}"] = sum(1 for v in key.values() if v == s)
    dvs = {NEW: [r for r in t["defect_verdicts"] if r["arm_id"] == NEW], OLD: data["old_defect_verdicts"]}
    for a, rows in dvs.items():
        out[f"key.{a}.all"] = sum(r["credit"] for r in rows)
        out[f"key.{a}.found"] = sum(1 for r in rows if r["verdict"] == "found")
        out[f"key.{a}.partial"] = sum(1 for r in rows if r["verdict"] == "partial")
        for s in SEVERITIES:
            out[f"key.{a}.{s}"] = sum(r["credit"] for r in rows if key.get((r["instance_id"], r["defect_id"])) == s)

    # the judged comments: on an answer-key defect, not correct (incorrect, partly correct or unverifiable)
    cvs = {NEW: [r for r in t["comment_verdicts"] if r["arm_id"] == NEW], OLD: data["old_comment_verdicts"]}
    for a, rows in cvs.items():
        n = len(rows)
        out[f"comments.{a}.judged"] = n
        out[f"comments.{a}.on_key"] = sum(1 for r in rows if r["defect_id"])
        out[f"comments.{a}.not_correct"] = sum(1 for r in rows if r["grade"] in NOT_CORRECT)
        out[f"comments.{a}.not_correct.pct"] = 100.0 * out[f"comments.{a}.not_correct"] / n if n else None
        out[f"comments.{a}.correct_off_key"] = sum(1 for r in rows if not r["defect_id"] and r["grade"] not in NOT_CORRECT)
        out[f"comments.{a}.on_key_not_correct"] = sum(1 for r in rows if r["defect_id"] and r["grade"] in NOT_CORRECT)
        out[f"comments.{a}.per_pr"] = n / len(prs) if prs else None
    out[f"comments.{NEW}.inline"] = sum(1 for r in t["reviews"] if r["arm_id"] == NEW and r["inline"])
    out[f"comments.{NEW}.body"] = sum(1 for r in t["reviews"] if r["arm_id"] == NEW and not r["inline"])
    out[f"comments.{OLD}.posted"] = sum(r["n_comments"] or 0 for r in data["old_reviews"])

    # cost and time: compare.usd_and_minutes per review (cases.usd, the dataset's reviews.cost_usd)
    money = {NEW: [(r["usd"], r["minutes"]) for r in cases],
             OLD: [(r["cost_usd"], r["minutes"]) for r in data["old_reviews"]]}
    for a, rows in money.items():
        usd, mins = [u for u, _ in rows], [m for _, m in rows]
        out[f"cost.{a}.usd_total"] = sum(usd) if rows and None not in usd else None
        out[f"cost.{a}.usd_per_pr"] = out[f"cost.{a}.usd_total"] / len(rows) if out[f"cost.{a}.usd_total"] is not None else None
        out[f"cost.{a}.minutes_median"] = statistics.median(mins) if rows and None not in mins else None
        out[f"cost.{a}.minutes_per_pr"] = statistics.mean(mins) if rows and None not in mins else None
    out["cost.ratio"] = (out[f"cost.{NEW}.usd_per_pr"] / out[f"cost.{OLD}.usd_per_pr"]
                         if out[f"cost.{NEW}.usd_per_pr"] and out[f"cost.{OLD}.usd_per_pr"] else None)

    # pairwise Elo
    fit = refit(t) if fit is None else fit
    units = {r["pr"] for r in t["elo_units"]}
    out["elo.prs"] = len(units)
    for scope in SCOPES:
        src = fit["combined"] if scope == "combined" else fit["judges"].get(scope)
        if not src:
            continue
        for cat in ("overall",) + tuple(CATEGORIES):
            g, lo, hi = _signed(src[cat])
            out[f"elo.{scope}.{cat}"], out[f"elo.{scope}.{cat}.lo"], out[f"elo.{scope}.{cat}.hi"] = g, lo, hi
        out[f"elo.{scope}.games"] = src["overall"]["games"]
        out[f"elo.{scope}.prs"] = src["overall"]["prs"]
        out[f"elo.{scope}.prs_never"] = len(units) - src["overall"]["prs"]
    for j, v in fit["judges"].items():
        out[f"elo.{j}.plans"] = v["plans"]
        for k, x in v["position"].items():
            out[f"elo.{j}.position.{k}"] = x
        d = v["position"]["decided"]
        out[f"elo.{j}.position.a_pct"] = 100.0 * v["position"]["a_wins"] / d if d else None
        out[f"elo.{j}.position.b_pct"] = 100.0 * (d - v["position"]["a_wins"]) / d if d else None
        for k, x in v["order"].items():
            out[f"elo.{j}.order.{k}"] = x
    for pair, ag in fit["agreement"].items():
        for k, x in ag.items():
            out[f"elo.agreement.{pair}.{k}"] = x
    # every attempt, by judge: the set-aside first attempts count (they were made and failed)
    for j in sorted({r["judgment_file"] for r in t["elo_judgments"]}):
        rows = [r for r in t["elo_judgments"] if r["judgment_file"] == j]
        out[f"elo.{j}.attempts"] = len(rows)
        out[f"elo.{j}.attempts.ok"] = sum(1 for r in rows if r["status"] == "ok")
        out[f"elo.{j}.attempts.not_ok"] = sum(1 for r in rows if r["status"] != "ok")
        out[f"elo.{j}.attempts.set_aside"] = sum(1 for r in rows if r["set_aside"])
        out[f"elo.{j}.input_tokens"] = sum(r["input_tokens"] or 0 for r in rows)
        out[f"elo.{j}.output_tokens"] = sum(r["output_tokens"] or 0 for r in rows)
    return out


def _r(x, n):
    return None if x is None else round(x, n)


def _i(x):
    """A whole number as the write-up prints it (format's rounding)."""
    return None if x is None or x != x else int(f"{x:.0f}")


def post_values(n: Dict[str, object]) -> Dict[str, object]:
    """numbers() in POST's shape and rounding (POST's comment)."""
    g = n.get
    return {
        "prs": g("prs"),
        "answer_key": {"defects": g("key.defects"), **{s: g(f"key.{s}") for s in SEVERITIES},
                       **{a: {"all": g(f"key.{a}.all"), **{s: g(f"key.{a}.{s}") for s in SEVERITIES}} for a in ARMS}},
        "comments": {a: {"judged": g(f"comments.{a}.judged"), "on_key": g(f"comments.{a}.on_key"),
                         "not_correct": g(f"comments.{a}.not_correct"),
                         "not_correct_pct": _i(g(f"comments.{a}.not_correct.pct")),
                         "per_pr": _r(g(f"comments.{a}.per_pr"), 1)} for a in ARMS},
        "cost": {a: {"usd_per_pr": _r(g(f"cost.{a}.usd_per_pr"), 2), "minutes_median": _r(g(f"cost.{a}.minutes_median"), 1)}
                 for a in ARMS},
        "elo": {s: {c: [_i(g(f"elo.{s}.{c}")), _i(g(f"elo.{s}.{c}.lo")), _i(g(f"elo.{s}.{c}.hi"))]
                    for c in ("overall",) + tuple(CATEGORIES)} for s in SCOPES},
        "elo_games": {"gpt": {"games": g("elo.gpt.games"), "prs": g("elo.gpt.prs")},
                      "deepseek": {"games": g("elo.deepseek.games"), "prs": g("elo.deepseek.prs"),
                                   "prs_never": g("elo.deepseek.prs_never")},
                      "combined": {"games": g("elo.combined.games"), "prs": g("elo.combined.prs")}},
        "position": {"gpt": {**{k: g(f"elo.gpt.position.{k}") for k in ("a_wins", "decided", "ties")},
                             "b_pct": _i(g("elo.gpt.position.b_pct"))},
                     "deepseek": {**{k: g(f"elo.deepseek.position.{k}") for k in ("a_wins", "decided", "ties")},
                                  "a_pct": _i(g("elo.deepseek.position.a_pct"))}},
        "order": {j: {k: g(f"elo.{j}.order.{k}") for k in ("pairs", "same", "flipped", "with_tie")}
                  for j in ("gpt", "deepseek")},
        "agreement": {k: g(f"elo.agreement.gpt~deepseek.{k}") for k in ("units", "same", "opposite", "one_tie")},
        "attempts": {"gpt": {k: g(f"elo.gpt.attempts{'' if k == 'total' else '.' + k}") for k in ("total", "ok", "not_ok")},
                     "deepseek": {k: g(f"elo.deepseek.attempts{'' if k == 'total' else '.' + k}")
                                  for k in ("total", "ok", "not_ok", "set_aside")}},
    }


# ---------------------------------------------------------------------------------------------------- checks

NUMBER_CHECKS = (
    ("prs", "s62 reviewed all the pull requests"),
    ("answer_key", "the answer key's defects by severity, and each setup's credit on them (found 1, partial 0.5) "
                   "from its defect judge's verdicts"),
    ("comments", "the comments each setup's defect judge read: on an answer-key defect, not correct (incorrect, "
                 "partly correct or unverifiable), and per pull request"),
    ("cost", "list-price dollars per pull request and median minutes per review (compare.usd_and_minutes)"),
    ("elo", "the Elo gap of s62 over final1 with its 95% interval, per judge and pooled, overall and per category "
            "(refit from elo_judgments)"),
    ("elo_games", "the games each judge's ratings use and the pull requests they cover, and the pull requests "
                  "DeepSeek never answered"),
    ("position", "how often each judge picked Review A among its decided verdicts"),
    ("order", "the pairs each judge judged in both orders: the same winner both times, flipped, or a tie in one"),
    ("agreement", "the units both judges answered: the same winner, opposite winners, one tie"),
    ("attempts", "every judgment attempt by judge and status, the set-aside first attempts included"),
)
COLUMNS_CHECK = "every table has exactly its listed columns"
WHOLE_CHECK = ("the rows are whole: s62 reviewed and was judged on final1's pull requests in the dataset (arm "
               "quickreview-frozen), one verdict on every answer-key defect at its key version, every judged comment "
               "a posted one (inline or in the review body), and every Elo judgment of a unit of its plan between s62 "
               "and final1, in its file's order")
README_CHECK = "README.md is the README its tables give (gpt62_sol.readme of numbers())"
REFIT_CHECK = ("elo_ratings, elo_gaps and elo_judgments.used_in_ratings are the refit of elo_judgments (each judge "
               "over every plan it judged, and both pooled with each judge weighted the same)")


def checks(root: str, manifest_path: str = MANIFEST, post: Optional[Dict[str, object]] = None) -> List[dict]:
    """The comparison's checks of validation.json (the module docstring), on a dataset root."""
    post = POST if post is None else post
    root = root_of(root)
    folder = os.path.join(root, FOLDER)
    out: List[dict] = []

    def check(what, got, want):
        out.append({"check": f"{FOLDER}: {what}", "got": got, "want": want, "ok": _same(got, want)})

    try:
        man = manifest_problems(folder, read_manifest(manifest_path))
    except OSError as e:
        man = {"error": str(e)}
    check("every file is the committed manifest's (bench/aacr/hf/gpt62-sol.sha256), none missing, extra or "
          "differing", man, {"missing": [], "extra": [], "differs": []})
    if not os.path.isdir(folder):
        why = f"no {FOLDER}/ beside the tables"
        for what, want in ((COLUMNS_CHECK, {}), (WHOLE_CHECK, {}), (README_CHECK, True), (REFIT_CHECK, {})):
            check(what, why, want)
        for key, what in NUMBER_CHECKS:
            check(what, why, post.get(key))
        return out
    errs = (SystemExit, OSError, ValueError, KeyError, TypeError, IndexError)
    try:
        cols = {t: c for t, want in TABLES.items() if sorted(c := columns_of(folder, t)) != sorted(want)}
    except errs as e:
        cols = {"error": str(e)}
    check(COLUMNS_CHECK, cols, {})
    try:
        t, data = tables_of(folder), dataset_of(root)
    except errs as e:
        t, data = None, {"error": str(e)}
    try:
        whole = whole_problems(t, data) if t is not None else data
    except errs as e:
        whole = {"error": str(e)}
    check(WHOLE_CHECK, whole, {})
    try:
        fit = refit(t)
        n = numbers_of(t, data, fit)
    except errs as e:
        fit, n = None, {"error": str(e)}
    try:
        with open(os.path.join(folder, "README.md"), encoding="utf-8") as f:
            same = f.read() == readme(n)
    except errs as e:
        same = {"error": str(e)}
    check(README_CHECK, same, True)
    try:
        bad = refit_problems(t, fit) if fit is not None else n
    except errs as e:
        bad = {"error": str(e)}
    check(REFIT_CHECK, bad, {})
    try:
        got = post_values(n) if "error" not in n else {k: n for k, _ in NUMBER_CHECKS}
    except errs as e:
        got = {k: {"error": str(e)} for k, _ in NUMBER_CHECKS}
    for key, what in NUMBER_CHECKS:
        check(what, got.get(key), post.get(key))
    return out


def _same(a, b) -> bool:
    """Equal, with floats to 1e-9 and NaN equal to NaN (a refit's interval when a table has too few PRs)."""
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(_same(a[k], b[k]) for k in a)
    if isinstance(a, (list, tuple)) and isinstance(b, (list, tuple)):
        return len(a) == len(b) and all(_same(x, y) for x, y in zip(a, b))
    if isinstance(a, float) or isinstance(b, float):
        if not isinstance(a, (int, float)) or not isinstance(b, (int, float)) or isinstance(a, bool) or isinstance(b, bool):
            return False
        return (a != a and b != b) or abs(a - b) <= 1e-9
    return a == b


def refit_problems(t: Dict[str, List[dict]], fit: dict) -> Dict[str, object]:
    """elo_ratings, elo_gaps and the used_in_ratings flags against the refit: {problem: examples}."""
    bad: Dict[str, object] = {}
    labels = {x["run"]: x["label"] for p in t["elo_plans"] for x in p["labels"]}
    want = refit_rows(fit, labels)
    for name in ("elo_ratings", "elo_gaps"):
        key = (lambda r: (r["scope"], r["category"], r["run"])) if name == "elo_ratings" else \
            (lambda r: (r["scope"], r["category"], r["upper"], r["lower"]))
        have = {key(r): r for r in t[name]}
        exp = {key(r): r for r in want[name]}
        if set(have) != set(exp) or len(have) != len(t[name]):
            bad[f"{name}: rows differ from the refit's"] = {"missing": sorted(map(str, set(exp) - set(have)))[:5],
                                                            "extra": sorted(map(str, set(have) - set(exp)))[:5]}
            continue
        off = sorted(str(k) for k in exp if not _same({c: have[k][c] for c in TABLES[name]},
                                                      {c: exp[k][c] for c in TABLES[name]}))
        if off:
            bad[f"{name}: a value differs from the refit's"] = off[:5]
    used = {(p, j, r["unit_id"], r["line"])
            for p, by in finals(t).items() for j, f in by.items() for r in f.values()}
    flags = {(r["plan"], r["judgment_file"], r["unit_id"], r["line"]) for r in t["elo_judgments"] if r["used_in_ratings"]}
    if used != flags:
        bad["elo_judgments: used_in_ratings is not the refit's selection"] = {
            "unflagged": len(used - flags), "flagged_unused": len(flags - used)}
    return bad


def whole_problems(t: Dict[str, List[dict]], data: Dict[str, List[dict]]) -> Dict[str, object]:
    """The folder's rows against each other and against the dataset's: {problem: examples}, empty when whole."""
    bad: Dict[str, object] = {}
    cases = [r for r in t["cases"] if r["arm_id"] == NEW]
    prs = sorted(r["instance_id"] for r in cases)
    old = sorted(r["instance_id"] for r in data["old_reviews"])
    if prs != old or not prs or len(prs) != len(set(prs)):
        bad["cases: s62's pull requests are not final1's in the dataset"] = {"s62": len(prs), OLD: len(old)}
    if not data["old_arm"] or sorted(data["old_arm"][0]["runs"] or []) != sorted(f"{OLD}-{s}" for s in SETS):
        bad[f"dataset: arm {OLD_ARM} is not runs {OLD}-*"] = (data["old_arm"][0]["runs"] if data["old_arm"] else None)
    unjudged = sorted(r["instance_id"] for r in cases if not r["judged"])
    if unjudged:
        bad["cases: not judged"] = unjudged[:10]
    key = collections.defaultdict(set)
    kv = {}
    for d in data["defects"]:
        key[d["instance_id"]].add(d["defect_id"])
        kv[d["instance_id"]] = str(d["key_version"])
    got = collections.defaultdict(list)
    for r in t["defect_verdicts"]:
        got[r["instance_id"]].append(r)
    off = sorted(p for p in prs if sorted(r["defect_id"] for r in got[p]) != sorted(key[p])
                 or any(str(r["key_version"]) != kv.get(p) for r in got[p]))
    if off or set(got) - set(prs):
        bad["defect_verdicts: not one verdict on each answer-key defect of the PR, at its key version"] = off[:10]
    inline = [r for r in t["reviews"] if r["inline"]]
    posted = collections.defaultdict(list)
    for r in inline:
        posted[(r["arm_id"], r["instance_id"])].append(r["index"])
    gaps = sorted(f"{a}/{p}" for (a, p), ix in posted.items() if sorted(ix) != list(range(len(ix))))
    if gaps:
        bad["reviews: inline comment indices are not 0..n-1"] = gaps[:10]
    body = sorted(f"{r['arm_id']}/{r['instance_id']}#{r['comment_id']}" for r in t["reviews"]
                  if not r["inline"] and (r["index"] is not None or r["comment_id"] is None))
    if body:
        bad["reviews: a finding in the review body with an index, or without the judge's id"] = body[:10]
    counts = collections.Counter((r["arm_id"], r["instance_id"]) for r in inline)
    off = sorted(f"{r['arm_id']}/{r['instance_id']}" for r in t["cases"] if counts[(r["arm_id"], r["instance_id"])] != r["n_posted"])
    if off:
        bad["cases: n_posted differs from the inline comments"] = off[:10]
    ids = {(r["arm_id"], r["instance_id"], r["comment_id"]) for r in t["comment_verdicts"]}
    unl = sorted(f"{r['arm_id']}/{r['instance_id']}#{r['index']}" for r in t["reviews"]
                 if r["comment_id"] is not None and (r["arm_id"], r["instance_id"], r["comment_id"]) not in ids)
    if unl:
        bad["reviews: a comment id the judge's verdicts lack"] = unl[:10]
    row_of = {(r["arm_id"], r["instance_id"], r["comment_id"]): r["index"] for r in t["reviews"] if r["comment_id"]}
    loose = sorted(f"{r['arm_id']}/{r['instance_id']}#{r['comment_id']}" for r in t["comment_verdicts"]
                   if (r["arm_id"], r["instance_id"], r["comment_id"]) not in row_of
                   or row_of[(r["arm_id"], r["instance_id"], r["comment_id"])] != r["index"])
    if loose:
        bad["comment_verdicts: a judged comment that is no reviews row, or another index than its row's"] = loose[:10]

    # Elo
    plans = {p["plan"]: p for p in t["elo_plans"]}
    if sorted(plans) != sorted(PLANS) or sorted(p["order"] for p in t["elo_plans"]) != list(range(len(PLANS))):
        bad["elo_plans: not the four plans, ordered 0..3"] = sorted(plans)
    units = {(u["plan"], u["unit_id"]): u for u in t["elo_units"]}
    stray = sorted(f"{u['plan']}/{u['unit_id']}" for u in t["elo_units"]
                   if u["plan"] not in plans or {u["a"], u["b"]} != set(ARMS) or u["pr"] not in set(prs))
    if stray or len(units) != len(t["elo_units"]):
        bad["elo_units: a unit of no plan, not between s62 and final1, of a PR s62 did not review, or twice"] = stray[:10]
    loose = []
    lines = collections.defaultdict(list)
    for r in t["elo_judgments"]:
        u = units.get((r["plan"], r["unit_id"]))
        judges = [x["judge"] for x in plans.get(r["plan"], {}).get("judges") or []]
        if u is None or (u["pr"], u["a"], u["b"], u["round"]) != (r["pr"], r["a"], r["b"], r["round"]) \
                or r["judgment_file"] not in judges or r["judge"] != r["judgment_file"]:
            loose.append(f"{r['plan']}/{r['judgment_file']}/{r['unit_id']}")
        if r["set_aside"] and r["status"] == "ok":
            loose.append(f"{r['plan']}/{r['judgment_file']}/{r['unit_id']} set aside but ok")
        if (r["status"] == "ok") != all(r[f"{c}_winner"] in ("A", "B", "tie") for c in ("overall",) + tuple(CATEGORIES)):
            loose.append(f"{r['plan']}/{r['judgment_file']}/{r['unit_id']} winners")
        lines[(r["plan"], r["judgment_file"])].append(r["line"])
    if loose:
        bad["elo_judgments: a judgment of no unit of its plan, by a judge the plan does not rate, a set-aside ok "
            "row, or an ok row without every winner"] = sorted(loose)[:10]
    off = sorted(f"{p}/{j}" for (p, j), ls in lines.items() if sorted(ls) != list(range(len(ls))))
    if off:
        bad["elo_judgments: lines are not 0..n-1 in a file"] = off
    return bad


# ---------------------------------------------------------------------------------------------------- build

BODY_MARK = "_posted in the body_"


def _on_main(repo: str, commit: str) -> bool:
    p = subprocess.run(["git", "-C", repo, "merge-base", "--is-ancestor", commit, "origin/main"], capture_output=True)
    if p.returncode not in (0, 1):
        raise SystemExit(f"git merge-base on {commit}: {p.stderr.decode(errors='replace').strip()}")
    return p.returncode == 0


def _pi_source(image_id: str, pi: Optional[str]) -> Optional[str]:
    """Where the image's pi came from when it is not the release `pi` names (PI_MAIN), checked against the
    image's own `qcr.pi.main` label when docker still has the image; None when nothing records it."""
    commit = PI_MAIN.get(image_id)
    try:
        p = subprocess.run(["docker", "image", "inspect", image_id, "--format", "{{json .Config.Labels}}"],
                           capture_output=True, text=True, timeout=60)
        label = (json.loads(p.stdout) or {}).get("qcr.pi.main") if p.returncode == 0 else None
    except (OSError, ValueError, subprocess.TimeoutExpired):
        label = None
    if label is not None and label != commit:
        raise SystemExit(f"{image_id}: its qcr.pi.main label is {label}, PI_MAIN says {commit}")
    if commit is None:
        return None
    return f"pi rebuilt from its unreleased main at {commit}; it reports itself as {pi}"


def _engine(engine: Optional[dict]) -> Optional[str]:
    """run.json's `engine` as `key=value` pairs; None where the run recorded none (a run from before the SDK
    engine)."""
    return ", ".join(f"{k}={v if isinstance(v, str) else json.dumps(v)}" for k, v in engine.items()) if engine else None


def _judge_file(run_dir: str, iid: str) -> Optional[str]:
    g = sorted(glob.glob(os.path.join(run_dir, "judge", f"v*-{NEW_JUDGE_DIR}", f"{iid}.r1.json")))
    return g[0] if g else None


def _read_jsonl(path: str) -> List[dict]:
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


def _attempts(d: str, judge: str) -> List[tuple]:
    """(row, set_aside) of every attempt of one judge in one plan dir, in the order they were made. Where the
    failed first attempts were moved out (`<judge>.jsonl.pass1-with-errors.bak` holds the whole first file),
    the current file must be that file without them, in order, plus the attempts made after: those failed
    rows come back with set_aside true."""
    cur = _read_jsonl(os.path.join(d, "judgments", f"{judge}.jsonl"))
    bak_path = os.path.join(d, "judgments", judge + SET_ASIDE_SUFFIX)
    if not os.path.exists(bak_path):
        return [(r, False) for r in cur]
    bak = _read_jsonl(bak_path)
    kept = [r for r in bak if r in cur]
    if cur[:len(kept)] != kept:
        raise SystemExit(f"{bak_path}: the current file does not start with the first file's kept rows, in order")
    aside = [r for r in bak if r not in cur]
    if any(r.get("status") == "ok" for r in aside):
        raise SystemExit(f"{bak_path}: an ok judgment was moved out")
    return [(r, r in aside) for r in bak] + [(r, False) for r in cur[len(kept):]]


def collect(a) -> tuple:
    """The folder's tables from the runs and the Elo dirs, and the scrub's counts: (tables, counts)."""
    sys.path.insert(0, os.path.dirname(HERE))
    import compare
    import hf_export as H
    import release_catalogue as RC

    counts = collections.Counter()
    S = lambda x: H.scrub_obj(x, counts)  # noqa: E731
    tables: Dict[str, List[dict]] = {n: [] for n in TABLES}

    runs = [f"{NEW}-{s}" for s in SETS]
    rj = [json.load(open(os.path.join(a.runs_dir, r, "run.json"))) for r in runs]
    aj = [json.load(open(os.path.join(a.runs_dir, f"{r}.arm.json"))) for r in runs]

    def one(xs, what):
        if len({json.dumps(x) for x in xs}) != 1:
            raise SystemExit(f"{NEW}: the runs differ in {what}: {sorted({json.dumps(x) for x in xs})}")
        return xs[0]
    commit = one([r["qcr_commit"] for r in rj], "qcr_commit")
    on = _on_main(a.repo, commit.replace("-dirty", ""))
    f = RC.commit_fields(commit, {commit: commit if on else None}, {commit: {"match": "same"}} if on else {})
    labels = {}
    for p in PLANS:
        labels.update(json.load(open(os.path.join(a.elo_dir, p, "plan.json"))).get("labels") or {})
    image_id, pi = one([x["image_id"] for x in aj], "image_id"), one([r.get("pi") for r in rj], "pi")
    tables["arms"].append({
        "arm_id": NEW, "display_name": labels.get(NEW), "dataset_arm": None,
        "image": one([x["image"] for x in aj], "image"), "image_id": image_id,
        "config": one([x["config"] for x in aj], "config"), "profile": one([r.get("profile") or None for r in rj], "profile"),
        **f, "pi": pi, "pi_source": _pi_source(image_id, pi), "engine": _engine(one([r.get("engine") for r in rj], "engine")),
        "reviewer_model": one([r["models"]["conversation"] for r in rj], "model"), "judge": NEW_JUDGE_DIR,
        "runs": runs, "prs": sum(len(r["cases"]) for r in rj),
        "note": "QuickReview 1.6.0 with review.quiet=true (no nits, nothing below P2), on the SDK engine; its "
                "reviews and verdicts are this folder's"})
    old_runs = [f"{OLD}-{s}" for s in SETS]
    oj = [json.load(open(os.path.join(a.runs_dir, r, "run.json"))) for r in old_runs]
    tables["arms"].append({
        "arm_id": OLD, "display_name": labels.get(OLD), "dataset_arm": OLD_ARM, **{k: None for k in (
            "image", "image_id", "config", "profile", "qcr_commit", "qcr_commit_on_public_main", "qcr_commit_match",
            "qcr_commit_dirty", "pi_source")},
        "pi": one([r.get("pi") for r in oj], "final1 pi"), "engine": _engine(one([r.get("engine") for r in oj], "final1 engine")),
        "reviewer_model": one([r["models"]["conversation"] for r in oj], "final1 model"),
        "judge": "gpt-6-sol-high", "runs": old_runs,
        "prs": sum(len(os.listdir(os.path.join(a.runs_dir, r, "results", "all"))) for r in old_runs),
        "note": f"the build frozen on 2026-10-04, no quiet default; its runs record pi {one([r.get('pi') for r in oj], 'final1 pi')} "
                f"and no engine (they predate the SDK engine); its reviews, verdicts and build ids are the "
                f"dataset's (arm {OLD_ARM} in arms, reviews, defect_verdicts, comment_verdicts; runs {OLD}-* in runs)"})

    for s, run_json in zip(SETS, rj):
        run = f"{NEW}-{s}"
        for pr in run_json["cases"]:
            case = os.path.join(a.runs_dir, run, "cases", pr)
            summ = json.load(open(os.path.join(case, "case-summary.json")))
            usd, mins = compare.usd_and_minutes(case)
            posted = json.load(open(os.path.join(case, "comments.json")))
            jf = _judge_file(os.path.join(a.runs_dir, run), pr)
            j = json.load(open(jf)) if jf else None
            j = j if isinstance(j, dict) and not j.get("error") else None
            judge = re.sub(r"^v\d+-", "", os.path.basename(os.path.dirname(jf))) if j is not None else None
            # the judge's ids C1..Cn number the result file's rows with text, in order
            res = json.load(open(os.path.join(a.runs_dir, run, "results", "all", f"{pr}.json")))
            rows = [r for r in (res.get("review") or {}).get("comments") or [] if (r.get("content") or "").strip()]
            if j is not None and len(rows) != len(j["comments"]):
                raise SystemExit(f"{run}/{pr}: {len(rows)} result rows, {len(j['comments'])} judged comments")
            cid_of, used = {}, set()
            for i, b in enumerate(posted):
                ids = [f"C{k + 1}" for k, r in enumerate(rows) if r["content"] == b["body"] and f"C{k + 1}" not in used]
                if ids:
                    used.add(ids[0])
                    cid_of[i] = ids[0]
                tables["reviews"].append({"arm_id": NEW, "instance_id": pr, "index": i, "inline": True,
                                          "path": b.get("path"), "line": b.get("line"), "side": b.get("side"),
                                          "body": b.get("body"), "comment_id": cid_of.get(i) if j is not None else None})
            rest = [(f"C{k + 1}", r) for k, r in enumerate(rows) if f"C{k + 1}" not in used]
            if rest:
                md = open(os.path.join(case, "review.md"), encoding="utf-8").read()
                title = lambda r: r["content"].split("\n", 1)[0].split("] ", 1)[-1].strip()  # noqa: E731
                lost = [c for c, r in rest if title(r) not in md]
                if lost or md.count(BODY_MARK) != len(rest):
                    raise SystemExit(f"{run}/{pr}: result rows {[c for c, _ in rest]} are neither inline comments "
                                     f"nor the review body's {md.count(BODY_MARK)} findings")
                for c, r in rest:
                    tables["reviews"].append({"arm_id": NEW, "instance_id": pr, "index": None, "inline": False,
                                              "path": r.get("path"), "line": r.get("end_line"), "side": None,
                                              "body": r["content"], "comment_id": c if j is not None else None})
            u = (j or {}).get("usage") or {}
            tables["cases"].append({"arm_id": NEW, "instance_id": pr, "set": s, "run": run,
                                    "status": summ.get("status"), "verdict": (res.get("qcr") or {}).get("verdict"),
                                    "usd": usd, "minutes": mins, "n_posted": len(posted), "judged": j is not None,
                                    "judge_input_tokens": u.get("input"), "judge_output_tokens": u.get("output"),
                                    "judge_cache_read_tokens": u.get("cacheRead")})
            if j is None:
                continue
            index_of = {c: i for i, c in cid_of.items()}
            for d in j["defects"]:
                tables["defect_verdicts"].append({"arm_id": NEW, "instance_id": pr, "judge": judge,
                                                  "key_version": str(j.get("defect_set_version")),
                                                  "defect_id": d["id"], "verdict": d.get("verdict"),
                                                  "credit": H.credit(d.get("verdict")),
                                                  "comment_ids": [str(x) for x in d.get("comments") or []],
                                                  "why": d.get("why")})
            for c in j["comments"]:
                tables["comment_verdicts"].append({"arm_id": NEW, "instance_id": pr, "judge": judge,
                                                   "comment_id": c["id"], "index": index_of.get(c["id"]),
                                                   "grade": c.get("verdict"), "defect_id": c.get("defect"),
                                                   "new_defect": c.get("new_defect"), "why": c.get("why")})

    # the Elo plans, their units and every judgment attempt
    for order, p in enumerate(PLANS):
        d = os.path.join(a.elo_dir, p)
        plan = json.load(open(os.path.join(d, "plan.json")))
        if plan["name"] != p:
            raise SystemExit(f"{d}: plan.json names {plan['name']}")
        rated = R.rated_judges(plan)
        tables["elo_plans"].append({
            "plan": p, "order": order, "role": ROLES[p], **{k: plan.get(k) for k in PLAN_KEYS},
            "labels": [{"run": r, "label": plan["labels"][r]} for r in plan["runs"]],
            "judges": [{"judge": jn, **{k: (plan["judges"][jn] or {}).get(k) for k in JUDGE_KEYS}} for jn in rated]})
        for u in _read_jsonl(os.path.join(d, "units.jsonl")):
            tables["elo_units"].append({"plan": p, "unit_id": u["id"], "round": u["round"], "pr": u["pr"],
                                        "a": u["a"], "b": u["b"]})
        attempts = {jn: _attempts(d, jn) for jn in rated}
        # the judgments the ratings use: per plan, over all its judges at once (the current prompt is theirs)
        use = {id(r) for f in ER.finals({jn: [r for r, aside in at if not aside] for jn, at in attempts.items()}).values()
               for r in f.values()}
        for jn in rated:
            for line, (r, aside) in enumerate(attempts[jn]):
                v = r.get("verdict") or {}
                cats = v.get("categories") or {}
                us = r.get("usage") or {}
                row = {"plan": p, "judgment_file": jn, "line": line, "set_aside": aside, "unit_id": r["id"],
                       "round": r.get("round"), "pr": r["pr"], "a": r["a"], "b": r["b"], "judge": r.get("judge"),
                       "judge_model": r.get("model"), "effort": r.get("effort"), "at": r.get("at"),
                       "status": r.get("status"), "prompt_sha256": r.get("prompt_sha256"),
                       "used_in_ratings": id(r) in use, "turns": r.get("turns"),
                       "finish_reason": r.get("finish_reason"), "http_attempts": r.get("http_attempts"),
                       "error": r.get("error"), "raw": r.get("raw"),
                       "input_tokens": us.get("prompt_tokens"), "output_tokens": us.get("completion_tokens"),
                       "cached_tokens": (us.get("prompt_tokens_details") or {}).get("cached_tokens"),
                       "reasoning_tokens": (us.get("completion_tokens_details") or {}).get("reasoning_tokens"),
                       "overall_winner": (v.get("overall") or {}).get("winner"),
                       "overall_explanation": (v.get("overall") or {}).get("explanation")}
                for c in CATEGORIES:
                    row[f"{c}_winner"] = (cats.get(c) or {}).get("winner")
                    row[f"{c}_reasoning"] = (cats.get(c) or {}).get("reasoning")
                tables["elo_judgments"].append(row)
        # the plan's judges must have one current prompt: a judgment the ratings set aside as stale is a fault
        if len(rated) > 1 and ER.displaced({jn: _read_jsonl(os.path.join(d, "judgments", f"{jn}.jsonl")) for jn in rated}):
            raise SystemExit(f"{d}: a judge's prompt differs from the others'")
    tables = {n: [S(r) for r in rows] for n, rows in tables.items()}
    tables.update(refit_rows(refit(tables), {x["run"]: x["label"] for x in tables["elo_plans"][0]["labels"]}))
    return tables, counts


def build(a) -> None:
    """Write the folder from the runs and the Elo dirs (`gpt62_sol.py build --help`)."""
    sys.path.insert(0, os.path.dirname(HERE))
    import hf_export as H

    out = os.path.abspath(a.out)
    if os.path.basename(out) != FOLDER:
        raise SystemExit(f"--out: the `{FOLDER}` folder itself, not {out}")
    if os.path.exists(out):
        raise SystemExit(f"--out {out} exists: give a new folder (nothing is overwritten)")
    tmp = out + ".partial"
    if os.path.exists(tmp):
        raise SystemExit(f"{tmp} exists: move it away first")
    tables, counts = collect(a)
    os.makedirs(tmp)
    write_tables(tables, tmp)
    text = readme(numbers_of(tables_of(tmp), dataset_of(a.data)))
    # checks() compares README.md with readme() of the tables, so the scrub may not change it
    if H.scrub_obj(text, collections.Counter()) != text:
        raise SystemExit(f"README.md: the scrub would rewrite it; {tmp} is left for a look")
    with open(os.path.join(tmp, "README.md"), "w", encoding="utf-8") as fh:
        fh.write(text)
    os.rename(tmp, out)
    print(json.dumps({"rows": {k: len(v) for k, v in tables.items()}, "scrub_counts": dict(counts)}, indent=1))


def write_tables(tables: Dict[str, List[dict]], out: str) -> None:
    import pyarrow as pa
    import pyarrow.parquet as pq
    for name, cols in TABLES.items():
        rows = tables[name]
        t = pa.table({k: pa.array([r.get(k) for r in rows]) for k in cols})
        for i, f in enumerate(t.schema):  # a column every row leaves null has no type: a string column
            if pa.types.is_null(f.type):
                t = t.set_column(i, f.name, pa.array([None] * len(t), pa.string()))
        pq.write_table(t, os.path.join(out, f"{name}.parquet"), compression="zstd")


# ---------------------------------------------------------------------------------------------------- README

def readme(n: Dict[str, object]) -> str:
    """The folder's README, every number in it from numbers() (checks() compares the file with this)."""
    i = lambda k: f"{int(n[k]):,}"  # noqa: E731
    h = lambda k: f"{n[k]:g}"  # noqa: E731
    e = lambda k: f"{n[k]:+.0f}"  # noqa: E731
    ci = lambda k: f"{n[k + '.lo']:+.0f} to {n[k + '.hi']:+.0f}"  # noqa: E731
    names = {"overall": "Overall", "recall": "Finds the defects that matter", "precision": "Wastes less attention",
             "finding_quality": "States findings better", "writing": "Easier to read"}
    elo = "\n".join(f"| {names[c]} | {e(f'elo.gpt.{c}')} ({ci(f'elo.gpt.{c}')}) | {e(f'elo.deepseek.{c}')} "
                    f"({ci(f'elo.deepseek.{c}')}) | {e(f'elo.combined.{c}')} ({ci(f'elo.combined.{c}')}) |"
                    for c in ("overall",) + tuple(CATEGORIES))
    key = "\n".join(f"| {s.capitalize()} (of {i(f'key.{s}')}) | {h(f'key.{NEW}.{s}')} | {h(f'key.{OLD}.{s}')} |"
                    for s in SEVERITIES)
    return f"""# GPT-6.2 Sol comparison

QuickReview 1.6.0 on GPT-6.2 Sol, with its quiet default on (`{NEW}`), beside QuickReview's build frozen
on 2026-10-04 on GPT-6.1 Sol (`{OLD}`), on all {i('prs')} AACR-Bench pull requests: on the answer key, and
judged side by side by two AI judges. No config of the card reads this folder, so `load_dataset`
returns the same rows with or without it. `bench/aacr/recompute/gpt62_sol.py --data <this dataset>`
recomputes every number below from these tables and the dataset's own, checks that this README is the
one they give, refits the Elo ratings from the judgments, and runs the release's other checks of the
folder (`validation.json` holds them).

`{OLD}`'s reviews and its defect judge's verdicts are not repeated here: they are the dataset's arm
`{OLD_ARM}` (`reviews`, `defect_verdicts`, `comment_verdicts`; its runs `{OLD}-*` in `runs`). This
folder holds `{NEW}`'s, and the pairwise judgments of the two.

## The two setups

| | `{NEW}` | `{OLD}` |
|---|---|---|
| Reviewer | QuickReview 1.6.0, `review.quiet=true` (no nits, nothing below P2) | the build frozen on 2026-10-04, no quiet default |
| Model | GPT-6.2 Sol | GPT-6.1 Sol |
| pi | rebuilt from its unreleased main at `1e34c3b4` (for GPT-6.2 Sol; it reports itself as 1.5.2) | 1.0.0 |
| Runtime | the SDK engine (`runtime=sdk`, `lens_runtime=engine`, `wave=true`) | from before the SDK engine (its runs record no `engine`) |
| Defect judge | `gpt-6.1-sol` at high | `gpt-6-sol` at high (the dataset's published verdicts) |
| Comments the defect judge read | {i(f'comments.{NEW}.judged')} ({n[f'comments.{NEW}.per_pr']:.1f} per PR) | {i(f'comments.{OLD}.judged')} ({n[f'comments.{OLD}.per_pr']:.1f} per PR) |
| $ per PR (list price) | {n[f'cost.{NEW}.usd_per_pr']:.2f} | {n[f'cost.{OLD}.usd_per_pr']:.2f} |
| Median minutes per review | {n[f'cost.{NEW}.minutes_median']:.1f} | {n[f'cost.{OLD}.minutes_median']:.1f} |

Four things differ between the setups: the model, the QuickReview releases between the two builds, the
runtime under them (pi and the SDK engine, the table's two rows above), and the quiet default. The
comparison cannot say how much of a difference comes from the model alone.

## Tables

Every table is a `.parquet` file in this folder.

- `arms`: the two setups. `{NEW}`'s image, config, build commit (`qcr_commit` and its flags, as the card's
  `runs` states them), pi, model, defect judge and run directories; `{OLD}`'s `dataset_arm`
  (`{OLD_ARM}`), whose rows hold the rest. `pi` is the version each run recorded, `pi_source` where
  that pi came from when it is not that release (`{NEW}`'s image label `qcr.pi.main`), and `engine` the
  run's engine settings (null for `{OLD}`, whose runs record none).
- `cases`: one row per pull request of `{NEW}`: set, run, `status`, the review's `verdict`, cost and
  minutes (compare.usd_and_minutes, as the dataset's `reviews.cost_usd`), `n_posted` (the inline
  comments), whether the defect judge read it, and the judge's token usage.
- `reviews`: every finding `{NEW}` posted, with the defect judge's id for it (`comment_id`, C1..Cn). An
  inline comment has `inline` true, `index` from 0 in posting order, and its `path`, `line`, `side` and
  `body`; a finding posted in the review body has `inline` false, `index` null and its text as the judge
  read it. {i(f'comments.{NEW}.inline')} inline, {i(f'comments.{NEW}.body')} in the review body.
- `defect_verdicts`, `comment_verdicts`: the defect judge's verdicts on `{NEW}`, with the dataset's
  columns of the same names except `run_family`; `comment_verdicts.index` is the inline comment the
  judged row is (null for a finding in the review body). The answer-key defects are the dataset's
  `defects`.
- `elo_plans`: the four pairwise plans, in the order the ratings read them (`order`): the plan's sets,
  configurations and their `labels`, its rated `judges` (model, effort, output and time limits), and
  its note. Where the repositories and the judges ran is left out.
- `elo_units`: every unit of every plan: a pull request and which configuration is Review A and which
  Review B.
- `elo_judgments`: every judgment attempt, in each judge file's order (`line`): the unit, the judge,
  `status` (`ok`, `error`, `invalid`), the prompt hash, token usage, the error or the unparsed answer
  (`raw`), and for an ok judgment the winner (`A`, `B` or `tie`) and the reasoning of each category and
  the overall explanation. `set_aside` marks the {i('elo.deepseek.attempts.set_aside')} failed first
  DeepSeek attempts of pass 1 that were moved out of its judgment file so the units could be judged
  again with longer limits; no ok judgment was moved. `used_in_ratings` marks the judgments the ratings
  use: per plan, each judge's first ok judgment of a unit.
- `elo_ratings`, `elo_gaps`: the ratings refit from `elo_judgments` per `scope` (`gpt`, `deepseek`, and
  `combined`) and `category` (`overall` and the four categories): each configuration's Elo, 95%
  interval and record, and the gap between the two with its interval, separation, expected win rate
  and direct record.

## The numbers, and how each is recomputed

**The answer key** (`defect_verdicts`, the dataset's `defect_verdicts` of `{OLD_ARM}` and `defects`):
credit 1 for a defect found, 0.5 for one found in part, of {i('key.defects')} defects.

| Answer-key defects found | `{NEW}` | `{OLD}` |
|---|---:|---:|
{key}
| All (of {i('key.defects')}) | {h(f'key.{NEW}.all')} | {h(f'key.{OLD}.all')} |

**Comments** (`comment_verdicts`; the dataset's for `{OLD}`): of the {i(f'comments.{NEW}.judged')} comments
the defect judge read for `{NEW}`, {i(f'comments.{NEW}.on_key')} are on an answer-key defect and
{i(f'comments.{NEW}.not_correct')} ({n[f'comments.{NEW}.not_correct.pct']:.0f}%) not correct (graded
incorrect, partly correct or unverifiable; {i(f'comments.{NEW}.on_key_not_correct')} of them are also on an
answer-key defect); {i(f'comments.{NEW}.correct_off_key')} are correct and on no answer-key defect. For
`{OLD}`: {i(f'comments.{OLD}.judged')}, {i(f'comments.{OLD}.on_key')}, {i(f'comments.{OLD}.not_correct')}
({n[f'comments.{OLD}.not_correct.pct']:.0f}%; {i(f'comments.{OLD}.on_key_not_correct')} also on a defect) and
{i(f'comments.{OLD}.correct_off_key')}.

**Cost and time** (`cases`; the dataset's `reviews.cost_usd` and `minutes`): {n[f'cost.{NEW}.usd_per_pr']:.2f}
against {n[f'cost.{OLD}.usd_per_pr']:.2f} dollars per PR at list prices, a median
{n[f'cost.{NEW}.minutes_median']:.1f} against {n[f'cost.{OLD}.minutes_median']:.1f} minutes per review.

**Pairwise Elo** (`elo_judgments`, refit into `elo_ratings` and `elo_gaps`). A Bradley-Terry fit on the
Elo scale, ties counting half, with 95% intervals from {REPS:,} bootstrap resamples over pull requests
(`bench/aacr/elo/elo_rating.py`). Each judge is rated over every plan it judged: GPT-6.1 Sol on
{i('elo.gpt.games')} judgments over {i('elo.gpt.prs')} pull requests (every pair once in each order),
DeepSeek V4.1 Flash on {i('elo.deepseek.games')} over {i('elo.deepseek.prs')} (up to twice in each order;
it never returned a verdict on {i('elo.deepseek.prs_never')} pull requests). The pooled fit counts every
judge the same: each judge's games are repeated so that it contributes the same number of games per unit
judged ({i('elo.combined.games')} games). The gap of `{NEW}` over `{OLD}`, negative where `{OLD}` is ahead:

| Category | GPT-6.1 Sol judge | DeepSeek V4.1 Flash judge | Pooled |
|---|---:|---:|---:|
{elo}

Position: the GPT judge picked Review A in {i('elo.gpt.position.a_wins')} of its {i('elo.gpt.position.decided')}
decided verdicts ({n['elo.gpt.position.a_pct']:.0f}%), DeepSeek in {i('elo.deepseek.position.a_wins')} of
{i('elo.deepseek.position.decided')} ({n['elo.deepseek.position.a_pct']:.0f}%). Order: of the
{i('elo.gpt.order.pairs')} pairs the GPT judge judged in both orders, the same setup won both times in
{i('elo.gpt.order.same')}, the winner flipped in {i('elo.gpt.order.flipped')}, and {i('elo.gpt.order.with_tie')}
had a tie in one; for DeepSeek {i('elo.deepseek.order.same')}, {i('elo.deepseek.order.flipped')} and
{i('elo.deepseek.order.with_tie')} of {i('elo.deepseek.order.pairs')}. Agreement: on the
{i('elo.agreement.gpt~deepseek.units')} units both judges answered in the same plan, they named the same
winner {i('elo.agreement.gpt~deepseek.same')} times, opposite winners {i('elo.agreement.gpt~deepseek.opposite')}
times, and one tie {i('elo.agreement.gpt~deepseek.one_tie')} times. Attempts: the GPT judge
{i('elo.gpt.attempts')} ({i('elo.gpt.attempts.ok')} ok), DeepSeek {i('elo.deepseek.attempts')}
({i('elo.deepseek.attempts.ok')} ok, {i('elo.deepseek.attempts.not_ok')} timed out, cut off or unparsable).

## Limits

- The two runs had different defect judges: `gpt-6.1-sol` for `{NEW}`, `gpt-6-sol` for `{OLD}`'s
  published verdicts.
- Four things differ between the setups (the model, the QuickReview releases between the builds, the
  runtime under them, the quiet default), so no number here is of the model alone. `{NEW}`'s pi is
  rebuilt from an unreleased commit (`pi_source`), not a release a reader can install. One run each.
- The GPT-6.1 Sol judge is of the same family as both reviewers. It prefers Review B
  ({n['elo.gpt.position.b_pct']:.0f}% of its decided verdicts), which is why every pair was judged in both
  orders.
- DeepSeek never returned a verdict on {i('elo.deepseek.prs_never')} pull requests: on those every attempt
  failed (it timed out, or its output was cut off), so its ratings and the pooled ones are over the rest.
- The judges are AI models; no person has read the pairs. The answer key is AI-made and verified, not
  ground truth, and the Elo judges were told so.
"""


# ---------------------------------------------------------------------------------------------------- CLI

def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "build":
        ap = argparse.ArgumentParser(prog="gpt62_sol.py build", description=build.__doc__)
        ap.add_argument("--runs-dir", required=True, help="the bench runs dir (it holds s62-* and final1-*)")
        ap.add_argument("--elo-dir", required=True, help="the dir holding the four Elo plan dirs (PLANS)")
        ap.add_argument("--data", required=True, help="a built dataset (data/ with defects and final1's rows), "
                        "for the README's numbers")
        ap.add_argument("--repo", required=True, help="a QuickReview checkout with origin/main fetched")
        ap.add_argument("--out", required=True, help="the new `gpt62_sol` folder")
        build(ap.parse_args(sys.argv[2:]))
        return
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", required=True, help="the Hugging Face dataset dir (it holds data/ and gpt62_sol/)")
    ap.add_argument("--manifest", default=MANIFEST)
    ap.add_argument("--json", help="also write the checks to this JSON file")
    a = ap.parse_args()
    cs = checks(a.data, a.manifest)
    for c in cs:
        print(f"{'ok  ' if c['ok'] else 'FAIL'} {c['check']}" + ("" if c["ok"] else f": got {c['got']}"))
    print(f"{sum(c['ok'] for c in cs)} of {len(cs)} pass")
    if a.json:
        with open(a.json, "w") as f:
            json.dump(cs, f, indent=1, default=str)
    sys.exit(0 if all(c["ok"] for c in cs) else 1)


if __name__ == "__main__":
    main()
