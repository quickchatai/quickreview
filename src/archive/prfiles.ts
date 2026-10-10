// The per-PR INVENTORY (docs/archiving.md §7.2): which live files
// belong to a closed PR, found without a synchronous walk.
//
//   - One async `readdir` of each live directory the per-PR artifacts sit in,
//     grouped by PR (`listLiveTree`) — never one listing per PR per directory,
//     so a pass over N PRs costs the directories once plus each PR's own files.
//   - A recursive async walk only inside one PR's own dirs (its pi session
//     dir, its round pass dirs, its inject dir's `.done/` and `.terminal/`).
//   - Session-command payloads come from the DATABASE (the PR's terminal
//     command rows, `payload_path` under `state/session-commands/`), never
//     from a listing of that directory (thousands of uuid files, none named
//     by PR).
//
// The plan (`plan.ts`) tallies this inventory; an archive pass
// (`prarchive.ts`) moves it. One definition of §7.2, two readers.
import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import type { StateStore } from "../state.js";

/** The per-PR artifact classes that LEAVE the live tree (§7.2). */
export const ARTIFACT_CLASSES = [
  "transcripts",
  "round_prompts",
  "session_commands",
  "findings",
  "posting_receipts",
  "round_files",
  "session_files",
  "inject_done",
  "stale_injects",
  "verdicts",
] as const;
export type ArtifactClass = (typeof ARTIFACT_CLASSES)[number];

/** The small (bundled) classes — every class but the transcripts. */
export type SmallClass = Exclude<ArtifactClass, "transcripts">;

/** Measures the synchronous spans it is handed. */
export class SpanMeter {
  max = 0;
  measure<T>(fn: () => T): T {
    const t0 = performance.now();
    try {
      return fn();
    } finally {
      const d = performance.now() - t0;
      if (d > this.max) this.max = d;
    }
  }
}

/** Directory entries, [] when the directory does not exist; any other
 * failure is thrown — a listing that could not be read is not "empty". */
