#!/usr/bin/env python3
"""Compare judged benchmark arms on the SAME PRs — the table behind RESULTS.md.

    bench/aacr/compare.py --cases fresh10 "before=fresh10-off" "default=lean-fresh10" "low=low-fresh10"
    bench/aacr/compare.py --cases fresh10:id,id low=low-fresh10 default=default-fresh10 ocr=ocr-fresh10
    bench/aacr/compare.py --cases levers16 "default=lean-smoke10,lean-dev10,lean-holdout10"

An arm is NAME=run[,run...] (run dirs under $QCR_BENCH_RUNS_DIR, e.g. what
arm.sh produced); REPEATS of one arm are joined with '+', NAME=runs+runs, and
then the arm also gets a consistency line: agreement — of the defects
any repeat found, the share EVERY repeat found — and "found in every run"
recall, overall and for high severity. Defects the ground truth marks with a
`benchmark_limitation` (CI-gate defects a read-only review can only find by
knowing the repo's CI) are counted in the table as usual and also reported on
their own line. --cases names the PRs every arm is scored on: a set name,
`levers16`, or `all30`; a PR an arm has no judgement for is counted in the
PRs column, never silently dropped. Scores come only from the archived judge
files (judge/v<ground-truth version>-<judge model>/), so this never calls a
model. Defects found count a partial find as ½; weighted = high 3 / medium 2 /
low 1; $ is pi's own per-call price summed over the main session and every
pass (the OCR arm's bridge tokens at the same rates). Standard library only.

Two tables, both led by the NUMBER OF PROBLEMS FOUND — what the review is
for; rates follow it. The first is the defect benchmark (our judge, real
defects graded high/medium/low). The second, printed whenever an arm has a
`bench.sh eval` (arm.sh --eval), is AACR-Bench's own: references matched, its
recall/precision/F1, and recall by the benchmark's own labels — category and
context, from references.json (reference_index.py) — since its references
carry no severity. Both are restricted to the --cases PRs.

--exclude-refs FILE adds a third table: the AACR metric before → after
removing those references (bot_references.json: the 80 "human" references
that are rewritten review-bot comments), from the same round files
— recall over the kept references, and precision with a comment whose only
match was a removed reference counted as unmatched / dropped from the count.
"""
import argparse, collections, glob, hashlib, json, os, re, statistics, sys

HERE = os.path.dirname(os.path.abspath(__file__))
W = {"high": 3, "medium": 2, "low": 1}
# src/bench/cost.ts GPT6_SOL_USD_PER_MTOK — $ per million tokens, pi's price list.
GPT6_SOL = {"input": 2, "cacheRead": 0.2, "output": 10}
LEVERS16 = {
    "smoke10": "cline__cline@7d18fb9 linera-io__linera-protocol@3535ddb lvgl__lvgl@4a57db3 ollama__ollama@b6002f6 dbeaver__dbeaver@bc3ac7b mrdoob__three.js@96ab072",
    "dev10": "CherryHQ__cherry-studio@83a2594 bluewave-labs__Checkmate@29e03a6 mpv-player__mpv@0729afe FreeCAD__FreeCAD@699b45c openai__codex@8c952af alibaba__spring-ai-alibaba@4bc7305",
    "holdout10": "libsdl-org__SDL@1526727 keycloak__keycloak@805c204 n8n-io__n8n@9321691 PowerShell__PowerShell@ec952ce",
}


LIMITED = set()  # (iid, defect id) carrying a benchmark_limitation note
ERRORED = set()  # (run, iid) whose judgement is an error file — never scored as misses


def ground_truth(set_name):
    d = json.load(open(os.path.join(HERE, "defects", f"{set_name}.json")))
    for iid, c in d["cases"].items():
        for x in c["defects"]:
            if x.get("benchmark_limitation"):
                LIMITED.add((iid, x["id"]))
    return d["version"], {iid: {x["id"]: x["severity"] for x in c["defects"]} for iid, c in d["cases"].items()}


