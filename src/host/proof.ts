// `host review-now <pr>`, `host proof-start <pr>` and `host proof-result
// <pr>`: a review asked for by a host's operator, and the practice review a
// go-live is confirmed against.
//
// `review-now` is the operator's "review this pull request now": one
// `review-now` command into the daemon's root-sealed operator channel, the
// channel `qcr review-now` and the wizard's proof round use
// (src/onboard/steps/proof.ts builds the argv). It queues the pull request as
// a fresh trigger label would, with no GitHub write.
//
// The practice review is the wizard's proof round, cut in two so that neither
// half waits:
//
//   proof-start   asks for the round the same way, and remembers which round
//                 of the pull request was the newest that had already ended,
//                 so only a later one answers the request. It refuses when
//                 the config says the reviewer posts live: a practice review
//                 is one that cannot post. It writes no proof record.
//   proof-result  looks once. While the round runs it says so. When the round
//                 has finished it reads the review out of the dry-run record
//                 (the file the mutation gate wrote instead of calling
//                 GitHub), writes the checklist's proof record through a step
//                 of its own, marks the round as shown, and prints the review
//                 as it would have been posted, capped. It is the only thing
//                 here that writes the proof record: a go-live is admitted on
//                 a practice round this verb returned, and on no other.
//
// The daemon's state is read as the operator would read it: its own
// `qcr why <n> --json`, inside its container.
import {
  recordedReviewEvent,
  sandboxReviewFrom,
  sandboxReviewRecord,
  type ReviewSnapshot,
} from "../compare.js";
import { acquireChecklistLock } from "../onboard/checklistlock.js";
import { CHOICE_KEYS } from "../onboard/choices.js";
import type { OnboardingStep, StepReport } from "../onboard/engine.js";
import { StepRegistry } from "@quickchatai/pi-quickreview/src/setupchecklist.js";
import {
  PROOF_STEP_ID,
  classifyRounds,
  completedRound,
  parseWhy,
  proofRoundStep,
  readContainerDryrun,
  recordForPr,
  reviewNowFileName,
  reviewNowResultArgv,
  reviewNowWriteArgv,
  roundRecords,
  type ObservedRound,
  type ProofRecord,
  type RoundObservation,
} from "../onboard/steps/proof.js";
import type { StackTransport } from "../onboard/steps/transport.js";
import { readConfigToml } from "@quickchatai/pi-quickreview/src/shippedconfig.js";
import { configFacts } from "../boardexport.js";
import { admit } from "./admit.js";
import {
  HOST_MESSAGE_CAP,
  PROOF_BODY_CAP,
  PROOF_COMMENT_BODY_CAP,
  PROOF_COMMENT_CAP,
  PROOF_PATH_CAP,
  REVIEW_EVENTS,
  refused,
  type HostAnswer,
  type HostReason,
  type HostReview,
  type HostVerb,
} from "./outcomes.js";
import { lockOptions, transportOf, type HostPorts } from "./ports.js";
import {
  proofWasShown,
  readHostRecord,
  recordedProofIn,
  updateHostRecord,
  type ProofRequest,
} from "./record.js";

/** How often, and how long apart, the daemon's receipt for a request is read
 * before the verb answers without it. */
export const RECEIPT_TRIES = 4;
export const RECEIPT_WAIT_MS = 750;

/** A request the daemon settled without a new round (the head was already
 * reviewed) is answered by the standing round, once this long has passed. */
export const SETTLED_AFTER_MS = 90_000;

/** The largest pull request number read: GitHub's are 32-bit. */
const MAX_PR = 2_147_483_647;

/** The one argument of a per-pull-request verb, or a string saying what is
 * wrong with it. */
