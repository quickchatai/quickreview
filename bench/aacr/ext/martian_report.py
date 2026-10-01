#!/usr/bin/env python3
"""Martian scores, by Martian's own scorer, for a run and its published comparators.

Runs INSIDE the Martian image (ext.sh martian), next to the unmodified
pipeline, and imports its scorer — `analysis/score_profiles.py` `score_tools`,
the function behind its leaderboard's Strict/Core/All profiles and F-beta —
rather than reimplementing it. Two inputs, scored the same way:

  * this run's evaluations (results/<judge>/evaluations.json): QuickReview and
    the re-judged published tools, all judged by the same gpt-6.1-sol;
  * Martian's COMMITTED evaluations of the same tools under each published
    judge (results/<judge>/evaluations.json in the pinned checkout), filtered
    to exactly this run's PRs — the published numbers on the same PRs.

Writes martian-scores.json and prints a markdown table.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from analysis.score_profiles import PROFILE_CATEGORIES, _load_golden_categories, score_tools

PUBLISHED = Path("/opt/martian/offline/results")
JUDGES = ["anthropic_claude-opus-4-5-20251101", "anthropic_claude-sonnet-4-5-20250929", "openai_gpt-5.2"]


def scores(evals: dict, cats: dict) -> dict:
    out: dict = {}
    for profile in PROFILE_CATEGORIES:
        for tool, m in score_tools(evals, cats, profile, 2.0).items():
            out.setdefault(tool, {})[profile] = {
                "precision": m["precision"], "recall": m["recall"], "f1": m["f1"], "f2": m["fbeta"],
                "tp": m["tp"], "fp": m["fp"], "fn": m["fn"], "prs": m["prs"],
            }
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", default="results")
    ap.add_argument("--model-dir", required=True)
    ap.add_argument("--tools", required=True, help="published tools that were re-judged")
    ap.add_argument("--out", default="martian-scores.json")
    a = ap.parse_args()
    results = Path(a.results)
    ours = json.loads((results / a.model_dir / "evaluations.json").read_text())
    prs = sorted(ours)
    cats = _load_golden_categories(PUBLISHED)
    report = {"prs": prs, "this_run": {"judge": a.model_dir, "scores": scores(ours, cats)}, "published": {}}
    tools = a.tools.split(",")
    for judge in JUDGES:
        pub = json.loads((PUBLISHED / judge / "evaluations.json").read_text())
        subset = {u: {t: v for t, v in pub[u].items() if t in tools} for u in prs if u in pub}
        report["published"][judge] = {"prs": len(subset), "scores": scores(subset, cats)}
    Path(a.out).write_text(json.dumps(report, indent=1) + "\n")

    def row(label: str, s: dict) -> str:
        cells = []
        for p in ("core", "strict", "all"):
            m = s.get(p)
            cells += ["—"] * 4 if m is None else [f"{100 * m[k]:.1f}" for k in ("precision", "recall", "f1", "f2")]
        tp = s.get("core", {})
        return f"| {label} | " + " | ".join(cells) + f" | {tp.get('tp', 0)}/{tp.get('tp', 0) + tp.get('fn', 0)} | {tp.get('fp', 0)} |"

    head = ("| Tool (judge) | Core P | Core R | Core F1 | Core F2 | Strict P | Strict R | Strict F1 | Strict F2 "
            "| All P | All R | All F1 | All F2 | Core TP/golden | FP |\n|" + "---|" * 15)
    print(f"Martian, {len(prs)} PRs — profiles Core (default) / Strict / All, F1 and F2 (score_profiles.py)\n")
    print(head)
    for tool, s in sorted(report["this_run"]["scores"].items()):
        print(row(f"{tool} ({a.model_dir})", s))
    for judge, j in report["published"].items():
        for tool, s in sorted(j["scores"].items()):
            print(row(f"{tool} — published ({judge}, {j['prs']} PRs)", s))


if __name__ == "__main__":
    main()
