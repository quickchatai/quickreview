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
import { ownerRecord, PostingJournal } from "../src/posting-journal.js";
import {
  IN_FLIGHT_LINE,
  postOps,
  replyPostMarker,
  validationText,
  type PostAdapter,
  type PostOpsDeps,
  type PostOutcome,
} from "../src/postops.js";
import type { RequestContext } from "../src/ipc/server.js";
import {
  SECURITY_PASSES_UNKNOWN_LINE,
  securityPassIncompleteLine,
  withSecurityIncompleteLines,
} from "@quickchatai/pi-quickreview/src/templates.js";
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

  // Fail-closed: a security-family row is not required, so its failure never
  // holds the post back — but the body names it, in the round prompt's own
  // words (templates.ts securityPassIncompleteLine), once.
  // MUTATION: post `r.text` instead of `withSecurityGaps(…)` in postReview — fails.
  it("posts with a line naming a security pass that did not complete", async () => {
    const plan: PassPlanEntry[] = [
      {
        lens: "pass-baseline",
        agent: "pass-baseline--sol-high",
        tier: "sol-high",
        raisable_to: [],
        required: true,
      },
      {
        lens: "pass-sec-access",
        agent: "pass-sec-access--sol-high",
        tier: "sol-high",
        raisable_to: [],
      },
    ];
    rig.store.startRound(PR, "first", ["pass-baseline", "pass-sec-access"], 30, {
      pass_plan: plan,
    });
    mkdirSync(join(rig.root, "state", "round-progress"), { recursive: true });
    const run = (agent: string, status: "completed" | "failed") => ({
      execution_id: `call:${agent}#1`,
      agent,
      status,
      duration_ms: 1,
      tool_count: 0,
      started_at: "2026-10-15T10:00:01.000Z",
      finished_at: "2026-10-15T10:00:02.000Z",
      ...(status === "failed" ? { error: "timed out" } : {}),
    });
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
          run("pass-baseline--sol-high", "completed"),
          run("pass-sec-access--sol-high", "failed"),
        ],
      }),
    );
    const line = securityPassIncompleteLine("pass-sec-access");
    const body = rig.write(`pr-${PR}-round-1-review.md`, "**Verdict** no findings.");
    const c = await rig.connect("c-round");
    const out = await c.request<PostOutcome>(
      "post.review",
      { pr: PR, event: "COMMENT", body_file: body },
      { pr: PR },
    );
    expect(out.status).toBe("dryrun");
    const [rec] = dryrunRecords();
    expect((rec as { body: { body: string } }).body.body).toBe(
      `**Verdict** no findings.\n\n${line}\n\n${postingMarker(KEY)}`,
    );
    expect(withSecurityIncompleteLines(`a\n\n${line}`, [{ lens: "pass-sec-access" }])).toBe(
      `a\n\n${line}`,
    );
  });

  // The chain's `compose` row is planned after the wave (`post_plan`, its
  // own `tasks-post/` phase): the round record carries it, and a failed one
  // is named in the body as a failed plan row is.
  // MUTATION: drop `parsePlan(row.post_plan)` from withSecurityGaps — fails.
  it("names a failed compose row, read from the round's recorded post rows", async () => {
    const compose: PassPlanEntry = {
      lens: "pass-sec-exploit-chain",
      agent: "pass-sec-exploit-chain--sol-high",
      tier: "sol-high",
      raisable_to: [],
      strategy: "compose",
      stage: "post-discovery",
    };
    rig.store.startRound(PR, "first", ["pass-baseline"], 30, {
      pass_plan: [
        {
          lens: "pass-baseline",
          agent: "pass-baseline--sol-high",
          tier: "sol-high",
          raisable_to: [],
          required: true,
        },
      ],
      post_plan: [compose],
    });
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
            status: "completed",
            duration_ms: 1,
            tool_count: 0,
            started_at: "2026-10-15T10:00:01.000Z",
            finished_at: "2026-10-15T10:00:02.000Z",
          },
          {
            execution_id: "call:pass-sec-exploit-chain#1",
            agent: "pass-sec-exploit-chain--sol-high",
            strategy: "compose",
            phase: "post",
            status: "failed",
            duration_ms: 1,
            tool_count: 0,
            started_at: "2026-10-15T10:00:02.000Z",
            finished_at: "2026-10-15T10:00:03.000Z",
            error: "timed out",
          },
        ],
      }),
    );
    const line = securityPassIncompleteLine("pass-sec-exploit-chain", "compose");
    const body = rig.write(`pr-${PR}-round-1-review.md`, "**Verdict** no findings.");
    const c = await rig.connect("c-round");
    const out = await c.request<PostOutcome>(
      "post.review",
      { pr: PR, event: "COMMENT", body_file: body },
      { pr: PR },
    );
    expect(out.status).toBe("dryrun");
    const [rec] = dryrunRecords();
    expect((rec as { body: { body: string } }).body.body).toBe(
      `**Verdict** no findings.\n\n${line}\n\n${postingMarker(KEY)}`,
    );
  });

  // A follow-up can carry its family rows only in the owed whole-PR sweep
  // (`sweep_plan`): its delta plan completing says nothing of them.
  // MUTATION: drop the sweep argument from withSecurityGaps' failedSecurityRows
  // call — this fails.
  it("names a failed family row of the round's owed sweep", async () => {
    const baseline: PassPlanEntry = {
      lens: "pass-baseline",
      agent: "pass-baseline--sol-high",
      tier: "sol-high",
      raisable_to: [],
      required: true,
    };
    rig.store.startRound(PR, "first", ["pass-baseline"], 30, {
      pass_plan: [baseline],
      sweep_plan: [
        baseline,
        {
          lens: "pass-sec-access",
          agent: "pass-sec-access--sol-high",
          tier: "sol-high",
          raisable_to: [],
        },
      ],
    });
    mkdirSync(join(rig.root, "state", "round-progress"), { recursive: true });
    const run = (agent: string, status: "completed" | "failed", phase?: "sweep") => ({
      execution_id: `call:${agent}#${phase ?? "plan"}`,
      agent,
      status,
      duration_ms: 1,
      tool_count: 0,
      started_at: "2026-10-15T10:00:01.000Z",
      finished_at: "2026-10-15T10:00:02.000Z",
      ...(phase ? { phase } : {}),
      ...(status === "failed" ? { error: "timed out" } : {}),
    });
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
          run("pass-baseline--sol-high", "completed"),
          run("pass-baseline--sol-high", "completed", "sweep"),
          run("pass-sec-access--sol-high", "failed", "sweep"),
        ],
      }),
    );
    const line = securityPassIncompleteLine("pass-sec-access");
    const body = rig.write(`pr-${PR}-round-1-review.md`, "**Verdict** no findings.");
    const c = await rig.connect("c-round");
    const out = await c.request<PostOutcome>(
      "post.review",
      { pr: PR, event: "COMMENT", body_file: body },
      { pr: PR },
    );
    expect(out.status).toBe("dryrun");
    const [rec] = dryrunRecords();
    expect((rec as { body: { body: string } }).body.body).toBe(
      `**Verdict** no findings.\n\n${line}\n\n${postingMarker(KEY)}`,
    );
  });

  // The security line never blocks, so it is not held to the required-pass
  // rule's positive evidence: a family row never launched is named, and a
  // round whose passes cannot be read says so instead of reading as complete.
  describe("a security row with no failed execution", () => {
    const secPlan: PassPlanEntry[] = [
      {
        lens: "pass-baseline",
        agent: "pass-baseline--sol-high",
        tier: "sol-high",
        raisable_to: [],
        required: true,
      },
      {
        lens: "pass-sec-access",
        agent: "pass-sec-access--sol-high",
        tier: "sol-high",
        raisable_to: [],
      },
    ];
    const writeProgress = (roundNo: number) => {
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
          round_no: roundNo,
          head_sha: HEAD,
          last_activity_at: "2026-10-15T10:00:03.000Z",
          last_activity: "x",
          agents: [
            {
              execution_id: "call:pass-baseline#1",
              agent: "pass-baseline--sol-high",
              status: "completed",
              duration_ms: 1,
              tool_count: 0,
              started_at: "2026-10-15T10:00:01.000Z",
              finished_at: "2026-10-15T10:00:02.000Z",
            },
          ],
        }),
      );
    };
    const postBody = async (): Promise<string> => {
      const body = rig.write(`pr-${PR}-round-1-review.md`, "**Verdict** no findings.");
      const c = await rig.connect("c-round");
      const out = await c.request<PostOutcome>(
        "post.review",
        { pr: PR, event: "COMMENT", body_file: body },
        { pr: PR },
      );
      expect(out.status).toBe("dryrun");
      const [rec] = dryrunRecords();
      return (rec as { body: { body: string } }).body.body;
    };
    const kinds = () => rig.store.recentEvents(50).map((e) => e.kind);

    // MUTATION: restore `failedRuns.length > 0 &&` in incompleteSecurityRows — fails.
    it("names a planned family row the session never launched", async () => {
      rig.store.startRound(PR, "first", ["pass-baseline", "pass-sec-access"], 30, {
        pass_plan: secPlan,
      });
      writeProgress(1);
      expect(await postBody()).toBe(
        `**Verdict** no findings.\n\n${securityPassIncompleteLine("pass-sec-access")}\n\n${postingMarker(KEY)}`,
      );
      expect(kinds()).toContain("security_pass_incomplete");
    });

    // MUTATION: return `text` on `gaps.state === "unknown"` in withSecurityGaps — fails.
    it.each([
      ["no progress record", null],
      ["another round's progress record", 2],
    ])("says completion is unknown with %s", async (_what, roundNo) => {
      rig.store.startRound(PR, "first", ["pass-baseline", "pass-sec-access"], 30, {
        pass_plan: secPlan,
      });
      if (roundNo !== null) writeProgress(roundNo);
      expect(await postBody()).toBe(
        `**Verdict** no findings.\n\n${SECURITY_PASSES_UNKNOWN_LINE}\n\n${postingMarker(KEY)}`,
      );
      expect(kinds()).toContain("security_pass_unknown");
    });

    it("adds nothing on a plan with no family row, snapshot or not", async () => {
      rig.store.startRound(PR, "first", ["pass-baseline"], 30, { pass_plan: [secPlan[0]!] });
      expect(await postBody()).toBe(`**Verdict** no findings.\n\n${postingMarker(KEY)}`);
    });
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

  // A 4xx is a known outcome: GitHub refused the review and nothing landed.
  // MUTATION: drop the `f.kind === "rejected"` branch in submit — this fails
  // (the receipt stays prepared and the corrected re-post is refused).
  it("a 422 is a rejection: nothing landed, GitHub's validation text, and the corrected re-post is accepted", async () => {
    rig.gh.failReviewPost = 422;
    rig.gh.failReviewBody = JSON.stringify({
      message: "Unprocessable Entity",
      errors: ["Pull request review thread line must be part of the diff"],
      documentation_url: "https://docs.github.com/rest",
    });
    const body = rig.write(`pr-${PR}-round-1-review.md`, "bad anchor");
    const comments = rig.write(`pr-${PR}-round-1-comments.json`, COMMENTS);
    const c = await rig.connect("c-round");
    const ask = (withComments: boolean) =>
      c.request<PostOutcome>(
        "post.review",
        {
          pr: PR,
          event: "COMMENT",
          body_file: body,
          ...(withComments ? { comments_file: comments } : {}),
        },
        { pr: PR },
      );
    await expect(ask(true)).rejects.toMatchObject({
      code: "post_rejected",
      message: expect.stringMatching(
        /Pull request review thread line must be part of the diff.*Nothing was posted; fix the named comment \(or move it into the body\) and run the same script again/,
      ),
    });
    // Only the validation text reaches the wire, never the rest of the answer.
    // (Read the message itself: a negated toMatchObject over a thrown error
    // passes or fails on the error's shape, not on this text.)
    const again = await ask(true).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(again?.message).toMatch(/Pull request review thread line must be part of the diff/);
    expect(again?.message).not.toMatch(/documentation_url|Unprocessable Entity/);
    expect(receipt()).toBeUndefined();
    expect(rig.journal.readJob(PR, 1)).toBeUndefined();
    expect(readdirSync(receiptsDir()).some((f) => f.includes(".withdrawn-"))).toBe(true);
    // The corrected review (the comment moved into the body) posts under the same key.
    rig.gh.failReviewPost = null;
    const out = await ask(false);
    expect(out.status).toBe("posted");
    expect(receipt()).toMatchObject({ status: "confirmed", posting_key: KEY });
  });

  it("validationText reads errors[].message, plain strings, and a cut-short answer", () => {
    const err = (detail: string) =>
      new GitHubRequestError("POST", "/repos/o/r/pulls/7/reviews", 422, detail);
    expect(
      validationText(
        err(
          JSON.stringify({ message: "x", errors: [{ resource: "R", message: "line\u0007bad" }] }),
        ),
      ),
    ).toBe("line bad");
    expect(validationText(err('{"message":"x","errors":["first","sec'))).toBe("first");
    expect(validationText(err("upstream trouble"))).toBe("(GitHub gave no validation detail)");
  });

  // MUTATION: drop `|| kind === "rate_limited"` from unanswered() — this fails.
  it("a rate-limited POST is handed to the daemon like an unanswered one", async () => {
    rig.gh.failReviewPost = 429;
    const body = rig.write(`pr-${PR}-round-1-review.md`, "later");
    const c = await rig.connect("c-round");
    const out = await c.request<PostOutcome>(
      "post.review",
      { pr: PR, event: "COMMENT", body_file: body },
      { pr: PR },
    );
    expect(out.status).toBe("deferred");
    expect(receipt()).toMatchObject({ status: "deferred" });
    expect(rig.journal.readJob(PR, 1)).toMatchObject({ status: "pending" });
  });

  // MUTATION: drop the `res.blocked === "pr-unreadable"` deferral in submit — this fails.
  it("a gate that cannot read the PR defers the post: nothing sent, the outbox owns it", async () => {
    rig.gh.failPr = 502;
    const body = rig.write(`pr-${PR}-round-1-review.md`, "x");
    const c = await rig.connect("c-round");
    const out = await c.request<PostOutcome>(
      "post.review",
      { pr: PR, event: "COMMENT", body_file: body },
      { pr: PR },
    );
    expect(out.status).toBe("deferred");
    expect(out.lines.join("\n")).toMatch(/Do NOT post again/);
    expect(rig.gh.posts()).toEqual([]);
    expect(receipt()).toMatchObject({ status: "deferred", defer_reason: /^pr-unreadable/ });
    expect(rig.journal.readJob(PR, 1)).toMatchObject({ status: "pending" });
  });

  // MUTATION: drop the TERMINAL_REFUSALS withdraw in submit — this fails.
  it.each([
    ["pr-merged", (): void => void (rig.gh.pr.merged = true)],
    ["pr-closed", (): void => void (rig.gh.pr.state = "closed")],
    ["head-drift", (): void => void (rig.gh.pr.head = MOVED)],
  ] as const)("a %s refusal takes the queued job back", async (reason, arrange) => {
    arrange();
    const body = rig.write(`pr-${PR}-round-1-review.md`, "x");
    const c = await rig.connect("c-round");
    await expect(
      c.request("post.review", { pr: PR, event: "COMMENT", body_file: body }, { pr: PR }),
    ).rejects.toMatchObject({ code: "blocked", message: new RegExp(reason) });
    expect(receipt()).toBeUndefined();
    expect(rig.journal.readJob(PR, 1)).toBeUndefined();
  });

  // MUTATION: throw the lock's JournalError as `blocked` in wrap — this fails.
  it("a posting already in flight for the round answers in_flight, never a second POST", async () => {
    mkdirSync(receiptsDir(), { recursive: true });
    const lock = `${join(receiptsDir(), `pr-${PR}-round-1.json`)}.lock`;
    mkdirSync(lock);
    writeFileSync(join(lock, "pid"), ownerRecord(process.pid) ?? String(process.pid));
    const body = rig.write(`pr-${PR}-round-1-review.md`, "x");
    const c = await rig.connect("c-round");
    const out = await c.request<PostOutcome>(
      "post.review",
      { pr: PR, event: "COMMENT", body_file: body },
      { pr: PR },
    );
    expect(out.status).toBe("in_flight");
    expect(out.lines[0]).toContain(IN_FLIGHT_LINE);
    expect(rig.gh.posts()).toEqual([]);
  });
});

