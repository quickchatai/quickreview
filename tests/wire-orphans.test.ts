// The production startup orphan sweep (wire.ts onStart): a round whose
// session did not survive a restart is cancelled and requeued, EXCEPT one
// whose finished review the outbox still owes GitHub — that debt is delivered
// without any session, and cancelling the round would make the outbox abandon
// it and run the lenses again.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PostingJob } from "../src/posting-outbox.js";
import { postingMarker, roundPostingKey } from "../src/posting-receipt.js";
import { reconcileOrphanedRounds } from "../src/reconcile.js";
import { StateStore } from "../src/state.js";
import { orphanPostingOwed } from "../src/wire.js";

let dir: string;
let store: StateStore;
const head = "a".repeat(40);

function upsertReviewing(n: number): void {
  store.upsertPr({
    number: n,
    state: "reviewing",
    head_sha: head,
    title: `PR ${n}`,
    author: "alice",
    trigger_ts: null,
    stale_recheck: 0,
    migration_gate: 0,
  });
}

function writeJob(
  pr: number,
  roundNo: number,
  key: string,
  status: PostingJob["status"],
  over: Partial<Pick<PostingJob, "mode" | "repo">> = {},
): void {
  const payload = {
    commit_id: head,
    event: "COMMENT" as const,
    body: `R\n\n${postingMarker(key)}`,
  };
  const job: PostingJob = {
    version: 1,
    posting_key: key,
    repo: "org/repo",
    mode: "live",
    pr,
    round_no: roundNo,
    head_sha: head,
    intended_event: "COMMENT",
    payload,
    payload_sha256: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
    status,
    attempts: 0,
    next_attempt_at: "2026-10-12T10:30:00.000Z",
    created_at: "2026-10-12T10:00:00.000Z",
    ...over,
  };
  writeFileSync(join(dir, `pr-${pr}-round-${roundNo}.outbox.json`), JSON.stringify(job));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-wire-orphans-"));
  store = new StateStore(":memory:");
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("startup orphan sweep with the production posting-debt predicate", () => {
  it("keeps a sessionless round whose review posting is still pending, and cancels the rest", () => {
    upsertReviewing(30);
    upsertReviewing(31);
    const owedId = store.startRound(30, "first", ["pass-baseline"], 75);
    const lostId = store.startRound(31, "first", ["pass-baseline"], 75);
    const owedKey = roundPostingKey(30, 1, head);
    store.stampPostingKey(owedId, owedKey);
    store.stampPostingKey(lostId, roundPostingKey(31, 1, head));
    writeJob(30, 1, owedKey, "pending");

    const res = reconcileOrphanedRounds(store, [], {
      postingOwed: orphanPostingOwed(dir, false, "org/repo"),
    });

    expect(res.kept_for_posting).toEqual([30]);
    expect(res.cancelled).toEqual([31]);
    expect(res.requeued).toEqual([31]);
    // The owed round keeps running (the outbox's `owed` reads exactly this)
    // and its PR stays reviewing — no second review round is queued.
    expect(store.runningRounds().map((r) => r.id)).toEqual([owedId]);
    expect(store.getPr(30)!.state).toBe("reviewing");
    expect(
      store.db
        .prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'orphaned_round_posting_owed'")
        .get(),
    ).toEqual({ n: 1 });
  });

  it("a delivered (done) job, a job for another posting key, or a dry run owes nothing", () => {
    const owed = orphanPostingOwed(dir, false, "org/repo");
    const key = roundPostingKey(40, 1, head);
    writeJob(40, 1, key, "done");
    expect(owed({ pr: 40, round_no: 1, posting_key: key })).toBe(false);
    writeJob(40, 1, key, "pending");
    expect(owed({ pr: 40, round_no: 1, posting_key: key })).toBe(true);
    expect(owed({ pr: 40, round_no: 1, posting_key: roundPostingKey(40, 1, "b".repeat(40)) })).toBe(
      false,
    );
    expect(owed({ pr: 40, round_no: 1, posting_key: null })).toBe(false);
    expect(
      orphanPostingOwed(dir, true, "org/repo")({ pr: 40, round_no: 1, posting_key: key }),
    ).toBe(false);
  });

  it("keeps a sessionless round whose review is posted (confirmed receipt) but unsettled, in either mode", () => {
    upsertReviewing(60);
    const id = store.startRound(60, "first", ["pass-baseline"], 75);
    const key = roundPostingKey(60, 1, head);
    store.stampPostingKey(id, key);
    writeJob(60, 1, key, "done");
    const receipt = (over: Record<string, unknown> = {}) =>
      writeFileSync(
        join(dir, "pr-60-round-1.json"),
        JSON.stringify({
          version: 1,
          posting_key: key,
          marker: postingMarker(key),
          pr: 60,
          round_no: 1,
          head_sha: head,
          intended_event: "REQUEST_CHANGES",
          actual_event: "REQUEST_CHANGES",
          status: "confirmed",
          payload_sha256: "c".repeat(64),
          prepared_at: "2026-10-12T10:00:00.000Z",
          confirmed_at: "2026-10-12T10:00:05.000Z",
          gh_review_id: 9001,
          gh_commit_id: head,
          gh_state: "CHANGES_REQUESTED",
          ...over,
        }),
      );
    const owed = orphanPostingOwed(dir, false, "org/repo");
    receipt({ status: "prepared", confirmed_at: undefined, gh_review_id: undefined });
    expect(owed({ pr: 60, round_no: 1, posting_key: key })).toBe(false);
    receipt({ posting_key: roundPostingKey(60, 1, "b".repeat(40)) });
    expect(owed({ pr: 60, round_no: 1, posting_key: key })).toBe(false);
    receipt();
    expect(owed({ pr: 60, round_no: 1, posting_key: key })).toBe(true);
    expect(
      orphanPostingOwed(dir, true, "org/repo")({ pr: 60, round_no: 1, posting_key: key }),
    ).toBe(true);

    const res = reconcileOrphanedRounds(store, [], { botLogin: "bot[bot]", postingOwed: owed });
    expect(res.kept_for_posting).toEqual([60]);
    expect(res.cancelled).toEqual([]);
    expect(res.requeued).toEqual([]);
    expect(store.runningRounds().map((r) => r.id)).toEqual([id]);
  });

  // The outbox processes only live jobs of its own repo. A pending job outside
  // that — a dry-run snapshot left over a flip to live, another repo's — is
  // never delivered, so its round is an ordinary orphan: cancelled and
  // requeued, never held until the operator's `u`.
  it.each([
    ["a dry-run snapshot", { mode: "dryrun" as const }],
    ["another repo's job", { repo: "org/other" }],
  ])("a pending job the outbox will never process owes nothing: %s", (_label, over) => {
    upsertReviewing(50);
    const id = store.startRound(50, "first", ["pass-baseline"], 75);
    const key = roundPostingKey(50, 1, head);
    store.stampPostingKey(id, key);
    writeJob(50, 1, key, "pending", over);

    expect(
      orphanPostingOwed(dir, false, "org/repo")({ pr: 50, round_no: 1, posting_key: key }),
    ).toBe(false);
    const res = reconcileOrphanedRounds(store, [], {
      postingOwed: orphanPostingOwed(dir, false, "org/repo"),
    });
    expect(res.kept_for_posting).toEqual([]);
    expect(res.cancelled).toEqual([50]);
    expect(res.requeued).toEqual([50]);
  });
});
