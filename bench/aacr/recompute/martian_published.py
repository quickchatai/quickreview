#!/usr/bin/env python3
"""Martian's published Opus 4.5 judgements of the leaderboard's tools, recounted against the golden audit.

    python3 bench/aacr/recompute/martian_published.py --martian <code-review-benchmark checkout> \\
        --data <hf-dataset> [--json OUT]

(`uv run --no-project --with pyarrow python ...` for the parquet tables.)

benchmark.tex tab:martianaudit (right block) and the paragraphs around it. Martian publishes, in its own
repository (withmartian/code-review-benchmark, read at e616e84; third-party and never in the release),
`offline/results/anthropic_claude-opus-4-5-20251101/evaluations.json`: per PR and tool, the golden
comments its judge credited (`true_positives[].golden_comment`, the golden's text), and
`offline/results/benchmark_data.json`, each PR's golden comments in order. A credited golden is placed
by its text in its PR's list (a credit whose text names no listed golden is left out and counted, as
hf_export.py does); the release's golden audit (the HF `martian_goldens` table:
`audit_bucket`, `severity`) says whether it is real. Per tool:
  real_recall     real goldens credited / every real golden (86), percent;
  notreal_share   credited goldens the audit judged not real / credited goldens, percent;
  all_blocking_real  PRs where every real Critical or High golden was credited (of the 19 that have one).
No model call.
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tables import load_table  # noqa: E402

JUDGE = "anthropic_claude-opus-4-5-20251101"


def compute(martian: Path, goldens: list) -> dict:
    res = martian / "offline" / "results"
    evals = json.loads((res / JUDGE / "evaluations.json").read_text())
    bd = json.loads((res / "benchmark_data.json").read_text())
    audit = {(g["pr_url"], g["golden_index"]): g for g in goldens}
    real = {k for k, g in audit.items() if g["audit_bucket"] == "real"}
    blocking_real = collections.defaultdict(set)
    for k in real:
        if (audit[k]["severity"] or "").lower() in ("critical", "high"):
            blocking_real[k[0]].add(k)
    credited = collections.defaultdict(set)
    unknown = collections.Counter()
    for pr, tools in evals.items():
        index = {g["comment"]: i for i, g in enumerate(bd[pr]["golden_comments"])}
        for tool, e in tools.items():
            for tp in (e or {}).get("true_positives") or []:
                i = index.get(tp.get("golden_comment"))
                if i is None:  # a credit naming no listed golden: left out, as hf_export.py does
                    unknown[tool] += 1
                    continue
                credited[tool].add((pr, i))
    out = {"real": len(real), "blocking_real_prs": len(blocking_real), "unknown_credits": dict(unknown), "tools": {}}
    for tool, hit in credited.items():
        notreal = sum(1 for k in hit if audit.get(k, {}).get("audit_bucket") == "notreal")
        out["tools"][tool] = {"credited": len(hit), "real_found": len(hit & real), "real_recall": 100 * len(hit & real) / len(real),
                              "notreal_share": 100 * notreal / len(hit) if hit else None,
                              "all_blocking_real": sum(1 for ks in blocking_real.values() if ks <= hit)}
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--martian", required=True, help="withmartian/code-review-benchmark checkout (third-party)")
    ap.add_argument("--data", required=True)
    ap.add_argument("--json")
    a = ap.parse_args()
    res = compute(Path(a.martian), load_table(a.data, "martian_goldens"))
    print(json.dumps(res, indent=1))
    if a.json:
        Path(a.json).write_text(json.dumps(res, indent=1) + "\n")


if __name__ == "__main__":
    main()
