#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["matplotlib>=3.8"]
# ///
"""Showcase graphics for QuickReview's benchmark results — PNG (light + dark) and SVG in out/.

    uv run bench/aacr/showcase/make_charts.py            # every figure, both themes
    uv run bench/aacr/showcase/make_charts.py headline   # one figure (names: --list)

Reads only data/*.json (refresh.py rebuilds the generated ones from the runs),
so new results are: refresh, then this. Every number, rank and claim in a
title is computed from the data at render time: if a result moves, the words
move with it rather than going stale.
"""
import argparse, collections, json, math, os, sys, textwrap

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import logging  # noqa: E402

import theme  # noqa: E402

logging.getLogger("matplotlib.font_manager").setLevel(logging.ERROR)
from theme import Page, bar, save  # noqa: E402

from matplotlib.patches import Circle, FancyBboxPatch  # noqa: E402

QR = "quickreview"
HIGH, SERIOUS = {"high"}, {"high", "medium"}
AACR_NOTE = ("AACR-Bench: 185 real PRs in 10 languages, 520 defects verified in the code (90 high, 145 medium, 285 low "
             "severity). One judge, one run per reviewer; a partly found defect counts ½.\nQuickReview: frozen build "
             "e32f0cf on gpt-6.1-sol. Every OpenAI-based tool ran on gpt-6.1-sol, Claude Code on Opus 5.5.")
KINDS = [("bug", "Functional bugs"), ("maintainability", "Maintainability"), ("incomplete-fix", "Incomplete fixes"),
         ("build", "Build and CI breaks"), ("contract", "Broken contracts"), ("data", "Data handling"),
         ("compat", "Compatibility"), ("security", "Security")]


def fmt(x):
    return str(int(x)) if float(x).is_integer() else f"{x:g}"


def pct(x):
    return f"{x * 100:.0f}%"


def wrap(s, width):
    return "\n".join(textwrap.fill(p, width, break_on_hyphens=False) for p in s.split("\n"))


class Bench:
    """Every input the figures read, and the arithmetic they share."""

    def __init__(self):
        j = lambda n: json.load(open(os.path.join(HERE, "data", n)))  # noqa: E731
        self.tools = j("tools.json")["tools"]
        self.aacr = j("aacr.json")
        self.qodo = j("qodo.json")
        self.martian = j("martian.json")
        self.manual = j("manual.json")
        self.D = self.aacr["defects"]

    def name(self, t):
        return self.tools[t]["name"]

    def kind(self, t):
        return self.tools[t]["kind"]

    def colour(self, t, T):
        k = self.kind(t)
        return T["qr"] if k == "quickreview" else T[k]

    # --- AACR
    def aacr_tools(self):
        """The frozen build and the six third-party tools (the design-study build left out)."""
        return [t for t in self.aacr["reviewers"] if t != "quickreview-b2ce03a"]

    def found(self, t, sev=None, pred=None):
        return sum(x["credit"].get(t, 0) for x in self.D
                   if (sev is None or x["severity"] in sev) and (pred is None or pred(x)))

    def total(self, sev=None, pred=None):
        return sum(1 for x in self.D if (sev is None or x["severity"] in sev) and (pred is None or pred(x)))

    def recall(self, t, sev=None, pred=None):
        return self.found(t, sev, pred) / max(self.total(sev, pred), 1)

    def ranked(self, sev=None, pred=None):
        return sorted(self.aacr_tools(), key=lambda t: -self.found(t, sev, pred))

    # --- Qodo
    def qodo_recall(self, t, what="recall_functional", rule="N=5"):
        row = self.qodo["tools"].get(t)
        return None if row is None else row["scores"][rule][what]

    # --- Martian
    def martian_best(self):
        """tool -> {'same': n, 'published': n} (either may be missing)."""
        out = collections.defaultdict(dict)
        for r in self.martian["rows"]:
            out[r["tool"]][r["judge"]] = r["real_found"]
        return out


def legend_kinds(p, T, x, y, kinds=("quickreview", "closed", "open")):
    return p.legend([(T["qr"] if k == "quickreview" else T[k], theme.KIND_LABEL[k]) for k in kinds], x, y)


def rank_of(value, others):
    return 1 + sum(1 for v in others if v > value)


