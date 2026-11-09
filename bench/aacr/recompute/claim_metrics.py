"""Published numbers recomputed from the Hugging Face tables, by key.

bench/aacr/verify_claims.py asks this module for the value behind a claim of
bench/aacr/claims.json whose check is `aacr`, `key`, `martian`, `qodo`, `elo`,
`judges` or `second_judge`. No model call; the tables are read with
recompute/tables.py (parquet, or .jsonl fixtures). Every value is a plain number in the unit the papers print:
percentages are already x100, money in dollars, time in minutes.

Keys
----
aacr     ARM[@JUDGE][~SEL]:METRIC
         ARM an `arms.arm_id`; JUDGE defaults to the arm's AACR judge
         (gpt-6-sol-high, or gpt-6.1-sol-high for the open-model arms).
         SEL narrows the PRs (and so the key), `&`-joined:
           all (default) | own (the PRs the arm has a review of) | s40 | o145
           | set=a+b (the `prs.set` names) | lang=<language> | kind=<pr_category>
           | lines=<lo>-<hi> (change_line_count, inclusive) | arm=<arm id> (that arm's PRs) | pr=<instance id>[+<instance id>…]
           | refcat=<AACR reference category> (the aacr_* metrics over those references only)
           | rlabel=<label reality> (the aacr_* metrics over the labelled references of that reality only)
           | done=<arm id> (the PRs that arm's review completed, status ok) | run=<run> (the arm's reviews from that run)
           | size=<lo>-<hi> (insertions + deletions of the PR's diff.stat, the HF pr_diffstats, inclusive)
         ARM+ARM+...[@JUDGE][~SEL]:single_found|any_found  key defects found or partly found by exactly one / any arm
           | dset=indep (only defects the blind hunt or an AACR reference raised) | dkind=<defect kind>
           | dnotkind=<defect kind> | dset=limitation (the defects carrying a benchmark_limitation note)
         METRIC:
           found high medium low            credit found (partial 1/2)
           defects n_high n_medium n_low    the key's size on the PRs
           missed high_missed medium_missed low_missed
           recall high_rec medium_rec low_rec serious_rec weighted   (percent)
           full_only_rec                    recall counting a partial find as 0 (percent)
           partials                         verdicts graded partial
           graded correct valuable minor partly incorrect unverifiable mapped  (comment grades; percent of graded)
           per_pr                           graded comments per judged review
           new_defects new_per_pr new_per_100   comments the judge flagged as a possible defect missing from the key
           prs_with_defects                 PRs of the selection that hold at least one key defect
           comments                         sum of the reviews' n_comments
           reviews judged prs               rows, judged rows, distinct PRs
           usd usd_median usd_total         list cost of the judged reviews
           min_median min_mean              wall-clock minutes of the judged reviews
           usd_per_defect usd_per_high
           aacr_found aacr_refs aacr_comments aacr_recall aacr_precision aacr_f1
           aacr_found_nobot aacr_refs_nobot aacr_recall_nobot aacr_precision_nobot aacr_f1_nobot
             (AACR-Bench's own metric: references found = summed match shares)
key      METRIC[~SEL]  the answer key alone: defects n_high n_medium n_low prs exclusions refs bot_refs
         indep (defects the blind hunt or an AACR reference raised) extension, ext_high|ext_medium|ext_low
         (added by the key's v2 extension) prs_with_defects languages repos max_lines (the largest change) labels labelled_prs; SEL also takes dkind=<kind> and size=<lo>-<hi>
         refs_cited (AACR references some defect's provenance cites) cited_pct (of the references)
         label=<reality> (labelled references of that reality) bot=<bot> (bot-derived references of that bot)
         bot_prs ai_refs not_ai_refs label_starts ref_raised ref_raised_high (defects an AACR reference raised)
         cite_bot cite_bot_hunt (defects citing a bot-derived reference; of them, hunted)
         indep_reviewed indep_unreviewed (hunt-or-reference defects some reviewer also raised; none did)
         not_hunt[_high|_medium|_low|_reviewer_only|_ref] (defects the blind hunt did not raise)
         median_per_pr max_per_pr mean_per_pr  excl_src=<prefix> (exclusions whose candidate id starts so)
         one_source reviewer_only (defects with one kind of source: hunt, AACR reference or reviewer comments)
         SEL also takes v1 (leave out the defects the key's v2 extension added)
         size_median size_max (pr_diffstats changed lines) ai_or_bot_pct (references AI-written or bot-derived)
         unrunnable unrunnable_repo=<owner/repo> (sets/full.json PRs missing from the release's PRs)
judges   J1|J2|ARM+ARM+...[|sample=JUDGE]:METRIC   two defect judges on the same reviews (see Judges)
second_judge  LABEL/aacr/ARM:METRIC | LABEL/martian/WORK|TOOL:METRIC | LABEL/qodo/WORK|TOOL:METRIC
         a second judge's numbers from the dataset's second_judges/LABEL/ through the scorers (see SecondJudge)
martian  WORK[+WORK...]|TOOL[@JUDGE][~HALF]:METRIC  (JUDGE default gpt-6.1-sol; a published judge is
         "published: <model>", and WORK "-" names Martian's own published scores over all 50 PRs). METRIC: {core,strict,all}_{tp,fp,fn,precision,recall,f1,f2},
         the stored scores of one dir; with HALF (a set file, martian-tune20 or martian-test30) recounted on that
         half's PRs from the per-golden verdicts and per-PR false positives, and with several WORKs summed;
         real_found notreal_found disputed_found real_pct notreal_share, real_found~<set> (on one half),
         all_blocking all_blocking_real all_real (PRs in which every Critical/High golden, every real
         Critical/High one, every real one was matched) and their n_*_prs denominators,
         usd min_mean extracted comments_per_pr inline_per_pr prs
         goldens[~HALF]:real|notreal|disputed|total|prs|blocking|blocking_<bucket> (Critical/High goldens)
         dirs:<prefix>  the scoring dirs whose name starts with prefix and score quickreview; extracted_total
         dirsmax:<prefix>:METRIC  the best {core,strict,all}_* score of quickreview over those dirs (judge gpt-6.1-sol)
qodo     WORK|TOOL[@JUDGE]:METRIC  (JUDGE default gpt-6.1-sol; the comments are the judge-free qodo_reviews)
         METRIC: hits comments per_pr precision recall f1 recall_functional
         recall_rule (the primary rule, N=5), the same with _samefile or _semantic (no location), usd min_mean prs
         issues:total|functional|rule|prs|repos
elo      PLAN|TABLE|CATEGORY|RUN:elo|lo|hi|w|t|l|games|prs   (the published ratings table)
         PLAN:agreement   share of units both judges answered on which they name the same overall winner
         PLAN[@JUDGE]:judgments   judgments used in the ratings (of one judge: gpt, opus)
         PLAN|X|Y:w|l|t   X's overall record against Y over every used judgment
"""
from __future__ import annotations

