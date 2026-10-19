// sdkRuntime: the runtime port (port.ts) hosted in-process on the pi SDK, through
// PiHost (pisdk.ts, the only module that builds an SDK session).
//
// One session is one live AgentSession. Turns run one at a time, in order: the
// first is `prompt`, each later one a `followUp` that waits behind the turn in
// flight, and a `steer` goes into the turn in flight through pi's own steering
// queue (the one thing a process runtime cannot do).
//
// The main session is file-backed: with `sessionFile` in the spec the JSONL is
// written at exactly that path (or under `sessionDir`, where pi names the file),
// so a finished session opens in pi and resumes by id. Without either it is in
// memory and `sessionFile` is null.
//
// `subscribe` and the events file carry the stream a `pi --mode json` child
// prints, line for line: the session header first, then every session event as
// JSON, with the `message_update` and `tool_execution_update` re-emissions left
// out (they restate a whole transcript on each update; procruntime.ts drops
// them the same way). The spend and the dollar cap read the same events, so
// bench/aacr.ts parses a file from either runtime unchanged. What pi itself
// prints to stdout in that mode is only this stream; nothing else is faked.

import {
  appendFileSync,
  closeSync,
  createWriteStream,
  existsSync,
  openSync,
  readFileSync,
} from "node:fs";
import type { WriteStream } from "node:fs";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { splitModelSpec, type ThinkingLevel } from "../config.js";
import { TurnBudget } from "./budget.js";
import type { HostSessionSpec, PiHost } from "./pisdk.js";
import {
  RuntimeUnsupportedError,
  type Delivery,
  type Runtime,
  type RuntimeSession,
  type SessionEvent,
  type SessionSpec,
  type SessionStats,
  type TurnOptions,
  type TurnResult,
} from "./port.js";

/** What only the route knows about a session, beyond the port's plain data: the
 * extension factories and tools it carries (P3's factories, the lens tool), the
 * tool allowlist those tools join, the model's bash environment, the context
 * files it hands over as data, the thinking level, and text appended to pi's own
 * system prompt (a leaf's body). Called once per session. A field here wins over
 * the spec's own. */
export type SessionExtras = Pick<
  HostSessionSpec,
  | "extensions"
  | "customTools"
  | "tools"
  | "agentsFiles"
  | "bashEnv"
  | "thinkingLevel"
  | "appendSystemPrompt"
>;

export interface SdkRuntimeOptions {
  /** The route's own pieces for a spec. Without it a spec that names
   * `extensions` (paths) is refused: an SDK session loads factories, not files. */
  extras?: (spec: SessionSpec) => SessionExtras;
}

/** Grace between a hit limit's abort and the dispose that follows it. */
const GRACE_MS = { cap: 5_000, timeout: 15_000 };

/** The lines `pi --mode json` writes that carry no information a reader wants and
 * grow with the transcript (procruntime.ts drops the same two). */
function isUpdate(event: AgentSessionEvent): boolean {
  return event.type === "message_update" || event.type === "tool_execution_update";
}

const stripBom = (s: string): string => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

class SdkSession implements RuntimeSession {
  private readonly listeners = new Set<(event: SessionEvent) => void>();
  private readonly events: WriteStream;
  private readonly unsubscribe: () => void;
  /** The turn in flight and everything queued behind it. */
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private prompted = false;
  private disposed = false;
  private turns = 0;
  private spentUsd = 0;
  private last: TurnResult | null = null;
  private budget: TurnBudget | null = null;
  private stopped = false;
  private streamError: string | null = null;
  private headerWritten = false;

  constructor(
    private readonly spec: SessionSpec,
    private readonly session: AgentSession,
    /** A reopened session: its history is the first turn, so a message may
     * follow it with no prompt. */
    private readonly resumed = false,
  ) {
    this.events = createWriteStream(spec.eventsFile, { flags: "a" });
    // A full disk must end THIS turn as a recorded failure, not throw out of the
    // process: the same contract runPi has.
    this.events.on("error", (e) => {
      this.streamError = String(e);
      void this.abort();
    });
    this.unsubscribe = session.subscribe((event) => this.onEvent(event));
  }

