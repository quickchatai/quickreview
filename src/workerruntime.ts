// What hosts each PR's session, for status.json's per-PR `runtime` (P8.12).
//
//   takeover  the operator works in the PR's real session under a lease (P8.13)
//   debug     a round runs inside interactive pi (P8.13b)
//   worker    a round's worker runs
//   answer    an idle-PR answer worker runs (P8.17)
//   idle      nothing runs: the PR is its JSONL and waits for the next round
//
// The TUI's PR pane picks its surface from it (src/tui/viewer.ts `paneSurface`):
// the viewer for worker, answer and idle, the pi terminal for debug and takeover.
// A lease outranks a worker, because a lease is only ever granted when no worker
// runs and a worker is refused while it is held; a stale worker record never
// shows the pane a viewer over a takeover.
import type { PrRuntime } from "./state.js";
import type { WorkerStatus } from "./workersupervisor.js";

export interface RuntimeSources {
  /** The supervisor's live workers. */
  workers(): readonly Pick<WorkerStatus, "pr" | "mode">[];
  /** The PR's host lease, once takeover and debug rounds exist; null for none. */
  lease?(pr: number): "takeover" | "debug" | null | undefined;
}

export function runtimeOfPr(pr: number, sources: RuntimeSources): PrRuntime {
  const lease = sources.lease?.(pr);
  if (lease === "takeover" || lease === "debug") return lease;
  const worker = sources.workers().find((w) => w.pr === pr);
  if (worker) return worker.mode === "answer" ? "answer" : "worker";
  return "idle";
}
