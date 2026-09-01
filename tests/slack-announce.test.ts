// The announcer (S4): threading, idempotence, caps, failure
// containment, the daemon lifecycle and the pinned heartbeat. All I/O is faked
// — the Slack seam is a recording object and the store is in-memory.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig, type Config } from "../src/config.js";
import { HEARTBEAT_IDEM_KEY, SlackAnnouncer, makeAnnouncer, scanNotPickedUp } from "../src/slack/announce.js";
import type { SlackPostResult, SlackWebApi } from "../src/slack/types.js";
import { StateStore } from "../src/state.js";

interface Posted {
  channel: string;
  text: string;
  thread_ts?: string;
}

class FakeSlack implements SlackWebApi {
  posts: Posted[] = [];
  updates: Array<{ ts: string; text: string }> = [];
  pins: string[] = [];
  failNext = false;
  throwNext = false;
  pinResult: SlackPostResult = { ok: true };
  private seq = 0;

  async postMessage(args: { channel: string; text: string; thread_ts?: string }): Promise<SlackPostResult> {
    if (this.throwNext) {
      this.throwNext = false;
      throw new Error("socket hang up");
    }
    if (this.failNext) {
      this.failNext = false;
      return { ok: false, error: "rate_limited" };
    }
    this.posts.push({ channel: args.channel, text: args.text, thread_ts: args.thread_ts });
    return { ok: true, ts: `170000000${++this.seq}.0001` };
  }
  async updateMessage(args: { channel: string; ts: string; text: string }): Promise<SlackPostResult> {
    this.updates.push({ ts: args.ts, text: args.text });
    return { ok: true, ts: args.ts };
  }
  async usersInfo(): Promise<undefined> {
    return undefined;
  }
  async authTest(): Promise<undefined> {
    return undefined;
  }
  async pinsAdd(args: { channel: string; ts: string }): Promise<SlackPostResult> {
    this.pins.push(args.ts);
    return this.pinResult;
  }
}

const shipped = readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8");
const T0 = new Date("2026-08-17T09:00:00.000Z"); // 11:00 Warsaw

let clock = T0;
const now = () => clock;
const at = (iso: string) => {
  clock = new Date(iso);
};

let store: StateStore;
let cfg: Config;
let slack: FakeSlack;

function announcer(overrides: Partial<ConstructorParameters<typeof SlackAnnouncer>[0]> = {}): SlackAnnouncer {
  return new SlackAnnouncer({ cfg, store, slack, now, version: "0.1.0", ...overrides });
}

function queuedPr(pr: number, triggerTs: string | null = T0.toISOString()): void {
  store.upsertPr({
    number: pr,
    state: "queued",
    head_sha: "abcdef1234567890",
    title: `PR ${pr}`,
    author: "alice",
    trigger_ts: triggerTs,
    stale_recheck: 0,
    migration_gate: 0,
  });
}

const round = {
  pr: 5263,
  title: "Add rate limiting",
  author: "alice",
  head_sha: "abcdef1234567890",
  round_no: 1,
  round_type: "first" as const,
  lenses: ["pass-baseline", "pass-validate"],
  additions: 120,
  deletions: 34,
  changed_files: 7,
};

beforeEach(() => {
  clock = T0;
  store = new StateStore(":memory:", now);
  cfg = parseConfig(shipped);
  cfg.slack.enabled = true;
  cfg.slack.channel = "C_REVIEW";
  cfg.owner.slack_id = "U_MAT";
  cfg.slack.users = { U_MAT: "mhale", U_ALICE: "alice" };
  cfg.github.repo = "exampleorg/example-app";
  slack = new FakeSlack();
});
afterEach(() => store.close());

describe("disabled Slack", () => {
  it("posts nothing and writes no state at all", async () => {
    cfg.slack.enabled = false;
    const a = announcer();
    await a.roundStarted(round);
    await a.verdict({ pr: 5263, round_no: 1, verdict: "APPROVE", summary: "s", duration_s: 60 });
    await a.anomaly({ pr: 5263, round_no: 1, kind: "overdue", deadline_min: 45 });
    await a.capReached(80);
    expect(await a.daemonUp()).toBe(false);
    expect(await a.heartbeat()).toBeUndefined();
    expect(slack.posts).toEqual([]);
    expect(store.allSlackThreads()).toEqual([]);
    expect(store.slackPost("pickup:5263")).toBeUndefined();
    expect(makeAnnouncer({ cfg, store, slack })).toBeUndefined();
  });
});

