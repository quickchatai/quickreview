#!/usr/bin/env python3
"""Anonymous, cached, resumable scrape of Qodo PR-Review-Bench's public GitHub data.

READ ONLY and ANONYMOUS: no token is ever sent (any GH_TOKEN/GITHUB_TOKEN in the
environment is ignored). Anonymous REST allows 60 requests an hour, so every
response is cached under CACHE/api/ and a rerun only fetches what is missing;
when the limit is spent the scraper sleeps until X-RateLimit-Reset.

  qodo_scrape.py --cache DIR sources     # the 8 source forks' PR lists (head/base sha, title, body)
  qodo_scrape.py --cache DIR comments    # every tool fork's inline review comments (repo-level list)
  qodo_scrape.py --cache DIR build       # → DIR/tool-comments.json (benchmark row → tool → comments)

The tool forks are agentic-review-benchmarks/<repo>-combined-<tool>; which tool PR
reviewed which benchmark PR comes from the benchmark-pr-mapping README (pinned by
commit; fetched from raw.githubusercontent.com, which is not the REST API).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ORG = "agentic-review-benchmarks"
REPOS = ["Ghost", "cal.com", "dify", "firefox-ios", "prefect", "tauri", "aspnetcore", "redis"]
TOOLS = ["qodo", "augment", "copilot", "cursor", "greptile", "codex", "coderabbit", "sentry"]
COLUMNS = ["qodo-exhaustive", "qodo-precise", "augment", "copilot", "cursor", "greptile", "codex", "coderabbit", "sentry"]
MAPPING_COMMIT = "81cb96a3a2781186a446bf9fb8dd06d5314fb1a1"
UA = "qcr-bench-qodo-scrape (anonymous research read)"


def get(cache: Path, url: str) -> object:
    key = re.sub(r"[^A-Za-z0-9._-]+", "_", url.split("://", 1)[1])
    f = cache / "api" / f"{key}.json"
    if f.exists():
        return json.loads(f.read_text())
    f.parent.mkdir(parents=True, exist_ok=True)
    while True:
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/vnd.github+json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                body = r.read()
                rem = r.headers.get("X-RateLimit-Remaining")
                reset = r.headers.get("X-RateLimit-Reset")
            data = json.loads(body)
            f.write_text(json.dumps(data))
            print(f"GET {url} -> {len(data) if isinstance(data, list) else 'obj'} (remaining {rem})", flush=True)
            if rem is not None and int(rem) == 0 and reset:
                wait = max(0, int(reset) - int(time.time())) + 5
                print(f"rate limit spent; sleeping {wait}s", flush=True)
                time.sleep(wait)
            return data
        except urllib.error.HTTPError as e:
            if e.code in (403, 429):
                reset = e.headers.get("X-RateLimit-Reset")
                wait = max(60, int(reset) - int(time.time()) + 5) if reset else 600
                print(f"HTTP {e.code} on {url}; sleeping {wait}s", flush=True)
                time.sleep(wait)
                continue
            if e.code == 404:
                f.write_text("null")
                print(f"404 {url}", flush=True)
                return None
            raise


def paged(cache: Path, base: str) -> list:
    out, page = [], 1
    while True:
        sep = "&" if "?" in base else "?"
        data = get(cache, f"{base}{sep}per_page=100&page={page}") or []
        out.extend(data)
        if len(data) < 100:
            return out
        page += 1


def mapping(cache: Path) -> list[dict]:
    f = cache / "mapping-README.md"
    if not f.exists():
        url = f"https://raw.githubusercontent.com/{ORG}/benchmark-pr-mapping/{MAPPING_COMMIT}/README.md"
        f.write_bytes(urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=60).read())
    rows = []
    for ln in f.read_text().splitlines():
        if not ln.startswith("| ") or "](https://github.com/" not in ln:
            continue
        cells = [c.strip() for c in ln.strip().strip("|").split("|")]
        repo, title, links = cells[0], cells[1], cells[2:]
        row = {"repo": repo, "title": title, "tools": {}}
        for col, cell in zip(COLUMNS, links):
            m = re.search(r"github\.com/([^/]+)/([^/]+)/pull/(\d+)", cell)
            if m:
                row["tools"][col] = {"fork": m.group(2), "pr": int(m.group(3))}
        rows.append(row)
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", required=True, type=Path)
    ap.add_argument("what", choices=["sources", "comments", "build"])
    a = ap.parse_args()
    for k in ("GH_TOKEN", "GITHUB_TOKEN"):
        os.environ.pop(k, None)
    cache = a.cache
    if a.what in ("sources", "build"):
        for repo in REPOS:
            paged(cache, f"https://api.github.com/repos/{ORG}/{repo}/pulls?state=all")
    if a.what in ("comments", "build"):
        forks = sorted({t["fork"] for r in mapping(cache) for t in r["tools"].values()})
        print(f"{len(forks)} tool forks", flush=True)
        for fork in forks:
            paged(cache, f"https://api.github.com/repos/{ORG}/{fork}/pulls/comments?sort=created&direction=asc")
    if a.what == "build":
        rows = mapping(cache)
        bench = [json.loads(l) for l in open(cache / "git_code_review_bench_100_w_open_prs.jsonl")]
        src = {}
        for repo in REPOS:
            for p in paged(cache, f"https://api.github.com/repos/{ORG}/{repo}/pulls?state=all"):
                src[(repo, p["number"])] = p
        bytitle = {(r["repo"], r["title"].strip()): r for r in rows}
        comments = {}
        for fork in sorted({t["fork"] for r in rows for t in r["tools"].values()}):
            for c in paged(cache, f"https://api.github.com/repos/{ORG}/{fork}/pulls/comments?sort=created&direction=asc"):
                n = int(c["pull_request_url"].rsplit("/", 1)[1])
                comments.setdefault((fork, n), []).append(c)
        out, unmatched = [], []
        for b in bench:
            m = re.search(r"github\.com/[^/]+/([^/]+)/pull/(\d+)", b["pr_url_to_review"])
            repo, n = m.group(1), int(m.group(2))
            p = src.get((repo, n))
            # the source fork PR title is "Code Review Bench PR #<upstream> - <upstream title>";
            # the mapping README lists the upstream title alone
            t = re.sub(r"^Code Review Bench PR #\d+\s*-\s*", "", (p or {}).get("title", "")).strip()
            row = bytitle.get((repo, t))
            if row is None:  # the README truncates long titles to 60 chars + "..."
                hits = [r for (rp, rt), r in bytitle.items()
                        if rp == repo and rt.endswith("...") and t.startswith(rt[:-3].rstrip())]
                row = hits[0] if len(hits) == 1 else None
            if not row:
                unmatched.append(b["pr_url_to_review"])
            tools = {}
            for col, t in (row or {"tools": {}})["tools"].items():
                cs = comments.get((t["fork"], t["pr"]), [])
                tools[col] = {"fork": t["fork"], "pr": t["pr"], "comments": [
                    {"path": c.get("path"), "line": c.get("line") or c.get("original_line"),
                     "start_line": c.get("start_line") or c.get("original_start_line"),
                     "side": c.get("side"), "user": (c.get("user") or {}).get("login"),
                     "in_reply_to": c.get("in_reply_to_id"), "body": c.get("body")} for c in cs]}
            out.append({"pr_url": b["pr_url_to_review"], "repo": repo, "number": n,
                        "title": (p or {}).get("title"), "body": (p or {}).get("body"),
                        "head_sha": ((p or {}).get("head") or {}).get("sha"),
                        "base_sha": ((p or {}).get("base") or {}).get("sha"),
                        "base_ref": ((p or {}).get("base") or {}).get("ref"),
                        "tools": tools})
        (cache / "tool-comments.json").write_text(json.dumps(out, indent=1))
        counts = {col: sum(len(r["tools"].get(col, {}).get("comments", [])) for r in out) for col in COLUMNS}
        print("unmatched benchmark PRs:", unmatched)
        print("inline comments per tool:", counts)


if __name__ == "__main__":
    main()
