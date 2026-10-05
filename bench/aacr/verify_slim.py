#!/usr/bin/env python3
"""Verify the slim re-score bundle: unpack it into a clean directory
and recompute, with no model call, every table that final/score.sh, compare.py,
charts.py and the external-benchmark scorers produce; compare each against the
same computation over the full runs and against the papers' printed numbers.

    bench/aacr/verify_slim.py --bundle OUT/slim/quickreview-bench-slim.tar.zst --work SCRATCH \\
        --full RUNS_ROOT/runs --martian MARTIAN_CHECKOUT --qodo-gt QODO_DATASET.jsonl

  --full      the full runs dir (optional): every compare.py table is also run
              there with the repo's unmodified compare.py and the two outputs
              are diffed line for line.
  --martian   a checkout of withmartian/code-review-benchmark@e616e84 (its
              scorer and published judgements; MIT, never in the bundle).
  --qodo-gt   Qodo PR-Review-Bench's git_code_review_bench_100_w_open_prs.jsonl
              (HF Qodo/PR-Review-Bench@a73957c, MIT).

The tools run from a copy of bench/aacr in WORK; when that compare.py does not
read `bench_cost_usd` yet (C10), the copy gets the three-line patch
below, which is exactly the change the public tree needs.
"""
from __future__ import annotations

import argparse
import collections
import difflib
import glob
import json
import os
import re
import shutil
import statistics
import subprocess
import sys
import tarfile
from pathlib import Path

HERE = Path(__file__).resolve().parent

C10_ANCHOR = '    mins = summary["duration_seconds"] / 60 if "duration_seconds" in summary else None\n'
C10_PATCH = ('    if not os.path.exists(ev) and "bench_cost_usd" in summary:\n'
             '        # The slim re-score bundle (C10): compare.py\'s own figure, computed\n'
             '        # from pi-events.jsonl before the bundle left that file out.\n'
             '        usd = summary["bench_cost_usd"]\n')


def lines(path):
    return [ln.strip() for ln in Path(path).read_text().splitlines()]


def arms(path):
    return [ln for ln in lines(path) if ln]


FINAL = arms(HERE / "final" / "arms.txt")
SOL = arms(HERE / "final" / "arms-gpt6sol.txt")
SET40 = Path(HERE / "final" / "select40.txt").read_text().strip()
OTHER145 = Path(HERE / "final" / "other145.txt").read_text().strip()
FROZEN = "QuickReview frozen=final1-smoke10,final1-dev10,final1-holdout10,final1-fresh10,final1-rest145"
FAST = "QuickReview fast=fast1-smoke10,fast1-dev10,fast1-holdout10,fast1-fresh10,fast1-rest145"
ALL = "all30+fresh10+rest145"
BOT = str(HERE / "bot_references.json")

# (label, compare.py arguments); the first five are final/score.sh's
COMPARES = [
    ("score.sh 1: final comparison, 185 PRs (+AACR, bot refs removed)", ["--cases", ALL, "--exclude-refs", "{BOT}"] + FINAL),
    ("score.sh 2: final arms on S40", ["--cases", SET40] + FINAL),
    ("score.sh 3: final arms on O145", ["--cases", OTHER145] + FINAL),
    ("gpt-6-sol study, primary judge (+AACR, bot refs removed)", ["--cases", ALL, "--exclude-refs", "{BOT}"] + SOL),
    ("gpt-6-sol study, second judge (Opus 5.5)", ["--cases", ALL, "--judge-model", "claude-opus-5-5"] + SOL),
    ("frozen build and fast option, 185 PRs", ["--cases", ALL, FROZEN, FAST] + FINAL[:1]),
    ("frozen build on R145", ["--cases", "rest145", FROZEN] + FINAL[:1]),
    ("frozen build on smoke10+dev10", ["--cases", "smoke10+dev10", FROZEN] + FINAL[:1]),
    ("frozen build on holdout10+fresh10", ["--cases", "holdout10+fresh10", FROZEN] + FINAL[:1]),
]

