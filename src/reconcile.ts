// The reconcile poll (spec §3, §3.4) — the correctness backbone.
// GitHub never redelivers a failed webhook, so every 5 minutes (and on
// startup) the daemon rebuilds the truth from the API and forces local state
// to match. GitHub always wins. Every correction is logged as a
// `reconcile_correction` event: a rising correction rate is the webhook-health
// signal the operator watches.
import {
  capturedFromIssueComment,
  capturedFromReview,
  capturedFromReviewComment,
  isHumanCapture,
  type CapturedComment,
} from "./capture.js";
import { retryWithheldApproval, type CheckSummary } from "./cigate.js";
import { auditUngatedReviews, hasUngatedApproval, ungatedReviewMessage } from "./execboundary.js";
import { recheckFingerprint } from "./recheck.js";
import { recheckPromptMarker } from "./types.js";
import { standingVerdict } from "./standing-review.js";
import { DEFAULT_ROUND_STALL_GRACE_MIN, type Config } from "./config.js";
import type { IssueCommentFull, PrRef, ReviewCommentFull, ReviewFull } from "./github.js";
import { applyEvent, isBotAuthor } from "./statemachine.js";
import type { StateStore } from "./state.js";
import type { SessionHooks } from "./types.js";

export interface ReconcileSearchItem {
  number: number;
  title: string;
  user: { login: string; type: string };
  updated_at: string;
  created_at: string;
}

/** The read-only slice of GitHubAdapter reconcile needs. */
export interface ReconcileAdapter {
  searchLabelTriggered(): Promise<ReconcileSearchItem[]>;
  searchTeamTriggered(): Promise<ReconcileSearchItem[]>;
  listOpenPrs(): Promise<PrRef[]>;
  getPr(n: number): Promise<PrRef>;
  listBotReviewComments(n: number): Promise<number[]>;
  getRequestedReviewers(n: number): Promise<{ users: string[]; teams: string[] }>;
  /** Checks at a ref — the withheld-approval backstop reads CI
   * through this. Optional: a stub-wired daemon without it simply has no
   * backstop, exactly as it had none before the slice existed. */
  listChecks?(ref: string): Promise<CheckSummary[]>;
  /** The comment-capture sweep's three READ sources. All optional and
   * all-or-nothing: a stub-wired daemon without them simply has no backstop,
   * exactly as it had none before the slice existed. Reads only — capture
   * never writes to GitHub. */
  listReviewCommentsFull?(n: number): Promise<ReviewCommentFull[]>;
  listIssueComments?(n: number): Promise<IssueCommentFull[]>;
  listReviewsFull?(n: number): Promise<ReviewFull[]>;
}

/**
 * Per-pass bound on the comment-capture sweep: three API reads per
 * PR, so the sweep must never grow with the whole tracked history. Freshest
 * local activity first — a PR nobody has touched in weeks is not where a
 * missed comment lives, and the ones left out are picked up on a later pass as
 * soon as they move.
 */
export const COMMENT_SWEEP_MAX_PRS = 25;

/**
 * How long after a PR closes the capture sweep still includes it. The
 * closed-sync step earlier in the SAME pass is what marks a PR closed, so a
 * blanket `state !== "closed"` filter would skip exactly the PR that closed
 * while the daemon was down — the scenario the sweep exists to recover. The
 * rule: a closed PR is swept when it transitioned this pass, or when its row
 * last moved (which for a closed PR is the close itself — nothing writes the
 * row after that) within this window. The watermark below makes the repeat
 * cost of the window one skipped filter check, not three API reads.
 */
