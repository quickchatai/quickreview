#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["matplotlib>=3.8", "markdown>=3.5"]
# ///
"""The repository README's benchmark charts, light and dark, into docs/media/.

    uv run bench/aacr/showcase/readme_charts.py              # or name figures: ... readme_charts.py bench-hero

The numbers are the papers' tables, copied here with the table each row comes from, so the
README's charts and its prose read the same source: AACR-Bench is benchmark.tex Table
tab:final (QuickReview's row: its frozen build, quickreview.tex Table tab:frozen), Martian is
benchmark.tex Table tab:martianfinal, Qodo is benchmark.tex Table tab:qodo. The high + medium
counts (bench-hero) are computed from the per-defect credits in data/aacr.json,
the same runs as tab:final. Every title is computed from the rows. The look is v4's (theme_v4);
the images carry no repo file names.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from make_charts_v4 import place_labels  # noqa: E402
import theme_v4 as theme  # noqa: E402
from theme_v4 import Page4, axis_frame, dot  # noqa: E402

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "docs", "media")
QR = "QuickReview (GPT-6.1 Sol)"
OTHERS = "Other reviewers: all on GPT-6.1 Sol except Claude Code (Claude Opus 5.5)."

# AACR-Bench, 185 PRs: found of 90 high-severity and of all 520 verified defects (a partly found one counts ½).
AACR = [  # (name, high found, all found)
    (QR, 87.5, 461),
    ("pi-review panel", 80, 347.5),
    ("Claude Code", 72.5, 324.5),
    ("open-code-review", 63.5, 298.5),
    ("Codex CLI", 81, 287),
    ("OpenCode", 76, 263.5),
    ("PR-Agent", 55.5, 194),
]

# Martian Code Review Bench, 50 PRs: precision and recall against its goldens, one GPT-6.1 Sol judge for every row.
MARTIAN = [  # (name, precision, recall)
    (QR, 16.2, 65.8),
    ("qodo-extended-v2", 56.2, 60.1),
    ("cubic-v2", 54.3, 60.1),
    ("open-code-review", 26.7, 58.9),
    ("PR-Agent", 41.9, 36.1),
    ("Claude Code", 36.5, 41.1),
    ("OpenCode", 32.7, 33.5),
]

# Qodo PR-Review-Bench, 100 PRs, 580 injected issues: precision and recall, one GPT-6.1 Sol judge for every tool.
QODO = [  # (name, precision, recall)
    ("qodo-exhaustive", 58.0, 46.4),
    ("qodo-precise", 68.0, 35.9),
    ("augment", 67.5, 29.7),
    (QR, 37.3, 45.3),
    ("OpenCode", 64.9, 29.0),
    ("copilot", 46.8, 33.6),
    ("greptile", 64.7, 26.6),
    ("cursor", 73.8, 24.3),
    ("open-code-review", 47.1, 28.1),
    ("codex", 78.2, 22.2),
    ("PR-Agent", 47.2, 27.2),
    ("sentry", 76.8, 12.6),
    ("coderabbit", 43.7, 14.3),
]


# The same base model in two reviewers, AACR-Bench, one judge (GPT-6 Sol at high) for both rows of a pair.
SAME_MODEL = [  # (model, PRs, high defects, all defects, [(reviewer, high found, all found)])
    # quickreview.tex Table tab:bm40 (QuickReview on Opus, the 40 T40 PRs it was tuned on, September build) and
    # benchmark.tex Table tab:halves-sol (Claude Code on the same 40, its 185-PR runs cut to them).
    ("Claude Opus 5.5", 40, 34, 126, [("QuickReview", 32, 119.5), ("Claude Code /code-review", 25.5, 75)]),
    # benchmark.tex Table tab:final: the frozen build and Codex CLI at high.
    ("GPT-6.1 Sol", 185, 90, 520, [("QuickReview", 87.5, 461), ("Codex CLI (high)", 81, 287)]),
    # benchmark.tex Table tab:sol-summary: the original default run and Codex CLI as first run (medium, no PR text).
    ("GPT-6 Sol", 185, 90, 520, [("QuickReview", 86, 437.5), ("Codex CLI (as shipped)", 70, 248.5)]),
]

# Pairwise Elo on Martian's hard20 (the 20 PRs QuickReview on GPT-6.1 Sol or DeepSeek V4.1 Flash did worst on
# against its own average), both judges pooled: the "Combined" table of the run archive's
# elo/martian-hard20-all-gpt/REPORT.md. QuickReview's Opus and Sonnet runs kept the image's six lenses pinned to
# GPT-6 Luna (maintainability, duplication, abstraction, consistency, placement, simplicity).
ELO = [  # (name, Elo, 95% low, 95% high, QuickReview?)
    ("Claude Code max (Opus + Sonnet 5.5)", 1666, 1581, 1794, False),
    ("QuickReview (Opus 5.5)*", 1628, 1567, 1726, True),
    ("QuickReview (GPT-6.1 Sol)", 1566, 1486, 1662, True),
    ("Claude Code high (Opus 5.5)", 1518, 1425, 1629, False),
    ("QuickReview (Sonnet 5.5)*", 1489, 1415, 1584, True),
    ("QuickReview (DeepSeek V4.1 Flash)", 1406, 1201, 1556, True),
    ("Claude Code high (Sonnet 5.5)", 1398, 1290, 1456, False),
    ("QuickReview (GLM-5.3 Flash)", 1329, 1110, 1477, True),
]
# One pair from the same REPORT's every-pair table: direct record over both judges, and the gap's 95% interval.
ELO_DIRECT = ("QuickReview (Opus 5.5)*", "Claude Code high (Opus 5.5)", 29, 11, (31, 196))

DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "aacr.json")
KEYS = {"quickreview": QR, "pi-review": "pi-review panel", "claude-code": "Claude Code",
        "open-code-review": "open-code-review", "codex-cli": "Codex CLI", "opencode": "OpenCode", "pr-agent": "PR-Agent"}


def serious():
    """Per reviewer of AACR, from data/aacr.json's per-defect credits: high-severity found, high + medium found,
    and the PRs with a high or medium defect where every one of them was found in full."""
    with open(DATA) as f:
        d = json.load(f)
    high = [x for x in d["defects"] if x["severity"] == "high"]
    ser = [x for x in d["defects"] if x["severity"] in ("high", "medium")]
    prs = {}
    for x in ser:
        prs.setdefault(x["pr"], []).append(x)
    rows = {name: {"high": sum(x["credit"][k] for x in high),
                   "found": sum(x["credit"][k] for x in ser),
                   "clean": sum(all(x["credit"][k] == 1.0 for x in xs) for xs in prs.values())}
            for k, name in KEYS.items()}
    assert {n: (r["high"], sum(x["credit"][k] for x in d["defects"])) for k, n in KEYS.items() for r in [rows[n]]} \
        == {r[0]: (r[1], r[2]) for r in AACR}, "data/aacr.json is not tab:final"
    return rows, len(high), len(ser), len(prs), d["cases"]


def pct(v):
    return f"{v:.0f}%"


def ordinal(n):
    return f"{n}{'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"


def place(rows, i):
    """QuickReview's place on column i, best first."""
    ours = next(r[i] for r in rows if r[0] == QR)
    return 1 + sum(1 for r in rows if r[0] != QR and r[i] > ours)


