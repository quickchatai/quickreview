"""Published numbers recomputed from the Hugging Face tables, by key.

bench/aacr/verify_claims.py asks this module for the value behind a claim of
bench/aacr/claims.json whose check is `aacr`, `martian`, `qodo` or `elo`. No
model call; the tables are read with recompute/tables.py (parquet, or .jsonl
fixtures). Every value is a plain number in the unit the papers print:
percentages are already x100, money in dollars, time in minutes.

Keys
----
aacr     ARM[@JUDGE][~SEL]:METRIC
         ARM an `arms.arm_id`; JUDGE defaults to the arm's AACR judge
         (gpt-6-sol-high, or gpt-6.1-sol-high for the open-model arms).
         SEL narrows the PRs (and so the key), `&`-joined:
           all (default) | own (the PRs the arm has a review of) | s40 | o145
           | set=a+b (the `prs.set` names) | lang=<language> | kind=<pr_category>
           | lines=<lo>-<hi> (change_line_count, inclusive) | arm=<arm id> (that arm's PRs)
           | dset=indep (only defects the blind hunt or an AACR reference raised) | dkind=<defect kind>
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
         (added by the key's v2 extension) prs_with_defects languages repos labels labelled_prs; SEL also takes dkind=<kind>
         refs_cited (AACR references some defect's provenance cites) cited_pct (of the references)
         label=<reality> (labelled references of that reality) bot=<bot> (bot-derived references of that bot)
         bot_prs not_ai_refs cite_bot cite_bot_hunt (defects citing a bot-derived reference; of them, hunted)
         indep_reviewed indep_unreviewed (hunt-or-reference defects some reviewer also raised; none did)
judges   J1|J2|ARM+ARM+...:[high_]same|pairs|pct   two defect judges' verdicts on the same (arm, PR,
         defect), over every key defect (or every high-severity one) of each arm (no row = missed)
         repeat_prs   PRs the primary judge re-judged for self-consistency
martian  WORK|TOOL[@JUDGE]:METRIC  (JUDGE default gpt-6.1-sol; a published judge is
         "published: <model>", and WORK "-" names Martian's own published scores over all 50 PRs). METRIC: {core,strict,all}_{tp,fp,fn,precision,recall,f1,f2},
         real_found notreal_found disputed_found real_pct notreal_share, usd min_mean extracted comments_per_pr prs
         goldens:real|notreal|disputed|total|prs
qodo     WORK|TOOL:METRIC  METRIC: hits comments per_pr precision recall f1 recall_functional
         recall_rule (the primary rule, N=5), the same with _samefile, usd min_mean prs
         issues:total|functional|rule|prs
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
            elif k == "kind":
                keep &= {i for i, p in prs.items() if p["pr_category"] == v}
            elif k == "lines":
                lo, _, hi = v.partition("-")
                keep &= {i for i, p in prs.items()
                         if (p["change_line_count"] or 0) >= float(lo) and (not hi or (p["change_line_count"] or 0) <= float(hi))}
            elif k == "arm":
                if v not in self._index()[5]:
                    raise KeyError_(f"selector arm={v}: no such arm")
                keep &= {r["instance_id"] for r in rv.get(v, [])}
            elif k == "dset" and v == "indep":
                dfilter = lambda d: bool(d["provenance_hunt"] or d["provenance_dataset_refs"])  # noqa: E731
            elif k == "dkind":
                dfilter = lambda d, v=v: d["kind"] == v  # noqa: E731
            else:
                raise KeyError_(f"unknown selector {part!r}")
        return keep, dfilter

    def compute(self, key: str) -> Optional[float]:
        head, _, metric = key.rpartition(":")
        if not head:
            raise KeyError_(f"aacr key {key!r} has no metric")
        head, _, sel = head.partition("~")
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
            return self._aacr(arm, keep, metric[5:], judged)
        raise KeyError_(f"unknown aacr metric {metric!r}")

    def _aacr(self, arm, keep, m, judged):
        refs = [r for r in self.t("aacr_references") if r["instance_id"] in keep]
        nobot = m.endswith("_nobot")
        base = m[:-6] if nobot else m
        bot = {r["ref_key"] for r in refs if r["bot_derived"]}
        shares = [x for x in self.t("aacr_matches") if x["arm_id"] == arm and x["instance_id"] in keep]
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
        dkind = None
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
            elif k == "dkind":
                dkind = v
            else:
                raise KeyError_(f"unknown key selector {part!r}")
        d = [x for x in self.t("defects") if x["instance_id"] in keep and (dkind is None or x["kind"] == dkind)]
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
        raise KeyError_(f"unknown key metric {metric!r}")


# ---------------------------------------------------------------- Martian

class Martian(Provider):
    def compute(self, key: str) -> Optional[float]:
        head, _, metric = key.rpartition(":")
        if head == "goldens":
            if metric == "prs":
                return len(self.t("martian_prs"))
            b = collections.Counter(g["audit_bucket"] for g in self.t("martian_goldens"))
            return len(self.t("martian_goldens")) if metric == "total" else b[metric]
        work, _, rest = head.partition("|")
        tool, _, judge = rest.partition("@")
        judge = judge or "gpt-6.1-sol"
        work = None if work == "-" else work  # "-": Martian's own published scores over all 50 PRs (no scoring dir)
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
        if metric == "comments_per_pr":
            return _mean([r["n_comments"] or 0 for r in rows])
        if metric == "prs":
            return len(rows)
        raise KeyError_(f"unknown martian metric {metric!r}")


# ---------------------------------------------------------------- Qodo

class Qodo(Provider):
    def compute(self, key: str) -> Optional[float]:
        head, _, metric = key.rpartition(":")
        issues = {(i["pr_url"], i["issue_index"]): i for i in self.t("qodo_issues")}
        if head == "issues":
            if metric == "prs":
                return len(self.t("qodo_prs"))
            return {"total": len(issues), "functional": sum(1 for i in issues.values() if i["functional"]),
                    "rule": sum(1 for i in issues.values() if not i["functional"])}[metric]
        work, _, tool = head.partition("|")
        vs = [v for v in self.t("qodo_verdicts") if v["work_dir"] == work and v["tool"] == tool]
        rows = [r for r in self.t("qodo_reviews") if r["work_dir"] == work and r["tool"] == tool]
        if not vs or not rows:
            raise KeyError_(f"no qodo verdicts or reviews for {work}|{tool}")
        same = metric.endswith("_samefile")
        m = metric[:-9] if same else metric
        loc = "located_same_file" if same else "located_n5"
        hit = {(v["pr_url"], v["issue_index"]) for v in vs if v["matched"] and v[loc]}
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
    def compute(self, key: str) -> Optional[float]:
        head, _, metric = key.rpartition(":")
        if key == "repeat_prs":
            return len({r["instance_id"] for r in self.t("reviews") if "gpt-6-sol-high-repeat" in (r["judged_by"] or [])})
        parts = head.split("|")
        if len(parts) != 3:
            raise KeyError_(f"judges key {key!r}: want J1|J2|ARM+ARM:metric")
        j1, j2, arms = parts[0], parts[1], parts[2].split("+")
        keys = [(d["instance_id"], d["defect_id"]) for d in self.t("defects")]
        v = collections.defaultdict(dict)
        for r in self.t("defect_verdicts"):
            if r["judge"] in (j1, j2) and r["arm_id"] in arms:
                v[(r["arm_id"], r["judge"])][(r["instance_id"], r["defect_id"])] = r["verdict"]
        high = {(d["instance_id"], d["defect_id"]) for d in self.t("defects") if d["severity"] == "high"}
        if metric.startswith("high_"):
            keys = [k for k in keys if k in high]
            metric = metric[5:]
        same = n = 0
        for a in arms:
            if not v.get((a, j1)) or not v.get((a, j2)):
                raise KeyError_(f"no {j1} or {j2} verdicts for arm {a}")
            for k in keys:
                n += 1
                same += v[(a, j1)].get(k, "missed") == v[(a, j2)].get(k, "missed")
        if metric not in ("same", "pairs", "pct"):
            raise KeyError_(f"unknown judges metric {metric!r}")
        return {"same": same, "pairs": n, "pct": _pct(same, n)}[metric]


PROVIDERS = {"aacr": Aacr, "key": Key, "martian": Martian, "qodo": Qodo, "elo": Elo, "judges": Judges}
