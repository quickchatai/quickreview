// Companion sidebar — the companion is an always-visible right
// COLUMN, not a strip above the command bar. It replaces `strip.ts`: the strip
// bought five mirror lines by stealing seven rows from every tab, and a mirror
// that narrow could not carry a conversation. A column pays once, vertically,
// and the tab keeps its full height.
//
// Geometry (the binding half of docs/sidebar-contract.md): the sidebar owns its
// own LEFT border, so the inner tab Frame keeps its right border and the two
// simply concatenate — `cols = inner.cols + sidebarWidth(cols, state)`. Row 0
// and row `rows-1` carry the junction glyphs that continue the inner frame's
// top and bottom rules; the compositor never patches corners.
//
// Capture is `-e` (SGR kept — the whole point of the restyle: the mirror shows
// pi's own colors) and `-J`, through the same local DockerRunner seam the
// lifecycle uses. Input goes back as `tmux send-keys`, never a shell string.
//
// THE COLUMN IS A TERMINAL (root CLAUDE.md). While focused, EVERY
// byte goes to pi — `/` commands and their menu, completion, history,
// multi-line editing, Ctrl-C to interrupt a turn are all pi's, and running it
// under tmux is pointless if the bytes stop here. `Ctrl-q` is the only
// reserved one; it releases focus.
//
// There is deliberately NO draft/input field on this class or its view. One
// shipped in and it was the bug: a second, worse input box in front of
// the real one, which the mirror was already showing. If you are about to add
// `input: string` back, you are re-introducing it — the quick-message box
// (msg.ts) is the thing you actually want, and it is for sessions you are NOT
// focused on.
import type { CompanionConfig } from "../config.js";
import type { DockerRunner } from "./companion.js";
import { ACCENT, BAD, MUTED, OK, RESET, SEP, WARN } from "./design.js";
import { displayWidth, fit } from "./paint.js";
import { clampScrollback, keysToTmux, SCROLL_STEP, splitCapture } from "./pipane.js";

/** Left divider + right border — the two cells the column adds beyond content. */
export const SIDEBAR_BORDER = 2;
/** Smallest useful expanded column, borders included. */
export const SIDEBAR_MIN_WIDTH = 24;
/** Width reserved for the tab beside the sidebar. */
export const SIDEBAR_MIN_INNER_COLS = 64;
/** The legacy fixed default. Hot reload used to serialize this as a user
 * preference, so one reload could pin the narrow width forever. */
export const LEGACY_SIDEBAR_WIDTH = 46;

/** Clamp a drag request while guaranteeing usable space for the tab. */
export function clampSidebarWidth(cols: number, requested: number): number {
  const max = Math.max(SIDEBAR_MIN_WIDTH, cols - SIDEBAR_MIN_INNER_COLS);
  return Math.min(max, Math.max(SIDEBAR_MIN_WIDTH, Math.round(requested)));
}

/** The conversation is a first-class half of the screen, not a 44-column
 * status rail. The clamp gives the tab its guaranteed 64 columns. */
export function defaultSidebarWidth(cols: number): number {
  return clampSidebarWidth(cols, Math.floor(cols / 2));
}

/** A width emitted by the old hot-reload snapshot was not a real operator
 * choice. Drop it so the first reload after this fix adopts the new default. */
export function restorePreferredSidebarWidth(width: number | undefined): number | undefined {
  return width === LEGACY_SIDEBAR_WIDTH ? undefined : width;
}

/**
 * Total width the column occupies — ALWAYS its full width (2026-09-02, the
 * owner's fixed-layout order). There is no collapsed spine, no auto-collapse
 * on a narrow terminal and no hidden state: the layout is the tab on the left
 * and the companion on the right, whatever the terminal width, whatever the
 * config, whatever docker says. On a terminal too narrow for both minimums the
 * clamp keeps the column at its minimum and the tab takes the rest — a
 * cramped tab is an honest rendering of a cramped terminal; a column that
 * folds away is a layout change, which is the thing forbidden.
 */
export function sidebarWidth(cols: number, st: { preferredWidth?: number } = {}): number {
  return clampSidebarWidth(cols, st.preferredWidth ?? defaultSidebarWidth(cols));
}

