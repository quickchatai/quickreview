// The round's lens wave, as a board of rows in flight.
//
// On an engine route the round's engine launches the PLANNED discovery wave at
// round start, and the main session runs alongside it. `lens_wave` is how the
// session collects it: finished rows come back as they are, running rows are
// waited for, and nothing is launched twice. A row is keyed by its task file's
// path (planLaunch resolves every dir to its real path, so the engine's launch
// and the session's `lens_wave({dirs})` name the same file the same way).
//
// The board holds the promise of each row's run, nothing else. It never
// schedules: the engine (or, for a row the session names, the session's own
// `lens_wave` call) starts a row, and a started row is joined by every later
// call. A row is forgotten only when the call that launched it was aborted: a
// lens that failed or timed out stays on the board as the failure it was, and
// the session re-runs it through `lens` if it wants it again.
import { randomUUID } from "node:crypto";
import type { Runtime } from "../port.js";
import type { LaunchUnit } from "./launch-plan.js";
import type { LensRequest, LensRun } from "./runlens.js";

/** What a wave needs of the runner: start one pass. */
export interface WaveRunner {
  run(request: LensRequest): Promise<LensRun>;
}

/** Who started a row. */
export type WaveOrigin = "engine" | "call";

export interface WaveRow {
  /** The task file's path: the row's identity. */
  key: string;
  unit: LaunchUnit;
  origin: WaveOrigin;
  /** The task text the row was started with (its pointer plus any `extra`). */
  task: string;
  /** Settles with the pass's result; never rejects. */
  done: Promise<LensRun>;
  /** The result, once `done` has settled. */
  result: LensRun | undefined;
  /** The call's abort ended it before the model did. */
  aborted: boolean;
}

/** One pass, as a result however it ends: runLens does not reject, but a runner
 * that does (a host that cannot be built) is still a failed pass. */
export function runSafely(runner: WaveRunner, request: LensRequest): Promise<LensRun> {
  return Promise.resolve()
    .then(() => runner.run(request))
    .catch((e: unknown): LensRun => ({
      text: "",
      result: {
        id: randomUUID(),
        agent: request.agent,
        model: "unknown",
        usage: { input: 0, output: 0, cacheRead: 0, cost: 0 },
        messages: [],
        exitCode: 1,
        stopReason: "error",
        errorMessage: e instanceof Error ? e.message : String(e),
      },
    }));
}

export class LensWave {
  private readonly byKey = new Map<string, WaveRow>();

  /** The row for a task file, if one was started. */
  get(key: string): WaveRow | undefined {
    return this.byKey.get(key);
  }

  /** Every row, in the order they were started. */
  rows(): WaveRow[] {
    return [...this.byKey.values()];
  }

  /** Rows still running. */
  running(): number {
    return this.rows().filter((r) => r.result === undefined).length;
  }

  /** Start a row, unless a row for the same task file is already on the board:
   * then that row is returned and nothing is started. `started` tells which. */
  start(
    runner: WaveRunner,
    unit: LaunchUnit,
    origin: WaveOrigin,
    signal?: AbortSignal,
  ): { row: WaveRow; started: boolean } {
    const held = this.byKey.get(unit.path);
    if (held !== undefined) return { row: held, started: false };
    // `done` is assigned below: the settling callback needs the row itself.
    const row = {
      key: unit.path,
      unit,
      origin,
      task: unit.task,
      result: undefined,
      aborted: false,
    } as WaveRow;
    row.done = runSafely(runner, {
      agent: unit.agent,
      task: unit.task,
      ...(signal ? { signal } : {}),
    }).then((run) => {
      row.result = run;
      if (signal?.aborted && run.result.stopReason === "aborted") {
        row.aborted = true;
        // Its caller ended it: the next call may start the row afresh.
        if (this.byKey.get(unit.path) === row) this.byKey.delete(unit.path);
      }
      return run;
    });
    this.byKey.set(unit.path, row);
    return { row, started: true };
  }

  /** Forget every row (a new round on the same board). */
  clear(): void {
    this.byKey.clear();
  }
}

/**
 * The engine's launch of the planned wave: every unit started at once (the
 * runner's own cap and session stagger pace them), none twice. Returns the
 * rows; the engine keeps `signal` to end the wave with the round.
 */
export function launchWave(
  wave: LensWave,
  runner: WaveRunner,
  units: readonly LaunchUnit[],
  signal?: AbortSignal,
): WaveRow[] {
  return units.map((unit) => wave.start(runner, unit, "engine", signal).row);
}

/** What a runtime that hosts the engine's lens tools hands the round: the board
 * its `lens_wave` reads, the runner behind it, and whether the engine starts the
 * planned wave (`[pi] engine_wave`) or leaves the launch to the main session. */
export interface EngineRoute {
  wave: LensWave;
  runner: WaveRunner;
  plannedWave: boolean;
}

/** A runtime that carries an engine route (packages/pi-plugin/src/engine/reviewsdk.ts). The round
 * (round.ts) reads it off the runtime it is given. */
export type EngineRouteRuntime = Runtime & { readonly engineLens?: EngineRoute };
