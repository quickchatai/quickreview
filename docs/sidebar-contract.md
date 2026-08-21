# Companion sidebar — the build contract

Working contract for the parallel build of the always-visible companion right
column. Every module below is coded against these signatures **exactly**, so
the pieces meet without a negotiation round. Decisions come from the map
[Companion right-panel UX](../../issue-tracker/tracker/efforts/companion-panel-ux/map.md)
; this file is mechanics only, not decisions.

## Geometry

The frame is composed of an **inner Frame** (the tab, rendered at a reduced
width) with the **sidebar column appended to its right**. The sidebar owns its
own left border, so the inner frame keeps its own right border and the two
simply concatenate.

```
cols = inner.cols + sidebarWidth(cols, state)
```

- expanded: `SIDEBAR_COLS = 44` content, plus its border → `46`
- collapsed: a `3`-wide spine (border + one glyph column)
- hidden (companion off, or terminal too narrow): `0`

Auto-collapse below `SIDEBAR_MIN_COLS = 110` total columns: the board's
list/detail split stops being legible before the sidebar does.

**Row contract**: the sidebar column supplies **exactly `rows` strings**, each
of display width exactly `sidebarWidth`. Row `0` and row `rows-1` must carry
the junction glyphs that continue the inner frame's top and bottom borders
(`┬`/`┴` at the seam, `┐`/`┘` at the right edge) — the sidebar owns its
corners, the compositor never patches them.

## Modules and ownership

### `src/tui/sidebar.ts` — the widget (agent A)

```ts
export const SIDEBAR_COLS = 44;
export const SIDEBAR_MIN_COLS = 110;
export const SIDEBAR_BORDER = 2;          // left divider + right border

/** Total width the column occupies, 0 when hidden. */
export function sidebarWidth(cols: number, st: { collapsed: boolean; available: boolean }): number;

export interface SidebarHeader {
  up: boolean;            // container running
  piUp: boolean;          // the companion pi session is alive
  day: string;            // Warsaw day token, e.g. "2026-08-21"
  lastWake: string;       // "3m ago" | "—"
  memory: "ok" | "degraded" | "off";
}

export interface SidebarView {
  header: SidebarHeader;
  /** Mirror lines, oldest first, SGR-styled (keepSgrOnly already applied). */
  lines: string[];
  input: string;
  focused: boolean;
  collapsed: boolean;
  available: boolean;
  /** Lines above the live tail; 0 = following. */
  offset: number;
  /** Newest alerts, newest last; rendered inline under the mirror. */
  alerts: Array<{ tier: "notice" | "alert"; title: string; ts: string }>;
}

/** Exactly `rows` strings of display width `width`. Pure. */
export function paintSidebar(view: SidebarView, width: number, rows: number): string[];

/** 1-based terminal click → what the sidebar does with it. */
export function sidebarHit(x: number, y: number, cols: number, rows: number, width: number):
  | "input" | "mirror" | "header" | "collapse" | undefined;

export class CompanionSidebar {
  constructor(
    cfg: Pick<CompanionConfig, "container_name" | "session">,
    docker: DockerRunner,
    opts?: { available?: () => boolean; onUpdate?: () => void; now?: () => number },
  );
  view(): SidebarView;
  refresh(): Promise<void>;
  /** Draft text + Enter (the quick-send path). */
  send(text: string): Promise<void>;
  /** Raw stdin passthrough while focused (pipane's keysToTmux). */
  sendKeys(buf: Buffer): Promise<void>;
  focus(seed?: string): void;
  blur(): void;
  toggleCollapse(): void;
  collapsed: boolean;
  scroll(notches: number): void;
  stop(): void;
}
```

Reuse from `pipane.ts`, do not reimplement: `keepSgrOnly`, `splitCapture`,
`keysToTmux`, `SCROLL_STEP`. Capture with `-e` (colors kept — that is the whole
point of the restyle work) and `-J`, through the same local `DockerRunner`
seam `CompanionStrip` used.

### `src/tui/paint.ts` — composition (agent C)

```ts
/** Append a right-hand column to a frame. `column.length === inner.rows`, each
 * of display width `width`. Returns a NEW Frame of `inner.cols + width`;
 * zones and meta are carried over unchanged (their coordinates do not move —
 * the column is appended to the right of existing content). */
export function composeColumn(inner: Frame, column: string[], width: number): Frame;
```

### Strip retirement (agent B)

`src/tui/strip.ts` is deleted; the sidebar absorbs it. `board.ts`,
`memtab.ts`, `digesttab.ts` drop their `strip?: StripView` parameter and the
`stripHeight()` row reservation, so `bodyRows` becomes `rows - 4`.

### Wiring (`app.ts`, `index.ts`) — the orchestrator, not an agent

Key model (provisional — decides it properly):

| key | meaning |
|---|---|
| `/` | focus the sidebar |
| printable on a tab with no binding | focus the sidebar, seeded with that char |
| `Esc` | blur (drop the draft) |
| `Ctrl-q` | release focus (same as the board's pi pane) |
| `\` | toggle collapse |
| `PgUp`/`PgDn` | scroll the sidebar while focused |

Fullscreen is retired: `AttachScreen` is no longer reachable for the companion
or for PR sessions.
