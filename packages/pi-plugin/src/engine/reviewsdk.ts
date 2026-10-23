// The runtime `qcr review` hosts its main session on when `[engine] runtime =
// "sdk"`: the round's session as an in-process SDK session, with the pieces the
// `pi` child gets as files handed over as data (packages/pi-plugin/src/engine/roundsdk.ts).
//
// The route prepares a private agent dir for the run (src/hostroute.ts
// prepareHostRun: a refresh-blanked copy of the owner's login, the model list,
// settings.json), and the round's spec names it (`PI_CODING_AGENT_DIR`). This
// runtime builds its host on that dir when the first session is asked for:
//
//   login        read from the dir's auth.json by engineCredentials: an
//                in-memory, read-only copy, refused up front when the token would
//                expire inside the turn. An API key in the spec's env (the key
//                route) is given to the runtime in memory.
//   settings     the dir's settings.json supplies what the process route's pi
//                reads from it: the durable retry and the HTTP idle timeout.
//   dispatcher   pi's HTTP dispatcher is installed when the route owns its
//                process (`qcr review`); inside a running pi (the plugin's
//                /review, `hostPi`) pi's own is reused.
//   lens tool    the engine's own (`lens`, `lens_wave`: engineLensTools,
//                packages/pi-plugin/src/engine/lens/engine-tools.ts), through the `lens` option, or,
//                with the `engine` option, over a runner this module builds on
//                the host: the passes are SDK sessions of this process, not `pi`
//                children, so the process env is never changed. A route that
//                hands neither has no lens tool and gets no session. The
//                `engine` option carries the round's `engineLens` (wave.ts),
//                which the round reads: its board and runner, and whether the
//                engine starts the planned wave (`[pi] engine_wave`).
//
// Stopping: every session is in the live registry (livesessions.ts), which the
// detached driver's signal handler aborts and disposes before it exits.
//
// One runtime hosts one review at a time: its lens board and its lens runner
// are the run's (the round clears the board when it starts), so a caller that
// runs reviews side by side builds a runtime per run (packages/pi-plugin/src/reviewapi.ts asks
// for one per run) and disposes it after.
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { lensRunConfigFromEnv } from "../../extensions/lens.js";
import { CONTEXT_PACK_FILE } from "../contextpack.js";
import { agentDirSettings } from "./agentdir.js";
import { applyEnvApiKeys, engineCredentials, type EngineAuth } from "./auth.js";
import { engineLensTools, type EngineLensTools } from "./lens/engine-tools.js";
import type { LensRunConfig } from "./lens/runlens.js";
import { LensWave, type EngineRoute, type EngineRouteRuntime } from "./lens/wave.js";
import { PiHost, type PiHostOptions } from "./pisdk.js";
import { credentialPaths, loginSourceDirs } from "./toolfence.js";
import { checkToolUid, toolIdsOf } from "./tooluid.js";
import type { BudgetReason } from "./budget.js";
import type { Runtime, RuntimeSession, SessionSpec } from "./port.js";
import { BASH_ENV_ALLOW, reviewerStub, roundSdkExtras, type RoundLensTools } from "./roundsdk.js";
import { sdkRuntime, type SessionExtras } from "./sdkruntime.js";

