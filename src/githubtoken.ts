// The host-side GitHub token refresher — `qcr github-token sync`.
//
// On the own-account route (`[github] auth = "user"`) the daemon runs on the
// person's own GitHub credential instead of a GitHub App, and that credential
// reaches it as ONE FILE: `<secrets dir>/github_token`, mode 0600, the token
// alone with no newline, rewritten atomically. Never env, never argv: the
// daemon's UserTokenSource re-reads the file, and nothing here hands it a
// token any other way.
//
// This module is the only writer of that file. It runs on the HOST, as the
// person, where their GitHub sign-in lives:
//
//   1. the token comes from `gh auth token` — the gh binary the wizard
//      resolved (`--gh <abs path>`, recorded at onboarding because cron's PATH
//      is not the wizard's: on a Boxes VM the signed-in gh is the broker
//      wrapper in /usr/local/bin, and a /usr/bin/gh beside it has no login) —
//      or, when there is no gh at all, from GH_TOKEN / GITHUB_TOKEN;
//   2. `GET /user` with it proves it works and names the login;
//   3. only then is the file rewritten (tmp + rename, 0600 under a 0700 dir).
//
// It prints the login and the token's KIND (ghu_/gho_/ghp_/github_pat_), and
// the expiry GitHub states for it, never the token: no line this module
// produces carries a token value.
//
// The wizard installs a user crontab entry that runs this every 20 minutes,
// marked `# qcr github-token sync` so a re-run replaces it instead of adding a
// second. Boxes' gh hands out an 8 h `ghu_` token from its broker, so there the
// refresh is what keeps the reviewer signed in; a `gho_`/`ghp_` token does not
// expire and the entry is merely harmless.
//
// The daemon never imports this module (it reads no personal token itself):
// the CLI and the onboarding wizard are its only callers.
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The token file's name in the secrets dir — the shared interface. */
export const GITHUB_TOKEN_FILE = "github_token";

/** The marker that makes the crontab entry idempotent. */
export const CRON_MARKER = "# qcr github-token sync";

/** How often the crontab entry refreshes the file. */
export const CRON_SCHEDULE = "*/20 * * * *";

export interface TokenRunner {
  run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
}

/** A token's shape, without its value. */
export interface TokenKind {
  /** The prefix family: "ghu_", "gho_", "ghp_", "github_pat_", "ghs_", or "unknown". */
  prefix: string;
  /** What the person reads. */
  label: string;
  /** Does a token of this kind lapse on its own? null = cannot tell. */
  expires: boolean | null;
}

export function tokenKind(token: string): TokenKind {
  if (token.startsWith("github_pat_"))
    return {
      prefix: "github_pat_",
      label: "fine-grained personal access token (expires on the date you set)",
      expires: true,
    };
  if (token.startsWith("ghu_"))
    return {
      prefix: "ghu_",
      label: "GitHub App user token (expires after 8 hours — the crontab refresh keeps it current)",
      expires: true,
    };
  if (token.startsWith("gho_"))
    return { prefix: "gho_", label: "OAuth token from gh (does not expire)", expires: false };
  if (token.startsWith("ghp_"))
    return {
      prefix: "ghp_",
      label: "classic personal access token (expires only if you set one)",
      expires: null,
    };
  if (token.startsWith("ghs_"))
    return {
      prefix: "ghs_",
      label: "GitHub App installation token (expires within the hour)",
      expires: true,
    };
  return { prefix: "unknown", label: "token of an unrecognised kind", expires: null };
}

/** A token is one line of word characters; anything else is not a token. */
const TOKEN_RE = /^[A-Za-z0-9_]{20,255}$/;

export type TokenSource = "gh" | "env:GH_TOKEN" | "env:GITHUB_TOKEN";

export type PersonToken =
  { ok: true; token: string; source: TokenSource } | { ok: false; problem: string };

/** The absolute path of the `gh` the CALLER's environment resolves, or null.
 * Recorded at onboarding so the crontab entry runs that same binary. */
