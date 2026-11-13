// The state_explore tool's reads, over a PR worktree's git object store.
//
// The tool runs in the worker process as the run uid — outside the bash
// guard, the tool-uid split and the file fence — so this reader holds the
// exec boundary itself (docs/exec-boundary.md):
//
//  - Committed objects only, never the working tree: a file the session
//    wrote or a symlink it planted cannot feed an answer.
//  - Four plumbing verbs and nothing else: `rev-parse --verify`, `ls-tree`,
//    `cat-file --batch` (no `--textconv`, no `--filters`) and `diff-tree`
//    with `--no-ext-diff --no-textconv`. No porcelain (diff, log, show,
//    grep), no `ls-files` (the index reaches fsmonitor).
//  - Every child pins the configuration that could run a program
//    (`core.fsmonitor`, `diff.external`, `core.sshCommand`, `protocol.allow`)
//    and gets an environment built from nothing: PATH from the host (its
//    absolute entries only), no system or global config, no prompt, no lazy
//    fetch, no optional locks, the C locale and a home that does not exist.
//    `diff-tree` runs the fsmonitor hook unless it is pinned off, measured
//    against git 2.55. Children start in `/`, so nothing resolves against
//    the worker's own directory.
//  - The reader picks the repository, not git. Discovery is fenced (no bare
//    repository found by walking, no walking above the worktree's parent),
//    and `verify()` asks git once which repository it found: the worktree
//    must be the top of its work tree, and the git directory its own `.git`
//    or a linked worktree's directory that names this worktree back. Every
//    later child names that directory explicitly. A committed directory
//    shaped like a bare repository (with `objects/info/alternates` pointing
//    at another repository) therefore cannot lend the reader another
//    repository's objects, or its configuration.
//  - Asynchronous children only: one worker hosts every lens session.
//  - A target is verified once per session. A session's later calls hand
//    the next reader the git directory `verify()` accepted (`verified`) and
//    the target's tree listings and diff (`cache`): commit ids name
//    immutable objects, and every child after verification names that
//    directory explicitly, so a later change to `<worktree>/.git` cannot
//    redirect a reused reader. Only a positive answer is kept: a refused
//    verification, a failed listing or a failed diff is asked again.
//  - No network, no writes, no session, no agent.
//
// A failed or refused read is null, never a throw; the caller says
// `unknown`.

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { isInside } from "./pathinside.js";
import type { ExploreIo } from "./stateexplore.js";
import { parseUnifiedDiff } from "./unifieddiff.js";

export type ExploreSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

/** The configuration every child pins, before `-C`. */
export const EXPLORE_GIT_PINS: readonly string[] = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "protocol.allow=never",
  "-c",
  "core.sshCommand=false",
  "-c",
  "diff.external=",
  "-c",
  "safe.bareRepository=explicit",
];

/** The diff's flags: no external diff, no textconv, no colour. */
export const EXPLORE_DIFF_FLAGS: readonly string[] = [
  "-r",
  "-p",
  "-M",
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
];

/** PATH's absolute entries: an empty or relative entry would resolve `git`
 * against whatever directory the child starts in. */
export function absolutePath(path: string): string {
  return path
    .split(":")
    .filter((s) => isAbsolute(s))
    .join(":");
}

/** The one environment every child gets, built from nothing. Discovery
 * stops below the worktree's parent (`GIT_CEILING_DIRECTORIES`). */
export function exploreGitEnv(path: string, worktree: string): Record<string, string> {
  return {
    PATH: absolutePath(path),
    GIT_CEILING_DIRECTORIES: dirname(worktree),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
    LC_ALL: "C",
    HOME: "/nonexistent",
  };
}

/** A commit id: 40 hex (SHA-1) or 64 hex (SHA-256). */
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** The largest blob the reader hands over. */
export const EXPLORE_GIT_READ_MAX_BYTES = 1024 * 1024;
/** The largest listing or diff a child may print. */
const LIST_MAX_BYTES = 64 * 1024 * 1024;
const DIFF_MAX_BYTES = 32 * 1024 * 1024;
/** A child's wall time. */
export const EXPLORE_GIT_TIMEOUT_MS = 20_000;

export type ExploreTargetCheck =
  { ok: true; worktree: string; base: string; head: string } | { ok: false; refusal: string };

/**
 * The worktree and the two commits a call names, checked before any git
 * runs: an absolute path whose real path is the session's `cwd` or lies
 * under it, an existing directory, and two 40-hex (or 64-hex) ids. Whether
 * the ids resolve to commits is `GitExploreIo.verify`'s question.
 */
