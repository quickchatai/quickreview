// The runtime `qcr review` hosts its main session on when `[engine] runtime =
// "sdk"`: the round's session as an in-process SDK session, with the pieces the
// `pi` child gets as files handed over as data (src/engine/roundsdk.ts).
//
// The route prepares a private agent dir for the run (src/hostroute.ts
// prepareHostRun: a refresh-blanked copy of the owner's login, the model list,
// settings.json), and the round's spec names it (`PI_CODING_AGENT_DIR`). This
// runtime builds its host on that dir when the first session is asked for:
//
//   login        read from the dir's auth.json by engineCredentials (D5): an
//                in-memory, read-only copy, refused up front when the token would
//                expire inside the turn. An API key in the spec's env (the key
//                route) is given to the runtime in memory.
//   settings     the dir's settings.json supplies what the process route's pi
//                reads from it: the durable retry and the HTTP idle timeout.
//   dispatcher   pi's HTTP dispatcher is installed (D4): `qcr review` owns its
//                process.
//   lens tool    today's native one (`subagent`, `launch_plan`), loaded as a
//                factory. It spawns its lens passes as `pi` children that read
//                the process env, so for the sessions' life the process env
//                carries the round's QCR_* names and PI_CODING_AGENT_DIR, and
//                no GitHub token (a lens child runs the model's bash, rule 3).
//                The engine's own tools (`lens`, `lens_wave`: engineLensTools,
//                src/engine/lens/engine-tools.ts) take this slot through the
//                `lens` option, or, with the `engine` option (`[pi] lens_runtime
//                = engine`), over a runner this module builds on the host: the
//                passes are SDK sessions of this process, not `pi` children.
//                The runtime then carries the round's `engineLens` (wave.ts), which
//                the round reads: its board and runner, and whether the engine starts
//                the planned wave (`[pi] engine_wave`).
//
// Stopping: every session is in the live registry (livesessions.ts), which the
// detached driver's signal handler aborts and disposes before it exits.
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { lensRunConfigFromEnv } from "../../extensions/lens.js";
import subagents from "../../extensions/subagents.js";
import { CONTEXT_PACK_FILE } from "../contextpack.js";
import { GITHUB_TOKEN_ENVS } from "../envstrip.js";
import { agentDirSettings } from "./agentdir.js";
import { applyEnvApiKeys, engineCredentials, type EngineAuth } from "./auth.js";
import { engineLensTools, type EngineLensTools } from "./lens/engine-tools.js";
import type { LensRunConfig } from "./lens/runlens.js";
import { LensWave, type EngineRoute, type EngineRouteRuntime } from "./lens/wave.js";
import { PiHost, type PiHostOptions } from "./pisdk.js";
import { loginSourceDirs } from "./toolfence.js";
import { checkToolUid, toolIdsOf } from "./tooluid.js";
import type { Runtime, RuntimeSession, SessionSpec } from "./port.js";
import { BASH_ENV_ALLOW, reviewerStub, roundSdkExtras, type RoundLensTools } from "./roundsdk.js";
import { releasing } from "./sessionwrap.js";
import { sdkRuntime, type SessionExtras } from "./sdkruntime.js";

export interface ReviewSdkOptions {
  /** Builds the host. Omitted: a PiHost that owns this process (installs pi's
   * HTTP dispatcher) over the run's private agent dir. */
  makeHost?: (o: PiHostOptions) => Promise<PiHost>;
  /** The round's lens tool, given the spec it serves and the host its passes
   * run on. Omitted: today's native one (see the header). */
  lens?: (spec: SessionSpec, host: PiHost) => RoundLensTools;
  /** The process env the native lens tool's children inherit. Omitted:
   * `process.env`. */
  processEnv?: NodeJS.ProcessEnv;
  /** Names of the spec's env, besides the QCR_* names and the agent dir, that
   * the process env carries for the native lens tool's children (the bench: its
   * spill dir and git isolation). */
  childEnv?: (name: string) => boolean;
  /** Replaces the round's extras (the extension factories, tool allowlist and
   * context stub of a main session) for a session that is not a round's, such
   * as the defect judge's. Such a session has no native lens children, so the
   * process env is left alone. */
  extras?: (spec: SessionSpec) => SessionExtras;
  /** `[pi] lens_runtime = engine`: the round's lens tools are ours (`lens`,
   * `lens_wave`), their passes SDK sessions on the session's host. `wave` is the
   * round's board (given, so a route can name it before the host exists);
   * `plannedWave` is `[pi] engine_wave`. Takes the `lens` slot. */
  engine?: { wave?: LensWave; plannedWave: boolean };
}

/** The review SDK runtime: a runtime, carrying the engine route when it has one. */
export type ReviewSdkRuntime = EngineRouteRuntime;

