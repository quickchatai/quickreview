// The change register (FT-0234) — every feedback-derived change this loop has
// produced, newest first, with a one-key revert behind it.
//
// WHY IT EXISTS. Per-change ceremony is deliberately light: the owner approves the
// IDEA in a ratifying turn, not the diff (FT-0196). The risk that buys is DRIFT
// — no single change looks like lowering the bar, ten might — so the guard is
// that the whole set is readable at once, and that any one of them comes back
// out with one key. Without this list that light approval is unprotected.
//
// HOW A CHANGE IS IDENTIFIED: the commit trailers the `land` skill already
// promises (skills/companion/land/SKILL.md), and no new competing set:
//
//     Feedback-PR: 5270            ← omitted when the change came from no episode
//     Adjudication: FT-0231        ← omitted likewise
//     Ratified-in-session: <session id, and his approving words>
//
// `Ratified-in-session:` is the one trailer that is NEVER omitted, so it — and
// only it — is the register's key. A commit carrying it is a change this loop
// produced; a commit without it is not, however it is worded. That keeps the
// register honest in both directions: nothing lands unlisted without also
// skipping the ratifying turn, which is the void-the-widening offence.
//
// Trailers are read from the LAST paragraph of the message only, the same
// header-only discipline `src/memory/eventtags.ts` uses: a quoted line in a
// commit body must never be able to mint a register entry.
//
// REVERTS ARE READ BACK OUT OF GIT, not out of this file. `git revert` writes
// "This reverts commit <sha>." into the message it makes, so a reverted entry
// stays marked after any restart, on any checkout, even if this file is deleted
// — the durability of record lives in the repository, and the JSON is a cache
// that makes the tab paint instantly and remembers when we first saw a change.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LocalRunner } from "./deploytab.js";

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
 * the register is about this loop's output, and the loop started in 2026-08.
 * Entries already in the file are NEVER dropped for falling off this window —
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
    out.push({ sha, at: at ?? "", author: author ?? "", subject: subject ?? "", body: rest.join(FS) });
  }
  return out;
}

/**
 * The message's trailer block: `Key: value` lines in the LAST paragraph only.
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
export function buildEntries(commits: ChangeCommit[], now: string): ChangeEntry[] {
  const reverts = new Map<string, { by: string; at: string }>();
  for (const c of commits) {
    const target = revertedSha(c.body);
    if (!target) continue;
    // Newest first, so the FIRST revert seen for a target is the latest one.
    if (!reverts.has(target)) reverts.set(target, { by: shortSha(c.sha), at: c.at });
  }
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
    const rev = reverts.get(c.sha) ?? [...reverts.entries()].find(([k]) => c.sha.startsWith(k))?.[1];
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
 *    checkout that does not carry it) is KEPT. Nothing here removes a row; a
 *    list that quietly forgets a change is worse than no list, because the
 *    whole point is reading the drift in one place.
 */
export function mergeRegister(previous: ChangeEntry[], fresh: ChangeEntry[]): ChangeEntry[] {
  const byShaOld = new Map(previous.map((e) => [e.sha, e]));
  const merged: ChangeEntry[] = fresh.map((e) => {
    const old = byShaOld.get(e.sha);
    return old ? { ...e, first_seen: old.first_seen } : e;
  });
  const seen = new Set(merged.map((e) => e.sha));
  for (const old of previous) if (!seen.has(old.sha)) merged.push(old);
  // Newest first by author date, sha as the tiebreak so the order is stable.
  return merged.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.sha < b.sha ? 1 : -1));
}

export const REGISTER_FILE = "change-register.json";

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

  /** Missing or unreadable ⇒ undefined. Never a throw, never "no changes". */
  load(): ChangeRegister | undefined {
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as ChangeRegister;
      if (!Array.isArray(raw?.entries)) return undefined;
      return raw;
    } catch {
      return undefined;
    }
  }

  save(register: ChangeRegister): void {
    this.ensure();
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(register, null, 2)}\n`);
    renameSync(tmp, this.path);
  }
}

// ---- scanning and reverting ---------------------------------------------------

export interface RevertResult {
  ok: boolean;
  message: string;
}

/**
 * The register's one write, and the third user-initiated write in the whole TUI
 * (after `msg.ts`'s inject files and `unwedge.ts`'s command file).
 *
 * Bounds, all structural:
 *  · It runs `git revert` in the LOCAL sandbox checkout and nothing else. No
 *    push (this repo has no remote), no GitHub call, nothing near the
 *    `MutationGate` — a revert here is a local commit and a rebuild, exactly
 *    what the companion's own landing path is.
 *  · It refuses on a dirty tree. Root rule 11: the checkout is shared and a
 *    dirty tree is almost certainly the companion's in-flight work, which is
 *    never ours to stash, reset or commit around. `git revert` would refuse
 *    anyway — refusing FIRST is how the operator gets told why.
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
    // The persisted register IS the first paint: the tab has content before
    // git has been asked anything, which is what "survives a restart" means
    // in practice on a cold start.
    this.register = store.load();
  }

  /** Last loaded/scanned register — what the tab paints. */
  register: ChangeRegister | undefined;

  private busy = false;

  async refresh(): Promise<ChangeRegister | undefined> {
    if (this.busy) return this.register;
    this.busy = true;
    try {
      const res = await this.local(changeLogArgv());
      if (!res.ok) return this.register;
      const commits = parseGitLog(res.stdout);
      const now = this.now().toISOString();
      const previous = this.store.load()?.entries ?? [];
      const register: ChangeRegister = {
        version: 1,
        updated_at: now,
        entries: mergeRegister(previous, buildEntries(commits, now)),
        scanned: commits.length,
      };
      try {
        this.store.save(register);
      } catch {
        // An unwritable state dir costs durability, never the view.
      }
      this.register = register;
      return register;
    } catch {
      return this.register;
    } finally {
      this.busy = false;
    }
  }

  async revert(sha: string): Promise<RevertResult> {
    const entry = this.register?.entries.find((e) => e.sha === sha);
    if (!entry) return { ok: false, message: `✖ ${shortSha(sha)} is not in the register — nothing reverted` };
    if (entry.reverted) return { ok: false, message: `✖ ${entry.short} was already reverted by ${entry.reverted.by}` };

    const dirty = await this.local(DIRTY_ARGV);
    if (!dirty.ok) return { ok: false, message: `✖ git status failed — nothing reverted (${firstLine(dirty.stderr)})` };
    const dirtyFiles = dirty.stdout.split("\n").filter((l) => l.trim() !== "");
    if (dirtyFiles.length > 0) {
      return {
        ok: false,
        message: `✖ the checkout has ${dirtyFiles.length} uncommitted file${dirtyFiles.length === 1 ? "" : "s"} — that is almost certainly the companion's work. Never stash it; wait for its commit, then revert.`,
      };
    }

    const res = await this.local(revertArgv(sha));
    if (!res.ok) {
      // A conflicted revert leaves the shared tree half-applied — abort it.
      await this.local(REVERT_ABORT_ARGV).catch(() => undefined);
      return { ok: false, message: `✖ revert of ${entry.short} failed (aborted, tree unchanged): ${firstLine(res.stderr || res.stdout)}` };
    }
    await this.refresh();
    return { ok: true, message: `✓ reverted ${entry.short} "${entry.subject}" — local commit only, nothing pushed` };
  }
}

function firstLine(text: string): string {
  return text.split("\n").find((l) => l.trim() !== "")?.trim() ?? "no output";
}
