#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["matplotlib>=3.8", "markdown>=3.5"]
# ///
"""Showcase graphics v4: each benchmark drawn the way its publisher draws it, with QuickReview added.

    uv run bench/aacr/showcase/make_charts_v4.py                # every chart and infographic, both themes, NUMBERS.md
    uv run bench/aacr/showcase/make_charts_v4.py martian-recall # one image (names: --list)

The charts use only forms readers already know from the vendors' and the
benchmarks' own pages:
- sorted bar lists (Martian, DeepSource, Qodo, Greptile);
- the precision/recall scatter (Martian, Qodo, Augment);
- leaderboard tables (Martian, Augment, ReviewBench);
- bars by severity (Greptile).
Every image has a title that is the takeaway, one metric line (what is measured,
out of what, which way is better), direct labels and one source line.
QuickReview is the only coloured mark, and every tool tested is drawn.
infographics_v4.py adds the explainers: how each benchmark was run and scored,
and how QuickReview works.

v1-v3 are untouched. Inputs: data/*.json, plus data/v4.json from refresh_v4.py
(Martian's published leaderboard next to our run) and data/published.json (the
scores Qodo printed, hand-kept).
"""
import argparse, json, math, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import logging  # noqa: E402

logging.getLogger("matplotlib.font_manager").setLevel(logging.ERROR)
from make_charts import HIGH, QR, Bench, pct  # noqa: E402  (v1's data layer)
import theme_v4 as theme  # noqa: E402
from theme_v4 import Page4, axis_frame, bar_rows, dot, save, table  # noqa: E402

OUT = os.path.join(HERE, "out", "v4")
FAST = "quickreview-fast"  # the fast option (profile `fast`, preset `low`), data/v3.json
SEVS = [("high", "High"), ("medium", "Medium"), ("low", "Low")]
MARTIAN_SEVS = ["Critical", "High", "Medium", "Low"]  # data/v4.json keeps keys sorted; print in this order

# Martian's dashboard ids -> the names its public leaderboard shows.
MARTIAN_NAMES = {
    "qodo-extended-v2": "Qodo Deep", "cubic-v2": "cubic", "augment": "Augment", "qodo-v2": "Qodo",
    "copilot-v2": "GitHub Copilot", "gemini-v2": "Gemini", "gitlab": "GitLab Duo", "sourcery": "Sourcery",
    "greptile-v4-1": "Greptile", "coderabbit": "CodeRabbit", "macroscope": "Macroscope", "bugbot": "Cursor Bugbot",
    "claude-code": "Claude Code (CLI)", "devin": "Devin", "gitar": "Gitar", "kodus-v2": "Kodus",
    "codeant-v2": "CodeAnt", "baz": "Baz", "claude": "Claude Code (plugin)", "kg": "Kilo + Grok",
    "graphite": "Graphite",
}
MARTIAN_JUDGE = "openai_gpt-5.2"  # the published judge ours tracks (calibration in data/v4.json)
# Qodo publishes no scorer. Matching an issue by meaning, without a line check, is the rule under which our
# judge reproduces Qodo's own published scores (ext/QODO-BENCH.md; the gap is printed on every Qodo image).
QODO_RULE = "semantic only"
QODO_STRICT = "N=5"  # the rule Qodo's blog states (file + ±5 lines): v3's official-qodo; NUMBERS.md gives both
NOISE = 0.02  # a lead under 2 points is never a title


class V4:
    """data/v4.json, data/v3.json and data/published.json beside v1's Bench."""

    def __init__(self, B):
        j = lambda n: json.load(open(os.path.join(HERE, "data", n)))  # noqa: E731
        self.B = B
        self.d = j("v4.json")
        self.v3 = j("v3.json")
        self.pub = j("published.json")
        self.m = self.d["martian"]

    # ---- Martian
    def martian_partial(self, judge=MARTIAN_JUDGE):
        """Tools whose published row scores only part of the Core goldens (matched + missed short of all):
        their recall is over a different denominator, so the v4 charts leave them out (README says so)."""
        return sorted(t for t, s in self.m["judges"][judge]["tools"].items() if s["tp"] + s["fn"] != self.m["goldens"])

    def martian_rows(self, judge=MARTIAN_JUDGE):
        """[(id, name, scores)]: every complete tool row on Martian's board under `judge`, plus QuickReview."""
        partial = set(self.martian_partial(judge))
        rows = [(t, MARTIAN_NAMES.get(t, self.m["display_names"].get(t, t)), s)
                for t, s in self.m["judges"][judge]["tools"].items() if t not in partial]
        rows.append((QR, "QuickReview", self.m["quickreview"]))
        return rows

    def calibration_gap(self, judge=MARTIAN_JUDGE, key="recall"):
        """Largest |ours - theirs| on the tools both judges graded."""
        return max(abs(c["ours"][key] - c[judge][key]) for c in self.m["calibration"].values())

    def martian_source(self):
        j = self.m["judges"][MARTIAN_JUDGE]["label"]
        gap = self.calibration_gap()
        return (f"Others: Martian's published scores ({j} judge, Core profile), from the benchmark's public repo.\n"
                f"QuickReview: the same pipeline with our gpt-6.1-sol judge, within {max(gap * 100, 1):.0f} point "
                f"of {j}'s recall on the 3 tools both judges graded.")

    # ---- Qodo
    def qodo_rows(self, rule=QODO_RULE):
        """[(id, name, scores)] for the 13 reviewers on Qodo's benchmark, all graded by our one judge."""
        return [(t, self.B.name(t), r["scores"][rule]) for t, r in self.B.qodo["tools"].items()]

    def qodo_gaps(self):
        """|our F1 - Qodo's published F1| per vendor run, in points."""
        return {t: abs(self.B.qodo["tools"][t]["scores"][QODO_RULE]["f1"] * 100 - p["f1"])
                for t, p in self.pub["qodo"]["tools"].items()}

    def qodo_source(self):
        g = sorted(self.qodo_gaps().values())
        close = sum(1 for v in g if v <= 1.5)
        return (f"All 13 graded by one judge of ours (gpt-6.1-sol), matching issues by meaning: on Qodo's {len(g)} "
                f"vendor runs it lands within {g[-1]:.1f} points of Qodo's own F1 ({close} within 1.5).\n"
                "Vendor reviews: the vendors' own runs on Qodo's public forks. QuickReview, PR-Agent, OpenCode and "
                "open-code-review: run by us.")

    # ---- AACR
    def name(self, t):
        return "QuickReview fast" if t == FAST else self.B.name(t)

    def recall(self, t, sev=None):
        if t == FAST:
            xs = [x for x in self.B.D if sev is None or x["severity"] in sev]
            return sum(self.v3["arms"][FAST]["credit"][f"{x['pr']}|{x['id']}"] for x in xs) / len(xs)
        return self.B.recall(t, sev)

    def mean(self, t, key):
        v = [r[key] for r in self.v3["arms"][t]["per_pr"].values() if r[key] is not None]
        return sum(v) / len(v)


