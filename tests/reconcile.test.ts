import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { CheckSummary } from "../src/cigate.js";
import { parseConfig, type Config } from "../src/config.js";
import type { PrRef, StalePr } from "../src/github.js";
import { roundTypeFor } from "../src/dispatch.js";
import { recheckPromptMarker } from "../src/types.js";
import {
  reconcileOnce,
  reconcileOrphanedRounds,
  type ReconcileAdapter,
  type ReconcileSearchItem,
} from "../src/reconcile.js";
import { applyEvent } from "../src/statemachine.js";
import { StateStore, type PrLifecycleState } from "../src/state.js";
import type { SessionHooks } from "../src/types.js";

const cfg: Config = parseConfig(
  readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8"),
);

function ref(number: number, over: Partial<PrRef> = {}): PrRef {
  return {
    number,
    title: `PR ${number}`,
    author: "alice",
    head_sha: `sha${number}`,
    base_ref: "master",
    updated_at: "2026-08-13T09:00:00Z",
    state: "open",
    draft: false,
    merged: false,
    labels: [],
    ...over,
  };
}

function item(number: number, login = "alice"): ReconcileSearchItem {
  return {
    number,
    title: `PR ${number}`,
    user: { login, type: login.endsWith("[bot]") ? "Bot" : "User" },
    updated_at: "2026-08-13T09:05:00Z",
    created_at: "2026-08-13T08:00:00Z",
  };
}

/** GitHub's truth, as a fake. Every method is deterministic. */
class FakeGitHub implements ReconcileAdapter {
  open: PrRef[] = [];
  labelTriggered: ReconcileSearchItem[] = [];
  teamTriggered: ReconcileSearchItem[] = [];
  awaiting: ReconcileSearchItem[] = [];
  stale: StalePr[] = [];
  botComments = new Map<number, number[]>();
  requested = new Map<number, { users: string[]; teams: string[] }>();
  closedPrs = new Map<number, PrRef>();
  calls: string[] = [];

  async searchLabelTriggered() {
    this.calls.push("searchLabelTriggered");
    return this.labelTriggered;
  }
  async searchTeamTriggered() {
    this.calls.push("searchTeamTriggered");
    return this.teamTriggered;
  }
  async listOpenPrs() {
    return this.open;
  }
  async getPr(n: number): Promise<PrRef> {
    const closed = this.closedPrs.get(n);
    if (closed) return closed;
    const found = this.open.find((p) => p.number === n);
    if (!found) throw new Error(`no such PR ${n}`);
    return found;
  }
  async stalenessScan() {
    return this.stale;
  }
  /** Checks per head sha; a head with no entry has no checks (`none`). */
  checksAt = new Map<string, CheckSummary[]>();

  async listChecks(ref: string) {
    this.calls.push(`listChecks:${ref}`);
    return this.checksAt.get(ref) ?? [];
  }
  async listBotReviewComments(n: number) {
    return this.botComments.get(n) ?? [];
  }
  async getRequestedReviewers(n: number) {
    return this.requested.get(n) ?? { users: [], teams: [] };
  }
}

function recordingHooks(): { hooks: SessionHooks; archived: number[] } {
  const archived: number[] = [];
  return {
    archived,
    hooks: {
      async dispatchRound() {},
      async inject() {},
      async injectOverseer() {},
      async archiveAndClose(pr) {
        archived.push(pr);
      },
    },
  };
}

let store: StateStore;
let gh: FakeGitHub;

beforeEach(() => {
  store = new StateStore(":memory:");
  gh = new FakeGitHub();
});

function seed(
  number: number,
  state: PrLifecycleState,
  over: Partial<{ head: string; stale: number; trigger: string | null }> = {},
): void {
  store.upsertPr({
    number,
    state,
    head_sha: over.head ?? `sha${number}`,
    title: `PR ${number}`,
    author: "alice",
    trigger_ts: over.trigger ?? null,
    stale_recheck: over.stale ?? 0,
    migration_gate: 0,
  });
}

const corrections = (s: StateStore) =>
  (
    s.db
      .prepare("SELECT pr, payload FROM events WHERE kind = 'reconcile_correction'")
      .all() as Array<{ pr: number; payload: string }>
  ).map((r) => ({ pr: r.pr, ...JSON.parse(r.payload) }));

