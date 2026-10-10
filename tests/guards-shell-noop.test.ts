// scripts/post-review.sh — guard 2 records a guarded no-op receipt, and posting-receipt.py's skip/prepare ordering.
// Part of the guards-shell suite: the real session posting scripts against a
// loopback GitHub stub, in dry-run. The rig (stub, temp home, state.db, the
// run/record helpers) and why the suite is split are in
// tests/helpers/guards-shell-rig.ts; this file owns its own stub instance.
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { StateStore } from "../src/state.js";
import { parsePostingReceipt } from "../src/posting-receipt.js";
import { HEAD, exec, root, useGuardsShellRig } from "./helpers/guards-shell-rig.js";

const s = useGuardsShellRig();
const { run, dryrunRecords, bodyFile } = s;

/**
 * Guard 2 leaves evidence. A refusal with no receipt would read to the daemon
 * as a lost POST and open a FAILED_LOUD incident, so the shell writes an
 * identity-bound `skipped` record before it exits, and only under the same
 * conditions the daemon later checks.
 */
describe("scripts/post-review.sh — guard 2 records a guarded no-op", () => {
  const receiptPath = (round: number) => join(s.dir, "receipts", `pr-5180-round-${round}.json`);
  const keyed = (round: number, key: string) => ({
    QCR_EXPECTED_HEAD: HEAD,
    QCR_ROUND_NO: String(round),
    QCR_POSTING_KEY: key,
    QCR_POSTING_RECEIPT_DIR: join(s.dir, "receipts"),
  });
  const seedPartialMark = (): { reviewed_at: string } => {
    const store = new StateStore(s.dbPath);
    store.recordReviewedHead(5180, { head_sha: HEAD, posted_event: "REQUEST_CHANGES" });
    const mark = store.reviewedHead(5180)!;
    store.close();
    return { reviewed_at: mark.reviewed_at };
  };

  it("the #5409 shape: a shell-only REQUEST_CHANGES mark at the same head refuses AND records the refusal — no POST, no dry-run intent, no re-stamp", async () => {
    const mark = seedPartialMark();
    const key = `v1:5180:18:${HEAD}`;

    const res = await run(
      "post-review.sh",
      ["5180", "REQUEST_CHANGES", bodyFile()],
      keyed(18, key),
    );

    expect(res.ok).toBe(false);
    expect(res.out).toContain("guard 2");
    expect(res.out).toContain("recorded guarded no-op");
    expect(dryrunRecords()).toEqual([]);
    const raw = readFileSync(receiptPath(18), "utf8");
    expect(JSON.parse(raw)).toMatchObject({
      version: 1,
      posting_key: key,
      marker: `<!-- qcr-post:${key} -->`,
      pr: 5180,
      round_no: 18,
      head_sha: HEAD,
      status: "skipped",
      skip_reason: "no-new-evidence",
      intended_event: "REQUEST_CHANGES",
      mode: "dryrun",
      standing_mark: {
        head_sha: HEAD,
        reviewed_at: mark.reviewed_at,
        verdict: null,
        posted_event: "REQUEST_CHANGES",
        round_no: null,
        last_author_reply_at: null,
      },
    });
    expect(JSON.parse(raw)).not.toHaveProperty("actual_event");
    // The daemon-side parser accepts exactly what the shell wrote.
    expect(parsePostingReceipt(raw)?.status).toBe("skipped");
    // The mark was read, not re-stamped, and the receipt lock was released.
    const after = new StateStore(s.dbPath);
    expect(after.reviewedHead(5180)).toMatchObject({
      reviewed_at: mark.reviewed_at,
      verdict: null,
      posted_event: "REQUEST_CHANGES",
    });
    after.close();
    expect(existsSync(`${receiptPath(18)}.lock`)).toBe(false);
  });

  it("a replay against the recorded refusal is terminal: refuses again, posts nothing, leaves the record byte-identical", async () => {
    seedPartialMark();
    const key = `v1:5180:19:${HEAD}`;
    expect((await run("post-review.sh", ["5180", "COMMENT", bodyFile()], keyed(19, key))).ok).toBe(
      false,
    );
    const first = readFileSync(receiptPath(19), "utf8");

    const again = await run("post-review.sh", ["5180", "COMMENT", bodyFile()], keyed(19, key));

    expect(again.ok).toBe(false);
    expect(again.out).toContain("already refused");
    expect(readFileSync(receiptPath(19), "utf8")).toBe(first);
    expect(dryrunRecords()).toEqual([]);
  });

  it("a legacy round with no posting identity refuses exactly as before and records nothing", async () => {
    seedPartialMark();
    const res = await run("post-review.sh", ["5180", "COMMENT", bodyFile()]);
    expect(res.ok).toBe(false);
    expect(res.out).toContain("guard 2");
    expect(res.out).not.toContain("recorded guarded no-op");
    expect(existsSync(join(s.dir, "receipts"))).toBe(false);
    expect(dryrunRecords()).toEqual([]);
  });

  it("an author reply since the mark still posts, and writes an ordinary receipt rather than a skip", async () => {
    const store = new StateStore(s.dbPath);
    store.recordReviewedHead(5180, { head_sha: HEAD, posted_event: "REQUEST_CHANGES" });
    store.noteAuthorReply(5180, "2099-01-01T00:00:00.000Z");
    store.close();
    const key = `v1:5180:20:${HEAD}`;

    const res = await run("post-review.sh", ["5180", "COMMENT", bodyFile()], keyed(20, key));

    expect(res.ok).toBe(true);
    expect(dryrunRecords()).toHaveLength(1);
    expect(JSON.parse(readFileSync(receiptPath(20), "utf8"))).toMatchObject({
      status: "dryrun",
      posting_key: key,
    });
  });

  it("posting-receipt.py: a skip never lands over an attempted post, an attempt never lands over a skip, and a same-identity skip replays inertly", async () => {
    const script = join(root, "scripts", "posting-receipt.py");
    const mark = JSON.stringify({
      head_sha: HEAD,
      reviewed_at: "2026-09-01T10:41:34.773Z",
      last_author_reply_at: null,
      verdict: null,
      posted_event: "REQUEST_CHANGES",
      round_no: null,
    });
    mkdirSync(join(s.dir, "receipts"), { recursive: true });

    // prepared ⇒ skip refused (the ambiguous window outranks a later "never sent").
    const k21 = `v1:5180:21:${HEAD}`;
    await exec("python3", [
      script,
      "prepare",
      receiptPath(21),
      k21,
      "5180",
      "21",
      HEAD,
      "COMMENT",
      "COMMENT",
      '{"event":"COMMENT"}',
    ]);
    await expect(
      exec("python3", [
        script,
        "skip",
        receiptPath(21),
        k21,
        "5180",
        "21",
        HEAD,
        "COMMENT",
        "dryrun",
        mark,
      ]),
    ).rejects.toThrow(/attempted post/);
    expect(JSON.parse(readFileSync(receiptPath(21), "utf8")).status).toBe("prepared");

    // skipped ⇒ prepare refused (the refusal is terminal for the key).
    const k22 = `v1:5180:22:${HEAD}`;
    await exec("python3", [
      script,
      "skip",
      receiptPath(22),
      k22,
      "5180",
      "22",
      HEAD,
      "COMMENT",
      "dryrun",
      mark,
    ]);
    await expect(
      exec("python3", [
        script,
        "prepare",
        receiptPath(22),
        k22,
        "5180",
        "22",
        HEAD,
        "COMMENT",
        "COMMENT",
        '{"event":"COMMENT"}',
      ]),
    ).rejects.toThrow(/refused/);
    const before = readFileSync(receiptPath(22), "utf8");
    await exec("python3", [
      script,
      "skip",
      receiptPath(22),
      k22,
      "5180",
      "22",
      HEAD,
      "COMMENT",
      "dryrun",
      mark,
    ]);
    expect(readFileSync(receiptPath(22), "utf8")).toBe(before);

    // A mark that would NOT satisfy guard 2 cannot be written as a skip at all.
    const k23 = `v1:5180:23:${HEAD}`;
    const replied = JSON.stringify({
      ...JSON.parse(mark),
      last_author_reply_at: "2026-09-01T11:00:00.000Z",
    });
    await expect(
      exec("python3", [
        script,
        "skip",
        receiptPath(23),
        k23,
        "5180",
        "23",
        HEAD,
        "COMMENT",
        "dryrun",
        replied,
      ]),
    ).rejects.toThrow(/author reply/);
    const otherHead = JSON.stringify({ ...JSON.parse(mark), head_sha: "0000000" });
    await expect(
      exec("python3", [
        script,
        "skip",
        receiptPath(23),
        k23,
        "5180",
        "23",
        HEAD,
        "COMMENT",
        "dryrun",
        otherHead,
      ]),
    ).rejects.toThrow(/head/);
    expect(existsSync(receiptPath(23))).toBe(false);
  });
});
