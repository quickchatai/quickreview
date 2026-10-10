#!/usr/bin/env python3
"""Per-lens yield over stored benchmark runs (docs/duplicate-merge.md, decision 10).

Analysis only: reads run dirs, their scoring, and the benchmarks' keys; runs no
review and no judge.

Counting is per ROOT CAUSE (a merge group), never per comment trailer — the
trailer credits every corroborating lens, so a per-comment count would let
"posted" exceed "raised" and give one lens two different unique counts.
A group is one lead finding of the findings
record (any disposition but merged/folded) plus every merged/folded entry
pointing at it — `merged_into` (new records), "MERGED x into F1" in the reason
(older ones), else the lead on the same path within 3 lines. Its RAISERS are
the union of the lenses of all its members.

For every lens:
  raised      groups the lens is a raiser of (posted or not)
  posted      posted groups the lens is a raiser of
  unique      posted groups the lens raised ALONE
  unique_real unique groups that are REAL by the benchmark's own key
  real        posted groups that are REAL, the lens among the raisers
  cost_usd    the lens's subagent cost (pi-events tool results, usage.cost)
  usd_per_unique_real

A posted group is matched to the benchmark's comment by path and line (within
3 lines), else by the comment's trailer lenses among the case's posted groups;
an unmatched comment counts as its own group with its trailer lenses.

REAL, per benchmark (a posted comment, matched by the benchmark's judge):
  aacr     judge/<label>/<case>.r1.json: the comment carries a key `defect`
  martian  the comment's extracted candidate is a judge TP on a golden the
           audit rated real (bench/aacr/ext/martian-tuning/golden-audit-full.json)
  qodo     <run>.qodo/judgements.jsonl (pass 1): the comment credits an issue
  swepr    <run>.sweprbench eval_results (config A): the comment is in a matched pair

  lens_yield.py --runs-dir DIR --run KIND:RUN [--run KIND:RUN ...] [--filter-set NAME ...] [--json OUT]
"""
from __future__ import annotations

import argparse
import collections
import glob
import json
import os
import re
from pathlib import Path

TRAILER = re.compile(r"·\s*lens\s+([^\n]+?)_?\s*$", re.M)
TIER = re.compile(r"--(terra|sol|luna)[-a-z]*$")


def lenses_of_text(body: str) -> list[str]:
    m = None
    for m in TRAILER.finditer(body or ""):
        pass
    if not m:
        return []
    return sorted(set(re.findall(r"pass-[a-z][a-z-]*[a-z]", m.group(1))))


def lens_list(v) -> list[str]:
    text = " ".join(map(str, v)) if isinstance(v, list) else str(v or "")
    return sorted(set(re.findall(r"pass-[a-z][a-z-]*[a-z]", text)))


def read_json(p):
    try:
        return json.load(open(p))
    except Exception:
        return None


INTO = re.compile(r"\binto\s+([A-Za-z0-9_.:-]+)")


def _line(v) -> int | None:
    try:
        return int(str(v).split("-")[0])
    except (TypeError, ValueError):
        return None


def case_groups(case: Path) -> list[dict]:
    """The case's root causes: [{lead, raisers, posted, path, line}]."""
    rec = read_json(case / "findings-record.json") or {}
    entries = [e for e in rec.get("findings") or [] if isinstance(e, dict)]
    leads = [e for e in entries if e.get("disposition") not in ("merged", "folded")]
    by_id = {str(e.get("id")): e for e in leads}
    groups = {id(e): {"lead": e, "raisers": set(lens_list(e.get("lens"))),
                      "posted": e.get("disposition") == "posted",
                      "path": e.get("path"), "line": _line(e.get("line"))} for e in leads}
    all_by_id = {str(e.get("id")): e for e in entries}
    for e in entries:
        if e.get("disposition") not in ("merged", "folded"):
            continue
        target, seen = None, set()
        ref = e.get("merged_into") or (INTO.search(str(e.get("reason") or "")) or [None, None])[1]
        while ref and ref not in seen:
            seen.add(ref)
            ref = str(ref).rstrip(".:,;")
            if ref in by_id:
                target = by_id[ref]
                break
            nxt = all_by_id.get(ref)
            ref = (nxt or {}).get("merged_into") or (INTO.search(str((nxt or {}).get("reason") or "")) or [None, None])[1]
        if target is None:
            ln = _line(e.get("line"))
            near = [g for g in leads if g.get("path") == e.get("path") and ln is not None
                    and _line(g.get("line")) is not None and abs(_line(g.get("line")) - ln) <= 3]
            target = near[0] if near else None
        if target is None:
            groups[id(e)] = {"lead": e, "raisers": set(lens_list(e.get("lens"))), "posted": False,
                             "path": e.get("path"), "line": _line(e.get("line"))}
        else:
            groups[id(target)]["raisers"] |= set(lens_list(e.get("lens")))
    return [g for g in groups.values() if g["raisers"]]