import collections
import os
import statistics
import sys
from typing import Dict, List, Optional

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tables import load_table  # noqa: E402

SEVS = ("high", "medium", "low")
WEIGHT = {"high": 3, "medium": 2, "low": 1}
CREDIT = {"found": 1.0, "partial": 0.5}
GRADES = {"valuable": "correct-valuable", "minor": "correct-minor", "partly": "partly-correct",
          "incorrect": "incorrect", "unverifiable": "unverifiable"}


class KeyError_(Exception):
    """A key the provider cannot read: a fault of the manifest, never a number."""


def _mean(xs):
    return statistics.mean(xs) if xs else None


def _median(xs):
    return statistics.median(xs) if xs else None


def _pct(a, b):
    return 100.0 * a / b if b else None


def _f1(p, r):
    return 2 * p * r / (p + r) if p is not None and r is not None and p + r else (0.0 if p is not None and r is not None else None)


class Tables:
    def __init__(self, data: str):
        self.data = data
        self._t: Dict[str, List[dict]] = {}

    def __call__(self, name: str) -> List[dict]:
        if name not in self._t:
            self._t[name] = load_table(self.data, name)
        return self._t[name]


class Provider:
    def __init__(self, tables: Tables):
        self.t = tables
        self._cache: Dict[str, Optional[float]] = {}

    def value(self, key: str) -> Optional[float]:
        if key not in self._cache:
            self._cache[key] = self.compute(key)
        return self._cache[key]

    def compute(self, key: str) -> Optional[float]:  # pragma: no cover - abstract
        raise NotImplementedError


# ---------------------------------------------------------------- AACR

