#!/usr/bin/env node
// The webhook-ingress tunnel sidecar — a thin wrapper around an
// OFFICIAL tunnel client (cloudflared or ngrok, copied verbatim out of the
// vendor's own image; see Dockerfile.cloudflared / Dockerfile.ngrok).
//
// WHY THIS EXISTS
// ---------------
// A laptop operator has no public hostname. A cloudflared QUICK tunnel gives
// them one for free, with no account and no signup — but it ROTATES: every
// restart of the client mints a new `*.trycloudflare.com` name. The daemon
// handles that (src/webhookheal.ts re-points the GitHub App's own webhook URL
// when the name changes), and this wrapper is the other half of that contract:
// it reads the assigned hostname out of the client's own output and writes it
// to a file on a volume shared with the daemon.
//
// THE FILE CONTRACT (the watcher's, not ours — src/webhookheal.ts):
//   * ONE line, the BARE hostname: no scheme, no port, no path
//     (`abc-def-ghi.trycloudflare.com\n`);
//   * it must satisfy the watcher's HOSTNAME_RE, which is mirrored below and
//     pinned character-for-character by tests/tunnel-sidecar.test.ts;
//   * writes are tmp+rename ATOMIC, so a watcher that wakes mid-write reads
//     either the old name or the new one, never half of either (the watcher
//     also retries a partial read — belt and braces, not a licence to be
//     sloppy);
//   * the file is only rewritten when the hostname actually CHANGES, so a
//     chatty client cannot make the daemon re-point in a loop;
//   * a dead tunnel does NOT delete the file. A stale hostname and no
//     hostname are equally unreachable, and keeping the last known name means
//     a client that comes back on the SAME name costs zero GitHub calls.
//
// NEVER WEDGE THE STACK
// ---------------------
// The tunnel is best-effort infrastructure: the reconcile poll is the
// correctness backbone, and a webhook that never arrives costs latency, not
// correctness. So this process never exits on a tunnel fault — a client that
// dies is restarted on a capped backoff ladder, forever, and a missing
// credential is logged loudly on every attempt and re-read from disk each
// time (drop the file in and the next attempt picks it up; no restart, no
// crash loop).
//
// SECRETS NEVER REACH AN ARGV (house rule). The ngrok authtoken and the named
// tunnel's connector token are read from files in the read-only secrets mount
// and handed to the child in its ENVIRONMENT. `ps` on the host shows the
// command line, never the credential.
//
// Zero dependencies beyond node builtins: the image is the official client's
// binary on a bare node base, nothing else.
import { spawn as nodeSpawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";

/** The three shapes this wrapper can run. `quick` and `ngrok` CAPTURE a
 * hostname; `named` has a stable one already (the operator's own domain), so
 * it runs the client and writes no file. */
export const KINDS = ["quick", "ngrok", "named"];

/** MIRROR of HOSTNAME_RE in src/webhookheal.ts — a bare DNS hostname, no
 * scheme, no path, no port. The two spellings are asserted identical by
 * tests/tunnel-sidecar.test.ts: if the watcher's contract ever changes, both
 * sides change together or the suite refuses. */
export const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,62})?(\.[a-z0-9]([a-z0-9-]{0,62})?)+$/i;

/** Hosts that appear in tunnel-client output but are never the public name. */
const NEVER_PUBLIC = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "dashboard.ngrok.com",
  "ngrok.com",
]);

export const DEFAULT_BACKOFF_MIN_MS = 2_000;
export const DEFAULT_BACKOFF_MAX_MS = 60_000;

/** @typedef {{ kind: string, upstream: string, hostnameFile: string, secretsDir: string, domain: string, backoffMinMs: number, backoffMaxMs: number }} SidecarConfig */

// ---- pure helpers -----------------------------------------------------------

export function isHostname(value) {
  const host = String(value ?? "")
    .trim()
    .toLowerCase();
  if (host === "" || host.length > 253 || NEVER_PUBLIC.has(host)) return false;
  return HOSTNAME_RE.test(host);
}

/** The host part of an absolute https URL, or null. Ports are stripped — the
 * contract is a BARE hostname, and a quick tunnel is always :443 anyway. */
function hostOf(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
    return isHostname(parsed.hostname) ? parsed.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Pull the assigned public hostname out of ONE line of client output.
 * Returns null for every line that does not announce one — which is almost
 * all of them.
 *
 * cloudflared quick tunnel prints a banner:
 *   INF |  https://foo-bar-baz.trycloudflare.com   |
 * and only ever a `*.trycloudflare.com` name, so that suffix is the guard: a
 * documentation link in the banner can never be mistaken for the tunnel.
 *
 * ngrok logs the tunnel URL as a `url=` field (logfmt) or a "url" key (json):
 *   t=... lvl=info msg="started tunnel" addr=http://daemon:8787 url=https://x.ngrok-free.app
 * The upstream `addr=` is http, and the account/dashboard links are not `url=`
 * fields, so keying on the field name plus https is precise. A reserved
 * domain therefore captures exactly like a rotating one.
 *
 * @param {string} kind @param {string} line
 */
export function extractHostname(kind, line) {
  const text = String(line ?? "");
  if (kind === "quick") {
    const m = /https:\/\/([a-z0-9][a-z0-9.-]*\.trycloudflare\.com)/i.exec(text);
    return m && isHostname(m[1]) ? m[1].toLowerCase() : null;
  }
  if (kind === "ngrok") {
    const json = /"url"\s*:\s*"(https:\/\/[^"]+)"/i.exec(text);
    const logfmt = /\burl=(?:"([^"]+)"|(\S+))/i.exec(text);
    const candidate = json?.[1] ?? logfmt?.[1] ?? logfmt?.[2] ?? null;
    return candidate === null ? null : hostOf(candidate);
  }
  return null; // named: the hostname is the operator's, not the client's
}

