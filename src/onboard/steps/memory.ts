// Memory keys — mint, place, prove.
//
// A new operator gets working, CONFINED memory without ever learning what a
// memory key is: this step issues and places all three keys, and the one
// placement mistake that matters (the companion key landing where review
// sessions can read it) is a check, not a paragraph of prose.
//
// THE THREE KEYS AND WHERE EACH ONE MAY LIVE. This is the whole point of the
// step, and it is absolute (root CLAUDE.md rule 8, docs/companion-memory-access.md):
//
//   root      the SERVER's own credential. ONLY <secrets>/openviking_root_key,
//             0600, on the daemon host. Never a client credential, never in the
//             operator key file, never handed to a session or the companion.
//   reviewer  the one USER key the daemon and every review session hold.
//             <secrets>/openviking_reviewer_key AND the operator key file.
//   companion the companion's own USER key. ONLY the operator key file (0600).
//             NEVER on the daemon side: review sessions run in that container,
//             and a companion key they could read would defeat the confinement
//             this whole design exists to enforce.
//
// The compose route mounts the WHOLE secrets dir into the container read-only,
// so the key file must never sit inside it. Its documented home is the
// operator home, outside every mounted dir; `resolveKeysFile` refuses any
// layout that would put it inside a dir the container mounts anyway (the
// secrets dir, the config home, the live config's directory, the checkout —
// `keysFileConfinement`), rather than writing a key into a mounted directory.
//
// IDEMPOTENT BY CONSTRUCTION. An existing key is left exactly alone: minting
// asks the server for the key a user ALREADY has instead of issuing a second
// one, and a local file that already holds a value is never overwritten. A
// rotation would orphan every copy already distributed — the daemon's secrets
// mount, the operator's key file — so nothing here rotates, ever. A local value
// that disagrees with the server is reported red, not "fixed".
//
// TWO PHASES, because the two halves need different things:
//   A. the root key is minted and placed OFFLINE — it must be in the secrets
//      dir BEFORE the daemon container boots, since the entrypoint renders it
//      into ov.conf (no root key ⇒ the server degrades to auth_mode=dev and
//      confinement is not enforced);
//   B. the USER keys can only come from a RUNNING server (it mints them), so
//      that half needs the stack up. Running this step before bring-up lands
//      phase A and says plainly that phase B is waiting; re-run it after
//      bring-up and it completes. The engine's resume re-verification is what
//      makes that a normal flow rather than a special case.
//
// VERIFICATION IS THE EXISTING FOUR-CELL CONFINEMENT MATRIX
// (scripts/companion-memory-forward.mjs `runVerify`) — not a second proof.
// A FAILED row fails the step; an INCONCLUSIVE row also fails it. Inconclusive
// means the probe could not tell (a 404, a 5xx, a 200 carrying an error
// envelope), and "could not tell" has never been a pass for this matrix.
//
// DECLINING IS LEGAL AND LOUD. An operator who says no to memory setup gets the
// documented memory-less mode — rounds still run (context assembly resolves
// empty and never blocks or delays a round), the TUI's Memory tab paints its
// store row red, the EOD curator and the [feedback] sink have nowhere to write.
// The step records the choice, mints and places nothing, and writes exactly ONE
// thing: `[openviking] enabled = false` in config.toml — the daemon's word for
// "off". Without it the daemon cannot tell a declined install from
// a broken one: memory health reads a missing reviewer key as the credential
// failure it would be on an install that wanted memory, and wakes the overseer,
// paints the board and files a ticket for a choice. Configuring memory later
// switches it back on. It never wedges and never crashes.
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { OPENVIKING_DEFAULTS, parseConfig } from "../../config.js";
import { configHome, locateKeysFile, locateSecrets } from "../../install.js";
import { tuiMemoryBaseUrl } from "../../tui/memory.js";
import { CHOICE_KEYS, type MemoryChoice } from "../choices.js";
import { configMountOf } from "./bringup.js";
import { readTextOrNull, rootOf, writeAtomic } from "./compose.js";
import { assertNoDryRunEdit, patchToml, type TomlEdit } from "./configfill.js";
import { readTomlKey } from "./ingress.js";
import { topologyOf } from "./topology.js";
import { stackTransportFor } from "./transport.js";
import type { CheckResult, OnboardingStep, StepContext, StepReport } from "../engine.js";

export const MEMORY_STEP_ID = "memory";
/** Recorded choice: "configure" (default) | "declined". */
export const MEMORY_CHOICE_KEY = CHOICE_KEYS.memory;
/** Recorded so later steps / the TUI launch know where the key file went. */
export const KEYS_FILE_CHOICE_KEY = "openviking_keys_file";

export const REVIEWER_USER = "reviewer";
export const COMPANION_USER = "companion";

/** Secret FILE NAMES — taken from the one config authority so this step cannot
 * drift from the entrypoint, ansible and the secrets wizard. */
export const ROOT_KEY_FILE = OPENVIKING_DEFAULTS.root_key_file;
export const REVIEWER_KEY_FILE = OPENVIKING_DEFAULTS.reviewer_key_file;

/** The operator key file's three variables (docs/companion-memory-access.md).
 * `OPENVIKING_API_KEY` is the companion extension's own identity. */
export const COMPANION_VARS = ["OPENVIKING_API_KEY", "OPENVIKING_COMPANION_KEY"] as const;
export const REVIEWER_VAR = "OPENVIKING_REVIEWER_KEY";

/** Where the daemon container mounts the secrets dir, read-only — the same
 * path on both routes (docker-compose.yml, the playbook's container task). */
export const CONTAINER_SECRETS_DIR = "/opt/quickreview/secrets";

// ---- the two script modules this step drives (never reimplemented) ----------

/** The slice of `scripts/openviking-provision.mjs` used here. The script is
 * untyped, build-free ESM (the container entrypoint runs it before any build),
 * so this interface IS the contract — `tests/onboard-memory.test.ts` checks the
 * real module still satisfies it. */
