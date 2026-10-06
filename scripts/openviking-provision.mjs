#!/usr/bin/env node
// OpenViking boot provisioning — the users that make `api_key` mode
// mean something.
//
// WHY THIS EXISTS
// ---------------
// Until the deployed server ran `auth_mode: "dev"`, which bypasses
// authentication on loopback. The whole two-user design (rule 8) rests on the
// server CONFINING each USER key to its own tree, so in dev mode the
// confinement was nominal: a reviewer-scoped search returned another user's
// content on 2026-08-20. `api_key` mode is the ratified posture — and it only
// works if the users exist and hold the keys we distributed.
//
// WHAT IT DOES, AND WHAT IT DELIBERATELY DOES NOT
// ------------------------------------------------
//   * ENSURES the users exist: created if absent, LEFT EXACTLY ALONE if
//     present. Re-running is a no-op; a restored state volume keeps its users.
//   * VERIFIES the reviewer key from the secrets mount actually authenticates,
//     and says so in the boot log when it does not.
//   * REPORTS what it found in `state/openviking/provision.json` (S1):
//     the daemon reads it at boot, carries it in status.json `memory`, and
//     wakes `memory_provision_failed` on a failure or a user it had to create.
//     The boot log alone reached nobody.
//   * NEVER ROTATES, and never mints a key for a user that already has one. A
//     rotation would orphan the key already distributed to the companion's PC
//     (and to this container's secrets mount) — the exact "must not orphan or
//     rotate them" the ticket forbids.
//   * NEVER WRITES A COMPANION KEY ANYWHERE ON THIS MACHINE. The companion key
//     is minted once by a human, in the deploy window, and goes straight to his
//     PC (docs/companion-memory-access.md). A container that stored it would be
//     handing every review session the reach confinement exists to deny.
//
// THE ROOT KEY
// ------------
// The server's root key is the SERVER's credential, not a client's. It reaches
// this process from the read-only secrets mount, is used for the admin calls
// below, and is never logged, never put on an argv, never copied into any file
// this process writes. `writeOvcliConf` (src/memory/ovsession.ts) refuses to
// hand it to a pi session, and `extensions/bash-guard.ts` refuses bash commands
// that read the files carrying it.
//
// MEMORY NEVER BLOCKS THE BOOT. Every failure here is a log line, a report
// line and exit 0: an unprovisioned server means memory degrades (401s, which
// the daemon's memory health monitor turns into a wake and a TUI banner),
// never a reviewer that does not come up. `--strict` (tests, manual runs) is the only way to get a
// non-zero exit.
//
// MINTING lives here too, and is NOT part of the boot path.
// `main()` below never mints: the boot container ensures users and verifies the
// reviewer key, exactly as before. The onboarding wizard
// (`src/onboard/steps/memory.ts`) imports `mintRootKey` / `mintUserKeys` to
// close the documented "mint one, once" gap with an actual command. The mint
// helpers are PURE of the filesystem — they generate a value or ask the server
// for one and RETURN it; where each key may be written is the step's business,
// and the confinement rules there are absolute (root + reviewer into the
// daemon-side secrets, the companion key ONLY into the operator's key file).
// Minting is idempotent by construction: a user that already exists keeps the
// key it already has (read back from the admin listing), and nothing here ever
// rotates one.
//
// Zero dependencies and plain JS on purpose: the entrypoint runs it before the
// TypeScript build, on a container that may have no `dist/` yet.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PATHS, authHeaders, classify } from "./companion-memory-forward.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, "..");

export const DEFAULTS = {
  base: "http://127.0.0.1:1933",
  account: "default",
  users: ["reviewer", "companion"],
  readyTimeoutMs: 60_000,
  requestTimeoutMs: 10_000,
};

// ---- admin surface ----------------------------------------------------------
//
// Verified to EXIST against a running 0.4.15 (triage): the account
// user routes below. Their request/response BODIES are the adjustable part —
// everything that reads a response goes through the tolerant helpers here, and
// anything unrecognised is INCONCLUSIVE, never a silent success.

export function adminUsersPath(account) {
  return `/api/v1/admin/accounts/${encodeURIComponent(account)}/users`;
}

export function adminUserKeyPath(account, user) {
  return `${adminUsersPath(account)}/${encodeURIComponent(user)}/key`;
}

/** Root-key headers for an admin call. The key is a value, never a log line. */
export function adminHeaders(rootKey) {
  return { Authorization: `Bearer ${rootKey}`, "Content-Type": "application/json" };
}

/**
 * User ids out of whatever the listing returned.
 *
 * Deliberately tolerant of envelope shape (`{data:{users:[…]}}`, `{users:[…]}`,
 * a bare array) and of item shape (a string, or an object keyed `user`,
 * `user_id`, `id` or `name`). `null` means "this did not look like a listing at
 * all" — which the caller treats as inconclusive and NOT as "no users", because
 * "no users" would make it create users that already exist.
 */
