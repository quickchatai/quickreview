#!/usr/bin/env python3
"""The dataset's state-machine study: `state_machines/`, built, checked and recomputed. No model call.

    uv run --no-project --with pyarrow python bench/aacr/recompute/state_machines.py --data <hf-dataset> [--json OUT]
    uv run --no-project --with pyarrow python bench/aacr/recompute/state_machines.py build --runs-dir <runs> \\
        --labels <label dir> --positives <positives.json> --earlier <earlier arms' score.json> \\
        --figures <figure dir> --repo <checkout> [--key <answer key dir>] --out <dir>/state_machines \\
        [--manifest bench/aacr/hf/state-machines.sha256]

The study compares two AACR-Bench runs on 34 pull requests that hold labelled state defects, reviewer and
judge gpt-6.1-sol (judge effort high): the state-machine review (`sm4-p`, `review.profile=state-machines`
on public main) and the default review with its automatic state lens off (`sm1-c`, an earlier build from a
branch that was never published). A third run, `sm5-a`, is a preliminary addition: the state-machine review
with openai-codex/gpt-6.2-astra as the reviewer, the same judge, and a 20-minute lens deadline (the shipped
default is 8); the study labelled none of its comments and pooled none of its bugs. AI readers relabelled
the 186 answer-key defects of those PRs as state bugs or not, labelled every comment of the state review
and every comment of the default review the judge matched to no answer-key defect, and pooled the real state bugs either review posted that the answer key
does not list. The folder holds the three runs' posted comments and judge verdicts, every label, and the
earlier builds' found flags on the strict state defects; README.md (written by `build`) says what each
table holds.

checks() is what the export's validation.json and the claims verifier's release checks hold for it:

  - every file of `state_machines/` is the committed manifest's (bench/aacr/hf/state-machines.sha256),
    none missing, none extra, none differing;
  - every table has exactly its listed columns (ids, verdicts, our labels and reasons, QuickReview's own
    posted comments; never an answer-key defect's text);
  - the rows are whole: every run reviewed and was judged on the same PRs, one verdict per run on every
    labelled answer-key defect, every judged comment is a posted one (inline, or a finding in the review
    body), every labelled comment is an inline one of the two labelled runs, the default review's labelled
    comments are exactly its inline comments the judge matched to no answer-key defect, and every unlisted
    bug's found flags are its listed inline comments;
  - README.md is readme() of numbers(): every number the README prints, recomputed from the tables;
  - no label text of ours repeats QUOTE_WORDS words in a row of an answer-key defect's own text (the
    dataset's `defects`, beside the folder);
  - every number the study's write-up prints (POST), recomputed from the tables alone (numbers()).

claim_metrics.StateMachines gives numbers() by name to the claims verifier (`state_machines` keys). Tables
are `.parquet` or `.jsonl` (the tests' fixtures).
"""
from __future__ import annotations

import argparse
import collections
import glob
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from typing import Dict, List, Optional

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from tables import data_dir_of, load_table  # noqa: E402

FOLDER = "state_machines"
MANIFEST = os.path.join(os.path.dirname(HERE), "hf", "state-machines.sha256")
SETS = ("smoke10", "dev10", "holdout10", "fresh10", "rest145")
STATE, DEFAULT = "sm4-p", "sm1-c"
ARMS = (STATE, DEFAULT)  # the study's two runs: the ones its labels and its pool cover
# a preliminary third run: the state-machine review with another reviewer model; its comments, verdicts and
# costs are in the folder, but the study labelled none of its comments and pooled none of its bugs
ASTRA = "sm5-a"
RUNS = (*ARMS, ASTRA)
# the earlier builds whose found flags on the strict state defects the folder carries (derived numbers only;
# their reviews are not in it)
EARLIER = {
    "sm1-s4": "the state-machine review's first version: four state lenses on every change, the other four on a signal",
    "sm1-s8": "all eight state lenses on every change, normal effort",
    "sm1-s8d": "all eight state lenses on every change, higher effort, before the lookup tool",
    "sm1-r": "the eight state lenses added to the default review, in one run (an earlier build)",
}
CLASSES = ("event-order", "stale-copy", "lifecycle-order", "stored-state", "stuck-state", "unhandled-state",
           "unchecked-transition", "impossible-states")
# the labels' short spellings of a class, folded to the class's name
CLASS_SPELLINGS = {"lifecycle": "lifecycle-order", "stuck": "stuck-state", "unhandled": "unhandled-state",
                   "impossible": "impossible-states", "transition": "unchecked-transition",
                   "event": "event-order", "stale": "stale-copy", "stored": "stored-state"}
MISS_CAUSES = ("site_read_nothing_reported", "reported_a_different_problem", "defect_not_real_or_unreachable")
FIGURES = ("fig1-every-known-state-bug.svg", "fig2-outside-the-answer-key.svg", "fig3-builds-on-the-answer-key.svg",
           "fig4-by-kind.svg")

# Every table of the folder, with exactly its columns: no column holds an answer-key defect's text.
TABLES: Dict[str, tuple] = {
    "arms": ("arm_id", "display_name", "image", "image_id", "config", "profile", "qcr_commit",
             "qcr_commit_on_public_main", "qcr_commit_match", "qcr_commit_dirty", "pi", "reviewer_model",
             "judge_model", "runs", "prs", "note"),
    "cases": ("arm_id", "instance_id", "set", "run", "status", "verdict", "usd", "minutes", "n_posted", "judged",
              "judge_input_tokens", "judge_output_tokens", "judge_cache_read_tokens"),
    "reviews": ("arm_id", "instance_id", "index", "inline", "path", "line", "side", "body", "comment_id"),
    "defect_verdicts": ("arm_id", "instance_id", "judge", "key_version", "defect_id", "verdict", "credit",
                        "comment_ids", "why"),
    "comment_verdicts": ("arm_id", "instance_id", "judge", "comment_id", "index", "grade", "defect_id", "new_defect",
                         "why"),
    "state_labels": ("instance_id", "defect_id", "verdict", "klass", "how", "old45", "reachable", "votes"),
    "comment_state_labels": ("arm_id", "instance_id", "index", "title", "verdict", "klass", "reason",
                             "first_verdict", "second_read_verdict", "second_read_agrees", "second_read_reason",
                             "key_defect", "real_if_unlisted"),
    "pooled_bugs": ("bug_id", "instance_id", "local_id", "source", "klass", "state_found", "default_found",
                    "statement", "state_review_comments", "default_review_comments", "check_reason",
                    "blind_verdict", "blind_agrees", "blind_reason"),
    "misses": ("instance_id", "defect_id", "cause", "owning_lens", "planned_lenses", "what_would_have_caught_it",
               "second_read_verdict", "second_read_agrees", "second_read_reason", "relabel_note"),
    "earlier_arms": ("arm_id", "description", "instance_id", "defect_id", "found"),
}

# The label texts that are ours (a reader's words): none may repeat QUOTE_WORDS words in a row of an answer-key
# defect's own text (its title, statement, evidence or notes), which the dataset's `defects` table holds. `build`
# replaces such a run with QUOTED; checks() fails a folder that holds one. "votes.reason" is a field of each vote.
LABEL_TEXT: Dict[str, tuple] = {
    "state_labels": ("votes.reason",),
    "comment_state_labels": ("reason", "second_read_reason"),
    "pooled_bugs": ("statement", "check_reason", "blind_reason"),
    "misses": ("what_would_have_caught_it", "second_read_reason", "relabel_note"),
}
QUOTE_WORDS = 10
QUOTED = "[words of the answer key's defect]"

# The preliminary GPT-6.2 Astra run's numbers, as the card prints them: answer-key recall on the reachable
# strict state defects (verdict found) and its share, the answer-key defects of every kind it found, its inline
# comments and comments per PR, and its list-price dollars per PR (compare.usd_and_minutes, as for the others).
ASTRA_POST: Dict[str, object] = {"key_found": 52, "of": 55, "share": 95, "defects_found": 152, "defects_of": 186,
                                 "comments": 448, "per_pr": 13.2, "usd_per_pr": 21.06}

