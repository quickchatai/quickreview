#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["matplotlib>=3.8"]
# ///
"""v4 infographics: how the 520-defect key was built, how the comparison was kept fair, how Martian and Qodo were run, and how a comment is scored.

Conventions: infographics_v4.py (the look, the two exemplars) and diagram_v4.py (the parts).
    uv run bench/aacr/showcase/info_bench_v4.py [names]   # draws this file's figures into out/v4/
"""
import os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from diagram_v4 import arrow, badge, check, group, icon, measure, node, pill, tint  # noqa: E402
from matplotlib.patches import Circle, FancyBboxPatch, Wedge  # noqa: E402
from theme_v4 import Page4  # noqa: E402,F401

QR = "quickreview"
W = 1072  # the drawing's width between the 64 px side margins


def verdict(p, x, y, ok, claim, aside=None, size=17, ha="center", band=True):
    """A tick or cross, a bold claim and a muted aside on one line; y is the text baseline, x its centre
    (ha='center') or left end. band=True sets it on a soft rounded band. Returns its width."""
    T = p.T
    cw = measure(p, claim, size, "bold")
    aw = measure(p, aside, size * 0.76) + 14 if aside else 0
    w = 30 + cw + aw
    x0 = x - w / 2 if ha == "center" else x
    if band:
        p.c.add_patch(FancyBboxPatch((x0 - 22, y - size * 1.1 - 12), w + 44, size * 1.39 + 26,
                                     boxstyle="round,pad=0,rounding_size=12", facecolor=tint(p)["wash"],
                                     edgecolor=tint(p)["line"], lw=1.0, zorder=1))
    check(p, x0 + 9, y - size * 0.36, ok=ok, size=size + 1)
    p.text(x0 + 30, y, claim, size=size, weight="bold", va="baseline")
    if aside:
        p.text(x0 + 30 + cw + 14, y, aside, size=size * 0.76, color=T["ink2"], va="baseline")
    return w


