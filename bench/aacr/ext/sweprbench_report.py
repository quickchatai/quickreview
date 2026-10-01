#!/usr/bin/env python3
"""SWE-PRBench, Table-8-shaped, from the harness's OWN eval_report.json.

    python3 bench/aacr/ext/sweprbench_report.py WORK_DIR

Reads what run_eval.py wrote (runs/<agent>__judge_<judge>/eval_report.json —
its aggregate.py: per-config means and the difficulty-weighted
`overall_score_weighted`), never re-scores. Table 8 of the paper reports, per
model: s_A, s_B, s_C (the difficulty-weighted composite per context config),
s̄ (their mean across configs), DR_A (detection rate on config A) and FPR_avg
(the false-positive — FABRICATED — rate averaged over configs). Also prints
the replay's hit/miss count (a miss would mean a context QuickReview had no
answer for — the run is then invalid) and the judge's token use.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

# Paper Table 8 (eval_100, judge GPT-5.2, pipeline v0.4.1): sA sB sC s̄ DR_A FPR_avg
PUBLISHED = [
    ("Claude Haiku 4.5", 0.172, 0.129, 0.126, 0.153, 0.306, 0.346),
    ("Claude Sonnet 4.6", 0.190, 0.135, 0.122, 0.152, 0.297, 0.227),
    ("DeepSeek V3", 0.181, 0.132, 0.118, 0.150, 0.312, 0.315),
    ("Mistral Large 3", 0.170, 0.125, 0.135, 0.147, 0.305, 0.353),
    ("GPT-4o", 0.134, 0.110, 0.090, 0.113, 0.220, 0.193),
    ("GPT-4o-mini", 0.110, 0.095, 0.093, 0.108, 0.210, 0.353),
    ("Mistral Small", 0.131, 0.080, 0.091, 0.106, 0.257, 0.251),
    ("Llama 3.3 70B", 0.088, 0.071, 0.065, 0.079, 0.223, 0.417),
]
PRICE = {"in": 2.0, "cached": 0.10, "out": 10.0}  # gpt-6.1-sol list $/M (FULL-BENCHMARK.md)


def judge_cost(log: Path) -> dict:
    t = {"requests": 0, "errors": 0, "input": 0, "cached": 0, "output": 0, "reasoning": 0, "ms": []}
    if log.exists():
        for line in log.read_text().splitlines():
            r = json.loads(line)
            if "route" not in r:
                continue
            t["requests"] += 1
            if r.get("status") != 200:
                t["errors"] += 1
                continue
            u = r.get("usage") or {}
            cached = int((u.get("input_tokens_details") or {}).get("cached_tokens") or 0)
            t["input"] += int(u.get("input_tokens") or 0) - cached
            t["cached"] += cached
            t["output"] += int(u.get("output_tokens") or 0)
            t["reasoning"] += int((u.get("output_tokens_details") or {}).get("reasoning_tokens") or 0)
            t["ms"].append(int(r.get("ms") or 0))
    ms = sorted(t.pop("ms"))
    t["median_ms"] = ms[len(ms) // 2] if ms else None
    t["usd"] = round((t["input"] * PRICE["in"] + t["cached"] * PRICE["cached"] + t["output"] * PRICE["out"]) / 1e6, 4)
    return t


def main() -> None:
    work = Path(sys.argv[1])
    reports = sorted(work.glob("runs/*/eval_report.json"))
    if len(reports) != 1:
        sys.exit(f"expected one eval_report.json under {work}/runs, found {len(reports)}")
    rep = json.loads(reports[0].read_text())
    by = rep["by_config"]
    s = {k: by.get(f"config_{k}", {}).get("overall_score_weighted") for k in "ABC"}
    sbar = sum(v for v in s.values() if v is not None) / max(1, sum(v is not None for v in s.values()))
    fpr = [by[c]["false_positive_rate"] for c in by]
    row = {
        "run_dir": str(reports[0].parent.name),
        "prs": rep["total_prs"], "records": rep["total_eval_records"],
        "sA": s["A"], "sB": s["B"], "sC": s["C"], "s_bar": round(sbar, 3),
        "DR_A": by.get("config_A", {}).get("detection_rate"),
        "FPR_avg": round(sum(fpr) / len(fpr), 3) if fpr else None,
        "by_config": {c: {k: by[c][k] for k in ("n", "detection_rate", "precision", "recall", "f1_score",
                                                "false_positive_rate", "overall_score", "overall_score_weighted",
                                                "no_attempt_count")} for c in sorted(by)},
        "agent_parse_failures": rep["agent_parse_failures"],
        "judge_parse_fallbacks": rep["judge_parse_fallback_count"],
    }
    hits = misses = 0
    for line in (work / "replay.jsonl").read_text().splitlines() if (work / "replay.jsonl").exists() else []:
        r = json.loads(line)
        if r.get("event") == "start":
            continue
        hits += bool(r.get("hit"))
        misses += not r.get("hit")
    row["replay"] = {"hits": hits, "misses": misses}
    row["judge"] = judge_cost(work / "judge" / "judge.jsonl")
    (work / "sweprbench-table8.json").write_text(json.dumps(row, indent=1) + "\n")
    f = lambda v: "—" if v is None else f"{v:.3f}"  # noqa: E731
    print(f"SWE-PRBench, {row['prs']} PRs × 3 configs = {row['records']} records "
          f"(replay {hits} hits / {misses} misses; agent parse failures {row['agent_parse_failures']}, "
          f"judge fallbacks {row['judge_parse_fallbacks']})\n")
    print("| Model | s_A | s_B | s_C | s̄ | DR_A | FPR_avg | PRs |\n|---|---|---|---|---|---|---|---|")
    print(f"| **QuickReview default (gpt-6.1-sol), judge gpt-6.1-sol** | {f(row['sA'])} | {f(row['sB'])} | {f(row['sC'])} "
          f"| {f(row['s_bar'])} | {f(row['DR_A'])} | {f(row['FPR_avg'])} | {row['prs']} (smoke) |")
    for name, *v in PUBLISHED:
        print(f"| {name} — published, judge GPT-5.2 | " + " | ".join(f"{x:.3f}" for x in v) + " | 100 (eval_100) |")
    print(f"\njudge: {row['judge']}")


if __name__ == "__main__":
    main()
