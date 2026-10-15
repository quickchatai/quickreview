#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["matplotlib>=3.8"]
# ///
"""v5 'what is a found bug worth' charts, for out/v5/BUG-VALUE.md: v4's, with the model each reviewer ran on.

    uv run bench/aacr/showcase/value_v5.py [names]   # draws this file's figures into out/v5/

v5 changes the names, not the numbers. QuickReview's labels carry its model ("QuickReview (GPT-6.1 Sol)",
through make_charts_v5.V5), each name column is sized to its longest label, and the small print says which
model every reviewer ran on, read from the runs (data/v5.json). The ladder's reading cost is "our estimate",
so it is not mistaken for an AI model. The report says which build and model its numbers are.

Everything is computed from AACR-Bench's 185 PRs (data/aacr.json, data/v3.json) and the hand-kept
assumptions in data/value.json (an engineer's hourly cost, reading speed, seconds to triage a comment).
Change an assumption there and re-render: every number, title and break-even point moves with it.

A reviewer's ALL-IN cost per PR = its model spend + the time a person spends reading what it posted
(words ÷ reading speed, plus a triage time per comment) × the engineer's hourly cost. QuickReview's
reader skips its [nit]s: no serious (high or medium) finding arrives through a nit alone
(v3's idea-skip-nits), so its reading cost counts blockers and questions only.
"""
import json, math, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from matplotlib.patches import Rectangle  # noqa: E402
from theme_v4 import Page4, bar, bar_rows, dot  # noqa: E402

QR, FAST = "quickreview", "quickreview-fast"
SERIOUS = ("high", "medium")


class Value:
    """Per reviewer on AACR-Bench: serious defects found and missed, model spend, reading load."""

    def __init__(self, B, V):
        self.B, self.V = B, V
        self.a = json.load(open(os.path.join(HERE, "data", "value.json")))
        self.s = V.v3["ideas"]["idea-skip-nits"]  # comments, words and tag credits per reviewer
        self.prs = self.s["prs"]
        self.serious_total = sum(self.s["defects"][k] for k in SERIOUS)
        self.tools = [QR, FAST] + [t for t in B.aacr_tools() if t != QR]

    def name(self, t):
        return self.V.name(t)

    def serious_found(self, t):
        return sum(self.s["reviewers"][t]["credit"][k] for k in SERIOUS)

    def missed_per_100(self, t):
        return (self.serious_total - self.serious_found(t)) / self.prs * 100

    def model_usd(self, t):
        return self.V.mean(t, "usd")

    def read_load(self, t, nits=False):
        """(comments, words) per PR a reader goes through; QuickReview's [nit]s only when nits=True."""
        r = self.s["reviewers"][t]
        rows, words = r["rows"], r["words"]
        if t == QR and not nits:
            rows -= r["tags"]["rows"]["nit"]
            words -= r["tags"]["words"]["nit"]
        return rows / self.prs, words / self.prs

    def reading_usd(self, t, nits=False, triage_s=None):
        c, w = self.read_load(t, nits)
        triage = self.a["triage_seconds_per_comment"]["value"] if triage_s is None else triage_s
        minutes = w / self.a["reading_words_per_minute"]["value"] + c * triage / 60
        return minutes / 60 * self.a["engineer_usd_per_hour"]["value"]

    def all_in(self, t, **kw):
        return self.model_usd(t) + self.reading_usd(t, **kw)

    def price_per_extra(self, rival, **kw):
        """QuickReview's extra all-in cost per extra serious defect it finds over `rival` ($)."""
        extra_cost = (self.all_in(QR, **kw) - self.all_in(rival, **kw)) * self.prs
        extra_found = self.serious_found(QR) - self.serious_found(rival)
        return extra_cost / extra_found if extra_found > 0 else None

    def rivals(self):
        return [t for t in self.tools if t not in (QR, FAST)]

    def hour(self):
        return self.a["engineer_usd_per_hour"]["value"]

    def release_extra_usd(self):
        """The extra engineer cost of a bug fixed after release rather than in coding (NIST 2002 hours)."""
        f = self.a["fix_hours"]
        return (f["post_release"] - f["coding"]) * self.hour()

    def miss_usd(self):
        """The expected later cost of one missed serious defect, under the escape-share scenario."""
        return self.a["escape_share"]["value"] * self.release_extra_usd()

    def breakeven_share(self, rival):
        """The share of missed serious defects that must reach production for QuickReview to cost less in all."""
        return self.price_per_extra(rival) / self.release_extra_usd()