# ---------------------------------------------------------------- the AACR key: how the 520 defects were built
def fig_how_key(B, V, T):
    """The key, end to end: three candidate sources -> four blind checks -> the verified defects."""
    p = Page4(T)
    n_prs, total = B.aacr["cases"], B.total()
    refs = next(r for r in V.v3["official"]["aacr"].values() if r)["references"]  # AACR's own reference comments
    # bench docs (the key's build): 379 defects on the first 145 PRs, +15 from four more tools, 126 on the other 40 PRs
    first, more, later, main_prs = 379, 15, 126, 145
    if first + more + later != total:
        p.__dict__.setdefault("issues", []).append(f"the key's counts no longer add up to {total}")
    p.title("Defects checked in code, blind to who found them")
    p.metric(f"How the key of {total} verified defects was built for AACR-Bench's {n_prs} PRs")
    lane, lh = 246, 156  # the main lane's top and height
    mid = lane + lh / 2
    gw, sw, rw = 210, 132, 166  # the widths of the candidates, each step and the key
    wide = 39  # the two gaps that carry a running count
    gap = (W - gw - 4 * sw - rw - 2 * wide) / 3
    # the candidates: three sources pooled (counts from the bench docs)
    nh = 70
    gh = 38 + 3 * nh + 2 * 8 + 14
    gy = mid - gh / 2
    group(p, 64, gy, gw, gh, "Candidates")
    for i, (n, what) in enumerate((("235", "expert drafts"), (f"{refs:,}", "AACR references"),
                                   ("2,216", "reviewer comments"))):
        node(p, 78, gy + 38 + i * (nh + 8), gw - 28, nh, n, what, size=15, note_size=11.5)
    # the four checks, each blind to who raised the candidate
    xs = [64 + gw + gap + i * (sw + gap) + (wide - gap) * (i == 3) for i in range(4)]
    steps = [("Authors\nhidden", "anonymised, shuffled", "lock"),
             ("Checked\nin code", "29 verifiers", "search"),
             ("Adversarial\ncritics", "10 critics\n6 fixes", "flag"),
             ("Extended", "never changed", "plug")]
    for i, (x, (label, note, ic)) in enumerate(zip(xs, steps)):
        node(p, x, lane, sw, lh, label, note, icon_name=ic, icon_top=True, size=13, note_size=11.5, num=i + 1)
    arrow(p, (64 + gw + 2, mid), (xs[0] - 2, mid))
    for i in range(3):
        arrow(p, (xs[i] + sw + 2, mid), (xs[i + 1] - 2, mid))
    # the key itself, and the running count of defects on the arrows into it
    rx = xs[3] + sw + wide
    node(p, rx, lane, rw, lh, f"{total} defects", "verified in code", style="qr-solid", icon_name="list",
         icon_top=True, size=17, note_size=12)
    arrow(p, (xs[3] + sw + 2, mid), (rx - 2, mid))
    for x, n in ((xs[2] + sw, first), (xs[3] + sw, first + more)):
        p.text(x + wide / 2, mid - 15, str(n), size=12, weight="bold", color=T["ink2"], ha="center", va="baseline")
    for i, s in enumerate(("high", "medium", "low")):
        pill(p, rx + rw / 2, lane + lh + 30 + i * 34, f"{B.total({s})} {s}", ha="center")
    # later additions: four more tools on the same PRs, and 40 more PRs built the same way
    top, th = 142, 68
    for cx, w, label, note in ((xs[3] + sw / 2, 168, "4 more tools", "1,527 candidates"),
                               (rx + rw / 2, rw, f"{n_prs - main_prs} more PRs", f"same steps: +{later}")):
        node(p, cx - w / 2, top, w, th, label, note, style="ghost", size=13, note_size=11.5)
        arrow(p, (cx, top + th + 2), (cx, lane - 2))
    # what was rejected, and why
    by = lane + lh + 40
    node(p, xs[1], by, xs[3] + sw - xs[1], 68, "3,093 rejected", "each kept with its reason", icon_name="doc",
         size=14, note_size=11.5)
    for i in (1, 3):
        arrow(p, (xs[i] + sw / 2, lane + lh + 2), (xs[i] + sw / 2, by - 2), dashed=True)
    p.text(xs[1] + sw / 2 + 12, lane + lh + 21, "2,118 excluded", size=11.5, color=T["ink2"], va="center")
    # the honest part: AI agents built it; no person has checked it yet
    verdict(p, 600, 574, False, "No human check yet", "blinded 20-defect audit pending", size=16)
    # sources: bench docs (key build, contamination)
    p.source("Built by AI agents (Claude Code subagents on Opus 5.5). A defect is introduced or newly exposed by the PR and "
             f"has a statable consequence.\nQuickReview's earlier comments raised 334 of the first {first} defects; 162 of "
             f"the {total} are among AACR's own references.")
    return p


# ---------------------------------------------------------------- fairness: what was level, and what was not
def checklist(p, x, y, w, h, head, rows, ok):
    """A panel of rows [(label, note, icon)], each with a tick (ok) or a cross, under a bold header."""
    T, k = p.T, tint(p)
    p.c.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0,rounding_size=16", facecolor=k["wash"],
                                 edgecolor=k["line"], lw=1.0, zorder=1))
    p.text(x + 24, y + 38, head, size=16.5, weight="bold", va="baseline")
    top = y + 58
    pitch = (y + h - 12 - top) / len(rows)
    for i, (label, note, ic) in enumerate(rows):
        cy = top + pitch * (i + 0.5)
        if i:
            p.c.plot([x + 20, x + w - 20], [top + pitch * i] * 2, color=T["grid"], lw=1, zorder=2)
        check(p, x + 34, cy, ok=ok, size=17)
        icon(p, ic, x + 72, cy, 20, color=T["ink2"])
        p.text(x + 100, cy - 4, label, size=14.5, weight="bold", va="baseline")
        p.text(x + 100, cy + 17, note, size=12, color=T["ink2"], va="baseline")


