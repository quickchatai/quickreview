// The bot's per-round worker (P8.3, D22): one Node process that serves ONE round
// of one PR and exits.
//
//     node dist/src/botworker.js --command <id> --mode round|answer
//
// `--mode answer` (P8.17, rule 9's second exception) serves an operator's message
// to an idle PR instead of a round: the same handshake, login and resume under the
// same session id, then ONE user turn marked with operator provenance, and the
// reply goes back in the `done` event. Its tools are the read-only repo tools and
// the memory lookups (src/engine/botsdk.ts `answer`), no lens tool, no verdict,
// and no wave, wake or permit: the daemon's own wakes stay held for the round.
// Only a message the operator marked may-post also gets bash, for the post
// scripts, and the capability they read; the daemon refuses any other post in any
// case. It compacts before it exits like a round, and the daemon bounds it by
// `[daemon] answer_timeout_s` and `answer_cap_usd`. The numbered round below is the
// round mode's; an answer runs 1 to 3, the one turn, then 6 and 7.
//
// The daemon starts it with the command's capability on an inherited fd
// (QCR_IPC_CAP_FD, src/ipc/capability.ts), the socket path, the command id and
// the generation in env (QCR_IPC_*), and a small allowlisted env of its own. It
// holds no GitHub credential (rule 3: the bot mints per command, and every post
// goes to the daemon's one gate over the socket) and it never opens state.db:
// what it needs to know arrives through `worker.spec`, what it records goes
// back as events, and the held wakes come through `wakes.take`
// (src/ipc/workerspec.ts). tests/botworker-fence.test.ts holds the last claim
// by walking the import closure.
//
// A round, in order:
//   1. connect, ask for the spec, and verify the payload against the sha256 the
//      daemon recorded at dispatch;
//   2. borrow the login: a refresh-blanked copy read once from the agent dir the
//      login refresher owns (P8.22), refused when the token would expire inside
//      this worker's wall-clock cap. The worker never refreshes it;
//   3. open the PR's session: resume the newest JSONL under its session dir
//      under the SAME id (the provider's cache key), or start one at birth;
//   4. start the planned discovery wave (the engine, rule 9), then send the
//      round order. A JSONL that already holds this command's marker means an
//      earlier worker took the order: this worker continues instead of sending
//      it again (marker idempotency, as the inject bridge's receipt works);
//   5. deliver the wakes held while the round ran, in arrival order;
//   6. compact (ledger-pin pins the review ledger through pi's own compact());
//   7. report usage and done, and exit.
//
// Throughout, the daemon may push the operator's controls (P8.12, src/botcontrol.ts):
// a steer lands in the turn in flight, a follow-up behind the run, an abort stops the
// session and the passes it started and ends the round with the aborted exit code.
// Each is acked once over `control.ack`. The turns a control starts are waited for
// before the wakes and again before the compaction.
//
// Exit codes: 0 the round was served (a verdict may or may not have been
// written: `done` says), 1 a turn failed (timeout, cap, stream, refused
// login), 2 bad usage, 3 the handshake or the
// payload could not be trusted, 4 the login was refused up front, 5 the session
// could not be opened, 6 the operator aborted the round, 75 the daemon went away, 76 the daemon fenced this
// worker (a stale generation or an inactive command), 143 terminated.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EventCostMeter } from "./bench/cost.js";
import { CONTEXT_PACK_FILE } from "./contextpack.js";
import {
  AuthError,
  classifyAuthFailure,
  engineCredentials,
  type EngineAuth,
} from "./engine/auth.js";
import { agentDirSettings } from "./engine/agentdir.js";
import { COMMIT_VERDICT_RE } from "./engine/answerguard.js";
import { NO_LENS, botSdkRuntime } from "./engine/botsdk.js";
import { engineLensTools, type EngineLensTools } from "./engine/lens/engine-tools.js";
import type { Permits } from "./engine/lens/permits.js";
import { planLaunch, type LaunchUnit } from "./engine/lens/launch-plan.js";
import { engineLensSection } from "./engine/lens/section.js";
import { LensWave, launchWave, type WaveRow } from "./engine/lens/wave.js";
import type { LensRun } from "./engine/lens/runlens.js";
import { stopLiveSessions } from "./engine/livesessions.js";
import { LENS_SESSIONS_DIR } from "./engine/openable.js";
import { PiHost, headerId, type PiHostOptions } from "./engine/pisdk.js";
import type { RuntimeSession, SessionSpec, TurnOptions, TurnResult } from "./engine/port.js";
import { engineLensConfig } from "./engine/reviewsdk.js";
import { credentialPaths, loginSourceDirs } from "./engine/toolfence.js";
import { TOOL_UMASK, checkToolUid, toolIdsOf } from "./engine/tooluid.js";
import { connectFromEnv, type IpcClient } from "./ipc/client.js";
import { brokerPermits } from "./ipc/permits.js";
import { IpcError, type IpcEventKind } from "./ipc/protocol.js";
import {
  WAKES_ACK_OP,
  WAKES_TAKE_OP,
  WORKER_MODES,
  WORKER_SPEC_OP,
  parseWakesTaken,
  parseWorkerSpec,
  lensDirOf,
  roundPassesDir,
  type WorkerMode,
  type WorkerSpec,
} from "./ipc/workerspec.js";
import { WorkerControls, ackSender } from "./botcontrol.js";
import { MAX_REPLY_CHARS, operatorMayPost } from "./operatormessage.js";
import { sessionCommandMarker } from "./session-command.js";
import { verifiedPayload } from "./session-command-payload.js";
import { newestSessionFile } from "./sessionjsonl.js";