/** The panel's left border is its resize handle. */
export function sidebarResizeHit(x: number, cols: number, width: number): boolean {
  return width > 0 && x === cols - width + 1;
}

export interface SidebarHeader {
  up: boolean; // container running
  piUp: boolean; // the companion pi session is alive
  day: string; // ops-day token, e.g. "2026-08-21"
  lastWake: string; // "3m ago" | "—"
  memory: "ok" | "degraded" | "off";
}

export interface SidebarView {
  header: SidebarHeader;
  /** Mirror lines, oldest first, SGR-styled (keepSgrOnly already applied). */
  lines: string[];
  focused: boolean;
  available: boolean;
  /** The companion is OFF by configuration (`--no-companion`, `[companion]
   * enabled = false`), with the reason. The column is on screen regardless
   * (2026-09-02) — this is what it says instead of "starting up". */
  off?: string;
  /** Lines above the live tail; 0 = following. */
  offset: number;
  /** Newest alerts, newest last; rendered inline under the mirror. */
  alerts: Array<{ tier: "notice" | "alert"; title: string; ts: string }>;
  /**: bring-up progress, painted in the mirror's space while the mirror
   * is still empty. The column is on screen from the first frame (its width is
   * config-derived), so this is where startup reports — never the normal
   * screen, whose lines the alt screen then erased. Optional so a bare test
   * harness (and any legacy caller) still paints a plain mirror. */
  startup?: string[];
  /** The mirror has carried content at least once in this session. Once true
   * the bring-up checklist NEVER comes back, however empty a capture is.
   *
   * Without this the column silently rewinds: `showStartup` keys on an empty
   * mirror, and an empty capture is a NORMAL event — the day-rollover kills
   * and respawns pi on purpose — so hours later the column would flip back to
   * a frozen checklist from boot, with the hint row reading "starting up". */
  mirrored?: boolean;
}

export const SIDEBAR_PLACEHOLDER = "ask the companion — ⏎ sends";
export const SIDEBAR_OFF = "companion off";
/** Shown while the bring-up is still running. */
export const SIDEBAR_STARTING = "starting up — progress above";

/** Draft text is ONE line: CR/LF/tab from a paste would break the row
 * discipline (and tmux send-keys would submit mid-paste). */
export function sidebarInputText(s: string): string {
  return s.replace(/[\r\n\t]/g, "");
}

/** At most this many alerts ride under the mirror; older ones scroll off. */
const MAX_ALERTS = 3;

/** One bordered body row. The trailing RESET matters: mirror lines arrive with
 * live SGR state and would otherwise bleed styling onto the right border. */
function bodyRow(content: string, inner: number): string {
  return `│${fit(content, inner)}${RESET}│`;
}

function headerRows(h: SidebarHeader, off: string | undefined): [string, string] {
  const dot =
    off !== undefined
      ? `${MUTED}●${RESET}`
      : !h.up
        ? `${BAD}●${RESET}`
        : h.piUp
          ? `${OK}●${RESET}`
          : `${WARN}●${RESET}`;
  const name =
    off !== undefined
      ? `${MUTED}companion off${RESET}`
      : h.up
        ? "companion"
        : `${MUTED}down${RESET}`;
  const mem =
    h.memory === "ok"
      ? `${OK}mem ok${RESET}`
      : h.memory === "degraded"
        ? `${WARN}mem degraded${RESET}`
        : `${MUTED}mem off${RESET}`;
  const day = h.day.length > 0 ? `${SEP}${MUTED}${h.day}${RESET}` : "";
  const pi = h.up && !h.piUp ? `${SEP}${BAD}pi down${RESET}` : "";
  return [` ${dot} ${name}${day}${SEP}${mem}`, ` ${MUTED}last wake${RESET} ${h.lastWake}${pi}`];
}

/** `─ label ────` divider, drawn inside the sidebar's own borders (so it starts
 * and ends with `│`, never a `├`/`┤` that would imply a frame-wide rule). */
function dividerRow(label: string, inner: number): string {
  const lead = `${MUTED}─${RESET} ${label} `;
  const fill = Math.max(0, inner - displayWidth(lead));
  return bodyRow(`${lead}${MUTED}${"─".repeat(fill)}${RESET}`, inner);
}

