#!/usr/bin/env python3
"""How the AACR answer key was built, recounted from the key-building files the archive ships.

    python3 bench/aacr/recompute/key_build.py --archive <release>/archive --data <hf-dataset> \\
        [--work <scratch>] [--json OUT]

(`uv run --no-project --with pyarrow python ...` for the parquet tables.)

Reads the archive's `answer-key` volume, the per-PR files the key was built from:
  rest145-code/<id>/  candidates.json + candidates-key.json (the first key's reviewer comments,
                      C1..Cn, and the run that wrote each), hunt.json (the expert hunt's drafts and
                      its verdict on every AACR reference), truth.json (key v1), truth-current.json
                      and truth-ext.json (before and after the v2 extension), new-candidates.json +
                      new-candidates-key.json (the extension's comments, N1..Nn, and their reviewer);
  orig40-code/<id>/   the same extension files for the 40 original PRs;
and, for the credit-based checks, the Hugging Face tables `prs`, `defects` and `defect_verdicts`
(primary judge gpt-6-sol-high, a partial find ½). No model call.

Recomputes (keys of the JSON it writes):
  first_key      the first key's reviewer comments by run, v1 defects and exclusions by source,
                 the hunt's drafts and reference verdicts, the share of each run's comments that a v1
                 defect cites (benchmark.tex "Provenance on R145", METHODOLOGY.md, the key figure);
  prov           tab:prov: per source (each first-pass run, the hunt, the references) the v1 defects
                 it raised and those it alone raised; and the defects the hunt missed;
  extension      the v2 extension: candidates by reviewer, matched to an existing defect, excluded,
                 added (THREATS-TO-VALIDITY.md, METHODOLOGY.md, benchmark.tex);
  hunt_grade     the hunt's grade against the verifier's on every v1 defect the hunt raised, matched
                 to its draft by site overlap and text similarity (the analysis tree's prov.py rule),
                 with all matches and without the seven weakest;
  saturation     the union of defects after k of the seven reviewers, averaged over all 5,040 orders,
                 and each reviewer's mean marginal contribution, on R145;
  single_source  defects with one kind of source (hunt | references | reviewers), per half;
  loo            the leave-one-reviewer-out key on R145 (seven reviewers) and on all 185 PRs (the four
                 extension reviewers);
  own_seeding    the final comparison on a key without the defects whose only sources are
                 QuickReview's own earlier runs (factcheck_analyses.py (b)): the dropped defects, each
                 reviewer's recall on the rest, the default's lead over the panel with its paired
                 bootstrap interval (aacr_bootstrap.py's resamples and seed).
"""
from __future__ import annotations

import argparse
import collections
import itertools
import json
import os
import re
import sys
from pathlib import Path
from typing import Dict, List

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from archive import open_archive, read_json  # noqa: E402
from tables import load_table, percentile_ci  # noqa: E402
import aacr_bootstrap as AB  # noqa: E402

JUDGE = "gpt-6-sol-high"
CR = {"found": 1.0, "partial": 0.5}
RUN_ARM = {"all-default-rest145": "default", "all-low-rest145": "low", "all-ocr-rest145": "ocr"}
QR_RUNS = {"all-default-rest145", "all-low-rest145"}
# the seven reviewers of the earlier study: candidate-key name -> its gpt-6-sol study arm
STUDY = {"default": "quickreview-default-sol", "low": "quickreview-low-sol", "ocr": "ocr-medium-sol",
         "codex": "codex-medium-sol", "opencode": "opencode-bridge-sol", "pireview": "pireview-medium-sol",
         "claude": "claude-code-opus55"}
EXT = ("codex", "opencode", "pireview", "claude")
FINAL = ("quickreview-default-g61", "quickreview-low-g61", "pireview-panel-high-g61", "claude-code-opus55",
         "ocr-high-g61", "codex-high-g61", "opencode-native-pr-g61", "pragent-g61")
ORD = {"low": 0, "medium": 1, "high": 2}
WEAKEST_LEFT_OUT = 7  # benchmark.tex: "the seven weakest of the 241 matches were left out"


def _pct(a, b):
    return 100.0 * a / b if b else None


def _kappa(pairs, weighted=False):
    cats = ("high", "medium", "low")
    n = len(pairs)
    pa = collections.Counter(a for a, _ in pairs)
    pb = collections.Counter(b for _, b in pairs)
    w = (lambda a, b: 1 - abs(ORD[a] - ORD[b]) / 2) if weighted else (lambda a, b: 1.0 if a == b else 0.0)
    po = sum(w(a, b) for a, b in pairs) / n
    pe = sum(pa[a] * pb[b] * w(a, b) for a in cats for b in cats) / n / n
    return (po - pe) / (1 - pe)


