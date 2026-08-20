// The PR session's OpenViking identity and its raw-notes session.
//
// Two tiers of memory, expressed by the DATA MODEL rather than by prompt
// discipline:
//
//   * DURABLE memories live under `viking://user/reviewer/memories/…`. They are
//     authored (never extracted), they outlive every PR, and they are what a
//     search returns.
//   * The RAW tier is an OpenViking **session** named `pr-<n>`: the working
//     notes of one review conversation. Sessions are absent from the search
//     corpus (verified against a running v0.4.15), so nothing
//     a PR session scribbles can leak into another PR's context, and the tier
//     ages out by `DELETE` when the PR closes. `commit` is never called: it
//     exists to PROMOTE session content into memories, which is exactly the
//     extraction we have switched off.
//
// Three rules bind everything below:
//
//   1. NEVER A ROOT OR ADMIN KEY. Sessions hold the reviewer USER key and
//      nothing else — the server confines it to `user/reviewer/`. Upstream's
//      credential resolver falls back to the SERVER's `root_api_key` when it
//      finds nothing else, and in our container that file sits one symlink
//      away, so `writeOvcliConf` refuses to hand a session a key that IS the
//      root key: no key at all (a loud 401, memory-less) beats the wrong
//      identity (silent, total access).
//   2. THE KEY NEVER RIDES ARGV OR THE ENVIRONMENT. `ps` is world-readable
//      inside the container; a 0600 `ovcli.conf` in the pi HOME is not. Only
//      the non-secret half of the identity (url, user, peer, session id) goes
//      on the command line — see `openVikingSessionEnv`.
//   3. MEMORY NEVER BLOCKS A ROUND. Every call here is total: bounded by a
//      deadline, swallowing every throw, returning a boolean. A session whose
//      OpenViking session could not be created simply runs without a raw tier.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The OpenViking USER every daemon-side surface authenticates as. The server
 * confines this key to `user/reviewer/`; the companion's `companion` key is a
 * different tree that review sessions can never reach. */
export const OV_REVIEWER_USER = "reviewer";

/** Secrets-mount file name holding the reviewer USER key. Same 0600 discipline
 * as `openai_api_key`, read from the secrets dir and never from process.env. */
export const OV_REVIEWER_KEY_SECRET = "openviking_reviewer_key";

/** Fallback endpoint when no `[openviking]` block is configured (a hand-rolled
 * test config); the real one comes from `openVikingBaseUrl(config.openviking)`. */
export const OV_DEFAULT_BASE_URL = "http://127.0.0.1:1933";

/**
 * The OpenViking session id a PR's pi session owns.
 *
 * Deliberately the SAME string as the tmux session name: one PR, one review,
 * one name, and an operator reading `state/` or the server's session list sees
 * the correspondence immediately. It is NOT a second session kind — see the
 * single-shepherd note in `tests/single-shepherd.test.ts`: this id names a
 * store object the daemon creates over HTTP, not a process anyone schedules.
 */
export function ovSessionIdForPr(pr: number): string {
  return `pr-${pr}`;
}

// ---- lifecycle --------------------------------------------------------------

/** The slice of `OpenVikingClient` this module needs. Structural on purpose:
 * the client is another module's to evolve, and the daemon's session lifecycle
 * must not pin its type surface. */
export interface OvSessionApi {
  /** Creates with `memory_policy` fully disabled — the policy is the client's,
   * not a parameter here, because a session created without it queues a failed
   * extraction task on every commit. */
  createSession(sessionId: string): Promise<{ ok: boolean; status: number; conflict?: boolean }>;
  deleteSession(sessionId: string): Promise<{ ok: boolean; status: number }>;
}

/** What `PiSessionManager` calls at a PR session's birth and death. */
export interface OvSessionLifecycle {
  /** Idempotent: an existing session is a success, not an error. */
  create(sessionId: string): Promise<boolean>;
  /** Removes the session's messages and archives. */
  remove(sessionId: string): Promise<boolean>;
}

export interface OvSessionLifecycleOptions {
  /** Ceiling on either call. The client has its own timeout; this is the belt
   * to that braces, so a client wired without one can never wedge a birth. */
  timeoutMs?: number;
  log?: (msg: string) => void;
}

const DEFAULT_LIFECYCLE_TIMEOUT_MS = 5_000;

