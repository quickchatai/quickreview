// The reconcile poll (spec §3, §3.4) — the correctness backbone.
// GitHub never redelivers a failed webhook, so every 5 minutes (and on
// startup) the daemon rebuilds the truth from the API and forces local state
// to match. GitHub always wins. Every correction is logged as a
// `reconcile_correction` event: a rising correction rate is the webhook-health
// signal the operator watches.
import { retryWithheldApproval, type CheckSummary } from "./cigate.js";
import { recheckFingerprint } from "./recheck.js";
import { normalizeVerdict } from "./types.js";
import type { Config } from "./config.js";
import type { PrRef } from "./github.js";
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
}

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
}

export interface ReconcileReport {
  ran_at: string;
  open_prs: number;
  triggered: number[];
  closed: number[];
  awaiting_human: number[];
  backfilled_comments: number;
  corrections: number;
  errors: string[];
}

function correction(deps: ReconcileDeps, pr: number | null, what: string, detail: unknown, report: ReconcileReport): void {
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
    store.markRoundCancelled(round.id, "orphaned — tmux session lost across a restart");
    store.logEvent("round_orphaned", round.pr, { round_id: round.id, round_no: round.round_no });
    cancelled.push(round.pr);
    log(`startup: #${round.pr} round ${round.round_no} cancelled (session lost)`);
    const row = store.getPr(round.pr);
    if (row?.state === "reviewing" && !store.hasLaterRound(round.pr, round.round_no)) {
      // "reviewing" was true only while the session lived. Same move as the
      // overseer's rerun-round command: back to queued for a fresh dispatch.
      store.upsertPr({ ...row, state: "queued", trigger_ts: now().toISOString() });
      store.logEvent("orphaned_round_requeued", round.pr, { round_id: round.id, round_no: round.round_no });
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
    awaiting_human: [],
    backfilled_comments: 0,
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
        applyEvent(store, pr.number, { type: "track" }, { title: pr.title, head_sha: pr.head_sha, author: pr.author }, { botLogin, now });
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
          reviewed.verdict === "APPROVE" &&
          reviewed.head_sha !== pr.head_sha &&
          !store.hasRecheck(pr.number, recheckFingerprint({ trigger: "push" }, pr.head_sha))
        ) {
          (deps.log ?? (() => {}))(`reconcile: recheck backstop #${pr.number} — reviewed ${reviewed.head_sha.slice(0, 7)} != head ${pr.head_sha.slice(0, 7)}, unclaimed`);
          try {
            await deps.onHeadPush(pr.number, pr.head_sha);
          } catch (err) {
            report.errors.push(`onHeadPush(backstop) #${pr.number}: ${String(err)}`);
            (deps.log ?? (() => {}))(`reconcile: onHeadPush backstop failed #${pr.number}`, err);
          }
        }
      }
      if (local.state === "closed") {
        // GitHub says open, we say closed → GitHub wins.
        correction(deps, pr.number, "reopened", { local: local.state }, report);
        applyEvent(store, pr.number, { type: "reopened" }, { title: pr.title, head_sha: pr.head_sha, author: pr.author }, { botLogin, now });
      }
    }
  });

  // ---- 2. triggered-set derivation (both searches) ------------------------
  await step("triggered-set", async () => {
    const [labelled, teamed] = await Promise.all([adapter.searchLabelTriggered(), adapter.searchTeamTriggered()]);
    const seen = new Set<number>();
    for (const [source, items] of [
      ["label", labelled],
      ["team_request", teamed],
    ] as const) {
      for (const item of items) {
        if (seen.has(item.number)) continue;
        seen.add(item.number);
        if (isBotAuthor(item.user?.login ?? "", botLogin) || item.user?.type === "Bot") continue;
        const ref = open.get(item.number);
        const local = store.getPr(item.number);
        const meta = {
          title: ref?.title ?? item.title,
          head_sha: ref?.head_sha ?? local?.head_sha ?? "",
          author: ref?.author ?? item.user?.login ?? "",
          trigger_ts: local?.trigger_ts ?? item.updated_at ?? now().toISOString(),
        };
        report.triggered.push(item.number);
        if (local?.paused) continue; // overseer pause-pr: no re-trigger until resumed
        if (local?.state === "queued" || local?.state === "reviewing") continue; // already handled
        // Dry-run never consumes triggers on GitHub, so an already-reviewed
        // head would re-queue forever; suppress until the head moves.
        if (cfg.dry_run && meta.head_sha && store.lastVerdictHead(item.number) === meta.head_sha) {
          deps.log?.(`dry-run: suppressing re-trigger of #${item.number} at reviewed head ${meta.head_sha.slice(0, 10)}`);
          continue;
        }
        correction(deps, item.number, "triggered-not-queued", { local: local?.state ?? null, source }, report);
        applyEvent(store, item.number, { type: "trigger", source: "reconcile" }, meta, { botLogin, now, reason: `reconcile:${source}` });
      }
    }
  });

  // Commits never dispatch a review. Open-PR truth above refreshes the stored
  // head, but only the explicit label/team triggered-set may queue a round.

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
      correction(deps, local.number, "pr-closed", { merged: ref.merged, local: local.state }, report);
      // same signal the webhook's closed case derives — a merge
      // landing over a standing REQUEST_CHANGES. Read the state BEFORE
      // applyEvent erases it; per-(pr, day) dedupe absorbs the overlap with
      // a webhook delivery that already fired.
      const mergedOverBlock = ref.merged && local.state === "awaiting_author";
      applyEvent(store, local.number, { type: "closed" }, { title: ref.title, head_sha: ref.head_sha, author: ref.author }, { botLogin, now });
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
          correction(deps, local.number, "withheld-approval-requeued", { head_sha: mark.head_sha, ci: outcome.ci }, report);
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

  // ---- 6. retired-park migration -------------------------------------------
  // awaiting_human was RETIRED on 2026-08-19 (the owner: the review is never
  // handed to a human — the AI keeps driving). Nothing transitions into it any
  // more; any lingering legacy row is migrated here to the state its standing
  // verdict implies (REQUEST_CHANGES ⇒ awaiting_author, else tracked — never
  // an approval that was not posted). Idempotent: after one pass the census
  // stays empty.
  for (const parked of store.allPrs().filter((p) => p.state === "awaiting_human")) {
    const standing = normalizeVerdict(store.reviewedHead(parked.number)?.verdict);
    const to = standing === "REQUEST_CHANGES" ? ("awaiting_author" as const) : ("tracked" as const);
    store.upsertPr({ ...parked, state: to });
    store.logEvent("unparked_retired_state", parked.number, { from: "awaiting_human", to, standing: standing ?? null });
    report.corrections += 1;
    (deps.log ?? (() => {}))(`reconcile: unparked #${parked.number} (awaiting_human retired) → ${to}`);
    report.awaiting_human.push(parked.number);
  }

  store.logEvent("reconcile_pass", null, {
    open_prs: report.open_prs,
    triggered: report.triggered.length,
    closed: report.closed.length,
    awaiting_human: report.awaiting_human.length,
    corrections: report.corrections,
    errors: report.errors.length,
  });
  return report;
}
