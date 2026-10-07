// Worktree manager (spec §4, brief B3 step 1). One base clone of the app repo
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
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { ExecFn, ExecResult } from "./tmux.js";
import { nodeExec, runOrThrow } from "./tmux.js";

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
   * from `repo`'s basename the same way ("owner/name" ⇒ "name"). */
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
  for (const m of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm))
    out.push({ old_start: Number(m[1]), old_count: m[2] === undefined ? 1 : Number(m[2]) });
  return out;
}

/** How near an anchored line a change must land to count as touching it
 * (S6): a fix rarely edits only the one line a comment points at. */
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

const SHA_RE = /^[0-9a-f]{7,40}$/i;

/** What one round's worktree preparation established about the tree on disk. */
export interface WorktreeFacts {
  path: string;
  /** The sha the worktree is actually checked out at, resolved from the
   * just-fetched `refs/pull/<n>/head` — the authority for the round. */
  head_sha: string;
  /** Branch the PR targets; "" when the caller did not supply one. */
  base_ref: string;
  /** Tip of base_ref at fetch time; "" when no base_ref was fetched. */
  base_sha: string;
  /** merge-base(base_sha, head_sha); "" when unavailable. */
  merge_base: string;
}

export function cloneUrlFor(repo: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(repo) || repo.startsWith("git@") || repo.startsWith("/")
    ? repo
    : `https://github.com/${repo}.git`;
}

/** Fallback clone-dir derivation when the caller passes none: the repo's
 * basename, `.git` stripped — the same rule as `githubCloneDir`
 * (src/config.ts), duplicated here only so this module keeps zero config
 * imports. */
function repoBasename(repo: string): string {
  const tail = repo
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .split("/")
    .pop();
  return tail || "repo";
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
 * keep the base clone out of `git status` of the checkout it lives
 * in. The clone's name is per-install (`[github] clone_dir`, else the repo's
 * basename), so no tracked `.gitignore` line can name it; the rule goes into
 * the repository's LOCAL `info/exclude` instead — the same line
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

export class WorktreeManager {
  readonly root: string;
  readonly basePath: string;
  readonly wtRoot: string;
  private readonly cloneUrl: string;
  private readonly run: ExecFn;

  constructor(opts: WorktreeManagerOptions) {
    this.root = opts.root;
    this.basePath = join(opts.root, opts.cloneDir ?? repoBasename(opts.repo));
    this.wtRoot = join(opts.root, "wt");
    this.cloneUrl = opts.cloneUrl ?? cloneUrlFor(opts.repo);
    this.run = opts.run ?? nodeExec;
  }

  private git(args: string[], cwd = this.basePath): Promise<ExecResult> {
    return runOrThrow(this.run, "git", args, { cwd });
  }

  worktreePath(pr: number): string {
    return join(this.wtRoot, `pr-${pr}`);
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
    return `refs/qcr/pr-${pr}`;
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
   * The base fetch is not decoration. Before 2026-08-18 the base clone was
   * created once and only ever fetched `refs/pull/<n>/head`, so
   * `origin/master` stayed frozen at clone time — while `pass-data-safety` is
   * instructed to verify migration numbering and `dependencies` "against
   * master's current head", a P1 rule. That check was reading a snapshot that
   * could be weeks old, producing both false P1s and false clears.
   *
   * Both refspecs go in one `git fetch` so the two sides are as close to
   * simultaneous as git allows.
   */
  async ensureWorktree(pr: number, opts: { baseRef?: string } = {}): Promise<WorktreeFacts> {
    await this.ensureBaseClone();
    mkdirSync(this.wtRoot, { recursive: true });
    const base = opts.baseRef?.trim();
    const ref = this.prRef(pr);
    const refspecs = [`+refs/pull/${pr}/head:${ref}`];
    if (base) refspecs.push(`+refs/heads/${base}:${this.baseRef(base)}`);
    await this.git(["fetch", "--force", "origin", ...refspecs]);
    const head_sha = (await this.git(["rev-parse", ref])).stdout.trim();
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
    return { path, head_sha, base_ref: base ?? "", base_sha, merge_base };
  }

  /**
   * Materialise wt/pr-<n> at an ALREADY-FETCHED sha, without touching the
   * network. This is what keeps the round prompt honest: the sha is resolved
   * once, in ensureWorktree, and every later step checks out that exact sha
   * instead of re-fetching and silently landing on a newer head.
   */
  async checkoutAt(pr: number, sha: string): Promise<string> {
    await this.ensureBaseClone();
    mkdirSync(this.wtRoot, { recursive: true });
    const path = this.worktreePath(pr);
    if (existsSync(path)) {
      await this.git(["reset", "--hard", sha], path);
      await this.git(["clean", "-fdx"], path);
    } else {
      await this.git(["worktree", "add", "--detach", path, sha]);
    }
    return path;
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
    // A sha this reader cannot use THROWS rather than returning []: an empty
    // list is indistinguishable from "the base has no migrations", which would
    // make the pre-check silently find nothing — the one failure mode
    // hard constraint forbids ("more reliable, never quieter"). The caller
    // catches it and logs `migration_precheck_failed`.
    if (!/^[0-9a-f]{7,40}$/i.test(sha))
      throw new Error(`listMigrationFiles: not a commit sha: ${sha}`);
    const res = await this.git(["ls-tree", "-r", "--name-only", sha]);
    return res.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /(^|\/)migrations\/[^/]+\.py$/.test(l));
  }