# The papers' printed numbers (bench/aacr/paper/benchmark.tex), as printed.
PAPER_FINAL = {  # tab:final: found, recall, high, medium, low, weighted, correct, $/PR, median min
    "QuickReview default": ("409", "79%", "83.5", "121", "204.5", "82%", "95%", "1.36", "9.5"),
    "QuickReview low": ("365.5", "70%", "79.5", "104.5", "181.5", "74%", "94%", "0.88", "6.7"),
    "pi-review panel (high)": ("347.5", "67%", "80", "119", "148.5", "74%", "89%", "0.27", "1.8"),
    "Claude Code (Opus 5.5)": ("324.5", "62%", "72.5", "105", "147", "68%", "81%", "0.20", "0.7"),
    "open-code-review high": ("298.5", "57%", "63.5", "102", "133", "62%", "86%", "0.53", "1.8"),
    "Codex CLI high": ("287", "55%", "81", "101.5", "104.5", "65%", "93%", "0.14", "2.1"),
    "OpenCode native + PR text": ("263.5", "51%", "76", "99", "88.5", "61%", "93%", "0.17", "2.3"),
    "PR-Agent": ("194", "37%", "55.5", "70", "68.5", "44%", "76%", "0.07", "1.9"),
}
PAPER_AACR = {  # tab:aacr: found, recall, precision, comments, F1, then bot-removed recall, precision, F1
    "QuickReview default": ("151.7", "10.7%", "15.2%", "999", "12.5%", "9.9%", "13.3%", "11.4%"),
    "QuickReview low": ("127.3", "9.0%", "15.9%", "801", "11.5%", "8.1%", "13.5%", "10.1%"),
    "pi-review panel (high)": ("84.7", "6.0%", "14.5%", "583", "8.5%", "5.7%", "13.2%", "8.0%"),
    "Claude Code (Opus 5.5)": ("81.0", "5.7%", "19.9%", "407", "8.9%", "5.8%", "18.9%", "8.8%"),
    "open-code-review high": ("115.3", "8.1%", "20.2%", "570", "11.6%", "7.7%", "18.1%", "10.8%"),
    "Codex CLI high": ("68.7", "4.8%", "20.0%", "343", "7.8%", "4.7%", "18.3%", "7.5%"),
    "OpenCode native + PR text": ("61.3", "4.3%", "17.3%", "354", "6.9%", "4.1%", "15.6%", "6.5%"),
    "PR-Agent": ("86.0", "6.1%", "21.3%", "404", "9.4%", "5.6%", "18.6%", "8.6%"),
}
PAPER_SELECTION = {  # tab:selection: S40 recall, O145 found, O145 recall, O145 high
    "QuickReview default": ("85%", "311", "77%", "66.5"), "QuickReview low": ("75%", "279", "69%", "62.5"),
    "pi-review panel (high)": ("70%", "267.5", "66%", "63"), "Claude Code (Opus 5.5)": ("60%", "256", "63%", "58.5"),
    "open-code-review high": ("66%", "223", "55%", "48.5"), "Codex CLI high": ("56%", "222.5", "55%", "65"),
    "OpenCode native + PR text": ("50%", "206", "51%", "60"), "PR-Agent": ("34%", "154.5", "38%", "44.5"),
}
PAPER_SOL = {  # tab:sol-summary: found, recall, high, correct, 2nd recall, 2nd correct, $/PR, AACR F1
    "QuickReview default": ("437.5", "84%", "86", "86%", "84%", "86%", "1.71", "12.6%"),
    "QuickReview low": ("345", "66%", "75", "80%", "66%", "82%", "0.80", "11.9%"),
    "Claude Code (Opus 5.5)": ("324.5", "62%", "72.5", "81%", "62%", "86%", "0.20", "8.9%"),
    "pi-review": ("292.5", "56%", "71.5", "79%", "56%", "79%", "0.11", "9.1%"),
    "open-code-review": ("291.5", "56%", "64.5", "73%", "56%", "77%", "0.60", "14.0%"),
    "OpenCode": ("250", "48%", "64.5", "55%", "48%", "55%", "0.83", "8.4%"),
    "Codex CLI": ("248.5", "48%", "70", "69%", "48%", "69%", "0.15", "6.9%"),
}
PAPER_FROZEN = {  # tab:finalbuild, frozen column
    "185 found": "461", "185 recall": "89%", "high": "87.5", "medium": "134.5", "low": "239", "weighted": "91%",
    "R145 found": "356", "R145 recall": "90%", "smoke10+dev10 found": "59.5", "smoke10+dev10 recall": "84%",
    "holdout10+fresh10 found": "45.5", "holdout10+fresh10 recall": "83%", "correct": "92%", "$/PR": "2.06", "median min": "17.5",
}
PAPER_MARTIAN = {  # tab:martianfinal: run.martian dir, tool key, (matched, P, R, F1, F2)
    "QuickReview frozen build": ("final1-martian50.martian", "quickreview", ("104", "16.2", "65.8", "26.1", "40.9")),
    "qodo-extended-v2 (re-judged)": ("final1-martian50.martian", "rejudged-qodo-extended-v2", ("95", "56.2", "60.1", "58.1", "59.3")),
    "cubic-v2 (re-judged)": ("final1-martian50.martian", "rejudged-cubic-v2", ("95", "54.3", "60.1", "57.1", "58.9")),
    "Claude Code (re-judged)": ("final1-martian50.martian", "rejudged-claude-code", ("65", "36.5", "41.1", "38.7", "40.1")),
    "open-code-review high": ("final1-ocr-martian50.martian", "open-code-review", ("93", "26.7", "58.9", "36.8", "47.4")),
    "PR-Agent": ("final1-pragent-martian50.martian", "pr-agent", ("57", "41.9", "36.1", "38.8", "37.1")),
    "OpenCode + PR text": ("final1-opencode-martian50.martian", "opencode", ("53", "32.7", "33.5", "33.1", "33.4")),
    "qodo-extended-v2 (Opus 4.5)": ("final1-martian50.martian", "published:anthropic_claude-opus-4-5-20251101:qodo-extended-v2", ("102", "67.1", "64.6", "65.8", "65.1")),
    "cubic-v2 (Opus 4.5)": ("final1-martian50.martian", "published:anthropic_claude-opus-4-5-20251101:cubic-v2", ("104", "61.5", "65.8", "63.6", "64.9")),
    "Claude Code (Opus 4.5)": ("final1-martian50.martian", "published:anthropic_claude-opus-4-5-20251101:claude-code", ("76", "46.3", "48.1", "47.2", "47.7")),
}
PAPER_MARTIAN_COST = {"final1-martian50": ("2.84", "26.1"), "final1-ocr-martian50": ("0.86", "3.3"),
                      "final1-pragent-martian50": ("0.09", "1.4"), "final1-opencode-martian50": ("0.19", "2.4")}
