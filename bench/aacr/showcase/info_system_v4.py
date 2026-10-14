#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["matplotlib>=3.8"]
# ///
"""v4 infographics: how one review round works, the lenses, the safety model and a PR's lifecycle.

Conventions: infographics_v4.py (the look, the two exemplars) and diagram_v4.py (the parts).
    uv run bench/aacr/showcase/info_system_v4.py [names]   # draws this file's figures into out/v4/
"""
import math, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from matplotlib.patches import FancyBboxPatch, Polygon  # noqa: E402
from diagram_v4 import arrow, badge, check, group, icon, measure, node, path_arrow, pill, stat, tint  # noqa: E402,F401
from theme_v4 import Page4  # noqa: E402,F401

QR = "quickreview"
LEFT, RIGHT = 64, 1136  # the side margins every v4 image keeps


def row_x(widths, gaps, x0=LEFT):
    """The left edges of boxes laid side by side: widths[i], then gaps[i] to the next one."""
    xs, x = [], x0
    for w, g in zip(widths, list(gaps) + [0]):
        xs.append(x)
        x += w + g
    return xs


def chip(p, x, y, w, h, dashed=False, r=5, z=3):
    """A small accent square: one lens run in the fan-out (dashed: one added by the coverage check)."""
    k = tint(p)
    p.c.add_patch(FancyBboxPatch((x, y), w, h, boxstyle=f"round,pad=0,rounding_size={r}",
                                 facecolor="none" if dashed else k["qr_fill"], edgecolor=k["qr_line"],
                                 lw=1.2, ls=(0, (3, 2.5)) if dashed else "-", zorder=z))


def pill_right(p, x, y, text, **kw):
    """A pill whose right end is at x."""
    size = kw.get("size", 11.5)
    w = measure(p, text, size, "bold" if kw.get("qr") else "normal") + 22
    return pill(p, x - w, y, text, **kw)


def stream(p, stops, yc, tip=16, z=2):
    """A horizontal band centred on yc whose height eases from one (x, height) stop to the next; it ends in a point."""
    k = tint(p)
    top, bot = [], []
    for (xa, ha), (xb, hb) in zip(stops, stops[1:]):
        n = max(2, int((xb - xa) / 3))
        for i in range(n):
            t = i / n
            hh = ha + (hb - ha) * (1 - math.cos(math.pi * t)) / 2
            top.append((xa + (xb - xa) * t, yc - hh / 2))
            bot.append((xa + (xb - xa) * t, yc + hh / 2))
    xe, he = stops[-1]
    top.append((xe, yc - he / 2))
    bot.append((xe, yc + he / 2))
    p.c.add_patch(Polygon(top + [(xe + tip, yc)] + bot[::-1], closed=True, facecolor=k["qr_fill"],
                          edgecolor=k["qr_line"], lw=1.2, zorder=z, joinstyle="round"))


# ---------------------------------------------------------------- one review round
def per_pr(V):
    """Mean per PR over the AACR-Bench findings records: (PRs, [lens findings, after merging, posted, correct])."""
    d = V.v3["ideas"]["idea-funnel"]
    n, t = len(d["prs"]), d["totals"]
    return n, [t["raised"] / n, t["distinct"] / n, t["posted"] / n, (t["correct-valuable"] + t["correct-minor"]) / n]


