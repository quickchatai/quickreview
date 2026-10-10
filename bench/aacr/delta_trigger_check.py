#!/usr/bin/env python3
"""Replay the narrowed pass-behaviour-delta trigger on stored runs.

The rule: behaviour-delta is planned only where base behaviour is at risk
(src/heuristics.ts behaviourDeltaRisk), never removed, and
a narrowing must still plan the lens on every stored case where it produced a
posted real finding. This replays, from stored data only (no review, no judge):

  delta_trigger_check.py --runs-dir DIR KIND:RUN [KIND:RUN ...]

KIND is aacr | martian | qodo | swepr (lens_yield.py's adapters). For every case
it rebuilds the PR's per-file patches from the local caches (AACR: the code
dir's pr.diff; Martian / Qodo / SWE-PRBench: `git diff` in the bare caches at
the reviewed base and head), runs the BUILT heuristics (dist/src/heuristics.js,
run `npm run build` first) with and without the patches — without = the old
trigger — and reports:

  planned_old / planned_new    cases with at least one behaviour-delta row
  delta_posted_real            cases where the lens is among the raisers of a
                               posted root cause the benchmark credits
  kept                         of those, cases the new trigger still plans
  no_patch                     cases whose patches could not be rebuilt
                               (planned as before: no signal is never no risk)
"""
from __future__ import annotations

import argparse
import ast
import json
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE))
import lens_yield as ly  # noqa: E402

# The bench data root beside the runs dir (its parent): ext-cache/, *-code/.
CACHE = Path(".")
DELTA = "pass-behaviour-delta"


def split_diff(text: str) -> dict[str, str]:
    out: dict[str, list[str]] = {}
    cur = None
    for line in text.splitlines():
        m = re.match(r"^diff --git a/(.+?) b/(.+)$", line)
        if m:
            cur = m.group(2)
            out[cur] = []
            continue
        if cur is not None:
            out[cur].append(line)
    return {k: "\n".join(v) + "\n" for k, v in out.items()}


def git_diff(repo: Path, base: str, head: str) -> str | None:
    r = subprocess.run(["git", "-C", str(repo), "diff", "--no-color", "-M", base, head],
                       capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else None


def leak(c: dict) -> dict:
    lp = c.get("leakproof")
    return ast.literal_eval(lp) if isinstance(lp, str) else (lp or {})


def patches_for(kind: str, case: dict) -> dict[str, str] | None:
    iid = case["instance_id"]
    if kind == "aacr":
        for d in ("orig40-code", "rest145-code", "fresh10-code"):
            p = CACHE / d / iid / "pr.diff"
            if p.exists():
                return split_diff(p.read_text(errors="replace"))
        return None
    if kind == "martian":
        proj = ast.literal_eval(case["martian"])["project"] if isinstance(case.get("martian"), str) else case["martian"]["project"]
        d = git_diff(CACHE / "ext-cache" / "martian" / f"{proj}.git", case.get("expect_merge_base") or case["base_commit"], case["head_commit"])
        return split_diff(d) if d is not None else None
    if kind in ("qodo", "swepr"):
        lp = leak(case)
        sub = "qodo/git" if kind == "qodo" else "sweprbench"
        d = git_diff(CACHE / "ext-cache" / sub / f"{iid.split('@')[0]}.git", lp.get("source_merge_base"), lp.get("source_head"))
        return split_diff(d) if d is not None else None
    return None


SETS = {"aacr": ["dev10", "rest145"], "martian": ["martian-tune20"], "qodo": ["qodo-pr100"], "swepr": ["sweprbench-eval100"]}

NODE = r"""
const { behaviourDeltaGroups } = await import(process.argv[1]);
const cases = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const out = {};
for (const [k, files] of Object.entries(cases)) {
  const noPatch = files.map(({ patch, ...f }) => f);
  out[k] = { old: behaviourDeltaGroups(noPatch, 3, 500).groups.length, new: behaviourDeltaGroups(files, 3, 500).groups.length };
}
process.stdout.write(JSON.stringify(out));
"""


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--runs-dir", required=True)
    ap.add_argument("runs", nargs="+")
    a = ap.parse_args()
    runs = Path(a.runs_dir)
    global CACHE
    CACHE = runs.resolve().parent
    case_index: dict[str, tuple[str, dict]] = {}
    for kind, names in SETS.items():
        for n in names:
            f = HERE / "sets" / f"{n}.json"
            if f.exists():
                for c in json.load(open(f))["cases"]:
                    case_index.setdefault(c["instance_id"], (kind, c))
    payload: dict[str, list] = {}
    meta: dict[str, dict] = {}
    for spec in a.runs:
        kind, run = spec.split(":", 1)
        if kind == "aacr":
            it = ly.aacr_comments(runs, run)
        elif kind == "qodo":
            it = ly.qodo_comments(runs, run, HERE / "sets" / "qodo-pr100.json")
        elif kind == "swepr":
            it = ly.swepr_comments(runs, run, HERE / "sets" / "sweprbench-eval100.json")
        elif kind == "martian":
            it = ly.martian_comments(runs, run, HERE / "ext" / "martian-tuning" / "golden-audit-full.json")
        else:
            raise SystemExit(f"unknown kind {kind}")
        for case_dir, comments in it:
            key = f"{run}/{case_dir.name}"
            files = ly.read_json(case_dir / "files.json") or []
            _, c = case_index.get(case_dir.name, (kind, None))
            pt = patches_for(kind, c) if c else None
            entries = []
            for fe in files:
                e = {k: fe[k] for k in ("filename", "additions", "deletions", "status") if k in fe}
                if pt is not None and fe["filename"] in pt:
                    e["patch"] = pt[fe["filename"]]
                entries.append(e)
            payload[key] = entries
            groups = ly.case_groups(case_dir)
            posted_real = any(DELTA in ls and real for ls, real in ly.match_comments(groups, comments))
            posted_any = any(DELTA in g["raisers"] and g["posted"] for g in groups)
            raised = any(DELTA in g["raisers"] for g in groups)
            meta[key] = {"no_patch": pt is None, "posted_real": posted_real, "posted": posted_any, "raised": raised}
    dist = ROOT / "dist" / "src" / "heuristics.js"
    r = subprocess.run(["node", "--input-type=commonjs", "-e", f"(async()=>{{{NODE}}})()", str(dist)],
                       input=json.dumps(payload), capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(r.stderr)
    res = json.loads(r.stdout)
    tot = {"cases": 0, "planned_old": 0, "planned_new": 0, "rows_old": 0, "rows_new": 0, "no_patch": 0,
           "posted_real": 0, "posted_real_kept": 0, "posted": 0, "posted_kept": 0, "raised": 0, "raised_kept": 0}
    lost = []
    for k, v in res.items():
        m = meta[k]
        tot["cases"] += 1
        tot["planned_old"] += v["old"] > 0
        tot["planned_new"] += v["new"] > 0
        tot["rows_old"] += v["old"]
        tot["rows_new"] += v["new"]
        tot["no_patch"] += m["no_patch"]
        for f in ("posted_real", "posted", "raised"):
            if m[f]:
                tot[f] += 1
                if v["new"] > 0:
                    tot[f + "_kept"] += 1
                elif f == "posted_real":
                    lost.append(k)
    print(json.dumps(tot, indent=1))
    if lost:
        print("posted-real cases the new trigger would NOT plan:", *lost, sep="\n  ")


if __name__ == "__main__":
    main()
