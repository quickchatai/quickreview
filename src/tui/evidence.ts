// Finished-round evidence transport.
//
// The companion cannot reach the VM — rule 8 is structural and this ticket does
// not widen it by a byte. So the TUI, which already holds the ssh access, copies
// every finished round's artefacts DOWN to a local store, and the companion
// reads plain files out of a read-only mount. Nothing new is granted to it: no
// ssh, no credential, no network reach.
//
// Why on completion rather than on demand: on-demand transport is exactly what
// lost #5306, #5308 and #5312 — nothing was copying while they happened, so the
// three most interesting episodes have no local record at all. A round that has
// finished is a round whose evidence is already complete; waiting for someone to
// ask for it is waiting for the session to be recycled first.
//
// Shape follows remote.ts: command construction is pure so tests can assert the
// exact argv, execution goes through the one injectable SshRunner, and every
// failure degrades (logged, retried on the next poll) rather than throwing into
// the paint loop.
//
// Retention: evidence is kept indefinitely by the owner's explicit choice
// — not by omission. Do not add a TTL or a cleanup sweep.
//
// Load (L1, after the 2026-10-07 post-drain burst): the sweep's
// per-PR progress is kept on disk (`SweepProgressFile`), so a TUI re-exec —
// every local `dist/` rebuild — resumes instead of re-running `qcr why` for
// every PR; and the `why` execs are paced (`evidence_why_interval_s`) and held
// entirely while the board's last status shows the daemon draining or its
// heartbeat stale, so the sweep can never be the thing that saturates the
// container.
//
// The closed-PR archiver (S4, docs/archiving.md §4, §14): a round
// copied after its PR's files were archived (14 days closed — a TUI that was
// off that long) finds them in `archive/pr-<n>/` instead. The transcript is
// read from its archived gzip (`zcat | head -c`, after `zcat -t` proves the
// gzip whole, so a corrupt one fails the copy rather than landing short); a
// role whose file now sits only inside a bundle is recorded as `archived`
// with its pointer — the bundle and the path in it — never as `missing`.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { TuiConfig } from "../config.js";
import type { StatusSnapshot } from "../state.js";
import { settledIndex, type Manifest, type SettledRecord } from "../archive/manifest.js";
import { whyArgv, type RemoteResult, type SshRunner } from "./remote.js";

/** Roles a round bundle can carry, in copy order. `transcript` carries the pass
 * output too: lens passes run as subagent children inside the PR's one
 * session, so their output IS the session JSONL (root rule 9 — passes are
 * leaves). */
export const EVIDENCE_ROLES = ["transcript", "ledger", "prompt", "verdict"] as const;
export type EvidenceRole = (typeof EVIDENCE_ROLES)[number];

/** Local file name each role lands under. */
const LOCAL_NAME: Record<EvidenceRole, string> = {
  transcript: "session.jsonl",
  ledger: "ledger.md",
  prompt: "prompt.md",
  verdict: "verdict.json",
};

/**
 * Per-file byte cap on the remote side (`head -c`).
 *
 * A knob would be knob sprawl: this is not a tuning dial but a blast-radius
 * bound. A transcript is ~0.6 MB per session; 32 MiB is two orders of magnitude
 * of headroom and still small enough that one runaway JSONL cannot fill
 * the owner's disk or stall an ssh for minutes. A truncated file is recorded as
 * truncated in the manifest — never silently short.
 */
export const MAX_FILE_BYTES = 32 * 1024 * 1024;

/** Rounds copied per PR per sweep. Keeps a first-ever sweep over a PR with 20
 * rounds from monopolising the poll; the rest land on the following ticks. */
export const ROUNDS_PER_SWEEP = 3;

/**
 * Roles whose remote file is the PR's CURRENT one, not the round's: the ledger
 * and session-prompt live at `pr-<n>.md` and the transcript is "the newest
 * JSONL in the session dir". Copying them into `round-<k>/` is honest only for
 * a round that finished under this copier's watch — for a backlog round the
 * copy would stamp TODAY's files into an old round's dir and silently corrupt
 * the adjudication evidence. Only `verdict` is genuinely round-scoped.
 */
export const PR_CURRENT_ROLES: readonly EvidenceRole[] = ["transcript", "ledger", "prompt"];

/** Recorded verbatim in every manifest so a reader of the store never has to
 * know the copier's version to interpret what it holds. */
export const ROLES_NOTE =
  "transcript, ledger and prompt are the PR's CURRENT files at copy time (scope: pr-current), not artefacts of this round; only verdict.json is round-scoped. Rounds that finished before this copier first saw the PR carry those roles under skipped_stale instead of a misleading copy.";

export interface EvidenceFile {
  role: EvidenceRole;
  /** Absolute path INSIDE the container, as the VM reported it. */
  remotePath: string;
}