export async function resolveGhPath(runner: TokenRunner): Promise<string | null> {
  const r = await runner.run("sh", ["-c", "command -v gh"]);
  const path = r.code === 0 ? r.stdout.trim().split("\n")[0]!.trim() : "";
  return path.startsWith("/") ? path : null;
}

/**
 * The person's token: `gh auth token` first (the named binary, else `gh` on
 * PATH), then GH_TOKEN, then GITHUB_TOKEN. Env is read only when gh cannot
 * answer at all — a gh that exists but is signed out is said as itself.
 */
export async function readPersonToken(o: {
  runner: TokenRunner;
  env: Readonly<Record<string, string | undefined>>;
  gh?: string | null;
}): Promise<PersonToken> {
  const gh = o.gh && o.gh.trim() !== "" ? o.gh : "gh";
  const r = await o.runner.run(gh, ["auth", "token"]);
  const out = r.code === 0 ? r.stdout.trim() : "";
  if (out !== "") {
    if (!TOKEN_RE.test(out))
      return { ok: false, problem: `\`${gh} auth token\` printed something that is not a token` };
    return { ok: true, token: out, source: "gh" };
  }
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN"] as const) {
    const v = (o.env[name] ?? "").trim();
    if (v === "") continue;
    if (!TOKEN_RE.test(v)) return { ok: false, problem: `${name} is set but is not a token` };
    return { ok: true, token: v, source: `env:${name}` };
  }
  const why = (r.stderr || r.stdout).trim().split("\n")[0]?.slice(0, 160) ?? "";
  return {
    ok: false,
    problem:
      `no GitHub sign-in found: \`${gh} auth token\` gave no token${why ? ` (${why})` : ""} and neither GH_TOKEN nor ` +
      "GITHUB_TOKEN is set. Sign in with `gh auth login`, then run this again",
  };
}

export type LoginLookup =
  | { ok: true; login: string; expiry: string | null }
  | { ok: false; status: number; detail: string };

/** `GET /user` — which account the token is, and when GitHub says it lapses. */
export async function githubLogin(
  fetchFn: typeof fetch,
  token: string,
  apiBase = "https://api.github.com",
): Promise<LoginLookup> {
  try {
    const res = await fetchFn(`${apiBase}/user`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "quickreview-github-token-sync",
      },
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    const login = (body as { login?: unknown } | null)?.login;
    if (res.status === 200 && typeof login === "string" && login !== "") {
      const expiry = res.headers?.get?.("github-authentication-token-expiration") ?? null;
      return { ok: true, login, expiry: expiry && expiry.trim() !== "" ? expiry.trim() : null };
    }
    const message = (body as { message?: unknown } | null)?.message;
    return {
      ok: false,
      status: res.status,
      detail: `GET /user answered HTTP ${res.status}${typeof message === "string" ? `: ${message}` : ""}`,
    };
  } catch (err) {
    return { ok: false, status: 0, detail: `GET /user failed: ${String(err)}` };
  }
}

/** Write the token file: 0600 under a 0700 dir, the token alone, tmp+rename so
 * a reader never sees half a token. Returns the file's path. */
