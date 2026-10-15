"""v5 infographics: v4's, with the models named in the words and read from the runs.

The drawings are v4's (infographics_v4.py and the three info_*_v4.py files), reused as they are. v5 changes the
words on the images that name a model or show a count from a run, and one drawing:
- how-aacr, how-fair, how-martian, how-qodo: every reviewer's and judge's model by its display name
  (data/models.json), read from data/v5.json. how-fair also names the model of the best-shot selection runs behind
  its "lifted 3 rivals", and how-martian the model of the golden audit's investigators (from the audit's own doc);
- how-key: which run seeded the key (QuickReview's default run, its build and model), the model of every reviewer
  run whose comments the key's builders checked (a third line of small print), and the builders' model;
- review-round: whose counts these are (QuickReview's frozen build and its model), which judge graded them, and the
  median number of lenses that build ran per PR. v4 printed 15 and drew 15 lens chips; the build's own runs say 11,
  so v5 draws 11.
Each word change quotes the v4 words it replaces and must find them in exactly one text of the image. If v4's
wording ever moves, this stops instead of drawing an image that still says the old thing. The layout checks
(overflow, margins, the small print) run on the result as they do on every image.
"""
import math
import statistics
import sys

from matplotlib.lines import Line2D
from matplotlib.patches import Circle, FancyBboxPatch

import infographics_v4
import info_system_v4
from diagram_v4 import icon

QR = "quickreview"
LIFTED = {"codex-cli", "opencode", "pi-review"}  # how-fair's "lifted 3 rivals": 44->56, 52->68, 43->60 (bench docs)
AUDITORS = "claude-opus-5-5"  # GOLDEN-AUDIT-FULL.md: "One independent investigator per golden comment (Claude Opus 5.5
# subagents ...)"; the key's builders likewise (paper/benchmark.tex). No run records either.


def retext(fn, swaps, after=None):
    """fn's v4 drawing with words swapped: swaps(B, V) -> [(v4 words, v5 words)], each found in exactly one text;
    then after(p, B, V, T), when given, for a change that is not a word swap."""
    def draw(B, V, T):
        p = fn(B, V, T)
        for old, new in swaps(B, V):
            hits = [t for t in p.c.texts if old in t.get_text()]
            if len(hits) != 1:
                sys.exit(f"{fn.__name__}: {old!r} is in {len(hits)} texts of the v4 image, not exactly 1")
            hits[0].set_text(hits[0].get_text().replace(old, new))
        if after:
            after(p, B, V, T)
        return p
    draw.__name__ = fn.__name__
    return draw


def one_more_line(p, text):
    """A line of small print under v4's: its lines move up one step of Page4.source's 17 px ladder."""
    import make_charts_v5 as M  # here: it imports this module
    for t in [t for t in p.c.texts if M.is_small_print(p, t)]:
        x, y = t.get_position()
        t.set_position((x, y - 17))
    p.source(text)


def how_aacr(B, V):
    name, effort = V.judge("aacr")
    return [("OpenAI-based tools on gpt-6.1-sol, Claude Code on Opus 5.5. One judge, gpt-6-sol at high reasoning, "
             "grades every reviewer.",
             f"Reviewers: {V.reviewers('aacr', B.aacr_tools())}. One judge, {name} at {effort} reasoning, grades every "
             "reviewer.")]


def how_fair(B, V):
    name, effort = V.judge("aacr")
    others = [t for t in B.aacr_tools() if t != "claude-code"]
    if len({V.our_model("aacr", t) for t in others}) != 1:
        sys.exit("how-fair: the reviewers other than Claude Code no longer share one model; reword its row")
    return [("gpt-6-sol, high reasoning", f"{name}, {effort} reasoning"),
            ("Claude Code on Opus 5.5", f"{len(others)} on {V.our_model('aacr', QR)}; Claude Code on "
             f"{V.our_model('aacr', 'claude-code')}"),
            ("lifted 3 rivals 12–17 pts", f"lifted 3 rivals 12–17 pts on {V.best_shot(LIFTED)}")]


def how_key(B, V):
    seed_model, seed_build = V.key_seed()
    return [("(Claude Code subagents on Opus 5.5)", f"(Claude Code subagents on {V.model_name(AUDITORS)})"),
            ("QuickReview's earlier comments raised",
             f"An earlier QuickReview run (default, build {seed_build} on {seed_model}) raised")]


def raise_banner(p, claim, dy):
    """The verdict banner whose bold claim is `claim` (info_bench_v4.verdict: a band, a tick or cross, the claim and
    its aside), moved dy px up."""
    hits = [t for t in p.c.texts if t.get_text() == claim]
    if len(hits) != 1:
        sys.exit(f"{claim!r} is in {len(hits)} texts, not exactly 1")
    cx, cy = hits[0].get_position()
    band = [a for a in p.c.patches if isinstance(a, FancyBboxPatch)
            and a.get_x() <= cx <= a.get_x() + a.get_width() and a.get_y() <= cy <= a.get_y() + a.get_height()]
    if len(band) != 1:
        sys.exit(f"the banner of {claim!r} is not one band")
    x0, y0, x1, y1 = band[0].get_x(), band[0].get_y(), band[0].get_x() + band[0].get_width(), \
        band[0].get_y() + band[0].get_height()
    within = lambda x, y: x0 <= x <= x1 and y0 <= y <= y1  # noqa: E731
    texts = [t for t in p.c.texts if within(*t.get_position())]
    marks = [ln for ln in p.c.lines if all(within(x, y) for x, y in ln.get_xydata())]
    if len(texts) != 2 or len(marks) not in (1, 2):  # the claim and its aside; a tick is one line, a cross two
        sys.exit(f"the banner of {claim!r} no longer holds a claim, an aside and a mark")
    band[0].set_y(y0 - dy)
    for t in texts:
        x, y = t.get_position()
        t.set_position((x, y - dy))
    for ln in marks:
        ln.set_ydata([y - dy for y in ln.get_ydata()])