describe("root-on-first-event (DP-2a)", () => {
  it("pickup opens the thread and every later post replies to the recorded root", async () => {
    const a = announcer();
    await a.roundStarted(round);
    const root = store.slackThreadForPr(5263)!;
    expect(slack.posts[0]).toMatchObject({ channel: "C_REVIEW", thread_ts: undefined });
    expect(root.root_ts).toBe("1700000001.0001");

    await a.verdict({ pr: 5263, round_no: 1, verdict: "APPROVE", summary: "ok", duration_s: 840 });
    await a.superseded({ pr: 5263, old_round_no: 1, new_round_no: 2, head_sha: "deadbeefcafe" });
    expect(slack.posts.slice(1).map((p) => p.thread_ts)).toEqual([root.root_ts, root.root_ts]);
    // Never a reply's own ts: the root is stable across posts.
    expect(store.slackThreadForPr(5263)!.root_ts).toBe(root.root_ts);
    expect(store.slackThreadForPr(5263)!.post_count).toBe(2);
  });

  it("pickup opens the root, and only a GENUINELY later round speaks the 🔄 line", async () => {
    const a = announcer();
    await a.roundStarted(round);
    expect(slack.posts[0]!.thread_ts).toBeUndefined();
    expect(slack.posts[0]!.text).toContain("👀");
    const root = store.slackThreadForPr(5263)!.root_ts;

    await a.roundStarted({ ...round, round_no: 2, round_type: "re-review" });
    expect(slack.posts).toHaveLength(2);
    expect(slack.posts[1]!.thread_ts).toBe(root);
    expect(slack.posts[1]!.text).toBe("🔄 round 2 started — you pushed new commits (`abcdef1`)");
  });

  it("a not-picked-up notice can open the thread, and the pickup TEMPLATE lands as the first REPLY", async () => {
    queuedPr(5263, "2026-08-17T08:00:00.000Z");
    const a = announcer();
    await a.announceNotPickedUp();
    expect(slack.posts).toHaveLength(1);
    expect(slack.posts[0]!.thread_ts).toBeUndefined();
    expect(slack.posts[0]!.text).toContain("🐢 #5263 has been waiting 60 min");
    const root = store.slackThreadForPr(5263)!.root_ts;

    // The thread exists but the PICKUP was never said: round 1 must still say
    // it (in-thread), and must NOT claim "you pushed new commits".
    await a.roundStarted(round);
    expect(slack.posts).toHaveLength(2);
    expect(slack.posts[1]!.thread_ts).toBe(root);
    expect(slack.posts[1]!.text).toBe(
      "👀 *<https://github.com/exampleorg/example-app/pull/5263|#5263 Add rate limiting>* — review started for <@U_ALICE>\n" +
        "_round 1 · first review · 7 files, +120/−34 · lenses: pass-baseline, pass-validate_",
    );
    expect(slack.posts[1]!.text).not.toContain("🔄");
    expect(store.slackPost("pickup:5263")).toMatchObject({ ok: 1 });

    // …and the round AFTER that is the first genuine re-round.
    await a.roundStarted({ ...round, round_no: 2, round_type: "re-review" });
    expect(slack.posts).toHaveLength(3);
    expect(slack.posts[2]).toMatchObject({ thread_ts: root, text: "🔄 round 2 started — you pushed new commits (`abcdef1`)" });
  });

  it("a replayed round 1 says nothing at all — never a 🔄 line for the first round", async () => {
    const a = announcer();
    await a.roundStarted(round);
    await a.roundStarted(round); // restart mid-dispatch, thread row intact
    expect(slack.posts).toHaveLength(1);
    expect(store.slackPost("reround:5263:1")).toBeUndefined();
  });

  it("retries a FAILED pickup with the pickup template, not a re-round line", async () => {
    slack.failNext = true;
    const a = announcer();
    await a.roundStarted(round);
    expect(slack.posts).toHaveLength(0);
    await a.roundStarted(round);
    expect(slack.posts).toHaveLength(1);
    expect(slack.posts[0]!.text).toContain("👀");
  });

  it("promotes a reply to a root when the PR has no thread yet", async () => {
    const a = announcer();
    await a.verdict({ pr: 77, round_no: 1, verdict: "APPROVE", summary: null, duration_s: 60 });
    expect(slack.posts[0]!.thread_ts).toBeUndefined();
    expect(store.slackThreadForPr(77)?.root_ts).toBe("1700000001.0001");
  });
});

