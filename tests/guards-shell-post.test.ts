// scripts/post-review.sh — guard 1 (a human approval at this head) and guard 2 (no new evidence).
// Part of the guards-shell suite: the real session posting scripts against a
// loopback GitHub stub, in dry-run. The rig (stub, temp home, state.db, the
// run/record helpers) and why the suite is split are in
// tests/helpers/guards-shell-rig.ts; this file owns its own stub instance.
import { describe, expect, it } from "vitest";
import { StateStore } from "../src/state.js";
import { HEAD, useGuardsShellRig } from "./helpers/guards-shell-rig.js";

const s = useGuardsShellRig();
const { run, dryrunRecords, record, bodyFile } = s;

describe("scripts/post-review.sh — guard 1 (human approval at this head)", () => {
  it("downgrades REQUEST_CHANGES to COMMENT and keeps the findings", async () => {
    s.reviews = [{ id: 1, user: { login: "mhale" }, state: "APPROVED", commit_id: HEAD }];
    const res = await run("post-review.sh", ["5180", "REQUEST_CHANGES", bodyFile()]);
    expect(res.ok).toBe(true);
    const rec = record();
    expect(rec.body.event).toBe("COMMENT");
    expect(rec.body.body).toContain("Automated review body."); // findings intact
    expect(rec.body.body).toContain("@mhale");
    expect(rec.body.commit_id).toBe(HEAD);
    expect(rec.note).toContain("downgraded");
  });

  it("leaves REQUEST_CHANGES alone when the approval is on an older head", async () => {
    s.reviews = [{ id: 1, user: { login: "mhale" }, state: "APPROVED", commit_id: "0ldhead" }];
    const res = await run("post-review.sh", ["5180", "REQUEST_CHANGES", bodyFile()]);
    expect(res.ok).toBe(true);
    expect(record().body.event).toBe("REQUEST_CHANGES");
  });

  it("ignores the bot's own approval and the PR author's", async () => {
    s.reviews = [
      { id: 1, user: { login: "example-review[bot]" }, state: "APPROVED", commit_id: HEAD },
      { id: 2, user: { login: "pr-author" }, state: "APPROVED", commit_id: HEAD },
    ];
    const res = await run("post-review.sh", ["5180", "REQUEST_CHANGES", bodyFile()]);
    expect(res.ok).toBe(true);
    expect(record().body.event).toBe("REQUEST_CHANGES");
  });

  it("sees a human approval past the first 100 reviews (selfscan 91382fae)", async () => {
    // Reviews are oldest-first and every bot thread reply is one, so on a long
    // PR the approval at the current head lives on page 2 or later.
    s.reviews = [
      ...Array.from({ length: 120 }, (_, i) => ({
        id: i + 1,
        user: { login: "example-review[bot]" },
        state: "COMMENTED",
        commit_id: "0ldhead",
      })),
      { id: 500, user: { login: "mhale" }, state: "APPROVED", commit_id: HEAD },
    ];
    const res = await run("post-review.sh", ["5180", "REQUEST_CHANGES", bodyFile()]);
    expect(res.ok).toBe(true);
    expect(record().body.event).toBe("COMMENT");
    expect(record().body.body).toContain("@mhale");
  });

  it("reads every page, with no page bound, as listReviews does", async () => {
    // 3,050 earlier reviews fill 30 full pages; the approval is on page 31.
    s.reviews = [
      ...Array.from({ length: 3050 }, (_, i) => ({
        id: i + 1,
        user: { login: "example-review[bot]" },
        state: "COMMENTED",
        commit_id: "0ldhead",
      })),
      { id: 5000, user: { login: "mhale" }, state: "APPROVED", commit_id: HEAD },
    ];
    const res = await run("post-review.sh", ["5180", "REQUEST_CHANGES", bodyFile()]);
    expect(res.ok).toBe(true);
    expect(record().body.event).toBe("COMMENT");
    expect(record().body.body).toContain("@mhale");
  });

  it("ignores an approval the same human has since retired", async () => {
    s.reviews = [
      { id: 1, user: { login: "mhale" }, state: "APPROVED", commit_id: HEAD },
      { id: 2, user: { login: "mhale" }, state: "CHANGES_REQUESTED", commit_id: HEAD },
    ];
    const res = await run("post-review.sh", ["5180", "REQUEST_CHANGES", bodyFile()]);
    expect(res.ok).toBe(true);
    expect(record().body.event).toBe("REQUEST_CHANGES");
  });
});

describe("scripts/post-review.sh — guard 2 (no new evidence)", () => {
  it("refuses a second review of the same head with no author reply since", async () => {
    const store = new StateStore(s.dbPath);
    store.recordReviewedHead(5180, { head_sha: HEAD, verdict: "REQUEST_CHANGES" });
    store.close();
    const res = await run("post-review.sh", ["5180", "COMMENT", bodyFile()]);
    expect(res.ok).toBe(false);
    expect(res.out).toContain("guard 2");
    expect(dryrunRecords()).toEqual([]);
  });

  it("allows it again once the author has replied", async () => {
    const store = new StateStore(s.dbPath);
    store.recordReviewedHead(5180, { head_sha: HEAD, verdict: "REQUEST_CHANGES" });
    store.noteAuthorReply(5180, "2099-01-01T00:00:00.000Z");
    store.close();
    const res = await run("post-review.sh", ["5180", "COMMENT", bodyFile()]);
    expect(res.ok).toBe(true);
    expect(dryrunRecords()).toHaveLength(1);
  });

  it("allows it on a new head", async () => {
    const store = new StateStore(s.dbPath);
    store.recordReviewedHead(5180, { head_sha: "an0therhead", verdict: "REQUEST_CHANGES" });
    store.close();
    const res = await run("post-review.sh", ["5180", "COMMENT", bodyFile()]);
    expect(res.ok).toBe(true);
    expect(dryrunRecords()).toHaveLength(1);
  });

  it("posts when there is no mark at all (and dry-run stamps none)", async () => {
    const res = await run("post-review.sh", ["5180", "COMMENT", bodyFile()]);
    expect(res.ok).toBe(true);
    const store = new StateStore(s.dbPath);
    expect(store.reviewedHead(5180)).toBeUndefined();
    store.close();
  });
});
