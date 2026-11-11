#!/usr/bin/env python3
"""The dataset's second judges: `second_judges/<LABEL>/`, checked and scored. No model call.

    uv run --no-project --with pyarrow python bench/aacr/recompute/second_judges.py --data <hf-dataset> [--json OUT]

A second judge's folder holds another judge's verdicts on reviews the tables already hold, shaped as
the scorers' `--verdicts` input (`aacr/`, `martian/`, `qodo/`), the scorers' output on them (`scores/`),
its README and the scripts that made it (`code/`, data: never run here). No config of the card reads
it, so `load_dataset` returns the same rows with or without it.

checks() is what the export's validation.json and the claims verifier's release checks hold for it:

  - every file of `second_judges/` is the committed manifest's (bench/aacr/hf/second-judges.sha256),
    none missing, none extra, none differing;
  - every verdict table's `judge` column is the folder's label alone, and no published row carries it;
  - coverage: the folder's rows are exactly the published judge's rows of the arms, Martian runs and
    Qodo runs SPECS names for the label (the arm's `arms.judge` on AACR-Bench, gpt-6.1-sol on Martian
    and Qodo): no row missing, none extra, none repeated; `judgements` is one row per (arm, PR) the
    published judge has a verdict on;
  - the three scorers (score_verdicts.py, martian_scores.py, qodo_scores.py), run as the folder's
    README gives them, reproduce `scores/<part>.json` as an object and `scores/<part>.txt` byte for
    byte;
  - no third-party text: every verdict table has exactly its listed columns (ids, verdicts, the
    judge's own reasons and run figures; never a review, comment, golden or issue text).

claim_metrics.SecondJudge reads the same folder through the same scorers for the claims verifier
(`second_judge` keys). Tables are `.parquet` or `.jsonl` (the tests' fixtures).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from typing import Dict, List, Optional

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from tables import data_dir_of, load_table  # noqa: E402

FOLDER = "second_judges"
MANIFEST = os.path.join(os.path.dirname(HERE), "hf", "second-judges.sha256")
EXT_JUDGE = "gpt-6.1-sol"  # the published Martian and Qodo judge (heldout.QODO_JUDGE)

# What each label's folder re-judged: the reviewers of the repository README's full tables. The
# AACR-Bench arms in the order its README's scoring command passes them (score_verdicts --arms), the
# Martian and Qodo runs as (work_dir, tool). Coverage is checked against these, never against what
# the folder happens to hold.
SPECS: Dict[str, dict] = {
    "deepseek-v4.1-flash-1017": {
        "aacr_arms": ("quickreview-frozen", "pireview-panel-high-g61", "claude-code-opus55", "ocr-high-g61",
                      "codex-high-g61", "opencode-native-pr-g61", "pragent-g61"),
        "martian_runs": (("final1-martian50", "quickreview-frozen"), ("final1-martian50", "rejudged-qodo-extended-v2"),
                         ("final1-martian50", "rejudged-cubic-v2"), ("final1-martian50", "rejudged-claude-code"),
                         ("final1-ocr-martian50", "open-code-review"), ("final1-pragent-martian50", "pr-agent"),
                         ("final1-opencode-martian50", "opencode")),
        "qodo_runs": (("final1-qodo-pr100", "quickreview-frozen"), ("final1-opencode-qodo-pr100", "opencode"),
                      ("final1-ocr-qodo-pr100", "open-code-review"), ("final1-pragent-qodo-pr100", "pr-agent"),
                      ("ext-r6-qodo-pr100", "qodo-exhaustive"), ("ext-r6-qodo-pr100", "qodo-precise"),
                      ("ext-r6-qodo-pr100", "augment"), ("ext-r6-qodo-pr100", "copilot")),
    },
}

# Every verdict table of a folder, with exactly its columns: no column holds third-party text.
TABLES: Dict[str, Dict[str, tuple]] = {
    "aacr": {
        "defect_verdicts": ("arm_id", "instance_id", "defect_id", "verdict", "judge", "why"),
        "comment_verdicts": ("arm_id", "instance_id", "comment_id", "grade", "defect_id", "new_defect", "judge", "why"),
        "judgements": ("judge", "arm_id", "instance_id", "model", "effort_requested", "effort_used", "ok", "attempts",
                       "finish", "prompt_tokens", "completion_tokens", "usd", "error", "no_tools_system_line",
                       "prompt_sha256"),
    },
    "martian": {
        "martian_verdicts": ("work_dir", "tool", "pr_url", "golden_index", "matched", "judge"),
        "martian_reviews": ("work_dir", "tool", "pr_url", "fp", "judge"),
    },
    "qodo": {
        "qodo_verdicts": ("work_dir", "tool", "pr_url", "issue_index", "matched", "comment_index", "judge"),
    },
}
# the published tables a label must not already label (tables.with_judge refuses that too)
PUBLISHED_JUDGED = ("defect_verdicts", "comment_verdicts", "martian_verdicts", "martian_reviews", "martian_scores",
                    "qodo_verdicts")


def root_of(path: str) -> str:
    """The dataset root of a dataset dir or its data/ dir: the dir that holds data/ (and second_judges/)."""
    d = os.path.abspath(data_dir_of(path))
    return os.path.dirname(d) if os.path.basename(d) == "data" else d


def folder_of(path: str) -> str:
    return os.path.join(root_of(path), FOLDER)


def read_manifest(path: str = MANIFEST) -> Dict[str, str]:
    """{path relative to the dataset root: sha256} from a `sha256sum` file."""
    out: Dict[str, str] = {}
    with open(path) as f:
        for line in f:
            if line.strip():
                sha, _, rel = line.rstrip("\n").partition("  ")
                out[rel.lstrip("*")] = sha
    return out


def labels_of(manifest: Dict[str, str]) -> List[str]:
    return sorted({p.split("/")[1] for p in manifest if p.startswith(FOLDER + "/") and p.count("/") >= 2})


def manifest_problems(folder: str, manifest: Dict[str, str]) -> Dict[str, List[str]]:
    """The files of a `second_judges` folder against the manifest (paths `second_judges/...`): missing,
    extra and differing (sha256), each sorted."""
    have: Dict[str, str] = {}
    if os.path.isdir(folder):
        for root, _, files in os.walk(folder):
            for f in files:
                p = os.path.join(root, f)
                with open(p, "rb") as fh:
                    have[FOLDER + "/" + os.path.relpath(p, folder).replace(os.sep, "/")] = hashlib.sha256(fh.read()).hexdigest()
    return {"missing": sorted(set(manifest) - set(have)), "extra": sorted(set(have) - set(manifest)),
            "differs": sorted(p for p in set(have) & set(manifest) if have[p] != manifest[p])}


def columns_of(d: str, name: str) -> List[str]:
    pq_path = os.path.join(d, f"{name}.parquet")
    if os.path.exists(pq_path):
        import pyarrow.parquet as pq
        return list(pq.read_schema(pq_path).names)
    cols: Dict[str, None] = {}
    for r in load_table(d, name):
        cols.update(dict.fromkeys(r))
    return list(cols)


def _keys(rows: List[dict], fields: tuple) -> List[tuple]:
    return [tuple(r.get(f) for f in fields) for r in rows]


def _cover(published: List[tuple], mine: List[tuple]) -> Dict[str, int]:
    return {"missing": len(set(published) - set(mine)), "extra": len(set(mine) - set(published)),
            "repeated": len(mine) - len(set(mine))}


def coverage(data: str, sub: str, spec: dict) -> Dict[str, Dict[str, Dict[str, int]]]:
    """{part: {table: {missing, extra, repeated}}} of a label's folder `sub` against the published judge's rows."""
    arms = set(spec["aacr_arms"])
    judge = {a["arm_id"]: a.get("judge") or "gpt-6-sol-high" for a in load_table(data, "arms")}
    out: Dict[str, Dict[str, Dict[str, int]]] = {"aacr": {}, "martian": {}, "qodo": {}}
    aacr = os.path.join(sub, "aacr")
    pub_reviews = set()
    for table, idf in (("defect_verdicts", "defect_id"), ("comment_verdicts", "comment_id")):
        pub = [r for r in load_table(data, table) if r["arm_id"] in arms and r["judge"] == judge.get(r["arm_id"])]
        pub_reviews |= {(r["arm_id"], r["instance_id"]) for r in pub}
        out["aacr"][table] = _cover(_keys(pub, ("arm_id", "instance_id", idf)),
                                    _keys(load_table(aacr, table), ("arm_id", "instance_id", idf)))
    out["aacr"]["judgements"] = _cover(sorted(pub_reviews), _keys(load_table(aacr, "judgements"), ("arm_id", "instance_id")))
    for part, runs, tables in (("martian", spec["martian_runs"], (("martian_verdicts", ("pr_url", "golden_index")),
                                                                   ("martian_reviews", ("pr_url",)))),
                               ("qodo", spec["qodo_runs"], (("qodo_verdicts", ("pr_url", "issue_index")),))):
        want = {tuple(r) for r in runs}
        for table, rest in tables:
            fields = ("work_dir", "tool") + rest
            pub = [r for r in load_table(data, table) if (r["work_dir"], r["tool"]) in want and r["judge"] == EXT_JUDGE]
            out[part][table] = _cover(_keys(pub, fields), _keys(load_table(os.path.join(sub, part), table), fields))
    return out


def scorer_commands(root: str, label: str, spec: dict, out_dir: str) -> Dict[str, List[str]]:
    """The folder README's three scoring commands (each with --json <out_dir>/<part>.json; stdout is <part>.txt)."""
    v = os.path.join(root, FOLDER, label)
    py = [sys.executable, "-I"]
    return {
        "aacr": py + [os.path.join(HERE, "score_verdicts.py"), "--data", root, "--verdicts", os.path.join(v, "aacr"),
                      "--judge", label, "--arms", ",".join(spec["aacr_arms"]), "--json", os.path.join(out_dir, "aacr.json")],
        "martian": py + [os.path.join(HERE, "martian_scores.py"), "--data", root, "--verdicts", os.path.join(v, "martian"),
                         "--judge", label, "--json", os.path.join(out_dir, "martian.json")],
        "qodo": py + [os.path.join(HERE, "qodo_scores.py"), "--data", root, "--verdicts", os.path.join(v, "qodo"),
                      "--judge", label, "--json", os.path.join(out_dir, "qodo.json")],
    }


