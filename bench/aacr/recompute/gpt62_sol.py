#!/usr/bin/env python3
"""The dataset's GPT-6.2 Sol comparison: `gpt62_sol/`, built, checked and recomputed. No model call.

    uv run --no-project --with pyarrow python bench/aacr/recompute/gpt62_sol.py --data <hf-dataset> [--json OUT]
    uv run --no-project --with pyarrow python bench/aacr/recompute/gpt62_sol.py build --runs-dir <runs> \\
        --elo-dir <elo> --data <hf-dataset> --repo <checkout> --qodo-gt <qodo jsonl> --out <dir>/gpt62_sol

The comparison puts QuickReview 1.6.0 on GPT-6.2 Sol with its quiet default on (`s62`) beside the build
frozen on 2026-10-04 on GPT-6.1 Sol with no quiet default (`final1`, the dataset's arm `quickreview-frozen`),
on all 185 AACR-Bench pull requests, and on Martian's benchmark (50) and Qodo's PR-Review-Bench (100). It has
three parts:

  - the answer key: s62's posted comments and the defect judge's verdicts on them (gpt-6.1-sol at high),
    beside final1's published ones (gpt-6-sol at high), which the dataset's tables already hold (`reviews`,
    `defect_verdicts`, `comment_verdicts` of `quickreview-frozen`, runs final1-*) and this folder does not
    repeat;
  - pairwise Elo: two judges (gpt-6.1-sol and deepseek-v4.1-flash, both at xhigh) read both reviews of a
    pull request and pick the better one per category, every pair in both A/B orders, over four plans
    (PLANS). Every attempt is in `elo_judgments`; the ratings are a Bradley-Terry fit per judge over every
    plan it judged, and one pooled with each judge weighted the same (the pooled report's rule: a judge's games
    repeat so every judge contributes the same number of games per unit judged);
  - Martian and Qodo: s62's reviews and their scorings (gpt-6.1-sol at low for both setups) in the columns of
    the dataset's martian_* and qodo_* tables, built by the export's own _martian_dir and _qodo_dir (tool s62,
    work dirs MQ_WORK_DIRS); final1's are the dataset's rows (tool quickreview-frozen, work dirs final1-*), which
    this folder does not repeat. The numbers are recounted as recompute/martian_scores.py and
    claim_metrics.Qodo (recompute/qodo_scores.py) count them.

checks() is what the export's validation.json and the claims verifier's release checks hold for it:

  - every file of `gpt62_sol/` is the committed manifest's (bench/aacr/hf/gpt62-sol.sha256);
  - every table has exactly its listed columns, and the Martian and Qodo tables the dataset's columns;
  - the rows are whole (whole_problems): s62 reviewed and was judged on the pull requests final1 has in
    the dataset, against the dataset's answer key at its version; every judged comment is a posted one;
    every Elo judgment is of a unit of its plan, between s62 and final1, numbered in its file's order; the
    Martian and Qodo rows are s62's scorings of final1's pull requests, whole, with stored scores that recount
    and location flags qodo_judge.located gives (mq_whole_problems);
  - README.md is readme() of numbers();
  - `elo_ratings`, `elo_gaps` and the `used_in_ratings` flags are the refit of `elo_judgments` (refit());
  - every number the write-up prints (POST, the Martian and Qodo groups the analysis's numbers file),
    recomputed from the folder and the dataset's tables.

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

# Martian (50 PRs) and Qodo PR-Review-Bench (100 PRs): each setup's review run is also its scoring's work_dir.
# s62's scorings are this folder's (tool `s62`); final1's are the dataset's (tool quickreview-frozen).
MARTIAN_WORK = {NEW: f"{NEW}-martian50", OLD: f"{OLD}-martian50"}
QODO_WORK = {NEW: f"{NEW}-qodo-pr100", OLD: f"{OLD}-qodo-pr100"}
MQ_WORK_DIRS = (MARTIAN_WORK[NEW], QODO_WORK[NEW])  # the dataset's own tables hold no row of these
MQ_SETS = ("martian50", "qodo-pr100")  # `cases.set` of s62's Martian and Qodo reviews
MQ_TOOL = {NEW: NEW, OLD: OLD_ARM}
MQ_JUDGE = "gpt-6.1-sol"  # both setups' Martian and Qodo judge (the tables' `judge`), at reasoning effort low
MQ_EFFORT = "low"
REJUDGED = "rejudged-"  # Martian's re-judged comparator reviews, scored again in each scoring
# Qodo's location rules: the primary N=5 (the comment's file and lines within 5 of the issue's), the same file,
# and none (the judge's semantic match alone); claim_metrics.Qodo's metric suffixes
QODO_RULES = (("n5", "located_n5", ""), ("same_file", "located_same_file", "_samefile"), ("semantic", None, "_semantic"))
MARTIAN_PROFILES = ("core", "strict", "all")
MARTIAN_PAGE = 30  # Martian's step 1 reads the first page of a PR's inline comments
TAG_RE = re.compile(r"^\[([^\]]+)\]")
FOOTER_SEV_RE = re.compile(r"_(P[0-3]|nit) · ")
LENS_RE = re.compile(r"\blens (pass-[a-z0-9-]+)")

TABLES: Dict[str, tuple] = {
    "arms": ("arm_id", "display_name", "dataset_arm", "image", "image_id", "config", "profile", "qcr_commit",
             "qcr_commit_on_public_main", "qcr_commit_match", "qcr_commit_dirty", "pi", "pi_source", "engine",
             "reviewer_model", "judge", "runs", "prs", "martian_run", "qodo_run", "mq_judge", "note"),
    "cases": ("arm_id", "instance_id", "set", "run", "pr_url", "status", "verdict", "usd", "minutes", "n_posted",
              "model_errors", "judged", "judge_input_tokens", "judge_output_tokens", "judge_cache_read_tokens"),
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
    # the dataset's tables of the same names, with their columns (the columns check compares both)
    "martian_reviews": ("tool", "pr_url", "work_dir", "vendor_link_only", "source_url", "comments", "n_comments",
                        "n_posted_inline", "comments_beyond_first_page", "extracted_candidates",
                        "unmatched_candidates", "tp", "fp", "fn", "skipped", "cost_usd", "minutes", "judge",
                        "run_family"),
    "martian_verdicts": ("tool", "pr_url", "judge", "golden_index", "matched", "confidence", "matched_candidate",
                         "reasoning", "work_dir", "run_family"),
    "martian_scores": ("tool", "judge", "work_dir", "run_family",
                       *(f"{p}_{k}" for p in ("strict", "core", "all")
                         for k in ("precision", "recall", "f1", "f2", "tp", "fp", "fn"))),
    "qodo_reviews": ("tool", "pr_url", "work_dir", "vendor_link_only", "source_url", "comments", "n_comments",
                     "cost_usd", "minutes", "judge", "run_family"),
    "qodo_verdicts": ("tool", "pr_url", "work_dir", "judge", "issue_index", "matched", "comment_index", "located_n5",
                      "located_same_file", "why", "run_family"),
}
MQ_TABLES = ("martian_reviews", "martian_verdicts", "martian_scores", "qodo_reviews", "qodo_verdicts")

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
    # Martian and Qodo: the numbers file of the write-up (numbers.json of its Martian and Qodo analysis), every
    # group in mq_post_values' shape
    "martian": {
        "s62": {
            "prs": 50,
            "core": {
                "precision": 12.9, "recall": 62.0, "f1": 21.3, "f2": 35.2, "tp": 98, "golden": 158, "fp": 664,
                "fn": 60},
            "strict": {
                "precision": 11.9, "recall": 64.7, "f1": 20.2, "f2": 34.4, "tp": 90, "golden": 139, "fp": 664,
                "fn": 49},
            "all": {
                "precision": 13.4, "recall": 59.5, "f1": 21.9, "f2": 35.3, "tp": 103, "golden": 173, "fp": 664,
                "fn": 70}},
        "final1": {
            "prs": 50,
            "core": {
                "precision": 16.2, "recall": 65.8, "f1": 26.1, "f2": 40.9, "tp": 104, "golden": 158, "fp": 536,
                "fn": 54},
            "strict": {
                "precision": 14.6, "recall": 66.2, "f1": 24.0, "f2": 38.9, "tp": 92, "golden": 139, "fp": 536,
                "fn": 47},
            "all": {
                "precision": 16.8, "recall": 62.4, "f1": 26.4, "f2": 40.4, "tp": 108, "golden": 173, "fp": 536,
                "fn": 65}},
        "delta": {
            "core": {"precision": -3.3, "recall": -3.8, "f1": -4.8, "f2": -5.7, "tp": -6, "fp": 128},
            "strict": {"precision": -2.7, "recall": -1.5, "f1": -3.8, "f2": -4.5, "tp": -2, "fp": 128},
            "all": {"precision": -3.4, "recall": -2.9, "f1": -4.5, "f2": -5.1, "tp": -5, "fp": 128}}},
    "martian_goldens": {
        "goldens": {
            "category.api": 13, "category.bug": 94, "category.concurrency": 14, "category.data": 7,
            "category.doc_defect": 9, "category.perf": 6, "category.security": 11, "category.speculative": 5,
            "category.style": 10, "category.test_gap": 4, "severity.Critical": 12, "severity.High": 54,
            "severity.Low": 46, "severity.Medium": 61, "audit.disputed": 10, "audit.notreal": 77, "audit.real": 86,
            "total": 173},
        "s62": {
            "category.api": 10, "category.bug": 59, "category.concurrency": 12, "category.data": 4,
            "category.doc_defect": 2, "category.perf": 3, "category.security": 5, "category.speculative": 4,
            "category.style": 1, "category.test_gap": 3, "severity.Critical": 7, "severity.High": 41,
            "severity.Low": 16, "severity.Medium": 39, "audit.disputed": 7, "audit.notreal": 26, "audit.real": 70},
        "final1": {
            "category.api": 8, "category.bug": 61, "category.concurrency": 13, "category.data": 5,
            "category.doc_defect": 7, "category.perf": 3, "category.security": 5, "category.speculative": 2,
            "category.style": 2, "category.test_gap": 2, "severity.Critical": 8, "severity.High": 40,
            "severity.Low": 19, "severity.Medium": 41, "audit.disputed": 6, "audit.notreal": 27, "audit.real": 75},
        "paired": {
            "category.api.items": 13, "category.api.both": 8, "category.api.s62_only": 2,
            "category.api.final1_only": 0, "category.api.neither": 3, "category.bug.items": 94,
            "category.bug.both": 51, "category.bug.s62_only": 8, "category.bug.final1_only": 10,
            "category.bug.neither": 25, "category.concurrency.items": 14, "category.concurrency.both": 12,
            "category.concurrency.s62_only": 0, "category.concurrency.final1_only": 1,
            "category.concurrency.neither": 1, "category.data.items": 7, "category.data.both": 4,
            "category.data.s62_only": 0, "category.data.final1_only": 1, "category.data.neither": 2,
            "category.doc_defect.items": 9, "category.doc_defect.both": 2, "category.doc_defect.s62_only": 0,
            "category.doc_defect.final1_only": 5, "category.doc_defect.neither": 2, "category.perf.items": 6,
            "category.perf.both": 2, "category.perf.s62_only": 1, "category.perf.final1_only": 1,
            "category.perf.neither": 2, "category.security.items": 11, "category.security.both": 4,
            "category.security.s62_only": 1, "category.security.final1_only": 1, "category.security.neither": 5,
            "category.speculative.items": 5, "category.speculative.both": 2, "category.speculative.s62_only": 2,
            "category.speculative.final1_only": 0, "category.speculative.neither": 1, "category.style.items": 10,
            "category.style.both": 0, "category.style.s62_only": 1, "category.style.final1_only": 2,
            "category.style.neither": 7, "category.test_gap.items": 4, "category.test_gap.both": 2,
            "category.test_gap.s62_only": 1, "category.test_gap.final1_only": 0, "category.test_gap.neither": 1,
            "category.total.items": 173, "category.total.both": 87, "category.total.s62_only": 16,
            "category.total.final1_only": 21, "category.total.neither": 49, "audit.disputed.items": 10,
            "audit.disputed.both": 5, "audit.disputed.s62_only": 2, "audit.disputed.final1_only": 1,
            "audit.disputed.neither": 2, "audit.notreal.items": 77, "audit.notreal.both": 16,
            "audit.notreal.s62_only": 10, "audit.notreal.final1_only": 11, "audit.notreal.neither": 40,
            "audit.real.items": 86, "audit.real.both": 66, "audit.real.s62_only": 4, "audit.real.final1_only": 9,
            "audit.real.neither": 7, "audit.total.items": 173, "audit.total.both": 87, "audit.total.s62_only": 16,
            "audit.total.final1_only": 21, "audit.total.neither": 49}},
    "martian_comments": {
        "s62": {
            "posted.total": 750, "posted.mean": 15, "posted.median": 13.5, "ingested.total": 697,
            "ingested.mean": 13.94, "ingested.median": 13.5, "extracted.total": 762, "extracted.mean": 15.24,
            "extracted.median": 13.5, "dropped": 53, "prs_over_page": 4, "prs_with_body": 50,
            "listed_match_posted": 1.0, "tag.blocker": 418, "tag.question": 332},
        "final1": {
            "posted.total": 620, "posted.mean": 12.4, "posted.median": 10.0, "ingested.total": 608,
            "ingested.mean": 12.16, "ingested.median": 10.0, "extracted.total": 641, "extracted.mean": 12.82,
            "extracted.median": 10.5, "dropped": 12, "prs_over_page": 2, "prs_with_body": 50,
            "listed_match_posted": 1.0, "tag.nit": 209, "tag.question": 206, "tag.blocker": 205}},
    "martian_rejudged": {
        "s62": {
            "rejudged-qodo-extended-v2.tp": 95, "rejudged-qodo-extended-v2.fp": 75,
            "rejudged-qodo-extended-v2.fn": 63, "rejudged-cubic-v2.tp": 98, "rejudged-cubic-v2.fp": 79,
            "rejudged-cubic-v2.fn": 60, "rejudged-claude-code.tp": 64, "rejudged-claude-code.fp": 109,
            "rejudged-claude-code.fn": 94},
        "final1": {
            "rejudged-qodo-extended-v2.tp": 95, "rejudged-qodo-extended-v2.fp": 74,
            "rejudged-qodo-extended-v2.fn": 63, "rejudged-cubic-v2.tp": 95, "rejudged-cubic-v2.fp": 80,
            "rejudged-cubic-v2.fn": 63, "rejudged-claude-code.tp": 65, "rejudged-claude-code.fp": 113,
            "rejudged-claude-code.fn": 93},
        "max_core_move": 4},
    "qodo": {
        "issues": {"total": 580, "functional": 309, "rule": 271, "prs": 100},
        "s62": {
            "prs": 100,
            "n5": {
                "comments": 729, "per_pr": 7.29, "precision": 28.0, "recall": 35.2, "f1": 31.2,
                "recall_functional": 53.1, "recall_rule": 14.8, "hits": 204, "hits_functional": 164, "hits_rule": 40},
            "same_file": {
                "comments": 729, "per_pr": 7.29, "precision": 28.4, "recall": 35.7, "f1": 31.6,
                "recall_functional": 54.0, "recall_rule": 14.8, "hits": 207, "hits_functional": 167, "hits_rule": 40},
            "semantic": {
                "comments": 729, "per_pr": 7.29, "precision": 31.3, "recall": 39.3, "f1": 34.8,
                "recall_functional": 60.8, "recall_rule": 14.8, "hits": 228, "hits_functional": 188, "hits_rule": 40}},
        "final1": {
            "prs": 100,
            "n5": {
                "comments": 706, "per_pr": 7.06, "precision": 37.3, "recall": 45.3, "f1": 40.9,
                "recall_functional": 52.1, "recall_rule": 37.6, "hits": 263, "hits_functional": 161, "hits_rule": 102},
            "same_file": {
                "comments": 706, "per_pr": 7.06, "precision": 38.8, "recall": 47.2, "f1": 42.6,
                "recall_functional": 53.7, "recall_rule": 39.9, "hits": 274, "hits_functional": 166, "hits_rule": 108},
            "semantic": {
                "comments": 706, "per_pr": 7.06, "precision": 42.5, "recall": 51.7, "f1": 46.7,
                "recall_functional": 61.2, "recall_rule": 41.0, "hits": 300, "hits_functional": 189, "hits_rule": 111}},
        "delta": {
            "n5": {
                "per_pr": 0.23, "precision": -9.3, "recall": -10.1, "f1": -9.7, "recall_functional": 1.0,
                "recall_rule": -22.8, "hits": -59, "hits_functional": 3, "hits_rule": -62},
            "same_file": {
                "per_pr": 0.23, "precision": -10.4, "recall": -11.5, "f1": -11.0, "recall_functional": 0.3,
                "recall_rule": -25.1, "hits": -67, "hits_functional": 1, "hits_rule": -68},
            "semantic": {
                "per_pr": 0.23, "precision": -11.2, "recall": -12.4, "f1": -11.9, "recall_functional": -0.4,
                "recall_rule": -26.2, "hits": -72, "hits_functional": -1, "hits_rule": -71}}},
    "qodo_comments": {
        "s62": {
            "listed": 729, "prs_without": 1, "tag.blocker": 445, "tag.question": 282, "tag.check this": 2,
            "severity.P2": 471, "severity.P1": 237, "severity.P0": 15, "severity.none": 6},
        "s62_n5_hits": {
            "rule.tag.blocker": 38, "rule.tag.question": 2, "rule.severity.P2": 24, "rule.severity.P1": 14,
            "rule.severity.P0": 1, "rule.severity.none": 1, "rule.lens.pass-baseline": 30, "rule.lens.pass-sweep": 3,
            "rule.lens.pass-style": 2, "rule.lens.pass-maintainability": 2, "rule.lens.none": 1,
            "rule.lens.pass-tests": 1, "rule.lens.pass-behaviour-delta": 1, "functional.tag.blocker": 129,
            "functional.tag.question": 35, "functional.severity.P1": 105, "functional.severity.P2": 50,
            "functional.severity.P0": 9, "functional.lens.pass-baseline": 154,
            "functional.lens.pass-behaviour-delta": 5, "functional.lens.pass-sweep": 2,
            "functional.lens.pass-contracts": 2, "functional.lens.pass-tests": 1},
        "final1": {
            "listed": 706, "prs_without": 0, "tag.blocker": 300, "tag.nit": 281, "tag.question": 125,
            "severity.P3": 317, "severity.P2": 201, "severity.P1": 178, "severity.none": 5, "severity.nit": 3,
            "severity.P0": 2},
        "final1_n5_hits": {
            "rule.tag.nit": 70, "rule.tag.blocker": 29, "rule.tag.question": 3, "rule.severity.P3": 71,
            "rule.severity.P2": 19, "rule.severity.P1": 12, "rule.lens.pass-baseline": 70, "rule.lens.pass-style": 17,
            "rule.lens.pass-lint-conformance": 5, "rule.lens.pass-sweep": 2, "rule.lens.pass-claims": 2,
            "rule.lens.pass-behaviour-delta": 2, "rule.lens.pass-maintainability": 1, "rule.lens.pass-simplicity": 1,
            "rule.lens.pass-duplication": 1, "rule.lens.pass-tests": 1, "functional.tag.blocker": 129,
            "functional.tag.question": 27, "functional.tag.nit": 5, "functional.severity.P1": 104,
            "functional.severity.P2": 45, "functional.severity.P3": 10, "functional.severity.P0": 2,
            "functional.lens.pass-baseline": 147, "functional.lens.pass-tests": 3,
            "functional.lens.pass-maintainability": 2, "functional.lens.pass-sweep": 2,
            "functional.lens.pass-consistency": 2, "functional.lens.pass-intent": 1,
            "functional.lens.pass-backcompat": 1, "functional.lens.pass-prod-risk": 1,
            "functional.lens.pass-abstraction": 1, "functional.lens.pass-behaviour-delta": 1},
        "paired": {
            "n5.functional.items": 309, "n5.functional.both": 155, "n5.functional.s62_only": 9,
            "n5.functional.final1_only": 6, "n5.functional.neither": 139, "n5.rule.items": 271, "n5.rule.both": 38,
            "n5.rule.s62_only": 2, "n5.rule.final1_only": 64, "n5.rule.neither": 167, "n5.total.items": 580,
            "n5.total.both": 193, "n5.total.s62_only": 11, "n5.total.final1_only": 70, "n5.total.neither": 306,
            "semantic.functional.items": 309, "semantic.functional.both": 178, "semantic.functional.s62_only": 10,
            "semantic.functional.final1_only": 11, "semantic.functional.neither": 110, "semantic.rule.items": 271,
            "semantic.rule.both": 39, "semantic.rule.s62_only": 1, "semantic.rule.final1_only": 72,
            "semantic.rule.neither": 159, "semantic.total.items": 580, "semantic.total.both": 217,
            "semantic.total.s62_only": 11, "semantic.total.final1_only": 83, "semantic.total.neither": 269},
        "drop": {
            "old_rule_hits_nit_tag": 70, "old_rule_hits_quiet": 71, "old_functional_hits_quiet": 10,
            "old_rule_hits_p0_p2": 31, "old_rule_hits_no_footer": 0, "new_rule_hits_p0_p2": 39,
            "new_rule_hits_no_footer": 1, "s62_nits": 0, "final1_nits": 281}},
    "mq_cost": {
        "martian.s62.reviews": 50, "martian.s62.usd_total": 269.8, "martian.s62.usd_per_pr": 5.4,
        "martian.s62.usd_median": 4.35, "martian.s62.minutes_median": 20.9, "martian.s62.minutes_mean": 21.3,
        "martian.final1.reviews": 50, "martian.final1.usd_total": 142.03, "martian.final1.usd_per_pr": 2.84,
        "martian.final1.usd_median": 2.5, "martian.final1.minutes_median": 22.6, "martian.final1.minutes_mean": 26.1,
        "martian50.s62.ok": 50, "martian50.s62.rate_limited": 34, "qodo.s62.reviews": 100,
        "qodo.s62.usd_total": 355.42, "qodo.s62.usd_per_pr": 3.55, "qodo.s62.usd_median": 3.3,
        "qodo.s62.minutes_median": 12.9, "qodo.s62.minutes_mean": 13.2, "qodo.final1.reviews": 100,
        "qodo.final1.usd_total": 248.34, "qodo.final1.usd_per_pr": 2.48, "qodo.final1.usd_median": 2.16,
        "qodo.final1.minutes_median": 17.0, "qodo.final1.minutes_mean": 19.6, "qodo-pr100.s62.ok": 100,
        "qodo-pr100.s62.rate_limited": 49},
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


def _data(root: str, name: str, columns: Optional[tuple], arm: Optional[str] = None, key: str = "arm_id") -> List[dict]:
    """One table of the dataset's data/ beside the folder, only `columns` (all when None), and only the rows
    whose `key` column is `arm` (when given)."""
    d = os.path.join(root_of(root), "data")
    pq_path = os.path.join(d, f"{name}.parquet")
    if os.path.exists(pq_path):
        import pyarrow.parquet as pq
        return pq.read_table(pq_path, columns=list(columns) if columns else None,
                             filters=[(key, "=", arm)] if arm else None).to_pylist()
    return [{k: r.get(k) for k in columns} if columns else dict(r)
            for r in load_table(d, name) if arm is None or r.get(key) == arm]


def dataset_of(root: str) -> Dict[str, List[dict]]:
    """What the comparison reads from the dataset's tables: the answer key, and final1's arm, reviews and
    verdicts (arm quickreview-frozen); Martian's goldens and Qodo's issues, and final1's Martian and Qodo
    scorings (work dirs final1-martian50 and final1-qodo-pr100, every column)."""
    return {"defects": _data(root, "defects", ("instance_id", "defect_id", "severity", "key_version")),
            "old_arm": _data(root, "arms", ("arm_id", "runs", "judge", "model_billed"), OLD_ARM),
            "old_reviews": _data(root, "reviews", ("arm_id", "instance_id", "run", "n_comments", "cost_usd", "minutes"),
                                 OLD_ARM),
            "old_defect_verdicts": _data(root, "defect_verdicts", ("arm_id", "instance_id", "defect_id", "credit",
                                                                   "verdict"), OLD_ARM),
            "old_comment_verdicts": _data(root, "comment_verdicts", ("arm_id", "instance_id", "comment_id", "grade",
                                                                     "defect_id"), OLD_ARM),
            "martian_goldens": _data(root, "martian_goldens", ("pr_url", "golden_index", "comment", "severity",
                                                               "category", "audit_bucket")),
            "qodo_issues": _data(root, "qodo_issues", ("pr_url", "issue_index", "file_path", "start_line", "end_line",
                                                       "rule_name", "functional")),
            **{f"old_{n}": _data(root, n, None, (MARTIAN_WORK if n.startswith("martian") else QODO_WORK)[OLD],
                                 key="work_dir") for n in MQ_TABLES}}


def dataset_columns(root: str, name: str) -> List[str]:
    """The columns of one of the dataset's tables (data/ beside the folder)."""
    return columns_of(os.path.join(root_of(root), "data"), name)


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
    cases = aacr_cases(t)
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
    out.update(martian_numbers(t, data))
    out.update(qodo_numbers(t, data))
    return out