export const EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  handshake: 3,
  auth: 4,
  session: 5,
  aborted: 6,
  lost: 75,
  fenced: 76,
  terminated: 143,
} as const;

/** The most rounds of `wakes.take` one worker serves: wakes that arrive while it
 * delivers are served too, but a flood cannot keep a round open for ever. */
const MAX_WAKE_PASSES = 20;
/** How long the round waits for the wave's rows to settle once it has ended
 * them (each ends its session and writes its ledger line). */
const WAVE_SETTLE_MS = 15_000;
const DEFAULT_HEARTBEAT_MS = 15_000;
/** A turn is never given less than this, so a nearly spent cap still runs it. */
const MIN_TURN_MS = 1_000;
/** The names of the worker's own env the main session's bash needs for the post
 * shims (src/ipc/postshim.ts). Never given to a lens pass. */
const IPC_ENV = [
  "QCR_IPC_SOCKET",
  "QCR_IPC_CAP_FD",
  "QCR_IPC_COMMAND_ID",
  "QCR_IPC_GENERATION",
] as const;

/** The names of a round's identity in the session env. An answer has no round, so
 * the model's bash (and the post scripts it may run) carries none of them: a post
 * would claim a round and the daemon would refuse it. */
const ROUND_ONLY_ENV = ["QCR_ROUND_NO", "QCR_EXPECTED_HEAD", "QCR_POSTING_KEY"] as const;

export interface WorkerArgs {
  command: string;
  mode: WorkerMode;
}

export function parseWorkerArgs(argv: readonly string[]): WorkerArgs | { error: string } {
  let command: string | undefined;
  let mode: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--command") command = argv[++i];
    else if (a === "--mode") mode = argv[++i];
    else return { error: `unknown argument ${JSON.stringify(a)}` };
  }
  if (!command) return { error: "--command <id> is required" };
  if (!mode || !WORKER_MODES.includes(mode as WorkerMode))
    return { error: "--mode must be round or answer" };
  return { command, mode: mode as WorkerMode };
}

export interface WorkerDeps {
  /** The worker's own process env. */
  env: NodeJS.ProcessEnv;
  /** Opens the daemon connection. Omitted: from env and the inherited fd. */
  connect?: () => Promise<IpcClient>;
  /** Builds the host (test seam: the faux provider). Omitted: a PiHost that
   * owns this process, over the spec's agent dir and the borrowed login. */
  makeHost?: (options: PiHostOptions) => Promise<PiHost>;
  /** Test seam over the OpenViking config the session's extension is given. */
  openViking?: Parameters<typeof botSdkRuntime>[1]["openViking"];
  now?: () => number;
  /** Diagnostics: one line, no secret. */
  log?: (line: string) => void;
}

/** A user turn's closing marker, in the inject bridge's own spelling. */
function withMarker(text: string, marker: string): string {
  return `${text}${text.endsWith("\n") ? "\n" : "\n\n"}${marker}`;
}

export const wakeMarker = (batchId: string): string => `<!-- qcr-wake:${batchId} -->`;

/** What a continuing worker tells the session. */
export function continuationText(marker: string): string {
  return [
    "The worker that was running this round stopped before the round finished; this conversation is intact. Carry on from where it stopped.",
    "",
    "Before you repeat a step, check what the round already produced: files you wrote, lens results you read, a review that was posted. Never post the same review twice (the post scripts tell you when it is already posted). A planned lens whose result you did not read ran in the worker that is gone: run `lens_wave` over the round's task directory again for it.",
    "",
    `The round order is the message above that carries ${marker}.`,
  ].join("\n");
}

