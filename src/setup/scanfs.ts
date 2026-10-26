// The scan's real filesystem ports: the reviewed checkout, read-only
// (`checkoutReader`), and a home directory as a rooted filesystem
// (`stateHomeFs`, `configHomeFs`). Every port is total at its edge: a
// missing checkout lists null, and nothing throws but the state port's
// "exists but cannot be read", which its callers turn into a reported,
// write-refusing problem.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import type { RepoReader, StateFs } from "./scanports.js";
import { isBinaryContent, textLineCount } from "./textsniff.js";

/** Files over this are not read for facts or counted line by line — a
 * generated dump says nothing about a repo's conventions. */
export const MAX_READ_BYTES = 1024 * 1024;

/** Directories a walk never descends (the git-less fallback only). */
const WALK_SKIP = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "build",
]);

/** Does `back` (a `relative(root, …)`) stay under the root? A parent
 * traversal is the `..` COMPONENT, never a name that merely begins with two
 * dots — a tracked `..fixtures/a.ts` is an ordinary in-root file. The scan's
 * tree reader holds the same rule. */
export function inRoot(back: string): boolean {
  return back !== "" && back !== ".." && !back.startsWith(`..${sep}`) && !isAbsolute(back);
}

function inside(root: string, rel: string): string | null {
  if (isAbsolute(rel)) return null;
  const full = normalize(join(root, rel));
  return inRoot(relative(root, full)) ? full : null;
}

/**
 * The reviewed checkout. Listing is `git ls-files` — what the repo tracks,
 * so ignored build output never counts as the repo — with a plain walk as
 * the fallback for a tree git cannot read (no `.git`, or a mount git calls
 * "dubious ownership" despite the `safe.directory` override).
 */
export function checkoutReader(root: string): RepoReader {
  const git = (args: string[]): string | null => {
    try {
      return execFileSync("git", ["-c", `safe.directory=${root}`, "-C", root, ...args], {
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return null;
    }
  };
  // A directory it cannot list makes the whole listing unknown (null), never
  // a shorter one that reads as complete. A directory symlink is not
  // descended (a link back up would list the tree forever, one out of the
  // root lists another tree); a file symlink is listed like git lists it, and
  // `read` decides whether its target is inside.
  const walk = (): string[] | null => {
    const out: string[] = [];
    const visit = (dir: string): boolean => {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return false;
      }
      for (const name of names) {
        if (WALK_SKIP.has(name)) continue;
        const full = join(dir, name);
        let st;
        try {
          const l = lstatSync(full);
          if (l.isDirectory()) {
            if (!visit(full)) return false;
            continue;
          }
          st = l.isSymbolicLink() ? statSync(full) : l;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") return false;
          continue; // a dangling link names no file
        }
        if (st.isFile()) out.push(relative(root, full).split(sep).join("/"));
      }
      return true;
    };
    try {
      if (!statSync(root).isDirectory()) return null;
    } catch {
      return null;
    }
    return visit(root) ? out : null;
  };
  // The checkout's own resolved path, for the symlink check below; a root
  // that cannot be resolved reads nothing.
  let realRoot: string | null | undefined;
  const resolvedRoot = (): string | null => {
    if (realRoot === undefined) {
      try {
        realRoot = realpathSync(root);
      } catch {
        realRoot = null;
      }
    }
    return realRoot;
  };
  const readText = (rel: string): string | null => {
    const full = inside(root, rel);
    if (full === null) return null;
    try {
      // The lexical check above cannot see a symlink: a tracked link to a
      // file outside the checkout is not the checkout's content.
      const top = resolvedRoot();
      if (top === null || !inRoot(relative(top, realpathSync(full)))) return null;
      const st = statSync(full);
      if (!st.isFile() || st.size > MAX_READ_BYTES) return null;
      const buf = readFileSync(full);
      if (isBinaryContent(buf, rel)) return null; // binary — one stray NUL is not
      return buf.toString("utf8");
    } catch {
      return null;
    }
  };
  return {
    location: root,
    listFiles: () => {
      const listed = git(["ls-files", "-z"]);
      if (listed !== null) return listed.split("\0").filter((p) => p !== "");
      return walk();
    },
    read: readText,
    lines: (rel) => {
      const text = readText(rel);
      if (text === null) return null;
      return textLineCount(text);
    },
    head: () => git(["rev-parse", "HEAD"])?.trim() || null,
    changeCounts: () => {
      // Six months, bounded twice over: a busy repo's whole history is not
      // what "most-changed" means, and the listing must stay cheap.
      const log = git([
        "log",
        "--since=6.months",
        "--no-merges",
        "-n",
        String(CHANGE_LOG_COMMITS),
        "--name-only",
        "-z",
        "--format=",
      ]);
      if (log === null) return null;
      const counts: Record<string, number> = {};
      for (const p of log.split("\0")) {
        if (p !== "") counts[p] = (counts[p] ?? 0) + 1;
      }
      return counts;
    },
  };
}

/** The most commits the "most-changed" count walks. */
export const CHANGE_LOG_COMMITS = 2000;

/** The state home as a rooted filesystem: relative paths only, never out of
 * the root, every write tmp+rename atomic. */
export function stateHomeFs(root: string): StateFs {
  return homeFs(root, "state home");
}

/** The config home, the same way (the portrait narrative). In the
 * companion only parts of it are mounted, so its callers write only under a
 * mounted directory. */
export function configHomeFs(root: string): StateFs {
  return homeFs(root, "config home");
}

function homeFs(root: string, what: string): StateFs {
  const resolve = (rel: string): string => {
    const full = inside(root, rel);
    if (full === null) throw new Error(`path ${JSON.stringify(rel)} leaves the ${what}`);
    return full;
  };
  return {
    location: root,
    read: (rel) => {
      const full = resolve(rel);
      try {
        return readFileSync(full, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
    write: (rel, text) => {
      const full = resolve(rel);
      mkdirSync(dirname(full), { recursive: true });
      const tmp = join(
        dirname(full),
        `.${full.split("/").at(-1)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
      );
      try {
        writeFileSync(tmp, text);
        renameSync(tmp, full);
      } catch (err) {
        rmSync(tmp, { force: true });
        throw err;
      }
    },
  };
}
