#!/usr/bin/env python3
"""Export the benchmark's tables to a Hugging Face dataset directory.

    uv run --no-project --with pyarrow --with datasets python bench/aacr/hf_export.py \\
        --runs-dir <runs dir>/runs \\
        --aacr-dataset <AACR-Bench v1.0 dataset/positive_samples.json> \\
        --out <runs dir>/release/hf-dataset \\
        --repo-id <org>/<name> [--archive-url URL] [--no-figures] [--no-load-check]

What it writes (no model call, nothing uploaded; the run dirs are only read):

  data/<config>.parquet  one file per config, one `test` split each (README.md
                         YAML maps them): the AACR-derived key (prs, defects,
                         exclusions), AACR's own references and our labels of
                         them, every reviewer arm the papers report (arms,
                         reviews, defect_verdicts, comment_verdicts,
                         aacr_matches), and the Martian and Qodo benchmarks'
                         goldens, reviews and verdicts.
  figures/, keys/, reports/   the generated artefacts kept out of git:
                         the charts (the earlier study's re-drawn under the
                         public name), the rendered keys and FULL-BENCHMARK.
  README.md (the card, from hf/card.md), LICENSE (Apache-2.0), NOTICE,
  validation.json        every count and headline number recomputed FROM THE
                         WRITTEN TABLES, against the papers' values.

Third-party text: AACR reference comments (Apache-2.0), Martian golden
comments (MIT) and Qodo's issues (MIT) are copied; vendor bot comments (the
Copilot 2025 harvest, the Martian vendors re-judged, Qodo's nine vendors) are
LINKS ONLY — a review row carries the source URL and the comment locations,
never their text. Every exported string goes through `scrub` (SCRUB_RULES), and
the card states the rewrite.

Scoring is compare.py's own (imported): an arm is a list of run dirs, a PR is
scored from the FIRST run that has a usable judgement for it, a partial find
counts 1/2, and the $ and minutes are compare.usd_and_minutes. The pure helpers
(scrub, review_for_judge, the arm registry, the metric functions) need only the
standard library, so tests import them without pyarrow.
"""
from __future__ import annotations

import argparse
import collections
import glob
import hashlib
import json
import os
import re
import shutil
import statistics
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "ext"))
import compare  # noqa: E402

SETS = ("smoke10", "dev10", "holdout10", "fresh10", "rest145")
AACR_V1_SHA256 = "d8683cb240249bc4e0aff6428802bdffa7b7573ace600552cab1cd0cb7e905c9"
QODO_GT_SHA256 = "2f0448ed1f9a55bea14039961d8d9e610ee8885b37559b80f5821f3f70cfe64d"
PRIMARY = "gpt-6-sol-high"
SECOND = "claude-opus-5-5"
SELFCONS = "wpself-gpt-6-sol-high"  # the primary judge re-run (no key-version prefix)
JUDGE_LABELS = {PRIMARY: "gpt-6-sol-high", SECOND: "claude-opus-5-5", SELFCONS: "gpt-6-sol-high-repeat"}

# ---------------------------------------------------------------------------
# The scrub (spellings shared with the run archive, export_runs.py). Order
# matters: the longer spellings first. One name, one placeholder, everywhere.
# ---------------------------------------------------------------------------

# the exporting host's home directory: $QCR_SCRUB_HOME, default this user's home
_HOME_RX = re.escape(os.environ.get("QCR_SCRUB_HOME", os.path.expanduser("~")).rstrip("/"))
# the repo checkout and the bench runs dir: $QCR_SCRUB_REPO_DIR (default: this
# checkout, a worktree resolved to its main checkout) and $QCR_SCRUB_RUNS_DIR
# (default: `qcr-bench-runs` beside that checkout)
_REPO_DIR = os.environ.get(
    "QCR_SCRUB_REPO_DIR",
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))).split("/.claude/worktrees/")[0],
).rstrip("/")
_RUNS_DIR = os.environ.get("QCR_SCRUB_RUNS_DIR", os.path.join(os.path.dirname(_REPO_DIR), "qcr-bench-runs")).rstrip("/")

SCRUB_RULES: list[tuple[str, str, str]] = [
    # (label, regex, replacement)
    ("host path: runs dir", re.escape(_RUNS_DIR), "<runs>"),
    ("host path: repo checkout", re.escape(_REPO_DIR), "<repo>"),
    ("host path: home", _HOME_RX + r"\b", "<home>"),
    ("host volume: pi login", r"companion-pihome", "<pi-login-volume>"),
    ("review bot", r"example-review\[bot\]", "<review-bot>"),
    ("review bot (bare)", r"example-review\b", "<review-bot>"),
    ("old product name", r"quickreviewd", "quickreview"),
    ("owner", r"the owner", "<owner>"),
    ("owner (other case)", r"(?i)<owner>", "<owner>"),
]
_SCRUB = [(label, re.compile(rx), rep) for label, rx, rep in SCRUB_RULES]


def scrub(text, counts: collections.Counter | None = None):
    """Apply SCRUB_RULES to one string (anything else is returned as is)."""
    if not isinstance(text, str):
        return text
    for label, rx, rep in _SCRUB:
        text, n = rx.subn(rep, text)
        if n and counts is not None:
            counts[label] += n
    return text


def scrub_obj(obj, counts: collections.Counter | None = None):
    """scrub() over every string in a JSON-shaped value (keys included)."""
    if isinstance(obj, str):
        return scrub(obj, counts)
    if isinstance(obj, list):
        return [scrub_obj(x, counts) for x in obj]
    if isinstance(obj, dict):
        return {scrub(k, counts): scrub_obj(v, counts) for k, v in obj.items()}
    return obj


# ---------------------------------------------------------------------------
# The review the defect judge read — a port of src/bench/defects.ts
# `reviewForJudge`, so comment ids C1..Cn line up with the verdict files.
# ---------------------------------------------------------------------------

TAG_RE = re.compile(r"^\s*\[([a-z][a-z ]*)\]\s*", re.I)
FOOTER_RE = re.compile(r"\n*_P\d[^\n]*_\s*$")


def _read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _claude_rows(result):
    """src/bench/claudeshape.ts claudeRowsForJudge."""
    if not isinstance(result, dict) or "review_output" not in result:
        return None
    rows = []
    out = result.get("review_output")
    for f in out if isinstance(out, list) else []:
        if not isinstance(f, dict):
            continue
        s = f["summary"].strip() if isinstance(f.get("summary"), str) else ""
        fs = f["failure_scenario"].strip() if isinstance(f.get("failure_scenario"), str) else ""
        note = "\n".join(x for x in (s, fs) if x).strip()
        if not note:
            continue
        line = f["line"] if isinstance(f.get("line"), (int, float)) and not isinstance(f.get("line"), bool) else None
        rows.append({"path": f["file"] if isinstance(f.get("file"), str) else "", "start_line": line,
                     "end_line": line, "content": note})
    return rows


def _num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def review_for_judge(run_dir: str, iid: str) -> list[dict]:
    """The comments as the judge numbered them: the scored result file's rows,
    then the posted comments on DELETED lines (side LEFT) appended last."""
    scored = _read_json(os.path.join(run_dir, "results", "all", f"{iid}.json"))
    rows = None
    if isinstance(scored, dict):
        rows = (scored.get("review") or {}).get("comments") if isinstance(scored.get("review"), dict) else None
    if rows is None:
        rows = _claude_rows(scored) or []
    out = []
    for r in rows:
        r = r if isinstance(r, dict) else {}
        raw = r.get("content") if isinstance(r.get("content"), str) else ""
        if not raw.strip():
            continue
        m = TAG_RE.match(raw)
        line = _num(r.get("start_line"))
        end = _num(r.get("end_line"))
        out.append({"id": f"C{len(out) + 1}", "path": r.get("path") if isinstance(r.get("path"), str) else None,
                    "line": line, "end_line": end if end is not None else line, "deleted_line": False,
                    "tag": m.group(1).lower() if m else None,
                    "text": FOOTER_RE.sub("", TAG_RE.sub("", raw, count=1)).strip()})
    posted = _read_json(os.path.join(run_dir, "cases", iid, "comments.json"))
    for r in posted if isinstance(posted, list) else []:
        r = r if isinstance(r, dict) else {}
        if not isinstance(r.get("side"), str) or r["side"].upper() != "LEFT":
            continue
        raw = r.get("body") if isinstance(r.get("body"), str) else ""
        if not raw.strip():
            continue
        m = TAG_RE.match(raw)
        line = _num(r.get("line"))
        out.append({"id": f"C{len(out) + 1}", "path": r.get("path") if isinstance(r.get("path"), str) else None,
                    "line": line, "end_line": line, "deleted_line": True,
                    "tag": m.group(1).lower() if m else None,
                    "text": FOOTER_RE.sub("", TAG_RE.sub("", raw, count=1)).strip()})
    return out


CREDIT = {"found": 1.0, "partial": 0.5}