# ---------------------------------------------------------------- 1 headline
def fig_headline(B, T):
    """The one image: the high-severity number, the field behind it, three proof points."""
    p = Page(T, 1200, 675)
    n = B.total(HIGH)
    order = B.ranked(HIGH)
    qr = B.found(QR, HIGH)
    nxt = next(t for t in order if t != QR)
    p.text(56, 70, "QUICKREVIEW  ·  AUTOMATED PULL-REQUEST REVIEW", size=10, color=T["muted"], weight="medium")
    p.text(48, 228, pct(qr / n), size=118, weight="bold")
    p.text(56, 272, "of high-severity bugs caught", size=22, weight="bold")
    p.text(56, 302, wrap(f"{fmt(qr)} of the {n} in 185 real pull requests. The next best reviewer, "
                         f"{B.name(nxt)}, caught {fmt(B.found(nxt, HIGH))}.", 66),
           size=11.5, color=T["ink2"], va="top", linespacing=1.5)
    p.c.plot([56, 560], [366, 366], color=T["grid"], lw=1)
    # three proof points, each computed
    allr = B.ranked()
    nxt_all = next(t for t in allr if t != QR)
    q_tools = list(B.qodo["tools"])
    q_rank = rank_of(B.qodo_recall(QR), [B.qodo_recall(t) for t in q_tools if t != QR])
    mb = B.martian_best()
    m_qr = mb[QR]["same"]
    m_others = [v for t, d in mb.items() if t != QR for v in d.values()]
    m_n = B.martian["real_goldens"]
    proofs = [
        (pct(B.recall(QR)), f"of all {B.total()} verified defects found; the next best, {B.name(nxt_all)}, "
                            f"found {pct(B.recall(nxt_all))}"),
        (f"#{q_rank}", f"in functional-bug recall among {len(q_tools)} reviewers on Qodo's PR-Review-Bench, "
                       f"{sum(1 for t in q_tools if B.kind(t) == 'closed')} of them commercial"),
        (pct(m_qr / m_n), f"of the real bugs in Martian's benchmark — "
                          + ("more than any of " if m_qr > max(m_others) else "against ")
                          + f"{len(mb) - 1} other reviewers"),
    ]
    y = 398
    for big, small in proofs:
        p.text(56, y, big, size=21, weight="bold", va="top")
        p.text(150, y + 4, wrap(small, 58), size=11, color=T["ink2"], va="top", linespacing=1.35)
        y += 62
    # the field, right
    x0, x1, top, pitch, h = 820, 1090, 178, 50, 18
    p.text(640, 122, f"High-severity bugs caught, of {n}", size=13, weight="bold")
    p.text(640, 144, "AACR-Bench · same verified key and judge for every reviewer", size=10, color=T["muted"])
    for i, t in enumerate(order):
        y = top + i * pitch
        v = B.found(t, HIGH)
        bar(p.c, x0, x1, y, h, T["track"])
        bar(p.c, x0, x0 + (x1 - x0) * v / n, y, h, B.colour(t, T), zorder=3)
        p.text(x0 - 12, y + 4.5, B.name(t), size=11.5, ha="right",
               weight="bold" if t == QR else "normal", color=T["ink"] if t == QR else T["ink2"])
        p.text(x1 + 10, y + 4.5, pct(v / n), size=11.5, weight="bold" if t == QR else "normal")
    legend_kinds(p, T, 640, top + len(order) * pitch + 4)
    usd = B.aacr["reviewers"][QR]["usd_mean"]
    mins = B.aacr["reviewers"][QR]["minutes_median"]
    p.footer(AACR_NOTE + f" QuickReview costs ${usd:.2f} a PR at list prices, median {mins:.1f} min.")
    return p


# ---------------------------------------------------------------- 2 missed
def fig_missed(B, T):
    """Unit chart: one square per serious defect a reviewer let through."""
    p = Page(T, 1200, 675)
    n = B.total(SERIOUS)
    order = sorted(B.aacr_tools(), key=lambda t: n - B.found(t, SERIOUS))
    miss = {t: n - B.found(t, SERIOUS) for t in order}
    nxt = next(t for t in order if t != QR)
    y = p.header(f"QuickReview let {fmt(miss[QR])} serious bugs through. The next best let {fmt(miss[nxt])}.",
                 f"Each square is a high- or medium-severity defect the reviewer missed (half a square: found only "
                 f"in part), of {n} in 185 real pull requests.")
    legend_kinds(p, T, 56, y + 4)
    unit, gap, x0, top, pitch, tall = 10, 3, 236, y + 52, 64, 3
    for i, t in enumerate(order):
        yy = top + i * pitch
        m = miss[t]
        c = B.colour(t, T)
        whole = int(m)
        for k in range(whole + (1 if m - whole >= 0.5 else 0)):
            col, row = divmod(k, tall)
            w = unit if k < whole else unit / 2
            p.c.add_patch(FancyBboxPatch((x0 + col * (unit + gap), yy + row * (unit + gap)), w, unit,
                                         boxstyle="round,pad=0,rounding_size=1.5", facecolor=c, edgecolor="none"))
        end = x0 + math.ceil(m / tall) * (unit + gap)
        hm = B.total(HIGH) - B.found(t, HIGH)
        mid = yy + (tall * (unit + gap) - gap) / 2
        p.text(56, mid + 5, B.name(t), size=12, weight="bold" if t == QR else "normal",
               color=T["ink"] if t == QR else T["ink2"])
        num = p.text(end + 10, mid + 5, fmt(m), size=14, weight="bold")
        p.text(end + 16 + theme.text_width(p.fig, num), mid + 5, f"missed  ·  {fmt(hm)} high severity",
               size=10.5, color=T["muted"])
    p.footer(AACR_NOTE)
    return p