def fig_review_round(B, V, T):
    """One round left to right: a plan by rules, the lenses in parallel, the cuts to one review; under the steps,
    the record every candidate lands in, with what it counts per PR."""
    p = Page4(T, h=752)
    n_prs, (raised, merged, posted, correct) = per_pr(V)
    p.title("Read widely, filter hard, post one review")
    p.metric("Inside one review round: all lenses read at once, then each step narrows toward one review")
    top, h = 196, 168
    mid = top + h / 2
    widths = [120, 180, 124, 124, 124, 124, 140]
    wide = 22  # the room around the fan-out
    gap = (RIGHT - LEFT - sum(widths) - 2 * wide) / 4
    xs = row_x(widths, [wide, wide, gap, gap, gap, gap])
    cx = [x + w / 2 for x, w in zip(xs, widths)]
    kw = dict(icon_top=True, size=14, note_size=11.5)
    node(p, xs[0], top, widths[0], h, "Plan", "rules pick lenses", icon_name="gear", num=1, **kw)
    # 2-3: the lenses run together; the coverage check adds a sweep where none commented
    gx, gw = xs[1], widths[1]
    gtop, gh = mid - 106, 212
    group(p, gx, gtop, gw, gh, "Lenses", qr=True)
    badge(p, gx, gtop, 2)
    s, sg, cols = 22, 7, 5
    gx0 = gx + (gw - cols * s - (cols - 1) * sg) / 2
    for i in range(15):
        x, y = gx0 + (i % cols) * (s + sg), gtop + 44 + (i // cols) * (s + sg)
        chip(p, x, y, s, s)
        icon(p, "search", x + s / 2, y + s / 2, 12, color=T["qr"], lw=1.3)
    cy = gtop + 44 + 3 * (s + sg) + 10
    for i in range(2):  # the coverage check's sweeps, on the grid's columns
        chip(p, gx0 + i * (s + sg), cy, s, s, dashed=True)
    p.text(gx0 + 2 * (s + sg) + 1, cy + s / 2, "coverage", size=11, color=T["ink2"])
    badge(p, gx, cy + s / 2, 3)
    p.text(cx[1], gtop + gh - 13, "read-only · one commit", size=10.5, color=T["muted"], ha="center", va="baseline")
    pill(p, cx[1], gtop + gh + 24, "median 15", qr=True, ha="center")
    steps = [  # (label, note, icon, style)
        ("Merge", "one per root cause", "list", "qr"),
        ("Validate", "re-checks each claim", "judge", "qr"),
        ("Severity", "contrived never blocks", "flag", "plain"),
        ("Decide", "any blocker: changes", "branch", "plain"),
        ("One review", "≤ 50 inline + summary", "doc", "qr-solid"),
    ]
    for i, (label, note, ic, st) in enumerate(steps, start=2):  # columns 2-6 hold steps 4-8
        node(p, xs[i], top, widths[i], h, label, note, icon_name=ic, style=st, num=i + 2, **kw)
    for i in range(len(xs) - 1):
        arrow(p, (xs[i] + widths[i] + 2, mid), (xs[i + 1] - 2, mid))
    # 7's outcomes, under it
    oy = top + h + 30
    for j, (ok, txt) in enumerate(((False, "changes"), (True, "approve"))):
        check(p, xs[5] + 24, oy + j * 26, ok=ok, size=13)
        p.text(xs[5] + 40, oy + j * 26, txt, size=11.5, color=T["ink2"])
    pill(p, cx[5], oy + 2 * 26 + 4, "CI not green: comment", ha="center", size=10.5)
    # 9: the record every candidate lands in, drawn as the stream of findings per PR under the steps
    ry, rh = 502, 176
    group(p, LEFT, ry, RIGHT - LEFT, rh, "Reasoning record · mean per PR")
    badge(p, LEFT, ry, 9)
    rx = (LEFT + xs[1]) / 2
    icon(p, "db", rx, ry + 84, 30, color=T["ink2"])
    p.text(rx, ry + 124, "every outcome", size=11.5, color=T["ink2"], ha="center")
    yc, hmax = ry + 96, 100
    H = lambda v: hmax * v / raised  # noqa: E731
    stream(p, [(xs[1], H(raised)), (xs[1] + gw, H(raised)), (xs[2] + widths[2], H(merged)),
               (xs[3] + 24, H(merged)), (xs[3] + widths[3] - 10, H(posted)), (RIGHT - 18, H(posted))], yc)
    stat(p, cx[1], yc + 6, f"{raised:.1f}", "lens findings", size=26, cap_size=11.5, ha="center", width=150)
    for x, v, lab in ((xs[2] + widths[2] + 8, merged, "after merging"), (xs[6] + 6, posted, "posted")):
        p.text(x, yc + 1, f"{v:.1f}", size=15, weight="bold", color=T["qr"])
        p.text(x + measure(p, f"{v:.1f}", 15, "bold") + 6, yc + 1, lab, size=12, color=T["ink2"])
    pill(p, cx[3], yc + 44, "doubted: kept, not posted", ha="center", size=10.5)
    p.text(RIGHT - 16, yc + 38, f"{correct:.1f} judged correct", size=11, color=T["muted"], ha="right")
    p.source(f"Counts: mean per PR over the {n_prs} AACR-Bench PRs; \"judged correct\" is the benchmark judge's grade.\n"
             "Severity: P0–P1 block; P2 blocks only at confidence 0.8 or more, else it is a question; P3 is a question.")
    return p


# ---------------------------------------------------------------- the lens catalog
SUB, EVERY = "sub", "every"  # markers: a sub-lens the diff's content triggers; a lens that runs every round
AREAS = [  # (area, cap, [(lens, what it looks for, marker)]), in the catalog's order
    ("Correctness", None, [("baseline", "correctness and tests", EVERY), ("sweep", "slips on changed lines", EVERY),
                           ("behaviour-delta", "dropped old behaviour", None), ("tests", "broken, mocked tests", None),
                           ("widened", "widened check's users", SUB), ("concurrency", "races, interleavings", SUB),
                           ("deferred", "who drains queues", SUB)]),
    ("Security & data", None, [("security", "auth, tenancy, secrets", None),
                               ("data-safety", "migrations, bulk writes", None),
                               ("prod-risk", "endpoint load, latency", None),
                               ("bounds", "untrusted sizes, leaks", SUB), ("roundtrip", "decode, encode, write", SUB)]),
    ("Runtime & compatibility", None, [("contracts", "external payloads", None),
                                       ("delivery", "redelivery, drops", None),
                                       ("statelessness", "in-process state", None),
                                       ("ui", "frontend state, effects", None),
                                       ("backcompat", "old and new together", None),
                                       ("rollout", "mixed-version peers", SUB)]),
    ("Design", "max P2", [("placement", "right module, layer", None), ("simplicity", "simpler shape", None)]),
    ("Intent", None, [("intent", "diff vs PR text", None), ("claims", "each checkable claim", SUB),
                      ("ask-human", "questions for a person", None)]),
    ("Quality", "max P2", [("maintainability", "names, docs, coupling", None),
                         ("duplication", "same knowledge twice", None),
                         ("abstraction", "right-level boundaries", None),
                         ("consistency", "similar cases alike", None), ("style", "written style rules", None),
                         ("lint-conformance", "what CI's linter fails", None)]),
]
MARK_ICON = {SUB: "bolt", EVERY: "loop"}


def lens_tile(p, x, y, w, h, name, looks, mark=None):
    """One lens: its name over what it looks for, with the marker (if any) at the top right."""
    T, k = p.T, tint(p)
    p.c.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0,rounding_size=8", facecolor=k["qr_fill"],
                                 edgecolor=k["qr_line"], lw=1.2, zorder=3))
    p.text(x + 12, y + h / 2 - 2, name, size=12.5, weight="bold", va="baseline", zorder=4)
    p.text(x + 12, y + h / 2 + 16, looks, size=10.5, color=T["ink2"], va="baseline", zorder=4)
    if mark:
        icon(p, MARK_ICON[mark], x + w - 16, y + 15, 13, color=T["qr"], lw=1.5)


