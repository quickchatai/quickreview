// The token file, read as its writer left it, and what it says of itself.
//
// Under `[github] auth = "user"` and `auth = "installation"` the GitHub
// credential is ONE file, `<secrets dir>/github_token`
// (packages/pi-plugin/src/githubAuth.ts): the person's own token, or an App
// installation's. Under `[github] token_source = "host"` a host that manages
// the install is its only writer (an installation token has no other), and
// the host's half of the contract is:
//
//   * the file is written atomically (a rename), mode 0600, the token alone;
//   * it holds, at all times, a token with at least 15 minutes of life left,
//     so the reader's own rules (first use, every five minutes, after a 401)
//     never meet a token about to lapse;
//   * beside it the host MAY write an expiry note, `github_token.expires_at`:
//     one ISO 8601 instant (GitHub's own `expires_at` spelling), the time the
//     token in the file lapses. The note is optional and is never a credential.
//
// The marker itself is read off a config's own text (`readHostMarker`), never
// through a config loader: a config holding nothing but the marker is a
// host-managed install's from the moment its host writes it, before a setup
// has written the keys a loader needs beside it. Every reader that must
// behave differently on such an install asks that one function (the app's
// src/hostmanaged.ts, the plugin's setup check), and the session token helper
// (scripts/mint-token.sh) reads the same key first.
//
// Who a token is (`tokenOwnLogin`) is asked of GitHub's GraphQL `viewer`,
// which answers for every kind of token: a person's login for theirs, and
// `<slug>[bot]` for an App installation's. The REST user endpoint is not
// asked: it refuses an installation token. The account step and a host's
// setup compare that login with the configured `bot_login`, so an install
// whose slug names another App than the one the token belongs to is told so
// instead of failing to recognise its own reviews.
//
// Nothing here writes either file, and nothing here reads the environment.
// The readers: the local review route's credential chain (ghcred.ts), the
// home's GitHub port and the board export's `github` field (the app).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { USER_TOKEN_FILE } from "./githubAuth.js";

/** The expiry note's name in the secrets dir, beside the token file. */
export const TOKEN_EXPIRY_NOTE_FILE = `${USER_TOKEN_FILE}.expires_at`;

/** How a host-managed credential is named to the person, on every surface. */
export const HOST_MANAGED = "managed by your host";

/** What a config's own `[github]` table says of who keeps the credential. */
export interface HostMarker {
  /** `token_source = "host"` is written. */
  hostManaged: boolean;
  /** `secrets_dir` as written; null when the config names none. */
  secretsDir: string | null;
}

/**
 * The host-managed marker of a config.toml, read off its text as written:
 * `[github] token_source = "host"`, whatever else the file holds or lacks.
 * Null for a text that is not TOML, which says nothing either way.
 */
export function readHostMarker(toml: string): HostMarker | null {
  let doc: unknown;
  try {
    doc = parse(toml);
  } catch {
    return null;
  }
  const raw = (doc as Record<string, unknown> | null)?.["github"];
  const github: Record<string, unknown> =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const secrets = github["secrets_dir"];
  return {
    hostManaged: github["token_source"] === "host",
    secretsDir: typeof secrets === "string" && secrets.trim() !== "" ? secrets : null,
  };
}

export type TokenFileRead =
  | { ok: true; token: string; path: string }
  | {
      ok: false;
      /** `missing`: no file. `empty`: a file with no token in it. `malformed`:
       * more than one word. `unreadable`: the file is there and cannot be read. */
      reason: "missing" | "empty" | "malformed" | "unreadable";
      path: string;
    };

type ReadText = (path: string) => string;
const readUtf8: ReadText = (path) => readFileSync(path, "utf8");

/** Read the token file in `secretsDir`. Never throws, and never puts the
 * token in a message. */
