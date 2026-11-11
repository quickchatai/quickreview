#!/usr/bin/env python3
"""What judging the AACR reviews cost and how it ran, from the judges' numbers-only extracts.

    python3 bench/aacr/recompute/judge_ops.py --archive <release>/archive --data <hf-dataset> \\
        [--work <scratch>] [--json OUT]

(`uv run --no-project --with pyarrow python ...` for the parquet tables.)

The defect judge writes, per run and PR, `runs/<run>/judge/v<key version>-<judge>/<id>.r1.json` (the
judgement; an `error` field marks a failed one) and `<id>.r1.events.pruned.jsonl` (the numbers-only
extract of its session: every assistant message's usage, no prompt or model text). For the earlier
gpt-6-sol study's seven reviewers (the HF `arms` table: each arm's runs, in order), and for each judge
(the primary `gpt-6-sol-high` and the second, `claude-opus-5-5`), a PR's judgement is the first run's
usable one (compare.py's rule). Over those judgements this counts:
  - judgements, the reviews that needed no model call (no extract: a review with neither defects nor
    comments) and the judgements left in error;
  - model calls (assistant messages) and their tokens (uncached input, cached input, cache writes,
    output), priced at the papers' list rates (gpt-6-sol: $2 / $0.2 cached / $10 per million tokens;
    Opus 5.5: $4 in, $20 out, $0.2 cache read, $5 cache write) and against pi's own recorded cost;
  - the same for the primary judge's self-consistency re-run (`runs/<run>/judge/wpself-gpt-6-sol-high/`);
  - the AACR-metric judge's calls recorded in the surviving shim logs (`eval/judge-shim*.log`, a line
    per call starting `judge:`) of the runs that supplied the seven reviewers' AACR table, and the
    papers' estimate of that judge's cost (the shim records no usage): every reference paired with every
    review comment that passes the harness's path and line gate (k = 1) is an upper bound on calls per
    round; a call's prompt is the harness's fixed judge text (775 characters, measured from
    evaluation/judge.py) plus the reference and the comment, at 3.6 characters a token, with 40 output
    tokens, priced at gpt-6-sol's $2 / $10 per million (the analysis tree's wp-data/cost.py and
    linek_plan.py). A PR's AACR row comes from the first of the arm's runs whose official metrics files
    score it.
No model call.
"""
from __future__ import annotations

import argparse
import collections
import glob
import json
import os
import sys
from pathlib import Path
from typing import Dict, List

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from archive import iter_jsonl, open_archive, read_json  # noqa: E402
from tables import load_table  # noqa: E402

STUDY = ("quickreview-default-sol", "quickreview-low-sol", "ocr-medium-sol", "codex-medium-sol",
         "opencode-bridge-sol", "pireview-medium-sol", "claude-code-opus55")
JUDGES = ("gpt-6-sol-high", "claude-opus-5-5")
RATES = {"gpt-6-sol-high": {"input": 2, "cacheRead": 0.2, "cacheWrite": 0, "output": 10},
         "claude-opus-5-5": {"input": 4, "cacheRead": 0.2, "cacheWrite": 5, "output": 20}}
SELF = "wpself-gpt-6-sol-high"


def usage(events: Path):
    u = collections.Counter()
    calls = 0
    pi_cost = 0.0
    for e in iter_jsonl(events):
        if e.get("type") == "message_end" and (e.get("message") or {}).get("role") == "assistant":
            us = e["message"].get("usage") or {}
            calls += 1
            for k in ("input", "output", "cacheRead", "cacheWrite"):
                u[k] += us.get(k) or 0
            pi_cost += (us.get("cost") or {}).get("total") or 0
    return u, calls, pi_cost


def judgement(root: Path, run: str, iid: str, ver, judge: str):
    f = root / "runs" / run / "judge" / f"v{ver}-{judge}" / f"{iid}.r1.json"
    if not f.exists():
        return None, f
    j = read_json(f)
    return (None if j.get("error") else j), f


def judge_cost(root: Path, arms: Dict[str, List[str]], prs: Dict[str, dict], judge: str) -> dict:
    tot = collections.Counter()
    calls = judged = no_call = errors = 0
    pi_cost = 0.0
    for arm in STUDY:
        for iid, p in prs.items():
            for run in arms[arm]:
                j, f = judgement(root, run, iid, p["key_version"], judge)
                if j is None:
                    errors += f.exists()
                    continue
                judged += 1
                ev = f.with_name(f"{iid}.r1.events.pruned.jsonl")
                if not ev.exists():
                    no_call += 1
                    break
                u, c, pc = usage(ev)
                tot.update(u)
                calls += c
                pi_cost += pc
                break
    r = RATES[judge]
    usd = sum(tot[k] * r[k] for k in r) / 1e6
    return {"judgements": judged, "with_calls": judged - no_call, "no_call": no_call, "error_files_skipped": errors,
            "calls": calls, "calls_per_judgement": calls / max(judged - no_call, 1),
            "tokens": dict(tot), "uncached_input": tot["input"] + tot["cacheWrite"], "cached_input": tot["cacheRead"],
            "output": tot["output"], "usd_list": usd, "usd_pi": pi_cost, "usd_per_review": usd / max(judged - no_call, 1)}


def errors_left(root: Path, arms: Dict[str, List[str]], prs: Dict[str, dict], judge: str) -> int:
    """PRs of the seven reviewers with no usable judgement: every run's file absent or in error."""
    n = 0
    for arm in STUDY:
        for iid, p in prs.items():
            if all(judgement(root, run, iid, p["key_version"], judge)[0] is None for run in arms[arm]):
                n += 1
    return n


