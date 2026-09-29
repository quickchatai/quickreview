// The scan's real source port (src/setup/scantree.ts) against a
// scratch git repo in a temp dir — no network. It is the one piece of the
// scan that must be proven on git itself: "the tree AT the chosen sha", with
// git's own blob hashes as the ledger's content hash.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitScanSource, SCAN_TREES_DIR } from "../src/setup/scantree.js";

let dir: string;
let repo: string;
let state: string;

const git = (...args: string[]): string =>
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8",
  }).trim();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-scantree-"));
  repo = join(dir, "repo");
  state = join(dir, "state");
  mkdirSync(join(repo, "src"), { recursive: true });
  git("init", "-q");
  writeFileSync(join(repo, "src/a.py"), "one\ntwo\n");
  symlinkSync("../../etc/passwd", join(repo, "src/link"));
  git("add", "-A");
  git("commit", "-qm", "first");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("gitScanSource", () => {
  it("reads the tree AT the chosen sha, not the working copy, with git's blob hashes", () => {
    const first = git("rev-parse", "HEAD");
    writeFileSync(join(repo, "src/a.py"), "one\ntwo\nthree\n");
    git("commit", "-qam", "second");
    writeFileSync(join(repo, "src/a.py"), "uncommitted\n");

    const src = gitScanSource(repo, state);
    expect(src.resolve("HEAD")).toBe(git("rev-parse", "HEAD"));
    expect(src.resolve("no-such-ref")).toBeNull();
    expect(src.resolve("--output=x")).toBeNull();

    const opened = src.open(first, []);
    if (!opened.ok) throw new Error(opened.reason);
    const t = opened.tree;
    expect(t.root).toBe(join(state, SCAN_TREES_DIR, first));
    // Regular files only: the symlink is not a scan file.
    expect(t.files.map((f) => f.path)).toEqual(["src/a.py"]);
    expect(t.files[0]!.blob).toBe(git("rev-parse", `${first}:src/a.py`));
    expect(t.read("src/a.py")).toBe("one\ntwo\n");
    expect(t.lines("src/a.py")).toBe(2);
    expect(t.read("../repo/src/a.py")).toBeNull();
  });

  it("keeps one materialised tree per sha, and the running one on request", () => {
    const first = git("rev-parse", "HEAD");
    writeFileSync(join(repo, "src/b.py"), "b\n");
    git("add", "-A");
    git("commit", "-qm", "second");
    const second = git("rev-parse", "HEAD");
    const src = gitScanSource(repo, state);
    expect(src.open(first, []).ok).toBe(true);
    expect(src.open(second, [first]).ok).toBe(true);
    expect(existsSync(join(state, SCAN_TREES_DIR, first))).toBe(true);
    expect(src.open(second, []).ok).toBe(true);
    expect(existsSync(join(state, SCAN_TREES_DIR, first))).toBe(false);
  });
});