def money(v):
    if v >= 1e6:
        return f"${v / 1e6:.3g}M"
    if v >= 1e4:
        return f"${v / 1e3:.0f}k"
    return f"${v:,.0f}" if v >= 10 else f"${v:.2f}"


def money_range(lo, hi):
    """'$10–25', '$100k–1M': the dollar sign once."""
    return money(lo) if hi == lo else f"{money(lo)}–{money(hi)[1:]}"


AACR = "AACR-Bench · 185 real PRs · 235 high- and medium-severity defects"
SOURCE_READ = ("Reading cost: words ÷ {wpm} a minute, plus {tri} s to triage each comment, at ${hr} an engineer-hour "
               "(data/value.json). QuickReview's reader skips its [nit]s, which carry none of its serious finds. Model "
               "spend at list prices.")


def field(X):
    """'all on GPT-6.1 Sol except Claude Code (Claude Opus 5.5)': every reviewer here, read from the runs."""
    return X.V.reviewers("aacr", X.tools)


def judged(X):
    """Where the serious-defect counts come from: 'AACR-Bench, one judge (GPT-6 Sol, high reasoning), ...'."""
    return f"AACR-Bench, one judge ({X.V.judge_words('aacr')}), one run per reviewer."


def small(text):
    """The small print, wrapped to the width (make_charts_v5.wrap)."""
    import make_charts_v5 as M
    return M.wrap(text)


def lines_over(src, n):
    """The px a chart gives up to small print longer than `n` lines."""
    return 17 * max(0, src.count("\n") + 1 - n)


def source_read(X, fast=True):
    """v4's reading-cost small print, then the judge and the model each reviewer ran on."""
    return small(SOURCE_READ.format(wpm=X.a["reading_words_per_minute"]["value"],
                                    tri=X.a["triage_seconds_per_comment"]["value"], hr=X.hour())
                 + f" {judged(X)} {X.V.aacr_models(fast=fast)}")


def name_x(p, X, ts, size=13):
    """Where the bars start: v4's 290 px, or further right to fit the longest (model-carrying) name."""
    import make_charts_v5 as M
    return M.name_x(p, [(X.name(t), size, t == QR) for t in ts])


# ---------------------------------------------------------------- 1. what slips through
def fig_value_escapes(B, V, T):
    X = Value(B, V)
    order = sorted(X.tools, key=X.missed_per_100)
    p = Page4(T)
    fewest = order[0] == QR
    p.title("Lets the fewest serious defects through" if fewest else "Serious defects let through")
    p.metric("AACR-Bench · high- and medium-severity defects each reviewer missed, per 100 PRs · fewer is better")
    rows = [{"name": X.name(t), "value": X.missed_per_100(t), "label": f"{X.missed_per_100(t):.0f}",
             "qr": t == QR} for t in order]
    vmax = max(r["value"] for r in rows) * 1.08
    src = small("High severity blocks a merge, medium should be fixed before one (the key's own scale). A partly found "
                f"defect counts ½. {judged(X)} {X.V.aacr_models(fast=True)}")
    x0, x1 = name_x(p, X, order, 13.5), p.w - 120
    pitch = bar_rows(p, rows, x0=x0, x1=x1, top=140, bottom=p.h - 76 - lines_over(src, 2), vmax=vmax)
    if FAST in order:  # the fast option: the accent, lighter
        i = order.index(FAST)
        y = 140 + pitch * (i + 0.5)
        bar(p.c, x0, x0 + (x1 - x0) * X.missed_per_100(FAST) / vmax, y, min(26, pitch * 0.62),
            "#86b6ef" if T["surface"] == "#fcfcfb" else "#5f8fd0", zorder=4)
    p.source(src)
    return p


