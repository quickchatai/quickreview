#!/usr/bin/env python3
"""Two facts of the answer key's build, read from the `*-code` case dirs
(`orig40-code/`, `rest145-code/`, `fresh10-code/` beside `runs/`) and shipped
as data, never as code: the run archive carries them as
`key-data/candidate-maps.json` and `key-data/pr-diffstats.json`, the Hugging
Face dataset as the `aacr_candidates` and `pr_diffstats` configs.

  candidate_rows   which reviewer raised each candidate the key was built
                   from: `candidates-key.json` maps C1..Cn to the earlier run
                   that raised it (rest145's first key), and
                   `new-candidates-key.json` maps N1..Nn to the reviewer of the
                   comparison runs (the extended key); `candidates.json` and
                   `new-candidates.json` give each candidate's file, lines and
                   text (a review comment of one of those runs).
  diffstat_rows    each PR's size as the papers bucket it: files changed,
                   insertions and deletions from the summary line of the
                   case's `diff.stat` (`git diff --stat base head`).

Standard library only.
"""
from __future__ import annotations

import json
import os
import re
from typing import Dict, List

CODE_DIRS = ("orig40-code", "rest145-code", "fresh10-code")
ROUNDS = (("candidates", "candidates-key.json", "candidates.json"),
          ("new-candidates", "new-candidates-key.json", "new-candidates.json"))
STAT = re.compile(r"(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?")


def _case_dirs(src: str):
    for code in CODE_DIRS:
        d = os.path.join(src, code)
        if not os.path.isdir(d):
            continue
        for iid in sorted(os.listdir(d)):
            p = os.path.join(d, iid)
            if "@" in iid and os.path.isdir(p):
                yield code, iid, p


def _load(path: str):
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def candidate_rows(src: str) -> List[dict]:
    """One row per key-building candidate: the PR, the round, the candidate id,
    the run or reviewer that raised it, and where it pointed."""
    rows = []
    for code, iid, d in _case_dirs(src):
        for rnd, keyf, candf in ROUNDS:
            key = _load(os.path.join(d, keyf))
            if not isinstance(key, dict):
                continue
            cands = _load(os.path.join(d, candf)) or {}
            by_id = {c.get("cand"): c for c in cands.get("candidates") or [] if isinstance(c, dict)}
            for cid in sorted(key, key=lambda c: (re.sub(r"\d+", "", c), int(re.sub(r"\D", "", c) or 0))):
                c = by_id.get(cid) or {}
                rows.append({"instance_id": iid, "code_dir": code, "round": rnd, "candidate": cid,
                             "raised_by": key[cid], "path": c.get("path"), "from_line": c.get("from_line"),
                             "to_line": c.get("to_line"), "text": c.get("text")})
    return rows


def parse_diffstat(text: str) -> Dict[str, int] | None:
    """The summary line of `git diff --stat`, or None when it has none."""
    m = None
    for m in STAT.finditer(text):
        pass
    if m is None:
        return None
    files, ins, dels = (int(x) if x else 0 for x in m.groups())
    return {"files_changed": files, "insertions": ins, "deletions": dels, "changed_lines": ins + dels}


def diffstat_rows(src: str) -> List[dict]:
    """One row per PR with a `diff.stat`: its size, and every code dir that
    holds the same file (fresh10's ten PRs are also in orig40)."""
    out: Dict[str, dict] = {}
    for code, iid, d in _case_dirs(src):
        p = os.path.join(d, "diff.stat")
        if not os.path.isfile(p):
            continue
        st = parse_diffstat(open(p, errors="replace").read())
        if st is None:
            continue
        if iid in out:
            if {k: out[iid][k] for k in st} != st:
                raise SystemExit(f"{iid}: two code dirs disagree on diff.stat")
            out[iid]["code_dirs"].append(code)
            continue
        out[iid] = {"instance_id": iid, **st, "code_dirs": [code]}
    return [out[k] for k in sorted(out)]
