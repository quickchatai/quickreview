// Reading a JSON file another process may still be writing.
//
// A session writes its verdict (and its recheck outcome) with pi's `write`
// tool, which is Node's `fs.promises.writeFile`: open with O_TRUNC, then the
// bytes, then close, each step a separate turn of pi's event loop. `fs.watch`
// fires on the open. Between the two steps the file is empty or short, and on
// a CPU-starved container that gap can outlast a short burst of re-reads.
//
// So an unparseable read is not evidence of a malformed file while the file
// is still plausibly being written: while its bytes moved within the last
// `settleMs` — by its own mtime, or between two of our own looks. The reader
// re-reads with backoff until the JSON parses, or until the file has sat
// unchanged for `settleMs` across several looks (it really is corrupt), or
// until `windowMs` has passed since the first look (a hard bound, so a file
// rewritten forever is still declared). Only unparseable bytes wait: a file
// that parses is complete, whatever its shape, and shape checking is the
// caller's. A file that is there but cannot be read (EISDIR, EACCES, EIO, …)
// waits the same way and is then reported as unparseable — never as missing,
// which would leave it in place, unconsumed and unannounced. Only ENOENT is
// "missing".
//
// The wait is an ordinary async sleep, never a busy loop: nothing here holds
// the event loop.
import { readFileSync, statSync } from "node:fs";

export interface PartialWritePolicy {
  /** Bytes that moved this recently may still be mid-write. Also the time an
   * unchanged unparseable file must sit, under our own observation, before it
   * is called corrupt. */
  settleMs: number;
  /** Hard bound from the first look to "unparseable", however the file moves.
   * 0 disables the tolerance: one read decides (tests). */
  windowMs: number;
  /** First re-read delay; doubles up to `maxDelayMs`. */
  initialDelayMs: number;
  maxDelayMs: number;
}

/** 3 s of stillness is two orders of magnitude above a healthy write and well
 * above a CFS-throttled one; 30 s bounds the worst case. A truly corrupt file
 * is declared after ~3–4 s instead of 120 ms, which costs nothing: the round
 * is over either way and nothing else is waiting on the answer. */
export const DEFAULT_PARTIAL_WRITE_POLICY: PartialWritePolicy = {
  settleMs: 3_000,
  windowMs: 30_000,
  initialDelayMs: 50,
  maxDelayMs: 1_000,
};

/** Unchanged looks required before stillness counts — at least two re-reads
 * after the signature was first seen, so a look that lands right after a
 * daemon stall (when the writer, in the same throttled cgroup, has not run
 * yet either) can never decide alone. */
const MIN_STABLE_LOOKS = 3;

export type SettledRead =
  | { kind: "parsed"; value: unknown; reads: number; waited_ms: number }
  /** The file is not there (ENOENT) — never there, or gone mid-wait. Only
   * ENOENT: any other stat or read failure is evidence about a file that is
   * there, and is reported as `unparseable` below. */
  | { kind: "missing"; reads: number }
  | {
      /** The bytes never parsed as JSON — or could not be read at all (EISDIR,
       * EACCES, EIO, …; `error` then says "could not be read"): either way
       * nothing usable is there, and the caller's malformed path decides. */
      kind: "unparseable";
      error: string;
      reads: number;
      waited_ms: number;
      /** `settled`: it sat still and stayed broken. `window`: the hard bound.
       * `no_tolerance`: the policy's window is 0. */
      why: "settled" | "window" | "no_tolerance";
    };

export interface SettledReadIo {
  /** Monotonic ms — the wait's own clock. Default `performance.now()`. */
  monotonicMs?: () => number;
  /** Wall ms, compared with the file's mtime. Default `Date.now()`. */
  wallMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
  stat?: (path: string) => { size: number; mtimeMs: number; ino: number };
  read?: (path: string) => string;
}

export function resolvePartialWritePolicy(
  over: Partial<PartialWritePolicy> | undefined,
): PartialWritePolicy {
  return { ...DEFAULT_PARTIAL_WRITE_POLICY, ...(over ?? {}) };
}

