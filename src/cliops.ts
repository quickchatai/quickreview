// qcr checklist / qcr compare — production wiring of the cutover harnesses. Local
// runs exercise the offline halves; the live halves (tunnel, real searches,
// live rounds) light up on the VM where the daemon and pi are running.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runChecklist, type ChecklistDeps } from "./checklist.js";
import { loadConfig, sandboxRoot, type Config } from "./config.js";
import { dispatchOnce } from "./dispatch.js";
import { zoneDateString } from "./eod.js";
import type { GateResult } from "./gate.js";
import type { GitHubAdapter, PrRef } from "./github.js";
import { readDryrunDir, runCompare, type CompareDeps, type ReviewSnapshot } from "./compare.js";
import { reconcileOnce } from "./reconcile.js";
import { StateStore } from "./state.js";
import { stubSessionHooks } from "./stubs.js";
import type { RoundOrder } from "./types.js";
import { applyInterpretation, interpretEvent } from "./webhook.js";
import { buildParts, type ProductionParts } from "./wire.js";

function dryGateResult(): GateResult {
  return { executed: false };
}

/** Offline push-with-old-approval simulation: the real reconcile and dispatch
 * paths run against a moved head and must stay quiet without an explicit
 * label/team review re-request. The fixture is a TRACKED PR whose approved
 * head is the old sha — an untracked PR is skipped by reconcile outright, and
 * a probe over one would pass without exercising anything. */
export function stalenessSimulation(
  cfg: Config,
  hooksRoot: string = join(sandboxRoot(), "state", "checklist-sim"),
) {
  const store = new StateStore(":memory:");
  const issued: RoundOrder[] = [];
  const fixture = {
    number: 999901,
    head_sha: "fixture-head-sha",
    approved_sha: "fixture-approved-sha",
  };
  const prRef: PrRef = {
    number: fixture.number,
    title: "pushed approved PR fixture",
    author: "someone",
    head_sha: fixture.head_sha,
    base_ref: cfg.github.base_branch,
    updated_at: new Date().toISOString(),
    state: "open",
    draft: false,
    merged: false,
    labels: [],
  };
  const adapter = {
    searchLabelTriggered: async () => [],
    searchTeamTriggered: async () => [],
    listOpenPrs: async () => [prRef],
    getPr: async () => prRef,
    stalenessScan: async () => [
      {
        number: fixture.number,
        head_sha: fixture.head_sha,
        approved_sha: fixture.approved_sha,
        approved_at: "",
      },
    ],
    listBotReviewComments: async () => [],
    listPrFiles: async () => [
      { filename: "src/x.ts", additions: 1, deletions: 0, status: "modified" },
    ],
    addLabel: async () => dryGateResult(),
    removeLabel: async () => dryGateResult(),
    deleteTeamReviewRequest: async () => dryGateResult(),
    createReview: async () => dryGateResult(),
  };
  const hooks = {
    ...stubSessionHooks(hooksRoot),
    async dispatchRound(order: RoundOrder) {
      issued.push(order);
    },
  };
  return {
    fixture,
    store,
    injectStalePr: (f: typeof fixture) => {
      // Reviewed and approved at the old head, one finished round behind it.
      store.upsertPr({
        number: f.number,
        state: "tracked",
        head_sha: f.approved_sha,
        title: prRef.title,
        author: prRef.author,
        trigger_ts: null,
        stale_recheck: 0,
        migration_gate: 0,
      });
      const round = store.startRound(f.number, "first", [], 60);
      store.finishRound(round, "APPROVE", null);
      store.recordReviewedHead(f.number, {
        head_sha: f.approved_sha,
        verdict: "APPROVE",
        posted_event: "APPROVE",
        round_no: 1,
      });
    },
    runStalenessReconcile: async () => {
      await reconcileOnce({ cfg, store, adapter, hooks, log: () => {} });
      await dispatchOnce({ cfg, store, adapter, hooks, log: () => {} });
    },
    issuedOrders: () => issued.map((o) => ({ pr: o.pr, round_type: o.round_type })),
  };
}

/** Offline ping-pong plumbing probe: the real interpreter + apply path with an
 * isolated registry; the inject write lands in the real inject/ dir. The live
 * end-to-end (real author reply through the tunnel) is a VM item. */
function pingPongSimulation(cfg: Config, root: string) {
  const store = new StateStore(":memory:");
  const botCommentId = 424242;
  const pr = 999902;
  store.registerBotComment(botCommentId, pr);
  const event = {
    comment: {
      id: 555,
      in_reply_to_id: botCommentId,
      body: "author reply fixture",
      user: { login: "someone", type: "User" },
      path: "src/x.ts",
    },
    pull_request: {
      number: pr,
      title: "pingpong fixture",
      user: { login: "someone" },
      head: { sha: "abc" },
    },
    sender: { login: "someone", type: "User" },
  };
  return {
    injectDir: join(root, "inject"),
    event,
    pr,
    interpret: async (payload: unknown) => {
      const i = interpretEvent("pull_request_review_comment", "created", payload, {
        botLogin: cfg.github.bot_login,
        triggerLabel: cfg.github.trigger_label,
        reviewTeam: cfg.github.review_team,
        botCommentPr: (id) => store.botCommentPr(id),
      });
      await applyInterpretation(
        {
          cfg,
          store,
          onAuthorReply: async (reply) => {
            const dir = join(root, "inject", `pr-${reply.pr}`);
            mkdirSync(dir, { recursive: true });
            const { writeFileSync } = await import("node:fs");
            writeFileSync(join(dir, `${Date.now()}-pingpong-probe.md`), reply.body);
          },
        },
        i,
      );
    },
  };
}

