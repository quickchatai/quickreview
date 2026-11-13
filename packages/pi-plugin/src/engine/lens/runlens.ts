// runLens: one lens pass as an in-process SDK session, the engine's replacement
// for a native `subagent` child process.
//
// What a pass is, by construction:
//   - A leaf. It gets the tools its agent file lists, the bash-guard factory
//     and the leaf tools of its family (config.leafTools: `state_explore` for
//     a state-machine family variant whose allowlist names it, nothing for any
//     other lens), and never a lens tool: the runner hands the host no
//     customTools and refuses an agent file that names one (include.ts checks
//     the same at build time). The runner cannot be asked to nest.
//   - Capped. A Permits port bounds the passes in flight: one WeightedSemaphore
//     per PiHost on a one-shot route, the daemon's central broker in a bot worker
//    . A pass holds its permit from before its session exists until the
//     session is read and disposed, retry included.
//   - Isolated. The session comes from PiHost.makeSession (the fence: no
//     other module builds an SDK session), in memory unless `sessionsDir` keeps
//     its JSONL, under an id of its own, so
//     disposing one pass never cuts a sibling's provider socket (canary 1).
//     Its system prompt is pi's base plus the agent's body appended, and the
//     context files ride as data; the pass reads the same bytes a native child
//     reads (tests/lens-prompt-parity.test.ts).
//   - Cache-grouped, when asked (config.cache). The passes of one group, per
//     model and tool list (cacheGroupKey: the request's `tools` field is part
//     of the cached prefix), share ONE session id, which is what routes their requests to one
//     provider cache. Disposing a session closes the transports held for its id,
//     so a grouped session is kept until the group's last pass is done and the
//     group is disposed together (cache-run.ts): one pass finishing never ends
//     a sibling's stream. That much holds on every API.
//   - Packed, where the API is the one the pack is built for. With a context
//     pack, a group whose model speaks an API of the pack-first family
//     (leaf-cache.ts PACK_FIRST_APIS, read off the model's `api`, never off a
//     provider or a model name) is packed: its first pass starts a warm-up (no
//     permit, the pack and "reply OK") that every pass of the group waits for,
//     at most 30 s, and every request is rewritten pack-first. Any other group,
//     and every group of a round with no pack, is not: no warm-up, no wait, no
//     rewrite; its later passes start after a stagger, and a lens reads the
//     pack file its task names.
//   - Staggered. Sessions are created sessionGapMs apart, per host: building a
//     wave at once blocks the event loop for seconds (docs/cpu-gate.md, finding 4).
//   - Bounded in time. With a deadline, an attempt the timer ends is aborted and
//     retried once on a FRESH session; a second timeout answers timedOut.
//   - On the host's route, unless its agent names a model. An agent file with
//     no `model:` (an unpinned tier's) runs on the model the host resolved for
//     the run (PiHost.route): asked once per runner, that model's spec keys the
//     pass's cache group (with its tools) and is the model it reports, and the
//     session is made with no model of its own. A host with no route fails the
//     pass with the reason.
//   - Never fatal. runLens does not reject. A host that cannot build the
//     session, an extension that throws, a provider that fails, a caller's
//     abort: each is a failed LensResult, with the spend so far in its usage,
//     one ledger line and a pass_end in the progress log.
//
// The task is sent the way the native child sends it: `Task: <task>`.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { moveToCredentialed, refusalText, splitProvider } from "../../modelroute.js";
import { THINKING_LEVELS } from "../../reviewconfig.js";
import type {
  AgentSession,
  ExtensionError,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import {
  isLensTool,
  ledgerLineOf,
  serializeLedgerLine,
  type LensMessage,
  type LensResult,
  type LensUsage,
} from "../../lensresult.js";
import {
  appendProgressLog,
  type LiveAgentStatus,
  type ProgressTransition,
} from "../../round-progress.js";
import type { LiveSink } from "../../live/writer.js";
import type { BashEnvOptions, HostSessionSpec, PiHost } from "../pisdk.js";
import type { AgentsFile } from "../port.js";
import {
  CacheGroups,
  WARMUP_REPLY_TASK,
  cacheGroupKey,
  WARMUP_WAIT_MS,
  delay,
  settledWithin,
  type CacheLease,
} from "./cache-run.js";
import { LensActivityTracker, type LensActivity } from "./activity.js";
import { ProviderRetryWatch, passTimeoutMessage, runUnderDeadline } from "./deadline.js";
import { isPackFirstApi, leafCache } from "./leaf-cache.js";
import type { AgentRegistry, LensAgent } from "./registry.js";
import { localPermits, type Permit, type Permits } from "./permits.js";
import { WeightedSemaphore } from "./semaphore.js";

/** Where a round's lifecycle events go: the `pr-<n>.jsonl` transition log the
 * round-progress extension writes on the tmux route, here written by the engine
 * through the same writer and line shape. */
export interface LensProgressSink {
  /** The transition log, `state/round-progress/pr-<n>.jsonl`. */
  logPath: string;
  pr: number;
  session: string;
  /** ISO time the run (the round's main session) started. */
  runStartedAt: string;
  commandId?: string;
}

/** Lens cache groups. */
export interface LensCacheConfig {
  /** Passes per group, per model and tool list; below 1 there are no groups. */
  size: number;
  /** How long the later passes of a group that is not packed start after its first. */
  staggerMs: number;
  /** The round's context pack text. Present: each group whose model speaks an
   * API of the pack-first family (leaf-cache.ts PACK_FIRST_APIS) is warmed
   * with it and its requests are rewritten pack-first. Absent, or a group on
   * any other API: the stagger applies and nothing is rewritten. */
  pack?: string;
  /** How long a pass waits for its packed group's warm-up. Default 30 s. */
  warmupWaitMs?: number;
}

/** Gap between session creations on one host. Creating a wave at once blocks
 * the loop for seconds (0.7 to 2.5 s for 8 to 20 sessions). */
export const DEFAULT_SESSION_GAP_MS = 25;

export interface LensRunConfig {
  host: PiHost;
  /** The cap on passes in flight for this host. The first runner on a host sets
   * it; a later runner on the same host must ask for the same number. Unused when
   * `permitPort` is given. */
  permits: number;
  /** Where a pass gets its permit. Omitted: the host's local semaphore, sized by
   * `permits`. A bot worker passes the daemon's broker client. */
  permitPort?: Permits;
  registry: AgentRegistry;
  /** The passes' working directory (also their bash tool's). */
  cwd: string;
  /** The environment the model's bash may draw from. */
  env: Readonly<Record<string, string | undefined>>;
  /** The bash-guard factory, attached to every pass. Required: there is no
   * lens without it. */
  bashGuard: ExtensionFactory;
  /** The extension factories that give `agent`'s session its leaf tools,
   * attached after the bash guard to the agent's passes and to a warm-up its
   * pass starts. Required, as the guard is, so a route that forgets it does
   * not typecheck; a route with none says `() => []`. Each call returns fresh
   * factories: a tool's per-session state is never shared between passes. */
  leafTools: (agent: LensAgent) => ExtensionFactory[];
  /** Append-only `lens-ledger.jsonl`; one line per pass. */
  ledgerPath: string;
  /** context files. Omitted: the host's. */
  agentsFiles?: readonly AgentsFile[];
  bashEnv?: BashEnvOptions;
  /** `provider/id` for an agent file that names no model. Omitted: such an
   * agent runs on the host's route. */
  defaultModel?: string;
  /** Per-attempt deadline. Omitted: none. */
  deadlineMs?: number;
  /** Cache groups. Omitted: every pass has a session id of its own. */
  cache?: LensCacheConfig;
  /** Minimum gap between two session creations on this host. 0 turns the
   * stagger off. Default DEFAULT_SESSION_GAP_MS. */
  sessionGapMs?: number;
  progress?: LensProgressSink;
  /** Keep each pass's session JSONL under `<sessionsDir>/<run id>/`, so a
   * finished lens opens in pi (`qcr open --lens`). A retried pass writes a second
   * file beside the first. Omitted: the passes stay in memory. */
  sessionsDir?: string;
  /** The lens session's LiveEvent log (`lens-<id>.jsonl`): given the run's id
   * and agent, returns the sink the session's events are fed to. Closed when
   * the attempt ends. A sink that cannot be made is a warning, never a failure. */
  live?: (id: string, agent: string) => LiveSink;
  /** Hears every extension error pi reports instead of throwing. */
  onExtensionError?: (agent: string, id: string, error: ExtensionError) => void;
  /** A ledger or progress write that failed (diagnostic only; never fatal).
   * The host's sink: omitted, nowhere. */
  warn?: (message: string) => void;
  now?: () => number;
  newId?: () => string;
}

export interface LensRequest {
  agent: string;
  task: string;
  /** Ends the pass: the session is aborted and the result says so. */
  signal?: AbortSignal;
  /** Hears the pass's activity each time a tool call of its session starts or
   * ends, while it runs. A listener that throws is ignored. */
  onActivity?: (activity: LensActivity) => void;
}

export interface LensRun {
  result: LensResult;
  /** The pass's last assistant text; "" when it produced none. */
  text: string;
  /** What the pass did, at its end: its tool count and duration. Absent on a
   * pass that never reached its session's setup (an unknown agent, no permit). */
  activity?: LensActivity;
}

export interface LensRunner {
  run(request: LensRequest): Promise<LensRun>;
  /** Passes with a live session right now. */
  liveSessions(): number;
}

const semaphores = new WeakMap<PiHost, WeightedSemaphore>();

/** The host's one lens cap, created on first use. */
export function lensSemaphoreFor(host: PiHost, permits: number): WeightedSemaphore {
  const held = semaphores.get(host);
  if (held === undefined) {
    const made = new WeightedSemaphore(permits);
    semaphores.set(host, made);
    return made;
  }
  if (held.permits !== permits)
    throw new Error(
      `this host already runs lenses under a cap of ${held.permits}, not ${permits}: one cap per host`,
    );
  return held;
}

const creationClocks = new WeakMap<PiHost, { nextFree: number }>();

/** Wait for this host's next session-creation slot, `gapMs` after the last one
 * handed out. Slots are spaced on the real clock, never the injected one. */
async function awaitCreationSlot(host: PiHost, gapMs: number, signal?: AbortSignal): Promise<void> {
  if (gapMs <= 0) return;
  let clock = creationClocks.get(host);
  if (clock === undefined) {
    clock = { nextFree: 0 };
    creationClocks.set(host, clock);
  }
  const at = Math.max(Date.now(), clock.nextFree);
  clock.nextFree = at + gapMs;
  await delay(at - Date.now(), signal);
}

const THINKING_LEVEL_SET: ReadonlySet<string> = new Set(THINKING_LEVELS);

/** What a pass runs on: the spec that names it (its cache group, and the
 * model it reports) and what its session is asked for. `model` undefined is
 * the host's route. */
interface PassModel {
  spec: string;
  model: string | undefined;
}

/** Why a pass has no model to run on. */
interface NoPassModel {
  refused: string;
}

/** A failed pass's envelope: no text, exit 1, `error` unless `extra` says more. */
function failedRun(
  id: string,
  agent: string,
  model: string,
  usage: LensUsage,
  errorMessage: string,
  extra: Partial<LensResult> = {},
): LensRun {
  return {
    text: "",
    result: {
      id,
      agent,
      model,
      usage,
      messages: [],
      exitCode: 1,
      stopReason: "error",
      errorMessage,
      ...extra,
    },
  };
}

const ZERO_USAGE: LensUsage = { input: 0, output: 0, cacheRead: 0, cost: 0 };

const addUsage = (a: LensUsage, b: LensUsage): LensUsage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cost: a.cost + b.cost,
});