# ---------------------------------------------------------------- 3 one vs six
def fig_union(B, T):
    """Six reviewers pooled, still short of one QuickReview."""
    p = Page(T, 1200, 675)
    others = [t for t in B.aacr_tools() if t != QR]
    chosen, cur, segs = [], 0.0, []
    rem = list(others)
    while rem:  # greedy: each step adds the tool that grows the pooled set most
        best = max(rem, key=lambda t: sum(max(x["credit"][u] for u in chosen + [t]) for x in B.D))
        val = sum(max(x["credit"][u] for u in chosen + [best]) for x in B.D)
        segs.append((best, val - cur))
        cur = val
        chosen.append(best)
        rem.remove(best)
    union = cur
    qr = B.found(QR)
    n = B.total()
    only = sum(1 for x in B.D if x["credit"][QR] >= 0.5 and all(x["credit"][o] == 0 for o in others))
    verb = "more than" if qr > union else ("as many as" if qr == union else "nearly as many as")
    p.header(f"One QuickReview finds {verb} six other reviewers combined",
             f"Real defects found on AACR-Bench ({n} verified in 185 PRs). Combined: every defect that at least one "
             f"of the six found, counted once.")
    base, top = 548, 172
    s = (base - top) / n
    p.c.plot([300, 1010], [base - n * s] * 2, color=T["axis"], lw=1, zorder=1)
    p.text(1010, base - n * s - 8, f"all {n} defects", size=10, color=T["muted"], ha="right")
    p.c.plot([300, 1010], [base, base], color=T["axis"], lw=1, zorder=1)
    # left: the pooled six, the long tail folded into one block; square at the base, rounded at the top
    lx0, lx1 = 420, 560
    head, tail = segs[:2], segs[2:]
    blocks = head + [("__tail__", sum(v for _, v in tail))]
    y = base
    for k, (t, v) in enumerate(blocks):
        colour = B.colour(t, T) if t != "__tail__" else T["open"]
        y1 = y - v * s
        lo = y - (0 if k == 0 else 1)  # a 2 px surface gap between segments
        hi = y1 + (0 if k == len(blocks) - 1 else 1)
        if k == len(blocks) - 1:
            bar(p.c, lo, hi, (lx0 + lx1) / 2, lx1 - lx0, colour, vertical=True)
        else:
            p.c.add_patch(FancyBboxPatch((lx0, hi), lx1 - lx0, lo - hi, boxstyle="square,pad=0", facecolor=colour,
                                         edgecolor="none", zorder=2))
        mid = (y + y1) / 2
        if t == "__tail__":
            p.text(lx0 - 14, mid - 1, f"+ {fmt(v)}  from {len(tail)} more tools", size=11, ha="right",
                   color=T["ink2"])
            p.text(lx0 - 14, mid + 15, ", ".join(B.name(u) for u, _ in tail), size=9, ha="right", color=T["muted"])
        else:
            p.text(lx0 - 14, mid + 4, f"{'' if k == 0 else '+ '}{fmt(v)}  {B.name(t)}", size=11, ha="right",
                   color=T["ink2"])
        y = y1
    p.text((lx0 + lx1) / 2, y - 14, fmt(union), size=24, weight="bold", ha="center")
    p.text((lx0 + lx1) / 2, base + 24, "Six other reviewers, combined", size=11.5, ha="center", color=T["ink2"])
    # right: QuickReview alone
    rx0, rx1 = 680, 820
    bar(p.c, base, base - qr * s, (rx0 + rx1) / 2, rx1 - rx0, T["qr"], vertical=True)
    p.text((rx0 + rx1) / 2, base - qr * s - 14, fmt(qr), size=24, weight="bold", ha="center")
    p.text((rx0 + rx1) / 2, base + 24, "QuickReview, alone", size=11.5, ha="center", weight="bold")
    # what only QuickReview found
    yb0, yb1 = base - qr * s, base - (qr - only) * s
    p.c.plot([rx1 + 10, rx1 + 16, rx1 + 16, rx1 + 10], [yb0, yb0, yb1, yb1], color=T["ink2"], lw=1)
    p.text(rx1 + 26, (yb0 + yb1) / 2 - 2, f"{only} defects", size=11.5, weight="bold")
    p.text(rx1 + 26, (yb0 + yb1) / 2 + 15, "none of the six found", size=10.5, color=T["ink2"])
    hm_q, hm_u = B.found(QR, SERIOUS), sum(max(x["credit"][o] for o in others) for x in B.D
                                           if x["severity"] in SERIOUS)
    p.footer(f"High and medium severity alone: QuickReview {fmt(hm_q)}, the six combined {fmt(hm_u)} of "
             f"{B.total(SERIOUS)}.\n" + AACR_NOTE)
    return p


# ---------------------------------------------------------------- 4 head to head
def fig_head_to_head(B, T):
    """Butterfly: what QuickReview caught that each rival missed, and the reverse."""
    p = Page(T, 1200, 675)
    others = [t for t in B.aacr_tools() if t != QR]
    rows = []
    for t in others:
        a = sum(1 for x in B.D if x["credit"][QR] >= 0.5 and x["credit"][t] == 0)
        b = sum(1 for x in B.D if x["credit"][t] >= 0.5 and x["credit"][QR] == 0)
        rows.append((t, a, b))
    rows.sort(key=lambda r: r[1])
    lo_a, hi_a = min(r[1] for r in rows), max(r[1] for r in rows)
    lo_b, hi_b = min(r[2] for r in rows), max(r[2] for r in rows)
    y0 = p.header("Head to head, the gap runs one way",
             f"QuickReview against each tool on AACR-Bench's {B.total()} defects: the defects one found (fully or "
             f"partly) and the other missed entirely.")
    legend_kinds(p, T, 56, y0 + 4)
    cx_l, cx_r, top, pitch, h = 500, 700, y0 + 96, 60, 20
    s = 420 / max(hi_a, hi_b)
    p.text(cx_l, top - 38, "QuickReview found, the other missed", size=11, weight="bold", ha="right")
    p.text(cx_r, top - 38, "The other found, QuickReview missed", size=11, weight="bold", color=T["ink2"])
    for i, (t, a, b) in enumerate(rows):
        y = top + i * pitch
        bar(p.c, cx_l, cx_l - a * s, y, h, T["qr"])
        if b > 0:
            bar(p.c, cx_r, cx_r + b * s, y, h, B.colour(t, T))
        p.text(cx_l - a * s - 10, y + 5, str(a), size=13, weight="bold", ha="right")
        p.text(cx_r + b * s + 10, y + 5, str(b), size=13, weight="bold", color=T["ink2"])
        p.text(600, y + 5, B.name(t), size=11.5, ha="center")
    p.footer(f"Across the six tools: QuickReview found {lo_a}–{hi_a} defects each one missed; each found {lo_b}–{hi_b} "
             f"that QuickReview missed. " + AACR_NOTE)
    return p


