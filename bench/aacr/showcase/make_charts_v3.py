#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["matplotlib>=3.8"]
# ///
"""Showcase graphics v3 — new angles, FIFA-style area charts, and the honest set — into out/v3/.

    uv run bench/aacr/showcase/make_charts_v3.py              # every figure, both themes, NUMBERS.md
    uv run bench/aacr/showcase/make_charts_v3.py radar-kinds  # one figure (names: --list)

Four groups, all in v2's one-chart style (a title that is the message, the
marks, names and values, one line of small print):
  radar-*    FIFA-style "attribute" area charts: one filled shape per reviewer.
  honest-*   the trade-offs: QuickReview finds more, and costs more money, more
             time and more comments to read.
  official-* each benchmark scored by ITS OWN metric (precision, recall, F1 on its
             own reference list), not by our verified-defect key — where
             QuickReview's precision is the lowest on two of the three.
  idea-*     ten more angles, in ideas_v3.py: the defects nobody else found, PR-by-PR
             records, languages, robustness, price per extra defect, and more.
A full run (no names) also writes out/v3/NUMBERS.md: every number each image prints,
as tables, with the caveats that did not fit on the image.
v1 (make_charts.py, out/) and v2 (make_charts_v2.py, out/v2/) are untouched; v3
reuses their data layer and look. Inputs: data/*.json, plus data/v3.json from
refresh_v3.py (per-PR cost and time, the fast option, the official metrics, and the
idea-* figures' own data).
"""
import argparse, json, math, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from make_charts import KINDS, QR, Bench, pct  # noqa: E402  (v1's data layer)
from make_charts_v2 import AACR_TAG, colour, dot, ink, weight  # noqa: E402  (v2's look)
from matplotlib.patches import FancyBboxPatch, Polygon  # noqa: E402
import theme_v2 as theme  # noqa: E402
from theme_v2 import Page, save  # noqa: E402

FAST, OCT1 = "quickreview-fast", "quickreview-b2ce03a"
EXTRA_NAMES = {FAST: "QuickReview fast", OCT1: "QuickReview (Oct 1 build)"}
# The six biggest kinds of defect, as FIFA-style three-letter attributes.
SIX = [("bug", "Functional bugs", "BUG"), ("maintainability", "Maintainability", "MNT"),
       ("incomplete-fix", "Incomplete fixes", "FIX"), ("build", "Build and CI breaks", "BLD"),
       ("contract", "Broken contracts", "API"), ("data", "Data handling", "DAT")]


def light(T):
    return T["surface"] == theme.THEMES["light"]["surface"]


def col(t, T):
    """QuickReview blue, its fast option a lighter blue, everyone else grey."""
    if t == FAST:
        return "#86b6ef" if light(T) else "#5f8fd0"
    if t == OCT1:
        return T["qr"]
    return colour(t, T)


def tink(t, T):
    return T["ink"] if t in (QR, FAST, OCT1) else T["ink2"]


class V3:
    """data/v3.json beside v1's Bench: the fast option's credits, per-PR cost/time, official metrics."""

    def __init__(self, B):
        self.B = B
        self.d = json.load(open(os.path.join(HERE, "data", "v3.json")))

    def name(self, t):
        return EXTRA_NAMES.get(t) or self.B.name(t)

    def credit(self, t, x):
        if t in x["credit"]:
            return x["credit"][t]
        return self.d["arms"][t]["credit"][f"{x['pr']}|{x['id']}"]

    def recall(self, t, pred=None):
        xs = [x for x in self.B.D if pred is None or pred(x)]
        return sum(self.credit(t, x) for x in xs) / len(xs)

    def kind_recall(self, t, kind):
        return self.recall(t, lambda x: x["kind"] == kind)

    def mean(self, t, key):
        v = [r[key] for r in self.d["arms"][t]["per_pr"].values() if r[key] is not None]
        return sum(v) / len(v) if v else None

    def grades(self, t):
        g = (self.B.aacr["reviewers"].get(t) or {}).get("comment_grades") or self.d["arms"][t]["comment_grades"]
        n = sum(g.values())
        prs = len(self.d["arms"][t]["per_pr"])
        useful = g.get("correct-valuable", 0)
        minor = g.get("correct-minor", 0)
        return {"per_pr": n / prs, "useful": useful / prs, "minor": minor / prs, "wrong": (n - useful - minor) / prs,
                "correct": (useful + minor) / n}


