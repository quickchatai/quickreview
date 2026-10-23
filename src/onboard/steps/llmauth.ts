import { deliverConfigChange, configDeliveryChecks } from "./configdelivery.js";
import type { TransportOptions } from "./transport.js";
// LLM auth — the wizard's credential choice.
// Both routes are first-class and the trade is stated honestly:
//
//   OAuth (a ChatGPT subscription) — the shipped default. pi's tokens live in
//     `auth.json` under the pi home of the process that logged in, and they do
//     NOT transfer between the host and the containers. So the OAuth route
//     costs up to THREE separate browser logins: this wizard's own pi session
//     (on the image route, `qcr login` into the `qcr-login` volume), the daemon
//     container, and the companion container. Each container login must land
//     on that container's named pi-home volume (the daemon's is `qcr-pihome`,
//     mounted at /home/qcr/.pi in the released image) or a recreate silently
//     costs it — this step verifies exactly that, per surface, at the moment
//     the surface exists.
//   API key — one paste covers the daemon and its review sessions at once (the
//     daemon container's entrypoint exports the secrets-dir file as
//     OPENAI_API_KEY for every pi process in it), and every model string must
//     move from the OAuth provider prefix to the API one. The key file reaches
//     no other process: the companion container is never handed it, so the
//     companion keeps its own login (its model is on the OAuth provider by
//     default), and this host's own pi reads OPENAI_API_KEY only from its own
//     environment.
//     The wizard does that rewrite itself: five values, comment-preserving,
//     idempotent, and reversible, so switching routes later re-runs cleanly in
//     either direction.
//
// Neither route needs anything for memory embeddings: the memory
// engine embeds LOCALLY by default, and `openai_api_key` is pi's credential
// alone — the hosted-embeddings opt-in is the embeddings step (38) with its
// OWN key file. This step says so once, as a note, so an operator on the OAuth
// route is not left wondering what the key file would have covered.
//
// House rule, structural here: NO credential value ever reaches an argv. The
// key is written straight to the secrets file (0600, dir 0700) by this module,
// or collected by `deploy/collect-secrets.sh` — never passed to a process, and
// never echoed into a check detail, the checklist, or a tool result. In the
// pi-driven flow the wizard has no prompter at all, so the LLM never even sees
// the key: the step points at the shell wizard and then verifies the file.
//
// Deterministic by construction: config and secrets are plain files under
// paths derived from the injected state dir, every docker probe goes through
// the ProcessRunner seam, and verify() neither prompts nor writes.
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { COMPANION_DEFAULTS, TUI_DEFAULTS } from "../../config.js";
import { locateSecrets } from "../../install.js";
import { CHOICE_KEYS, AUTH_ROUTES, authRouteOf, type AuthRoute } from "../choices.js";
import type {
  CheckResult,
  OnboardAdapters,
  OnboardingStep,
  ProcessRunner,
  StepContext,
  StepReport,
} from "../engine.js";
import { DAEMON_SERVICE, composeArgs, rootOf, writeAtomic } from "./compose.js";
import { readTomlKey, tomlScalarText } from "./ingress.js";
import { sshArgv } from "./ssh.js";
import { topologyOf } from "./topology.js";
import { remoteFactsFor } from "./transport.js";

export const LLM_AUTH_STEP_ID = "llm_auth";
/** The choice key later steps read the route from. */
export const AUTH_ROUTE_CHOICE_KEY = CHOICE_KEYS.authRoute;
/** The choice key carrying the provider prefix the config now uses. */
export const MODEL_PREFIX_CHOICE_KEY = "llm_model_prefix";

export type { AuthRoute };

/** pi's ChatGPT-OAuth provider prefix (config.example.toml's shipped default). */
export const OAUTH_PREFIX = "openai-codex/";
/** pi's direct-API provider prefix — needs OPENAI_API_KEY. */
export const API_PREFIX = "openai/";

export function prefixFor(route: AuthRoute): string {
  return route === "oauth" ? OAUTH_PREFIX : API_PREFIX;
}

/** The secrets-dir file name — the same one `deploy/collect-secrets.sh` writes
 * and the container entrypoints export as OPENAI_API_KEY. */
export const OPENAI_KEY_FILE = "openai_api_key";

/**
 * The FIVE model strings the route decides. Every one of them lives in
 * `config.toml [models]` / `[models.tiers]` (docs/llm-setup.md route 2), and
 * the provider prefix IS the route — nothing else in the file changes.
 */
export const MODEL_LOCATIONS: ReadonlyArray<{ section: string; key: string }> = [
  { section: "models", key: "default" },
  { section: "models", key: "conversation" },
  { section: "models.tiers", key: "terra-med" },
  { section: "models.tiers", key: "sol-med" },
  { section: "models.tiers", key: "sol-high" },
];

/** "models.default", "models.tiers.sol-high", … — the stable labels the checks
 * and the checklist record use. */
export function modelLabels(): string[] {
  return MODEL_LOCATIONS.map((l) => `${l.section}.${l.key}`);
}

// ---- paths ------------------------------------------------------------------

export function configExamplePathFor(stateDir: string): string {
  return join(dirname(stateDir), "config.example.toml");
}

