// Startup progress (ruling 3) — the bring-up, reported IN the
// companion column.
//
// The column is empty at that moment and already the right shape (its width
// comes from config, ruling 2), so it costs no new surface: memory forward,
// OpenViking namespaces, container bring-up, day rollover and the first poll
// each report there, and when the companion is up the mirror takes the space
// back. Before these lines were printed on the NORMAL screen and then
// erased by the alt screen's clear — that erasure was the flicker.
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
export const STARTUP_STEPS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "ssh", label: "VM ssh" },
  { key: "poll", label: "daemon status" },
  { key: "memory-forward", label: "memory forward" },
  { key: "memory-namespaces", label: "memory namespaces" },
  { key: "container", label: "companion container" },
  { key: "rollover", label: "day rollover" },
  { key: "companion-pi", label: "companion pi" },
];

export interface StartupOpts {
  now?: () => number;
  /** Called after every transition — the TUI repaints from here. */
  onUpdate?: (progress: StartupProgress) => void;
}

/**
 * The bring-up's state. Total by construction: an unknown key is ignored rather
 * than throwing — a progress reporter must never be able to break the startup
 * it is reporting on.
 */
export class StartupProgress {
  private readonly order: StartupStep[];
  private readonly byKey = new Map<string, StartupStep>();

  constructor(steps: ReadonlyArray<{ key: string; label: string }> = STARTUP_STEPS, private readonly opts: StartupOpts = {}) {
    this.order = steps.map((s) => ({ key: s.key, label: s.label, state: "pending" as StepState }));
    for (const s of this.order) this.byKey.set(s.key, s);
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private set(key: string, patch: Partial<StartupStep>): void {
    const step = this.byKey.get(key);
    if (!step) return;
    Object.assign(step, patch);
    this.opts.onUpdate?.(this);
  }

  begin(key: string, detail?: string): void {
    this.set(key, { state: "running", startedAt: this.now(), ...(detail !== undefined ? { detail } : {}) });
  }

  /** Update a running step's detail WITHOUT restarting its clock — "what it is
   * doing right now". Restarting it would hide a stall behind chatter. */
  note(key: string, detail: string): void {
    if (this.byKey.get(key)?.state !== "running") return;
    this.set(key, { detail });
  }

  done(key: string, detail?: string): void {
    this.set(key, { state: "done", endedAt: this.now(), ...(detail !== undefined ? { detail } : {}) });
  }

  fail(key: string, detail: string): void {
    this.set(key, { state: "failed", endedAt: this.now(), detail });
  }

  skip(key: string, detail?: string): void {
    this.set(key, { state: "skipped", endedAt: this.now(), ...(detail !== undefined ? { detail } : {}) });
  }

  /** Run one step, recording begin/done/fail around it. Never throws: a failed
   * bring-up step is a degraded mode, never a reason the TUI does not open. */
  async step<T>(key: string, fn: () => Promise<T>, describe?: (value: T) => string | undefined): Promise<T | undefined> {
    this.begin(key);
    try {
      const value = await fn();
      this.done(key, describe?.(value));
      return value;
    } catch (err) {
      this.fail(key, err instanceof Error ? err.message : String(err));
      return undefined;
    }
  }

  steps(): StartupStep[] {
    return this.order.map((s) => ({ ...s }));
  }

  /** Every step has reached a terminal state. */
  settled(): boolean {
    return this.order.every((s) => s.state !== "pending" && s.state !== "running");
  }

  lines(): string[] {
    return startupLines(this.order, this.now());
  }
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
        const took = s.startedAt !== undefined && s.endedAt !== undefined ? ` · ${secs(s.endedAt - s.startedAt)}` : "";
        return `${OK}✓ ${s.label}${RESET}${MUTED}${took}${detail}${RESET}`;
      }
      case "failed":
        return `${BAD}✗ ${s.label}${detail}${RESET}`;
      case "skipped":
        return `${MUTED}– ${s.label}${detail}${RESET}`;
    }
  });
}