export async function checkExploreTarget(
  cwd: string,
  worktree: unknown,
  base: unknown,
  head: unknown,
): Promise<ExploreTargetCheck> {
  if (
    typeof worktree !== "string" ||
    worktree === "" ||
    worktree.includes("\0") ||
    !isAbsolute(worktree)
  )
    return {
      ok: false,
      refusal: "refused: `worktree` must be an absolute path (the PR worktree from the task)",
    };
  if (typeof base !== "string" || typeof head !== "string")
    return { ok: false, refusal: "refused: `base` and `head` are required on the first call" };
  const b = base.trim().toLowerCase();
  const h = head.trim().toLowerCase();
  if (!SHA_RE.test(b) || !SHA_RE.test(h))
    return {
      ok: false,
      refusal: "refused: `base` and `head` must be full commit ids (40 hex, or 64)",
    };
  let realCwd: string;
  let realWt: string;
  try {
    realCwd = await realpath(cwd);
  } catch {
    return { ok: false, refusal: "refused: the session's working directory cannot be resolved" };
  }
  try {
    realWt = await realpath(worktree);
  } catch {
    return { ok: false, refusal: "refused: `worktree` does not exist" };
  }
  if (!isInside(realWt, realCwd))
    return {
      ok: false,
      refusal: "refused: `worktree` is not inside this session's working directory",
    };
  try {
    if (!(await stat(realWt)).isDirectory())
      return { ok: false, refusal: "refused: `worktree` is not a directory" };
  } catch {
    return { ok: false, refusal: "refused: `worktree` cannot be read" };
  }
  return { ok: true, worktree: realWt, base: b, head: h };
}

export interface GitExploreOptions {
  worktree: string;
  base: string;
  head: string;
  /** The host's PATH, passed in (the core reads no ambient environment). */
  path: string;
  spawn?: ExploreSpawn;
  timeoutMs?: number;
  /** The git directory an earlier reader's `verify()` accepted for this same
   * target: `verify()` answers null with no child, and every child names it. */
  verified?: { gitDir: string };
  /** The target's listings and diff, shared by the readers of one session
   * over one target (`newExploreGitCache`). Only a positive read is kept. */
  cache?: ExploreGitCache;
}

export interface GitExploreIo extends ExploreIo {
  /** Null when the worktree is the top of a work tree whose repository is
   * its own and both ids resolve to commits; a refusal text otherwise. */
  verify(): Promise<string | null>;
  /** The git directory `verify()` accepted; null before it has, or when it refused. */
  gitDir(): string | null;
  close(): Promise<void>;
}

/** One regular blob of a tree listing. */
export interface TreeEntry {
  sha: string;
  size: number;
}

/** What one session reuses across calls over one target. */
export interface ExploreGitCache {
  trees: Map<string, Promise<Map<string, TreeEntry> | null>>;
  diff?: Promise<ReturnType<typeof parseUnifiedDiff> | null>;
}

export function newExploreGitCache(): ExploreGitCache {
  return { trees: new Map() };
}

/** `ls-tree -r -l -z` output: regular blobs only (no symlink, no submodule). */
function parseTree(out: Buffer): Map<string, TreeEntry> {
  const map = new Map<string, TreeEntry>();
  for (const rec of out.toString("utf8").split("\0")) {
    const tab = rec.indexOf("\t");
    if (tab < 0) continue;
    const meta = rec.slice(0, tab).split(/ +/);
    const path = rec.slice(tab + 1);
    const [mode, type, sha, size] = meta;
    if (type !== "blob" || (mode !== "100644" && mode !== "100755")) continue;
    if (sha === undefined || !/^[0-9a-f]{40,64}$/.test(sha)) continue;
    const n = Number(size);
    if (!Number.isFinite(n) || path === "") continue;
    map.set(path, { sha, size: n });
  }
  return map;
}

