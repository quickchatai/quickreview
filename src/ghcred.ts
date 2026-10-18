// The GitHub credential chain of the LOCAL review route (`qcr review`).
//
// CLAUDE.md rule 3 (carve-out of 2026-10-18): the daemon holds only the App
// credential. The local and Action review routes run as the person at their
// own terminal, so they may also use the credentials that person already has.
// This module is that route's alone: the daemon's code never imports it
// (tests/review-pr-target.test.ts fences who may).
//
// Order: the App if configured, then GITHUB_TOKEN / GH_TOKEN, then
// `gh auth token`.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type CredentialSource = "app" | "env:GITHUB_TOKEN" | "env:GH_TOKEN" | "gh";

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
