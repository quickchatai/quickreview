// The LiveEvent v1 writer (events.ts is the format): turns a pi session's event
// stream into the slim log a viewer reads.
//
// A sink is fed every event of one session (`feed`), including the two update
// events the runtime port hides from ordinary listeners. It coalesces them:
// the many `message_update`s of one ~250 ms window become one `message_delta`
// line, and the many `tool_execution_update`s of a call one `tool_update`
// carrying only the children that changed. Anything else flushes what is
// pending first, so the file keeps the order the events happened in.
//
// A write that fails is reported once and then ignored: a viewer's log never
// costs the session it watches.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { isLensTool, LENS_WAVE_TOOL, lensIdOf, lensUsageOf } from "../lensresult.js";
import {
  LIVE_MAIN_FILE,
  lensLogName,
  resumePoint,
  type LiveBody,
  type LiveDraft,
  type LiveEvent,
  type LiveExecution,
  type LiveResult,
  type LiveStreamKind,
} from "./events.js";

/** The delta window: how long text and updates are held before one line. */
export const LIVE_COALESCE_MS = 250;

/** The launch-plan tool (and `lens_wave`, which takes the same arguments), whose
 * task slots the host resolves from the task dirs. */
const LAUNCH_PLAN = "launch_plan";

type Bag = Record<string, unknown>;

function record(value: unknown): Bag | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Bag)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

// The accessors below read a pi event field by field, whatever its declared
// type, exactly as extensions/round-progress.ts does: the two must agree on
// every payload, so the same probing order is kept.

function toolName(e: Bag): string {
  return text(e.toolName) ?? text(e.name) ?? "tool";
}

function toolId(e: Bag): string {
  return text(e.toolCallId) ?? text(e.id) ?? `${toolName(e)}:unknown`;
}

function toolArgs(e: Bag): Bag {
  return record(e.args) ?? record(e.input) ?? record(e.arguments) ?? {};
}

function argPreview(args: Bag): string | undefined {
  for (const key of ["command", "path", "query", "pattern", "url"]) {
    const value = text(args[key]);
    if (value) return value.replace(/\s+/g, " ").slice(0, 120);
  }
  return undefined;
}

/** The task slots of a `subagent` / `lens` call (one `{agent, task}` or
 * `{tasks:[...]}`), with the phase its task-file pointer names. */
export function subagentExecutions(args: Bag): LiveExecution[] {
  const tasks =
    typeof args.agent === "string" ? [args] : Array.isArray(args.tasks) ? args.tasks : args.chain;
  if (!Array.isArray(tasks)) return [];
  return tasks.map(record).flatMap((task) => {
    const agent = text(task?.agent);
    if (!agent) return [];
    const pointer = text(task?.task)?.match(
      /^Task file: [^\n]*[/]tasks(-sweep|-optional)?[/][^\n]+\. Read it first;/,
    );
    const phase: LiveExecution["phase"] | undefined = pointer
      ? pointer[1] === "-sweep"
        ? "sweep"
        : pointer[1] === "-optional"
          ? "optional"
          : "plan"
      : undefined;
    return [{ agent, ...(phase ? { phase } : {}) }];
  });
}

function userText(message: unknown): string | undefined {
  const m = record(message);
  if (m?.role !== "user" || !Array.isArray(m.content)) return undefined;
  return m.content
    .map(record)
    .filter(
      (part): part is Bag =>
        part !== undefined && part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text as string)
    .join("\n");
}

function currentToolArgs(value: unknown): string | undefined {
  return text(value)?.slice(0, 120);
}

/** What the native extension's transcript says of a child (round-progress
 * reads these when the child carries no `progress` record). */
function nativeParts(messages: unknown): LiveResult["native"] | undefined {
  if (!Array.isArray(messages)) return undefined;
  let toolCount = 0;
  let lastText: string | undefined;
  let lastTool: string | undefined;
  for (const msg of messages.map(record)) {
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content.map(record)) {
      if (part?.type === "toolCall") {
        toolCount += 1;
        lastTool = text(part.name) ?? lastTool;
      } else if (part?.type === "text") {
        lastText = text(part.text) ?? lastText;
      }
    }
  }
  return {
    tool_count: toolCount,
    ...(lastText ? { last_text: lastText } : {}),
    ...(lastTool ? { last_tool: lastTool } : {}),
  };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** One child of a lens tool call, reduced to what round-progress reads. */