def fig_how_fair(B, V, T):
    """What every AACR-Bench reviewer shared, and what was not level, as two checklists."""
    p = Page4(T, h=760)
    tools = B.aacr_tools()
    n, n_prs, total = len(tools), B.aacr["cases"], B.total()
    p.title("Same PRs, key and judge for all; caveats shown")
    p.metric(f"AACR-Bench · what all {n} reviewers shared on the {n_prs} PRs, and what was not level")
    # bench docs (fairness): the judge, the sandbox, prices, one run each, the best-shot lift (44->56, 52->68, 43->60)
    same = [(f"{n_prs} PRs", f"all {n_prs} judged", "pr"),
            (f"{total}-defect key", "verified in the code", "list"),
            ("One judge", "gpt-6-sol, high reasoning", "judge"),
            ("One sandbox", "locked-down container", "box"),
            ("Nothing posted", "no GitHub credential", "shield"),
            ("List prices", "tokens at list price, not bills", "coin"),
            ("One run each", "one review per PR", "terminal"),
            ("Best-shot settings", "lifted 3 rivals 12–17 pts", "gear")]
    # bench docs: who reads the PR text (QuickReview, OpenCode, PR-Agent), the judge's family, the tuning
    differ = [("Model family", "Claude Code on Opus 5.5", "bolt"),
              ("Inputs", "only 3 read title + body", "doc"),
              ("Budget", "not equalised; cost shown", "coin"),
              ("Judge's family", "same as the GPT tools", "judge"),
              ("Tuned on these PRs", "QuickReview mined 121 PRs' misses", "loop"),
              ("Human check", "none yet; audit pending", "person")]
    top, bottom, gap = 148, p.h - 84, 24
    cw = (W - gap) / 2
    checklist(p, 64, top, cw, bottom - top, f"Same for all {n}", same, ok=True)
    checklist(p, 64 + cw + gap, top, cw, bottom - top, "Not the same", differ, ok=False)
    p.source("Best-shot: each rival's published run, the variants its docs ship or recommend and a PR-text variant, "
             "picked on 40 seeded PRs by highest recall.\nCodex CLI ran with seccomp unconfined so its own sandbox works. "
             "The judge sees each comment's text: blind judging is not claimed.")
    return p