def aacr_cases(t: Dict[str, List[dict]]) -> List[dict]:
    """s62's AACR cases (its Martian and Qodo reviews are cases of the sets MQ_SETS)."""
    return [r for r in t["cases"] if r["arm_id"] == NEW and r["set"] in SETS]


def mq_rows(t: Dict[str, List[dict]], data: Dict[str, List[dict]], name: str, arm: str) -> List[dict]:
    """One setup's rows of a Martian or Qodo table: s62's from the folder, final1's from the dataset's (its
    scoring's work dir), each of that work dir alone."""
    work = (MARTIAN_WORK if name.startswith("martian") else QODO_WORK)[arm]
    src = t[name] if arm == NEW else data[f"old_{name}"]
    return [r for r in src if r["work_dir"] == work]


def _tag(body: Optional[str]) -> str:
    m = TAG_RE.match(body or "")
    return m.group(1) if m else "none"


def _footer(body: Optional[str]) -> str:
    """The severity a QuickReview comment's footer prints (its last `_P<n> · ` or `_nit · `); "none" for a
    finding posted in the review body, which has no footer."""
    s = FOOTER_SEV_RE.findall(body or "")
    return s[-1] if s else "none"


def _lens(body: Optional[str]) -> str:
    s = LENS_RE.findall(body or "")
    return s[-1] if s else "none"


