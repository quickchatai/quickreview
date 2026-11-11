// The engine's model credentials: one module for every way a headless host gets
// a pi login it must never refresh.
//
// A pi login (its `auth.json`) has one owner: the pi home that ran `/login` and
// keeps refreshing it. Everything else borrows. An engine host, the benchmark
// sandbox and the scan sandbox read the owner's login READ-ONLY and run on a
// copy in which every OAuth entry's refresh token is replaced by a value no
// OAuth server accepts. A borrower therefore never refreshes, so it can never
// rotate (and invalidate) the owner's grant, and never writes a file the owner
// reads. Its price: it cannot outlive the access token. A token that would
// expire inside the work window is settled before work starts: an in-process
// run leaves that login out and tells its route, and a copy for a pi child is
// refused.
//
// One exception, the VM's: after the cutover no pi session lives long enough to
// refresh the bot's login, so ONE locked refresher in the bot container
// (src/loginrefresh/, spawned and supervised by the daemon by path) is its
// owner. It holds an exclusive flock on pihome/agent/loginrefresh.lock for its whole
// life, refreshes through pi-ai's own OAuth refresh and writes auth.json
// atomically. Workers, takeover and debug pi are borrowers like any other: they
// copy the file at spawn, blank, and take no lock. Everywhere else the login-refresh rule is as
// above.
//
// Two ways in, one module:
//   - `borrowedCredentials`: the in-process route. The copy lives in memory as
//     a CredentialStore for PiHost (packages/pi-plugin/src/engine/pisdk.ts); no
//     file is written. It is a filter, not a refusal: a login that cannot last
//     the run on this surface is left out and named (`skipped`), so pi sees its
//     provider as it would be without that login, and an API key in the
//     environment for it takes over by pi's own rule. Where something renews
//     the owner's login while the run is going (`owner`), a token shorter than
//     the run is kept, and the store's `modify` (pi calls it only to refresh)
//     takes the newer token from the owner's file instead of refreshing.
//   - `copyPiAuth`: the process route. The same copy, written 0600 into a
//     sandbox's own agent dir for a pi child (bench, scan).
//
// No key is ever handed to pi's runtime from here. A provider's key is found
// by pi, by pi's own names and in pi's own order, in the environment the host
// was given: a stored credential owns its provider, and a key in the
// environment is the route only where no stored one can be used.
//
// The scan sandbox's wiring (it mounts the companion's agent dir read-only and
// re-takes the copy before every case) is here too: it is this module's copy
// with the scan's words and budget.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";
import { CASE_STOP_GRACE_MS } from "../casebudget.js";
import { providerErrorKind } from "../modelerrors.js";
import type { SkippedLogin } from "../modelroute.js";

/** What a copied OAuth credential carries instead of the real refresh token. */
export const DISABLED_REFRESH = "bench-refresh-disabled";

/** pi refreshes an OAuth token with less than this left (pi-ai auth/resolve.js
 * DEFAULT_OAUTH_MINIMUM_VALIDITY_MS), so a run that ends inside it would ask a
 * refresher it does not have. The engine's preflight keeps clear of it. */
export const PI_REFRESH_MARGIN_MS = 5 * 60_000;

// ---- typed errors ---------------------------------------------------------------

export type AuthErrorCode = "missing" | "expiring" | "unreadable" | "refresh-refused" | "rejected";

/** Base of every auth failure the engine raises: `code` is what a caller
 * branches on (authwatch's raise, a route's exit status), the message is for a
 * person. */