class Aacr(Provider):
    def __init__(self, tables: Tables):
        super().__init__(tables)
        self._idx = None

    def _index(self):
        if self._idx is None:
            prs = {p["instance_id"]: p for p in self.t("prs")}
            defects = {(d["instance_id"], d["defect_id"]): d for d in self.t("defects")}
            dv = collections.defaultdict(dict)
            for r in self.t("defect_verdicts"):
                dv[(r["arm_id"], r["judge"])][(r["instance_id"], r["defect_id"])] = r["verdict"]
            cv = collections.defaultdict(list)
            for r in self.t("comment_verdicts"):
                cv[(r["arm_id"], r["judge"])].append(r)
            rv = collections.defaultdict(list)
            for r in self.t("reviews"):
                rv[r["arm_id"]].append(r)
            arms = {a["arm_id"]: a for a in self.t("arms")}
            self._idx = (prs, defects, dv, cv, rv, arms)
        return self._idx

    def judge_of(self, arm: str) -> str:
        arms = self._index()[5]
        a = arms.get(arm)
        if a is None:
            raise KeyError_(f"no arm {arm!r} in the arms table")
        return a.get("judge") or "gpt-6-sol-high"  # the defect judge (aacr_judge is AACR-Bench's own metric's)

    def select(self, arm: str, sel: str):
        """(PR ids, defect filter or None)."""
        prs, defects, _, _, rv, _ = self._index()
        keep = set(prs)
        dfilter = None
        for part in [p for p in sel.split("&") if p and p != "all"]:
            k, _, v = part.partition("=")
            if k == "own":
                keep &= {r["instance_id"] for r in rv.get(arm, [])}
            elif k == "s40":
                keep &= {i for i, p in prs.items() if p["in_s40"]}
            elif k == "o145":
                keep &= {i for i, p in prs.items() if not p["in_s40"]}
            elif k == "set":
                names = set(v.split("+"))
                keep &= {i for i, p in prs.items() if p["set"] in names}
            elif k == "lang":
                keep &= {i for i, p in prs.items() if p["language"] == v}
            elif k == "pr":
                keep &= set(v.split("+"))
            elif k == "kind":
                keep &= {i for i, p in prs.items() if p["pr_category"] == v}
            elif k == "lines":
                lo, _, hi = v.partition("-")
                keep &= {i for i, p in prs.items()
                         if (p["change_line_count"] or 0) >= float(lo) and (not hi or (p["change_line_count"] or 0) <= float(hi))}
            elif k == "size":
                lo, _, hi = v.partition("-")
                size = {r["instance_id"]: r["changed_lines"] for r in self.t("pr_diffstats")}
                keep &= {i for i in prs if size.get(i) is not None and size[i] >= float(lo) and (not hi or size[i] <= float(hi))}
            elif k == "rlabel":
                pass  # a reference label's reality; read by the aacr_* metrics
            elif k == "run":  # the PRs whose review of this arm came from that run
                keep &= {r["instance_id"] for r in rv.get(arm, []) if r["run"] == v}
            elif k == "done":  # the PRs that arm's review completed (status ok; not timed out or failed)
                if v not in self._index()[5]:
                    raise KeyError_(f"selector done={v}: no such arm")
                keep &= {r["instance_id"] for r in rv.get(v, []) if r["status"] == "ok"}
            elif k == "arm":
                if v not in self._index()[5]:
                    raise KeyError_(f"selector arm={v}: no such arm")
                keep &= {r["instance_id"] for r in rv.get(v, [])}
            elif k == "dset" and v == "indep":
                dfilter = lambda d: bool(d["provenance_hunt"] or d["provenance_dataset_refs"])  # noqa: E731
            elif k == "dkind":
                dfilter = lambda d, v=v: d["kind"] == v  # noqa: E731
            elif k == "dnotkind":
                dfilter = lambda d, v=v: d["kind"] != v  # noqa: E731
            elif k == "refcat":
                pass  # AACR-Bench's reference category; read by the aacr_* metrics
            elif k == "dset" and v == "limitation":
                dfilter = lambda d: bool(d.get("benchmark_limitation"))  # noqa: E731
            else:
                raise KeyError_(f"unknown selector {part!r}")
        return keep, dfilter

    def compute(self, key: str) -> Optional[float]:
        head, _, metric = key.rpartition(":")
        if not head:
            raise KeyError_(f"aacr key {key!r} has no metric")
        head, _, sel = head.partition("~")
        if "+" in head.partition("@")[0]:
            return self._multi(head, sel, metric)
        arm, _, judge = head.partition("@")
        judge = judge or self.judge_of(arm)
        prs_, defects, dv, cv, rv, arms = self._index()
        if arm not in arms:
            raise KeyError_(f"no arm {arm!r}")
        keep, dfilter = self.select(arm, sel)
        key_defects = {k: d["severity"] for k, d in defects.items() if k[0] in keep and (dfilter is None or dfilter(d))}
        verdicts = dv.get((arm, judge), {})
        found = collections.Counter()
        full = collections.Counter()
        total = collections.Counter(key_defects.values())
        partials = 0
        for k, sev in key_defects.items():
            v = verdicts.get(k)
            found[sev] += CREDIT.get(v, 0.0)
            full[sev] += 1.0 if v == "found" else 0.0
            partials += v == "partial"
        n = sum(total.values())
        f = sum(found.values())
        reviews = [r for r in rv.get(arm, []) if r["instance_id"] in keep]
        judged = [r for r in reviews if r["judged"]]
        graded = [c for c in cv.get((arm, judge), []) if c["instance_id"] in keep]
        sev_metric = {"found": f, "high": found["high"], "medium": found["medium"], "low": found["low"],
                      "defects": n, "n_high": total["high"], "n_medium": total["medium"], "n_low": total["low"],
                      "missed": n - f, "high_missed": total["high"] - found["high"],
                      "medium_missed": total["medium"] - found["medium"], "low_missed": total["low"] - found["low"],
                      "recall": _pct(f, n), "high_rec": _pct(found["high"], total["high"]),
                      "medium_rec": _pct(found["medium"], total["medium"]), "low_rec": _pct(found["low"], total["low"]),
                      "serious_rec": _pct(found["high"] + found["medium"], total["high"] + total["medium"]),
                      "weighted": _pct(sum(WEIGHT[s] * found[s] for s in SEVS), sum(WEIGHT[s] * total[s] for s in SEVS)),
                      "full_only_rec": _pct(sum(full.values()), n), "partials": partials}
        if metric in sev_metric:
            return sev_metric[metric]
        if metric == "prs_with_defects":
            return len({k[0] for k in key_defects})
        if metric in ("new_defects", "new_per_pr", "new_per_100"):
            nd = sum(1 for c in graded if c.get("new_defect"))
            return {"new_defects": nd, "new_per_pr": nd / len(judged) if judged else None,
                    "new_per_100": _pct(nd, len(graded))}[metric]
        if metric == "graded":
            return len(graded)
        if metric in GRADES:
            return _pct(sum(1 for c in graded if c["grade"] == GRADES[metric]), len(graded))
        if metric == "correct":
            return _pct(sum(1 for c in graded if c["grade"] in ("correct-valuable", "correct-minor")), len(graded))
        if metric == "mapped":
            return _pct(sum(1 for c in graded if c["defect_id"]), len(graded))
        if metric == "per_pr":
            return len(graded) / len(judged) if judged else None
        if metric == "comments":
            return sum(r["n_comments"] or 0 for r in judged)
        if metric == "reviews":
            return len(reviews)
        if metric == "judged":
            return len(judged)
        if metric == "prs":
            return len({r["instance_id"] for r in reviews})
        costs = [r["cost_usd"] for r in judged if r["cost_usd"] is not None]
        mins = [r["minutes"] for r in judged if r["minutes"]]
        if metric in ("usd", "usd_median", "usd_total", "usd_per_defect", "usd_per_high"):
            if len(costs) != len(judged) or not costs:
                return None  # a judged review with no cost: unknown, never a smaller mean
            tot = sum(costs)
            return {"usd": tot / len(costs), "usd_median": _median(costs), "usd_total": tot,
                    "usd_per_defect": tot / f if f else None,
                    "usd_per_high": tot / found["high"] if found["high"] else None}[metric]
        if metric == "min_median":
            return _median(mins)
        if metric == "min_mean":
            return _mean(mins)
        if metric.startswith("aacr_"):
            refcat = next((p.partition("=")[2] for p in sel.split("&") if p.startswith("refcat=")), None)
            rlabel = next((p.partition("=")[2] for p in sel.split("&") if p.startswith("rlabel=")), None)
            return self._aacr(arm, keep, metric[5:], judged, refcat, rlabel)
        raise KeyError_(f"unknown aacr metric {metric!r}")

    def _multi(self, head, sel, metric):
        """ARM+ARM+...[@JUDGE]~SEL:single_found|any_found — key defects found (or partly) by exactly one / any of the arms."""
        arms_, _, judge = head.partition("@")
        arms = arms_.split("+")
        prs_, defects, dv, _, _, known = self._index()
        keep, dfilter = self.select(arms[0], sel)
        hits = collections.Counter()
        for a in arms:
            if a not in known:
                raise KeyError_(f"no arm {a!r}")
            ver = dv.get((a, judge or self.judge_of(a)), {})
            for k, d in defects.items():
                if k[0] in keep and (dfilter is None or dfilter(d)) and ver.get(k) in CREDIT:
                    hits[k] += 1
        if metric == "single_found":
            return sum(1 for c in hits.values() if c == 1)
        if metric == "any_found":
            return len(hits)
        raise KeyError_(f"unknown multi-arm metric {metric!r}")

    def labelled_refs(self) -> Dict[tuple, str]:
        """(PR, ref_key) -> the label's reality, for every labelled reference: a label is aligned to the
        reference at the same position of its PR's list, and must name the same path and start line
        (src/bench/report.ts's rule); a label that does not align is a fault, never skipped."""
        refs = {(r["instance_id"], r["ref_index"]): r for r in self.t("aacr_references")}
        out = {}
        for lab in self.t("aacr_reference_labels"):
            r = refs.get((lab["instance_id"], lab["index"]))
            if r is None or r["path"] != lab["path"] or int(r["from_line"] or 0) != int(lab["from_line"] or 0):
                raise KeyError_(f"label {lab['instance_id']}#{lab['index']} does not align with a reference")
            out[(lab["instance_id"], r["ref_key"])] = lab["reality"]
        return out

    def _aacr(self, arm, keep, m, judged, refcat=None, rlabel=None):
        refs = [r for r in self.t("aacr_references") if r["instance_id"] in keep and (refcat is None or r["category"] == refcat)]
        if rlabel is not None:
            lab = self.labelled_refs()
            refs = [r for r in refs if lab.get((r["instance_id"], r["ref_key"])) == rlabel]
        nobot = m.endswith("_nobot")
        base = m[:-6] if nobot else m
        bot = {r["ref_key"] for r in refs if r["bot_derived"]}
        cat_keys = {(r["instance_id"], r["ref_key"]) for r in refs}
        shares = [x for x in self.t("aacr_matches") if x["arm_id"] == arm and x["instance_id"] in keep
                  and ((refcat is None and rlabel is None) or (x["instance_id"], x["ref_key"]) in cat_keys)]
        found = sum(x["match_share"] for x in shares if not (nobot and x["ref_key"] in bot))
        n_refs = len(refs) - (len(bot) if nobot else 0)
        comments = sum(r["aacr_scored_comments"] or 0 for r in judged)
        if base == "found":
            return found
        if base == "refs":
            return n_refs
        if base == "comments":
            return comments
        r_ = found / n_refs if n_refs else None
        p = found / comments if comments else None
        if base == "recall":
            return None if r_ is None else 100 * r_
        if base == "precision":
            return None if p is None else 100 * p
        if base == "f1":
            f = _f1(p, r_)
            return None if f is None else 100 * f
        raise KeyError_(f"unknown aacr metric aacr_{m}")


