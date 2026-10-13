"""v3's ten idea-* figures: new angles on the results, in v2's one-chart style.

make_charts_v3.py draws them beside the radar-*, honest-* and official-* figures, into
out/v3/. One section per figure, in the order of FIGURES. Each defines
fig_idea_<slug>(B, V, T) -> Page and numbers_idea_<slug>(B, V) -> its section of
out/v3/NUMBERS.md; helpers are named _<slug>_*, constants <SLUG>_*. A figure that needs
more than data/aacr.json reads V.d["ideas"]["idea-<name>"], built by ideas_v3_data.py
(through refresh_v3.py). make_charts_v3.main() imports this module, not its top level:
this module imports make_charts_v3's helpers.
"""
import collections, fractions, functools, math, operator, random, statistics
from fractions import Fraction

from make_charts import HIGH, QR, SERIOUS, fmt, pct
from make_charts_v2 import dot
from make_charts_v3 import OCT1, axes_box, light, rivals
from matplotlib.patches import Circle, FancyBboxPatch, Polygon
from theme_v2 import Page, bar


# ---------------------------------------------------------------- idea-rare-finds: QuickReview's share of each group
#   of defects, grouped by how many of the six others found them.
RARE_FINDS_FOUND = 0.5  # a rival "found" a defect at credit >= this: found, or partly found
RARE_FINDS_SEED = 20261013  # the brief's PR bootstrap: 5,000 resamples of the PRs from this seed
RARE_FINDS_RESAMPLES = 5000
RARE_FINDS_WORDS = {1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight",
                    9: "nine"}


def _rare_finds_word(n):
    return RARE_FINDS_WORDS.get(n, str(n))


def _rare_finds_k(x, others):
    """How many of `others` found defect x (credit >= RARE_FINDS_FOUND); None when a credit is missing."""
    cr = [x["credit"].get(t) for t in others]
    return None if any(v is None for v in cr) else sum(1 for v in cr if v >= RARE_FINDS_FOUND)


def _rare_finds_columns(B, tool=QR):
    """The defects grouped by how many of QuickReview's rivals found each: one dict per count k = 0..len(rivals)
    with the defects `n`, their PRs, `tool`'s summed credit (`share` = credit / n, None when n is 0) and the
    rivals' summed mean credit (`others_share`). A defect missing a needed credit is left out and counted in
    `unread` (unknown is never zero)."""
    others = rivals(B)
    cols = [{"k": k, "n": 0, "credit": 0.0, "others": 0.0, "prs": set()} for k in range(len(others) + 1)]
    unread = 0
    for x in B.D:
        k = _rare_finds_k(x, others)
        if k is None or x["credit"].get(tool) is None:
            unread += 1
            continue
        c = cols[k]
        c["n"] += 1
        c["credit"] += x["credit"][tool]
        c["others"] += sum(x["credit"][t] for t in others) / len(others)
        c["prs"].add(x["pr"])
    for c in cols:
        c["share"] = c["credit"] / c["n"] if c["n"] else None
        c["others_share"] = c["others"] / c["n"] if c["n"] else None
    return cols, unread


def _rare_finds_ci(B, groups):
    """PR-bootstrap 95% percentile intervals of QuickReview's pooled share over each group of counts in
    `groups`, drawn in order from ONE random.Random(RARE_FINDS_SEED): each resample draws as many PRs as
    there are, with replacement (the brief's procedure, so its intervals reproduce). None for an empty group."""
    others = rivals(B)
    prs = sorted({x["pr"] for x in B.D})
    per = {p: [[0, 0.0] for _ in range(len(others) + 1)] for p in prs}
    for x in B.D:
        k = _rare_finds_k(x, others)
        if k is not None and x["credit"].get(QR) is not None:
            per[x["pr"]][k][0] += 1
            per[x["pr"]][k][1] += x["credit"][QR]
    rng = random.Random(RARE_FINDS_SEED)
    out = []
    for ks in groups:
        n_of = {p: sum(per[p][k][0] for k in ks) for p in prs}
        c_of = {p: sum(per[p][k][1] for k in ks) for p in prs}
        vals = []
        for _ in range(RARE_FINDS_RESAMPLES):
            n = c = 0.0
            for _ in prs:
                p = rng.choice(prs)
                n += n_of[p]
                c += c_of[p]
            if n:
                vals.append(c / n)
        vals.sort()
        out.append((vals[int(0.025 * len(vals))], vals[int(0.975 * len(vals)) - 1]) if vals else None)
    return out


def _rare_finds_range(ci):
    return f"{pct(ci[0])[:-1]}–{pct(ci[1])}"


def fig_idea_rare_finds(B, V, T):
    others = rivals(B)
    six = _rare_finds_word(len(others))
    cols, _ = _rare_finds_columns(B)
    head = cols[0]["share"]
    p = Page(T)
    p.title(f"Finds {pct(head)} of what all {six} others missed" if head is not None
            else "Share found, by how many others found it")
    base, top = 520, 170  # where 0% and 100% sit, in 1x pixels
    Y = lambda v: base - (base - top) * v  # noqa: E731
    pitch = min(136.0, 900 / max(len(cols) - 1, 1))
    w = min(36.0, pitch * 0.3)
    xs = [600 + pitch * (k - (len(cols) - 1) / 2) for k in range(len(cols))]
    p.c.plot([xs[0] - pitch / 2 + 10, xs[-1] + pitch / 2 - 10], [base, base], color=T["grid"], lw=1, zorder=1)
    for x, c in zip(xs, cols):
        hero = c["k"] == 0
        if c["share"] is None:  # no defect in this column: no bar, and no number
            p.text(x, base - 14, "–", size=17, color=T["muted"], ha="center", va="baseline")
        else:
            bar(p.c, base, Y(c["share"]), x, w, T["qr"], vertical=True, zorder=3)
            p.text(x, Y(c["share"]) - (14 if hero else 12), pct(c["share"]), size=30 if hero else 17,
                   weight="bold", ha="center", va="baseline")
        p.text(x, base + 32, str(c["k"]), size=16, color=T["ink2"], ha="center", va="baseline")
        p.text(x, base + 56, f"{c['n']} defects" if hero else str(c["n"]), size=11, color=T["muted"], ha="center",
               va="baseline")
    p.text(xs[0] - pitch / 2 + 10, top - 24, "found by QuickReview", size=13, weight="bold", va="baseline")
    p.text(600, base + 90, f"found by this many of the {six} others", size=12.5, color=T["ink2"], ha="center",
           va="baseline")
    ci = _rare_finds_ci(B, [[0]])[0]
    p.source(f"AACR-Bench · {len(B.D)} verified defects · the {six}: " + ", ".join(V.name(t) for t in others) +
             (f" · 95% CI for the {pct(head)}: {_rare_finds_range(ci)}" if ci and head is not None else ""))
    return p


def _rare_finds_pooled(cols, ks):
    n = sum(cols[k]["n"] for k in ks)
    c = sum(cols[k]["credit"] for k in ks)
    o = sum(cols[k]["others"] for k in ks)
    prs = set().union(*(cols[k]["prs"] for k in ks))
    return {"n": n, "credit": c, "share": c / n if n else None, "others_share": o / n if n else None, "prs": prs}


def _rare_finds_own_zero(B, t):
    """Reviewer t's credit and count on the defects ALL of its own rivals (the other reviewers of the seven,
    QuickReview included) scored below RARE_FINDS_FOUND on: the same column 0, built around t."""
    riv = [u for u in B.aacr_tools() if u != t]
    xs = [x for x in B.D if _rare_finds_k(x, riv) == 0 and x["credit"].get(t) is not None]
    return sum(x["credit"][t] for x in xs), len(xs)


def numbers_idea_rare_finds(B, V):
    others = rivals(B)
    six = _rare_finds_word(len(others))
    cols, unread = _rare_finds_columns(B)
    old, _ = _rare_finds_columns(B, tool=OCT1)
    last = len(cols) - 1
    ci = _rare_finds_ci(B, [[0], [0, 1]])
    s1 = lambda v: "–" if v is None else f"{v * 100:.1f}%"  # noqa: E731
    out = ["### idea-rare-finds", "",
           f"QuickReview's share of AACR-Bench's {len(B.D)} verified defects (credit: found 1, partly found ½), in "
           f"columns by how many of the {six} other reviewers ({', '.join(B.name(t) for t in others)}) found each. "
           f"A rival found a defect when its credit is ≥ {RARE_FINDS_FOUND:g} (found or partly found), so column 0 "
           f"is the defects all {six} scored 0 on."
           + ("" if not unread else f" {unread} defect{' lacks' if unread == 1 else 's lack'} a credit and "
                                    f"{'is' if unread == 1 else 'are'} left out."), "",
           f"| found by, of the {six} others | defects | PRs | QuickReview credit | QuickReview's share (the bar) | "
           f"the {six} others' average (set by the grouping; not drawn) | Oct 1 build {OCT1.split('-')[-1]} |",
           "|---:|---:|---:|---:|---:|---:|---:|"]
    for c, o in zip(cols, old):
        out.append(f"| {c['k']} | {c['n']} | {len(c['prs'])} | {fmt(c['credit'])} | "
                   + ("–" if c["share"] is None else f"**{pct(c['share'])}** ({s1(c['share'])})")
                   + f" | {s1(c['others_share'])} | {s1(o['share'])} |")
    for label, ks in (("0–1", [0, 1]), ("all", list(range(last + 1)))):
        a, b = _rare_finds_pooled(cols, ks), _rare_finds_pooled(old, ks)
        out.append(f"| {label} | {a['n']} | {len(a['prs'])} | {fmt(a['credit'])} | {s1(a['share'])} | "
                   f"{s1(a['others_share'])} | {s1(b['share'])} |")
    prs = sorted({x["pr"] for x in B.D})
    out += ["", "95% CI of QuickReview's share, PR bootstrap ({:,} resamples of the {} PRs that hold a defect, with "
                "replacement, random.Random({})): column 0 {}; columns 0–1 {}.".format(
                    RARE_FINDS_RESAMPLES, len(prs), RARE_FINDS_SEED,
                    *(("–" if v is None else f"{v[0] * 100:.1f}–{v[1] * 100:.1f}%") for v in ci)), ""]
    # the caveats; every number computed here except the brief's dated key-seeding check
    zero = [x for x in B.D if _rare_finds_k(x, others) == 0 and x["credit"].get(QR) is not None]
    sev = {s: sum(1 for x in zero if x["severity"] == s) for s in ("high", "medium", "low")}
    bugs = [x for x in zero if x["kind"] == "bug"]
    got = sum(x["credit"][QR] for x in bugs)
    hi = cols[last]
    out.append(f"- The {six} others' average is listed, not drawn: the grouping sets it (about k/{len(others)}, a "
               f"little lower where a rival only partly found a defect), so it measures nothing independently; and "
               f"at k = {last} it is above QuickReview's ({s1(hi['others_share'])} against {s1(hi['share'])}).")
    if zero:
        out.append(f"- Column 0 by severity: {sev['high']} high, {sev['medium']} medium and {sev['low']} low. "
                   f"{len(bugs)} of its {len(zero)} are functional bugs (kind = bug), and QuickReview found "
                   f"{fmt(got)} of them" + (f" ({pct(got / len(bugs))})" if bugs else "")
                   + ". Hence \"defects\", never \"bugs\".")
    # tuning: the frozen build's changes were mined from rest145's misses; the other PRs (smoke10/dev10 validated
    # those changes, holdout10/fresh10 sat out that step) carried the earlier tuning, so none of them is unseen
    sets = {iid: (r or {}).get("set") for iid, r in V.d.get("prs", {}).items()}
    rest = [x for x in zero if sets.get(x["pr"]) not in (None, "rest145")]
    n_rest = sum(1 for s in sets.values() if s not in (None, "rest145"))
    tune = "- Tuning: the frozen build's last changes were mined from its predecessor's misses on rest145"
    if zero and all(sets.get(x["pr"]) is not None for x in zero) and rest:
        r_c = sum(x["credit"][QR] for x in rest)
        tune += (f" (the other {n_rest} PRs served earlier tuning and validation). On those {n_rest} it finds "
                 f"{pct(r_c / len(rest))} ({fmt(r_c)} of {len(rest)}) of column 0")
    else:
        tune += "; its share of column 0 outside rest145 is unknown (no PR set read)"
    if old[0]["share"] is not None:
        tune += (f"; the Oct 1 build ({OCT1.split('-')[-1]}) found {pct(old[0]['share'])} ({fmt(old[0]['credit'])}"
                 f" of {old[0]['n']}) of it")
    out.append(tune + ".")
    seed = ("- One run per reviewer, one judge (gpt-6-sol-high). Some column-0 defects are in the answer key only "
            "because QuickReview's earlier runs raised them; the brief's check (2026-10-13, not recomputed here) "
            "put the share at 63–67% without them.")
    own = {t: _rare_finds_own_zero(B, t) for t in others}
    ranked = sorted((t for t in others if own[t][1]), key=lambda t: -own[t][0] / own[t][1])
    if ranked:
        t = ranked[0]
        seed += (f" Grouped the same way around each other reviewer, the best of them, {B.name(t)}, finds "
                 f"{pct(own[t][0] / own[t][1])} ({fmt(own[t][0])} of {own[t][1]}) of what its own {six} rivals "
                 f"all missed.")
    out.append(seed)
    return "\n".join(out) + "\n"


# ---------------------------------------------------------------- idea-best-of-six: per PR, QuickReview's share found
#   against the best of the six others on that PR.
BEST_OF_SIX_R1 = 5.5  # radius (1x px) of a one-PR bubble; a bubble's AREA is proportional to its PRs
BEST_OF_SIX_GAP = 2  # px between two bubbles' fills, at least (the spec's surface gap)
BEST_OF_SIX_SIDE = 530  # px: the square plot's side, 0..100% on both axes
BEST_OF_SIX_WORDS = {1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight",
                     9: "nine", 10: "ten"}


def _best_of_six_rows(B, keep=None, me=QR, pooled=False):
    """One row per AACR-Bench PR with a verified defect (that `keep` admits):
    (pr, defects, found by `me`, found by the best of the six others, [the six that reached it]).
    The best of the six is ONE tool per PR, picked after the fact; pooled=True instead credits each
    defect if any of the six found it. A PR where any of the seven has no credit for a defect is left
    out (unknown, not zero). Credits are multiples of 0.5, so the sums compare exactly."""
    six = rivals(B)
    by_pr = collections.defaultdict(list)
    for x in B.D:
        if keep is None or keep(x):
            by_pr[x["pr"]].append(x)
    rows = []
    for pr in sorted(by_pr):
        xs = by_pr[pr]
        if any(x["credit"].get(t) is None for x in xs for t in [me] + six):
            continue
        found = {t: sum(x["credit"][t] for x in xs) for t in six}
        best = sum(max(x["credit"][t] for t in six) for x in xs) if pooled else max(found.values())
        rows.append((pr, len(xs), sum(x["credit"][me] for x in xs), best,
                     sorted(t for t in six if found[t] == best)))
    return rows


def _best_of_six_tally(rows):
    """The record over rows: PRs ahead / tied / behind, the corners, means and sums (None when empty)."""
    n = len(rows)
    ahead = [r for r in rows if r[2] > r[3]]
    behind = [r for r in rows if r[2] < r[3]]
    return {
        "prs": n, "ahead": len(ahead), "tied": n - len(ahead) - len(behind), "behind": len(behind),
        "both_all": sum(1 for r in rows if r[2] == r[3] == r[1]),
        "both_none": sum(1 for r in rows if r[2] == r[3] == 0),
        "mean_me": sum(r[2] / r[1] for r in rows) / n if n else None,
        "mean_best": sum(r[3] / r[1] for r in rows) / n if n else None,
        "found_me": sum(r[2] for r in rows), "found_best": sum(r[3] for r in rows),
        "defects": sum(r[1] for r in rows),
        "whole_ahead": sum(1 for r in ahead if r[2] - r[3] >= 1),
        "whole_behind": sum(1 for r in behind if r[3] - r[2] >= 1),
    }


def _best_of_six_points(rows):
    """[(x, y, PRs, side)] with x = the best of six's share of the PR's defects, y = QuickReview's, as
    exact fractions: one bubble per distinct point, biggest first (a deterministic drawing order)."""
    cells = collections.Counter((Fraction(round(2 * r[3]), 2 * r[1]), Fraction(round(2 * r[2]), 2 * r[1]))
                                for r in rows)
    side = lambda x, y: "ahead" if y > x else ("tied" if y == x else "behind")  # noqa: E731
    return sorted(((x, y, k, side(x, y)) for (x, y), k in cells.items()), key=lambda q: (-q[2], q[0], q[1]))


def _best_of_six_merge(pts, scale):
    """The bubbles as drawn, [(x, y, PRs, side, ((x, y, PRs) of each exact point it holds))], biggest
    first. Two bubbles on the same side whose fills would come closer than BEST_OF_SIX_GAP px (`scale`
    px = 100%) would hide part of one's area, which is the encoding, so they merge, closest pair first,
    into one bubble at their PR-weighted mean holding their summed PRs; repeated until none is that
    close. Exact fractions: a weighted mean of points on one side of y = x lies on that side, so no PR
    changes region."""
    bs = [(x, y, k, sd, ((x, y, k),)) for x, y, k, sd in pts]
    while True:
        close = []
        for i, a in enumerate(bs):
            for j in range(i + 1, len(bs)):
                b = bs[j]
                if a[3] == b[3]:
                    gap = (scale * math.hypot(float(a[0] - b[0]), float(a[1] - b[1]))
                           - BEST_OF_SIX_R1 * (math.sqrt(a[2]) + math.sqrt(b[2])))
                    if gap < BEST_OF_SIX_GAP:
                        close.append((gap, i, j))
        if not close:
            return sorted(bs, key=lambda q: (-q[2], q[0], q[1]))
        _, i, j = min(close)
        a, b = bs[i], bs[j]
        k = a[2] + b[2]
        bs = [q for m, q in enumerate(bs) if m not in (i, j)] + [
            ((a[0] * a[2] + b[0] * b[2]) / k, (a[1] * a[2] + b[1] * b[2]) / k, k, a[3], a[4] + b[4])]


def _best_of_six_word(n):
    return BEST_OF_SIX_WORDS.get(n, str(n))


def _best_of_six_comments(V, t):
    """Comments per PR from the judge's grades, or None when they cannot be read."""
    try:
        return V.grades(t)["per_pr"]
    except (KeyError, TypeError, ZeroDivisionError):
        return None


def _best_of_six_width(p, s, size, weight):
    """Rendered width of a one-line text in 1x px (the canvas is drawn at 1x, so px = data units)."""
    t = p.text(0, 0, s, size=size, weight=weight)
    w = t.get_window_extent(renderer=p.fig.canvas.get_renderer()).width
    t.remove()
    return w


def _best_of_six_measure(p, num, word, size, wsize):
    """(count width, gap, total length, cap height) of a 'count word' label, in 1x px."""
    gap = wsize * 0.4
    wn = _best_of_six_width(p, num, size, "bold")
    return wn, gap, wn + gap + _best_of_six_width(p, word, wsize, "normal"), size * 100 / 72 * 0.72


def _best_of_six_label(p, cx, cy, num, word, color, size=28, wsize=16, angle=0.0):
    """'56 ahead' centred on (cx, cy): the count big and bold, the word on the same baseline, the pair
    rotated `angle` degrees counter-clockwise (the page's y grows down)."""
    wn, gap, length, cap = _best_of_six_measure(p, num, word, size, wsize)
    a = math.radians(angle)
    ux, uy = math.cos(a), -math.sin(a)  # along the text
    dx, dy = math.sin(a), math.cos(a)  # across it, towards the text's own "down"
    bx = cx - ux * length / 2 + dx * cap / 2
    by = cy - uy * length / 2 + dy * cap / 2
    kw = dict(rotation=angle, rotation_mode="anchor", ha="left", va="baseline", zorder=10)  # over the bubbles
    p.text(bx, by, num, size=size, weight="bold", color=color, **kw)
    p.text(bx + ux * (wn + gap), by + uy * (wn + gap), word, size=wsize, color=color, **kw)


def _best_of_six_room(cx, cy, half_l, half_h, discs, angle=0.0):
    """The px between a label box (half length, half height) centred on (cx, cy), turned `angle`
    degrees, and the nearest bubble disc (x, y, r) — negative when it overlaps one."""
    a = math.radians(angle)
    ux, uy, dx, dy = math.cos(a), -math.sin(a), math.sin(a), math.cos(a)
    room = math.inf
    for x, y, r in discs:
        along, across = (x - cx) * ux + (y - cy) * uy, (x - cx) * dx + (y - cy) * dy
        room = min(room, math.hypot(along - min(max(along, -half_l), half_l),
                                    across - min(max(across, -half_h), half_h)) - r)
    return room