/** One `cat-file --batch` child for the life of the io: blob ids in, blobs out. */
class BatchReader {
  private child: ChildProcess | null = null;
  private dead = false;
  private buf: Buffer = Buffer.alloc(0);
  private readonly queue: { resolve: (b: Buffer | null) => void }[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly start: () => ChildProcess;
  private readonly timeoutMs: number;

  constructor(start: () => ChildProcess, timeoutMs: number) {
    this.start = start;
    this.timeoutMs = timeoutMs;
  }

  read(sha: string): Promise<Buffer | null> {
    if (this.dead) return Promise.resolve(null);
    if (!this.child) {
      try {
        this.child = this.start();
      } catch {
        this.fail();
        return Promise.resolve(null);
      }
      this.timer = setTimeout(() => this.fail(), this.timeoutMs);
      this.child.on("error", () => this.fail());
      this.child.on("close", () => this.fail());
      this.child.stdin?.on("error", () => this.fail());
      this.child.stdout?.on("data", (chunk: Buffer) => this.take(chunk));
    }
    return new Promise((resolve) => {
      this.queue.push({ resolve });
      this.child?.stdin?.write(`${sha}\n`);
    });
  }

  private take(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    while (this.queue.length > 0) {
      const nl = this.buf.indexOf(10);
      if (nl < 0) return;
      const header = this.buf.subarray(0, nl).toString("utf8");
      if (header.endsWith(" missing") || header.endsWith(" ambiguous")) {
        this.buf = this.buf.subarray(nl + 1);
        this.queue.shift()!.resolve(null);
        continue;
      }
      const parts = header.split(" ");
      const size = Number(parts[2]);
      if (parts.length !== 3 || !Number.isFinite(size)) {
        this.fail();
        return;
      }
      if (this.buf.length < nl + 1 + size + 1) return;
      const body = Buffer.from(this.buf.subarray(nl + 1, nl + 1 + size));
      this.buf = this.buf.subarray(nl + 1 + size + 1);
      this.queue.shift()!.resolve(parts[1] === "blob" ? body : null);
    }
  }

  private fail(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.dead = true;
    for (const q of this.queue.splice(0)) q.resolve(null);
    if (this.child && this.child.exitCode === null && this.child.signalCode === null)
      this.child.kill("SIGKILL");
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child || this.dead) {
      this.fail();
      return;
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        this.fail();
        resolve();
      }, 2_000);
      child.once("close", () => {
        clearTimeout(t);
        resolve();
      });
      child.stdin?.end();
    });
    this.fail();
  }
}

/**
 * The explore io over `worktree`'s object store at `base` and `head`. The
 * caller has checked the target (`checkExploreTarget`) and asks `verify()`
 * before the first read; `close()` ends the reader child.
 */
