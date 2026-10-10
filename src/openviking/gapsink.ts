// The counted `openviking_gap`.
//
// Every gap the daemon's memory client reports (a failed request: transport,
// 5xx, a bad body, an auth refusal) is COUNTED — into the memory health block,
// through `record`, and here per `op:code` — and written as a QUIET anomaly row
// at most once an hour per `op:code`, the row carrying the running count. The
// table records that a class of gap is happening, never every request of an
// outage; the person-facing signal is the memory STATE (`src/memory/health.ts`),
// not these rows. `openviking_gap` is deliberately not in `WAKE_KINDS`.
import type { OvGap } from "./client.js";

export const GAP_ANOMALY_KIND = "openviking_gap";

/** One row per `op:code` per this long. */
export const GAP_ROW_EVERY_MS = 3_600_000;

export interface CountedGapSinkDeps {
  /** Writes the anomaly row — wire.ts: `store.logAnomaly`. */
  logAnomaly: (kind: string, pr: number | null, roundNo: number | null, detail: string) => void;
  /** Feeds the memory health block's gap counters (absent when memory is not
   * monitored — the rows are still written). Must not throw. */
  record?: (gap: OvGap) => void;
  log?: (msg: string, extra?: unknown) => void;
  now?: () => number;
  everyMs?: number;
}

/** The client's `onGap` sink. Never throws: a counter must not become an
 * outage on the request path. */
export function countedGapSink(deps: CountedGapSinkDeps): (gap: OvGap) => void {
  const now = deps.now ?? Date.now;
  const everyMs = deps.everyMs ?? GAP_ROW_EVERY_MS;
  const counts = new Map<string, number>();
  const rowAt = new Map<string, number>();
  return (gap) => {
    try {
      deps.log?.("openviking gap", gap);
      try {
        deps.record?.(gap);
      } catch {
        // The health block missing one count is not worth the row.
      }
      const key = `${gap.op}:${gap.code}`;
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      const t = now();
      const last = rowAt.get(key);
      if (last !== undefined && t - last < everyMs) return;
      rowAt.set(key, t);
      deps.logAnomaly(
        GAP_ANOMALY_KIND,
        null,
        null,
        `${gap.op} ${gap.code} (${gap.status || "no answer"}): ${gap.message.slice(0, 200)} — ${n} such gap${n === 1 ? "" : "s"} since boot`,
      );
    } catch {
      // Swallowed by contract: the client already swallows a throwing sink,
      // and this sink promises not to need that.
    }
  };
}