  /**
   * Files whose content in a merge commit differs from git's own auto-merge
   * of that merge's parents — i.e. files a human (or their agent) resolved by
   * hand (the owner, 2026-08-19: amendment — a CLEAN base merge stays a
   * trivial no-op, a conflict RESOLUTION is significant and gets reviewed for
   * the dropped-master-change bug).
   *
   * `git merge-tree --write-tree` (git ≥ 2.38) recomputes the auto-merge
   * without touching any worktree; on conflicts it exits 1 but still writes
   * the tree (with conflict-marker blobs), so diffing it against the merge
   * commit's real tree names exactly the hand-resolved paths.
   *
   * `degraded: true` means the answer is unknown (old git, missing objects) —
   * the caller decides what that costs; this reader never guesses.
   */
  async resolvedFilesInMerges(
    from: string,
    to: string,
    pr?: number,
  ): Promise<{ files: string[]; degraded: boolean }> {
    if (!/^[0-9a-f]{7,40}$/i.test(from) || !/^[0-9a-f]{7,40}$/i.test(to))
      return { files: [], degraded: true };
    try {
      // A recheck classifies a push minutes after it lands — usually before
      // any round has fetched the new objects into the base clone, which
      // degraded EVERY live recheck (2026-08-19 anomaly storm). Fetch on
      // miss: by sha first (GitHub serves reachable want-shas), then the PR
      // ref as the reliable route for PR-branch heads.
      const missing = async () => {
        const out: string[] = [];
        for (const sha of [from, to]) if (!(await this.hasCommit(sha))) out.push(sha);
        return out;
      };
      let gone = await missing();
      if (gone.length) {
        await this.run("git", ["fetch", "--force", "origin", ...gone], { cwd: this.basePath });
        gone = await missing();
      }
      if (gone.length && pr !== undefined) {
        await this.run(
          "git",
          ["fetch", "--force", "origin", `+refs/pull/${pr}/head:${this.prRef(pr)}`],
          { cwd: this.basePath },
        );
        gone = await missing();
      }
      if (gone.length) return { files: [], degraded: true };
      const merges = (await this.git(["rev-list", "--merges", `${from}..${to}`])).stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const files = new Set<string>();
      for (const m of merges) {
        const parents = (await this.git(["rev-list", "--parents", "-n", "1", m])).stdout
          .trim()
          .split(/\s+/)
          .slice(1);
        if (parents.length !== 2) continue; // octopus/odd merges: skip, stay honest below
        // merge-tree exits 1 on conflicts while still printing the tree oid —
        // run unchecked and read the first line.
        const mt = await this.run("git", ["merge-tree", "--write-tree", parents[0]!, parents[1]!], {
          cwd: this.basePath,
        });
        const tree = (mt.stdout.split("\n")[0] ?? "").trim();
        if (!/^[0-9a-f]{40,64}$/.test(tree)) return { files: [...files], degraded: true };
        const diff = await this.git(["diff", "--name-only", tree, `${m}^{tree}`]);
        for (const f of diff.stdout
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean))
          files.add(f);
      }
      return { files: [...files], degraded: false };
    } catch {
      return { files: [], degraded: true };
    }
  }

  /**
   * The most recent HUMAN author of `paths` in the history reachable from
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
    if (!/^[0-9a-f]{7,40}$/i.test(sha) || paths.length === 0) return null;
    const bots = new Set((opts.botLogins ?? []).map((b) => b.toLowerCase()));
    const res = await this.git(["log", "--format=%ae%x09%an", sha, "--", ...paths]);
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

  /** Memo for `anchorTouched`: a diff between two commits never changes. */
  private readonly hunkMemo = new Map<string, DiffHunk[]>();
  /** Commits `anchorTouched` has seen in the clone (only a present one is
   * remembered: a missing one may be fetched by the next round). */
  private readonly presentCommits = new Set<string>();
  /** Memo for `pathAt`, over commits known present: a tree never changes. */
  private readonly pathMemo = new Map<string, boolean>();
  /** Memo for `introducedBetween` — definite answers only. */
  private readonly betweenMemo = new Map<string, boolean>();

  /**
   * Did the change from `from` to `to` touch `path` within `window` lines of
   * `line`, on the `from` side (S6, outcome capture: "the code at the
   * finding's anchor changed")? Read-only git in the base clone, no fetch:
   * a commit the clone does not hold makes the answer unknown (`null`), never
   * a guess — and so does a `path` that `from` does not hold (a LEFT-side
   * anchor on a file the PR deletes, an imprecise body-only path): an empty
   * diff of a file that is not there proves nothing about an anchor in it.
   * A file `to` deletes is touched. Answers are memoised — commits are
   * immutable.
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
          const res = await this.git([
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
          hunks = parseDiffHunks(res.stdout);
        }
      } catch {
        return null;
      }
      if (this.hunkMemo.size >= 5000) this.hunkMemo.clear();
      this.hunkMemo.set(key, hunks);
    }
    return hunksTouchLine(hunks, line, window);
  }

  /**
   * Is `sha` a commit that `to` contains and `from` does not — a commit made
   * after the head a finding was raised at, and part of the PR since (
   * S6: a human reply citing "Fixed in <sha>" counts only when the sha is
   * such a commit, so a UUID segment, a colour or the commit that introduced
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
      if (this.betweenMemo.size >= 5000) this.betweenMemo.clear();
      this.betweenMemo.set(key, answer);
      return answer;
    } catch {
      return null;
    }
  }

  /** `hasCommit`, remembering a present commit. */
  private async present(sha: string): Promise<boolean> {
    if (this.presentCommits.has(sha)) return true;
    if (!(await this.hasCommit(sha))) return false;
    if (this.presentCommits.size >= 5000) this.presentCommits.clear();
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
    if (this.pathMemo.size >= 5000) this.pathMemo.clear();
    this.pathMemo.set(key, answer);
    return answer;
  }

  /** `git merge-base --is-ancestor`: 0 yes, 1 no, anything else unknown. */
  private async isAncestor(a: string, b: string): Promise<boolean | null> {
    const res = await this.run("git", ["merge-base", "--is-ancestor", a, b], {
      cwd: this.basePath,
    });
    return res.code === 0 ? true : res.code === 1 ? false : null;
  }

  /** True when `sha` is present in the base clone (no fetch needed). */
  async hasCommit(sha: string): Promise<boolean> {
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) return false;
    const res = await this.run("git", ["cat-file", "-e", `${sha}^{commit}`], {
      cwd: this.basePath,
    });
    return res.code === 0;
  }

  /** Re-fetch + reset an existing worktree (round refresh); creates if absent. */
  async refresh(pr: number, opts: { baseRef?: string } = {}): Promise<WorktreeFacts> {
    return this.ensureWorktree(pr, opts);
  }

  async headSha(pr: number): Promise<string> {
    const res = await this.git(["rev-parse", "HEAD"], this.worktreePath(pr));
    return res.stdout.trim();
  }

  /** Drop a worktree at PR close: remove --force, then prune. */
  async remove(pr: number): Promise<void> {
    const path = this.worktreePath(pr);
    if (existsSync(path)) {
      await this.run("git", ["worktree", "remove", "--force", path], { cwd: this.basePath });
      // Registry drift (or a path git never knew about): make sure it is gone.
      rmSync(path, { recursive: true, force: true });
    }
    if (existsSync(join(this.basePath, ".git"))) {
      await this.run("git", ["worktree", "prune"], { cwd: this.basePath });
      await this.run("git", ["update-ref", "-d", this.prRef(pr)], { cwd: this.basePath });
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
   * Stale-worktree sweep at daemon start (ported preflight): every wt/pr-*
   * whose PR is no longer open/known gets removed.
   */
  async sweepStale(activePrs: Iterable<number>): Promise<number[]> {
    const active = new Set(activePrs);
    const removed: number[] = [];
    for (const pr of this.listWorktreePrs()) {
      if (active.has(pr)) continue;
      await this.remove(pr);
      removed.push(pr);
    }
    return removed;
  }
}