describe("idempotence", () => {
  it("a repeated pickup does not double-post", async () => {
    const a = announcer();
    await a.roundStarted(round);
    const a2 = announcer();
    // Same round, replayed from scratch (a restart mid-dispatch).
    store.db.prepare("DELETE FROM slack_threads WHERE pr = ?").run(5263);
    await a2.roundStarted(round);
    expect(slack.posts).toHaveLength(1);
  });

  it("a repeated verdict for the same round does not double-post", async () => {
    const a = announcer();
    await a.roundStarted(round);
    const v = { pr: 5263, round_no: 1, verdict: "APPROVE" as const, summary: "ok", duration_s: 120 };
    await a.verdict(v);
    await a.verdict(v);
    expect(slack.posts.filter((p) => p.text.includes("APPROVED"))).toHaveLength(1);
  });

  // The 🚩 pre-flag was removed on 2026-08-18 with the heuristic behind it.
  it("announces no pre-flag: a round opens its thread and says nothing else", async () => {
    const a = announcer();
    expect((a as unknown as Record<string, unknown>).escalationWorthy).toBeUndefined();
    await a.roundStarted(round);
    expect(slack.posts.filter((p) => p.text.startsWith("🚩"))).toHaveLength(0);
    expect(slack.posts).toHaveLength(1); // the pickup root, nothing more
  });
});

describe("failure containment", () => {
  it("records ok=0 and never throws when Slack refuses", async () => {
    slack.failNext = true;
    const a = announcer();
    await expect(a.roundStarted(round)).resolves.toBeUndefined();
    expect(store.slackPost("pickup:5263")).toMatchObject({ ok: 0, error: "rate_limited" });
    expect(store.slackThreadForPr(5263)).toBeUndefined();
  });

  it("swallows a thrown transport error and still records the failure", async () => {
    slack.throwNext = true;
    const a = announcer();
    await a.verdict({ pr: 5263, round_no: 1, verdict: "APPROVE", summary: "s", duration_s: 60 });
    expect(store.slackPost("verdict:5263:1")).toMatchObject({ ok: 0 });
    expect(String(store.slackPost("verdict:5263:1")!.error)).toContain("socket hang up");
  });

  it("lets a failed post be retried, but never a delivered one", async () => {
    slack.failNext = true;
    const a = announcer();
    await a.verdict({ pr: 5263, round_no: 1, verdict: "APPROVE", summary: "s", duration_s: 60 });
    expect(slack.posts).toHaveLength(0);
    await a.verdict({ pr: 5263, round_no: 1, verdict: "APPROVE", summary: "s", duration_s: 60 });
    expect(slack.posts).toHaveLength(1);
    await a.verdict({ pr: 5263, round_no: 1, verdict: "APPROVE", summary: "s", duration_s: 60 });
    expect(slack.posts).toHaveLength(1);
  });
});

describe("policy", () => {
  it("stays silent for a per-cause disabled announcement", async () => {
    cfg.slack.policy.causes["round.overdue"] = { enabled: false, cooldown_min: 0 };
    const a = announcer();
    await a.anomaly({ pr: 5263, round_no: 1, kind: "overdue", deadline_min: 45 });
    expect(slack.posts).toEqual([]);
  });

  it("honours a disabled LIFECYCLE cause too (never hardcoded on)", async () => {
    cfg.slack.policy.causes["pr.verdict"] = { enabled: false, cooldown_min: 0 };
    const a = announcer();
    await a.verdict({ pr: 5263, round_no: 1, verdict: "APPROVE", summary: "s", duration_s: 60 });
    expect(slack.posts).toEqual([]);
  });

  it("folds a repeat inside the cooldown window", async () => {
    queuedPr(5263, "2026-08-17T08:00:00.000Z");
    const a = announcer();
    await a.announceNotPickedUp();
    expect(slack.posts).toHaveLength(1);
    at("2026-08-17T09:30:00.000Z"); // 30 min later; cooldown is 120 min
    await a.announceNotPickedUp();
    expect(slack.posts).toHaveLength(1);
    expect(store.slackCooldown("pr.not_picked_up:5263")!.fold_count).toBe(1);
  });

  it("a verdict is never folded by a cooldown — two rounds in an hour both speak", async () => {
    const a = announcer();
    await a.roundStarted(round);
    await a.verdict({ pr: 5263, round_no: 1, verdict: "REQUEST_CHANGES", summary: "a", duration_s: 60 });
    at("2026-08-17T09:20:00.000Z");
    await a.verdict({ pr: 5263, round_no: 2, verdict: "APPROVE", summary: "b", duration_s: 60 });
    expect(slack.posts.filter((p) => p.text.includes("round 1") || p.text.includes("round 2"))).toHaveLength(3);
  });

  it("verdicts are thread-only — the seam has no broadcast, whatever the config says", async () => {
    cfg.slack.policy.broadcast_verdicts = "always";
    const a = announcer();
    await a.roundStarted(round);
    await a.verdict({ pr: 5263, round_no: 1, verdict: "APPROVE", summary: "s", duration_s: 60 });
    for (const post of slack.posts) expect(Object.keys(post)).not.toContain("reply_broadcast");
    expect(slack.posts[1]!.thread_ts).toBe(store.slackThreadForPr(5263)!.root_ts);
  });

  it("says the cap-reached line once a day", async () => {
    const a = announcer();
    await a.capReached(80);
    at("2026-08-17T15:00:00.000Z");
    await a.capReached(80);
    expect(slack.posts).toHaveLength(1);
    at("2026-08-18T09:00:00.000Z");
    await a.capReached(80);
    expect(slack.posts).toHaveLength(2);
  });
});