/** What one attempt left behind once its session was read. */
interface Reading {
  text: string;
  messages: LensMessage[];
  model: string | undefined;
  stopReason: string | undefined;
  errorMessage: string | undefined;
  /** Set when the turn threw instead of settling. */
  failure: string | undefined;
}

function readSession(session: AgentSession): {
  reading: Omit<Reading, "failure">;
  usage: LensUsage;
} {
  // The system message carries the whole prompt; a native child's stream never
  // had it, and no consumer reads it.
  const messages = (session.messages as unknown as LensMessage[]).filter(
    (m) => m.role !== "system",
  );
  let last: LensMessage | undefined;
  for (let i = messages.length - 1; i >= 0; i--)
    if (messages[i]?.role === "assistant") {
      last = messages[i];
      break;
    }
  const stats = session.getSessionStats();
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v !== "" ? v : undefined;
  return {
    reading: {
      text: session.getLastAssistantText() ?? "",
      messages: [...messages],
      model: str(last?.["model"]),
      stopReason: str(last?.["stopReason"]),
      errorMessage: str(last?.["errorMessage"]),
    },
    usage: {
      input: stats.tokens.input,
      output: stats.tokens.output,
      cacheRead: stats.tokens.cacheRead,
      cost: stats.cost,
    },
  };
}

