// The PR-owned inter-round delta (follow-up rounds; docs/follow-up-rounds.md):
// what the author changed between two reviewed heads, read with git over a
// repository the caller names. Its parsers and types are pure; its reader runs
// git through an injected ExecFn. The daemon reads it over the base clone
// (`WorktreeManager.prOwnedDelta`), `qcr review` over the repo the person is
// standing in (src/reviewdelta.ts), and the planner (src/planner.ts) plans a
// follow-up round from it.
import { runOrThrow, type ExecFn } from "./execfn.js";
import { parseHunkHeader } from "./hunkheader.js";
import { gitDiffHeaderPaths, unquoteGitPath } from "./unifieddiff.js";

/** A commit sha, abbreviated or full. */
const SHA_RE = /^[0-9a-f]{7,40}$/i;

/** One changed run on the NEW side of a diff: `[start, count]`. `count > 0`
 * is lines `start … start+count-1` at the new head; `count === 0` is a
 * DELETION POINT after line `start` (0 = before the first line) — kept, zero
 * width, so a finding next to removed code still counts as touched. */
export type NewSideRange = [start: number, count: number];

/** What `parseNewSideRanges` read from one file's hunk text. */
export interface NewSideParse {
  ranges: NewSideRange[];
  additions: number;
  deletions: number;
  /** False when a hunk header promised lines the text did not deliver (or
   * the text held no hunk at all while it had content) — the caller then
   * scopes the whole file rather than trusting a partial read. */
  ok: boolean;
}

/**
 * The new-side changed ranges of one file's unified hunks (any context
 * size — `-U0` and `-U3` read the same). Pure. Each hunk is bounded by the
 * counts its `@@ -a,b +c,d @@` header promises, so a removed line whose text
 * starts `-- ` (an SQL comment) or `++` is read as the body line it is, never
 * as a file header. A contiguous run of `-`/`+` lines is one change: its
 * added lines are its range; a run with no added line is a deletion point
 * after the last new-side line before it.
 */
export function parseNewSideRanges(hunks: string): NewSideParse {
  const ranges: NewSideRange[] = [];
  let additions = 0;
  let deletions = 0;
  let ok = true;
  let sawHunk = false;
  let oldLeft = 0;
  let newLeft = 0;
  let newLine = 0;
  let runStart = -1;
  let runPlus = 0;
  let runMinus = false;
  const flush = () => {
    if (runPlus > 0) ranges.push([runStart, runPlus]);
    else if (runMinus) ranges.push([newLine - 1, 0]);
    runStart = -1;
    runPlus = 0;
    runMinus = false;
  };
  for (const line of hunks.split("\n")) {
    const inHunk = oldLeft > 0 || newLeft > 0;
    if (!inHunk) {
      flush();
      const h = parseHunkHeader(line);
      if (!h) continue;
      sawHunk = true;
      oldLeft = h.old_count;
      newLeft = h.new_count;
      // An empty new side names the line BEFORE the hunk.
      newLine = newLeft === 0 ? h.new_start + 1 : h.new_start;
      continue;
    }
    const ch = line[0];
    if (ch === "\\") continue; // "\ No newline at end of file"
    if (ch === "+") {
      if (newLeft === 0) {
        ok = false;
        oldLeft = newLeft = 0;
        continue;
      }
      if (runPlus === 0) runStart = newLine;
      runPlus += 1;
      additions += 1;
      newLine += 1;
      newLeft -= 1;
    } else if (ch === "-") {
      if (oldLeft === 0) {
        ok = false;
        oldLeft = newLeft = 0;
        continue;
      }
      runMinus = true;
      deletions += 1;
      oldLeft -= 1;
    } else if (ch === " " || line === "") {
      // `diff.suppressBlankEmpty` writes an empty context line as "".
      flush();
      newLine += 1;
      oldLeft = Math.max(0, oldLeft - 1);
      newLeft = Math.max(0, newLeft - 1);
    } else {
      ok = false;
      flush();
      oldLeft = newLeft = 0;
    }
  }
  if (oldLeft > 0 || newLeft > 0) ok = false; // a hunk cut short
  flush();
  if (!sawHunk && hunks.trim() !== "") ok = false;
  return { ranges, additions, deletions, ok };
}

