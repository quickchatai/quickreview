// Worktree manager (spec §4, brief B3 step 1). One base clone of the app repo
// plus one worktree per open PR, created at queue time from the PR head ref
// and refreshed at the start of every round. Worktrees are read-only working
// copies for the lens passes — nothing here ever commits, pushes or touches a
// branch of the upstream repo.
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ExecFn, ExecResult } from "./tmux.js";
import { nodeExec, runOrThrow } from "./tmux.js";

export interface WorktreeManagerOptions {
  /** Sandbox root — the clone lives at <root>/example-app, worktrees at <root>/wt. */
  root: string;
  /** "owner/name" (config.github.repo) or a full clone URL. */
  repo: string;
  /** Overrides the derived https://github.com/<repo>.git clone URL. */
  cloneUrl?: string;
  run?: ExecFn;
  /** Directory name of the base clone; overridable for tests. */
  cloneDir?: string;
}

/** What one round's worktree preparation established about the tree on disk. */
export interface WorktreeFacts {
  path: string;
  /** The sha the worktree is actually checked out at, resolved from the
   * just-fetched `refs/pull/<n>/head` — the authority for the round. */
  head_sha: string;
  /** Branch the PR targets; "" when the caller did not supply one. */
  base_ref: string;
  /** Tip of base_ref at fetch time; "" when no base_ref was fetched. */
  base_sha: string;
  /** merge-base(base_sha, head_sha); "" when unavailable. */
  merge_base: string;
}

export function cloneUrlFor(repo: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(repo) || repo.startsWith("git@") || repo.startsWith("/")
    ? repo
    : `https://github.com/${repo}.git`;
}

export class WorktreeManager {
  readonly root: string;
  readonly basePath: string;
  readonly wtRoot: string;
  private readonly cloneUrl: string;
  private readonly run: ExecFn;

  constructor(opts: WorktreeManagerOptions) {
    this.root = opts.root;
    this.basePath = join(opts.root, opts.cloneDir ?? "example-app");
    this.wtRoot = join(opts.root, "wt");
    this.cloneUrl = opts.cloneUrl ?? cloneUrlFor(opts.repo);
    this.run = opts.run ?? nodeExec;
  }

  private git(args: string[], cwd = this.basePath): Promise<ExecResult> {
    return runOrThrow(this.run, "git", args, { cwd });
  }

  worktreePath(pr: number): string {
    return join(this.wtRoot, `pr-${pr}`);
  }

  /** Clone the base repo if it is not there yet. Idempotent. */
  async ensureBaseClone(): Promise<string> {
    if (existsSync(join(this.basePath, ".git"))) return this.basePath;
    mkdirSync(this.root, { recursive: true });
    await runOrThrow(this.run, "git", ["clone", this.cloneUrl, this.basePath], { cwd: this.root });
    return this.basePath;
  }

  /** Local ref the PR head is fetched into. FETCH_HEAD is per-worktree, so a
   * named ref is what makes "fetch in the clone, reset in the worktree" work. */
  private prRef(pr: number): string {
    return `refs/qcr/pr-${pr}`;
  }

  /** Where a fetched base branch lands — the ordinary remote-tracking name, so
   * `origin/master` in a pass's shell means what it says. */
  private baseRef(branch: string): string {
    return `refs/remotes/origin/${branch}`;
  }

  /**
   * Fetch the PR head AND the branch it targets, then materialise (or refresh)
   * wt/pr-<n> at the head.
   *
   * The base fetch is not decoration. Before 2026-08-18 the base clone was
   * created once and only ever fetched `refs/pull/<n>/head`, so
   * `origin/master` stayed frozen at clone time — while `pass-data-safety` is
   * instructed to verify migration numbering and `dependencies` "against
   * master's current head", a P1 rule. That check was reading a snapshot that
   * could be weeks old, producing both false P1s and false clears.
   *
   * Both refspecs go in one `git fetch` so the two sides are as close to
   * simultaneous as git allows.
   */
  async ensureWorktree(pr: number, opts: { baseRef?: string } = {}): Promise<WorktreeFacts> {
    await this.ensureBaseClone();
    mkdirSync(this.wtRoot, { recursive: true });
    const base = opts.baseRef?.trim();
    const ref = this.prRef(pr);
    const refspecs = [`+refs/pull/${pr}/head:${ref}`];
    if (base) refspecs.push(`+refs/heads/${base}:${this.baseRef(base)}`);
    await this.git(["fetch", "--force", "origin", ...refspecs]);
    const head_sha = (await this.git(["rev-parse", ref])).stdout.trim();
    const path = await this.checkoutAt(pr, head_sha);

    let base_sha = "";
    let merge_base = "";
    if (base) {
      base_sha = (await this.git(["rev-parse", this.baseRef(base)])).stdout.trim();
      // Unrelated histories (or a force-pushed base) leave no merge-base. That
      // is information for the session, not a reason to fail the round.
      const mb = await this.run("git", ["merge-base", base_sha, head_sha], { cwd: this.basePath });
      if (mb.code === 0) merge_base = mb.stdout.trim();
    }
    return { path, head_sha, base_ref: base ?? "", base_sha, merge_base };
  }

