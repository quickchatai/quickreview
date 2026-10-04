#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["matplotlib>=3.8"]
# ///
"""Figures for the Martian critique — PDF, PNG and SVG in bench/aacr/charts/martian-*.

    uv run bench/aacr/martian_figs.py

No review, judge or annotation run is made here. Inputs:
  charts/martian-data.json   derived once from the golden audit labels and the stored
                             Martian evaluations (golden per-item buckets, real-golden
                             credits per tool, the "all blocking found" counts)
  ext/martian-tuning/tune20-leaderboard.txt   the posting-policy variants (tune20)
  the small tables below, copied from FAIR-COMPARISON.md (section C), the 50-PR
  Core scoring (score_profiles.py over the stored evaluations) and Martian's
  published Opus 4.5 results.
QuickReview is drawn in the highlight colour in every figure.
"""
import collections, json, os, re

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "charts")
INK, MUTED, GRID, GROUND = "#141922", "#566172", "#E3E8EF", "#FFFFFF"
QR, OTHER, OTHER2 = "#2D5BFF", "#8A97AB", "#C9D1DC"
GOOD, MINOR, DUP, WRONG = "#2E8B57", "#D9B44A", "#8A97AB", "#D2455B"
plt.rcParams.update({
    "font.family": "DejaVu Sans", "font.size": 10.5, "text.color": INK, "axes.labelcolor": MUTED,
    "axes.edgecolor": GRID, "xtick.color": MUTED, "ytick.color": INK, "axes.titleweight": "bold",
    "axes.titlesize": 12.5, "axes.titlelocation": "left", "figure.facecolor": GROUND, "axes.facecolor": GROUND,
    "savefig.facecolor": GROUND, "axes.spines.top": False, "axes.spines.right": False, "svg.fonttype": "none",
})
D = json.load(open(os.path.join(OUT, "martian-data.json")))


def save(fig, name):
    for ext in ("pdf", "png", "svg"):
        fig.savefig(os.path.join(OUT, f"martian-{name}.{ext}"), dpi=200 if ext == "png" else None, bbox_inches="tight")
    plt.close(fig)


def is_qr(name):
    return name.lower().startswith("quickreview")


# 1 — the golden audit: what Martian's 173 golden comments are
def fig_audit():
    g = D["goldens"]
    order = ["real", "disputed", "notreal"]
    colors = {"real": GOOD, "disputed": OTHER, "notreal": WRONG}
    labels = {"real": "real defect introduced by the PR", "disputed": "disputed (investigators split)",
              "notreal": "not a real PR defect (trivial, latent, pre-existing, intended, wrong)"}
    sevs = ["Critical", "High", "Medium", "Low"]
    cats = [c for c, _ in collections.Counter(x["cat"] for x in g).most_common()]
    fig, axes = plt.subplots(1, 2, figsize=(11, 4.4), gridspec_kw={"width_ratios": [1, 1.5], "wspace": 0.35})
    for ax, key, rows, title in ((axes[0], "sev", sevs, "By Martian's severity label"),
                                 (axes[1], "cat", cats, "By Martian's category")):
        for i, r in enumerate(rows):
            left = 0
            for b in order:
                n = sum(1 for x in g if x[key] == r and x["bucket"] == b)
                if n:
                    ax.barh(i, n, left=left, color=colors[b], height=0.62, edgecolor=GROUND)
                if n >= 2:
                    ax.text(left + n / 2, i, str(n), ha="center", va="center", fontsize=9, color="white")
                left += n
        ax.set_yticks(range(len(rows)), rows)
        ax.invert_yaxis()
        ax.set_title(title, fontsize=11)
        ax.grid(axis="x", color=GRID)
        ax.set_axisbelow(True)
    c = collections.Counter(x["bucket"] for x in g)
    handles = [plt.Rectangle((0, 0), 1, 1, color=colors[b]) for b in order]
    fig.legend(handles, [f"{labels[b]} — {c[b]}" for b in order], loc="lower center", ncol=1, frameon=False,
               bbox_to_anchor=(0.5, -0.13))
    fig.suptitle(f"Martian's {len(g)} golden comments, audited one by one: only {c['real']} are real PR defects",
                 x=0.01, ha="left", fontweight="bold", fontsize=13)
    save(fig, "audit")


