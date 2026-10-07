#!/usr/bin/env node
// The companion's memory forward — host-owned, TUI-independent.
//
// WHY THIS EXISTS
// ---------------
// The local pi companion must read and write memory that lives on the VM,
// while holding NO VM credential (root CLAUDE.md rule 8). So the ssh runs
// HERE, on the owner's PC, as a systemd --user service he owns:
//
//     companion container ──▶ 198.51.100.1:1933      (docker bridge `qcr-memory`)
//                              │  this process, on the host
//                              ▼
//     ssh <vm-host> ──▶ sudo docker exec -i quickreview-sandbox
//                              ▼
//                      node stdio↔TCP bridge ──▶ 127.0.0.1:1933  (OpenViking)
//
// Two properties make it worth the machinery:
//
//   * the container never sees an ssh key, an agent socket or a host known_hosts
//     file — it sees one TCP endpoint on a bridge, and nothing else;
//   * nothing on the VM is published. OpenViking stays bound to the quickreview
//     container's own loopback ([openviking] host/port); the last hop is a
//     `docker exec` inside the container's netns, so no port is opened on the
//     VM, on the VM's docker bridge, or anywhere reachable from the network.
//
// It is deliberately NOT part of the TUI: `qcr tui` starting and stopping is
// not an event memory should notice. systemd owns the process (Restart=always,
// enabled at login, `loginctl enable-linger` for boot), so the companion keeps
// its memory while the TUI is closed — which is most of the day.
//
// LOCAL MODE. On a one-machine (laptop) topology the daemon
// container runs on THIS host, so `--local` (or QCR_MEMORY_LOCAL=1, or an
// explicit empty --ssh-host) replaces the ssh hop with a plain local
// `docker exec` into the same container netns. Everything else — the
// `qcr-memory` bridge + loopback binds, the listener contract, `verify`,
// adopt-or-bind from the TUI — is identical: this file stays the ONE relay
// implementation for both topologies.
//
// RELAY CAP (F1). Every relay is one ssh session on the forward's one
// shared connection, and sshd refuses sessions past its MaxSessions (10) —
// each refused relay then quietly opens a full ssh login of its own. So at
// most `--max-relays` (6) relays are open at once; a request beyond that
// waits its turn, a relay between requests hands its slot over, and a request
// that waits too long gets an honest 503 — see "the relay cap" below. The
// systemd unit and the TUI both parse through `parseArgs`, so both carry it.
//
// SUBCOMMANDS
//   run              the forwarder itself (what the systemd unit executes)
//   install          create the docker network + write/enable the user unit
//   uninstall        stop + disable the unit (network and keys left alone)
//   status           unit state, network, endpoint, the relay cap and the
//                    running forward's live counts, one live probe
//   ensure-network   idempotent docker network create (the unit's ExecStartPre)
//   verify           the two-key reach + confinement proof (see docs/)
//
// Zero dependencies, no repo build needed: systemd must be able to run this
// from a bare checkout at boot.
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, "..");

// ---- defaults ---------------------------------------------------------------
// These MIRROR src/tui/companion.ts MEMORY.* — the forward and the container
// must agree on network, subnet and port or the companion talks to nothing.
// tests/companion-memory.test.ts fails on drift.

export const DEFAULTS = {
  network: "qcr-memory",
  subnet: "198.51.100.0/24",
  gateway: "198.51.100.1",
  port: 1933,
  sshHost: "my-vm",
  container: "quickreview-sandbox",
  remoteHost: "127.0.0.1",
  remotePort: 1933,
  sudo: true,
  unit: "qcr-memory-forward",
  // F1 — the relay cap. Every relay is one ssh SESSION on the
  // forward's one shared connection, and sshd refuses the session past its
  // `MaxSessions` (10 on the VM, the OpenSSH default). 6 leaves room for
  // relays still closing and for anything else that shares the ControlPath.
  maxRelays: 6,
  /** Requests that may wait for a relay; one more is refused at once. */
  queueMax: 64,
  /** How long one request may wait for a relay before it is refused. */
  queueTimeoutS: 15,
};

/** OpenSSH's default sshd `MaxSessions`: session channels per connection.
 * Verified on the VM (`sshd -T | grep maxsessions` → 10, 2026-10-07). */
export const SSHD_DEFAULT_MAX_SESSIONS = 10;

/**
 * The forward's OWN ssh control socket (F1). Its relays multiplex
 * over one master connection, and every relay is a session on it; a path of
 * its own keeps the operator's interactive ssh — whose `~/.ssh/config`
 * ControlPath is a different file — off that connection's session budget.
 * `%C` (a hash of the local host, remote host, port and user) keeps the path
 * short enough for a unix socket. Until F1 the default was
 * `~/.ssh/cm-%r@%h:%p`: already separate from the VM config's
 * `~/.ssh/sockets/…`, but the stock example name a config might share.
 */
export function defaultControlPath(home = homedir()) {
  return join(home, ".ssh", "qcr-memfwd-%C");
}

/**
 * The keys file (0600, two USER keys) — the install locator's rule
 * (`locateKeysFile` in src/install.ts), the same path
 * src/tui/companion.ts reads: `QCR_OPENVIKING_KEYS`, else the operator home
 * `$XDG_CONFIG_HOME/qcr-operator/<install>/` (the old
 * `~/.config/quickreview-bot/` copy is never read). Mirrored rather than
 * imported because this script runs from a checkout with no dist/;
 * tests/companion-memory.test.ts runs both over the same temp homes.
 */
export function keysFilePath(env = process.env, home = homedir()) {
  const override = (env.QCR_OPENVIKING_KEYS ?? "").trim();
  if (override !== "") return override;
  const install = (env.QCR_INSTALL ?? "").trim() || "default";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(install) || install.includes("..")) {
    throw new Error(`QCR_INSTALL ${JSON.stringify(install)} is not a plain name`);
  }
  const xdg = (env.XDG_CONFIG_HOME ?? "").trim();
  const base = xdg !== "" && isAbsolute(xdg) ? xdg : join(home, ".config");
  return join(base, "qcr-operator", install, "openviking-keys.env");
}

// ---- the remote half --------------------------------------------------------

/**
 * The stdio↔TCP bridge that runs INSIDE the VM container. It is a node
 * one-liner because node is the one interpreter the quickreview image is
 * guaranteed to have (it runs pi); `nc` is not installed there.
 *
 * Single quotes are forbidden in this string: the whole program is passed to
 * the remote shell inside single quotes.
 */
