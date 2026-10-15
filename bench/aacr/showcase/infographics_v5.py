"""v5 infographics: v4's, with the models named in the words and read from the runs.

The drawings are v4's (infographics_v4.py and the three info_*_v4.py files), reused as they are. v5 changes only
words, on the six images that name a model or show a count from QuickReview's runs:
- how-aacr, how-fair, how-martian, how-qodo: every reviewer's and judge's model by its display name
  (data/models.json), read from data/v5.json;
- how-key: which build and model seeded the key (the run behind "334 of the first 379"), and the builders' model by
  its display name;
- review-round: whose counts these are (QuickReview's frozen build and its model), which judge graded them, and the
  median number of lenses that build ran per PR (v4 printed 15; the build's own runs say otherwise).
Each change quotes the v4 words it replaces and must find them in exactly one text of the image. If v4's wording ever
moves, this stops instead of drawing an image that still says the old thing. The layout checks (overflow, margins,
the small print) run on the result as they do on every image.
"""
import statistics
import sys

import infographics_v4

QR = "quickreview"


def retext(fn, swaps):
    """fn's v4 drawing with words swapped: swaps(B, V) -> [(v4 words, v5 words)], each found in exactly one text."""
    def draw(B, V, T):
        p = fn(B, V, T)
        for old, new in swaps(B, V):
            hits = [t for t in p.c.texts if old in t.get_text()]
            if len(hits) != 1:
                sys.exit(f"{fn.__name__}: {old!r} is in {len(hits)} texts of the v4 image, not exactly 1")
            hits[0].set_text(hits[0].get_text().replace(old, new))
        return p
    draw.__name__ = fn.__name__
    return draw


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
            ("Claude Code on Opus 5.5", f"{V.our_model('aacr', QR)}; Claude Code on {V.our_model('aacr', 'claude-code')}")]


def how_key(B, V):
    seed_model, seed_build = V.key_seed()
    # the builders are Claude Code subagents (bench docs, not a run): only their model's display name changes
    return [("(Claude Code subagents on Opus 5.5)", f"(Claude Code subagents on {V.model_name('claude-opus-5-5')})"),
            ("QuickReview's earlier comments raised",
             f"QuickReview's earlier comments (build {seed_build} on {seed_model}) raised")]


def how_martian(B, V):
    name, effort = V.judge("martian")
    return [("QuickReview: frozen build, judged by gpt-6.1-sol at low reasoning.",
             f"QuickReview: frozen build on {V.our_model('martian', QR)}; our judge: {name}, {effort} reasoning.")]


def how_qodo(B, V):
    ran = [t for t, _, _ in V.qodo_rows() if V.model("qodo", t)]
    models = sorted({V.our_model("qodo", t) for t in ran})
    if len(models) != 1:
        sys.exit("how-qodo: the reviewers we ran on Qodo no longer share one model; reword its small print")
    name, effort = V.judge("qodo")
    return [("Ours, offline: gpt-6.1-sol,", f"Ours, offline, on {models[0]}:"),
            ("One judge, gpt-6.1-sol at low reasoning,", f"One judge of ours, {name} at {effort} reasoning,")]


def review_round(B, V):
    funnel = V.v3["ideas"]["idea-funnel"]
    if funnel["tool"] != QR or funnel["runs"] != V.runs["aacr"]["reviewers"][QR]["runs"]:
        sys.exit("review-round: its counts are no longer QuickReview's frozen build (data/v3.json idea-funnel)")
    lenses = statistics.median(p["lenses"] for p in funnel["prs"].values())
    name, effort = V.judge("aacr")
    return [("Counts: mean per PR over the", f"Counts: QuickReview's frozen build on {V.our_model('aacr', QR)}, mean "
             "per PR over the"),
            ("is the benchmark judge's grade.", f"is our judge's grade ({name}, {effort})."),
            ("median 15", f"median {lenses:g}")]


V4 = infographics_v4.FIGURES
FIGURES = dict(V4)
FIGURES.update({
    "how-aacr": retext(V4["how-aacr"], how_aacr),
    "how-fair": retext(V4["how-fair"], how_fair),
    "how-key": retext(V4["how-key"], how_key),
    "how-martian": retext(V4["how-martian"], how_martian),
    "how-qodo": retext(V4["how-qodo"], how_qodo),
    "review-round": retext(V4["review-round"], review_round),
})
