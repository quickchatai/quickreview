// The PI-GLOBAL store (S4, docs/archiving.md §5): pi's default
// global session store (`~/.pi/agent/sessions/`, the pihome volume) — the lens
// transcripts written before, when pass children ran without
// `--session-dir`, and any interactive pi run in the container. Since
// the children keep no session file, so nothing should add files here; what
// is there is history. `measureUsage` walks this tree at every round end
// (async since H2, but a stat per file all the same) and authwatch
// stats it every minute, so it leaves the live tree.
//
//   - A `*.jsonl` leaves once its mtime is more than `PI_GLOBAL_MIN_AGE_MS`
//     (a day) old: no round window is that long, and measureUsage reads only
//     files inside the running round's window. Anything younger, and any
//     other file, stays.
//   - Into `archive/pi-global/<path relative to the store>.gz`, under the same
//     per-file protocol and its own append-only manifest
//     (`archive/pi-global/manifest.json`, then `manifest-2.json`, … — sharded,
//     `STORE_SHARD_ENTRIES` entries each, so no write grows with the store's
//     history; `source`s are relative to the store, not the sandbox root —
//     the store lives on another volume).
//   - Emptied directories go with a non-recursive rmdir, deepest first; the
//     store's own directory never does.
//
// Nothing is restored from here (nothing reads it live). Daemon bookkeeping
// only (rule 9).
import { rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import type { FileIdentity } from "./fsutil.js";
import { identityOrNull } from "./gzfile.js";
import { walkFiles } from "./prfiles.js";
import {
  StoreWriter,
  emptyStoreResult,
  type StoreFile,
  type StorePassDeps,
  type StorePassResult,
  type StoreTally,
  unlinkStopOf,
} from "./storepass.js";

/** The archive dir's (and the manifest subject's) name. */
export const PI_GLOBAL_STORE = "pi-global";

/** A file must be at least this old to leave the global store. */
export const PI_GLOBAL_MIN_AGE_MS = 86_400_000;

/** pi's default global session store under this process's home (in the
 * container, the pihome volume) — the one the auth watch also reads. */
export function piGlobalSessionsDir(): string {
  return join(homedir(), ".pi", "agent", "sessions");
}

/** The store's `*.jsonl` files, split by the age rule. */
async function listPiGlobal(
  storeDir: string,
  nowMs: number,
  signal?: AbortSignal,
  measure: <T>(fn: () => T) => T = (fn) => fn(),
): Promise<{
  old: Array<{ path: string; id: FileIdentity }>;
  young: Array<{ path: string; id: FileIdentity }>;
  dirs: string[];
}> {
  const paths: string[] = [];
  const dirs: string[] = [];
  await walkFiles(storeDir, paths, signal, dirs);
  const cutoff = nowMs - PI_GLOBAL_MIN_AGE_MS;
  const old: Array<{ path: string; id: FileIdentity }> = [];
  const young: Array<{ path: string; id: FileIdentity }> = [];
  for (const p of paths) {
    if (!p.endsWith(".jsonl")) continue;
    const id = await identityOrNull(p);
    if (!id) continue;
    (id.mtimeMs < cutoff ? old : young).push({ path: p, id });
  }
  // One synchronous span that grows with the store: measured.
  measure(() => old.sort((a, b) => a.id.mtimeMs - b.id.mtimeMs || a.path.localeCompare(b.path)));
  return { old, young, dirs };
}

/** pi's global store as the plan sees it (read-only). */
export async function measurePiGlobal(deps: {
  storeDir: string;
  now: () => Date;
  signal?: AbortSignal;
}): Promise<StoreTally> {
  try {
    const { old, young } = await listPiGlobal(deps.storeDir, deps.now().getTime(), deps.signal);
    const all = [...old, ...young];
    return {
      state: "measured",
      files: all.length,
      bytes: all.reduce((n, f) => n + f.id.size, 0),
      movable_files: old.length,
      movable_bytes: old.reduce((n, f) => n + f.id.size, 0),
      legacy_copies: 0,
      legacy_bytes: 0,
    };
  } catch (err) {
    if (deps.signal?.aborted) throw err;
    return { state: "unreadable", error: (err as Error).message };
  }
}

export interface PiGlobalPassDeps extends Omit<StorePassDeps, "dir" | "subject" | "liveOf"> {
  root: string;
  /** pi's global session store (`~/.pi/agent/sessions`). */
  storeDir: string;
}

/** One pi-global pass. Never throws for a refusal; an unexpected I/O failure
 * throws, and the next pass resumes. */
export async function archivePiGlobal(deps: PiGlobalPassDeps): Promise<StorePassResult> {
  const { storeDir } = deps;
  const {
    old,
    young: youngFiles,
    dirs,
  } = await listPiGlobal(storeDir, deps.now().getTime(), deps.signal, (fn) =>
    deps.meter ? deps.meter.measure(fn) : fn(),
  );
  const young = youngFiles.length;
  if (old.length === 0) {
    const r = emptyStoreResult("none");
    r.keptLive = young;
    return r;
  }
  const writer = await StoreWriter.open({
    ...deps,
    dir: join(deps.root, "archive", PI_GLOBAL_STORE),
    subject: PI_GLOBAL_STORE,
    liveOf: (source) => join(storeDir, source),
  });
  if (!writer) return emptyStoreResult("held", "manifest_unreadable");
  const res = writer.result;
  res.keptLive = young;
  const files: StoreFile[] = old.map((o) => {
    const source = relative(storeDir, o.path);
    return { path: o.path, source, archive: `${source}.gz`, identity: o.id };
  });
  const pass = await writer.archiveAll(files);
  // A file older than a day stays older than a day: the identity check
  // before each unlink (an appended file has a new size and mtime) is the
  // re-check. None once a restore waits for the mutex.
  const { removed, stop: unlinkStop } = await writer.unlinkAll(pass.unlinks, () =>
    deps.signal.aborted ? "stopping" : unlinkStopOf(deps.stopReason()),
  );
  await writer.finish(removed, []);
  // Emptied directories, deepest first, never recursively, never the store.
  if (removed.size > 0)
    for (const d of [...dirs].reverse())
      try {
        await rmdir(d);
      } catch {
        /* not empty (or gone): it stays */
      }
  const stop = pass.stop ?? unlinkStop;
  const incomplete = pass.incomplete || pass.unlinks.some((u) => !removed.has(u.source));
  res.outcome = stop || incomplete ? "partial" : "done";
  res.reason =
    stop ?? (incomplete ? (res.verifyFailures > 0 ? "verify_failed" : "incomplete") : null);
  return res;
}
