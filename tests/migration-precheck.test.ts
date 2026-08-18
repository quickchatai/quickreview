// Migration-number collision pre-check: the dispatch half.
//
// The daemon detects the collision against the PR's base branch at the round's
// pinned base sha, BEFORE the session hears about the round, and delivers it as
// a gated COMMENT — never a blocker, never a verdict.
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parseConfig, type Config } from "../src/config.js";
import { dispatchOnce, type DispatchAdapter } from "../src/dispatch.js";
import { MutationGate, type MutationIntent, type GateResult } from "../src/gate.js";
import type { PrFileEntry } from "../src/github.js";
import { StateStore } from "../src/state.js";
import type { RoundOrder, SessionHooks } from "../src/types.js";

const cfg: Config = parseConfig(readFileSync(resolve(process.cwd(), "config.toml"), "utf8"));

const BASE_MIGRATIONS = [
  "backend/chat/migrations/0041_add_index.py",
  "backend/chat/migrations/0042_add_widget_flag.py",
];

/** Every write this adapter makes goes through a real MutationGate, so the
 * "no mutation path bypasses the gate" criterion is checked, not assumed. */
class GatedAdapter implements DispatchAdapter {
  reviews: Array<{ pr: number; event: string; body: string; commit_id: string }> = [];
  intents: MutationIntent[] = [];
  files: PrFileEntry[] = [];
  failCreateReview = false;
  private readonly gate: MutationGate;

  constructor(dryrunDir: string) {
    this.gate = new MutationGate(false, dryrunDir, async (intent) => {
      this.intents.push(intent);
      if (intent.kind === "create_review") {
        if (this.failCreateReview) throw new Error("500 boom");
        const body = intent.body as { event: string; body: string; commit_id: string };
        this.reviews.push({ pr: intent.pr as number, ...body });
      }
      return { ok: true };
    });
  }

