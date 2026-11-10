// The scan driver's SDK leaves: the leaf runner on the SDK (scanleaves.ts
// `sdkCaseRunner`, the in-process twin of `piCaseRunner`) over a host this
// module builds per case, on the owner's borrowed login.
//
// WHERE IT RUNS. Only in scancli's detached driver, a disposable one-scan
// process (the scan sandbox or the host process `detachDriver` starts), whose
// host this module builds and owns (`scanSdkCases`). The long-lived companion
// pi never imports it: src/scancli.ts loads it on demand, and tests/
// fences-engine.test.ts pins that no extension's import closure reaches it.
// That keeps the SDK's process-global HTTP dispatcher and a frozen loop out of
// the companion (the companion boundary).
//
// AUTH. Each case builds its own host on a fresh read-only copy of the owner's
// login (engineCredentials): a token the companion refreshed mid-scan is
// picked up at the next case, a token the case would not outlive is refused
// before it starts, and nothing is ever refreshed or written here. On the host
// (no container mount), a pi home with no login runs on a provider API key in
// the environment, as `qcr review` and /qcr-scan do: an empty in-memory store,
// and pi finds the key in the driver's env by its own lookup (`authEnv`). With
// neither, the run stops naming `qcr login`.
//
// THE MODEL. A scan has one route (`scanRoute`): resolved from that same
// login source, the choice remembered beside it, pi's saved provider and a
// pin, over a host made for the route alone, the way `qcr review` resolves
// its own. The driver resolves it once, before the run is recorded, and every
// case's host is handed it as fixed (`ScanSdkCasesOptions.route`), so a login
// that changes mid-scan can end a case and never move the scan to another
// model. A case's login is then checked for the route's provider alone: a
// short-lived login of a provider the scan does not run on refuses nothing.
// The same function answers a preview: in this process for a host scan, and
// in the scan image for a sandboxed one (src/scancli.ts), where the login is.
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  AuthExpiring,
  RUNTIME_KEY_ENVS,
  SCAN_AUTH_SRC_ENV,
  SCAN_CASE_AUTH_BUDGET_MS,
  borrowedCredentials,
  engineCredentials,
  keyOnlyCredentials,
  scanAuthExpiring,
  scanAuthMissing,
} from "@quickchatai/pi-quickreview/src/engine/auth.js";
import {
  PiHost,
  piSavedProvider,
  type PiHostOptions,
} from "@quickchatai/pi-quickreview/src/engine/pisdk.js";
import { readModelChoice, writeModelChoice } from "@quickchatai/pi-quickreview/src/modelchoice.js";
import {
  credentialWords,
  refusalText,
  skippedNotice,
  type ModelChoice,
  type ModelRoute,
  type RouteInput,
  type RouteResult,
  type SkippedLogin,
} from "@quickchatai/pi-quickreview/src/modelroute.js";
import { copyCatalogFiles, routeHost } from "@quickchatai/pi-quickreview/src/reviewhost.js";
import { sdkRuntime } from "@quickchatai/pi-quickreview/src/engine/sdkruntime.js";
import { BUDGET_EXIT_CODE } from "@quickchatai/pi-quickreview/src/engine/budget.js";
import type { CaseRunner } from "@quickchatai/pi-quickreview/src/scan/scanports.js";
import {
  LEAF_TURN_TIMEOUT_MS,
  sdkCaseRunner as sdkCaseRunnerOver,
  type SdkCaseRunnerOptions,
} from "@quickchatai/pi-quickreview/src/scan/scanleaves.js";

export {
  LEAF_TURN_TIMEOUT_MS,
  caseSessionDir,
  type LeafExtras,
  type SdkCaseRunnerOptions,
} from "@quickchatai/pi-quickreview/src/scan/scanleaves.js";

/** `sdkCaseRunner` (scanleaves.ts) in this process: the leaf env filtered
 * from this process's env and a read's `~` taken as this process's home,
 * unless told otherwise. */
export function sdkCaseRunner(
  opts: Omit<SdkCaseRunnerOptions, "env" | "home"> & { env?: NodeJS.ProcessEnv; home?: string },
): CaseRunner {
  return sdkCaseRunnerOver({ ...opts, env: opts.env ?? process.env, home: opts.home ?? homedir() });
}

// ---- the scan driver's host ----------------------------------------------------