def rivals(B):
    return [t for t in B.aacr_tools() if t != QR]


# ---------------------------------------------------------------- shared marks
def place_labels(p, items, taken):
    """Greedy direct labels: items [(x, y, text, kw)] in priority order; each tries a ring of
    offsets around its point and keeps the first that overlaps nothing placed (or a dot)."""
    r = p.fig.canvas.get_renderer()
    inv = p.c.transData.inverted()
    offsets = [(16, 0, "left"), (-16, 0, "right"), (0, -22, "center"), (0, 24, "center"), (16, -20, "left"),
               (16, 20, "left"), (-16, -20, "right"), (-16, 20, "right"), (0, -42, "center"), (0, 44, "center"),
               (30, -36, "left"), (-30, -36, "right"), (30, 38, "left"), (-30, 38, "right")]
    for x, y, s, kw in items:
        best = None
        for dx, dy, ha in offsets:
            t = p.text(x + dx, y + dy, s, ha=ha, **kw)
            (a, b), (c, d) = inv.transform(t.get_window_extent(renderer=r).get_points())
            rect = (min(a, c) - 3, min(b, d) - 2, max(a, c) + 3, max(b, d) + 2)
            inside = rect[0] > 8 and rect[2] < p.w - 8 and rect[1] > 100 and rect[3] < p.h - 50
            if inside and not any(rect[0] < q[2] and q[0] < rect[2] and rect[1] < q[3] and q[1] < rect[3]
                                  for q in taken):
                best = rect
                if abs(dy) >= 20:  # away from its dot: a hairline leader says whose label it is
                    ex = x + dx - (8 if ha == "left" else (-8 if ha == "right" else 0))
                    ey = y + dy + (10 if dy < 0 else -12)
                    p.c.plot([x, ex], [y, ey], color=p.T["muted"], lw=0.8, zorder=2)
                break
            t.remove()
        if best is None:  # nowhere free: the first position, accepted
            dx, dy, ha = offsets[0]
            p.text(x + dx, y + dy, s, ha=ha, **kw)
        else:
            taken.append(best)


def axes_box(p, T, box, xr, yr, xticks, yticks, xfmt, yfmt, xlabel=None, ylabel=None, ylabels=True):
    """Hairline grid and tick labels for a scatter in the pixel box (x0, top, x1, bottom)."""
    x0, y0, x1, y1 = box
    xticks = [v for v in xticks if xr[0] - 1e-9 <= v <= xr[1] + 1e-9]
    yticks = [v for v in yticks if yr[0] - 1e-9 <= v <= yr[1] + 1e-9]
    X = lambda v: x0 + (x1 - x0) * (v - xr[0]) / (xr[1] - xr[0])  # noqa: E731
    Y = lambda v: y1 - (y1 - y0) * (v - yr[0]) / (yr[1] - yr[0])  # noqa: E731
    for v in xticks:
        p.c.plot([X(v)] * 2, [y0, y1], color=T["grid"], lw=1, zorder=1)
        p.text(X(v), y1 + 22, xfmt(v), size=10.5, color=T["muted"], ha="center")
    for v in yticks:
        p.c.plot([x0, x1], [Y(v)] * 2, color=T["grid"], lw=1, zorder=1)
        if ylabels:
            p.text(x0 - 12, Y(v), yfmt(v), size=10.5, color=T["muted"], ha="right")
    if xlabel:
        p.text((x0 + x1) / 2, y1 + 50, xlabel, size=12.5, color=T["ink2"], ha="center")
    if ylabel:
        p.text(x0 - 12, y0 - 26, ylabel, size=12.5, color=T["ink2"], ha="left", va="baseline")
    return X, Y