describe("scanNotPickedUp", () => {
  it("reports only queued, unpaused, over-grace PRs with no round since the trigger", () => {
    queuedPr(1, "2026-08-17T08:00:00.000Z"); // 60 min old → over the 20 min grace
    queuedPr(2, "2026-08-17T08:55:00.000Z"); // 5 min old → inside the grace
    queuedPr(3, "2026-08-17T08:00:00.000Z");
    store.setPaused(3, true);
    queuedPr(4, "2026-08-17T08:00:00.000Z");
    store.startRound(4, "first", ["pass-baseline"], 45);
    const hits = scanNotPickedUp(store, cfg, clock);
    expect(hits.map((h) => h.pr)).toEqual([1]);
    expect(hits[0]).toMatchObject({ age_min: 60, running: 1, max_concurrent: cfg.daemon.max_concurrent_rounds });
  });
});

describe("daemon lifecycle", () => {
  const status = (heartbeat: string) => () => JSON.stringify({ heartbeat, written_at: heartbeat });

  it("stays silent for a sub-threshold gap (deploy noise)", async () => {
    const a = announcer({ readStatus: status("2026-08-17T08:57:00.000Z") }); // 3 min
    expect(await a.daemonUp()).toBe(false);
    expect(slack.posts).toEqual([]);
  });

  it("stays silent when there is no previous snapshot at all", async () => {
    const a = announcer({ readStatus: () => undefined });
    expect(await a.daemonUp()).toBe(false);
  });

  it("reports the measured gap above the threshold", async () => {
    const a = announcer({ readStatus: status("2026-08-17T08:38:00.000Z") }); // 22 min
    expect(await a.daemonUp()).toBe(true);
    expect(slack.posts[0]!.text).toBe(
      "🟢 review daemon up (0.1.0) — was down 22 min (since 2026-08-17T08:38:00Z); " +
        "events in that window may have been missed, reconcile is catching up.",
    );
  });

  it("announces stopping without ever blocking on Slack", async () => {
    const a = announcer({ stopTimeoutMs: 5 });
    await a.daemonStopping("deploy");
    expect(slack.posts[0]!.text).toBe("🟡 review daemon stopping (deploy) — back shortly.");
  });

  it("a hung stopping post is abandoned at the timeout instead of delaying exit", async () => {
    const hung = new FakeSlack();
    hung.postMessage = () => new Promise<SlackPostResult>(() => {});
    const a = new SlackAnnouncer({ cfg, store, slack: hung, now, stopTimeoutMs: 5 });
    await a.daemonStopping("SIGTERM"); // resolves via the race, not the post
    expect(hung.posts).toEqual([]);
  });
});

