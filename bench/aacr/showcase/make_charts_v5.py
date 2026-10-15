#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["matplotlib>=3.8", "markdown>=3.5"]
# ///
"""Showcase graphics v5: v4's library, with the model named beside every QuickReview result.

    uv run bench/aacr/showcase/make_charts_v5.py                # every image, both themes, NUMBERS.md, the pages
    uv run bench/aacr/showcase/make_charts_v5.py martian-recall # one image (names: --list)

QuickReview now runs on more than one model. The benchmark has an open-model arm (GLM-5.3 Flash ran first, and
more are coming), so a bare "QuickReview" result is ambiguous. v5 draws v4's images with:
- QuickReview's own label naming its model, e.g. "QuickReview (GPT-6.1 Sol)";
- the small print naming the judge's model and every other reviewer's we ran, and saying which build QuickReview's
  numbers are;
- the pages naming the model in their text, beside every image, and NUMBERS.md opening with every drawn run, its
  model, reasoning effort and build.
Every model an image names comes from a data file:
- data/v5.json, which refresh_v5.py reads from the runs, down to the models their event logs record;
- the display names in data/models.json;
- Martian's judge from Martian's own dashboard (data/v4.json).
The one exception is the AACR key's builders, which no run records; how-key names them from the bench docs.

v1-v4 are untouched. v4's chart functions are reused where only a name changes, since they read every name through
V, and a V5 names the models. The rest are redrawn here: name columns sized to the longest label, small print
wrapped to the width (measured) with the chart above it making room. infographics_v5.py and value_v5.py do the same
for the infographics and the bug-value charts.
"""
import argparse, json, math, os, statistics, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import logging  # noqa: E402

logging.getLogger("matplotlib.font_manager").setLevel(logging.ERROR)
import make_charts_v4 as v4  # noqa: E402
import theme_v2  # noqa: E402
import theme_v4 as theme  # noqa: E402
from diagram_v4 import lines, measure  # noqa: E402
from make_charts import QR, Bench, pct  # noqa: E402  (v1's data layer)
from make_charts_v4 import (AACR_LINE, FAST, MARTIAN_JUDGE, MARTIAN_NAMES, MARTIAN_SEVS, OCT1, QODO_RULE,  # noqa: E402
                            QODO_STRICT, SEVS, SHARE_CSS, SHARE_JS, aacr_order, accent, embed, labelled_dots, md_table,
                            ordinal, pareto, pct1, rank, standings)
from theme_v4 import Page4, axis_frame, bar_rows, save, table  # noqa: E402

OUT = os.path.join(HERE, "out", "v5")
EFFORTS = ["off", "none", "minimal", "low", "medium", "high", "xhigh", "max"]  # refresh_v5.py's list, lowest first
BENCHES = {"aacr": "AACR-Bench", "martian": "Martian", "qodo": "Qodo"}
TUNED_PRS = "121 of these PRs"  # bench docs: QuickReview's lenses were mined from 121 AACR PRs
TUNED = f"tuned on misses from {TUNED_PRS}"
FAST_PROFILE = "its fast profile (fewer lenses, shorter comments)"  # profiles/fast on the frozen build (RESULTS.md)
SMALL_INK = {"light": "#73716c"}  # the small print, 4.75:1 on the light surface (v4's muted is 3.5:1); dark keeps 4.85:1
WIDTH = 1072  # the text column: the canvas minus v4's 64 px side margins
SMALL = 10.5  # Page4.source's size
STUB = 0.3  # a paragraph's last line shorter than this share of the width takes words from the line above


def cap(s):
    return s[:1].upper() + s[1:]


def and_join(xs):
    xs = list(xs)
    return xs[0] if len(xs) == 1 else ", ".join(xs[:-1]) + " and " + xs[-1]


_measure, _whole = [], []


def keep_whole(text):
    """text with no-break spaces inside the phrases a line break must not split: every model's display name
    (data/models.json) and the tuning count. diagram_v4.lines breaks only at a plain space."""
    if not _whole:
        names = json.load(open(os.path.join(HERE, "data", "models.json")))["models"]
        _whole.extend(sorted({m["name"] for m in names.values()} | {TUNED_PRS}, key=len, reverse=True))
    for phrase in _whole:
        text = text.replace(phrase, phrase.replace(" ", "\u00a0"))
    return text


def wrap(text, size=SMALL, width=WIDTH):
    """text in lines that fit `width` px at `size` pt, measured by the renderer; explicit newlines kept, no model's
    name split, and no paragraph ending on a stub (a last line under STUB of the width takes words from the line
    above, the paragraph keeping its number of lines). Called while drawing, so the theme's fonts are set (both
    themes use the same ones)."""
    if not _measure:
        _measure.append(Page4(theme_v2.THEMES["light"], w=100, h=100))
    p, out = _measure[0], []
    for para in keep_whole(text).split("\n"):
        best, w = lines(p, para, width, size), width
        while len(best) > 1 and measure(p, best[-1], size) < STUB * width and w > width / 2:
            w -= 16
            narrower = lines(p, para, w, size)
            if len(narrower) > len(best):
                break
            best = narrower
        out += best
    return "\n".join(out)


def extra(src):
    """The px a chart gives up to small print longer than v4's two lines."""
    return 17 * max(0, src.count("\n") - 1)


