// The in-process file tools' fence (D32). The SDK session's read, grep, find,
// ls, edit and write tools run inside the Node process that holds the GitHub
// token and the login, as the run uid, so a path they are given must not lead
// to the places that hold them:
//
//   /proc/*        the token holder's own environ, mem, cmdline and fds
//   /run/qcr-in    where the caller staged the token (read once and unlinked,
//                  but the mount is the caller's)
//   the agent dir  the run's login copy, models and settings
//   credentials    the secrets dirs (the App key, the webhook secret, the
//                  OpenViking keys), the IPC run dirs and the sessions'
//                  ovcli.conf (credentialPaths)
//
// The model's bash runs as another uid (tooluid.ts) and so cannot reach them;
// these tools can. Plain path matching is not enough: bash, as the tool uid,
// can plant a symlink in the worktree that points at a fenced path. So the
// fence resolves the target first: the real path of the file, or, for one that
// does not exist yet (a write), of its parent directory, following a dangling
// final symlink too (a write follows it). Both the path as given and the
// resolved one must be clear of the fence.
//
// The tools are built with pi's own `operations` hook, so each file is opened
// by this module: a read opens the file first and checks what the descriptor
// really is (/proc/self/fd), so a symlink swapped in after the path check
// still lands on a refusal. grep and find hand their search root to ripgrep
// and fd, which pi starts itself as the run uid and do not follow symlinks;
// those two are checked before the tool runs: the root, and that no fenced
// path lies below it.
import { constants, lstatSync, readlinkSync, realpathSync, type PathLike } from "node:fs";
import { mkdir, open, stat, readdir, access } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  EditOperations,
  GrepOperations,
  LsOperations,
  ReadOperations,
  ToolDefinition,
  WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { defaultSecretPathContext } from "../../extensions/bash-guard.js";

/** What no file tool may reach, besides the run's agent dirs. `/qcr-login` is
 * where the wrapper and the Action mount the owner's login volume: its
 * auth.json holds the long-lived refresh token and is group-readable by the
 * run uid, whose group the in-process file tools (unlike the tool uid's bash)
 * keep. */
export const FENCED_PATHS: readonly string[] = ["/proc", "/dev/fd", "/run/qcr-in", "/qcr-login"];

/** The directories `env` names as the login's source: the process's own pi
 * agent dir (`PI_CODING_AGENT_DIR`, which a review copies into its private
 * agent dir) and the scan's `QCR_SCAN_AUTH_SRC`. The round's copy is the
 * host's agent dir, fenced separately. */
export function loginSourceDirs(env: NodeJS.ProcessEnv): string[] {
  return ["PI_CODING_AGENT_DIR", "QCR_SCAN_AUTH_SRC"]
    .map((k) => env[k]?.trim())
    .filter((v): v is string => v !== undefined && v !== "" && isAbsolute(v));
}

/**
 * The credentials an `env` points at, which no file tool may reach:
 *
 *   - every secrets dir this install could be using: the App's private key, the
 *     webhook secret and the OpenViking keys live there. The list is the bash
 *     guard's own (`defaultSecretPathContext`, which mirrors the install
 *     locator: `$QCR_SECRETS_MOUNT`, the container mount, `$QC_SECRETS_DIR`,
 *     `<config home>/secrets`, a `[github] secrets_dir` read from
 *     `$QCR_CONFIG`, and the legacy dir), so the shell belt and this fence
 *     name the same places;
 *   - the daemon's IPC run dirs (the socket and the capability launch files);
 *   - the memory CLI config the env names (`OPENVIKING_CLI_CONFIG_FILE`, the
 *     sessions' ovcli.conf): it holds the reviewer key, which the in-process
 *     memory extension reads itself and the model has no use for.
 *
 * Our own code reads these with plain fs calls, never through the tools, so
 * fencing them takes nothing away from it. Every absolute path, deduplicated;
 * a path that does not exist is fenced lexically and by its resolved prefix.
 */
export function credentialPaths(...envs: NodeJS.ProcessEnv[]): string[] {
  const out = new Set<string>();
  for (const env of envs) {
    const ctx = defaultSecretPathContext(env, "/");
    for (const d of [...ctx.dirs, ...(ctx.runDirs ?? [])]) out.add(d);
    const ovcli = env["OPENVIKING_CLI_CONFIG_FILE"]?.trim();
    if (ovcli !== undefined && isAbsolute(ovcli)) out.add(resolve(ovcli));
  }
  return [...out];
}

/** The names of the file tools behind the fence. */
export const FENCED_TOOLS = ["read", "grep", "find", "ls", "edit", "write"] as const;
export type FencedTool = (typeof FENCED_TOOLS)[number];

/** A path the fence refuses; `message` is what the model reads. */
export class ToolFenceError extends Error {
  constructor(path: string) {
    super(`${path}: access refused (it leads into a fenced path)`);
    this.name = "ToolFenceError";
  }
}

const MAX_LINKS = 40;

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith("/") ? root : root + "/");
}

