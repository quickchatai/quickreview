// Startup progress — the bring-up, reported IN the companion column.
//
// The column is empty at that moment and already the right shape (its width
// comes from config), so it costs no new surface: memory forward, OpenViking
// namespaces, container bring-up, day rollover and the first poll each report
// there, and when the companion is up the mirror takes the space back. Lines
// printed on the NORMAL screen would be erased by the alt screen's clear.
//
// A step that never completes must be distinguishable from one still working:
// past STALL_AFTER_MS a running step stops looking like a spinner and says so,
// with the elapsed time, in warning colour. Nothing here has a timeout of its
// own — the bring-up steps own their deadlines; this only tells the truth about
// how long one has been going.
import { ACCENT, BAD, MUTED, OK, RESET, WARN } from "./design.js";

export type StepState = "pending" | "running" | "done" | "failed" | "skipped";

export interface StartupStep {
  key: string;
  label: string;
  state: StepState;
  /** One short clause: what happened, or what it is doing. */
  detail?: string;
  startedAt?: number;
  endedAt?: number;
}

/** After this long a running step is flagged as overdue rather than working. */
export const STALL_AFTER_MS = 20_000;

/** The bring-up, in the order it runs. Declared here so the column shows every
 * step from the first frame — a step nobody has reached yet is `pending`, which
 * is a different thing from one that failed. */
export const STARTUP_STEPS = [
  { key: "ssh", label: "vm ssh" },
  { key: "poll", label: "daemon status" },
  { key: "memory-forward", label: "memory forward" },
  { key: "memory-namespaces", label: "memory namespaces" },
  { key: "container", label: "companion container" },
  { key: "rollover", label: "day rollover" },
  { key: "companion-pi", label: "companion pi" },
] as const satisfies ReadonlyArray<{ key: string; label: string }>;

/** Every step key the bring-up may address — derived from `STARTUP_STEPS`, so
 * a key cannot exist without the step it names. A union rather than bare
 * strings: `set()` has to ignore an unknown key (a progress reporter must
 * never break the startup it reports on), which makes a typo INVISIBLE at
 * runtime — so it is caught at compile time instead. */
export type StartupStepKey = (typeof STARTUP_STEPS)[number]["key"];

/** What a reporter is allowed to read — structural, so `StartupOpts` does not
 * have to be generic over the step keys. */
export interface ProgressView {
  lines(): string[];
  steps(): StartupStep[];
  settled(): boolean;
}

export interface StartupOpts {
  now?: () => number;
  /** Called after every transition AND on every tick — the TUI repaints here. */
  onUpdate?: (progress: ProgressView) => void;
  /** Re-render cadence while a step is running (0 disables the ticker).
   *
   * Without this the overdue warning can never appear. A step that hangs emits
   * no transition, so nothing calls `onUpdate`, so the column keeps painting
   * the elapsed time it had at the last transition — `⟳ companion container ·
   * 0ms`, frozen, forever. A docker daemon which is down must look different
   * from one that is slow, and it is exactly this tick that makes the
   * difference visible. */
  tickMs?: number;
}

/** Re-render cadence while the bring-up is unsettled. Deliberately slower than
 * a second is not worth it (the elapsed counter would visibly stutter) and
 * faster is pointless; it is independent of the 3s poll and never triggers
 * one — it only repaints what is already known. */
export const DEFAULT_TICK_MS = 1_000;

/**
 * The bring-up's state. Total by construction: an unknown key is ignored rather
 * than throwing — a progress reporter must never be able to break the startup
 * it is reporting on.
 */
export class StartupProgress<K extends string = StartupStepKey> {
  private readonly order: StartupStep[];
  private readonly byKey = new Map<string, StartupStep>();

