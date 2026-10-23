#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["matplotlib>=3.8", "markdown>=3.5"]
# ///
"""The repository README's three benchmark charts, light and dark, into docs/media/.

    uv run bench/aacr/showcase/readme_charts.py

The numbers are the papers' tables, copied here with the table each row comes from, so the
README's charts and its prose read the same source: AACR-Bench is benchmark.tex Table
tab:final (QuickReview's row: its frozen build, quickreview.tex Table tab:frozen), Martian is
benchmark.tex Table tab:martianfinal, Qodo is benchmark.tex Table tab:qodo. Every title is
computed from the rows. The look is v4's (theme_v4); the images carry no repo file names.
"""
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


def main():
    for name, fig in (("bench-aacr", fig_aacr), ("bench-martian", fig_martian), ("bench-qodo", fig_qodo)):
        for t in ("light", "dark"):
            print(theme.save(fig(theme.use(t)), OUT, name, t))


if __name__ == "__main__":
    main()
