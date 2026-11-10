// `qcr model`: which model reviews run on here, why, and how to change it.
//
//   qcr model [--json]                 the route, or why there is none
//   qcr model use <provider[/model]>   run reviews on this provider (and model)
//   qcr model reset                    forget that: pick automatically again
//
// A front-door verb (src/qcrbin.ts) that needs no state database. It asks pi
// the way a review does: it borrows the login of pi's agent dir for a
// review's length, adds the model environment of the install's secrets dir
// (src/modelenv.ts), and resolves the route on a host made for that alone
// (packages/pi-plugin/src/reviewhost.ts routeHost), over a private agent dir
// that is removed again. It starts no session and sends nothing.
//
// The remembered choice is one file in pi's agent dir, beside the logins it
// chooses among (packages/pi-plugin/src/modelchoice.ts), never in a config
// home: `use` writes it, `reset` removes it.
//
// `--json` prints one object, for the wizard, the scan sandbox and the smoke
// scripts: `{ ok, route, refusal?, choice, config_pin, skipped }`, where `ok`
// says a route resolves. `use` and `reset` print the same object for the
// state after the change. A failure that is not a refusal (a login file that
// cannot be read, a choice that cannot be written, a usage error) is
// `{ ok: false, route: null, error }`. No value of any credential is in it.
//
// Exit status: 0 a route resolves (or the change was made), 1 no route or a
// failure, 2 a usage error.
import { join } from "node:path";
import { borrowedCredentials } from "@quickchatai/pi-quickreview/src/engine/auth.js";
import {
  clearModelChoice,
  readModelChoice,
  writeModelChoice,
} from "@quickchatai/pi-quickreview/src/modelchoice.js";
import {
  credentialWords,
  expiryClock,
  refusalText,
  routeNoticeLines,
  routePicked,
  routeWhy,
  skippedNotice,
  type ModelChoice,
  type ModelRoute,
  type RouteRefusal,
  type RouteResult,
  type SkippedLogin,
} from "@quickchatai/pi-quickreview/src/modelroute.js";
import {
  splitModelSpec,
  TIER_LEVELS,
  type ModelsConfig,
} from "@quickchatai/pi-quickreview/src/reviewconfig.js";
import { PASS_TIER_ORDER } from "@quickchatai/pi-quickreview/src/types.js";
import { modelEnvFrom } from "./modelenv.js";

/** How long a review may last: the window a borrowed login has to outlive
 * for `qcr review` to use it. */
export const REVIEW_WINDOW_MS = 60 * 60_000;

export const MODEL_USAGE = [
  "usage: qcr model [--json]                 which model reviews run on here, and why",
  "       qcr model use <provider[/model]>   run reviews on this provider (and model)",
  "       qcr model reset                    forget that choice: pick automatically again",
].join("\n");

export interface ModelCliDeps {
  /** The environment pi's credential lookups read (with the model env over it). */
  env: Readonly<Record<string, string | undefined>>;
  /** pi's agent dir: the logins, the catalog and the remembered choice. */
  agentDir: string;
  /** Where the route host's private agent dir is made and removed: the state
   * home's tmp. */
  tmpDir: string;
  /** `[models]` of the install's config: the pin and the tiers. */
  models: Pick<ModelsConfig, "model" | "tiers">;
  /** The install's config file, or null when the shipped defaults stand in. */
  configPath: string | null;
  /** The install's secrets dir, when one is located. */
  secretsDir: string | null;
  /** The install has a config of its own, which is what a daemon runs on:
   * the answer then also says what holds for the bot's rounds. */
  daemon: boolean;
  out: (line: string) => void;
  err: (line: string) => void;
  /** How long a review may last; default `REVIEW_WINDOW_MS`. */
  needMs?: number;
  now?: () => number;
}

/** What `qcr model --json` prints. */
export interface ModelCliJson {
  /** A route resolves. */
  ok: boolean;
  route: ModelRoute | null;
  refusal?: { code: RouteRefusal["code"]; text: string };
  /** The remembered choice, or null. */
  choice: ModelChoice | null;
  /** `[models] model` as the config writes it, or null when it pins nothing. */
  config_pin: string | null;
  /** The stored logins left out because they cannot last a review here. */
  skipped: SkippedLogin[];
}

