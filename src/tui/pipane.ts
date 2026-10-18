// Live pi pane (the board's lower region): what the selected PR's pi session
// is doing right now.
//
// The pane is an embedded terminal. Output comes from
// `tmux capture-pane -e -p -J` inside the container (poll tick, ~400ms while
// focused, ~300ms after the selection moves); input goes back the other way as
// `tmux send-keys` (see `keysToTmux` + `sendKeysArgv`).
import type { TuiConfig } from "../config.js";
import { captureArgv, scrolledRange, type SshRunner } from "./remote.js";
import { SCROLL_STEP, clampScrollback, splitCapture } from "./termmirror.js";

// The mirror protocol lives in termmirror.ts; re-exported so pipane stays the
// board pane's import surface.
export {
  PANE_ESCAPE,
  SCROLL_STEP,
  clampScrollback,
  isEndKey,
  keepSgrOnly,
  keysToTmux,
  splitCapture,
} from "./termmirror.js";

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
   * session's own size rather than guessing one. */
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
    return {
      pr,
      lines: lines ?? [],
      missing,
      stale: missing && (lines?.length ?? 0) > 0,
      offset: this.offsetFor(pr),
    };
  }

  /**
   * Receive the board's real painted mirror rectangle (`piPaneSize`).
   *
   * Pure state: the next `fetch` folds `resize-window` into the
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
      const range = scrolledRange(offset);
      const res = await this.ssh(
        this.cfg.ssh_host,
        captureArgv(this.cfg, `pr-${pr}`, range, this.paneSize),
        { timeoutMs: 5_000 },
      );
      if (!res.ok) {
        this.missing.add(pr);
      } else {
        this.missing.delete(pr);
        const lines = splitCapture(res.stdout, offset);
        this.cache.set(pr, lines);
        // Only when the user has not scrolled again while this was in flight:
        // the capture describes the offset it was asked for, not a newer one.
        if (this.offsetFor(pr) === offset)
          this.setOffset(pr, clampScrollback(offset, lines.length, this.paneSize?.rows));
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
