// The companion's read-only reach into GitHub.
//
// Setup reads a repo's review history and a scan looks things up, so the
// companion holds a GitHub credential — and rule 8 still says it never
// writes to GitHub. Both hold because of what it holds:
//
//  * A down-scoped installation token, minted here, on the host, from the App
//    credential the host already has. The request names the permissions it
//    wants (`COMPANION_GITHUB_PERMISSIONS`: contents / issues / pull requests,
//    each `read`) and the one repository, and GitHub signs a token that can
//    do exactly that. The grant GitHub reports back is checked again before
//    the token is handed over: anything that is not `read` is refused, so an
//    App whose permissions changed can never widen what the companion holds.
//  * It is handed over as an env file in a directory the companion mounts
//    read-only (`CONTAINER.githubRead`), never as an argv value and never as
//    a docker `--env`: the token lives an hour, so the host re-mints it into
//    the same file before it expires, and a container env var would be
//    frozen at creation. The App's private key never leaves the host — the
//    config home's `secrets/` is not mounted (see CONTAINER.configHome).
//
// The variable is deliberately not `GH_TOKEN` / `GITHUB_TOKEN`: nothing in the
// container picks it up on its own, so every use of it is an explicit read.
// `companion-guard` additionally vetoes write-shaped calls against the API
// (belt); the token's own scope is the brace.
//
// Everything here is total at the edge the TUI calls: `refresh()` answers an
// outcome, never throws — a companion without GitHub is under-equipped, never
// a companion that does not start.
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { mintAppJwt, type FetchFn } from "../githubAuth.js";

/** The only permissions the companion's token is ever minted with. */
export const COMPANION_GITHUB_PERMISSIONS: Readonly<Record<string, "read">> = Object.freeze({
  contents: "read",
  issues: "read",
  pull_requests: "read",
});

/** GitHub adds `metadata: read` to every installation token on its own. */
const IMPLICIT_PERMISSIONS = new Set(["metadata"]);

export const TOKEN_FILE = "github-read.env";
export const TOKEN_VAR = "QCR_GITHUB_READ_TOKEN";
export const EXPIRES_VAR = "QCR_GITHUB_READ_EXPIRES_AT";
export const REPO_VAR = "QCR_GITHUB_REPO";

/** Each GitHub call is bounded: the mint runs in the companion bring-up,
 * ahead of the container, and a hung API must cost seconds, not the start. */
export const FETCH_TIMEOUT_MS = 15_000;

/** Re-mint when less than this is left; GitHub tokens live an hour. */
export const REFRESH_MARGIN_MS = 15 * 60 * 1000;
/** How often the host checks. Well inside the margin, so a slow or failed
 * mint gets two more tries before the old token lapses. */
export const CHECK_EVERY_MS = 5 * 60 * 1000;

export interface ReadToken {
  token: string;
  expires_at: string;
  permissions: Record<string, string>;
}

/**
 * Why a reported grant is NOT read-only, or undefined when it is. Every key
 * must be one we asked for (or GitHub's implicit `metadata`), and every value
 * exactly `read`.
 */
export function readOnlyGrantProblem(perms: unknown): string | undefined {
  if (typeof perms !== "object" || perms === null || Array.isArray(perms))
    return "GitHub reported no permissions for the token";
  const entries = Object.entries(perms as Record<string, unknown>);
  if (entries.length === 0) return "GitHub reported an empty grant";
  for (const [name, level] of entries) {
    if (!(name in COMPANION_GITHUB_PERMISSIONS) && !IMPLICIT_PERMISSIONS.has(name))
      return `the grant carries ${name}=${String(level)}, which was never asked for`;
    if (level !== "read")
      return `the grant carries ${name}=${String(level)} — only read is allowed`;
  }
  return undefined;
}

/** owner/name, each segment a GitHub name that cannot start with a dot — so
 * `..` can never walk the API path. */
const REPO_RE = /^([A-Za-z0-9_-][A-Za-z0-9_.-]*)\/([A-Za-z0-9_-][A-Za-z0-9_.-]*)$/;

/** Mint a read-only token for ONE repository, JWT-authed as the App. Throws
 * with a reason (never a secret) on any failure, including a grant that came
 * back wider than read. */
