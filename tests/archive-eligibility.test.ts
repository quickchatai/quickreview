// Archive eligibility, docs/archiving.md §7.1: ONE function, and
// every clause of it, each alone. A PR is eligible only when ALL hold; each
// row below breaks exactly one and must come back with exactly its reason.
import { describe, expect, it } from "vitest";
import {
  closedAt,
  INELIGIBLE_REASONS,
  prEligibility,
  type OutsideFacts,
} from "../src/archive/eligibility.js";
import { StateStore } from "../src/state.js";

const T0 = Date.parse("2026-10-21T12:00:00.000Z");
const DAY = 86_400_000;
const PR = 5406;
const INJECT = `/sandbox/inject/pr-${PR}`;

/** A store whose clock the test moves. */
function rig(): { store: StateStore; at: (ms: number) => void } {
  let now = T0;
  const store = new StateStore(":memory:", () => new Date(now));
  return { store, at: (ms) => (now = ms) };
}

/** PR `n`, closed `daysAgo` days before T0 (its `pr_closed` event then). */
function closedPr(h: ReturnType<typeof rig>, n = PR, daysAgo = 20): void {
  h.at(T0 - daysAgo * DAY);
  h.store.upsertPr({
    number: n,
    state: "closed",
    head_sha: "abc",
    title: "t",
    author: "a",
    trigger_ts: null,
    stale_recheck: 0,
    migration_gate: 0,
  });
  h.store.logEvent("pr_closed", n, { merged: true });
  h.at(T0);
}

const clear: OutsideFacts = { workerAlive: false, birthInFlight: false, injectFiles: [] };

function check(h: ReturnType<typeof rig>, outside: Partial<OutsideFacts> = {}, pr = PR) {
  return prEligibility(h.store, pr, {
    now: new Date(T0),
    afterDays: 14,
    outside: { ...clear, ...outside },
  });
}

function command(
  h: ReturnType<typeof rig>,
  id: string,
  status: "pending" | "running" | "acked" | "failed" | "cancelled",
  inject = `${INJECT}/${id}.md`,
): void {
  h.store.createSessionCommand({
    id,
    pr: PR,
    session: `pr-${PR}`,
    kind: "wake",
    round_no: null,
    payload_sha256: "0".repeat(64),
    payload_path: `/sandbox/state/session-commands/${id}.md`,
    inject_path: inject,
    next_check_at: new Date(T0).toISOString(),
  });
  if (status !== "pending")
    h.store.db.prepare("UPDATE session_commands SET status = ? WHERE id = ?").run(status, id);
}