export interface ScanSdkCasesOptions {
  agentsDir: string;
  cwd: string;
  transcriptDir?: string;
  /** The driver's env: names the login source (`QCR_SCAN_AUTH_SRC`, else
   * `PI_CODING_AGENT_DIR`, else the home's pi agent dir) and feeds the leaf env. */
  env: NodeJS.ProcessEnv;
  /** A private, absolute directory for the host's own files (models list). Never
   * the operator's pi home. */
  agentDir: string;
  /** Hears an expired or missing login, so the run can stop with the fix. */
  onExpired: (reason: string) => void;
  /** The scan's route, once the driver resolved it (`scanRoute`): every
   * case's host is handed it, and a case's login is checked for its provider
   * alone. Asked per case. Omitted, or answering nothing: each case's host
   * resolves its own, from the login it is given. */
  route?: () => ModelRoute | undefined;
  /** The host a case runs on, built from its credentials. Omitted: a PiHost that
   * owns this process (the driver's) and installs pi's HTTP dispatcher. */
  makeHost?: (o: {
    agentDir: string;
    credentials: ReturnType<typeof engineCredentials>["credentials"];
    /** Where pi looks for a provider key: the driver's env. */
    authEnv: NodeJS.ProcessEnv;
    /** The scan's route as the host takes it; absent when the scan has none. */
    route?: NonNullable<PiHostOptions["route"]>;
  }) => Promise<PiHost>;
}

/**
 * The scan's route as a case's host takes it: fixed, so the host resolves
 * nothing of its own. A custom id (one pi's catalog does not hold) is handed
 * over as a pin instead: the host then makes pi's own model object for the
 * id, on the same catalog the route was resolved over.
 */
export function caseHostRoute(route: ModelRoute): NonNullable<PiHostOptions["route"]> {
  return route.custom ? { pin: { text: route.spec, from: "flag" } } : { fixed: route };
}

/** The provider key variables set in `env` (RUNTIME_KEY_ENVS). */
function envKeyNames(env: NodeJS.ProcessEnv): string[] {
  return Object.values(RUNTIME_KEY_ENVS).filter((name) => (env[name] ?? "").trim() !== "");
}

/** Why a host scan cannot start with neither a pi login nor an env key. */
export function hostScanAuthMissing(src: string): string {
  return (
    `no pi login at ${src} and no provider API key in the environment ` +
    `(${Object.values(RUNTIME_KEY_ENVS).join(", ")}) — run \`qcr login\`, or set the key`
  );
}

/** Where the borrowed login is read from: the scan container's read-only mount
 * of the companion's agent dir, else the process's own pi agent dir. */
export function scanAuthSource(env: NodeJS.ProcessEnv): string {
  return (
    env[SCAN_AUTH_SRC_ENV]?.trim() ||
    env["PI_CODING_AGENT_DIR"]?.trim() ||
    join(env["HOME"]?.trim() || homedir(), ".pi", "agent")
  );
}

/** How long a login must last for one case. In the scan container the
 * driver's login wrapper ends a case at the case budget; on the host nothing
 * does, so the login must cover the turn's whole wall clock. */
export function scanAuthWindowMs(env: NodeJS.ProcessEnv): number {
  return env[SCAN_AUTH_SRC_ENV]?.trim() ? SCAN_CASE_AUTH_BUDGET_MS : LEAF_TURN_TIMEOUT_MS;
}

// ---- the scan's route ------------------------------------------------------------

/** What `scanRoute` answers: plain data, so the scan image can print it and
 * the host can read it back. No value of any credential is in it. */
export interface ScanRouteAnswer {
  /** The route, or why there is none, under pi's display names. */
  result: RouteResult;
  /** Why there is no route, in words that name the fix. Absent with a route. */
  refusal?: string;
}

export interface ScanRouteOptions {
  /** The driver's env: names the login source (`scanAuthSource`) and is where
   * pi looks for a provider's key. */
  env: NodeJS.ProcessEnv;
  /** Where the route host's private agent dir is made and removed again. */
  tmpDir: string;
  /** `--model`, else the config's `[models] model` when it names a model. */
  pin?: RouteInput["pin"];
  /** The config that holds the pin, for a refusal that names it. */
  configPath?: string | null;
  /** Ask the person which provider runs the scan: the question and one row
   * per provider, the first being the one the order takes. Resolves the row's
   * index, or null when they gave no answer. Omitted or null: nobody to ask. */
  choose?: ((question: string, rows: readonly string[]) => Promise<number | null>) | null;
  /** Where a note about the choice is said. */
  say?: (line: string) => void;
  /** Runs once on each host's new model runtime: a test registers its provider here. */
  configureModels?: PiHostOptions["configureModels"];
  now?: () => number;
}

/** The rows of the provider question: the model each provider would run,
 * whose credential it is, and what is not known about its price. */