/** What a continuing answer worker tells the session. */
export function answerContinuationText(marker: string): string {
  return [
    "The worker that was answering the operator's message stopped before it finished; this conversation is intact. Finish the answer.",
    "",
    "Before you repeat a step, check what is already done: a review or reply you posted stays posted (the post scripts tell you when it is). Never post the same thing twice.",
    "",
    `The operator's message is the one above that carries ${marker}.`,
  ].join("\n");
}

/** Does the session JSONL already hold `marker`? An unreadable file holds none. */
export function jsonlHasMarker(file: string, marker: string): boolean {
  try {
    return readFileSync(file, "utf8").includes(marker);
  } catch {
    return false;
  }
}

const POST_RE = /(?:^|[\s/;&|(])(post-review|approve-pr|reply-thread)\.sh(?:\s|$)/;

/** What the daemon wants to know of the session's work: a verdict committed, a
 * post made, and whether the model's last answer was the provider's failure.
 * Observed off the session's events, the way the supervisor reads a round's
 * progress, never off files. */
class RoundWatch {
  verdictWritten = false;
  posted = 0;
  /** The provider's error on the newest assistant message, if that is how it ended. */
  lastError: string | undefined;
  /** The text of the newest assistant message that did not end in a tool call:
   * what the model said last, which is an answer's reply. */
  replyText: string | undefined;
  private readonly commands = new Map<string, string>();

  constructor(private readonly report: (kind: IpcEventKind, body?: unknown) => void) {}

  hear(event: Record<string, unknown>): void {
    if (event["type"] === "message_end") {
      const message = event["message"] as
        { role?: unknown; stopReason?: unknown; errorMessage?: unknown } | undefined;
      if (message?.role === "assistant") {
        const full = event["message"] as { content?: unknown; stopReason?: unknown };
        if (full.stopReason !== "toolUse" && full.stopReason !== "error")
          this.replyText = textOf(full.content);
      }
      if (message?.role === "assistant")
        this.lastError =
          message.stopReason === "error"
            ? (typeof message.errorMessage === "string"
                ? message.errorMessage
                : "the provider returned an error"
              ).slice(0, 300)
            : undefined;
      return;
    }
    const id = event["toolCallId"];
    if (typeof id !== "string") return;
    if (event["type"] === "tool_execution_start" && event["toolName"] === "bash") {
      const command = (event["args"] as { command?: unknown } | null | undefined)?.command;
      if (typeof command === "string") this.commands.set(id, command);
      return;
    }
    if (event["type"] !== "tool_execution_end") return;
    const command = this.commands.get(id);
    this.commands.delete(id);
    if (command === undefined || event["isError"] !== false) return;
    if (COMMIT_VERDICT_RE.test(command)) {
      this.verdictWritten = true;
      this.report("verdict_written", {});
    }
    const post = POST_RE.exec(command);
    if (post) {
      this.posted++;
      this.report("posted", { script: `${post[1]}.sh` });
    }
  }
}

/** The text blocks of an assistant message's content, joined. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((b: unknown) =>
      typeof b === "object" &&
      b !== null &&
      (b as { type?: unknown }).type === "text" &&
      typeof (b as { text?: unknown }).text === "string"
        ? [(b as { text: string }).text]
        : [],
    )
    .join("\n")
    .trim();
}

/** `: <the file's last line>` for a failure's reason, or nothing. */
function lastLineOf(file: string): string {
  try {
    const line = readFileSync(file, "utf8").trimEnd().split("\n").at(-1)?.trim();
    return line ? `: ${line.slice(0, 300)}` : "";
  } catch {
    return "";
  }
}

class Stop extends Error {
  constructor(
    readonly exit: number,
    readonly reason: string,
  ) {
    super(reason);
  }
}

/** The PR's session, opened. */
interface Opened {
  session: RuntimeSession;
  /** The round's lens tools; none for an answer worker. */
  tools: EngineLensTools | undefined;
  resumed: boolean;
  /** The JSONL it was resumed from; undefined at birth. */
  file: string | undefined;
  /** The JSONL already holds this command's marker: an earlier worker took the order. */
  continuing: boolean;
}

/** Serve one round. Resolves to the exit code; a failed round is a returned
 * code and a `failed` event, never a throw. */
export async function runBotWorker(args: WorkerArgs, deps: WorkerDeps): Promise<number> {
  const log = deps.log ?? ((): void => {});
  const now = deps.now ?? Date.now;
  const env = deps.env;
  const answering = args.mode === "answer";
  if (env["QCR_IPC_COMMAND_ID"] !== args.command) {
    log("botworker: --command is not the command id the daemon put in env");
    return EXIT.usage;
  }

  let client: IpcClient;
  try {
    client = await (deps.connect ?? (() => connectFromEnv("worker", env)))();
  } catch (e) {
    log(`botworker: could not reach the daemon: ${errText(e)}`);
    return EXIT.lost;
  }

  let broken = false;
  const report = (kind: IpcEventKind, body?: unknown): void => {
    if (broken) return;
    try {
      client.event(kind, body);
    } catch {
      broken = true;
    }
  };

  // A daemon that restarts takes the socket with it (D23): there is nobody left
  // to post for this worker, so it stops spending. The same for a daemon that
  // fences it (a newer generation, a command that is no longer active).
  let stopCode: number | undefined;
  let stopReason = "stopped";
  let stopped: Promise<void> = Promise.resolve();
  let session: RuntimeSession | undefined;
  const stopNow = (code: number, why: string): Promise<void> => {
    if (stopCode !== undefined) return stopped;
    stopCode = code;
    stopReason = why;
    log(`botworker: stopping (${why})`);
    stopped = (session?.abort() ?? Promise.resolve())
      .catch(() => {})
      .then(() => stopLiveSessions(5_000))
      .catch(() => {});
    return stopped;
  };
  const checkpoint = (): void => {
    if (stopCode !== undefined) throw new Stop(stopCode, stopReason);
  };
  client.onClose((e) => void stopNow(EXIT.lost, `the daemon connection ended: ${e.message}`));
  client.onError((e) => {
    if (e.code === "stale_generation" || e.code === "command_inactive" || e.code === "unauthorized")
      void stopNow(EXIT.fenced, `the daemon fenced this worker: ${e.code}`);
  });
  // The operator's controls (P8.12). They are taken from the moment the daemon
  // connects: one that arrives before the session is open is refused, not lost.
  let turnLimits: () => TurnOptions = () => ({});
  const controls = new WorkerControls({
    session: () => session,
    limits: () => turnLimits(),
    abort: () => stopNow(EXIT.aborted, "the round was aborted by the operator"),
    ack: ackSender((op, body) => client.request(op, body)),
    log,
  });
  client.onControl((kind, body) => controls.receive(kind, body));

  let host: PiHost | undefined;
  let beat: ReturnType<typeof setInterval> | undefined;
  let endWave: () => Promise<void> = async () => {};
  const started = now();
  try {
    const spec = await handshake(client, args);
    const deadline = started + spec.wall_clock_ms;
    const remaining = (): number => Math.max(MIN_TURN_MS, deadline - now());

    // The payload is what the daemon dispatched, byte for byte, or nothing runs.
    const verified = verifiedPayload(
      { payload_path: spec.payload_path, payload_sha256: spec.payload_sha256 },
      "the command's payload",
    );
    if (!verified.ok) throw new Stop(EXIT.handshake, verified.why);
    // An answer posts only when the operator marked the message: the daemon's word
    // (the spec) and the sealed payload both have to say so.
    const mayPost =
      answering && spec.may_post === true && operatorMayPost(verified.payload.toString("utf8"));

    // The login: borrowed, blanked, and checked against this worker's own cap.
    let auth: EngineAuth;
    try {
      auth = engineCredentials({ srcDir: spec.agent_dir, needMs: spec.wall_clock_ms, now });
    } catch (e) {
      if (e instanceof AuthError) throw new Stop(EXIT.auth, e.message);
      throw e;
    }
    checkpoint();

    // The host, the lens tools and the session. The model's tools run as the
    // tool uid wherever the image asks for it (D32).
    const wave = new LensWave();
    let lensUsd = 0;
    let lensRuns = 0;
    const marker = sessionCommandMarker(spec.command_id, spec.payload_sha256);
    let opened: Opened;
    try {
      checkToolUid(env, { what: "the bot worker", instead: "", isolated: true });
      const ids = toolIdsOf(env);
      host = await (deps.makeHost ?? PiHost.create)({
        agentDir: spec.agent_dir,
        ownsProcess: true,
        ...(ids !== null && !("refused" in ids) ? { toolUid: ids } : {}),
        fenceDirs: [...loginSourceDirs(env), ...credentialPaths(env, spec.env)],
        credentials: auth.credentials,
        settings: agentDirSettings(spec.agent_dir),
      });
      // The lens cap is the daemon's, over every worker (D25): a pass asks the broker.
      const permits = brokerPermits(client, (m) => log(`botworker: ${m}`));
      opened = await openSession(
        host,
        spec,
        env,
        wave,
        marker,
        deps,
        log,
        permits,
        (run) => {
          lensUsd += run.result.usage.cost;
          lensRuns++;
        },
        answering ? { mayPost } : undefined,
      );
    } catch (e) {
      throw new Stop(EXIT.session, `could not open the session: ${errText(e)}`);
    }
    const { tools, resumed, continuing } = opened;
    const live = opened.session;
    session = live;
    checkpoint();

    const watch = new RoundWatch(report);
    let accepted = false;
    live.subscribe((event) => {
      if (!accepted && event["type"] === "agent_start") {
        accepted = true;
        report("accepted", { command_id: spec.command_id, continued: continuing });
      }
      watch.hear(event);
    });
    report("ready", {
      session_id: live.id,
      session_file: opened.file ?? null,
      resumed,
      continued: continuing,
    });
    beat = setInterval(
      () =>
        report("progress", {
          stage: "heartbeat",
          turns: live.stats().turns,
          busy: live.stats().busy,
        }),
      spec.heartbeat_ms ?? DEFAULT_HEARTBEAT_MS,
    );
    beat.unref();

    turnLimits = () => ({
      timeoutMs: remaining(),
      ...(spec.cap_usd !== undefined
        ? { capUsd: Math.max(0, spec.cap_usd - live.stats().spentUsd) }
        : {}),
    });
    // What the round has cost, priced the way the transcript is (src/bench/cost.ts):
    // the session's assistant messages and the passes its lens tools reported, each
    // run once, and, at the end, the lens ledger's warm-ups. The daemon's est_usd
    // takes it in place of measuring the transcript (P8.9).
    const meter = new EventCostMeter();
    live.subscribe(
      (event) => {
        const type = event["type"];
        if (
          type === "message_end" ||
          type === "tool_execution_update" ||
          type === "tool_execution_end"
        )
          meter.add(JSON.stringify(event));
      },
      { updates: true },
    );
    const usage = (): void =>
      report("usage", {
        total_usd: meter.totalUsd,
        lens_usd: lensUsd,
        lens_runs: lensRuns,
        turns: live.stats().turns,
      });
    const settle = (r: TurnResult, what: string): void => {
      usage();
      checkpoint();
      if (r.timedOut) throw new Stop(EXIT.failed, `${what}: the wall-clock cap ran out`);
      if (r.capped) throw new Stop(EXIT.failed, `${what}: the dollar cap was reached`);
      if (r.streamError) throw new Stop(EXIT.failed, `${what}: output stream failed: ${r.streamError.slice(0, 300)}`);
      // A provider failure ends the turn as an assistant message, not as a throw.
      if (watch.lastError !== undefined) {
        const refused = classifyAuthFailure(watch.lastError);
        throw new Stop(
          EXIT.failed,
          refused
            ? `${what}: the provider refused the login: ${refused.message}`
            : `${what}: the provider failed the turn: ${watch.lastError}`,
        );
      }
      if (r.code !== 0)
        throw new Stop(EXIT.failed, `${what}: the turn failed${lastLineOf(spec.stderr_file)}`);
    };
    const deliver = async (text: string, what: string): Promise<void> => {
      const d = await live.followUp(text, turnLimits());
      if (d.status === "queued") {
        // An operator's turn is in flight, and this message runs behind it: its
        // result is the session's last once nothing is queued.
        await controls.drain();
        const last = live.stats().last;
        if (last === null) throw new Stop(EXIT.failed, `${what}: the message was not run (queued)`);
        settle(last, what);
        return;
      }
      if (d.status !== "handled")
        throw new Stop(EXIT.failed, `${what}: the message was not run (${d.status})`);
      settle(d.result, what);
    };
    // The turns an operator's control started: settled before the round goes on.
    let controlsChecked = 0;
    const settleControls = async (close: boolean): Promise<void> => {
      await (close ? controls.drainAndClose() : controls.drain());
      checkpoint();
      const taken = controls.counts.steer + controls.counts.follow_up;
      const last = live.stats().last;
      if (last !== null && taken > controlsChecked) settle(last, "the operator's message");
      controlsChecked = taken;
    };

    // The round's turn. The engine starts the planned wave first, so the lenses
    // are in flight while the session reads. A continuation does not: the rows ran
    // in the worker that is gone, and the session is told so. An answer is one
    // turn: the operator's message, no wave and no wakes (the daemon's own wakes
    // stay held for the round).
    let wakesDelivered = 0;
    if (answering) {
      const message = verified.payload.toString("utf8");
      if (continuing) {
        report("progress", { stage: "continuing" });
        await deliver(answerContinuationText(marker), "the continuation");
      } else {
        report("progress", { stage: "message_sent" });
        settle(await live.prompt(withMarker(message, marker), turnLimits()), "the answer");
      }
    } else {
      if (continuing) {
        report("progress", { stage: "continuing" });
        await deliver(continuationText(marker), "the continuation");
      } else {
        const planned = plannedWave(spec, env);
        if (planned.note) log(`botworker: ${planned.note}`);
        const section = engineLensSection(
          planned.dir,
          spec.planned_wave && planned.units.length
            ? { dir: planned.dir, agents: planned.units.map((u) => u.agent) }
            : null,
        );
        if (spec.planned_wave && planned.units.length) {
          const stop = new AbortController();
          if (tools === undefined)
            throw new Stop(EXIT.session, "a round opens with its lens tools");
          const rows: WaveRow[] = launchWave(wave, tools.runner, planned.units, stop.signal);
          report("progress", { stage: "wave_started", rows: rows.length });
          endWave = async () => {
            stop.abort();
            let timer: NodeJS.Timeout | undefined;
            await Promise.race([
              Promise.allSettled(rows.map((row) => row.done)),
              new Promise((resolve) => (timer = setTimeout(resolve, WAVE_SETTLE_MS))),
            ]);
            clearTimeout(timer);
            endWave = async () => {};
          };
        }
        const order = verified.payload.toString("utf8");
        report("progress", { stage: "round_order_sent" });
        settle(
          await live.prompt(withMarker(`${order.trimEnd()}\n\n${section}`, marker), turnLimits()),
          "the round",
        );
      }
      // Whatever the operator steered or followed up with runs to its end first.
      await settleControls(false);
      // The turns are over: a wave row nobody joined is not wanted any more.
      await endWave();

      // The wakes held while the round ran, in arrival order.
      for (let pass = 0; pass < MAX_WAKE_PASSES; pass++) {
        let batches;
        try {
          batches = parseWakesTaken(await client.request(WAKES_TAKE_OP, {})).batches;
        } catch (e) {
          if (e instanceof IpcError && e.code === "unknown_op") break;
          throw e;
        }
        if (batches.length === 0) break;
        for (const batch of batches) {
          const mark = wakeMarker(batch.id);
          const file = live.sessionFile;
          // A batch an earlier worker delivered and died before acking is acked, not sent again.
          if (!(file !== null && jsonlHasMarker(file, mark)))
            await deliver(withMarker(batch.message, mark), `wake ${batch.id}`);
          await client.request(WAKES_ACK_OP, { id: batch.id });
          wakesDelivered++;
        }
        report("progress", { stage: "wakes_delivered", delivered: wakesDelivered });
      }
    }

    // Nothing is steered into a round that is closing; an abort still is.
    await settleControls(true);

    // Compaction through ledger-pin: pi's own compact() fires the session's
    // session_before_compact. An optimisation, so a failure is reported and not fatal.
    let compacted = "skipped";
    if (spec.compact !== false && live.compact) {
      report("progress", { stage: "compacting" });
      const outcome = await live.compact();
      compacted = outcome.status;
      report("compacted", outcome);
    }

    checkpoint();
    if (!answering) foldLensLedger(meter, lensLedgerOf(spec));
    usage();
    report("done", {
      mode: args.mode,
      ...(answering
        ? {
            // What the model said last, for the operator: the daemon writes it to the
            // command's result file.
            reply: (watch.replyText ?? "").slice(0, MAX_REPLY_CHARS),
            may_post: mayPost,
          }
        : {}),
      session_id: live.id,
      resumed,
      continued: continuing,
      verdict_written: watch.verdictWritten,
      posted: watch.posted,
      wakes_delivered: wakesDelivered,
      controls: { ...controls.counts },
      compacted,
      turns: live.stats().turns,
      total_usd: meter.totalUsd,
      lens_usd: lensUsd,
      elapsed_ms: now() - started,
    });
    return EXIT.ok;
  } catch (e) {
    // A dropped connection fails whatever request was in flight; the cause is the
    // stop code, not the request's error (the supervisor reads lost/fenced from it).
    const stop =
      e instanceof Stop
        ? e
        : stopCode !== undefined
          ? new Stop(stopCode, stopReason)
          : new Stop(EXIT.failed, errText(e));
    log(`botworker: ${stop.reason}`);
    report("failed", { code: stop.exit, reason: stop.reason });
    return stop.exit;
  } finally {
    if (beat !== undefined) clearInterval(beat);
    await endWave().catch(() => {});
    await session?.dispose().catch(() => {});
    host?.dispose();
    await controls.flush().catch(() => {});
    await client.drain().catch(() => {});
    client.close();
  }
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 500);

/** The hello is the daemon's; the spec is its answer to who this command is. */
async function handshake(client: IpcClient, args: WorkerArgs): Promise<WorkerSpec> {
  let spec: WorkerSpec;
  try {
    spec = parseWorkerSpec(await client.request(WORKER_SPEC_OP, {}));
  } catch (e) {
    throw new Stop(EXIT.handshake, `no usable spec from the daemon: ${errText(e)}`);
  }
  if (spec.command_id !== args.command || spec.mode !== args.mode)
    throw new Stop(EXIT.handshake, "the spec is for another command or mode");
  if (spec.pr !== client.pr) throw new Stop(EXIT.handshake, "the spec is for another PR");
  if (Object.keys(spec.env).some((k) => k.startsWith("QCR_IPC_")))
    throw new Stop(
      EXIT.handshake,
      "the spec's env names the IPC variables, which are the worker's",
    );
  return spec;
}

/** The planned discovery wave's task files: the round's own pass dir. */
function plannedWave(
  spec: WorkerSpec,
  env: NodeJS.ProcessEnv,
): { dir: string; units: LaunchUnit[]; note?: string } {
  const passes = roundPassesDir(spec, spec.round_no ?? 0);
  const dir = join(passes, "tasks");
  if (!existsSync(dir)) return { dir, units: [] };
  const plan = planLaunch(
    { dirs: [passes] },
    { QCR_SANDBOX_ROOT: spec.root, QCR_PR: String(spec.pr), PATH: env["PATH"] },
  );
  return plan.ok
    ? { dir, units: plan.units }
    : { dir, units: [], note: `engine wave not planned: ${plan.error}`.slice(0, 300) };
}

/** The main session's spec: the daemon's env, plus the IPC names the post shims
 * read from the model's bash. A lens pass never gets those. */
function sessionSpecOf(
  spec: WorkerSpec,
  env: NodeJS.ProcessEnv,
  answer?: { mayPost: boolean },
): SessionSpec {
  const ipc: Record<string, string> = {};
  // An answer that may not post is given no way to reach the daemon at all.
  if (!answer || answer.mayPost)
    for (const name of IPC_ENV) {
      const value = env[name];
      if (value !== undefined) ipc[name] = value;
    }
  const own: Record<string, string> = { ...spec.env };
  if (answer) for (const name of ROUND_ONLY_ENV) delete own[name];
  return {
    cwd: spec.cwd,
    env: { ...own, ...ipc },
    model: spec.model,
    systemPromptFile: spec.system_prompt_file,
    name: spec.session,
    eventsFile: spec.events_file,
    stderrFile: spec.stderr_file,
    limits: {
      timeoutMs: spec.wall_clock_ms,
      ...(spec.cap_usd !== undefined ? { capUsd: spec.cap_usd } : {}),
    },
  };
}


const lensLedgerOf = (spec: WorkerSpec): string => join(lensDirOf(spec), "lens-ledger.jsonl");

/** The ledger's lines priced into `meter`: a run a tool result already reported
 * adds nothing, a cache warm-up (which only the ledger records) is added. */
function foldLensLedger(meter: EventCostMeter, file: string): void {
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) meter.add(line);
  } catch {
    // no ledger: the round ran no pass
  }
}