/** The lens runner's config on the review route's host: the passes read the agent
 * dir's agents, carry the reviewer stub (D34) and the same bash env allowlist as
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

/** The native lens tool as a factory. */
function nativeLens(): RoundLensTools {
  return {
    factories: [subagents],
    toolNames: ["subagent", "launch_plan"],
  };
}

/** Puts the round's env where the native lens tool and its children read it, and
 * takes the GitHub tokens out; returns the undo. */
function scopeProcessEnv(
  target: NodeJS.ProcessEnv,
  spec: SessionSpec,
  extra?: (name: string) => boolean,
): { restore: () => void } {
  const saved = new Map<string, string | undefined>();
  const set = (name: string, value: string | undefined): void => {
    if (!saved.has(name)) saved.set(name, target[name]);
    if (value === undefined) delete target[name];
    else target[name] = value;
  };
  for (const [name, value] of Object.entries(spec.env))
    if (
      (name.startsWith("QCR_") || name === AGENT_DIR_ENV || extra?.(name) === true) &&
      value !== undefined
    )
      set(name, value);
  for (const name of GITHUB_TOKEN_ENVS) set(name, undefined);
  return {
    restore: () => {
      for (const [name, value] of saved) {
        if (value === undefined) delete target[name];
        else target[name] = value;
      }
    },
  };
}

/**
 * The review route's SDK runtime. One host per agent dir, built lazily at the
 * first session; no session, no host, no network and no env change.
 */
export function reviewSdkRuntime(options: ReviewSdkOptions = {}): ReviewSdkRuntime {
  const procEnv = options.processEnv ?? process.env;
  const hosts = new Map<string, Promise<Runtime>>();
  const engine = options.engine;
  const wave = engine?.wave ?? new LensWave();
  // The tools of the host built last: one agent dir per review, so one.
  let lens: EngineLensTools | undefined;

  function runtimeFor(spec: SessionSpec): Promise<Runtime> {
    const agentDir = spec.env[AGENT_DIR_ENV];
    if (agentDir === undefined || !isAbsolute(agentDir))
      return Promise.reject(
        new Error(`the review's spec names no absolute ${AGENT_DIR_ENV}: ${String(agentDir)}`),
      );
    let built = hosts.get(agentDir);
    if (built === undefined) {
      built = (async (): Promise<Runtime> => {
        const auth: EngineAuth = engineCredentials({
          srcDir: agentDir,
          needMs: spec.limits.timeoutMs,
        });
        const ids = toolIdsOf(procEnv);
        const hostOptions: PiHostOptions = {
          agentDir,
          ownsProcess: true,
          // The model's bash and every lens session's, as the tool uid (D32).
          ...(ids !== null && !("refused" in ids) ? { toolUid: ids } : {}),
          // The round's agent dir is a copy: the login it was copied from (the
          // wrapper's /qcr-login, group-readable by this uid) is fenced too.
          fenceDirs: loginSourceDirs(procEnv),
          credentials: auth.credentials,
          settings: agentDirSettings(agentDir),
          configureModels: async (runtime) => {
            await applyEnvApiKeys(runtime, spec.env);
          },
        };
        const host = await (options.makeHost ?? PiHost.create)(hostOptions);
        const tools = engine ? engineLensTools(engineLensConfig(host, spec), wave) : undefined;
        if (tools) lens = tools;
        return sdkRuntime(host, {
          extras:
            options.extras ??
            ((s) =>
              roundSdkExtras({
                lens: tools ?? (options.lens ? options.lens(s, host) : nativeLens()),
              })(s)),
        });
      })();
      // A host that failed to build is not kept: the next ask tries again.
      built.catch(() => hosts.delete(agentDir));
      hosts.set(agentDir, built);
    }
    return built;
  }

  async function open(
    spec: SessionSpec,
    start: (rt: Runtime) => Promise<RuntimeSession>,
  ): Promise<RuntimeSession> {
    // The native lens tool runs its passes as `pi` children of this process,
    // and their bash would share its uid: that asks for the shared uid. Every
    // other session is ours and runs its tools as the tool uid.
    const native = options.lens === undefined && options.extras === undefined && !engine;
    checkToolUid(
      procEnv,
      native
        ? {
            what: "the SDK runtime with the native lens tool",
            instead: "set [pi] lens_runtime = engine, or use [engine] runtime = proc here",
          }
        : { what: "the SDK runtime", instead: "", isolated: true },
    );
    const rt = await runtimeFor(spec);
    // Before the session: the native lens factory reads the env as the session
    // is made. A route that hands its own lens tool has no such children.
    const scoped = native ? scopeProcessEnv(procEnv, spec, options.childEnv) : null;
    try {
      const session = await start(rt);
      return scoped === null ? session : releasing(session, scoped.restore);
    } catch (e) {
      scoped?.restore();
      throw e;
    }
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
    ...(route ? { engineLens: route } : {}),
  };
}
