// The pieces of a local review (`qcr review`) that are not the CLI: what the
// current branch is against its base (read with git, no network), what the
// review will cost, and how its findings read in a terminal. The engine is
// the shared one-shot runner (packages/pi-plugin/src/oneshot.ts); the plan key is the scan's
// (src/setup/scan.ts planKey) so a start must quote the price it was shown.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { PrFileEntry } from "./githubcore.js";
import { normalizeDisposition, recordNumber, recordString } from "./findingkey.js";
import { severityRank } from "./severityrank.js";
import { planKey } from "./plankey.js";
import { parseUnifiedDiff } from "./diffinput.js";
import { nodeExec, runOrThrow } from "./execfn.js";

/** A git command's stdout, trimmed; throws with git's own words. */
function git(
  cwd: string,
  args: readonly string[],
  opts: { env?: Record<string, string>; input?: string; raw?: boolean } = {},
): string {
  const out = execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
    ...(opts.input !== undefined ? { input: opts.input } : {}),
    stdio: [opts.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
  return opts.raw ? out : out.trim();
}

/** How long one git step of building a review tree may take. */
const TREE_GIT_TIMEOUT_MS = 10 * 60_000;

/** A git command run as a child the event loop waits on (a clone or checkout
 * of a large repo takes a while, and the caller's stop must be heard while it
 * runs); throws with git's own words, or the signal's AbortError. */
async function gitAsync(
  cwd: string,
  args: readonly string[],
  opts: { input?: string; signal?: AbortSignal } = {},
): Promise<string> {
  const res = await runOrThrow(nodeExec, "git", [...args], {
    cwd,
    timeoutMs: TREE_GIT_TIMEOUT_MS,
    ...(opts.input !== undefined ? { input: opts.input } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  return res.stdout.trim();
}

function tryGit(cwd: string, args: readonly string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

// ---- the target ---------------------------------------------------------------

/** The current branch against its base, as the round order takes a target. */
export interface BranchTarget {
  /** `owner/name` from the origin remote, else `local/<directory>`. */
  repo: string;
  branch: string;
  base: string;
  headSha: string;
  baseSha: string;
  mergeBase: string;
  files: PrFileEntry[];
  /** Added plus deleted lines over the diff. */
  lines: number;
  /** Set when the target is the uncommitted working tree: the tree object of
   * HEAD plus every uncommitted edit (the person's index is never touched),
   * and the binary patch from HEAD to it. The tree's objects live only in a
   * scratch store that is gone once the target is resolved, so the patch is
   * what later builds the review tree. */
  uncommitted?: { treeSha: string; patch: string };
  /** Set when the target is a unified diff handed in (`--diff`): there is no
   * branch and no head, so `headSha` is a hash of the diff's text. */
  diff?: { patch: string };
}

export type BranchResolution = { ok: true; target: BranchTarget } | { ok: false; error: string };

const STATUS: Record<string, string> = { A: "added", D: "removed", M: "modified" };

/** The base to review against: `--base`, else origin's default branch, else
 * `main`, else `master`. */
function baseOf(cwd: string, asked: string | undefined): string | null {
  const exists = (ref: string): boolean =>
    tryGit(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]) !== null;
  if (asked !== undefined) return exists(asked) ? asked : null;
  const origin = tryGit(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (origin && exists(origin)) return origin;
  for (const c of ["main", "master"]) if (exists(c)) return c;
  return null;
}

/** The files and changed-line count between two trees (or commits). */
function diffFiles(
  cwd: string,
  from: string,
  to: string,
  env?: Record<string, string>,
): { files: PrFileEntry[]; lines: number } {
  // -z: NUL-terminated records with the paths verbatim, never C-quoted.
  const numstat = git(cwd, ["diff", "--no-renames", "-z", "--numstat", from, to], {
    env,
    raw: true,
  });
  const names = new Map<string, string>();
  const nameFields = git(cwd, ["diff", "--no-renames", "-z", "--name-status", from, to], {
    env,
    raw: true,
  }).split("\0");
  for (let i = 0; i + 1 < nameFields.length; i += 2)
    names.set(nameFields[i + 1]!, STATUS[nameFields[i]![0]!] ?? "modified");
  const files: PrFileEntry[] = [];
  let lines = 0;
  for (const l of numstat.split("\0").filter(Boolean)) {
    const [a, d, ...p] = l.split("\t");
    const path = p.join("\t");
    const binary = a === "-";
    const additions = binary ? 0 : Number(a);
    const deletions = binary ? 0 : Number(d);
    lines += additions + deletions;
    const patch = binary
      ? undefined
      : git(cwd, ["diff", "--no-renames", from, to, "--", path], { env });
    files.push({
      filename: path,
      additions,
      deletions,
      status: names.get(path) ?? "modified",
      ...(patch ? { patch } : {}),
    });
  }
  return { files, lines };
}

/** `owner/name` from the origin remote, or null when there is none. */
export function originRepo(cwd: string): string | null {
  const origin = tryGit(cwd, ["remote", "get-url", "origin"]);
  const m = origin?.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/);
  return m ? m[1]! : null;
}

/** `owner/name` from the origin remote, else `local/<directory>`. */
function repoName(cwd: string): string {
  const top = tryGit(cwd, ["rev-parse", "--show-toplevel"]) ?? cwd;
  return originRepo(cwd) ?? `local/${basename(resolve(top))}`;
}

/** The repository check both resolvers start with: `cwd` is a work tree and
 * HEAD names a commit. */
function admitRepo(cwd: string): { ok: true; headSha: string } | { ok: false; error: string } {
  if (tryGit(cwd, ["rev-parse", "--is-inside-work-tree"]) !== "true")
    return { ok: false, error: `${cwd} is not a git repository` };
  const headSha = tryGit(cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (headSha === null) return { ok: false, error: "the repository has no commits yet" };
  return { ok: true, headSha };
}

/** How a branch target is read: `head` names the branch (or commit) to
 * review instead of HEAD; `uncommitted` adds the working tree's uncommitted
 * edits on top of HEAD's commits, as one review (`snapshotWorkTree`, its
 * scratch store under `scratchParent`). */
export interface BranchOptions {
  head?: string;
  uncommitted?: boolean;
  scratchParent?: string;
}

export function resolveBranch(
  cwd: string,
  asked?: string,
  o: BranchOptions = {},
): BranchResolution {
  const admitted = admitRepo(cwd);
  if (!admitted.ok) return admitted;
  let headSha = admitted.headSha;
  if (o.head !== undefined) {
    const named = tryGit(cwd, ["rev-parse", "--verify", "--quiet", `${o.head}^{commit}`]);
    if (named === null)
      return { ok: false, error: `${o.head} is not a branch or commit in this repository` };
    headSha = named;
  }
  const headRef = o.head ?? "HEAD";
  const base = baseOf(cwd, asked);
  if (base === null)
    return {
      ok: false,
      error:
        asked !== undefined
          ? `base ${asked} is not a commit in this repository`
          : "no base to review against: no origin default branch, main or master — pass --base REF",
    };
  const baseSha = git(cwd, ["rev-parse", `${base}^{commit}`]);
  const mergeBase = tryGit(cwd, ["merge-base", base, headRef]);
  if (mergeBase === null)
    return {
      ok: false,
      error: `${headRef} and ${base} share no history, so there is no branch to review`,
    };
  const branch = o.head ?? tryGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]) ?? "HEAD";
  // The working tree's edits ride on HEAD only: a named branch is its commits.
  if (o.uncommitted && o.head === undefined) {
    const snap = snapshotWorkTree(cwd, headSha, mergeBase, o.scratchParent);
    if (snap.edited) {
      if (snap.files.length === 0)
        return {
          ok: false,
          error: `nothing to review: ${branch} has no changes against ${base}, committed or not`,
        };
      return {
        ok: true,
        target: {
          repo: repoName(cwd),
          branch,
          base,
          headSha,
          baseSha,
          mergeBase,
          files: snap.files,
          lines: snap.lines,
          uncommitted: { treeSha: snap.treeSha, patch: snap.patch },
        },
      };
    }
  }
  const { files, lines } = diffFiles(cwd, mergeBase, headSha);
  if (files.length === 0)
    return {
      ok: false,
      error: `nothing to review: ${branch} has no changes against ${base}${o.uncommitted && o.head === undefined ? ", committed or not" : ""}`,
    };
  return {
    ok: true,
    target: {
      repo: repoName(cwd),
      branch,
      base,
      headSha,
      baseSha,
      mergeBase,
      files,
      lines,
    },
  };
}

/** The working tree as one tree object: HEAD plus every uncommitted edit
 * (staged, unstaged and new files, not ignored), built in a throwaway index
 * whose objects go to a throwaway store borrowing the repo's as an alternate,
 * so nothing is written into the reviewed repository and a read-only checkout
 * works. `files` are the tree against `from`; `patch` is the binary patch
 * from HEAD to it (empty when the tree is HEAD's, `edited` false). The scratch
 * store goes under `scratchParent` (default: the OS temp dir) and is gone
 * when this returns. */
function snapshotWorkTree(
  cwd: string,
  headSha: string,
  from: string,
  scratchParent?: string,
): { treeSha: string; files: PrFileEntry[]; lines: number; patch: string; edited: boolean } {
  if (scratchParent !== undefined) mkdirSync(scratchParent, { recursive: true });
  const scratch = mkdtempSync(join(scratchParent ?? tmpdir(), "qcr-snap-"));
  try {
    const objects = join(scratch, "objects");
    mkdirSync(objects);
    const commonDir = resolve(cwd, git(cwd, ["rev-parse", "--git-common-dir"]));
    const env = {
      GIT_INDEX_FILE: join(scratch, "index"),
      GIT_OBJECT_DIRECTORY: objects,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(commonDir, "objects"),
    };
    const top = git(cwd, ["rev-parse", "--show-toplevel"]);
    // Start from the person's own index (copied, never touched): its cached
    // stat data keeps `add -A` from re-hashing every unchanged file, and git
    // refreshes the mtime of each object it writes again, even one that sits
    // in the alternate store. An index that is absent or unreadable falls back
    // to HEAD's tree.
    const index = resolve(cwd, git(cwd, ["rev-parse", "--git-path", "index"]));
    try {
      copyFileSync(index, env.GIT_INDEX_FILE);
      // git re-hashes a file whose stat matches its entry only while the index
      // file is no newer than that entry (the racy check): the copy keeps the
      // original's mtime, a microsecond earlier, or a same-size edit made in
      // the tick of the last index write would be read as unchanged
      const t = (Math.floor(statSync(index).mtimeMs * 1000) - 1) / 1e6;
      utimesSync(env.GIT_INDEX_FILE, t, t);
    } catch {
      git(top, ["read-tree", headSha], { env });
    }
    git(top, ["add", "-A"], { env });
    const treeSha = git(top, ["write-tree"], { env });
    const edited = treeSha !== git(cwd, ["rev-parse", `${headSha}^{tree}`]);
    const { files, lines } = diffFiles(cwd, from, treeSha, env);
    const patch = edited
      ? git(cwd, ["diff", "--binary", "--no-renames", headSha, treeSha], { env, raw: true })
      : "";
    return { treeSha, files, lines, patch, edited };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The uncommitted working tree against HEAD: staged, unstaged and new
 * (untracked, not ignored) files, read without touching the person's index or
 * files (the snapshot is `snapshotWorkTree`'s). */
export function resolveUncommitted(
  cwd: string,
  o: { scratchParent?: string } = {},
): BranchResolution {
  const head = admitRepo(cwd);
  if (!head.ok) return head;
  const headSha = head.headSha;
  const snap = snapshotWorkTree(cwd, headSha, headSha, o.scratchParent);
  const { treeSha, files, lines, patch } = snap;
  if (files.length === 0)
    return { ok: false, error: "nothing to review: the working tree has no uncommitted changes" };
  const branch = tryGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]) ?? "HEAD";
  return {
    ok: true,
    target: {
      repo: repoName(cwd),
      branch,
      base: "HEAD",
      headSha,
      baseSha: headSha,
      mergeBase: headSha,
      files,
      lines,
      uncommitted: { treeSha, patch },
    },
  };
}

/** A unified diff handed in, as a target. The repository around `cwd` is not
 * needed: when there is one it is only named (the repo, for the report), never
 * written to. */
export function resolveDiff(cwd: string, text: string): BranchResolution {
  const { files, lines } = parseUnifiedDiff(text);
  if (files.length === 0)
    return { ok: false, error: "nothing to review: no file changes were found in the diff" };
  const id = createHash("sha1").update(text).digest("hex");
  const inRepo = tryGit(cwd, ["rev-parse", "--is-inside-work-tree"]) === "true";
  return {
    ok: true,
    target: {
      repo: inRepo ? repoName(cwd) : "local/diff",
      branch: "diff",
      base: "diff",
      headSha: id,
      baseSha: id,
      mergeBase: id,
      files,
      lines,
      diff: { patch: text },
    },
  };
}

/** The review's tree for a diff target: a plain directory, never a git
 * worktree, so a read-only checkout is enough and nothing is written to its
 * git dir. With a repository around `cwd` the tree starts as a copy of HEAD
 * (`git archive`, a read) and the diff is applied on top when it applies;
 * otherwise, or when it does not, the tree is the HEAD copy (or empty) and
 * the review reads the changes from the diff itself. Returns a warning when
 * the diff did not apply. The HEAD archive is staged beside `dir`. */
export function addDiffTree(cwd: string, dir: string, t: BranchTarget): string | null {
  mkdirSync(dir, { recursive: true });
  const top = tryGit(cwd, ["rev-parse", "--show-toplevel"]);
  const head =
    top === null ? null : tryGit(top, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (top === null || head === null) return null;
  const scratch = mkdtempSync(join(dirname(resolve(dir)), ".qcr-diff-"));
  try {
    const tarball = join(scratch, "head.tar");
    git(top, ["archive", "--format=tar", "-o", tarball, head]);
    execFileSync("tar", ["-xf", tarball, "-C", dir], { stdio: "ignore" });
    if (!t.diff) return null;
    try {
      // the ceiling keeps git from finding a repository above the scratch tree
      git(dir, ["apply", "--whitespace=nowarn"], {
        input: t.diff.patch,
        env: { GIT_CEILING_DIRECTORIES: dirname(resolve(dir)) },
      });
      return null;
    } catch {
      return "the diff does not apply to this repository's HEAD, so the repository is context only and the review reads the changes from the diff";
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The review's tree for an uncommitted target: HEAD, then the edits on top. */
export async function addUncommittedTree(
  cwd: string,
  dir: string,
  t: BranchTarget,
  o: { signal?: AbortSignal } = {},
): Promise<void> {
  await addReviewTree(cwd, dir, t.headSha, o);
  if (!t.uncommitted) return;
  const { patch } = t.uncommitted;
  if (patch)
    await gitAsync(dir, ["apply", "--whitespace=nowarn"], {
      input: patch,
      ...(o.signal ? { signal: o.signal } : {}),
    });
}

/** A throwaway detached checkout of `sha`, for the review to read. A shared
 * clone, not a worktree: its objects come from the repository by alternates, so
 * nothing is written into the reviewed repo's .git (the wrapper and the Action
 * mount it read-only), and the tree is still a git checkout the lenses can ask. */
export async function addReviewTree(
  cwd: string,
  dir: string,
  sha: string,
  o: { signal?: AbortSignal } = {},
): Promise<void> {
  const common = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const signal = o.signal ? { signal: o.signal } : {};
  await gitAsync(cwd, ["clone", "--quiet", "--shared", "--no-checkout", common, dir], signal);
  await gitAsync(dir, ["checkout", "--quiet", "--detach", sha], signal);
}

export function removeReviewTree(_cwd: string, dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

// ---- the repo's settings and the price -----------------------------------------------

/** What a repo has decided about local reviews, kept in its git dir (never
 * tracked, never shared): the price under which a review starts without
 * asking, and the price model's three rates. */
export interface ReviewSettings {
  auto_limit_usd: number;
  /** Dollars a review costs before any lens runs. */
  usd_base: number;
  /** Dollars one planned lens costs, whatever the diff. */
  usd_per_lens: number;
  /** Dollars the diff adds per thousand changed lines, once, not per lens. */
  usd_per_kline: number;
}

/** The rates are a least-squares fit to what 295 recorded default-preset
 * reviews cost (the final1 bench runs, gpt-6.1-sol list prices: $2 / M
 * uncached input, $0.10 / M cached input, $10 / M output): the median PR is
 * off by about a fifth, the sum by 1%, and no recorded review cost more than
 * twice its estimate. The table is tests/fixtures/review-cost/recorded.json.
 * A different model moves them; the repo's settings override them. */
export const DEFAULT_REVIEW_SETTINGS: ReviewSettings = {
  auto_limit_usd: 2,
  usd_base: 0.1,
  usd_per_lens: 0.125,
  usd_per_kline: 1.85,
};

/** A review stops hard at this many times its estimate. The estimate is the
 * expected cost, so stopping at it would cut about half the reviews short. */
export const HARD_STOP_FACTOR = 2;

export const SETTINGS_GIT_PATH = "qcr-review.json";

export function settingsPath(cwd: string): string | null {
  const p = tryGit(cwd, ["rev-parse", "--git-path", SETTINGS_GIT_PATH]);
  return p === null ? null : resolve(cwd, p);
}

/** The repo's settings over the defaults. A key that is not a positive number
 * is ignored, so a typo never turns the limit off. */
export function loadReviewSettings(cwd: string): ReviewSettings {
  const out = { ...DEFAULT_REVIEW_SETTINGS };
  const path = settingsPath(cwd);
  if (path === null || !existsSync(path)) return out;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    for (const k of Object.keys(out) as Array<keyof ReviewSettings>) {
      const v = raw[k];
      if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = v;
    }
  } catch {
    // unreadable settings are the defaults
  }
  return out;
}

/** The estimated cost of reviewing `lines` changed lines with `lenses` lenses:
 * a base, a fixed cost per lens and one term for the diff. Rounded UP to the
 * cent shown. */
export function priceReview(lenses: number, lines: number, s: ReviewSettings): number {
  const usd = s.usd_base + s.usd_per_lens * lenses + (s.usd_per_kline * lines) / 1000;
  return Math.max(0.01, Math.ceil(usd * 100 - 1e-9) / 100);
}

/** The most a review may spend before it is stopped, from its estimate. */
export function hardStopFor(estimateUsd: number): number {
  return Math.ceil(estimateUsd * HARD_STOP_FACTOR * 100 - 1e-9) / 100;
}

/** What a start must quote: change the branch, the plan or the price and the
 * key moves. */
export function reviewKey(parts: {
  headSha: string;
  baseSha: string;
  lenses: readonly string[];
  lines: number;
  cap_usd: number;
  /** A delta review: the head it reviews from. */
  since?: string;
}): string {
  return planKey({ ...parts, cap: Math.round(parts.cap_usd * 100) });
}

// ---- the findings in a terminal ------------------------------------------------------

export interface TerminalFinding {
  path: string | null;
  line: number | null;
  severity: string;
  title: string;
  lens: string | null;
}

/** Dispositions that never reach a reader: the review's own kills. */
const HIDDEN = new Set(["killed", "withheld", "merged", "folded", "conceded"]);

/** The findings a reader sees, grouped by severity, worst first (P0 … nit;
 * a spelling outside the scale after them, as "other"). */
export function groupFindings(record: unknown): Record<string, TerminalFinding[]> {
  const entries =
    record !== null &&
    typeof record === "object" &&
    Array.isArray((record as { findings?: unknown }).findings)
      ? ((record as { findings: unknown[] }).findings as Array<Record<string, unknown>>)
      : record !== null &&
          typeof record === "object" &&
          Array.isArray((record as { candidates?: unknown }).candidates)
        ? ((record as { candidates: unknown[] }).candidates as Array<Record<string, unknown>>)
        : [];
  const rows: Array<TerminalFinding & { rank: number }> = [];
  for (const e of entries) {
    if (e === null || typeof e !== "object") continue;
    if (HIDDEN.has(normalizeDisposition(e["disposition"]))) continue;
    const sev = typeof e["severity"] === "string" ? e["severity"].trim() : "";
    const rank = severityRank(sev);
    const str = recordString;
    rows.push({
      rank: rank ?? 99,
      path: str(e["path"]),
      line: recordNumber(e["line"]),
      severity:
        rank === undefined ? "other" : sev.toUpperCase() === "NIT" ? "nit" : sev.toUpperCase(),
      title: str(e["title"]) ?? str(e["reason"]) ?? "(untitled finding)",
      lens: str(e["lens"]) ?? str(e["name"]),
    });
  }
  rows.sort((a, b) => a.rank - b.rank);
  const out: Record<string, TerminalFinding[]> = {};
  for (const { rank: _r, ...f } of rows) (out[f.severity] ??= []).push(f);
  return out;
}

export function renderGrouped(groups: Record<string, TerminalFinding[]>): string[] {
  const lines: string[] = [];
  for (const [sev, list] of Object.entries(groups)) {
    lines.push(`${sev} (${list.length})`);
    for (const f of list) {
      const where = f.path ? `${f.path}${f.line !== null ? `:${f.line}` : ""}` : "(no location)";
      lines.push(`  ${where}  ${f.title}`);
    }
  }
  return lines;
}