/**
 * Read `path` as JSON, tolerating a writer that has not finished. Total: never
 * throws. The caller still owns shape validation of `value`.
 */
export async function readSettledJson(
  path: string,
  policy: PartialWritePolicy,
  io: SettledReadIo = {},
): Promise<SettledRead> {
  const mono = io.monotonicMs ?? (() => performance.now());
  const wall = io.wallMs ?? (() => Date.now());
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const stat = io.stat ?? ((p: string) => statSync(p));
  const read = io.read ?? ((p: string) => readFileSync(p, "utf8"));

  const start = mono();
  let delay = Math.max(1, policy.initialDelayMs);
  let reads = 0;
  let lastSig: string | null = null;
  let stableSince = start;
  let stableLooks = 0;
  for (;;) {
    const look = lookAt(path, stat, read, wall);
    if (look.kind === "missing") return { kind: "missing", reads };
    reads++;
    let error: string;
    if (look.kind === "bytes") {
      try {
        return { kind: "parsed", value: JSON.parse(look.raw), reads, waited_ms: mono() - start };
      } catch (err) {
        error = String(err);
      }
    } else {
      error = `the file could not be read: ${look.error}`;
    }
    const now = mono();
    const waited = now - start;
    if (policy.windowMs <= 0)
      return { kind: "unparseable", error, reads, waited_ms: waited, why: "no_tolerance" };
    const { sig, mtimeAge } = look;
    if (sig !== lastSig) {
      lastSig = sig;
      stableSince = now;
      stableLooks = 1;
    } else {
      stableLooks++;
    }
    const stillFor = now - stableSince;
    if (
      stableLooks >= MIN_STABLE_LOOKS &&
      stillFor >= policy.settleMs &&
      mtimeAge >= policy.settleMs
    )
      return { kind: "unparseable", error, reads, waited_ms: waited, why: "settled" };
    if (waited >= policy.windowMs)
      return { kind: "unparseable", error, reads, waited_ms: waited, why: "window" };
    await sleep(Math.min(delay, Math.max(1, policy.windowMs - waited)));
    delay = Math.min(delay * 2, Math.max(1, policy.maxDelayMs));
  }
}

type Look =
  | { kind: "missing" }
  | { kind: "bytes"; raw: string; sig: string; mtimeAge: number }
  | { kind: "error"; error: string; sig: string; mtimeAge: number };

/** ENOENT is the one failure that means "no file here". */
function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/** One look: the file's signature and its bytes, or why they could not be had.
 * A read that fails on a file that is there (EISDIR, EACCES, EIO, …) is not
 * "missing" — a verdict path the watcher silently never consumes would wedge
 * its round with nothing ever said — so it is reported as an error and waited
 * out like unparseable bytes: transient ones clear, persistent ones are
 * declared at the same bounds. */
function lookAt(
  path: string,
  stat: (path: string) => { size: number; mtimeMs: number; ino: number },
  read: (path: string) => string,
  wall: () => number,
): Look {
  let st: { size: number; mtimeMs: number; ino: number };
  try {
    st = stat(path);
  } catch (err) {
    if (isMissing(err)) return { kind: "missing" };
    // No mtime to age: stillness under our own looks decides alone.
    const code = (err as NodeJS.ErrnoException | null)?.code ?? "unknown";
    return { kind: "error", error: String(err), sig: `stat-error:${code}`, mtimeAge: Infinity };
  }
  // Size alone misses a same-length rewrite; mtime alone misses a coarse
  // clock; the inode catches a rename onto the name.
  const sig = `${st.size}:${st.mtimeMs}:${st.ino}`;
  const mtimeAge = wall() - st.mtimeMs;
  try {
    return { kind: "bytes", raw: read(path), sig, mtimeAge };
  } catch (err) {
    if (isMissing(err)) return { kind: "missing" };
    return { kind: "error", error: String(err), sig, mtimeAge };
  }
}