describe("reconcileOnce", () => {
  it("adopts a hand-edited divergent pr_state from GitHub truth", async () => {
    // Local state says #1 is merely tracked and #2 is queued; GitHub says both
    // carry a live trigger, #3 has an outdated approval and #4 is closed.
    // The outdated approval is metadata only: commits never queue reviews.
    gh.open = [ref(1), ref(2), ref(3)];
    gh.labelTriggered = [item(1)];
    gh.teamTriggered = [item(2)];
    gh.stale = [
      { number: 3, head_sha: "sha3", approved_sha: "old3", approved_at: "2026-08-12T10:00:00Z" },
    ];
    gh.closedPrs.set(4, ref(4, { state: "closed", merged: true }));
    seed(1, "tracked");
    seed(2, "queued", { trigger: "2026-08-13T08:00:00Z" });
    seed(3, "tracked");
    seed(4, "awaiting_author");
    const { hooks, archived } = recordingHooks();

    const report = await reconcileOnce({ cfg, store, adapter: gh, hooks });

    expect(store.getPr(1)!.state).toBe("queued");
    expect(store.getPr(2)!.state).toBe("queued"); // already correct: no correction
    expect(store.getPr(3)!.state).toBe("tracked");
    expect(store.getPr(3)!.stale_recheck).toBe(0);
    expect(store.getPr(4)!.state).toBe("closed");
    expect(archived).toEqual([4]);
    expect(report.closed).toEqual([4]);

    const what = corrections(store).map((c) => `${c.pr}:${c.what}`);
    expect(what).toContain("1:triggered-not-queued");
    expect(what).not.toContain("3:stale-approval");
    expect(what).toContain("4:pr-closed");
    expect(what).not.toContain("2:triggered-not-queued");
    expect(report.corrections).toBe(2);
  });

  it("tracks a triggered PR the daemon has never seen (lost delivery)", async () => {
    gh.open = [ref(10)];
    gh.labelTriggered = [item(10)];
    const { hooks } = recordingHooks();
    await reconcileOnce({ cfg, store, adapter: gh, hooks });
    const row = store.getPr(10)!;
    expect(row.state).toBe("queued");
    expect(row.title).toBe("PR 10");
    expect(row.head_sha).toBe("sha10");
    expect(row.trigger_ts).toBe("2026-08-13T09:05:00Z");
  });

  it("retargets a terminal predecessor's stale successor to GitHub's authoritative head", async () => {
    const { hooks } = recordingHooks();
    seed(39, "queued", { head: "b8dd" });
    const predecessor = store.startRound(39, "re-review", ["pass-baseline"], 75);
    store.finishRound(predecessor, "REQUEST_CHANGES", 0);
    store.recordSuccessor({
      pr: 39,
      predecessor_round_id: predecessor,
      head_sha: "b8dd",
      provenance: "human",
      reason: "push+trigger",
    });
    const owedSince = store.successorFor(39)!.requested_at;
    gh.open = [ref(39, { head_sha: "e038" })];

    await reconcileOnce({ cfg, store, adapter: gh, hooks });

    expect(store.successorFor(39)).toMatchObject({
      predecessor_round_id: predecessor,
      head_sha: "e038",
      requested_at: owedSince,
      provenance: "human",
    });
    expect(store.getPr(39)).toMatchObject({
      state: "queued",
      head_sha: "e038",
      trigger_ts: owedSince,
      trigger_provenance: "human",
    });

    await reconcileOnce({ cfg, store, adapter: gh, hooks });
    expect(store.successorFor(39)?.head_sha).toBe("e038");
    expect(store.getPr(39)?.head_sha).toBe("e038");
  });

  it("retargets a stale successor even when the PR row was already corrected before this pass", async () => {
    const { hooks } = recordingHooks();
    seed(40, "tracked", { head: "github-head" });
    const predecessor = store.startRound(40, "re-review", ["pass-baseline"], 75);
    store.finishRound(predecessor, "REQUEST_CHANGES", 0);
    store.recordSuccessor({
      pr: 40,
      predecessor_round_id: predecessor,
      head_sha: "stale-successor",
      provenance: "system",
      reason: "push",
    });
    gh.open = [ref(40, { head_sha: "github-head" })];

    await reconcileOnce({ cfg, store, adapter: gh, hooks });

    expect(store.successorFor(40)?.head_sha).toBe("github-head");
    expect(store.getPr(40)?.head_sha).toBe("github-head");
  });

  it("does not turn standing trigger residue into a full round after a push recheck claimed the head", async () => {
    const { hooks } = recordingHooks();
    seed(37, "reviewing", { head: "approved-sha" });
    store.recordReviewedHead(37, { head_sha: "approved-sha", verdict: "APPROVE", round_no: 1 });
    gh.open = [ref(37, { head_sha: "approved-sha" })];
    gh.labelTriggered = [item(37)];

    // Establish that the label was already present while the prior review was
    // in flight. Its continued presence is a level, not a new human edge.
    await reconcileOnce({ cfg, store, adapter: gh, hooks });

    seed(37, "tracked", { head: "layout-sha" });
    store.claimRecheck(37, "push:layout-sha::", { head_sha: "layout-sha", trigger: "push" });
    gh.open = [ref(37, { head_sha: "layout-sha" })];
    await reconcileOnce({ cfg, store, adapter: gh, hooks });

    expect(store.getPr(37)!.state).toBe("tracked");
    expect(
      store.db
        .prepare(
          "SELECT COUNT(*) AS n FROM events WHERE pr = 37 AND kind = 'standing_trigger_suppressed'",
        )
        .get(),
    ).toEqual({ n: 1 });
  });

  it("suppresses standing trigger residue across the additive-table bootstrap", async () => {
    const { hooks } = recordingHooks();
    seed(39, "tracked", { head: "layout-sha" });
    store.recordReviewedHead(39, { head_sha: "approved-sha", verdict: "APPROVE", round_no: 1 });
    store.claimRecheck(39, "push:layout-sha::", { head_sha: "layout-sha", trigger: "push" });
    gh.open = [ref(39, { head_sha: "layout-sha" })];
    gh.labelTriggered = [item(39)];
    gh.teamTriggered = [item(39)];

    // No trigger-level rows exist: this is the first reconcile after a build
    // which added the table to an existing database. Unknown history is not a
    // fresh human edge and must not recreate #5372 during rollout.
    await reconcileOnce({ cfg, store, adapter: gh, hooks });

    expect(store.getPr(39)!.state).toBe("tracked");
    expect(
      store.db
        .prepare(
          "SELECT COUNT(*) AS n FROM events WHERE pr = 39 AND kind = 'standing_trigger_suppressed'",
        )
        .get(),
    ).toEqual({ n: 1 });
  });

  it("still treats a newly appearing trigger as a human full-review request", async () => {
    const { hooks } = recordingHooks();
    seed(38, "tracked", { head: "layout-sha" });
    store.recordReviewedHead(38, { head_sha: "approved-sha", verdict: "APPROVE", round_no: 1 });
    store.claimRecheck(38, "push:layout-sha::", { head_sha: "layout-sha", trigger: "push" });
    gh.open = [ref(38, { head_sha: "layout-sha" })];

    await reconcileOnce({ cfg, store, adapter: gh, hooks }); // observed absent
    gh.teamTriggered = [item(38)];
    await reconcileOnce({ cfg, store, adapter: gh, hooks });

    expect(store.getPr(38)!.state).toBe("queued");
    expect(store.getPr(38)!.trigger_provenance).toBe("human");
  });

  // push-trigger backstop (live gap 2026-08-19, #5307): with webhooks
  // dead, a post-review push was never rechecked and a withheld approval had
  // no path forward — reconcile must hand detected pushes to the same recheck
  // route the webhook's onSynchronize uses.
  it("invokes onHeadPush when a tracked PR's head moved, after updating the row", async () => {
    seed(30, "tracked", { head: "old-sha" });
    gh.open = [ref(30, { head_sha: "new-sha" })];
    const { hooks } = recordingHooks();
    const pushes: Array<{ pr: number; head: string; rowHeadAtCall: string }> = [];
    await reconcileOnce({
      cfg,
      store,
      adapter: gh,
      hooks,
      onHeadPush: async (pr, head_sha) => {
        pushes.push({ pr, head: head_sha, rowHeadAtCall: store.getPr(pr)!.head_sha });
      },
    });
    expect(pushes).toEqual([{ pr: 30, head: "new-sha", rowHeadAtCall: "new-sha" }]);
  });

  // Lost-recheck backstop (live gap 2026-08-19, #5290): a recheck that failed
  // to deliver never retried once the head was tracked — change-detection
  // fires exactly once. A standing APPROVE at a stale reviewed head with the
  // question unclaimed is re-asked; a claimed question dedupes.
  it("backstop: re-invokes onHeadPush for a standing APPROVE at a stale reviewed head, unless claimed", async () => {
    seed(35, "tracked", { head: "cur-sha" });
    store.recordReviewedHead(35, { head_sha: "approved-sha", verdict: "APPROVE", round_no: 1 });
    gh.open = [ref(35, { head_sha: "cur-sha" })]; // head unchanged — no push detection
    const { hooks } = recordingHooks();
    const pushes: number[] = [];
    await reconcileOnce({
      cfg,
      store,
      adapter: gh,
      hooks,
      onHeadPush: async (pr) => {
        pushes.push(pr);
      },
    });
    expect(pushes).toEqual([35]);

    // Claimed (a nudge or a terminal noop answered it) → silent.
    store.claimRecheck(35, "push:cur-sha::", { head_sha: "cur-sha", trigger: "push" });
    const again: number[] = [];
    await reconcileOnce({
      cfg,
      store,
      adapter: gh,
      hooks,
      onHeadPush: async (pr) => {
        again.push(pr);
      },
    });
    expect(again).toEqual([]);
  });

  it("backstop stays quiet for a non-APPROVE standing verdict", async () => {
    seed(36, "tracked", { head: "cur-sha" });
    store.recordReviewedHead(36, { head_sha: "rc-sha", verdict: "REQUEST_CHANGES", round_no: 1 });
    gh.open = [ref(36, { head_sha: "cur-sha" })];
    const { hooks } = recordingHooks();
    const pushes: number[] = [];
    await reconcileOnce({
      cfg,
      store,
      adapter: gh,
      hooks,
      onHeadPush: async (pr) => {
        pushes.push(pr);
      },
    });
    expect(pushes).toEqual([]);
  });

  it("does not invoke onHeadPush for an unchanged head or a title-only change", async () => {
    seed(31, "tracked");
    gh.open = [ref(31, { title: "renamed title" })];
    const { hooks } = recordingHooks();
    const pushes: number[] = [];
    await reconcileOnce({
      cfg,
      store,
      adapter: gh,
      hooks,
      onHeadPush: async (pr) => {
        pushes.push(pr);
      },
    });
    expect(pushes).toEqual([]);
  });

  it("contains an onHeadPush failure — the reconcile pass completes and reports the error", async () => {
    seed(32, "tracked", { head: "old-sha" });
    gh.open = [ref(32, { head_sha: "new-sha" })];
    const { hooks } = recordingHooks();
    const report = await reconcileOnce({
      cfg,
      store,
      adapter: gh,
      hooks,
      onHeadPush: async () => {
        throw new Error("recheck exploded");
      },
    });
    expect(report.errors.some((e) => e.includes("onHeadPush #32"))).toBe(true);
    expect(store.getPr(32)!.head_sha).toBe("new-sha"); // track still applied
  });

  it("never adopts a bot-authored PR", async () => {
    gh.open = [ref(11, { author: cfg.github.bot_login })];
    gh.labelTriggered = [item(11, cfg.github.bot_login)];
    const { hooks } = recordingHooks();
    await reconcileOnce({ cfg, store, adapter: gh, hooks });
    expect(store.getPr(11)).toBeUndefined();
  });

  it("does not disturb a round in flight", async () => {
    gh.open = [ref(12), ref(13)];
    gh.labelTriggered = [item(12)];
    gh.stale = [
      { number: 13, head_sha: "sha13", approved_sha: "old", approved_at: "2026-08-12T00:00:00Z" },
    ];
    seed(12, "reviewing");
    seed(13, "reviewing");
    const { hooks } = recordingHooks();
    const report = await reconcileOnce({ cfg, store, adapter: gh, hooks });
    expect(store.getPr(12)!.state).toBe("reviewing");
    expect(store.getPr(13)!.state).toBe("reviewing");
    expect(report.corrections).toBe(0);
  });

  it("backfills the bot-comment registry", async () => {
    gh.open = [ref(14)];
    seed(14, "awaiting_author");
    gh.botComments.set(14, [111, 222]);
    store.registerBotComment(111, 14);
    const { hooks } = recordingHooks();
    const report = await reconcileOnce({ cfg, store, adapter: gh, hooks });
    expect(report.backfilled_comments).toBe(1);
    expect(store.isBotComment(222)).toBe(true);
  });

  it("skips the registry backfill when disabled", async () => {
    gh.open = [ref(15)];
    seed(15, "tracked");
    gh.botComments.set(15, [333]);
    const { hooks } = recordingHooks();
    await reconcileOnce({ cfg, store, adapter: gh, hooks, backfillRegistry: false });
    expect(store.isBotComment(333)).toBe(false);
  });

  // A human reviewer requested on GitHub is somebody else's business: it must
  // not move our lifecycle state, and it can never produce a park — there is
  // no park (removed the state and the migration that used to
  // drain it, after a live check found no row left carrying one).
  it("never changes local state off a GitHub review request", async () => {
    gh.open = [ref(16), ref(17)];
    gh.requested.set(16, { users: ["mhale"], teams: [] });
    seed(16, "tracked");
    seed(17, "awaiting_author");
    const { hooks } = recordingHooks();
    const report = await reconcileOnce({ cfg, store, adapter: gh, hooks });
    expect(store.getPr(16)!.state).toBe("tracked");
    expect(store.getPr(17)!.state).toBe("awaiting_author");
    expect(report.triggered).not.toContain(16);
    expect(gh.calls).not.toContain("searchAwaitingEscalationReviewer");
  });

  it("does not close a PR GitHub still reports as open (listing lag)", async () => {
    gh.open = [];
    gh.closedPrs.set(18, ref(18, { state: "open" }));
    seed(18, "awaiting_author");
    const { hooks, archived } = recordingHooks();
    const report = await reconcileOnce({ cfg, store, adapter: gh, hooks });
    expect(store.getPr(18)!.state).toBe("awaiting_author");
    expect(archived).toEqual([]);
    expect(report.closed).toEqual([]);
  });

  it("reopens a locally-closed PR GitHub lists as open", async () => {
    gh.open = [ref(19)];
    seed(19, "closed");
    const { hooks } = recordingHooks();
    await reconcileOnce({ cfg, store, adapter: gh, hooks });
    expect(store.getPr(19)!.state).toBe("tracked");
    expect(corrections(store).map((c) => `${c.pr}:${c.what}`)).toContain("19:reopened");
  });

  it("survives a failing step and reports the error", async () => {
    gh.open = [ref(20)];
    seed(20, "tracked");
    gh.searchLabelTriggered = async () => {
      throw new Error("search 503");
    };
    gh.stale = [
      { number: 20, head_sha: "sha20", approved_sha: "old", approved_at: "2026-08-12T00:00:00Z" },
    ];
    const { hooks } = recordingHooks();
    const report = await reconcileOnce({ cfg, store, adapter: gh, hooks });
    expect(report.errors.join(" ")).toContain("search 503");
    expect(store.getPr(20)!.state).toBe("tracked"); // stale approval is not a fallback trigger
  });

  it("logs a reconcile_pass summary every time", async () => {
    const { hooks } = recordingHooks();
    await reconcileOnce({ cfg, store, adapter: gh, hooks });
    expect(
      store.db.prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'reconcile_pass'").get(),
    ).toMatchObject({ c: 1 });
  });
});

