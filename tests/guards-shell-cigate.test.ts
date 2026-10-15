// scripts/approve-pr.sh — guard 4: red CI hard-gates APPROVE, latest run per check name.
// Part of the guards-shell suite: the real session posting scripts against a
// loopback GitHub stub, in dry-run. The rig (stub, temp home, state.db, the
// run/record helpers) and why the suite is split are in
// tests/helpers/guards-shell-rig.ts; this file owns its own stub instance.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HEAD, exec, root, useGuardsShellRig } from "./helpers/guards-shell-rig.js";

const s = useGuardsShellRig();
const { run, dryrunRecords, bodyFile } = s;

describe("scripts/approve-pr.sh — guard 4 (red CI hard-gates APPROVE)", () => {
  it("refuses the approval over a failing check and sends nothing at all", async () => {
    s.checkRuns = [
      { name: "unit", status: "completed", conclusion: "success" },
      { name: "e2e", status: "completed", conclusion: "failure" },
    ];
    const res = await run("approve-pr.sh", ["5180", bodyFile()]);
    expect(res.ok).toBe(false);
    expect(res.out).toContain("APPROVE is unavailable");
    expect(res.out).toContain("post-review.sh"); // it says what to do instead
    expect(dryrunRecords()).toEqual([]);
  });

  it("refuses identically for an infra cancellation — no special-casing", async () => {
    s.checkRuns = [{ name: "unit", status: "completed", conclusion: "cancelled" }];
    const res = await run("approve-pr.sh", ["5180", bodyFile()]);
    expect(res.ok).toBe(false);
    expect(res.out).toContain("CI is red");
  });

  it("refuses while a check is still running", async () => {
    s.checkRuns = [{ name: "unit", status: "in_progress", conclusion: null }];
    const res = await run("approve-pr.sh", ["5180", bodyFile()]);
    expect(res.ok).toBe(false);
    expect(res.out).toContain("CI is pending");
  });

  it("lets a green suite through — the three approval records still appear", async () => {
    const res = await run("approve-pr.sh", ["5180", bodyFile()]);
    expect(res.ok).toBe(true);
    expect(dryrunRecords()).toHaveLength(3);
  });

  // Parity with classifyCi's latest-run-per-name rule.
  it("ignores a cancelled husk when a newer run of the same name succeeded", async () => {
    s.checkRuns = [
      {
        name: "sync",
        status: "completed",
        conclusion: "cancelled",
        started_at: "2026-08-19T08:00:00Z",
      },
      {
        name: "sync",
        status: "completed",
        conclusion: "cancelled",
        started_at: "2026-08-19T08:05:00Z",
      },
      {
        name: "sync",
        status: "completed",
        conclusion: "success",
        started_at: "2026-08-19T08:10:00Z",
      },
    ];
    const res = await run("approve-pr.sh", ["5180", bodyFile()]);
    expect(res.ok).toBe(true);
  });

  it("still refuses when the LATEST run of a name was cancelled", async () => {
    s.checkRuns = [
      {
        name: "sync",
        status: "completed",
        conclusion: "success",
        started_at: "2026-08-19T08:00:00Z",
      },
      {
        name: "sync",
        status: "completed",
        conclusion: "cancelled",
        started_at: "2026-08-19T08:10:00Z",
      },
    ];
    const res = await run("approve-pr.sh", ["5180", bodyFile()]);
    expect(res.ok).toBe(false);
    expect(res.out).toContain("CI is red");
  });

  // A commit status under a check-run's name is a second check, never
  // collapsed with the run. These pin the shell side of that parity with the
  // gate's classifier.
  it.each([
    ["failure", "CI is red"],
    ["error", "CI is red"],
    ["pending", "CI is pending"],
  ])(
    "refuses over a %s commit status that shares a passing check-run's name",
    async (state, message) => {
      s.checkRuns = [
        {
          name: "ci",
          status: "completed",
          conclusion: "success",
          started_at: "2026-09-01T10:00:00Z",
        },
      ];
      s.statuses = [{ context: "ci", state }];
      const res = await run("approve-pr.sh", ["5180", bodyFile()]);
      expect(res.ok).toBe(false);
      expect(res.out).toContain(message);
      expect(dryrunRecords()).toEqual([]);
    },
  );

  it("a queued run with a null started_at is pending, not green off the older completed run of its name", async () => {
    s.checkRuns = [
      {
        name: "ci",
        status: "completed",
        conclusion: "success",
        started_at: "2026-09-01T10:00:00Z",
      },
      { name: "ci", status: "queued", conclusion: null, started_at: null },
    ];
    const res = await run("approve-pr.sh", ["5180", bodyFile()]);
    expect(res.ok).toBe(false);
    expect(res.out).toContain("CI is pending");
  });

  it.each([
    ["queued", null, "CI is pending"],
    ["completed", "failure", "CI is red"],
  ] as const)(
    "a %s/%s check-run with a null started_at is never masked by a passing status of its name",
    async (status, conclusion, message) => {
      // An untimestamped run is never collapsed with the same-named status:
      // collapsing them would read green here.
      s.checkRuns = [{ name: "ci", status, conclusion, started_at: null }];
      s.statuses = [{ context: "ci", state: "success" }];
      const res = await run("approve-pr.sh", ["5180", bodyFile()]);
      expect(res.ok).toBe(false);
      expect(res.out).toContain(message);
      expect(dryrunRecords()).toEqual([]);
    },
  );

  it("a passing status beside a passing run of its name still approves", async () => {
    s.checkRuns = [
      {
        name: "ci",
        status: "completed",
        conclusion: "success",
        started_at: "2026-09-01T10:00:00Z",
      },
    ];
    s.statuses = [{ context: "ci", state: "success" }];
    const res = await run("approve-pr.sh", ["5180", bodyFile()]);
    expect(res.ok).toBe(true);
  });

  // Parity with no_checks_is_red.
  it("refuses a zero-checks head when no_checks_is_red is on; allows it when off", async () => {
    s.checkRuns = [];
    const base = readFileSync(join(s.dir, "config.toml"), "utf8");
    writeFileSync(join(s.dir, "config.toml"), `${base}\n[guards]\nno_checks_is_red = true\n`);
    const refused = await run("approve-pr.sh", ["5180", bodyFile()]);
    expect(refused.ok).toBe(false);
    expect(refused.out).toContain("no CI has run");
    writeFileSync(join(s.dir, "config.toml"), base);
    const allowed = await run("approve-pr.sh", ["5180", bodyFile()]);
    expect(allowed.ok).toBe(true);
  });

  // A receipt-keyed approval snapshots its input into the posting outbox
  // before the guard reads. A guard-4 refusal must take that snapshot back:
  // the session's prescribed follow-up is a COMMENT under the same round key,
  // and a pending APPROVE job would both refuse that COMMENT ("refusing to
  // change queued review input") and be delivered by the daemon's outbox once
  // CI turned green.
  it.each([
    ["red", [{ name: "unit", status: "completed", conclusion: "failure" }]],
    ["pending", [{ name: "unit", status: "in_progress", conclusion: null }]],
  ] as const)(
    "a %s-CI refusal leaves no queued APPROVE, so the withheld COMMENT posts under the same key",
    async (_state, checkRuns) => {
      s.checkRuns = [...checkRuns];
      const receipts = join(s.dir, "receipts");
      const env = {
        QCR_EXPECTED_HEAD: HEAD,
        QCR_ROUND_NO: "31",
        QCR_POSTING_RECEIPT_DIR: receipts,
      };
      const refused = await run("approve-pr.sh", ["5180", bodyFile()], env);
      expect(refused.ok).toBe(false);
      expect(refused.out).toContain("APPROVE is unavailable");
      expect(existsSync(join(receipts, "pr-5180-round-31.outbox.json"))).toBe(false);
      expect(existsSync(join(receipts, "pr-5180-round-31.json"))).toBe(false);
      expect(existsSync(join(receipts, "pr-5180-round-31.json.lock"))).toBe(false);
      // The withdrawn snapshot is kept beside the receipts as evidence, under a
      // name no outbox reader picks up.
      expect(
        readdirSync(receipts).filter((n) => n.includes(".outbox.json.withdrawn-")),
      ).toHaveLength(1);

      const comment = await run("post-review.sh", ["5180", "COMMENT", bodyFile()], env);
      expect(comment.ok, comment.out).toBe(true);
      const job = JSON.parse(readFileSync(join(receipts, "pr-5180-round-31.outbox.json"), "utf8"));
      expect(job).toMatchObject({ intended_event: "COMMENT", payload: { event: "COMMENT" } });
      expect(
        JSON.parse(readFileSync(join(receipts, "pr-5180-round-31.json"), "utf8")),
      ).toMatchObject({ status: "dryrun", actual_event: "COMMENT" });
      expect(dryrunRecords()).toHaveLength(1);
    },
  );

  it("a withdrawal never touches a job whose posting was already attempted", async () => {
    const receipts = join(s.dir, "receipts");
    const receipt = join(receipts, "pr-5180-round-32.json");
    const key = `v1:5180:32:${HEAD}`;
    const helper = join(root, "scripts", "posting-receipt.py");
    const body = bodyFile();
    await exec("python3", [
      helper,
      "enqueue",
      join(receipts, "pr-5180-round-32.outbox.json"),
      key,
      "5180",
      "32",
      HEAD,
      "APPROVE",
      "exampleorg/example-app",
      "live",
      body,
      "",
    ]);
    await exec("python3", [
      helper,
      "prepare",
      receipt,
      key,
      "5180",
      "32",
      HEAD,
      "APPROVE",
      "APPROVE",
      '{"event":"APPROVE"}',
    ]);
    await expect(exec("python3", [helper, "withdraw", receipt, key])).rejects.toThrow(/attempted/);
    expect(
      JSON.parse(readFileSync(join(receipts, "pr-5180-round-32.outbox.json"), "utf8")),
    ).toMatchObject({ status: "pending", posting_key: key });
  });

  it("posting the withheld review as a COMMENT is never refused by this guard", async () => {
    s.checkRuns = [{ name: "unit", status: "completed", conclusion: "failure" }];
    const res = await run("post-review.sh", ["5180", "COMMENT", bodyFile()]);
    expect(res.ok).toBe(true);
    expect(dryrunRecords()).toHaveLength(1);
  });
});
