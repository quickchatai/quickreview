// The daemon's post ops on the worker socket: post.review, post.approval
// and post.reply.
//
// Everything runs through the real stack a host would meet: a real IpcServer on
// a real unix socket, the real post ops, the real GitHubAdapter (App minter
// stubbed) over a fake GitHub `fetch`, the real MutationGate with the real
// posting guards, the real receipt/outbox journal. A dry-run install writes
// only under state/dryrun/ and makes no POST; the refusals are asserted to
// leave no trace anywhere.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitHubRequestError } from "../src/github.js";
import type { IpcClient } from "../src/ipc/client.js";
import type { CommandState, IpcErrorCode } from "../src/ipc/protocol.js";
import { readPostingJob } from "../src/posting-outbox.js";
import {
  postingMarker,
  readPostingReceipt,
  roundPostingKey,
  type PostingReceipt,
} from "../src/posting-receipt.js";
import type { PostOutcome } from "../src/postops.js";
import type { PassPlanEntry } from "@quickchatai/pi-quickreview/src/types.js";
import {
  BOT,
  COMMENTS,
  HEAD,
  KEY,
  MOVED,
  OTHER_PR,
  PR,
  REPO,
  SANDBOX,
  buildRig,
  dryrunRecords as dryrunRecordsOf,
  plainCommand as plainCommandOf,
  roundCommand as roundCommandOf,
  type Rig,
} from "./helpers/post-ops-rig.js";

let rig: Rig;
let clients: IpcClient[];

const build = (dryRun: boolean): Promise<Rig> => buildRig(dryRun, clients);
const roundCommand = (id = "c-round", over: Partial<CommandState> = {}): void =>
  roundCommandOf(rig, id, over);
const plainCommand = (id: string, over: Partial<CommandState> = {}): void =>
  plainCommandOf(rig, id, over);
const dryrunRecords = () => dryrunRecordsOf(rig);
const receiptsDir = (): string => join(rig.state, "posting-receipts");
const receipt = (round = 1) => readPostingReceipt(receiptsDir(), PR, round);

async function refusedWith(p: Promise<unknown>, code: IpcErrorCode): Promise<void> {
  await expect(p).rejects.toMatchObject({ code });
}

/** After a refusal nothing was recorded, queued or sent anywhere. */
function expectNoTrace(): void {
  expect(dryrunRecords()).toEqual([]);
  expect(rig.gh.posts()).toEqual([]);
  expect(existsSync(receiptsDir()) ? readdirSync(receiptsDir()) : []).toEqual([]);
}

beforeEach(() => {
  clients = [];
});
afterEach(async () => {
  for (const c of clients) c.close();
  await rig?.server.stop();
  rig?.store.close();
  if (rig) rmSync(rig.root, { recursive: true, force: true });
});

