#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["matplotlib>=3.8"]
# ///
"""v4 infographics: the learning loop, where QuickReview can be extended, what runs where, and the setup path.

Conventions: infographics_v4.py (the look, the two exemplars) and diagram_v4.py (the parts).
    uv run bench/aacr/showcase/info_platform_v4.py [names]   # draws this file's figures into out/v4/
"""
import os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from matplotlib.patches import Circle, FancyBboxPatch  # noqa: E402
from diagram_v4 import arrow, group, icon, lines, measure, node, path_arrow, pill, text_block, tint  # noqa: E402
from theme_v4 import Page4  # noqa: E402,F401

QR = "quickreview"


def cover(p, x, y, w, h, radius=10):
    """A surface-coloured box under a ghost node, so a line behind it does not show through."""
    p.c.add_patch(FancyBboxPatch((x, y), w, h, boxstyle=f"round,pad=0,rounding_size={radius}",
                                 facecolor=p.T["surface"], edgecolor="none", zorder=2.5))


def radios(p, cx, y, options, pitch=30):
    """A setting's options, one per row, centred on cx: a filled dot for the one that ships, its name, what it does."""
    T = p.T
    tab = max(measure(p, name, 12.5, "bold") for name, _, _ in options) + 32
    x = cx - (tab + max(measure(p, note, 11.5) for _, note, _ in options)) / 2
    for i, (name, note, on) in enumerate(options):
        yy = y + i * pitch
        p.c.add_patch(Circle((x + 7, yy), 7, facecolor=T["qr"] if on else "none", edgecolor=T["qr"], lw=1.6,
                             zorder=5))
        p.text(x + 22, yy, name, size=12.5, weight="bold", color=T["ink"], zorder=5)
        p.text(x + tab, yy, note, size=11.5, color=T["ink2"], zorder=5)


def pill_rows(p, cx, y, rows, pitch=32, gap=8):
    """Rows of plain pills, each row centred on cx."""
    for r, row in enumerate(rows):
        widths = [measure(p, s, 11.5) + 22 for s in row]
        x = cx - (sum(widths) + gap * (len(row) - 1)) / 2
        for s, wd in zip(row, widths):
            pill(p, x, y + r * pitch, s)
            x += wd + gap


def feature(p, x, y, w, icon_name, label, note):
    """One extension point: an icon, a bold label and a short note under it; (x, y) is the top-left."""
    T = p.T
    icon(p, icon_name, x + 11, y + 12, 20, color=T["qr"])
    rows = [(ln, 13.5, "bold", T["ink"]) for ln in lines(p, label, w - 34, 13.5, "bold")]
    rows += [(ln, 11.5, "normal", T["ink2"]) for ln in lines(p, note, w - 34, 11.5)]
    return text_block(p, x + 34, y, rows)


