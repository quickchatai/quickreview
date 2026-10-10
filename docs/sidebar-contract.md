# Companion sidebar — the build contract

The contract for the always-visible companion right column. The modules below
are coded against these signatures, so the pieces meet without negotiation.
This file is mechanics only; the layout rule itself is in the TUI's ratified
decisions (root CLAUDE.md, "The TUI has ONE layout").

## Geometry

The frame is composed of an **inner Frame** (the tab, rendered at a reduced
width) with the **sidebar column appended to its right**. The sidebar owns its
own left border, so the inner frame keeps its own right border and the two
simply concatenate.

```
cols = inner.cols + sidebarWidth(cols, state)
```

- default: half the terminal, clamped to leave `64` columns for the tab
- resized: drag the column's left border; minimum `24`, maximum leaves
  `64` columns for the tab

That is the whole state space. There is **no collapsed spine, no hidden
state and no config-driven zero width**: the column is on every frame in every configuration — `--no-companion`
and `[companion] enabled = false` change what runs and what the column says,
never whether it is there — and a terminal too narrow for both minimums gets a
cramped tab beside a minimum-width column, not a column that folds away. An
explicitly resized width survives TUI hot reload; a stored width equal to the
legacy fixed 46-column default (`LEGACY_SIDEBAR_WIDTH`) is dropped rather
than restored as a preference. Pinned by
`tests/tui-fixed-layout.test.ts`.

**Row contract**: the sidebar column supplies **exactly `rows` strings**, each
of display width exactly `sidebarWidth`. Row `0` and row `rows-1` must carry
the junction glyphs that continue the inner frame's top and bottom borders
(`┬`/`┴` at the seam, `┐`/`┘` at the right edge) — the sidebar owns its
corners, the compositor never patches them.

**Terminal contract**: the mirrored pi is not left at detached tmux's 80×24
default. On every capture, `resize-window` first sets tmux to the exact mirror
rectangle: sidebar inner width minus its one-cell visual inset, and the row
budget left after borders/header/divider/hint/alerts. Resize and capture share
one tmux invocation so terminal reflow cannot race the screenshot.

## Modules and ownership

### `src/tui/sidebar.ts` — the widget (agent A)

```ts
export const SIDEBAR_BORDER = 2;          // left divider + right border

/** Total width the column occupies — always its full width. */
export function sidebarWidth(cols: number, st?: { preferredWidth?: number }): number;

export interface SidebarHeader {
  up: boolean;            // container running
  piUp: boolean;          // the companion pi session is alive
  day: string;            // ops-day token, e.g. "2026-08-21"
  lastWake: string;       // "3m ago" | "—"
  memory: "ok" | "degraded" | "off";
}

export interface SidebarView {
  header: SidebarHeader;
  /** Mirror lines, oldest first, SGR-styled (keepSgrOnly already applied). */
  lines: string[];
  focused: boolean;
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
  | "input" | "mirror" | "header" | undefined;

export class CompanionSidebar {
  constructor(
    cfg: Pick<CompanionConfig, "container_name" | "session">,
    docker: DockerRunner,
    opts?: { available?: () => boolean; onUpdate?: () => void; now?: () => number },
  );
  view(): SidebarView;
  /** Receives the currently painted sidebar geometry from App.repaint. */
  setViewport(width: number, rows: number): void;
  /** Atomically resizes the tmux window and captures the resulting pane. */
  refresh(): Promise<void>;
  send(text: string): Promise<void>;
  /** Raw stdin passthrough while focused (pipane's keysToTmux). */
  sendKeys(buf: Buffer): Promise<void>;
  focus(seed?: string): void;
  blur(): void;
  resizeFromPointer(cols: number, x: number): number;
  preferredWidth: number | undefined; // undefined = responsive half-screen default
  scroll(notches: number): void;
  stop(): void;
}
```

Reuse from `pipane.ts`, do not reimplement: `keepSgrOnly`, `splitCapture`,
`keysToTmux`, `SCROLL_STEP`. Capture with `-e` (colors kept — that is the whole
point of the restyle work) and `-J`, through the same local `DockerRunner`
seam.

### `src/tui/paint.ts` — composition (agent C)

```ts
/** Append a right-hand column to a frame. `column.length === inner.rows`, each
 * of display width `width`. Returns a NEW Frame of `inner.cols + width`;
 * zones and meta are carried over unchanged (their coordinates do not move —
 * the column is appended to the right of existing content). */
export function composeColumn(inner: Frame, column: string[], width: number): Frame;
```

### Tab body height (agent B)

The command bar wraps instead of dropping buttons, so a tab's body height is
`rows - 2 - barHeight(tab, cols, live.bar)` (`src/tui/cmdbar.ts`), and the
board's pi viewport is sized from the same number (`boardBarHeight`). The
eight tabs (`src/tui/tabs.ts`: board · memory · digest · tickets · deploy ·
metrics · feedback · scan) register under `AppHooks.tabs[tab]` as one `TabHooks`
each — `screen` / `key` / `click` / `keys`, the last being the LIVE key set
the bar paints and `App.registeredKeys()` derives from. `docs/tui.md` is the
surface contract.

### Wiring (`app.ts`, `index.ts`) — the orchestrator, not an agent

Key model:

| key | meaning |
|---|---|
| `/` | focus the sidebar |
| printable the current frame does not register (`App.registeredKeys()`, derived from the bar it is painting) | focus the sidebar, seeded with that char |
| `Esc` | forwarded to pi while focused |
| `Ctrl-q` | release focus (same as the board's pi pane) |
| `PgUp`/`PgDn` | scroll the sidebar while focused |

There is no fullscreen attach and no collapsed spine. The companion, the PR sessions, the overseer and the main session are never
attached to from the TUI — the board's PR pane and this column are the only
terminals, both embedded.