describe("post.review in dry-run", () => {
  beforeEach(async () => {
    rig = await build(true);
    roundCommand();
  });

  it("records the review under state/dryrun/ only, and keys the receipt and outbox job", async () => {
    const body = rig.write(`pr-${PR}-round-1-review.md`, "**Verdict** one blocker.");
    const comments = rig.write(`pr-${PR}-round-1-comments.json`, COMMENTS);
    const c = await rig.connect("c-round");
    const out = await c.request<PostOutcome>(
      "post.review",
      {
        pr: PR,
        event: "REQUEST_CHANGES",
        body_file: body,
        comments_file: comments,
        round_no: 1,
        expected_head: HEAD,
      },
      { pr: PR },
    );
    expect(out.status).toBe("dryrun");
    expect(rig.gh.posts()).toEqual([]);
    const [rec] = dryrunRecords();
    expect(dryrunRecords()).toHaveLength(1);
    expect(rec).toMatchObject({
      kind: "create_review",
      method: "POST",
      path: `/repos/${REPO}/pulls/${PR}/reviews`,
      pr: PR,
      body: {
        commit_id: HEAD,
        event: "REQUEST_CHANGES",
        body: `**Verdict** one blocker.\n\n${postingMarker(KEY)}`,
        // only the five anchor keys and the body survive
        comments: [{ path: "a.py", line: 3, side: "RIGHT", body: "[blocker] x" }],
      },
    });
    expect(out.dryrun_file).toBe(join(rig.dryrun, readdirSync(rig.dryrun)[0]!));
    const r = receipt() as PostingReceipt;
    expect(r).toMatchObject({
      posting_key: KEY,
      status: "dryrun",
      intended_event: "REQUEST_CHANGES",
      actual_event: "REQUEST_CHANGES",
    });
    const job = rig.journal.readJob(PR, 1)!;
    expect(job).toMatchObject({ status: "done", mode: "dryrun", repo: REPO, posting_key: KEY });
    expect(job.payload_sha256).toBe(r.payload_sha256);
    // The files are exactly what the outbox and verdict watcher read.
    expect(readPostingJob(rig.journal.jobPath(PR, 1))).toBeDefined();
  });

  it("answers a repeat with the recorded receipt and records nothing twice", async () => {
    const body = rig.write(`pr-${PR}-round-1-review.md`, "same");
    const c = await rig.connect("c-round");
    const ask = () =>
      c.request<PostOutcome>(
        "post.review",
        { pr: PR, event: "COMMENT", body_file: body },
        { pr: PR },
      );
    expect((await ask()).status).toBe("dryrun");
    expect((await ask()).status).toBe("already_confirmed");
    expect(dryrunRecords()).toHaveLength(1);
  });

  it("reads the body as post-review.sh does: CRLF and a lone CR become LF", async () => {
    const body = rig.write(`pr-${PR}-round-1-review.md`, "one\r\ntwo\rthree\r\n\r\n");
    const c = await rig.connect("c-round");
    await c.request("post.review", { pr: PR, event: "COMMENT", body_file: body }, { pr: PR });
    expect(dryrunRecords()[0]!.body.body).toBe(`one\ntwo\nthree\n\n\n\n${postingMarker(KEY)}`);
  });

  it("refuses APPROVE on post.review and an unknown event", async () => {
    const body = rig.write(`pr-${PR}-round-1-review.md`, "x");
    const c = await rig.connect("c-round");
    await refusedWith(
      c.request("post.review", { pr: PR, event: "APPROVE", body_file: body }, { pr: PR }),
      "bad_request",
    );
    await refusedWith(
      c.request("post.review", { pr: PR, event: "DISMISS", body_file: body }, { pr: PR }),
      "bad_request",
    );
    expectNoTrace();
  });

  it("records a guard-2 refusal as a guarded no-op and refuses the key afterwards", async () => {
    rig.store.recordReviewedHead(PR, { head_sha: HEAD, verdict: "REQUEST_CHANGES", round_no: 1 });
    const body = rig.write(`pr-${PR}-round-1-review.md`, "again");
    const c = await rig.connect("c-round");
    const ask = () =>
      c.request("post.review", { pr: PR, event: "REQUEST_CHANGES", body_file: body }, { pr: PR });
    await expect(ask()).rejects.toMatchObject({ code: "blocked", message: /no-new-evidence/ });
    expect(rig.gh.posts()).toEqual([]);
    expect(dryrunRecords()).toEqual([]);
    expect(receipt()).toMatchObject({ status: "skipped", skip_reason: "no-new-evidence" });
    await expect(ask()).rejects.toMatchObject({ code: "blocked", message: /already refused/ });
  });

  it("refuses to post while a required pass failed and never completed", async () => {
    const plan: PassPlanEntry[] = [
      {
        lens: "pass-baseline",
        agent: "pass-baseline--sol-high",
        tier: "sol-high",
        raisable_to: [],
        required: true,
      },
    ];
    rig.store.startRound(PR, "first", ["pass-baseline"], 30, { pass_plan: plan });
    mkdirSync(join(rig.root, "state", "round-progress"), { recursive: true });
    writeFileSync(
      join(rig.root, "state", "round-progress", `pr-${PR}.json`),
      JSON.stringify({
        version: 2,
        pr: PR,
        session: `pr-${PR}`,
        run_started_at: "2026-10-15T10:00:00.000Z",
        updated_at: "2026-10-15T10:00:03.000Z",
        parent_status: "active",
        command_id: "c",
        command_sha256: "a".repeat(64),
        command_accepted_at: "2026-10-15T10:00:00.000Z",
        preparing_at: "2026-10-15T10:00:00.000Z",
        first_lens_started_at: "2026-10-15T10:00:01.000Z",
        fanout_started_at: "2026-10-15T10:00:01.000Z",
        round_no: 1,
        head_sha: HEAD,
        last_activity_at: "2026-10-15T10:00:03.000Z",
        last_activity: "x",
        agents: [
          {
            execution_id: "call:pass-baseline#1",
            agent: "pass-baseline--sol-high",
            status: "failed",
            duration_ms: 1,
            tool_count: 0,
            started_at: "2026-10-15T10:00:01.000Z",
            finished_at: "2026-10-15T10:00:02.000Z",
            error: "timed out",
          },
        ],
      }),
    );
    const body = rig.write(`pr-${PR}-round-1-review.md`, "x");
    const c = await rig.connect("c-round");
    await expect(
      c.request("post.review", { pr: PR, event: "COMMENT", body_file: body }, { pr: PR }),
    ).rejects.toMatchObject({ code: "blocked", message: /required pass missing/ });
    expectNoTrace();
  });
});

