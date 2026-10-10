// Connection triage — the TUI does the ssh diagnosis so the operator does not
// have to.
//
// Three failure classes are routinely confused: a key that is simply not in
// the agent looks, on the board, like a dead daemon with no PRs. Each class
// gets its own CAUSE sentence and its own EXACT remedy command, and the TUI
// never runs the remedy itself — there is deliberately no self-healing: the
// TUI reports, the operator acts, and `s` re-runs the check.
//
// Everything here is probe-in / diagnosis-out. `classifyConnection` is PURE and
// carries all the judgment; `triageConnection` only collects the probes. Every
// probe is local-ish, bounded and non-interactive (BatchMode), so a triage can
// never hang the TUI and never prompts for a passphrase behind the alt screen.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { TuiConfig } from "../config.js";
import { masterCheckArgv } from "./connect.js";
import { transportOf } from "./remote.js";

export type ConnectionClass =
  /** The VM answers — master alive, or a fresh connection succeeded. */
  | "ok"
  /** `[tui] target = "local"`: there is no ssh anywhere. */
  | "local"
  /** The agent cannot offer the key ssh wants for this host. */
  | "no-agent-key"
  /** A ControlMaster socket is there and does not answer. */
  | "wedged-master"
  /** The host itself did not answer: DNS, routing, timeout, closed by peer. */
  | "host-unreachable"
  /** ssh failed in a way none of the above explains — say so, show the text. */
  | "unknown";

export interface ConnectionDiagnosis {
  kind: ConnectionClass;
  /** One sentence, in the operator's terms: what is wrong. */
  cause: string;
  /** The exact command to paste into their own shell ("" = nothing to run). */
  remedy: string;
  /** Raw evidence (ssh stderr, agent output) — never a guess. */
  detail?: string;
}

export interface AgentProbe {
  /** An agent answered at all (SSH_AUTH_SOCK set and the socket live). */
  reachable: boolean;
  /** One line per identity, exactly as `ssh-add -l` printed them. */
  identities: string[];
}

/** Everything `classifyConnection` is allowed to know. Collected by probes. */
export interface ConnectionProbes {
  host: string;
  /** `ssh -O check` succeeded — a live shared master. */
  masterAlive: boolean;
  /** Expanded ControlPath, when ssh told us one. */
  controlPath?: string;
  /** That path exists on disk (a socket is there, live or not). */
  controlSocketExists: boolean;
  /** Identity files ssh would offer for this host (`ssh -G`), expanded. */
  identityFiles: string[];
  /** The key we name in the remedy — the first identity that exists on disk. */
  identity?: string;
  /** Fingerprint of `<identity>.pub`, when readable. */
  identityFingerprint?: string;
  agent: AgentProbe;
  /** A non-interactive `ssh … true`, when the master was not already alive. */
  connect?: { ok: boolean; stderr: string; timedOut: boolean };
}

/**
 * The methods OpenSSH says it offered: `Permission denied (publickey,password)`
 * → `["publickey", "password"]`. This is the only reliable way to tell "a key
 * would have worked" from "a key is irrelevant here", and BatchMode collapses
 * both into the same "Permission denied" sentence.
 */
export function offeredAuthMethods(stderr: string): string[] {
  const m = /permission denied \(([^)]*)\)/i.exec(stderr);
  return m
    ? m[1]!
        .split(",")
        .map((x) => x.trim().toLowerCase())
        .filter((x) => x.length > 0)
    : [];
}

/** Refusals that a key in the agent would have fixed, outside a method list. */
const AUTH_PATTERNS = [
  /publickey/i,
  /too many authentication failures/i,
  /agent refused operation/i,
  /sign_and_send_pubkey/i,
];

/**
 * Refusals a key CANNOT fix: an interactive second factor, an account
 * restriction. Answering one of these with `ssh-add` is a confidently wrong
 * remedy, which is the failure mode triage exists to prevent — so this is
 * checked FIRST, and it reports rather than guessing.
 */
