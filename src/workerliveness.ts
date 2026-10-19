// Worker liveness (P8.8): what the archiver, the startup orphan sweep and
// operator recovery ask of the machine instead of asking tmux.
//
// A PR has no session between rounds, only its JSONL. Whether anything runs for
// it is two facts the daemon already keeps:
//
//   - the WORKER LEASE (src/workerlease.ts), one small file per session naming
//     the process the WorkerSupervisor started. A lease is read through the
//     process table (start time, boot/container id), never taken at its word:
//     pids repeat, so a lease alone does not say "alive";
//   - the ONE-ACTIVE INDEX (`session_commands_one_active`, src/state.ts), which
//     holds one pending or running command per session. A round whose command
//     still waits for a worker (a restart requeued it) is in flight, not lost.
//
// A first boot after the cutover finds no lease and no tmux `pr-*`: every open
// PR reads as idle with its JSONL. There is no per-PR host flag to consult.
//
// Neutral by design (node builtins, src/workerlease.ts, src/state.ts types): the
// daemon, the CLI and the tests all import it without reaching src/engine/.
import { existsSync } from "node:fs";
import { prOfSession, prSessionName } from "./pr-session-lifecycle.js";
import type { StateStore } from "./state.js";
import {
  judgeLease,
  leaseDirOf,
  realProc,
  WorkerLeases,
  type ProcView,
  type WorkerLease,
} from "./workerlease.js";

export interface WorkerLivenessOptions {
  /** The run dir the supervisor keeps its leases under (`<state>/run`). */
  runDir: string;
  /** Test seam: the machine's process table. */
  proc?: ProcView;
}

export interface WorkerLiveness {
  /** The sessions (`pr-<n>`) a worker runs for now. null = the leases could not
   * be read, which a caller treats as UNKNOWN (the archiver holds), never as
   * "none". An empty or absent lease dir is an answer: nothing runs. */
  liveSessions(): string[] | null;
  /** Does a worker of PR `pr` run now? null = could not be asked. */
  runs(pr: number): boolean | null;
}

/** Which of a lease's states keep a session alive. A lease the process table
 * does not confirm (`dead`, `foreign`) is a corpse, and the boot reaps it. */
function holdsSession(lease: WorkerLease | null, proc: ProcView): boolean {
  // A file that is not a lease (a crash mid-write, someone's edit) may hide a
  // live worker: it counts as one until the supervisor's boot removes it.
  if (lease === null) return true;
  const verdict = judgeLease(lease, proc);
  // `unstarted`: the lease is taken and the process is on its way.
  return verdict.kind === "group" || verdict.kind === "members" || verdict.kind === "unstarted";
}

export function createWorkerLiveness(opts: WorkerLivenessOptions): WorkerLiveness {
  const proc = opts.proc ?? realProc;
  const dir = leaseDirOf(opts.runDir);
  const live = (): string[] | null => {
    // No dir: no worker was ever started here. Not created by a read.
    if (!existsSync(dir)) return [];
    try {
      const leases = new WorkerLeases(dir);
      return leases
        .list()
        .filter((l) => holdsSession(l.lease, proc))
        .map((l) => l.session)
        .sort();
    } catch {
      return null;
    }
  };
  return {
    liveSessions: live,
    runs(pr) {
      const names = live();
      return names === null ? null : names.includes(prSessionName(pr));
    },
  };
}

/**
 * The PRs the startup orphan sweep must leave alone: a worker runs for them, or
 * a round command still waits for the next worker (the one-active index).
 * Everything else with a round marked running has lost its session. Leases that
 * cannot be read leave every running round alone: the sweep cancels on evidence
 * of a lost session, never on a failed look.
 */
export function inFlightPrs(store: StateStore, liveness: WorkerLiveness): number[] {
  const prs = new Set<number>();
  const names = liveness.liveSessions();
  if (names === null) for (const round of store.runningRounds()) prs.add(round.pr);
  for (const name of names ?? []) {
    const pr = prOfSession(name);
    if (pr !== undefined) prs.add(pr);
  }
  for (const command of store.activeSessionCommands())
    if (command.kind === "round") prs.add(command.pr);
  return [...prs].sort((a, b) => a - b);
}