# ---------------------------------------------------------------- 2. the all-in cost of a review
def fig_value_review_cost(B, V, T):
    X = Value(B, V)
    order = sorted(X.tools, key=lambda t: X.all_in(t))
    p = Page4(T, h=720)
    reading_wins = all(X.reading_usd(t) > X.model_usd(t) for t in X.tools)
    p.title("A review's real cost is reading time, not tokens" if reading_wins else "What a review costs per PR")
    p.metric("All-in cost per PR: model spend plus the time a person spends reading what the reviewer posted")
    src = source_read(X)
    x0, x1, top, bottom = name_x(p, X, order), p.w - 130, 150, p.h - 92 - lines_over(src, 3)
    vmax = max(X.all_in(t, nits=True) for t in X.tools) * 1.08
    pitch = (bottom - top) / len(order)
    h = min(26, pitch * 0.6)
    X_ = lambda v: x0 + (x1 - x0) * v / vmax  # noqa: E731
    light = T["surface"] == "#fcfcfb"
    for i, t in enumerate(order):
        y = top + pitch * (i + 0.5)
        m, r = X.model_usd(t), X.reading_usd(t)
        dark = T["qr"] if t in (QR, FAST) else ("#8f8d86" if light else "#8a8983")
        soft = ("#9cc2ef" if light else "#2f5f99") if t in (QR, FAST) else T["other"]
        bar(p.c, x0, X_(m + r), y, h, soft, zorder=3, r=4)
        bar(p.c, x0, X_(m), y, h, dark, zorder=4, r=0)
        end = X_(m + r)
        if t == QR:  # the reader who also reads every nit
            n = X.all_in(t, nits=True)
            p.c.add_patch(Rectangle((end, y - h / 2), X_(n) - end, h, facecolor="none", edgecolor=soft,
                                    hatch="////", lw=0, zorder=3))
            end = X_(n)
            p.text(end + 10, y, money(m + r), size=13, weight="bold", color=T["ink"])
            p.text(end + 10, y + 17, f"{money(n)} with nits", size=10.5, color=T["muted"])
        else:
            p.text(end + 10, y, money(m + r), size=13, color=T["ink"] if t == FAST else T["ink2"])
        p.text(x0 - 14, y, X.name(t), ha="right", size=13, color=T["ink"] if t in (QR, FAST) else T["ink2"],
               weight="bold" if t == QR else "normal")
    # the legend: the first bar's two parts, named once
    y0 = top - 18
    bar(p.c, x0, x0 + 26, y0, 12, "#8f8d86" if light else "#8a8983", zorder=4, r=0)
    p.text(x0 + 34, y0, "model spend", size=11.5, color=T["ink2"])
    bar(p.c, x0 + 150, x0 + 176, y0, 12, T["other"], zorder=4, r=0)
    p.text(x0 + 184, y0, "reading time", size=11.5, color=T["ink2"])
    p.source(src)
    return p


# ---------------------------------------------------------------- 3. break-even: the price of one more catch
def fig_value_price(B, V, T):
    """QuickReview's extra all-in cost per extra serious catch, against each reviewer: the break-even price of a
    miss. If a missed serious defect would cost you more than this, the extra review pays for itself."""
    X = Value(B, V)
    rows = sorted(((t, X.price_per_extra(t)) for t in X.rivals()), key=lambda kv: kv[1])
    hi = rows[-1][1]
    hour = X.hour()
    p = Page4(T)
    p.title(f"Pays for itself if a missed serious defect costs {money(hi)}")
    p.metric(f"QuickReview on {V.our_model('aacr', QR)}: its extra review cost ÷ the extra serious defects it catches, "
             "per reviewer")
    src = source_read(X, fast=False)
    # v4's p.h - 92, raised so the note under the bars clears the longer small print
    x0, x1, top, bottom = 290, p.w - 140, 160, p.h - 96 - 17 * max(0, src.count("\n") - 1)
    vmax = hour * 1.12
    data = [{"name": f"vs {X.name(t)}", "value": v, "label": money(v), "qr": True} for t, v in rows]
    bar_rows(p, data, x0=x0, x1=x1, top=top, bottom=bottom, vmax=vmax)
    for ref, label in ((hour / 2, "30 min of an engineer"), (hour, "1 engineer-hour")):
        xr = x0 + (x1 - x0) * ref / vmax
        p.c.plot([xr, xr], [top - 8, bottom], color=T["muted"], lw=1.2, ls=(0, (4, 3)), zorder=5)
        p.text(xr, top - 18, f"{label} · {money(ref)}", size=11.5, color=T["muted"], ha="center")
    rel = X.a["fix_hours"]["post_release"] * hour
    p.text(x1 + 6, bottom + 2, f"a bug fixed after release: {money(rel)} →", size=11.5, color=T["ink2"], ha="right",
           va="top", weight="bold")
    p.source(src)
    return p