/** One `diff --git` section of a patch, read for the delta. */
export interface PatchSection {
  /** The path at the new side; the old path for a deletion. Null when the
   * section names no path this reader can trust. */
  path: string | null;
  old_path: string | null;
  deleted: boolean;
  added: boolean;
  binary: boolean;
  /** A submodule pointer (mode 160000): no lines to scope. */
  gitlink: boolean;
  /** Executable/type mode metadata changed, independent of any line hunks. */
  mode_changed?: true;
  /** The hunk text from the first `@@` on — GitHub's `patch` shape. */
  hunks: string;
}

/** A `---`/`+++`/`rename to` path: the trailing tab git appends to a path
 * with a space dropped, the quoting undone, the `a/`/`b/` prefix removed. */
export function sectionPath(raw: string, prefix: "a/" | "b/" | ""): string | null {
  const p = unquoteGitPath(raw.replace(/\t$/, ""));
  if (p === null) return null;
  if (prefix === "") return p;
  return p.startsWith(prefix) ? p.slice(prefix.length) : null;
}

/** Split `git diff` patch output (explicit `a/`/`b/` prefixes) into its
 * file sections. Pure. Inside a section only the lines before its first
 * `@@` are headers — a removed `-- comment` line is never read as one. */
export function parsePatchSections(diff: string): PatchSection[] {
  const out: PatchSection[] = [];
  const lines = diff.split("\n");
  let i = 0;
  while (i < lines.length) {
    const head = lines[i]!;
    if (!head.startsWith("diff --git ")) {
      i += 1;
      continue;
    }
    const hp = gitDiffHeaderPaths(head.slice("diff --git ".length));
    let minus: string | null | undefined;
    let plus: string | null | undefined;
    let renameFrom: string | null = null;
    let renameTo: string | null = null;
    let deleted = false;
    let added = false;
    let binary = false;
    let gitlink = false;
    let modeChanged = false;
    i += 1;
    while (
      i < lines.length &&
      !lines[i]!.startsWith("@@") &&
      !lines[i]!.startsWith("diff --git ")
    ) {
      const l = lines[i]!;
      if (l.startsWith("--- "))
        minus = l === "--- /dev/null" ? null : sectionPath(l.slice(4), "a/");
      else if (l.startsWith("+++ "))
        plus = l === "+++ /dev/null" ? null : sectionPath(l.slice(4), "b/");
      else if (l.startsWith("rename from ") || l.startsWith("copy from "))
        renameFrom = sectionPath(l.slice(l.indexOf(" from ") + 6), "");
      else if (l.startsWith("rename to ") || l.startsWith("copy to "))
        renameTo = sectionPath(l.slice(l.indexOf(" to ") + 4), "");
      else if (l.startsWith("deleted file mode")) deleted = true;
      else if (l.startsWith("new file mode")) added = true;
      else if (l.startsWith("old mode ") || l.startsWith("new mode ")) modeChanged = true;
      else if (l.startsWith("Binary files ") || l === "GIT binary patch") binary = true;
      if (/ 160000$|^index [0-9a-f]+\.\.[0-9a-f]+ 160000$/.test(l)) gitlink = true;
      i += 1;
    }
    const body: string[] = [];
    while (i < lines.length && !lines[i]!.startsWith("diff --git ")) {
      body.push(lines[i]!);
      i += 1;
    }
    while (body.length && body[body.length - 1] === "") body.pop();
    const hunks = body.length ? body.join("\n") + "\n" : "";
    if (/^[-+]Subproject commit /m.test(hunks)) gitlink = true;
    const newPath = plus ?? renameTo ?? (plus === null ? null : hp.b);
    const oldPath = minus ?? renameFrom ?? (minus === null ? null : hp.a);
    out.push({
      path: deleted || plus === null ? (oldPath ?? hp.a) : (newPath ?? null),
      old_path: oldPath ?? null,
      deleted: deleted || plus === null,
      added: added || minus === null,
      binary,
      gitlink,
      ...(modeChanged ? { mode_changed: true as const } : {}),
      hunks,
    });
  }
  return out;
}