def credit(verdict: str | None) -> float:
    return CREDIT.get(verdict or "missed", 0.0)


# ---------------------------------------------------------------------------
# The arms the papers report. Display names are the papers'; `runs` is
# compare.py's NAME=run,run,... (first judged run per PR wins).
# ---------------------------------------------------------------------------

def _sets(prefix: str, sets=SETS) -> list[str]:
    return [f"{prefix}-{s}" for s in sets]


FINAL_IDS = {  # bench/aacr/final/arms.txt name -> arm id
    "QuickReview default": "quickreview-default-g61",
    "QuickReview low": "quickreview-low-g61",
    "pi-review panel (high)": "pireview-panel-high-g61",
    "Claude Code (Opus 5.5)": "claude-code-opus55",
    "open-code-review high": "ocr-high-g61",
    "Codex CLI high": "codex-high-g61",
    "OpenCode native + PR text": "opencode-native-pr-g61",
    "PR-Agent": "pragent-g61",
}
SOL_IDS = {  # bench/aacr/final/arms-gpt6sol.txt name -> arm id
    "QuickReview default": "quickreview-default-sol",
    "QuickReview low": "quickreview-low-sol",
    "open-code-review": "ocr-medium-sol",
    "Codex CLI": "codex-medium-sol",
    "OpenCode": "opencode-bridge-sol",
    "pi-review": "pireview-medium-sol",
    "Claude Code (Opus 5.5)": "claude-code-opus55",
}


def read_arms_file(path: str) -> list[tuple[str, list[str]]]:
    out = []
    for line in open(path):
        line = line.strip()
        if line and "=" in line:
            name, _, runs = line.partition("=")
            out.append((name, runs.split(",")))
    return out


def aacr_arms() -> list[dict]:
    """Every AACR arm, in the order the card lists them."""
    arms: dict[str, dict] = {}

    def add(aid, name, runs, study, tables, scope="all185", **kw):
        if aid in arms:
            arms[aid]["studies"].append(study)
            arms[aid]["paper_tables"] += [t for t in tables if t not in arms[aid]["paper_tables"]]
            if arms[aid]["runs"] != runs:
                raise SystemExit(f"arm {aid}: two run lists")
            return
        arms[aid] = {"arm_id": aid, "benchmark": "aacr", "display_name": name, "runs": runs,
                     "studies": [study], "paper_tables": list(tables), "scope": scope,
                     "link_only": kw.get("link_only", False), "note": kw.get("note", "")}

    add("quickreview-frozen", "QuickReview frozen build (e32f0cf, gpt-6.1-sol)", _sets("final1"),
        "frozen build", ["benchmark: tab:finalbuild", "quickreview: The frozen build"])
    for name, runs in read_arms_file(os.path.join(HERE, "final", "arms.txt")):
        add(FINAL_IDS[name], name, runs, "final comparison (best-shot, gpt-6.1-sol)",
            ["benchmark: tab:final, tab:ci, tab:grades, tab:lang, tab:aacr, tab:costfinal, tab:selection"])
    for name, runs in read_arms_file(os.path.join(HERE, "final", "arms-gpt6sol.txt")):
        add(SOL_IDS[name], name, runs,
            "earlier study (as shipped, gpt-6-sol; two judges)",
            ["benchmark: tab:sol-summary, tab:ci-sol, tab:grades-sol, tab:persets, tab:persets2"])
    add("quickreview-default-sol-rerun", "QuickReview default, gpt-6-sol, current build (9106a64)", _sets("v2-default"),
        "stability: full reproduction", ["benchmark: tab:sol-summary", "quickreview: tab:bm185, tab:stab"])
    add("quickreview-luna", "QuickReview default on gpt-6-luna", _sets("all-luna"),
        "base models", ["quickreview: tab:bm185, tab:bm40"])
    add("quickreview-opus55", "QuickReview default on Claude Opus 5.5 (40 PRs)", _sets("opus", SETS[:4]),
        "base models", ["quickreview: tab:bm40, tab:bmsplit"], scope="runs")
    add("quickreview-max-g61", "QuickReview max preset, gpt-6.1-sol (smoke10 only)", ["g61max-smoke-smoke10"],
        "base models", ["quickreview: max preset anecdote"], scope="runs")
    for k in range(1, 5):
        add(f"quickreview-stab-r{k}", f"QuickReview default, gpt-6-sol, stability run {k}",
            [f"stab-r{k}-{s}" for s in ("dev10", "fresh10", "rest145")], "stability: repeat runs",
            ["benchmark: tab:stab-sol", "quickreview: tab:stab"], scope="runs")
    add("copilot-2025-upstream", "Copilot 2025 (upstream, harvested)", _sets("upstream-copilot2025"),
        "upstream Copilot reviews (not a controlled arm)", ["benchmark: tab:copilot2025"], scope="runs",
        link_only=True, note="Vendor bot comments: text not redistributed; each review row links the original review.")
    fair = [
        ("pireview-high-sol-s40", "pi-review high (S40)", "fair-pireview-high-rest145"),
        ("pireview-prtext-sol-s40", "pi-review high + PR text (S40)", "fair-pireview-prtext-rest145"),
        ("pireview-panel-sol-s40", "pi-review 3-reviewer panel, high (S40)", "fair-pireview-panel-rest145"),
        ("ocr-high-sol-s40", "open-code-review high (S40)", "fair-ocr-high-rest145"),
        ("ocr-prtext-sol-s40", "open-code-review medium + PR text (S40)", "fair-ocr-prtext-rest145"),
        ("opencode-native-sol-s40", "OpenCode native provider (S40)", "fair-opencode-native-rest145"),
        ("opencode-native-pr-sol-s40", "OpenCode native + PR text (S40)", "fair-opencode-prtext-rest145"),
        ("codex-high-sol-s40", "Codex CLI high (S40)", "fair-codex-high-rest145"),
        ("codex-prtext-sol-s40", "Codex CLI medium + PR text (S40)", "fair-codex-prtext-rest145"),
        ("pragent-sol-s40", "PR-Agent on gpt-6-sol (S40)", "fair-pragent-sol-rest145"),
        ("pragent-g61-s40", "PR-Agent on gpt-6.1-sol (S40)", "fair-pragent-g61-rest145"),
    ]
    for aid, name, run in fair:
        add(aid, name, [run], "best-shot selection on S40 (gpt-6-sol unless named)",
            ["benchmark: tab:bestshot, tab:transfer"], scope="runs")
    return list(arms.values())


def qodo_effective(lines) -> list[dict]:
    """The pass-1 judgement per (PR, tool) that qodo_judge.py scores from its
    append-only judgements.jsonl: the last record without an error, else the
    last record. A retry appends its replacement and never removes the errored
    record, so reading every line would export a review twice."""
    best: dict[tuple[str, str], dict] = {}
    for line in lines:
        if not line.strip():
            continue
        j = json.loads(line)
        if j["pass"] != 1:
            continue
        k = (j["pr"], j["tool"])
        prev = best.get(k)
        if prev is None or "error" in prev["meta"] or "error" not in j["meta"]:
            best[k] = j
    return list(best.values())


# ---------------------------------------------------------------------------
# Metrics over the exported rows (the validation recomputes from the tables).
# ---------------------------------------------------------------------------

def defect_summary(verdict_rows: list[dict], defects: dict[tuple[str, str], str], prs: set[str] | None = None) -> dict:
    """Found / by severity / weighted over every key defect of `prs` (all key
    PRs when None); a defect with no verdict row counts as missed."""
    found, total = collections.Counter(), collections.Counter()
    got = {(r["instance_id"], r["defect_id"]): credit(r["verdict"]) for r in verdict_rows}
    for (iid, did), sev in defects.items():
        if prs is not None and iid not in prs:
            continue
        total[sev] += 1
        found[sev] += got.get((iid, did), 0.0)
    W = compare.W
    f, n = sum(found.values()), sum(total.values())
    wt = sum(W[s] * found[s] for s in W) / max(sum(W[s] * total[s] for s in W), 1)
    return {"found": f, "total": n, "recall": f / n if n else 0.0, "high": found["high"], "medium": found["medium"],
            "low": found["low"], "weighted": wt}


def correct_share(comment_rows: list[dict]) -> float:
    c = collections.Counter(r["grade"] for r in comment_rows)
    return (c["correct-valuable"] + c["correct-minor"]) / max(sum(c.values()), 1)


def rpf(found: float, total: float, generated: float) -> tuple[float, float, float]:
    r = found / total if total else 0.0
    p = found / generated if generated else 0.0
    return r, p, (2 * p * r / (p + r) if p + r else 0.0)


# ---------------------------------------------------------------------------
# Reading the runs (only under main; needs the runs dir).
# ---------------------------------------------------------------------------

