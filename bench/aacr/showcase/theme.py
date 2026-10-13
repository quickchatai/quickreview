"""The showcase's look: colour tokens for both themes, layout in pixels, rounded bars, export.

Every figure is designed on a canvas measured in 1x pixels (matplotlib at 100
dpi) and exported at EXPORT_DPI. Layout is placed in pixels from the top-left
corner, so a figure reads like a page layout rather than a matplotlib default.

Colour does one job: QuickReview is the accent (validated blue, the dataviz
reference palette's slot 1, light #2a78d6 / dark #3987e5); every other tool is
grey — darker for closed-source products, lighter for open-source tools — and a
legend or a label always names the group, so identity is never colour alone.
"""
import math
import os
import textwrap

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.patches import PathPatch  # noqa: E402
from matplotlib.path import Path  # noqa: E402

DESIGN_DPI = 100
EXPORT_DPI = 160  # a 1200 px wide design exports at 1920 px

THEMES = {
    "light": {
        "surface": "#fcfcfb", "ink": "#0b0b0b", "ink2": "#52514e", "muted": "#898781",
        "grid": "#e1e0d9", "axis": "#c3c2b7", "track": "#efeee9",
        "qr": "#2a78d6", "qr_soft": "#cde2fb", "qr_text": "#1c5cab",
        "closed": "#85837c", "open": "#c4c2ba", "empty": "#e9e8e2",
    },
    "dark": {
        "surface": "#1a1a19", "ink": "#ffffff", "ink2": "#c3c2b7", "muted": "#898781",
        "grid": "#2c2c2a", "axis": "#383835", "track": "#252524",
        "qr": "#3987e5", "qr_soft": "#184f95", "qr_text": "#86b6ef",
        "closed": "#7c7a73", "open": "#4f4e4a", "empty": "#2a2a28",
    },
}
# The sequential ramp (blue, light -> dark), for cells that encode magnitude.
BLUE_RAMP = ["#cde2fb", "#b7d3f6", "#9ec5f4", "#86b6ef", "#6da7ec", "#5598e7", "#3987e5",
             "#2a78d6", "#256abf", "#1c5cab", "#184f95", "#104281", "#0d366b"]

FONT = ["Noto Sans", "Liberation Sans", "DejaVu Sans"]
KIND_LABEL = {"quickreview": "QuickReview", "closed": "Closed-source product", "open": "Open-source tool"}


def use(theme):
    T = THEMES[theme]
    plt.rcParams.update({
        "font.family": "sans-serif", "font.sans-serif": FONT, "font.size": 11,
        "text.color": T["ink"], "axes.labelcolor": T["ink2"], "axes.edgecolor": T["axis"],
        "xtick.color": T["muted"], "ytick.color": T["ink2"], "figure.facecolor": T["surface"],
        "axes.facecolor": T["surface"], "savefig.facecolor": T["surface"],
        "axes.spines.top": False, "axes.spines.right": False, "svg.fonttype": "path",
        "svg.hashsalt": "qcr-showcase",  # stable element ids: a re-render of unchanged data is byte-identical
        "axes.linewidth": 0.8, "xtick.major.width": 0.8, "ytick.major.width": 0.8,
    })
    return T