def fig_aacr(T):
    rows = sorted(AACR, key=lambda r: -r[2])
    lead = place(rows, 1) == 1 and place(rows, 2) == 1
    p = Page4(T, h=640)
    p.title("Most real defects found, high-severity and overall" if lead else "Real defects found")
    p.metric("AACR-Bench · 185 real PRs in 10 languages · share of the verified defects found · higher is better")
    cols = [("High severity · 90 defects", 1, 90, 330), ("All · 520 defects", 2, 520, 770)]
    top, bottom, width = 190, p.h - 96, 330
    pitch = (bottom - top) / len(rows)
    h = min(26, pitch * 0.62)
    for head, _, _, x0 in cols:
        p.text(x0, top - 22, head, size=14, weight="bold", va="baseline")
    for k, r in enumerate(rows):
        y = top + pitch * (k + 0.5)
        ours = r[0] == QR
        ink, wt = (T["ink"], "bold") if ours else (T["ink2"], "normal")
        p.text(cols[0][3] - 14, y, r[0], ha="right", size=13.5, color=ink, weight=wt)
        for _, i, n, x0 in cols:
            share = r[i] / n
            theme.bar(p.c, x0, x0 + width, y, h, T["empty"], zorder=2)
            theme.bar(p.c, x0, x0 + width * share, y, h, T["qr"] if ours else T["other"], zorder=3)
            p.text(x0 + width + 12, y, pct(100 * share), size=13.5, color=ink, weight=wt)
    p.source("520 defects each verified in the code; one judge (GPT-6 Sol), one run per reviewer, a partly found "
             "defect counts ½.\nQuickReview: its frozen build. " + OTHERS)
    return p