describe("pinned heartbeat", () => {
  it("posts once, pins best-effort, then UPDATES the same ts", async () => {
    const a = announcer();
    const ts = await a.heartbeat();
    expect(slack.posts).toHaveLength(1);
    expect(slack.pins).toEqual([ts]);
    at("2026-08-17T09:05:00.000Z");
    await a.heartbeat();
    at("2026-08-17T09:10:00.000Z");
    await a.heartbeat();
    expect(slack.posts).toHaveLength(1);
    expect(slack.updates.map((u) => u.ts)).toEqual([ts, ts]);
    expect(slack.updates[1]!.text).toContain("2026-08-17T09:10:00Z");
  });

  it("keeps FAILED_LOUD review debt visible in the pinned heartbeat", async () => {
    store.upsertPr({ number: 5408, state: "reviewing", head_sha: "abc", title: "PR", author: "alice", trigger_ts: null, stale_recheck: 0, migration_gate: 0 });
    const roundId = store.startRound(5408, "first", ["pass-baseline"], 75);
    store.openReviewFailure({ pr: 5408, command_id: "cmd-5408", round_id: roundId, round_no: 1, head_sha: "abc", stage: "command_start", detail: "no start", attempts: 2, retry_cap: 2 });

    const a = announcer();
    await a.anomaly({ pr: 5408, round_no: 1, kind: "failed_loud", deadline_min: 75, incident_id: "review-failure:cmd-5408" });
    const incidentTs = store.slackPost("review-failure:cmd-5408")?.ts;
    await a.heartbeat();
    expect(slack.posts.some((post) => post.text.includes("PIPELINE FAILED · 1 review needs u"))).toBe(true);

    store.recoverReviewFailure(5408, "operator-rerun");
    store.upsertPr({ number: 5409, state: "reviewing", head_sha: "def", title: "PR 2", author: "bob", trigger_ts: null, stale_recheck: 0, migration_gate: 0 });
    const round2 = store.startRound(5409, "first", ["pass-baseline"], 75);
    store.openReviewFailure({ pr: 5409, command_id: "cmd-5409", round_id: round2, round_no: 1, head_sha: "def", stage: "command_start", detail: "no start", attempts: 2, retry_cap: 2 });
    await a.anomaly({ pr: 5409, round_no: 1, kind: "failed_loud", deadline_min: 75, incident_id: "review-failure:cmd-5409" });
    const incidentTs2 = store.slackPost("review-failure:cmd-5409")?.ts;
    store.recoverReviewFailure(5409, "operator-rerun");

    at("2026-08-17T09:01:00.000Z");
    await a.heartbeat();
    expect(slack.updates).toContainEqual({ ts: incidentTs, text: expect.stringContaining("recovered via operator-rerun") });
    expect(slack.updates).toContainEqual({ ts: incidentTs2, text: expect.stringContaining("recovered via operator-rerun") });
  });

  it("ignores a refused pin (no_permission — the owner may pin by hand)", async () => {
    slack.pinResult = { ok: false, error: "no_permission" };
    const a = announcer();
    expect(await a.heartbeat()).toBeDefined();
    expect(slack.posts).toHaveLength(1);
  });

  it("survives a restart: a fresh announcer updates the SAME message", async () => {
    const ts = await announcer().heartbeat();
    const fresh = announcer(); // new instance, same store — the ledger is the memory
    at("2026-08-17T09:05:00.000Z");
    await fresh.heartbeat();
    expect(slack.posts).toHaveLength(1);
    expect(slack.updates).toEqual([{ ts: ts!, text: expect.stringContaining("💓") }]);
    expect(store.slackPost(HEARTBEAT_IDEM_KEY)!.ts).toBe(ts);
  });

  it("drives the interval through the injected timer seam (same shape as api.ts/socket.ts)", async () => {
    const ticks: Array<{ fn: () => void; ms: number }> = [];
    const cleared: unknown[] = [];
    const a = announcer({
      setIntervalFn: (fn, ms) => {
        ticks.push({ fn, ms });
        return ticks.length;
      },
      clearIntervalFn: (h) => void cleared.push(h),
    });
    const flush = () => new Promise<void>((r) => setImmediate(r));
    a.startHeartbeat();
    expect(ticks[0]!.ms).toBe(cfg.slack.policy.heartbeat_interval_min * 60_000);
    await flush(); // the initial post
    at("2026-08-17T09:05:00.000Z");
    ticks[0]!.fn();
    await flush();
    expect(slack.updates.map((u) => u.ts)).toEqual(["1700000001.0001"]);
    a.stopHeartbeat();
    expect(cleared).toEqual([1]);
  });

  it("start/stop drive the interval and are idempotent", async () => {
    const a = announcer();
    a.startHeartbeat();
    a.startHeartbeat();
    a.stopHeartbeat();
    a.stopHeartbeat();
    await Promise.resolve();
    expect(slack.posts.length).toBeLessThanOrEqual(1);
  });
});

describe("duplicate socket consumers", () => {
  it("raises an anomaly signal instead of posting to the channel", () => {
    const seen: string[] = [];
    const a = announcer({ onAnomalySignal: (m) => void seen.push(m) });
    a.noteConnections(2);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("2 connections");
    expect(slack.posts).toEqual([]);
    a.noteConnections(2); // unchanged — one event, not a stream
    expect(seen).toHaveLength(1);
  });

  it("says nothing during a deploy window or for a single connection", () => {
    const seen: string[] = [];
    const a = announcer({ onAnomalySignal: (m) => void seen.push(m) });
    a.noteConnections(2, { deployWindow: true });
    a.noteConnections(1);
    expect(seen).toEqual([]);
  });
});