class Exporter:
    def __init__(self, a):
        self.a = a
        self.runs_dir = os.path.abspath(os.path.expanduser(a.runs_dir))
        self.counts = collections.Counter()
        self.notes: list[str] = []
        self.tables: dict[str, list[dict]] = {}
        self.aacr_judges: dict[str, str] = {}
        self.key = {}  # iid -> {"set", "version", "case"}
        for s in SETS:
            d = json.load(open(os.path.join(HERE, "defects", f"{s}.json")))
            for iid, c in d["cases"].items():
                self.key[iid] = {"set": s, "version": d["version"], "case": c}

    def S(self, v):
        return scrub_obj(v, self.counts)

    # --- the key -----------------------------------------------------------
    def build_key(self):
        sel40 = set(open(os.path.join(HERE, "final", "select40.txt")).read().strip().split(":", 1)[1].split(","))
        meta = {}
        for s in SETS:
            for c in json.load(open(os.path.join(HERE, "sets", f"{s}.json")))["cases"]:
                meta[c["instance_id"]] = c
        prs, defects, excl = [], [], []
        for iid, k in self.key.items():
            m, c = meta[iid], k["case"]
            sev = collections.Counter(x["severity"] for x in c["defects"])
            prs.append({
                "instance_id": iid, "set": k["set"], "key_version": str(k["version"]), "repo": m["repo"],
                "pr_number": m["pr"], "pr_url": m["pr_url"], "base_commit": m["base_commit"],
                "head_commit": m["head_commit"], "language": m["language"], "pr_category": m["pr_category"],
                "change_line_count": m["change_line_count"], "aacr_references": m["references"],
                "in_s40": iid in sel40, "pr_summary": self.S(c.get("pr_summary")),
                "defects": len(c["defects"]), "defects_high": sev["high"], "defects_medium": sev["medium"],
                "defects_low": sev["low"], "exclusions": len(c["excluded"]),
                "repo_license": REPO_LICENSES[m["repo"]][0], "repo_license_note": REPO_LICENSES[m["repo"]][1],
            })
            for x in c["defects"]:
                p = x.get("provenance") or {}
                hunt = p.get("hunt")
                bdr = x.get("bot_derived_reference")
                defects.append(self.S({
                    "instance_id": iid, "set": k["set"], "key_version": str(k["version"]), "defect_id": x["id"],
                    "title": x["title"], "statement": x["statement"], "kind": x["kind"], "severity": x["severity"],
                    "sites": [{"path": st["path"], "from_line": st["from_line"], "to_line": st["to_line"],
                               "role": st.get("role")} for st in x["sites"]],
                    "evidence": x["evidence"], "counts_if": x.get("notes"),
                    "provenance_hunt": bool(hunt), "provenance_hunt_refs": [str(h) for h in hunt] if isinstance(hunt, list) else [],
                    "provenance_dataset_refs": [str(r) for r in p.get("dataset_refs") or []],
                    "provenance_reviewer_comments": [str(r) for r in p.get("reviewer_comments") or []],
                    "provenance_added_in": p.get("added_in"),
                    "benchmark_limitation": x.get("benchmark_limitation"),
                    "bot_derived_reference": json.dumps(bdr, ensure_ascii=False) if bdr else None,
                    "repo": m["repo"], "head_commit": m["head_commit"],
                }))
            for j, e in enumerate(c["excluded"]):
                excl.append(self.S({"instance_id": iid, "set": k["set"], "key_version": str(k["version"]),
                                    "index": j, "source": e["source"], "reason": e["reason"]}))
        self.tables["prs"], self.tables["defects"], self.tables["exclusions"] = prs, defects, excl

    def build_references(self):
        raw = open(self.a.aacr_dataset, "rb").read()
        if hashlib.sha256(raw).hexdigest() != AACR_V1_SHA256:
            raise SystemExit("--aacr-dataset is not AACR-Bench v1.0 (sha256 mismatch)")
        from select_cases import case_of
        bots = json.load(open(os.path.join(HERE, "bot_references.json")))["references"]
        refs = []
        for rec in json.loads(raw):
            iid = case_of(rec)["instance_id"]
            if iid not in self.key:
                continue
            for j, c in enumerate(rec.get("comments") or []):
                key = compare.note_key(c["path"], c["from_line"], c["to_line"], c["note"])
                b = (bots.get(iid) or {}).get(key)
                refs.append(self.S({
                    "instance_id": iid, "set": self.key[iid]["set"], "ref_index": j, "ref_key": key,
                    "path": c["path"], "from_line": c["from_line"], "to_line": c["to_line"], "side": c.get("side"),
                    "note": c["note"], "category": c.get("category"), "context": c.get("context"),
                    "is_ai_comment": c.get("is_ai_comment"), "source_model": c.get("source_model"),
                    "bot_derived": b is not None, "bot": (b or {}).get("bot"), "bot_overlap": (b or {}).get("overlap"),
                }))
        self.tables["aacr_references"] = refs
        labels = []
        for s in ("smoke10", "dev10", "holdout10"):
            lab = json.load(open(os.path.join(HERE, "sets", f"{s}.labels.json")))
            for iid, rows in lab["labels"].items():
                for j, r in enumerate(rows):
                    cand = [x["ref_key"] for x in refs if x["instance_id"] == iid and x["path"] == r["path"]
                            and x["from_line"] == r["from_line"]]
                    labels.append(self.S({
                        "instance_id": iid, "set": s, "index": j, "path": r["path"], "from_line": r["from_line"],
                        "ref_key": cand[0] if len(set(cand)) == 1 else None, "reality": r["reality"],
                        "value": r.get("value"), "reason": r.get("reason"), "miss_reason": r.get("miss_reason"),
                        "label_source": lab.get("source"),
                    }))
        self.tables["aacr_reference_labels"] = labels

    # --- reviews and verdicts ---------------------------------------------
    def arm_cases(self, arm) -> list[str]:
        if arm["scope"] == "all185":
            return list(self.key)
        seen = []
        for run in arm["runs"]:
            d = os.path.join(self.runs_dir, run, "cases")
            for iid in sorted(os.listdir(d)) if os.path.isdir(d) else []:
                if iid in self.key and iid not in seen:
                    seen.append(iid)
        return seen

    def judgement(self, run, iid, label):
        v = self.key[iid]["version"]
        sub = label if label == SELFCONS else f"v{v}-{label}"
        f = os.path.join(self.runs_dir, run, "judge", sub, f"{iid}.r1.json")
        j = _read_json(f)
        if not isinstance(j, dict) or j.get("error"):
            return None
        return j

    def build_aacr_reviews(self):
        arms = aacr_arms()
        reviews, dv, cv, matches = [], [], [], []
        mismatched = []
        for arm in arms:
            aacr_rows = self.aacr_metric(arm)
            for iid in self.arm_cases(arm):
                src = next((r for r in arm["runs"] if self.judgement(r, iid, PRIMARY)), None)
                if src is None:
                    src = next((r for r in arm["runs"] if os.path.isdir(os.path.join(self.runs_dir, r, "cases", iid))), None)
                    judged = False
                else:
                    judged = True
                case_dir = os.path.join(self.runs_dir, src, "cases", iid) if src else None
                summary = _read_json(os.path.join(case_dir, "case-summary.json")) if case_dir else None
                summary = summary if isinstance(summary, dict) else {}
                comments = review_for_judge(os.path.join(self.runs_dir, src), iid) if src else []
                body = None
                if case_dir and os.path.exists(os.path.join(case_dir, "review.md")):
                    body = open(os.path.join(case_dir, "review.md")).read().strip() or None
                usd, mins = compare.usd_and_minutes(case_dir) if case_dir else (None, None)
                source_url = None
                if arm["link_only"]:
                    body = None
                    m = self.key[iid]
                    pr_url = next(c["pr_url"] for c in json.load(open(os.path.join(HERE, "sets", f"{m['set']}.json")))["cases"]
                                  if c["instance_id"] == iid)
                    ids = [r.get("id") for r in summary.get("reviews") or [] if r.get("id")]
                    source_url = " ".join(f"{pr_url}#pullrequestreview-{i}" for i in ids) or pr_url
                    for c in comments:
                        c["text"] = None
                a_ref = aacr_rows.get(iid)
                judged_by = [JUDGE_LABELS[lb] for lb in (PRIMARY, SECOND, SELFCONS) if src and self.judgement(src, iid, lb)]
                reviews.append(self.S({
                    "arm_id": arm["arm_id"], "instance_id": iid, "set": self.key[iid]["set"], "run": src,
                    "judged": judged, "status": summary.get("status"), "verdict": summary.get("verdict"),
                    "body": body, "comments": comments, "n_comments": len(comments),
                    "cost_usd": usd, "minutes": mins, "source_url": source_url,
                    "aacr_scored_comments": a_ref["generated"] if a_ref else None,
                    "judged_by": judged_by,
                }))
                if a_ref:
                    for key, share in sorted(a_ref["refs"].items()):
                        matches.append(self.S({"arm_id": arm["arm_id"], "instance_id": iid, "ref_key": key,
                                               "match_share": share}))
                if not src:
                    continue
                for label in (PRIMARY, SECOND, SELFCONS):
                    j = self.judgement(src, iid, label)
                    if j is None:
                        continue
                    if label == PRIMARY and len(j.get("comments") or []) != len(comments):
                        mismatched.append(f"{arm['arm_id']}/{iid}: judge {len(j.get('comments') or [])} vs export {len(comments)}")
                    jl = JUDGE_LABELS[label]
                    for d in j.get("defects") or []:
                        dv.append(self.S({"arm_id": arm["arm_id"], "instance_id": iid, "judge": jl,
                                          "key_version": str(self.key[iid]["version"]), "defect_id": d["id"],
                                          "verdict": d.get("verdict"), "credit": credit(d.get("verdict")),
                                          "comment_ids": [str(x) for x in d.get("comments") or []], "why": d.get("why")}))
                    for c in j.get("comments") or []:
                        cv.append(self.S({"arm_id": arm["arm_id"], "instance_id": iid, "judge": jl, "comment_id": c["id"],
                                          "grade": c.get("verdict"), "defect_id": c.get("defect"),
                                          "new_defect": c.get("new_defect"), "why": c.get("why")}))
        if mismatched:
            self.notes.append(f"{len(mismatched)} reviews whose exported comment count differs from the primary judge's: "
                              + "; ".join(mismatched[:20]))
        arm_rows = []
        for arm in arms:
            arm_rows.append(self.S({k: arm[k] for k in ("arm_id", "benchmark", "display_name", "runs", "studies",
                                                        "paper_tables", "scope", "link_only", "note")}
                                   | {"aacr_judge": self.aacr_judges.get(arm["arm_id"])}))
        self.tables["arms"] = arm_rows
        self.tables["reviews"], self.tables["defect_verdicts"] = reviews, dv
        self.tables["comment_verdicts"], self.tables["aacr_matches"] = cv, matches

    def aacr_metric(self, arm) -> dict:
        """compare.aacr per PR: {iid: {"refs": {key: share}, "generated": n}}."""
        out, scored, judges = {}, set(), set()
        for run in arm["runs"]:
            d = os.path.join(self.runs_dir, run, "results", "all")
            rounds = [f for f in sorted(glob.glob(os.path.join(d, "metrics_*_*.json"))) if "average" not in f]
            per = collections.defaultdict(list)
            for f in rounds:
                for inst in (json.load(open(f)).get("eval_res") or []):
                    iid = inst["instance_id"]
                    if iid not in self.key or iid in scored:
                        continue
                    for c in inst.get("comments") or []:
                        key = compare.note_key(c["path"], c["from_line"], c["to_line"], c["note"])
                        per[(iid, key)].append(1 if c.get("semantic_match") else 0)
            got = {k[0] for k in per}
            for (iid, key), v in per.items():
                out.setdefault(iid, {"refs": {}, "generated": 0})["refs"][key] = sum(v) / len(v)
            for iid in got:
                r = _read_json(os.path.join(d, f"{iid}.json")) or {}
                rows = (r.get("review") or {}).get("comments") or r.get("comments") or []
                if not rows and isinstance(r.get("review_output"), list):
                    rows = [x for x in r["review_output"] if isinstance(x, dict) and "\n".join(
                        p for p in [(x.get("summary") or "").strip(), (x.get("failure_scenario") or "").strip()] if p)]
                out[iid]["generated"] = len(rows)
            if got and rounds:
                j = os.path.join(self.runs_dir, run, "judge.txt")
                judges.add(open(j).readline().strip() if os.path.exists(j) else "(no judge.txt)")
            scored |= got
        if judges:
            self.aacr_judges[arm["arm_id"]] = scrub(" / ".join(sorted(judges)))
        return out

    # --- Martian --------------------------------------------------------------
    def build_martian(self):
        import martian_real
        work_dirs = [("final1-martian50", {"quickreview": "quickreview-frozen"}),
                     ("final1-ocr-martian50", {}), ("final1-pragent-martian50", {}), ("final1-opencode-martian50", {})]
        main = os.path.join(self.runs_dir, "final1-martian50.martian")
        published = json.load(open(os.path.join(main, "published-benchmark_data.json")))
        goldens = martian_real.buckets(published)
        audit = {}
        for x in json.load(open(os.path.join(HERE, "ext", "martian-tuning", "golden-audit-full.json"))):
            audit[(x["url"], x["idx"])] = x
        mset = {c["martian"]["golden_url"]: c for c in json.load(open(os.path.join(HERE, "sets", "martian50.json")))["cases"]}
        prs, gold = [], []
        for u in sorted(published):
            p = published[u]
            c = mset.get(u, {})
            prs.append(self.S({"pr_url": u, "instance_id": c.get("instance_id"), "repo": c.get("repo"),
                               "source_repo": p.get("source_repo"), "title": p.get("pr_title"),
                               "base_commit": c.get("base_commit"), "head_commit": c.get("head_commit"),
                               "language": c.get("language"), "goldens": len(p["golden_comments"])}))
            for i, g in enumerate(p["golden_comments"]):
                au = audit.get((u, i)) or {}
                gold.append(self.S({
                    "pr_url": u, "golden_index": i, "comment": g["comment"], "severity": g.get("severity"),
                    "category": g.get("category"), "audit_bucket": goldens[(u, i)]["bucket"],
                    "audit_split": au.get("split"),
                    "audit_first_verdict": (au.get("first") or {}).get("verdict"),
                    "audit_second_verdict": (au.get("second") or {}).get("verdict"),
                    "audit_evidence": (au.get("first") or {}).get("evidence"),
                    "audit_strongest_case": (au.get("first") or {}).get("strongest_case_for_golden"),
                }))
        reviews, verdicts, scores = [], [], []
        set_by_url = {c["martian"]["golden_url"]: c["instance_id"] for c in mset.values()}
        for work, rename in work_dirs:
            wd = os.path.join(self.runs_dir, work + ".martian")
            evals = json.load(open(os.path.join(wd, "results", "gpt-6.1-sol", "evaluations.json")))
            bench = json.load(open(os.path.join(wd, "results", "benchmark_data.json")))
            ms = json.load(open(os.path.join(wd, "martian-scores.json")))
            for tool, sc in ms["this_run"]["scores"].items():
                scores.append({"tool": rename.get(tool, tool), "judge": "gpt-6.1-sol", "work_dir": work,
                               **{f"{prof}_{k}": v.get(k) for prof, v in sc.items() for k in ("precision", "recall", "f1", "f2", "tp", "fp", "fn")}})
            if work == "final1-martian50":
                for judge, by in ms["published"].items():
                    for tool, sc in by["scores"].items():
                        scores.append({"tool": tool, "judge": f"published: {judge}", "work_dir": None,
                                       **{f"{prof}_{k}": v.get(k) for prof, v in sc.items() for k in ("precision", "recall", "f1", "f2", "tp", "fp", "fn")}})
            for u in sorted(evals):
                for tool, e in evals[u].items():
                    vendor = tool.startswith("rejudged-")
                    name = rename.get(tool, tool)
                    rv = next((r for r in bench[u]["reviews"] if r["tool"] == tool), {})
                    iid = set_by_url.get(u)
                    usd = mins = None
                    if not vendor and iid:
                        usd, mins = compare.usd_and_minutes(os.path.join(self.runs_dir, work, "cases", iid))
                    comments = [] if vendor else [{"path": c.get("path"), "line": c.get("line"), "body": c.get("body")}
                                                  for c in rv.get("review_comments") or []]
                    reviews.append(self.S({
                        "tool": name, "pr_url": u, "work_dir": work, "vendor_link_only": vendor,
                        "source_url": rv.get("pr_url") if vendor else None, "comments": comments,
                        "n_comments": len(rv.get("review_comments") or []),
                        "extracted_candidates": e.get("total_candidates"),
                        "unmatched_candidates": None if vendor else [fp.get("candidate") for fp in e.get("false_positives") or []],
                        "tp": e.get("tp"), "fp": e.get("fp"), "fn": e.get("fn"), "skipped": e.get("skipped"),
                        "cost_usd": usd, "minutes": mins,
                    }))
                    hit = {}
                    for tp in e.get("true_positives") or []:
                        idx = next(i for (uu, i), v in goldens.items() if uu == u and v["text"] == tp["golden_comment"])
                        hit[idx] = tp
                    for (uu, i), v in goldens.items():
                        if uu != u:
                            continue
                        tp = hit.get(i)
                        verdicts.append(self.S({
                            "tool": name, "pr_url": u, "judge": "gpt-6.1-sol", "golden_index": i, "matched": tp is not None,
                            "confidence": (tp or {}).get("confidence"),
                            "matched_candidate": None if vendor else (tp or {}).get("matched_candidate"),
                            "reasoning": (tp or {}).get("reasoning"),
                        }))
        self.tables["martian_prs"], self.tables["martian_goldens"] = prs, gold
        self.tables["martian_reviews"], self.tables["martian_verdicts"] = reviews, verdicts
        self.tables["martian_scores"] = [self.S(s) for s in scores]

    # --- Qodo -----------------------------------------------------------------
    def build_qodo(self):
        raw = open(self.a.qodo_gt, "rb").read()
        if hashlib.sha256(raw).hexdigest() != QODO_GT_SHA256:
            raise SystemExit("--qodo-gt is not the pinned Qodo PR-Review-Bench file (sha256 mismatch)")
        gt = {r["pr_url_to_review"]: r for r in map(json.loads, raw.decode().splitlines()) if r}
        qset = json.load(open(os.path.join(HERE, "sets", "qodo-pr100.json")))["cases"]
        forks = {r["pr_url"]: r["tools"] for r in json.load(open(self.a.qodo_tools))}
        prs, issues = [], []
        for c in qset:
            g = gt[c["pr_url"]]
            prs.append(self.S({"pr_url": c["pr_url"], "instance_id": c["instance_id"], "repo": c["repo"],
                               "title": c.get("title"), "base_commit": c["base_commit"], "head_commit": c["head_commit"],
                               "language": c.get("language"), "issues": len(g["issues"])}))
            for i, x in enumerate(g["issues"]):
                issues.append(self.S({"pr_url": c["pr_url"], "issue_index": i, "title": x.get("title"),
                                      "description": x.get("description"), "file_path": x.get("file_path"),
                                      "start_line": x.get("start_line"), "end_line": x.get("end_line"),
                                      "problematic_code_snippet": x.get("problematic_code_snippet"),
                                      "rule_name": x.get("rule_name"), "functional": not x.get("rule_name")}))
        import qodo_judge
        work = [("ext-r6-qodo-pr100", {"quickreview": "quickreview-2026-10-02"}, "ext-r6-qodo-pr100"),
                ("final1-qodo-pr100", {"quickreview": "quickreview-frozen"}, "final1-qodo-pr100"),
                ("final1-ocr-qodo-pr100", {}, "final1-ocr-qodo-pr100"),
                ("final1-opencode-qodo-pr100", {}, "final1-opencode-qodo-pr100"),
                ("final1-pragent-qodo-pr100", {}, "final1-pragent-qodo-pr100")]
        by_url = {c["pr_url"]: c for c in qset}
        reviews, verdicts = [], []
        for wd, rename, run in work:
            for j in qodo_effective(open(os.path.join(self.runs_dir, wd + ".qodo", "judgements.jsonl"))):
                tool = j["tool"]
                vendor = tool in qodo_judge.VENDORS
                name = rename.get(tool, tool)
                url = j["pr"]
                usd = mins = None
                if not vendor:
                    usd, mins = compare.usd_and_minutes(os.path.join(self.runs_dir, run, "cases", by_url[url]["instance_id"]))
                f = (forks.get(url) or {}).get(tool)
                cms = j.get("comments") or []
                reviews.append(self.S({
                    "tool": name, "pr_url": url, "work_dir": wd, "vendor_link_only": vendor,
                    "source_url": f"https://github.com/agentic-review-benchmarks/{f['fork']}/pull/{f['pr']}" if vendor and f else None,
                    "comments": [{"index": k, "path": c.get("path"), "start": c.get("start"), "end": c.get("end"),
                                  "body": None if vendor else c.get("body")} for k, c in enumerate(cms)],
                    "n_comments": j["n_comments"], "cost_usd": usd, "minutes": mins,
                }))
                iss = gt[url]["issues"]
                by_issue = {m["issue"]: m for m in j["matches"]}
                for i, x in enumerate(iss):
                    m = by_issue.get(i)
                    cm = cms[m["comment"]] if m else None
                    verdicts.append(self.S({
                        "tool": name, "pr_url": url, "work_dir": wd, "judge": "gpt-6.1-sol", "issue_index": i,
                        "matched": m is not None, "comment_index": m["comment"] if m else None,
                        "located_n5": bool(cm) and qodo_judge.located(cm, x, 5),
                        "located_same_file": bool(cm) and qodo_judge.located(cm, x, float("inf")),
                        "why": m.get("why") if m else None,
                    }))
        self.tables["qodo_prs"], self.tables["qodo_issues"] = prs, issues
        self.tables["qodo_reviews"], self.tables["qodo_verdicts"] = reviews, verdicts