class V5(v4.V4):
    """v4's data, plus which model every drawn run used (data/v5.json) and its display name (data/models.json)."""

    def __init__(self, B):
        super().__init__(B)
        j = lambda n: json.load(open(os.path.join(HERE, "data", n)))  # noqa: E731
        self.runs = j("v5.json")
        self.names = j("models.json")["models"]
        self.check_runs()

    def check_runs(self):
        """data/v5.json must describe the very runs whose numbers are drawn; stop if a refresh is stale."""
        a, q, r = self.runs["aacr"]["reviewers"], self.runs["qodo"]["reviewers"], self.runs["martian"]["reviewers"]
        stale = []
        for t, arm in self.v3["arms"].items():
            if a.get(t, {}).get("runs") != arm["runs"]:
                stale.append(f"aacr {t}: data/v3.json {arm['runs']} vs data/v5.json {a.get(t, {}).get('runs')}")
        for t, rv in self.B.aacr["reviewers"].items():
            if a.get(t, {}).get("runs") != rv["runs"]:
                stale.append(f"aacr {t}: data/aacr.json {rv['runs']} vs data/v5.json {a.get(t, {}).get('runs')}")
        for t, tool in self.B.qodo["tools"].items():
            run = tool["source"].split(".qodo")[0]
            if t in q and q[t]["runs"] != [run]:
                stale.append(f"qodo {t}: data/qodo.json {run} vs data/v5.json {q[t]['runs']}")
        if r["quickreview"]["runs"] != [self.m["quickreview"]["run"]]:
            stale.append(f"martian: data/v4.json {self.m['quickreview']['run']} vs data/v5.json {r['quickreview']['runs']}")
        if not (self.B.aacr["judge"] == self.v3["judge"] == "-".join((self.runs["aacr"]["judge"]["model"],
                                                                        self.runs["aacr"]["judge"]["effort"]))):
            stale.append("aacr judge: data/aacr.json, data/v3.json and data/v5.json disagree")
        if stale:
            sys.exit("data/v5.json does not describe the drawn runs (rerun refresh_v5.py, or the refresh it names):\n  "
                     + "\n  ".join(stale))

    # ---- which model
    def model_name(self, mid):
        return self.names[mid]["name"]

    def model(self, bench, t):
        """The model a reviewer we ran used on `bench`, by name ("GPT-6.1 Sol"); None for a vendor's own run."""
        r = self.runs[bench]["reviewers"].get(t)
        return " + ".join(self.model_name(m) for m in r["models"]) if r else None

    def our_model(self, bench, t):
        """model(), for a reviewer we ran: stops rather than print a model it has no run for."""
        m = self.model(bench, t)
        if m is None:
            sys.exit(f"{bench} {t}: no run in data/v5.json names its model")
        return m

    def reasoning(self, bench, t):
        """Its reasoning effort(s), lowest first: "medium/high", "low"; "" when the run records none."""
        return "/".join(sorted(self.runs[bench]["reviewers"][t]["efforts"], key=EFFORTS.index))

    def builds(self, bench, t=QR):
        return self.runs[bench]["reviewers"][t].get("builds", [])

    def judge(self, bench):
        """(the judge's model by name, its reasoning effort)."""
        j = self.runs[bench]["judge"]
        return self.model_name(j["model"]), j["effort"]

    def judge_words(self, bench):
        name, effort = self.judge(bench)
        return f"{name}, {effort} reasoning"

    def official_judge(self):
        """AACR-Bench's own score's judge: (name, effort, rounds)."""
        j = self.runs["aacr"]["official_judge"]
        return self.model_name(j["model"]), j["effort"], j["rounds"]

    def key_seed(self):
        """The run whose comments seeded the AACR key: (model by name, build)."""
        k = self.runs["aacr"]["key_seed"]
        return " + ".join(self.model_name(m) for m in k["models"]), "/".join(k["builds"])

    def key_sources(self):
        """The runs whose comments the key's builders checked, as reviewers() words it: "all on GPT-6 Sol except
        Claude Code (Claude Opus 5.5)"."""
        src = self.runs["aacr"]["key_sources"]
        return self.grouped([(self.run_name(who), " + ".join(self.model_name(m) for m in r["models"]))
                             for who, r in src.items()], "the key's sources")

    def best_shot(self, tools):
        """The model every best-shot selection run of these tools (refresh_v5 ids) used, by name; stops if they
        differ."""
        ms = {m for r in self.runs["aacr"]["best_shot"].values() if r["tool"] in tools for m in r["models"]}
        if len(ms) != 1:
            sys.exit(f"best-shot runs of {sorted(tools)}: {sorted(ms) or 'none'}, not one model")
        return self.model_name(ms.pop())

    def tagged(self, name, bench, t):
        """A QuickReview label with its model: "QuickReview (GPT-6.1 Sol)"."""
        return f"{name} ({self.our_model(bench, t)})"

    def reviewers(self, bench, tools):
        """What the reviewers we ran used, as one phrase: "all on GPT-6.1 Sol except Claude Code (Claude Opus 5.5)",
        or, with no clear majority, "A and B on GPT-6.1 Sol; C on Claude Opus 5.5"."""
        return self.grouped([(self.base_name(t), self.our_model(bench, t)) for t in tools], bench)

    @staticmethod
    def grouped(named, what):
        """[(reviewer, model)] as reviewers() words it."""
        by = {}
        for n, m in named:
            by.setdefault(m, []).append(n)
        if not by:
            sys.exit(f"{what}: no reviewers to name")
        ranked = sorted(by.items(), key=lambda kv: -len(kv[1]))
        if len(ranked) == 1 or len(ranked[0][1]) > sum(len(v) for _, v in ranked[1:]):
            main, rest = ranked[0][0], [f"{n} ({m})" for m, ns in ranked[1:] for n in ns]
            return f"all on {main}" + (" except " + and_join(rest) if rest else "")
        return "; ".join(f"{and_join(ns)} on {m}" for m, ns in ranked)

    def ran_by_us(self, bench, tools):
        """'Run by us on GPT-6.1 Sol: QuickReview's frozen build, A and B' (or each with its model)."""
        names = [("QuickReview's frozen build" if t == QR else self.base_name(t)) for t in tools]
        ms = {self.our_model(bench, t) for t in tools}
        if len(ms) == 1:
            return f"Run by us on {ms.pop()}: {and_join(names)}"
        return "Run by us: " + and_join(f"{n} ({self.our_model(bench, t)})" for n, t in zip(names, tools))

    def qr_model(self):
        """The frozen build's model on every benchmark drawn, by name; stops if they differ."""
        ms = {self.our_model(b, QR) for b in BENCHES}
        if len(ms) != 1:
            sys.exit(f"QuickReview's drawn runs are on different models per benchmark: {ms}")
        return ms.pop()

    def base_name(self, t):
        return super().name(t)

    def run_name(self, t):
        """The name of a run that is not a drawn arm (the key's sources, the best-shot variants): data/tools.json
        names pi-review by its drawn configuration, "pi-review panel", and refresh_v5 labels QuickReview's two key
        sources by their preset."""
        plain = {"pi-review": "pi-review", "quickreview": "QuickReview (default)",
                 "quickreview low": "QuickReview (low preset)"}
        return plain.get(t) or (self.base_name(t) if t in self.B.tools else t)

    # ---- QuickReview's labels carry the model (v4's chart functions read every name through these)
    def name(self, t):  # AACR-Bench, and the bug-value charts
        n = super().name(t)
        return self.tagged(n, "aacr", t) if t in (QR, FAST) else n

    def martian_rows(self, judge=MARTIAN_JUDGE):
        return [(t, self.tagged(n, "martian", t) if t == QR else n, s) for t, n, s in super().martian_rows(judge)]

    def qodo_rows(self, rule=QODO_RULE):
        return [(t, self.tagged(n, "qodo", t) if t == QR else n, s) for t, n, s in super().qodo_rows(rule)]

    # ---- the small print
    def martian_source(self):
        jl = self.m["judges"][MARTIAN_JUDGE]["label"]
        gap = max(self.calibration_gap() * 100, 1)
        return wrap(f"Others: Martian's published runs and scores (Core profile, {jl} judge); Martian lists no model for "
                    f"them.\nQuickReview: frozen build on {self.our_model('martian', QR)}, the same pipeline with our "
                    f"judge ({self.judge_words('martian')}), within {gap:.0f} point of {jl}'s recall on "
                    f"{len(self.m['calibration'])} tools.")

    def qodo_source(self):
        g = sorted(self.qodo_gaps().values())
        close = sum(1 for v in g if v <= 1.5)
        rows = self.qodo_rows()
        ran = [t for t, _, _ in rows if self.model("qodo", t)]
        return wrap(f"All {len(rows)} graded by our judge ({self.judge_words('qodo')}), matching issues by meaning; on "
                    f"Qodo's {len(g)} vendor runs, within {g[-1]:.1f} points of Qodo's F1 ({close} within 1.5).\n"
                    f"Vendors: their own runs, models not published. "
                    f"{self.ran_by_us('qodo', [QR] + [t for t in ran if t != QR])}.")

    def aacr_key(self):
        B = self.B
        return (f"{B.total()} defects verified in the code ({B.total({'high'})} high, {B.total({'medium'})} medium, "
                f"{B.total({'low'})} low severity). One judge ({self.judge_words('aacr')}), one run per reviewer; a "
                "partly found defect counts ½.")

    def aacr_models(self, fast=False, tuned=True):
        """'Reviewers: all on GPT-6.1 Sol except Claude Code (Claude Opus 5.5). QuickReview: its frozen build at
        medium/high reasoning, tuned ...; QuickReview fast: the same build's fast profile ... at low reasoning.'"""
        tools = self.B.aacr_tools() + ([FAST] if fast else [])
        s = (f"Reviewers: {self.reviewers('aacr', tools)}. QuickReview: frozen build, {self.reasoning('aacr', QR)} "
             "reasoning" + (f", {TUNED}" if tuned else ""))
        if fast:
            s += f"; fast: {FAST_PROFILE} at {self.reasoning('aacr', FAST)} reasoning"
        return s + "."