# The numbers the study's write-up prints, each recomputed by numbers() from the tables (checks() compares).
# Percentages are rounded to whole numbers, comments per PR to one decimal, dollars to cents; the cost of both
# runs is their exact combined cost per PR, rounded to cents (not the sum of the two rounded costs).
POST: Dict[str, object] = {
    "prs": 34,
    "relabel": {"total": 186, "state": 56, "borderline": 2, "not": 128, "reachable": 55, "state_not_old45": 21},
    "old45": {"total": 45, "state": 35, "borderline": 2, "not": 8, "found_default": 36},
    "key_found": {STATE: 44, DEFAULT: 45, "sm1-s4": 38, "sm1-s8": 39, "sm1-s8d": 43, "sm1-r": 46},
    "key_only": {"state_not_default": 0, "default_not_state": 1,
                 "default_not_state_ids": ["immich-app__immich@b7a1255#D2"]},
    "pool": {"total": 105, "key": 55, "unlisted": 50, STATE: 89, DEFAULT: 75, "union": 95},
    "unlisted": {"both": 25, "state_only": 20, "default_only": 5, "blind_checked": 25, "blind_agree": 25},
    "classes": {"event-order": [31, 29, 22], "stale-copy": [25, 18, 16], "lifecycle-order": [18, 17, 13],
                "stored-state": [13, 8, 10], "stuck-state": [8, 7, 7], "unhandled-state": [4, 4, 3],
                "unchecked-transition": [3, 3, 3], "impossible-states": [3, 3, 1]},
    "shares": {"key": {STATE: 80, DEFAULT: 82, "sm1-s4": 69, "sm1-s8": 71, "sm1-s8d": 78},
               "pool": {STATE: 85, DEFAULT: 71, "union": 90}, "state_comments_not": 20},
    "comments": {STATE: 159, "state": 96, "borderline": 31, "not": 32, "not_judged_correct": 28, DEFAULT: 397,
                 "per_pr_state": 4.7, "per_pr_default": 11.7, "per_pr_union": 16.4},
    "default_found_any": {"found": 161, "of": 186},
    "misses": {"total": 12, "real": 11, "site_read_nothing_reported": 5, "reported_a_different_problem": 6,
               "defect_not_real_or_unreachable": 1},
    "cost": {"usd_per_pr_state": 2.78, "usd_per_pr_default": 2.77, "usd_per_pr_both": 5.56},
    "astra": ASTRA_POST,
}


# ---------------------------------------------------------------------------------------------------- reading

def root_of(path: str) -> str:
    """The dataset root of a dataset dir or its data/ dir: the dir that holds data/ (and state_machines/)."""
    d = os.path.abspath(data_dir_of(path))
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
    """The files of a `state_machines` folder against the manifest (paths `state_machines/...`): missing,
    extra and differing (sha256), each sorted."""
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
    """A `sha256sum` manifest of a dataset root's state_machines/ (paths relative to the root), sorted."""
    folder = os.path.join(root, FOLDER)
    rows = []
    for d, _, files in os.walk(folder):
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
    folder = os.path.join(root_of(root), FOLDER)
    out = []
    for t in TABLES:
        if os.path.exists(os.path.join(folder, f"{t}.parquet")):
            import pyarrow.parquet as pq
            out.append((f"{FOLDER}/{t}.parquet", pq.ParquetFile(os.path.join(folder, f"{t}.parquet")).metadata.num_rows))
        elif os.path.exists(os.path.join(folder, f"{t}.jsonl")):
            out.append((f"{FOLDER}/{t}.jsonl", len(load_table(folder, t))))
    return out


# ---------------------------------------------------------------------------------------------------- numbers

def numbers(path: str) -> Dict[str, object]:
    """Every number of the study, by name, from the folder's tables alone (`path`: the dataset root, its
    data/ dir or the folder itself). Percentages are x100, money in dollars, time in minutes."""
    return numbers_of(tables_of(path))


def tables_of(path: str) -> Dict[str, List[dict]]:
    """Every table of the folder (`path`: the dataset root, its data/ dir or the folder itself)."""
    d = path if any(os.path.exists(os.path.join(path, f"pooled_bugs.{x}")) for x in ("parquet", "jsonl")) else folder_of(path)
    return {n: load_table(d, n) for n in TABLES}


def numbers_of(t: Dict[str, List[dict]]) -> Dict[str, object]:
    """numbers() from the tables in hand. Every value is a number, except the `.ids` keys (lists)."""
    out: Dict[str, object] = {}

    # the strict relabel of the answer-key defects
    labels = t["state_labels"]
    strict = {(r["instance_id"], r["defect_id"]) for r in labels if r["verdict"] == "state_machine"}
    reach = {(r["instance_id"], r["defect_id"]) for r in labels if r["verdict"] == "state_machine" and r["reachable"]}
    old = [r for r in labels if r["old45"]]
    out["relabel.total"] = len(labels)
    for v, name in (("state_machine", "state"), ("borderline", "borderline"), ("not", "not")):
        out[f"relabel.{name}"] = sum(1 for r in labels if r["verdict"] == v)
        out[f"old45.{name}"] = sum(1 for r in old if r["verdict"] == v)
    out["relabel.reachable"] = len(reach)
    out["relabel.tiebreak"] = sum(1 for r in labels if r["how"] == "tiebreak")
    out["relabel.state_not_old45"] = sum(1 for r in labels if r["verdict"] == "state_machine" and not r["old45"])
    out["old45.total"] = len(old)
    out["prs.with_old45"] = len({r["instance_id"] for r in old})
    out["prs.with_strict_state"] = len({r["instance_id"] for r in labels if r["verdict"] == "state_machine"})

    # the answer key: the judge's verdict `found` (a partial is not a find here)
    found = {a: {(r["instance_id"], r["defect_id"]) for r in t["defect_verdicts"]
                 if r["arm_id"] == a and r["verdict"] == "found"} for a in RUNS}
    for a in RUNS:
        out[f"key.{a}"] = len(found[a] & reach)
        out[f"key.{a}.pct"] = 100.0 * out[f"key.{a}"] / len(reach) if reach else None
        out[f"key_old45.{a}"] = len(found[a] & {(r["instance_id"], r["defect_id"]) for r in old})
        out[f"defects.{a}.found"] = len({k for k in found[a]})
        out[f"defects.{a}.partial"] = sum(1 for r in t["defect_verdicts"] if r["arm_id"] == a and r["verdict"] == "partial")
    out["defects.total"] = len(labels)
    out["key.state_not_default"] = len((found[STATE] - found[DEFAULT]) & reach)
    out["key.default_not_state"] = len((found[DEFAULT] - found[STATE]) & reach)
    out["key.default_not_state.ids"] = sorted(f"{p}#{d}" for p, d in (found[DEFAULT] - found[STATE]) & reach)
    out[f"key.{ASTRA}.missed.ids"] = sorted(f"{p}#{d}" for p, d in reach - found[ASTRA])
    out[f"key.{ASTRA}.not_{STATE}"] = len((found[ASTRA] - found[STATE]) & reach)
    out[f"key.{STATE}.not_{ASTRA}"] = len((found[STATE] - found[ASTRA]) & reach)
    for a in EARLIER:
        f = {(r["instance_id"], r["defect_id"]) for r in t["earlier_arms"] if r["arm_id"] == a and r["found"]}
        out[f"key.{a}"] = len(f & reach)
        out[f"key.{a}.pct"] = 100.0 * out[f"key.{a}"] / len(reach) if reach else None

    # the pool: the reachable strict defects (found = the judge's verdicts) and the unlisted bugs (our labels)
    pool = t["pooled_bugs"]
    key_rows = [b for b in pool if b["source"] == "answer-key"]
    unl = [b for b in pool if b["source"] == "unlisted"]
    out["pool.total"], out["pool.key"], out["pool.unlisted"] = len(pool), len(key_rows), len(unl)

    def got(b, a):
        if b["source"] == "answer-key":
            return (b["instance_id"], b["local_id"]) in found[a]
        return bool(b["state_found" if a == STATE else "default_found"])
    for a in ARMS:
        out[f"pool.{a}"] = sum(1 for b in pool if got(b, a))
        out[f"pool.{a}.pct"] = 100.0 * out[f"pool.{a}"] / len(pool) if pool else None
        out[f"pool.unlisted.{a}"] = sum(1 for b in unl if got(b, a))
    out["pool.union"] = sum(1 for b in pool if got(b, STATE) or got(b, DEFAULT))
    out["pool.union.pct"] = 100.0 * out["pool.union"] / len(pool) if pool else None
    out["pool.key_is_reachable_strict"] = float({(b["instance_id"], b["local_id"]) for b in key_rows} == reach)
    out["pool.key_flags_agree"] = float(all(bool(b["state_found"]) == got(b, STATE) and bool(b["default_found"]) == got(b, DEFAULT)
                                            for b in key_rows))
    out["unlisted.both"] = sum(1 for b in unl if got(b, STATE) and got(b, DEFAULT))
    out["unlisted.state_only"] = sum(1 for b in unl if got(b, STATE) and not got(b, DEFAULT))
    out["unlisted.default_only"] = sum(1 for b in unl if got(b, DEFAULT) and not got(b, STATE))
    one = [b for b in unl if got(b, STATE) != got(b, DEFAULT)]
    out["unlisted.blind_checked"] = sum(1 for b in one if b["blind_verdict"])
    out["unlisted.blind_agree"] = sum(1 for b in one if b["blind_verdict"] and b["blind_agrees"]
                                      and b["blind_verdict"] == ("state" if got(b, STATE) else "default"))
    for k in CLASSES:
        rows = [b for b in pool if b["klass"] == k]
        out[f"class.{k}.pool"] = len(rows)
        out[f"class.{k}.{STATE}"] = sum(1 for b in rows if got(b, STATE))
        out[f"class.{k}.{DEFAULT}"] = sum(1 for b in rows if got(b, DEFAULT))
    out["class.other"] = sum(1 for b in pool if b["klass"] not in CLASSES)

    # the comments
    prs = {a: {r["instance_id"] for r in t["cases"] if r["arm_id"] == a} for a in RUNS}
    out["prs"] = len(prs[STATE]) if all(prs[a] == prs[STATE] for a in RUNS) else None
    for a in RUNS:  # the inline comments; a finding posted in the review body is a row with `inline` false
        out[f"comments.{a}"] = sum(1 for r in t["reviews"] if r["arm_id"] == a and r["inline"])
        out[f"comments.{a}.body"] = sum(1 for r in t["reviews"] if r["arm_id"] == a and not r["inline"])
        out[f"comments.{a}.per_pr"] = out[f"comments.{a}"] / len(prs[a]) if prs[a] else None
    out["comments.union.per_pr"] = (out[f"comments.{STATE}"] + out[f"comments.{DEFAULT}"]) / out["prs"] if out["prs"] else None
    out["comments.state_share_of_default"] = (100.0 * out[f"comments.{STATE}"] / out[f"comments.{DEFAULT}"]
                                              if out[f"comments.{DEFAULT}"] else None)
    lab = {a: [r for r in t["comment_state_labels"] if r["arm_id"] == a] for a in ARMS}
    for a in ARMS:
        for v, name in (("state_machine", "state"), ("borderline", "borderline"), ("not", "not")):
            out[f"comments.{a}.{name}"] = sum(1 for r in lab[a] if r["verdict"] == v)
        out[f"comments.{a}.labelled"] = len(lab[a])
    out[f"comments.{STATE}.state.pct"] = (100.0 * out[f"comments.{STATE}.state"] / len(lab[STATE])) if lab[STATE] else None
    out[f"comments.{STATE}.not.pct"] = (100.0 * out[f"comments.{STATE}.not"] / len(lab[STATE])) if lab[STATE] else None
    out[f"comments.{STATE}.second_reads"] = sum(1 for r in lab[STATE] if r["second_read_verdict"])
    out[f"comments.{STATE}.second_read_changed"] = sum(1 for r in lab[STATE] if r["second_read_verdict"]
                                                       and r["second_read_verdict"] != r["first_verdict"])
    grade = {(r["arm_id"], r["instance_id"], r["index"]): r["grade"] for r in t["comment_verdicts"] if r["index"] is not None}
    out[f"comments.{STATE}.not_judged_correct"] = sum(
        1 for r in lab[STATE] if r["verdict"] == "not"
        and str(grade.get((STATE, r["instance_id"], r["index"]))).startswith("correct"))
    out[f"comments.{DEFAULT}.unmatched"] = sum(
        1 for r in t["comment_verdicts"] if r["arm_id"] == DEFAULT and r["index"] is not None and not r["defect_id"])

    # the misses: the state review's, on the strict state defects
    miss = t["misses"]
    out["misses.total"] = len(miss)
    out["misses.real"] = sum(1 for m in miss if m["cause"] != "defect_not_real_or_unreachable")
    for c in MISS_CAUSES:
        out[f"misses.{c}"] = sum(1 for m in miss if m["cause"] == c)
    out["misses.are_strict_not_found"] = float({(m["instance_id"], m["defect_id"]) for m in miss} == strict - found[STATE])

    # cost and time: compare.usd_and_minutes per case, as the export prices every review
    for a in RUNS:
        rows = [r for r in t["cases"] if r["arm_id"] == a]
        usd = [r["usd"] for r in rows]
        mins = [r["minutes"] for r in rows]
        out[f"cost.{a}.usd_total"] = sum(usd) if rows and None not in usd else None
        out[f"cost.{a}.usd_per_pr"] = out[f"cost.{a}.usd_total"] / len(rows) if out[f"cost.{a}.usd_total"] is not None else None
        out[f"cost.{a}.minutes_per_pr"] = sum(mins) / len(rows) if rows and None not in mins else None
    both = (out[f"cost.{STATE}.usd_per_pr"], out[f"cost.{DEFAULT}.usd_per_pr"])
    out["cost.union.usd_per_pr"] = sum(both) if None not in both else None
    return out