export function parsePrArg(verb: HostVerb, args: readonly string[]): number | string {
  const usage = `usage: qcr --schema 3 host ${verb} <pr-number>`;
  if (args.length !== 1) return `${verb} takes one pull request number. ${usage}`;
  const raw = args[0]!;
  if (!/^[1-9][0-9]{0,9}$/.test(raw) || Number(raw) > MAX_PR)
    return `${JSON.stringify(raw)} is not a pull request number. ${usage}`;
  return Number(raw);
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const isMissingFile = (err: unknown): boolean =>
  (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

interface Standing {
  transport: StackTransport;
  /** The config's `dry_run`; null when the file does not say. */
  dryRun: boolean | null;
}

/** Is there a reviewer to ask: a repository set up, and a daemon running? */
async function standing(ports: HostPorts): Promise<Standing | HostAnswer> {
  let repo: string | undefined;
  let dryRun: boolean | null = null;
  try {
    const text = ports.read(ports.configPath);
    repo = configFacts(text).repo;
    const dry = readConfigToml(text, ports.template())["dry_run"];
    dryRun = typeof dry === "boolean" ? dry : null;
  } catch (err) {
    if (!isMissingFile(err))
      return refused(
        "config_unreadable",
        `can't read ${ports.configPath} (${message(err)}). Nothing changed`,
      );
  }
  if (repo === undefined)
    return refused(
      "not_set_up",
      "no repository is set up for this reviewer yet: `host setup` comes first. Nothing changed",
    );
  const transport = transportOf(ports);
  const daemon = await transport.daemonState();
  if (daemon.state === "unknown")
    return refused(
      "reviewer_unreachable",
      `whether the reviewer runs could not be told (${oneLine(daemon.detail).slice(0, 200)}). Nothing changed`,
    );
  if (daemon.state !== "running")
    return refused("reviewer_not_running", "the reviewer is not running. Nothing changed");
  return { transport, dryRun };
}

const isAnswer = (v: Standing | HostAnswer): v is HostAnswer => "state" in v;

/** The daemon's own record of the pull request, or null when it cannot be read. */
async function observe(transport: StackTransport, pr: number): Promise<RoundObservation | null> {
  const r = await transport.exec(["node", "dist/src/cli.js", "why", String(pr), "--json"]);
  return r.code === 0 ? parseWhy(r.stdout) : null;
}

type Receipt = { kind: "queued" } | { kind: "refused"; reason: string } | { kind: "pending" };

/** The daemon's answer to the command file `name`, read once. */
async function receiptOf(transport: StackTransport, name: string): Promise<Receipt> {
  const read = await transport.exec(reviewNowResultArgv(name));
  const body = read.code === 0 ? read.stdout.trim() : "";
  if (body === "" || body === "pending") return { kind: "pending" };
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(body) as Record<string, unknown>;
  } catch {
    // the daemon may still be writing it
    return { kind: "pending" };
  }
  if (v["ok"] === true) return { kind: "queued" };
  return {
    kind: "refused",
    reason:
      typeof v["reason"] === "string" ? oneLine(v["reason"]).slice(0, 300) : "no reason given",
  };
}

type Asked =
  | { kind: "queued"; command: string }
  | { kind: "sent"; command: string }
  | { kind: "refused"; reason: string }
  | { kind: "unwritten"; detail: string };

/** Write one `review-now` command for `pr` and read its receipt for a moment. */
async function askForReview(
  ports: HostPorts,
  transport: StackTransport,
  pr: number,
): Promise<Asked> {
  const command = reviewNowFileName(ports.now(), pr);
  const write = await transport.execAsRoot(reviewNowWriteArgv(command, pr));
  if (write.code !== 0)
    return {
      kind: "unwritten",
      detail: oneLine(write.stderr || write.stdout).slice(0, 200) || `exit ${write.code}`,
    };
  for (let attempt = 0; attempt < RECEIPT_TRIES; attempt += 1) {
    await ports.sleep(RECEIPT_WAIT_MS);
    const receipt = await receiptOf(transport, command);
    if (receipt.kind === "queued") return { kind: "queued", command };
    if (receipt.kind === "refused") return receipt;
  }
  return { kind: "sent", command };
}

const unwritten = (detail: string): HostAnswer =>
  refused(
    "reviewer_unreachable",
    `the request could not be handed to the reviewer (${detail}). Nothing changed`,
  );

const daemonRefused = (pr: number, reason: string): HostAnswer =>
  refused("review_refused", `the reviewer refused to review #${pr}: ${reason}`);

/** The `review-now` verb. */
export async function hostReviewNow(
  ports: HostPorts,
  args: readonly string[],
): Promise<HostAnswer> {
  const no = admit(ports);
  if (no !== null) return no;
  const pr = parsePrArg("review-now", args);
  if (typeof pr === "string") return refused("usage", pr);
  const at = await standing(ports);
  if (isAnswer(at)) return at;
  const asked = await askForReview(ports, at.transport, pr);
  if (asked.kind === "unwritten") return unwritten(asked.detail);
  if (asked.kind === "refused") return daemonRefused(pr, asked.reason);
  return { state: asked.kind, pr };
}

/** The newest round that is not running; 0 when there is none. */
function floorOf(obs: RoundObservation): number {
  return obs.rounds
    .filter((r) => r.status !== "running")
    .reduce((n, r) => Math.max(n, r.round_no), 0);
}

const inFlight = (obs: RoundObservation): boolean =>
  obs.rounds.at(-1)?.status === "running" || obs.state === "queued" || obs.state === "reviewing";

/** The `proof-start` verb. */
export async function hostProofStart(
  ports: HostPorts,
  args: readonly string[],
): Promise<HostAnswer> {
  const no = admit(ports);
  if (no !== null) return no;
  const pr = parsePrArg("proof-start", args);
  if (typeof pr === "string") return refused("usage", pr);
  const at = await standing(ports);
  if (isAnswer(at)) return at;
  if (at.dryRun === null)
    return refused(
      "config_unreadable",
      `${ports.configPath} does not say whether the reviewer is in dry-run, so whether a review would post is unknown. Nothing changed`,
    );
  if (!at.dryRun)
    return refused(
      "already_live",
      "the reviewer posts live: a practice review is one that cannot post, and this one would. Nothing changed",
    );
  const got = acquireChecklistLock(ports.stateDir, "proof", lockOptions(ports));
  if (!got.ok) return { state: "busy", holder: got.held.holder };
  try {
    const obs = await observe(at.transport, pr);
    if (obs === null)
      return refused(
        "reviewer_unreachable",
        "the reviewer's own state could not be read. Nothing changed",
      );
    const request: ProofRequest = {
      pr,
      floor: floorOf(obs),
      requested_at: ports.now().toISOString(),
    };
    const remember = (r: ProofRequest): void => {
      updateHostRecord(ports.stateDir, (record) => ({ ...record, proof_request: r }));
    };
    // a round already under way is the practice round: nothing more is asked
    if (inFlight(obs)) {
      remember(request);
      return { state: "running", pr };
    }
    const asked = await askForReview(ports, at.transport, pr);
    if (asked.kind === "unwritten") return unwritten(asked.detail);
    if (asked.kind === "refused") return daemonRefused(pr, asked.reason);
    remember({ ...request, command: asked.command });
    return { state: asked.kind === "queued" ? "started" : "sent", pr };
  } finally {
    got.lock.release();
  }
}

// ---- the review, as printed -----------------------------------------------------------

const cut = (text: string, cap: number): { text: string; cut: boolean } =>
  text.length > cap ? { text: text.slice(0, cap), cut: true } : { text, cut: false };

/**
 * The review as it would have been posted, within the verb's caps.
 * `recordedEvent` is the event the dry-run record itself names
 * (src/compare.ts `recordedReviewEvent`): the review's own `state` is not
 * read for it, because a record that names no event is given one there, and
 * what the record does not say is not printed.
 */
export function cappedReview(
  review: Pick<ReviewSnapshot, "body" | "comments">,
  recordedEvent: string | undefined,
): HostReview {
  const body = cut(review.body, PROOF_BODY_CAP);
  const event = REVIEW_EVENTS.find((e) => e === recordedEvent);
  return {
    ...(event !== undefined ? { event } : {}),
    body: body.text,
    ...(body.cut ? { body_truncated: true as const } : {}),
    comments: review.comments.slice(0, PROOF_COMMENT_CAP).map((c) => {
      const text = cut(c.body, PROOF_COMMENT_BODY_CAP);
      return {
        path: c.path.slice(0, PROOF_PATH_CAP),
        line: Number.isInteger(c.line) && c.line > 0 ? c.line : 0,
        body: text.text,
        ...(text.cut ? { truncated: true as const } : {}),
      };
    }),
    comments_total: review.comments.length,
  };
}

// ---- the proof record's one writer -----------------------------------------------------

/**
 * The wizard's proof step, with a run that waits for nothing: it records the
 * practice round `observed` hands it, the one `proof-result` has just seen
 * finished and is about to return. Its id, its place and its verify are the
 * wizard's, so the checklist holds one proof step whoever ran it, and the
 * go-live step reads the record where it always has.
 */
export function hostProofStep(observed: () => ProofRecord | null): OnboardingStep {
  return {
    ...proofRoundStep(),
    async run(ctx): Promise<StepReport> {
      const record = observed();
      if (record === null)
        return {
          ok: false,
          checks: [{ name: "proof", ok: false, detail: "no finished practice round was observed" }],
        };
      ctx.recordChoice(CHOICE_KEYS.proof, record);
      return {
        ok: true,
        checks: [
          {
            name: "proof",
            ok: true,
            detail: `#${record.pr} round ${record.round_no} finished with ${record.verdict}; its review was returned to the host`,
          },
        ],
        data: { proof: record },
      };
    },
  };
}

/** A practice round that produced no review: the words are capped as a
 * refusal's are, whatever a step or the daemon put in them. */
const failed = (reason: HostReason, text: string, pr: number): HostAnswer => ({
  state: "failed",
  reason,
  message: text.slice(0, HOST_MESSAGE_CAP),
  pr,
});

/** Read the finished round's review, record the proof, and print it. */
async function show(
  ports: HostPorts,
  transport: StackTransport,
  pr: number,
  round: ObservedRound & { verdict: string },
): Promise<HostAnswer> {
  const read = await readContainerDryrun(transport, 40, {
    since: Date.parse(round.started_at),
    pr,
  });
  const records = roundRecords(read.records, round).filter((r) => recordForPr(r, pr));
  const record = read.problem !== "" ? null : sandboxReviewRecord(records, pr);
  const review = record === null ? null : sandboxReviewFrom(records, pr);
  if (record === null || review === null)
    return failed(
      "no_dry_run_record",
      `round ${round.round_no} of #${pr} finished, and no review of it is in the dry-run record: nothing was recorded as a practice review`,
      pr,
    );
  // A round already recorded and returned is returned again as it is.
  const before = recordedAndShown(ports, pr, round);
  const recorded = before !== null ? before : await recordProof(ports, pr, round);
  if (typeof recorded !== "string") return recorded;
  return {
    state: "done",
    pr,
    proof: { pr, round_no: round.round_no, verdict: round.verdict, completed_at: recorded },
    review: cappedReview(review, recordedReviewEvent(record)),
  };
}

/**
 * Write the checklist's proof record for this round and mark it as shown,
 * under the checklist lock. The time it was recorded, or the answer that
 * says why it was not.
 */
async function recordProof(
  ports: HostPorts,
  pr: number,
  round: ObservedRound & { verdict: string },
): Promise<string | HostAnswer> {
  const got = acquireChecklistLock(ports.stateDir, "proof", lockOptions(ports));
  if (!got.ok) return { state: "busy", holder: got.held.holder, pr };
  try {
    const at = ports.now().toISOString();
    const record: ProofRecord = {
      pr,
      round_no: round.round_no,
      verdict: round.verdict,
      completed_at: at,
      review_shown: true,
    };
    const registry = new StepRegistry(
      ports
        .registry()
        .steps()
        .map((s) => (s.id === PROOF_STEP_ID ? hostProofStep(() => record) : s)),
    );
    const wrote = await ports.checklist(registry).runStep(PROOF_STEP_ID);
    if (!wrote.ok)
      return failed(
        "record_failed",
        `the practice review of #${pr} could not be recorded: ${wrote.failures.join("; ") || "the checklist did not take it"}`,
        pr,
      );
    updateHostRecord(ports.stateDir, (r) => ({
      ...r,
      proof_shown: { pr, round_no: round.round_no, shown_at: at },
    }));
    return at;
  } finally {
    got.lock.release();
  }
}

/** When this round was recorded as the proof and returned before; null when
 * it was not. */
function recordedAndShown(
  ports: HostPorts,
  pr: number,
  round: ObservedRound & { verdict: string },
): string | null {
  const recorded = recordedProofIn(ports.stateDir);
  if (recorded === undefined) return null;
  if (recorded.pr !== pr || recorded.round_no !== round.round_no) return null;
  if (recorded.verdict !== round.verdict) return null;
  return proofWasShown(readHostRecord(ports.stateDir), recorded) ? recorded.completed_at : null;
}

/** The `proof-result` verb. */
export async function hostProofResult(
  ports: HostPorts,
  args: readonly string[],
): Promise<HostAnswer> {
  const no = admit(ports);
  if (no !== null) return no;
  const pr = parsePrArg("proof-result", args);
  if (typeof pr === "string") return refused("usage", pr);
  const request = readHostRecord(ports.stateDir).proof_request;
  if (request === undefined || request.pr !== pr) return { state: "not_started", pr };
  const at = await standing(ports);
  if (isAnswer(at)) return at;
  const obs = await observe(at.transport, pr);
  if (obs === null)
    return failed("reviewer_unreachable", "the reviewer's own state could not be read", pr);
  const outcome = classifyRounds({
    ...obs,
    rounds: obs.rounds.filter((r) => r.round_no > request.floor),
  });
  if (outcome.kind === "done" && completedRound(outcome.round))
    return show(ports, at.transport, pr, outcome.round);
  if (outcome.kind === "failed")
    return failed(
      "round_failed",
      `round ${outcome.round.round_no} of #${pr} ended as "${oneLine(outcome.round.status).slice(0, 40)}"`,
      pr,
    );
  if (outcome.kind === "waiting") {
    // asked, and no round yet: the daemon may have said no since
    if (request.command !== undefined) {
      const receipt = await receiptOf(at.transport, request.command);
      if (receipt.kind === "refused")
        return failed(
          "review_refused",
          `the reviewer refused to review #${pr}: ${receipt.reason}`,
          pr,
        );
    }
    // or settled it without a new round: that head's review is the answer
    const last = obs.rounds.at(-1);
    const waited = ports.now().getTime() - Date.parse(request.requested_at);
    if (
      obs.state !== "queued" &&
      obs.state !== "reviewing" &&
      waited >= SETTLED_AFTER_MS &&
      completedRound(last)
    )
      return show(ports, at.transport, pr, last);
  }
  return { state: "running", pr };
}
