// Worktree manager. One base clone of the app repo
// plus one worktree per open PR, created at queue time from the PR head ref
// and refreshed at the start of every round. Worktrees are read-only working
// copies for the lens passes — nothing here ever commits, pushes or touches a
// branch of the upstream repo.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { ExecFn, ExecResult } from "./tmux.js";
import { nodeExec, runOrThrow } from "./tmux.js";
import { parseHunkHeader } from "@quickchatai/pi-quickreview/src/hunkheader.js";
import { repoCloneDirName } from "./clonedir.js";
import {
  fetchMissingCommits,
  gitHasCommit,
  gitIsAncestor,
  prFetchRef,
  readPrOwnedDelta,
  sectionPath,
  type PrOwnedDelta,
} from "@quickchatai/pi-quickreview/src/prdelta.js";
import { unquoteGitPath } from "@quickchatai/pi-quickreview/src/unifieddiff.js";
import type { PreparedTree } from "@quickchatai/pi-quickreview/src/planner.js";

export { unquoteGitPath };
export {
  deltaAsPrFiles,
  githubStatusOf,
  joinDeltaFiles,
  parseNameStatusZ,
  parseNewSideRanges,
  parsePatchSections,
  type NameStatusEntry,
  type NewSideParse,
  type NewSideRange,
  type PatchSection,
  type PrOwnedDelta,
  type PrOwnedDeltaFile,
  type PrOwnedDeltaUnavailable,
} from "@quickchatai/pi-quickreview/src/prdelta.js";

export interface WorktreeManagerOptions {
  /** Sandbox root — the clone lives at <root>/<cloneDir>, worktrees at <root>/wt. */
  root: string;
  /** "owner/name" (config.github.repo) or a full clone URL. */
  repo: string;
  /** Overrides the derived https://github.com/<repo>.git clone URL. */
  cloneUrl?: string;
  run?: ExecFn;
  /** Directory name of the base clone. Production wires `[github] clone_dir`
   * via `githubCloneDir` (src/config.ts); absent ⇒ derived here
   * from `repo` by the same rule, `repoCloneDirName` ("owner/name" ⇒ "name"). */
  cloneDir?: string;
}

/** One `@@ -a,b +c,d @@` hunk of a zero-context diff: the old side's first
 * line and how many lines it removed (0 = a pure insertion after `old_start`). */
export interface DiffHunk {
  old_start: number;
  old_count: number;
}

/** The hunks of `git diff -U0` output (one file's, or several — only the
 * headers are read). */
export function parseDiffHunks(diff: string): DiffHunk[] {
  const out: DiffHunk[] = [];
  for (const line of diff.split("\n")) {
    const h = parseHunkHeader(line);
    if (h) out.push({ old_start: h.old_start, old_count: h.old_count });
  }
  return out;
}

/** How near an anchored line a change must land to count as touching it: a fix rarely edits only the one line a comment points at. */
export const ANCHOR_WINDOW = 3;

/** Does any hunk change the old side within `window` lines of `line`? A null
 * line (a finding anchored to the file, not a line) is touched by any hunk. */
export function hunksTouchLine(
  hunks: readonly DiffHunk[],
  line: number | null,
  window = ANCHOR_WINDOW,
): boolean {
  if (line === null) return hunks.length > 0;
  return hunks.some((h) => {
    const start = h.old_start;
    // A pure insertion sits between old_start and old_start + 1.
    const end = h.old_count === 0 ? h.old_start + 1 : h.old_start + h.old_count - 1;
    return start <= line + window && end >= line - window;
  });
}

/** A PR's worktree, relative to the sandbox root: the one spelling of the
 * `wt/pr-<n>` layout every reader of it uses. */
export function prWorktreeRel(pr: number): string {
  return `wt/pr-${pr}`;
}

const SHA_RE = /^[0-9a-f]{7,40}$/i;
const MEMO_ENTRY_LIMIT = 5000;

/** A file diff git renders without text hunks although the file changed:
 * a binary file, a file deleted while empty, or a mode-only change. */
const WHOLE_FILE_CHANGE = /^(Binary files .* differ|deleted file mode |old mode )/m;

/** One file's zero-context hunks, keyed by the file's OLD path (the side a
 * blame of the parent reads) as the repository spells it — git's quoting of a
 * special or non-ASCII path undone, the tab it appends to a path with a space
 * dropped; a file the diff creates has no old side and is left out, and a
 * header this reader cannot decode leaves its section out rather than misread
 * it. A `--- ` line is a file header only in a file section's header
 * (after its `diff --git`, before its first `@@`): inside a hunk it is a
 * REMOVED line whose text starts `-- ` (an SQL, Lua or Haskell comment), and
 * reading it as a header would drop the rest of the file's hunks. */
export function parseDiffHunksByFile(diff: string): Map<string, DiffHunk[]> {
  const out = new Map<string, DiffHunk[]>();
  let current: string | null = null;
  let inHeader = true;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHeader = true;
      current = null;
      continue;
    }
    if (inHeader && line.startsWith("--- ")) {
      current = line === "--- /dev/null" ? null : sectionPath(line.slice(4), "a/");
      continue;
    }
    if (line.startsWith("@@")) inHeader = false;
    if (current === null) continue;
    const h = parseHunkHeader(line);
    if (!h) continue;
    const list = out.get(current) ?? [];
    list.push({ old_start: h.old_start, old_count: h.old_count });
    out.set(current, list);
  }
  return out;
}

// ---- the PR-owned inter-round delta ----------------------------------------

// The delta's parsers, its types and its reader live in packages/pi-plugin/src/prdelta.ts (the
// review core); `WorktreeManager.prOwnedDelta` reads it over the base clone.