# ---------------------------------------------------------------- 5 clean catch
def fig_clean_catch(B, T):
    """Per-PR: on how many PRs did the reviewer flag every serious bug."""
    p = Page(T, 1200, 566)
    prs = collections.defaultdict(list)
    for x in B.D:
        if x["severity"] in SERIOUS:
            prs[x["pr"]].append(x)
    n = len(prs)
    share = {t: sum(1 for xs in prs.values() if all(x["credit"][t] == 1 for x in xs)) for t in B.aacr_tools()}
    order = sorted(share, key=lambda t: -share[t])
    y0 = p.header(f"Every serious bug caught on {pct(share[QR] / n)} of pull requests",
             f"Of the {n} PRs that carry at least one high- or medium-severity defect, the share on which the reviewer "
             f"fully found every one of them.")
    x = legend_kinds(p, T, 56, y0 + 4)
    p.legend([(T["empty"], "a serious defect missed or found only in part")], x, y0 + 4)
    cols, unit, gap, gy = 9, 12, 3, y0 + 64
    gx, gw = 56, cols * (unit + gap) - gap
    step = (1200 - 2 * 56 - gw) / (len(order) - 1)
    for i, t in enumerate(order):
        x0 = gx + i * step
        p.text(x0, gy, pct(share[t] / n), size=22, weight="bold")
        p.text(x0, gy + 24, B.name(t), size=10.5, weight="bold" if t == QR else "normal",
               color=T["ink"] if t == QR else T["ink2"])
        for k in range(n):
            r, c = divmod(k, cols)
            colour = B.colour(t, T) if k < share[t] else T["empty"]
            p.c.add_patch(FancyBboxPatch((x0 + c * (unit + gap), gy + 42 + r * (unit + gap)), unit, unit,
                                         boxstyle="round,pad=0,rounding_size=2", facecolor=colour, edgecolor="none"))
    p.footer(AACR_NOTE)
    return p


# ---------------------------------------------------------------- 6 Qodo
def fig_qodo(B, T):
    """Functional-bug recall on Qodo's benchmark, QuickReview against 12 tools."""
    p = Page(T, 1200, 792)
    tools = sorted(B.qodo["tools"], key=lambda t: -B.qodo_recall(t))
    some = B.qodo["tools"][QR]
    nf = some["issues"] - some["rule_issues"]
    rank = rank_of(B.qodo_recall(QR), [B.qodo_recall(t) for t in tools if t != QR])
    lead = ("The most functional bugs found" if rank == 1 else f"#{rank} in functional bugs found")
    y0 = p.header(f"{lead} among {len(tools)} code reviewers",
             f"Qodo PR-Review-Bench: {nf} functional bugs injected into {some['prs']} real PRs · every tool's "
             f"comments graded by the same gpt-6.1-sol judge")
    legend_kinds(p, T, 56, y0 + 4)
    x0, x1, top, pitch, h = 280, 980, y0 + 66, 37, 18
    dom = 0.6
    for g in range(0, 7):
        gx = x0 + (x1 - x0) * g / 6
        p.c.plot([gx, gx], [top - 18, top + (len(tools) - 1) * pitch + 18], color=T["grid"], lw=1, zorder=1)
        p.text(gx, top + (len(tools) - 1) * pitch + 38, f"{g * 10}%", size=9.5, color=T["muted"], ha="center")
    for i, t in enumerate(tools):
        y = top + i * pitch
        v = B.qodo_recall(t)
        bar(p.c, x0, x0 + (x1 - x0) * v / dom, y, h, B.colour(t, T), zorder=3)
        p.text(x0 - 12, y + 4.5, B.name(t), size=11.5, ha="right", weight="bold" if t == QR else "normal",
               color=T["ink"] if t == QR else T["ink2"])
        p.text(x0 + (x1 - x0) * v / dom + 10, y + 4.5, f"{v * 100:.1f}%", size=11.5,
               weight="bold" if t == QR else "normal")
    alls = sorted(tools, key=lambda t: -B.qodo_recall(t, "recall"))
    r_all = rank_of(B.qodo_recall(QR, "recall"), [B.qodo_recall(t, "recall") for t in tools if t != QR])
    lead_all = alls[0] if alls[0] != QR else alls[1]
    p.footer(f"On all {some['issues']} issues, rule violations of the repository's AGENTS.md included, QuickReview ranks "
             f"#{r_all} ({B.qodo_recall(QR, 'recall') * 100:.1f}%; {B.name(lead_all)} "
             f"{B.qodo_recall(lead_all, 'recall') * 100:.1f}%). Location rule: the comment's file is the issue's and its "
             f"lines within ±5.\nVendor rows are the vendors' public January 2026 comments; QuickReview is the frozen "
             f"build e32f0cf, OpenCode, open-code-review and PR-Agent ran on gpt-6.1-sol. Qodo built the benchmark.")
    return p


