// runLens: one lens pass as an in-process SDK session, the engine's replacement
// for a native `subagent` child process.
//
// What a pass is, by construction:
//   - A leaf. It gets the tools its agent file lists, plus the bash-guard
//     factory, and never a lens tool: the runner hands the host no customTools
//     and refuses an agent file that names one (include.ts checks the same at
//     build time). The runner cannot be asked to nest.
//   - Capped. One WeightedSemaphore per PiHost bounds the passes in flight; a
//     pass holds its permit from before its session exists until the session is
//     read and disposed, retry included.
//   - Isolated. The session comes from PiHost.makeSession (the P2.1 fence: no
//     other module builds an SDK session), in memory, under an id of its own, so
//     disposing one pass never cuts a sibling's provider socket (canary 1).
//     Its system prompt is pi's base plus the agent's body appended, and the D34
//     context files ride as data; the pass reads the same bytes a native child
//     reads (tests/lens-prompt-parity.test.ts).
//   - Bounded in time. With a deadline, an attempt the timer ends is aborted and
//     retried once on a FRESH session; a second timeout answers timedOut.
//   - Never fatal. runLens does not reject. A host that cannot build the
//     session, an extension that throws, a provider that fails, a caller's
//     abort: each is a failed LensResult, with the spend so far in its usage,
//     one ledger line and a pass_end in the progress log.
//
// The task is sent the way the native child sends it: `Task: <task>`.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
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
import type { BashEnvOptions, HostSessionSpec, PiHost } from "../pisdk.js";
import type { AgentsFile } from "../port.js";
import { passTimeoutMessage, runUnderDeadline } from "./deadline.js";
import type { AgentRegistry, LensAgent } from "./registry.js";
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

export interface LensRunConfig {
  host: PiHost;
  /** The cap on passes in flight for this host. The first runner on a host sets
   * it; a later runner on the same host must ask for the same number. */
  permits: number;
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
  progress?: LensProgressSink;
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
  const semaphore = lensSemaphoreFor(config.host, config.permits);
  const now = config.now ?? Date.now;
  const newId = config.newId ?? randomUUID;
  const warn = config.warn ?? ((m: string): void => console.error(`[lens] ${m}`));
  /** Ids of the sessions alive now: a host that handed two passes one id
   * would cut one's websocket when the other is disposed (canary 1). */
  const live = new Set<string>();

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

  const record = (id: string, result: LensResult, startedAtMs: number): void => {
    try {
      mkdirSync(dirname(config.ledgerPath), { recursive: true });
      appendFileSync(
        config.ledgerPath,
        serializeLedgerLine(ledgerLineOf("lens", id, result, { endedAtMs: now(), startedAtMs })),
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

    await semaphore.acquire(1);
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
      semaphore.release(1);
    }
    if (started) {
      const status: LiveAgentStatus = out.result.exitCode === 0 ? "completed" : "failed";
      transition(id, { event: "pass_end", execution_id: id, agent: agent.name, status });
    }
    return finish(out);
  }

  /** The attempts of one pass, under its permit. Never throws. */
  async function execute(id: string, agent: LensAgent, request: LensRequest): Promise<LensRun> {
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

    const attempt = async (signal: AbortSignal): Promise<Reading> => {
      let session: AgentSession | undefined;
      let sessionId: string | undefined;
      try {
        const spec: HostSessionSpec = {
          cwd: config.cwd,
          env: config.env,
          model: modelSpec,
          ...(thinking !== null
            ? { thinkingLevel: thinking as HostSessionSpec["thinkingLevel"] }
            : {}),
          appendSystemPrompt: [agent.body],
          ...(config.agentsFiles ? { agentsFiles: config.agentsFiles } : {}),
          extensions: [config.bashGuard],
          ...(agent.tools ? { tools: agent.tools } : {}),
          ...(config.bashEnv ? { bashEnv: config.bashEnv } : {}),
          onExtensionError: (e) => config.onExtensionError?.(agent.name, id, e),
        };
        session = await config.host.makeSession(spec);
        sessionId = session.sessionId;
        if (live.has(sessionId))
          throw new Error(`session id ${sessionId} is already live: lens sessions need unique ids`);
        live.add(sessionId);
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
        session.dispose();
        live.delete(sessionId);
        session = undefined;
        // Ended by a signal, not by the model: the deadline decides what that means.
        signal.throwIfAborted();
        return { ...reading, failure };
      } finally {
        if (session !== undefined) {
          try {
            spent = addUsage(spent, readSession(session).usage);
          } catch {
            // nothing readable: the spend is unknown, not guessed
          }
          try {
            session.dispose();
          } catch {
            // already disposed
          }
          if (sessionId !== undefined) live.delete(sessionId);
        }
      }
    };

    let outcome: Reading | "timed_out";
    try {
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
