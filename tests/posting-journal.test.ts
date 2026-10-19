// [P7.2] The TypeScript posting journal writes the same receipt and outbox job
// files as scripts/posting-receipt.py, step for step: the verdict watcher, the
// outbox and the deferred retry read them and cannot tell which route wrote
// them. Each scenario runs the Python helper and the journal over the same
// inputs in two directories and compares the files, timestamps aside.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  roundPostingKey,
  type PostingReceipt,
} from "../src/posting-receipt.js";
import type { StandingMarkSnapshot } from "../src/standing-review.js";

const PY = resolve(import.meta.dirname, "..", "scripts", "posting-receipt.py");
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
let pyDir: string;
let tsDir: string;
let journal: PostingJournal;
const receiptName = `pr-${PR}-round-${ROUND}.json`;
const jobName = `pr-${PR}-round-${ROUND}.outbox.json`;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "journal-"));
  pyDir = join(work, "py");
  tsDir = join(work, "ts");
  journal = new PostingJournal({ dir: tsDir, repo: REPO });
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

const py = (args: string[], env: Record<string, string> = {}): void => {
  execFileSync("python3", ["-I", PY, ...args], { env: { ...process.env, ...env }, stdio: "pipe" });
};

/** A file as plain data, with its timestamps blanked. */
function load(dir: string, name: string): Record<string, unknown> | null {
  const p = join(dir, name);
  if (!existsSync(p)) return null;
  const v = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  for (const t of TIMES) if (t in v) v[t] = "<time>";
  return v;
}

function same(name: string): void {
  const a = load(pyDir, name);
  const b = load(tsDir, name);
  expect(b, name).toEqual(a);
  if (a && b) expect(Object.keys(b), `${name} key order`).toEqual(Object.keys(a));
}

const bodyFile = (): string => {
  const p = join(work, "body.md");
  writeFileSync(p, "the review body");
  return p;
};
const commentsFile = (): string => {
  const p = join(work, "comments.json");
  writeFileSync(
    p,
    JSON.stringify([{ path: "a.py", line: 3, side: "RIGHT", body: "b", extra: "dropped" }]),
  );
  return p;
};
const payload = (event: ReviewEvent = "REQUEST_CHANGES"): JobPayload => ({
  commit_id: HEAD,
  event,
  body: `the review body\n\n${postingMarker(KEY)}`,
  comments: [{ path: "a.py", line: 3, side: "RIGHT", body: "b" }] as unknown[],
});
const pyPath = (n: string) => join(pyDir, n);

function bothEnqueue(event: ReviewEvent = "REQUEST_CHANGES", mode: "live" | "dryrun" = "live") {
  py([
    "enqueue",
    pyPath(jobName),
    KEY,
    String(PR),
    String(ROUND),
    HEAD,
    event,
    REPO,
    mode,
    bodyFile(),
    commentsFile(),
  ]);
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
function bothPrepare(intended: ReviewEvent = "REQUEST_CHANGES") {
  py([
    "prepare",
    pyPath(receiptName),
    KEY,
    String(PR),
    String(ROUND),
    HEAD,
    intended,
    intended,
    JSON.stringify(payload(intended)),
  ]);
  journal.prepare({
    key: KEY,
    pr: PR,
    round: ROUND,
    head: HEAD,
    intended,
    payload: payload(intended),
  });
}

describe("[P7.2] the journal writes what posting-receipt.py writes", () => {
  it("enqueue, prepare, confirm", () => {
    bothEnqueue();
    same(jobName);
    bothPrepare();
    same(receiptName);
    same(jobName);
    const response = { id: 501, commit_id: HEAD, state: "CHANGES_REQUESTED" };
    py(
      [
        "confirm",
        pyPath(receiptName),
        KEY,
        String(PR),
        String(ROUND),
        HEAD,
        "REQUEST_CHANGES",
        "REQUEST_CHANGES",
        JSON.stringify(payload()),
      ],
      { QCR_POST_RESPONSE: JSON.stringify(response) },
    );
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
    bothEnqueue("COMMENT", "dryrun");
    bothPrepare("COMMENT");
    py([
      "dryrun",
      pyPath(receiptName),
      KEY,
      String(PR),
      String(ROUND),
      HEAD,
      "COMMENT",
      "COMMENT",
      JSON.stringify(payload("COMMENT")),
    ]);
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
    bothEnqueue();
    bothPrepare();
    const reason = "GitHub answered 502; marker read: none";
    py([
      "defer",
      pyPath(receiptName),
      KEY,
      String(PR),
      String(ROUND),
      HEAD,
      "REQUEST_CHANGES",
      "REQUEST_CHANGES",
      JSON.stringify(payload()),
      reason,
    ]);
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
    bothEnqueue("APPROVE");
    py(["withdraw", pyPath(receiptName), KEY]);
    journal.withdraw(PR, ROUND, KEY);
    for (const dir of [pyDir, tsDir]) {
      expect(existsSync(join(dir, jobName))).toBe(false);
      expect(readdirSync(dir).filter((f) => f.startsWith(`${jobName}.withdrawn-`))).toHaveLength(1);
    }
    // never over a receipt
    bothEnqueue("COMMENT");
    bothPrepare("COMMENT");
    expect(() => py(["withdraw", pyPath(receiptName), KEY])).toThrow();
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
    py([
      "skip",
      pyPath(receiptName),
      KEY,
      String(PR),
      String(ROUND),
      HEAD,
      "REQUEST_CHANGES",
      "live",
      JSON.stringify(mark),
    ]);
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
    bothEnqueue("COMMENT");
    bothPrepare("COMMENT");
    expect(() => skip(ok)).toThrow(/attempted post/);
  });

  it("hashes the receipt and the job alike, so the job reader accepts the receipt's twin", () => {
    bothEnqueue();
    bothPrepare();
    const r = readPostingReceipt(tsDir, PR, ROUND) as PostingReceipt;
    expect(r.payload_sha256).toBe(payloadHash(payload()));
    expect(readPostingJob(join(tsDir, jobName))!.payload_sha256).toBe(r.payload_sha256);
  });

  it("refuses a changed queued input and a foreign key", () => {
    bothEnqueue();
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

  it("confirm refuses a response that contradicts the attempt", () => {
    bothPrepare();
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

  it("is released when the attempt throws", async () => {
    await expect(
      journal.locked(PR, ROUND, KEY, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await journal.locked(PR, ROUND, KEY, async () => 2)).toBe(2);
  });
});