function providerRows(route: ModelRoute): string[] {
  const options = [route, ...route.alternatives];
  const width = Math.max(...options.map((x) => x.spec.length));
  return options.map((x) =>
    [
      x.spec.padEnd(width),
      `${x.providerName}, ${credentialWords(x.credential)}`,
      ...(x.priced ? [] : ["no list price"]),
    ].join("    "),
  );
}

/**
 * Why a scan has no route and what to do about it. The route's own words
 * (modelroute.ts `refusalText`) speak of a review; a scan says scan, and
 * names its own way into pi. In the scan sandbox the login is the
 * companion's, which only the companion's pi signs in and renews: a missing
 * or short login says so, in the words a refused case uses.
 */
export function scanRefusalWords(
  refusal: Extract<RouteResult, { ok: false }>["refusal"],
  o: {
    /** The agent dir the login was looked for in. */
    src: string;
    needMs: number;
    /** The login is the companion's, mounted read-only. */
    sandboxed: boolean;
    configPath?: string | null;
    nameOf?: (provider: string) => string;
    now?: () => number;
  },
): string {
  if (o.sandboxed && refusal.code === "no-credential")
    return scanAuthMissing(join(o.src, "auth.json"));
  if (o.sandboxed && refusal.code === "login-too-short" && refusal.logins[0] !== undefined)
    return scanAuthExpiring({
      provider: refusal.logins[0].name,
      expiresAt: refusal.logins[0].expiresAt,
      needMs: o.needMs,
    });
  const words = refusalText(refusal, "app", {
    agentDir: o.src,
    needMs: o.needMs,
    ...(o.configPath !== undefined ? { configPath: o.configPath } : {}),
    ...(o.nameOf ? { nameOf: o.nameOf } : {}),
    ...(o.now ? { now: o.now } : {}),
  })
    .replaceAll("Run the review inside pi (/qcr-review)", "Run the scan inside pi (/qcr-scan)")
    .replaceAll("this review", "this scan")
    .replaceAll("the review's", "the scan's");
  return o.sandboxed
    ? `${words} The scan sandbox reads the companion's login: \`qcr scan login\` signs it in.`
    : words;
}

/**
 * The model a scan over `env`'s login runs on, or why there is none. Nothing
 * is started and nothing is sent: a host is made over a private agent dir
 * (the login's catalog copied in), asked for its route, and removed.
 *
 * The login is borrowed for one case's window, since each case reads it
 * again: a login shorter than that is left out before the route is chosen,
 * as nothing here renews it. With `choose`, two providers that tie are asked
 * about once, and the answer is remembered beside the login.
 *
 * Throws when the login file is there and cannot be read: an unknown store is
 * never taken for an empty one.
 */
export async function scanRoute(o: ScanRouteOptions): Promise<ScanRouteAnswer> {
  const src = scanAuthSource(o.env);
  const needMs = scanAuthWindowMs(o.env);
  const remembered = readModelChoice(src);
  if (remembered.notice !== undefined) o.say?.(`note: ${remembered.notice}`);
  const borrowed = borrowedCredentials({
    srcDir: src,
    needMs,
    // Nothing renews the login for a scan: its owner is the pi that wrote it.
    owner: false,
    ...(o.now ? { now: o.now } : {}),
  });
  const saved = piSavedProvider(src);
  const resolve = async (
    choice: ModelChoice | undefined,
  ): Promise<{ result: RouteResult; nameOf: (provider: string) => string }> => {
    const made = await routeHost({
      srcAgentDir: src,
      tmpDir: o.tmpDir,
      credentials: borrowed.credentials,
      authEnv: o.env,
      route: {
        skipped: borrowed.skipped,
        ...(o.pin ? { pin: o.pin } : {}),
        ...(choice ? { choice } : {}),
        ...(saved !== undefined
          ? { piProvider: { provider: saved, from: "pi-settings" as const } }
          : {}),
      },
      ...(o.configureModels ? { configureModels: o.configureModels } : {}),
    });
    try {
      const result = await made.host.route();
      const names = new Map(made.host.modelRuntime.getProviders().map((p) => [p.id, p.name]));
      return { result, nameOf: (provider) => names.get(provider) ?? provider };
    } finally {
      made.dispose();
    }
  };

  let got = await resolve(remembered.choice);
  // Two providers tie and a person is here: ask once, remember the answer,
  // and resolve again with it.
  if (got.result.ok && got.result.route.ask && o.choose) {
    const options = [got.result.route, ...got.result.route.alternatives];
    const picked = await o.choose(
      "pi can run this scan on more than one provider:",
      providerRows(got.result.route),
    );
    const answer = picked === null ? undefined : options[picked];
    if (answer !== undefined) {
      const written = writeModelChoice(src, { provider: answer.provider, model: null, via: "ask" });
      // A choice that cannot be kept still holds for this plan.
      o.say?.(
        written.ok
          ? `Remembered: ${answer.providerName}. qcr model use <provider> changes it.`
          : written.error,
      );
      got = await resolve({
        provider: answer.provider,
        model: null,
        via: "ask",
        no_estimate_ok: remembered.noEstimateOk,
      });
    }
  }

  // The borrow reads a login file and knows no provider's name: pi's go in.
  const rename = (l: SkippedLogin): SkippedLogin => ({ ...l, name: got.nameOf(l.provider) });
  const { result } = got;
  if (!result.ok) {
    const refusal =
      result.refusal.code === "login-too-short"
        ? { ...result.refusal, logins: result.refusal.logins.map(rename) }
        : result.refusal;
    return {
      result: { ok: false, refusal },
      refusal: scanRefusalWords(refusal, {
        src,
        needMs,
        sandboxed: Boolean(o.env[SCAN_AUTH_SRC_ENV]?.trim()),
        configPath: o.configPath ?? null,
        nameOf: got.nameOf,
        ...(o.now ? { now: o.now } : {}),
      }),
    };
  }
  const said = new Map(borrowed.skipped.map((l) => [skippedNotice(l), skippedNotice(rename(l))]));
  return {
    result: {
      ok: true,
      route: { ...result.route, notices: result.route.notices.map((n) => said.get(n) ?? n) },
    },
  };
}

