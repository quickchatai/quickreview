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
    const facts = await m.ensureWorktree(7);
    expect(facts.path).toBe(join(root, "wt", "pr-7"));
    expect(facts.head_sha).toBe(sha);
    expect(readFileSync(join(facts.path, "feature.txt"), "utf8")).toBe("v1\n");
    expect(await m.headSha(7)).toBe(sha);
  });

  it("re-fetches and resets an existing worktree on refresh", async () => {
    const first = commit("feature.txt", "v1\n");
    publishPullHead(7, first);
    const m = mgr();
    const { path } = await m.ensureWorktree(7);
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

  // ---- base-branch freshness (2026-08-18) ---------------------------------
  // The bug this closes: the base clone was created once and only ever fetched
  // refs/pull/<n>/head, so origin/master stayed frozen at clone time while
  // pass-data-safety was told to verify migration ordering "against master's
  // current head" — a P1 rule reading a snapshot that could be weeks old.

  it("fetches the PR's base branch alongside the head and reports its tip", async () => {
    const head = commit("feature.txt", "v1\n");
    publishPullHead(7, head);
    const m = mgr();
    await m.ensureWorktree(7, { baseRef: "master" });

    // master moves AFTER the clone exists — the stale-clone scenario exactly.
    const newMaster = commit("other.txt", "landed later\n");
    const facts = await m.refresh(7, { baseRef: "master" });

    expect(facts.base_ref).toBe("master");
    expect(facts.base_sha).toBe(newMaster);
    expect(git(m.basePath, "rev-parse", "refs/remotes/origin/master").trim()).toBe(newMaster);
  });

  it("computes the merge-base so the session can scope the PR's own commits", async () => {
    const forkPoint = git(origin, "rev-parse", "HEAD").trim();
    // A PR head that branched at forkPoint, while master moved on separately.
    git(origin, "checkout", "-q", "-b", "feature");
    const head = commit("feature.txt", "pr work\n");
    publishPullHead(7, head);
    git(origin, "checkout", "-q", "master");
    commit("unrelated.txt", "master moved\n");

    const facts = await mgr().ensureWorktree(7, { baseRef: "master" });
    expect(facts.head_sha).toBe(head);
    expect(facts.merge_base).toBe(forkPoint);
    expect(facts.merge_base).not.toBe(facts.base_sha);
  });

  it("degrades to empty base facts when no base ref is supplied", async () => {
    publishPullHead(7, commit("a.txt", "x\n"));
    const facts = await mgr().ensureWorktree(7);
    expect(facts).toMatchObject({ base_ref: "", base_sha: "", merge_base: "" });
    expect(facts.head_sha).not.toBe("");
  });

  // ---- sha pinning: the prompt must not outrun the tree -------------------

  it("checkoutAt materialises an already-fetched sha WITHOUT hitting the network", async () => {
    const first = commit("feature.txt", "v1\n");
    publishPullHead(7, first);
    const m = mgr();
    await m.ensureWorktree(7);

    // A push lands after the round was pinned. checkoutAt must ignore it.
    const second = commit("feature.txt", "v2\n");
    publishPullHead(7, second);
    const path = await m.checkoutAt(7, first);

    expect(readFileSync(join(path, "feature.txt"), "utf8")).toBe("v1\n");
    expect(await m.headSha(7)).toBe(first);
  });

  it("hasCommit distinguishes a fetched sha from an unknown one", async () => {
    const sha = commit("a.txt", "x\n");
    publishPullHead(7, sha);
    const m = mgr();
    await m.ensureWorktree(7);
    expect(await m.hasCommit(sha)).toBe(true);
    expect(await m.hasCommit("0".repeat(40))).toBe(false);
    expect(await m.hasCommit("not-a-sha")).toBe(false);
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