export class AuthError extends Error {
  readonly code: AuthErrorCode;
  constructor(code: AuthErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** The login was refused before work started: no login (`code` "missing"), or a
 * token that would expire inside the work window ("expiring"). */
export class AuthExpiring extends AuthError {
  readonly provider: string | null;
  readonly expiresAt: number | null;
  constructor(
    message: string,
    detail: {
      code?: "missing" | "expiring";
      provider?: string | null;
      expiresAt?: number | null;
    } = {},
  ) {
    super(detail.code ?? "expiring", message);
    this.provider = detail.provider ?? null;
    this.expiresAt = detail.expiresAt ?? null;
  }
}

/** Something asked the borrowed login to change. It never may: only the
 * owner's pi `/login` refreshes. `cause` is what kept a borrower from taking a
 * newer token from the owner (a renewal that failed, a file it could not read). */
export class AuthRefreshRefused extends AuthError {
  constructor(operation: string, providerId: string, options?: ErrorOptions) {
    super(
      "refresh-refused",
      `refusing to ${operation} the ${providerId} login: this host holds a read-only copy, and only the owner's pi /login refreshes`,
      options,
    );
  }
}

/** pi's credentials are there and could not be read: the file is not readable,
 * or is not the JSON object pi writes. Never treated as "no login": a store
 * nobody could read is unknown, not empty. */
export class AuthUnreadable extends AuthError {
  readonly path: string;
  constructor(path: string, cause: unknown) {
    const why = cause instanceof Error ? cause.message : String(cause);
    super("unreadable", `could not read pi's credentials at ${path}: ${why}`, { cause });
    this.path = path;
  }
}

/** A provider refused the credential mid-run (the kind authwatch watches for).
 * `message` is the provider's own text. */
export class AuthRejected extends AuthError {
  constructor(message: string) {
    super("rejected", message);
  }
}

/** The typed error for a provider's failure text, or undefined when the text is
 * not a refused credential. The reading is the one classifier's `auth` kind
 * (src/modelerrors.ts), the same one authwatch reads: a refused model, a rate
 * limit or a spent usage window is not a refused login. */
export function classifyAuthFailure(message: string): AuthRejected | undefined {
  return providerErrorKind(message) === "auth" ? new AuthRejected(message) : undefined;
}

// ---- reading the owner's file ---------------------------------------------------

/** How a borrower waits out a file it cannot parse. */
export interface ReadRetry {
  tries?: number;
  delayMs?: number;
}

/** Block this thread for `ms` (a borrower's copy is synchronous). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The owner's `auth.json` as text that parses, taking no lock. Every write by
 * the refresher is an atomic rename (src/loginrefresh/atomic.ts), so a borrower
 * reads the old file or the new one, whole. The one file that may not parse is
 * one a login is rewriting in place (the pi `/login` under the entrypoint's
 * login mode, which the refresher pauses for): that read is retried, a few
 * times, and then fails with the parse error.
 */
export function readOwnerAuth(src: string, retry: ReadRetry = {}): string {
  const tries = retry.tries ?? 5;
  const delayMs = retry.delayMs ?? 200;
  for (let attempt = 1; ; attempt++) {
    const raw = readFileSync(src, "utf8");
    try {
      JSON.parse(raw);
      return raw;
    } catch (err) {
      if (attempt >= tries) throw err;
      sleepSync(delayMs);
    }
  }
}

// ---- the refresh-blanked copy ---------------------------------------------------

type AuthData = Record<string, unknown>;

/** `parsed` with every OAuth entry's refresh token replaced (not deleted — pi's
 * credential guard expects the field to be a string), everything else kept, and
 * the earliest OAuth expiry with the provider it belongs to. Mutates `parsed`. */
function blankRefresh(parsed: AuthData): { expiresAt: number | null; provider: string | null } {
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
  return { expiresAt, provider };
}

/**
 * The sandbox copy of a pi `auth.json`, as text: every OAuth entry's refresh
 * token replaced, everything else kept. Returns the earliest OAuth expiry, and
 * the provider it belongs to, so the caller can refuse work that would outlive it.
 */
export function authCopyFrom(
  raw: string,
  /** Keep only these providers' entries: the copy, and its expiry check,
   * then cover exactly what the run uses. Omitted: every entry. */
  providers?: readonly string[],
): {
  json: string;
  expiresAt: number | null;
  provider: string | null;
} {
  const all = JSON.parse(raw) as AuthData;
  const parsed: AuthData =
    providers === undefined
      ? all
      : Object.fromEntries(Object.entries(all).filter(([name]) => providers.includes(name)));
  const { expiresAt, provider } = blankRefresh(parsed);
  return { json: JSON.stringify(parsed, null, 2) + "\n", expiresAt, provider };
}

/** A login's providers, each with its credential type and (OAuth) expiry —
 * never a token. */
export type LoginSummary = Record<string, { type: string; expires: number | null }>;

export function loginSummary(raw: string): LoginSummary {
  return summaryOf(JSON.parse(raw) as Record<string, unknown>);
}

function summaryOf(parsed: Record<string, unknown>): LoginSummary {
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

/** An expiry as text: the ISO time, or `never` for one that is no date. pi
 * writes the largest safe integer for a login that does not expire, and a
 * Date made from it is invalid (`toISOString` throws). */
export function expiryText(expiresAt: number | null): string {
  if (expiresAt === null) return "never";
  const date = new Date(expiresAt);
  return Number.isNaN(date.getTime()) ? "never" : date.toISOString();
}

/** The words a refusal is made of — each borrower names its own fix. */
export interface AuthCopyWords {
  /** No `auth.json` at `src`. */
  missing: (src: string) => string;
  /** The earliest OAuth token (`provider`'s) expires at `expiresAt`, inside `needMs`. */
  expiring: (o: { provider: string | null; expiresAt: number; needMs: number }) => string;
}

/** The engine host's own refusals. */
export const ENGINE_AUTH_WORDS: AuthCopyWords = {
  missing: (src) => `no pi login at ${src} — run pi's /login as the owner, then start again`,
  expiring: ({ provider, expiresAt, needMs }) =>
    `the ${provider ?? "pi"} access token expires at ${expiryText(expiresAt)}, inside this run's ${Math.round(needMs / 60_000)}-minute window. ` +
    "An engine host never refreshes it (a second refresher would invalidate the owner's grant) — run pi's /login as the owner, then start again.",
};

/** The benchmark's refusals: its fixes are the login volume and the key route. */
export const BENCH_AUTH_WORDS: AuthCopyWords = {
  missing: (src) =>
    `no pi login at ${src} — log pi in on the auth volume first (/login), or use your own API key: QCR_BENCH_AUTH=api-key (bench/aacr/README.md "Reproduce")`,
  expiring: ({ expiresAt, needMs }) =>
    `the shared Codex access token expires at ${expiryText(expiresAt)}, inside this case's ${Math.round(needMs / 60_000)}-minute budget. ` +
    "The benchmark never refreshes it (that would invalidate the login's own grant). Use pi on that login volume once so it refreshes its own login, then re-run with --resume — or run on your own API key (QCR_BENCH_AUTH=api-key).",
};

/**
 * The preflight: throw `AuthExpiring` when the earliest OAuth token expires
 * inside `needMs` (plus `marginMs`, the stretch at the end of its life in which
 * pi would try to refresh it). A login with no OAuth entry never expires.
 */
export function checkAuth(
  copy: { expiresAt: number | null; provider: string | null },
  o: { needMs: number; now?: () => number; marginMs?: number; words?: AuthCopyWords },
): void {
  if (copy.expiresAt === null) return;
  const now = (o.now ?? Date.now)();
  if (copy.expiresAt >= now + o.needMs + (o.marginMs ?? PI_REFRESH_MARGIN_MS)) return;
  const words = (o.words ?? ENGINE_AUTH_WORDS).expiring({
    provider: copy.provider,
    expiresAt: copy.expiresAt,
    needMs: o.needMs,
  });
  throw new AuthExpiring(words, {
    code: "expiring",
    provider: copy.provider,
    expiresAt: copy.expiresAt,
  });
}

// ---- the in-process route -------------------------------------------------------

/** Where a borrowed store takes a newer token from: the owner's file, after
 * asking the owner to renew when the host can. */
interface OwnerSource {
  /** The owner's `auth.json`. */
  src: string;
  renew?: (provider: string) => Promise<void>;
  retry?: ReadRetry;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A CredentialStore that serves a copy and never refreshes. pi writes to a
 * store only to refresh, log in or log out (pi-ai auth/resolve.js, models.js).
 * Logging in or out is never this host's to do, so `delete` throws, loudly and
 * typed, instead of persisting anything. A refresh is `modify`: with no owner
 * to borrow from again it throws the same way; with one it re-borrows. */
class ReadOnlyCredentials implements CredentialStore {
  private readonly data: Map<string, Credential>;
  private readonly owner: OwnerSource | undefined;
  /** One re-borrow per provider at a time: sessions that ask together share it. */
  private readonly reborrowing = new Map<string, Promise<Credential>>();
  constructor(data: AuthData, owner?: OwnerSource) {
    this.data = new Map(
      Object.entries(data)
        .filter(([, v]) => typeof v === "object" && v !== null)
        .map(([name, v]) => [name, v as Credential]),
    );
    this.owner = owner;
  }
  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    const cred = this.data.get(providerId);
    return cred ? structuredClone(cred) : undefined;
  }
  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    return [...this.data].map(([providerId, c]) => ({ providerId, type: c.type }));
  }
  /**
   * pi asks for a refresh (the token is inside pi's five minutes). A borrower
   * still never makes one: pi's updater, which would spend the owner's refresh
   * token, is not called. The owner is asked to renew when the host can ask,
   * the owner's file is read again, and a token there that expires later than
   * the one held is adopted, refresh blanked, and returned.
   * VERIFY-ON-PIN (pi 1.4.0, canary 14): pi calls `modify` only on its refresh
   * path, and the credential it resolves with is the one the request runs on.
   */
  async modify(
    providerId: string,
    _update?: unknown,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    const owner = this.owner;
    if (owner === undefined) throw new AuthRefreshRefused("modify", providerId);
    let pending = this.reborrowing.get(providerId);
    if (pending === undefined) {
      pending = this.reborrow(providerId, owner).finally(() => this.reborrowing.delete(providerId));
      this.reborrowing.set(providerId, pending);
    }
    return structuredClone(await pending);
  }
  async delete(providerId: string): Promise<void> {
    throw new AuthRefreshRefused("delete", providerId);
  }

  private async reborrow(providerId: string, owner: OwnerSource): Promise<Credential> {
    const held = this.data.get(providerId);
    // A login the borrow left out stays out: the route was chosen without it.
    if (held?.type !== "oauth") throw new AuthRefreshRefused("modify", providerId);
    let cause: unknown;
    try {
      await owner.renew?.(providerId);
    } catch (err) {
      // The owner's file may hold a newer token all the same: read it.
      cause = err;
    }
    let fresh: unknown;
    try {
      const parsed: unknown = JSON.parse(readOwnerAuth(owner.src, owner.retry));
      fresh = isRecord(parsed) ? parsed[providerId] : undefined;
    } catch (err) {
      cause ??= err;
    }
    const heldExpires = typeof held.expires === "number" ? held.expires : -Infinity;
    if (
      isRecord(fresh) &&
      fresh["type"] === "oauth" &&
      typeof fresh["expires"] === "number" &&
      fresh["expires"] > heldExpires
    ) {
      const adopted = { ...fresh, refresh: DISABLED_REFRESH } as Credential;
      this.data.set(providerId, adopted);
      return adopted;
    }
    throw new AuthRefreshRefused("modify", providerId, cause !== undefined ? { cause } : undefined);
  }
}

/** The store of a host that holds no login: nothing to refresh, nothing
 * written (pi would otherwise create an empty `auth.json` in the agent dir).
 * Its credentials are the ones pi finds in the environment. */
export function keyOnlyCredentials(): CredentialStore {
  return new ReadOnlyCredentials({});
}

/** What a run borrowed of the owner's login. */
export interface BorrowedAuth {
  /** The credential store for `PiHostOptions.credentials`: every stored key
   * and every login that can last the run, refresh blanked. */
  credentials: CredentialStore;
  /** The logins left out because they cannot last this run on this surface.
   * `name` is the provider id: a host that knows pi's display name puts it in. */
  skipped: SkippedLogin[];
  /** Every entry of the owner's file, kept or skipped: type and expiry, never
   * a token. */
  summary: LoginSummary;
}

/**
 * Borrow the owner's login from the agent dir `srcDir` (read only: nothing is
 * written there or anywhere), before a route is chosen, so that a login this
 * surface cannot use is never picked.
 *
 * It filters, entry by entry:
 *
 *   an API key                                          kept
 *   a login that lasts `needMs` plus the margin         kept
 *   a login shorter than that, outside the margin now   kept with an `owner`
 *                                                       (the store re-borrows),
 *                                                       else skipped
 *   a login inside the margin now                       skipped
 *
 * A login that never expires lasts any run. No `auth.json` is an empty store
 * (a key in the environment is then the route). One that is there and cannot
 * be read, or is not the object pi writes, throws `AuthUnreadable`: an unknown
 * store is never taken for an empty one.
 */
export function borrowedCredentials(o: {
  srcDir: string;
  /** How long the run may last. */
  needMs: number;
  /** The stretch at the end of a login's life in which pi would refresh it;
   * default pi's own. */
  marginMs?: number;
  now?: () => number;
  /** Something renews this login while the run is going: the pi the run is
   * inside, or the bot's refresher while it is healthy. */
  owner: boolean;
  /** Ask the owner to renew one provider's login now. */
  renew?: (provider: string) => Promise<void>;
  /** How a file that does not parse is waited out (a login being rewritten). */
  retry?: ReadRetry;
}): BorrowedAuth {
  const src = join(o.srcDir, "auth.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readOwnerAuth(src, o.retry));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      return { credentials: new ReadOnlyCredentials({}), skipped: [], summary: {} };
    throw new AuthUnreadable(src, err);
  }
  if (!isRecord(parsed)) throw new AuthUnreadable(src, new Error("it is not a JSON object"));
  const now = (o.now ?? Date.now)();
  const margin = o.marginMs ?? PI_REFRESH_MARGIN_MS;
  const kept: AuthData = {};
  const skipped: SkippedLogin[] = [];
  for (const [provider, entry] of Object.entries(parsed)) {
    if (!isRecord(entry)) continue;
    if (entry["type"] !== "oauth") {
      kept[provider] = entry;
      continue;
    }
    const expires = entry["expires"];
    if (typeof expires === "number") {
      const lasts = expires >= now + o.needMs + margin;
      const renewed = o.owner && expires >= now + margin;
      if (!lasts && !renewed) {
        skipped.push({ provider, name: provider, expiresAt: expires });
        continue;
      }
    }
    kept[provider] = { ...entry, refresh: DISABLED_REFRESH };
  }
  return {
    credentials: new ReadOnlyCredentials(kept, {
      src,
      ...(o.renew ? { renew: o.renew } : {}),
      ...(o.retry ? { retry: o.retry } : {}),
    }),
    skipped,
    summary: summaryOf(parsed),
  };
}

// ---- the process route ----------------------------------------------------------

/**
 * Write the refresh-disabled copy of `srcDir/auth.json` to `dstDir/auth.json`
 * (0600, written aside and renamed into place). Throws `AuthExpiring` — and
 * writes nothing — when there is no login, or when its earliest OAuth token
 * expires inside `needMs`.
 *
 * This is the sandbox copy a pi CHILD reads; it keeps the sandboxes' original
 * admission rule (no refresh margin). The in-process route's
 * `borrowedCredentials` adds pi's five-minute refresh margin.
 */
export function copyPiAuth(o: {
  srcDir: string;
  dstDir: string;
  needMs: number;
  now?: () => number;
  words: AuthCopyWords;
  /** Copy (and check) only these providers' logins; omitted: all of them. */
  providers?: readonly string[];
}): { expiresAt: number | null } {
  const src = join(o.srcDir, "auth.json");
  if (!existsSync(src)) throw new AuthExpiring(o.words.missing(src), { code: "missing" });
  const { json, expiresAt, provider } = authCopyFrom(readOwnerAuth(src), o.providers);
  checkAuth(
    { expiresAt, provider },
    { needMs: o.needMs, marginMs: 0, words: o.words, ...(o.now ? { now: o.now } : {}) },
  );
  mkdirSync(o.dstDir, { recursive: true, mode: 0o700 });
  const tmp = join(o.dstDir, "auth.json.tmp");
  writeFileSync(tmp, json, { mode: 0o600 });
  renameSync(tmp, join(o.dstDir, "auth.json"));
  chmodSync(join(o.dstDir, "auth.json"), 0o600);
  return { expiresAt };
}

// ---- the scan sandbox's login ---------------------------------------------------
//
// There is one login: the companion's pi home, which is also the only refresher.
// The scan container mounts the companion's agent dir READ-ONLY at a source path
// (src/scanbox.ts) and, before every case, re-takes a private copy of its
// auth.json into the container's own pi agent dir. So a scan never refreshes,
// never writes anything the companion reads, and picks up a token the companion
// refreshed at its next case. A case whose budget the token would not cover is
// refused before it starts, and the run is stopped with the fix.

/** The scan engine's case runner (src/setup/engine.ts `CaseRunner`), by
 * shape: this module stays outside src/setup/. */
export interface CaseRunnerOf<S, O> {
  run(spec: S, signal: AbortSignal, onCost?: (spentSoFar: number) => void): Promise<O>;
}
/** A case the copy refused: it never started, so it spent nothing. */
export type CaseRefused = { ok: false; reason: string; cost_usd: number };

/** Set in the scan container: where the companion's agent dir is mounted
 * read-only. Its presence is what makes the driver copy before each case. */
export const SCAN_AUTH_SRC_ENV = "QCR_SCAN_AUTH_SRC";
/** The time a scan case may take, which the access token must outlive. */
export const SCAN_CASE_AUTH_BUDGET_MS = 30 * 60_000;

/** The way out of a refused copy: the companion refreshes its own login. */
export const SCAN_AUTH_FIX =
  "open the companion so its pi refreshes the login (or run `qcr scan login`), then start the scan again";

export function scanAuthMissing(src: string): string {
  return `no pi login in the companion's pi home (${src}) — run \`qcr scan login\` to log the companion's pi in`;
}

export function scanAuthExpiring(o: {
  provider: string | null;
  expiresAt: number;
  needMs: number;
}): string {
  return (
    `the companion's ${o.provider ?? "pi"} access token expires at ${expiryText(o.expiresAt)}, inside a scan case's ${Math.round(o.needMs / 60_000)}-minute budget. ` +
    "A scan never refreshes it (a second refresher would invalidate the companion's own grant) — " +
    `${SCAN_AUTH_FIX}.`
  );
}

const SCAN_AUTH_WORDS: AuthCopyWords = { missing: scanAuthMissing, expiring: scanAuthExpiring };

/** The provider a model spec names (`provider/model[:level]`), or null when
 * it names none: a spec that pins no model runs on the route's. */
function specProvider(spec: string): string | null {
  const at = spec.indexOf("/");
  return at > 0 ? spec.slice(0, at) : null;
}

/**
 * The providers a scan's models are on: the route's, and the provider of
 * every tier and lens the config pins to a model of its own. These are the
 * only logins a scan needs to outlive a case; any other login in the pi home
 * (one the person signed in to for something else) decides nothing.
 */
export function scanProviders(
  route: { provider: string },
  models?: {
    tiers?: Readonly<Record<string, string>>;
    pass_models?: Readonly<Record<string, string>>;
  },
): string[] {
  const out = new Set([route.provider]);
  for (const spec of [
    ...Object.values(models?.tiers ?? {}),
    ...Object.values(models?.pass_models ?? {}),
  ]) {
    const provider = specProvider(spec);
    if (provider !== null) out.add(provider);
  }
  return [...out];
}

/**
 * Copy the companion's login from `srcDir` into the scan's agent dir
 * `dstDir`, refresh-disabled. Throws `AuthExpiring` when there is none, or
 * when a token would expire inside `needMs`.
 *
 * With `providers` (the providers the scan's models are on), only their
 * tokens are judged: a login of another provider that is about to expire is
 * not the scan's to refuse. The copy is still the whole login, so a tier the
 * config pins to another provider finds its own.
 */
export function syncScanAuth(o: {
  srcDir: string;
  dstDir: string;
  needMs: number;
  now?: () => number;
  providers?: readonly string[];
}): { expiresAt: number | null } {
  const { providers, ...copy } = o;
  if (providers === undefined) return copyPiAuth({ ...copy, words: SCAN_AUTH_WORDS });
  const src = join(o.srcDir, "auth.json");
  if (!existsSync(src)) throw new AuthExpiring(scanAuthMissing(src), { code: "missing" });
  const judged = authCopyFrom(readOwnerAuth(src), providers);
  checkAuth(
    { expiresAt: judged.expiresAt, provider: judged.provider },
    {
      needMs: o.needMs,
      marginMs: 0,
      words: SCAN_AUTH_WORDS,
      ...(o.now ? { now: o.now } : {}),
    },
  );
  // The whole login, with no window of its own: what had to be judged was.
  copyPiAuth({ ...copy, needMs: Number.NEGATIVE_INFINITY, words: SCAN_AUTH_WORDS });
  return { expiresAt: judged.expiresAt };
}

/** A case runner over the borrowed login: before each case, the copy is
 * re-taken from the live source. A refused copy never starts the case — it
 * fails with the refusal and `onExpired` hears it, so the run can stop. */
export function scanAuthCases<S, O>(
  inner: CaseRunnerOf<S, O>,
  o: {
    srcDir: string;
    dstDir: string;
    needMs: number;
    now?: () => number;
    onExpired: (reason: string) => void;
    /** The providers the scan's models are on, asked per case: the only
     * logins the copy then judges. Omitted, or answering nothing: all. */
    providers?: () => readonly string[] | undefined;
  },
): CaseRunnerOf<S, O | CaseRefused> {
  return {
    run: async (spec, signal, onCost): Promise<O | CaseRefused> => {
      try {
        const providers = o.providers?.();
        syncScanAuth({
          srcDir: o.srcDir,
          dstDir: o.dstDir,
          needMs: o.needMs,
          ...(o.now ? { now: o.now } : {}),
          ...(providers !== undefined ? { providers } : {}),
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        if (!(err instanceof AuthExpiring)) {
          return { ok: false, reason: `the login copy failed: ${reason}`, cost_usd: 0 };
        }
        o.onExpired(reason);
        return { ok: false, reason, cost_usd: 0 };
      }
      const bounded = new AbortController();
      const stop = (): void => bounded.abort();
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
      // Reserve the runner's forced-stop grace inside the login admission budget.
      const timer = setTimeout(stop, Math.max(0, o.needMs - CASE_STOP_GRACE_MS));
      timer.unref();
      try {
        // Wait for process cleanup and its final cost rather than racing a refusal.
        return await inner.run(spec, bounded.signal, onCost);
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
      }
    },
  };
}

/** The driver's case runner: over the borrowed login in the scan container
 * (its env names the read-only source), the plain runner anywhere else —
 * `sandbox = "host"` runs on the host pi's own login. `homeDir` is the user's
 * home as the host resolved it, for an env that names neither the agent dir
 * nor HOME. */
export function scanCasesForEnv<S, O>(
  inner: CaseRunnerOf<S, O>,
  env: NodeJS.ProcessEnv,
  onExpired: (reason: string) => void,
  homeDir?: string,
  /** The providers the scan's models are on (`scanAuthCases`). */
  providers?: () => readonly string[] | undefined,
): CaseRunnerOf<S, O | CaseRefused> {
  const srcDir = env[SCAN_AUTH_SRC_ENV]?.trim();
  if (!srcDir) return inner;
  const home = env["HOME"]?.trim() || homeDir;
  const dstDir =
    env["PI_CODING_AGENT_DIR"]?.trim() || (home ? join(home, ".pi", "agent") : undefined);
  if (!dstDir)
    throw new Error("scan auth: PI_CODING_AGENT_DIR is not set and there is no home to default it");
  return scanAuthCases(inner, {
    srcDir,
    dstDir,
    needMs: SCAN_CASE_AUTH_BUDGET_MS,
    onExpired,
    ...(providers ? { providers } : {}),
  });
}
