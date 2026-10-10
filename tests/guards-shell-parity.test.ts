// Guard 2 on both routes (src/guards.ts vs scripts/guards.sh, one case table) and the shell's reviewed-head stamp.
// Part of the guards-shell suite: the real session posting scripts against a
// loopback GitHub stub, in dry-run. The rig (stub, temp home, state.db, the
// run/record helpers) and why the suite is split are in
// tests/helpers/guards-shell-rig.ts; this file owns its own stub instance.
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { StateStore } from "../src/state.js";
import { hasNewEvidence } from "../src/guards.js";
import { HEAD, exec, root, useGuardsShellRig } from "./helpers/guards-shell-rig.js";

const s = useGuardsShellRig();
const { run, dryrunRecords, bodyFile } = s;

/**
 * Guard 2 on both routes, pinned by the same table.
 *
 * `src/guards.ts hasNewEvidence` and `scripts/guards.sh` — the route the
 * sessions actually post through — must apply the same rule, including the
 * undecided carve-out: a NEEDS_HUMAN/ESCALATE mark is an undecided review and
 * never suppresses a re-run or a posting.
 *
 * Drift between the twins is the bug class, so this asserts them together: one
 * case list, each case run through the TypeScript predicate and through the
 * real `post-review.sh`, with the two answers required to agree. Asserting each
 * side separately would let them drift.
 */
describe("guard 2 parity — src/guards.ts and scripts/guards.sh answer identically", () => {
  interface Case {
    what: string;
    /** The stored mark, or null for "no mark at all". */
    mark: { head_sha: string; verdict: string | null; reply_at?: string } | null;
    /** Is there new evidence at HEAD — i.e. may the review post? */
    newEvidence: boolean;
  }

  const cases: Case[] = [
    {
      what: "same head, decided, no author reply",
      mark: { head_sha: HEAD, verdict: "REQUEST_CHANGES" },
      newEvidence: false,
    },
    {
      what: "same head, APPROVE, no author reply",
      mark: { head_sha: HEAD, verdict: "APPROVE" },
      newEvidence: false,
    },
    // The carve-out. Undecided is not reviewed-and-decided.
    {
      what: "same head, NEEDS_HUMAN — undecided is not reviewed",
      mark: { head_sha: HEAD, verdict: "NEEDS_HUMAN" },
      newEvidence: true,
    },
    // The retired spelling still on disk in older rows; normalizeVerdict folds
    // it, so the shell must fold it too.
    {
      what: "same head, legacy ESCALATE spelling",
      mark: { head_sha: HEAD, verdict: "ESCALATE" },
      newEvidence: true,
    },
    {
      what: "same head, undecided in lower case",
      mark: { head_sha: HEAD, verdict: "needs_human" },
      newEvidence: true,
    },
    {
      what: "a different head",
      mark: { head_sha: "an0therhead", verdict: "REQUEST_CHANGES" },
      newEvidence: true,
    },
    {
      what: "same head with an author reply since",
      mark: { head_sha: HEAD, verdict: "REQUEST_CHANGES", reply_at: "2099-01-01T00:00:00.000Z" },
      newEvidence: true,
    },
    {
      what: "same head, verdict column null (a legacy row)",
      mark: { head_sha: HEAD, verdict: null },
      newEvidence: false,
    },
    { what: "no mark at all", mark: null, newEvidence: true },
  ];

  for (const c of cases) {
    it(`${c.what} → ${c.newEvidence ? "posts" : "refused"} on both routes`, async () => {
      const store = new StateStore(s.dbPath);
      if (c.mark) {
        store.recordReviewedHead(5180, { head_sha: c.mark.head_sha, verdict: c.mark.verdict });
        if (c.mark.reply_at) store.noteAuthorReply(5180, c.mark.reply_at);
      }
      // --- the TypeScript route ---
      const ts = hasNewEvidence(store.reviewedHead(5180), HEAD);
      store.close();
      expect(ts, "src/guards.ts hasNewEvidence").toBe(c.newEvidence);

      // --- the shell route the sessions actually post through ---
      const res = await run("post-review.sh", ["5180", "COMMENT", bodyFile()]);
      expect(res.ok, `scripts/guards.sh guard 2 (${res.out})`).toBe(c.newEvidence);
      if (!c.newEvidence) {
        expect(res.out).toContain("guard 2");
        expect(dryrunRecords()).toEqual([]);
      } else {
        expect(dryrunRecords()).toHaveLength(1);
      }

      // --- and the two agree ---
      expect(res.ok, "the shell twin must answer exactly what hasNewEvidence answers").toBe(ts);
    });
  }
});

describe("scripts/guards.sh — the reviewed-head stamp", () => {
  // The live route stamps the mark itself (the gate's after-step covers only
  // the daemon's route), so the stamp is exercised directly: the shell writes
  // a row src/state.ts reads back, with recordReviewedHead's semantics.
  async function stamp(head: string, event: string): Promise<void> {
    const script = [
      `ROOT=${JSON.stringify(root)}`,
      "API=http://127.0.0.1:1 CONFIG=/dev/null REPO=o/r PR=5180 LIVE=1",
      'die() { echo "$*" >&2; exit 1; }',
      "cfg() { :; }",
      `. ${JSON.stringify(join(root, "scripts", "guards.sh"))}`,
      `guard_stamp_reviewed_head ${JSON.stringify(head)} ${JSON.stringify(event)}`,
    ].join("\n");
    await exec("bash", ["-c", script], { env: { ...process.env, QCR_STATE_DB: s.dbPath } });
  }

  it("records the head that was really posted, keeping the verdict on a re-stamp", async () => {
    const store = new StateStore(s.dbPath);
    store.recordReviewedHead(5180, { head_sha: HEAD, verdict: "REQUEST_CHANGES", round_no: 2 });
    store.noteAuthorReply(5180, "2099-01-01T00:00:00.000Z");
    store.close();

    await stamp(HEAD, "COMMENT");
    const after = new StateStore(s.dbPath);
    expect(after.reviewedHead(5180)).toMatchObject({
      head_sha: HEAD,
      verdict: "REQUEST_CHANGES", // same head ⇒ kept
      round_no: 2,
      posted_event: "COMMENT",
      last_author_reply_at: null, // the reply has now been answered
    });
    after.close();
  });

  it("replaces the row wholesale on a new head", async () => {
    const store = new StateStore(s.dbPath);
    store.recordReviewedHead(5180, {
      head_sha: "0ldhead",
      verdict: "REQUEST_CHANGES",
      round_no: 1,
    });
    store.close();

    await stamp(HEAD, "REQUEST_CHANGES");
    const after = new StateStore(s.dbPath);
    expect(after.reviewedHead(5180)).toMatchObject({
      head_sha: HEAD,
      verdict: null,
      round_no: null,
    });
    after.close();
  });
});