def name_x(p, names, floor=290, gap=14, slack=8):
    """The x a bar list's bars start at: v4's 290 px, or further right when the longest name (each measured at its
    size and weight, plus `slack` for the export's wider rendering) would otherwise cross the 64 px margin."""
    return max(floor, 64 + gap + slack + max(measure(p, s, size, "bold" if bold else "normal") for s, size, bold in names))


def boxes(page):
    """[(artist, (x0, y0, x1, y1))] for every visible text, in canvas px (font boxes: ascent to descent)."""
    r = page.fig.canvas.get_renderer()
    inv = page.c.transData.inverted()
    out = []
    for t in page.c.texts:
        if t.get_text().strip() and t.get_visible():
            (a, b), (c, d) = inv.transform(t.get_window_extent(renderer=r).get_points())
            out.append((t, (min(a, c), min(b, d), max(a, c), max(b, d))))
    return out


def is_small_print(page, t):
    """A line Page4.source drew: 10.5 pt at x 64, its baseline on the 17 px ladder up from h - 30."""
    x, y = t.get_position()
    up = page.h - 30 - y
    return x == 64 and t.get_fontsize() == SMALL and up >= 0 and up % 17 == 0 and up <= 17 * 6


def margins(page, side=40, left=58, cover=0.25):
    """v5's layout checks, beyond v4's 8 px overflow check:
    - a text within `side` px of the left or right edge, or left of the 64 px text margin (`left`, with slack);
    - a text running into the small print (font boxes touching, not just stacked), or a page with none;
    - two texts covering each other by more than `cover` of the smaller one's box."""
    bs = boxes(page)
    out = [f"past the side margin: {t.get_text()[:60]!r}" for t, (x0, _, x1, _) in bs
           if x0 < min(side, left) or x1 > page.w - side]
    out += [f"left of the text margin: {t.get_text()[:60]!r}" for t, (x0, _, _, _) in bs if side <= x0 < left]
    small = [b for t, b in bs if is_small_print(page, t)]
    if not small:
        out.append("no small print found")
    else:
        top, right = min(b[1] for b in small), max(b[2] for b in small)
        for t, b in bs:
            if not is_small_print(page, t) and b[3] > top and b[2] > 64 and b[0] < right:
                out.append(f"runs into the small print: {t.get_text()[:60]!r}")
    for i, (t1, a) in enumerate(bs):
        for t2, b in bs[i + 1:]:
            w = min(a[2], b[2]) - max(a[0], b[0])
            h = min(a[3], b[3]) - max(a[1], b[1])
            least = min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]))
            if w > 0 and h > 0 and w * h > cover * least:
                out.append(f"texts overlap: {t1.get_text()[:40]!r} / {t2.get_text()[:40]!r}")
    return out


# ---------------------------------------------------------------- Martian (Greptile's 50 PRs)
def fig_martian_recall(B, V, T):
    rows = sorted(V.martian_rows(), key=lambda r: -r[2]["recall"])
    n, k = len(rows), rank(rows, "recall", QR)
    p = Page4(T, h=1000)
    p.title(f"Highest recall of {n} code reviewers" if k == 1 else f"{ordinal(k)} of {n} code reviewers on recall")
    p.metric(f"Martian Code Review Bench · share of its {V.m['goldens']} known issues found · "
             f"{V.m['prs']} PRs · higher is better")
    src = V.martian_source()
    x0 = name_x(p, [(name, 13, t == QR) for t, name, _ in rows])
    bar_rows(p, [{"name": name, "value": s["recall"], "label": pct(s["recall"]), "qr": t == QR}
                 for t, name, s in rows], x0=x0, x1=p.w - 120, top=136, bottom=p.h - 72 - extra(src), vmax=1.0,
             name_size=13, value_size=13)
    p.source(src)
    return p


# ---------------------------------------------------------------- Qodo PR-Review-Bench
def qodo_bars(B, V, T, key, title, metric):
    rows = sorted(V.qodo_rows(), key=lambda r: -r[2][key])
    p = Page4(T, h=760)
    p.title(title(rows))
    p.metric(metric)
    src = V.qodo_source()
    x0 = name_x(p, [(name, 13.5, t == QR) for t, name, _ in rows])
    bar_rows(p, [{"name": name, "value": s[key], "label": pct(s[key]), "qr": t == QR} for t, name, s in rows],
             x0=x0, x1=p.w - 120, top=140, bottom=p.h - 76 - extra(src), vmax=1.0)
    p.source(src)
    return p


def fig_qodo_f1(B, V, T):
    def title(rows):
        n, k = len(rows), rank(rows, "f1", QR)
        if k > 1 and all(t.startswith("qodo") for t in [r[0] for r in rows[:k - 1]]):
            return f"{ordinal(k)} of {n} on Qodo's benchmark, behind only Qodo"
        return f"{ordinal(k)} of {n} on Qodo's benchmark"
    return qodo_bars(B, V, T, "f1", title, "Qodo PR-Review-Bench · F1, its headline score: issues found and comment "
                     "precision in one number · 100 PRs")


def fig_qodo_functional(B, V, T):
    nf = round(B.qodo["tools"][QR]["issues"] - B.qodo["tools"][QR]["rule_issues"])

    def title(rows):
        n, k = len(rows), rank(rows, "recall_functional", QR)
        return f"Most functional bugs found of {n} reviewers" if k == 1 else f"{ordinal(k)} of {n} on functional bugs found"
    return qodo_bars(B, V, T, "recall_functional", title,
                     f"Qodo PR-Review-Bench · share of its {nf} injected functional bugs found · 100 PRs · higher is better")


# ---------------------------------------------------------------- AACR-Bench (185 PRs, 520 verified defects)
def fig_aacr_found(B, V, T):
    order = aacr_order(B, V)
    rivals = [t for t in order if t not in (QR, FAST)]
    p = Page4(T)
    lead = all(V.recall(QR) > V.recall(t) for t in rivals)
    fast_lead = FAST in order and all(V.recall(FAST) > V.recall(t) for t in rivals)
    p.title("Most defects found, even in fast mode" if lead and fast_lead else
            f"Most defects found of {len(rivals) + 1} reviewers" if lead else "Defects found")
    p.metric(f"{AACR_LINE} · share of the {B.total()} verified defects found · higher is better")
    src = wrap(V.aacr_key() + " " + V.aacr_models(fast=True))
    x0, x1 = name_x(p, [(V.name(t), 13.5, t == QR) for t in order]), p.w - 150
    rows = [{"name": V.name(t), "value": V.recall(t), "label": pct(V.recall(t)), "qr": t == QR} for t in order]
    pitch = bar_rows(p, rows, x0=x0, x1=x1, top=140, bottom=p.h - 76 - extra(src), vmax=1.0, track=True)
    if FAST in order:  # the fast option: the accent, lighter
        y = 140 + pitch * (order.index(FAST) + 0.5)
        theme.bar(p.c, x0, x0 + (x1 - x0) * V.recall(FAST), y, min(26, pitch * 0.62), accent(T, FAST), zorder=4)
    p.source(src)
    return p