describe("post.review live", () => {
  beforeEach(async () => {
    rig = await build(false);
    roundCommand();
  });

  it("posts through the gate, confirms the receipt, stamps the head and registers the comments", async () => {
    const body = rig.write(`pr-${PR}-round-1-review.md`, "live review");
    const comments = rig.write(`pr-${PR}-round-1-comments.json`, COMMENTS);
    const c = await rig.connect("c-round");
    const out = await c.request<PostOutcome>(
      "post.review",
      { pr: PR, event: "REQUEST_CHANGES", body_file: body, comments_file: comments },
      { pr: PR },
    );
    expect(out).toMatchObject({
      status: "posted",
      review_id: 501,
      review_url: `https://github.com/${REPO}/pull/${PR}#pullrequestreview-501`,
    });
    const posted = rig.gh.posts();
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toMatchObject({
      commit_id: HEAD,
      event: "REQUEST_CHANGES",
      body: `live review\n\n${postingMarker(KEY)}`,
    });
    expect(receipt()).toMatchObject({
      status: "confirmed",
      gh_review_id: 501,
      gh_commit_id: HEAD,
      gh_state: "CHANGES_REQUESTED",
      actual_event: "REQUEST_CHANGES",
    });
    expect(rig.journal.readJob(PR, 1)!.status).toBe("done");
    expect(rig.store.reviewedHead(PR)).toMatchObject({
      head_sha: HEAD,
      posted_event: "REQUEST_CHANGES",
    });
    expect(rig.store.isBotComment(501, "review")).toBe(true);
    expect(rig.store.isBotComment(7000, "review_comment")).toBe(true);
    expect(rig.store.botCommentRound(501, "review")).toBe(1);
    // A repeat is the recorded receipt, never a second POST.
    const again = await c.request<PostOutcome>(
      "post.review",
      { pr: PR, event: "REQUEST_CHANGES", body_file: body },
      { pr: PR },
    );
    expect(again.status).toBe("already_confirmed");
    expect(rig.gh.posts()).toHaveLength(1);
  });

  it("softens a REQUEST_CHANGES a human already approved, and the receipt says so", async () => {
    rig.gh.reviews = [
      {
        id: 1,
        user: { login: "bob" },
        state: "APPROVED",
        commit_id: HEAD,
        body: "",
        submitted_at: null,
      },
    ];
    const body = rig.write(`pr-${PR}-round-1-review.md`, "findings");
    const c = await rig.connect("c-round");
    await c.request(
      "post.review",
      { pr: PR, event: "REQUEST_CHANGES", body_file: body },
      { pr: PR },
    );
    expect(rig.gh.posts()[0]!.body.event).toBe("COMMENT");
    expect(receipt()).toMatchObject({
      status: "confirmed",
      intended_event: "REQUEST_CHANGES",
      actual_event: "COMMENT",
    });
  });

  it("refuses a head that moved since the round reviewed it (guard 5) and may post again after", async () => {
    rig.gh.pr.head = MOVED;
    const body = rig.write(`pr-${PR}-round-1-review.md`, "stale");
    const c = await rig.connect("c-round");
    await expect(
      c.request("post.review", { pr: PR, event: "COMMENT", body_file: body }, { pr: PR }),
    ).rejects.toMatchObject({ code: "blocked", message: /head-drift/ });
    expect(rig.gh.posts()).toEqual([]);
    expect(receipt()).toBeUndefined(); // the prepared receipt was taken back
    rig.gh.pr.head = HEAD;
    expect(
      (
        await c.request<PostOutcome>(
          "post.review",
          { pr: PR, event: "COMMENT", body_file: body },
          { pr: PR },
        )
      ).status,
    ).toBe("posted");
  });

  it("refuses a merged PR", async () => {
    rig.gh.pr.merged = true;
    const body = rig.write(`pr-${PR}-round-1-review.md`, "x");
    const c = await rig.connect("c-round");
    await expect(
      c.request("post.review", { pr: PR, event: "COMMENT", body_file: body }, { pr: PR }),
    ).rejects.toMatchObject({ code: "blocked", message: /pr-merged/ });
    expect(rig.gh.posts()).toEqual([]);
  });

  it("hands an unanswered POST to the outbox when the review is not on GitHub", async () => {
    rig.gh.failReviewPost = 502;
    const body = rig.write(`pr-${PR}-round-1-review.md`, "will defer");
    const c = await rig.connect("c-round");
    const out = await c.request<PostOutcome>(
      "post.review",
      { pr: PR, event: "REQUEST_CHANGES", body_file: body },
      { pr: PR },
    );
    expect(out.status).toBe("deferred");
    expect(receipt()).toMatchObject({ status: "deferred", intended_event: "REQUEST_CHANGES" });
    const job = readPostingJob(rig.journal.jobPath(PR, 1))!;
    expect(job).toMatchObject({ status: "pending", posting_key: KEY, mode: "live" });
    expect(job.deferred_at).toBeTruthy();
    expect(job.payload.body).toContain(postingMarker(KEY));
    // The session posting again is told it is deferred, never a second POST.
    rig.gh.failReviewPost = null;
    const again = await c.request<PostOutcome>(
      "post.review",
      { pr: PR, event: "REQUEST_CHANGES", body_file: body },
      { pr: PR },
    );
    expect(again.status).toBe("deferred");
    expect(rig.gh.posts().filter((p) => p.method === "POST")).toHaveLength(1);
  });

  it("confirms from GitHub when the unanswered POST had in fact landed", async () => {
    rig.gh.failReviewPost = "network";
    rig.gh.reviews = [
      {
        id: 777,
        user: { login: BOT },
        state: "CHANGES_REQUESTED",
        commit_id: HEAD,
        body: `landed\n\n${postingMarker(KEY)}`,
        submitted_at: null,
      },
    ];
    const body = rig.write(`pr-${PR}-round-1-review.md`, "landed");
    const c = await rig.connect("c-round");
    const out = await c.request<PostOutcome>(
      "post.review",
      { pr: PR, event: "REQUEST_CHANGES", body_file: body },
      { pr: PR },
    );
    expect(out).toMatchObject({ status: "posted", review_id: 777 });
    expect(receipt()).toMatchObject({ status: "confirmed", gh_review_id: 777 });
  });

  it("leaves the receipt prepared when GitHub explicitly refuses the post", async () => {
    rig.gh.failReviewPost = 422;
    const body = rig.write(`pr-${PR}-round-1-review.md`, "bad");
    const c = await rig.connect("c-round");
    await refusedWith(
      c.request("post.review", { pr: PR, event: "COMMENT", body_file: body }, { pr: PR }),
      "post_failed",
    );
    expect(receipt()).toMatchObject({ status: "prepared" });
    // The daemon keeps GitHub's answer; the wire carries only status and route.
    expect(rig.logs.some((l) => l.includes("upstream trouble"))).toBe(true);
    // Never a duplicate POST over an unknown outcome.
    rig.gh.failReviewPost = null;
    await expect(
      c.request("post.review", { pr: PR, event: "COMMENT", body_file: body }, { pr: PR }),
    ).rejects.toMatchObject({ code: "blocked", message: /still unknown/ });
  });
});