export function slimResult(raw: Bag, slot: number): LiveResult {
  const progress = record(raw.progress);
  const exit = raw.exitCode;
  const agent = text(raw.agent);
  const id = lensIdOf(raw);
  const stop = typeof raw.stopReason === "string" ? raw.stopReason : undefined;
  const error = typeof raw.errorMessage === "string" ? raw.errorMessage : undefined;
  const native = nativeParts(raw.messages);
  const cost = lensUsageOf(raw.usage).cost;
  const recent = Array.isArray(progress?.recentTools)
    ? progress.recentTools.map(record).flatMap((t) => {
        if (t === undefined) return [];
        const tool = text(t.tool);
        const args = currentToolArgs(t.args);
        const status = typeof t.status === "string" ? t.status : undefined;
        return [
          {
            ...(tool ? { tool } : {}),
            ...(args ? { args } : {}),
            ...(status ? { status } : {}),
          },
        ];
      })
    : undefined;
  const slimProgress =
    progress === undefined
      ? undefined
      : {
          ...(typeof progress.status === "string" ? { status: progress.status } : {}),
          ...(finiteNumber(progress.durationMs) !== undefined
            ? { duration_ms: progress.durationMs as number }
            : {}),
          ...(finiteNumber(progress.toolCount) !== undefined
            ? { tool_count: progress.toolCount as number }
            : {}),
          ...(text(progress.lastMessage) ? { last_message: text(progress.lastMessage)! } : {}),
          ...(text(progress.error) ? { error: text(progress.error)! } : {}),
          ...(recent ? { recent_tools: recent } : {}),
        };
  return {
    slot,
    ...(agent ? { agent } : {}),
    ...(id ? { id } : {}),
    ...(exit === null || ["number", "string", "boolean"].includes(typeof exit)
      ? { exit_code: exit as number | string | boolean | null }
      : {}),
    ...(stop !== undefined ? { stop_reason: stop } : {}),
    ...(error !== undefined ? { error_message: error } : {}),
    ...(slimProgress ? { progress: slimProgress } : {}),
    ...(native ? { native } : {}),
    ...(cost > 0 ? { cost_usd: cost } : {}),
  };
}

/** `details.results` of a tool result, the records only (a non-record entry
 * has no slot). */
function resultsOf(carrier: unknown): Bag[] {
  const details = record(record(carrier)?.details);
  return Array.isArray(details?.results)
    ? details.results.filter((x): x is Bag => record(x) !== undefined)
    : [];
}

// ---- the file ----------------------------------------------------------------------

/** One append-only log file: it numbers its lines, and resumes a file that
 * already exists after its last good line (closing off a torn one). */
class LiveLog {
  private seq: number;
  private prefix: string;
  private failed = false;

  constructor(
    readonly path: string,
    private readonly warn: (message: string) => void,
  ) {
    // A file that cannot be read cannot be resumed; the first write reports it.
    let point = { lastSeq: 0, torn: false };
    try {
      point = resumePoint(path);
    } catch {
      // see above
    }
    this.seq = point.lastSeq;
    this.prefix = point.torn ? "\n" : "";
  }

  append(draft: LiveDraft): LiveEvent | undefined {
    const { at, ...body } = draft;
    const event = { v: 1, seq: this.seq + 1, at, ...body } as LiveEvent;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, `${this.prefix}${JSON.stringify(event)}\n`);
    } catch (err) {
      if (!this.failed) this.warn(`live log ${this.path} is not writable: ${String(err)}`);
      this.failed = true;
      return undefined;
    }
    this.failed = false;
    this.prefix = "";
    this.seq += 1;
    return event;
  }
}

// ---- the sink -----------------------------------------------------------------------

export interface LiveSinkMeta {
  /** The state key the round lives under. */
  key: string;
  round: number;
  /** The PR number round-progress is published for; null when there is none. */
  pr: number | null;
  /** The session's name (round-progress's `session`). */
  session: string;
  lensId?: string;
  agent?: string;
}

export interface LiveSink {
  readonly path: string;
  /** Hear one event of the session. Never throws. */
  feed(event: unknown): void;
  /** Write what is pending now. */
  flush(): void;
  /** Flush and stop: the sink writes nothing after this. */
  close(): void;
}

export interface LiveWriterOptions {
  /** The round's directory (`liveRoundDir`). */
  dir: string;
  /** Milliseconds; default the wall clock. */
  now?: () => number;
  coalesceMs?: number;
  /** A write that failed (never fatal): the host's sink. Omitted: nowhere. */
  warn?: (message: string) => void;
  /** The environment a launch plan resolves its task dirs against (the
   * session's, not this process's). */
  env?: Readonly<Record<string, string | undefined>>;
  /** What a `launch_plan` call launches: the host resolves it at call start,
   * because the task files are gone or changed by the time a reader asks. */
  launchExecutions?: (
    args: Bag,
    env: Readonly<Record<string, string | undefined>>,
  ) => LiveExecution[];
}

export interface LiveWriter {
  readonly dir: string;
  main(meta: LiveSinkMeta): LiveSink;
  lens(id: string, meta: LiveSinkMeta): LiveSink;
}