def _dist(out: Dict[str, object], key: str, xs: List[float]) -> None:
    out[f"{key}.total"] = sum(xs)
    out[f"{key}.mean"] = statistics.mean(xs) if xs else None
    out[f"{key}.median"] = statistics.median(xs) if xs else None


def _paired(out: Dict[str, object], key: str, a: set, b: set, cat_of: Dict[tuple, str]) -> None:
    """Every item by category (and in total): found by both setups, by s62 only, by final1 only, by neither."""
    for k in sorted(set(cat_of.values())) + ["total"]:
        items = [i for i, c in cat_of.items() if k == "total" or c == k]
        out[f"{key}.{k}.items"] = len(items)
        out[f"{key}.{k}.both"] = sum(1 for i in items if i in a and i in b)
        out[f"{key}.{k}.{NEW}_only"] = sum(1 for i in items if i in a and i not in b)
        out[f"{key}.{k}.{OLD}_only"] = sum(1 for i in items if i not in a and i in b)
        out[f"{key}.{k}.neither"] = sum(1 for i in items if i not in a and i not in b)


def _cost(out: Dict[str, object], key: str, rows: List[dict]) -> None:
    """compare.usd_and_minutes per review, as the tables' cost_usd and minutes hold it."""
    usd, mins = [r["cost_usd"] for r in rows], [r["minutes"] for r in rows]
    out[f"{key}.reviews"] = len(rows)
    out[f"{key}.usd_total"] = sum(usd) if rows and None not in usd else None
    out[f"{key}.usd_per_pr"] = out[f"{key}.usd_total"] / len(rows) if out[f"{key}.usd_total"] is not None else None
    out[f"{key}.usd_median"] = statistics.median(usd) if rows and None not in usd else None
    out[f"{key}.minutes_median"] = statistics.median(mins) if rows and None not in mins else None
    out[f"{key}.minutes_mean"] = statistics.mean(mins) if rows and None not in mins else None


