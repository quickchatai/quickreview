// Committing setup's profile writes when the config home is a git repo.
//
// Why a request and not a commit. Setup's tools run in the companion
// container, which mounts only `profiles/` and `portrait/` of the config home
// — never the home whole, because it holds `secrets/` (root rule 8) — so the
// home's `.git` is out of its reach by design. A profile write therefore
// leaves a request in the state home
// (`setup/commits/<id>.request.json`: the paths it wrote and a message), and
// the operator's own machine carries it out: the TUI on its config-mirror
// timer, and `qcr setup commit`. The answer lands beside it
// (`<id>.result.json`), where the companion's `setup_profile` reads it.
//
// What it will commit, and where. Only paths under `profiles/` — the request
// is data the container wrote, so a path is checked before git ever sees it
// (no `..`, no absolute path, nothing else in the home) — and only in a config
// home that is its own repository: a home that merely sits inside a bigger
// one (a dotfiles repo over `~/.config`) is reported, not committed into.
// `git commit -- <paths>` takes those paths alone, so nothing else staged in
// the home — least of all `secrets/` — rides along. Not a repo is an ordinary
// answer ("not-a-repo"), not a failure: a config home is a git repo only if
// the operator made it one.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { PROFILES_DIR } from "../install.js";

/** Where requests and results live, relative to the state home. */
export const COMMITS_DIR = "setup/commits";

export interface CommitRequest {
  id: string;
  requested_at: string;
  profile: string;
  /** Config-home-relative paths the write touched. */
  paths: string[];
  message: string;
}

export type CommitState = "committed" | "nothing-to-commit" | "not-a-repo" | "refused" | "failed";

export interface CommitResult {
  id: string;
  at: string;
  state: CommitState;
  /** The commit, when one was made. */
  sha?: string;
  detail: string;
}

export const requestFile = (id: string): string => `${COMMITS_DIR}/${id}.request.json`;
export const resultFile = (id: string): string => `${COMMITS_DIR}/${id}.result.json`;

/** A commit id: a plain, sortable token (it names two files and a replay
 * baseline). Millisecond resolution, and `taken` — does a request or result
 * already carry this id? — moves a same-instant write to `_2`, `_3`, … so two
 * writes never share one id (a shared id would replace the first write's
 * baseline and let the second be skipped as already answered). */
export function commitId(
  now: Date,
  profile: string,
  taken: (id: string) => boolean = () => false,
): string {
  const stamp = now.toISOString().replace(/[-:.]/g, "").replace("T", "-").slice(0, 18);
  for (let n = 1; ; n++) {
    const id = `${stamp}${n === 1 ? "" : `_${n}`}-${profile}`;
    if (!taken(id)) return id;
  }
}

/** Why a requested path is not one this may commit, or null when it is. */
export function refusePath(path: unknown): string | null {
  if (typeof path !== "string" || path === "") return "a path is not a non-empty string";
  if (path.startsWith("/") || path.split("/").some((s) => s === ".." || s === "." || s === ""))
    return `${JSON.stringify(path)} is not a plain relative path`;
  if (!path.startsWith(`${PROFILES_DIR}/`))
    return `${JSON.stringify(path)} is outside ${PROFILES_DIR}/`;
  return null;
}

/** One git invocation in `cwd`: exit code and output, never a throw. */
export type GitRun = (
  args: string[],
  cwd: string,
) => { code: number; stdout: string; stderr: string };

export const realGit: GitRun = (args, cwd) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return {
    code: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? (r.error ? String(r.error) : ""),
  };
};

function parseRequest(text: string): CommitRequest | string {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return "the request is not JSON";
  }
  const r = (raw ?? {}) as Partial<CommitRequest>;
  if (
    typeof r.id !== "string" ||
    typeof r.message !== "string" ||
    r.message.trim() === "" ||
    !Array.isArray(r.paths) ||
    r.paths.length === 0
  ) {
    return "the request is not {id, message, paths}";
  }
  for (const p of r.paths) {
    const why = refusePath(p);
    if (why !== null) return why;
  }
  return {
    id: r.id,
    requested_at: typeof r.requested_at === "string" ? r.requested_at : "",
    profile: typeof r.profile === "string" ? r.profile : "",
    paths: r.paths,
    message: r.message,
  };
}

/** Is `configHome` the top of its own git work tree? */
function ownRepo(
  configHome: string,
  git: GitRun,
): { ok: true } | { ok: false; detail: string; failed?: boolean } {
  const top = git(["rev-parse", "--show-toplevel"], configHome);
  if (top.code !== 0)
    return {
      ok: false,
      detail: `git repository probe: ${(top.stderr || top.stdout).trim() || `exit ${top.code}`}`,
      failed: !/not a git repository/i.test(top.stderr || top.stdout),
    };
  let same = false;
  try {
    same = realpathSync(top.stdout.trim()) === realpathSync(configHome);
  } catch {
    same = false;
  }
  return same
    ? { ok: true }
    : {
        ok: false,
        detail: `${configHome} sits inside ${top.stdout.trim()}, not in a repository of its own — not committed into it`,
      };
}