def fig_aacr_severity(B, V, T):
    order = aacr_order(B, V, with_fast=False)
    lead = all(all(V.recall(QR, {s}) > V.recall(t, {s}) for t in order if t != QR) for s, _ in SEVS)
    p = Page4(T, h=700)
    p.title("Ahead at every severity" if lead else "Defects found, by severity")
    p.metric(f"{AACR_LINE} · share of the verified defects found, by severity · higher is better")
    src = wrap(V.aacr_key() + " " + V.aacr_models())
    top, bottom = 196, p.h - 78 - extra(src)
    names_x = name_x(p, [(V.name(t), 13, t == QR) for t in order], floor=250, gap=0)
    w = (p.w - names_x - 40) / 3
    pitch = (bottom - top) / len(order)
    for c, (s, label) in enumerate(SEVS):
        x0 = names_x + 14 + c * w
        x1 = x0 + w - 70
        p.text(x0, top - 26, f"{label} · {B.total({s})} defects", size=14, weight="bold", color=T["ink"])
        for i, t in enumerate(order):
            y = top + pitch * (i + 0.5)
            v = V.recall(t, {s})
            theme.bar(p.c, x0, x1, y, min(24, pitch * 0.6), T["empty"], zorder=2)
            theme.bar(p.c, x0, x0 + (x1 - x0) * v, y, min(24, pitch * 0.6), accent(T, t), zorder=3)
            p.text(x1 + 8, y, pct(v), size=12.5, color=T["ink"] if t == QR else T["ink2"],
                   weight="bold" if t == QR else "normal")
            if c == 0:
                p.text(names_x, y, V.name(t), ha="right", size=13, color=T["ink"] if t == QR else T["ink2"],
                       weight="bold" if t == QR else "normal")
    p.source(src)
    return p


def tradeoff(B, V, T, key, unit, title_unit, xr, xticks, xfmt, worse):
    ts = aacr_order(B, V)
    rivals = [t for t in ts if t not in (QR, FAST)]
    # QuickReview's label on two lines, so it sits right of its dot near the right edge, clear of the frontier as in
    # v4; the fast option's stays on one, since a second line would rise into the frontier's first segment
    label = lambda t: f"{V.base_name(t)}\n({V.our_model('aacr', t)})" if t == QR else V.name(t)  # noqa: E731
    pts = [(t, label(t), V.mean(t, key), V.recall(t)) for t in ts]
    lo = min(V.mean(QR, key) / V.mean(t, key) for t in rivals)
    hi = max(V.mean(QR, key) / V.mean(t, key) for t in rivals)
    p = Page4(T, h=760)
    lead = all(V.recall(QR) > V.recall(t) for t in rivals)
    p.title(f"Finds the most, at {lo:.0f}–{hi:.0f}× the {title_unit}" if lead else f"Defects found against {title_unit}")
    p.metric(f"{AACR_LINE} · share of {B.total()} defects found, against {unit} per PR")
    src = wrap("Cost: model spend at list prices, not a bill; time: wall clock on a shared scheduler. " + V.aacr_key()
               + " " + V.aacr_models(fast=True, tuned=False))
    box = (130, 160, p.w - 80, p.h - 130 - extra(src))
    lx = lambda v: math.log10(v)  # noqa: E731
    X0, Y = axis_frame(p, box, (lx(xr[0]), lx(xr[1])), (0, 1), [lx(v) for v in xticks], [0, .25, .5, .75, 1],
                       lambda v: xfmt(10 ** v), pct, f"Average {unit} per PR (log scale)  →  {worse}",
                       "Share of defects found  ↑  better")
    X = lambda v: X0(lx(v))  # noqa: E731
    front = pareto([(c, f) for _, _, c, f in pts])
    fx = [X(pts[i][2]) for i in front]
    fy = [Y(pts[i][3]) for i in front]
    p.c.plot(fx, fy, color=T["muted"], lw=1.4, ls=(0, (5, 4)), zorder=2)
    p.text(fx[-1] - 10, fy[-1] - 26, "best found at each " + title_unit, size=11, color=T["muted"], ha="right")
    labelled_dots(p, pts, X, Y, (box[0] + 4, box[1] + 4, box[2] - 4, box[3] - 4), r=7)
    v4.corner_note(p, box[0] + 10, box[1] + 14, "↖ better", ha="left")
    p.source(src)
    return p


def fig_aacr_cost(B, V, T):
    return tradeoff(B, V, T, "usd", "model cost", "cost", (0.05, 4), [0.05, 0.1, 0.25, 0.5, 1, 2, 4],
                    lambda v: f"${v:g}", "costlier")


def fig_aacr_time(B, V, T):
    return tradeoff(B, V, T, "minutes", "minutes", "time", (0.5, 40), [0.5, 1, 2, 5, 10, 20, 40],
                    lambda v: f"{v:g} min", "slower")


def fig_aacr_leaderboard(B, V, T):
    """AACR-Bench's own metric, laid out as Alibaba's open-code-review leaderboard (its de facto board); the Model
    column and the judge read from the runs."""
    off = V.v3["official"]["aacr"]
    rows = sorted(((t, r) for t, r in off.items() if r), key=lambda kv: -kv[1]["f1"])
    n = len(rows)
    k = 1 + sum(1 for t, r in rows if r["f1"] > off[OCT1]["f1"])
    refs = rows[0][1]["references"]
    p = Page4(T, h=700)
    p.title(f"{ordinal(k)} of {n} on AACR-Bench's own score" if k > 1 else f"Top F1 of {n} on AACR-Bench's own score")
    p.metric(f"How closely a review reproduces the dataset's {refs:,} reference comments · 185 PRs · sorted by F1")
    best = {key: max(r[key] for _, r in rows) for key in ("f1", "precision", "recall")}
    name = lambda t: "QuickReview (Oct 1 build)" if t == OCT1 else B.name(t)  # noqa: E731
    cols = [("#", 84, "right"), ("Reviewer", 110, "left"), ("Model", 430, "left"), ("F1", 650, "right"),
            ("Precision", 790, "right"), ("Recall", 930, "right"), ("Time / PR", 1040, "right"),
            ("Cost / PR", 1150, "right")]
    table(p, cols, [{"cells": [str(i + 1), name(t), V.our_model("aacr", t), pct1(r["f1"]),
                               (pct1(r["precision"]), f"{r['found']:.0f} / {r['comments']}"),
                               (pct1(r["recall"]), f"{r['found']:.0f} / {r['references']}"),
                               f"{V.mean(t, 'minutes'):.1f} min", f"${V.mean(t, 'usd'):.2f}"],
                     "qr": t == OCT1,
                     "best": [c for c, key in ((3, "f1"), (4, "precision"), (5, "recall")) if r[key] == best[key]]}
                    for i, (t, r) in enumerate(rows)], top=160, row_h=58, size=14)
    jn, je, rounds = V.official_judge()
    p.source(wrap(f"AACR-Bench's own matching: a comment on the same file within a line, which a judge ({jn}, {je} "
                  f"reasoning, {rounds} rounds averaged) calls the same concern.\nReferences are mostly AI-written. "
                  "QuickReview: the Oct 1 build (the frozen build was not scored this way).\nTime: mean wall clock; "
                  "cost: mean model spend at list prices."))
    return p


def fig_martian_leaderboard(B, V, T):
    """v4's, titled by its sort key. v4's "Martian's default ranking" meant Martian's default sort (F2), but the
    site's default view also uses its Opus 4.5 judge, and this board is at the GPT-5.2 judge's scores, which the v5
    small print names: so "Martian's F2 ranking"."""
    p = v4.fig_martian_leaderboard(B, V, T)
    old, new = "on Martian's default ranking", "on Martian's F2 ranking"
    hits = [t for t in p.c.texts if t.get_text() == p.title_text]
    if old not in p.title_text or len(hits) != 1:
        sys.exit(f"martian-leaderboard: v4's title no longer says {old!r}")
    p.title_text = p.title_text.replace(old, new)
    hits[0].set_text(p.title_text)
    return p