def martian_numbers(t: Dict[str, List[dict]], data: Dict[str, List[dict]]) -> Dict[str, object]:
    """Martian, both setups: each profile's counts and rates as Martian's scorer gives them, recounted from the
    per-golden verdicts and the reviews' false positives (martian_scores.counts and metrics, judge gpt-6.1-sol);
    the goldens found by Martian's category and severity and by the dataset's audit bucket, and the goldens each
    setup found that the other did not; the inline comments posted, the first page Martian read of them, its
    extracted candidates and the comments' tags; the re-judged comparators' Core counts in each scoring
    (identical inputs both times: the judge's own run-to-run spread); cost and time."""
    import martian_scores as MS
    out: Dict[str, object] = {}
    gold = data["martian_goldens"]
    cat = {(g["pr_url"], g["golden_index"]): g["category"] for g in gold}
    sev = {(g["pr_url"], g["golden_index"]): g["severity"] for g in gold}
    bucket = {(g["pr_url"], g["golden_index"]): g["audit_bucket"] for g in gold}
    hits = {}
    for a in ARMS:
        vs, rs = mq_rows(t, data, "martian_verdicts", a), mq_rows(t, data, "martian_reviews", a)
        work, tool = MARTIAN_WORK[a], MQ_TOOL[a]
        mine = [r for r in rs if r["tool"] == tool and r["judge"] == MQ_JUDGE]
        prs = {r["pr_url"] for r in mine}
        out[f"martian.{a}.prs"] = len(prs)
        m = MS.metrics(MS.counts(gold, vs, rs, work, tool, MQ_JUDGE))
        for p in MARTIAN_PROFILES:
            for f in ("tp", "fp", "fn", "precision", "recall", "f1", "f2"):
                out[f"martian.{a}.{p}.{f}"] = m[f"{p}_{f}"]
            out[f"martian.{a}.{p}.golden"] = m[f"{p}_tp"] + m[f"{p}_fn"]
        hit = {(v["pr_url"], v["golden_index"]) for v in vs
               if v["tool"] == tool and v["judge"] == MQ_JUDGE and v["matched"] and v["pr_url"] in prs}
        hits[a] = hit
        for name, of in (("category", cat), ("severity", sev), ("audit", bucket)):
            for k in sorted({str(x) for x in of.values()}):
                out[f"martian.{a}.found.{name}.{k}"] = sum(1 for h in hit if str(of[h]) == k)
        # the comments: every inline comment posted (the first page Martian read, the rest beyond it) and the
        # review body (an ingested comment with no path)
        inline = [[c for c in r["comments"] or [] if c["path"] is not None] for r in mine]
        posted = [x + list(r["comments_beyond_first_page"] or []) for x, r in zip(inline, mine)]
        _dist(out, f"martian.{a}.comments.posted", [r["n_posted_inline"] for r in mine])
        _dist(out, f"martian.{a}.comments.ingested", [len(x) for x in inline])
        _dist(out, f"martian.{a}.comments.extracted", [r["extracted_candidates"] for r in mine])
        out[f"martian.{a}.comments.dropped"] = sum(r["n_posted_inline"] - len(x) for x, r in zip(inline, mine))
        out[f"martian.{a}.comments.prs_over_page"] = sum(1 for x, r in zip(inline, mine) if r["n_posted_inline"] > len(x))
        out[f"martian.{a}.comments.prs_with_body"] = sum(1 for r in mine if any(c["path"] is None for c in r["comments"] or []))
        out[f"martian.{a}.comments.listed_match_posted"] = float(all(len(p) == r["n_posted_inline"]
                                                                     for p, r in zip(posted, mine)))
        for k, n in collections.Counter(_tag(c["body"]) for p in posted for c in p).items():
            out[f"martian.{a}.comments.tag.{k}"] = n
        for tool_ in sorted({r["tool"] for r in rs if r["tool"].startswith(REJUDGED)}):
            c = MS.counts(gold, vs, rs, work, tool_, MQ_JUDGE)["core"]
            for f, x in zip(("tp", "fp", "fn"), c):
                out[f"martian.{a}.rejudged.{tool_}.{f}"] = x
        _cost(out, f"mq_cost.martian.{a}", mine)
    for name, of in (("category", cat), ("severity", sev), ("audit", bucket)):
        for k in sorted({str(x) for x in of.values()}):
            out[f"martian.goldens.{name}.{k}"] = sum(1 for x in of.values() if str(x) == k)
    out["martian.goldens.total"] = len(gold)
    _paired(out, "martian.paired.category", hits[NEW], hits[OLD], {k: str(v) for k, v in cat.items()})
    _paired(out, "martian.paired.audit", hits[NEW], hits[OLD], {k: str(v) for k, v in bucket.items()})
    spread = [abs(out[f"martian.{NEW}.rejudged.{x}.{f}"] - out[f"martian.{OLD}.rejudged.{x}.{f}"])
              for x in {k.split(".")[3] for k in out if k.startswith(f"martian.{NEW}.rejudged.")}
              if f"martian.{OLD}.rejudged.{x}.tp" in out for f in ("tp", "fp")]
    out["martian.rejudged.max_core_move"] = max(spread) if spread else None
    _rate_limited(out, t, "martian50")
    return out


def _rate_limited(out: Dict[str, object], t: Dict[str, List[dict]], s: str) -> None:
    """s62's reviews of one set: how many finished ok, and the rate-limit errors its case summaries record."""
    rows = [r for r in t["cases"] if r["arm_id"] == NEW and r["set"] == s]
    out[f"mq_cost.{s}.{NEW}.ok"] = sum(1 for r in rows if r["status"] == "ok")
    out[f"mq_cost.{s}.{NEW}.rate_limited"] = sum((r["model_errors"] or {}).get("rate_limited") or 0 for r in rows)


def qodo_numbers(t: Dict[str, List[dict]], data: Dict[str, List[dict]]) -> Dict[str, object]:
    """Qodo PR-Review-Bench, both setups: per location rule, the comments judged, precision, recall, F1 and the
    recall on functional issues and on rule violations (claim_metrics.Qodo over the verdicts); the issues each
    setup found that the other did not; the judged comments' tags and footer severities, and those of the
    comments that hit an issue under N=5 (the rule-violation drop is read from them); cost and time."""
    import claim_metrics as CM
    out: Dict[str, object] = {}
    issues = {(i["pr_url"], i["issue_index"]): i for i in data["qodo_issues"]}
    kind = {k: ("functional" if i["functional"] else "rule") for k, i in issues.items()}
    view = CM.Tables(None)
    view._t = {"qodo_issues": data["qodo_issues"],
               "qodo_reviews": mq_rows(t, data, "qodo_reviews", NEW) + mq_rows(t, data, "qodo_reviews", OLD),
               "qodo_verdicts": mq_rows(t, data, "qodo_verdicts", NEW) + mq_rows(t, data, "qodo_verdicts", OLD)}
    q = CM.Qodo(view)
    out["qodo.issues"] = len(issues)
    out["qodo.issues.functional"] = sum(1 for v in kind.values() if v == "functional")
    out["qodo.issues.rule"] = sum(1 for v in kind.values() if v == "rule")
    out["qodo.issues.prs"] = len({k[0] for k in issues})
    hits: Dict[str, Dict[str, set]] = {}
    for a in ARMS:
        work, tool = QODO_WORK[a], MQ_TOOL[a]
        rs = [r for r in mq_rows(t, data, "qodo_reviews", a) if r["tool"] == tool]
        vs = [v for v in mq_rows(t, data, "qodo_verdicts", a) if v["tool"] == tool and v["judge"] == MQ_JUDGE]
        out[f"qodo.{a}.prs"] = len(rs)
        hits[a] = {}
        for rule, loc, suffix in QODO_RULES:
            k = f"{work}|{tool}@{MQ_JUDGE}:"
            for m in ("comments", "per_pr", "precision", "recall", "f1", "recall_functional", "recall_rule"):
                out[f"qodo.{a}.{rule}.{m}"] = q.value(k + m + (suffix if m not in ("comments", "per_pr") else ""))
            h = {(v["pr_url"], v["issue_index"]) for v in vs if v["matched"] and (loc is None or v[loc])}
            hits[a][rule] = h
            out[f"qodo.{a}.{rule}.hits"] = len(h)
            for x in ("functional", "rule"):
                out[f"qodo.{a}.{rule}.hits_{x}"] = sum(1 for i in h if kind[i] == x)
        body = {(r["pr_url"], c["index"]): c["body"] for r in rs for c in r["comments"] or []}
        out[f"qodo.{a}.comments.listed"] = len(body)
        out[f"qodo.{a}.comments.prs_without"] = sum(1 for r in rs if not r["n_comments"])
        for name, f in (("tag", _tag), ("severity", _footer)):
            for x, n in collections.Counter(f(b) for b in body.values()).items():
                out[f"qodo.{a}.comments.{name}.{x}"] = n
        for v in vs:
            if v["matched"] and v["located_n5"]:
                b = body[(v["pr_url"], v["comment_index"])]
                for name, f in (("tag", _tag), ("severity", _footer), ("lens", _lens)):
                    k = f"qodo.{a}.n5_hits.{kind[(v['pr_url'], v['issue_index'])]}.{name}.{f(b)}"
                    out[k] = out.get(k, 0) + 1
        _cost(out, f"mq_cost.qodo.{a}", rs)
    _paired(out, "qodo.paired.n5", hits[NEW]["n5"], hits[OLD]["n5"], kind)
    _paired(out, "qodo.paired.semantic", hits[NEW]["semantic"], hits[OLD]["semantic"], kind)
    # the rule-violation drop: final1's N=5 rule hits from comments the quiet default neither raises nor posts
    quiet = ("P3", "nit")
    g = out.get
    out["qodo.drop.old_rule_hits_nit_tag"] = g(f"qodo.{OLD}.n5_hits.rule.tag.nit", 0)
    out["qodo.drop.old_rule_hits_quiet"] = sum(g(f"qodo.{OLD}.n5_hits.rule.severity.{s}", 0) for s in quiet)
    out["qodo.drop.old_functional_hits_quiet"] = sum(g(f"qodo.{OLD}.n5_hits.functional.severity.{s}", 0) for s in quiet)
    # each setup's rule hits at P0 to P2 by the comment's footer, as the README defines severity: a finding posted
    # in the review body has no footer and is counted apart (rule_hits_no_footer), never folded into P0 to P2
    for a, x in ((OLD, "old"), (NEW, "new")):
        out[f"qodo.drop.{x}_rule_hits_p0_p2"] = sum(g(f"qodo.{a}.n5_hits.rule.severity.{s}", 0) for s in ("P0", "P1", "P2"))
        out[f"qodo.drop.{x}_rule_hits_no_footer"] = g(f"qodo.{a}.n5_hits.rule.severity.none", 0)
    for a in ARMS:
        out[f"qodo.drop.{a}_nits"] = g(f"qodo.{a}.comments.tag.nit", 0)
    _rate_limited(out, t, "qodo-pr100")
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
        **mq_post_values(n),
    }


