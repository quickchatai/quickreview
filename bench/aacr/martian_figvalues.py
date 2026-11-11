#!/usr/bin/env python3
"""The numbers the Martian figures draw that no other shipped file holds, recomputed from the release.

    uv run --no-project --with pyarrow python3 bench/aacr/martian_figvalues.py --data <hf-dataset> \\
        --archive <release>/archive --martian <code-review-benchmark checkout> --check [--partial]
    uv run --no-project --with pyarrow python3 bench/aacr/martian_figvalues.py --data <hf-dataset> \\
        --archive <release>/archive --martian <code-review-benchmark checkout> \\
        --json bench/aacr/charts/martian-figs.json        # rewrite the committed copy

bench/aacr/martian_figs.py draws the eight martian-*.pdf figures. What it does not read from
charts/martian-data.json, charts/martian-tiers.json or ext/martian-tuning/tune20-leaderboard.txt it
reads from charts/martian-figs.json, which this script writes: per value, the number as the figure
draws it (rounded to the decimals it is drawn with), its key `q` and the runs it is computed from.
--check recomputes every value and fails on any that prints differently from the committed copy, or
whose key or runs differ from VALUES below. No model call.

A key is written in bench/aacr/claims.json's language and evaluated by verify_claims.py's own sources,
so a figure value and the paper's number for the same thing are one computation:
  martian:...      the HF tables (recompute/claim_metrics.py's Martian keys): a scoring dir's stored
                   scores, `-` for Martian's published scores of the three re-judged tools;
  martian_ext:...  recompute/martian_ext.py over the archive's analysis volume (fair/, gm/rows.json)
                   and runs/mv-r1-asposted.martian: the tune20 extended key and its blind classification;
  opus:TOOL:core_f2  Martian's published Opus 4.5 evaluations
                   (withmartian/code-review-benchmark at e616e84, offline/results/
                   anthropic_claude-opus-4-5-20251101/evaluations.json and benchmark_data.json; third-party,
                   never in the release, given with --martian), scored the way Martian's own scorer
                   (offline/analysis/score_profiles.py) scores its leaderboard: per tool, over the PRs it
                   was not skipped on, tp and fn the true positives and false negatives whose golden
                   category is in the Core profile, fp the entry's `fp`; F2 with beta 2.
Without --martian the `opus:` values fail as "needs --martian"; with --partial they are reported as
skipped and the run exits 0 when every other value matches (the same rule as verify_claims.py).
"""
from __future__ import annotations

import argparse
import ast
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import verify_claims as V  # noqa: E402

COMMITTED = HERE / "charts" / "martian-figs.json"
OPUS = "anthropic_claude-opus-4-5-20251101"
PUB = f"published: {OPUS}"
MARTIAN_AT = "withmartian/code-review-benchmark@e616e84"
EXT_ROOT = "analysis/external-benchmarks-2026-10-02"
EXT_RUNS = ["runs/mv-r1-asposted.martian", f"{EXT_ROOT}/fair/", f"{EXT_ROOT}/gm/rows.json"]
# Martian's scorer's Core profile: the golden categories it keeps (score_profiles.PROFILE_CATEGORIES)
CORE = frozenset({"bug", "security", "concurrency", "data", "api", "perf", "test_gap", "doc_defect"})

# the tune20 extended-key tools, in the order the figure lists them (FIGURE_NAME: the drawn label)
EXT_TOOLS = ("quickreview", "qodo-v2", "augment", "qodo-extended-v2", "cubic-v2", "claude-code", "macroscope", "devin")
# Martian's leaderboard, the tools the figure draws; the three re-judged ones' published scores ship in the HF tables
OPUS_TOOLS = ("qodo-extended-v2", "cubic-v2", "augment", "qodo-v2", "copilot-v2", "gemini-v2", "gitlab", "sourcery",
              "greptile-v4-1", "coderabbit", "macroscope", "bugbot", "claude-code", "devin", "greptile-v5", "kodus-v2",
              "codeant-v2", "copilot", "baz", "claude", "kg", "graphite")
IN_TABLES = ("qodo-extended-v2", "cubic-v2", "claude-code")

# the extra matches Opus 4.5 credits a re-judged tool over our judge, in every pass that re-judged all 50 PRs
# (the same nine pairs as the paper's claim for "7--12")
_PAIRS = [("cubic-v2", "final1-martian50"), ("qodo-extended-v2", "final1-martian50"), ("claude-code", "final1-martian50"),
          ("cubic-v2", "fast1-martian50"), ("qodo-extended-v2", "fast1-martian50"), ("claude-code", "fast1-martian50"),
          ("cubic-v2", "ext-default3-martian-tune20+ext-r4-martian-test30"),
          ("qodo-extended-v2", "mv-r1-asposted+ext-r4-martian-test30"),
          ("claude-code", "mv-r1-asposted+ext-r4-martian-test30")]


