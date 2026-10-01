#!/usr/bin/env python3
"""Build the Martian offline benchmark's case sets for the bench harness.

    python3 bench/aacr/ext/martian_set.py --martian DIR [--cache DIR] [--scratch DIR]

DIR is withmartian/code-review-benchmark checked out at the pinned commit
e616e84; its golden comments and committed benchmark_data.json are verified
against the manifest sha256 registered in src/bench/aacr.ts DATASET_PINS
before anything is read. Writes bench/aacr/sets/martian50.json (all 50 PRs)
and martian-smoke10.json (the smoke: per project, the two smallest PRs with at
least two golden comments).

Each case is the PR as the benchmark's forks carry it — the code every
published tool reviewed: fork `code-review-benchmark/<project>__<repo>__augment__PR<n>__…`,
PR #1. Base/head shas, title and description come from that fork PR through
the public API, anonymously (60 requests/h: the builder waits for the reset
when it runs out) and are cached in bench/aacr/ext/martian/fork-prs.json so a
rebuild asks nothing. The merge-base is computed here (gitmeta.resolve) and
carried as `expect_merge_base`; prefetch refuses a store that disagrees.
`repo`/`pr` stay the ORIGINAL project and PR (the golden URL), so the review
reads like a review of that project; `fetch_repo`/`fetch_pr` name the fork.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import gitmeta  # noqa: E402

PIN = {
    "source": "https://github.com/withmartian/code-review-benchmark",
    "commit": "e616e849755441da38f18bf3adba2c9583b03803",
    "file": "offline/golden_comments/*.json + offline/results/benchmark_data.json (manifest sha256)",
    "sha256": "0265909b9ebe206e9b8e28f548f0a3ffa145c9b28d317da522ef1034186269ee",
}
FORK_ORG = "code-review-benchmark"
LANGUAGE = {
    "cal_dot_com.json": "TypeScript",
    "discourse.json": "Ruby",
    "grafana.json": "Go",
    "keycloak.json": "Java",
    "sentry.json": "Python",
}
API_CACHE = HERE / "martian" / "fork-prs.json"
SETS = HERE.parent / "sets"


def manifest_sha256(offline: Path) -> str:
    files = sorted(
        [f"golden_comments/{p.name}" for p in (offline / "golden_comments").glob("*.json")]
        + ["results/benchmark_data.json"]
    )
    lines = "".join(f"{gitmeta.sha256_file(offline / f)}  offline/{f}\n" for f in files)
    return hashlib.sha256(lines.encode()).hexdigest()


def api_get(path: str, log=print) -> dict:
    url = f"https://api.github.com{path}"
    for _ in range(3):
        req = urllib.request.Request(url, headers={"accept": "application/vnd.github+json",
                                                   "user-agent": "qcr-ext-bench"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code in (403, 429) and e.headers.get("x-ratelimit-remaining") == "0":
                wait = max(0, int(e.headers.get("x-ratelimit-reset", "0")) - int(time.time())) + 5
                log(f"  GitHub API rate limit (anonymous) — waiting {wait // 60} min for the reset")
                time.sleep(wait)
                continue
            raise
    raise RuntimeError(f"{url}: still rate-limited")


def fork_pr(fork: str, cache: dict, log=print) -> dict:
    if fork in cache:
        return cache[fork]
    j = api_get(f"/repos/{FORK_ORG}/{fork}/pulls/1", log)
    row = {
        "title": j.get("title"),
        "body": j.get("body"),
        "base_ref": (j.get("base") or {}).get("ref"),
        "base_sha": (j.get("base") or {}).get("sha"),
        "head_sha": (j.get("head") or {}).get("sha"),
        "additions": j.get("additions"),
        "deletions": j.get("deletions"),
        "html_url": j.get("html_url"),
    }
    cache[fork] = row
    API_CACHE.parent.mkdir(parents=True, exist_ok=True)
    API_CACHE.write_text(json.dumps(cache, indent=1, sort_keys=True) + "\n")
    return row


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--martian", required=True, type=Path, help="the pinned checkout (contains offline/)")
    ap.add_argument("--cache", type=Path, help="dir of bare caches <project>.git with full history")
    ap.add_argument("--scratch", type=Path, default=Path("/tmp/qcr-ext-martian-scratch"))
    args = ap.parse_args()
    offline = args.martian / "offline"
    got = manifest_sha256(offline)
    if got != PIN["sha256"]:
        sys.exit(f"martian data manifest {got} != the pinned {PIN['sha256']} — not the e616e84 dataset")
    bd = json.loads((offline / "results" / "benchmark_data.json").read_text())
    cache = json.loads(API_CACHE.read_text()) if API_CACHE.exists() else {}

    cases = []
    for golden_url, entry in bd.items():
        project = entry["golden_source_file"]
        aug = [r for r in entry["reviews"] if r["tool"] == "augment"]
        if len(aug) != 1:
            sys.exit(f"{golden_url}: expected one augment fork, found {len(aug)}")
        fork = aug[0]["repo_name"]
        meta = fork_pr(fork, cache)
        owner_repo, _, num = golden_url.removeprefix("https://github.com/").partition("/pull/")
        base, head = meta["base_sha"], meta["head_sha"]
        cache_repo = None
        if args.cache:
            cache_repo = args.cache / (project.removesuffix(".json") + ".git")
        info = gitmeta.resolve(f"{FORK_ORG}/{fork}", base, head, cache_repo, args.scratch)
        lines = None
        if info["source"] == "cache":
            lines = gitmeta.diff_lines(cache_repo, info["merge_base"], head)
        print(f"{golden_url}: mb {info['merge_base'][:10]}{' (diverged)' if info['merge_base'] != base else ''}"
              f" via {info['source']}, {lines} lines")
        cases.append({
            # the PR number rides the id: sentry-greptile #1 and #2 share a head
            "instance_id": f"{owner_repo.replace('/', '__')}-{int(num)}@{head[:7]}",
            "repo": owner_repo,
            "pr": int(num),
            "pr_url": golden_url,
            "base_commit": base,
            "head_commit": head,
            "language": LANGUAGE[project],
            "pr_category": "",
            "change_line_count": lines if lines is not None else (meta.get("additions") or 0) + (meta.get("deletions") or 0),
            "references": len(entry["golden_comments"]),
            "fetch_repo": f"{FORK_ORG}/{fork}",
            "fetch_pr": 1,
            "title": meta["title"],
            "body": meta["body"],
            "expect_merge_base": info["merge_base"],
            "martian": {"project": project.removesuffix(".json"), "golden_url": golden_url,
                        "fork": fork, "base_ref": meta["base_ref"]},
        })

    def write(name: str, rule: str, chosen: list[dict]) -> None:
        out = {"name": name, "dataset": PIN, "rule": rule,
               "references": sum(c["references"] for c in chosen), "cases": chosen, "backups": []}
        (SETS / f"{name}.json").write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")
        print(f"wrote sets/{name}.json: {len(chosen)} PRs, {out['references']} golden comments")

    cases.sort(key=lambda c: (c["martian"]["project"], c["change_line_count"], c["instance_id"]))
    write("martian50", "every PR of the Martian offline benchmark (50 PRs, 173 golden comments)", cases)
    smoke = []
    for project in sorted({c["martian"]["project"] for c in cases}):
        pool = [c for c in cases if c["martian"]["project"] == project and c["references"] >= 2]
        smoke += pool[:2]
    if not any(c["expect_merge_base"] != c["base_commit"] for c in smoke):
        sys.exit("the smoke rule picked no merge-base-diverged PR — revisit the rule")
    write("martian-smoke10",
          "per project (5), the two smallest PRs by changed lines (merge-base..head) with >=2 golden comments",
          smoke)


if __name__ == "__main__":
    main()