function failure(h: ReturnType<typeof rig>, workOwed: 0 | 1): void {
  const ts = new Date(T0 - 19 * DAY).toISOString();
  h.store.db
    .prepare(
      `INSERT INTO review_failures (incident_id, pr, head_sha, stage, detail, attempts, retry_cap,
         failed_at, updated_at, next_action, work_owed, recovered_at, recovery)
       VALUES (?, ?, 'abc', 'first_pass_start', 'd', 1, 2, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `review-failure:pr-${PR}-${workOwed}`,
      PR,
      ts,
      ts,
      workOwed ? "operator" : "closed",
      workOwed,
      workOwed ? null : ts,
      workOwed ? null : "terminal-closed",
    );
}

describe("archive eligibility — every clause of §7.1, each alone", () => {
  it("a PR closed 20 days ago with nothing standing is eligible, counted from its pr_closed event", () => {
    const h = rig();
    closedPr(h);
    const e = check(h);
    expect(e).toMatchObject({
      eligible: true,
      reason: null,
      reasons: [],
      closed_at: new Date(T0 - 20 * DAY).toISOString(),
      closed_source: "pr_closed_event",
    });
  });

  type Row = {
    clause: string;
    reason: (typeof INELIGIBLE_REASONS)[number];
    setup: (h: ReturnType<typeof rig>) => void;
    outside?: Partial<OutsideFacts>;
  };
  const rows: Row[] = [
    {
      clause: "no registry row",
      reason: "unknown_pr",
      setup: () => {},
    },
    {
      clause: "pr_state is not closed",
      reason: "not_closed",
      setup: (h) => h.store.setPrState(PR, "tracked"),
    },
    {
      clause: "closed less than after_days ago",
      reason: "closed_recently",
      setup: (h) => {
        h.at(T0 - 13 * DAY);
        h.store.logEvent("pr_closed", PR, { merged: true });
        h.at(T0);
      },
    },
    {
      clause: "a worker of pr-<n> runs",
      reason: "worker_alive",
      setup: () => {},
      outside: { workerAlive: true },
    },
    {
      clause: "worker liveness could not be asked",
      reason: "worker_unknown",
      setup: () => {},
      outside: { workerAlive: null },
    },
    {
      clause: "a session birth is in flight",
      reason: "birth_in_flight",
      setup: () => {},
      outside: { birthInFlight: true },
    },
    {
      clause: "a round is running",
      reason: "round_running",
      setup: (h) => h.store.startRound(PR, "first", ["pass-baseline"], 60),
    },
    {
      clause: "a round is overdue (not terminal either)",
      reason: "round_overdue",
      setup: (h) => {
        const id = h.store.startRound(PR, "first", ["pass-baseline"], 60);
        h.store.db.prepare("UPDATE rounds SET status = 'overdue' WHERE id = ?").run(id);
      },
    },
    {
      clause: "a session command is pending",
      reason: "command_active",
      setup: (h) => command(h, "c-pending", "pending", "/elsewhere/c-pending.md"),
    },
    {
      clause: "a session command is running",
      reason: "command_active",
      setup: (h) => command(h, "c-running", "running", "/elsewhere/c-running.md"),
    },
    {
      clause: "a review failure owes work (work_owed = 1) — the owner resolves it, never us",
      reason: "failure_open",
      setup: (h) => failure(h, 1),
    },
    {
      clause: "a wake is held",
      reason: "wake_held",
      setup: (h) => h.store.holdWake(PR, "wake text", "round_in_flight"),
    },
    {
      clause: "a top-level inject file whose command row is non-terminal",
      reason: "pending_inject",
      // A non-terminal row holds through its own clause too (command_active);
      // the assertion below expects both.
      setup: (h) => command(h, "c-inj", "running"),
      outside: { injectFiles: [`${INJECT}/c-inj.md`] },
    },
    {
      clause: "a top-level inject file with no command row at all",
      reason: "pending_inject",
      setup: () => {},
      outside: { injectFiles: [`${INJECT}/legacy-unadopted.md`] },
    },
    {
      clause: "the inject dir could not be listed",
      reason: "inject_unknown",
      setup: () => {},
      outside: { injectFiles: null },
    },
  ];

  it.each(rows)("$clause ⇒ $reason", ({ reason, setup, outside, clause }) => {
    const h = rig();
    if (clause !== "no registry row") closedPr(h);
    setup(h);
    const e = check(h, outside);
    expect(e.eligible).toBe(false);
    expect(e.reasons).toContain(reason);
    if (clause.startsWith("a top-level inject file whose command row is non-terminal"))
      // The non-terminal row holds through its own clause too — both say so.
      expect(e.reasons).toEqual(["command_active", "pending_inject"]);
    else expect(e.reasons).toEqual([reason]);
    expect(e.reason).toBe(e.reasons[0]);
  });

  it("every reason in the vocabulary is exercised above", () => {
    const covered = new Set(rows.map((r) => r.reason));
    expect([...INELIGIBLE_REASONS].filter((r) => !covered.has(r))).toEqual([]);
  });

  it("a top-level inject file whose command row is TERMINAL is a leftover, not a hold (stale_inject)", () => {
    const h = rig();
    closedPr(h);
    for (const [id, status] of [
      ["c-acked", "acked"],
      ["c-failed", "failed"],
      ["c-cancelled", "cancelled"],
    ] as const)
      command(h, id, status);
    const files = ["c-acked", "c-failed", "c-cancelled"].map((id) => `${INJECT}/${id}.md`);
    const e = check(h, { injectFiles: files });
    expect(e.eligible).toBe(true);
    expect(e.stale_injects).toEqual(files);
  });

  it("a RECOVERED review failure (work_owed = 0) does not hold the PR", () => {
    const h = rig();
    closedPr(h);
    failure(h, 0);
    expect(check(h).eligible).toBe(true);
  });

  it("terminal rounds (done, cancelled, expired) do not hold the PR", () => {
    const h = rig();
    closedPr(h);
    for (const status of ["done", "cancelled", "expired"]) {
      const id = h.store.startRound(PR, "first", ["pass-baseline"], 60);
      h.store.db.prepare("UPDATE rounds SET status = ? WHERE id = ?").run(status, id);
    }
    expect(check(h).eligible).toBe(true);
  });

  it("the window counts from the NEWEST pr_closed event (a reopen and re-close restarts it)", () => {
    const h = rig();
    closedPr(h, PR, 30);
    h.at(T0 - 3 * DAY);
    h.store.logEvent("pr_closed", PR, { merged: true });
    h.at(T0);
    const e = check(h);
    expect(e.reasons).toEqual(["closed_recently"]);
    expect(e.closed_at).toBe(new Date(T0 - 3 * DAY).toISOString());
  });

  it("with no pr_closed event the close falls back to pr_state.updated_at", () => {
    const h = rig();
    h.at(T0 - 15 * DAY);
    h.store.upsertPr({
      number: PR,
      state: "closed",
      head_sha: "abc",
      title: "t",
      author: "a",
      trigger_ts: null,
      stale_recheck: 0,
      migration_gate: 0,
    });
    h.at(T0);
    expect(closedAt(h.store, PR)).toEqual({
      at: new Date(T0 - 15 * DAY).toISOString(),
      source: "pr_state_updated_at",
    });
    expect(check(h)).toMatchObject({ eligible: true, closed_source: "pr_state_updated_at" });
  });

  it("a PR restored earlier counts from the newer of its close and its restore", () => {
    const h = rig();
    closedPr(h, PR, 40);
    h.store.db
      .prepare(
        "INSERT INTO archive_prs (pr, state, restored_at, updated_at) VALUES (?, 'restored', ?, ?)",
      )
      .run(PR, new Date(T0 - 5 * DAY).toISOString(), new Date(T0).toISOString());
    const e = check(h);
    expect(e.reasons).toEqual(["closed_recently"]);
    expect(e.since).toBe(new Date(T0 - 5 * DAY).toISOString());
    // …and once the restore is itself past the window, eligible again.
    expect(
      prEligibility(h.store, PR, {
        now: new Date(T0 + 10 * DAY),
        afterDays: 14,
        outside: clear,
      }).eligible,
    ).toBe(true);
  });

  it("several failing clauses are all reported, the first in the rule's order", () => {
    const h = rig();
    closedPr(h);
    h.store.holdWake(PR, "w", "round_in_flight");
    failure(h, 1);
    const e = check(h, { workerAlive: true });
    expect(e.reasons).toEqual(["worker_alive", "failure_open", "wake_held"]);
    expect(e.reason).toBe("worker_alive");
  });

  it("reads only: the store's change counter does not move", () => {
    const h = rig();
    closedPr(h);
    const before = h.store.db.prepare("SELECT total_changes() AS n").get();
    check(h, { injectFiles: [`${INJECT}/x.md`] });
    expect(h.store.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
  });
});