class Sink implements LiveSink {
  private readonly log: LiveLog;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Text since the last line; its instant is the first update's. */
  private delta: { at: string; text: string; thinking: string } | undefined;
  /** The latest update event of each call that has one pending. */
  private readonly updates = new Map<string, { at: string; event: Bag }>();
  /** Arrival order of the pending delta (`""`) and updates (call ids). */
  private order: string[] = [];
  /** The slim result last written for each (call, slot), to write only changes. */
  private readonly sent = new Map<string, string[]>();

  constructor(
    path: string,
    kind: LiveStreamKind,
    meta: LiveSinkMeta,
    private readonly o: Required<Pick<LiveWriterOptions, "now" | "coalesceMs" | "warn" | "env">> &
      Pick<LiveWriterOptions, "launchExecutions">,
  ) {
    this.log = new LiveLog(path, o.warn);
    this.write({
      type: "session_start",
      stream: kind,
      key: meta.key,
      round: meta.round,
      pr: meta.pr,
      session: meta.session,
      ...(meta.lensId !== undefined ? { lens_id: meta.lensId } : {}),
      ...(meta.agent !== undefined ? { agent: meta.agent } : {}),
    });
  }

  get path(): string {
    return this.log.path;
  }

  private at(): string {
    return new Date(this.o.now()).toISOString();
  }

  private write(body: LiveBody, at = this.at()): void {
    this.log.append({ ...body, at });
  }

  feed(event: unknown): void {
    if (this.closed) return;
    try {
      this.handle(record(event) ?? {});
    } catch (err) {
      this.o.warn(`live event dropped: ${String(err)}`);
    }
  }

  flush(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const order = this.order;
    this.order = [];
    for (const key of order) {
      if (key === "") {
        const d = this.delta;
        this.delta = undefined;
        if (d)
          this.write(
            {
              type: "message_delta",
              ...(d.text ? { text: d.text } : {}),
              ...(d.thinking ? { thinking: d.thinking } : {}),
            },
            d.at,
          );
      } else {
        const u = this.updates.get(key);
        this.updates.delete(key);
        if (u) this.writeUpdate("tool_update", u.event, u.at);
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.flush();
    this.closed = true;
  }

  private arm(): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, this.o.coalesceMs);
    this.timer.unref?.();
  }

  private handle(e: Bag): void {
    const type = e.type;
    // The two high-rate events are held; everything else orders after them.
    if (type === "message_update") {
      const sub = record(e.assistantMessageEvent);
      const piece = typeof sub?.delta === "string" ? sub.delta : "";
      const d = (this.delta ??= { at: this.at(), text: "", thinking: "" });
      if (!this.order.includes("")) this.order.push("");
      if (sub?.type === "text_delta") d.text += piece;
      else if (sub?.type === "thinking_delta") d.thinking += piece;
      this.arm();
      return;
    }
    if (type === "tool_execution_update") {
      const id = toolId(e);
      if (!this.updates.has(id)) this.order.push(id);
      this.updates.set(id, { at: this.at(), event: e });
      this.arm();
      return;
    }
    this.flush();
    switch (type) {
      case "agent_start":
        return this.write({ type: "agent_start" });
      case "agent_end":
        return this.write({
          type: "agent_end",
          ...(e.willRetry === true ? { will_retry: true } : {}),
        });
      case "agent_settled":
        return this.write({ type: "agent_settled", aborted: e.aborted === true });
      case "turn_start":
        return this.write({ type: "turn_start" });
      case "turn_end":
        return this.write({ type: "turn_end" });
      case "message_start": {
        const role = text(record(e.message)?.role);
        if (role !== "user" && role !== "assistant") return;
        const body = role === "user" ? userText(e.message) : undefined;
        return this.write({ type: "message_start", role, ...(body ? { text: body } : {}) });
      }
      case "message_end":
        return this.messageEnd(record(e.message));
      case "tool_execution_start":
        return this.toolStart(e);
      case "tool_execution_end":
        return this.toolEnd(e);
      case "queue_update":
        return this.write({
          type: "queue_update",
          steering: strings(e.steering),
          follow_up: strings(e.followUp),
        });
      case "compaction_start":
        return this.write({
          type: "compaction_start",
          reason: typeof e.reason === "string" ? e.reason : "",
        });
      case "compaction_end":
        return this.write({
          type: "compaction_end",
          reason: typeof e.reason === "string" ? e.reason : "",
          aborted: e.aborted === true,
          will_retry: e.willRetry === true,
          ...(typeof e.errorMessage === "string" ? { error: e.errorMessage } : {}),
        });
      case "auto_retry_start":
        return this.write({
          type: "retry",
          phase: "start",
          attempt: finiteNumber(e.attempt) ?? 0,
          ...(typeof e.errorMessage === "string" ? { error: e.errorMessage } : {}),
        });
      case "auto_retry_end":
        return this.write({
          type: "retry",
          phase: "end",
          attempt: finiteNumber(e.attempt) ?? 0,
          success: e.success === true,
          ...(typeof e.finalError === "string" ? { error: e.finalError } : {}),
        });
      default:
        // entry_appended, thinking_level_changed, bash_execution_update, ...:
        // nothing a viewer reads that the lines above do not already carry.
        return;
    }
  }