export function usersFromListing(body) {
  const candidates = [body, body?.data, body?.result].filter((c) => c && typeof c === "object");
  // The live 0.4.15 answers `{status:"ok", result:[...]}` — the envelope's
  // `result`/`data` IS the array, not an object carrying one (verified against
  // the deployed server, 2026-08-25; the miss made boot provisioning refuse to
  // create anything, correctly but uselessly).
  let list = Array.isArray(body)
    ? body
    : Array.isArray(body?.result)
      ? body.result
      : Array.isArray(body?.data)
        ? body.data
        : null;
  for (const c of candidates) {
    if (list) break;
    for (const key of ["users", "items", "accounts"]) {
      if (Array.isArray(c[key])) {
        list = c[key];
        break;
      }
    }
  }
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const item of list) {
    if (typeof item === "string") {
      if (item.trim() !== "") out.push(item.trim());
      continue;
    }
    if (item && typeof item === "object") {
      const name = item.user ?? item.user_id ?? item.id ?? item.name;
      if (typeof name === "string" && name.trim() !== "") out.push(name.trim());
    }
  }
  return out;
}

/**
 * user → key out of a listing, when the listing carries keys.
 *
 * A root/admin listing answers each user with its key in plaintext (verified
 * against 0.4.15, asset 17). That is what makes minting idempotent
 * WITHOUT rotating: a user that already exists hands its existing key back, so
 * the wizard can distribute it instead of issuing a second one. Tolerant of the
 * same envelope/item shapes as `usersFromListing`; users whose item carries no
 * key are simply absent from the map (never guessed, never rotated).
 */
export function userKeysFromListing(body) {
  const list = Array.isArray(body)
    ? body
    : Array.isArray(body?.result)
      ? body.result
      : Array.isArray(body?.data)
        ? body.data
        : Array.isArray(body?.users)
          ? body.users
          : Array.isArray(body?.data?.users)
            ? body.data.users
            : Array.isArray(body?.result?.users)
              ? body.result.users
              : null;
  const out = {};
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const name = item.user_id ?? item.user ?? item.id ?? item.name;
    const key = item.api_key ?? item.user_key ?? item.key;
    if (
      typeof name === "string" &&
      name.trim() !== "" &&
      typeof key === "string" &&
      key.trim() !== ""
    ) {
      out[name.trim()] = key.trim();
    }
  }
  return out;
}

/** The key a create-user response minted, or "" when it carried none. */
export function keyFromCreate(body) {
  for (const c of [body?.result, body?.data, body]) {
    if (!c || typeof c !== "object") continue;
    const key = c.user_key ?? c.api_key ?? c.key;
    if (typeof key === "string" && key.trim() !== "") return key.trim();
  }
  return "";
}

/**
 * A cryptographically strong SERVER root key.
 *
 * The root key is the one key in the system nobody issues for us: ov.conf's
 * `server.root_api_key` is whatever value the secrets file holds, so "mint one,
 * once" means generating one here. 32 random bytes, base64url — no separators,
 * so it survives every env-file, TOML and shell hop it travels through.
 */
export function mintRootKey(rand = randomBytes) {
  return Buffer.from(rand(32)).toString("base64url");
}

/**
 * The idempotence core, pure: what a provisioning run would DO given what is
 * already there. `existing === null` (an unreadable listing) creates NOTHING —
 * guessing wrong here means minting a duplicate identity for a user who
 * already has one, and the standing rule is that a degraded memory engine is
 * always better than a wrong one.
 */
export function planProvision(existing, wanted) {
  const seen = [];
  for (const u of wanted) {
    const name = String(u).trim();
    if (name !== "" && !seen.includes(name)) seen.push(name);
  }
  if (existing === null) return { create: [], keep: [], unknown: seen };
  const have = new Set(existing.map((u) => String(u).trim()));
  return {
    create: seen.filter((u) => !have.has(u)),
    keep: seen.filter((u) => have.has(u)),
    unknown: [],
  };
}

