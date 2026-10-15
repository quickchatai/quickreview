import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig, type Config } from "../src/config.js";
import { StateStore } from "../src/state.js";
import {
  announcedCap,
  announcementKey,
  causePolicy,
  claimPost,
  dayWindow,
  decideAnnouncement,
  decideReply,
  decideTurn,
  policyWindow,
} from "../src/slack/policy.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shipped = readFileSync(join(root, "tests/fixtures/config.toml"), "utf8");

const T0 = new Date("2026-08-17T09:00:00.000Z"); // 11:00 Warsaw (CEST)
let clock = T0;
const now = () => clock;
let store: StateStore;
let cfg: Config;

beforeEach(() => {
  clock = T0;
  store = new StateStore(":memory:", now);
  cfg = parseConfig(shipped);
});
afterEach(() => store.close());

const at = (iso: string) => {
  clock = new Date(iso);
};

const inject = (id: string, user: string | null) =>
  store.recordSlackEvent({
    event_id: id,
    channel: "C1",
    ts: `${id}.0`,
    thread_ts: "1.1",
    slack_user: user,
    tier: "author",
    disposition: "injected",
  });

describe("dayWindow (Warsaw, DST-correct)", () => {
  it(
    "puts a late-evening UTC instant in the NEXT Warsaw day",
    { timeout: HEAVY_TIMEOUT_MS },
    () => {
      // 22:30Z on the 17th is 00:30 on the 18th in Warsaw (CEST, +2).
      expect(dayWindow(new Date("2026-08-17T22:30:00Z"), "Europe/Warsaw").day).toBe("2026-08-18");
      expect(dayWindow(new Date("2026-08-17T21:30:00Z"), "Europe/Warsaw").day).toBe("2026-08-17");
    },
  );

  it("spans 23h on the spring-forward day and 25h on the fall-back day", () => {
    const spring = dayWindow(new Date("2026-03-29T12:00:00Z"), "Europe/Warsaw");
    expect(spring).toMatchObject({
      day: "2026-03-29",
      startIso: "2026-03-28T23:00:00.000Z",
      endIso: "2026-03-29T22:00:00.000Z",
    });
    expect(Date.parse(spring.endIso) - Date.parse(spring.startIso)).toBe(23 * 3_600_000);

    const fall = dayWindow(new Date("2026-10-25T12:00:00Z"), "Europe/Warsaw");
    expect(fall).toMatchObject({
      day: "2026-10-25",
      startIso: "2026-10-24T22:00:00.000Z",
      endIso: "2026-10-25T23:00:00.000Z",
    });
    expect(Date.parse(fall.endIso) - Date.parse(fall.startIso)).toBe(25 * 3_600_000);
  });

  it("policyWindow follows [slack.policy].timezone", () => {
    cfg.slack.policy.timezone = "UTC";
    expect(policyWindow(cfg, new Date("2026-08-17T22:30:00Z")).day).toBe("2026-08-17");
  });
});