# ---------------------------------------------------------------- 4. total cost once misses are priced
def fig_value_total(B, V, T):
    """Per 100 PRs: the review (model + reading) plus the serious defects it let through, each priced at the
    reference cost of a miss in data/value.json. Stacked bars, cheapest first."""
    X = Value(B, V)
    miss = X.miss_usd()
    share = X.a["escape_share"]
    tools = [t for t in X.tools if t != FAST]
    total = {t: (X.all_in(t) * 100, X.missed_per_100(t) * miss) for t in tools}
    order = sorted(tools, key=lambda t: sum(total[t]))
    p = Page4(T, h=700)
    p.title(f"Cheapest per 100 PRs if {share['label']} misses reaches production" if order[0] == QR else
            "Total cost per 100 PRs")
    p.metric(f"Per 100 PRs: the review (model + reading) plus the serious defects it missed, at {money(miss)} each "
             "on average")
    f = X.a["fix_hours"]
    need = max(X.breakeven_share(t) for t in X.rivals())
    src = small(f"A scenario, not a measurement: {share['label']} missed serious defects reaches production at "
                f"{f['post_release'] - f['coding']:g} extra engineer-hours (NIST 2002); the rest cost nothing more.\n"
                f"QuickReview costs less than every reviewer here once 1 in {1 / need:.0f} misses reaches production. "
                f"{judged(X)} {X.V.aacr_models()}")
    x0, x1, top, bottom = name_x(p, X, order), p.w - 150, 160, p.h - 92 - lines_over(src, 3)
    vmax = max(sum(v) for v in total.values()) * 1.04
    pitch = (bottom - top) / len(order)
    h = min(26, pitch * 0.6)
    X_ = lambda v: x0 + (x1 - x0) * v / vmax  # noqa: E731
    light = T["surface"] == "#fcfcfb"
    for i, t in enumerate(order):
        y = top + pitch * (i + 0.5)
        review, missed = total[t]
        strong = T["qr"] if t == QR else ("#8f8d86" if light else "#8a8983")
        soft = ("#9cc2ef" if light else "#2f5f99") if t == QR else T["other"]
        bar(p.c, x0, X_(review + missed), y, h, soft, zorder=3, r=4)
        bar(p.c, x0, X_(review), y, h, strong, zorder=4, r=0)
        p.text(X_(review + missed) + 10, y, f"${review + missed:,.0f}", size=13,
               color=T["ink"] if t == QR else T["ink2"], weight="bold" if t == QR else "normal")
        p.text(x0 - 14, y, X.name(t), ha="right", size=13, color=T["ink"] if t == QR else T["ink2"],
               weight="bold" if t == QR else "normal")
    y0 = top - 20
    bar(p.c, x0, x0 + 26, y0, 12, "#8f8d86" if light else "#8a8983", zorder=4, r=0)
    p.text(x0 + 34, y0, "the review", size=11.5, color=T["ink2"])
    bar(p.c, x0 + 130, x0 + 156, y0, 12, T["other"], zorder=4, r=0)
    p.text(x0 + 164, y0, "serious defects missed", size=11.5, color=T["ink2"])
    p.source(src)
    return p


