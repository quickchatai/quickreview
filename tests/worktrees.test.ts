// Worktree lifecycle against a REAL scratch git repo in a temp dir (the one
// place in B3 where real I/O is allowed, per the brief). A local "origin" repo
// stands in for GitHub: PR heads are published as refs/pull/<n>/head, exactly
// the ref the manager fetches.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WorktreeManager,
  cloneUrlFor,
  ensureLocallyIgnored,
  findMergeCommit,
  hunksTouchLine,
  localExcludePath,
  parseBlameShas,
  parseDiffHunks,
  parseDiffHunksByFile,
  POST_MERGE_LIMITS,
} from "../src/worktrees.js";
import { nodeExec, type ExecFn } from "../src/tmux.js";

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
  return new WorktreeManager({ root, repo: "exampleorg/example-app", cloneUrl: origin });
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
    expect(cloneUrlFor("exampleorg/example-app")).toBe(
      "https://github.com/exampleorg/example-app.git",
    );
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
    // Same repo slug ⇒ same derived clone dir (the default clone dir
    // derives from the repo's basename instead of a hardcode).
    const m2 = new WorktreeManager({
      root,
      repo: "exampleorg/example-app",
      cloneUrl: origin,
      run: spy,
    });
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

// The migration-collision pre-check reads the BASE branch's migration
// files at the round's base sha — out of the clone's object store, not the
// checkout, because the base clone is never checked out at the base branch.
describe("listMigrationFiles", () => {
  function commitAt(paths: Record<string, string>): string {
    for (const [p, body] of Object.entries(paths)) {
      mkdirSync(join(origin, p, ".."), { recursive: true });
      writeFileSync(join(origin, p), body);
    }
    git(origin, "add", "-A");
    git(origin, "commit", "-q", "-m", "migrations");
    return git(origin, "rev-parse", "HEAD").trim();
  }

  it("lists only numbered migration files at that sha", async () => {
    const sha = commitAt({
      "backend/chat/migrations/__init__.py": "",
      "backend/chat/migrations/0041_add_index.py": "x\n",
      "backend/chat/migrations/0042_add_flag.py": "x\n",
      "backend/chat/models.py": "x\n",
      "docs/migrations/plan.md": "x\n",
    });
    const m = mgr();
    await m.ensureBaseClone();
    await m.ensureWorktree(1, { baseRef: "master" }).catch(() => undefined); // fetch master
    const files = await m.listMigrationFiles(sha);
    expect(files).toEqual([
      "backend/chat/migrations/0041_add_index.py",
      "backend/chat/migrations/0042_add_flag.py",
      "backend/chat/migrations/__init__.py",
    ]);
  });

  // Never []: an empty list means "the base has no migrations", and a reader
  // that cannot read must not be able to impersonate that answer — the
  // pre-check would then go silently quiet, which forbids.
  it("throws rather than returning [] when the sha is unusable", async () => {
    const m = mgr();
    await m.ensureBaseClone();
    await expect(m.listMigrationFiles("not-a-sha")).rejects.toThrow(/not a commit sha/);
  });

  it("throws when the sha is well-shaped but absent from the clone", async () => {
    const m = mgr();
    await m.ensureBaseClone();
    await expect(m.listMigrationFiles("0".repeat(40))).rejects.toThrow();
  });
});