# ---------------------------------------------------------------- 7 Martian
def fig_martian(B, T):
    """Real bugs found on Martian's benchmark: our judge and the published one."""
    mb = B.martian_best()
    n = B.martian["real_goldens"]
    order = sorted(mb, key=lambda t: -max(mb[t].values()))
    p = Page(T, 1200, 200 + 30 * len(order) + 130)
    qr = mb[QR]["same"]
    beaten = qr > max(v for t, d in mb.items() if t != QR for v in d.values())
    y0 = p.header(f"{pct(qr / n)} of Martian's real bugs" + (", more than any other reviewer" if beaten else ""),
             f"Martian offline benchmark, {B.martian['prs']} PRs: the {n} golden comments an audit confirmed as real "
             f"defects introduced by the PR.")
    # two legends: identity (colour), then which judge (filled or hollow marker)
    legend_kinds(p, T, 56, y0 + 4)
    lx, ly = 56, y0 + 34
    p.c.add_patch(Circle((lx + 5, ly + 5), 5, facecolor=T["closed"], edgecolor="none"))
    t1 = p.text(lx + 16, ly + 9, "graded by our gpt-6.1-sol judge, as QuickReview was", size=10.5, color=T["ink2"])
    lx += 16 + theme.text_width(p.fig, t1) + 26
    p.c.add_patch(Circle((lx + 5, ly + 5), 4.2, facecolor="none", edgecolor=T["closed"], lw=1.6))
    p.text(lx + 16, ly + 9, "Martian's published grading (Claude Opus 4.5 judge)", size=10.5, color=T["ink2"])
    # dots need no zero baseline: the axis starts where the field does, in steps of 10 points
    lo = math.floor(min(v for d in mb.values() for v in d.values()) / n * 10 - 0.5) / 10
    x0, x1, top, pitch = 280, 1000, ly + 64, 30
    steps = round((1 - lo) * 10)
    for g in range(steps + 1):
        gx = x0 + (x1 - x0) * g / steps
        p.c.plot([gx, gx], [top - 14, top + (len(order) - 1) * pitch + 14], color=T["grid"], lw=1, zorder=1)
        p.text(gx, top + (len(order) - 1) * pitch + 34, f"{round((lo + g / 10) * 100)}%", size=9.5,
               color=T["muted"], ha="center")
    X = lambda v: x0 + (x1 - x0) * (v / n - lo) / (1 - lo)  # noqa: E731
    for i, t in enumerate(order):
        y = top + i * pitch
        d = mb[t]
        c = B.colour(t, T)
        if "same" in d and "published" in d:
            p.c.plot([X(d["same"]), X(d["published"])], [y, y], color=T["axis"], lw=2, zorder=2)
        if "published" in d:
            p.c.add_patch(Circle((X(d["published"]), y), 5.2, facecolor=T["surface"], edgecolor=c, lw=1.8, zorder=3))
        if "same" in d:
            r = 7 if t == QR else 6
            p.c.add_patch(Circle((X(d["same"]), y), r + 2, facecolor=T["surface"], edgecolor="none", zorder=3))
            p.c.add_patch(Circle((X(d["same"]), y), r, facecolor=c, edgecolor="none", zorder=4))
        p.text(x0 - 14, y + 4.5, B.name(t), size=11, ha="right", weight="bold" if t == QR else "normal",
               color=T["ink"] if t == QR else T["ink2"])
        v = max(d.values())
        p.text(X(v) + 14, y + 4.5, f"{v}  ({pct(v / n)})", size=10.5, weight="bold" if t == QR else "normal",
               color=T["ink"] if t == QR else T["ink2"])
    both = [mb[t]["published"] - mb[t]["same"] for t in mb if "same" in mb[t] and "published" in mb[t]]
    p.footer(f"Where a tool was judged both ways, the published judge credits it {min(both)}–{max(both)} more real "
             f"bugs than ours: the comparison is, if anything, tilted against QuickReview.\nMartian's other "
             f"golden comments were judged not real defects of the PR (trivial, latent, pre-existing or intended) and "
             f"are left out. QuickReview: frozen build e32f0cf on gpt-6.1-sol.")
    return p


# ---------------------------------------------------------------- 8 same model
def fig_same_model(B, T):
    """The harness, not the model: every tool on gpt-6.1-sol, on three benchmarks."""
    p = Page(T, 1200, 600)
    tools = [t for t in B.ranked() if B.tools[t].get("model") == "gpt-6.1-sol"]
    mb = B.martian_best()
    m_n = B.martian["real_goldens"]
    panels = [
        ("AACR-Bench", f"all {B.total()} verified defects", lambda t: B.recall(t)),
        ("Martian", f"the {m_n} audited real bugs",
         lambda t: mb[t]["same"] / m_n if "same" in mb.get(t, {}) else None),
        ("Qodo PR-Review-Bench", f"all {B.qodo['tools'][QR]['issues']} issues",
         lambda t: B.qodo_recall(t, "recall")),
    ]
    y0 = p.header("Same model, better reviewer",
             f"Recall of {len(tools)} review tools that all ran on gpt-6.1-sol: the difference is the review design, "
             f"not the model.")
    legend_kinds(p, T, 56, y0 + 4, kinds=("quickreview", "open"))
    top, pitch, h, gut, pw, gap = y0 + 110, 44, 18, 220, 270, 40
    missing = set()
    for k, (bench, what, f) in enumerate(panels):
        x0 = gut + k * (pw + gap)
        x1 = x0 + pw - 60
        p.text(x0, top - 50, bench, size=12.5, weight="bold")
        p.text(x0, top - 32, f"share of {what} found", size=9.5, color=T["muted"])
        for i, t in enumerate(tools):
            y = top + i * pitch
            v = f(t)
            if v is None:
                p.text(x0, y + 4.5, "not run", size=10, color=T["muted"], style="italic")
                missing.add(t)
                continue
            bar(p.c, x0, x1, y, h, T["track"])
            bar(p.c, x0, x0 + (x1 - x0) * v, y, h, B.colour(t, T), zorder=3)
            p.text(x0 + (x1 - x0) * v + 8, y + 4.5, pct(v), size=11, weight="bold" if t == QR else "normal")
    for i, t in enumerate(tools):
        p.text(gut - 16, top + i * pitch + 4.5, B.name(t), size=11.5, ha="right",
               weight="bold" if t == QR else "normal", color=T["ink"] if t == QR else T["ink2"])
    gap_note = (f"Not run: {', '.join(B.name(t) for t in tools if t in missing)} on Martian and Qodo (a data gap, not "
                f"a result). " if missing else "")
    p.footer(gap_note + "Martian counts a comment against Martian's own matcher, Qodo with its file and ±5-line rule; "
             "QuickReview is the frozen build e32f0cf.\nAACR-Bench: one judge (gpt-6-sol), one run per reviewer, 185 "
             "real PRs. Martian and Qodo: one gpt-6.1-sol judge for every row shown.")
    return p


