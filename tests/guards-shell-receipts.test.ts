// Posting receipts: the deterministic marker, the keyed receipt, and idempotent retries on both posting scripts.
// Part of the guards-shell suite: the real session posting scripts against a
// loopback GitHub stub, in dry-run. The rig (stub, temp home, state.db, the
// run/record helpers) and why the suite is split are in
// tests/helpers/guards-shell-rig.ts; this file owns its own stub instance.
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HEAD, exec, root, useGuardsShellRig } from "./helpers/guards-shell-rig.js";

const s = useGuardsShellRig();
const inlineComments = [
  { path: "src/example.ts", line: 12, side: "RIGHT", body: "Optional improvement." },
];
const { run, dryrunRecords, record, bodyFile } = s;

describe("posting receipts", () => {
  it.each(["post-review.sh", "approve-pr.sh"])(
    "%s checks replay identity only after acquiring ownership",
    (script) => {
      // MUTATION: move receipt check above acquire_receipt_lock — this fails.
      const source = readFileSync(join(root, "scripts", script), "utf8");
      expect(source.indexOf("\n  acquire_receipt_lock\n")).toBeLessThan(
        source.indexOf("  RECEIPT_STATE="),
      );
    },
  );

  it("snapshots review and inline comments before a posting-time read refuses", async () => {
    s.pr = { state: "closed", merged: false, head: { sha: HEAD } };
    const comments = join(s.dir, "comments.json");
    writeFileSync(comments, JSON.stringify(inlineComments));
    const result = await run("post-review.sh", ["5180", "COMMENT", bodyFile(), comments], {
      QCR_EXPECTED_HEAD: HEAD,
      QCR_ROUND_NO: "21",
      QCR_POSTING_RECEIPT_DIR: join(s.dir, "receipts"),
    });
    expect(result.ok).toBe(false);
    const job = JSON.parse(
      readFileSync(join(s.dir, "receipts", "pr-5180-round-21.outbox.json"), "utf8"),
    );
    expect(job).toMatchObject({
      status: "pending",
      mode: "dryrun",
      payload: { comments: inlineComments, commit_id: HEAD, event: "COMMENT" },
    });
    expect(job.payload.body).toContain(`<!-- qcr-post:v1:5180:21:${HEAD} -->`);
    expect(job.payload_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(existsSync(join(s.dir, "receipts", "pr-5180-round-21.json.lock"))).toBe(false);
  });

  it.each(
    [
      {},
      [null],
      [{ path: "src/example.ts", line: true, body: "Invalid line" }],
      [{ path: "src/example.ts", line: 0, body: "Invalid line" }],
      [{ path: "src/example.ts", line: 1, body: "Invalid side", side: "MIDDLE" }],
      [{ path: "src/example.ts", line: 1 }],
    ].map((comments) => [comments]),
  )("approval refuses invalid inline comments before any mutation: %j", async (comments) => {
    const commentsFile = join(s.dir, "invalid-comments.json");
    writeFileSync(commentsFile, JSON.stringify(comments));
    const res = await run("approve-pr.sh", ["5180", bodyFile(), commentsFile]);
    expect(res.ok).toBe(false);
    expect(dryrunRecords()).toEqual([]);
  });

  it("approval refuses an unreadable comments file before any mutation", async () => {
    const res = await run("approve-pr.sh", [
      "5180",
      bodyFile(),
      join(s.dir, "no-such-comments.json"),
    ]);
    expect(res.ok).toBe(false);
    expect(res.out).toContain("unreadable comments file");
    expect(dryrunRecords()).toEqual([]);
  });

  it("approval accepts an empty inline array", async () => {
    const commentsFile = join(s.dir, "empty-comments.json");
    writeFileSync(commentsFile, "[]");
    const res = await run("approve-pr.sh", ["5180", bodyFile(), commentsFile]);
    expect(res.ok).toBe(true);
    const create = dryrunRecords().find((name) => name.includes("create_review"));
    expect(JSON.parse(readFileSync(join(s.dir, "dryrun", create!), "utf8")).body.comments).toEqual(
      [],
    );
  });

  const receipt = (round: number) =>
    JSON.parse(readFileSync(join(s.dir, "receipts", `pr-5180-round-${round}.json`), "utf8"));

  it("post-review embeds the deterministic marker and atomically records dry-run intent", async () => {
    const key = `v1:5180:7:${HEAD}`;
    const res = await run("post-review.sh", ["5180", "COMMENT", bodyFile()], {
      QCR_EXPECTED_HEAD: HEAD,
      QCR_ROUND_NO: "7",
      QCR_POSTING_KEY: key,
      QCR_POSTING_RECEIPT_DIR: join(s.dir, "receipts"),
    });
    expect(res.ok).toBe(true);
    expect(record().body.body).toContain(`<!-- qcr-post:${key} -->`);
    expect(receipt(7)).toMatchObject({
      status: "dryrun",
      posting_key: key,
      pr: 5180,
      round_no: 7,
      head_sha: HEAD,
      actual_event: "COMMENT",
    });

    const repeated = await run("post-review.sh", ["5180", "COMMENT", bodyFile()], {
      QCR_EXPECTED_HEAD: HEAD,
      QCR_ROUND_NO: "7",
      QCR_POSTING_KEY: key,
      QCR_POSTING_RECEIPT_DIR: join(s.dir, "receipts"),
    });
    expect(repeated.ok).toBe(true);
    expect(repeated.out).toContain("skipping duplicate review");
    expect(dryrunRecords()).toHaveLength(1);
  });

  it("treats a confirmed retry as idempotent before body and posting guards", async () => {
    const key = `v1:5180:11:${HEAD}`;
    const path = join(s.dir, "receipts", "pr-5180-round-11.json");
    const args = [path, key, "5180", "11", HEAD, "COMMENT", "COMMENT", '{"event":"COMMENT"}'];
    await exec("python3", [join(root, "scripts", "posting-receipt.py"), "prepare", ...args]);
    await exec("python3", [join(root, "scripts", "posting-receipt.py"), "confirm", ...args], {
      env: {
        ...process.env,
        QCR_POST_RESPONSE: JSON.stringify({ id: 446, commit_id: HEAD, state: "COMMENTED" }),
      },
    });
    s.pr = {
      state: "closed",
      merged: false,
      head: { sha: "different" },
      user: { login: "pr-author" },
    };
    const res = await run("post-review.sh", ["5180", "COMMENT", join(s.dir, "missing-body.md")], {
      QCR_EXPECTED_HEAD: HEAD,
      QCR_ROUND_NO: "11",
      QCR_POSTING_KEY: key,
      QCR_POSTING_RECEIPT_DIR: join(s.dir, "receipts"),
    });
    expect(res.ok).toBe(true);
    expect(res.out).toContain("skipping duplicate review");
    expect(dryrunRecords()).toEqual([]);
  });

  it("refuses a prepared/unknown receipt rather than risking a second POST", async () => {
    const key = `v1:5180:9:${HEAD}`;
    mkdirSync(join(s.dir, "receipts"), { recursive: true });
    writeFileSync(
      join(s.dir, "receipts", "pr-5180-round-9.json"),
      JSON.stringify({ posting_key: key, status: "prepared" }),
    );
    const res = await run("post-review.sh", ["5180", "COMMENT", bodyFile()], {
      QCR_EXPECTED_HEAD: HEAD,
      QCR_ROUND_NO: "9",
      QCR_POSTING_KEY: key,
      QCR_POSTING_RECEIPT_DIR: join(s.dir, "receipts"),
    });
    expect(res.ok).toBe(false);
    expect(res.out).toContain("refusing a duplicate POST");
    expect(dryrunRecords()).toEqual([]);
  });

  it("an approval refused by another attempt's receipt lock leaves that lock in place", async () => {
    const key = `v1:5180:10:${HEAD}`;
    const lock = join(s.dir, "receipts", "pr-5180-round-10.json.lock");
    mkdirSync(lock, { recursive: true });
    const commentsFile = join(s.dir, "inline-comments.json");
    writeFileSync(commentsFile, JSON.stringify(inlineComments));
    const res = await run("approve-pr.sh", ["5180", bodyFile(), commentsFile], {
      QCR_EXPECTED_HEAD: HEAD,
      QCR_ROUND_NO: "10",
      QCR_POSTING_KEY: key,
      QCR_POSTING_RECEIPT_DIR: join(s.dir, "receipts"),
    });
    expect(res.ok).toBe(false);
    expect(res.out).toContain("another posting attempt owns");
    expect(existsSync(lock)).toBe(true);
    expect(dryrunRecords()).toEqual([]);
  });

  it("a review refused by another attempt's receipt lock leaves that lock in place", async () => {
    const key = `v1:5180:11:${HEAD}`;
    const lock = join(s.dir, "receipts", "pr-5180-round-11.json.lock");
    mkdirSync(lock, { recursive: true });
    const res = await run("post-review.sh", ["5180", "COMMENT", bodyFile()], {
      QCR_EXPECTED_HEAD: HEAD,
      QCR_ROUND_NO: "11",
      QCR_POSTING_KEY: key,
      QCR_POSTING_RECEIPT_DIR: join(s.dir, "receipts"),
    });
    expect(res.ok).toBe(false);
    expect(res.out).toContain("another posting attempt owns");
    expect(existsSync(lock)).toBe(true);
    expect(dryrunRecords()).toEqual([]);
  });

  it("requires GitHub's returned id, commit and state before confirming", async () => {
    const key = `v1:5180:10:${HEAD}`;
    const path = join(s.dir, "receipts", "pr-5180-round-10.json");
    const args = [path, key, "5180", "10", HEAD, "COMMENT", "COMMENT", '{"event":"COMMENT"}'];
    await exec("python3", [join(root, "scripts", "posting-receipt.py"), "prepare", ...args]);
    await exec("python3", [join(root, "scripts", "posting-receipt.py"), "confirm", ...args], {
      env: {
        ...process.env,
        QCR_POST_RESPONSE: JSON.stringify({ id: 444, commit_id: HEAD, state: "COMMENTED" }),
      },
    });
    expect(receipt(10)).toMatchObject({
      status: "confirmed",
      gh_review_id: 444,
      gh_commit_id: HEAD,
      gh_state: "COMMENTED",
    });
    await expect(
      exec("python3", [join(root, "scripts", "posting-receipt.py"), "confirm", ...args], {
        env: {
          ...process.env,
          QCR_POST_RESPONSE: JSON.stringify({ id: 445, commit_id: "wrong", state: "COMMENTED" }),
        },
      }),
    ).rejects.toThrow();
  });

  it("confirmed approval retry bypasses changed posting guards and resumes cleanup only", async () => {
    const key = `v1:5180:12:${HEAD}`;
    const path = join(s.dir, "receipts", "pr-5180-round-12.json");
    const args = [
      path,
      key,
      "5180",
      "12",
      HEAD,
      "APPROVE",
      "APPROVE",
      JSON.stringify({ event: "APPROVE", comments: inlineComments }),
    ];
    await exec("python3", [join(root, "scripts", "posting-receipt.py"), "prepare", ...args]);
    await exec("python3", [join(root, "scripts", "posting-receipt.py"), "confirm", ...args], {
      env: {
        ...process.env,
        QCR_POST_RESPONSE: JSON.stringify({ id: 447, commit_id: HEAD, state: "APPROVED" }),
      },
    });
    s.pr = {
      state: "closed",
      merged: false,
      head: { sha: "different" },
      user: { login: "pr-author" },
    };
    s.checkRuns = [{ name: "unit", status: "completed", conclusion: "failure" }];
    const res = await run(
      "approve-pr.sh",
      ["5180", join(s.dir, "missing-body.md"), join(s.dir, "missing-comments.json")],
      {
        QCR_EXPECTED_HEAD: HEAD,
        QCR_ROUND_NO: "12",
        QCR_POSTING_KEY: key,
        QCR_POSTING_RECEIPT_DIR: join(s.dir, "receipts"),
      },
    );
    expect(res.ok).toBe(true);
    expect(res.out).toContain("skipping duplicate approval");
    expect(dryrunRecords().some((name) => name.includes("create_review"))).toBe(false);
    expect(dryrunRecords().some((name) => name.includes("remove_label"))).toBe(true);
    expect(dryrunRecords().some((name) => name.includes("delete_team_review_request"))).toBe(true);
  });

  it("approval records the same keyed dry-run receipt before trigger cleanup", async () => {
    const key = `v1:5180:8:${HEAD}`;
    const commentsFile = join(s.dir, "inline-comments.json");
    writeFileSync(commentsFile, JSON.stringify(inlineComments));
    const res = await run("approve-pr.sh", ["5180", bodyFile(), commentsFile], {
      QCR_EXPECTED_HEAD: HEAD,
      QCR_ROUND_NO: "8",
      QCR_POSTING_KEY: key,
      QCR_POSTING_RECEIPT_DIR: join(s.dir, "receipts"),
    });
    expect(res.ok).toBe(true);
    expect(receipt(8)).toMatchObject({
      status: "dryrun",
      posting_key: key,
      pr: 5180,
      round_no: 8,
      head_sha: HEAD,
      actual_event: "APPROVE",
    });
    const create = dryrunRecords().find((name) => name.includes("create_review"));
    expect(create).toBeDefined();
    const payload = JSON.parse(readFileSync(join(s.dir, "dryrun", create!), "utf8")).body;
    expect(payload.commit_id).toBe(HEAD);
    expect(payload.event).toBe("APPROVE");
    expect(payload.comments).toEqual(inlineComments);
    expect(dryrunRecords().filter((name) => name.includes("create_review"))).toHaveLength(1);
    expect(dryrunRecords()).toHaveLength(3);

    const repeated = await run("approve-pr.sh", ["5180", bodyFile(), commentsFile], {
      QCR_EXPECTED_HEAD: HEAD,
      QCR_ROUND_NO: "8",
      QCR_POSTING_KEY: key,
      QCR_POSTING_RECEIPT_DIR: join(s.dir, "receipts"),
    });
    expect(repeated.ok).toBe(true);
    expect(repeated.out).toContain("skipping duplicate approval");
    expect(dryrunRecords().filter((name) => name.includes("create_review"))).toHaveLength(1);
  });
});
