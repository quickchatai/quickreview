// Guard 5 — QCR_EXPECTED_HEAD posting-head drift on post-review.sh and approve-pr.sh.
// Part of the guards-shell suite: the real session posting scripts against a
// loopback GitHub stub, in dry-run. The rig (stub, temp home, state.db, the
// run/record helpers) and why the suite is split are in
// tests/helpers/guards-shell-rig.ts; this file owns its own stub instance.
import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HEAD, useGuardsShellRig } from "./helpers/guards-shell-rig.js";

const s = useGuardsShellRig();
const { run, dryrunRecords, record, bodyFile } = s;

describe("guard 5 — QCR_EXPECTED_HEAD (posting-head drift)", () => {
  const MOVED = "5b71a80ffee0987654321fedcba09876543210ab";

  it("post-review.sh posts when the expectation matches the live head", async () => {
    const res = await run("post-review.sh", ["5180", "COMMENT", bodyFile()], {
      QCR_EXPECTED_HEAD: HEAD,
    });
    expect(res.ok).toBe(true);
    expect(record().body.commit_id).toBe(HEAD);
  });

  it("post-review.sh refuses when the PR advanced past the reviewed head, exit 1, nothing recorded", async () => {
    s.pr = { state: "open", merged: false, head: { sha: MOVED }, user: { login: "pr-author" } };
    const res = await run("post-review.sh", ["5180", "REQUEST_CHANGES", bodyFile()], {
      QCR_EXPECTED_HEAD: HEAD,
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe(1);
    expect(res.out).toContain("head moved");
    expect(res.out).toContain("guard 5");
    // The message tells the session what to do: post nothing further and land
    // the round through the head_moved verdict-file outcome.
    expect(res.out).toContain("Post nothing further");
    expect(res.out).toContain("head_moved");
    expect(res.out).toContain("daemon");
    expect(dryrunRecords()).toEqual([]);
  });

  it("post-review.sh warns loudly but proceeds when no expectation is set (older prompts)", async () => {
    const res = await run("post-review.sh", ["5180", "COMMENT", bodyFile()]);
    expect(res.ok).toBe(true);
    expect(res.out).toContain("WARNING");
    expect(res.out).toContain("QCR_EXPECTED_HEAD");
    expect(dryrunRecords()).toHaveLength(1);
  });

  it("approve-pr.sh refuses on a moved head before anything is recorded", async () => {
    s.pr = { state: "open", merged: false, head: { sha: MOVED }, user: { login: "pr-author" } };
    const res = await run("approve-pr.sh", ["5180", bodyFile()], { QCR_EXPECTED_HEAD: HEAD });
    expect(res.ok).toBe(false);
    expect(res.code).toBe(1);
    expect(res.out).toContain("head moved");
    expect(dryrunRecords()).toEqual([]);
  });

  it("approve-pr.sh approves when the expectation matches", async () => {
    const res = await run("approve-pr.sh", ["5180", bodyFile()], { QCR_EXPECTED_HEAD: HEAD });
    expect(res.ok).toBe(true);
    expect(dryrunRecords()).toHaveLength(3);
  });

  it("approve-pr.sh warns but proceeds when no expectation is set", async () => {
    const res = await run("approve-pr.sh", ["5180", bodyFile()]);
    expect(res.ok).toBe(true);
    expect(res.out).toContain("WARNING");
  });

  it("a case-only sha difference is not drift", async () => {
    const res = await run("post-review.sh", ["5180", "COMMENT", bodyFile()], {
      QCR_EXPECTED_HEAD: HEAD.toUpperCase(),
    });
    expect(res.ok).toBe(true);
  });

  it("is off when [guards] refuse_on_head_drift = false", async () => {
    s.pr = { state: "open", merged: false, head: { sha: MOVED }, user: { login: "pr-author" } };
    const base = readFileSync(join(s.dir, "config.toml"), "utf8");
    writeFileSync(join(s.dir, "config.toml"), `${base}\n[guards]\nrefuse_on_head_drift = false\n`);
    const res = await run("post-review.sh", ["5180", "COMMENT", bodyFile()], {
      QCR_EXPECTED_HEAD: HEAD,
    });
    expect(res.ok).toBe(true);
  });
});
