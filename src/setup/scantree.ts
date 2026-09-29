// The scan's SOURCE port, for real: the reviewed checkout, READ-
// ONLY, as trees at a chosen sha.
//
// "Scan my local checkout at a sha I choose" means the tree AT THAT SHA, not
// whatever the working copy holds: the file list and every content hash come
// from git's own objects (`ls-tree` — the blob hash IS the ledger's content
// hash), and the files the lenses read are materialised from the commit
// (`git archive` → `tar -x`) into `<state home>/scan/tree/<sha>/`. The
// checkout itself is never written — the companion mounts it `:ro` — and no
// credential is involved: the objects are local.
//
// One materialised tree is kept per sha; opening another removes the earlier
// ones except those `keep` names (the one a running scan is reading). A tree
// is complete only once its marker is written, so an extraction cut short is
// redone rather than trusted.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize, relative } from "node:path";
import { MAX_READ_BYTES } from "./adapters.js";
import type { ScanSource, ScanTree } from "./scanrun.js";
import type { TreeFile } from "./scan.js";

/** Where materialised trees live, under the state home. */
export const SCAN_TREES_DIR = "scan/tree";
const COMPLETE_MARKER = ".qcr-tree-complete";
const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export function gitScanSource(repoRoot: string, stateRoot: string): ScanSource {
  const git = (args: string[], maxBuffer = 64 * 1024 * 1024): string | null => {
    try {
      return execFileSync("git", ["-c", `safe.directory=${repoRoot}`, "-C", repoRoot, ...args], {
        encoding: "utf8",
        maxBuffer,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return null;
    }
  };
  const treesDir = join(stateRoot, SCAN_TREES_DIR);
  return {
    location: repoRoot,
    resolve: (ref) => {
      if (!/^[A-Za-z0-9._/@^~-]+$/.test(ref) || ref.startsWith("-")) return null;
      const sha = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])?.trim() ?? "";
      return SHA_RE.test(sha) ? sha : null;
    },
    open: (sha, keep) => {
      if (!SHA_RE.test(sha)) return { ok: false, reason: `not a commit sha: ${JSON.stringify(sha)}` };
      const listed = git(["ls-tree", "-r", "-z", "--full-tree", sha], 512 * 1024 * 1024);
      if (listed === null) return { ok: false, reason: "git cannot list that commit's tree" };
      const files: TreeFile[] = [];
      for (const rec of listed.split("\0")) {
        // `<mode> <type> <object>\t<path>` — regular files only: no submodule
        // (`commit`), no symlink (120000) a lens could follow out of the tree.
        const m = /^(\d{6}) (\w+) ([0-9a-f]+)\t(.+)$/s.exec(rec);
        if (!m || m[2] !== "blob" || m[1] === "120000") continue;
        files.push({ path: m[4]!, blob: m[3]! });
      }
      const root = join(treesDir, sha);
      try {
        mkdirSync(treesDir, { recursive: true });
        for (const other of readdirSync(treesDir)) {
          if (other !== sha && !keep.includes(other)) rmSync(join(treesDir, other), { recursive: true, force: true });
        }
        if (!existsSync(join(root, COMPLETE_MARKER))) {
          rmSync(root, { recursive: true, force: true });
          mkdirSync(root, { recursive: true });
          const tar = join(treesDir, `.${sha}.tar`);
          if (git(["archive", "--format=tar", "-o", tar, sha]) === null) {
            return { ok: false, reason: "git archive failed" };
          }
          try {
            execFileSync("tar", ["-xf", tar, "-C", root], { stdio: ["ignore", "ignore", "pipe"] });
          } finally {
            rmSync(tar, { force: true });
          }
          writeFileSync(join(root, COMPLETE_MARKER), `${sha}\n`);
        }
      } catch (err) {
        return { ok: false, reason: `cannot materialise the tree: ${err instanceof Error ? err.message : String(err)}` };
      }
      return { ok: true, tree: treeAt(sha, root, files) };
    },
  };
}

/** A materialised tree as the runner reads it: text within the reader's
 * size cap, never a binary, never a path that leaves the root. */
export function treeAt(sha: string, root: string, files: TreeFile[]): ScanTree {
  const read = (rel: string): string | null => {
    if (isAbsolute(rel)) return null;
    const full = normalize(join(root, rel));
    const back = relative(root, full);
    if (back === "" || back.startsWith("..")) return null;
    try {
      const st = statSync(full);
      if (!st.isFile() || st.size > MAX_READ_BYTES) return null;
      const buf = readFileSync(full);
      if (buf.subarray(0, 8000).includes(0)) return null;
      return buf.toString("utf8");
    } catch {
      return null;
    }
  };
  const cache = new Map<string, number | null>();
  return {
    sha,
    root,
    files,
    read,
    lines: (rel) => {
      if (cache.has(rel)) return cache.get(rel)!;
      const text = read(rel);
      let n: number | null = null;
      if (text !== null) {
        n = 0;
        for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
        if (text !== "" && !text.endsWith("\n")) n++;
      }
      cache.set(rel, n);
      return n;
    },
  };
}