/**
 * The bottom row is a HINT, never an editor.
 *
 * pi's own input line — with its `/` commands, its completion menu, its
 * history — is already on screen: it is part of the mirror. A second input
 * box in the TUI would be a strictly worse copy of it, which is exactly the
 * regression this row's shape prevents. Focused, the row says where the keys
 * are going; unfocused, it says how to get there. Its height never changes,
 * so taking focus cannot shift the layout.
 */
function hintContent(view: SidebarView): string {
  // Starting is not "off": while the bring-up is still running the column is on
  // screen at its real width with the progress in it, and saying "companion
  // off" there would be the same class of lie as a DRY-RUN badge with no
  // heartbeat behind it.
  if (view.off !== undefined) return ` ${MUTED}${SIDEBAR_OFF} — ${view.off}${RESET}`;
  if (!view.available) {
    const starting = (view.startup ?? []).length > 0 && view.mirrored !== true;
    return ` ${MUTED}${starting ? SIDEBAR_STARTING : SIDEBAR_OFF}${RESET}`;
  }
  if (view.focused) return ` ${ACCENT}▶${RESET} ${MUTED}keys go to pi · Ctrl-q releases${RESET}`;
  return ` ${MUTED}❯ ${SIDEBAR_PLACEHOLDER} · drag left edge${RESET}`;
}

function alertContent(a: SidebarView["alerts"][number]): string {
  const glyph = a.tier === "alert" ? `${BAD}▲${RESET}` : `${WARN}•${RESET}`;
  return ` ${glyph} ${a.title} ${MUTED}${a.ts}${RESET}`;
}

/**
 * Exactly `rows` strings of display width `width`. Pure.
 *
 * Layout top→bottom: junction border, a two-row status header, a divider, the
 * mirror (the bulk), an alerts block when there are alerts, the input row, and
 * the bottom junction border. A short terminal sheds those in a fixed order —
 * alerts first, then the divider, then the second header row — so the mirror
 * and the input row are the last things to go.
 */
interface SidebarRowLayout {
  inputRows: number;
  head: number;
  divider: number;
  alertN: number;
  mirrorRows: number;
}

/** One source of truth for both painting and the tmux viewport. If these row
 * budgets drift, pi lays itself out for a terminal different from the space in
 * which its capture is rendered. */
function sidebarRowLayout(view: SidebarView, rows: number): SidebarRowLayout {
  let left = Math.max(0, rows - 2); // top + bottom borders
  const inputRows = Math.min(1, left);
  left -= inputRows;
  const head = Math.min(2, left);
  left -= head;
  const divider = left > 1 ? 1 : 0;
  left -= divider;
  let alertN = 0;
  if (view.alerts.length > 0 && left >= 3) {
    alertN = Math.min(MAX_ALERTS, view.alerts.length, left - 2);
    left -= alertN + 1; // + the alerts divider
  }
  return { inputRows, head, divider, alertN, mirrorRows: Math.max(0, left) };
}

/** Exact terminal geometry pi gets inside tmux. The mirror adds one visual
 * leading space inside the two sidebar borders, so that cell is not available
 * to pi itself. */
export function sidebarPaneSize(
  view: SidebarView,
  width: number,
  rows: number,
): { cols: number; rows: number } | undefined {
  if (!view.available || width <= SIDEBAR_BORDER || rows <= 0) return undefined;
  const layout = sidebarRowLayout(view, rows);
  return {
    cols: Math.max(1, width - SIDEBAR_BORDER - 1),
    rows: Math.max(1, layout.mirrorRows),
  };
}

