// A worker's spend report, taken in by the daemon.
//
// The bot worker totals what its round cost as it runs (src/botworker.ts: the
// session's assistant messages, the passes its lens tools reported and, at the
// end, the lens ledger's warm-ups, each run once) and reports it over IPC as
// `usage` events and a closing `done`. The daemon keeps it on the command's row.
// recordRoundUsage then prefers it to a transcript measurement, which stays the
// answer for a worker that never closed its report (`workerReportedUsd`).
import type { EventHandler } from "./ipc/server.js";
import type { IpcEventKind } from "./ipc/protocol.js";

export interface CommandUsageStore {
  recordCommandUsage(
    commandId: string,
    usage: { est_usd: number; lens_usd: number | null; final: boolean },
  ): boolean;
}

const money = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

/** The spend an event carries, or null when it carries none a store should keep. */
export function usageOfEvent(
  kind: IpcEventKind,
  body: unknown,
): { est_usd: number; lens_usd: number | null; final: boolean } | null {
  if (kind !== "usage" && kind !== "done") return null;
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  const est = money(b["total_usd"]);
  if (est === null) return null;
  return { est_usd: est, lens_usd: money(b["lens_usd"]), final: kind === "done" };
}

/** The daemon's `onEvent` for the usage figures. the supervisor composes it with
 * its own handling of the other kinds. A malformed body keeps nothing. */
export function workerUsageHandler(store: CommandUsageStore): EventHandler {
  return (ctx, kind, body) => {
    const usage = usageOfEvent(kind, body);
    if (usage !== null) store.recordCommandUsage(ctx.commandId, usage);
  };
}