export interface ProvisionModule {
  mintRootKey(): string;
  mintUserKeys(opts: {
    base: string;
    account: string;
    users: string[];
    rootKey: string;
    fetchFn: typeof fetch;
    log?: (line: string) => void;
  }): Promise<{
    keys: Record<string, string>;
    created: string[];
    kept: string[];
    missing: string[];
    ok: boolean;
    detail: string;
  }>;
}

/** The slice of `scripts/companion-memory-forward.mjs` used here: the ONE
 * four-cell confinement matrix in the repo. */
export interface MatrixModule {
  runVerify(opts: {
    base: string;
    keys: { companion?: string; reviewer?: string };
    env?: NodeJS.ProcessEnv;
    fetchFn: typeof fetch;
    write?: boolean;
    log?: (line: string) => void;
  }): Promise<{ rows: MatrixRow[]; failed: number; unclear: number }>;
}

export interface MatrixRow {
  who: string;
  ns: string;
  want: string;
  why: string;
  observed: string;
  verdict: string;
  detail: string;
}

export interface MemoryStepOptions {
  /** Daemon-side secrets dir (default `$QC_SECRETS_DIR`, else the install locator's answer). */
  secretsDir?: string;
  /** Operator-side key file (default: the install locator's answer; refused
   * when it would sit inside a dir the container mounts). */
  keysFile?: string;
  /** OpenViking endpoint. Default: `$QCR_OV_BASE`, else the endpoint the TUI
   * reaches memory at (`tuiMemoryBaseUrl` — the memory forward's loopback
   * listener, `QCR_MEMORY_PORT` honoured). */
  base?: string;
  account?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  loadProvision?: () => Promise<ProvisionModule>;
  loadMatrix?: () => Promise<MatrixModule>;
}

// ---- path rules -------------------------------------------------------------

/** The install locator's answer: a set `[github] secrets_dir`
 * first — exactly as the daemon's loader and the compose mount read it — then
 * `$QC_SECRETS_DIR`, then `<config home>/secrets`. */
export function resolveSecretsDir(
  env: NodeJS.ProcessEnv,
  home: string,
  configured?: string | null,
): string {
  return resolve(
    locateSecrets({ configured, override: env.QC_SECRETS_DIR, env: { ...env, HOME: home } }).path,
  );
}

/** `[github] secrets_dir` as the live config.toml writes it; null when the
 * file is not there yet (the step then resolves as an unset value would). */
function configuredSecretsDir(configPath: string): string | null {
  try {
    return readTomlKey(readFileSync(configPath, "utf8"), "github", "secrets_dir");
  } catch {
    return null;
  }
}

/** The documented key-file location — the install locator's, the
 * same one `keysFilePath` in the TUI and the forward read. */
export function documentedKeysFile(env: NodeJS.ProcessEnv, home: string): string {
  return resolve(locateKeysFile({ env: { ...env, HOME: home } }).path);
}

/** Is `file` inside `dir`? (A file IN the daemon-side secrets dir is readable by
 * every review session on the compose route — the whole dir is bind-mounted.) */
export function isInside(dir: string, file: string): boolean {
  const d = resolve(dir).replace(new RegExp(`${sep}$`), "");
  const f = resolve(file);
  return f === d || f.startsWith(`${d}${sep}`);
}

export interface KeysFileChoice {
  path: string;
  /** The key file would sit inside a dir the container mounts — refused. */
  unsafe: boolean;
  note: string;
}

/**
 * Where the operator key file goes.
 *
 * The companion key lives in that file, so the file must not be inside the
 * daemon-side secrets dir (`docker-compose.yml` mounts `$QCR_SECRETS_DIR`
 * read-only at `/opt/quickreview/secrets`) nor inside the install's config home
 * (mounted read-only too), or it would be one `cat` away from every review
 * session. Its default home is the operator home, outside both. A
 * layout that puts it inside either anyway — a pinned `QCR_OPENVIKING_KEYS`,
 * or a secrets dir that contains the operator home — is refused rather than
 * quietly moved: there is no other documented place to move it to.
 */
export function resolveKeysFile(
  secretsDir: string,
  env: NodeJS.ProcessEnv,
  home: string,
  mounted: readonly string[] = [],
): KeysFileChoice {
  const pinned = (env.QCR_OPENVIKING_KEYS ?? "").trim() !== "";
  const candidate = documentedKeysFile(env, home);
  return keysFileConfinement(candidate, secretsDir, env, home, mounted, pinned);
}

/**
 * Is a key file at `path` confined — outside EVERY directory the daemon
 * container mounts? Those are the secrets dir, the install's config home,
 * and whatever the caller adds: bring-up mounts the directory of
 * the live config.toml (wherever `QCR_CONFIG` points, `configMountOf`) and the
 * whole checkout (read-write, at /opt/quickreview/sandbox). A key file inside
 * any of them is one `cat` away from every review session.
 */
export function keysFileConfinement(
  path: string,
  secretsDir: string,
  env: NodeJS.ProcessEnv,
  home: string,
  mounted: readonly string[] = [],
  pinned = true,
): KeysFileChoice {
  const fix = pinned
    ? "Point it at a path outside that directory and run this step again."
    : "Point the secrets dir elsewhere, or set QCR_OPENVIKING_KEYS to a path outside it, and run this step again.";
  const what = pinned ? "QCR_OPENVIKING_KEYS points" : `the key file's home ${path} sits`;
  if (isInside(secretsDir, path)) {
    return {
      path,
      unsafe: true,
      note:
        `${what} inside the daemon-side secrets dir (${secretsDir}), which the container mounts read-only — ` +
        `a review session could read the companion key there. ${fix}`,
    };
  }
  const cfgHome = configHome({ ...env, HOME: home });
  const places: Array<[string, string]> = [
    [cfgHome, `the install's config home (${cfgHome}), which the container mounts read-only`],
    ...mounted.map((dir): [string, string] => [dir, `${dir}, which the daemon container mounts`]),
  ];
  for (const [dir, label] of places) {
    if (isInside(dir, path)) {
      return {
        path,
        unsafe: true,
        note: `${what} inside ${label} — a review session could read the companion key there. ${fix}`,
      };
    }
  }
  return { path, unsafe: false, note: "" };
}