def _best_of_six_clear(cx, cy, half_l, half_h, discs, angle=0.0, pad=10):
    """True when the label box keeps `pad` px clear of every bubble disc."""
    return _best_of_six_room(cx, cy, half_l, half_h, discs, angle) >= pad


def _best_of_six_source(p, s, hm, n_all, six, seven):
    """The one line of small print: the scope, the record on high + medium severity alone (so the
    image shows whether the lead holds where the defects matter most), and who the rival is. The
    longest form that fits on one line inside x 64..1136."""
    scope = f"{s['prs']} PRs with a verified defect" if s["prs"] == n_all else \
        f"{s['prs']} of {n_all} PRs with a verified defect (all {seven} judged)"
    rec = f"high + medium alone: {hm['ahead']} ahead, {hm['behind']} behind" if hm["prs"] else \
        "high + medium alone: no PR readable"
    ties = f", {hm['tied']} tied" if hm["prs"] else ""
    rival = f" · rival = each PR's best of the {six} others"
    forms = [f"AACR-Bench · {scope}, all severities ({rec}{ties}){rival}",
             f"AACR-Bench · {scope}, all severities ({rec}){rival}",
             f"AACR-Bench · {scope}, all severities ({rec}{ties})",
             f"AACR-Bench · {scope}, all severities ({rec})"]
    return next((f for f in forms if 64 + _best_of_six_width(p, f, 10.5, "normal") <= 1136), forms[-1])


def fig_idea_best_of_six(B, V, T):
    rows = _best_of_six_rows(B)
    s = _best_of_six_tally(rows)
    six = _best_of_six_word(len(rivals(B)))
    p = Page(T, h=830)
    p.title(f"Vs each PR's best rival: {s['ahead']} ahead, {s['behind']} behind" if s["prs"]
            else "Vs each PR's best rival: no PR readable")

    side = BEST_OF_SIX_SIDE  # a square plot: both axes run 0..100% of the PR's verified defects found
    x0, y0 = (p.w - side) / 2, 170
    x1, y1 = x0 + side, y0 + side
    X = lambda v: x0 + side * float(v)  # noqa: E731
    Y = lambda v: y1 - side * float(v)  # noqa: E731
    for v in (0, 0.5, 1):  # halves only: the region labels sit in open cells, no line through them
        p.c.plot([X(v)] * 2, [y0, y1], color=T["grid"], lw=1, zorder=1)
        p.c.plot([x0, x1], [Y(v)] * 2, color=T["grid"], lw=1, zorder=1)
        p.text(X(v), y1 + 26, pct(v), size=10.5, color=T["muted"], ha="center")
        p.text(x0 - 20, Y(v), pct(v), size=10.5, color=T["muted"], ha="right")
    p.text(x0 - 20, y0 - 32, "QuickReview", size=13, weight="bold", color=T["ink"], va="baseline")
    p.text((x0 + x1) / 2, y1 + 56, f"best of the {six} others: share of the PR's defects found", size=12.5,
           color=T["ink2"], ha="center")

    hm = _best_of_six_tally(_best_of_six_rows(B, lambda x: x["severity"] in SERIOUS))
    p.source(_best_of_six_source(p, s, hm, len({x["pr"] for x in B.D}), six,
                                 _best_of_six_word(len(rivals(B)) + 1)))
    if not rows:  # nothing readable: the empty frame and an honest title, never zeros
        return p

    # one bubble per distinct point (merged only where two would overlap), area proportional to PRs:
    # ties first, then losses, QuickReview's wins on top
    drawn = _best_of_six_merge(_best_of_six_points(rows), side)
    discs = [(X(x), Y(y), BEST_OF_SIX_R1 * math.sqrt(k)) for x, y, k, _, _ in drawn]
    face = {"ahead": T["qr"], "tied": T["empty"], "behind": T["other"]}
    z = 3.0
    for grp in ("tied", "behind", "ahead"):
        for x, y, k, sd, _ in drawn:  # largest first, so a small bubble is never hidden under a big one
            if sd != grp:
                continue
            r = BEST_OF_SIX_R1 * math.sqrt(k)
            p.c.add_patch(Circle((X(x), Y(y)), r + 2, facecolor=T["surface"], edgecolor="none", zorder=z))
            p.c.add_patch(Circle((X(x), Y(y)), r - (0.4 if sd == "tied" else 0), facecolor=face[sd],
                                 edgecolor=T["muted"] if sd == "tied" else "none", lw=0.75, zorder=z + 0.005))
            z += 0.01

    # the biggest bubble names its own count (the unit of every bubble): inside it when it fits, else on
    # the first side where the label clears every other bubble and stays on the page
    bx, by, bk, bsd, _ = drawn[0]
    br = BEST_OF_SIX_R1 * math.sqrt(bk)
    _, _, blen, bcap = _best_of_six_measure(p, str(bk), "PRs", 19, 13)
    inner = {"ahead": "#ffffff", "tied": T["ink2"], "behind": T["ink"]}[bsd]  # white only on solid blue
    spot, tone = (X(bx), Y(by)), inner
    if blen >= 2 * br - 18:
        beside = [(X(bx) - br - 10 - blen / 2, Y(by)), (X(bx) + br + 10 + blen / 2, Y(by)),
                  (X(bx), Y(by) - br - 8 - bcap / 2), (X(bx), Y(by) + br + 8 + bcap / 2)]
        spot = next((c for c in beside if 64 <= c[0] - blen / 2 and c[0] + blen / 2 <= 1136
                     and y0 - 40 <= c[1] - bcap / 2 and c[1] + bcap / 2 <= y1 + 8
                     and _best_of_six_clear(c[0], c[1], blen / 2, bcap / 2, discs[1:], pad=6)), None)
        if spot is None:  # nowhere clear: inside, however tight
            spot = (X(bx), Y(by))
        else:  # beside it: muted ink, and the later labels keep clear of it as of a bubble
            tone = T["ink2"]
            discs.append((spot[0], spot[1], blen / 2))
    _best_of_six_label(p, *spot, str(bk), "PRs", tone, size=19, wsize=13)

    # the diagonal y = x, cut where its label sits on it
    num, word = str(s["tied"]), "tied"
    _, _, length, cap = _best_of_six_measure(p, num, word, 28, 16)
    half = length / 2 + 10
    spots = [(X(t), Y(t)) for t in (0.3, 0.25, 0.35, 0.2, 0.15)]  # the lower half: clear of the 50% crossing
    dx, dy = next((c for c in spots if _best_of_six_clear(c[0], c[1], half, cap / 2, discs, angle=45)), None) \
        or max(spots, key=lambda c: _best_of_six_room(c[0], c[1], half, cap / 2, discs, angle=45))
    u = 1 / math.sqrt(2)
    for (ax, ay), (ex, ey) in (((X(0), Y(0)), (dx - half * u, dy + half * u)),
                               ((dx + half * u, dy - half * u), (X(1), Y(1)))):
        p.c.plot([ax, ex], [ay, ey], color=T["muted"], lw=1.1, zorder=2, solid_capstyle="butt")
    _best_of_six_label(p, dx, dy, num, word, T["ink2"], angle=45)

    # the two regions, each named inside its open half-cell (no gridline or diagonal crosses one)
    for num, word, color, (ca, cb, ra, rb) in ((s["ahead"], "ahead", T["ink"], (0, 0.5, 0.5, 1)),
                                               (s["behind"], "behind", T["ink2"], (0.5, 1, 0, 0.5))):
        _, _, length, cap = _best_of_six_measure(p, str(num), word, 28, 16)
        lo_x, hi_x = X(ca) + length / 2 + 12, X(cb) - length / 2 - 12
        lo_y, hi_y = Y(rb) + cap / 2 + 12, Y(ra) - cap / 2 - 12
        spots = [(lo_x + (hi_x - lo_x) * fx, lo_y + (hi_y - lo_y) * fy)
                 for fx, fy in ((0.5, 0.5), (0.5, 0.3), (0.5, 0.7), (0.3, 0.5), (0.7, 0.5), (0.2, 0.2), (0.8, 0.8),
                                (0.2, 0.8), (0.8, 0.2))]
        cx, cy = next((c for c in spots if _best_of_six_clear(c[0], c[1], length / 2, cap / 2, discs)),
                      None) or max(spots, key=lambda c: _best_of_six_room(c[0], c[1], length / 2, cap / 2, discs))
        _best_of_six_label(p, cx, cy, str(num), word, color)
    return p