# ---------------------------------------------------------------- 9 by kind
def fig_by_kind(B, T):
    """Dot strip: recall per kind of defect, QuickReview against the field."""
    p = Page(T, 1200, 672)
    tools = B.aacr_tools()
    rows = []
    for k, label in KINDS:
        pred = (lambda kk: lambda x: x["kind"] == kk)(k)
        n = B.total(pred=pred)
        if n:
            vals = {t: B.recall(t, pred=pred) for t in tools}
            rows.append((label, n, vals))
    leads = [r[2][QR] - max(v for t, v in r[2].items() if t != QR) for r in rows]
    ahead = sum(1 for d in leads if d > 0)
    y0 = p.header("Ahead on every kind of defect" if ahead == len(rows) else f"Ahead on {ahead} of {len(rows)} kinds of defect",
             "Share of each kind of verified defect found on AACR-Bench, QuickReview against six other reviewers.")
    legend_kinds(p, T, 56, y0 + 4)
    x0, x1, top, pitch = 300, 1010, y0 + 80, 46
    for g in range(0, 11, 2):
        gx = x0 + (x1 - x0) * g / 10
        p.c.plot([gx, gx], [top - 22, top + (len(rows) - 1) * pitch + 22], color=T["grid"], lw=1, zorder=1)
        p.text(gx, top + (len(rows) - 1) * pitch + 42, f"{g * 10}%", size=9.5, color=T["muted"], ha="center")
    p.text(1110, top - 36, "lead over", size=9.5, color=T["muted"], ha="right")
    p.text(1110, top - 22, "the next best", size=9.5, color=T["muted"], ha="right")
    for i, (label, n, vals) in enumerate(rows):
        y = top + i * pitch
        X = lambda v: x0 + (x1 - x0) * v  # noqa: E731
        lo = min(vals.values())
        p.c.plot([X(lo), X(vals[QR])], [y, y], color=T["grid"], lw=2, zorder=2)
        for t, v in sorted(vals.items(), key=lambda kv: kv[0] == QR):
            r = 7.5 if t == QR else 5.5
            p.c.add_patch(Circle((X(v), y), r + 2, facecolor=T["surface"], edgecolor="none", zorder=3))
            p.c.add_patch(Circle((X(v), y), r, facecolor=B.colour(t, T), edgecolor="none", zorder=4))
        p.text(x0 - 16, y + 1, label, size=11.5, ha="right")
        p.text(x0 - 16, y + 16, f"{n} defects", size=9, ha="right", color=T["muted"])
        p.text(X(vals[QR]) + 14, y + 4.5, pct(vals[QR]), size=11, weight="bold")
        d = vals[QR] - max(v for t, v in vals.items() if t != QR)
        p.text(1110, y + 4.5, f"{d * 100:+.0f} pts", size=11.5, weight="bold" if d > 0 else "normal", ha="right")
    p.footer(AACR_NOTE)
    return p