export function paintSidebar(view: SidebarView, width: number, rows: number): string[] {
  if (rows <= 0) return [];
  if (width <= 0) return new Array<string>(rows).fill("");
  const inner = width - SIDEBAR_BORDER;
  // Narrower than its own two borders cannot happen through sidebarWidth
  // (the clamp floors at SIDEBAR_MIN_WIDTH); a direct caller gets blank cells
  // of the right width rather than a panel folded into a spine.
  if (inner < 1) return new Array<string>(rows).fill(fit("", width));
  if (rows === 1) return [`┬${"─".repeat(inner)}┐`];

  // Row budget is shared with sidebarPaneSize: tmux receives exactly the
  // rectangle the capture occupies, not its detached-session 80×24 default.
  const { inputRows, head, divider, alertN, mirrorRows } = sidebarRowLayout(view, rows);

  const out: string[] = [`┬${"─".repeat(inner)}┐`];
  const hdr = headerRows(view.header, view.off);
  for (let i = 0; i < head; i++) out.push(bodyRow(hdr[i] ?? "", inner));
  // No mirror yet and a bring-up in flight: the space belongs to the progress.
  // The moment pi's capture arrives the mirror takes it back, with no layout
  // change — the region is the same rectangle either way.
  const startup = view.startup ?? [];
  const showStartup = view.lines.length === 0 && startup.length > 0 && view.mirrored !== true;
  if (divider === 1) {
    const label = showStartup
      ? `${MUTED}starting${RESET}`
      : view.offset > 0
        ? `${ACCENT}↑${view.offset}${RESET}`
        : `${view.focused ? ACCENT : MUTED}session${RESET}`;
    out.push(dividerRow(label, inner));
  }

  if (showStartup) {
    // TOP-anchored, unlike the mirror: this is a checklist read downwards, not
    // a terminal tail.
    for (let i = 0; i < mirrorRows; i++) {
      const line = startup[i];
      out.push(bodyRow(line !== undefined ? ` ${line}` : "", inner));
    }
  } else {
    // Scrollback: `offset` lines above the live tail, then the last `mirrorRows`.
    const end = Math.max(0, view.lines.length - view.offset);
    const tail = view.lines.slice(Math.max(0, end - mirrorRows), end);
    const pad = mirrorRows - tail.length;
    for (let i = 0; i < mirrorRows; i++) {
      const line = i < pad ? "" : (tail[i - pad] ?? "");
      // `fit` (via truncate) is ANSI-aware: escapes are zero-width and never cut
      // mid-sequence, so a styled mirror line keeps its exact cell count.
      out.push(bodyRow(line.length > 0 ? ` ${line}` : "", inner));
    }
  }

  if (alertN > 0) {
    out.push(dividerRow(`${MUTED}alerts${RESET}`, inner));
    for (const a of view.alerts.slice(-alertN)) out.push(bodyRow(alertContent(a), inner));
  }
  if (inputRows === 1) out.push(bodyRow(hintContent(view), inner));
  out.push(`┴${"─".repeat(inner)}┘`);
  return out.slice(0, rows);
}

/**
 * 1-based terminal click → what the sidebar does with it. The column occupies
 * terminal columns `cols-width+1 … cols`; terminal y=r+1 paints frame row r
 * (the same convention as barHitKey). Both borders are inert chrome — the
 * top one used to be the collapse affordance until the collapse was retired
 * (2026-09-02); the left seam's DRAG is handled before this, by
 * `sidebarResizeHit`.
 */
export function sidebarHit(
  x: number,
  y: number,
  cols: number,
  rows: number,
  width: number,
): "input" | "mirror" | "header" | undefined {
  if (width <= 0) return undefined;
  if (x <= cols - width || x > cols) return undefined;
  if (y < 1 || y > rows) return undefined;
  if (y === 1 || y === rows) return undefined; // top / bottom border
  if (y === rows - 1) return "input";
  if (y === 2 || y === 3) return "header";
  return "mirror";
}

/** How long after a send the fast poll keeps running (echo catches up). */
const SEND_FAST_MS = 5_000;
/** Focused/fresh-send capture cadence — the board pi pane's focus-poll twin. */
const FAST_POLL_MS = 500;
/** Extra history a scrolled capture asks for beyond the offset itself, so the
 * area above the parked window is filled rather than blank (pipane's twin). */
const SCROLL_PAD = 200;

/**
 * The sidebar's state + I/O. Same discipline as the retired CompanionStrip: a
 * failed capture KEEPS the last good mirror (a transient docker hiccup must not
 * blank the panel), the fast poll runs only while focused or just after a send
 * and stops itself, and its timer is unref'd so it never holds the process up.
 *
 * The header fields the daemon owns (day, memory state, last wake) are pushed
 * in by the orchestrator through `setHeader`; `up`/`piUp` derive from
 * `available()` and the last capture unless explicitly set.
 */