// The owner, 2026-08-19 (amendment): a clean merge stays trivial; a
// hand-resolved conflict must be named so the recheck reviews it — the
// dropped-master-change bug lives exactly in the difference between git's own
// auto-merge and what the author committed.
describe("resolvedFilesInMerges", () => {
  /** Base → `side` branch; master edits shared.txt; merge master into side.
   * Conflicting scenarios resolve by hand with `resolution`. Returns the
   * span (base sha → merge sha). */
  function mergeScenario(opts: { conflicting: boolean; resolution?: string }): {
    from: string;
    to: string;
  } {
    writeFileSync(join(origin, "shared.txt"), "line1\nline2\nline3\n");
    git(origin, "add", "-A");
    git(origin, "commit", "-q", "-m", "base");
    const from = git(origin, "rev-parse", "HEAD").trim();
    git(origin, "checkout", "-q", "-b", "side");
    writeFileSync(
      join(origin, opts.conflicting ? "shared.txt" : "other.txt"),
      opts.conflicting ? "line1 SIDE\nline2\nline3\n" : "side\n",
    );
    git(origin, "add", "-A");
    git(origin, "commit", "-q", "-m", "side edit");
    git(origin, "checkout", "-q", "master");
    writeFileSync(join(origin, "shared.txt"), "line1 MASTER\nline2\nline3\n");
    git(origin, "add", "-A");
    git(origin, "commit", "-q", "-m", "master edit");
    git(origin, "checkout", "-q", "side");
    try {
      git(origin, "merge", "-q", "master");
    } catch {
      // conflict: resolve by hand (possibly dropping master's change)
      writeFileSync(join(origin, "shared.txt"), opts.resolution ?? "line1 SIDE\nline2\nline3\n");
      git(origin, "add", "-A");
      git(origin, "commit", "-q", "-m", "resolve");
    }
    const to = git(origin, "rev-parse", "HEAD").trim();
    return { from, to };
  }

  it("a clean merge names no files", async () => {
    const { from, to } = mergeScenario({ conflicting: false });
    const m = mgr();
    await m.ensureBaseClone();
    git(join(root, "example-app"), "fetch", "-q", "origin", "side", "master");
    const res = await m.resolvedFilesInMerges(from, to);
    expect(res).toEqual({ files: [], degraded: false });
  });

  it("a hand-resolved conflict names the file — including one that dropped master's change", async () => {
    const { from, to } = mergeScenario({
      conflicting: true,
      resolution: "line1 SIDE\nline2\nline3\n",
    });
    const m = mgr();
    await m.ensureBaseClone();
    git(join(root, "example-app"), "fetch", "-q", "origin", "side", "master");
    const res = await m.resolvedFilesInMerges(from, to);
    expect(res.degraded).toBe(false);
    expect(res.files).toEqual(["shared.txt"]);
  });

  it("fetches missing objects on demand instead of degrading (2026-08-19 recheck storm)", async () => {
    const m = mgr();
    await m.ensureBaseClone(); // clone BEFORE the merge exists — the live recheck timing
    const { from, to } = mergeScenario({
      conflicting: true,
      resolution: "line1 SIDE\nline2\nline3\n",
    });
    git(origin, "update-ref", "refs/pull/7/head", to);
    const res = await m.resolvedFilesInMerges(from, to, 7);
    expect(res.degraded).toBe(false);
    expect(res.files).toEqual(["shared.txt"]);
  });

  it("reports degraded on unusable shas instead of guessing", async () => {
    const m = mgr();
    await m.ensureBaseClone();
    expect(await m.resolvedFilesInMerges("not-a-sha", "also-not")).toEqual({
      files: [],
      degraded: true,
    });
    expect(
      (
        await m.resolvedFilesInMerges(
          "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
          "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        )
      ).degraded,
    ).toBe(true);
  });
});

describe("lastHumanAuthor", () => {
  /** Commit `body` to `f` with an explicit author (committer stays "t"). */
  function commitAs(f: string, body: string, author: string): string {
    mkdirSync(dirname(join(origin, f)), { recursive: true });
    writeFileSync(join(origin, f), body);
    git(origin, "add", f);
    git(origin, "commit", "-q", "-m", `edit ${f}`, "--author", author);
    return git(origin, "rev-parse", "HEAD").trim();
  }

  it("returns the newest NON-BOT author of the paths, with the login off a noreply email", async () => {
    const skill = ".claude/skills/uja/SKILL.md";
    commitAs(skill, "v1\n", "Alex <7+alex@users.noreply.github.com>");
    commitAs("other.txt", "x\n", "Alice <1+alice@users.noreply.github.com>");
    const tip = commitAs(
      skill,
      "v2\n",
      "example-review[bot] <12+example-review[bot]@users.noreply.github.com>",
    );
    const m = mgr();
    await m.ensureBaseClone();
    // The bot's later edit is skipped; Alice never touched the path.
    expect(await m.lastHumanAuthor(tip, [skill], { botLogins: ["example-review[bot]"] })).toEqual({
      login: "alex",
      name: "Alex",
      email: "7+alex@users.noreply.github.com",
    });
  });

  it("returns a null login (caller falls back to config) for a non-noreply human email", async () => {
    const tip = commitAs("CLAUDE.md", "rules\n", "Bob <bob@example.com>");
    const m = mgr();
    await m.ensureBaseClone();
    expect(await m.lastHumanAuthor(tip, ["CLAUDE.md"])).toEqual({
      login: null,
      name: "Bob",
      email: "bob@example.com",
    });
  });

  it("returns null for untouched paths, empty path lists, and non-shas", async () => {
    const tip = git(origin, "rev-parse", "HEAD").trim();
    const m = mgr();
    await m.ensureBaseClone();
    expect(await m.lastHumanAuthor(tip, ["never-touched.md"])).toBeNull();
    expect(await m.lastHumanAuthor(tip, [])).toBeNull();
    expect(await m.lastHumanAuthor("not-a-sha", ["CLAUDE.md"])).toBeNull();
  });
});

// S6 (outcome capture): did the code at a posted finding's anchor
// change between two commits? Read-only git in the base clone, no fetch; a
// commit the clone does not hold is UNKNOWN (null), never a guess.
describe("anchorTouched (S6)", () => {
  const lines = (n: number, edit: Record<number, string> = {}) =>
    Array.from({ length: n }, (_, i) => edit[i + 1] ?? `line ${i + 1}`).join("\n") + "\n";

  it("answers whether a change landed within the window of the anchored line", async () => {
    const base = commit("app.py", lines(40));
    const near = commit("app.py", lines(40, { 22: "changed 22" }));
    const far = commit("app.py", lines(40, { 22: "changed 22", 35: "changed 35" }));
    const other = commit("other.py", "x\n");
    const m = mgr();
    await m.ensureBaseClone();
    expect(await m.anchorTouched("app.py", 20, base, near)).toBe(true); // 2 lines away
    expect(await m.anchorTouched("app.py", 10, base, near)).toBe(false);
    expect(await m.anchorTouched("app.py", 35, near, far)).toBe(true);
    expect(await m.anchorTouched("app.py", 20, far, other)).toBe(false); // app.py untouched
    expect(await m.anchorTouched("app.py", null, base, near)).toBe(true); // a file-level anchor
    expect(await m.anchorTouched("app.py", 20, base, base)).toBe(false);
  });

  it("is unknown — never a guess — for a commit the clone does not hold, or a non-sha", async () => {
    const base = commit("app.py", lines(5));
    const m = mgr();
    await m.ensureBaseClone();
    const later = commit("app.py", lines(5, { 3: "x" })); // committed after the clone: not fetched
    expect(await m.anchorTouched("app.py", 3, base, later)).toBeNull();
    expect(await m.anchorTouched("app.py", 3, "not-a-sha", base)).toBeNull();
    expect(await m.anchorTouched("", 3, base, base)).toBeNull();
  });

  it("is unknown for a path the `from` commit does not hold — an empty diff of no file proves nothing", async () => {
    const base = commit("gone.py", lines(10));
    git(origin, "rm", "-q", "gone.py");
    git(origin, "commit", "-q", "-m", "delete gone.py");
    const deleted = git(origin, "rev-parse", "HEAD").trim();
    const after = commit("app.py", lines(5));
    const m = mgr();
    await m.ensureBaseClone();
    // In neither commit (`git diff` exits 0 with no output for such a path).
    expect(await m.anchorTouched("no/such/file.py", 4, base, after)).toBeNull();
    // A LEFT-side anchor on a file the PR deletes: its head no longer holds it.
    expect(await m.anchorTouched("gone.py", 4, deleted, after)).toBeNull();
    expect(await m.anchorTouched("gone.py", 4, deleted, deleted)).toBeNull();
    // A file that `to` deletes WAS touched.
    expect(await m.anchorTouched("gone.py", 4, base, deleted)).toBe(true);
    // Present and untouched is still a definite no.
    expect(await m.anchorTouched("gone.py", 4, base, base)).toBe(false);
  });
});

// a reply's "Fixed in <sha>" counts only when <sha> is a commit
// made after the reviewed head and carried by a later one.
describe("introducedBetween (S6)", () => {
  it("is true only for a commit `to` contains and `from` does not", async () => {
    const reviewed = commit("app.py", "a\n");
    const fix = commit("app.py", "b\n");
    const later = commit("other.py", "c\n");
    const m = mgr();
    await m.ensureBaseClone();
    expect(await m.introducedBetween(fix, reviewed, later)).toBe(true);
    expect(await m.introducedBetween(fix.slice(0, 7), reviewed, later)).toBe(true); // abbreviated
    expect(await m.introducedBetween(fix.toUpperCase(), reviewed, later)).toBe(true);
    // the commit that introduced the behaviour: already in the reviewed head
    expect(await m.introducedBetween(reviewed, reviewed, later)).toBe(false);
    // a later commit the head it is checked against does not contain
    expect(await m.introducedBetween(later, reviewed, fix)).toBe(false);
  });

  it("is unknown — never a guess — for a token that is no commit the clone holds", async () => {
    const reviewed = commit("app.py", "a\n");
    const m = mgr();
    await m.ensureBaseClone();
    const unfetched = commit("app.py", "b\n");
    expect(await m.introducedBetween("550e8400", reviewed, reviewed)).toBeNull(); // a UUID segment
    expect(await m.introducedBetween(unfetched, reviewed, reviewed)).toBeNull();
    expect(await m.introducedBetween(reviewed, reviewed, unfetched)).toBeNull();
    expect(await m.introducedBetween("not-a-sha", reviewed, reviewed)).toBeNull();
  });
});

describe("parseDiffHunks / hunksTouchLine", () => {
  it("reads -U0 hunk headers, a count of 0 being a pure insertion", () => {
    const diff = [
      "diff --git a/x b/x",
      "@@ -10 +10 @@",
      "@@ -20,3 +20,0 @@",
      "@@ -30,0 +31,2 @@",
    ].join("\n");
    const hunks = parseDiffHunks(diff);
    expect(hunks).toEqual([
      { old_start: 10, old_count: 1 },
      { old_start: 20, old_count: 3 },
      { old_start: 30, old_count: 0 },
    ]);
    expect(hunksTouchLine(hunks, 13)).toBe(true); // 10 + 3
    expect(hunksTouchLine(hunks, 14)).toBe(false);
    expect(hunksTouchLine(hunks, 25)).toBe(true); // 22 + 3
    expect(hunksTouchLine(hunks, 34)).toBe(true); // insertion after 30, 31 + 3
    expect(hunksTouchLine(hunks, 35)).toBe(false);
    expect(hunksTouchLine([], null)).toBe(false);
  });
});

// the base clone's name is per-install, so no tracked .gitignore line
// can cover it. Where the sandbox root IS a checkout (`npm run daemon`, the
// plain-docker bind mount), the manager itself files the clone in the
// checkout's LOCAL info/exclude — the same `/<name>/` line deploy.sh writes.
describe("base clone is locally ignored", () => {
  it("a clone of any name inside a checkout leaves `git status` clean, and the rule is written once", async () => {
    git(root, "init", "-q", "-b", "master");
    writeFileSync(join(root, "tracked.txt"), "x\n");
    git(root, "add", "tracked.txt");
    git(root, "commit", "-q", "-m", "t");
    const m = new WorktreeManager({ root, repo: "acme/acme-api", cloneUrl: origin });
    await m.ensureBaseClone();
    expect(existsSync(join(root, "acme-api", ".git"))).toBe(true);
    expect(git(root, "status", "--porcelain")).toBe("");
    await m.ensureBaseClone();
    const exclude = readFileSync(join(root, ".git", "info", "exclude"), "utf8");
    expect(exclude.match(/^\/acme-api\/$/gm)).toHaveLength(1);
  });

  it("does nothing where the root is not a checkout (the VM: no .git is shipped)", async () => {
    const m = new WorktreeManager({ root, repo: "acme/acme-api", cloneUrl: origin });
    await m.ensureBaseClone();
    expect(existsSync(join(root, ".git"))).toBe(false);
    expect(localExcludePath(root)).toBeNull();
  });

  it("accepts deploy.sh's spelling as already present and never glues onto an unterminated line", () => {
    git(root, "init", "-q");
    const exclude = join(root, ".git", "info", "exclude");
    writeFileSync(exclude, "*.swp");
    expect(ensureLocallyIgnored(root, "acme-api")).toBe(true);
    expect(readFileSync(exclude, "utf8")).toBe("*.swp\n/acme-api/\n");
    expect(ensureLocallyIgnored(root, "acme-api")).toBe(false);
  });

  it("a checkout that is itself a linked worktree writes the SHARED exclude", () => {
    git(root, "init", "-q", "-b", "master");
    writeFileSync(join(root, "f"), "x\n");
    git(root, "add", "f");
    git(root, "commit", "-q", "-m", "t");
    const linked = join(tmp, "linked");
    git(root, "worktree", "add", "-q", linked);
    expect(localExcludePath(linked)).toBe(join(root, ".git", "info", "exclude"));
    expect(ensureLocallyIgnored(linked, "acme-api")).toBe(true);
    mkdirSync(join(linked, "acme-api"));
    writeFileSync(join(linked, "acme-api", "x"), "y\n");
    expect(git(linked, "status", "--porcelain")).toBe("");
  });
});

// ---- S8: post-merge commits that touch a merged PR's lines -----------

describe("postMergeTouches (the learner's recall source)", () => {
  /** Commit the given files on master with `subject`, dated `at` (both
   * author and committer — `--until` reads the committer date). */
  function commitAt(files: Record<string, string>, subject: string, at: string): string {
    for (const [f, body] of Object.entries(files)) {
      mkdirSync(dirname(join(origin, f)), { recursive: true });
      writeFileSync(join(origin, f), body);
    }
    git(origin, "add", "-A");
    execFileSync("git", ["commit", "-q", "-m", subject], {
      cwd: origin,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
        GIT_AUTHOR_DATE: at,
        GIT_COMMITTER_DATE: at,
      },
    });
    return git(origin, "rev-parse", "HEAD").trim();
  }
  const lines = (n: number, tag: string) =>
    Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join("\n") + "\n";

  async function fetched(): Promise<WorktreeManager> {
    const m = mgr();
    await m.ensureBaseClone();
    git(m.basePath, "fetch", "-q", "origin", "+refs/heads/master:refs/remotes/origin/master");
    return m;
  }

  it("finds the squash commit by its (#pr) subject and the later fix of its lines", async () => {
    commitAt(
      { "app/a.py": lines(20, "base"), "app/b.py": lines(5, "b") },
      "seed",
      "2026-09-01T10:00:00Z",
    );
    const a = lines(20, "base").split("\n");
    a[9] = "pr line 10";
    a[10] = "pr line 11";
    const squash = commitAt(
      { "app/a.py": a.join("\n") },
      "Add the thing (#7)",
      "2026-09-10T12:00:00Z",
    );
    // Unrelated: touches b.py only.
    commitAt({ "app/b.py": lines(5, "b2") }, "Tweak b (#8)", "2026-09-11T12:00:00Z");
    // A fix of the PR's own line 10, two days later.
    a[9] = "fixed line 10";
    const fix = commitAt(
      { "app/a.py": a.join("\n") },
      "Fix the thing (#9)",
      "2026-09-12T12:00:00Z",
    );
    // Touches a.py but only lines the PR never changed.
    a[1] = "other line 2";
    commitAt({ "app/a.py": a.join("\n") }, "Unrelated edit (#10)", "2026-09-13T12:00:00Z");
    // Outside the 14-day window.
    a[10] = "late line 11";
    commitAt({ "app/a.py": a.join("\n") }, "Late (#11)", "2026-10-20T12:00:00Z");
    const m = await fetched();
    const scan = await m.postMergeTouches({
      pr: 7,
      baseRef: "master",
      mergedAt: "2026-09-10T12:00:05Z",
      windowDays: 14,
    });
    expect(scan).not.toBeNull();
    expect(scan!.merge).toBe(squash);
    expect(scan!.shape).toBe("squash");
    expect(scan!.checked).toBe(2); // the fix and the unrelated edit to a.py
    expect(scan!.touches).toEqual([
      {
        commit: fix,
        subject: "Fix the thing (#9)",
        committed_at: expect.stringContaining("2026-09-12") as unknown as string,
        path: "app/a.py",
        start: 10,
        end: 10,
      },
    ]);
    expect(scan!.truncated).toBe(false);
    // The clone's base tip, so the learner can tell a window not fetched yet.
    expect(scan!.tip_at).toContain("2026-10-20");
  });

  it("finds a merge commit by its 'Merge pull request #N' subject and blames the branch's own commits", async () => {
    commitAt({ "app/m.py": lines(10, "base") }, "seed", "2026-09-01T10:00:00Z");
    git(origin, "checkout", "-q", "-b", "feature");
    const m = lines(10, "base").split("\n");
    m[4] = "branch line 5";
    commitAt({ "app/m.py": m.join("\n") }, "branch work", "2026-09-09T12:00:00Z");
    git(origin, "checkout", "-q", "master");
    commitAt({ "app/other.py": "x\n" }, "Other (#6)", "2026-09-09T13:00:00Z");
    const at = "2026-09-10T12:00:00Z";
    execFileSync(
      "git",
      ["merge", "--no-ff", "-q", "-m", "Merge pull request #7 from x/feature", "feature"],
      {
        cwd: origin,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@example.com",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@example.com",
          GIT_AUTHOR_DATE: at,
          GIT_COMMITTER_DATE: at,
        },
      },
    );
    const merge = git(origin, "rev-parse", "HEAD").trim();
    m[4] = "fixed line 5";
    const fix = commitAt({ "app/m.py": m.join("\n") }, "Fix it (#8)", "2026-09-11T12:00:00Z");
    const scan = await (
      await fetched()
    ).postMergeTouches({
      pr: 7,
      baseRef: "master",
      mergedAt: "2026-09-10T12:00:03Z",
      windowDays: 14,
    });
    expect(scan).toMatchObject({ merge, shape: "merge", truncated: false, checked: 1 });
    expect(scan!.touches).toEqual([
      {
        commit: fix,
        subject: "Fix it (#8)",
        committed_at: expect.stringContaining("2026-09-11") as unknown as string,
        path: "app/m.py",
        start: 5,
        end: 5,
      },
    ]);
  });

  it("past the later-commit cap it reads the OLDEST commits — the first fix after the merge is never the one dropped", async () => {
    commitAt({ "app/a.py": lines(20, "base") }, "seed", "2026-09-01T10:00:00Z");
    const a = lines(20, "base").split("\n");
    a[9] = "pr line 10";
    commitAt({ "app/a.py": a.join("\n") }, "Add (#7)", "2026-09-10T12:00:00Z");
    a[9] = "fixed line 10";
    const fix = commitAt({ "app/a.py": a.join("\n") }, "Fix (#8)", "2026-09-10T13:00:00Z");
    // Then more churn on the same file (a line the PR never changed) than the
    // cap reads.
    for (let i = 0; i < POST_MERGE_LIMITS.laterCommits; i++) {
      a[1] = `churn ${i}`;
      commitAt(
        { "app/a.py": a.join("\n") },
        `Churn ${i}`,
        new Date(Date.parse("2026-09-11T00:00:00Z") + i * 60_000).toISOString(),
      );
    }
    const scan = await (
      await fetched()
    ).postMergeTouches({
      pr: 7,
      baseRef: "master",
      mergedAt: "2026-09-10T12:00:03Z",
      windowDays: 14,
    });
    expect(scan!.truncated).toBe(true);
    expect(scan!.checked).toBe(POST_MERGE_LIMITS.laterCommits);
    expect(scan!.touches.map((t) => t.commit)).toEqual([fix]);
  });

  it("a blame it cannot read makes the scan partial, never 'not the PR's lines'", async () => {
    commitAt({ "app/a.py": lines(20, "base") }, "seed", "2026-09-01T10:00:00Z");
    const a = lines(20, "base").split("\n");
    a[9] = "pr line 10";
    commitAt({ "app/a.py": a.join("\n") }, "Add (#7)", "2026-09-10T12:00:00Z");
    a[9] = "fixed line 10";
    commitAt({ "app/a.py": a.join("\n") }, "Fix (#8)", "2026-09-11T12:00:00Z");
    const real = await fetched();
    const run: ExecFn = async (cmd, args, opts) => {
      if (args[0] === "blame") return { code: 128, stdout: "", stderr: "fatal: no such path" };
      return nodeExec(cmd, args, opts);
    };
    const m = new WorktreeManager({
      root,
      repo: "exampleorg/example-app",
      cloneUrl: origin,
      run,
    });
    expect(m.basePath).toBe(real.basePath);
    const scan = await m.postMergeTouches({
      pr: 7,
      baseRef: "master",
      mergedAt: "2026-09-10T12:00:03Z",
      windowDays: 14,
    });
    expect(scan).toMatchObject({ checked: 1, touches: [], truncated: true });
  });

  it("is UNKNOWN — never 'nothing touched' — when no commit names the PR or the branch is absent", async () => {
    commitAt({ "x.py": "1\n" }, "Rebased without a PR number", "2026-09-10T12:00:00Z");
    const m = await fetched();
    expect(
      await m.postMergeTouches({
        pr: 7,
        baseRef: "master",
        mergedAt: "2026-09-10T12:00:00Z",
        windowDays: 14,
      }),
    ).toBeNull();
    expect(
      await m.postMergeTouches({
        pr: 7,
        baseRef: "nope",
        mergedAt: "2026-09-10T12:00:00Z",
        windowDays: 14,
      }),
    ).toBeNull();
    expect(
      await m.postMergeTouches({
        pr: 7,
        baseRef: "--evil",
        mergedAt: "2026-09-10T12:00:00Z",
        windowDays: 14,
      }),
    ).toBeNull();
  });

  it("parses per-file hunks, blame shas and the merge commit from git's own output", () => {
    const diff = [
      "diff --git a/x.py b/x.py",
      "--- a/x.py",
      "+++ b/x.py",
      "@@ -3,2 +3,2 @@",
      "@@ -9 +9,0 @@",
      "diff --git a/new.py b/new.py",
      "--- /dev/null",
      "+++ b/new.py",
      "@@ -0,0 +1,3 @@",
      'diff --git "a/sp ace.py" "b/sp ace.py"',
      '--- "a/sp ace.py"',
      '+++ "b/sp ace.py"',
      "@@ -1 +1 @@",
      // A -U0 hunk REMOVING an SQL comment line prints it as `--- …`: a body
      // line, never a header — the file's later hunks still count.
      "diff --git a/schema.sql b/schema.sql",
      "--- a/schema.sql",
      "+++ b/schema.sql",
      "@@ -4 +3,0 @@",
      "--- add an index on orders",
      "@@ -12,2 +11,2 @@",
      "-a",
      "-b",
      "+++ added line that looks like a header",
      "+c",
    ].join("\n");
    expect([...parseDiffHunksByFile(diff).entries()]).toEqual([
      [
        "x.py",
        [
          { old_start: 3, old_count: 2 },
          { old_start: 9, old_count: 1 },
        ],
      ],
      [
        "schema.sql",
        [
          { old_start: 4, old_count: 1 },
          { old_start: 12, old_count: 2 },
        ],
      ],
    ]);
    const sha = "a".repeat(40);
    expect([...parseBlameShas(`${sha} 3 3 2\nauthor t\n\tline\n${sha} 4 4\n\tline`)]).toEqual([
      sha,
    ]);
    const log = [
      `${"1".repeat(40)}\t2026-09-10T12:00:00Z\t${"0".repeat(40)}\tFix (#77)`,
      `${"2".repeat(40)}\t2026-09-10T12:00:00Z\t${"0".repeat(40)} ${"3".repeat(40)}\tMerge pull request #7 from x/y`,
      `${"4".repeat(40)}\t2026-09-01T12:00:00Z\t${"0".repeat(40)}\tOld thing (#7)`,
    ].join("\n");
    expect(findMergeCommit(log, 7, Date.parse("2026-09-10T12:00:00Z"))).toEqual({
      sha: "2".repeat(40),
      parents: ["0".repeat(40), "3".repeat(40)],
      committed_at: "2026-09-10T12:00:00Z",
    });
    expect(findMergeCommit(log, 8, Date.parse("2026-09-10T12:00:00Z"))).toBeNull();
  });
});
