#!/usr/bin/env python3
"""Pick a deterministic AACR-Bench case set from the PINNED v1.0 dataset.

v1.0 is git ab8af8d of alibaba/aacr-bench: 196 scored PRs, 1,505 reference
comments — the revision every published leaderboard row is denominated in
(x/1505). `main` has since moved (1,506), so this script refuses any file whose
sha256 is not v1.0's.

Usage:
    python3 select_cases.py <v1.0 positive_samples.json> smoke10 > sets/smoke10.json
    python3 select_cases.py <v1.0 positive_samples.json> full    > sets/full.json
    python3 select_cases.py <v1.0 positive_samples.json> rest145 > sets/rest145.json

`smoke10` — ten SMALL PRs for proving the plumbing end to end. The rule, in
order, so anyone can re-derive the set:
  1. 20 <= change_line_count <= 160 and at least 4 reference comments (fewer
     makes recall a coin toss; tinier PRs are not representative);
  2. language quota: Python 3, TypeScript 2, JavaScript 1, Go 1, Java 1,
     Rust 1, C 1 — weighted to the deployed repo's own stack (Python + TS) while
     still exercising the other languages the benchmark scores;
  3. within a language, smallest change_line_count first (ties: PR URL);
  4. at most one PR per repository, so a set never measures one project twice.
The next three eligible PRs per language are listed as `backups`, for the case
a head commit is no longer fetchable.

`holdout10` — ten PRs for checking that an improvement found on smoke10
GENERALISES (a change is kept only if it holds on both). Same filters as
smoke10, none of smoke10's repositories, quota Python 1 / TypeScript 2 /
JavaScript 2 / Go 1 / Java 2 / Rust 1 / C 1 (only one other Python repo is
eligible), smallest first, one PR per repo.

`dev10` — a second DEVELOPMENT set, so improvements are not tuned on
smoke10's eleven real references alone. The small-PR pool is spent (no
Python repository is left), so the ceiling rises to 400 changed lines. Same
other filters, none of smoke10's or holdout10's repositories, quota C++ 2 /
TypeScript 1 / JavaScript 1 / Go 1 / Java 1 / Rust 1 / C 1 / C# 1 / PHP 1
(C++ is the dataset's largest language), smallest first, one PR per repo.

`fresh10` — an OUT-OF-SAMPLE set for the review levers that were
designed from the missed defects of smoke10, dev10 and holdout10: none of those
30 PRs (a different PR of the same repository is allowed — the levers were
built from specific defects, not from projects), 60 <= change_line_count <=
400, no documentation / test-suite / style-only category, no reference minimum
(the defect benchmark builds its own ground truth), quota weighted to the
deployed stack — Python 4 / TypeScript 4 / JavaScript 1 / Go 1 — smallest
first, one PR per repo.

`full` — every v1.0 PR, in dataset order. That is the real benchmark.

Standard library only: it runs on the host before any image exists.
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
from collections import OrderedDict

V1_COMMIT = "ab8af8d5c74e2a4d1945d247ea4bbc49f93eb33f"
V1_SHA256 = "d8683cb240249bc4e0aff6428802bdffa7b7573ace600552cab1cd0cb7e905c9"

SMOKE_QUOTA = OrderedDict(
    [("Python", 3), ("TypeScript", 2), ("JavaScript", 1), ("Go", 1), ("Java", 1), ("Rust", 1), ("C", 1)]
)
SMOKE_MIN_LINES, SMOKE_MAX_LINES, SMOKE_MIN_REFS = 20, 160, 4
BACKUPS_PER_LANGUAGE = 3
HOLDOUT_QUOTA = OrderedDict(
    [("Python", 1), ("TypeScript", 2), ("JavaScript", 2), ("Go", 1), ("Java", 2), ("Rust", 1), ("C", 1)]
)
DEV_MAX_LINES = 400
FRESH_QUOTA = OrderedDict([("Python", 4), ("TypeScript", 4), ("JavaScript", 1), ("Go", 1)])
FRESH_MIN_LINES = 60
FRESH_SKIP_CATEGORIES = frozenset(
    {"Documentation Update", "Test Suite / CI Enhancements", "Code Style, Linting, Formatting Fixes"}
)
DEV_QUOTA = OrderedDict(
    [("C++", 2), ("TypeScript", 1), ("JavaScript", 1), ("Go", 1), ("Java", 1), ("Rust", 1), ("C", 1),
     ("C#", 1), ("PHP", 1)]
)

# Dataset heads GitHub no longer serves (force-pushed away): no reviewer can be
# run on them, so a set never selects them. Found by `bench.sh prefetch`.
UNREACHABLE_HEADS = {
    "nodejs__node@b225544": "upload-pack: not our ref b2255442 (checked 2026-09-25)",
    "astral-sh__uv@ed57db2": "upload-pack: not our ref ed57db2b (checked 2026-09-26)",
    "comfyanonymous__ComfyUI@cfc3122": "upload-pack: not our ref cfc31229 (checked 2026-09-26)",
    "comfyanonymous__ComfyUI@4936d01": "upload-pack: not our ref 4936d018 (checked 2026-09-26)",
}

# More heads GitHub no longer serves, found by check_available.py on the whole
# dataset. Kept apart from UNREACHABLE_HEADS so the earlier sets
# (and their backups) regenerate byte-identical; rest145 excludes both.
UNAVAILABLE_HEADS_2026_09_27 = {
    "ClickHouse__ClickHouse@fd6ba0c": "upload-pack: not our ref fd6ba0c1 (checked 2026-09-27)",
    "ClickHouse__ClickHouse@cc96255": "upload-pack: not our ref cc962559 (checked 2026-09-27)",
    "keycloak__keycloak@1463502": "upload-pack: not our ref 14635020 (checked 2026-09-27)",
    "keycloak__keycloak@2373a48": "upload-pack: not our ref 2373a483 (checked 2026-09-27)",
    "keycloak__keycloak@460f800": "upload-pack: not our ref 460f8008 (checked 2026-09-27)",
    "keycloak__keycloak@79dbba9": "upload-pack: not our ref 79dbba9b (checked 2026-09-27)",
    "keycloak__keycloak@21d4538": "upload-pack: not our ref 21d4538b (checked 2026-09-27)",
}

PR_URL = re.compile(r"github\.com/([^/]+)/([^/]+)/pull/(\d+)", re.IGNORECASE)


def case_of(record: dict) -> dict:
    """One dataset record -> one case, with the harness converter's instance_id
    (`owner__name@<head[:7]>`, evaluation/converters/aacr_bench.py)."""
    m = PR_URL.search(record["githubPrUrl"])
    if not m:
        raise SystemExit(f"unparseable PR url: {record['githubPrUrl']}")
    owner, name, pr = m.group(1), m.group(2), int(m.group(3))
    head = record["target_commit"]
    return {
        "instance_id": f"{owner}__{name}@{head[:7]}",
        "repo": f"{owner}/{name}",
        "pr": pr,
        "pr_url": record["githubPrUrl"],
        "base_commit": record["source_commit"],
        "head_commit": head,
        "language": record["project_main_language"],
        "pr_category": record["category"],
        "change_line_count": record["change_line_count"],
        "references": len(record.get("comments") or []),
    }


def smoke10(
    records: list[dict], quota_by_lang=None, exclude_repos=frozenset(), fill_to: int = 0,
    max_lines: int = SMOKE_MAX_LINES,
) -> tuple[list[dict], list[dict]]:
    """`fill_to`: when a language cannot meet its quota (holdout only), fill up
    to this many cases with the smallest remaining eligible PRs from unused
    repositories, any language — deterministic, and said in the set's rule."""
    quota_by_lang = quota_by_lang or SMOKE_QUOTA
    eligible = [
        c
        for c in (
            case_of(r)
            for r in records
            if SMOKE_MIN_LINES <= r["change_line_count"] <= max_lines
            and len(r.get("comments") or []) >= SMOKE_MIN_REFS
        )
        if c["instance_id"] not in UNREACHABLE_HEADS
    ]
    eligible.sort(key=lambda c: (c["change_line_count"], c["pr_url"]))
    chosen: list[dict] = []
    backups: list[dict] = []
    used_repos: set[str] = set(exclude_repos)
    for language, quota in quota_by_lang.items():
        spare = 0
        for c in (c for c in eligible if c["language"] == language):
            if c["repo"] in used_repos:
                continue
            if quota > 0:
                chosen.append(c)
                used_repos.add(c["repo"])
                quota -= 1
            elif spare < BACKUPS_PER_LANGUAGE:
                backups.append(c)
                spare += 1
        if quota > 0 and not fill_to:
            raise SystemExit(f"not enough eligible {language} PRs for the quota")
    for c in eligible:
        if len(chosen) >= fill_to:
            break
        if c["repo"] not in used_repos:
            chosen.append(c)
            used_repos.add(c["repo"])
    backups = [b for b in backups if b["instance_id"] not in {c["instance_id"] for c in chosen}]
    return chosen, backups