def fig_lenses(B, V, T):
    """The lens catalog: one column per area (Design over Intent), a tile per lens, the validator under them all."""
    p = Page4(T, h=800)
    lenses = [ln for _, _, ls in AREAS for ln in ls]
    n_sub = sum(1 for *_, m in lenses if m == SUB)
    p.title(f"{len(lenses)} specialists, each looking for one kind of problem")
    p.metric(f"The lens catalog by area: {len(lenses)} lenses, {n_sub} of them triggered by what the diff contains, "
             "and one validator")
    areas = {a: (cap, ls) for a, cap, ls in AREAS}
    columns = [["Correctness"], ["Security & data"], ["Runtime & compatibility"], ["Design", "Intent"], ["Quality"]]
    widths = [200, 196, 236, 194, 196]  # Runtime's name is the longest header
    xs = row_x(widths, [(RIGHT - LEFT - sum(widths)) / (len(widths) - 1)] * (len(widths) - 1))
    top, head, th, tg, pad = 140, 36, 50, 7, 7
    vy, vh = 616, 54  # the validator, under every column
    for x, w, col in zip(xs, widths, columns):
        y = top
        for area in col:
            cap, ls = areas[area]
            gh = head + len(ls) * (th + tg) - tg + pad + 1
            group(p, x, y, w, gh, area)
            if cap:
                pill_right(p, x + w - 9, y + 18, cap, size=10.5)
            for i, (name, looks, mark) in enumerate(ls):
                lens_tile(p, x + pad, y + head + i * (th + tg), w - 2 * pad, th, name, looks, mark)
            bottom = y + gh
            y = bottom + 14
        arrow(p, (x + w / 2, bottom + 4), (x + w / 2, vy - 4), lw=1.5, head=9)
    # the validator: one bar every column feeds, in one line
    p.c.add_patch(FancyBboxPatch((LEFT, vy), RIGHT - LEFT, vh, boxstyle="round,pad=0,rounding_size=10",
                                 facecolor=T["qr"], edgecolor=T["qr"], lw=1.4, zorder=3))
    ink = tint(p)["solid_ink"]
    icon(p, "judge", LEFT + 30, vy + vh / 2, 22, color=ink)
    p.text(LEFT + 54, vy + vh / 2, "validate", size=15, weight="bold", color=ink)
    p.text(LEFT + 66 + measure(p, "validate", 15, "bold"), vy + vh / 2, "re-checks every candidate, last in every round",
           size=12.5, color=ink)
    icon(p, MARK_ICON[EVERY], RIGHT - 24, vy + vh / 2, 14, color=ink, lw=1.6)
    # the key to the markers
    ly = vy + vh + 30
    x = LEFT
    for mark, txt in ((SUB, "a sub-lens the diff's content triggers"), (EVERY, "runs every round")):
        icon(p, MARK_ICON[mark], x + 7, ly, 13, color=T["qr"], lw=1.5)
        p.text(x + 22, ly, txt, size=11.5, color=T["ink2"])
        x += 22 + measure(p, txt, 11.5) + 30
    p.source("Max P2: the highest severity a design or quality lens may raise. Rules plan each PR's lenses; the review "
             "session may add one, never drop one.\nSecurity, data-safety and prod-risk always run at the top reasoning "
             "tier. A repo's profile may switch the validator off.")
    return p