def ordinal(n):
    return f"{n}{'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"


def rank(rows, key, t, low_is_good=False):
    v = {r[0]: r[2][key] for r in rows}
    return 1 + sum(1 for k, x in v.items() if k != t and (x < v[t] if low_is_good else x > v[t]))


def accent(T, t):
    if t == FAST:
        return "#86b6ef" if theme.theme_name(T) == "light" else "#5f8fd0"
    return T["qr"] if t == QR else T["other"]


def place_labels(p, items, taken, box):
    """Direct labels: items [(x, y, text, kw)] in priority order. Each tries a ring of offsets around its
    point and keeps the first that stays inside `box` and overlaps nothing already placed."""
    r = p.fig.canvas.get_renderer()
    inv = p.c.transData.inverted()
    offsets = [(12, 0, "left"), (-12, 0, "right"), (0, -18, "center"), (0, 20, "center"), (12, -16, "left"),
               (12, 16, "left"), (-12, -16, "right"), (-12, 16, "right"), (0, -34, "center"), (0, 36, "center"),
               (24, -30, "left"), (-24, -30, "right"), (24, 32, "left"), (-24, 32, "right")]
    bx0, by0, bx1, by1 = box
    for x, y, s, kw in items:
        placed = False
        for dx, dy, ha in offsets:
            t = p.text(x + dx, y + dy, s, ha=ha, zorder=7,
                       bbox={"facecolor": p.T["surface"], "edgecolor": "none", "pad": 0.6, "alpha": 0.85}, **kw)
            (a, b), (c, d) = inv.transform(t.get_window_extent(renderer=r).get_points())
            rect = (min(a, c) - 2, min(b, d) - 1, max(a, c) + 2, max(b, d) + 1)
            inside = rect[0] >= bx0 and rect[2] <= bx1 and rect[1] >= by0 and rect[3] <= by1
            if inside and not any(rect[0] < q[2] and q[0] < rect[2] and rect[1] < q[3] and q[1] < rect[3]
                                  for q in taken):
                taken.append(rect)
                if abs(dy) >= 30:  # far from its dot: a hairline says whose label it is
                    p.c.plot([x, x + dx * 0.6], [y, y + dy * 0.55], color=p.T["muted"], lw=0.8, zorder=2)
                placed = True
                break
            t.remove()
        if not placed:
            dx, dy, ha = offsets[0]
            p.text(x + dx, y + dy, s, ha=ha, **kw)


def labelled_dots(p, pts, X, Y, box, r=6):
    """pts [(id, name, x, y)]: one dot per tool, all the same size; QuickReview's drawn last, in the accent,
    with a bold label. Every dot is named."""
    T = p.T
    taken = [(X(x) - r - 2, Y(y) - r - 2, X(x) + r + 2, Y(y) + r + 2) for _, _, x, y in pts]
    for t, _, x, y in sorted(pts, key=lambda q: q[0] in (QR, FAST)):
        dot(p, X(x), Y(y), r, accent(T, t), zorder=6 if t in (QR, FAST) else 4)
    order = sorted(pts, key=lambda q: (q[0] not in (QR, FAST), -q[3]))
    place_labels(p, [(X(x), Y(y), name, {"size": 13.5 if t in (QR, FAST) else 11.5,
                                         "weight": "bold" if t == QR else "normal",
                                         "color": T["ink"] if t in (QR, FAST) else T["ink2"]})
                     for t, name, x, y in order], taken, box)


def corner_note(p, x, y, s, ha="right"):
    p.text(x, y, s, size=12, color=p.T["muted"], ha=ha, weight="bold")


# ---------------------------------------------------------------- Martian (Greptile's 50 PRs)
def fig_martian_recall(B, V, T):
    rows = sorted(V.martian_rows(), key=lambda r: -r[2]["recall"])
    n, k = len(rows), rank(rows, "recall", QR)
    p = Page4(T, h=1000)
    p.title(f"Highest recall of {n} code reviewers" if k == 1 else f"{ordinal(k)} of {n} code reviewers on recall")
    p.metric(f"Martian Code Review Bench · share of its {V.m['goldens']} known issues found · "
             f"{V.m['prs']} PRs · higher is better")
    bar_rows(p, [{"name": name, "value": s["recall"], "label": pct(s["recall"]), "qr": t == QR}
                 for t, name, s in rows], x0=290, x1=p.w - 120, top=136, bottom=p.h - 72, vmax=1.0,
             name_size=13, value_size=13)
    p.source(V.martian_source())
    return p


def fig_martian_scatter(B, V, T):
    rows = V.martian_rows()
    best_r = max(rows, key=lambda r: r[2]["recall"])[0]
    worst_p = min(rows, key=lambda r: r[2]["precision"])[0]
    p = Page4(T, h=820)
    if best_r == QR and worst_p == QR:
        p.title(f"Most thorough of {len(rows)}, and the noisiest")
    else:
        p.title(f"Recall {ordinal(rank(rows, 'recall', QR))}, precision {ordinal(rank(rows, 'precision', QR))} "
                f"of {len(rows)}")
    p.metric(f"Martian Code Review Bench · {V.m['prs']} PRs · {V.m['goldens']} known issues · "
             "each dot is one reviewer, as on Martian's own chart")
    box = (130, 160, p.w - 70, p.h - 130)
    X, Y = axis_frame(p, box, (0, 0.8), (0, 0.7), [0, .2, .4, .6, .8], [0, .1, .2, .3, .4, .5, .6, .7], pct, pct,
                      "Precision: share of its comments that match a known issue  →  less noise",
                      "Recall: share of known issues found  ↑  more thorough")
    labelled_dots(p, [(t, name, s["precision"], s["recall"]) for t, name, s in rows], X, Y,
                  (box[0] + 4, box[1] + 4, box[2] - 4, box[3] - 4))
    corner_note(p, box[2] - 8, box[1] + 14, "better ↗")
    p.source(V.martian_source())
    return p


