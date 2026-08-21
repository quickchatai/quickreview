// Live pi pane (the board's lower region). The 2026-08-14 grill verdict: the
// EVENTS strip was wasted space and the half-empty bottom of the board should
// show what the selected PR's pi session is doing *right now*.
//
// Since the 2026-08-14 "integral part, not a window" pass it is not a
// photograph either: the pane is an embedded terminal. Output comes from
// `tmux capture-pane -e -p -J` inside the container (poll tick, ~400ms while
// focused, ~300ms after the selection moves); input goes back the other way as
// `tmux send-keys` (see `keysToTmux` + `sendKeysArgv`). The full-screen
// AttachScreen still exists — it is just no longer the only way to type.
import type { TuiConfig } from "../config.js";
import { closeSgr } from "./paint.js";
import { captureArgv, type SshRunner } from "./remote.js";

/**
 * Keep SGR (color/style) escapes, drop everything else.
 *
 * `capture-pane -e` re-emits the pane's colors, but a pane can also carry
 * cursor-movement, erase, scroll-region and OSC sequences. Painting those into
 * our frame would rehome the cursor and shred the board border, so they go.
 * `paint.sanitizeText` is the wrong tool here — it strips *all* escapes, which
 * would throw away the colors that make the mirror readable.
 */
export function keepSgrOnly(line: string): string {
  const SEQ = /\x1b\[[0-9;:?<>!$"' ]*[A-Za-z@`{|}~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[ #%()*+][0-9A-Za-z]|\x1b[@-Z\\-_]/g;
  const kept = line
    .replace(SEQ, (m) => (/^\x1b\[[0-9;:]*m$/.test(m) ? m : ""))
    .replace(/\t/g, "  ")
    .replace(/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f-\x9f]/g, ""); // C0/C1 minus ESC (0x1b)
  // Close the row. A tmux pane row has no reason to end reset — 7 of 23 rows
  // of the live pr-5312 mirror ended with a background or foreground still
  // set — and an open attribute does not stop at the mirror's edge: it paints
  // the pane's padding, the board's right border and the companion column
  // beside it. That is the mirror "escaping" its box and colouring the sidebar
  // (reported 2026-08-21). `truncate` already closes the lines it CUTS; this
  // covers every line that fits, which is most of them.
  return closeSgr(kept);
}

/** What the board paints for one PR's session. */
export interface PiPaneView {
  pr: number;
  /** Captured pane lines, oldest first (the board shows the tail). */
  lines: string[];
  /** The last capture attempt failed — no such tmux session (or ssh died). */
  missing: boolean;
  /** `lines` come from an older successful capture (missing + cache hit). */
  stale: boolean;
  /** Scrollback: how many lines above the live tail the pane is parked.
   * 0 = following the bottom. The board drops this many lines off `lines`. */
  offset: number;
}

/** Keep the mirror bounded — the board only ever paints the tail. */
const MAX_LINES = 400;

/** Wheel notch = three lines, the usual terminal step. */
export const SCROLL_STEP = 3;

/** Extra history a scrolled capture asks for beyond the offset itself, so the
 * pane above the parked window is filled rather than blank. */
const SCROLL_PAD = 200;

/**
 * Per-PR capture cache with stale-while-revalidate semantics, mirroring the
 * detail cache in `App`: a cached capture paints instantly when the selection
 * comes back, and the refresh lands behind it.
 */
export class PiMirror {
  private readonly cache = new Map<number, string[]>();
  private readonly missing = new Set<number>();
  private readonly inFlight = new Set<number>();
  private readonly offsets = new Map<number, number>();
  private timer: NodeJS.Timeout | undefined;
  /** The board's painted mirror rectangle, fed in by `App.repaint`. Undefined
   * until the board has been painted once — the first capture then rides the
   * session's own size, exactly as it did before, rather than guessing one. */
  private paneSize: { cols: number; rows: number } | undefined;

  constructor(
    private readonly cfg: TuiConfig,
    private readonly ssh: SshRunner,
    private readonly onUpdate: () => void = () => {},
    private readonly debounceMs = 300,
  ) {}

  /** What the board should paint for `pr` right now (never throws, never waits). */
  view(pr: number | undefined): PiPaneView | undefined {
    if (pr === undefined) return undefined;
    const lines = this.cache.get(pr);
    const missing = this.missing.has(pr);
    return { pr, lines: lines ?? [], missing, stale: missing && (lines?.length ?? 0) > 0, offset: this.offsetFor(pr) };
  }

  /**
   * Receive the board's real painted mirror rectangle (`piPaneSize`).
   *
   * Pure state, deliberately: the next `fetch` folds `resize-window` into the
   * capture it was going to make anyway, so a terminal resize costs no extra
   * round trip and the two can never race. A degenerate rectangle (the pane
   * squeezed to nothing) is ignored rather than sent — tmux would refuse it,
   * and the last useful size is the better thing to keep.
   */
  setViewport(size: { cols: number; rows: number } | undefined): void {
    if (size && size.cols > 0 && size.rows > 0) this.paneSize = size;
  }

  /** How far back in scrollback the pane for `pr` is parked (0 = live tail). */
  offsetFor(pr: number | undefined): number {
    return pr === undefined ? 0 : (this.offsets.get(pr) ?? 0);
  }

  /** Park the pane `n` lines above the tail (clamped at 0 = live). */
  setOffset(pr: number, n: number): number {
    const next = Math.max(0, Math.floor(n));
    if (next === 0) this.offsets.delete(pr);
    else this.offsets.set(pr, next);
    return next;
  }

  /** Wheel: move the scrollback window by `notches × SCROLL_STEP` lines.
   * Positive = further back in history, negative = towards the live tail. */
  scroll(pr: number, notches: number): number {
    return this.setOffset(pr, this.offsetFor(pr) + notches * SCROLL_STEP);
  }

  /** Selection moved (j/k, click, wheel): debounce, then capture. Rapid
   * scrolling through the list must not fire an ssh per row. */
  select(pr: number | undefined): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (pr === undefined) return;
    const t = setTimeout(() => {
      this.timer = undefined;
      void this.fetch(pr);
    }, this.debounceMs);
    t.unref?.();
    this.timer = t;
  }

  /** Poll tick: refresh the visible pane now, no debounce. */
  async refresh(pr: number | undefined): Promise<void> {
    if (pr === undefined) return;
    await this.fetch(pr);
  }

  /** The debounced capture, exposed for tests that would rather not fake timers. */
  async fetch(pr: number): Promise<void> {
    if (this.inFlight.has(pr)) return;
    this.inFlight.add(pr);
    try {
      const offset = this.offsetFor(pr);
      // Live tail = the plain visible-pane capture; scrolled back = the same
      // capture with `-S -(offset + pad)` so there is history above the window.
      const range = offset > 0 ? { startBack: offset + SCROLL_PAD } : undefined;
      const res = await this.ssh(this.cfg.ssh_host, captureArgv(this.cfg, `pr-${pr}`, range, this.paneSize), { timeoutMs: 5_000 });
      if (!res.ok) {
        this.missing.add(pr);
      } else {
        this.missing.delete(pr);
        this.cache.set(pr, splitCapture(res.stdout));
      }
    } finally {
      this.inFlight.delete(pr);
    }
    this.onUpdate();
  }

  /** Drop a PR's mirror (session archived / round finished). */
  invalidate(pr: number): void {
    this.cache.delete(pr);
    this.missing.delete(pr);
    this.offsets.delete(pr);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

// ---- keyboard: raw stdin → tmux send-keys ----------------------------------

/** Escape sequences we can name for tmux. Longest-first matching. */
const SEQUENCES: Array<[string, string]> = [
  ["\x1b[1;5A", "C-Up"],
  ["\x1b[1;5B", "C-Down"],
  ["\x1b[1;5C", "C-Right"],
  ["\x1b[1;5D", "C-Left"],
  ["\x1b[5~", "PPage"],
  ["\x1b[6~", "NPage"],
  ["\x1b[3~", "DC"],
  ["\x1b[2~", "IC"],
  ["\x1b[1~", "Home"],
  ["\x1b[4~", "End"],
  ["\x1b[7~", "Home"],
  ["\x1b[8~", "End"],
  ["\x1b[A", "Up"],
  ["\x1b[B", "Down"],
  ["\x1b[C", "Right"],
  ["\x1b[D", "Left"],
  ["\x1b[H", "Home"],
  ["\x1b[F", "End"],
  ["\x1b[Z", "BTab"],
  ["\x1bOA", "Up"],
  ["\x1bOB", "Down"],
  ["\x1bOC", "Right"],
  ["\x1bOD", "Left"],
  ["\x1bOH", "Home"],
  ["\x1bOF", "End"],
  ["\x1b\r", "M-Enter"],
  ["\x1b\n", "M-Enter"],
  ["\x1b\x7f", "M-BSpace"],
];

/**
 * The board's Ctrl-q — the chord that hands focus back to the list. It is the
 * one byte that never reaches the session, so the operator can always get out
 * (mirrors AttachScreen's detach chord; see chord.ts CTRL_Q).
 */
export const PANE_ESCAPE = 0x11;

// The rule both embedded surfaces share (root CLAUDE.md): while
// focused, a pi pane forwards EVERY byte except this one. `/` commands,
// completion, history and Ctrl-C are pi's — a TUI-side input box in front of
// them is the regression, not the feature. Same chord in `sidebar.ts`, so
// there is one way out of every embedded surface.

/**
 * One raw stdin chunk → the `tmux send-keys` argument groups that reproduce it
 * inside the session.
 *
 * Why groups and not one flat argv: `send-keys -l` is a flag of the *command*,
 * not of an argument, so literal text and named keys cannot share one
 * invocation. Runs of printable characters coalesce into a single
 * `["-l", "<text>"]` group (so typing a word — or pasting a paragraph — is one
 * round trip), runs of specials coalesce into a single group of key names, and
 * a chunk that is purely one or the other (the overwhelmingly common case) is
 * exactly one invocation.
 *
 * Ctrl-q is dropped, never translated: the focus chord belongs to the board.
 */
export function keysToTmux(buf: Buffer): string[][] {
  const s = buf.toString("utf8");
  const groups: string[][] = [];
  let literal = "";
  let names: string[] = [];
  const flushLiteral = (): void => {
    if (literal.length === 0) return;
    groups.push(["-l", literal]);
    literal = "";
  };
  const flushNames = (): void => {
    if (names.length === 0) return;
    groups.push(names);
    names = [];
  };
  const pushName = (name: string): void => {
    flushLiteral();
    names.push(name);
  };

  let i = 0;
  outer: while (i < s.length) {
    for (const [seq, name] of SEQUENCES) {
      if (s.startsWith(seq, i)) {
        pushName(name);
        i += seq.length;
        continue outer;
      }
    }
    const ch = s[i]!;
    const code = ch.codePointAt(0)!;
    if (code === PANE_ESCAPE) {
      i += 1; // the board's own chord — it never travels
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      pushName("Enter");
    } else if (ch === "\t") {
      pushName("Tab");
    } else if (ch === "\x7f" || ch === "\b") {
      pushName("BSpace");
    } else if (ch === "\x1b") {
      // Alt-<printable> arrives as ESC + the character; a lone ESC is Escape.
      const next = s[i + 1];
      if (next !== undefined && next >= " " && next !== "\x7f") {
        pushName(`M-${next}`);
        i += 2;
        continue;
      }
      pushName("Escape");
    } else if (code === 0) {
      pushName("C-Space");
    } else if (code < 0x20) {
      pushName(`C-${String.fromCharCode(code + 96)}`); // 0x01 → C-a …
    } else {
      flushNames();
      literal += ch;
    }
    i += 1;
  }
  flushLiteral();
  flushNames();
  return groups;
}

/** Capture text → sanitized lines, trailing blanks trimmed, bounded. */
export function splitCapture(stdout: string): string[] {
  const lines = stdout.split("\n").map(keepSgrOnly);
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  return lines.slice(-MAX_LINES);
}