# SPDX per reviewed repo. Code excerpts in `defects`
# (evidence, sites) stay under these licences.
_L = {
    "Apache-2.0": "ClickHouse/ClickHouse alibaba/spring-ai-alibaba cline/cline dbeaver/dbeaver gofr-dev/gofr "
                  "google-gemini/gemini-cli infiniflow/ragflow juspay/hyperswitch kestra-io/kestra keycloak/keycloak "
                  "linera-io/linera-protocol microsoft/typescript-go openai/codex opencv/opencv vllm-project/vllm "
                  "wavetermdev/waveterm",
    "MIT": "PowerShell/PowerShell bitcoin/bitcoin browser-use/browser-use dotnet/aspnetcore electron/electron "
           "facebook/react filamentphp/filament langflow-ai/langflow laravel/framework lvgl/lvgl microsoft/PowerToys "
           "microsoft/semantic-kernel mrdoob/three.js mudler/LocalAI nodejs/node ollama/ollama ppy/osu "
           "sveltejs/svelte symfony/symfony",
    "MIT OR Apache-2.0": "astral-sh/uv unionlabs/union",
    "BSD-3-Clause": "appwrite/appwrite valkey-io/valkey",
    "Zlib": "libsdl-org/SDL",
    "LGPL-2.0-or-later": "FreeCAD/FreeCAD",
    "GPL-2.0-or-later": "mpv-player/mpv",
    "GPL-3.0": "comfyanonymous/ComfyUI",
    "AGPL-3.0-or-later": "bluewave-labs/Checkmate immich-app/immich nextcloud/server",
}
REPO_LICENSES = {r: (lic, "") for lic, rs in _L.items() for r in rs.split()}
REPO_LICENSES.update({
    "mpv-player/mpv": ("GPL-2.0-or-later", "LGPL-2.1-or-later build option; both texts shipped"),
    "CherryHQ/cherry-studio": ("LicenseRef-cherry-studio", "source-available: user-segmented AGPL-3.0 / commercial dual licence"),
    "n8n-io/n8n": ("LicenseRef-Sustainable-Use-1.0", "source-available: Sustainable Use License 1.0"),
    "elastic/elasticsearch": ("AGPL-3.0-only OR SSPL-1.0 OR Elastic-2.0", "source-available: x-pack/ is Elastic-2.0 only"),
    "timescale/timescaledb": ("Apache-2.0 AND LicenseRef-Timescale", "source-available: tsl/ is under the Timescale License"),
})


