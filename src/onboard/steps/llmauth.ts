// The wizard's model step: a route resolves where the daemon runs.
//
// QuickReview reviews on whatever model credential pi has: a subscription
// login, an API key stored by /login, or a provider key in the environment.
// Which credential that is, and which model it runs, is one rule
// (packages/pi-plugin/src/modelroute.ts), and `qcr model --json`
// (src/modelcli.ts) is that rule asked from outside. This step asks it in two
// places and decides nothing of its own:
//
//   in the daemon's container   the answer that counts, once the daemon runs.
//                               `qcr model` reads the secrets dir's model
//                               environment itself (src/modelenv.ts), so the
//                               exec sees what a worker sees.
//   on this machine             the home's pi. On this computer it stands in
//                               for a daemon that is not running yet: the
//                               daemon's container mounts this machine's
//                               secrets dir, and auto-review reviews on this
//                               machine's login (steps/loginshare.ts). On a
//                               server it stands in for nothing, because no
//                               login is ever copied there: the line is a note.
//
// So there is no route question, no key question, no config rewrite and no key
// file here: the step names no provider and no model, and a daemon signed in
// to any provider pi offers is green. The one thing it records is the model it
// found, for the interview's shape line.
//
// What an older wizard recorded (an auth route, a model prefix) is not read:
// src/onboard/choices.ts says which keys those are.
//
// House rules, structural here:
//   - NO credential value ever reaches an argv, a check detail, the checklist
//     or a tool result. The step never opens a credential file: it runs two
//     fixed commands and reads their one JSON object, which holds no value of
//     any credential (src/modelcli.ts).
//   - Config reads are tolerant: a half-filled config.toml, or none at all, is
//     read through the wizard's own key readers, never the strict loader.
//   - run() and verify() ask the same two questions, and neither writes a
//     file. An answer that cannot be read is said as that, never as a route.
import { dirname, join } from "node:path";
import {
  credentialWords,
  type CredentialOrigin,
  type ProviderCredential,
  type RouteRefusal,
} from "@quickchatai/pi-quickreview/src/modelroute.js";
import { defaultCliPath } from "../../githubtoken.js";
import { LEGACY_MODEL_KEY_FILE, MODEL_ENV_DIR } from "../../modelenv.js";
import { OPENVIKING_DEFAULTS } from "../../config.js";
import { CHOICE_KEYS } from "../choices.js";
import type {
  CheckResult,
  OnboardingStep,
  ProcessResult,
  StepContext,
  StepReport,
} from "../engine.js";
import { secretsDirFor } from "./compose.js";
import { topologyOf } from "./topology.js";
import {
  remoteFactsFor,
  stackTransportFor,
  type StackTransport,
  type TransportOptions,
} from "./transport.js";

export const LLM_AUTH_STEP_ID = "llm_auth";

/** The shipped config template beside the state dir: what a step that has no
 * config.toml yet reads its defaults from. */
export function configExamplePathFor(stateDir: string): string {
  return join(dirname(stateDir), "config.example.toml");
}

// ---- the question -------------------------------------------------------------

/** `qcr model --json`, as the arguments after the app's cli.js. */
export const MODEL_QUERY: readonly string[] = ["model", "--json"];
/** The same question inside the daemon's container, on the image's own cli.js. */
export const CONTAINER_MODEL_QUERY: readonly string[] = ["node", "dist/src/cli.js", ...MODEL_QUERY];
/** The image's login mode: pi itself with /login opened, on the daemon's pi home. */
const CONTAINER_LOGIN = "/opt/qcr/docker/entrypoint.sh login";

/** What `qcr model --json` answered, as far as this step reads it. */
export type ModelAnswer =
  /** A route resolves. `words` is the model and its credential, for a person. */
  | { kind: "route"; spec: string; words: string }
  /** No route: one of the route's refusals, with its own text. */
  | { kind: "refused"; code: string; text: string }
  /** The verb ran and could not tell (a login store it could not read, say). */
  | { kind: "failed"; error: string }
  /** No answer this step can read: the command did not run, or said something else. */
  | { kind: "silent"; why: string };

/** The refusal codes this step words itself, held to the route's own list. */
const NO_CREDENTIAL: RouteRefusal["code"] = "no-credential";
const LOGIN_TOO_SHORT: RouteRefusal["code"] = "login-too-short";

/** Every origin a credential may have, so one read off a process boundary is
 * checked against the type and not trusted to be one. */