describe("withheld-approval backstop", () => {
  // The webhook `ci_completed` is the fast path; this is the reconcile sweep
  // cigate.ts promises for a lost delivery.
  const green: CheckSummary[] = [
    { name: "ci", source: "check_run", status: "completed", conclusion: "success" },
  ];
  const red: CheckSummary[] = [
    { name: "ci", source: "check_run", status: "completed", conclusion: "failure" },
  ];

  it("requeues a withheld PR when CI is green at the recorded head (webhook lost)", async () => {
    seed(70, "tracked");
    gh.open = [ref(70)];
    store.recordApprovalWithheld(70, { head_sha: "sha70", ci_state: "red", reason: "red-ci" });
    gh.checksAt.set("sha70", green);

    await reconcileOnce({ cfg, store, adapter: gh, hooks: recordingHooks().hooks });

    expect(store.getPr(70)?.state).toBe("queued");
    // The retry is retryWithheldApproval itself — its own event fires, plus the
    // reconcile correction that says the poll (not the webhook) caught it.
    expect(
      store.db
        .prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'approval_retry_queued'")
        .get(),
    ).toEqual({ c: 1 });
    expect(corrections(store).some((c) => c.what === "withheld-approval-requeued")).toBe(true);
  });

  it("does not requeue while CI is still red — the mark stands", async () => {
    seed(71, "tracked");
    gh.open = [ref(71)];
    store.recordApprovalWithheld(71, { head_sha: "sha71", ci_state: "red", reason: "red-ci" });
    gh.checksAt.set("sha71", red);

    await reconcileOnce({ cfg, store, adapter: gh, hooks: recordingHooks().hooks });

    expect(store.getPr(71)?.state).toBe("tracked");
    expect(store.approvalWithheld(71)).toBeDefined();
    expect(
      store.db
        .prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'approval_retry_queued'")
        .get(),
    ).toEqual({ c: 0 });
    expect(corrections(store).some((c) => c.what === "withheld-approval-requeued")).toBe(false);
  });

  it("reads CI only for PRs that actually hold a withheld mark", async () => {
    seed(72, "tracked");
    gh.open = [ref(72)];

    await reconcileOnce({ cfg, store, adapter: gh, hooks: recordingHooks().hooks });

    expect(gh.calls.filter((c) => c.startsWith("listChecks"))).toEqual([]);
  });

  it("skips the sweep entirely on an adapter without a checks read", async () => {
    seed(73, "tracked");
    gh.open = [ref(73)];
    store.recordApprovalWithheld(73, { head_sha: "sha73", ci_state: "red", reason: "red-ci" });
    const bare = Object.assign(Object.create(Object.getPrototypeOf(gh)), gh) as FakeGitHub & {
      listChecks?: unknown;
    };
    // Simulate a stub wiring with no listChecks at all.
    (bare as { listChecks?: unknown }).listChecks = undefined;

    const report = await reconcileOnce({
      cfg,
      store,
      adapter: bare,
      hooks: recordingHooks().hooks,
    });

    expect(report.errors).toEqual([]);
    expect(store.getPr(73)?.state).toBe("tracked");
  });
});

