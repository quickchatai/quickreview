#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["matplotlib>=3.8"]
# ///
"""Showcase graphics v2 — one chart per image, a few-word title, nothing else.

    uv run bench/aacr/showcase/make_charts_v2.py            # every figure, both themes, into out/v2/
    uv run bench/aacr/showcase/make_charts_v2.py headline   # one figure (names: --list)

v2 leaves v1 (make_charts.py, theme.py, out/) untouched and reuses its data
layer: the same data/*.json and the same Bench arithmetic, so both versions
always show the same numbers. Every image must read without explanation: a
short title that IS the message, the marks, direct labels and one tiny
benchmark tag. The method and the caveats live in the README; the table behind
every chart in out/NUMBERS.md. Every number, and every claim a title makes, is
computed at render time.
"""
import argparse, math, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from make_charts import HIGH, KINDS, QR, SERIOUS, Bench, fmt, pct  # noqa: E402  (v1's data layer)
from matplotlib.patches import Circle, FancyBboxPatch  # noqa: E402
import theme_v2 as theme  # noqa: E402
from theme_v2 import Page, bar, save  # noqa: E402

AACR_TAG = "AACR-Bench · 185 real pull requests"


def colour(t, T):
    return T["qr"] if t == QR else T["other"]


def ink(t, T):
    return T["ink"] if t == QR else T["ink2"]


def weight(t):
    return "bold" if t == QR else "normal"


def martian_share(B, t):
    """QuickReview on our judge; every other tool at its BEST count, re-judged or Martian's own
    published grading — the reading most generous to the competition."""
    d = B.martian_best().get(t)
    if not d:
        return None
    return (d["same"] if t == QR else max(d.values())) / B.martian["real_goldens"]


def dot(p, x, y, r, fill, T):
    p.c.add_patch(Circle((x, y), r + 2.5, facecolor=T["surface"], edgecolor="none", zorder=3))
    p.c.add_patch(Circle((x, y), r, facecolor=fill, edgecolor="none", zorder=4))


def bar_list(p, B, T, rows, top, bottom, label=pct, big_qr=False, vmax=None, name_w=250):
    """One horizontal bar per (tool, value): QuickReview in the accent, the field grey, values at the tips."""
    vmax = vmax or max(v for _, v in rows)
    pitch = (bottom - top) / len(rows)
    h = min(24, pitch * 0.56)
    x0, x1 = 64 + name_w, p.w - 170
    for i, (t, v) in enumerate(rows):
        y = top + pitch * (i + 0.5)
        tip = x0 + (x1 - x0) * v / vmax
        bar(p.c, x0, tip, y, h, colour(t, T), zorder=3)
        p.text(x0 - 16, y, B.name(t), ha="right", weight=weight(t), color=ink(t, T))
        p.text(tip + 12, y, label(v), size=24 if t == QR and big_qr else 14, weight=weight(t), color=ink(t, T))


def dot_rows(p, T, rows, top, bottom, x0=300, x1=1060):
    """One row per (label, {tool: share}): the field as grey dots, QuickReview as the accent dot with
    its value beside it. Returns the x of a share."""
    pitch = (bottom - top) / len(rows)
    X = lambda v: x0 + (x1 - x0) * v  # noqa: E731
    for tk in (0, .25, .5, .75, 1):
        p.c.plot([X(tk)] * 2, [top, bottom], color=T["grid"], lw=1, zorder=1)
        p.text(X(tk), bottom + 28, pct(tk), size=11, color=T["muted"], ha="center")
    for i, (label, vals) in enumerate(rows):
        y = top + pitch * (i + 0.5)
        q = vals[QR]
        others = [v for t, v in vals.items() if t != QR and v is not None]
        p.c.plot([X(min(others + [q])), X(max(others + [q]))], [y, y], color=T["grid"], lw=3, zorder=2,
                 solid_capstyle="round")
        for v in others:
            dot(p, X(v), y, 7, T["other"], T)
        dot(p, X(q), y, 11, T["qr"], T)
        if all(X(v) <= X(q) or X(v) - X(q) > 70 for v in others):
            p.text(X(q) + 20, y, pct(q), size=16, weight="bold")
        else:  # a grey dot sits just right of it: the value goes above instead
            p.text(X(q), y - 26, pct(q), size=16, weight="bold", ha="center")
        p.text(x0 - 24, y, label, size=15, ha="right")
    return X