export function remoteBridgeJs(host, port) {
  if (/'/.test(host)) throw new Error("remote host must not contain a quote");
  return (
    `const n=require("net");const s=n.connect(${Number(port)},"${host}");` +
    `s.on("error",()=>process.exit(1));s.on("close",()=>process.exit(0));` +
    `process.stdin.on("end",()=>s.end());process.stdin.pipe(s);s.pipe(process.stdout);`
  );
}

/** `ssh …` argv for ONE relayed connection. Pure — the test asserts it. */
export function relayArgv(cfg) {
  const docker = cfg.sudo ? "sudo docker" : "docker";
  const remote = `${docker} exec -i ${cfg.container} node -e '${remoteBridgeJs(cfg.remoteHost, cfg.remotePort)}'`;
  return [
    "-q",
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=3",
    // A shared control connection turns a per-request ssh handshake into a
    // channel open on an existing socket. Without it every HTTP connection
    // would pay a full login. Each relay is one SESSION on that connection,
    // and sshd caps sessions per connection (`MaxSessions`) — which is what
    // `createForwarder`'s relay cap stays under (F1).
    "-o",
    "ControlMaster=auto",
    "-o",
    `ControlPath=${cfg.controlPath}`,
    "-o",
    "ControlPersist=4h",
    ...(cfg.identity ? ["-i", cfg.identity] : []),
    cfg.sshHost,
    remote,
  ];
}

// ---- repeat-failure collapse --------------------------------------

/**
 * The likely CAUSE of a relay failure, in the operator's terms, with the exact
 * command that fixes it. `ssh` exiting 255 with nothing else to say is the
 * symptom the journal used to be full of; this is the sentence that was
 * missing beside it.
 */
export function relayFailureCause(cfg, text, deps = {}) {
  const s = String(text ?? "");
  // The docker check comes FIRST and is not interchangeable with the ssh one:
  // "permission denied while trying to connect to the Docker daemon" also
  // matches /permission denied/, and answering it with `ssh-add` would send the
  // operator hunting for a key problem that does not exist.
  if (
    /permission denied while trying to connect to the docker daemon|cannot connect to the docker daemon|docker: command not found/i.test(
      s,
    )
  ) {
    // …and the docker in question is the VM's, not this laptop's: the relay is
    // `ssh <host> sudo docker exec …`. A local `systemctl status docker` was a
    // remedy pointed at the wrong machine (review). With `sudo docker`
    // the usual fault is the sudo/group grant, not the unit being down.
    const where = cfg.local ? "the local docker daemon" : `docker ON ${cfg.sshHost}`;
    return {
      key: "docker",
      cause: `${where} refused the exec`,
      remedy: cfg.local ? "docker ps" : `ssh ${cfg.sshHost} ${cfg.sudo ? "sudo " : ""}docker ps`,
    };
  }
  if (/permission denied|publickey|too many authentication failures|agent refused/i.test(s)) {
    // The KEY, derived the same way `src/tui/sshtriage.ts` derives it — from
    // `ssh -G <host>`, never guessed. A hard-coded path is precisely the
    // "confidently wrong exact command" ruling 4 exists to prevent.
    const key = cfg.identity ?? sshIdentityFor(cfg, deps);
    return {
      key: "auth",
      cause: `ssh to ${cfg.sshHost} has no usable key — the agent is empty or does not hold this host's key`,
      remedy: `ssh-add ${key}`,
    };
  }
  if (
    /could not resolve|name or service not known|no route to host|network is unreachable|connection timed out|operation timed out/i.test(
      s,
    )
  ) {
    return {
      key: "host",
      cause: `${cfg.sshHost} did not answer`,
      remedy: `ssh -v ${cfg.sshHost} true`,
    };
  }
  // There is deliberately no cause for sshd refusing a session past its
  // MaxSessions (F1 review): the mux client does not fail on that —
  // it gives up on the shared connection and opens a full ssh login of its
  // own, and under `-q` it says neither. Nothing reaches stderr to match; the
  // relay cap is what keeps relays inside the shared connection.
  if (/control socket|mux_client|multiplexing/i.test(s)) {
    // The forward's master lives at ITS OWN ControlPath, so a bare
    // `ssh -O exit <host>` would address the operator's master (the one in
    // ~/.ssh/config) and leave the wedged one standing.
    return {
      key: "mux",
      cause: `the forward's own ssh ControlMaster for ${cfg.sshHost}${cfg.controlPath ? ` (${cfg.controlPath})` : ""} is wedged`,
      remedy: cfg.controlPath
        ? `ssh -o 'ControlPath=${cfg.controlPath}' -O exit ${cfg.sshHost}`
        : `ssh -O exit ${cfg.sshHost}`,
    };
  }
  return {
    key: "unknown",
    cause: `the relay to ${cfg.container} on ${cfg.sshHost} exited without connecting`,
    remedy: `ssh -v ${cfg.sshHost} true`,
  };
}

/** Cache: `ssh -G` is local and cheap, but this runs on a failure path that can
 * fire once per connection. */
let identityCache;

/**
 * The key ssh would actually offer for this host, from `ssh -G` — the same
 * source `src/tui/sshtriage.ts` uses. Local only (no network). Falls back to
 * the conventional GCP metadata key when ssh tells us nothing, and is never
 * consulted in `--local` mode, where there is no ssh at all.
 */
export function sshIdentityFor(cfg, deps = {}) {
  if (cfg.local) return "~/.ssh/id_ed25519";
  if (identityCache !== undefined && deps.run === undefined) return identityCache;
  const runner = deps.run ?? ((bin, args) => run(bin, args));
  const home = deps.home ?? homedir();
  const fileExists = deps.exists ?? existsSync;
  let picked = "";
  try {
    const res = runner("ssh", ["-G", cfg.sshHost]);
    const files = String(res.stdout ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^identityfile /i.test(l))
      .map((l) => l.slice("identityfile ".length).trim())
      .map((f) => (f.startsWith("~/") ? join(home, f.slice(2)) : f));
    picked = files.find((f) => fileExists(f)) ?? files[0] ?? "";
  } catch {
    picked = "";
  }
  const answer = picked || join(home, ".ssh", "google_compute_engine");
  if (deps.run === undefined) identityCache = answer;
  return answer;
}

/** How long one cause stays collapsed before it is worth saying again. */
export const FAILURE_REPEAT_MS = 60_000;

/**
 * Collapses a repeating relay failure into ONE actionable line, rate-limited,
 * and says so out loud when it recovers.
 *
 * Every HTTP connection the companion or the TUI makes spawns its own relay, so
 * a missing agent key produced thousands of `relay #N exited 255` lines — a
 * symptom, repeated, with no cause and no remedy. One line per cause per
 * window, a count of what was suppressed, and a `recovered` line that proves
 * the self-healing actually happened: nothing here needs a restart, the next
 * successful relay clears the state on its own.
 *
 * @param {{ log?: (line: string) => void, now?: () => number, windowMs?: number }} [opts]
 *   `log` is declared here rather than defaulted on purpose: it has no
 *   sensible default (a collapser that swallows its own output is worse than
 *   one that throws), but without the annotation TypeScript infers the option
 *   bag from the DEFAULTED keys only and `tsconfig.tests.json` then rejects
 *   every caller that passes it.
 */
export function createFailureCollapser({
  log,
  now = () => Date.now(),
  windowMs = FAILURE_REPEAT_MS,
} = {}) {
  let key = null;
  let lastAt = 0;
  // Suppressed since the LAST PRINTED line, and suppressed since the last
  // recovery. Two counters because they answer different questions, and
  // collapsing them into one is how the old version came to say "0 suppressed"
  // after hiding six failures: a cause change reset the only counter it had.
  let suppressedSincePrint = 0;
  let suppressedTotal = 0;
  let total = 0;
  const emit = (cause, t) => {
    const hidden = suppressedSincePrint;
    const sameCause = cause.key === key;
    const ago = Math.round((t - lastAt) / 1000);
    const repeat =
      hidden > 0
        ? ` (${hidden} similar failure${hidden === 1 ? "" : "s"} suppressed${sameCause ? ` in the last ${ago}s` : ""})`
        : "";
    key = cause.key;
    lastAt = t;
    suppressedSincePrint = 0;
    log(`relay failing: ${cause.cause} — fix: ${cause.remedy}${repeat}`);
  };
  return {
    fail(cause) {
      total += 1;
      const t = now();
      if (cause.key === key && t - lastAt < windowMs) {
        suppressedSincePrint += 1;
        suppressedTotal += 1;
        return;
      }
      emit(cause, t);
    },
    ok() {
      if (key === null) return;
      const hidden = suppressedTotal;
      const seen = total;
      key = null;
      suppressedSincePrint = 0;
      suppressedTotal = 0;
      total = 0;
      log(
        `relay recovered — the forward is working again (${seen} failure${seen === 1 ? "" : "s"}, ${hidden} suppressed)`,
      );
    },
    /** Test handle: what is currently collapsed. */
    state: () => ({ key, suppressed: suppressedSincePrint, hidden: suppressedTotal, total }),
  };
}

// ---- the forwarder ----------------------------------------------------------

/**
 * Local relay argv (`--local`): the SAME stdio↔TCP bridge, reached by
 * a plain `docker exec` on THIS machine — the daemon container runs here, so
 * there is no ssh hop. The bridge program rides as a real argv element (no
 * shell re-parse, so no quote wrapper); `--no-sudo` drops the sudo prefix.
 */
export function localRelayArgv(cfg) {
  return [
    ...(cfg.sudo ? ["sudo"] : []),
    "docker",
    "exec",
    "-i",
    cfg.container,
    "node",
    "-e",
    remoteBridgeJs(cfg.remoteHost, cfg.remotePort),
  ];
}

/** The FULL relay command, binary first — the transport decision in one place.
 * Pure; tests assert both shapes. */
export function relaySpawnCommand(cfg) {
  return cfg.local ? localRelayArgv(cfg) : ["ssh", ...relayArgv(cfg)];
}

/** Spawn one relay child. Injectable so the test drives streams, not ssh. */
export function realRelaySpawner(cfg) {
  const cmd = relaySpawnCommand(cfg);
  return () => spawn(cmd[0], cmd.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
}

// ---- the relay cap (F1) ---------------------------------------------
//
// THE DEFECT (2026-10-07). Every accepted TCP connection got its own relay —
// one `ssh … docker exec …` — and every relay is one SESSION on the forward's
// one shared ssh connection. sshd allows `MaxSessions` (10) of those per
// connection and refuses the rest. A refused relay does not stop there: the
// mux client gives up on the shared connection and opens a full ssh login of
// its own through the bastion, saying nothing under `-q`. On the VM those
// extra logins failed (2026-08-26, docs/memory-forward-connection-research.md:
// 16 concurrent probes, exactly 10 answered, ssh exiting 255), so a burst —
// the store's 8-way read sweep (`qcr memory relayout`) beside the TUI's polls
// and the companion — had its extra connections closed under it, and the
// callers saw `fetch failed`.
//
// THE CAP. At most `maxRelays` relays are open at once, counted from spawn to
// the child's EXIT (a killed relay still holds its session until ssh is gone).
// A connection that has a request to send and no relay waits in a FIFO queue
// (`queueMax` deep); a request that waits `queueTimeoutMs` — or arrives at a
// full queue — gets an HTTP 503 in OpenViking's own error envelope and a clean
// close, never a hang and never a bare reset.
//
// WHY A QUEUE ALONE IS NOT ENOUGH. Every client here keeps its connections
// alive between requests (undici, browsers). A connection holding a relay and
// looping on it never closes, so a queue that only advanced on a close would
// starve whoever waited behind a busy sweep. So a relay YIELDS: when its
// connection is BETWEEN requests and somebody is waiting, the relay is
// stopped and its slot goes to the head of the queue; the connection itself
// stays open, and its next request waits its turn for a new relay. "Between
// requests" is read off the bytes by `createExchangeTracker` — a whole
// request, then a whole Content-Length response, and nothing since — never
// guessed from a quiet line. A connection that is not plain request/response
// HTTP/1.1 (a websocket, a chunked or close-delimited body, a pipelined
// request) is never stopped: it keeps its relay to the end, as every
// connection did before F1.
//
// A relay that yields has served its connection for `minLeaseMs` (so a hot
// loop pays one relay start per second, not one per request), or has been
// quiet for `idleYieldMs` (an idle keep-alive connection, which may never send
// again). No bytes ever cross from one connection's relay to another's: a
// yielded relay is killed, and the next request starts a fresh one.

/** Internal timings. `opts.timings` overrides them (tests). */
export const RELAY_TIMINGS = {
  /** A relay serving a busy connection yields at a request boundary only
   * after this long — bounds the cost of fairness to one relay start a second. */
  minLeaseMs: 1_000,
  /** …or as soon as its connection has been idle (between requests) this long. */
  idleYieldMs: 200,
  /** SIGTERM → SIGKILL, and the slot is counted free at the SIGKILL. */
  killGraceMs: 3_000,
  /** While anyone waits, how often idle relays are looked for. */
  rebalanceMs: 100,
  /** A refused connection: how long its client gets to read the 503. */
  refuseLingerMs: 2_000,
  /** A relay that exited mid-exchange: how long to wait for its last bytes. */
  relayCloseGraceMs: 1_000,
  /** A waiting connection's held bytes past which its socket is paused. */
  holdLimitBytes: 256 * 1024,
  /** At most one stats-file write per this window. */
  statsEveryMs: 500,
  /** One "queueing" line per window, however many bursts. */
  logWindowMs: 60_000,
};

/**
 * The cap, the queue depth and the wait, off `cfg` (`parseArgs` fills all
 * three — so the systemd unit and the TUI, which both parse through it, carry
 * the same cap; a cfg built by hand falls back to the defaults).
 */
export function forwardLimits(cfg) {
  return {
    maxRelays: cfg?.maxRelays ?? DEFAULTS.maxRelays,
    queueMax: cfg?.queueMax ?? DEFAULTS.queueMax,
    queueTimeoutMs: cfg?.queueTimeoutMs ?? DEFAULTS.queueTimeoutS * 1000,
  };
}

/** Longest message head the tracker reads before it calls the stream opaque. */
const MAX_HEAD_BYTES = 64 * 1024;

/** `name: value` lines → lowercase name → values; null when malformed. */
function parseHeaderLines(lines) {
  const headers = new Map();
  for (const line of lines) {
    const i = line.indexOf(":");
    if (i <= 0 || /^[ \t]/.test(line)) return null; // obs-fold or garbage
    const name = line.slice(0, i).trim().toLowerCase();
    const list = headers.get(name) ?? [];
    list.push(line.slice(i + 1).trim());
    headers.set(name, list);
  }
  return headers;
}

/** A body length the bytes declare: a number, `undefined` when nothing is
 * declared, `null` when it is chunked, malformed or contradictory. */
function declaredLength(headers) {
  if (headers.has("transfer-encoding")) return null;
  const values = headers.get("content-length");
  if (!values) return undefined;
  const all = new Set(values.flatMap((v) => v.split(",")).map((v) => v.trim()));
  if (all.size !== 1) return null;
  const [only] = [...all];
  return /^\d{1,15}$/.test(only) ? Number(only) : null;
}

/**
 * Where one connection's HTTP/1.1 exchange stands, read off its bytes — just
 * enough to know when its relay is BETWEEN requests and may be handed over.
 *
 * It frames only what it can frame exactly: a request (Content-Length body or
 * none) and its response (a Content-Length body; none for HEAD, 204, 304).
 * Anything else — chunked or close-delimited bodies, a 1xx or 101 upgrade, an
 * `Upgrade` or `Expect` request, a second request sent before the first
 * response came back, a server speaking unasked, a head over 64 KiB — makes
 * the stream OPAQUE for good, and an opaque connection is never stopped. The
 * tracker never changes a byte; it only watches.
 */
export function createExchangeTracker() {
  /** idle | request-head | request-body | response-wait | response-head |
   * response-body | opaque */
  let phase = "idle";
  let head = "";
  let remaining = 0;
  let method = "";
  let exchanges = 0;

  const opaque = () => {
    phase = "opaque";
    head = "";
  };

  /** Consume head bytes from `off`; the offset past the head once it is
   * whole (after `onHead`), else the end of the buffer. */
  const takeHead = (buf, off, onHead) => {
    const window = buf.toString("latin1", off, Math.min(buf.length, off + MAX_HEAD_BYTES + 4));
    const combined = head + window;
    const end = combined.indexOf("\r\n\r\n", Math.max(0, head.length - 3));
    if (end === -1) {
      head = combined;
      if (head.length > MAX_HEAD_BYTES) opaque();
      return buf.length;
    }
    const consumed = end + 4 - head.length;
    const text = combined.slice(0, end);
    head = "";
    onHead(text);
    return off + consumed;
  };

  const startRequest = (text) => {
    const lines = text.split("\r\n");
    const m = /^([A-Z]+) \S+ HTTP\/1\.[01]$/.exec(lines[0] ?? "");
    const headers = parseHeaderLines(lines.slice(1));
    if (!m || !headers || headers.has("upgrade") || headers.has("expect")) return opaque();
    const len = declaredLength(headers);
    if (len === null) return opaque();
    method = m[1];
    remaining = len ?? 0; // a request that declares nothing has no body
    phase = remaining > 0 ? "request-body" : "response-wait";
  };

  const startResponse = (text) => {
    const lines = text.split("\r\n");
    const m = /^HTTP\/1\.[01] (\d{3})(?: |$)/.exec(lines[0] ?? "");
    const headers = parseHeaderLines(lines.slice(1));
    if (!m || !headers) return opaque();
    const status = Number(m[1]);
    if (status < 200) return opaque(); // 1xx, 101 upgrade: not one request, one answer
    let len = 0;
    if (method !== "HEAD" && status !== 204 && status !== 304) {
      const declared = declaredLength(headers);
      // No length is a body that ends at the close: nothing marks its end.
      if (declared === null || declared === undefined) return opaque();
      len = declared;
    }
    remaining = len;
    if (remaining > 0) phase = "response-body";
    else {
      phase = "idle";
      exchanges += 1;
    }
  };

  return {
    /** Bytes the client sent. */
    client(buf) {
      let off = 0;
      while (off < buf.length) {
        if (phase === "opaque") return;
        if (phase === "idle") {
          phase = "request-head";
          continue;
        }
        if (phase === "request-head") {
          off = takeHead(buf, off, startRequest);
          continue;
        }
        if (phase === "request-body") {
          const n = Math.min(remaining, buf.length - off);
          remaining -= n;
          off += n;
          if (remaining === 0) phase = "response-wait";
          continue;
        }
        // Client bytes while a response is owed: pipelining, or a protocol
        // that talks both ways at once. Either way, no boundary to trust.
        return opaque();
      }
    },
    /** Bytes the server (the relay) sent. */
    server(buf) {
      let off = 0;
      while (off < buf.length) {
        if (phase === "opaque") return;
        if (phase === "response-wait") {
          phase = "response-head";
          continue;
        }
        if (phase === "response-head") {
          off = takeHead(buf, off, startResponse);
          continue;
        }
        if (phase === "response-body") {
          const n = Math.min(remaining, buf.length - off);
          remaining -= n;
          off += n;
          if (remaining === 0) {
            phase = "idle";
            exchanges += 1;
          }
          continue;
        }
        // The server spoke unasked, or before the request was whole.
        return opaque();
      }
    },
    /** Nothing in flight: no request begun, or the last response is whole. */
    atRest: () => phase === "idle",
    opaque: () => phase === "opaque",
    phase: () => phase,
    exchanges: () => exchanges,
  };
}

/**
 * The answer a refused request gets: an HTTP 503 in OpenViking's own
 * `{status, error}` envelope, so a caller's client reports WHY ("the memory
 * forward is busy …") where a bare close read as `fetch failed`.
 */
export function busyResponse(message) {
  const body = JSON.stringify({ status: "error", error: { code: "FORWARD_BUSY", message } });
  return (
    "HTTP/1.1 503 Service Unavailable\r\n" +
    "Content-Type: application/json\r\n" +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    "Retry-After: 1\r\n" +
    "Connection: close\r\n" +
    "\r\n" +
    body
  );
}

const seconds = (ms) => `${Math.round(ms / 100) / 10}s`;

/**
 * The listener. One TCP server per bind address; every connection that has
 * a request to send gets a relay child — at most `maxRelays` at once (above) —
 * and either side closing tears the pair down.
 *
 * Failure is always local and always survivable: a relay that cannot start
 * closes that one connection (the extension sees a connection error, degrades,
 * and the in-container watcher alerts) — the forwarder keeps listening.
 *
 * @param {Record<string, any>} cfg
 * @param {{
 *   log?: (line: string) => void,
 *   spawnRelay?: () => any,
 *   now?: () => number,
 *   collapser?: { fail: (cause: { key: string, cause: string, remedy: string }) => void, ok: () => void },
 *   timings?: Partial<typeof RELAY_TIMINGS>,
 * }} [opts]
 */
export function createForwarder(cfg, opts = {}) {
  const log = opts.log ?? ((line) => console.log(`[memory-forward] ${line}`));
  const spawnRelay = opts.spawnRelay ?? realRelaySpawner(cfg);
  const now = opts.now ?? (() => Date.now());
  const limits = forwardLimits(cfg);
  const t = { ...RELAY_TIMINGS, ...(opts.timings ?? {}) };
  const servers = [];
  // Every accepted connection not yet closed. Tracked so close() can tear
  // them down: `server.close()` only stops ACCEPTING, and each relay is an ssh
  // + a remote docker exec, so a caller that stops the forwarder and keeps
  // running would strand one process trio per open connection. That caller
  // exists — the TUI owns a forward for as long as it is up
  // (src/tui/memforward.ts) — where before only systemd did.
  const conns = new Set();
  /** Connections with a request waiting for a relay, oldest first. */
  let queue = [];
  /** Relay children spawned and not yet exited: the sessions on the master. */
  let open = 0;
  /** Of those, the ones already told to stop — slots on their way back. */
  let retiring = 0;
  let closed = false;
  let ticker = null;
  const counters = {
    accepted: 0,
    /** Requests that ever had to wait (the live count is `queued`). */
    enqueued: 0,
    servedFromQueue: 0,
    yielded: 0,
    refusedTimeout: 0,
    refusedFull: 0,
    longestWaitMs: 0,
    peakOpen: 0,
    peakQueued: 0,
  };

  // one actionable line per cause, not one symptom line per relay.
  const collapser =
    opts.collapser ?? createFailureCollapser({ log, ...(opts.now ? { now: opts.now } : {}) });

  // ---- what the operator reads ------------------------------------------
  let episode = false;
  let lastQueueLogAt = Number.NEGATIVE_INFINITY;
  let lastRefusalLogAt = Number.NEGATIVE_INFINITY;
  let summaryOwed = false;
  let summaryBase = { ...counters };
  let longestSinceSummary = 0;
  const startEpisode = () => {
    if (episode) return;
    episode = true;
    const at = now();
    if (at - lastQueueLogAt < t.logWindowMs) return;
    lastQueueLogAt = at;
    summaryOwed = true;
    log(
      `relay cap reached: ${open}/${limits.maxRelays} relays open — requests wait (up to ${limits.queueMax}, ${seconds(limits.queueTimeoutMs)} each) and a relay between requests hands its slot over`,
    );
  };
  const endEpisode = () => {
    if (!episode) return;
    episode = false;
    if (!summaryOwed) return;
    summaryOwed = false;
    const d = (k) => counters[k] - summaryBase[k];
    const refused = d("refusedTimeout") + d("refusedFull");
    log(
      `relay queue drained: ${d("servedFromQueue")} request(s) waited for a relay (longest ${longestSinceSummary}ms), ${d("yielded")} relay(s) handed over between requests, ${refused} refused`,
    );
    summaryBase = { ...counters };
    longestSinceSummary = 0;
  };

  // ---- stats: the `status` subcommand's live view -------------------------
  let statsTimer = null;
  let statsWritten = false;
  const stats = () => {
    let leased = 0;
    let unyielding = 0;
    for (const c of conns) {
      if (!c.lease) continue;
      leased += 1;
      if (c.tracker.opaque()) unyielding += 1;
    }
    return {
      ...counters,
      maxRelays: limits.maxRelays,
      queueMax: limits.queueMax,
      queueTimeoutMs: limits.queueTimeoutMs,
      open,
      leased,
      unyielding,
      queued: queue.length,
      connections: conns.size,
    };
  };
  const writeStats = () => {
    statsTimer = null;
    if (closed || !cfg.statsFile) return;
    const snapshot = {
      pid: process.pid,
      port: cfg.port,
      transport: cfg.local ? "local docker" : cfg.sshHost,
      ...(cfg.local ? {} : { controlPath: cfg.controlPath }),
      updatedAt: new Date(now()).toISOString(),
      ...stats(),
    };
    try {
      const tmp = `${cfg.statsFile}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
      renameSync(tmp, cfg.statsFile);
      statsWritten = true;
    } catch (err) {
      if (!statsWritten) log(`cannot write the stats file ${cfg.statsFile}: ${errText(err)}`);
    }
  };
  const scheduleStats = () => {
    if (closed || !cfg.statsFile || statsTimer) return;
    statsTimer = setTimeout(writeStats, t.statsEveryMs);
    statsTimer.unref?.();
  };

  // ---- the slots ------------------------------------------------------------
  const startTicker = () => {
    if (ticker || closed) return;
    ticker = setInterval(rebalance, t.rebalanceMs);
    ticker.unref?.();
  };
  const stopTicker = () => {
    if (ticker) clearInterval(ticker);
    ticker = null;
  };

  /** Stop a relay. Its slot is free once the child has EXITED — the ssh
   * session is gone then — or at the SIGKILL, whichever comes first. */
  const retire = (lease) => {
    if (lease.retiring) return;
    lease.retiring = true;
    if (lease.released) return;
    retiring += 1;
    try {
      lease.child.kill();
    } catch {
      /* already gone */
    }
    lease.killTimer = setTimeout(() => {
      try {
        lease.child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      lease.release();
    }, t.killGraceMs);
    lease.killTimer.unref?.();
  };

  const dequeue = (conn) => {
    if (!conn.queued) return;
    conn.queued = false;
    if (conn.queueTimer) clearTimeout(conn.queueTimer);
    conn.queueTimer = null;
    queue = queue.filter((c) => c !== conn);
    if (queue.length === 0) {
      stopTicker();
      endEpisode();
    }
  };

  const pump = () => {
    if (closed) return;
    while (queue.length > 0 && open < limits.maxRelays) {
      const conn = queue.shift();
      conn.queued = false;
      if (conn.queueTimer) clearTimeout(conn.queueTimer);
      conn.queueTimer = null;
      const waited = now() - conn.queuedAt;
      counters.servedFromQueue += 1;
      counters.longestWaitMs = Math.max(counters.longestWaitMs, waited);
      longestSinceSummary = Math.max(longestSinceSummary, waited);
      grant(conn);
    }
    if (queue.length === 0) {
      stopTicker();
      endEpisode();
    } else rebalance();
  };

  /** Hand waiters the slots of relays that are between requests: the
   * longest-quiet first, and only as many as are still needed. */
  function rebalance() {
    if (closed || queue.length === 0) return stopTicker();
    const at = now();
    const ready = [...conns]
      .filter(
        (c) =>
          c.lease &&
          !c.lease.retiring &&
          !c.lease.released &&
          c.tracker.atRest() &&
          (at - c.lease.startedAt >= t.minLeaseMs || at - c.lastActive >= t.idleYieldMs),
      )
      .sort((a, b) => a.lastActive - b.lastActive);
    for (const c of ready) {
      if (queue.length <= retiring) break;
      park(c);
    }
    startTicker();
  }

  /** A connection that just lost its relay BETWEEN requests reads again. A
   * pause the old relay's full stdin set would otherwise stand for good: its
   * lift is that child's 'drain', which never comes from a child that is gone,
   * so the next request would be neither read nor queued. The hold limit's
   * own pause (`heldBytes` over it) is left standing. */
  const resumeAfterRelay = (conn) => {
    if (conn.socket.isPaused?.() && conn.heldBytes <= t.holdLimitBytes) conn.socket.resume();
  };

  /** Take a connection's relay away BETWEEN requests. The connection stays
   * open; its next request asks for a relay again. */
  const park = (conn) => {
    const lease = conn.lease;
    conn.lease = null;
    counters.yielded += 1;
    retire(lease);
    resumeAfterRelay(conn);
    scheduleStats();
  };

  /** A connection with bytes to send and no relay asks for one. */
  const wantRelay = (conn) => {
    if (conn.queued || conn.closed || conn.refused || conn.finishing || conn.lease) return;
    if (queue.length === 0 && open < limits.maxRelays) return grant(conn);
    if (queue.length >= limits.queueMax) return refuse(conn, "full");
    conn.queued = true;
    conn.queuedAt = now();
    queue.push(conn);
    counters.enqueued += 1;
    counters.peakQueued = Math.max(counters.peakQueued, queue.length);
    conn.queueTimer = setTimeout(() => {
      if (!conn.queued) return;
      dequeue(conn);
      refuse(conn, "timeout");
    }, limits.queueTimeoutMs);
    conn.queueTimer.unref?.();
    startEpisode();
    rebalance();
    scheduleStats();
  };

  /** A clean "no": the 503 envelope, a FIN, and the rest of the request read
   * and dropped — closing with unread bytes would RESET the answer away. */
  const refuse = (conn, why) => {
    if (conn.refused || conn.closed) return;
    conn.refused = true;
    dequeue(conn);
    if (why === "full") counters.refusedFull += 1;
    else counters.refusedTimeout += 1;
    const state = `${open}/${limits.maxRelays} relays open, ${queue.length} waiting`;
    const message =
      why === "full"
        ? `the memory forward's wait queue is full (${state}) — retry shortly`
        : `the memory forward is at its relay cap and this request waited ${seconds(limits.queueTimeoutMs)} for a relay (${state}) — retry shortly`;
    const at = now();
    if (at - lastRefusalLogAt >= t.logWindowMs) {
      lastRefusalLogAt = at;
      log(
        `refused a request — ${why === "full" ? `the wait queue is full (${limits.queueMax})` : `it waited ${seconds(limits.queueTimeoutMs)} for a relay`}; ${state} (more refusals are counted, not logged, for a minute)`,
      );
    }
    conn.held = [];
    conn.heldBytes = 0;
    try {
      if (!conn.tracker.opaque() && conn.socket.writable) conn.socket.write(busyResponse(message));
      conn.socket.end();
    } catch {
      /* the client is already gone */
    }
    if (conn.socket.isPaused?.()) conn.socket.resume();
    conn.lingerTimer = setTimeout(() => closeConn(conn), t.refuseLingerMs);
    conn.lingerTimer.unref?.();
    scheduleStats();
  };

  const closeConn = (conn) => {
    if (conn.closed) return;
    conn.closed = true;
    conns.delete(conn);
    dequeue(conn);
    for (const k of ["lingerTimer", "finishTimer"]) if (conn[k]) clearTimeout(conn[k]);
    if (conn.lease) {
      retire(conn.lease);
      conn.lease = null;
    }
    conn.socket.destroy();
    scheduleStats();
  };

  const writeToRelay = (conn, lease, chunk) => {
    let ok = true;
    try {
      ok = lease.child.stdin.write(chunk);
    } catch {
      return; // a dying relay; its exit settles the connection
    }
    if (ok) return;
    conn.socket.pause();
    lease.child.stdin.once?.("drain", () => {
      if (conn.lease === lease && !conn.closed) conn.socket.resume();
    });
  };

  /** The current relay ended. Between requests (the server closed an idle
   * keep-alive connection) the connection simply lives on without one;
   * mid-exchange the client must see the loss, so its side ends too — after
   * the relay's last bytes have reached it. */
  const relayEnded = (conn, lease) => {
    if (conn.closed || conn.lease !== lease) return;
    if (conn.tracker.atRest()) {
      conn.lease = null;
      resumeAfterRelay(conn);
      return;
    }
    conn.finishing = true;
    const finish = () => {
      if (conn.closed || conn.lease !== lease) return;
      conn.lease = null;
      try {
        conn.socket.end();
      } catch {
        /* already gone */
      }
      conn.lingerTimer = setTimeout(() => closeConn(conn), t.refuseLingerMs);
      conn.lingerTimer.unref?.();
    };
    if (lease.stdioClosed) return finish();
    lease.onStdioClosed = finish;
    conn.finishTimer = setTimeout(finish, t.relayCloseGraceMs);
    conn.finishTimer.unref?.();
  };

  const onRelayData = (conn, lease, chunk) => {
    if (conn.closed || conn.lease !== lease) return; // a stopped relay's late bytes go nowhere
    // The first byte back from the container IS the proof that the whole chain
    // works, so it is what clears a collapsed failure — self-recovery with no
    // restart, which is the half asked for beyond the rate limit.
    if (!lease.moved) {
      lease.moved = true;
      collapser.ok();
    }
    conn.lastActive = now();
    conn.tracker.server(chunk);
    if (!conn.socket.write(chunk)) {
      lease.child.stdout.pause?.();
      conn.socket.once("drain", () => lease.child.stdout.resume?.());
    }
    if (queue.length > 0 && conn.tracker.atRest()) rebalance();
  };

  function grant(conn) {
    let child;
    try {
      child = spawnRelay();
    } catch (err) {
      collapser.fail(relayFailureCause(cfg, errText(err)));
      closeConn(conn);
      return;
    }
    open += 1;
    counters.peakOpen = Math.max(counters.peakOpen, open);
    const lease = {
      child,
      startedAt: now(),
      moved: false,
      // Evidence for the cause: ssh writes the reason to stderr and then exits
      // 255, so the exit code alone can never name it.
      stderrText: "",
      retiring: false,
      released: false,
      stdioClosed: false,
      onStdioClosed: null,
      killTimer: null,
      release: () => {},
    };
    lease.release = () => {
      if (lease.released) return;
      lease.released = true;
      open -= 1;
      if (lease.retiring) retiring -= 1;
      if (lease.killTimer) clearTimeout(lease.killTimer);
      pump();
      scheduleStats();
    };
    conn.lease = lease;
    conn.lastActive = now();
    child.on?.("error", (err) => {
      if (!lease.retiring) collapser.fail(relayFailureCause(cfg, errText(err)));
      lease.release();
      if (conn.lease === lease) {
        conn.lease = null;
        closeConn(conn);
      }
    });
    child.on?.("exit", (code) => {
      // A relay that carried bytes and then exited is a closed connection, not
      // a failure — only one that never moved anything is worth a cause. One
      // WE stopped is neither.
      if (code && !lease.moved && !lease.retiring)
        collapser.fail(relayFailureCause(cfg, lease.stderrText));
      lease.release();
      relayEnded(conn, lease);
    });
    child.on?.("close", () => {
      lease.stdioClosed = true;
      lease.onStdioClosed?.();
    });
    child.stderr?.on?.("data", (d) => {
      lease.stderrText = `${lease.stderrText}${String(d)}`.slice(-2000);
    });
    // An EPIPE on a dying relay surfaces through its exit, never as a throw.
    child.stdin?.on?.("error", () => {});
    child.stdout?.on?.("error", () => {});
    child.stdout.on("data", (d) => onRelayData(conn, lease, d));
    const held = conn.held;
    conn.held = [];
    conn.heldBytes = 0;
    // Lift the hold limit's pause BEFORE the flush, so a pause the flush
    // itself sets (the relay's stdin full) stands. Resuming only flows on the
    // next tick, after the held bytes are written: the order holds.
    if (conn.socket.isPaused?.()) conn.socket.resume();
    for (const chunk of held) writeToRelay(conn, lease, chunk);
    if (conn.clientEnded) {
      try {
        child.stdin.end();
      } catch {
        /* already gone */
      }
    }
    scheduleStats();
  }

  const onConnection = (socket) => {
    if (closed) {
      socket.destroy();
      return;
    }
    counters.accepted += 1;
    const conn = {
      socket,
      tracker: createExchangeTracker(),
      lease: null,
      held: [],
      heldBytes: 0,
      queued: false,
      queuedAt: 0,
      queueTimer: null,
      lingerTimer: null,
      finishTimer: null,
      lastActive: now(),
      refused: false,
      finishing: false,
      clientEnded: false,
      closed: false,
    };
    conns.add(conn);
    socket.on("data", (chunk) => {
      if (conn.closed || conn.refused || conn.finishing) return; // read and dropped
      conn.lastActive = now();
      conn.tracker.client(chunk);
      const lease = conn.lease;
      if (lease && !lease.retiring) {
        writeToRelay(conn, lease, chunk);
        return;
      }
      conn.held.push(chunk);
      conn.heldBytes += chunk.length;
      if (conn.heldBytes > t.holdLimitBytes) socket.pause();
      wantRelay(conn);
    });
    socket.on("end", () => {
      conn.clientEnded = true;
      if (conn.lease && !conn.lease.retiring) {
        try {
          conn.lease.child.stdin.end();
        } catch {
          /* already gone */
        }
      }
    });
    socket.on("error", () => closeConn(conn));
    socket.on("close", () => closeConn(conn));
    // A free slot is taken at once, as every connection did before the cap;
    // with none free, nothing is owed until the client actually asks.
    if (queue.length === 0 && open < limits.maxRelays) grant(conn);
    else scheduleStats();
  };

  return {
    async listen() {
      for (const address of cfg.binds) {
        const server = createServer(onConnection);
        servers.push(server);
        await new Promise((res, rej) => {
          server.once("error", rej);
          server.listen(cfg.port, address, () => res(undefined));
        }).catch((err) => {
          // A bind that fails (gateway not up yet) must not take the loopback
          // listener down with it — systemd restarts us either way.
          log(`cannot bind ${address}:${cfg.port}: ${errText(err)}`);
        });
        const addr = server.address();
        if (addr)
          log(
            `listening on ${addr.address}:${addr.port} → ${cfg.local ? "local docker" : cfg.sshHost} ${cfg.container} ${cfg.remoteHost}:${cfg.remotePort} — at most ${limits.maxRelays} relays at once, up to ${limits.queueMax} requests wait ${seconds(limits.queueTimeoutMs)}`,
          );
      }
      const bound = servers.filter((s) => s.address() !== null).length;
      if (bound > 0 && !cfg.local && limits.maxRelays >= SSHD_DEFAULT_MAX_SESSIONS)
        log(
          `WARNING: --max-relays ${limits.maxRelays} is not under sshd's default MaxSessions (${SSHD_DEFAULT_MAX_SESSIONS}) — a relay past the server's limit is refused on the shared connection and quietly opens a full ssh login of its own, which can fail; check \`ssh ${cfg.sshHost} sudo sshd -T | grep -i maxsessions\``,
        );
      if (bound > 0) writeStats();
      return bound;
    },
    /** Stop accepting AND tear down what is still in flight. Both halves are
     * required: without the second, a still-running caller leaks one ssh +
     * remote node per open connection. */
    close() {
      for (const s of servers) s.close();
      closed = true;
      stopTicker();
      if (statsTimer) clearTimeout(statsTimer);
      statsTimer = null;
      for (const conn of [...conns]) {
        if (conn.queueTimer) clearTimeout(conn.queueTimer);
        conn.queued = false;
        closeConn(conn);
      }
      queue = [];
      if (statsWritten && cfg.statsFile) {
        // Only OUR file: another forward may have taken the port since.
        try {
          const mine = JSON.parse(readFileSync(cfg.statsFile, "utf8")).pid === process.pid;
          if (mine) unlinkSync(cfg.statsFile);
        } catch {
          /* gone already, or not ours to read */
        }
      }
    },
    /** Connections holding a relay — the test's handle on the teardown above. */
    liveRelays: () => [...conns].filter((c) => c.lease).length,
    /** The cap, the queue and what they have done (F1). */
    stats,
    /** Bound ports (the test asks for the ephemeral one). */
    addresses: () => servers.map((s) => s.address()).filter(Boolean),
  };
}

/**
 * Where the running forward writes its live counts for `status` (F1):
 * `$XDG_RUNTIME_DIR/qcr-memory-forward-<port>.json` — the same directory the
 * systemd unit's `%t` names, so the CLI and the unit agree. No runtime dir, no
 * file: `status` then says the counts are unknown rather than guessing.
 */
export function statsFilePath(env = process.env, port = DEFAULTS.port) {
  const dir = (env.XDG_RUNTIME_DIR ?? "").trim();
  if (dir === "" || !isAbsolute(dir)) return null;
  return join(dir, `qcr-memory-forward-${port}.json`);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

/**
 * Read the running forward's stats file: `live`, `stale` (its pid is gone),
 * `absent`, `unreadable`, or `off` (no path) — never a guessed zero.
 *
 * @param {string | null | undefined} path
 * @param {{ read?: (p: string) => string, alive?: (pid: number) => boolean }} [deps]
 */
export function readForwardStats(path, deps = {}) {
  if (!path) return { state: "off" };
  let text;
  try {
    text = (deps.read ?? ((p) => readFileSync(p, "utf8")))(path);
  } catch (err) {
    return err?.code === "ENOENT"
      ? { state: "absent" }
      : { state: "unreadable", error: errText(err) };
  }
  let snapshot;
  try {
    snapshot = JSON.parse(text);
  } catch {
    return { state: "unreadable", error: "not JSON" };
  }
  if (!snapshot || typeof snapshot !== "object")
    return { state: "unreadable", error: "not a stats object" };
  return { state: (deps.alive ?? pidAlive)(snapshot.pid) ? "live" : "stale", snapshot };
}

/** What `status` prints about the cap — the running forward's own numbers
 * when it is live, this command's settings otherwise, never a made-up count. */
export function describeForwardStats(cfg, read) {
  const lim = forwardLimits(cfg);
  const capLine = (s, whose) =>
    `relay cap${whose}: ${s.maxRelays} at once (sshd's default MaxSessions is ${SSHD_DEFAULT_MAX_SESSIONS}); up to ${s.queueMax} requests wait ${seconds(s.queueTimeoutMs)} each`;
  if (read.state !== "live") {
    const why = {
      off: "no stats file (XDG_RUNTIME_DIR is not set)",
      absent: `no forward has written ${cfg.statsFile} (none running on this port, or one started before F1)`,
      unreadable: `${cfg.statsFile} is unreadable (${read.error})`,
      stale: `${cfg.statsFile} names pid ${read.snapshot?.pid}, which is not running`,
    }[read.state];
    return [capLine(lim, " (this command's settings)"), `live relays: unknown — ${why}`];
  }
  const s = read.snapshot;
  const lines = [capLine(s, "")];
  lines.push(
    `live relays (pid ${s.pid}, as of ${s.updatedAt}): ${s.open}/${s.maxRelays} open, ${s.queued} waiting, ${s.unyielding ?? 0} held by connections that cannot hand over (peak ${s.peakOpen} open, ${s.peakQueued} waiting)`,
  );
  lines.push(
    `since start: ${s.servedFromQueue} request(s) waited for a relay (longest ${s.longestWaitMs}ms), ${s.yielded} relay(s) handed over between requests, refused ${s.refusedTimeout} on timeout and ${s.refusedFull} on a full queue`,
  );
  if (s.maxRelays !== lim.maxRelays)
    lines.push(
      `(this command would use ${lim.maxRelays}; the running forward was started with other settings)`,
    );
  return lines;
}

// ---- systemd ----------------------------------------------------------------

/**
 * SSH_AUTH_SOCK for the unit. A path under $XDG_RUNTIME_DIR is rewritten to
 * systemd's `%t` so it survives a reboot; a per-session /tmp agent path cannot
 * survive one and is reported as such by the caller.
 */
export function unitAuthSock(env = process.env) {
  const sock = (env.SSH_AUTH_SOCK ?? "").trim();
  if (sock === "") return { value: "", stable: false, why: "no SSH_AUTH_SOCK in this shell" };
  const runtime = (env.XDG_RUNTIME_DIR ?? "").trim();
  if (runtime !== "" && sock.startsWith(`${runtime}/`)) {
    return { value: `%t/${sock.slice(runtime.length + 1)}`, stable: true, why: "" };
  }
  return {
    value: sock,
    stable: false,
    why: "the agent socket path looks per-session; prefer --identity <key> or a keyring agent",
  };
}

/** The systemd --user unit. Pure so the test can read it. */
export function unitText(cfg, env = process.env) {
  const script = join(ROOT, "scripts", "companion-memory-forward.mjs");
  const auth = unitAuthSock(env);
  const runArgs = [
    "run",
    ...(cfg.local ? ["--local"] : ["--ssh-host", cfg.sshHost]),
    "--container",
    cfg.container,
    "--port",
    String(cfg.port),
    "--gateway",
    cfg.gateway,
    ...(cfg.sudo ? [] : ["--no-sudo"]),
    ...(cfg.identity ? ["--identity", cfg.identity] : []),
    // F1: the cap and the control socket ride the unit only when they
    // differ from the defaults, so a later default reaches an installed unit.
    ...unitLimitArgs(cfg),
  ].join(" ");
  // name the transport truthfully — a local unit that claimed to
  // forward "OpenViking on my-vm" is the line an operator reads first in
  // `systemctl --user status` when the laptop route misbehaves.
  const where = cfg.local ? "local docker" : cfg.sshHost;
  return `[Unit]
Description=quickreview companion memory forward (OpenViking on ${where} -> ${cfg.gateway}:${cfg.port})
Documentation=file://${join(ROOT, "docs", "companion-memory-access.md")}
After=default.target

[Service]
Type=simple
${auth.value === "" ? "" : `Environment=SSH_AUTH_SOCK=${auth.value}\n`}ExecStartPre=${process.execPath} ${script} ensure-network --network ${cfg.network} --subnet ${cfg.subnet}
ExecStart=${process.execPath} ${script} ${runArgs}
Restart=always
RestartSec=5
# This process is the ONLY holder of a VM credential in the companion path.
# It runs as the desktop user, never inside a container (root CLAUDE.md rule 8).
NoNewPrivileges=yes

[Install]
WantedBy=default.target
`;
}

/**
 * The non-default relay settings as `run` flags for the unit's ExecStart.
 * A control path is written with `%` doubled: systemd expands `%C`, `%h`,
 * `%r`, `%p` itself in ExecStart, and those are also ssh's tokens.
 */
export function unitLimitArgs(cfg, home = homedir()) {
  const lim = forwardLimits(cfg);
  const out = [];
  if (lim.maxRelays !== DEFAULTS.maxRelays) out.push("--max-relays", String(lim.maxRelays));
  if (lim.queueMax !== DEFAULTS.queueMax) out.push("--queue-max", String(lim.queueMax));
  if (lim.queueTimeoutMs !== DEFAULTS.queueTimeoutS * 1000)
    out.push("--queue-timeout", String(Math.round(lim.queueTimeoutMs / 1000)));
  if (!cfg.local && cfg.controlPath && cfg.controlPath !== defaultControlPath(home))
    out.push("--control-path", cfg.controlPath.replaceAll("%", "%%"));
  return out;
}

export function unitPath(cfg, home = homedir()) {
  return join(home, ".config", "systemd", "user", `${cfg.unit}.service`);
}

// ---- the confinement proof --------------------------------------------------
//
// The reverse direction is the property that makes two USER keys safe: the
// reviewer key (which every automated review session holds) must be unable to
// read or write companion memory. Server-side confinement was verified against
// a running 0.4.15 server; this turns it into something re-runnable on demand.
//
// The REQUEST SHAPES below are the adjustable part — src/memory is
// the authority for what OpenViking's read/write endpoints look like. The
// VERDICT logic (what each status code proves) is what the unit test pins, and
// anything that is neither reach nor refusal is reported "inconclusive", never
// as a pass.

export const PATHS = {
  /** A directory listing at the user root: exists for every user, and needs no
   * knowledge of which memory "space" that user happens to have. */
  read: (env = process.env) => (env.QCR_OV_READ_PATH ?? "/api/v1/fs/ls").trim(),
  // `{user}` is substituted with the namespace being probed. VERIFIED LIVE
  // (2026-08-25, api_key mode): the server derives identity from the KEY and
  // confines by URI — `X-OpenViking-User` does NOT select the namespace, so a
  // bare `viking://user/` read answered 200 for every key and the cross-cells
  // could never fail. The namespace must live in the URI.
  readUri: (env = process.env, user = "") =>
    (env.QCR_OV_READ_URI ?? "viking://user/{user}/").trim().replaceAll("{user}", user),
  /** The ONE durable write path (see the vendored client's PATCH 4 note). */
  write: (env = process.env) => (env.QCR_OV_WRITE_PATH ?? "/api/v1/content/batch-write").trim(),
};

/**
 * Auth + the cross-user selector.
 *
 * `X-OpenViking-User` is what names the namespace being addressed; the Bearer
 * key is what the server checks it against. That pairing IS the confinement
 * being proved: reviewer key + `X-OpenViking-User: companion` must be refused.
 */
export function authHeaders(key, user, env = process.env) {
  const name = (env.QCR_OV_AUTH_HEADER ?? "Authorization").trim();
  const prefix = (env.QCR_OV_AUTH_PREFIX ?? "Bearer ").replace(/\\s/g, " ");
  return {
    [name]: `${prefix}${key}`,
    "X-OpenViking-User": user,
    "X-OpenViking-Actor-Peer": user,
    "Content-Type": "application/json",
  };
}

const REFUSAL_WORDS = /forbid|permission|unauthor|denied|not allowed|access.*(denied|refused)/i;

/**
 * How one probe reads.
 *
 * OpenViking answers some errors with HTTP 200 and `{status:"error"}` in the
 * envelope, so the status code alone is not enough: a 200 whose body says
 * "permission denied" is a refusal, and a 200 whose body says something else
 * entirely is INCONCLUSIVE — never a pass.
 */
export function classify(status, body) {
  if (status === 401 || status === 403) return "refused";
  if (status >= 200 && status < 300) {
    const envelope = body && typeof body === "object" ? body : {};
    if (envelope.status === "error") {
      const message = String(envelope.error?.message ?? envelope.error ?? "");
      return REFUSAL_WORDS.test(message) ? "refused" : "inconclusive";
    }
    return "reach";
  }
  return "inconclusive"; // 404 (wrong uri), 5xx, transport — cannot tell
}

/** The four (key, namespace) pairs and what each MUST show. */
export function expectations() {
  return [
    {
      who: "companion",
      ns: "companion",
      want: "reach",
      why: "the companion writes and reads its own memory",
    },
    {
      who: "reviewer",
      ns: "reviewer",
      want: "reach",
      why: "the companion holds the reviewer key too — full reach over review memory",
    },
    {
      who: "reviewer",
      ns: "companion",
      want: "refused",
      why: "REVERSE DIRECTION: review sessions hold only this key and must not see companion memory",
    },
    {
      who: "companion",
      ns: "reviewer",
      want: "refused",
      why: "user keys are confined both ways (the companion uses the reviewer key for that namespace)",
    },
  ];
}

export function verdictFor(expected, observed) {
  if (observed === "inconclusive") return "INCONCLUSIVE";
  return observed === expected ? "PASS" : "FAIL";
}

/** Read the two keys. Values are used, never printed or logged. */
export function readKeys(path) {
  const out = {};
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

async function probePair(base, key, ns, env, fetchFn, doWrite) {
  const headers = authHeaders(key, ns, env);
  const at = new Date().toISOString().replace(/[:.]/g, "-");
  const init = doWrite
    ? {
        method: "POST",
        headers,
        body: JSON.stringify({
          // Namespace in the URI, same reason as the read probe: the server
          // confines by URI, not by the X-OpenViking-User header.
          // "batch-write root must be inside a memory type directory" — the
          // root needs the category level under memories/ (the store's
          // DEFAULT_CATEGORY, src/openviking/store.ts). Verified live.
          root_uri: `viking://user/${ns}/memories/experiences`,
          operations: [
            {
              uri: `viking://user/${ns}/memories/experiences/qcr-confinement-probe-${at}.md`,
              content: `confinement probe ${at}\n`,
              // Mandatory on the live 0.4.15: an operation without a
              // precondition is HTTP 400 (mirrors src/openviking/client.ts).
              precondition: { kind: "create_if_absent" },
            },
          ],
          wait: false,
        }),
      }
    : { method: "GET", headers };
  const url = doWrite
    ? `${base}${PATHS.write(env)}`
    : `${base}${PATHS.read(env)}?uri=${encodeURIComponent(PATHS.readUri(env, ns))}`;
  try {
    // 30s: the forward path is ssh + docker exec per request, and the local
    // dense embedder answers slowly from cold — 8s produced false timeouts.
    const res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(30000) });
    const body = res.json ? await res.json().catch(() => ({})) : {};
    return { status: res.status, classification: classify(res.status, body) };
  } catch (err) {
    return { status: 0, classification: "inconclusive", error: errText(err) };
  }
}

/**
 * Run the matrix. Resolves a report; never throws on a probe failure.
 * `keys` maps role → key value.
 *
 * `fetchFn` is declared by the MINIMUM the probe reads — a status and an
 * optional `json()` — not as `typeof fetch`, which is what the default binds
 * it to. A seam typed by its implementation makes every test double fabricate
 * a whole `Response` for no gain.
 *
 * @param {{
 *   base: string,
 *   keys: Record<string, string>,
 *   env?: Record<string, string | undefined>,
 *   fetchFn?: (url: string, init?: { method?: string, headers?: Record<string, string>, body?: string, signal?: AbortSignal }) => Promise<{ status: number, json?: () => Promise<unknown> }>,
 *   write?: boolean,
 *   log?: (line: string) => void,
 * }} opts
 */
export async function runVerify({
  base,
  keys,
  env = process.env,
  fetchFn = fetch,
  write = false,
  log = console.log,
}) {
  const rows = [];
  for (const e of expectations()) {
    const key = e.who === "companion" ? keys.companion : keys.reviewer;
    if (!key) {
      rows.push({
        ...e,
        observed: "inconclusive",
        verdict: "INCONCLUSIVE",
        detail: `no ${e.who} key configured`,
      });
      continue;
    }
    const r = await probePair(base, key, e.ns, env, fetchFn, write);
    rows.push({
      ...e,
      observed: r.classification,
      verdict: verdictFor(e.want, r.classification),
      detail: r.error ?? `HTTP ${r.status}`,
    });
  }
  for (const r of rows) {
    log(
      `${r.verdict.padEnd(13)} ${r.who} key → user/${r.ns} memory: expected ${r.want}, got ${r.observed} (${r.detail})`,
    );
    if (r.verdict !== "PASS") log(`              ${r.why}`);
  }
  const failed = rows.filter((r) => r.verdict === "FAIL").length;
  const unclear = rows.filter((r) => r.verdict === "INCONCLUSIVE").length;
  log(`\n${rows.length - failed - unclear} pass, ${failed} fail, ${unclear} inconclusive`);
  if (unclear > 0) {
    log("Inconclusive rows mean the request shape did not match this server — adjust");
    log(
      "QCR_OV_READ_PATH / QCR_OV_READ_URI / QCR_OV_WRITE_PATH / QCR_OV_AUTH_HEADER (see docs/companion-memory-access.md).",
    );
  }
  return { rows, failed, unclear };
}

// ---- cli --------------------------------------------------------------------

export function parseArgs(argv, env = process.env) {
  const cmd = argv[0] && !argv[0].startsWith("--") ? argv[0] : "run";
  const rest = argv[0] && !argv[0].startsWith("--") ? argv.slice(1) : argv;
  const flags = new Map();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) continue;
    const [name, inline] = a.slice(2).split("=", 2);
    if (inline !== undefined) flags.set(name, inline);
    else if (rest[i + 1] && !rest[i + 1].startsWith("--")) flags.set(name, rest[++i]);
    else flags.set(name, "true");
  }
  const num = (k, d) => (flags.has(k) ? Number(flags.get(k)) : d);
  // F1: a positive whole number from a flag, else the env, else the
  // default. A bad value REFUSES rather than falling back: a cap silently
  // replaced by something else is the defect this exists to prevent.
  const count = (flag, envName, d) => {
    const fromEnv = (env[envName] ?? "").trim();
    const raw = flags.has(flag) ? String(flags.get(flag)) : fromEnv !== "" ? fromEnv : undefined;
    if (raw === undefined) return d;
    if (!/^\d+$/.test(raw) || Number(raw) < 1)
      throw new Error(
        `--${flag} (${envName}) must be a whole number of at least 1, got ${JSON.stringify(raw)}`,
      );
    return Number(raw);
  };
  const gateway = flags.get("gateway") ?? env.QCR_MEMORY_GATEWAY ?? DEFAULTS.gateway;
  const port = num("port", Number(env.QCR_MEMORY_PORT ?? DEFAULTS.port));
  const sshHost = flags.get("ssh-host") ?? env.QCR_SSH_HOST ?? DEFAULTS.sshHost;
  // one-machine topology — the relay is a plain local `docker exec`,
  // no ssh hop. `--local` (or QCR_MEMORY_LOCAL=1) selects it; an EXPLICIT
  // empty --ssh-host means the same thing (there is no host to ssh to).
  const local =
    flags.has("local") ||
    ["1", "true"].includes((env.QCR_MEMORY_LOCAL ?? "").trim()) ||
    sshHost === "";
  const cfg = {
    network: flags.get("network") ?? DEFAULTS.network,
    subnet: flags.get("subnet") ?? DEFAULTS.subnet,
    gateway,
    port,
    // Loopback too: `verify`, curl and any host-side tool use it, and it is the
    // half that keeps working when docker is down.
    binds: (flags.get("bind") ?? `${gateway},127.0.0.1`)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    sshHost,
    local,
    container: flags.get("container") ?? env.QCR_VM_CONTAINER ?? DEFAULTS.container,
    remoteHost: flags.get("remote-host") ?? DEFAULTS.remoteHost,
    remotePort: num("remote-port", DEFAULTS.remotePort),
    sudo: !flags.has("no-sudo"),
    identity: flags.get("identity"),
    controlPath: flags.get("control-path") ?? defaultControlPath(),
    // F1 — one parser, so the systemd unit and the TUI (which runs
    // this same parseArgs) carry the same cap.
    maxRelays: count("max-relays", "QCR_MEMORY_MAX_RELAYS", DEFAULTS.maxRelays),
    queueMax: count("queue-max", "QCR_MEMORY_QUEUE_MAX", DEFAULTS.queueMax),
    queueTimeoutMs:
      count("queue-timeout", "QCR_MEMORY_QUEUE_TIMEOUT_S", DEFAULTS.queueTimeoutS) * 1000,
    statsFile: flags.get("stats-file") ?? statsFilePath(env, port),
    unit: flags.get("unit") ?? DEFAULTS.unit,
    write: flags.has("write"),
    base: flags.get("base") ?? `http://127.0.0.1:${port}`,
    keysFile: flags.get("keys") ?? keysFilePath(env),
  };
  return { cmd, cfg, flags };
}

function errText(err) {
  if (err instanceof Error)
    return err.name === "TimeoutError" || err.name === "AbortError" ? "timeout" : err.message;
  return String(err);
}

function run(bin, args) {
  return spawnSync(bin, args, { encoding: "utf8" });
}

function ensureNetwork(cfg) {
  const inspect = run("docker", [
    "network",
    "inspect",
    "--format",
    "{{range .IPAM.Config}}{{.Gateway}}{{end}}",
    cfg.network,
  ]);
  if (inspect.status === 0 && inspect.stdout.trim() !== "") {
    console.log(`docker network ${cfg.network} present (gateway ${inspect.stdout.trim()})`);
    return 0;
  }
  const created = run("docker", ["network", "create", "--subnet", cfg.subnet, cfg.network]);
  if (created.status !== 0) {
    console.error(
      `could not create docker network ${cfg.network}: ${(created.stderr || "").trim()}`,
    );
    return 1;
  }
  console.log(`docker network ${cfg.network} created (${cfg.subnet})`);
  return 0;
}

function install(cfg) {
  if (ensureNetwork(cfg) !== 0) return 1;
  const path = unitPath(cfg);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, unitText(cfg));
  console.log(`wrote ${path}`);
  const auth = unitAuthSock();
  if (!auth.stable) console.log(`WARNING: ${auth.why}`);
  const keys = cfg.keysFile;
  if (!existsSync(keys)) {
    console.log(`\nNEXT: create ${keys} (chmod 600) with the two OpenViking USER keys:`);
    console.log("  OPENVIKING_API_KEY=<companion user key>");
    console.log("  OPENVIKING_COMPANION_KEY=<companion user key>");
    console.log("  OPENVIKING_REVIEWER_KEY=<reviewer user key>");
  }
  for (const args of [
    ["--user", "daemon-reload"],
    ["--user", "enable", "--now", `${cfg.unit}.service`],
  ]) {
    const r = run("systemctl", args);
    if (r.status !== 0) {
      console.error(`systemctl ${args.join(" ")} failed: ${(r.stderr || "").trim()}`);
      return 1;
    }
  }
  console.log(`systemd unit ${cfg.unit}.service enabled and started`);
  console.log(
    `run once so it survives logout/reboot:  loginctl enable-linger ${process.env.USER ?? ""}`,
  );
  return 0;
}

