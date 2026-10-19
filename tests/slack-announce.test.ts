// The announcer: threading, idempotence, caps, failure
// containment, the daemon lifecycle and the pinned heartbeat. All I/O is faked
// — the Slack seam is a recording object and the store is in-memory.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseConfig, type Config } from "../src/config.js";
import {
  HEARTBEAT_IDEM_KEY,
  SlackAnnouncer,
  makeAnnouncer,
  scanNotPickedUp,
} from "../src/slack/announce.js";
import { announcementKey } from "../src/slack/policy.js";
import type { SlackPostResult, SlackWebApi } from "../src/slack/types.js";
import { StateStore } from "../src/state.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

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
  /** Refuse (ok:false, the way SlackApiClient reports a dropped call) this
   * many updateMessage calls before accepting again. */
  refuseUpdates = 0;
  /** When set, every postMessage waits on this gate (a slow, queued call). */
  gate: Promise<void> | null = null;
  private seq = 0;

  async postMessage(args: {
    channel: string;
    text: string;
    thread_ts?: string;
  }): Promise<SlackPostResult> {
    if (this.gate) await this.gate;
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
  async updateMessage(args: {
    channel: string;
    ts: string;
    text: string;
  }): Promise<SlackPostResult> {
    if (this.refuseUpdates > 0) {
      this.refuseUpdates--;
      return { ok: false, error: "ratelimited" };
    }
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

function announcer(
  overrides: Partial<ConstructorParameters<typeof SlackAnnouncer>[0]> = {},
): SlackAnnouncer {
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
  it("posts nothing and writes no state at all", { timeout: HEAVY_TIMEOUT_MS }, async () => {
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
  it("starts a new root when the recorded PR thread belongs to another channel", async () => {
    store.upsertSlackThread({ pr: 5263, channel: "C_OLD", root_ts: "old-root" });
    await announcer().roundStarted(round);
    expect(slack.posts[0]?.thread_ts).toBeUndefined();
    expect(store.slackThreadForPr(5263)).toMatchObject({
      channel: "C_REVIEW",
      root_ts: slack.posts[0] ? "1700000001.0001" : "missing",
    });
  });

  it("retains an unknown delivery reservation across repeated calls and restart", async () => {
    const post = vi
      .spyOn(slack, "postMessage")
      .mockResolvedValue({ ok: false, error: "response lost", ambiguous: true } as SlackPostResult);
    const args = {
      pr: 5263,
      round_no: 1,
      verdict: "APPROVE" as const,
      summary: "s",
      duration_s: 60,
    };
    const a = announcer();
    await a.verdict(args);
    await a.verdict(args);
    await announcer().verdict(args);
    expect(post).toHaveBeenCalledTimes(1);
    expect(store.slackPost("verdict:5263:1")?.ts).toBeNull();
  });
  it("never persists successful post settlement without its first thread root", async () => {
    const bind = vi.spyOn(store, "upsertSlackThread").mockImplementation(() => {
      throw new Error("interrupted root binding");
    });
    await expect(announcer().roundStarted(round)).rejects.toThrow("interrupted root binding");
    bind.mockRestore();
    expect(store.slackPost("pickup:5263")?.ts).toBeNull();
    expect(store.slackThreadForPr(5263)).toBeUndefined();
  });
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
    expect(slack.posts[2]).toMatchObject({
      thread_ts: root,
      text: "🔄 round 2 started — you pushed new commits (`abcdef1`)",
    });
  });

  it("a replayed round 1 says nothing at all — never a 🔄 line for the first round", async () => {
    const a = announcer();
    await a.roundStarted(round);
    await a.roundStarted(round); // restart mid-dispatch, thread row intact
    expect(slack.posts).toHaveLength(1);
    expect(store.slackPost("reround:5263:1")).toBeUndefined();
  });

  it("with pickup switched off, a later round still speaks its own 🔄 line", async () => {
    cfg.slack.policy.causes["pr.pickup"] = { enabled: false, cooldown_min: 0 };
    const a = announcer();
    await a.roundStarted(round);
    expect(slack.posts).toHaveLength(0);
    await a.roundStarted({ ...round, round_no: 2, round_type: "re-review" });
    expect(slack.posts).toHaveLength(1);
    expect(slack.posts[0]!.text).toBe("🔄 round 2 started — you pushed new commits (`abcdef1`)");
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
    const v = {
      pr: 5263,
      round_no: 1,
      verdict: "APPROVE" as const,
      summary: "ok",
      duration_s: 120,
    };
    await a.verdict(v);
    await a.verdict(v);
    expect(slack.posts.filter((p) => p.text.includes("APPROVED"))).toHaveLength(1);
  });

  // There is no 🚩 pre-flag: no escalation-worthiness heuristic exists.
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

  it("swallows a thrown transport error and retains the unknown reservation with its cause", async () => {
    slack.throwNext = true;
    const a = announcer();
    await a.verdict({ pr: 5263, round_no: 1, verdict: "APPROVE", summary: "s", duration_s: 60 });
    expect(store.slackPost("verdict:5263:1")).toMatchObject({ ok: 1, ts: null });
    expect(String(store.slackPost("verdict:5263:1")!.error)).toContain("socket hang up");
  });

  it("a retried failed post is claimed afresh: the rolling-hour ceiling counts the new attempt", async () => {
    cfg.slack.policy.announcements_per_hour = 1;
    const a = announcer();
    slack.failNext = true;
    await a.anomaly({ pr: 1, round_no: 1, kind: "overdue", deadline_min: 45 });
    expect(store.slackPost("round.overdue:1:1")).toMatchObject({ ok: 0 });
    // Hours later the same incident is retried and delivered…
    at("2026-08-17T12:00:00.000Z");
    await a.anomaly({ pr: 1, round_no: 1, kind: "overdue", deadline_min: 45 });
    expect(slack.posts).toHaveLength(1);
    // …and it fills this hour's one slot.
    await a.anomaly({ pr: 2, round_no: 1, kind: "overdue", deadline_min: 45 });
    expect(slack.posts).toHaveLength(1);
  });

  it("an APPROVE whose approval was withheld is announced as withheld, never as APPROVED", async () => {
    const a = announcer();
    await a.verdict({
      pr: 5263,
      round_no: 1,
      verdict: "APPROVE",
      approval_withheld: true,
      summary: "s",
      duration_s: 60,
    });
    expect(slack.posts[0]!.text).toContain("*APPROVAL WITHHELD (CI not green)*");
    expect(slack.posts[0]!.text).not.toContain("APPROVED");
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
    await a.verdict({
      pr: 5263,
      round_no: 1,
      verdict: "REQUEST_CHANGES",
      summary: "a",
      duration_s: 60,
    });
    at("2026-08-17T09:20:00.000Z");
    await a.verdict({ pr: 5263, round_no: 2, verdict: "APPROVE", summary: "b", duration_s: 60 });
    expect(
      slack.posts.filter((p) => p.text.includes("round 1") || p.text.includes("round 2")),
    ).toHaveLength(3);
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
    store.pausePr(3, { issuer: "operator", expires_at: null }, "test");
    queuedPr(4, "2026-08-17T08:00:00.000Z");
    store.startRound(4, "first", ["pass-baseline"], 45);
    const hits = scanNotPickedUp(store, cfg, clock);
    expect(hits.map((h) => h.pr)).toEqual([1]);
    expect(hits[0]).toMatchObject({
      age_min: 60,
      running: 1,
      max_concurrent: cfg.daemon.max_concurrent_rounds,
    });
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
  it("a heartbeat claim an earlier run never settled does not block the heartbeat forever", async () => {
    // The previous process claimed the key and died before Slack answered.
    store.recordSlackPost({ idem_key: HEARTBEAT_IDEM_KEY, kind: "announce" });
    const a = announcer();
    const ts = await a.heartbeat();
    expect(ts).toBeDefined();
    expect(slack.posts).toHaveLength(1);
    expect(store.slackPost(HEARTBEAT_IDEM_KEY)).toMatchObject({ ok: 1, ts });
  });

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
    store.upsertPr({
      number: 5408,
      state: "reviewing",
      head_sha: "abc",
      title: "PR",
      author: "alice",
      trigger_ts: null,
      stale_recheck: 0,
      migration_gate: 0,
    });
    const roundId = store.startRound(5408, "first", ["pass-baseline"], 75);
    store.openReviewFailure({
      pr: 5408,
      command_id: "cmd-5408",
      round_id: roundId,
      round_no: 1,
      head_sha: "abc",
      stage: "command_start",
      detail: "no start",
      attempts: 2,
      retry_cap: 2,
    });

    const a = announcer();
    await a.anomaly({
      pr: 5408,
      round_no: 1,
      kind: "failed_loud",
      deadline_min: 75,
      incident_id: "review-failure:cmd-5408",
    });
    const incidentTs = store.slackPost("review-failure:cmd-5408")?.ts;
    await a.heartbeat();
    expect(
      slack.posts.some((post) => post.text.includes("PIPELINE FAILED · 1 review needs u")),
    ).toBe(true);

    store.recoverReviewFailure(5408, "operator-rerun");
    store.upsertPr({
      number: 5409,
      state: "reviewing",
      head_sha: "def",
      title: "PR 2",
      author: "bob",
      trigger_ts: null,
      stale_recheck: 0,
      migration_gate: 0,
    });
    const round2 = store.startRound(5409, "first", ["pass-baseline"], 75);
    store.openReviewFailure({
      pr: 5409,
      command_id: "cmd-5409",
      round_id: round2,
      round_no: 1,
      head_sha: "def",
      stage: "command_start",
      detail: "no start",
      attempts: 2,
      retry_cap: 2,
    });
    await a.anomaly({
      pr: 5409,
      round_no: 1,
      kind: "failed_loud",
      deadline_min: 75,
      incident_id: "review-failure:cmd-5409",
    });
    const incidentTs2 = store.slackPost("review-failure:cmd-5409")?.ts;
    store.recoverReviewFailure(5409, "operator-rerun");

    at("2026-08-17T09:01:00.000Z");
    await a.heartbeat();
    expect(slack.updates).toContainEqual({
      ts: incidentTs,
      text: expect.stringContaining("recovered via operator-rerun"),
    });
    expect(slack.updates).toContainEqual({
      ts: incidentTs2,
      text: expect.stringContaining("recovered via operator-rerun"),
    });
  });

  describe("a recovered incident's correction (selfscan 3087bc73 / 89309b74)", () => {
    async function recoveredIncident(a: SlackAnnouncer): Promise<string> {
      store.upsertPr({
        number: 5410,
        state: "reviewing",
        head_sha: "abc",
        title: "PR",
        author: "alice",
        trigger_ts: null,
        stale_recheck: 0,
        migration_gate: 0,
      });
      const roundId = store.startRound(5410, "first", ["pass-baseline"], 75);
      store.openReviewFailure({
        pr: 5410,
        command_id: "cmd-5410",
        round_id: roundId,
        round_no: 1,
        head_sha: "abc",
        stage: "command_start",
        detail: "no start",
        attempts: 2,
        retry_cap: 2,
      });
      await a.anomaly({
        pr: 5410,
        round_no: 1,
        kind: "failed_loud",
        deadline_min: 75,
        incident_id: "review-failure:cmd-5410",
      });
      store.recoverReviewFailure(5410, "operator-rerun");
      return store.slackPost("review-failure:cmd-5410")!.ts!;
    }
    function reopenFailure(): void {
      store.openReviewFailure({
        pr: 5410,
        command_id: "cmd-5410",
        round_id: null,
        round_no: 1,
        head_sha: "abc",
        stage: "command_start",
        detail: "again",
        attempts: 2,
        retry_cap: 2,
      });
    }
    const reopened = {
      pr: 5410,
      round_no: 1,
      kind: "failed_loud" as const,
      deadline_min: 75,
      incident_id: "review-failure:cmd-5410",
    };

    it("honours the cause switch before editing a reopened incident", async () => {
      const a = announcer();
      const ts = await recoveredIncident(a);
      await a.heartbeat();
      reopenFailure();
      cfg.slack.policy.causes["review.failed_loud"] = { enabled: false, cooldown_min: 0 };
      slack.updates.length = 0;
      await a.anomaly(reopened);
      expect(slack.updates.filter((update) => update.ts === ts)).toEqual([]);
    });

    it("retries an owed reopening correction across announcer restart", async () => {
      const dir = mkdtempSync(join(tmpdir(), "slack-reopening-"));
      store.close();
      const dbPath = join(dir, "state.db");
      store = new StateStore(dbPath, now);
      try {
        const a = announcer();
        const ts = await recoveredIncident(a);
        await a.heartbeat();
        at("2026-08-17T09:02:00.000Z");
        reopenFailure();
        slack.refuseUpdates = 1;
        await a.anomaly(reopened);
        expect(slack.updates.filter((update) => update.ts === ts).at(-1)?.text).toContain(
          "recovered via",
        );
        cfg.slack.policy.causes["review.failed_loud"] = { enabled: false, cooldown_min: 0 };
        await announcer().heartbeat();
        expect(slack.updates.filter((update) => update.ts === ts).at(-1)?.text).toContain(
          "recovered via",
        );
        cfg.slack.policy.causes["review.failed_loud"] = { enabled: true, cooldown_min: 0 };
        store.close();
        store = new StateStore(dbPath, now);
        await announcer().heartbeat();
        expect(slack.updates.filter((update) => update.ts === ts).at(-1)?.text).toContain(
          "work is still owed",
        );
      } finally {
        store.close();
        store = new StateStore(":memory:", now);
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("retains a refused reopening when automatic retry is merely deferred", async () => {
      const a = announcer();
      const ts = await recoveredIncident(a);
      await a.heartbeat();
      at("2026-08-17T09:02:00.000Z");
      reopenFailure();
      slack.refuseUpdates = 1;
      await a.anomaly(reopened);
      // Scheduling facts select the ordinary paused-PR deferral path.
      store.db
        .prepare(
          "UPDATE review_failures SET stage='first_pass_start', next_action='retry_wait', next_retry_at=? WHERE pr=5410",
        )
        .run(clock.toISOString());
      store.db.prepare("UPDATE pr_state SET paused=1 WHERE number=5410").run();
      at("2026-08-17T09:03:00.000Z");
      expect(store.activateDueReviewFailureRetries(clock.toISOString())).toEqual([]);
      expect(store.openReviewFailure(5410)?.updated_at).toBe(clock.toISOString());
      await announcer().heartbeat();
      expect(slack.updates.filter((update) => update.ts === ts).at(-1)?.text).toContain(
        "work is still owed",
      );
    });

    it("does not let an older successful edit forget a newer refused reopening", async () => {
      const a = announcer();
      const ts = await recoveredIncident(a);
      await a.heartbeat();
      const original = slack.updateMessage.bind(slack);
      let release!: (result: SlackPostResult) => void;
      const update = vi
        .spyOn(slack, "updateMessage")
        .mockImplementationOnce(
          async () =>
            new Promise((resolve) => {
              release = resolve;
            }),
        )
        .mockResolvedValueOnce({ ok: false, error: "rate_limited" })
        .mockImplementation(original);
      at("2026-08-17T09:02:00.000Z");
      reopenFailure();
      const first = a.anomaly({ ...reopened, kind: "overdue" });
      await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
      at("2026-08-17T09:03:00.000Z");
      reopenFailure();
      const second = a.anomaly(reopened);
      release({ ok: true });
      await first;
      await second;
      await a.heartbeat();
      expect(slack.updates.filter((entry) => entry.ts === ts).at(-1)?.text).toContain(
        "work is still owed",
      );
    });

    const corrections = (ts: string) =>
      slack.updates.filter((u) => u.ts === ts && u.text.includes("recovered via"));

    it.each([
      { first: "recovery", superseded: false },
      { first: "reopening", superseded: false },
      { first: "recovery", superseded: true },
      { first: "reopening", superseded: true },
    ] as const)(
      "keeps the latest incident state with $first in flight and queued edit superseded=$superseded",
      async ({ first, superseded }) => {
        const a = announcer();
        const ts = await recoveredIncident(a);
        if (first === "reopening") await a.heartbeat();
        const reopen = () => {
          store.openReviewFailure({
            pr: 5410,
            command_id: "cmd-5410",
            round_id: null,
            round_no: 1,
            head_sha: "abc",
            stage: "command_start",
            detail: "again",
            attempts: 2,
            retry_cap: 2,
          });
          return a.anomaly({
            pr: 5410,
            round_no: 1,
            kind: "failed_loud",
            deadline_min: 75,
            incident_id: "review-failure:cmd-5410",
          });
        };
        let release!: () => void;
        let entered!: () => void;
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const update = slack.updateMessage.bind(slack);
        let held = false;
        slack.updateMessage = async (args) => {
          if (args.ts === ts && !held) {
            held = true;
            entered();
            await gate;
          }
          return update(args);
        };
        const before = slack.updates.length;
        const earlier = first === "recovery" ? a.heartbeat() : reopen();
        await started;
        let later: Promise<unknown>;
        if (first === "recovery") later = reopen();
        else {
          at("2026-08-17T09:03:00.000Z");
          store.recoverReviewFailure(5410, "operator-unwedge");
          later = a.heartbeat();
        }
        let newest: Promise<unknown> = Promise.resolve();
        if (superseded) {
          if (first === "recovery") {
            at("2026-08-17T09:04:00.000Z");
            store.recoverReviewFailure(5410, "operator-unwedge");
            newest = a.heartbeat();
          } else newest = reopen();
        }
        // Let an unqueued second update finish before the earlier response.
        await new Promise<void>((resolve) => setImmediate(resolve));
        release();
        await Promise.all([earlier, later, newest]);
        const edits = slack.updates.slice(before).filter((u) => u.ts === ts);
        if (superseded) {
          // A queued edit whose state changed again never reaches Slack.
          expect(edits).toHaveLength(2);
          expect(edits.every((u) => u.text.startsWith("✓"))).toBe(first === "recovery");
        }
        const last = edits.at(-1)!.text;
        if ((first === "recovery") !== superseded) {
          expect(store.openReviewFailure(5410)).toBeDefined();
          expect(last).toMatch(/^⛔/);
        } else {
          expect(store.openReviewFailure(5410)).toBeUndefined();
          expect(last).toContain("recovered via operator-unwedge");
        }
        expect(slack.posts.filter((p) => p.text.startsWith("⛔"))).toHaveLength(1);
      },
    );

    it("reaches the incident message on a long heartbeat interval", async () => {
      cfg.slack.policy.heartbeat_interval_min = 15;
      const a = announcer();
      await a.heartbeat(); // 09:00 tick, before the failure
      at("2026-08-17T09:01:00.000Z");
      const ts = await recoveredIncident(a);
      at("2026-08-17T09:15:00.000Z"); // the next tick: 14 min after the recovery
      await a.heartbeat();
      expect(corrections(ts)).toHaveLength(1);
    });

    it("keeps retrying a refused correction until Slack accepts it, and logs the refusal", async () => {
      const logs: string[] = [];
      const a = announcer({ log: (m: string) => logs.push(m) });
      const ts = await recoveredIncident(a);
      slack.refuseUpdates = 3; // both ticks' corrections + the second heartbeat edit refused
      await a.heartbeat();
      at("2026-08-17T09:05:00.000Z");
      await a.heartbeat();
      expect(corrections(ts)).toHaveLength(0);
      expect(
        logs.some(
          (m) =>
            m.includes("failure recovery update failed") &&
            m.includes("review-failure:cmd-5410") &&
            m.includes(ts),
        ),
      ).toBe(true);
      at("2026-08-17T09:30:00.000Z"); // well past the old 10-minute window
      await a.heartbeat();
      expect(corrections(ts)).toHaveLength(1);
      at("2026-08-17T09:35:00.000Z");
      await a.heartbeat(); // delivered once — never re-edited every tick
      expect(corrections(ts)).toHaveLength(1);
    });

    it("owes a fresh correction when the incident reopens and recovers again", async () => {
      const a = announcer();
      const ts = await recoveredIncident(a);
      await a.heartbeat();
      expect(corrections(ts)).toHaveLength(1);
      at("2026-08-17T09:02:00.000Z");
      store.openReviewFailure({
        pr: 5410,
        command_id: "cmd-5410",
        round_id: null,
        round_no: 1,
        head_sha: "abc",
        stage: "command_start",
        detail: "again",
        attempts: 2,
        retry_cap: 2,
      });
      await a.anomaly({
        pr: 5410,
        round_no: 1,
        kind: "failed_loud",
        deadline_min: 75,
        incident_id: "review-failure:cmd-5410",
      });
      // The reopened incident's message no longer claims recovery.
      expect(slack.updates.filter((u) => u.ts === ts).at(-1)!.text).toMatch(
        /^⛔ #5410 round 1 exhausted automatic recovery/,
      );
      expect(slack.posts.filter((p) => p.text.startsWith("⛔"))).toHaveLength(1);
      at("2026-08-17T09:03:00.000Z");
      store.recoverReviewFailure(5410, "operator-unwedge");
      at("2026-08-17T09:05:00.000Z");
      await a.heartbeat();
      expect(corrections(ts)).toHaveLength(2);
      expect(corrections(ts)[1]!.text).toContain("operator-unwedge");
    });
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

function holdSlack(): () => void {
  let release!: () => void;
  slack.gate = new Promise<void>((r) => (release = r));
  return () => {
    slack.gate = null;
    release();
  };
}

describe("concurrent posts", () => {
  it("a not-picked-up notice and the pickup racing for one PR open ONE root (selfscan c3075124)", async () => {
    queuedPr(5263, "2026-08-17T08:00:00.000Z");
    const a = announcer();
    const release = holdSlack();
    const sweep = a.announceNotPickedUp(); // in flight, waiting on Slack
    await Promise.resolve();
    const pickup = a.roundStarted(round); // dispatch picks the PR up meanwhile
    await Promise.resolve();
    release();
    await Promise.all([sweep, pickup]);

    expect(slack.posts).toHaveLength(2);
    expect(slack.posts[0]!.thread_ts).toBeUndefined();
    const root = store.slackThreadForPr(5263)!.root_ts;
    expect(slack.posts[1]!.thread_ts).toBe(root);
    expect(root).toBe("1700000001.0001");
  });

  it("two heartbeat ticks retrying a failed first post deliver ONE message (selfscan 0bfd2673)", async () => {
    slack.failNext = true;
    const a = announcer();
    expect(await a.heartbeat()).toBeUndefined();
    expect(store.slackPost(HEARTBEAT_IDEM_KEY)).toMatchObject({ ok: 0 });

    const release = holdSlack();
    const tickB = a.heartbeat();
    await Promise.resolve();
    const tickC = a.heartbeat();
    await Promise.resolve();
    release();
    await Promise.all([tickB, tickC]);

    expect(slack.posts).toHaveLength(1);
    expect(slack.pins).toHaveLength(1);
  });

  it("two anomalies admitted in one tick at cap-1 post ONE — the ceiling is re-read at claim time (selfscan 71870f5b)", async () => {
    cfg.slack.policy.announcements_per_hour = 2;
    const a = announcer();
    await a.anomaly({ pr: 5263, round_no: 1, kind: "overdue", deadline_min: 45 });
    expect(slack.posts).toHaveLength(1); // rolling count is now cap-1

    // Both pass admission in the same synchronous stretch, before either claims.
    const one = a.anomaly({ pr: 5270, round_no: 1, kind: "overdue", deadline_min: 45 });
    const two = a.anomaly({ pr: 5271, round_no: 1, kind: "overdue", deadline_min: 45 });
    await Promise.all([one, two]);

    expect(slack.posts).toHaveLength(2);
    expect(store.slackPostsSince(new Date(T0.getTime() - 3_600_000).toISOString())).toBe(2);
  });

  it("a claim-time refusal writes no cooldown — the cause stays free to speak later, exactly like an admission refusal", async () => {
    cfg.slack.policy.announcements_per_hour = 2;
    const a = announcer();
    await a.anomaly({ pr: 5263, round_no: 1, kind: "overdue", deadline_min: 45 });
    const key = (pr: number) => announcementKey("round.overdue", pr);
    const before = { 5270: store.slackCooldown(key(5270)), 5271: store.slackCooldown(key(5271)) };
    expect(before[5270]).toBeUndefined();
    expect(before[5271]).toBeUndefined();

    await Promise.all([
      a.anomaly({ pr: 5270, round_no: 1, kind: "overdue", deadline_min: 45 }),
      a.anomaly({ pr: 5271, round_no: 1, kind: "overdue", deadline_min: 45 }),
    ]);
    expect(slack.posts).toHaveLength(2);
    // Exactly one of the two posted and paid its cooldown; the refused one left none.
    const stamped = [5270, 5271].filter((pr) => store.slackCooldown(key(pr)) !== undefined);
    expect(stamped).toHaveLength(1);
  });

  it("the claim-time ceiling never gates a lifecycle post (it counts, it is not blocked)", async () => {
    cfg.slack.policy.announcements_per_hour = 1;
    const a = announcer();
    await a.anomaly({ pr: 5270, round_no: 1, kind: "overdue", deadline_min: 45 });
    await a.roundStarted(round);
    expect(slack.posts).toHaveLength(2);
  });
});

it("replaces a definitively missing heartbeat and ignores stale missing-message replies", async () => {
  const a = announcer();
  const old = await a.heartbeat();
  const releases: Array<(result: SlackPostResult) => void> = [];
  vi.spyOn(slack, "updateMessage").mockImplementation(
    async () => new Promise((resolve) => releases.push(resolve)),
  );
  const first = a.heartbeat();
  const second = a.heartbeat();
  await vi.waitFor(() => expect(releases).toHaveLength(2));
  releases[0]!({ ok: false, error: "message_not_found" });
  const replacement = await first;
  expect(replacement).not.toBe(old);
  releases[1]!({ ok: false, error: "message_not_found" });
  expect(await second).toBe(replacement);
  expect(slack.posts).toHaveLength(2);
  expect(store.slackPost(HEARTBEAT_IDEM_KEY)?.ts).toBe(replacement);
});