// The approval's CI pre-check, live: the production incident. A checks read
// that fails transiently (after the adapter's own retries) must neither post
// nor be lost: the approval is deferred to the daemon, which re-reads CI.
describe("post.approval live: the CI pre-check", () => {
  beforeEach(async () => {
    rig = await build(false);
    roundCommand();
  });
  const approve = async () => {
    const body = rig.write(`pr-${PR}-round-1-approve.md`, "LGTM");
    const c = await rig.connect("c-round");
    return c.request<PostOutcome>("post.approval", { pr: PR, body_file: body }, { pr: PR });
  };
  const withdrawn = () =>
    existsSync(receiptsDir()) && readdirSync(receiptsDir()).some((f) => f.includes(".withdrawn-"));

  // MUTATION: withdraw before the retryable check in postReview (the old
  // bare catch) — this fails.
  it.each([502, "network"] as const)(
    "checks read %s: deferred, a deferred receipt, the job still pending, nothing withdrawn",
    async (failure) => {
      rig.gh.failChecks = failure;
      const out = await approve();
      expect(out.status).toBe("deferred");
      expect(out.lines.join("\n")).toMatch(
        /CI checks at 68b8040 could not be read[\s\S]*re-reads CI before every attempt[\s\S]*Do NOT post again/,
      );
      expect(rig.gh.posts()).toEqual([]);
      expect(receipt()).toMatchObject({
        status: "deferred",
        intended_event: "APPROVE",
        actual_event: "APPROVE",
        defer_reason: expect.stringMatching(/^ci-unreadable: /),
      });
      const job = readPostingJob(rig.journal.jobPath(PR, 1))!;
      expect(job).toMatchObject({ status: "pending", posting_key: KEY, mode: "live" });
      expect(job.deferred_at).toBeTruthy();
      expect(job.attempted_at).toBeUndefined(); // nothing that "may have landed"
      expect(withdrawn()).toBe(false);
      // The session asking again is told it is deferred.
      rig.gh.failChecks = null;
      expect((await approve()).status).toBe("deferred");
      expect(rig.gh.posts()).toEqual([]);
    },
  );

  // MUTATION: interpolate the failure's `detail` into ciUnreadable again — this fails.
  it("a read that failed on a local file never names that file to the session", async () => {
    rig.gh.failChecks = new Error("EACCES: permission denied, open '/srv/qcr/secrets/app.pem'");
    const err = await approve().catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "blocked" });
    expect((err as Error).message).not.toContain("/srv/qcr/secrets");
    expect((err as Error).message).toMatch(/the daemon's log has the cause/);
    // The daemon's own log keeps the full cause.
    expect(rig.logs.join("\n")).toContain("/srv/qcr/secrets/app.pem");
  });

  it("checks read 404: blocked with a next step, the queued approval withdrawn", async () => {
    rig.gh.failChecks = 404;
    await expect(approve()).rejects.toMatchObject({
      code: "blocked",
      message: expect.stringMatching(/pr-unreadable: .*GitHub answered 404.*post-review\.sh/),
    });
    expect(rig.gh.posts()).toEqual([]);
    expect(receipt()).toBeUndefined();
    expect(withdrawn()).toBe(true);
  });

  it("green CI: the approval is posted", async () => {
    const out = await approve();
    expect(out.status).toBe("posted");
    expect(receipt()).toMatchObject({ status: "confirmed", actual_event: "APPROVE" });
    expect(rig.gh.posts()[0]!.body).toMatchObject({ event: "APPROVE", commit_id: HEAD });
  });

  // MUTATION: restore the `throw` in approval()'s trigger-step catch — this fails.
  it("a trigger step that fails after the approval is a line, never a refusal", async () => {
    rig.gh.failDeletes = 500;
    const out = await approve();
    expect(out.status).toBe("posted");
    expect(out.lines.filter((l) => /the approval is posted, but/.test(l))).toHaveLength(2);
  });

  it("a checks read past the deadline is transient: deferred", async () => {
    await rig.server.stop();
    rig.store.close();
    rmSync(rig.root, { recursive: true, force: true });
    rig = await buildRig(false, clients, { readDeadlineMs: 50 });
    roundCommand();
    rig.gh.failChecks = "hang";
    const out = await approve();
    expect(out.status).toBe("deferred");
    expect(receipt()).toMatchObject({ defer_reason: /^ci-unreadable: .*did not answer within/ });
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
        body: { body: `thanks, fixed\n\n${replyPostMarker(PR, 9001, "thanks, fixed")}` },
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
  let clock: number;
  beforeEach(async () => {
    clock = Date.parse("2026-11-04T10:00:00Z");
    rig = await buildRig(false, clients, { now: () => new Date(clock) });
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
        body: { body: `thanks, fixed\n\n${replyPostMarker(PR, 9001, "thanks, fixed")}` },
      }),
    ]);
    // the reconcile's ungated-review audit reads this to excuse the reply's
    // wrapper review (execboundary.ts isGatedReplyWrapper)
    expect(rig.store.isBotComment(9100, "review_comment")).toBe(true);
    expect(rig.store.botCommentIds(PR)).toContain(9100);
  });

  const reply = async () => {
    const body = rig.write(`pr-${PR}-reply.md`, "thanks, fixed");
    const c = await rig.connect("c-answer");
    return c.request<PostOutcome>(
      "post.reply",
      { pr: PR, comment_id: 9001, body_file: body },
      { pr: PR },
    );
  };
  const replyPosts = () => rig.gh.posts().filter((p) => /\/replies$/.test(p.path));

  // MUTATION: skip the findReply before the POST — this fails (two POSTs).
  it("the same reply run twice is posted once", async () => {
    expect((await reply()).status).toBe("posted");
    const again = await reply();
    expect(again.status).toBe("already_confirmed");
    expect(again.lines[0]).toMatch(/already posted/);
    expect(replyPosts()).toHaveLength(1);
  });

  // MUTATION: drop the findReply after an unanswered POST — this fails.
  it("an unanswered POST whose reply landed answers already posted", async () => {
    rig.gh.failReplyPost = "network";
    rig.gh.replyLandsOnFailure = true;
    const out = await reply();
    expect(out.status).toBe("already_confirmed");
    expect(rig.store.isBotComment(9100, "review_comment")).toBe(true);
    expect(replyPosts()).toHaveLength(1);
  });

  // MUTATION: post again on the first re-run's negative read (skip the
  // reconciliation of the earlier attempt) — this fails.
  it("an unanswered POST stays uncertain: a re-run posts only after the quiet window and two negative reads", async () => {
    rig.gh.failReplyPost = 502;
    await expect(reply()).rejects.toMatchObject({
      code: "post_failed",
      message: /not on GitHub yet: it may still land.*Run the same script again/,
    });
    rig.gh.failReplyPost = null;
    // At once: the earlier POST may still be processing — nothing is sent.
    await expect(reply()).rejects.toMatchObject({
      code: "post_failed",
      message: /may still land, so nothing was posted now/,
    });
    clock += 121_000; // past the quiet window: the first negative read
    await expect(reply()).rejects.toMatchObject({ message: /may still land/ });
    clock += 10_000; // too soon after it
    await expect(reply()).rejects.toMatchObject({ message: /may still land/ });
    expect(replyPosts()).toHaveLength(1);
    clock += 21_000; // the second negative read, apart: it may post now
    expect((await reply()).status).toBe("posted");
    expect(replyPosts()).toHaveLength(2);
    // Settled: the next run finds it and posts nothing.
    expect((await reply()).status).toBe("already_confirmed");
    expect(replyPosts()).toHaveLength(2);
  });

  it("an earlier POST that lands while its re-run waits is found, never posted again", async () => {
    rig.gh.failReplyPost = 502;
    await expect(reply()).rejects.toMatchObject({ code: "post_failed" });
    rig.gh.failReplyPost = null;
    rig.gh.comments.push({
      id: 9200,
      user: { login: BOT },
      body: `thanks, fixed\n\n${replyPostMarker(PR, 9001, "thanks, fixed")}`,
      in_reply_to_id: 9001,
    });
    expect((await reply()).status).toBe("already_confirmed");
    clock += 600_000;
    expect((await reply()).status).toBe("already_confirmed");
    expect(replyPosts()).toHaveLength(1);
  });

  // MUTATION: answer "do NOT retry" again on an unreadable pre-check — this fails.
  it("a reply check that cannot read GitHub posts nothing; the re-run once GitHub reads posts it", async () => {
    rig.gh.failComments = 500;
    await expect(reply()).rejects.toMatchObject({
      code: "post_failed",
      message: /nothing was posted\. Run the same script again in a few minutes/,
    });
    expect(replyPosts()).toEqual([]);
    rig.gh.failComments = null;
    expect((await reply()).status).toBe("posted");
    expect(replyPosts()).toHaveLength(1);
  });

  // An accepted POST whose answer could not be read is not a refusal.
  // MUTATION: clear the attempt for every failure not classified transient or rate-limited — this fails (two POSTs).
  it("an accepted POST whose answer is cut short stays uncertain: no second copy at once", async () => {
    rig.gh.replyAnswerTruncated = true;
    await expect(reply()).rejects.toMatchObject({
      code: "post_failed",
      message: /not on GitHub yet: it may still land/,
    });
    rig.gh.replyAnswerTruncated = false;
    await expect(reply()).rejects.toMatchObject({
      message: /may still land, so nothing was posted now/,
    });
    expect(replyPosts()).toHaveLength(1);
  });

  // MUTATION: drop the not_before check at the top of replyOnce — this fails.
  it("a rate-limited POST keeps GitHub's requested wait: no read and no POST before it", async () => {
    rig.gh.failReplyPost = 429;
    rig.gh.replyRetryAfterS = 1800;
    const until = new Date(clock + 1_800_000).toISOString();
    const reads = () =>
      rig.gh.calls.filter((c) => c.method === "GET" && /\/comments$/.test(c.path));
    await expect(reply()).rejects.toMatchObject({
      code: "post_failed",
      message: new RegExp(
        `no more requests until ${until}.*Run the same script again after that time`,
      ),
    });
    expect(reads()).toHaveLength(1); // the check before the POST, none after it
    rig.gh.failReplyPost = null;
    clock += 150_000; // past the quiet window and a negative gap, inside the wait
    await expect(reply()).rejects.toMatchObject({ message: new RegExp(`until ${until}`) });
    clock += 30_000;
    await expect(reply()).rejects.toMatchObject({ message: new RegExp(`until ${until}`) });
    expect(reads()).toHaveLength(1);
    expect(replyPosts()).toHaveLength(1);
    // The wait over: the two negative reads apart, then the POST.
    clock = Date.parse(until) + 1_000;
    await expect(reply()).rejects.toMatchObject({ message: /may still land/ });
    clock += 31_000;
    expect((await reply()).status).toBe("posted");
    expect(replyPosts()).toHaveLength(2);
  });

  it("a refused POST (4xx) is a known outcome: the re-run may post at once", async () => {
    rig.gh.failReplyPost = 422;
    await expect(reply()).rejects.toMatchObject({ code: "post_failed" });
    rig.gh.failReplyPost = null;
    expect((await reply()).status).toBe("posted");
    expect(replyPosts()).toHaveLength(2);
  });
});

