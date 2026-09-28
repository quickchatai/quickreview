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
NAME=runs argument. The "tuned vs unseen" chart splits the cases into the 40
PRs the review was tuned on (all30+fresh10) and the rest (rest145).
"""
import argparse, collections, json, os, sys

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
    usd = []
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
            u, _ = compare.usd_and_minutes(os.path.join(runs_dir, run, "cases", iid))
            usd.append(u)
            break
    refs, generated, scored, _ = compare.aacr(runs_dir, runs, cases)
    labels = compare.ref_labels()
    n_refs = sum(len(labels.get(iid, {})) for iid in cases) or len(refs)
    hit = sum(refs.values())
    return {
        "found": dict(found), "total": dict(total),
        "correct": ok_comments / max(all_comments, 1),
        "usd": sum(usd) / max(len(usd), 1),
        "aacr_recall": hit / max(n_refs, 1), "aacr_precision": hit / max(generated, 1),
    }


def recall(s):
    return sum(s["found"].values()) / max(sum(s["total"].values()), 1)


def save(fig, out, name):
    path = os.path.join(out, name)
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
    ax.set_title(f"Real defects found, by severity — {n} defects verified in the code")
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
    ax.set_title("High-severity defects caught (merge-blocking)")
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
    ax.set_title("Cost against coverage")
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
    fig.suptitle("Same reviews, two scores", x=0.01, y=1.0, ha="left", va="bottom", fontweight="bold", fontsize=14)
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
    ax.set_title(f"What AACR-Bench's reference comments are — {n} on 30 PRs, hand-checked against the code: "
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
    ax.set_title("Holds on unseen PRs — ○ 40 tuning PRs  ● 145 unseen PRs")
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
    fig.suptitle(f"Code review benchmark — AACR-Bench v1.0, {len(CASES)} PRs, 10 languages", x=0.01, y=0.99,
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
    ax.set_title(f"Share found — light: all {n_all} defects; dark: the {n_ind} that the code hunt or an AACR reference also found (in the key without any reviewer)",
                 fontsize=11)
    save(fig, out, "independent-defects.jpg")


def defect_recall(runs_dir, runs, cases, judge_model, keys):
    v = compare.verdicts(runs_dir, runs, cases, judge_model)
    return sum(v.get(k, 0) for k in keys) / max(len(keys), 1) * 100


CASES = {}


def main():
    global CASES
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--cases", required=True, help="compare.py --cases syntax")
    ap.add_argument("--tuned", default="all30+fresh10", help="the tuning PRs, for the split chart")
    ap.add_argument("--unseen", default="rest145", help="the unseen PRs, for the split chart")
    ap.add_argument("--judge-model", default="gpt-6-sol-high")
    ap.add_argument("--second-judge", help="a second judge label (e.g. claude-opus-5-5) for the agreement chart")
    ap.add_argument("--runs-dir", default=os.environ.get("QCR_BENCH_RUNS_DIR", os.path.expanduser("~/qcr-bench-runs/runs") if os.path.isdir(os.path.expanduser("~/qcr-bench-runs/runs")) else os.path.join(HERE, "runs")))
    ap.add_argument("--out", default=os.path.join(HERE, "charts"))
    ap.add_argument("arms", nargs="+", help="NAME=run[,run...]")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    CASES = compare.cases_for(a.cases)
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
    chart_independent(names, colors, [defect_recall(a.runs_dir, r, CASES, a.judge_model, alld) for r in run_lists],
                      [defect_recall(a.runs_dir, r, CASES, a.judge_model, indep) for r in run_lists],
                      len(alld), len(indep), a.out)
    summary = {name: {"recall": round(recall(s), 4), **{k: s[k] for k in ("found", "total", "usd", "aacr_recall", "aacr_precision", "correct")}} for name, _, s in arms}
    json.dump({"cases": len(CASES), "arms": summary}, open(os.path.join(a.out, "numbers.json"), "w"), indent=1)
    print("wrote", os.path.relpath(os.path.join(a.out, "numbers.json")))


if __name__ == "__main__":
    main()
