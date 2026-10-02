#!/usr/bin/env python3
"""Build Qodo PR-Review-Bench case sets for the bench harness — leak-proof.

    python3 bench/aacr/ext/qodo_set.py --data DIR [--cache DIR] [--scratch DIR] [--sets smoke10,pr100]

DIR holds the HF dataset Qodo/PR-Review-Bench at the pinned revision a73957c
(git_code_review_bench_100_w_open_prs.jsonl, sha256 checked against the
`qodo-pr-review-bench-a73957c` entry of src/bench/aacr.ts DATASET_PINS) and the
anonymous API cache written by qodo_scrape.py (the source forks' PR lists, for
each benchmark PR's base and head sha). Writes bench/aacr/sets/qodo-{smoke10,pr100}.json.

LEAK-PROOF, as sweprbench_set.py: the benchmark PRs live on forks whose branch
names and commit messages were written by whoever injected the bugs, so a case
names two SYNTHETIC commits — the real tree of the PR's merge-base and the real
tree of its head on top, fixed identity, a message that says nothing. The
repo's own AGENTS.md (the rules Qodo committed to every fork) stays in the
tree: every vendor reviewed with it. The PR title and description ride the set
from the source fork PR, reduced to the upstream PR's own title and
description (original_pr).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import gitmeta  # noqa: E402

PIN = {
    "source": "https://huggingface.co/datasets/Qodo/PR-Review-Bench",
    "commit": "a73957c450a70693a743260e5637fffc44625f16",
    "file": "git_code_review_bench_100_w_open_prs.jsonl",
    "sha256": "",  # filled from the file and checked against DATASET_PINS
}
ORG = "agentic-review-benchmarks"
LANG = {"cal.com": "TypeScript", "Ghost": "JavaScript", "dify": "Python", "firefox-ios": "Swift",
        "prefect": "Python", "tauri": "Rust", "aspnetcore": "C#", "redis": "C"}
SETS = HERE.parent / "sets"


def source_prs(cache: Path, repo: str) -> dict[int, dict]:
    out = {}
    for f in sorted((cache / "api").glob(f"api.github.com_repos_{ORG}_{re.escape(repo).replace(chr(92), '')}_pulls_state_all*.json")):
        for p in json.loads(f.read_text()) or []:
            out[p["number"]] = p
    return out


def original_pr(p: dict) -> tuple[str, str]:
    """The source fork PR's body wraps the upstream PR: a "Code Review Bench PR #N"
    header, **Original PR Title**, **Original PR Description** and **Original PR
    URL**. Keep the upstream title and description only — the header says the
    PR is a benchmark item and the URL points at the clean upstream PR."""
    b = p.get("body") or ""
    t = re.search(r"\*\*Original PR Title\*\*:\s*(.*)", b)
    d = re.search(r"\*\*Original PR Description\*\*:\s*(.*?)(?:\n\*\*Original PR URL\*\*:|\Z)", b, re.S)
    return ((t.group(1).strip() if t else p.get("title") or ""), (d.group(1).strip() if d else ""))


def smoke10(rows: list[dict]) -> list[str]:
    """One PR per repository (the lowest sha256 of its URL), then the two lowest of the rest."""
    key = lambda r: hashlib.sha256(r["pr_url_to_review"].encode()).hexdigest()
    picked, by = [], {}
    for r in sorted(rows, key=key):
        repo = r["pr_url_to_review"].split("/")[4]
        if repo not in by:
            by[repo] = r["pr_url_to_review"]
            picked.append(r["pr_url_to_review"])
    rest = [r["pr_url_to_review"] for r in sorted(rows, key=key) if r["pr_url_to_review"] not in picked]
    return picked + rest[:10 - len(picked)]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", required=True, type=Path, help="dir with the dataset jsonl and the scrape's api/ cache")
    ap.add_argument("--cache", type=Path, help="dir of bare caches <owner>__<repo>.git")
    ap.add_argument("--scratch", type=Path, default=Path("/tmp/qcr-ext-qodo-scratch"))
    ap.add_argument("--sets", default="smoke10,pr100")
    a = ap.parse_args()
    f = a.data / PIN["file"]
    PIN["sha256"] = gitmeta.sha256_file(f)
    rows = [json.loads(l) for l in f.read_text().splitlines() if l.strip()]
    resolved = {}
    for n, r in enumerate(rows, 1):
        m = re.search(r"github\.com/([^/]+)/([^/]+)/pull/(\d+)", r["pr_url_to_review"])
        owner, repo, num = m.group(1), m.group(2), int(m.group(3))
        p = source_prs(a.data, repo).get(num)
        if not p:
            sys.exit(f"{r['pr_url_to_review']}: not in the scraped PR list — run qodo_scrape.py sources first")
        full = f"{owner}/{repo}"
        cache = a.cache / (full.replace("/", "__") + ".git") if a.cache else None
        info = gitmeta.resolve(full, p["base"]["sha"], p["head"]["sha"], cache, a.scratch)
        base_id, head_id = gitmeta.leakproof_ids(info["base_tree"], info["head_tree"])
        resolved[r["pr_url_to_review"]] = {
            "instance_id": f"{full.replace('/', '__')}@{head_id[:7]}",
            "repo": full,
            "pr": num,
            "pr_url": r["pr_url_to_review"],
            "base_commit": base_id,
            "head_commit": head_id,
            "language": LANG.get(repo, ""),
            "pr_category": "qodo-injected",
            "change_line_count": int(p.get("additions") or 0) + int(p.get("deletions") or 0),
            "references": int(r["num_of_issues"]),
            "title": original_pr(p)[0],
            "body": original_pr(p)[1],
            "leakproof": {
                "source_head": p["head"]["sha"],
                "source_merge_base": info["merge_base"],
                "base_tree": info["base_tree"],
                "head_tree": info["head_tree"],
            },
            "task_id": f"{repo}#{num}",
            "source_base_commit": p["base"]["sha"],
        }
        print(f"[{n}/{len(rows)}] {repo}#{num}: mb {info['merge_base'][:10]} via {info['source']} → "
              f"{resolved[r['pr_url_to_review']]['instance_id']}", flush=True)
    ids = {"smoke10": smoke10(rows), "pr100": [r["pr_url_to_review"] for r in rows]}
    rules = {"smoke10": "one PR per repository (lowest sha256 of the PR URL) plus the next two",
             "pr100": "every PR of the benchmark (git_code_review_bench_100_w_open_prs.jsonl)"}
    for s in a.sets.split(","):
        cases = [resolved[u] for u in ids[s]]
        if len({c["instance_id"] for c in cases}) != len(cases):
            sys.exit(f"{s}: duplicate instance ids")
        out = {"name": f"qodo-{s}", "dataset": PIN, "rule": rules[s],
               "references": sum(c["references"] for c in cases), "cases": cases, "backups": []}
        (SETS / f"qodo-{s}.json").write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")
        print(f"wrote sets/qodo-{s}.json: {len(cases)} PRs, {out['references']} ground-truth issues")


if __name__ == "__main__":
    main()