# 2 — real-golden recall vs share of credits earned on not-real goldens
# hand-placed label offsets (points, ha): the right-hand cluster is fanned out with leader lines
RVT_OFFSETS = {
    "QuickReview *": (10, 4, "left"), "copilot-v2": (10, 4, "left"),
    "qodo-extended-v2": (-8, 9, "right"), "qodo-extended-v2 *": (-9, -12, "right"),
    "augment": (8, 2, "left"), "qodo-v2": (8, -2, "left"),
    "cubic-v2": (34, 6, "left"), "cubic-v2 *": (34, 16, "left"), "coderabbit": (34, -2, "left"),
    "sourcery": (34, 12, "left"), "gitlab": (34, 1, "left"), "gemini-v2": (34, -10, "left"),
    "greptile-v4-1": (-10, 14, "right"), "claude-code": (34, -20, "left"),
    "macroscope": (8, 0, "left"), "bugbot": (8, 0, "left"), "devin": (8, 0, "left"),
    "claude-code *": (34, 0, "left"),
}


def fig_real_vs_trivia():
    fig, ax = plt.subplots(figsize=(8.6, 5.4))
    for src, marker, edge in (("real_published_opus", "o", OTHER), ("real_same_judge", "D", None)):
        for t, v in D[src].items():
            tot = v["real"] + v["notreal"] + v["disputed"]
            x, y = 100 * v["notreal"] / tot, 100 * v["real"] / 86
            c = QR if is_qr(t) else (OTHER if src.endswith("opus") else "#4A5567")
            ax.scatter(x, y, s=150 if is_qr(t) else 60, marker=marker, color=c, zorder=3,
                       edgecolor="white", linewidth=0.8)
            name = t.replace("QuickReview (latest)", "QuickReview")
            if src == "real_same_judge":
                name += " *"
            dx, dy, ha = RVT_OFFSETS.get(name, (6, 3, "left"))
            far = abs(dx) > 12 or abs(dy) > 9
            ax.annotate(name, (x, y), xytext=(dx, dy), textcoords="offset points", fontsize=8.5, ha=ha,
                        va="center", color=QR if is_qr(t) else INK,
                        fontweight="bold" if is_qr(t) else "normal",
                        arrowprops={"arrowstyle": "-", "color": MUTED, "lw": 0.6, "shrinkA": 0, "shrinkB": 4}
                        if far else None)
    ax.set_xlim(17, 44)
    ax.set_xlabel("share of the tool's golden credits that land on NOT-real goldens (%)")
    ax.set_ylabel("real goldens found, of 86 (%)")
    ax.grid(color=GRID)
    ax.set_axisbelow(True)
    ax.set_title("Finding the real defects vs being rewarded for the rest (50 PRs)")
    ax.text(0.01, 0.01, "◆ * = judged by gpt-6.1-sol in our pass   ● = Martian's published Opus 4.5 judgements",
            transform=ax.transAxes, fontsize=8.5, color=MUTED)
    save(fig, "real-vs-trivia")


# 3 + 4 — the tune20 extended key (FAIR-COMPARISON.md, section C; QuickReview = round-1 default)
FAIR = [  # tool, recall, P strict, P lenient, GOOD, MINOR, DUP, WRONG
    ("QuickReview", 86.6, 40.0, 75.6, 68, 80, 19, 3), ("qodo-v2", 52.4, 58.7, 92.5, 37, 23, 0, 3),
    ("augment", 48.8, 54.4, 86.0, 37, 25, 3, 3), ("qodo-extended-v2", 46.3, 56.1, 82.2, 37, 21, 3, 5),
    ("cubic-v2", 42.7, 50.0, 70.2, 33, 19, 5, 9), ("claude-code", 39.0, 42.7, 71.1, 32, 30, 8, 5),
    ("macroscope", 31.7, 63.2, 82.8, 24, 9, 1, 4), ("devin", 26.8, 64.7, 78.6, 22, 6, 5, 1)]


def fig_extended_key():
    fig, ax = plt.subplots(figsize=(8.6, 6.6))
    for t, r, ps, pl, *_ in FAIR:
        c = QR if is_qr(t) else "#4A5567"
        ax.plot([ps, pl], [r, r], color=c, lw=1.2, alpha=0.5, zorder=2)
        ax.scatter(ps, r, s=140 if is_qr(t) else 60, color=c, zorder=3)
        ax.scatter(pl, r, s=60, facecolor="white", edgecolor=c, zorder=3, linewidth=1.5)
        # name on the left of the strict point, vertically centred on its row: rows sit
        # 2.5 recall points apart at the tightest, which the taller canvas keeps legible
        ax.annotate(t, (ps, r), xytext=(-9, 0), textcoords="offset points", ha="right", va="center",
                    fontsize=8.5, color=c, fontweight="bold" if is_qr(t) else "normal")
    ax.set_xlim(20, 100)
    ax.set_ylim(20, 95)
    ax.set_xlabel("precision against real defects (%) — ● strict: true-but-minor counts as noise   ○ lenient: it does not")
    ax.set_ylabel("recall of the 82 real defects (%)")
    ax.set_title("Tune20 with the key extended by every real bug any tool found")
    ax.grid(color=GRID)
    ax.set_axisbelow(True)
    save(fig, "extended-key")


