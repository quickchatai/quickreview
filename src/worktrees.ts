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

  /**
   * Fetch the PR head and materialise (or refresh) wt/pr-<n> at it.
   * Called at queue time and again at the start of every round.
   */
  async ensureWorktree(pr: number): Promise<string> {
    await this.ensureBaseClone();
    mkdirSync(this.wtRoot, { recursive: true });
    const path = this.worktreePath(pr);
    const ref = this.prRef(pr);
    await this.git(["fetch", "--force", "origin", `+refs/pull/${pr}/head:${ref}`]);
    const sha = (await this.git(["rev-parse", ref])).stdout.trim();
    if (existsSync(path)) {
      await this.git(["reset", "--hard", sha], path);
      await this.git(["clean", "-fdx"], path);
    } else {
      await this.git(["worktree", "add", "--detach", path, sha]);
    }
    return path;
  }

  /** Re-fetch + reset an existing worktree (round refresh); creates if absent. */
  async refresh(pr: number): Promise<string> {
    return this.ensureWorktree(pr);
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
