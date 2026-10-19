// ONE PR'S ARCHIVE PASS (docs/archiving.md §7): its live files into
// `archive/pr-<n>/`, verified, then — and only then — out of the live tree.
//
//   1. The ONE eligibility rule, fresh (the plan may be minutes old).
//   2. The PR's inventory (`prfiles.ts`) and its manifest. A manifest that
//      cannot be read holds the PR — it is never overwritten.
//   3. The `archive_prs` row is committed — `archiving`, with the newest
//      original mtime among the transcripts about to move — BEFORE the first
//      byte leaves: from here the receipt guard reads an archived receipt as
//      UNKNOWN, never as absent (§8.1).
//   4. Each transcript through the per-file protocol (`gzfile.ts`), one at a
//      time, its manifest entry appended after its rename. A source the
//      manifest already holds with the SAME identity is not read again (a
//      re-run after a crash, or a re-archive of a restored file — that one
//      gets a `reused` entry, never a second gzip). One whose identity moved
//      with its bytes unchanged is compressed, found equal (sha256, length)
//      to the source's earlier entry, and its new gzip dropped for a `reused`
//      entry too (`commitPacked`).
//   5. The small files as ONE bundle (`bundle.ts`), the ledger snapshotted.
//   6. The legacy `archive/pr-<n>/session.jsonl`: a verified duplicate (whole,
//      or a byte-prefix) of the transcript `meta.json` names is removed, its
//      `duplicate_removed` entry committed BEFORE the unlink; anything else is
//      gzipped and kept (§7.5).
//   7. Eligibility again, in two steps: the async tmux probe and inject
//      listing, then — synchronously, before EACH unlink — the registry, the
//      births and every database clause. A reopen at any point stops the
//      unlinks.
//   8. Each source unlinked only if its identity is still the one hashed;
//      then the manifest stamped, emptied directories removed with a
//      NON-recursive rmdir, and the row `archived` once nothing is left live.
//      The row's counts are the manifest's (`rowTallies`), never this pass's
//      own sums — a pass a crash or a throw cut short leaves files the pass
//      that completes only reuses, and those must still be counted.
//
// Between files the pass asks whether it must stop (the tick budget, a hold,
// a restore waiting for the mutex, `stop()` — between two unlinks only the
// last two, as a store pass does); a stopped PR stays `archiving`
// and the next pass resumes it — every step is idempotent. Disk is checked
// before each file (§7.7). Nothing here spawns, injects, wakes or kills a
// session (rule 9), and nothing reads or writes memory.
import {
  prepareDuplicateCount,
  finishDuplicateCount,
  recoverDuplicateCounts,
} from "./duplicatecounts.js";
import { mkdir, readdir, rmdir } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import type { StateStore } from "../state.js";
import { yieldToLoop } from "../yieldloop.js";
import {
  BUNDLE_RECORD_MAX_BYTES,
  readBundleRecords,
  writeBundle,
  type BundleSource,
} from "./bundle.js";
import {
  archiveFileSize,
  archiveStamp,
  bundleName,
  bundlePassOf,
  bytesHeld,
  freshPassId,
  heldAsRecorded,
  identityFields,
  legacyArchiveName,
  legacyMatch,
  packedOf,
  placeArchive,
  placementOutcome,
  readSessionMeta,
  sameRecorded,
  unlinkStopOf,
  type Packed,
} from "./archivewrite.js";
import { prEligibility, type OutsideFacts } from "./eligibility.js";
import { fsyncDir, sameIdentity, unlinkIfPresent, type FileIdentity } from "./fsutil.js";
import {
  fileDigestWithPrefix,
  identityOrNull,
  sweepPartials,
  unlinkIfIdentity,
  type ArchiveFileOk,
  type StepFn,
} from "./gzfile.js";
import {
  ManifestUnreadable,
  cloneManifest,
  readManifest,
  referencedArchives,
  rowTallies,
  settledIndex,
  stampedBundleSources,
  writeManifest,
  type BundleFile,
  type FileEntry,
  type Manifest,
  type SettledRecord,
} from "./manifest.js";
import { OWN_GZIP_CLASSES, prInventory, type LiveListing, type SpanMeter } from "./prfiles.js";
import { armArchiveRow, finishArchiveRow } from "./rows.js";