# ---------------------------------------------------------------- one table: where QuickReview stands
def fig_standings(B, V, T):
    rows = standings(B, V)
    recall_rows = [r for r in rows if (r[0], r[1]) in (("AACR-Bench", "Defects found"), ("Martian", "Recall"),
                                                       ("Qodo", "Functional bugs found"))]
    prec_rows = [r for r in rows if r[1] == "Precision"]
    p = Page4(T, h=740)
    if all(r[3] == 1 for r in recall_rows) and all(r[3] == r[4] for r in prec_rows):
        p.title(f"Most found on all {len(recall_rows)} benchmarks, least precise on {len(prec_rows)}")
    # (Qodo's all-issue recall lead is under a point, so its "found" row is the functional bugs)
    else:
        p.title("Where QuickReview stands")
    p.metric(f"QuickReview ({V.qr_model()}): its place on each benchmark's own measures · every tool each benchmark "
             "tested")
    cols = [("Benchmark", 64, "left"), ("Measure", 250, "left"), ("QuickReview", 650, "right"),
            ("Place", 790, "right"), ("Best other tool", 830, "left")]
    table(p, cols, [{"cells": [b, measure_, pct(v), f"{k} of {n}", f"{other} {pct(ov)}"],
                     "qr": False, "best": [2, 3] if k == 1 else []}
                    for b, measure_, v, k, n, other, ov in rows], top=160, row_h=50, size=14.5)
    jl = V.m["judges"][MARTIAN_JUDGE]["label"]
    p.source(wrap(f"AACR-Bench: 185 PRs, our verified key of 520 defects, one judge ({V.judge_words('aacr')}); precision "
                  "is not measured on it (comments are graded instead).\n"
                  f"Martian: 50 PRs, its own scorer; others at its published {jl}-judge scores, QuickReview scored by our "
                  f"judge ({V.judge_words('martian')}).\n"
                  f"Qodo: 100 PRs, all 13 graded by our judge ({V.judge_words('qodo')}).\n"
                  "QuickReview: its frozen build everywhere. The other tools we ran: "
                  f"{V.reviewers('aacr', [t for t in B.aacr_tools() if t != QR])}."))
    return p


CHARTS = {
    "martian-recall": fig_martian_recall,
    "martian-scatter": v4.fig_martian_scatter,  # v4's, as it is: QuickReview's label and the small print come from V5
    "martian-leaderboard": fig_martian_leaderboard,  # v4's, retitled
    "qodo-f1": fig_qodo_f1,
    "qodo-functional": fig_qodo_functional,
    "qodo-scatter": v4.fig_qodo_scatter,  # likewise
    "aacr-found": fig_aacr_found,
    "aacr-severity": fig_aacr_severity,
    "aacr-cost": fig_aacr_cost,
    "aacr-time": fig_aacr_time,
    "aacr-leaderboard": fig_aacr_leaderboard,
    "standings": fig_standings,
}


def figures():
    # here, not at the top: these import this module's helpers
    import infographics_v5, value_v5
    return {**CHARTS, **value_v5.FIGURES, **infographics_v5.FIGURES}


# ---------------------------------------------------------------- NUMBERS.md
def models_section(V):
    """Every drawn run's model, read from the runs (data/v5.json), and every judge."""
    out = ["## Which model each result ran on\n\n"
           f"Read from each run's own files by refresh_v5.py (data/v5.json, built {V.runs['generated']}):\n"
           "- a QuickReview run: its configured models (run.json `models`, the model overrides, each case's per-lens "
           "pins), then every model its event logs (pi-events.jsonl) record, which must be the same;\n"
           "- a third-party tool: run.json `model` and effort; Claude Code: each case's `models`;\n"
           "- a judge: its JUDGE.txt, judge.txt or judge directory.\n\n"
           "Display names: data/models.json. Martian's other tools and Qodo's vendor rows are the vendors' own runs, "
           "and neither benchmark's data names their models. A build marked `-dirty` ran with uncommitted changes.\n\n"]
    rows = []
    jn, je, rounds = V.official_judge()
    j = V.runs["aacr"]["official_judge"]
    rows.append(["AACR-Bench", "**judge**, the defect key (every AACR image but aacr-leaderboard)",
                 f"{V.judge('aacr')[0]} (`{V.runs['aacr']['judge']['model']}`)", V.judge('aacr')[1], "", "", ""])
    rows.append(["AACR-Bench", f"**judge**, AACR-Bench's own score (aacr-leaderboard; {rounds} rounds averaged)",
                 f"{jn} (`{j['model']}`)", je, "", "", ""])
    k = V.runs["aacr"]["key_seed"]
    rows.append(["AACR-Bench", "QuickReview, the key's seed (how-key's comments)",
                 " + ".join(f"{V.model_name(m)} (`{m}`)" for m in k["models"]), "/".join(k["efforts"]),
                 " ".join(k["builds"]), ", ".join(f"{n:,}" for n in k["calls"].values()), ", ".join(k["runs"])])
    for who, r in V.runs["aacr"]["key_sources"].items():
        rows.append(["AACR-Bench", f"the key's candidate comments: {V.run_name(who)}",
                     " + ".join(f"{V.model_name(m)} (`{m}`)" for m in r["models"]), "/".join(r["efforts"]) or
                     "the tool's default", " ".join(r.get("builds", [])),
                     ", ".join(f"{n:,}" for n in r.get("calls", {}).values()), ", ".join(r["runs"])])
    for run, r in V.runs["aacr"]["best_shot"].items():
        rows.append(["AACR-Bench", f"best-shot selection: {V.run_name(r['tool'])} (how-fair)",
                     " + ".join(f"{V.model_name(m)} (`{m}`)" for m in r["models"]), "/".join(r["efforts"]), "", "",
                     run])
    graded = {"martian": f"QuickReview's row; {len(V.m['calibration'])} published tools re-graded to calibrate it",
              "qodo": "every row, the vendors' runs included"}
    for b, label in BENCHES.items():
        if b != "aacr":
            jb = V.runs[b]["judge"]
            rows.append([label, f"**judge** ({graded[b]})",
                         f"{V.model_name(jb['model'])} (`{jb['model']}`)", jb["effort"], "", "", ""])
        for t, r in V.runs[b]["reviewers"].items():
            rows.append([label, V.base_name(t), " + ".join(f"{V.model_name(m)} (`{m}`)" for m in r["models"]),
                         V.reasoning(b, t) or "the tool's default", " ".join(r.get("builds", [])),
                         ", ".join(f"{n:,}" for n in r.get("calls", {}).values()), ", ".join(r["runs"])])
    out.append(md_table(["Benchmark", "Reviewer or judge", "Model", "Reasoning", "QuickReview build",
                         "Model records in its event logs", "Runs"], rows))
    return "".join(out)