/** Resolve `fallback` if `p` has not settled within `ms`. Never rejects. */
async function withDeadline<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p.catch(() => fallback),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The lifecycle over a real client — total in both directions.
 *
 * A create that comes back `conflict` (409) means the session is already there,
 * which is the state the caller wanted: a PR whose tmux session died and was
 * respawned keeps the notes it already had.
 */
export function openVikingSessionLifecycle(
  api: OvSessionApi,
  opts: OvSessionLifecycleOptions = {},
): OvSessionLifecycle {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LIFECYCLE_TIMEOUT_MS;
  const log = opts.log ?? (() => {});
  const fail: { ok: boolean; status: number; conflict?: boolean } = { ok: false, status: 0, conflict: false };
  return {
    async create(sessionId: string): Promise<boolean> {
      let out: { ok: boolean; status: number; conflict?: boolean } = fail;
      try {
        out = await withDeadline(api.createSession(sessionId), timeoutMs, fail);
      } catch {
        out = fail;
      }
      if (out.ok) return true;
      if (out.conflict === true || out.status === 409) {
        log(`openviking: session ${sessionId} already exists — reusing it`);
        return true;
      }
      log(`openviking: could not create session ${sessionId} (${out.status || "no answer"}) — the PR runs without a raw tier`);
      return false;
    },
    async remove(sessionId: string): Promise<boolean> {
      let out: { ok: boolean; status: number } = fail;
      try {
        out = await withDeadline(api.deleteSession(sessionId), timeoutMs, fail);
      } catch {
        out = fail;
      }
      // 404 is the desired end state, not a failure: nothing is left to delete.
      if (out.ok || out.status === 404) return true;
      log(`openviking: could not delete session ${sessionId} (${out.status || "no answer"}) — it will linger on the server`);
      return false;
    },
  };
}

// ---- credentials ------------------------------------------------------------

export interface OvcliIdentity {
  /** `http://127.0.0.1:1933`. */
  url: string;
  /** The reviewer USER key, or "" when the secrets mount has none. */
  apiKey: string;
  user: string;
  account?: string;
}

/**
 * The `ovcli.conf` body, exactly as `shared/credentials.mjs` reads it.
 *
 * `actor_peer_id` is deliberately ABSENT: the peer is per-session and rides the
 * command line (`OPENVIKING_PEER_ID`), because all our sessions share one
 * working directory and the extension's path-derived peer id cannot tell two
 * PRs apart. A peer baked into the shared file would be one identity for every
 * session — the exact confusion this file must not create.
 */
export function renderOvcliConf(id: OvcliIdentity): string {
  const conf: Record<string, string> = { url: id.url.replace(/\/+$/, ""), user: id.user };
  if (id.account && id.account.trim() !== "") conf["account"] = id.account.trim();
  if (id.apiKey !== "") conf["api_key"] = id.apiKey;
  return `${JSON.stringify(conf, null, 2)}\n`;
}

/** The server's own `root_api_key`, or "" when unreadable. Read ONLY so we can
 * refuse to hand it to a session — it is never used as a credential here. */
export function readServerRootKey(ovConfPath: string | undefined): string {
  if (!ovConfPath) return "";
  try {
    const parsed = JSON.parse(readFileSync(ovConfPath, "utf8")) as { server?: { root_api_key?: unknown } };
    const key = parsed?.server?.root_api_key;
    return typeof key === "string" ? key.trim() : "";
  } catch {
    return "";
  }
}

export interface WriteOvcliOptions {
  /** Path of the SERVER's ov.conf, so its root key can be recognised. */
  serverConfigPath?: string;
  log?: (msg: string) => void;
}

export interface OvcliWriteResult {
  path: string;
  /** The file was written (it always is, unless the disk refused). */
  written: boolean;
  /** A usable reviewer key landed in it. False ⇒ sessions run memory-less. */
  keyed: boolean;
  /** `no-key` | `root-key-refused` | "" — why `keyed` is false. */
  reason: string;
}