class Key(Provider):
    """The answer key alone."""

    def compute(self, key: str) -> Optional[float]:
        metric, _, sel = key.partition("~")
        prs = {p["instance_id"]: p for p in self.t("prs")}
        keep = set(prs)
        dkind, v1 = None, False
        for part in [p for p in sel.split("&") if p and p != "all"]:
            k, _, v = part.partition("=")
            if k == "set":
                keep &= {i for i, p in prs.items() if p["set"] in set(v.split("+"))}
            elif k == "s40":
                keep &= {i for i, p in prs.items() if p["in_s40"]}
            elif k == "o145":
                keep &= {i for i, p in prs.items() if not p["in_s40"]}
            elif k == "lang":
                keep &= {i for i, p in prs.items() if p["language"] == v}
            elif k == "pr":
                keep &= {v}
            elif k == "arm":
                keep &= {r["instance_id"] for r in self.t("reviews") if r["arm_id"] == v}
            elif k == "dkind":
                dkind = v
            elif k == "size":
                lo, _, hi = v.partition("-")
                size = {r["instance_id"]: r["changed_lines"] for r in self.t("pr_diffstats")}
                keep &= {i for i in prs if size.get(i) is not None and size[i] >= float(lo) and (not hi or size[i] <= float(hi))}
            elif k == "v1":
                v1 = True
            else:
                raise KeyError_(f"unknown key selector {part!r}")
        d = [x for x in self.t("defects") if x["instance_id"] in keep and (dkind is None or x["kind"] == dkind)
             and not (v1 and x["provenance_added_in"])]
        sev = collections.Counter(x["severity"] for x in d)
        if metric == "defects":
            return len(d)
        if metric in ("n_high", "n_medium", "n_low"):
            return sev[metric[2:]]
        if metric == "prs":
            return len(keep)
        if metric == "exclusions":
            return sum(1 for x in self.t("exclusions") if x["instance_id"] in keep)
        if metric == "refs":
            return sum(1 for x in self.t("aacr_references") if x["instance_id"] in keep)
        if metric == "bot_refs":
            return sum(1 for x in self.t("aacr_references") if x["instance_id"] in keep and x["bot_derived"])
        if metric == "indep":
            return sum(1 for x in d if x["provenance_hunt"] or x["provenance_dataset_refs"])
        if metric.startswith("label="):
            return sum(1 for x in self.t("aacr_reference_labels") if x["instance_id"] in keep and x["reality"] == metric[6:])
        if metric.startswith("bot="):
            return sum(1 for x in self.t("aacr_references") if x["instance_id"] in keep and x["bot_derived"] and x["bot"] == metric[4:])
        if metric == "bot_prs":
            return len({x["instance_id"] for x in self.t("aacr_references") if x["instance_id"] in keep and x["bot_derived"]})
        if metric == "ai_refs":
            return sum(1 for x in self.t("aacr_references") if x["instance_id"] in keep and x["is_ai_comment"])
        if metric == "label_starts":
            return len({(x["instance_id"], x["path"], x["from_line"]) for x in self.t("aacr_reference_labels") if x["instance_id"] in keep})
        if metric in ("ref_raised", "ref_raised_high"):
            return sum(1 for x in d if x["provenance_dataset_refs"] and (metric == "ref_raised" or x["severity"] == "high"))
        if metric == "not_ai_refs":
            return sum(1 for x in self.t("aacr_references") if x["instance_id"] in keep and not x["is_ai_comment"])
        if metric in ("cite_bot", "cite_bot_hunt"):
            b = [x for x in d if x["bot_derived_reference"]]
            return len(b) if metric == "cite_bot" else sum(1 for x in b if x["provenance_hunt"])
        if metric in ("indep_reviewed", "indep_unreviewed"):
            ind = [x for x in d if x["provenance_hunt"] or x["provenance_dataset_refs"]]
            r = sum(1 for x in ind if x["provenance_reviewer_comments"])
            return r if metric == "indep_reviewed" else len(ind) - r
        if metric == "extension":
            return sum(1 for x in d if x["provenance_added_in"])
        if metric in ("ext_high", "ext_medium", "ext_low"):
            return sum(1 for x in d if x["provenance_added_in"] and x["severity"] == metric[4:])
        if metric == "prs_with_defects":
            return len({x["instance_id"] for x in d})
        if metric in ("one_source", "reviewer_only"):
            def kinds(x):
                return [bool(x["provenance_hunt"]), bool(x["provenance_dataset_refs"]), bool(x["provenance_reviewer_comments"])]
            if metric == "one_source":
                return sum(1 for x in d if sum(kinds(x)) == 1)
            return sum(1 for x in d if kinds(x) == [False, False, True])
        if metric.startswith("excl_src="):
            return sum(1 for x in self.t("exclusions") if x["instance_id"] in keep and (x["source"] or "").startswith(metric[9:]))
        if metric.startswith("not_hunt"):
            nh = [x for x in d if not x["provenance_hunt"]]
            sub = metric[8:]
            if sub in ("_high", "_medium", "_low"):
                return sum(1 for x in nh if x["severity"] == sub[1:])
            if sub == "_reviewer_only":
                return sum(1 for x in nh if not x["provenance_dataset_refs"])
            if sub == "_ref":
                return sum(1 for x in nh if x["provenance_dataset_refs"])
            return len(nh)
        if metric in ("median_per_pr", "max_per_pr", "mean_per_pr"):
            per = collections.Counter(x["instance_id"] for x in d)
            counts = [per.get(i, 0) for i in keep]
            return {"median_per_pr": _median(counts), "max_per_pr": max(counts) if counts else None,
                    "mean_per_pr": _mean(counts)}[metric]
        if metric == "max_lines":
            return max(prs[i]["change_line_count"] or 0 for i in keep)
        if metric == "languages":
            return len({prs[i]["language"] for i in keep})
        if metric == "labels":
            return sum(1 for x in self.t("aacr_reference_labels") if x["instance_id"] in keep)
        if metric == "labelled_prs":
            return len({x["instance_id"] for x in self.t("aacr_reference_labels") if x["instance_id"] in keep})
        if metric in ("refs_cited", "cited_pct"):
            cited = {(x["instance_id"], r) for x in d for r in (x["provenance_dataset_refs"] or [])}
            n_refs = sum(1 for x in self.t("aacr_references") if x["instance_id"] in keep)
            return len(cited) if metric == "refs_cited" else _pct(len(cited), n_refs)
        if metric == "repos":
            return len({prs[i]["repo"] for i in keep})
        if metric in ("size_median", "size_max"):
            size = [r["changed_lines"] for r in self.t("pr_diffstats") if r["instance_id"] in keep]
            return _median(size) if metric == "size_median" else max(size)
        if metric == "ai_or_bot_pct":  # references AI-written or rewritten from a review bot's comment
            rs = [x for x in self.t("aacr_references") if x["instance_id"] in keep]
            return _pct(sum(1 for x in rs if x["is_ai_comment"] or x["bot_derived"]), len(rs))
        if metric == "unrunnable" or metric.startswith("unrunnable_repo="):
            # AACR-Bench v1.0's scored PRs (the committed sets/full.json) that are not among the release's PRs
            import json as _json
            full = _json.load(open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "sets", "full.json")))
            gone = [c for c in full["cases"] if c["instance_id"] not in prs]
            return len(gone) if metric == "unrunnable" else sum(1 for c in gone if c["repo"] == metric.partition("=")[2])
        raise KeyError_(f"unknown key metric {metric!r}")


