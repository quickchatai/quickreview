#!/usr/bin/env python3
"""bench/aacr/docs/DIGITALOCEAN.md's speed table and smoke figures, from the run files alone.

    python3 bench/aacr/recompute/do_speed.py --runs-dir <open-model runs> --gpt-runs-dir <runs> [--json OUT]

No model call; reads each case's `case-summary.json` and `pi-events.jsonl`.

"Why the open models take longer" — the same 10 PRs (sets glm-aacr1, glm-aacr-extra3,
glm-martian1, glm-martian-extra2, glm-qodo1, glm-qodo-extra2), one row per model:
  GPT-6.1 Sol  the frozen build's own cases of those PRs (final1-rest145, final1-martian50,
               final1-qodo-pr100 under --gpt-runs-dir)
  GLM-5.3 Flash         glm53-smoke-7879ddc5-1013-1822-<set>
  DeepSeek V4.1 Flash   dsv41f-smoke-ffa13988-1013-2125-<set>
  Gemma 4 31B           gemma4-smoke-d39d39dc-1013-1957-<set>
Every reply is an assistant message in the main session (message_end) or in a lens child's
transcript (launch_plan / subagent results). Its time is from its own timestamp (the request)
to the next message of the same transcript; a reply with no next message has no time.
  Minutes / PR       median of case duration_seconds / 60
  Output tokens / PR median over PRs of the summed `usage.output` of every reply
  Replies / PR       median over PRs of the replies that have a time
  Typical reply      median reply time, seconds
  Generation speed   median over timed replies of output tokens / reply time
  $ / PR             mean over PRs of the case's usage (input, output, cacheRead) at the model's
                     list price (openmodels/models.py; GPT-6.1 Sol at compare.py CODEX_RATES)

The GLM smoke paragraph ("10/10 reviews ok, ... $3.31 in total at list price, median 26.5
minutes per PR (mean 27.9), slowest 54 minutes") is glm53-smoke-p10-l12 over the same six sets,
counted as openmodels/gate.py counts it: status ok, every planned lens run and its final
attempt successful; dollars rounded to the cent per set, then summed; minutes per PR to one
decimal, their median and mean, and the slowest. (The text once printed the mean, 27.9, as
"median about 28".) Gemma's smoke ("9 of 10 PRs cleanly") is the same count on
its row's run.

"Review time limit" ("GLM-5.3 Flash's five slowest AACR reviews ... took 55-72 minutes"): the
five slowest reviews of the full GLM run (glm53-full-<set>) on AACR. The first attempt's
timeouts at 75 minutes happened in an attempt whose cases the resumed run re-reviewed in
place; no run file keeps them, so the text gives no count.
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
from pathlib import Path
from typing import Dict, List, Optional

HERE = os.path.dirname(os.path.abspath(__file__))
AACR = os.path.dirname(HERE)
sys.path.insert(0, AACR)
sys.path.insert(0, os.path.join(AACR, "openmodels"))
from models import MODELS  # noqa: E402
from lensfinal import events_file, lens as lens_name, lost as lost_lenses  # noqa: E402

SETS = ("glm-aacr1", "glm-aacr-extra3", "glm-martian1", "glm-martian-extra2", "glm-qodo1", "glm-qodo-extra2")
GPT_PRICE = {"input": 2.0, "output": 10.0, "cacheRead": 0.10}  # compare.py CODEX_RATES["gpt-6.1-sol"]
ROWS = (  # (row, model id for the price, run prefix; None = the frozen build's cases)
    ("GPT-6.1 Sol", None, None),
    ("GLM-5.3 Flash", "glm-5.3-flash", "glm53-smoke-7879ddc5-1013-1822"),
    ("DeepSeek V4.1 Flash", "deepseek-v4.1-flash", "dsv41f-smoke-ffa13988-1013-2125"),
    ("Gemma 4 31B", "gemma-4-31B-it", "gemma4-smoke-d39d39dc-1013-1957"),
)
FULL_GLM, AACR_SETS = "glm53-full", ("smoke10", "dev10", "holdout10", "fresh10", "rest145")
SMOKES = (("glm-5.3-flash", "glm53-smoke-p10-l12"), ("gemma-4-31B-it", "gemma4-smoke-d39d39dc-1013-1957"))


def gpt_parent(set_name: str) -> str:
    """The frozen build's run that holds a glm-* set's PRs (the sets were cut from these)."""
    return "final1-" + ("rest145" if "aacr" in set_name else "martian50" if "martian" in set_name else "qodo-pr100")


def set_ids(name: str, sets_dir: str) -> List[str]:
    with open(os.path.join(sets_dir, f"{name}.json")) as f:
        return [c["instance_id"] for c in json.load(f)["cases"]]


def transcripts(events: Path) -> List[List[dict]]:
    """The main session's messages, then each lens child's, in order."""
    main, kids = [], []
    with events_file(events).open() as f:
        for line in f:
            try:
                e = json.loads(line)
            except ValueError:
                continue
            if e.get("type") == "message_end" and isinstance(e.get("message"), dict):
                main.append(e["message"])
            elif e.get("type") == "tool_execution_end" and e.get("toolName") in ("launch_plan", "subagent"):
                for r in ((e.get("result") or {}).get("details") or {}).get("results") or []:
                    kids.append([m for m in r.get("messages") or [] if isinstance(m, dict)])
    return [main] + kids


def case_stats(case_dir: Path, price: Dict[str, float]) -> dict:
    s = json.loads((case_dir / "case-summary.json").read_text())
    u = s.get("usage") or {}
    out_tokens, timed = 0, []
    for t in transcripts(case_dir / "pi-events.jsonl"):
        for i, m in enumerate(t):
            if m.get("role") != "assistant":
                continue
            out = (m.get("usage") or {}).get("output") or 0
            out_tokens += out
            if i + 1 < len(t) and t[i + 1].get("timestamp") and m.get("timestamp"):
                secs = (t[i + 1]["timestamp"] - m["timestamp"]) / 1000
                if secs > 0:
                    timed.append((secs, out))
    return {"minutes": (s.get("duration_seconds") or 0) / 60, "output": out_tokens, "replies": len(timed),
            "timed": timed, "usd": sum((u.get(k) or 0) / 1e6 * p for k, p in price.items())}


def row(cases: List[Path], price: Dict[str, float]) -> dict:
    st = [case_stats(c, price) for c in cases]
    timed = [x for s in st for x in s["timed"]]
    return {"prs": len(st),
            "minutes": statistics.median(s["minutes"] for s in st),
            "output": statistics.median(s["output"] for s in st),
            "replies": statistics.median(s["replies"] for s in st),
            "reply_seconds": statistics.median(t for t, _ in timed),
            "reply_tokens": statistics.median(o for _, o in timed),
            "tok_per_s": statistics.median(o / t for t, o in timed),
            "usd": statistics.mean(s["usd"] for s in st)}


def smoke(runs_dir: Path, prefix: str, model: str, sets: List[str], sets_dir: str) -> dict:
    """gate.py's count over one smoke: ok PRs, $ (cents per set, summed), median and slowest minutes."""
    price = MODELS[model]["price"]
    ok, n, usd, mins = 0, 0, 0.0, []
    for s in sets:
        set_usd = 0.0
        for cid in set_ids(s, sets_dir):
            n += 1
            d = runs_dir / f"{prefix}-{s}" / "cases" / cid
            f = d / "case-summary.json"
            if not f.is_file():
                continue
            j = json.loads(f.read_text())
            planned = j.get("planned_lenses") or []
            ran = {lens_name(p) for p in j.get("executed_passes") or []}
            clean = (j.get("status") == "ok" and not (set(map(lens_name, planned)) - ran)
                     and not lost_lenses(planned, d / "pi-events.jsonl"))
            ok += clean
            u = j.get("usage") or {}
            set_usd += sum((u.get(k) or 0) / 1e6 * p for k, p in price.items())
            if j.get("duration_seconds"):
                mins.append(round(j["duration_seconds"] / 60, 1))
        usd += round(set_usd, 2)
    m = sorted(mins)
    return {"prefix": prefix, "prs": n, "ok": ok, "usd": round(usd, 2),
            "median_min": statistics.median(m) if m else None, "mean_min": statistics.mean(m) if m else None,
            "max_min": m[-1] if m else None}