def cases_for(spec):
    """PR id -> (set, severities, judge-label version). `spec` is arm.sh's
    --cases syntax: groups joined by '+', each a set, set:id,id, levers16 or
    all30."""
    out = {}
    for group in spec.split("+"):
        if ":" in group:
            name, ids = group.split(":", 1)
            sets = {name: " ".join(ids.split(","))}
        else:
            sets = {"levers16": LEVERS16, "all30": {s: None for s in ("smoke10", "dev10", "holdout10")}}.get(group, {group: None})
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
    summary = json.load(open(s)) if os.path.exists(s) else {}
    b = summary.get("bridge")
    if not os.path.exists(ev) and b:
        # The OCR arm does not run through pi: its bridge's tokens at pi's
        # gpt-6-sol rates, exactly as src/bench/cost.ts prices them.
        inp = b.get("input_tokens") or 0
        cached = min(b.get("cached_tokens") or 0, inp)
        usd = ((inp - cached) * GPT6_SOL["input"] + cached * GPT6_SOL["cacheRead"] + (b.get("output_tokens") or 0) * GPT6_SOL["output"]) / 1e6
    if not os.path.exists(ev) and summary.get("arm") == "claude" and summary.get("cost_usd") is not None:
        # The Claude Code arm: its own total_cost_usd (API-price equivalent).
        usd = summary["cost_usd"]
    mins = summary["duration_seconds"] / 60 if "duration_seconds" in summary else None
    return usd, mins


def judgement(runs_dir, run, iid, version, judge_model):
    """One case's round-1 judgement in one run, or None (absent or errored)."""
    f = os.path.join(runs_dir, run, "judge", f"v{version}-{judge_model}", f"{iid}.r1.json")
    if not os.path.exists(f):
        return None
    j = json.load(open(f))
    if j.get("error"):
        ERRORED.add((run, iid))
        return None
    return j


def verdicts(runs_dir, runs, cases, judge_model):
    """(iid, defect) -> credit for one repeat of an arm; unjudged PRs are absent."""
    out = {}
    for iid, (_, sevs, version) in cases.items():
        for run in runs:
            j = judgement(runs_dir, run, iid, version, judge_model)
            if j is None:
                continue
            v = {d["id"]: d["verdict"] for d in j["defects"]}
            for did in sevs:
                out[(iid, did)] = {"found": 1, "partial": 0.5}.get(v.get(did, "missed"), 0)
            break
    return out


def consistency(repeats, cases):
    """Agreement and found-in-every-run across repeats judged on the same PRs."""
    keys = set.intersection(*(set(r) for r in repeats))
    dropped = len(set.union(*(set(r) for r in repeats)) - keys)
    sev = {(iid, did): s for iid, (_, sevs, _) in cases.items() for did, s in sevs.items()}
    lines = []
    for label, pick in (("all", lambda k: True), ("high", lambda k: sev[k] == "high")):
        ks = [k for k in keys if pick(k)]
        anyf = [k for k in ks if any(r[k] == 1 for r in repeats)]
        every = [k for k in ks if all(r[k] == 1 for r in repeats)]
        agree = len(every) / max(len(anyf), 1)
        lines.append(f"{label}: found in every run {len(every)}/{len(ks)} ({len(every) / max(len(ks), 1):.0%}), agreement {agree:.0%} of {len(anyf)} found by any")
    return "; ".join(lines) + (f" ({dropped} defect(s) left out: not judged in every repeat)" if dropped else "")


def score(runs_dir, runs, cases, judge_model):
    """One repeat's row. Every defect of every PR in --cases is in the
    denominator: a PR with no usable judgement counts as found nothing, and
    the PRs column says how many were actually judged."""
    found, total, comments = collections.Counter(), collections.Counter(), collections.Counter()
    usd, mins, judged = [], [], 0
    for iid, (_, sevs, version) in cases.items():
        for sev in sevs.values():
            total[sev] += 1
        for run in runs:
            j = judgement(runs_dir, run, iid, version, judge_model)
            if j is None:
                continue
            judged += 1
            verdict = {d["id"]: d["verdict"] for d in j["defects"]}
            for did, sev in sevs.items():
                found[sev] += {"found": 1, "partial": 0.5}.get(verdict.get(did, "missed"), 0)
            for c in j["comments"]:
                comments[c["verdict"]] += 1
            u, m = usd_and_minutes(os.path.join(runs_dir, run, "cases", iid))
            usd.append(u)
            if m:
                mins.append(m)
            break
    n, f = sum(total.values()), sum(found.values())
    wt = sum(W[s] * found[s] for s in W) / max(sum(W[s] * total[s] for s in W), 1)
    ct = sum(comments.values())
    correct = (comments["correct-valuable"] + comments["correct-minor"]) / max(ct, 1)
    sev = " | ".join(f"{found[s]:g}/{total[s]}" for s in W)
    incomplete = "" if judged == len(cases) else " INCOMPLETE"
    return (f"{f:g}/{n} | {f / max(n, 1):.0%} | {sev} | {wt:.0%} | {correct:.0%} | "
            f"${statistics.mean(usd) if usd else 0:.2f} | {statistics.median(mins) if mins else 0:.1f} | {judged}/{len(cases)}{incomplete}")


