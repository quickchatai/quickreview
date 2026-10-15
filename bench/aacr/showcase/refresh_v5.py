#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""Record which model every drawn run used, into data/v5.json (v1-v4 data untouched).

    QCR_BENCH_RUNS_DIR=<runs dir> uv run bench/aacr/showcase/refresh_v5.py

v5 names the model beside every QuickReview result. It also says which model each tool we ran and each judge
used. This file reads all of them from the runs themselves:
  - a QuickReview run: its configured models, then every model it actually called.
      - configured: run.json `models` (the conversation and every lens tier), the `overrides` for models.default,
        models.overseer and per-lens pins, and each case's fingerprint `pass_models`;
      - called: every "model" and "provider" its cases' pi-events.jsonl record. A call to anything not configured
        stops this.
  - a third-party tool we ran: run.json `model`, with its `effort` (pi-review: `thinking`);
  - Claude Code: each case's case-summary.json `models` (its run.json points there);
  - the judges:
      - the defect key's: data/aacr.json `judge`, checked against every drawn run's judge directory;
      - AACR-Bench's own score's: each scored run's judge.txt;
      - Martian's and Qodo's: each scored directory's judge/JUDGE.txt;
  - the AACR key's sources (how-key):
      - the seed: the run whose comments seeded the key ("334 of the first 379"). FULL-BENCHMARK.md's table of the
        key's sources names it: QuickReview's default arm, all-default-rest145;
      - every reviewer run whose comments the key's builders checked: QuickReview's default and low arms and
        open-code-review (the first build), then Codex CLI, OpenCode, pi-review and Claude Code (its extension).
        FULL-BENCHMARK.md's run table names their rest145 runs;
  - the best-shot selection (how-fair's "lifted 3 rivals"): every fair-* run, the variants FULL-BENCHMARK.md §3
    picked each rival's configuration from.
Besides those, only the runs whose numbers the v5 images draw are read:
  - AACR-Bench: aacr-arms.txt and aacr-arms-v3.txt;
  - Martian: refresh_v4's Martian run, since the Martian charts draw Martian's own board plus QuickReview;
  - Qodo: the qodo-sources.txt rows that are our own reviews.
It stops whenever a run cannot be traced: among other cases, when the runs an arm lists disagree on the model, an
effort is not a known level, a run calls a model it is not configured for, a judge file does not parse, or a model
id has no name in data/models.json. So no image names a model it cannot trace to a run. The vendors' own reviews
carry no model here: their published runs record none.

The runs directory is only read. Nothing here calls a model.
"""
import argparse, collections, glob, json, os, re, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from refresh import read_specs  # noqa: E402
from refresh_v4 import MARTIAN_RUN  # noqa: E402  (the scored Martian run the v4 and v5 charts draw)

AACR_ARMS = ["aacr-arms.txt", "aacr-arms-v3.txt"]
KEY_SEED = "all-default-rest145"  # FULL-BENCHMARK.md, the v1 key's sources: "default's comments | 334"
# FULL-BENCHMARK.md: the reviewers whose comments the key's builders checked (v1: "quickreviewd default, quickreviewd low
# and OCR"; the v2 extension: "the four new reviewers"), with their rest145 runs from its run table
KEY_SOURCES = [("quickreview", [KEY_SEED]), ("quickreview low", ["all-low-rest145"]),
               ("open-code-review", ["all-ocr-rest145"]),
               ("codex-cli", ["all-codex-rest145"] + [f"all-codex-c{i}-rest145" for i in range(1, 5)]),
               ("opencode", ["all-opencode-rest145"] + [f"all-opencode-c{i}-rest145" for i in range(1, 5)]),
               ("pi-review", [f"all-pireview-c{i}-rest145" for i in range(1, 5)]),
               ("claude-code", [f"all-claude-c{i}-rest145" for i in range(1, 5)])]
BEST_SHOT = "fair-*-rest145"  # FULL-BENCHMARK.md §3: "Every variant ran once on those 40 PRs ... (runs `fair-*`)"
TOOL = {"codex": "codex-cli", "claude": "claude-code", "ocr": "open-code-review", "opencode": "opencode",
        "pragent": "pr-agent", "pireview": "pi-review"}  # run.json `reviewer` -> the showcase's tool id
EFFORTS = ["off", "none", "minimal", "low", "medium", "high", "xhigh", "max"]  # pi's levels, and OpenAI's "none"
JUDGE_TXT = re.compile(r"^\s*([\w.\-]+), reasoning effort (\w+)")  # judge/JUDGE.txt
OFFICIAL_TXT = re.compile(r"^`([^`]+)`.*?(\d+) round")  # <run>/judge.txt, AACR-Bench's own harness


def spec(s):
    """'openai-codex/gpt-6.1-sol:high' -> ('openai-codex', 'gpt-6.1-sol', 'high')."""
    provider, _, rest = s.rpartition("/")
    model, _, effort = rest.partition(":")
    return provider, model, effort


def called(d):
    """Every "model"/"provider" value the cases' pi-events.jsonl record: Counter of (key, value)."""
    files = sorted(glob.glob(os.path.join(d, "cases", "*", "pi-events.jsonl")))
    if not files:
        sys.exit(f"{d}: no pi-events.jsonl to count its calls")
    out = subprocess.run(["xargs", "-0", "-P", "8", "grep", "-ohE", '"(model|provider)":"[^"]+"'],
                         input="\0".join(files).encode(), capture_output=True)
    if out.returncode not in (0, 123) or out.stderr:  # 123: some file had no match
        sys.exit(f"{d}: counting calls failed: {out.stderr.decode()[:300]}")
    c = collections.Counter()
    for ln in out.stdout.decode().splitlines():
        k, _, v = ln.partition('":"')
        c[(k.strip('"'), v.rstrip('"'))] += 1
    return c


def run_models(runs_dir, run, calls=True):
    """One run's tool, models, reasoning efforts and providers; for QuickReview also its build and the models
    it called (calls=False skips the count, for a run only checked for its tool)."""
    d = os.path.join(runs_dir, run)
    r = json.load(open(os.path.join(d, "run.json")))
    if "models" in r:  # QuickReview: the conversation, every tier, the overrides and any per-lens pin
        specs = [r["models"]["conversation"], *r["models"]["tiers"].values()]
        for o in r.get("overrides", "").split(","):
            k, _, v = o.partition("=")
            if k in ("models.default", "models.overseer") or k.startswith("models.pass_models."):
                specs.append(v)
        for f in glob.glob(os.path.join(d, "cases", "*", "case-summary.json")):
            specs += list(((json.load(open(f)).get("fingerprint") or {}).get("pass_models") or {}).values())
        tool = "quickreview"
    elif r.get("reviewer") == "claude":  # run.json: "Claude Code's default for the credential (per case: ...)"
        specs = sorted({m for f in glob.glob(os.path.join(d, "cases", "*", "case-summary.json"))
                        for m in json.load(open(f)).get("models") or []})
        if not specs:
            sys.exit(f"{run}: no case-summary.json names a model")
        tool = TOOL["claude"]
    else:
        tool = TOOL.get(r.get("reviewer"))
        if tool is None:
            sys.exit(f"{run}: reviewer {r.get('reviewer')!r} is not one this file knows (TOOL)")
        effort = r.get("effort") or r.get("thinking") or ""
        specs = [f"{r['model']}:{effort}" if effort else r["model"]]
    parts = [spec(s) for s in specs]
    out = {"tool": tool, "models": sorted({m for _, m, _ in parts}),
           "efforts": sorted({e for _, _, e in parts if e}, key=lambda e: EFFORTS.index(e) if e in EFFORTS else -1),
           "providers": sorted({p for p, _, _ in parts if p})}
    unknown = [e for e in out["efforts"] if e not in EFFORTS]
    if unknown:
        sys.exit(f"{run}: unknown reasoning effort(s) {unknown}; known: {EFFORTS}")
    if tool == "quickreview":
        commit = r.get("qcr_commit") or ""
        out["build"] = commit[:7] + ("-dirty" if commit.endswith("-dirty") else "")
        if calls:
            c = called(d)
            models = {spec(v)[1] for (k, v) in c if k == "model"}
            providers = {v for (k, v) in c if k == "provider"} | {spec(v)[0] for (k, v) in c if k == "model" and "/" in v}
            if not models:
                sys.exit(f"{run}: its pi-events record no model call")
            if models - set(out["models"]) or providers - set(out["providers"]):
                sys.exit(f"{run}: called {sorted(models)} via {sorted(providers)}, but is configured for "
                         f"{out['models']} via {out['providers']}")
            out["calls"] = {m: sum(n for (k, v), n in c.items() if k == "model" and spec(v)[1] == m) for m in sorted(models)}
    return out


def arm(runs_dir, tool, runs):
    """What one drawn reviewer ran on, over every run it lists (they must agree on the model)."""
    per = {run: run_models(runs_dir, run) for run in runs}
    models = {tuple(v["models"]) for v in per.values()}
    if len(models) != 1:
        sys.exit(f"{tool}: its runs disagree on the model: " + "; ".join(f"{k} {v['models']}" for k, v in per.items()))
    out = {"runs": runs, "models": list(models.pop()),
           "efforts": sorted({e for v in per.values() for e in v["efforts"]}, key=EFFORTS.index),
           "providers": sorted({p for v in per.values() for p in v["providers"]})}
    builds = sorted({v["build"] for v in per.values() if v.get("build")})
    if builds:
        out["builds"] = builds
    if any("calls" in v for v in per.values()):
        out["calls"] = dict(sum((collections.Counter(v.get("calls", {})) for v in per.values()), collections.Counter()))
    return out


def judge_txt(path):
    """'gpt-6.1-sol, reasoning effort low, via ...' -> {model, effort}."""
    m = JUDGE_TXT.match(open(path).read())
    if not m:
        sys.exit(f"{path}: not a judge line")
    return {"model": m.group(1), "effort": m.group(2)}


def one(what, found):
    """The single value every source agrees on, or stop."""
    seen = {json.dumps(v, sort_keys=True) for v in found.values()}
    if len(seen) != 1:
        sys.exit(f"{what}: the runs disagree: {found}")
    return {**json.loads(seen.pop()), "from": sorted(found)}


def aacr(runs_dir):
    arms = [a for f in AACR_ARMS for a in read_specs(os.path.join(HERE, f))]
    judge = json.load(open(os.path.join(HERE, "data", "aacr.json")))["judge"]  # refresh.py's --judge-model
    model, _, effort = judge.rpartition("-")
    for tool, runs in arms:
        for run in runs:
            if not glob.glob(os.path.join(runs_dir, run, "judge", f"*{judge}")):
                sys.exit(f"aacr {tool}: {run} has no {judge} judge directory")
    # AACR-Bench's own score (aacr-leaderboard): every scored arm's runs carry the harness judge in judge.txt
    official = json.load(open(os.path.join(HERE, "data", "v3.json")))["official"]["aacr"]
    harness = {}
    for tool, runs in arms:
        if official.get(tool):
            for run in runs:
                m = OFFICIAL_TXT.match(open(os.path.join(runs_dir, run, "judge.txt")).readline())
                if not m:
                    sys.exit(f"aacr {tool}: {run}/judge.txt names no judge")
                _, jm, je = spec(m.group(1))
                harness[run] = {"model": jm, "effort": je, "rounds": int(m.group(2))}
    fair = sorted(os.path.basename(d) for d in glob.glob(os.path.join(runs_dir, BEST_SHOT)) if os.path.isdir(d))
    if not fair:
        sys.exit(f"aacr: no {BEST_SHOT} run for the best-shot selection")
    return {"judge": {"model": model, "effort": effort, "from": ["data/aacr.json judge; every drawn run's judge dir"]},
            "official_judge": one("AACR-Bench's own score judge", harness),
            "key_seed": arm(runs_dir, "key seed", [KEY_SEED]),
            "key_sources": {who: arm(runs_dir, who, runs) for who, runs in KEY_SOURCES},
            "best_shot": {run: run_models(runs_dir, run) for run in fair},
            "reviewers": {tool: arm(runs_dir, tool, runs) for tool, runs in arms}}


def martian(runs_dir):
    """The Martian charts draw Martian's own board (no model of ours) plus QuickReview's run."""
    run = MARTIAN_RUN.split(".")[0]
    return {"judge": one("martian judge", {MARTIAN_RUN: judge_txt(os.path.join(runs_dir, MARTIAN_RUN, "judge", "JUDGE.txt"))}),
            "reviewers": {"quickreview": arm(runs_dir, "quickreview", [run])}}


def qodo(runs_dir):
    """The Qodo rows that are our own reviews (a vendor's row, re-judged inside one of our scored directories, is
    not), and the judge of every scored directory the rows come from."""
    reviewers, judges = {}, {}
    for tool, (src,) in read_specs(os.path.join(HERE, "qodo-sources.txt")):
        scored, _, key = src.partition(":")
        judges[scored] = judge_txt(os.path.join(runs_dir, scored, "judge", "JUDGE.txt"))
        run = re.sub(r"\.qodo(-[\w-]+)?$", "", scored)
        mine = run_models(runs_dir, run, calls=False)["tool"]
        if mine == tool and (tool != "quickreview" or key == "quickreview"):
            reviewers[tool] = arm(runs_dir, tool, [run])
    return {"judge": one("qodo judge", judges), "reviewers": reviewers}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--runs-dir", default=os.environ.get("QCR_BENCH_RUNS_DIR"))
    a = ap.parse_args()
    if not a.runs_dir or not os.path.isdir(a.runs_dir):
        sys.exit("set QCR_BENCH_RUNS_DIR (or --runs-dir) to the benchmark runs directory")
    out = {"generated": time.strftime("%Y-%m-%d"), "aacr": aacr(a.runs_dir), "martian": martian(a.runs_dir),
           "qodo": qodo(a.runs_dir)}
    names = json.load(open(os.path.join(HERE, "data", "models.json")))["models"]
    used = {out["aacr"]["official_judge"]["model"]} | set(out["aacr"]["key_seed"]["models"])
    used |= {m for r in [*out["aacr"]["key_sources"].values(), *out["aacr"]["best_shot"].values()] for m in r["models"]}
    for b in ("aacr", "martian", "qodo"):
        used |= {out[b]["judge"]["model"]} | {m for r in out[b]["reviewers"].values() for m in r["models"]}
    missing = sorted(used - set(names))
    if missing:
        sys.exit(f"no name in data/models.json for: {', '.join(missing)}")
    path = os.path.join(HERE, "data", "v5.json")
    json.dump(out, open(path, "w"), indent=1, sort_keys=True)
    for b in ("aacr", "martian", "qodo"):
        j = out[b]["judge"]
        print(f"{b:8s} judge {j['model']} ({j['effort']})")
        rows = dict(out[b]["reviewers"])
        if b == "aacr":
            o = out[b]["official_judge"]
            print(f"{'':9s}own-score judge {o['model']} ({o['effort']}, {o['rounds']} rounds)")
            rows["(key seed)"] = out[b]["key_seed"]
            rows.update({f"(key source) {k}": v for k, v in out[b]["key_sources"].items()})
            rows.update({f"(best shot) {k}": v for k, v in out[b]["best_shot"].items()})
        for t, r in rows.items():
            calls = " ".join(f"{m}×{n}" for m, n in r.get("calls", {}).items())
            print(f"{'':9s}{t:20s} {', '.join(r['models']):18s} {'/'.join(r['efforts']):12s} "
                  f"{' '.join(r.get('builds', [])):14s} {calls}")
    print("wrote", os.path.relpath(path))


if __name__ == "__main__":
    main()
