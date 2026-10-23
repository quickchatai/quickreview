// The review store (src/reviewstore.ts): one directory per repo under the
// install's state home, keyed by origin owner/name plus the root commit, with
// a one-time copy of what the git dir held before. Real throwaway repos, temp
// XDG homes (tests/helpers/install-env.ts), no network, no model.

import { afterAll, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoKey } from "../src/reviewstore.js";
import {
  loadDefaultDestinations,
  openReviewStore,
  saveDefaultDestinations,
} from "../src/reviewhome.js";
import { branchTargetKey, emptyState, loadState, saveState } from "../src/reviewstate.js";

const tmp = mkdtempSync(join(tmpdir(), "reviewstore-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  ).trim();

function mkRepo(name: string, origin?: string, content = "a\n"): string {
  const repo = join(tmp, name);
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), content);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "root");
  if (origin) git(repo, "remote", "add", "origin", origin);
  return repo;
}

const stateOf = (target: string) => ({ ...emptyState(target), rounds: [round()] });
const round = () => ({
  round_no: 1,
  head_sha: "a".repeat(40),
  base_sha: "b".repeat(40),
  merge_base: "b".repeat(40),
  reviewed_at: "2026-10-18T00:00:00Z",
  verdict: null,
  scope: "full" as const,
  cost_usd: null,
});

describe("repo key", () => {
  it("is origin owner/name plus the root commit", () => {
    const repo = mkRepo("keyed", "https://github.com/Acme/Widgets.git");
    const root = git(repo, "rev-list", "--max-parents=0", "HEAD");
    expect(repoKey(repo)).toBe(`acme--widgets--${root.slice(0, 12)}`);
  });

  it("is the same for a worktree and for a clone with the same origin", () => {
    const repo = mkRepo("orig", "git@github.com:acme/widgets.git");
    git(repo, "branch", "other");
    const wt = join(tmp, "orig-wt");
    git(repo, "worktree", "add", "-q", wt, "other");
    const clone = join(tmp, "orig-clone");
    execFileSync("git", ["clone", "-q", repo, clone]);
    git(clone, "remote", "set-url", "origin", "https://github.com/acme/widgets");
    expect(repoKey(wt)).toBe(repoKey(repo));
    expect(repoKey(clone)).toBe(repoKey(repo));
  });

  it("differs for a fork (another origin) of the same history", () => {
    const repo = mkRepo("fork-a", "https://github.com/acme/widgets.git");
    const clone = join(tmp, "fork-b");
    execFileSync("git", ["clone", "-q", repo, clone]);
    git(clone, "remote", "set-url", "origin", "https://github.com/me/widgets.git");
    expect(repoKey(clone)).not.toBe(repoKey(repo));
  });

  it("differs for two repos of the same name but other histories", () => {
    const a = mkRepo("same-1", "https://github.com/acme/widgets.git", "one\n");
    const b = mkRepo("same-2", "https://github.com/acme/widgets.git", "two\n");
    git(b, "commit", "-q", "--amend", "-m", "other root", "--date", "2001-01-01T00:00:00");
    expect(repoKey(a)).not.toBe(repoKey(b));
  });

  it("without an origin falls back to the directory name; null outside a repo or before a commit", () => {
    const repo = mkRepo("no-origin-dir");
    expect(repoKey(repo)).toMatch(/^local--no-origin-dir--[0-9a-f]{12}$/);
    const empty = join(tmp, "empty");
    mkdirSync(empty);
    git(empty, "init", "-q");
    expect(repoKey(empty)).toBeNull();
    expect(openReviewStore(empty)).toBeNull();
    const plain = join(tmp, "plain");
    mkdirSync(plain);
    expect(repoKey(plain)).toBeNull();
  });
});

