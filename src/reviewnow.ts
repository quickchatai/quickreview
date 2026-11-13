// "Review this PR now" — the operator's `review-now` command (src/commands.ts,
// root-sealed operator channel only).
//
// It queues ONE pull request for a human-asked round, the same state-machine
// event a fresh trigger label produces (`trigger`, source `manual`, so the
// round's provenance is the person's ask and dispatch reviews it in full),
// and then pumps dispatch. It makes no GitHub write to ask for the review:
// the label path stays the way later reviews are requested, and every write
// the round itself makes still goes through the one MutationGate.
//
// The PR is read from GitHub first (one GET), so a closed or merged PR, or a
// number that is not a PR of the reviewed repo, is refused with its reason
// instead of being adopted into the state store.
//
// `--state-machines` records the same request for the state-machine family
// (src/staterequest.ts). `--security` also records the operator's request for a security review
// (src/securityrequest.ts): every round of the PR then plans the security
// family, and the request is new evidence, so a PR already reviewed at its
// head is reviewed again rather than skipped. A request that lands while a
// round runs is served once that round settles.
import type { PrRef } from "./github.js";
import type { FileOutcome } from "./improvements.js";
import {
  applySecurityRequest,
  SECURITY_REQUEST_KIND,
  type SecurityRequestOutcome,
} from "./securityrequest.js";
import { STATE_REQUEST_KIND } from "./staterequest.js";
import { applyEvent } from "./statemachine.js";
import type { StateStore } from "./state.js";

export interface ReviewNowDeps {
  store: StateStore;
  /** The PR as GitHub has it (read-only). */
  getPr(n: number): Promise<PrRef>;
  pump(): Promise<void>;
  /** The App's bot login, whose own PRs are never reviewed. Absent on the
   * own-account route, where the "bot" is the person and their own PRs are
   * exactly what they ask to have reviewed. */
  botLogin?: string;
  now?: () => Date;
}

/** The login an operator request is recorded under. */
export const OPERATOR_REQUESTER = "operator";

/** What `--security` (or `--state-machines`: `what` names the review) did,
 * for the operator's receipt. */
function securityOutcome(o: SecurityRequestOutcome, what = "security"): string {
  if (!o.fresh)
    return o.reason === "closed"
      ? `${what} review not requested: closed`
      : o.reason === "upgraded"
        ? `${what} review already requested by label; it now stands until the PR closes`
        : `${what} review already requested`;
  return o.served
    ? `${what} review requested`
    : `${what} review requested; it runs once the round in flight settles`;
}

export async function reviewNow(
  deps: ReviewNowDeps,
  pr: number,
  opts: { security?: boolean; stateMachines?: boolean } = {},
): Promise<FileOutcome> {
  let ref: PrRef;
  try {
    ref = await deps.getPr(pr);
  } catch (err) {
    return {
      ok: false,
      reason: `could not read PR #${pr} from GitHub: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (ref.merged) return { ok: false, reason: `PR #${pr} is merged — there is nothing to review` };
  if (ref.state !== "open") return { ok: false, reason: `PR #${pr} is closed` };
  const local = deps.store.getPr(pr);
  if (local?.paused)
    return { ok: false, reason: `PR #${pr} is paused — resume it first (qcr resume-pr ${pr})` };
  // The worker crash-loop breaker parks a PR after repeated worker failures
  // (a missing model login is the usual first-install cause). Asking for this
  // PR's review is the operator's word that it may run again, exactly as
  // rerun-round's unpark is — without it the new round could never start.
  if (deps.store.clearWorkerBreaker(pr))
    deps.store.logEvent("worker_unparked", pr, { by: "review-now" });
  const meta = { title: ref.title, head_sha: ref.head_sha, author: ref.author };
  // The reviews asked for with the round: `--security`, `--state-machines`
  // (src/staterequest.ts), or both — one request row per kind.
  const asked: Array<{ kind: string; what: string }> = [
    ...(opts.security ? [{ kind: SECURITY_REQUEST_KIND, what: "security" }] : []),
    ...(opts.stateMachines ? [{ kind: STATE_REQUEST_KIND, what: "state-machine" }] : []),
  ];
  const outcomes: Array<{ o: SecurityRequestOutcome; what: string }> = [];
  for (const { kind, what } of asked) {
    const o = applySecurityRequest(
      deps.store,
      { pr, source: "operator", by: OPERATOR_REQUESTER },
      {
        meta,
        ...(deps.botLogin ? { botLogin: deps.botLogin } : {}),
        ...(deps.now ? { now: deps.now } : {}),
      },
      kind,
    );
    outcomes.push({ o, what });
  }
  const receipt = (): string => outcomes.map(({ o, what }) => securityOutcome(o, what)).join("; ");
  // Served: a request's own trigger queued the round. A bot-authored PR
  // withdraws the request and falls through to the refusal below.
  if (outcomes.some(({ o }) => o.fresh && o.served)) {
    await deps.pump();
    const state = deps.store.getPr(pr)?.state ?? "queued";
    return { ok: true, pr, state, head_sha: ref.head_sha, outcome: receipt() };
  }
  const result = applyEvent(
    deps.store,
    pr,
    { type: "trigger", source: "manual" },
    {
      title: ref.title,
      head_sha: ref.head_sha,
      author: ref.author,
      trigger_ts: (deps.now ?? (() => new Date()))().toISOString(),
    },
    {
      ...(deps.botLogin ? { botLogin: deps.botLogin } : {}),
      ...(deps.now ? { now: deps.now } : {}),
      reason: "operator:review-now",
    },
  );
  if (result.skipped === "bot-author")
    return {
      ok: false,
      reason: `PR #${pr} is authored by the bot itself — it never reviews its own PRs`,
    };
  await deps.pump();
  const state = deps.store.getPr(pr)?.state ?? result.to;
  return {
    ok: true,
    pr,
    state,
    head_sha: ref.head_sha,
    ...(outcomes.length > 0 ? { outcome: receipt() } : {}),
  };
}
