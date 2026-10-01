#!/usr/bin/env python3
"""Build SWE-PRBench case sets for the bench harness — leak-proof.

    python3 bench/aacr/ext/sweprbench_set.py --data DIR [--cache DIR] [--scratch DIR] [--sets smoke10,eval100,350]

DIR is the HF dataset foundry-ai/swe-prbench at the pinned revision b87f579
(its `dataset/prs.jsonl` sha256 is checked against src/bench/aacr.ts
DATASET_PINS, and every file the evaluation reads against
bench/aacr/ext/sweprbench/dataset-manifest.sha256). Writes
bench/aacr/sets/sweprbench-{smoke10,eval100,350}.json.

LEAK-PROOF. The dataset's ground truth is the PR's human review, and the
recorded head is the PR's FINAL head: its intermediate commits and every
commit message may echo that review ("address review: …"). So a case names two
SYNTHETIC commits — the real tree of the PR's merge-base, and the real tree of
its head on top — with a fixed identity and a message that says nothing
(gitmeta.leakproof_commit_text = src/bench/aacr.ts leakproofCommitText). This
builder computes their ids by hand from the two tree ids; prefetch fetches the
two real commits at depth 1, writes the synthetic ones, checks the ids match,
and clones only what the synthetic head reaches into the store. The merge-base
and trees come from a local full-history cache when it has the commits, else a
commits-only partial fetch from GitHub (anonymous).

The PR's title and description ride the set (from prs.jsonl), so prefetch
asks no API. `references` is the number of ground-truth comments the
harness's loader selects (substantive_comment_ids, else initiating comments).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import gitmeta  # noqa: E402

PIN = {
    "source": "https://huggingface.co/datasets/foundry-ai/swe-prbench",
    "commit": "b87f5797aef3ed2c3153bb1304ea4d801d36ba6e",
    "file": "dataset/prs.jsonl",
    "sha256": "a58e1f713533f6bc260a93f6e234b85acd16a77f55a756893694b96495eb43cd",
}
# The 10-PR smoke (DECISIONS: all from eval_100, two per difficulty-ish, five languages).
SMOKE10 = [
    "coreos-assembler__4386", "stylelint__8953", "vitest__9152", "nessie__11676", "mycli__1517",
    "falcon__2572", "pip__13482", "pipecat__3328", "espnet__6356", "litgpt__2188",
]
SETS = HERE.parent / "sets"
MANIFEST = HERE / "sweprbench" / "dataset-manifest.sha256"


def ground_truth_count(annotation: dict) -> int:
    """eval_harness/loader.py load_eval_input's selection, verbatim in effect."""
    comments = annotation.get("comments", [])
    ids = set(annotation.get("substantive_comment_ids", []))
    if ids:
        return sum(1 for c in comments if c.get("comment_id") in ids)
    return sum(1 for c in comments if c.get("is_initiating_comment"))


def write_manifest(dataset: Path) -> None:
    """sha256 of every file the evaluation reads (prs.jsonl, annotations,
    contexts, evals) — written once, verified by sweprbench_eval.sh."""
    files = sorted(
        str(p.relative_to(dataset.parent))
        for p in dataset.rglob("*")
        if p.is_file() and p.name != ".DS_Store"
    )
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text("".join(f"{gitmeta.sha256_file(dataset.parent / f)}  {f}\n" for f in files))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", required=True, type=Path, help="the HF dataset checkout (contains dataset/)")
    ap.add_argument("--cache", type=Path, help="dir of bare caches <owner>__<repo>.git with full history")
    ap.add_argument("--scratch", type=Path, default=Path("/tmp/qcr-ext-swepr-scratch"))
    ap.add_argument("--sets", default="smoke10,eval100,350")
    args = ap.parse_args()
    dataset = args.data / "dataset"
    prs_path = dataset / "prs.jsonl"
    got = gitmeta.sha256_file(prs_path)
    if got != PIN["sha256"]:
        sys.exit(f"prs.jsonl sha256 {got} != the pinned {PIN['sha256']} — not the b87f579 dataset")
    if not MANIFEST.exists():
        write_manifest(dataset)
    prs = {r["task_id"]: r for r in map(json.loads, prs_path.read_text().splitlines()) if r}
    eval100 = [e["task_id"] for e in json.loads((dataset / "evals" / "eval_100.json").read_text())]
    want = args.sets.split(",")
    ids = {"smoke10": SMOKE10, "eval100": eval100, "350": sorted(prs)}

    needed = sorted({t for s in want for t in ids[s]})
    resolved: dict[str, dict] = {}
    for n, tid in enumerate(needed, 1):
        pr = prs[tid]
        repo = pr["repo"]
        cache = args.cache / (repo.replace("/", "__") + ".git") if args.cache else None
        info = gitmeta.resolve(repo, pr["base_commit"], pr["head_commit"], cache, args.scratch)
        base_id, head_id = gitmeta.leakproof_ids(info["base_tree"], info["head_tree"])
        ann = json.loads((dataset / "annotations" / f"{tid}_human.json").read_text())
        resolved[tid] = {
            "instance_id": f"{repo.replace('/', '__')}@{head_id[:7]}",
            "repo": repo,
            "pr": int(pr["pr_number"]),
            "pr_url": pr["pr_url"],
            "base_commit": base_id,
            "head_commit": head_id,
            "language": pr.get("language") or "",
            "pr_category": pr.get("difficulty") or "",
            "change_line_count": int(pr.get("lines_added") or 0) + int(pr.get("lines_removed") or 0),
            "references": ground_truth_count(ann),
            "title": pr.get("title"),
            "body": pr.get("description"),
            "leakproof": {
                "source_head": pr["head_commit"],
                "source_merge_base": info["merge_base"],
                "base_tree": info["base_tree"],
                "head_tree": info["head_tree"],
            },
            "task_id": tid,
            "source_base_commit": pr["base_commit"],
        }
        print(f"[{n}/{len(needed)}] {tid}: mb {info['merge_base'][:10]}"
              f"{' (≠ base)' if info['merge_base'] != pr['base_commit'] else ''} via {info['source']}"
              f" → {resolved[tid]['instance_id']}", flush=True)

    rules = {
        "smoke10": "the 10-PR smoke from eval_100 (DECISIONS-PENDING.md)",
        "eval100": "evals/eval_100.json — the split every published SWE-PRBench number is on",
        "350": "every PR of the dataset",
    }
    for s in want:
        cases = [resolved[t] for t in ids[s]]
        seen = {c["instance_id"] for c in cases}
        if len(seen) != len(cases):
            sys.exit(f"{s}: duplicate instance ids")
        out = {"name": f"sweprbench-{s}", "dataset": PIN, "rule": rules[s],
               "references": sum(c["references"] for c in cases), "cases": cases, "backups": []}
        (SETS / f"sweprbench-{s}.json").write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")
        print(f"wrote sets/sweprbench-{s}.json: {len(cases)} PRs, {out['references']} ground-truth comments")


if __name__ == "__main__":
    main()
