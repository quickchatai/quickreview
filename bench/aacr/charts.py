#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["matplotlib>=3.8", "pillow>=10"]
# ///
"""Charts for the benchmark report — JPGs in bench/aacr/charts/.

    uv run bench/aacr/charts.py --cases all30+fresh10+rest145 \\
        "quickreviewd default=b40-smoke10,b40-dev10,b40-holdout10,b40-fresh10,all-default-rest145" \\
        "quickreviewd low=all-low-smoke10,all-low-dev10,all-low-holdout10,all-low-fresh10,all-low-rest145" \\
        "open-code-review=b40ocr-smoke10,b40ocr-dev10,b40ocr-holdout10,b40ocr-fresh10,all-ocr-rest145"

Every number comes from the archived judge and harness files through
compare.py's own scoring (same denominators, same judge label), so a chart can
never disagree with the tables. An arm is NAME=runs as in compare.py; arms are
drawn in the order given, the first highlighted. Adding a reviewer is one more
NAME=runs argument.

`--sensitivity` draws only charts/config-sensitivity.jpg and its data
(config-sensitivity.json): arms are TOOL|VARIANT=runs, each tool's first
variant is its published configuration, and the variant the full comparison
takes forward is picked by `pick_best` (highest recall, ties to comments
correct). The command behind the published chart is in FULL-BENCHMARK.md. The "tuned vs unseen" chart splits the cases into the 40
PRs the review was tuned on (all30+fresh10) and the rest (rest145).

`--suffix -gpt6sol` writes every file as NAME-gpt6sol.jpg (and
numbers-gpt6sol.json), so an earlier arm set's charts are kept beside the
current ones; `--note` adds a second title line naming the arm set (model,
configurations). numbers.json also records each arm's recall on the tuned and
unseen halves and on the defects the code hunt or an AACR reference raised.
"""
import argparse, collections, json, os, statistics, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import compare  # noqa: E402

import matplotlib  # noqa: E402

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

INK, MUTED, GRID, GROUND = "#141922", "#566172", "#E3E8EF", "#FFFFFF"
PALETTE = ["#2D5BFF", "#8A97AB", "#D98A2B", "#2E8B57", "#9B51E0", "#D2455B", "#1B9AAA", "#6B4F2A"]
plt.rcParams.update({
    "font.family": "DejaVu Sans", "font.size": 11, "text.color": INK, "axes.labelcolor": MUTED,
    "axes.edgecolor": GRID, "xtick.color": MUTED, "ytick.color": INK, "axes.titleweight": "bold",
    "axes.titlesize": 13, "axes.titlelocation": "left", "figure.facecolor": GROUND, "axes.facecolor": GROUND,
    "savefig.facecolor": GROUND, "axes.spines.top": False, "axes.spines.right": False,
})


def shade(hex_color, f):
    """Mix a colour toward white by f (0 = colour, 1 = white)."""
    h = hex_color.lstrip("#")
    r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    return "#%02x%02x%02x" % tuple(int(c + (255 - c) * f) for c in (r, g, b))


def arm_stats(runs_dir, runs, cases, judge_model):
    """Per-severity credit, comments-correct share, cost and AACR numbers for one arm."""
    found, total = collections.Counter(), collections.Counter()
    ok_comments = all_comments = 0
    usd, mins = [], []
    for iid, (_, sevs, version) in cases.items():
        for sev in sevs.values():
            total[sev] += 1
        for run in runs:
            j = compare.judgement(runs_dir, run, iid, version, judge_model)
            if j is None:
                continue
            verdict = {x["id"]: x["verdict"] for x in j["defects"]}
            for did, sev in sevs.items():
                found[sev] += {"found": 1, "partial": 0.5}.get(verdict.get(did, "missed"), 0)
            for c in j["comments"]:
                all_comments += 1
                ok_comments += c["verdict"] in ("correct-valuable", "correct-minor")
            u, m = compare.usd_and_minutes(os.path.join(runs_dir, run, "cases", iid))
            usd.append(u)
            if m is not None:
                mins.append(m)
            break
    refs, generated, scored, _ = compare.aacr(runs_dir, runs, cases)
    labels = compare.ref_labels()
    n_refs = sum(len(labels.get(iid, {})) for iid in cases) or len(refs)
    hit = sum(refs.values())
    return {
        "found": dict(found), "total": dict(total),
        "correct": ok_comments / max(all_comments, 1),
        "usd": sum(usd) / max(len(usd), 1),
        "median_min": statistics.median(mins) if mins else 0,
        "aacr_recall": hit / max(n_refs, 1), "aacr_precision": hit / max(generated, 1),
    }