# ---------------------------------------------------------------- Martian: placing QuickReview on its board
def fig_how_martian(B, V, T):
    """Martian's Code Review Bench: the same code, Martian's own unmodified scorer, and our judge calibrated to its."""
    from make_charts_v4 import MARTIAN_JUDGE
    p = Page4(T, h=700)
    rows = V.martian_rows()
    published = len(rows) - 1
    jl = V.m["judges"][MARTIAN_JUDGE]["label"]
    cal = V.m["calibration"]
    rgap = max(abs(c["ours"]["recall"] - c[MARTIAN_JUDGE]["recall"]) for c in cal.values()) * 100
    pgap = [(c[MARTIAN_JUDGE]["precision"] - c["ours"]["precision"]) * 100 for c in cal.values()]
    p.title("Same code, Martian's own scorer, a calibrated judge")
    p.metric(f"How QuickReview was placed on Martian's Code Review Bench: the same {V.m['prs']} PRs as "
             f"{published} published tools")
    gy, gh = 240, 206  # the groups' top and height
    y, h = 276, 130  # the main row's nodes
    mid = y + h / 2
    # 1. the pull requests: five projects, the code every published tool reviewed
    node(p, 64, y, 146, h, f"{V.m['prs']} PRs", "5 projects", style="ghost", icon_name="pr", icon_top=True, num=1)
    for i, proj in enumerate(("Sentry", "Grafana", "Keycloak", "Discourse", "cal.com")):  # bench docs: 10 PRs each
        pill(p, 64 + 73, y + h + 30 + i * 31, proj, ha="center")
    # 2. QuickReview, once per PR, in the sandbox
    sx, sw = 238, 196
    group(p, sx, gy, sw, gh, "Sandbox")
    badge(p, sx, gy, 2)
    node(p, sx + 14, y, sw - 28, h, "QuickReview", "one review per PR", style="qr-solid", size=15, note_size=11.5)
    p.text(sx + sw / 2, gy + gh - 14, "nothing posted", size=11, color=T["muted"], ha="center", va="baseline")
    arrow(p, (64 + 146 + 2, mid), (sx + 12, mid))
    # 3. Martian's own pipeline, unmodified
    mx, stw, sg = sx + sw + 26, 104, 16
    xs = [mx + 16 + i * (stw + sg) for i in range(4)]
    mw = xs[-1] + stw + 16 - mx
    group(p, mx, gy, mw, gh, "Martian's pipeline, unmodified")
    badge(p, mx, gy, 3)
    for x, (label, note) in zip(xs, (("Extract\nissues", "location\ndropped"), ("Dedup", None),
                                      ("Judge\npairs", "golden vs\ncandidate"), ("Score", "F2 ranks"))):
        node(p, x, y, stw, h, label, note, size=13, note_size=11)
    arrow(p, (sx + sw - 12, mid), (xs[0] - 2, mid))
    for a, b in zip(xs, xs[1:]):
        arrow(p, (a + stw + 2, mid), (b - 2, mid))
    # the goldens the judge compares against, and what an audit of them found
    jx = xs[2] + stw / 2
    real, total = B.martian["real_goldens"], 173  # golden audit (bench docs): 173 goldens, 77 not real, 10 disputed
    node(p, jx - 90, 142, 180, 68, f"{V.m['goldens']} goldens", f"Core profile, of {total}", style="ghost", size=13,
         note_size=11.5)
    arrow(p, (jx, 212), (jx, y - 2))
    ax = jx + 114
    aw = 64 + W - ax
    p.text(ax, 164, f"Our audit: {real} of {total} real", size=13, weight="bold", va="baseline")
    x = ax
    for n, col in ((real, T["ink2"]), (77, T["other"]), (10, T["empty"])):
        w = aw * n / total
        p.c.add_patch(FancyBboxPatch((x, 176), max(w - 2, 1), 10, boxstyle="round,pad=0,rounding_size=2",
                                     facecolor=col, edgecolor="none", zorder=3))
        x += w
    p.text(ax, 206, "77 not real · 10 disputed", size=11, color=T["ink2"], va="baseline")
    # 4. the leaderboard: QuickReview beside the published tools
    lx = mx + mw + 26
    lw = 64 + W - lx
    node(p, lx, y, lw, h, "Leaderboard", f"{len(rows)} ranked by F2", style="qr", icon_name="chart", icon_top=True,
         num=4)
    arrow(p, (xs[-1] + stw + 2, mid), (lx - 2, mid))
    by = 478
    node(p, lx, by, lw, 88, f"{published} published\ntools", f"{jl} judge", style="ghost", size=13, note_size=11.5)
    arrow(p, (lx + lw / 2, by - 2), (lx + lw / 2, y + h + 2))
    # calibration: our judge re-grades three published tools
    cw = mx + mw - sx
    group(p, sx, by, cw, 122, "Our judge, calibrated")
    arrow(p, (jx, y + h + 2), (jx, by - 2), dashed=True)
    claim = f"Recall within {max(1, round(rgap))} pt of {jl}"
    x0 = sx + (cw - (200 + 46 + 30 + measure(p, claim, 15, "bold"))) / 2  # the row, centred in its panel
    node(p, x0, by + 38, 200, 68, f"{len(cal)} published tools", "re-judged by ours", size=13, note_size=11.5)
    arrow(p, (x0 + 202, by + 72), (x0 + 234, by + 72))
    verdict(p, x0 + 246, by + 68, True, claim, size=15, ha="left", band=False)
    p.text(x0 + 276, by + 94, f"precision {round(min(pgap))}–{round(max(pgap))} pts stricter", size=11.5,
           color=T["ink2"], va="baseline")
    p.source(f"Others: Martian's published scores ({jl} judge, Core profile). QuickReview: frozen build, judged by "
             "gpt-6.1-sol at low reasoning.\nGolden audit: one AI investigator per golden, reading only the code; a "
             "second on every non-real verdict. No human check.")
    return p


