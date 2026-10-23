// [P7.2] The TypeScript posting journal writes the receipt and outbox job
// files the verdict watcher, the outbox and the deferred retry read. Each
// scenario's files are pinned as snapshots (timestamps blanked, key order kept):
// they are the bytes scripts/posting-receipt.py wrote step for step until P9.3
// deleted it, so the readers keep reading what they always read.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  JournalError,
  PostingJournal,
  payloadHash,
  type JobPayload,
  type ReviewEvent,
} from "../src/posting-journal.js";
import { readPostingJob } from "../src/posting-outbox.js";
import {
  postingMarker,
  readPostingReceipt,
  retrySoftenedApproval,
  roundPostingKey,
  type PostingReceipt,
} from "../src/posting-receipt.js";
import type { StandingMarkSnapshot } from "../src/standing-review.js";

const PR = 12;
const ROUND = 2;
const HEAD = "b".repeat(40);
const KEY = roundPostingKey(PR, ROUND, HEAD);
const REPO = "org/repo";
const TIMES = [
  "created_at",
  "next_attempt_at",
  "prepared_at",
  "confirmed_at",
  "attempted_at",
  "deferred_at",
  "skipped_at",
];

let work: string;
let tsDir: string;
let journal: PostingJournal;
const receiptName = `pr-${PR}-round-${ROUND}.json`;
const jobName = `pr-${PR}-round-${ROUND}.outbox.json`;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "journal-"));
  tsDir = join(work, "ts");
  journal = new PostingJournal({ dir: tsDir, repo: REPO });
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

/** A file as plain data, with its timestamps blanked. */
function load(dir: string, name: string): Record<string, unknown> | null {
  const p = join(dir, name);
  if (!existsSync(p)) return null;
  const v = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  for (const t of TIMES) if (t in v) v[t] = "<time>";
  return v;
}

function same(name: string): void {
  expect(JSON.stringify(load(tsDir, name), null, 1)).toMatchSnapshot(name);
}

const payload = (event: ReviewEvent = "REQUEST_CHANGES"): JobPayload => ({
  commit_id: HEAD,
  event,
  body: `the review body\n\n${postingMarker(KEY)}`,
  comments: [{ path: "a.py", line: 3, side: "RIGHT", body: "b" }] as unknown[],
});

function enqueue(event: ReviewEvent = "REQUEST_CHANGES", mode: "live" | "dryrun" = "live") {
  journal.enqueue({
    key: KEY,
    pr: PR,
    round: ROUND,
    head: HEAD,
    event,
    mode,
    payload: payload(event),
  });
}
function prepare(intended: ReviewEvent = "REQUEST_CHANGES") {
  journal.prepare({
    key: KEY,
    pr: PR,
    round: ROUND,
    head: HEAD,
    intended,
    payload: payload(intended),
  });
}