/**
 * The scan driver's SDK leaf runner: `sdkCaseRunner` over a host per case, each
 * on the login's refresh-blanked in-memory copy (engineCredentials). A login
 * that is missing or would expire inside the case stops the run through
 * `onExpired`, and the case is refused having spent nothing.
 */
export function scanSdkCases(o: ScanSdkCasesOptions): CaseRunner {
  if (!isAbsolute(o.agentDir))
    throw new Error(`the SDK host's agentDir must be absolute: ${o.agentDir}`);
  return sdkCaseRunner({
    agentsDir: o.agentsDir,
    home: homedir(),
    cwd: o.cwd,
    ...(o.transcriptDir !== undefined ? { transcriptDir: o.transcriptDir } : {}),
    env: o.env,
    runtime: async (extras) => {
      const src = scanAuthSource(o.env);
      const onHost = !o.env[SCAN_AUTH_SRC_ENV]?.trim();
      const keyOnly = onHost && !existsSync(join(src, "auth.json"));
      // The scan's one route, when its driver resolved one.
      const route = o.route?.();
      let auth: Pick<ReturnType<typeof engineCredentials>, "credentials">;
      try {
        if (keyOnly && envKeyNames(o.env).length === 0)
          throw new AuthExpiring(hostScanAuthMissing(join(src, "auth.json")), { code: "missing" });
        auth = keyOnly
          ? { credentials: keyOnlyCredentials() }
          : engineCredentials({
              srcDir: src,
              needMs: scanAuthWindowMs(o.env),
              words: { missing: scanAuthMissing, expiring: scanAuthExpiring },
              // With a route the case runs on one provider: only its login
              // has to last the case.
              ...(route !== undefined ? { providers: [route.provider] } : {}),
            });
      } catch (err) {
        if (err instanceof AuthExpiring) o.onExpired(err.message);
        throw err;
      }
      mkdirSync(o.agentDir, { recursive: true, mode: 0o700 });
      // pi's catalog lives next to the login (the person's own providers, and
      // the models pi learned since its build): the host reads its own copy,
      // the same one the route was resolved over.
      copyCatalogFiles(src, o.agentDir);
      const hostRoute = route !== undefined ? { route: caseHostRoute(route) } : {};
      const host = await (o.makeHost
        ? o.makeHost({
            agentDir: o.agentDir,
            credentials: auth.credentials,
            authEnv: o.env,
            ...hostRoute,
          })
        : PiHost.create({
            agentDir: o.agentDir,
            ownsProcess: true,
            homeDir: homedir(),
            credentials: auth.credentials,
            authEnv: o.env,
            ...hostRoute,
          }));
      // The case driver owns its process: a turn its abort and dispose did not
      // end exits it (packages/pi-plugin/src/engine/budget.ts).
      return sdkRuntime(host, { extras, backstop: () => process.exit(BUDGET_EXIT_CODE) });
    },
  });
}
