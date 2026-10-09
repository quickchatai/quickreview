// the bot resolves its own threads of prior findings a follow-up
// round verified fixed or obsolete.
//
// #5917 round 3 verified 12 of its 13 prior findings fixed and none of their
// threads was resolved: the bot's only resolve path was ping-pong, which acts
// on an author REPLY. These tests pin, over an in-memory store and a fake
// adapter: which statuses resolve (fixed, obsolete — never open, unverifiable,
// conceded, settled), which comment is a finding's (the outcome capture's link,
// else the record's thread_id, plus a carried finding's earlier postings from
// the sidecar), only that round's reports, and that every outcome — resolved,
// skipped by the adapter, not executed (dry-run), failed, no known comment — is
// an event and never a throw.
import { describe, expect, it } from "vitest";
import {
  earlierRefsFromSidecar,
  priorThreadsToResolve,
  resolveVerifiedPriorThreads,
} from "../src/priorresolve.js";
import { StateStore, type RoundFindingInput } from "../src/state.js";

const HEAD = "abcdef1234567890abcdef1234567890abcdef12";

const finding = (key: string, thread: number | null): RoundFindingInput =>
  ({
    key,
    path: "src/api/orders.py",
    line: 10,
    lens: "pass-security",
    severity: "P1",
    disposition: "posted",
    posted_as: "blocker",
    thread_id: thread,
  }) as RoundFindingInput;

function setup() {
  const store = new StateStore(":memory:");
  store.recordRoundFindings({ pr: 7, round_id: null, round_no: 1, head_sha: HEAD }, [
    finding("fixed1", 101),
    finding("fixed2", 102),
    finding("open1", 103),
    finding("gone1", 104),
    finding("conceded1", 105),
    finding("nolink", null),
  ]);
  store.recordPriorReports(7, 3, HEAD, [
    { round_no: 1, finding_key: "fixed1", status: "fixed", evidence: "x" },
    { round_no: 1, finding_key: "fixed2", status: "fixed", evidence: "x" },
    { round_no: 1, finding_key: "open1", status: "open", evidence: "x" },
    { round_no: 1, finding_key: "gone1", status: "obsolete", evidence: "x" },
    { round_no: 1, finding_key: "conceded1", status: "conceded", evidence: "x" },
    { round_no: 1, finding_key: "nolink", status: "fixed", evidence: "x" },
  ]);
  return store;
}

const events = (store: StateStore, kind: string) =>
  (
    store.db
      .prepare("SELECT payload FROM events WHERE pr = 7 AND kind = ? ORDER BY id")
      .all(kind) as Array<{ payload: string }>
  ).map((r) => JSON.parse(r.payload) as Record<string, unknown>);

describe("which threads a round resolves", () => {
  it("fixed and obsolete only, by the record's thread_id; a finding with no known comment is listed apart", () => {
    const store = setup();
    const plan = priorThreadsToResolve(store, 7, 3);
    expect(plan.threads.map((t) => [t.finding_key, t.comment_id, t.status])).toEqual([
      ["fixed1", 101, "fixed"],
      ["fixed2", 102, "fixed"],
      ["gone1", 104, "obsolete"],
    ]);
    expect(plan.unlinked).toEqual(["1:nolink"]);
    // Another round's reports are not this round's.
    expect(priorThreadsToResolve(store, 4, 3).threads).toEqual([]);
    expect(priorThreadsToResolve(store, 7, 4).threads).toEqual([]);
  });

  it("prefers the outcome capture's settled link, and resolves a carried finding's earlier postings too", () => {
    const store = setup();
    store.db.exec(
      "CREATE TABLE finding_comments (comment_id INTEGER PRIMARY KEY, pr INTEGER, round_no INTEGER, finding_key TEXT)",
    );
    store.db
      .prepare("INSERT INTO finding_comments VALUES (?, ?, ?, ?)")
      .run(201, 7, 1, "fixed1");
    store.recordRoundFindings({ pr: 7, round_id: null, round_no: 0, head_sha: HEAD }, [
      finding("older", 99),
    ]);
    const earlier = earlierRefsFromSidecar(
      JSON.stringify({ findings: [{ ref: "1:fixed1", earlier_refs: ["0:older"] }] }),
    );
    const plan = priorThreadsToResolve(store, 7, 3, earlier);
    expect(plan.threads.filter((t) => t.status === "fixed").map((t) => t.comment_id)).toEqual([
      201, 99, 102,
    ]);
  });

  it("an unreadable sidecar names no earlier postings", () => {
    expect(earlierRefsFromSidecar(undefined).size).toBe(0);
    expect(earlierRefsFromSidecar("{not json").size).toBe(0);
  });
});

describe("resolving them", () => {
  it("each thread through the adapter's one resolve path; every outcome an event, never a throw", async () => {
    const store = setup();
    const calls: number[] = [];
    const adapter = {
      resolveOwnReviewThread: async (n: number, id: number) => {
        calls.push(id);
        expect(n).toBe(7);
        if (id === 101) return { skipped: null, result: { executed: true } };
        if (id === 102) return { skipped: "check-this-human-only" as const };
        if (id === 104) throw new Error("refusing: root author is someone-else");
        return { skipped: null };
      },
    };
    const tally = await resolveVerifiedPriorThreads({ store, adapter }, 7, 3);
    expect(calls).toEqual([101, 102, 104]);
    expect(tally).toEqual({ resolved: 1, skipped: 1, failed: 1, unlinked: 1 });
    expect(events(store, "prior_thread_resolved")).toEqual([
      { round_no: 3, ref: "1:fixed1", comment_id: 101, status: "fixed" },
    ]);
    expect(events(store, "prior_thread_resolve_skipped").map((e) => e.reason)).toEqual([
      "no-known-comment",
      "check-this-human-only",
    ]);
    expect(events(store, "prior_thread_resolve_failed")[0]).toMatchObject({
      comment_id: 104,
      error: "refusing: root author is someone-else",
    });
  });

  it("a gated write that did not execute (dry-run, a guard) is a skip, not a resolution", async () => {
    const store = setup();
    const adapter = {
      resolveOwnReviewThread: async () => ({
        skipped: null,
        result: { executed: false, dryRunFile: "/s/dryrun/x.json" },
      }),
    };
    const tally = await resolveVerifiedPriorThreads({ store, adapter }, 7, 3);
    expect(tally.resolved).toBe(0);
    expect(tally.skipped).toBe(3);
    expect(events(store, "prior_thread_resolved")).toEqual([]);
  });

  it("a round with nothing fixed calls nothing", async () => {
    const store = new StateStore(":memory:");
    let called = false;
    const adapter = {
      resolveOwnReviewThread: async () => {
        called = true;
        return { skipped: null };
      },
    };
    expect(await resolveVerifiedPriorThreads({ store, adapter }, 7, 3)).toEqual({
      resolved: 0,
      skipped: 0,
      failed: 0,
      unlinked: 0,
    });
    expect(called).toBe(false);
  });
});