def numbers(B, V):
    import value_v5
    out = ["# The numbers behind out/v5\n",
           f"Every number the v5 charts print, and the ones they rest on (data/v4.json built {V.d['generated']}, "
           f"data/v5.json {V.runs['generated']}). Written by make_charts_v5.py: do not edit by hand. The numbers are "
           "v4's; v5 adds which model each one ran on. The infographics' own counts are listed at the end.\n",
           models_section(V)]
    jl = V.m["judges"][MARTIAN_JUDGE]["label"]
    by_sev = V.m["goldens_by_severity"]
    sev_list = ", ".join(f"{k} {by_sev[k]}" for k in MARTIAN_SEVS)
    out.append(f"## Martian Code Review Bench (martian-recall, martian-scatter, martian-leaderboard)\n\n"
               f"{V.m['prs']} PRs, {V.m['goldens']} Core golden comments ({sev_list}). Others: Martian's published "
               f"runs and scores, its {jl} judge; Martian lists no model for them. QuickReview: its frozen build on "
               f"{V.our_model('martian', QR)}, scored by our judge ({V.judge_words('martian')}).\n")
    rows = sorted(V.martian_rows(), key=lambda r: -r[2]["f2"])
    out.append(md_table(["#", "Tool", "F2", "Precision", "Recall", "F1", "Matched", "Unmatched comments"] +
                        [f"{k} found" for k in MARTIAN_SEVS],
                        [[i + 1, name, pct(s["f2"]), pct(s["precision"]), pct(s["recall"]), pct(s["f1"]), s["tp"],
                          s["fp"]] + [f"{s['by_severity'][k]}/{by_sev[k]}" for k in MARTIAN_SEVS]
                         for i, (t, name, s) in enumerate(rows)]))
    for t in V.martian_partial():
        r = V.m["judges"][MARTIAN_JUDGE]["tools"][t]
        out.append(f"\nLeft out: {MARTIAN_NAMES.get(t, t)}. Its row in the repo scores {r['tp'] + r['fn']} of the "
                   f"{V.m['goldens']} Core goldens (recall {pct(r['recall'])} over that part), so it is not comparable. "
                   "Martian's live site shows a newer, complete run for it.\n")
    out.append("\nCalibration: the three tools graded by both our judge and Martian's (recall / precision).\n\n")
    cal = V.m["calibration"]
    out.append(md_table(["Tool", f"ours ({V.judge('martian')[0]})"] + [V.m["judges"][k]["label"] for k in V.m["judges"]],
                        [[MARTIAN_NAMES.get(t, t), f"{pct(c['ours']['recall'])} / {pct(c['ours']['precision'])}"] +
                         [f"{pct(c[k]['recall'])} / {pct(c[k]['precision'])}" for k in V.m["judges"]]
                         for t, c in cal.items()]))
    ran = [t for t, _, _ in V.qodo_rows() if V.model("qodo", t)]
    out.append("\n## Qodo PR-Review-Bench (qodo-f1, qodo-functional, qodo-scatter)\n\n"
               f"100 PRs, 580 injected issues (309 functional, 271 rule violations). One judge of ours for all 13 "
               f"({V.judge_words('qodo')}). Vendor rows: the vendors' own runs, models not published. "
               f"{V.ran_by_us('qodo', [QR] + [t for t in ran if t != QR])}. Charts use '{QODO_RULE}' (an issue matched "
               f"by meaning); the stricter '{QODO_STRICT}' rule (same file, ±5 lines; v3's official-qodo) is beside "
               "it. Qodo's own published scores are the last column.\n\n")
    pub = V.pub["qodo"]["tools"]
    rows = sorted(V.qodo_rows(), key=lambda r: -r[2]["f1"])
    out.append(md_table(["Tool", "F1", "Precision", "Recall", "Functional found", "Rule found", "Comments/PR",
                         f"F1 ({QODO_STRICT})", f"Recall ({QODO_STRICT})", f"Functional ({QODO_STRICT})",
                         "Qodo's published F1"],
                        [[name, pct(s["f1"]), pct(s["precision"]), pct(s["recall"]), pct(s["recall_functional"]),
                          pct(s["recall_rule"]), f"{s['per_pr']:.1f}",
                          pct(B.qodo["tools"][t]["scores"][QODO_STRICT]["f1"]),
                          pct(B.qodo["tools"][t]["scores"][QODO_STRICT]["recall"]),
                          pct(B.qodo["tools"][t]["scores"][QODO_STRICT]["recall_functional"]),
                          f"{pub[t]['f1']:.1f}%" if t in pub else "not published"] for t, name, s in rows]))
    out.append("\n## AACR-Bench (aacr-found, aacr-severity, aacr-cost, aacr-time)\n\n"
               f"{V.aacr_key()} {V.aacr_models(fast=True)} Cost: mean model spend per PR at list prices; time: mean "
               "wall-clock minutes per PR.\n\n")
    out.append(md_table(["Reviewer", "Found", "High (90)", "Medium (145)", "Low (285)", "$ / PR", "Minutes / PR"],
                        [[V.name(t), pct(V.recall(t)), pct(V.recall(t, {"high"})), pct(V.recall(t, {"medium"})),
                          pct(V.recall(t, {"low"})), f"${V.mean(t, 'usd'):.2f}", f"{V.mean(t, 'minutes'):.1f}"]
                         for t in aacr_order(B, V)]))
    off = V.v3["official"]["aacr"]
    jn, je, rounds = V.official_judge()
    out.append("\n## AACR-Bench's own score (aacr-leaderboard)\n\nThe dataset's reference comments, matched by "
               f"AACR-Bench's harness with its judge prompt on {jn} ({je} reasoning, {rounds} rounds averaged). "
               f"QuickReview: the Oct 1 build ({', '.join(V.builds('aacr', OCT1))}), on {V.our_model('aacr', OCT1)}; "
               "its frozen build and fast option were not scored this way.\n\n")
    out.append(md_table(["Reviewer", "Model", "F1", "Precision", "Recall", "Matched", "Comments", "References"],
                        [[("QuickReview (Oct 1 build)" if t == OCT1 else B.name(t)), V.our_model("aacr", t),
                          pct1(r["f1"]), pct1(r["precision"]), pct1(r["recall"]), f"{r['found']:.1f}", r["comments"],
                          r["references"]]
                         for t, r in sorted(((t, r) for t, r in off.items() if r), key=lambda kv: -kv[1]["f1"])]))
    out.append("\n" + value_v5.numbers(B, V))
    out.append(f"\n## Where QuickReview stands (standings)\n\nQuickReview: its frozen build, on {V.qr_model()}, on "
               "every benchmark.\n\n")
    out.append(md_table(["Benchmark", "Measure", "QuickReview", "Place", "Best other tool"],
                        [[b, m_, pct(v), f"{k} of {n}", f"{o} {pct(ov)}"] for b, m_, v, k, n, o, ov in standings(B, V)]))
    import infographics_v5 as I
    seed_model, seed_build = V.key_seed()
    jl = V.m["judges"][MARTIAN_JUDGE]["label"]
    audit = V.model_name(I.AUDITORS)
    out.append("\n## The infographics' counts that come from runs\n\n"
               f"- **review-round:** QuickReview's frozen build on {V.qr_model()}, mean per PR over AACR-Bench's 185 "
               f"PRs (data/v3.json idea-funnel); \"judged correct\" is the benchmark judge's grade "
               f"({V.judge_words('aacr')}). Lenses run per PR: median {I.median_lenses(V):g}, drawn as that many "
               "chips.\n"
               f"- **how-key:** \"334 of the first 379 defects\" counts the comments of the run that seeded the key, "
               f"QuickReview's default run, build {seed_build} on {seed_model} (FULL-BENCHMARK.md, the key's sources). "
               f"Every reviewer comment the builders checked came from earlier runs, {V.key_sources()} (the table "
               f"above). The builders were Claude Code subagents on {audit} (bench docs).\n"
               f"- **how-fair:** \"lifted 3 rivals 12–17 pts\" compares each rival's best-shot variant with its "
               f"published run on 40 PRs, all on {V.best_shot(I.LIFTED)}, graded by {V.judge_words('aacr')} "
               "(FULL-BENCHMARK.md §3; the selection runs are in the table above).\n"
               f"- **how-martian:** the golden audit (\"Our audit: {B.martian['real_goldens']} of 173 real\") was done "
               f"by AI investigators on {audit} (GOLDEN-AUDIT-FULL.md); its calibration (\"Recall within … of {jl}\") "
               f"is our judge ({V.judge_words('martian')}) against Martian's {jl} judge on the same "
               f"{len(V.m['calibration'])} tools.\n"
               f"- **how-qodo:** its calibration (\"Within … pts of Qodo's F1\") is our judge "
               f"({V.judge_words('qodo')}) against Qodo's published F1 on its {len(V.qodo_gaps())} vendor runs.\n"
               "- The other infographics print no measured result.\n")
    return "\n".join(out)