# ---------------------------------------------------------------------------
# Writing, validation, card
# ---------------------------------------------------------------------------

CONFIGS = ["defects", "exclusions", "prs", "aacr_references", "aacr_reference_labels", "arms", "reviews",
           "defect_verdicts", "comment_verdicts", "aacr_matches", "martian_prs", "martian_goldens",
           "martian_reviews", "martian_verdicts", "martian_scores", "qodo_prs", "qodo_issues", "qodo_reviews",
           "qodo_verdicts"]


def write_parquet(tables: dict[str, list[dict]], out: str) -> dict[str, int]:
    import pyarrow as pa
    import pyarrow.parquet as pq
    os.makedirs(os.path.join(out, "data"), exist_ok=True)
    sizes = {}
    for name in CONFIGS:
        rows = tables[name]
        t = pa.Table.from_pylist(rows)
        # A column every row leaves null has no type; make it a string column.
        for i, f in enumerate(t.schema):
            if pa.types.is_null(f.type):
                t = t.set_column(i, f.name, pa.array([None] * len(t), pa.string()))
        p = os.path.join(out, "data", f"{name}.parquet")
        pq.write_table(t, p, compression="zstd")
        sizes[name] = len(rows)
    return sizes


def read_parquet(out: str) -> dict[str, list[dict]]:
    import pyarrow.parquet as pq
    return {n: pq.read_table(os.path.join(out, "data", f"{n}.parquet")).to_pylist() for n in CONFIGS}


def approx(a, b, tol):
    return a is not None and abs(a - b) <= tol


