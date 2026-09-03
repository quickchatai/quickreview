import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseConfig, type Config } from "../src/config.js";
import { StateStore } from "../src/state.js";
import {
  applyInterpretation,
  handleDelivery,
  interpretEvent,
  mentionsBot,
  signBody,
  verifySignature,
  type Interpretation,
} from "../src/webhook.js";

const cfg: Config = parseConfig(
  readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8"),
);
const BOT = cfg.github.bot_login; // example-review[bot]
const SECRET = "it's a secret to everybody";

const deps = (botCommentPr: (id: number) => number | undefined = () => undefined) => ({
  botLogin: BOT,
  triggerLabel: cfg.github.trigger_label,
  reviewTeam: cfg.github.review_team,
  botCommentPr,
});

// ---- fixture payloads (shapes per findings §3.1) -----------------

const prBody = (over: Record<string, unknown> = {}) => ({
  number: 4242,
  title: "Add retry to the ingest worker",
  user: { login: "alice", type: "User" },
  head: { sha: "deadbeefcafe" },
  merged: false,
  ...over,
});

const labeledPayload = (labelName: string) => ({
  action: "labeled",
  number: 4242,
  label: { id: 1, name: labelName, color: "ededed" },
  pull_request: prBody(),
  repository: { full_name: cfg.github.repo },
  sender: { login: "alice", type: "User" },
  installation: { id: 555 },
});

const reviewRequestedPayload = (team: string | null, reviewer?: string) => ({
  action: "review_requested",
  number: 4242,
  ...(team ? { requested_team: { id: 9, slug: team, name: team } } : {}),
  ...(reviewer ? { requested_reviewer: { login: reviewer, type: "User" } } : {}),
  pull_request: prBody(),
  sender: { login: "alice", type: "User" },
});

const synchronizePayload = () => ({
  action: "synchronize",
  number: 4242,
  before: "1111111111",
  after: "2222222222",
  pull_request: prBody({ head: { sha: "2222222222" } }),
  sender: { login: "alice", type: "User" },
});

const closedPayload = (merged: boolean) => ({
  action: "closed",
  number: 4242,
  pull_request: prBody({ merged }),
  sender: { login: "alice", type: "User" },
});

const reviewCommentPayload = (over: Record<string, unknown> = {}) => ({
  action: "created",
  comment: {
    id: 900001,
    in_reply_to_id: 800001,
    pull_request_review_id: 70001,
    path: "workers/ingest.py",
    diff_hunk: "@@ -1,3 +1,7 @@",
    body: "This is intentional — the retry is idempotent.",
    user: { login: "alice", type: "User" },
    ...(over.comment as object),
  },
  pull_request: prBody(),
  sender: { login: "alice", type: "User", ...(over.sender as object) },
});

const issueCommentPayload = (over: { isPr?: boolean; body?: string; user?: object } = {}) => ({
  action: "created",
  issue: {
    number: 4242,
    title: "Add retry to the ingest worker",
    ...(over.isPr === false
      ? {}
      : { pull_request: { url: "https://api.github.com/repos/x/y/pulls/4242" } }),
  },
  comment: {
    id: 910001,
    body: over.body ?? "@example-review please take another look",
    user: over.user ?? { login: "alice", type: "User" },
  },
  sender: over.user ?? { login: "alice", type: "User" },
});

// ---- signature verification ---------------------------------------------