describe("post.approval", () => {
  beforeEach(async () => {
    rig = await build(true);
    roundCommand();
  });

  it("records the approval and clears both wake triggers, in dry-run, in approve-pr.sh's order", async () => {
    const body = rig.write(`pr-${PR}-round-1-approve.md`, "LGTM");
    const c = await rig.connect("c-round");
    const out = await c.request<PostOutcome>(
      "post.approval",
      { pr: PR, body_file: body },
      { pr: PR },
    );
    expect(out.status).toBe("dryrun");
    expect(rig.gh.posts()).toEqual([]);
    const recs = dryrunRecords();
    expect(recs.map((r) => r.kind)).toEqual([
      "create_review",
      "remove_label",
      "delete_team_review_request",
    ]);
    expect(recs[0]!.body).toMatchObject({
      event: "APPROVE",
      commit_id: HEAD,
      body: `LGTM\n\n${postingMarker(KEY)}`,
    });
    expect(recs[1]!.path).toContain(`/issues/${PR}/labels/AI%20review%20requested`);
    expect(receipt()).toMatchObject({ status: "dryrun", actual_event: "APPROVE" });
  });

  it("refuses over red CI where the gate would soften, and takes the queued approval back", async () => {
    rig.gh.checks = [{ name: "ci", status: "completed", conclusion: "failure" }];
    const body = rig.write(`pr-${PR}-round-1-approve.md`, "LGTM");
    const c = await rig.connect("c-round");
    await expect(
      c.request("post.approval", { pr: PR, body_file: body }, { pr: PR }),
    ).rejects.toMatchObject({ code: "blocked", message: /ci-not-green/ });
    expect(dryrunRecords()).toEqual([]);
    expect(receipt()).toBeUndefined();
    // The session's COMMENT under the same key is accepted: no stale APPROVE job.
    const out = await c.request<PostOutcome>(
      "post.review",
      { pr: PR, event: "COMMENT", body_file: body },
      { pr: PR },
    );
    expect(out.status).toBe("dryrun");
  });

  it("reads the body as approve-pr.sh does: every trailing newline is stripped, CR is kept", async () => {
    const body = rig.write(`pr-${PR}-round-1-approve.md`, "LGTM\r\nnits\n\n\n");
    const c = await rig.connect("c-round");
    await c.request("post.approval", { pr: PR, body_file: body }, { pr: PR });
    expect(dryrunRecords()[0]!.body.body).toBe(`LGTM\r\nnits\n\n${postingMarker(KEY)}`);
  });

  it("uses the default body when no file is named", async () => {
    const c = await rig.connect("c-round");
    await c.request("post.approval", { pr: PR }, { pr: PR });
    expect(dryrunRecords()[0]!.body.body).toContain("Automated review: approved.");
  });
});