def validate(t: dict[str, list[dict]]) -> list[dict]:
    """Recompute the papers' counts and headline numbers from the written tables."""
    checks = []

    def check(what, got, want, tol=0.0):
        ok = approx(got, want, tol) if tol else got == want
        checks.append({"check": what, "got": got, "want": want, "ok": bool(ok)})

    defects = {(d["instance_id"], d["defect_id"]): d["severity"] for d in t["defects"]}
    sev = collections.Counter(defects.values())
    check("defects", len(t["defects"]), 520)
    check("defects high/medium/low", f"{sev['high']}/{sev['medium']}/{sev['low']}", "90/145/285")
    check("exclusions", len(t["exclusions"]), 3093)
    check("PRs", len(t["prs"]), 185)
    check("AACR references on the 185 PRs", len(t["aacr_references"]), 1418)
    check("bot-derived references", sum(r["bot_derived"] for r in t["aacr_references"]), 80)
    check("labelled references (30 PRs)", len(t["aacr_reference_labels"]), 253)
    indep = sum(1 for d in t["defects"] if d["provenance_hunt"] or d["provenance_dataset_refs"])
    check("defects raised by the hunt or an AACR reference", indep, 369)
    s40 = {p["instance_id"] for p in t["prs"] if p["in_s40"]}
    check("S40 PRs", len(s40), 40)
    check("S40 defects", sum(1 for k in defects if k[0] in s40), 115)

    by_arm = collections.defaultdict(list)
    for r in t["reviews"]:
        by_arm[r["arm_id"]].append(r)
    dv = collections.defaultdict(list)
    for r in t["defect_verdicts"]:
        dv[(r["arm_id"], r["judge"])].append(r)
    cvs = collections.defaultdict(list)
    for r in t["comment_verdicts"]:
        cvs[(r["arm_id"], r["judge"])].append(r)

    def arm(aid, judge="gpt-6-sol-high", prs=None):
        return defect_summary(dv[(aid, judge)], defects, prs)

    def corr(aid, judge="gpt-6-sol-high", prs=None):
        return correct_share([c for c in cvs[(aid, judge)] if prs is None or c["instance_id"] in prs])

    def money(aid, prs=None):
        rs = [r for r in by_arm[aid] if prs is None or r["instance_id"] in prs]
        c = [r["cost_usd"] for r in rs if r["judged"] and r["cost_usd"] is not None]
        m = [r["minutes"] for r in rs if r["judged"] and r["minutes"]]
        return (statistics.mean(c) if c else 0.0), (statistics.median(m) if m else 0.0)

    # benchmark.tex tab:final + tab:finalbuild (found, high, medium, low, correct, $/PR, median min)
    final = {
        "quickreview-frozen": (461, 87.5, 134.5, 239, 0.92, 2.06, 17.5),
        "quickreview-default-g61": (409, 83.5, 121, 204.5, 0.95, 1.36, 9.5),
        "quickreview-low-g61": (365.5, 79.5, 104.5, 181.5, 0.94, 0.88, 6.7),
        "pireview-panel-high-g61": (347.5, 80, 119, 148.5, 0.89, 0.27, 1.8),
        "claude-code-opus55": (324.5, 72.5, 105, 147, 0.81, 0.20, 0.7),
        "ocr-high-g61": (298.5, 63.5, 102, 133, 0.86, 0.53, 1.8),
        "codex-high-g61": (287, 81, 101.5, 104.5, 0.93, 0.14, 2.1),
        "opencode-native-pr-g61": (263.5, 76, 99, 88.5, 0.93, 0.17, 2.3),
        "pragent-g61": (194, 55.5, 70, 68.5, 0.76, 0.07, 1.9),
    }
    for aid, (f, h, m, lo, c, usd, mins) in final.items():
        s = arm(aid)
        check(f"{aid}: reviews", len(by_arm[aid]), 185)
        check(f"{aid}: judged", sum(r["judged"] for r in by_arm[aid]), 185)
        check(f"{aid}: found/520", s["found"], f, 0.001)
        check(f"{aid}: high/medium/low", f"{s['high']:g}/{s['medium']:g}/{s['low']:g}", f"{h:g}/{m:g}/{lo:g}")
        check(f"{aid}: comments correct", round(corr(aid), 2), c, 0.005)
        mu, md = money(aid)
        check(f"{aid}: $/PR", round(mu, 2), usd, 0.006)
        check(f"{aid}: median min/PR", round(md, 1), mins, 0.06)
    # tab:finalbuild by set
    by_set = collections.defaultdict(set)
    for p in t["prs"]:
        by_set[p["set"]].add(p["instance_id"])
    for aid, (r145, val, out) in {"quickreview-frozen": (356, 59.5, 45.5), "quickreview-default-g61": (321, 49.5, 38.5),
                                  "pireview-panel-high-g61": (270, 38, 39.5)}.items():
        check(f"{aid}: rest145 found/394", arm(aid, prs=by_set["rest145"])["found"], r145, 0.001)
        check(f"{aid}: smoke10+dev10 found/71", arm(aid, prs=by_set["smoke10"] | by_set["dev10"])["found"], val, 0.001)
        check(f"{aid}: holdout10+fresh10 found/55", arm(aid, prs=by_set["holdout10"] | by_set["fresh10"])["found"], out, 0.001)
    # tab:sol-summary — primary and second judge
    sol = {
        "quickreview-default-sol-rerun": (436, 85, 0.88, None, None),
        "quickreview-default-sol": (437.5, 86, 0.86, 439, 0.86),
        "quickreview-low-sol": (345, 75, 0.80, 345.5, 0.82),
        "claude-code-opus55": (324.5, 72.5, 0.81, 321.5, 0.86),
        "pireview-medium-sol": (292.5, 71.5, 0.79, 289.5, 0.79),
        "ocr-medium-sol": (291.5, 64.5, 0.73, 291, 0.77),
        "opencode-bridge-sol": (250, 64.5, 0.55, 249.5, 0.55),
        "codex-medium-sol": (248.5, 70, 0.69, 247, 0.69),
    }
    for aid, (f, h, c, f2, c2) in sol.items():
        s = arm(aid)
        check(f"{aid}: found/520 (primary)", s["found"], f, 0.001)
        check(f"{aid}: high (primary)", s["high"], h, 0.001)
        check(f"{aid}: comments correct (primary)", round(corr(aid), 2), c, 0.005)
        if f2 is not None:
            check(f"{aid}: found/520 (second judge)", arm(aid, "claude-opus-5-5")["found"], f2, 0.001)
            check(f"{aid}: comments correct (second judge)", round(corr(aid, "claude-opus-5-5"), 2), c2, 0.005)
    # judge agreement over the 7 earlier-study arms (benchmark.tex §judge)
    seven = ["quickreview-default-sol", "quickreview-low-sol", "claude-code-opus55", "pireview-medium-sol",
             "ocr-medium-sol", "opencode-bridge-sol", "codex-medium-sol"]
    same = n = 0
    for aid in seven:
        p = {(r["instance_id"], r["defect_id"]): r["verdict"] for r in dv[(aid, "gpt-6-sol-high")]}
        q = {(r["instance_id"], r["defect_id"]): r["verdict"] for r in dv[(aid, "claude-opus-5-5")]}
        for k in defects:
            n += 1
            same += p.get(k, "missed") == q.get(k, "missed")
    check("two judges: same verdict (7 reviewers x 520)", f"{same}/{n}", "3593/3640")
    sc_reviews = {(r["arm_id"], r["instance_id"]) for r in t["reviews"] if "gpt-6-sol-high-repeat" in r["judged_by"]}
    check("self-consistency re-judge: reviews", len({k for k in sc_reviews if k[0] in seven}), 210)
    check("self-consistency re-judge: defect pairs",
          sum(1 for aid in seven for _ in dv[(aid, "gpt-6-sol-high-repeat")]), 637)
    # base models (quickreview.tex tab:bm185 / tab:bm40) and stability
    check("quickreview-luna: found/520", arm("quickreview-luna")["found"], 147, 0.001)
    forty = {r["instance_id"] for r in by_arm["quickreview-opus55"]}
    check("quickreview-opus55: PRs", len(forty), 40)
    check("quickreview-opus55: found/126", arm("quickreview-opus55", prs=forty)["found"], 119.5, 0.001)
    eight = {r["instance_id"] for r in by_arm["quickreview-stab-r1"]}
    for k, f in zip(range(1, 5), (11, 14, 12.5, 11.5)):
        check(f"quickreview-stab-r{k}: found/17", arm(f"quickreview-stab-r{k}", prs=eight)["found"], f, 0.001)
    check("stability: defects on the 8 PRs", sum(1 for d in defects if d[0] in eight), 17)
    # Copilot 2025 (tab:copilot2025)
    cp = {r["instance_id"] for r in by_arm["copilot-2025-upstream"]}
    check("copilot-2025-upstream: PRs", len(cp), 19)
    check("copilot-2025-upstream: found/59", arm("copilot-2025-upstream", prs=cp)["found"], 6.5, 0.001)
    check("copilot-2025-upstream: comment text withheld",
          all(c["text"] is None for r in by_arm["copilot-2025-upstream"] for c in r["comments"]), True)
    # best-shot S40 (tab:bestshot, tab:transfer)
    for aid, f in {"pireview-high-sol-s40": 71, "pireview-prtext-sol-s40": 72.5, "pireview-panel-sol-s40": 78,
                   "ocr-high-sol-s40": 78, "ocr-prtext-sol-s40": 78, "opencode-native-sol-s40": 57,
                   "opencode-native-pr-sol-s40": 69.5, "codex-high-sol-s40": 64, "codex-prtext-sol-s40": 62.5,
                   "pragent-sol-s40": 34.5, "pragent-g61-s40": 39.5}.items():
        check(f"{aid}: found/115", arm(aid, prs=s40)["found"], f, 0.001)
    for aid, f in {"quickreview-default-sol": 98.5, "quickreview-default-sol-rerun": 103, "quickreview-default-g61": 98,
                   "quickreview-low-sol": 77.5, "claude-code-opus55": 68.5, "pireview-medium-sol": 59.5,
                   "ocr-medium-sol": 76, "opencode-bridge-sol": 49, "codex-medium-sol": 51,
                   "pireview-panel-high-g61": 80, "ocr-high-g61": 75.5, "opencode-native-pr-g61": 57.5,
                   "codex-high-g61": 64.5, "quickreview-low-g61": 86.5}.items():
        check(f"{aid}: found on S40/115", arm(aid, prs=s40)["found"], f, 0.001)
    # AACR-Bench's own metric (tab:aacr): references found, comments, F1
    refs_by_pr = collections.Counter(r["instance_id"] for r in t["aacr_references"])
    total_refs = sum(refs_by_pr.values())
    for aid, (fnd, comments, f1) in {"quickreview-default-g61": (151.7, 999, 0.125),
                                     "quickreview-low-g61": (127.3, 801, 0.115),
                                     "pireview-panel-high-g61": (84.7, 583, 0.085),
                                     "claude-code-opus55": (81.0, 407, 0.089),
                                     "ocr-high-g61": (115.3, 570, 0.116), "codex-high-g61": (68.7, 343, 0.078),
                                     "opencode-native-pr-g61": (61.3, 354, 0.069), "pragent-g61": (86.0, 404, 0.094)}.items():
        found = sum(m["match_share"] for m in t["aacr_matches"] if m["arm_id"] == aid)
        gen = sum(r["aacr_scored_comments"] or 0 for r in by_arm[aid])
        check(f"{aid}: AACR references found/1418", round(found, 1), fnd, 0.051)
        check(f"{aid}: AACR scored comments", gen, comments)
        check(f"{aid}: AACR F1", round(rpf(found, total_refs, gen)[2], 3), f1, 0.0006)
    # Martian (tab:martianfinal, tab:martianaudit)
    gold = {(g["pr_url"], g["golden_index"]): g for g in t["martian_goldens"]}
    b = collections.Counter(g["audit_bucket"] for g in gold.values())
    check("martian goldens", len(gold), 173)
    check("martian audit real/notreal/disputed", f"{b['real']}/{b['notreal']}/{b['disputed']}", "86/77/10")
    for tool, real in {"quickreview-frozen": 75, "open-code-review": 67, "pr-agent": 46, "opencode": 48}.items():
        got = sum(1 for v in t["martian_verdicts"] if v["tool"] == tool and v["matched"]
                  and gold[(v["pr_url"], v["golden_index"])]["audit_bucket"] == "real")
        check(f"martian {tool}: real goldens found/86", got, real)
    for tool, (matched, p, r) in {"quickreview-frozen": (104, 0.162, 0.658), "open-code-review": (93, 0.267, 0.589)}.items():
        s = next(x for x in t["martian_scores"] if x["tool"] == tool and x["judge"] == "gpt-6.1-sol")
        check(f"martian {tool}: Core matched/158", s["core_tp"], matched)
        check(f"martian {tool}: Core P", s["core_precision"], p, 0.0006)
        check(f"martian {tool}: Core R", s["core_recall"], r, 0.0006)
    for tool, (usd, mins) in {"quickreview-frozen": (2.84, 26.1), "open-code-review": (0.86, 3.3),
                              "pr-agent": (0.09, 1.4), "opencode": (0.19, 2.4)}.items():
        rs = [x for x in t["martian_reviews"] if x["tool"] == tool]
        check(f"martian {tool}: $/PR", round(statistics.mean(x["cost_usd"] for x in rs if x["cost_usd"] is not None), 2), usd, 0.006)
        check(f"martian {tool}: mean min/PR", round(statistics.mean(x["minutes"] for x in rs if x["minutes"]), 1), mins, 0.06)
    check("martian vendor comment text withheld",
          all(not r["comments"] and r["unmatched_candidates"] is None for r in t["martian_reviews"] if r["vendor_link_only"]), True)
    # Qodo (tab:qodo)
    issues = {(x["pr_url"], x["issue_index"]): x for x in t["qodo_issues"]}
    check("qodo issues", len(issues), 580)
    check("qodo functional / rule", f"{sum(x['functional'] for x in issues.values())}/{sum(not x['functional'] for x in issues.values())}", "309/271")
    qrev = collections.defaultdict(int)
    for r in t["qodo_reviews"]:
        qrev[r["tool"]] += r["n_comments"]
    want = {"qodo-exhaustive": 51.5, "qodo-precise": 47.0, "augment": 41.2, "quickreview-frozen": 40.9,
            "opencode": 40.0, "copilot": 39.1, "greptile": 37.7, "cursor": 36.6, "open-code-review": 35.2,
            "quickreview-2026-10-02": 34.9, "codex": 34.6, "pr-agent": 34.5, "sentry": 21.6, "coderabbit": 21.6}
    for tool, f1 in want.items():
        vs = [v for v in t["qodo_verdicts"] if v["tool"] == tool]
        tp = sum(v["located_n5"] for v in vs)
        func = sum(v["located_n5"] for v in vs if issues[(v["pr_url"], v["issue_index"])]["functional"])
        r, p, f = rpf(tp, len(issues), qrev[tool])
        check(f"qodo {tool}: F1 (N=5)", round(100 * f, 1), f1, 0.051)
        if tool == "quickreview-frozen":
            check("qodo quickreview-frozen: functional recall", round(100 * func / 309, 1), 52.1, 0.051)
    for tool, (usd, mins) in {"quickreview-frozen": (2.48, 19.6), "open-code-review": (0.46, 1.9),
                              "opencode": (0.20, 2.3), "pr-agent": (0.10, 1.2)}.items():
        rs = [x for x in t["qodo_reviews"] if x["tool"] == tool]
        check(f"qodo {tool}: $/PR", round(statistics.mean(x["cost_usd"] for x in rs if x["cost_usd"] is not None), 2), usd, 0.006)
        check(f"qodo {tool}: mean min/PR", round(statistics.mean(x["minutes"] for x in rs if x["minutes"]), 1), mins, 0.06)
    check("qodo vendor comment text withheld",
          all(c["body"] is None for r in t["qodo_reviews"] if r["vendor_link_only"] for c in r["comments"]), True)
    return checks


