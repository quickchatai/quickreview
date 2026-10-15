import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../src/state.js";

const T0 = new Date("2026-08-17T09:00:00.000Z");
let clock = T0;
const now = () => clock;
let store: StateStore;

beforeEach(() => {
  clock = T0;
  store = new StateStore(":memory:", now);
});
afterEach(() => store.close());

const at = (ms: number) => {
  clock = new Date(T0.getTime() + ms);
};

describe("slack_threads", () => {
  it("binds a PR to a thread root and looks it up both ways", () => {
    store.upsertSlackThread({ pr: 5263, channel: "C1", root_ts: "1755431234.001900" });
    expect(store.slackThreadForPr(5263)).toMatchObject({
      pr: 5263,
      channel: "C1",
      root_ts: "1755431234.001900",
      created_at: T0.toISOString(),
      last_post_at: null,
      post_count: 0,
    });
    expect(store.slackThreadByRoot("C1", "1755431234.001900")?.pr).toBe(5263);
    expect(store.slackThreadByRoot("C1", "nope")).toBeUndefined();
  });

  it("keeps the Slack ts as TEXT, with trailing-zero precision intact", () => {
    store.upsertSlackThread({ pr: 1, channel: "C1", root_ts: "1755431234.001900" });
    const row = store.slackThreadForPr(1)!;
    expect(typeof row.root_ts).toBe("string");
    expect(row.root_ts).toBe("1755431234.001900");
  });

  it("re-binding a PR overwrites the root and does not duplicate rows", () => {
    store.upsertSlackThread({ pr: 7, channel: "C1", root_ts: "1.1" });
    store.upsertSlackThread({ pr: 7, channel: "C1", root_ts: "2.2" });
    expect(store.allSlackThreads()).toHaveLength(1);
    expect(store.slackThreadForPr(7)?.root_ts).toBe("2.2");
  });

  it("re-binding to a new root resets the old thread's counters; re-binding the same root keeps them", () => {
    store.upsertSlackThread({ pr: 7, channel: "C1", root_ts: "1.1" });
    at(60_000);
    store.touchSlackThread(7);
    store.upsertSlackThread({ pr: 7, channel: "C1", root_ts: "1.1" });
    expect(store.slackThreadForPr(7)).toMatchObject({
      created_at: T0.toISOString(),
      post_count: 1,
      last_post_at: clock.toISOString(),
    });
    at(120_000);
    store.upsertSlackThread({ pr: 7, channel: "C1", root_ts: "2.2" });
    expect(store.slackThreadForPr(7)).toMatchObject({
      root_ts: "2.2",
      created_at: clock.toISOString(),
      post_count: 0,
      last_post_at: null,
    });
  });

  it("touch bumps post_count and stamps last_post_at", () => {
    store.upsertSlackThread({ pr: 7, channel: "C1", root_ts: "1.1" });
    at(60_000);
    store.touchSlackThread(7);
    store.touchSlackThread(7);
    expect(store.slackThreadForPr(7)).toMatchObject({
      post_count: 2,
      last_post_at: clock.toISOString(),
    });
  });
});

describe("slack_events", () => {
  const ev = (id: string, over: Record<string, unknown> = {}) => ({
    event_id: id,
    channel: "C1",
    ts: "1755431234.001900",
    thread_ts: "1755431230.000100",
    slack_user: "U1",
    tier: "author" as const,
    disposition: "injected" as const,
    ...over,
  });

  it("dedupes by event_id like the webhook delivery ledger", () => {
    expect(store.recordSlackEvent(ev("Ev1"))).toBe(true);
    expect(store.recordSlackEvent(ev("Ev1", { disposition: "dropped_dupe" }))).toBe(false);
    expect(store.slackEvent("Ev1")?.disposition).toBe("injected");
  });

  it("settles a disposition and stamps injected_at only when injected", () => {
    store.recordSlackEvent(ev("Ev2", { disposition: "dropped_stale" }));
    expect(store.slackEvent("Ev2")?.injected_at).toBeNull();
    at(1000);
    store.setSlackEventDisposition("Ev2", "injected");
    expect(store.slackEvent("Ev2")).toMatchObject({
      disposition: "injected",
      injected_at: clock.toISOString(),
    });
    store.setSlackEventDisposition("Ev2", "dropped_cap");
    expect(store.slackEvent("Ev2")?.injected_at).toBeNull();
  });

  it("counts only injected turns inside the window, and per user", () => {
    store.recordSlackEvent(ev("a", { slack_user: "U1" }));
    store.recordSlackEvent(ev("b", { slack_user: "U2" }));
    store.recordSlackEvent(ev("c", { slack_user: "U1", disposition: "dropped_echo" }));
    const from = T0.toISOString();
    const to = new Date(T0.getTime() + 3_600_000).toISOString();
    expect(store.slackTurnsBetween(from, to)).toBe(2);
    expect(store.slackTurnsBetween(from, to, "U1")).toBe(1);
    // outside the window
    expect(store.slackTurnsBetween(to, new Date(T0.getTime() + 7_200_000).toISOString())).toBe(0);
  });
});