export interface PrPassDeps {
  store: StateStore;
  root: string;
  sessionsRoot: string;
  /** This pass's listing of the live tree (one readdir per directory). */
  listing: LiveListing;
  now: () => Date;
  afterDays: number;
  level: number;
  bytesPerS: number;
  signal: AbortSignal;
  /** Fresh outside facts for the eligibility rule: tmux (asked, bounded) and
   * the PR's top-level inject files. `birthInFlight` is ignored — births are
   * read synchronously through `birthInFlight` below. */
  outside: (pr: number) => Promise<OutsideFacts>;
  birthInFlight: (pr: number) => boolean;
  /** Free space for one file of `bytes` on both mounts: null = room. */
  diskFor: (bytes: number) => Promise<"disk_low" | "disk_unknown" | null>;
  /** Why no new file may start now; null = go on. */
  stopReason: () => string | null;
  /** The quiet `archive_verify_failed` anomaly, once per incident. */
  verifyFailed: (key: string, detail: string) => void;
  log: (msg: string, extra?: unknown) => void;
  meter: SpanMeter;
  /** Crash-injection seam (tests): called after each protocol step. */
  step?: StepFn;
}

export interface PrPassResult {
  pr: number;
  /** `archived` — nothing of the PR left live; `partial` — the pass stopped
   * (budget, hold, restore, a changed source, a verify failure) and the next
   * resumes; `held` — the eligibility rule or the manifest stopped it (a
   * reopen between two unlinks too: what left before it stays left, on the
   * record). */
  outcome: "archived" | "partial" | "held";
  reason: string | null;
  transcripts: number;
  reused: number;
  stateFiles: number;
  bytesIn: number;
  bytesOut: number;
  removed: number;
  duplicatesRemoved: number;
  verifyFailures: number;
  staleInjects: string[];
}

/** What a later unlink needs: the live path and the identity hashed. */
interface Unlink {
  path: string;
  rel: string;
  identity: { dev: number | null; ino: number | null; bytes: number; mtime_ms: number };
}

/** Non-recursive rmdir: an emptied dir goes, anything else stays. */
async function rmdirQuiet(dir: string): Promise<boolean> {
  try {
    await rmdir(dir);
    return true;
  } catch {
    return false;
  }
}

/** Archive one PR. Never throws for a refusal (held/partial say why); an
 * unexpected I/O failure throws and leaves the row `archiving` (the guard
 * armed) for the next pass. */
