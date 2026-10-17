// The scan driver lease: which process drives the scan in flight, across
// processes. A ScanRunner knows its OWN run (`active`); a run recorded as
// `running` that this runner does not drive is either interrupted or driven
// by another process sharing the state home — the companion, or a
// `qcr scan start` driver. The lease tells them apart: the driving runner
// holds `scan/driver.json` and renews it while it drives; a holder that
// stopped renewing (killed, its machine asleep) has let it lapse, and its
// run reads as interrupted again.
//
// It also keeps two drivers from running at once: a runner refuses to start
// while another holder's lease is live, and claims the lease BEFORE it plans,
// re-reading it after the write so of two claims at once only one proceeds.
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type { StateFs } from "./engine.js";

export const DRIVER_FILE = "scan/driver.json";
/** How often a driving runner renews its lease. */
export const LEASE_RENEW_MS = 5_000;
/** A lease not renewed for this long has lapsed. */
export const LEASE_TTL_MS = 30_000;

export interface LeaseRecord {
  holder: string;
  /** The run it drives; null while a start is still planning. */
  run: string | null;
  pid: number;
  host: string;
  at: string;
}

/** The lease port a ScanRunner drives. */
export interface ScanLease {
  /** This runner's holder id. */
  readonly holder: string;
  /** Claim (or renew) the lease for `run`; false when another live holder
   * has it. */
  claim(run: string | null): boolean;
  /** Give the lease up — only when this runner still holds it. */
  release(): void;
  /** The live lease of ANOTHER holder, or null. */
  other(): LeaseRecord | null;
}

function parse(text: string | null): LeaseRecord | null {
  if (text === null) return null;
  try {
    const r = JSON.parse(text) as Partial<LeaseRecord>;
    if (typeof r.holder !== "string" || typeof r.at !== "string") return null;
    return {
      holder: r.holder,
      run: typeof r.run === "string" ? r.run : null,
      pid: typeof r.pid === "number" ? r.pid : 0,
      host: typeof r.host === "string" ? r.host : "",
      at: r.at,
    };
  } catch {
    return null;
  }
}

/** The lease as a file in the state home. Total: an unreadable lease file
 * reads as no lease (a reader never blocks on it), and a failed write is a
 * failed claim. */
export function fileLease(
  state: StateFs,
  clock: () => Date = () => new Date(),
  holder: string = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`,
): ScanLease {
  const read = (): LeaseRecord | null => {
    try {
      return parse(state.read(DRIVER_FILE));
    } catch {
      return null;
    }
  };
  const live = (r: LeaseRecord): boolean => {
    const at = Date.parse(r.at);
    return Number.isFinite(at) && clock().getTime() - at < LEASE_TTL_MS;
  };
  return {
    holder,
    claim(run) {
      const cur = read();
      if (cur !== null && cur.holder !== holder && live(cur)) return false;
      const rec: LeaseRecord = {
        holder,
        run,
        pid: process.pid,
        host: hostname(),
        at: clock().toISOString(),
      };
      try {
        state.write(DRIVER_FILE, `${JSON.stringify(rec)}\n`);
      } catch {
        return false;
      }
      return read()?.holder === holder;
    },
    release() {
      const cur = read();
      if (cur === null || cur.holder !== holder) return;
      try {
        state.write(DRIVER_FILE, `${JSON.stringify({ ...cur, at: new Date(0).toISOString() })}\n`);
      } catch {
        // A lease left behind lapses on its own.
      }
    },
    other() {
      const cur = read();
      return cur !== null && cur.holder !== holder && live(cur) ? cur : null;
    },
  };
}
