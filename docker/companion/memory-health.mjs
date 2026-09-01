#!/usr/bin/env node
// In-container memory health watcher.
//
// The companion reaches OpenViking through a chain it does not own — docker
// bridge → the host-side ssh forward (systemd --user on the owner's PC) → the
// `quickreview-sandbox` container on the VM → the server on its loopback. Any
// link can be down, and when one is, the companion must SAY SO and keep
// working. This watcher is the "say so" half:
//
//   * it probes `<endpoint>/health` then `/ready` on a timer,
//   * on a sustained transition it writes ONE alert file into /alerts, in the
//     schema prompts/companion.md fixes and src/tui/alerts.ts parses — so the
//     existing alert policy (per-cause cooldown, status line, notify-send,
//     overseer inject) carries it with no new pipeline,
//   * it never touches pi. A wedged memory engine must never wedge the
//     conversation: the extension degrades, this process narrates.
//
// It is deliberately a plain .mjs with zero imports beyond node builtins: it
// runs as a background process of the container entrypoint, long before (and
// independently of) any repo build.
import { mkdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Consecutive failed probes before "unreachable" is believed. One blip during
 * an ssh reconnect is not an outage; three in a row is. */
export const FAIL_THRESHOLD = 3;
export const DEFAULT_INTERVAL_S = 60;
export const DEFAULT_TIMEOUT_MS = 4000;

/** A deploy recreates the VM container and restarts the host forward, so the
 * memory chain is EXPECTED down for a few minutes — long enough that the
 * 3×60s threshold fired on every single deploy (the owner, 2026-08-27: "on
 * EVERY deploy"). deploy.sh stamps this marker into the alerts dir (a live
 * bind mount, so it appears here instantly) when its disruptive phase starts
 * and deletes it once the chain answers again; while the marker's mtime is
 * younger than the grace, a "down" transition is HELD rather than announced.
 * The marker only absorbs the deploy window: an outage that outlives the
 * grace alerts on the next failed probe, and with no marker nothing changes.
 * Dotfile on purpose — AlertConsumer skips dotfiles, so the marker can never
 * be mistaken for an alert. */
export const DEPLOY_MARKER = ".deploy-window.json";
export const DEPLOY_GRACE_MS = 10 * 60 * 1000;

/** Is a deploy window open? Never throws: no marker (or an unreadable one)
 * means no grace. mtime is the signal — the stamp refreshes it.
 *
 * `statFn` is declared by the one field this reads, not as `typeof statSync`
 * (whose overloads make every stub uncompilable) — same reasoning as `probe`.
 *
 * @param {string} dir
 * @param {number} nowMs
 * @param {number} [graceMs]
 * @param {(path: string) => { mtimeMs: number }} [statFn]
 */
export function deployGraceActive(dir, nowMs, graceMs = DEPLOY_GRACE_MS, statFn = statSync) {
  try {
    const age = nowMs - statFn(join(dir, DEPLOY_MARKER)).mtimeMs;
    return age >= 0 && age < graceMs;
  } catch {
    return false;
  }
}

export const CAUSE_DOWN = "companion-memory-unreachable";
export const CAUSE_UP = "companion-memory-restored";

/** @typedef {{ ok: boolean, reason: string }} Sample */
/** @typedef {{ fails: number, announced: "down" | "up" | null }} WatchState */

/** @returns {WatchState} */
export function initialState() {
  return { fails: 0, announced: null };
}

/**
 * Pure transition. Returns the next state and what (if anything) to announce.
 * Only TRANSITIONS are announced: a memory engine that stays down produces one
 * alert, not one per minute (and the policy's cooldown is a second net).
 *
 * A deploy-grace window (`inGrace`) holds the "down" announcement without
 * touching the failure count: the threshold stays crossed, so the moment the
 * grace lapses a still-dead chain announces on the very next failed sample.
 *
 * @param {WatchState} state
 * @param {Sample} sample
 * @param {boolean} [inGrace]
 * @returns {{ state: WatchState, emit: "down" | "up" | null }}
 */
export function decide(state, sample, inGrace = false) {
  if (sample.ok) {
    const emit = state.announced === "down" ? "up" : null;
    return { state: { fails: 0, announced: emit === "up" ? "up" : state.announced }, emit };
  }
  const fails = state.fails + 1;
  if (fails >= FAIL_THRESHOLD && state.announced !== "down" && !inGrace) {
    return { state: { fails, announced: "down" }, emit: "down" };
  }
  return { state: { fails, announced: state.announced }, emit: null };
}

/**
 * The alert file body. `alert` tier for an outage (status line + notify-send +
 * overseer inject), `notice` for the recovery — a restored engine is news, not
 * an emergency.
 *
 * @param {"down" | "up"} kind
 * @param {{ endpoint: string, reason: string, at: string, fails: number }} ctx
 */
export function alertBody(kind, ctx) {
  if (kind === "down") {
    return {
      tier: "alert",
      cause: CAUSE_DOWN,
      pr: null,
      title: "memory unreachable — running without it",
      body:
        `OpenViking did not answer at ${ctx.endpoint} on ${ctx.fails} consecutive probes (${ctx.reason}). ` +
        `Memory reads and writes will fail until it is back; everything else keeps working. ` +
        `Check the host forward first: systemctl --user status qcr-memory-forward.`,
      ts: ctx.at,
    };
  }
  return {
    tier: "notice",
    cause: CAUSE_UP,
    pr: null,
    title: "memory reachable again",
    body: `OpenViking answered at ${ctx.endpoint}. Anything you wanted remembered during the outage was not written — re-say it if it mattered.`,
    ts: ctx.at,
  };
}

/** Sortable, unique-enough alert file name (the consumer sorts by name). */
export function alertFileName(at, cause) {
  return `${at.replace(/[:.]/g, "-")}-${cause}.json`;
}

/** tmp+rename so the TUI never reads a half-written alert; the tmp name starts
 * with "." because AlertConsumer skips dotfiles. */
export function writeAlertFile(dir, body) {
  mkdirSync(dir, { recursive: true });
  const name = alertFileName(body.ts, body.cause);
  const tmp = join(dir, `.${name}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`);
  renameSync(tmp, join(dir, name));
  return name;
}

/**
 * One probe. Never throws: every outcome is a Sample.
 * `/ready` is the gate (never `doctor` — it exits 1 with no vlm configured,
 * which is our normal state), `/health` first because a refused connection
 * makes the second call pointless.
 *
 * The `fetchFn` seam is declared by the MINIMUM this function reads — a status
 * and an ok flag — not as `typeof fetch`: the default binds it to the global,
 * and a seam typed by its implementation rather than by its use forces every
 * test double to fabricate a whole `Response`.
 *
 * @param {string} endpoint
 * @param {number} [timeoutMs]
 * @param {(url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean, status: number }>} [fetchFn]
 * @returns {Promise<Sample>}
 */
export async function probe(endpoint, timeoutMs = DEFAULT_TIMEOUT_MS, fetchFn = fetch) {
  try {
    const health = await fetchFn(`${endpoint}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!health.ok) return { ok: false, reason: `health ${health.status}` };
  } catch (err) {
    return { ok: false, reason: errText(err) };
  }
  try {
    const ready = await fetchFn(`${endpoint}/ready`, { signal: AbortSignal.timeout(timeoutMs) });
    return ready.ok ? { ok: true, reason: "ready" } : { ok: false, reason: `ready ${ready.status}` };
  } catch (err) {
    return { ok: false, reason: errText(err) };
  }
}

function errText(err) {
  if (err instanceof Error) return err.name === "TimeoutError" || err.name === "AbortError" ? "timeout" : err.message;
  return String(err);
}

/** Config from the container env — all of it optional. No endpoint configured
 * means the memory path was never wired, which is silence, not an alert. */
export function watcherConfig(env) {
  const endpoint = (env.QCR_MEMORY_ENDPOINT || env.OPENVIKING_URL || env.OPENVIKING_BASE_URL || "").trim().replace(/\/+$/, "");
  const interval = Number(env.QCR_MEMORY_PROBE_INTERVAL_S || DEFAULT_INTERVAL_S);
  return {
    endpoint,
    alertsDir: (env.QCR_MEMORY_ALERTS_DIR || env.QCR_ALERTS_DIR || "/alerts").trim(),
    intervalMs: Number.isFinite(interval) && interval > 0 ? interval * 1000 : DEFAULT_INTERVAL_S * 1000,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
}

export async function runWatcher(cfg, opts = {}) {
  const log = opts.log ?? ((line) => console.log(`[memory-health] ${line}`));
  const fetchFn = opts.fetchFn ?? fetch;
  const now = opts.now ?? (() => new Date());
  let state = initialState();
  const tick = async () => {
    const sample = await probe(cfg.endpoint, cfg.timeoutMs, fetchFn);
    const inGrace = !sample.ok && deployGraceActive(cfg.alertsDir, now().getTime());
    const next = decide(state, sample, inGrace);
    state = next.state;
    if (inGrace && state.fails >= FAIL_THRESHOLD && state.announced !== "down") {
      log(`unreachable ×${state.fails} (${sample.reason}) — deploy window open, holding the alert`);
    }
    if (next.emit) {
      const at = now().toISOString();
      const body = alertBody(next.emit, { endpoint: cfg.endpoint, reason: sample.reason, at, fails: state.fails });
      try {
        log(`${next.emit === "down" ? "unreachable" : "restored"} (${sample.reason}) → ${writeAlertFile(cfg.alertsDir, body)}`);
      } catch (err) {
        // An unwritable alerts dir is not worth dying over; the log line is
        // still in `docker logs`.
        log(`could not write alert file: ${errText(err)}`);
      }
    }
    return next.emit;
  };
  if (opts.once) return tick();
  log(`watching ${cfg.endpoint} every ${cfg.intervalMs / 1000}s → ${cfg.alertsDir}`);
  for (;;) {
    await tick().catch((err) => log(`probe cycle failed: ${errText(err)}`));
    await new Promise((r) => setTimeout(r, cfg.intervalMs));
  }
}

// ---- entry point ------------------------------------------------------------

// Importing this file (the tests do) must not start a watcher.
const invokedDirectly = (() => {
  try {
    return process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  const cfg = watcherConfig(process.env);
  if (cfg.endpoint === "") {
    console.log("[memory-health] no QCR_MEMORY_ENDPOINT — memory path not wired, watcher idle");
    process.exit(0);
  }
  runWatcher(cfg).catch((err) => {
    console.error(`[memory-health] fatal: ${errText(err)}`);
    process.exit(1);
  });
}