# ---------------------------------------------------------------- 5. the cost ladder
def fig_value_ladder(B, V, T):
    """What each step costs, on one log scale: reading a comment, QuickReview's price per extra serious catch,
    and the published costs of finding a defect later (data/value.json "ladder", each rung sourced)."""
    X = Value(B, V)
    rungs = []
    c, w = X.read_load(QR)  # one QuickReview comment: its words and its triage time
    one = (w / c / X.a["reading_words_per_minute"]["value"] + X.a["triage_seconds_per_comment"]["value"] / 60) \
        / 60 * X.hour()
    rungs.append(("Read one review comment", one, one, True, f"our estimate, for {X.name(QR)}"))
    prices = [X.price_per_extra(t) for t in X.rivals()]
    rungs.append(("Catch one more serious defect", min(prices), max(prices), True,
                  f"{X.name(QR)} vs the six"))
    for r in X.a["ladder"]["rungs"]:
        lo, hi = (r["hours"] * X.hour(),) * 2 if "hours" in r else (r["low"], r["high"])
        rungs.append((r["label"], lo, hi, False, r["short_source"]))
    p = Page4(T, h=640 + 34 * max(0, len(rungs) - 6))
    release = X.a["fix_hours"]["post_release"] * X.hour()
    p.title(X.a["ladder"]["title_fmt"].format(catch=money_range(min(prices), max(prices)), release=money(release)))
    p.metric("What each step costs, in US dollars on a log scale (each gridline ten times the last): review on top")
    import make_charts_v5 as M
    x0 = M.name_x(p, [(r[0], 13, r[3]) for r in rungs] + [(r[4], 10, False) for r in rungs], floor=330, gap=16)
    ours = " Ours: AACR-Bench, see value-price."
    if not X.a["ladder"]["source_line"].endswith(ours):
        sys.exit("value-ladder: data/value.json's ladder source_line no longer ends with the words v5 replaces")
    src = small(X.a["ladder"]["source_line"][:-len(ours)] + f"\nOurs: {judged(X)} {X.V.aacr_models(tuned=False)}")
    x1, top, bottom = p.w - 90, 160, p.h - 112 - lines_over(src, 3)
    lo_e, hi_e = 0, 7  # $1 .. $10M
    Xl = lambda v: x0 + (x1 - x0) * (math.log10(max(v, 1)) - lo_e) / (hi_e - lo_e)  # noqa: E731
    for e in range(lo_e, hi_e + 1):
        xg = Xl(10 ** e)
        p.c.plot([xg, xg], [top - 10, bottom], color=T["grid"], lw=1, zorder=1)
        p.text(xg, bottom + 22, ["$1", "$10", "$100", "$1k", "$10k", "$100k", "$1M", "$10M"][e], size=11,
               color=T["muted"], ha="center")
    pitch = (bottom - top) / len(rungs)
    h = min(24, pitch * 0.55)
    for i, (label, lo, hi, ours, src) in enumerate(rungs):
        y = top + pitch * (i + 0.5)
        col = T["qr"] if ours else T["other"]
        if hi > lo:
            bar(p.c, Xl(lo), Xl(hi), y, h, col, zorder=3, r=h / 2)
        else:
            dot(p, Xl(lo), y, h / 2, col)
        val = money_range(lo, hi)
        p.text(Xl(hi) + 12 + (h / 2 if hi == lo else 0), y, val, size=12.5, color=T["ink"] if ours else T["ink2"],
               weight="bold" if ours else "normal")
        p.text(x0 - 16, y - 7, label, ha="right", size=13, color=T["ink"] if ours else T["ink2"],
               weight="bold" if ours else "normal")
        p.text(x0 - 16, y + 11, src, ha="right", size=10, color=T["muted"])
    p.source(src)
    return p


FIGURES = {
    "value-escapes": fig_value_escapes,
    "value-review-cost": fig_value_review_cost,
    "value-price": fig_value_price,
    "value-total": fig_value_total,
    "value-ladder": fig_value_ladder,
}


def numbers(B, V):
    X = Value(B, V)
    rows = []
    for t in sorted(X.tools, key=X.missed_per_100):
        c, w = X.read_load(t)
        rows.append([X.name(t), f"{X.serious_found(t):g}", f"{X.missed_per_100(t):.1f}", f"${X.model_usd(t):.2f}",
                     f"{c:.1f}", f"{w:.0f}", f"${X.reading_usd(t):.2f}", f"${X.all_in(t):.2f}",
                     "—" if t in (QR, FAST) else f"${X.price_per_extra(t):.0f}"])
    head = ["Reviewer", f"Serious found (of {X.serious_total})", "Missed per 100 PRs", "Model $/PR", "Comments read/PR",
            "Words read/PR", "Reading $/PR", "All-in $/PR", "QuickReview's $ per extra serious catch"]
    import make_charts_v5 as M
    return ("## What a found bug is worth (value-*)\n\n" + source_read(X).replace("\n", " ") + "\n\n" +
            M.md_table(head, rows))