export async function mintReadOnlyToken(opts: {
  appId: string;
  pem: string;
  repo: string;
  fetchFn?: FetchFn;
  apiBase?: string;
  now?: () => number;
}): Promise<ReadToken> {
  const m = REPO_RE.exec(opts.repo);
  if (!m) throw new Error(`[github] repo ${JSON.stringify(opts.repo)} is not owner/name`);
  const [, owner, name] = m as unknown as [string, string, string];
  const fetchFn = opts.fetchFn ?? fetch;
  const api = opts.apiBase ?? "https://api.github.com";
  const headers = {
    authorization: `Bearer ${mintAppJwt(opts.appId, opts.pem, opts.now)}`,
    accept: "application/vnd.github+json",
  };
  const inst = await fetchFn(`${api}/repos/${owner}/${name}/installation`, {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!inst.ok) throw new Error(`GET /repos/${owner}/${name}/installation failed: ${inst.status}`);
  const id = ((await inst.json()) as { id?: unknown }).id;
  if (typeof id !== "number") throw new Error("the installation lookup returned no id");
  const res = await fetchFn(`${api}/app/installations/${id}/access_tokens`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ repositories: [name], permissions: COMPANION_GITHUB_PERMISSIONS }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`read-only token mint failed: ${res.status}`);
  const body = (await res.json()) as {
    token?: unknown;
    expires_at?: unknown;
    permissions?: unknown;
    repositories?: unknown;
  };
  const problem = readOnlyGrantProblem(body.permissions);
  if (problem) throw new Error(`refused the minted token: ${problem}`);
  if (Array.isArray(body.repositories)) {
    const other = body.repositories
      .map((r) => (r as { name?: unknown }).name)
      .find((n) => n !== name);
    if (other !== undefined)
      throw new Error(`refused the minted token: it reaches ${String(other)}, not only ${name}`);
  }
  if (typeof body.token !== "string" || typeof body.expires_at !== "string")
    throw new Error("the token mint returned no token");
  return {
    token: body.token,
    expires_at: body.expires_at,
    permissions: body.permissions as Record<string, string>,
  };
}

/**
 * What a token may be made of to go into the env file. It is GitHub's token
 * alphabet: an installation token is `ghs_` followed by base64url segments
 * joined by `.` (currently 383 characters). Nothing else is allowed, so no
 * whitespace, quote, `$`, backtick, backslash, `#`, glob character or newline
 * can reach the file.
 *
 * `.` and `-` are safe both ways the file is read. When it is `source`d, the
 * value of a `NAME=value` assignment is neither split nor globbed. Docker's
 * env-file format takes the rest of the line literally. `.` and `-` must stay
 * in the set: without them every real token is refused.
 */
const TOKEN_VALUE_RE = /^[A-Za-z0-9_.-]+$/;

/** The env file's text. Every value is checked against a character set that
 * is inert in both a docker env file and a `source`d shell file. A token
 * outside that set is refused, and the refusal never echoes it. */
export function renderTokenEnv(tok: ReadToken, repo: string): string {
  if (!TOKEN_VALUE_RE.test(tok.token))
    throw new Error(
      "the minted token has a character an env file cannot carry safely (only A-Z a-z 0-9 _ . - are allowed)",
    );
  if (!/^[0-9TZ:.+-]+$/.test(tok.expires_at))
    throw new Error("the token expiry is not a timestamp");
  if (!REPO_RE.test(repo))
    throw new Error(`[github] repo ${JSON.stringify(repo)} is not owner/name`);
  return (
    "# Minted on the host by qcr: a READ-ONLY GitHub App installation token\n" +
    "# (contents / issues / pull requests: read) for one repository. Re-minted before\n" +
    "# it expires. It cannot write to GitHub.\n" +
    `${TOKEN_VAR}=${tok.token}\n${EXPIRES_VAR}=${tok.expires_at}\n${REPO_VAR}=${repo}\n`
  );
}

/** Atomic, 0600 in a 0700 dir: the file is readable only by the host user —
 * which is also the companion's uid (the image is built with it). */
export function writeTokenEnv(dir: string, text: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = join(dir, TOKEN_FILE);
  writePrivateAtomic(file, text);
  return file;
}

/** Stage-then-rename a 0600 file. The staging name is unique per process and
 * per write and created exclusively: two TUIs (or two pulls) publishing the
 * same file at once must never share one staging inode, where one would
 * truncate or rename the other's half-written bytes. A failed write removes
 * its own staging file, never another's. */