def scatter(T, rows, title, metric, source, xr, yr, xt, yt, xlabel, ylabel, x_of, y_of):
    p = Page4(T, h=780)
    p.title(title)
    p.metric(metric)
    box = (130, 170, p.w - 70, p.h - 140)
    X, Y = axis_frame(p, box, xr, yr, xt, yt, pct, pct, xlabel, ylabel)
    r = 6
    taken = [(X(x_of(q)) - r - 2, Y(y_of(q)) - r - 2, X(x_of(q)) + r + 2, Y(y_of(q)) + r + 2) for q in rows]
    for q in sorted(rows, key=lambda q: q[0] == QR):
        dot(p, X(x_of(q)), Y(y_of(q)), r, T["qr"] if q[0] == QR else T["other"], zorder=6 if q[0] == QR else 4)
    order = sorted(rows, key=lambda q: (q[0] != QR, -y_of(q)))
    place_labels(p, [(X(x_of(q)), Y(y_of(q)), q[0], {"size": 13.5 if q[0] == QR else 11.5,
                                                    "weight": "bold" if q[0] == QR else "normal",
                                                    "color": T["ink"] if q[0] == QR else T["ink2"]})
                     for q in order], taken, (box[0] + 4, box[1] + 4, box[2] - 4, box[3] - 4))
    p.text(box[2] - 8, box[1] + 14, "better ↗", size=12, color=T["muted"], ha="right", weight="bold")
    p.source(source)
    return p


def headline(rows, n):
    kr, kp = place(rows, 2), place(rows, 1)
    last = "lowest precision" if kp == n else f"{ordinal(kp)} on precision"
    first = "Highest recall" if kr == 1 else f"{ordinal(kr)} of {n} on recall"
    return f"{first}, {last}"


def fig_martian(T):
    n = len(MARTIAN)
    return scatter(
        T, MARTIAN, headline(MARTIAN, n),
        f"Martian Code Review Bench · 50 PRs · {n} reviewers, each a dot · up and right is better",
        "One judge (GPT-6.1 Sol) for every row; Martian counts any comment not on its golden list as a false "
        "positive.\nQuickReview: its frozen build. The vendor rows are their published comments, re-judged.",
        (0, 70), (0, 80), [0, 10, 20, 30, 40, 50, 60, 70], [0, 20, 40, 60, 80],
        "Precision: share of its comments that match a golden  →  less noise",
        "Recall: share of the goldens found  ↑  more thorough",
        lambda q: q[1], lambda q: q[2])


def fig_qodo(T):
    n = len(QODO)
    return scatter(
        T, QODO, headline(QODO, n),
        f"Qodo PR-Review-Bench · 100 PRs · 580 injected issues · {n} reviewers, each a dot · up and right is better",
        "One judge (GPT-6.1 Sol) for every tool, under Qodo's matching rule. The vendor rows are their published "
        "reviews.\nQuickReview: its frozen build. OpenCode, open-code-review and PR-Agent: run by us on GPT-6.1 Sol.",
        (0, 90), (0, 60), [0, 15, 30, 45, 60, 75, 90], [0, 15, 30, 45, 60],
        "Precision: share of its comments that name an injected issue  →  less noise",
        "Recall: share of the 580 issues found  ↑  more thorough",
        lambda q: q[1], lambda q: q[2])