export function expandHomePath(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

/** The host pi's OAuth token store — this wizard's own login (pi keeps it at
 * `$HOME/.pi/agent/auth.json`). */
export function hostAuthJsonPath(home: string): string {
  return join(home, ".pi", "agent", "auth.json");
}

/** pi's provider key for the ChatGPT-OAuth route — the `openai-codex/` prefix
 * without its slash, and the entry pi writes into auth.json on /login. */
const OAUTH_PROVIDER = OAUTH_PREFIX.replace(/\/$/, "");

/** Does this host's auth.json hold a ChatGPT (openai-codex) OAuth login? The
 * file existing proves nothing: pi keeps every provider's login there, and a
 * logged-out pi can leave `{}` behind. Unreadable or malformed ⇒ false. */
export function hostHasOAuthLogin(authPath: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
    const cred = parsed?.[OAUTH_PROVIDER] as Record<string, unknown> | undefined;
    return typeof cred === "object" && cred !== null && cred.type === "oauth";
  } catch {
    return false;
  }
}

function hostHome(): string {
  return process.env.HOME ?? homedir();
}

// ---- tolerant TOML reads ----------------------------------------------------

const SECTION_RE = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/;
// key = "value" or key = 'value' — the key may be bare or quoted (TOML allows
// both for the dashed tier names); the value is a basic or a literal string,
// single- or triple-quoted, as the loader reads any of them. Trailing text (a comment) is preserved verbatim.
const STRING_KV_RE = /^(\s*)("?)([A-Za-z0-9_.-]+)\2(\s*=\s*)("""|'''|"|')(.*?)\5(.*)$/;

/** The string value an STRING_KV_RE match carries, whichever quote it used. */
function kvValue(kv: RegExpExecArray): string {
  return kv[6]!;
}

function isComment(line: string): boolean {
  return /^\s*#/.test(line);
}

/** Read one string value out of raw config text. Tolerant on purpose: the
 * wizard reads a half-filled config (FILL values everywhere) that the strict
 * loader would refuse. Returns null when absent. */
export function readTomlString(text: string, section: string, key: string): string | null {
  let current = "";
  for (const line of text.split("\n")) {
    const sec = SECTION_RE.exec(line);
    if (sec) {
      current = sec[1]!.trim();
      continue;
    }
    if (isComment(line) || current !== section) continue;
    const kv = STRING_KV_RE.exec(line);
    if (kv && kv[3] === key) {
      // A basic string's escapes decode as readTomlKey decodes them.
      if (kv[5] === '"')
        return tomlScalarText(
          line.slice(kv[1]!.length + kv[2]!.length + kv[3]!.length + kv[2]!.length + kv[4]!.length),
        );
      return kvValue(kv);
    }
  }
  return null;
}

/** Where the secrets live: `[github] secrets_dir` wins (it is what the daemon
 * and the compose mount actually use), then $QC_SECRETS_DIR, then the install
 * locator's answer — `<config home>/secrets`: the same answer the
 * daemon's loader reaches. The value is read the way every other onboarding
 * step reads it (`readTomlKey`: basic or literal string), so a single-quoted
 * secrets_dir names the same directory here as in memory and bring-up. */
export function resolveSecretsDir(
  configText: string,
  home: string,
  envDir?: string,
  root?: string,
): string {
  const located = locateSecrets({
    configured: readTomlKey(configText, "github", "secrets_dir"),
    override: envDir,
    env: { ...process.env, HOME: home },
  }).path;
  // A relative answer is rooted at the sandbox, as every other step roots it —
  // never at the wizard's cwd.
  return root !== undefined && !isAbsolute(located) ? join(root, located) : located;
}

// ---- the model-string rewrite ----------------------------------------------

export interface ModelAudit {
  /** "models.default" … */
  label: string;
  value: string;
  /** "oauth" | "api" | "custom" (some other provider — not ours to touch) |
   * "missing" (the key is not in the file). */
  kind: AuthRoute | "custom" | "missing";
}

/** Which managed route a model string is on, and the model after the prefix;
 * null for any other provider (not ours to touch). The one classification the
 * audit and the rewrite share. */
export function managedModel(value: string): { route: AuthRoute; rest: string } | null {
  for (const route of AUTH_ROUTES) {
    const prefix = prefixFor(route);
    if (value.startsWith(prefix)) return { route, rest: value.slice(prefix.length) };
  }
  return null;
}

/** What the five locations currently say. Read-only; the basis of verify(). */
export function auditModelStrings(text: string): ModelAudit[] {
  return MODEL_LOCATIONS.map(({ section, key }) => {
    const label = `${section}.${key}`;
    const value = readTomlString(text, section, key);
    if (value === null) return { label, value: "", kind: "missing" as const };
    return { label, value, kind: managedModel(value)?.route ?? ("custom" as const) };
  });
}

export interface RewriteResult {
  text: string;
  /** Labels whose prefix changed in this pass. */
  rewritten: string[];
  /** Labels already on the target prefix (idempotent re-run ⇒ all five). */
  unchanged: string[];
  /** Labels on some other provider — left exactly as they are. */
  custom: string[];
  /** Labels not present in the file at all. */
  missing: string[];
}

/**
 * Move every one of the five model strings onto `route`'s provider prefix.
 *
 * Line-oriented on purpose: comments, ordering, spacing and every other key in
 * the file survive byte-for-byte (a TOML round-trip would eat them). Only the
 * prefix of the five values changes, so the operation is idempotent (running it
 * twice is a no-op) and reversible (oauth → api → oauth restores the original
 * bytes). Values on any other provider are left alone — a deliberate custom
 * model is not the wizard's business.
 */
export function rewriteModelPrefixes(text: string, route: AuthRoute): RewriteResult {
  const target = prefixFor(route);
  const wanted = new Map(MODEL_LOCATIONS.map((l) => [`${l.section}.${l.key}`, l]));
  const seen = new Set<string>();
  const rewritten: string[] = [];
  const unchanged: string[] = [];
  const custom: string[] = [];

  const lines = text.split("\n");
  let current = "";
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const sec = SECTION_RE.exec(line);
    if (sec) {
      current = sec[1]!.trim();
      continue;
    }
    if (isComment(line)) continue;
    const kv = STRING_KV_RE.exec(line);
    if (!kv) continue;
    const label = `${current}.${kv[3]!}`;
    if (!wanted.has(label) || seen.has(label)) continue;
    seen.add(label);
    const value = kvValue(kv);
    const managed = managedModel(value);
    if (managed === null) {
      custom.push(label);
      continue;
    }
    const next = `${target}${managed.rest}`;
    if (next === value) {
      unchanged.push(label);
      continue;
    }
    const quote = kv[5]!;
    lines[i] = `${kv[1]!}${kv[2]!}${kv[3]!}${kv[2]!}${kv[4]!}${quote}${next}${quote}${kv[7]!}`;
    rewritten.push(label);
  }

  const missing = modelLabels().filter((l) => !seen.has(l));
  return { text: lines.join("\n"), rewritten, unchanged, custom, missing };
}

// ---- the API key ------------------------------------------------------------

/**
 * The same shape `deploy/collect-secrets.sh`'s `v_openai` asserts (`^sk-`),
 * plus "one unbroken string" — the shell's hidden single-line read cannot
 * produce whitespace anyway. Pinned against the shell by
 * tests/onboard-llmauth.test.ts so the two validators cannot drift.
 */
export function validateOpenAiKey(value: string): boolean {
  const v = value.trim();
  return v.startsWith("sk-") && v.length > 3 && !/\s/.test(v);
}

export interface KeyFileState {
  present: boolean;
  valid: boolean;
  path: string;
}

export function readKeyFileState(secretsDir: string): KeyFileState {
  const path = join(secretsDir, OPENAI_KEY_FILE);
  if (!existsSync(path)) return { present: false, valid: false, path };
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { present: true, valid: false, path };
  }
  return { present: raw.trim().length > 0, valid: validateOpenAiKey(raw), path };
}

/** Write the key exactly the way the shell wizard does: dir 0700, file 0600,
 * no trailing newline, and the value never leaves this function. */
export function writeKeyFile(secretsDir: string, value: string): string {
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  chmodSync(secretsDir, 0o700);
  const path = join(secretsDir, OPENAI_KEY_FILE);
  writeFileSync(path, value.trim(), { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

// ---- container login verification -------------------------------------------

export type LoginState =
  "absent" | "no-pi-volume" | "stopped" | "no-auth" | "wrong-provider" | "ok" | "undetectable";

/**
 * The in-container login check: the same question `hostHasOAuthLogin` asks of
 * the host — is there an `openai-codex` entry of type `oauth`? — asked by the
 * container's own node, so only an exit code ever leaves it (never a token,
 * which on the VM route would otherwise cross ssh). Exit 0 = logged in,
 * 3 = no auth.json / empty, 4 = an auth.json without that login (`{}`, or
 * another provider picked at pi's /login menu). Anything else (no node) is
 * undetectable, never a pass.
 */
export const CONTAINER_LOGIN_SCRIPT =
  "const fs=require('fs');let t='';try{t=fs.readFileSync(process.argv[1],'utf8')}catch{process.exit(3)}" +
  "if(!t.trim())process.exit(3);let a;try{a=JSON.parse(t)}catch{process.exit(4)}" +
  `const c=a&&a[${JSON.stringify(OAUTH_PROVIDER)}];process.exit(c&&typeof c==='object'&&c.type==='oauth'?0:4)`;

export interface LoginProbe {
  state: LoginState;
  /** The pi-home mount destination inside the container, when there is one. */
  destination?: string;
  /** Mount type + name, for the durability claim. */
  mount?: string;
}

/**
 * Did a pi OAuth login actually land on this container's PERSISTENT pi home?
 *
 * The question is deliberately asked about the MOUNT, not about `$HOME`: a
 * container whose HOME has drifted off the mounted volume has pi write a
 * perfectly good auth.json into the writable layer, and every recreate
 * silently costs the login. Testing `<mount destination>/agent/
 * auth.json` proves the token is on the volume, which is the only claim worth
 * making. Never throws, never prompts: an undetectable docker is a note.
 */
export async function probeContainerLogin(
  runner: ProcessRunner,
  container: string,
): Promise<LoginProbe> {
  const mounts = await runner.run("docker", ["inspect", "--format", "{{json .Mounts}}", container]);
  if (mounts.code !== 0) {
    const err = `${mounts.stderr}${mounts.stdout}`;
    // "No such object" is a container that does not exist yet (the normal case
    // before bring-up); anything else means we could not look.
    return { state: /no such object|no such container/i.test(err) ? "absent" : "undetectable" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(mounts.stdout.trim() || "[]");
  } catch {
    return { state: "undetectable" };
  }
  const list = Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [];
  const piMount = list.find(
    (m) => typeof m.Destination === "string" && /\/\.pi$/.test(m.Destination),
  );
  if (!piMount) return { state: "no-pi-volume" };
  const destination = String(piMount.Destination);
  const mount =
    `${String(piMount.Type ?? "mount")} ${String(piMount.Name ?? piMount.Source ?? "")}`.trim();

  const running = await runner.run("docker", [
    "inspect",
    "--format",
    "{{.State.Running}}",
    container,
  ]);
  if (running.code !== 0 || running.stdout.trim() !== "true")
    return { state: "stopped", destination, mount };

  const auth = await runner.run("docker", [
    "exec",
    container,
    "node",
    "-e",
    CONTAINER_LOGIN_SCRIPT,
    `${destination}/agent/auth.json`,
  ]);
  const state: LoginState =
    auth.code === 0
      ? "ok"
      : auth.code === 3
        ? "no-auth"
        : auth.code === 4
          ? "wrong-provider"
          : "undetectable";
  return { state, destination, mount };
}

/** How an operator reaches a container's pi login: a tmux attach ends with a
 * detach; a command that runs pi itself (the daemon's login entrypoint) ends
 * when pi exits. */
interface LoginRoute {
  command: string;
  tmux: boolean;
}

function loginSteps(route: LoginRoute): string {
  return route.tmux
    ? `${route.command} → /login → detach (Ctrl-b d)`
    : `${route.command} → finish the browser login in pi, then exit pi`;
}

function loginCheck(
  name: string,
  label: string,
  route: LoginRoute,
  probe: LoginProbe,
): CheckResult {
  const steps = loginSteps(route);
  switch (probe.state) {
    case "ok":
      return {
        name,
        ok: true,
        detail: `${label}: logged in — auth.json is on the persistent pi home (${probe.mount}) at ${probe.destination}, so a container recreate keeps it`,
      };
    case "no-auth":
      return {
        name,
        ok: false,
        detail:
          `${label}: no auth.json on the pi home (${probe.mount}). Attach and log in: ` +
          `${steps}. ` +
          "Host tokens do not transfer — this container needs its own login.",
      };
    case "wrong-provider":
      return {
        name,
        ok: false,
        detail:
          `${label}: auth.json on the pi home (${probe.mount}) holds no ChatGPT (${OAUTH_PROVIDER}) OAuth login — ` +
          "a /login to another provider does not count. Attach and log in with the ChatGPT option: " +
          `${steps}.`,
      };
    case "no-pi-volume":
      return {
        name,
        ok: false,
        detail:
          `${label}: the container has no volume mounted on its pi home, so any /login would live in the writable layer ` +
          "and vanish on the next recreate. Recreate it with its pihome volume before logging in.",
      };
    case "stopped":
      return {
        name,
        ok: true,
        detail: `${label}: container exists but is not running — its login is verified when it starts`,
      };
    case "undetectable":
      return {
        name,
        ok: true,
        detail: `${label}: could not inspect docker from here — this login is verified where the container runs`,
      };
    case "absent":
    default:
      return {
        name,
        ok: true,
        detail: `${label}: no container yet — this browser login is guided at the moment the container first needs it (tokens never transfer from this host)`,
      };
  }
}

/** The command that attaches to a tmux session in a container on this machine. */
function localAttach(container: string, session: string): string {
  return `docker exec -it ${container} tmux attach -t ${session}`;
}

/** The command that opens pi in the daemon container with `/login` typed for
 * the operator: the release image has no pi on the PATH and the daemon hosts no
 * tmux session, so the login is the image's own `login` entrypoint mode. */
function daemonLoginCommand(container: string): string {
  return `docker exec -it ${container} /opt/qcr/docker/entrypoint.sh login`;
}

/** Container names to probe, config first so a renamed deployment still works;
 * the fallbacks are the loader's own defaults. */
export function daemonContainerName(configText: string): string {
  return readTomlString(configText, "tui", "container")?.trim() || TUI_DEFAULTS.container;
}

/**
 * The daemon container on this machine. The shipped compose file sets no
 * `container_name`, so compose names it after the project
 * (`<project>-daemon-1`), never the `[tui] container` the VM uses: ask compose
 * first; when it names none (no compose stack here, or no daemon container
 * yet) the configured name is probed.
 */
async function localDaemonContainer(
  runner: ProcessRunner,
  root: string,
  configText: string,
): Promise<string> {
  const ps = await runner.run(
    "docker",
    composeArgs(root, ["ps", "--all", "--format", "{{.Name}}", DAEMON_SERVICE]),
  );
  if (ps.code === 0) {
    const name = ps.stdout
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l !== "");
    if (name) return name;
  }
  return daemonContainerName(configText);
}

export function companionContainerName(configText: string): string {
  return (
    readTomlString(configText, "companion", "container_name")?.trim() ||
    COMPANION_DEFAULTS.container_name
  );
}

/** The companion's tmux session — where its pi, and so its /login, runs. */
export function companionSessionName(configText: string): string {
  return readTomlString(configText, "companion", "session")?.trim() || COMPANION_DEFAULTS.session;
}

// ---- the operator-facing text ----------------------------------------------

export const ROUTE_QUESTION =
  "How should the review sessions authenticate to OpenAI?\n" +
  "  1) oauth — a ChatGPT subscription. Cost is your plan, flat. The catch: pi's OAuth tokens live in the\n" +
  "     pi home of whichever process logged in and DO NOT transfer between this host and the containers, so\n" +
  "     expect up to three separate browser logins — this wizard's pi session, the daemon container, and the\n" +
  "     companion container. Each is guided when its surface first needs it.\n" +
  "  2) api — one OpenAI API key, metered per token. One paste covers the daemon and its review sessions (the daemon\n" +
  "     container's entrypoint exports the key file as OPENAI_API_KEY), and the wizard rewrites all five model strings\n" +
  "     for you. The companion container is not handed the key: it keeps its own login.\n" +
  "Answer 1/oauth or 2/api:";

export const KEY_QUESTION = `paste the OpenAI API key (it is written straight to the ${OPENAI_KEY_FILE} secrets file, 0600, never to a command line):`;

export const EMBEDDINGS_NOTE =
  "memory embeddings need nothing from this step: the memory engine embeds LOCALLY by default, inside the daemon " +
  "container, so no memory text leaves the machine on either route. openai_api_key is pi's model credential alone and " +
  "is never read for embeddings; a hosted embedder is a separate, explicit opt-in (the embeddings step, order 38) with " +
  "its own openai_embeddings_api_key file.";

export const STEP_EXPLAIN =
  "Chooses how the review sessions talk to OpenAI, and makes the whole installation consistent with that choice. " +
  "OAuth (a ChatGPT subscription) is flat-cost but costs up to three separate browser logins — this wizard's pi " +
  "session, the daemon container and the companion container — because pi's tokens do not transfer between the host " +
  "and a container; each login is guided where it happens and verified to have landed on that container's persistent " +
  "pi-home volume, so a recreate never silently costs it. An API key is one paste that covers the daemon and its review " +
  "sessions (the companion container is not handed the key and keeps its own login), " +
  "and the wizard then rewrites all five model strings in config.toml from the openai-codex/ provider prefix to " +
  "openai/ (comment-preserving and reversible — switching routes later just re-runs this step). Neither route has " +
  "anything to do with memory embeddings: those run locally by default, and pi's key is never used for them.";

// ---- route decision ---------------------------------------------------------

export function parseRouteAnswer(answer: string): AuthRoute | null {
  const a = answer.trim().toLowerCase();
  if (["1", "oauth", "chatgpt", "subscription", "login"].includes(a)) return "oauth";
  if (["2", "api", "key", "api key", "api-key", "apikey"].includes(a)) return "api";
  return null;
}

/** The recorded route: the shared choice reader first, then this step's own
 * record (an older checklist), read through the same reader. */
function recordedRoute(ctx: StepContext): AuthRoute | null {
  return authRouteOf(ctx.choices) ?? authRouteOf({ [AUTH_ROUTE_CHOICE_KEY]: ctx.data.route });
}

interface RouteDecision {
  route: AuthRoute | null;
  source: string;
}

/**
 * run() re-decides the route every time, so switching later is just "change the
 * world and run the step again" — which is what makes the rewrite reversible in
 * practice. Order:
 *   1. the prompter (the non-LLM fallback entry actually asks the question);
 *   2. otherwise the credential reality, using pi's OWN resolution order
 *      (CLI flag → auth.json → env): a completed host login means the OAuth
 *      route is what pi will really use, so the config must say so;
 *   3. otherwise a valid key file;
 *   4. otherwise the previously recorded route;
 *   5. otherwise: no answer yet — the step goes red with the choice text.
 */
async function decideRoute(
  ctx: StepContext,
  keyFile: KeyFileState,
  hostLogin: boolean,
): Promise<RouteDecision> {
  const prompter = ctx.adapters.prompter;
  if (prompter) {
    const answer = await prompter(ROUTE_QUESTION);
    const parsed = parseRouteAnswer(answer);
    if (parsed) return { route: parsed, source: "you chose it" };
    const kept = recordedRoute(ctx);
    if (!answer.trim() && kept)
      return { route: kept, source: "kept the recorded route (empty answer)" };
    return { route: null, source: `did not understand the answer — reply 1/oauth or 2/api` };
  }
  if (hostLogin)
    return {
      route: "oauth",
      source: "a completed pi login is on this host, and pi prefers auth.json over any env key",
    };
  if (keyFile.valid)
    return { route: "api", source: `a valid ${OPENAI_KEY_FILE} is in the secrets dir` };
  const kept = recordedRoute(ctx);
  if (kept) return { route: kept, source: "the recorded route" };
  return { route: null, source: "nothing on disk says which route this installation uses" };
}

// ---- config loading ---------------------------------------------------------

interface ConfigState {
  path: string;
  text: string | null;
  /** Set when this call seeded config.toml from config.example.toml. */
  seeded: boolean;
  error: string | null;
}

function loadConfig(paths: OnboardAdapters["paths"], allowSeed: boolean): ConfigState {
  const path = paths.configPath;
  if (existsSync(path)) {
    try {
      return { path, text: readFileSync(path, "utf8"), seeded: false, error: null };
    } catch (err) {
      return { path, text: null, seeded: false, error: `cannot read ${path}: ${String(err)}` };
    }
  }
  const example = configExamplePathFor(paths.stateDir);
  if (!allowSeed)
    return {
      path,
      text: null,
      seeded: false,
      error: `${path} does not exist yet — run this step to create it from config.example.toml`,
    };
  if (!existsSync(example))
    return {
      path,
      text: null,
      seeded: false,
      error: `neither ${path} nor ${example} exists — is this a QuickReview checkout?`,
    };
  try {
    // A fresh install's config lives in the config home, which may
    // not exist yet.
    mkdirSync(dirname(path), { recursive: true });
    copyFileSync(example, path);
    return { path, text: readFileSync(path, "utf8"), seeded: true, error: null };
  } catch (err) {
    return {
      path,
      text: null,
      seeded: false,
      error: `could not create ${path} from config.example.toml: ${String(err)}`,
    };
  }
}

// ---- checks -----------------------------------------------------------------

function embeddingsCheck(): CheckResult {
  return { name: "embeddings", ok: true, detail: EMBEDDINGS_NOTE };
}

function modelsCheck(audit: ModelAudit[], route: AuthRoute, note: string): CheckResult {
  const wrong = audit
    .filter((a) => a.kind === "oauth" || a.kind === "api")
    .filter((a) => a.kind !== route);
  const missing = audit.filter((a) => a.kind === "missing");
  const custom = audit.filter((a) => a.kind === "custom");
  const tail = [
    custom.length ? `left alone on another provider: ${custom.map((c) => c.label).join(", ")}` : "",
    note,
  ]
    .filter(Boolean)
    .join("; ");
  if (wrong.length === 0 && missing.length === 0) {
    return {
      name: "models",
      ok: true,
      detail: `all ${audit.length - custom.length} model strings use the ${prefixFor(route)} prefix (${route} route)${tail ? ` — ${tail}` : ""}`,
    };
  }
  const problems = [
    wrong.length
      ? `still on the wrong provider: ${wrong.map((w) => `${w.label}="${w.value}"`).join(", ")}`
      : "",
    missing.length ? `not found in config.toml: ${missing.map((m) => m.label).join(", ")}` : "",
  ].filter(Boolean);
  return {
    name: "models",
    ok: false,
    detail: `${problems.join("; ")} — expected the ${prefixFor(route)} prefix for the ${route} route${tail ? ` (${tail})` : ""}`,
  };
}

/**
 * What the route means for the companion. Its container is never handed the
 * API key file, so on the api route an `openai/` companion model has no
 * credential, and the shipped `openai-codex/` one keeps needing the
 * companion's own login.
 */
function companionModelNote(configText: string, route: AuthRoute): string {
  const model = readTomlString(configText, "companion", "model") ?? COMPANION_DEFAULTS.model;
  if (route === "oauth") {
    return model.startsWith(OAUTH_PREFIX)
      ? ""
      : `[companion] model is set to "${model}" — the companion is yours to point where you like, but on the oauth route it usually wants the ${OAUTH_PREFIX} prefix too`;
  }
  return model.startsWith(API_PREFIX)
    ? `[companion] model is "${model}", but the companion container is never handed ${OPENAI_KEY_FILE}, so that model has no ` +
        `credential there — point it at ${OAUTH_PREFIX} and log the companion in, or pass OPENAI_API_KEY to its container yourself`
    : `the companion (model "${model}") is not covered by ${OPENAI_KEY_FILE} — its container is never handed the key, so it keeps ` +
        "its own login (/login in its pi)";
}

async function companionLoginChecks(ctx: StepContext, configText: string): Promise<CheckResult[]> {
  const model = readTomlString(configText, "companion", "model") ?? COMPANION_DEFAULTS.model;
  if (!model.startsWith(OAUTH_PREFIX)) return [];
  const name = companionContainerName(configText);
  return [
    loginCheck(
      "companion_login",
      "companion container",
      { command: localAttach(name, companionSessionName(configText)), tmux: true },
      await probeContainerLogin(ctx.adapters.runner, name),
    ),
  ];
}

async function oauthLoginChecks(
  ctx: StepContext,
  configText: string,
  home: string,
): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];
  const authPath = hostAuthJsonPath(home);
  const hostOk = hostHasOAuthLogin(authPath);
  checks.push(
    hostOk
      ? {
          name: "wizard_login",
          ok: true,
          detail: `this host's pi is logged in (${authPath}) — login 1 of 3 done`,
        }
      : {
          name: "wizard_login",
          ok: false,
          detail:
            `no ChatGPT (${OAUTH_PROVIDER}) OAuth login in this host's pi (${authPath}). Log in from this very session — type /login at pi's input line ` +
            "and follow the browser flow — then run this step again. This is login 1 of 3; the two container logins come later.",
        },
  );
  const runner = ctx.adapters.runner;
  // The daemon runs where the topology says: on the VM route its container is
  // on the review host, so the probe goes there over ssh (the transport's own
  // facts: alias, container, sudo). The companion is always this machine's.
  // The repair command names the same host and container the probe reached.
  const vm = topologyOf(ctx.choices) === "vm";
  let daemon = vm ? "" : await localDaemonContainer(runner, rootOf(ctx.adapters), configText);
  let daemonRunner: ProcessRunner = runner;
  let daemonAttach = daemonLoginCommand(daemon);
  if (vm) {
    const facts = remoteFactsFor(ctx.adapters, ctx.choices);
    daemon = facts.container;
    const prefix = facts.sudo ? ["sudo"] : [];
    daemonAttach = `ssh -t ${facts.alias || "<vm>"} ${facts.sudo ? "sudo " : ""}${daemonLoginCommand(daemon)}`;
    daemonRunner =
      facts.alias === ""
        ? { run: async () => ({ code: 1, stdout: "", stderr: "no ssh alias recorded" }) }
        : {
            run: (cmd, args) => runner.run("ssh", sshArgv(facts.alias, [...prefix, cmd, ...args])),
          };
  }
  checks.push(
    loginCheck(
      "daemon_login",
      "daemon container",
      { command: daemonAttach, tmux: false },
      await probeContainerLogin(daemonRunner, daemon),
    ),
  );
  checks.push(...(await companionLoginChecks(ctx, configText)));
  return checks;
}

// ---- the step ---------------------------------------------------------------

export function llmAuthStep(opts: { transport?: TransportOptions } = {}): OnboardingStep {
  return {
    id: LLM_AUTH_STEP_ID,
    title: "LLM auth: ChatGPT OAuth or an API key",
    explain: STEP_EXPLAIN,
    // After preflight (10) and the topology question (20): the spec's second
    // question, and everything after it assumes a decided route.
    order: 30,

    async run(ctx): Promise<StepReport> {
      const home = hostHome();
      const cfg = loadConfig(ctx.adapters.paths, true);
      if (cfg.text === null) {
        return {
          ok: false,
          checks: [{ name: "config", ok: false, detail: cfg.error ?? "config.toml unavailable" }],
        };
      }
      const checks: CheckResult[] = [];
      if (cfg.seeded) {
        checks.push({
          name: "config",
          ok: true,
          detail: `created ${cfg.path} from config.example.toml (its FILL values are untouched — later steps fill them)`,
        });
      }

      const secretsDir = resolveSecretsDir(
        cfg.text,
        home,
        process.env.QC_SECRETS_DIR,
        rootOf(ctx.adapters),
      );
      let keyFile = readKeyFileState(secretsDir);
      const hostLogin = hostHasOAuthLogin(hostAuthJsonPath(home));

      const decision = await decideRoute(ctx, keyFile, hostLogin);
      if (decision.route === null) {
        checks.push({ name: "route", ok: false, detail: `${decision.source}.\n${ROUTE_QUESTION}` });
        return { ok: false, checks };
      }
      const route = decision.route;
      checks.push({ name: "route", ok: true, detail: `${route} route — ${decision.source}` });

      let credentialChanged =
        ctx.data.credentials_owed === true ||
        (route === "api" &&
          (recordedRoute(ctx) !== "api" ||
            auditModelStrings(cfg.text).some((model) => model.kind === "oauth")));
      // --- the credential ------------------------------------------------
      if (route === "api") {
        if (!keyFile.valid) {
          const prompter = ctx.adapters.prompter;
          if (prompter) {
            const pasted = await prompter(KEY_QUESTION);
            if (!pasted.trim()) {
              checks.push({
                name: "credential",
                ok: false,
                detail: `no key entered — nothing was written to ${keyFile.path}. Run this step again, or collect the key with: bash deploy/collect-secrets.sh`,
              });
            } else if (!validateOpenAiKey(pasted)) {
              // The value itself is NEVER echoed back.
              checks.push({
                name: "credential",
                ok: false,
                detail:
                  "that does not look like an OpenAI API key (they start with sk- and contain no spaces) — nothing was written",
              });
            } else {
              writeKeyFile(secretsDir, pasted);
              credentialChanged = true;
              keyFile = readKeyFileState(secretsDir);
              checks.push({
                name: "credential",
                ok: true,
                detail:
                  `saved to ${keyFile.path} (0600, dir 0700) — the daemon container's entrypoint exports it as OPENAI_API_KEY ` +
                  "for every review session; the companion container is never handed it (see the models note)",
              });
            }
          } else {
            checks.push({
              name: "credential",
              ok: false,
              detail:
                `no valid ${OPENAI_KEY_FILE} in ${secretsDir}. Collect it with the secrets wizard, in another terminal: ` +
                "bash deploy/collect-secrets.sh — it reads the key with hidden input and writes it 0600. " +
                "(The key never passes through this session or any command line.) Then run this step again.",
            });
          }
        } else {
          checks.push({
            name: "credential",
            ok: true,
            detail: `${OPENAI_KEY_FILE} present in ${secretsDir} — the daemon container's entrypoint exports it for every review session`,
          });
        }
      }

      // A refused credential leaves the previously working models and the
      // running daemon exactly as they were: nothing is rewritten or delivered.
      if (checks.some((c) => c.name === "credential" && !c.ok)) {
        return {
          ok: false,
          checks,
          data: {
            restart_owed: ctx.data.restart_owed === true,
            credentials_owed: ctx.data.credentials_owed === true,
          },
        };
      }

      // --- the model strings ---------------------------------------------
      const rewrite = rewriteModelPrefixes(cfg.text, route);
      if (rewrite.text !== cfg.text) {
        try {
          writeAtomic(cfg.path, rewrite.text);
        } catch (err) {
          checks.push({
            name: "models",
            ok: false,
            detail: `could not write ${cfg.path}: ${String(err)}`,
          });
          return { ok: false, checks };
        }
      }
      const configText = rewrite.text;
      const audit = auditModelStrings(configText);
      const note = [
        rewrite.rewritten.length
          ? `rewrote ${rewrite.rewritten.length}: ${rewrite.rewritten.join(", ")}`
          : "already on this route",
        companionModelNote(configText, route),
      ]
        .filter(Boolean)
        .join("; ");
      checks.push(modelsCheck(audit, route, note));

      // --- the logins ------------------------------------------------------
      if (route === "oauth") checks.push(...(await oauthLoginChecks(ctx, configText, home)));
      else checks.push(...(await companionLoginChecks(ctx, configText)));
      const delivery = await deliverConfigChange(
        ctx,
        {
          ...opts.transport,
          ...(credentialChanged ? { deploymentMode: "provision" as const } : {}),
        },
        ctx.data.restart_owed === true || credentialChanged || rewrite.text !== cfg.text,
        LLM_AUTH_STEP_ID,
      );
      checks.push(...delivery.checks);
      checks.push(embeddingsCheck());

      const ok = checks.every((c) => c.ok);
      if (ok) {
        ctx.recordChoice(CHOICE_KEYS.authRoute, route);
        ctx.recordChoice(MODEL_PREFIX_CHOICE_KEY, prefixFor(route));
        return {
          ok,
          checks,
          data: {
            route,
            prefix: prefixFor(route),
            config_path: cfg.path,
            models: modelLabels(),
            restart_owed: delivery.restartOwed,
            credentials_owed: credentialChanged && delivery.restartOwed,
          },
        };
      }
      return {
        ok,
        checks,
        data: {
          restart_owed: delivery.restartOwed,
          credentials_owed: credentialChanged && delivery.restartOwed,
        },
      };
    },

    async verify(ctx): Promise<StepReport> {
      const owed = configDeliveryChecks(ctx);
      if (owed.length) return { ok: false, checks: owed };
      // Never prompts, never writes, never touches a credential value.
      const home = hostHome();
      const route = recordedRoute(ctx);
      if (route === null) {
        return {
          ok: false,
          checks: [
            {
              name: "route",
              ok: false,
              detail: "no LLM auth route recorded — run this step to choose one",
            },
          ],
        };
      }
      const cfg = loadConfig(ctx.adapters.paths, false);
      if (cfg.text === null) {
        return {
          ok: false,
          checks: [
            { name: "route", ok: true, detail: `${route} route recorded` },
            { name: "config", ok: false, detail: cfg.error ?? "config.toml unavailable" },
          ],
        };
      }
      const checks: CheckResult[] = [
        { name: "route", ok: true, detail: `${route} route recorded` },
      ];
      const secretsDir = resolveSecretsDir(
        cfg.text,
        home,
        process.env.QC_SECRETS_DIR,
        rootOf(ctx.adapters),
      );
      const keyFile = readKeyFileState(secretsDir);

      if (route === "api") {
        checks.push(
          keyFile.valid
            ? {
                name: "credential",
                ok: true,
                detail: `${OPENAI_KEY_FILE} present in ${secretsDir}`,
              }
            : {
                name: "credential",
                ok: false,
                detail: keyFile.present
                  ? `${keyFile.path} does not look like an OpenAI API key (they start with sk-) — re-run the step or bash deploy/collect-secrets.sh`
                  : `the api route needs ${OPENAI_KEY_FILE} in ${secretsDir} — run bash deploy/collect-secrets.sh, or re-run this step to switch back to the OAuth route`,
              },
        );
      }

      checks.push(
        modelsCheck(auditModelStrings(cfg.text), route, companionModelNote(cfg.text, route)),
      );
      if (route === "oauth") checks.push(...(await oauthLoginChecks(ctx, cfg.text, home)));
      else checks.push(...(await companionLoginChecks(ctx, cfg.text)));
      checks.push(embeddingsCheck());

      return { ok: checks.every((c) => c.ok), checks };
    },
  };
}
