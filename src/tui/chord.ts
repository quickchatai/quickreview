// The TUI's one hard-kill chord. (The Ctrl-q detach scanner that used to live
// here went with the full-screen attach, 2026-09-02: the TUI no longer owns a
// pty to detach from. Ctrl-q still releases an embedded surface's focus —
// pipane.ts PANE_ESCAPE — but that is a single byte, not a chord.)
export const CTRL_C = 0x03;
export const KILL_WINDOW_MS = 1200;

/** Last-resort escape: three bare Ctrl-C presses inside the window mean
 * "kill the TUI no matter what". Single/double Ctrl-C keeps flowing to the
 * session (pi needs it), so only distinct one-byte 0x03 chunks — human
 * keypresses — count. */
export class TripleCtrlC {
  private taps: number[] = [];

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Feed a raw stdin chunk; true = the user demanded a hard kill. */
  feed(chunk: Buffer): boolean {
    if (chunk.length !== 1 || chunk[0] !== CTRL_C) {
      this.taps = [];
      return false;
    }
    const t = this.now();
    this.taps = [...this.taps.filter((x) => t - x <= KILL_WINDOW_MS), t];
    return this.taps.length >= 3;
  }
}