def numbers_idea_best_of_six(B, V):
    """The table behind the image, for out/v3/NUMBERS.md."""
    rows = _best_of_six_rows(B)
    s = _best_of_six_tally(rows)
    six = _best_of_six_word(len(rivals(B)))
    n = s["prs"]
    head = ["### idea-best-of-six", ""]
    if not n:  # unknown is never zero: no record, no table of zeros
        return "\n".join(head + [
            f"No PR with a verified defect has a readable credit from all {_best_of_six_word(len(rivals(B)) + 1)} "
            "reviewers, so the record is unknown; the image shows an empty frame."]) + "\n"
    share = lambda k: f"{100 * k / n:.0f}%"  # noqa: E731
    mean = lambda v: "—" if v is None else f"{100 * v:.1f}%"  # noqa: E731
    num = lambda v: f"{v:g}"  # noqa: E731
    rec = lambda t: f"{t['ahead']}–{t['behind']} with {t['tied']} tied" if t["prs"] else "unknown (no PR readable)"  # noqa: E731
    prs = V.d.get("prs", {})
    sets = {r[0]: (prs.get(r[0]) or {}).get("set") for r in rows}
    unset = sum(1 for v in sets.values() if v is None)
    held = {"holdout10", "fresh10"}
    slices = [
        ("All defects (the chart)", s),
        ("High + medium severity only (the source line)",
         _best_of_six_tally(_best_of_six_rows(B, lambda x: x["severity"] in SERIOUS))),
        ("High severity only", _best_of_six_tally(_best_of_six_rows(B, lambda x: x["severity"] == "high"))),
        ("Low severity only", _best_of_six_tally(_best_of_six_rows(B, lambda x: x["severity"] == "low"))),
        ("PRs not used for the frozen build's final changes (holdout10 + fresh10)",
         _best_of_six_tally(_best_of_six_rows(B, lambda x: sets.get(x["pr"]) in held))),
        (f"Against the {six} pooled (a defect counts if any of them found it)",
         _best_of_six_tally(_best_of_six_rows(B, pooled=True))),
    ]
    hm, high, low, heldout, pooled = (t for _, t in slices[1:])
    pts = _best_of_six_points(rows)
    drawn = _best_of_six_merge(pts, BEST_OF_SIX_SIDE)
    fx = lambda f: f"{100 * float(f):.1f}".rstrip("0").rstrip(".")  # noqa: E731
    bubbles = {sd: ", ".join(f"{fx(x)}→{fx(y)}: {k}" for x, y, k, d in pts if d == sd)
               for sd in ("ahead", "tied", "behind")}
    merged = [b for b in drawn if len(b[4]) > 1]
    lost_to = collections.Counter(" + ".join(B.name(t) for t in r[4]) for r in rows if r[2] < r[3])
    g = {t: _best_of_six_comments(V, t) for t in [QR] + rivals(B)}
    others = [g[t] for t in rivals(B) if g[t] is not None]
    rng = f"{min(others):.1f}–{max(others):.1f}" if len(others) == len(rivals(B)) else "unknown"
    mine = "an unknown number of" if g[QR] is None else f"{g[QR]:.1f}"
    decided = s["ahead"] + s["behind"]
    half = decided - s["whole_ahead"] - s["whole_behind"]
    out = head + [
        f"Each AACR-Bench PR with a verified defect ({n}) placed by the share of its defects QuickReview found (y) "
        f"against the share the best of the {six} other reviewers found on that same PR (x; one tool per PR, picked "
        "after the fact); bubble area = PRs at that point.", "",
        "| Slice | Ahead | Tied | Behind | Both 100% | Both 0% | Mean per PR: QuickReview / best | Found: QuickReview / best |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for label, t in slices:
        out.append(f"| {label} | — | — | — | — | — | unknown (no PR readable) | — |" if not t["prs"] else
                   f"| {label} | {t['ahead']} | {t['tied']} | {t['behind']} | {t['both_all']} | {t['both_none']} | "
                   f"{mean(t['mean_me'])} / {mean(t['mean_best'])} | {num(t['found_me'])} / {num(t['found_best'])} "
                   f"of {t['defects']} |")
    losses = ", ".join(f"{k} {v}" for k, v in sorted(lost_to.items(), key=lambda kv: (-kv[1], kv[0])))
    out += [
        "", f"Shares of the {n} PRs: ahead {share(s['ahead'])}, tied {share(s['tied'])}, behind {share(s['behind'])}."
            + (f" Where QuickReview is behind, the best rival was: {losses}." if losses else ""),
        "", f"Bubbles ({len(pts)}; best of {six} → QuickReview, % of the PR's defects: PRs):", "",
        "| Side | Bubbles |", "|---|---|",
    ] + [f"| {sd} | {bubbles[sd] or '—'} |" for sd in ("ahead", "tied", "behind")] + [""]
    if merged:
        out += [f"Drawn as {len(drawn)} bubbles: points whose bubbles would overlap are drawn as one, at their "
                "PR-weighted mean, so no bubble hides another's area and no PR changes side: "
                + "; ".join(" + ".join(f"{fx(x)}→{fx(y)}" + (f" ({k})" if k > 1 else "") for x, y, k in b[4])
                            + f" drawn as one {b[2]}-PR bubble at {fx(b[0])}→{fx(b[1])}" for b in merged) + ".", ""]
    lead = "The lead comes from low-severity defects. " if (
        hm["prs"] and low["prs"] and low["ahead"] - low["behind"] > hm["ahead"] - hm["behind"]) else ""
    cmp = lambda a, b: "lower" if a < b else ("higher" if a > b else "the same")  # noqa: E731
    high_mean = "" if not high["prs"] else (
        f", and QuickReview's mean per PR is {cmp(high['mean_me'], high['mean_best'])} "
        f"({mean(high['mean_me'])} vs {mean(high['mean_best'])})")
    held_rec = (f"On the {heldout['prs']} not used for the frozen build's final changes it is {rec(heldout)}"
                if heldout["prs"] else "On the PRs not used for the frozen build's final changes the record is "
                                       "unknown (no PR readable)")
    out += [
        f"- The rival is one tool per PR, picked after the fact; pooling all {six} is stronger "
        f"({rec(pooled)}). One run per reviewer under one judge: {half} of the {decided} decided PRs turn on half a "
        f"defect (whole-defect margins only: {s['whole_ahead']}–{s['whole_behind']}).",
        f"- {lead}High + medium alone (on the image): {rec(hm)}. High alone: {rec(high)}{high_mean}. "
        f"Low alone: {rec(low)}.",
        f"- In-sample: QuickReview was tuned on these PRs, and none is fully out-of-sample. {held_rec}"
        + (f" ({unset} PRs' sets unknown, left out)." if unset else "."),
        f"- Recall only: QuickReview posts {mine} comments per PR, the {six} others {rng}.",
    ]
    return "\n".join(out) + "\n"


# ---------------------------------------------------------------- idea-record: against each of the six, the PRs where
#   QuickReview found more, the same, or fewer.
RECORD_HELD_OUT = ("holdout10", "fresh10")  # the sets never used in the frozen build's tuning or validation
RECORD_TUNED = "rest145"  # the set whose misses the frozen build was tuned on
RECORD_WORDS = {2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine"}


def _record_table(B):
    """pr -> tool -> credit summed over the PR's verified defects (found 1, partly found ½), for
    QuickReview and the six other reviewers; None when the tool has no judgement for the PR
    (refresh.py then writes no credit at all): unknown, never zero."""
    by_pr = collections.defaultdict(list)
    for x in B.D:
        by_pr[x["pr"]].append(x["credit"])
    return {pr: {t: (sum(c[t] for c in cs) if all(c.get(t) is not None for c in cs) else None)
                 for t in [QR] + rivals(B)}
            for pr, cs in sorted(by_pr.items())}


def _record_sets(B, V):
    """pr -> the benchmark set it belongs to (V's PR table); None when V does not say: unknown."""
    return {i: (V.d["prs"].get(i) or {}).get("set") for i in _record_table(B)}


def _record_rows(B, keep=None):
    """One row per rival, toughest first (smallest net lead, then fewest wins): the PRs with a
    verified defect (narrowed by keep(pr)) on which QuickReview's credit sum is higher, equal or
    lower, counted over the PRs both tools were judged on (kept in the row as `prs`)."""
    table = _record_table(B)
    prs = [i for i in table if keep is None or keep(i)]
    rows = []
    for t in rivals(B):
        known = [i for i in prs if table[i][QR] is not None and table[i][t] is not None]
        more = sum(1 for i in known if table[i][QR] > table[i][t])
        fewer = sum(1 for i in known if table[i][QR] < table[i][t])
        rows.append({"tool": t, "more": more, "same": len(known) - more - fewer, "fewer": fewer,
                     "n": len(known), "unknown": len(prs) - len(known), "prs": known})
    rows.sort(key=lambda r: (r["n"] == 0, r["more"] - r["fewer"], r["more"], r["tool"]))
    return rows


def _record_span(vals):
    """'a' when every value agrees, else 'lo–hi'."""
    return f"{min(vals)}" if min(vals) == max(vals) else f"{min(vals)}–{max(vals)}"


def _record_source(rows, sets):
    """The one line of small print: the base, how much of it QuickReview was tuned on (a PR with no
    set might be one, so that count becomes a range, never a guess), the measure, and the runs."""
    judged = [r for r in rows if r["n"]]
    if not judged:
        return f"AACR-Bench · {len(sets)} PRs with a verified defect · no judgements to compare"
    lo = [sum(1 for i in r["prs"] if sets.get(i) == RECORD_TUNED) for r in judged]
    hi = [a + sum(1 for i in r["prs"] if sets.get(i) is None) for a, r in zip(lo, judged)]
    tuned = f" (QuickReview was tuned on {_record_span(lo + hi)} of them)" if max(hi) else ""
    return (f"AACR-Bench · {_record_span([r['n'] for r in judged])} PRs with a verified defect{tuned} · "
            f"per PR: who found more of its verified defects · one run each")


def _record_claim(rows):
    """The title: a winning record (more PRs won than lost) against every rival, else the honest count."""
    won = sum(1 for r in rows if r["n"] and r["more"] > r["fewer"])
    if won == len(rows):
        return f"A winning record against all {RECORD_WORDS.get(len(rows), len(rows))}, PR by PR"
    if won and all(r["n"] for r in rows):
        return f"A winning record against {won} of {len(rows)}, PR by PR"
    return "Who found more, PR by PR"


def _record_width(p, s, **kw):
    """The width of a text in page pixels, measured with the renderer and not drawn."""
    t = p.text(0, 0, s, **kw)
    (a, _), (b, _) = p.c.transData.inverted().transform(
        t.get_window_extent(renderer=p.fig.canvas.get_renderer()).get_points())
    t.remove()
    return abs(b - a)


def _record_bar(p, x0, x1, y, h, parts):
    """One 100% bar from parts [(count, colour)]: square joins with a 2 px surface gap between fills
    and the 4 px rounded tip on the last filled part. Returns each part's drawn (left, right)."""
    n = sum(c for c, _ in parts)
    live = [k for k, (c, _) in enumerate(parts) if c > 0]
    spans, cum = [None] * len(parts), 0
    for k, (c, colour) in enumerate(parts):
        a, b = x0 + (x1 - x0) * cum / n, x0 + (x1 - x0) * (cum + c) / n
        cum += c
        if c == 0:
            continue
        a += 0 if k == live[0] else 1
        b -= 0 if k == live[-1] else 1
        bar(p.c, a, b, y, h, colour, r=4 if k == live[-1] else 0, zorder=4 if k == 0 else 3)
        spans[k] = (a, b)
    return spans


def fig_idea_record(B, V, T):
    rows = _record_rows(B)
    p = Page(T)
    p.title(_record_claim(rows))
    size, pad, hs = 15, 7, 13  # names and counts; the inset a count needs inside its part; segment words
    x0 = 64 + 18 + max(_record_width(p, B.name(r["tool"]), size=size) for r in rows)
    x1, top, pitch, h = 1080, 196, 74, 40
    words = ("QuickReview found more", "same", "the other found more")
    styles = [{"color": "#ffffff", "weight": "bold"}, {"color": T["ink"]}, {"color": T["ink2"]}]
    bars = []
    for i, r in enumerate(rows):
        y = top + i * pitch
        p.text(x0 - 18, y, B.name(r["tool"]), size=size, ha="right", va="center", color=T["ink2"])
        if not r["n"]:
            p.text(x0, y, "not judged", size=13, va="center", color=T["muted"], style="italic")
            continue
        counts = (r["more"], r["same"], r["fewer"])
        spans = _record_bar(p, x0, x1, y, h, [(counts[0], T["qr"]), (counts[1], T["empty"]),
                                               (counts[2], T["other"])])
        bars.append((y, counts, spans))
    fits = lambda c, k, spans: (_record_width(p, str(c), size=size, weight=styles[k].get("weight", "normal"))  # noqa: E731
                                + 2 * pad <= spans[k][1] - spans[k][0])
    # the last part's counts form one column: inside every bar, or all just past the tips when any is a sliver
    tips_out = any(c[2] and not fits(c[2], 2, s) for _, c, s in bars)
    for y, counts, spans in bars:
        for k, c in enumerate(counts):
            if not c:
                continue
            a, b = spans[k]
            if k == 2 and tips_out:
                p.text(x1 + 10, y, str(c), size=size, va="center", color=T["ink2"], zorder=6)
            elif fits(c, k, spans) or k == 2:
                p.text((a + b) / 2, y, str(c), size=size, ha="center", va="center", zorder=6, **styles[k])
            else:  # a sliver inside the bar: its count just past it, over the pale part that follows
                p.text(b + pad, y, str(c), size=size, va="center", color=T["ink"], zorder=6)
    # the three segment words, once, each aligned to its part of the top bar; the last one ends with the
    # column it names: the bar ends, or the grey counts' column when those sit past the tips
    if bars:
        yh = top - h / 2 - 16
        spans = bars[0][2]
        right = x1 + (10 + max(_record_width(p, str(c[2]), size=size) for _, c, _ in bars if c[2])
                      if tips_out else 0)
        p.text(x0, yh, words[0], size=hs, weight="bold", va="baseline")
        p.text(right, yh, words[2], size=hs, color=T["ink2"], ha="right", va="baseline")
        left_end = x0 + _record_width(p, words[0], size=hs, weight="bold")
        right_start = right - _record_width(p, words[2], size=hs)
        w_same = _record_width(p, words[1], size=hs)
        xs = max(spans[1][0] if spans[1] else x0, left_end + 24)
        xs = min(xs, right_start - 24 - w_same)
        if xs >= left_end + 24:
            p.text(xs, yh, words[1], size=hs, color=T["ink2"], va="baseline")
    p.source(_record_source(rows, _record_sets(B, V)))
    return p


def numbers_idea_record(B, V):
    """The table behind the image, for out/v3/NUMBERS.md."""
    rows = _record_rows(B)
    sets = _record_sets(B, V)
    tuned_rows = {r["tool"]: r for r in _record_rows(B, lambda i: sets[i] == RECORD_TUNED)}
    held = {r["tool"]: r for r in _record_rows(B, lambda i: sets[i] in RECORD_HELD_OUT)}
    split = lambda r: f"{r['more']} / {r['same']} / {r['fewer']} (of {r['n']})" if r["n"] else "not judged"  # noqa: E731
    out = ["### idea-record\n",
           f"Per AACR-Bench PR with a verified defect, whether QuickReview's credited finds (found 1, partly found "
           f"½) beat, equalled or trailed each other reviewer's; one 100% bar per reviewer, the smallest net lead "
           f"first. Title: \"{_record_claim(rows)}\".\n",
           "| Against | QuickReview found more | Same | The other found more | PRs compared | Unjudged | "
           f"Tuned-on PRs ({RECORD_TUNED}): more / same / fewer | "
           f"Held-out PRs ({' + '.join(RECORD_HELD_OUT)}): more / same / fewer |",
           "|---|---|---|---|---|---|---|---|"]
    for r in rows:
        msf = " | ".join(str(r[k]) if r["n"] else "–" for k in ("more", "same", "fewer"))
        out.append(f"| {B.name(r['tool'])} | {msf} | {r['n']} | {r['unknown']} | "
                   f"{split(tuned_rows[r['tool']])} | {split(held[r['tool']])} |")
    # per PR, against the best of the six at once (the rows are per rival, not simultaneous)
    table = _record_table(B)
    best = collections.Counter()
    for i, v in table.items():
        if all(x is not None for x in v.values()):
            q, o = v[QR], max(v[t] for t in rivals(B))
            best["more" if q > o else "fewer" if q < o else "same"] += 1
    six = RECORD_WORDS.get(len(rows), str(len(rows)))
    nb = sum(best.values())
    best_note = (f"against the best of the {six} on each PR, QuickReview is ahead on {best['more']}, level on "
                 f"{best['same']} and behind on {best['fewer']} of the {nb}." if nb else
                 f"no PR has a judgement for QuickReview and all {six}, so the split against the best of them is "
                 f"unknown.")
    # the held-out record, over the rivals judged there (an unjudged rival is unknown, never a loss)
    net = lambda r: (r["more"] - r["fewer"]) / r["n"]  # noqa: E731
    hj = sorted((r for r in held.values() if r["n"]), key=lambda r: (net(r), r["more"], r["tool"]))
    h_won = sum(1 for r in hj if r["more"] > r["fewer"])
    if hj:
        h0 = hj[0]
        narrows = net(h0) < min(net(r) for r in rows if r["n"]) if any(r["n"] for r in rows) else False
        held_note = (f"On the {h0['n']} PRs never used in tuning or validation the record "
                     f"{'narrows but is' if narrows else 'is'} "
                     + (f"still a winning one against all {six}" if h_won == len(rows) else
                        f"a winning one against {h_won} of the {len(hj)} judged there")
                     + f"; closest: {B.name(h0['tool'])} {h0['more']} / {h0['same']} / {h0['fewer']}.")
    else:
        held_note = "No PR never used in tuning or validation has a judgement for both sides."
    tuned = sum(1 for i in table if sets[i] == RECORD_TUNED)
    unset = sum(1 for i in table if sets[i] is None)
    c = {t: V.grades(t)["per_pr"] for t in [QR] + rivals(B)}
    usd = {t: B.aacr["reviewers"][t]["usd_mean"] for t in [QR] + rivals(B)}
    lo, hi = min(v for t, v in c.items() if t != QR), max(v for t, v in c.items() if t != QR)
    priced = [usd[QR] / v for t, v in usd.items() if t != QR and v and usd[QR] is not None]
    cost = (f" and costs ${usd[QR]:.2f} per PR, {min(priced):.1f}–{max(priced):.1f}× theirs" if priced
            else " (its cost per PR is unknown)")
    out += [
        "",
        f"- Per rival, not all {six} at once: {best_note}",
        f"- Tuning: the frozen build was tuned on misses from {RECORD_TUNED}, {tuned} of these {len(table)} PRs. "
        f"{held_note}" + (f" ({unset} PRs carry no set and are left out.)" if unset else ""),
        "- Home advantage: some defects entered the answer key only through reviewers' comments, which in rest145 came "
        "from QuickReview's earlier default and low runs and open-code-review (the other rivals' comments, all but "
        "PR-Agent's, joined in a later extension) and in fresh10 from QuickReview runs only. data/aacr.json carries "
        "no provenance, so this table cannot separate that out. Each reviewer ran once, so the smallest 'the other "
        "found more' counts are mostly luck.",
        f"- Recall only, not review quality: QuickReview posts {c[QR]:.1f} comments per PR against {lo:.1f}–{hi:.1f} "
        f"for the {six}{cost}.",
    ]
    return "\n".join(out) + "\n"


# ---------------------------------------------------------------- idea-languages: per language, QuickReview's share
#   found beside the best of the six others.
LANGUAGES_THIN = 30  # fewer verified defects than this: a thin tile (the brief's MIN_DEFECTS)
LANGUAGES_WORDS = ("no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten")


def _languages_word(n):
    return LANGUAGES_WORDS[n] if 0 <= n < len(LANGUAGES_WORDS) else str(n)


def _languages_and(items):
    """'a', 'a and b', 'a, b and c'."""
    items = list(items)
    return " and ".join(items) if len(items) < 3 else ", ".join(items[:-1]) + " and " + items[-1]


def _languages_found(xs, t, whole=False):
    """Credit `t` earned on the defects `xs` as an exact Fraction, or None when any credit is unreadable.
    whole=True counts a partly found defect as found."""
    cs = [x["credit"].get(t) for x in xs]
    if not xs or any(c is None for c in cs):
        return None
    return sum((Fraction(int(c > 0)) if whole else Fraction(c) for c in cs), Fraction(0))


def _languages_cut(B, xs, me=QR, whole=False):
    """`me` (QuickReview unless named) against the best of the six other reviewers on the defects `xs`."""
    others = rivals(B)
    found = {t: _languages_found(xs, t, whole) for t in [me] + others}
    # the best of the others is known only when every one of them is: an unread one might be the best
    best = max(found[t] for t in others) if others and all(found[t] is not None for t in others) else None
    q = found[me]
    return {
        "n": len(xs), "me": me, "found": found, "best": best,
        "best_tools": [] if best is None else sorted(t for t in others if found[t] == best),
        "first": q is not None and best is not None and q > best,  # strictly ahead: a tie is not a first
    }


def _languages_rows(B, V):
    """One row per AACR-Bench language (the PR's `language`, i.e. AACR's project_main_language),
    ordered by defect count; plus the number of defects whose PR carries no language label."""
    by, unlabelled = {}, 0
    for x in B.D:
        lang = (V.d["prs"].get(x["pr"]) or {}).get("language")
        if lang:
            by.setdefault(lang, []).append(x)
        else:
            unlabelled += 1
    rows = []
    for lang, xs in by.items():
        r = _languages_cut(B, xs)
        r.update(language=lang, xs=xs, prs=sum(1 for p in V.d["prs"].values() if p.get("language") == lang),
                 prs_with=len({x["pr"] for x in xs}))
        rows.append(r)
    rows.sort(key=lambda r: (-r["n"], r["language"]))
    return rows, unlabelled


def _languages_share(v, n):
    return None if v is None else float(v / n)


def _languages_d1(v):
    """An exact Fraction to one decimal, halves away from zero (28.75 -> 28.8, not float rounding's 28.7)."""
    k = math.floor(abs(v) * 10 + Fraction(1, 2))
    return ("-" if v < 0 and k else "") + f"{k // 10}.{k % 10}"


def _languages_gap(c):
    """The cut's subject minus the best other reviewer, in exact percentage points; None when unknown."""
    q, b = c["found"][c["me"]], c["best"]
    return None if q is None or b is None or not c["n"] else (q - b) * 100 / c["n"]


def _languages_pts(g):
    return "unknown" if g is None else ("+" if g > 0 else "") + _languages_d1(g)


def _languages_lead(c):
    """The cut's lead over the best other reviewer, in points and in defects, signed; None when unknown."""
    g = _languages_gap(c)
    if g is None:
        return None
    d = c["found"][c["me"]] - c["best"]
    return _languages_pts(g), f"{'+' if d > 0 else ''}{fmt(float(d))} defect{'' if abs(d) == 1 else 's'}"


def _languages_thin_note(B, V, rows):
    """The thin-tiles caveat: their sizes, the narrowest lead and what partial credit does to it, the earlier
    build in the paper's per-language table, and the runner-up ties."""
    thin = [r for r in rows if r["n"] < LANGUAGES_THIN]
    out = ["Thin tiles: " + ", ".join(f"{r['language']} {r['n']}" for r in thin) + " defects."] if thin else []
    won = [r for r in rows if r["first"]]
    if won:
        r = min(won, key=lambda r: (r["found"][QR] - r["best"], r["language"]))
        w = _languages_cut(B, r["xs"], whole=True)
        wq, wb = w["found"][QR], w["best"]
        state = ("unknown" if wq is None or wb is None else "a tie" if wq == wb else "behind" if wq < wb
                 else "still ahead")
        whole_first = sum(1 for x in rows if _languages_cut(B, x["xs"], whole=True)["first"])
        out.append(f"The narrowest lead is {r['language']}'s, {fmt(float(r['found'][QR]))} vs {fmt(float(r['best']))} "
                   f"of {r['n']}; with a partly found defect counted as found it is {state}"
                   + ("" if state == "unknown" else f" ({fmt(float(wq))} vs {fmt(float(wb))})")
                   + f" and QuickReview is first in {whole_first} of {len(rows)}.")
    old = [(r["language"], _languages_cut(B, r["xs"], me=OCT1)) for r in rows]
    if any(c["found"][OCT1] is None or c["best"] is None for _, c in old):
        out.append(f"How {B.name(OCT1)}, the earlier build in the paper's per-language table, compares is unknown "
                   "(an unreadable credit).")
    else:
        behind = [f"{lang} ({fmt(float(c['found'][OCT1]))} vs {fmt(float(c['best']))})" for lang, c in old
                  if c["found"][OCT1] < c["best"]]
        tied = [lang for lang, c in old if c["found"][OCT1] == c["best"]]
        where = ([f"behind in {_languages_and(behind)}"] if behind else []) + (
            [f"tied in {_languages_and(tied)}"] if tied else [])
        out.append(f"{B.name(OCT1)}, the earlier build in the paper's per-language table, is "
                   + (" and ".join(where) if where else f"first in all {len(rows)} too") + ".")
    ties = [f"{r['language']} ({', '.join(V.name(t) for t in r['best_tools'])})" for r in rows
            if len(r["best_tools"]) > 1]
    out.append(f"Runner-up ties: {'; '.join(ties)}." if ties else "No runner-up is a tie.")
    return " ".join(out)


def _languages_key_note(B, V, rows):
    """The key-provenance sentence, from the data part's provenance classes when they cover every defect; else
    a sentence with no number and no claim, because the cut cannot be computed (unknown is never zero)."""
    prov = ((V.d.get("ideas") or {}).get("idea-languages") or {}).get("provenance") or {}
    cls = {k: c for c, ks in prov.items() for k in ks}
    key = lambda x: f"{x['pr']}|{x['id']}"  # noqa: E731
    of = [cls.get(key(x), "unknown") for x in B.D]
    if not of or "unknown" in of:
        return ("Some defects entered the key only because a benchmarked reviewer's comment raised them, "
                "QuickReview's earlier builds among the sources; the cut on the blind hunt's defects alone is unknown "
                "here (no provenance data).")
    hunt = [x for x in B.D if cls[key(x)] == "hunt"]
    by = [(r, _languages_cut(B, [x for x in r["xs"] if cls[key(x)] == "hunt"])) for r in rows]
    by = [(r, c) for r, c in by if c["n"]]
    k = sum(1 for _, c in by if c["first"])
    g_all, g_hunt = _languages_gap(_languages_cut(B, B.D)), _languages_gap(_languages_cut(B, hunt))
    still = "still " if k == len(by) == len(rows) and all(r["first"] for r in rows) else ""
    s = (f"Of the {len(B.D)}, {of.count('comments')} entered the key only because a benchmarked reviewer's comment "
         f"raised them, QuickReview's earlier builds among the sources; on the {len(hunt)} the blind hunt found, "
         f"QuickReview is {still}first in {k} of {len(by)} languages")
    if g_all is None or g_hunt is None:
        return s + "; its overall lead there is unknown (an unreadable credit)."
    if g_hunt >= g_all:
        return s + f", its overall lead {_languages_pts(g_hunt)} pts against {_languages_pts(g_all)} on all {len(B.D)}."
    pairs = [(r["language"], _languages_gap(r), _languages_gap(c)) for r, c in by]
    drops = [(a - h, lang, h, a) for lang, a, h in pairs if a is not None and h is not None]
    drop = max(drops) if drops else None  # the largest fall; a tie goes to the later name, deterministically
    return s + (f", by less: {_languages_pts(g_hunt)} pts overall against {_languages_pts(g_all)}"
                + (f"; in {drop[1]}, where it falls most, {_languages_pts(drop[2])} against {_languages_pts(drop[3])}"
                   if drop and drop[0] > 0 else "") + ".")


def _languages_width(p, s, **kw):
    """Width in page pixels of `s` set as Page.text would set it."""
    t = p.text(0, 0, s, **kw)
    bb = t.get_window_extent(renderer=p.fig.canvas.get_renderer())
    t.remove()
    return bb.width * p.w / p.fig.bbox.width


def fig_idea_languages(B, V, T):
    rows, _ = _languages_rows(B, V)
    others = rivals(B)
    n = len(rows)
    firsts = sum(1 for r in rows if r["first"])
    p = Page(T)
    p.title(f"Most defects found in all {n} languages" if firsts == n > 0 else
            f"Most defects found in {firsts} of {n} languages" if firsts else "Defects found, by language")
    p.text(64, 128, f"blue: QuickReview    grey: the best of the {_languages_word(len(others))} other reviewers",
           size=12, color=T["ink2"], va="baseline")
    lines = 2 if n > 4 else 1
    cols = math.ceil(n / lines)
    gx = gy = 16
    left, right, top, bottom = 64, 1136, 154, 604
    w = (right - left - gx * (cols - 1)) / cols
    h = (bottom - top - gy * (lines - 1)) / lines
    pad, thick = 20, 12
    inner = w - 2 * pad
    lab = {"size": 12, "color": T["ink2"]}
    # one scale for every tile: 0..100% as long as the tile allows with the grey value beside its tip
    span = inner
    for r in rows:
        b = _languages_share(r["best"], r["n"])
        if b:
            span = min(span, (inner - 7 - _languages_width(p, pct(b), **lab)) / b)
    card = "#f2f1ec" if light(T) else "#242423"
    for i, r in enumerate(rows):
        rr, c = divmod(i, cols)
        x0, y0 = left + c * (w + gx), top + rr * (h + gy)
        p.c.add_patch(FancyBboxPatch((x0, y0), w, h, boxstyle="round,pad=0,rounding_size=12", facecolor=card,
                                     edgecolor="none", zorder=0.5))
        q, b = _languages_share(r["found"][QR], r["n"]), _languages_share(r["best"], r["n"])
        bx = x0 + pad
        p.text(bx, y0 + 46, r["language"], size=15, weight="bold", va="baseline")
        p.text(bx, y0 + 70, f"{r['n']} defects", size=11.5, color=T["muted"], va="baseline")
        p.text(bx, y0 + 128, pct(q) if q is not None else "?", size=30, weight="bold", va="baseline",
               color=T["ink"] if q is not None else T["muted"])
        yq, yo = y0 + 158, y0 + 182
        if b is not None:
            bar(p.c, bx, bx + span * b, yo, thick, T["other"], zorder=3)
            p.text(bx + span * b + 7, yo, pct(b), **lab)
        else:  # unknown is never zero: say so instead of drawing nothing
            p.text(bx, yo, "?", size=12, color=T["muted"])
        if q is not None:
            bar(p.c, bx, bx + span * q, yq, thick, T["qr"], zorder=4)
    p.source(f"AACR-Bench · {len(V.d['prs'])} PRs · share of each language's verified defects found, all severities "
             "· language = the project's main language")
    return p


def numbers_idea_languages(B, V):
    """The table behind the image, for out/v3/NUMBERS.md."""
    rows, unlabelled = _languages_rows(B, V)
    others = rivals(B)
    names = lambda ts: ", ".join(V.name(t) for t in ts)  # noqa: E731
    nm = lambda ts: names(ts) + (" (tied)" if len(ts) > 1 else "")  # noqa: E731

    def side(v, n):
        if v is None:
            return "unknown | | ?"
        return f"{fmt(float(v))} | {_languages_d1(v * 100 / n)} | {pct(float(v / n))}"

    def cells(label, r, prs):
        lead = _languages_lead(r)
        return (f"| {label} | {prs} | {r['n']} | {side(r['found'][QR], r['n'])} "
                f"| {nm(r['best_tools']) if r['best_tools'] else 'unknown'} | {side(r['best'], r['n'])} "
                f"| {'unknown' if lead is None else f'{lead[0]} pts / {lead[1]}'} |")

    firsts = sum(1 for r in rows if r["first"])
    closed = [V.name(t) for t in others if B.kind(t) == "closed"]
    who = (f"{closed[0]} is the only closed-source one" if len(closed) == 1 else
           f"{_languages_and(closed)} are closed-source" if closed else "all of them open-source")
    out = ["### idea-languages", "",
           f"Share of each language's verified AACR-Bench defects found (all severities): QuickReview against the "
           f"best of the {_languages_word(len(others))} other reviewers in that language ({names(others)}; {who}); "
           f"tiles ordered by defect count. QuickReview has the most in {firsts} of {len(rows)} languages (a tie "
           f"would not count).", "",
           "| Language | PRs (with a defect) | Defects | QuickReview found | % | on image | Best other reviewer "
           "| found | % | on image | Lead |",
           "|---|---|---|---|---|---|---|---|---|---|---|"]
    for r in rows:
        out.append(cells(r["language"], r, f"{r['prs']} ({r['prs_with']})"))
    thin = [r for r in rows if r["n"] < LANGUAGES_THIN]
    if thin:
        pool = _languages_cut(B, [x for r in thin for x in r["xs"]])
        prs = sum(r["prs"] for r in thin)
        out.append(cells(" + ".join(r["language"] for r in thin) + " pooled (not drawn)", pool,
                         f"{prs} ({sum(r['prs_with'] for r in thin)})"))
    out.append(cells("All languages (not drawn)", _languages_cut(B, B.D),
                     f"{len(V.d['prs'])} ({len({x['pr'] for x in B.D})})"))
    out.append("")
    # caveats, every number computed
    hm = [_languages_cut(B, [x for x in r["xs"] if x["severity"] in SERIOUS]) for r in rows]
    hm_first = sum(1 for c in hm if c["first"])
    hm_tied = [r["language"] for r, c in zip(rows, hm)
               if not c["first"] and c["found"][QR] is not None and c["found"][QR] == c["best"]]
    sets = {iid: pr.get("set") for iid, pr in V.d["prs"].items()}
    ins = [x for x in B.D if sets.get(x["pr"]) == "rest145"]
    oos = [x for x in B.D if sets.get(x["pr"]) in ("holdout10", "fresh10")]

    def per_pr(f, form, unit=""):  # QuickReview's figure and the others' range, or None when any is unknown
        vals = {t: f(t) for t in [QR] + others}
        if any(v is None for v in vals.values()):
            return None
        rest = [vals[t] for t in others]
        return f"{form(vals[QR])}{unit} (the others {form(min(rest))} to {form(max(rest))})"

    comments = per_pr(lambda t: V.grades(t)["per_pr"], lambda v: f"{v:.1f}", " comments")
    cost = per_pr(lambda t: V.mean(t, "usd"), lambda v: f"${v:.2f}")
    out += [
        "- Language is AACR-Bench's project_main_language (the repository's main language), not the language of "
        "each changed file"
        + (f"; {unlabelled} defects in PRs without a label are in no tile" if unlabelled else "")
        + ". AACR-Bench only: on Qodo PR-Review-Bench QuickReview is not first in several languages.",
        "- " + _languages_thin_note(B, V, rows),
        f"- All severities, recall only: on high and medium defects alone QuickReview is strictly first in "
        f"{hm_first} of {len(rows)} languages and tied first in {_languages_and(hm_tied) or 'none'}. Per PR "
        f"QuickReview posts {comments or 'an unknown number of comments'} and costs {cost or 'an unknown amount'}.",
        f"- In-sample: {len(ins)} of the {len(B.D)} defects are in rest145, the set the frozen build's changes were "
        f"mined from (lead {_languages_pts(_languages_gap(_languages_cut(B, ins)) if ins else None)} pts there); on "
        f"the {len(oos)} never-used holdout10 + fresh10 defects the overall lead is "
        f"{_languages_pts(_languages_gap(_languages_cut(B, oos)) if oos else None)} pts. "
        + _languages_key_note(B, V, rows),
    ]
    return "\n".join(out) + "\n"


# ---------------------------------------------------------------- idea-commercial-misses: Martian's 30 held-out PRs:
#   per commercial tool, the real bugs most of the other 13 missed.
COMMERCIAL_MISSES_HELD_OUT = "test30"  # the 30 Martian PRs never used to tune QuickReview
COMMERCIAL_MISSES_IDEA = "idea-commercial-misses"
# Half the height of a digit or a capital, in ems: Noto Sans 0.357 (the fallback fonts within 0.01). A row's
# text sits on the baseline that puts its digits' centre on the dots' centre line.
COMMERCIAL_MISSES_CAP_MID = 0.357


def _commercial_misses_data(V):
    d = (V.d.get("ideas") or {}).get(COMMERCIAL_MISSES_IDEA)
    return d if d and d.get("goldens") is not None else None


def _commercial_misses_real(g):
    return g["bucket"] == "real"


def _commercial_misses_rows(d, split=None, cut=None, keep=None):
    """One row per commercial tool X: its contested set = the goldens kept (default: the real bugs, our audit's
    bucket) of `split` (or all 50 PRs) that at most `cut` of the OTHER commercial tools found (default: fewer
    than half of them, i.e. most of them missed it). Neither X nor QuickReview enters the set's definition.
    Goldens with an unknown grading are left out."""
    keep = keep or _commercial_misses_real
    tools = sorted(d["tools"])
    gs = [g for g in d["goldens"] if not g.get("unknown") and (split is None or g["split"] == split) and keep(g)]
    cut = (len(tools) - 2) // 2 if cut is None else cut
    rows = []
    for t in tools:
        hard = [g for g in gs if sum(o in g["found_by"] for o in tools if o != t) <= cut]
        x = sum(t in g["found_by"] for g in hard)
        q = sum(QR in g["found_by"] for g in hard)
        rows.append({"tool": t, "x": x, "q": q, "n": len(hard), "ids": [g["id"] for g in hard],
                     "x_only": sum(t in g["found_by"] and QR not in g["found_by"] for g in hard),
                     "q_only": sum(QR in g["found_by"] and t not in g["found_by"] for g in hard)})
    return rows


def _commercial_misses_sorted(B, rows):
    """By the tool's share of its own set, highest first; ties by name; empty sets last."""
    return sorted(rows, key=lambda r: (r["n"] == 0, -fractions.Fraction(r["x"], r["n"] or 1),
                                       B.name(r["tool"]).lower()))


def _commercial_misses_score(rows):
    rows = [r for r in rows if r["n"]]
    return (sum(r["q"] > r["x"] for r in rows), sum(r["q"] == r["x"] for r in rows),
            sum(r["q"] < r["x"] for r in rows), len(rows))


def _commercial_misses_title(rows):
    """Counts only the rows QuickReview is ahead on. It never says "never behind": the level rows can rest
    on a few low-severity bugs (NUMBERS.md), and a count claims nothing about them."""
    ahead, _, _, n = _commercial_misses_score(rows)
    if not n:
        return "No bugs here that most tools miss"
    if ahead == n:
        return f"Ahead of all {n} on bugs most tools miss"
    return f"Ahead of {ahead or 'none'} of {n} on bugs most tools miss"


def _commercial_misses_prs(d, split):
    return sum(1 for s in d["prs"].values() if s == split)


def _commercial_misses_width(p, t):
    (a, _), (b, _) = p.c.transData.inverted().transform(
        t.get_window_extent(renderer=p.fig.canvas.get_renderer()).get_points())
    return abs(b - a)


def _commercial_misses_base(p, y, size=14):
    """The baseline that centres a `size`-point digit or capital on y (page pixels, y down)."""
    return y + COMMERCIAL_MISSES_CAP_MID * size * p.fig.dpi / 72


def _commercial_misses_sign_p(a, b):
    """Two-sided exact sign test over the bugs exactly one of the two found."""
    n, k = a + b, min(a, b)
    return 1.0 if n == 0 else min(1.0, 2 * sum(math.comb(n, i) for i in range(k + 1)) / 2 ** n)


def fig_idea_commercial_misses(B, V, T):
    d = _commercial_misses_data(V)
    p = Page(T, h=720)
    if d is None:
        p.title("Martian results not available")
        p.source("Martian · the archived runs were not readable")
        return p
    split = COMMERCIAL_MISSES_HELD_OUT
    rows = _commercial_misses_sorted(B, _commercial_misses_rows(d, split))
    p.title(_commercial_misses_title(rows))
    # the key: one line under the title, grey then blue, the order of every row and of every label
    x = 64
    for fill, label, w in ((T["other"], "the tool named on the row", "normal"), (T["qr"], "QuickReview", "bold")):
        dot(p, x + 6, 123.5, 6, fill, T)
        t = p.text(x + 18, 128, label, size=12, weight=w, color=T["ink"] if w == "bold" else T["ink2"],
                   va="baseline")
        x += 18 + _commercial_misses_width(p, t) + 30
    x0, x1, top, bottom = 268, 950, 158, 628
    X = lambda v: x0 + (x1 - x0) * v  # noqa: E731
    for tk in (0, .25, .5, .75, 1):
        p.c.plot([X(tk)] * 2, [top, bottom], color=T["grid"], lw=1, zorder=1)
        p.text(X(tk), bottom + 24, pct(tk), size=11, color=T["muted"], ha="center")
    pitch = (bottom - top) / len(rows)
    probe = p.text(0, -100, "00", size=14)  # two digits wide: the column the tools' counts end on
    c1 = x1 + 34 + _commercial_misses_width(p, probe)
    probe.remove()
    for i, r in enumerate(rows):
        y = top + pitch * (i + 0.5)
        base = _commercial_misses_base(p, y)  # every text of the row on one baseline, digits centred on the dots
        p.text(x0 - 18, base, B.name(r["tool"]), size=14, ha="right", color=T["ink2"], va="baseline")
        if not r["n"]:
            p.text(c1 + 7, base, "no such bugs", size=12, color=T["muted"], va="baseline")
            continue
        gx, qx = X(r["x"] / r["n"]), X(r["q"] / r["n"])
        if r["q"] == r["x"]:  # level: the blue ring around the grey dot
            p.c.add_patch(Circle((gx, y), 13.5, facecolor=T["surface"], edgecolor="none", zorder=5))
            p.c.add_patch(Circle((gx, y), 11, facecolor="none", edgecolor=T["qr"], lw=2.4, zorder=6))
            p.c.add_patch(Circle((gx, y), 6.5, facecolor=T["other"], edgecolor="none", zorder=6))
        else:
            p.c.plot([gx, qx], [y, y], color=T["other"], lw=2, zorder=2, solid_capstyle="butt")
            dot(p, gx, y, 7, T["other"], T)
            dot(p, qx, y, 8.5, T["qr"], T)
        # "x vs q of n": the tool's count ends on one column so every "vs" lines up; the rest flows
        p.text(c1, base, str(r["x"]), size=14, ha="right", color=T["ink2"], va="baseline")
        vs = p.text(c1 + 7, base, "vs", size=12, color=T["muted"], va="baseline")
        cx = c1 + 7 + _commercial_misses_width(p, vs) + 7
        q = p.text(cx, base, str(r["q"]), size=14, weight="bold", color=T["ink"], va="baseline")
        p.text(cx + _commercial_misses_width(p, q) + 7, base, f"of {r['n']}", size=12, color=T["muted"],
               va="baseline")
    p.source(f"Martian · {_commercial_misses_prs(d, split)} held-out PRs · real bugs (our audit) that most of the "
             f"other {len(d['tools']) - 1} commercial tools missed · recall only · QuickReview: our judge, "
             "others: Martian's")
    return p


def _commercial_misses_and(names):
    return names[0] if len(names) == 1 else ", ".join(names[:-1]) + " and " + names[-1]


def _commercial_misses_vs(B, r):
    return f"{B.name(r['tool'])} {r['x']} vs {r['q']} of {r['n']}"


def _commercial_misses_table(head, rows):
    return "\n".join(["| " + " | ".join(head) + " |", "|---" * len(head) + "|"]
                     + ["| " + " | ".join(str(c) for c in r) + " |" for r in rows])


def numbers_idea_commercial_misses(B, V):
    head = f"### {COMMERCIAL_MISSES_IDEA}\n\n"
    d = _commercial_misses_data(V)
    if d is None:
        raw = (V.d.get("ideas") or {}).get(COMMERCIAL_MISSES_IDEA) or {}
        why = raw.get("error") or (f"missing {', '.join(raw['missing'])}" if raw.get("missing") else
                                   "the Martian runs were not readable when data/v3.json was built")
        return head + f"Not available: {why}.\n"
    split = COMMERCIAL_MISSES_HELD_OUT
    m = len(d["tools"]) - 1
    cut = (m - 1) // 2
    n30, n50 = _commercial_misses_prs(d, split), len(d["prs"])
    rows = _commercial_misses_sorted(B, _commercial_misses_rows(d, split))
    by_tool = {r["tool"]: r for r in rows}
    every = {r["tool"]: r for r in _commercial_misses_rows(d)}
    byid = {g["id"]: g for g in d["goldens"]}
    held = [g for g in d["goldens"] if g["split"] == split]
    n_real = sum(map(_commercial_misses_real, held))
    ahead, level, behind, _ = _commercial_misses_score(rows)
    cuts = {k: _commercial_misses_score(_commercial_misses_rows(d, split, cut=k))[2] for k in range(3, 10)}
    out = [head + f"Martian, the {n30} PRs never used to tune QuickReview: for each of the {len(d['tools'])} "
           f"commercial reviewers, the real bugs (our audit's bucket) that at most {cut} of the other {m} found, "
           f"and the share of them that tool (grey) and QuickReview (blue) each found. QuickReview: {ahead} ahead, "
           f"{level} level, {behind} behind"
           + (f"; behind in no row at any cut from 3 to 9 of {m}" if not any(cuts.values()) else
              f"; rows behind by cut (at most k of {m}): " + ", ".join(f"{k}: {v}" for k, v in cuts.items())) + ".\n"]

    same = {}  # our judge's count for a re-graded tool, on that tool's own set (None: a grading is unknown)
    for t in d.get("same_judge_tools") or ():
        hard = [byid[i] for i in by_tool[t]["ids"]] if t in by_tool else []
        same[t] = (sum(t in g["same_judge"] for g in hard) if all(g.get("same_judge") is not None for g in hard)
                   else None)
    table = []
    for r in rows:
        a = every[r["tool"]]
        share = (lambda k: f"{100 * r[k] / r['n']:.1f}") if r["n"] else (lambda k: "–")
        sj = same.get(r["tool"], "–")
        table.append([B.name(r["tool"]), r["n"], r["x"], r["q"], share("x"), share("q"),
                      f"{r['x_only']} / {r['q_only']}", f"{_commercial_misses_sign_p(r['x_only'], r['q_only']):.2f}",
                      "unknown" if sj is None else sj, f"{a['x']} vs {a['q']} of {a['n']}"])
    out.append(_commercial_misses_table(
        ["reviewer", "bugs in its set", "it found", "QuickReview found", "it %", "QuickReview %",
         "only it / only QuickReview", "sign-test p", "it, by our judge",
         f"all {n50} PRs (incl. {n50 - n30} tuning): it vs QuickReview of n"], table) + "\n")
    sized = [r for r in rows if r["n"]]
    union = sorted({i for r in sized for i in r["ids"]})
    if sized:
        lo, hi = min(r["n"] for r in sized), max(r["n"] for r in sized)
        sev = ", ".join(f"{s} {sum(byid[i]['severity'] == s for i in union)}" for s in ("Critical", "High", "Medium", "Low"))
        sig = [B.name(r["tool"]) for r in sized if _commercial_misses_sign_p(r["x_only"], r["q_only"]) < 0.05]
        shared = sum(all(i in r["ids"] for r in sized) for i in union)
        out.append(f"The rows draw on {len(union)} bugs ({sev}), {shared} of them in every row, so they are not "
                   f"{len(sized)} independent comparisons; with {lo}–{hi} bugs a row one bug moves a row "
                   f"{100 / hi:.0f}–{100 / lo:.0f} points, and the sign test reaches p < 0.05 only for "
                   f"{_commercial_misses_and(sig) if sig else 'no row'}.\n")

    keys = [("real, our audit (drawn)", _commercial_misses_real),
            ("real, without Low severity", lambda g: g["bucket"] == "real" and g["severity"] != "Low"),
            ("real, Critical and High only", lambda g: g["bucket"] == "real" and g["severity"] in ("Critical", "High")),
            ("real or disputed, our audit", lambda g: g["bucket"] in ("real", "disputed")),
            ("every golden on Martian's list", lambda g: True)]
    sens, rs_by = [], {}
    for label, keep in keys:
        rs_by[label] = rs = _commercial_misses_sorted(B, _commercial_misses_rows(d, split, keep=keep))
        a_, l_, b_, n_ = _commercial_misses_score(rs)
        where = "; ".join(_commercial_misses_vs(B, r) for r in rs if r["n"] and r["q"] < r["x"]) or "–"
        sens.append([label, a_, l_, b_, where + (f" ({len(rs) - n_} rows with no such bugs)" if n_ < len(rs) else "")])
    out.append(f"The same {n30} PRs and cut, counting other goldens:\n\n" + _commercial_misses_table(
        ["bugs counted", "ahead", "level", "behind", "where QuickReview is behind (it vs QuickReview of n)"], sens)
        + "\n")

    left_out = sum(1 for g in held if g.get("unknown") and _commercial_misses_real(g))
    a50, _, _, n_rows = _commercial_misses_score(list(every.values()))
    tuned = [B.name(r["tool"]) for r in rows if r["n"] and r["q"] <= r["x"]
             and every[r["tool"]]["q"] > every[r["tool"]]["x"]]
    bullets = [f"Held out: only the {n30} PRs whose goldens were never read while tuning QuickReview are drawn "
               f"({n_real} real bugs" + (f", {left_out} left out for an unknown grading" if left_out else "")
               + f"). On all {n50} PRs it is ahead in {a50} of {n_rows} rows"
               + (f", but its leads over {_commercial_misses_and(tuned)} come only from the {n50 - n30} tuning PRs"
                  if tuned else "") + "."]

    nolow = {r["tool"]: r for r in rs_by[keys[1][0]]}
    tied = [r for r in sized if r["q"] == r["x"]]
    flips = [r for r in tied if nolow[r["tool"]]["q"] < nolow[r["tool"]]["x"]]
    if flips:
        low = sorted({i for r in flips for i in r["ids"] if byid[i]["severity"] == "Low"})
        cats = [byid[i]["category"] for i in low]
        doc = ("" if None in cats else
               f" ({sum(c == 'doc_defect' for c in cats)} of them documentation defects by Martian's category)")
        names = _commercial_misses_and([B.name(r["tool"]) for r in flips])
        many = len(flips) > 1
        bullets.append(("Both ties, with " + names + "," if len(flips) == len(tied) == 2 else
                        f"The tie{'s' if many else ''} with {names}")
                       + f" rest{'' if many else 's'} on the {len(low)} Low-severity bug{'s' if len(low) != 1 else ''}"
                       f" in {'their sets' if many else 'its set'}{doc}: without them QuickReview is behind "
                       f"{'both' if len(flips) == 2 else 'each' if many else 'there'} (second table), so the title "
                       "counts only the rows it is ahead on.")

    raw = [r for r in rs_by[keys[-1][0]] if r["n"] and r["q"] < r["x"]]
    blind = [g["blind"] for g in held]
    key = ("On Martian's own golden list QuickReview is behind "
           + (f"{len(raw)} of {len(rows)} rows (second table)" if raw else "no row"))
    if raw and all(by_tool[r["tool"]]["q"] >= by_tool[r["tool"]]["x"] for r in raw):
        key += "; on the real bugs of those same rows it is never behind"
    if None not in blind:
        key += (f". Our audit judged {'all' if all(blind) else f'{sum(blind)} of the'} {len(held)} goldens of these "
                f"PRs without seeing any reviewer's output, and calls {n_real} of them real")
    bullets.append(key + ".")

    iss = {t: (v or {}).get(split) for t, v in (d.get("issues") or {}).items()}
    others = sorted(v for t, v in iss.items() if t != QR and v is not None)
    dates = sorted(x for v in (d.get("review_dates") or {}).values() for x in v)
    graded = {t: v for t, v in same.items() if v is not None and t in by_tool}
    more = [B.name(t) for t, v in graded.items() if v > by_tool[t]["x"]]
    judges = (f"Two judges: ours ({d['judge']}) for QuickReview, Martian's published Opus 4.5 grading for the tools; "
              + ("where ours also graded a tool it credited no more than Martian's did ('it, by our judge')"
                 if graded and not more else f"ours credited more for {_commercial_misses_and(more)}" if more else
                 "no tool was graded both ways") + ". Recall only: here QuickReview's reviews yield "
              + (f"{iss[QR]} extracted issues" if iss.get(QR) is not None else "an unknown number of issues")
              + (f", the tools' {others[0]}–{others[-1]}" if others else "") + ".")
    if dates:
        judges += (f" Vendors reviewed from {dates[0]} to {dates[-1]}"
                   + (f"; QuickReview's run started {d['qr_review_started']}" if d.get("qr_review_started") else "")
                   + ".")
    bullets.append(judges)
    out.append("\n".join("- " + b for b in bullets))
    return "\n".join(out) + "\n"


# ---------------------------------------------------------------- idea-robust: QuickReview's lead over the best of
#   the six on four cuts of the answer key, with intervals.
ROBUST_SEED = 20261001  # the paper's bootstrap seed and draw order (final_tables.py)
ROBUST_ALT_SEED = 20261013  # the per-cut analyses' seed, for the sensitivity line in NUMBERS.md
ROBUST_RESAMPLES = 10000
ROBUST_LEFT_OUT = ("holdout10", "fresh10")  # the sets the frozen build's final changes neither mined nor validated on
ROBUST_WORDS = {5: "five", 6: "six", 7: "seven", 8: "eight"}


def _robust_key(x):
    return f"{x['pr']}|{x['id']}"


def _robust_source(B, V):
    """"<pr>|<id>" -> the sources that put the defect in the key (None: unknown) — the data part's provenance."""
    prov = ((V.d.get("ideas") or {}).get("idea-robust") or {}).get("provenance") or {}
    return {_robust_key(x): prov.get(_robust_key(x)) for x in B.D}


def _robust_cuts(B, V):
    """[(name, n line, defects, the PRs a resample draws from)] for the four cuts, always all four, in order. Every
    key cut resamples all the benchmark's PRs (the paper's universe); the last one resamples its own 20. A defect
    whose provenance, or a PR whose set, cannot be read is never counted in a cut, and the n line says how many;
    a cut that nothing can be read for has defects None: drawn as unknown, never dropped."""
    src = _robust_source(B, V)
    prs = V.d.get("prs") or {}
    every = sorted(set(prs) | {x["pr"] for x in B.D})  # every PR of the benchmark, a defect or not
    sets = {i: (prs.get(i) or {}).get("set") for i in every}
    n = len(B.D)
    known = [x for x in B.D if src[_robust_key(x)] is not None]
    gap = f", {n - len(known)} unknown" if len(known) < n else ""
    by = lambda *names: [x for x in known if set(names) & set(src[_robust_key(x)])] if known else None  # noqa: E731
    of = lambda xs: "provenance unknown" if xs is None else f"{len(xs)} of {n}{gap}"  # noqa: E731
    indep, refs = by("hunt", "dataset_refs"), by("dataset_refs")  # unknown provenance is never counted as independent
    unset = sum(1 for v in sets.values() if v is None)
    left = sorted(i for i in every if sets[i] in ROBUST_LEFT_OUT)
    kept = [x for x in B.D if sets[x["pr"]] in ROBUST_LEFT_OUT] if unset < len(every) else None
    sub = ("set membership unknown" if kept is None else
           f"{len(kept)} of {n}, on {len(left)} PRs" + (f", {unset} PRs unknown" if unset else ""))
    return [("Whole answer key", f"{n} defects", B.D, every),
            ("Without defects only reviewers raised", of(indep), indep, every),
            ("AACR's own references only", of(refs), refs, every),
            ("PRs left out of the final tuning", sub, kept, left)]


def _robust_draws(universe, cache, seed=ROBUST_SEED):
    """ROBUST_RESAMPLES resamples of the PRs as index lists: random.Random(seed), rng.choice per PR over the sorted
    ids — the paper's draw order, so its published intervals reproduce. Cuts on one universe share them."""
    key = (seed, tuple(universe))
    if key not in cache:
        rng = random.Random(seed)
        ix = range(len(universe))
        cache[key] = [[rng.choice(ix) for _ in ix] for _ in range(ROBUST_RESAMPLES)]
    return cache[key]


def _robust_lead(B, defects, universe, cache, seed=ROBUST_SEED):
    """QuickReview's recall minus the best other reviewer's on these defects, with two 95% percentile intervals over
    paired PR resamples: the best other RE-PICKED in every resample (the plotted, conservative one) and the
    full-sample best held fixed (the usual paired difference). Credits are summed per PR once, up front.
    None when there is nothing to score or a reviewer lacks a verdict: unknown, never a zero lead."""
    tools = [QR] + rivals(B)
    if not defects or any(x["credit"].get(t) is None for x in defects for t in tools):
        return None
    pos = {iid: k for k, iid in enumerate(universe)}
    cols = [[0.0] * len(universe) for _ in range(len(tools) + 1)]  # cols[0]: defects per PR
    for x in defects:
        k = pos[x["pr"]]
        cols[0][k] += 1
        for j, t in enumerate(tools):
            cols[1 + j][k] += x["credit"][t]
    n = sum(cols[0])
    found = {t: sum(cols[1 + j]) for j, t in enumerate(tools)}
    rec = {t: 100 * found[t] / n for t in tools}
    best = max(tools[1:], key=lambda t: rec[t])
    b = tools.index(best)
    draws = _robust_draws(universe, cache, seed)
    repick, fixed = [], []
    for idx in draws:
        g = [sum(map(c.__getitem__, idx)) for c in cols]
        m = max(g[0], 1)
        repick.append(100 * (g[1] - max(g[2:])) / m)
        fixed.append(100 * (g[1] - g[1 + b]) / m)
    repick.sort()
    fixed.sort()
    lo, hi = int(.025 * len(draws)), int(.975 * len(draws)) - 1  # sorted index 250 and 9749
    return {"n": int(n), "prs": len(universe), "rec": rec, "found": found, "best": best, "lead": rec[QR] - rec[best],
            "lo": repick[lo], "hi": repick[hi], "fixed": (fixed[lo], fixed[hi]),
            "ahead": sum(1 for v in repick if v > 0) / len(draws),
            "ahead_fixed": sum(1 for v in fixed if v > 0) / len(draws)}


def _robust_rows(B, V, cache):
    """The four rows in order; stats None when a cut cannot be scored: unknown, or (empty) no defects in it."""
    return [{"name": name, "sub": sub, "empty": xs is not None and not xs,
             "stats": _robust_lead(B, xs, prs, cache) if xs else None}
            for name, sub, xs, prs in _robust_cuts(B, V)]


def _robust_title(rows):
    """The message, computed: every plotted interval clear of zero, else how many leads are ahead and how many
    clearly (interval above zero). Only scored rows count, and 'known' says when an unknown row is left out."""
    s = [r["stats"] for r in rows if r["stats"] is not None]
    n, ahead, clear = len(s), sum(1 for r in s if r["lead"] > 0), sum(1 for r in s if r["lo"] > 0)
    if not n:
        return "QuickReview's lead, cut by cut"
    cuts = ("known " if any(r["stats"] is None and not r["empty"] for r in rows) else "") + ("cut" if n == 1 else "cuts")
    every = {1: "the one", 2: "both"}.get(n, f"all {n}")
    if clear == n:
        return f"QuickReview's lead holds on {every} {cuts}"
    if ahead == n:
        return f"QuickReview leads on {every} {cuts}, " + (f"clearly on {clear}" if clear else "none clearly")
    return f"QuickReview leads on {ahead} of {n} {cuts}" if ahead else f"QuickReview leads on none of the {n} {cuts}"


def fig_idea_robust(B, V, T):
    rows = _robust_rows(B, V, {})
    p = Page(T)
    p.title(_robust_title(rows))
    top, bottom, x0, x1 = 150, 534, 470, 1050
    s = [r["stats"] for r in rows if r["stats"] is not None]
    vmin = min([0.0] + [r["lo"] for r in s]) - 2
    vmax = math.ceil((max([10.0] + [r["hi"] for r in s]) + 2) / 10) * 10
    X = lambda v: x0 + (x1 - x0) * (v - vmin) / (vmax - vmin)  # noqa: E731
    for v in range(math.ceil(vmin / 10) * 10, vmax + 1, 10):
        if v:
            p.c.plot([X(v)] * 2, [top, bottom], color=T["grid"], lw=1, zorder=1)
            p.text(X(v), bottom + 28, f"{v:+d}", size=11, color=T["muted"], ha="center")
    p.c.plot([X(0)] * 2, [top, bottom], color=T["muted"], lw=1.3, zorder=1.5)  # the zero line, labelled once
    p.text(X(0), bottom + 28, "no lead", size=11, color=T["muted"], ha="center")
    pitch = (bottom - top) / len(rows)
    mask = {"boxstyle": "square,pad=0.12", "facecolor": T["surface"], "edgecolor": "none"}
    tint = 0.8 if light(T) else 0.75  # the interval's blue tint, >= 3:1 against the surface in either theme
    for i, r in enumerate(rows):
        y = top + pitch * (i + 0.5)
        p.text(x0 - 30, y - 11, r["name"], size=15, ha="right")
        p.text(x0 - 30, y + 17, r["sub"], size=12, color=T["muted"], ha="right")
        st = r["stats"]
        if st is None:
            p.text(X(0) + 14, y, "no defects" if r["empty"] else "unknown", size=12, color=T["muted"])
            continue
        p.c.plot([X(st["lo"]), X(st["hi"])], [y, y], color=T["qr"], alpha=tint, lw=4, solid_capstyle="butt", zorder=2)
        dot(p, X(st["lead"]), y, 10, T["qr"], T)
        p.text(X(st["lead"]), y - 31, f"{st['lead']:+.0f}", size=16, weight="bold", ha="center", bbox=mask)
    k = len(rivals(B))
    p.text((x0 + x1) / 2, bottom + 60, f"QuickReview's lead in share of defects found, over the best of "
           f"{ROBUST_WORDS.get(k, k)} other reviewers (points)", size=12.5, color=T["ink2"], ha="center")
    p.source("AACR-Bench · recall only · one run each, one judge · 95% PR-bootstrap intervals · bottom row's PRs "
             "were used in September's tuning")
    return p


def _robust_pm(v):
    return "0.0" if round(v, 1) == 0 else f"{v:+.1f}"


def _robust_share(v):
    """A share of the resamples that never rounds a miss away: 0.9999 prints 99.99%, not 100.0%."""
    s = f"{100 * v:.1f}%"
    return "100%" if v == 1 else f"{100 * v:.2f}%" if s == "100.0%" else s


def _robust_cost(B, t):
    r = B.aacr["reviewers"].get(t) or {}
    if r.get("usd_mean") is None or not r.get("prs_judged") or r.get("comments") is None:
        return f"{B.name(t)} unknown"
    return f"{B.name(t)} ${r['usd_mean']:.2f} and {r['comments'] / r['prs_judged']:.1f} comments"


def numbers_idea_robust(B, V):
    """The table behind the image, for out/v3/NUMBERS.md."""
    cache = {}
    rows = _robust_rows(B, V, cache)
    cuts = _robust_cuts(B, V)
    src = _robust_source(B, V)
    limited = set(((V.d.get("ideas") or {}).get("idea-robust") or {}).get("benchmark_limitation") or [])
    six = ROBUST_WORDS.get(len(rivals(B)), len(rivals(B)))
    out = ["### idea-robust", "",
           f"QuickReview's lead over the best of the {six} other reviewers, in points of the share of defects found "
           "(recall), on four cuts of the AACR-Bench answer key, with a 95% PR-paired bootstrap interval that re-picks "
           "the best other reviewer in every resample (plotted).", "",
           "| Cut | Defects | PRs resampled | QuickReview | Best other on the cut | Lead (points) "
           f"| 95% interval, best re-picked (plotted) | Resamples ahead of all {six} (re-pick) "
           "| 95% interval vs that reviewer alone | Resamples ahead of that reviewer alone |",
           "|---|---|---|---|---|---|---|---|---|---|"]
    for r in rows:
        st = r["stats"]
        if st is None:
            out.append(f"| {r['name']} | {r['sub']} | | {'no defects' if r['empty'] else 'unknown'} | | | | | | |")
            continue
        out.append(f"| {r['name']} | {st['n']} | {st['prs']} | {st['rec'][QR]:.1f}% ({st['found'][QR]:g}) "
                   f"| {B.name(st['best'])} {st['rec'][st['best']]:.1f}% ({st['found'][st['best']]:g}) "
                   f"| {st['lead']:+.1f} | [{_robust_pm(st['lo'])}, {_robust_pm(st['hi'])}] "
                   f"| {_robust_share(st['ahead'])} | [{_robust_pm(st['fixed'][0])}, {_robust_pm(st['fixed'][1])}] "
                   f"| {_robust_share(st['ahead_fixed'])} |")
    out.append("")
    (n2, _, indep, _), (n3, _, refs, _), (_, _, kept, left) = cuts[1], cuts[2], cuts[3]
    if indep is not None:
        unknown = sum(1 for v in src.values() if v is None)
        also = sum(1 for x in indep if "reviewer_comments" in src[_robust_key(x)])
        out.append(f"- *{n2}* drops the {len(B.D) - len(indep) - unknown} defects only benchmarked reviewers' "
                   f"comments put in the key and keeps the {len(indep)} the expert hunt or an AACR reference raised "
                   f"({also} also raised by a reviewer); *{n3}* keeps the {len(refs)} an AACR reference points at."
                   + (f" {unknown} defects have no provenance record and sit in neither cut." if unknown else "")
                   + " Both remove membership bias only, on an AI-built key no human has audited.")
    if rows[3]["stats"] is not None:
        said = []
        nr = _robust_lead(B, [x for x in kept if _robust_key(x) not in limited], left, cache)
        if nr is not None and nr["n"] < len(kept):
            said.append(f"without the key's {len(kept) - nr['n']} CI-gate defects (benchmark_limitation) its lead is "
                        f"{nr['lead']:+.1f} [{_robust_pm(nr['lo'])}, {_robust_pm(nr['hi'])}] (best re-picked)")
        cross = _robust_lead(B, [x for x in kept if "dataset_refs" in (src[_robust_key(x)] or ())], left, cache)
        if cross is not None:
            verb = "trails" if cross["lead"] < 0 else "ties" if cross["lead"] == 0 else "leads"
            said.append(f"on its {cross['n']} AACR-reference defects QuickReview {verb} {B.name(cross['best'])}, "
                        f"{cross['rec'][QR]:.1f}% to {cross['rec'][cross['best']]:.1f}%")
        said = ", and ".join(said)
        out.append(f"- Bottom row: the {len(left)} PRs of {' and '.join(ROBUST_LEFT_OUT)}, which the frozen build's final "
                   "changes neither mined nor validated on, though September's tuning used them."
                   + (f" {said[0].upper()}{said[1:]}." if said else ""))
    alt = []
    for _, _, xs, _ in cuts[:3]:
        st = _robust_lead(B, xs, sorted({x["pr"] for x in xs}), cache, ROBUST_ALT_SEED) if xs else None
        if st is not None:
            alt.append(f"[{_robust_pm(st['fixed'][0])}, {_robust_pm(st['fixed'][1])}]")
    shift = (f"; resampling only the PRs that hold a defect of the cut, with seed {ROBUST_ALT_SEED}, gives "
             f"{alt[0]}, {alt[1]} and {alt[2]} vs that reviewer alone on rows 1-3" if len(alt) == 3 else "")
    out.append(f"- Intervals: {ROBUST_RESAMPLES:,} paired PR resamples (random.Random({ROBUST_SEED}), the paper's draw "
               f"order) over all {len(cuts[0][3])} PRs, or the bottom row's {len(left)}{shift}. They cover PR sampling "
               f"only: one run per reviewer, one judge ({B.aacr.get('judge')}, round 1), a partial find counted ½.")
    bests = sorted({r["stats"]["best"] for r in rows if r["stats"] is not None}, key=B.name)
    judged = {(B.aacr["reviewers"].get(t) or {}).get("prs_judged") for t in [QR] + bests}
    over = f"means over the {judged.pop()} PRs" if len(judged) == 1 and None not in judged else "means per reviewer"
    out.append("- Recall only, not cost. List price and comments per PR: "
               + "; ".join(_robust_cost(B, t) for t in [QR] + bests) + f" ({over}).")
    return "\n".join(out) + "\n"


# ---------------------------------------------------------------- idea-skip-nits: serious defects found against
#   comments read, as QuickReview's review is cut by tag.
SKIP_NITS_KEY = "idea-skip-nits"
# QuickReview's one review read three ways, each adding a tag. A defect counts toward a reading when
# any comment the judge credited for it carries one of the reading's tags. "other" (no tag, or another
# one) is empty for QuickReview; it belongs to the whole review, the last reading.
SKIP_NITS_STEPS = (("blockers", ("blocker",)), ("+ questions", ("blocker", "question")),
                   ("+ nits (all posted)", ("blocker", "question", "nit", "other")))
# Marks in 1x pixels; line widths in points, SKIP_NITS_PX pixels each at the design's 100 dpi.
# pi-review's dot lies 6.9 px from QuickReview's line: the others' dots at the 8 px minimum and a
# 2.5 pt line keep a gap between them.
SKIP_NITS_PX = 100 / 72
SKIP_NITS_R_QR, SKIP_NITS_R_OTHER, SKIP_NITS_LW = 6, 4, 2.5
SKIP_NITS_HALO, SKIP_NITS_GAP = 2.5, 2  # make_charts_v2.dot's surface ring; the gap kept between marks
SKIP_NITS_RING_W = 2  # px: the outline that stands in for a dot hidden under one of QuickReview's points
SKIP_NITS_BOX = (150, 150, 1050, 560)
SKIP_NITS_EQUAL = 0.25  # "equal volume" in NUMBERS: at most this many more comments per PR
# Label offsets (dx, dy, ha) from a mark's centre, tried in order (a size-12 name's box reaches ~11 px
# above its anchor and ~5 below; a reading's label, ~15 and ~6).
SKIP_NITS_AROUND = ([(13, dy, "left") for dy in (0, 10, -10, 20, -20)] + [(-13, dy, "right") for dy in (0, 10, -10, 20, -20)]
                    + [(0, -29, "center"), (0, 25, "center"), (0, -41, "center"), (0, 37, "center"),
                       (23, -33, "left"), (-23, -33, "right"), (23, 31, "left"), (-23, 31, "right"),
                       (0, -53, "center"), (0, 49, "center")])
SKIP_NITS_BELOW = [(0, 31, "center"), (0, 36, "center"), (-14, 34, "right"), (14, 34, "left"), (16, 14, "left"),
                   (0, -34, "center")]
SKIP_NITS_ABOVE = [(0, -34, "center"), (-16, -30, "right"), (16, -30, "left"), (0, 30, "center")]
SKIP_NITS_END = [(16, 0, "left"), (16, 22, "left"), (0, 30, "center"), (-16, 0, "right")]


def _skip_nits_data(V):
    return (V.d.get("ideas") or {}).get(SKIP_NITS_KEY)


def _skip_nits_steps(B, d):
    """[{label, posted, rows, serious_credit, serious, high, all}] for QuickReview's three readings:
    comments per PR (posted, and judged rows) and shares of the key's defects found. None when the
    tag split is unknown."""
    r = ((d or {}).get("reviewers") or {}).get(QR) or {}
    tg = r.get("tags") or {}
    if not r.get("prs_judged") or any(tg.get(k) is None for k in ("posted", "rows", "credit")):
        return None
    n = r["prs_judged"]
    out = []
    for label, tags in SKIP_NITS_STEPS:
        got = {s: sum(tg["credit"][s][t] for t in tags) for s in ("high", "medium", "low")}
        out.append({"label": label, "posted": sum(tg["posted"][t] for t in tags) / n,
                    "rows": sum(tg["rows"][t] for t in tags) / n, "serious_credit": got["high"] + got["medium"],
                    "serious": (got["high"] + got["medium"]) / B.total(SERIOUS),
                    "high": got["high"] / B.total(HIGH), "all": sum(got.values()) / B.total()})
    return out


def _skip_nits_x(B, d, t):
    """Comments per PR a reader of t's whole review reads: its posted comments (the data part drops
    the rows the harness showed the judge twice), or, with no data part at all, data/aacr.json's
    judged rows for every reviewer. None when unknown."""
    if d is None:
        r = B.aacr["reviewers"].get(t) or {}
        return r["comments"] / r["prs_judged"] if r.get("prs_judged") else None
    r = (d.get("reviewers") or {}).get(t) or {}
    return r["posted"] / r["prs_judged"] if r.get("posted") is not None and r.get("prs_judged") else None


def _skip_nits_consistent(B, d):
    """The data part's whole-review credit for QuickReview equals data/aacr.json's (same judgements)."""
    c = (((d or {}).get("reviewers") or {}).get(QR) or {}).get("credit")
    return bool(c) and all(abs(c[s] - B.found(QR, {s})) < 1e-9 for s in ("high", "medium", "low"))


def _skip_nits_claim(B, d):
    """The title's claim, on what is plotted: there are nits to skip, and skipping them loses none of
    the serious credit QuickReview's comments carry (no serious credit arrives through a nit alone)."""
    s = _skip_nits_steps(B, d)
    return (s is not None and _skip_nits_consistent(B, d) and s[2]["posted"] > s[1]["posted"]
            and abs(s[2]["serious_credit"] - s[1]["serious_credit"]) < 1e-9)


def _skip_nits_ring(x, y, line):
    """A grey dot at (x, y) that would touch or hide under one of QuickReview's points gets an outline
    instead: centred on its true position, round that point, clearing its fill by SKIP_NITS_GAP.
    Returns the outline's radius, or None when the dot stands clear."""
    d = min((math.hypot(x - a, y - b) for a, b in line), default=math.inf)
    if d >= SKIP_NITS_R_QR + SKIP_NITS_HALO + SKIP_NITS_GAP + SKIP_NITS_R_OTHER:
        return None
    return d + SKIP_NITS_R_QR + SKIP_NITS_GAP + SKIP_NITS_RING_W / 2


def _skip_nits_rect(p, texts, pad=(3, 2)):
    r = p.fig.canvas.get_renderer()
    inv = p.c.transData.inverted()
    xs, ys = [], []
    for t in texts:
        (a, b), (c, e) = inv.transform(t.get_window_extent(renderer=r).get_points())
        xs += [a, c]
        ys += [b, e]
    return (min(xs) - pad[0], min(ys) - pad[1], max(xs) + pad[0], max(ys) + pad[1])


def _skip_nits_set(p, parts, x, y, ha):
    """Draw parts [(text, size, weight, colour)] side by side on one baseline, anchored at (x, y) by
    ha; return (texts, rect)."""
    texts = [p.text(0, 0, s, size=z, weight=w, color=c) for s, z, w, c in parts]
    widths = [(lambda q: q[2] - q[0])(_skip_nits_rect(p, [t], pad=(0, 0))) for t in texts]
    w = sum(widths) + 7 * (len(texts) - 1)
    left = x if ha == "left" else (x - w if ha == "right" else x - w / 2)
    for t, tw in zip(texts, widths):
        t.set_position((left, y))
        left += tw + 7
    return texts, _skip_nits_rect(p, texts)


def _skip_nits_overlap(rect, taken):
    return sum(max(0, min(rect[2], q[2]) - max(rect[0], q[0])) * max(0, min(rect[3], q[3]) - max(rect[1], q[1]))
               for q in taken)


def _skip_nits_cross(a, b, c, d):
    """Whether segment ab properly crosses segment cd."""
    def side(p, q, r):
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    return side(a, b, c) * side(a, b, d) < 0 and side(c, d, a) * side(c, d, b) < 0


def _skip_nits_across(x, y, rect, line):
    """Whether a label at rect would sit across QuickReview's line from its mark at (x, y). A crossing
    within 14 px of one of QuickReview's points does not count: it passes the point, not the line."""
    to = ((rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2)
    rx, ry = to[0] - x, to[1] - y
    for c, d in zip(line, line[1:]):
        if _skip_nits_cross((x, y), to, c, d):
            sx, sy = d[0] - c[0], d[1] - c[1]
            t = ((c[0] - x) * sy - (c[1] - y) * sx) / (rx * sy - ry * sx)  # where it crosses, along mark -> label
            if all(math.hypot(x + rx * t - qx, y + ry * t - qy) > 14 for qx, qy in line):
                return True
    return False


def _skip_nits_place(p, T, x, y, parts, taken, offsets, line=(), edge=SKIP_NITS_R_OTHER, start=0.0):
    """A direct label for the mark of outer radius edge at (x, y), in the spirit of
    make_charts_v3.place_labels (whose fixed offsets find no free spot in this chart's cluster, and
    whose fallback then draws text on text): the first offset whose box overlaps nothing taken, stays
    inside the layout and does not sit across QuickReview's line from its mark, else the offset
    overlapping least. The gridlines are knocked out behind the label, and a hairline leader, from
    start px off the centre (0: under a filled dot), joins a label that sits away from its mark."""
    best = None
    for k, (dx, dy, ha) in enumerate(offsets):
        texts, rect = _skip_nits_set(p, parts, x + dx, y + dy, ha)
        for t in texts:
            t.remove()
        inside = rect[0] > 64 and rect[2] < 1136 and rect[1] > 100 and rect[3] < p.h - 50
        cost = (_skip_nits_overlap(rect, taken) + (0 if inside else 1e6)
                + (1e5 if _skip_nits_across(x, y, rect, line) else 0))
        if best is None or cost < best[0]:
            best = (cost, k)
        if cost == 0:
            break
    dx, dy, ha = offsets[best[1]]
    _, rect = _skip_nits_set(p, parts, x + dx, y + dy, ha)
    taken.append(rect)
    top = max(rect[1], SKIP_NITS_BOX[1] + 1)  # the 100% line stays whole: a font box reaches above its ink
    if rect[3] > top:
        p.c.add_patch(Polygon([(rect[0], top), (rect[2], top), (rect[2], rect[3]), (rect[0], rect[3])],
                              closed=True, facecolor=T["surface"], edgecolor="none", zorder=1.5))
    nx, ny = min(max(x, rect[0]), rect[2]), min(max(y, rect[1]), rect[3])
    gap = math.hypot(nx - x, ny - y)
    if gap > edge + 14:
        ux, uy = (nx - x) / gap, (ny - y) / gap
        p.c.plot([x + ux * start, nx - ux * 3], [y + uy * start, ny - uy * 3], color=T["muted"], lw=0.8, zorder=2)
    return rect


def _skip_nits_line_boxes(xy, half):
    """Small boxes along a polyline, so no label lands on it."""
    out = []
    for (x0, y0), (x1, y1) in zip(xy, xy[1:]):
        k = max(1, int(math.hypot(x1 - x0, y1 - y0) / 4))
        for i in range(k + 1):
            x, y = x0 + (x1 - x0) * i / k, y0 + (y1 - y0) * i / k
            out.append((x - half, y - half, x + half, y + half))
    return out


def fig_idea_skip_nits(B, V, T):
    d = _skip_nits_data(V)
    steps = _skip_nits_steps(B, d)
    others = [(t, _skip_nits_x(B, d, t), B.recall(t, SERIOUS)) for t in rivals(B)]
    others = [o for o in others if o[1] is not None]  # an unknown volume is not drawn, never put at 0
    qr = [(s["posted"], s["serious"]) for s in steps] if steps else []
    if not qr and _skip_nits_x(B, d, QR) is not None:  # no tag split: the whole review, one dot
        qr = [(_skip_nits_x(B, d, QR), B.recall(QR, SERIOUS))]
    p = Page(T)
    p.title("Skip the nits, keep every serious find" if _skip_nits_claim(B, d)
            else "Serious finds against comments read")
    xs = [x for _, x, _ in others] + [x for x, _ in qr]
    ys = [y for _, _, y in others] + [y for _, y in qr]
    xmax = math.ceil((max(xs, default=7) + 0.45) * 2) / 2
    ylo = min(0.5, math.floor(min(ys, default=0.5) * 10) / 10)
    X, Y = axes_box(p, T, SKIP_NITS_BOX, (0, xmax), (ylo, 1.0), list(range(int(xmax) + 1)),
                    [ylo + 0.1 * k for k in range(round((1 - ylo) * 10) + 1)], lambda v: f"{v:g}", pct,
                    xlabel="comments per PR a reader reads", ylabel="serious (high + medium) defects found")
    line = [(X(x), Y(y)) for x, y in qr]
    pts = [(X(x), Y(y)) for _, x, y in others]
    rings = [_skip_nits_ring(x, y, line) for x, y in pts]
    taken = []
    for (x, y), ring in zip(pts, rings):
        if ring is None:
            dot(p, x, y, SKIP_NITS_R_OTHER, T["other"], T)
            h = SKIP_NITS_R_OTHER + SKIP_NITS_HALO + SKIP_NITS_GAP
        else:  # it would hide under QuickReview's point: an outline round both, between that point's
            p.c.add_patch(Circle((x, y), ring, facecolor="none", edgecolor=T["other"],  # surface ring and fill
                                 lw=SKIP_NITS_RING_W / SKIP_NITS_PX, zorder=4.25))
            h = ring + SKIP_NITS_RING_W / 2 + SKIP_NITS_GAP
        taken.append((x - h, y - h, x + h, y + h))
    for x, y in line:  # QuickReview on top: its points (surface ring included) over the others' marks,
        n = len(p.c.patches)  # and its line over all of them, so it runs unbroken from point to point
        dot(p, x, y, SKIP_NITS_R_QR, T["qr"], T)
        for k, patch in enumerate(p.c.patches[n:]):
            patch.set_zorder(4.2 + 0.1 * k)
        h = SKIP_NITS_R_QR + SKIP_NITS_HALO + SKIP_NITS_GAP
        taken.append((x - h, y - h, x + h, y + h))
    if len(line) > 1:
        p.c.plot([a for a, _ in line], [b for _, b in line], color=T["qr"], lw=SKIP_NITS_LW,
                 solid_capstyle="round", solid_joinstyle="round", zorder=4.5)
        taken += _skip_nits_line_boxes(line, SKIP_NITS_LW * SKIP_NITS_PX / 2 + SKIP_NITS_GAP)
    if line:
        _skip_nits_place(p, T, *line[-1], [("QuickReview", 14, "bold", T["ink"])], taken, SKIP_NITS_END,
                         edge=SKIP_NITS_R_QR)
    for (x, y), s in zip(line if steps else [], steps or []):
        _skip_nits_place(p, T, x, y, [(s["label"], 13, "normal", T["ink"]), (pct(s["serious"]), 16, "bold", T["ink"])],
                         taken, SKIP_NITS_BELOW if s is steps[0] else SKIP_NITS_ABOVE, edge=SKIP_NITS_R_QR)
    # The others' names, the most crowded mark first.
    near = lambda q: min([math.hypot(q[0] - a, q[1] - b) for a, b in pts + line if (a, b) != q] or [0])  # noqa: E731
    for (t, _, _), (x, y), ring in sorted(zip(others, pts, rings), key=lambda o: (near(o[1]), o[0][0])):
        edge = SKIP_NITS_R_OTHER if ring is None else ring + SKIP_NITS_RING_W / 2
        _skip_nits_place(p, T, x, y, [(B.name(t), 12, "normal", T["ink2"])], taken, SKIP_NITS_AROUND, line,
                         edge=edge, start=0 if ring is None else edge)
    p.source(f"AACR-Bench · {B.aacr['cases']} PRs · {B.total(SERIOUS)} verified high and medium defects · "
             + ("QuickReview's points: one review read by tag; the others' reviews are whole" if steps
                else "every point is a whole review"))
    return p


def _skip_nits_by_tag(c, sevs=("high", "medium")):
    """Credit by the strongest tag the judge credited, summed over severities, under the data part's
    own keys (blocker, question, nit, other, body)."""
    return {k: sum(c[s][k] for s in sevs) for k in c[sevs[0]]}


def numbers_idea_skip_nits(B, V):
    """The table behind the image, for out/v3/NUMBERS.md."""
    d = _skip_nits_data(V)
    steps = _skip_nits_steps(B, d)
    n_ser, n_high, n_all = B.total(SERIOUS), B.total(HIGH), B.total()
    out = ["### idea-skip-nits", "",
           f"QuickReview's one review read three ways (its [blocker] comments, then + [question]s, then + [nit]s: "
           f"everything it posted) against the {len(rivals(B))} other reviewers' whole reviews: comments per PR a reader "
           f"reads (x) and share of the {n_ser} high + medium defects found (y). The title's claim "
           + ("holds: no serious credit arrives through a nit alone." if _skip_nits_claim(B, d)
              else "does not hold on this data (or the tag split is unknown), so the title is neutral."), ""]
    if d is not None and not _skip_nits_consistent(B, d):
        out += ["The data part and data/aacr.json disagree on QuickReview's credit: rebuild both.", ""]
    if steps is None:
        basis = "judged rows (data/aacr.json)" if d is None else "posted comments"
        out += [f"QuickReview's tag split is unknown; every point is a whole review, x = {basis}.", "",
                "| reviewer | comments per PR | high + medium found |", "|---|---|---|"]
        for t in [QR] + rivals(B):
            x = _skip_nits_x(B, d, t)
            out.append(f"| {B.name(t)} | {'unknown' if x is None else f'{x:.2f}'} | {B.recall(t, SERIOUS) * 100:.1f}% |")
        return "\n".join(out) + "\n"
    rv = d["reviewers"]
    out += ["| reading | comments read per PR (x) | judged rows per PR | high + medium found (y) | credit, of "
            f"{n_ser} | high found, of {n_high} | all defects found, of {n_all} |", "|---|---|---|---|---|---|---|"]
    for s in steps:
        out.append(f"| QuickReview: {s['label']} | {s['posted']:.2f} | {s['rows']:.2f} | {s['serious'] * 100:.1f}% | "
                   f"{fmt(s['serious_credit'])} | {s['high'] * 100:.1f}% | {s['all'] * 100:.1f}% |")
    for t in sorted(rivals(B), key=lambda t: (-B.recall(t, SERIOUS), t)):
        r = rv.get(t) or {}
        x = _skip_nits_x(B, d, t)
        rows = f"{r['rows'] / r['prs_judged']:.2f}" if r.get("prs_judged") else "unknown"
        out.append(f"| {B.name(t)}: whole review | {'unknown' if x is None else f'{x:.2f}'} | {rows} | "
                   f"{B.recall(t, SERIOUS) * 100:.1f}% | {fmt(B.found(t, SERIOUS))} | {B.recall(t, HIGH) * 100:.1f}% | "
                   f"{B.recall(t) * 100:.1f}% |")
    # What the title rests on: where QuickReview's serious credit comes from, by tag.
    q = rv[QR]
    tg = q["tags"]
    table = [(f"{V.name(QR)}, all {q['prs_judged']} PRs", _skip_nits_by_tag(tg["credit"]), n_ser),
             (f"{V.name(QR)}, {d['heldout_prs']} held-out PRs ({' + '.join(d['heldout_sets'])})",
              _skip_nits_by_tag(tg["credit_heldout"]),
              sum(d["heldout_defects"].get(s, 0) for s in ("high", "medium")))]
    for t in sorted(rv):
        c = (rv[t].get("tags") or {}).get("credit")
        if t != QR and c:
            table.append((f"{V.name(t)}, all {rv[t]['prs_judged']} PRs", _skip_nits_by_tag(c), n_ser))
    extra = any(row.get(k) for _, row, _ in table for k in ("other", "body"))
    out += ["", "| serious credit, by the strongest tag the judge credited | blocker | question | nit "
            + ("| other or body only " if extra else "") + "| total |", "|---|---|---|---|" + ("---|" if extra else "") + "---|"]
    for name, row, of in table:
        out.append(f"| {name} | {fmt(row['blocker'])} | {fmt(row['question'])} | {fmt(row['nit'])} | "
                   + (f"{fmt(row.get('other', 0) + row.get('body', 0))} | " if extra else "")
                   + f"{fmt(sum(row.values()))} of {of} |")
    # Caveats, one or two sentences each; the tables carry the rest.
    rep = tg["repeats"]
    others_rep = sum((rv.get(t) or {}).get("repeats") or 0 for t in rivals(B))
    inline = sum(tg["inline"].values()) if tg.get("inline") else None
    also = tg["nit_also"]["high"] + tg["nit_also"]["medium"]
    words = {t: rv[t]["words"] / rv[t]["prs_judged"] for t in rivals(B) if (rv.get(t) or {}).get("words") is not None}
    w_bq = (tg["words"]["blocker"] + tg["words"]["question"]) / q["prs_judged"]
    hi = max(words, key=lambda t: (words[t], t), default=None)
    lo = min(words, key=lambda t: (words[t], t), default=None)
    b0 = steps[0]
    xs = {t: _skip_nits_x(B, d, t) for t in rivals(B)}
    peers = sorted((t for t in xs if xs[t] is not None and xs[t] <= b0["posted"] + SKIP_NITS_EQUAL
                    and B.recall(t, SERIOUS) >= b0["serious"]), key=lambda t: (-xs[t], t))
    if peers:
        equal = (f"At equal volume it is not ahead: blockers alone find {b0['serious'] * 100:.1f}% at "
                 f"{b0['posted']:.2f} per PR, " + " and ".join(
                     f"{B.name(t)} {B.recall(t, SERIOUS) * 100:.1f}% at {xs[t]:.2f}" for t in peers) + ".")
    else:
        equal = (f"At equal volume it still leads: blockers alone find {b0['serious'] * 100:.1f}% at "
                 f"{b0['posted']:.2f} per PR, more than any reviewer posting as few.")
    if words:
        load = (f"more than any other reviewer's whole review ({words[hi]:.0f} for {B.name(hi)} down to {words[lo]:.0f} "
                f"for {B.name(lo)}; review bodies not counted)" if w_bq > words[hi] else
                f"against {words[hi]:.0f} ({B.name(hi)}) down to {words[lo]:.0f} ({B.name(lo)}) for the others' whole "
                "reviews (review bodies not counted)")
    else:
        load = "beside the others' whole reviews, whose length is unknown"
    nit_only = [row["nit"] for _, row, _ in table[2:]]
    if table[0][1]["nit"]:
        one = table[0][1]["nit"] == 1
        zero = (f"{fmt(table[0][1]['nit'])} serious credit{'' if one else 's'} ({fmt(table[1][1]['nit'])} on the "
                f"held-out PRs) arrive{'s' if one else ''} through a nit alone.")
    else:
        zero = ("No serious credit arrives through a nit alone on the held-out PRs either"
                + (f"; on the other builds {' and '.join(fmt(v) for v in nit_only)} do (table above)." if any(nit_only)
                   else (", nor on the other builds." if nit_only else ".")))
    out += ["",
            f"- x counts each distinct comment once: QuickReview's {q['posted']:,}"
            + (f" ({inline:,} inline, {q['posted'] - inline:,} in the review body)" if inline is not None else "")
            + f". The judge saw {q['repeats']} deleted-line comments twice ({rep['blocker']} blockers, "
            f"{rep['question']} questions, {rep['nit']} nits), so its {q['rows']:,} rows would put x at "
            + " / ".join(f"{s['rows']:.2f}" for s in steps)
            + ("; the others have no such repeats" if not others_rep else f"; the others have {others_rep}")
            + ", and recall is the same either way.",
            f"- A defect counts toward a reading when any comment credited for it carries one of the reading's tags "
            f"({also} serious defects also credit a nit). Nits still carry {fmt(tg['credit']['low']['nit'])} low-severity "
            f"credits: skipping them drops all-defect recall from {steps[2]['all'] * 100:.1f}% to "
            f"{steps[1]['all'] * 100:.1f}%.",
            f"- Skipping nits is the reader's choice, not a setting, and blockers + questions still run {w_bq:.0f} words "
            f"per PR, {load}. " + equal,
            f"- One benchmark, judge ({d['judge']}) and run per PR, on QuickReview's "
            f"{B.tools[QR].get('note', 'build')}, whose rebuilt reviews match the judge's hashes on {tg['hash_match']} "
            f"of {q['prs_judged']} PRs. " + zero]
    return "\n".join(out) + "\n"


# ---------------------------------------------------------------- idea-funnel: from the lenses' findings to posted
#   comments to judged correct, per PR.
FUNNEL_TINT = 0.32  # the two internal stages: QuickReview's blue at this strength over the page
FUNNEL_FEW = 0.15  # "a few vetoed" only while vetoes and holds remove at most this share of the distinct issues


def _funnel_stats(V):
    """Totals and per-PR means over the PRs the data part could read (a record and a judgement both)."""
    d = V.d["ideas"].get("idea-funnel")
    if not d or not d.get("prs"):
        return None
    rows = d["prs"]
    n = len(rows)
    t = d["totals"]
    lenses = [r["lenses"] for r in rows.values() if r["lenses"] is not None]
    raising = [r.get("lenses_raising") for r in rows.values() if r.get("lenses_raising") is not None]
    runs = [r["lens_runs"] for r in rows.values() if r["lens_runs"] is not None]
    held = [r for r in rows.values() if r["set"] in ("holdout10", "fresh10")]
    gap = [r["judged"] - r["posted"] for r in rows.values()]
    drop = t["raised"] - t["posted"]
    correct = t["correct-valuable"] + t["correct-minor"]
    return {
        "d": d, "n": n, "t": t, "drop": drop,
        "raised": t["raised"] / n, "distinct": t["distinct"] / n, "posted": t["posted"] / n, "correct": correct / n,
        "useful": t["correct-valuable"] / n, "minor": t["correct-minor"] / n,
        "precision": correct / t["judged"] if t["judged"] else None,
        "merged": t["merged"] + t["folded"],
        "merged_share_of_drop": (t["merged"] + t["folded"]) / drop if drop > 0 else None,
        "removed_share_of_distinct": (t["distinct"] - t["posted"]) / t["distinct"] if t["distinct"] else None,
        "vetoed": t["killed"] + t["doubted"], "held": t["withheld"] + t["held_downgraded"] + t["other"],
        "lenses": statistics.mean(lenses) if lenses else None,
        "lenses_median": statistics.median(lenses) if lenses else None,
        "raising": statistics.mean(raising) if raising else None,
        "raising_median": statistics.median(raising) if raising else None,
        "lens_runs": statistics.mean(runs) if runs else None,
        "median": {k: statistics.median(r[k] for r in rows.values()) for k in ("raised", "distinct", "posted")},
        "held_out": None if not held else {
            "n": len(held), **{k: sum(r[k] for r in held) / len(held) for k in ("raised", "distinct", "posted")}},
        "gap_match": sum(1 for g in gap if g == 0), "gap_other": sum(1 for g in gap if g != 0),
        "gap_max": max((abs(g) for g in gap), default=0),
    }


def _funnel_stages(s):
    """[(per PR, stage name, second line or None, internal stage?)], top to bottom; every claim checked.
    The lens count is the lenses that RUN: fewer of them raise a finding (NUMBERS.md has both)."""
    ran = f"~{round(s['lenses'])} run per PR" if s["lenses"] is not None else None
    dup = "same issue from several lenses" if s["merged"] else None
    gone = s["removed_share_of_distinct"]
    veto = (None if gone is None or gone <= 0 else
            "a few vetoed or held back" if gone <= FUNNEL_FEW else f"{pct(gone)} vetoed or held back")
    minor = "incl. minor points" if s["t"]["correct-minor"] else None
    return [(s["raised"], "raised by the lenses", ran, True),
            (s["distinct"], "after merging duplicates", dup, True),
            (s["posted"], "posted as comments", veto, False),
            (s["correct"], "judged correct", minor, False)]


def _funnel_tint(T, a):
    """QuickReview's blue laid over the page at strength a, as one opaque colour (a tint, no new hue)."""
    rgb = lambda c: [int(c[i:i + 2], 16) for i in (1, 3, 5)]  # noqa: E731
    return "#" + "".join(f"{round(a * q + (1 - a) * b):02x}" for q, b in zip(rgb(T["qr"]), rgb(T["surface"])))


def _funnel_width(p, t, **kw):
    """Width in page pixels of a drawn text, or of a string set with p.text's keywords (measured, removed)."""
    tmp = isinstance(t, str)
    if tmp:
        t = p.text(0, 0, t, **kw)
    r = p.fig.canvas.get_renderer()
    (a, _), (b, _) = p.c.transData.inverted().transform(t.get_window_extent(renderer=r).get_points())
    if tmp:
        t.remove()
    return abs(b - a)


def fig_idea_funnel(B, V, T):
    p = Page(T)
    s = _funnel_stats(V)
    if s is None:
        p.title("Lens findings to comments")
        p.text(64, 200, "no data", size=14, color=T["muted"])
        return p
    merge_led = s["merged_share_of_drop"] is not None and s["merged_share_of_drop"] >= 0.5
    # "merge into M comments" also needs little removed after the merge, or 21 -> 10 -> 5 would hide the vetoes
    gone = s["removed_share_of_distinct"]
    little_after = (gone is not None and gone <= FUNNEL_FEW) or round(s["distinct"]) == round(s["posted"])
    if merge_led and little_after and round(s["raised"]) > round(s["posted"]):
        p.title(f"{round(s['raised'])} lens findings merge into {round(s['posted'])} comments")
    else:
        p.title(f"{round(s['raised'])} lens findings, {round(s['posted'])} comments")
    stages = _funnel_stages(s)
    # Geometry from the measured top row: its name, bar and value span the width between the margins.
    left, right, gap_l, gap_r, unit_gap = 64, 1136, 18, 16, 8
    top, bottom, thick, radius = 154, 570, 72, 4
    lab = dict(size=15, ha="right")
    sub_kw = dict(size=12, ha="right", color=T["muted"])
    val_kw = dict(size=22, weight="bold")
    unit_kw = dict(size=13, color=T["muted"])
    lw0 = max(_funnel_width(p, stages[0][1], **lab), _funnel_width(p, stages[0][2], **sub_kw) if stages[0][2] else 0)
    vw0 = _funnel_width(p, f"{stages[0][0]:.1f}", **val_kw) + unit_gap + _funnel_width(p, "per PR", **unit_kw)
    max_half = min(380, (right - left - gap_l - gap_r - lw0 - vw0) / 2)
    cx = left + (right - left - (lw0 + gap_l + 2 * max_half + gap_r + vw0)) / 2 + lw0 + gap_l + max_half
    scale = max_half / max(max(v for v, *_ in stages), 1e-9)
    pitch = (bottom - top) / len(stages)
    halves = [v * scale for v, *_ in stages]
    ys = [top + pitch * (i + 0.5) for i in range(len(stages))]
    tint = _funnel_tint(T, FUNNEL_TINT)
    for i in range(len(stages) - 1):  # the funnel's walls: a background trapezoid from each stage to the next
        a, b = halves[i] - radius + 1, halves[i + 1] - radius + 1
        y0, y1 = ys[i] + thick / 2 + 2, ys[i + 1] - thick / 2 - 2
        if a > 0 and b > 0:
            p.c.add_patch(Polygon([(cx - a, y0), (cx + a, y0), (cx + b, y1), (cx - b, y1)], closed=True,
                                  facecolor=T["empty"], edgecolor="none", zorder=1))
    for i, (v, label, sub, internal) in enumerate(stages):
        y, half = ys[i], halves[i]
        if half > 0:  # one centred bar, both ends tips: the mark spec's 4 px rounding at each
            p.c.add_patch(FancyBboxPatch((cx - half, y - thick / 2), 2 * half, thick,
                                         boxstyle=f"round,pad=0,rounding_size={min(radius, half)}",
                                         facecolor=tint if internal else T["qr"], edgecolor="none", zorder=3))
        # the after-stages share one name column and one value column; the first row hugs its own bar
        anchor = half if i == 0 else max(halves[1:])
        lx, vx = cx - anchor - gap_l, cx + anchor + gap_r
        if sub:
            p.text(lx, y - 11, label, **lab)
            p.text(lx, y + 16, sub, **sub_kw)
        else:
            p.text(lx, y + 1, label, **lab)
        val = p.text(vx, y + 1, f"{v:.1f}", **val_kw)
        if i == 0:
            p.text(vx + _funnel_width(p, val) + unit_gap, y + 1, "per PR", **unit_kw)
    share = s["merged_share_of_drop"]
    why = ("" if share is None else " · most of the drop is the same issue raised by several lenses" if merge_led
           else f" · {pct(share)} of the drop is the same issue raised by several lenses")
    p.source(f"AACR-Bench · {s['n']} real pull requests · frozen build · average per PR{why}")
    return p


def numbers_idea_funnel(B, V):
    """The table behind the image, for out/v3/NUMBERS.md."""
    s = _funnel_stats(V)
    if s is None:
        return "### idea-funnel\n\nNo data: the data part found no PR with both a findings record and a judgement.\n"
    t, n, drop = s["t"], s["n"], s["drop"]
    f = lambda x: f"{x:,}"  # noqa: E731
    pc = lambda x: "?" if x is None else f"{x:.1%}"  # noqa: E731
    names = [name for _, name, _, _ in _funnel_stages(s)]
    lens_note = "; ".join(
        ([f"{s['lenses']:.1f} lenses run per PR (median {s['lenses_median']:g})"] if s["lenses"] is not None else [])
        + ([f"{s['raising']:.1f} lenses raise at least one finding (median {s['raising_median']:g})"]
           if s["raising"] is not None else [])
        + ([f"{s['lens_runs']:.1f} lens runs (the sweep runs once per group of files)"]
           if s["lens_runs"] is not None else [])) or "lens counts unknown"
    other = f", {t['other']} other" if t["other"] else ""
    out = ["### idea-funnel", "",
           f"QuickReview's review of one PR, averaged over {n} AACR PRs: the findings its lenses raised, what was "
           f"left after merging the same issue raised by several lenses, what it posted, and what the judge graded "
           f"correct (the title rounds {s['raised']:.1f} and {s['posted']:.1f}).", "",
           "| stage (bar) | per PR | total | what it rests on |", "|---|---:|---:|---|",
           f"| {names[0]} | {s['raised']:.1f} | {f(t['raised'])} | one entry per lens candidate in the findings "
           f"record ({t['copies']} pre-downgrade copies of posted entries left out); {lens_note} |",
           f"| {names[1]} | {s['distinct']:.1f} | {f(t['distinct'])} | {f(s['merged'])} candidates "
           f"({pc(s['merged'] / t['raised'] if t['raised'] else None)} of raised) merged into another lens's "
           f"finding of the same issue |",
           f"| {names[2]} | {s['posted']:.1f} | {f(t['posted'])} | {t['posted_blocker']} blocker + "
           f"{t['posted_question']} question + {t['posted_nit']} nit; not posted: {s['vetoed']} vetoed "
           f"({t['killed']} killed, {t['doubted']} doubted) + {s['held']} held back ({t['withheld']} withheld, "
           f"{t['held_downgraded']} downgraded and not posted{other}) |",
           f"| {names[3]} | {s['correct']:.1f} | {f(t['correct-valuable'] + t['correct-minor'])} of "
           f"{f(t['judged'])} graded | {t['correct-valuable']} correct-valuable ({s['useful']:.1f}/PR) + "
           f"{t['correct-minor']} correct-minor ({s['minor']:.1f}/PR) = {pc(s['precision'])}; "
           f"{t['partly-correct']} partly correct, {t['incorrect']} incorrect, {t['unverifiable']} unverifiable |",
           ""]
    others = rivals(B)
    mine = V.grades(QR)
    vol = [V.grades(o)["per_pr"] for o in others]
    rank = 1 + sum(1 for v in vol if v > mine["per_pr"])
    most = "the most" if rank == 1 else f"number {rank}"
    best = max(round(V.grades(o)["correct"], 3) for o in others)
    at_best = [B.name(o) for o in others if round(V.grades(o)["correct"], 3) == best]
    mp = round(mine["correct"], 3)
    level = "level with" if abs(mp - best) <= 0.005 else ("above" if mp > best else "below")
    m, h = s["median"], s["held_out"]
    gaps = ("every PR matches" if not s["gap_other"] else
            f"{s['gap_match']} PRs match, {s['gap_other']} differ by 1 to {s['gap_max']}")
    caveats = [
        f"Most of the drop is duplicates, not rejection: {f(s['merged'])} of the {f(drop)} candidates that never "
        f"became a comment of their own ({pc(s['merged'] / drop if drop else None)}) were the same issue as another "
        f"lens's finding. The validator vetoed {s['vetoed']} ({pc(s['vetoed'] / t['raised'] if t['raised'] else None)} "
        f"of raised) and {s['held']} were held back. The stages are an accounting, not a timeline: the validator "
        f"decides merges and vetoes in one pass.",
        f"Averages: large PRs pull them up. Medians are {m['raised']:g} raised, {m['distinct']:g} distinct, "
        f"{m['posted']:g} posted per PR"
        + (f"; the held-out sets (holdout10 + fresh10, {h['n']} PRs) give {h['raised']:.2f}, {h['distinct']:.2f}, "
           f"{h['posted']:.2f}" if h else "")
        + f". Counting the {t['copies']} pre-downgrade copies makes bar 1 {(t['raised'] + t['copies']) / n:.1f}; "
        f"leaving out {t['synth']} more likely synthesized copies makes it {(t['raised'] - t['synth']) / n:.1f}.",
        f"'Judged correct' is one LLM judge's ({s['d']['judge_model']}) correct-valuable plus correct-minor, over "
        f"the {f(t['judged'])} comments it graded, {t['judged'] - t['posted']:+d} against the record's "
        f"{f(t['posted'])} posted ({gaps}).",
        f"Volume: {mine['per_pr']:.1f} judged comments per PR is {most} of the {len(others) + 1} AACR reviewers "
        f"(the others {min(vol):.1f} to {max(vol):.1f}), and {mine['correct']:.1%} correct is {level} the best of "
        f"them ({' and '.join(at_best)}, {best:.1%}). The chart shows QuickReview filtering its own output; never "
        f"pair it with a 'less noise' or 'more precise' claim.",
    ]
    return "\n".join(out + [f"- {c}" for c in caveats]) + "\n"


# ---------------------------------------------------------------- idea-price-per-bug: model spend per extra serious
#   defect, against each of the six.
PRICE_PER_BUG_HELD_OUT = ("holdout10", "fresh10")  # the sets never used to tune or validate the frozen build
PRICE_PER_BUG_SEED, PRICE_PER_BUG_RESAMPLES = 20261001, 10000  # the paper's bootstrap


def _price_per_bug_word(rows):
    """The title's word for what it counts, the net extra serious finds: 'bug' only while functional bugs (the key's
    kind 'bug') are at least half of them against every reviewer QuickReview out-finds; otherwise the key's own word,
    'defect'. The test runs on the extra finds, not on the whole serious set, because the title counts the extras."""
    ahead = [r for r in rows if r["n"] is not None and r["n"] > 0]
    return "bug" if ahead and all(2 * r["bug"] >= r["n"] for r in ahead) else "defect"


def _price_per_bug_money(v):
    """A price as the image prints it: whole dollars, or cents under $1 so that a small price never reads '$0'."""
    return f"${v:.2f}" if v < 1 else f"${v:.0f}"


def _price_per_bug_per_pr(B, V, t, keep=None):
    """PR -> (list-price $, serious credit, the part of that credit on functional bugs) for one reviewer over every
    AACR PR, PRs in sorted order; None when any PR is unpriced or any serious defect unjudged (unknown, never zero)."""
    arm = V.d["arms"].get(t) or {}
    usd = {i: (arm.get("per_pr") or {}).get(i, {}).get("usd") for i in V.d["prs"]}
    if any(u is None for u in usd.values()):
        return None
    ser, bug = dict.fromkeys(usd, 0.0), dict.fromkeys(usd, 0.0)
    for x in B.D:
        if x["severity"] in SERIOUS and (keep is None or f"{x['pr']}|{x['id']}" in keep):
            if t not in x["credit"]:
                return None
            ser[x["pr"]] += x["credit"][t]
            if x.get("kind") == "bug":
                bug[x["pr"]] += x["credit"][t]
    return {i: (usd[i], ser[i], bug[i]) for i in sorted(usd)}


def _price_per_bug_rows(B, V, keep=None, prs=None):
    """One row per other reviewer, priciest first: QuickReview's extra list-price spend (the sum over the PRs
    of its $ minus theirs, = the difference of the means x the PRs) divided by its extra serious credit, NET
    (QuickReview's found minus theirs, a partial find 0.5), and how much of that net credit is on functional bugs;
    and the extra judged comments per extra serious find. `keep` limits the serious defects, `prs` the PRs. None
    wherever an input is unknown."""
    q = _price_per_bug_per_pr(B, V, QR, keep)
    qc = B.aacr["reviewers"][QR].get("comments")
    rows = []
    for t in rivals(B):
        x = _price_per_bug_per_pr(B, V, t, keep)
        xc = B.aacr["reviewers"][t].get("comments")
        r = {"tool": t, "found": None, "n": None, "bug": None, "usd": None, "usd_per": None, "com": None,
             "com_per": None, "diffs": None}
        if q is not None and x is not None:
            ids = [i for i in q if prs is None or V.d["prs"][i]["set"] in prs]
            r["diffs"] = [(q[i][0] - x[i][0], q[i][1] - x[i][1]) for i in ids]
            r["found"] = sum(x[i][1] for i in ids)
            r["n"] = sum(q[i][1] for i in ids) - r["found"]
            r["bug"] = sum(q[i][2] for i in ids) - sum(x[i][2] for i in ids)
            r["usd"] = sum(d for d, _ in r["diffs"])
            if r["n"] > 0:
                r["usd_per"] = r["usd"] / r["n"]
        if qc is not None and xc is not None:
            r["com"] = qc - xc
            if r["n"] is not None and r["n"] > 0:
                r["com_per"] = r["com"] / r["n"]
        rows.append(r)
    return sorted(rows, key=lambda r: (r["usd_per"] is None, -(r["usd_per"] or 0)))


def _price_per_bug_draws(n):
    """The resampled PR indices, PRICE_PER_BUG_RESAMPLES x n of them: randrange(n) from a fresh
    random.Random(seed), as the verifier drew them for every comparison (so one stream serves all six)."""
    rng = random.Random(PRICE_PER_BUG_SEED)
    return [rng.randrange(n) for _ in range(n * PRICE_PER_BUG_RESAMPLES)]


def _price_per_bug_interval(diffs, idx):
    """95% paired bootstrap over PRs of the ratio of sums (extra $ / extra serious credit), the verifier's
    procedure exactly: `diffs` per PR in sorted order, `idx` from _price_per_bug_draws, sums in draw order,
    2.5/97.5 percentiles of the resamples with an extra serious find. Returns (low, high, resamples with none)."""
    n = len(diffs)
    du, ds = [d for d, _ in diffs], [s for _, s in diffs]
    vals, none = [], 0
    for b in range(PRICE_PER_BUG_RESAMPLES):
        sl = idx[b * n:(b + 1) * n]
        sd = functools.reduce(operator.add, map(du.__getitem__, sl), 0.0)
        sn = functools.reduce(operator.add, map(ds.__getitem__, sl), 0.0)
        if sn > 0:
            vals.append(sd / sn)
        else:
            none += 1
    vals.sort()
    q = lambda p: vals[min(len(vals) - 1, max(0, int(round(p * (len(vals) - 1)))))] if vals else None  # noqa: E731
    return q(0.025), q(0.975), none


def fig_idea_price_per_bug(B, V, T):
    rows = _price_per_bug_rows(B, V)
    p = Page(T)
    word = _price_per_bug_word(rows)
    priced = [r for r in rows if r["usd_per"] is not None and r["usd_per"] > 0]
    if rows and len(priced) == len(rows):
        lo, hi = (_price_per_bug_money(agg(r["usd_per"] for r in rows)) for agg in (min, max))
        p.title(f"{lo} of model spend per extra serious {word}" if lo == hi else
                f"{lo}–{hi[1:]} of model spend per extra serious {word}")
    else:
        p.title(f"Model spend per extra serious {word}")
    x_end, top, bottom, h = 1128, 124, 604, 26
    pitch = (bottom - top) / max(len(rows), 1)
    r_ = p.fig.canvas.get_renderer()
    inv = p.c.transData.inverted()

    def width(t):
        (a, _), (c, _) = inv.transform(t.get_window_extent(renderer=r_).get_points())
        return abs(c - a)

    # Units are spelled out once, on the first row that has them ("QuickReview found 23 more", "... to read");
    # the rows below repeat only the numbers.
    names, tips, named, spelled = [], [], False, False
    for i, r in enumerate(rows):
        y = top + pitch * (i + 0.5)
        n, usd = r["n"], r["usd"]
        who = "" if named or n is None else "QuickReview "
        named = named or n is not None
        sub = ("unknown" if n is None else f"{who}found {fmt(n)} more" if n > 0 else
               f"{who}found as many" if n == 0 else f"{who}found {fmt(-n)} fewer")
        names += [p.text(0, y - 9, f"vs {B.name(r['tool'])}", size=15, ha="right", color=T["ink2"]),
                  p.text(0, y + 13, sub, size=12, ha="right", color=T["muted"])]
        if n is not None and n > 0 and usd is not None and usd > 0:
            # the price per extra find: its model spend PLUS the extra reading, one unit for both
            com = "?" if r["com_per"] is None else f"{r['com_per']:.0f}"
            tips.append((r, y, p.text(0, y, _price_per_bug_money(r["usd_per"]), size=17, weight="bold"),
                         p.text(0, y, f"+ {com} more comments" + ("" if spelled else " to read"), size=14,
                                color=T["ink2"])))
            spelled = True
        else:  # nothing to price: unknown inputs, no extra find, or the extra finds cost nothing extra
            tips.append((r, y, p.text(0, y, "unknown" if n is None or usd is None else
                                      "no extra find to price" if n <= 0 else "no extra spend", size=14,
                                      color=T["muted"]), None))
    x0 = 68 + max(width(t) for t in names) + 18  # bars start where the longest name ends (4 px for hinting)
    for t in names:
        t.set_x(x0 - 18)
    # one scale for every bar: the largest that keeps every tip label inside the page
    s = min(((x_end - x0 - 12 - width(val) - 8 - width(rest)) / r["usd_per"] for r, _, val, rest in tips if rest),
            default=0.0)
    for r, y, val, rest in tips:
        if rest is None:
            val.set_x(x0)
            continue
        tip = x0 + s * r["usd_per"]
        bar(p.c, x0, tip, y, h, T["qr"], zorder=3)
        val.set_x(tip + 12)
        rest.set_x(tip + 12 + width(val) + 8)
    p.source(f"AACR-Bench · {len(V.d['prs'])} PRs · one run each · point estimates · list prices · "
             "serious = high or medium · a partial find counts ½")
    return p


def numbers_idea_price_per_bug(B, V):
    """The table behind the image, for out/v3/NUMBERS.md."""
    rows = _price_per_bug_rows(B, V)
    word = _price_per_bug_word(rows)
    idea = (V.d.get("ideas") or {}).get("idea-price-per-bug") or {}
    prov, lowest = idea.get("provenance") or {}, idea.get("lowest_label") or {}
    indep = set(prov.get("independent") or [])
    ind = _price_per_bug_rows(B, V, keep=indep) if indep else []
    held = _price_per_bug_rows(B, V, prs=PRICE_PER_BUG_HELD_OUT)
    qa, n_prs = B.aacr["reviewers"][QR], len(V.d["prs"])
    ser = [x for x in B.D if x["severity"] in SERIOUS]
    money = lambda v: "?" if v is None else f"${v:,.2f}"  # noqa: E731
    one = lambda v: "?" if v is None else f"{v:.1f}"  # noqa: E731
    num = lambda v: "?" if v is None else fmt(v)  # noqa: E731
    span = lambda vs, f: f"{f(min(vs))}–{f(max(vs))}"  # noqa: E731

    def skipped(t, n):
        """Extra judged comments per extra serious find once each tool's own lowest tag is skipped."""
        a, b = (lowest.get(QR) or {}).get("comments"), (lowest.get(t) or {"comments": 0}).get("comments")
        c, d = qa.get("comments"), B.aacr["reviewers"][t].get("comments")
        return None if None in (a, b, c, d, n) or n <= 0 else (c - a - (d - b)) / n

    idx = _price_per_bug_draws(len(V.d["prs"]))
    ivs = {r["tool"]: _price_per_bug_interval(r["diffs"], idx) if r["diffs"] else (None, None, None) for r in rows}
    ahead = [r for r in rows if r["n"] is not None and r["n"] > 0]
    word_note = ("" if not ahead else
                 " The title says 'bug': functional bugs (the key's kind 'bug') are at least half of the net extra "
                 "serious finds against every reviewer." if word == "bug" else
                 " The title says 'defect', not 'bug': functional bugs (the key's kind 'bug') are under half of the "
                 f"net extra serious finds against {sum(1 for r in ahead if 2 * r['bug'] < r['n'])} of the "
                 f"{len(ahead)} reviewers.")
    out = ["### idea-price-per-bug\n",
           f"Each bar: QuickReview's extra list-price model spend over AACR-Bench's {n_prs} PRs (the sum of the "
           f"per-PR differences, = the difference of the mean $ per PR x {n_prs}) divided by its net extra serious "
           "(high or medium) credit against that reviewer; the label adds the extra judged comments per extra serious "
           "find." + word_note + "\n",
           f"| vs | serious found (of {len(ser)}) | extra serious, net | of which functional bugs | extra $ ({n_prs} "
           f"PRs) | **$ per extra serious {word}** | 95% interval | extra comments | **more comments per extra "
           f"{word}** | same, lowest tag skipped | $ per extra {word}, independently raised defects only |",
           "|---|---|---|---|---|---|---|---|---|---|---|"]
    by_ind = {r["tool"]: r for r in ind}
    for r in rows:
        lo, hi, _ = ivs[r["tool"]]
        out.append(f"| {B.name(r['tool'])} | {num(r['found'])} | {num(r['n'])} | {num(r['bug'])} | "
                   f"{money(r['usd'])} | **{money(r['usd_per'])}** | {money(lo)}–{money(hi)} | {num(r['com'])} | "
                   f"**{one(r['com_per'])}** | {one(skipped(r['tool'], r['n']))} | "
                   f"{money((by_ind.get(r['tool']) or {}).get('usd_per'))} |")
    q = _price_per_bug_per_pr(B, V, QR)
    q_found, q_usd = (None, None) if q is None else (sum(v[1] for v in q.values()), sum(v[0] for v in q.values()))
    out.append(f"| *QuickReview itself* | {num(q_found)} | | | {money(q_usd)} in all, {money(qa.get('usd_mean'))} a "
               f"PR | | | {num(qa.get('comments'))} judged | | {num((lowest.get(QR) or {}).get('comments'))} tagged "
               "[nit] | |")
    out += ["", "- Model spend at list prices, not a bill, and no reading time: GPT-based tools' tokens at "
                "gpt-6.1-sol rates, Claude Code at Opus 5.5's. The pi-review panel's reported cost leaves out its "
                "adjudicator calls, so the extra spend against it is if anything overstated."]
    known = [r for r in rows if r["n"] is not None and ivs[r["tool"]][1] is not None]
    if known:
        wide = max(known, key=lambda r: ivs[r["tool"]][1] - ivs[r["tool"]][0])
        why = (f", whose price rests on the fewest extra finds ({fmt(wide['n'])})"
               if wide is min(known, key=lambda r: r["n"]) else "")
        out.append(f"- Point estimates from one run per reviewer and one judge, with all the extra spend and comments "
                   f"charged to the serious finds. 95% intervals: paired bootstrap over PRs, "
                   f"{PRICE_PER_BUG_RESAMPLES:,} resamples, seed {PRICE_PER_BUG_SEED}; the widest is against the "
                   f"{B.name(wide['tool'])}{why}: {money(ivs[wide['tool']][0])}–{money(ivs[wide['tool']][1])}.")
    key = lambda x: x["pr"] + "|" + x["id"]  # noqa: E731
    co = set(prov.get("comments_only") or [])
    co_ser = [x for x in ser if key(x) in co]
    n_ind = sum(1 for x in ser if key(x) in indep)
    ind_vals = [r["usd_per"] for r in ind if r["usd_per"] is not None]
    if ind_vals:
        lead = len(ind_vals) == len(ind) and all(r["n"] > 0 for r in ind)
        co_qr = fmt(sum(x["credit"][QR] for x in co_ser))
        chg = [by_ind[r["tool"]]["usd_per"] / r["usd_per"] - 1 for r in rows
               if r["usd_per"] is not None and r["usd_per"] > 0 and (by_ind.get(r["tool"]) or {}).get("usd_per")]
        moved = ("" if not chg else f" (each row {100 * min(chg):.0f}–{100 * max(chg):.0f}% higher)" if min(chg) > 0
                 else f" (each row {100 * min(chg):+.0f}% to {100 * max(chg):+.0f}%)")
        out.append(f"- The answer key is a verified pool: {len(co_ser)} of the {len(ser)} serious defects were "
                   f"raised only by benchmarked reviewers' comments (QuickReview finds {co_qr}). Counting only the "
                   f"{n_ind} that the expert hunt or an AACR reference raised, the price is {span(ind_vals, money)}"
                   + moved + (", and QuickReview still finds more serious defects than each of them." if lead else
                              "."))
    parts = []
    if held and all(r["usd_per"] is not None for r in held):
        n_held = sum(1 for i in V.d["prs"].values() if i["set"] in PRICE_PER_BUG_HELD_OUT)
        parts.append(f"On the {n_held} PRs never used to tune or validate the build "
                     f"({' + '.join(PRICE_PER_BUG_HELD_OUT)}) QuickReview finds {span([r['n'] for r in held], fmt)} "
                     f"more serious defects, at {span([r['usd_per'] for r in held], money)} each.")
    sk = [v for v in (skipped(r["tool"], r["n"]) for r in rows) if v is not None]
    tags = [lowest[t] for t in sorted(lowest)]
    if sk and tags and all(v.get("serious_credit_lost") == 0 for v in tags):
        which = ", ".join("%s %s [%s]" % (B.name(t), num(lowest[t].get("comments")), lowest[t].get("tag"))
                          for t in sorted(lowest, key=lambda t: (t != QR, t)))
        cited = sum(v.get("serious_defects_citing") or 0 for v in tags)
        parts.append(f"Skipping each tool's lowest tag ({which}) leaves {span(sk, one)} more comments per extra "
                     f"{word} and loses no serious find: the {cited} serious defects a skipped comment is cited for "
                     "are each credited through another comment too.")
    if parts:
        out.append("- " + " ".join(parts))
    return "\n".join(out) + "\n"


# ---------------------------------------------------------------- idea-uncredited: what QuickReview's uncredited
#   comments were, checked by hand on Qodo and Martian.
UNCREDITED_ORDER = ("real", "listed", "dup", "minor", "wrong")
UNCREDITED_NAMES = {"real": "real defect the key lacks, any severity", "listed": "listed issue the scoring missed",
                    "dup": "same issue at another site", "minor": "true but minor", "wrong": "wrong"}
# A segment too narrow to hold its share is flagged under its bar with the share and this short name.
UNCREDITED_SHORT = {"real": "real defect", "listed": "listed issue", "dup": "same issue", "minor": "minor"}
UNCREDITED_ALPHA = {"listed": 0.6, "dup": 0.36}  # tints of QuickReview's blue; every other segment is opaque
# Top bar first: Qodo's bar has a segment in every class but "wrong", so the class names point into it.
UNCREDITED_BARS = (("qodo", "Qodo benchmark", "inline comments", "r6"),
                   ("martian", "Martian benchmark", "extracted findings", "round-1 default"))


def _uncredited_shares(counts, n):
    """Whole percents that add up to 100 (largest remainder, ties to the larger share)."""
    exact = {k: 100 * counts[k] / n for k in UNCREDITED_ORDER}
    out = {k: math.floor(v) for k, v in exact.items()}
    for k in sorted(UNCREDITED_ORDER, key=lambda k: (out[k] - exact[k], -exact[k]))[:100 - sum(out.values())]:
        out[k] += 1
    return out


def _uncredited_interval(k, n, z=1.959964):
    """The 95% Wilson score interval of k out of n, in whole percents."""
    p, d = k / n, 1 + z * z / n
    c, h = (p + z * z / (2 * n)) / d, z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return f"{max(0.0, c - h) * 100:.0f}–{min(1.0, c + h) * 100:.0f}%"


def _uncredited_title(d):
    rare = all(d[b]["classes"]["wrong"] <= 0.03 * d[b]["uncredited"] for b, *_ in UNCREDITED_BARS)
    often = all(d[b]["classes"]["minor"] >= 0.4 * d[b]["uncredited"] for b, *_ in UNCREDITED_BARS)
    if rare and often:
        return "Uncredited comments: often minor, rarely wrong"
    return "Uncredited comments are rarely wrong" if rare else "What the uncredited comments were"


def _uncredited_prs(d):
    """The PR samples in the bars' order, e.g. '10 Qodo + 20 Martian'."""
    return " + ".join(f"{d[b]['prs']} {name.split()[0]}" for b, name, *_ in UNCREDITED_BARS)


def _uncredited_width(p, s, **kw):
    """A text's rendered width, in the page's 1x pixels."""
    t = p.text(0, 0, s, **kw)
    (a, _), (b, _) = p.c.transData.inverted().transform(t.get_window_extent(p.fig.canvas.get_renderer()).get_points())
    t.remove()
    return abs(b - a)


def _uncredited_flags(p, T, flags, edge, away, size=13, pitch=25, gap=22):
    """Flags off one long edge of a bar (at y `edge`, rows running `away` = -1 up or +1 down): each flag is
    (x, [(text, weight, colour), ...]), its texts in a run right of a hairline tick at x, on the row nearest the
    bar where the run clears every flag placed and no tick crosses text. Placed right to left, so the flags
    step away from the bar towards its start, in its order."""
    row = lambda r: edge + away * (gap + pitch * r)  # noqa: E731
    taken = []  # (row, tick x, text end x)
    for cx, parts in sorted(flags, key=lambda f: -f[0]):
        widths = [_uncredited_width(p, s, size=size, weight=wt) for s, wt, _ in parts]
        end = cx + 6 + sum(widths) + 4 * (len(parts) - 1)

        def clear(q, r, cx=cx, end=end):  # texts apart on a row; no tick, farther or this one, crosses a text
            return not (q[0] == r and q[1] < end + 12 and cx - 12 < q[2]) and \
                not (q[0] > r and cx - 4 <= q[1] <= end + 4) and not (q[0] < r and q[1] - 4 <= cx <= q[2] + 4)

        r = next((r for r in range(len(flags)) if all(clear(q, r) for q in taken)), len(flags))
        p.c.plot([cx, cx], [row(r) - away * 5, edge + away * 3], color=T["muted"], lw=0.8, zorder=2)
        x = cx + 6
        for (s, wt, colour), w in zip(parts, widths):
            p.text(x, row(r), s, size=size, weight=wt, color=colour)
            x += w + 4
        taken.append((r, cx, end))


def fig_idea_uncredited(B, V, T):
    d = V.d["ideas"]["idea-uncredited"]
    p = Page(T)
    p.title(_uncredited_title(d))
    thick, mids = 56, (332, 456)
    calls = {b: (f"{d[b]['classes']['wrong']} wrong",
                 f"95% interval {_uncredited_interval(d[b]['classes']['wrong'], d[b]['uncredited'])}")
             for b, *_ in UNCREDITED_BARS}
    x0 = 64 + 18 + max(max(_uncredited_width(p, name, size=16, weight="bold"),
                           _uncredited_width(p, f"{d[b]['uncredited']} {unit}", size=12))
                       for b, name, unit, _ in UNCREDITED_BARS)
    x1 = 1136 - 16 - max(max(_uncredited_width(p, a, size=16, weight="bold"), _uncredited_width(p, c, size=11))
                         for a, c in calls.values())
    spans = {}
    for (b, name, unit, _), y in zip(UNCREDITED_BARS, mids):
        c, n = d[b]["classes"], d[b]["uncredited"]
        share = _uncredited_shares(c, n)
        last = max(i for i, k in enumerate(UNCREDITED_ORDER) if c[k])
        x, spans[b], narrow = x0, {}, []
        for i, k in enumerate(UNCREDITED_ORDER):
            w = (x1 - x0) * c[k] / n
            if w <= 0:
                continue
            fill = T["other"] if k == "minor" else (T["ink"] if k == "wrong" else T["qr"])
            seg = bar(p.c, x, x + (w if i == last else w - 2), y, thick, fill, r=4 if i == last else 0, zorder=3)
            seg.set_alpha(UNCREDITED_ALPHA.get(k, 1.0))
            spans[b][k] = (x, x + w)
            label = f"{share[k]}%"
            if k != "wrong":  # the "wrong" sliver's count is called out at the bar's end instead
                if w - 2 >= _uncredited_width(p, label, size=15, weight="bold") + 16:
                    p.text(x + (w - 2) / 2, y, label, size=15, weight="bold", ha="center",
                           color="#ffffff" if k == "real" else T["ink"], zorder=4)
                else:  # too narrow to hold its share: flagged under the bar, with a short name (its tint alone is weak)
                    narrow.append((x + (w - 2) / 2,
                                   [(label, "bold", T["ink"]), (UNCREDITED_SHORT[k], "normal", T["ink2"])]))
            x += w
        _uncredited_flags(p, T, narrow, y + thick / 2, +1)
        p.text(x0 - 18, y - 12, name, size=16, weight="bold", ha="right")
        p.text(x0 - 18, y + 17, f"{n} {unit}", size=12, color=T["muted"], ha="right")
        p.text(x1 + 16, y - 12, calls[b][0], size=16, weight="bold")
        p.text(x1 + 16, y + 16, calls[b][1], size=11, color=T["muted"])
    top = spans[UNCREDITED_BARS[0][0]]
    _uncredited_flags(p, T, [(sum(top[k]) / 2, [(UNCREDITED_NAMES[k], "normal", T["ink2"])])
                             for k in top if k != "wrong"], mids[0] - thick / 2, -1)  # "wrong": at the bar's end
    p.source(f"QuickReview's comments no answer key credited · {_uncredited_prs(d)} PRs, earlier builds · checked "
             "against the code by Claude models, partly blinded")
    return p


def numbers_idea_uncredited(B, V):
    """The table behind the image, for out/v3/NUMBERS.md."""
    d = V.d["ideas"]["idea-uncredited"]
    m, fz = d["martian"], d["frozen"]
    name = lambda t: B.tools.get(t, {}).get("name", t)  # noqa: E731
    head = ["Benchmark (unit)", "QuickReview build", "PRs", "All", "Uncredited"] + \
        [UNCREDITED_NAMES[k].capitalize() for k in UNCREDITED_ORDER] + ["Wrong, 95% interval"]
    rows = []
    for b, bench, unit, build in UNCREDITED_BARS:
        x = d[b]
        variants = [(x["classes"], bench)]
        if x["as_labelled"] != x["classes"]:
            variants.append((x["as_labelled"], f"{bench}, repeats as the appendix labels them"))
        for counts, what in variants:
            s = _uncredited_shares(counts, x["uncredited"])
            rows.append([f"{what} ({unit})", build, str(x["prs"]), str(x.get("comments", x.get("findings"))),
                         str(x["uncredited"])] + [f"{counts[k]} ({s[k]}%)" for k in UNCREDITED_ORDER]
                        + [_uncredited_interval(counts["wrong"], x["uncredited"])])
    table = "\n".join("| " + " | ".join(r) + " |" for r in [head, ["---"] * len(head)] + rows)

    def frozen(x, key, what):
        return f"an unknown number of its {what}" if x is None else f"{x['uncredited']} of its {x[key]} {what}"

    g = fz["aacr"]
    aacr = "its AACR-Bench judge grades are unknown" if g is None else (
        f"AACR-Bench's judge grades {g['grades'].get('incorrect', 0)} of its {g['unlinked']} comments linked to no "
        f"credited defect incorrect ({100 * g['grades'].get('incorrect', 0) / g['unlinked']:.1f}%) and "
        f"{g['grades'].get('partly-correct', 0)} partly correct")
    n, w, bw, br = m["uncredited"], m["classes"]["wrong"], m["borderline_wrong"], m["borderline_repeats"]
    borderline = f"{w + bw} of {n} ({100 * (w + bw) / n:.1f}%)" + (
        f", or {w + bw + br} ({100 * (w + bw + br) / n:.1f}%) with their {br} repeats" if br else "")
    sev = ", ".join(f"{v} {k}" for k, v in sorted(m["real_severity"].items(), key=lambda kv: -kv[1]))
    reps = ", ".join(f"{v} {k}" for k, v in sorted(m["repeats"].items(), key=lambda kv: -kv[1]) if k != "dup")
    alike = "; ".join(f"{name(t)} {v['classes']['wrong']}/{v['uncredited']} on Qodo"
                      for t, v in d["qodo"]["others"].items())
    alike += "; on Martian " + ", ".join(f"{name(t)} {bad}/{of}" for t, (bad, of) in m["wrong_by_tool"].items()
                                         if t != "quickreview")
    return (
        "### idea-uncredited\n\n"
        "QuickReview's comments that no answer key credited (Martian: our gpt-6.1-sol judge on its pipeline; Qodo: "
        "the N=5 rule as qodo_judge.py implements it), by what a check against the code found, each bar's shares "
        "rounded by largest remainder to add up to 100.\n\n"
        f"{table}\n\n"
        f"- Earlier builds only: on the same PRs the frozen build leaves "
        f"{frozen(fz['martian'], 'findings', 'Martian findings')} and "
        f"{frozen(fz['qodo'], 'comments', 'Qodo comments')} uncredited, none checked, and {aacr}.\n"
        f"- Labelled by Claude models, partly blinded (one annotator on Qodo), on {_uncredited_prs(d)} PRs of our own "
        f"system; counting as wrong the {bw} low-confidence Martian 'minor' calls whose reasons call the flagged "
        f"behaviour intended gives {borderline}.\n"
        f"- 'Real defect' is any severity (Martian: {m['real_defects']} distinct defects, {sev}; "
        f"{m['low_confidence']['real']} of {m['classes']['real']} findings low-confidence); 'same issue at another "
        f"site' is a repeat of a credited comment, as in the Qodo check, and other repeats count as what they repeat "
        f"(Martian: {reps}; last row: the appendix's own labels).\n"
        f"- Rarely wrong is not unique to QuickReview: wrong of uncredited, {alike}.\n"
    )


FIGURES = {
    "idea-rare-finds": fig_idea_rare_finds,
    "idea-best-of-six": fig_idea_best_of_six,
    "idea-record": fig_idea_record,
    "idea-languages": fig_idea_languages,
    "idea-commercial-misses": fig_idea_commercial_misses,
    "idea-robust": fig_idea_robust,
    "idea-skip-nits": fig_idea_skip_nits,
    "idea-funnel": fig_idea_funnel,
    "idea-price-per-bug": fig_idea_price_per_bug,
    "idea-uncredited": fig_idea_uncredited,
}
NUMBERS = {
    "idea-rare-finds": numbers_idea_rare_finds,
    "idea-best-of-six": numbers_idea_best_of_six,
    "idea-record": numbers_idea_record,
    "idea-languages": numbers_idea_languages,
    "idea-commercial-misses": numbers_idea_commercial_misses,
    "idea-robust": numbers_idea_robust,
    "idea-skip-nits": numbers_idea_skip_nits,
    "idea-funnel": numbers_idea_funnel,
    "idea-price-per-bug": numbers_idea_price_per_bug,
    "idea-uncredited": numbers_idea_uncredited,
}