export function writePrivateAtomic(path: string, text: string): void {
  const tmp = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
  );
  try {
    writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
    chmodSync(tmp, 0o600); // the umask may have narrowed the create mode
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** The expiry recorded in the env file, as epoch ms, or undefined. With
 * `repo`, a file minted for a DIFFERENT repository counts as no token at all,
 * so a changed `[github] repo` re-mints at once rather than when the old
 * token runs out. */
export function tokenExpiry(dir: string, repo?: string): number | undefined {
  let text: string;
  try {
    text = readFileSync(join(dir, TOKEN_FILE), "utf8");
  } catch {
    return undefined;
  }
  if (repo !== undefined) {
    const r = new RegExp(`^${REPO_VAR}=(.*)$`, "m").exec(text);
    if (!r || r[1]!.trim() !== repo) return undefined;
  }
  const m = new RegExp(`^${EXPIRES_VAR}=(.+)$`, "m").exec(text);
  const ms = m ? Date.parse(m[1]!.trim()) : Number.NaN;
  return Number.isFinite(ms) ? ms : undefined;
}

export type TokenOutcome =
  /** The file holds a token with more than the margin left: nothing minted. */
  | { kind: "fresh"; expiresAt: string }
  | { kind: "minted"; expiresAt: string }
  /** No App credential on this host: the companion simply has no GitHub. */
  | { kind: "unavailable"; reason: string }
  | { kind: "failed"; reason: string };

/** One line for the companion column / notice bar. Never a token value. */
export function tokenOutcomeLine(o: TokenOutcome): string {
  switch (o.kind) {
    case "fresh":
      return `read-only GitHub token valid until ${o.expiresAt}`;
    case "minted":
      return `read-only GitHub token minted (valid until ${o.expiresAt})`;
    case "unavailable":
      return `no read-only GitHub token — ${o.reason}`;
    case "failed":
      return `read-only GitHub token NOT refreshed — ${o.reason}`;
  }
}

export interface CompanionGithubTokenOptions {
  /** Host dir the env file lives in (`companionGithubDir()`). */
  dir: string;
  /** `[github] repo`, owner/name. */
  repo: string;
  /** The resolved App secrets dir (`app_id`, `app.pem`). Read here, on the
   * host; nothing from it is ever written into `dir`. */
  secretsDir: string;
  fetchFn?: FetchFn;
  apiBase?: string;
  now?: () => number;
}

/** Keeps the companion's token file fresh while the TUI runs. */
export class CompanionGithubToken {
  private inflight: Promise<TokenOutcome> | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly opts: CompanionGithubTokenOptions) {}

  /** Mint when the file is missing or near expiry. Single-flight; total. */
  refresh(): Promise<TokenOutcome> {
    this.inflight ??= this.doRefresh().finally(() => (this.inflight = undefined));
    return this.inflight;
  }

  private async doRefresh(): Promise<TokenOutcome> {
    const now = (this.opts.now ?? Date.now)();
    const current = tokenExpiry(this.opts.dir, this.opts.repo);
    if (current !== undefined && current - now > REFRESH_MARGIN_MS)
      return { kind: "fresh", expiresAt: new Date(current).toISOString() };
    let appId: string;
    let pem: string;
    try {
      appId = readFileSync(join(this.opts.secretsDir, "app_id"), "utf8").trim();
      pem = readFileSync(join(this.opts.secretsDir, "app.pem"), "utf8");
    } catch {
      return {
        kind: "unavailable",
        reason: `no App credential in ${this.opts.secretsDir} (app_id + app.pem)`,
      };
    }
    try {
      const tok = await mintReadOnlyToken({
        appId,
        pem,
        repo: this.opts.repo,
        fetchFn: this.opts.fetchFn,
        apiBase: this.opts.apiBase,
        now: this.opts.now,
      });
      writeTokenEnv(this.opts.dir, renderTokenEnv(tok, this.opts.repo));
      return { kind: "minted", expiresAt: tok.expires_at };
    } catch (err) {
      return { kind: "failed", reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Check every `everyMs`; each outcome goes to `onOutcome`. Idempotent. */
  start(onOutcome: (o: TokenOutcome) => void, everyMs: number = CHECK_EVERY_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.refresh().then(onOutcome), everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
