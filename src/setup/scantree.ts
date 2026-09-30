// The scan's SOURCE port, for real: the reviewed checkout, READ-
// ONLY, as trees at a chosen sha.
//
// "Scan my local checkout at a sha I choose" means the tree AT THAT SHA, not
// whatever the working copy holds: the file list and every content hash come
// from git's own objects (`ls-tree` — the blob hash IS the ledger's content
// hash), and the files the lenses read are materialised from exactly those
// blobs (`git cat-file --batch`, raw bytes) into
// `<state home>/scan/tree/<sha>/`. Not `git archive`: it honours in-tree
// `export-ignore`/`export-subst`, so a listed file could be missing or read
// as bytes its blob hash never named; and it extracts symlinks. Only the
// listed regular files are written, so nothing in the tree is a link. The
// checkout itself is never written — the companion mounts it `:ro` — and no
// credential is involved: the objects are local.
//
// One materialised tree is kept per sha; opening another removes the earlier
// ones except those `keep` names (the one a running scan is reading). A tree
// is complete only once its marker is written, so an extraction cut short is
// redone rather than trusted. The marker is a SIBLING of the tree
// (`<sha>.complete`), never a path inside it: a name inside the tree is one
// the commit can occupy.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import { MAX_READ_BYTES } from "./adapters.js";
import type { ScanSource, ScanTree } from "./scanrun.js";
import type { TreeFile } from "./scan.js";

/** Where materialised trees live, under the state home. */
export const SCAN_TREES_DIR = "scan/tree";
const COMPLETE_SUFFIX = ".complete";
/** Blobs per `cat-file --batch` call — bounds one call's output buffer. */
const BLOBS_PER_BATCH = 256;
const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** `treesDir` (relative to the state home) is where this source keeps its
 * trees — the scan's own by default; another reader of trees (the PR
 * replay) passes its own, so neither prunes the other's. */
export function gitScanSource(repoRoot: string, stateRoot: string, opts: { treesDir?: string } = {}): ScanSource {
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
  const gitBytes = (args: string[], input: string): Buffer | null => {
    try {
      return execFileSync("git", ["-c", `safe.directory=${repoRoot}`, "-C", repoRoot, ...args], {
        input,
        maxBuffer: 1024 * 1024 * 1024,
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      return null;
    }
  };
  /** Write every listed file's blob, raw, under `root`. False when git
   * cannot produce one — the tree is then not complete. */
  const materialise = (root: string, files: TreeFile[]): boolean => {
    const pathsOf = new Map<string, string[]>();
    for (const f of files) pathsOf.set(f.blob, [...(pathsOf.get(f.blob) ?? []), f.path]);
    const blobs = [...pathsOf.keys()];
    for (let i = 0; i < blobs.length; i += BLOBS_PER_BATCH) {
      const chunk = blobs.slice(i, i + BLOBS_PER_BATCH);
      const out = gitBytes(["cat-file", "--batch"], chunk.join("\n") + "\n");
      if (out === null) return false;
      let at = 0;
      for (const blob of chunk) {
        const nl = out.indexOf(10, at);
        if (nl < 0) return false;
        const m = /^([0-9a-f]+) blob (\d+)$/.exec(out.subarray(at, nl).toString("utf8"));
        if (!m || m[1] !== blob) return false;
        const size = Number(m[2]);
        const body = out.subarray(nl + 1, nl + 1 + size);
        if (body.length !== size) return false;
        at = nl + 1 + size + 1;
        for (const rel of pathsOf.get(blob)!) {
          const full = normalize(join(root, rel));
          const back = relative(root, full);
          if (isAbsolute(rel) || back === "" || back.startsWith("..")) continue;
          mkdirSync(dirname(full), { recursive: true });
          writeFileSync(full, body);
        }
      }
    }
    return true;
  };
  const treesDir = join(stateRoot, opts.treesDir ?? SCAN_TREES_DIR);
  const list = (sha: string): TreeFile[] | null => {
    if (!SHA_RE.test(sha)) return null;
    const listed = git(["ls-tree", "-r", "-z", "--full-tree", sha], 512 * 1024 * 1024);
    if (listed === null) return null;
    const files: TreeFile[] = [];
    for (const rec of listed.split("\0")) {
      // `<mode> <type> <object>\t<path>` — regular files only: no submodule
      // (`commit`), no symlink (120000) a lens could follow out of the tree.
      const m = /^(\d{6}) (\w+) ([0-9a-f]+)\t(.+)$/s.exec(rec);
      if (!m || m[2] !== "blob" || m[1] === "120000") continue;
      files.push({ path: m[4]!, blob: m[3]! });
    }
    return files;
  };
  return {
    location: repoRoot,
    resolve: (ref) => {
      if (!/^[A-Za-z0-9._/@^~-]+$/.test(ref) || ref.startsWith("-")) return null;
      const sha = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])?.trim() ?? "";
      return SHA_RE.test(sha) ? sha : null;
    },
    open: (sha, keep) => {
      if (!SHA_RE.test(sha)) return { ok: false, reason: `not a commit sha: ${JSON.stringify(sha)}` };
      const files = list(sha);
      if (files === null) return { ok: false, reason: "git cannot list that commit's tree" };
      const root = join(treesDir, sha);
      const marker = `${root}${COMPLETE_SUFFIX}`;
      try {
        mkdirSync(treesDir, { recursive: true });
        for (const other of readdirSync(treesDir)) {
          const owner = other.endsWith(COMPLETE_SUFFIX) ? other.slice(0, -COMPLETE_SUFFIX.length) : other;
          if (owner !== sha && !keep.includes(owner)) rmSync(join(treesDir, other), { recursive: true, force: true });
        }
        if (!existsSync(marker)) {
          rmSync(root, { recursive: true, force: true });
          mkdirSync(root, { recursive: true });
          if (!materialise(root, files)) return { ok: false, reason: "git cannot read that commit's blobs" };
          writeFileSync(marker, `${sha}\n`);
        }
      } catch (err) {
        return { ok: false, reason: `cannot materialise the tree: ${err instanceof Error ? err.message : String(err)}` };
      }
      return { ok: true, tree: treeAt(sha, root, files) };
    },
    list,
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
