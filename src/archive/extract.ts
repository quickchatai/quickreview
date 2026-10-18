// `qcr archive extract <pr> --to <dir>` (docs/archiving.md §11,
// §15): one PR's archive decompressed into a scratch directory, every byte
// verified against the sha256 its manifest records. Read-only over the
// archive, and never into a live tree.
//
// Layout under `<to>/`:
//
//   transcripts/<name>.jsonl     each archived transcript gzip, decompressed
//                                (a `.v<k>` or `session-at-close-…` name kept)
//   files/<live path>            each state file too large for a bundle
//   state-<pass>/<live path>     each bundle's records, at the live path they
//                                were archived from (`same_as` resolved)
//   manifest.json, ledger.md,    copied as they are — plain, and carrying no
//   meta.json                    hash of their own
//
// Refused before anything is written: a `--to` inside the sandbox root (its
// live trees `state/`, the pi sessions root, `inject/` and `archive/`, and its
// code), inside any of those trees wherever a symlink puts them, or one that
// would CONTAIN any of them (`/`, the root's parent). Symlinks are resolved
// first. Below `--to`, no symlink is ever followed: every directory an
// extraction writes in is a plain directory under it, and temporary files are created in a
// fresh private directory beside the target, never at another output name. Nothing is ever
// overwritten: a file already there with the same bytes is left (a re-run is
// idempotent); one with other bytes is reported, never replaced.
//
// This runs in the CLI process, never in the daemon; it takes no lock (the
// archiver only appends to a manifest and never rewrites a placed gzip).
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rmdir,
  utimes,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readBundleRecords } from "./bundle.js";
import { fileDigest, gunzipToFile, renameNoReplace, unlinkIfPresent } from "./fsutil.js";
import { ManifestUnreadable, readManifestIfPresent, type Manifest } from "./manifest.js";
import { injectDirOf } from "./prfiles.js";

/** The suffix of a file being extracted (never left behind on a failure). */
export const EXTRACT_PARTIAL_SUFFIX = ".extract-partial";

export interface ExtractOptions {
  /** The sandbox root. */
  root: string;
  /** `<root>/<[pi] session_dir>`. */
  sessionsRoot: string;
  pr: number;
  /** The scratch directory (created when absent). */
  to: string;
  bytesPerS: number;
  signal?: AbortSignal;
}

export interface ExtractedFile {
  /** Relative to `--to`. */
  path: string;
  /** The archive file it came from, relative to the PR's archive dir. */
  from: string;
  bytes: number;
  sha256: string;
  /** `written` now, or `present` already with these exact bytes. */
  outcome: "written" | "present";
}

export type ExtractResult =
  | { ok: false; reason: string }
  | {
      ok: true;
      dir: string;
      files: ExtractedFile[];
      /** The plain files copied as they are (no hash to check them by). */
      copied: string[];
      /** Files that could not be extracted (verify failure, a different file
       * already at the target, an unsafe name) — the rest still were. */
      errors: Array<{ path: string; error: string }>;
    };

/** `p` with every existing prefix resolved through symlinks. */
async function realish(p: string): Promise<string> {
  const abs = resolve(p);
  const rest: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      const real = await realpath(cur);
      return rest.length > 0 ? join(real, ...rest.reverse()) : real;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const up = dirname(cur);
      if (up === cur) return abs;
      rest.push(basename(cur));
      cur = up;
    }
  }
}

const inside = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);

/**
 * Why `to` may not take an extraction, or null. Refused: inside the sandbox
 * root or any live tree (symlinks resolved), or containing any of them.
 */
export async function liveTreeRefusal(
  to: string,
  root: string,
  sessionsRoot: string,
): Promise<string | null> {
  const target = await realish(to);
  // The most specific tree first, so the refusal names it; the root last.
  const trees: Array<[string, string]> = [
    ["the pi sessions root", sessionsRoot],
    ["state/", join(root, "state")],
    ["the wake drop-box root", dirname(injectDirOf(root, 0))],
    ["archive/", join(root, "archive")],
    ["the sandbox root", root],
  ];
  for (const [label, path] of trees) {
    const real = await realish(path);
    if (inside(target, real))
      return `--to ${to} is inside ${label} (${real}) — an extraction never goes into a live tree`;
    if (inside(real, target))
      return `--to ${to} contains ${label} (${real}) — an extraction never goes into a live tree`;
  }
  return null;
}

