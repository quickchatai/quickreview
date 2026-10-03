#!/usr/bin/env python3
"""Duplicates per case in stored runs (docs/duplicate-merge.md measurement).

Analysis only. Per case of each run, from its findings record:
  raw          every entry
  merged       merge-stage attrition (merged / folded entries)
  posted       posted entries
  posted_dups  posted duplicates: follower rows (`same_as`) plus pairs of posted
               entries in one file within 3 lines that share a named identifier
               (the post-check's rule, src/dedup.ts)
  comments     inline comments posted (comments.json)
  extra_sites  inline comments beyond one per posted root cause (comments minus
               posted entries that are not follower rows): a root cause posted
               at several sites, in record shapes that did not mark followers

  dup_stats.py --runs-dir DIR --run RUN [--run RUN ...] [--filter-set NAME ...]
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
from pathlib import Path


def ids(t: str) -> set[str]:
    return {m for span in re.findall(r"`([^`\n]{1,200})`", t or "") for m in re.findall(r"[A-Za-z_$][A-Za-z0-9_$]{2,}", span)}


def stats(cd: Path) -> dict | None:
    try:
        rec = json.load(open(cd / "findings-record.json"))
    except Exception:
        return None
    f = [e for e in rec.get("findings") or [] if isinstance(e, dict)]
    posted = [e for e in f if e.get("disposition") == "posted"]
    near = 0
    for i in range(len(posted)):
        for j in range(i + 1, len(posted)):
            a, b = posted[i], posted[j]
            try:
                if (a.get("path") == b.get("path") and abs(int(a.get("line")) - int(b.get("line"))) <= 3
                        and ids(f"{a.get('title')} {a.get('body')}") & ids(f"{b.get('title')} {b.get('body')}")):
                    near += 1
            except (TypeError, ValueError):
                pass
    try:
        comments = len(json.load(open(cd / "comments.json")))
    except Exception:
        comments = 0
    return {
        "raw": len(f),
        "merged": sum(1 for e in f if e.get("disposition") in ("merged", "folded")),
        "posted": len(posted),
        "posted_dups": near + sum(1 for e in posted if e.get("same_as")),
        "comments": comments,
        "extra_sites": max(0, comments - sum(1 for e in posted if not e.get("same_as"))),
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--runs-dir", default=os.environ.get("QCR_BENCH_RUNS_DIR", ""))
    ap.add_argument("--run", action="append", required=True)
    ap.add_argument("--filter-set", action="append", default=[])
    a = ap.parse_args()
    here = Path(__file__).resolve().parent
    allowed = None
    if a.filter_set:
        allowed = set()
        for n in a.filter_set:
            allowed |= {c["instance_id"] for c in json.load(open(here / "sets" / f"{n}.json"))["cases"]}
    print("| run | case | raw | merged | posted | posted dups | inline comments | extra sites |")
    print("|---|---|---|---|---|---|---|---|")
    tot: dict[str, dict[str, int]] = {}
    for run in a.run:
        for cd in sorted(glob.glob(str(Path(a.runs_dir) / run / "cases" / "*"))):
            name = os.path.basename(cd)
            if allowed is not None and name not in allowed:
                continue
            s = stats(Path(cd))
            if s is None:
                continue
            t = tot.setdefault(run, {k: 0 for k in s} | {"cases": 0})
            for k, v in s.items():
                t[k] += v
            t["cases"] += 1
            print(f"| {run} | {name} | {s['raw']} | {s['merged']} | {s['posted']} | {s['posted_dups']} | {s['comments']} | {s['extra_sites']} |")
    print()
    print("| run | cases | raw | merged | posted | posted dups | inline comments | extra sites | comments/PR |")
    print("|---|---|---|---|---|---|---|---|---|")
    for run, t in tot.items():
        print(f"| {run} | {t['cases']} | {t['raw']} | {t['merged']} | {t['posted']} | {t['posted_dups']} | {t['comments']} | {t['extra_sites']} | {t['comments'] / max(1, t['cases']):.1f} |")


if __name__ == "__main__":
    main()