class Page:
    """A figure laid out in 1x pixels from the top-left corner."""

    def __init__(self, T, w, h):
        self.T, self.w, self.h = T, w, h
        self.fig = plt.figure(figsize=(w / DESIGN_DPI, h / DESIGN_DPI), dpi=DESIGN_DPI)
        # The canvas: one invisible axes over the whole page whose data units ARE 1x pixels,
        # y growing downwards, so marks are placed exactly like the text.
        self.c = self.fig.add_axes([0, 0, 1, 1], zorder=0)
        self.c.set_xlim(0, w)
        self.c.set_ylim(h, 0)
        self.c.set_axis_off()
        self.c.patch.set_visible(False)

    def fx(self, x):
        return x / self.w

    def fy(self, y):
        return 1 - y / self.h

    def axes(self, left, top, width, height, **kw):
        ax = self.fig.add_axes([left / self.w, 1 - (top + height) / self.h, width / self.w, height / self.h], **kw)
        ax.set_facecolor(self.T["surface"])
        return ax

    def text(self, x, y, s, size=11, color=None, weight="normal", ha="left", va="baseline", **kw):
        return self.fig.text(self.fx(x), self.fy(y), s, fontsize=size, color=color or self.T["ink"],
                             fontweight=weight, ha=ha, va=va, **kw)

    def header(self, title, subtitle=None, x=56, y=56, width=150):
        """Title, then a subtitle wrapped to `width` characters; returns the y below it."""
        self.text(x, y, title, size=21, weight="bold")
        if not subtitle:
            return y + 24
        sub = textwrap.fill(subtitle, width)
        t = self.text(x, y + 15, sub, size=12.5, color=self.T["ink2"], va="top", linespacing=1.25)
        return round(y + 15 + text_height(self.fig, t) + 20)

    def footer(self, s, x=56, bottom=18, width=188):
        """Small print, wrapped, growing upwards from the bottom edge."""
        s = "\n".join(textwrap.fill(par, width) for par in s.split("\n"))
        self.text(x, self.h - bottom, s, size=8.6, color=self.T["muted"], va="bottom", linespacing=1.5)

    def legend(self, items, x, y, size=10.5, gap=26):
        """items: [(colour, label)] as a row of 10 px swatches."""
        for colour, label in items:
            self.fig.patches.append(matplotlib.patches.FancyBboxPatch(
                (self.fx(x), self.fy(y + 5)), 10 / self.w, 10 / self.h, boxstyle="round,pad=0,rounding_size=0.002",
                transform=self.fig.transFigure, facecolor=colour, edgecolor="none"))
            t = self.text(x + 16, y + 4, label, size=size, color=self.T["ink2"])
            x += 16 + text_width(self.fig, t) + gap
        return x


def text_width(fig, t):
    """A placed text's width in 1x pixels."""
    r = fig.canvas.get_renderer()
    return t.get_window_extent(renderer=r).width * DESIGN_DPI / fig.dpi


def text_height(fig, t):
    """A placed text's height in 1x pixels."""
    r = fig.canvas.get_renderer()
    return t.get_window_extent(renderer=r).height * DESIGN_DPI / fig.dpi


def px_per_unit(ax):
    (x0, y0), (x1, y1) = ax.transData.transform([(0, 0), (1, 1)])
    return abs(x1 - x0), abs(y1 - y0)


def bar(ax, base, tip, mid, thick, colour, r=4, vertical=False, zorder=2):
    """A bar from `base` to `tip` along its length axis (tip may lie either side of base),
    centred on `mid` and `thick` across (data units): rounded at the tip by r 1x pixels,
    square at the base — the mark spec. vertical=True runs it along y.
    Call after the axes' limits are final: the rounding is computed in pixels.
    """
    length = tip - base
    if length == 0:
        return None
    sx, sy = px_per_unit(ax)
    s_len, s_cross = (sy, sx) if vertical else (sx, sy)
    L = abs(length)
    ru, rv = min(r / s_len, L), min(r / s_cross, thick / 2)
    lo, hi = -thick / 2, thick / 2
    pts = [(0, lo), (L - ru, lo)]
    for k in range(9):  # one tip corner, then the other
        a = -math.pi / 2 + k * math.pi / 16
        pts.append((L - ru + ru * math.cos(a), lo + rv + rv * math.sin(a)))
    for k in range(9):
        a = k * math.pi / 16
        pts.append((L - ru + ru * math.cos(a), hi - rv + rv * math.sin(a)))
    pts += [(L - ru, hi), (0, hi), (0, lo)]
    sign = 1 if length > 0 else -1
    pts = [(base + sign * u, mid + v) for u, v in pts]
    if vertical:
        pts = [(b, a) for a, b in pts]
    p = PathPatch(Path(pts, closed=True), facecolor=colour, edgecolor="none", zorder=zorder)
    ax.add_patch(p)
    return p


def clean(ax, keep=()):
    for side in ("top", "right", "left", "bottom"):
        ax.spines[side].set_visible(side in keep)
    ax.tick_params(length=0)


def save(page, out_dir, name, theme, svg=False):
    os.makedirs(out_dir, exist_ok=True)
    stem = name if theme == "light" else f"{name}-dark"
    page.fig.savefig(os.path.join(out_dir, f"{stem}.png"), dpi=EXPORT_DPI)
    if svg:
        page.fig.savefig(os.path.join(out_dir, f"{stem}.svg"), metadata={"Date": None})
    plt.close(page.fig)
    return os.path.join(out_dir, f"{stem}.png")