const INTERACTIVE_AUTH_PATTERNS = [
  /keyboard-interactive/i,
  /two-factor|2fa|verification code|one-time password/i,
  /account is locked|account is disabled/i,
];

const MUX_PATTERNS = [/control socket connect/i, /mux_client/i, /multiplexing/i, /controlpath/i];

/** The host's key is unknown or has changed. Nothing about the AGENT can fix
 * it, and the fallback below would otherwise report "no usable key is loaded"
 * — a confidently wrong remedy for a host-identity problem. */
const HOST_KEY_PATTERNS = [
  /host key verification failed/i,
  /no matching host key/i,
  /remote host identification has changed/i,
  /host key for .* has changed/i,
];

const NETWORK_PATTERNS = [
  /could not resolve hostname/i,
  /name or service not known/i,
  /connection timed out/i,
  /operation timed out/i,
  /no route to host/i,
  /network is unreachable/i,
  /connection refused/i,
  /connection closed by/i,
  /kex_exchange_identification/i,
  /broken pipe/i,
];

/**
 * The first line of ssh's stderr that actually SAYS something.
 *
 * Not simply the first non-empty one: OpenSSH frames its loudest messages in
 * banner rules, so a changed host key leads with
 * `@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@` and the operator's "cause" would
 * have been a row of at-signs. A line with no letters or digits in it is
 * decoration, not evidence.
 */
function firstLine(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && /[a-z0-9]/i.test(l));
  return line ?? "";
}

/** Does the agent hold the key ssh would offer for this host? */
export function agentHoldsIdentity(p: ConnectionProbes): "yes" | "no" | "unknown" {
  if (!p.agent.reachable || p.agent.identities.length === 0) return "no";
  if (p.identityFingerprint)
    return p.agent.identities.some((l) => l.includes(p.identityFingerprint!)) ? "yes" : "no";
  // No fingerprint to match on (no readable `.pub`): ssh-add prints the key's
  // path as the comment for most keys, so a name match is still evidence.
  // Anything else is UNKNOWN, never "yes" — reading an agent holding somebody
  // else's key as holding this one turns a diagnosis into a guess and hands
  // the operator a remedy that cannot work.
  if (p.identity) {
    const base = p.identity.split("/").pop() ?? p.identity;
    if (p.agent.identities.some((l) => l.includes(base))) return "yes";
  }
  return "unknown";
}

/** The `ssh-add` line for this host's key, or the generic one when ssh named
 * no identity file at all. An unreachable agent needs starting first. */
export function sshAddRemedy(p: ConnectionProbes): string {
  const key = p.identity ?? p.identityFiles[0] ?? "~/.ssh/id_ed25519";
  const add = `ssh-add ${key}`;
  return p.agent.reachable ? add : `eval "$(ssh-agent -s)" && ${add}`;
}

/**
 * The whole judgment, in one pure function.
 *
 * Order matters and is deliberate: an explicit auth refusal outranks a stale
 * socket (ssh falls back to a direct connection when the mux socket is dead,
 * so a socket on disk is not by itself the fault), a mux complaint outranks a
 * generic network error, and an agent holding NOTHING is read as the key case
 * even when ssh was vague — that combination is a key missing from the agent.
 */