def recall(s):
    return sum(s["found"].values()) / max(sum(s["total"].values()), 1)


SUFFIX = ""  # --suffix: appended to every file name (e.g. "-gpt6sol"), so a second arm set never overwrites the first
NOTE = ""  # --note: one line under the headline charts' titles (which arms, which model)


def titled(title):
    return f"{title}\n{NOTE}" if NOTE else title


def save(fig, out, name):
    stem, ext = os.path.splitext(name)
    path = os.path.join(out, stem + SUFFIX + ext)
    fig.savefig(path, dpi=180, bbox_inches="tight", pil_kwargs={"quality": 92})
    plt.close(fig)
    print("wrote", os.path.relpath(path))


def chart_severity(arms, out):
    fig, ax = plt.subplots(figsize=(10, 1.1 + 0.75 * len(arms)))
    total = arms[0][2]["total"]
    n = sum(total.values())
    for i, (name, color, s) in enumerate(arms):
        left = 0
        for sev, f in (("high", 0), ("medium", 0.35), ("low", 0.62)):
            w = s["found"].get(sev, 0)
            ax.barh(i, w, left=left, color=shade(color, f), height=0.62, edgecolor=GROUND, linewidth=1)
            if w > n * 0.06:
                ax.text(left + w / 2, i, f"{w:g}", ha="center", va="center", fontsize=10,
                        color="white" if f < 0.5 else INK)
            left += w
        ax.text(left + n * 0.01, i, f"{left:g}  ({left / n:.0%})", va="center", fontsize=11, fontweight="bold",
                bbox={"facecolor": GROUND, "edgecolor": "none", "pad": 1.5}, zorder=4)
    ax.axvline(n, color=MUTED, lw=1, ls=(0, (3, 3)), zorder=1)
    ax.text(n, len(arms) - 0.45, f"all {n}", ha="center", va="top", fontsize=10, color=MUTED)
    ax.set_yticks(range(len(arms)), [a[0] for a in arms])
    ax.invert_yaxis()
    ax.set_xlim(0, n * 1.22)
    ax.grid(axis="x", color=GRID)
    ax.set_axisbelow(True)
    ax.set_xlabel("real defects found (partial = ½) — dark: high · mid: medium · light: low")
    ax.set_title(titled(f"Real defects found, by severity — {n} defects verified in the code"))
    save(fig, out, "defects-by-severity.jpg")


def chart_high(arms, out):
    fig, ax = plt.subplots(figsize=(7, 0.9 + 0.7 * len(arms)))
    n = arms[0][2]["total"].get("high", 0)
    for i, (name, color, s) in enumerate(arms):
        v = s["found"].get("high", 0)
        ax.barh(i, n, color=GRID, height=0.6)
        ax.barh(i, v, color=color, height=0.6)
        ax.text(n * 1.02, i, f"{v:g} / {n}", va="center", fontsize=11, fontweight="bold")
    ax.set_yticks(range(len(arms)), [a[0] for a in arms])
    ax.invert_yaxis()
    ax.set_xlim(0, n * 1.25)
    ax.set_xticks([])
    ax.spines["bottom"].set_visible(False)
    ax.set_title(titled("High-severity defects caught (merge-blocking)"))
    save(fig, out, "high-severity.jpg")