/** Where reviewed-head pins live. Their own namespace: `refs/qcr/pr-<n>` is a
 * ref already, so `refs/qcr/pr-<n>/…` could not be created. */
const REVIEWED_HEAD_NAMESPACE = "refs/qcr/reviewed/";

/** Recognises a reviewed-head pin (any 7–12 hex suffix, so legacy shorter
 * pins match); group 1 is the PR number. */
const REVIEWED_HEAD_REF_RE = new RegExp(
  `^${REVIEWED_HEAD_NAMESPACE.replace(/\//g, "\\/")}pr-(\\d+)-[0-9a-f]{7,12}$`,
);

/** Every pin of PR `pr` starts with this — what creation writes and the
 * PR's removal lists. */
function reviewedHeadPrefix(pr: number): string {
  return `${REVIEWED_HEAD_NAMESPACE}pr-${pr}-`;
}

/** The ref that pins a reviewed head against gc. */
export function reviewedHeadRef(pr: number, sha: string): string {
  return `${reviewedHeadPrefix(pr)}${sha.slice(0, 12).toLowerCase()}`;
}

/** The commits `git blame --porcelain` attributes lines to (each line's
 * header carries the full sha). */
export function parseBlameShas(porcelain: string): Set<string> {
  const out = new Set<string>();
  for (const line of porcelain.split("\n")) {
    const m = /^([0-9a-f]{40}) \d+ \d+(?: \d+)?$/.exec(line);
    if (m) out.add(m[1]!);
  }
  return out;
}

/** The commit on the base branch that landed PR `pr`, from `git log
 * --first-parent --format=%H%x09%cI%x09%P%x09%s` lines: a squash merge's
 * subject ends `(#<pr>)` (GitHub's own spelling), a merge commit's starts
 * `Merge pull request #<pr> `. Several candidates: the one committed nearest
 * `mergedAtMs`. Null when none names the PR (a rebase merge, a manual
 * cherry-pick) — never a guess. */
export function findMergeCommit(
  log: string,
  pr: number,
  mergedAtMs: number,
): { sha: string; parents: string[]; committed_at: string } | null {
  let best: { sha: string; parents: string[]; committed_at: string; gap: number } | null = null;
  const squash = new RegExp(`\\(#${pr}\\)\\s*$`);
  const merge = new RegExp(`^Merge pull request #${pr}(?!\\d)`);
  for (const line of log.split("\n")) {
    const [sha = "", at = "", parents = "", ...rest] = line.split("\t");
    const subject = rest.join("\t");
    if (!/^[0-9a-f]{40}$/.test(sha)) continue;
    if (!squash.test(subject) && !merge.test(subject)) continue;
    const gap = Math.abs((Date.parse(at) || 0) - mergedAtMs);
    if (!best || gap < best.gap)
      best = { sha, parents: parents.split(" ").filter(Boolean), committed_at: at, gap };
  }
  return best ? { sha: best.sha, parents: best.parents, committed_at: best.committed_at } : null;
}

/** A later commit on the base branch that changed lines a merged PR had
 * changed (one of the learner's recall sources). */
export interface PostMergeTouch {
  commit: string;
  subject: string;
  committed_at: string;
  path: string;
  /** The lines it changed, in its PARENT's numbering (what was blamed). */
  start: number;
  end: number;
}

export interface PostMergeScan {
  /** The commit that landed the PR on the base branch. */
  merge: string;
  shape: "squash" | "merge";
  /** Later commits read (touching the PR's files, inside the window). */
  checked: number;
  touches: PostMergeTouch[];
  /** The scan is PARTIAL: a cap was hit (more files, commits or blames than
   * were read), or a blame could not be read — what it did not read is
   * unknown, never "not touched". */
  truncated: boolean;
  /** Part of the partiality is a READ that failed (a blame git could not
   * answer), not a cap: another read may recover it. Absent means none. */
  unread?: boolean;
  /** The committer date of the base branch's tip in the clone: commits after
   * it have not been fetched, so a window ending later is not fully read yet
   * (the learner keeps such a PR pending — no fetch happens here). */
  tip_at: string;
}

/** Bounds of one `postMergeTouches` scan. */
export const POST_MERGE_LIMITS = Object.freeze({
  files: 100,
  laterCommits: 60,
  blames: 80,
  prCommits: 300,
});

/** What one round's worktree preparation established about the tree on disk:
 * the facts the planner reads (packages/pi-plugin/src/planner.ts), and where the tree lives. */
export interface WorktreeFacts extends PreparedTree {
  path: string;
}

export function cloneUrlFor(repo: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(repo) || repo.startsWith("git@") || repo.startsWith("/")
    ? repo
    : `https://github.com/${repo}.git`;
}

/** The info/exclude file of the git repository whose work tree is exactly
 * `root`, or null when `root` is not a work-tree root (the VM's sandbox: the
 * rsync ships no `.git`). Pure filesystem — no `git` process, so a checkout
 * owned by another uid (the plain-docker bind mount) cannot trip git's
 * safe.directory refusal. A `.git` FILE (the checkout is itself a linked
 * worktree) resolves through `gitdir:` and `commondir`, because info/ is
 * shared by every worktree of a repository. */
export function localExcludePath(root: string): string | null {
  const dotGit = join(root, ".git");
  let st;
  try {
    st = statSync(dotGit);
  } catch {
    return null;
  }
  if (st.isDirectory()) return join(dotGit, "info", "exclude");
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"));
  if (!m) return null;
  const gitDir = isAbsolute(m[1]!) ? m[1]! : resolve(root, m[1]!);
  const commonFile = join(gitDir, "commondir");
  const common = existsSync(commonFile)
    ? resolve(gitDir, readFileSync(commonFile, "utf8").trim())
    : gitDir;
  return join(common, "info", "exclude");
}

