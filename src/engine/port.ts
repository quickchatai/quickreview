// The runtime port: the one narrow seam between the engine and whatever hosts a
// pi session. A route builds a SessionSpec (plain data), asks a Runtime for a
// session, and drives it through RuntimeSession. The in-process SDK runtime
// (sdkruntime.ts) is the one implementation behind the port.
//
// What a runtime cannot do is said in the type, not hidden: a `steer` or a
// `resume` it has no way to honour comes back as a typed "unsupported", never a
// silent no-op.

/** A context file (AGENTS.md style) handed to the session as data. The runtime
 * never writes it into a checkout. */
export interface AgentsFile {
  path: string;
  content: string;
}

/** The limits one turn runs under. A hit ends the turn, and the result says so. */
export interface TurnLimits {
  /** Wall clock for the turn; the session is terminated when it passes. */
  timeoutMs: number;
  /** Hard stop in dollars: the turn is killed once its spend reaches this.
   * Omitted: no cap. */
  capUsd?: number;
}

/** A per-turn override of the session's limits (a follow-up's budget is what
 * is left of the round's, not the session's). */
export type TurnOptions = Partial<TurnLimits>;

/** Everything a runtime needs to start a session. Plain data: no handles, no
 * closures, so a spec can be logged, compared and rebuilt. */
export interface SessionSpec {
  /** The session's working directory. */
  cwd: string;
  /** The environment the session's tools see, and nothing else. */
  env: Readonly<Record<string, string | undefined>>;
  model: string;
  /** A file holding the system prompt. */
  systemPromptFile?: string;
  /** The extensions the session loads, absolute paths. It loads these and no
   * others when the runtime is told to discover nothing. */
  extensions?: readonly string[];
  /** The tool allowlist. Omitted: the runtime's default set. */
  tools?: readonly string[];
  /** The session's name, as the harness shows it. */
  name?: string;
  /** Where the session persists its JSONL. Omitted: the session is not
   * persisted by this spec (a process runtime is then told so through
   * `cliFlags`). */
  sessionDir?: string;
  /** The exact JSONL path of a persisted in-process session. */
  sessionFile?: string;
  /** Context files handed to the session (D34), never written into a checkout.
   * A runtime that cannot deliver them refuses the spec. */
  agentsFiles?: readonly AgentsFile[];
  /** Where the session's event stream is written, one JSON event per line. */
  eventsFile: string;
  /** Where the session's diagnostic output is written. */
  stderrFile: string;
  limits: TurnLimits;
  /** Flags only the pi command line has, placed ahead of every other flag
   * (resource-discovery switches, no-session). An in-process runtime builds an
   * isolated session from the fields above and takes none of these. */
  cliFlags?: readonly string[];
}

/** How a turn ended. */
export interface TurnResult {
  code: number | null;
  timedOut: boolean;
  streamError: string | null;
  /** pi's own price for what the turn spent (every lens child included). */
  spentUsd?: number;
  /** The turn was killed because its spend reached the cap. */
  capped?: boolean;
}

/** How one pi run ended: a turn's result, by its older name. */
export type PiRun = TurnResult;

/** One event of the stream, as the harness wrote it. */
export type SessionEvent = Record<string, unknown>;

/** What a listener hears. By default the stream `pi --mode json` writes to the
 * events file, which leaves out the `message_update` and `tool_execution_update`
 * re-emissions (each restates a whole transcript). `updates` adds them: the live
 * log (src/live/) coalesces them, a listener must not mutate what it is given. */
export interface SubscribeOptions {
  updates?: boolean;
}

export interface SessionStats {
  /** Turns that have settled. */
  turns: number;
  /** A turn is running or queued. */
  busy: boolean;
  /** Spend across every settled turn. */
  spentUsd: number;
  /** The most recent settled turn. */
  last: TurnResult | null;
}

/** What `followUp` and `steer` did with the message.
 *  - queued: it will be delivered; the session is busy now.
 *  - handled: it was delivered and its turn has settled (`result`).
 *  - unsupported: this runtime has no way to deliver it. */
export type Delivery =
  | { status: "queued" }
  | { status: "handled"; result: TurnResult }
  | { status: "unsupported"; reason: string };

/** What a compaction did. A compaction is an optimisation, never owed work: a
 * failure is reported, not thrown. */
export type CompactOutcome =
  { status: "compacted"; tokensBefore: number } | { status: "failed"; reason: string };

export interface RuntimeSession {
  /** The session's id. */
  readonly id: string;
  /** The persisted JSONL, once there is one; null before that or when the
   * session is not persisted. */
  readonly sessionFile: string | null;
  /** Send the first message and run the turn to its end. */
  prompt(text: string, options?: TurnOptions): Promise<TurnResult>;
  /** A message for after the current work: on an idle session it runs the next
   * turn now. */
  followUp(text: string, options?: TurnOptions): Promise<Delivery>;
  /** A message into the turn in flight, if the runtime can reach it. */
  steer(text: string): Promise<Delivery>;
  /** Stop the running turn (and everything it started). */
  abort(): Promise<void>;
  /** Hear each event as it is written; returns the unsubscribe. */
  subscribe(listener: (event: SessionEvent) => void, options?: SubscribeOptions): () => void;
  /** Compact the conversation once nothing is in flight, through pi's own
   * `compact()` (so the session's `session_before_compact` extensions, ledger-pin
   * among them, run). Only a runtime that hosts the session in this process can:
   * absent elsewhere. */
  compact?(): Promise<CompactOutcome>;
  stats(): SessionStats;
  /** Release the session; aborts a running turn. Idempotent. */
  dispose(): Promise<void>;
}

export interface Runtime {
  create(spec: SessionSpec): Promise<RuntimeSession>;
  /** Reopen a persisted session under its own id, so the next turn continues
   * it. Declared by the port; the in-process runtime implements it. */
  resume(sessionFile: string, spec: SessionSpec): Promise<RuntimeSession>;
}

/** A runtime was asked for something it cannot do (and says what). */
export class RuntimeUnsupportedError extends Error {
  constructor(what: string) {
    super(`unsupported by this runtime: ${what}`);
    this.name = "RuntimeUnsupportedError";
  }
}
