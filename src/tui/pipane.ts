// Live pi mirror (the board's lower region). The 2026-08-14 grill verdict:
// the EVENTS strip was wasted space and the half-empty bottom of the board
// should show what the selected PR's pi session is doing *right now*.
//
// This is a read-only mirror: `tmux capture-pane -e -p -J` inside the
// container, once per poll tick and ~300ms after the selection moves. It is
// NOT an attach — no keystrokes ever travel this way; ⏎ (or a click on the
// pane) hands over to the real AttachScreen.
import type { TuiConfig } from "../config.js";
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
  return line
    .replace(SEQ, (m) => (/^\x1b\[[0-9;:]*m$/.test(m) ? m : ""))
    .replace(/\t/g, "  ")
    .replace(/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f-\x9f]/g, ""); // C0/C1 minus ESC (0x1b)
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
}

/** Keep the mirror bounded — the board only ever paints the tail. */
const MAX_LINES = 400;

/**
 * Per-PR capture cache with stale-while-revalidate semantics, mirroring the
 * detail cache in `App`: a cached capture paints instantly when the selection
 * comes back, and the refresh lands behind it.
 */
export class PiMirror {
  private readonly cache = new Map<number, string[]>();
  private readonly missing = new Set<number>();
  private readonly inFlight = new Set<number>();
  private timer: NodeJS.Timeout | undefined;

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
    return { pr, lines: lines ?? [], missing, stale: missing && (lines?.length ?? 0) > 0 };
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
      const res = await this.ssh(this.cfg.ssh_host, captureArgv(this.cfg, `pr-${pr}`), { timeoutMs: 5_000 });
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
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

/** Capture text → sanitized lines, trailing blanks trimmed, bounded. */
export function splitCapture(stdout: string): string[] {
  const lines = stdout.split("\n").map(keepSgrOnly);
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  return lines.slice(-MAX_LINES);
}