/** One round's record, written last so its presence means "fully copied". */
export interface RoundManifest {
  pr: number;
  round_no: number;
  copied_at: string;
  round: unknown;
  /** `ROLES_NOTE`: which roles are round-scoped and which are pr-current. */
  roles_note: string;
  files: Array<{
    role: EvidenceRole;
    remote_path: string;
    chars: number;
    truncated: boolean;
    /** "round" = this file belongs to this round; "pr-current" = this is the
     * PR's file AS OF COPY TIME (honest only because the round finished under
     * this copier's watch). */
    scope: "round" | "pr-current";
    /** Where the bytes were read: the live file, or the archived
     * gzip `remote_path` names, decompressed. Absent from an older copier's
     * manifest, which only ever read live files. */
    from?: "live" | "archive";
  }>;
  /** Not in the live tree, and found in the PR's archive: where
   * the bytes are — `pointer` the archive file (a bundle, or a gzip) relative
   * to the sandbox root, `path` the live path it was archived from (the
   * record's name inside a bundle). Never counted `missing`. Absent from an
   * older copier's manifest. */
  archived?: Array<{ role: EvidenceRole; pointer: string; path: string }>;
  /** Absent at copy time: not live, and not in the PR's archive either. */
  missing: EvidenceRole[];
  /** PR-current roles deliberately NOT copied: the round finished before this
   * copier first saw the PR, so the current ledger/prompt/transcript would be
   * stamped into an old round's dir as if they were its own. */
  skipped_stale: EvidenceRole[];
}

export const MANIFEST_NAME = "manifest.json";

function dockerSh(cfg: TuiConfig, script: string): string[] {
  return [
    ...(cfg.sudo_docker ? ["sudo"] : []),
    "docker",
    "exec",
    cfg.container,
    "sh",
    "-c",
    script,
  ];
}

/**
 * Locate a round's artefacts on the VM in ONE call, printing `role<space>path`
 * for each that exists.
 *
 * Resolution is done remotely on purpose: the transcript is "the newest JSONL in
 * the session dir" and the verdict may be either still in `verdict/` or already
 * moved to `verdict/processed/<ts>-…` by the watcher. Guessing either one
 * client-side would produce a copier that works until the daemon moves a file.
 *
 * The archive fallback: with no live transcript, the newest archived
 * one — `archive/pr-<n>/transcripts/*.gz`, whose mtime the archiver keeps at
 * the original's; never a `session-at-close-*` legacy copy. And when the PR
 * has an archive manifest it is listed (`archive-manifest <path>`), so a role
 * found nowhere live can be looked up in it instead of read as missing.
 *
 * Ends `exit 0`: a trailing `[ -f … ] && echo` that finds nothing would
 * otherwise exit non-zero and make an entirely successful listing look failed.
 */
export function manifestArgv(
  cfg: TuiConfig,
  sessionDir: string,
  pr: number,
  round: number,
): string[] {
  const root = cfg.remote_sandbox_root;
  const script = [
    `r="${root}"`,
    `t=$(ls -1t "$r/${sessionDir}/pr-${pr}"/*.jsonl 2>/dev/null | head -1)`,
    `[ -z "$t" ] && t=$(ls -1t "$r/archive/pr-${pr}/transcripts"/*.gz 2>/dev/null | grep -v '/session-at-close-' | head -1)`,
    `[ -n "$t" ] && echo "transcript $t"`,
    `[ -f "$r/state/ledgers/pr-${pr}.md" ] && echo "ledger $r/state/ledgers/pr-${pr}.md"`,
    `[ -f "$r/state/session-prompts/pr-${pr}.md" ] && echo "prompt $r/state/session-prompts/pr-${pr}.md"`,
    `v=$(ls -1t "$r/verdict/pr-${pr}-round-${round}.json" "$r"/verdict/processed/*pr-${pr}-round-${round}.json 2>/dev/null | head -1)`,
    `[ -n "$v" ] && echo "verdict $v"`,
    `[ -f "$r/archive/pr-${pr}/manifest.json" ] && echo "${ARCHIVE_MANIFEST_LINE} $r/archive/pr-${pr}/manifest.json"`,
    `exit 0`,
  ].join("\n");
  return dockerSh(cfg, script);
}

/** The listing line naming the PR's archive manifest. */
export const ARCHIVE_MANIFEST_LINE = "archive-manifest";

/** The PR's archive manifest, when the listing named one — with the same
 * trust-boundary checks as an artefact path, and it must be the manifest of
 * THIS PR's archive. */
export function parseArchiveManifestLine(stdout: string, root: string, pr: number): string | null {
  const want = `${root}/archive/pr-${pr}/manifest.json`;
  for (const line of stdout.split("\n")) {
    const sp = line.indexOf(" ");
    if (sp <= 0 || line.slice(0, sp).trim() !== ARCHIVE_MANIFEST_LINE) continue;
    const path = line.slice(sp + 1).trim();
    if (path === want && /^[\w./@:+-]+$/.test(path)) return path;
  }
  return null;
}

/** Is this artefact path an archived gzip (read with `zcat`)? */
const isArchivedGzip = (remotePath: string, root: string): boolean =>
  remotePath.startsWith(`${root}/archive/`) && remotePath.endsWith(".gz");

/**
 * Parse the listing, refusing any path that is not plainly inside the sandbox
 * root and plainly shell-safe. The VM answers here become the next command's
 * argument, so this is the trust boundary — a path is data, never a fragment of
 * script.
 */