def _extra(fn: str) -> str:
    return fn + "(" + ", ".join(f"{{martian:-|{t}@{PUB}:core_tp}} - {{martian:{w}|rejudged-{t}:core_tp}}"
                                for t, w in _PAIRS) + ")"


def _estimate_f2(fn: str) -> str:
    """The frozen build's F2 had Opus credited it the fewest (min) or most (max) extra matches."""
    tp = f"({{martian:final1-martian50|quickreview-frozen:core_tp}} + {_extra(fn)})"
    p = f"({tp} / ({{martian:final1-martian50|quickreview-frozen:core_tp}} + {{martian:final1-martian50|quickreview-frozen:core_fp}}) * 100)"
    r = f"({tp} / ({{martian:final1-martian50|quickreview-frozen:core_tp}} + {{martian:final1-martian50|quickreview-frozen:core_fn}}) * 100)"
    return f"5 * {p} * {r} / (4 * {p} + {r})"


def _values() -> list:
    """(name, q, decimals drawn). Name = figure/what."""
    out = [("goldens/prs", "martian:goldens:prs", 0), ("goldens/real", "martian:goldens:real", 0),
           ("extended_key/key", "martian_ext:key", 0), ("extended_key/prs", "martian_ext:prs", 0)]
    for t in EXT_TOOLS:
        for m in ("recall", "p_strict", "p_lenient"):
            out.append((f"extended_key/{t}/{m}", f"martian_ext:tool/{t}/{m}", 1))
        for c in ("good", "minor", "dup", "wrong"):  # counts: martian_ext gives each class's share of the candidates
            out.append((f"extended_key/{t}/{c}", f"{{martian_ext:tool/{t}/{c}_pct}} * {{martian_ext:tool/{t}/candidates}} / 100", 0))
    for name, work in (("as_posted", "mv-r1-asposted"), ("round3", "ext-default3-martian-tune20"),
                       ("snappy", "ext-snappy-martian-tune20"), ("frozen_tune20", "mv-r7-c100-l2-vb"),
                       ("frozen_test30", "mt-test30-frozen")):
        for m in ("precision", "recall") + (("f1",) if name.startswith("frozen") else ()):
            out.append((f"policy/{name}/{m}", f"martian:{work}|quickreview:core_{m}", 1))
    for m in ("precision", "recall"):
        out.append((f"policy/cubic_rejudged/{m}", f"martian:ext-default3-martian-tune20|rejudged-cubic-v2:core_{m}", 1))
    for t in OPUS_TOOLS:
        out.append((f"leaderboard/{t}", f"martian:-|{t}@{PUB}:core_f2" if t in IN_TABLES else f"opus:{t}:core_f2", 1))
    out += [("leaderboard/quickreview_own_f2", "martian:final1-martian50|quickreview-frozen:core_f2", 1),
            ("leaderboard/extra_min", _extra("min"), 0), ("leaderboard/extra_max", _extra("max"), 0),
            ("leaderboard/estimate_low", _estimate_f2("min"), 1), ("leaderboard/estimate_high", _estimate_f2("max"), 1)]
    return out


VALUES = _values()


def runs_of(q: str) -> list:
    """The run dirs (archive paths) and third-party files a key reads."""
    out = []
    for check, key in V.refs_of(q):
        if check == "martian_ext":
            add = EXT_RUNS
        elif check == "opus":
            add = [f"{MARTIAN_AT} offline/results/{OPUS}/evaluations.json"]
        elif key.startswith("goldens"):
            add = ["hf:martian_prs" if key == "goldens:prs" else "hf:martian_goldens"]
        else:
            work = key.split("|", 1)[0]
            add = ([f"{MARTIAN_AT} (its published scores, the HF martian_scores rows with no work_dir)"] if work == "-"
                   else [f"runs/{w}.martian" for w in work.split("+")])
        out += [x for x in add if x not in out]
    return out


def drawn(v, dp: int):
    """The value as the figure draws it: rounded to its decimals the way verify_claims prints a number."""
    s = format(float(v), f".{dp}f")
    return int(s) if dp == 0 else float(s)


class Opus:
    """Martian's leaderboard score of a tool from its published Opus 4.5 evaluations (see the docstring)."""

    def __init__(self, martian: str):
        res = Path(martian) / "offline" / "results"
        self.ev = json.loads((res / OPUS / "evaluations.json").read_text())
        bd = json.loads((res / "benchmark_data.json").read_text())
        self.cat = {g.get("comment", ""): g.get("category", "") for e in bd.values() for g in e.get("golden_comments", [])}

    def value(self, key: str) -> float:
        tool, _, metric = key.partition(":")
        if metric != "core_f2":
            raise KeyError(f"opus key {key!r}: only core_f2")
        tp = fp = fn = n = 0
        for pr in self.ev.values():
            e = pr.get(tool)
            if not e or e.get("skipped"):
                continue
            n += 1
            cat = lambda x: x.get("category") or self.cat.get(x.get("golden_comment", ""), "")  # noqa: E731
            tp += sum(1 for x in e.get("true_positives") or [] if cat(x) in CORE)
            fn += sum(1 for x in e.get("false_negatives") or [] if cat(x) in CORE)
            fp += e.get("fp") or 0
        if not n:
            raise KeyError(f"opus: no evaluations of {tool!r}")
        p = tp / (tp + fp) if tp + fp else 0.0
        r = tp / (tp + fn) if tp + fn else 0.0
        return 100 * (5 * p * r / (4 * p + r) if p + r else 0.0)