def _r(x, n):
    return None if x is None else round(x, n)


def _pct(x):
    return None if x is None else int(round(x))


def post_values(n: Dict[str, object]) -> Dict[str, object]:
    """numbers() in POST's shape and rounding (POST's comment)."""
    g = lambda k: n.get(k)  # noqa: E731
    return {
        "prs": g("prs"),
        "relabel": {k: g(f"relabel.{k}") for k in ("total", "state", "borderline", "not", "reachable", "state_not_old45")},
        "old45": {**{k: g(f"old45.{k}") for k in ("total", "state", "borderline", "not")},
                  "found_default": g(f"key_old45.{DEFAULT}")},
        "key_found": {a: g(f"key.{a}") for a in (STATE, DEFAULT, *EARLIER)},
        "key_only": {"state_not_default": g("key.state_not_default"), "default_not_state": g("key.default_not_state"),
                     "default_not_state_ids": g("key.default_not_state.ids")},
        "pool": {"total": g("pool.total"), "key": g("pool.key"), "unlisted": g("pool.unlisted"), STATE: g(f"pool.{STATE}"),
                 DEFAULT: g(f"pool.{DEFAULT}"), "union": g("pool.union")},
        "unlisted": {k: g(f"unlisted.{k}") for k in ("both", "state_only", "default_only", "blind_checked", "blind_agree")},
        "classes": {k: [g(f"class.{k}.pool"), g(f"class.{k}.{STATE}"), g(f"class.{k}.{DEFAULT}")] for k in CLASSES},
        "shares": {"key": {a: _pct(g(f"key.{a}.pct")) for a in (STATE, DEFAULT, "sm1-s4", "sm1-s8", "sm1-s8d")},
                   "pool": {STATE: _pct(g(f"pool.{STATE}.pct")), DEFAULT: _pct(g(f"pool.{DEFAULT}.pct")),
                            "union": _pct(g("pool.union.pct"))},
                   "state_comments_not": _pct(g(f"comments.{STATE}.not.pct"))},
        "comments": {STATE: g(f"comments.{STATE}"), "state": g(f"comments.{STATE}.state"),
                     "borderline": g(f"comments.{STATE}.borderline"), "not": g(f"comments.{STATE}.not"),
                     "not_judged_correct": g(f"comments.{STATE}.not_judged_correct"), DEFAULT: g(f"comments.{DEFAULT}"),
                     "per_pr_state": _r(g(f"comments.{STATE}.per_pr"), 1),
                     "per_pr_default": _r(g(f"comments.{DEFAULT}.per_pr"), 1),
                     "per_pr_union": _r(g("comments.union.per_pr"), 1)},
        "default_found_any": {"found": g(f"defects.{DEFAULT}.found"), "of": g("defects.total")},
        "misses": {"total": g("misses.total"), "real": g("misses.real"), **{c: g(f"misses.{c}") for c in MISS_CAUSES}},
        "cost": {"usd_per_pr_state": _r(g(f"cost.{STATE}.usd_per_pr"), 2),
                 "usd_per_pr_default": _r(g(f"cost.{DEFAULT}.usd_per_pr"), 2),
                 "usd_per_pr_both": _r(g("cost.union.usd_per_pr"), 2)},
        "astra": {"key_found": g(f"key.{ASTRA}"), "of": g("relabel.reachable"), "share": _pct(g(f"key.{ASTRA}.pct")),
                  "defects_found": g(f"defects.{ASTRA}.found"), "defects_of": g("defects.total"),
                  "comments": g(f"comments.{ASTRA}"), "per_pr": _r(g(f"comments.{ASTRA}.per_pr"), 1),
                  "usd_per_pr": _r(g(f"cost.{ASTRA}.usd_per_pr"), 2)},
    }


# ---------------------------------------------------------------------------------------------------- checks