describe("decideTurn", () => {
  it("allows while under both caps and reports the counts", () => {
    cfg.slack.policy.daily_turns = 3;
    cfg.slack.policy.per_user_daily_turns = 2;
    inject("a", "U1");
    const d = decideTurn(store, cfg, { slackUser: "U1" }, clock);
    expect(d).toMatchObject({ allow: true, used: 1, userUsed: 1, day: "2026-08-17" });
  });

  it("denies on the channel-wide cap with a distinguishable reason", () => {
    cfg.slack.policy.daily_turns = 2;
    inject("a", "U1");
    inject("b", "U2");
    const d = decideTurn(store, cfg, { slackUser: "U3" }, clock);
    expect(d.allow).toBe(false);
    expect(d.cap).toBe("daily_turns");
    expect(d.reason).toMatch(/daily turn cap reached \(2\/2\)/);
  });

  it("denies one loud user without touching anybody else", () => {
    cfg.slack.policy.per_user_daily_turns = 1;
    inject("a", "U1");
    expect(decideTurn(store, cfg, { slackUser: "U1" }, clock).cap).toBe("per_user_daily_turns");
    expect(decideTurn(store, cfg, { slackUser: "U2" }, clock).allow).toBe(true);
  });

  it("only the channel-wide cap is announced to the channel — a per-user one is not", () => {
    cfg.slack.policy.daily_turns = 2;
    cfg.slack.policy.per_user_daily_turns = 1;
    inject("a", "U1");
    const user = decideTurn(store, cfg, { slackUser: "U1" }, clock);
    expect(user.cap).toBe("per_user_daily_turns");
    expect(announcedCap(cfg, user)).toBeNull();
    inject("b", "U2");
    const channel = decideTurn(store, cfg, { slackUser: "U3" }, clock);
    expect(channel.cap).toBe("daily_turns");
    expect(announcedCap(cfg, channel)).toBe(2);
  });

  it("counts only injected events — drops are free", () => {
    cfg.slack.policy.daily_turns = 1;
    store.recordSlackEvent({
      event_id: "x",
      channel: "C1",
      ts: "1.0",
      slack_user: "U1",
      tier: "anyone",
      disposition: "dropped_echo",
    });
    expect(decideTurn(store, cfg, { slackUser: "U1" }, clock).allow).toBe(true);
  });

  it("resets at the WARSAW midnight, not the UTC one", () => {
    cfg.slack.policy.daily_turns = 1;
    at("2026-08-17T21:30:00Z"); // 23:30 Warsaw
    inject("a", "U1");
    expect(decideTurn(store, cfg, { slackUser: "U1" }, clock).allow).toBe(false);
    at("2026-08-17T22:30:00Z"); // 00:30 Warsaw, next day — still the same UTC day
    const d = decideTurn(store, cfg, { slackUser: "U1" }, clock);
    expect(d).toMatchObject({ allow: true, used: 0, day: "2026-08-18" });
  });
});

describe("decideReply", () => {
  it("refuses a spent idem_key — a retry never double-posts", () => {
    expect(
      claimPost(store, { idem_key: "reply:c1.json", kind: "reply", pr: 5, thread_ts: "1.1" }),
    ).toBe(true);
    const d = decideReply(store, cfg, { threadTs: "1.1", idemKey: "reply:c1.json" }, clock);
    expect(d).toMatchObject({ allow: false, cap: "idempotent" });
    expect(
      claimPost(store, { idem_key: "reply:c1.json", kind: "reply", pr: 5, thread_ts: "1.1" }),
    ).toBe(false);
  });

  it("enforces the per-thread daily cap on REPLIES only, without silencing other threads", () => {
    cfg.slack.policy.thread_replies_per_day = 2;
    // A pickup and a verdict in the same thread are daemon-authored: free.
    claimPost(store, { idem_key: "p0", kind: "pickup", thread_ts: "1.1" });
    claimPost(store, { idem_key: "p2", kind: "verdict", thread_ts: "1.1" });
    expect(decideReply(store, cfg, { threadTs: "1.1" }, clock)).toMatchObject({
      allow: true,
      threadUsed: 0,
    });
    claimPost(store, { idem_key: "p1", kind: "reply", thread_ts: "1.1" });
    claimPost(store, { idem_key: "p3", kind: "reply", thread_ts: "1.1" });
    expect(decideReply(store, cfg, { threadTs: "1.1" }, clock)).toMatchObject({
      allow: false,
      cap: "thread_replies_per_day",
      threadUsed: 2,
    });
    expect(decideReply(store, cfg, { threadTs: "2.2" }, clock).allow).toBe(true);
  });

  it("a busy PR can never silence its own thread — 6 rounds of lifecycle posts cost nothing", () => {
    // The shipped thread cap is 6; a PR that runs 6 rounds writes 1 pickup +
    // 6 verdicts into its thread. If those counted, the concierge could never
    // answer a human in that thread again that day.
    expect(cfg.slack.policy.thread_replies_per_day).toBe(6);
    claimPost(store, { idem_key: "pickup:5263", kind: "pickup", pr: 5263, thread_ts: "1.1" });
    for (let round = 1; round <= 6; round++) {
      claimPost(store, {
        idem_key: `verdict:5263:${round}`,
        kind: "verdict",
        pr: 5263,
        thread_ts: "1.1",
      });
      claimPost(store, {
        idem_key: `reround:5263:${round}`,
        kind: "announce",
        pr: 5263,
        thread_ts: "1.1",
      });
    }
    expect(decideReply(store, cfg, { threadTs: "1.1" }, clock)).toMatchObject({
      allow: true,
      threadUsed: 0,
      used: 0,
    });
  });

  it("enforces the channel-wide daily post cap on REPLIES only", () => {
    cfg.slack.policy.daily_turns = 2;
    cfg.slack.policy.thread_replies_per_day = 99;
    claimPost(store, { idem_key: "a1", kind: "announce" });
    claimPost(store, { idem_key: "a2", kind: "announce" });
    claimPost(store, { idem_key: "k1", kind: "pickup", thread_ts: "1.1" });
    claimPost(store, { idem_key: "v1", kind: "verdict", thread_ts: "1.1" });
    expect(decideReply(store, cfg, { threadTs: "1.1" }, clock)).toMatchObject({
      allow: true,
      used: 0,
    });
    claimPost(store, { idem_key: "r1", kind: "reply", thread_ts: "1.1" });
    claimPost(store, { idem_key: "r2", kind: "reply", thread_ts: "1.1" });
    expect(decideReply(store, cfg, { threadTs: "1.1" }, clock)).toMatchObject({
      allow: false,
      cap: "daily_posts",
      used: 2,
    });
  });

  it("a failed post does not consume the budget", () => {
    cfg.slack.policy.thread_replies_per_day = 1;
    claimPost(store, { idem_key: "r1", kind: "reply", thread_ts: "1.1" });
    store.settleSlackPost("r1", { ok: false, error: "ratelimited" });
    expect(decideReply(store, cfg, { threadTs: "1.1" }, clock).allow).toBe(true);
  });

  it("the thread budget rolls over at Warsaw midnight", () => {
    cfg.slack.policy.thread_replies_per_day = 1;
    at("2026-08-17T21:30:00Z");
    claimPost(store, { idem_key: "r1", kind: "reply", thread_ts: "1.1" });
    expect(decideReply(store, cfg, { threadTs: "1.1" }, clock).allow).toBe(false);
    at("2026-08-17T22:30:00Z");
    expect(decideReply(store, cfg, { threadTs: "1.1" }, clock).allow).toBe(true);
  });
});