def reproduce(root: str, label: str, spec: dict) -> Dict[str, List[str]]:
    """{part: problems}: each scorer's output against the folder's scores/<part>.json (as an object) and
    scores/<part>.txt (byte for byte); a scorer that fails is a problem, never a pass."""
    scores = os.path.join(root, FOLDER, label, "scores")
    out: Dict[str, List[str]] = {}
    with tempfile.TemporaryDirectory(prefix="second-judge-scores-") as tmp:
        for part, cmd in scorer_commands(root, label, spec, tmp).items():
            bad: List[str] = []
            p = subprocess.run(cmd, capture_output=True)
            if p.returncode:
                bad.append(f"{os.path.basename(cmd[2])} failed (exit {p.returncode}): "
                           f"{p.stderr.decode(errors='replace').strip()[-300:]}")
            else:
                try:
                    with open(os.path.join(scores, f"{part}.txt"), "rb") as f:
                        if f.read() != p.stdout:
                            bad.append(f"scores/{part}.txt differs from the scorer's output")
                    with open(os.path.join(scores, f"{part}.json")) as f, open(os.path.join(tmp, f"{part}.json")) as g:
                        if json.load(f) != json.load(g):
                            bad.append(f"scores/{part}.json differs from the scorer's output")
                except (OSError, ValueError) as e:
                    bad.append(f"scores/{part}: {e}")
            out[part] = bad
    return out