# ---------------------------------------------------------------- the figures
def fig_headline(B, T):
    n = B.total(HIGH)
    p = Page(T)
    p.title(f"{pct(B.recall(QR, HIGH))} of high-severity bugs caught")
    bar_list(p, B, T, [(t, B.found(t, HIGH) / n) for t in B.ranked(HIGH)], 136, 604, big_qr=True, vmax=1.0)
    p.source(AACR_TAG)
    return p


def fig_missed(B, T):
    """Unit chart: one square per serious (high or medium) bug a reviewer missed."""
    n = B.total(SERIOUS)
    order = sorted(B.aacr_tools(), key=lambda t: n - B.found(t, SERIOUS))
    p = Page(T)
    p.title("Fewest serious bugs missed" if order[0] == QR else "Serious bugs missed")
    unit, gap, tall, x0, top, bottom = 11, 3, 3, 314, 136, 606
    pitch = (bottom - top) / len(order)
    bh = tall * (unit + gap) - gap
    for i, t in enumerate(order):
        y = top + pitch * (i + 0.5)
        m = n - B.found(t, SERIOUS)
        whole = int(m)
        for k in range(whole + (1 if m - whole >= 0.5 else 0)):
            col, row = divmod(k, tall)
            p.c.add_patch(FancyBboxPatch((x0 + col * (unit + gap), y - bh / 2 + row * (unit + gap)),
                                         unit if k < whole else unit / 2, unit,
                                         boxstyle="round,pad=0,rounding_size=2", facecolor=colour(t, T),
                                         edgecolor="none"))
        p.text(x0 - 16, y, B.name(t), ha="right", weight=weight(t), color=ink(t, T))
        p.text(x0 + math.ceil(m / tall) * (unit + gap) + 10, y, fmt(m), size=22 if t == QR else 15,
               weight=weight(t), color=ink(t, T))
    p.source(AACR_TAG)
    return p


def fig_union(B, T):
    """QuickReview alone against the six other reviewers pooled."""
    others = [t for t in B.aacr_tools() if t != QR]
    union = sum(max(x["credit"][o] for o in others) for x in B.D)
    qr = B.found(QR)
    verb = "beats" if qr > union else ("matches" if qr == union else "trails")
    p = Page(T)
    p.title(f"QuickReview alone {verb} {len(others)} tools combined")
    base, peak = 556, 196
    s = (base - peak) / max(qr, union)
    p.c.plot([300, 900], [base, base], color=T["grid"], lw=1.2, zorder=1)
    for cx, label, v, t in ((440, f"{len(others)} other tools combined", union, None), (760, "QuickReview", qr, QR)):
        bar(p.c, base, base - v * s, cx, 180, colour(t, T), r=5, vertical=True, zorder=3)
        p.text(cx, base - v * s - 40, fmt(v), size=30, weight="bold", ha="center", color=ink(t, T))
        p.text(cx, base + 36, label, size=16, ha="center", weight=weight(t), color=ink(t, T))
    p.source(AACR_TAG + " · bugs found")
    return p


def fig_head_to_head(B, T):
    """Butterfly: bugs only QuickReview found against bugs only the other tool found."""
    rows = []
    for t in (t for t in B.aacr_tools() if t != QR):
        a = sum(1 for x in B.D if x["credit"][QR] >= 0.5 and x["credit"][t] == 0)
        b = sum(1 for x in B.D if x["credit"][t] >= 0.5 and x["credit"][QR] == 0)
        rows.append((t, a, b))
    rows.sort(key=lambda r: r[1])
    p = Page(T)
    p.title("Head to head")
    cx_l, cx_r, top, bottom, h = 500, 700, 190, 610, 22
    s = 380 / max(max(a, b) for _, a, b in rows)
    p.text(cx_l, 152, "found only by QuickReview", size=13, ha="right", weight="bold")
    p.text(cx_r, 152, "found only by the other tool", size=13, color=T["ink2"])
    pitch = (bottom - top) / len(rows)
    for i, (t, a, b) in enumerate(rows):
        y = top + pitch * (i + 0.5)
        bar(p.c, cx_l, cx_l - a * s, y, h, T["qr"], zorder=3)
        if b:
            bar(p.c, cx_r, cx_r + b * s, y, h, T["other"], zorder=3)
        p.text(cx_l - a * s - 10, y, str(a), size=15, weight="bold", ha="right")
        p.text(cx_r + b * s + 10, y, str(b), size=15, color=T["ink2"])
        p.text(600, y, B.name(t), ha="center", color=T["ink2"])
    p.source(AACR_TAG)
    return p