/**
 * Keep the base clone out of `git status` of the checkout it lives in. The
 * clone's name is per-install (`[github] clone_dir`, else the repo's
 * basename), so no tracked `.gitignore` line can name it; the rule goes into
 * the repository's local `info/exclude` instead — the same line
 * `scripts/deploy.sh` writes, so either writer finding it is a no-op. Only
 * matters where the sandbox root IS a checkout (`npm run daemon`, the
 * plain-docker bind mount); on the VM there is no `.git` and nothing happens.
 * Best-effort by contract: an unwritable exclude costs a dirty-looking tree,
 * never a round. Returns whether a line was appended.
 */
export function ensureLocallyIgnored(root: string, dirName: string): boolean {
  try {
    const exclude = localExcludePath(root);
    if (exclude === null) return false;
    const rule = `/${dirName}/`;
    const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    const spellings = new Set([rule, `/${dirName}`, `${dirName}/`, dirName]);
    if (current.split("\n").some((l) => spellings.has(l.trim()))) return false;
    mkdirSync(dirname(exclude), { recursive: true });
    // never glue the rule onto a last line that lacks its newline
    const sep = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
    appendFileSync(exclude, `${sep}${rule}\n`);
    return true;
  } catch {
    return false;
  }
}

/** Do two paths name the same directory? Both resolved through symlinks; one
 * that does not resolve names nothing. */
function samePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/**
 * The command-scope config every git the daemon runs carries. The
 * daemon's git runs in the base clone and the PR worktrees, whose repo-scope
 * config and hooks the daemon wrote but a session could reach if a boundary
 * failed; these settings shut the routes from a repo's config to running a
 * program: hooks (a worktree add runs post-checkout), the fsmonitor command
 * (every status and diff), and the `ext::` transport. Passed by git's
 * GIT_CONFIG_COUNT environment, which outranks every config file and leaves the
 * argv as it was.
 */
export const DAEMON_GIT_PINS: readonly (readonly [string, string])[] = [
  ["core.hooksPath", "/dev/null"],
  ["core.fsmonitor", "false"],
  ["protocol.ext.allow", "never"],
];

/** The env that carries `DAEMON_GIT_PINS` on top of `base`. */
export function pinnedGitEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, GIT_CONFIG_COUNT: String(DAEMON_GIT_PINS.length) };
  DAEMON_GIT_PINS.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return env;
}

/** nodeExec, with `DAEMON_GIT_PINS` on every git it starts. */
export const pinnedGitExec: ExecFn = (cmd, args, opts = {}) =>
  cmd === "git"
    ? nodeExec(cmd, args, { ...opts, env: pinnedGitEnv(opts.env ?? process.env) })
    : nodeExec(cmd, args, opts);

export class WorktreeManager {
  readonly root: string;
  readonly basePath: string;
  readonly wtRoot: string;
  private readonly cloneUrl: string;
  private readonly run: ExecFn;

  constructor(opts: WorktreeManagerOptions) {
    this.root = opts.root;
    this.basePath = join(opts.root, opts.cloneDir ?? repoCloneDirName(opts.repo));
    this.wtRoot = join(opts.root, "wt");
    this.cloneUrl = opts.cloneUrl ?? cloneUrlFor(opts.repo);
    this.run = opts.run ?? pinnedGitExec;
  }

  private git(args: string[], cwd = this.basePath): Promise<ExecResult> {
    return runOrThrow(this.run, "git", args, { cwd });
  }

  worktreePath(pr: number): string {
    return join(this.root, prWorktreeRel(pr));
  }

  /** Clone the base repo if it is not there yet. Idempotent. */
  async ensureBaseClone(): Promise<string> {
    // Only when the clone sits directly under root — the one shape the
    // anchored `/<name>/` rule describes.
    if (resolve(dirname(this.basePath)) === resolve(this.root))
      ensureLocallyIgnored(this.root, basename(this.basePath));
    if (existsSync(join(this.basePath, ".git"))) return this.basePath;
    mkdirSync(this.root, { recursive: true });
    await runOrThrow(this.run, "git", ["clone", this.cloneUrl, this.basePath], { cwd: this.root });
    return this.basePath;
  }

  /** Local ref the PR head is fetched into. FETCH_HEAD is per-worktree, so a
   * named ref is what makes "fetch in the clone, reset in the worktree" work. */
  private prRef(pr: number): string {
    return prFetchRef(pr);
  }

  /** Where a fetched base branch lands — the ordinary remote-tracking name, so
   * `origin/master` in a pass's shell means what it says. */
  private baseRef(branch: string): string {
    return `refs/remotes/origin/${branch}`;
  }

