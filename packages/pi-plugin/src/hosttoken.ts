// The token file, read as its writer left it, and what it says of itself.
//
// Under `[github] auth = "user"` the GitHub credential is ONE file,
// `<secrets dir>/github_token` (packages/pi-plugin/src/githubAuth.ts). Under
// `[github] token_source = "host"` a host that manages the install is its
// only writer, and the host's half of the contract is:
//
//   * the file is written atomically (a rename), mode 0600, the token alone;
//   * it holds, at all times, a token with at least 15 minutes of life left,
//     so the reader's own rules (first use, every five minutes, after a 401)
//     never meet a token about to lapse;
//   * beside it the host MAY write an expiry note, `github_token.expires_at`:
//     one ISO 8601 instant (GitHub's own `expires_at` spelling), the time the
//     token in the file lapses. The note is optional and is never a credential.
//
// Nothing here writes either file, and nothing here reads the environment.
// The readers: the local review route's credential chain (ghcred.ts), the
// home's GitHub port and the board export's `github` field (the app).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { USER_TOKEN_FILE } from "./githubAuth.js";

/** The expiry note's name in the secrets dir, beside the token file. */
export const TOKEN_EXPIRY_NOTE_FILE = `${USER_TOKEN_FILE}.expires_at`;

/** How a host-managed credential is named to the person, on every surface. */
export const HOST_MANAGED = "managed by your host";

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
  g: { auth?: "app" | "user"; secrets_dir: string },
  o: { now?: () => number; read?: ReadText } = {},
): GithubTokenHealth | null {
  if (g.auth !== "user") return null;
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