def match_comments(groups: list[dict], comments) -> list[tuple[set, bool]]:
    """(raisers, real) per posted root cause: comments matched onto posted
    groups by path+line (3), else trailer lenses; leftovers stand alone."""
    posted = [g for g in groups if g["posted"]]
    real = {id(g): False for g in posted}
    out = []
    for path, line, ls, r in comments:
        hit = None
        if path is not None and line is not None:
            near = [g for g in posted if g["path"] == path and g["line"] is not None and abs(g["line"] - line) <= 3]
            hit = min(near, key=lambda g: abs(g["line"] - line)) if near else None
        if hit is None and ls:
            cand = [g for g in posted if (path is None or g["path"] == path) and set(ls) <= g["raisers"]]
            hit = cand[0] if cand else None
        if hit is None:
            out.append((set(ls), bool(r)))
        else:
            real[id(hit)] = real[id(hit)] or bool(r)
    out.extend((g["raisers"], real[id(g)]) for g in posted)
    return out


def case_cost(case: Path) -> dict[str, float]:
    out: dict[str, float] = collections.defaultdict(float)
    p = case / "pi-events.jsonl"
    if not p.exists():
        return out
    for line in open(p, errors="replace"):
        if '"tool_execution_end"' not in line or "results" not in line:
            continue
        try:
            d = json.loads(line)
        except Exception:
            continue
        det = ((d.get("result") or {}).get("details") or {})
        for r in det.get("results") or []:
            agent = TIER.sub("", str(r.get("agent") or ""))
            u = r.get("usage") or {}
            c = u.get("cost")
            if isinstance(c, dict):
                c = c.get("total")
            if agent.startswith("pass-") and isinstance(c, (int, float)):
                out[agent] += float(c)
    return out


# ---- benchmark adapters: (case dir, [(lenses, real)]) -------------------------

def aacr_comments(runs: Path, run: str):
    jdirs = sorted(glob.glob(str(runs / run / "judge" / "*")))
    jdir = Path(jdirs[-1]) if jdirs else None
    for res in sorted(glob.glob(str(runs / run / "results" / "all" / "*.json"))):
        iid = Path(res).stem
        d = read_json(res) or {}
        comments = ((d.get("review") or {}).get("comments")) or []
        j = read_json(jdir / f"{iid}.r1.json") if jdir else None
        real_ids = {c.get("id") for c in (j or {}).get("comments", []) if c.get("defect")}
        out = [(c.get("path"), _line(c.get("start_line")), lenses_of_text(c.get("content", "")), f"C{i + 1}" in real_ids) for i, c in enumerate(comments)]
        yield runs / run / "cases" / iid, out


def qodo_comments(runs: Path, run: str, set_file: Path):
    by_pr = {c["pr_url"]: c["instance_id"] for c in json.load(open(set_file))["cases"]}
    # judgements.jsonl is append-only: a retry appends its replacement and
    # keeps the record it replaces. The judge scores the last record without
    # an error per PR, else the last record — one judgement per case.
    best: dict[str, dict] = {}
    for line in open(runs / f"{run}.qodo" / "judgements.jsonl"):
        if not line.strip():
            continue
        j = json.loads(line)
        if j.get("tool") != "quickreview" or j.get("pass", 1) != 1:
            continue
        prev = best.get(j["pr"])
        if prev is None or "error" in (prev.get("meta") or {}) or "error" not in (j.get("meta") or {}):
            best[j["pr"]] = j
    for j in best.values():
        matched = {m["comment"] for m in j.get("matches") or []}
        out = [(c.get("path"), _line(c.get("start")), lenses_of_text(c.get("body", "")), i in matched) for i, c in enumerate(j.get("comments") or [])]
        yield runs / run / "cases" / by_pr[j["pr"]], out