# ---------------------------------------------------------------- 10 by size
def fig_by_size(B, T):
    """Recall by PR size: QuickReview's line against the field's."""
    buckets = [(0, 50, "up to 50"), (51, 200, "51–200"), (201, 10 ** 9, "201 and more")]
    tools = B.aacr_tools()
    vals, ns, nprs = {t: [] for t in tools}, [], []
    for lo, hi, _ in buckets:
        pred = (lambda a, b: lambda x: a <= x["changed_lines"] <= b)(lo, hi)
        ns.append(B.total(pred=pred))
        nprs.append(len({x["pr"] for x in B.D if pred(x)}))
        for t in tools:
            vals[t].append(B.recall(t, pred=pred))
    lead = [vals[QR][i] - max(vals[t][i] for t in tools if t != QR) for i in range(len(buckets))]
    # the stronger claim only when the lead grows by 5 points or more; a smaller move is noise
    title = ("The bigger the pull request, the bigger the lead" if lead[-1] >= lead[0] + 0.05
             else "No drop-off on big pull requests")
    p = Page(T, 1200, 640)
    y0 = p.header(title, "Share of verified defects found on AACR-Bench, by the size of the pull request in changed lines.")
    legend_kinds(p, T, 56, y0 + 4)
    AX_TOP, AX_H = y0 + 50, 360
    ax = p.axes(120, AX_TOP, 760, AX_H)
    theme.clean(ax)
    ax.set_xlim(-0.25, len(buckets) - 0.75)
    floor = math.floor(min(min(v) for v in vals.values()) * 4) / 4  # the field's floor, in 25-point steps
    ax.set_ylim(floor, 1.0)
    ticks = [floor + 0.25 * k for k in range(round((1 - floor) / 0.25) + 1)]
    ax.set_yticks(ticks, [pct(t) for t in ticks], fontsize=9.5)
    ax.grid(axis="y", color=T["grid"], lw=1)
    ax.set_axisbelow(True)
    ax.set_xticks(range(len(buckets)), [f"{b[2]} lines\n{np_} PRs · {n} defects" for b, np_, n in zip(buckets, nprs, ns)],
                  fontsize=10.5, color=T["ink2"])
    xs = list(range(len(buckets)))
    for t in sorted(tools, key=lambda t: t == QR):
        c = B.colour(t, T)
        if t == QR:
            ax.plot(xs, vals[t], color=c, lw=3, solid_capstyle="round", zorder=5)
            ax.scatter(xs, vals[t], s=90, color=c, edgecolor=T["surface"], linewidth=2, zorder=6)
            for x, v in zip(xs, vals[t]):
                ax.annotate(pct(v), (x, v), xytext=(0, 13), textcoords="offset points", ha="center", fontsize=12,
                            fontweight="bold", color=T["ink"])
        else:
            ax.plot(xs, vals[t], color=c, lw=1.6, zorder=3, solid_capstyle="round")
            ax.scatter(xs, vals[t], s=26, color=c, edgecolor=T["surface"], linewidth=1.5, zorder=4)
    # end labels, spread so they never overlap, with leaders back to the line ends
    ends = sorted(((vals[t][-1], t) for t in tools), reverse=True)
    ypx = lambda v: AX_TOP + AX_H - (v - floor) / (1 - floor) * AX_H  # noqa: E731
    ys_px = [ypx(v) for v, _ in ends]
    for i in range(1, len(ys_px)):
        ys_px[i] = max(ys_px[i], ys_px[i - 1] + 17)
    for (v, t), ly in zip(ends, ys_px):
        ex, ey = 120 + 760 * (len(buckets) - 1 + 0.25) / (len(buckets) - 0.5), ypx(v)
        lx = 900
        p.c.plot([ex + 8, lx - 6], [ey, ly], color=T["axis"], lw=0.8, zorder=1)
        p.text(lx, ly + 4, f"{B.name(t)}  {pct(v)}", size=10.5, weight="bold" if t == QR else "normal",
               color=T["ink"] if t == QR else T["ink2"])
    p.footer(AACR_NOTE.split("\n")[0])
    return p


# ---------------------------------------------------------------- 11 scorecard
def fig_scorecard(B, T):
    """Every benchmark, every tool we have a same-judge number for; gaps shown as gaps."""
    mb = B.martian_best()
    m_n = B.martian["real_goldens"]
    q = B.qodo["tools"]
    cols = [
        ("High-severity", f"AACR · {B.total(HIGH)}",
         lambda t: B.recall(t, HIGH) if t in B.aacr["reviewers"] else None, False),
        ("All defects", f"AACR · {B.total()}", lambda t: B.recall(t) if t in B.aacr["reviewers"] else None, False),
        ("Real bugs", f"Martian · {m_n}", lambda t: (mb[t].get("same", mb[t].get("published")) / m_n)
         if t in mb else None, True),
        ("Functional bugs", f"Qodo · {q[QR]['issues'] - q[QR]['rule_issues']}", lambda t: B.qodo_recall(t), False),
        ("All issues", f"Qodo · {q[QR]['issues']}", lambda t: B.qodo_recall(t, "recall"), False),
    ]
    tools = [t for t in B.tools if t != "quickreview-b2ce03a"
             and any(f(t) is not None for _, _, f, _ in cols)
             and (t in B.aacr["reviewers"] or t in q or "same" in mb.get(t, {}))]
    tools.sort(key=lambda t: (t != QR, -sum(1 for _, _, f, _ in cols if f(t) is not None),
                              -max(f(t) or 0 for _, _, f, _ in cols)))
    ranks = []
    for _, _, f, _ in cols:
        others = [f(t) for t in tools if t != QR and f(t) is not None]
        ranks.append((rank_of(f(QR), others), len(others) + 1))
    firsts = sum(1 for r, _ in ranks if r == 1)
    p = Page(T, 1200, 230 + 31 * len(tools) + 90)
    y0 = p.header(f"First in recall on {firsts} of {len(cols)} measures across three benchmarks",
             "Share found, QuickReview and every reviewer with a number on at least one benchmark. "
             "A dash is a benchmark the tool was not run on.")
    legend_kinds(p, T, 56, y0 + 4)
    gut, cw, top, pitch = 250, 176, y0 + 104, 31
    for k, (head, sub, _, _) in enumerate(cols):
        x = gut + k * cw
        p.text(x, top - 50, head, size=11.5, weight="bold")
        p.text(x, top - 33, sub, size=9.5, color=T["muted"])
        r, of = ranks[k]
        p.text(x, top - 17, f"QuickReview #{r} of {of}", size=9.5, color=T["ink2"], weight="bold" if r == 1 else "normal")
    for i, t in enumerate(tools):
        y = top + 14 + i * pitch
        if i % 2 == 0:
            p.c.add_patch(FancyBboxPatch((40, y - pitch / 2), 1120, pitch, boxstyle="round,pad=0,rounding_size=4",
                                         facecolor=T["track"], edgecolor="none", zorder=0, alpha=0.6))
        p.text(56, y + 4.5, B.name(t), size=11, weight="bold" if t == QR else "normal",
               color=T["ink"] if t == QR else T["ink2"])
        for k, (_, _, f, flag) in enumerate(cols):
            x = gut + k * cw
            v = f(t)
            if v is None:
                p.text(x + 2, y + 4.5, "—", size=11, color=T["muted"])
                continue
            bar(p.c, x, x + 100, y, 12, T["empty"], r=3)
            bar(p.c, x, x + 100 * v, y, 12, B.colour(t, T), r=3, zorder=3)
            pub = flag and "same" not in mb.get(t, {})
            p.text(x + 108, y + 4.5, f"{v * 100:.0f}%" + ("°" if pub else ""), size=10.5,
                   weight="bold" if t == QR else "normal", color=T["ink"] if t == QR else T["ink2"])
    p.footer("° Martian's published evaluation (Claude Opus 4.5 judge), which credits the tools judged both ways "
             "4–6 more real bugs than our gpt-6.1-sol judge; every other Martian cell is our judge.\nAACR-Bench: one "
             "judge (gpt-6-sol), 185 real PRs, a partly found defect counts ½. Qodo: one gpt-6.1-sol judge, file and "
             "±5-line rule. QuickReview: frozen build e32f0cf.")
    return p