def _sites(s):
    return (s["path"], int(s.get("from_line") or 0), int(s.get("to_line") or s.get("from_line") or 0))


def _overlap(a, b, slack=5):
    best = 0
    for p, f, t in map(_sites, a):
        for q, g, u in map(_sites, b):
            if p == q:
                best = max(best, 1)
                if f - slack <= u and g - slack <= t:
                    best = 2
    return best


def _toks(s):
    return set(re.findall(r"[a-z0-9_]{3,}", s.lower()))


class Key:
    def __init__(self, root: Path):
        self.root = root
        self.rest = sorted(os.listdir(root / "rest145-code"))
        self.orig = sorted(d for d in os.listdir(root / "orig40-code") if (root / "orig40-code" / d).is_dir())
        self._c = {}

    def j(self, half: str, iid: str, name: str):
        k = (half, iid, name)
        if k not in self._c:
            self._c[k] = read_json(self.root / f"{half}-code" / iid / name)
        return self._c[k]


def first_key(k: Key) -> dict:
    cand = collections.Counter()
    cited = collections.Counter()
    sev = collections.Counter()
    excl = collections.Counter()
    excl_run = collections.Counter()
    drafts = high = 0
    refv = collections.Counter()
    hunt_flag = 0
    nohunt = collections.Counter()
    nohunt_src = collections.Counter()
    for iid in k.rest:
        key = k.j("rest145", iid, "candidates-key.json")
        cand.update(RUN_ARM[r] for r in key.values())
        t = k.j("rest145", iid, "truth.json")
        cites = {str(c) for x in t["defects"] for c in x["provenance"]["reviewer_comments"]}
        cited.update(RUN_ARM[key[c]] for c in cites if c.startswith("C"))
        for e in t["excluded"]:
            s = str(e["source"])
            if s.startswith("C"):
                excl["reviewer"] += 1
                excl_run[RUN_ARM[key[s]]] += 1
            elif s.startswith("R"):
                excl["reference"] += 1
            elif s.startswith("H"):
                excl["hunt"] += 1
            else:
                excl["other"] += 1
        for x in t["defects"]:
            sev[x["severity"]] += 1
            p = x["provenance"]
            if p["hunt"]:
                hunt_flag += 1
            else:
                nohunt[x["severity"]] += 1
                src = "+".join(n for n, v in (("refs", p["dataset_refs"]), ("reviewers", p["reviewer_comments"])) if v)
                nohunt_src[src or "none"] += 1
        h = k.j("rest145", iid, "hunt.json")
        drafts += len(h["defects"])
        high += sum(1 for x in h["defects"] if x["severity"] == "high")
        refv.update(r["verdict"] for r in h["references"])
    n_v1 = sum(sev.values())
    return {"candidates": sum(cand.values()), "candidates_by_run": dict(cand),
            "cited_by_run": dict(cited),
            "mapped_pct_by_run": {r: _pct(cited[r], cand[r]) for r in cand},
            "v1_defects": n_v1, "v1_by_severity": dict(sev),
            "v1_exclusions": sum(excl.values()), "v1_exclusions_by_source": dict(excl),
            "v1_reviewer_exclusions_by_run": dict(excl_run),
            "hunt_drafts": drafts, "hunt_drafts_high": high,
            "hunt_refs_real": refv["defect"], "hunt_refs_rejected": refv["rejected"],
            "hunt_refs": sum(refv.values()),
            "hunt_raised": hunt_flag, "not_in_hunt": sum(nohunt.values()),
            "not_in_hunt_by_severity": dict(nohunt), "not_in_hunt_by_source": dict(nohunt_src),
            "hunt_missed_pct": {s: _pct(nohunt[s], sev[s]) for s in sev}}


def prov_table(k: Key) -> dict:
    """tab:prov: each source's v1 defects on R145 (truth.json), and those only it raised."""
    raised = collections.Counter()
    only = collections.Counter()
    n = 0
    for iid in k.rest:
        key = k.j("rest145", iid, "candidates-key.json")
        for x in k.j("rest145", iid, "truth.json")["defects"]:
            p = x["provenance"]
            srcs = set()
            if p["hunt"]:
                srcs.add("hunt")
            if p["dataset_refs"]:
                srcs.add("refs")
            for c in p["reviewer_comments"]:
                if str(c).startswith("C"):
                    srcs.add(RUN_ARM[key[str(c)]])
            n += 1
            raised.update(srcs)
            if len(srcs) == 1:
                only.update(srcs)
    return {"defects": n, "raised": dict(raised), "only": dict(only),
            "raised_pct": {s: _pct(v, n) for s, v in raised.items()}}


