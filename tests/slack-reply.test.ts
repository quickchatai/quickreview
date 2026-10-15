import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseConfig, type Config } from "../src/config.js";
import { StateStore } from "../src/state.js";
import {
  makeSlackReply,
  replyIdemKey,
  threadIsKnown,
  truncateReply,
  TRUNCATION_SUFFIX,
} from "../src/slack/reply.js";
import * as replyModule from "../src/slack/reply.js";
import type { SlackPostResult } from "../src/slack/types.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shipped = readFileSync(join(root, "tests/fixtures/config.toml"), "utf8");

const CHANNEL = "C0CONCIERGE";
const THREAD = "1712345678.123456";
const T0 = new Date("2026-08-17T09:12:33.000Z");
let clock = T0;
const now = () => clock;

let store: StateStore;
let cfg: Config;
let posts: Array<{ channel: string; text: string; thread_ts?: string }>;
let postMessage: ReturnType<typeof vi.fn>;

/** A transport that throws on anything the reply path must not call. */
function api(result: SlackPostResult = { ok: true, ts: "1755431234.001900" }) {
  postMessage = vi.fn(async (args: { channel: string; text: string; thread_ts?: string }) => {
    posts.push(args);
    return result;
  });
  return {
    postMessage: postMessage as never,
    updateMessage: () => {
      throw new Error("updateMessage must not be called");
    },
    usersInfo: () => {
      throw new Error("usersInfo must not be called");
    },
    authTest: () => {
      throw new Error("authTest must not be called");
    },
    pinsAdd: () => {
      throw new Error("pinsAdd must not be called");
    },
  };
}

function reply(result?: SlackPostResult) {
  return makeSlackReply({ cfg, store, api: api(result), now });
}

/** Pretend somebody spoke to us in THREAD. */
function seenInbound(threadTs = THREAD, id = "Ev1"): void {
  store.recordSlackEvent({
    event_id: id,
    channel: CHANNEL,
    ts: threadTs,
    thread_ts: null,
    slack_user: "U0ALICE",
    tier: "author",
    disposition: "injected",
  });
}

beforeEach(() => {
  clock = T0;
  store = new StateStore(":memory:", now);
  cfg = parseConfig(shipped);
  cfg.slack.enabled = true;
  cfg.slack.channel = CHANNEL;
  cfg.owner.slack_id = "U0OWNER";
  cfg.slack.users = { U0OWNER: "mhale", U0ALICE: "alice-gh" };
  posts = [];
});
afterEach(() => store.close());