def checks(root: str, manifest_path: str = MANIFEST, specs: Optional[Dict[str, dict]] = None) -> List[dict]:
    """The second judges' checks of validation.json (the module docstring), on a dataset root."""
    specs = SPECS if specs is None else specs
    root = root_of(root)
    folder = os.path.join(root, FOLDER)
    manifest = read_manifest(manifest_path)
    out: List[dict] = []

    def check(what, got, want):
        out.append({"check": what, "got": got, "want": want, "ok": got == want})

    check("second_judges: every file is the committed manifest's (bench/aacr/hf/second-judges.sha256), none "
          "missing, extra or differing",
          manifest_problems(folder, manifest), {"missing": [], "extra": [], "differs": []})
    for label in labels_of(manifest):
        sub = os.path.join(folder, label)
        spec = specs.get(label)
        if spec is None or not os.path.isdir(sub):
            why = f"no spec for {label} in second_judges.SPECS" if spec is None else f"no folder {FOLDER}/{label}"
            for what in ("judge column", "AACR-Bench coverage", "Martian coverage", "Qodo coverage",
                         "score_verdicts.py reproduces scores/aacr", "martian_scores.py reproduces scores/martian",
                         "qodo_scores.py reproduces scores/qodo", "columns"):
                check(f"second_judges/{label}: {what}", why, "")
            continue
        try:
            judges = {f"{part}/{t}": sorted({str(r.get("judge")) for r in load_table(os.path.join(sub, part), t)})
                      for part, ts in TABLES.items() for t in ts}
            used = sorted(t for t in PUBLISHED_JUDGED if any(r.get("judge") == label for r in load_table(root, t)))
            got_j = {"tables": {k: v for k, v in judges.items() if v != [label]}, "published_tables_with_label": used}
        except (SystemExit, OSError, ValueError) as e:
            got_j = {"error": str(e)}
        check(f"second_judges/{label}: every verdict table's judge column is the label alone, and no published "
              f"row carries it", got_j, {"tables": {}, "published_tables_with_label": []})
        try:
            cov = coverage(root, sub, spec)
        except (SystemExit, OSError, ValueError, KeyError) as e:
            cov = {p: {"error": str(e)} for p in ("aacr", "martian", "qodo")}
        zero = {"missing": 0, "extra": 0, "repeated": 0}
        for part, name, tables in (("aacr", "AACR-Bench", ("defect_verdicts", "comment_verdicts", "judgements")),
                                   ("martian", "Martian", ("martian_verdicts", "martian_reviews")),
                                   ("qodo", "Qodo", ("qodo_verdicts",))):
            check(f"second_judges/{label}: {name} rows are exactly the published judge's rows of the named "
                  f"{'arms' if part == 'aacr' else 'runs'} ({', '.join(tables)}): none missing, extra or repeated",
                  cov[part], {t: zero for t in tables})
        rep = reproduce(root, label, spec)
        for part, script in (("aacr", "score_verdicts.py"), ("martian", "martian_scores.py"), ("qodo", "qodo_scores.py")):
            check(f"second_judges/{label}: {script} on the folder reproduces scores/{part}.json (as an object) and "
                  f"scores/{part}.txt (byte for byte)", rep[part], [])
        try:
            cols = {f"{part}/{t}": c for part, ts in TABLES.items() for t, want in ts.items()
                    if sorted(c := columns_of(os.path.join(sub, part), t)) != sorted(want)}
        except (SystemExit, OSError, ValueError) as e:
            cols = {"error": str(e)}
        check(f"second_judges/{label}: every verdict table has exactly its listed columns (no review, comment, "
              f"golden or issue text)", cols, {})
    return out


