// runLens: one lens pass as an in-process SDK session, the engine's replacement
// for a native `subagent` child process.
//
// What a pass is, by construction:
//   - A leaf. It gets the tools its agent file lists, plus the bash-guard
//     factory, and never a lens tool: the runner hands the host no customTools
//     and refuses an agent file that names one (include.ts checks the same at
//     build time). The runner cannot be asked to nest.
//   - Capped. A Permits port bounds the passes in flight: one WeightedSemaphore
//     per PiHost on a one-shot route, the daemon's central broker in a bot worker
//     (D25). A pass holds its permit from before its session exists until the
//     session is read and disposed, retry included.
//   - Isolated. The session comes from PiHost.makeSession (the P2.1 fence: no
//     other module builds an SDK session), in memory unless `sessionsDir` keeps
//     its JSONL (D10), under an id of its own, so
//     disposing one pass never cuts a sibling's provider socket (canary 1).
//     Its system prompt is pi's base plus the agent's body appended, and the D34
//     context files ride as data; the pass reads the same bytes a native child
//     reads (tests/lens-prompt-parity.test.ts).
//   - Cache-grouped, when asked (config.cache, D7). The passes of one group, per
//     model, share ONE session id, which is what routes their requests to one
//     provider cache. Disposing a session closes the transports held for its id,
//     so a grouped session is kept until the group's last pass is done and the
//     group is disposed together (cache-run.ts): one pass finishing never ends
//     a sibling's stream. With a context pack the group's first pass starts a
//     warm-up (no permit, the pack and "reply OK") that every pass of the group
//     waits for, at most 30 s; without one, later passes start after a stagger.
//   - Staggered. Sessions are created sessionGapMs apart, per host: building a
//     wave at once blocks the event loop for seconds (docs/cpu-gate.md, finding 4).
//   - Bounded in time. With a deadline, an attempt the timer ends is aborted and
//     retried once on a FRESH session; a second timeout answers timedOut.
//   - Never fatal. runLens does not reject. A host that cannot build the
//     session, an extension that throws, a provider that fails, a caller's
//     abort: each is a failed LensResult, with the spend so far in its usage,
//     one ledger line and a pass_end in the progress log.
//
// The task is sent the way the native child sends it: `Task: <task>`.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
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
  WARMUP_WAIT_MS,
  delay,
  settledWithin,
  type CacheLease,
} from "./cache-run.js";
import { passTimeoutMessage, runUnderDeadline } from "./deadline.js";
import { leafCache } from "./leaf-cache.js";
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

/** Lens cache groups (D7). */
export interface LensCacheConfig {
  /** Passes per group, per model; below 1 there are no groups. */
  size: number;
  /** How long a pack-less group's later passes start after its first. */
  staggerMs: number;
  /** The round's context pack text. Present: each group is warmed with it and
   * every request is rewritten pack-first. Absent: the stagger applies. */
  pack?: string;
  /** How long a pass waits for its group's warm-up. Default 30 s. */
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
   * `permits`. A bot worker passes the daemon's broker client (D25). */
  permitPort?: Permits;
  registry: AgentRegistry;
  /** The passes' working directory (also their bash tool's). */
  cwd: string;
  /** The environment the model's bash may draw from. */
  env: Readonly<Record<string, string | undefined>>;
  /** The bash-guard factory, attached to every pass. Required: there is no
   * lens without it. */
  bashGuard: ExtensionFactory;
  /** Append-only `lens-ledger.jsonl`; one line per pass. */
  ledgerPath: string;
  /** D34 context files. Omitted: the host's. */
  agentsFiles?: readonly AgentsFile[];
  bashEnv?: BashEnvOptions;
  /** `provider/id` for an agent file that names no model. */
  defaultModel?: string;
  /** Per-attempt deadline. Omitted: none. */
  deadlineMs?: number;
  /** Cache groups. Omitted: every pass has a session id of its own. */
  cache?: LensCacheConfig;
  /** Minimum gap between two session creations on this host. 0 turns the
   * stagger off. Default DEFAULT_SESSION_GAP_MS. */
  sessionGapMs?: number;
  progress?: LensProgressSink;
  /** Keep each pass's session JSONL under `<sessionsDir>/<run id>/` (D10), so a
   * finished lens opens in pi (`qcr open --lens`). A retried pass writes a second
   * file beside the first. Omitted: the passes stay in memory. */
  sessionsDir?: string;
  /** The lens session's LiveEvent log (`lens-<id>.jsonl`): given the run's id
   * and agent, returns the sink the session's events are fed to. Closed when
   * the attempt ends. A sink that cannot be made is a warning, never a failure. */
  live?: (id: string, agent: string) => LiveSink;
  /** Hears every extension error pi reports instead of throwing. */
  onExtensionError?: (agent: string, id: string, error: ExtensionError) => void;
  /** A ledger or progress write that failed (diagnostic only; never fatal). */
  warn?: (message: string) => void;
  now?: () => number;
  newId?: () => string;
}

export interface LensRequest {
  agent: string;
  task: string;
  /** Ends the pass: the session is aborted and the result says so. */
  signal?: AbortSignal;
}