export interface ReviewSdkOptions {
  /** Builds the host. Omitted: a PiHost over the run's private agent dir, which
   * owns this process (installs pi's HTTP dispatcher) unless `ownsProcess` or
   * `hostPi` says otherwise. */
  makeHost?: (o: PiHostOptions) => Promise<PiHost>;
  /** The round's lens tool, given the spec it serves and the host its passes
   * run on. Omitted: the `engine` option's (or `extras`'). */
  lens?: (spec: SessionSpec, host: PiHost) => RoundLensTools;
  /** The process env the tool uid split is read from. Omitted: `process.env`. */
  processEnv?: NodeJS.ProcessEnv;
  /** Replaces the round's extras (the extension factories, tool allowlist and
   * context stub of a main session) for a session that is not a round's, such
   * as the defect judge's. */
  extras?: (spec: SessionSpec) => SessionExtras;
  /** `[pi] lens_runtime = engine`: the round's lens tools are ours (`lens`,
   * `lens_wave`), their passes SDK sessions on the session's host. `wave` is the
   * round's board (given, so a route can name it before the host exists);
   * `plannedWave` is `[pi] engine_wave`. Takes the `lens` slot. `config` builds
   * the passes' runner config (default `engineLensConfig`): the bench keeps its
   * agents elsewhere. */
  engine?: {
    wave?: LensWave;
    plannedWave: boolean;
    config?: (host: PiHost, spec: SessionSpec) => LensRunConfig;
  };
  /** The last resort of a turn its abort and dispose did not end
   * (packages/pi-plugin/src/engine/budget.ts). `qcr review` and the bench own their process and
   * pass one that exits it. Omitted: the process is left to its owner. */
  backstop?: (reason: BudgetReason) => void;
  /** Where the round's diagnostics go, one line each: a lens runner's warnings
   * (`[lens] …`, unless its config has a `warn` of its own) and ledger-pin's.
   * Omitted: nowhere. */
  warn?: (line: string) => void;
  /** The user's home, resolved by the host: the tool fence keeps its `.pi` out
   * and expands a tool's `~` against it (PiHostOptions.homeDir). */
  homeDir?: string;
  /** The route owns this process (`qcr review`, the bench): PiHost may install
   * pi's HTTP dispatcher. Default true. */
  ownsProcess?: boolean;
  /** The runtime is built by an extension of the running pi (the pi plugin's
   * /review): PiHostOptions.hostPi. Implies `ownsProcess: false`. */
  hostPi?: boolean;
  /** The stretch at the end of a login's life the run refuses on top of its
   * time budget (`checkAuth`'s margin). Default pi's own refresh margin. A
   * host whose pi refreshed the login for this run's whole window just before
   * it (the plugin's borrowed login) passes 0. */
  authMarginMs?: number;
  /** Paths the tool fence keeps out beside the defaults: where the host's own
   * login lives when no env names it (the plugin's host pi agent dir). */
  fenceDirs?: readonly string[];
}

/** The review SDK runtime: a runtime, carrying the engine route when it has one.
 * `dispose` releases every host it built (their sessions and in-memory logins);
 * a later session builds a host again. */
export type ReviewSdkRuntime = EngineRouteRuntime & { dispose(): Promise<void> };

/** The lens runner's config on the review route's host: the passes read the agent
 * dir's agents, carry the reviewer stub and the same bash env allowlist as
 * the main session, and (with a context pack beside the round's ledger) warm
 * their cache groups with it. */
export function engineLensConfig(host: PiHost, spec: SessionSpec): LensRunConfig {
  const base = lensRunConfigFromEnv(spec.env, host, spec.cwd);
  const root = spec.env["QCR_SANDBOX_ROOT"];
  if (root === undefined)
    throw new Error("a round's spec names its production tree (QCR_SANDBOX_ROOT)");
  const ledger = spec.env["QCR_LEDGER_FILE"];
  const packPath = ledger === undefined ? undefined : join(dirname(ledger), CONTEXT_PACK_FILE);
  const pack = packPath !== undefined && existsSync(packPath) ? readFileSync(packPath, "utf8") : "";
  return {
    ...base,
    agentsFiles: [reviewerStub(root, spec.cwd)],
    bashEnv: { allow: BASH_ENV_ALLOW },
    ...(base.cache && pack ? { cache: { ...base.cache, pack } } : {}),
  };
}

/** `SessionSpec.env` names this dir: the run's private pi agent dir. */
const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

/**
 * The review route's SDK runtime. One host per agent dir, built lazily at the
 * first session; no session, no host, no network and no env change.
 */
