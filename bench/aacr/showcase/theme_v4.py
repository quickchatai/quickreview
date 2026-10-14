"""v4's look: v2's colour tokens and marks, plus the one line v2 left out, what the number is.

Every v4 image is a form readers already know from the vendors' and the
benchmarks' own pages: a sorted bar list, a labelled scatter or a leaderboard
table. The text is:
- a title that is the takeaway;
- ONE metric line under it, saying what is measured, out of what, and which way
  is better;
- direct labels;
- one source line.
QuickReview is the only coloured mark. Everything else is one grey at the same
size, and every tool tested is drawn.
"""
import math

import matplotlib.pyplot as plt
import theme_v2
from theme_v2 import FONT, THEMES, Page, bar, save  # noqa: F401  (re-exported for make_charts_v4)

ROW_TINT = {"light": "#e3eefb", "dark": "#1f3550"}  # QuickReview's table row: the accent, very light


class Page4(Page):
    """v2's page with a title and a metric line."""

    def title(self, s):
        self.title_text = s  # the gallery page (make_charts_v4.write_index) lists it
        self.text(64, 74, s, size=27, weight="bold", va="baseline")

    def metric(self, s):
        """What the number is: the one line of explanation every v4 chart keeps."""
        self.metric_text = s
        self.text(64, 110, s, size=15, color=self.T["ink2"], va="baseline")

    def source(self, s):
        """The small print, at most two lines ("\n"), set from the bottom up."""
        lines = s.split("\n")
        for i, ln in enumerate(lines):
            self.text(64, self.h - 30 - 17 * (len(lines) - 1 - i), ln, size=10.5, color=self.T["muted"], va="baseline")


def use(theme):
    """v2's tokens, with the font list as the family itself, so a glyph Noto Sans lacks (an arrow)
    falls back to the next font instead of a missing-glyph box, and no text read as a formula."""
    T = theme_v2.use(theme)
    plt.rcParams["font.family"] = FONT
    plt.rcParams["text.parse_math"] = False  # "$10 to $26" is money, never a formula
    return T


def theme_name(T):
    return "light" if T["surface"] == THEMES["light"]["surface"] else "dark"


def bar_rows(p, rows, x0, x1, top, bottom, vmax, rank=False, track=False, name_size=13.5, value_size=13.5):
    """A sorted horizontal bar list from a zero baseline.

    rows: dicts with name, value, label (the text at the bar's end) and qr (True for
    QuickReview, drawn in the accent with a bold name and value). rank=True prints
    each row's place in the field, and track=True draws the full length (vmax) as a
    light track, so "X of Y" reads at a glance.
    """
    T = p.T
    pitch = (bottom - top) / len(rows)
    h = min(26, pitch * 0.62)
    for i, r in enumerate(rows):
        y = top + pitch * (i + 0.5)
        ink = T["ink"] if r.get("qr") else T["ink2"]
        wt = "bold" if r.get("qr") else "normal"
        if track:
            bar(p.c, x0, x1, y, h, T["empty"], zorder=2)
        tip = x0 + (x1 - x0) * max(r["value"], 0) / vmax
        if tip > x0:
            bar(p.c, x0, tip, y, h, T["qr"] if r.get("qr") else T["other"], zorder=3)
        if rank:
            p.text(64, y, str(r.get("rank", i + 1)), size=name_size - 1, color=T["muted"] if not r.get("qr") else T["ink"],
                   weight=wt)
        p.text(x0 - 14, y, r["name"], ha="right", size=name_size, color=ink, weight=wt)
        p.text((x1 if track else tip) + 12, y, r["label"], size=value_size, color=ink, weight=wt)
    return pitch


def axis_frame(p, box, xr, yr, xticks, yticks, xfmt, yfmt, xlabel, ylabel):
    """Hairline grid, tick labels and plain-words axis titles for a scatter in the pixel box (x0, top, x1, bottom)."""
    T = p.T
    x0, y0, x1, y1 = box
    X = lambda v: x0 + (x1 - x0) * (v - xr[0]) / (xr[1] - xr[0])  # noqa: E731
    Y = lambda v: y1 - (y1 - y0) * (v - yr[0]) / (yr[1] - yr[0])  # noqa: E731
    for v in xticks:
        p.c.plot([X(v)] * 2, [y0, y1], color=T["grid"], lw=1, zorder=1)
        p.text(X(v), y1 + 22, xfmt(v), size=11, color=T["muted"], ha="center")
    for v in yticks:
        p.c.plot([x0, x1], [Y(v)] * 2, color=T["grid"], lw=1, zorder=1)
        p.text(x0 - 12, Y(v), yfmt(v), size=11, color=T["muted"], ha="right")
    p.text((x0 + x1) / 2, y1 + 52, xlabel, size=13, color=T["ink2"], ha="center")
    p.text(x0 - 12, y0 - 22, ylabel, size=13, color=T["ink2"], ha="left", va="baseline")
    return X, Y