PAPER_QODO = {  # tab:qodo: qodo dir, tool, (comments/PR, P, R, F1, R functional, R rule)
    "qodo-exhaustive": ("ext-r6-qodo-pr100.qodo", "qodo-exhaustive", ("4.6", "58.0", "46.4", "51.5", "48.2", "44.3")),
    "qodo-precise": ("ext-r6-qodo-pr100.qodo", "qodo-precise", ("3.1", "68.0", "35.9", "47.0", "36.2", "35.4")),
    "augment": ("ext-r6-qodo-pr100.qodo", "augment", ("2.5", "67.5", "29.7", "41.2", "49.2", "7.4")),
    "QuickReview frozen build": ("final1-qodo-pr100.qodo", "quickreview", ("7.1", "37.3", "45.3", "40.9", "52.1", "37.6")),
    "OpenCode": ("final1-opencode-qodo-pr100.qodo", "opencode", ("2.6", "64.9", "29.0", "40.0", "43.7", "12.2")),
    "copilot": ("ext-r6-qodo-pr100.qodo", "copilot", ("4.2", "46.8", "33.6", "39.1", "46.3", "19.2")),
    "greptile": ("ext-r6-qodo-pr100.qodo", "greptile", ("2.4", "64.7", "26.6", "37.7", "37.2", "14.4")),
    "cursor": ("ext-r6-qodo-pr100.qodo", "cursor", ("1.9", "73.8", "24.3", "36.6", "41.1", "5.2")),
    "open-code-review": ("final1-ocr-qodo-pr100.qodo", "open-code-review", ("3.5", "47.1", "28.1", "35.2", "45.6", "8.1")),
    "QuickReview 2026-10-02 build": ("ext-r6-qodo-pr100.qodo", "quickreview", ("5.5", "35.8", "34.0", "34.9", "50.8", "14.8")),
    "codex": ("ext-r6-qodo-pr100.qodo", "codex", ("1.6", "78.2", "22.2", "34.6", "32.4", "10.7")),
    "PR-Agent": ("final1-pragent-qodo-pr100.qodo", "pr-agent", ("3.4", "47.2", "27.2", "34.5", "43.7", "8.5")),
    "sentry": ("ext-r6-qodo-pr100.qodo", "sentry", ("0.9", "76.8", "12.6", "21.6", "22.7", "1.1")),
    "coderabbit": ("ext-r6-qodo-pr100.qodo", "coderabbit", ("1.9", "43.7", "14.3", "21.6", "23.0", "4.4")),
}
PAPER_QODO_COST = {"final1-qodo-pr100": ("2.48", "19.6"), "final1-opencode-qodo-pr100": ("0.20", "2.3"),
                   "final1-ocr-qodo-pr100": ("0.46", "1.9"), "final1-pragent-qodo-pr100": ("0.10", "1.2")}