describe("dry-run re-trigger suppression", () => {
  let store: StateStore;
  let gh: FakeGitHub;

  beforeEach(() => {
    store = new StateStore(":memory:");
    gh = new FakeGitHub();
  });

  const hooks: SessionHooks = {
    dispatchRound: async () => {},
    inject: async () => {},
    injectOverseer: async () => {},
    archiveAndClose: async () => {},
  };

  it("suppresses re-queue when the last applied verdict matches the head (dry-run)", async () => {
    gh.open = [ref(9, { head_sha: "sha9" })];
    gh.labelTriggered = [item(9)];
    store.upsertPr({
      number: 9,
      state: "tracked",
      head_sha: "sha9",
      title: "PR 9",
      author: "alice",
      trigger_ts: null,
      stale_recheck: 0,
      migration_gate: 0,
    });
    store.logEvent("verdict_applied", 9, { head_sha: "sha9", verdict: "APPROVE" });

    await reconcileOnce({ cfg: { ...cfg, dry_run: true }, store, adapter: gh, hooks });
    expect(store.getPr(9)!.state).toBe("tracked"); // not re-queued

    // Head moved → re-queue is legitimate again.
    gh.open = [ref(9, { head_sha: "sha9-new" })];
    await reconcileOnce({ cfg: { ...cfg, dry_run: true }, store, adapter: gh, hooks });
    expect(store.getPr(9)!.state).toBe("queued");
  });

  it("does not suppress when dry_run is off", async () => {
    gh.open = [ref(9, { head_sha: "sha9" })];
    gh.labelTriggered = [item(9)];
    store.upsertPr({
      number: 9,
      state: "tracked",
      head_sha: "sha9",
      title: "PR 9",
      author: "alice",
      trigger_ts: null,
      stale_recheck: 0,
      migration_gate: 0,
    });
    store.logEvent("verdict_applied", 9, { head_sha: "sha9", verdict: "APPROVE" });

    await reconcileOnce({ cfg: { ...cfg, dry_run: false }, store, adapter: gh, hooks });
    expect(store.getPr(9)!.state).toBe("queued");
  });

  it.each([true, false])(
    "never queues an outdated approval merely because the head moved (dry_run=%s)",
    async (dryRun) => {
      gh.open = [ref(11, { head_sha: "sha11-new" })];
      gh.stale = [
        {
          number: 11,
          head_sha: "sha11-new",
          approved_sha: "old-sha",
          approved_at: "2026-08-10T00:00:00Z",
        },
      ];
      store.upsertPr({
        number: 11,
        state: "tracked",
        head_sha: "sha11",
        title: "PR 11",
        author: "alice",
        trigger_ts: null,
        stale_recheck: 0,
        migration_gate: 0,
      });

      await reconcileOnce({ cfg: { ...cfg, dry_run: dryRun }, store, adapter: gh, hooks });
      expect(store.getPr(11)).toMatchObject({
        state: "tracked",
        head_sha: "sha11-new",
        stale_recheck: 0,
      });
      expect(gh.calls).not.toContain("stalenessScan");
    },
  );

  it("paused PRs are never re-triggered or staleness-rechecked", async () => {
    gh.open = [ref(13, { head_sha: "sha13" })];
    gh.labelTriggered = [item(13)];
    gh.stale = [
      { number: 13, head_sha: "sha13", approved_sha: "old", approved_at: "2026-08-10T00:00:00Z" },
    ];
    store.upsertPr({
      number: 13,
      state: "tracked",
      head_sha: "sha13",
      title: "PR 13",
      author: "alice",
      trigger_ts: null,
      stale_recheck: 0,
      migration_gate: 0,
    });
    store.pausePr(13, { issuer: "operator", expires_at: null }, "test");

    await reconcileOnce({ cfg: { ...cfg, dry_run: false }, store, adapter: gh, hooks });
    const row = store.getPr(13)!;
    expect(row.state).toBe("tracked");
    expect(row.stale_recheck).toBe(0);

    store.resumePr(13, "operator");
    await reconcileOnce({ cfg: { ...cfg, dry_run: false }, store, adapter: gh, hooks });
    expect(store.getPr(13)!.state).toBe("queued");
  });
});

