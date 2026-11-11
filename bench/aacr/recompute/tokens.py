#!/usr/bin/env python3
"""Tokens per PR of the AACR arms, from the run archive's numbers-only extracts and case summaries.

    python3 bench/aacr/recompute/tokens.py --archive <release>/archive --data <hf-dataset> \\
        [--arms a,b,...] [--work <scratch>] [--json OUT]

(`uv run --no-project --with pyarrow python ...` for the parquet tables.)

For every judged review of an arm (the HF `reviews` table: arm, PR, the run the scores use), the
case dir `runs/<run>/cases/<id>/` in the archive gives its tokens, by the rule of the analysis tree's
paper-data/final_tables.py (the papers' tab:costfinal and THREATS-TO-VALIDITY.md §5):
  - a pi session (QuickReview, pi-review): every assistant `message_end` usage of
    `pi-events.pruned.jsonl` plus every subagent result's usage (the lens passes and the validator);
    uncached input = input + cacheWrite, cached = cacheRead;
  - Claude Code: its case summary's `tokens`: input + cache_creation / cache_read / output;
  - a bridged tool (open-code-review, OpenCode, Codex CLI, PR-Agent): the bridge's counts:
    input_tokens - cached / cached / output;
  - otherwise the summary's `usage` (input / cacheRead / output).
The extracts are the published numbers-only form of the session logs: they keep every usage record
and drop all prompt and model text.

Per arm and PR selection (`all`, `s40` for the selection set, `rest145`): the mean uncached input, cached
input and output per PR, the cache share (cached / all input), and, for a pi session, the subagent passes
per PR and the median output tokens of one pass. The runs' archive volumes are found through the HF `runs` table.
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
from pathlib import Path
from typing import Dict, List, Optional, Sequence

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from archive import iter_jsonl, open_archive, read_json  # noqa: E402
from tables import load_table  # noqa: E402

DEFAULT_ARMS = (
    # the final comparison and the frozen build
    "quickreview-frozen", "quickreview-default-g61", "quickreview-low-g61", "pireview-panel-high-g61",
    "claude-code-opus55", "ocr-high-g61", "codex-high-g61", "opencode-native-pr-g61", "pragent-g61",
    # the earlier gpt-6-sol study
    "quickreview-default-sol", "quickreview-low-sol", "ocr-medium-sol", "codex-medium-sol",
    "opencode-bridge-sol", "pireview-medium-sol",
    # the base-model and best-shot arms
    "quickreview-luna", "quickreview-default-sol-rerun", "pireview-panel-sol-s40",
)


def case_tokens(cd: Path) -> Dict[str, object]:
    """(uncached input, cached input, output) of one case, and its subagent passes' output tokens."""
    s = read_json(cd / "case-summary.json")
    ev = cd / "pi-events.pruned.jsonl"
    i = c = o = 0
    passes: List[int] = []
    if ev.exists():
        for e in iter_jsonl(ev):
            if e.get("type") == "message_end" and (e.get("message") or {}).get("role") == "assistant":
                u = e["message"].get("usage") or {}
                i += (u.get("input") or 0) + (u.get("cacheWrite") or 0)
                c += u.get("cacheRead") or 0
                o += u.get("output") or 0
            elif e.get("type") == "tool_execution_end" and e.get("toolName") == "subagent":
                for r in ((e.get("result") or {}).get("details") or {}).get("results") or []:
                    u = r.get("usage") or {}
                    i += (u.get("input") or 0) + (u.get("cacheWrite") or 0)
                    c += u.get("cacheRead") or 0
                    o += u.get("output") or 0
                    passes.append(u.get("output") or 0)
    elif s.get("arm") == "claude":
        t = s["tokens"]
        i, c, o = t["input"] + t["cache_creation"], t["cache_read"], t["output"]
    elif s.get("bridge"):
        b = s["bridge"]
        c = min(b.get("cached_tokens") or 0, b["input_tokens"])
        i, o = b["input_tokens"] - c, b["output_tokens"]
    elif s.get("usage"):
        u = s["usage"]
        i, c, o = u["input"], u["cacheRead"], u["output"]
    else:
        raise SystemExit(f"{cd}: no token record (no extract, no claude tokens, no bridge, no usage)")
    return {"uncached": i, "cached": c, "output": o, "passes": passes}


def summarise(rows: List[dict]) -> Optional[dict]:
    if not rows:
        return None
    k = len(rows)
    inp = sum(r["uncached"] for r in rows)
    cached = sum(r["cached"] for r in rows)
    out = sum(r["output"] for r in rows)
    passes = [p for r in rows for p in r["passes"]]
    return {"prs": k, "uncached_in_per_pr": inp / k, "cached_in_per_pr": cached / k,
            "input_per_pr": (inp + cached) / k, "cache_share": 100 * cached / (inp + cached) if inp + cached else 0.0,
            "output_per_pr": out / k, "passes": len(passes), "passes_per_pr": len(passes) / k,
            "pass_output_median": statistics.median(passes) if passes else None}


def tokens(root: Path, reviews: List[dict], prs: List[dict], arms: Sequence[str]) -> dict:
    s40 = {p["instance_id"] for p in prs if p["in_s40"]}
    rest145 = {p["instance_id"] for p in prs if p["set"] == "rest145"}
    out = {}
    for arm in arms:
        rows = [r for r in reviews if r["arm_id"] == arm and r["judged"]]
        if not rows:
            raise SystemExit(f"no judged reviews of arm {arm!r} in the reviews table")
        per = {r["instance_id"]: case_tokens(root / "runs" / r["run"] / "cases" / r["instance_id"]) for r in rows}
        out[arm] = {"all": summarise(list(per.values())),
                    "s40": summarise([v for i, v in per.items() if i in s40]),
                    "rest145": summarise([v for i, v in per.items() if i in rest145])}
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--archive", required=True)
    ap.add_argument("--data", required=True)
    ap.add_argument("--arms", default=",".join(DEFAULT_ARMS))
    ap.add_argument("--work", default=os.path.join(os.environ.get("TMPDIR", "."), "tokens"))
    ap.add_argument("--json")
    a = ap.parse_args()
    arms = [x for x in a.arms.split(",") if x]
    reviews = load_table(a.data, "reviews")
    runs = {r["unit"]: r for r in load_table(a.data, "runs")}
    need = sorted({r["run"] for r in reviews if r["arm_id"] in arms and r["judged"]})
    vols = set()
    for run in need:
        if run not in runs:
            raise SystemExit(f"run {run!r} is not in the runs table")
        vols.update(v.removeprefix("quickreview-runs-").removesuffix(".tar.zst") for v in runs[run]["archive_volumes"] or [])
    root = open_archive(a.archive, a.work, sorted(vols))
    res = tokens(root, reviews, load_table(a.data, "prs"), arms)
    for arm, v in res.items():
        x = v["all"]
        print(f"{arm}: {x['prs']} PRs, uncached {x['uncached_in_per_pr']:,.0f}, cached {x['cached_in_per_pr']:,.0f} "
              f"({x['cache_share']:.0f}%), output {x['output_per_pr']:,.0f}"
              + (f", median pass output {x['pass_output_median']:,.0f}" if x["pass_output_median"] is not None else ""))
    if a.json:
        Path(a.json).write_text(json.dumps(res, indent=1) + "\n")


if __name__ == "__main__":
    main()