/** One `--name-status -z` entry. */
export interface NameStatusEntry {
  /** The status letter (`A`, `M`, `D`, `R`, `C`, `T`, …). */
  status: string;
  path: string;
  old_path?: string;
}

/** `git diff --name-status -z` output, read. Pure; null when it does not
 * parse (a path a rename/copy entry promised is missing, an unknown shape). */
export function parseNameStatusZ(out: string): NameStatusEntry[] | null {
  const tok = out.split("\0");
  if (tok[tok.length - 1] === "") tok.pop();
  const entries: NameStatusEntry[] = [];
  let i = 0;
  while (i < tok.length) {
    const st = tok[i]!;
    const m = /^([A-Z])\d*$/.exec(st);
    if (!m) return null;
    const letter = m[1]!;
    if (letter === "R" || letter === "C") {
      const from = tok[i + 1];
      const to = tok[i + 2];
      if (from === undefined || to === undefined) return null;
      entries.push({ status: letter, path: to, old_path: from });
      i += 3;
    } else {
      const p = tok[i + 1];
      if (p === undefined) return null;
      entries.push({ status: letter, path: p });
      i += 2;
    }
  }
  return entries;
}

/** The GitHub `status` spelling of a name-status letter, so a delta file
 * reads like a `PrFileEntry`. */
export function githubStatusOf(letter: string): string {
  switch (letter) {
    case "A":
      return "added";
    case "D":
      return "removed";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "M":
      return "modified";
    default:
      return "changed"; // T (type change), U, X, B
  }
}

/** One file of the PR-owned inter-round delta. */
export interface PrOwnedDeltaFile {
  /** The path at the new head (the old path for a deleted file). */
  path: string;
  /** The path at the replayed old head, when a rename/copy moved it. */
  old_path?: string;
  /** GitHub's spelling: added | modified | removed | renamed | copied | changed. */
  status: string;
  additions: number;
  deletions: number;
  /** Changed lines at the NEW head (see `NewSideRange`). */
  ranges: NewSideRange[];
  /** The whole file is in scope: deleted, binary, a submodule, a hunk text
   * this reader could not read, or a conflict resolution. `ranges` is then
   * a hint at most, never the bound. */
  whole_file: boolean;
  /** The file's `-U3` hunk text (GitHub's `patch` shape), "" when none. */
  patch: string;
  /** Replaying the reviewed head onto the new base conflicted here: the
   * author resolved it, so the file is audited against both parents. Its ranges and patch are the PR's own
   * `merge_base..head` hunks — the replayed side holds conflict markers and
   * is never diffed as content. */
  conflict?: true;
  binary?: true;
}

/** Why the delta could not be computed — the round then runs in full: every
 * unknown is a full round, never a quieter one. */
export type PrOwnedDeltaUnavailable =
  | "no-reviewed-head"
  | "no-merge-base"
  | "old-head-missing"
  | "base-rewound"
  | "merge-tree-failed"
  | "diff-failed";

export type PrOwnedDelta =
  | {
      ok: true;
      /** The synthetic tree: the reviewed head replayed onto `mergeBase`. */
      tree: string;
      files: PrOwnedDeltaFile[];
      /** additions + deletions over every file. */
      lines: number;
      /** Paths whose replay conflicted (each also a `conflict` file). */
      conflicted: string[];
    }
  | { ok: false; reason: PrOwnedDeltaUnavailable; detail?: string };

/** Join name-status entries with their patch sections into delta files.
 * Pure. An entry no section matches is scoped whole — never dropped. */