/** The reason an agent may not run as a lens, or undefined. */
function leafViolation(agent: LensAgent): string | undefined {
  const lensTools = (agent.tools ?? []).filter((t) => isLensTool(t));
  return lensTools.length > 0
    ? `agent ${agent.name} lists a lens tool (${lensTools.join(", ")}): lenses are leaves`
    : undefined;
}

export function createLensRunner(config: LensRunConfig): LensRunner {
  const permitPort =
    config.permitPort ?? localPermits(lensSemaphoreFor(config.host, config.permits));
  const now = config.now ?? Date.now;
  const newId = config.newId ?? randomUUID;
  // The host's sink (it prefixes `[lens] ` where it prints); omitted: nowhere.
  const warn = config.warn ?? ((): void => {});
  /** Sessions streaming now, by id. A host that handed two ungrouped passes
   * one id would cut one's websocket when the other is disposed (canary 1);
   * a cache group shares its id on purpose and disposes together. */
  const live = new Map<string, number>();
  const enter = (sessionId: string): void => {
    live.set(sessionId, (live.get(sessionId) ?? 0) + 1);
  };
  const leave = (sessionId: string): void => {
    const n = (live.get(sessionId) ?? 0) - 1;
    if (n > 0) live.set(sessionId, n);
    else live.delete(sessionId);
  };
  const cache = config.cache !== undefined && config.cache.size >= 1 ? config.cache : undefined;
  const groups =
    cache !== undefined
      ? new CacheGroups(cache.size, cache.staggerMs, undefined, (key, n) =>
          warn(`pin-evidence cache-group-disposed key=${key} sessions=${n}`),
        )
      : undefined;
  const sessionGapMs = config.sessionGapMs ?? DEFAULT_SESSION_GAP_MS;

  /** The host's route, asked once for every pass of this runner that names no
   * model. A refusal is kept too: each such pass fails with its words. A host
   * that could not answer is asked again by the next pass. */
  let routed: Promise<PassModel | NoPassModel> | undefined;
  /** The route's spec, once the host has answered with one. */
  let routeSpec: string | undefined;
  /** The route's model as the host's catalog names it, kept with the spec. */
  let routeModel: { provider: string; id: string } | undefined;
  const hostRoute = (): Promise<PassModel | NoPassModel> => {
    routed ??= Promise.resolve()
      .then(() => config.host.route())
      .then((r): PassModel | NoPassModel => {
        if (!r.ok) return { refused: refusalText(r.refusal, "app") };
        routeSpec = r.route.spec;
        routeModel = { provider: r.route.provider, id: r.route.modelId };
        return { spec: r.route.spec, model: undefined };
      })
      .catch((e: unknown) => {
        routed = undefined;
        return {
          refused: `the host could not resolve a model: ${e instanceof Error ? e.message : String(e)}`,
        };
      });
    return routed;
  };
  /** The model `agent` runs on: its own, else the run's default, else the
   * host's route. An agent's `model:` that names only a level names no model. */
  const passModel = async (agent: LensAgent): Promise<PassModel | NoPassModel> => {
    const named = agent.modelId || config.defaultModel;
    return named ? { spec: named, model: named } : hostRoute();
  };
  /** The model a pass reports: its agent's `model:` as written when that
   * names one, else the run's default, else the route's spec. */
  const reported = (agent: LensAgent, on: PassModel): string =>
    agent.modelId ? (agent.model ?? on.spec) : on.spec;
  /** The model a pass that never got as far as its model reports: what its
   * agent or the run names, else the route when the host has answered. */
  const namedModel = (agent: LensAgent | undefined): string =>
    (agent?.modelId ? agent.model : undefined) ??
    config.defaultModel ??
    (agent !== undefined ? routeSpec : undefined) ??
    "unknown";

  /** The API the sessions of `on` will speak, or undefined when the host
   * cannot say before a session exists. It follows the host's own resolution
   * (pisdk.ts `resolveModel`): no model is the host's route, as the runner
   * already holds it; a named provider with a credential is itself; one
   * without runs on the credentialed provider that serves the same id, when
   * that is not a guess. An id the host's catalog does not hold, a move the
   * host would settle by the remembered provider and a host that throws all
   * answer undefined: the group is then not packed, which is right on every
   * API. */
  const apiOf = async (on: PassModel): Promise<string | undefined> => {
    try {
      const { host } = config;
      if (on.model === undefined)
        return routeModel !== undefined
          ? host.modelRuntime.getModel(routeModel.provider, routeModel.id)?.api
          : undefined;
      const named = splitProvider(on.model);
      if (named === null) return undefined;
      const inventory = await host.inventory();
      if (inventory.some((e) => e.provider === named.provider))
        return host.modelRuntime.getModel(named.provider, named.rest)?.api;
      const move = moveToCredentialed({ provider: named.provider, id: named.rest }, inventory);
      return move !== null && "provider" in move
        ? host.modelRuntime.getModel(move.provider, named.rest)?.api
        : undefined;
    } catch {
      return undefined;
    }
  };

  /** Whether the groups of a model are packed, by the spec that keys their
   * group: asked once per model of the run, so every pass of a group, and
   * every group of a model, takes one path. */
  const packedSpecs = new Map<string, Promise<boolean>>();
  const packedOn = (on: PassModel): Promise<boolean> => {
    let known = packedSpecs.get(on.spec);
    if (known === undefined) {
      known = apiOf(on).then(isPackFirstApi);
      packedSpecs.set(on.spec, known);
    }
    return known;
  };

  /** The round's pack for a pass on `on` when its cache group is packed, else
   * undefined. A group is packed when the round has a pack and the group's
   * model speaks an API of the pack-first family: the rewrite builds that
   * family's request and no other. Never rejects. */
  const packFor = async (on: PassModel): Promise<string | undefined> => {
    const pack = cache?.pack;
    if (pack === undefined || !pack.trim()) return undefined;
    return (await packedOn(on)) ? pack : undefined;
  };

  const transition = (id: string, entry: ProgressTransition): void => {
    const p = config.progress;
    if (p === undefined) return;
    try {
      mkdirSync(dirname(p.logPath), { recursive: true });
      appendProgressLog(p.logPath, {
        at: new Date(now()).toISOString(),
        pr: p.pr,
        session: p.session,
        run_started_at: p.runStartedAt,
        ...(p.commandId !== undefined ? { command_id: p.commandId } : {}),
        ...entry,
      });
    } catch (e) {
      warn(`progress append failed for ${id}: ${String(e)}`);
    }
  };

  const record = (
    id: string,
    result: LensResult,
    startedAtMs: number,
    kind: "lens" | "warmup" = "lens",
  ): void => {
    try {
      mkdirSync(dirname(config.ledgerPath), { recursive: true });
      appendFileSync(
        config.ledgerPath,
        serializeLedgerLine(ledgerLineOf(kind, id, result, { endedAtMs: now(), startedAtMs })),
      );
    } catch (e) {
      warn(`ledger append failed for ${id}: ${String(e)}`);
    }
  };

  async function run(request: LensRequest): Promise<LensRun> {
    const id = newId();
    const startedAt = now();
    const agent = config.registry.get(request.agent);
    const failed = (
      usage: LensUsage,
      errorMessage: string,
      extra: Partial<LensResult> = {},
    ): LensRun => failedRun(id, request.agent, namedModel(agent), usage, errorMessage, extra);
    const finish = (out: LensRun): LensRun => {
      record(id, out.result, startedAt);
      return out;
    };

    if (agent === undefined)
      return finish(
        failed(
          ZERO_USAGE,
          `Unknown agent: "${request.agent}". Available agents: ${
            config.registry
              .names()
              .map((n) => `"${n}"`)
              .join(", ") || "none"
          }.`,
        ),
      );
    const violation = leafViolation(agent);
    if (violation !== undefined) return finish(failed(ZERO_USAGE, violation));

    let permit: Permit;
    try {
      permit = await permitPort.acquire(id, 1, request.signal);
    } catch (e) {
      return finish(
        failed(
          ZERO_USAGE,
          request.signal?.aborted
            ? "lens aborted before it started"
            : `no lens permit: ${e instanceof Error ? e.message : String(e)}`,
          request.signal?.aborted ? { stopReason: "aborted" } : {},
        ),
      );
    }
    let out: LensRun;
    let started = false;
    try {
      if (request.signal?.aborted) {
        out = failed(ZERO_USAGE, "lens aborted before it started", { stopReason: "aborted" });
      } else {
        started = true;
        transition(id, { event: "pass_start", execution_id: id, agent: agent.name });
        out = await execute(id, agent, request);
      }
    } finally {
      permit.release();
    }
    if (started) {
      const status: LiveAgentStatus = out.result.exitCode === 0 ? "completed" : "failed";
      transition(id, { event: "pass_end", execution_id: id, agent: agent.name, status });
    }
    return finish(out);
  }

  /** The pass under its permit: joins its cache group, if any, and leaves it
   * once its last attempt is done. Never throws. */
  async function execute(id: string, agent: LensAgent, request: LensRequest): Promise<LensRun> {
    const on = await passModel(agent);
    if ("refused" in on)
      return failedRun(id, agent.name, namedModel(agent), ZERO_USAGE, on.refused);
    // Decided before the pass joins its group, so joining and waiting on the
    // group stay one step: a group's first pass has started the warm-up
    // before any other pass of the group looks for it.
    const pack = groups !== undefined ? await packFor(on) : undefined;
    // Keyed by tool list too: a warm-up warms the prefix of its first pass's
    // tools, and the request's `tools` field is part of that prefix.
    const lease =
      groups !== undefined ? groups.join(cacheGroupKey(on.spec, agent.tools), now()) : undefined;
    try {
      return await executeIn(id, agent, request, on, lease, pack);
    } finally {
      lease?.release();
    }
  }

  /** Session spec the warm-up and the passes share: the host-facing part. */
  const baseSpec = (
    agent: LensAgent,
    on: PassModel,
    extensions: ExtensionFactory[],
  ): HostSessionSpec => ({
    cwd: config.cwd,
    env: config.env,
    // No model of its own: the host's route.
    ...(on.model !== undefined ? { model: on.model } : {}),
    ...(agent.thinking !== null
      ? { thinkingLevel: agent.thinking as HostSessionSpec["thinkingLevel"] }
      : {}),
    ...(config.agentsFiles ? { agentsFiles: config.agentsFiles } : {}),
    extensions,
    ...(agent.tools ? { tools: agent.tools } : {}),
    ...(config.bashEnv ? { bashEnv: config.bashEnv } : {}),
  });

  /** A group's warm-up: the first pass's model and tools, no lens text, the
   * pack and "reply OK", under the group's session id. It takes no permit (it
   * runs beside the first pass, which holds one) and never rejects: the group
   * is released when it finishes, whatever happened. Its session is kept for
   * the group's disposal. One ledger line, kind "warmup". */
  async function warmUp(
    agent: LensAgent,
    on: PassModel,
    lease: CacheLease,
    pack: string,
    keep: (s: AgentSession) => void,
    hardStopMs: number,
  ): Promise<void> {
    const id = newId();
    const startedAt = now();
    const stop = AbortSignal.timeout(hardStopMs);
    let spent = ZERO_USAGE;
    let session: AgentSession | undefined;
    let failure: string | undefined;
    let unexpected = false;
    try {
      await awaitCreationSlot(config.host, sessionGapMs, stop);
      stop.throwIfAborted();
      session = await config.host.makeSession({
        ...baseSpec(agent, on, [
          config.bashGuard,
          ...config.leafTools(agent),
          leafCache({ pack, cacheKey: lease.key, onUnexpected: () => (unexpected = true) }),
        ]),
        sessionId: lease.key,
        onExtensionError: (e) => config.onExtensionError?.("warmup", id, e),
      });
      keep(session);
      stop.throwIfAborted();
      const s = session;
      // An abort that lands before pi's agent is running is a no-op there, so
      // it is repeated until the turn has settled.
      let repeat: ReturnType<typeof setInterval> | undefined;
      let turnSettled = false;
      const onStop = (): void => {
        const again = (): void => {
          if (turnSettled) {
            if (repeat !== undefined) clearInterval(repeat);
            return;
          }
          void s.abort().catch(() => {});
        };
        again();
        repeat = setInterval(again, 100);
      };
      stop.addEventListener("abort", onStop, { once: true });
      try {
        await s.prompt(`Task: ${WARMUP_REPLY_TASK}`);
      } finally {
        turnSettled = true;
        stop.removeEventListener("abort", onStop);
        if (repeat !== undefined) clearInterval(repeat);
      }
      const read = readSession(s);
      spent = addUsage(spent, read.usage);
      if (stop.aborted) failure = "warm-up stopped after its time limit";
      else if (read.reading.stopReason === "error" || read.reading.stopReason === "aborted")
        failure = read.reading.errorMessage ?? `warm-up ended ${read.reading.stopReason}`;
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
      if (session !== undefined) {
        try {
          spent = addUsage(spent, readSession(session).usage);
        } catch {
          // nothing readable
        }
      }
    }
    if (unexpected) warn(`warm-up ${id}: request shape not as expected; sent unchanged`);
    record(
      id,
      {
        agent: "warmup",
        model: reported(agent, on),
        usage: spent,
        messages: [],
        exitCode: failure === undefined ? 0 : 1,
        ...(failure !== undefined ? { stopReason: "error", errorMessage: failure } : {}),
      },
      startedAt,
      "warmup",
    );
  }

  /** Wait until the pass's group is ready for it. A packed group (`pack` is
   * its pack, from packFor): the group's warm-up (started by the first
   * pass), at most the wait; a warm-up that fails or runs late releases the
   * group all the same. Any other group: the stagger after the group's first
   * pass, an awaited delay, and no warm-up. */
  async function groupReady(
    agent: LensAgent,
    on: PassModel,
    lease: CacheLease,
    pack: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (pack === undefined) {
      await delay(lease.delayMs, signal);
      return;
    }
    const waitMs = cache?.warmupWaitMs ?? WARMUP_WAIT_MS;
    const warm = lease.first
      ? lease.startWarmup((keep) => warmUp(agent, on, lease, pack, keep, waitMs * 2))
      : lease.warmup();
    if (warm === undefined) return;
    if (!(await settledWithin(warm, waitMs, signal)) && !signal?.aborted)
      warn(`warm-up for cache group ${lease.key} still running after ${waitMs} ms; lenses go on`);
  }

  /** The attempts of one pass, under its permit, with what it did: its
   * activity is told to the request while it runs and kept on the run at its
   * end. `pack` is the round's pack when the pass's group is packed (packFor).
   * Never throws. */
  async function executeIn(
    id: string,
    agent: LensAgent,
    request: LensRequest,
    on: PassModel,
    lease: CacheLease | undefined,
    pack: string | undefined,
  ): Promise<LensRun> {
    const activity = new LensActivityTracker(now(), now, config.cwd);
    const out = await attemptsOf(id, agent, request, on, lease, pack, activity);
    activity.settle();
    return { ...out, activity: activity.view() };
  }

  /** executeIn's body: the attempts, each feeding `activity` from its
   * session's events. Never throws. */
  async function attemptsOf(
    id: string,
    agent: LensAgent,
    request: LensRequest,
    on: PassModel,
    lease: CacheLease | undefined,
    pack: string | undefined,
    activity: LensActivityTracker,
  ): Promise<LensRun> {
    let spent = ZERO_USAGE;
    const thinking = agent.thinking;
    const fail = (errorMessage: string, extra: Partial<LensResult> = {}): LensRun =>
      failedRun(id, agent.name, reported(agent, on), spent, errorMessage, extra);
    // The provider error pi is retrying, across both attempts: a timeout
    // while it retries names it (`passTimeoutMessage`).
    const providerRetry = new ProviderRetryWatch();
    const tell = (): void => {
      if (request.onActivity === undefined) return;
      try {
        request.onActivity(activity.view());
      } catch {
        // a listener's failure is not the pass's
      }
    };
    if (thinking !== null && !THINKING_LEVEL_SET.has(thinking))
      return fail(`agent ${agent.name} asks for an unknown thinking level "${thinking}"`);

    /** Dispose a finished session: now, or with its cache group, which shares
     * its id and so its transports. */
    const retire = (s: AgentSession): void => {
      if (lease !== undefined) lease.keep(s);
      else s.dispose();
    };

    const attempt = async (signal: AbortSignal): Promise<Reading> => {
      let session: AgentSession | undefined;
      let sessionId: string | undefined;
      let entered = false;
      let sink: LiveSink | undefined;
      let unsubscribe: (() => void) | undefined;
      let unhear: (() => void) | undefined;
      try {
        const spec: HostSessionSpec = {
          ...baseSpec(agent, on, [
            config.bashGuard,
            ...config.leafTools(agent),
            // The rewrite hook is a packed group's alone.
            ...(lease !== undefined && pack !== undefined
              ? [
                  leafCache({
                    pack,
                    cacheKey: lease.key,
                    body: agent.body,
                    onUnexpected: () =>
                      warn(
                        `lens ${agent.name} ${id}: request shape not as expected; sent unchanged`,
                      ),
                  }),
                ]
              : []),
          ]),
          appendSystemPrompt: [agent.body],
          ...(config.sessionsDir !== undefined
            ? { persist: { sessionDir: join(config.sessionsDir, id) } }
            : {}),
          ...(lease !== undefined ? { sessionId: lease.key } : {}),
          onExtensionError: (e) => config.onExtensionError?.(agent.name, id, e),
        };
        await awaitCreationSlot(config.host, sessionGapMs, signal);
        signal.throwIfAborted();
        session = await config.host.makeSession(spec);
        sessionId = session.sessionId;
        unhear = session.subscribe((event) => {
          providerRetry.feed(event);
          if (activity.feed(event)) tell();
        });
        if (config.live !== undefined) {
          try {
            const made = config.live(id, agent.name);
            sink = made;
            unsubscribe = session.subscribe((event) => made.feed(event));
          } catch (e) {
            warn(`live log for ${id} not started: ${String(e)}`);
          }
        }
        if (lease === undefined && live.has(sessionId))
          throw new Error(`session id ${sessionId} is already live: lens sessions need unique ids`);
        if (lease !== undefined && sessionId !== lease.key)
          throw new Error(`session id ${sessionId} is not its cache group's ${lease.key}`);
        enter(sessionId);
        entered = true;
        signal.throwIfAborted();
        const turn = session.prompt(`Task: ${request.task}`).then(
          () => undefined,
          (e: unknown) => (e instanceof Error ? e.message : String(e)),
        );
        let settled = false;
        void turn.then(() => {
          settled = true;
        });
        // An abort that lands before pi's agent is running is a no-op there, so
        // it is repeated until the turn has settled.
        const s = session;
        let repeat: ReturnType<typeof setInterval> | undefined;
        const onAbort = (): void => {
          const stop = (): void => {
            if (settled) {
              if (repeat !== undefined) clearInterval(repeat);
              return;
            }
            void s.abort().catch(() => {});
          };
          stop();
          repeat = setInterval(stop, 100);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
        const failure = await turn;
        signal.removeEventListener("abort", onAbort);
        if (repeat !== undefined) clearInterval(repeat);
        const { reading, usage } = readSession(session);
        spent = addUsage(spent, usage);
        retire(session);
        leave(sessionId);
        entered = false;
        session = undefined;
        // Ended by a signal, not by the model: the deadline decides what that means.
        signal.throwIfAborted();
        return { ...reading, failure };
      } finally {
        unhear?.();
        // A call the attempt left open (an abort, a deadline) is over with it.
        activity.settle();
        unsubscribe?.();
        sink?.close();
        if (session !== undefined) {
          try {
            spent = addUsage(spent, readSession(session).usage);
          } catch {
            // nothing readable: the spend is unknown, not guessed
          }
          try {
            retire(session);
          } catch {
            // already disposed
          }
          if (sessionId !== undefined && entered) leave(sessionId);
        }
      }
    };

    let outcome: Reading | "timed_out";
    try {
      if (lease !== undefined) await groupReady(agent, on, lease, pack, request.signal);
      request.signal?.throwIfAborted();
      outcome =
        config.deadlineMs !== undefined
          ? await runUnderDeadline(attempt, request.signal, config.deadlineMs)
          : await attempt(request.signal ?? new AbortController().signal);
    } catch (e) {
      if (request.signal?.aborted) return fail("lens aborted", { stopReason: "aborted" });
      return fail(`lens session failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (outcome === "timed_out")
      return fail(
        passTimeoutMessage(agent.name, config.deadlineMs as number, providerRetry.last()),
        { timedOut: true },
      );

    const stopReason = outcome.stopReason;
    const errorMessage = outcome.failure ?? outcome.errorMessage;
    const bad = outcome.failure !== undefined || stopReason === "error" || stopReason === "aborted";
    return {
      text: outcome.text,
      result: {
        id,
        agent: agent.name,
        model: outcome.model ?? reported(agent, on),
        usage: spent,
        messages: outcome.messages,
        exitCode: bad ? 1 : 0,
        ...(stopReason !== undefined ? { stopReason } : {}),
        ...(errorMessage !== undefined ? { errorMessage } : {}),
      },
    };
  }

  return {
    run,
    liveSessions: () => {
      let n = 0;
      for (const c of live.values()) n += c;
      return n;
    },
  };
}