def fig_composition():
    fig, ax = plt.subplots(figsize=(8.6, 4.6))
    rows = sorted(FAIR, key=lambda x: -(x[4] + x[5] + x[6] + x[7]))
    for i, (t, *_, good, minor, dup, wrong) in enumerate(rows):
        left = 0
        for n, c in ((good, GOOD), (minor, MINOR), (dup, DUP), (wrong, WRONG)):
            ax.barh(i, n, left=left, color=c, height=0.62, edgecolor=GROUND)
            if n >= 6:
                ax.text(left + n / 2, i, str(n), ha="center", va="center", fontsize=8.5, color="white")
            left += n
    ax.set_yticks(range(len(rows)), [r[0] for r in rows])
    for lbl in ax.get_yticklabels():
        if is_qr(lbl.get_text()):
            lbl.set_color(QR)
            lbl.set_fontweight("bold")
    ax.invert_yaxis()
    ax.set_xlabel("extracted comments on the 20 tuning PRs")
    handles = [plt.Rectangle((0, 0), 1, 1, color=c) for c in (GOOD, MINOR, DUP, WRONG)]
    ax.legend(handles, ["real defect (golden or unlisted)", "true but minor", "duplicate", "wrong"],
              frameon=False, loc="lower right")
    ax.set_title("What each tool's comments are (blind classification, tool hidden)")
    ax.grid(axis="x", color=GRID)
    ax.set_axisbelow(True)
    save(fig, "composition")


# 5 — posting-policy experiments slide along the precision/recall frontier
def fig_policy():
    pts = []
    for ln in open(os.path.join(HERE, "ext", "martian-tuning", "tune20-leaderboard.txt")):
        m = re.match(r"(\S+)\s+P\s+([\d.]+)\s+R\s+([\d.]+)", ln)
        if m:
            pts.append((m.group(1), float(m.group(2)), float(m.group(3))))
    fig, ax = plt.subplots(figsize=(8.6, 5.6))
    import numpy as np
    p = np.linspace(1, 100, 300)
    for f2 in (30, 40, 50, 60, 70):
        r = f2 * 4 * p / (5 * p - f2)
        ok = (r > 0) & (r <= 100)
        ax.plot(p[ok], r[ok], color=GRID, lw=1, zorder=1)
        ax.text(99, f2 * 4 * 99 / (5 * 99 - f2) + 1, f"F2={f2}", fontsize=8, color=MUTED, ha="right")
    ax.scatter([x[1] for x in pts], [x[2] for x in pts], s=22, color=shade(QR), zorder=2,
               label=f"{len(pts)} posting policies on stored reviews (tune20)")
    named = [("as posted, tune20", 19.7, 58.6), ("round 3 default", 20.2, 60.3), ("snappy profile", 27.0, 34.5)]
    offs = {"as posted, tune20": (-14, -18, "right"), "round 3 default": (14, 16, "left"),
            "snappy profile": (8, -12, "left")}
    for t, x, y in named:
        ax.scatter(x, y, s=80, color=QR, zorder=4)
        dx, dy, ha = offs[t]
        ax.annotate(t, (x, y), xytext=(dx, dy), textcoords="offset points", fontsize=8.5, color=QR, ha=ha,
                    va="center", arrowprops={"arrowstyle": "-", "color": QR, "lw": 0.7, "shrinkA": 0, "shrinkB": 4})
    ax.annotate("", xy=(36.5, 19.0), xytext=(49.0, 43.1),
                arrowprops={"arrowstyle": "->", "color": WRONG, "lw": 1.6})
    ax.scatter([49.0], [43.1], s=80, color=WRONG, zorder=4)
    ax.scatter([36.5], [19.0], s=80, facecolor="white", edgecolor=WRONG, zorder=4, linewidth=1.6)
    ax.text(49.5, 44.5, "best policy, frozen on tune20 (F1 45.9)", fontsize=8.5, color=WRONG)
    ax.text(37.0, 15.5, "same policy on test30 (F1 25.0)", fontsize=8.5, color=WRONG)
    ax.scatter([62.7], [72.4], s=80, color="#4A5567", zorder=4)
    ax.annotate("cubic-v2 (re-judged)", (62.7, 72.4), xytext=(6, 4), textcoords="offset points", fontsize=8.5)
    ax.set_xlim(0, 100)
    ax.set_ylim(0, 100)
    ax.set_xlabel("Martian precision (%)")
    ax.set_ylabel("Martian recall (%)")
    ax.legend(frameon=False, loc="lower right", fontsize=8.5)
    ax.set_title("Cutting what we post trades recall for precision; F2 stays near 40–45")
    ax.grid(color=GRID, alpha=0.6)
    ax.set_axisbelow(True)
    save(fig, "policy")


