#!/usr/bin/env python3
"""One judge for every tool on Qodo PR-Review-Bench — QuickReview and the nine
vendor runs Qodo published — so the comparison is apples to apples.

    qodo_judge.py --set SET.json --gt DATASET.jsonl [--tools TOOL-COMMENTS.json] \
        [--run RUN_DIR | --reviews QODO_REVIEWS --review-key WORK|TOOL] --endpoint URL --out WORK
        [--model M] [--judge-label L] [--resume] [--only-tools a,b] [--noise N] [--concurrency 8]

Qodo publishes no judge, prompt or scorer (the benchmark paper's section on Qodo), only the
rule its blog states: a hit is a comment that accurately describes a
ground-truth issue AND whose file/line points at the issue's source; any other
comment is a false positive; only inline comments are judged. This applies
that rule with one judge, identically to every tool: ours is gpt-6.1-sol
through ext_judge.py (the default --model); --model names another model on the
--endpoint and --judge-label the name its verdicts carry (default: the model):

  1. semantic match, by the judge: per PR and tool ONE request carrying the
     PR's ground-truth issues (title, description, file, lines, snippet) and
     the tool's inline comments (file, line, body); the judge returns which
     comment states which issue, one to one (a comment credits at most one
     issue, an issue at most one comment);
  2. location, deterministically here: the comment's file must be the issue's
     file and its line range must overlap the issue's range widened by N
     lines — N=5 is the primary score, N=∞ (same file) and "no location"
     (semantic only) are reported as sensitivities.

Per tool: precision = matched comments / comments, recall = matched issues /
issues, F1; recall split into functional issues (no rule_name) and rule
violations (rule_name). With --noise N the first N PRs are judged a second
time (fresh requests) and the two passes compared.

--out is one judge's work dir: an existing judgements.jsonl (an earlier run's,
or the run archive's) is refused unless --resume, and --resume refuses one
whose judgements carry another judge label (a row with none is gpt-6.1-sol's),
so two judges' verdicts never mix in one score.

--tools (qodo_scrape.py's vendor comments) is needed only to judge the vendors;
without it only the run's tool is judged.

--reviews reads the run's comments from the published `qodo_reviews` table
(.jsonl, or .parquet with pyarrow) instead of a run dir: the rows of
--review-key WORK|TOOL, exactly the list our judge was given (ours() below
re-reads a run dir with today's rules, which add back the deleted-line
comments the 2026-10-02 build's judging left out); the scores carry TOOL
unless --run-tool says otherwise.

--run-tool names the run's tool in the scores (default quickreview); a
third-party bench arm (PR-Agent, OpenCode, …) is read the same way — its
results/all/<id>.json carries the same `review.comments` view, the one the
AACR defect judge reads for that arm.

QuickReview's comments are what it would post, as the scored result file has
them (results/all/<id>.json — inline comments and the body findings that carry
a path and line), exactly as sweprbench_export.py reads them.
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

VENDORS = ["qodo-exhaustive", "qodo-precise", "augment", "copilot", "cursor", "greptile",
           "codex", "coderabbit", "sentry"]
MODEL = "gpt-6.1-sol"  # our judge; --model names another
BODY_MAX = 2500
SNIPPET_MAX = 600

SYSTEM = """You are the judge of a code-review benchmark. For one pull request you receive
(a) the benchmark's ground-truth ISSUES — real problems deliberately present in the
PR, each with an id, title, description, file, line range and the problematic code —
and (b) the review COMMENTS one review tool posted on that PR, each with an id, file,
line and text.

Decide which comment states which issue. A comment MATCHES an issue when it identifies
the same underlying problem: the same construct and the same failure or violation. A
different suggested fix still matches; a vaguer statement matches if a developer
reading it would fix the same problem; a comment that only mentions the same code
without naming the problem does NOT match, nor does one about a different problem in
the same lines. Ignore tone, length and severity labels. Judge only from the texts
given; do not reward confident wording.