export interface LensRun {
  result: LensResult;
  /** The pass's last assistant text; "" when it produced none. */
  text: string;
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

const THINKING_LEVELS: ReadonlySet<string> = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

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
  const warn = config.warn ?? ((m: string): void => console.error(`[lens] ${m}`));
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
    ): LensRun => ({
      text: "",
      result: {
        id,
        agent: request.agent,
        model: agent?.model ?? config.defaultModel ?? "unknown",
        usage,
        messages: [],
        exitCode: 1,
        stopReason: "error",
        errorMessage,
        ...extra,
      },
    });
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
    const modelSpec = agent.modelId ?? config.defaultModel;
    const lease =
      groups !== undefined && modelSpec !== undefined ? groups.join(modelSpec, now()) : undefined;
    try {
      return await executeIn(id, agent, request, lease);
    } finally {
      lease?.release();
    }
  }

  /** Session spec the warm-up and the passes share: the host-facing part. */
  const baseSpec = (
    agent: LensAgent,
    modelSpec: string,
    extensions: ExtensionFactory[],
  ): HostSessionSpec => ({
    cwd: config.cwd,
    env: config.env,
    model: modelSpec,
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
    modelSpec: string,
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
        ...baseSpec(agent, modelSpec, [
          config.bashGuard,
          leafCache({ pack, cacheKey: lease.key, onUnexpected: () => (unexpected = true) }),
        ]),
        sessionId: lease.key,
        onExtensionError: (e) => config.onExtensionError?.("warmup", id, e),
      });
      keep(session);
      stop.throwIfAborted();
      const s = session;
      const onStop = (): void => void s.abort().catch(() => {});
      stop.addEventListener("abort", onStop, { once: true });
      try {
        await s.prompt(`Task: ${WARMUP_REPLY_TASK}`);
      } finally {
        stop.removeEventListener("abort", onStop);
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
        model: agent.model ?? config.defaultModel ?? "unknown",
        usage: spent,
        messages: [],
        exitCode: failure === undefined ? 0 : 1,
        ...(failure !== undefined ? { stopReason: "error", errorMessage: failure } : {}),
      },
      startedAt,
      "warmup",
    );
  }

  /** Wait until the pass's group is ready for it. With a pack: the group's
   * warm-up (started by the first pass), at most the wait; a warm-up that
   * fails or runs late releases the group all the same. Without: the stagger
   * after the group's first pass, an awaited delay. */
  async function groupReady(
    agent: LensAgent,
    modelSpec: string,
    lease: CacheLease,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const pack = cache?.pack;
    if (pack === undefined || !pack.trim()) {
      await delay(lease.delayMs, signal);
      return;
    }
    const waitMs = cache?.warmupWaitMs ?? WARMUP_WAIT_MS;
    const warm = lease.first
      ? lease.startWarmup((keep) => warmUp(agent, modelSpec, lease, pack, keep, waitMs * 2))
      : lease.warmup();
    if (warm === undefined) return;
    if (!(await settledWithin(warm, waitMs, signal)) && !signal?.aborted)
      warn(`warm-up for cache group ${lease.key} still running after ${waitMs} ms; lenses go on`);
  }

  /** The attempts of one pass, under its permit. Never throws. */
  async function executeIn(
    id: string,
    agent: LensAgent,
    request: LensRequest,
    lease: CacheLease | undefined,
  ): Promise<LensRun> {
    let spent = ZERO_USAGE;
    const modelSpec = agent.modelId ?? config.defaultModel;
    const thinking = agent.thinking;
    const fail = (errorMessage: string, extra: Partial<LensResult> = {}): LensRun => ({
      text: "",
      result: {
        id,
        agent: agent.name,
        model: agent.model ?? config.defaultModel ?? "unknown",
        usage: spent,
        messages: [],
        exitCode: 1,
        stopReason: "error",
        errorMessage,
        ...extra,
      },
    });
    if (modelSpec === undefined)
      return fail(`agent ${agent.name} names no model and the run has no default`);
    if (thinking !== null && !THINKING_LEVELS.has(thinking))
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
      try {
        const pack = cache?.pack;
        const spec: HostSessionSpec = {
          ...baseSpec(agent, modelSpec, [
            config.bashGuard,
            ...(lease !== undefined && pack !== undefined
              ? [leafCache({ pack, cacheKey: lease.key, body: agent.body })]
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
      if (lease !== undefined) await groupReady(agent, modelSpec, lease, request.signal);
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
      return fail(passTimeoutMessage(agent.name, config.deadlineMs as number), { timedOut: true });

    const stopReason = outcome.stopReason;
    const errorMessage = outcome.failure ?? outcome.errorMessage;
    const bad = outcome.failure !== undefined || stopReason === "error" || stopReason === "aborted";
    return {
      text: outcome.text,
      result: {
        id,
        agent: agent.name,
        model: outcome.model ?? agent.model ?? config.defaultModel ?? "unknown",
        usage: spent,
        messages: outcome.messages,
        exitCode: bad ? 1 : 0,
        ...(stopReason !== undefined ? { stopReason } : {}),
        ...(errorMessage !== undefined ? { errorMessage } : {}),
      },
    };
  }

  return { run, liveSessions: () => live.size };
}