class Report:
    def __init__(self):
        self.rows, self.bad = [], 0

    def check(self, table, row, col, paper, ours):
        ok = str(paper).strip() == str(ours).strip()
        self.bad += not ok
        self.rows.append((table, row, col, paper, ours, "ok" if ok else "MISMATCH"))

    def text(self):
        out = ["| Table | Row | Column | Paper | Re-scored from the bundle | |", "|---|---|---|---|---|---|"]
        out += [f"| {' | '.join(map(str, r))} |" for r in self.rows]
        return "\n".join(out)


def table_rows(text: str, header_start: str) -> dict:
    """compare.py's markdown table under a header line -> {arm: [cells]}. A
    header_start ending in '|' must match the whole header line."""
    rows, on = {}, False
    for ln in text.splitlines():
        if (ln.strip() == header_start) if header_start.endswith("|") else ln.startswith(header_start):
            on = True
            continue
        if on:
            if ln.startswith("| Arm") or ln.startswith("|---"):
                continue
            if not ln.startswith("|"):
                if rows:
                    break
                continue
            cells = [c.strip() for c in ln.strip("|").split("|")]
            rows[cells[0]] = cells[1:]
    return rows


def run(cmd, env=None, cwd=None):
    p = subprocess.run(cmd, capture_output=True, text=True, env=env, cwd=cwd)
    if p.returncode:
        raise SystemExit(f"failed: {' '.join(cmd)}\n{p.stderr[-3000:]}")
    return p.stdout


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--bundle", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--full", help="the full runs dir, for a line-for-line diff of every compare.py table")
    ap.add_argument("--martian", required=True)
    ap.add_argument("--qodo-gt", required=True)
    ap.add_argument("--skip-charts", action="store_true")
    a = ap.parse_args()
    work = Path(a.work)
    if work.exists():
        shutil.rmtree(work)
    slim, tools = work / "slim", work / "aacr"
    slim.mkdir(parents=True)
    out = work / "out"
    out.mkdir()

    # 1. unpack, check every file's hash
    run(["tar", "--zstd", "-xf", a.bundle, "-C", str(slim)])
    bad = 0
    for ln in (slim / "FILES.sha256").read_text().splitlines():
        h, _, p = ln.split("  ", 2)
        import hashlib
        bad += hashlib.sha256((slim / p).read_bytes()).hexdigest() != h
    nfiles = sum(1 for _ in (slim / "FILES.sha256").read_text().splitlines())
    events = list(slim.glob("runs/*/cases/*/pi-events.jsonl"))
    print(f"unpacked {nfiles} files, {bad} hash mismatches, {len(events)} pi-events.jsonl (expected 0)")

    # 2. the tools: a copy of bench/aacr (+ the C10 patch when compare.py lacks it)
    tools.mkdir()
    for item in ("compare.py", "charts.py", "defects", "references.json", "sets", "bot_references.json", "final", "ext"):
        s = HERE / item
        (shutil.copytree if s.is_dir() else shutil.copy2)(s, tools / item)
    src = (tools / "compare.py").read_text()
    patched = "bench_cost_usd" not in src
    if patched:
        assert C10_ANCHOR in src, "compare.py changed shape; update the C10 patch"
        (tools / "compare.py").write_text(src.replace(C10_ANCHOR, C10_PATCH + C10_ANCHOR))
    print(f"compare.py C10 patch {'applied to the copy' if patched else 'already in the tree'}")

    rep = Report()
    env = dict(os.environ, QCR_BENCH_RUNS_DIR=str(slim / "runs"))

    # 3. compare.py: every table, from the bundle; and line for line against the full runs
    outputs = {}
    procs = []
    for label, args in COMPARES:
        args = [x.replace("{BOT}", BOT) for x in args]
        procs.append((label, "slim", subprocess.Popen([sys.executable, str(tools / "compare.py"), "--runs-dir", str(slim / "runs")] + args,
                                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)))
        if a.full:
            procs.append((label, "full", subprocess.Popen([sys.executable, str(HERE / "compare.py"), "--runs-dir", a.full] + args,
                                                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)))
    for label, kind, p in procs:
        o, e = p.communicate()
        if p.returncode:
            raise SystemExit(f"compare.py failed ({label}, {kind}):\n{e[-3000:]}")
        outputs[(label, kind)] = o
    diffs = {}
    for i, (label, _) in enumerate(COMPARES):
        (out / f"compare-{i}.slim.md").write_text(outputs[(label, "slim")])
        if a.full:
            (out / f"compare-{i}.full.md").write_text(outputs[(label, "full")])
            d = list(difflib.unified_diff(outputs[(label, "full")].splitlines(), outputs[(label, "slim")].splitlines(), lineterm="", n=0))
            diffs[label] = d
            print(f"compare {i} ({label}): {'IDENTICAL to the full runs' if not d else f'{len(d)} diff lines'}")
            for ln in d[:12]:
                print("   ", ln)

    # 4. the papers' AACR tables
    o1 = outputs[(COMPARES[0][0], "slim")]
    dt = table_rows(o1, "| Arm | Problems found")
    for arm, exp in PAPER_FINAL.items():
        c = dt.get(arm)
        if not c:
            rep.check("tab:final", arm, "row", "present", "absent")
            continue
        found = c[0].split("/")[0]
        high, med, low = (x.split("/")[0] for x in c[2:5])
        for col, p, v in zip(("found", "recall", "high", "medium", "low", "weighted", "correct", "$/PR", "median min"),
                             exp, (found, c[1], high, med, low, c[5], c[6], c[7].lstrip("$"), c[8])):
            rep.check("tab:final", arm, col, p, v)
    at = table_rows(o1, "| Arm | References found | Recall | Precision | F1 | Code defect")
    ex = table_rows(o1, "| Arm | References found | Recall | Precision | F1 |")
    for arm, exp in PAPER_AACR.items():
        c, e = at.get(arm), ex.get(arm)
        if not c or not e:
            rep.check("tab:aacr", arm, "row", "present", "absent")
            continue
        m = re.match(r"([\d.]+)% \((\d+) comments\)", c[2])
        rec_after = e[1].split("→")[1].strip()
        prec_after = e[2].split("→")[1].split("/")[0].strip()
        f1_after = e[3].split("→")[1].split("/")[0].strip()
        for col, p, v in zip(("found", "recall", "precision", "comments", "F1", "recall, bot refs removed", "precision, bot refs removed", "F1, bot refs removed"),
                             exp, (c[0].split("/")[0], c[1], m.group(1) + "%", m.group(2), c[3], rec_after, prec_after, f1_after)):
            rep.check("tab:aacr", arm, col, p, v)
    s40 = table_rows(outputs[(COMPARES[1][0], "slim")], "| Arm | Problems found")
    o145 = table_rows(outputs[(COMPARES[2][0], "slim")], "| Arm | Problems found")
    for arm, exp in PAPER_SELECTION.items():
        if arm in s40 and arm in o145:
            for col, p, v in zip(("S40 recall", "O145 found", "O145 recall", "O145 high"), exp,
                                 (s40[arm][1], o145[arm][0].split("/")[0], o145[arm][1], o145[arm][2].split("/")[0])):
                rep.check("tab:selection", arm, col, p, v)
    o4, o5 = outputs[(COMPARES[3][0], "slim")], outputs[(COMPARES[4][0], "slim")]
    p4, p5, a4 = table_rows(o4, "| Arm | Problems found"), table_rows(o5, "| Arm | Problems found"), table_rows(o4, "| Arm | References found | Recall | Precision | F1 | Code defect")
    for arm, exp in PAPER_SOL.items():
        c, d, f = p4.get(arm), p5.get(arm), a4.get(arm)
        if not (c and d and f):
            rep.check("tab:sol-summary", arm, "row", "present", "absent")
            continue
        for col, p, v in zip(("found", "recall", "high", "correct", "2nd judge recall", "2nd judge correct", "$/PR", "AACR F1"), exp,
                             (c[0].split("/")[0], c[1], c[2].split("/")[0], c[6], d[1], d[6], c[7].lstrip("$"), f[3])):
            rep.check("tab:sol-summary", arm, col, p, v)
    fz = table_rows(outputs[(COMPARES[5][0], "slim")], "| Arm | Problems found").get("QuickReview frozen")
    if fz:
        vals = {"185 found": fz[0].split("/")[0], "185 recall": fz[1], "high": fz[2].split("/")[0], "medium": fz[3].split("/")[0],
                "low": fz[4].split("/")[0], "weighted": fz[5], "correct": fz[6], "$/PR": fz[7].lstrip("$"), "median min": fz[8]}
        for key, i in (("R145", 6), ("smoke10+dev10", 7), ("holdout10+fresh10", 8)):
            r = table_rows(outputs[(COMPARES[i][0], "slim")], "| Arm | Problems found")["QuickReview frozen"]
            vals[f"{key} found"], vals[f"{key} recall"] = r[0].split("/")[0], r[1]
        for col, p in PAPER_FROZEN.items():
            rep.check("tab:finalbuild", "QuickReview frozen", col, p, vals.get(col))

    # 5. charts.py: numbers.json from the bundle against the committed ones
    chart_notes = []
    if not a.skip_charts:
        for suffix, arms_, note in (("", FINAL, "final"), ("-gpt6sol", SOL, "gpt-6-sol study")):
            cdir = out / f"charts{suffix}"
            cdir.mkdir()
            cmd = ["uv", "run", "--offline", "--quiet", str(tools / "charts.py"), "--out", str(cdir), "--cases", ALL]
            if suffix:
                cmd.append(f"--suffix={suffix}")
            run(cmd + arms_, env=env)
            mine = json.loads((cdir / f"numbers{suffix}.json").read_text())
            theirs = json.loads((HERE / "charts" / f"numbers{suffix}.json").read_text())
            # the committed gpt-6-sol chart data predates the product's rename
            # (arms-gpt6sol.txt now says QuickReview where it said quickreviewd)
            renamed = {k.replace("quickreviewd", "QuickReview"): v for k, v in (theirs.get("arms") or {}).items()}
            same = _num_equal(mine.get("arms"), renamed)
            how = " (arm labels quickreviewd -> QuickReview)" if renamed.keys() != (theirs.get("arms") or {}).keys() else ""
            chart_notes.append(f"charts.py {note}: numbers{suffix}.json arms {'IDENTICAL to' if same else 'DIFFER from'} the committed charts/numbers{suffix}.json{how}")
            rep.check("charts/numbers" + suffix + ".json", "all arms", "every number", "identical to the committed file", "identical to the committed file" if same else "differs")
            print(chart_notes[-1])

    # 6. Martian: every scoring dir, by Martian's own scorer, against the stored scores
    sys.path.insert(0, str(Path(a.martian) / "offline"))
    sys.path.insert(0, str(tools / "ext"))
    cwd = os.getcwd()
    os.chdir(Path(a.martian) / "offline")
    import martian_report as MR
    MR.PUBLISHED = Path(a.martian) / "offline" / "results"
    cats = MR._load_golden_categories(MR.PUBLISHED)
    os.chdir(cwd)
    mstats = collections.Counter()
    recomputed = {}
    for d in sorted((slim / "runs").glob("*.martian*")):
        stored = d / "martian-scores.json"
        if not stored.exists():
            continue
        s = json.loads(stored.read_text())
        ours = json.loads((d / "results" / s["this_run"]["judge"] / "evaluations.json").read_text())
        mine = {"this_run": MR.scores(ours, cats)}
        prs = sorted(ours)
        for judge, j in s.get("published", {}).items():
            tools_ = {t for t in j["scores"]}
            pub = json.loads((MR.PUBLISHED / judge / "evaluations.json").read_text())
            subset = {u: {t: v for t, v in pub[u].items() if t in tools_} for u in prs if u in pub}
            mine[f"published:{judge}"] = MR.scores(subset, cats)
        recomputed[d.name] = mine
        same = _num_equal(mine["this_run"], s["this_run"]["scores"]) and all(
            _num_equal(mine[f"published:{k}"], v["scores"]) for k, v in s.get("published", {}).items())
        mstats["identical" if same else "DIFFERENT"] += 1
        if not same:
            print("Martian scores differ:", d.name)
    print(f"Martian: {sum(mstats.values())} scoring dirs re-scored from the bundle: {dict(mstats)}")
    for row, (dname, tool, exp) in PAPER_MARTIAN.items():
        sc = recomputed.get(dname, {})
        if tool.startswith("published:"):
            _, judge, t = tool.split(":")
            m = sc.get(f"published:{judge}", {}).get(t, {}).get("core")
        else:
            m = sc.get("this_run", {}).get(tool, {}).get("core")
        if not m:
            rep.check("tab:martianfinal", row, "row", "present", "absent")
            continue
        for col, p, v in zip(("matched/158", "P", "R", "F1", "F2"), exp,
                             (str(m["tp"]), f"{100 * m['precision']:.1f}", f"{100 * m['recall']:.1f}", f"{100 * m['f1']:.1f}", f"{100 * m['f2']:.1f}")):
            rep.check("tab:martianfinal", row, col, p, v)
    for run_, (pu, pm) in PAPER_MARTIAN_COST.items():
        u, m = _cost(slim / "runs" / run_)
        rep.check("tab:martianfinal", run_, "$/PR", pu, f"{u:.2f}")
        rep.check("tab:martianfinal", run_, "min/PR (mean)", pm, f"{m:.1f}")

    # 7. Qodo: every scoring dir, by qodo_judge.py's scorer, against the stored scores.md
    import qodo_judge as QJ
    gt = {r["pr_url_to_review"]: r for r in map(json.loads, Path(a.qodo_gt).read_text().splitlines()) if r}
    qstats = collections.Counter()
    qscores = {}
    for d in sorted((slim / "runs").glob("*.qodo*")):
        if not (d / "scores.json").exists():
            continue
        stored = json.loads((d / "scores.json").read_text())
        set_name = _qodo_set(d.name)
        cases = json.loads((tools / "sets" / f"{set_name}.json").read_text())["cases"]
        done = {}
        for ln in (d / "judgements.jsonl").read_text().splitlines():
            j = json.loads(ln)
            if "error" not in j["meta"]:
                done[(j["pr"], j["tool"], j["pass"])] = j
        present = {k[1] for k in done}
        tools_ = sorted(t for t in present if t not in QJ.VENDORS) + [v for v in QJ.VENDORS if v in present]
        tools_ = [t for t in tools_ if t in stored["scores"]]
        tmp = out / "qodo" / d.name
        tmp.mkdir(parents=True)
        import contextlib, io
        with contextlib.redirect_stdout(io.StringIO()):
            QJ.score(cases, gt, tools_, done, tmp, [tuple(e) for e in stored.get("errors", [])])
        mine = json.loads((tmp / "scores.json").read_text())
        same_md = (tmp / "scores.md").read_text() == (d / "scores.md").read_text()
        same = _num_equal(mine["scores"], stored["scores"])
        qscores[d.name] = mine["scores"]
        qstats["identical" if same and same_md else ("numbers identical, scores.md text differs" if same else "DIFFERENT")] += 1
        if not same:
            print("Qodo scores differ:", d.name)
    print(f"Qodo: {sum(qstats.values())} scoring dirs re-scored from the bundle: {dict(qstats)}")
    for row, (dname, tool, exp) in PAPER_QODO.items():
        s = (qscores.get(dname) or {}).get(tool, {}).get("N=5")
        if not s:
            rep.check("tab:qodo", row, "row", "present", "absent")
            continue
        for col, p, v in zip(("comments/PR", "P", "R", "F1", "R functional", "R rule"), exp,
                             (f"{s['per_pr']:.1f}", f"{100 * s['precision']:.1f}", f"{100 * s['recall']:.1f}", f"{100 * s['f1']:.1f}",
                              f"{100 * s['recall_functional']:.1f}", f"{100 * s['recall_rule']:.1f}")):
            rep.check("tab:qodo", row, col, p, v)
    for run_, (pu, pm) in PAPER_QODO_COST.items():
        u, m = _cost(slim / "runs" / run_)
        rep.check("tab:qodo", run_, "$/PR", pu, f"{u:.2f}")
        rep.check("tab:qodo", run_, "min/PR (mean)", pm, f"{m:.1f}")

    (out / "paper-comparison.md").write_text(rep.text() + "\n")
    print(f"\npaper comparison: {len(rep.rows)} cells, {rep.bad} mismatches -> {out / 'paper-comparison.md'}")
    summary = {"files": nfiles, "hash_mismatches": bad, "pi_events_in_bundle": len(events), "c10_patched_copy": patched,
               "compare_vs_full": {k: ("identical" if not v else f"{len(v)} diff lines") for k, v in diffs.items()},
               "charts": chart_notes, "martian": dict(mstats), "qodo": dict(qstats),
               "paper_cells": len(rep.rows), "paper_mismatches": rep.bad,
               "mismatch_rows": [r for r in rep.rows if r[-1] != "ok"]}
    (out / "summary.json").write_text(json.dumps(summary, indent=1) + "\n")
    print(json.dumps({k: v for k, v in summary.items() if k != "mismatch_rows"}, indent=1))
    for r in summary["mismatch_rows"]:
        print("MISMATCH", r)


def _cost(run_dir: Path):
    u, m = [], []
    for f in sorted(run_dir.glob("cases/*/case-summary.json")):
        s = json.loads(f.read_text())
        if s.get("bench_cost_usd") is not None:
            u.append(s["bench_cost_usd"])
        if s.get("duration_seconds"):
            m.append(s["duration_seconds"] / 60)
    return (statistics.mean(u) if u else 0.0), (statistics.mean(m) if m else 0.0)


def _qodo_set(name: str) -> str:
    base = name.split(".qodo")[0]
    if "dedup5" in base:
        return "dedup5-qodo"
    m = re.search(r"qodo-([A-Za-z0-9]+)$", base)
    return f"qodo-{m.group(1)}"


def _num_equal(a, b, tol=1e-9) -> bool:
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(_num_equal(a[k], b[k], tol) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_num_equal(x, y, tol) for x, y in zip(a, b))
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return abs(a - b) <= tol
    return a == b


if __name__ == "__main__":
    main()