# ---------------------------------------------------------------- Qodo: placing QuickReview on its benchmark
def fig_how_qodo(B, V, T):
    """Qodo's PR-Review-Bench: nine vendor runs read from Qodo's forks plus four tools run by us, one judge for all."""
    p = Page4(T, h=700)
    rows = V.qodo_rows()
    pub = V.pub["qodo"]["tools"]
    vendors = [t for t, _, _ in rows if t in pub]
    ours = [QR] + sorted((t for t, _, _ in rows if t not in pub and t != QR), key=lambda t: B.name(t).lower())
    q = B.qodo["tools"][QR]
    n_issues, n_rule, n_prs = q["issues"], q["rule_issues"], q["prs"]
    gaps = V.qodo_gaps()
    tol = 1.3  # bench docs: our judge lands within 0.1-1.3 F1 points of Qodo's published figure for 6 of 9 vendors
    close = sum(1 for g in gaps.values() if g <= tol)
    worst = max(gaps.values())
    p.title(f"One judge for all {len(rows)}, calibrated to Qodo's scores")
    p.metric(f"How QuickReview was placed on Qodo's PR-Review-Bench: {n_prs} PRs, {n_issues} injected issues, "
             f"{len(rows)} reviewers")
    gy, gw, th = 228, 300, 42  # the reviewers' group; the pitch of its tool rows
    gh = 38 + 66 + 30 + len(ours) * th - 6 + 16
    mid = gy + gh / 2
    # 1. the pull requests
    node(p, 64, mid - 65, 148, 130, f"{n_prs} PRs", "8 repos", style="ghost", icon_name="pr", icon_top=True,
         num=1)  # bench docs: Ghost, aspnetcore, cal.com, dify, firefox-ios, prefect, redis, tauri
    # 2. thirteen reviewers: nine vendor runs as published, four run by us
    gx = 64 + 148 + 32
    group(p, gx, gy, gw, gh, f"{len(rows)} reviewers")
    badge(p, gx, gy, 2)
    node(p, gx + 16, gy + 38, gw - 32, 66, f"{len(vendors)} vendor runs", "from Qodo's public forks", style="ghost",
         icon_name="cloud", size=13.5, note_size=11.5)
    p.text(gx + 16, gy + 126, "RUN BY US · NOTHING POSTED", size=10.5, weight="bold", color=T["muted"],
           va="baseline")
    for i, t in enumerate(ours):
        node(p, gx + 16, gy + 138 + i * th, gw - 32, th - 6, B.name(t), style="qr-solid" if t == QR else "plain",
             size=13, radius=8)
    arrow(p, (64 + 148 + 2, mid), (gx - 2, mid))
    # 3. one judge, matching inline comments to issues one to one, against the injected issues
    jx, jw = gx + gw + 44, 208
    node(p, jx, mid - 65, jw, 130, "One judge", "inline comments,\none-to-one", icon_name="judge", icon_top=True,
         size=14, note_size=11.5, num=3)
    arrow(p, (gx + gw + 2, mid), (jx - 2, mid))
    node(p, jx + jw / 2 - 120, 142, 240, 68, f"{n_issues} injected issues",
         f"{n_issues - n_rule} bugs · {n_rule} rule breaks", style="ghost", size=13, note_size=11.5)
    arrow(p, (jx + jw / 2, 212), (jx + jw / 2, mid - 67))
    # 4. the scores
    sx = jx + jw + 40
    node(p, sx, mid - 65, 64 + W - sx, 130, "Precision, recall, F1", f"for all {len(rows)} reviewers", style="qr",
         icon_name="chart", icon_top=True, num=4)
    arrow(p, (jx + jw + 2, mid), (sx - 2, mid))
    # calibration: the same judge re-grades the vendors' runs Qodo published scores for
    cy, cw = mid + 65 + 46, 64 + W - jx
    group(p, jx, cy, cw, 114, "Our judge, calibrated")
    arrow(p, (jx + jw / 2, mid + 67), (jx + jw / 2, cy - 2), dashed=True)
    claim = f"Within {tol} pts of Qodo's F1"
    x0 = jx + (cw - (170 + 46 + 30 + measure(p, claim, 14.5, "bold"))) / 2
    ny = cy + 34
    node(p, x0, ny, 170, 66, f"{len(vendors)} vendor runs", "re-judged by ours", size=13, note_size=11.5)
    arrow(p, (x0 + 172, ny + 33), (x0 + 204, ny + 33))
    verdict(p, x0 + 216, ny + 30, True, claim, size=14.5, ha="left", band=False)
    p.text(x0 + 246, ny + 55, f"{close} of {len(vendors)} runs · same ranking", size=11.5, color=T["ink2"],
           va="baseline")
    p.source("Vendor runs: January 2026, default settings. Ours, offline: gpt-6.1-sol, one review per PR, each PR rebuilt "
             "as two neutral commits to hide the injection.\nOne judge, gpt-6.1-sol at low reasoning, matches by meaning; the "
             f"other {len(vendors) - close} vendor runs land within {worst:.1f} pts of Qodo's own F1.")
    return p