# ---------------------------------------------------------------- the pages to share
# v4's gallery sections, with the Martian heading no longer saying Martian scored everything
SECTIONS = [(t if not t.startswith("Martian") else "Martian Code Review Bench: Greptile's and Augment's 50 PRs", ns)
            for t, ns in v4.SECTIONS]


def section_notes(V):
    jl = V.m["judges"][MARTIAN_JUDGE]["label"]
    notes = dict(v4.SECTION_NOTES)
    notes.pop("Martian Code Review Bench: Greptile's and Augment's 50 PRs, scored by Martian")
    notes["Martian Code Review Bench: Greptile's and Augment's 50 PRs"] = (
        f"Martian's public leaderboard with QuickReview added: the other tools at Martian's published scores (its "
        f"{jl} judge), QuickReview scored by the same pipeline with our judge ({V.judge_words('martian')}).")
    return notes


def caption_model(V, n):
    """The model line under an image on the page: whose numbers, on which model, graded by which judge."""
    import infographics_v5 as I
    qr, frozen = V.qr_model(), "QuickReview: frozen build on "
    aacr = f"reviewers: {V.reviewers('aacr', V.B.aacr_tools())}; judge: {V.judge_words('aacr')}"
    ran = [t for t, _, _ in V.qodo_rows() if V.model("qodo", t)]
    if n.startswith("martian") or n == "how-martian":
        return (f"{frozen}{qr}, scored by our judge ({V.judge_words('martian')}); the other tools at Martian's "
                f"{V.m['judges'][MARTIAN_JUDGE]['label']}-judge scores"
                + (f"; golden audit by {V.model_name(I.AUDITORS)} investigators" if n == "how-martian" else ""))
    if n.startswith("qodo") or n == "how-qodo":
        return (f"{V.ran_by_us('qodo', [QR] + [t for t in ran if t != QR])}; every row graded by our judge "
                f"({V.judge_words('qodo')})")
    if n == "aacr-leaderboard":
        jn, je, rounds = V.official_judge()
        return (f"QuickReview: the Oct 1 build on {V.our_model('aacr', OCT1)}; matched by {jn} ({je} reasoning, "
                f"{rounds} rounds averaged)")
    if n.startswith("aacr") or n.startswith("value"):
        return f"{frozen}{qr}; {aacr}"
    if n == "how-aacr":
        return cap(aacr)
    if n == "how-fair":
        return f"{cap(aacr)}; best-shot selection runs on {V.best_shot(I.LIFTED)}"
    if n == "standings":
        return f"{frozen}{qr} on every benchmark"
    if n == "review-round":
        return f"Counts: QuickReview's frozen build on {qr}; judge: {V.judge_words('aacr')}"
    if n == "how-key":
        seed_model, seed_build = V.key_seed()
        return (f"Candidate comments from earlier runs, {V.key_sources()}; the seed: QuickReview build {seed_build} "
                f"on {seed_model}; built by Claude Code subagents on {V.model_name(I.AUDITORS)}")
    return ""


def qr_note(V):
    """The pages' sentence on which builds and models QuickReview's results are, each read from the runs."""
    qr, fast, oct1 = V.qr_model(), V.our_model("aacr", FAST), V.our_model("aacr", OCT1)
    same = lambda m: "the same model" if m == qr else m  # noqa: E731
    seed_model, seed_build = V.key_seed()
    jn, je, rounds = V.official_judge()
    return (f"QuickReview's results come from its frozen build ({', '.join(V.builds('aacr'))}) with {qr} on every "
            f"model call, at {V.reasoning('aacr', QR)} reasoning by lens. Its fast option ({', '.join(V.builds('aacr', FAST))}, "
            f"the frozen build with a fast profile) runs {same(fast)} at {V.reasoning('aacr', FAST)} reasoning. "
            f"AACR-Bench's own score shows the Oct 1 build, on {same(oct1)}, and how-key counts the comments of an "
            f"earlier build ({seed_build}, on {seed_model}). The other tools we ran are "
            f"{V.reviewers('aacr', [t for t in V.B.aacr_tools() if t != QR])}. Judges: {V.judge_words('aacr')}, for "
            f"AACR-Bench; {jn}, {je} reasoning, for AACR-Bench's own score; ours, {V.judge_words('qodo')}, for Qodo and "
            f"QuickReview's Martian row; Martian's {V.m['judges'][MARTIAN_JUDGE]['label']} for its other rows.")


SHARE_CSS5 = SHARE_CSS + """
:root{color-scheme:light dark;--shade:rgba(0,0,0,.18)}:root[data-theme=light]{color-scheme:light}
:root[data-theme=dark]{color-scheme:dark;--shade:rgba(255,255,255,.2)}
@media (prefers-color-scheme: dark){:root:not([data-theme=light]){--shade:rgba(255,255,255,.2)}}
figcaption i{display:block;color:var(--ink2);font-style:normal;font-size:12.5px;margin:-4px 0 8px}
#zoom{overscroll-behavior:contain}#zoom.big{overflow:auto;align-items:flex-start;justify-content:flex-start}
#zoom.big img{max-width:none;max-height:none;width:1200px;border-radius:0}
"""
# v4's script, opening an image at its full 1200 px (the overlay scrolls) whenever fitting it to the window would
# not make it clearly larger than on the page (a phone, a sideways phone, a tablet), and always at its top-left corner
_OPEN = "zimg.src=vis.src;zimg.alt=vis.alt;zoom.style.display='flex';}));"
if SHARE_JS.count(_OPEN) != 1:
    sys.exit("make_charts_v4.SHARE_JS no longer opens an image the way v5 extends")
SHARE_JS5 = SHARE_JS.replace(_OPEN, "const fit=Math.min(innerWidth-32,(innerHeight-32)*vis.naturalWidth/vis.naturalHeight);\n"
                             "zoom.classList.toggle('big',fit<1.25*vis.getBoundingClientRect().width);\n"
                             "zimg.src=vis.src;zimg.alt=vis.alt;zoom.style.display='flex';zoom.scrollTo(0,0);}));")