# ---------------------------------------------------------------- Martian

class Martian(Provider):
    def compute(self, key: str) -> Optional[float]:
        head, _, metric = key.rpartition(":")
        if head == "dirs":  # how many scoring dirs' names start with the prefix (and score `quickreview`)
            return len({s["work_dir"] for s in self.t("martian_scores")
                        if s["work_dir"] and s["work_dir"].startswith(metric) and s["tool"] == "quickreview"})
        if head.startswith("dirsmax:"):  # the best score of quickreview over the scoring dirs whose names start with a prefix
            vals = [s.get(metric) for s in self.t("martian_scores") if s["work_dir"] and s["tool"] == "quickreview"
                    and s["work_dir"].startswith(head[8:]) and s["judge"] == "gpt-6.1-sol"]
            vals = [v for v in vals if v is not None]
            if not vals:
                raise KeyError_(f"no martian scores {metric!r} for dirs {head[8:]}*")
            return 100 * max(vals) if metric.split("_", 1)[1] in ("precision", "recall", "f1", "f2") else max(vals)
        if head.startswith("goldens"):
            gold = self.t("martian_goldens")
            _, _, half = head.partition("~")
            if half:
                import json as _json
                setf = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "sets", half + ".json")
                urls = {c["pr_url"] for c in _json.load(open(setf))["cases"]}
                gold = [g for g in gold if g["pr_url"] in urls]
            if metric == "prs":
                return len(self.t("martian_prs")) if not half else len({g["pr_url"] for g in gold})
            if metric.startswith("blocking"):  # goldens Martian labels Critical or High, [by audit bucket]
                blk = [g for g in gold if (g["severity"] or "").lower() in ("critical", "high")]
                b = metric.partition("_")[2]
                return len(blk) if not b else sum(1 for g in blk if g["audit_bucket"] == b)
            b = collections.Counter(g["audit_bucket"] for g in gold)
            return len(gold) if metric == "total" else b[metric]
        head, _, half = head.partition("~")
        work, _, rest = head.partition("|")
        tool, _, judge = rest.partition("@")
        judge = judge or "gpt-6.1-sol"
        work = None if work == "-" else work  # "-": Martian's own published scores over all 50 PRs (no scoring dir)
        if (half or "+" in (work or "")) and metric.split("_", 1)[0] in PROFILES:
            return self._recount(work.split("+"), tool, judge, half or None, metric)
        if metric.startswith("real_found~"):  # real goldens found on one half (a committed set file of PR urls)
            import json as _json
            setf = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "sets", metric[11:] + ".json")
            urls = {c["pr_url"] for c in _json.load(open(setf))["cases"]}
            gold = {(g["pr_url"], g["golden_index"]): g["audit_bucket"] for g in self.t("martian_goldens")}
            return len({(v["pr_url"], v["golden_index"]) for v in self.t("martian_verdicts")
                        if v["work_dir"] == work and v["tool"] == tool and v["judge"] == judge and v["matched"]
                        and v["pr_url"] in urls and gold.get((v["pr_url"], v["golden_index"])) == "real"})
        if metric in ("all_blocking", "all_blocking_real", "all_real", "n_blocking_prs", "n_blocking_real_prs", "n_real_prs"):
            gold = self.t("martian_goldens")
            hit = {(v["pr_url"], v["golden_index"]) for v in self.t("martian_verdicts")
                   if v["work_dir"] == work and v["tool"] == tool and v["judge"] == judge and v["matched"]}
            want = collections.defaultdict(set)
            for g in gold:
                blocking = (g["severity"] or "").lower() in ("critical", "high")
                real = g["audit_bucket"] == "real"
                if (metric.endswith("blocking") or metric == "n_blocking_prs") and blocking:
                    want[g["pr_url"]].add((g["pr_url"], g["golden_index"]))
                elif metric in ("all_blocking_real", "n_blocking_real_prs") and blocking and real:
                    want[g["pr_url"]].add((g["pr_url"], g["golden_index"]))
                elif metric in ("all_real", "n_real_prs") and real:
                    want[g["pr_url"]].add((g["pr_url"], g["golden_index"]))
            if metric.startswith("n_"):
                return len(want)
            return sum(1 for ks in want.values() if ks <= hit)
        for kind in ("core", "strict", "all"):
            if metric.startswith(kind + "_"):
                rows = [s for s in self.t("martian_scores") if s["work_dir"] == work and s["tool"] == tool and s["judge"] == judge]
                if len(rows) != 1:
                    raise KeyError_(f"martian scores for {work}|{tool}@{judge}: {len(rows)} rows")
                v = rows[0].get(metric)
                if v is None:
                    raise KeyError_(f"no martian_scores column {metric!r}")
                return 100 * v if metric.split("_", 1)[1] in ("precision", "recall", "f1", "f2") else v
        if metric in ("real_found", "notreal_found", "disputed_found", "real_pct", "notreal_share"):
            gold = {(g["pr_url"], g["golden_index"]): g["audit_bucket"] for g in self.t("martian_goldens")}
            hit = {(v["pr_url"], v["golden_index"]) for v in self.t("martian_verdicts")
                   if v["work_dir"] == work and v["tool"] == tool and v["judge"] == judge and v["matched"]}
            if not any(v["work_dir"] == work and v["tool"] == tool and v["judge"] == judge for v in self.t("martian_verdicts")):
                raise KeyError_(f"no martian verdicts for {work}|{tool}@{judge}")
            if metric == "notreal_share":  # the share of the tool's matched goldens the audit judged not real
                return _pct(sum(1 for k in hit if gold.get(k) == "notreal"), len(hit))
            bucket = metric.replace("_found", "").replace("_pct", "")
            n = sum(1 for k in hit if gold.get(k) == bucket)
            return _pct(n, sum(1 for b in gold.values() if b == "real")) if metric == "real_pct" else n
        rows = [r for r in self.t("martian_reviews") if r["work_dir"] == work and r["tool"] == tool]
        if not rows:
            raise KeyError_(f"no martian reviews for {work}|{tool}")
        if metric == "usd":
            c = [r["cost_usd"] for r in rows]
            return None if any(x is None for x in c) else _mean(c)
        if metric == "min_mean":
            return _mean([r["minutes"] for r in rows if r["minutes"]])
        if metric == "extracted":
            return _mean([r["extracted_candidates"] or 0 for r in rows])
        if metric == "extracted_total":
            return sum(r["extracted_candidates"] or 0 for r in rows)
        if metric == "comments_per_pr":
            return _mean([r["n_comments"] or 0 for r in rows])
        if metric == "inline_per_pr":  # posted comments anchored to a line (the review body is not one)
            return _mean([sum(1 for c in (r["comments"] or []) if c.get("line") is not None) for r in rows])
        if metric == "prs":
            return len(rows)
        raise KeyError_(f"unknown martian metric {metric!r}")


    def _counts(self, work, tool, judge, half):
        """{profile: (tp, fp, fn)} of one scoring dir: its stored scores, or, restricted to a half (a committed
        set file of PR urls), recounted from the per-golden verdicts and the per-PR false positives."""
        if half is None:
            rows = [s for s in self.t("martian_scores") if s["work_dir"] == work and s["tool"] == tool and s["judge"] == judge]
            if len(rows) != 1:
                raise KeyError_(f"martian scores for {work}|{tool}@{judge}: {len(rows)} rows")
            return {p: (rows[0][f"{p}_tp"], rows[0][f"{p}_fp"], rows[0][f"{p}_fn"]) for p in PROFILES}
        import json as _json
        setf = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "sets", half + ".json")
        urls = {c["pr_url"] for c in _json.load(open(setf))["cases"]}
        reviews = [r for r in self.t("martian_reviews") if r["work_dir"] == work and r["tool"] == tool
                   and r["judge"] == judge and r["pr_url"] in urls]  # fp is the judge's: one judge's rows
        if not reviews:
            raise KeyError_(f"no martian reviews of {work}|{tool} on {half}")
        prs = {r["pr_url"] for r in reviews}
        cat = {(g["pr_url"], g["golden_index"]): g["category"] for g in self.t("martian_goldens")}
        hit = {(v["pr_url"], v["golden_index"]) for v in self.t("martian_verdicts")
               if v["work_dir"] == work and v["tool"] == tool and v["judge"] == judge and v["matched"] and v["pr_url"] in prs}
        fp = sum(r["fp"] or 0 for r in reviews)
        out = {}
        for p, excluded in PROFILES.items():
            tp = sum(1 for k in hit if cat[k] not in excluded)
            out[p] = (tp, fp, sum(1 for k, c in cat.items() if k[0] in prs and c not in excluded) - tp)
        return out

    def _recount(self, works, tool, judge, half, metric):
        prof, _, m = metric.partition("_")
        tp = fp = fn = 0
        for w in works:
            a, b, c = self._counts(w, tool, judge, half)[prof]
            tp, fp, fn = tp + a, fp + b, fn + c
        p = tp / (tp + fp) if tp + fp else 0.0
        r = tp / (tp + fn) if tp + fn else 0.0
        f = {"tp": tp, "fp": fp, "fn": fn, "precision": 100 * p, "recall": 100 * r,
             "f1": 100 * (2 * p * r / (p + r) if p + r else 0.0), "f2": 100 * (5 * p * r / (4 * p + r) if p + r else 0.0)}
        if m not in f:
            raise KeyError_(f"unknown martian metric {metric!r}")
        return f[m]