def chart_cost(arms, out):
    fig, ax = plt.subplots(figsize=(9, 4.8))
    for name, color, s in arms:
        x, y = s["usd"], recall(s) * 100
        ax.scatter([x], [y], s=140, color=color, zorder=3, label=f"{name} — {y:.0f}% · ${x:.2f}/PR")
    ax.legend(loc="center left", bbox_to_anchor=(1.02, 0.5), frameon=False, fontsize=10)
    ax.set_xlim(0, max(s["usd"] for _, _, s in arms) * 1.6)
    ax.set_ylim(0, 100)
    ax.set_xlabel("model cost per PR (list prices)")
    ax.set_ylabel("share of real defects found")
    ax.yaxis.set_major_formatter(matplotlib.ticker.PercentFormatter())
    ax.xaxis.set_major_formatter(matplotlib.ticker.FormatStrFormatter("$%.2f"))
    ax.grid(color=GRID)
    ax.set_axisbelow(True)
    ax.set_title(titled("Cost against coverage"))
    save(fig, out, "cost-vs-coverage.jpg")


def chart_two_scores(arms, out):
    fig, axes = plt.subplots(1, 2, figsize=(11, 1.2 + 0.7 * len(arms)), sharey=True)
    panels = (("Real defects found (our judge)", lambda s: recall(s) * 100),
              ("AACR references reproduced (benchmark metric)", lambda s: s["aacr_recall"] * 100))
    for ax, (title, f) in zip(axes, panels):
        for i, (name, color, s) in enumerate(arms):
            v = f(s)
            ax.barh(i, v, color=color, height=0.6)
            ax.text(v + 1.5, i, f"{v:.1f}%", va="center", fontsize=11)
        ax.set_xlim(0, 110)
        ax.xaxis.set_major_formatter(matplotlib.ticker.PercentFormatter())
        ax.grid(axis="x", color=GRID)
        ax.set_axisbelow(True)
        ax.set_title(title, fontsize=12)
    axes[0].set_yticks(range(len(arms)), [a[0] for a in arms])
    axes[0].invert_yaxis()
    fig.suptitle(titled("Same reviews, two scores"), x=0.01, y=1.0, ha="left", va="bottom", fontweight="bold", fontsize=14)
    fig.tight_layout(rect=(0, 0, 1, 0.97))
    save(fig, out, "two-scores.jpg")


def chart_references(out):
    tally = collections.Counter()
    for s in ("smoke10", "dev10", "holdout10"):
        for rows in json.load(open(os.path.join(HERE, "sets", f"{s}.labels.json")))["labels"].values():
            for r in rows:
                tally[r["reality"]] += 1
    order = [("real-defect", "Real defect", "#2E8B57"), ("real-maintainability", "Real maintainability", "#7FBF95"),
             ("trivial", "Trivial", "#C9CFD8"), ("dubious", "Dubious or wrong", "#DDE2E9"),
             ("duplicate", "Duplicate", "#E9ECF1")]
    n = sum(tally.values())
    fig, ax = plt.subplots(figsize=(10, 2.3))
    left = 0
    for key, lab, c in order:
        p = tally[key] / n * 100
        ax.barh(0, p, left=left, color=c, height=0.55, edgecolor=GROUND, linewidth=1.5)
        ax.text(left + p / 2, 0, f"{lab}\n{p:.0f}%", ha="center", va="center", fontsize=10)
        left += p
    ax.set_xlim(0, 100)
    ax.axis("off")
    real = (tally["real-defect"] + tally["real-maintainability"]) / n
    ax.set_title(f"What AACR-Bench's reference comments are — {n} on 30 PRs, agent-checked against the code: "
                 f"{real:.0%} real", fontsize=12)
    save(fig, out, "reference-quality.jpg")


