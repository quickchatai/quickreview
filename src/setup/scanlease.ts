// The scan driver lease: which process drives the scan in flight, across
// processes. A ScanRunner knows its OWN run (`active`); a run recorded as
// `running` that this runner does not drive is either interrupted or driven
// by another process sharing the state home — the companion, or a
// `qcr scan start` driver. The lease tells them apart: the driving runner
// holds it and renews it while it drives; a holder that stopped renewing
// (killed, its machine asleep) has let it lapse, and its run reads as
// interrupted again.
//
// The lease is a sequence of GENERATIONS, `scan/driver/<n>.json`, the highest
// one current. A claim creates the next generation with an exclusive create
// (the record is written aside and hard-linked into place, which fails when
// the name exists), so of any number of processes claiming at once exactly
// one wins each generation — and a record is never seen half-written. A
// holder renews only its own generation; once a newer one exists (its lease
// lapsed and was taken over) it no longer holds the lease, and renewal says
// so. An unreadable current generation is no lease.
//
// What the lease does NOT serialise: the records other processes may write
// while a run is driven elsewhere. `qcr scan match` / `dismiss` and the
// companion's triage rewrite `scan/findings.json`, and a driver's reconcile
// does too, each as a fresh read, a change and a write — between one
// process's read and its write another's write can be lost. The run record
// `scan/run.json` is written only by the lease holder; a holder that lost the
// lease stops its run and writes it no more (scanrun.ts).
//
// A leaf: node built-ins only, so the TUI's scan tab reads the lease too.
import { randomUUID } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

export const DRIVER_DIR = "scan/driver";
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
  /** Take the lease for `run` — or renew it when this runner holds it
   * already; false when another live holder has it, or another claim won. */
  claim(run: string | null): boolean;
  /** Renew the lease this runner holds; false when it holds none any more. */
  renew(run: string | null): boolean;
  /** Give the lease up — only when this runner still holds it. */
  release(): void;
  /** The live lease of ANOTHER holder, or null. */
  other(): LeaseRecord | null;
}

function parse(text: string): LeaseRecord | null {
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

const GEN = /^(\d+)\.json$/;

/** The current generation and its record (null: unreadable), or null when
 * there is no lease at all. */
function current(dir: string): { gen: number; record: LeaseRecord | null } | null {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const gens = names.flatMap((n) => {
    const m = GEN.exec(n);
    return m ? [Number(m[1])] : [];
  });
  if (gens.length === 0) return null;
  const gen = Math.max(...gens);
  let record: LeaseRecord | null = null;
  try {
    record = parse(readFileSync(join(dir, `${gen}.json`), "utf8"));
  } catch {
    record = null;
  }
  return { gen, record };
}

const isLive = (r: LeaseRecord, now: Date): boolean => {
  const at = Date.parse(r.at);
  return Number.isFinite(at) && now.getTime() - at < LEASE_TTL_MS;
};

/** The current lease record under the state home `home`, live or not —
 * null when there is none or it cannot be read. For a reader that holds
 * none (the TUI), which judges it with `leaseIsLive`. */
export function currentLease(home: string): LeaseRecord | null {
  return current(join(home, DRIVER_DIR))?.record ?? null;
}

export const leaseIsLive = (r: LeaseRecord, now: Date = new Date()): boolean => isLive(r, now);

/** The live lease under the state home `home`, or null. */
export function liveLease(home: string, now: Date = new Date()): LeaseRecord | null {
  const r = currentLease(home);
  return r && isLive(r, now) ? r : null;
}

/** The lease as generation files under the state home `home`. Total: a
 * failed write is a failed claim or renewal, never a throw. */
export function fileLease(
  home: string,
  opts: {
    clock?: () => Date;
    holder?: string;
    /** Called between reading the lease and creating the next generation. */
    beforeCreate?: () => void;
  } = {},
): ScanLease {
  const dir = join(home, DRIVER_DIR);
  const clock = opts.clock ?? (() => new Date());
  const holder = opts.holder ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  let mine: number | null = null;
  const record = (run: string | null, at = clock()): string =>
    `${JSON.stringify({ holder, run, pid: process.pid, host: hostname(), at: at.toISOString() })}\n`;
  // Only its holder rewrites a generation: tmp + rename.
  const rewrite = (gen: number, text: string): boolean => {
    const tmp = join(dir, `.${gen}.${randomUUID()}.tmp`);
    try {
      writeFileSync(tmp, text);
      renameSync(tmp, join(dir, `${gen}.json`));
      return true;
    } catch {
      return false;
    }
  };
  const prune = (below: number): void => {
    try {
      for (const name of readdirSync(dir)) {
        const m = GEN.exec(name);
        if (m && Number(m[1]) < below) unlinkSync(join(dir, name));
      }
    } catch {
      // Another claimer pruned it first.
    }
  };
  const lease: ScanLease = {
    holder,
    claim(run) {
      const cur = current(dir);
      if (cur !== null && mine === cur.gen) return lease.renew(run);
      if (cur?.record && cur.record.holder !== holder && isLive(cur.record, clock())) return false;
      opts.beforeCreate?.();
      const gen = (cur?.gen ?? 0) + 1;
      const tmp = join(dir, `.claim.${randomUUID()}.tmp`);
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(tmp, record(run));
        // The exclusive create: the link fails when generation `gen` exists.
        linkSync(tmp, join(dir, `${gen}.json`));
      } catch {
        return false;
      } finally {
        try {
          unlinkSync(tmp);
        } catch {
          // Never written.
        }
      }
      mine = gen;
      prune(gen - 1);
      return true;
    },
    renew(run) {
      const cur = current(dir);
      if (mine === null || cur === null || cur.gen !== mine) {
        mine = null;
        return false;
      }
      return rewrite(mine, record(run));
    },
    release() {
      const cur = current(dir);
      if (mine !== null && cur !== null && cur.gen === mine)
        rewrite(mine, record(null, new Date(0)));
      mine = null;
    },
    other() {
      const cur = current(dir);
      if (cur === null || cur.record === null || cur.gen === mine) return null;
      return isLive(cur.record, clock()) ? cur.record : null;
    },
  };
  return lease;
}