def fig_martian_leaderboard(B, V, T):
    rows = sorted(V.martian_rows(), key=lambda r: -r[2]["f2"])
    n, k = len(rows), rank(rows, "f2", QR)
    p = Page4(T, h=1000)
    p.title(f"{ordinal(k)} of {n} on Martian's default ranking")
    p.metric("Code Review Leaderboard, sorted by F2 (recall counts twice as much as precision) · "
             f"Martian · {V.m['prs']} PRs")
    best = {key: max(r[2][key] for r in rows) for key in ("f2", "precision", "recall")}
    cols = [("#", 92, "right"), ("Tool", 124, "left"), ("F2 score", 800, "right"), ("Precision", 950, "right"),
            ("Recall", 1100, "right")]
    table(p, cols, [{"cells": [str(i + 1), name, pct(s["f2"]), pct(s["precision"]), pct(s["recall"])],
                     "qr": t == QR,
                     "best": [c for c, key in ((2, "f2"), (3, "precision"), (4, "recall")) if s[key] == best[key]]}
                    for i, (t, name, s) in enumerate(rows)], top=150, row_h=34, size=13)
    p.source(V.martian_source())
    return p


# ---------------------------------------------------------------- Qodo PR-Review-Bench
def fig_qodo_f1(B, V, T):
    rows = sorted(V.qodo_rows(), key=lambda r: -r[2]["f1"])
    n, k = len(rows), rank(rows, "f1", QR)
    above = [r[0] for r in rows[:k - 1]]
    p = Page4(T, h=760)
    if k > 1 and all(t.startswith("qodo") for t in above):
        p.title(f"{ordinal(k)} of {n} on Qodo's benchmark, behind only Qodo")
    else:
        p.title(f"{ordinal(k)} of {n} on Qodo's benchmark")
    p.metric("Qodo PR-Review-Bench · F1, its headline score: issues found and comment precision in one number · "
             "100 PRs")
    bar_rows(p, [{"name": name, "value": s["f1"], "label": pct(s["f1"]), "qr": t == QR} for t, name, s in rows],
             x0=290, x1=p.w - 120, top=140, bottom=p.h - 76, vmax=1.0)
    p.source(V.qodo_source())
    return p


def fig_qodo_functional(B, V, T):
    rows = sorted(V.qodo_rows(), key=lambda r: -r[2]["recall_functional"])
    n, k = len(rows), rank(rows, "recall_functional", QR)
    nf = round(B.qodo["tools"][QR]["issues"] - B.qodo["tools"][QR]["rule_issues"])
    p = Page4(T, h=760)
    p.title(f"Most functional bugs found of {n} reviewers" if k == 1 else
            f"{ordinal(k)} of {n} on functional bugs found")
    p.metric(f"Qodo PR-Review-Bench · share of its {nf} injected functional bugs found · 100 PRs · higher is better")
    bar_rows(p, [{"name": name, "value": s["recall_functional"], "label": pct(s["recall_functional"]),
                  "qr": t == QR} for t, name, s in rows], x0=290, x1=p.w - 120, top=140, bottom=p.h - 76, vmax=1.0)
    p.source(V.qodo_source())
    return p


def fig_qodo_scatter(B, V, T):
    rows = V.qodo_rows()
    kr, kp = rank(rows, "recall", QR), rank(rows, "precision", QR)
    p = Page4(T, h=820)
    best_other = max(r[2]["recall"] for r in rows if r[0] != QR)
    ours = next(r[2] for r in rows if r[0] == QR)
    if kp == len(rows) and abs(ours["recall"] - best_other) < NOISE:
        p.title("As thorough as the best, but the least precise")
    elif kr == 1 and kp == len(rows):
        p.title(f"Finds the most of {len(rows)}, but the least precise")
    else:
        p.title(f"Recall {ordinal(kr)}, precision {ordinal(kp)} of {len(rows)}")
    p.metric("Qodo PR-Review-Bench · 100 PRs · 580 injected issues · each dot is one reviewer, as on Qodo's own chart")
    box = (130, 160, p.w - 70, p.h - 130)
    X, Y = axis_frame(p, box, (0, 0.6), (0, 0.9), [0, .1, .2, .3, .4, .5, .6], [0, .15, .3, .45, .6, .75, .9],
                      pct, pct, "Recall: share of the 580 issues found  →  more thorough",
                      "Precision: share of comments that name an issue  ↑  less noise")
    labelled_dots(p, [(t, name, s["recall"], s["precision"]) for t, name, s in rows], X, Y,
                  (box[0] + 4, box[1] + 4, box[2] - 4, box[3] - 4))
    corner_note(p, box[2] - 8, box[1] + 14, "better ↗")
    p.source(V.qodo_source())
    return p


# ---------------------------------------------------------------- AACR-Bench (185 PRs, 520 verified defects)
AACR_LINE = "AACR-Bench · 185 real PRs in 10 languages"
AACR_SOURCE = ("520 defects verified in the code (90 high, 145 medium, 285 low severity). One judge, one run per "
               "reviewer; a partly found defect counts ½.\nQuickReview: frozen build on gpt-6.1-sol; every OpenAI-based "
               "tool ran on gpt-6.1-sol, Claude Code on Opus 5.5. QuickReview was tuned on 121 of these PRs.")


def aacr_order(B, V, with_fast=True):
    ts = B.aacr_tools() + ([FAST] if with_fast else [])
    return sorted(ts, key=lambda t: -V.recall(t))