describe("decideAnnouncement", () => {
  it("keys per PR so one stuck PR never silences another", () => {
    expect(announcementKey("round.overdue", 5263)).toBe("round.overdue:5263");
    expect(announcementKey("daemon.up", null)).toBe("daemon.up");
    const a = decideAnnouncement(store, cfg, { cause: "round.overdue", pr: 5263 }, clock);
    expect(a).toMatchObject({ allow: true, key: "round.overdue:5263" });
    expect(decideAnnouncement(store, cfg, { cause: "round.overdue", pr: 5263 }, clock).allow).toBe(
      false,
    );
    expect(
      decideAnnouncement(store, cfg, { cause: "round.overdue", pr: 999 }, clock),
    ).toMatchObject({ allow: true, key: "round.overdue:999" });
  });

  it("refuses a disabled cause and writes no cooldown state", () => {
    const d = decideAnnouncement(store, cfg, { cause: "reconcile.storm" }, clock);
    expect(d).toMatchObject({ allow: false, block: "disabled" });
    expect(store.slackCooldown("reconcile.storm")).toBeUndefined();
  });

  it("folds repeats inside the cooldown and fires again once it expires", () => {
    at("2026-08-17T09:00:00Z");
    expect(decideAnnouncement(store, cfg, { cause: "round.overdue", pr: 1 }, clock).allow).toBe(
      true,
    );
    at("2026-08-17T09:30:00Z"); // cooldown_min = 60
    const folded = decideAnnouncement(store, cfg, { cause: "round.overdue", pr: 1 }, clock);
    expect(folded).toMatchObject({ allow: false, block: "cooldown", folds: 1 });
    expect(decideAnnouncement(store, cfg, { cause: "round.overdue", pr: 1 }, clock).folds).toBe(2);
    at("2026-08-17T10:05:00Z");
    expect(decideAnnouncement(store, cfg, { cause: "round.overdue", pr: 1 }, clock).allow).toBe(
      true,
    );
    expect(store.slackCooldown("round.overdue:1")).toMatchObject({ fire_count: 2, fold_count: 0 });
  });

  it("a zero cooldown cause fires every time", () => {
    expect(causePolicy(cfg, "daemon.up").cooldown_min).toBe(0);
    expect(decideAnnouncement(store, cfg, { cause: "daemon.up" }, clock).allow).toBe(true);
    expect(decideAnnouncement(store, cfg, { cause: "daemon.up" }, clock).allow).toBe(true);
  });

  it("an unlisted cause takes default_cooldown_min and is enabled", () => {
    expect(causePolicy(cfg, "something.new")).toEqual({
      enabled: true,
      cooldown_min: cfg.slack.policy.default_cooldown_min,
    });
  });

  it("an escalation breaks the cooldown exactly once per Warsaw day", () => {
    at("2026-08-17T09:00:00Z");
    decideAnnouncement(store, cfg, { cause: "round.overdue", pr: 1 }, clock);
    at("2026-08-17T09:10:00Z");
    expect(
      decideAnnouncement(store, cfg, { cause: "round.overdue", pr: 1, escalated: true }, clock),
    ).toMatchObject({
      allow: true,
      bypass: true,
    });
    at("2026-08-17T09:20:00Z");
    expect(
      decideAnnouncement(store, cfg, { cause: "round.overdue", pr: 1, escalated: true }, clock),
    ).toMatchObject({
      allow: false,
      block: "cooldown",
    });
    // Next policy day: fresh fire, and the bypass is available again.
    at("2026-08-17T22:30:00Z");
    expect(decideAnnouncement(store, cfg, { cause: "round.overdue", pr: 1 }, clock)).toMatchObject({
      allow: true,
    });
    expect(store.slackCooldown("round.overdue:1")).toMatchObject({
      day: "2026-08-18",
      bypassed: 0,
      fire_count: 1,
    });
    at("2026-08-17T22:40:00Z");
    expect(
      decideAnnouncement(store, cfg, { cause: "round.overdue", pr: 1, escalated: true }, clock)
        .bypass,
    ).toBe(true);
  });

  it("passes the rolling per-hour limiter and leaves the cooldown untouched when it bites", () => {
    cfg.slack.policy.announcements_per_hour = 2;
    claimPost(store, { idem_key: "a1", kind: "announce" });
    claimPost(store, { idem_key: "a2", kind: "announce" });
    const blocked = decideAnnouncement(store, cfg, { cause: "daemon.up" }, clock);
    expect(blocked).toMatchObject({ allow: false, block: "per_hour" });
    expect(store.slackCooldown("daemon.up")).toBeUndefined();
    // One hour later the rolling window has emptied.
    at("2026-08-17T10:01:00Z");
    expect(decideAnnouncement(store, cfg, { cause: "daemon.up" }, clock).allow).toBe(true);
  });

  it("the per-hour ceiling counts EVERY daemon-authored post, not just kind='announce'", () => {
    cfg.slack.policy.announcements_per_hour = 2;
    claimPost(store, { idem_key: "pickup:1", kind: "pickup", pr: 1, thread_ts: "1.1" });
    claimPost(store, { idem_key: "verdict:1:1", kind: "verdict", pr: 1, thread_ts: "1.1" });
    expect(decideAnnouncement(store, cfg, { cause: "daemon.up" }, clock)).toMatchObject({
      allow: false,
      block: "per_hour",
    });
  });

  it("conversational replies are NOT daemon announcements and never eat that ceiling", () => {
    cfg.slack.policy.announcements_per_hour = 2;
    claimPost(store, { idem_key: "reply:c1", kind: "reply", thread_ts: "1.1" });
    claimPost(store, { idem_key: "reply:c2", kind: "reply", thread_ts: "1.1" });
    claimPost(store, { idem_key: "reply:c3", kind: "reply", thread_ts: "1.1" });
    expect(decideAnnouncement(store, cfg, { cause: "daemon.up" }, clock).allow).toBe(true);
  });

  it("announcements bypass the turn caps entirely", () => {
    cfg.slack.policy.daily_turns = 0;
    cfg.slack.policy.per_user_daily_turns = 0;
    expect(decideTurn(store, cfg, { slackUser: "U1" }, clock).allow).toBe(false);
    expect(decideAnnouncement(store, cfg, { cause: "daemon.up" }, clock).allow).toBe(true);
  });
});