def chart_split(arms_split, out):
    fig, ax = plt.subplots(figsize=(7, 0.9 + 0.75 * len(arms_split)))
    for i, (name, color, a, b) in enumerate(arms_split):
        ax.plot([a, b], [i, i], color=color, lw=3, zorder=2)
        ax.scatter([a], [i], s=90, facecolor=GROUND, edgecolor=color, linewidth=2.5, zorder=3)
        ax.scatter([b], [i], s=100, color=color, zorder=3)
        ax.text(a, i + 0.3, f"{a:.0f}%", ha="center", fontsize=9.5, color=MUTED)
        ax.text(b, i + 0.3, f"{b:.0f}%", ha="center", fontsize=9.5, fontweight="bold")
    ax.set_yticks(range(len(arms_split)), [a[0] for a in arms_split])
    ax.invert_yaxis()
    ax.set_xlim(30, 100)
    ax.xaxis.set_major_formatter(matplotlib.ticker.PercentFormatter())
    ax.grid(axis="x", color=GRID)
    ax.set_axisbelow(True)
    ax.set_title(titled("Holds on unseen PRs — ○ 40 tuning PRs  ● 145 unseen PRs"))
    save(fig, out, "tuned-vs-unseen.jpg")


def chart_overview(arms, out):
    """One image for sharing: the two headline comparisons side by side."""
    fig, axes = plt.subplots(1, 3, figsize=(15, 1.6 + 0.75 * len(arms)), gridspec_kw={"width_ratios": [1.3, 1, 1]})
    n = sum(arms[0][2]["total"].values())
    nh = arms[0][2]["total"].get("high", 0)
    panels = ((f"Real defects found (of {n})", lambda s: recall(s) * 100, "%"),
              (f"High-severity caught (of {nh})", lambda s: s["found"].get("high", 0) / max(nh, 1) * 100, "%"),
              ("AACR-Bench reference recall", lambda s: s["aacr_recall"] * 100, "%"))
    for k, (ax, (title, f, unit)) in enumerate(zip(axes, panels)):
        for i, (name, color, s) in enumerate(arms):
            v = f(s)
            ax.barh(i, v, color=color, height=0.62)
            ax.text(v + 1.5, i, f"{v:.0f}%" if k < 2 else f"{v:.1f}%", va="center", fontsize=11, fontweight="bold" if i == 0 else None)
        ax.set_xlim(0, 115)
        ax.set_xticks([])
        ax.spines["bottom"].set_visible(False)
        ax.set_title(title, fontsize=12)
        if k:
            ax.set_yticks([])
            ax.spines["left"].set_visible(False)
    axes[0].set_yticks(range(len(arms)), [a[0] for a in arms])
    axes[0].invert_yaxis()
    for ax in axes[1:]:
        ax.invert_yaxis()
    fig.tight_layout(rect=(0, 0, 1, 0.93))
    fig.suptitle(titled(f"Code review benchmark — AACR-Bench v1.0, {len(CASES)} PRs, 10 languages"), x=0.01, y=0.99,
                 ha="left", va="top", fontweight="bold", fontsize=15)
    save(fig, out, "overview.jpg")


def chart_judges(names, colors, a, b, la, lb, out):
    """Share of real defects found under two judges, side by side."""
    import numpy as np
    fig, ax = plt.subplots(figsize=(10, 1.2 + 0.62 * len(names)))
    y = np.arange(len(names))
    ax.barh(y - 0.19, a, height=0.36, color=colors, label=la)
    ax.barh(y + 0.19, b, height=0.36, color=[shade(c, 0.5) for c in colors], label=lb)
    for i in range(len(names)):
        ax.text(a[i] + 0.8, y[i] - 0.19, f"{a[i]:.0f}%", va="center", fontsize=9.5)
        ax.text(b[i] + 0.8, y[i] + 0.19, f"{b[i]:.0f}%", va="center", fontsize=9.5, color=MUTED)
    ax.set_yticks(y, names)
    ax.invert_yaxis()
    ax.set_xlim(0, 105)
    ax.xaxis.set_major_formatter(matplotlib.ticker.PercentFormatter())
    ax.grid(axis="x", color=GRID)
    ax.set_axisbelow(True)
    ax.set_title(f"Two judges, same reviews — share of real defects found (dark: {la}, light: {lb})", fontsize=12)
    save(fig, out, "judge-agreement.jpg")