# What each POST group's check states (validation.json's `check` text), in order.
NUMBER_CHECKS = (
    ("prs", "every run reviewed the same pull requests"),
    ("relabel", "the strict relabel of the answer-key defects: state, borderline and not, the state ones "
                "reachable at head, and the state ones not on the earlier list of 45"),
    ("old45", "the earlier list of 45 state defects under the strict relabel, and how many of them the default "
              "review found"),
    ("key_found", "answer-key recall on the reachable strict state defects (judge verdict found), of the two runs "
                  "and the four earlier builds"),
    ("key_only", "the reachable strict state defects one run found and the other did not, and which"),
    ("pool", "the pool of known real state bugs (answer key + unlisted) and how many of them each run and either "
             "run found; the answer-key part's found flags are the judge's verdicts"),
    ("unlisted", "the unlisted bugs found by both runs or by one, and the one-sided ones re-checked blind"),
    ("classes", "per class of state bug: pool, state review, default review"),
    ("shares", "the percentages: answer-key recall, the pool found, and the state review's comments about "
               "something else"),
    ("comments", "the inline comments: the state review's by label after the second reads, its not-state ones the "
                 "judge graded correct, the default review's, and comments per pull request"),
    ("default_found_any", "the answer-key defects of every kind the default review found"),
    ("misses", "the state review's misses on the strict state defects, by cause"),
    ("cost", "list-price dollars per pull request (compare.usd_and_minutes), and both runs' exact combined cost "
             "rounded"),
    ("astra", f"the preliminary GPT-6.2 Astra run ({ASTRA}): answer-key recall on the reachable strict state "
              "defects and its share, the answer-key defects of every kind it found, its inline comments and "
              "comments per pull request, and list-price dollars per pull request (compare.usd_and_minutes)"),
)
README_CHECK = "README.md is the README its tables give (state_machines.readme of numbers())"
QUOTE_CHECK = (f"no label text of ours repeats {QUOTE_WORDS} words in a row of an answer-key defect's text "
               "(the dataset's `defects`)")


def checks(root: str, manifest_path: str = MANIFEST, post: Optional[Dict[str, object]] = None) -> List[dict]:
    """The state-machine study's checks of validation.json (the module docstring), on a dataset root."""
    post = POST if post is None else post
    root = root_of(root)
    folder = os.path.join(root, FOLDER)
    out: List[dict] = []

    def check(what, got, want):
        out.append({"check": f"{FOLDER}: {what}", "got": got, "want": want, "ok": got == want})

    try:
        man = manifest_problems(folder, read_manifest(manifest_path))
    except OSError as e:
        man = {"error": str(e)}
    check("every file is the committed manifest's (bench/aacr/hf/state-machines.sha256), none missing, extra or "
          "differing", man, {"missing": [], "extra": [], "differs": []})
    if not os.path.isdir(folder):
        why = f"no {FOLDER}/ beside the tables"
        check("every table has exactly its listed columns (no answer-key defect text)", why, {})
        check(WHOLE_CHECK, why, {})
        check(README_CHECK, why, True)
        check(QUOTE_CHECK, why, {})
        for key, what in NUMBER_CHECKS:
            check(what, why, post.get(key))
        return out
    try:
        cols = {t: c for t, want in TABLES.items() if sorted(c := columns_of(folder, t)) != sorted(want)}
    except (SystemExit, OSError, ValueError) as e:
        cols = {"error": str(e)}
    check("every table has exactly its listed columns (no answer-key defect text)", cols, {})
    try:
        whole = whole_problems(folder)
    except (SystemExit, OSError, ValueError, KeyError, TypeError) as e:
        whole = {"error": str(e)}
    check(WHOLE_CHECK, whole, {})
    try:
        n = numbers(folder)
    except (SystemExit, OSError, ValueError, KeyError, TypeError) as e:
        n = {"error": str(e)}
    try:
        with open(os.path.join(folder, "README.md"), encoding="utf-8") as f:
            same = f.read() == readme(n)
    except (OSError, ValueError, KeyError, TypeError) as e:
        same = {"error": str(e)}
    check(README_CHECK, same, True)
    try:
        quoted = quote_problems(root)
    except (SystemExit, OSError, ValueError, KeyError, TypeError) as e:
        quoted = {"error": str(e)}
    check(QUOTE_CHECK, quoted, {})
    try:
        got = post_values(n) if "error" not in n else {k: n for k, _ in NUMBER_CHECKS}
    except (SystemExit, OSError, ValueError, KeyError, TypeError) as e:
        got = {k: {"error": str(e)} for k, _ in NUMBER_CHECKS}
    for key, what in NUMBER_CHECKS:
        check(what, got.get(key), post.get(key))
    return out


WHOLE_CHECK = ("the rows are whole: every run judged on the same pull requests, one verdict per run on every "
               "labelled answer-key defect, every judged comment a posted one (inline or in the review body), every "
               "labelled comment an inline one of the two labelled runs, the default review's labelled comments "
               "exactly its inline comments matched to no answer-key defect, and every unlisted bug found exactly by "
               "the reviews whose inline comments it lists")


def whole_problems(folder: str) -> Dict[str, object]:
    """The folder's rows against each other: {problem: examples}, empty when whole."""
    t = {n: load_table(folder, n) for n in TABLES}
    bad: Dict[str, object] = {}
    prs = {a: sorted({r["instance_id"] for r in t["cases"] if r["arm_id"] == a}) for a in RUNS}
    if any(prs[a] != prs[STATE] for a in RUNS) or not prs[STATE]:
        bad["cases: the runs' pull requests differ"] = {a: len(prs[a]) for a in RUNS}
    unjudged = sorted(f"{r['arm_id']}/{r['instance_id']}" for r in t["cases"] if not r["judged"])
    if unjudged:
        bad["cases: not judged"] = unjudged[:10]
    labelled = sorted((r["instance_id"], r["defect_id"]) for r in t["state_labels"])
    for a in RUNS:
        got = sorted((r["instance_id"], r["defect_id"]) for r in t["defect_verdicts"] if r["arm_id"] == a)
        if got != labelled:
            bad[f"defect_verdicts: {a} is not one verdict on each labelled defect"] = {
                "missing": len(set(labelled) - set(got)), "extra": len(set(got) - set(labelled)),
                "repeated": len(got) - len(set(got))}
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
    keys = {(r["arm_id"], r["instance_id"], r["index"]) for r in inline}
    lab = [(r["arm_id"], r["instance_id"], r["index"]) for r in t["comment_state_labels"]]
    stray = sorted(f"{a}/{p}#{i}" for a, p, i in set(lab) - keys)
    if stray or len(lab) != len(set(lab)):
        bad["comment_state_labels: a label of no inline comment, or two labels of one"] = {
            "stray": stray[:10], "repeated": len(lab) - len(set(lab))}
    other = sorted(f"{a}/{p}#{i}" for a, p, i in set(lab) & keys if a not in ARMS)
    if other:
        bad["comment_state_labels: a label of a run the study did not label"] = other[:10]
    state_posted = {k for k in keys if k[0] == STATE}
    if {k for k in lab if k[0] == STATE} != state_posted:
        bad["comment_state_labels: the state review's labels are not every one of its inline comments"] = {
            "unlabelled": len(state_posted - set(lab))}
    unmatched = {(r["arm_id"], r["instance_id"], r["index"]) for r in t["comment_verdicts"]
                 if r["arm_id"] == DEFAULT and r["index"] is not None and not r["defect_id"]}
    if {k for k in lab if k[0] == DEFAULT} != unmatched:
        bad["comment_state_labels: the default review's labels are not exactly its unmatched inline comments"] = {
            "missing": len(unmatched - set(lab)), "extra": len({k for k in lab if k[0] == DEFAULT} - unmatched)}
    n = numbers_of(t)
    if not n["pool.key_is_reachable_strict"]:
        bad["pooled_bugs: the answer-key rows are not the reachable strict state defects"] = True
    if not n["pool.key_flags_agree"]:
        bad["pooled_bugs: an answer-key row's found flags differ from the judge's verdicts"] = True
    if not n["misses.are_strict_not_found"]:
        bad["misses: not exactly the strict state defects the state review did not find"] = True
    if n["class.other"]:
        bad["pooled_bugs: a class outside the eight"] = n["class.other"]
    flags = []
    for b in t["pooled_bugs"]:
        if b["source"] != "unlisted":
            continue
        for a, flag, lst in ((STATE, "state_found", "state_review_comments"),
                             (DEFAULT, "default_found", "default_review_comments")):
            ix = b[lst] or []
            if bool(b[flag]) != bool(ix) or any((a, b["instance_id"], i) not in keys for i in ix):
                flags.append(f"{b['bug_id']} {flag}")
    if flags:
        bad["pooled_bugs: an unlisted bug's found flag is not its listed inline comments"] = sorted(flags)[:10]
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
    return bad


# ---------------------------------------------------------------------------------------------------- quotes

def _tokens(text: str) -> List[tuple]:
    """(start, end, word) of every word of a text (a run of letters, digits and `_`), lower case: punctuation
    and code marks between words do not hide a repeat."""
    return [(m.start(), m.end(), m.group().lower()) for m in re.finditer(r"\w+", text or "")]


