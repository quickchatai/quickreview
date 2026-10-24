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
import type { PrRef } from "./github.js";
import type { FileOutcome } from "./improvements.js";
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

export async function reviewNow(deps: ReviewNowDeps, pr: number): Promise<FileOutcome> {
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
  return { ok: true, pr, state, head_sha: ref.head_sha };
}