def build(runs_dir, runs):
    """The build each run was reviewed by (run.json qcr_commit), for the
    same-build check."""
    out = set()
    for run in runs:
        f = os.path.join(runs_dir, run, "run.json")
        if os.path.exists(f):
            r = json.load(open(f))
            out.add(str(r.get("qcr_commit") or (r.get("fingerprint") or {}).get("qcr_commit") or "unknown"))
    return out


CATEGORIES = ("Code Defect", "Maintainability and Readability", "Performance", "Security Vulnerability")
CONTEXTS = ("Diff Level", "File Level", "Repo Level")
REFS = None  # references.json: the benchmark's own label per reference


def ref_labels():
    global REFS
    if REFS is None:
        f = os.path.join(HERE, "references.json")
        REFS = json.load(open(f))["references"] if os.path.exists(f) else {}
    return REFS


def note_key(path, start, end, note):
    """reference_index.py's key for one harness reference."""
    h = hashlib.sha1(" ".join(str(note).split()).encode()).hexdigest()[:12]
    return f"{path}:{start}-{end}:{h}"


def aacr(runs_dir, runs, cases, exclude=frozenset()):
    """AACR-Bench's own metric for one repeat, from the harness's per-round
    files of the `all` variant, restricted to --cases: per reference, the
    share of judge rounds that semantically matched it; per PR, the comments
    the harness scored (for precision). Also the judge line each eval wrote,
    and — for --exclude-refs — the review comments whose only semantic match
    was an excluded reference (per PR, averaged over judge rounds; a comment
    is known by the `matched_note` the harness records on the reference)."""
    refs, generated, scored, judges = {}, 0, set(), set()
    only_excluded = 0.0
    for run in runs:
        d = os.path.join(runs_dir, run, "results", "all")
        # metrics_<reader>_*: ocr for every arm (a Claude Code run scored before its
        # `review` view existed has metrics_claude_*; its next eval clears them).
        rounds = [f for f in sorted(glob.glob(os.path.join(d, "metrics_*_*.json"))) if "average" not in f]
        per = collections.defaultdict(list)
        lone = collections.defaultdict(list)  # iid -> per round: comments matching only excluded refs
        for f in rounds:
            m = json.load(open(f))
            for inst in m.get("eval_res") or []:
                iid = inst["instance_id"]
                if iid not in cases or iid in scored:
                    continue
                kept, dropped = set(), set()
                for c in inst.get("comments") or []:
                    key = note_key(c["path"], c["from_line"], c["to_line"], c["note"])
                    per[(iid, key)].append(1 if c.get("semantic_match") else 0)
                    if c.get("semantic_match"):
                        (dropped if (iid, key) in exclude else kept).add(" ".join(str(c.get("matched_note") or "").split()))
                lone[iid].append(len(dropped - kept))
        got = {k[0] for k in per}
        only_excluded += sum(sum(v) / len(v) for v in lone.values() if v)
        for k, v in per.items():
            refs[k] = sum(v) / len(v)
        for iid in got:
            # The comments the harness scored for this PR: its result file.
            rf = os.path.join(d, f"{iid}.json")
            r = json.load(open(rf)) if os.path.exists(rf) else {}
            rows = (r.get("review") or {}).get("comments") or r.get("comments") or []
            if not rows and isinstance(r.get("review_output"), list):
                # A Claude Code result: the findings the harness's Claude reader scores.
                rows = [x for x in r["review_output"] if isinstance(x, dict)
                        and "\n".join(p for p in [(x.get("summary") or "").strip(), (x.get("failure_scenario") or "").strip()] if p)]
            generated += len(rows)
        if got and rounds:
            j = os.path.join(runs_dir, run, "judge.txt")
            judges.add(open(j).readline().strip() if os.path.exists(j) else "(no judge.txt)")
        scored |= got
    if exclude:
        return refs, generated, scored, judges, only_excluded
    return refs, generated, scored, judges


