#!/usr/bin/env python3
"""Martian tune20 against the extended key: every candidate classified blind, recounted from the archive.

    python3 bench/aacr/recompute/martian_ext.py --archive <release>/archive --data <hf-dataset> \\
        [--work <scratch>] [--json OUT]

(`uv run --no-project --with pyarrow python ...` for the HF `runs` table.)

benchmark.tex "Martian's list against one key" (tab:martianext, its sensitivity table, the golden
quality and severity-tier paragraphs). Reads from the archive's `analysis` volume the classification
the analysis tree's fair/agg.py and fair/report.py scored:
  fair/secret.json     the 580 candidates Martian's step 2 extracted from the eight tools on tune20,
                       with their tool, PR, text and whether the judge matched them to a golden;
  fair/out/<pr>.json   the blind classification of each PR's candidates (GOLDEN / REAL / MINOR / WRONG,
                       the issue each names) and the PR's REAL key entries (real defects no golden lists);
  gm/rows.json         the quality of each of the 59 tune20 goldens (valid, trivial, doubtful, wrong), and
                       what the default QuickReview did with it (`D`: P+ posted and credited, P- posted
                       and not credited, RNP raised and not posted, NR never raised by any lens);
and the primary judge's (gpt-6.1-sol) Martian scoring of tune20, `runs/mv-r1-asposted.martian/results/`
(benchmark_data.json, gpt-6.1-sol/candidates.json and evaluations.json), for the goldens each re-judged
tool is credited with.

The rules are fair/agg.py's: the key is the 38 valid goldens plus every REAL entry; a candidate's final
class is its classification, with a second candidate of the same tool and PR naming the same issue a
DUP (judge-matched candidates first, then by class rank, then by id); GOOD = KEY-GOLDEN or REAL, MINOR
= a true-but-minor note or a trivial or doubtful golden, WRONG = wrong (a wrong golden included).
Recall = key entries a tool raised / key size; strict precision = GOOD / candidates; lenient = GOOD /
(candidates - MINOR). No model call.
"""
from __future__ import annotations

import argparse
import collections
import glob
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from archive import open_archive, read_json, volumes_for  # noqa: E402
from tables import load_table  # noqa: E402

AN = "analysis/external-benchmarks-2026-10-02"
SCORING = "mv-r1-asposted.martian"
JUDGE = "gpt-6.1-sol"
TOOLS = ("quickreview", "cubic-v2", "qodo-extended-v2", "claude-code", "augment", "qodo-v2", "macroscope", "devin")
REJUDGED = {"quickreview": "quickreview", "cubic-v2": "rejudged-cubic-v2", "qodo-extended-v2": "rejudged-qodo-extended-v2",
            "claude-code": "rejudged-claude-code"}
# a golden's short id: the PR's repo prefix, its number and the golden's index (fair/gold.py)
PREF = {"cal": "https://github.com/calcom/cal.com/pull/", "dis": "https://github.com/ai-code-review-evaluation/discourse-graphite/pull/",
        "gr": "https://github.com/grafana/grafana/pull/", "kc": "https://github.com/keycloak/keycloak/pull/",
        "sg": "https://github.com/ai-code-review-evaluation/sentry-greptile/pull/", "s": "https://github.com/getsentry/sentry/pull/"}
ALIAS = {"s93824.1": ["s93824.3"]}  # golden .3 is the same patched sleep at a second site
RANK = {"KEY-GOLDEN": 0, "REAL": 0, "GOLDEN-TRIVIAL": 1, "GOLDEN-DOUBTFUL": 1, "MINOR": 2, "GOLDEN-WRONG": 3, "WRONG": 3}
ROLL = {"KEY-GOLDEN": "GOOD", "REAL": "GOOD", "GOLDEN-TRIVIAL": "MINOR", "GOLDEN-DOUBTFUL": "MINOR", "MINOR": "MINOR",
        "DUP": "DUP", "WRONG": "WRONG", "GOLDEN-WRONG": "WRONG"}