export class CompanionSidebar {
  lines: string[] = [];
  focused = false;
  /** Explicit width including both borders. Undefined means the responsive
   * half-screen default; only a real seam drag sets this. */
  preferredWidth: number | undefined;
  offset = 0;
  alerts: SidebarView["alerts"] = [];
  /**: bring-up progress lines, shown until the mirror has content. */
  startup: string[] = [];
  /** Set once by the orchestrator when the companion is off by configuration. */
  private off: string | undefined;

  private captureOk = false;
  /** The mirror has held content at least once — see SidebarView.mirrored. */
  private mirrored = false;
  private patch: Partial<SidebarHeader> = {};
  private timer: NodeJS.Timeout | undefined;
  private fastUntil = 0;
  /** Set by App.repaint from the actual terminal geometry. */
  private paneSize: { cols: number; rows: number } | undefined;

  constructor(
    private readonly cfg: Pick<CompanionConfig, "container_name" | "session">,
    private readonly docker: DockerRunner,
    private readonly opts: {
      available?: () => boolean;
      onUpdate?: () => void;
      now?: () => number;
    } = {},
  ) {}

  /** The companion is up and can take keystrokes. */
  available(): boolean {
    return this.opts.available?.() ?? true;
  }

  // There is no `shown()` / `enabled` any more (2026-09-02). The column is
  // part of the layout unconditionally — `--no-companion` and `[companion]
  // enabled = false` decide what RUNS (no container, no feed, no alerts) and
  // what the column SAYS ("companion off"), never whether it is there. That
  // closes the layout-jump objection for good: geometry depends on
  // nothing that can arrive late, because it depends on nothing at all but
  // the terminal width and the operator's own seam drag.

  /** Replace the bring-up progress lines (pure state; the App repaints). */
  setStartup(lines: string[]): void {
    this.startup = lines;
  }

  /** The companion is off by configuration; `reason` is what the column
   * says (`--no-companion`, `[companion] enabled = false`). The column keeps
   * its width and its bring-up lines — only its story changes. */
  setOff(reason: string): void {
    this.off = reason;
  }

  /** Push the header facts only the orchestrator knows (day, memory, wake). */
  setHeader(patch: Partial<SidebarHeader>): void {
    this.patch = { ...this.patch, ...patch };
  }

  /** Newest last; the paint keeps only the last few. */
  setAlerts(alerts: SidebarView["alerts"]): void {
    this.alerts = alerts;
  }

  view(): SidebarView {
    const available = this.available();
    return {
      header: {
        up: this.patch.up ?? available,
        piUp: this.patch.piUp ?? this.captureOk,
        day: this.patch.day ?? "",
        lastWake: this.patch.lastWake ?? "—",
        memory: this.patch.memory ?? "off",
      },
      lines: this.lines,
      focused: this.focused,
      available,
      ...(this.off !== undefined ? { off: this.off } : {}),
      offset: this.offset,
      alerts: this.alerts,
      startup: this.startup,
      mirrored: this.mirrored,
    };
  }

  /** Receive the expanded sidebar's real painted geometry. This is pure state:
   * refresh folds resize-window + capture-pane into one docker round trip. */
  setViewport(width: number, rows: number): void {
    const next = sidebarPaneSize(this.view(), width, rows);
    if (next) this.paneSize = next;
  }

