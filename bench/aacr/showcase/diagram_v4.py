"""Diagram primitives for the v4 infographics, in v4's look (theme_v4).

A diagram is a Page4: a title that is the takeaway, one line under it saying
what the picture shows, the drawing and one source line. The drawing is made
of a few parts:
- nodes: rounded boxes with a bold label and an optional short note;
- arrows: straight, curved or elbowed, with an optional label;
- groups: a tinted region with a small caps name, such as SANDBOX or JUDGE;
- badges: numbered circles for the steps of a process;
- pills: small tags such as "185 PRs";
- stats: one big number with its caption;
- icons: simple line glyphs drawn in code, so nothing is downloaded.

Colour does one job, as in the charts:
- QuickReview's own parts take the accent (style "qr", a blue outline and tint;
  "qr-solid", filled);
- everything else is neutral ("plain", "soft", "ghost").
Coordinates are 1x pixels from the top-left corner, like the rest of v4.
"""
import math

from matplotlib.patches import Circle, FancyArrowPatch, FancyBboxPatch, PathPatch, Polygon
from matplotlib.path import Path

from theme_v4 import theme_name

TINTS = {  # light / dark: the accent's tint for QuickReview's parts, a neutral fill, a group wash
    "light": {"qr_fill": "#eaf2fd", "qr_line": "#2a78d6", "fill": "#f1f0ec", "line": "#d6d4cc",
              "wash": "#f6f5f1", "qr_wash": "#f2f7fe", "solid_ink": "#ffffff", "good": "#2f8f5b",
              "bad": "#c4473a"},
    "dark": {"qr_fill": "#1c2c42", "qr_line": "#3987e5", "fill": "#262624", "line": "#3a3a37",
             "wash": "#20201e", "qr_wash": "#1b2433", "solid_ink": "#ffffff", "good": "#4cb37b",
             "bad": "#e0685a"},
}


def tint(p):
    return TINTS[theme_name(p.T)]


PT = 100 / 72  # px per point: the canvas is drawn at 100 dpi


def measure(p, s, size, weight="normal"):
    """The width of s in canvas px, measured by the renderer (never guessed)."""
    t = p.c.text(0, 0, s, fontsize=size, fontweight=weight)
    r = p.fig.canvas.get_renderer()
    bb = t.get_window_extent(renderer=r)
    t.remove()
    (x0, _), (x1, _) = p.c.transData.inverted().transform([(bb.x0, bb.y0), (bb.x1, bb.y1)])
    return abs(x1 - x0)


def lines(p, s, width, size, weight="normal"):
    """s broken into lines that fit width px at a font size (explicit newlines kept)."""
    out = []
    for para in s.split("\n"):
        cur = ""
        for word in [w for w in para.split(" ") if w]:  # a no-break space (\u00a0) keeps "145 medium" whole
            cand = f"{cur} {word}".strip()
            if cur and measure(p, cand, size, weight) > width:
                out.append(cur)
                cur = word
            else:
                cur = cand
        out.append(cur)
    return out


def text_block(p, x, top, rows, ha="left", z=5):
    """Draw [(text, size, weight, colour)] line by line from `top` down. Returns the y under the block."""
    y = top
    for s, size, weight, colour in rows:
        p.text(x, y, s, size=size, weight=weight, color=colour, ha=ha, va="top", zorder=z)
        y += size * PT * 1.28
    return y


