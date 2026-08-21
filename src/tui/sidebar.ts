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
import { ACCENT, ACCENT_BG, BAD, MUTED, OK, RESET, SEP, WARN } from "./design.js";
import { displayWidth, fit } from "./paint.js";
import { keysToTmux, SCROLL_STEP, splitCapture } from "./pipane.js";

/** Content columns of the expanded sidebar (border excluded). */
export const SIDEBAR_COLS = 44;
/** Below this many TOTAL terminal columns the sidebar auto-collapses: the
 * board's list/detail split stops being legible before the sidebar does. */
export const SIDEBAR_MIN_COLS = 110;
/** Left divider + right border — the two cells the column adds beyond content. */
export const SIDEBAR_BORDER = 2;

/** The collapsed spine: border + one glyph column. */
export const SIDEBAR_SPINE = 3;
/** Below this the spine goes too — at that width the board itself is unusable
 * and three stolen columns are three columns the list cannot spare. */
export const SIDEBAR_HIDE_BELOW = 40;

/** Total width the column occupies, 0 when hidden. */
export function sidebarWidth(cols: number, st: { collapsed: boolean; available: boolean }): number {
  if (!st.available) return 0;
  if (cols < SIDEBAR_HIDE_BELOW) return 0;
  if (st.collapsed || cols < SIDEBAR_MIN_COLS) return SIDEBAR_SPINE;
  return SIDEBAR_COLS + SIDEBAR_BORDER;
}

export interface SidebarHeader {
  up: boolean; // container running
  piUp: boolean; // the companion pi session is alive
  day: string; // Warsaw day token, e.g. "2026-08-21"
  lastWake: string; // "3m ago" | "—"
  memory: "ok" | "degraded" | "off";
}

export interface SidebarView {
  header: SidebarHeader;
  /** Mirror lines, oldest first, SGR-styled (keepSgrOnly already applied). */
  lines: string[];
  focused: boolean;
  collapsed: boolean;
  available: boolean;
  /** Lines above the live tail; 0 = following. */
  offset: number;
  /** Newest alerts, newest last; rendered inline under the mirror. */
  alerts: Array<{ tier: "notice" | "alert"; title: string; ts: string }>;
}

export const SIDEBAR_PLACEHOLDER = "ask the companion — ⏎ sends";
export const SIDEBAR_OFF = "companion off";

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

function headerRows(h: SidebarHeader): [string, string] {
  const dot = !h.up ? `${BAD}●${RESET}` : h.piUp ? `${OK}●${RESET}` : `${WARN}●${RESET}`;
  const name = h.up ? "companion" : `${MUTED}down${RESET}`;
  const mem =
    h.memory === "ok" ? `${OK}mem ok${RESET}` : h.memory === "degraded" ? `${WARN}mem degraded${RESET}` : `${MUTED}mem off${RESET}`;
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
  if (!view.available) return ` ${MUTED}${SIDEBAR_OFF}${RESET}`;
  if (view.focused) return ` ${ACCENT}▶${RESET} ${MUTED}keys go to pi · Ctrl-q releases${RESET}`;
  return ` ${MUTED}❯ ${SIDEBAR_PLACEHOLDER}${RESET}`;
}

function alertContent(a: SidebarView["alerts"][number]): string {
  const glyph = a.tier === "alert" ? `${BAD}▲${RESET}` : `${WARN}•${RESET}`;
  return ` ${glyph} ${a.title} ${MUTED}${a.ts}${RESET}`;
}

/** The collapsed spine: an attention dot when an alert is pending, then the
 * word "companion" running down the column as the affordance that says the
 * panel is there and clickable. */
