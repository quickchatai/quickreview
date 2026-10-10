// The OVERSEER store (docs/archiving.md §5, §7.5): the overseer's
// transcripts that are no longer current, out of
// `<[pi] session_dir>/overseer/` into `archive/overseer/transcripts/`, and
// the legacy uncompressed `archive/overseer/<date>/session.jsonl` rotation
// copies removed once proven duplicates.
//
//   - The CURRENT file is never archived. A file leaves only when its mtime
//     predates the current birth (`born_at` of the overseer's birth record)
//     by more than `CURRENT_SLACK_MS`, and the newest file never leaves,
//     whatever its mtime. pi never reopens an old file (no continue flag);
//     each overseer birth starts a fresh one. A birth that cannot be read is
//     UNKNOWN: nothing moves (`birth_unknown`), never a guess.
//   - Each archived file is named by its own source name, so two rotations
//     on one day never overwrite each other's record.
//   - A legacy copy is compared with the transcript its `meta.json` names
//     (`session_file`, by path under this root, else by file name) once that
//     transcript is archived: equal, or a byte-prefix (the copy was taken
//     before the tmux kill), and it is removed with a `duplicate_removed`
//     entry. A copy whose transcript is still live waits. One that matches
//     nothing is gzipped under the same protocol as
//     `transcripts/session-at-close-<stamp>.jsonl.gz` (`legacy`), then
//     removed. `ledger.md` and `meta.json` beside it stay, plain.
//
// Daemon bookkeeping only (rule 9): nothing here spawns, injects, wakes or
// kills a session — the overseer session is never touched, only files it
// stopped writing.
import { readFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { fileDigestWithPrefix, identityOrNull } from "./gzfile.js";
import type { FileIdentity } from "./fsutil.js";
import type { DuplicateEntry } from "./manifest.js";
import { listDir, walkFiles } from "./prfiles.js";
import {
  StoreWriter,
  archiveFileSize,
  emptyStoreResult,
  type StoreFile,
  type StorePassDeps,
  type StorePassResult,
  type StoreTally,
  type StoreUnlink,
  unlinkStopOf,
} from "./storepass.js";

/** The overseer session's name — its `--session-dir` subdir and its archive
 * dir both carry it. */
export const OVERSEER_STORE = "overseer";

/** A file written within this long before the current birth may still be
 * the current one (pi creates its file as it starts): it stays live. */
export const CURRENT_SLACK_MS = 60_000;

/** A rotation's record dir: `YYYY-MM-DD`, or `YYYY-MM-DD-<k>` for a second
 * rotation the same day. */
export const ROTATION_DIR = /^\d{4}-\d{2}-\d{2}(?:-\d+)?$/;

export interface OverseerPassDeps extends Omit<StorePassDeps, "dir" | "subject" | "liveOf"> {
  root: string;
  /** `<root>/<[pi] session_dir>`. */
  sessionsRoot: string;
  /** When the current overseer was born; null = unknown (nothing moves). */
  bornAt: () => Date | null;
}

const stampOf = (ms: number): string =>
  new Date(ms)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

/** A rotation record's `meta.json`: the live transcript it named, and when. */
async function metaOf(
  dir: string,
): Promise<{ session_file: string | null; archived_at: string | null }> {
  try {
    const m = JSON.parse(await readFile(join(dir, "meta.json"), "utf8")) as Record<string, unknown>;
    return {
      session_file: typeof m.session_file === "string" ? m.session_file : null,
      archived_at: typeof m.archived_at === "string" ? m.archived_at : null,
    };
  } catch {
    return { session_file: null, archived_at: null };
  }
}

const validBirth = (d: Date | null): d is Date => d !== null && Number.isFinite(d.getTime());

/** The overseer's live transcripts, oldest first. Throws when the dir
 * cannot be walked (an unreadable listing is never "nothing there"). */
async function listOverseer(
  sessionsRoot: string,
  signal?: AbortSignal,
): Promise<Array<{ path: string; id: FileIdentity }>> {
  const paths: string[] = [];
  await walkFiles(join(sessionsRoot, OVERSEER_STORE), paths, signal);
  const live: Array<{ path: string; id: FileIdentity }> = [];
  for (const p of paths) {
    if (!p.endsWith(".jsonl")) continue;
    const id = await identityOrNull(p);
    if (id) live.push({ path: p, id });
  }
  live.sort((a, b) => a.id.mtimeMs - b.id.mtimeMs || a.path.localeCompare(b.path));
  return live;
}

/** The files a pass may move (§5): never the newest, never one written
 * within CURRENT_SLACK_MS of the current birth or after it. */
export function overseerMovable<T extends { path: string; id: FileIdentity }>(
  live: readonly T[],
  born: Date,
): T[] {
  const newest = live.at(-1)?.path;
  const cutoff = born.getTime() - CURRENT_SLACK_MS;
  return live.filter((f) => f.path !== newest && f.id.mtimeMs < cutoff);
}

/** The legacy rotation copies `archive/overseer/<date>/session.jsonl`. */
async function legacyCopies(
  dir: string,
): Promise<Array<{ path: string; recordDir: string; size: number }>> {
  const out: Array<{ path: string; recordDir: string; size: number }> = [];
  for (const e of await listDir(dir)) {
    if (!e.isDirectory() || !ROTATION_DIR.test(e.name)) continue;
    const copy = join(dir, e.name, "session.jsonl");
    const id = await identityOrNull(copy);
    if (id) out.push({ path: copy, recordDir: join(dir, e.name), size: id.size });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** The overseer store as the plan sees it (read-only). */
export async function measureOverseer(deps: {
  root: string;
  sessionsRoot: string;
  bornAt?: () => Date | null;
  signal?: AbortSignal;
}): Promise<StoreTally> {
  try {
    const live = await listOverseer(deps.sessionsRoot, deps.signal);
    const legacy = await legacyCopies(join(deps.root, "archive", OVERSEER_STORE));
    const born = deps.bornAt?.() ?? null;
    const movable = validBirth(born) ? overseerMovable(live, born) : null;
    return {
      state: "measured",
      files: live.length,
      bytes: live.reduce((n, f) => n + f.id.size, 0),
      movable_files: movable ? movable.length : null,
      movable_bytes: movable ? movable.reduce((n, f) => n + f.id.size, 0) : null,
      legacy_copies: legacy.length,
      legacy_bytes: legacy.reduce((n, l) => n + l.size, 0),
    };
  } catch (err) {
    if (deps.signal?.aborted) throw err;
    return { state: "unreadable", error: (err as Error).message };
  }
}

/** One overseer pass. Never throws for a refusal (held/partial say why); an
 * unexpected I/O failure throws, and the next pass resumes. */
export async function archiveOverseer(deps: OverseerPassDeps): Promise<StorePassResult> {
  const { root } = deps;
  const born = deps.bornAt();
  if (!validBirth(born)) return emptyStoreResult("held", "birth_unknown");
  const sessionDir = join(deps.sessionsRoot, OVERSEER_STORE);
  const dir = join(root, "archive", OVERSEER_STORE);

  // The live transcripts, oldest first; the newest and the current birth's
  // stay.
  const live = await listOverseer(deps.sessionsRoot, deps.signal);
  const candidates = overseerMovable(live, born);

  // The legacy rotation copies.
  const legacy = await legacyCopies(dir);

  if (candidates.length === 0 && legacy.length === 0) {
    const r = emptyStoreResult("none");
    r.keptLive = live.length;
    return r;
  }

  const writer = await StoreWriter.open({
    ...deps,
    dir,
    subject: OVERSEER_STORE,
    liveOf: (source) => join(root, source),
  });
  if (!writer) return emptyStoreResult("held", "manifest_unreadable");
  const res = writer.result;
  res.keptLive = live.length - candidates.length;

  const files: StoreFile[] = candidates.map((c) => ({
    path: c.path,
    source: relative(root, c.path),
    archive: `transcripts/${relative(sessionDir, c.path)}.gz`,
    identity: c.id,
  }));
  const pass = await writer.archiveAll(files);
  let stop = pass.stop;
  let incomplete = pass.incomplete;
  /** Legacy copies whose transcript is still live: they wait, by design. */
  let waits = 0;
  const unlinks: StoreUnlink[] = [...pass.unlinks];

  // The legacy copies (§7.5): proven duplicates removed, the rest kept as
  // gzips and then removed.
  const duplicates: Array<{
    path: string;
    id: FileIdentity;
    entry: Omit<DuplicateEntry, "pass" | "removed_at">;
  }> = [];
  for (const l of stop ? [] : legacy) {
    stop = deps.stopReason();
    if (stop) break;
    const id = await identityOrNull(l.path);
    if (!id) continue;
    const meta = await metaOf(l.recordDir);
    const target = namedTranscript(meta.session_file, root, writer, live);
    if (target === "live") {
      // The transcript it copies is still live (current, or not archived
      // yet): it waits for the pass that archives it.
      waits += 1;
      continue;
    }
    if (target) {
      const match = await compareLegacy(l.path, id, target, dir, deps);
      if (match) {
        duplicates.push({
          path: l.path,
          id,
          entry: {
            kind: "duplicate_removed",
            path: relative(dir, l.path),
            bytes: id.size,
            sha256: match.sha256,
            duplicate_of: target.archive,
            match: match.match,
          },
        });
        continue;
      }
    }
    // Matched nothing: kept, as a gzip under the protocol, then removed.
    const source = relative(root, l.path);
    const held = await writer.alreadyHeld({ path: l.path, source, archive: "", identity: id });
    if (held) {
      unlinks.push({ path: l.path, source, identity: identityFields(id) });
      continue;
    }
    const disk = await deps.diskFor(id.size);
    if (disk) {
      stop = disk;
      break;
    }
    const at = Date.parse(meta.archived_at ?? "");
    const f: StoreFile = {
      path: l.path,
      source,
      archive: `transcripts/session-at-close-${stampOf(Number.isFinite(at) ? at : id.mtimeMs)}.jsonl.gz`,
      identity: id,
    };
    const entryOf = writer.transcriptEntry(f, { legacy: true });
    const out = await writer.archiveOne(f, entryOf);
    if (out === "verify_failed" || out === "changed") {
      incomplete = true;
      continue;
    }
    await writer.append(
      entryOf(out.dest, {
        ...identityFields(id),
        sha256: out.ok.sha256,
        gz_bytes: out.ok.gzBytes,
      }),
    );
    res.bytesIn += out.ok.bytes;
    res.bytesOut += out.ok.gzBytes;
    unlinks.push({ path: l.path, source, identity: identityFields(id) });
  }

  // The unlinks — each only while the birth is still readable (a file that
  // was not current under one birth is not current under a later one), and
  // none once a restore waits for the mutex.
  const allowed = (): string | null => {
    if (deps.signal.aborted) return "stopping";
    const stop = unlinkStopOf(deps.stopReason());
    if (stop) return stop;
    return validBirth(deps.bornAt()) ? null : "birth_unknown";
  };
  const { removed, stop: unlinkStop } = await writer.unlinkAll(unlinks, allowed);
  const removedDuplicates: Array<Omit<DuplicateEntry, "pass" | "removed_at">> = [];
  if (!unlinkStop)
    for (const d of duplicates) {
      if (allowed()) break;
      if (await writer.removeDuplicate(d.path, d.id)) removedDuplicates.push(d.entry);
      else incomplete = true;
    }
  await writer.finish(removed, removedDuplicates);

  stop = stop ?? unlinkStop;
  if (unlinks.some((u) => !removed.has(u.source))) incomplete = true;
  if (removedDuplicates.length < duplicates.length) incomplete = true;
  res.outcome = stop || incomplete || waits > 0 ? "partial" : "done";
  res.reason =
    stop ??
    (incomplete
      ? res.verifyFailures > 0
        ? "verify_failed"
        : "incomplete"
      : waits > 0
        ? "legacy_copy_waits"
        : null);
  return res;
}

const identityFields = (id: FileIdentity) => ({
  bytes: id.size,
  mtime_ms: id.mtimeMs,
  dev: id.dev,
  ino: id.ino,
});

/**
 * The transcript a legacy copy names: its archived record (by path under this
 * root, else by file name); "live" when that transcript is still in the live
 * tree and not archived yet; null when it is nowhere — the copy then matches
 * nothing.
 */
function namedTranscript(
  sessionFile: string | null,
  root: string,
  writer: StoreWriter,
  live: ReadonlyArray<{ path: string }>,
): { source: string; archive: string; bytes: number; sha256: string } | "live" | null {
  if (!sessionFile) return null;
  const records = [...writer.records().values()].filter(
    (r) => r.via === "archive" && r.kind === "transcript" && !r.legacy,
  );
  const rel = relative(root, sessionFile);
  const name = basename(sessionFile);
  const rec =
    records.find((r) => r.source === rel) ?? records.find((r) => basename(r.source) === name);
  // Archived (in an earlier pass, or in this one with its unlink still to
  // come): the verified gzip is what the copy is compared with.
  if (rec)
    return { source: rec.source, archive: rec.archive, bytes: rec.bytes, sha256: rec.sha256 };
  const stillLive = live.some((f) => relative(root, f.path) === rel || basename(f.path) === name);
  return stillLive ? "live" : null;
}

/** Is the legacy copy the named transcript, whole or as a byte-prefix? Read
 * from the archived gzip (decompressed), never from a live file. */
async function compareLegacy(
  copy: string,
  id: FileIdentity,
  target: { archive: string; bytes: number; sha256: string },
  dir: string,
  deps: OverseerPassDeps,
): Promise<{ match: "exact" | "prefix"; sha256: string } | null> {
  if ((await archiveFileSize(dir, target.archive)) === null) return null;
  const src = await fileDigestWithPrefix(join(dir, target.archive), {
    bytesPerS: deps.bytesPerS,
    signal: deps.signal,
    prefixBytes: id.size,
    gz: true,
  });
  const mine = await fileDigestWithPrefix(copy, { bytesPerS: deps.bytesPerS, signal: deps.signal });
  if (src.bytes !== target.bytes || src.sha256 !== target.sha256) return null;
  if (mine.bytes === src.bytes && mine.sha256 === src.sha256)
    return { match: "exact", sha256: mine.sha256 };
  if (mine.bytes < src.bytes && mine.sha256 === src.prefixSha256)
    return { match: "prefix", sha256: mine.sha256 };
  return null;
}