def shingles(texts) -> set:
    """Every run of QUOTE_WORDS words of the texts."""
    out = set()
    for x in texts:
        ws = [w for _, _, w in _tokens(x if isinstance(x, str) else "")]
        out |= {tuple(ws[i:i + QUOTE_WORDS]) for i in range(len(ws) - QUOTE_WORDS + 1)}
    return out


def _quoted_runs(text: str, key: set) -> List[tuple]:
    """(start, end) of each stretch of a text made of runs of QUOTE_WORDS words that are in `key`."""
    tok = _tokens(text)
    hit = [False] * len(tok)
    for i in range(len(tok) - QUOTE_WORDS + 1):
        if tuple(w for _, _, w in tok[i:i + QUOTE_WORDS]) in key:
            for k in range(i, i + QUOTE_WORDS):
                hit[k] = True
    runs, i = [], 0
    while i < len(tok):
        if hit[i]:
            k = i
            while k + 1 < len(tok) and hit[k + 1]:
                k += 1
            runs.append((tok[i][0], tok[k][1]))
            i = k + 1
        else:
            i += 1
    return runs


def unquote(text: Optional[str], key: set) -> Optional[str]:
    """The text with every stretch it shares with `key` (shingles()) replaced by QUOTED."""
    if not isinstance(text, str):
        return text
    for a, b in reversed(_quoted_runs(text, key)):
        text = text[:a] + QUOTED + text[b:]
    return text


def _label_texts(table: str, r: dict):
    """(field, text) of a row's label texts (LABEL_TEXT)."""
    for f in LABEL_TEXT.get(table, ()):
        head, _, sub = f.partition(".")
        if sub:
            for i, v in enumerate(r.get(head) or []):
                yield f"{head}[{i}].{sub}", v.get(sub)
        else:
            yield f, r.get(f)


def key_text(d: dict) -> list:
    """An answer-key defect's own texts: the dataset's `defects` columns (title, statement, evidence,
    counts_if) or the key file's fields (notes for counts_if)."""
    return [d.get("title"), d.get("statement"), d.get("evidence"), d.get("counts_if", d.get("notes"))]


def quote_problems(root: str) -> Dict[str, object]:
    """{table.field: [instance_id ...]} of the label texts that repeat an answer-key defect's words of the same
    pull request (the dataset's `defects`, beside the folder); empty when none."""
    root = root_of(root)
    key: Dict[str, set] = collections.defaultdict(set)
    for d in load_table(os.path.join(root, "data"), "defects"):
        key[d["instance_id"]] |= shingles(key_text(d))
    bad: Dict[str, list] = collections.defaultdict(list)
    folder = os.path.join(root, FOLDER)
    for table in LABEL_TEXT:
        for r in load_table(folder, table):
            for f, v in _label_texts(table, r):
                if isinstance(v, str) and _quoted_runs(v, key[r["instance_id"]]):
                    bad[f"{table}.{f.split('[')[0]}"].append(r["instance_id"])
    return {k: sorted(v)[:10] for k, v in bad.items()}


# ---------------------------------------------------------------------------------------------------- build

def _klass(k: Optional[str]) -> Optional[str]:
    if k in (None, "", "none"):
        return None
    return CLASS_SPELLINGS.get(k, k)


def _judge_file(run_dir: str, iid: str) -> Optional[str]:
    g = sorted(glob.glob(os.path.join(run_dir, "judge", "v*-gpt-6.1-sol-high", f"{iid}.r1.json")))
    return g[0] if g else None


def _on_main(repo: str, commit: str) -> bool:
    p = subprocess.run(["git", "-C", repo, "merge-base", "--is-ancestor", commit, "origin/main"], capture_output=True)
    if p.returncode not in (0, 1):
        raise SystemExit(f"git merge-base on {commit}: {p.stderr.decode(errors='replace').strip()}")
    return p.returncode == 0


def _key_texts(key_dir: str) -> Dict[str, set]:
    """{instance_id: shingles of its answer-key defects' texts} from the key files (<set>.json)."""
    out: Dict[str, set] = collections.defaultdict(set)
    for s in SETS:
        p = os.path.join(key_dir, f"{s}.json")
        if os.path.exists(p):
            for iid, c in json.load(open(p))["cases"].items():
                for d in c["defects"]:
                    out[iid] |= shingles(key_text(d))
    return out


BODY_MARK = "_posted in the body_"