describe("[P7.2] the journal writes the receipt and job files the readers expect", () => {
  it("enqueue, prepare, confirm", () => {
    enqueue();
    same(jobName);
    prepare();
    same(receiptName);
    same(jobName);
    const response = { id: 501, commit_id: HEAD, state: "CHANGES_REQUESTED" };
    journal.confirm({
      key: KEY,
      pr: PR,
      round: ROUND,
      head: HEAD,
      intended: "REQUEST_CHANGES",
      payload: payload(),
      response,
    });
    same(receiptName);
    same(jobName);
    // and the daemon's own readers accept the result
    expect(readPostingReceipt(tsDir, PR, ROUND)).toMatchObject({ status: "confirmed" });
    expect(readPostingJob(join(tsDir, jobName))).toMatchObject({ status: "done" });
  });

  it("enqueue, prepare, dry-run", () => {
    enqueue("COMMENT", "dryrun");
    prepare("COMMENT");
    journal.dryrun({
      key: KEY,
      pr: PR,
      round: ROUND,
      head: HEAD,
      intended: "COMMENT",
      actual: "COMMENT",
      payload: payload("COMMENT"),
    });
    same(receiptName);
    same(jobName);
  });

  it("enqueue, prepare, defer", () => {
    enqueue();
    prepare();
    const reason = "GitHub answered 502; marker read: none";
    journal.defer({
      key: KEY,
      pr: PR,
      round: ROUND,
      head: HEAD,
      intended: "REQUEST_CHANGES",
      payload: payload(),
      reason,
    });
    same(receiptName);
    same(jobName);
    const job = readPostingJob(join(tsDir, jobName))!;
    expect(job.deferred_at).toBeTruthy();
    expect(readPostingReceipt(tsDir, PR, ROUND)).toMatchObject({ status: "deferred" });
  });

  it("enqueue, withdraw: the job is set aside and nothing else is written", () => {
    enqueue("APPROVE");
    journal.withdraw(PR, ROUND, KEY);
    expect(existsSync(join(tsDir, jobName))).toBe(false);
    expect(readdirSync(tsDir).filter((f) => f.startsWith(`${jobName}.withdrawn-`))).toHaveLength(1);
    // never over a receipt
    enqueue("COMMENT");
    prepare("COMMENT");
    expect(() => journal.withdraw(PR, ROUND, KEY)).toThrow(JournalError);
  });

  it("skip", () => {
    const mark = {
      head_sha: HEAD,
      reviewed_at: "2026-10-18T10:00:00.000Z",
      verdict: "REQUEST_CHANGES",
      posted_event: "REQUEST_CHANGES",
      round_no: 1,
      last_author_reply_at: null,
    };
    expect(
      journal.skip({
        key: KEY,
        pr: PR,
        round: ROUND,
        head: HEAD,
        intended: "REQUEST_CHANGES",
        mode: "live",
        mark,
      }),
    ).toBe(true);
    same(receiptName);
    expect(readPostingReceipt(tsDir, PR, ROUND)).toMatchObject({ status: "skipped" });
  });

  it("skip refuses a mark that would not have justified the refusal, and never overwrites an attempt", () => {
    const ok: StandingMarkSnapshot = {
      head_sha: HEAD,
      reviewed_at: "2026-10-18T10:00:00.000Z",
      verdict: "REQUEST_CHANGES",
      posted_event: null,
      round_no: null,
      last_author_reply_at: null,
    };
    const skip = (mark: StandingMarkSnapshot) =>
      journal.skip({
        key: KEY,
        pr: PR,
        round: ROUND,
        head: HEAD,
        intended: "COMMENT",
        mode: "live",
        mark,
      });
    expect(skip({ ...ok, last_author_reply_at: "2026-10-18T10:00:00.000Z" })).toBe(false);
    expect(skip({ ...ok, verdict: "NEEDS_HUMAN" })).toBe(false);
    expect(skip({ ...ok, head_sha: "c".repeat(40) })).toBe(false);
    expect(existsSync(join(tsDir, receiptName))).toBe(false);
    enqueue("COMMENT");
    prepare("COMMENT");
    expect(() => skip(ok)).toThrow(/attempted post/);
  });

  it("hashes the receipt and the job alike, so the job reader accepts the receipt's twin", () => {
    enqueue();
    prepare();
    const r = readPostingReceipt(tsDir, PR, ROUND) as PostingReceipt;
    expect(r.payload_sha256).toBe(payloadHash(payload()));
    expect(readPostingJob(join(tsDir, jobName))!.payload_sha256).toBe(r.payload_sha256);
  });

  it("refuses a changed queued input and a foreign key", () => {
    enqueue();
    expect(() =>
      journal.enqueue({
        key: KEY,
        pr: PR,
        round: ROUND,
        head: HEAD,
        event: "REQUEST_CHANGES",
        mode: "live",
        payload: { ...payload(), body: "changed" },
      }),
    ).toThrow(/refusing to change queued review input/);
    expect(() =>
      journal.prepare({
        key: roundPostingKey(PR, ROUND, "c".repeat(40)),
        pr: PR,
        round: ROUND,
        head: "c".repeat(40),
        intended: "COMMENT",
        payload: payload("COMMENT"),
      }),
    ).not.toThrow();
    expect(journal.check(PR, ROUND, KEY)).toBe("mismatch");
  });

  it("confirm marks an APPROVE that GitHub holds as a COMMENT with the withheld-approval provenance", () => {
    enqueue("APPROVE");
    prepare("APPROVE");
    journal.confirm({
      key: KEY,
      pr: PR,
      round: ROUND,
      head: HEAD,
      intended: "APPROVE",
      payload: payload("APPROVE"),
      response: { id: 77, commit_id: HEAD, state: "COMMENTED" },
    });
    const receipt = readPostingReceipt(tsDir, PR, ROUND) as PostingReceipt;
    expect(receipt).toMatchObject({ actual_event: "COMMENT", delivered_by: "daemon_retry" });
    expect(retrySoftenedApproval(receipt)).toBe(true);
  });

  it("confirm leaves an APPROVE that landed as an APPROVE without that provenance", () => {
    enqueue("APPROVE");
    prepare("APPROVE");
    journal.confirm({
      key: KEY,
      pr: PR,
      round: ROUND,
      head: HEAD,
      intended: "APPROVE",
      payload: payload("APPROVE"),
      response: { id: 78, commit_id: HEAD, state: "APPROVED" },
    });
    expect(readPostingReceipt(tsDir, PR, ROUND)).not.toHaveProperty("delivered_by");
  });

  it("confirm refuses a response that contradicts the attempt", () => {
    prepare();
    const base = {
      key: KEY,
      pr: PR,
      round: ROUND,
      head: HEAD,
      intended: "REQUEST_CHANGES" as const,
      payload: payload(),
    };
    expect(() =>
      journal.confirm({
        ...base,
        response: { id: 1, commit_id: "c".repeat(40), state: "CHANGES_REQUESTED" },
      }),
    ).toThrow(JournalError);
    expect(() =>
      journal.confirm({ ...base, response: { id: 1, commit_id: HEAD, state: "APPROVED" } }),
    ).toThrow(JournalError);
    expect(() =>
      journal.confirm({ ...base, response: { commit_id: HEAD, state: "COMMENTED" } }),
    ).toThrow(JournalError);
    expect(journal.check(PR, ROUND, KEY)).toBe("prepared");
  });
});