QUALITY = ("valid", "trivial", "doubtful", "wrong")


def gid(pr_url: str, i) -> str:
    for p, u in PREF.items():
        if pr_url.startswith(u):
            return f"{p}{pr_url[len(u):]}.{i}"
    raise SystemExit(f"no golden id prefix for {pr_url}")


def f1(p, r):
    return 2 * p * r / (p + r) if p + r else 0.0


def pct(a, b):
    return 100.0 * a / b if b else None


class Ext:
    def __init__(self, root: Path):
        an = root / AN
        self.S = read_json(an / "fair" / "secret.json")
        self.ANN, self.KEYREAL = {}, {}
        for f in sorted(glob.glob(str(an / "fair" / "out" / "*.json"))):
            d = read_json(Path(f))
            self.ANN.update(d["candidates"])
            self.KEYREAL.update(d.get("key_entries") or {})
        missing = [c for c in self.S if c not in self.ANN]
        if missing:
            raise SystemExit(f"{len(missing)} candidates have no classification")
        self.rows = read_json(an / "gm" / "rows.json")
        self.GQ = {f"{r['pr']}.{r['idx']}": r["q"] for r in self.rows}
        res = root / "runs" / SCORING / "results"
        self.bd = read_json(res / "benchmark_data.json")
        self.ge = read_json(res / JUDGE / "evaluations.json")
        self.TUNE = sorted(read_json(res / JUDGE / "candidates.json"))
        self.GSEV = {gid(pr, i): g["severity"] for pr in self.TUNE for i, g in enumerate(self.bd[pr]["golden_comments"])}
        self.VALID = {g for g, q in self.GQ.items() if q == "valid"}
        self.key = self.VALID | set(self.KEYREAL)
        self.FINAL = self._final()
        self.SRC = collections.defaultdict(set)
        for c, a in self.ANN.items():
            for j in self._issues(a):
                if j in self.key:
                    self.SRC[j].add(self.S[c]["tool"])

    def base(self, a):
        if a["class"] == "GOLDEN":
            return {"valid": "KEY-GOLDEN", "trivial": "GOLDEN-TRIVIAL", "doubtful": "GOLDEN-DOUBTFUL", "wrong": "GOLDEN-WRONG"}[self.GQ[a["issue"]]]
        return a["class"]

    def _final(self):
        by = collections.defaultdict(list)
        for c, s in self.S.items():
            by[(s["tool"], s["pr"])].append(c)
        out = {}
        for cids in by.values():
            seen = set()
            for c in sorted(cids, key=lambda c: (0 if self.S[c]["matched"] else 1, RANK.get(self.base(self.ANN[c]), 5), c)):
                a = self.ANN[c]
                if a["issue"] in seen:
                    out[c] = "DUP"
                else:
                    out[c] = self.base(a)
                    seen.add(a["issue"])
        return out

    @staticmethod
    def _issues(a):
        for i in [a["issue"]] + list(a.get("also") or []):
            yield from [i] + ALIAS.get(i, [])

    def cands(self, tool, pr=None):
        return [c for c in self.S if self.S[c]["tool"] == tool and (pr is None or self.S[c]["pr"] == pr)]

    def tool(self, t) -> dict:
        cids = self.cands(t)
        n = len(cids)
        roll = collections.Counter(ROLL[self.FINAL[c]] for c in cids)
        raised = {j for c in cids for j in self._issues(self.ANN[c]) if j in self.key}
        rec = len(raised) / len(self.key)
        ps = roll["GOOD"] / n
        pl = roll["GOOD"] / (n - roll["MINOR"])
        return {"candidates": n, "per_pr": n / len(self.TUNE), "raised": len(raised),
                "valid_raised": len(raised & self.VALID), "real_raised": len(raised & set(self.KEYREAL)),
                "recall": 100 * rec, "p_strict": 100 * ps, "p_lenient": 100 * pl,
                "f1_strict": 100 * f1(ps, rec), "f1_lenient": 100 * f1(pl, rec),
                "good_pct": pct(roll["GOOD"], n), "minor_pct": pct(roll["MINOR"], n), "dup_pct": pct(roll["DUP"], n),
                "wrong_pct": pct(roll["WRONG"], n)}

    def variant(self, keep) -> dict:
        ks = self.VALID | {k for k in self.KEYREAL if keep(k)}
        out = {"key": len(ks)}
        for t in TOOLS:
            cids = self.cands(t)
            raised = {j for c in cids for j in self._issues(self.ANN[c]) if j in ks}
            good = sum(1 for c in cids if self.FINAL[c] in ("KEY-GOLDEN", "REAL") and self.ANN[c]["issue"] in ks)
            p, r = good / len(cids), len(raised) / len(ks)
            out[t] = {"recall": 100 * r, "p_strict": 100 * p, "f1_strict": 100 * f1(p, r)}
        return out

    def judge(self, t) -> dict:
        """Martian's own credit under the primary judge (re-judged tools): goldens credited, by quality."""
        k = REJUDGED[t]
        cred = set()
        for pr in self.TUNE:
            gtext = {g["comment"]: gid(pr, i) for i, g in enumerate(self.bd[pr]["golden_comments"])}
            for x in (self.ge[pr].get(k) or {}).get("true_positives") or []:
                cred.add(gtext[x["golden_comment"]])
        by = collections.Counter(self.GQ[g] for g in cred)
        return {"credited": len(cred), **{q: by[q] for q in QUALITY}, "not_valid": len(cred) - by["valid"]}