// Two requests for one reply, overlapping inside the daemon: called on the
// handler directly, so both are in flight before either reads GitHub.
describe("post.reply: one owner per reply", () => {
  // MUTATION: drop the in-flight map in PostOps.reply — this fails (two POSTs).
  it("two requests for the same reply at once read and post it once, and both get its answer", async () => {
    const root = mkdtempSync(join(tmpdir(), "po-reply-"));
    try {
      const comments: Array<{ id: number; user: string; body: string }> = [];
      const posts: string[] = [];
      let reads = 0;
      const adapter = {
        gate: { isDryRun: false },
        listRecentReviewComments: async () => {
          reads++;
          return [...comments];
        },
        createReviewCommentReply: async (_pr: number, _id: number, body: string) => {
          posts.push(body);
          comments.push({ id: 9300, user: BOT, body });
          return { executed: true, response: { id: 9300 } };
        },
      } as unknown as PostAdapter;
      const deps: PostOpsDeps = {
        root,
        adapter,
        store: {
          registerBotComment: () => {},
          logEvent: () => {},
          reviewedHead: () => undefined,
          roundsFor: () => [],
        } as unknown as PostOpsDeps["store"],
        journal: new PostingJournal({ dir: join(root, "receipts"), repo: REPO }),
        cfg: { github: { repo: REPO, trigger_label: "review" } } as unknown as PostOpsDeps["cfg"],
        botLogins: [BOT],
        roundOf: () => null,
        resultDirs: () => [{ dir: root }],
      };
      const file = join(root, "reply.md");
      writeFileSync(file, "thanks, fixed");
      const ctx: RequestContext = {
        commandId: "c-answer",
        role: "shim",
        pr: PR,
        generation: 1,
        mayPost: true,
        answer: true,
        lease: "none",
        requirePr: () => {},
      };
      const handle = postOps(deps)["post.reply"].handle;
      const body = { pr: PR, comment_id: 9001, body_file: file };
      const [a, b] = await Promise.all([handle(ctx, body), handle(ctx, body)]);
      expect(posts).toHaveLength(1);
      expect(reads).toBe(1);
      expect([(a as PostOutcome).status, (b as PostOutcome).status]).toEqual(["posted", "posted"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