def scatter(p, T, V, pts, X, Y, label=True, big=11, small=8):
    """pts [(tool, x, y)]: QuickReview's dots drawn last and largest; names placed greedily."""
    taken = [(X(x) - 12, Y(y) - 12, X(x) + 12, Y(y) + 12) for _, x, y in pts]
    for t, x, y in sorted(pts, key=lambda q: q[0] in (QR, FAST, OCT1)):
        dot(p, X(x), Y(y), big if t == QR else (big - 2 if t in (FAST, OCT1) else small), col(t, T), T)
    if label:
        order = sorted(pts, key=lambda q: (q[0] not in (QR, FAST, OCT1), -q[1]))
        place_labels(p, [(X(x), Y(y), V.name(t), {"size": 13 if t in (QR, FAST, OCT1) else 12,
                                                  "weight": "bold" if t == QR else "normal", "color": tink(t, T)})
                         for t, x, y in order], taken)


def f1_curves(p, T, X, Y, xr, yr, levels, size=10):
    """Faint iso-F1 curves (precision = F1 x recall / (2 recall - F1)), each labelled at its right end."""
    for f in levels:
        pts = []
        steps = 200
        for k in range(steps + 1):
            r = xr[0] + (xr[1] - xr[0]) * k / steps
            if 2 * r - f <= 0:
                continue
            pr = f * r / (2 * r - f)
            if yr[0] <= pr <= yr[1]:
                pts.append((X(r), Y(pr)))
        if len(pts) > 1:
            p.c.plot([a for a, _ in pts], [b for _, b in pts], color=T["grid"], lw=1.6, zorder=1)
            ex, ey = pts[-1]
            p.text(ex - 4, ey - 10, f"F1 {f * 100:.0f}%", size=size, color=T["muted"], ha="right")


def radar(p, T, cx, cy, R, labels, series, rings=(0.25, 0.5, 0.75, 1.0), label_size=12.5, label_gap=22,
          ring_labels=True):
    """FIFA-style attribute polygon. series [(values 0..1, fill, stroke, lw, fill_alpha, zorder)]."""
    n = len(labels)
    ang = [-math.pi / 2 + 2 * math.pi * k / n for k in range(n)]
    P = lambda k, v: (cx + R * v * math.cos(ang[k]), cy + R * v * math.sin(ang[k]))  # noqa: E731
    for rg in rings:
        p.c.add_patch(Polygon([P(k, rg) for k in range(n)], closed=True, facecolor="none", edgecolor=T["grid"],
                              lw=1, zorder=1))
        if ring_labels and rg < 1:
            x, y = P(0, rg)
            p.text(x + 5, y - 2, pct(rg), size=9, color=T["muted"])
    for k in range(n):
        p.c.plot([cx, P(k, 1)[0]], [cy, P(k, 1)[1]], color=T["grid"], lw=1, zorder=1)
    for vals, fill, stroke, lw, alpha, z in series:
        poly = [P(k, max(0.0, min(1.0, v))) for k, v in enumerate(vals)]
        if fill:
            p.c.add_patch(Polygon(poly, closed=True, facecolor=fill, edgecolor="none", alpha=alpha, zorder=z))
        p.c.add_patch(Polygon(poly, closed=True, facecolor="none", edgecolor=stroke, lw=lw, zorder=z + 0.5,
                              joinstyle="round"))
    for k, lab in enumerate(labels):
        x, y = P(k, 1)
        c, s = math.cos(ang[k]), math.sin(ang[k])
        ha = "left" if c > 0.3 else ("right" if c < -0.3 else "center")
        p.text(x + c * label_gap, y + s * label_gap + (6 if s > 0.5 else 0), lab, size=label_size, ha=ha,
               color=T["ink2"])
    return P