  private messageEnd(message: Bag | undefined): void {
    if (message?.role !== "assistant") return;
    const parts = Array.isArray(message.content) ? message.content.map(record) : [];
    const body = parts
      .filter((p): p is Bag => p?.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("\n");
    const calls = parts.flatMap((p) =>
      p?.type === "toolCall" && text(p.name) ? [text(p.name)!] : [],
    );
    const usage = record(message.usage) ? lensUsageOf(message.usage) : undefined;
    this.write({
      type: "message_end",
      role: "assistant",
      ...(body ? { text: body } : {}),
      ...(calls.length > 0 ? { tool_calls: calls } : {}),
      ...(typeof message.stopReason === "string" ? { stop_reason: message.stopReason } : {}),
      ...(typeof message.errorMessage === "string" ? { error: message.errorMessage } : {}),
      ...(usage
        ? {
            usage: {
              input: usage.input,
              output: usage.output,
              cache_read: usage.cacheRead,
              cost_usd: usage.cost,
            },
          }
        : {}),
    });
  }

  private toolStart(e: Bag): void {
    const tool = toolName(e);
    const args = toolArgs(e);
    const parent = text(e.parentToolCallId);
    const lens = isLensTool(tool);
    const executions = lens
      ? tool === LAUNCH_PLAN || tool === LENS_WAVE_TOOL
        ? (this.o.launchExecutions?.(args, this.o.env) ?? [])
        : subagentExecutions(args)
      : [];
    const preview = argPreview(args);
    this.write({
      type: "tool_start",
      id: toolId(e),
      tool,
      ...(parent ? { parent } : {}),
      ...(lens ? { args } : {}),
      ...(executions.length > 0 ? { executions } : {}),
      ...(preview ? { preview } : {}),
    });
  }

  /** The children of a call that changed since its previous line. */
  private changed(id: string, raw: readonly Bag[]): { n: number; results: LiveResult[] } {
    const before = this.sent.get(id) ?? [];
    const now: string[] = [];
    const results: LiveResult[] = [];
    raw.forEach((r, slot) => {
      const slim = slimResult(r, slot);
      const json = JSON.stringify(slim);
      now.push(json);
      if (before[slot] !== json) results.push(slim);
    });
    this.sent.set(id, now);
    return { n: raw.length, results };
  }

  private writeUpdate(type: "tool_update", e: Bag, at: string): void {
    const id = toolId(e);
    const partial = record(e.partialResult);
    const mode = record(partial?.details)?.mode;
    const parent = text(e.parentToolCallId);
    const { n, results } = this.changed(id, resultsOf(partial));
    this.write(
      {
        type,
        id,
        tool: toolName(e),
        ...(parent ? { parent } : {}),
        ...(typeof mode === "string" ? { mode } : {}),
        n,
        results,
      },
      at,
    );
  }

  private toolEnd(e: Bag): void {
    const id = toolId(e);
    const parent = text(e.parentToolCallId);
    const raw = resultsOf(e.result);
    const { n, results } = this.changed(id, raw);
    this.sent.delete(id);
    const cost = raw.reduce((sum, r) => sum + lensUsageOf(r.usage).cost, 0);
    this.write({
      type: "tool_end",
      id,
      tool: toolName(e),
      ...(parent ? { parent } : {}),
      is_error: e.isError === true,
      ...(finiteNumber(e.durationMs) !== undefined ? { duration_ms: e.durationMs as number } : {}),
      n,
      results,
      ...(cost > 0 ? { cost_usd: cost } : {}),
    });
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** The writer of one round's directory: a sink for the main session and one per
 * lens session. */
export function createLiveWriter(options: LiveWriterOptions): LiveWriter {
  const resolved = {
    now: options.now ?? Date.now,
    coalesceMs: options.coalesceMs ?? LIVE_COALESCE_MS,
    warn: options.warn ?? ((): void => {}),
    env: options.env ?? process.env,
    ...(options.launchExecutions ? { launchExecutions: options.launchExecutions } : {}),
  };
  return {
    dir: options.dir,
    main: (meta) => new Sink(join(options.dir, LIVE_MAIN_FILE), "main", meta, resolved),
    lens: (id, meta) =>
      new Sink(join(options.dir, lensLogName(id)), "lens", { ...meta, lensId: id }, resolved),
  };
}