const ORIGINS: Readonly<Record<CredentialOrigin, true>> = {
  stored: true,
  runtime: true,
  "models-json": true,
  "env-key": true,
  ambient: true,
};

/** One line of another process's text, short enough for a check detail. */
function clip(text: string, max = 400): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function record(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function credentialOf(v: unknown): ProviderCredential | null {
  const c = record(v);
  if (c === null) return null;
  if (c.kind !== "oauth" && c.kind !== "api_key") return null;
  if (typeof c.origin !== "string" || !Object.hasOwn(ORIGINS, c.origin)) return null;
  return {
    kind: c.kind,
    origin: c.origin as CredentialOrigin,
    subscription: c.subscription === true,
    ...(typeof c.label === "string" ? { label: clip(c.label, 80) } : {}),
  };
}

/** `<spec> (<provider's name>, <where pi found the credential>)`, and the
 * provider a pin named when the run moved off it. */
function routeOf(v: unknown): { spec: string; words: string } | null {
  const r = record(v);
  if (r === null || typeof r.spec !== "string" || r.spec.trim() === "") return null;
  const credential = credentialOf(r.credential);
  if (credential === null) return null;
  const spec = clip(r.spec, 120);
  const name =
    typeof r.providerName === "string" && r.providerName.trim() !== ""
      ? clip(r.providerName, 80)
      : spec.split("/")[0]!;
  const moved =
    typeof r.movedFrom === "string" && r.movedFrom !== ""
      ? ` (moved from ${clip(r.movedFrom, 80)}: no credential for it there)`
      : "";
  return { spec, words: `${spec} (${name}, ${credentialWords(credential)})${moved}` };
}

/**
 * Read what `qcr model --json` printed: its one JSON object, on a line of its
 * own. Anything else (a command that did not run, an image whose cli has no
 * such verb, an object of another shape) is `silent`, with the reason: an
 * answer that cannot be read is never taken for a route, nor for a refusal.
 */
export function parseModelAnswer(r: ProcessResult): ModelAnswer {
  const lines = r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"));
  for (const line of lines.reverse()) {
    let doc: unknown;
    try {
      doc = JSON.parse(line);
    } catch {
      continue;
    }
    const o = record(doc);
    if (o === null || typeof o.ok !== "boolean") continue;
    if (o.ok) {
      const route = routeOf(o.route);
      if (route !== null) return { kind: "route", ...route };
      return { kind: "silent", why: "it answered ok with a route this wizard cannot read" };
    }
    const refusal = record(o.refusal);
    if (refusal !== null && typeof refusal.code === "string" && typeof refusal.text === "string")
      return { kind: "refused", code: clip(refusal.code, 40), text: clip(refusal.text, 600) };
    if (typeof o.error === "string") return { kind: "failed", error: clip(o.error) };
    return { kind: "silent", why: "it answered with neither a route nor a reason" };
  }
  const said = clip(r.stderr.trim() !== "" ? r.stderr : r.stdout, 200);
  return { kind: "silent", why: `exit ${r.code}${said !== "" ? `: ${said}` : ", no output"}` };
}

// ---- the two places -----------------------------------------------------------

export interface LlmAuthOptions {
  transport?: TransportOptions;
  /** node and the app's own cli.js, for asking this machine's pi. The
   * defaults are the ones this wizard runs on. */
  nodePath?: string;
  cliPath?: string;
}

/** The daemon's own pi, asked in its container; or why it could not be asked. */
type DaemonAsk =
  | { asked: true; answer: Exclude<ModelAnswer, { kind: "silent" }> }
  | { asked: false; why: "not-running" | "unknown" | "silent"; detail: string };

async function askDaemon(transport: StackTransport): Promise<DaemonAsk> {
  const state = await transport.daemonState();
  if (state.state === "stopped") return { asked: false, why: "not-running", detail: "" };
  if (state.state === "unknown") return { asked: false, why: "unknown", detail: state.detail };
  const answer = parseModelAnswer(await transport.exec(CONTAINER_MODEL_QUERY));
  return answer.kind === "silent"
    ? { asked: false, why: "silent", detail: answer.why }
    : { asked: true, answer };
}

async function askHost(ctx: StepContext, opts: LlmAuthOptions): Promise<ModelAnswer> {
  const node = opts.nodePath ?? process.execPath;
  const cli = opts.cliPath ?? defaultCliPath();
  return parseModelAnswer(await ctx.adapters.runner.run(node, [cli, ...MODEL_QUERY]));
}

/** Where the daemon runs, in the words and commands a red check needs. */
interface DaemonPlace {
  /** The server route: the daemon keeps a credential of its own there. */
  server: boolean;
  /** "on this machine, through docker compose" / "on <alias>, over ssh". */
  where: string;
  /** The command that opens pi's /login on the daemon's own pi home. */
  login: string;
  /** Where a provider key goes for the daemon, as a path a person can follow. */
  keyFile: string;
}

function daemonPlace(ctx: StepContext, transport: StackTransport): DaemonPlace {
  if (topologyOf(ctx.choices) === "vm") {
    const facts = remoteFactsFor(ctx.adapters, ctx.choices);
    return {
      server: true,
      where: transport.where,
      // pi's login is interactive: a terminal on both hops.
      login: `ssh -t ${facts.alias || "<vm>"} ${facts.sudo ? "sudo " : ""}docker exec -it ${facts.container} ${CONTAINER_LOGIN}`,
      keyFile: `the server's secrets dir, as ${MODEL_ENV_DIR}/<ENV_NAME>`,
    };
  }
  return {
    server: false,
    where: transport.where,
    login: transport.execCommand(CONTAINER_LOGIN),
    keyFile: join(secretsDirFor(ctx.adapters, ctx.choices), MODEL_ENV_DIR, "<ENV_NAME>"),
  };
}

// ---- the checks ---------------------------------------------------------------

const DAEMON_CHECK = "daemon_model";
const HOST_CHECK = "host_model";

/** The daemon's pi answered: its answer is the step's. */
function daemonAnswerCheck(
  answer: Exclude<ModelAnswer, { kind: "silent" }>,
  place: DaemonPlace,
): CheckResult {
  switch (answer.kind) {
    case "route":
      return { name: DAEMON_CHECK, ok: true, detail: `the daemon's pi runs ${answer.words}` };
    case "refused":
      return {
        name: DAEMON_CHECK,
        ok: false,
        detail:
          answer.code === NO_CREDENTIAL
            ? `the daemon's pi has no model credential. Sign in there with \`${place.login}\` (pi's /login lists every provider), ` +
              `or put a provider key in ${place.keyFile}.`
            : `the daemon's pi cannot run a review: ${answer.text}` +
              (answer.code === LOGIN_TOO_SHORT
                ? ` Sign in again there with \`${place.login}\`.`
                : ""),
      };
    case "failed":
      return {
        name: DAEMON_CHECK,
        ok: false,
        detail: `the daemon's pi could not say which model it runs: ${answer.error}`,
      };
  }
}

/** The daemon's pi could not be asked: said as that, never as a route. */
function daemonUnaskedCheck(
  ask: Extract<DaemonAsk, { asked: false }>,
  place: DaemonPlace,
): CheckResult {
  const later = place.server
    ? `The daemon keeps a credential of its own there, never this machine's login: once it runs, sign in with \`${place.login}\` ` +
      `(pi's /login lists every provider) or put a provider key in ${place.keyFile}, and this step asks its pi`
    : "This machine's pi stands in for it until it runs, and this step asks the daemon's own pi then";
  const what =
    ask.why === "not-running"
      ? `no daemon is running ${place.where} yet`
      : ask.why === "unknown"
        ? `could not tell whether the daemon is running ${place.where} (${ask.detail})`
        : `the daemon ${place.where} gave no answer to \`qcr model --json\` (${ask.detail}); an image older than this wizard has no such verb`;
  return { name: DAEMON_CHECK, ok: true, detail: `${what}. ${later}` };
}

/** This machine's pi, when its answer is the step's: the daemon runs on this
 * computer and could not be asked. */
function hostDecidingCheck(answer: ModelAnswer, place: DaemonPlace): CheckResult {
  switch (answer.kind) {
    case "route":
      return { name: HOST_CHECK, ok: true, detail: `this machine's pi runs ${answer.words}` };
    case "refused":
      // A login is there. Outside pi nothing renews it, which is what the
      // refusal says; the daemon's refresher does, and the daemon is asked
      // once it runs.
      if (answer.code === LOGIN_TOO_SHORT)
        return {
          name: HOST_CHECK,
          ok: true,
          detail:
            "this machine's pi is signed in with a login too short to last a review outside pi (`qcr model` names it). " +
            "The daemon's refresher renews a login it reviews on, and this step asks the daemon's own pi once it runs",
        };
      return {
        name: HOST_CHECK,
        ok: false,
        detail:
          answer.code === NO_CREDENTIAL
            ? "this machine's pi has no model credential. Sign in with /login in this pi session, or `qcr login` in a terminal " +
              `(pi's /login lists every provider), or put a provider key in ${place.keyFile}; then run this step again.`
            : `this machine's pi cannot run a review: ${answer.text}`,
      };
    case "failed":
      return {
        name: HOST_CHECK,
        ok: false,
        detail: `this machine's pi could not say which model it runs: ${answer.error}`,
      };
    case "silent":
      return {
        name: HOST_CHECK,
        ok: false,
        detail:
          `could not ask this machine's pi which model it runs (${answer.why}). ` +
          "Run `qcr model` in a terminal to see why, then run this step again",
      };
  }
}

/** This machine's pi, when the answer that counts is elsewhere: a note. */
function hostNoteCheck(answer: ModelAnswer, place: DaemonPlace): CheckResult {
  const aside = place.server
    ? "The daemon on the server keeps its own credential, so this line decides nothing"
    : "The daemon answered for itself, so this line decides nothing";
  const what =
    answer.kind === "route"
      ? `this machine's pi runs ${answer.words}`
      : answer.kind === "refused"
        ? `this machine's pi has no route of its own (${answer.code})`
        : `could not ask this machine's pi (${answer.kind === "failed" ? answer.error : answer.why})`;
  return { name: HOST_CHECK, ok: true, detail: `${what}. ${aside}` };
}

export const EMBEDDINGS_NOTE =
  "memory embeddings need nothing from this step: the memory engine embeds locally by default, inside the memory " +
  "container, so no memory text leaves the machine. No model credential is ever read for embeddings (not pi's login, " +
  `not a key under ${MODEL_ENV_DIR}/, not the older ${LEGACY_MODEL_KEY_FILE} file); a hosted embedder is a separate, ` +
  `explicit opt-in (the embeddings step, order 38) with its own ${OPENVIKING_DEFAULTS.embedding_key_file} file.`;

export const STEP_EXPLAIN =
  "QuickReview runs on whatever model credential pi has: a subscription login, an API key stored by /login, or a " +
  "provider key in the environment. With several, `qcr model` shows which one runs.";

/** Both answers, as checks, and the model the step found where the daemon
 * runs (null when no answer there names one). Writes nothing. */
async function modelChecks(
  ctx: StepContext,
  opts: LlmAuthOptions,
): Promise<{ checks: CheckResult[]; spec: string | null }> {
  const transport = stackTransportFor(ctx, opts.transport);
  const place = daemonPlace(ctx, transport);
  const host = await askHost(ctx, opts);
  const daemon = await askDaemon(transport);
  // This machine's pi decides only where the daemon runs on this machine and
  // could not answer for itself.
  const hostDecides = !daemon.asked && !place.server;
  const checks: CheckResult[] = [
    daemon.asked ? daemonAnswerCheck(daemon.answer, place) : daemonUnaskedCheck(daemon, place),
    hostDecides ? hostDecidingCheck(host, place) : hostNoteCheck(host, place),
    { name: "embeddings", ok: true, detail: EMBEDDINGS_NOTE },
  ];
  const counted = daemon.asked ? daemon.answer : hostDecides ? host : null;
  return { checks, spec: counted?.kind === "route" ? counted.spec : null };
}

// ---- the step -----------------------------------------------------------------

export function llmAuthStep(opts: LlmAuthOptions = {}): OnboardingStep {
  return {
    id: LLM_AUTH_STEP_ID,
    title: "Model credential: a login or key pi can use",
    explain: STEP_EXPLAIN,
    // After preflight (10) and the topology question (20), which says where
    // the daemon runs; persisted checklists name this id and this order.
    order: 30,

    async run(ctx): Promise<StepReport> {
      const { checks, spec } = await modelChecks(ctx, opts);
      const ok = checks.every((c) => c.ok);
      // The one thing recorded: the model found, for the interview's shape line.
      if (ok && spec !== null) ctx.recordChoice(CHOICE_KEYS.model, spec);
      return { ok, checks, data: { model: spec } };
    },

    async verify(ctx): Promise<StepReport> {
      // The same two questions: never a prompt, never a write.
      const { checks } = await modelChecks(ctx, opts);
      return { ok: checks.every((c) => c.ok), checks };
    },
  };
}