describe("the store", () => {
  it("lives under the state home, per repo and per target", () => {
    const home = join(tmp, "home-a");
    const repo = mkRepo("layout", "https://github.com/acme/layout.git");
    const store = openReviewStore(repo, { QCR_STATE_HOME: home })!;
    expect(store.dir.startsWith(join(home, "review") + "/")).toBe(true);
    const k = branchTargetKey("acme/layout", "feature");
    expect(store.statePath(k)).toBe(store.statePath(k));
    expect(store.statePath(k)).not.toBe(store.statePath(branchTargetKey("acme/layout", "other")));
    expect(store.statePath(k).startsWith(join(store.dir, "state") + "/")).toBe(true);
    expect(store.destinationPath()).toBe(join(store.dir, "destination.json"));
  });

  it("follows QCR_STATE_HOME, then XDG_STATE_HOME and QCR_INSTALL", () => {
    const repo = mkRepo("homes", "https://github.com/acme/homes.git");
    const viaOverride = openReviewStore(repo, { QCR_STATE_HOME: join(tmp, "ov") })!;
    expect(viaOverride.dir.startsWith(join(tmp, "ov", "review"))).toBe(true);
    const viaXdg = openReviewStore(repo, { XDG_STATE_HOME: join(tmp, "xdg"), QCR_INSTALL: "bot" })!;
    expect(viaXdg.dir.startsWith(join(tmp, "xdg", "qcr", "bot", "review"))).toBe(true);
  });

  it("state and destination round-trip through the store, nothing lands in the repo", () => {
    const repo = mkRepo("roundtrip", "https://github.com/acme/roundtrip.git");
    const store = openReviewStore(repo)!;
    const k = branchTargetKey("acme/roundtrip", "feature");
    expect(saveState(store.statePath(k), stateOf(k))).toBe(true);
    expect(loadState(store.statePath(k), k)?.rounds).toHaveLength(1);
    expect(saveDefaultDestinations(repo, ["json", "file"])).toBe(true);
    expect(loadDefaultDestinations(repo)).toEqual(["json", "file"]);
    expect(existsSync(join(repo, ".git", "qcr-review-state"))).toBe(false);
    expect(existsSync(join(repo, ".git", "qcr-review-destination.json"))).toBe(false);
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("a worktree shares the main checkout's store", () => {
    const repo = mkRepo("shared", "https://github.com/acme/shared.git");
    git(repo, "branch", "side");
    const wt = join(tmp, "shared-wt");
    git(repo, "worktree", "add", "-q", wt, "side");
    saveDefaultDestinations(repo, ["file"]);
    expect(loadDefaultDestinations(wt)).toEqual(["file"]);
  });
});

describe("the one-time import from the git dir", () => {
  const legacy = (repo: string, k: string) => {
    const dir = join(repo, ".git", "qcr-review-state");
    mkdirSync(dir, { recursive: true });
    // The old name of a state file: the same hash openReviewStore derives.
    const fresh = openReviewStore(repo, { QCR_STATE_HOME: join(tmp, "probe") })!;
    const file = fresh.statePath(k).split("/").pop()!;
    writeFileSync(join(dir, file), JSON.stringify(stateOf(k)));
    writeFileSync(
      join(repo, ".git", "qcr-review-destination.json"),
      JSON.stringify({ destinations: ["json"] }),
    );
    return file;
  };

  it("copies old state and the saved destination into the store, and leaves the originals", () => {
    const repo = mkRepo("legacy", "https://github.com/acme/legacy.git");
    const k = branchTargetKey("acme/legacy", "feature");
    const file = legacy(repo, k);
    const home = join(tmp, "home-legacy");
    const store = openReviewStore(repo, { QCR_STATE_HOME: home })!;
    expect(loadState(store.statePath(k), k)?.rounds).toHaveLength(1);
    expect(JSON.parse(readFileSync(store.destinationPath(), "utf8")).destinations).toEqual([
      "json",
    ]);
    expect(existsSync(join(repo, ".git", "qcr-review-state", file))).toBe(true);
  });

  it("happens once: a later change in the store is not overwritten, a deleted file does not come back", () => {
    const repo = mkRepo("legacy-once", "https://github.com/acme/once.git");
    const k = branchTargetKey("acme/once", "feature");
    const file = legacy(repo, k);
    const env = { QCR_STATE_HOME: join(tmp, "home-once") };
    const store = openReviewStore(repo, env)!;
    const changed = { ...stateOf(k), rows: [{ marker: 1 }] };
    writeFileSync(store.statePath(k), JSON.stringify(changed));
    openReviewStore(repo, env);
    expect(JSON.parse(readFileSync(store.statePath(k), "utf8")).rows).toHaveLength(1);
    rmSync(store.statePath(k));
    openReviewStore(repo, env);
    expect(existsSync(store.statePath(k))).toBe(false);
    expect(readdirSync(join(store.dir, "state"))).not.toContain(file);
  });

  it("a repo with nothing old imports nothing and still works", () => {
    const repo = mkRepo("fresh", "https://github.com/acme/fresh.git");
    const store = openReviewStore(repo, { QCR_STATE_HOME: join(tmp, "home-fresh") })!;
    expect(existsSync(store.destinationPath())).toBe(false);
    expect(existsSync(join(store.dir, "state"))).toBe(false);
  });
});
