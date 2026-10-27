// `qcr review --uncommitted` on a read-only repository (packages/pi-plugin/src/localreview.ts
// resolveUncommitted): the snapshot tree is built in a scratch object store, so
// nothing is written into the reviewed repo's .git and a :ro mount works.
// A real throwaway git repo is the fixture; no model, no network.

import { afterAll, describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addReviewTree,
  addUncommittedTree,
  removeReviewTree,
  resolveBranch,
  resolveUncommitted,
} from "@quickchatai/pi-quickreview/src/localreview.js";

const tmp = mkdtempSync(join(tmpdir(), "localreview-ro-"));

/** Make a tree writable again so the fixture can be removed. */
function unlock(dir: string): void {
  execFileSync("chmod", ["-R", "u+w", dir]);
}

afterAll(() => {
  unlock(tmp);
  rmSync(tmp, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  ).trim();

/** A committed file, then a staged edit, an unstaged edit, a new file and a binary one. */
function dirtyRepo(name: string): string {
  const repo = join(tmp, name);
  mkdirSync(join(repo, "src"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  // the test's own `chmod -R a-w` changes every file's ctime; git compares it
  // at one-second resolution, so without this the stat check passes or fails
  // with the clock and a failed one re-hashes (and freshens) a stored object
  git(repo, "config", "core.trustctime", "false");
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\nexport const z = 0;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  writeFileSync(join(repo, "src", "b.ts"), "export const s = 1;\n");
  // an old mtime, then staged: git's racy-index check would otherwise re-hash
  // the file on the next `add`, and re-hashing touches the stored object
  utimesSync(join(repo, "src", "b.ts"), new Date(2020, 0, 1), new Date(2020, 0, 1));
  git(repo, "add", "src/b.ts");
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\nexport const u = 9;\n");
  writeFileSync(join(repo, "src", "new.ts"), "export const n = 0;\n");
  writeFileSync(join(repo, "blob.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
  return repo;
}

/** Every path under .git/objects, with its mtime. */
function objectStore(repo: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      out.push(`${p}@${statSync(p).mtimeMs}`);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(join(repo, ".git", "objects"));
  return out.sort();
}

describe("resolveUncommitted on a read-only repository", () => {
  it("sees the same files and lines as on a writable one, and writes nothing into .git/objects", () => {
    const writable = dirtyRepo("rw");
    const ro = dirtyRepo("ro");
    const w = resolveUncommitted(writable);
    expect(w.ok).toBe(true);

    chmodSync(join(tmp, "ro"), 0o555);
    execFileSync("chmod", ["-R", "a-w", ro]);
    const before = objectStore(ro);
    const r = resolveUncommitted(ro);
    expect(r.ok).toBe(true);
    if (!w.ok || !r.ok) return;

    const shape = (t: typeof w.target): unknown =>
      t.files.map((f) => [f.filename, f.status, f.additions, f.deletions, f.patch]);
    expect(shape(r.target)).toEqual(shape(w.target));
    expect(r.target.lines).toBe(w.target.lines);
    expect(r.target.files.map((f) => f.filename).sort()).toEqual([
      "blob.bin",
      "src/a.ts",
      "src/b.ts",
      "src/new.ts",
    ]);
    expect(r.target.uncommitted?.treeSha).toBe(w.target.uncommitted?.treeSha);

    // the object store is exactly as it was: no new loose object, no new directory
    expect(objectStore(ro)).toEqual(before);
    expect(() => git(ro, "cat-file", "-e", r.target.uncommitted!.treeSha)).toThrow();
  });

  // MUTATION: make addUncommittedTree return t.headSha after applying the
  // patch (the edits left uncommitted) — the advertised diff loses them and
  // this fails.
  it("builds the same review tree from the patch the target carries, committed as the snapshot the instructions name", async () => {
    const repo = dirtyRepo("tree");
    const r = resolveUncommitted(repo);
    if (!r.ok) throw new Error(r.error);
    const dir = join(tmp, "tree-wt");
    try {
      const snapshot = await addUncommittedTree(repo, dir, r.target);
      expect(snapshot).not.toBe(r.target.headSha);
      expect(git(dir, "rev-parse", "HEAD")).toBe(snapshot);
      expect(git(dir, "rev-parse", `${snapshot}^{tree}`)).toBe(r.target.uncommitted?.treeSha);
      expect(git(dir, "status", "--porcelain")).toBe("");
      // the scope the round order advertises: merge-base to the snapshot
      const scope = git(dir, "diff", "--name-only", r.target.mergeBase, snapshot).split("\n");
      expect(scope.sort()).toEqual(["blob.bin", "src/a.ts", "src/b.ts", "src/new.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a branch with uncommitted edits: the snapshot's diff from the merge-base holds the commits and the edits", async () => {
    const repo = dirtyRepo("combined");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "all");
    git(repo, "checkout", "-q", "-b", "topic");
    writeFileSync(join(repo, "src", "c.ts"), "export const c = 1;\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "topic");
    writeFileSync(join(repo, "src", "c.ts"), "export const c = 2;\n");
    writeFileSync(join(repo, "src", "d.ts"), "export const d = 0;\n");
    const r = resolveBranch(repo, "main", { uncommitted: true });
    if (!r.ok) throw new Error(r.error);
    const dir = join(tmp, "combined-wt");
    try {
      const snapshot = await addUncommittedTree(repo, dir, r.target);
      const scope = git(dir, "diff", "--name-only", r.target.mergeBase, snapshot).split("\n");
      expect(scope.sort()).toEqual(["src/c.ts", "src/d.ts"]);
      expect(git(dir, "show", `${snapshot}:src/c.ts`)).toBe("export const c = 2;");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("checks a commit out for the review without writing into a read-only repo", async () => {
    const repo = dirtyRepo("ro-tree");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "all");
    const head = git(repo, "rev-parse", "HEAD");
    execFileSync("chmod", ["-R", "a-w", repo]);
    const before = objectStore(repo);
    const dir = join(tmp, "ro-tree-wt");
    try {
      await addReviewTree(repo, dir, head);
      expect(git(dir, "rev-parse", "HEAD")).toBe(head);
      expect(git(dir, "status", "--porcelain")).toBe("");
      expect(objectStore(repo)).toEqual(before);
      expect(readdirSync(join(repo, ".git"))).not.toContain("worktrees");
    } finally {
      removeReviewTree(repo, dir);
    }
    expect(() => statSync(dir)).toThrow();
  });

  it("a stop ends the review tree's checkout: the call rejects with the abort", async () => {
    const repo = dirtyRepo("stop-tree");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "all");
    const head = git(repo, "rev-parse", "HEAD");
    const stop = new AbortController();
    stop.abort();
    const dir = join(tmp, "stop-tree-wt");
    try {
      await expect(addReviewTree(repo, dir, head, { signal: stop.signal })).rejects.toMatchObject({
        name: "AbortError",
      });
    } finally {
      removeReviewTree(repo, dir);
    }
  });

  it("still says there is nothing to review on a clean read-only repo", () => {
    const repo = dirtyRepo("clean");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "all");
    execFileSync("chmod", ["-R", "a-w", repo]);
    const r = resolveUncommitted(repo);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/nothing to review/);
  });
});