export function parseManifest(stdout: string, root: string): EvidenceFile[] {
  const out: EvidenceFile[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split("\n")) {
    const sp = line.indexOf(" ");
    if (sp <= 0) continue;
    const role = line.slice(0, sp).trim() as EvidenceRole;
    const remotePath = line.slice(sp + 1).trim();
    if (!(EVIDENCE_ROLES as readonly string[]).includes(role) || seen.has(role)) continue;
    if (!remotePath.startsWith(`${root}/`) || !/^[\w./@:+-]+$/.test(remotePath)) continue;
    seen.add(role);
    out.push({ role, remotePath });
  }
  return out;
}

/** `head -c <cap>` one artefact. Every artefact is text (JSONL / Markdown /
 * JSON), so the string the runner returns is the file — no base64 hop, and no
 * dependency on tar being present in the image.
 *
 * An ARCHIVED transcript (a `.gz` under `archive/`) is decompressed
 * on the VM: `zcat -t` first proves the whole gzip decompresses — `zcat | head`
 * alone exits with head's status, so a corrupt gzip would land as a short
 * file that looks complete — then `zcat | head -c <cap>`. */
export function fetchArgv(cfg: TuiConfig, remotePath: string, maxBytes = MAX_FILE_BYTES): string[] {
  if (isArchivedGzip(remotePath, cfg.remote_sandbox_root))
    return dockerSh(cfg, `zcat -t '${remotePath}' && zcat '${remotePath}' | head -c ${maxBytes}`);
  return dockerSh(cfg, `head -c ${maxBytes} '${remotePath}'`);
}

/** An archive manifest (`archive/pr-<n>/manifest.json`) as fetched, or null
 * when it is not one. A manifest is plain, append-only JSON; one
 * that does not parse is never read as "nothing archived". */
export function parseArchiveManifest(text: string): Manifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const m = parsed as Partial<Manifest>;
  if (
    m.format !== 1 ||
    !Array.isArray(m.passes) ||
    !Array.isArray(m.entries) ||
    !m.entries.every((e) => typeof e === "object" && e !== null && typeof e.kind === "string")
  )
    return null;
  return m as Manifest;
}

/**
 * Where a role's file sits in the PR's archive, by its manifest:
 * the latest record of the path the live listing would have found — the
 * ledger, the session prompt, this round's processed verdict, or the newest
 * PR transcript — or null when the archive holds none. `pointer` is the
 * archive file relative to the sandbox root; `path` the live path it was
 * archived from (its record's name inside a bundle).
 */
export function archivedRole(
  manifest: Manifest,
  role: EvidenceRole,
  pr: number,
  round: number,
  sessionDir: string,
): { pointer: string; path: string } | null {
  const verdictRe = new RegExp(`^verdict/processed/(?:[^/]*-)?pr-${pr}-round-${round}\\.json$`);
  const match = (r: SettledRecord): boolean => {
    switch (role) {
      case "ledger":
        return r.source === `state/ledgers/pr-${pr}.md`;
      case "prompt":
        return r.source === `state/session-prompts/pr-${pr}.md`;
      case "verdict":
        return verdictRe.test(r.source);
      case "transcript":
        return (
          r.kind === "transcript" &&
          !r.legacy &&
          r.source.startsWith(`${sessionDir}/pr-${pr}/`) &&
          r.source.endsWith(".jsonl")
        );
    }
  };
  let best: SettledRecord | null = null;
  for (const r of settledIndex(manifest).values())
    if (match(r) && (!best || r.mtime_ms > best.mtime_ms)) best = r;
  return best ? { pointer: `archive/pr-${pr}/${best.archive}`, path: best.source } : null;
}

/** The round rows `qcr why --json` reports; only the fields the copier reads. */
export interface WhyRound {
  round_no: number;
  status: string;
  verdict: string | null;
  finished_at: string | null;
  [k: string]: unknown;
}

/**
 * A round is COPYABLE once it is no longer running. `done` is the common case;
 * `expired`, `overdue` and `cancelled` are copied too — a round that died is
 * precisely the episode worth having a local record of, and refusing them would
 * reproduce the gap this ticket exists to close.
 */
export function finishedRounds(rounds: WhyRound[]): WhyRound[] {
  return rounds
    .filter((r) => r.status !== "running" && Number.isInteger(r.round_no))
    .sort((a, b) => a.round_no - b.round_no);
}

/** The finished rounds out of one `qcr why --json` answer, or `undefined`
 * when the answer does not carry a round list at all. `[]` is reserved for a
 * payload that SAID there are no rounds; a payload that said nothing about
 * rounds is not that. */
export function readWhyRounds(stdout: string): WhyRound[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const rounds = (parsed as { rounds?: unknown }).rounds;
  return Array.isArray(rounds) ? finishedRounds(rounds as WhyRound[]) : undefined;
}

/** Cheap "has anything changed for this PR" key, read off the poll snapshot the
 * TUI already fetches. Unchanged ⇒ no `why` call at all, so the steady state
 * costs the copier ZERO extra ssh. */
export function prSignature(pr: StatusSnapshot["prs"][number]): string {
  return `${pr.rounds ?? 0}/${pr.last_verdict ?? ""}/${pr.state}/${pr.head_sha}`;
}

// ---- pacing and holds (L1) ----------------------------------------

/** `[tui] evidence_why_interval_s` — the shipped default and its bounds. A
 * value outside the bounds is clamped, a non-number is the default: the knob
 * tunes the pace, it can never switch the pacing off. */