def chart_independent(names, colors, all_r, ind_r, n_all, n_ind, out):
    import numpy as np
    fig, ax = plt.subplots(figsize=(10, 1.2 + 0.62 * len(names)))
    y = np.arange(len(names))
    ax.barh(y - 0.19, all_r, height=0.36, color=[shade(c, 0.5) for c in colors])
    ax.barh(y + 0.19, ind_r, height=0.36, color=colors)
    for i in range(len(names)):
        ax.text(all_r[i] + 0.8, y[i] - 0.19, f"{all_r[i]:.0f}%", va="center", fontsize=9.5, color=MUTED)
        ax.text(ind_r[i] + 0.8, y[i] + 0.19, f"{ind_r[i]:.0f}%", va="center", fontsize=9.5)
    ax.set_yticks(y, names)
    ax.invert_yaxis()
    ax.set_xlim(0, 105)
    ax.xaxis.set_major_formatter(matplotlib.ticker.PercentFormatter())
    ax.grid(axis="x", color=GRID)
    ax.set_axisbelow(True)
    ax.set_title(titled(f"Share found — light: all {n_all} defects; dark: the {n_ind} that the code hunt or an AACR reference also found (in the key without any reviewer)"),
                 fontsize=11)
    save(fig, out, "independent-defects.jpg")


def pick_best(rows):
    """The selection rule for the full comparison: highest defect recall; a tie
    goes to the higher share of correct comments."""
    return max(rows, key=lambda r: (sum(r[2]["found"].values()), r[2]["correct"]))


def chart_sensitivity(groups, reference, out):
    """Configuration sensitivity: per tool, the published configuration (hollow)
    and every variant run on the same PRs (filled, stem from the published
    value), the best by the selection rule in bold; the reference tool's
    published and best recall as dashed lines across the plot. Right panel:
    $/PR of the same rows, log scale."""
    import numpy as np
    ylabels, ys, y = [], [], 0
    rows = []  # (y, tool, variant, color, stats, published_stats, is_best)
    for k, (tool, variants) in enumerate(groups):
        color = PALETTE[0] if tool == reference else PALETTE[1 + (k % (len(PALETTE) - 1))]
        ylabels.append((y, tool, True))
        y += 1
        pub = variants[0][1]
        best = pick_best([(v, color, st) for v, st in variants]) if tool != reference else None
        for v, st in variants:
            rows.append((y, tool, v, color, st, pub, best is not None and best[0] == v))
            ylabels.append((y, v, False))
            y += 1
        y += 0.4
    fig, (ax, bx) = plt.subplots(1, 2, figsize=(13, 0.9 + 0.36 * y), sharey=True, gridspec_kw={"width_ratios": [2.1, 1]})
    ref_rows = [r for r in rows if r[1] == reference]
    if ref_rows:
        lines = [(recall(ref_rows[0][4]) * 100, f"{reference} {ref_rows[0][2]}")]
        top = max(ref_rows, key=lambda r: recall(r[4]))
        if top is not ref_rows[0]:
            lines.append((recall(top[4]) * 100, f"{reference} {top[2]}"))
        for x, lab in lines:
            ax.axvline(x, color=PALETTE[0], lw=1, ls=(0, (4, 3)), alpha=0.7, zorder=1)
    for (yy, tool, v, color, st, pub, is_best) in rows:
        r, r0 = recall(st) * 100, recall(pub) * 100
        first = st is pub
        if not first:
            ax.plot([r0, r], [yy, yy], color=shade(color, 0.45), lw=2.2, zorder=2)
            ax.scatter([r0], [yy], s=30, facecolor=GROUND, edgecolor=shade(color, 0.4), linewidth=1.2, zorder=3)
        ax.scatter([r], [yy], s=150 if is_best else 80, facecolor=GROUND if first else color, edgecolor=color,
                   linewidth=2, zorder=4)
        dd = round(r) - round(r0)
        d = "" if first else f"  ({dd:+d})" if dd else "  (±0)"
        ax.text(r + 1.8, yy, f"{r:.0f}%{d}", va="center", fontsize=10, fontweight="bold" if is_best else None,
                color=INK if (is_best or first) else MUTED)
        u = st["usd"]
        bx.scatter([u], [yy], s=150 if is_best else 80, facecolor=GROUND if first else color, edgecolor=color,
                   linewidth=2, zorder=4)
        bx.text(u * 1.18, yy, f"${u:.2f}", va="center", fontsize=9.5, color=INK if is_best else MUTED,
                fontweight="bold" if is_best else None)
    ax.set_yticks([p for p, _, _ in ylabels], [lab for _, lab, _ in ylabels])
    for t, (_, _, head) in zip(ax.get_yticklabels(), ylabels):
        if head:
            t.set_fontweight("bold")
            t.set_fontsize(11.5)
        else:
            t.set_color(MUTED)
            t.set_fontsize(10)
    ax.tick_params(axis="y", length=0)
    ax.set_ylim(y - 0.2, -0.8)
    ax.set_xlim(20, 104)
    ax.xaxis.set_major_formatter(matplotlib.ticker.PercentFormatter())
    ax.grid(axis="x", color=GRID)
    ax.set_axisbelow(True)
    ax.set_xlabel("share of real defects found")
    if ref_rows:
        for j, (x, lab) in enumerate(lines):
            ax.text(x + (0.6 if j else -0.6), -0.7, f"{lab} {x:.0f}%", ha="left" if j else "right", va="bottom",
                    fontsize=8.5, color=PALETTE[0])
    bx.set_xscale("log")
    bx.set_xlim(0.05, 6)
    bx.xaxis.set_major_formatter(matplotlib.ticker.FuncFormatter(lambda v, _: f"${v:g}"))
    bx.grid(axis="x", color=GRID)
    bx.set_axisbelow(True)
    bx.tick_params(axis="y", length=0)
    bx.set_xlabel("model cost per PR, list prices (log scale)")
    n = sum(rows[0][4]["total"].values())
    fig.suptitle(f"How much configuration moves each reviewer — {len(CASES)} PRs, {n} defects, one run per configuration",
                 x=0.01, y=1.0, ha="left", va="bottom", fontweight="bold", fontsize=14)
    fig.text(0.01, 0.995, "○ published configuration   ● variant (stem from the published value)   "
             "large ● the best configuration found for that tool", ha="left", va="top", fontsize=10, color=MUTED)
    fig.tight_layout(rect=(0, 0, 1, 0.975))
    save(fig, out, "config-sensitivity.jpg")