def write_index(out, pages, V):
    """out/v5/index.html: the whole library as ONE self-contained page to share.

    Every image is embedded, light and dark, and the page follows the viewer's theme or a switch. Click an image to
    enlarge it (where the window is too small to enlarge it whole, it opens at full size and scrolls). There are no
    links to other files, no scripts from elsewhere and no web fonts. Under each image, the model its numbers ran on.
    """
    import html
    notes = section_notes(V)
    listed = [n for _, names in SECTIONS for n in names]
    sections = [(t, [n for n in names if n in pages]) for t, names in SECTIONS]
    sections.append(("More", [n for n in pages if n not in listed]))
    body = []
    for title, names in sections:
        if not names:
            continue
        body.append(f"<h2>{html.escape(title.split(' (')[0])}</h2>")
        if title in notes:
            body.append(f"<p>{html.escape(notes[title])}</p>")
        body.append("<div class=grid>")
        for n in names:
            head, sub = (html.escape(x or "") for x in pages[n])
            model = caption_model(V, n)
            alt = html.escape(pages[n][0] + (f" ({model})" if model else ""))
            lt, dk = embed(os.path.join(out, f"{n}.png")), embed(os.path.join(out, f"{n}-dark.png"))
            body.append(
                f'<figure id="{n}"><img class=lt src="{lt}" alt="{alt}" loading="lazy">'
                f'<img class=dk src="{dk}" alt="{alt}" loading="lazy">'
                f'<figcaption><b>{head}</b><span>{sub}</span>'
                + (f"<i>{html.escape(model)}</i>" if model else "") +
                f'<code>{n}</code> &nbsp; '
                f'<a href="#{n}" data-get="lt">download light</a><a href="#{n}" data-get="dk">download dark</a>'
                "</figcaption></figure>")
        body.append("</div>")
    data = f"data of {V.d['generated']}; models read {V.runs['generated']}"
    doc = ("<!doctype html>\n<html lang=en><head><meta charset=utf-8>"
           "<meta name=viewport content=\"width=device-width,initial-scale=1\"><title>QuickReview showcase</title>"
           f"<style>{SHARE_CSS5}</style></head><body><main>\n<h1>QuickReview: benchmarks and how it works</h1>\n"
           "<p>Each public benchmark drawn the way its publisher draws it, with QuickReview added under the model it "
           "ran on; what a found bug is worth; how we measured; and how QuickReview reviews a pull request. Every "
           f"number comes from the benchmark runs ({html.escape(data)}); each image's small print says how it was "
           "measured. Click an image to enlarge it.</p>\n"
           f"<p>{html.escape(qr_note(V))}</p>\n"
           "<div class=bar><span>Theme</span><button data-t=auto aria-pressed=true>auto</button>"
           "<button data-t=light aria-pressed=false>light</button><button data-t=dark aria-pressed=false>dark"
           "</button></div>\n" + "\n".join(body) +
           "\n</main><div id=zoom><img alt=\"\"></div>" + f"<script>{SHARE_JS5}</script></body></html>\n")
    with open(os.path.join(out, "index.html"), "w") as fh:
        fh.write(doc)


def write_report_html(text, html_path, title, V, out=OUT):
    """A Markdown report (its page version) as ONE self-contained HTML page to share. Every image it shows from its
    own directory is embedded, light and dark, with the model line the gallery gives it; the page follows the
    viewer's theme or a switch; its sources' addresses are links; and its tables scroll sideways on a narrow screen
    instead of the page, a shadow at the edge showing there is more."""
    import html as H
    import re
    import markdown
    text = re.sub(r"(?<![<(])\bhttps?://[^\s<>()]*[^\s<>().,;:]", lambda m: f"<{m.group(0)}>", text)
    body = markdown.markdown(text, extensions=["tables", "sane_lists"])

    def figure(m):
        """An <img> of a chart beside the report, as its light and dark images embedded, and its model line."""
        attrs = dict(re.findall(r'(\w+)="([^"]*)"', m.group(1)))
        src = attrs.get("src", "")
        if "/" in src or not src.endswith(".png"):
            return m.group(0)
        stem = os.path.splitext(src)[0]
        model = caption_model(V, stem)
        alt = H.escape(H.unescape(attrs.get("alt", "")) + (f" ({model})" if model else ""))
        lt, dk = (embed(os.path.join(out, f"{stem}{sfx}.png")) for sfx in ("", "-dark"))
        return (f'<figure><img class=lt src="{lt}" alt="{alt}"><img class=dk src="{dk}" alt="{alt}">'
                + (f"<figcaption><i>{H.escape(model)}</i></figcaption>" if model else "") + "</figure>")

    body = re.sub(r"<img ([^>]*?)\s*/?>", figure, body)
    body = re.sub(r"<p>(<figure>.*?</figure>)</p>", r"\1", body)  # a figure may not sit inside a paragraph
    body = body.replace("<table>", "<div class=scroll><table>").replace("</table>", "</table></div>")
    css = SHARE_CSS5 + ("article{max-width:900px;margin:0 auto}article p,article li{color:var(--ink);max-width:none;"
                        "overflow-wrap:anywhere}article figure{margin:18px 0;cursor:zoom-in}article figcaption{padding:"
                        "10px 14px 6px}.scroll{overflow-x:auto;background:linear-gradient(to right,var(--bg) 30%,"
                        "transparent) left center/40px 100% no-repeat local,linear-gradient(to left,var(--bg) 30%,"
                        "transparent) right center/40px 100% no-repeat local,radial-gradient(farthest-side at 0 50%,"
                        "var(--shade),transparent) left center/14px 100% no-repeat scroll,radial-gradient(farthest-side"
                        " at 100% 50%,var(--shade),transparent) right center/14px 100% no-repeat scroll}"
                        "table{border-collapse:collapse;margin:12px 0;font-size:14px}th,td{border-bottom:1px solid "
                        "var(--line);padding:6px 10px;text-align:left}th{color:var(--muted);font-weight:600}"
                        "a{color:var(--accent)}")
    doc = ("<!doctype html>\n<html lang=en><head><meta charset=utf-8>"
           "<meta name=viewport content=\"width=device-width,initial-scale=1\">"
           f"<title>{H.escape(title)}</title><style>{css}</style></head><body><main><article>\n"
           "<div class=bar><span>Theme</span><button data-t=auto aria-pressed=true>auto</button>"
           "<button data-t=light aria-pressed=false>light</button><button data-t=dark aria-pressed=false>dark"
           "</button></div>\n" + body + "\n</article></main><div id=zoom><img alt=\"\"></div>"
           f"<script>{SHARE_JS5}</script></body></html>\n")
    with open(html_path, "w") as fh:
        fh.write(doc)


def render(figs, names, out=OUT, full=False):
    """Draw the named figures (all of figs when names is empty), light and dark; return the layout problems.
    A full run also writes NUMBERS.md, the bug-value report (BUG-VALUE.md and its page) and the gallery page, all
    in out/v5."""
    B = Bench()
    V = V5(B)
    os.makedirs(out, exist_ok=True)
    bad = 0
    pages = {}
    for name in names or figs:
        for th in ("light", "dark"):
            T = theme.use(th)
            page = figs[name](B, V, T)
            for t in page.c.texts:  # the small print, where the models are named, in a darker grey on light
                if th in SMALL_INK and is_small_print(page, t):
                    t.set_color(SMALL_INK[th])
            pages[name] = (getattr(page, "title_text", name), getattr(page, "metric_text", ""))
            for problem in theme.overflow(page) + margins(page):
                bad += 1
                print(f"LAYOUT {name} ({th}): {problem}", file=sys.stderr)
            print(save(page, out, name, th, svg=th == "light"))
    if full:
        with open(os.path.join(out, "NUMBERS.md"), "w") as fh:
            fh.write(numbers(B, V))
        import value_v5
        with open(os.path.join(out, "BUG-VALUE.md"), "w") as fh:
            fh.write(value_v5.report(B, V))
        write_report_html(value_v5.report(B, V, page=True), os.path.join(out, "bug-value.html"),
                          "What a found bug is worth", V, out)
        write_index(out, pages, V)
    return bad


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("names", nargs="*")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--out", default=OUT)
    a = ap.parse_args()
    figs = figures()
    if a.list:
        print("\n".join(figs))
        return
    unknown = [n for n in a.names if n not in figs]
    if unknown:
        sys.exit(f"unknown image(s): {', '.join(unknown)} (see --list)")
    bad = render(figs, a.names, a.out, full=not a.names)
    if bad:
        sys.exit(f"{bad} layout problem(s)")


if __name__ == "__main__":
    main()