PCT_KEYS = ("precision", "recall", "f1", "f2", "recall_functional", "recall_rule")


def _group(n: Dict[str, object], prefix: str) -> Dict[str, object]:
    """The numbers under `prefix.`, by the rest of their name."""
    return {k[len(prefix) + 1:]: v for k, v in n.items() if k.startswith(prefix + ".")}


def _rd(k: str, v):
    """A number in the numbers file's rounding: rates one decimal, means and dollars two, minutes one."""
    if v is None or isinstance(v, bool):
        return v
    last = k.rsplit(".", 1)[-1]
    if last in PCT_KEYS or last.startswith("minutes"):
        return round(v, 1)
    if last in ("per_pr", "mean") or last.startswith("usd") or last.endswith("_mean"):
        return round(v, 2)
    return v


def mq_post_values(n: Dict[str, object]) -> Dict[str, object]:
    """The Martian and Qodo groups of post_values (POST's comment): rates and minutes one decimal, means and
    dollars two; a delta (s62 minus final1) is of the rounded numbers, as the numbers file has it."""
    g = n.get
    r = lambda k: _rd(k, g(k))  # noqa: E731
    martian = {a: {"prs": g(f"martian.{a}.prs"),
                   **{p: {f: r(f"martian.{a}.{p}.{f}") for f in ("precision", "recall", "f1", "f2", "tp", "golden",
                                                                  "fp", "fn")} for p in MARTIAN_PROFILES}}
               for a in ARMS}
    martian["delta"] = {p: {f: round(martian[NEW][p][f] - martian[OLD][p][f], 1) for f in
                            ("precision", "recall", "f1", "f2", "tp", "fp")} for p in MARTIAN_PROFILES}
    qodo = {"issues": {k: g(f"qodo.issues{'' if k == 'total' else '.' + k}")
                       for k in ("total", "functional", "rule", "prs")},
            **{a: {"prs": g(f"qodo.{a}.prs"),
                   **{rule: {m: r(f"qodo.{a}.{rule}.{m}") for m in ("comments", "per_pr", "precision", "recall", "f1",
                                                                     "recall_functional", "recall_rule", "hits",
                                                                     "hits_functional", "hits_rule")}
                      for rule, _, _ in QODO_RULES}} for a in ARMS}}
    qodo["delta"] = {rule: {m: round(qodo[NEW][rule][m] - qodo[OLD][rule][m], 2) for m in
                            ("per_pr", "precision", "recall", "f1", "recall_functional", "recall_rule", "hits",
                             "hits_functional", "hits_rule")} for rule, _, _ in QODO_RULES}
    return {
        "martian": martian,
        "martian_goldens": {"goldens": _group(n, "martian.goldens"),
                            **{a: _group(n, f"martian.{a}.found") for a in ARMS},
                            "paired": _group(n, "martian.paired")},
        "martian_comments": {a: {k: r(f"martian.{a}.comments.{k}") for k in _group(n, f"martian.{a}.comments")}
                             for a in ARMS},
        "martian_rejudged": {**{a: _group(n, f"martian.{a}.rejudged") for a in ARMS},
                             "max_core_move": g("martian.rejudged.max_core_move")},
        "qodo": qodo,
        "qodo_comments": {**{a: _group(n, f"qodo.{a}.comments") for a in ARMS},
                          **{f"{a}_n5_hits": _group(n, f"qodo.{a}.n5_hits") for a in ARMS},
                          "paired": _group(n, "qodo.paired"), "drop": _group(n, "qodo.drop")},
        "mq_cost": {k: r(f"mq_cost.{k}") for k in _group(n, "mq_cost")},
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
    ("martian", "Martian's scores of each setup per profile (Core, Strict, All), recounted from the verdicts and the "
                "reviews' false positives (martian_scores.counts), and their difference"),
    ("martian_goldens", "the goldens each setup found by Martian's category and severity and by the audit bucket, "
                        "and the goldens found by both setups, one or neither"),
    ("martian_comments", "each setup's inline comments posted, the first page Martian read of them, its extracted "
                         "candidates and the comments' tags"),
    ("martian_rejudged", "the re-judged comparators' Core counts in each Martian scoring, and the most one moved"),
    ("qodo", "Qodo's issues, and each setup's comments, precision, recall, F1 and recall by issue kind under each "
             "location rule (claim_metrics.Qodo), and their difference"),
    ("qodo_comments", "the judged comments' tags and footer severities and those of the N=5 hits, the issues found "
                      "by both setups, one or neither, and the rule-violation drop"),
    ("mq_cost", "Martian and Qodo: list-price dollars and minutes per review, and s62's reviews that finished ok "
                "and its rate-limit errors"),
)
COLUMNS_CHECK = ("every table has exactly its listed columns, and the Martian and Qodo tables those of the dataset's "
                 "tables of the same names")
WHOLE_CHECK = ("the rows are whole: s62 reviewed and was judged on final1's pull requests in the dataset (arm "
               "quickreview-frozen), one verdict on every answer-key defect at its key version, every judged comment "
               "a posted one (inline or in the review body), and every Elo judgment of a unit of its plan between s62 "
               "and final1, in its file's order; s62's Martian and Qodo scorings are of final1's pull requests there, "
               "one verdict on every golden or issue, Martian scores that recount, Qodo matches one to one and "
               "located as qodo_judge.located gives, and one case per review with its cost")
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
        cols.update({f"the dataset's {t}": c for t in MQ_TABLES if sorted(c := dataset_columns(root, t)) != sorted(TABLES[t])})
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
    cases = aacr_cases(t)
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
    off = sorted(f"{r['arm_id']}/{r['instance_id']}" for r in cases if counts[(r["arm_id"], r["instance_id"])] != r["n_posted"])
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
    bad.update(mq_whole_problems(t, data))
    return bad