describe("post.reply", () => {
  beforeEach(async () => {
    rig = await build(true);
    plainCommand("c-answer", { may_post: true, answer: true });
  });

  it("records the reply through the gate", async () => {
    const body = rig.write(`pr-${PR}-reply.md`, "thanks, fixed");
    const c = await rig.connect("c-answer");
    const out = await c.request<PostOutcome>(
      "post.reply",
      { pr: PR, comment_id: 9001, body_file: body },
      { pr: PR },
    );
    expect(out.status).toBe("dryrun");
    expect(dryrunRecords()).toEqual([
      expect.objectContaining({
        kind: "create_review_comment_reply",
        path: `/repos/${REPO}/pulls/${PR}/comments/9001/replies`,
        body: { body: "thanks, fixed" },
        pr: PR,
      }),
    ]);
  });

  it("refuses a bad comment id", async () => {
    const body = rig.write(`pr-${PR}-reply.md`, "x");
    const c = await rig.connect("c-answer");
    await refusedWith(
      c.request("post.reply", { pr: PR, comment_id: "abc", body_file: body }, { pr: PR }),
      "bad_request",
    );
  });
});

describe("post.reply live", () => {
  beforeEach(async () => {
    rig = await build(false);
    plainCommand("c-answer", { may_post: true, answer: true });
  });

  it("posts the reply and registers it as the bot's own comment", async () => {
    const body = rig.write(`pr-${PR}-reply.md`, "thanks, fixed");
    const c = await rig.connect("c-answer");
    const out = await c.request<PostOutcome>(
      "post.reply",
      { pr: PR, comment_id: 9001, body_file: body },
      { pr: PR },
    );
    expect(out.status).toBe("posted");
    expect(rig.gh.posts()).toEqual([
      expect.objectContaining({
        method: "POST",
        path: `/pulls/${PR}/comments/9001/replies`,
        body: { body: "thanks, fixed" },
      }),
    ]);
    // the reconcile's ungated-review audit reads this to excuse the reply's
    // wrapper review (execboundary.ts isGatedReplyWrapper)
    expect(rig.store.isBotComment(9100, "review_comment")).toBe(true);
    expect(rig.store.botCommentIds(PR)).toContain(9100);
  });
});