def fig_clean_catch(B, T):
    """Waffles: one square per PR with a serious bug, filled when the reviewer caught every one."""
    prs = {}
    for x in B.D:
        if x["severity"] in SERIOUS:
            prs.setdefault(x["pr"], []).append(x)
    n = len(prs)
    share = {t: sum(1 for xs in prs.values() if all(x["credit"][t] == 1 for x in xs)) for t in B.aacr_tools()}
    order = sorted(share, key=lambda t: -share[t])
    p = Page(T)
    p.title(f"Every serious bug caught on {pct(share[QR] / n)} of PRs")
    cols, unit, gap = 8, 14, 3
    gw = cols * (unit + gap) - gap
    step = (p.w - 128 - gw) / (len(order) - 1)
    for i, t in enumerate(order):
        x0 = 64 + i * step
        p.text(x0, 200, pct(share[t] / n), size=26 if t == QR else 22, weight="bold", color=ink(t, T),
               va="baseline")
        p.text(x0, 228, B.name(t), size=12, weight=weight(t), color=ink(t, T), va="baseline")
        for k in range(n):
            r, c = divmod(k, cols)
            p.c.add_patch(FancyBboxPatch((x0 + c * (unit + gap), 252 + r * (unit + gap)), unit, unit,
                                         boxstyle="round,pad=0,rounding_size=2",
                                         facecolor=colour(t, T) if k < share[t] else T["empty"], edgecolor="none"))
    p.source(AACR_TAG)
    return p


def fig_qodo(B, T):
    rows = sorted(((t, B.qodo_recall(t)) for t in B.qodo["tools"]), key=lambda r: -r[1])
    p = Page(T, h=720)
    p.title("Most functional bugs found" if rows[0][0] == QR else "Functional bugs found")
    bar_list(p, B, T, rows, 128, 662)
    q = B.qodo["tools"][QR]
    p.source(f"Qodo PR-Review-Bench · {q['prs']} PRs · {q['issues'] - q['rule_issues']} functional bugs")
    return p


def fig_martian(B, T):
    rows = sorted(((t, martian_share(B, t)) for t in B.martian_best()), key=lambda r: -r[1])
    p = Page(T, h=830)
    p.title("Most real bugs found" if rows[0][0] == QR else "Real bugs found")
    bar_list(p, B, T, rows, 128, 772)
    p.source(f"Martian benchmark · {B.martian['prs']} PRs · {B.martian['real_goldens']} real bugs")
    return p


def fig_same_model(B, T):
    tools = [t for t in B.ranked() if B.tools[t].get("model") == "gpt-6.1-sol"]
    mb = B.martian_best()
    rows = [("AACR-Bench", {t: B.recall(t) for t in tools}),
            ("Martian", {t: mb[t]["same"] / B.martian["real_goldens"] for t in tools if "same" in mb.get(t, {})}),
            ("Qodo", {t: B.qodo_recall(t, "recall") for t in tools if t in B.qodo["tools"]})]
    p = Page(T)
    p.title("Same model, better reviewer")
    X = dot_rows(p, T, rows, 150, 560)
    first = [v for t, v in rows[0][1].items() if t != QR]
    p.text(X(sum(first) / len(first)), 150 + (560 - 150) / 6 - 24, "other tools", size=11.5, color=T["muted"],
           ha="center")
    p.source("Every tool on the same model, GPT-6.1 · share of bugs found")
    return p


def fig_by_kind(B, T):
    rows = []
    for k, label in KINDS:
        pred = (lambda kk: lambda x: x["kind"] == kk)(k)
        if B.total(pred=pred):
            rows.append((label, {t: B.recall(t, pred=pred) for t in B.aacr_tools()}))
    ahead = sum(1 for _, v in rows if v[QR] > max(x for t, x in v.items() if t != QR))
    p = Page(T, h=720)
    p.title("Ahead on every kind of bug" if ahead == len(rows) else f"Ahead on {ahead} of {len(rows)} kinds of bug")
    dot_rows(p, T, rows, 126, 604)
    p.source(AACR_TAG)
    return p