def shade(hex_color, f=0.55):
    h = hex_color.lstrip("#")
    r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    return "#%02x%02x%02x" % tuple(int(c + (255 - c) * f) for c in (r, g, b))


# 6 — PRs where every listed blocking problem was found
def fig_allfound():
    af = D["allfound"]
    fig, axes = plt.subplots(1, 2, figsize=(11, 5.2), sharey=False)
    for ax, key, title in ((axes[0], "hi", "All of Martian's Critical+High goldens"),
                           (axes[1], "realhi", "All audited-REAL Critical+High goldens")):
        rows = [(t, a, n, "same") for t, (a, n) in af[key + "_same"].items()]
        rows += [(t, a, n, "opus") for t, (a, n) in af[key + "_opus"].items()
                 if t not in ("qodo-extended-v2", "cubic-v2", "claude-code")]
        rows.sort(key=lambda r: -r[1] / r[2])
        n_prs = rows[0][2]
        for i, (t, a, n, src) in enumerate(rows):
            c = QR if is_qr(t) else ("#4A5567" if src == "same" else OTHER2)
            ax.barh(i, 100 * a / n, color=c, height=0.66)
            ax.text(100 * a / n + 1, i, f"{a}/{n}", va="center", fontsize=8, color=MUTED)
        ax.set_yticks(range(len(rows)), [r[0].replace("QuickReview (latest)", "QuickReview") +
                                         (" *" if r[3] == "same" else "") for r in rows], fontsize=8.5)
        for lbl in ax.get_yticklabels():
            if is_qr(lbl.get_text()):
                lbl.set_color(QR)
                lbl.set_fontweight("bold")
        ax.invert_yaxis()
        ax.set_xlim(0, 100)
        ax.set_xlabel(f"% of the {n_prs} PRs that have one")
        ax.set_title(title, fontsize=11)
        ax.grid(axis="x", color=GRID)
        ax.set_axisbelow(True)
    fig.suptitle("PRs where the tool found every listed blocking problem", x=0.01, ha="left",
                 fontweight="bold", fontsize=13)
    fig.text(0.01, -0.02, "* = gpt-6.1-sol judge, same pass (dark); others: Martian's published Opus 4.5 "
             "judgements, which credit 7–12 more matches per tool than ours", fontsize=8.5, color=MUTED)
    save(fig, "all-blocking")


# 7 — the 50-PR leaderboard (Core, F2), Martian's published Opus 4.5 judge
OPUS50 = [("qodo-extended-v2", 65.1), ("cubic-v2", 64.9), ("augment", 64.0), ("qodo-v2", 60.6),
          ("copilot-v2", 58.0), ("gemini-v2", 52.8), ("gitlab", 52.7), ("sourcery", 51.5),
          ("greptile-v4-1", 51.2), ("coderabbit", 51.1), ("macroscope", 50.8), ("bugbot", 48.6),
          ("claude-code", 47.7), ("devin", 44.8), ("greptile-v5", 44.5), ("kodus-v2", 41.5),
          ("codeant-v2", 40.9), ("copilot", 40.6), ("baz", 40.5), ("claude", 38.9), ("kg", 18.4),
          ("graphite", 9.3)]
QR_EST = (43.5, 45.6)  # final build (2026-10-04): our-judge 104 matches / 640 candidates (F2 40.9), plus the 7..12 extra matches per tool the Opus 4.5 judge credited across our passes