# ---------------------------------------------------------------- the mini report
def report(B, V):
    """out/v5/BUG-VALUE.md: the mini report, every number in it computed here (make_charts_v5.py writes it, and a
    self-contained bug-value.html, beside the charts)."""
    X = Value(B, V)
    riv = sorted(X.rivals(), key=X.missed_per_100)
    miss_lo, miss_hi = X.missed_per_100(riv[0]), X.missed_per_100(riv[-1])
    prices = {t: X.price_per_extra(t) for t in riv}
    nits = {t: X.price_per_extra(t, nits=True) for t in riv}
    share = {t: X.breakeven_share(t) for t in riv}
    worst = max(share, key=share.get)
    f, hr, sc = X.a["fix_hours"], X.hour(), X.a["escape_share"]
    total = {t: X.all_in(t) * 100 + X.missed_per_100(t) * X.miss_usd() for t in [QR] + riv}
    best_other = min(riv, key=total.get)
    high = {t: X.s["reviewers"][t]["credit"]["high"] / X.s["defects"]["high"] for t in [QR] + riv}
    g = B.aacr["reviewers"][QR]["comment_grades"]
    per_pr, minor = sum(g.values()) / X.prs, g.get("correct-minor", 0) / sum(g.values())
    import make_charts_v5 as M  # here: it imports this module
    m_rows, q_rows = V.martian_rows(), V.qodo_rows()
    m_last = M.rank(m_rows, "precision", QR) == len(m_rows)
    q_last = M.rank(q_rows, "precision", QR) == len(q_rows)
    cheapest = min(total, key=total.get) == QR
    slow = [X.price_per_extra(t, triage_s=150) for t in riv]
    c_qr, w_qr = X.read_load(QR)
    slow_s = w_qr / c_qr / X.a["reading_words_per_minute"]["value"] * 60 + 150
    slow_line = (f"At about {slow_s / 60:.0f} minutes a comment, the price of an extra serious catch is "
                 f"{money(min(slow))}–{money(max(slow))}, and review still pays for itself once 1 in "
                 f"{X.release_extra_usd() / max(slow):.0f} of those misses would have reached production.")
    prec_line = ("It is the least precise tool on Martian's and Qodo's own keys." if m_last and q_last else
                 "Its precision is low on Martian's and Qodo's own keys.")
    scen_line = ("Under that scenario QuickReview is the cheapest reviewer per 100 PRs." if cheapest else
                 "Under that scenario QuickReview is not the cheapest reviewer per 100 PRs.")
    short_line = (f"If {sc['label']} does, QuickReview is the cheapest reviewer per 100 PRs: {money(total[QR])} in "
                  f"all against {money(total[best_other])} for the next cheapest." if cheapest else "")
    rows = "\n".join(
        f"| {X.name(t)} | {X.serious_found(t):g} | {X.missed_per_100(t):.0f} | ${X.model_usd(t):.2f} | "
        f"${X.all_in(t):.2f} | {money(prices[t])} ({money(nits[t])}) | 1 in {1 / share[t]:.0f} |" for t in riv)
    fast = V.our_model("aacr", FAST)
    which = (f"QuickReview's numbers are its frozen build ({', '.join(V.builds('aacr'))}) with "
             f"{V.our_model('aacr', QR)} on every model call, at {V.reasoning('aacr', QR)} reasoning by lens; its fast "
             f"option ({', '.join(V.builds('aacr', FAST))}, the same build with a fast profile) runs "
             f"{'the same model' if fast == V.our_model('aacr', QR) else fast} at {V.reasoning('aacr', FAST)} reasoning. "
             f"The other reviewers ran {field(X)}. One judge ({V.judge_words('aacr')}) graded every AACR-Bench number. "
             f"The Martian and Qodo precision figures are our judge's ({V.judge_words('qodo')}); Martian's other "
             f"tools are at its own {V.m['judges'][M.MARTIAN_JUDGE]['label']} judge's scores.")
    return f"""# What a found bug is worth

*A mini report on recall-first code review: what it costs to catch more, and what a miss costs later. Generated by
`make_charts_v5.py` from AACR-Bench's {X.prs} pull requests and the published figures in `data/value.json`; do not
edit by hand. Change an assumption there and every number below moves with it.*

*Which model: {which}*

## In short

- **What slips through is what costs.** On AACR-Bench, QuickReview let **{X.missed_per_100(QR):.0f}
  serious defects per 100 PRs** through. The six other reviewers let {miss_lo:.0f}–{miss_hi:.0f} through.
  "Serious" means high or medium severity: the key's "blocks merge" and "fix before merge".
- **Finding more costs more, mostly in reading time.** A QuickReview review costs **${X.all_in(QR):.2f} per PR**
  all in: ${X.model_usd(QR):.2f} of model spend and the rest the reader's time. The other six cost
  ${min(X.all_in(t) for t in riv):.2f}–{money(max(X.all_in(t) for t in riv))}.
- **Each extra serious catch costs {money(min(prices.values()))}–{money(max(prices.values()))}**, against each of
  the six: QuickReview's extra review cost divided by the extra serious defects it finds. That is at most
  {math.ceil(max(prices.values()) / hr * 60)} minutes of an engineer's time at ${hr} an hour.
- **A bug fixed after release costs about {f['post_release']:g} engineer-hours ({money(f['post_release'] * hr)})**,
  against {f['coding']:g} hours ({money(f['coding'] * hr)}) when it is found while coding. That is the one
  published per-bug figure (NIST, 2002), and it is weak evidence. Outages and breaches cost orders of magnitude
  more.
- **So recall-first review pays for itself if 1 in {1 / share[worst]:.0f} of the serious defects it adds would
  otherwise reach production.** {short_line}

![Serious defects let through per 100 PRs](value-escapes.png)

## Why recall first

A pull request is the last cheap place to stop a defect. Once it merges, finding it takes a failing test, an
incident or a customer.

- **Human review was never mainly a bug filter.**
    - In Microsoft's studies, only 14–15% of review comments concern defects (Bacchelli & Bird 2013; Czerwonka et
      al. 2015).
    - Informal peer review removes about half of the defects it sees (Capers Jones, 2011).
- **More of the code is now written by AI, and delivery is less stable for it.**
    - Each 25% rise in AI adoption went with 7.2% lower delivery stability (DORA 2024). DORA 2025 still finds more
      instability.
    - Adopting an AI coding assistant raised static-analysis warnings by 30% and code complexity by 42% across 806
      repositories (He et al., MSR 2026).
- **The damage sits in a few serious defects.**
    - About 90% of downtime comes from at most 10% of defects (Boehm & Basili 2001).
    - Code changes cause most outages: roughly 70% are due to changes in a live system (Google, *Site Reliability
      Engineering*, 2016).
    - On high-severity defects QuickReview finds {high[QR]:.0%}, against {min(high[t] for t in riv):.0%}–{max(high[t] for t in riv):.0%}
      for the six.

A recall-first reviewer accepts more comments to read in exchange for fewer serious misses. The rest of this report
puts prices on both sides.

## What a missed bug costs: the evidence, and its limits

![The cost ladder](value-ladder.png)

| Figure | What it measures | Source | How solid |
|---|---|---|---|
| {f['coding']:g} h vs {f['post_release']:g} h per bug | fixing a bug found in coding or unit test vs after release | NIST Planning Report 02-3, 2002 | weak: a small 2002 survey; effort only |
| ≈100× for severe defects; ≈2× for non-severe | cost after delivery vs requirements/design | Shull et al., METRICS 2002; Boehm & Basili 2001 | expert workshop; old data |
| no delayed-issue effect before release | fix time in review (median 10 min) vs system test (13 min), 171 projects | Menzies et al., *EMSE* 2017 | peer-reviewed; stops at delivery |
| 54% of significant outages cost over $100k; 1 in 5 over $1M | operators' own estimates | Uptime Institute, Annual Outage Analysis 2025 | survey |
| $4.44M average breach | all causes, few of them code | IBM/Ponemon, Cost of a Data Breach 2025 | vendor-sponsored |
| 14% of the workday on debugging and fixing bugs | 5,971 Microsoft developers | Meyer et al., *IEEE TSE* 2019 | peer-reviewed; self-report |
| ${hr} per hour worked | median pay $135,980 (May 2025), loaded about 1.28× | US BLS (OOH; ECEC) | government statistics |

**What we do not use.**

- The "IBM Systems Sciences Institute 1 : 6.5 : 15 : 100" ratio traces to undated internal course notes (Bossavit,
  *The Leprechauns of Software Engineering*).
- NIST's "30×" table is captioned "example only".
- Gartner's "$5,600 a minute" is a 2014 blog average.

**The honest reading.**

- Before release, a defect costs about the same to fix whenever it is found (Menzies et al.).
- The jump comes when it ships: hours of engineering per bug, and sometimes an outage. One outage at the $100k that
  most significant outages exceed would pay for about {round(100000 / X.all_in(QR), -3):,.0f} QuickReview reviews, reading
  included.

## What a found bug costs: our data

![All-in review cost per PR](value-review-cost.png)

**Model spend is the small part.** The larger part is a person reading what the reviewer posted.

- **How we estimate it:** the words at 200 a minute, plus 30 seconds to look at the line and decide, at ${hr} an hour.
  That charges about 50 seconds for an average QuickReview comment.
- **The one measurement we found is shorter.** Reviewers took a median 16–28 seconds to evaluate an AI review comment
  (Olewicki et al. 2024, a preprint), so the estimate is if anything hard on QuickReview.
- **QuickReview tags every comment as a blocker, a question or a nit, and its reader can skip the nits.** None of its
  serious finds arrives through a nit alone.
    - Read that way, it costs ${X.all_in(QR):.2f} a PR.
    - Read in full, ${X.all_in(QR, nits=True):.2f}.
- **The conclusion survives slow readers.** {slow_line}

## Break-even

![What one more serious catch costs](value-price.png)

| Against | Serious found (of {X.serious_total}) | Missed per 100 PRs | Model $/PR | All-in $/PR | QuickReview's price per extra serious catch (reading its nits too) | Pays off once this share of misses ships |
|---|---|---|---|---|---|---|
| **{X.name(QR)}** | **{X.serious_found(QR):g}** | **{X.missed_per_100(QR):.0f}** | **${X.model_usd(QR):.2f}** | **${X.all_in(QR):.2f}** | — | — |
{rows}

The scenario below assumes {sc['label']} missed serious defects reach production and each costs the extra
{f['post_release'] - f['coding']:g} hours NIST measured. The other nine cost nothing more, and no outage is counted.
{scen_line}

![Total cost per 100 PRs](value-total.png)

## What this does not show

- **These are benchmark defects, not production escapes.**
    - Nobody has measured how many serious defects missed in review would ship. Some would be caught by tests, and some
      would never cause harm.
    - The escape share is a scenario. The break-even share in the table is the figure to argue about.
- **The precision cost is real.**
    - QuickReview posts the most comments ({per_pr:.1f} a PR on AACR-Bench, {minor:.0%} of them true but minor).
    - {prec_line}
    - Developers tolerate false positives only up to a point: 90% accept up to 5%, and only 24% accept 20%
      (Christakis & Bird 2016). Recall-first works only while the extra comments are cheap to skip.
- **The benchmark has limits.**
    - The defect key was built by AI agents and no person has checked it yet.
    - QuickReview was tuned on misses from 121 of these PRs.
    - There is one run per reviewer.
- **What would settle it:** QuickReview's blocks followed into production, and reading time measured on real PRs
  (MISSING-DATA.md §1 and §3).

## Sources

- Bacchelli, A. & Bird, C. "Expectations, Outcomes, and Challenges of Modern Code Review." ICSE 2013.
  https://doi.org/10.1109/ICSE.2013.6606617
- Boehm, B. & Basili, V. "Software Defect Reduction Top 10 List." *IEEE Computer* 34(1), 2001.
  https://doi.org/10.1109/2.962984
- Bossavit, L. *The Leprechauns of Software Engineering.* https://leanpub.com/leprechauns
- Brysbaert, M. "How many words do we read per minute?" *Journal of Memory and Language* 109, 2019.
- Christakis, M. & Bird, C. "What developers want and need from program analysis." ASE 2016.
  https://doi.org/10.1145/2970276.2970347
- Czerwonka, J., Greiler, M. & Tilford, J. "Code Reviews Do Not Find Bugs." ICSE-SEIP 2015.
  https://doi.org/10.1109/ICSE.2015.131
- DORA. *Accelerate State of DevOps Report* 2024; *State of AI-assisted Software Development* 2025.
  https://dora.dev/research/
- Google. *Site Reliability Engineering*, ch. 1, 2016. https://sre.google/sre-book/introduction/
- He, H. et al. Cursor adoption and code quality, MSR 2026. https://arxiv.org/abs/2511.04427
- IBM/Ponemon. *Cost of a Data Breach Report* 2025. https://www.ibm.com/reports/data-breach
- Jones, C. "Software Defect Removal Efficiency," 2011.
- Menzies, T., Nichols, W., Shull, F. & Layman, L. "Are delayed issues harder to resolve?" *EMSE* 22(4), 2017.
  https://arxiv.org/abs/1609.04886
- Meyer, A. et al. "Today was a Good Day." *IEEE TSE*, 2019.
- NIST Planning Report 02-3. *The Economic Impacts of Inadequate Infrastructure for Software Testing*, 2002.
  https://www.nist.gov/system/files/documents/director/planning/report02-3.pdf
- Olewicki, D. et al. (Ubisoft, Mozilla), 2024 preprint. https://arxiv.org/abs/2411.07091
- Shull, F. et al. "What We Have Learned About Fighting Defects." METRICS 2002.
- Uptime Institute. *Annual Outage Analysis* 2025.
- US Bureau of Labor Statistics. Occupational Outlook Handbook: Software Developers; Employer Costs for Employee
  Compensation, 2026.
"""


if __name__ == "__main__":
    import make_charts_v5
    sys.exit(1 if make_charts_v5.render(FIGURES, sys.argv[1:]) else 0)