export function joinDeltaFiles(
  entries: readonly NameStatusEntry[],
  sections: readonly PatchSection[],
): PrOwnedDeltaFile[] {
  const byPath = new Map<string, PatchSection[]>();
  for (const s of sections) {
    if (s.path === null) continue;
    const list = byPath.get(s.path) ?? [];
    list.push(s);
    byPath.set(s.path, list);
  }
  return entries.map((e) => {
    const secs = byPath.get(e.path) ?? [];
    const hunks = secs.map((s) => s.hunks).join("");
    const parse = parseNewSideRanges(hunks);
    const binary = secs.some((s) => s.binary);
    const gitlink = secs.some((s) => s.gitlink);
    const modeChanged = secs.some((s) => s.mode_changed);
    const deleted = e.status === "D";
    // A rename/copy with no content change has a section and no hunks: no
    // lines, but the section is what proves it was read.
    const unread = secs.length === 0 || !parse.ok;
    const typeChange = e.status === "T" || secs.length > 1;
    const file: PrOwnedDeltaFile = {
      path: e.path,
      status: githubStatusOf(e.status),
      additions: parse.additions,
      deletions: parse.deletions,
      ranges: parse.ranges,
      whole_file: deleted || binary || gitlink || modeChanged || unread || typeChange,
      patch: binary ? "" : hunks,
    };
    if (e.old_path !== undefined) file.old_path = e.old_path;
    if (binary) file.binary = true;
    return file;
  });
}

/** Delta files as the `PrFileEntry` shape the plan heuristics and
 * `classifyDelta` read. */
export function deltaAsPrFiles(files: readonly PrOwnedDeltaFile[]): Array<{
  filename: string;
  additions: number;
  deletions: number;
  status: string;
  patch?: string;
  previous_filename?: string;
}> {
  return files.map((f) => ({
    filename: f.path,
    additions: f.additions,
    deletions: f.deletions,
    status: f.status,
    ...(f.patch !== "" ? { patch: f.patch } : {}),
    ...(f.old_path !== undefined ? { previous_filename: f.old_path } : {}),
  }));
}

/** The repository the delta is read in, and the git reads the reader needs
 * beyond plain commands. `WorktreeManager` implements it over the base clone
 * (memoised, fetching on miss); `gitDeltaRepo` is the plain one. */
export interface DeltaRepo {
  run: ExecFn;
  /** The repository's working directory: every git runs here. */
  cwd: string;
  /** Is the commit present (no fetch)? */
  hasCommit(sha: string): Promise<boolean>;
  /** The commits of `shas` still missing after fetching them on miss. */
  fetchMissing(shas: readonly string[], pr?: number): Promise<string[]>;
  /** Does the (present) commit `sha` hold `path`? */
  pathAt(sha: string, path: string): Promise<boolean>;
}

/** The local ref PR `pr`'s head is fetched into. */
export function prFetchRef(pr: number): string {
  return `refs/qcr/pr-${pr}`;
}

