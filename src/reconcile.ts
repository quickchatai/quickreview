// The reconcile poll (spec §3, §3.4) — the correctness backbone.
// GitHub never redelivers a failed webhook, so every 5 minutes (and on
// startup) the daemon rebuilds the truth from the API and forces local state
// to match. GitHub always wins. Every correction is logged as a
// `reconcile_correction` event: a rising correction rate is the webhook-health
// signal the operator watches.
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
        if (local.head_sha !== pr.head_sha) {
          // Push instant as GitHub-derived truth (webhooks may have been missed)
          // — the author-response metric reads these.
          store.logEvent("head_push", pr.number, { head_sha: pr.head_sha, source: "reconcile" });
        }
        applyEvent(store, pr.number, { type: "track" }, { title: pr.title, head_sha: pr.head_sha, author: pr.author }, { botLogin, now });
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
      applyEvent(store, local.number, { type: "closed" }, { title: ref.title, head_sha: ref.head_sha, author: ref.author }, { botLogin, now });
      store.logEvent("pr_closed", local.number, { merged: ref.merged, source: "reconcile" });
      report.closed.push(local.number);
      try {
        await deps.hooks.archiveAndClose(local.number);
      } catch (err) {
        report.errors.push(`archiveAndClose #${local.number}: ${String(err)}`);
      }
    }
  });

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

  // ---- 6. parked-PR census -----------------------------------------------
  // Until 2026-08-18 this step searched GitHub for PRs where the escalation
  // reviewer was awaited and parked them locally. With escalation scrapped,
  // nothing requests a reviewer, so the GitHub side carries no such signal:
  // awaiting_human is now purely a local state and the report just counts it.
  report.awaiting_human.push(...store.allPrs().filter((p) => p.state === "awaiting_human").map((p) => p.number));

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