def aacr_row(refs, generated, scored, cases):
    labels = ref_labels()
    found = sum(refs.values())
    total = sum(len(labels.get(iid, {})) for iid in cases) or len(refs)
    p, r = found / max(generated, 1), found / max(total, 1)
    f1 = 2 * p * r / (p + r) if p + r else 0
    by = collections.Counter()
    n = collections.Counter()
    for iid in cases:
        for key, (cat, ctx) in labels.get(iid, {}).items():
            n[cat] += 1
            n[ctx] += 1
            by[cat] += refs.get((iid, key), 0)
            by[ctx] += refs.get((iid, key), 0)
    cols = " | ".join(f"{by[c]:.1f}/{n[c]}" for c in CATEGORIES + CONTEXTS)
    incomplete = "" if len(scored) == len(cases) else " INCOMPLETE"
    return (f"{found:.1f}/{total} | {r:.1%} | {p:.1%} ({generated} comments) | {f1:.1%} | {cols} | "
            f"{len(scored)}/{len(cases)}{incomplete}")


def excluded_refs(path):
    """--exclude-refs: {"references": {iid: {key: ...}}} (bot_references.json)
    -> the set of (iid, key)."""
    d = json.load(open(path))
    return frozenset((iid, k) for iid, v in d["references"].items() for k in v)


def prf(found, total, generated):
    p, r = found / max(generated, 1), found / max(total, 1)
    return r, p, (2 * p * r / (p + r) if p + r else 0)


