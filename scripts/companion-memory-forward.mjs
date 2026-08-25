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
//     ssh my-vm ──▶ sudo docker exec -i quickreview-sandbox
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
// SUBCOMMANDS
//   run              the forwarder itself (what the systemd unit executes)
//   install          create the docker network + write/enable the user unit
//   uninstall        stop + disable the unit (network and keys left alone)
//   status           unit state, network, endpoint, one live probe
//   ensure-network   idempotent docker network create (the unit's ExecStartPre)
//   verify           the two-key reach + confinement proof (see docs/)
//
// Zero dependencies, no repo build needed: systemd must be able to run this
// from a bare checkout at boot.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
};

/** The keys file — same path src/tui/companion.ts reads (0600, two USER keys). */
export function keysFilePath(env = process.env, home = homedir()) {
  const override = (env.QCR_OPENVIKING_KEYS ?? "").trim();
  return override !== "" ? override : join(home, ".config", "quickreview-bot", "openviking-keys.env");
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
    // would pay a full login.
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

// ---- the forwarder ----------------------------------------------------------

/** Spawn one relay child. Injectable so the test drives streams, not ssh. */
export function realRelaySpawner(cfg) {
  return () => spawn("ssh", relayArgv(cfg), { stdio: ["pipe", "pipe", "pipe"] });
}

/**
 * The listener. One TCP server per bind address; every accepted connection gets
 * its own relay child, and either side closing tears the pair down.
 *
 * Failure is always local and always survivable: a relay that cannot start
 * closes that one connection (the extension sees a connection error, degrades,
 * and the in-container watcher alerts) — the forwarder keeps listening.
 */
export function createForwarder(cfg, opts = {}) {
  const log = opts.log ?? ((line) => console.log(`[memory-forward] ${line}`));
  const spawnRelay = opts.spawnRelay ?? realRelaySpawner(cfg);
  const servers = [];
  let live = 0;
  // Every in-flight socket↔child pair. Tracked so close() can tear them down:
  // `server.close()` only stops ACCEPTING, and each relay is an ssh + a remote
  // docker exec, so a caller that stops the forwarder and keeps running would
  // strand one process trio per open connection. That caller now exists — the
  // TUI owns a forward for as long as it is up (src/tui/memforward.ts) — where
  // before only systemd did, and a process exiting cleaned up for free.
  const pairs = new Set();

  const onConnection = (socket) => {
    const id = ++live;
    let child;
    try {
      child = spawnRelay();
    } catch (err) {
      log(`relay spawn failed: ${errText(err)}`);
      socket.destroy();
      return;
    }
    const pair = { socket, child };
    pairs.add(pair);
    const done = () => {
      pairs.delete(pair);
      socket.destroy();
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    };
    socket.on("error", done);
    socket.on("close", done);
    child.on?.("error", (err) => {
      log(`relay #${id} error: ${errText(err)}`);
      done();
    });
    child.on?.("exit", (code) => {
      if (code) log(`relay #${id} exited ${code}`);
      socket.destroy();
    });
    child.stderr?.on?.("data", (d) => log(`relay #${id}: ${String(d).trim()}`));
    socket.pipe(child.stdin);
    child.stdout.pipe(socket);
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
        if (addr) log(`listening on ${addr.address}:${addr.port} → ${cfg.sshHost} ${cfg.container} ${cfg.remoteHost}:${cfg.remotePort}`);
      }
      return servers.filter((s) => s.address() !== null).length;
    },
    /** Stop accepting AND tear down what is still in flight. Both halves are
     * required: without the second, a still-running caller leaks one ssh +
     * remote node per open connection. */
    close() {
      for (const s of servers) s.close();
      for (const { socket, child } of [...pairs]) {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        socket.destroy();
      }
      pairs.clear();
    },
    /** In-flight relay count — the test's handle on the teardown above. */
    liveRelays: () => pairs.size,
    /** Bound ports (the test asks for the ephemeral one). */
    addresses: () => servers.map((s) => s.address()).filter(Boolean),
  };
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
  return { value: sock, stable: false, why: "the agent socket path looks per-session; prefer --identity <key> or a keyring agent" };
}