def mq_whole_problems(t: Dict[str, List[dict]], data: Dict[str, List[dict]]) -> Dict[str, object]:
    """The folder's Martian and Qodo rows against each other and the dataset's: {problem: examples}."""
    sys.path.insert(0, os.path.join(os.path.dirname(HERE), "ext"))
    import martian_scores as MS
    from qodo_judge import located
    bad: Dict[str, object] = {}
    for name in MQ_TABLES:
        martian = name.startswith("martian")
        work = (MARTIAN_WORK if martian else QODO_WORK)[NEW]
        stray = sorted({f"{r['work_dir']}|{r['tool']}@{r['judge']}" for r in t[name]
                        if r["work_dir"] != work or r["judge"] != MQ_JUDGE
                        or not (r["tool"] == NEW or (martian and str(r["tool"]).startswith(REJUDGED)))})
        if stray:
            bad[f"{name}: a row of another scoring, tool or judge than s62's (work dir {work}, judge {MQ_JUDGE})"] = stray[:5]
    for name in ("martian_reviews", "qodo_reviews"):
        mine = sorted(r["pr_url"] for r in t[name] if r["tool"] == NEW)
        old = sorted(r["pr_url"] for r in data[f"old_{name}"] if r["tool"] == OLD_ARM)
        if mine != old or not mine or len(set(mine)) != len(mine):
            bad[f"{name}: s62's pull requests are not final1's in the dataset (tool {OLD_ARM})"] = {NEW: len(mine), OLD: len(old)}
    # one verdict per golden (issue) of every review's PR, and none on a PR without its review
    want = {"martian": collections.defaultdict(set), "qodo": collections.defaultdict(set)}
    for g in data["martian_goldens"]:
        want["martian"][g["pr_url"]].add(g["golden_index"])
    for i in data["qodo_issues"]:
        want["qodo"][i["pr_url"]].add(i["issue_index"])
    for b, col in (("martian", "golden_index"), ("qodo", "issue_index")):
        got = collections.defaultdict(list)
        for v in t[f"{b}_verdicts"]:
            got[(v["tool"], v["pr_url"])].append(v[col])
        revs = {(r["tool"], r["pr_url"]) for r in t[f"{b}_reviews"]}
        off = sorted(f"{k[0]}|{k[1]}" for k in revs | set(got)
                     if k not in revs or sorted(got.get(k, [])) != sorted(want[b].get(k[1], ())))
        if off:
            bad[f"{b}_verdicts: not one verdict on each {col.split('_')[0]} of a reviewed PR"] = off[:5]
    # the stored Martian scores recount from the verdicts and the reviews' false positives
    off = []
    for sc in t["martian_scores"]:
        try:
            c = MS.counts(data["martian_goldens"], t["martian_verdicts"], t["martian_reviews"], sc["work_dir"],
                          sc["tool"], sc["judge"])
        except SystemExit:
            off.append(f"{sc['tool']}: no reviews")
            continue
        off += [f"{sc['tool']} {p}" for p in MARTIAN_PROFILES
                if c[p] != (sc[f"{p}_tp"], sc[f"{p}_fp"], sc[f"{p}_fn"])]
    if off or sorted(sc["tool"] for sc in t["martian_scores"]) != sorted({r["tool"] for r in t["martian_reviews"]}):
        bad["martian_scores: not one row per tool that recounts from its verdicts and its reviews' false positives"] = off[:5]
    # a Qodo match names a comment the review has, one to one, and its location flags are qodo_judge.located's
    issues = {(i["pr_url"], i["issue_index"]): i for i in data["qodo_issues"]}
    comments = {(r["tool"], r["pr_url"]): {c["index"]: c for c in r["comments"] or []} for r in t["qodo_reviews"]}
    off, used = [], set()
    for v in t["qodo_verdicts"]:
        k = (v["tool"], v["pr_url"])
        c = comments.get(k, {}).get(v["comment_index"]) if v["matched"] else None
        if v["matched"] and (c is None or k + (v["comment_index"],) in used):
            off.append(f"{v['pr_url']}#{v['issue_index']}: comment {v['comment_index']}")
            continue
        if c is not None:
            used.add(k + (v["comment_index"],))
        x = issues.get((v["pr_url"], v["issue_index"]))
        flags = (bool(c) and x is not None and located(c, x, 5), bool(c) and x is not None and located(c, x, float("inf")))
        if flags != (bool(v["located_n5"]), bool(v["located_same_file"])):
            off.append(f"{v['pr_url']}#{v['issue_index']}: located")
    if off:
        bad["qodo_verdicts: a match on no comment of the review, or twice, or location flags qodo_judge.located does "
            "not give"] = off[:5]
    # s62's Martian and Qodo cases: one per reviewed PR, its cost and minutes the review row's, scored; a Martian
    # case's inline comments the review's
    revs = {"martian50": {r["pr_url"]: r for r in t["martian_reviews"] if r["tool"] == NEW},
            "qodo-pr100": {r["pr_url"]: r for r in t["qodo_reviews"] if r["tool"] == NEW}}
    for s_ in MQ_SETS:
        cs = [r for r in t["cases"] if r["arm_id"] == NEW and r["set"] == s_]
        off = sorted(str(r["pr_url"]) for r in cs
                     if r["pr_url"] not in revs[s_] or not r["judged"]
                     or (r["usd"], r["minutes"]) != (revs[s_][r["pr_url"]]["cost_usd"], revs[s_][r["pr_url"]]["minutes"])
                     or (s_ == "martian50" and r["n_posted"] != revs[s_][r["pr_url"]]["n_posted_inline"]))
        if off or sorted(r["pr_url"] for r in cs) != sorted(revs[s_]):
            bad[f"cases: s62's {s_} cases are not one per reviewed PR with its review's cost, minutes and comments"] = off[:5]
    arms = {r["arm_id"]: r for r in t["arms"]}
    off = sorted(a for a in ARMS if (arms.get(a) or {}).get("martian_run") != MARTIAN_WORK[a]
                 or (arms.get(a) or {}).get("qodo_run") != QODO_WORK[a])
    if off:
        bad["arms: a setup's martian_run or qodo_run is not its scoring's work dir"] = off
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
    # s62's Martian and Qodo reviews ran from the same image, config, build, pi and engine as its AACR runs
    mq = {s: (json.load(open(os.path.join(a.runs_dir, f"{NEW}-{s}", "run.json"))),
              json.load(open(os.path.join(a.runs_dir, f"{NEW}-{s}.arm.json")))) for s in MQ_SETS}
    for s, (r, x) in mq.items():
        for what, got, want in (("qcr_commit", r["qcr_commit"], commit), ("pi", r.get("pi"), pi),
                                ("engine", r.get("engine"), rj[0].get("engine")),
                                ("model", r["models"]["conversation"], rj[0]["models"]["conversation"]),
                                ("profile", r.get("profile") or None, rj[0].get("profile") or None),
                                ("image_id", x["image_id"], image_id), ("image", x["image"], aj[0]["image"]),
                                ("config", x["config"], aj[0]["config"])):
            if got != want:
                raise SystemExit(f"{NEW}-{s}: its {what} {got!r} is not the AACR runs' {want!r}")
    mq_judge = one([_mq_judge(os.path.join(a.runs_dir, d)) for arm in ARMS
                    for d in (MARTIAN_WORK[arm] + ".martian", QODO_WORK[arm] + ".qodo")], "Martian and Qodo judge")
    tables["arms"].append({
        "arm_id": NEW, "display_name": labels.get(NEW), "dataset_arm": None,
        "image": one([x["image"] for x in aj], "image"), "image_id": image_id,
        "config": one([x["config"] for x in aj], "config"), "profile": one([r.get("profile") or None for r in rj], "profile"),
        **f, "pi": pi, "pi_source": _pi_source(image_id, pi), "engine": _engine(one([r.get("engine") for r in rj], "engine")),
        "reviewer_model": one([r["models"]["conversation"] for r in rj], "model"), "judge": NEW_JUDGE_DIR,
        "runs": runs, "prs": sum(len(r["cases"]) for r in rj),
        "martian_run": MARTIAN_WORK[NEW], "qodo_run": QODO_WORK[NEW], "mq_judge": mq_judge,
        "note": "QuickReview 1.6.0 with review.quiet=true (no nits, nothing below P2), on the SDK engine; its "
                "reviews and verdicts are this folder's, its Martian and Qodo reviews and scorings too (tool s62)"})
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
        "martian_run": MARTIAN_WORK[OLD], "qodo_run": QODO_WORK[OLD], "mq_judge": mq_judge,
        "note": f"the build frozen on 2026-10-04, no quiet default; its runs record pi {one([r.get('pi') for r in oj], 'final1 pi')} "
                f"and no engine (they predate the SDK engine); its reviews, verdicts and build ids are the "
                f"dataset's (arm {OLD_ARM} in arms, reviews, defect_verdicts, comment_verdicts; runs {OLD}-* in runs), "
                f"and so are its Martian and Qodo scorings (tool {OLD_ARM}, work dirs {MARTIAN_WORK[OLD]} and "
                f"{QODO_WORK[OLD]} in martian_* and qodo_*)"})

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
            tables["cases"].append({"arm_id": NEW, "instance_id": pr, "set": s, "run": run, "pr_url": None,
                                    "status": summ.get("status"), "verdict": (res.get("qcr") or {}).get("verdict"),
                                    "usd": usd, "minutes": mins, "n_posted": len(posted),
                                    "model_errors": _model_errors(summ), "judged": j is not None,
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

    collect_mq(a, tables, H, compare, S)

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


def _model_errors(summ: dict) -> Optional[dict]:
    """A case summary's model error counts (rate_limited, overloaded, usage_limit, other); None where it records
    none."""
    me = summ.get("model_errors")
    if not isinstance(me, dict):
        return None
    return {k: me.get(k) if isinstance(me.get(k), int) else None for k in ("rate_limited", "overloaded", "usage_limit", "other")}


def _mq_judge(score_dir: str) -> str:
    """A Martian or Qodo scoring's judge, as its judge/JUDGE.txt names it, checked against every call its
    judge/judge.jsonl records: each answered call (HTTP 200) asked for and was served MQ_JUDGE at MQ_EFFORT."""
    with open(os.path.join(score_dir, "judge", "JUDGE.txt")) as f:
        named = [x.strip() for x in f.read().split(",")[:2]]
    if named != [MQ_JUDGE, f"reasoning effort {MQ_EFFORT}"]:
        raise SystemExit(f"{score_dir}: JUDGE.txt names {named}, not {MQ_JUDGE} at {MQ_EFFORT}")
    ok = 0
    for r in _read_jsonl(os.path.join(score_dir, "judge", "judge.jsonl")):
        if r.get("probe") or r.get("status") != 200:
            continue
        if (r.get("asked_model"), r.get("served_model"), r.get("effort")) != (MQ_JUDGE, MQ_JUDGE, MQ_EFFORT):
            raise SystemExit(f"{score_dir}: a judge call asked {r.get('asked_model')}, was served "
                             f"{r.get('served_model')} at {r.get('effort')}")
        ok += 1
    if not ok:
        raise SystemExit(f"{score_dir}: judge.jsonl records no answered call")
    return f"{MQ_JUDGE} at reasoning effort {MQ_EFFORT}"


def collect_mq(a, tables: Dict[str, List[dict]], H, compare, S) -> None:
    """s62's Martian and Qodo reviews and scorings, as the export builds the dataset's own (hf_export's
    _martian_dir and _qodo_dir on the scoring dirs, `quickreview` named s62), with Martian's published scores of
    other tools left out (the dataset's martian_scores holds them); and s62's Martian and Qodo cases."""
    import martian_real
    runs_dir = os.path.abspath(a.runs_dir)
    sets = os.path.join(os.path.dirname(HERE), "sets")
    x = H.Exporter(argparse.Namespace(runs_dir=runs_dir))
    pub = {w: json.load(open(os.path.join(runs_dir, w + ".martian", "published-benchmark_data.json")))
           for w in MARTIAN_WORK.values()}
    if pub[MARTIAN_WORK[NEW]] != pub[MARTIAN_WORK[OLD]]:
        raise SystemExit("the two Martian scorings read different published goldens")
    goldens = martian_real.buckets(pub[MARTIAN_WORK[NEW]])
    mset = json.load(open(os.path.join(sets, "martian50.json")))["cases"]
    set_by_url = {c["martian"]["golden_url"]: c["instance_id"] for c in mset}
    rv, vd, sc = [], [], []
    x._martian_dir(MARTIAN_WORK[NEW] + ".martian", {"quickreview": NEW}, goldens, set_by_url, rv, vd, sc, paper=False)
    sc = [r for r in sc if not str(r["judge"]).startswith("published: ")]
    with open(a.qodo_gt, "rb") as f:
        raw = f.read()
    if hashlib.sha256(raw).hexdigest() != H.QODO_GT_SHA256:
        raise SystemExit("--qodo-gt is not the pinned Qodo PR-Review-Bench file (sha256 mismatch)")
    gt = {r["pr_url_to_review"]: r for r in map(json.loads, raw.decode().splitlines()) if r}
    qset = json.load(open(os.path.join(sets, "qodo-pr100.json")))["cases"]
    qr, qv = [], []
    x._qodo_dir(x.rd(QODO_WORK[NEW] + ".qodo"), QODO_WORK[NEW], {"quickreview": NEW}, QODO_WORK[NEW], gt,
                {c["pr_url"]: c for c in qset}, {}, qr, qv, False)
    if x.notes:
        raise SystemExit(f"the export's notes on s62's scorings: {x.notes}")
    for name, rows in (("martian_reviews", rv), ("martian_verdicts", vd), ("martian_scores", sc),
                       ("qodo_reviews", qr), ("qodo_verdicts", qv)):
        for r in rows:
            if sorted(r) != sorted(TABLES[name]):
                raise SystemExit(f"{name}: the export's row has columns {sorted(r)}, not {sorted(TABLES[name])}")
        tables[name] += rows
    scored = {"martian50": {r["pr_url"] for r in rv if r["tool"] == NEW}, "qodo-pr100": {r["pr_url"] for r in qr}}
    url_of = {"martian50": {c["instance_id"]: c["martian"]["golden_url"] for c in mset},
              "qodo-pr100": {c["instance_id"]: c["pr_url"] for c in qset}}
    for s in MQ_SETS:
        run = f"{NEW}-{s}"
        for pr in json.load(open(os.path.join(runs_dir, run, "run.json")))["cases"]:
            case = os.path.join(runs_dir, run, "cases", pr)
            summ = json.load(open(os.path.join(case, "case-summary.json")))
            usd, mins = compare.usd_and_minutes(case)
            res = json.load(open(os.path.join(runs_dir, run, "results", "all", f"{pr}.json")))
            tables["cases"].append({
                "arm_id": NEW, "instance_id": pr, "set": s, "run": run, "pr_url": url_of[s][pr],
                "status": summ.get("status"), "verdict": (res.get("qcr") or {}).get("verdict"), "usd": usd,
                "minutes": mins, "n_posted": len(json.load(open(os.path.join(case, "comments.json")))),
                "model_errors": _model_errors(summ), "judged": url_of[s][pr] in scored[s], "judge_input_tokens": None,
                "judge_output_tokens": None, "judge_cache_read_tokens": None})


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

def mq_readme(n: Dict[str, object]) -> str:
    """The README's "Martian and Qodo" section (readme())."""
    i = lambda k: f"{int(n[k]):,}"  # noqa: E731
    d1 = lambda k: f"{n[k]:.1f}"  # noqa: E731
    d2 = lambda k: f"{n[k]:.2f}"  # noqa: E731
    prf = lambda p: "{} / {} / {} / {}".format(*(d1(f"{p}.{f}") for f in ("precision", "recall", "f1", "f2")))  # noqa: E731
    martian = "\n".join(
        f"| {p.capitalize()} precision / recall / F1 / F2 | {prf(f'martian.{NEW}.{p}')} | {prf(f'martian.{OLD}.{p}')} |\n"
        f"| {p.capitalize()} goldens found (of {i(f'martian.{NEW}.{p}.golden')}) | {i(f'martian.{NEW}.{p}.tp')} | "
        f"{i(f'martian.{OLD}.{p}.tp')} |" for p in MARTIAN_PROFILES)
    qprf = lambda k: "{} / {} / {}".format(*(d1(f"{k}.{f}") for f in ("precision", "recall", "f1")))  # noqa: E731
    names = {"n5": "N=5", "same_file": "Same file", "semantic": "Semantic only"}
    qodo = "\n".join(f"| {names[r]} precision / recall / F1 | {qprf(f'qodo.{NEW}.{r}')} | {qprf(f'qodo.{OLD}.{r}')} |"
                     for r, _, _ in QODO_RULES)
    pc, pq = "martian.paired.category.total", "qodo.paired.n5"

    def body(x: str) -> str:  # the rule hits from review-body findings, which have no footer and so no severity
        nf = int(n[f"qodo.drop.{x}_rule_hits_no_footer"])
        return "" if not nf else (f" (and {nf:,} from {'a review-body finding, which has' if nf == 1 else 'review-body findings, which have'}"
                                  " no footer)")
    tags = lambda a: ", ".join(f"{i(k)} `[{k.rsplit('.', 1)[1]}]`" for k in sorted(  # noqa: E731
        (k for k in n if k.startswith(f"martian.{a}.comments.tag.")), key=lambda k: -n[k]))
    cost = "\n".join(
        f"| {label} | {fmt(f'mq_cost.martian.{NEW}.{m}')} | {fmt(f'mq_cost.martian.{OLD}.{m}')} | "
        f"{fmt(f'mq_cost.qodo.{NEW}.{m}')} | {fmt(f'mq_cost.qodo.{OLD}.{m}')} |"
        for label, m, fmt in (("$ per PR (list price)", "usd_per_pr", d2), ("Median $ per PR", "usd_median", d2),
                              ("Median minutes per review", "minutes_median", d1),
                              ("Mean minutes per review", "minutes_mean", d1)))
    return f"""## Martian and Qodo

The same two setups on two more benchmarks: Martian's code-review benchmark ({i(f'martian.{NEW}.prs')} pull
requests, {i('martian.goldens.total')} golden comments) and Qodo's PR-Review-Bench ({i('qodo.issues.prs')} pull
requests, {i('qodo.issues')} issues: {i('qodo.issues.functional')} functional, {i('qodo.issues.rule')} rule
violations). One review per pull request and setup. Both setups were scored by the same judge, `{MQ_JUDGE}` at
reasoning effort {MQ_EFFORT} (`arms.mq_judge`), with Martian's own pipeline on Martian and
`bench/aacr/ext/qodo_judge.py` on Qodo: `{OLD}` on 2026-10-04, `{NEW}` on 2026-11-20. `{NEW}`'s rows are this
folder's `martian_*` and `qodo_*` tables (tool `{NEW}`, work dirs `{MARTIAN_WORK[NEW]}` and
`{QODO_WORK[NEW]}`); `{OLD}`'s are the dataset's (tool `{OLD_ARM}`, work dirs `{MARTIAN_WORK[OLD]}` and
`{QODO_WORK[OLD]}`). `gpt62_sol.py` recomputes every count, rate and dollar figure below from those rows; the
scoring dates are those of each scoring's judge log (`judge.jsonl`), which this folder does not carry.

**Martian** (`martian_verdicts`, `martian_reviews.fp`, and the dataset's `martian_goldens`). Martian's scorer
counts, per profile, the goldens a review matched (found), the candidates it extracted from the review that
matched no golden (false positives, the same under every profile) and the goldens missed. Core leaves out
the goldens Martian categorises `style` and `speculative`; Strict also `doc_defect`, `test_gap` and `perf`.
The counts are `recompute/martian_scores.py`'s (`counts`, `metrics`), and the folder's stored
`martian_scores` rows recount from its verdicts.

| Martian | `{NEW}` | `{OLD}` |
|---|---:|---:|
{martian}
| False positives | {i(f'martian.{NEW}.core.fp')} | {i(f'martian.{OLD}.core.fp')} |
| Inline comments posted (per PR) | {i(f'martian.{NEW}.comments.posted.total')} ({d1(f'martian.{NEW}.comments.posted.mean')}) | {i(f'martian.{OLD}.comments.posted.total')} ({d1(f'martian.{OLD}.comments.posted.mean')}) |
| Read by Martian (the first {MARTIAN_PAGE} per PR) | {i(f'martian.{NEW}.comments.ingested.total')} | {i(f'martian.{OLD}.comments.ingested.total')} |
| Candidates extracted | {i(f'martian.{NEW}.comments.extracted.total')} | {i(f'martian.{OLD}.comments.extracted.total')} |

Of the {i(pc + '.items')} goldens both setups found {i(pc + '.both')}, only `{NEW}` {i(pc + f'.{NEW}_only')}, only
`{OLD}` {i(pc + f'.{OLD}_only')}, and neither {i(pc + '.neither')}. Of the {i('martian.goldens.audit.real')} goldens
the dataset's audit (`martian_goldens.audit_bucket`) calls real, `{NEW}` found {i(f'martian.{NEW}.found.audit.real')}
and `{OLD}` {i(f'martian.{OLD}.found.audit.real')}. The inline comments by their tag: `{NEW}` {tags(NEW)};
`{OLD}` {tags(OLD)}. Martian's re-judged comparator reviews (`rejudged-*`) are the same inputs in both
scorings, yet their Core found or false-positive counts moved by up to {i('martian.rejudged.max_core_move')} between
the two: the judge's own run-to-run spread, beside `{NEW}`'s {n[f'martian.{NEW}.core.tp'] - n[f'martian.{OLD}.core.tp']:+d}
Core goldens found.

**Qodo** (`qodo_verdicts`, `qodo_reviews.n_comments`, and the dataset's `qodo_issues.functional`). The judge
matches each issue to at most one comment and each comment to at most one issue. Under the primary rule,
N=5, a match counts when the comment is on the issue's file and its lines come within 5 of the issue's
(`located_n5`); under "same file" when the file matches (`located_same_file`); under "semantic only"
always. Precision is the matches counted over the comments judged, recall over the
{i('qodo.issues')} issues (`claim_metrics.Qodo`, which `recompute/qodo_scores.py` reads); the two location
flags are checked against `qodo_judge.located`.

| Qodo | `{NEW}` | `{OLD}` |
|---|---:|---:|
| Comments judged (per PR) | {i(f'qodo.{NEW}.n5.comments')} ({d2(f'qodo.{NEW}.n5.per_pr')}) | {i(f'qodo.{OLD}.n5.comments')} ({d2(f'qodo.{OLD}.n5.per_pr')}) |
{qodo}
| N=5 recall on functional issues (found, of {i('qodo.issues.functional')}) | {d1(f'qodo.{NEW}.n5.recall_functional')} ({i(f'qodo.{NEW}.n5.hits_functional')}) | {d1(f'qodo.{OLD}.n5.recall_functional')} ({i(f'qodo.{OLD}.n5.hits_functional')}) |
| N=5 recall on rule violations (found, of {i('qodo.issues.rule')}) | {d1(f'qodo.{NEW}.n5.recall_rule')} ({i(f'qodo.{NEW}.n5.hits_rule')}) | {d1(f'qodo.{OLD}.n5.recall_rule')} ({i(f'qodo.{OLD}.n5.hits_rule')}) |

The difference is in the rule violations. Of `{OLD}`'s {i(f'qodo.{OLD}.n5.hits_rule')} rule-violation matches under
N=5, {i('qodo.drop.old_rule_hits_quiet')} came from comments whose footer gives P3 or nit
({i('qodo.drop.old_rule_hits_nit_tag')} of them tagged `[nit]`), a class the quiet default neither raises nor
posts: `{NEW}`'s judged comments hold {i(f'qodo.drop.{NEW}_nits')} nits, `{OLD}`'s {i(f'qodo.drop.{OLD}_nits')}.
By footer, `{OLD}`'s rule-violation matches at P0 to P2 number {i('qodo.drop.old_rule_hits_p0_p2')}{body('old')},
against `{NEW}`'s {i('qodo.drop.new_rule_hits_p0_p2')}{body('new')}.
On functional issues both setups found {i(pq + '.functional.both')}, only `{NEW}` {i(pq + f'.functional.{NEW}_only')}
and only `{OLD}` {i(pq + f'.functional.{OLD}_only')}; on rule violations {i(pq + '.rule.both')}, {i(pq + f'.rule.{NEW}_only')} and {i(pq + f'.rule.{OLD}_only')}. The comments judged include the
findings each setup posted in the review body, which carry no footer (`{NEW}` {i(f'qodo.{NEW}.comments.severity.none')},
`{OLD}` {i(f'qodo.{OLD}.comments.severity.none')}); {i(f'qodo.{NEW}.comments.prs_without')} of `{NEW}`'s reviews
posted no comment and counts as no match.

**Cost and time** (`martian_reviews` and `qodo_reviews`: `cost_usd`, `minutes`, compare.usd_and_minutes at list
prices):

| | Martian `{NEW}` | Martian `{OLD}` | Qodo `{NEW}` | Qodo `{OLD}` |
|---|---:|---:|---:|---:|
{cost}

`{NEW}`'s reviews finished ok on all {i(f'mq_cost.martian50.{NEW}.ok')} Martian and {i(f'mq_cost.qodo-pr100.{NEW}.ok')}
Qodo pull requests (`cases`), and its case summaries record {i(f'mq_cost.martian50.{NEW}.rate_limited')} and
{i(f'mq_cost.qodo-pr100.{NEW}.rate_limited')} rate-limit errors (`cases.model_errors`).
"""


def mq_limits(n: Dict[str, object]) -> str:
    """The README's Limits on Martian and Qodo (readme())."""
    i = lambda k: f"{int(n[k]):,}"  # noqa: E731
    return f"""- On Martian and Qodo, too, `{NEW}` changes the model, the build and the quiet default at once, and no run
  has GPT-6.2 Sol on 1.6.0 with the quiet default off. The rule-violation reading above is consistent with
  the quiet default causing the drop; it does not measure it.
- Martian and Qodo: one review per pull request and setup, one judge pass each. The re-judged comparators
  give Martian's judge spread; Qodo had no second pass. The judge's model and effort are the same for
  both setups, but the scorings ran 47 days apart by their judge logs; by the repository's history,
  `qodo_judge.py`'s prompt and location rule did not change between them. `{OLD}`'s Qodo verdicts carry
  the judge the export names (its judge log records the model; its judgement file names none).
- Martian reads only the first {MARTIAN_PAGE} inline comments of a pull request: it left out
  {i(f'martian.{NEW}.comments.dropped')} of `{NEW}`'s on {i(f'martian.{NEW}.comments.prs_over_page')} pull requests and
  {i(f'martian.{OLD}.comments.dropped')} of `{OLD}`'s on {i(f'martian.{OLD}.comments.prs_over_page')}
  (`comments_beyond_first_page`).
- `{NEW}`'s dollars are at GPT-6.1 Sol's list price: the pi it ran prices GPT-6.2 Sol at that card. If
  GPT-6.2 Sol's list price differs, they scale with it. The Martian and Qodo dollars are separate from the
  AACR ones above.
- Minutes are wall-clock time under different load: `{NEW}` ran more reviews at once and hit rate limits, so
  they do not compare speed cleanly.
- A comment's severity is what its footer prints; the findings posted in a review body have none.
"""


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
judged side by side by two AI judges; and on Martian's code-review benchmark ({i(f'martian.{NEW}.prs')} pull
requests) and Qodo's PR-Review-Bench ({i('qodo.issues.prs')}), scored by one judge for both setups ("Martian and
Qodo" below). No config of the card reads this folder, so `load_dataset`
returns the same rows with or without it. `bench/aacr/recompute/gpt62_sol.py --data <this dataset>`
recomputes every number below from these tables and the dataset's own, checks that this README is the
one they give, refits the Elo ratings from the judgments, and runs the release's other checks of the
folder (`validation.json` holds them).

`{OLD}`'s reviews and its defect judge's verdicts are not repeated here: they are the dataset's arm
`{OLD_ARM}` (`reviews`, `defect_verdicts`, `comment_verdicts`; its runs `{OLD}-*` in `runs`), and its
Martian and Qodo scorings are the dataset's rows of tool `{OLD_ARM}` under work dirs `{MARTIAN_WORK[OLD]}`
and `{QODO_WORK[OLD]}` (`martian_reviews`, `martian_verdicts`, `martian_scores`, `qodo_reviews`,
`qodo_verdicts`). This folder holds `{NEW}`'s, and the pairwise judgments of the two.

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
  run's engine settings (null for `{OLD}`, whose runs record none). `martian_run` and `qodo_run` are each
  setup's Martian and Qodo review runs (the scorings' `work_dir`; `{NEW}`'s ran from the same image,
  config, build, pi and engine as its AACR runs), and `mq_judge` their judge, as each scoring's judge log
  records every answered call.