  /**
   * Fetch the PR head AND the branch it targets, then materialise (or refresh)
   * wt/pr-<n> at the head.
   *
   * The base fetch keeps `origin/<base>` current: lens rules such as
   * pass-data-safety's migration-numbering check compare against the base
   * branch's current head, and a base frozen at clone time would give both
   * false blockers and false clears.
   *
   * Both refspecs go in one `git fetch` so the two sides are as close to
   * simultaneous as git allows.
   */
  async ensureWorktree(
    pr: number,
    opts: { baseRef?: string; expectedHead?: string } = {},
  ): Promise<WorktreeFacts> {
    await this.ensureBaseClone();
    mkdirSync(this.wtRoot, { recursive: true });
    const base = opts.baseRef?.trim();
    const ref = this.prRef(pr);
    const refspecs = [`+refs/pull/${pr}/head:${ref}`];
    if (base) refspecs.push(`+refs/heads/${base}:${this.baseRef(base)}`);
    await this.git(["fetch", "--force", "origin", ...refspecs]);
    let head_sha = (await this.git(["rev-parse", ref])).stdout.trim();
    // GitHub updates `refs/pull/<n>/head` asynchronously and sometimes leaves it
    // behind the PR's head for good (#6075, 2026-10-21: three rounds reviewed a
    // stale commit and the head-moved guard refused each one). When the fetched
    // commit is a strict ANCESTOR of the head the API reported, the ref lags:
    // the round reviews that head, fetched by sha. A ref NEWER than the expected
    // head (the PR moved after the read) or unrelated to it (a force push) keeps
    // the ref's answer, as before.
    let pull_ref_sha: string | undefined;
    const want = opts.expectedHead?.trim() ?? "";
    if (/^[0-9a-f]{40}$/.test(want) && want !== head_sha && (await this.refLags(head_sha, want))) {
      await this.git(["update-ref", ref, want]);
      pull_ref_sha = head_sha;
      head_sha = want;
    }
    const path = await this.checkoutAt(pr, head_sha);

    let base_sha = "";
    let merge_base = "";
    if (base) {
      base_sha = (await this.git(["rev-parse", this.baseRef(base)])).stdout.trim();
      // Unrelated histories (or a force-pushed base) leave no merge-base. That
      // is information for the session, not a reason to fail the round.
      const mb = await this.run("git", ["merge-base", base_sha, head_sha], { cwd: this.basePath });
      if (mb.code === 0) merge_base = mb.stdout.trim();
    }
    return {
      path,
      head_sha,
      base_ref: base ?? "",
      base_sha,
      merge_base,
      ...(pull_ref_sha ? { pull_ref_sha } : {}),
    };
  }

  /** Whether `fetched` is a strict ancestor of `want`, fetching `want` by sha
   * when the clone lacks it. False on any failure: an unfetchable sha is no
   * evidence the ref lags. */
  private async refLags(fetched: string, want: string): Promise<boolean> {
    const cwd = this.basePath;
    if (!(await this.hasCommit(want))) {
      if ((await this.run("git", ["fetch", "--force", "origin", want], { cwd })).code !== 0)
        return false;
    }
    return (await this.isAncestor(fetched, want)) === true;
  }

  /**
   * Materialise wt/pr-<n> at an already-fetched sha, without touching the
   * network. This is what keeps the round prompt honest: the sha is resolved
   * once, in ensureWorktree, and every later step checks out that exact sha
   * instead of re-fetching and silently landing on a newer head.
   */
  async checkoutAt(pr: number, sha: string): Promise<string> {
    await this.ensureBaseClone();
    mkdirSync(this.wtRoot, { recursive: true });
    const path = this.worktreePath(pr);
    if (existsSync(path) && (await this.isOwnWorktree(path))) {
      await this.git(["reset", "--hard", sha], path);
      await this.git(["clean", "-fdx"], path);
      return path;
    }
    if (existsSync(path)) {
      // Not this clone's registered worktree — an interrupted `worktree add`,
      // a lost gitfile, a stray directory. Git run inside it would discover
      // whatever repository encloses the sandbox, so it is rebuilt instead.
      rmSync(path, { recursive: true, force: true });
    }
    // `--force` twice re-adds a path still registered (even locked, as an
    // interrupted add leaves it) whose checkout is gone.
    await this.git(["worktree", "add", "--force", "--force", "--detach", path, sha]);
    return path;
  }

  /** Is `path` a linked worktree of the base clone — its own top level, its
   * common git dir the clone's? Anything else, or a git that cannot say, is
   * not. */
  private async isOwnWorktree(path: string): Promise<boolean> {
    if (!existsSync(join(path, ".git"))) return false;
    const res = await this.run("git", ["rev-parse", "--show-toplevel", "--git-common-dir"], {
      cwd: path,
    });
    if (res.code !== 0) return false;
    const [top, common] = res.stdout.trim().split("\n");
    if (!top || !common) return false;
    return samePath(top, path) && samePath(resolve(path, common), join(this.basePath, ".git"));
  }

  /**
   * Every Django migration file present at `sha`, repo-relative.
   *
   * Read-only, no network: the base branch was fetched moments earlier by
   * `ensureWorktree`, so `sha` (the round's `base_sha`) is the branch's real
   * tip. `git ls-tree` is used rather than the filesystem because the base
   * clone's checkout is not at the base branch — the worktrees are.
   */
  async listMigrationFiles(sha: string): Promise<string[]> {
    // A sha this reader cannot use throws rather than returning []: an empty
    // list is indistinguishable from "the base has no migrations", which would
    // make the pre-check silently find nothing — and the migration pre-check
    // may get more reliable, never quieter. The caller
    // catches it and logs `migration_precheck_failed`.
    if (!SHA_RE.test(sha)) throw new Error(`listMigrationFiles: not a commit sha: ${sha}`);
    // NUL-separated: the names as the repository spells them, never git's
    // quoted display of a non-ASCII or special path.
    const res = await this.git(["ls-tree", "-r", "-z", "--name-only", sha]);
    return res.stdout.split("\0").filter((l) => /(^|\/)migrations\/[^/]+\.py$/.test(l));
  }

