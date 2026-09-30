// Guard 3 on every posting script — approve-pr.sh, post-review.sh and reply-thread.sh refuse a merged or closed PR.
// Part of the guards-shell suite: the real session posting scripts against a
// loopback GitHub stub, in dry-run. The rig (stub, temp home, state.db, the
// run/record helpers) and why the suite is split are in
// tests/helpers/guards-shell-rig.ts; this file owns its own stub instance.
import { describe, expect, it } from "vitest";
import { useGuardsShellRig } from "./helpers/guards-shell-rig.js";

const s = useGuardsShellRig();
const { run, dryrunRecords, bodyFile } = s;

describe("scripts/approve-pr.sh — guard 3", () => {
  it("refuses to approve a merged PR and records no mutation at all", async () => {
    s.pr = { state: "closed", merged: true };
    const res = await run("approve-pr.sh", ["5180", bodyFile()]);
    expect(res.ok).toBe(false);
    expect(res.out).toContain("already merged");
    expect(dryrunRecords()).toEqual([]);
  });

  it("refuses to approve a closed PR", async () => {
    s.pr = { state: "closed", merged: false };
    const res = await run("approve-pr.sh", ["5180", bodyFile()]);
    expect(res.ok).toBe(false);
    expect(res.out).toContain("is closed");
    expect(dryrunRecords()).toEqual([]);
  });

  it("proceeds on an open PR — the three dry-run records still appear", async () => {
    const res = await run("approve-pr.sh", ["5180", bodyFile()]);
    expect(res.ok).toBe(true);
    const kinds = dryrunRecords().map((f) => f.replace(/^.*-(?=[a-z])/, ""));
    expect(kinds.sort()).toEqual([
      "create_review.json",
      "delete_team_review_request.json",
      "remove_label.json",
    ]);
  });
});

describe("scripts/post-review.sh — guard 3", () => {
  it("refuses to post onto a merged PR", async () => {
    s.pr = { state: "closed", merged: true };
    const res = await run("post-review.sh", ["5180", "REQUEST_CHANGES", bodyFile()]);
    expect(res.ok).toBe(false);
    expect(res.out).toContain("already merged");
    expect(dryrunRecords()).toEqual([]);
  });

  it("posts on an open PR", async () => {
    const res = await run("post-review.sh", ["5180", "COMMENT", bodyFile()]);
    expect(res.ok).toBe(true);
    expect(dryrunRecords()).toHaveLength(1);
  });

  it("continues in dry-run when the state cannot be read (nothing is sent anyway)", async () => {
    s.pr = null; // the stub 404s
    const res = await run("post-review.sh", ["5180", "COMMENT", bodyFile()]);
    expect(res.ok).toBe(true);
    expect(res.out).toContain("unreadable");
    expect(dryrunRecords()).toHaveLength(1);
  });
});

describe("scripts/reply-thread.sh — guard 3", () => {
  it("refuses to reply on a merged PR", async () => {
    s.pr = { state: "closed", merged: true };
    const res = await run("reply-thread.sh", ["5180", "12345", bodyFile()]);
    expect(res.ok).toBe(false);
    expect(res.out).toContain("already merged");
    expect(dryrunRecords()).toEqual([]);
  });

  it("replies on an open PR", async () => {
    const res = await run("reply-thread.sh", ["5180", "12345", bodyFile()]);
    expect(res.ok).toBe(true);
    expect(dryrunRecords()).toHaveLength(1);
  });
});