  get id(): string {
    return this.session.sessionId;
  }

  get sessionFile(): string | null {
    const file = this.session.sessionFile;
    // pi writes the file from the first user message on.
    return file !== undefined && existsSync(file) ? file : null;
  }

  async prompt(text: string, options?: TurnOptions): Promise<TurnResult> {
    if (this.prompted)
      throw new RuntimeUnsupportedError("a second prompt (a session continues by followUp)");
    this.prompted = true;
    // The process runtime hands the first message to pi on stdin, and pi trims
    // piped stdin (main.js readPipedStdin): the provider sees the trimmed text.
    // A follow-up rides `-p`, which pi does not trim, so only this one is.
    return this.turn(text.trim(), options);
  }

  async followUp(text: string, options?: TurnOptions): Promise<Delivery> {
    if (!this.prompted && !this.resumed) throw new Error("followUp before the first prompt");
    this.prompted = true;
    const run = this.turn(text, options);
    if (this.pending > 1) {
      // A turn is in flight: this one runs behind it. Its result lands in stats().
      run.catch(() => {});
      return { status: "queued" };
    }
    return { status: "handled", result: await run };
  }

  async steer(text: string): Promise<Delivery> {
    // Nothing running: there is no turn to steer, so the message starts one.
    if (this.pending === 0 || this.disposed) return this.followUp(text);
    await this.session.steer(text);
    return { status: "queued" };
  }

  async abort(): Promise<void> {
    if (this.pending === 0) return;
    this.stopped = true;
    await this.session.abort().catch(() => {});
  }