/** A name from the archive, safe to place under `to`: relative, no `..`. */
function safeUnder(to: string, rel: string): string | null {
  if (rel.length === 0 || rel.includes("\0") || isAbsolute(rel)) return null;
  if (rel.split(/[\\/]/).some((seg) => seg === "..")) return null;
  const target = resolve(to, rel);
  return inside(target, resolve(to)) && target !== resolve(to) ? target : null;
}

/**
 * The partial `target` is written through, made safe to create: every
 * directory from `to` down to the target's is created or found as a PLAIN
 * directory (a symlink there is refused, so a write never leaves `--to`).
 */
async function preparePartial(to: string, target: string): Promise<void> {
  const rel = relative(to, dirname(target));
  let cur = to;
  for (const seg of rel === "" ? [] : rel.split(sep)) {
    cur = join(cur, seg);
    try {
      await mkdir(cur);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    if (!(await lstat(cur)).isDirectory())
      throw new Error(`${cur} is not a plain directory — an extraction never follows a link`);
  }
}

/**
 * Write one target through its partial: `preparePartial`, then `write` (which
 * creates the partial and places it). Any failure removes the partial — never
 * through a directory that was refused — and is returned as its message; a
 * stop is thrown.
 */
async function throughPartial(
  to: string,
  target: string,
  signal: AbortSignal | undefined,
  write: (partial: string) => Promise<void>,
): Promise<string | null> {
  let staging: string | undefined;
  let partial: string | undefined;
  try {
    await preparePartial(to, target);
    staging = await mkdtemp(join(dirname(target), ".qcr-extract-"));
    partial = join(staging, `payload${EXTRACT_PARTIAL_SUFFIX}`);
    await write(partial);
    return null;
  } catch (err) {
    if (signal?.aborted) throw err;
    return (err as Error).message;
  } finally {
    if (partial) await unlinkIfPresent(partial).catch(() => false);
    if (staging) await rmdir(staging).catch(() => {});
  }
}

/** Place `partial` at `target` without replacing anything: a target already
 * holding the same bytes is `present`; one holding others is an error. */
async function place(
  partial: string,
  target: string,
  got: { bytes: number; sha256: string },
  mtimeMs: number | null,
  bytesPerS: number,
  signal?: AbortSignal,
): Promise<"written" | "present"> {
  if (mtimeMs !== null) await utimes(partial, mtimeMs / 1000, mtimeMs / 1000);
  if ((await renameNoReplace(partial, target)) === "placed") return "written";
  await unlinkIfPresent(partial);
  // What is there is read only when it is a plain file: a link is never
  // followed out of `--to`, and a FIFO never blocks the read.
  if (!(await lstat(target)).isFile())
    throw new Error(`${target} exists and is not a plain file — never followed or overwritten`);
  const there = await fileDigest(target, { bytesPerS, ...(signal ? { signal } : {}) });
  if (there.bytes === got.bytes && there.sha256 === got.sha256) return "present";
  throw new Error(`${target} already holds other bytes — never overwritten`);
}

/** Extract one PR's archive into `opts.to` (see the header). */
export async function extractPr(opts: ExtractOptions): Promise<ExtractResult> {
  const { root, pr, bytesPerS, signal } = opts;
  const refusal = await liveTreeRefusal(opts.to, root, opts.sessionsRoot);
  if (refusal) return { ok: false, reason: refusal };
  const dir = join(root, "archive", `pr-${pr}`);
  let manifest: Manifest | null;
  try {
    manifest = await readManifestIfPresent(dir);
  } catch (err) {
    if (err instanceof ManifestUnreadable) return { ok: false, reason: err.message };
    throw err;
  }
  if (manifest === null) {
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    return {
      ok: false,
      reason: names.some((n) => n.endsWith(".gz") || n === "transcripts")
        ? `${join(dir, "manifest.json")} is missing beside archived files — what they hold cannot be verified`
        : `pr-${pr} has no archive manifest — nothing of it was archived`,
    };
  }
  const to = resolve(opts.to);
  await mkdir(to, { recursive: true });
  const files: ExtractedFile[] = [];
  const errors: Array<{ path: string; error: string }> = [];

  // Each archive gzip once (a reused entry points at an existing one).
  const gzips = new Map<string, { bytes: number; sha256: string; mtime_ms: number }>();
  for (const e of manifest.entries)
    if ((e.kind === "transcript" || e.kind === "file") && !gzips.has(e.archive))
      gzips.set(e.archive, { bytes: e.bytes, sha256: e.sha256, mtime_ms: e.mtime_ms });
  for (const [archive, expect] of gzips) {
    signal?.throwIfAborted();
    const rel = archive.replace(/\.gz$/, "");
    const target = safeUnder(to, rel);
    if (!target || !archive.endsWith(".gz") || !safeUnder(dir, archive)) {
      errors.push({ path: archive, error: "an unsafe archive name — skipped" });
      continue;
    }
    const error = await throughPartial(to, target, signal, async (partial) => {
      const got = await gunzipToFile(join(dir, archive), partial, {
        bytesPerS,
        signal,
        exclusive: true,
      });
      if (got.bytes !== expect.bytes || got.sha256 !== expect.sha256)
        throw new Error(
          `${archive} decompressed to ${got.bytes} bytes / ${got.sha256.slice(0, 12)}…, the manifest records ${expect.bytes} / ${expect.sha256.slice(0, 12)}…`,
        );
      const outcome = await place(partial, target, got, expect.mtime_ms, bytesPerS, signal);
      files.push({ path: relative(to, target), from: archive, ...got, outcome });
    });
    if (error !== null) errors.push({ path: rel, error });
  }

  // Each bundle's records, under `state-<pass>/`.
  for (const e of manifest.entries) {
    if (e.kind !== "bundle") continue;
    signal?.throwIfAborted();
    const bundleDir = e.archive.replace(/\.jsonl\.gz$/, "");
    if (!safeUnder(dir, e.archive) || !safeUnder(to, bundleDir) || bundleDir === e.archive) {
      errors.push({ path: e.archive, error: "an unsafe bundle name — skipped" });
      continue;
    }
    let records: Awaited<ReturnType<typeof readBundleRecords>>;
    try {
      records = await readBundleRecords(join(dir, e.archive), null, {
        bytesPerS,
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      errors.push({ path: e.archive, error: `does not verify: ${(err as Error).message}` });
      continue;
    }
    for (const f of e.files) {
      const target = safeUnder(to, join(bundleDir, f.path));
      if (!target || !safeUnder(to, f.path)) {
        errors.push({ path: f.path, error: "an unsafe record path — skipped" });
        continue;
      }
      const rec = records.get(f.path);
      const sha = rec?.record.sha256 ?? null;
      if (!rec || rec.data.length !== f.bytes || sha !== f.sha256) {
        errors.push({
          path: relative(to, target),
          error: rec
            ? `${e.archive} holds ${rec.data.length} bytes / ${sha!.slice(0, 12)}… for it, the manifest records ${f.bytes} / ${f.sha256.slice(0, 12)}…`
            : `${e.archive} holds no record for ${f.path}`,
        });
        continue;
      }
      const error = await throughPartial(to, target, signal, async (partial) => {
        await writeFile(partial, rec.data, { flag: "wx" });
        const got = { bytes: rec.data.length, sha256: sha };
        const outcome = await place(partial, target, got, f.mtime_ms, bytesPerS, signal);
        files.push({ path: relative(to, target), from: e.archive, ...got, outcome });
      });
      if (error !== null) errors.push({ path: relative(to, target), error });
    }
  }

  // The plain record, as it is.
  const copied: string[] = [];
  for (const name of ["manifest.json", "ledger.md", "meta.json"]) {
    const src = join(dir, name);
    try {
      if (!(await lstat(src)).isFile()) continue;
    } catch {
      continue;
    }
    const target = join(to, name);
    const error = await throughPartial(to, target, signal, async (partial) => {
      await copyFile(src, partial, constants.COPYFILE_EXCL);
      const got = await fileDigest(partial, { bytesPerS, ...(signal ? { signal } : {}) });
      await place(partial, target, got, null, bytesPerS, signal);
      copied.push(name);
    });
    if (error !== null) errors.push({ path: name, error });
  }
  return { ok: true, dir: to, files, copied, errors };
}