export const EVIDENCE_WHY_INTERVAL_DEFAULT_S = 10;
export const EVIDENCE_WHY_INTERVAL_MIN_S = 5;
export const EVIDENCE_WHY_INTERVAL_MAX_S = 600;

/** The minimum gap, in ms, between the END of one sweep `why` exec and the
 * start of the next. */
export function evidenceWhyIntervalMs(cfg: Pick<TuiConfig, "evidence_why_interval_s">): number {
  const raw: unknown = cfg.evidence_why_interval_s;
  const s = typeof raw === "number" && Number.isFinite(raw) ? raw : EVIDENCE_WHY_INTERVAL_DEFAULT_S;
  return Math.min(EVIDENCE_WHY_INTERVAL_MAX_S, Math.max(EVIDENCE_WHY_INTERVAL_MIN_S, s)) * 1000;
}

/** Why a sweep did nothing at all this poll. */
export type SweepHold = "draining" | "heartbeat-stale";

/**
 * The board's last status says the daemon should not be asked for anything
 * now: it is draining (a deploy window — the container is busy finishing
 * rounds), or its heartbeat is older than `[tui] stale_after_s` (the same
 * bound the board's DATA STALE banner uses — the daemon writes `heartbeat`
 * and `written_at` together). A heartbeat that cannot be read is not a fresh
 * one (honest-unknown). A heartbeat AHEAD of this clock is clock skew between
 * the PC and the VM, not staleness.
 */
export function sweepHold(
  snapshot: StatusSnapshot,
  nowMs: number,
  staleAfterS: number,
): SweepHold | undefined {
  if (snapshot.draining === true) return "draining";
  const beat = typeof snapshot.heartbeat === "string" ? Date.parse(snapshot.heartbeat) : NaN;
  if (!Number.isFinite(beat) || nowMs - beat > staleAfterS * 1000) return "heartbeat-stale";
  return undefined;
}

// ---- the sweep's progress record (L1) -----------------------------

/** File name of the record, beside the TUI's other state files
 * (`<sandbox root>/state/`). */
export const SWEEP_PROGRESS_FILE = "tui-evidence-sweep.json";
export const SWEEP_PROGRESS_VERSION = 1;

/** One PR's entry: the snapshot signature it was last cleanly reconciled at,
 * and whether the store held anything for it once that reconcile was done.
 * `stored: false` is the ordinary case of a PR whose rounds were all still
 * RUNNING (or that had none): the reconcile was clean and copied nothing, so
 * no `pr-<n>` dir exists — and a missing dir proves nothing lost. Only an
 * entry that says the store held the PR's evidence can be caught out by that
 * evidence having gone. */
export interface SweepEntry {
  sig: string;
  stored: boolean;
}

/** On disk: what `EvidenceCopier.reconciled` holds, and which store it is
 * about. An entry here means "this PR, at this snapshot signature, was
 * cleanly reconciled into THIS store" — a claim about the store, so the store
 * is named in the record and a record about another store is not believed. */
export interface SweepProgressRecord {
  version: typeof SWEEP_PROGRESS_VERSION;
  store_dir: string;
  updated_at: string;
  /** PR number (decimal string key) → its entry. */
  reconciled: Record<string, SweepEntry>;
}

/** Four answers, never a throw. `absent` (first run) and `read` are the only
 * ones that are not news; `unreadable` and `other-store` are each treated as
 * an EMPTY record with a notice — never as "all reconciled". */
export type SweepProgressRead =
  | { kind: "absent" }
  | { kind: "read"; reconciled: Map<number, SweepEntry> }
  | { kind: "unreadable"; reason: string }
  | { kind: "other-store"; storeDir: string };

/** The seam the copier keeps its progress through (a fake in tests). */
export interface SweepProgressStore {
  read(storeDir: string): SweepProgressRead;
  /** Atomic replace. May throw; the copier owns the notice. */
  write(storeDir: string, reconciled: ReadonlyMap<number, SweepEntry>, at: Date): void;
}

/** Parse a record's text against the store it must describe. Strict: one
 * malformed entry makes the whole record unreadable, because a half-believed
 * record is a record nobody can reason about. */
export function parseSweepProgress(text: string, storeDir: string): SweepProgressRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { kind: "unreadable", reason: `not JSON (${msg(err)})` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return { kind: "unreadable", reason: "not an object" };
  const rec = parsed as Partial<Record<keyof SweepProgressRecord, unknown>>;
  if (rec.version !== SWEEP_PROGRESS_VERSION)
    return { kind: "unreadable", reason: `unknown version ${JSON.stringify(rec.version)}` };
  if (typeof rec.store_dir !== "string" || rec.store_dir === "")
    return { kind: "unreadable", reason: "no store_dir" };
  const entries = rec.reconciled;
  if (typeof entries !== "object" || entries === null || Array.isArray(entries))
    return { kind: "unreadable", reason: "no reconciled map" };
  const reconciled = new Map<number, SweepEntry>();
  for (const [key, raw] of Object.entries(entries)) {
    const entry = raw as Partial<Record<keyof SweepEntry, unknown>> | null;
    if (
      !/^[1-9]\d*$/.test(key) ||
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry) ||
      typeof entry.sig !== "string" ||
      entry.sig === "" ||
      typeof entry.stored !== "boolean"
    )
      return { kind: "unreadable", reason: `malformed entry ${JSON.stringify(key)}` };
    reconciled.set(Number(key), { sig: entry.sig, stored: entry.stored });
  }
  if (resolve(rec.store_dir) !== resolve(storeDir))
    return { kind: "other-store", storeDir: rec.store_dir };
  return { kind: "read", reconciled };
}

