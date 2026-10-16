// The scan's source port: the reviewed checkout, read-only, as trees at a
// chosen sha.
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
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import { inRoot, MAX_READ_BYTES } from "./adapters.js";
import type { ScanSource, ScanTree } from "./scanrun.js";
import type { UnreadableReason } from "./scan.js";
import { isBinaryContent, textLineCount } from "./textsniff.js";
import type { TreeFile } from "./scan.js";

/** Where materialised trees live, under the state home. */
export const SCAN_TREES_DIR = "scan/tree";
const COMPLETE_SUFFIX = ".complete";
/** Blobs, and their bytes, per `cat-file --batch` call — bound one call's
 * output buffer (a single larger blob is a call of its own). */
const BLOBS_PER_BATCH = 256;
const BYTES_PER_BATCH = 64 * 1024 * 1024;
const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
/** A full commit sha (SHA-1 or SHA-256) — the only spelling a tree is opened at. */
export const isFullSha = (s: string): boolean => SHA_RE.test(s);

/** `treesDir` (relative to the state home) is where this source keeps its
 * trees — the scan's own by default; another reader of trees (the PR
 * replay) passes its own, so neither prunes the other's.
 * `batchBytes` bounds one `cat-file --batch` call's output (tests shrink it). */
export function gitScanSource(
  repoRoot: string,
  stateRoot: string,
  opts: { treesDir?: string; batchBytes?: number } = {},
): ScanSource {
  const batchBytes = opts.batchBytes ?? BYTES_PER_BATCH;
  // Why the last git call failed — its stderr's first line, or the error
  // (a buffer overrun, git missing) — so a refusal names the cause.
  let lastFailure = "";
  const failed = (err: unknown): null => {
    const e = err as { stderr?: Buffer | string; message?: string };
    const stderr = (
      Buffer.isBuffer(e.stderr) ? e.stderr.toString("utf8") : (e.stderr ?? "")
    ).trim();
    lastFailure = (stderr.split("\n")[0] || e.message || String(err)).slice(0, 300);
    return null;
  };
  const because = (): string => (lastFailure ? ` (${lastFailure})` : "");
  const git = (args: string[], maxBuffer = 64 * 1024 * 1024): string | null => {
    try {
      return execFileSync("git", ["-c", `safe.directory=${repoRoot}`, "-C", repoRoot, ...args], {
        encoding: "utf8",
        maxBuffer,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      return failed(err);
    }
  };
  const gitBytes = (args: string[], input: string, maxBuffer: number): Buffer | null => {
    try {
      return execFileSync("git", ["-c", `safe.directory=${repoRoot}`, "-C", repoRoot, ...args], {
        input,
        maxBuffer,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      return failed(err);
    }
  };
  /** Write every listed file's blob, raw, under `root`. False when git
   * cannot produce one — the tree is then not complete. */
  const materialise = (root: string, files: TreeFile[]): boolean => {
    const pathsOf = new Map<string, string[]>();
    for (const f of files) pathsOf.set(f.blob, [...(pathsOf.get(f.blob) ?? []), f.path]);
    const blobs = [...pathsOf.keys()];
    if (blobs.length === 0) return true;
    // Sizes first, so one call's output is bounded by BYTES as well as by
    // count: a repository of large assets must not need one huge buffer.
    const checked = gitBytes(
      ["cat-file", "--batch-check"],
      blobs.join("\n") + "\n",
      64 * 1024 * 1024,
    );
    if (checked === null) return false;
    const sizeOf = new Map<string, number>();
    for (const line of checked.toString("utf8").split("\n")) {
      const m = /^([0-9a-f]+) blob (\d+)$/.exec(line);
      if (m) sizeOf.set(m[1]!, Number(m[2]));
    }
    const chunks: Array<{ blobs: string[]; bytes: number }> = [];
    for (const blob of blobs) {
      const size = sizeOf.get(blob);
      if (size === undefined) return false;
      const last = chunks[chunks.length - 1];
      if (last && last.blobs.length < BLOBS_PER_BATCH && last.bytes + size <= batchBytes) {
        last.blobs.push(blob);
        last.bytes += size;
      } else chunks.push({ blobs: [blob], bytes: size });
    }
    for (const { blobs: chunk, bytes } of chunks) {
      // Each blob's header and trailing newline on top of its bytes.
      const out = gitBytes(
        ["cat-file", "--batch"],
        chunk.join("\n") + "\n",
        bytes + chunk.length * 128 + 1024,
      );
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
          if (isAbsolute(rel) || !inRoot(back)) continue;
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
      if (!SHA_RE.test(sha))
        return { ok: false, reason: `not a commit sha: ${JSON.stringify(sha)}` };
      lastFailure = "";
      const files = list(sha);
      if (files === null)
        return { ok: false, reason: `git cannot list that commit's tree${because()}` };
      const root = join(treesDir, sha);
      const marker = `${root}${COMPLETE_SUFFIX}`;
      try {
        mkdirSync(treesDir, { recursive: true });
        for (const other of readdirSync(treesDir)) {
          const owner = other.endsWith(COMPLETE_SUFFIX)
            ? other.slice(0, -COMPLETE_SUFFIX.length)
            : other;
          if (owner !== sha && !keep.includes(owner))
            rmSync(join(treesDir, other), { recursive: true, force: true });
        }
        if (!existsSync(marker)) {
          rmSync(root, { recursive: true, force: true });
          mkdirSync(root, { recursive: true });
          if (!materialise(root, files))
            return { ok: false, reason: `git cannot read that commit's blobs${because()}` };
          writeFileSync(marker, `${sha}\n`);
        }
      } catch (err) {
        return {
          ok: false,
          reason: `cannot materialise the tree: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      return { ok: true, tree: treeAt(sha, root, files) };
    },
    list,
  };
}

/** A materialised tree as the runner reads it: text within the reader's
 * size cap, never a binary (`isBinaryContent` — one stray NUL in a source
 * file is still text), never a path that leaves the root. What it cannot
 * read it says why (`whyUnreadable`), so the plan REPORTS a skipped binary
 * rather than dropping it silently. */
export function treeAt(sha: string, root: string, files: TreeFile[]): ScanTree {
  const why = new Map<string, UnreadableReason>();
  const read = (rel: string): string | null => {
    if (isAbsolute(rel)) return null;
    const full = normalize(join(root, rel));
    const back = relative(root, full);
    if (!inRoot(back)) return null;
    try {
      const st = statSync(full);
      if (!st.isFile()) return null;
      if (st.size > MAX_READ_BYTES) {
        why.set(rel, "too-big");
        return null;
      }
      const buf = readFileSync(full);
      if (isBinaryContent(buf, rel)) {
        why.set(rel, "binary");
        return null;
      }
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
    whyUnreadable: (rel) => {
      if (read(rel) !== null) return null;
      return why.get(rel) ?? "unreadable";
    },
    lines: (rel) => {
      if (cache.has(rel)) return cache.get(rel)!;
      const text = read(rel);
      const n = text === null ? null : textLineCount(text);
      cache.set(rel, n);
      return n;
    },
  };
}