export function readTokenFile(secretsDir: string, read: ReadText = readUtf8): TokenFileRead {
  const path = join(secretsDir, USER_TOKEN_FILE);
  let text: string;
  try {
    text = read(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    return { ok: false, reason: code === "ENOENT" ? "missing" : "unreadable", path };
  }
  const token = text.trim();
  if (token === "") return { ok: false, reason: "empty", path };
  if (/\s/.test(token)) return { ok: false, reason: "malformed", path };
  return { ok: true, token, path };
}

/** Why a host-managed token could not be used, for the person: what is wrong
 * and whose it is to put right. No command is named, because none on this
 * machine writes the file. */
export function hostTokenProblem(r: Extract<TokenFileRead, { ok: false }>): string {
  const whose =
    "this install's GitHub credential is managed by its host, which writes that file and keeps it fresh";
  switch (r.reason) {
    case "missing":
      return `no GitHub token at ${r.path} yet: ${whose}`;
    case "empty":
      return `the GitHub token file ${r.path} is empty: ${whose}`;
    case "malformed":
      return `the GitHub token file ${r.path} holds more than one token-shaped word: ${whose}`;
    case "unreadable":
      return `the GitHub token file ${r.path} cannot be read: ${whose}`;
  }
}

/** The token file's state as a host reads it back: a token is there and
 * nothing says it lapsed, its note says it lapsed, or there is no token. */
export type GithubTokenHealth = "ok" | "expired" | "missing";

/**
 * The board export's `github` value, from the token file and its optional
 * expiry note:
 *
 *   missing  no token file, or one with no token in it
 *   expired  a token, and a note whose instant is not after `now`
 *   ok       a token, and either no note or a note whose instant is ahead
 *   null     it cannot be told: the mode has no token file (`auth = "app"`
 *            mints its own), the file or the note is there and cannot be
 *            read, or the note is not an instant. The export leaves the
 *            field out: unknown is never `ok` and never `missing`.
 *
 * GitHub is not asked: this is what the files say, at no cost per read.
 */
export function githubTokenHealth(
  g: { auth?: "app" | "user" | "installation"; secrets_dir: string },
  o: { now?: () => number; read?: ReadText } = {},
): GithubTokenHealth | null {
  if (g.auth !== "user" && g.auth !== "installation") return null;
  const read = o.read ?? readUtf8;
  const token = readTokenFile(g.secrets_dir, read);
  if (!token.ok) {
    if (token.reason === "missing" || token.reason === "empty") return "missing";
    return null;
  }
  let note: string;
  try {
    note = read(join(g.secrets_dir, TOKEN_EXPIRY_NOTE_FILE)).trim();
  } catch (err) {
    return (err as NodeJS.ErrnoException | null)?.code === "ENOENT" ? "ok" : null;
  }
  const at = expiryInstant(note);
  if (at === null) return null;
  return at > (o.now ?? Date.now)() ? "ok" : "expired";
}

const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** An ISO 8601 instant with its zone (`2026-11-19T15:04:05Z`), as ms since
 * the epoch; null for anything else. A date with no time or no zone is not
 * an instant: it would be read in the machine's own zone. */
export function expiryInstant(text: string): number | null {
  if (!INSTANT_RE.test(text)) return null;
  const at = Date.parse(text);
  return Number.isFinite(at) ? at : null;
}

/** Who a token is, as GitHub says it; or why that could not be read
 * (`status` 0: GitHub was not reached). The token is never in `detail`. */
export type TokenLoginRead =
  { ok: true; login: string } | { ok: false; status: number; detail: string };

const VIEWER_LOGIN_QUERY = "query { viewer { login } }";
const TOKEN_LOGIN_TIMEOUT_MS = 15_000;

/**
 * The login a token acts as: GraphQL's `viewer`. It answers for a person's
 * token (their login) and for an App installation's (`<slug>[bot]`), which
 * the REST user endpoint refuses. One read, no retry: the caller says what
 * it could not learn.
 */
export async function tokenOwnLogin(
  fetchFn: typeof fetch,
  token: string,
  apiBase = "https://api.github.com",
): Promise<TokenLoginRead> {
  let status: number;
  let body: unknown = null;
  try {
    const res = await fetchFn(`${apiBase}/graphql`, {
      method: "POST",
      signal: AbortSignal.timeout(TOKEN_LOGIN_TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "quickreview",
      },
      body: JSON.stringify({ query: VIEWER_LOGIN_QUERY }),
    });
    status = res.status;
    const text = await res.text();
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
  } catch {
    return { ok: false, status: 0, detail: "GitHub could not be reached to ask who the token is" };
  }
  const answer = body as {
    data?: { viewer?: { login?: unknown } | null } | null;
    errors?: Array<{ message?: unknown }>;
    message?: unknown;
  } | null;
  const login = answer?.data?.viewer?.login;
  if (status === 200 && typeof login === "string" && login !== "") return { ok: true, login };
  const said = status === 200 ? answer?.errors?.[0]?.message : answer?.message;
  const words =
    typeof said === "string" ? `: ${said.replace(/\s+/g, " ").trim().slice(0, 160)}` : "";
  return {
    ok: false,
    status,
    detail:
      status === 200
        ? `GitHub did not say who the token is${words}`
        : `GitHub answered HTTP ${status} when asked who the token is${words}`,
  };
}

/** Why a token whose own login is `actual` is not the identity `expected`
 * names, in words for the person; null when it is. GitHub's logins compare
 * without case. */
export function tokenIdentityProblem(expected: string, actual: string): string | null {
  if (expected.toLowerCase() === actual.toLowerCase()) return null;
  return (
    `the token in the token file acts as ${actual}, but this reviewer is set up to post as ${expected}: ` +
    "the App slug and the token name two different identities, so the reviewer would not recognise its own reviews"
  );
}
