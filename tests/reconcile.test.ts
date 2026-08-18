import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parseConfig, type Config } from "../src/config.js";
import type { PrRef, StalePr } from "../src/github.js";
import { reconcileOnce, reconcileOrphanedRounds, type ReconcileAdapter, type ReconcileSearchItem } from "../src/reconcile.js";
import { StateStore, type PrLifecycleState } from "../src/state.js";
import type { SessionHooks } from "../src/types.js";

const cfg: Config = parseConfig(readFileSync(resolve(process.cwd(), "config.toml"), "utf8"));

function ref(number: number, over: Partial<PrRef> = {}): PrRef {
  return {
    number,
    title: `PR ${number}`,
    author: "alice",
    head_sha: `sha${number}`,
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

function seed(number: number, state: PrLifecycleState, over: Partial<{ head: string; stale: number; trigger: string | null }> = {}): void {
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
  (s.db.prepare("SELECT pr, payload FROM events WHERE kind = 'reconcile_correction'").all() as Array<{ pr: number; payload: string }>).map(
    (r) => ({ pr: r.pr, ...JSON.parse(r.payload) }),
  );

describe("reconcileOnce", () => {
  it("adopts a hand-edited divergent pr_state from GitHub truth", async () => {
    // Local state says #1 is merely tracked and #2 is queued; GitHub says both
    // carry a live trigger, #3 has an outdated approval and #4 is closed.
    // The outdated approval is metadata only: commits never queue reviews.
    gh.open = [ref(1), ref(2), ref(3)];
    gh.labelTriggered = [item(1)];
    gh.teamTriggered = [item(2)];
    gh.stale = [{ number: 3, head_sha: "sha3", approved_sha: "old3", approved_at: "2026-08-12T10:00:00Z" }];
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
    gh.stale = [{ number: 13, head_sha: "sha13", approved_sha: "old", approved_at: "2026-08-12T00:00:00Z" }];
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

  // Since the escalation scrap (2026-08-18), awaiting_human is a purely LOCAL
  // state: a requested reviewer on GitHub is somebody else's business and must
  // no longer park a PR here. The reconcile pass only counts what is parked.
  it("reports locally parked PRs and never parks one off a GitHub review request", async () => {
    gh.open = [ref(16), ref(17)];
    gh.requested.set(16, { users: ["mhale"], teams: [] });
    seed(16, "tracked");
    seed(17, "awaiting_human");
    const { hooks } = recordingHooks();
    const report = await reconcileOnce({ cfg, store, adapter: gh, hooks });
    expect(store.getPr(16)!.state).toBe("tracked"); // a human reviewer ≠ our park
    expect(report.awaiting_human).toEqual([17]);
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
    gh.stale = [{ number: 20, head_sha: "sha20", approved_sha: "old", approved_at: "2026-08-12T00:00:00Z" }];
    const { hooks } = recordingHooks();
    const report = await reconcileOnce({ cfg, store, adapter: gh, hooks });
    expect(report.errors.join(" ")).toContain("search 503");
    expect(store.getPr(20)!.state).toBe("tracked"); // stale approval is not a fallback trigger
  });

  it("logs a reconcile_pass summary every time", async () => {
    const { hooks } = recordingHooks();
    await reconcileOnce({ cfg, store, adapter: gh, hooks });
    expect(store.db.prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'reconcile_pass'").get()).toMatchObject({ c: 1 });
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
    store.upsertPr({ number: 9, state: "tracked", head_sha: "sha9", title: "PR 9", author: "alice", trigger_ts: null, stale_recheck: 0, migration_gate: 0 });
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
    store.upsertPr({ number: 9, state: "tracked", head_sha: "sha9", title: "PR 9", author: "alice", trigger_ts: null, stale_recheck: 0, migration_gate: 0 });
    store.logEvent("verdict_applied", 9, { head_sha: "sha9", verdict: "APPROVE" });

    await reconcileOnce({ cfg: { ...cfg, dry_run: false }, store, adapter: gh, hooks });
    expect(store.getPr(9)!.state).toBe("queued");
  });

  it.each([true, false])("never queues an outdated approval merely because the head moved (dry_run=%s)", async (dryRun) => {
    gh.open = [ref(11, { head_sha: "sha11-new" })];
    gh.stale = [{ number: 11, head_sha: "sha11-new", approved_sha: "old-sha", approved_at: "2026-08-10T00:00:00Z" }];
    store.upsertPr({ number: 11, state: "tracked", head_sha: "sha11", title: "PR 11", author: "alice", trigger_ts: null, stale_recheck: 0, migration_gate: 0 });

    await reconcileOnce({ cfg: { ...cfg, dry_run: dryRun }, store, adapter: gh, hooks });
    expect(store.getPr(11)).toMatchObject({ state: "tracked", head_sha: "sha11-new", stale_recheck: 0 });
    expect(gh.calls).not.toContain("stalenessScan");
  });

  it("paused PRs are never re-triggered or staleness-rechecked", async () => {
    gh.open = [ref(13, { head_sha: "sha13" })];
    gh.labelTriggered = [item(13)];
    gh.stale = [{ number: 13, head_sha: "sha13", approved_sha: "old", approved_at: "2026-08-10T00:00:00Z" }];
    store.upsertPr({ number: 13, state: "tracked", head_sha: "sha13", title: "PR 13", author: "alice", trigger_ts: null, stale_recheck: 0, migration_gate: 0 });
    store.setPaused(13, true);

    await reconcileOnce({ cfg: { ...cfg, dry_run: false }, store, adapter: gh, hooks });
    const row = store.getPr(13)!;
    expect(row.state).toBe("tracked");
    expect(row.stale_recheck).toBe(0);

    store.setPaused(13, false);
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
    expect((store.db.prepare("SELECT status FROM rounds WHERE id = ?").get(lostId) as any).status).toBe("cancelled");
    expect((store.db.prepare("SELECT status FROM rounds WHERE id = ?").get(phantomId) as any).status).toBe("cancelled");
    expect(store.getPr(11)!.state).toBe("queued");
    expect(store.getPr(12)!.state).toBe("tracked"); // never disturbed
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
    expect((store.db.prepare("SELECT status FROM rounds WHERE id = ?").get(oldId) as any).status).toBe("cancelled");
    store.close();
  });
});