/** The systemd --user unit. Pure so the test can read it. */
export function unitText(cfg, env = process.env) {
  const script = join(ROOT, "scripts", "companion-memory-forward.mjs");
  const auth = unitAuthSock(env);
  const runArgs = [
    "run",
    "--ssh-host",
    cfg.sshHost,
    "--container",
    cfg.container,
    "--port",
    String(cfg.port),
    "--gateway",
    cfg.gateway,
    ...(cfg.sudo ? [] : ["--no-sudo"]),
    ...(cfg.identity ? ["--identity", cfg.identity] : []),
  ].join(" ");
  return `[Unit]
Description=quickreview companion memory forward (OpenViking on ${cfg.sshHost} -> ${cfg.gateway}:${cfg.port})
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
    { who: "companion", ns: "companion", want: "reach", why: "the companion writes and reads its own memory" },
    { who: "reviewer", ns: "reviewer", want: "reach", why: "the companion holds the reviewer key too — full reach over review memory" },
    { who: "reviewer", ns: "companion", want: "refused", why: "REVERSE DIRECTION: review sessions hold only this key and must not see companion memory" },
    { who: "companion", ns: "reviewer", want: "refused", why: "user keys are confined both ways (the companion uses the reviewer key for that namespace)" },
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
          root_uri: `viking://user/${ns}/memories`,
          operations: [
            {
              uri: `viking://user/${ns}/memories/qcr-confinement-probe-${at}.md`,
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
  const url = doWrite ? `${base}${PATHS.write(env)}` : `${base}${PATHS.read(env)}?uri=${encodeURIComponent(PATHS.readUri(env, ns))}`;
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
 */
export async function runVerify({ base, keys, env = process.env, fetchFn = fetch, write = false, log = console.log }) {
  const rows = [];
  for (const e of expectations()) {
    const key = e.who === "companion" ? keys.companion : keys.reviewer;
    if (!key) {
      rows.push({ ...e, observed: "inconclusive", verdict: "INCONCLUSIVE", detail: `no ${e.who} key configured` });
      continue;
    }
    const r = await probePair(base, key, e.ns, env, fetchFn, write);
    rows.push({ ...e, observed: r.classification, verdict: verdictFor(e.want, r.classification), detail: r.error ?? `HTTP ${r.status}` });
  }
  for (const r of rows) {
    log(`${r.verdict.padEnd(13)} ${r.who} key → user/${r.ns} memory: expected ${r.want}, got ${r.observed} (${r.detail})`);
    if (r.verdict !== "PASS") log(`              ${r.why}`);
  }
  const failed = rows.filter((r) => r.verdict === "FAIL").length;
  const unclear = rows.filter((r) => r.verdict === "INCONCLUSIVE").length;
  log(`\n${rows.length - failed - unclear} pass, ${failed} fail, ${unclear} inconclusive`);
  if (unclear > 0) {
    log("Inconclusive rows mean the request shape did not match this server — adjust");
    log("QCR_OV_READ_PATH / QCR_OV_READ_URI / QCR_OV_WRITE_PATH / QCR_OV_AUTH_HEADER (see docs/companion-memory-access.md).");
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
  const gateway = flags.get("gateway") ?? env.QCR_MEMORY_GATEWAY ?? DEFAULTS.gateway;
  const port = num("port", Number(env.QCR_MEMORY_PORT ?? DEFAULTS.port));
  const cfg = {
    network: flags.get("network") ?? DEFAULTS.network,
    subnet: flags.get("subnet") ?? DEFAULTS.subnet,
    gateway,
    port,
    // Loopback too: `verify`, curl and any host-side tool use it, and it is the
    // half that keeps working when docker is down.
    binds: (flags.get("bind") ?? `${gateway},127.0.0.1`).split(",").map((s) => s.trim()).filter(Boolean),
    sshHost: flags.get("ssh-host") ?? env.QCR_SSH_HOST ?? DEFAULTS.sshHost,
    container: flags.get("container") ?? env.QCR_VM_CONTAINER ?? DEFAULTS.container,
    remoteHost: flags.get("remote-host") ?? DEFAULTS.remoteHost,
    remotePort: num("remote-port", DEFAULTS.remotePort),
    sudo: !flags.has("no-sudo"),
    identity: flags.get("identity"),
    controlPath: flags.get("control-path") ?? join(homedir(), ".ssh", "cm-%r@%h:%p"),
    unit: flags.get("unit") ?? DEFAULTS.unit,
    write: flags.has("write"),
    base: flags.get("base") ?? `http://127.0.0.1:${port}`,
    keysFile: flags.get("keys") ?? keysFilePath(env),
  };
  return { cmd, cfg, flags };
}

function errText(err) {
  if (err instanceof Error) return err.name === "TimeoutError" || err.name === "AbortError" ? "timeout" : err.message;
  return String(err);
}

function run(bin, args) {
  return spawnSync(bin, args, { encoding: "utf8" });
}

function ensureNetwork(cfg) {
  const inspect = run("docker", ["network", "inspect", "--format", "{{range .IPAM.Config}}{{.Gateway}}{{end}}", cfg.network]);
  if (inspect.status === 0 && inspect.stdout.trim() !== "") {
    console.log(`docker network ${cfg.network} present (gateway ${inspect.stdout.trim()})`);
    return 0;
  }
  const created = run("docker", ["network", "create", "--subnet", cfg.subnet, cfg.network]);
  if (created.status !== 0) {
    console.error(`could not create docker network ${cfg.network}: ${(created.stderr || "").trim()}`);
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
  for (const args of [["--user", "daemon-reload"], ["--user", "enable", "--now", `${cfg.unit}.service`]]) {
    const r = run("systemctl", args);
    if (r.status !== 0) {
      console.error(`systemctl ${args.join(" ")} failed: ${(r.stderr || "").trim()}`);
      return 1;
    }
  }
  console.log(`systemd unit ${cfg.unit}.service enabled and started`);
  console.log(`run once so it survives logout/reboot:  loginctl enable-linger ${process.env.USER ?? ""}`);
  return 0;
}

function uninstall(cfg) {
  run("systemctl", ["--user", "disable", "--now", `${cfg.unit}.service`]);
  console.log(`${cfg.unit}.service disabled (unit file, docker network and keys left in place)`);
  return 0;
}

async function status(cfg) {
  const unit = run("systemctl", ["--user", "is-active", `${cfg.unit}.service`]);
  console.log(`unit ${cfg.unit}.service: ${(unit.stdout || unit.stderr || "").trim() || "unknown"}`);
  const net = run("docker", ["network", "inspect", "--format", "{{range .IPAM.Config}}{{.Gateway}}{{end}}", cfg.network]);
  console.log(`docker network ${cfg.network}: ${net.status === 0 ? `gateway ${net.stdout.trim()}` : "absent"}`);
  console.log(`endpoint for the container: http://${cfg.gateway}:${cfg.port}`);
  for (const probe of ["/health", "/ready"]) {
    try {
      const res = await fetch(`http://127.0.0.1:${cfg.port}${probe}`, { signal: AbortSignal.timeout(5000) });
      console.log(`  ${probe}: HTTP ${res.status}`);
    } catch (err) {
      console.log(`  ${probe}: ${errText(err)}`);
    }
  }
  const keys = readKeys(cfg.keysFile);
  const have = ["OPENVIKING_API_KEY", "OPENVIKING_COMPANION_KEY", "OPENVIKING_REVIEWER_KEY"].filter((n) => keys[n]);
  console.log(`keys file ${cfg.keysFile}: ${have.length > 0 ? `defines ${have.join(", ")}` : "missing or empty"}`);
  return 0;
}

async function verify(cfg) {
  const raw = readKeys(cfg.keysFile);
  const keys = { companion: raw.OPENVIKING_COMPANION_KEY ?? raw.OPENVIKING_API_KEY, reviewer: raw.OPENVIKING_REVIEWER_KEY };
  if (!keys.companion || !keys.reviewer) {
    console.error(`both keys are required in ${cfg.keysFile} (OPENVIKING_COMPANION_KEY / OPENVIKING_API_KEY and OPENVIKING_REVIEWER_KEY)`);
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
        console.error(`[memory-forward] bound ${bound}/${cfg.binds.length} addresses (${cfg.binds.join(", ")}) — is the docker network up?`);
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
      console.error("usage: companion-memory-forward.mjs [run|install|uninstall|status|ensure-network|verify] [--flags]");
      return 2;
  }
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
      console.error(`[memory-forward] ${errText(err)}`);
      process.exit(1);
    });
}