def self_rerun(root: Path) -> dict:
    tot = collections.Counter()
    calls = files = 0
    pi_cost = 0.0
    for ev in sorted(glob.glob(str(root / "runs" / "*" / "judge" / SELF / "*.r1.events.pruned.jsonl"))):
        u, c, pc = usage(Path(ev))
        tot.update(u)
        calls += c
        pi_cost += pc
        files += 1
    r = RATES["gpt-6-sol-high"]
    return {"judgements": files, "calls": calls, "usd_list": sum(tot[k] * r[k] for k in r) / 1e6, "usd_pi": pi_cost}


def shim_calls(root: Path, arms: Dict[str, List[str]]) -> dict:
    by = {}
    for arm in STUDY:
        n = 0
        for run in arms[arm]:
            for f in glob.glob(str(root / "runs" / run / "eval" / "judge-shim*.log")):
                with open(f, errors="replace") as fh:
                    n += sum(1 for line in fh if line.startswith("judge:"))
        by[arm] = n
    return {"calls": sum(by.values()), "by_arm": by}


TEMPLATE_CHARS = 775   # evaluation/judge.py's fixed prompt text around the two notes (measured)
CHARS_PER_TOKEN = 3.6  # English prose with code
OUT_TOKENS = 40        # "yes"/"no" plus low-effort reasoning
ROUNDS = 3


def _span(a, b):
    a = a if a is not None else b
    b = b if b is not None else a
    if a is not None and b is not None and a > b:
        a, b = b, a
    return a, b


def _near(f1, t1, f2, t2, k):
    if not (f1 > t2 or f2 < t1):
        return True
    return min(abs(f1 - t2), abs(f2 - t1)) <= k


def aacr_estimate(root: Path, arms: Dict[str, List[str]], prs: Dict[str, dict]) -> dict:
    refs = {}
    for f in sorted(glob.glob(str(root / "runs" / "*" / "eval" / "aacr_bench_v1_*.jsonl"))):
        if Path(f).parent.parent.name.startswith(("v2-default", "stab-r")):
            continue
        for d in iter_jsonl(Path(f)):
            refs.setdefault(d["instance_id"], d["reference_comments"])
    chars = []
    for arm in STUDY:
        seen = set()
        for run in arms[arm]:
            got = set()
            for f in sorted(glob.glob(str(root / "runs" / run / "results" / "all" / "metrics_*_*.json"))):
                if "average" in f:
                    continue
                for inst in read_json(Path(f)).get("eval_res") or []:
                    if inst["instance_id"] in prs and inst["instance_id"] not in seen:
                        got.add(inst["instance_id"])
            seen |= got
            for iid in sorted(got):
                f = root / "runs" / run / "results" / "all" / f"{iid}.json"
                rev = (read_json(f).get("review") if f.exists() else None) or {}
                gens = []
                for c in (rev.get("comments") if isinstance(rev, dict) else None) or []:
                    note = (c.get("content") or "").strip()
                    if note:
                        gens.append(((c.get("path") or "").replace("\\", "/"), *_span(c.get("start_line"), c.get("end_line")), note))
                for ref in refs.get(iid, []):
                    if not ref.get("text"):
                        continue
                    rp = (ref.get("path") or "").replace("\\", "/")
                    a, b = _span(ref.get("start_line"), ref.get("end_line"))
                    for gp, f1, t1, note in gens:
                        if rp and gp and rp != gp:
                            continue
                        if None not in (a, b, f1, t1) and not _near(a, b, f1, t1, 1):
                            continue
                        chars.append(TEMPLATE_CHARS + len(ref["text"]) + len(note))
    mean_chars = sum(chars) / len(chars)
    in_tok = mean_chars / CHARS_PER_TOKEN
    per_call = (in_tok * RATES["gpt-6-sol-high"]["input"] + OUT_TOKENS * RATES["gpt-6-sol-high"]["output"]) / 1e6
    return {"pairs_per_round": len(chars), "upper_bound_calls": ROUNDS * len(chars), "mean_prompt_chars": mean_chars,
            "input_tokens_per_call": in_tok, "usd_per_call": per_call, "usd_upper_bound": ROUNDS * len(chars) * per_call}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--archive", required=True)
    ap.add_argument("--data", required=True)
    ap.add_argument("--work", default=os.path.join(os.environ.get("TMPDIR", "."), "judge-ops"))
    ap.add_argument("--json")
    a = ap.parse_args()
    arms = {x["arm_id"]: list(x["runs"]) for x in load_table(a.data, "arms") if x["arm_id"] in STUDY}
    prs = {p["instance_id"]: p for p in load_table(a.data, "prs")}
    runs = {r["unit"]: r for r in load_table(a.data, "runs")}
    vols = set()
    for rs in arms.values():
        for run in rs:
            vols.update(v.removeprefix("quickreview-runs-").removesuffix(".tar.zst")
                        for v in (runs.get(run) or {}).get("archive_volumes") or [])
    root = open_archive(a.archive, a.work, sorted(vols))
    res = {j: judge_cost(root, arms, prs, j) for j in JUDGES}
    for j in JUDGES:
        res[j]["errors_left"] = errors_left(root, arms, prs, j)
    res["self_rerun"] = self_rerun(root)
    res["aacr_shim"] = shim_calls(root, arms)
    res["aacr_estimate"] = aacr_estimate(root, arms, prs)
    res["aacr_estimate"]["usd_logged_calls"] = res["aacr_shim"]["calls"] * res["aacr_estimate"]["usd_per_call"]
    print(json.dumps(res, indent=1))
    if a.json:
        Path(a.json).write_text(json.dumps(res, indent=1) + "\n")


if __name__ == "__main__":
    main()
