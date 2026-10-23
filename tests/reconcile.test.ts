import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

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
  it(
    "adopts a hand-edited divergent pr_state from GitHub truth",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
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
    },
  );

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
    // fresh human edge and must not re-trigger an already-reviewed PR.
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

  it("rolls back a human edge when its level checkpoint fails", () => {
    seed(45, "tracked");
    store.observeTriggerLevel(45, "label", false);
    store.db.exec(
      "CREATE TRIGGER fail_trigger_level BEFORE UPDATE ON trigger_levels BEGIN SELECT RAISE(ABORT, 'level unavailable'); END",
    );
    expect(() => store.observeTriggerLevel(45, "label", true)).toThrow("level unavailable");
    expect(store.triggerLevel(45, "label")).toBe(false);
    expect(store.triggerEdgePending(45, "label")).toBe(false);
    store.db.exec("DROP TRIGGER fail_trigger_level");
    store.observeTriggerLevel(45, "label", true);
    expect(store.triggerEdgePending(45, "label")).toBe(true);
  });

  it("retains a fresh human trigger after queue publication fails", async () => {
    const { hooks } = recordingHooks();
    seed(38, "tracked", { head: "layout-sha" });
    store.recordReviewedHead(38, { head_sha: "approved-sha", verdict: "APPROVE", round_no: 1 });
    store.claimRecheck(38, "push:layout-sha::", { head_sha: "layout-sha", trigger: "push" });
    gh.open = [ref(38, { head_sha: "layout-sha" })];
    await reconcileOnce({ cfg, store, adapter: gh, hooks });
    gh.teamTriggered = [item(38)];
    const write = store.upsertPr.bind(store);
    const checkpoint = vi.spyOn(store, "upsertPr").mockImplementation((row) => {
      if (row.state === "queued") throw new Error("queue checkpoint unavailable");
      write(row);
    });
    await reconcileOnce({ cfg, store, adapter: gh, hooks });
    checkpoint.mockRestore();
    expect(store.getPr(38)?.state).toBe("tracked");
    await reconcileOnce({ cfg, store, adapter: gh, hooks });
    expect(store.getPr(38)).toMatchObject({ state: "queued", trigger_provenance: "human" });
  });

  it("rolls back a push fact when authoritative head publication fails", async () => {
    const { hooks } = recordingHooks();
    seed(44, "tracked", { head: "old" });
    gh.open = [ref(44, { head_sha: "new" })];
    const checkpoint = vi.spyOn(store, "upsertPr").mockImplementationOnce(() => {
      throw new Error("head publication failed");
    });
    await reconcileOnce({ cfg, store, adapter: gh, hooks });
    checkpoint.mockRestore();
    expect(store.getPr(44)?.head_sha).toBe("old");
    expect(
      store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE pr=44 AND kind='head_push'").get(),
    ).toEqual({ n: 0 });
    await reconcileOnce({ cfg, store, adapter: gh, hooks });
    expect(
      store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE pr=44 AND kind='head_push'").get(),
    ).toEqual({ n: 1 });
  });

  it("records merged-over-block feedback before a fallible close callback", async () => {
    const { hooks } = recordingHooks();
    seed(43, "awaiting_author");
    gh.closedPrs.set(43, ref(43, { state: "closed", merged: true }));
    const feedback = vi.fn(async () => {
      throw new Error("feedback callback failed");
    });
    await reconcileOnce({ cfg, store, adapter: gh, hooks, onMergedOverBlock: feedback });
    expect(store.getPr(43)?.state).toBe("closed");
    expect(store.feedbackSignalsFor(43)).toMatchObject([{ kind: "merged_over_block" }]);
    await reconcileOnce({ cfg, store, adapter: gh, hooks, onMergedOverBlock: feedback });
    expect(store.feedbackSignalsFor(43)).toHaveLength(1);
    expect(feedback).toHaveBeenCalledTimes(1);
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

  // A webhook lost (during a drain, say) leaves the poll the only witness of a
  // person's re-review request; a PR already queued by the system must still
  // learn the request is a person's, or dispatch may skip it as trivial.
  it("upgrades a system-queued PR to human provenance on a fresh trigger edge", async () => {
    const { hooks } = recordingHooks();
    seed(41, "tracked", { head: "sha41" });
    gh.open = [ref(41)];
    await reconcileOnce({ cfg, store, adapter: gh, hooks }); // observed absent
    applyEvent(store, 41, { type: "trigger", source: "reconcile" }, {}, { botLogin: "bot" });
    expect(store.getPr(41)!.trigger_provenance).toBe("system");
    const queuedAt = store.getPr(41)!.trigger_ts;

    gh.labelTriggered = [item(41)];
    await reconcileOnce({ cfg, store, adapter: gh, hooks });
    expect(store.getPr(41)!.state).toBe("queued");
    expect(store.getPr(41)!.trigger_provenance).toBe("human");
    expect(store.getPr(41)!.trigger_ts).toBe(queuedAt);
  });

  // The label/team searches can lag the close by a pass.
  it("a closed PR a lagging search still lists writes no correction and no transition", async () => {
    const { hooks } = recordingHooks();
    seed(42, "closed");
    gh.open = [];
    gh.labelTriggered = [item(42)];
    const report = await reconcileOnce({ cfg, store, adapter: gh, hooks });
    expect(report.corrections).toBe(0);
    expect(corrections(store)).toEqual([]);
    expect(
      store.db
        .prepare("SELECT COUNT(*) AS n FROM events WHERE pr = 42 AND kind = 'pr_transition'")
        .get(),
    ).toEqual({ n: 0 });
    expect(store.getPr(42)!.state).toBe("closed");
  });

  it("a search-only PR never tracked here is not queued while the open list omits it", async () => {
    const { hooks } = recordingHooks();
    gh.open = [];
    gh.labelTriggered = [item(45)];
    const report = await reconcileOnce({ cfg, store, adapter: gh, hooks });
    expect(report.corrections).toBe(0);
    expect(corrections(store)).toEqual([]);
    expect(store.getPr(45)).toBeUndefined();
  });

  // A PR merged while the daemon was down, still tracked locally and still
  // listed by a lagging search: the closed-sync decides it from the PR, so the
  // search must not queue it first — that would erase the standing block the
  // merge-over-block signal reads, and count a phantom correction.
  it("a search-only PR still live locally is left to the closed-sync", async () => {
    const { hooks } = recordingHooks();
    seed(44, "awaiting_author");
    gh.open = [];
    gh.labelTriggered = [item(44)];
    gh.closedPrs.set(44, ref(44, { state: "closed", merged: true }));
    const overBlock: number[] = [];
    await reconcileOnce({
      cfg,
      store,
      adapter: gh,
      hooks,
      onMergedOverBlock: async (pr) => {
        overBlock.push(pr);
      },
    });
    expect(corrections(store).map((c) => c.what)).toEqual(["pr-closed"]);
    expect(overBlock).toEqual([44]);
    expect(store.getPr(44)!.state).toBe("closed");
  });

  // A pause defers a person's request; it must not acknowledge it away. With
  // the head already push-rechecked, a consumed edge would read as standing
  // residue after the resume and the request would never run.
  it("a trigger that appears while a PR is paused is still a fresh request after the resume", async () => {
    const { hooks } = recordingHooks();
    seed(43, "tracked", { head: "layout-sha" });
    store.recordReviewedHead(43, { head_sha: "approved-sha", verdict: "APPROVE", round_no: 1 });
    store.claimRecheck(43, "push:layout-sha::", { head_sha: "layout-sha", trigger: "push" });
    gh.open = [ref(43, { head_sha: "layout-sha" })];
    await reconcileOnce({ cfg, store, adapter: gh, hooks }); // observed absent

    store.pausePr(43, { issuer: "operator", expires_at: null }, "hold");
    gh.labelTriggered = [item(43)];
    await reconcileOnce({ cfg, store, adapter: gh, hooks });
    expect(store.getPr(43)!.state).toBe("tracked");

    store.resumePr(43, "operator");
    await reconcileOnce({ cfg, store, adapter: gh, hooks });
    expect(store.getPr(43)!.state).toBe("queued");
    expect(store.getPr(43)!.trigger_provenance).toBe("human");
  });

  // Push-trigger backstop: with webhooks dead, a post-review push would never
  // be rechecked and a withheld approval would have no path forward —
  // reconcile hands detected pushes to the same recheck route the webhook's
  // onSynchronize uses.
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

  // Lost-recheck backstop: change-detection fires exactly once, so a recheck
  // that failed to deliver would never retry once the head was tracked. A
  // standing APPROVE at a stale reviewed head with the question unclaimed is re-asked; a claimed question dedupes.
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
  // no park state at all.
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

// The raw-tier sweep rides the reconcile pass — after the
// closed-sync, so a PR closed THIS pass is already closed when it runs — and
// it is never an error of the pass: the boot's first healthy pass lifts a
// deploy drain, and memory must not be able to hold that.
describe("the stale raw-tier sweep rides the reconcile pass", () => {
  it("runs after the closed-sync and lands its outcome on the report and the pass event", async () => {
    gh.closedPrs.set(4, ref(4, { state: "closed", merged: true }));
    seed(4, "tracked");
    const order: string[] = [];
    const { hooks: base } = recordingHooks();
    const hooks: SessionHooks = {
      ...base,
      async archiveAndClose(pr) {
        order.push(`close ${pr}`);
      },
      async sweepStaleOvSessions() {
        // The PR closed this pass is already closed in the registry.
        order.push(`sweep (pr 4 ${store.getPr(4)!.state})`);
        return { listed: 3, stale: 1, deleted: ["pr-4"], failed: [], deferred: 0 };
      },
    };
    const report = await reconcileOnce({ cfg, store, adapter: gh, hooks });
    expect(order).toEqual(["close 4", "sweep (pr 4 closed)"]);
    expect(report.ov_sessions).toEqual({
      listed: 3,
      stale: 1,
      deleted: ["pr-4"],
      failed: [],
      deferred: 0,
    });
    expect(report.errors).toEqual([]);
    const pass = store.db
      .prepare("SELECT payload FROM events WHERE kind = 'reconcile_pass'")
      .get() as { payload: string };
    expect(JSON.parse(pass.payload)).toMatchObject({
      ov_sessions_deleted: 1,
      ov_sessions_failed: 0,
    });
  });

  it("a sweep that cannot list, or throws, is NEVER an error of the pass", async () => {
    const { hooks: base } = recordingHooks();
    const failing: SessionHooks = {
      ...base,
      async sweepStaleOvSessions() {
        return { listed: 0, stale: 0, deleted: [], failed: [], deferred: 0, error: "401" };
      },
    };
    const report = await reconcileOnce({ cfg, store, adapter: gh, hooks: failing });
    expect(report.errors).toEqual([]);
    expect(report.ov_sessions?.error).toBe("401");
    const throwing: SessionHooks = {
      ...base,
      async sweepStaleOvSessions() {
        throw new Error("boom");
      },
    };
    const report2 = await reconcileOnce({ cfg, store, adapter: gh, hooks: throwing });
    expect(report2.errors).toEqual([]);
    expect(report2.ov_sessions).toBeUndefined();
  });

  it("no raw tier managed ⇒ no sweep and nothing on the report", async () => {
    const { hooks } = recordingHooks();
    const report = await reconcileOnce({ cfg, store, adapter: gh, hooks });
    expect(report.ov_sessions).toBeUndefined();
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

    const res = reconcileOrphanedRounds(store, [10], {});

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

  it("rolls back orphan cancellation when replacement publication fails", () => {
    const store = new StateStore(":memory:");
    try {
      upsert(store, 14, "reviewing");
      const id = store.startRound(14, "first", ["pass-baseline"], 75);
      const checkpoint = vi.spyOn(store, "upsertPr").mockImplementationOnce(() => {
        throw new Error("queue disk failure");
      });
      expect(() => reconcileOrphanedRounds(store, [], {})).toThrow("queue disk failure");
      checkpoint.mockRestore();
      expect(store.runningRounds().map((r) => r.id)).toContain(id);
      expect(store.getPr(14)?.state).toBe("reviewing");
      expect(reconcileOrphanedRounds(store, [], {}).requeued).toEqual([14]);
      expect(store.getPr(14)?.state).toBe("queued");
    } finally {
      store.close();
    }
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

    const res = reconcileOrphanedRounds(store, [], {});

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

    const res = reconcileOrphanedRounds(store, [], {});
    expect(res.cancelled).toEqual([20]);
    expect(res.requeued).toEqual([]); // the phantom was superseded — no new round
    expect(
      (store.db.prepare("SELECT status FROM rounds WHERE id = ?").get(oldId) as any).status,
    ).toBe("cancelled");
    store.close();
  });
});

// ---- stale-trigger residue -------------------------------------------------

describe("stale-trigger residue sweep", () => {
  it("clears stale_recheck + trigger_ts on a settled PR with no round running, and logs it", async () => {
    // The residue shape: tracked, stale_recheck=1, a days-old trigger_ts,
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

    // A human re-labels the PR: an explicit trigger, days later.
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

describe("undelivered recheck-claim sweep", () => {
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
    return h;
  }

  /** A claim older than the grace window, as a dropped nudge leaves one. */
  function staleClaim(pr: number): void {
    store.claimRecheck(pr, fp, { head_sha: "head1", trigger: "push", reason: "delta" });
    store.db
      .prepare("UPDATE rechecks SET created_at = ? WHERE pr = ? AND fingerprint = ?")
      .run("2026-08-14T09:00:00.000Z", pr, fp);
  }

  it("retains legacy non-push debt when no exact rendered payload survived", async () => {
    gh.open = [ref(605)];
    seed(605, "tracked");
    store.claimRecheck(605, "legacy-ci", { head_sha: "sha605", trigger: "ci" });
    store.db.prepare("UPDATE rechecks SET created_at='2020-01-01T00:00:00.000Z'").run();
    const hooks = hooksWithReceipt(false);
    const injected = vi.spyOn(hooks, "inject");
    await reconcileOnce({ cfg, store, adapter: gh, hooks });
    expect(store.hasRecheck(605, "legacy-ci")).toBe(true);
    expect(injected).not.toHaveBeenCalled();
    expect(store.lastEventAt("recheck_payload_unknown", 605)).toBeDefined();
  });

  it("keeps an owed CI payload paused while its owner trigger is disabled", async () => {
    gh.open = [ref(606)];
    seed(606, "tracked");
    const fingerprint = "owed-ci";
    store.claimRecheck(606, fingerprint, {
      head_sha: "sha606",
      trigger: "ci",
      delivery: {
        payload: `question\n${recheckPromptMarker(606, fingerprint)}`,
        reason: "recheck:ci",
      },
    });
    store.db.prepare("UPDATE rechecks SET created_at='2020-01-01T00:00:00.000Z'").run();
    store.recordReviewedHead(606, { head_sha: "sha606", verdict: "APPROVE", round_no: 1 });
    const hooks = hooksWithReceipt(false);
    const injected = vi.spyOn(hooks, "inject");
    await reconcileOnce({
      cfg: { ...cfg, recheck: { ...cfg.recheck, on_ci: false } },
      store,
      adapter: gh,
      hooks,
    });
    expect(injected).not.toHaveBeenCalled();
    expect(store.recheckDelivery(606, fingerprint)).not.toBeNull();
    await reconcileOnce({ cfg, store, adapter: gh, hooks });
    expect(injected).toHaveBeenCalledTimes(1);
  });

  it("does not replay an owed question at a superseding current head", async () => {
    gh.open = [ref(607, { head_sha: "new" })];
    seed(607, "tracked", { head: "new" });
    const fingerprint = "old-ci";
    store.claimRecheck(607, fingerprint, {
      head_sha: "old",
      trigger: "ci",
      delivery: {
        payload: `old question\n${recheckPromptMarker(607, fingerprint)}`,
        reason: "recheck:ci",
      },
    });
    store.db.prepare("UPDATE rechecks SET created_at='2020-01-01T00:00:00.000Z'").run();
    store.recordReviewedHead(607, { head_sha: "old", verdict: "APPROVE", round_no: 1 });
    const hooks = hooksWithReceipt(false);
    const injected = vi.spyOn(hooks, "inject");
    await reconcileOnce({ cfg, store, adapter: gh, hooks });
    expect(injected).not.toHaveBeenCalled();
    expect(store.hasRecheck(607, fingerprint)).toBe(false);
    expect(store.recheckDelivery(607, fingerprint)).toBeNull();
  });

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
    // wakeOrHold holds a mid-round nudge in `pending_wakes` by design.
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

describe("undelivered recheck-claim sweep — bounded (boot stall)", () => {
  // An unbounded sweep blocks the event loop: it would ask about every claim
  // ever written — already-delivered ones re-proven every pass, claims on
  // closed PRs, no-op claims that never carried a token — every 5 minutes.
  const NOW = () => new Date("2026-08-14T12:00:00Z");
  const STALE = "2026-08-14T09:00:00.000Z";

  function claimAt(
    pr: number,
    fp: string,
    opts: { reason?: string; nudge?: boolean; at?: string } = {},
  ): void {
    store.claimRecheck(pr, fp, {
      head_sha: `sha${pr}`,
      trigger: "push",
      reason: opts.reason ?? "2 changed file(s) this review",
      ...(opts.nudge === undefined ? {} : { nudge: opts.nudge }),
    });
    store.db
      .prepare("UPDATE rechecks SET created_at = ? WHERE pr = ? AND fingerprint = ?")
      .run(opts.at ?? STALE, pr, fp);
  }

  function askingHooks(answer: (pr: number, marker: string) => boolean | null): SessionHooks & {
    asked: string[];
  } {
    const h = recordingHooks().hooks as SessionHooks & { asked: string[] };
    h.asked = [];
    h.wakeReceiptPresent = async (pr, marker) => {
      h.asked.push(`${pr}:${marker}`);
      return answer(pr, marker);
    };
    return h;
  }

  const released = () =>
    corrections(store).filter((c) => c.what === "recheck-claim-released-undelivered");

  it("records a found receipt once and never asks about that claim again", async () => {
    gh.open = [ref(700)];
    seed(700, "tracked");
    claimAt(700, "push:a");
    const hooks = askingHooks(() => true);

    await reconcileOnce({ cfg, store, adapter: gh, hooks, now: NOW });
    expect(hooks.asked).toEqual([`700:${recheckPromptMarker(700, "push:a")}`]);
    expect(store.rechecksFor(700)[0]?.receipt_at).not.toBeNull();

    await reconcileOnce({ cfg, store, adapter: gh, hooks, now: NOW });
    await reconcileOnce({ cfg, store, adapter: gh, hooks, now: NOW });
    expect(hooks.asked).toHaveLength(1); // delivered is a fact, not re-proven
    expect(store.hasRecheck(700, "push:a")).toBe(true);
  });

  it("a no-op claim carries no token, so it is never released and the backstop is never re-armed", async () => {
    // Releasing a no-op claim the moment the session writes anything (reading
    // the absent token as a lost nudge) would let the next pass's backstop
    // re-ask a question the trivial-delta classifier already answered.
    seed(701, "tracked", { head: "cur-sha" });
    store.recordReviewedHead(701, { head_sha: "approved-sha", verdict: "APPROVE", round_no: 1 });
    gh.open = [ref(701, { head_sha: "cur-sha" })];
    claimAt(701, "push:cur-sha::", { reason: "noop:trivial-delta", nudge: false });
    // The session HAS written since, without any token: what an unbounded
    // sweep would read as "provable absence".
    const hooks = askingHooks(() => false);
    const pushes: number[] = [];
    const onHeadPush = async (pr: number): Promise<void> => {
      pushes.push(pr);
    };

    for (let pass = 0; pass < 3; pass++)
      await reconcileOnce({ cfg, store, adapter: gh, hooks, now: NOW, onHeadPush });

    expect(hooks.asked).toEqual([]);
    expect(released()).toHaveLength(0);
    expect(store.hasRecheck(701, "push:cur-sha::")).toBe(true);
    expect(pushes).toEqual([]); // the answered question is never re-asked
  });

  it("a claim on a closed PR is not asked; reopened, it is asked again", async () => {
    seed(702, "closed");
    claimAt(702, "push:a");
    const hooks = askingHooks(() => false);

    await reconcileOnce({ cfg, store, adapter: gh, hooks, now: NOW });
    expect(hooks.asked).toEqual([]);
    expect(store.hasRecheck(702, "push:a")).toBe(true);

    // GitHub says open again: the open-PR step reopens it, and the sweep later
    // in the same pass asks about its claims again.
    gh.open = [ref(702)];
    await reconcileOnce({ cfg, store, adapter: gh, hooks, now: NOW });
    expect(store.getPr(702)?.state).not.toBe("closed");
    expect(hooks.asked).toEqual([`702:${recheckPromptMarker(702, "push:a")}`]);
    expect(store.hasRecheck(702, "push:a")).toBe(false);
    expect(released()).toHaveLength(1);
  });

  it("the boot pass defers the sweep; the next pass runs it", async () => {
    gh.open = [ref(703)];
    seed(703, "tracked");
    claimAt(703, "push:a");
    const hooks = askingHooks(() => false);
    const logs: string[] = [];

    await reconcileOnce({
      cfg,
      store,
      adapter: gh,
      hooks,
      now: NOW,
      receiptSweep: false,
      log: (m) => logs.push(m),
    });
    expect(hooks.asked).toEqual([]);
    expect(store.hasRecheck(703, "push:a")).toBe(true);
    expect(logs.some((l) => l.includes("undelivered-recheck sweep deferred"))).toBe(true);

    await reconcileOnce({ cfg, store, adapter: gh, hooks, now: NOW });
    expect(store.hasRecheck(703, "push:a")).toBe(false);
  });

  it("past its budget the sweep carries the rest, least recently asked first — nothing starves", async () => {
    gh.open = [ref(704), ref(705), ref(706)];
    for (const n of [704, 705, 706]) {
      seed(n, "tracked");
      claimAt(n, "push:a", { at: `2026-08-14T09:00:0${n - 704}.000Z` });
    }
    // No evidence either way: nothing settles, so only the rotation can make
    // progress past the first claim.
    const hooks = askingHooks(() => null);
    const passes: number[][] = [];
    for (let pass = 0; pass < 4; pass++) {
      const before = hooks.asked.length;
      const report = await reconcileOnce({
        cfg,
        store,
        adapter: gh,
        hooks,
        now: NOW,
        receiptSweepBudgetMs: 0, // one claim a pass
      });
      passes.push(hooks.asked.slice(before).map((a) => Number(a.split(":")[0])));
      expect(report.receipt_sweep).toMatchObject({ asked: 1, carried: 2 });
    }
    expect(passes).toEqual([[704], [705], [706], [704]]);
    expect(released()).toHaveLength(0);
  });

  it("yields a real event-loop turn per claim — the sweep is never one synchronous span", async () => {
    const n = 300;
    for (let i = 0; i < n; i++) {
      seed(800 + i, "tracked");
      claimAt(800 + i, "push:a");
    }
    gh.open = Array.from({ length: n }, (_, i) => ref(800 + i));
    // The receipt answers WITHOUT real I/O — an async function whose body is
    // synchronous, which keeps an unyielding loop on the microtask queue for
    // every claim.
    const hooks = askingHooks(() => true);
    let turns = 0;
    let ticking = true;
    const tick = (): void => {
      turns++;
      if (ticking) setImmediate(tick);
    };
    setImmediate(tick);
    const report = await reconcileOnce({ cfg, store, adapter: gh, hooks, now: NOW });
    ticking = false;
    expect(report.receipt_sweep).toMatchObject({ asked: n, delivered: n, released: 0 });
    expect(turns).toBeGreaterThanOrEqual(n);
  });
});