/** Open the PR's session: the engine's lens tools over this round's own ledger
 * and JSONLs (D10), the bot runtime over them, and then resume the newest JSONL
 * under the PR's session dir (same id) or, with none, a session born there. */
async function openSession(
  host: PiHost,
  spec: WorkerSpec,
  env: NodeJS.ProcessEnv,
  wave: LensWave,
  marker: string,
  deps: WorkerDeps,
  log: (line: string) => void,
  permitPort: Permits,
  tap: (run: LensRun) => void,
  answer?: { mayPost: boolean },
): Promise<Opened> {
  if (answer) return openAnswerSession(host, spec, env, marker, deps, log, answer);
  const round = spec.round_no ?? 0;
  const lensDir = lensDirOf(spec);
  const lensSpec: SessionSpec = {
    ...sessionSpecOf(spec, {}),
    env: { ...spec.env, PI_CODING_AGENT_DIR: spec.agent_dir },
  };
  const base = engineLensConfig(host, lensSpec);
  // The round's context pack sits beside its task files, not beside the ledger.
  const packFile = join(roundPassesDir(spec, round), CONTEXT_PACK_FILE);
  const pack = existsSync(packFile) ? readFileSync(packFile, "utf8") : "";
  const tools = engineLensTools(
    {
      ...base,
      permitPort,
      ledgerPath: lensLedgerOf(spec),
      sessionsDir: join(lensDir, LENS_SESSIONS_DIR),
      ...(base.cache && pack ? { cache: { ...base.cache, pack } } : {}),
    },
    wave,
    tap,
  );
  const runtime = botSdkRuntime(host, {
    lens: tools,
    processEnv: env,
    ...(spec.round_no !== null
      ? { live: { root: spec.root, key: spec.session, round: spec.round_no } }
      : {}),
    warn: (m) => log(`botworker: ${m}`),
    ...(deps.openViking ? { openViking: deps.openViking } : {}),
  });
  const sessionSpec = sessionSpecOf(spec, env);
  const file = newestSessionFile(spec.session_dir);
  if (file === undefined) {
    const born = await runtime.create({ ...sessionSpec, sessionDir: spec.session_dir });
    return { session: born, tools, resumed: false, file: undefined, continuing: false };
  }
  const id = headerId(file);
  const resumed = await runtime.resume(file, sessionSpec);
  if (id !== null && resumed.id !== id) {
    await resumed.dispose();
    throw new Error(`the resumed session id ${resumed.id} is not the JSONL's ${id}`);
  }
  return { session: resumed, tools, resumed: true, file, continuing: jsonlHasMarker(file, marker) };
}