export const COMMENT_SWEEP_CLOSED_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ReconcileDeps {
  cfg: Config;
  store: StateStore;
  adapter: ReconcileAdapter;
  hooks: SessionHooks;
  now?: () => Date;
  log?: (msg: string, extra?: unknown) => void;
  /** Registry backfill is an API call per open PR; the daemon runs it every
   * Nth poll. Default true. */
  backfillRegistry?: boolean;
  /** Backstop for the push trigger (live gap 2026-08-19, PR #5307):
   * the webhook's `onSynchronize` is the fast path, but a lost/dead webhook
   * means a post-review push is otherwise never rechecked — the withheld-
   * approval retry no-ops on a moved head ("a push re-reviews through its own
   * route") while that route never fires. Same idiom as the sweep:
   * the daemon wires runRecheck here, never a copy. */
  onHeadPush?: (pr: number, head_sha: string) => Promise<void>;
  /** backstop: the merged-over-block feedback signal for closes the
   * webhook missed (GitHub never redelivers). The daemon wires the same
   * engine sink the webhook path uses; dedupe is the store's. */
  onMergedOverBlock?: (pr: number) => Promise<void> | void;
  /** backstop: capture comments the webhook never saw (GitHub never
   * redelivers, so a comment posted while the daemon was down would otherwise
   * be permanent evidence loss). Default on when the adapter can read;
   * `false` disables it for a poll that must stay cheap. */
  captureComments?: boolean;
}

export interface ReconcileReport {
  ran_at: string;
  open_prs: number;
  triggered: number[];
  closed: number[];
  backfilled_comments: number;
  /** Human comments the sweep captured that the webhook had missed.
   * A rising number is the same webhook-health signal `corrections` is. */
  captured_comments: number;
  corrections: number;
  errors: string[];
}

function correction(
  deps: ReconcileDeps,
  pr: number | null,
  what: string,
  detail: unknown,
  report: ReconcileReport,
): void {
  report.corrections++;
  deps.store.logEvent("reconcile_correction", pr, { what, ...(detail as object) });
  (deps.log ?? (() => {}))(`reconcile: correction ${what}${pr ? ` #${pr}` : ""}`, detail);
}

/** Startup repair: a DB round marked running whose tmux session did not
 * survive the restart will never produce a verdict — it would sit as a
 * phantom until its deadline, holding a capacity slot and then corrupting the
 * PR via the overdue path. Cancel it; if it was the PR's newest round and the
 * PR still says reviewing, requeue so the lost work is redone. */
export function reconcileOrphanedRounds(
  store: StateStore,
  adoptedPrs: Iterable<number>,
  opts: { botLogin: string; now?: () => Date; log?: (msg: string, extra?: unknown) => void },
): { cancelled: number[]; requeued: number[] } {
  const live = new Set(adoptedPrs);
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});
  const cancelled: number[] = [];
  const requeued: number[] = [];
  for (const round of store.runningRounds()) {
    if (live.has(round.pr)) continue;
    // `orphan_sweep` is the QUIET cause: tmux lives in the container,
    // so a clean redeploy orphans every round in flight by construction. It is
    // counted and grouped like every other cause, and it raises nothing.
    store.markRoundCancelled(
      round.id,
      "orphaned — tmux session lost across a restart",
      "orphan_sweep",
    );
    store.logEvent("round_orphaned", round.pr, { round_id: round.id, round_no: round.round_no });
    cancelled.push(round.pr);
    log(`startup: #${round.pr} round ${round.round_no} cancelled (session lost)`);
    const row = store.getPr(round.pr);
    if (row?.state === "reviewing" && !store.hasLaterRound(round.pr, round.round_no)) {
      // "reviewing" was true only while the session lived. A durable newer
      // head wins; otherwise redo the lost head.
      const successorPromoted = store.promoteSuccessor(round.pr);
      if (!successorPromoted)
        store.upsertPr({ ...row, state: "queued", trigger_ts: now().toISOString() });
      store.logEvent("orphaned_round_requeued", round.pr, {
        round_id: round.id,
        round_no: round.round_no,
        successor_promoted: successorPromoted,
      });
      requeued.push(round.pr);
      log(`startup: #${round.pr} requeued — its in-flight round was lost`);
    }
  }
  return { cancelled, requeued };
}