def collect(a) -> tuple:
    """The folder's tables from the runs and the label files, and the scrub's counts: (tables, counts). Nothing
    is written."""
    sys.path.insert(0, os.path.dirname(HERE))
    import compare
    import hf_export as H
    import release_catalogue as RC

    counts = collections.Counter()
    S = lambda x: H.scrub_obj(x, counts)  # noqa: E731
    lab = a.labels
    pos = json.load(open(a.positives))
    bysub = pos["bysub"]
    pr_set = {pr: s for s, ps in bysub.items() for pr in ps}
    tables: Dict[str, List[dict]] = {n: [] for n in TABLES}

    # arms
    for arm, name, note in (
            (STATE, "State-machine review", "review.profile=state-machines: the eight pass-sm-* lenses alone, all at "
                                            "deep on every change, the merged build"),
            (DEFAULT, "Default review, automatic state lens off", "the default lenses with state_machines.triggers=off, "
                                                                  "an earlier build from a branch that was never "
                                                                  "published; the merge did not change its other lenses"),
            (ASTRA, "State-machine review, GPT-6.2 Astra (preliminary)",
             "preliminary: review.profile=state-machines as sm4-p, reviewer openai-codex/gpt-6.2-astra, lens pass "
             "deadline 20 minutes (engine.lens_pass_deadline_min; the shipped default is 8); its build is public main "
             "plus one bench-only commit that registers the model with pi (QCR_BENCH_LOGIN_MODELS, with OpenAI's list "
             "prices at release), the review code unchanged; the study labelled none of its comments and pooled none "
             "of its bugs")):
        runs = [f"{arm}-{s}" for s in SETS if s in bysub]
        rj = [json.load(open(os.path.join(a.runs_dir, r, "run.json"))) for r in runs]
        aj = [json.load(open(os.path.join(a.runs_dir, f"{r}.arm.json"))) for r in runs]

        def one(xs, what):
            if len({json.dumps(x) for x in xs}) != 1:
                raise SystemExit(f"{arm}: the runs differ in {what}: {sorted({json.dumps(x) for x in xs})}")
            return xs[0]
        commit = one([r["qcr_commit"] for r in rj], "qcr_commit")
        on = _on_main(a.repo, commit.replace("-dirty", ""))
        f = RC.commit_fields(commit, {commit: commit if on else None}, {commit: {"match": "same"}} if on else {})
        tables["arms"].append({
            "arm_id": arm, "display_name": name, "image": one([x["image"] for x in aj], "image"),
            "image_id": one([x["image_id"] for x in aj], "image_id"), "config": one([x["config"] for x in aj], "config"),
            # no profile is null, never an empty string
            "profile": one([r.get("profile") or None for r in rj], "profile"), **f,
            "pi": one([r.get("pi") for r in rj], "pi"),
            "reviewer_model": one([r["models"]["conversation"] for r in rj], "model"),
            "judge_model": "gpt-6.1-sol (effort high)", "runs": runs, "prs": len(pr_set), "note": note})

    # cases, reviews and the judge's verdicts
    for arm in RUNS:
        for s in SETS:
            for pr in bysub.get(s, []):
                run = f"{arm}-{s}"
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
                # an inline comment is the first unused row of the same text; two comments of one text take two rows
                cid_of, used = {}, set()
                for i, b in enumerate(posted):
                    ids = [f"C{k + 1}" for k, r in enumerate(rows) if r["content"] == b["body"] and f"C{k + 1}" not in used]
                    if ids:
                        used.add(ids[0])
                        cid_of[i] = ids[0]
                    tables["reviews"].append({"arm_id": arm, "instance_id": pr, "index": i, "inline": True,
                                              "path": b.get("path"), "line": b.get("line"), "side": b.get("side"),
                                              "body": b.get("body"),
                                              "comment_id": cid_of.get(i) if j is not None else None})
                # a row no inline comment took was posted in the review body (review.md says so for each one)
                rest = [(f"C{k + 1}", r) for k, r in enumerate(rows) if f"C{k + 1}" not in used]
                if rest:
                    md = open(os.path.join(case, "review.md"), encoding="utf-8").read()
                    title = lambda r: r["content"].split("\n", 1)[0].split("] ", 1)[-1].strip()  # noqa: E731
                    lost = [c for c, r in rest if title(r) not in md]
                    if lost or md.count(BODY_MARK) != len(rest):
                        raise SystemExit(f"{run}/{pr}: result rows {[c for c, _ in rest]} are neither inline comments "
                                         f"nor the review body's {md.count(BODY_MARK)} findings")
                    for c, r in rest:
                        tables["reviews"].append({"arm_id": arm, "instance_id": pr, "index": None, "inline": False,
                                                  "path": r.get("path"), "line": r.get("end_line"), "side": None,
                                                  "body": r["content"], "comment_id": c if j is not None else None})
                u = (j or {}).get("usage") or {}
                tables["cases"].append({"arm_id": arm, "instance_id": pr, "set": s, "run": run,
                                        "status": summ.get("status"), "verdict": summ.get("verdict"), "usd": usd,
                                        "minutes": mins, "n_posted": len(posted), "judged": j is not None,
                                        "judge_input_tokens": u.get("input"), "judge_output_tokens": u.get("output"),
                                        "judge_cache_read_tokens": u.get("cacheRead")})
                if j is None:
                    continue
                index_of = {c: i for i, c in cid_of.items()}
                for d in j["defects"]:
                    tables["defect_verdicts"].append({"arm_id": arm, "instance_id": pr, "judge": judge,
                                                      "key_version": str(j.get("defect_set_version")),
                                                      "defect_id": d["id"], "verdict": d.get("verdict"),
                                                      "credit": H.credit(d.get("verdict")),
                                                      "comment_ids": [str(x) for x in d.get("comments") or []],
                                                      "why": d.get("why")})
                for c in j["comments"]:
                    tables["comment_verdicts"].append({"arm_id": arm, "instance_id": pr, "judge": judge,
                                                       "comment_id": c["id"], "index": index_of.get(c["id"]),
                                                       "grade": c.get("verdict"), "defect_id": c.get("defect"),
                                                       "new_defect": c.get("new_defect"), "why": c.get("why")})

    # the labels
    sr = json.load(open(os.path.join(lab, "strict-relabel.json")))
    cm = json.load(open(os.path.join(lab, "comments-and-misses.json")))
    pu = json.load(open(os.path.join(lab, "pooled-unlisted.json")))
    res = json.load(open(os.path.join(lab, "results.json")))
    blind = {f"{x['pr']}#{x['bug_id']}": x for x in json.load(open(os.path.join(lab, "blind-result.json")))}
    # a defect a second reader agreed cannot happen at head is not reachable
    unreachable = {m["key"] for m in cm["misses"] if m["cause"] == "defect_not_real_or_unreachable"
                   and (m.get("check") or {}).get("agree")}
    for k, v in sr.items():
        pr, _, did = k.partition("#")
        votes = [{"reader": int(n), "verdict": x.get("verdict"), "klass": _klass(x.get("klass")),
                  "reason": x.get("reason"), "state": x.get("state") or None, "event": x.get("event") or None}
                 for n, x in sorted(v["votes"].items(), key=lambda kv: int(kv[0]))]
        tables["state_labels"].append({"instance_id": pr, "defect_id": did, "verdict": v["verdict"],
                                       "klass": _klass(v["klass"]), "how": v["how"], "old45": bool(v["old45"]),
                                       "reachable": k not in unreachable, "votes": votes})
    second = {(c["pr"], c["index"]): c["check"] for c in cm["checked"]}
    for c in cm["comments"]:
        ch = second.get((c["pr"], c["index"]))
        tables["comment_state_labels"].append({
            "arm_id": STATE, "instance_id": c["pr"], "index": c["index"], "title": c["title"],
            "verdict": ch["verdict"] if ch else c["verdict"], "klass": _klass(c["klass"]), "reason": c["reason"],
            "first_verdict": c["verdict"], "second_read_verdict": ch["verdict"] if ch else None,
            "second_read_agrees": ch["agree"] if ch else None, "second_read_reason": ch["reason"] if ch else None,
            "key_defect": c.get("key_defect") or None, "real_if_unlisted": c.get("real_if_unlisted")})
    for c in pu["classified"]:
        tables["comment_state_labels"].append({
            "arm_id": DEFAULT, "instance_id": c["pr"], "index": c["index"], "title": c["title"], "verdict": c["verdict"],
            "klass": _klass(c["klass"]), "reason": c["reason"], "first_verdict": c["verdict"],
            "second_read_verdict": None, "second_read_agrees": None, "second_read_reason": None, "key_defect": None,
            "real_if_unlisted": c.get("real")})
    bugs = {f"{b['pr']}#{b['bug_id']}": b for b in pu["bugs"]}
    for p in res["pool"]:
        pr, _, local = p["id"].partition("#")
        b = bugs.get(p["id"]) if p["source"] == "unlisted" else None
        bl = blind.get(p["id"])
        tables["pooled_bugs"].append({
            "bug_id": p["id"], "instance_id": pr, "local_id": local, "source": p["source"], "klass": _klass(p["klass"]),
            "state_found": bool(p["state"]), "default_found": bool(p["default"]),
            "statement": b["statement"] if b else None,
            "state_review_comments": b["state_review_comments"] if b else None,
            "default_review_comments": b["default_review_comments"] if b else None,
            "check_reason": b["check"]["reason"] if b else None,
            "blind_verdict": bl["blind"] if bl else None,
            # a blind re-check holds when it names the review that found the bug and finds the bug real
            "blind_agrees": (bl["blind"] == bl["expected"] and bl["real"] == "real") if bl else None,
            "blind_reason": bl["reason"] if bl else None})
    for m in cm["misses"]:
        pr, _, did = m["key"].partition("#")
        ch = m.get("check") or {}
        tables["misses"].append({"instance_id": pr, "defect_id": did, "cause": m["cause"],
                                 "owning_lens": m.get("owning_lens"), "planned_lenses": m.get("planned_lenses"),
                                 "what_would_have_caught_it": m.get("what_would_have_caught_it"),
                                 "second_read_verdict": ch.get("verdict"), "second_read_agrees": ch.get("agree"),
                                 "second_read_reason": ch.get("reason"),
                                 # why a miss's cause was changed on review, where it was
                                 "relabel_note": m.get("relabel_note")})
    # the earlier builds: found flags on the strict state defects (the score file's own strict list)
    ea = json.load(open(a.earlier))
    strict = sorted(k for k, v in sr.items() if v["verdict"] == "state_machine")
    for arm, desc in EARLIER.items():
        f = set(ea[arm]["found_strict"])
        if not f <= set(strict):
            raise SystemExit(f"--earlier: {arm} found a defect the strict relabel does not hold: {sorted(f - set(strict))}")
        for k in strict:
            pr, _, did = k.partition("#")
            tables["earlier_arms"].append({"arm_id": arm, "description": desc, "instance_id": pr, "defect_id": did,
                                           "found": k in f})
    # the score file's own copy of the default run must agree with the judge files read above
    if DEFAULT in ea:
        mine = sorted(f"{r['instance_id']}#{r['defect_id']}" for r in tables["defect_verdicts"]
                      if r["arm_id"] == DEFAULT and r["verdict"] == "found" and f"{r['instance_id']}#{r['defect_id']}" in strict)
        if mine != sorted(ea[DEFAULT]["found_strict"]):
            raise SystemExit("--earlier: its default-run found list differs from the judge files")

    # our label texts never repeat an answer-key defect's own words (LABEL_TEXT)
    key = _key_texts(a.key)
    for table, fields in LABEL_TEXT.items():
        for r in tables[table]:
            for f in fields:
                head, _, sub = f.partition(".")
                for x in (r.get(head) or []) if sub else [r]:
                    k = sub or head
                    new = unquote(x.get(k), key[r["instance_id"]])
                    if new != x.get(k):
                        counts[f"quoted {table}.{head}"] += 1
                        x[k] = new
    return {n: [S(r) for r in rows] for n, rows in tables.items()}, counts


def build(a) -> None:
    """Write the folder from the runs and the label files (`state_machines.py build --help`)."""
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
    for f in FIGURES:
        txt = open(os.path.join(a.figures, f), encoding="utf-8").read()
        if H.scrub_obj(txt, collections.Counter()) != txt:
            raise SystemExit(f"figures/{f}: the scrub would rewrite it; fix the drawing")
    tables, counts = collect(a)
    os.makedirs(os.path.join(tmp, "figures"))
    write_tables(tables, tmp)
    for f in FIGURES:
        shutil.copyfile(os.path.join(a.figures, f), os.path.join(tmp, "figures", f))
    text = readme(numbers(tmp))
    # checks() compares README.md with readme() of the tables, so the scrub may not change it
    if H.scrub_obj(text, collections.Counter()) != text:
        raise SystemExit(f"README.md: the scrub would rewrite it; {tmp} is left for a look")
    with open(os.path.join(tmp, "README.md"), "w", encoding="utf-8") as fh:
        fh.write(text)
    os.rename(tmp, out)
    if getattr(a, "manifest", None):  # the committed manifest of the folder just written (`--manifest`)
        write_manifest(os.path.dirname(out), a.manifest)
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