def extension(k: Key) -> dict:
    cand = collections.Counter()
    matched = set()
    to_added = set()
    excluded = collections.Counter()
    added = collections.Counter()
    added_by = collections.Counter()
    for half, ids in (("rest145", k.rest), ("orig40", k.orig)):
        for iid in ids:
            nkey = k.j(half, iid, "new-candidates-key.json")
            cand.update(nkey.values())
            cur = k.j(half, iid, "truth-current.json")
            te = k.j(half, iid, "truth-ext.json")
            have = {x["id"] for x in cur["defects"]}
            for x in te["defects"]:
                ns = {str(c) for c in x["provenance"]["reviewer_comments"] if str(c).startswith("N")}
                (matched if x["id"] in have else to_added).update((iid, c) for c in ns)
                if x["id"] not in have:
                    added[x["severity"]] += 1
                    added_by.update({nkey[c] for c in ns})
            old = {json.dumps(e, sort_keys=True) for e in cur.get("excluded", [])}
            excluded[half] += sum(1 for e in te["excluded"]
                                  if str(e["source"]).startswith("N") and json.dumps(e, sort_keys=True) not in old)
    return {"candidates": sum(cand.values()), "candidates_by_reviewer": dict(cand),
            "matched_existing": len(matched), "cited_by_added": len(to_added),
            "excluded": sum(excluded.values()), "excluded_by_half": dict(excluded),
            "added": sum(added.values()), "added_by_severity": dict(added), "added_raised_by": dict(added_by)}


def hunt_grade(k: Key) -> dict:
    pairs = []
    unmatched = 0
    flagged = 0
    for iid in k.rest:
        t = k.j("rest145", iid, "truth.json")
        h = k.j("rest145", iid, "hunt.json")["defects"]
        for x in t["defects"]:
            if not x["provenance"]["hunt"]:
                continue
            flagged += 1
            tx = _toks(x["title"] + " " + x["statement"])
            best, bs = None, 0.0
            for y in h:
                ty = _toks(y["title"] + " " + y["statement"])
                sc = _overlap(x["sites"], y["sites"]) * 1.0 + len(tx & ty) / max(1, len(tx | ty)) * 3 \
                    + (0.5 if y["id"] == x["id"] else 0)
                if sc > bs:
                    best, bs = y, sc
            if best is None or bs < 2.0:
                unmatched += 1
                continue
            pairs.append({"hunt": best["severity"], "verifier": x["severity"], "score": bs,
                          "pr": iid, "draft": best["id"], "defect": x["id"]})

    def summary(ps):
        sv = [(p["hunt"], p["verifier"]) for p in ps]
        conf = collections.Counter(f"{a}->{b}" for a, b in sv)
        same = sum(a == b for a, b in sv)
        drafts = collections.Counter((p["pr"], p["draft"]) for p in ps)
        return {"matches": len(ps), "same": same, "same_pct": _pct(same, len(ps)),
                "kappa": _kappa(sv), "kappa_linear": _kappa(sv, weighted=True),
                "raised": sum(ORD[b] > ORD[a] for a, b in sv), "lowered": sum(ORD[b] < ORD[a] for a, b in sv),
                "transitions": dict(conf), "drafts_split": sum(1 for v in drafts.values() if v > 1)}

    confident = sorted(pairs, key=lambda p: p["score"])[WEAKEST_LEFT_OUT:]
    return {"hunt_flagged": flagged, "unmatched": unmatched, "all": summary(pairs), "confident": summary(confident)}


def sources(k: Key) -> Dict[str, Dict[str, dict]]:
    """Per PR and defect of key v2 (truth-ext.json): hunt, refs, the reviewers that raised it, and on the
    original 40 whether an earlier-pool comment (whose run is not recorded) raised it."""
    out = {}
    for iid in k.rest:
        key = k.j("rest145", iid, "candidates-key.json")
        nkey = k.j("rest145", iid, "new-candidates-key.json")
        res = {}
        for x in k.j("rest145", iid, "truth-ext.json")["defects"]:
            p = x["provenance"]
            arms = set()
            runs = set()
            for c in map(str, p["reviewer_comments"]):
                if c.startswith("C"):
                    arms.add(RUN_ARM[key[c]])
                    runs.add(key[c])
                elif c.startswith("N"):
                    arms.add(nkey[c])
            res[x["id"]] = {"hunt": bool(p.get("hunt")), "refs": bool(p.get("dataset_refs")), "arms": arms,
                            "runs": runs, "earlier": False, "sev": x["severity"]}
        out[iid] = res
    for iid in k.orig:
        nkey = k.j("orig40", iid, "new-candidates-key.json")
        res = {}
        for x in k.j("orig40", iid, "truth-ext.json")["defects"]:
            p = x["provenance"]
            arms = set()
            earlier = False
            for c in map(str, p["reviewer_comments"]):
                if c.startswith("N"):
                    arms.add(nkey[c])
                else:
                    earlier = True
            res[x["id"]] = {"hunt": bool(p.get("hunt")), "refs": bool(p.get("dataset_refs")), "arms": arms,
                            "runs": set(), "earlier": earlier, "sev": x["severity"]}
        out[iid] = res
    return out