describe("verifySignature", () => {
  const raw = Buffer.from(JSON.stringify({ hello: "world" }));

  it("accepts a correct signature", () => {
    expect(verifySignature(raw, signBody(raw, SECRET), SECRET)).toBe(true);
  });

  it("rejects a wrong secret", () => {
    expect(verifySignature(raw, signBody(raw, "wrong"), SECRET)).toBe(false);
  });

  it("rejects a tampered body (signature is over the RAW bytes)", () => {
    const sig = signBody(raw, SECRET);
    expect(verifySignature(Buffer.from(JSON.stringify({ hello: "worlds" })), sig, SECRET)).toBe(
      false,
    );
  });

  it("rejects a missing header", () => {
    expect(verifySignature(raw, undefined, SECRET)).toBe(false);
  });

  it("rejects a wrong prefix", () => {
    const hex = createHmac("sha256", SECRET).update(raw).digest("hex");
    expect(verifySignature(raw, `sha1=${hex}`, SECRET)).toBe(false);
  });

  it("rejects a truncated signature without throwing (timingSafeEqual length guard)", () => {
    const sig = signBody(raw, SECRET);
    expect(() => verifySignature(raw, sig.slice(0, 20), SECRET)).not.toThrow();
    expect(verifySignature(raw, sig.slice(0, 20), SECRET)).toBe(false);
    expect(verifySignature(raw, `${sig}00`, SECRET)).toBe(false);
  });
});

// ---- delivery handling: dedupe + persistence ----------------------------

function delivery(
  store: StateStore,
  payload: unknown,
  event: string,
  guid: string,
  secret = SECRET,
) {
  const raw = Buffer.from(JSON.stringify(payload));
  return handleDelivery(
    { cfg, store, secret: SECRET, onInterpretation: () => {} },
    { signature: signBody(raw, secret), guid, event },
    raw,
  );
}

describe("handleDelivery", () => {
  it("403s a bad signature and logs the rejection", () => {
    const store = new StateStore(":memory:");
    const res = delivery(
      store,
      labeledPayload(cfg.github.trigger_label),
      "pull_request",
      "g1",
      "wrong-secret",
    );
    expect(res.status).toBe(403);
    expect(res.interpretation).toBeUndefined();
    const kinds = (
      store.db.prepare("SELECT kind FROM events").all() as Array<{ kind: string }>
    ).map((e) => e.kind);
    expect(kinds).toContain("webhook_rejected");
    store.close();
  });

  it("dedupes a redelivered guid", () => {
    const store = new StateStore(":memory:");
    const first = delivery(store, labeledPayload(cfg.github.trigger_label), "pull_request", "g2");
    expect(first.status).toBe(200);
    expect(first.interpretation?.kind).toBe("trigger");
    const second = delivery(store, labeledPayload(cfg.github.trigger_label), "pull_request", "g2");
    expect(second.reason).toBe("duplicate");
    expect(second.interpretation).toBeUndefined();
    store.close();
  });

  it("400s missing headers and bad JSON", () => {
    const store = new StateStore(":memory:");
    const raw = Buffer.from("{not json");
    const base = { cfg, store, secret: SECRET, onInterpretation: () => {} };
    expect(
      handleDelivery(
        base,
        { signature: signBody(raw, SECRET), guid: "g3", event: "pull_request" },
        raw,
      ).status,
    ).toBe(400);
    const ok = Buffer.from("{}");
    expect(
      handleDelivery(
        base,
        { signature: signBody(ok, SECRET), guid: undefined, event: "pull_request" },
        ok,
      ).status,
    ).toBe(400);
    store.close();
  });

  it("persists the delivery row for dedupe", () => {
    const store = new StateStore(":memory:");
    delivery(store, synchronizePayload(), "pull_request", "g4");
    const rows = store.db.prepare("SELECT * FROM deliveries").all() as Array<{
      guid: string;
      event: string;
      action: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ guid: "g4", event: "pull_request", action: "synchronize" });
    store.close();
  });
});

// ---- interpretation ------------------------------------------------------