describe("reconcileOrphanedRounds", () => {
  const upsert = (store: StateStore, n: number, state: PrLifecycleState) =>
    store.upsertPr({
      number: n,
      state,
      head_sha: `sha${n}`,
      title: `PR ${n}`,
      author: "alice",
      trigger_ts: null,
      stale_recheck: 0,
      migration_gate: 0,
    });

  it("cancels rounds whose session is gone and requeues lost work", () => {
    const store = new StateStore(":memory:");
    upsert(store, 10, "reviewing"); // session survived
    upsert(store, 11, "reviewing"); // session lost — latest round → requeue
    upsert(store, 12, "tracked"); // phantom round, PR already moved on
    store.startRound(10, "first", ["pass-baseline"], 75);
    const lostId = store.startRound(11, "first", ["pass-baseline"], 75);
    const phantomId = store.startRound(12, "first", ["pass-baseline"], 75);

    const res = reconcileOrphanedRounds(store, [10], { botLogin: cfg.github.bot_login });

    expect(res.cancelled.sort()).toEqual([11, 12]);
    expect(res.requeued).toEqual([11]);
    expect(store.runningRounds().map((r) => r.pr)).toEqual([10]); // capacity restored
    expect(
      (store.db.prepare("SELECT status FROM rounds WHERE id = ?").get(lostId) as any).status,
    ).toBe("cancelled");
    expect(
      (store.db.prepare("SELECT status FROM rounds WHERE id = ?").get(phantomId) as any).status,
    ).toBe("cancelled");
    expect(store.getPr(11)!.state).toBe("queued");
    expect(store.getPr(12)!.state).toBe("tracked"); // never disturbed
    store.close();
  });

  it("promotes a durable fresh-head successor when the predecessor session is lost", () => {
    const store = new StateStore(":memory:");
    upsert(store, 13, "reviewing");
    const oldId = store.startRound(13, "first", ["pass-baseline"], 75);
    store.recordSuccessor({
      pr: 13,
      predecessor_round_id: oldId,
      head_sha: "fresh13",
      provenance: "human",
      reason: "push+trigger",
    });

    const res = reconcileOrphanedRounds(store, [], { botLogin: cfg.github.bot_login });

    expect(res.requeued).toEqual([13]);
    expect(store.getPr(13)).toMatchObject({
      state: "queued",
      head_sha: "fresh13",
      trigger_provenance: "human",
    });
    expect(store.successorFor(13)?.head_sha).toBe("fresh13");
    store.close();
  });

  it("does not requeue a PR whose newer round already completed", () => {
    const store = new StateStore(":memory:");
    upsert(store, 20, "reviewing");
    const oldId = store.startRound(20, "first", ["pass-baseline"], 75);
    const newId = store.startRound(20, "re-review", ["pass-baseline"], 75);
    store.finishRound(newId, "REQUEST_CHANGES", 1.25);

    const res = reconcileOrphanedRounds(store, [], { botLogin: cfg.github.bot_login });
    expect(res.cancelled).toEqual([20]);
    expect(res.requeued).toEqual([]); // the phantom was superseded — no new round
    expect(
      (store.db.prepare("SELECT status FROM rounds WHERE id = ?").get(oldId) as any).status,
    ).toBe("cancelled");
    store.close();
  });
});

