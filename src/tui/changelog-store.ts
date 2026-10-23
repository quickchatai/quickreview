// The change register — every feedback-derived change this loop has
// produced, newest first, with a one-key revert behind it.
//
// Why it exists. Per-change ceremony is deliberately light: the owner approves
// the idea in a ratifying turn, not the diff. The risk that buys is drift
// — no single change looks like lowering the bar, ten might — so the guard is
// that the whole set is readable at once, and that any one of them comes back
// out with one key. Without this list that light approval is unprotected.
//
// How a change is identified: by commit trailers.
//
//     Feedback-PR: 5270            ← omitted when the change came from no episode
//     Adjudication: FT-NNNN        ← omitted likewise
//     Ratified-in-session: <what ratified it>
//
// `Ratified-in-session:` — and only it — is the register's key. A commit
// carrying it is a change this loop produced; a commit without it is not,
// however it is worded. Today the TUI's rubric-accept path is the one writer
// (the owner's accept click is the ratification). The companion writes no
// trailers: the history is public, so its commits carry no quote, session id
// or ticket id (skills/companion/land/SKILL.md).
//
// Trailers are read from the last paragraph of the message only, the same
// header-only discipline `src/memory/eventtags.ts` uses: a quoted line in a
// commit body must never be able to mint a register entry.
//
// Reverts are read back out of git, not out of this file. `git revert` writes
// "This reverts commit <sha>." into the message it makes, so a reverted entry
// stays marked after any restart, on any checkout, even if this file is deleted
// — the durability of record lives in the repository, and the JSON is a cache
// that makes the tab paint instantly and remembers when we first saw a change.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { LocalRunner } from "./deploytab.js";
import { errText, readJsonFile, writeJsonFile } from "./jsonfile.js";
import type { RemoteResult } from "./remote.js";

// ---- the trailer convention ---------------------------------------------------

/** Never omitted — the register's key. */
export const TRAILER_RATIFIED = "Ratified-in-session";
/** The episode the change came from; omitted when there was none. */
export const TRAILER_FEEDBACK = "Feedback-PR";
/** The adjudication ticket that justified it; omitted likewise. */
export const TRAILER_ADJUDICATION = "Adjudication";

// ---- reading git --------------------------------------------------------------

/** Field separator (US) and record separator (RS) — bytes a commit message
 * cannot contain, so no message can fake a record boundary. */
const FS = "\x1f";
const RS = "\x1e";

export const CHANGE_LOG_FORMAT = `%H${FS}%aI${FS}%an${FS}%s${FS}%B${RS}`;

/**
 * How many commits back a scan looks. A bound rather than a full-history walk:
 * the register is about this loop's output, which is recent history.
 * Entries already in the file are never dropped for falling off this window —
 * `mergeRegister` only ever adds — so raising or lowering it cannot lose a row.
 */
export const SCAN_LIMIT = 500;

export function changeLogArgv(limit: number = SCAN_LIMIT): string[] {
  return ["git", "log", `-${Math.max(1, Math.floor(limit))}`, `--format=${CHANGE_LOG_FORMAT}`];
}

/** `git status --porcelain` — the dirty-tree check that protects rule 11. */
export const DIRTY_ARGV = ["git", "status", "--porcelain"];

export function revertArgv(sha: string): string[] {
  return ["git", "revert", "--no-edit", sha];
}

export const REVERT_ABORT_ARGV = ["git", "revert", "--abort"];

export interface ChangeCommit {
  sha: string;
  at: string;
  author: string;
  subject: string;
  body: string;
}

/** Parse `changeLogArgv`'s output. Malformed records are skipped, never
 * guessed at: a half-record is a truncated read, not a fact about history. */
export function parseGitLog(stdout: string): ChangeCommit[] {
  const out: ChangeCommit[] = [];
  for (const record of stdout.split(RS)) {
    const rec = record.replace(/^\s+/, "");
    if (rec === "") continue;
    const [sha, at, author, subject, ...rest] = rec.split(FS);
    if (!sha || !/^[0-9a-f]{7,40}$/.test(sha)) continue;
    out.push({
      sha,
      at: at ?? "",
      author: author ?? "",
      subject: subject ?? "",
      body: rest.join(FS),
    });
  }
  return out;
}

/**
 * The message's trailer block: `Key: value` lines in the last paragraph only.
 * A paragraph that is not entirely trailer-shaped yields nothing — that is what
 * stops a body's closing prose line from being read as a trailer.
 */
export function messageTrailers(body: string): Record<string, string> {
  const paragraphs = body.replace(/\s+$/, "").split(/\n\s*\n/);
  const last = paragraphs[paragraphs.length - 1];
  if (last === undefined) return {};
  const lines = last.split("\n").filter((l) => l.trim() !== "");
  const out: Record<string, string> = {};
  for (const line of lines) {
    const m = /^([A-Za-z][A-Za-z0-9-]*):[ \t]+(.+)$/.exec(line);
    if (!m) return {}; // not a trailer block at all
    if (!(m[1]! in out)) out[m[1]!] = m[2]!.trim();
  }
  return out;
}

