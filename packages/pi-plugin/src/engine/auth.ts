// The engine's model credentials: one module for every way a headless host gets
// a pi login it must never refresh.
//
// A pi login (its `auth.json`) has one owner: the pi home that ran `/login` and
// keeps refreshing it. Everything else borrows. An engine host, the benchmark
// sandbox and the scan sandbox read the owner's login READ-ONLY and run on a
// copy in which every OAuth entry's refresh token is replaced by a value no
// OAuth server accepts. A borrower therefore never refreshes, so it can never
// rotate (and invalidate) the owner's grant, and never writes a file the owner
// reads. Its price: it cannot outlive the access token, so the login is refused
// before work starts when the token would expire inside the work window.
//
// One exception, the VM's: after the cutover no pi session lives long enough to
// refresh the bot's login, so ONE locked refresher in the bot container
// (src/loginrefresh/, spawned and supervised by the daemon by path) is its
// owner. It holds an exclusive flock on pihome/agent/auth.json.lock for its whole
// life, refreshes through pi-ai's own OAuth refresh and writes auth.json
// atomically. Workers, takeover and debug pi are borrowers like any other: they
// copy the file at spawn, blank, and take no lock. Everywhere else the login-refresh rule is as
// above.
//
// Three ways in, one module:
//   - `engineCredentials` / `loadAuth`: the in-process route. The copy lives in
//     memory as a CredentialStore for PiHost (packages/pi-plugin/src/engine/pisdk.ts); no file is
//     written, and its `modify` is never reached (a refresh is the only caller
//     on this route, and the copy cannot make one succeed).
//   - `copyPiAuth`: the process route. The same copy, written 0600 into a
//     sandbox's own agent dir for a pi child (bench, scan).
//   - `setRuntimeApiKey` / `applyEnvApiKeys`: the headless key route (bench,
//     the Action). No login is read at all; the key lives in the runtime only.
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
import { PI_AUTH_ERROR_RE } from "../authwatch.js";
import { CASE_STOP_GRACE_MS } from "../casebudget.js";

/** What a copied OAuth credential carries instead of the real refresh token. */
export const DISABLED_REFRESH = "bench-refresh-disabled";

/** pi refreshes an OAuth token with less than this left (pi-ai auth/resolve.js
 * DEFAULT_OAUTH_MINIMUM_VALIDITY_MS), so a run that ends inside it would ask a
 * refresher it does not have. The engine's preflight keeps clear of it. */
export const PI_REFRESH_MARGIN_MS = 5 * 60_000;

// ---- typed errors ---------------------------------------------------------------

export type AuthErrorCode = "missing" | "expiring" | "refresh-refused" | "rejected";

/** Base of every auth failure the engine raises: `code` is what a caller
 * branches on (authwatch's raise, a route's exit status), the message is for a
 * person. */