# ---------------------------------------------------------------- the safety model
GUARDS = [  # (the question asked right before a review lands, what happens on the wrong answer)
    ("Still open?", "else refuse"),
    ("Same head?", "else refuse"),
    ("Anything new?", "else post nothing"),
    ("Human approved?", "then soften to comment"),
    ("CI green?", "else withhold approval"),
]
RULES = [  # (label, note, icon, pills): what holds whatever a session does
    ("Reads, never runs", "CI is read, never triggered", "eye", ["28 read-only programs", "5 layers"]),
    ("No dismiss action", "approvals never dismissed", "shield", ["[check this]: humans only"]),
    ("Dry-run first", "would-be writes to a file", "doc", ["the shipped default"]),
    ("App credential only", "no personal-token path", "lock", ["tokens from the App key"]),
]


def fig_safety(B, V, T):
    """Two write paths into the same five guards, then GitHub; under them the rules that always hold."""
    p = Page4(T, h=780)
    p.title("Every GitHub write is checked before it lands")
    p.metric("The safety model: one gate, the same five guards on both write paths, and four standing rules")
    widths = [146, 152, 470, 0]  # writers, their checked route, the guards; GitHub takes what is left
    xs = row_x(widths, [30, 36, 36])
    widths[3] = RIGHT - xs[3]
    gy, gh = 150, 344  # the guards' panel
    nh = 140
    paths = [(gy + 20, "Daemon", "background service", "gear", "plain", "One gate", "13 kinds only", "shield"),
             (gy + gh - 20 - nh, "Review session", "posts reviews", "chat", "qr", "Posting scripts",
              "same 5 guards", "terminal")]
    kw = dict(icon_top=True, size=14, note_size=11.5)
    for y, who, wnote, wic, wst, via, vnote, vic in paths:
        node(p, xs[0], y, widths[0], nh, who, wnote, icon_name=wic, style=wst, **kw)
        node(p, xs[1], y, widths[1], nh, via, vnote, icon_name=vic, style="plain", **kw)
        arrow(p, (xs[0] + widths[0] + 2, y + nh / 2), (xs[1] - 2, y + nh / 2))
        arrow(p, (xs[1] + widths[1] + 2, y + nh / 2), (xs[2] - 2, y + nh / 2))
    # the five guards: one row each, the question and what a wrong answer does
    gx, gw = xs[2], widths[2]
    group(p, gx, gy, gw, gh, "5 guards before a review lands", qr=True)
    rh = (gh - 80) / len(GUARDS)
    for i, (q, outcome) in enumerate(GUARDS):
        y = gy + 46 + i * rh + rh / 2
        badge(p, gx + 30, y, i + 1, r=11)
        p.text(gx + 52, y, q, size=13.5, weight="bold")
        pill_right(p, gx + gw - 16, y, outcome, size=10.5)
        if i:
            p.c.plot([gx + 18, gx + gw - 18], [y - rh / 2] * 2, color=tint(p)["line"], lw=0.8, zorder=2)
    p.text(gx + gw / 2, gy + gh - 16, "a guard only refuses or softens", size=11, color=T["muted"], ha="center",
           va="baseline")
    # GitHub, outside
    hh = 128
    node(p, xs[3], gy + gh / 2 - hh / 2, widths[3], hh, "GitHub", "reviews, comments", icon_name="pr", style="ghost",
         **kw)
    arrow(p, (gx + gw + 2, gy + gh / 2), (xs[3] - 2, gy + gh / 2))
    # the rules that hold whatever a session does
    ry, rules_h = 538, 166
    group(p, LEFT, ry, RIGHT - LEFT, rules_h, "Standing rules")
    cws = [310] + [(RIGHT - LEFT - 32 - 310) / 3] * 3  # the first rule carries two numbers
    for i, (label, note, ic, pills) in enumerate(RULES):
        x = LEFT + 16 + sum(cws[:i])
        icon(p, ic, x + 16, ry + 62, 22, color=T["ink2"])
        p.text(x + 40, ry + 62, label, size=14, weight="bold")
        p.text(x + 40, ry + 90, note, size=11.5, color=T["ink2"])
        px = x + 40
        for t in pills:
            px += pill(p, px, ry + 128, t, size=10.5, qr=t[0].isdigit()) + 6
    p.source("Daemon writes outside the gate's closed list of 13 kinds are rejected at runtime. Tests prove the scripts' "
             "guards match the gate's.\nNo write kind can dismiss an approval or another identity's review.")
    return p