def node(p, x, y, w, h, label, note=None, style="plain", size=15, note_size=12, align="center", num=None,
         icon_name=None, radius=10, lw=1.4, z=3, icon_top=False):
    """A rounded box whose top-left corner is (x, y). Returns its centre.

    style:
      plain     neutral fill, hairline;
      soft      wash fill, no line;
      ghost     no fill, dashed line (something outside the system);
      qr        the accent's tint with an accent line (QuickReview's parts);
      qr-solid  filled with the accent, white text (the one thing to look at).
    With an icon the text is set left of centre, beside it (icon_top=True puts the icon above centred
    text instead); without, centred.
    """
    T, k = p.T, tint(p)
    face, edge, ls, ink, ink2 = {
        "plain": (k["fill"], k["line"], "-", T["ink"], T["ink2"]),
        "soft": (k["wash"], "none", "-", T["ink"], T["ink2"]),
        "ghost": ("none", T["muted"], (0, (4, 3)), T["ink"], T["ink2"]),
        "qr": (k["qr_fill"], k["qr_line"], "-", T["ink"], T["ink2"]),
        "qr-solid": (T["qr"], T["qr"], "-", k["solid_ink"], k["solid_ink"]),
    }[style]
    p.c.add_patch(FancyBboxPatch((x, y), w, h, boxstyle=f"round,pad=0,rounding_size={radius}",
                                 facecolor=face, edgecolor=edge, lw=lw, ls=ls, zorder=z))
    pad = 14
    left = x + pad
    side_icon = icon_name and not icon_top
    if side_icon:
        left = x + pad + 30
    inner = x + w - pad - left
    centred = align == "center" and not side_icon
    rows = [(ln, size, "bold", ink) for ln in lines(p, label, inner, size, "bold")]
    if note:
        rows += [("", note_size * 0.45, "normal", ink2)]
        rows += [(ln, note_size, "normal", ink2) for ln in lines(p, note, inner, note_size)]
    block = sum(r[1] * PT * 1.28 for r in rows)
    room_top = y + (40 if icon_top and icon_name else 0)
    room = y + h - room_top
    if block > room - 12:  # the layout check (theme_v4.overflow) reports it
        p.__dict__.setdefault("issues", []).append(f"text does not fit its box: {label!r}")
    top = room_top + (room - block) / 2 + 1
    icol = ink if style == "qr-solid" else (T["qr"] if style.startswith("qr") else T["ink2"])
    if side_icon:
        icon(p, icon_name, x + pad + 11, top + size * PT * 0.62, 20, color=icol, z=z + 1)
    elif icon_name:
        icon(p, icon_name, x + w / 2, y + 26, 22, color=icol, z=z + 1)
    if num is not None:
        badge(p, x, y, num, z=z + 2)
    text_block(p, x + w / 2 if centred else left, top, rows, ha="center" if centred else "left", z=z + 1)
    return (x + w / 2, y + h / 2)


def group(p, x, y, w, h, label=None, qr=False, z=1, radius=16):
    """A tinted region holding related nodes, named in small caps at its top-left corner."""
    k = tint(p)
    p.c.add_patch(FancyBboxPatch((x, y), w, h, boxstyle=f"round,pad=0,rounding_size={radius}",
                                 facecolor=k["qr_wash"] if qr else k["wash"],
                                 edgecolor=k["qr_line"] if qr else k["line"], lw=1.0,
                                 ls=(0, (2, 3)) if not qr else "-", zorder=z))
    if label:
        p.text(x + 16, y + 22, label.upper(), size=11, weight="bold", color=p.T["qr"] if qr else p.T["muted"],
               va="baseline", zorder=z + 1)


def arrow(p, a, b, label=None, rad=0.0, dashed=False, color=None, lw=1.8, head=11, label_pos=0.5,
          label_dx=0, label_dy=-12, z=2, size=11.5, shrink=0):
    """An arrow from a to b (points in px). rad bends it (matplotlib's arc3), label sits near its middle."""
    T = p.T
    col = color or T["muted"]
    ar = FancyArrowPatch(a, b, arrowstyle=f"-|>,head_length={head * 0.08},head_width={head * 0.05}",
                         connectionstyle=f"arc3,rad={rad}", mutation_scale=10, color=col, lw=lw,
                         ls=(0, (4, 3)) if dashed else "-", zorder=z, shrinkA=shrink, shrinkB=shrink)
    p.c.add_patch(ar)
    if label:
        mx = a[0] + (b[0] - a[0]) * label_pos + label_dx
        my = a[1] + (b[1] - a[1]) * label_pos + label_dy
        p.text(mx, my, label, size=size, color=T["ink2"], ha="center", va="center", zorder=z + 3,
               bbox={"facecolor": T["surface"], "edgecolor": "none", "pad": 1.5})
    return ar