def readme(n: Dict[str, object]) -> str:
    """The folder's README, every number in it from numbers() (checks() compares the file with this)."""
    i = lambda k: f"{int(n[k]):,}"  # noqa: E731
    pct = lambda k: f"{n[k]:.0f}%"  # noqa: E731
    cls = "\n".join(f"| {k} | {i(f'class.{k}.pool')} | {i(f'class.{k}.{STATE}')} | {i(f'class.{k}.{DEFAULT}')} |"
                    for k in CLASSES)
    earlier = "\n".join(f"| `{a}` | {d} | {i(f'key.{a}')} ({pct(f'key.{a}.pct')}) |" for a, d in EARLIER.items())
    only = ", ".join(f"`{x}`" for x in n["key.default_not_state.ids"]) or "none"
    astra_missed = ", ".join(f"`{x}`" for x in n[f"key.{ASTRA}.missed.ids"]) or "none"
    return f"""# State-machine study

A study of QuickReview's state-machine review on the {i('prs')} AACR-Bench pull requests that hold the
earlier list of {i('old45.total')} labelled state defects ({i('prs.with_strict_state')} of them hold a state
defect under the strict relabel below), with the default review beside it. It holds the two runs'
posted comments and judge verdicts, every label the study made, and the earlier builds' found flags on
the answer key's state defects, and a preliminary third run, `{ASTRA}`, the state-machine review with
GPT-6.2 Astra as the reviewer (its comments and verdicts; none of its comments is labelled). No config of the card reads this folder, so `load_dataset` returns the
same rows with or without it. `bench/aacr/recompute/state_machines.py --data <this dataset>` recomputes
every number below from these tables alone, checks that this README is the one the tables give, and
runs the release's other checks of the folder (`validation.json` holds them).

The folder backs the write-up's sections on the merged build: the strict relabel, the two runs on all
{i('prs')} pull requests, the bugs outside the answer key, and the cost of the two runs. It does not back
the write-up's earlier tests on the list of {i('old45.total')} (their recall, costs and miss traces), the
lookup tool's and the validator's audits, or the self-review of the change that adds the state lenses.

## The runs

| Arm | What ran | Inline comments | $ per PR | Minutes per PR |
|---|---|---|---|---|
| `{STATE}` | the state-machine review: `review.profile=state-machines`, the eight `pass-sm-*` lenses alone, at deep on every change, on public main | {i(f'comments.{STATE}')} | {n[f'cost.{STATE}.usd_per_pr']:.2f} | {n[f'cost.{STATE}.minutes_per_pr']:.1f} |
| `{DEFAULT}` | the default review with its automatic state lens off (`state_machines.triggers=off`), on an earlier build from a branch that was never published (`arms.qcr_commit_on_public_main` false) | {i(f'comments.{DEFAULT}')} | {n[f'cost.{DEFAULT}.usd_per_pr']:.2f} | {n[f'cost.{DEFAULT}.minutes_per_pr']:.1f} |
| `{ASTRA}` | preliminary: the state-machine review as `{STATE}`, reviewer `openai-codex/gpt-6.2-astra`, lens pass deadline 20 minutes where the shipped default is 8, on public main plus one bench-only commit that registers the model with pi (`arms.qcr_commit_on_public_main` false) | {i(f'comments.{ASTRA}')} | {n[f'cost.{ASTRA}.usd_per_pr']:.2f} | {n[f'cost.{ASTRA}.minutes_per_pr']:.1f} |

Reviewer and judge gpt-6.1-sol, the judge at high effort; one run each. `{ASTRA}`'s reviewer is
gpt-6.2-astra and its judge the same gpt-6.1-sol at high effort. Cost is the list-price equivalent,
priced per review as the dataset's `reviews.cost_usd` is (compare.usd_and_minutes: pi's cost of each
call at the model's list prices; for gpt-6.2-astra, OpenAI's list prices at its release); the judge's
cost is not in it. Every count of comments here is of inline comments; the default review also posted
{i(f'comments.{DEFAULT}.body')} findings in its review body, the state review
{i(f'comments.{STATE}.body')}, and `{ASTRA}` {i(f'comments.{ASTRA}.body')}.

## Tables

Every table is a `.parquet` file in this folder.

- `arms`: the three runs: image, config, `profile` (null when the run set none), the build commit as the
  release states one (`qcr_commit`, `qcr_commit_on_public_main`, `qcr_commit_match`, `qcr_commit_dirty`,
  see the card's `runs`), pi, models, run directories.
- `cases`: one row per arm and pull request: set, run, `status` (the case's run status), the
  review's `verdict` (`APPROVE`, `COMMENT` or `REQUEST_CHANGES`), cost, minutes, `n_posted` (the inline
  comments), whether the judge read it, and the judge's token usage.
- `reviews`: every finding of the three runs as QuickReview posted it, with the judge's id for it
  (`comment_id`, C1..Cn). An inline comment has `inline` true, `index` from 0 in posting order, and the
  `path`, `line`, `side` and `body` it was posted with. A finding posted in the review body instead has
  `inline` false, `index` null, its `path` and last `line`, and its text as the judge read it.
- `defect_verdicts`, `comment_verdicts`: the judge's verdicts, with the dataset's columns of the same
  names (`judge`, `key_version`, `credit`, ...) except `run_family`, since these runs are not in its
  `runs` table; `comment_verdicts.index` is the inline comment the judged row is (null for a finding
  posted in the review body). The answer-key defects themselves are in the dataset's `defects` table,
  by `instance_id` and `defect_id`.
- `state_labels`: all {i('relabel.total')} answer-key defects of these pull requests, relabelled blind by
  two AI readers (a third settled {i('relabel.tiebreak')} disagreements, `how` `tiebreak`): `verdict`
  `state_machine`, `borderline` or `not`, by the rule that a state bug needs a named state and an event
  or sequence, so that a single call with fresh state would behave correctly; `klass`, the kind of state
  bug; `old45`, whether the defect was on the earlier list of {i('old45.total')}; `reachable`, false for a
  state defect a second reader agreed cannot happen at head; `votes`, each reader's verdict, kind and
  reason. Where a reason repeated {QUOTE_WORDS} or more words in a row of the defect's own text, those
  words are replaced by `{QUOTED}`; the text is in `defects`.
- `comment_state_labels`: every inline comment of the state review ({i(f'comments.{STATE}.labelled')}), and
  every inline comment of the default review that the judge matched to no answer-key defect
  ({i(f'comments.{DEFAULT}.labelled')}), labelled with the same rule: `title`, the comment's first line;
  `verdict`, `klass` and `reason`. The state review's non-state calls were read a second time
  ({i(f'comments.{STATE}.second_reads')} reads, {i(f'comments.{STATE}.second_read_changed')} changed): `first_verdict` is
  the first reader's, `second_read_*` the second read's, and `verdict` the final one. `key_defect` is
  the answer-key defect the judge matched a state-review comment to (null when none, and for the
  default review's rows). `real_if_unlisted` is, for a state comment that matches no answer-key defect,
  whether a reader found the bug real at head (`real` or `unsure`), and `n/a` for every other comment.
  `{ASTRA}`'s comments are not labelled.
- `pooled_bugs`: the {i('pool.total')} known real state bugs: the {i('pool.key')} reachable strict state
  defects of the answer key (`source` `answer-key`, `local_id` the defect id) and {i('pool.unlisted')}
  real state bugs either review posted that the key does not list (`source` `unlisted`, `local_id`
  U1..; `statement` is ours). An unlisted bug was confirmed in the code at head by an AI reader and
  re-checked by a sceptical one (`check_reason`); a candidate the check rated unsure at head is left
  out. The inline comments that raise it are listed by `index` (`state_review_comments`,
  `default_review_comments`); each one only one review found was checked once more blind to which
  review posted it (`blind_*`). The answer-key rows' found flags are the judge's verdicts (`found`);
  the unlisted rows' are the labels, and each is true exactly when its list of comments is not empty.
- `misses`: the state review's {i('misses.total')} misses on the strict state defects, each traced
  through the run's plan, lens transcripts and candidate findings (the trace itself is not here): the
  `cause`, the lens that owned the defect (`owning_lens`), the lenses the run's plan held
  (`planned_lenses`), and what would have caught it; `second_read_*` is a second reader's check of the
  cause where one was made, and `relabel_note` says why a cause was changed on review (null where it
  was not).
- `earlier_arms`: whether each of four earlier builds found each strict state defect (judge verdict
  `found`); derived flags only, their reviews are not in this folder. `{ASTRA}`'s found flags are its
  rows of `defect_verdicts`.
- `figures/`: the write-up's four charts (the two runs; `{ASTRA}` is not drawn).

## The numbers, and how each is recomputed

**The strict relabel** (`state_labels`): {i('relabel.state')} state, {i('relabel.borderline')} borderline,
{i('relabel.not')} not, of {i('relabel.total')}; {i('relabel.reachable')} of the state ones are reachable at
head, and {i('relabel.state_not_old45')} of them were not on the earlier list. Of the earlier list of
{i('old45.total')} (`old45`): {i('old45.state')} state, {i('old45.borderline')} borderline, {i('old45.not')} not.

**Answer-key recall** on the {i('relabel.reachable')} (`defect_verdicts.verdict` `found`, against the
reachable state rows of `state_labels`): the state review {i(f'key.{STATE}')} ({pct(f'key.{STATE}.pct')}),
the default review {i(f'key.{DEFAULT}')} ({pct(f'key.{DEFAULT}.pct')}). The state review found
{i('key.state_not_default')} the default review did not; the default review found
{i('key.default_not_state')} the state review did not ({only}). On the earlier list of
{i('old45.total')} the state review found {i(f'key_old45.{STATE}')} and the default review
{i(f'key_old45.{DEFAULT}')}. The earlier builds (`earlier_arms`):

| Arm | Build | Found of {i('relabel.reachable')} |
|---|---|---|
{earlier}

**The pool** (`pooled_bugs`): {i('pool.total')} known real state bugs, {i('pool.key')} in the answer key and
{i('pool.unlisted')} outside it. Found: the state review {i(f'pool.{STATE}')} ({pct(f'pool.{STATE}.pct')}), the
default review {i(f'pool.{DEFAULT}')} ({pct(f'pool.{DEFAULT}.pct')}), either {i('pool.union')}
({pct('pool.union.pct')}). Of the unlisted: {i('unlisted.both')} both, {i('unlisted.state_only')} only the
state review, {i('unlisted.default_only')} only the default review; {i('unlisted.blind_agree')} of the
{i('unlisted.blind_checked')} one-sided ones held when re-checked blind.

| Class | Pool | State review | Default review |
|---|---|---|---|
{cls}

**Comments** (`reviews` with `inline` true, `comment_state_labels`, `comment_verdicts`): the state review
posted {i(f'comments.{STATE}')} ({n[f'comments.{STATE}.per_pr']:.1f} per PR), {i(f'comments.{STATE}.state')} state
({pct(f'comments.{STATE}.state.pct')}), {i(f'comments.{STATE}.borderline')} borderline and
{i(f'comments.{STATE}.not')} not ({pct(f'comments.{STATE}.not.pct')}); the judge graded
{i(f'comments.{STATE}.not_judged_correct')} of the {i(f'comments.{STATE}.not')} not-state ones correct. The
default review posted {i(f'comments.{DEFAULT}')} ({n[f'comments.{DEFAULT}.per_pr']:.1f} per PR),
{i(f'comments.{DEFAULT}.unmatched')} of them matched to no answer-key defect; together
{n['comments.union.per_pr']:.1f} per PR. Of all {i('defects.total')} answer-key defects, of every kind, the
default review found {i(f'defects.{DEFAULT}.found')} (`found`; {i(f'defects.{DEFAULT}.partial')} more partly) and
the state review {i(f'defects.{STATE}.found')} ({i(f'defects.{STATE}.partial')} more partly). A judge's credit
for a finding posted in the review body counts: its text is the `reviews` row with `inline` false.

**Misses** (`misses`): {i('misses.total')}, {i('misses.real')} of them real: {i('misses.site_read_nothing_reported')}
where a lens read the site and reported nothing, {i('misses.reported_a_different_problem')} where it
reported a different problem at the site, {i('misses.defect_not_real_or_unreachable')} not real at head.
They are exactly the strict state defects the state review did not find.

**Cost** (`cases.usd`): {n[f'cost.{STATE}.usd_per_pr']:.2f} and {n[f'cost.{DEFAULT}.usd_per_pr']:.2f} dollars
per PR, rounded to cents as the write-up prints them; both runs together cost
{n['cost.union.usd_per_pr']:.2f} per PR, the exact sum ({n['cost.union.usd_per_pr']:.4f}) rounded, not the sum of
the two rounded costs.

## Preliminary: GPT-6.2 Astra (`{ASTRA}`)

The state-machine review of `{STATE}` with `openai-codex/gpt-6.2-astra` as the reviewer, on the same
{i('prs')} pull requests, judged by gpt-6.1-sol at high effort (`defect_verdicts`, `comment_verdicts`
with `arm_id` `{ASTRA}`). On the {i('relabel.reachable')} reachable strict state defects it found
{i(f'key.{ASTRA}')} ({pct(f'key.{ASTRA}.pct')}); it missed {astra_missed}. It found
{i(f'key.{ASTRA}.not_{STATE}')} that `{STATE}` did not, and `{STATE}` found {i(f'key.{STATE}.not_{ASTRA}')} that it
did not. Of all {i('defects.total')} answer-key defects, of every kind, it found {i(f'defects.{ASTRA}.found')}
(`found`; {i(f'defects.{ASTRA}.partial')} more partly). It posted {i(f'comments.{ASTRA}')} inline comments
({n[f'comments.{ASTRA}.per_pr']:.1f} per PR), for {n[f'cost.{ASTRA}.usd_per_pr']:.2f} dollars per PR at list price.

It is preliminary: one run; its lens pass deadline was 20 minutes where the shipped default is 8; its
judge is not its reviewer's model; none of its comments is labelled, so how many are about state bugs
is not known (the state review's comments are not all about state: see the comment labels above); and
none of its bugs outside the answer key were pooled, so it has no share of the pool.

## Limits

- AI agents made the answer key, the state labels, the comment labels and the checks of the unlisted
  bugs, and no person has checked them.
- The pool counts the state bugs known on these pull requests. A state bug that neither review found and
  the answer key does not list cannot be counted, so the pooled shares are of the known bugs and
  overstate true recall.
- The answer-key part is scored by the judge; the unlisted part by AI agents reading the code.
- One run per arm. A repeat of one earlier build differed by one defect.
- The default arm ran with its automatic state lens off, on an earlier build from a branch that was never
  published; the merge did not change its other lenses.
- The judge is the reviewer's model, gpt-6.1-sol, for the two runs; `{ASTRA}`'s reviewer is another model.
- Part of the answer key entered it through the default review's own earlier comments, which favours
  the default review on the key.
- The pull requests were chosen because they hold labelled state defects, so state bugs are more common
  in them than in ordinary pull requests.
- The earlier builds' reviews and costs are not in this folder; their found flags are.
"""


