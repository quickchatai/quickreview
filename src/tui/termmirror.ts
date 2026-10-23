// The embedded-terminal protocol shared by both tmux mirrors (the board's PR
// pane in `pipane.ts`, the companion column in `sidebar.ts`): the capture
// argv, capture text -> painted lines, scrollback bounds, and raw stdin ->
// `tmux send-keys`. Pure functions and constants only — no transport, no
// state. The mirrors differ in how they run the argv, not in what it says.
import { closeSgr } from "./paint.js";
import type { CaptureRange } from "./remote.js";

/**
 * The tmux arguments of one embedded-terminal capture, after `tmux` and
 * before any transport: an optional `resize-window` to the painted rectangle,
 * then `capture-pane -e -p -J` over `range`. Both embedded terminals build
 * their capture from this — the board's PR pane through `captureArgv`, the
 * companion column through its local docker runner — so the capture protocol
 * is spelled once.
 */
export function tmuxCaptureArgs(
  session: string,
  range?: CaptureRange,
  size?: { cols: number; rows: number },
): string[] {
  const window: string[] = [];
  if (range && range.startBack > 0) {
    window.push("-S", `-${range.startBack}`);
    if (range.endBack !== undefined && range.endBack > 0) window.push("-E", `-${range.endBack}`);
  }
  const resize: string[] = size
    ? ["resize-window", "-t", session, "-x", String(size.cols), "-y", String(size.rows), ";"]
    : [];
  return [...resize, "capture-pane", "-e", "-p", "-J", ...window, "-t", session];
}

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
  const SEQ =
    /\x1b\[[0-9;:?<>!$"' ]*[A-Za-z@`{|}~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[ #%()*+][0-9A-Za-z]|\x1b[@-Z\\-_]/g;
  const kept = line
    .replace(SEQ, (m) => (/^\x1b\[[0-9;:]*m$/.test(m) ? m : ""))
    .replace(/\t/g, "  ")
    .replace(/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f-\x9f]/g, ""); // C0/C1 minus ESC (0x1b)
  // Close the row. A tmux pane row often ends with a background or foreground
  // still set, and an open attribute does not stop at the mirror's edge: it
  // paints the pane's padding, the board's right border and the companion
  // column beside it. `truncate` already closes the lines it cuts; this
  // covers every line that fits, which is most of them.
  return closeSgr(kept);
}

/** Keep the mirror bounded — the board only ever paints the tail. */
const MAX_LINES = 400;

/** Wheel notch = three lines, the usual terminal step. */
export const SCROLL_STEP = 3;

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

/** ESC [ with at least one parameter byte, optional intermediates and a final
 * byte: a whole keyboard report, as opposed to a typed Alt-[. */
const CSI_WITH_PARAMS = /^\x1b\[[0-9;:<=>?]+[ -/]*[@-~]/;

/** Is `input` exactly one encoding of the End key (the pane's "back to
 * live")? Read off the same table the keys are translated by. */
export function isEndKey(input: string): boolean {
  return SEQUENCES.some(([seq, name]) => name === "End" && seq === input);
}

/**
 * The board's Ctrl-q — the byte that hands focus back to the list. It is the
 * one byte that never reaches the session, so the operator can always get out.
 */
export const PANE_ESCAPE = 0x11;

// The rule both embedded surfaces share (docs/tui.md): while focused, a pi
// pane forwards every byte except this one. `/` commands, completion, history
// and Ctrl-C are pi's — never put a TUI-side input box in front of them. Same
// byte in `sidebar.ts`, so there is one way out of every embedded surface.

/**
 * One raw stdin chunk → the `tmux send-keys` argument groups that reproduce it
 * inside the session.
 *
 * Why groups and not one flat argv: `send-keys -l` is a flag of the *command*,
 * not of an argument, so literal text and named keys cannot share one
 * invocation. Runs of printable characters coalesce into a single
 * `["-l", "--", "<text>"]` group (so typing a word — or pasting a paragraph — is one
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
    // `--` ends tmux's options: a literal that begins with `-` (a pasted
    // markdown list item, a `--flag`) is text for pi, never flags for tmux.
    groups.push(["-l", "--", literal]);
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

  let csi: RegExpExecArray | null;
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
    } else if (ch === "\x1b" && (csi = CSI_WITH_PARAMS.exec(s.slice(i))) !== null) {
      // A complete CSI sequence the table does not name (Alt-Left ESC[1;3D,
      // CSI-u keys): the application decodes it, so it travels whole.
      flushNames();
      literal += csi[0];
      i += csi[0].length;
      continue;
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

/** Capture text → sanitized lines, trailing blanks trimmed, bounded. The
 * bound is MAX_LINES above the parked window: a capture scrolled `offset`
 * lines back keeps those `offset` lines too, or the window the renderer cuts
 * at `length - offset` would fall off the front and paint blank. */
export function splitCapture(stdout: string, offset = 0): string[] {
  const lines = stdout.split("\n").map(keepSgrOnly);
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  return lines.slice(-(MAX_LINES + Math.max(0, offset)));
}

/** A scrolled capture that came back with less history than the window needs
 * has reached the top of tmux's scrollback: park the window there instead of
 * past it (which paints blank under a "↑N" that points at nothing). `rows` is
 * the painted window height (1 when not yet known). 0 stays 0. */
export function clampScrollback(offset: number, lineCount: number, rows = 1): number {
  if (offset <= 0) return 0;
  return Math.min(offset, Math.max(0, lineCount - Math.max(1, rows)));
}