def defect_recall(runs_dir, runs, cases, judge_model, keys):
    v = compare.verdicts(runs_dir, runs, cases, judge_model)
    return sum(v.get(k, 0) for k in keys) / max(len(keys), 1) * 100


CASES = {}


def main():
    global CASES, SUFFIX, NOTE
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--cases", required=True, help="compare.py --cases syntax")
    ap.add_argument("--tuned", default="all30+fresh10", help="the tuning PRs, for the split chart")
    ap.add_argument("--unseen", default="rest145", help="the unseen PRs, for the split chart")
    ap.add_argument("--judge-model", default="gpt-6-sol-high")
    ap.add_argument("--second-judge", help="a second judge label (e.g. claude-opus-5-5) for the agreement chart")
    ap.add_argument("--runs-dir", default=os.environ.get("QCR_BENCH_RUNS_DIR", os.path.expanduser("~/qcr-bench-runs/runs") if os.path.isdir(os.path.expanduser("~/qcr-bench-runs/runs")) else os.path.join(HERE, "runs")))
    ap.add_argument("--out", default=os.path.join(HERE, "charts"))
    ap.add_argument("--sensitivity", action="store_true",
                    help="draw only config-sensitivity.jpg (+ config-sensitivity.json): arms are TOOL|VARIANT=runs, "
                         "a tool's first variant is its published configuration")
    ap.add_argument("--reference", default="QuickReview", help="with --sensitivity: the tool drawn as reference lines")
    ap.add_argument("--suffix", default="", help="appended to every output file name (charts and numbers.json), "
                    "e.g. -gpt6sol, so a second arm set is kept beside the first")
    ap.add_argument("--note", default="", help="a second title line on the headline charts (e.g. which model)")
    ap.add_argument("arms", nargs="+", help="NAME=run[,run...]")
    a = ap.parse_args()
    SUFFIX, NOTE = a.suffix, a.note
    os.makedirs(a.out, exist_ok=True)
    CASES = compare.cases_for(a.cases)
    if a.sensitivity:
        groups = collections.OrderedDict()
        for spec in a.arms:
            name, _, runs = spec.partition("=")
            tool, _, variant = name.partition("|")
            groups.setdefault(tool, []).append((variant or "published", arm_stats(a.runs_dir, runs.split(","), CASES, a.judge_model)))
        chart_sensitivity(list(groups.items()), a.reference, a.out)
        data = {}
        for tool, variants in groups.items():
            best = pick_best([(v, None, st) for v, st in variants])[0] if tool != a.reference else None
            data[tool] = [{"variant": v, "published": i == 0, "selected": v == best, "recall": round(recall(st), 4),
                           **{k: st[k] for k in ("found", "total", "correct", "usd", "median_min", "aacr_recall", "aacr_precision")}}
                          for i, (v, st) in enumerate(variants)]
        path = os.path.join(a.out, f"config-sensitivity{SUFFIX}.json")
        json.dump({"cases": sorted(CASES), "judge": a.judge_model, "arms": [spec for spec in a.arms], "tools": data},
                  open(path, "w"), indent=1)
        print("wrote", os.path.relpath(path))
        return
    tuned, unseen = compare.cases_for(a.tuned), compare.cases_for(a.unseen)
    arms, split = [], []
    for k, spec in enumerate(a.arms):
        name, _, runs = spec.partition("=")
        runs = runs.split(",")
        color = PALETTE[k % len(PALETTE)]
        arms.append((name, color, arm_stats(a.runs_dir, runs, CASES, a.judge_model)))
        split.append((name, color, recall(arm_stats(a.runs_dir, runs, tuned, a.judge_model)) * 100,
                      recall(arm_stats(a.runs_dir, runs, unseen, a.judge_model)) * 100))
    chart_overview(arms, a.out)
    chart_severity(arms, a.out)
    chart_high(arms, a.out)
    chart_cost(arms, a.out)
    chart_two_scores(arms, a.out)
    chart_references(a.out)
    chart_split(split, a.out)
    names = [n for n, _, _ in arms]
    colors = [c for _, c, _ in arms]
    run_lists = [spec.partition("=")[2].split(",") for spec in a.arms]
    if a.second_judge:
        chart_judges(names, colors, [recall(s) * 100 for _, _, s in arms],
                     [recall(arm_stats(a.runs_dir, r, CASES, a.second_judge)) * 100 for r in run_lists],
                     a.judge_model, a.second_judge, a.out)
    # The independence check: only defects the code hunt or an AACR reference surfaced.
    alld, indep = [], []
    for iid, (s, sevs, _) in CASES.items():
        truth = json.load(open(os.path.join(HERE, "defects", f"{s}.json")))["cases"][iid]
        for x in truth["defects"]:
            alld.append((iid, x["id"]))
            p = x.get("provenance") or {}
            if p.get("hunt") or p.get("dataset_refs"):
                indep.append((iid, x["id"]))
    all_r = [defect_recall(a.runs_dir, r, CASES, a.judge_model, alld) for r in run_lists]
    ind_r = [defect_recall(a.runs_dir, r, CASES, a.judge_model, indep) for r in run_lists]
    chart_independent(names, colors, all_r, ind_r, len(alld), len(indep), a.out)
    summary = {name: {"recall": round(recall(s), 4), **{k: s[k] for k in ("found", "total", "usd", "aacr_recall", "aacr_precision", "correct")},
                      "recall_tuned": round(sp[2] / 100, 4), "recall_unseen": round(sp[3] / 100, 4),
                      "recall_independent": round(ir / 100, 4)}
               for (name, _, s), sp, ir in zip(arms, split, ind_r)}
    path = os.path.join(a.out, f"numbers{SUFFIX}.json")
    json.dump({"cases": len(CASES), "judge": a.judge_model, "independent_defects": len(indep),
               "arms_spec": list(a.arms), "arms": summary}, open(path, "w"), indent=1)
    print("wrote", os.path.relpath(path))


if __name__ == "__main__":
    main()