/** True when `sha` is present in the repository at `cwd` (no fetch). */
export async function gitHasCommit(run: ExecFn, cwd: string, sha: string): Promise<boolean> {
  if (!SHA_RE.test(sha)) return false;
  const res = await run("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd });
  return res.code === 0;
}

/** `git merge-base --is-ancestor`: true yes, false no, null unknown. */
export async function gitIsAncestor(
  run: ExecFn,
  cwd: string,
  a: string,
  b: string,
): Promise<boolean | null> {
  const res = await run("git", ["merge-base", "--is-ancestor", a, b], { cwd });
  return res.code === 0 ? true : res.code === 1 ? false : null;
}

/**
 * The commits of `shas` the repository still lacks after fetching them on
 * miss: by sha first (GitHub serves a reachable want-sha), then PR `pr`'s head
 * ref, the reliable route for PR-branch heads. A fetch that fails is no
 * throw — the answer is what is still missing.
 */
export async function fetchMissingCommits(
  repo: Pick<DeltaRepo, "run" | "cwd" | "hasCommit">,
  shas: readonly string[],
  pr?: number,
): Promise<string[]> {
  const missing = async () => {
    const out: string[] = [];
    for (const sha of shas) if (!(await repo.hasCommit(sha))) out.push(sha);
    return out;
  };
  let gone = await missing();
  if (gone.length) {
    await repo.run("git", ["fetch", "--force", "origin", ...gone], { cwd: repo.cwd });
    gone = await missing();
  }
  if (gone.length && pr !== undefined && Number.isInteger(pr) && pr > 0) {
    const refspec = `+refs/pull/${pr}/head:${prFetchRef(pr)}`;
    await repo.run("git", ["fetch", "--force", "origin", refspec], { cwd: repo.cwd });
    gone = await missing();
  }
  return gone;
}

/** The plain `DeltaRepo` over the repository at `cwd`: no memo, and a
 * missing commit is fetched through `run` like any other git. */
export function gitDeltaRepo(run: ExecFn, cwd: string): DeltaRepo {
  const repo: DeltaRepo = {
    run,
    cwd,
    hasCommit: (sha) => gitHasCommit(run, cwd, sha),
    fetchMissing: (shas, pr) => fetchMissingCommits(repo, shas, pr),
    pathAt: async (sha, path) =>
      (await run("git", ["cat-file", "-e", `${sha}:${path}`], { cwd })).code === 0,
  };
  return repo;
}

/**
 * The PR-owned change between two reviewed heads (follow-up rounds;
 * `docs/follow-up-rounds.md`): the reviewed head `from` is replayed
 * onto the content the new head `to` actually builds on (`mergeBase`, the
 * round's own `merge_base`) with `git merge-tree`, and that synthetic tree
 * is diffed against `to`. Base content cancels out — a clean master merge
 * (with or without a merge commit) and a rebase leave only what the author
 * changed — while a master change the author dropped shows as a hunk, and
 * a replay that conflicts names its paths, scoped whole and tagged for the
 * both-parents audit. Ranges are at `to`'s line numbers, keyed by the new
 * path.
 *
 * Read-only towards every ref but the PR's own fetch ref; merge-tree writes
 * tree and blob objects into the repository's store, as the worktree
 * manager's `resolvedFilesInMerges` does. Every step is an async child
 * process. Total: any unknown is `{ok:false, reason}` and the caller runs the
 * full round — this reader never returns a partial delta.
 *
 * `baseSha` (the base branch tip the round fetched) makes the base check
 * real: the base content the reviewed head held must still be under
 * `mergeBase`, else the author rebased onto an older base (or un-merged
 * master) and the replay would read base drift as the PR's — `base-rewound`.
 * `fromMergeBase` (the merge base the reviewed round recorded), when known,
 * catches a force-pushed base the same way.
 */
export async function readPrOwnedDelta(
  repo: DeltaRepo,
  q: {
    pr: number;
    from: string;
    to: string;
    mergeBase: string;
    baseSha?: string;
    fromMergeBase?: string;
  },
): Promise<PrOwnedDelta> {
  const fail = (reason: PrOwnedDeltaUnavailable, detail?: string): PrOwnedDelta =>
    detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };
  const git = (args: string[]) => runOrThrow(repo.run, "git", args, { cwd: repo.cwd });
  const isAncestor = (a: string, b: string) => gitIsAncestor(repo.run, repo.cwd, a, b);
  if (!SHA_RE.test(q.from ?? "")) return fail("no-reviewed-head");
  if (!SHA_RE.test(q.mergeBase ?? "")) return fail("no-merge-base");
  if (!SHA_RE.test(q.to ?? "")) return fail("diff-failed", "head is not a sha");
  try {
    for (const sha of [q.to, q.mergeBase])
      if (!(await repo.hasCommit(sha))) return fail("diff-failed", `${sha} not in the clone`);
    // Fetch on miss, as resolvedFilesInMerges.
    if ((await repo.fetchMissing([q.from], q.pr)).length) return fail("old-head-missing");

    // 1. The base may only have moved forward between the two reviews.
    const anchor =
      q.baseSha && SHA_RE.test(q.baseSha) && (await repo.hasCommit(q.baseSha))
        ? q.baseSha
        : q.mergeBase;
    const b0 = await repo.run("git", ["merge-base", q.from, anchor], { cwd: repo.cwd });
    if (b0.code === 1) return fail("base-rewound", "no common history");
    if (b0.code !== 0) return fail("diff-failed", "merge-base");
    const b0sha = b0.stdout.trim();
    const forward = await isAncestor(b0sha, q.mergeBase);
    if (forward === null) return fail("diff-failed", "is-ancestor");
    if (!forward) return fail("base-rewound");
    if (q.fromMergeBase) {
      if (!SHA_RE.test(q.fromMergeBase)) return fail("base-rewound", "recorded base unusable");
      const kept = await isAncestor(q.fromMergeBase, q.mergeBase);
      if (kept !== true) return fail("base-rewound", "recorded base not under the new base");
    }

    // 2. The reviewed PR replayed onto the base content `to` has.
    let tree: string;
    const conflicted: string[] = [];
    const onBase = await isAncestor(q.mergeBase, q.from);
    if (onBase === null) return fail("diff-failed", "is-ancestor");
    if (onBase) {
      tree = (await git(["rev-parse", `${q.from}^{tree}`])).stdout.trim();
    } else {
      const mt = await repo.run(
        "git",
        ["merge-tree", "--write-tree", "-z", "--name-only", "--no-messages", q.from, q.mergeBase],
        { cwd: repo.cwd },
      );
      if (mt.code !== 0 && mt.code !== 1) {
        const cause = mt.stderr.trim().slice(0, 500);
        return fail("merge-tree-failed", `exit ${mt.code}${cause ? `: ${cause}` : ""}`);
      }
      const tok = mt.stdout.split("\0");
      tree = (tok[0] ?? "").trim();
      if (mt.code === 1)
        for (const p of tok.slice(1)) if (p !== "" && !conflicted.includes(p)) conflicted.push(p);
      if (mt.code === 1 && conflicted.length === 0)
        return fail("merge-tree-failed", "conflict without a path");
    }
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(tree)) return fail("merge-tree-failed", "no tree");

    // 3. The delta, at new-head line numbers.
    const conflictSet = new Set(conflicted);
    const read = async (from: string, paths?: string[]) => {
      const diff = [
        "--literal-pathspecs",
        "-c",
        "core.quotePath=false",
        "-c",
        "diff.noprefix=false",
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--no-relative",
        "--submodule=short",
        "-M",
      ];
      const spec = paths ? ["--", ...paths] : [];
      const ns = await git([...diff, "-z", "--name-status", from, q.to, ...spec]);
      const patch = await git([
        ...diff,
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "-U3",
        from,
        q.to,
        ...spec,
      ]);
      const entries = parseNameStatusZ(ns.stdout);
      if (entries === null) return null;
      return joinDeltaFiles(entries, parsePatchSections(patch.stdout));
    };
    const delta = await read(tree);
    if (delta === null) return fail("diff-failed", "name-status");
    const files = delta.filter((f) => !conflictSet.has(f.path));
    // A rename out of a conflicted path was compared against marker blobs.
    for (const f of files) if (f.old_path && conflictSet.has(f.old_path)) f.whole_file = true;
    if (conflicted.length) {
      // Never diff marker blobs as content: a conflicted file's scope is
      // the PR's own hunks for it, whole-file, for the both-parents audit.
      const own = await read(q.mergeBase, conflicted);
      if (own === null) return fail("diff-failed", "name-status (conflicts)");
      for (const p of conflicted) {
        const f: PrOwnedDeltaFile = own.find((o) => o.path === p) ?? {
          path: p,
          status: (await repo.pathAt(q.to, p)) ? "modified" : "removed",
          additions: 0,
          deletions: 0,
          ranges: [],
          whole_file: true,
          patch: "",
        };
        f.whole_file = true;
        f.conflict = true;
        files.push(f);
      }
    }
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const lines = files.reduce((n, f) => n + f.additions + f.deletions, 0);
    return { ok: true, tree, files, lines, conflicted };
  } catch (err) {
    return fail("diff-failed", err instanceof Error ? err.message.slice(0, 200) : String(err));
  }
}