# Martian's scoring profiles: the golden categories each leaves out (its scorer's Core and Strict)
PROFILES = {"all": frozenset(), "core": frozenset({"style", "speculative"}),
            "strict": frozenset({"style", "speculative", "doc_defect", "test_gap", "perf"})}


# ---------------------------------------------------------------- Qodo

class Qodo(Provider):
    def compute(self, key: str) -> Optional[float]:
        head, _, metric = key.rpartition(":")
        issues = {(i["pr_url"], i["issue_index"]): i for i in self.t("qodo_issues")}
        if head == "issues":
            if metric == "prs":
                return len(self.t("qodo_prs"))
            if metric == "repos":
                return len({p["repo"] for p in self.t("qodo_prs")})
            return {"total": len(issues), "functional": sum(1 for i in issues.values() if i["functional"]),
                    "rule": sum(1 for i in issues.values() if not i["functional"])}[metric]
        work, _, tool = head.partition("|")
        tool, _, judge = tool.partition("@")
        judge = judge or "gpt-6.1-sol"
        # One judge's verdicts only: two judges' matches on the same reviews must never pool into one hit set.
        vs = [v for v in self.t("qodo_verdicts") if v["work_dir"] == work and v["tool"] == tool and v["judge"] == judge]
        rows = [r for r in self.t("qodo_reviews") if r["work_dir"] == work and r["tool"] == tool]
        if not vs or not rows:
            raise KeyError_(f"no qodo verdicts or reviews for {work}|{tool}@{judge}")
        same = metric.endswith("_samefile")
        sem = metric.endswith("_semantic")
        m = metric[:-9] if same or sem else metric
        loc = "located_same_file" if same else "located_n5"
        hit = {(v["pr_url"], v["issue_index"]) for v in vs if v["matched"] and (sem or v[loc])}
        comments = sum(r["n_comments"] or 0 for r in rows)
        n = len(issues)
        if m == "hits":
            return len(hit)
        if m == "comments":
            return comments
        if m == "per_pr":
            return comments / len(rows)
        if m == "prs":
            return len(rows)
        r_, p = len(hit) / n, (len(hit) / comments if comments else 0.0)
        if m == "recall":
            return 100 * r_
        if m == "precision":
            return 100 * p
        if m == "f1":
            return 100 * _f1(p, r_)
        if m in ("recall_functional", "recall_rule"):
            want = m == "recall_functional"
            sub = [k for k, i in issues.items() if bool(i["functional"]) == want]
            return _pct(sum(1 for k in sub if k in hit), len(sub))
        if m == "usd":
            c = [r["cost_usd"] for r in rows]
            return None if any(x is None for x in c) else _mean(c)
        if m == "min_mean":
            return _mean([r["minutes"] for r in rows if r["minutes"]])
        raise KeyError_(f"unknown qodo metric {metric!r}")


# ---------------------------------------------------------------- Elo