  subscribe(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  stats(): SessionStats {
    return { turns: this.turns, busy: this.pending > 0, spentUsd: this.spentUsd, last: this.last };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // Queued follow-ups fail fast (disposed); the running turn is aborted.
    if (this.pending > 0) {
      this.stopped = true;
      await this.session.abort().catch(() => {});
    }
    await this.tail.catch(() => {});
    this.unsubscribe();
    try {
      this.session.dispose();
    } catch {
      // already disposed (the host's own sweep, a budget's dispose step)
    }
    await new Promise<void>((resolve) => this.events.end(resolve));
  }

  /** Queue one turn behind whatever is in flight. */
  private turn(text: string, options: TurnOptions | undefined): Promise<TurnResult> {
    if (this.disposed) return Promise.reject(new Error("session disposed"));
    const spec = this.spec;
    this.pending++;
    const run = this.tail.then(async (): Promise<TurnResult> => {
      if (this.disposed) return { code: null, timedOut: false, streamError: "disposed" };
      const r = await this.runTurn(
        text,
        options?.timeoutMs ?? spec.limits.timeoutMs,
        options?.capUsd ?? spec.limits.capUsd,
      );
      this.turns++;
      this.spentUsd += r.spentUsd ?? 0;
      this.last = r;
      return r;
    });
    const settled = (): void => {
      this.pending--;
    };
    this.tail = run.then(settled, settled);
    return run;
  }

  private async runTurn(
    text: string,
    timeoutMs: number,
    capUsd: number | undefined,
  ): Promise<TurnResult> {
    this.stopped = false;
    const budget = new TurnBudget(
      {
        abort: () => this.session.abort(),
        dispose: async () => this.session.dispose(),
      },
      { timeoutMs, capUsd, graceMs: GRACE_MS },
    );
    this.budget = budget;
    this.writeHeader();
    let failure: string | null = null;
    try {
      await this.session.prompt(text);
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
      appendFileSync(this.spec.stderrFile, `${failure}\n`);
    } finally {
      budget.end();
      this.budget = null;
    }
    // Callers read the events file the moment the turn resolves: every line
    // written so far must be on disk by then.
    await new Promise<void>((resolve) => this.events.write("", () => resolve()));
    const tripped = budget.tripped;
    return {
      // No exit status in process: 0 when the turn ran to its end, null when it
      // was stopped (by us, or a limit), 1 when pi refused or failed it.
      code: tripped !== null || this.stopped ? null : failure !== null ? 1 : 0,
      timedOut: tripped === "timeout",
      streamError: this.streamError,
      spentUsd: budget.spentUsd,
      capped: tripped === "cap",
    };
  }

  /** The session header leads the stream, as it leads `pi --mode json`'s stdout. */
  private writeHeader(): void {
    if (this.headerWritten) return;
    this.headerWritten = true;
    const header = this.session.sessionManager.getHeader();
    if (header) this.write(JSON.stringify(header));
  }

  private onEvent(event: AgentSessionEvent): void {
    // The cap reads the lens children's spend off the updates, so it sees them;
    // the file and the listeners do not.
    this.budget?.observe(event);
    if (isUpdate(event)) return;
    this.write(JSON.stringify(event));
  }

  private write(line: string): void {
    this.events.write(line + "\n");
    if (this.listeners.size === 0) return;
    let parsed: SessionEvent;
    try {
      parsed = JSON.parse(line) as SessionEvent;
    } catch {
      return;
    }
    for (const l of this.listeners) {
      try {
        l(parsed);
      } catch {
        // a listener's failure is not the session's
      }
    }
  }
}

/** The runtime that hosts a session in this process, on `host`'s pi SDK. */
export function sdkRuntime(host: PiHost, options: SdkRuntimeOptions = {}): Runtime {
  /** One session from a spec, new or reopened. `persist` is the one place the
   * two differ. */
  async function open(
    spec: SessionSpec,
    persist: HostSessionSpec["persist"],
    resumed: boolean,
  ): Promise<RuntimeSession> {
    if (!options.extras && spec.extensions && spec.extensions.length > 0)
      // An SDK session loads extension factories, which a route hands it; a
      // path would mean an unrelated loader. Refused, never dropped.
      throw new RuntimeUnsupportedError("extension paths on an SDK session (pass factories)");
    // The two files exist from the start, as they do for a spawned pi.
    for (const f of [spec.eventsFile, spec.stderrFile]) closeSync(openSync(f, "a"));
    // `provider/id:level` is pi's spelling of a model and its thinking level
    // (--model takes it whole); the host takes them apart.
    const { model, thinking } = splitModelSpec(spec.model);
    const hostSpec: HostSessionSpec = {
      cwd: spec.cwd,
      env: spec.env,
      model,
      ...(thinking ? { thinkingLevel: thinking as ThinkingLevel } : {}),
      ...(spec.systemPromptFile !== undefined
        ? { systemPrompt: stripBom(readFileSync(spec.systemPromptFile, "utf8")) }
        : {}),
      ...(spec.agentsFiles ? { agentsFiles: spec.agentsFiles } : {}),
      ...(spec.tools ? { tools: spec.tools } : {}),
      ...(persist ? { persist } : {}),
      onExtensionError: (e) =>
        appendFileSync(spec.stderrFile, `Extension error (${e.extensionPath}): ${e.error}\n`),
      ...options.extras?.(spec),
    };
    return new SdkSession(spec, await host.makeSession(hostSpec), resumed);
  }

  return {
    create(spec) {
      if (spec.sessionFile !== undefined && spec.sessionDir !== undefined)
        return Promise.reject(new Error("a spec names a sessionFile or a sessionDir, not both"));
      return open(
        spec,
        spec.sessionFile !== undefined
          ? { sessionFile: spec.sessionFile }
          : spec.sessionDir !== undefined
            ? { sessionDir: spec.sessionDir }
            : undefined,
        false,
      );
    },
    resume(sessionFile, spec) {
      // SessionManager.open on the existing JSONL: the same id (the provider's
      // cache key), later turns appended to the same file. The file is named by
      // the argument; a spec that names another one, or a directory, is a bug.
      if (spec.sessionDir !== undefined)
        return Promise.reject(new Error("a resume names its file, not a sessionDir"));
      if (spec.sessionFile !== undefined && spec.sessionFile !== sessionFile)
        return Promise.reject(
          new Error(`a resume of ${sessionFile} cannot name another sessionFile`),
        );
      return open(spec, { resumeFile: sessionFile }, true);
    },
  };
}