class NeedsMartian(Exception):
    pass


def compute(a) -> dict:
    """{name: value or the exception that kept it from being computed}."""
    found = V.discover([d for d in (a.data, a.archive) if d])
    src = V.Sources(argparse.Namespace(work=a.work, martian=a.martian, qodo_gt=None, partial=a.partial),
                    json.loads(V.MANIFEST.read_text()), found)
    opus = Opus(a.martian) if a.martian else None
    out = {}
    for name, q, dp in VALUES:
        try:
            vals = {}
            for i, (check, key) in enumerate(V.refs_of(q)):
                if check == "opus":
                    if opus is None:
                        raise NeedsMartian("needs --martian")
                    vals[f"_r{i}"] = opus.value(key)
                else:
                    vals[f"_r{i}"] = src.value(check, key)
            if V._REF.search(q):
                expr = q
                for i, (check, key) in enumerate(V.refs_of(q)):
                    expr = expr.replace("{" + f"{check}:{key}" + "}", f"_r{i}", 1)
                v = V._eval(ast.parse(expr, mode="eval"), vals)
            else:
                v = vals["_r0"]
            out[name] = drawn(v, dp)
        except Exception as e:  # a missing source or a key the data cannot answer: never a number
            out[name] = e
    return out


def document(values: dict) -> dict:
    return {"_doc": "The numbers martian_figs.py draws that no other shipped file holds, as drawn (rounded to the "
                    "decimals the figure prints), each with its key in bench/aacr/claims.json's language and the runs "
                    "it reads. Written and checked by bench/aacr/martian_figvalues.py (its docstring: every key kind).",
            "values": {name: {"value": values[name], "q": q, "runs": runs_of(q)} for name, q, _ in VALUES}}


def check(committed: dict, values: dict, partial: bool) -> tuple:
    """(problems, skipped): every value that differs from the committed copy, and those only --martian could give."""
    problems, skipped = [], []
    have = committed.get("values") or {}
    for name, q, _ in VALUES:
        c = have.get(name)
        v = values.get(name)
        if c is None:
            problems.append(f"{name}: not in the committed copy")
            continue
        if c.get("q") != q or c.get("runs") != runs_of(q):
            problems.append(f"{name}: the committed key or runs differ from martian_figvalues.VALUES")
        if isinstance(v, NeedsMartian) and partial:
            skipped.append(name)
        elif isinstance(v, Exception):
            problems.append(f"{name}: not computed ({type(v).__name__}: {str(v)[:200]})")
        elif v != c.get("value"):
            problems.append(f"{name}: computed {v}, the figure draws {c.get('value')}")
    problems += [f"{n}: in the committed copy, not in VALUES" for n in sorted(set(have) - {n for n, _, _ in VALUES})]
    return problems, skipped


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--data", required=True, help="the HF dataset (its data/ dir or the dataset root)")
    ap.add_argument("--archive", help="the release's archive/ (for the martian_ext values)")
    ap.add_argument("--martian", help="withmartian/code-review-benchmark checkout at e616e84 (third-party)")
    ap.add_argument("--work", default=os.path.join(os.environ.get("TMPDIR", "."), "martian-figvalues"))
    ap.add_argument("--check", action="store_true", help="fail on any value that differs from charts/martian-figs.json")
    ap.add_argument("--committed", default=str(COMMITTED), help="the committed copy --check compares with")
    ap.add_argument("--partial", action="store_true", help="skip, do not fail, the values only --martian gives")
    ap.add_argument("--json", help="write the values here (charts/martian-figs.json to update the committed copy)")
    a = ap.parse_args()
    values = compute(a)
    if a.json:
        bad = {n: v for n, v in values.items() if isinstance(v, Exception)}
        if bad:
            for n, e in bad.items():
                print(f"{n}: not computed ({e})", file=sys.stderr)
            return 1
        Path(a.json).write_text(json.dumps(document(values), indent=1) + "\n")
        print(f"wrote {len(values)} values to {a.json}")
    if a.check:
        problems, skipped = check(json.loads(Path(a.committed).read_text()), values, a.partial)
        for p in problems:
            print("MISMATCH:", p)
        ok = len(VALUES) - len(problems) - len(skipped)
        tail = f", {len(skipped)} skipped (needs --martian)" if skipped else ""
        print(f"martian figure values: {ok} of {len(VALUES)} equal the drawn ones{tail}: exit {1 if problems else 0}")
        return 1 if problems else 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