def key_sources(p, B, V, T):
    raise_banner(p, "No human check yet", 12)  # the room the third line of small print takes under it
    one_more_line(p, f"Every reviewer comment checked came from earlier runs: {V.key_sources()}.")


def how_martian(B, V):
    name, effort = V.judge("martian")
    return [("QuickReview: frozen build, judged by gpt-6.1-sol at low reasoning.",
             f"QuickReview: frozen build on {V.our_model('martian', QR)}; our judge: {name}, {effort} reasoning."),
            ("one AI investigator per golden", f"one AI investigator ({V.model_name(AUDITORS)}) per golden")]


def how_qodo(B, V):
    ran = [t for t, _, _ in V.qodo_rows() if V.model("qodo", t)]
    models = sorted({V.our_model("qodo", t) for t in ran})
    if len(models) != 1:
        sys.exit("how-qodo: the reviewers we ran on Qodo no longer share one model; reword its small print")
    name, effort = V.judge("qodo")
    return [("Ours, offline: gpt-6.1-sol,", f"Ours, offline, on {models[0]}:"),
            ("One judge, gpt-6.1-sol at low reasoning,", f"One judge of ours, {name} at {effort} reasoning,")]


def funnel(V):
    """The review-round counts (data/v3.json idea-funnel), checked to be QuickReview's frozen build's runs."""
    f = V.v3["ideas"]["idea-funnel"]
    if f["tool"] != QR or f["runs"] != V.runs["aacr"]["reviewers"][QR]["runs"]:
        sys.exit("review-round: its counts are no longer QuickReview's frozen build (data/v3.json idea-funnel)")
    return f


def median_lenses(V):
    return statistics.median(p["lenses"] for p in funnel(V)["prs"].values())


def review_round(B, V):
    n = len(funnel(V)["prs"])
    return [(f"Counts: mean per PR over the {n} AACR-Bench PRs; \"judged correct\" is the benchmark judge's grade.",
             f"QuickReview's frozen build on {V.our_model('aacr', QR)}, mean per PR on {n} AACR-Bench PRs; "
             f"\"judged correct\": the benchmark judge ({V.judge_words('aacr')})."),
            ("median 15", f"median {median_lenses(V):g}")]


def lens_chips(p, B, V, T):
    """The lens grid redrawn with the median's chips: v4 drew 15 (3 rows of 5) for its 'median 15'. The chips keep
    v4's three rows, as many columns as that takes, centred where v4's grid was; the coverage check's two dashed
    chips and their word move onto the new columns."""
    n = math.floor(median_lenses(V))
    s, g = 22, 7  # v4's chip and gap
    chips = [a for a in p.c.patches if isinstance(a, FancyBboxPatch) and (a.get_width(), a.get_height()) == (s, s)]
    solid = [a for a in chips if a.get_facecolor()[3] > 0]
    dashed = [a for a in chips if a.get_facecolor()[3] == 0]
    boxes = [(a.get_x(), a.get_y(), a.get_x() + s, a.get_y() + s) for a in solid]
    inside = lambda x, y: any(x0 <= x <= x1 and y0 <= y <= y1 for x0, y0, x1, y1 in boxes)  # noqa: E731
    glass = [a for a in p.c.patches if isinstance(a, Circle) and inside(*a.center)]
    handle = [ln for ln in p.c.lines if isinstance(ln, Line2D) and all(inside(x, y) for x, y in ln.get_xydata())]
    word = [t for t in p.c.texts if t.get_text() == "coverage"]
    if (len(solid), len(dashed), len(glass), len(handle), len(word)) != (15, 2, 15, 15, 1):
        sys.exit("review-round: v4's lens grid is no longer 15 chips with their icons over 2 dashed ones")
    if not 1 <= n <= 15:
        sys.exit(f"review-round: a median of {n} lenses does not fit v4's grid (at most 15)")
    for a in solid + glass + handle:
        a.remove()
    x0, y0 = min(b[0] for b in boxes), min(b[1] for b in boxes)
    cols = math.ceil(n / 3)
    nx0 = x0 + (5 * s + 4 * g) / 2 - (cols * s + (cols - 1) * g) / 2  # the same centre as v4's 5 columns
    for i in range(n):
        x, y = nx0 + (i % cols) * (s + g), y0 + (i // cols) * (s + g)
        info_system_v4.chip(p, x, y, s, s)
        icon(p, "search", x + s / 2, y + s / 2, 12, color=T["qr"], lw=1.3)
    for a in dashed:
        a.set_x(a.get_x() + nx0 - x0)
    x, y = word[0].get_position()
    word[0].set_position((x + nx0 - x0, y))


V4 = infographics_v4.FIGURES
FIGURES = dict(V4)
FIGURES.update({
    "how-aacr": retext(V4["how-aacr"], how_aacr),
    "how-fair": retext(V4["how-fair"], how_fair),
    "how-key": retext(V4["how-key"], how_key, after=key_sources),
    "how-martian": retext(V4["how-martian"], how_martian),
    "how-qodo": retext(V4["how-qodo"], how_qodo),
    "review-round": retext(V4["review-round"], review_round, after=lens_chips),
})