/** The record as a file: read whole, written temp + rename. */
export class SweepProgressFile implements SweepProgressStore {
  constructor(readonly path: string) {}

  read(storeDir: string): SweepProgressRead {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
      return { kind: "unreadable", reason: msg(err) };
    }
    return parseSweepProgress(text, storeDir);
  }

  write(storeDir: string, reconciled: ReadonlyMap<number, SweepEntry>, at: Date): void {
    const record: SweepProgressRecord = {
      version: SWEEP_PROGRESS_VERSION,
      store_dir: storeDir,
      updated_at: at.toISOString(),
      reconciled: Object.fromEntries(
        [...reconciled]
          .sort(([a], [b]) => a - b)
          .map(([pr, { sig, stored }]) => [String(pr), { sig, stored }]),
      ),
    };
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
    renameSync(tmp, this.path); // atomic: a re-exec never reads a torn record
  }
}

/** The local store: one dir per PR, one dir per round, manifest written last. */
export class EvidenceStore {
  constructor(readonly dir: string) {}

  ensure(): void {
    mkdirSync(this.dir, { recursive: true });
  }

  roundDir(pr: number, round: number): string {
    return join(this.dir, `pr-${pr}`, `round-${round}`);
  }

  /**
   * Idempotence, and the whole of it: the manifest is written last, atomically,
   * so its presence means every artefact for that round already landed. A
   * crashed half-copy leaves no manifest and is simply redone — files are
   * overwritten in place, never appended, so a retry cannot duplicate anything.
   */
  has(pr: number, round: number): boolean {
    return existsSync(join(this.roundDir(pr, round), MANIFEST_NAME));
  }

  /** Whether the store holds anything at all for a PR (one stat, no walk). */
  hasPr(pr: number): boolean {
    return existsSync(join(this.dir, `pr-${pr}`));
  }

  /** Round numbers already copied for a PR (used only for reporting). */
  copiedRounds(pr: number): number[] {
    const dir = join(this.dir, `pr-${pr}`);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .map((d) => /^round-(\d+)$/.exec(d)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number)
      .filter((n) => this.has(pr, n))
      .sort((a, b) => a - b);
  }