/** An answer worker's session: the PR's newest JSONL resumed under its own id (an
 * answer never births one), with the read-only tool set and no lens tool. */
async function openAnswerSession(
  host: PiHost,
  spec: WorkerSpec,
  env: NodeJS.ProcessEnv,
  marker: string,
  deps: WorkerDeps,
  log: (line: string) => void,
  answer: { mayPost: boolean },
): Promise<Opened> {
  const file = newestSessionFile(spec.session_dir);
  if (file === undefined)
    throw new Error(`#${spec.pr} has no session to resume: an answer never births one`);
  const liveRound = spec.round_no ?? spec.live_round;
  const runtime = botSdkRuntime(host, {
    lens: NO_LENS,
    answer,
    processEnv: env,
    ...(liveRound !== undefined
      ? { live: { root: spec.root, key: spec.session, round: liveRound } }
      : {}),
    warn: (m) => log(`botworker: ${m}`),
    ...(deps.openViking ? { openViking: deps.openViking } : {}),
  });
  const id = headerId(file);
  const resumed = await runtime.resume(file, sessionSpecOf(spec, env, answer));
  if (id !== null && resumed.id !== id) {
    await resumed.dispose();
    throw new Error(`the resumed session id ${resumed.id} is not the JSONL's ${id}`);
  }
  return {
    session: resumed,
    tools: undefined,
    resumed: true,
    file,
    continuing: jsonlHasMarker(file, marker),
  };
}