- `cases`: one row per review of `{NEW}`: set (the five AACR sets, and `martian50` and `qodo-pr100`, which
  carry the review's `pr_url`), run, `status`, the review's `verdict`, cost and minutes
  (compare.usd_and_minutes, as the dataset's `reviews.cost_usd`), `n_posted` (the inline comments),
  `model_errors` (the case summary's counts), whether the review was judged (by the defect judge; on
  Martian and Qodo, scored), and the defect judge's token usage.
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
- `martian_reviews`, `martian_verdicts`, `martian_scores`, `qodo_reviews`, `qodo_verdicts`: `{NEW}`'s
  Martian and Qodo scorings, with exactly the columns of the dataset's tables of the same names and built
  the same way (`hf_export.py`), its tool named `{NEW}`. The Martian tables also hold Martian's re-judged
  comparator reviews (tools `rejudged-*`, link-only) as this scoring judged them; Martian's published
  scores of other tools are the dataset's `martian_scores` alone. `run_family` is null: the runs are in
  no family of the dataset's run index.

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

{mq_readme(n)}
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
{mq_limits(n)}"""


# ---------------------------------------------------------------------------------------------------- CLI

def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "build":
        ap = argparse.ArgumentParser(prog="gpt62_sol.py build", description=build.__doc__)
        ap.add_argument("--runs-dir", required=True, help="the bench runs dir (it holds s62-* and final1-*)")
        ap.add_argument("--elo-dir", required=True, help="the dir holding the four Elo plan dirs (PLANS)")
        ap.add_argument("--data", required=True, help="a built dataset (data/ with defects and final1's rows), "
                        "for the README's numbers")
        ap.add_argument("--repo", required=True, help="a QuickReview checkout with origin/main fetched")
        ap.add_argument("--qodo-gt", required=True, help="Qodo's git_code_review_bench_100_w_open_prs.jsonl (the pinned "
                        "file the export reads)")
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