def path_arrow(p, pts, label=None, dashed=False, color=None, lw=1.8, label_at=None, size=11.5, z=2, head=True):
    """An elbowed arrow through pts [(x, y), ...]; the head is on the last segment."""
    T = p.T
    col = color or T["muted"]
    xs, ys = [q[0] for q in pts[:-1]], [q[1] for q in pts[:-1]]
    p.c.plot(xs + [pts[-1][0]] if not head else xs, ys + [pts[-1][1]] if not head else ys, color=col, lw=lw,
             ls=(0, (4, 3)) if dashed else "-", zorder=z, solid_capstyle="round")
    if head:
        arrow(p, pts[-2], pts[-1], dashed=dashed, color=col, lw=lw, z=z)
    if label:
        lx, ly = label_at if label_at else ((pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2 - 12)
        p.text(lx, ly, label, size=size, color=T["ink2"], ha="center", va="center", zorder=z + 3,
               bbox={"facecolor": T["surface"], "edgecolor": "none", "pad": 1.5})


def badge(p, x, y, n, r=13, z=6, qr=True):
    """A numbered step marker centred on (x, y)."""
    T = p.T
    p.c.add_patch(Circle((x, y), r + 2.5, facecolor=T["surface"], edgecolor="none", zorder=z))
    p.c.add_patch(Circle((x, y), r, facecolor=T["qr"] if qr else T["ink2"], edgecolor="none", zorder=z + 1))
    p.text(x, y + 0.5, str(n), size=12, weight="bold", color="#ffffff", ha="center", va="center", zorder=z + 2)


def pill(p, x, y, text, qr=False, size=11.5, ha="left", z=5):
    """A small rounded tag; (x, y) is its left (or centre, ha='center') middle. Returns its width."""
    T, k = p.T, tint(p)
    w = measure(p, text, size, "bold" if qr else "normal") + 22
    x0 = x - w / 2 if ha == "center" else x
    p.c.add_patch(FancyBboxPatch((x0, y - 13), w, 26, boxstyle="round,pad=0,rounding_size=13",
                                 facecolor=k["qr_fill"] if qr else k["fill"], edgecolor="none", zorder=z))
    p.text(x0 + w / 2, y, text, size=size, color=T["qr"] if qr else T["ink2"], ha="center", va="center",
           weight="bold" if qr else "normal", zorder=z + 1)
    return w


def stat(p, x, y, value, caption, qr=True, size=40, cap_size=13, ha="left", width=220):
    """One big number with its caption under it; (x, y) is the number's baseline start."""
    T = p.T
    p.text(x, y, value, size=size, weight="bold", color=T["qr"] if qr else T["ink"], ha=ha, va="baseline")
    text_block(p, x, y + 10, [(ln, cap_size, "normal", T["ink2"]) for ln in lines(p, caption, width, cap_size)],
               ha=ha)


def check(p, x, y, ok=True, size=18, z=6):
    """A drawn tick (ok) or cross, centred on (x, y)."""
    k = tint(p)
    col = k["good"] if ok else k["bad"]
    s = size / 2
    if ok:
        p.c.plot([x - s * 0.8, x - s * 0.2, x + s * 0.9], [y, y + s * 0.6, y - s * 0.7], color=col, lw=2.6,
                 solid_capstyle="round", solid_joinstyle="round", zorder=z)
    else:
        p.c.plot([x - s * 0.6, x + s * 0.6], [y - s * 0.6, y + s * 0.6], color=col, lw=2.6, solid_capstyle="round",
                 zorder=z)
        p.c.plot([x - s * 0.6, x + s * 0.6], [y + s * 0.6, y - s * 0.6], color=col, lw=2.6, solid_capstyle="round",
                 zorder=z)


# ---------------------------------------------------------------- icons: line glyphs, centred on (x, y)
def icon(p, name, x, y, s, color=None, z=5, lw=1.8):
    """A small line icon of size s px. Names: pr, doc, gear, lock, shield, person, people, db, chat, chart,
    search, clock, coin, box, judge, bolt, branch, eye, list, plug, loop, flag, cloud, terminal, book."""
    T = p.T
    col = color or T["ink2"]
    h = s / 2
    kw = {"color": col, "lw": lw, "zorder": z, "solid_capstyle": "round", "solid_joinstyle": "round"}
    ax = p.c

    def circ(cx, cy, r, fill=False):
        ax.add_patch(Circle((cx, cy), r, facecolor=col if fill else "none", edgecolor=col, lw=lw, zorder=z))

    def rect(x0, y0, w, hh, r=2, fill=False):
        ax.add_patch(FancyBboxPatch((x0, y0), w, hh, boxstyle=f"round,pad=0,rounding_size={r}",
                                    facecolor=col if fill else "none", edgecolor=col, lw=lw, zorder=z))

    if name == "pr":  # two commits and a merge line
        circ(x - h * 0.5, y - h * 0.6, h * 0.22)
        circ(x - h * 0.5, y + h * 0.6, h * 0.22)
        circ(x + h * 0.5, y + h * 0.6, h * 0.22)
        ax.plot([x - h * 0.5, x - h * 0.5], [y - h * 0.38, y + h * 0.38], **kw)
        ax.plot([x + h * 0.5, x + h * 0.5, x + h * 0.1], [y + h * 0.38, y - h * 0.3, y - h * 0.6], **kw)
    elif name == "doc":
        rect(x - h * 0.65, y - h * 0.85, h * 1.3, h * 1.7)
        for k_ in (-0.35, 0, 0.35):
            ax.plot([x - h * 0.35, x + h * 0.35], [y + h * k_, y + h * k_], **kw)
    elif name == "gear":
        circ(x, y, h * 0.32)
        for a in range(8):
            t = a * math.pi / 4
            ax.plot([x + math.cos(t) * h * 0.55, x + math.cos(t) * h * 0.85],
                    [y + math.sin(t) * h * 0.55, y + math.sin(t) * h * 0.85], **kw)
        circ(x, y, h * 0.6)
    elif name == "lock":
        rect(x - h * 0.7, y - h * 0.05, h * 1.4, h * 0.95)
        ax.add_patch(PathPatch(Path([(x - h * 0.42, y - h * 0.05), (x - h * 0.42, y - h * 0.55),
                                     (x - h * 0.42, y - h * 0.95), (x, y - h * 0.95), (x + h * 0.42, y - h * 0.95),
                                     (x + h * 0.42, y - h * 0.55), (x + h * 0.42, y - h * 0.05)],
                                    [Path.MOVETO, Path.LINETO, Path.CURVE3, Path.CURVE3, Path.CURVE3, Path.CURVE3,
                                     Path.LINETO]), facecolor="none", edgecolor=col, lw=lw, zorder=z))
    elif name == "shield":
        ax.add_patch(Polygon([(x, y - h * 0.95), (x + h * 0.8, y - h * 0.6), (x + h * 0.65, y + h * 0.35),
                              (x, y + h * 0.95), (x - h * 0.65, y + h * 0.35), (x - h * 0.8, y - h * 0.6)],
                             closed=True, facecolor="none", edgecolor=col, lw=lw, zorder=z, joinstyle="round"))
        ax.plot([x - h * 0.3, x - h * 0.05, x + h * 0.35], [y, y + h * 0.28, y - h * 0.25], **kw)
    elif name in ("person", "people"):
        offs = [0] if name == "person" else [-h * 0.42, h * 0.42]
        for o in offs:
            circ(x + o, y - h * 0.45, h * 0.3)
            ax.add_patch(PathPatch(Path([(x + o - h * 0.55, y + h * 0.85), (x + o - h * 0.55, y + h * 0.05),
                                         (x + o + h * 0.55, y + h * 0.05), (x + o + h * 0.55, y + h * 0.85)],
                                        [Path.MOVETO, Path.CURVE4, Path.CURVE4, Path.CURVE4]),
                                   facecolor="none", edgecolor=col, lw=lw, zorder=z))
    elif name == "db":
        from matplotlib.patches import Ellipse
        for yy in (-0.7, ):
            ax.add_patch(Ellipse((x, y + h * yy), h * 1.4, h * 0.5, facecolor="none", edgecolor=col, lw=lw, zorder=z))
        ax.plot([x - h * 0.7, x - h * 0.7], [y - h * 0.7, y + h * 0.7], **kw)
        ax.plot([x + h * 0.7, x + h * 0.7], [y - h * 0.7, y + h * 0.7], **kw)
        from matplotlib.patches import Arc
        ax.add_patch(Arc((x, y + h * 0.7), h * 1.4, h * 0.5, theta1=0, theta2=180, edgecolor=col, lw=lw, zorder=z))
        ax.add_patch(Arc((x, y), h * 1.4, h * 0.5, theta1=0, theta2=180, edgecolor=col, lw=lw, zorder=z))
    elif name == "chat":
        rect(x - h * 0.85, y - h * 0.7, h * 1.7, h * 1.15, r=4)
        ax.plot([x - h * 0.35, x - h * 0.55, x - h * 0.05], [y + h * 0.45, y + h * 0.85, y + h * 0.45], **kw)
    elif name == "chart":
        ax.plot([x - h * 0.85, x - h * 0.85, x + h * 0.85], [y - h * 0.85, y + h * 0.85, y + h * 0.85], **kw)
        for i, v in enumerate((0.35, 0.8, 0.55)):
            rect(x - h * 0.5 + i * h * 0.45, y + h * 0.85 - h * 1.4 * v, h * 0.28, h * 1.4 * v - 1, r=1, fill=True)
    elif name == "search":
        circ(x - h * 0.15, y - h * 0.15, h * 0.55)
        ax.plot([x + h * 0.25, x + h * 0.8], [y + h * 0.25, y + h * 0.8], **kw)
    elif name == "clock":
        circ(x, y, h * 0.85)
        ax.plot([x, x, x + h * 0.4], [y - h * 0.5, y, y + h * 0.2], **kw)
    elif name == "coin":
        circ(x, y, h * 0.85)
        p.text(x, y + 1, "$", size=s * 0.55, weight="bold", color=col, ha="center", va="center", zorder=z)
    elif name == "box":  # a container
        rect(x - h * 0.85, y - h * 0.6, h * 1.7, h * 1.3, r=2)
        ax.plot([x - h * 0.85, x + h * 0.85], [y - h * 0.15, y - h * 0.15], **kw)
        ax.plot([x - h * 0.2, x + h * 0.2], [y + h * 0.2, y + h * 0.2], **kw)
    elif name == "judge":  # scales
        ax.plot([x, x], [y - h * 0.85, y + h * 0.75], **kw)
        ax.plot([x - h * 0.8, x + h * 0.8], [y - h * 0.55, y - h * 0.55], **kw)
        ax.plot([x - h * 0.45, x + h * 0.45], [y + h * 0.75, y + h * 0.75], **kw)
        for o in (-0.8, 0.8):
            ax.plot([x + h * o - h * 0.3, x + h * o, x + h * o + h * 0.3], [y + h * 0.05, y - h * 0.55, y + h * 0.05],
                    **kw)
            ax.plot([x + h * o - h * 0.3, x + h * o + h * 0.3], [y + h * 0.05, y + h * 0.05], **kw)
    elif name == "bolt":
        ax.add_patch(Polygon([(x + h * 0.15, y - h * 0.95), (x - h * 0.55, y + h * 0.1), (x - h * 0.05, y + h * 0.1),
                              (x - h * 0.2, y + h * 0.95), (x + h * 0.55, y - h * 0.15), (x + h * 0.05, y - h * 0.15)],
                             closed=True, facecolor="none", edgecolor=col, lw=lw, zorder=z, joinstyle="round"))
    elif name == "branch":
        circ(x - h * 0.45, y - h * 0.65, h * 0.2)
        circ(x - h * 0.45, y + h * 0.65, h * 0.2)
        circ(x + h * 0.5, y - h * 0.3, h * 0.2)
        ax.plot([x - h * 0.45, x - h * 0.45], [y - h * 0.45, y + h * 0.45], **kw)
        ax.plot([x + h * 0.5, x + h * 0.5, x - h * 0.3], [y - h * 0.1, y + h * 0.15, y + h * 0.5], **kw)
    elif name == "eye":
        ax.add_patch(PathPatch(Path([(x - h * 0.95, y), (x, y - h * 0.85), (x + h * 0.95, y), (x, y + h * 0.85),
                                     (x - h * 0.95, y)],
                                    [Path.MOVETO, Path.CURVE3, Path.CURVE3, Path.CURVE3, Path.CURVE3]),
                               facecolor="none", edgecolor=col, lw=lw, zorder=z))
        circ(x, y, h * 0.28, fill=True)
    elif name == "list":
        for k_ in (-0.6, 0, 0.6):
            circ(x - h * 0.7, y + h * k_, h * 0.09, fill=True)
            ax.plot([x - h * 0.4, x + h * 0.85], [y + h * k_, y + h * k_], **kw)
    elif name == "plug":
        rect(x - h * 0.5, y - h * 0.2, h * 1.0, h * 0.7, r=3)
        ax.plot([x - h * 0.25, x - h * 0.25], [y - h * 0.2, y - h * 0.75], **kw)
        ax.plot([x + h * 0.25, x + h * 0.25], [y - h * 0.2, y - h * 0.75], **kw)
        ax.plot([x, x], [y + h * 0.5, y + h * 0.95], **kw)
    elif name == "loop":
        from matplotlib.patches import Arc
        ax.add_patch(Arc((x, y), h * 1.6, h * 1.6, theta1=40, theta2=330, edgecolor=col, lw=lw, zorder=z))
        a = math.radians(40)
        tx, ty = x + math.cos(a) * h * 0.8, y - math.sin(a) * h * 0.8
        ax.plot([tx - h * 0.35, tx, tx + h * 0.05], [ty - h * 0.05, ty, ty + h * 0.38], **kw)
    elif name == "flag":
        ax.plot([x - h * 0.6, x - h * 0.6], [y - h * 0.9, y + h * 0.9], **kw)
        ax.add_patch(Polygon([(x - h * 0.6, y - h * 0.9), (x + h * 0.8, y - h * 0.55), (x - h * 0.6, y - h * 0.1)],
                             closed=True, facecolor="none", edgecolor=col, lw=lw, zorder=z, joinstyle="round"))
    elif name == "cloud":
        for cx_, cy_, r_ in ((-0.4, 0.15, 0.4), (0.1, -0.2, 0.5), (0.5, 0.2, 0.38)):
            circ(x + h * cx_, y + h * cy_, h * r_)
    elif name == "terminal":
        rect(x - h * 0.9, y - h * 0.7, h * 1.8, h * 1.4, r=3)
        ax.plot([x - h * 0.55, x - h * 0.25, x - h * 0.55], [y - h * 0.25, y, y + h * 0.25], **kw)
        ax.plot([x - h * 0.05, x + h * 0.45], [y + h * 0.3, y + h * 0.3], **kw)
    elif name == "book":
        rect(x - h * 0.85, y - h * 0.7, h * 0.85, h * 1.4, r=2)
        rect(x, y - h * 0.7, h * 0.85, h * 1.4, r=2)
    else:
        raise ValueError(f"unknown icon {name!r}")
