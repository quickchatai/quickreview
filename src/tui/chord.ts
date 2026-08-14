// The single reserved chord in attach mode (keybinding map): Ctrl-q
// (0x11) detaches; Ctrl-q Ctrl-q inside the grace window sends one literal
// Ctrl-q to the session. Every other byte — csi-u sequences included — is
// forwarded verbatim, never parsed (§3B). 0x11 cannot appear inside
// a csi-u sequence (those are printable-ASCII CSI … u), so a bare scan is
// prefix-collision-free.
export const CTRL_Q = 0x11;
export const CHORD_GRACE_MS = 300;

export interface ChordAction {
  /** Bytes to forward to the pty, in order. */
  forward: Buffer[];
  /** Detach now. */
  detach: boolean;
  /** Arm (or re-arm) the grace timer; fires armTimeout() if untouched. */
  arm: boolean;
  /** Cancel a pending grace timer. */
  disarm: boolean;
}

/** Pure chord state machine. Feed raw stdin chunks; on a lone Ctrl-q it asks
 * the caller to arm a timer, and a second Ctrl-q within the window turns into
 * one literal 0x11. Ctrl-q followed by other bytes in the same chunk detaches
 * immediately (typed-ahead input after a detach intent is dropped). */
export class ChordScanner {
  private pending = false;

  feed(chunk: Buffer): ChordAction {
    const action: ChordAction = { forward: [], detach: false, arm: false, disarm: false };
    let rest = chunk;
    if (this.pending) {
      this.pending = false;
      action.disarm = true;
      if (rest.length > 0 && rest[0] === CTRL_Q) {
        action.forward.push(Buffer.from([CTRL_Q])); // double-tap → literal
        rest = rest.subarray(1);
      } else {
        action.detach = true;
        return action; // pending + non-Ctrl-q: detach, drop the type-ahead
      }
    }
    const i = rest.indexOf(CTRL_Q);
    if (i === -1) {
      if (rest.length > 0) action.forward.push(rest);
      return action;
    }
    if (i > 0) action.forward.push(rest.subarray(0, i));
    if (i < rest.length - 1) {
      // Ctrl-q with bytes after it in one chunk — not a human double-tap
      // unless the next byte is another Ctrl-q.
      if (rest[i + 1] === CTRL_Q) {
        action.forward.push(Buffer.from([CTRL_Q]));
        const tail = rest.subarray(i + 2);
        if (tail.length > 0) action.forward.push(tail);
      } else {
        action.detach = true;
      }
      return action;
    }
    this.pending = true;
    action.arm = true;
    return action;
  }

  /** Grace expired with no second tap: detach. */
  armTimeout(): { detach: boolean } {
    if (!this.pending) return { detach: false };
    this.pending = false;
    return { detach: true };
  }
}

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