def fig_aacr_found(B, V, T):
    order = aacr_order(B, V)
    rivals = [t for t in order if t not in (QR, FAST)]
    p = Page4(T)
    lead = all(V.recall(QR) > V.recall(t) for t in rivals)
    fast_lead = FAST in order and all(V.recall(FAST) > V.recall(t) for t in rivals)
    p.title("Most defects found, even in fast mode" if lead and fast_lead else
            f"Most defects found of {len(rivals) + 1} reviewers" if lead else "Defects found")
    p.metric(f"{AACR_LINE} · share of the {B.total()} verified defects found · higher is better")
    rows = []
    for t in order:
        rows.append({"name": V.name(t), "value": V.recall(t), "label": pct(V.recall(t)), "qr": t == QR})
    pitch = bar_rows(p, rows, x0=290, x1=p.w - 150, top=140, bottom=p.h - 76, vmax=1.0, track=True)
    if FAST in order:  # the fast option: the accent, lighter
        i = order.index(FAST)
        y = 140 + pitch * (i + 0.5)
        theme.bar(p.c, 290, 290 + (p.w - 440) * V.recall(FAST), y, min(26, pitch * 0.62), accent(T, FAST), zorder=4)
    p.source(AACR_SOURCE)
    return p


def fig_aacr_severity(B, V, T):
    order = aacr_order(B, V, with_fast=False)
    lead = all(all(V.recall(QR, {s}) > V.recall(t, {s}) for t in order if t != QR) for s, _ in SEVS)
    p = Page4(T, h=700)
    p.title("Ahead at every severity" if lead else "Defects found, by severity")
    p.metric(f"{AACR_LINE} · share of the verified defects found, by severity · higher is better")
    top, bottom = 196, p.h - 78
    names_x = 250
    w = (p.w - names_x - 40) / 3
    pitch = (bottom - top) / len(order)
    for c, (s, label) in enumerate(SEVS):
        x0 = names_x + 14 + c * w
        x1 = x0 + w - 70
        p.text(x0, top - 26, f"{label} · {B.total({s})} defects", size=14, weight="bold", color=T["ink"])
        for i, t in enumerate(order):
            y = top + pitch * (i + 0.5)
            v = V.recall(t, {s})
            theme.bar(p.c, x0, x1, y, min(24, pitch * 0.6), T["empty"], zorder=2)
            theme.bar(p.c, x0, x0 + (x1 - x0) * v, y, min(24, pitch * 0.6), accent(T, t), zorder=3)
            p.text(x1 + 8, y, pct(v), size=12.5, color=T["ink"] if t == QR else T["ink2"],
                   weight="bold" if t == QR else "normal")
            if c == 0:
                p.text(names_x, y, V.name(t), ha="right", size=13, color=T["ink"] if t == QR else T["ink2"],
                       weight="bold" if t == QR else "normal")
    p.source(AACR_SOURCE)
    return p


def pareto(points):
    """Indices of the points no other point beats on both cost (lower) and found (higher)."""
    keep = []
    for i, (c, f) in enumerate(points):
        if not any((c2 <= c and f2 >= f) and (c2, f2) != (c, f) for c2, f2 in points):
            keep.append(i)
    return sorted(keep, key=lambda i: points[i][0])


def tradeoff(B, V, T, key, unit, title_unit, xr, xticks, xfmt, worse):
    ts = aacr_order(B, V)
    rivals = [t for t in ts if t not in (QR, FAST)]
    pts = [(t, V.name(t), V.mean(t, key), V.recall(t)) for t in ts]
    lo = min(V.mean(QR, key) / V.mean(t, key) for t in rivals)
    hi = max(V.mean(QR, key) / V.mean(t, key) for t in rivals)
    p = Page4(T, h=760)
    lead = all(V.recall(QR) > V.recall(t) for t in rivals)
    p.title(f"Finds the most, at {lo:.0f}–{hi:.0f}× the {title_unit}" if lead else f"Defects found against {title_unit}")
    p.metric(f"{AACR_LINE} · share of {B.total()} verified defects found, against {unit} per PR")
    box = (130, 160, p.w - 80, p.h - 130)
    lx = lambda v: math.log10(v)  # noqa: E731
    X0, Y = axis_frame(p, box, (lx(xr[0]), lx(xr[1])), (0, 1), [lx(v) for v in xticks], [0, .25, .5, .75, 1],
                       lambda v: xfmt(10 ** v), pct, f"{unit[0].upper()}{unit[1:]} per PR (log scale)  →  {worse}",
                       "Share of defects found  ↑  better")
    X = lambda v: X0(lx(v))  # noqa: E731
    front = pareto([(c, f) for _, _, c, f in pts])
    fx = [X(pts[i][2]) for i in front]
    fy = [Y(pts[i][3]) for i in front]
    p.c.plot(fx, fy, color=T["muted"], lw=1.4, ls=(0, (5, 4)), zorder=2)
    p.text(fx[-1] - 10, fy[-1] - 26, "best found at each " + title_unit, size=11, color=T["muted"], ha="right")
    labelled_dots(p, pts, X, Y, (box[0] + 4, box[1] + 4, box[2] - 4, box[3] - 4), r=7)
    corner_note(p, box[0] + 10, box[1] + 14, "↖ better", ha="left")
    p.source(AACR_SOURCE.split("\n")[0] + "\nCost: model spend at list prices, not a bill; time: wall clock on a "
             "shared scheduler. QuickReview fast: every model at low effort, same build.")
    return p


def fig_aacr_cost(B, V, T):
    return tradeoff(B, V, T, "usd", "average model cost", "cost", (0.05, 4), [0.05, 0.1, 0.25, 0.5, 1, 2, 4],
                    lambda v: f"${v:g}", "costlier")


def fig_aacr_time(B, V, T):
    return tradeoff(B, V, T, "minutes", "average minutes", "time", (0.5, 40), [0.5, 1, 2, 5, 10, 20, 40],
                    lambda v: f"{v:g} min", "slower")


OCT1 = "quickreview-b2ce03a"  # the paper's design-study build: the one QuickReview build AACR's own scorer ran on


