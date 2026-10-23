// Where a local review keeps what it remembers about a repo: the delta history
// per target (packages/pi-plugin/src/reviewstate.ts) and the saved destination (packages/pi-plugin/src/reviewdest.ts).
//
// One directory per repo under the review home the host names (the CLI's is
// `<state home>/review`, src/reviewhome.ts):
//   <home>/<key>/state/<hash>.json   one file per target
//   <home>/<key>/destination.json    the saved destinations
// The key is the origin's owner/name plus the repo's root commit, so every
// clone and worktree of a repo shares one history and a fork keeps its own.
// A repo with no origin is keyed by its directory name instead of an owner.
// The state home is the place a container volume mounts, which is why this is
// not the git dir any more. The git dir's old files are copied in once.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { originRepo } from "./localreview.js";

const LEGACY_STATE_DIR = "qcr-review-state";
const LEGACY_DEST_FILE = "qcr-review-destination.json";
const IMPORTED_MARKER = ".legacy-imported";

export interface ReviewStore {
  /** `<state home>/review/<key>`. */
  readonly dir: string;
  /** The state file for a target (`branchTargetKey` / `prTargetKey`). */
  statePath(targetKey: string): string;
  /** The repo's saved destinations. */
  destinationPath(): string;
}

function git(cwd: string, args: readonly string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^\.+/, "_");

/** The repo's directory-safe key; null outside a git repo, or in one with no
 * commit yet (nothing to key it by, and nothing to remember). Several root
 * commits (merged histories): the smallest hash, so the key is stable. */
export function repoKey(cwd: string): string | null {
  const roots = git(cwd, ["rev-list", "--max-parents=0", "HEAD"]);
  const root = roots?.split("\n").filter(Boolean).sort()[0];
  if (!root) return null;
  const origin = originRepo(cwd);
  let name = origin;
  if (name === null) {
    const common = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (common === null) return null;
    // A normal repo's common dir is `<repo>/.git`; a bare one is the repo.
    const dir = basename(common) === ".git" ? dirname(common) : common;
    name = `local/${basename(dir)}`;
  }
  const [owner = "local", repo = ""] = name.split("/");
  return `${slug(owner)}--${slug(repo)}--${root.slice(0, 12)}`;
}

/** Copy what the repo's git dir held before the state moved here. Once per
 * store (a marker says so), and never over a file the store already has. The
 * originals are left where they are. Best-effort: a copy that fails costs the
 * repo its old history, not the review. */
function importLegacy(cwd: string, store: ReviewStore): void {
  const marker = join(store.dir, IMPORTED_MARKER);
  if (existsSync(marker)) return;
  try {
    const common = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (common !== null) {
      const stateDir = join(common, LEGACY_STATE_DIR);
      const copy = (from: string, to: string): void => {
        if (!existsSync(from) || existsSync(to)) return;
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(from, to);
      };
      if (existsSync(stateDir))
        for (const f of readdirSync(stateDir))
          if (f.endsWith(".json")) copy(join(stateDir, f), join(store.dir, "state", f));
      copy(join(common, LEGACY_DEST_FILE), store.destinationPath());
    }
    mkdirSync(store.dir, { recursive: true });
    writeFileSync(marker, "");
  } catch {
    // Unwritable store: the callers' own saves fail the same way, quietly.
  }
}

/** The repo's store under the review home `home`; null outside a git repo.
 * Opening is cheap and creates nothing but, on the first open, the imported
 * copies. */
export function openReviewStoreIn(home: string, cwd: string): ReviewStore | null {
  const key = repoKey(cwd);
  if (key === null) return null;
  const dir = resolve(home, key);
  const store: ReviewStore = {
    dir,
    statePath: (targetKey) =>
      join(
        dir,
        "state",
        `${createHash("sha256").update(targetKey).digest("hex").slice(0, 20)}.json`,
      ),
    destinationPath: () => join(dir, "destination.json"),
  };
  importLegacy(cwd, store);
  return store;
}
