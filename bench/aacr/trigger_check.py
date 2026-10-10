#!/usr/bin/env python3
"""Check a narrowed planning trigger against stored runs before shipping it.

The planning rule: no lens is removed or disabled; a
trigger may be NARROWED only where the evidence shows the lens planned with
nothing to do, and never below the cases behind its stored unique real
findings. This tool is that check, from stored data only (no review, no judge):

  trigger_check.py --runs-dir DIR --run RUN [--run RUN ...] \
      --unique-real CASES.json [--lens LENS ...]

For every lens and every candidate trigger in CANDIDATES below, over every
case of the runs:
  planned     cases whose stored pass-plan planned the lens
  none        of those, cases where the lens raised no finding at all (NONE)
  kept        planned cases the candidate would still plan
  none_after  NONE cases among the kept ones
  unique_real cases with a unique real finding by the lens (lens_yield.py
              --cases-json) and how many the candidate keeps — the bar: ALL.
              A unique-real case inside a selected run that could not be
              loaded (its files.json, pass-plan.json or findings-record.json
              missing or unreadable) is listed as UNREAD: the bar is then
              unchecked for it, never met by leaving it out.

A candidate reads only what a stored case keeps: files.json (filename,
additions, deletions, status). A trigger that needs the patch or the PR text
cannot be replayed from it and is not listed here.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
from pathlib import Path

TEST = [re.compile(p) for p in (r"(^|/)tests?/", r"(^|/)__tests__/", r"(^|/)test_[^/]+$", r"_test\.[a-z0-9]+$",
                                 r"\.(test|spec)\.[a-z0-9]+$", r"(^|/)conftest\.py$", r"(^|/)fixtures/")]
CODE = re.compile(r"\.(py|pyi|ts|tsx|mts|cts|js|jsx|mjs|cjs|go|rb|java|kt|kts|rs|c|cc|cpp|cxx|h|hh|hpp|hxx|cs|php|swift|scala|dart|ex|exs|vue|svelte)$", re.I)
API_DIR = re.compile(r"(^|/)(serializers?|schemas?|apis?|views?|endpoints?|routes?|controllers?|handlers?)/")
JOB_DIR = re.compile(r"(^|/)(tasks|jobs|workers?|consumers?|queues?)/")


def is_test(n: str) -> bool:
    return any(p.search(n) for p in TEST)


def tests_candidate(files: list[dict]) -> bool:
    """pass-tests: the PR changes a test, or modifies/deletes existing
    non-test code (an existing test may now be wrong). A PR that only ADDS new
    non-test code and touches no test is left to the add protocol."""
    if any(is_test(f["filename"]) for f in files):
        return True
    return any(CODE.search(f["filename"]) and not is_test(f["filename"]) and (f.get("deletions", 0) > 0 or f.get("status") == "removed") for f in files)


def backcompat_candidate(files: list[dict]) -> bool:
    """pass-backcompat: the API/job path arms count only when the file
    MODIFIES or REMOVES existing code — a brand-new endpoint or job cannot
    break a caller built against the old version. Migrations, wire-format
    files and the content arms are unchanged (and not replayable here)."""
    for f in files:
        n = f["filename"]
        if re.search(r"\.(proto|graphql)$", n) or re.search(r"(^|/)migrations/", n):
            return True
        if CODE.search(n) and not is_test(n) and (API_DIR.search(n) or JOB_DIR.search(n)):
            if f.get("deletions", 0) > 0 or f.get("status") == "removed":
                return True
    return False


CANDIDATES = {
    "pass-tests": [("touches a test, or modifies existing code", tests_candidate)],
    "pass-backcompat": [("API/job paths only when existing code is modified", backcompat_candidate)],
}


def read(p: Path):
    try:
        return json.loads(p.read_text())
    except Exception:
        return None


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--runs-dir", default=os.environ.get("QCR_BENCH_RUNS_DIR", ""))
    ap.add_argument("--run", action="append", required=True)
    ap.add_argument("--unique-real", required=True, type=Path)
    ap.add_argument("--lens", action="append", default=[])
    a = ap.parse_args()
    ur = json.loads(a.unique_real.read_text())
    lenses = a.lens or list(CANDIDATES)
    cases = []
    run_roots = {(Path(a.runs_dir) / run / "cases").resolve() for run in a.run}
    for run in a.run:
        for cd in sorted(glob.glob(str(Path(a.runs_dir) / run / "cases" / "*"))):
            files = read(Path(cd) / "files.json")
            plan = read(Path(cd) / "pass-plan.json")
            rec = read(Path(cd) / "findings-record.json")
            if not isinstance(files, list) or not isinstance(plan, list) or not isinstance(rec, dict):
                continue
            raised = set()
            for fnd in rec.get("findings") or []:
                for l in re.findall(r"pass-[a-z][a-z-]*[a-z]", str(fnd.get("lens") or "")):
                    raised.add(l)
            cases.append({"dir": cd, "key": Path(cd).resolve(), "files": files, "planned": {r.get("lens") for r in plan}, "raised": raised})
    print(f"cases: {len(cases)} over {len(a.run)} run(s)\n")
    print("| lens | candidate | planned | NONE | kept | NONE after | unique-real cases kept |")
    print("|---|---|---|---|---|---|---|")
    loaded = {c["key"] for c in cases}
    for lens in lenses:
        ur_cases = {Path(p).resolve() for p in ur.get(lens, [])}
        unread = sorted(p.name for p in ur_cases if p.parent in run_roots and p not in loaded)
        for name, fn in CANDIDATES.get(lens, []):
            planned = [c for c in cases if lens in c["planned"]]
            none = [c for c in planned if lens not in c["raised"]]
            kept = [c for c in planned if fn(c["files"])]
            none_after = [c for c in kept if lens not in c["raised"]]
            ur_in = [c for c in cases if c["key"] in ur_cases]
            ur_kept = [c for c in ur_in if fn(c["files"])]
            lost = sorted(Path(c["dir"]).name for c in ur_in if not fn(c["files"]))
            print(f"| {lens} | {name} | {len(planned)} | {len(none)} ({100 * len(none) / max(1, len(planned)):.0f}%) | "
                  f"{len(kept)} | {len(none_after)} ({100 * len(none_after) / max(1, len(kept)):.0f}%) | "
                  f"{len(ur_kept)}/{len(ur_in)}{' LOST: ' + ', '.join(lost) if lost else ''}"
                  f"{' UNREAD: ' + ', '.join(unread) if unread else ''} |")


if __name__ == "__main__":
    main()
