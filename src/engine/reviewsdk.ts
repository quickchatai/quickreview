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
//                The engine's own lens tool (P4.5) takes this slot.
//
// Stopping: every session is in the live registry (livesessions.ts), which the
// detached driver's signal handler aborts and disposes before it exits.
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import subagents from "../../extensions/subagents.js";
import { GITHUB_TOKEN_ENVS } from "../envstrip.js";
import { applyEnvApiKeys, engineCredentials, type EngineAuth } from "./auth.js";
import { PiHost, type PiHostOptions } from "./pisdk.js";
import type { Runtime, RuntimeSession, SessionSpec } from "./port.js";
import { roundSdkExtras, type RoundLensTools } from "./roundsdk.js";
import { sdkRuntime } from "./sdkruntime.js";

export interface ReviewSdkOptions {
  /** Builds the host. Omitted: a PiHost that owns this process (installs pi's
   * HTTP dispatcher) over the run's private agent dir. */
  makeHost?: (o: PiHostOptions) => Promise<PiHost>;
  /** The round's lens tool, given the spec it serves. Omitted: today's native
   * one (see the header). */
  lens?: (spec: SessionSpec) => RoundLensTools;
  /** The process env the native lens tool's children inherit. Omitted:
   * `process.env`. */
  processEnv?: NodeJS.ProcessEnv;
}

/** `SessionSpec.env` names this dir: the run's private pi agent dir. */
const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

/** The names the image's entrypoint sets when the model's tools must run as
 * another uid than this process (procruntime.ts `toolIsolation`, D32). */
const TOOL_UID_ENVS = ["QCR_TOOL_UID", "QCR_TOOL_GID", "QCR_TOOL_UID_REQUIRED"] as const;

/** The SDK host runs the model's bash in this process, as this process's uid, so
 * it cannot give the tools the separate uid the image asks for. It refuses
 * rather than run without it, unless the shared uid is accepted. */
function checkToolUid(env: NodeJS.ProcessEnv): void {
  if (env["QCR_ALLOW_SHARED_TOOL_UID"] === "1") return;
  if (TOOL_UID_ENVS.some((n) => env[n]))
    throw new Error(
      "the SDK runtime runs the model's tools in this process, so it cannot run them as another uid, " +
        "which this container asks for: use [engine] runtime = proc here, or set " +
        "QCR_ALLOW_SHARED_TOOL_UID=1 to accept the shared uid",
    );
}

/** What the process route's pi reads from the agent dir's settings.json and an
 * SDK host must be given instead (it takes in-memory settings only). */
function agentDirSettings(agentDir: string): PiHostOptions["settings"] {
  try {
    const s = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as Record<
      string,
      unknown
    >;
    return {
      ...(s["retry"] !== undefined ? { retry: s["retry"] } : {}),
      ...(typeof s["httpIdleTimeoutMs"] === "number"
        ? { httpIdleTimeoutMs: s["httpIdleTimeoutMs"] }
        : {}),
    } as PiHostOptions["settings"];
  } catch {
    return {};
  }
}

/** The native lens tool as a factory. */
function nativeLens(): RoundLensTools {
  return {
    factories: [subagents],
    toolNames: ["subagent", "launch_plan"],
  };
}

/** Puts the round's env where the native lens tool and its children read it, and
 * takes the GitHub tokens out; returns the undo. */
function scopeProcessEnv(target: NodeJS.ProcessEnv, spec: SessionSpec): { restore: () => void } {
  const saved = new Map<string, string | undefined>();
  const set = (name: string, value: string | undefined): void => {
    if (!saved.has(name)) saved.set(name, target[name]);
    if (value === undefined) delete target[name];
    else target[name] = value;
  };
  for (const [name, value] of Object.entries(spec.env))
    if ((name.startsWith("QCR_") || name === AGENT_DIR_ENV) && value !== undefined)
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

/** A session that runs `after` once, when it is disposed. */
function releasing(session: RuntimeSession, after: () => void): RuntimeSession {
  return {
    get id() {
      return session.id;
    },
    get sessionFile() {
      return session.sessionFile;
    },
    prompt: (text, options) => session.prompt(text, options),
    followUp: (text, options) => session.followUp(text, options),
    steer: (text) => session.steer(text),
    abort: () => session.abort(),
    subscribe: (listener) => session.subscribe(listener),
    stats: () => session.stats(),
    dispose: async () => {
      try {
        await session.dispose();
      } finally {
        after();
      }
    },
  };
}

/**
 * The review route's SDK runtime. One host per agent dir, built lazily at the
 * first session; no session, no host, no network and no env change.
 */
export function reviewSdkRuntime(options: ReviewSdkOptions = {}): Runtime {
  const procEnv = options.processEnv ?? process.env;
  const hosts = new Map<string, Promise<Runtime>>();

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
        const hostOptions: PiHostOptions = {
          agentDir,
          ownsProcess: true,
          credentials: auth.credentials,
          settings: agentDirSettings(agentDir),
          configureModels: async (runtime) => {
            await applyEnvApiKeys(runtime, spec.env);
          },
        };
        const host = await (options.makeHost ?? PiHost.create)(hostOptions);
        return sdkRuntime(host, {
          extras: (s) => roundSdkExtras({ lens: (options.lens ?? nativeLens)(s) })(s),
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
    checkToolUid(procEnv);
    const rt = await runtimeFor(spec);
    // Before the session: the native lens factory reads the env as the session
    // is made. A route that hands its own lens tool has no such children.
    const scoped = options.lens === undefined ? scopeProcessEnv(procEnv, spec) : null;
    try {
      const session = await start(rt);
      return scoped === null ? session : releasing(session, scoped.restore);
    } catch (e) {
      scoped?.restore();
      throw e;
    }
  }

  return {
    create: (spec) => open(spec, (rt) => rt.create(spec)),
    resume: (file, spec) => open(spec, (rt) => rt.resume(file, spec)),
  };
}