describe("interpretEvent — pull_request", () => {
  it("treats the trigger label as a trigger and other labels as noise", () => {
    const hit = interpretEvent(
      "pull_request",
      "labeled",
      labeledPayload(cfg.github.trigger_label),
      deps(),
    );
    expect(hit).toMatchObject({ kind: "trigger", pr: 4242, source: "label" });
    expect((hit as any).meta).toMatchObject({
      title: "Add retry to the ingest worker",
      author: "alice",
      head_sha: "deadbeefcafe",
    });
    expect(interpretEvent("pull_request", "labeled", labeledPayload("needs-qa"), deps()).kind).toBe(
      "ignored",
    );
  });

  it("triggers only on the configured review team", () => {
    const teamSlug = cfg.github.review_team.split("/")[1]!;
    expect(
      interpretEvent("pull_request", "review_requested", reviewRequestedPayload(teamSlug), deps()),
    ).toMatchObject({
      kind: "trigger",
      source: "team_request",
    });
    expect(
      interpretEvent("pull_request", "review_requested", reviewRequestedPayload("infra"), deps())
        .kind,
    ).toBe("ignored");
    expect(
      interpretEvent(
        "pull_request",
        "review_requested",
        reviewRequestedPayload(null, "mhale"),
        deps(),
      ).kind,
    ).toBe("ignored");
  });

  it("maps synchronize and closed", () => {
    expect(
      interpretEvent("pull_request", "synchronize", synchronizePayload(), deps()),
    ).toMatchObject({ kind: "synchronize", pr: 4242 });
    expect(interpretEvent("pull_request", "closed", closedPayload(true), deps())).toMatchObject({
      kind: "closed",
      merged: true,
    });
    expect(interpretEvent("pull_request", "closed", closedPayload(false), deps())).toMatchObject({
      kind: "closed",
      merged: false,
    });
  });

  it("never tracks a bot-authored PR", () => {
    const payload = labeledPayload(cfg.github.trigger_label);
    payload.pull_request = prBody({ user: { login: BOT, type: "Bot" } }) as any;
    expect(interpretEvent("pull_request", "labeled", payload, deps())).toMatchObject({
      kind: "ignored",
      reason: "bot-authored PR",
    });
  });

  it("ignores unhandled actions and events", () => {
    expect(interpretEvent("pull_request", "assigned", labeledPayload("x"), deps()).kind).toBe(
      "ignored",
    );
    expect(interpretEvent("push", null, {}, deps()).kind).toBe("ignored");
  });
});

describe("interpretEvent — review comments", () => {
  it("detects a human reply inside this PR's bot thread via the registry", () => {
    const i = interpretEvent(
      "pull_request_review_comment",
      "created",
      reviewCommentPayload(),
      deps((id) => (id === 800001 ? 4242 : undefined)),
    );
    expect(i).toMatchObject({
      kind: "author_reply",
      pr: 4242,
      in_reply_to_id: 800001,
      via: "thread_reply",
      author: "alice",
    });
  });

  it("ignores another identity's thread and a bot thread registered to another PR", () => {
    expect(
      interpretEvent(
        "pull_request_review_comment",
        "created",
        reviewCommentPayload(),
        deps(() => undefined),
      ).kind,
    ).toBe("ignored");
    expect(
      interpretEvent(
        "pull_request_review_comment",
        "created",
        reviewCommentPayload(),
        deps(() => 99),
      ).kind,
    ).toBe("ignored");
  });

  it("ignores an @mention outside a bot-owned thread", () => {
    const payload = reviewCommentPayload({
      comment: { in_reply_to_id: undefined, body: "hey @example-review what about nulls?" },
    });
    expect(interpretEvent("pull_request_review_comment", "created", payload, deps())).toMatchObject(
      {
        kind: "ignored",
        reason: "not a reply in this PR's bot thread",
      },
    );
  });

  it("registers the bot's own comments instead of replying to itself", () => {
    const payload = reviewCommentPayload({
      comment: { id: 800002, user: { login: BOT, type: "Bot" } },
      sender: { login: BOT, type: "Bot" },
    });
    expect(
      interpretEvent(
        "pull_request_review_comment",
        "created",
        payload,
        deps(() => 4242),
      ),
    ).toMatchObject({
      kind: "bot_comment",
      comment_id: 800002,
      scope: "review_comment",
    });
  });

  it("ignores other bots", () => {
    const payload = reviewCommentPayload({
      comment: { user: { login: "coderabbit[bot]", type: "Bot" } },
    });
    expect(
      interpretEvent(
        "pull_request_review_comment",
        "created",
        payload,
        deps(() => 4242),
      ),
    ).toMatchObject({
      kind: "ignored",
      reason: "other-bot comment",
    });
  });
});