def saturation(k: Key, src) -> dict:
    defs = [s for iid in k.rest for s in src[iid].values()]
    arms = list(STUDY)
    base = sum(1 for s in defs if s["hunt"] or s["refs"])

    def union(pool):
        return sum(1 for s in defs if s["hunt"] or s["refs"] or (s["arms"] & pool))

    def rev_only(pool):
        return sum(1 for s in defs if s["arms"] & pool)

    perms = list(itertools.permutations(arms))
    curve = [0.0] * (len(arms) + 1)
    curve_r = [0.0] * (len(arms) + 1)
    marg = collections.defaultdict(float)
    for p in perms:
        pool = set()
        prev = base
        curve[0] += base
        for i, a in enumerate(p):
            pool.add(a)
            u = union(pool)
            curve[i + 1] += u
            marg[a] += u - prev
            prev = u
            curve_r[i + 1] += rev_only(pool)
    curve = [c / len(perms) for c in curve]
    curve_r = [c / len(perms) for c in curve_r]
    return {"defects": len(defs), "orders": len(perms), "hunt_or_refs": base,
            "union_after_k": curve, "marginal_step": [curve[i + 1] - curve[i] for i in range(len(arms))],
            "last_step_pct": _pct(curve[-1] - curve[-2], len(defs)),
            "reviewers_only_union_after_k": curve_r,
            "marginal_per_reviewer": {a: marg[a] / len(perms) for a in arms},
            "only_that_reviewer": {a: sum(1 for s in defs if not s["hunt"] and not s["refs"] and s["arms"] == {a})
                                   for a in arms}}


def single_source(k: Key, src) -> dict:
    def coarse(s):
        return int(s["hunt"]) + int(s["refs"]) + int(bool(s["arms"]) or s["earlier"])

    def share(vals):
        c = collections.Counter(vals)
        n = len(vals)
        return {"n": n, "single": c[1], "pct_single": _pct(c[1], n), "no_source": c[0]}

    def reviewer_only(ids):
        return sum(1 for i in ids for s in src[i].values()
                   if not s["hunt"] and not s["refs"] and (s["arms"] or s["earlier"]))

    return {"orig40_reviewer_only": reviewer_only(k.orig), "rest145_reviewer_only": reviewer_only(k.rest),
            "orig40": share([coarse(s) for i in k.orig for s in src[i].values()]),
            "rest145": share([coarse(s) for i in k.rest for s in src[i].values()]),
            "rest145_fine": share([int(s["hunt"]) + int(s["refs"]) + len(s["arms"])
                                   for i in k.rest for s in src[i].values()])}


def verdicts(dv: List[dict], arm: str) -> Dict[tuple, str]:
    return {(v["instance_id"], v["defect_id"]): v["verdict"] for v in dv if v["arm_id"] == arm and v["judge"] == JUDGE}


def loo(k: Key, src, dv) -> dict:
    v = {a: verdicts(dv, arm) for a, arm in STUDY.items()}

    def run(ids, arms):
        res = {}
        for a in arms:
            num = den = full = fd = 0.0
            for iid in ids:
                for did, s in src[iid].items():
                    c = CR.get(v[a].get((iid, did)), 0.0)
                    full += c
                    fd += 1
                    if s["hunt"] or s["refs"] or (s["arms"] - {a}) or s["earlier"]:
                        den += 1
                        num += c
            res[a] = {"loo_defects": int(den), "loo_recall": _pct(num, den), "full_recall": _pct(full, fd),
                      "delta_pts": _pct(num, den) - _pct(full, fd),
                      # the papers print the two recalls to 0.1 and quote the difference of the printed values
                      "delta_printed_pts": round(_pct(num, den), 1) - round(_pct(full, fd), 1)}
        return res

    r145 = run(k.rest, list(STUDY))
    all185 = run(k.rest + k.orig, list(EXT))
    deltas = [abs(x["delta_pts"]) for x in list(r145.values()) + list(all185.values())]
    return {"rest145": r145, "all185": all185, "max_abs_delta_pts": max(deltas),
            "all185_abs_printed_delta_min": min(abs(x["delta_printed_pts"]) for x in all185.values()),
            "all185_abs_printed_delta_max": max(abs(x["delta_printed_pts"]) for x in all185.values())}