def swepr_comments(runs: Path, run: str, set_file: Path):
    by_task = {c["task_id"]: c["instance_id"] for c in json.load(open(set_file))["cases"]}
    base = glob.glob(str(runs / f"{run}.sweprbench" / "runs" / "*"))[0]
    for a in sorted(glob.glob(f"{base}/agent_outputs/*config_A*")):
        ao = read_json(a) or {}
        t = ao.get("task_id")
        # The harness's own credit: matched_pairs after its alignment (the
        # judge's raw CONFIRMED labels are only its first pass).
        ev = read_json(a.replace("agent_outputs", "eval_results").replace("_agent.json", "_eval.json")) or {}
        conf = {p.get("agent_comment_id") for p in ev.get("matched_pairs") or []}
        out = [(c.get("file_reference"), _line(c.get("line_reference")), lenses_of_text(c.get("body", "")), c.get("comment_id") in conf) for c in ao.get("comments") or []]
        yield runs / run / "cases" / by_task[t], out


def toks(s: str) -> set[str]:
    return set(re.findall(r"[a-z0-9_]{3,}", (s or "").lower()))


def martian_case(cases: dict, pr_url: str) -> str | None:
    """The run's case dir for one PR, by identity: the instance id is
    `<owner>__<repo>-<num>@<head7>` (bench/aacr/ext/martian_set.py). A PR with
    no case dir, or with more than one, is None — never another PR's case."""
    owner_repo, _, num = pr_url.removeprefix("https://github.com/").partition("/pull/")
    if not num.isdigit():
        return None
    prefix = f"{owner_repo.replace('/', '__')}-{int(num)}@"
    hits = [k for k in cases if Path(k).name.startswith(prefix)]
    return hits[0] if len(hits) == 1 else None