/** One resolution: the route and what the words about it need. */
interface Resolved {
  result: RouteResult;
  /** The choice the route was resolved with. */
  choice: ModelChoice | null;
  /** The skipped logins, under pi's display names. */
  skipped: SkippedLogin[];
  /** pi's display name for a provider id, else the id. */
  nameOf: (provider: string) => string;
  /** Is this a provider pi knows at all? */
  knows: (provider: string) => boolean;
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const isHelp = (arg: string | undefined): boolean =>
  arg === "--help" || arg === "-h" || arg === "help";

/** Where the config that pins the model is, in words. */
const configWhere = (deps: ModelCliDeps): string => deps.configPath ?? "the shipped defaults";

/**
 * Resolve the route as a review here would. `choice` replaces the remembered
 * one (a choice being tried before it is written); `pin: false` leaves the
 * config's pin out, to see the choice on its own.
 */
async function resolve(
  deps: ModelCliDeps,
  o: { choice?: ModelChoice; pin?: boolean } = {},
): Promise<Resolved> {
  const read = readModelChoice(deps.agentDir);
  if (read.notice !== undefined) deps.err(`note: ${read.notice}`);
  const choice = o.choice ?? read.choice ?? null;
  // Throws when the login file is there and cannot be read: an unknown store
  // is never taken for an empty one.
  const borrowed = borrowedCredentials({
    srcDir: deps.agentDir,
    needMs: deps.needMs ?? REVIEW_WINDOW_MS,
    owner: false,
    ...(deps.now ? { now: deps.now } : {}),
  });
  const modelEnv =
    deps.secretsDir !== null ? modelEnvFrom(deps.secretsDir, { warn: deps.err }) : {};
  const pin = o.pin === false ? "" : deps.models.model;
  // Loaded here, not at the top: the pi SDK is needed only once a route is asked for.
  const [{ routeHost }, { piSavedProvider }] = await Promise.all([
    import("@quickchatai/pi-quickreview/src/reviewhost.js"),
    import("@quickchatai/pi-quickreview/src/engine/pisdk.js"),
  ]);
  const piProvider = piSavedProvider(deps.agentDir);
  const made = await routeHost({
    srcAgentDir: deps.agentDir,
    tmpDir: deps.tmpDir,
    credentials: borrowed.credentials,
    // The model env over the process's own, as a worker's process holds it.
    authEnv: { ...deps.env, ...modelEnv },
    route: {
      skipped: borrowed.skipped,
      ...(pin !== "" ? { pin: { text: pin, from: "config" as const } } : {}),
      ...(choice !== null ? { choice } : {}),
      ...(piProvider !== undefined
        ? { piProvider: { provider: piProvider, from: "pi-settings" as const } }
        : {}),
    },
  });
  try {
    const result = await made.host.route();
    const names = new Map(made.host.modelRuntime.getProviders().map((p) => [p.id, p.name]));
    const nameOf = (provider: string): string => names.get(provider) ?? provider;
    return {
      result: named(result, borrowed.skipped, nameOf),
      choice,
      skipped: borrowed.skipped.map((l) => ({ ...l, name: nameOf(l.provider) })),
      nameOf,
      knows: (provider) => names.has(provider),
    };
  } finally {
    made.dispose();
  }
}

/** The result with pi's display names where the borrow could only give ids:
 * the borrow reads a login file and knows no provider's name. */
function named(
  result: RouteResult,
  skipped: readonly SkippedLogin[],
  nameOf: (provider: string) => string,
): RouteResult {
  const rename = (l: SkippedLogin): SkippedLogin => ({ ...l, name: nameOf(l.provider) });
  if (!result.ok)
    return result.refusal.code === "login-too-short"
      ? { ok: false, refusal: { ...result.refusal, logins: result.refusal.logins.map(rename) } }
      : result;
  const said = new Map(skipped.map((l) => [skippedNotice(l), skippedNotice(rename(l))]));
  return {
    ok: true,
    route: { ...result.route, notices: result.route.notices.map((n) => said.get(n) ?? n) },
  };
}

function refusalWords(deps: ModelCliDeps, r: Resolved, refusal: RouteRefusal): string {
  return refusalText(refusal, "app", {
    agentDir: deps.agentDir,
    needMs: deps.needMs ?? REVIEW_WINDOW_MS,
    configPath: deps.configPath,
    nameOf: r.nameOf,
    ...(deps.now ? { now: deps.now } : {}),
  });
}

function stateJson(deps: ModelCliDeps, r: Resolved): ModelCliJson {
  return {
    ok: r.result.ok,
    route: r.result.ok ? r.result.route : null,
    ...(r.result.ok
      ? {}
      : {
          refusal: {
            code: r.result.refusal.code,
            text: refusalWords(deps, r, r.result.refusal),
          },
        }),
    choice: r.choice,
    config_pin: deps.models.model !== "" ? deps.models.model : null,
    skipped: r.skipped,
  };
}

/** A login left out, and where it does work. */
function skippedWords(deps: ModelCliDeps, login: SkippedLogin): string {
  const past = login.expiresAt <= (deps.now ?? Date.now)();
  return `${login.name}: its login ${past ? "expired" : "expires"} at ${expiryClock(login.expiresAt)} and nothing here renews it (inside pi: /qcr-review)`;
}

/** Each tier as it runs on the route: its level, or the whole spec of a tier
 * the config pins to a model of its own. */
function levelsLine(deps: ModelCliDeps): string {
  const each = PASS_TIER_ORDER.map((tier) => {
    const spec = deps.models.tiers[tier];
    const own = splitModelSpec(spec);
    return `${tier} ${own.model !== "" ? spec : (own.thinking ?? TIER_LEVELS[tier])}`;
  });
  return `levels: ${each.join(", ")}`;
}

/** The answer as a person reads it. */
function stateLines(deps: ModelCliDeps, r: Resolved): string[] {
  const lines: string[] = [];
  const notUsable = (): void => {
    if (r.skipped.length === 0) return;
    lines.push("not usable here:");
    for (const login of r.skipped) lines.push(`  ${skippedWords(deps, login)}`);
  };
  if (!r.result.ok) {
    lines.push("model: none", refusalWords(deps, r, r.result.refusal));
    // The refusal of a login that is too short already names it.
    if (r.result.refusal.code !== "login-too-short") notUsable();
    return lines;
  }
  const route = r.result.route;
  lines.push(`model: ${route.spec}`);
  lines.push(`  why: ${routeWhy(route, "app", { configPath: configWhere(deps) })}`);
  const picked = routePicked(route);
  if (picked !== null) lines.push(`  picked: ${picked}`);
  if (route.custom)
    lines.push(`  note: not in pi's catalog for ${route.providerName}: sent as written`);
  lines.push(`  credential: ${route.providerName}, ${credentialWords(route.credential)}`);
  lines.push(`  ${levelsLine(deps)}`);
  if (!route.priced) lines.push("  price: pi has no list price for this model");
  if (deps.daemon) lines.push("  bot rounds: no dollar stop (time limits hold)");
  // The logins left out have their own block below.
  const left = new Set(r.skipped.map(skippedNotice));
  for (const notice of route.notices) if (!left.has(notice)) lines.push(`  note: ${notice}`);
  if (route.alternatives.length > 0) {
    // Two rows on one environment variable spend the same key.
    const labels = [route, ...route.alternatives]
      .filter((x) => x.credential.origin === "env-key")
      .map((x) => x.credential.label);
    const shared = (label: string | undefined): boolean =>
      label !== undefined && labels.filter((l) => l === label).length > 1;
    lines.push("also usable:");
    for (const alt of route.alternatives)
      lines.push(
        "  " +
          [
            alt.spec,
            `${alt.providerName}, ${credentialWords(alt.credential)}`,
            ...(alt.priced ? [] : ["no list price"]),
            ...(alt.credential.origin === "env-key" && shared(alt.credential.label)
              ? [`same key: ${alt.credential.label}`]
              : []),
          ].join("    "),
      );
  }
  notUsable();
  lines.push(
    "change it: qcr model use <provider[/model]>    automatic again: qcr model reset    one run: --model <provider/model>",
  );
  return lines;
}

/** Print the state, as JSON or as lines. */
function printState(deps: ModelCliDeps, json: boolean, r: Resolved): void {
  if (json) deps.out(JSON.stringify(stateJson(deps, r)));
  else for (const line of stateLines(deps, r)) deps.out(line);
}

/** A failure that is not a refusal, on the surface asked for. */
function fail(deps: ModelCliDeps, json: boolean, error: string, code: 1 | 2): number {
  if (json) deps.out(JSON.stringify({ ok: false, route: null, error }));
  else deps.err(`qcr model: ${error}`);
  return code;
}

async function show(json: boolean, deps: ModelCliDeps): Promise<number> {
  const r = await resolve(deps);
  printState(deps, json, r);
  return r.result.ok ? 0 : 1;
}

async function use(target: string, json: boolean, deps: ModelCliDeps): Promise<number> {
  const slash = target.indexOf("/");
  const provider = (slash < 0 ? target : target.slice(0, slash)).trim();
  const given = slash < 0 ? null : target.slice(slash + 1).trim();
  if (provider === "" || given === "") {
    return fail(deps, json, `"${target}" names no provider or no model\n${MODEL_USAGE}`, 2);
  }
  const candidate: ModelChoice = {
    provider,
    // A level is not part of a choice: each tier keeps its own.
    model: given === null ? null : splitModelSpec(given).model,
    via: "use",
    no_estimate_ok: readModelChoice(deps.agentDir).noEstimateOk,
  };
  // The choice on its own, through pi's own reading of the text: the config's
  // pin is left out here and named afterwards.
  const tried = await resolve(deps, { choice: candidate, pin: false });
  if (!tried.knows(provider))
    return fail(
      deps,
      json,
      `pi knows no provider "${provider}": qcr model lists the usable ones`,
      2,
    );
  const refusal = tried.result.ok ? null : tried.result.refusal;
  if (refusal?.code === "pin-unknown")
    return fail(deps, json, refusalWords(deps, tried, refusal), 2);
  // A provider none of whose models a review can run on is not remembered:
  // every review would be refused. The refusal says how to name a model.
  if (refusal?.code === "no-model") return fail(deps, json, refusalWords(deps, tried, refusal), 1);
  const model =
    candidate.model === null
      ? null
      : tried.result.ok
        ? tried.result.route.modelId
        : candidate.model;
  const written = writeModelChoice(deps.agentDir, { provider, model, via: "use" });
  if (!written.ok) return fail(deps, json, written.error, 1);
  if (json) {
    printState(deps, true, await resolve(deps));
    return 0;
  }
  deps.out(
    `remembered: ${provider}${model !== null ? `/${model}` : ""}. Reviews on this pi run on it; qcr model reset makes the choice automatic again.`,
  );
  if (tried.result.ok && tried.result.route.custom)
    deps.out(
      `note: ${model} is not in pi's catalog for ${tried.result.route.providerName}: it is sent as written`,
    );
  if (refusal?.code === "login-too-short")
    for (const login of refusal.logins) deps.out(`note: ${skippedWords(deps, login)}`);
  else if (refusal !== null)
    deps.out(`pi has no credential for ${provider} yet: qcr login ${provider}`);
  if (deps.models.model !== "")
    deps.out(
      `[models] model in ${configWhere(deps)} still pins ${deps.models.model}: the config wins`,
    );
  return 0;
}

async function reset(json: boolean, deps: ModelCliDeps): Promise<number> {
  const cleared = clearModelChoice(deps.agentDir);
  if (!cleared.ok) return fail(deps, json, cleared.error, 1);
  const r = await resolve(deps);
  if (json) {
    printState(deps, true, r);
    return 0;
  }
  if (r.result.ok) {
    const [line, ...notices] = routeNoticeLines(r.result.route, "app");
    deps.out(`forgot the remembered model. Now: ${line}`);
    for (const notice of notices) deps.out(notice);
  } else {
    deps.out("forgot the remembered model. Now: model: none");
    deps.out(refusalWords(deps, r, r.result.refusal));
  }
  return 0;
}

/** `qcr model …` on `args` (the arguments after the verb, `--json` taken off). */
export async function cmdModel(
  args: readonly string[],
  json: boolean,
  deps: ModelCliDeps,
): Promise<number> {
  const [sub, ...rest] = args;
  try {
    if (sub === undefined) return await show(json, deps);
    if (isHelp(sub)) {
      deps.out(MODEL_USAGE);
      return 0;
    }
    if (sub === "use" && rest.length === 1) return await use(rest[0]!, json, deps);
    if (sub === "reset" && rest.length === 0) return await reset(json, deps);
  } catch (e) {
    // A login file that cannot be read, a host that cannot be made: said in
    // one line, never as a stack.
    return fail(deps, json, errorText(e), 1);
  }
  return fail(deps, json, `unknown arguments: ${args.join(" ")}\n${MODEL_USAGE}`, 2);
}

/** `qcr model` for this process: the install's config and homes, pi's agent
 * dir as pi finds it. */
export async function runModelCli(
  args: readonly string[],
  json: boolean,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const out = (line: string): void => console.log(line);
  const err = (line: string): void => console.error(line);
  // The usage needs no config and no pi home.
  if (isHelp(args[0])) {
    out(MODEL_USAGE);
    return 0;
  }
  let deps: ModelCliDeps;
  try {
    const [{ assetRoot }, { loadOneShotConfig, stateHome }, { piAgentDir }] = await Promise.all([
      import("@quickchatai/pi-quickreview/src/assetroot.js"),
      import("./homes.js"),
      import("./piagentdir.js"),
    ]);
    // The install's config, or the shipped defaults when it has none.
    const loaded = loadOneShotConfig({ root: assetRoot(), env, warn: err });
    deps = {
      env,
      agentDir: piAgentDir(env),
      tmpDir: join(stateHome(env), "tmp"),
      models: loaded.cfg.models,
      configPath: loaded.path,
      secretsDir: loaded.cfg.github.secrets_dir || null,
      daemon: loaded.path !== null,
      out,
      err,
    };
  } catch (e) {
    if (json) out(JSON.stringify({ ok: false, route: null, error: errorText(e) }));
    else err(`qcr model: ${errorText(e)}`);
    return 1;
  }
  return cmdModel(args, json, deps);
}