  /**
   * Files whose content in a merge commit differs from git's own auto-merge
   * of that merge's parents — i.e. files a human (or their agent) resolved by
   * hand. A clean base merge stays a trivial no-op for the recheck; a
   * conflict resolution is significant and gets reviewed for dropped
   * base-branch changes.
   *
   * `git merge-tree --write-tree` (git ≥ 2.38) recomputes the auto-merge
   * without touching any worktree; on conflicts it exits 1 but still writes
   * the tree (with conflict-marker blobs), so diffing it against the merge
   * commit's real tree names exactly the hand-resolved paths.
   *
   * `degraded: true` means the answer is unknown (old git, missing objects) —
   * the caller decides what that costs; this reader never guesses. `reason`
   * says why, for the caller's log (the failed git command and its stderr
   * when one failed).
   */
  async resolvedFilesInMerges(
    from: string,
    to: string,
    pr?: number,
  ): Promise<{ files: string[]; degraded: boolean; reason?: string }> {
    if (!SHA_RE.test(from) || !SHA_RE.test(to))
      return { files: [], degraded: true, reason: "not a commit sha" };
    // Every degraded answer keeps the files already verified: a later merge
    // that cannot be read makes the set incomplete, not wrong.
    const files = new Set<string>();
    try {
      // A recheck classifies a push minutes after it lands — usually before
      // any round has fetched the new objects into the base clone, so without
      // a fetch every live recheck would degrade.
      const gone = await this.fetchMissing([from, to], pr);
      if (gone.length)
        return { files: [], degraded: true, reason: `not in the clone: ${gone.join(", ")}` };
      const merges = (await this.git(["rev-list", "--merges", `${from}..${to}`])).stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const unverified: string[] = [];
      for (const m of merges) {
        const parents = (await this.git(["rev-list", "--parents", "-n", "1", m])).stdout
          .trim()
          .split(/\s+/)
          .slice(1);
        // An octopus (or otherwise odd) merge has no two-parent auto-merge to
        // compare against: the files it resolved are unknown, so the answer is
        // degraded — the other merges' files still count.
        if (parents.length !== 2) {
          unverified.push(m);
          continue;
        }
        // merge-tree exits 1 on conflicts while still printing the tree oid —
        // run unchecked and read the first line.
        const mt = await this.run("git", ["merge-tree", "--write-tree", parents[0]!, parents[1]!], {
          cwd: this.basePath,
        });
        const tree = (mt.stdout.split("\n")[0] ?? "").trim();
        if (!/^[0-9a-f]{40,64}$/.test(tree))
          return {
            files: [...files],
            degraded: true,
            reason: `merge-tree gave no tree for ${m} (exit ${mt.code}): ${mt.stderr.trim().slice(0, 200)}`,
          };
        // NUL-separated: the names GitHub reports, never git's quoted display.
        const diff = await this.git(["diff", "-z", "--name-only", tree, `${m}^{tree}`]);
        for (const f of diff.stdout.split("\0").filter(Boolean)) files.add(f);
      }
      return unverified.length
        ? {
            files: [...files],
            degraded: true,
            reason: `merge(s) with other than two parents not verified: ${unverified.join(", ")}`,
          }
        : { files: [...files], degraded: false };
    } catch (err) {
      return {
        files: [...files],
        degraded: true,
        reason: (err instanceof Error ? err.message : String(err)).slice(0, 300),
      };
    }
  }

  /**
   * The commits of `shas` the clone still lacks after fetching them on miss:
   * by sha first (GitHub serves a reachable want-sha), then PR `pr`'s head
   * ref, the reliable route for PR-branch heads. A fetch that fails is no
   * throw — the answer is what is still missing.
   */
  private async fetchMissing(shas: readonly string[], pr?: number): Promise<string[]> {
    return fetchMissingCommits(
      { run: this.run, cwd: this.basePath, hasCommit: (sha) => this.hasCommit(sha) },
      shas,
      pr,
    );
  }

  /**
   * The most recent human author of `paths` in the history reachable from
   * `sha` (the teammate the first-party-directive escalation comment
   * @-mentions). Read-only git in the base clone; the caller passes the
   * round's merge base so the PR's own commits never elect the PR author.
   *
   * Returns the newest non-bot author entry: `login` is derived from a GitHub
   * noreply email (`NNN+login@users.noreply.github.com` or
   * `login@users.noreply.github.com`) and is null when the email carries no
   * derivable login — the caller then falls back to its configured default
   * rather than walking further back (mentioning an older, uninvolved author
   * would be worse than the fallback). Null when no human touched the paths.
   */
  async lastHumanAuthor(
    sha: string,
    paths: string[],
    opts: { botLogins?: string[] } = {},
  ): Promise<{ login: string | null; name: string; email: string } | null> {
    if (!SHA_RE.test(sha) || paths.length === 0) return null;
    const bots = new Set((opts.botLogins ?? []).map((b) => b.toLowerCase()));
    const res = await this.git([
      "--literal-pathspecs",
      "log",
      "--format=%ae%x09%an",
      sha,
      "--",
      ...paths,
    ]);
    for (const line of res.stdout.split("\n")) {
      const [email = "", name = ""] = line.split("\t");
      if (!email && !name) continue;
      const login =
        /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i.exec(email.trim())?.[1] ?? null;
      const isBot =
        /\[bot\]/i.test(name) ||
        /\[bot\]/i.test(email) ||
        (login !== null && bots.has(login.toLowerCase())) ||
        bots.has(name.trim().toLowerCase()) ||
        bots.has(email.trim().toLowerCase());
      if (isBot) continue;
      return { login, name: name.trim(), email: email.trim() };
    }
    return null;
  }

  /** Memo for `anchorTouched`: a diff between two commits never changes.
   * `"whole"` is a change git shows without text hunks. */
  private readonly hunkMemo = new Map<string, DiffHunk[] | "whole">();
  /** Commits `anchorTouched` has seen in the clone (only a present one is
   * remembered: a missing one may be fetched by the next round). */
  private readonly presentCommits = new Set<string>();
  /** Memo for `pathAt`, over commits known present: a tree never changes. */
  private readonly pathMemo = new Map<string, boolean>();
  /** Memo for `introducedBetween` — definite answers only. */
  private readonly betweenMemo = new Map<string, boolean>();