def fig_leaderboard():
    rows = OPUS50 + [("QuickReview (estimate)", sum(QR_EST) / 2)]
    rows.sort(key=lambda r: -r[1])
    fig, ax = plt.subplots(figsize=(8.6, 6.4))
    for i, (t, v) in enumerate(rows):
        if is_qr(t):
            ax.barh(i, QR_EST[0], color=shade(QR, 0.35), height=0.66)
            ax.barh(i, QR_EST[1] - QR_EST[0], left=QR_EST[0], color=QR, height=0.66, hatch="////",
                    edgecolor="white")
            ax.text(QR_EST[1] + 1, i, f"{QR_EST[0]}–{QR_EST[1]} (est.)", va="center", fontsize=8.5, color=QR)
        else:
            ax.barh(i, v, color=OTHER2, height=0.66)
            ax.text(v + 1, i, f"{v:.1f}", va="center", fontsize=8, color=MUTED)
    ax.set_yticks(range(len(rows)), [r[0] for r in rows], fontsize=8.5)
    for lbl in ax.get_yticklabels():
        if is_qr(lbl.get_text()):
            lbl.set_color(QR)
            lbl.set_fontweight("bold")
    ax.invert_yaxis()
    ax.set_xlim(0, 80)
    ax.set_xlabel("Martian Core F2, 50 PRs, Opus 4.5 judge")
    ax.set_title("Martian's leaderboard metric: QuickReview mid-table")
    ax.text(0.99, 0.02, "QuickReview was never judged by Opus: range estimated from the three tools\n"
            "both judges scored (Opus credits 7–12 more matches each). Our own judge: F2 40.9.",
            transform=ax.transAxes, fontsize=8, color=MUTED, ha="right")
    ax.grid(axis="x", color=GRID)
    ax.set_axisbelow(True)
    save(fig, "leaderboard")


# 8 — where QuickReview is strong: its own severity tiers, real-defect share vs Martian's precision
TIERS = [("P0–P1", 38, 32, 4, 1, 1), ("P2", 46, 19, 22, 4, 1), ("P3", 18, 8, 10, 0, 0), ("nit", 68, 10, 44, 14, 0)]
CUM = [("P0–P1 only", 84, 26.4, "2.4/PR"), ("P0–P2", 61, 21.2, "6.0/PR"),
       ("everything", 41, 19.2, "9.4/PR")]


def fig_strength():
    fig, axes = plt.subplots(1, 2, figsize=(11, 4.6), gridspec_kw={"width_ratios": [1.1, 1]})
    ax = axes[0]
    x = range(len(CUM))
    ax.bar([i - 0.19 for i in x], [c[1] for c in CUM], width=0.36, color=GOOD, label="real defects (blind classification, tune20)")
    ax.bar([i + 0.19 for i in x], [c[2] for c in CUM], width=0.36, color=OTHER, label="Martian precision (50 PRs, its judge)")
    for i, c in enumerate(CUM):
        ax.text(i - 0.19, c[1] + 1.5, f"{c[1]}%", ha="center", fontsize=9, color=GOOD, fontweight="bold")
        ax.text(i + 0.19, c[2] + 1.5, f"{c[2]:.0f}%", ha="center", fontsize=9, color=MUTED)
    ax.set_xticks(list(x), [f"{c[0]}\n{c[3]}" for c in CUM], fontsize=8.5)
    ax.set_ylim(0, 100)
    ax.set_ylabel("share of QuickReview's comments (%)")
    ax.legend(frameon=False, fontsize=8.5, loc="upper center", bbox_to_anchor=(0.5, -0.17), ncol=1)
    ax.set_title("Our blockers are real; the list cannot see them", fontsize=11)
    ax.grid(axis="y", color=GRID)
    ax.set_axisbelow(True)
    ax = axes[1]
    for i, (t, n, good, minor, dup, wrong) in enumerate(TIERS):
        left = 0
        for v, c in ((good, GOOD), (minor, MINOR), (dup, DUP), (wrong, WRONG)):
            w = 100 * v / n
            ax.barh(i, w, left=left, color=c, height=0.62, edgecolor=GROUND)
            if w >= 9:
                ax.text(left + w / 2, i, f"{100 * v / n:.0f}%", ha="center", va="center", fontsize=8.5, color="white")
            left += w
    ax.set_yticks(range(len(TIERS)), [f"{t}  (n={n})" for t, n, *_ in TIERS])
    ax.invert_yaxis()
    ax.set_xlim(0, 100)
    ax.set_xlabel("composition of the tier (%)")
    handles = [plt.Rectangle((0, 0), 1, 1, color=c) for c in (GOOD, MINOR, DUP, WRONG)]
    ax.legend(handles, ["real defect", "true but minor", "duplicate", "wrong"], frameon=False, fontsize=8.5,
              loc="upper center", bbox_to_anchor=(0.5, -0.14), ncol=4)
    ax.set_title("What each of our severity tiers is (tune20)", fontsize=11)
    fig.suptitle("Where QuickReview is strong: by its own severity", x=0.01, ha="left", fontweight="bold", fontsize=13)
    save(fig, "strength")


if __name__ == "__main__":
    for f in (fig_audit, fig_real_vs_trivia, fig_extended_key, fig_composition, fig_policy, fig_allfound,
              fig_leaderboard, fig_strength):
        f()
        print("ok", f.__name__)