class Elo(Provider):
    def compute(self, key: str) -> Optional[float]:
        head, _, metric = key.rpartition(":")
        parts = head.split("|")
        plan, _, judge = parts[0].partition("@")
        used = [j for j in self.t("elo_judgments") if j["plan"] == plan and j["used_in_ratings"]]
        if judge:
            used = [j for j in used if j["judgment_file"] == judge]
        if not used and not any(r["plan"] == plan for r in self.t("elo_ratings")):
            raise KeyError_(f"no Elo plan {plan!r}")
        if len(parts) == 1 and metric == "judgments":
            return len(used)
        if len(parts) == 1 and metric == "agreement":
            by = collections.defaultdict(dict)
            for j in used:
                by[j["unit_id"]][j["judgment_file"]] = j["overall_winner"]
            both = [v for v in by.values() if len(v) >= 2]
            same = sum(1 for v in both if len(set(v.values())) == 1)
            return _pct(same, len(both))
        if len(parts) == 3 and metric in ("w", "l", "t"):
            x, y = parts[1], parts[2]
            rec = collections.Counter()
            for j in used:
                if {j["a"], j["b"]} != {x, y}:
                    continue
                w = j["overall_winner"]
                if w == "tie":
                    rec["t"] += 1
                elif (w == "A") == (j["a"] == x):
                    rec["w"] += 1
                else:
                    rec["l"] += 1
            return rec[metric]
        if len(parts) == 4:
            _, table, cat, run = parts
            rows = [r for r in self.t("elo_ratings") if r["plan"] == plan and r["table"] == table
                    and r["category"] == cat and r["run"] == run]
            if len(rows) != 1:
                raise KeyError_(f"elo rating {head}: {len(rows)} rows")
            return rows[0][metric]
        raise KeyError_(f"unknown elo key {key!r}")


# ---------------------------------------------------------------- two defect judges

class Judges(Provider):
    """Two defect judges (or one judge and its re-run) on the same reviews.

    J1|J2|ARM+ARM+...[|sample=JUDGE]:METRIC — every key defect (comment) of each arm's reviews that
    both judges judged (reviews.judged_by), restricted with `sample=` to the reviews a third judge
    also judged (the re-run's 30 PRs). Defect metrics (no row = missed): same pairs pct kappa,
    high_* (high-severity only), merged_pct merged_kappa (found and partial one class), disagree
    disagree_partial. Comment metrics (pairs both judges graded): c_same c_pairs c_pct c_kappa,
    c_bin_pct (correct = correct-valuable or correct-minor), c_bin_min_pct c_bin_max_pct (the lowest
    and highest per-arm share), c_from=<grade>>to=<grade> (comments J1 graded one way and J2 the other).
    repeat_prs: PRs the primary judge re-judged for self-consistency."""

    @staticmethod
    def _kappa(pairs):
        n = len(pairs)
        if not n:
            return None
        m1 = collections.Counter(x for x, _ in pairs)
        m2 = collections.Counter(y for _, y in pairs)
        po = sum(1 for x, y in pairs if x == y) / n
        pe = sum(m1[c] * m2[c] for c in set(m1) | set(m2)) / (n * n)
        return (po - pe) / (1 - pe) if pe < 1 else None

    def compute(self, key: str) -> Optional[float]:
        if key == "repeat_prs":
            return len({r["instance_id"] for r in self.t("reviews") if "gpt-6-sol-high-repeat" in (r["judged_by"] or [])})
        head, _, metric = key.rpartition(":")
        parts = head.split("|")
        if len(parts) not in (3, 4):
            raise KeyError_(f"judges key {key!r}: want J1|J2|ARM+ARM[|sample=JUDGE]:metric")
        j1, j2, arms = parts[0], parts[1], parts[2].split("+")
        sample = parts[3].partition("=")[2] if len(parts) == 4 else None
        need = {j1, j2} | ({sample} if sample else set())
        both = {(r["arm_id"], r["instance_id"]) for r in self.t("reviews")
                if r["arm_id"] in arms and need <= set(r["judged_by"] or [])}
        if not both:
            raise KeyError_(f"no reviews of {arms} judged by {sorted(need)}")
        if metric.startswith("c_"):
            g = collections.defaultdict(dict)
            for r in self.t("comment_verdicts"):
                if r["judge"] in (j1, j2) and (r["arm_id"], r["instance_id"]) in both:
                    g[(r["arm_id"], r["instance_id"], r["comment_id"])][r["judge"]] = r["grade"]
            pairs = {k: (v[j1], v[j2]) for k, v in g.items() if j1 in v and j2 in v}
            ok = ("correct-valuable", "correct-minor")
            m = metric[2:]
            if m == "same":
                return sum(1 for x, y in pairs.values() if x == y)
            if m == "pairs":
                return len(pairs)
            if m == "pct":
                return _pct(sum(1 for x, y in pairs.values() if x == y), len(pairs))
            if m == "kappa":
                return self._kappa(list(pairs.values()))
            if m == "bin_pct":
                return _pct(sum(1 for x, y in pairs.values() if (x in ok) == (y in ok)), len(pairs))
            if m in ("bin_min_pct", "bin_max_pct"):
                per = []
                for arm in arms:
                    ps = [v for k, v in pairs.items() if k[0] == arm]
                    per.append(_pct(sum(1 for x, y in ps if (x in ok) == (y in ok)), len(ps)))
                return (min if m == "bin_min_pct" else max)(per)
            if m.startswith("from="):
                frm, _, to = m[5:].partition(">to=")
                return sum(1 for x, y in pairs.values() if x == frm and y == to)
            raise KeyError_(f"unknown judges metric {metric!r}")
        high = {(d["instance_id"], d["defect_id"]) for d in self.t("defects") if d["severity"] == "high"}
        keys = [(d["instance_id"], d["defect_id"]) for d in self.t("defects")]
        if metric in ("kendall_found", "discordant_found"):
            found = {}
            for j in (j1, j2):
                c = collections.Counter()
                for r in self.t("defect_verdicts"):
                    if r["judge"] == j and r["arm_id"] in arms and (r["arm_id"], r["instance_id"]) in both:
                        c[r["arm_id"]] += CREDIT.get(r["verdict"], 0.0)
                found[j] = c
            conc = disc = 0
            for i in range(len(arms)):
                for k in range(i + 1, len(arms)):
                    x = found[j1][arms[i]] - found[j1][arms[k]]
                    y = found[j2][arms[i]] - found[j2][arms[k]]
                    if x * y > 0:
                        conc += 1
                    elif x * y < 0:
                        disc += 1
            if metric == "discordant_found":
                return disc
            return (conc - disc) / (conc + disc) if conc + disc else None
        if metric.startswith("high_"):
            keys = [k for k in keys if k in high]
            metric = metric[5:]
        v = collections.defaultdict(dict)
        for r in self.t("defect_verdicts"):
            if r["judge"] in (j1, j2) and r["arm_id"] in arms:
                v[(r["arm_id"], r["judge"])][(r["instance_id"], r["defect_id"])] = r["verdict"]
        pairs = [(v[(a, j1)].get(k, "missed"), v[(a, j2)].get(k, "missed"))
                 for a in arms for k in keys if (a, k[0]) in both]
        n = len(pairs)
        same = sum(1 for x, y in pairs if x == y)
        merge = {"partial": "found"}
        if metric == "same":
            return same
        if metric == "pairs":
            return n
        if metric == "pct":
            return _pct(same, n)
        if metric == "kappa":
            return self._kappa(pairs)
        if metric == "merged_pct":
            return _pct(sum(1 for x, y in pairs if merge.get(x, x) == merge.get(y, y)), n)
        if metric == "merged_kappa":
            return self._kappa([(merge.get(x, x), merge.get(y, y)) for x, y in pairs])
        if metric == "disagree":
            return n - same
        if metric == "disagree_partial":
            return sum(1 for x, y in pairs if x != y and "partial" in (x, y))
        raise KeyError_(f"unknown judges metric {metric!r}")


