import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { completeRecordedFindings } from "../src/recordedfindings.js";
import { LessonLedger } from "../src/lessonledger.js";
import { StateStore, type RoundFindingInput } from "../src/state.js";

let store: StateStore;
beforeEach(() => {
  store = new StateStore(":memory:");
});
afterEach(() => store.close());

describe("production recorded-findings completion", () => {
  it("retains the obligation while the boot lesson ledger is unavailable", async () => {
    await expect(
      completeRecordedFindings(
        {
          store,
          ledger: null,
          adapter: {
            async resolveOwnReviewThread() {
              return { skipped: null, result: { executed: true } };
            },
          },
        },
        { pr: 7, roundNo: 3 },
      ),
    ).rejects.toThrow("not ready");
  });

  it("does not complete before the prior-thread consumer has finished", async () => {
    store.recordRoundFindings({ pr: 7, round_id: null, round_no: 1, head_sha: "head" }, [
      {
        key: "one",
        path: "a.py",
        line: 1,
        lens: "pass-baseline",
        severity: "P1",
        disposition: "posted",
        posted_as: "blocker",
        thread_id: 101,
      } as RoundFindingInput,
    ]);
    store.recordPriorReports(7, 3, "head", [
      { round_no: 1, finding_key: "one", status: "fixed", evidence: "fixed" },
    ]);
    let release!: () => void;
    let reached!: () => void;
    const started = new Promise<void>((r) => {
      reached = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let finished = false;
    const completion = completeRecordedFindings(
      {
        store,
        ledger: new LessonLedger(store),
        adapter: {
          async resolveOwnReviewThread() {
            reached();
            await gate;
            return { skipped: null, result: { executed: true } };
          },
        },
      },
      { pr: 7, roundNo: 3 },
    ).then(() => {
      finished = true;
    });
    await started;
    await Promise.resolve();
    const premature = finished;
    release();
    await completion;
    expect(premature).toBe(false);
    expect(finished).toBe(true);
  });
});