Matching is one to one: each comment matches at most one issue and each issue at most
one comment — if several comments state the same issue, keep the one that states it
best. Most comments will match nothing; that is expected.

Answer with JSON only, no prose:
{"matches": [{"comment": "<comment id>", "issue": "<issue id>", "why": "<10 words>"}]}
Use an empty list when nothing matches."""


def sev_free(body: str) -> str:
    return body if len(body) <= BODY_MAX else body[:BODY_MAX] + " […]"


def ours(run: Path, instance_id: str) -> list[dict]:
    f = run / "results" / "all" / f"{instance_id}.json"
    if not f.exists():
        return []
    res = json.loads(f.read_text())
    out = []
    for c in (res.get("review") or {}).get("comments") or []:
        body = str(c.get("content") or "").strip()
        if body and c.get("path"):
            s = c.get("start_line")
            e = c.get("end_line") or s
            out.append({"path": c["path"], "start": s, "end": e, "body": body})
    # A run made before the bench re-anchored deleted-line comments excluded
    # them from results/all; read them back from the case (old-file line, so
    # only the file is trusted: start/end None — they can match on the
    # semantic and same-file rules, never on a line distance).
    seen = {o["body"] for o in out}
    cj = run / "cases" / instance_id / "comments.json"
    if cj.exists():
        for c in json.loads(cj.read_text() or "[]"):
            body = str(c.get("body") or "").strip()
            if c.get("side") == "LEFT" and body and c.get("path") and body not in seen:
                out.append({"path": c["path"], "start": None, "end": None, "body": body})
    return out


def published(path: Path, key: str) -> dict[str, list[dict]]:
    """--reviews: pr_url -> the comments of the `qodo_reviews` rows of WORK|TOOL, in their order."""
    work, sep, tool = key.partition("|")
    if not sep or not work or not tool:
        sys.exit(f"--review-key {key!r} is not WORK|TOOL")
    if path.suffix == ".parquet":
        import pyarrow.parquet as pq  # the published table; jsonl needs nothing
        rows = pq.read_table(path).to_pylist()
    else:
        rows = [json.loads(ln) for ln in path.read_text().splitlines() if ln.strip()]
    out: dict[str, list[dict]] = {}
    for r in rows:
        if r.get("work_dir") != work or r.get("tool") != tool:
            continue
        if r["pr_url"] in out:
            sys.exit(f"{path}: two {key} rows for {r['pr_url']}")
        cs = sorted(r.get("comments") or [], key=lambda c: c.get("index", 0))
        out[r["pr_url"]] = [{"path": c["path"], "start": c["start"], "end": c["end"], "body": c["body"]} for c in cs]
    if not out:
        sys.exit(f"{path}: no qodo_reviews rows for {key}")
    return out


def vendor(row: dict, tool: str) -> list[dict]:
    out = []
    for c in (row.get("tools", {}).get(tool) or {}).get("comments", []):
        if c.get("in_reply_to") or not (c.get("body") or "").strip() or not c.get("path"):
            continue
        e = c.get("line")
        s = c.get("start_line") or e
        out.append({"path": c["path"], "start": s, "end": e, "body": c["body"].strip()})
    return out


def ask(endpoint: str, issues: list[dict], comments: list[dict], tries: int = 4,
        model: str = MODEL) -> tuple[list[dict], dict]:
    user = json.dumps({
        "issues": [{"id": f"I{i}", "title": x["title"], "description": x["description"],
                    "file": x["file_path"], "lines": [x["start_line"], x["end_line"]],
                    "code": (x.get("problematic_code_snippet") or "")[:SNIPPET_MAX]} for i, x in enumerate(issues)],
        "comments": [{"id": f"C{i}", "file": c["path"], "line": c["end"] or c["start"],
                      "text": sev_free(c["body"])} for i, c in enumerate(comments)],
    }, ensure_ascii=False)
    req = {"model": model, "temperature": 0,
           "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}]}
    last = ""
    for t in range(tries):
        try:
            r = urllib.request.Request(endpoint, data=json.dumps(req).encode(),
                                       headers={"Content-Type": "application/json", "Authorization": "Bearer local"})
            with urllib.request.urlopen(r, timeout=600) as resp:
                d = json.loads(resp.read())
            text = d["choices"][0]["message"]["content"] or ""
            m = re.search(r"\{.*\}", text, re.S)
            parsed = json.loads(m.group(0)) if m else {}
            raw = parsed.get("matches")
            if not isinstance(raw, list):
                raise ValueError(f"no matches list: {text[:200]}")
            seen_c, seen_i, out = set(), set(), []
            for x in raw:
                c, i = str(x.get("comment", "")), str(x.get("issue", ""))
                if not re.fullmatch(r"C\d+", c) or not re.fullmatch(r"I\d+", i):
                    continue
                ci, ii = int(c[1:]), int(i[1:])
                if ci >= len(comments) or ii >= len(issues) or ci in seen_c or ii in seen_i:
                    continue
                seen_c.add(ci)
                seen_i.add(ii)
                out.append({"comment": ci, "issue": ii, "why": str(x.get("why", ""))[:200]})
            return out, {"usage": d.get("usage"), "tries": t + 1}
        except Exception as e:  # noqa: BLE001 — retried, then recorded
            last = repr(e)[:300]
            time.sleep(5 * (t + 1))
    return [], {"error": last, "tries": tries}


def norm(p: str) -> str:
    return (p or "").lstrip("./").lstrip("/")


def located(c: dict, x: dict, n: float) -> bool:
    if norm(c["path"]) != norm(x["file_path"]):
        return False
    if n == float("inf"):
        return True
    s = c["start"] if c["start"] is not None else c["end"]
    e = c["end"] if c["end"] is not None else s
    if s is None:
        return False
    lo, hi = min(s, e), max(s, e)
    return hi >= x["start_line"] - n and lo <= x["end_line"] + n


def effective(lines) -> list[dict]:
    """The pass-1 judgement per (PR, tool) that this judge's scoring stands on, from its
    append-only judgements.jsonl: the last record without an error, else the last record.
    A retry appends its replacement and never removes the errored record, so reading every
    line would count a review twice (hf_export.py and recompute/qodo_scores.py read it so)."""
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


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--set", required=True, type=Path)
    ap.add_argument("--gt", required=True, type=Path)
    ap.add_argument("--tools", type=Path, help="tool-comments.json from qodo_scrape.py build (the vendors' comments)")
    ap.add_argument("--run", type=Path, help="QuickReview run dir (omit to judge the vendors only)")
    ap.add_argument("--reviews", type=Path, help="the published qodo_reviews table (.jsonl or .parquet), instead of --run")
    ap.add_argument("--review-key", help="with --reviews: WORK|TOOL, the rows to judge")
    ap.add_argument("--endpoint", required=True)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--model", default=MODEL, help=f"the model asked on --endpoint (default {MODEL})")
    ap.add_argument("--judge-label", help="the name this judge's verdicts carry (default: --model)")
    ap.add_argument("--resume", action="store_true", help="continue the judgements already in --out (same judge)")
    ap.add_argument("--run-tool", help="the tool name the --run is scored under (default quickreview; "
                                       "with --reviews, the key's TOOL)")
    ap.add_argument("--only-tools", default="")
    ap.add_argument("--noise", type=int, default=0)
    ap.add_argument("--concurrency", type=int, default=8)
    a = ap.parse_args()
    label = a.judge_label or a.model
    if a.run and a.reviews:
        sys.exit("--run or --reviews: one source for the run's comments")
    if bool(a.reviews) != bool(a.review_key):
        sys.exit("--reviews and --review-key go together")
    a.run_tool = a.run_tool or (a.review_key.partition("|")[2] if a.review_key else "quickreview")
    if a.run_tool in VENDORS:
        sys.exit(f"--run-tool {a.run_tool} is a published vendor's name")
    pub = published(a.reviews, a.review_key) if a.reviews else None
    cache = a.out / "judgements.jsonl"
    if cache.exists() and not a.resume:
        sys.exit(f"{cache} exists (an earlier run's, or the run archive's): --resume continues it with the same "
                 "judge; a new judge or a fresh run needs a new --out")
    a.out.mkdir(parents=True, exist_ok=True)
    cases = json.loads(a.set.read_text())["cases"]
    gt = {r["pr_url_to_review"]: r for r in map(json.loads, a.gt.read_text().splitlines()) if r}
    ours_too = bool(a.run or pub)
    only = [t for t in a.only_tools.split(",") if t]
    tools = ([a.run_tool] if ours_too else []) + VENDORS
    if only:
        tools = [t for t in tools if t in only]
    if a.tools is None:
        wanted = [t for t in tools if t in VENDORS]
        if wanted and (only or not ours_too):
            sys.exit(f"judging {', '.join(wanted)} needs their comments: --tools (qodo_scrape.py build)")
        tools = [t for t in tools if t not in VENDORS]
    if not tools:
        sys.exit("nothing to judge: give --run or --reviews, and/or --tools")
    rows = {r["pr_url"]: r for r in json.loads(a.tools.read_text())} if a.tools else {}

    jobs = []
    for k, c in enumerate(cases):
        issues = gt[c["pr_url"]]["issues"]
        for t in tools:
            if t == a.run_tool and pub is not None:
                cm = pub.get(c["pr_url"], [])  # no row: the run posted nothing on this PR
            elif t == a.run_tool and a.run:
                cm = ours(a.run, c["instance_id"])
            else:
                cm = vendor(rows.get(c["pr_url"], {}), t)
            jobs.append((c["pr_url"], t, 1, issues, cm))
            if k < a.noise:
                jobs.append((c["pr_url"], t, 2, issues, cm))
    done = {}
    if cache.exists():
        for ln in cache.read_text().splitlines():
            j = json.loads(ln)
            if j.get("judge", MODEL) != label:  # a row from before labels is our judge's
                sys.exit(f"{cache} holds judgements by {j.get('judge', MODEL)}; this run's judge is {label}: "
                         "a new --out, so two judges' verdicts never mix")
            if "error" not in j["meta"]:
                done[(j["pr"], j["tool"], j["pass"])] = j
    # A cached judgement stands only for the comments it judged: a case that
    # was unfinished at an interim score (judged silent) or whose comments
    # changed since is asked again.
    todo = [j for j in jobs if (c := done.get((j[0], j[1], j[2]))) is None or c.get("comments") != j[4]]
    print(f"{len(jobs)} judgements ({len(jobs) - len(todo)} cached, {len(todo)} to ask), {len(tools)} tools, "
          f"judge {label}", flush=True)

    def run(job):
        pr, t, p, issues, cm = job
        if not cm:
            return {"pr": pr, "tool": t, "pass": p, "judge": label, "n_comments": 0, "matches": [],
                    "meta": {"empty": True}, "comments": []}
        m, meta = ask(a.endpoint, issues, cm, model=a.model)
        return {"pr": pr, "tool": t, "pass": p, "judge": label, "n_comments": len(cm), "matches": m, "meta": meta,
                "comments": cm}

    with open(cache, "a") as fh, cf.ThreadPoolExecutor(a.concurrency) as ex:
        for i, j in enumerate(ex.map(run, todo), 1):
            fh.write(json.dumps(j, ensure_ascii=False) + "\n")
            fh.flush()
            done[(j["pr"], j["tool"], j["pass"])] = j
            if i % 25 == 0 or i == len(todo):
                print(f"  {i}/{len(todo)}", flush=True)

    errors = [k for k, j in done.items() if "error" in j["meta"]]
    score(cases, gt, tools, done, a.out, errors, label)


def score(cases, gt, tools, done, out: Path, errors, judge: str = MODEL) -> None:
    n_issues = sum(len(gt[c["pr_url"]]["issues"]) for c in cases)
    n_rule = sum(1 for c in cases for x in gt[c["pr_url"]]["issues"] if x.get("rule_name"))
    variants = {"N=5": 5, "same file": float("inf"), "semantic only": None}
    res = {}
    for t in tools:
        res[t] = {}
        for vname, n in variants.items():
            tp_i, tp_c, comments, rule_hit, func_hit = 0, 0, 0, 0, 0
            for c in cases:
                j = done.get((c["pr_url"], t, 1))
                if not j:
                    continue
                issues = gt[c["pr_url"]]["issues"]
                comments += j["n_comments"]
                for m in j["matches"]:
                    x, cm = issues[m["issue"]], j["comments"][m["comment"]]
                    if n is None or located(cm, x, n):
                        tp_i += 1
                        tp_c += 1
                        if x.get("rule_name"):
                            rule_hit += 1
                        else:
                            func_hit += 1
            p = tp_c / comments if comments else 0.0
            r = tp_i / n_issues if n_issues else 0.0
            f = 2 * p * r / (p + r) if p + r else 0.0
            res[t][vname] = {"comments": comments, "per_pr": comments / len(cases), "tp": tp_i,
                             "precision": p, "recall": r, "f1": f,
                             "recall_functional": func_hit / (n_issues - n_rule) if n_issues - n_rule else 0.0,
                             "recall_rule": rule_hit / n_rule if n_rule else 0.0}
    # judge noise: pass 1 vs pass 2 on the doubled PRs (semantic matches)
    noise = {}
    for t in tools:
        a = b = same = 0
        for c in cases:
            j1, j2 = done.get((c["pr_url"], t, 1)), done.get((c["pr_url"], t, 2))
            if not (j1 and j2):
                continue
            s1 = {(m["comment"], m["issue"]) for m in j1["matches"]}
            s2 = {(m["comment"], m["issue"]) for m in j2["matches"]}
            a += len(s1)
            b += len(s2)
            same += len(s1 & s2)
        if a or b:
            noise[t] = {"pass1": a, "pass2": b, "agree": same}
    report = {"judge": judge, "prs": len(cases), "issues": n_issues, "rule_issues": n_rule,
              "errors": [list(e) for e in errors],
              "scores": res, "noise": noise}
    (out / "scores.json").write_text(json.dumps(report, indent=1))
    lines = [f"Qodo PR-Review-Bench, {len(cases)} PRs, {n_issues} issues ({n_rule} rule violations, "
             f"{n_issues - n_rule} functional); one judge ({judge}) for every tool; judge errors {len(errors)}", ""]
    for vname in variants:
        lines += [f"### Location rule: {vname}", "",
                  "| Tool | comments/PR | P | R | F1 | R functional | R rule |", "|---|---|---|---|---|---|---|"]
        for t in sorted(tools, key=lambda t: -res[t][vname]["f1"]):
            s = res[t][vname]
            lines.append(f"| {t} | {s['per_pr']:.1f} | {100*s['precision']:.1f} | {100*s['recall']:.1f} | "
                         f"{100*s['f1']:.1f} | {100*s['recall_functional']:.1f} | {100*s['recall_rule']:.1f} |")
        lines.append("")
    if noise:
        lines += ["### Judge noise (semantic matches, two independent passes)", "", "| Tool | pass 1 | pass 2 | in both |", "|---|---|---|---|"]
        for t, v in noise.items():
            lines.append(f"| {t} | {v['pass1']} | {v['pass2']} | {v['agree']} |")
    (out / "scores.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