describe("[P7.2] the posting lock", () => {
  it("is held by one attempt at a time and released afterwards", async () => {
    let inner: Promise<unknown> | undefined;
    await journal.locked(PR, ROUND, KEY, async () => {
      inner = journal.locked(PR, ROUND, KEY, async () => 1);
      await expect(inner).rejects.toThrow(/another posting attempt owns/);
    });
    expect(await journal.locked(PR, ROUND, KEY, async () => "free")).toBe("free");
    expect(existsSync(join(tsDir, `${receiptName}.lock`))).toBe(false);
  });

  it("takes over a reclaim mutex a dead reclaimer left behind", async () => {
    const lock = join(tsDir, `${receiptName}.lock`);
    mkdirSync(lock, { recursive: true });
    mkdirSync(`${lock}.reclaim`);
    const old = new Date(Date.now() - 3_600_000);
    for (const d of [lock, `${lock}.reclaim`]) utimesSync(d, old, old);
    expect(await journal.locked(PR, ROUND, KEY, async () => "taken")).toBe("taken");
    expect(existsSync(`${lock}.reclaim`)).toBe(false);
  });

  it("leaves a fresh reclaim mutex alone", async () => {
    const lock = join(tsDir, `${receiptName}.lock`);
    mkdirSync(lock, { recursive: true });
    mkdirSync(`${lock}.reclaim`);
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(lock, old, old);
    await expect(journal.locked(PR, ROUND, KEY, async () => 1)).rejects.toThrow(
      /another posting attempt owns/,
    );
  });

  it("is released when the attempt throws", async () => {
    await expect(
      journal.locked(PR, ROUND, KEY, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await journal.locked(PR, ROUND, KEY, async () => 2)).toBe(2);
  });
});