def fig_aacr_leaderboard(B, V, T):
    """AACR-Bench's own metric, laid out as Alibaba's open-code-review leaderboard (its de facto board)."""
    off = V.v3["official"]["aacr"]
    rows = sorted(((t, r) for t, r in off.items() if r), key=lambda kv: -kv[1]["f1"])
    n = len(rows)
    k = 1 + sum(1 for t, r in rows if r["f1"] > off[OCT1]["f1"])
    refs = rows[0][1]["references"]
    p = Page4(T, h=700)
    p.title(f"{ordinal(k)} of {n} on AACR-Bench's own score" if k > 1 else f"Top F1 of {n} on AACR-Bench's own score")
    p.metric(f"How closely a review reproduces the dataset's {refs:,} reference comments · 185 PRs · sorted by F1")
    best = {key: max(r[key] for _, r in rows) for key in ("f1", "precision", "recall")}
    name = lambda t: "QuickReview (Oct 1 build)" if t == OCT1 else B.name(t)  # noqa: E731
    model = lambda t: "Opus 5.5" if t == "claude-code" else "gpt-6.1-sol"  # noqa: E731  (data/tools.json)
    cols = [("#", 84, "right"), ("Reviewer", 110, "left"), ("Model", 430, "left"), ("F1", 650, "right"),
            ("Precision", 790, "right"), ("Recall", 930, "right"), ("Time / PR", 1040, "right"),
            ("Cost / PR", 1150, "right")]
    table(p, cols, [{"cells": [str(i + 1), name(t), model(t), pct1(r["f1"]),
                               (pct1(r["precision"]), f"{r['found']:.0f} / {r['comments']}"),
                               (pct1(r["recall"]), f"{r['found']:.0f} / {r['references']}"),
                               f"{V.mean(t, 'minutes'):.1f} min", f"${V.mean(t, 'usd'):.2f}"],
                     "qr": t == OCT1,
                     "best": [c for c, key in ((3, "f1"), (4, "precision"), (5, "recall")) if r[key] == best[key]]}
                    for i, (t, r) in enumerate(rows)], top=160, row_h=58, size=14)
    p.source("AACR-Bench's own matching: a comment on the same file within a line, which a judge calls the same concern; "
             "references are mostly AI-written.\nQuickReview: the Oct 1 build (the frozen build was not scored this way). "
             "Time: mean wall clock; cost: mean model spend at list prices.")
    return p


def pct1(x):
    return f"{x * 100:.1f}%"


# ---------------------------------------------------------------- one table: where QuickReview stands
def standings(B, V):
    """[(benchmark, measure, our value, our rank, field, best other name, its value)], each computed."""
    out = []
    aacr = B.aacr_tools()
    for label, sev in (("Defects found", None), ("High-severity found", HIGH)):
        vals = {t: B.recall(t, sev) for t in aacr}
        other = max((t for t in aacr if t != QR), key=lambda t: vals[t])
        out.append(("AACR-Bench", label, vals[QR], 1 + sum(1 for t in aacr if vals[t] > vals[QR]), len(aacr),
                    B.name(other), vals[other]))
    m = V.martian_rows()
    for label, key, low in (("Recall", "recall", False), ("Precision", "precision", False),
                            ("F2, its default ranking", "f2", False)):
        other = max((r for r in m if r[0] != QR), key=lambda r: r[2][key])
        ours = next(r for r in m if r[0] == QR)[2][key]
        out.append(("Martian", label, ours, rank(m, key, QR, low), len(m), other[1], other[2][key]))
    q = V.qodo_rows()
    for label, key in (("Recall", "recall"), ("Functional bugs found", "recall_functional"),
                       ("Precision", "precision"), ("F1, its headline score", "f1")):
        other = max((r for r in q if r[0] != QR), key=lambda r: r[2][key])
        ours = next(r for r in q if r[0] == QR)[2][key]
        out.append(("Qodo", label, ours, rank(q, key, QR), len(q), other[1], other[2][key]))
    return out


def fig_standings(B, V, T):
    rows = standings(B, V)
    recall_rows = [r for r in rows if (r[0], r[1]) in (("AACR-Bench", "Defects found"), ("Martian", "Recall"),
                                                       ("Qodo", "Functional bugs found"))]
    prec_rows = [r for r in rows if r[1] == "Precision"]
    p = Page4(T, h=720)
    if all(r[3] == 1 for r in recall_rows) and all(r[3] == r[4] for r in prec_rows):
        p.title(f"Most found on all {len(recall_rows)} benchmarks, least precise on {len(prec_rows)}")
    # (Qodo's all-issue recall lead is under a point, so its "found" row is the functional bugs)
    else:
        p.title("Where QuickReview stands")
    p.metric("QuickReview's place on each benchmark's own measures · every tool each benchmark tested")
    cols = [("Benchmark", 64, "left"), ("Measure", 250, "left"), ("QuickReview", 650, "right"),
            ("Place", 790, "right"), ("Best other tool", 830, "left")]
    table(p, cols, [{"cells": [b, measure, pct(v), f"{k} of {n}", f"{other} {pct(ov)}"],
                     "qr": False, "best": [2, 3] if k == 1 else []}
                    for b, measure, v, k, n, other, ov in rows], top=160, row_h=50, size=14.5)
    p.source("AACR-Bench: 185 PRs, our verified key of 520 defects. Martian: 50 PRs, its own scorer; others at its "
             "published GPT-5.2-judge scores.\nQodo: 100 PRs, all 13 graded by one judge of ours. Precision is not "
             "measured on our AACR key (comments are graded instead).")
    return p


CHARTS = {
    "martian-recall": fig_martian_recall,
    "martian-scatter": fig_martian_scatter,
    "martian-leaderboard": fig_martian_leaderboard,
    "qodo-f1": fig_qodo_f1,
    "qodo-functional": fig_qodo_functional,
    "qodo-scatter": fig_qodo_scatter,
    "aacr-found": fig_aacr_found,
    "aacr-severity": fig_aacr_severity,
    "aacr-cost": fig_aacr_cost,
    "aacr-time": fig_aacr_time,
    "aacr-leaderboard": fig_aacr_leaderboard,
    "standings": fig_standings,
}


def figures():
    # here, not at the top: these import this module's helpers
    import infographics_v4, value_v4
    return {**CHARTS, **value_v4.FIGURES, **infographics_v4.FIGURES}


# ---------------------------------------------------------------- NUMBERS.md
def md_table(head, rows):
    return "\n".join(["| " + " | ".join(head) + " |", "|" + "---|" * len(head)] +
                     ["| " + " | ".join(str(c) for c in r) + " |" for r in rows]) + "\n"