def compute(root: Path) -> dict:
    e = Ext(root)
    quality = collections.Counter(e.GQ.values())
    out = {"candidates": len(e.S), "tools": len(TOOLS), "prs": len(e.TUNE), "goldens": len(e.GQ),
           "golden_quality": dict(quality), "not_valid_goldens": len(e.GQ) - quality["valid"],
           "key": len(e.key), "valid": len(e.VALID), "unlisted": len(e.KEYREAL),
           "tool": {t: e.tool(t) for t in TOOLS}}
    only_qr = [k for k in e.KEYREAL if e.SRC[k] == {"quickreview"}]
    out["unlisted_only_quickreview"] = len(only_qr)
    out["unlisted_only_quickreview_by_severity"] = dict(collections.Counter(e.KEYREAL[k].get("severity") for k in only_qr))
    out["sensitivity"] = {
        "full": e.variant(lambda k: True),
        "medium_high": e.variant(lambda k: e.KEYREAL[k].get("severity") in ("medium", "high")),
        "two_tools": e.variant(lambda k: len(e.SRC[k]) >= 2),
        "not_quickreview_alone": e.variant(lambda k: len(e.SRC[k] - {"quickreview"}) >= 1),
        "valid_only": e.variant(lambda k: False)}
    others = [t for t in TOOLS if t != "quickreview"]
    out["next_raised"] = max(out["tool"][t]["raised"] for t in others)
    out["next_recall"] = max(out["tool"][t]["recall"] for t in others)
    out["best_other_f1_strict"] = max(out["tool"][t]["f1_strict"] for t in others)
    out["best_other_f1_lenient"] = max(out["tool"][t]["f1_lenient"] for t in others)
    out["judge"] = {t: e.judge(t) for t in REJUDGED}
    out["valid_disposition"] = dict(collections.Counter(r["D"] for r in e.rows if r["q"] == "valid"))
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--archive", required=True)
    ap.add_argument("--data", required=True)
    ap.add_argument("--work", default=os.path.join(os.environ.get("TMPDIR", "."), "martian-ext"))
    ap.add_argument("--json")
    a = ap.parse_args()
    root = open_archive(a.archive, a.work, volumes_for(load_table(a.data, "runs"), ["analysis", SCORING]))
    res = compute(root)
    print(json.dumps(res, indent=1))
    if a.json:
        Path(a.json).write_text(json.dumps(res, indent=1) + "\n")


if __name__ == "__main__":
    main()
