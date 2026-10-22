// The daemon's own git carries command-scope pins that shut the routes
// from a repo's config to running a program: hooks, the fsmonitor command and
// the ext:: transport. Proven on a scratch repo whose config and hooks try each;
// the same calls through the unpinned exec show the repo really would run them.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nodeExec } from "../src/tmux.js";
import { DAEMON_GIT_PINS, pinnedGitExec } from "../src/worktrees.js";

describe("the daemon's git pins", () => {
  let dir: string;
  let repo: string;
  let fsmon: string;
  let hook: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "git-pins-"));
    repo = join(dir, "repo");
    fsmon = join(dir, "fsmonitor-ran");
    hook = join(dir, "hook-ran");
    const g = (...a: string[]) =>
      expect(spawnSync("git", ["-C", repo, ...a], { encoding: "utf-8" }).status).toBe(0);
    mkdirSync(repo);
    g("init", "-q", "-b", "main");
    g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "c");
    const script = (path: string, marker: string) => {
      writeFileSync(path, `#!/bin/sh\ntouch '${marker}'\n`);
      chmodSync(path, 0o755);
    };
    script(join(dir, "fsmon.sh"), fsmon);
    script(join(repo, ".git", "hooks", "post-checkout"), hook);
    g("config", "core.fsmonitor", join(dir, "fsmon.sh"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("runs neither the repo's fsmonitor nor its hooks", async () => {
    expect((await pinnedGitExec("git", ["status", "--porcelain"], { cwd: repo })).code).toBe(0);
    expect(
      (
        await pinnedGitExec("git", ["worktree", "add", "-q", join(dir, "wt"), "main", "--detach"], {
          cwd: repo,
        })
      ).code,
    ).toBe(0);
    expect(existsSync(fsmon)).toBe(false);
    expect(existsSync(hook)).toBe(false);
  });

  it("the unpinned exec does run them (the repo above is a real threat)", async () => {
    await nodeExec("git", ["status", "--porcelain"], { cwd: repo });
    await nodeExec("git", ["worktree", "add", "-q", join(dir, "wt2"), "main", "--detach"], {
      cwd: repo,
    });
    expect(existsSync(fsmon)).toBe(true);
    expect(existsSync(hook)).toBe(true);
  });

  it("every pin is in force as git reads its config", async () => {
    for (const [k, v] of DAEMON_GIT_PINS) {
      const res = await pinnedGitExec("git", ["config", "--get", k], { cwd: repo });
      expect(res.stdout.trim()).toBe(v);
    }
  });
});