def numbers(B, V):
    out = ["# The numbers behind out/v4\n",
           f"Every number the v4 charts print, and the ones they rest on (data/v4.json built {V.d['generated']}). "
           "Written by make_charts_v4.py: do not edit by hand.\n"]
    j = V.m["judges"][MARTIAN_JUDGE]["label"]
    by_sev = V.m["goldens_by_severity"]
    sev_list = ", ".join(f"{k} {by_sev[k]}" for k in MARTIAN_SEVS)
    out.append(f"## Martian Code Review Bench (martian-recall, martian-scatter, martian-leaderboard)\n\n"
               f"{V.m['prs']} PRs, {V.m['goldens']} Core golden comments ({sev_list}). "
               f"Others: Martian's published {j} judge; QuickReview: our gpt-6.1-sol judge.\n")
    rows = sorted(V.martian_rows(), key=lambda r: -r[2]["f2"])
    out.append(md_table(["#", "Tool", "F2", "Precision", "Recall", "F1", "Matched", "Unmatched comments"] +
                        [f"{k} found" for k in MARTIAN_SEVS],
                        [[i + 1, name, pct(s["f2"]), pct(s["precision"]), pct(s["recall"]), pct(s["f1"]), s["tp"],
                          s["fp"]] + [f"{s['by_severity'][k]}/{by_sev[k]}" for k in MARTIAN_SEVS]
                         for i, (t, name, s) in enumerate(rows)]))
    for t in V.martian_partial():
        r = V.m["judges"][MARTIAN_JUDGE]["tools"][t]
        out.append(f"\nLeft out: {MARTIAN_NAMES.get(t, t)}. Its row in the repo scores {r['tp'] + r['fn']} of the "
                   f"{V.m['goldens']} Core goldens (recall {pct(r['recall'])} over that part), so it is not comparable. "
                   "Martian's live site shows a newer, complete run for it.\n")
    out.append("\nCalibration: the three tools graded by both our judge and Martian's (recall / precision).\n\n")
    cal = V.m["calibration"]
    out.append(md_table(["Tool", "ours (gpt-6.1-sol)"] + [V.m["judges"][k]["label"] for k in V.m["judges"]],
                        [[MARTIAN_NAMES.get(t, t), f"{pct(c['ours']['recall'])} / {pct(c['ours']['precision'])}"] +
                         [f"{pct(c[k]['recall'])} / {pct(c[k]['precision'])}" for k in V.m["judges"]]
                         for t, c in cal.items()]))
    out.append("\n## Qodo PR-Review-Bench (qodo-f1, qodo-functional, qodo-scatter)\n\n"
               f"100 PRs, 580 injected issues (309 functional, 271 rule violations). One judge of ours for all 13. "
               f"Charts use '{QODO_RULE}' (an issue matched by meaning); the stricter '{QODO_STRICT}' rule (same file, "
               "±5 lines; v3's official-qodo) is beside it. Qodo's own published scores are the last column.\n\n")
    pub = V.pub["qodo"]["tools"]
    rows = sorted(V.qodo_rows(), key=lambda r: -r[2]["f1"])
    out.append(md_table(["Tool", "F1", "Precision", "Recall", "Functional found", "Rule found", "Comments/PR",
                         f"F1 ({QODO_STRICT})", f"Recall ({QODO_STRICT})", f"Functional ({QODO_STRICT})",
                         "Qodo's published F1"],
                        [[name, pct(s["f1"]), pct(s["precision"]), pct(s["recall"]), pct(s["recall_functional"]),
                          pct(s["recall_rule"]), f"{s['per_pr']:.1f}",
                          pct(B.qodo["tools"][t]["scores"][QODO_STRICT]["f1"]),
                          pct(B.qodo["tools"][t]["scores"][QODO_STRICT]["recall"]),
                          pct(B.qodo["tools"][t]["scores"][QODO_STRICT]["recall_functional"]),
                          f"{pub[t]['f1']:.1f}%" if t in pub else "not published"] for t, name, s in rows]))
    out.append("\n## AACR-Bench (aacr-found, aacr-severity, aacr-cost, aacr-time)\n\n"
               "185 PRs, 520 verified defects; a partly found defect counts ½. Cost: mean model spend per PR at list "
               "prices; time: mean wall-clock minutes per PR.\n\n")
    out.append(md_table(["Reviewer", "Found", "High (90)", "Medium (145)", "Low (285)", "$ / PR", "Minutes / PR"],
                        [[V.name(t), pct(V.recall(t)), pct(V.recall(t, {"high"})), pct(V.recall(t, {"medium"})),
                          pct(V.recall(t, {"low"})), f"${V.mean(t, 'usd'):.2f}", f"{V.mean(t, 'minutes'):.1f}"]
                         for t in aacr_order(B, V)]))
    off = V.v3["official"]["aacr"]
    out.append("\n## AACR-Bench's own score (aacr-leaderboard)\n\nThe dataset's reference comments, matched by "
               "AACR-Bench's harness. QuickReview: the Oct 1 build (b2ce03a); its frozen build and fast option were "
               "not scored this way.\n\n")
    out.append(md_table(["Reviewer", "F1", "Precision", "Recall", "Matched", "Comments", "References"],
                        [[("QuickReview (Oct 1 build)" if t == OCT1 else B.name(t)), pct1(r["f1"]), pct1(r["precision"]),
                          pct1(r["recall"]), f"{r['found']:.1f}", r["comments"], r["references"]]
                         for t, r in sorted(((t, r) for t, r in off.items() if r), key=lambda kv: -kv[1]["f1"])]))
    import value_v4
    out.append("\n" + value_v4.numbers(B, V))
    out.append("\n## Where QuickReview stands (standings)\n\n")
    out.append(md_table(["Benchmark", "Measure", "QuickReview", "Place", "Best other tool"],
                        [[b, m_, pct(v), f"{k} of {n}", f"{o} {pct(ov)}"] for b, m_, v, k, n, o, ov in standings(B, V)]))
    return "\n".join(out)