  /**
   * Did the change from `from` to `to` touch `path` within `window` lines of
   * `line`, on the `from` side (outcome capture: "the code at the finding's
   * anchor changed")? Read-only git in the base clone, no fetch:
   * a commit the clone does not hold makes the answer unknown (`null`), never
   * a guess — and so does a `path` that `from` does not hold (a left-side
   * anchor on a file the PR deletes, an imprecise body-only path): an empty
   * diff of a file that is not there proves nothing about an anchor in it.
   * A file `to` deletes is touched, and so is one changed with no text hunks
   * to read (a binary edit, an empty file deleted): the whole file changed.
   * Answers are memoised — commits are immutable.
   */
  async anchorTouched(
    path: string,
    line: number | null,
    from: string,
    to: string,
    window = ANCHOR_WINDOW,
  ): Promise<boolean | null> {
    if (!path || !SHA_RE.test(from) || !SHA_RE.test(to)) return null;
    const key = `${from}..${to}\0${path}`;
    let hunks = this.hunkMemo.get(key);
    if (!hunks) {
      try {
        for (const sha of [from, to]) if (!(await this.present(sha))) return null;
        if (!(await this.pathAt(from, path))) return null;
        if (from === to) hunks = [];
        else {
          // A literal pathspec: `app/[id].tsx` must not also match
          // `app/i.tsx`, whose hunks would read as this anchor's.
          const res = await this.git([
            "--literal-pathspecs",
            "diff",
            "--no-color",
            "--no-ext-diff",
            "--no-renames",
            "-U0",
            from,
            to,
            "--",
            path,
          ]);
          const parsed = parseDiffHunks(res.stdout);
          hunks = parsed.length === 0 && WHOLE_FILE_CHANGE.test(res.stdout) ? "whole" : parsed;
        }
      } catch {
        return null;
      }
      if (this.hunkMemo.size >= MEMO_ENTRY_LIMIT) this.hunkMemo.clear();
      this.hunkMemo.set(key, hunks);
    }
    return hunks === "whole" || hunksTouchLine(hunks, line, window);
  }

