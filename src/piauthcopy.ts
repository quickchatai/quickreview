// A sandbox's copy of a pi login it must never refresh.
//
// A pi login (its `auth.json`) has one owner: the pi home that logged in and
// keeps refreshing it. A sandbox that borrows it — the benchmark
// (src/bench/auth.ts), the scan sandbox (src/scanauth.ts) — reads the owner's
// agent dir READ-ONLY and runs on a private copy in which every OAuth entry's
// refresh token is replaced by a value no OAuth server accepts. The sandbox
// therefore never refreshes, so it can never rotate (and invalidate) the
// owner's grant, and never writes a file the owner reads. Its price: the
// sandbox cannot outlive the access token, so the copy is refused before work
// starts when the token would expire inside the time that work may take.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** What a copied OAuth credential carries instead of the real refresh token. */
export const DISABLED_REFRESH = "bench-refresh-disabled";

/** The copy was refused: no login, or a token that would expire too soon. */
export class AuthExpiring extends Error {}

/**
 * The sandbox copy of a pi `auth.json`: every OAuth entry's refresh token
 * replaced (not deleted — pi's credential guard expects the field to be a
 * string), everything else kept. Returns the earliest OAuth expiry, and the
 * provider it belongs to, so the caller can refuse work that would outlive it.
 */
export function authCopyFrom(raw: string): {
  json: string;
  expiresAt: number | null;
  provider: string | null;
} {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  let expiresAt: number | null = null;
  let provider: string | null = null;
  for (const [name, v] of Object.entries(parsed)) {
    if (typeof v !== "object" || v === null) continue;
    const cred = v as Record<string, unknown>;
    if (cred["type"] !== "oauth") continue;
    cred["refresh"] = DISABLED_REFRESH;
    const exp = cred["expires"];
    if (typeof exp === "number" && (expiresAt === null || exp < expiresAt)) {
      expiresAt = exp;
      provider = name;
    }
  }
  return { json: JSON.stringify(parsed, null, 2) + "\n", expiresAt, provider };
}

/** A login's providers, each with its credential type and (OAuth) expiry —
 * never a token. */
export type LoginSummary = Record<string, { type: string; expires: number | null }>;

export function loginSummary(raw: string): LoginSummary {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const out: LoginSummary = {};
  for (const [name, v] of Object.entries(parsed)) {
    if (typeof v !== "object" || v === null) continue;
    const cred = v as Record<string, unknown>;
    out[name] = {
      type: typeof cred["type"] === "string" ? cred["type"] : "unknown",
      expires: typeof cred["expires"] === "number" ? cred["expires"] : null,
    };
  }
  return out;
}

/** The words a refusal is made of — each borrower names its own fix. */
export interface AuthCopyWords {
  /** No `auth.json` at `src`. */
  missing: (src: string) => string;
  /** The earliest OAuth token (`provider`'s) expires at `expiresAt`, inside `needMs`. */
  expiring: (o: { provider: string | null; expiresAt: number; needMs: number }) => string;
}

/**
 * Write the refresh-disabled copy of `srcDir/auth.json` to `dstDir/auth.json`
 * (0600, written aside and renamed into place). Throws `AuthExpiring` — and
 * writes nothing — when there is no login, or when its earliest OAuth token
 * expires inside `needMs`.
 */
export function copyPiAuth(o: {
  srcDir: string;
  dstDir: string;
  needMs: number;
  now?: () => number;
  words: AuthCopyWords;
}): { expiresAt: number | null } {
  const src = join(o.srcDir, "auth.json");
  if (!existsSync(src)) throw new AuthExpiring(o.words.missing(src));
  const { json, expiresAt, provider } = authCopyFrom(readFileSync(src, "utf8"));
  const now = (o.now ?? Date.now)();
  if (expiresAt !== null && expiresAt < now + o.needMs) {
    throw new AuthExpiring(o.words.expiring({ provider, expiresAt, needMs: o.needMs }));
  }
  mkdirSync(o.dstDir, { recursive: true, mode: 0o700 });
  const tmp = join(o.dstDir, "auth.json.tmp");
  writeFileSync(tmp, json, { mode: 0o600 });
  renameSync(tmp, join(o.dstDir, "auth.json"));
  chmodSync(join(o.dstDir, "auth.json"), 0o600);
  return { expiresAt };
}