def aacr_clean_row(refs, generated, only_excluded, cases, exclude):
    """Before / after removing the excluded references. After: recall over the
    kept references; precision two ways — the comments that matched only an
    excluded reference counted as unmatched (denominator unchanged), or
    dropped from the denominator (as if never written)."""
    labels = ref_labels()
    total = sum(len(labels.get(iid, {})) for iid in cases) or len(refs)
    gone = sum(1 for iid in cases for k in labels.get(iid, {}) if (iid, k) in exclude)
    found = sum(refs.values())
    kept = sum(v for k, v in refs.items() if k not in exclude)
    r0, p0, f0 = prf(found, total, generated)
    r1, p1, f1 = prf(kept, total - gone, generated)
    _, p2, f2 = prf(kept, total - gone, generated - only_excluded)
    return (f"{found:.1f}/{total} → {kept:.1f}/{total - gone} | {r0:.1%} → {r1:.1%} | "
            f"{p0:.1%} → {p1:.1%} / {p2:.1%} ({only_excluded:.1f} comments matched only a removed reference) | "
            f"{f0:.1%} → {f1:.1%} / {f2:.1%}")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--cases", required=True, help="arm.sh --cases syntax: groups joined by +, each a set, set:id,id, levers16 or all30")
    ap.add_argument("--judge-model", default="gpt-6-sol-high", help="the judge label's model part")
    ap.add_argument("--runs-dir", default=os.environ.get("QCR_BENCH_RUNS_DIR", os.path.join(HERE, "runs")))
    ap.add_argument("--aacr", action="store_true", help="print the AACR-Bench table even when no arm has been evaluated (it prints by itself when one has)")
    ap.add_argument("--exclude-refs", metavar="FILE", help="also print the AACR table with these references removed (bot_references.json: the bot-derived ones)")
    ap.add_argument("arms", nargs="+", help="NAME=run[,run...]")
    a = ap.parse_args()
    cases = cases_for(a.cases)
    print(f"{len(cases)} PRs, {sum(len(v[1]) for v in cases.values())} defects ({a.cases})\n")
    print("Defect benchmark (our judge: did the review find each real defect — what the review is built for)\n")
    print("| Arm | Problems found | Recall | High | Medium | Low | Weighted | Comments correct | $ / PR | Median min | PRs judged |")
    print("|---|---|---|---|---|---|---|---|---|---|---|")
    notes, builds = [], {}
    for arm in a.arms:
        name, _, spec = arm.partition("=")
        if not spec:
            sys.exit(f"arm {arm!r} is not NAME=run[,run...][+run[,run...]]")
        repeats = [r.split(",") for r in spec.split("+")]
        for k, runs in enumerate(repeats, 1):
            label = name if len(repeats) == 1 else f"{name} (run {k})"
            print(f"| {label} | {score(a.runs_dir, runs, cases, a.judge_model)} |")
        for runs in repeats:
            builds[name] = builds.get(name, set()) | build(a.runs_dir, runs)
        vs = [verdicts(a.runs_dir, runs, cases, a.judge_model) for runs in repeats]
        lim = [k for k in LIMITED if k[0] in cases]
        if lim:
            got = [sum(v.get(k, 0) for k in lim) for v in vs]
            notes.append(f"{name}: CI-gate defects (benchmark limitation) found {' / '.join(f'{g:g}' for g in got)} of {len(lim)}")
        if len(repeats) > 1:
            notes.append(f"{name} consistency — {consistency(vs, cases)}")
    if ERRORED:
        notes.append(f"{len(ERRORED)} judgement(s) are ERROR files, scored as not judged (re-run bench.sh judge --resume): "
                     + ", ".join(f"{r}/{i}" for r, i in sorted(ERRORED)))
    commits = set().union(*builds.values()) if builds else set()
    if len(commits) > 1:
        notes.append("arms were reviewed by DIFFERENT builds — "
                     + "; ".join(f"{k}: {', '.join(sorted(v))}" for k, v in builds.items()))
    # The benchmark's own metric, `all` variant (the only one the OCR arm
    # has): semantic matches against the dataset's references, scored by the
    # harness under whatever judge each run's `bench.sh eval` used — printed
    # whenever any arm has been evaluated.
    rows, judges = [], set()
    for arm in a.arms:
        name, _, spec = arm.partition("=")
        repeats = [r.split(",") for r in spec.split("+")]
        for k, runs in enumerate(repeats, 1):
            refs, gen, scored, js = aacr(a.runs_dir, runs, cases)
            judges |= js
            label = name if len(repeats) == 1 else f"{name} (run {k})"
            rows.append(f"| {label} | {aacr_row(refs, gen, scored, cases) if scored else 'not evaluated' + ' |' * 12 + f' 0/{len(cases)}'} |")
    if judges or a.aacr:
        print("\nAACR-Bench (the original benchmark: how closely the review reproduces its reference comments at the same lines; `all` variant, judge rounds averaged)\n")
        print("| Arm | References found | Recall | Precision | F1 | Code defect | Maintainability | Performance | Security | Diff level | File level | Repo level | PRs scored |")
        print("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
        print("\n".join(rows))
        if len(judges) > 1:
            notes.append("NOT COMPARABLE — the AACR evals used different judges: " + " / ".join(sorted(judges)))
        elif judges:
            notes.append(f"AACR judge: {judges.pop()}")
    if a.exclude_refs:
        exclude = excluded_refs(a.exclude_refs)
        gone = sum(1 for iid, k in exclude if iid in cases)
        print(f"\nAACR-Bench with {gone} references removed ({os.path.basename(a.exclude_refs)}); before → after. "
              "Precision and F1 after: a comment that matched only a removed reference counted as unmatched / dropped from the count\n")
        print("| Arm | References found | Recall | Precision | F1 |")
        print("|---|---|---|---|---|")
        for arm in a.arms:
            name, _, spec = arm.partition("=")
            repeats = [r.split(",") for r in spec.split("+")]
            for k, runs in enumerate(repeats, 1):
                refs, gen, scored, _, lone = aacr(a.runs_dir, runs, cases, exclude)
                label = name if len(repeats) == 1 else f"{name} (run {k})"
                print(f"| {label} | {aacr_clean_row(refs, gen, lone, cases, exclude) if scored else 'not evaluated | | | '} |")
    notes.append("How to read these tables, and why they can disagree: bench/aacr/METRICS.md")
    print()
    for n in notes:
        print(f"- {n}")


if __name__ == "__main__":
    main()