HERO_SOURCE = ("520 defects each verified in the code; one judge (GPT-6 Sol), one run each, a partly found one counts ½. "
               + OTHERS.replace("Other reviewers: all", "Others").replace(" (Claude Opus 5.5)", " (Opus 5.5)")
               + "\nQuickReview: frozen build on GPT-6.1 Sol, last tuned on misses from 145 of these PRs; on the 20 kept out, "
                 "it finds 83% of all defects, the next best 72%.")
MARGIN = 2.0  # never headline a lead under 2 points


def fig_hero(T):
    """Three shares of the defects that matter, each over the field it was measured against."""
    S, n_high, n_ser, n_prs, n_cases = serious()
    panels = [  # (key, out of, big number, what it is)
        ("high", n_high, None, f"of the {n_high} high-severity defects found"),
        ("found", n_ser, None, f"of the {n_ser} high + medium defects found"),
        ("clean", n_prs, f"{S[QR]['clean']} of {n_prs}", "PRs with all high + medium found in full"),
    ]
    lead = all(100 * (S[QR][k] - max(r[k] for n, r in S.items() if n != QR)) / n >= MARGIN for k, n, _, _ in panels)
    p = Page4(T, h=560)
    p.title(f"The highest-performing of {len(S)} AI reviewers tested" if lead else f"{len(S)} AI reviewers tested")
    p.metric(f"AACR-Bench · {n_cases} real PRs · {n_ser} high- and medium-severity defects, each verified in the code · "
             "higher is better")
    col, top = 372, 296
    for i, (k, vmax, big, what) in enumerate(panels):
        x0 = 64 + col * i
        fmt = (lambda v: f"{v:.0f}") if big else (lambda v, n=vmax: pct(100 * v / n))
        rows = sorted(S.items(), key=lambda kv: -kv[1][k])
        nxt = next((n, r) for n, r in rows if n != QR)
        p.text(x0, 196, big or fmt(S[QR][k]), size=50, weight="bold", color=T["qr"], va="baseline")
        p.text(x0, 232, what, size=13.5, va="baseline")
        p.text(x0, 258, f"next best: {fmt(nxt[1][k])} ({nxt[0]})", size=12.5, color=T["ink2"], va="baseline")
        pitch = 26
        for j, (name, r) in enumerate(rows):
            y = top + pitch * (j + 0.5)
            ours = name == QR
            ink, wt = (T["ink"], "bold") if ours else (T["ink2"], "normal")
            bx0, bx1 = x0 + 128, x0 + 250
            theme.bar(p.c, bx0, bx1, y, 14, T["empty"], zorder=2)
            theme.bar(p.c, bx0, bx0 + (bx1 - bx0) * r[k] / vmax, y, 14, T["qr"] if ours else T["other"], zorder=3)
            p.text(bx0 - 10, y, "QuickReview" if ours else name, ha="right", size=12, color=ink, weight=wt)
            p.text(bx1 + 8, y, fmt(r[k]), size=12, color=ink, weight=wt)
    p.source(HERO_SOURCE)
    return p