# ---------------------------------------------------------------- scoring: recall and precision in one picture
def issue(p, x, y, state, r=11, z=4):
    """One known issue: found (the accent), missed (grey) or partly found (half and half)."""
    T = p.T
    if state == "partial":
        p.c.add_patch(Wedge((x, y), r, 90, 270, facecolor=T["qr"], edgecolor="none", zorder=z))
        p.c.add_patch(Wedge((x, y), r, -90, 90, facecolor=T["other"], edgecolor="none", zorder=z))
    else:
        p.c.add_patch(Circle((x, y), r, facecolor=T["qr"] if state == "found" else T["other"], edgecolor="none",
                             zorder=z))


def comment(p, x, y, state, w=26, h=18, z=4):
    """One review comment: it states a known issue (the accent) or is extra (an outline, dashed when big enough)."""
    T = p.T
    match = state == "match"
    p.c.add_patch(FancyBboxPatch((x - w / 2, y - h / 2), w, h, boxstyle=f"round,pad=0,rounding_size={h * 0.3}",
                                 facecolor=T["qr"] if match else "none", edgecolor="none" if match else T["muted"],
                                 lw=1.3 if w > 16 else 1.0, ls=(0, (2.5, 2)) if w > 16 else "-", zorder=z))


def bracket(p, x0, x1, y, label, below=False, strong=False):
    """A thin bracket over (or under) a run of marks, with its label."""
    T = p.T
    d = -6 if below else 6
    p.c.plot([x0, x0, x1, x1], [y + d, y, y, y + d], color=T["muted"], lw=1.1, zorder=3, solid_joinstyle="round")
    p.text((x0 + x1) / 2, y + (20 if below else -9), label, size=12.5, ha="center", va="baseline",
           color=T["ink"] if strong else T["ink2"], weight="bold" if strong else "normal")


def fraction(p, x, y, name, top, bottom, value, caption, vx, pitch=16):
    """A worked ratio drawn with the marks themselves: top over bottom = value, the value set at vx.
    (x, y) is the name's baseline."""
    T = p.T
    p.text(x, y, name, size=15, weight="bold", va="baseline")
    draw = (lambda gx, gy, st: issue(p, gx, gy, st, r=6)) if top[0] == "found" else \
        (lambda gx, gy, st: comment(p, gx, gy, st, w=13, h=9))
    wb = pitch * len(bottom)
    for i, st in enumerate(top):
        draw(x + (wb - pitch * len(top)) / 2 + pitch * (i + 0.5), y + 21, st)
    p.c.plot([x, x + wb], [y + 34] * 2, color=T["ink2"], lw=1.4, zorder=3)
    for i, st in enumerate(bottom):
        draw(x + pitch * (i + 0.5), y + 47, st)
    p.text(vx, y + 43, f"= {value}", size=24, weight="bold", va="baseline")
    p.text(x, y + 76, caption, size=12, color=T["ink2"], va="baseline")


