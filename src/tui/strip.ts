// Companion strip — the companion is chrome, not a tab: a fixed
// strip above the two-row command bar on EVERY tab. A labelled divider +
// session-tail mirror + one input row; short terminals collapse to the input
// row alone; a down companion collapses to one inert row.
//
// Frame geometry (0-based frame rows, shared with every renderer):
//   content ends at rows-11 (collapsed: rows-5)
//   strip rows rows-10..rows-4 (collapsed: the input row alone at rows-4)
//   command bar rows-3..rows-2, bottom border rows-1
import type { CompanionConfig } from "../config.js";
import type { DockerRunner } from "./companion.js";
import { ACCENT, ACCENT_BG, MUTED, RESET } from "./design.js";
import { Frame, rule, sanitizeText, truncate } from "./paint.js";

/** Full strip height: mirror area + input row, or the input row alone when
 * the terminal is too short for the mirror to earn its space. */
export function STRIP_ROWS(rows: number): number {
  return rows < 32 ? 1 : 7;
}

/** What the frame actually reserves: a down companion is one row, always. */
export function stripHeight(rows: number, available: boolean): number {
  return available ? STRIP_ROWS(rows) : 1;
}

/** Immutable paint/routing snapshot — renderers take this, never the class. */
export interface StripView {
  mirror: string[];
  input: string;
  focused: boolean;
  available: boolean;
}

export const STRIP_PLACEHOLDER = "ask the companion — just type, ⏎ sends";

/** Draft text is ONE line: CR/LF/tab from a paste would break the frame's
 * row discipline (and tmux send-keys would submit mid-paste). */
export function stripInputText(s: string): string {
  return s.replace(/[\r\n\t]/g, "");
}
export const STRIP_OFF = "companion off";

function inputRow(view: StripView): string {
  if (!view.available) return `${MUTED}${STRIP_OFF}${RESET}`;
  if (!view.focused && view.input.length === 0) return `${MUTED}❯ ${STRIP_PLACEHOLDER}${RESET}`;
  const cursor = view.focused ? `${ACCENT_BG} ${RESET}` : "";
  return `${ACCENT}❯ ${RESET}${view.input}${cursor}`;
}

/** Mirror lines the expanded strip shows (the labelled divider is the 6th). */
const MIRROR_LINES = 5;

/** Paints the strip rows onto an already-built frame (boxed, cmdbar style). */
export function paintStrip(frame: Frame, view: StripView, cols: number, rows: number): void {
  const h = stripHeight(rows, view.available);
  frame.boxRow(rows - 4, [{ text: ` ${inputRow(view)}`, width: cols - 2 }]);
  if (h === 1) return;
  frame.set(rows - 10, rule(cols, "├", "┤", [view.focused ? `${ACCENT}companion${RESET}` : `${MUTED}companion${RESET}`]));
  const tail = view.mirror.slice(-MIRROR_LINES);
  const pad = MIRROR_LINES - tail.length;
  for (let i = 0; i < MIRROR_LINES; i++) {
    const line = i < pad ? "" : (tail[i - pad] ?? "");
    frame.boxRow(rows - 9 + i, [{ text: ` ${truncate(line, cols - 4)}`, width: cols - 2 }]);
  }
}

/**
 * 1-based terminal click → what the strip does with it. Frame row r paints at
 * terminal y=r+1 (same convention as barHitKey): the input row answers at
 * y=rows-3, the mirror area (divider included) at y=rows-9..rows-4.
 */
export function stripHit(x: number, y: number, cols: number, rows: number, stripRows: number = STRIP_ROWS(rows)): "input" | "mirror" | undefined {
  if (x < 1 || x > cols) return undefined;
  if (y === rows - 3) return "input";
  if (stripRows === 7 && y >= rows - 9 && y <= rows - 4) return "mirror";
  return undefined;
}

/** How long after a send the fast poll keeps running (echo catches up). */
const SEND_FAST_MS = 5_000;
/** Focused/fresh-send capture cadence — the board pi pane's focus-poll twin. */
const FAST_POLL_MS = 500;
/** Mirror bound; the strip only ever paints the last few lines. */
const MAX_MIRROR_LINES = 50;

/**
 * The strip's state + I/O: mirrors the companion pane through the same local
 * DockerRunner seam CompanionLifecycle uses, and types into it with
 * `tmux send-keys` (literal text, then Enter — never shell interpolation).
 */
export class CompanionStrip {
  mirror: string[] = [];
  input = "";
  focused = false;

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

  view(): StripView {
    return { mirror: this.mirror, input: this.input, focused: this.focused, available: this.available() };
  }

  /** Capture the pane tail (plain text — the strip paints it undecorated). */
  async refresh(): Promise<void> {
    if (!this.available()) return;
    const res = await this.docker(["exec", this.cfg.container_name, "tmux", "capture-pane", "-p", "-t", this.cfg.session], { timeoutMs: 5_000 });
    if (!res.ok) return; // keep the last good mirror — the poller retries
    const lines = res.stdout.split("\n").map((l) => sanitizeText(l).trimEnd());
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    this.mirror = lines.slice(-MAX_MIRROR_LINES);
    this.opts.onUpdate?.();
  }

  /** Literal text (`send-keys -l`) then Enter — two invocations, because `-l`
   * is a flag of the command and Enter must arrive as a named key. */
  async send(text: string): Promise<void> {
    const lit = await this.docker(["exec", this.cfg.container_name, "tmux", "send-keys", "-t", this.cfg.session, "-l", "--", text], { timeoutMs: 5_000 });
    if (!lit.ok) throw new Error(`companion send failed: ${lit.stderr.trim() || `exit ${lit.code}`}`);
    const enter = await this.docker(["exec", this.cfg.container_name, "tmux", "send-keys", "-t", this.cfg.session, "Enter"], { timeoutMs: 5_000 });
    if (!enter.ok) throw new Error(`companion send failed: ${enter.stderr.trim() || `exit ${enter.code}`}`);
    this.fastUntil = this.now() + SEND_FAST_MS;
    this.ensureTimer();
    void this.refresh();
  }

  /** Take the keyboard (optionally seeded with the char that focused us). */
  focus(seed = ""): void {
    if (!this.available()) return;
    this.focused = true;
    this.input += stripInputText(seed);
    void this.refresh();
    this.ensureTimer();
  }

  /** Drop focus and the draft (Esc, or a send). */
  blur(): void {
    this.focused = false;
    this.input = "";
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
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