export class AuthError extends Error {
  readonly code: AuthErrorCode;
  constructor(code: AuthErrorCode, message: string) {
    super(message);
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
 * owner's pi `/login` refreshes. */
export class AuthRefreshRefused extends AuthError {
  constructor(operation: string, providerId: string) {
    super(
      "refresh-refused",
      `refusing to ${operation} the ${providerId} login: this host holds a read-only copy, and only the owner's pi /login refreshes`,
    );
  }
}

/** A provider rejected the token mid-run (the signature authwatch watches for).
 * `message` is the provider's own text. */
export class AuthRejected extends AuthError {
  constructor(message: string) {
    super("rejected", message);
  }
}

/** The typed error for a provider's failure text, or undefined when the text is
 * not an auth failure. One signature, shared with authwatch (PI_AUTH_ERROR_RE). */
export function classifyAuthFailure(message: string): AuthRejected | undefined {
  return PI_AUTH_ERROR_RE.test(message) ? new AuthRejected(message) : undefined;
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

/** The engine host's own refusals. */
export const ENGINE_AUTH_WORDS: AuthCopyWords = {
  missing: (src) => `no pi login at ${src} — run pi's /login as the owner, then start again`,
  expiring: ({ provider, expiresAt, needMs }) =>
    `the ${provider ?? "pi"} access token expires at ${new Date(expiresAt).toISOString()}, inside this run's ${Math.round(needMs / 60_000)}-minute window. ` +
    "An engine host never refreshes it (a second refresher would invalidate the owner's grant) — run pi's /login as the owner, then start again.",
};

/** The benchmark's refusals: its fixes are the login volume and the key route. */
export const BENCH_AUTH_WORDS: AuthCopyWords = {
  missing: (src) =>
    `no pi login at ${src} — log pi in on the auth volume first (/login), or use your own API key: QCR_BENCH_AUTH=api-key (bench/aacr/README.md "Reproduce")`,
  expiring: ({ expiresAt, needMs }) =>
    `the shared Codex access token expires at ${new Date(expiresAt).toISOString()}, inside this case's ${Math.round(needMs / 60_000)}-minute budget. ` +
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

/** A CredentialStore that serves a frozen copy and refuses every change. pi
 * writes to a store only to refresh, log in or log out (pi-ai auth/resolve.js,
 * models.js), and none of those is this host's to do: a call is a bug, so it
 * throws, loudly and typed, instead of persisting anything. */
class ReadOnlyCredentials implements CredentialStore {
  private readonly data: ReadonlyMap<string, Credential>;
  constructor(data: AuthData) {
    this.data = new Map(
      Object.entries(data)
        .filter(([, v]) => typeof v === "object" && v !== null)
        .map(([name, v]) => [name, v as Credential]),
    );
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
  async modify(providerId: string): Promise<Credential | undefined> {
    throw new AuthRefreshRefused("modify", providerId);
  }
  async delete(providerId: string): Promise<void> {
    throw new AuthRefreshRefused("delete", providerId);
  }
}

/** The store for the headless key route: no login at all, nothing to refresh,
 * nothing written (pi would otherwise create an empty `auth.json` in the agent
 * dir). Keys arrive through `setRuntimeApiKey`, into the runtime's memory. */
export function keyOnlyCredentials(): CredentialStore {
  return new ReadOnlyCredentials({});
}

/** The owner's login, read once from `srcDir/auth.json`, blanked and checked. */
export interface EngineAuth {
  /** The credential store for `PiHostOptions.credentials`. */
  credentials: CredentialStore;
  /** The earliest OAuth expiry, or null when the login has no OAuth entry. */
  expiresAt: number | null;
  provider: string | null;
}

/**
 * Build the engine's credentials from the owner's agent dir `srcDir` (read
 * only: nothing is written there or anywhere). Throws `AuthExpiring` — before
 * any session exists — when there is no login, or when its earliest OAuth token
 * would expire inside the run window `needMs`.
 */
export function engineCredentials(o: {
  srcDir: string;
  needMs: number;
  now?: () => number;
  words?: AuthCopyWords;
  /** The refusal margin on top of `needMs`; default pi's refresh margin. */
  marginMs?: number;
}): EngineAuth {
  const src = join(o.srcDir, "auth.json");
  const words = o.words ?? ENGINE_AUTH_WORDS;
  if (!existsSync(src)) throw new AuthExpiring(words.missing(src), { code: "missing" });
  const parsed = JSON.parse(readOwnerAuth(src)) as AuthData;
  const { expiresAt, provider } = blankRefresh(parsed);
  checkAuth({ expiresAt, provider }, { ...o, words });
  return { credentials: new ReadOnlyCredentials(parsed), expiresAt, provider };
}

// ---- the process route ----------------------------------------------------------

/**
 * Write the refresh-disabled copy of `srcDir/auth.json` to `dstDir/auth.json`
 * (0600, written aside and renamed into place). Throws `AuthExpiring` — and
 * writes nothing — when there is no login, or when its earliest OAuth token
 * expires inside `needMs`.
 *
 * This is the sandbox copy a pi CHILD reads; it keeps the sandboxes' original
 * admission rule (no refresh margin). The in-process route's `engineCredentials`
 * adds pi's five-minute refresh margin.
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

// ---- the headless key route -----------------------------------------------------

/** What `setRuntimeApiKey` needs of pi's ModelRuntime, by shape: this module
 * stays outside the SDK (tests/fences-engine S2). */
export interface RuntimeKeyTarget {
  setRuntimeApiKey(providerId: string, apiKey: string): Promise<void>;
}

/** The key variable each provider's headless route reads (bench, the Action). */
export const RUNTIME_KEY_ENVS: Readonly<Record<string, string>> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GEMINI_API_KEY",
  digitalocean: "DIGITALOCEAN_API_KEY",
};

/** Give the runtime an API key for `providerId`, in memory only: pi's runtime
 * overlay never persists it, and no login is read or written. */
export async function setRuntimeApiKey(
  runtime: RuntimeKeyTarget,
  providerId: string,
  apiKey: string,
): Promise<void> {
  if (apiKey.trim() === "") throw new Error(`an empty API key for ${providerId}`);
  await runtime.setRuntimeApiKey(providerId, apiKey);
}

/** `setRuntimeApiKey` for every provider whose key variable is set in `env`
 * (default: `providers`' table). Returns the providers it keyed. */
export async function applyEnvApiKeys(
  runtime: RuntimeKeyTarget,
  env: NodeJS.ProcessEnv,
  providers: readonly string[] = Object.keys(RUNTIME_KEY_ENVS),
): Promise<string[]> {
  const keyed: string[] = [];
  for (const providerId of providers) {
    const name = RUNTIME_KEY_ENVS[providerId];
    const value = name ? env[name] : undefined;
    if (!value || value.trim() === "") continue;
    await setRuntimeApiKey(runtime, providerId, value);
    keyed.push(providerId);
  }
  return keyed;
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
    `the companion's ${o.provider ?? "pi"} access token expires at ${new Date(o.expiresAt).toISOString()}, inside a scan case's ${Math.round(o.needMs / 60_000)}-minute budget. ` +
    "A scan never refreshes it (a second refresher would invalidate the companion's own grant) — " +
    `${SCAN_AUTH_FIX}.`
  );
}

const SCAN_AUTH_WORDS: AuthCopyWords = { missing: scanAuthMissing, expiring: scanAuthExpiring };

/** Copy the companion's login from `srcDir` into the scan's agent dir
 * `dstDir`, refresh-disabled. Throws `AuthExpiring` when there is none, or
 * when its token would expire inside `needMs`. */
export function syncScanAuth(o: {
  srcDir: string;
  dstDir: string;
  needMs: number;
  now?: () => number;
}): { expiresAt: number | null } {
  return copyPiAuth({ ...o, words: SCAN_AUTH_WORDS });
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
  },
): CaseRunnerOf<S, O | CaseRefused> {
  return {
    run: async (spec, signal, onCost): Promise<O | CaseRefused> => {
      try {
        syncScanAuth(o);
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
): CaseRunnerOf<S, O | CaseRefused> {
  const srcDir = env[SCAN_AUTH_SRC_ENV]?.trim();
  if (!srcDir) return inner;
  const home = env["HOME"]?.trim() || homeDir;
  const dstDir =
    env["PI_CODING_AGENT_DIR"]?.trim() || (home ? join(home, ".pi", "agent") : undefined);
  if (!dstDir)
    throw new Error("scan auth: PI_CODING_AGENT_DIR is not set and there is no home to default it");
  return scanAuthCases(inner, { srcDir, dstDir, needMs: SCAN_CASE_AUTH_BUDGET_MS, onExpired });
}