  writeArtifact(pr: number, round: number, role: EvidenceRole, body: string): void {
    const dir = this.roundDir(pr, round);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, LOCAL_NAME[role]), body);
  }

  writeManifest(m: RoundManifest): void {
    const dir = this.roundDir(m.pr, m.round_no);
    mkdirSync(dir, { recursive: true });
    const target = join(dir, MANIFEST_NAME);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(m, null, 2)}\n`);
    renameSync(tmp, target); // atomic: a reader never sees a half-written marker
  }
}

export interface CopierDeps {
  /** Relative session dir inside the sandbox root (`[pi] session_dir`). */
  sessionDir: string;
  /** How long any single remote read may take before it is killed. */
  timeoutMs: number;
  onNotice?: (text: string) => void;
  now?: () => Date;
  /** L1: where the sweep keeps its per-PR progress across a re-exec
   * or restart. Absent = in memory only (the pre-L1 behaviour, kept for the
   * unit harness); the TUI always passes the file. */
  progress?: SweepProgressStore;
  /** L1: the minimum gap between the END of one `why` exec and the
   * start of the next — and between the copier's construction and its first
   * `why`, so the pace holds across a re-exec — and with it at most one `why`
   * per sweep. Absent or 0 = unpaced (the unit harness); the TUI always
   * passes `evidenceWhyIntervalMs(cfg)`, which cannot be 0. */
  whyIntervalMs?: number;
}

export interface SweepReport {
  /** `pr-<n> round <k>` for each round that landed this sweep. */
  copied: string[];
  /** Human note for a PR whose copy could not complete (retried next poll). */
  failures: string[];
  /** Set when the sweep did nothing because of the board's last status. */
  held?: SweepHold;
  /** Set when a PR needed a `why` and the pace said not yet. */
  paced?: boolean;
  /** Notes about the progress record itself (unreadable, another store's,
   * not saved) — announced once, never per poll. */
  progress?: string[];
}

/**
 * The copier itself. Driven from the TUI's existing poll — there is deliberately
 * no second scheduler and no timer of its own: `sweep()` is called by the poll
 * hook, never awaited by it, and a sweep already in flight makes the next call a
 * no-op, so a wedged ssh can stall this and nothing else.
 *
 * Order (L1): PRs needing a `why` are visited in a ROTATION by number
 * starting at `nextFrom`. A failed PR moves the rotation past itself, so under
 * pacing — one `why` per sweep — it is retried only after every other pending
 * PR has had its turn (retried, never starving the rest). A PR that
 * made progress but still has a backlog (more than `ROUNDS_PER_SWEEP` rounds)
 * keeps the rotation on itself, so its backlog drains on consecutive turns.
 */
export class EvidenceCopier {
  private busy = false;
  /** Last snapshot signature per PR that was fully reconciled, and whether
   * the store held anything for it then. Persisted through `deps.progress`
   * (L1), loaded on the first sweep. */
  private readonly reconciled = new Map<number, SweepEntry>();
  /** The record has been loaded (or there is none to load). */
  private loaded = false;
  /** `reconciled` changed since the record was last written. */
  private dirty = false;
  /** A failed record write was announced; quiet until one succeeds. */
  private writeFailAnnounced = false;
  /** Rotation start: the next `why` goes to the first pending PR whose number
   * is ≥ this, wrapping around. */
  private nextFrom = 0;
  /** When the last `why` exec RETURNED (ms since epoch), for the pace. A
   * paced copier starts it at CONSTRUCTION: every TUI re-exec builds a new
   * copier, and one that could fire at once would let a run of local builds
   * — each a new generation — send `why`s faster than the interval. */
  private lastWhyEndMs: number | undefined;
  /** When THIS copier first saw each PR (ms since epoch). A round that
   * finished before that moment is a BACKFILL: its pr-current roles (ledger,
   * prompt, transcript) are skipped rather than stamped in as if today's
   * files were that round's — only verdict.json is copied. In-memory on
   * purpose: after a TUI restart everything already copied has a manifest,
   * and anything not yet copied is honestly "first seen now". */
  private readonly firstSeen = new Map<number, number>();
  /** The last sweep was HELD (L1). */
  private held = false;
  /** When the first sweep after a hold ran (ms since epoch; 0 = never held).
   * The copier was not looking while it was held, so a round that finished
   * before this moment did not finish under its watch either — a backfill,
   * exactly as one that finished before `firstSeen`. It matters most after a
   * drain: new rounds start the moment it lifts, so by the time the held
   * rounds are copied the PR's current ledger, prompt and transcript may
   * already be the next round's. */
  private watchResumedMs = 0;
  /** Rounds whose failure has already been announced — so a VM that stays
   * unreachable degrades to silence rather than a notice every 3 seconds. */
  private readonly announced = new Set<string>();

  constructor(
    private readonly cfg: TuiConfig,
    readonly store: EvidenceStore,
    private readonly ssh: SshRunner,
    private readonly deps: CopierDeps,
  ) {
    if ((deps.whyIntervalMs ?? 0) > 0) this.lastWhyEndMs = this.nowMs();
  }

  /** True while a sweep is in flight (the poll hook's re-entry guard). */
  get running(): boolean {
    return this.busy;
  }

  /**
   * One pass over the poll snapshot. Never throws: a failure is a note in the
   * report and a retry on the next poll, because a TUI that cannot copy
   * evidence is a TUI that must still paint.
   */
  async sweep(snapshot: StatusSnapshot | undefined): Promise<SweepReport> {
    const report: SweepReport = { copied: [], failures: [] };
    if (!snapshot || this.busy) return report;
    this.busy = true;
    try {
      this.store.ensure();
      this.loadProgress(report);
      await this.visit(snapshot, report);
    } catch (err) {
      report.failures.push(`evidence sweep failed: ${msg(err)}`);
    } finally {
      this.saveProgress(report);
      this.busy = false;
    }
    for (const note of report.progress ?? []) this.deps.onNotice?.(note);
    for (const note of report.copied) this.deps.onNotice?.(note);
    for (const note of report.failures) this.deps.onNotice?.(note);
    return report;
  }

  /** The sweep's one pass over the snapshot (the caller owns busy, the
   * record and the notices). */
  private async visit(snapshot: StatusSnapshot, report: SweepReport): Promise<void> {
    const nowMs = this.nowMs();
    for (const pr of snapshot.prs)
      if (!this.firstSeen.has(pr.number)) this.firstSeen.set(pr.number, nowMs);
    // L1: the board's last status says leave the daemon alone — no
    // `why`, no listing, no fetch. The hold is visible on the board itself
    // (the drain badge, DATA STALE), so it is not a notice.
    const hold = sweepHold(snapshot, nowMs, this.cfg.stale_after_s);
    if (hold !== undefined) {
      report.held = hold;
      this.held = true;
      return;
    }
    // Back from a hold: the watch restarts now (see `watchResumedMs`).
    if (this.held) {
      this.held = false;
      this.watchResumedMs = nowMs;
    }
    const byNumber = [...snapshot.prs].sort((a, b) => a.number - b.number);
    // A PR with no rounds costs nothing: retired without a `why`, whatever
    // the pace says.
    for (const pr of byNumber) if ((pr.rounds ?? 0) === 0) this.retire(pr.number, prSignature(pr));
    const pending = byNumber.filter(
      (pr) => this.reconciled.get(pr.number)?.sig !== prSignature(pr),
    );
    const start = pending.findIndex((pr) => pr.number >= this.nextFrom);
    const rotation = start <= 0 ? pending : [...pending.slice(start), ...pending.slice(0, start)];
    for (const pr of rotation) {
      if (!this.whyDue()) {
        report.paced = true;
        return;
      }
      const sig = prSignature(pr);
      const before = report.copied.length;
      const ok = await this.reconcilePr(pr.number, report);
      // Only a clean reconcile retires the signature; anything else is
      // retried on a later poll, which is what "survives a wedged ssh"
      // means here.
      if (ok) this.retire(pr.number, sig);
      const progressed = report.copied.length > before;
      // A backlog still draining keeps the rotation on this PR; a finished
      // PR or a FAILED one moves it on — a failure must not make the same
      // PR the first pick every turn.
      this.nextFrom = !ok && progressed ? pr.number : pr.number + 1;
      // Successful work is bounded to one PR per sweep: the poll runs every
      // few seconds and a backlog drains across ticks without ever holding
      // the loop. A FAILURE does not consume the sweep — a failed PR keeps
      // its stale signature, so stopping on it would make one permanently
      // failing PR the first pick every tick and starve all the others
      // forever. Move on to the next PR instead (when the pace allows; it
      // otherwise waits for the next turn of the rotation).
      if (ok || progressed) return;
    }
  }

  private nowMs(): number {
    return (this.deps.now?.() ?? new Date()).getTime();
  }

  /** May a `why` run now? Unpaced (the unit harness) always; paced, only once
   * the full interval has passed since the previous one RETURNED — measured
   * from the end, so a `why` slowed by a starved container is followed by the
   * same idle gap as a fast one, never by another `why` at once — or, before
   * the first, since this copier was built. */
  private whyDue(): boolean {
    const interval = this.deps.whyIntervalMs ?? 0;
    if (interval <= 0 || this.lastWhyEndMs === undefined) return true;
    return this.nowMs() - this.lastWhyEndMs >= interval;
  }

  /** Record a clean reconcile, with whether the store now holds anything
   * for the PR (one stat, only when the signature moved). */
  private retire(pr: number, sig: string): void {
    if (this.reconciled.get(pr)?.sig === sig) return;
    this.reconciled.set(pr, { sig, stored: this.store.hasPr(pr) });
    this.dirty = true;
  }

  private note(report: SweepReport, text: string): void {
    (report.progress ??= []).push(text);
  }

  /**
   * First sweep only: believe the record where it can be believed. An entry
   * that says the store held the PR's evidence is kept only while the store
   * still holds that PR — a record cannot vouch for evidence that is no
   * longer on disk. An entry that says the store held nothing (its rounds
   * were all still running, or it had none) is believed without a dir: there
   * was never one to lose.
   */
  private loadProgress(report: SweepReport): void {
    if (this.loaded) return;
    this.loaded = true;
    const progress = this.deps.progress;
    if (!progress) return;
    const read = progress.read(this.store.dir);
    switch (read.kind) {
      case "absent":
        return;
      case "unreadable":
        this.dirty = true; // replace it with a readable one at the next save
        this.note(
          report,
          `evidence: sweep progress record unreadable (${read.reason}) — re-checking every PR`,
        );
        return;
      case "other-store":
        this.dirty = true;
        this.note(
          report,
          `evidence: sweep progress record is for another store (${read.storeDir}) — re-checking every PR`,
        );
        return;
      case "read": {
        let gone = 0;
        for (const [pr, entry] of read.reconciled) {
          if (entry.stored && !this.store.hasPr(pr)) {
            gone += 1;
            continue;
          }
          this.reconciled.set(pr, entry);
        }
        if (gone > 0) {
          this.dirty = true;
          this.note(
            report,
            `evidence: ${gone} PR${gone === 1 ? "" : "s"} in the sweep record ${gone === 1 ? "has" : "have"} no evidence on disk — re-checking ${gone === 1 ? "it" : "them"}`,
          );
        }
        return;
      }
    }
  }

  /** Write the record when it changed. A failed write costs a notice (once)
   * and a retry at the next sweep (a temp file and a rename, local) — never
   * the sweep itself. */
  private saveProgress(report: SweepReport): void {
    const progress = this.deps.progress;
    if (!progress || !this.dirty) return;
    try {
      progress.write(this.store.dir, this.reconciled, this.deps.now?.() ?? new Date());
      this.dirty = false;
      this.writeFailAnnounced = false;
    } catch (err) {
      if (!this.writeFailAnnounced) {
        this.writeFailAnnounced = true;
        this.note(
          report,
          `evidence: sweep progress not saved (${msg(err)}) — a restart re-checks every PR`,
        );
      }
    }
  }

  private async reconcilePr(pr: number, report: SweepReport): Promise<boolean> {
    let res: RemoteResult;
    try {
      res = await this.ssh(this.cfg.ssh_host, whyArgv(this.cfg, pr), {
        timeoutMs: this.deps.timeoutMs,
      });
    } finally {
      this.lastWhyEndMs = this.nowMs();
    }
    if (!res.ok)
      return this.fail(report, `pr-${pr}`, `evidence: #${pr} — could not read round list (ssh)`);
    // The round list is what `qcr why --json` PROVES; anything else that came
    // back — a wrapper's own JSON, an older build's shape, a torn write — is an
    // unreadable list, not an empty one. Reading it as empty would retire this
    // PR's signature with nothing copied, and nothing would ever retry it
    //.
    const rounds = readWhyRounds(res.stdout);
    if (rounds === undefined)
      return this.fail(report, `pr-${pr}`, `evidence: #${pr} — unreadable round list`);
    const pending = rounds.filter((r) => !this.store.has(pr, r.round_no));
    if (pending.length === 0) return true;
    let complete = true;
    for (const round of pending.slice(0, ROUNDS_PER_SWEEP)) {
      const done = await this.copyRound(pr, round, report);
      if (!done) {
        complete = false;
        break; // the VM is unhappy; stop hammering it this tick
      }
    }
    return complete && pending.length <= ROUNDS_PER_SWEEP;
  }

  private async copyRound(pr: number, round: WhyRound, report: SweepReport): Promise<boolean> {
    const key = `pr-${pr} round ${round.round_no}`;
    const listed = await this.ssh(
      this.cfg.ssh_host,
      manifestArgv(this.cfg, this.deps.sessionDir, pr, round.round_no),
      {
        timeoutMs: this.deps.timeoutMs,
      },
    );
    if (!listed.ok)
      return this.fail(report, key, `evidence: ${key} — could not list artefacts (ssh)`);
    const files = parseManifest(listed.stdout, this.cfg.remote_sandbox_root);
    // A round that finished before this copier first saw the PR — or before
    // it came back from a hold (L1) — is a BACKFILL: the pr-current
    // roles on the VM are the PR's files as of TODAY, not that round's, so
    // copying them would fabricate round evidence. Verdict only. An
    // unparseable/absent finished_at is treated as backfill — the honest
    // direction, since freshness cannot be shown.
    const watchedFrom = Math.max(this.firstSeen.get(pr) ?? 0, this.watchResumedMs);
    const finishedMs = round.finished_at === null ? NaN : Date.parse(round.finished_at);
    const backfill = !Number.isFinite(finishedMs) || finishedMs < watchedFrom;
    const skipped: EvidenceRole[] = backfill
      ? PR_CURRENT_ROLES.filter((r) => files.some((f) => f.role === r))
      : [];
    const toCopy = backfill ? files.filter((f) => f.role === "verdict") : files;
    // a role found nowhere live may be in the PR's archive. Its
    // manifest says where; a role it holds is `archived` (a pr-current one
    // in a backfill is skipped as stale, exactly as a live one is), never
    // `missing`. A manifest that cannot be fetched or read fails the copy —
    // a manifest written now would say `missing` forever.
    const archived: NonNullable<RoundManifest["archived"]> = [];
    const absent = EVIDENCE_ROLES.filter((r) => !files.some((f) => f.role === r));
    const manifestPath = parseArchiveManifestLine(listed.stdout, this.cfg.remote_sandbox_root, pr);
    if (absent.length > 0 && manifestPath) {
      const got = await this.ssh(this.cfg.ssh_host, fetchArgv(this.cfg, manifestPath), {
        timeoutMs: this.deps.timeoutMs,
      });
      if (!got.ok)
        return this.fail(report, key, `evidence: ${key} — archive manifest fetch failed`);
      const manifest = parseArchiveManifest(got.stdout);
      if (!manifest)
        return this.fail(report, key, `evidence: ${key} — unreadable archive manifest`);
      for (const role of absent) {
        const at = archivedRole(manifest, role, pr, round.round_no, this.deps.sessionDir);
        if (!at) continue;
        if (backfill && PR_CURRENT_ROLES.includes(role)) skipped.push(role);
        else archived.push({ role, ...at });
      }
    }
    const written: RoundManifest["files"] = [];
    for (const f of toCopy) {
      const got = await this.ssh(this.cfg.ssh_host, fetchArgv(this.cfg, f.remotePath), {
        timeoutMs: this.deps.timeoutMs,
      });
      // An ssh that failed is a transport fault, not an absent artefact: leaving
      // the manifest unwritten is what makes the round come back next poll.
      if (!got.ok) return this.fail(report, key, `evidence: ${key} — ${f.role} fetch failed`);
      this.store.writeArtifact(pr, round.round_no, f.role, got.stdout);
      written.push({
        role: f.role,
        remote_path: f.remotePath,
        chars: got.stdout.length,
        // The cap is BYTES (`head -c`) and stdout arrives decoded, so compare
        // in bytes — multibyte text would otherwise read as short of the cap.
        truncated: Buffer.byteLength(got.stdout, "utf8") >= MAX_FILE_BYTES,
        scope: PR_CURRENT_ROLES.includes(f.role) ? "pr-current" : "round",
        from: isArchivedGzip(f.remotePath, this.cfg.remote_sandbox_root) ? "archive" : "live",
      });
    }
    this.store.writeManifest({
      pr,
      round_no: round.round_no,
      copied_at: (this.deps.now?.() ?? new Date()).toISOString(),
      round,
      roles_note: ROLES_NOTE,
      files: written,
      archived,
      missing: EVIDENCE_ROLES.filter(
        (r) =>
          !written.some((w) => w.role === r) &&
          !skipped.includes(r) &&
          !archived.some((a) => a.role === r),
      ),
      skipped_stale: skipped,
    });
    this.announced.delete(key);
    report.copied.push(
      `evidence: ${key} copied (${written.length} file${written.length === 1 ? "" : "s"}` +
        `${archived.length > 0 ? `, ${archived.length} archived` : ""})`,
    );
    return true;
  }

  /** Announce a failure once, then stay quiet until that round succeeds. */
  private fail(report: SweepReport, key: string, text: string): false {
    if (!this.announced.has(key)) {
      this.announced.add(key);
      report.failures.push(text);
    }
    return false;
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
