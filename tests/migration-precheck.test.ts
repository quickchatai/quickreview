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
import { AnomalyWakePolicy } from "../src/anomalies.js";
import { StateStore } from "../src/state.js";
import { renderRoundPrompt } from "../src/templates.js";
import type { RoundOrder, SessionHooks } from "../src/types.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const cfg: Config = parseConfig(
  readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8"),
);

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
  /** A posting guard's refusal tag for create_review, or null to let it by. */
  refuseReview: string | null = null;
  private readonly gate: MutationGate;

  constructor(dryrunDir: string, dryRun = false) {
    this.gate = new MutationGate(dryRun, dryrunDir, async (intent) => {
      this.intents.push(intent);
      if (intent.kind === "create_review") {
        if (this.failCreateReview) throw new Error("500 boom");
        const body = intent.body as { event: string; body: string; commit_id: string };
        this.reviews.push({ pr: intent.pr as number, ...body });
      }
      return { ok: true };
    });
    this.gate.setGuard({
      before: async (intent) =>
        intent.kind === "create_review" && this.refuseReview ? { block: this.refuseReview } : {},
    });
  }

  async getPr(): Promise<{ base_ref: string }> {
    return { base_ref: "master" };
  }
  async listPrFiles(): Promise<PrFileEntry[]> {
    return this.files;
  }
  addLabel(n: number, label: string): Promise<GateResult> {
    return this.gate.execute({
      kind: "add_label",
      method: "POST",
      path: `/l/${n}`,
      note: label,
      pr: n,
    });
  }
  removeLabel(n: number, label: string): Promise<GateResult> {
    return this.gate.execute({
      kind: "remove_label",
      method: "DELETE",
      path: `/l/${n}`,
      note: label,
      pr: n,
    });
  }
  deleteTeamReviewRequest(n: number): Promise<GateResult> {
    return this.gate.execute({
      kind: "delete_team_review_request",
      method: "DELETE",
      path: `/r/${n}`,
      note: "",
      pr: n,
    });
  }
  createReview(
    n: number,
    payload: { commit_id: string; event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"; body: string },
    options?: { purpose?: "migration_precheck" },
  ): Promise<GateResult> {
    return this.gate.execute({
      kind: "create_review",
      method: "POST",
      path: `/repos/o/r/pulls/${n}/reviews`,
      body: payload,
      note: `post ${payload.event} review on #${n}`,
      pr: n,
      reviewPurpose: options?.purpose,
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

const tree = async () => ({
  head_sha: "headsha",
  base_ref: "master",
  base_sha: "basesha",
  merge_base: "mb",
});

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
  it(
    "posts a COMMENT naming the target number and dependencies, and consumes no verdict",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(41);
      adapter.files = [
        file("backend/chat/migrations/0042_add_rate_limit.py"),
        file("backend/chat/views.py", "modified"),
      ];

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
      expect(review.body).toContain('point its `chat` entry at `("chat", "0042_add_widget_flag")`');
      // Never a blocker: no REQUEST_CHANGES, and the round still dispatched
      // normally with the PR's verdict untouched.
      expect(adapter.reviews.some((r) => r.event === "REQUEST_CHANGES")).toBe(false);
      expect(orders).toHaveLength(1);
      expect(store.roundsFor(41)[0]).toMatchObject({
        verdict: null,
        preflight_posting_state: "executed",
      });
    },
  );

  it(
    "routes the comment through the MutationGate as a create_review intent",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
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
      const intent = adapter.intents.find((i) => i.kind === "create_review");
      expect(intent?.pr).toBe(42);
      expect(intent?.reviewPurpose).toBe("migration_precheck");
    },
  );

  it(
    "carries the collisions on the round order, as mechanics not findings",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
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
    },
  );

  // The COMMENT alone does not fix the ticket: if the session still hears
  // nothing, pass-data-safety re-derives the same collision and REQUEST_CHANGES
  // is posted anyway — the merge gate consumed, the re-review round owed. So
  // the pre-check's result must arrive in the prompt the session is actually
  // injected with (the round template rendered through src/templates.ts).
  it(
    "tells the session, in the real rendered prompt, that the collision is already handled",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(49);
      adapter.files = [file("backend/chat/migrations/0042_x.py")];
      const prompts: string[] = [];
      const template = readFileSync(resolve(process.cwd(), "prompts/round-first.md"), "utf8");

      await dispatchOnce({
        cfg,
        store,
        adapter,
        hooks: {
          async dispatchRound(_order, prompt) {
            prompts.push(prompt);
          },
          async inject() {},
          async injectOverseer() {},
          async archiveAndClose() {},
        },
        renderPrompt: (o) => renderRoundPrompt(template, o),
        prepareWorktree: tree,
        listBaseMigrations: async () => BASE_MIGRATIONS,
      });

      const prompt = prompts[0] ?? "";
      expect(prompt).toContain("ALREADY HANDLED, DO NOT RAISE IT");
      expect(prompt).toContain("backend/chat/migrations/0043_x.py");
      expect(prompt).toContain('("chat", "0042_add_widget_flag")');
      expect(prompt).toContain("not a finding");
      // A pre-check that RAN never renders the degraded note.
      expect(prompt).not.toContain("MIGRATION PRE-CHECK DID NOT RUN");
    },
  );

  it(
    "leaves the gate note alone when there is no collision",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(50);
      adapter.files = [file("backend/chat/migrations/0043_free.py")];
      const prompts: string[] = [];
      const template = readFileSync(resolve(process.cwd(), "prompts/round-first.md"), "utf8");

      await dispatchOnce({
        cfg,
        store,
        adapter,
        hooks: {
          async dispatchRound(_order, prompt) {
            prompts.push(prompt);
          },
          async inject() {},
          async injectOverseer() {},
          async archiveAndClose() {},
        },
        renderPrompt: (o) => renderRoundPrompt(template, o),
        prepareWorktree: tree,
        listBaseMigrations: async () => BASE_MIGRATIONS,
      });

      expect(prompts[0]).not.toContain("ALREADY HANDLED");
      expect(prompts[0]).toContain("MIGRATION GATE");
    },
  );

  it("suppresses the repost however many events sit in between", () => {
    // Regression guard: the dedupe used to read the newest 10 events only, so
    // a PR with a busier log quietly started reposting the same comment.
    store.logEvent("migration_collision_comment", 51, { fingerprint: "fp-old" });
    for (let i = 0; i < 40; i++)
      store.logEvent("migration_collision_comment", 51, { fingerprint: `fp-${i}` });
    expect(store.migrationCollisionCommented(51, "fp-old")).toBe("commented");
    expect(store.migrationCollisionCommented(51, "fp-never")).toBe("not_commented");
    expect(store.migrationCollisionCommented(52, "fp-old")).toBe("not_commented"); // scoped per PR
  });

  // the third answer. `unknown` is a comment row this code cannot
  // read: a comment WAS posted, at a fingerprint nobody can recover, so "never
  // commented" is not a claim the log supports.
  it("an unreadable comment row answers UNKNOWN — neither 'commented' nor 'never commented'", () => {
    const torn = store.db.prepare(
      "INSERT INTO events (ts, kind, pr, payload) VALUES (?, 'migration_collision_comment', ?, ?)",
    );
    store.logEvent("migration_collision_comment", 53, { fingerprint: "fp-readable" });
    torn.run("2026-08-18T10:00:00Z", 53, "{torn");
    expect(store.migrationCollisionCommented(53, "fp-readable")).toBe("commented"); // a readable match still wins
    expect(store.migrationCollisionCommented(53, "fp-other")).toBe("unknown");
    expect(store.migrationCollisionCommented(54, "fp-other")).toBe("not_commented"); // scoped per PR
    torn.run("2026-08-18T10:00:00Z", 55, null); // a NULL payload is the same unreadable row
    expect(store.migrationCollisionCommented(55, "fp")).toBe("unknown");
    torn.run("2026-08-18T10:00:00Z", 57, JSON.stringify({ fingerprint: 12 })); // …and so is a non-string fingerprint
    expect(store.migrationCollisionCommented(57, "fp")).toBe("unknown");
  });

  it(
    "a corrupt comment row can never cause the GitHub write a readable one would have suppressed",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(56);
      adapter.files = [file("backend/chat/migrations/0042_x.py")];
      store.db
        .prepare(
          "INSERT INTO events (ts, kind, pr, payload) VALUES (?, 'migration_collision_comment', 56, ?)",
        )
        .run("2026-08-18T10:00:00Z", "{torn");

      await dispatchOnce({
        cfg,
        store,
        adapter,
        hooks: hooks(orders),
        prepareWorktree: tree,
        listBaseMigrations: async () => BASE_MIGRATIONS,
      });

      // No create_review reached the gate — the comment is withheld, not posted.
      expect(adapter.intents.filter((i) => i.kind === "create_review")).toHaveLength(0);
      expect(events("migration_collision_comment_withheld", 56)).toHaveLength(1);
      // The check RAN: detection is logged, the collisions ride the order into
      // the gate note, and the round dispatches un-degraded.
      expect(events("migration_collision_detected", 56)).toHaveLength(1);
      expect(orders).toHaveLength(1);
      expect(orders[0]?.migration_collisions).toHaveLength(1);
      expect(orders[0]?.migration_precheck_degraded).toBeFalsy();
    },
  );

  // A withheld comment is QUIETER than a posted one, and the torn row stays
  // torn on every later round — so the operator hears about it through the
  // same channel a degraded pre-check uses: a durable anomaly + overseer wake.
  it(
    "a withheld collision comment raises an overseer anomaly that names the torn row",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(58);
      adapter.files = [file("backend/chat/migrations/0042_x.py")];
      store.db
        .prepare(
          "INSERT INTO events (ts, kind, pr, payload) VALUES (?, 'migration_collision_comment', 58, ?)",
        )
        .run("2026-08-18T10:00:00Z", "{torn");
      const overseer: string[] = [];
      const policy = new AnomalyWakePolicy({
        injectOverseer: async (m) => {
          overseer.push(m);
        },
      });
      store.setAnomalySink((sig) => policy.onAnomaly(sig));

      await dispatchOnce({
        cfg,
        store,
        adapter,
        hooks: hooks(orders),
        prepareWorktree: tree,
        listBaseMigrations: async () => BASE_MIGRATIONS,
      });

      expect(orders).toHaveLength(1);
      expect(store.anomalies()).toEqual([
        expect.objectContaining({
          kind: "migration_collision_comment_withheld",
          pr: 58,
          round_no: orders[0]!.round_no,
        }),
      ]);
      const wake = overseer.join("\n");
      expect(wake).toContain("WITHHELD");
      expect(wake).toContain("migration_collision_comment");
      expect(wake).toContain("pr = 58");
    },
  );

  it(
    "…once per PR: a PR already told stays told, while another anomaly kind on it does not count",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(59);
      adapter.files = [file("backend/chat/migrations/0042_x.py")];
      store.db
        .prepare(
          "INSERT INTO events (ts, kind, pr, payload) VALUES (?, 'migration_collision_comment', 59, ?)",
        )
        .run("2026-08-18T10:00:00Z", "{torn");
      // An earlier round already raised it (the torn row was there then too).
      store.logAnomaly("migration_collision_comment_withheld", 59, 1, "already told");
      // Another PR's alert, and another kind on THIS PR, are not this PR's alert.
      store.logAnomaly("migration_collision_comment_withheld", 60, 1, "someone else");
      store.logAnomaly("migration_precheck_degraded", 59, 1, "unrelated kind");
      expect(store.anomalyRaised("migration_collision_comment_withheld", 59)).toBe(true);
      expect(store.anomalyRaised("migration_collision_comment_withheld", 61)).toBe(false);
      expect(store.anomalyRaised("migration_precheck_degraded", 60)).toBe(false);

      await dispatchOnce({
        cfg,
        store,
        adapter,
        hooks: hooks(orders),
        prepareWorktree: tree,
        listBaseMigrations: async () => BASE_MIGRATIONS,
      });

      // The withhold itself is still recorded on every round; only the alert is deduplicated.
      expect(events("migration_collision_comment_withheld", 59)).toHaveLength(1);
      expect(adapter.intents.filter((i) => i.kind === "create_review")).toHaveLength(0);
      expect(
        store
          .anomalies()
          .filter((a) => a.pr === 59 && a.kind === "migration_collision_comment_withheld"),
      ).toHaveLength(1);
    },
  );

  it(
    "says nothing when the PR's migration number is free",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
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
    },
  );

  it("says nothing for a PR with no migrations at all", { timeout: HEAVY_TIMEOUT_MS }, async () => {
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

  it(
    "does not repost the same collision at the same head (staleness re-round)",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
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
    },
  );

  // A guard refusal returns without throwing; it is not a delivered comment,
  // so it must not consume the fingerprint the staleness dedupe keys on.
  it(
    "a guard-refused COMMENT is not ledgered as commented, and the next round posts it",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(60);
      adapter.files = [file("backend/chat/migrations/0042_x.py")];
      adapter.refuseReview = "pr-unreadable";
      const args = {
        cfg,
        store,
        adapter,
        hooks: hooks(orders),
        prepareWorktree: tree,
        listBaseMigrations: async () => BASE_MIGRATIONS,
      };

      await dispatchOnce(args);
      expect(adapter.reviews).toHaveLength(0);
      expect(events("migration_collision_comment", 60)).toHaveLength(0);
      expect(events("migration_collision_comment_refused", 60)[0]).toMatchObject({
        reason: "pr-unreadable",
        fingerprint: expect.any(String),
      });

      adapter.refuseReview = null;
      store.finishRound(store.roundsFor(60)[0]!.id, "REQUEST_CHANGES", null);
      store.setPrState(60, "queued");
      await dispatchOnce(args);
      expect(adapter.reviews).toHaveLength(1);
    },
  );

  // A dry-run record is the would-be comment, not a posted one: it dedupes
  // dry-run re-rounds, but after the flip to live the same head still posts.
  it(
    "a dry-run comment record does not suppress the live post at the same head",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(61);
      adapter.files = [file("backend/chat/migrations/0042_x.py")];
      const dry = new GatedAdapter(mkdtempSync(join(tmpdir(), "qcr-precheck-")), true);
      dry.files = adapter.files;
      const base = {
        store,
        hooks: hooks(orders),
        prepareWorktree: tree,
        listBaseMigrations: async () => BASE_MIGRATIONS,
      };

      await dispatchOnce({ ...base, cfg: { ...cfg, dry_run: true }, adapter: dry });
      expect(events("migration_collision_comment", 61)[0]).toMatchObject({ executed: false });
      store.finishRound(store.roundsFor(61)[0]!.id, "REQUEST_CHANGES", null);
      store.setPrState(61, "queued");
      await dispatchOnce({ ...base, cfg: { ...cfg, dry_run: true }, adapter: dry });
      expect(events("migration_collision_comment", 61)).toHaveLength(1); // dry-run re-round deduped

      store.finishRound(store.roundsFor(61)[1]!.id, "REQUEST_CHANGES", null);
      store.setPrState(61, "queued");
      await dispatchOnce({ ...base, cfg: { ...cfg, dry_run: false }, adapter });
      expect(adapter.reviews).toHaveLength(1);
    },
  );

  it(
    "logs a skip (never a silent pass) when there is no base reader",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(47);
      adapter.files = [file("backend/chat/migrations/0042_x.py")];

      await dispatchOnce({ cfg, store, adapter, hooks: hooks(orders), prepareWorktree: tree });

      expect(adapter.reviews).toEqual([]);
      expect(events("migration_precheck_skipped", 47)[0]).toMatchObject({
        reason: "no_base_reader",
      });
      expect(orders).toHaveLength(1);
    },
  );

  // acceptance: "more reliable, never quieter". The three degraded
  // paths must each leave SOMEBODY holding the collision class — the gate note
  // when detection ran, the session itself when it did not.
  it(
    "still renders the collisions into the gate note when the COMMENT fails",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(52);
      adapter.files = [file("backend/chat/migrations/0042_x.py")];
      adapter.failCreateReview = true;
      const prompts: string[] = [];
      const template = readFileSync(resolve(process.cwd(), "prompts/round-first.md"), "utf8");

      await dispatchOnce({
        cfg,
        store,
        adapter,
        hooks: {
          async dispatchRound(order, prompt) {
            orders.push(order);
            prompts.push(prompt);
          },
          async inject() {},
          async injectOverseer() {},
          async archiveAndClose() {},
        },
        renderPrompt: (o) => renderRoundPrompt(template, o),
        prepareWorktree: tree,
        listBaseMigrations: async () => BASE_MIGRATIONS,
      });

      // The collisions were computed and logged — they are not thrown away with
      // the failed COMMENT: the session's gate note still carries them. And it
      // does NOT claim the remedy was posted: nobody told the author, so the
      // session carries it this round (selfscan-2, "never quieter").
      expect(orders[0]?.migration_collisions).toHaveLength(1);
      expect(orders[0]?.migration_collisions_undelivered).toBe(true);
      expect(prompts[0]).not.toContain("ALREADY HANDLED, DO NOT RAISE IT");
      expect(prompts[0]).toContain("REMEDY NOT DELIVERED, CARRY IT IN YOUR REVIEW");
      expect(prompts[0]).toContain("backend/chat/migrations/0043_x.py");
      expect(prompts[0]).not.toContain("MIGRATION PRE-CHECK DID NOT RUN");
      expect(events("migration_precheck_failed", 52)).toHaveLength(1);
      // The fingerprint is only marked on success, so the COMMENT retries later.
      expect(adapter.reviews).toHaveLength(0);
    },
  );

  it(
    "tells the session to check collisions itself when the pre-check cannot run",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(53);
      adapter.files = [file("backend/chat/migrations/0042_x.py")];
      const prompts: string[] = [];
      const overseer: string[] = [];
      // Mirror daemon.ts's wiring: the degraded pre-check wake now flows
      // through the store's anomaly sink rather than a call-site inject.
      const policy = new AnomalyWakePolicy({
        injectOverseer: async (m) => {
          overseer.push(m);
        },
      });
      store.setAnomalySink((sig) => policy.onAnomaly(sig));
      const template = readFileSync(resolve(process.cwd(), "prompts/round-first.md"), "utf8");

      await dispatchOnce({
        cfg,
        store,
        adapter,
        hooks: {
          async dispatchRound(order, prompt) {
            orders.push(order);
            prompts.push(prompt);
          },
          async inject() {},
          async injectOverseer(message) {
            overseer.push(message);
          },
          async archiveAndClose() {},
        },
        renderPrompt: (o) => renderRoundPrompt(template, o),
        prepareWorktree: tree,
        // no listBaseMigrations: the degraded path (a)
      });

      expect(orders[0]?.migration_precheck_degraded).toBe(true);
      expect(prompts[0]).toContain("MIGRATION PRE-CHECK DID NOT RUN");
      expect(prompts[0]).toContain(
        "YOU must check base-branch migration-number collisions yourself",
      );
      // The degraded case is an overseer anomaly, on the existing inject channel.
      expect(overseer.join("\n")).toContain("migration-precheck");
      // and a durable, queryable anomaly record beside the wake.
      const anomalies = store.anomalies();
      expect(anomalies).toHaveLength(1);
      expect(anomalies[0]).toMatchObject({
        kind: "migration_precheck_degraded",
        pr: orders[0]!.pr,
        round_no: orders[0]!.round_no,
      });
      // The round itself still dispatched.
      expect(orders).toHaveLength(1);
    },
  );

  it("degrades the same way when the base read throws", { timeout: HEAVY_TIMEOUT_MS }, async () => {
    queue(54);
    adapter.files = [file("backend/chat/migrations/0042_x.py")];
    const prompts: string[] = [];
    const template = readFileSync(resolve(process.cwd(), "prompts/round-first.md"), "utf8");

    await dispatchOnce({
      cfg,
      store,
      adapter,
      hooks: {
        async dispatchRound(order, prompt) {
          orders.push(order);
          prompts.push(prompt);
        },
        async inject() {},
        async injectOverseer() {},
        async archiveAndClose() {},
      },
      renderPrompt: (o) => renderRoundPrompt(template, o),
      prepareWorktree: tree,
      listBaseMigrations: async () => {
        throw new Error("git for-each-ref exploded");
      },
    });

    expect(orders[0]?.migration_precheck_degraded).toBe(true);
    expect(prompts[0]).toContain("MIGRATION PRE-CHECK DID NOT RUN");
    expect(events("migration_precheck_failed", 54)).toHaveLength(1);
  });

  it(
    "says nothing about a degraded pre-check on a PR with no migrations",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(55);
      adapter.files = [file("backend/chat/views.py", "modified")];
      const prompts: string[] = [];
      const overseer: string[] = [];
      // Mirror daemon.ts's wiring: the degraded pre-check wake now flows
      // through the store's anomaly sink rather than a call-site inject.
      const policy = new AnomalyWakePolicy({
        injectOverseer: async (m) => {
          overseer.push(m);
        },
      });
      store.setAnomalySink((sig) => policy.onAnomaly(sig));
      const template = readFileSync(resolve(process.cwd(), "prompts/round-first.md"), "utf8");

      await dispatchOnce({
        cfg,
        store,
        adapter,
        hooks: {
          async dispatchRound(order, prompt) {
            orders.push(order);
            prompts.push(prompt);
          },
          async inject() {},
          async injectOverseer(message) {
            overseer.push(message);
          },
          async archiveAndClose() {},
        },
        renderPrompt: (o) => renderRoundPrompt(template, o),
        prepareWorktree: tree,
        // no listBaseMigrations — but there is nothing to collide either
      });

      expect(orders[0]?.migration_precheck_degraded).toBe(false);
      expect(prompts[0]).not.toContain("MIGRATION PRE-CHECK DID NOT RUN");
      expect(overseer).toEqual([]);
    },
  );

  it("never loses a round to a failing pre-check", { timeout: HEAVY_TIMEOUT_MS }, async () => {
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
    expect(store.roundsFor(48)[0]?.preflight_posting_state).toBe("ambiguous");
  });
});
