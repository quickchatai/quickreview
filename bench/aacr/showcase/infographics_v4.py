"""v4 infographics: how each benchmark was run and scored, and how QuickReview works.

Each figure is a Page4, like the charts:
- a title that is the takeaway;
- one line saying what the picture shows;
- the drawing, made from diagram_v4's parts;
- one source line.
Every count drawn here (PRs, defects, reviewers, tools) is read from the same data
files the charts use, so a new run updates the pictures too. Labels name only
what the code and the bench docs say. FIGURES maps each name to its function;
make_charts_v4.py renders them with the charts.
"""
from diagram_v4 import arrow, badge, group, node, path_arrow, pill
from theme_v4 import Page4

QR = "quickreview"


# ---------------------------------------------------------------- benchmarks: how they were run
def fig_how_aacr(B, V, T):
    """The AACR-Bench comparison, end to end: PRs -> one sandbox -> reviews -> one judge + the key -> scores."""
    p = Page4(T)
    tools = B.aacr_tools()
    n_prs = B.aacr["cases"]
    p.title("Same PRs, same sandbox, one judge for all")
    p.metric(f"How the AACR-Bench comparison was run: {len(tools)} reviewers on the same {n_prs} pull requests")
    top, bottom = 170, 590
    mid = 420
    bw, bh = 168, 108
    # 1. the pull requests
    node(p, 64, mid - bh / 2, bw, bh, f"{n_prs} real PRs", "10 languages", icon_name="pr", num=1)
    # 2. the sandbox: one row per reviewer
    gx, gw = 262, 232
    group(p, gx, top, gw, bottom - top, "Same sandbox")
    badge(p, gx, top, 2)
    order = [QR] + [t for t in tools if t != QR]
    pitch = (bottom - top - 78) / len(order)
    for i, t in enumerate(order):
        node(p, gx + 16, top + 40 + i * pitch, gw - 32, pitch - 10, B.name(t),
             style="qr-solid" if t == QR else "plain", size=13, radius=8)
    p.text(gx + gw / 2, bottom - 14, "read-only · nothing posted", size=11, color=T["muted"], ha="center",
           va="baseline")
    arrow(p, (64 + bw + 2, mid), (gx - 2, mid))
    # 3. the reviews
    x3 = gx + gw + 34
    node(p, x3, mid - bh / 2, 150, bh, "Reviews", "every comment", icon_name="chat", num=3)
    arrow(p, (gx + gw + 2, mid), (x3 - 2, mid))
    # 4. the key, above 5. the judge
    x4 = x3 + 150 + 34
    kw = 214
    node(p, x4, top, kw, 146, f"{B.total()} defects", f"checked in the code\n{B.total({'high'})}\u00a0high · "
         f"{B.total({'medium'})}\u00a0medium · {B.total({'low'})}\u00a0low", icon_name="list", num=4)
    node(p, x4, mid - bh / 2, kw, bh, "One judge", "same model grades all", icon_name="judge", num=5)
    arrow(p, (x4 + kw / 2, top + 148), (x4 + kw / 2, mid - bh / 2 - 2))
    arrow(p, (x3 + 152, mid), (x4 - 2, mid))
    # 6. the scores
    x6 = x4 + kw + 34
    node(p, x6, mid - bh / 2, p.w - 64 - x6, bh, "Scores", "share found; cost; time",
         icon_name="chart", num=6, style="qr")
    arrow(p, (x4 + kw + 2, mid), (x6 - 2, mid))
    for i, (txt, val) in enumerate((("found", "1"), ("partly found", "½"), ("missed", "0"))):
        pill(p, x6 + (p.w - 64 - x6) / 2, mid + bh / 2 + 30 + i * 34, f"{txt} = {val}", ha="center")
    p.source("AACR-Bench: Alibaba's public code-review dataset. Every reviewer ran once per PR in the same locked-down "
             "container, with no GitHub access.\nOpenAI-based tools on gpt-6.1-sol, Claude Code on Opus 5.5. One judge, "
             "gpt-6-sol at high reasoning, grades every reviewer.")
    return p


# ---------------------------------------------------------------- the system: how QuickReview works
def fig_system_overview(B, V, T):
    """How a pull request gets reviewed, from the GitHub event to the posted review, and the loop back."""
    p = Page4(T, h=700)
    p.title("How QuickReview reviews a pull request")
    p.metric("Plain code decides when to review, AI does the reading, and every GitHub write passes one gate")
    y1, h1 = 210, 166
    xs = [64 + i * 156 for i in range(7)]
    w = 134
    steps = [
        ("Pull request", "label or team request", "pr", "ghost"),
        ("Scheduler", "plain code, no AI", "gear", "plain"),
        ("Review session", "one AI chat per PR", "chat", "qr"),
        ("Lenses", "specialists in parallel", "search", "qr"),
        ("Validator", "re-checks every finding", "judge", "qr"),
        ("One gate", "every GitHub write", "shield", "plain"),
        ("Review", "comments and a verdict", "doc", "qr-solid"),
    ]
    group(p, xs[1] - 14, y1 - 46, xs[5] + w - xs[1] + 28, h1 + 70, "QuickReview", qr=True)
    for i, (x, (label, note, ic, st)) in enumerate(zip(xs, steps)):
        node(p, x, y1, w, h1, label, note, icon_name=ic, icon_top=True, style=st, size=14, note_size=11.5,
             num=i + 1)
        if i:
            arrow(p, (xs[i - 1] + w + 2, y1 + h1 / 2), (x - 2, y1 + h1 / 2))
    # the loop back: what people do with the comments becomes lessons
    y2, h2 = 466, 158
    loop = [
        (xs[6], "Your team", "fixes, replies, dismissals", "people", "ghost"),
        (xs[4] + 70, "Outcomes", "what became of each comment", "list", "plain"),
        (xs[2] + 70, "Daily learning", "turns outcomes into lessons", "loop", "plain"),
        (xs[0] + 40, "Memory", "lessons for the next review", "db", "plain"),
    ]
    for x, label, note, ic, st in loop:
        node(p, x, y2, w + 20 if x != xs[6] else w, h2, label, note, style=st, size=14, note_size=11.5,
             icon_name=ic, icon_top=True)
    arrow(p, (xs[6] + w / 2, y1 + h1 + 2), (xs[6] + w / 2, y2 - 2))
    for (xa, *_), (xb, *_) in zip(loop, loop[1:]):
        arrow(p, (xa - 2, y2 + h2 / 2), (xb + w + 22, y2 + h2 / 2))
    path_arrow(p, [(xs[0] + 40 + (w + 20) / 2, y2 - 2), (xs[0] + 40 + (w + 20) / 2, y1 + h1 + 40),
                   (xs[2] + w / 2, y1 + h1 + 40), (xs[2] + w / 2, y1 + h1 + 2)], dashed=True)
    p.source("A review starts on a label or a request to the review team. Every session runs in one container; an "
             "overseer session watches for anomalies.\nThe review session keeps one conversation per PR across rounds, "
             "so later rounds see what was already said.")
    return p


FIGURES = {
    "how-aacr": fig_how_aacr,
    "system-overview": fig_system_overview,
}
# The rest of the library, one file per group, each built from the same parts.
import info_bench_v4, info_platform_v4, info_system_v4  # noqa: E402

FIGURES.update({**info_bench_v4.FIGURES, **info_system_v4.FIGURES, **info_platform_v4.FIGURES})