# ---------------------------------------------------------------- a PR's lifecycle
def tag(p, x, y, text, ok=None, size=11.5, color=None):
    """A transition's label centred on (x, y) over a patch of page colour, so it sits cleanly on a line; ok=True/False
    puts a tick or a cross before it."""
    T = p.T
    mark = 18 if ok is not None else 0
    w = measure(p, text, size) + mark + 10
    p.c.add_patch(FancyBboxPatch((x - w / 2, y - 11), w, 22, boxstyle="round,pad=0,rounding_size=4",
                                 facecolor=T["surface"], edgecolor="none", zorder=4))
    if ok is not None:
        check(p, x - w / 2 + 12, y, ok=ok, size=12)
    p.text(x - w / 2 + 5 + mark, y, text, size=size, color=color or T["ink2"], zorder=5)
    return w


def fig_lifecycle(B, V, T):
    """The states left to right; approve returns over the top, changes and a re-request loop underneath; the
    recheck and the replies are loops on their states; closed is the exit."""
    p = Page4(T, h=740)
    p.title("Five states, and none waits for a human verdict")
    p.metric("A pull request's life: what moves it between states, and what follows each verdict")
    top, h = 282, 112
    mid = top + h / 2
    widths = [162, 162, 162, 208]
    xs = row_x(widths, [(RIGHT - LEFT - sum(widths)) / 3] * 3)
    cx = [x + w / 2 for x, w in zip(xs, widths)]
    states = [("Tracked", "nothing owed", "eye", "plain"), ("Queued", "waits for a slot", "clock", "plain"),
              ("Reviewing", "a round runs", "search", "qr-solid"),
              ("Awaiting author", "author pushes, replies", "person", "plain")]
    kw = dict(icon_top=True, size=14, note_size=11.5)
    for x, w, (label, note, ic, st) in zip(xs, widths, states):
        node(p, x, top, w, h, label, note, icon_name=ic, style=st, **kw)
    # forward: a trigger queues it, a free slot starts the round, a blocker hands it to the author
    for i, words in ((0, ("label or", "team request")), (1, ("first come,", "first served"))):
        a, b = xs[i] + widths[i] + 2, xs[i + 1] - 2
        arrow(p, (a, mid), (b, mid))
        for j, ln in enumerate(words):
            p.text((a + b) / 2, mid - 40 + j * 17, ln, size=11, color=T["ink2"], ha="center")
    a, b = xs[2] + widths[2] + 2, xs[3] - 2
    arrow(p, (a, mid), (b, mid))
    tag(p, (a + b) / 2, mid - 24, "changes", ok=False)
    pill(p, cx[2], top + h + 30, "≤ 2 retries per head", ha="center", size=10.5)
    # approve: back to tracked, over the top
    ya = top - 70
    path_arrow(p, [(cx[2], top - 2), (cx[2], ya), (cx[0], ya), (cx[0], top - 2)])
    tag(p, (cx[0] + cx[1]) / 2, ya, "approve", ok=True)
    pill(p, (cx[1] + cx[2]) / 2 + 20, ya, "red CI: comment until green", ha="center", size=10.5)
    # the author's turn: replies stay on their thread; a re-request starts the next round
    loop = 44
    path_arrow(p, [(cx[3] + loop, top - 2), (cx[3] + loop, top - 52), (cx[3] - loop, top - 52),
                   (cx[3] - loop, top - 2)], lw=1.5)
    tag(p, cx[3], top - 52, "replies")
    w1 = pill_right(p, RIGHT, top - 90, "never change a verdict", size=10.5)
    pill_right(p, RIGHT - w1 - 8, top - 90, "≤ 3 exchanges per thread", size=10.5)
    yb = top + h + 84
    xq = xs[1] + widths[1] * 0.7
    path_arrow(p, [(cx[3], top + h + 2), (cx[3], yb), (xq, yb), (xq, top + h + 2)])
    xm = (cx[3] + xq) / 2
    tag(p, xm, yb, "re-request")
    for j, t in enumerate(("next round: only what changed", "round 3+: new nits inside it")):
        pill(p, xm, yb + 36 + j * 32, t, ha="center", size=10.5)
    # after approval: pushes, CI results and base moves are rechecked; the verdict can only flip to changes
    path_arrow(p, [(cx[0] - loop, top + h + 2), (cx[0] - loop, top + h + 52), (cx[0] + loop, top + h + 52),
                   (cx[0] + loop, top + h + 2)], lw=1.5)
    tag(p, cx[0], top + h + 52, "recheck")
    for j, t in enumerate(("on push, CI result or base move", "trivial change: nothing", "can only flip to changes")):
        pill(p, LEFT, top + h + 90 + j * 32, t, size=10.5)
    # closed: the exit, from any state; reopening returns to tracked
    y_closed = yb + 60
    node(p, xs[3], y_closed, widths[3], h, "Closed", "merged or closed", icon_name="flag", **kw)
    ym = y_closed + h / 2
    arrow(p, (xs[3] - 80, ym), (xs[3] - 2, ym), dashed=True, lw=1.5, head=9)
    p.text(xs[3] - 90, ym, "from any state", size=11.5, color=T["ink2"], ha="right")
    pill_right(p, xs[3] - 12, ym + 36, "reopened: back to tracked", size=10.5)
    p.source("A round's verdict is APPROVE or REQUEST_CHANGES; nothing mid-round interrupts it. P0–P2 findings are "
             "exempt from the round-3 nit rule.\nAfter 2 automatic retries at one head, an operator steps in.")
    return p


FIGURES = {
    "review-round": fig_review_round,
    "lenses": fig_lenses,
    "safety": fig_safety,
    "lifecycle": fig_lifecycle,
}

if __name__ == "__main__":
    import make_charts_v4
    sys.exit(1 if make_charts_v4.render(FIGURES, sys.argv[1:]) else 0)