// ---- small file helpers (0600 everywhere) -----------------------------------

function writePrivate(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = join(dirname(path), `.${path.split(sep).at(-1)}.tmp`);
  writeFileSync(tmp, content, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

/** A secret file's value, or "" (an unreadable secret is a degraded mode). */
export function readSecretFile(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

/** Why a file that EXISTS could not be read (its errno code), or null when it
 * is absent or readable. The readers above fold both into "empty" — right for
 * reporting, wrong before a write: an unreadable key is not a missing one, and
 * replacing it would rotate a key (or drop variables) we could not even see. */
export function unreadableReason(path: string): string | null {
  try {
    readFileSync(path);
    return null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? null : (code ?? String(err));
  }
}

function unreadableCheck(name: string, path: string, why: string): CheckResult {
  return {
    name,
    ok: false,
    detail:
      `${path} exists but cannot be read (${why}) — left untouched: writing over it would rotate or drop keys that are ` +
      "already in use. Fix its ownership/permissions and run this step again.",
  };
}

/** `KEY=value` lines → map. Mirrors `readKeys` in the forward script. */
export function parseKeysFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m || m[1] === undefined || m[2] === undefined) continue;
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

export function readKeysFile(path: string): Record<string, string> {
  try {
    return parseKeysFile(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

/** Render the key file, preserving any variables already in it that we do not
 * own. Values already present are never replaced — that is the no-rotation rule
 * at the file level. */
export function renderKeysFile(
  existing: Record<string, string>,
  next: Record<string, string>,
): string {
  const merged: Record<string, string> = { ...existing };
  for (const [k, v] of Object.entries(next)) {
    if (v && !merged[k]) merged[k] = v;
  }
  const head = [
    "# OpenViking USER keys — the operator's copy (written by qcr onboard).",
    "# BOTH user keys, and never a root or admin key: an admin key lists every",
    "# user key in plaintext. The companion key must never reach the daemon-side",
    "# secrets dir — review sessions run in that container.",
    "# 0600. Read by the TUI, the companion container (--env-file) and",
    "# scripts/companion-memory-forward.mjs.",
  ];
  const body = Object.entries(merged).map(([k, v]) => `${k}=${v}`);
  return `${[...head, ...body].join("\n")}\n`;
}

/** Every file under `dir`, at any depth (the whole tree is bind-mounted),
 * whose contents contain `value`. The companion-key negative assertion runs
 * through this. A symlinked directory is not descended: its target is not
 * part of the mount. */
export function filesContaining(dir: string, value: string): string[] {
  if (!value || !existsSync(dir)) return [];
  const hits: string[] = [];
  const walk = (at: string): void => {
    let names: string[];
    try {
      names = readdirSync(at);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(at, name);
      try {
        if (lstatSync(path).isDirectory()) {
          walk(path);
          continue;
        }
        if (!statSync(path).isFile()) continue;
        if (readFileSync(path, "utf8").includes(value)) hits.push(path);
      } catch {
        /* unreadable file — cannot leak what we cannot read here either */
      }
    }
  };
  walk(dir);
  return hits;
}

function modeOk(path: string): boolean {
  try {
    return (statSync(path).mode & 0o077) === 0;
  } catch {
    return false;
  }
}

// ---- choices ----------------------------------------------------------------

export type { MemoryChoice };

/** The two answers — the tool schema's enum, the guards and the refusal text
 * all read this one list. */
const MEMORY_CHOICE_IDS = ["configure", "declined"] as const satisfies readonly MemoryChoice[];

function isMemoryChoice(value: unknown): value is MemoryChoice {
  return (MEMORY_CHOICE_IDS as readonly unknown[]).includes(value);
}

/**
 * Read a typed answer as a choice, or `null` when it is neither a yes nor a
 * no. An empty answer is the [Y/n] prompt's default, "configure"; anything
 * unrecognised is null, so the step refuses with the options rather than
 * guessing — a guessed "configure" mints keys and turns memory on, and a
 * guessed "declined" turns memory off. Each word must be whole: "need more
 * information" is not a no.
 */
export function normalizeMemoryChoice(answer: string | undefined): MemoryChoice | null {
  const text = (answer ?? "").trim();
  if (text === "") return "configure";
  if (/^(n|no|nope|skip|declin(e|ed|ing)?|later|without)\b/i.test(text)) return "declined";
  if (/^(y|yes|yep|yeah|sure|ok|okay|configure|set ?up)\b/i.test(text)) return "configure";
  return null;
}

/** The refusal for an answer that is not a recognised choice. */
export function memoryChoiceOfferCheck(answer: string): CheckResult {
  return {
    name: "choice",
    ok: false,
    detail:
      `"${answer.trim()}" is not a recognised answer — pick one of ${MEMORY_CHOICE_IDS.join(" | ")} and call this ` +
      'step again with it (choice: "<id>"): "configure" sets memory up, "declined" runs the reviewer memory-less.',
  };
}

export const DECLINED_CHECKS: readonly CheckResult[] = [
  {
    name: "memory",
    ok: true,
    detail:
      "memory setup DECLINED — running memory-less, which is a legal mode: rounds still run (context assembly resolves " +
      "empty and never blocks or delays a round), the TUI's Memory tab paints its MEMORY STORE row red, and the EOD " +
      "curator and the [feedback] sink have nowhere to write. No key was minted or placed. Re-run this step with " +
      'choice "configure" to set memory up later.',
  },
];

/** The check row that reports the daemon's on/off switch. */
export const MEMORY_SWITCH_CHECK = "memory-switch";

/** The config.toml the memory switch lives in: the path the interview
 * recorded writing, else the adapters'. */
function configPathOf(ctx: StepContext): string {
  const recorded = ctx.choices[CHOICE_KEYS.configPath];
  return typeof recorded === "string" && recorded ? recorded : ctx.adapters.paths.configPath;
}

/**
 * Tell the DAEMON the operator's answer: `[openviking] enabled =
 * false` on a decline — its word for "off", under which memory health reports
 * "not monitored" and raises nothing — and back to `true` when memory is
 * configured over an earlier decline. Configuring never ADDS the key: an
 * install that never said "off" stays exactly as it is. The patched text is
 * parsed by the daemon's own loader before it is written, like every other
 * wizard config write. Returns the row to report, or null when there is
 * nothing to say (configuring an install that is already on).
 */
function switchMemory(ctx: StepContext, on: boolean): CheckResult | null {
  const path = configPathOf(ctx);
  const text = readTextOrNull(path);
  if (text === null) {
    return on
      ? null
      : {
          name: MEMORY_SWITCH_CHECK,
          ok: false,
          detail:
            `${path} does not exist yet, so the daemon cannot be told memory is OFF — without that it reads the missing ` +
            "reviewer key as a credential failure and wakes the overseer about it. Run the config_fill step, then this step again",
        };
  }
  const current = readTomlKey(text, "openviking", "enabled");
  if (on && current !== "false") return null;
  if (!on && current === "false") {
    return {
      name: MEMORY_SWITCH_CHECK,
      ok: true,
      detail: `[openviking] enabled = false already in ${path} — the daemon reports memory "not monitored" and raises no memory alert`,
    };
  }
  const edits: TomlEdit[] = [
    { section: "openviking", key: "enabled", value: on ? "true" : "false" },
  ];
  assertNoDryRunEdit(edits);
  const patched = patchToml(text, edits);
  try {
    parseConfig(patched);
  } catch (err) {
    return {
      name: MEMORY_SWITCH_CHECK,
      ok: false,
      detail: `[openviking] enabled = ${on ? "true" : "false"} would not load in ${path}: ${String(err)} — nothing was written`,
    };
  }
  writeAtomic(path, patched);
  return {
    name: MEMORY_SWITCH_CHECK,
    ok: true,
    detail: on
      ? `[openviking] enabled = true written to ${path} (it said false from an earlier decline) — memory is monitored again`
      : `[openviking] enabled = false written to ${path} — the daemon's word for "off": memory health reports "not monitored" ` +
        "and raises no memory alert. Ship it with the next deploy sync on the server route",
  };
}

/** Verify's half of the switch for a configured install: the daemon must not
 * have been told memory is OFF since. */
function switchStillOn(ctx: StepContext): CheckResult | null {
  const path = configPathOf(ctx);
  const text = readTextOrNull(path);
  if (text === null || readTomlKey(text, "openviking", "enabled") !== "false") return null;
  return {
    name: MEMORY_SWITCH_CHECK,
    ok: false,
    detail:
      `memory is configured, but ${path} says [openviking] enabled = false — the daemon runs memory-less whatever the ` +
      'keys prove. Run this step again with choice "configure" to switch it back on',
  };
}

/** Verify's half of the switch: a declined install must still SAY off. */
function switchStillOff(ctx: StepContext): CheckResult {
  const path = configPathOf(ctx);
  const text = readTextOrNull(path);
  const current = text === null ? null : readTomlKey(text, "openviking", "enabled");
  return current === "false"
    ? { name: MEMORY_SWITCH_CHECK, ok: true, detail: `[openviking] enabled = false in ${path}` }
    : {
        name: MEMORY_SWITCH_CHECK,
        ok: false,
        detail:
          text === null
            ? `${path} is not readable — the daemon cannot be told memory is OFF; run this step again`
            : `memory was declined but ${path} does not say [openviking] enabled = false — the daemon will read the missing ` +
              "reviewer key as a credential failure and wake the overseer; run this step again",
      };
}

// ---- the step ---------------------------------------------------------------

function defaultLoaders(root: string): {
  provision: () => Promise<ProvisionModule>;
  matrix: () => Promise<MatrixModule>;
} {
  // Dynamic, by file URL, for the same reason src/tui/memforward.ts does it:
  // both scripts are dependency-free ESM outside tsconfig's include, and a
  // static import would either drag them into the build or fork their logic.
  return {
    provision: () =>
      import(
        pathToFileURL(join(root, "scripts", "openviking-provision.mjs")).href
      ) as Promise<ProvisionModule>,
    matrix: () =>
      import(
        pathToFileURL(join(root, "scripts", "companion-memory-forward.mjs")).href
      ) as Promise<MatrixModule>,
  };
}

async function serverReady(
  fetchFn: typeof fetch,
  base: string,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetchFn(`${base}/ready`, { signal: AbortSignal.timeout(10_000) });
    return { ok: res.status >= 200 && res.status < 300, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

interface Resolved {
  secretsDir: string;
  keys: KeysFileChoice;
  base: string;
  account: string;
  env: NodeJS.ProcessEnv;
  home: string;
  mounted: string[];
}

function resolvePaths(opts: MemoryStepOptions, ctx: StepContext): Resolved {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const secretsDir = opts.secretsDir
    ? resolve(opts.secretsDir)
    : resolveSecretsDir(env, home, configuredSecretsDir(ctx.adapters.paths.configPath));
  const mounted = daemonMounts(ctx);
  const keys = opts.keysFile
    ? keysFileConfinement(resolve(opts.keysFile), secretsDir, env, home, mounted)
    : resolveKeysFile(secretsDir, env, home, mounted);
  // The endpoint is the memory forward's loopback listener on both routes —
  // the engine is never published on a host port (docker-compose.yml, the
  // playbook) — so this step reaches memory exactly where the TUI does.
  const base = opts.base ?? ((env.QCR_OV_BASE ?? "").trim() || tuiMemoryBaseUrl(env));
  const account = opts.account ?? ((env.QCR_OV_ADMIN_ACCOUNT ?? "").trim() || "default");
  return { secretsDir, keys, base, account, env, home, mounted };
}

/** The host dirs bring-up mounts into the daemon container besides the
 * secrets dir and the config home: the live config's directory
 * (`configMountOf`) and the checkout. */
function daemonMounts(ctx: StepContext): string[] {
  return [configMountOf(ctx.adapters.paths.configPath).dir, rootOf(ctx.adapters)];
}

/** Why nothing answered at `base`, and the one thing that makes it answer: the
 * memory forward, in the mode this topology needs. The engine listens on the
 * daemon container's own loopback on both routes and is never published. */
function serverUnreachableDetail(ctx: StepContext, base: string, why: string): string {
  const forward =
    topologyOf(ctx.choices) === "vm"
      ? "`node scripts/companion-memory-forward.mjs run` (it reaches the server's container over ssh)"
      : '`node scripts/companion-memory-forward.mjs run --local --container "$(docker compose ps -q daemon)"` ' +
        "(add --no-sudo when docker runs without sudo here)";
  return (
    `no OpenViking answering at ${base} (${why}). The root key is in place, which is what the daemon needs at boot. ` +
    "The memory engine listens only on the daemon container's own loopback, so this machine reaches it through the memory " +
    `forward: bring the stack up if it is not, then start the forward in another terminal — ${forward}, or ` +
    "`node scripts/companion-memory-forward.mjs install` for the systemd unit, or open `qcr tui`, which starts one — and run " +
    "this step again: the two user keys are minted and placed. Nothing is lost by waiting."
  );
}

/**
 * The server route's daemon reads ITS copy of the reviewer key: the one a
 * deploy shipped into the VM's secrets dir, and only `rebuild` ships secrets
 * (`deploy.sh sync` starts past those tasks). The operator copy proven here
 * says nothing about it, so ask the container for the hash of its copy — a
 * hash, never the key — and compare. null on the compose route, where the
 * container mounts this machine's secrets dir itself.
 */
async function daemonReviewerCopyCheck(
  ctx: StepContext,
  localPath: string,
): Promise<CheckResult | null> {
  if (topologyOf(ctx.choices) !== "vm") return null;
  const name = "reviewer-key-on-server";
  const remotePath = `${CONTAINER_SECRETS_DIR}/${REVIEWER_KEY_FILE}`;
  const ship =
    'run the vm_deploy step with mode "rebuild" (`bash scripts/deploy.sh rebuild`) — only a rebuild copies the ' +
    "secrets dir to the server; a sync never does — then run this step again";
  let local: string;
  try {
    local = createHash("sha256").update(readFileSync(localPath)).digest("hex");
  } catch (err) {
    return { name, ok: false, detail: `cannot read ${localPath} to compare: ${String(err)}` };
  }
  const r = await stackTransportFor(ctx).exec(["sha256sum", remotePath]);
  const remote = /^([0-9a-f]{64})\b/.exec(r.stdout.trim())?.[1];
  if (r.code === 0 && remote !== undefined) {
    return remote === local
      ? {
          name,
          ok: true,
          detail: `the daemon on the server holds the same reviewer key as ${localPath}`,
        }
      : {
          name,
          ok: false,
          detail: `the daemon on the server holds a DIFFERENT reviewer key than ${localPath} — it authenticates with a key the matrix never proved. Fix: ${ship}`,
        };
  }
  const said = (r.stderr || r.stdout).trim().slice(0, 200) || `exit ${r.code}`;
  return /no such file/i.test(said)
    ? {
        name,
        ok: false,
        detail: `the daemon on the server has no reviewer key yet (${remotePath}), so it runs memory-less. Fix: ${ship}`,
      }
    : {
        name,
        ok: false,
        detail: `could not ask the server's daemon container for its reviewer key (${said}) — not proven either way; check the deploy step, then run this step again`,
      };
}

/** Placement: root + reviewer daemon-side, both USER keys operator-side, the
 * companion key operator-side ONLY. Returns one check per rule; writes nothing
 * a rule forbids. */
export function placeKeys(args: {
  secretsDir: string;
  keysFile: string;
  rootKey: string;
  reviewerKey: string;
  companionKey: string;
}): CheckResult[] {
  const checks: CheckResult[] = [];
  const { secretsDir, keysFile, rootKey, reviewerKey, companionKey } = args;
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });

  // --- daemon side: root + reviewer, and NOTHING else ---
  for (const [name, file, value] of [
    ["root", ROOT_KEY_FILE, rootKey],
    ["reviewer", REVIEWER_KEY_FILE, reviewerKey],
  ] as const) {
    if (!value) continue;
    const path = join(secretsDir, file);
    const existing = readSecretFile(path);
    const unreadable = existing === "" ? unreadableReason(path) : null;
    if (unreadable !== null) {
      checks.push(unreadableCheck(`${name}-key-placed`, path, unreadable));
    } else if (existing === "") {
      writePrivate(path, `${value}\n`);
      checks.push({
        name: `${name}-key-placed`,
        ok: true,
        detail: `${file} written 0600 in ${secretsDir}`,
      });
    } else if (existing === value) {
      if (!modeOk(path)) chmodSync(path, 0o600);
      checks.push({
        name: `${name}-key-placed`,
        ok: true,
        detail: `${file} already holds this key — left untouched (keys are never rotated)`,
      });
    } else {
      checks.push({
        name: `${name}-key-placed`,
        ok: false,
        detail:
          `${path} holds a DIFFERENT ${name} key than the server has. Nothing was rotated: a rotation orphans every copy ` +
          "already distributed. Restore the correct value, or remove that file and run this step again to adopt the server's key.",
      });
    }
  }

  // --- operator side: both USER keys, 0600, outside the secrets dir ---
  if (isInside(secretsDir, keysFile)) {
    checks.push({
      name: "companion-key-confinement",
      ok: false,
      detail:
        `refusing to write the key file at ${keysFile}: it is inside the daemon-side secrets dir (${secretsDir}), which the ` +
        "container mounts read-only — a review session could read the companion key. Point QCR_OPENVIKING_KEYS outside it.",
    });
    return checks;
  }
  const keysUnreadable = unreadableReason(keysFile);
  if (keysUnreadable !== null) {
    checks.push(unreadableCheck("key-file", keysFile, keysUnreadable));
    return checks;
  }
  const existingKeys = readKeysFile(keysFile);
  const next: Record<string, string> = {};
  for (const v of COMPANION_VARS) next[v] = companionKey;
  next[REVIEWER_VAR] = reviewerKey;
  const conflicts = Object.entries(next).filter(
    ([k, v]) => v && existingKeys[k] && existingKeys[k] !== v,
  );
  writePrivate(keysFile, renderKeysFile(existingKeys, next));
  const after = readKeysFile(keysFile);
  const haveBoth = Boolean(after[COMPANION_VARS[0]] && after[REVIEWER_VAR]);
  checks.push({
    name: "key-file",
    ok: haveBoth && conflicts.length === 0,
    detail:
      conflicts.length > 0
        ? `${keysFile} already defines ${conflicts.map(([k]) => k).join(", ")} with a different value — left as it was (never rotated). ` +
          "Remove the stale line and run this step again to adopt the server's key."
        : haveBoth
          ? `${keysFile} holds both USER keys, 0600 (no root or admin key ever goes here)`
          : `${keysFile} is missing ${[...COMPANION_VARS, REVIEWER_VAR].filter((v) => !after[v]).join(", ")}`,
  });

  // --- the negative assertion: the companion key is NOWHERE on the daemon side ---
  const leaked = companionKey ? filesContaining(secretsDir, companionKey) : [];
  checks.push({
    name: "companion-key-confinement",
    ok: leaked.length === 0,
    detail:
      leaked.length === 0
        ? `the companion key is not in any file under ${secretsDir} — review sessions run in that container and must never read it`
        : `THE COMPANION KEY IS IN ${leaked.join(", ")} — remove those files: review sessions can read the secrets mount`,
  });
  return checks;
}

export function memoryStep(opts: MemoryStepOptions = {}): OnboardingStep {
  // A choice, or the answer that was not one (the step refuses with the options).
  const askChoice = async (ctx: StepContext): Promise<MemoryChoice | { unrecognised: string }> => {
    const read = (answer: string) => normalizeMemoryChoice(answer) ?? { unrecognised: answer };
    // The operator's answer through the tool call wins: it is how the pi
    // wizard, which has no prompter, says yes or no, and how an earlier
    // decline is reversed.
    const given = ctx.input.choice;
    if (isMemoryChoice(given)) return given;
    if (typeof given === "string" && given.trim() !== "") return read(given);
    const recorded = ctx.choices[MEMORY_CHOICE_KEY];
    if (isMemoryChoice(recorded)) return recorded;
    const prompter = ctx.adapters.prompter;
    if (!prompter) return "configure";
    let answer: string;
    try {
      answer = await prompter(
        "Set up memory now? The reviewer remembers what it learned across PRs. Saying no is fine — it runs memory-less. [Y/n]",
      );
    } catch {
      return "configure";
    }
    return read(answer);
  };

  const loaders = (ctx: StepContext) => {
    const fallback = defaultLoaders(rootOf(ctx.adapters));
    return {
      provision: opts.loadProvision ?? fallback.provision,
      matrix: opts.loadMatrix ?? fallback.matrix,
    };
  };

  return {
    id: MEMORY_STEP_ID,
    title: "Memory: mint, place and confine the OpenViking keys",
    explain:
      "Memory is what lets the reviewer remember what it learned about your repo. Three keys make it work, and where each " +
      "one lives is a security boundary: the server's own root key stays on the daemon host, the reviewer key goes to the " +
      "daemon and every review session, and the companion key goes only to your own machine — review sessions must never " +
      "be able to read it. This step mints whatever does not exist yet (never re-issuing a key you already have), puts each " +
      "one where it belongs, and then proves the confinement with the four-cell matrix. The root key is placed first because " +
      "the daemon needs it at boot; the two user keys can only be minted by a running server, so if the stack is not up yet " +
      "this step lands the root key, says so, and finishes when you re-run it after bring-up. Declining memory entirely is a " +
      "supported answer — the reviewer then runs memory-less.",
    order: 60,
    parameters: {
      type: "object",
      properties: {
        choice: {
          type: "string",
          enum: [...MEMORY_CHOICE_IDS],
          description:
            'The operator\'s answer: "configure" to set memory up, "declined" to run memory-less. Omit to keep the ' +
            "recorded answer (configure when none is recorded).",
        },
      },
    },

    async run(ctx): Promise<StepReport> {
      const choice = await askChoice(ctx);
      if (typeof choice !== "string") return { ok: false, checks: [memoryChoiceOfferCheck(choice.unrecognised)] };
      ctx.recordChoice(CHOICE_KEYS.memory, choice);
      const switched = switchMemory(ctx, choice === "configure");
      if (choice === "declined") {
        const declined = [...DECLINED_CHECKS, ...(switched ? [switched] : [])];
        return { ok: declined.every((c) => c.ok), checks: declined, data: { declined: true } };
      }

      const { secretsDir, keys, base, account } = resolvePaths(opts, ctx);
      // A failed switch-on stays in `checks` and turns the step red at the end;
      // the keys are still worth placing.
      const checks: CheckResult[] = switched ? [switched] : [];
      if (keys.unsafe) {
        checks.push({ name: "key-file-location", ok: false, detail: keys.note });
        return { ok: false, checks };
      }
      ctx.recordChoice(KEYS_FILE_CHOICE_KEY, keys.path);

      // --- phase A: the root key (offline; needed before the daemon boots) ---
      const rootPath = join(secretsDir, ROOT_KEY_FILE);
      let rootKey = readSecretFile(rootPath);
      const { provision, matrix } = loaders(ctx);
      let prov: ProvisionModule;
      try {
        prov = await provision();
      } catch (err) {
        checks.push({
          name: "provisioning-machinery",
          ok: false,
          detail: `could not load scripts/openviking-provision.mjs: ${String(err)}`,
        });
        return { ok: false, checks };
      }
      const rootUnreadable = rootKey === "" ? unreadableReason(rootPath) : null;
      if (rootUnreadable !== null) {
        checks.push(unreadableCheck("root-key", rootPath, rootUnreadable));
        return { ok: false, checks };
      }
      if (rootKey === "") {
        rootKey = prov.mintRootKey();
        mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
        writePrivate(rootPath, `${rootKey}\n`);
        checks.push({
          name: "root-key",
          ok: true,
          detail: `minted the server root key and wrote ${rootPath} (0600). It is the SERVER's credential: never a client's, never in the key file.`,
        });
      } else {
        checks.push({
          name: "root-key",
          ok: true,
          detail: `${rootPath} already holds a root key — left untouched (nothing is ever rotated)`,
        });
      }

      // --- phase B: the two USER keys (the server mints them) ---
      const ready = await serverReady(ctx.adapters.fetch, base);
      if (!ready.ok) {
        checks.push({
          name: "memory-server",
          ok: false,
          detail: serverUnreachableDetail(ctx, base, ready.detail),
        });
        return { ok: false, checks, data: { root_key_placed: true, keys_file: keys.path } };
      }

      const minted = await prov.mintUserKeys({
        base,
        account,
        users: [REVIEWER_USER, COMPANION_USER],
        rootKey,
        fetchFn: ctx.adapters.fetch,
        log: (line) => ctx.adapters.log?.(line),
      });
      const reviewerKey = minted.keys[REVIEWER_USER] ?? "";
      const companionKey = minted.keys[COMPANION_USER] ?? "";
      checks.push({
        name: "user-keys",
        ok: minted.ok && reviewerKey !== "" && companionKey !== "",
        detail:
          minted.ok && reviewerKey && companionKey
            ? `${minted.created.length > 0 ? `minted ${minted.created.join(", ")}` : "no user needed creating"}` +
              `${minted.kept.length > 0 ? `; kept the existing key for ${minted.kept.join(", ")} (never rotated)` : ""}`
            : `could not obtain a key for ${minted.missing.join(", ") || "every user"}${minted.detail ? ` (${minted.detail})` : ""} — ` +
              "nothing was rotated. Check that the daemon restarted after the root key landed (the server reads it at boot, and " +
              "without it runs auth_mode=dev), then run this step again.",
      });
      if (!reviewerKey || !companionKey)
        return { ok: false, checks, data: { root_key_placed: true, keys_file: keys.path } };

      checks.push(
        ...placeKeys({ secretsDir, keysFile: keys.path, rootKey, reviewerKey, companionKey }),
      );
      if (!checks.every((c) => c.ok))
        return { ok: false, checks, data: { root_key_placed: true, keys_file: keys.path } };

      // --- the proof ---
      checks.push(
        ...(await matrixChecks(
          matrix,
          base,
          { companion: companionKey, reviewer: reviewerKey },
          ctx,
          opts,
        )),
      );
      // --- the daemon's own copy, where it is not this machine's file ---
      const onServer = await daemonReviewerCopyCheck(ctx, join(secretsDir, REVIEWER_KEY_FILE));
      if (onServer) checks.push(onServer);
      return {
        ok: checks.every((c) => c.ok),
        checks,
        data: {
          root_key_placed: true,
          keys_file: keys.path,
          users: [REVIEWER_USER, COMPANION_USER],
        },
      };
    },

    async verify(ctx): Promise<StepReport> {
      // The recorded choice is authoritative: a run's data is merged into the
      // step record, so an earlier decline's `declined` flag outlives a later
      // configure. The flag counts only when no choice is recorded.
      const recorded = ctx.choices[MEMORY_CHOICE_KEY];
      if (recorded === "declined" || (recorded === undefined && ctx.data.declined === true)) {
        const declined = [...DECLINED_CHECKS, switchStillOff(ctx)];
        return { ok: declined.every((c) => c.ok), checks: declined };
      }
      const { secretsDir, keys, base, env, home, mounted } = resolvePaths(opts, ctx);
      // The file the TUI, the companion and the forward read NOW is the one
      // that must hold the keys: a file this step wrote earlier, somewhere the
      // locator no longer points, serves nobody. That earlier copy is still
      // checked for confinement below — it holds the companion key.
      const keysPath = keys.path;
      const placedPath =
        typeof ctx.data.keys_file === "string" && resolve(ctx.data.keys_file) !== resolve(keysPath)
          ? ctx.data.keys_file
          : null;
      // Confinement against the CURRENT mounts: the layout may have moved
      // since this step placed the file (a new config location, a new pin).
      const placed =
        placedPath !== null && existsSync(placedPath)
          ? keysFileConfinement(placedPath, secretsDir, env, home, mounted)
          : null;
      const checks: CheckResult[] = [];
      const switched = switchStillOn(ctx);
      if (switched) checks.push(switched);

      const rootPath = join(secretsDir, ROOT_KEY_FILE);
      const reviewerPath = join(secretsDir, REVIEWER_KEY_FILE);
      for (const [name, path] of [
        ["root-key", rootPath],
        ["reviewer-key", reviewerPath],
      ] as const) {
        const value = readSecretFile(path);
        checks.push({
          name,
          ok: value !== "" && modeOk(path),
          detail:
            value === ""
              ? `${path} is missing or empty — run this step to mint and place it`
              : modeOk(path)
                ? `${path} present, 0600`
                : `${path} is readable by others — chmod 600 it`,
        });
      }

      const fileKeys = readKeysFile(keysPath);
      // Both companion spellings are written with the same key, and each has a
      // reader (the companion extension takes OPENVIKING_API_KEY, the TUI the
      // specific one first): proving one while the other disagrees proves a
      // key one of them never sends.
      const companionValues = [...new Set(COMPANION_VARS.map((v) => fileKeys[v] ?? ""))];
      const companionSplit = companionValues.length > 1;
      const companionKey = companionSplit ? "" : (companionValues[0] ?? "");
      const reviewerKey = fileKeys[REVIEWER_VAR] ?? "";
      checks.push({
        name: "key-file",
        ok: companionKey !== "" && reviewerKey !== "" && modeOk(keysPath),
        detail: companionSplit
          ? `${keysPath} defines ${COMPANION_VARS.join(" and ")} with different values (or only one of them) — both must hold ` +
            "the companion key. Remove the stale line and run this step again to adopt the server's key"
          : companionKey === "" || reviewerKey === ""
            ? `${keysPath} must define ${COMPANION_VARS.join("/")} and ${REVIEWER_VAR} — run this step to write them`
            : modeOk(keysPath)
              ? `${keysPath} holds both USER keys, 0600`
              : `${keysPath} is readable by others — chmod 600 it`,
      });

      // The matrix proves the operator copy of the reviewer key; the daemon
      // reads its own copy from the secrets dir. Only when the two agree does
      // that proof cover the key the daemon and its sessions actually hold.
      const daemonReviewerKey = readSecretFile(reviewerPath);
      if (daemonReviewerKey !== "" && reviewerKey !== "") {
        const same = daemonReviewerKey === reviewerKey;
        checks.push({
          name: "reviewer-key-match",
          ok: same,
          detail: same
            ? `${reviewerPath} holds the same reviewer key as ${keysPath}`
            : `${reviewerPath} holds a DIFFERENT reviewer key than ${REVIEWER_VAR} in ${keysPath} — the daemon would ` +
              "authenticate with a key the matrix never proved. Nothing is rotated: restore the correct value, or remove " +
              "the stale copy and run this step again to adopt the server's key.",
        });
      }

      const leaked = [
        ...companionValues.flatMap((v) => (v ? filesContaining(secretsDir, v) : [])),
        ...[keysPath, ...(placedPath !== null ? [placedPath] : [])].filter((p) =>
          isInside(secretsDir, p),
        ),
      ];
      // The file the locator names now, then an earlier placement still on
      // disk (their secrets-dir cases are already in `leaked`).
      const misplaced =
        keys.unsafe && !isInside(secretsDir, keysPath)
          ? keys
          : placed?.unsafe && placedPath !== null && !isInside(secretsDir, placedPath)
            ? placed
            : undefined;
      checks.push({
        name: "companion-key-confinement",
        ok: leaked.length === 0 && misplaced === undefined,
        detail:
          leaked.length > 0
            ? `the companion key is reachable from the daemon-side secrets dir (${leaked.join(", ")}) — remove it and re-run this step`
            : misplaced !== undefined
              ? `the key file ${misplaced.path} is no longer confined: ${misplaced.note}`
              : `no companion key under ${secretsDir}, and the key file sits outside every directory the daemon container mounts`,
      });

      if (!companionKey || !reviewerKey) {
        checks.push({
          name: "confinement-matrix",
          ok: false,
          detail: "not run: both USER keys are needed to probe the four cells",
        });
        return { ok: false, checks };
      }
      const { matrix } = loaders(ctx);
      checks.push(
        ...(await matrixChecks(
          matrix,
          base,
          { companion: companionKey, reviewer: reviewerKey },
          ctx,
          opts,
        )),
      );
      const onServer = await daemonReviewerCopyCheck(ctx, reviewerPath);
      if (onServer) checks.push(onServer);
      return { ok: checks.every((c) => c.ok), checks };
    },
  };
}

/**
 * The four-cell confinement matrix as onboarding checks.
 *
 * One check per row plus a summary. A FAILED row is a boundary violation; an
 * INCONCLUSIVE row is NOT a pass — it means the probe could not tell (a 404, a
 * 5xx, a 200 carrying an error envelope), and the guidance says exactly that.
 */
async function matrixChecks(
  load: () => Promise<MatrixModule>,
  base: string,
  keys: { companion: string; reviewer: string },
  ctx: StepContext,
  opts: MemoryStepOptions,
): Promise<CheckResult[]> {
  let mod: MatrixModule;
  try {
    mod = await load();
  } catch (err) {
    return [
      {
        name: "confinement-matrix",
        ok: false,
        detail: `could not load scripts/companion-memory-forward.mjs: ${String(err)}`,
      },
    ];
  }
  let report: { rows: MatrixRow[]; failed: number; unclear: number };
  try {
    report = await mod.runVerify({
      base,
      keys,
      env: opts.env ?? process.env,
      fetchFn: ctx.adapters.fetch,
      write: false,
      log: () => {},
    });
  } catch (err) {
    return [
      {
        name: "confinement-matrix",
        ok: false,
        detail: `the confinement matrix could not run: ${String(err)}`,
      },
    ];
  }
  const checks: CheckResult[] = report.rows.map((row) => ({
    name: `matrix:${row.who}-key→${row.ns}`,
    ok: row.verdict === "PASS",
    detail:
      row.verdict === "PASS"
        ? `${row.want} — ${row.why}`
        : row.verdict === "INCONCLUSIVE"
          ? `INCONCLUSIVE (${row.detail}): the probe could not tell reach from refusal, which is NEVER a pass. ` +
            "Usually the request shape does not match this server — see docs/companion-memory-access.md " +
            "(QCR_OV_READ_PATH / QCR_OV_READ_URI / QCR_OV_WRITE_PATH) — or the memory forward is not up."
          : `FAILED: expected ${row.want}, got ${row.observed} (${row.detail}). ${row.why}`,
  }));
  checks.push({
    name: "confinement-matrix",
    ok: report.failed === 0 && report.unclear === 0 && report.rows.length > 0,
    detail:
      report.rows.length === 0
        ? "the matrix produced no rows — it did not run"
        : `${report.rows.length - report.failed - report.unclear} pass, ${report.failed} fail, ${report.unclear} inconclusive` +
          (report.failed === 0 && report.unclear === 0
            ? " (run `node scripts/companion-memory-forward.mjs verify --write` for the write half)"
            : " — an inconclusive cell is not a pass"),
  });
  return checks;
}