export function writeTokenFile(secretsDir: string, token: string): string {
  if (!TOKEN_RE.test(token)) throw new Error("refusing to write something that is not a token");
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  chmodSync(secretsDir, 0o700);
  const path = join(secretsDir, GITHUB_TOKEN_FILE);
  const tmp = join(secretsDir, `.${GITHUB_TOKEN_FILE}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, token, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
  return path;
}

export type SyncResult =
  | {
      ok: true;
      login: string;
      kind: TokenKind;
      source: TokenSource;
      expiry: string | null;
      path: string;
    }
  | { ok: false; problem: string };

/** The whole refresh: read the person's token, prove it with `GET /user`, and
 * only then rewrite the file. A token GitHub refuses never reaches the file. */
export async function syncGithubToken(o: {
  runner: TokenRunner;
  env: Readonly<Record<string, string | undefined>>;
  fetch: typeof fetch;
  secretsDir: string;
  gh?: string | null;
  apiBase?: string;
}): Promise<SyncResult> {
  const got = await readPersonToken(o);
  if (!got.ok) return got;
  const who = await githubLogin(o.fetch, got.token, o.apiBase);
  if (!who.ok)
    return {
      ok: false,
      problem:
        who.status === 401
          ? `GitHub rejected the token from ${got.source} (${who.detail}) — sign in again (\`gh auth login\`); the token file was left as it was`
          : `could not check the token from ${got.source} with GitHub (${who.detail}); the token file was left as it was`,
    };
  let path: string;
  try {
    path = writeTokenFile(o.secretsDir, got.token);
  } catch (err) {
    return {
      ok: false,
      problem: `could not write ${join(o.secretsDir, GITHUB_TOKEN_FILE)}: ${String(err)}`,
    };
  }
  return {
    ok: true,
    login: who.login,
    kind: tokenKind(got.token),
    source: got.source,
    expiry: who.expiry,
    path,
  };
}

/** The one line a sync reports. No token value can appear in it. */
export function renderSync(r: SyncResult): string {
  if (!r.ok) return `✗ github-token sync: ${r.problem}`;
  return (
    `✓ github-token sync: signed in as ${r.login} — ${r.kind.prefix} ${r.kind.label}` +
    `${r.expiry ? `, GitHub says it expires ${r.expiry}` : ""}; from ${r.source}, written to ${r.path} (0600)`
  );
}

// ---- the crontab entry -------------------------------------------------------

/** POSIX single-quoting for one word of the crontab command. */
function shq(word: string): string {
  return /^[A-Za-z0-9_./=:@%+-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** The app's own cli.js, beside this module in the built tree. */
export function defaultCliPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "cli.js");
}

/** The command a refresh runs: absolute node, absolute cli.js, the gh the
 * wizard resolved and the secrets dir it wrote to — cron's environment knows
 * none of them. */
export function syncCommandWords(o: {
  node: string;
  cli: string;
  gh: string | null;
  secretsDir: string;
}): string[] {
  return [
    o.node,
    o.cli,
    "github-token",
    "sync",
    ...(o.gh ? ["--gh", o.gh] : []),
    "--secrets-dir",
    o.secretsDir,
  ];
}

export function syncCommandLine(o: Parameters<typeof syncCommandWords>[0]): string {
  return syncCommandWords(o).map(shq).join(" ");
}

export function cronLine(o: Parameters<typeof syncCommandWords>[0]): string {
  return `${CRON_SCHEDULE} ${syncCommandLine(o)} >/dev/null 2>&1 ${CRON_MARKER}`;
}

/** Replace every marked line with `line` (or add it). Idempotent: a crontab
 * that already carries exactly this line comes back unchanged. */
export function mergeCrontab(existing: string, line: string): { text: string; changed: boolean } {
  const lines = existing.split("\n").filter((l, i, all) => !(l === "" && i === all.length - 1));
  const kept = lines.filter((l) => !l.includes(CRON_MARKER));
  const text = `${[...kept, line].join("\n")}\n`;
  const before = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
  return { text, changed: text !== before };
}

export type CronOutcome =
  | { kind: "installed"; line: string }
  | { kind: "unchanged"; line: string }
  | { kind: "no-crontab"; line: string }
  | { kind: "failed"; line: string; detail: string };

/**
 * Install (or refresh) the marked user crontab entry, through the runner:
 * `crontab -l`, merge, write the result to a 0600 scratch file, `crontab
 * <file>`. A machine with no `crontab` is reported as such, never an error.
 */
export async function installCronEntry(o: {
  runner: TokenRunner;
  line: string;
  scratchDir: string;
}): Promise<CronOutcome> {
  const which = await o.runner.run("sh", ["-c", "command -v crontab"]);
  if (which.code !== 0 || which.stdout.trim() === "") return { kind: "no-crontab", line: o.line };
  const current = await o.runner.run("crontab", ["-l"]);
  let existing = "";
  if (current.code === 0) existing = current.stdout;
  else if (!/no crontab/i.test(current.stderr + current.stdout))
    return {
      kind: "failed",
      line: o.line,
      detail: `crontab -l exited ${current.code}: ${(current.stderr || current.stdout).trim().slice(0, 200)}`,
    };
  const merged = mergeCrontab(existing, o.line);
  if (!merged.changed) return { kind: "unchanged", line: o.line };
  mkdirSync(o.scratchDir, { recursive: true });
  const file = join(o.scratchDir, "crontab.qcr.new");
  try {
    writeFileSync(file, merged.text, { mode: 0o600 });
    const put = await o.runner.run("crontab", [file]);
    if (put.code !== 0)
      return {
        kind: "failed",
        line: o.line,
        detail: `crontab ${file} exited ${put.code}: ${(put.stderr || put.stdout).trim().slice(0, 200)}`,
      };
  } finally {
    rmSync(file, { force: true });
  }
  return { kind: "installed", line: o.line };
}

/** Does the user crontab carry the marked entry, and does it run THIS gh? */
export async function cronEntryState(
  runner: TokenRunner,
  gh: string | null,
): Promise<"present" | "stale" | "absent" | "no-crontab"> {
  const which = await runner.run("sh", ["-c", "command -v crontab"]);
  if (which.code !== 0 || which.stdout.trim() === "") return "no-crontab";
  const current = await runner.run("crontab", ["-l"]);
  const line = (current.code === 0 ? current.stdout : "")
    .split("\n")
    .find((l) => l.includes(CRON_MARKER));
  if (!line) return "absent";
  if (gh && !line.includes(` --gh ${shq(gh)} `)) return "stale";
  return "present";
}

// ---- the CLI verb ------------------------------------------------------------

export const GITHUB_TOKEN_USAGE =
  "usage: qcr github-token sync [--gh <path to gh>] [--secrets-dir <dir>]";

export function parseGithubTokenArgs(rest: readonly string[]): {
  gh: string | null;
  secretsDir: string | null;
} {
  if (rest[0] !== "sync") throw new Error(GITHUB_TOKEN_USAGE);
  let gh: string | null = null;
  let secretsDir: string | null = null;
  for (let i = 1; i < rest.length; i++) {
    const a = rest[i]!;
    const v = rest[i + 1];
    if ((a === "--gh" || a === "--secrets-dir") && v !== undefined && v.trim() !== "") {
      if (a === "--gh") gh = v;
      else secretsDir = v;
      i++;
    } else throw new Error(GITHUB_TOKEN_USAGE);
  }
  return { gh, secretsDir };
}

/** A real runner for the CLI: execFile, never a shell, never a throw. */
export const execRunner: TokenRunner = {
  run: (cmd, args) =>
    new Promise((done) => {
      execFile(cmd, args, { timeout: 30_000 }, (err, stdout, stderr) => {
        const code = err === null ? 0 : typeof err.code === "number" ? err.code : 1;
        done({
          code,
          stdout: String(stdout),
          stderr: err && !stderr ? String(err.message) : String(stderr),
        });
      });
    }),
};

/** `qcr github-token sync`. Exit 0 on a written, proven token; 1 otherwise. */
export async function cmdGithubToken(
  rest: readonly string[],
  deps: {
    runner?: TokenRunner;
    env?: Readonly<Record<string, string | undefined>>;
    fetch?: typeof fetch;
    /** The secrets dir when `--secrets-dir` is not given. */
    secretsDir: () => string;
    log?: (line: string) => void;
  },
): Promise<number> {
  const args = parseGithubTokenArgs(rest);
  const log = deps.log ?? ((l: string) => console.log(l));
  const result = await syncGithubToken({
    runner: deps.runner ?? execRunner,
    env: deps.env ?? process.env,
    fetch: deps.fetch ?? fetch,
    secretsDir: args.secretsDir ?? deps.secretsDir(),
    gh: args.gh,
  });
  log(renderSync(result));
  return result.ok ? 0 : 1;
}
