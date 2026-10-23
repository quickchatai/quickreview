// The GitHub credential chain of the LOCAL review route (`qcr review`).
//
// CLAUDE.md rule 3 (carve-out of 2026-10-18): the daemon holds only the App
// credential. The local and Action review routes run as the person at their
// own terminal, so they may also use the credentials that person already has.
// This module is that route's alone: the daemon's code never imports it
// (tests/review-pr-target.test.ts fences who may).
//
// Order: the App if configured, then the token handed to a container as a
// file (below), then GITHUB_TOKEN / GH_TOKEN, then `gh auth token`.
//
// The handoff (D39, amending R7): a token a container runs with is never env
// and never argv. The caller (the host wrapper, or the Action) writes it to a
// 0600 file in a fresh 0700 dir, bind-mounted at /run/qcr-in, and names the
// file in QCR_GH_TOKEN_FILE. `takeHandoffToken` reads it ONCE at startup,
// unlinks it, deletes the variable and keeps the token in this module's
// memory only, all before any pi or bash child exists.
import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CREDENTIAL_SOURCES = ["app", "handoff", "gh", "env:GITHUB_TOKEN", "env:GH_TOKEN"] as const;
export type CredentialSource = (typeof CREDENTIAL_SOURCES)[number];

/** The variable that names the handed-over token file. */
export const HANDOFF_FILE_ENV = "QCR_GH_TOKEN_FILE";
/** Where the container sees the handoff dir. */
export const HANDOFF_MOUNT = "/run/qcr-in";

let handed: string | null = null;

/**
 * Read the handed-over token file once and unlink it. Returns the token (also
 * kept for `handedToken()`), or null when no file was named. Throws, leaving
 * nothing in memory, when the file is named but unreadable, empty, or cannot
 * be removed: a token that stays on disk beside a model's tools is refused,
 * never used. The variable is deleted from `env` either way, so no child
 * inherits the path.
 */
export function takeHandoffToken(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const file = env[HANDOFF_FILE_ENV];
  delete env[HANDOFF_FILE_ENV];
  if (file === undefined || file === "") return handed;
  const fd = openSync(file, "r");
  try {
    // Unlink first, read from the open descriptor: the file is gone before
    // its content is in memory, and a failed unlink reads nothing.
    unlinkSync(file);
    const token = readFileSync(fd, "utf8").trim();
    if (!token) throw new Error("the GitHub token file is empty");
    handed = token;
  } finally {
    closeSync(fd);
  }
  return handed;
}

/** The token `takeHandoffToken` read, or null. */
export const handedToken = (): string | null => handed;

/** Forget the handed-over token (tests; a long-lived host after its last use). */
export function dropHandedToken(): void {
  handed = null;
}

export interface StagedHandoff {
  /** The host dir to bind-mount at HANDOFF_MOUNT (mode 0700). */
  dir: string;
  /** The value for QCR_GH_TOKEN_FILE inside the container. */
  containerFile: string;
  /** Remove the host dir; call on exit, whatever happened. */
  remove: () => void;
}

/**
 * The caller's half: write `token` to a 0600 file in a fresh 0700 dir. On
 * Linux the dir is under $XDG_RUNTIME_DIR (a tmpfs); elsewhere (macOS) it
 * comes from mkdtemp under $TMPDIR. The token is never put in env or argv.
 */
export function stageHandoffToken(
  token: string,
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): StagedHandoff {
  const runtime = env["XDG_RUNTIME_DIR"];
  const base = platform === "linux" && runtime && runtime.startsWith("/") ? runtime : tmpdir();
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "qcr-in-")); // 0700
  try {
    writeFileSync(join(dir, "gh-token"), token, { mode: 0o600, flag: "wx" });
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return {
    dir,
    containerFile: `${HANDOFF_MOUNT}/gh-token`,
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export type CredentialResolution =
  { ok: true; source: CredentialSource; token: string } | { ok: false; error: string };

export const MISSING_CREDENTIAL_HELP =
  "no GitHub credential found. Run `gh auth login`, or set GITHUB_TOKEN (or GH_TOKEN) " +
  "to a token that can read the repository, or configure the GitHub App.";

export interface CredentialDeps {
  /** `[github].secrets_dir`: where the App's app_id and app.pem live. */
  secretsDir: string;
  env: Record<string, string | undefined>;
  /** Mint an installation token from the App in `secretsDir`. */
  mintApp: (secretsDir: string) => Promise<string>;
  /** The token `gh auth token` prints, or null when gh is absent or logged out. */
  ghAuthToken: () => string | null;
  /** The token handed to this container as a file, if one was (`handedToken()`). */
  handoff?: string | null;
}

/** The real `gh auth token`. */
export function ghAuthTokenFromCli(): string | null {
  try {
    const out = execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

export async function resolveGithubCredential(d: CredentialDeps): Promise<CredentialResolution> {
  let appNote = "";
  const appConfigured =
    d.secretsDir !== "" &&
    existsSync(join(d.secretsDir, "app_id")) &&
    existsSync(join(d.secretsDir, "app.pem"));
  if (appConfigured) {
    try {
      const token = (await d.mintApp(d.secretsDir)).trim();
      if (token) return { ok: true, source: "app", token };
    } catch (err) {
      appNote = `the configured GitHub App could not mint a token (${String(
        err instanceof Error ? err.message : err,
      ).slice(0, 200)}). `;
    }
  }
  const given = d.handoff?.trim();
  if (given) return { ok: true, source: "handoff", token: given };
  for (const name of ["GITHUB_TOKEN", "GH_TOKEN"] as const) {
    const v = d.env[name]?.trim();
    if (v) return { ok: true, source: `env:${name}`, token: v };
  }
  const gh = d.ghAuthToken();
  if (gh) return { ok: true, source: "gh", token: gh };
  return {
    ok: false,
    error: appNote ? appNote + MISSING_CREDENTIAL_HELP : MISSING_CREDENTIAL_HELP,
  };
}