/** One reconcile pass. Never throws: per-step failures land in
 * `report.errors` so a single bad PR or a flaky API call cannot stall the
 * daemon. */
export async function reconcileOnce(deps: ReconcileDeps): Promise<ReconcileReport> {
  const { store, cfg, adapter } = deps;
  const now = deps.now ?? (() => new Date());
  const botLogin = cfg.github.bot_login;
  const report: ReconcileReport = {
    ran_at: now().toISOString(),
    open_prs: 0,
    triggered: [],
    closed: [],
    backfilled_comments: 0,
    captured_comments: 0,
    corrections: 0,
    errors: [],
  };

  const step = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      report.errors.push(`${name}: ${String(err)}`);
      (deps.log ?? (() => {}))(`reconcile: step ${name} failed`, err);
    }
  };

  // ---- 1. open-PR truth ---------------------------------------------------
  const open = new Map<number, PrRef>();
  await step("listOpenPrs", async () => {
    for (const pr of await adapter.listOpenPrs()) open.set(pr.number, pr);
    report.open_prs = open.size;
    for (const pr of open.values()) {
      if (isBotAuthor(pr.author, botLogin)) continue;
      const local = store.getPr(pr.number);
      if (!local) continue; // untriggered PRs are not tracked (no sweeps, spec §8)
      if (local.head_sha !== pr.head_sha || local.title !== pr.title) {
        const pushed = local.head_sha !== pr.head_sha;
        if (pushed) {
          // Push instant as GitHub-derived truth (webhooks may have been missed)
          // — the author-response metric reads these.
          store.logEvent("head_push", pr.number, { head_sha: pr.head_sha, source: "reconcile" });
        }
        applyEvent(
          store,
          pr.number,
          { type: "track" },
          { title: pr.title, head_sha: pr.head_sha, author: pr.author },
          { botLogin, now },
        );
        if (pushed && deps.onHeadPush) {
          // After the track so the recheck reads the updated row. Errors are
          // contained: a failed recheck must not abort the reconcile pass.
          try {
            await deps.onHeadPush(pr.number, pr.head_sha);
          } catch (err) {
            report.errors.push(`onHeadPush #${pr.number}: ${String(err)}`);
            (deps.log ?? (() => {}))(`reconcile: onHeadPush failed #${pr.number}`, err);
          }
        }
      } else if (deps.onHeadPush) {
        // Lost-recheck backstop (live: #5290, 2026-08-19): change-detection
        // fires onHeadPush exactly once, so a recheck that failed to deliver
        // (or died with the process) never retried once the head was tracked.
        // A standing reviewed head that differs from the current head, with
        // this exact question unclaimed, is re-asked; claimed questions
        // (nudged, or answered trivially) dedupe before any classification.
        const reviewed = store.reviewedHead(pr.number);
        if (
          reviewed &&
          standingVerdict(reviewed) === "APPROVE" &&
          reviewed.head_sha !== pr.head_sha &&
          !store.hasRecheck(pr.number, recheckFingerprint({ trigger: "push" }, pr.head_sha))
        ) {
          (deps.log ?? (() => {}))(
            `reconcile: recheck backstop #${pr.number} — reviewed ${reviewed.head_sha.slice(0, 7)} != head ${pr.head_sha.slice(0, 7)}, unclaimed`,
          );
          try {
            await deps.onHeadPush(pr.number, pr.head_sha);
          } catch (err) {
            report.errors.push(`onHeadPush(backstop) #${pr.number}: ${String(err)}`);
            (deps.log ?? (() => {}))(`reconcile: onHeadPush backstop failed #${pr.number}`, err);
          }
        }
      }
      // GitHub owns head truth. A successor can outlive its predecessor and
      // can also survive a crash after the PR row was corrected, so enforce
      // this independently of whether THIS pass observed a local head change.
      // The store preserves predecessor, first-request FIFO time, and sticky
      // human provenance while coalescing only the target head.
      const successor = store.successorFor(pr.number);
      if (successor && successor.head_sha !== pr.head_sha) {
        store.recordSuccessor({
          pr: pr.number,
          predecessor_round_id: successor.predecessor_round_id,
          head_sha: pr.head_sha,
          provenance: successor.provenance,
          reason: "reconcile-authoritative-head",
        });
      }
      if (local.state === "closed") {
        // GitHub says open, we say closed → GitHub wins.
        correction(deps, pr.number, "reopened", { local: local.state }, report);
        applyEvent(
          store,
          pr.number,
          { type: "reopened" },
          { title: pr.title, head_sha: pr.head_sha, author: pr.author },
          { botLogin, now },
        );
      }
    }
  });

  // ---- 2. triggered-set derivation (both searches) ------------------------
  await step("triggered-set", async () => {
    const [labelled, teamed] = await Promise.all([
      adapter.searchLabelTriggered(),
      adapter.searchTeamTriggered(),
    ]);
    const kinds = ["label", "team_request"] as const;
    const searches = { label: labelled, team_request: teamed };
    const current = {
      label: new Set(labelled.map((item) => item.number)),
      team_request: new Set(teamed.map((item) => item.number)),
    };

    // Snapshot BEFORE writing this poll. GitHub searches expose current levels,
    // not the edge that created them; this durable previous observation is what
    // distinguishes a new human request from residue left by an older round.
    const previous = new Map<string, boolean | undefined>();
    for (const pr of open.keys()) {
      if (!store.getPr(pr)) continue; // untriggered PRs acquire observations when first triggered
      for (const kind of kinds) previous.set(`${pr}:${kind}`, store.triggerLevel(pr, kind));
    }

    const grouped = new Map<
      number,
      { item: ReconcileSearchItem; kinds: Array<(typeof kinds)[number]> }
    >();
    for (const kind of kinds) {
      for (const item of searches[kind]) {
        if (isBotAuthor(item.user?.login ?? "", botLogin) || item.user?.type === "Bot") continue;
        const group = grouped.get(item.number) ?? { item, kinds: [] };
        group.kinds.push(kind);
        grouped.set(item.number, group);
      }
    }

    // Record both presence and absence. Remove→re-add is a fresh edge even
    // when its webhook was lost; rows survive daemon restarts.
    for (const pr of open.keys()) {
      if (!store.getPr(pr) && !grouped.has(pr)) continue;
      for (const kind of kinds) store.observeTriggerLevel(pr, kind, current[kind].has(pr));
    }

    for (const [pr, group] of grouped) {
      const ref = open.get(pr);
      const local = store.getPr(pr);
      const meta = {
        title: ref?.title ?? group.item.title,
        head_sha: ref?.head_sha ?? local?.head_sha ?? "",
        author: ref?.author ?? group.item.user?.login ?? "",
        trigger_ts: local?.trigger_ts ?? group.item.updated_at ?? now().toISOString(),
      };
      report.triggered.push(pr);
      if (local?.paused) continue; // overseer pause-pr: no re-trigger until resumed

      // Only an observed absent→present transition is a fresh edge. Undefined
      // is bootstrap history for an existing row (the table is additive on
      // deploy), not proof a person just acted. A PR never tracked before is
      // different: its first trigger is the human ask that brings it in.
      const freshKind =
        local === undefined
          ? group.kinds[0]
          : group.kinds.find((kind) => previous.get(`${pr}:${kind}`) === false);
      if (local?.state === "reviewing") {
        // A fresh request can upgrade an already-recorded pushed-head
        // successor to human provenance. Same-head requests need no second
        // round: the active one already covers that head.
        if (freshKind)
          applyEvent(store, pr, { type: "trigger", source: freshKind }, meta, {
            botLogin,
            now,
            reason: `reconcile:${freshKind}:reviewing`,
          });
        continue;
      }
      if (local?.state === "queued") continue; // already handled
      const reviewed = store.reviewedHead(pr);
      const pushHandled =
        !freshKind &&
        reviewed !== undefined &&
        standingVerdict(reviewed) === "APPROVE" &&
        reviewed.head_sha !== meta.head_sha &&
        store.hasRecheck(pr, recheckFingerprint({ trigger: "push" }, meta.head_sha));
      if (pushHandled) {
        // The targeted APPROVE path already owns this head. A standing label or
        // team request is residue, not a second blank-slate review. A genuinely
        // new edge still bypasses this branch and keeps's full review.
        store.logEvent("standing_trigger_suppressed", pr, {
          head_sha: meta.head_sha,
          kinds: group.kinds,
        });
        deps.log?.(
          `reconcile: suppressed standing trigger for #${pr} at rechecked head ${meta.head_sha.slice(0, 10)}`,
        );
        continue;
      }

      // Dry-run never consumes triggers on GitHub, so an already-reviewed
      // head would re-queue forever; suppress until the head moves.
      if (cfg.dry_run && meta.head_sha && store.lastVerdictHead(pr) === meta.head_sha) {
        deps.log?.(
          `dry-run: suppressing re-trigger of #${pr} at reviewed head ${meta.head_sha.slice(0, 10)}`,
        );
        continue;
      }
      const source = freshKind ?? "reconcile";
      correction(
        deps,
        pr,
        "triggered-not-queued",
        { local: local?.state ?? null, source, kinds: group.kinds },
        report,
      );
      applyEvent(store, pr, { type: "trigger", source }, meta, {
        botLogin,
        now,
        reason: `reconcile:${source}`,
      });
    }
  });

  // Commits outside a round never dispatch a review. A head advance WHILE an
  // older round owns the PR is different: records durable successor
  // work. Promote obligations whose predecessor became terminal across a
  // crash/restart; queue publication is idempotent and retains the evidence.
  await step("successor-obligations", async () => {
    for (const row of store.allPrs()) {
      if (store.successorFor(row.number)) store.promoteSuccessor(row.number);
    }
  });

  // ---- 2b. stale-trigger residue sweep --------------------------
  // A settled PR (tracked/awaiting_author, no round running) never
  // legitimately carries `stale_recheck` or a `trigger_ts`: both are consumed
  // by dispatch and cleared when a round settles. Residue (#5180: tracked,
  // stale_recheck=1, trigger_ts from four days earlier, zero rounds running)
  // misclassifies the NEXT explicit re-review as a staleness round and lets
  // it jump the FIFO on the ancient timestamp. Swept HERE, after the
  // triggered-set step, so a PR GitHub still lists as triggered has already
  // been re-queued and is never touched.
  // ---- 2d. undelivered recheck-claim sweep (#5362 W2) ---------------------
  // The worst of the wedge family, because nothing bounded it. `claimRecheck`
  // is written BEFORE the nudge goes out, `releaseRecheck` fires only on a
  // synchronous throw (which a bridge-level drop is not), and `rechecks` has
  // no deadline, no sweep and no expiry. So a dropped nudge left a claim that
  // suppressed the push-backstop below (`!store.hasRecheck(...)`) forever: a
  // delta on an APPROVED PR was never audited, nothing anywhere said so, and
  // the approval stood over code nobody read.
  //
  // The receipt makes it recoverable. A claim past the grace window whose
  // marker never reached the session is released, and the backstop re-asks on
  // the next pass. Every ambiguity is a no-op: only a provable absence counts.
  await step("undelivered-rechecks", async () => {
    const receipt = deps.hooks.wakeReceiptPresent;
    if (!receipt) return;
    const graceMs = (cfg.daemon.round_stall_grace_min ?? DEFAULT_ROUND_STALL_GRACE_MIN) * 60_000;
    const cutoff = new Date(now().getTime() - graceMs).toISOString();
    for (const claim of store.recheckClaimsBefore(cutoff)) {
      // A held or still-pending nudge is not a lost one.
      if (store.hasRunningRound(claim.pr)) continue;
      if (store.heldWakes(claim.pr).length > 0) continue;
      if (deps.hooks.injectPending && (await deps.hooks.injectPending(claim.pr))) continue;
      const claimedMs = Date.parse(claim.created_at);
      if (!Number.isFinite(claimedMs)) continue;
      const landed = await receipt.call(
        deps.hooks,
        claim.pr,
        recheckPromptMarker(claim.pr, claim.fingerprint),
        claimedMs,
      );
      if (landed !== false) continue; // delivered, or no evidence — never guess
      store.releaseRecheck(claim.pr, claim.fingerprint);
      correction(
        deps,
        claim.pr,
        "recheck-claim-released-undelivered",
        {
          fingerprint: claim.fingerprint,
          head_sha: claim.head_sha,
          trigger: claim.trigger,
          claimed_at: claim.created_at,
        },
        report,
      );
    }
  });

  await step("stale-trigger-residue", async () => {
    for (const local of store.allPrs()) {
      if (local.state !== "tracked" && local.state !== "awaiting_author") continue;
      if (!local.stale_recheck && local.trigger_ts === null) continue;
      if (store.hasRunningRound(local.number)) continue;
      correction(
        deps,
        local.number,
        "stale-trigger-residue-cleared",
        { state: local.state, stale_recheck: local.stale_recheck, trigger_ts: local.trigger_ts },
        report,
      );
      store.upsertPr({ ...local, stale_recheck: 0, trigger_ts: null });
    }
  });

  // ---- 3. open-PR sync: locally-live PRs GitHub no longer lists as open ----
  await step("closed-sync", async () => {
    for (const local of store.allPrs()) {
      if (local.state === "closed") continue;
      if (open.has(local.number)) continue;
      let ref: PrRef | null = null;
      try {
        ref = await adapter.getPr(local.number);
      } catch (err) {
        report.errors.push(`getPr #${local.number}: ${String(err)}`);
        continue;
      }
      if (ref.state !== "closed") continue; // listing lag — leave it alone
      correction(
        deps,
        local.number,
        "pr-closed",
        { merged: ref.merged, local: local.state },
        report,
      );
      // same signal the webhook's closed case derives — a merge
      // landing over a standing REQUEST_CHANGES. Read the state BEFORE
      // applyEvent erases it; per-(pr, day) dedupe absorbs the overlap with
      // a webhook delivery that already fired.
      const mergedOverBlock = ref.merged && local.state === "awaiting_author";
      applyEvent(
        store,
        local.number,
        { type: "closed" },
        { title: ref.title, head_sha: ref.head_sha, author: ref.author },
        { botLogin, now },
      );
      store.logEvent("pr_closed", local.number, { merged: ref.merged, source: "reconcile" });
      if (mergedOverBlock && deps.onMergedOverBlock) {
        try {
          await deps.onMergedOverBlock(local.number);
        } catch (err) {
          report.errors.push(`onMergedOverBlock #${local.number}: ${String(err)}`);
        }
      }
      report.closed.push(local.number);
      try {
        await deps.hooks.archiveAndClose(local.number);
      } catch (err) {
        report.errors.push(`archiveAndClose #${local.number}: ${String(err)}`);
      }
    }
  });

  // ---- 4. withheld-approval backstop ----------------------------
  // cigate.ts promises that a PR whose approval was withheld for red CI is
  // re-queued "by the next completion (or the reconcile poll)". The
  // `ci_completed` webhook is the fast path; this sweep is the backstop for a
  // lost delivery — without it a missed green would leave the PR waiting on a
  // verdict that is never re-attempted. Same idiom as every other step:
  // GitHub (the CI state at the recorded head) always wins, corrections
  // logged. The retry itself is retryWithheldApproval — the exact function the
  // webhook path calls — never a copy.
  if (adapter.listChecks) {
    await step("withheld-approvals", async () => {
      for (const local of store.allPrs()) {
        if (local.state === "closed") continue;
        const mark = store.approvalWithheld(local.number);
        if (!mark) continue;
        const outcome = await retryWithheldApproval(
          {
            cfg,
            store,
            adapter: { listChecks: (ref) => adapter.listChecks!(ref) },
            now,
            ...(deps.log ? { log: deps.log } : {}),
          },
          { pr: local.number, head_sha: mark.head_sha },
        );
        if (outcome.action === "requeued")
          correction(
            deps,
            local.number,
            "withheld-approval-requeued",
            { head_sha: mark.head_sha, ci: outcome.ci },
            report,
          );
      }
    });
  }

  // ---- 5. bot-comment registry backfill ----------------------------------
  if (deps.backfillRegistry !== false) {
    await step("registry-backfill", async () => {
      for (const local of store.allPrs()) {
        if (local.state === "closed") continue;
        try {
          for (const id of await adapter.listBotReviewComments(local.number)) {
            if (store.isBotComment(id)) continue;
            store.registerBotComment(id, local.number);
            report.backfilled_comments++;
          }
        } catch (err) {
          report.errors.push(`backfill #${local.number}: ${String(err)}`);
        }
      }
    });
  }

  // ---- 5b. human-comment capture sweep --------------------------
  // The webhook is the fast path and GitHub never redelivers, so a comment
  // posted while the daemon was down is — under widened capture — permanent
  // evidence loss rather than a delayed signal. This is the backstop, and it
  // is deliberately shaped like every other sweep here: READ-ONLY (three list
  // calls per PR, no mutation anywhere in the path), bounded
  // (COMMENT_SWEEP_MAX_PRS, freshest first, one API page per source), and
  // idempotent — dedupe is GitHub's own `(source, comment_id)` identity in
  // `pr_comments`, so re-running captures nothing twice and an edited comment
  // is still the same comment.
  //
  // It captures ONLY: nothing here routes, wakes a session, stamps a mark or
  // feeds the [feedback] engine. A tagged comment picked up here gets the tag
  // recorded and nothing else — the same-day addendum stays tag-gated on the
  // webhook's feedback path, where a human is in the loop.
  if (
    deps.captureComments !== false &&
    adapter.listReviewCommentsFull &&
    adapter.listIssueComments &&
    adapter.listReviewsFull
  ) {
    await step("comment-capture", async () => {
      // Recently-closed PRs stay in: closed-sync above marks a
      // closed-during-downtime PR closed in this very pass, and its comments
      // are what this backstop exists to recover (adversarial finding,
      // review). `updated_at` is the close instant for a closed row.
      const nowMs = now().getTime();
      const closedRecently = (updated_at: string): boolean => {
        const t = Date.parse(updated_at);
        return Number.isFinite(t) && nowMs - t <= COMMENT_SWEEP_CLOSED_WINDOW_MS;
      };
      const sweepMark = (p: { number: number; updated_at: string }): string =>
        `${p.updated_at}|${open.get(p.number)?.updated_at ?? ""}`;
      const candidates = store
        .allPrs()
        .filter(
          (p) =>
            p.state !== "closed" ||
            report.closed.includes(p.number) ||
            closedRecently(p.updated_at),
        )
        // Change gating (adversarial finding: ~900 standing reads/h without
        // it): a PR whose row has not moved since the last successful sweep
        // of it has produced no webhook the sweep could have missed a
        // *newer* version of than last time — skip it. The watermark is the
        // row's own `updated_at` PAIRED with GitHub's `updated_at` for the PR
        // (from the open-PR list above), recorded per PR after a clean sweep.
        // The remote half is load-bearing: capturing a comment never moves
        // the local row, so a comment whose webhook was lost (the daemon was
        // down, no push, no title change) only shows up as GitHub's
        // timestamp moving (selfscan finding d02908a3).
        .filter((p) => store.lastCommentSweep(p.number) !== sweepMark(p))
        .sort((a, b) =>
          a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : a.number - b.number,
        )
        .slice(0, COMMENT_SWEEP_MAX_PRS);
      for (const local of candidates) {
        const n = local.number;
        let rows: CapturedComment[];
        let reviewsFetched: ReviewFull[] = [];
        try {
          const [inline, top, reviews] = await Promise.all([
            adapter.listReviewCommentsFull!(n),
            adapter.listIssueComments!(n),
            adapter.listReviewsFull!(n),
          ]);
          reviewsFetched = reviews;
          rows = [
            ...inline.map((c) => capturedFromReviewComment(n, c)),
            ...top.map((c) => capturedFromIssueComment(n, c)),
            ...reviews.map((r) => capturedFromReview(n, r)),
          ];
        } catch (err) {
          report.errors.push(`comment-capture #${n}: ${String(err)}`);
          continue;
        }
        for (const c of rows) {
          if (!isHumanCapture(c, botLogin)) continue;
          if (!store.recordPrComment({ ...c, captured_via: "reconcile" })) continue;
          report.captured_comments++;
          store.logEvent("comment_captured", n, {
            source: c.source,
            comment_id: c.comment_id,
            author: c.author,
            tagged: c.tagged,
            via: "reconcile",
          });
        }
        // ---- the exec boundary's OUTCOME layer -------------------
        // The bot's OWN reviews, which `isHumanCapture` discards two lines up,
        // are the one piece of evidence that does not care HOW a write was
        // made. Four adversarial rounds each found a live way around the
        // command-string guard; a review here that the daemon has no record of
        // posting is a violation whichever way it got there — and this costs no
        // API call, because `listReviewsFull` was already fetched above.
        // Detection only: nothing below mutates GitHub, and nothing here can
        // withdraw, retract or edit a review (rule 2 — structural, not
        // prompted; there is no such call in this module or its imports).
        try {
          const ungated = auditUngatedReviews(
            reviewsFetched,
            local.head_sha,
            {
              reviewIds: store.postedReviewIds(n),
              reviewedHead: store.reviewedHead(n) ?? undefined,
              migrationPrecheck: store.lastEventAt("migration_collision_comment", n) !== undefined,
            },
            { botLogin, appSlug: cfg.github.app_slug },
          );
          if (ungated.length > 0) {
            store.logEvent("ungated_review_detected", n, {
              head_sha: local.head_sha,
              reviews: ungated,
            });
            const message = ungatedReviewMessage(n, ungated);
            // An unaccounted APPROVE wakes; anything else stays a durable row.
            // The asymmetry is the blocker bar's: an approval posted outside
            // the gate defeats rule 1, the CI hard-gate and every posting
            // guard at once, and it is the outcome all four bypasses
            // were reaching for.
            if (hasUngatedApproval(ungated))
              store.logAnomaly("ungated_approval", n, null, message, message);
            else store.logAnomaly("ungated_review", n, null, message);
            report.errors.push(
              `ungated-review #${n}: ${ungated.length} unaccounted bot review(s) at the head`,
            );
          }
        } catch (err) {
          // Never let the audit break the sweep it rides on.
          report.errors.push(`ungated-review-audit #${n}: ${String(err)}`);
        }
        // Watermark only a CLEAN sweep of this PR — a failed read `continue`s
        // above without one, so it is retried on the next pass.
        store.markCommentSweep(n, sweepMark(local));
      }
    });
  }

  // The retired-park migration that used to run here is GONE. It
  // drained the last five `awaiting_human` rows on the live install on
  // 2026-08-19T17:04Z and never fired again; the state is no longer a member
  // of `PrLifecycleState`, so nothing can write one for it to find.

  store.logEvent("reconcile_pass", null, {
    open_prs: report.open_prs,
    triggered: report.triggered.length,
    closed: report.closed.length,
    captured_comments: report.captured_comments,
    corrections: report.corrections,
    errors: report.errors.length,
  });
  return report;
}
