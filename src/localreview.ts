// The pieces of a local review (`qcr review`) that are not the CLI: what the
// current branch is against its base (read with git, no network), what the
// review will cost, and how its findings read in a terminal. The engine is
// the shared one-shot runner (src/oneshot.ts); the plan key is the scan's
// (src/setup/scan.ts planKey) so a start must quote the price it was shown.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { PrFileEntry } from "./github.js";
import { normalizeDisposition } from "./findingkey.js";
import { severityRank } from "./severityrank.js";
import { planKey } from "./plankey.js";

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
   * HEAD plus every uncommitted edit (the person's index is never touched). */
  uncommitted?: { treeSha: string };
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
function diffFiles(cwd: string, from: string, to: string): { files: PrFileEntry[]; lines: number } {
  const numstat = git(cwd, ["diff", "--no-renames", "--numstat", from, to]);
  const names = new Map<string, string>();
  for (const l of git(cwd, ["diff", "--no-renames", "--name-status", from, to])
    .split("\n")
    .filter(Boolean)) {
    const [s, ...p] = l.split("\t");
    names.set(p.join("\t"), STATUS[s![0]!] ?? "modified");
  }
  const files: PrFileEntry[] = [];
  let lines = 0;
  for (const l of numstat.split("\n").filter(Boolean)) {
    const [a, d, ...p] = l.split("\t");
    const path = p.join("\t");
    const binary = a === "-";
    const additions = binary ? 0 : Number(a);
    const deletions = binary ? 0 : Number(d);
    lines += additions + deletions;
    const patch = binary ? undefined : git(cwd, ["diff", "--no-renames", from, to, "--", path]);
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

/** `owner/name` from the origin remote, else `local/<directory>`. */
function repoName(cwd: string): string {
  const top = tryGit(cwd, ["rev-parse", "--show-toplevel"]) ?? cwd;
  const origin = tryGit(cwd, ["remote", "get-url", "origin"]);
  const m = origin?.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/);
  return m ? m[1]! : `local/${basename(resolve(top))}`;
}

export function resolveBranch(cwd: string, asked?: string): BranchResolution {
  if (tryGit(cwd, ["rev-parse", "--is-inside-work-tree"]) !== "true")
    return { ok: false, error: `${cwd} is not a git repository` };
  const headSha = tryGit(cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (headSha === null) return { ok: false, error: "the repository has no commits yet" };
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
  const mergeBase = tryGit(cwd, ["merge-base", base, "HEAD"]);
  if (mergeBase === null)
    return {
      ok: false,
      error: `HEAD and ${base} share no history, so there is no branch to review`,
    };
  const branch = tryGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]) ?? "HEAD";
  const { files, lines } = diffFiles(cwd, mergeBase, headSha);
  if (files.length === 0)
    return { ok: false, error: `nothing to review: ${branch} has no changes against ${base}` };
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

/** The uncommitted working tree against HEAD: staged, unstaged and new
 * (untracked, not ignored) files, read without touching the person's index or
 * files. The snapshot is a tree built in a throwaway index. */
export function resolveUncommitted(cwd: string): BranchResolution {
  if (tryGit(cwd, ["rev-parse", "--is-inside-work-tree"]) !== "true")
    return { ok: false, error: `${cwd} is not a git repository` };
  const headSha = tryGit(cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (headSha === null) return { ok: false, error: "the repository has no commits yet" };
  const scratch = mkdtempSync(join(tmpdir(), "qcr-snap-"));
  let treeSha: string;
  try {
    const env = { GIT_INDEX_FILE: join(scratch, "index") };
    const top = git(cwd, ["rev-parse", "--show-toplevel"]);
    git(top, ["read-tree", headSha], { env });
    git(top, ["add", "-A"], { env });
    treeSha = git(top, ["write-tree"], { env });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const { files, lines } = diffFiles(cwd, headSha, treeSha);
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
      uncommitted: { treeSha },
    },
  };
}

/** The review's tree for an uncommitted target: HEAD, then the edits on top. */
export function addUncommittedTree(cwd: string, dir: string, t: BranchTarget): void {
  addReviewTree(cwd, dir, t.headSha);
  if (!t.uncommitted) return;
  const patch = git(cwd, ["diff", "--binary", "--no-renames", t.headSha, t.uncommitted.treeSha], {
    raw: true,
  });
  if (patch) git(dir, ["apply", "--whitespace=nowarn"], { input: patch });
}

/** A throwaway detached checkout of `sha`, for the review to read. */
export function addReviewTree(cwd: string, dir: string, sha: string): void {
  git(cwd, ["worktree", "add", "--detach", "--force", dir, sha]);
}

export function removeReviewTree(cwd: string, dir: string): void {
  tryGit(cwd, ["worktree", "remove", "--force", dir]);
  tryGit(cwd, ["worktree", "prune"]);
}

// ---- the repo's settings and the price -----------------------------------------------

/** What a repo has decided about local reviews, kept in its git dir (never
 * tracked, never shared): the price under which a review starts without
 * asking, and the price model's two rates. */
export interface ReviewSettings {
  auto_limit_usd: number;
  /** Dollars one lens costs before it reads anything. */
  usd_per_lens: number;
  /** Dollars one lens adds per thousand changed lines. */
  usd_per_kline: number;
}

export const DEFAULT_REVIEW_SETTINGS: ReviewSettings = {
  auto_limit_usd: 2,
  usd_per_lens: 0.1,
  usd_per_kline: 0.5,
};

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

/** The price of reviewing `lines` changed lines with `lenses` lenses. The
 * review stops hard at it, so it is rounded UP to the cent shown. */
export function priceReview(lenses: number, lines: number, s: ReviewSettings): number {
  const usd = lenses * (s.usd_per_lens + (s.usd_per_kline * lines) / 1000);
  return Math.max(0.01, Math.ceil(usd * 100 - 1e-9) / 100);
}

/** What a start must quote: change the branch, the plan or the price and the
 * key moves. */
export function reviewKey(parts: {
  headSha: string;
  baseSha: string;
  lenses: readonly string[];
  lines: number;
  cap_usd: number;
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
      : [];
  const rows: Array<TerminalFinding & { rank: number }> = [];
  for (const e of entries) {
    if (e === null || typeof e !== "object") continue;
    if (HIDDEN.has(normalizeDisposition(e["disposition"]))) continue;
    const sev = typeof e["severity"] === "string" ? e["severity"].trim() : "";
    const rank = severityRank(sev);
    const str = (v: unknown): string | null =>
      typeof v === "string" && v.trim() ? v.trim() : null;
    rows.push({
      rank: rank ?? 99,
      path: str(e["path"]),
      line: typeof e["line"] === "number" ? e["line"] : null,
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
