// procRuntime: the runtime port (port.ts) hosted as a `pi` child process.
//
// One session is a sequence of `pi -p --mode json` runs: the first turn sends
// the prompt on stdin, and each follow-up is a respawn that resumes the same pi
// session with `--continue`. Each child leads its own process group, so an abort
// or a timeout takes its lens children with it. There is no way into a running
// pi's turn, so `steer` is typed as unsupported here.
//
// Shared by the one-shot review (src/oneshot.ts), the bench and the defect
// judge (src/bench/runner.ts); `runPi` below is the one place a pi child is
// spawned for them.

import { spawn } from "node:child_process";
import {
  appendFileSync,
  createWriteStream,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { TurnBudget, termThenKill } from "./budget.js";
import {
  RuntimeUnsupportedError,
  type Delivery,
  type Runtime,
  type RuntimeSession,
  type SessionEvent,
  type SessionSpec,
  type SessionStats,
  type SubscribeOptions,
  type TurnOptions,
  type TurnResult,
} from "./port.js";
import { toolIsolation } from "./tooluid.js";

/** Feed `onLine` each LF-terminated line of `input` (a trailing CR dropped, a
 * last unterminated line delivered at end). pi's JSON mode frames events by
 * LF alone: node's readline also splits on U+2028/U+2029 (which JSON leaves
 * unescaped inside strings) and on a bare CR, cutting one event into
 * fragments that parse as nothing, so the $ cap never saw their cost. */
export function onLfLines(input: Readable, onLine: (line: string) => void): void {
  const decoder = new StringDecoder("utf8");
  let rest = "";
  const emit = (line: string): void => onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  input.on("data", (chunk: Buffer | string) => {
    rest += typeof chunk === "string" ? chunk : decoder.write(chunk);
    let nl: number;
    while ((nl = rest.indexOf("\n")) !== -1) {
      const line = rest.slice(0, nl);
      rest = rest.slice(nl + 1);
      emit(line);
    }
  });
  input.on("end", () => {
    rest += decoder.end();
    if (rest !== "") emit(rest);
    rest = "";
  });
}

/** How one pi process ended: a turn's result, by its older name. */
export type PiRun = TurnResult;

/** Process groups of the pi children runPi has running right now, so a signal
 * handler elsewhere (reviewdetach.ts runDetachedChild) can reach them: each pi
 * leads its own group, which a kill aimed at the driver's group never touches. */
const livePiGroups = new Set<number>();
let piHalted = false;

/** The process groups of the pi children running now: the heartbeat names them
 * so an outside watchdog can reach what the driver's own group does not hold. */
export function livePiGroupIds(): number[] {
  return [...livePiGroups];
}

/** Signal every running pi's process group (its lens children with it). */
export function killPiGroups(sig: NodeJS.Signals): void {
  for (const pgid of livePiGroups) {
    try {
      process.kill(-pgid, sig);
    } catch {
      // already gone
    }
  }
}

/** The run is being stopped: no further pi is spawned by this process. */
export function haltPi(): void {
  piHalted = true;
}

/** The ONE pi spawn (tests/single-shepherd.test.ts S2): the review round and
 * the defect judge both go through it, by way of procRuntime. */
export function runPi(
  argv: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  eventsPath: string,
  stderrPath: string,
  timeoutMs: number,
  bin: string,
  stdinText?: string,
  /** Hard stop: kill the process group once pi's own price for the run reaches
   * this many dollars. Omitted: no cap. */
  capUsd?: number,
  /** Hooks for a session that owns this run: each event line written to the
   * stream, and the group kill once the child exists. */
  hooks?: {
    onEvent?: (line: string) => void;
    /** A `*_update` line: held out of the events file, but a listener that asked
     * for updates hears it. */
    onUpdate?: (line: string) => void;
    onSpawn?: (kill: (sig: NodeJS.Signals) => void) => void;
  },
): Promise<PiRun> {
  return new Promise((resolve) => {
    if (piHalted) {
      resolve({ code: null, timedOut: false, streamError: "stopped" });
      return;
    }
    const launch = toolIsolation(bin, argv);
    if ("refused" in launch) {
      try {
        appendFileSync(stderrPath, `pi not started: ${launch.refused}\n`);
      } catch {
        // the refusal is in the result either way
      }
      resolve({ code: null, timedOut: false, streamError: launch.refused });
      return;
    }
    const events = createWriteStream(eventsPath, { flags: "a" });
    const errs = createWriteStream(stderrPath, { flags: "a" });
    // detached: its own process group, so a timeout kills the lens children
    // with it rather than orphaning six pi processes on the model API.
    const child = spawn(launch.bin, launch.argv, {
      cwd,
      env,
      stdio: [stdinText === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: true,
    });
    if (child.pid) livePiGroups.add(child.pid);
    let streamError: string | null = null;
    const kill = (sig: NodeJS.Signals): void => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        // already gone
      }
    };
    // A full disk must end THIS case as a recorded failure, not throw out of
    // the CLI and lose every case after it.
    const onStreamError = (e: Error): void => {
      streamError = String(e);
      kill("SIGKILL");
    };
    // The deadline and the $ cap: abort is SIGTERM to the group, dispose is
    // SIGKILL, which cannot be ignored, so there is no backstop beyond it.
    const budget = new TurnBudget(
      { abort: async () => kill("SIGTERM"), dispose: async () => kill("SIGKILL") },
      { timeoutMs, capUsd, graceMs: { cap: 5_000, timeout: 15_000 }, backstop: () => {} },
    );
    hooks?.onSpawn?.(kill);
    events.on("error", onStreamError);
    errs.on("error", onStreamError);
    // The round order goes in on stdin: pi -p takes piped stdin as the prompt,
    // and an argv string caps at 128 KiB (MAX_ARG_STRLEN).
    // A pi that dies before reading its prompt (bad model, auth refusal)
    // EPIPEs this write asynchronously: unheard, that error kills the CLI.
    if (stdinText !== undefined && child.stdin) {
      child.stdin.on("error", (e) => onStreamError(new Error(`prompt delivery: ${String(e)}`)));
      child.stdin.end(stdinText);
    }
    // `*_update` events re-emit a lens child's whole transcript on every
    // update — the file grows quadratically, so they are not written. The $ cap
    // does read them (a `subagent`/`launch_plan` update carries its children's
    // spend so far, so the cap bites before the call ends); the cost in the
    // file comes from `message_end` and `tool_execution_end`.
    onLfLines(child.stdout!, (line) => {
      budget.observe(line);
      if (
        line.startsWith('{"type":"tool_execution_update"') ||
        line.startsWith('{"type":"message_update"')
      ) {
        hooks?.onUpdate?.(line);
        return;
      }
      events.write(line + "\n");
      hooks?.onEvent?.(line);
    });
    child.stderr!.pipe(errs);
    child.on("error", (e) => {
      errs.write(`spawn error: ${String(e)}\n`);
    });
    // Resolve only once both files are flushed and closed: every caller reads
    // them synchronously the moment this resolves (the judge's answer is the
    // events file's LAST message_end).
    child.on("close", (code) => {
      budget.end();
      if (child.pid) livePiGroups.delete(child.pid);
      let open = 2;
      const settled = (): void => {
        if (--open === 0)
          resolve({
            code,
            timedOut: budget.tripped === "timeout",
            streamError,
            spentUsd: budget.spentUsd,
            capped: budget.tripped === "cap",
          });
      };
      for (const s of [events, errs]) {
        if (s.closed) settled();
        else {
          s.once("close", settled);
          s.end();
        }
      }
    });
  });
}