export async function listDir(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/** A regular file's size; null when it is gone or not a regular file. */
export async function fileSize(path: string): Promise<number | null> {
  try {
    const st = await lstat(path);
    return st.isFile() ? st.size : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Every regular file under `dir` (recursive, symlinks never followed); the
 * directories met are pushed to `dirs` deepest-last (the caller reverses). */
export async function walkFiles(
  dir: string,
  out: string[],
  signal?: AbortSignal,
  dirs?: string[],
): Promise<void> {
  signal?.throwIfAborted();
  for (const e of await listDir(dir)) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      dirs?.push(p);
      await walkFiles(p, out, signal, dirs);
    } else if (e.isFile()) out.push(p);
  }
}

export type Groups = Map<number, string[]>;
const push = (g: Groups, pr: number, path: string): void => {
  const list = g.get(pr);
  if (list) list.push(path);
  else g.set(pr, [path]);
};

/** Group a listing's entries by the PR number `re` captures — one pass over
 * the listing, a map lookup per PR after (linear in the listing). */
export function groupBy(
  meter: SpanMeter,
  dir: string,
  entries: readonly Dirent[],
  re: RegExp,
  want: "file" | "dir" | "any" = "file",
): Groups {
  return meter.measure(() => {
    const g: Groups = new Map();
    for (const e of entries) {
      if (want === "file" && !e.isFile()) continue;
      if (want === "dir" && !e.isDirectory()) continue;
      if (want === "any" && !e.isFile() && !e.isDirectory()) continue;
      const m = re.exec(e.name);
      if (m) push(g, Number(m[1]), join(dir, e.name));
    }
    return g;
  });
}

export const PR_DIR = /^pr-(\d+)$/;
const PR_PREFIX = /^pr-(\d+)-/;
const ROUND_PROMPT = /^pr-(\d+)-round-\d+\.md$/;
/** Every per-round entry at the top of `state/` — the daemon's (`-passes/`,
 * `-review.md`, `-comments.json`) and any a session wrote beside them (e.g. a
 * `pr-<n>-round-<k>-body.md`), so none is left live under an `archived` row. */
const STATE_ROUND = /^pr-(\d+)-round-\d+-.+$/;
/** Any top-level `state/` entry named for a PR. Those no class claims are
 * reported by the plan (`unclassified`) and kept live — never moved on a
 * guess, never invisible. */
const STATE_PR = /^pr-(\d+)(?:[-.]|$)/;
const SESSION_PROMPT = /^pr-(\d+)\.md$/;
const SESSION_STATE = /^pr-(\d+)\.(?:json|bridge-.+\.json)$/;
const PROGRESS = /^pr-(\d+)\.json$/;
const LEDGER = /^pr-(\d+)\.md$/;
const VERDICT = /(?:^|-)pr-(\d+)-/;
const INJECT_RECOVERY = /\.operator-recovery-/;

/** Session-command statuses whose payload may leave (§7.2): terminal only. */
export const TERMINAL_COMMAND_STATUSES = ["acked", "cancelled", "failed"] as const;

/** The live directories, each listed ONCE and grouped by PR. */
export interface LiveListing {
  sessionDirs: Groups;
  injectDirs: Groups;
  archiveDirs: Groups;
  /** The flat per-PR state files and dirs, by class (`ledger` = the live
   * ledger, snapshotted and kept). */
  flat: Array<[SmallClass | "ledger", Groups]>;
  /** Top-level `state/` entries named for a PR that no class claims: kept
   * live, reported by the plan. */
  unclassified: Groups;
}

/** List every live directory once. Throws when one cannot be listed (an
 * unreadable listing is never "nothing there"). */
export async function listLiveTree(
  root: string,
  sessionsRoot: string,
  meter: SpanMeter = new SpanMeter(),
): Promise<LiveListing> {
  const stateDir = join(root, "state");
  const sessionDirs = groupBy(meter, sessionsRoot, await listDir(sessionsRoot), PR_DIR, "dir");
  const injectRoot = dirname(injectDirOf(root, 0));
  const injectDirs = groupBy(meter, injectRoot, await listDir(injectRoot), PR_DIR, "dir");
  const archiveRoot = join(root, "archive");
  const archiveDirs = groupBy(meter, archiveRoot, await listDir(archiveRoot), PR_DIR, "dir");
  const flat: LiveListing["flat"] = [];
  const listing = async (
    cls: SmallClass | "ledger",
    dir: string,
    re: RegExp,
    want: "file" | "dir" | "any" = "file",
  ): Promise<void> => {
    flat.push([cls, groupBy(meter, dir, await listDir(dir), re, want)]);
  };
  await listing("round_prompts", join(stateDir, "round-prompts"), ROUND_PROMPT);
  await listing("findings", join(stateDir, "findings"), PR_PREFIX);
  await listing("posting_receipts", join(stateDir, "posting-receipts"), PR_PREFIX);
  // `state/` itself, listed once: the per-round entries, and what is left.
  const stateEntries = await listDir(stateDir);
  flat.push(["round_files", groupBy(meter, stateDir, stateEntries, STATE_ROUND, "any")]);
  const unclassified = groupBy(
    meter,
    stateDir,
    stateEntries.filter((e) => !STATE_ROUND.test(e.name)),
    STATE_PR,
    "any",
  );
  await listing("session_files", join(stateDir, "session-prompts"), SESSION_PROMPT);
  await listing("session_files", join(stateDir, "sessions"), SESSION_STATE);
  await listing("session_files", join(stateDir, "round-progress"), PROGRESS);
  await listing("verdicts", join(root, "verdict", "processed"), VERDICT, "any");
  await listing("verdicts", join(root, "verdict", "failed"), VERDICT, "any");
  await listing("ledger", join(stateDir, "ledgers"), LEDGER);
  return { sessionDirs, injectDirs, archiveDirs, flat, unclassified };
}

/** `inject/pr-<n>/`, the PR session's drop-box. The archiver only LISTS it
 * (an undelivered top-level wake holds the PR) and archives what was
 * consumed; it never puts a wake there. */
export const injectDirOf = (root: string, pr: number): string => join(root, "inject", `pr-${pr}`);

/** The top-level `*.md` files of a PR's inject dir — its undelivered wakes
 * (an eligibility input). [] when the dir is absent; throws when it cannot be
 * listed. */
export async function topLevelInjectFiles(injectDir: string | undefined): Promise<string[]> {
  if (!injectDir) return [];
  return (await listDir(injectDir))
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => join(injectDir, e.name));
}

/** A session-command row whose payload the bundle carries. */
export interface PayloadCommand {
  id: string;
  kind: string;
  round_no: number | null;
  status: string;
  payload_sha256: string;
}

export interface InventoryFile {
  path: string;
  size: number;
}

export interface SmallFile extends InventoryFile {
  cls: SmallClass;
  /** For a session-command payload: the row it belongs to. */
  command?: PayloadCommand;
}

/** What one PR has in the live tree (§7.2). */
export interface PrInventory {
  pr: number;
  /** Every `*.jsonl` under `<sessionsRoot>/pr-<n>/` (not only the newest). */
  transcripts: InventoryFile[];
  /** The bundled classes. */
  small: SmallFile[];
  /** `state/ledgers/pr-<n>.md` — snapshotted into the bundle, KEPT live. */
  ledger: InventoryFile | null;
  /** `archive/pr-<n>/session.jsonl`, the legacy uncompressed copy (§7.5). */
  legacy: InventoryFile | null;
  /** `archive/pr-<n>/` — where the PR's archive lives (absent until made). */
  archiveDir: string;
  /** Directories the pass may empty, deepest first (removed with a
   * non-recursive rmdir only). */
  dirs: string[];
}