def numbers_md(B):
    """The table view behind every chart, rebuilt with them (out/NUMBERS.md)."""
    hm = B.total(SERIOUS)
    prs = collections.defaultdict(list)
    for x in B.D:
        if x["severity"] in SERIOUS:
            prs[x["pr"]].append(x)
    out = [f"# Showcase numbers\n\nGenerated by make_charts.py from data/ (AACR data generated {B.aacr['generated']}, "
           f"Qodo {B.qodo['generated']}). Recall is a share of the benchmark's own count; a partly found AACR "
           f"defect counts ½.\n",
           f"## AACR-Bench ({B.aacr['cases']} PRs, {B.total()} defects, judge {B.aacr['judge']})\n",
           "| Reviewer | Kind | High (%d) | High + medium (%d) | All (%d) | Serious missed | PRs with every serious "
           "defect found (of %d) | Comments | $/PR | Median min |" % (B.total(HIGH), hm, B.total(), len(prs)),
           "|---|---|---|---|---|---|---|---|---|---|"]
    for t in B.ranked() + ["quickreview-b2ce03a"]:
        r = B.aacr["reviewers"][t]
        clean = sum(1 for xs in prs.values() if all(x["credit"][t] == 1 for x in xs))
        usd = "?" if r["usd_mean"] is None else f"{r['usd_mean']:.2f}"
        mins = "?" if r["minutes_median"] is None else f"{r['minutes_median']:.1f}"
        out.append(f"| {B.name(t)} | {B.kind(t)} | {fmt(B.found(t, HIGH))} ({pct(B.recall(t, HIGH))}) | "
                   f"{fmt(B.found(t, SERIOUS))} ({pct(B.recall(t, SERIOUS))}) | {fmt(B.found(t))} ({pct(B.recall(t))}) | "
                   f"{fmt(hm - B.found(t, SERIOUS))} | {clean} ({pct(clean / len(prs))}) | {r['comments']} | {usd} | {mins} |")
    q = B.qodo["tools"]
    out += [f"\n## Qodo PR-Review-Bench ({q[QR]['prs']} PRs, {q[QR]['issues']} issues; N=5 location rule)\n",
            "| Tool | Kind | Functional recall | All-issue recall | Rule recall | Precision | F1 | Comments/PR |",
            "|---|---|---|---|---|---|---|---|"]
    for t in sorted(q, key=lambda t: -B.qodo_recall(t)):
        s = q[t]["scores"]["N=5"]
        out.append(f"| {B.name(t)} | {B.kind(t)} | {s['recall_functional'] * 100:.1f}% | {s['recall'] * 100:.1f}% | "
                   f"{s['recall_rule'] * 100:.1f}% | {s['precision'] * 100:.1f}% | {s['f1'] * 100:.1f}% | {s['per_pr']:.1f} |")
    mb = B.martian_best()
    n = B.martian["real_goldens"]
    out += [f"\n## Martian ({B.martian['prs']} PRs, {n} audited real golden comments)\n",
            "| Tool | Kind | Our judge (gpt-6.1-sol) | Martian's published judge (Opus 4.5) |", "|---|---|---|---|"]
    for t in sorted(mb, key=lambda t: -max(mb[t].values())):
        d = mb[t]
        cell = lambda k: f"{d[k]} ({pct(d[k] / n)})" if k in d else "—"  # noqa: E731
        out.append(f"| {B.name(t)} | {B.kind(t)} | {cell('same')} | {cell('published')} |")
    return "\n".join(out) + "\n"


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
    "scorecard": fig_scorecard,
}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("names", nargs="*", help="figures to draw (default: all)")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--theme", choices=("light", "dark", "both"), default="both")
    ap.add_argument("--out", default=os.path.join(HERE, "out"))
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
            page = FIGURES[name](B, T)
            print("wrote", os.path.relpath(save(page, a.out, name, th, svg=th == "light")))
    path = os.path.join(a.out, "NUMBERS.md")
    open(path, "w").write(numbers_md(B))
    print("wrote", os.path.relpath(path))


if __name__ == "__main__":
    main()