describe("what a post can never be", () => {
  const ASKS: Array<[string, (body: string, pr?: number) => Record<string, unknown>]> = [
    ["post.review", (body, pr = PR) => ({ pr, event: "COMMENT", body_file: body })],
    ["post.approval", (body, pr = PR) => ({ pr, body_file: body })],
    ["post.reply", (body, pr = PR) => ({ pr, comment_id: 9001, body_file: body })],
  ];

  beforeEach(async () => {
    rig = await build(true);
    roundCommand();
  });

  it.each(ASKS)("%s: a request for another PR is refused", async (op, ask) => {
    const body = rig.write(`pr-${PR}-x.md`, "x");
    const c = await rig.connect("c-round");
    // named in the body only, in the envelope only, and in both
    await refusedWith(c.request(op, ask(body, OTHER_PR), { pr: PR }), "wrong_pr");
    await refusedWith(c.request(op, ask(body, PR), { pr: OTHER_PR }), "wrong_pr");
    await refusedWith(c.request(op, ask(body, OTHER_PR), { pr: OTHER_PR }), "wrong_pr");
    await refusedWith(c.request(op, { ...ask(body), pr: undefined }, { pr: PR }), "wrong_pr");
    expectNoTrace();
  });

  it.each(ASKS)("%s: a stale generation is refused", async (op, ask) => {
    const body = rig.write(`pr-${PR}-x.md`, "x");
    const c = await rig.connect("c-round", { generation: 0 });
    await refusedWith(c.request(op, ask(body), { pr: PR }), "stale_generation");
    // and the daemon bumping the session's generation fences a live client
    const live = await rig.connect("c-round", { generation: 1 });
    rig.rows.get("c-round")!.generation = 2;
    await refusedWith(live.request(op, ask(body), { pr: PR }), "stale_generation");
    expectNoTrace();
  });

  it("a wrong or another command's capability is refused at the hello", async () => {
    roundCommand("c-other");
    const otherCap = rig.caps.get("c-other")!;
    await expect(rig.connect("c-round", { capability: otherCap })).rejects.toMatchObject({
      code: "unauthorized",
    });
    await expect(rig.connect("c-round", { capability: "0".repeat(32) })).rejects.toMatchObject({
      code: "unauthorized",
    });
    expectNoTrace();
  });

  it("a revoked capability posts nothing", async () => {
    const body = rig.write(`pr-${PR}-x.md`, "x");
    const c = await rig.connect("c-round");
    rig.caps.revoke("c-round");
    await expect(c.request("post.review", ASKS[0]![1](body), { pr: PR })).rejects.toBeDefined();
    expectNoTrace();
  });

  it.each(ASKS)("%s: a path outside the PR's own directories is refused", async (op, ask) => {
    const outside = mkdtempSync(join(tmpdir(), "po-out-"));
    try {
      writeFileSync(join(outside, "pr-7-body.md"), "elsewhere");
      const other = rig.write(`pr-${OTHER_PR}-round-1-review.md`, "another PR's file");
      const plain = rig.write("notes.md", "not a pr- file");
      const target = join(outside, "secret.md");
      writeFileSync(target, "secret");
      symlinkSync(target, join(rig.state, `pr-${PR}-link.md`));
      const c = await rig.connect("c-round");
      const paths = [
        join(outside, "pr-7-body.md"), // outside the sandbox
        other, // another PR's file in the shared dir
        plain, // right dir, not a pr-7 file
        join(rig.state, `pr-${PR}-link.md`), // a symlink out
        join(rig.state, "..", "..", "etc", "hostname"), // traversal
        "/etc/hostname",
        `state/pr-${PR}-x.md`, // relative
        join(rig.state, "posting-receipts"), // a directory
      ];
      for (const p of paths)
        await expect(c.request(op, ask(p), { pr: PR }), p).rejects.toMatchObject({
          code: expect.stringMatching(/^(bad_path|bad_request)$/),
        });
      expectNoTrace();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("a file in the command's own dir is accepted whatever it is called", async () => {
    const own = rig.write("review.md", "from my dir", join(rig.state, "commands", "c-round"));
    const c = await rig.connect("c-round");
    const out = await c.request<PostOutcome>(
      "post.review",
      { pr: PR, event: "COMMENT", body_file: own },
      { pr: PR },
    );
    expect(out.status).toBe("dryrun");
    // another command's dir is not this command's
    const theirs = rig.write("review.md", "x", join(rig.state, "commands", "c-someone-else"));
    await refusedWith(
      c.request("post.review", { pr: PR, event: "COMMENT", body_file: theirs }, { pr: PR }),
      "bad_path",
    );
  });

  it("an oversize result file is refused", async () => {
    const big = rig.write(`pr-${PR}-big.md`, "x".repeat(1024 * 1024 + 1));
    const c = await rig.connect("c-round");
    await refusedWith(
      c.request("post.review", { pr: PR, event: "COMMENT", body_file: big }, { pr: PR }),
      "bad_path",
    );
  });

  it("a round's identity restated in the request must be the command's own", async () => {
    const body = rig.write(`pr-${PR}-x.md`, "x");
    const c = await rig.connect("c-round");
    const base = { pr: PR, event: "COMMENT", body_file: body };
    await refusedWith(
      c.request("post.review", { ...base, round_no: 2 }, { pr: PR }),
      "bad_request",
    );
    await refusedWith(
      c.request("post.review", { ...base, expected_head: MOVED }, { pr: PR }),
      "bad_request",
    );
    await refusedWith(
      c.request("post.review", { ...base, posting_key: roundPostingKey(PR, 1, MOVED) }, { pr: PR }),
      "bad_request",
    );
    expectNoTrace();
  });

  it.each(ASKS)("%s: any post under a takeover lease is refused", async (op, ask) => {
    plainCommand("c-takeover", { lease: "takeover" });
    rig.rounds.set("c-takeover", { round_no: 1, head_sha: HEAD });
    const body = rig.write(`pr-${PR}-x.md`, "x");
    const c = await rig.connect("c-takeover");
    await refusedWith(c.request(op, ask(body), { pr: PR }), "lease_takeover");
    // also from a worker role, and even with may_post
    plainCommand("c-takeover2", { lease: "takeover", may_post: true, answer: true });
    const w = await rig.connect("c-takeover2", { role: "worker" });
    await refusedWith(w.request(op, ask(body), { pr: PR }), "lease_takeover");
    expectNoTrace();
  });

  it.each(ASKS)("%s: an answer worker without may_post is refused", async (op, ask) => {
    plainCommand("c-answer", { answer: true, may_post: false });
    const body = rig.write(`pr-${PR}-x.md`, "x");
    const c = await rig.connect("c-answer");
    await refusedWith(c.request(op, ask(body), { pr: PR }), "may_post_required");
    expectNoTrace();
  });

  it.each(ASKS)("%s: an answer worker WITH may_post posts through the gate", async (op, ask) => {
    plainCommand("c-answer", { answer: true, may_post: true });
    const body = rig.write(`pr-${PR}-x.md`, "x");
    const c = await rig.connect("c-answer");
    const out = await c.request<PostOutcome>(op, ask(body), { pr: PR });
    expect(out.status).toBe("dryrun");
    expect(dryrunRecords().length).toBeGreaterThan(0);
    expect(rig.gh.posts()).toEqual([]);
    // an unkeyed command leaves no receipt: it has no round
    expect(existsSync(receiptsDir())).toBe(false);
  });

  it.each(ASKS)("%s: a debug-round lease may post", async (op, ask) => {
    roundCommand("c-debug", { lease: "debug" });
    const body = rig.write(`pr-${PR}-x.md`, "x");
    const c = await rig.connect("c-debug");
    expect((await c.request<PostOutcome>(op, ask(body), { pr: PR })).status).toBe("dryrun");
  });

  it("an unkeyed command may not claim a round", async () => {
    plainCommand("c-answer", { answer: true, may_post: true });
    const body = rig.write(`pr-${PR}-x.md`, "x");
    const c = await rig.connect("c-answer");
    await refusedWith(
      c.request(
        "post.review",
        { pr: PR, event: "COMMENT", body_file: body, round_no: 1 },
        { pr: PR },
      ),
      "bad_request",
    );
  });

  it("an unkeyed review is posted at the live head", async () => {
    plainCommand("c-answer", { answer: true, may_post: true });
    const body = rig.write(`pr-${PR}-x.md`, "x");
    const c = await rig.connect("c-answer");
    await c.request("post.review", { pr: PR, event: "COMMENT", body_file: body }, { pr: PR });
    expect(dryrunRecords()[0]!.body.commit_id).toBe(HEAD);
  });
});

describe("AGENTS.md invariant 2: no path here retracts a review", () => {
  it("registers exactly the three post ops and imports no dismissal", () => {
    const text = readFileSync(join(SANDBOX, "src", "postops.ts"), "utf8");
    expect(text).not.toMatch(/dismiss|supersede|forceLive|\bfetch\(/i);
    expect(GitHubRequestError).toBeDefined();
  });
});
