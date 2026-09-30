// The scan's real source port (src/setup/scantree.ts) against a
// scratch git repo in a temp dir — no network. It is the one piece of the
// scan that must be proven on git itself: "the tree AT the chosen sha", with
// git's own blob hashes as the ledger's content hash.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

  it("lists a sha's files and blob hashes without materialising anything — a delta's baseline", () => {
    const first = git("rev-parse", "HEAD");
    const src = gitScanSource(repo, state);
    expect(src.list(first)).toEqual([{ path: "src/a.py", blob: git("rev-parse", `${first}:src/a.py`) }]);
    expect(existsSync(join(state, SCAN_TREES_DIR, first))).toBe(false);
    expect(src.list("f".repeat(40))).toBeNull();
    expect(src.list("HEAD")).toBeNull();
  });
});

describe("gitScanSource materialisation is the listed blobs, byte for byte (selfscan)", () => {
  it("never writes through a repository-controlled completion-marker symlink", () => {
    // A commit tracking the completion marker's name as a symlink to a file
    // outside the tree: the marker write must never follow it.
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "precious\n");
    symlinkSync(victim, join(repo, ".qcr-tree-complete"));
    git("add", "-A");
    git("commit", "-qm", "marker link");
    const sha = git("rev-parse", "HEAD");
    const opened = gitScanSource(repo, state).open(sha, []);
    if (!opened.ok) throw new Error(opened.reason);
    expect(readFileSync(victim, "utf8")).toBe("precious\n");
    // And the tree is still recognised as complete on the next open.
    const again = gitScanSource(repo, state).open(sha, []);
    expect(again.ok).toBe(true);
    expect(readFileSync(victim, "utf8")).toBe("precious\n");
  });

  it("ignores in-tree export-ignore / export-subst attributes: every listed file reads as its blob", () => {
    writeFileSync(join(repo, ".gitattributes"), "src/hidden.py export-ignore\nsrc/subst.py export-subst\n");
    writeFileSync(join(repo, "src/hidden.py"), "hidden\n");
    writeFileSync(join(repo, "src/subst.py"), "v = '$Format:%H$'\n");
    git("add", "-A");
    git("commit", "-qm", "attrs");
    const sha = git("rev-parse", "HEAD");
    const opened = gitScanSource(repo, state).open(sha, []);
    if (!opened.ok) throw new Error(opened.reason);
    expect(opened.tree.read("src/hidden.py")).toBe("hidden\n");
    expect(opened.tree.read("src/subst.py")).toBe("v = '$Format:%H$'\n");
    for (const f of opened.tree.files) {
      expect(git("hash-object", join(opened.tree.root, f.path))).toBe(f.blob);
    }
  });

  it("reads a tree whose blobs span several cat-file calls, by count and by bytes", () => {
    for (let i = 0; i < 300; i++) writeFileSync(join(repo, `src/f${i}.txt`), `${i}\n`.repeat(i + 1));
    git("add", "-A");
    git("commit", "-qm", "many");
    const sha = git("rev-parse", "HEAD");
    const opened = gitScanSource(repo, state, { batchBytes: 1000 }).open(sha, []);
    if (!opened.ok) throw new Error(opened.reason);
    expect(opened.tree.files.length).toBeGreaterThan(300);
    const files = opened.tree.files;
    const hashes = git("hash-object", ...files.map((f) => join(opened.tree.root, f.path))).split("\n");
    expect(hashes).toEqual(files.map((f) => f.blob));
  });
});