/** The sha a revert commit undoes — git's own "This reverts commit …" line. */
export function revertedSha(body: string): string | undefined {
  const m = /^\s*This reverts commit ([0-9a-f]{7,40})\b/m.exec(body);
  return m ? m[1]! : undefined;
}

// ---- the register -------------------------------------------------------------

export interface ChangeEntry {
  sha: string;
  short: string;
  /** Author date, ISO. */
  at: string;
  author: string;
  subject: string;
  /** `Feedback-PR:` — the episode, when there was one. */
  feedback_pr?: string;
  /** `Adjudication:` — the ticket that justified it, when there was one. */
  adjudication?: string;
  /** `Ratified-in-session:` — never absent on a listed change. */
  ratified: string;
  /** First scan that saw it. Never rewritten, so age reads true. */
  first_seen: string;
  /** Set when a later commit reverts this one — read out of git, not written
   * here, so it survives a deleted register file. */
  reverted?: { by: string; at: string };
}

export interface ChangeRegister {
  version: 1;
  updated_at: string;
  /** Newest first — the order the tab paints. */
  entries: ChangeEntry[];
  /** How many commits the scan actually looked at. */
  scanned: number;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * Commits → entries, newest first (git log's own order). Only commits carrying
 * `Ratified-in-session:` become entries; every commit — trailered or not — can
 * mark one as reverted, because a revert of a listed change may itself be an
 * ordinary commit.
 */
export type RevertIndex = Map<string, { by: string; at: string }>;

/** Every revert the scan saw that still stands, keyed by the sha (or
 * abbreviation) it undoes. A revert that was itself reverted (a reapply)
 * undoes nothing any more, so it marks nothing: a change reverted and then
 * restored is live again, and revertible. */
export function revertsIn(commits: ChangeCommit[]): RevertIndex {
  const reverts: RevertIndex = new Map();
  // Newest first, so a revert is seen before the commit it undoes — and a
  // revert's own undoing before the revert.
  for (const c of commits) {
    const target = revertedSha(c.body);
    if (!target) continue;
    if (revertOf(reverts, c.sha)) continue; // this revert was itself reverted
    // The first revert seen for a target is the latest one.
    if (!reverts.has(target)) reverts.set(target, { by: shortSha(c.sha), at: c.at });
  }
  return reverts;
}

/** The revert of `sha` in the index. Either side may be abbreviated: a revert
 * message can name an abbreviation, and a register row records its reverter
 * by its short sha. */
function revertOf(reverts: RevertIndex, sha: string): { by: string; at: string } | undefined {
  return (
    reverts.get(sha) ??
    [...reverts.entries()].find(([k]) => sha.startsWith(k) || k.startsWith(sha))?.[1]
  );
}

/** Newest first by author date — compared as instants, since `%aI` carries
 * each author's own offset — with the sha as the tiebreak so the order is
 * stable. */
function newestFirst(a: ChangeEntry, b: ChangeEntry): number {
  const d = (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0);
  if (d !== 0) return d;
  return a.sha < b.sha ? 1 : a.sha > b.sha ? -1 : 0;
}

export function buildEntries(commits: ChangeCommit[], now: string): ChangeEntry[] {
  const reverts = revertsIn(commits);
  const entries: ChangeEntry[] = [];
  for (const c of commits) {
    const t = messageTrailers(c.body);
    const ratified = t[TRAILER_RATIFIED];
    if (ratified === undefined || ratified === "") continue;
    const entry: ChangeEntry = {
      sha: c.sha,
      short: shortSha(c.sha),
      at: c.at,
      author: c.author,
      subject: c.subject,
      ratified,
      first_seen: now,
    };
    if (t[TRAILER_FEEDBACK]) entry.feedback_pr = t[TRAILER_FEEDBACK];
    if (t[TRAILER_ADJUDICATION]) entry.adjudication = t[TRAILER_ADJUDICATION];
    // A revert can be recorded against the full sha or an abbreviation.
    const rev = revertOf(reverts, c.sha);
    if (rev) entry.reverted = rev;
    entries.push(entry);
  }
  return entries;
}

/**
 * Fold a fresh scan into the stored register.
 *
 * Two rules, both load-bearing:
 *  · `first_seen` is never rewritten — the register is a record, not a mirror.
 *  · An entry the scan no longer reaches (older than `SCAN_LIMIT`, or a
 *    checkout that does not carry it) is kept. Nothing here removes a row; a
 *    list that quietly forgets a change is worse than no list, because the
 *    whole point is reading the drift in one place.
 *
 * A kept row is not frozen, though: a revert the scan did reach (`reverts`)
 * marks it, because the target of a recent revert may itself be older than the
 * window — and a row still offered for revert after it was reverted is a lie.
 */
export function mergeRegister(
  previous: ChangeEntry[],
  fresh: ChangeEntry[],
  reverts: RevertIndex = new Map(),
): ChangeEntry[] {
  const byShaOld = new Map(previous.map((e) => [e.sha, e]));
  const merged: ChangeEntry[] = fresh.map((e) => {
    const old = byShaOld.get(e.sha);
    return old ? { ...e, first_seen: old.first_seen } : e;
  });
  const seen = new Set(merged.map((e) => e.sha));
  for (const old of previous) {
    if (seen.has(old.sha)) continue;
    // A kept row's revert stands unless the scan saw that revert reverted.
    const stands = old.reverted && !revertOf(reverts, old.reverted.by) ? old.reverted : undefined;
    const rev = stands ?? revertOf(reverts, old.sha);
    const { reverted: _was, ...rest } = old;
    merged.push(rev ? { ...rest, reverted: rev } : rest);
  }
  return merged.sort(newestFirst);
}

export const REGISTER_FILE = "change-register.json";

/**
 * What a read of the register file found (the `CandidateStore.read` shape).
 * `absent` is a state dir with no register yet — the first scan writes one.
 * `unreadable` is a register that exists and cannot
 * be read: a torn write, a hand edit, a full disk. The two must never fold:
 * a scan merged onto an "empty" baseline and saved would rewrite
 * `first_seen` on every row and drop every row the scan no longer reaches —
 * the two things `mergeRegister` promises never happen.
 */
export type RegisterRead =
  | { state: "register"; register: ChangeRegister }
  | { state: "absent" }
  | { state: "unreadable"; reason: string };

/** Same idiom as `EvidenceStore`/`CandidateStore`: a plain file, written
 * atomically (temp + rename) so a reader never sees half a register, re-read
 * from disk rather than held in memory, so a TUI restart costs nothing. */
export class ChangeRegisterStore {
  constructor(readonly dir: string) {}

  get path(): string {
    return join(this.dir, REGISTER_FILE);
  }

  ensure(): void {
    mkdirSync(this.dir, { recursive: true });
  }

  /** Never a throw — and never a collapse of "cannot read" into "no changes";
   * there is deliberately no `load()` returning `ChangeRegister | undefined`
   * beside this (that accessor is what a merge-and-save reaches for). */
  read(): RegisterRead {
    const read = readJsonFile(this.path);
    if (read.state !== "parsed") return read;
    const parsed = read.value as ChangeRegister | null;
    if (!Array.isArray(parsed?.entries)) return { state: "unreadable", reason: "no entries array" };
    return { state: "register", register: parsed };
  }

  save(register: ChangeRegister): void {
    writeJsonFile(this.path, register);
  }
}

// ---- scanning and reverting ---------------------------------------------------

/**
 * What stops the register from being the whole story. `register_unreadable`
 * is the file on disk: it exists and cannot be read, so nothing is scanned
 * and nothing is saved over it. `scan_failed` is git: the stored register
 * stands, but whether it is current is unknown. The tab renders each as its
 * own sentence — neither is "no changes yet".
 */
export type ChangeLogProblem =
  | { kind: "register_unreadable"; reason: string }
  | { kind: "scan_failed"; reason: string }
  | { kind: "save_failed"; reason: string };

export interface RevertResult {
  ok: boolean;
  message: string;
}

/**
 * The register's one write.
 *
 * Bounds, all structural:
 *  · It runs `git revert` in the local sandbox checkout and nothing else. No
 *    push, no GitHub call, nothing near the
 *    `MutationGate` — a revert here is a local commit and a rebuild, exactly
 *    what the companion's own landing path is.
 *  · It refuses on a dirty tree. Root rule 11: the checkout is shared and a
 *    dirty tree is almost certainly the companion's in-flight work, which is
 *    never ours to stash, reset or commit around. `git revert` would refuse
 *    anyway — refusing first is how the operator gets told why.
 *  · A conflicted revert is aborted, not left half-applied in the tree the
 *    companion is working in.
 *  · Only a sha the register lists can be reverted — this is not a general
 *    "run git for me" surface.
 */
export class ChangeLog {
  constructor(
    readonly store: ChangeRegisterStore,
    private readonly local: LocalRunner,
    private readonly now: () => Date = () => new Date(),
  ) {
    // The persisted register is the first paint: the tab has content before
    // git has been asked anything, which is what "survives a restart" means
    // in practice on a cold start.
    this.adopt(store.read());
  }

  /** Last loaded/scanned register — what the tab paints. */
  register: ChangeRegister | undefined;

  /** Why `register` cannot currently be trusted as the whole story — for the
   * tab to say. `undefined` means the last read and scan both succeeded. */
  problem: ChangeLogProblem | undefined;

  private busy = false;

  /** A scanned register the store refused to save: the next scan merges onto
   * it rather than onto the older file, so `first_seen` is not rewritten and
   * no row the scan no longer reaches is dropped. */
  private unsaved: ChangeRegister | undefined;

  /** Fold one file read into the two fields above. An unreadable file keeps
   * whatever register is already in memory (an earlier, true read) and marks
   * the problem; it never blanks the list. */
  private adopt(read: RegisterRead): void {
    if (read.state === "register") this.register = read.register;
    this.problem =
      read.state === "unreadable"
        ? { kind: "register_unreadable", reason: read.reason }
        : undefined;
  }

  /**
   * Re-scan git and fold the result into the stored register. Resolves to the
   * problem that stopped it, or `undefined` when `register` is fresh.
   *
   * The baseline is read first and an unreadable one stands the scan down
   * entirely — no git, no merge, no save. `mergeRegister` keeps every row the
   * scan no longer reaches and never rewrites `first_seen`; both promises are
   * only as good as the baseline they merge onto, and a torn file merged as
   * "no previous entries" and saved would falsify both at once.
   */
  async refresh(): Promise<ChangeLogProblem | undefined> {
    if (this.busy) return this.problem;
    this.busy = true;
    try {
      const baseline = this.store.read();
      this.adopt(baseline);
      if (baseline.state === "unreadable") return this.problem;
      const res = await this.local(changeLogArgv());
      if (!res.ok) {
        this.problem = { kind: "scan_failed", reason: firstLine(res.stderr || res.stdout) };
        return this.problem;
      }
      const commits = parseGitLog(res.stdout);
      const now = this.now().toISOString();
      const previous =
        this.unsaved?.entries ?? (baseline.state === "register" ? baseline.register.entries : []);
      const register: ChangeRegister = {
        version: 1,
        updated_at: now,
        entries: mergeRegister(previous, buildEntries(commits, now), revertsIn(commits)),
        scanned: commits.length,
      };
      this.register = register;
      // An unwritable state dir costs durability, never the view — and says
      // so, since the rows only this register holds would not survive a restart.
      try {
        this.store.save(register);
        this.unsaved = undefined;
        this.problem = undefined;
      } catch (err) {
        this.unsaved = register;
        this.problem = { kind: "save_failed", reason: errText(err) };
      }
      return this.problem;
    } catch (err) {
      this.problem = { kind: "scan_failed", reason: errText(err) };
      return this.problem;
    } finally {
      this.busy = false;
    }
  }

  async revert(sha: string): Promise<RevertResult> {
    const entry = this.register?.entries.find((e) => e.sha === sha);
    if (!entry)
      return { ok: false, message: `✖ ${shortSha(sha)} is not in the register — nothing reverted` };
    if (entry.reverted)
      return {
        ok: false,
        message: `✖ ${entry.short} was already reverted by ${entry.reverted.by}`,
      };

    const dirty = await this.local(DIRTY_ARGV);
    if (!dirty.ok)
      return {
        ok: false,
        message: `✖ git status failed — nothing reverted (${firstLine(dirty.stderr)})`,
      };
    const dirtyFiles = dirty.stdout.split("\n").filter((l) => l.trim() !== "");
    if (dirtyFiles.length > 0) {
      return {
        ok: false,
        message: `✖ the checkout has ${dirtyFiles.length} uncommitted file${dirtyFiles.length === 1 ? "" : "s"} — that is almost certainly the companion's work. Never stash it; wait for its commit, then revert.`,
      };
    }

    const res = await this.local(revertArgv(sha));
    if (!res.ok) {
      // A conflicted revert leaves the shared tree half-applied — abort it,
      // and say "tree unchanged" only when the abort says so.
      const why = firstLine(res.stderr || res.stdout);
      const abort = await this.local(REVERT_ABORT_ARGV).catch((err: unknown): RemoteResult => ({
        ok: false,
        stdout: "",
        stderr: errText(err),
        code: -1,
      }));
      if (!abort.ok)
        return {
          ok: false,
          message: `✖ revert of ${entry.short} failed (${why}) and its abort failed too (${firstLine(abort.stderr || abort.stdout)}) — the shared checkout may be mid-revert: check git status`,
        };
      return {
        ok: false,
        message: `✖ revert of ${entry.short} failed (aborted, tree unchanged): ${why}`,
      };
    }
    await this.refresh();
    return {
      ok: true,
      message: `✓ reverted ${entry.short} "${entry.subject}" — local commit only, nothing pushed`,
    };
  }
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .find((l) => l.trim() !== "")
      ?.trim() ?? "no output"
  );
}