  /**
   * Materialise wt/pr-<n> at an ALREADY-FETCHED sha, without touching the
   * network. This is what keeps the round prompt honest: the sha is resolved
   * once, in ensureWorktree, and every later step checks out that exact sha
   * instead of re-fetching and silently landing on a newer head.
   */
  async checkoutAt(pr: number, sha: string): Promise<string> {
    await this.ensureBaseClone();
    mkdirSync(this.wtRoot, { recursive: true });
    const path = this.worktreePath(pr);
    if (existsSync(path)) {
      await this.git(["reset", "--hard", sha], path);
      await this.git(["clean", "-fdx"], path);
    } else {
      await this.git(["worktree", "add", "--detach", path, sha]);
    }
    return path;
  }

  /**
   * Every Django migration file present at `sha`, repo-relative.
   *
   * Read-only, no network: the base branch was fetched moments earlier by
   * `ensureWorktree`, so `sha` (the round's `base_sha`) is the branch's real
   * tip. `git ls-tree` is used rather than the filesystem because the base
   * clone's checkout is not at the base branch — the worktrees are.
   */
  async listMigrationFiles(sha: string): Promise<string[]> {
    // A sha this reader cannot use THROWS rather than returning []: an empty
    // list is indistinguishable from "the base has no migrations", which would
    // make the pre-check silently find nothing — the one failure mode
    // hard constraint forbids ("more reliable, never quieter"). The caller
    // catches it and logs `migration_precheck_failed`.
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) throw new Error(`listMigrationFiles: not a commit sha: ${sha}`);
    const res = await this.git(["ls-tree", "-r", "--name-only", sha]);
    return res.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /(^|\/)migrations\/[^/]+\.py$/.test(l));
  }

  /** True when `sha` is present in the base clone (no fetch needed). */
  async hasCommit(sha: string): Promise<boolean> {
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) return false;
    const res = await this.run("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: this.basePath });
    return res.code === 0;
  }

  /** Re-fetch + reset an existing worktree (round refresh); creates if absent. */
  async refresh(pr: number, opts: { baseRef?: string } = {}): Promise<WorktreeFacts> {
    return this.ensureWorktree(pr, opts);
  }

  async headSha(pr: number): Promise<string> {
    const res = await this.git(["rev-parse", "HEAD"], this.worktreePath(pr));
    return res.stdout.trim();
  }

  /** Drop a worktree at PR close: remove --force, then prune. */
  async remove(pr: number): Promise<void> {
    const path = this.worktreePath(pr);
    if (existsSync(path)) {
      await this.run("git", ["worktree", "remove", "--force", path], { cwd: this.basePath });
      // Registry drift (or a path git never knew about): make sure it is gone.
      rmSync(path, { recursive: true, force: true });
    }
    if (existsSync(join(this.basePath, ".git"))) {
      await this.run("git", ["worktree", "prune"], { cwd: this.basePath });
      await this.run("git", ["update-ref", "-d", this.prRef(pr)], { cwd: this.basePath });
    }
  }

  /** PR numbers with a wt/pr-<n> directory on disk. */
  listWorktreePrs(): number[] {
    if (!existsSync(this.wtRoot)) return [];
    return readdirSync(this.wtRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => /^pr-(\d+)$/.exec(e.name)?.[1])
      .filter((m): m is string => m !== undefined)
      .map(Number)
      .sort((a, b) => a - b);
  }

  /**
   * Stale-worktree sweep at daemon start (ported preflight): every wt/pr-*
   * whose PR is no longer open/known gets removed.
   */
  async sweepStale(activePrs: Iterable<number>): Promise<number[]> {
    const active = new Set(activePrs);
    const removed: number[] = [];
    for (const pr of this.listWorktreePrs()) {
      if (active.has(pr)) continue;
      await this.remove(pr);
      removed.push(pr);
    }
    return removed;
  }
}