export async function archivePr(deps: PrPassDeps, pr: number): Promise<PrPassResult> {
  const { store, root, signal } = deps;
  const res: PrPassResult = {
    pr,
    outcome: "partial",
    reason: null,
    transcripts: 0,
    reused: 0,
    stateFiles: 0,
    bytesIn: 0,
    bytesOut: 0,
    removed: 0,
    duplicatesRemoved: 0,
    verifyFailures: 0,
    staleInjects: [],
  };
  const held = (reason: string): PrPassResult => ({ ...res, outcome: "held", reason });
  const now = (): string => deps.now().toISOString();
  const eligibility = (facts: OutsideFacts) =>
    deps.meter.measure(() =>
      prEligibility(store, pr, {
        now: deps.now(),
        afterDays: deps.afterDays,
        outside: { ...facts, birthInFlight: deps.birthInFlight(pr) },
      }),
    );

  // 1. The one rule, fresh.
  let facts = await deps.outside(pr);
  const e = eligibility(facts);
  if (!e.eligible) return held(e.reason ?? "ineligible");
  res.staleInjects = e.stale_injects.map((f) => relative(root, f));

  // 2. Inventory and manifest.
  const inv = await prInventory(deps.listing, pr, {
    store,
    root,
    staleInjects: e.stale_injects,
    signal,
    meter: deps.meter,
  });
  const dir = inv.archiveDir;
  const subject = `pr-${pr}`;
  // A `.partial` here now is a leftover (a crash, or a pass that failed): only
  // this pass writes this dir, under the archiver's strict mutex.
  await sweepPartials(dir);
  let manifest: Manifest;
  try {
    manifest = await readManifest(dir, subject);
  } catch (err) {
    if (!(err instanceof ManifestUnreadable)) throw err;
    deps.verifyFailed(
      `manifest:${pr}`,
      `archive pr-${pr}: ${err.message} — the PR is held and its manifest left as found`,
    );
    return held("manifest_unreadable");
  }
  res.duplicatesRemoved += await recoverDuplicateCounts(store, pr, join(dir, "session.jsonl"));
  let index = settledIndex(manifest);
  const sessionDir = join(deps.sessionsRoot, subject);

  // Identities of the transcripts, for the guard's mtime.
  const transcripts: Array<{ path: string; rel: string; id: FileIdentity }> = [];
  for (const t of inv.transcripts) {
    const id = await identityOrNull(t.path);
    if (id) transcripts.push({ path: t.path, rel: relative(root, t.path), id });
  }
  transcripts.sort((a, b) => a.id.mtimeMs - b.id.mtimeMs || a.rel.localeCompare(b.rel));
  const maxMtime = transcripts.reduce<number | null>(
    (m, t) => (m === null || t.id.mtimeMs > m ? t.id.mtimeMs : m),
    null,
  );

  // 3. Arm the guard before the first byte leaves.
  const startedAt = now();
  armArchiveRow(store, pr, { at: startedAt, maxMtimeMs: maxMtime });

  // The pass id names the bundle: unique among the manifest's passes and the
  // bundles on disk.
  let onDisk: string[] = [];
  try {
    onDisk = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const passBase = archiveStamp(deps.now());
  const taken = new Set([
    ...manifest.passes.map((p) => p.id),
    ...onDisk.flatMap((f) => bundlePassOf(f, true) ?? []),
  ]);
  const passId = freshPassId(passBase, (id) => taken.has(id));
  let passRecorded = manifest.passes.some((p) => p.id === passId);

  /** Append to the manifest: append-only, durable before the next step. */
  const commit = async (mutate: (m: Manifest) => void): Promise<void> => {
    const next = deps.meter.measure(() => {
      const copy = cloneManifest(manifest);
      if (!passRecorded)
        copy.passes.push({
          id: passId,
          kind: "archive",
          started_at: startedAt,
          closed_at: e.closed_at,
        });
      mutate(copy);
      return copy;
    });
    await mkdir(dir, { recursive: true });
    await writeManifest(dir, manifest, next, deps.meter);
    manifest = next;
    passRecorded = true;
    index = deps.meter.measure(() => settledIndex(manifest));
  };

  // An orphan bundle (a crash between its rename and its entry): verified,
  // then adopted with the identities of the sources that still match it.
  const referenced = referencedArchives(manifest);
  for (const name of onDisk) {
    const orphanPass = bundlePassOf(name);
    if (orphanPass === null || referenced.has(name)) continue;
    let records: Awaited<ReturnType<typeof readBundleRecords>>;
    try {
      records = await readBundleRecords(join(dir, name), null, {
        bytesPerS: deps.bytesPerS,
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw err;
      deps.verifyFailed(
        `orphan:${pr}:${name}`,
        `archive pr-${pr}: ${name} has no manifest entry and does not verify (${(err as Error).message}) — left as found, the PR held`,
      );
      return held("orphan_unverified");
    }
    const files: BundleFile[] = [];
    let bytes = 0;
    for (const { record, data } of records.values()) {
      const live = join(root, record.path);
      const id = await identityOrNull(live);
      let matched = false;
      if (id && id.size === record.bytes) {
        const digest = await fileDigestWithPrefix(live, { bytesPerS: deps.bytesPerS, signal });
        matched = digest.sha256 === record.sha256 && sameIdentity(id, await identityOrNull(live));
      }
      bytes += data.length;
      files.push({
        path: record.path,
        bytes: record.bytes,
        mtime_ms: matched && id ? id.mtimeMs : record.mtime_ms,
        dev: matched && id ? id.dev : null,
        ino: matched && id ? id.ino : null,
        sha256: record.sha256,
        class: record.class,
        ...(record.snapshot ? { snapshot: true as const } : {}),
        ...(record.session_command ? { session_command: record.session_command } : {}),
      });
    }
    const gz = (await archiveFileSize(dir, name)) ?? 0;
    await commit((next) => {
      if (!next.passes.some((p) => p.id === orphanPass))
        next.passes.push({
          id: orphanPass,
          kind: "archive",
          started_at: null,
          recovered_at: now(),
        });
      next.entries.push({
        pass: orphanPass,
        kind: "bundle",
        archive: name,
        records: files.length,
        bytes,
        gz_bytes: gz,
        verified_at: now(),
        files,
        adopted: true,
      });
    });
    deps.log(`archive: pr-${pr} — adopted the orphan bundle ${name} (${files.length} record(s))`);
  }

  const unlinks: Unlink[] = [];
  let stop: string | null = null;
  let incomplete = false;

  // The legacy copy compares against ONE transcript: meta.json's
  // session_file, else the newest (§7.5).
  const legacyCmp = inv.legacy ? await legacySource(dir, root, transcripts, index) : null;
  let legacySrc: { bytes: number; sha256: string; prefixSha256: string | null } | null = null;

  /**
   * One file through the protocol (`placeArchive`): its base name while no
   * entry references that, else the first `.v<k>` no entry references (§7.6)
   * — a name that EXISTS on disk unreferenced is an orphan a crash left
   * between a rename and its entry, adopted, kept under its own entry
   * (`entryOf`) or redone there, never skipped.
   */
  const archiveOne = async (
    path: string,
    rel: string,
    id: FileIdentity,
    baseRel: string,
    prefixBytes: number | undefined,
    entryOf: (archive: string, p: Packed) => FileEntry,
  ): Promise<{ ok: ArchiveFileOk; dest: string } | "verify_failed" | "changed"> => {
    const r = await placeArchive({
      path,
      dir,
      base: baseRel,
      source: rel,
      who: subject,
      opts: {
        level: deps.level,
        bytesPerS: deps.bytesPerS,
        signal,
        identity: id,
        ...(prefixBytes !== undefined ? { prefixBytes } : {}),
        ...(deps.step ? { step: deps.step } : {}),
      },
      refs: () => referencedArchives(manifest),
      heldAlready: (sha256, bytes) => bytesHeld(manifest.entries, dir, sha256, bytes),
      keep: (dest, p) => commit((next) => next.entries.push(entryOf(dest, p))),
      log: (m) => deps.log(m),
    });
    return placementOutcome(r, (detail) => {
      res.verifyFailures += 1;
      deps.verifyFailed(`file:${pr}:${rel}`, `archive pr-${pr}: ${detail} — the source is kept`);
    });
  };

  /**
   * The entry for a freshly verified gzip at `dest` — unless an earlier entry
   * of the SAME source already holds these exact bytes (sha256 and length) in
   * an archive file on disk. Then the new gzip is a proven duplicate: it is
   * removed and a `reused` entry points at the one already there, so a file
   * whose identity changed with its bytes unchanged (a restore that died
   * before recording it, a tree copy or migration that renumbered every
   * inode) is never stored twice. The gzip goes first: a crash before the
   * entry leaves the source unrecorded, and the next pass converges here
   * again. Returns how it was recorded.
   */
  const commitPacked = async (
    rel: string,
    dest: string,
    p: Packed,
    entryOf: (archive: string, p: Packed) => FileEntry,
  ): Promise<"new" | "reused"> => {
    let held: FileEntry | null = null;
    for (const e of manifest.entries)
      if (
        (e.kind === "transcript" || e.kind === "file") &&
        !e.reused &&
        e.source === rel &&
        e.archive !== dest &&
        e.sha256 === p.sha256 &&
        e.bytes === p.bytes &&
        (await archiveFileSize(dir, e.archive)) !== null
      ) {
        held = e;
        break;
      }
    if (!held) {
      await commit((next) => next.entries.push(entryOf(dest, p)));
      return "new";
    }
    const same = held;
    await unlinkIfPresent(join(dir, dest));
    await fsyncDir(dirname(join(dir, dest)));
    await commit((next) =>
      next.entries.push({
        ...entryOf(same.archive, { ...p, gz_bytes: same.gz_bytes }),
        reused: true,
      }),
    );
    res.reused += 1;
    deps.log(
      `archive: pr-${pr} — ${rel} holds the bytes ${same.archive} already does: reused, the new ${dest} removed`,
    );
    return "reused";
  };

  // 4. Transcripts.
  for (const t of transcripts) {
    stop = deps.stopReason();
    if (stop) break;
    // Step 1, fresh: a transcript that moved since the guard was armed stops
    // the PR (the next pass re-arms with its new mtime).
    if (!sameIdentity(t.id, await identityOrNull(t.path))) {
      stop = "source_changed";
      break;
    }
    const rec = index.get(t.rel);
    const prefixBytes = legacyCmp?.rel === t.rel ? inv.legacy!.size : undefined;
    if (await heldAsRecorded(dir, rec, t.id)) {
      // Archived already with exactly these bytes: unlink only.
      if (rec!.via === "restore") {
        const gz = (await archiveFileSize(dir, rec!.archive)) ?? 0;
        await commit((next) =>
          next.entries.push({
            pass: passId,
            kind: "transcript",
            source: t.rel,
            archive: rec!.archive,
            ...identityFields(t.id),
            sha256: rec!.sha256,
            gz_bytes: gz,
            verified_at: now(),
            reused: true,
          }),
        );
        res.reused += 1;
      }
      unlinks.push({ path: t.path, rel: t.rel, identity: identityFields(t.id) });
      if (prefixBytes !== undefined)
        legacySrc = {
          bytes: rec!.bytes,
          sha256: rec!.sha256,
          prefixSha256: (
            await fileDigestWithPrefix(t.path, { bytesPerS: deps.bytesPerS, signal, prefixBytes })
          ).prefixSha256,
        };
      continue;
    }
    const disk = await deps.diskFor(t.id.size);
    if (disk) {
      stop = disk;
      break;
    }
    const entryOf = (archive: string, p: Packed): FileEntry => ({
      pass: passId,
      kind: "transcript",
      source: t.rel,
      archive,
      ...p,
      verified_at: now(),
    });
    const out = await archiveOne(
      t.path,
      t.rel,
      t.id,
      `transcripts/${relative(sessionDir, t.path)}.gz`,
      prefixBytes,
      entryOf,
    );
    if (out === "verify_failed") {
      incomplete = true;
      continue;
    }
    if (out === "changed") {
      stop = "source_changed";
      break;
    }
    const r = out.ok;
    const how = await commitPacked(t.rel, out.dest, packedOf(r, t.id), entryOf);
    await deps.step?.("manifest_appended", { pr, source: t.rel });
    if (how === "new") {
      res.transcripts += 1;
      res.bytesIn += r.bytes;
      res.bytesOut += r.gzBytes;
    }
    unlinks.push({ path: t.path, rel: t.rel, identity: identityFields(t.id) });
    if (prefixBytes !== undefined)
      legacySrc = { bytes: r.bytes, sha256: r.sha256, prefixSha256: r.prefixSha256 };
    await yieldToLoop();
  }

  // 5. The small files: one bundle for this pass.
  if (!stop) {
    const bundle: BundleSource[] = [];
    const small = [...inv.small.map((f) => ({ ...f, snapshot: false }))];
    if (inv.ledger) small.push({ ...inv.ledger, cls: "session_files", snapshot: true });
    for (const f of small) {
      const rel = relative(root, f.path);
      const id = await identityOrNull(f.path);
      if (!id) continue;
      const rec = index.get(rel);
      const cls = f.snapshot ? "ledger" : f.cls;
      if (await heldAsRecorded(dir, rec, id)) {
        if (f.snapshot) continue; // the same snapshot is already in a bundle
        if (rec!.via === "restore") {
          await commit((next) =>
            next.entries.push({
              pass: passId,
              kind: "reused",
              source: rel,
              archive: rec!.archive,
              ...identityFields(id),
              sha256: rec!.sha256,
              class: rec!.class ?? cls,
              verified_at: now(),
            }),
          );
          res.reused += 1;
        }
        unlinks.push({ path: f.path, rel, identity: identityFields(id) });
        continue;
      }
      if (id.size > BUNDLE_RECORD_MAX_BYTES || OWN_GZIP_CLASSES.has(f.cls)) {
        // Too big for a record, or a worker round's log (OWN_GZIP_CLASSES): its
        // own gzip, the transcript protocol.
        stop = deps.stopReason() ?? (await deps.diskFor(id.size));
        if (stop) break;
        const entryOf = (archive: string, p: Packed): FileEntry => ({
          pass: passId,
          kind: "file",
          source: rel,
          archive,
          ...p,
          verified_at: now(),
          class: cls,
          ...(f.snapshot ? { snapshot: true as const } : {}),
          ...("command" in f && f.command
            ? {
                session_command: {
                  id: f.command.id,
                  kind: f.command.kind,
                  round_no: f.command.round_no,
                  status: f.command.status,
                  payload_sha256_ok: f.command.payload_sha256 === p.sha256,
                },
              }
            : {}),
        });
        const out = await archiveOne(f.path, rel, id, `files/${rel}.gz`, undefined, entryOf);
        if (out === "verify_failed" || out === "changed") {
          incomplete = true;
          continue;
        }
        const r = out.ok;
        if ((await commitPacked(rel, out.dest, packedOf(r, id), entryOf)) === "new") {
          if (!f.snapshot) res.stateFiles += 1;
          res.bytesIn += r.bytes;
          res.bytesOut += r.gzBytes;
        }
        if (!f.snapshot) unlinks.push({ path: f.path, rel, identity: identityFields(id) });
        await yieldToLoop();
        continue;
      }
      bundle.push({
        path: f.path,
        cls,
        identity: id,
        ...(f.snapshot ? { snapshot: true } : {}),
        ...("command" in f && f.command ? { command: f.command } : {}),
      });
    }
    if (!stop && bundle.length > 0) {
      stop =
        deps.stopReason() ?? (await deps.diskFor(bundle.reduce((n, b) => n + b.identity.size, 0)));
      if (!stop) {
        const name = bundleName(passId);
        // A PR whose transcripts are gone (or none) has created no archive
        // dir yet; the bundle is its first file there.
        await mkdir(dir, { recursive: true });
        const r = await writeBundle(join(dir, name), root, bundle, {
          level: deps.level,
          bytesPerS: deps.bytesPerS,
          signal,
          ...(deps.step ? { step: deps.step } : {}),
        });
        if (r.kind === "verify_failed") {
          res.verifyFailures += 1;
          incomplete = true;
          deps.verifyFailed(
            `bundle:${pr}`,
            `archive pr-${pr}: bundle ${name}: ${r.detail} — every source is kept`,
          );
        } else if (r.kind === "ok") {
          await commit((next) =>
            next.entries.push({
              pass: passId,
              kind: "bundle",
              archive: name,
              records: r.records,
              bytes: r.bytes,
              gz_bytes: r.gzBytes,
              verified_at: now(),
              files: r.files,
            }),
          );
          await deps.step?.("manifest_appended", { pr, bundle: name });
          const live = r.files.filter((f) => !f.snapshot);
          res.stateFiles += live.length;
          res.bytesIn += r.bytes;
          res.bytesOut += r.gzBytes;
          for (const f of r.files)
            if (!f.snapshot) unlinks.push({ path: join(root, f.path), rel: f.path, identity: f });
          if (r.skipped.length > 0) incomplete = true;
        } else if (r.skipped.length > 0) incomplete = true;
      }
    }
  }

  // 6. The legacy copy (§7.5).
  let duplicate: {
    match: "exact" | "prefix";
    of: string;
    sha256: string;
    id: FileIdentity;
  } | null = null;
  const legacyId = !stop && inv.legacy ? await identityOrNull(inv.legacy.path) : null;
  if (inv.legacy && legacyId) {
    const legacyRel = relative(root, inv.legacy.path);
    const srcRec = legacyCmp ? index.get(legacyCmp.rel) : undefined;
    const srcArchived =
      srcRec !== undefined &&
      srcRec.via === "archive" &&
      !srcRec.legacy &&
      (await archiveFileSize(dir, srcRec.archive)) !== null;
    if (legacyCmp && !srcArchived) {
      // The transcript it is checked against is not archived yet: next pass.
      incomplete = true;
    } else {
      if (srcArchived && legacyCmp) {
        // Compare whole, or as a byte-prefix (the copy was taken before the
        // tmux kill, so it can be a strict prefix).
        if (!legacySrc) {
          const live = await identityOrNull(join(root, legacyCmp.rel));
          const from =
            live && sameRecorded(srcRec, live)
              ? { path: join(root, legacyCmp.rel), gz: false }
              : { path: join(dir, srcRec.archive), gz: true };
          legacySrc = {
            bytes: srcRec.bytes,
            sha256: srcRec.sha256,
            prefixSha256: (
              await fileDigestWithPrefix(from.path, {
                bytesPerS: deps.bytesPerS,
                signal,
                prefixBytes: legacyId.size,
                gz: from.gz,
              })
            ).prefixSha256,
          };
        }
        const mine = await fileDigestWithPrefix(inv.legacy.path, {
          bytesPerS: deps.bytesPerS,
          signal,
        });
        const match = legacyMatch(mine, legacySrc);
        if (match) duplicate = { match, of: srcRec.archive, sha256: mine.sha256, id: legacyId };
      }
      if (!duplicate) {
        // Matched nothing (or there is no transcript at all): kept, gzipped
        // under the protocol, then removed.
        const rec = index.get(legacyRel);
        if (await heldAsRecorded(dir, rec, legacyId))
          unlinks.push({
            path: inv.legacy.path,
            rel: legacyRel,
            identity: identityFields(legacyId),
          });
        else {
          stop = deps.stopReason() ?? (await deps.diskFor(legacyId.size));
          if (!stop) {
            const meta = await readSessionMeta(dir);
            const baseRel = legacyArchiveName(meta.archived_at, legacyId.mtimeMs);
            const entryOf = (archive: string, p: Packed): FileEntry => ({
              pass: passId,
              kind: "transcript",
              source: legacyRel,
              archive,
              ...p,
              verified_at: now(),
              legacy: true,
            });
            const out = await archiveOne(
              inv.legacy.path,
              legacyRel,
              legacyId,
              baseRel,
              undefined,
              entryOf,
            );
            if (out === "verify_failed" || out === "changed") incomplete = true;
            else {
              const r = out.ok;
              const how = await commitPacked(legacyRel, out.dest, packedOf(r, legacyId), entryOf);
              if (how === "new") {
                res.bytesIn += r.bytes;
                res.bytesOut += r.gzBytes;
              }
              unlinks.push({
                path: inv.legacy.path,
                rel: legacyRel,
                identity: identityFields(legacyId),
              });
            }
          }
        }
      }
    }
  }

  if (stop) {
    res.reason = stop;
    incomplete = true;
  }

  // 7. Eligibility again — the async half once, the sync half before each
  // unlink. The verified copies' sources go even when a later file was
  // refused for the disk, the budget or a load hold — as the store passes'
  // do: each unlink is one cheap step that frees space, and leaving it would
  // re-meet the same refusal next pass with the source still live. A source
  // that changed, the archiver stopping or a restore waiting keeps them.
  const removed = new Set<string>();
  let unlinkStop: string | null = null;
  // The archiver stopping, or a restore waiting for the mutex: served at the
  // next file boundary — an unlink is one.
  let unlinkYield: string | null = null;
  const unlinksGo = stop === null || (stop !== "source_changed" && unlinkStopOf(stop) === null);
  if (unlinksGo && (unlinks.length > 0 || duplicate)) {
    await deps.step?.("before_unlink", { pr });
    facts = await deps.outside(pr);
    const again = eligibility(facts);
    if (!again.eligible) unlinkStop = again.reason ?? "ineligible";
    let k = 0;
    for (const u of unlinkStop ? [] : unlinks) {
      unlinkYield = unlinkStopOf(deps.stopReason());
      if (unlinkYield) break;
      const now2 = eligibility(facts);
      if (!now2.eligible) {
        unlinkStop = now2.reason ?? "ineligible";
        break;
      }
      const r = await unlinkIfIdentity(u.path, u.identity);
      if (r === "changed") continue;
      removed.add(u.rel);
      if (r === "removed") {
        res.removed += 1;
        k += 1;
        await deps.step?.("unlinked", { pr, k, of: unlinks.length, path: u.path });
      }
    }
    if (!unlinkStop && !unlinkYield && duplicate && inv.legacy) {
      unlinkYield = unlinkStopOf(deps.stopReason());
      const now3 = unlinkYield ? null : eligibility(facts);
      if (now3 && !now3.eligible) unlinkStop = now3.reason ?? "ineligible";
      else if (now3) {
        // The removal is on the record BEFORE the unlink, as every other
        // removal's entry is: nothing after the unlink could rebuild it (the
        // copy is gone). A record an earlier pass committed before a crash
        // stopped its unlink is not written twice.
        const dup = duplicate;
        const entry = {
          kind: "duplicate_removed" as const,
          path: basename(inv.legacy.path),
          bytes: dup.id.size,
          sha256: dup.sha256,
          duplicate_of: dup.of,
          match: dup.match,
        };
        const recorded = manifest.entries.some(
          (e) =>
            e.kind === "duplicate_removed" &&
            e.path === entry.path &&
            e.bytes === entry.bytes &&
            e.sha256 === entry.sha256,
        );
        if (!recorded) {
          await commit((next) => next.entries.push({ pass: passId, ...entry, removed_at: now() }));
          await deps.step?.("duplicate_recorded", { pr });
        }
        // The commit awaited: the stops and eligibility are asked again, as
        // before every other unlink. A pass that stops here leaves the record
        // for the next one, which only unlinks.
        unlinkYield = unlinkStopOf(deps.stopReason());
        const now4 = unlinkYield ? null : eligibility(facts);
        if (now4 && !now4.eligible) unlinkStop = now4.reason ?? "ineligible";
        else if (now4) {
          const countKey = prepareDuplicateCount(store, pr, {
            path: inv.legacy.path,
            identity: dup.id,
          });
          const r = await unlinkIfIdentity(inv.legacy.path, identityFields(dup.id));
          finishDuplicateCount(store, countKey, r === "removed" || r === "gone");
          // Counted with the removal itself, so a pass that unlinks an earlier
          // pass's record counts it once and a copy that moved counts nothing.
          if (r === "removed") {
            res.duplicatesRemoved += 1;
            await deps.step?.("duplicate_unlinked", { pr });
          }
          if (r === "changed") {
            // It moved after it was compared: left live, the next pass
            // compares it again.
            duplicate = null;
            incomplete = true;
          }
        }
      }
    }
  }
  if (unlinkStop || unlinkYield) {
    res.reason = unlinkStop ?? unlinkYield;
    incomplete = true;
  }
  const kept = unlinks.filter((u) => !removed.has(u.rel)).map((u) => u.rel);
  if (kept.length > 0) incomplete = true;

  // 8. Stamp what left, finish the pass. A source an earlier run removed but
  // never stamped (a crash between its unlink and the stamp) is stamped now:
  // it is not live, its entry verified.
  const goneFrom = bundleRemovals(manifest);
  if (!unlinkStop && !unlinkYield && !stop)
    for (const entry of manifest.entries) {
      const sources =
        entry.kind === "transcript" || entry.kind === "file" || entry.kind === "reused"
          ? entry.source_removed_at === undefined && !("snapshot" in entry && entry.snapshot)
            ? [entry.source]
            : []
          : entry.kind === "bundle"
            ? entry.files
                .filter((f) => !f.snapshot && !goneFrom.get(entry.archive)?.has(f.path))
                .map((f) => f.path)
            : [];
      for (const src of sources)
        if (
          !removed.has(src) &&
          !kept.includes(src) &&
          (await identityOrNull(join(root, src))) === null
        )
          removed.add(src);
    }
  const at = now();
  const anyRemoved = removed.size > 0 || res.duplicatesRemoved > 0;
  if (anyRemoved || passRecorded) {
    await commit((next) => {
      const extra: Array<{ archive: string; paths: string[] }> = [];
      next.entries.forEach((entry) => {
        if (entry.kind === "transcript" || entry.kind === "file" || entry.kind === "reused") {
          if (removed.has(entry.source) && entry.source_removed_at === undefined)
            (entry as FileEntry).source_removed_at = at;
        } else if (entry.kind === "bundle") {
          const gone = goneFrom.get(entry.archive);
          const mine = entry.files
            .filter((f) => !f.snapshot && removed.has(f.path) && !gone?.has(f.path))
            .map((f) => f.path);
          if (mine.length === 0) return;
          if (entry.sources_removed_at === undefined) {
            entry.sources_removed_at = at;
            const left = entry.files
              .filter((f) => !f.snapshot && !removed.has(f.path))
              .map((f) => f.path);
            if (left.length > 0) entry.kept = left;
          } else extra.push({ archive: entry.archive, paths: mine });
        }
      });
      for (const x of extra)
        next.entries.push({ pass: passId, kind: "sources_removed", ...x, removed_at: at });
      const pass = next.passes.find((p) => p.id === passId);
      if (pass && pass.finished_at === undefined) pass.finished_at = at;
    });
  }
  // Emptied directories, deepest first, never recursively.
  if (removed.size > 0) for (const d of inv.dirs) await rmdirQuiet(d);

  const complete = !incomplete;
  res.outcome = complete ? "archived" : unlinkStop ? "held" : "partial";
  if (res.outcome === "partial" && !res.reason)
    res.reason = res.verifyFailures > 0 ? "verify_failed" : "incomplete";
  finishArchiveRow(store, pr, {
    at,
    complete,
    tallies: deps.meter.measure(() => rowTallies(manifest)),
    error: complete ? null : res.reason,
  });
  return res;
}

/** Per bundle: the sources the manifest already records as removed (its
 * stamp minus `kept`, and every later `sources_removed` entry). */
function bundleRemovals(m: Manifest): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const e of m.entries) {
    if (e.kind === "bundle" && e.sources_removed_at !== undefined) {
      out.set(e.archive, stampedBundleSources(e));
    } else if (e.kind === "sources_removed") {
      const set = out.get(e.archive) ?? new Set<string>();
      for (const p of e.paths) set.add(p);
      out.set(e.archive, set);
    }
  }
  return out;
}

/**
 * Which transcript the legacy copy is checked against (§7.5): the one
 * `meta.json`'s `session_file` names (by path under this root, else by name),
 * else the newest of the PR's transcripts, live or archived.
 */
async function legacySource(
  dir: string,
  root: string,
  live: ReadonlyArray<{ rel: string; id: FileIdentity }>,
  index: ReadonlyMap<string, SettledRecord>,
): Promise<{ rel: string } | null> {
  const cands = new Map<string, number>();
  for (const t of live) cands.set(t.rel, t.id.mtimeMs);
  for (const r of index.values())
    if (r.kind === "transcript" && !r.legacy && r.source.endsWith(".jsonl") && !cands.has(r.source))
      cands.set(r.source, r.mtime_ms);
  if (cands.size === 0) return null;
  const meta = await readSessionMeta(dir);
  if (meta.session_file) {
    const rel = relative(root, meta.session_file);
    if (cands.has(rel)) return { rel };
    const name = basename(meta.session_file);
    const byName = [...cands.keys()].find((c) => basename(c) === name);
    if (byName) return { rel: byName };
  }
  let best: { rel: string; m: number } | null = null;
  for (const [rel, m] of cands)
    if (!best || m > best.m || (m === best.m && rel > best.rel)) best = { rel, m };
  return best ? { rel: best.rel } : null;
}