export function reviewSdkRuntime(options: ReviewSdkOptions = {}): ReviewSdkRuntime {
  const procEnv = options.processEnv ?? process.env;
  const hosts = new Map<string, Promise<{ rt: Runtime; host: PiHost }>>();
  const engine = options.engine;
  const wave = engine?.wave ?? new LensWave();
  // The tools of the host built last: one agent dir per review, so one.
  let lens: EngineLensTools | undefined;

  /** The runner's config with the host's warn sink, unless it has its own. */
  function withWarn(config: LensRunConfig): LensRunConfig {
    const warn = options.warn;
    return config.warn || !warn ? config : { ...config, warn: (m) => warn(`[lens] ${m}`) };
  }

  function lensOf(spec: SessionSpec, host: PiHost): RoundLensTools {
    if (options.lens === undefined)
      throw new Error("the review runtime has no lens tool: pass `engine`, `lens` or `extras`");
    return options.lens(spec, host);
  }

  async function runtimeFor(spec: SessionSpec): Promise<Runtime> {
    const agentDir = spec.env[AGENT_DIR_ENV];
    if (agentDir === undefined || !isAbsolute(agentDir))
      throw new Error(`the review's spec names no absolute ${AGENT_DIR_ENV}: ${String(agentDir)}`);
    let built = hosts.get(agentDir);
    if (built === undefined) {
      built = (async (): Promise<{ rt: Runtime; host: PiHost }> => {
        const auth: EngineAuth = engineCredentials({
          srcDir: agentDir,
          needMs: spec.limits.timeoutMs,
          ...(options.authMarginMs !== undefined ? { marginMs: options.authMarginMs } : {}),
        });
        const ids = toolIdsOf(procEnv);
        const hostPi = options.hostPi === true;
        const hostOptions: PiHostOptions = {
          agentDir,
          ownsProcess: !hostPi && options.ownsProcess !== false,
          ...(hostPi ? { hostPi: true } : {}),
          ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
          // The model's bash and every lens session's, as the tool uid.
          ...(ids !== null && !("refused" in ids) ? { toolUid: ids } : {}),
          // The round's agent dir is a copy: the login it was copied from (the
          // wrapper's /qcr-login, group-readable by this uid) is fenced too.
          fenceDirs: [
            ...loginSourceDirs(procEnv),
            ...credentialPaths(procEnv, spec.env),
            ...(options.fenceDirs ?? []),
          ],
          credentials: auth.credentials,
          settings: agentDirSettings(agentDir),
          configureModels: async (runtime) => {
            await applyEnvApiKeys(runtime, spec.env);
          },
        };
        const host = await (options.makeHost ?? PiHost.create)(hostOptions);
        const tools = engine
          ? engineLensTools(withWarn((engine.config ?? engineLensConfig)(host, spec)), wave)
          : undefined;
        if (tools) lens = tools;
        const rt = sdkRuntime(host, {
          extras:
            options.extras ??
            ((s) =>
              roundSdkExtras({
                lens: tools ?? lensOf(s, host),
                ...(options.warn ? { log: options.warn } : {}),
              })(s)),
          ...(options.backstop ? { backstop: options.backstop } : {}),
        });
        return { rt, host };
      })();
      // A host that failed to build is not kept: the next ask tries again.
      built.catch(() => hosts.delete(agentDir));
      hosts.set(agentDir, built);
    }
    return (await built).rt;
  }

  async function dispose(): Promise<void> {
    const all = [...hosts.values()];
    hosts.clear();
    lens = undefined;
    for (const b of await Promise.allSettled(all))
      if (b.status === "fulfilled") b.value.host.dispose();
  }

  async function open(
    spec: SessionSpec,
    start: (rt: Runtime) => Promise<RuntimeSession>,
  ): Promise<RuntimeSession> {
    // Every session is ours and runs its tools as the tool uid.
    checkToolUid(procEnv, { what: "the SDK runtime", instead: "", isolated: true });
    const rt = await runtimeFor(spec);
    return start(rt);
  }

  const route: EngineRoute | undefined = engine && {
    wave,
    // Built with the host, which the round's session has by the time it launches.
    runner: {
      run: (request) => {
        if (lens === undefined)
          return Promise.reject(new Error("the lens runner is not built: no session was created"));
        return lens.runner.run(request);
      },
    },
    plannedWave: engine.plannedWave,
  };
  return {
    create: (spec) => open(spec, (rt) => rt.create(spec)),
    resume: (file, spec) => open(spec, (rt) => rt.resume(file, spec)),
    dispose,
    ...(route ? { engineLens: route } : {}),
  };
}