# ---------------------------------------------------------------- the learning loop
def fig_learning_loop(B, V, T):
    """The learning loop: what becomes of each posted finding, and how it returns as a lesson in a later round."""
    p = Page4(T, h=720)
    p.title("Learns from what your team does with its comments")
    p.metric("Each comment's fate becomes evidence, curated daily into typed lessons for later rounds")
    w, h = 214, 104
    left, right, top, bot = 66, 1134, 236, 500  # the track: one loop through every step
    x0 = left + 30
    gap = (right - 30 - x0 - 4 * w) / 3
    xs = [x0 + i * (w + gap) for i in range(4)]
    p.c.add_patch(FancyBboxPatch((left, top), right - left, bot - top, boxstyle="round,pad=0,rounding_size=40",
                                 facecolor="none", edgecolor=T["muted"], lw=1.8, zorder=1))
    upper = [("Posted findings", "on the pull request", "chat", "qr", 1),
             ("Your team", "fix, reply, [feedback]", "people", "ghost", None),
             ("Outcomes", "fixed · refuted · upheld · open", "list", "qr", 2),
             ("Miner", "plain code, no AI", "gear", "qr", 3)]
    lower = [("Daily curation", "end-of-day sweep, receipt checked", "clock", "qr", 4),
             ("Typed lessons", "lens, class, paths, evidence", "book", "qr-solid", 5),
             ("Per-round selection", "by lens and path", "search", "qr", 6),
             ("Validator", "may lower, never kill", "judge", "qr", 7)]
    for row, cy, cols in ((upper, top, range(4)), (lower, bot, range(3, -1, -1))):
        for i, (label, note, ic, st, num) in zip(cols, row):
            if st == "ghost":
                cover(p, xs[i], cy - h / 2, w, h)
            node(p, xs[i], cy - h / 2, w, h, label, note, style=st, icon_name=ic, num=num, size=14, note_size=11.5)
    for i in range(3):  # the heads on the track
        arrow(p, (xs[i] + w + 2, top), (xs[i + 1] - 2, top))
        arrow(p, (xs[i + 1] - 2, bot), (xs[i] + w + 2, bot))
    mid = (top + bot) / 2
    arrow(p, (left, mid + 18), (left, mid - 18))
    arrow(p, (right, mid - 18), (right, mid + 18))
    # inside the loop: the finding cases kept beside the miner, and the operator's kill switch on delivery
    ih = 90
    node(p, xs[2], mid - ih / 2, w, ih, "Finding cases", "one per answered finding", icon_name="db", size=13.5,
         note_size=11.5, style="qr")
    arrow(p, (xs[2] + w / 2, top + h / 2 + 2), (xs[2] + w / 2, mid - ih / 2 - 2))
    path_arrow(p, [(xs[2] + w + 2, mid), (xs[3] + w / 2, mid), (xs[3] + w / 2, bot - h / 2 - 2)])
    node(p, xs[1], mid - ih / 2, w, ih, "Kill switch", "operator only", icon_name="lock", size=13.5,
         note_size=11.5)
    arrow(p, (xs[1] + w / 2, mid + ih / 2 + 2), (xs[1] + w / 2, bot - h / 2 - 2), dashed=True)
    # under the loop: what survives the validator, how delivery ships, the four kinds, the daily cap
    ry = bot + h / 2 + 30
    pill(p, xs[0] + w / 2, ry + 15, "P0 always survives", qr=True, ha="center")
    radios(p, xs[1] + w / 2, ry, [("shadow", "records only (default)", True), ("on", "delivers to lens tasks", False)])
    pill_rows(p, xs[2] + w / 2, ry, [("repo-fact", "look-for"), ("dont-raise", "convention")])
    pill(p, xs[3] + w / 2, ry + 15, "≤ 40 candidates a day", ha="center")
    p.source("A [feedback] comment acts the same day, as a rule that only lets the validator lower a finding.\n"
             "Changes to the lens prompts themselves land only when a person accepts them with one click.")
    return p