/** ② The daemon's side of the queue comparison: the PRs still OWED a trigger
 * consumption. Live, dispatch consumes the label and team request as the round
 * starts, so a `reviewing` row no longer shows in the manual searches; in
 * dry-run nothing is consumed, so it still does. */
export function derivedQueueOf(
  rows: ReadonlyArray<{ number: number; state: string }>,
  dryRun: boolean,
): number[] {
  return rows
    .filter((r) => r.state === "queued" || (dryRun && r.state === "reviewing"))
    .map((r) => r.number);
}

export async function cmdChecklist(parts?: ProductionParts): Promise<number> {
  const root = sandboxRoot();
  const cfg = loadConfig();
  const p = parts ?? buildParts(root, cfg);
  const store = new StateStore(join(root, "state", "state.db"));
  let secret = "";
  try {
    secret = readFileSync(join(cfg.github.secrets_dir, "webhook_secret"), "utf8").trim();
  } catch {
    // No secrets on this machine — the tunnel probe will fail with detail.
  }
  const deps: ChecklistDeps = {
    tunnel: {
      url: `http://127.0.0.1:${cfg.server.port}/webhook`,
      webhookSecret: secret,
      hostname: cfg.server.hostname,
      post: async (url, headers, body) => {
        const res = await fetch(url, { method: "POST", headers, body });
        return { status: res.status, text: await res.text() };
      },
    },
    queue: {
      labelTriggered: async () => (await p.adapter.searchLabelTriggered()).map((i) => i.number),
      teamTriggered: async () => (await p.adapter.searchTeamTriggered()).map((i) => i.number),
      derivedQueue: () => derivedQueueOf(store.allPrs(), cfg.dry_run),
    },
    staleness: stalenessSimulation(cfg),
    pingPong: pingPongSimulation(cfg, root),
    digest: {
      digestDir: join(root, "digest"),
      statusPath: join(root, "state", "status.json"),
      today: zoneDateString(new Date(), cfg.eod.timezone),
    },
    tmux: {
      listSessions: () => p.sessions.tmux.listSessions(),
      requireOverseer: true,
    },
    restart: {
      statusPath: join(root, "state", "status.json"),
      adoptExistingSessions: async () => (await p.sessions.adopt()).adopted,
    },
    bot_login: cfg.github.bot_login,
  };
  try {
    const run = await runChecklist(deps);
    return run.exitCode;
  } finally {
    store.close();
  }
}

function oldReviewFetcher(adapter: GitHubAdapter, botLogin: string) {
  return async (pr: number): Promise<ReviewSnapshot | null> => {
    const reviews = (await adapter.listReviewsFull(pr)).filter(
      (r) =>
        r.user === botLogin && ["APPROVED", "CHANGES_REQUESTED", "COMMENTED"].includes(r.state),
    );
    const latest = reviews[reviews.length - 1];
    if (!latest) return null;
    const comments = (await adapter.listReviewCommentsFull(pr)).filter(
      (c) => c.pull_request_review_id === latest.id,
    );
    return {
      source: "old-flow",
      state: latest.state,
      body: latest.body,
      comments: comments.map((c) => ({ path: c.path, line: c.line ?? 0, body: c.body })),
      commit_id: latest.commit_id,
      ...(latest.submitted_at ? { submitted_at: latest.submitted_at } : {}),
    };
  };
}

export async function cmdCompare(prs: number[], parts?: ProductionParts): Promise<number> {
  const root = sandboxRoot();
  const cfg = loadConfig();
  const p = parts ?? buildParts(root, cfg);
  const dryrunDir = join(root, "state", "dryrun");
  const deps: CompareDeps = {
    // Locally the pi session can't execute a round; the harness collects
    // whatever dry-run records prior rounds produced. On the VM, trigger the
    // rounds via the daemon (label the PRs) before running compare.
    dispatchDryRun: async (pr) => {
      console.log(
        `compare: not dispatching #${pr} — collect-only (trigger rounds via the daemon on the VM first)`,
      );
    },
    readRecords: (pr) => readDryrunDir(dryrunDir).filter((r) => r.pr === pr),
    fetchOldReview: oldReviewFetcher(p.adapter, cfg.github.bot_login),
    fetchPatches: async (pr) =>
      (await p.adapter.listPrFiles(pr))
        .filter((f) => typeof f.patch === "string")
        .map((f) => ({ path: f.filename, patch: f.patch! })),
    readLedger: (pr) => {
      for (const candidate of [
        join(root, "archive", `pr-${pr}`, "ledger.md"),
        join(root, "state", "ledgers", `pr-${pr}.md`),
      ]) {
        if (existsSync(candidate)) return readFileSync(candidate, "utf8");
      }
      return "";
    },
    // Deliberately NOT set. `qcr compare` is collect-only: the records on disk
    // were produced by some earlier daemon round through a gate this process
    // never held, so there is nothing here to observe. Reporting this process's
    // own gate would be a fabricated attestation about someone else's run.
    // The reports say the dry-run claim is UNVERIFIED, which is the truth.
    // observeDryRun: …
    outDir: join(root, "reports"),
  };
  const run = await runCompare(prs, deps);
  return run.exitCode;
}