  /**
   * Is `sha` a commit that `to` contains and `from` does not — a commit made
   * after the head a finding was raised at, and part of the PR since (a human
   * reply citing "Fixed in <sha>" counts only when the sha is such a commit, so a UUID segment, a colour or the commit that introduced
   * the behaviour is no fix)? Read-only git in the base clone, no fetch.
   * `null` — unknown — when any of the three is not a commit the clone holds
   * (an abbreviation that is ambiguous included); never a guess. Definite
   * answers are memoised.
   */
  async introducedBetween(sha: string, from: string, to: string): Promise<boolean | null> {
    if (!SHA_RE.test(sha) || !SHA_RE.test(from) || !SHA_RE.test(to)) return null;
    const key = `${sha.toLowerCase()}\0${from}\0${to}`;
    const known = this.betweenMemo.get(key);
    if (known !== undefined) return known;
    try {
      for (const c of [from, to]) if (!(await this.present(c))) return null;
      const resolved = await this.run(
        "git",
        ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`],
        { cwd: this.basePath },
      );
      if (resolved.code !== 0) return null;
      const commit = resolved.stdout.trim();
      if (!SHA_RE.test(commit)) return null;
      const inTo = await this.isAncestor(commit, to);
      if (inTo === null) return null;
      let answer = false;
      if (inTo) {
        const inFrom = await this.isAncestor(commit, from);
        if (inFrom === null) return null;
        answer = !inFrom;
      }
      if (this.betweenMemo.size >= MEMO_ENTRY_LIMIT) this.betweenMemo.clear();
      this.betweenMemo.set(key, answer);
      return answer;
    } catch {
      return null;
    }
  }

  /**
   * The commits that changed, within `windowDays` of PR `pr`'s merge, lines
   * that PR had changed ("the bot approved it, and two days later somebody
   * fixed those very lines" is the recall evidence the learner mines). Read-only git in the base clone, no fetch: the commit that landed
   * the PR is found on the base branch's first-parent history by its subject
   * (`findMergeCommit`); the PR's lines are that commit's diff against its
   * first parent; a later first-parent commit touches them when `git blame`
   * of its parent attributes a line it changed to the PR's commit(s). Bounded
   * (`POST_MERGE_LIMITS` — the oldest later commits are read; `truncated`
   * says when a cap cut the scan or a blame could not be read). `tip_at` is
   * the clone's base tip, so the caller can tell a window the clone has not
   * been fetched past. Null — unknown — when the branch is not in the clone
   * or no commit names the PR (a rebase merge): never "nothing touched".
   */
  async postMergeTouches(q: {
    pr: number;
    baseRef: string;
    mergedAt: string;
    windowDays: number;
  }): Promise<PostMergeScan | null> {
    const mergedMs = Date.parse(q.mergedAt);
    if (!Number.isInteger(q.pr) || q.pr <= 0 || !Number.isFinite(mergedMs)) return null;
    if (
      !/^[A-Za-z0-9._/-]+$/.test(q.baseRef) ||
      q.baseRef.startsWith("-") ||
      q.baseRef.includes("..")
    )
      return null;
    const ref = this.baseRef(q.baseRef);
    const day = 86_400_000;
    try {
      const has = await this.run("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
        cwd: this.basePath,
      });
      if (has.code !== 0) return null;
      const tipAt = (await this.git(["log", "-1", "--format=%cI", ref])).stdout.trim();
      if (!Number.isFinite(Date.parse(tipAt))) return null;
      const iso = (ms: number) => new Date(ms).toISOString();
      const log = await this.git([
        "log",
        "--first-parent",
        "--format=%H%x09%cI%x09%P%x09%s",
        `--since=${iso(mergedMs - 3 * day)}`,
        `--until=${iso(mergedMs + 3 * day)}`,
        ref,
      ]);
      const m = findMergeCommit(log.stdout, q.pr, mergedMs);
      if (!m || m.parents.length === 0) return null;
      const shape: PostMergeScan["shape"] = m.parents.length >= 2 ? "merge" : "squash";
      const prCommits = new Set<string>([m.sha]);
      let truncated = false;
      if (shape === "merge") {
        const list = (
          await this.git([
            "rev-list",
            `--max-count=${POST_MERGE_LIMITS.prCommits + 1}`,
            `${m.parents[0]}..${m.parents[1]}`,
          ])
        ).stdout
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => /^[0-9a-f]{40}$/.test(l));
        if (list.length > POST_MERGE_LIMITS.prCommits) truncated = true;
        for (const c of list.slice(0, POST_MERGE_LIMITS.prCommits)) prCommits.add(c);
      }
      // NUL-separated names, and literal pathspecs below: the files as the
      // repository spells them, each matching only itself.
      let files = (
        await this.git([
          "diff",
          "--no-color",
          "--no-ext-diff",
          "--no-renames",
          "-z",
          "--name-only",
          m.parents[0]!,
          m.sha,
        ])
      ).stdout
        .split("\0")
        .filter(Boolean);
      if (files.length > POST_MERGE_LIMITS.files) {
        truncated = true;
        files = files.slice(0, POST_MERGE_LIMITS.files);
      }
      const scan: PostMergeScan = {
        merge: m.sha,
        shape,
        checked: 0,
        touches: [],
        truncated,
        tip_at: tipAt,
      };
      if (files.length === 0) return scan;
      // The whole window, uncapped: `--max-count` keeps the NEWEST commits
      // (git log lists newest first, and `--reverse` applies after the cut),
      // and the cut must drop the newest instead — the first fix after the
      // merge is the most telling. The window (≤ `windowDays` of first-parent
      // commits touching these files) bounds the listing.
      const oldestFirst = (
        await this.git([
          "--literal-pathspecs",
          "log",
          "--first-parent",
          "--no-renames",
          "--format=%H%x09%cI%x09%s",
          `--until=${iso(mergedMs + q.windowDays * day)}`,
          `${m.sha}..${ref}`,
          "--",
          ...files,
        ])
      ).stdout
        .split("\n")
        .map((l) => l.split("\t"))
        .filter((p) => /^[0-9a-f]{40}$/.test(p[0] ?? ""))
        .reverse();
      if (oldestFirst.length > POST_MERGE_LIMITS.laterCommits) scan.truncated = true;
      let blames = 0;
      for (const [commit = "", at = "", ...rest] of oldestFirst.slice(
        0,
        POST_MERGE_LIMITS.laterCommits,
      )) {
        scan.checked += 1;
        const diff = await this.git([
          "--literal-pathspecs",
          "diff",
          "--no-color",
          "--no-ext-diff",
          "--no-renames",
          "--src-prefix=a/",
          "--dst-prefix=b/",
          "-U0",
          `${commit}^1`,
          commit,
          "--",
          ...files,
        ]);
        for (const [path, hunks] of parseDiffHunksByFile(diff.stdout)) {
          let lo = Infinity;
          let hi = -Infinity;
          for (const h of hunks) {
            if (h.old_count === 0) continue; // a pure insertion changes none of the PR's lines
            if (blames >= POST_MERGE_LIMITS.blames) {
              scan.truncated = true;
              break;
            }
            blames += 1;
            const end = h.old_start + h.old_count - 1;
            const blame = await this.run(
              "git",
              ["blame", "--porcelain", "-L", `${h.old_start},${end}`, `${commit}^1`, "--", path],
              { cwd: this.basePath },
            );
            if (blame.code !== 0) {
              // Unread is unknown, never "not the PR's lines": the scan says
              // it is partial, and that a re-read may recover it.
              scan.truncated = true;
              scan.unread = true;
              continue;
            }
            const shas = parseBlameShas(blame.stdout);
            if ([...shas].some((sha) => prCommits.has(sha))) {
              lo = Math.min(lo, h.old_start);
              hi = Math.max(hi, end);
            }
          }
          if (lo !== Infinity)
            scan.touches.push({
              commit,
              subject: rest.join("\t"),
              committed_at: at,
              path,
              start: lo,
              end: hi,
            });
        }
      }
      return scan;
    } catch {
      return null;
    }
  }

  /** `hasCommit`, remembering a present commit. */
  private async present(sha: string): Promise<boolean> {
    if (this.presentCommits.has(sha)) return true;
    if (!(await this.hasCommit(sha))) return false;
    if (this.presentCommits.size >= MEMO_ENTRY_LIMIT) this.presentCommits.clear();
    this.presentCommits.add(sha);
    return true;
  }

  /** Does the (present) commit `sha` hold `path`? */
  private async pathAt(sha: string, path: string): Promise<boolean> {
    const key = `${sha}\0${path}`;
    const known = this.pathMemo.get(key);
    if (known !== undefined) return known;
    const res = await this.run("git", ["cat-file", "-e", `${sha}:${path}`], {
      cwd: this.basePath,
    });
    const answer = res.code === 0;
    if (this.pathMemo.size >= MEMO_ENTRY_LIMIT) this.pathMemo.clear();
    this.pathMemo.set(key, answer);
    return answer;
  }

  /** `git merge-base --is-ancestor`: 0 yes, 1 no, anything else unknown. */
  private async isAncestor(a: string, b: string): Promise<boolean | null> {
    return gitIsAncestor(this.run, this.basePath, a, b);
  }

  /** True when `sha` is present in the base clone (no fetch needed). */
  async hasCommit(sha: string): Promise<boolean> {
    return gitHasCommit(this.run, this.basePath, sha);
  }

  /** Re-fetch + reset an existing worktree (round refresh); creates if absent. */
  async refresh(pr: number, opts: { baseRef?: string } = {}): Promise<WorktreeFacts> {
    return this.ensureWorktree(pr, opts);
  }

  async headSha(pr: number): Promise<string> {
    const res = await this.git(["rev-parse", "HEAD"], this.worktreePath(pr));
    return res.stdout.trim();
  }

  /**
   * The PR-owned change between two reviewed heads, read over the base clone
   * (packages/pi-plugin/src/prdelta.ts `readPrOwnedDelta`, which says how): fetch on miss, the
   * clone's memoised commit and path reads. Total: any unknown is
   * `{ok:false, reason}` and the caller runs the full round.
   */
  async prOwnedDelta(q: {
    pr: number;
    from: string;
    to: string;
    mergeBase: string;
    baseSha?: string;
    fromMergeBase?: string;
  }): Promise<PrOwnedDelta> {
    return readPrOwnedDelta(
      {
        run: this.run,
        cwd: this.basePath,
        hasCommit: (sha) => this.hasCommit(sha),
        fetchMissing: (shas, pr) => this.fetchMissing(shas, pr),
        pathAt: (sha, path) => this.pathAt(sha, path),
      },
      q,
    );
  }

  /**
   * Pin a reviewed head against gc: a follow-up round replays it,
   * and a force-push leaves it reachable from nothing but a worktree reflog.
   * `refs/qcr/reviewed/pr-<n>-<sha12>`; idempotent; removed with the PR's
   * worktree. Best-effort by contract — false when it could not be written
   * (the next follow-up round then re-fetches, or runs in full).
   */
  async pinReviewedHead(pr: number, sha: string): Promise<boolean> {
    if (!Number.isInteger(pr) || pr <= 0 || !/^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(sha))
      return false;
    try {
      const res = await this.run("git", ["update-ref", reviewedHeadRef(pr, sha), sha], {
        cwd: this.basePath,
      });
      return res.code === 0;
    } catch {
      return false;
    }
  }

  /** The PR's pinned reviewed-head refs. */
  async reviewedHeadRefs(pr: number): Promise<string[]> {
    const prefix = reviewedHeadPrefix(pr);
    const res = await this.run(
      "git",
      ["for-each-ref", "--format=%(refname)", REVIEWED_HEAD_NAMESPACE],
      {
        cwd: this.basePath,
      },
    );
    if (res.code !== 0) return [];
    return res.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith(prefix));
  }

  /** Owned refs, including PRs whose worktree directory is already gone. */
  private async ownedPrRefs(): Promise<Map<number, string[]>> {
    const refs = new Map<number, string[]>();
    if (!existsSync(join(this.basePath, ".git"))) return refs;
    const res = await this.git(["for-each-ref", "--format=%(refname)", "refs/qcr/"]);
    for (const ref of res.stdout.split("\n")) {
      const match = /^refs\/qcr\/pr-(\d+)$/.exec(ref) ?? REVIEWED_HEAD_REF_RE.exec(ref);
      if (!match) continue;
      const pr = Number(match[1]);
      if (!Number.isSafeInteger(pr) || pr <= 0) continue;
      const list = refs.get(pr) ?? [];
      list.push(ref);
      refs.set(pr, list);
    }
    return refs;
  }

  /** Drop refs before the directory, retaining a discoverable retry on failure. */
  async remove(pr: number): Promise<void> {
    const refs = (await this.ownedPrRefs()).get(pr) ?? [];
    if (refs.length)
      await runOrThrow(this.run, "git", ["update-ref", "--stdin"], {
        cwd: this.basePath,
        input: refs.map((ref) => `delete ${ref}\n`).join(""),
      });
    const path = this.worktreePath(pr);
    if (existsSync(path)) {
      await this.run("git", ["worktree", "remove", "--force", path], { cwd: this.basePath });
      // Registry drift (or a path git never knew about): make sure it is gone.
      rmSync(path, { recursive: true, force: true });
    }
    if (existsSync(join(this.basePath, ".git"))) {
      await this.run("git", ["worktree", "prune"], { cwd: this.basePath });
    }
  }

  /** PR numbers with a wt/pr-<n> directory on disk. */
  listWorktreePrs(): number[] {
    if (!existsSync(this.wtRoot)) return [];
    return readdirSync(this.wtRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => /^pr-(\d+)$/.exec(e.name)?.[1])
      .filter((m): m is string => m !== undefined)
      .map(Number)
      .sort((a, b) => a - b);
  }

  /**
   * Stale cleanup at daemon start: directories and owned refs whose PR is
   * no longer open/known get removed, including interrupted prior cleanup.
   */
  async sweepStale(activePrs: Iterable<number>): Promise<number[]> {
    const active = new Set(activePrs);
    const removed: number[] = [];
    const candidates = new Set([...this.listWorktreePrs(), ...(await this.ownedPrRefs()).keys()]);
    for (const pr of [...candidates].sort((a, b) => a - b)) {
      if (active.has(pr)) continue;
      await this.remove(pr);
      removed.push(pr);
    }
    return removed;
  }
}