  /** Resize tmux to the mirror rectangle, then capture it WITH its colors (`-e`)
   * and joined wrapped lines (`-J`). Detached tmux otherwise stays 80×24 no
   * matter how large the sidebar becomes. Both commands share one invocation,
   * so capture can never race an asynchronous resize. */
  async refresh(): Promise<void> {
    if (!this.available()) return;
    const offset = this.offset;
    const argv = ["exec", this.cfg.container_name, "tmux"];
    if (this.paneSize) {
      argv.push(
        "resize-window",
        "-t",
        this.cfg.session,
        "-x",
        String(this.paneSize.cols),
        "-y",
        String(this.paneSize.rows),
        ";",
      );
    }
    argv.push("capture-pane", "-e", "-p", "-J");
    // Parked in scrollback: ask for history above the window, as pipane does.
    if (offset > 0) argv.push("-S", `-${offset + SCROLL_PAD}`);
    argv.push("-t", this.cfg.session);
    const res = await this.docker(argv, { timeoutMs: 5_000 });
    if (!res.ok) {
      // Keep the last good mirror — the poller retries; a blank panel would
      // read as "the companion died" on every transient docker stall.
      this.captureOk = false;
      this.opts.onUpdate?.();
      return;
    }
    this.captureOk = true;
    this.lines = splitCapture(res.stdout, offset);
    // Same rule as pipane: clamp only an offset this capture actually answers.
    if (this.offset === offset)
      this.offset = clampScrollback(offset, this.lines.length, this.paneSize?.rows);
    // One-way latch: from the first capture that actually said something, this
    // column is the companion's mirror and never the bring-up checklist again.
    if (!this.mirrored && this.lines.some((l) => l.trim() !== "")) this.mirrored = true;
    this.opts.onUpdate?.();
  }

  /** Literal text (`send-keys -l`) then Enter — two invocations, because `-l`
   * is a flag of the command and Enter must arrive as a named key. */
  async send(text: string): Promise<void> {
    await this.tmux(["-l", "--", sidebarInputText(text)]);
    await this.tmux(["Enter"]);
    this.offset = 0; // a send always returns the mirror to the live tail
    this.afterWrite();
  }

  /** Raw stdin passthrough while focused (pipane's keysToTmux grouping). */
  async sendKeys(buf: Buffer): Promise<void> {
    const groups = keysToTmux(buf);
    if (groups.length === 0) return;
    for (const g of groups) await this.tmux(g);
    this.offset = 0;
    this.afterWrite();
  }

  /** Take the keyboard (optionally seeded with the char that focused us). */
  focus(seed = ""): void {
    if (!this.available()) return;
    this.focused = true;
    // A seed is the character that focused us from elsewhere on the board. It
    // goes STRAIGHT to pi, so it lands in pi's own input line rather than in a
    // TUI-side buffer that pi knows nothing about. Focus is synchronous, so a
    // failed fire-and-forget send must be absorbed here rather than becoming
    // an unhandled rejection; the simultaneous refresh marks the pane down.
    if (seed.length > 0) {
      void this.sendKeys(Buffer.from(seed, "utf8")).catch(() => {
        this.captureOk = false;
        this.opts.onUpdate?.();
      });
    }
    void this.refresh();
    this.ensureTimer();
  }

  /** Hand the keyboard back to the board. */
  blur(): void {
    this.focused = false;
  }

  /** Resize from the seam's 1-based terminal x coordinate. */
  resizeFromPointer(cols: number, x: number): number {
    this.preferredWidth = clampSidebarWidth(cols, cols - x + 1);
    this.opts.onUpdate?.();
    return this.preferredWidth;
  }

  /** Wheel: move the scrollback window by `notches × SCROLL_STEP` lines.
   * Positive = further back in history; clamped at the live tail. */
  scroll(notches: number): void {
    const next = Math.max(0, this.offset + notches * SCROLL_STEP);
    if (next === this.offset) return;
    this.offset = next;
    void this.refresh();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async tmux(args: string[]): Promise<void> {
    const res = await this.docker(
      ["exec", this.cfg.container_name, "tmux", "send-keys", "-t", this.cfg.session, ...args],
      {
        timeoutMs: 5_000,
      },
    );
    if (!res.ok)
      throw new Error(`companion send failed: ${res.stderr.trim() || `exit ${res.code}`}`);
  }

  private afterWrite(): void {
    this.fastUntil = this.now() + SEND_FAST_MS;
    this.ensureTimer();
    void this.refresh();
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** Fast poll ONLY while focused or shortly after a send; self-stopping. */
  private ensureTimer(): void {
    if (this.timer) return;
    const t = setInterval(() => {
      if (!this.focused && this.now() > this.fastUntil) {
        clearInterval(t);
        this.timer = undefined;
        return;
      }
      void this.refresh();
    }, FAST_POLL_MS);
    t.unref?.();
    this.timer = t;
  }
}