def file_rows(root: str) -> List[tuple]:
    """(path under the dataset root, rows) of every verdict table of every second judge's folder present."""
    folder = os.path.join(root_of(root), FOLDER)
    out = []
    for label in sorted(os.listdir(folder)) if os.path.isdir(folder) else []:
        for part, ts in TABLES.items():
            for t in ts:
                d = os.path.join(folder, label, part)
                if os.path.exists(os.path.join(d, f"{t}.parquet")):
                    import pyarrow.parquet as pq
                    n = pq.ParquetFile(os.path.join(d, f"{t}.parquet")).metadata.num_rows
                    out.append((f"{FOLDER}/{label}/{part}/{t}.parquet", n))
                elif os.path.exists(os.path.join(d, f"{t}.jsonl")):
                    out.append((f"{FOLDER}/{label}/{part}/{t}.jsonl", len(load_table(d, t))))
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", required=True, help="the Hugging Face dataset dir (it holds data/ and second_judges/)")
    ap.add_argument("--manifest", default=MANIFEST)
    ap.add_argument("--json", help="also write the checks to this JSON file")
    a = ap.parse_args()
    cs = checks(a.data, a.manifest)
    for c in cs:
        print(f"{'ok  ' if c['ok'] else 'FAIL'} {c['check']}" + ("" if c["ok"] else f": got {c['got']}"))
    print(f"{sum(c['ok'] for c in cs)} of {len(cs)} pass")
    if a.json:
        with open(a.json, "w") as f:
            json.dump(cs, f, indent=1)
    sys.exit(0 if all(c["ok"] for c in cs) else 1)


if __name__ == "__main__":
    main()