# ---------------------------------------------------------------- radar (FIFA-style area charts)
def fig_radar_kinds(B, V, T):
    p = Page(T, h=790)
    tools = rivals(B)
    qv = [V.kind_recall(QR, k) for k, _, _ in SIX]
    bigger = all(qv[i] > max(V.kind_recall(t, k) for t in tools) for i, (k, _, _) in enumerate(SIX))
    p.title("Bigger in every direction" if bigger else "Recall by kind of bug")
    labels = [f"{name}  {pct(v)}" for (_, name, _), v in zip(SIX, qv)]
    series = [([V.kind_recall(t, k) for k, _, _ in SIX], None, T["other"], 1.6, 0, 3) for t in tools]
    series.append((qv, T["qr"], T["qr"], 3, 0.22, 5))
    p.text(64, 128, "blue: QuickReview    grey: the six other reviewers", size=12, color=T["ink2"], va="baseline")
    radar(p, T, 600, 438, 236, labels, series)
    p.source(AACR_TAG + " · share of each kind of bug found")
    return p


def card(p, T, V, x, y, w, h, t, qr_shape=None):
    vals = [V.kind_recall(t, k) for k, _, _ in SIX]
    q = t in (QR, FAST)
    p.c.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0,rounding_size=14",
                                 facecolor="#f2f1ec" if light(T) else "#242423", edgecolor="none", zorder=0.5))
    if q:  # the accent strip on QuickReview's own cards
        p.c.add_patch(FancyBboxPatch((x, y), w, 7, boxstyle="round,pad=0,rounding_size=3", facecolor=col(t, T),
                                     edgecolor="none", zorder=0.6))
    p.text(x + 18, y + 58, f"{V.recall(t) * 100:.0f}", size=34, weight="bold", color=tink(t, T), va="baseline")
    p.text(x + 18, y + 84, V.name(t), size=11.5, weight="bold" if q else "normal", color=tink(t, T), va="baseline")
    series = []
    if qr_shape is not None and t != QR:
        series.append((qr_shape, None, T["qr"], 1.4, 0, 2))
    series.append((vals, col(t, T), col(t, T), 2.2, 0.35 if q else 0.55, 3))
    radar(p, T, x + w - 62, y + 64, 44, [""] * len(SIX), series, rings=(0.5, 1.0), label_size=1, label_gap=0,
          ring_labels=False)
    for i, ((_, _, code), v) in enumerate(zip(SIX, vals)):
        cx, cy = x + 18 + (i // 3) * (w / 2 - 6), y + 140 + (i % 3) * 25
        p.text(cx, cy, f"{v * 100:.0f}", size=13, weight="bold", color=tink(t, T), va="baseline")
        p.text(cx + 32, cy, code, size=11, color=T["muted"], va="baseline")


def fig_radar_cards(B, V, T):
    p = Page(T, h=720)
    p.title("Player cards")
    order = [QR, FAST] + sorted(rivals(B), key=lambda t: -V.recall(t))
    qr_shape = [V.kind_recall(QR, k) for k, _, _ in SIX]
    w, h, gx, gy, top = 258, 228, 16, 18, 128
    for i, t in enumerate(order):
        r, c = divmod(i, 4)
        card(p, T, V, 64 + c * (w + gx), top + r * (h + gy), w, h, t, qr_shape)
    p.source("AACR-Bench · big number: % of all 520 bugs found · BUG functional · MNT maintainability · "
             "FIX incomplete fix · BLD build · API contract · DAT data")
    return p


def fig_radar_tradeoffs(B, V, T):
    """The honest card: what QuickReview is great at, and what it costs."""
    p = Page(T, h=790)
    tools = B.aacr_tools()
    g = {t: V.grades(t) for t in tools}
    cost = {t: V.mean(t, "usd") for t in tools}
    mins = {t: V.mean(t, "minutes") for t in tools}
    axes = [
        ("Bugs found", lambda t: V.recall(t)),
        ("High-severity found", lambda t: V.recall(t, lambda x: x["severity"] == "high")),
        ("Correct comments", lambda t: g[t]["correct"]),
        ("Fewer comments", lambda t: min(g[u]["per_pr"] for u in tools) / g[t]["per_pr"]),
        ("Speed", lambda t: min(mins.values()) / mins[t]),
        ("Low cost", lambda t: min(cost.values()) / cost[t]),
    ]
    p.title("Finds the most, but slow and costly")
    series = [([f(t) for _, f in axes], None, T["other"], 1.6, 0, 3) for t in tools if t != QR]
    qv = [f(QR) for _, f in axes]
    series.append((qv, T["qr"], T["qr"], 3, 0.22, 5))
    p.text(64, 128, "blue: QuickReview    grey: the six other reviewers    outer ring: the best of the seven",
           size=12, color=T["ink2"], va="baseline")
    radar(p, T, 600, 438, 236, [f"{lab}  {v * 100:.0f}" for (lab, _), v in zip(axes, qv)], series,
          ring_labels=False)
    p.source(AACR_TAG + " · speed, low cost and fewer comments relative to the best reviewer (= 100)")
    return p


# ---------------------------------------------------------------- honest: what it costs
def tradeoff(p, T, V, B, key, yfmt, ylabel, title_word):
    tools = B.aacr_tools() + [FAST]
    pts = [(t, V.recall(t), V.mean(t, key)) for t in tools]
    top = max(y for _, _, y in pts)
    step = 0.5 if key == "usd" else 5
    ymax = math.ceil(top * 1.08 / step) * step
    X, Y = axes_box(p, T, (150, 150, 1050, 560), (0.3, 1.0), (0, ymax), [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
                    [k * step for k in range(round(ymax / step) + 1)], pct, yfmt,
                    xlabel="share of the 520 bugs found", ylabel=ylabel)
    scatter(p, T, V, pts, X, Y)
    return pts


def fig_honest_cost(B, V, T):
    p = Page(T)
    pts = tradeoff(p, T, V, B, "usd", lambda v: f"${v:.2f}", "average cost per PR", "cost")
    most = max(pts, key=lambda q: q[1])[0] == QR and max(pts, key=lambda q: q[2])[0] == QR
    p.title("Finds the most, costs the most" if most else "Bugs found against cost")
    p.source(AACR_TAG + " · list prices")
    return p


def fig_honest_time(B, V, T):
    p = Page(T)
    pts = tradeoff(p, T, V, B, "minutes", lambda v: f"{v:.0f} min", "average minutes per PR", "time")
    most = max(pts, key=lambda q: q[1])[0] == QR and max(pts, key=lambda q: q[2])[0] == QR
    p.title("Finds the most, takes the longest" if most else "Bugs found against review time")
    p.source(AACR_TAG + " · wall-clock minutes under a shared scheduler")
    return p


def by_kind_grid(p, T, V, B, key, yfmt, kinds=KINDS):
    tools = B.aacr_tools() + [FAST]
    ys = {t: V.mean(t, key) for t in tools}
    step = 0.5 if key == "usd" else 5
    ymax = math.ceil(max(ys.values()) * 1.1 / step) * step
    cols, pw, ph, gx, gy, left, top = 4, 236, 180, 40, 74, 92, 150
    ahead = 0
    for i, (k, name) in enumerate(kinds):
        r, c = divmod(i, cols)
        x0, y0 = left + c * (pw + gx), top + r * (ph + gy)
        n = sum(1 for x in B.D if x["kind"] == k)
        p.text(x0, y0 - 16, name, size=12.5, weight="bold", va="baseline")
        p.text(x0 + pw, y0 - 16, f"{n} bugs", size=10, color=T["muted"], ha="right", va="baseline")
        X, Y = axes_box(p, T, (x0, y0, x0 + pw, y0 + ph), (0, 1.0), (0, ymax), [0, 0.5, 1.0], [0, ymax], pct,
                        yfmt, ylabels=c == 0)
        pts = [(t, V.kind_recall(t, k), ys[t]) for t in tools]
        ahead += max(pts, key=lambda q: q[1])[0] == QR
        scatter(p, T, V, pts, X, Y, label=False, big=8, small=5.5)
        qx, qy = V.kind_recall(QR, k), ys[QR]
        p.text(X(qx) - 12, Y(qy) - 1, pct(qx), size=11.5, weight="bold", ha="right")
    return ahead


def fig_honest_cost_by_kind(B, V, T):
    p = Page(T, h=720)
    ahead = by_kind_grid(p, T, V, B, "usd", lambda v: f"${v:.1f}")
    p.title("Ahead on every kind of bug, at a higher price" if ahead == len(KINDS) else "Bugs found against cost, by kind")
    p.source(AACR_TAG + " · x: share of that kind found · y: average cost per PR · blue: QuickReview, light blue: fast")
    return p


def fig_honest_time_by_kind(B, V, T):
    p = Page(T, h=720)
    ahead = by_kind_grid(p, T, V, B, "minutes", lambda v: f"{v:.0f}m")
    p.title("Ahead on every kind of bug, and slower" if ahead == len(KINDS) else "Bugs found against time, by kind")
    p.source(AACR_TAG + " · x: share of that kind found · y: average minutes per PR · blue: QuickReview, light blue: fast")
    return p


def fig_honest_comments(B, V, T):
    """Comments per PR, split by what the judge made of them."""
    tools = sorted(B.aacr_tools(), key=lambda t: -V.grades(t)["per_pr"])
    p = Page(T)
    g = {t: V.grades(t) for t in tools}
    p.title("More comments, and more of them minor" if tools[0] == QR else "Comments per PR")
    x0, x1, top, bottom = 314, 1010, 150, 590
    vmax = max(v["per_pr"] for v in g.values())
    s = (x1 - x0) / vmax
    pitch = (bottom - top) / len(tools)
    shades = {"useful": 1.0, "minor": 0.5, "wrong": 0.22}
    for i, t in enumerate(tools):
        y = top + pitch * (i + 0.5)
        x = x0
        for seg in ("useful", "minor", "wrong"):
            w = g[t][seg] * s
            if w > 0:
                p.c.add_patch(FancyBboxPatch((x, y - 12), max(w - 2, 0.5), 24, boxstyle="square,pad=0",
                                             facecolor=col(t, T), alpha=shades[seg], edgecolor="none", zorder=3))
                if t == QR and w > 70:
                    p.text(x + w / 2, y + 1, f"{seg} {g[t][seg]:.1f}", size=11, ha="center",
                           color="#ffffff" if seg == "useful" else T["ink"])
            x += w
        p.text(x0 - 16, y, B.name(t), ha="right", weight=weight(t), color=ink(t, T))
        p.text(x + 10, y, f"{g[t]['per_pr']:.1f}", size=14, weight=weight(t), color=ink(t, T))
    p.source(AACR_TAG + " · comments per PR: useful, true but minor, wrong or partly wrong (judge's grades)")
    return p


# ---------------------------------------------------------------- official: each benchmark's own metric
def ordinal(k, n):
    return "top" if k == 1 else ("last" if k == n else {2: "2nd", 3: "3rd"}.get(k, f"{k}th"))


def official_rows(B, V, bench):
    """[(tool, recall, precision, f1)] under the benchmark's own metric."""
    if bench == "aacr":
        rows = V.d["official"]["aacr"]
        return [(t, r["recall"], r["precision"], r["f1"]) for t, r in rows.items() if r is not None and t != FAST]
    if bench == "martian":
        return [(t, r["recall"], r["precision"], r["f1"]) for t, r in V.d["official"]["martian"].items()]
    return [(t, row["scores"]["N=5"]["recall"], row["scores"]["N=5"]["precision"], row["scores"]["N=5"]["f1"])
            for t, row in B.qodo["tools"].items()]


def official_title(rows, prefix):
    me = next(r for r in rows if r[0] in (QR, OCT1))
    n = len(rows)
    rr = 1 + sum(1 for r in rows if r[1] > me[1])
    rf = 1 + sum(1 for r in rows if r[3] > me[3])
    return f"{prefix}: {ordinal(rr, n)} on recall, {ordinal(rf, n)} on F1"


OFFICIAL = {
    "aacr": ("AACR-Bench's own score", "AACR-Bench's own metric: matching its 1,418 reference comments · 185 PRs · "
             "QuickReview: the Oct 1 build (the frozen build was not scored on it)", (0, 0.13), (0, 0.25),
             [0.05, 0.1, 0.15]),
    "martian": ("Martian's own score", "Martian's own metric (Core) · 50 PRs · one gpt-6.1-sol judge for every tool",
                (0.3, 0.7), (0, 0.65), [0.2, 0.3, 0.4, 0.5]),
    "qodo": ("Qodo's own score", "Qodo PR-Review-Bench's rule (file + ±5 lines) · 100 PRs · one gpt-6.1-sol judge",
             (0.1, 0.5), (0.3, 0.8), [0.2, 0.3, 0.4, 0.5]),
}


def official_panel(p, T, V, B, bench, box, label=True, size=10):
    _, _, xr, yr, levels = OFFICIAL[bench]
    rows = official_rows(B, V, bench)
    step = 0.05 if xr[1] <= 0.2 else 0.1
    xt = [round(xr[0] + step * k, 2) for k in range(round((xr[1] - xr[0]) / step) + 1)]
    ystep = 0.05 if yr[1] <= 0.3 else 0.1
    yt = [round(yr[0] + ystep * k, 2) for k in range(round((yr[1] - yr[0]) / ystep) + 1)]
    X, Y = axes_box(p, T, box, xr, yr, xt, yt, pct, pct, xlabel="recall" if label else None,
                    ylabel="precision" if label else None)
    f1_curves(p, T, X, Y, xr, yr, levels, size=size)
    scatter(p, T, V, [(t, r, pr) for t, r, pr, _ in rows], X, Y, label=label)
    return rows


def fig_official(bench):
    def fig(B, V, T):
        p = Page(T, h=700)
        rows = official_panel(p, T, V, B, bench, (150, 150, 1050, 580))
        p.title(official_title(rows, OFFICIAL[bench][0]))
        p.source(OFFICIAL[bench][1])
        return p
    return fig


def fig_official_combined(B, V, T):
    p = Page(T)
    p.title("Each benchmark, scored by its own rules")
    for i, (bench, name) in enumerate((("aacr", "AACR-Bench"), ("martian", "Martian"), ("qodo", "Qodo"))):
        x0 = 120 + i * 360
        rows = official_panel(p, T, V, B, bench, (x0, 170, x0 + 270, 520), label=False, size=8.5)
        me = next(r for r in rows if r[0] in (QR, OCT1))
        p.text(x0, 140, name, size=15, weight="bold", va="baseline")
        p.text(x0 + 270, 140, f"F1 {me[3] * 100:.0f}%", size=12, color=T["ink2"], ha="right", va="baseline")
    p.text(120, 600, "x: recall   y: precision   blue: QuickReview   grey: other tools   curves: equal F1",
           size=11.5, color=T["ink2"], va="baseline")
    p.source("Each benchmark's own metric, all rows under one judge per benchmark · AACR-Bench: QuickReview's Oct 1 build")
    return p


# ---------------------------------------------------------------- the table view (out/v3/NUMBERS.md)
def table(head, rows):
    return "\n".join(["| " + " | ".join(head) + " |", "|---|" + "---:|" * (len(head) - 1)] +
                     ["| " + " | ".join(str(c) for c in r) + " |" for r in rows])


def money(v):
    return "not priced" if v is None else f"${v:.2f}"


def minutes(v):
    return "not timed" if v is None else f"{v:.1f}"


def numbers_radar(B, V):
    tools = sorted(B.aacr_tools() + [FAST], key=lambda t: -V.recall(t))
    rows = [[V.name(t), pct(V.recall(t))] + [pct(V.kind_recall(t, k)) for k, _ in KINDS] for t in tools]
    counts = ", ".join(f"{name} {sum(1 for x in B.D if x['kind'] == k)}" for k, name in KINDS)
    return ("### radar-kinds, radar-cards, honest-cost-by-kind, honest-time-by-kind\n\n"
            f"Share of each kind of verified defect found (AACR-Bench, 185 PRs, {len(B.D)} defects).\n\n" +
            table(["reviewer", "all"] + [name for _, name in KINDS], rows) +
            f"\n\nDefects per kind: {counts}. The radars draw the six largest kinds.\n")


def numbers_honest(B, V):
    tools = sorted(B.aacr_tools() + [FAST], key=lambda t: -V.recall(t))
    rows = []
    for t in tools:
        g = V.grades(t)
        rows.append([V.name(t), pct(V.recall(t)), pct(V.recall(t, lambda x: x["severity"] == "high")),
                     money(V.mean(t, "usd")), minutes(V.mean(t, "minutes")), f"{g['per_pr']:.1f}",
                     f"{g['useful']:.1f}", f"{g['minor']:.1f}", f"{g['wrong']:.1f}", pct(g["correct"])])
    return ("### radar-tradeoffs, honest-cost, honest-time, honest-comments\n\n"
            "Per reviewer on AACR-Bench (185 PRs): defects found, cost and time per PR (means), and the judge's "
            "grades of its comments per PR.\n\n" +
            table(["reviewer", "found", "high found", "$ / PR", "minutes / PR", "comments / PR", "useful",
                   "minor", "wrong or partly", "correct share"], rows) +
            "\n\n- Cost: list prices of the tokens each reviewer used (Claude Code: its own API-price total). "
            "Minutes: wall-clock under a shared scheduler, so a busy machine inflates them.\n"
            "- radar-tradeoffs scores speed, low cost and fewer comments relative to the best of the seven "
            "(best = 100): QuickReview's are its ratio to that best.\n")


def numbers_official(B, V):
    out = ["### official-aacr, official-martian, official-qodo, official-combined", "",
           "Each benchmark scored by its own metric on its own reference list (not our verified-defect key).", ""]
    for bench, (prefix, src, *_) in OFFICIAL.items():
        rows = sorted(official_rows(B, V, bench), key=lambda r: -r[3])
        out += [f"**{prefix}**: {src}", "",
                table(["tool", "recall", "precision", "F1"],
                      [[V.name(t), pct(r), pct(pr), pct(f)] for t, r, pr, f in rows]), ""]
    return "\n".join(out)


NUMBERS = [numbers_radar, numbers_honest, numbers_official]


FIGURES = {
    "radar-kinds": fig_radar_kinds,
    "radar-cards": fig_radar_cards,
    "radar-tradeoffs": fig_radar_tradeoffs,
    "honest-cost": fig_honest_cost,
    "honest-time": fig_honest_time,
    "honest-cost-by-kind": fig_honest_cost_by_kind,
    "honest-time-by-kind": fig_honest_time_by_kind,
    "honest-comments": fig_honest_comments,
    "official-aacr": fig_official("aacr"),
    "official-martian": fig_official("martian"),
    "official-qodo": fig_official("qodo"),
    "official-combined": fig_official_combined,
}


def main():
    import ideas_v3  # here, not at the top: ideas_v3 imports this module's helpers
    figures = {**FIGURES, **ideas_v3.FIGURES}
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("names", nargs="*", help="figures to draw (default: all, and NUMBERS.md)")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--theme", choices=("light", "dark", "both"), default="both")
    ap.add_argument("--out", default=os.path.join(HERE, "out", "v3"))
    a = ap.parse_args()
    if a.list:
        print("\n".join(figures))
        return
    names = a.names or list(figures)
    unknown = [n for n in names if n not in figures]
    if unknown:
        sys.exit(f"unknown figure(s): {', '.join(unknown)} (see --list)")
    B = Bench()
    V = V3(B)
    for th in (("light", "dark") if a.theme == "both" else (a.theme,)):
        for name in names:
            T = theme.use(th)
            print("wrote", os.path.relpath(save(figures[name](B, V, T), a.out, name, th, svg=th == "light")))
    if not a.names:
        path = os.path.join(a.out, "NUMBERS.md")
        sections = [f(B, V) for f in NUMBERS] + [f(B, V) for f in ideas_v3.NUMBERS.values()]
        with open(path, "w") as fh:
            fh.write("# The numbers behind out/v3\n\nEvery number each v3 image prints, and the ones it rests on, as "
                     f"tables (data/v3.json built {V.d['generated']}). Written by make_charts_v3.py: do not edit "
                     "by hand.\n\n" + "\n".join(s.rstrip("\n") + "\n" for s in sections))
        print("wrote", os.path.relpath(path))


if __name__ == "__main__":
    main()