describe("slack_reply execution", () => {
  it(
    "posts into the configured channel and thread, and never takes a channel from the caller",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      seenInbound();
      const out = await reply()({ thread: THREAD, text: "on it", file: "cmd-1" });
      expect(out).toMatchObject({ ok: true, ts: "1755431234.001900", truncated: false });
      expect(posts).toEqual([{ channel: CHANNEL, text: "on it", thread_ts: THREAD }]);
      expect(store.slackPost("reply:cmd-1")).toMatchObject({
        ok: 1,
        ts: "1755431234.001900",
        kind: "reply",
      });
    },
  );

  it("refuses a thread it was never spoken to in (no cold starts)", async () => {
    const out = await reply()({ thread: THREAD, text: "hello?", file: "cmd-1" });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("unknown thread");
    expect(posts).toHaveLength(0);
  });

  it("accepts a thread the daemon opened for a PR", async () => {
    store.upsertSlackThread({ pr: 1234, channel: CHANNEL, root_ts: THREAD });
    const out = await reply()({ thread: THREAD, text: "verdict is in", file: "cmd-1" });
    expect(out.ok).toBe(true);
    expect(store.slackThreadForPr(1234)?.post_count).toBe(1);
  });

  it("accepts a thread whose ROOT we only saw as a parent ts", async () => {
    store.recordSlackEvent({
      event_id: "Ev9",
      channel: CHANNEL,
      ts: "1712345999.000100",
      thread_ts: THREAD,
      slack_user: "U0ALICE",
      tier: "author",
      disposition: "injected",
    });
    expect(threadIsKnown(store, CHANNEL, THREAD)).toBe(true);
    expect((await reply()({ thread: THREAD, text: "ok", file: "c" })).ok).toBe(true);
  });

  it("a thread only a bot (or a user-less message) spoke in stays unknown", async () => {
    store.recordSlackEvent({
      event_id: "EvBot",
      channel: CHANNEL,
      ts: THREAD,
      thread_ts: null,
      slack_user: null,
      tier: "ignored",
      disposition: "dropped_echo",
    });
    expect(threadIsKnown(store, CHANNEL, THREAD)).toBe(false);
    // A person's message there, even one the cap refused, makes it known.
    store.recordSlackEvent({
      event_id: "EvCap",
      channel: CHANNEL,
      ts: "1712345999.000200",
      thread_ts: THREAD,
      slack_user: "U0ALICE",
      tier: "author",
      disposition: "dropped_cap",
    });
    expect(threadIsKnown(store, CHANNEL, THREAD)).toBe(true);
  });

  it("rejects a malformed ts and a thread known only in another channel", async () => {
    seenInbound();
    expect((await reply()({ thread: "nope", text: "x", file: "c" })).ok).toBe(false);
    expect(threadIsKnown(store, "C0OTHER", THREAD)).toBe(false);
  });

  it("truncates at max_reply_chars with a visible marker", async () => {
    seenInbound();
    cfg.slack.max_reply_chars = 40;
    const out = await reply()({ thread: THREAD, text: "x".repeat(200), file: "cmd-1" });
    expect(out.ok).toBe(true);
    expect(out.truncated).toBe(true);
    expect(posts[0]?.text).toHaveLength(40);
    expect(posts[0]?.text.endsWith(TRUNCATION_SUFFIX)).toBe(true);
  });

  it("escapes model-produced text so a pasted mention cannot ping anyone", async () => {
    seenInbound();
    await reply()({ thread: THREAD, text: "ping <@U0OWNER> & <!channel> now", file: "cmd-1" });
    expect(posts[0]?.text).toBe("ping &lt;@U0OWNER&gt; &amp; &lt;!channel&gt; now");
    expect(posts[0]?.text).not.toContain("<@");
  });

  it("does not double-post for the same command file", async () => {
    seenInbound();
    const send = reply();
    expect((await send({ thread: THREAD, text: "one", file: "cmd-1" })).ok).toBe(true);
    const second = await send({ thread: THREAD, text: "one", file: "cmd-1" });
    expect(second.ok).toBe(false);
    expect(second.reason).toContain("already posted");
    expect(posts).toHaveLength(1);
  });

  it("refuses over the per-thread cap and reports which cap", async () => {
    seenInbound();
    const send = reply();
    for (let i = 0; i < cfg.slack.policy.thread_replies_per_day; i++) {
      expect((await send({ thread: THREAD, text: `m${i}`, file: `cmd-${i}` })).ok).toBe(true);
    }
    const out = await send({ thread: THREAD, text: "one more", file: "cmd-over" });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("thread reply cap");
    expect(out.cap).toBe("thread_replies_per_day");
    expect(posts).toHaveLength(cfg.slack.policy.thread_replies_per_day);
  });

  it("records a failed post and never blocks anything", async () => {
    seenInbound();
    const out = await reply({ ok: false, error: "rate_limited" })({
      thread: THREAD,
      text: "x",
      file: "cmd-1",
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("rate_limited");
    const row = store.slackPost("reply:cmd-1");
    expect(row).toMatchObject({ ok: 0, error: "rate_limited" });
    // The failure did not consume the daily post budget.
    expect(store.slackPostsBetween("2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z")).toBe(0);
  });

  it("survives a transport that throws", async () => {
    seenInbound();
    const send = makeSlackReply({
      cfg,
      store,
      api: {
        postMessage: (async () => {
          throw new Error("socket closed");
        }) as never,
      },
      now,
    });
    const out = await send({ thread: THREAD, text: "x", file: "cmd-1" });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("socket closed");
  });

  it("refuses entirely when Slack is disabled", async () => {
    seenInbound();
    cfg.slack.enabled = false;
    const out = await reply()({ thread: THREAD, text: "x", file: "cmd-1" });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("disabled");
    expect(posts).toHaveLength(0);
  });
});

describe("reply helpers", () => {
  it("escapes via the ONE implementation in messages.ts (no second spelling)", () => {
    expect(truncateReply("a & b < c > d", 100)).toBe("a &amp; b &lt; c &gt; d");
    expect(truncateReply("&lt;", 100)).toBe("&amp;lt;");
    // reply.ts must not re-export an escaper of its own.
    expect(Object.keys(replyModule)).not.toContain("escapeSlackText");
    // …nor a third spelling of messages.ts's mention/userRef.
    expect(Object.keys(replyModule)).not.toContain("mentionFor");
  });

  it("truncateReply is a no-op below the limit", () => {
    expect(truncateReply("short", 100)).toBe("short");
    expect(truncateReply("abcdef", 4)).toHaveLength(4);
  });

  it("never splits an HTML entity: truncation slices the RAW text, escaping comes after", () => {
    const out = truncateReply("&".repeat(200), 40);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.endsWith(TRUNCATION_SUFFIX)).toBe(true);
    // Every ampersand in the payload is a WHOLE `&amp;` — no `&am`, no `&a`.
    const body = out.slice(0, -TRUNCATION_SUFFIX.length);
    expect(body).toBe("&amp;".repeat(body.length / 5));
    expect(body).toMatch(/^(?:&amp;)*$/);
  });

  it("keeps max_reply_chars as the hard limit even when escaping inflates the text", () => {
    for (const max of [1, 5, 12, 13, 14, 20, 37, 40, 41]) {
      const out = truncateReply("&<>".repeat(100), max);
      expect(out.length).toBeLessThanOrEqual(max);
      expect(out.replace(/&amp;|&lt;|&gt;|…\(truncated\)/g, "")).toBe("");
    }
  });

  it("truncates a real reply exactly at the boundary, marker included", () => {
    expect(truncateReply("x".repeat(200), 40)).toBe("x".repeat(28) + TRUNCATION_SUFFIX);
    expect(truncateReply("x".repeat(40), 40)).toBe("x".repeat(40)); // exactly at the limit: untouched
  });

  it("the idem key is the command file basename, with a stable fallback", () => {
    expect(replyIdemKey({ thread: THREAD, text: "x", file: "reply-01" })).toBe("reply:reply-01");
    const a = replyIdemKey({ thread: THREAD, text: "x" });
    expect(a).toBe(replyIdemKey({ thread: THREAD, text: "x" }));
    expect(a).not.toBe(replyIdemKey({ thread: THREAD, text: "y" }));
  });
});