// ----: stale-trigger residue ----------------------------------------

describe("stale-trigger residue sweep", () => {
  it("clears stale_recheck + trigger_ts on a settled PR with no round running, and logs it", async () => {
    // #5180's live shape: tracked, stale_recheck=1, a days-old trigger_ts,
    // zero rounds running, and GitHub no longer lists it as triggered.
    gh.open = [ref(5180)];
    seed(5180, "tracked", { stale: 1, trigger: "2026-08-14T14:01:56.715Z" });
    const { hooks } = recordingHooks();

    await reconcileOnce({ cfg, store, adapter: gh, hooks });

    const row = store.getPr(5180)!;
    expect(row.state).toBe("tracked");
    expect(row.stale_recheck).toBe(0);
    expect(row.trigger_ts).toBeNull();
    const what = corrections(store).filter((c) => c.what === "stale-trigger-residue-cleared");
    expect(what).toHaveLength(1);
    expect(what[0]).toMatchObject({
      pr: 5180,
      stale_recheck: 1,
      trigger_ts: "2026-08-14T14:01:56.715Z",
    });
  });

  it("a subsequent explicit re-review is NOT classified as a staleness round", async () => {
    gh.open = [ref(5180)];
    seed(5180, "tracked", { stale: 1, trigger: "2026-08-14T14:01:56.715Z" });
    const { hooks } = recordingHooks();
    await reconcileOnce({ cfg, store, adapter: gh, hooks });

    // The owner re-labels the PR: an explicit human trigger, days later.
    applyEvent(
      store,
      5180,
      { type: "trigger", source: "label" },
      { author: "alice" },
      { now: () => new Date("2026-08-20T09:00:00Z") },
    );
    const row = store.getPr(5180)!;
    expect(row.state).toBe("queued");
    expect(row.stale_recheck).toBe(0);
    expect(row.trigger_ts).toBe("2026-08-20T09:00:00.000Z"); // fresh FIFO position, not the residue
    expect(roundTypeFor(row, 3)).toBe("re-review"); // never "staleness"
  });

  it("never touches a queued PR, a reviewing PR, or one with a round running", async () => {
    gh.open = [ref(21), ref(22), ref(23)];
    gh.labelTriggered = [item(21)];
    seed(21, "queued", { stale: 1, trigger: "2026-08-14T10:00:00Z" });
    seed(22, "reviewing", { stale: 1 });
    seed(23, "awaiting_author", { stale: 1 });
    store.startRound(23, "re-review", ["pass-baseline"], 75); // round in flight
    const { hooks } = recordingHooks();

    await reconcileOnce({ cfg, store, adapter: gh, hooks });

    expect(store.getPr(21)!.stale_recheck).toBe(1); // queued: the trigger is live
    expect(store.getPr(22)!.stale_recheck).toBe(1); // reviewing: dispatch clears it
    expect(store.getPr(23)!.stale_recheck).toBe(1); // running round owns the state
    expect(
      corrections(store).filter((c) => c.what === "stale-trigger-residue-cleared"),
    ).toHaveLength(0);
  });

  it("runs after the triggered-set step: a still-triggered PR re-queues instead of being wiped", async () => {
    gh.open = [ref(31)];
    gh.labelTriggered = [item(31)];
    seed(31, "tracked", { stale: 0, trigger: "2026-08-14T10:00:00Z" });
    const { hooks } = recordingHooks();

    await reconcileOnce({ cfg, store, adapter: gh, hooks });

    const row = store.getPr(31)!;
    expect(row.state).toBe("queued"); // the trigger was real — honored, not swept
    expect(row.trigger_ts).toBe("2026-08-14T10:00:00Z");
    expect(
      corrections(store).filter((c) => c.what === "stale-trigger-residue-cleared"),
    ).toHaveLength(0);
  });
});