def fresh10(records: list[dict], taken: frozenset) -> list[dict]:
    eligible = [
        c
        for c in (case_of(r) for r in records if FRESH_MIN_LINES <= r["change_line_count"] <= DEV_MAX_LINES)
        if c["instance_id"] not in taken
        and c["instance_id"] not in UNREACHABLE_HEADS
        and c["pr_category"] not in FRESH_SKIP_CATEGORIES
    ]
    eligible.sort(key=lambda c: (c["change_line_count"], c["pr_url"]))
    chosen: list[dict] = []
    used: set[str] = set()
    for language, quota in FRESH_QUOTA.items():
        for c in (c for c in eligible if c["language"] == language):
            if quota == 0:
                break
            if c["repo"] in used:
                continue
            chosen.append(c)
            used.add(c["repo"])
            quota -= 1
        if quota > 0:
            raise SystemExit(f"not enough eligible {language} PRs for the fresh10 quota")
    return chosen


def main() -> None:
    if len(sys.argv) != 3 or sys.argv[2] not in ("smoke10", "holdout10", "dev10", "fresh10", "rest145", "full"):
        raise SystemExit(__doc__)
    path, name = sys.argv[1], sys.argv[2]
    raw = open(path, "rb").read()
    digest = hashlib.sha256(raw).hexdigest()
    if digest != V1_SHA256:
        raise SystemExit(
            f"{path} is not AACR-Bench v1.0 (sha256 {digest}, want {V1_SHA256}) — "
            "the published numbers are denominated in v1.0; refusing to build a set from anything else"
        )
    records = json.loads(raw)
    if name == "smoke10":
        cases, backups = smoke10(records)
        rule = (
            f"{SMOKE_MIN_LINES}<=change_line_count<={SMOKE_MAX_LINES}, >={SMOKE_MIN_REFS} references, "
            f"quota {dict(SMOKE_QUOTA)}, smallest first, one PR per repo"
        )
    elif name == "holdout10":
        smoke, _ = smoke10(records)
        cases, backups = smoke10(records, HOLDOUT_QUOTA, frozenset(c["repo"] for c in smoke), fill_to=10)
        rule = (
            f"{SMOKE_MIN_LINES}<=change_line_count<={SMOKE_MAX_LINES}, >={SMOKE_MIN_REFS} references, "
            f"no smoke10 repository, quota {dict(HOLDOUT_QUOTA)}, smallest first, one PR per repo; "
            f"unreachable heads excluded ({', '.join(UNREACHABLE_HEADS)}); a short language is filled "
            "with the smallest remaining eligible PR from an unused repo"
        )
    elif name == "dev10":
        smoke, _ = smoke10(records)
        holdout, _ = smoke10(records, HOLDOUT_QUOTA, frozenset(c["repo"] for c in smoke), fill_to=10)
        taken = frozenset(c["repo"] for c in smoke + holdout)
        cases, backups = smoke10(records, DEV_QUOTA, taken, fill_to=10, max_lines=DEV_MAX_LINES)
        rule = (
            f"{SMOKE_MIN_LINES}<=change_line_count<={DEV_MAX_LINES}, >={SMOKE_MIN_REFS} references, "
            f"no smoke10 or holdout10 repository, quota {dict(DEV_QUOTA)}, smallest first, one PR per repo; "
            f"unreachable heads excluded ({', '.join(UNREACHABLE_HEADS)}); a short language is filled "
            "with the smallest remaining eligible PR from an unused repo"
        )
    elif name == "fresh10":
        smoke, _ = smoke10(records)
        holdout, _ = smoke10(records, HOLDOUT_QUOTA, frozenset(c["repo"] for c in smoke), fill_to=10)
        dev, _ = smoke10(
            records, DEV_QUOTA, frozenset(c["repo"] for c in smoke + holdout), fill_to=10,
            max_lines=DEV_MAX_LINES,
        )
        cases, backups = fresh10(records, frozenset(c["instance_id"] for c in smoke + holdout + dev)), []
        rule = (
            f"{FRESH_MIN_LINES}<=change_line_count<={DEV_MAX_LINES}, not one of the smoke10/holdout10/dev10 PRs, "
            f"no {sorted(FRESH_SKIP_CATEGORIES)} category, quota {dict(FRESH_QUOTA)}, smallest first, "
            "one PR per repo — out-of-sample for the levers designed from those 30 PRs' missed defects"
        )
    elif name == "rest145":
        smoke, _ = smoke10(records)
        holdout, _ = smoke10(records, HOLDOUT_QUOTA, frozenset(c["repo"] for c in smoke), fill_to=10)
        dev, _ = smoke10(
            records, DEV_QUOTA, frozenset(c["repo"] for c in smoke + holdout), fill_to=10,
            max_lines=DEV_MAX_LINES,
        )
        fresh = fresh10(records, frozenset(c["instance_id"] for c in smoke + holdout + dev))
        taken = {c["instance_id"] for c in smoke + holdout + dev + fresh}
        gone = set(UNREACHABLE_HEADS) | set(UNAVAILABLE_HEADS_2026_09_27)
        cases = [c for c in (case_of(r) for r in records) if c["instance_id"] not in taken | gone]
        cases = [c for c in cases if c["references"] > 0]
        backups = []
        rule = (
            "every v1.0 PR the harness scores (at least one reference) that is not one of the "
            "smoke10/holdout10/dev10/fresh10 PRs and whose head GitHub still serves "
            f"(excluded as unfetchable: {', '.join(sorted(gone))}); dataset order — the rest of the "
            "benchmark, for the 2026-09-27 whole-benchmark runs"
        )
    else:
        cases, backups = [case_of(r) for r in records], []
        rule = "every v1.0 PR, dataset order"
    out = {
        "name": name,
        "dataset": {
            "source": "https://github.com/alibaba/aacr-bench",
            "commit": V1_COMMIT,
            "file": "dataset/positive_samples.json",
            "sha256": V1_SHA256,
        },
        "rule": rule,
        "references": sum(c["references"] for c in cases),
        "cases": cases,
        "backups": backups,
    }
    json.dump(out, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
