#!/usr/bin/env python3
"""Compare judged benchmark arms on the SAME PRs — the table behind RESULTS.md.

    bench/aacr/compare.py --cases fresh10 "before=fresh10-off" "default=lean-fresh10" "low=low-fresh10"
    bench/aacr/compare.py --cases levers16 "default=lean-smoke10,lean-dev10,lean-holdout10"

An arm is NAME=run[,run...] (run dirs under $QCR_BENCH_RUNS_DIR, e.g. what
arm.sh produced). --cases names the PRs every arm is scored on: a set name,
`levers16`, or `all30`; a PR an arm has no judgement for is counted in the
PRs column, never silently dropped. Scores come only from the archived judge
files (judge/v<ground-truth version>-<judge model>/), so this never calls a
model. Defects found count a partial find as ½; weighted = high 3 / medium 2 /
low 1; $ is pi's own per-call price summed over the main session and every
pass. Standard library only.
"""
import argparse, collections, json, os, re, statistics, sys

HERE = os.path.dirname(os.path.abspath(__file__))
W = {"high": 3, "medium": 2, "low": 1}
LEVERS16 = {
    "smoke10": "cline__cline@7d18fb9 linera-io__linera-protocol@3535ddb lvgl__lvgl@4a57db3 ollama__ollama@b6002f6 dbeaver__dbeaver@bc3ac7b mrdoob__three.js@96ab072",
    "dev10": "CherryHQ__cherry-studio@83a2594 bluewave-labs__Checkmate@29e03a6 mpv-player__mpv@0729afe FreeCAD__FreeCAD@699b45c openai__codex@8c952af alibaba__spring-ai-alibaba@4bc7305",
    "holdout10": "libsdl-org__SDL@1526727 keycloak__keycloak@805c204 n8n-io__n8n@9321691 PowerShell__PowerShell@ec952ce",
}


def ground_truth(set_name):
    d = json.load(open(os.path.join(HERE, "defects", f"{set_name}.json")))
    return d["version"], {iid: {x["id"]: x["severity"] for x in c["defects"]} for iid, c in d["cases"].items()}


def cases_for(spec):
    """PR id -> (set, severities, judge-label version)."""
    sets = {"levers16": LEVERS16, "all30": {s: None for s in ("smoke10", "dev10", "holdout10")}}.get(spec, {spec: None})
    out = {}
    for s, ids in sets.items():
        version, gt = ground_truth(s)
        for iid in (ids.split() if ids else gt):
            out[iid] = (s, gt[iid], version)
    return out


def usd_and_minutes(case_dir):
    usd = 0.0
    ev = os.path.join(case_dir, "pi-events.jsonl")
    if os.path.exists(ev):
        for line in open(ev):
            if not line.startswith("{"):
                continue
            e = json.loads(line)
            if e.get("type") == "message_end" and (e.get("message") or {}).get("role") == "assistant":
                usd += ((e["message"].get("usage") or {}).get("cost") or {}).get("total") or 0
            elif e.get("type") == "tool_execution_end" and e.get("toolName") == "subagent":
                for r in ((e.get("result") or {}).get("details") or {}).get("results") or []:
                    c = (r.get("usage") or {}).get("cost")
                    usd += (c.get("total") if isinstance(c, dict) else c) or 0
    s = os.path.join(case_dir, "case-summary.json")
    mins = json.load(open(s)).get("duration_seconds", 0) / 60 if os.path.exists(s) else None
    return usd, mins


def score(runs_dir, runs, cases, judge_model):
    found, total, comments = collections.Counter(), collections.Counter(), collections.Counter()
    usd, mins, judged = [], [], set()
    for run in runs:
        for iid, (_, sevs, version) in cases.items():
            if iid in judged:
                continue
            f = os.path.join(runs_dir, run, "judge", f"v{version}-{judge_model}", f"{iid}.r1.json")
            if not os.path.exists(f):
                continue
            j = json.load(open(f))
            judged.add(iid)
            verdict = {d["id"]: d["verdict"] for d in j["defects"]}
            for did, sev in sevs.items():
                total[sev] += 1
                found[sev] += {"found": 1, "partial": 0.5}.get(verdict.get(did, "missed"), 0)
            for c in j["comments"]:
                comments[c["verdict"]] += 1
            u, m = usd_and_minutes(os.path.join(runs_dir, run, "cases", iid))
            usd.append(u)
            if m:
                mins.append(m)
    n, f = sum(total.values()), sum(found.values())
    wt = sum(W[s] * found[s] for s in W) / max(sum(W[s] * total[s] for s in W), 1)
    ct = sum(comments.values())
    correct = (comments["correct-valuable"] + comments["correct-minor"]) / max(ct, 1)
    sev = " | ".join(f"{found[s]:g}/{total[s]}" for s in W)
    return (f"{f:g}/{n} ({f / max(n, 1):.0%}) | {wt:.0%} | {sev} | {correct:.0%} | "
            f"${statistics.mean(usd) if usd else 0:.2f} | {statistics.median(mins) if mins else 0:.1f} | {len(judged)}/{len(cases)}")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--cases", required=True, help="a set name, levers16 or all30")
    ap.add_argument("--judge-model", default="gpt-6-sol-high", help="the judge label's model part")
    ap.add_argument("--runs-dir", default=os.environ.get("QCR_BENCH_RUNS_DIR", os.path.join(HERE, "runs")))
    ap.add_argument("arms", nargs="+", help="NAME=run[,run...]")
    a = ap.parse_args()
    cases = cases_for(a.cases)
    print(f"{len(cases)} PRs, {sum(len(v[1]) for v in cases.values())} defects ({a.cases})\n")
    print("| Arm | Found | Weighted | High | Medium | Low | Comments correct | $ / PR | Median min | PRs judged |")
    print("|---|---|---|---|---|---|---|---|---|---|")
    for arm in a.arms:
        name, _, runs = arm.partition("=")
        if not runs:
            sys.exit(f"arm {arm!r} is not NAME=run[,run...]")
        print(f"| {name} | {score(a.runs_dir, runs.split(','), cases, a.judge_model)} |")


if __name__ == "__main__":
    main()
