// The security facts' repository reads over a local git directory, for a
// host that reviews in one shot (reviewapi.ts: `/qcr-review`, `qcr review`).
// `computeSecurityFacts` (secfacts.ts) reads synchronously, so this reader
// does too: `git ls-tree` and `git cat-file` only, with the system and global
// git configuration ignored, nothing in the repository run. A read that
// fails, a file over the size cap and a read past the budget answer null,
// and the check that asked says `unknown`, never `clear`. The daemon has
// its own, asynchronous reader over its base clone (src/securityrequest.ts
// `securityFactsAt`).
import { execFileSync } from "node:child_process";
import { SECURITY_FACTS_MAX_FILES, type SecurityFactsIo } from "./secfacts.js";

/** The largest file a fact check reads. */
export const LOCAL_FACT_READ_MAX_BYTES = 1024 * 1024;
/** The most files the facts read in all, over both commits. */
export const LOCAL_FACT_READS_MAX = 4 * SECURITY_FACTS_MAX_FILES;

/** A commit or tree object name; anything else reads as nothing. */
const OBJECT_RE = /^[0-9a-f]{7,64}$/i;

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

function git(gitDir: string, args: string[], maxBuffer: number): Buffer {
  return execFileSync("git", ["-C", gitDir, ...args], {
    env: GIT_ENV,
    maxBuffer,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/**
 * The facts' reads at `head` and `base` in `gitDir` (a commit, or the tree
 * object an uncommitted review snapshots). Each read is cached; the listing
 * is read once, and a head path it does not hold is never read.
 */
export function localGitFactsIo(
  gitDir: string,
  shas: { head: string; base: string },
): SecurityFactsIo {
  let listing: string[] | null | undefined;
  let held: Set<string> | undefined;
  const cache = new Map<string, string | null>();
  let reads = 0;
  const listHead = (): string[] | null => {
    if (listing !== undefined) return listing;
    if (!OBJECT_RE.test(shas.head)) return (listing = null);
    try {
      listing = git(gitDir, ["ls-tree", "-r", "-z", "--name-only", shas.head], 64 * 1024 * 1024)
        .toString("utf8")
        .split("\0")
        .filter((p) => p.length > 0);
    } catch {
      listing = null;
    }
    held = listing === null ? undefined : new Set(listing);
    return listing;
  };
  const read = (side: "head" | "base", path: string): string | null => {
    const sha = side === "head" ? shas.head : shas.base;
    if (!OBJECT_RE.test(sha) || path === "" || path.includes("\0") || path.startsWith("/"))
      return null;
    const key = `${side}\0${path}`;
    if (cache.has(key)) return cache.get(key)!;
    if (side === "head" && listHead() !== null && !held!.has(path)) return null;
    if (reads >= LOCAL_FACT_READS_MAX) return null;
    reads++;
    let text: string | null;
    try {
      text = git(
        gitDir,
        ["cat-file", "blob", `${sha}:${path}`],
        LOCAL_FACT_READ_MAX_BYTES,
      ).toString("utf8");
    } catch {
      // Missing, not a blob, or over the cap (the buffer refuses it).
      text = null;
    }
    cache.set(key, text);
    return text;
  };
  return {
    readHead: (p) => read("head", p),
    readBase: (p) => read("base", p),
    listHead,
  };
}