# The gallery page's sections, in order; an image listed nowhere lands in "More".
SECTIONS = [
    ("Where QuickReview stands", ["standings"]),
    ("Martian Code Review Bench: Greptile's and Augment's 50 PRs, scored by Martian",
     ["martian-recall", "martian-scatter", "martian-leaderboard"]),
    ("Qodo PR-Review-Bench", ["qodo-f1", "qodo-functional", "qodo-scatter"]),
    ("AACR-Bench", ["aacr-found", "aacr-severity", "aacr-leaderboard", "aacr-cost", "aacr-time"]),
    ("What a found bug is worth (BUG-VALUE.md)", ["value-escapes", "value-review-cost", "value-price", "value-total",
                                                  "value-ladder"]),
    ("How we measured", ["how-aacr", "how-key", "how-fair", "how-martian", "how-qodo", "how-scoring"]),
    ("How QuickReview works", ["system-overview", "review-round", "lenses", "safety", "lifecycle", "learning-loop",
                               "extensibility", "deployment", "setup-scan"]),
]


def embed(path):
    """An image as a data URI: lossless WebP, about a third of the PNG's bytes, pixel for pixel the same."""
    import base64, io
    from PIL import Image  # a matplotlib dependency, so always here
    buf = io.BytesIO()
    Image.open(path).save(buf, "WEBP", lossless=True, method=6)
    return "data:image/webp;base64," + base64.b64encode(buf.getvalue()).decode()


SHARE_CSS = """
:root{--bg:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--card:#ffffff;--line:#e8e7e1;--accent:#2a78d6}
@media (prefers-color-scheme: dark){:root:not([data-theme=light]){--bg:#1a1a19;--ink:#fff;--ink2:#c3c2b7;--card:#222220;
--line:#2c2c2a;--accent:#3987e5}}
:root[data-theme=dark]{--bg:#1a1a19;--ink:#fff;--ink2:#c3c2b7;--card:#222220;--line:#2c2c2a;--accent:#3987e5}
body{margin:0;padding:24px 16px 64px;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,
"Segoe UI","Noto Sans",sans-serif}
main{max-width:1500px;margin:0 auto}h1{margin:0 0 6px;font-size:30px}p{margin:0 0 10px;color:var(--ink2);max-width:980px}
h2{margin:40px 0 4px;font-size:20px}h2+p{margin-bottom:14px}
.bar{display:flex;gap:8px;align-items:center;margin:14px 0 4px;flex-wrap:wrap}
.bar button{font:inherit;padding:5px 12px;border-radius:16px;border:1px solid var(--line);background:var(--card);
color:var(--ink2);cursor:pointer}.bar button[aria-pressed=true]{border-color:var(--accent);color:var(--accent)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(460px,100%),1fr));gap:16px}
figure{margin:0;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
figure img{display:block;width:100%;height:auto;cursor:zoom-in}
.dk{display:none}
@media (prefers-color-scheme: dark){:root:not([data-theme=light]) .lt{display:none}
:root:not([data-theme=light]) .dk{display:block}}
:root[data-theme=dark] .lt{display:none}:root[data-theme=dark] .dk{display:block}
figcaption{padding:10px 14px 14px;color:var(--muted);font-size:13px}
figcaption b{display:block;color:var(--ink);font-size:15px}figcaption span{display:block;color:var(--ink2);margin:2px 0 8px}
figcaption a{color:var(--ink2);margin-right:10px}code{font-size:12px}
#zoom{position:fixed;inset:0;background:rgba(0,0,0,.82);display:none;align-items:center;justify-content:center;
padding:16px;cursor:zoom-out;z-index:9}
#zoom img{max-width:100%;max-height:100%;border-radius:8px;box-shadow:0 8px 40px rgba(0,0,0,.5)}
"""

SHARE_JS = """
const root=document.documentElement,btns=document.querySelectorAll('.bar button');
function setTheme(t){if(t==='auto')root.removeAttribute('data-theme');else root.setAttribute('data-theme',t);
btns.forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.t===t)));}
btns.forEach(b=>b.addEventListener('click',()=>setTheme(b.dataset.t)));
const zoom=document.getElementById('zoom'),zimg=zoom.querySelector('img');
document.querySelectorAll('figure img').forEach(i=>i.addEventListener('click',()=>{
const vis=[...i.parentElement.querySelectorAll('img')].find(x=>getComputedStyle(x).display!=='none');
zimg.src=vis.src;zimg.alt=vis.alt;zoom.style.display='flex';}));
zoom.addEventListener('click',()=>{zoom.style.display='none';zimg.removeAttribute('src');});
document.addEventListener('keydown',e=>{if(e.key==='Escape')zoom.click();});
document.querySelectorAll('a[data-get]').forEach(a=>a.addEventListener('click',e=>{e.preventDefault();
const f=a.closest('figure'),img=f.querySelector('img.'+a.dataset.get),t=document.createElement('a');
t.href=img.src;t.download=f.id+(a.dataset.get==='dk'?'-dark':'')+'.webp';document.body.appendChild(t);t.click();
t.remove();}));
"""

SECTION_NOTES = {
    "Where QuickReview stands": "QuickReview's place on each benchmark's own measures, wins and losses alike.",
    "Martian Code Review Bench: Greptile's and Augment's 50 PRs, scored by Martian":
        "Martian's public leaderboard with QuickReview added: the other tools at Martian's published scores.",
    "Qodo PR-Review-Bench": "Qodo's benchmark of 100 PRs with 580 injected issues; 13 reviewers, one judge.",
    "AACR-Bench": "Alibaba's 185 real PRs in 10 languages, scored against 520 defects verified in the code.",
    "What a found bug is worth (BUG-VALUE.md)":
        "Model spend plus reading time against what a missed serious defect costs later.",
    "How we measured": "How each benchmark was run and scored, and what was and was not the same for every tool.",
    "How QuickReview works": "From a pull request to a posted review, and where the system can be extended.",
}


