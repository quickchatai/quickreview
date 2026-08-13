import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parseConfig, type Config } from "../src/config.js";
import type { PrRef, StalePr } from "../src/github.js";
import { reconcileOnce, type ReconcileAdapter, type ReconcileSearchItem } from "../src/reconcile.js";
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
  async searchAwaitingEscalationReviewer() {
    this.calls.push("searchAwaitingEscalationReviewer");
    return this.awaiting;
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
    escalation_worthy: 0,
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
    // carry a live trigger, #3 has a stale approval and #4 is closed.
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
    expect(store.getPr(3)!.state).toBe("queued");
    expect(store.getPr(3)!.stale_recheck).toBe(1);
    expect(store.getPr(4)!.state).toBe("closed");
    expect(archived).toEqual([4]);
    expect(report.closed).toEqual([4]);

    const what = corrections(store).map((c) => `${c.pr}:${c.what}`);
    expect(what).toContain("1:triggered-not-queued");
    expect(what).toContain("3:stale-approval");
    expect(what).toContain("4:pr-closed");
    expect(what).not.toContain("2:triggered-not-queued");
    expect(report.corrections).toBe(3);
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

  it("parks a PR on awaiting_human when the escalation reviewer is requested", async () => {
    gh.open = [ref(16), ref(17)];
    gh.awaiting = [item(16), item(17)];
    gh.requested.set(16, { users: [cfg.github.escalation_reviewer], teams: [] });
    gh.requested.set(17, { users: ["someone-else"], teams: [] });
    seed(16, "tracked");
    seed(17, "tracked");
    const { hooks } = recordingHooks();
    const report = await reconcileOnce({ cfg, store, adapter: gh, hooks });
    expect(store.getPr(16)!.state).toBe("awaiting_human");
    expect(store.getPr(17)!.state).toBe("tracked");
    expect(report.awaiting_human).toEqual([16]);
    expect(corrections(store).map((c) => `${c.pr}:${c.what}`)).toContain("16:awaiting-human");
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
    expect(store.getPr(20)!.state).toBe("queued"); // later steps still ran
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
    store.upsertPr({ number: 9, state: "tracked", head_sha: "sha9", title: "PR 9", author: "alice", trigger_ts: null, stale_recheck: 0, escalation_worthy: 0, migration_gate: 0 });
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
    store.upsertPr({ number: 9, state: "tracked", head_sha: "sha9", title: "PR 9", author: "alice", trigger_ts: null, stale_recheck: 0, escalation_worthy: 0, migration_gate: 0 });
    store.logEvent("verdict_applied", 9, { head_sha: "sha9", verdict: "APPROVE" });

    await reconcileOnce({ cfg: { ...cfg, dry_run: false }, store, adapter: gh, hooks });
    expect(store.getPr(9)!.state).toBe("queued");
  });
});