function commitOne(
  req: CommitRequest,
  configHome: string,
  git: GitRun,
): Omit<CommitResult, "id" | "at"> {
  const repo = ownRepo(configHome, git);
  if (!repo.ok) return { state: repo.failed ? "failed" : "not-a-repo", detail: repo.detail };
  const add = git(["add", "-A", "--", ...req.paths], configHome);
  if (add.code !== 0)
    return { state: "failed", detail: `git add: ${(add.stderr || add.stdout).trim()}` };
  const staged = git(["diff", "--cached", "--quiet", "--", ...req.paths], configHome);
  if (staged.code === 0)
    return { state: "nothing-to-commit", detail: "the committed profile already matches" };
  const commit = git(["commit", "--no-verify", "-m", req.message, "--", ...req.paths], configHome);
  if (commit.code !== 0)
    return { state: "failed", detail: `git commit: ${(commit.stderr || commit.stdout).trim()}` };
  const sha = git(["rev-parse", "HEAD"], configHome).stdout.trim();
  return { state: "committed", sha, detail: `committed ${req.paths.join(", ")}` };
}

/**
 * Carry out every pending request (one without a result), oldest first, and
 * write each one's result. Host-side only — it needs the config home whole.
 * Total: a missing directory is no requests; a malformed request is answered
 * "refused" and never retried. A request whose git step FAILED (an index
 * lock, a signing agent away) is carried out again only with `retryFailed` —
 * the operator's `qcr setup commit`, run once the cause is cleared — so a
 * standing failure is not re-run, and re-announced, on every timer tick.
 */
export function processProfileCommits(opts: {
  stateHome: string;
  configHome: string;
  git?: GitRun;
  clock?: () => Date;
  retryFailed?: boolean;
}): CommitResult[] {
  const git = opts.git ?? realGit;
  const clock = opts.clock ?? (() => new Date());
  const dir = join(opts.stateHome, COMMITS_DIR);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  // One processor at a time (the TUI's mirror timer and `qcr setup commit`
  // both run this): a second pass would re-answer a request the first just
  // committed and publish "nothing-to-commit" over its sha. A lock older than
  // PROCESS_LOCK_STALE_MS is a dead holder's and is taken over.
  const lock = join(dir, PROCESS_LOCK);
  if (!takeLock(lock, clock())) return [];
  try {
    return processLocked(
      dir,
      names,
      opts.stateHome,
      opts.configHome,
      git,
      clock,
      opts.retryFailed === true,
    );
  } finally {
    rmSync(lock, { force: true });
  }
}

const PROCESS_LOCK = ".processing.lock";
const PROCESS_LOCK_STALE_MS = 10 * 60 * 1000;

function takeLock(path: string, now: Date): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, `${process.pid} ${now.toISOString()}\n`, { flag: "wx" });
      return true;
    } catch {
      let age: number;
      try {
        age = Date.now() - statSync(path).mtimeMs;
      } catch {
        continue; // released between the two calls: try again
      }
      if (age < PROCESS_LOCK_STALE_MS) return false;
      rmSync(path, { force: true });
    }
  }
  return false;
}

/** The state a written result records, or null when it cannot be read. */
function answeredState(path: string): CommitState | null {
  try {
    const r = JSON.parse(readFileSync(path, "utf8")) as Partial<CommitResult>;
    return typeof r.state === "string" ? r.state : null;
  } catch {
    return null;
  }
}

function processLocked(
  dir: string,
  names: string[],
  stateHome: string,
  configHome: string,
  git: GitRun,
  clock: () => Date,
  retryFailed: boolean,
): CommitResult[] {
  const done: CommitResult[] = [];
  for (const name of names.filter((n) => n.endsWith(".request.json")).sort()) {
    const id = name.slice(0, -".request.json".length);
    // Re-read, not the listing: a result may have landed since it was taken.
    const priorResult = join(stateHome, resultFile(id));
    if (names.includes(basename(priorResult)) || existsSync(priorResult)) {
      if (!retryFailed || answeredState(priorResult) !== "failed") continue;
    }
    let text: string;
    try {
      text = readFileSync(join(dir, name), "utf8");
    } catch {
      continue; // mid-write or unreadable: the next pass sees it
    }
    const req = parseRequest(text);
    const outcome =
      typeof req === "string"
        ? { state: "refused" as const, detail: req }
        : req.id !== id
          ? {
              state: "refused" as const,
              detail: `the request's id ${JSON.stringify(req.id)} is not its file's`,
            }
          : commitOne(req, configHome, git);
    const result: CommitResult = { id, at: clock().toISOString(), ...outcome };
    const target = join(stateHome, resultFile(id));
    mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(result, null, 2)}\n`);
    renameSync(tmp, target);
    done.push(result);
  }
  return done;
}