def fig_how_scoring(B, V, T):
    """Recall and precision drawn with marks, then how each of the three benchmarks counts a review."""
    p = Page4(T, h=760)
    p.title("Finding raises recall; extra comments lower precision")
    p.metric("How a review is scored against a list of known issues, and how each benchmark counts")
    found, missed, extra = 6, 4, 6  # an example review: 10 known issues, 12 comments
    r1, r2 = 214, 324  # the two rows: known issues, review comments
    x0, pitch, gap = 288, 38, 30
    p.text(64, r1, "Known issues", size=14, weight="bold")
    p.text(64, r2, "Review comments", size=14, weight="bold")
    fx = [x0 + pitch * i for i in range(found)]
    mx = [fx[-1] + pitch + gap + pitch * i for i in range(missed)]
    ex = [fx[-1] + pitch + gap + pitch * i for i in range(extra)]
    for x in fx:  # each found issue and the comment that states it
        p.c.plot([x, x], [r1 + 13, r2 - 11], color=T["qr"], lw=1.6, zorder=3)
        issue(p, x, r1, "found")
        comment(p, x, r2, "match")
    for x in mx:
        issue(p, x, r1, "missed")
    for x in ex:
        comment(p, x, r2, "extra")
    bracket(p, fx[0] - 14, fx[-1] + 14, r1 - 26, f"{found} found", strong=True)
    bracket(p, mx[0] - 14, mx[-1] + 14, r1 - 26, f"{missed} missed")
    bracket(p, fx[0] - 14, fx[-1] + 14, r2 + 24, f"{found} match an issue", below=True, strong=True)
    bracket(p, ex[0] - 14, ex[-1] + 14, r2 + 24, f"{extra} extra", below=True)
    # the two ratios, worked with the same marks
    rx = 812
    vx = rx + 16 * (found + extra) + 22
    n = found + missed
    fraction(p, rx, 176, "Recall", ["found"] * found, ["found"] * found + ["missed"] * missed,
             f"{round(100 * found / n)}%", "found ÷ known issues", vx)
    fraction(p, rx, 290, "Precision", ["match"] * found, ["match"] * found + ["extra"] * extra,
             f"{round(100 * found / (found + extra))}%", "matching ÷ all comments", vx)
    # how each benchmark counts
    top = 452
    p.text(64, top, "HOW EACH BENCHMARK COUNTS", size=11, weight="bold", color=T["muted"], va="baseline")
    cards = [("Our AACR key", ["Whole review read", "Found 1 · partly ½", "Extras: no penalty", "Recall; comments graded"]),
             ("Martian", ["Issues extracted, deduped", "Judged, location dropped", "Extras cost precision", "F2 ranks"]),
             ("Qodo", ["Inline comments only", "One-to-one, by meaning", "Extras cost precision", "F1 headline"])]
    cw, cg = (W - 2 * 20) / 3, 20
    k = tint(p)
    for c, (name, rows) in enumerate(cards):
        x = 64 + c * (cw + cg)
        p.c.add_patch(FancyBboxPatch((x, top + 16), cw, 206, boxstyle="round,pad=0,rounding_size=12",
                                     facecolor=k["fill"], edgecolor=k["line"], lw=1.2, zorder=1))
        p.text(x + 20, top + 50, name, size=15, weight="bold", va="baseline")
        for i, s in enumerate(rows):
            y = top + 86 + i * 36
            gx = x + 32
            if i == 0:
                icon(p, "doc", gx, y, 17, color=T["ink2"])
            elif i == 1:
                if c == 0:
                    issue(p, gx, y, "partial", r=8)
                else:
                    issue(p, gx - 8, y, "found", r=5)
                    p.c.plot([gx - 3, gx + 3], [y, y], color=T["qr"], lw=1.4, zorder=3)
                    comment(p, gx + 9, y, "match", w=11, h=8)
            elif i == 2:
                comment(p, gx, y, "extra", w=20, h=14)
            else:
                icon(p, "chart", gx, y, 17, color=T["ink2"])
            p.text(x + 56, y, s, size=13, color=T["ink2"])
    p.source("Martian and Qodo count every unmatched comment against precision, whether a real bug their list lacks, a "
             "nit or a wrong claim.\nOur AACR key reads the whole review and grades each comment. Partly found: right "
             "problem or site, mechanism or consequence wrong or missing.")
    return p


FIGURES = {
    "how-key": fig_how_key,
    "how-fair": fig_how_fair,
    "how-martian": fig_how_martian,
    "how-qodo": fig_how_qodo,
    "how-scoring": fig_how_scoring,
}

if __name__ == "__main__":
    import make_charts_v4
    sys.exit(1 if make_charts_v4.render(FIGURES, sys.argv[1:]) else 0)