async function main(): Promise<void> {
  const parsed = parseWorkerArgs(process.argv.slice(2));
  if ("error" in parsed) {
    process.stderr.write(`botworker: ${parsed.error}\n`);
    process.exit(EXIT.usage);
  }
  // Under the tool uid (D32) the run uid and the tool uid share one
  // gid: what this worker's file tools write (a verdict staged, a review body)
  // the model's bash may rewrite (commit-verdict.sh, render-review.sh), and the
  // reverse, so both write group-writable files. The daemon keeps its own umask:
  // the files it writes for a session to read (the recall hints) stay its own.
  const ids = toolIdsOf(process.env);
  if (ids !== null && !("refused" in ids)) process.umask(TOOL_UMASK);
  // The supervisor's TERM is the hard stop (the process exit); this stops the
  // sessions first so a turn in flight is aborted and its JSONL closed.
  for (const sig of ["SIGTERM", "SIGINT"] as const)
    process.on(sig, () => {
      void stopLiveSessions(3_000).finally(() => process.exit(EXIT.terminated));
    });
  const code = await runBotWorker(parsed, {
    env: process.env,
    log: (line) => process.stderr.write(`${line}\n`),
  });
  process.exit(code);
}

// Run only as the entry point, not when a test imports runBotWorker.
if (process.argv[1]?.endsWith("botworker.js")) void main();
