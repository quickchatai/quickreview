// The daemon's side of the idle-PR answer worker (P8.17, rule 9's second exception).
//
// An operator's `message` to a PR with no running worker and no lease is ANSWERED
// NOW, not held as a wake for the next round: a short worker (src/botworker.ts
// `--mode answer`) resumes the PR's JSONL under the same session id, takes the
// message as one user turn marked with operator provenance, replies and exits.
// This module is the decision and the paperwork around it:
//
//   - WHERE a message goes. A round is running: it is a steer (the one place a
//     running session is interleaved, and the operator's alone). An answer worker
//     is running: refused, with the reason. A takeover lease, a debug round, a
//     drained bot, a parked PR, a closed PR or a PR with no session yet: refused,
//     with the reason, and nothing is submitted. Otherwise the message becomes an
//     `answer` command and one worker is started for it.
//   - WHAT it may do. `may_post` is the operator's explicit mark on the message
//     (the viewer's Alt-p, `qcr message --may-post`, a companion action). It is
//     written into the payload the worker verifies, so the daemon's refusal of a
//     post (src/postops.ts, `may_post_required`) and the worker's tool set both
//     read the same bytes. A message without the mark can post nothing.
//   - WHERE the reply goes. The worker reports it in its closing `done` event; the
//     supervisor hands it to `onSettled`, which writes the command's result file,
//     `state/commands/<command id>/result.json`. The operator's own command result
//     answers at once (the watcher is serial: it must not wait ten minutes) and
//     names that file.
//
// The command row is the one-active index's: while the answer worker runs, a
// round's order or a daemon wake for the PR cannot be submitted (the caller holds
// it), and goes through once the worker has exited. An answer never ends `failed`
// (src/state.ts `cancelAnswerCommand`): it owes nothing and blocks nothing.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ControlCommand } from "./commands.js";
import { DEFAULT_ANSWER_CAP_USD, DEFAULT_ANSWER_TIMEOUT_S, type Config } from "./config.js";
import type { FileOutcome } from "./improvements.js";
import { MAX_REPLY_CHARS, operatorMessagePayload } from "./operatormessage.js";
import { prSessionName } from "./pr-session-lifecycle.js";
import type { StateStore } from "./state.js";
import {
  WorkerLaunchError,
  type WorkerSettled,
  type WorkerSupervisor,
} from "./workersupervisor.js";

export type MessageCommand = Extract<ControlCommand, { command: "message" }>;

export interface AnswerHostDeps {
  supervisor: Pick<
    WorkerSupervisor,
    "submit" | "launch" | "control" | "runs" | "workers" | "breaker"
  >;
  store: Pick<
    StateStore,
    "getPr" | "getSessionCommand" | "activeSessionCommand" | "cancelAnswerCommand" | "logEvent"
  >;
  /** The sandbox root: the result files live under `<root>/state/commands/`. */
  root: string;
  /** The PR's host lease, once takeover and debug rounds exist (P8.13); null for none. */
  lease?: (pr: number) => "takeover" | "debug" | null | undefined;
  /** Whether the PR has a session JSONL to resume. An answer never births one. */
  hasSession: (pr: number) => boolean;
  now?: () => Date;
  log?: (msg: string) => void;
}

/** The supervisor's `answer` dep from the config: `[daemon] answer_timeout_s` and
 * `answer_cap_usd`. */
export function answerCapsOf(
  daemon: Pick<Config["daemon"], "answer_timeout_s" | "answer_cap_usd">,
): {
  timeoutMs: number;
  capUsd: number;
} {
  return {
    timeoutMs: Math.round((daemon.answer_timeout_s ?? DEFAULT_ANSWER_TIMEOUT_S) * 1000),
    capUsd: daemon.answer_cap_usd ?? DEFAULT_ANSWER_CAP_USD,
  };
}


/** `<root>/state/commands/<id>/result.json`: the command's result file. */
export const answerResultFile = (root: string, commandId: string): string =>
  join(root, "state", "commands", commandId, "result.json");

/** What the result file holds. */
export interface AnswerResult {
  command_id: string;
  pr: number;
  ok: boolean;
  /** The model's last words to the operator; absent when the worker gave none. */
  reply?: string;
  /** Why there is no reply, when there is none. */
  error?: string;
  may_post: boolean;
  /** Posts the worker made (through the one gate). */
  posted: number;
  est_usd: number | null;
  finished_at: string;
}

export class AnswerHost {
  private readonly now: () => Date;
  private readonly log: (msg: string) => void;

  constructor(private readonly deps: AnswerHostDeps) {
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? ((): void => {});
  }