export function gitExploreIo(opts: GitExploreOptions): GitExploreIo {
  const spawn = opts.spawn ?? nodeSpawn;
  const timeoutMs = opts.timeoutMs ?? EXPLORE_GIT_TIMEOUT_MS;
  const env = exploreGitEnv(opts.path, opts.worktree);
  /** The repository verify() accepted; until then git discovers it (fenced). */
  let gitDir: string | null = opts.verified?.gitDir ?? null;
  const argv = (args: readonly string[]): string[] => [
    ...EXPLORE_GIT_PINS,
    "-c",
    `safe.directory=${opts.worktree}`,
    ...(gitDir === null ? [] : [`--git-dir=${gitDir}`, `--work-tree=${opts.worktree}`]),
    "-C",
    opts.worktree,
    ...args,
  ];
  const spawnOpts = (stdio: SpawnOptions["stdio"]): SpawnOptions => ({
    env,
    cwd: "/",
    stdio,
    shell: false,
    windowsHide: true,
  });
  const shapeOk = SHA_RE.test(opts.base) && SHA_RE.test(opts.head);

  /** One child to completion: its stdout (null on failure or overflow) and
   * the first line of its stderr. */
  const runFull = (
    args: readonly string[],
    maxBytes: number,
  ): Promise<{ out: Buffer | null; err: string }> =>
    new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn("git", argv(args), spawnOpts(["ignore", "pipe", "pipe"]));
      } catch {
        resolve({ out: null, err: "" });
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      let err = "";
      let done = false;
      const finish = (v: Buffer | null): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (v === null && child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
        resolve({ out: v, err: err.split("\n")[0] ?? "" });
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      child.on("error", () => finish(null));
      child.stdout?.on("data", (c: Buffer) => {
        bytes += c.length;
        if (bytes > maxBytes) finish(null);
        else chunks.push(c);
      });
      child.stderr?.on("data", (c: Buffer) => {
        if (err.length < 1024) err += c.toString("utf8").slice(0, 1024);
      });
      child.on("close", (code) => finish(code === 0 ? Buffer.concat(chunks) : null));
    });
  const run = async (args: readonly string[], maxBytes: number): Promise<Buffer | null> =>
    (await runFull(args, maxBytes)).out;

  let verified: Promise<string | null> | undefined =
    opts.verified !== undefined && shapeOk ? Promise.resolve(null) : undefined;
  const cache = opts.cache ?? newExploreGitCache();
  const tree = (sha: string): Promise<Map<string, TreeEntry> | null> => {
    let t = cache.trees.get(sha);
    if (!t) {
      const mine: Promise<Map<string, TreeEntry> | null> = run(
        ["ls-tree", "--full-tree", "-r", "-l", "-z", sha],
        LIST_MAX_BYTES,
      ).then((out) => {
        // A failed listing is not kept: the next reader asks again.
        if (out === null && cache.trees.get(sha) === mine) cache.trees.delete(sha);
        return out === null ? null : parseTree(out);
      });
      t = mine;
      cache.trees.set(sha, t);
    }
    return t;
  };
  const batch = new BatchReader(
    () => spawn("git", argv(["cat-file", "--batch"]), spawnOpts(["pipe", "pipe", "ignore"])),
    timeoutMs,
  );
  /** Whether verify() accepted the target (true from the start when reused). */
  let accepted = verified !== undefined;
  const ready = async (): Promise<boolean> => shapeOk && (await verify()) === null;
  const verify = (): Promise<string | null> => {
    verified ??= (async () => {
      if (!shapeOk) return "refused: `base` and `head` must be full commit ids (40 hex, or 64)";
      const repo = await ownRepository();
      if (typeof repo !== "object") return repo;
      gitDir = repo.gitDir;
      for (const [label, sha] of [
        ["base", opts.base],
        ["head", opts.head],
      ] as const) {
        const out = await run(["rev-parse", "--verify", "--quiet", `${sha}^{commit}`], 4096);
        if (out === null || out.toString("utf8").trim() !== sha)
          return `refused: \`${label}\` ${sha.slice(0, 12)} does not resolve to a commit in the worktree's repository`;
      }
      accepted = true;
      return null;
    })();
    return verified;
  };
  /** Which repository git finds at the worktree, accepted only when it is
   * the worktree's own: the worktree is the top of its work tree, and the
   * git directory is `<worktree>/.git` or a linked worktree's directory
   * (`<common>/worktrees/<id>`) whose `gitdir` file names `<worktree>/.git`
   * back. Anything else is a refusal text. */
  const ownRepository = async (): Promise<{ gitDir: string } | string> => {
    const r = await runFull(
      [
        "rev-parse",
        "--path-format=absolute",
        "--show-toplevel",
        "--show-prefix",
        "--git-dir",
        "--git-common-dir",
      ],
      16 * 1024,
    );
    if (r.out === null) {
      if (/dubious ownership/i.test(r.err))
        return "refused: git does not trust the owner of `worktree` (safe.directory), so it cannot be read";
      if (/bare repository/i.test(r.err))
        return "refused: `worktree` is a bare repository, not a work tree";
      if (/not a git repository/i.test(r.err))
        return "refused: there is no git repository at `worktree` itself (git does not look above it; name the worktree, not a directory in it)";
      return "refused: `worktree` is not the top of a git work tree";
    }
    const [top, prefix, dir, common] = r.out.toString("utf8").split("\n");
    if (top === undefined || dir === undefined || common === undefined)
      return "refused: `worktree` is not the top of a git work tree";
    const real = async (p: string): Promise<string | null> => {
      try {
        return await realpath(p);
      } catch {
        return null;
      }
    };
    if (prefix !== "" || (await real(top)) !== opts.worktree)
      return "refused: `worktree` is not the top of its git work tree (name the worktree itself, not a directory in it)";
    const own = join(opts.worktree, ".git");
    const realDir = await real(dir);
    if (realDir === null) return "refused: the worktree's git directory cannot be resolved";
    if (realDir === own) return { gitDir: realDir };
    // A linked worktree: <common>/worktrees/<id>, registered for this worktree.
    if (
      basename(dirname(realDir)) === "worktrees" &&
      (await real(common)) === dirname(dirname(realDir))
    ) {
      let back: string | null = null;
      try {
        const text = await readFile(join(realDir, "gitdir"), "utf8");
        if (text.length <= 4096) back = await real(text.trim());
      } catch {
        back = null;
      }
      if (back === own) return { gitDir: realDir };
    }
    return "refused: the repository git finds at `worktree` is not that worktree's own";
  };
  const read = async (sha: string, path: string): Promise<string | null> => {
    if (path === "" || path.includes("\0") || path.includes("\n")) return null;
    if (!(await ready())) return null;
    const entry = (await tree(sha))?.get(path);
    if (!entry || entry.size > EXPLORE_GIT_READ_MAX_BYTES) return null;
    const blob = await batch.read(entry.sha);
    return blob === null ? null : blob.toString("utf8");
  };
  return {
    verify,
    gitDir: () => (accepted ? gitDir : null),
    async listHead() {
      if (!(await ready())) return null;
      const t = await tree(opts.head);
      return t === null ? null : [...t].map(([path, e]) => ({ path, size: e.size }));
    },
    readHead: (path) => read(opts.head, path),
    readBase: (path) => read(opts.base, path),
    async diff() {
      if (!(await ready())) return null;
      if (cache.diff === undefined) {
        const mine = run(
          ["diff-tree", ...EXPLORE_DIFF_FLAGS, opts.base, opts.head],
          DIFF_MAX_BYTES,
        ).then((out) => {
          // A failed diff is not kept: the next reader asks again.
          if (out === null && cache.diff === mine) delete cache.diff;
          return out === null ? null : parseUnifiedDiff(out.toString("utf8"));
        });
        cache.diff = mine;
      }
      return cache.diff;
    },
    close: () => batch.close(),
  };
}