export function classifyConnection(p: ConnectionProbes): ConnectionDiagnosis {
  if (p.masterAlive) {
    return { kind: "ok", cause: `the shared ssh master to ${p.host} is up`, remedy: "" };
  }
  if (p.connect?.ok) {
    return {
      kind: "ok",
      cause: `ssh to ${p.host} works (a fresh connection succeeded)`,
      remedy: "",
    };
  }
  const stderr = p.connect?.stderr ?? "";
  const evidence = firstLine(stderr);
  const holdsKey = agentHoldsIdentity(p);

  // A method list is authoritative when ssh printed one: publickey among the
  // offered methods means a loaded key really is the missing piece; its absence
  // means nothing in the agent could ever have helped.
  const methods = offeredAuthMethods(stderr);
  const keyIsRelevant =
    methods.length > 0
      ? methods.includes("publickey")
      : AUTH_PATTERNS.some((re) => re.test(stderr));
  const interactiveOnly =
    methods.length > 0
      ? !methods.includes("publickey")
      : INTERACTIVE_AUTH_PATTERNS.some((re) => re.test(stderr));

  if (interactiveOnly) {
    // Says exactly what it knows and no more: an `ssh-add` here would be a
    // confidently wrong remedy.
    return {
      kind: "unknown",
      cause: `${p.host} refused the non-interactive probe with something a key cannot fix — ${evidence || "an interactive authentication step"}`,
      remedy: `ssh -v ${p.host} true`,
      ...(evidence ? { detail: evidence } : {}),
    };
  }
  if (keyIsRelevant) {
    return {
      kind: "no-agent-key",
      cause: agentCause(p, holdsKey, `ssh to ${p.host} was refused for lack of a usable key`),
      remedy: sshAddRemedy(p),
      ...(evidence ? { detail: evidence } : {}),
    };
  }
  if (
    MUX_PATTERNS.some((re) => re.test(stderr)) ||
    (p.controlSocketExists && p.connect?.timedOut === true)
  ) {
    return {
      kind: "wedged-master",
      cause: `the shared ssh ControlMaster for ${p.host} is wedged — ${p.controlPath ? `${p.controlPath} is there` : "the control socket is there"} and does not answer`,
      remedy: `ssh -O exit ${p.host}`,
      ...(evidence ? { detail: evidence } : {}),
    };
  }
  if (HOST_KEY_PATTERNS.some((re) => re.test(stderr))) {
    return {
      kind: "unknown",
      cause: `${p.host}'s host key is not the one in known_hosts (or is not there at all) — ${evidence || "host key verification failed"}`,
      remedy: `ssh -o StrictHostKeyChecking=ask ${p.host} true`,
      ...(evidence ? { detail: evidence } : {}),
    };
  }
  if (NETWORK_PATTERNS.some((re) => re.test(stderr))) {
    return {
      kind: "host-unreachable",
      cause: `${p.host} did not answer — ${evidence || "the connection failed"}`,
      remedy: `ssh -v ${p.host} true`,
      ...(evidence ? { detail: evidence } : {}),
    };
  }
  if (holdsKey === "no") {
    return {
      kind: "no-agent-key",
      cause: agentCause(p, holdsKey, `ssh to ${p.host} failed and no usable key is loaded`),
      remedy: sshAddRemedy(p),
      ...(evidence ? { detail: evidence } : {}),
    };
  }
  return {
    kind: "unknown",
    cause: `ssh to ${p.host} failed — ${evidence || "no error text"}`,
    remedy: `ssh -v ${p.host} true`,
    ...(evidence ? { detail: evidence } : {}),
  };
}

function agentCause(p: ConnectionProbes, holdsKey: "yes" | "no" | "unknown", lead: string): string {
  const key = p.identity ?? p.identityFiles[0];
  const n = p.agent.identities.length;
  if (!p.agent.reachable)
    return `${lead}: no ssh agent is reachable (SSH_AUTH_SOCK is unset or the agent is not running)`;
  if (n === 0)
    return `${lead}: the agent holds no identities${key ? ` — ${key} is not loaded` : ""}`;
  if (holdsKey === "no")
    return `${lead}: the agent holds ${n} identit${n === 1 ? "y" : "ies"}${key ? `, and ${key} is not one of them` : ""}`;
  // UNKNOWN: no readable `.pub` to fingerprint against, so we cannot tell one
  // of those keys from another. Say that, rather than asserting either way.
  if (holdsKey === "unknown") {
    return `${lead}: the agent holds ${n} identit${n === 1 ? "y" : "ies"}, and without a readable ${key ?? "key"}.pub the TUI cannot tell whether ${key ?? "the right key"} is among them`;
  }
  return `${lead}: the agent holds ${key ?? "a key"} but ${p.host} would not take it`;
}

// ---- probes -----------------------------------------------------------------