/** Comma/space separated user list → array. */
export function parseUserList(raw) {
  return String(raw ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/** A secret file's contents, or "" — an unreadable secret is a degraded mode. */
export function readSecret(path) {
  if (!path) return "";
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

// ---- calls ------------------------------------------------------------------

/**
 * The HTTP seam every exported call takes, declared by the MINIMUM this module
 * reads — a status and an optional `json()`. Deliberately not `typeof fetch`:
 * the `fetchFn = fetch` defaults would otherwise bind the seam to the global's
 * full `Response` contract, and a seam typed by its implementation rather than
 * by its use forces every test double to fabricate a whole Response.
 *
 * @typedef {(url: string, init?: { method?: string, headers?: Record<string, string>, body?: string, signal?: AbortSignal }) => Promise<{ status: number, json?: () => Promise<unknown> }>} OvFetch
 */

/**
 * @param {OvFetch} fetchFn
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string, string>, body?: string }} init
 * @param {number} timeoutMs
 */
async function call(fetchFn, url, init, timeoutMs) {
  try {
    const res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    let body = {};
    if (typeof res.json === "function") body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  } catch (err) {
    return { status: 0, body: {}, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * List the account's users. Returns `null` for anything that is not a readable
 * listing — including OpenViking's habit of answering an error HTTP 200 with
 * `{status:"error"}` in the envelope.
 */
export async function listUsers({
  base,
  account,
  rootKey,
  fetchFn = /** @type {OvFetch} */ (fetch),
  timeoutMs = DEFAULTS.requestTimeoutMs,
}) {
  const r = await call(
    fetchFn,
    `${base}${adminUsersPath(account)}`,
    { method: "GET", headers: adminHeaders(rootKey) },
    timeoutMs,
  );
  if (r.status < 200 || r.status >= 300)
    return { users: null, keys: {}, status: r.status, detail: r.error ?? `HTTP ${r.status}` };
  if (r.body && typeof r.body === "object" && r.body.status === "error") {
    return {
      users: null,
      keys: {},
      status: r.status,
      detail: `error envelope: ${String(r.body.error?.message ?? r.body.error ?? "")}`,
    };
  }
  // `keys` is only ever READ by the wizard's mint path, so an
  // existing user's already-distributed key can be re-used instead of rotated.
  // The boot path ignores it and never writes a key anywhere.
  return {
    users: usersFromListing(r.body),
    keys: userKeysFromListing(r.body),
    status: r.status,
    detail: `HTTP ${r.status}`,
  };
}

/** Create ONE user. A 409 is success: the user already exists. */
export async function createUser({
  base,
  account,
  user,
  rootKey,
  fetchFn = /** @type {OvFetch} */ (fetch),
  timeoutMs = DEFAULTS.requestTimeoutMs,
}) {
  const r = await call(
    fetchFn,
    `${base}${adminUsersPath(account)}`,
    // role is lowercase on the live 0.4.15: uppercase gets INVALID_ARGUMENT
    // "Account user role must be user or admin" (verified 2026-08-25).
    {
      method: "POST",
      headers: adminHeaders(rootKey),
      body: JSON.stringify({ user_id: user, user, role: "user" }),
    },
    timeoutMs,
  );
  if (r.status === 409)
    return { ok: true, existed: true, key: "", detail: "HTTP 409 — already present" };
  if (r.status >= 200 && r.status < 300 && !(r.body && r.body.status === "error")) {
    // The server MINTS the user's key at creation and returns it here — this is
    // the only moment it is ever handed out. The boot path discards it; the
    // wizard's mint path is what places it.
    return { ok: true, existed: false, key: keyFromCreate(r.body), detail: `HTTP ${r.status}` };
  }
  return { ok: false, existed: false, key: "", detail: r.error ?? `HTTP ${r.status}` };
}

/**
 * Ensure every wanted user exists and RETURN the key each one holds.
 *
 * The mint capability the "mint one, once" docs described and no command
 * implemented. Idempotent by construction, in three layers:
 *
 *   * a user that exists keeps its key — read back from the admin listing,
 *     never re-issued (a rotation orphans the copy already distributed to the
 *     operator's PC and to the daemon's secrets mount);
 *   * a user that is missing is created, and the key the server mints in that
 *     response is the one returned;
 *   * an UNREADABLE listing creates nothing at all (`planProvision`'s rule): a
 *     wrong guess here mints a duplicate identity for a user who already has
 *     one, and a degraded memory engine always beats a wrong one.
 *
 * Users whose key could not be learned come back in `missing` — the caller
 * reports them; it must never invent or rotate one. Never throws, never writes
 * a file, never logs a key value.
 */
export async function mintUserKeys({
  base,
  account,
  users,
  rootKey,
  fetchFn = /** @type {OvFetch} */ (fetch),
  log = () => {},
}) {
  const report = { keys: {}, created: [], kept: [], missing: [], ok: true, detail: "" };
  if (!rootKey) {
    report.ok = false;
    report.detail = "no root key — admin calls cannot authenticate";
    report.missing = [...users];
    return report;
  }
  const listing = await listUsers({ base, account, rootKey, fetchFn });
  const plan = planProvision(listing.users, users);
  if (plan.unknown.length > 0) {
    report.ok = false;
    report.detail = `could not read the user listing (${listing.detail}) — creating nothing`;
    report.missing = plan.unknown;
    return report;
  }
  for (const user of plan.keep) {
    const known = listing.keys?.[user];
    if (known) {
      report.keys[user] = known;
      report.kept.push(user);
      log(`openviking: user ${user} already exists — keeping its existing key (never rotated)`);
    } else {
      report.missing.push(user);
      report.ok = false;
      log(
        `openviking: user ${user} already exists but the server did not hand back its key — NOT rotating`,
      );
    }
  }
  for (const user of plan.create) {
    const created = await createUser({ base, account, user, rootKey, fetchFn });
    if (!created.ok) {
      report.missing.push(user);
      report.ok = false;
      log(`openviking: could not create user ${user} (${created.detail})`);
      continue;
    }
    if (created.key) {
      report.keys[user] = created.key;
      report.created.push(user);
      log(`openviking: user ${user} created and its key minted`);
      continue;
    }
    // Created (or raced into existence) without a key in the response: ask the
    // listing rather than issuing a second key.
    const after = await listUsers({ base, account, rootKey, fetchFn });
    const known = after.keys?.[user];
    if (known) {
      report.keys[user] = known;
      (created.existed ? report.kept : report.created).push(user);
    } else {
      report.missing.push(user);
      report.ok = false;
      log(`openviking: user ${user} exists but no key could be read back — NOT rotating`);
    }
  }
  return report;
}

/**
 * Does this key reach this user's tree? Reuses the confinement proof's own
 * request shape and verdict logic (`scripts/companion-memory-forward.mjs`) so
 * there is exactly ONE definition of reach/refusal/inconclusive in the repo.
 */
export async function probeKey({
  base,
  key,
  user,
  fetchFn = /** @type {OvFetch} */ (fetch),
  env = process.env,
  timeoutMs = DEFAULTS.requestTimeoutMs,
}) {
  // Namespace in the URI — the server confines by URI, not by the header
  // (verified live 2026-08-25; see PATHS.readUri in the forward).
  const url = `${base}${PATHS.read(env)}?uri=${encodeURIComponent(PATHS.readUri(env, user))}`;
  const r = await call(
    fetchFn,
    url,
    { method: "GET", headers: authHeaders(key, user, env) },
    timeoutMs,
  );
  return {
    classification: classify(r.status, r.body),
    status: r.status,
    detail: r.error ?? `HTTP ${r.status}`,
  };
}

// ---- the temporary server ---------------------------------------------------
//
// The entrypoint runs this BEFORE the daemon exists, so there is no server to
// talk to yet. Rather than background a second long-lived process (the
// container keeps ONE supervised process tree), provisioning starts the server
// itself, provisions, and stops it again — all inside this one foreground step.

export function serverArgv(cfg) {
  return ["--config", cfg.config, "--host", cfg.host, "--port", String(cfg.port)];
}

export async function waitForReady({
  base,
  fetchFn = /** @type {OvFetch} */ (fetch),
  timeoutMs = DEFAULTS.readyTimeoutMs,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const r = await call(fetchFn, `${base}/ready`, { method: "GET", headers: {} }, 2000);
    if (r.status >= 200 && r.status < 300) return true;
    if (now() >= deadline) return false;
    await sleep(500);
  }
}

/**
 * The engine's own rule for one `/ready` check value (openviking 0.4.15,
 * server/routers/system.py `_is_ready_check_ok`): ok, not configured or not
 * supported — nested `{status, checks}` maps all the way down.
 *
 * @param {unknown} v
 * @returns {boolean}
 */
export function readyCheckOk(v) {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = /** @type {{ status?: unknown, checks?: unknown }} */ (v);
    if (o.status !== "ok" && o.status !== "not_configured" && o.status !== "not_supported")
      return false;
    if (o.checks === null || o.checks === undefined) return true;
    if (typeof o.checks !== "object") return false;
    return Object.values(/** @type {Record<string, unknown>} */ (o.checks)).every(readyCheckOk);
  }
  return v === "ok" || v === "not_configured" || v === "not_supported";
}

/**
 * Is a `/ready` answer the server saying it is up in every respect BUT its
 * embedder (S4)? The failing `embedding` check's text, or null. The
 * engine is then initialized, its filesystem, vector store and key manager
 * answer — everything provisioning's admin API needs, none of which embeds.
 *
 * @param {unknown} body
 * @returns {string | null}
 */
export function readyButEmbedding(body) {
  if (!body || typeof body !== "object") return null;
  const b = /** @type {{ status?: unknown, checks?: unknown }} */ (body);
  if (b.status !== "not_ready" || !b.checks || typeof b.checks !== "object") return null;
  const checks = /** @type {Record<string, unknown>} */ (b.checks);
  if (!("embedding" in checks) || readyCheckOk(checks.embedding)) return null;
  for (const [name, value] of Object.entries(checks))
    if (name !== "embedding" && !readyCheckOk(value)) return null;
  return typeof checks.embedding === "string" ? checks.embedding : JSON.stringify(checks.embedding);
}

/**
 * Wait until the provisioning server can PROVISION: `/ready` passes, or fails
 * on nothing but its embedding check. Provisioning only uses the admin API, so
 * a dead embedder must not also leave the users and keys unwritten — that
 * would surface downstream as an auth failure instead of an embedder fault.
 * `{ ready, embedding }` — `embedding` is the failing check's text when that
 * is what was let through.
 *
 * Each `/ready` call gets `READY_PROBE_CALL_MS`, not the 2 s `waitForReady`
 * gives: with its embedder unreachable, 0.4.15's `/ready` answers only once
 * its own embedding probe gives up — measured at 9.5 s against a real server
 * (the engine bounds that probe at 10 s). A 2 s call never saw the answer.
 */
export const READY_PROBE_CALL_MS = 15_000;

export async function waitForProvisionable({
  base,
  fetchFn = /** @type {OvFetch} */ (fetch),
  timeoutMs = DEFAULTS.readyTimeoutMs,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const r = await call(
      fetchFn,
      `${base}/ready`,
      { method: "GET", headers: {} },
      READY_PROBE_CALL_MS,
    );
    if (r.status >= 200 && r.status < 300) return { ready: true, embedding: null };
    const embedding = readyButEmbedding(r.body);
    if (embedding !== null) return { ready: true, embedding };
    if (now() >= deadline) return { ready: false, embedding: null };
    await sleep(500);
  }
}

// ---- the local English embedder (S4) --------------------------------
//
// Under `embedding_provider = "local"` the server embeds through an
// OpenAI-compatible service on loopback (scripts/openviking-embedder.py), and
// its `/ready` probes that service — so a provisioning server started without
// it never becomes ready. The boot therefore runs the embedder FIRST, for
// exactly as long as it runs the server, and stops both: still one foreground
// step, nothing left running for the daemon to trip over (the daemon
// supervises its own long-lived pair). The same helpers serve the re-embed
// script's `rehearse`. src/openviking/embedder.ts builds the daemon's argv;
// tests/openviking-embedder.test.ts holds the two spellings together.

/** The line the service prints once it serves (its own READY_PREFIX). */
export const EMBEDDER_READY_PREFIX = "openviking-embedder: ready";

/**
 * @typedef {{ python: string, script: string, model: string, file: string, sha256: string, port: number, threads: number }} EmbedderSpec
 */

/** The service's argv after the interpreter — loopback, always. */
export function embedderArgv(spec) {
  return [
    spec.script,
    "--model-path",
    spec.file,
    "--model-name",
    spec.model,
    "--sha256",
    spec.sha256,
    "--host",
    "127.0.0.1",
    "--port",
    String(spec.port),
    "--threads",
    String(spec.threads),
  ];
}

/** `http://127.0.0.1:<port>` — where the service's `/health` answers. */
export function embedderBase(spec) {
  return `http://127.0.0.1:${spec.port}`;
}

/**
 * The spec out of `--embedder-*` flags, or `null` when none was given (a
 * hosted embedder: nothing to run). A partial set is an error string, never a
 * guessed default — the boot renders all seven or none.
 *
 * @param {Map<string, string>} flags
 * @returns {EmbedderSpec | null | string}
 */
export function embedderSpecFromFlags(flags) {
  const keys = ["python", "script", "model", "file", "sha256", "port", "threads"];
  const given = keys.filter((k) => flags.has(`embedder-${k}`));
  if (given.length === 0) return null;
  const missing = keys.filter(
    (k) => !flags.get(`embedder-${k}`) || flags.get(`embedder-${k}`) === "true",
  );
  if (missing.length) return `the local embedder needs --embedder-${missing.join(", --embedder-")}`;
  const port = Number(flags.get("embedder-port"));
  const threads = Number(flags.get("embedder-threads"));
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    return `--embedder-port ${flags.get("embedder-port")} is not a port`;
  if (!Number.isInteger(threads) || threads < 1)
    return `--embedder-threads ${flags.get("embedder-threads")} is not a thread count`;
  return {
    python: String(flags.get("embedder-python")),
    script: String(flags.get("embedder-script")),
    model: String(flags.get("embedder-model")),
    file: String(flags.get("embedder-file")),
    sha256: String(flags.get("embedder-sha256")),
    port,
    threads,
  };
}

/** The service's own exit codes (scripts/openviking-embedder.py), named. */
const EMBEDDER_EXIT_MEANING = {
  2: "it refused its arguments",
  3: "its model file is missing or does not match the pinned sha256",
  4: "the model would not load or failed its self-check",
};

/**
 * Has the child gone — exited, been killed, or never started? A phrase, or
 * null while it runs. A spawn failure emits `error` and never sets an exit
 * code, so the caller passes what its `error` listener saw.
 *
 * @param {{ exitCode: number | null, signalCode: string | null }} child
 * @param {string | null} spawnError
 */
export function embedderGone(child, spawnError = null) {
  if (spawnError) return `it could not be started (${spawnError})`;
  if (child.exitCode !== null && child.exitCode !== undefined) {
    const meaning = EMBEDDER_EXIT_MEANING[child.exitCode];
    return `it exited with code ${child.exitCode}${meaning ? ` — ${meaning}` : ""}`;
  }
  if (child.signalCode) return `it was killed by ${child.signalCode}`;
  return null;
}

/**
 * Poll the service's `/health` until it answers 200, the child is gone, or
 * the deadline passes. `{ ready, gone }` — `gone` says how a child that died
 * died, so a refused start (a sha256 mismatch exits in under a second) ends
 * the wait at once instead of costing the boot the whole timeout.
 *
 * @param {{ base: string, gone?: () => string | null, fetchFn?: OvFetch, timeoutMs?: number, sleep?: (ms: number) => Promise<unknown>, now?: () => number }} opts
 * @returns {Promise<{ ready: boolean, gone: string | null }>}
 */
export async function waitForEmbedder({
  base,
  gone = () => null,
  fetchFn = /** @type {OvFetch} */ (fetch),
  timeoutMs = DEFAULTS.readyTimeoutMs,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const before = gone();
    if (before) return { ready: false, gone: before };
    const r = await call(fetchFn, `${base}/health`, { method: "GET", headers: {} }, 2000);
    if (r.status === 200) return { ready: true, gone: null };
    const after = gone();
    if (after) return { ready: false, gone: after };
    if (now() >= deadline) return { ready: false, gone: null };
    await sleep(250);
  }
}

/**
 * Start the service for a foreground step and wait until it serves. Never
 * throws: `{ child, ready, detail }` — a missing model file or interpreter is
 * reported (`ready: false`, no child) rather than spawned into a crash. The
 * child is unref'd, like the provisioning server, so it can never be what
 * keeps node alive; the caller stops it with `stopServerChild`.
 *
 * The seams are typed by their use, not by node's overloads (see `OvFetch`).
 *
 * @typedef {{ pid?: number, exitCode: number | null, signalCode: string | null, on?: (event: "error", cb: (err: Error) => void) => unknown, once: (event: "exit", cb: () => void) => unknown, removeListener?: (event: "exit", cb: () => void) => unknown, unref?: () => void, kill: (signal?: NodeJS.Signals) => boolean }} EmbedderChild
 * @param {EmbedderSpec} spec
 * @param {{ log?: (line: string) => void, readyTimeoutMs?: number, spawnFn?: (cmd: string, args: string[], opts: { stdio: ["ignore", "inherit", "inherit"] }) => EmbedderChild, exists?: (path: string) => boolean, fetchFn?: OvFetch, sleep?: (ms: number) => Promise<unknown> }} [opts]
 * @returns {Promise<{ child: EmbedderChild | null, ready: boolean, detail: string }>}
 */
export async function startEmbedder(
  spec,
  {
    log = (line) => console.log(line),
    readyTimeoutMs = DEFAULTS.readyTimeoutMs,
    spawnFn = (cmd, args, opts) => spawn(cmd, args, opts),
    exists = existsSync,
    fetchFn,
    sleep,
  } = {},
) {
  for (const [what, path] of [
    ["interpreter", spec.python],
    ["service script", spec.script],
    ["model file", spec.file],
  ]) {
    if (!exists(path)) {
      const detail = `the local embedder's ${what} ${path} does not exist${what === "model file" ? " — the image carries it; this image predates it (scripts/deploy.sh rebuild)" : ""}`;
      log(`openviking: ${detail}`);
      return { child: null, ready: false, detail };
    }
  }
  const child = spawnFn(spec.python, embedderArgv(spec), {
    stdio: ["ignore", "inherit", "inherit"],
  });
  /** @type {string | null} */
  let spawnError = null;
  child.on?.("error", (err) => {
    spawnError = err.message;
    log(`openviking: could not start the local embedder (${err.message})`);
  });
  child.unref?.();
  const waited = await waitForEmbedder({
    base: embedderBase(spec),
    gone: () => embedderGone(child, spawnError),
    timeoutMs: readyTimeoutMs,
    ...(fetchFn ? { fetchFn } : {}),
    ...(sleep ? { sleep } : {}),
  });
  const detail = waited.ready
    ? `local embedder ${spec.model} serving on ${embedderBase(spec)}`
    : waited.gone
      ? `the local embedder did not come up on ${embedderBase(spec)}: ${waited.gone} — see its log above`
      : `the local embedder never answered on ${embedderBase(spec)} — see its log above`;
  log(`openviking: ${detail}`);
  return { child, ready: waited.ready, detail };
}

// ---- orchestration ----------------------------------------------------------

/**
 * One provisioning pass against a server that is already up. Pure of process
 * management, so the test drives it with a fake fetch.
 *
 * Returns a report; NEVER throws.
 */
export async function provision({
  base,
  account,
  users,
  rootKey,
  reviewerKey,
  reviewerUser = "reviewer",
  fetchFn = /** @type {OvFetch} */ (fetch),
  env = process.env,
  log = console.log,
}) {
  const report = {
    created: [],
    kept: [],
    failed: [],
    reviewer: "skipped",
    ok: true,
    // every failure as a sentence, for the report file the daemon
    // reads — the boot log alone reached nobody.
    errors: [],
  };
  const fail = (line) => {
    log(line);
    report.errors.push(line.replace(/^openviking: /, ""));
    report.ok = false;
  };
  if (!rootKey) {
    fail(
      "openviking: no root key in the secrets mount — users NOT provisioned; memory degrades until one is",
    );
    return report;
  }
  const listing = await listUsers({ base, account, rootKey, fetchFn });
  const plan = planProvision(listing.users, users);
  if (plan.unknown.length > 0) {
    fail(
      `openviking: could not read the user listing (${listing.detail}) — creating nothing, leaving ${plan.unknown.join(", ")} as they are`,
    );
  }
  for (const user of plan.keep) {
    log(`openviking: user ${user} already provisioned — left untouched (keys are never rotated)`);
    report.kept.push(user);
  }
  for (const user of plan.create) {
    const r = await createUser({ base, account, user, rootKey, fetchFn });
    if (r.ok) {
      log(`openviking: user ${user} ${r.existed ? "already existed" : "created"}`);
      (r.existed ? report.kept : report.created).push(user);
    } else {
      report.failed.push(user);
      fail(
        `openviking: could not create user ${user} (${r.detail}) — memory for that user degrades until it exists`,
      );
    }
  }
  // The reviewer key is the ONE client credential this container may hold. We
  // check that it works; we never mint or replace it — issuing keys is a human
  // step in the deploy window, precisely because a minted key has to reach
  // the owner's PC and must not be written anywhere a review session can read.
  if (reviewerKey) {
    const probe = await probeKey({ base, key: reviewerKey, user: reviewerUser, fetchFn, env });
    report.reviewer = probe.classification;
    if (probe.classification === "reach") {
      log(`openviking: the reviewer key authenticates against user/${reviewerUser}`);
    } else {
      fail(
        `openviking: the reviewer key does NOT authenticate against user/${reviewerUser} (${probe.classification}, ${probe.detail}) — ` +
          "memory degrades until the key and the server agree. NOT rotating: that would orphan the distributed key.",
      );
    }
  } else {
    fail(
      "openviking: no reviewer key in the secrets mount — the daemon and every review session start memory-less",
    );
  }
  return report;
}

// ---- the report file (S1) ---------------------------------------------
//
// What this run found, for the DAEMON to read at boot (src/openviking/
// provisionreport.ts → status.json `memory.provision`, and a
// `memory_provision_failed` wake on a failure or a recreated user). The boot
// log said all of this before and reached nobody. Never carries a key.

/** Where the report goes by default: `<sandbox>/state/openviking/provision.json`
 * — the daemon resolves the same path from its own root, so neither entrypoint
 * has to pass it (a sync, not a rebuild, ships this). */
export function provisionReportPath(root = ROOT) {
  return join(root, "state", "openviking", "provision.json");
}

/**
 * The report body: the verdict, what was created / kept / not ensured, the
 * reviewer key's classification, and every failure as a sentence.
 *
 * @param {{ ok?: boolean, created?: string[], kept?: string[], failed?: string[], reviewer?: string, errors?: string[] }} report
 * @param {{ users?: string[], at?: string }} [opts]
 */
export function provisionReportBody(report, { users = [], at = new Date().toISOString() } = {}) {
  return {
    version: 1,
    at,
    ok: report.ok === true,
    users: [...users],
    created: [...(report.created ?? [])],
    kept: [...(report.kept ?? [])],
    failed: [...(report.failed ?? [])],
    reviewer: report.reviewer ?? "skipped",
    errors: [...(report.errors ?? [])],
  };
}

/**
 * Atomic write (temp + rename). Never throws: a report that cannot be written
 * is a log line — provisioning must not block the boot over its own receipt.
 *
 * @param {string} path
 * @param {unknown} body
 * @param {(line: string) => void} [log]
 */
export function writeProvisionReport(path, body, log = console.log) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`);
    renameSync(tmp, path);
    return true;
  } catch (err) {
    log(
      `openviking: could not write the provisioning report ${path} (${err instanceof Error ? err.message : String(err)})`,
    );
    return false;
  }
}

// ---- cli --------------------------------------------------------------------

export function parseArgs(argv, env = process.env) {
  const flags = new Map();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const [name, inline] = a.slice(2).split("=", 2);
    if (inline !== undefined) flags.set(name, inline);
    else if (argv[i + 1] && !argv[i + 1].startsWith("--")) flags.set(name, argv[++i]);
    else flags.set(name, "true");
  }
  const port = Number(flags.get("port") ?? 1933);
  return {
    base: flags.get("base") ?? env.QCR_OV_BASE ?? DEFAULTS.base,
    account: flags.get("account") ?? env.QCR_OV_ADMIN_ACCOUNT ?? DEFAULTS.account,
    users: flags.has("users") ? parseUserList(flags.get("users")) : DEFAULTS.users,
    rootKeyFile: flags.get("root-key-file") ?? "",
    reviewerKeyFile: flags.get("reviewer-key-file") ?? "",
    reviewerUser: flags.get("reviewer-user") ?? "reviewer",
    startServer: flags.has("start-server"),
    bin: flags.get("bin") ?? "",
    config: flags.get("config") ?? "",
    host: flags.get("host") ?? "127.0.0.1",
    port,
    readyTimeoutMs: Number(flags.get("ready-timeout-ms") ?? DEFAULTS.readyTimeoutMs),
    strict: flags.has("strict"),
    // where the report lands; default beside the daemon's state.
    reportPath: flags.get("report") ?? env.QCR_OV_PROVISION_REPORT ?? provisionReportPath(),
    // the local embedder the server's `/ready` depends on — a
    // spec, `null` (hosted: nothing to run) or an error string.
    embedder: embedderSpecFromFlags(flags),
  };
}

/** Grace between SIGTERM and SIGKILL for the temporary provisioning server. */
export const SERVER_STOP_GRACE_MS = 5000;

/**
 * Stop the temporary server child WITHOUT ever wedging the boot: SIGTERM,
 * a bounded wait, then SIGKILL — and the child is unref'd, so even a process
 * that somehow survives SIGKILL (e.g. stuck in uninterruptible IO) cannot keep
 * the node event loop alive. Before this existed, a server that trapped
 * SIGTERM kept node alive forever and the entrypoint's `|| true` never fired
 * because node never exited: the container boot hung.
 *
 * Returns what happened, for tests and the boot log: "absent",
 * "already-exited", "terminated" (exited within the grace) or "killed".
 */
export async function stopServerChild(child, { graceMs = SERVER_STOP_GRACE_MS } = {}) {
  if (!child) return "absent";
  child.unref?.();
  if (child.exitCode !== null || child.signalCode !== null) return "already-exited";
  try {
    child.kill("SIGTERM");
  } catch {
    return "already-exited";
  }
  const exited = await new Promise((resolve) => {
    // The SIGTERM above may have taken effect before this listener exists
    // (a fast child, or a test double that exits synchronously).
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    // The grace timer is deliberately NOT unref'd (S4): with the child
    // unref'd, nothing else holds the event loop, and node used to exit
    // mid-await — so the NEXT stop (the embedder, after the server) never sent
    // its SIGTERM and the boot left an unsupervised embedder on the daemon's
    // port. A ref'd timer holds node for at most `graceMs`, so it still cannot
    // wedge the boot; the child itself stays unref'd for a SIGKILL survivor.
    const timer = setTimeout(() => {
      child.removeListener?.("exit", onExit);
      resolve(false);
    }, graceMs);
    child.once("exit", onExit);
  });
  if (exited) return "terminated";
  try {
    child.kill("SIGKILL");
  } catch {
    /* raced its own exit — fine either way */
  }
  return "killed";
}

async function main(argv) {
  const cfg = parseArgs(argv);
  const log = (line) => console.log(line);
  // what the local embedder did, carried into EVERY report — so a
  // person reading it (status.json `memory.provision`) learns the embedder
  // failed, never only that something downstream did.
  /** @type {string[]} */
  const notes = [];
  // Every exit path below leaves a report for the daemon — the early ones too:
  // "provisioning never ran" is exactly what a person must hear about.
  const finish = (report) =>
    writeProvisionReport(
      cfg.reportPath,
      provisionReportBody(
        { ...report, errors: [...new Set([...(report.errors ?? []), ...notes])] },
        { users: cfg.users },
      ),
      log,
    );
  const failed = (line) => {
    log(line);
    return {
      created: [],
      kept: [],
      failed: [],
      reviewer: "skipped",
      ok: false,
      errors: [line.replace(/^openviking: /, "")],
    };
  };
  let child;
  let embedder = null;
  if (cfg.startServer) {
    if (!cfg.bin || !cfg.config) {
      finish(failed("openviking: --start-server needs --bin and --config — skipping provisioning"));
      return cfg.strict ? 1 : 0;
    }
    if (typeof cfg.embedder === "string") {
      finish(failed(`openviking: ${cfg.embedder} — skipping provisioning`));
      return cfg.strict ? 1 : 0;
    }
    if (cfg.embedder) {
      // The server's /ready probes its embedder: start that first. A dead one
      // is logged and provisioning carries on — the admin API needs no
      // embedding (waitForProvisionable), and the report names the failure.
      // The daemon's own supervisor then runs the long-lived embedder, and
      // memory health wakes on it if it stays dead (memory.serving).
      const started = await startEmbedder(cfg.embedder, {
        log,
        readyTimeoutMs: cfg.readyTimeoutMs,
      });
      embedder = started.child;
      if (!started.ready) notes.push(started.detail);
    }
    child = spawn(cfg.bin, serverArgv(cfg), { stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", (err) =>
      log(`openviking: could not start the provisioning server (${err.message})`),
    );
    // The child must never be what keeps node alive: the entrypoint's
    // `|| true` only fires once node EXITS.
    child.unref?.();
    const waited = await waitForProvisionable({ base: cfg.base, timeoutMs: cfg.readyTimeoutMs });
    if (waited.embedding !== null) {
      const note = `the provisioning server's embedding check fails (${waited.embedding.slice(0, 300)}) — users provisioned regardless; memory search fails until an embedder serves`;
      log(`openviking: ${note}`);
      notes.push(note);
    }
    if (!waited.ready) {
      finish(
        failed(
          "openviking: the provisioning server never became ready — users NOT provisioned; the daemon still supervises the real one",
        ),
      );
      await stopServerChild(child);
      await stopServerChild(embedder);
      return cfg.strict ? 1 : 0;
    }
  }
  let report = failed("openviking: provisioning did not complete");
  try {
    report = await provision({
      base: cfg.base,
      account: cfg.account,
      users: cfg.users,
      rootKey: readSecret(cfg.rootKeyFile),
      reviewerKey: readSecret(cfg.reviewerKeyFile),
      reviewerUser: cfg.reviewerUser,
      log,
    });
  } finally {
    finish(report);
    // Bounded stop: SIGTERM → grace → SIGKILL, child unref'd. A server that
    // traps SIGTERM must not keep node's event loop (and the container boot)
    // alive forever. The embedder goes last: the server may still be
    // vectorizing on its way down.
    await stopServerChild(child);
    await stopServerChild(embedder);
  }
  return report.ok || !cfg.strict ? 0 : 1;
}

const invokedDirectly = (() => {
  try {
    return (
      process.argv[1] !== undefined &&
      import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
    );
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      if (typeof code === "number" && code !== 0) process.exit(code);
    })
    .catch((err) => {
      // Never a non-zero exit on an unexpected throw: memory must not block the
      // boot. Say what happened and let the daemon come up memory-less.
      console.log(
        `openviking: provisioning failed (${err instanceof Error ? err.message : String(err)}) — the daemon starts memory-less`,
      );
    });
}