def martian_comments(runs: Path, run: str, audit: Path):
    real_golden = set()
    for a in json.load(open(audit)):
        f, s = a["first"]["verdict"], (a.get("second") or {}).get("verdict")
        REAL = {"REAL_DEFECT", "PARTLY_VALID"}
        if f in REAL and (s is None or s in REAL):
            real_golden.add((a["url"], a["golden"].strip()))
    res = runs / f"{run}.martian" / "results"
    cand = json.load(open(res / "gpt-6.1-sol" / "candidates.json"))
    ev = json.load(open(res / "gpt-6.1-sol" / "evaluations.json"))
    cases = {}
    for cd in glob.glob(str(runs / run / "cases" / "*")):
        cs = read_json(Path(cd) / "comments.json") or []
        cases[cd] = [(toks(c.get("body", "")), lenses_of_text(c.get("body", "")), c.get("path"), _line(c.get("line"))) for c in cs]
    for pr, v in cand.items():
        qc = v.get("quickreview") or []
        e = (ev.get(pr) or {}).get("quickreview") or {}
        tp = collections.defaultdict(set)
        for t in e.get("true_positives") or []:
            tp[t["matched_candidate"].strip()].add(t["golden_comment"].strip())
        cd = martian_case(cases, pr)
        if cd is None:
            continue
        items = cases[cd]
        real_idx = set()
        for c in qc:
            gs = tp.get(c["text"].strip(), set())
            if not any((pr, g) in real_golden for g in gs):
                continue
            ct = toks(c["text"])
            best = max(range(len(items)), key=lambda i: len(ct & items[i][0]) / max(1, len(ct | items[i][0])), default=None)
            if best is not None:
                real_idx.add(best)
        yield Path(cd), [(items[i][2], items[i][3], items[i][1], i in real_idx) for i in range(len(items))]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--runs-dir", default=os.environ.get("QCR_BENCH_RUNS_DIR", ""))
    ap.add_argument("--run", action="append", required=True, help="KIND:RUN, KIND in aacr|martian|qodo|swepr")
    ap.add_argument("--json")
    ap.add_argument("--cases-json", help="also write, per lens, the case dirs where it produced a unique REAL finding")
    ap.add_argument("--filter-set", action="append", default=[],
                    help="only cases of bench/aacr/sets/<NAME>.json (repeatable): compare runs on the same PRs")
    a = ap.parse_args()
    runs = Path(a.runs_dir)
    here = Path(__file__).resolve().parent
    stats = collections.defaultdict(lambda: collections.Counter())
    cost = collections.defaultdict(float)
    per_kind = collections.defaultdict(lambda: collections.defaultdict(collections.Counter))
    unique_real_cases = collections.defaultdict(set)
    allowed = None
    if a.filter_set:
        allowed = set()
        for name in a.filter_set:
            allowed |= {c["instance_id"] for c in json.load(open(here / "sets" / f"{name}.json"))["cases"]}
    for spec in a.run:
        kind, run = spec.split(":", 1)
        if kind == "aacr":
            it = aacr_comments(runs, run)
        elif kind == "qodo":
            it = qodo_comments(runs, run, here / "sets" / "qodo-pr100.json")
        elif kind == "swepr":
            it = swepr_comments(runs, run, here / "sets" / "sweprbench-eval100.json")
        elif kind == "martian":
            it = martian_comments(runs, run, here / "ext" / "martian-tuning" / "golden-audit-full.json")
        else:
            raise SystemExit(f"unknown kind {kind}")
        for case, comments in it:
            if allowed is not None and case.name not in allowed:
                continue
            groups = case_groups(case)
            for g in groups:
                for l in g["raisers"]:
                    stats[l]["raised"] += 1
                    per_kind[kind][l]["raised"] += 1
            for l, c in case_cost(case).items():
                cost[l] += c
                per_kind[kind][l]["cost_milli"] += int(c * 1000)
            for ls, real in match_comments(groups, comments):
                for l in ls:
                    stats[l]["posted"] += 1
                    per_kind[kind][l]["posted"] += 1
                    if real:
                        stats[l]["real"] += 1
                        per_kind[kind][l]["real"] += 1
                if len(ls) == 1:
                    (l,) = tuple(ls)
                    stats[l]["unique"] += 1
                    per_kind[kind][l]["unique"] += 1
                    if real:
                        stats[l]["unique_real"] += 1
                        per_kind[kind][l]["unique_real"] += 1
                        unique_real_cases[l].add(str(case))
    rows = []
    for l in sorted(set(stats) | set(cost)):
        s = stats[l]
        ur = s["unique_real"]
        rows.append({
            "lens": l, "raised": s["raised"], "posted": s["posted"], "real": s["real"],
            "unique": s["unique"], "unique_real": ur, "cost_usd": round(cost[l], 2),
            "usd_per_unique_real": round(cost[l] / ur, 2) if ur else None,
        })
    rows.sort(key=lambda r: (-r["unique_real"], -r["real"]))
    print("| lens | raised | posted | real | unique | unique real | cost $ | $ / unique real |")
    print("|---|---|---|---|---|---|---|---|")
    for r in rows:
        print(f"| {r['lens']} | {r['raised']} | {r['posted']} | {r['real']} | {r['unique']} | {r['unique_real']} | {r['cost_usd']} | {r['usd_per_unique_real'] if r['usd_per_unique_real'] is not None else '—'} |")
    if a.cases_json:
        json.dump({l: sorted(v) for l, v in unique_real_cases.items()}, open(a.cases_json, "w"), indent=1)
    if a.json:
        json.dump({"runs": a.run, "rows": rows,
                   "per_kind": {k: {l: dict(c) for l, c in v.items()} for k, v in per_kind.items()}},
                  open(a.json, "w"), indent=1)


if __name__ == "__main__":
    main()