export interface ProbeResult {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Runs one bounded, non-interactive command. Injectable — tests never spawn. */
export type ProbeRunner = (cmd: string, argv: string[], timeoutMs: number) => Promise<ProbeResult>;

export const realProbeRunner: ProbeRunner = (cmd, argv, timeoutMs) =>
  new Promise((resolve) => {
    // stdin is closed immediately and BatchMode rides the argv: nothing here
    // may ever stop on a prompt — this runs behind the alt screen.
    const child = execFile(
      cmd,
      argv,
      { timeout: timeoutMs, encoding: "utf8" },
      (err, stdout, stderr) => {
        const e = err as
          (Error & { code?: number | string; killed?: boolean; signal?: string }) | null;
        const timedOut = Boolean(e?.killed) || e?.signal === "SIGTERM";
        resolve({
          status: e ? (typeof e.code === "number" ? e.code : null) : 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? "") || (timedOut ? `timed out after ${timeoutMs}ms` : ""),
          timedOut,
        });
      },
    );
    child.stdin?.end();
  });

/**
 * Expand `~` and the ssh tokens we can resolve.
 *
 * Modern OpenSSH already expands ControlPath in `ssh -G` output, so on most
 * configs this is a pass-through; the token handling earns its keep on older
 * ssh and on a config read some other way. `%C` (a hash of the connection
 * parameters) is NOT reproducible here, and returning "" for it would demote a
 * wedged master to `unknown` (`controlSocketExists` would go false). So it
 * falls back to the socket's DIRECTORY: if that exists we still
 * know multiplexing is configured, `mux` stderr still classifies, and the
 * remedy (`ssh -O exit <host>`, which needs no path) is unchanged.
 */
export function expandControlPath(
  raw: string,
  tokens: { host?: string; user?: string; port?: string },
  home: string,
): string {
  if (raw === "" || raw.toLowerCase() === "none") return "";
  let out = raw.startsWith("~/") ? `${home}/${raw.slice(2)}` : raw;
  out = out
    .replace(/%h/g, tokens.host ?? "%h")
    .replace(/%n/g, tokens.host ?? "%n")
    .replace(/%r/g, tokens.user ?? "%r")
    .replace(/%p/g, tokens.port ?? "%p");
  return out;
}

/** True when SOMETHING is multiplexing at that path. An unexpandable token
 * (`%C`) leaves a path we cannot stat, so fall back to its directory rather
 * than reporting "no control socket", which is a different claim. */
export function controlSocketPresent(path: string, exists: (p: string) => boolean): boolean {
  if (path === "") return false;
  if (!/%[a-zA-Z]/.test(path)) return exists(path);
  const dir = path.slice(0, path.lastIndexOf("/"));
  return dir !== "" && exists(dir);
}

/** `ssh -G <host>` output → the fields the triage uses. */
export function parseSshConfigDump(text: string): {
  identityFiles: string[];
  controlPath: string;
  host?: string;
  user?: string;
  port?: string;
} {
  const identityFiles: string[] = [];
  let controlPath = "";
  let host: string | undefined;
  let user: string | undefined;
  let port: string | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const sp = line.indexOf(" ");
    if (sp <= 0) continue;
    const key = line.slice(0, sp).toLowerCase();
    const value = line.slice(sp + 1).trim();
    if (key === "identityfile") identityFiles.push(value);
    else if (key === "controlpath") controlPath = value;
    else if (key === "hostname") host = value;
    else if (key === "user") user = value;
    else if (key === "port") port = value;
  }
  return {
    identityFiles,
    controlPath,
    ...(host ? { host } : {}),
    ...(user ? { user } : {}),
    ...(port ? { port } : {}),
  };
}

/** `ssh-add -l` → the agent probe. Exit 1 = no identities, 2 = no agent. */
export function parseAgentList(res: ProbeResult): AgentProbe {
  if (
    res.status === 2 ||
    /error connecting to agent|could not open a connection/i.test(res.stderr)
  ) {
    return { reachable: false, identities: [] };
  }
  const identities = res.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/the agent has no identities/i.test(l));
  return { reachable: true, identities };
}

export interface TriageDeps {
  run?: ProbeRunner;
  exists?: (path: string) => boolean;
  home?: string;
  expand?: (p: string) => string;
}