describe("interpretEvent — issue comments", () => {
  it("ignores top-level comments on issues and PRs", () => {
    expect(
      interpretEvent("issue_comment", "created", issueCommentPayload({ isPr: false }), deps()).kind,
    ).toBe("ignored");
    expect(interpretEvent("issue_comment", "created", issueCommentPayload(), deps())).toMatchObject(
      {
        kind: "ignored",
        pr: 4242,
        reason: "top-level PR comment is outside bot review threads",
      },
    );
  });

  it("needs a mention — a plain PR comment is noise", () => {
    expect(
      interpretEvent("issue_comment", "created", issueCommentPayload({ body: "rebased" }), deps())
        .kind,
    ).toBe("ignored");
  });

  it("registers the bot's own PR comment", () => {
    const payload = issueCommentPayload({
      user: { login: BOT, type: "Bot" },
      body: "Round 1 summary",
    });
    expect(interpretEvent("issue_comment", "created", payload, deps())).toMatchObject({
      kind: "bot_comment",
      scope: "issue_comment",
    });
  });
});

describe("mentionsBot", () => {
  it("matches the handle with and without the [bot] suffix", () => {
    expect(mentionsBot("ping @example-review here", BOT)).toBe(true);
    expect(mentionsBot("ping @example-review[bot] here", BOT)).toBe(true);
    expect(mentionsBot("ping @example-reviewer here", BOT)).toBe(false); // a different handle, not the bot
    expect(mentionsBot("no mention at all", BOT)).toBe(false);
  });
});

// ---- applyInterpretation → store ----------------------------------------

describe("applyInterpretation", () => {
  it("refreshes a pushed head without queuing or pumping a review", async () => {
    const store = new StateStore(":memory:");
    store.upsertPr({
      number: 4242,
      state: "awaiting_author",
      head_sha: "old",
      title: "T",
      author: "alice",
      trigger_ts: null,
      stale_recheck: 0,
      migration_gate: 0,
    });
    const touched = vi.fn();
    await applyInterpretation(
      { cfg, store, onPrTouched: touched },
      interpretEvent("pull_request", "synchronize", synchronizePayload(), deps()),
    );
    expect(store.getPr(4242)).toMatchObject({ state: "awaiting_author", head_sha: "2222222222" });
    expect(touched).not.toHaveBeenCalled();
    store.close();
  });

  it("drives the state machine and the registry", async () => {
    const store = new StateStore(":memory:");
    const replies: number[] = [];
    const closed: number[] = [];
    const apply = (i: Interpretation) =>
      applyInterpretation(
        {
          cfg,
          store,
          onAuthorReply: (r) => void replies.push(r.pr),
          onClosed: (pr) => void closed.push(pr),
        },
        i,
      );

    await apply(
      interpretEvent("pull_request", "labeled", labeledPayload(cfg.github.trigger_label), deps()),
    );
    expect(store.getPr(4242)!.state).toBe("queued");

    await apply(
      interpretEvent(
        "pull_request_review_comment",
        "created",
        reviewCommentPayload({ comment: { id: 800003, user: { login: BOT, type: "Bot" } } }),
        deps(),
      ),
    );
    expect(store.isBotComment(800003)).toBe(true);

    await apply(
      interpretEvent(
        "pull_request_review_comment",
        "created",
        reviewCommentPayload(),
        deps((id) => (id === 800001 ? 4242 : undefined)),
      ),
    );
    expect(replies).toEqual([4242]);
    expect(store.getPr(4242)!.state).toBe("queued"); // ping-pong never moves the lifecycle

    await apply(interpretEvent("pull_request", "closed", closedPayload(true), deps()));
    expect(store.getPr(4242)!.state).toBe("closed");
    expect(closed).toEqual([4242]);
    store.close();
  });
});