/** What a pi child is started with, from the spec: its CLI-only flags first,
 * then the fields the port names, in the order pi's own docs list them. The
 * turn's `-p` (and, after the first turn, `--continue`) is the session's. */
export function procArgv(spec: SessionSpec): string[] {
  return [
    ...(spec.cliFlags ?? []),
    ...(spec.tools ? ["--tools", spec.tools.join(",")] : []),
    "--model",
    spec.model,
    ...(spec.sessionDir !== undefined ? ["--session-dir", spec.sessionDir] : []),
    ...(spec.systemPromptFile !== undefined ? ["--system-prompt", spec.systemPromptFile] : []),
    ...(spec.extensions ?? []).flatMap((e) => ["--extension", e]),
    ...(spec.name !== undefined ? ["--name", spec.name] : []),
    "--mode",
    "json",
  ];
}

/** Grace between the terminating signal and the kill that cannot be ignored. */
const ABORT_GRACE_MS = 5_000;

class ProcSession implements RuntimeSession {
  private readonly argv: string[];
  private readonly listeners = new Set<(event: SessionEvent) => void>();
  /** The listeners that also hear the `*_update` events. */
  private readonly updateListeners = new Set<(event: SessionEvent) => void>();
  private readonly generatedId = randomUUID();
  private killRunning: ((sig: NodeJS.Signals) => void) | null = null;
  /** The turn in flight and everything queued behind it. */
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private prompted = false;
  private disposed = false;
  private turns = 0;
  private spentUsd = 0;
  private last: TurnResult | null = null;

  constructor(
    private readonly spec: SessionSpec,
    private readonly bin: string,
  ) {
    this.argv = procArgv(spec);
  }