  async getPr(): Promise<{ base_ref: string }> {
    return { base_ref: "master" };
  }
  async listPrFiles(): Promise<PrFileEntry[]> {
    return this.files;
  }
  addLabel(n: number, label: string): Promise<GateResult> {
    return this.gate.execute({ kind: "add_label", method: "POST", path: `/l/${n}`, note: label, pr: n });
  }
  removeLabel(n: number, label: string): Promise<GateResult> {
    return this.gate.execute({ kind: "remove_label", method: "DELETE", path: `/l/${n}`, note: label, pr: n });
  }
  deleteTeamReviewRequest(n: number): Promise<GateResult> {
    return this.gate.execute({ kind: "delete_team_review_request", method: "DELETE", path: `/r/${n}`, note: "", pr: n });
  }
  createReview(
    n: number,
    payload: { commit_id: string; event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"; body: string },
  ): Promise<GateResult> {
    return this.gate.execute({
      kind: "create_review",
      method: "POST",
      path: `/repos/o/r/pulls/${n}/reviews`,
      body: payload,
      note: `post ${payload.event} review on #${n}`,
      pr: n,
    });
  }
}

function file(filename: string, status = "added"): PrFileEntry {
  return { filename, additions: 20, deletions: 0, status };
}

function hooks(orders: RoundOrder[]): SessionHooks {
  return {
    async dispatchRound(order) {
      orders.push(order);
    },
    async inject() {},
    async injectOverseer() {},
    async archiveAndClose() {},
  };
}

let store: StateStore;
let adapter: GatedAdapter;
let orders: RoundOrder[];

function queue(pr: number, head = "headsha"): void {
  store.upsertPr({
    number: pr,
    state: "queued",
    head_sha: head,
    title: `PR ${pr}`,
    author: "alice",
    trigger_ts: "2026-08-18T09:00:00Z",
    stale_recheck: 0,
    migration_gate: 1,
  });
}

const tree = async () => ({ head_sha: "headsha", base_ref: "master", base_sha: "basesha", merge_base: "mb" });

function events(kind: string, pr: number): Array<Record<string, unknown>> {
  return store
    .recentEvents(200)
    .filter((e) => e.kind === kind && e.pr === pr)
    .map((e) => JSON.parse(e.payload ?? "{}") as Record<string, unknown>);
}

beforeEach(() => {
  store = new StateStore(":memory:");
  adapter = new GatedAdapter(mkdtempSync(join(tmpdir(), "qcr-precheck-")));
  orders = [];
});

describe("migration collision pre-check", () => {
  it("posts a COMMENT naming the target number and dependencies, and consumes no verdict", async () => {
    queue(41);
    adapter.files = [file("backend/chat/migrations/0042_add_rate_limit.py"), file("backend/chat/views.py", "modified")];

    await dispatchOnce({
      cfg,
      store,
      adapter,
      hooks: hooks(orders),
      prepareWorktree: tree,
      listBaseMigrations: async () => BASE_MIGRATIONS,
    });

    expect(adapter.reviews).toHaveLength(1);
    const review = adapter.reviews[0]!;
    expect(review.event).toBe("COMMENT");
    expect(review.commit_id).toBe("headsha");
    expect(review.body).toContain("backend/chat/migrations/0043_add_rate_limit.py");
    expect(review.body).toContain('`[("chat", "0042_add_widget_flag")]`');
    // Never a blocker: no REQUEST_CHANGES, and the round still dispatched
    // normally with the PR's verdict untouched.
    expect(adapter.reviews.some((r) => r.event === "REQUEST_CHANGES")).toBe(false);
    expect(orders).toHaveLength(1);
    expect(store.roundsFor(41)[0]?.verdict ?? null).toBeNull();
  });

  it("routes the comment through the MutationGate as a create_review intent", async () => {
    queue(42);
    adapter.files = [file("backend/chat/migrations/0042_x.py")];

    await dispatchOnce({
      cfg,
      store,
      adapter,
      hooks: hooks(orders),
      prepareWorktree: tree,
      listBaseMigrations: async () => BASE_MIGRATIONS,
    });

    const kinds = adapter.intents.map((i) => i.kind);
    expect(kinds).toContain("create_review");
    // The gate is the only path: nothing was written that it did not describe.
    expect(adapter.intents.find((i) => i.kind === "create_review")?.pr).toBe(42);
  });

  it("carries the collisions on the round order, as mechanics not findings", async () => {
    queue(43);
    adapter.files = [file("backend/chat/migrations/0042_x.py")];

    await dispatchOnce({
      cfg,
      store,
      adapter,
      hooks: hooks(orders),
      prepareWorktree: tree,
      listBaseMigrations: async () => BASE_MIGRATIONS,
    });

    expect(orders[0]?.migration_collisions?.[0]).toMatchObject({
      pr_path: "backend/chat/migrations/0042_x.py",
      target_path: "backend/chat/migrations/0043_x.py",
    });
    // The gate flag is unchanged by the pre-check: the lens still runs.
    expect(orders[0]?.migration_gate).toBe(true);
    expect(orders[0]?.lenses).toContain("pass-data-safety");
  });

  it("says nothing when the PR's migration number is free", async () => {
    queue(44);
    adapter.files = [file("backend/chat/migrations/0043_free.py")];

    await dispatchOnce({
      cfg,
      store,
      adapter,
      hooks: hooks(orders),
      prepareWorktree: tree,
      listBaseMigrations: async () => BASE_MIGRATIONS,
    });

    expect(adapter.reviews).toEqual([]);
    expect(orders[0]?.migration_collisions).toEqual([]);
    expect(events("migration_collision_detected", 44)).toEqual([]);
  });

  it("says nothing for a PR with no migrations at all", async () => {
    queue(45);
    adapter.files = [file("backend/chat/views.py", "modified")];
    let asked = 0;

    await dispatchOnce({
      cfg,
      store,
      adapter,
      hooks: hooks(orders),
      prepareWorktree: tree,
      listBaseMigrations: async () => {
        asked++;
        return BASE_MIGRATIONS;
      },
    });

    expect(adapter.reviews).toEqual([]);
    expect(orders).toHaveLength(1);
    expect(asked).toBe(1); // the check runs regardless; it simply finds nothing
  });

  it("does not repost the same collision at the same head (staleness re-round)", async () => {
    queue(46);
    adapter.files = [file("backend/chat/migrations/0042_x.py")];
    const args = {
      cfg,
      store,
      adapter,
      hooks: hooks(orders),
      prepareWorktree: tree,
      listBaseMigrations: async () => BASE_MIGRATIONS,
    };

    await dispatchOnce(args);
    store.finishRound(store.roundsFor(46)[0]!.id, "REQUEST_CHANGES", null);
    store.setPrState(46, "queued");
    await dispatchOnce(args);

    expect(orders).toHaveLength(2);
    expect(adapter.reviews).toHaveLength(1);
    // Detection still fired on the second round — only the duplicate post is
    // suppressed, never the check.
    expect(events("migration_collision_detected", 46)).toHaveLength(2);
  });

  it("logs a skip (never a silent pass) when there is no base reader", async () => {
    queue(47);
    adapter.files = [file("backend/chat/migrations/0042_x.py")];

    await dispatchOnce({ cfg, store, adapter, hooks: hooks(orders), prepareWorktree: tree });

    expect(adapter.reviews).toEqual([]);
    expect(events("migration_precheck_skipped", 47)[0]).toMatchObject({ reason: "no_base_reader" });
    expect(orders).toHaveLength(1);
  });

  it("never loses a round to a failing pre-check", async () => {
    queue(48);
    adapter.files = [file("backend/chat/migrations/0042_x.py")];
    adapter.failCreateReview = true;

    await dispatchOnce({
      cfg,
      store,
      adapter,
      hooks: hooks(orders),
      prepareWorktree: tree,
      listBaseMigrations: async () => BASE_MIGRATIONS,
    });

    expect(orders).toHaveLength(1);
    expect(events("migration_precheck_failed", 48)).toHaveLength(1);
  });
});