def iso_f(p, X, Y, xr, yr, beta, level, label, recall_on_x=True):
    """One faint curve of equal F-beta through the plot, labelled at its upper end."""
    T = p.T
    b2 = beta * beta
    pts = []
    for k in range(401):
        r = xr[0] + (xr[1] - xr[0]) * k / 400 if recall_on_x else None
        if recall_on_x:
            den = (1 + b2) * r - level * b2
            if den <= 0:
                continue
            pr = level * r / den
            if yr[0] <= pr <= yr[1]:
                pts.append((X(r), Y(pr)))
        else:  # precision on x, recall on y
            pr = xr[0] + (xr[1] - xr[0]) * k / 400
            den = (1 + b2) * pr - level
            if den <= 0:
                continue
            rc = level * pr * b2 / den
            if yr[0] <= rc <= yr[1]:
                pts.append((X(pr), Y(rc)))
    if len(pts) > 1:
        p.c.plot([a for a, _ in pts], [b for _, b in pts], color=T["grid"], lw=1.8, ls=(0, (5, 4)), zorder=1)
        ax, ay = pts[-1] if recall_on_x else pts[0]
        p.text(ax + 6, ay - 8, label, size=10.5, color=T["muted"], ha="left")
    return pts


def dot(p, x, y, r, fill, zorder=4):
    """A dot with a 2px surface ring, so overlapping dots stay separable."""
    from matplotlib.patches import Circle
    p.c.add_patch(Circle((x, y), r + 2, facecolor=p.T["surface"], edgecolor="none", zorder=zorder))
    p.c.add_patch(Circle((x, y), r, facecolor=fill, edgecolor="none", zorder=zorder + 1))


def table(p, cols, rows, top, row_h=34, size=13.5, head_size=11.5):
    """A leaderboard table.

    cols: [(header, x, align)], where x is the column's anchor in px.
    rows: dicts with cells (one string per column, or a (value, raw count) pair set
    on two lines), qr (that row gets the accent tint and bold text) and best (the
    indices of the cells to set bold: each column's leader).
    """
    T = p.T
    from matplotlib.patches import FancyBboxPatch
    left, right = 48, p.w - 48
    for h, x, a in cols:
        p.text(x, top, h.upper(), size=head_size, color=T["muted"], ha=a, weight="bold")
    y = top + 18
    p.c.plot([left, right], [y, y], color=T["grid"], lw=1.2, zorder=1)
    for r in rows:
        mid = y + row_h / 2
        if r.get("qr"):
            p.c.add_patch(FancyBboxPatch((left, y + 2), right - left, row_h - 4,
                                         boxstyle="round,pad=0,rounding_size=6",
                                         facecolor=ROW_TINT[theme_name(T)], edgecolor="none", zorder=0.5))
        for k, ((_, x, a), cell) in enumerate(zip(cols, r["cells"])):
            strong = r.get("qr") or k in r.get("best", ())
            ink = T["ink"] if strong else T["ink2"]
            if isinstance(cell, tuple):  # (value, the raw count under it)
                p.text(x, mid - 8, cell[0], size=size, ha=a, weight="bold" if strong else "normal", color=ink)
                p.text(x, mid + 12, cell[1], size=size - 3.5, ha=a, color=T["muted"])
            else:
                p.text(x, mid, cell, size=size, ha=a, weight="bold" if strong else "normal", color=ink)
        y += row_h
        p.c.plot([left, right], [y, y], color=T["grid"], lw=0.8, zorder=1)
    return y


def nice_ticks(lo, hi, n=5):
    span = hi - lo
    step = 10 ** math.floor(math.log10(span / n))
    for m in (1, 2, 2.5, 5, 10):
        if span / (step * m) <= n:
            step *= m
            break
    first = math.ceil(lo / step - 1e-9) * step
    out, v = [], first
    while v <= hi + 1e-9:
        out.append(round(v, 10))
        v += step
    return out


def overflow(page, margin=8):
    """The texts that run off the canvas or into each other's lines: a layout check, run before every save."""
    r = page.fig.canvas.get_renderer()
    inv = page.c.transData.inverted()
    out = list(getattr(page, "issues", []))
    for t in page.c.texts:
        if not t.get_text().strip() or not t.get_visible():
            continue
        (a, b), (c, d) = inv.transform(t.get_window_extent(renderer=r).get_points())
        x0, x1, y0, y1 = min(a, c), max(a, c), min(b, d), max(b, d)
        if x0 < margin or x1 > page.w - margin or y0 < margin or y1 > page.h - margin:
            out.append(f"off canvas: {t.get_text()[:60]!r}")
    return out