# ---------------------------------------------------------------- where it can be extended
def fig_extensibility(B, V, T):
    """Sixteen extension points in four groups, plugged into one review core whose original prompts stay frozen."""
    p = Page4(T, h=740)
    p.title("Where you can extend it")
    p.metric("Sixteen extension points in four groups, all plugged into one review core")
    groups = [
        ("Tune the review", [("doc", "Repo profile", "extends a base profile"),
                             ("gear", "Per-lens tuning", "on/off, tier, effort, ceiling"),
                             ("chart", "Presets & tiers", "low, default or max"),
                             ("db", "Memory & lessons", "off, shadow or on")]),
        ("Add checks", [("book", "House-rule addenda", "your rules in Markdown"),
                        ("bolt", "Selection heuristics", "extra triggers, add-only"),
                        ("search", "New sub-lens", "one file, one trigger"),
                        ("box", "Ecosystem pre-check", "per-framework checks")]),
        ("Shape the output", [("list", "Posting policy", "comment budget, style"),
                              ("flag", "Nits strict/open", "drop trivial, or post all"),
                              ("branch", "Duplicate merge", "one comment per cause"),
                              ("shield", "Guards & rechecks", "each trigger switchable")]),
        ("Connect & operate", [("person", "Escalation", "pings a person; default off"),
                               ("chat", "Chat concierge", "thread per PR; default off"),
                               ("eye", "Setup & scan", "survey, interview, scan"),
                               ("terminal", "TUI & companion", "8 tabs + local assistant")]),
    ]
    gw, gh, gap = 524, 172, 24
    gx = [64, 64 + gw + gap]
    gy = [148, 488]
    core_y = (gy[0] + gh + gy[1]) / 2 - 8
    # the bus every group plugs into, with the core on it
    p.c.plot([gx[0] + gw / 2, gx[1] + gw / 2], [core_y, core_y], color=T["muted"], lw=1.8, zorder=1)
    for i, (name, items) in enumerate(groups):
        x, y = gx[i % 2], gy[i // 2]
        group(p, x, y, gw, gh, name)
        cx = x + gw / 2
        p.c.plot([cx, cx], [y + gh if y < core_y else y, core_y], color=T["muted"], lw=1.8, zorder=1)
        p.c.add_patch(Circle((cx, core_y), 5, facecolor=T["muted"], edgecolor="none", zorder=2))
        cw = (gw - 52) / 2
        for j, (ic, label, note) in enumerate(items):
            feature(p, x + 18 + (j % 2) * (cw + 16), y + 44 + (j // 2) * 62, cw, ic, label, note)
    node(p, 600 - 170, core_y - 38, 340, 76, "Review core", "9 lens + 4 system prompts, frozen",
         style="qr-solid", icon_name="lock", size=15, note_size=11.5)
    p.text(600, core_y + 38 + 20, "behaviour changes go through addenda", size=11.5, color=T["ink2"], ha="center")
    p.source("The original prompts are hash-frozen: behaviour changes go through addenda appended to the built prompts "
             "(74 ship built in), never edits.\nEscalation and the chat concierge ship switched off.")
    return p


# ---------------------------------------------------------------- what runs where
def fig_deployment(B, V, T):
    """What runs where: one review container on the server, the services it calls, and the operator's machine."""
    p = Page4(T, h=800)
    p.title("One container, one local port, nothing else exposed")
    p.metric("What runs where: the review container, the services it calls, and the operator's own machine")
    sx0, sx1 = 194, 910  # the server and the operator's machine share these edges
    cx0, cx1, cy0 = 346, 870, 186
    cw, rh = 220, 100
    cb = cx1 - 14 - cw
    ca = cb - 16 - cw
    r1 = cy0 + 46
    r2 = r1 + rh + 14
    cy1 = r2 + rh + 18
    group(p, sx0, 150, sx1 - sx0, cy1 + 22 - 150, "Server")
    group(p, cx0, cy0, cx1 - cx0, cy1 - cy0, "Review container", qr=True)
    pill(p, cx1 - 16 - measure(p, "2 CPU · 8 GiB", 11.5) - 22, cy0 + 22, "2 CPU · 8 GiB")
    parts = [(ca, r1, "Daemon", "webhooks, polling, gated writes", "gear", "qr-solid"),
             (cb, r1, "Review sessions", "per PR + overseer", "terminal", "qr"),
             (ca, r2, "Memory server", "local embedder; inside only", "db", "qr"),
             (cb, r2, "State volume", "database, heartbeat, worktrees", "box", "plain")]
    for x, y, label, note, ic, st in parts:
        node(p, x, y, cw, rh, label, note, style=st, icon_name=ic, size=14, note_size=11.5)
    # outside, left: GitHub reaches the daemon only through the tunnel and the one port
    gx1 = 174
    lane_in, lane_out = r1 + 28, r1 + rh - 22
    node(p, 64, r1 - 28, gx1 - 64, rh + 56, "GitHub App", "short-lived tokens", style="ghost", icon_name="pr",
         icon_top=True, size=14, note_size=11.5)
    tx, tw = 196, 92
    node(p, tx, lane_in - 34, tw, 68, "Tunnel", "dials out", size=13.5, note_size=11)
    arrow(p, (gx1 + 2, lane_in), (tx - 2, lane_in))
    arrow(p, (tx + tw + 2, lane_in), (ca - 2, lane_in))
    pill(p, cx0, lane_in, "1 port", qr=True, ha="center")  # the only way in, set in the container's wall
    arrow(p, (ca - 2, lane_out), (gx1 + 2, lane_out))
    p.text((sx0 + cx0) / 2, lane_out + 25, "polling and\ngated writes", size=11.5, color=T["ink2"], ha="center",
           va="center")
    # outside, right: what the container calls out to
    ox, oh, og = 932, 68, 20
    oy0 = cy0 + (cy1 - cy0 - 3 * oh - 2 * og) / 2
    for i, (label, note) in enumerate((("Model provider", "model calls"), ("Package registries", "source, never run"),
                                       ("Chat concierge", "optional"))):
        y = oy0 + i * (oh + og)
        node(p, ox, y, 1136 - ox, oh, label, note, style="ghost", size=13.5, note_size=11)
        arrow(p, (cx1 + 2, y + oh / 2), (ox - 2, y + oh / 2), dashed=i == 2)
    # the operator's machine: a relay into memory, the companion, and the TUI that reads the state
    by0 = cy1 + 52
    ow, oy, ohh = 164, by0 + 38, 152
    relay_c, tui_c = ca + 20, cb + cw - 40
    comp_c = (relay_c + tui_c) / 2
    group(p, sx0, by0, sx1 - sx0, ohh + 52, "Operator's machine")
    for c, label, note, ic in ((relay_c, "Memory relay", "no open port", "plug"),
                               (comp_c, "Companion assistant", "read-only GitHub token", "chat"),
                               (tui_c, "Operator TUI", "updates every 3\u00a0s", "terminal")):
        node(p, c - ow / 2, oy, ow, ohh, label, note, style="qr", icon_name=ic, icon_top=True, size=13.5,
             note_size=11.5)
    arrow(p, (comp_c - ow / 2 - 2, oy + ohh / 2), (relay_c + ow / 2 + 2, oy + ohh / 2))
    arrow(p, (comp_c + ow / 2 + 2, oy + ohh / 2), (tui_c - ow / 2 - 2, oy + ohh / 2))
    arrow(p, (relay_c, oy - 2), (relay_c, cy1 - 16), dashed=True)
    arrow(p, (tui_c, cy1 - 16), (tui_c, oy - 2), label="state over ssh", label_pos=0.5, label_dy=0)
    p.source("By default the model provider is the only place content is sent; packages are fetched as source and "
             "never installed or run.\nThe port is bound to the local machine by default. The tunnel is one of four "
             "ingress options, polling only among them.")
    return p


# ---------------------------------------------------------------- setup and the whole-repo scan
def tier(p, x, y, n, label, qr=False):
    """A validity tier as a pill: n of three dots filled (how sure), then its name; (x, y) is its left middle."""
    T, k = p.T, tint(p)
    tw = measure(p, label, 11.5, "bold" if qr else "normal")
    w = 22 + 3 * 11 + 6 + tw
    p.c.add_patch(FancyBboxPatch((x, y - 13), w, 26, boxstyle="round,pad=0,rounding_size=13",
                                 facecolor=k["qr_fill"] if qr else k["fill"], edgecolor="none", zorder=5))
    col = T["qr"] if qr else T["ink2"]
    for d in range(3):
        p.c.add_patch(Circle((x + 15 + d * 11, y), 3.6, facecolor=col if d < n else "none", edgecolor=col, lw=1.2,
                             zorder=6))
    p.text(x + 15 + 3 * 11 + 2, y, label, size=11.5, color=col, weight="bold" if qr else "normal", zorder=6)
    return w


def fig_setup_scan(B, V, T):
    """From a new repo to a tuned reviewer: the six setup steps, and the whole-repo scan in detail."""
    p = Page4(T, h=700)
    p.title("From a new repo to a tuned reviewer")
    p.metric("The setup path in six steps, with the whole-repo scan opened up below")
    steps = [("Survey & interview", "produce the profile", "eye", "qr"),
             ("Repo profile", "per-repo tuning", "doc", "qr"),
             ("Whole-repo scan", "stage 1, then stage 2", "search", "qr-solid"),
             ("Triage", "ticket or dismiss", "person", "ghost"),
             ("Re-tune", "the repo profile", "gear", "qr"),
             ("Deploy", "the tuned reviewer", "flag", "plain")]
    w, h, y1 = 152, 156, 166
    gap = (1072 - 6 * w) / 5
    xs = [64 + i * (w + gap) for i in range(6)]
    for i, (x, (label, note, ic, st)) in enumerate(zip(xs, steps)):
        node(p, x, y1, w, h, label, note, style=st, icon_name=ic, icon_top=True, size=14, note_size=11.5, num=i + 1)
        if i:
            arrow(p, (xs[i - 1] + w + 2, y1 + h / 2), (x - 2, y1 + h / 2))
    # step 3 opened up: in from above, out to triage
    py0, py1 = 386, 596
    group(p, 64, py0, 1072, py1 - py0, "Step 3 · whole-repo scan", qr=True)
    zx = xs[2] + w / 2
    p.c.plot([zx, zx], [y1 + h + 2, py0], color=T["qr"], lw=1.4, ls=(0, (2, 3)), zorder=1)
    mid = (py0 + py1 + 22) / 2 - 16
    s1x, s2x, sw, sh = 100, 316, 160, 68
    node(p, s1x, mid - sh / 2, sw, sh, "Stage 1", None, style="qr", icon_name="search", size=14)
    node(p, s2x, mid - sh / 2, sw, sh, "Stage 2", None, style="qr", icon_name="eye", size=14)
    arrow(p, (s1x + sw + 2, mid), (s2x - 2, mid))
    vx, vw, vh = 560, 236, 96
    node(p, vx, mid - vh / 2, vw, vh, "Sceptical validator", "sorts every finding", style="qr", icon_name="judge",
         size=14, note_size=11.5)
    arrow(p, (s2x + sw + 2, mid), (vx - 2, mid))
    # the hard stop over both stages
    by = mid + sh / 2 + 22
    p.c.plot([s1x, s1x, s2x + sw, s2x + sw], [by - 8, by, by, by - 8], color=T["muted"], lw=1.4, zorder=2)
    stop = "hard cost stop"
    lx = (s1x + s2x + sw) / 2 - (measure(p, stop, 12, "bold") + 26) / 2
    icon(p, "coin", lx + 9, by + 22, 18, color=T["ink2"])
    p.text(lx + 26, by + 22, stop, size=12, weight="bold", color=T["ink2"])
    # the three validity tiers, and on to triage
    tx = 890
    widths = []
    for i, (name, n, qr) in enumerate((("confirmed", 3, True), ("likely", 2, False), ("doubtful", 1, False))):
        ty = mid + (i - 1) * 42
        arrow(p, (vx + vw + 2, mid), (tx - 4, ty))
        widths.append(tier(p, tx, ty, n, name, qr=qr))
    bx = tx + max(widths) + 14  # a bracket round all three: every finding goes on to triage
    p.c.plot([bx - 8, bx, bx, bx - 8], [mid - 55, mid - 55, mid + 55, mid + 55], color=T["qr"], lw=1.4, zorder=2)
    ex, ey = bx + 34, (y1 + h + py0) / 2
    path_arrow(p, [(bx, mid), (ex, mid), (ex, ey), (xs[3] + w / 2, ey), (xs[3] + w / 2, y1 + h + 2)], dashed=True,
               color=T["qr"], lw=1.4)
    p.source("The repo profile inherits a base profile; the repo's own value wins, setting by setting.")
    return p


FIGURES = {
    "learning-loop": fig_learning_loop,
    "extensibility": fig_extensibility,
    "deployment": fig_deployment,
    "setup-scan": fig_setup_scan,
}

if __name__ == "__main__":
    import make_charts_v4
    sys.exit(1 if make_charts_v4.render(FIGURES, sys.argv[1:]) else 0)
