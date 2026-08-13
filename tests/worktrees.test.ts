// Worktree lifecycle against a REAL scratch git repo in a temp dir (the one
// place in B3 where real I/O is allowed, per the brief). A local "origin" repo
// stands in for GitHub: PR heads are published as refs/pull/<n>/head, exactly
// the ref the manager fetches.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorktreeManager, cloneUrlFor } from "../src/worktrees.js";
import type { ExecFn } from "../src/tmux.js";

let tmp: string;
let origin: string;
let root: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
}

/** Commit `body` to file `f` in the origin work tree and return the sha. */
function commit(f: string, body: string): string {
  writeFileSync(join(origin, f), body);
  git(origin, "add", f);
  git(origin, "commit", "-q", "-m", `add ${f}`);
  return git(origin, "rev-parse", "HEAD").trim();
}

/** Publish a PR head the way GitHub does. */
function publishPullHead(pr: number, sha: string): void {
  git(origin, "update-ref", `refs/pull/${pr}/head`, sha);
}

function mgr(): WorktreeManager {
  return new WorktreeManager({ root, repo: "example-org/example-app", cloneUrl: origin });
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "qcr-wt-"));
  origin = join(tmp, "origin");
  root = join(tmp, "sandbox");
  mkdirSync(origin, { recursive: true });
  mkdirSync(root, { recursive: true });
  git(origin, "init", "-q", "-b", "master");
  git(origin, "config", "receive.denyCurrentBranch", "ignore");
  commit("README.md", "base\n");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("cloneUrlFor", () => {
  it("derives an https URL from owner/name", () => {
    expect(cloneUrlFor("example-org/example-app")).toBe("https://github.com/example-org/example-app.git");
  });

  it("passes explicit URLs and local paths through", () => {
    expect(cloneUrlFor("git@github.com:o/n.git")).toBe("git@github.com:o/n.git");
    expect(cloneUrlFor("https://example.com/n.git")).toBe("https://example.com/n.git");
    expect(cloneUrlFor("/srv/mirror.git")).toBe("/srv/mirror.git");
  });
});

describe("WorktreeManager", () => {
  it("creates the base clone once and is idempotent", async () => {
    const m = mgr();
    await m.ensureBaseClone();
    expect(existsSync(join(m.basePath, ".git"))).toBe(true);
    const calls: string[][] = [];
    const spy: ExecFn = async (_c, args) => {
      calls.push(args);
      return { code: 0, stdout: "", stderr: "" };
    };
    const m2 = new WorktreeManager({ root, repo: "o/n", cloneUrl: origin, run: spy });
    await m2.ensureBaseClone();
    expect(calls).toEqual([]); // already cloned — no second clone
  });

  it("materialises a worktree at the PR head", async () => {
    const sha = commit("feature.txt", "v1\n");
    publishPullHead(7, sha);
    const m = mgr();
    const path = await m.ensureWorktree(7);
    expect(path).toBe(join(root, "wt", "pr-7"));
    expect(readFileSync(join(path, "feature.txt"), "utf8")).toBe("v1\n");
    expect(await m.headSha(7)).toBe(sha);
  });

  it("re-fetches and resets an existing worktree on refresh", async () => {
    const first = commit("feature.txt", "v1\n");
    publishPullHead(7, first);
    const m = mgr();
    const path = await m.ensureWorktree(7);
    // local scratch in the worktree must not survive the refresh
    writeFileSync(join(path, "feature.txt"), "dirty\n");
    writeFileSync(join(path, "junk.txt"), "junk\n");

    const second = commit("feature.txt", "v2\n");
    publishPullHead(7, second);
    await m.refresh(7);

    expect(readFileSync(join(path, "feature.txt"), "utf8")).toBe("v2\n");
    expect(existsSync(join(path, "junk.txt"))).toBe(false);
    expect(await m.headSha(7)).toBe(second);
  });

  it("keeps two PR worktrees independent", async () => {
    publishPullHead(7, commit("a.txt", "seven\n"));
    publishPullHead(8, commit("b.txt", "eight\n"));
    const m = mgr();
    await m.ensureWorktree(7);
    await m.ensureWorktree(8);
    expect(m.listWorktreePrs()).toEqual([7, 8]);
    expect(existsSync(join(root, "wt", "pr-7", "a.txt"))).toBe(true);
    expect(existsSync(join(root, "wt", "pr-8", "b.txt"))).toBe(true);
  });

  it("removes a worktree and prunes the registry at close", async () => {
    publishPullHead(7, commit("a.txt", "x\n"));
    const m = mgr();
    await m.ensureWorktree(7);
    await m.remove(7);
    expect(existsSync(join(root, "wt", "pr-7"))).toBe(false);
    expect(git(m.basePath, "worktree", "list")).not.toContain("pr-7");
    await m.remove(7); // idempotent
  });

  it("sweeps stale worktrees at daemon start and keeps active ones", async () => {
    publishPullHead(7, commit("a.txt", "x\n"));
    publishPullHead(8, commit("b.txt", "y\n"));
    publishPullHead(9, commit("c.txt", "z\n"));
    const m = mgr();
    await m.ensureWorktree(7);
    await m.ensureWorktree(8);
    await m.ensureWorktree(9);

    const removed = await m.sweepStale([8]);

    expect(removed).toEqual([7, 9]);
    expect(m.listWorktreePrs()).toEqual([8]);
    expect(existsSync(join(root, "wt", "pr-8", "b.txt"))).toBe(true);
  });

  it("ignores non-PR directories in wt/", async () => {
    const m = mgr();
    mkdirSync(join(root, "wt", "scratch"), { recursive: true });
    expect(m.listWorktreePrs()).toEqual([]);
    expect(await m.sweepStale([])).toEqual([]);
    expect(existsSync(join(root, "wt", "scratch"))).toBe(true);
  });
});