def slowest(runs_dir: Path, prefix: str, sets, sets_dir: str, n: int = 5) -> list:
    """The n longest reviews of a run over sets: [(minutes to one decimal, case id)], slowest first."""
    out = []
    for s in sets:
        for cid in set_ids(s, sets_dir):
            f = runs_dir / f"{prefix}-{s}" / "cases" / cid / "case-summary.json"
            if f.is_file():
                out.append((round((json.loads(f.read_text()).get("duration_seconds") or 0) / 60, 1), cid))
    return sorted(out, reverse=True)[:n]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--runs-dir", required=True, type=Path, help="the open-model runs/ dir")
    ap.add_argument("--gpt-runs-dir", required=True, type=Path, help="the runs/ dir holding final1-*")
    ap.add_argument("--sets-dir", default=os.path.join(AACR, "sets"))
    ap.add_argument("--json", help="also write every number to this JSON file")
    a = ap.parse_args()
    res: Dict[str, Optional[dict]] = {"table": {}, "smokes": {}}
    print("| Model | Minutes / PR | Output tokens / PR | Replies / PR | Typical reply | Generation speed | $ / PR |")
    print("|---|---|---|---|---|---|---|")
    for name, model, prefix in ROWS:
        cases = []
        for s in SETS:
            for cid in set_ids(s, a.sets_dir):
                cases.append(a.gpt_runs_dir / gpt_parent(s) / "cases" / cid if prefix is None
                             else a.runs_dir / f"{prefix}-{s}" / "cases" / cid)
        missing = [str(c) for c in cases if not events_file(c / "pi-events.jsonl").is_file()]
        if missing:
            sys.exit(f"{name}: no transcript in {missing[:3]}")
        r = row(cases, GPT_PRICE if model is None else MODELS[model]["price"])
        res["table"][name] = r
        print(f"| {name} | {r['minutes']:.0f} | {r['output'] / 1000:.0f}k | {r['replies']:.0f} | "
              f"{r['reply_seconds']:.0f} s ({r['reply_tokens']:.0f} tok) | ~{r['tok_per_s']:.0f} tok/s | ${r['usd']:.2f} |")
    for model, prefix in SMOKES:
        s = smoke(a.runs_dir, prefix, model, list(SETS), a.sets_dir)
        res["smokes"][prefix] = s
        print(f"\nsmoke {prefix}: {s['ok']}/{s['prs']} clean, ${s['usd']:.2f} at list price, "
              f"median {s['median_min']:.1f} min (mean {s['mean_min']:.1f}), slowest {s['max_min']} min")
    slow = slowest(a.runs_dir, FULL_GLM, AACR_SETS, a.sets_dir)
    res["glm_full_slowest"] = slow
    print(f"\n{FULL_GLM} AACR, slowest reviews (minutes): " + ", ".join(f"{m} ({cid})" for m, cid in slow))
    if a.json:
        with open(a.json, "w") as f:
            json.dump(res, f, indent=1)


if __name__ == "__main__":
    main()