/** Read a secret file from the read-only secrets mount. Trimmed; null when
 * absent or empty — never a throw, so a missing credential is a logged
 * refusal rather than a crash. */
export function readSecret(dir, name) {
  try {
    const value = readFileSync(join(dir, name), "utf8").trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

/**
 * Atomic hostname write. Returns "written" when the file now holds a NEW
 * hostname, "unchanged" when it already did (no touch at all — the watcher
 * must not be woken for nothing).
 */
export function writeHostname(file, hostname, io = {}) {
  const read = io.readFileSync ?? readFileSync;
  const write = io.writeFileSync ?? writeFileSync;
  const rename = io.renameSync ?? renameSync;
  const mkdir = io.mkdirSync ?? mkdirSync;
  const host = String(hostname).trim().toLowerCase();
  if (!isHostname(host))
    throw new Error(`refusing to write a non-hostname: ${JSON.stringify(hostname)}`);
  let current = null;
  try {
    current = read(file, "utf8").trim().toLowerCase();
  } catch {
    current = null;
  }
  if (current === host) return "unchanged";
  const dir = dirname(file);
  mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${host.slice(0, 40)}.tmp`);
  write(tmp, `${host}\n`);
  rename(tmp, file);
  return "written";
}

/**
 * What to run, and with what environment. Re-computed on EVERY attempt so a
 * credential dropped into the secrets mount after start is picked up without
 * a restart. `missing` (never a throw) names the file the operator must
 * create; `env` carries credentials — `args` never does.
 *
 * @param {SidecarConfig} cfg
 */
export function tunnelSpec(cfg) {
  if (cfg.kind === "quick") {
    return {
      cmd: "cloudflared",
      args: ["tunnel", "--no-autoupdate", "--url", cfg.upstream],
      env: {},
      captures: true,
      missing: null,
    };
  }
  if (cfg.kind === "ngrok") {
    const token = readSecret(cfg.secretsDir, "ngrok_authtoken");
    return {
      cmd: "ngrok",
      args: [
        "http",
        cfg.upstream,
        "--log",
        "stdout",
        "--log-format",
        "logfmt",
        ...(cfg.domain ? ["--domain", cfg.domain] : []),
      ],
      env: token ? { NGROK_AUTHTOKEN: token } : {},
      captures: true,
      missing: token ? null : `${cfg.secretsDir}/ngrok_authtoken`,
    };
  }
  if (cfg.kind === "named") {
    const token = readSecret(cfg.secretsDir, "tunnel_token");
    return {
      cmd: "cloudflared",
      args: ["tunnel", "--no-autoupdate", "run"],
      env: token ? { TUNNEL_TOKEN: token } : {},
      captures: false,
      missing: token ? null : `${cfg.secretsDir}/tunnel_token`,
    };
  }
  return { cmd: null, args: [], env: {}, captures: false, missing: null, unknownKind: cfg.kind };
}

/** Capped exponential ladder: 2s, 4s, 8s … 60s, then 60s forever. A tunnel
 * that cannot start must not become a fork bomb, and must not give up either. */
export function backoffMs(attempt, min = DEFAULT_BACKOFF_MIN_MS, max = DEFAULT_BACKOFF_MAX_MS) {
  const n = Math.max(0, Math.floor(attempt));
  return Math.min(max, min * 2 ** Math.min(n, 20));
}

/** Container env → config. Every knob optional but the kind. */
export function sidecarConfig(env) {
  const num = (raw, fallback) => {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    kind: (env.QCR_TUNNEL_KIND ?? "").trim(),
    upstream: (env.QCR_TUNNEL_UPSTREAM ?? "http://daemon:8787").trim(),
    hostnameFile: (env.QCR_TUNNEL_HOSTNAME_FILE ?? "/ingress/hostname").trim(),
    secretsDir: (env.QCR_TUNNEL_SECRETS_DIR ?? "/opt/quickreview/secrets").trim(),
    domain: (env.QCR_TUNNEL_DOMAIN ?? "").trim(),
    backoffMinMs: num(env.QCR_TUNNEL_BACKOFF_MIN_MS, DEFAULT_BACKOFF_MIN_MS),
    backoffMaxMs: num(env.QCR_TUNNEL_BACKOFF_MAX_MS, DEFAULT_BACKOFF_MAX_MS),
  };
}

// ---- the supervised run -----------------------------------------------------

/** Feed raw chunks, get whole lines. A hostname banner split across two reads
 * would otherwise be missed exactly once — at startup, the only time it
 * matters. */
function lineSplitter(onLine) {
  let buffer = "";
  return (chunk) => {
    buffer += String(chunk);
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      onLine(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
    if (buffer.length > 8192) buffer = buffer.slice(-1024); // a client that never newlines
  };
}

/**
 * Run the client ONCE, capturing hostnames from its output for as long as it
 * lives. Resolves with how it ended — never rejects.
 */
export function runClientOnce(cfg, spec, opts = {}) {
  const spawnFn = opts.spawn ?? nodeSpawn;
  const log = opts.log ?? ((line) => console.log(`[tunnel] ${line}`));
  const onHostname =
    opts.onHostname ??
    ((host) => {
      const outcome = writeHostname(cfg.hostnameFile, host);
      log(
        outcome === "written"
          ? `public hostname ${host} → ${cfg.hostnameFile} (the daemon re-points the App webhook URL from here)`
          : `public hostname ${host} unchanged`,
      );
    });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (how) => {
      if (settled) return;
      settled = true;
      resolve(how);
    };
    let child;
    try {
      child = spawnFn(spec.cmd, spec.args, {
        env: { ...(opts.baseEnv ?? process.env), ...spec.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      log(`could not start ${spec.cmd}: ${errText(err)}`);
      return finish({ ok: false, reason: errText(err) });
    }
    const handleLine = (line) => {
      if (opts.echo !== false && line.trim() !== "") log(line.trim());
      if (!spec.captures) return;
      const host = extractHostname(cfg.kind, line);
      if (host === null) return;
      try {
        onHostname(host);
      } catch (err) {
        // An unwritable shared volume is loud and retried on the next
        // announcement; it never kills the tunnel that is otherwise working.
        log(`could not publish hostname ${host}: ${errText(err)}`);
      }
    };
    const stdout = lineSplitter(handleLine);
    const stderr = lineSplitter(handleLine);
    child.stdout?.on("data", stdout);
    child.stderr?.on("data", stderr);
    child.on("error", (err) => {
      log(`${spec.cmd} failed: ${errText(err)}`);
      finish({ ok: false, reason: errText(err) });
    });
    child.on("close", (code, signal) => {
      const reason = signal ? `signal ${signal}` : `exit ${code}`;
      log(`${spec.cmd} ended (${reason}) — restarting`);
      finish({ ok: code === 0, reason });
    });
  });
}

/**
 * The supervisor: run, restart, forever. `opts.maxRuns` bounds it for tests
 * only — in the container it never returns.
 */
export async function runSidecar(cfg, opts = {}) {
  const log = opts.log ?? ((line) => console.log(`[tunnel] ${line}`));
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const maxRuns = opts.maxRuns ?? Infinity;
  const outcomes = [];
  let attempt = 0;
  for (let run = 0; run < maxRuns; run++) {
    const spec = tunnelSpec(cfg); // re-read secrets every attempt
    if (spec.unknownKind !== undefined) {
      // A misconfigured kind is the one thing a restart cannot fix, but even
      // this stays a loud idle rather than a crash loop: compose restarts a
      // dying container forever and the log would scroll away.
      log(
        `FATAL: unknown QCR_TUNNEL_KIND ${JSON.stringify(spec.unknownKind)} — expected one of ${KINDS.join(", ")}; idling`,
      );
      outcomes.push({ ok: false, reason: "unknown-kind" });
      await sleep(cfg.backoffMaxMs);
      continue;
    }
    if (spec.missing) {
      log(
        `${cfg.kind}: credential file ${spec.missing} is missing or empty — the tunnel cannot start. ` +
          "Create it (the sidecar re-reads it on every attempt; no restart needed).",
      );
      outcomes.push({ ok: false, reason: "missing-secret" });
      await sleep(backoffMs(attempt++, cfg.backoffMinMs, cfg.backoffMaxMs));
      continue;
    }
    log(`starting ${spec.cmd} ${spec.args.join(" ")} (kind=${cfg.kind}, upstream=${cfg.upstream})`);
    const outcome = await runClientOnce(cfg, spec, opts);
    outcomes.push(outcome);
    const wait = backoffMs(attempt++, cfg.backoffMinMs, cfg.backoffMaxMs);
    log(`restarting in ${Math.round(wait / 1000)}s`);
    await sleep(wait);
  }
  return outcomes;
}

function errText(err) {
  return err instanceof Error ? err.message : String(err);
}

// ---- entry point ------------------------------------------------------------

// Importing this file (the tests do) must never start a tunnel.
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
  const cfg = sidecarConfig(process.env);
  console.log(
    `[tunnel] kind=${cfg.kind || "(unset)"} upstream=${cfg.upstream} hostname-file=${cfg.hostnameFile}` +
      (cfg.domain ? ` domain=${cfg.domain}` : ""),
  );
  runSidecar(cfg).catch((err) => {
    console.error(`[tunnel] fatal: ${errText(err)}`);
    process.exit(1);
  });
}
