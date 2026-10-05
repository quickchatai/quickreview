// scan-loop: a replay lens's reads land in the replayed PR's worktree.
//
// The replay runs its cases through the same case runner as the scan, with
// cwd = the app root (first-party ground: `.pi/settings.json` and reviewer
// context ride it, and a reviewed tree's `.pi/` must never load). So a
// relative path a replay lens names opens the APP's file — on a replay of
// another repository's PR, the reviewer's own repository. The same two
// halves as the scan's fix (tests/scan-tree-reads.test.ts):
//  - every replay task names each changed file's absolute worktree path and
//    says the working directory is NOT the worktree;
//  - the runner's reads (already resolved the way pi resolves them) are
//    credited to the PR only when they land inside its worktree (or are its
//    diff file) — a relative read that resolved into the app root never is.
import { describe, expect, it } from "vitest";
import { resolvedReadPath } from "../src/setup/caserunner.js";
import {
  parseUnifiedDiff,
  replayLensPrompt,
  replayReads,
  replayValidatorPrompt,
  WORKTREE_PATHS_NOTE,
  type ReplayPr,
  type ReplayTree,
} from "../src/setup/replay.js";

const APP = "/workspace";
const ROOT = "/workspace/state/setup/replay/trees/abc123";
const DIFF = "/workspace/state/setup/replay/diffs/abc123.diff";
const diff = [
  "diff --git a/svc/auth/token.py b/svc/auth/token.py",
  "--- a/svc/auth/token.py",
  "+++ b/svc/auth/token.py",
  "@@ -1,1 +1,2 @@",
  " def check(t):",
  "+    return t",
  "diff --git a/svc/old.py b/svc/old.py",
  "deleted file mode 100644",
  "--- a/svc/old.py",
  "+++ /dev/null",
  "@@ -1,1 +0,0 @@",
  "-x = 1",
  "",
].join("\n");
const tree: ReplayTree = {
  sha: "abc123",
  base: "def456",
  root: ROOT,
  diffPath: DIFF,
  diffLines: 12,
  files: parseUnifiedDiff(diff),
  lines: () => 2,
};
const pr: ReplayPr = {
  number: 7,
  title: "t",
  body: "b",
  state: "closed",
  merged: true,
  head_sha: "abc123",
  base_sha: "def456",
  merge_commit_sha: null,
};

describe("every replay task names where to open each file", () => {
  it("the lens task carries each changed file's absolute worktree path, and says the cwd is not the worktree", () => {
    const task = replayLensPrompt(pr, tree, { lens: "pass-baseline", tier: "high" as never });
    expect(task).toContain(`svc/auth/token.py (modified, +1/-0) — open ${ROOT}/svc/auth/token.py`);
    expect(task).toContain(WORKTREE_PATHS_NOTE);
    expect(WORKTREE_PATHS_NOTE).toMatch(/working directory is NOT the worktree/);
    // The old "every path is relative to the worktree" instruction is gone:
    // it is what sent a lens to the app root's copy.
    expect(task).not.toMatch(/Every path below and in your answer is relative to the worktree/);
    // A deleted file is not in the worktree — nothing to open.
    expect(task).not.toContain(`${ROOT}/svc/old.py`);
  });

  it("a sweep row's focus files carry their absolute worktree paths", () => {
    const task = replayLensPrompt(pr, tree, {
      lens: "pass-sweep",
      tier: "high" as never,
      focus: ["svc/auth/token.py"],
    });
    expect(task).toMatch(
      new RegExp(
        `Your focus files \\(1\\):\\n- svc/auth/token.py — open ${ROOT}/svc/auth/token.py`,
      ),
    );
  });

  it("the validator is told the same", () => {
    const task = replayValidatorPrompt(pr, tree, "pass-validate", []);
    expect(task).toContain(`open ${ROOT}/svc/auth/token.py`);
    expect(task).toContain(WORKTREE_PATHS_NOTE);
  });
});

describe("a read counts as reading the PR only when it resolved inside its worktree", () => {
  it("a relative read resolved against the app root is not the PR — it is the app's own file", () => {
    const read = resolvedReadPath("svc/auth/token.py", APP);
    expect(read).toBe(`${APP}/svc/auth/token.py`);
    expect(replayReads([read], tree)).toEqual({ pr: [], elsewhere: [read] });
  });

  it("an absolute worktree read, a relative one that resolved inside, and the diff file are the PR", () => {
    const reads = [
      `${ROOT}/svc/auth/token.py`,
      resolvedReadPath("state/setup/replay/trees/abc123/svc/x.py", APP),
      DIFF,
    ];
    expect(replayReads(reads, tree)).toEqual({ pr: reads, elsewhere: [] });
  });

  it("a grep over the whole worktree (its root, with or without the slash) reads the PR", () => {
    const reads = [
      resolvedReadPath(ROOT, APP),
      resolvedReadPath(`${ROOT}/`, APP),
      resolvedReadPath(".", ROOT),
    ];
    expect(replayReads(reads, tree)).toEqual({ pr: reads, elsewhere: [] });
    // …but a grep over the app root is not.
    expect(replayReads([resolvedReadPath(".", APP)], tree)).toEqual({ pr: [], elsewhere: [APP] });
  });

  it("a read that climbs out, or a sibling tree sharing the prefix, is not the PR", () => {
    const out = [resolvedReadPath(`${ROOT}/../other/svc/x.py`, APP), `${ROOT}-other/svc/x.py`];
    expect(replayReads(out, tree)).toEqual({ pr: [], elsewhere: out });
  });
});