/** The real path of `p`, which need not exist: the longest existing prefix is
 * resolved, and a dangling symlink is followed to where it would lead. */
function realOrIntended(p: string, links = 0): string {
  if (links > MAX_LINKS) throw new Error(`${p}: too many levels of symbolic links`);
  try {
    return realpathSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const parent = dirname(p);
  if (parent === p) return p;
  let link: string | undefined;
  try {
    if (lstatSync(p).isSymbolicLink()) link = readlinkSync(p);
  } catch {
    // not there at all
  }
  const base = realOrIntended(parent, links + 1);
  if (link !== undefined) return realOrIntended(resolve(base, link), links + 1);
  return join(base, basename(p));
}

export interface ToolFence {
  /** Throws a ToolFenceError for a path that is, or leads to, a fenced one. */
  check(path: string): void;
  /** `check`, and for a search root that ripgrep or fd walk: also refuses a
   * root with a fenced path below it, which the walk would reach. */
  checkTree(path: string): void;
  /** For a file already opened: refuses when the descriptor is a fenced file,
   * whatever path it was opened by. A no-op where /proc/self/fd does not exist. */
  checkOpened(fd: number, path: string): void;
  /** `check`, and for a write: refuses a path that LEADS, through a symlink,
   * onto a protected write target (`protectedWrite`). A path that is itself the
   * target is the write veto's to judge as spelled (bash-guard), so only a real
   * path that differs from the one given is held to the predicate here. */
  checkWrite(path: string): void;
  /** `checkOpened`, and the same symlink rule for the descriptor a write opened. */
  checkWriteOpened(fd: number, path: string): void;
}

/** A fence over the fixed paths and the given directories. */
export function createToolFence(
  o: {
    dirs?: readonly string[];
    /** The write veto's predicate (bash-guard `isProtectedWriteTarget`): git's
     * config and hook surface, the policy surface, the memory scope, the wake
     * delivery files. Applied to where a write really lands when a symlink
     * moved it: the in-process write tools run in the uid that runs the
     * daemon's git and reads its policy, so a link committed in a PR, or one
     * the tool uid planted in a directory it shares, must not carry a write
     * there. */
    protectedWrite?: (realPath: string) => boolean;
  } = {},
): ToolFence {
  const roots = (): string[] => {
    const out = new Set<string>();
    for (const r of [...FENCED_PATHS, ...(o.dirs ?? [])]) {
      out.add(r);
      try {
        out.add(realpathSync(r));
      } catch {
        // not there: the lexical form is all there is
      }
    }
    return [...out];
  };
  const fenced = (p: string): boolean => roots().some((r) => within(p, r));
  return {
    check(path) {
      const abs = resolve(path);
      let real: string;
      try {
        real = realOrIntended(abs);
      } catch (e) {
        // A path that cannot be resolved cannot be shown clear of the fence.
        if (e instanceof ToolFenceError) throw e;
        throw new ToolFenceError(path);
      }
      if (fenced(abs) || fenced(real)) throw new ToolFenceError(path);
    },
    checkTree(path) {
      this.check(path);
      const abs = resolve(path);
      const real = realOrIntended(abs);
      if (roots().some((r) => within(r, abs) || within(r, real))) throw new ToolFenceError(path);
    },
    checkOpened(fd, path) {
      let real: string;
      try {
        real = realpathSync(`/proc/self/fd/${fd}`);
      } catch {
        return;
      }
      if (fenced(real)) throw new ToolFenceError(path);
    },
    checkWrite(path) {
      this.check(path);
      const guard = o.protectedWrite;
      if (guard === undefined) return;
      const abs = resolve(path);
      let real: string;
      try {
        real = realOrIntended(abs);
      } catch {
        throw new ToolFenceError(path);
      }
      if (real !== abs && guard(real)) throw new ToolFenceError(path);
    },
    checkWriteOpened(fd, path) {
      this.checkOpened(fd, path);
      const guard = o.protectedWrite;
      if (guard === undefined) return;
      let real: string;
      try {
        real = realpathSync(`/proc/self/fd/${fd}`);
      } catch {
        return;
      }
      if (real !== resolve(path) && guard(real)) throw new ToolFenceError(path);
    },
  };
}

// ---- the paths as pi reads them -------------------------------------------------

// pi's UNICODE_SPACES (utils/paths.js): the no-break and typographic spaces
const SPACE_CODES = [
  0x00a0,
  ...Array.from({ length: 11 }, (_, i) => 0x2000 + i),
  0x202f,
  0x205f,
  0x3000,
];
const UNICODE_SPACES = new RegExp(
  `[${SPACE_CODES.map((c) => String.fromCharCode(c)).join("")}]`,
  "g",
);

/** A tool's `path` argument as pi resolves it (utils/paths.js resolvePath with
 * unicode spaces and the `@` prefix normalised, `~` and file: URLs expanded). */
export function toolPath(input: string, cwd: string): string {
  let p = input.replace(UNICODE_SPACES, " ");
  if (p.startsWith("@")) p = p.slice(1);
  if (p === "~") p = homedir();
  else if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
  else if (/^file:\/\//.test(p)) p = fileURLToPath(p);
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

// ---- the operations ---------------------------------------------------------------

const MIME_SNIFF_BYTES = 4100;

/** Tells an image from its first bytes: its mime type, or null. */
export type ImageSniffer = (head: Buffer) => string | null | undefined;

/** Opens `path` for reading, checks what was opened, and gives the handle. */
async function openChecked(fence: ToolFence, path: string, flags: number) {
  fence.check(path);
  const fh = await open(path, flags);
  try {
    fence.checkOpened(fh.fd, path);
  } catch (e) {
    await fh.close();
    throw e;
  }
  return fh;
}

async function readChecked(fence: ToolFence, path: string): Promise<Buffer> {
  const fh = await openChecked(fence, path, constants.O_RDONLY);
  try {
    return await fh.readFile();
  } finally {
    await fh.close();
  }
}

async function writeChecked(fence: ToolFence, path: string, content: string): Promise<void> {
  // No truncation at open: nothing is cut before the descriptor is known to be
  // clear — of the fence, and of a protected target a symlink led it to (a link
  // swapped in after the path check still lands on a refusal here).
  fence.checkWrite(path);
  const fh = await open(path, constants.O_WRONLY | constants.O_CREAT);
  try {
    fence.checkWriteOpened(fh.fd, path);
  } catch (e) {
    await fh.close();
    throw e;
  }
  try {
    await fh.truncate(0);
    await fh.writeFile(content, "utf-8");
  } finally {
    await fh.close();
  }
}

function readOperations(fence: ToolFence, sniff: ImageSniffer | null): ReadOperations {
  return {
    readFile: (p) => readChecked(fence, p),
    access: async (p) => {
      fence.check(p);
      await access(p, constants.R_OK);
    },
    detectImageMimeType: async (p) => {
      if (sniff === null) return null;
      const fh = await openChecked(fence, p, constants.O_RDONLY);
      try {
        const buf = Buffer.alloc(MIME_SNIFF_BYTES);
        const { bytesRead } = await fh.read(buf, 0, MIME_SNIFF_BYTES, 0);
        return sniff(buf.subarray(0, bytesRead)) ?? null;
      } finally {
        await fh.close();
      }
    },
  };
}

function editOperations(fence: ToolFence): EditOperations {
  return {
    readFile: (p) => readChecked(fence, p),
    writeFile: (p, content) => writeChecked(fence, p, content),
    access: async (p) => {
      fence.check(p);
      await access(p, constants.R_OK | constants.W_OK);
    },
  };
}

function writeOperations(fence: ToolFence): WriteOperations {
  return {
    writeFile: (p, content) => writeChecked(fence, p, content),
    mkdir: async (dir) => {
      fence.checkWrite(dir);
      await mkdir(dir, { recursive: true });
    },
  };
}

function grepOperations(fence: ToolFence): GrepOperations {
  return {
    isDirectory: async (p) => {
      fence.check(p);
      return (await stat(p)).isDirectory();
    },
    readFile: async (p) => (await readChecked(fence, p)).toString("utf-8"),
  };
}

function lsOperations(fence: ToolFence): LsOperations {
  const checked =
    <T>(f: (p: PathLike) => Promise<T>) =>
    async (p: string) => {
      fence.check(p);
      return f(p);
    };
  return {
    exists: async (p) => {
      fence.check(p);
      try {
        await access(p);
        return true;
      } catch {
        return false;
      }
    },
    stat: checked(stat),
    readdir: checked((p) => readdir(p)),
  };
}

/** The `operations` of each file tool that takes them, every file opened through
 * the fence. `sniff` tells images from their first bytes; without it a file is
 * always read as text. find has none: it starts fd on its search root. */
export function fencedOperations(
  fence: ToolFence,
  sniff: ImageSniffer | null,
): {
  read: ReadOperations;
  grep: GrepOperations;
  ls: LsOperations;
  edit: EditOperations;
  write: WriteOperations;
} {
  return {
    read: readOperations(fence, sniff),
    grep: grepOperations(fence),
    ls: lsOperations(fence),
    edit: editOperations(fence),
    write: writeOperations(fence),
  };
}

/** `def` with a check of its `path` argument ahead of its execution: the
 * refusal says what it is, and the tools that start ripgrep and fd (which
 * `operations` does not reach) are covered. */
export function guardedTool(def: ToolDefinition, fence: ToolFence, cwd: string): ToolDefinition {
  const run = def.execute;
  return {
    ...def,
    execute: (id, params, signal, onUpdate, ctx) => {
      const given = (params as { path?: unknown }).path;
      const root = toolPath(
        typeof given === "string" && given !== "" ? given : ".",
        ctx?.cwd || cwd,
      );
      // grep and find walk the whole tree under the root.
      if (def.name === "grep" || def.name === "find") fence.checkTree(root);
      else fence.check(root);
      return run(id, params, signal, onUpdate, ctx);
    },
  } as ToolDefinition;
}