/**
 * One PR's live files, from the pass's listing. `staleInjects` are the
 * top-level inject files the eligibility rule found TERMINAL (leftovers of a
 * failed round command, §7.2). Throws when a dir of the PR cannot be walked.
 */
export async function prInventory(
  listing: LiveListing,
  pr: number,
  opts: {
    store: StateStore;
    root: string;
    staleInjects: readonly string[];
    signal?: AbortSignal;
    meter?: SpanMeter;
  },
): Promise<PrInventory> {
  const { root, signal } = opts;
  const meter = opts.meter ?? new SpanMeter();
  const commandsDir = resolve(root, "state", "session-commands") + sep;
  const inv: PrInventory = {
    pr,
    transcripts: [],
    small: [],
    ledger: null,
    legacy: null,
    archiveDir: listing.archiveDirs.get(pr)?.[0] ?? join(root, "archive", `pr-${pr}`),
    dirs: [],
  };
  const seen = new Set<string>();
  const addSmall = (f: SmallFile): void => {
    if (seen.has(f.path)) return;
    seen.add(f.path);
    inv.small.push(f);
  };
  // Transcripts: every *.jsonl under pi-sessions/pr-<n>/, not just the newest.
  for (const dir of listing.sessionDirs.get(pr) ?? []) {
    const files: string[] = [];
    const dirs: string[] = [];
    await walkFiles(dir, files, signal, dirs);
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const size = await fileSize(f);
      if (size !== null) inv.transcripts.push({ path: f, size });
    }
    inv.dirs.push(...dirs.reverse(), dir);
  }
  // The flat per-PR state files (and the passes dirs, walked).
  for (const [cls, groups] of listing.flat) {
    for (const p of groups.get(pr) ?? []) {
      const size = await fileSize(p);
      if (size !== null) {
        if (cls === "ledger") inv.ledger = { path: p, size };
        else addSmall({ path: p, size, cls });
        continue;
      }
      const files: string[] = [];
      const dirs: string[] = [];
      await walkFiles(p, files, signal, dirs);
      for (const f of files) {
        const s = await fileSize(f);
        if (s === null) continue;
        if (cls === "ledger") continue; // a ledger is a file, never a dir
        addSmall({ path: f, size: s, cls });
      }
      inv.dirs.push(...dirs.reverse(), p);
    }
  }
  // Session-command payloads: the PR's terminal command rows, under
  // state/session-commands/ only.
  const rows = meter.measure(
    () =>
      opts.store.db
        .prepare(
          `SELECT id, kind, round_no, status, payload_path, payload_sha256 FROM session_commands
            WHERE pr = ? AND status IN (${TERMINAL_COMMAND_STATUSES.map((s) => `'${s}'`).join(", ")})
            ORDER BY created_at, id`,
        )
        .all(pr) as Array<PayloadCommand & { payload_path: string }>,
  );
  for (const { payload_path, ...command } of rows) {
    if (!resolve(payload_path).startsWith(commandsDir)) continue;
    const size = await fileSize(payload_path);
    if (size !== null)
      addSmall({ path: resolve(payload_path), size, cls: "session_commands", command });
  }
  // inject/pr-<n>/: delivered wakes (.done/, .terminal/), quarantines, and the
  // top-level leftovers whose command row is terminal.
  const injectDir = listing.injectDirs.get(pr)?.[0];
  if (injectDir) {
    for (const e of await listDir(injectDir)) {
      const p = join(injectDir, e.name);
      if (e.isDirectory() && (e.name === ".done" || e.name === ".terminal")) {
        const files: string[] = [];
        const dirs: string[] = [];
        await walkFiles(p, files, signal, dirs);
        for (const f of files) {
          const s = await fileSize(f);
          if (s !== null) addSmall({ path: f, size: s, cls: "inject_done" });
        }
        inv.dirs.push(...dirs.reverse(), p);
      } else if (e.isFile() && INJECT_RECOVERY.test(e.name)) {
        const s = await fileSize(p);
        if (s !== null) addSmall({ path: p, size: s, cls: "inject_done" });
      }
    }
    for (const f of opts.staleInjects) {
      const s = await fileSize(f);
      if (s !== null) addSmall({ path: f, size: s, cls: "stale_injects" });
    }
    inv.dirs.push(injectDir);
  }
  // The legacy uncompressed copy in archive/pr-<n>/.
  const archiveDir = listing.archiveDirs.get(pr)?.[0];
  if (archiveDir) {
    const legacy = join(archiveDir, "session.jsonl");
    const s = await fileSize(legacy);
    if (s !== null) inv.legacy = { path: legacy, size: s };
  }
  return inv;
}