# ---------------------------------------------------------------- a second judge's folder

class SecondJudge(Provider):
    """A second judge's numbers, from the dataset's `second_judges/LABEL/` (second_judges.py) through the
    repository's scorers, exactly as the folder README's commands print them (the scorers' --json):

    LABEL/aacr/ARM:METRIC         score_verdicts.score over the folder's aacr/: under LABEL found defects
                                  recall high_rec weighted graded correct incorrect new_defects; against the
                                  arm's published judge (arms.judge) pairs pct kappa c_pairs c_pct c_kappa; reviews
    LABEL/aacr/judgements:METRIC  the folder's aacr/judgements rows: rows, usd (summed), effort_used=E and
                                  effort_requested=E (rows with that effort)
    LABEL/martian/WORK|TOOL:METRIC  martian_scores.metrics(counts(...)) under LABEL over the folder's martian/:
                                  {core,strict,all}_{tp,fp,fn,precision,recall,f1,f2}; prs
    LABEL/qodo/WORK|TOOL:METRIC   qodo_scores.run_scores under LABEL over the folder's qodo/ (on the PRs it
                                  judged when it judged only some, as the scorer counts): hits comments per_pr
                                  precision recall f1 recall_functional recall_rule and the _semantic ones; prs;
                                  empty (the run's reviews with no comment: no request to judge)

    The published judge's own cells are the `aacr`, `martian` and `qodo` keys; a folder the release does
    not hold is a missing source (the check needs `second_judges`), never a number."""

    def __init__(self, tables: Tables):
        super().__init__(tables)
        self._loaded: Dict[tuple, object] = {}

    def _folder(self, label: str, part: str) -> str:
        import second_judges as SJ
        d = os.path.join(SJ.folder_of(self.t.data), label, part)
        if not os.path.isdir(d):
            raise KeyError_(f"no {SJ.FOLDER}/{label}/{part} beside the tables")
        return d

    def _once(self, k: tuple, build):
        if k not in self._loaded:
            self._loaded[k] = build()
        return self._loaded[k]

    def compute(self, key: str) -> Optional[float]:
        label, part, rest = (key.split("/", 2) + ["", ""])[:3]
        head, _, metric = rest.rpartition(":")
        if not (label and head and metric) or part not in ("aacr", "martian", "qodo"):
            raise KeyError_(f"second_judge key {key!r}: want LABEL/aacr|martian|qodo/HEAD:METRIC")
        d = self._folder(label, part)
        try:
            if part == "aacr" and head == "judgements":
                rows = load_table(d, "judgements")
                k, _, v = metric.partition("=")
                if metric == "rows":
                    return len(rows)
                if metric == "usd":
                    return sum(r["usd"] or 0.0 for r in rows)
                if k in ("effort_used", "effort_requested") and v:
                    return sum(1 for r in rows if r[k] == v)
                raise KeyError_(f"unknown second_judge judgements metric {metric!r}")
            if part == "aacr":
                import score_verdicts as SV
                tables = self._once(("aacr", label), lambda: SV.WithJudge(self.t.data, d, label))
                if head not in {a for a, _ in tables.judged}:
                    raise KeyError_(f"no {label} verdicts for arm {head!r}")
                row = self._once(("aacr", label, head), lambda: SV.score(tables, label, [head])[head])
                for got in (row[label], row["agreement"], row):
                    if metric in got and not isinstance(got[metric], (dict, str, bool)):
                        return got[metric]
                raise KeyError_(f"unknown second_judge aacr metric {metric!r}")
            work, _, tool = head.partition("|")
            if part == "martian":
                import martian_scores as MS
                vs, rs = self._once(("martian", label), lambda: MS._load(self.t.data, d, label))
                prs = {r["pr_url"] for r in rs if r["judge"] == label and r["work_dir"] == work and r["tool"] == tool}
                if not prs:
                    raise KeyError_(f"no {label} martian_reviews rows for {head}")
                if metric == "prs":
                    return len(prs)
                m = self._once(("martian", label, head),
                               lambda: MS.metrics(MS.counts(self.t("martian_goldens"), vs, rs, work, tool, label)))
                if metric not in m:
                    raise KeyError_(f"unknown second_judge martian metric {metric!r}")
                return m[metric]
            import qodo_scores as QS
            t = self._once(("qodo", label), lambda: self._qodo_tables(QS, d, label))
            mine = {v["pr_url"] for v in t("qodo_verdicts") if v["judge"] == label and v["work_dir"] == work and v["tool"] == tool}
            if not mine:
                raise KeyError_(f"no {label} qodo_verdicts rows for {head}")
            if metric == "prs":
                return len(mine)
            if metric == "empty":
                return sum(1 for r in t("qodo_reviews") if r["work_dir"] == work and r["tool"] == tool
                           and not r["n_comments"])
            whole = {r["pr_url"] for r in t("qodo_reviews") if r["work_dir"] == work and r["tool"] == tool}
            view = t if whole <= mine else QS.on_prs(t, mine)  # qodo_scores.main's scope: a sample's own PRs
            if metric not in QS.METRICS:
                raise KeyError_(f"unknown second_judge qodo metric {metric!r}")
            return self._once(("qodo", label, head), lambda: QS.run_scores(view, head, label))[metric]
        except SystemExit as e:  # a scorer refusing the folder's rows: a fault, never a number
            raise KeyError_(f"{part} scorer refused {SJ_DIR}/{label}: {e}") from None

    def _qodo_tables(self, QS, d: str, label: str) -> Tables:
        t = Tables(self.t.data)
        t._t["qodo_verdicts"] = QS.verdict_rows(self.t.data, d, label)
        return t


SJ_DIR = "second_judges"
PROVIDERS = {"aacr": Aacr, "key": Key, "martian": Martian, "qodo": Qodo, "elo": Elo, "judges": Judges,
             "second_judge": SecondJudge}