def write_index(out, pages, generated=""):
    """out/v4/index.html: the whole library as ONE self-contained page to share.

    Every image is embedded, light and dark, and the page follows the viewer's theme or a switch. Click an
    image to enlarge it. There are no links to other files, no scripts from elsewhere and no web fonts.
    """
    import html
    listed = [n for _, names in SECTIONS for n in names]
    sections = [(t, [n for n in names if n in pages]) for t, names in SECTIONS]
    sections.append(("More", [n for n in pages if n not in listed]))
    body = []
    for title, names in sections:
        if not names:
            continue
        body.append(f"<h2>{html.escape(title.split(' (')[0])}</h2>")
        if title in SECTION_NOTES:
            body.append(f"<p>{html.escape(SECTION_NOTES[title])}</p>")
        body.append("<div class=grid>")
        for n in names:
            head, sub = (html.escape(x or "") for x in pages[n])
            lt, dk = embed(os.path.join(out, f"{n}.png")), embed(os.path.join(out, f"{n}-dark.png"))
            body.append(
                f'<figure id="{n}"><img class=lt src="{lt}" alt="{head}" loading="lazy">'
                f'<img class=dk src="{dk}" alt="{head}" loading="lazy">'
                f'<figcaption><b>{head}</b><span>{sub}</span><code>{n}</code> &nbsp; '
                f'<a href="#{n}" data-get="lt">download light</a><a href="#{n}" data-get="dk">download dark</a>'
                "</figcaption></figure>")
        body.append("</div>")
    doc = ("<!doctype html>\n<html lang=en><head><meta charset=utf-8>"
           "<meta name=viewport content=\"width=device-width,initial-scale=1\"><title>QuickReview showcase</title>"
           f"<style>{SHARE_CSS}</style></head><body><main>\n<h1>QuickReview: benchmarks and how it works</h1>\n"
           "<p>Each public benchmark drawn the way its publisher draws it, with QuickReview added; what a found bug "
           "is worth; how we measured; and how QuickReview reviews a pull request. Every number comes from the "
           f"benchmark runs{(' (data of ' + html.escape(generated) + ')') if generated else ''}; each image's "
           "small print says how it was measured. Click an image to enlarge it.</p>\n"
           "<div class=bar><span>Theme</span><button data-t=auto aria-pressed=true>auto</button>"
           "<button data-t=light aria-pressed=false>light</button><button data-t=dark aria-pressed=false>dark"
           "</button></div>\n" + "\n".join(body) +
           "\n</main><div id=zoom><img alt=\"\"></div>" + f"<script>{SHARE_JS}</script></body></html>\n")
    with open(os.path.join(out, "index.html"), "w") as fh:
        fh.write(doc)


def write_report_html(md_path, html_path, title):
    """A Markdown report as ONE self-contained HTML page to share: every out/v4 image it shows is embedded, light
    and dark, and the page follows the viewer's theme or a switch."""
    import html as H
    import re
    import markdown
    text = open(md_path).read()
    body = markdown.markdown(text, extensions=["tables", "sane_lists"])

    def figure(m):
        """An <img> of an out/v4 chart, as its light and dark images embedded."""
        attrs = dict(re.findall(r'(\w+)="([^"]*)"', m.group(1)))
        src = attrs.get("src", "")
        if not src.startswith("out/v4/"):
            return m.group(0)
        stem = os.path.splitext(os.path.basename(src))[0]
        alt = H.escape(H.unescape(attrs.get("alt", "")))
        lt, dk = (embed(os.path.join(OUT, f"{stem}{sfx}.png")) for sfx in ("", "-dark"))
        return f'<figure><img class=lt src="{lt}" alt="{alt}"><img class=dk src="{dk}" alt="{alt}"></figure>'

    body = re.sub(r"<img ([^>]*?)\s*/?>", figure, body)
    css = SHARE_CSS + ("article{max-width:900px;margin:0 auto}article p,article li{color:var(--ink);max-width:none}"
                       "article figure{margin:18px 0;cursor:zoom-in}table{border-collapse:collapse;margin:12px 0;"
                       "font-size:14px}th,td{border-bottom:1px solid var(--line);padding:6px 10px;text-align:left}"
                       "th{color:var(--muted);font-weight:600}a{color:var(--accent)}")
    doc = ("<!doctype html>\n<html lang=en><head><meta charset=utf-8>"
           "<meta name=viewport content=\"width=device-width,initial-scale=1\">"
           f"<title>{H.escape(title)}</title><style>{css}</style></head><body><main><article>\n"
           "<div class=bar><span>Theme</span><button data-t=auto aria-pressed=true>auto</button>"
           "<button data-t=light aria-pressed=false>light</button><button data-t=dark aria-pressed=false>dark"
           "</button></div>\n" + body + "\n</article></main><div id=zoom><img alt=\"\"></div>"
           f"<script>{SHARE_JS}</script></body></html>\n")
    with open(html_path, "w") as fh:
        fh.write(doc)


def render(figs, names, out=OUT, numbers_md=False):
    """Draw the named figures (all of figs when names is empty), light and dark; return the layout problems.
    A full run also writes NUMBERS.md and the gallery page."""
    B = Bench()
    V = V4(B)
    bad = 0
    pages = {}
    for name in names or figs:
        for th in ("light", "dark"):
            T = theme.use(th)
            page = figs[name](B, V, T)
            pages[name] = (getattr(page, "title_text", name), getattr(page, "metric_text", ""))
            for problem in theme.overflow(page):
                bad += 1
                print(f"LAYOUT {name} ({th}): {problem}", file=sys.stderr)
            print(save(page, out, name, th, svg=th == "light"))
    if numbers_md:
        with open(os.path.join(out, "NUMBERS.md"), "w") as fh:
            fh.write(numbers(B, V))
        import value_v4
        md = os.path.join(HERE, "BUG-VALUE.md")
        with open(md, "w") as fh:
            fh.write(value_v4.report(B, V))
        write_report_html(md, os.path.join(out, "bug-value.html"), "What a found bug is worth")
        write_index(out, pages, V.d["generated"])
    return bad


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("names", nargs="*")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--out", default=OUT)
    a = ap.parse_args()
    figs = figures()
    if a.list:
        print("\n".join(figs))
        return
    unknown = [n for n in a.names if n not in figs]
    if unknown:
        sys.exit(f"unknown image(s): {', '.join(unknown)} (see --list)")
    bad = render(figs, a.names, a.out, numbers_md=not a.names)
    if bad:
        sys.exit(f"{bad} layout problem(s)")


if __name__ == "__main__":
    main()