  /** The operator's `message`. Always an outcome, never a throw. */
  async message(command: MessageCommand): Promise<FileOutcome> {
    const { supervisor, store } = this.deps;
    const pr = command.pr;
    const session = prSessionName(pr);
    const mayPost = command.may_post === true;
    const refuse = (reason: string, code: string): FileOutcome => ({ ok: false, reason, code });

    const row = store.getPr(pr);
    if (!row) return refuse(`#${pr} is not a PR this bot tracks`, "unknown_pr");
    if (row.state === "closed")
      return refuse(`#${pr} is closed: its session is no longer answered`, "closed");

    const lease = this.deps.lease?.(pr);
    if (lease === "takeover")
      return refuse(
        `#${pr} is under a takeover lease: the operator works in its session; release it first`,
        "lease_takeover",
      );
    if (lease === "debug")
      return refuse(
        `a debug round runs in #${pr}'s session; focus its pane and type in pi`,
        "lease_debug",
      );

    // A round is running: the message is a steer, which is the operator's one way
    // into a running session. It carries no posting right of its own: the round's.
    const live = supervisor.workers().find((w) => w.pr === pr);
    if (live) {
      if (live.mode === "answer")
        return refuse(
          `an answer worker is already running for #${pr}; send the next message once it has replied`,
          "answer_running",
        );
      const steered = await supervisor.control(pr, "steer", command.text);
      if (!steered.ok) return refuse(steered.reason, "steer_refused");
      return {
        ok: true,
        ack: steered.ack,
        command_id: steered.command_id,
        path: "steer",
        ...(mayPost
          ? {
              may_post_ignored:
                "a round is running: the message was steered, and a steer posts nothing of its own",
            }
          : {}),
      };
    }
    const active = store.activeSessionCommand(session);
    if (active || supervisor.runs(session))
      return refuse(
        active
          ? `#${pr} has a ${active.kind} command in flight (${active.status}); send the message again once its worker is up`
          : `a worker of #${pr} is still running`,
        "in_flight",
      );

    const verdict = supervisor.breaker.gate(pr);
    if (!verdict.ok)
      return refuse(
        verdict.why === "draining" ? `drained: ${verdict.reason}` : verdict.reason,
        verdict.why === "draining" ? "drained" : "parked",
      );
    if (!this.deps.hasSession(pr))
      return refuse(
        `#${pr} has no session to resume yet: a round births it, and a message is answered from it`,
        "no_session",
      );

    let commandId: string;
    try {
      commandId = supervisor.submit({
        pr,
        kind: "answer",
        round_no: null,
        payload: operatorMessagePayload(command.text, mayPost),
      }).id;
    } catch (e) {
      return refuse(e instanceof Error ? e.message : String(e), "in_flight");
    }
    try {
      await supervisor.launch(commandId);
    } catch (e) {
      // A message that cannot start its worker now is not left to start one later:
      // the operator is told, and asks again.
      const why = e instanceof Error ? e.message : String(e);
      store.cancelAnswerCommand(commandId, why);
      if (!(e instanceof WorkerLaunchError)) this.log(`answer worker for #${pr}: ${why}`);
      return refuse(why, "launch_refused");
    }
    store.logEvent("answer_worker_started", pr, { command_id: commandId, may_post: mayPost });
    return {
      ok: true,
      ack: "queued",
      command_id: commandId,
      path: "answer",
      may_post: mayPost,
      result_file: answerResultFile(this.deps.root, commandId),
    };
  }

  /** The supervisor's `settled` hook: write the answer command's result file. Other
   * commands are not this module's. */
  onSettled = (s: WorkerSettled): void => {
    if (s.kind !== "answer") return;
    const reply = typeof s.report?.["reply"] === "string" ? s.report["reply"] : undefined;
    const ok = s.outcome === "acked" && reply !== undefined;
    const row = this.deps.store.getSessionCommand(s.command_id);
    const result: AnswerResult = {
      command_id: s.command_id,
      pr: s.pr,
      ok,
      ...(reply !== undefined ? { reply: reply.slice(0, MAX_REPLY_CHARS) } : {}),
      ...(ok
        ? {}
        : {
            error:
              s.reason ??
              (s.outcome === "leave"
                ? "the worker was ended by a recovery fence before it replied"
                : "the worker ended without a reply"),
          }),
      may_post: s.may_post,
      posted: s.posted,
      est_usd: row?.est_usd ?? null,
      finished_at: this.now().toISOString(),
    };
    const file = answerResultFile(this.deps.root, s.command_id);
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${process.pid}`;
      writeFileSync(tmp, `${JSON.stringify(result, null, 2)}\n`);
      renameSync(tmp, file);
    } catch (e) {
      this.log(`answer ${s.command_id}: result file not written: ${String(e)}`);
    }
    this.deps.store.logEvent("answer_worker_settled", s.pr, {
      command_id: s.command_id,
      ok,
      posted: s.posted,
    });
  };
}
