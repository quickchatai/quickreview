// The reconcile poll (spec §3, §3.4) — the correctness backbone.
// GitHub never redelivers a failed webhook, so every 5 minutes (and on
// startup) the daemon rebuilds the truth from the API and forces local state
// to match. GitHub always wins. Every correction is logged as a
// `reconcile_correction` event: a rising correction rate is the webhook-health
// signal the operator watches.
import type { Config } from "./config.js";
import type { PrRef, StalePr } from "./github.js";
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
  searchAwaitingEscalationReviewer(): Promise<ReconcileSearchItem[]>;
  listOpenPrs(): Promise<PrRef[]>;
  getPr(n: number): Promise<PrRef>;
  stalenessScan(): Promise<StalePr[]>;
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
  stale: number[];
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
    stale: [],
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

  // ---- 3. staleness scan --------------------------------------------------
  await step("staleness", async () => {
    for (const stale of await adapter.stalenessScan()) {
      const ref = open.get(stale.number);
      if (ref && isBotAuthor(ref.author, botLogin)) continue;
      const local = store.getPr(stale.number);
      report.stale.push(stale.number);
      if (local?.paused) continue; // overseer pause-pr
      if (local?.stale_recheck === 1 && (local.state === "queued" || local.state === "reviewing")) continue;
      if (local?.state === "reviewing" || local?.state === "awaiting_human") continue;
      // Dry-run never posts the re-approval, so GitHub reports the same
      // stale approved_sha forever; once we've verdicted this exact head,
      // re-dispatching reviews an empty range — suppress until it moves
      // (mirrors the trigger suppression above; live-fire 2026-08-14:
      // same-head staleness rounds every poll, pure spend churn).
      if (cfg.dry_run && store.lastVerdictHead(stale.number) === stale.head_sha) {
        deps.log?.(`dry-run: suppressing staleness recheck of #${stale.number} at verdicted head ${stale.head_sha.slice(0, 10)}`);
        continue;
      }
      correction(deps, stale.number, "stale-approval", { approved_sha: stale.approved_sha, head_sha: stale.head_sha, local: local?.state ?? null }, report);
      applyEvent(
        store,
        stale.number,
        { type: "stale_detected" },
        { title: ref?.title, head_sha: stale.head_sha, author: ref?.author },
        { botLogin, now, reason: "reconcile:staleness" },
      );
    }
  });

  // ---- 4. open-PR sync: locally-live PRs GitHub no longer lists as open ----
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

  // ---- 6. awaiting-owner scan ------------------------------------------
  await step("awaiting-human", async () => {
    const items = await adapter.searchAwaitingEscalationReviewer();
    for (const item of items) {
      let requested: { users: string[]; teams: string[] };
      try {
        requested = await adapter.getRequestedReviewers(item.number);
      } catch (err) {
        report.errors.push(`requested_reviewers #${item.number}: ${String(err)}`);
        continue;
      }
      if (!requested.users.includes(cfg.github.escalation_reviewer)) continue;
      report.awaiting_human.push(item.number);
      const local = store.getPr(item.number);
      if (!local || local.state === "closed" || local.state === "awaiting_human") continue;
      if (local.state === "queued" || local.state === "reviewing") continue; // let the round land first
      correction(deps, item.number, "awaiting-human", { local: local.state }, report);
      applyEvent(store, item.number, { type: "escalation_detected" }, {}, { botLogin, now, reason: "reconcile:awaiting-human" });
    }
  });

  store.logEvent("reconcile_pass", null, {
    open_prs: report.open_prs,
    triggered: report.triggered.length,
    stale: report.stale.length,
    closed: report.closed.length,
    awaiting_human: report.awaiting_human.length,
    corrections: report.corrections,
    errors: report.errors.length,
  });
  return report;
}