function paintSpine(view: SidebarView, width: number, rows: number): string[] {
  const inner = width - SIDEBAR_BORDER;
  const out: string[] = [`┬${"─".repeat(Math.max(0, inner))}┐`];
  const spine = Math.max(0, rows - 2);
  const cells = new Array<string>(spine).fill(" ");
  let start = 0;
  if (view.alerts.length > 0 && spine > 0) {
    cells[0] = `${BAD}●${RESET}`;
    start = 1;
  }
  const word = [..."companion"];
  const room = spine - start;
  const n = Math.max(0, Math.min(word.length, room));
  const top = start + Math.floor((room - n) / 2);
  const style = view.focused ? ACCENT : MUTED;
  for (let i = 0; i < n; i++) cells[top + i] = `${style}${word[i]}${RESET}`;
  for (const c of cells) out.push(bodyRow(c, inner));
  if (rows >= 2) out.push(`┴${"─".repeat(Math.max(0, inner))}┘`);
  return out.slice(0, rows);
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
export function paintSidebar(view: SidebarView, width: number, rows: number): string[] {
  if (rows <= 0) return [];
  if (width <= 0) return new Array<string>(rows).fill("");
  const inner = width - SIDEBAR_BORDER;
  if (view.collapsed || inner < 1) return paintSpine(view, width, rows);
  if (rows === 1) return [`┬${"─".repeat(inner)}┐`];

  // Row budget: header and input are claimed first; the divider and the alerts
  // block only take a row if a mirror row still survives underneath them.
  let left = rows - 2;
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
  const mirrorRows = Math.max(0, left);

  const out: string[] = [`┬${"─".repeat(inner)}┐`];
  const hdr = headerRows(view.header);
  for (let i = 0; i < head; i++) out.push(bodyRow(hdr[i] ?? "", inner));
  if (divider === 1) {
    const label = view.offset > 0 ? `${ACCENT}↑${view.offset}${RESET}` : `${view.focused ? ACCENT : MUTED}session${RESET}`;
    out.push(dividerRow(label, inner));
  }

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
 * (the same convention as barHitKey). The top border is the collapse
 * affordance — it is the one sidebar row with nothing else to say, and a click
 * on the spine expands again.
 */
export function sidebarHit(
  x: number,
  y: number,
  cols: number,
  rows: number,
  width: number,
): "input" | "mirror" | "header" | "collapse" | undefined {
  if (width <= 0) return undefined;
  if (x <= cols - width || x > cols) return undefined;
  if (y < 1 || y > rows) return undefined;
  if (width <= SIDEBAR_SPINE) return "collapse";
  if (y === 1) return "collapse";
  if (y === rows) return undefined; // bottom border
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
  collapsed = false;
  offset = 0;
  alerts: SidebarView["alerts"] = [];

  private captureOk = false;
  private patch: Partial<SidebarHeader> = {};
  private timer: NodeJS.Timeout | undefined;
  private fastUntil = 0;

  constructor(
    private readonly cfg: Pick<CompanionConfig, "container_name" | "session">,
    private readonly docker: DockerRunner,
    private readonly opts: { available?: () => boolean; onUpdate?: () => void; now?: () => number } = {},
  ) {}

  available(): boolean {
    return this.opts.available?.() ?? true;
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
      collapsed: this.collapsed,
      available,
      offset: this.offset,
      alerts: this.alerts,
    };
  }

  /** Capture the pane WITH its colors (`-e`) and joined wrapped lines (`-J`). */
  async refresh(): Promise<void> {
    if (!this.available()) return;
    const argv = ["exec", this.cfg.container_name, "tmux", "capture-pane", "-e", "-p", "-J"];
    // Parked in scrollback: ask for history above the window, as pipane does.
    if (this.offset > 0) argv.push("-S", `-${this.offset + SCROLL_PAD}`);
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
    this.lines = splitCapture(res.stdout);
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

  toggleCollapse(): void {
    this.collapsed = !this.collapsed;
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
    const res = await this.docker(["exec", this.cfg.container_name, "tmux", "send-keys", "-t", this.cfg.session, ...args], {
      timeoutMs: 5_000,
    });
    if (!res.ok) throw new Error(`companion send failed: ${res.stderr.trim() || `exit ${res.code}`}`);
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