  constructor(
    steps: ReadonlyArray<{ key: K; label: string }> = STARTUP_STEPS as unknown as ReadonlyArray<{
      key: K;
      label: string;
    }>,
    private readonly opts: StartupOpts = {},
  ) {
    this.order = steps.map((s) => ({ key: s.key, label: s.label, state: "pending" }));
    for (const s of this.order) this.byKey.set(s.key, s);
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private set(key: K, patch: Partial<StartupStep>): void {
    const step = this.byKey.get(key);
    if (!step) return;
    Object.assign(step, patch);
    if (this.settled()) this.stop();
    else this.ensureTicker();
    this.opts.onUpdate?.(this);
  }

  /** The re-render tick. Unref'd, so it can never hold the process open at
   * quit, and self-stopping the moment nothing is running any more. */
  private ticker: ReturnType<typeof setInterval> | undefined;

  private ensureTicker(): void {
    const ms = this.opts.tickMs ?? DEFAULT_TICK_MS;
    if (this.ticker !== undefined || ms <= 0) return;
    const t = setInterval(() => {
      if (this.settled()) {
        this.stop();
        return;
      }
      this.opts.onUpdate?.(this);
    }, ms);
    t.unref?.();
    this.ticker = t;
  }

  /** Stop ticking. Called on settle and from the TUI's teardown. */
  stop(): void {
    if (this.ticker !== undefined) clearInterval(this.ticker);
    this.ticker = undefined;
  }

  /** Start (or restart) a step: what a previous attempt said — a failure's
   * detail, its end time — is cleared, never carried into this one. */
  begin(key: K, detail?: string): void {
    const step = this.byKey.get(key);
    if (step) {
      delete step.detail;
      delete step.endedAt;
    }
    this.set(key, {
      state: "running",
      startedAt: this.now(),
      ...(detail !== undefined ? { detail } : {}),
    });
  }

  /** Update a running step's detail WITHOUT restarting its clock — "what it is
   * doing right now". Restarting it would hide a stall behind chatter. */
  note(key: K, detail: string): void {
    if (this.byKey.get(key)?.state !== "running") return;
    this.set(key, { detail });
  }

  done(key: K, detail?: string): void {
    this.set(key, {
      state: "done",
      endedAt: this.now(),
      ...(detail !== undefined ? { detail } : {}),
    });
  }

  fail(key: K, detail: string): void {
    this.set(key, { state: "failed", endedAt: this.now(), detail });
  }

  skip(key: K, detail?: string): void {
    this.set(key, {
      state: "skipped",
      endedAt: this.now(),
      ...(detail !== undefined ? { detail } : {}),
    });
  }

  steps(): StartupStep[] {
    return this.order.map((s) => ({ ...s }));
  }

  /** Every step has reached a terminal state — nothing left to re-render for,
   * which is what stops the ticker. */
  settled(): boolean {
    return this.order.every((s) => s.state !== "pending" && s.state !== "running");
  }

  lines(): string[] {
    return startupLines(this.order, this.now());
  }
}

/** ` · 400ms` for a step that actually ran; "" for one that never began. */
function took(s: StartupStep): string {
  return s.startedAt !== undefined && s.endedAt !== undefined
    ? ` · ${secs(s.endedAt - s.startedAt)}`
    : "";
}

function secs(ms: number): string {
  return ms < 1_000 ? `${Math.max(0, Math.round(ms))}ms` : `${Math.round(ms / 1000)}s`;
}

/** Pure render: one line per step, in declaration order. */
export function startupLines(steps: readonly StartupStep[], nowMs: number): string[] {
  return steps.map((s) => {
    const detail = s.detail && s.detail.trim() !== "" ? ` · ${s.detail.trim()}` : "";
    switch (s.state) {
      case "pending":
        return `${MUTED}○ ${s.label} · waiting${RESET}`;
      case "running": {
        const elapsed = s.startedAt === undefined ? 0 : Math.max(0, nowMs - s.startedAt);
        if (elapsed >= STALL_AFTER_MS) {
          return `${WARN}⚠ ${s.label} · ${secs(elapsed)} — still running, no result yet${RESET}`;
        }
        return `${ACCENT}⟳ ${s.label} · ${secs(elapsed)}${RESET}${MUTED}${detail}${RESET}`;
      }
      case "done": {
        return `${OK}✓ ${s.label}${RESET}${MUTED}${took(s)}${detail}${RESET}`;
      }
      case "failed":
        // The duration matters on a failure too: 12s says the probe timed out,
        // 40ms says it was refused outright. Its ABSENCE is also information —
        // a step that failed without ever starting never ran at all.
        return `${BAD}✗ ${s.label}${RESET}${MUTED}${took(s)}${RESET}${BAD}${detail}${RESET}`;
      case "skipped":
        return `${MUTED}– ${s.label}${detail}${RESET}`;
    }
  });
}
