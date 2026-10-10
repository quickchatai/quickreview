#!/usr/bin/env python3
"""Shard one AACR-Bench eval across several harness processes, and merge them.

The harness (`pipeline run --stage eval`) judges instances ONE AT A TIME, each
reference against each generated comment by a sequential model call — about
47 s per PR per round per variant with the codex judge, so a 3-round,
3-variant eval of the 196-PR `full` set is ~21 hours in one process. Its
numbers are MICRO sums: every metric is computed from counts summed over
instances (evaluate._compute_summary), and the multi-round file is the mean of
the round summaries (pipeline._average_summaries). So an eval split by
instance and merged by summing the same counts, then run through the SAME two
harness functions, gives exactly the numbers one process would have given
(the judge's own run-to-run noise aside, which is the same either way).

    eval_shards.py split --dataset subset.jsonl --results DIR --shards N --into WORK
        WORK/<k>/dataset.jsonl + a copy of each shard instance's result file
        (a missing one stays missing, as the harness would see it). Balanced by
        reference count, the judge's work unit.
    eval_shards.py merge --dataset subset.jsonl --out DIR --rounds R --line-k K WORK/0 WORK/1 ...
        DIR/metrics_ocr_<ts>[_round_<r>].json per round (eval_res in dataset
        order) and, for R > 1, metrics_ocr_average.json — the files one
        harness process writes, which report.ts, compare.py and
        in-container.sh's completeness check read unchanged.

Runs with the harness's venv python; --harness points at its evaluation/ dir
(default /opt/aacr-bench/evaluation), whose modules it imports.
"""
import argparse
import glob
import json
import os
import shutil
import sys
from datetime import datetime

COUNT_KEYS = (
    "total_instances",
    "candidate_instances",
    "evaluated_instances",
    "missing_instances",
    "expected_notes",
    "generated_notes",
    "matched_line_notes",
    "matched_semantic_notes",
    "total_duration_seconds",
    "total_input_tokens",
    "total_output_tokens",
)


def instances(dataset):
    out = []
    for line in open(dataset, encoding="utf-8"):
        if line.strip():
            out.append((json.loads(line), line if line.endswith("\n") else line + "\n"))
    return out


def safe_id(iid):
    # evaluation/config.py safe_id, and src/bench/aacr.ts safeId.
    return iid.replace("/", "__")


def split(a):
    rows = instances(a.dataset)
    n = max(1, min(a.shards, len(rows)))
    load = [0] * n
    parts = [[] for _ in range(n)]
    # Heaviest first onto the lightest shard; ties keep dataset order.
    order = sorted(range(len(rows)), key=lambda i: (-len(rows[i][0].get("reference_comments") or []), i))
    for i in order:
        k = min(range(n), key=lambda j: (load[j], j))
        parts[k].append(i)
        load[k] += max(1, len(rows[i][0].get("reference_comments") or []))
    for k, idx in enumerate(parts):
        d = os.path.join(a.into, str(k))
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "dataset.jsonl"), "w", encoding="utf-8") as f:
            for i in sorted(idx):
                f.write(rows[i][1])
        for i in idx:
            name = safe_id(rows[i][0]["instance_id"]) + ".json"
            src = os.path.join(a.results, name)
            if os.path.isfile(src) and not os.path.islink(src):
                shutil.copyfile(src, os.path.join(d, name))
    print(n)


def round_file(shard, rounds, r, reviewer="ocr"):
    files = [f for f in glob.glob(os.path.join(shard, f"metrics_{reviewer}_*.json")) if "average" not in f]
    if rounds > 1:
        files = [f for f in files if f.endswith(f"_round_{r}.json")]
    if len(files) != 1:
        sys.exit(f"eval_shards: {shard} has {len(files)} metrics file(s) for round {r}, expected 1")
    return json.load(open(files[0], encoding="utf-8"))


def merge(a):
    sys.path.insert(0, a.harness)
    os.chdir(a.harness)
    import evaluate  # noqa: E402 — the harness's own summary arithmetic
    import pipeline  # noqa: E402 — and its own multi-round average

    order = {row["instance_id"]: i for i, (row, _) in enumerate(instances(a.dataset))}
    summaries = []
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    for r in range(1, a.rounds + 1):
        parts = [round_file(s, a.rounds, r, a.reviewer) for s in a.shards]
        stats = {k: sum(p["summary"].get(k, 0) for p in parts) for k in COUNT_KEYS}
        summary = evaluate._compute_summary(stats)
        eval_res = sorted((e for p in parts for e in p.get("eval_res") or []),
                          key=lambda e: order.get(e.get("instance_id"), len(order)))
        missing = sorted((m for p in parts for m in (p.get("ex_info") or {}).get("missing_instance_ids") or []),
                         key=lambda m: order.get(m, len(order)))
        data = {
            "ex_info": {
                "start_time": min(str((p.get("ex_info") or {}).get("start_time", "")) for p in parts),
                "results_dir": a.out,
                "reviewer": a.reviewer,
                "line_k": a.line_k,
                "limit": None,
                "missing_instance_ids": missing,
                "shards": len(parts),
            },
            "summary": summary,
            "eval_res": eval_res,
        }
        label = f"_round_{r}" if a.rounds > 1 else ""
        with open(os.path.join(a.out, f"metrics_{a.reviewer}_{ts}{label}.json"), "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        summaries.append(summary)
    if a.rounds > 1:
        avg = {"summary": pipeline._average_summaries(summaries), "eval_rounds": a.rounds}
        with open(os.path.join(a.out, f"metrics_{a.reviewer}_average.json"), "w", encoding="utf-8") as f:
            json.dump(avg, f, ensure_ascii=False, indent=2)
    s = summaries[-1]
    print(f"merged {len(a.shards)} shard(s) × {a.rounds} round(s): "
          f"{s['evaluated_instances']} instance(s), semantic F1 {s['semantic_f1']} (last round)")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("split")
    s.add_argument("--dataset", required=True)
    s.add_argument("--results", required=True)
    s.add_argument("--shards", type=int, required=True)
    s.add_argument("--into", required=True)
    m = sub.add_parser("merge")
    m.add_argument("--dataset", required=True)
    m.add_argument("--out", required=True)
    m.add_argument("--rounds", type=int, required=True)
    m.add_argument("--line-k", type=int, default=1)
    m.add_argument("--harness", default="/opt/aacr-bench/evaluation")
    # The harness reader the shards ran with — it names the metrics files. Every
    # arm is scored with ocr (the Claude Code arm on its `review` view);
    # claude is accepted for re-merging shards of an older Claude Code eval.
    m.add_argument("--reviewer", default="ocr", choices=["ocr", "claude"])
    m.add_argument("shards", nargs="+")
    a = ap.parse_args()
    if a.cmd == "split":
        split(a)
    else:
        a.out = os.path.abspath(a.out)
        a.shards = [os.path.abspath(x) for x in a.shards]
        a.dataset = os.path.abspath(a.dataset)
        merge(a)


if __name__ == "__main__":
    main()