/**
 * Drop the reviewer credential into the pi HOME, 0600.
 *
 * The root-key refusal is the point of this function. Upstream's resolver ends
 * its fallback chain at the server's `root_api_key`, and in the container the
 * pi HOME's `.openviking` is a symlink onto the state volume that holds the
 * server's ov.conf — so a "helpfully" copied key would authenticate every
 * review session as ROOT, silently, with access to every user's tree. If the
 * key we were handed IS that key, it is dropped: the extension then 401s and
 * reports "not reachable", which an operator can see.
 */
export function writeOvcliConf(
  path: string,
  identity: OvcliIdentity,
  opts: WriteOvcliOptions = {},
): OvcliWriteResult {
  const log = opts.log ?? (() => {});
  let apiKey = identity.apiKey.trim();
  let reason = "";
  if (apiKey === "") {
    reason = "no-key";
    log(`openviking: no ${OV_REVIEWER_KEY_SECRET} in the secrets mount — sessions start memory-less`);
  } else if (apiKey === readServerRootKey(opts.serverConfigPath)) {
    apiKey = "";
    reason = "root-key-refused";
    log(
      "openviking: REFUSED to write the server root key as a session credential — " +
        "sessions authenticate as the reviewer USER or not at all",
    );
  }
  const body = renderOvcliConf({ ...identity, apiKey });
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, body, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    log(`openviking: could not write ${path} (${(err as Error).message}) — sessions start memory-less`);
    return { path, written: false, keyed: false, reason: reason || "write-failed" };
  }
  return { path, written: true, keyed: apiKey !== "", reason };
}

/** Where the reviewer credential lives, given a pi HOME. The DEFAULT path the
 * fork's resolver checks, so identity survives even if the env var is lost. */
export function ovcliConfPathIn(piHome: string): string {
  return join(piHome, ".openviking", "ovcli.conf");
}

// ---- the environment a session is launched with -----------------------------

export interface OvSessionEnvOptions {
  baseUrl: string;
  user?: string;
  account?: string;
  /** `X-OpenViking-Actor-Peer` — the tmux session name, one actor per PR.
   * Verified to override the extension's path-derived id (all our sessions
   * share one working directory, so the derived id cannot separate PRs). */
  peerId: string;
  /** Absolute path of the ovcli.conf written by `writeOvcliConf`. */
  cliConfigPath: string;
  /** Absolute path of the SERVER's ov.conf — passed so the fork's root-key
   * guard reads the real file rather than guessing from HOME. */
  serverConfigPath?: string;
  /** The OpenViking session to ATTACH to. Omitted for the overseer: it owns no
   * PR and therefore no raw tier. */
  ovSessionId?: string;
}

/**
 * The identity variables a pi session is launched with.
 *
 * `QCR_OV_SESSION_ID` and not `OPENVIKING_SESSION_ID`, because `src/sessions.ts`
 * puts only prefixed variables on the `env K=V … pi …` argv (tmux panes inherit
 * the tmux SERVER's environment, so a client-side variable would never arrive)
 * — the fork accepts both spellings for exactly this reason.
 *
 * NO KEY IS EVER RETURNED HERE. Everything in this map is world-readable via
 * `ps`; the credential rides `ovcli.conf` at 0600.
 */
export function openVikingSessionEnv(opts: OvSessionEnvOptions): NodeJS.ProcessEnv {
  const url = opts.baseUrl.replace(/\/+$/, "");
  const env: NodeJS.ProcessEnv = {
    OPENVIKING_URL: url,
    // The documented alias. Both are set for the same reason the companion
    // sets both: `shared/credentials.mjs` prefers OPENVIKING_URL but reads
    // OPENVIKING_BASE_URL when it is absent, and an upstream that flips the
    // preference must not silently unwire us.
    OPENVIKING_BASE_URL: url,
    OPENVIKING_USER: opts.user ?? OV_REVIEWER_USER,
    OPENVIKING_PEER_ID: opts.peerId,
    OPENVIKING_CLI_CONFIG_FILE: opts.cliConfigPath,
  };
  if (opts.account && opts.account.trim() !== "") env.OPENVIKING_ACCOUNT = opts.account.trim();
  if (opts.serverConfigPath && opts.serverConfigPath.trim() !== "") {
    env.OPENVIKING_CONFIG_FILE = opts.serverConfigPath.trim();
  }
  if (opts.ovSessionId && opts.ovSessionId.trim() !== "") env.QCR_OV_SESSION_ID = opts.ovSessionId.trim();
  return env;
}