def fig_same_model(T):
    """Each base model in QuickReview and in its maker's own reviewer, same PRs, same judge."""
    lead = all(g[4][0][i] / n > g[4][1][i] / n + 0.02 for g in SAME_MODEL for i, n in ((1, g[2]), (2, g[3])))
    p = Page4(T, h=640)
    p.title(f"Same model, more defects found: ahead on all {len(SAME_MODEL)} models" if lead
            else "Same model, two reviewers")
    p.metric("AACR-Bench · share of the verified defects found · each pair: one model, same PRs · higher is better")
    cols = [("High severity", 1, 2, 380), ("All defects", 2, 3, 790)]
    top, width = 190, 300
    for head, _, _, x0 in cols:
        p.text(x0, top - 22, head, size=14, weight="bold", va="baseline")
    y = top
    for model, n_prs, n_high, n_all, pair in SAME_MODEL:
        y += 22
        p.text(64, y, f"{model} · {n_prs} PRs · {n_high} high-severity, {n_all} in all", size=13.5, weight="bold",
               color=T["ink"])
        y += 30
        for name, *found in pair:
            ours = name == "QuickReview"
            ink, wt = (T["ink"], "bold") if ours else (T["ink2"], "normal")
            p.text(cols[0][3] - 14, y, name, ha="right", size=13, color=ink, weight=wt)
            for (_, i, j, x0), n in zip(cols, (n_high, n_all)):
                share = found[i - 1] / n
                theme.bar(p.c, x0, x0 + width, y, 22, T["empty"], zorder=2)
                theme.bar(p.c, x0, x0 + width * share, y, 22, T["qr"] if ours else T["other"], zorder=3)
                p.text(x0 + width + 12, y, pct(100 * share), size=13, color=ink, weight=wt)
            y += 32
        y += 6
    p.source("One judge (GPT-6 Sol), one run each, a partly found defect counts ½. Opus: 40 PRs QuickReview was tuned on; "
             "Claude Code at its default effort.\nQuickReview: its frozen build on GPT-6.1 Sol, September builds on Opus "
             "and GPT-6 Sol. Codex CLI on GPT-6 Sol: as first run, at medium, without the PR text.")
    return p


def fig_elo(T):
    """A pairwise Elo leaderboard: a dot per configuration, its 95% interval as a whisker."""
    rows = sorted(ELO, key=lambda r: -r[1])
    _, _, w, l, gap = ELO_DIRECT
    separated = gap[0] > 0 and w > l  # the gap's interval excludes zero, and it won the games
    p = Page4(T, h=640)
    p.title(f"On Opus 5.5, QuickReview beats Claude Code high {w}–{l}" if separated
            else "Judged side by side")
    p.metric("Martian · 20 PRs where QuickReview (GPT-6.1 Sol, DeepSeek) did worst · Elo, 95% intervals · higher is better")
    lo, hi = 1100, 1850
    x0, x1, top, bottom = 420, p.w - 90, 186, p.h - 110
    X = lambda v: x0 + (x1 - x0) * (v - lo) / (hi - lo)  # noqa: E731
    for v in range(lo, hi + 1, 150):
        p.c.plot([X(v)] * 2, [top - 10, bottom + 4], color=T["grid"], lw=1, zorder=1)
        p.text(X(v), bottom + 24, str(v), size=11, color=T["muted"], ha="center")
    pitch = (bottom - top) / len(rows)
    for k, (name, elo, a, b, ours) in enumerate(rows):
        y = top + pitch * (k + 0.5)
        ink, wt = (T["ink"], "bold") if ours else (T["ink2"], "normal")
        fill = T["qr"] if ours else T["other"]
        p.c.plot([X(a), X(b)], [y, y], color=fill, lw=2.5, solid_capstyle="round", zorder=3)
        dot(p, X(elo), y, 7, fill, zorder=5)
        p.text(x0 - 16, y, name, ha="right", size=13, color=ink, weight=wt)
        p.text(X(b) + 10, y, str(elo), size=12, color=ink, weight=wt)
    p.source(f"Two judges pooled (GPT-6.1 Sol, Claude Opus 5.5), each reading both reviews blind; {w}–{l} is their verdicts "
             "on 20 PRs.\n* Six of its lenses on GPT-6 Luna. QuickReview builds: Oct 3 on GPT-6.1 Sol, mid-October on "
             "DeepSeek and GLM, Oct 20 on Opus and Sonnet.")
    return p


FIGURES = {"bench-hero": fig_hero, "bench-same-model": fig_same_model,
           "bench-aacr": fig_aacr, "bench-martian": fig_martian, "bench-qodo": fig_qodo, "bench-elo": fig_elo}


def main():
    for name in sys.argv[1:] or FIGURES:
        for t in ("light", "dark"):
            page = FIGURES[name](theme.use(t))
            for issue in theme.overflow(page):
                print(f"  {name} ({t}): {issue}")
            print(theme.save(page, OUT, name, t))


if __name__ == "__main__":
    main()