describe("undelivered recheck-claim sweep (#5362 W2)", () => {
  // The worst of the wedge family, because nothing bounded it. `claimRecheck`
  // is written BEFORE the nudge goes out and released only on a synchronous
  // throw — which a bridge-level drop is not — and `rechecks` has no deadline,
  // no sweep and no expiry. A dropped nudge therefore left a claim that
  // suppressed the push-backstop FOREVER: a delta on an APPROVED PR silently
  // never audited, and the approval standing over code nobody read.
  const fp = "fp-push-deadbeef";

  function hooksWithReceipt(landed: boolean | null): SessionHooks & { asked: string[] } {
    const asked: string[] = [];
    const h = recordingHooks().hooks as SessionHooks & { asked: string[] };
    h.asked = asked;
    h.wakeReceiptPresent = async (pr, marker) => {
      asked.push(`${pr}:${marker}`);
      return landed;
    };
    h.injectPending = async () => false;
    return h;
  }

  /** A claim older than the grace window, as a dropped nudge leaves one. */
  function staleClaim(pr: number): void {
    store.claimRecheck(pr, fp, { head_sha: "head1", trigger: "push", reason: "delta" });
    store.db
      .prepare("UPDATE rechecks SET created_at = ? WHERE pr = ? AND fingerprint = ?")
      .run("2026-08-14T09:00:00.000Z", pr, fp);
  }

  it("releases a claim whose nudge provably never reached the session", async () => {
    gh.open = [ref(600)];
    seed(600, "tracked");
    staleClaim(600);
    const hooks = hooksWithReceipt(false);

    await reconcileOnce({
      cfg,
      store,
      adapter: gh,
      hooks,
      now: () => new Date("2026-08-14T12:00:00Z"),
    });

    expect(hooks.asked).toEqual([`600:${recheckPromptMarker(600, fp)}`]);
    // Released, so the reconcile push-backstop can ask the question again.
    expect(store.hasRecheck(600, fp)).toBe(false);
    expect(
      corrections(store).filter((c) => c.what === "recheck-claim-released-undelivered"),
    ).toHaveLength(1);
  });

  it("keeps a claim whose nudge DID land, and one with no evidence either way", async () => {
    gh.open = [ref(601), ref(602)];
    seed(601, "tracked");
    seed(602, "tracked");
    staleClaim(601);
    staleClaim(602);

    await reconcileOnce({
      cfg,
      store,
      adapter: gh,
      hooks: hooksWithReceipt(true),
      now: () => new Date("2026-08-14T12:00:00Z"),
    });
    expect(store.hasRecheck(601, fp)).toBe(true);

    await reconcileOnce({
      cfg,
      store,
      adapter: gh,
      hooks: hooksWithReceipt(null),
      now: () => new Date("2026-08-14T12:00:00Z"),
    });
    expect(store.hasRecheck(602, fp)).toBe(true);
    expect(
      corrections(store).filter((c) => c.what === "recheck-claim-released-undelivered"),
    ).toHaveLength(0);
  });

  it("never releases a claim that is merely HELD — a round in flight, or a wake still queued", async () => {
    // wakeOrHold holds a mid-round nudge in `pending_wakes` by design (S4).
    // It has not been delivered and has no receipt, but it is not lost either.
    gh.open = [ref(603), ref(604)];
    seed(603, "reviewing");
    seed(604, "tracked");
    staleClaim(603);
    staleClaim(604);
    store.startRound(603, "re-review", ["pass-baseline"], 75);
    store.holdWake(604, "the nudge", "recheck:push");

    await reconcileOnce({
      cfg,
      store,
      adapter: gh,
      hooks: hooksWithReceipt(false),
      now: () => new Date("2026-08-14T12:00:00Z"),
    });

    expect(store.hasRecheck(603, fp)).toBe(true);
    expect(store.hasRecheck(604, fp)).toBe(true);
  });

  it("waits out the grace window, and does nothing at all without the receipt hook", async () => {
    gh.open = [ref(605)];
    seed(605, "tracked");
    store.claimRecheck(605, fp, { head_sha: "head1", trigger: "push", reason: "delta" });

    // Fresh claim: inside the grace window.
    await reconcileOnce({ cfg, store, adapter: gh, hooks: hooksWithReceipt(false) });
    expect(store.hasRecheck(605, fp)).toBe(true);

    // Stale claim, but a stub with no receipt hook — no sweep, exactly as before.
    staleClaim(605);
    await reconcileOnce({
      cfg,
      store,
      adapter: gh,
      hooks: recordingHooks().hooks,
      now: () => new Date("2026-08-14T12:00:00Z"),
    });
    expect(store.hasRecheck(605, fp)).toBe(true);
  });
});