  get id(): string {
    const file = this.sessionFile;
    if (file) {
      try {
        const head = JSON.parse(readFileSync(file, "utf8").split("\n", 1)[0] ?? "") as {
          id?: unknown;
        };
        if (typeof head.id === "string" && head.id) return head.id;
      } catch {
        // an unreadable header: the generated id stands
      }
    }
    return this.generatedId;
  }

  /** The newest JSONL pi wrote under the session dir. */
  get sessionFile(): string | null {
    const dir = this.spec.sessionDir;
    if (dir === undefined || !existsSync(dir)) return null;
    let best: { file: string; mtime: number } | null = null;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const file = join(dir, f);
      const mtime = statSync(file).mtimeMs;
      if (!best || mtime > best.mtime) best = { file, mtime };
    }
    return best?.file ?? null;
  }

  async prompt(text: string, options?: TurnOptions): Promise<TurnResult> {
    if (this.prompted)
      throw new RuntimeUnsupportedError(
        "a second prompt (a process session continues by followUp)",
      );
    this.prompted = true;
    return this.turn(["-p"], text, options);
  }

  async followUp(text: string, options?: TurnOptions): Promise<Delivery> {
    if (!this.prompted) throw new Error("followUp before the first prompt");
    const run = this.turn(["--continue", "-p", text], undefined, options);
    if (this.pending > 1) {
      // A turn is in flight: this one runs behind it. Its result lands in stats().
      run.catch(() => {});
      return { status: "queued" };
    }
    return { status: "handled", result: await run };
  }

  steer(): Promise<Delivery> {
    return Promise.resolve({
      status: "unsupported",
      reason:
        "a pi process takes its next message at the next turn; there is no way into the running one",
    });
  }

  async abort(): Promise<void> {
    if (this.killRunning) termThenKill(this.killRunning, ABORT_GRACE_MS);
  }

  subscribe(listener: (event: SessionEvent) => void, options?: SubscribeOptions): () => void {
    this.listeners.add(listener);
    if (options?.updates) this.updateListeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      this.updateListeners.delete(listener);
    };
  }

  stats(): SessionStats {
    return { turns: this.turns, busy: this.pending > 0, spentUsd: this.spentUsd, last: this.last };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // Queued follow-ups fail fast (disposed), the running turn is killed.
    this.killRunning?.("SIGKILL");
    await this.tail.catch(() => {});
  }

  /** Queue one pi run behind whatever is in flight. `flags` end the argv: the
   * first turn's message is on stdin, a follow-up's follows its `-p`. */
  private turn(
    flags: string[],
    stdinText: string | undefined,
    options: TurnOptions | undefined,
  ): Promise<TurnResult> {
    if (this.disposed) return Promise.reject(new Error("session disposed"));
    const spec = this.spec;
    this.pending++;
    const run = this.tail.then(async (): Promise<TurnResult> => {
      if (this.disposed) return { code: null, timedOut: false, streamError: "disposed" };
      const r = await runPi(
        [...this.argv, ...flags],
        spec.env,
        spec.cwd,
        spec.eventsFile,
        spec.stderrFile,
        options?.timeoutMs ?? spec.limits.timeoutMs,
        this.bin,
        stdinText,
        options?.capUsd ?? spec.limits.capUsd,
        {
          onSpawn: (kill) => {
            this.killRunning = kill;
          },
          onEvent: (line) => this.emit(line, this.listeners),
          onUpdate: (line) => this.emit(line, this.updateListeners),
        },
      );
      this.killRunning = null;
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

  private emit(line: string, listeners: ReadonlySet<(event: SessionEvent) => void>): void {
    if (listeners.size === 0) return;
    let event: SessionEvent;
    try {
      event = JSON.parse(line) as SessionEvent;
    } catch {
      return;
    }
    for (const l of listeners) {
      try {
        l(event);
      } catch {
        // a listener's failure is not the session's
      }
    }
  }
}

const DEFAULT_BIN = "pi";

/** The runtime that hosts a session as `pi` child processes. `bin` is the pi
 * executable (a PATH lookup by default). */
export function procRuntime(options: { bin?: string } = {}): Runtime {
  const bin = options.bin ?? DEFAULT_BIN;
  return {
    create(spec) {
      if (spec.agentsFiles && spec.agentsFiles.length > 0)
        // pi finds context files by walking up from its cwd; handing it others
        // would mean writing them into a checkout. Refused, never dropped.
        return Promise.reject(new RuntimeUnsupportedError("agentsFiles on a process session"));
      return Promise.resolve(new ProcSession(spec, bin));
    },
    resume() {
      return Promise.reject(new RuntimeUnsupportedError("resume on a process session"));
    },
  };
}
