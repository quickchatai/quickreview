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
// MEMORY NEVER BLOCKS THE BOOT. Every failure here is a log line and exit 0:
// an unprovisioned server means memory degrades (401s, reported once per
// client, alerted through the existing gap path), never a reviewer that does
// not come up. `--strict` (tests, manual runs) is the only way to get a
// non-zero exit.
//
// Zero dependencies and plain JS on purpose: the entrypoint runs it before the
// TypeScript build, on a container that may have no `dist/` yet.
import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
  let list = Array.isArray(body) ? body
    : Array.isArray(body?.result) ? body.result
    : Array.isArray(body?.data) ? body.data
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
  return { create: seen.filter((u) => !have.has(u)), keep: seen.filter((u) => have.has(u)), unknown: [] };
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
export async function listUsers({ base, account, rootKey, fetchFn = fetch, timeoutMs = DEFAULTS.requestTimeoutMs }) {
  const r = await call(fetchFn, `${base}${adminUsersPath(account)}`, { method: "GET", headers: adminHeaders(rootKey) }, timeoutMs);
  if (r.status < 200 || r.status >= 300) return { users: null, status: r.status, detail: r.error ?? `HTTP ${r.status}` };
  if (r.body && typeof r.body === "object" && r.body.status === "error") {
    return { users: null, status: r.status, detail: `error envelope: ${String(r.body.error?.message ?? r.body.error ?? "")}` };
  }
  return { users: usersFromListing(r.body), status: r.status, detail: `HTTP ${r.status}` };
}

/** Create ONE user. A 409 is success: the user already exists. */
export async function createUser({ base, account, user, rootKey, fetchFn = fetch, timeoutMs = DEFAULTS.requestTimeoutMs }) {
  const r = await call(
    fetchFn,
    `${base}${adminUsersPath(account)}`,
    // role is lowercase on the live 0.4.15: uppercase gets INVALID_ARGUMENT
    // "Account user role must be user or admin" (verified 2026-08-25).
    { method: "POST", headers: adminHeaders(rootKey), body: JSON.stringify({ user_id: user, user, role: "user" }) },
    timeoutMs,
  );
  if (r.status === 409) return { ok: true, existed: true, detail: "HTTP 409 — already present" };
  if (r.status >= 200 && r.status < 300 && !(r.body && r.body.status === "error")) {
    return { ok: true, existed: false, detail: `HTTP ${r.status}` };
  }
  return { ok: false, existed: false, detail: r.error ?? `HTTP ${r.status}` };
}

/**
 * Does this key reach this user's tree? Reuses the confinement proof's own
 * request shape and verdict logic (`scripts/companion-memory-forward.mjs`) so
 * there is exactly ONE definition of reach/refusal/inconclusive in the repo.
 */
export async function probeKey({ base, key, user, fetchFn = fetch, env = process.env, timeoutMs = DEFAULTS.requestTimeoutMs }) {
  // Namespace in the URI — the server confines by URI, not by the header
  // (verified live 2026-08-25; see PATHS.readUri in the forward).
  const url = `${base}${PATHS.read(env)}?uri=${encodeURIComponent(PATHS.readUri(env, user))}`;
  const r = await call(fetchFn, url, { method: "GET", headers: authHeaders(key, user, env) }, timeoutMs);
  return { classification: classify(r.status, r.body), status: r.status, detail: r.error ?? `HTTP ${r.status}` };
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

export async function waitForReady({ base, fetchFn = fetch, timeoutMs = DEFAULTS.readyTimeoutMs, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const r = await call(fetchFn, `${base}/ready`, { method: "GET", headers: {} }, 2000);
    if (r.status >= 200 && r.status < 300) return true;
    if (now() >= deadline) return false;
    await sleep(500);
  }
}

// ---- orchestration ----------------------------------------------------------

/**
 * One provisioning pass against a server that is already up. Pure of process
 * management, so the test drives it with a fake fetch.
 *
 * Returns a report; NEVER throws.
 */
export async function provision({ base, account, users, rootKey, reviewerKey, reviewerUser = "reviewer", fetchFn = fetch, env = process.env, log = console.log }) {
  const report = { created: [], kept: [], failed: [], reviewer: "skipped", ok: true };
  if (!rootKey) {
    log("openviking: no root key in the secrets mount — users NOT provisioned; memory degrades until one is");
    report.ok = false;
    return report;
  }
  const listing = await listUsers({ base, account, rootKey, fetchFn });
  const plan = planProvision(listing.users, users);
  if (plan.unknown.length > 0) {
    log(`openviking: could not read the user listing (${listing.detail}) — creating nothing, leaving ${plan.unknown.join(", ")} as they are`);
    report.ok = false;
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
      log(`openviking: could not create user ${user} (${r.detail}) — memory for that user degrades until it exists`);
      report.failed.push(user);
      report.ok = false;
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
      log(
        `openviking: the reviewer key does NOT authenticate against user/${reviewerUser} (${probe.classification}, ${probe.detail}) — ` +
          "memory degrades until the key and the server agree. NOT rotating: that would orphan the distributed key.",
      );
      report.ok = false;
    }
  } else {
    log("openviking: no reviewer key in the secrets mount — the daemon and every review session start memory-less");
    report.ok = false;
  }
  return report;
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
    const timer = setTimeout(() => {
      child.removeListener?.("exit", onExit);
      resolve(false);
    }, graceMs);
    timer.unref?.();
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
  let child;
  if (cfg.startServer) {
    if (!cfg.bin || !cfg.config) {
      log("openviking: --start-server needs --bin and --config — skipping provisioning");
      return cfg.strict ? 1 : 0;
    }
    child = spawn(cfg.bin, serverArgv(cfg), { stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", (err) => log(`openviking: could not start the provisioning server (${err.message})`));
    // The child must never be what keeps node alive: the entrypoint's
    // `|| true` only fires once node EXITS.
    child.unref?.();
    const ready = await waitForReady({ base: cfg.base, timeoutMs: cfg.readyTimeoutMs });
    if (!ready) {
      log("openviking: the provisioning server never became ready — users NOT provisioned; the daemon still supervises the real one");
      await stopServerChild(child);
      return cfg.strict ? 1 : 0;
    }
  }
  let report = { ok: false };
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
    // Bounded stop: SIGTERM → grace → SIGKILL, child unref'd. A server that
    // traps SIGTERM must not keep node's event loop (and the container boot)
    // alive forever.
    await stopServerChild(child);
  }
  return report.ok || !cfg.strict ? 0 : 1;
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
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
      console.log(`openviking: provisioning failed (${err instanceof Error ? err.message : String(err)}) — the daemon starts memory-less`);
    });
}