# ---------------------------------------------------------------------------------------------------- CLI

def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "build":
        ap = argparse.ArgumentParser(prog="state_machines.py build", description=build.__doc__)
        ap.add_argument("--runs-dir", required=True, help="the bench runs dir (it holds sm4-p-*, sm1-c-*, sm5-a-*)")
        ap.add_argument("--labels", required=True, help="the dir of the study's label files (strict-relabel.json, "
                        "comments-and-misses.json, pooled-unlisted.json, results.json, blind-result.json)")
        ap.add_argument("--positives", required=True, help="the study's PR list (positives.json: bysub)")
        ap.add_argument("--earlier", required=True, help="the earlier builds' score file (found_strict per arm)")
        ap.add_argument("--figures", required=True, help="the dir holding the write-up's four SVG charts")
        ap.add_argument("--repo", required=True, help="a QuickReview checkout with origin/main fetched")
        ap.add_argument("--key", default=os.path.join(os.path.dirname(HERE), "defects"),
                        help="the answer key's dir (<set>.json); label texts that repeat its words are cut")
        ap.add_argument("--out", required=True, help="the new `state_machines` folder")
        ap.add_argument("--manifest", help="also write the folder's sha256 manifest here (the committed one is "
                        "bench/aacr/hf/state-machines.sha256)")
        build(ap.parse_args(sys.argv[2:]))
        return
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", required=True, help="the Hugging Face dataset dir (it holds data/ and state_machines/)")
    ap.add_argument("--manifest", default=MANIFEST)
    ap.add_argument("--json", help="also write the checks to this JSON file")
    a = ap.parse_args()
    cs = checks(a.data, a.manifest)
    for c in cs:
        print(f"{'ok  ' if c['ok'] else 'FAIL'} {c['check']}" + ("" if c["ok"] else f": got {c['got']}"))
    print(f"{sum(c['ok'] for c in cs)} of {len(cs)} pass")
    if a.json:
        with open(a.json, "w") as f:
            json.dump(cs, f, indent=1)
    sys.exit(0 if all(c["ok"] for c in cs) else 1)


if __name__ == "__main__":
    main()