function uninstall(cfg) {
  run("systemctl", ["--user", "disable", "--now", `${cfg.unit}.service`]);
  console.log(`${cfg.unit}.service disabled (unit file, docker network and keys left in place)`);
  return 0;
}

async function status(cfg) {
  const unit = run("systemctl", ["--user", "is-active", `${cfg.unit}.service`]);
  console.log(
    `unit ${cfg.unit}.service: ${(unit.stdout || unit.stderr || "").trim() || "unknown"}`,
  );
  const net = run("docker", [
    "network",
    "inspect",
    "--format",
    "{{range .IPAM.Config}}{{.Gateway}}{{end}}",
    cfg.network,
  ]);
  console.log(
    `docker network ${cfg.network}: ${net.status === 0 ? `gateway ${net.stdout.trim()}` : "absent"}`,
  );
  console.log(`endpoint for the container: http://${cfg.gateway}:${cfg.port}`);
  // F1: the cap, and the running forward's own live counts.
  for (const line of describeForwardStats(cfg, readForwardStats(cfg.statsFile))) console.log(line);
  for (const probe of ["/health", "/ready"]) {
    try {
      const res = await fetch(`http://127.0.0.1:${cfg.port}${probe}`, {
        signal: AbortSignal.timeout(5000),
      });
      console.log(`  ${probe}: HTTP ${res.status}`);
    } catch (err) {
      console.log(`  ${probe}: ${errText(err)}`);
    }
  }
  const keys = readKeys(cfg.keysFile);
  const have = ["OPENVIKING_API_KEY", "OPENVIKING_COMPANION_KEY", "OPENVIKING_REVIEWER_KEY"].filter(
    (n) => keys[n],
  );
  console.log(
    `keys file ${cfg.keysFile}: ${have.length > 0 ? `defines ${have.join(", ")}` : "missing or empty"}`,
  );
  return 0;
}