describe("slack_posts", () => {
  it("rejects a duplicate idem_key — the idempotence guarantee", () => {
    expect(
      store.recordSlackPost({
        idem_key: "verdict:5263:2",
        kind: "verdict",
        pr: 5263,
        thread_ts: "1.1",
      }),
    ).toBe(true);
    expect(
      store.recordSlackPost({
        idem_key: "verdict:5263:2",
        kind: "verdict",
        pr: 5263,
        thread_ts: "1.1",
      }),
    ).toBe(false);
    const from = T0.toISOString();
    const to = new Date(T0.getTime() + 3_600_000).toISOString();
    expect(store.slackPostsBetween(from, to)).toBe(1);
  });

  it("settles the Slack-assigned ts and an error keeps the row out of the counts", () => {
    store.recordSlackPost({ idem_key: "reply:cmd-1.json", kind: "reply", pr: 1, thread_ts: "1.1" });
    store.settleSlackPost("reply:cmd-1.json", { ts: "1755431299.000300", ok: true });
    expect(store.slackPost("reply:cmd-1.json")).toMatchObject({
      ts: "1755431299.000300",
      ok: 1,
      error: null,
    });

    store.recordSlackPost({ idem_key: "reply:cmd-2.json", kind: "reply", pr: 1, thread_ts: "1.1" });
    store.settleSlackPost("reply:cmd-2.json", { ok: false, error: "channel_not_found" });
    const from = T0.toISOString();
    const to = new Date(T0.getTime() + 3_600_000).toISOString();
    expect(store.slackPostsBetween(from, to)).toBe(1);
    expect(store.slackThreadPostsBetween("1.1", from, to)).toBe(1);
  });

  it("windows counts by kind, thread and rolling instant", () => {
    store.recordSlackPost({ idem_key: "p1", kind: "announce" });
    at(30 * 60_000);
    store.recordSlackPost({ idem_key: "p2", kind: "announce" });
    store.recordSlackPost({ idem_key: "p3", kind: "reply", thread_ts: "9.9" });
    at(91 * 60_000);
    const hourAgo = new Date(clock.getTime() - 3_600_000).toISOString();
    expect(store.slackPostsSince(hourAgo, "announce")).toBe(0); // both are >1h old
    expect(store.slackPostsSince(T0.toISOString(), "announce")).toBe(2);
    const from = T0.toISOString();
    const to = clock.toISOString();
    expect(store.slackThreadPostsBetween("9.9", from, to)).toBe(1);
  });
});

describe("slack_cooldowns", () => {
  it("records a fire, folds repeats and resets fold on the next fire", () => {
    store.recordSlackCooldownFire("round.overdue:5263", "2026-08-17");
    expect(store.slackCooldown("round.overdue:5263")).toMatchObject({
      day: "2026-08-17",
      fire_count: 1,
      fold_count: 0,
      bypassed: 0,
    });
    expect(store.foldSlackCooldown("round.overdue:5263")).toBe(1);
    expect(store.foldSlackCooldown("round.overdue:5263")).toBe(2);
    store.recordSlackCooldownFire("round.overdue:5263", "2026-08-17");
    expect(store.slackCooldown("round.overdue:5263")).toMatchObject({
      fire_count: 2,
      fold_count: 0,
    });
  });

  it("keeps the bypass spent within a day and clears it on the next day", () => {
    store.recordSlackCooldownFire("k", "2026-08-17", true);
    expect(store.slackCooldown("k")?.bypassed).toBe(1);
    store.recordSlackCooldownFire("k", "2026-08-17");
    expect(store.slackCooldown("k")).toMatchObject({ bypassed: 1, fire_count: 2 });
    store.recordSlackCooldownFire("k", "2026-08-18");
    expect(store.slackCooldown("k")).toMatchObject({
      bypassed: 0,
      fire_count: 1,
      day: "2026-08-18",
    });
  });

  it("keys are independent — one PR's cooldown never touches another's", () => {
    store.recordSlackCooldownFire("round.overdue:1", "2026-08-17");
    expect(store.slackCooldown("round.overdue:2")).toBeUndefined();
  });
});