def fig_by_size(B, T):
    buckets = [(0, 50, "Small PRs"), (51, 200, "Medium PRs"), (201, 10 ** 9, "Large PRs")]
    tools = B.aacr_tools()
    vals = {t: [] for t in tools}
    for lo, hi, _ in buckets:
        pred = (lambda a, b: lambda x: a <= x["changed_lines"] <= b)(lo, hi)
        for t in tools:
            vals[t].append(B.recall(t, pred=pred))
    lead = [vals[QR][i] - max(vals[t][i] for t in tools if t != QR) for i in range(len(buckets))]
    if lead[-1] >= lead[0] + 0.05:
        title = "Bigger PRs, bigger lead"
    elif vals[QR][-1] >= vals[QR][0] - 0.02:
        title = "No drop-off on big PRs"
    else:
        title = "Bugs found by PR size"
    p = Page(T)
    p.title(title)
    floor = math.floor(min(min(v) for v in vals.values()) * 4) / 4
    xs = [190, 560, 930]
    Y = lambda v: 560 - (v - floor) / (1 - floor) * 400  # noqa: E731
    for k in range(round((1 - floor) / 0.25) + 1):
        v = floor + 0.25 * k
        p.c.plot([150, 970], [Y(v)] * 2, color=T["grid"], lw=1, zorder=1)
        p.text(136, Y(v), pct(v), size=11, color=T["muted"], ha="right")
    for t in sorted(tools, key=lambda t: t == QR):
        ys = [Y(v) for v in vals[t]]
        if t == QR:
            p.c.plot(xs, ys, color=T["qr"], lw=4.5, solid_capstyle="round", solid_joinstyle="round", zorder=5)
            for x, y, v in zip(xs, ys, vals[t]):
                dot(p, x, y, 9, T["qr"], T)
                p.text(x, y - 30, pct(v), size=17, weight="bold", ha="center")
        else:
            p.c.plot(xs, ys, color=T["other"], lw=2.2, solid_capstyle="round", zorder=3)
    for x, (_, _, label) in zip(xs, buckets):
        p.text(x, 604, label, size=14, ha="center", color=T["ink2"])
    p.text(xs[-1] + 24, Y(vals[QR][-1]), "QuickReview", size=14, weight="bold")
    rest = [vals[t][-1] for t in tools if t != QR]
    p.text(xs[-1] + 24, Y(sum(rest) / len(rest)), "other tools", size=13, color=T["muted"])
    p.source(AACR_TAG)
    return p


def fig_every_benchmark(B, T):
    rows = [("AACR-Bench", {t: B.recall(t) for t in B.aacr_tools()}),
            ("Martian", {t: martian_share(B, t) for t in B.martian_best()}),
            ("Qodo", {t: B.qodo_recall(t) for t in B.qodo["tools"]})]
    firsts = sum(1 for _, v in rows if v[QR] >= max(v.values()))
    p = Page(T)
    p.title("#1 on all three benchmarks" if firsts == len(rows) else f"#1 on {firsts} of {len(rows)} benchmarks")
    dot_rows(p, T, rows, 150, 560)
    p.source("Share of bugs found · every reviewer with a result")
    return p


FIGURES = {
    "headline": fig_headline,
    "headline-missed": fig_missed,
    "one-vs-six": fig_union,
    "head-to-head": fig_head_to_head,
    "clean-catch": fig_clean_catch,
    "qodo-functional": fig_qodo,
    "martian-real-bugs": fig_martian,
    "same-model": fig_same_model,
    "by-kind": fig_by_kind,
    "by-size": fig_by_size,
    "every-benchmark": fig_every_benchmark,
}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("names", nargs="*", help="figures to draw (default: all)")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--theme", choices=("light", "dark", "both"), default="both")
    ap.add_argument("--out", default=os.path.join(HERE, "out", "v2"))
    a = ap.parse_args()
    if a.list:
        print("\n".join(FIGURES))
        return
    names = a.names or list(FIGURES)
    unknown = [n for n in names if n not in FIGURES]
    if unknown:
        sys.exit(f"unknown figure(s): {', '.join(unknown)} (see --list)")
    B = Bench()
    for th in (("light", "dark") if a.theme == "both" else (a.theme,)):
        for name in names:
            T = theme.use(th)
            print("wrote", os.path.relpath(save(FIGURES[name](B, T), a.out, name, th, svg=th == "light")))


if __name__ == "__main__":
    main()