async function verify(cfg) {
  const raw = readKeys(cfg.keysFile);
  const keys = {
    companion: raw.OPENVIKING_COMPANION_KEY ?? raw.OPENVIKING_API_KEY,
    reviewer: raw.OPENVIKING_REVIEWER_KEY,
  };
  if (!keys.companion || !keys.reviewer) {
    console.error(
      `both keys are required in ${cfg.keysFile} (OPENVIKING_COMPANION_KEY / OPENVIKING_API_KEY and OPENVIKING_REVIEWER_KEY)`,
    );
    return 2;
  }
  console.log(`probing ${cfg.base} (${cfg.write ? "read + write" : "read-only"})\n`);
  const report = await runVerify({ base: cfg.base, keys, write: cfg.write });
  return report.failed > 0 ? 1 : 0;
}

async function main(argv) {
  const { cmd, cfg } = parseArgs(argv);
  switch (cmd) {
    case "ensure-network":
      return ensureNetwork(cfg);
    case "install":
      return install(cfg);
    case "uninstall":
      return uninstall(cfg);
    case "status":
      return status(cfg);
    case "verify":
      return verify(cfg);
    case "run": {
      const fwd = createForwarder(cfg);
      const bound = await fwd.listen();
      if (bound < cfg.binds.length) {
        // Half a forward is not a forward: the bridge address is the one the
        // container uses. Exit and let systemd retry in RestartSec rather than
        // sit there pretending to serve.
        console.error(
          `[memory-forward] bound ${bound}/${cfg.binds.length} addresses (${cfg.binds.join(", ")}) — is the docker network up?`,
        );
        fwd.close();
        return 1;
      }
      for (const sig of ["SIGTERM", "SIGINT"]) {
        process.on(sig, () => {
          fwd.close();
          process.exit(0);
        });
      }
      return new Promise(() => {});
    }
    default:
      console.error(`unknown command: ${cmd}`);
      console.error(
        "usage: companion-memory-forward.mjs [run|install|uninstall|status|ensure-network|verify] [--flags]",
      );
      return 2;
  }
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
      console.error(`[memory-forward] ${errText(err)}`);
      process.exit(1);
    });
}