const CONFIG_TIMEOUT_MS = 5_000;
const CONNECT_TIMEOUT_MS = 12_000;

/**
 * The ONE probe that touches the network. Non-interactive (`BatchMode`) so it
 * can never stop on a prompt behind the alt screen, and — this is the part
 * that matters — it must neither CHANGE anything nor weaken anything.
 *
 * `StrictHostKeyChecking=yes` is doing both jobs. It is read-only: `yes` never
 * writes `known_hosts`, where `accept-new` PERSISTS a new host key as a side
 * effect of asking a diagnostic question, and `no` both accepts an unverified
 * key and may append it — harmless only while paired with
 * `UserKnownHostsFile=/dev/null`, a pairing one edit away from silently
 * writing again. And it keeps VERIFYING
 * against the operator's real file, so the probe cannot quietly succeed
 * against a host whose key changed. A key that is unknown or does not match
 * fails with "Host key verification failed", which the classifier reads and
 * reports with its own remedy — the honest outcome, and never a lie about
 * reachability.
 */
export function batchProbeArgv(host: string): string[] {
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=8",
    "-o",
    "StrictHostKeyChecking=yes",
    host,
    "true",
  ];
}

/**
 * Collect the probes and classify. One probe per class:
 * `ssh -G` (what key and socket ssh would use — no network), `ssh -O check`
 * (is the master alive), `ssh-add -l` (what the agent holds), and, only when
 * the master is down, ONE bounded BatchMode connection.
 */
export async function triageConnection(
  cfg: TuiConfig,
  deps: TriageDeps = {},
): Promise<ConnectionDiagnosis> {
  if (transportOf(cfg) === "local") {
    return {
      kind: "local",
      cause: "local transport — the daemon runs on this machine, no ssh involved",
      remedy: "",
    };
  }
  const run = deps.run ?? realProbeRunner;
  const exists = deps.exists ?? existsSync;
  const home = deps.home ?? homedir();
  const host = cfg.ssh_host;

  const dump = parseSshConfigDump((await run("ssh", ["-G", host], CONFIG_TIMEOUT_MS)).stdout);
  const identityFiles = dump.identityFiles.map((p) =>
    p.startsWith("~/") ? `${home}/${p.slice(2)}` : p,
  );
  const identity = identityFiles.find((p) => exists(p)) ?? identityFiles[0];
  const controlPath = expandControlPath(dump.controlPath, dump, home);

  // `connect.ts` already owns this argv — one spelling of "is the master
  // alive", shared with the `s` path, so the two can never drift.
  const master = await run("ssh", masterCheckArgv(cfg), CONFIG_TIMEOUT_MS);
  const masterAlive = master.status === 0;

  const agent = parseAgentList(await run("ssh-add", ["-l"], CONFIG_TIMEOUT_MS));
  let identityFingerprint: string | undefined;
  if (identity && exists(`${identity}.pub`)) {
    const fp = await run("ssh-keygen", ["-lf", `${identity}.pub`], CONFIG_TIMEOUT_MS);
    identityFingerprint = fp.stdout.split(/\s+/).find((t) => t.includes(":"));
  }

  const probes: ConnectionProbes = {
    host,
    masterAlive,
    ...(controlPath ? { controlPath } : {}),
    controlSocketExists: controlSocketPresent(controlPath, exists),
    identityFiles,
    ...(identity ? { identity } : {}),
    ...(identityFingerprint ? { identityFingerprint } : {}),
    agent,
  };
  if (!masterAlive) {
    const res = await run("ssh", batchProbeArgv(host), CONNECT_TIMEOUT_MS);
    probes.connect = { ok: res.status === 0, stderr: res.stderr, timedOut: res.timedOut };
  }
  return classifyConnection(probes);
}

/** The one-line summary the board's top bar and the notice line share. */
export function diagnosisLine(d: ConnectionDiagnosis): string {
  return d.remedy === "" ? d.cause : `${d.cause} · fix: ${d.remedy}`;
}