def leak_scan(out: str) -> dict:
    """Every scrubbed spelling must be gone from every text file written."""
    bad = collections.Counter()
    pats = [re.compile(rx) for _, rx, _ in SCRUB_RULES]
    import pyarrow.parquet as pq
    for n in CONFIGS:
        t = pq.read_table(os.path.join(out, "data", f"{n}.parquet"))
        blob = json.dumps(t.to_pylist(), ensure_ascii=False, default=str)
        for p in pats:
            bad[(n, p.pattern)] += len(p.findall(blob))
    for root, _, files in os.walk(out):
        for f in files:
            if f.endswith((".md", ".json", ".svg")) and f not in ("README.md", "NOTICE"):
                txt = open(os.path.join(root, f), errors="replace").read()
                for p in pats:
                    bad[(os.path.relpath(os.path.join(root, f), out), p.pattern)] += len(p.findall(txt))
    return {f"{k[0]} :: {k[1]}": v for k, v in bad.items() if v}


def figures(a, out: str, counts: collections.Counter, notes: list[str]):
    """Charts, rendered keys, FULL-BENCHMARK. The earlier study's
    charts are re-drawn with the public name; everything textual is scrubbed."""
    fig = os.path.join(out, "figures")
    keys = os.path.join(out, "keys")
    rep = os.path.join(out, "reports")
    for d in (fig, keys, rep):
        os.makedirs(d, exist_ok=True)
    src = os.path.join(HERE, "charts")
    redraw = {f for f in os.listdir(src) if "-gpt6sol" in f} | {"judge-agreement.jpg"}
    for f in sorted(os.listdir(src)):
        if f in redraw:
            continue
        p = os.path.join(src, f)
        if f.endswith((".json", ".svg")):
            open(os.path.join(fig, f), "w").write(scrub(open(p).read(), counts))
        else:
            shutil.copy2(p, os.path.join(fig, f))
    sol = []
    for name, runs in read_arms_file(os.path.join(HERE, "final", "arms-gpt6sol.txt")):
        sol.append(f"{scrub(name).replace('quickreview', 'QuickReview')}={','.join(runs)}")
    with tempfile.TemporaryDirectory() as tmp:
        env = dict(os.environ, QCR_BENCH_RUNS_DIR=a.runs_dir)
        base = ["uv", "run", "--quiet", os.path.join(HERE, "charts.py"), "--cases", "all30+fresh10+rest145", "--runs-dir", a.runs_dir]
        subprocess.run(base + ["--out", tmp, "--suffix=-gpt6sol", "--note",
                               "earlier study: tools as shipped or as the AACR harness runs them · gpt-6-sol except Claude Code (Opus 5.5)"]
                       + sol, check=True, env=env, stdout=subprocess.DEVNULL)
        agree = os.path.join(tmp, "agree")
        subprocess.run(base + ["--out", agree, "--second-judge", SECOND] + sol, check=True, env=env, stdout=subprocess.DEVNULL)
        for f in os.listdir(tmp):
            if "-gpt6sol" in f:
                p = os.path.join(tmp, f)
                if f.endswith(".json"):
                    open(os.path.join(fig, f), "w").write(scrub(open(p).read(), counts))
                else:
                    shutil.copy2(p, os.path.join(fig, f))
        shutil.copy2(os.path.join(agree, "judge-agreement.jpg"), os.path.join(fig, "judge-agreement.jpg"))
    for f in sorted(os.listdir(os.path.join(HERE, "defects"))):
        if f.endswith(".md"):
            open(os.path.join(keys, f), "w").write(scrub(open(os.path.join(HERE, "defects", f)).read(), counts))
    md = scrub(open(os.path.join(HERE, "FULL-BENCHMARK.md")).read(), counts)
    md = md.replace("](charts/", "](../figures/")
    open(os.path.join(rep, "FULL-BENCHMARK.md"), "w").write(md)
    if shutil.which("chromium"):
        html = os.path.join(rep, ".full.html")
        subprocess.run(["uv", "run", "--quiet", "--no-project", "--with", "markdown", "python3", "-c",
                        "import sys, markdown; body = markdown.markdown(open(sys.argv[1]).read(), extensions=['tables']); "
                        "css = \"@page { size: A4; margin: 14mm; } body { font-family: 'DejaVu Sans', sans-serif; font-size: 9pt; } "
                        "img { max-width: 100%; } table { border-collapse: collapse; font-size: 8pt; } th, td { border: 1px solid #ccc; padding: 2px 4px; }\"; "
                        "open(sys.argv[2], 'w').write(f\"<!doctype html><html><head><meta charset='utf-8'><style>{css}</style></head><body>{body}</body></html>\")",
                        os.path.join(rep, "FULL-BENCHMARK.md"), html], check=True)
        subprocess.run(["chromium", "--headless", "--disable-gpu", "--no-sandbox", "--no-pdf-header-footer",
                        f"--print-to-pdf={os.path.join(rep, 'FULL-BENCHMARK.pdf')}", f"file://{html}"],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        os.remove(html)
    else:
        notes.append("chromium not found: reports/FULL-BENCHMARK.pdf not rendered (the .md is there)")


def render_card(a, out: str, sizes: dict, checks: list[dict], counts: collections.Counter):
    tmpl = open(os.path.join(HERE, "hf", "card.md")).read()
    rows = "\n".join(f"| `{n}` | {sizes[n]:,} |" for n in CONFIGS)
    configs_yaml = "\n".join(
        f"- config_name: {n}\n  data_files:\n  - split: test\n    path: data/{n}.parquet" + ("\n  default: true" if n == "defects" else "")
        for n in CONFIGS)
    scrub_tbl = "\n".join(f"| `{rx}` | `{rep}` | {counts.get(label, 0):,} |" for label, rx, rep in SCRUB_RULES)
    ok = sum(c["ok"] for c in checks)
    vals = {"REPO_ID": a.repo_id, "ARCHIVE": a.archive_url, "CONFIGS_YAML": configs_yaml, "CONFIG_ROWS": rows,
            "SCRUB_TABLE": scrub_tbl, "CHECKS": f"{ok} of {len(checks)}"}
    for k, v in vals.items():
        tmpl = tmpl.replace("{{" + k + "}}", v)
    open(os.path.join(out, "README.md"), "w").write(tmpl)


NOTICE = """This dataset was assembled by Quickchat AI and is distributed under the Apache License,
Version 2.0 (LICENSE).

It contains material derived from AACR-Bench v1.0 (https://github.com/alibaba/aacr-bench,
dataset commit ab8af8d5c74e2a4d1945d247ea4bbc49f93eb33f, harness commit
68a569759289a83654a59d06db2a72910edf0a4a), licensed under the Apache License, Version 2.0.
AACR-Bench ships no NOTICE file of its own. MODIFIED WORK: the `aacr_references` config
reproduces AACR-Bench's reference comments for the 185 runnable PRs with our derived keys,
bot-derived flags and labels added; `prs`, `defects` and `exclusions` are a new answer key
built on AACR-Bench's PR selection; nothing in AACR-Bench itself was changed. Cite:
Zhang et al., "AACR-Bench: Evaluating Automatic Code Review with Holistic Repository-Level
Context", arXiv:2601.19494 (2026).

The `martian_*` configs contain golden comments from Martian's offline code-review
benchmark (https://github.com/withmartian/code-review-benchmark, commit
e616e849755441da38f18bf3adba2c9583b03803), MIT licence, Copyright (c) 2025 Martian.

The `qodo_*` configs contain issues from Qodo PR-Review-Bench
(https://huggingface.co/datasets/Qodo/PR-Review-Bench, revision
a73957c450a70693a743260e5637fffc44625f16), MIT licence, by the Qodo team.

Code excerpts quoted in `defects` (evidence, sites) come from the reviewed open-source
repositories at the commits named in `prs`; they remain under each project's own licence
(SPDX id in `prs.repo_license`). Comments written by third-party review bots are not
included: those rows carry links to the original comments.
"""


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--runs-dir", required=True)
    ap.add_argument("--aacr-dataset", required=True, help="AACR-Bench v1.0 dataset/positive_samples.json (sha256-pinned)")
    ap.add_argument("--qodo-gt", help="Qodo git_code_review_bench_100_w_open_prs.jsonl (default: <runs>/../ext-cache/qodo/)")
    ap.add_argument("--qodo-tools", help="tool-comments.json from qodo_scrape.py build (default: <runs>/../ext-cache/qodo/)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--repo-id", required=True, help="the Hugging Face dataset id the card names")
    ap.add_argument("--archive-url", default="the run archive, a Hugging Face dataset repo (link and DOI TBD)")
    ap.add_argument("--no-figures", action="store_true")
    ap.add_argument("--no-load-check", action="store_true")
    a = ap.parse_args()
    a.runs_dir = os.path.abspath(os.path.expanduser(a.runs_dir))
    cache = os.path.join(os.path.dirname(a.runs_dir), "ext-cache", "qodo")
    a.qodo_gt = a.qodo_gt or os.path.join(cache, "git_code_review_bench_100_w_open_prs.jsonl")
    a.qodo_tools = a.qodo_tools or os.path.join(cache, "tool-comments.json")
    out = os.path.abspath(os.path.expanduser(a.out))
    if os.path.exists(out):
        shutil.rmtree(out)
    os.makedirs(out)

    ex = Exporter(a)
    print("key …", flush=True); ex.build_key(); ex.build_references()
    print("AACR reviews and verdicts …", flush=True); ex.build_aacr_reviews()
    print("Martian …", flush=True); ex.build_martian()
    print("Qodo …", flush=True); ex.build_qodo()
    sizes = write_parquet(ex.tables, out)
    if not a.no_figures:
        print("figures, keys, reports …", flush=True)
        figures(a, out, ex.counts, ex.notes)
    tables = read_parquet(out)
    checks = validate(tables)
    shutil.copy2(os.path.join(HERE, "hf", "LICENSE"), os.path.join(out, "LICENSE"))
    open(os.path.join(out, "NOTICE"), "w").write(NOTICE)
    render_card(a, out, sizes, checks, ex.counts)
    leaks = leak_scan(out)
    load = {}
    if not a.no_load_check:
        import datasets
        for n in CONFIGS:
            ds = datasets.load_dataset(out, n, split="test")
            load[n] = ds.num_rows
    report = {"rows": sizes, "checks": checks, "failed": [c for c in checks if not c["ok"]],
              "scrub_counts": dict(ex.counts), "leaks": leaks, "load_dataset": load, "notes": ex.notes}
    json.dump(report, open(os.path.join(out, "validation.json"), "w"), indent=1, default=str)
    print(json.dumps({k: v for k, v in report.items() if k != "checks"}, indent=1, default=str))
    print(f"checks: {sum(c['ok'] for c in checks)}/{len(checks)} ok")
    if report["failed"] or leaks or (load and any(load[n] != sizes[n] for n in CONFIGS)):
        sys.exit(1)


if __name__ == "__main__":
    main()