def own_seeding(k: Key, prs: List[str], defects: List[dict], dv: List[dict]) -> dict:
    """factcheck_analyses.py (b): keep a defect when the hunt or an AACR reference raised it, or a comment of a
    reviewer other than QuickReview's earlier default and low runs; on the original 40 (no per-comment key)
    every reviewer-comment source counts as QuickReview's."""
    rest = set(k.rest)
    keep = {}
    for d in defects:
        iid, did = d["instance_id"], d["defect_id"]
        if d["provenance_hunt"] or d["provenance_dataset_refs"]:
            keep[(iid, did)] = True
            continue
        if iid not in rest:
            keep[(iid, did)] = False
            continue
        key = k.j("rest145", iid, "candidates-key.json")
        others = False
        for c in map(str, d["provenance_reviewer_comments"] or []):
            if c.startswith("C"):
                others |= key[c] not in QR_RUNS
            elif c.startswith("N"):
                others = True
            else:
                raise SystemExit(f"{iid} {did}: reviewer comment {c!r} is neither C nor N on R145")
        keep[(iid, did)] = others
    sev = {(d["instance_id"], d["defect_id"]): d["severity"] for d in defects}
    kept = [x for x, v in keep.items() if v]
    dropped = [x for x, v in keep.items() if not v]
    out = {"kept": len(kept), "dropped": len(dropped),
           "kept_by_severity": dict(collections.Counter(sev[x] for x in kept)),
           "dropped_by_severity": dict(collections.Counter(sev[x] for x in dropped)),
           "dropped_orig40": sum(1 for x in dropped if x[0] not in rest),
           "dropped_rest145": sum(1 for x in dropped if x[0] in rest), "recall": {}}
    for arm in FINAL:
        v = verdicts(dv, arm)
        f = sum(CR.get(v.get(x), 0.0) for x in kept)
        h = sum(CR.get(v.get(x), 0.0) for x in kept if sev[x] == "high")
        out["recall"][arm] = {"found": f, "recall": _pct(f, len(kept)), "high_found": h,
                              "high_recall": _pct(h, out["kept_by_severity"].get("high", 0)),
                              "credit_total": sum(CR.get(v.get(x), 0.0) for x in keep),
                              "credit_on_dropped": sum(CR.get(v.get(x), 0.0) for x in dropped)}
    kept_d = [d for d in defects if keep[(d["instance_id"], d["defect_id"])]]
    samples = AB.resamples(prs)
    per = {a: AB.per_pr(prs, kept_d, dv, a) for a in FINAL}
    base = FINAL[0]
    out["lead"] = {}
    for a in FINAL[1:]:
        diff = [AB.ratio(per[base], s, "recall") - AB.ratio(per[a], s, "recall") for s in samples]
        lo, hi = percentile_ci(diff)
        out["lead"][a] = {"diff": 100 * (AB.ratio(per[base], prs, "recall") - AB.ratio(per[a], prs, "recall")),
                          "lo": 100 * lo, "hi": 100 * hi}
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--archive", required=True, help="the release's archive/ dir (or an unpacked archive)")
    ap.add_argument("--data", required=True, help="the Hugging Face dataset dir (or its data/ dir)")
    ap.add_argument("--work", default=os.path.join(os.environ.get("TMPDIR", "."), "key-build"))
    ap.add_argument("--json")
    a = ap.parse_args()
    root = open_archive(a.archive, a.work, ["answer-key"])
    k = Key(root)
    prs = sorted(r["instance_id"] for r in load_table(a.data, "prs"))
    defects = load_table(a.data, "defects")
    dv = load_table(a.data, "defect_verdicts")
    src = sources(k)
    res = {"first_key": first_key(k), "prov": prov_table(k), "extension": extension(k), "hunt_grade": hunt_grade(k),
           "saturation": saturation(k, src), "single_source": single_source(k, src), "loo": loo(k, src, dv),
           "own_seeding": own_seeding(k, prs, defects, dv)}
    print(json.dumps(res, indent=1, default=sorted))
    if a.json:
        Path(a.json).write_text(json.dumps(res, indent=1, default=sorted) + "\n")


if __name__ == "__main__":
    main()
