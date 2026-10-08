// The two hook points (S4): dispatch announces a round, the verdict
// watcher announces the verdict, the anomalies and a supersede. Both modules
// must keep working with the announcer ABSENT, and neither may ever be
// disturbed by a Slack failure.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseConfig, type Config } from "../src/config.js";
import { dispatchOnce, type DispatchAdapter } from "../src/dispatch.js";
import type { GateResult } from "../src/gate.js";
import type { PrFileEntry } from "../src/github.js";
import { SlackAnnouncer } from "../src/slack/announce.js";
import type { SlackPostResult, SlackWebApi } from "../src/slack/types.js";
import { StateStore } from "../src/state.js";
import type { SessionHooks } from "../src/types.js";
import { VerdictWatcher, type VerdictAdapter } from "../src/verdicts.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

class FakeSlack implements SlackWebApi {
  posts: Array<{ text: string; thread_ts?: string }> = [];
  throwAlways = false;
  /** Set ⇒ every post waits on it: a blackholed / backed-up Slack queue. */
  hold: Promise<void> | undefined;
  private seq = 0;
  async postMessage(args: {
    channel: string;
    text: string;
    thread_ts?: string;
  }): Promise<SlackPostResult> {
    if (this.hold) await this.hold;
    if (this.throwAlways) throw new Error("slack is down");
    this.posts.push({ text: args.text, thread_ts: args.thread_ts });
    return { ok: true, ts: `17000000${++this.seq}.0001` };
  }
  async updateMessage(): Promise<SlackPostResult> {
    return { ok: true };
  }
  async usersInfo(): Promise<undefined> {
    return undefined;
  }
  async authTest(): Promise<undefined> {
    return undefined;
  }
  async pinsAdd(): Promise<SlackPostResult> {
    return { ok: true };
  }
}

class FakeDispatchAdapter implements DispatchAdapter {
  files: PrFileEntry[] = [
    { filename: "src/app.ts", status: "modified", additions: 120, deletions: 34 },
  ];
  async listPrFiles(): Promise<PrFileEntry[]> {
    return this.files;
  }
  async getPr(): Promise<{ base_ref: string; body?: string }> {
    return { base_ref: "master" };
  }
  async addLabel(): Promise<GateResult> {
    return { executed: false, dryRunFile: "x" };
  }
  async removeLabel(): Promise<GateResult> {
    return { executed: false, dryRunFile: "x" };
  }
  async deleteTeamReviewRequest(): Promise<GateResult> {
    return { executed: false, dryRunFile: "x" };
  }
  async createReview(): Promise<GateResult> {
    return { executed: false, dryRunFile: "x" };
  }
}

class FakeVerdictAdapter implements VerdictAdapter {
  async addLabel(): Promise<GateResult> {
    return { executed: false, dryRunFile: "d" };
  }
  async removeLabel(): Promise<GateResult> {
    return { executed: false, dryRunFile: "d" };
  }
  async requestEscalationReview(): Promise<GateResult> {
    return { executed: false, dryRunFile: "d" };
  }
}

const hooks: SessionHooks = {
  async dispatchRound() {},
  async inject() {},
  async injectOverseer() {},
  async archiveAndClose() {},
};

const shipped = readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8");
const T0 = new Date("2026-08-17T09:00:00.000Z");
let clock = T0;
const now = () => clock;

let store: StateStore;
let cfg: Config;
let slack: FakeSlack;
let dir: string;

function announcer(): SlackAnnouncer {
  return new SlackAnnouncer({ cfg, store, slack, now });
}

function queuedPr(pr: number): void {
  store.upsertPr({
    number: pr,
    state: "queued",
    head_sha: "abcdef1234567890",
    title: "Add rate limiting",
    author: "alice",
    trigger_ts: T0.toISOString(),
    stale_recheck: 0,
    migration_gate: 0,
  });
}

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
  dir = mkdtempSync(join(tmpdir(), "qcr-slack-hooks-"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("dispatch hook", () => {
  it("posts the pickup root for a dispatched round", { timeout: HEAVY_TIMEOUT_MS }, async () => {
    queuedPr(5263);
    const orders = await dispatchOnce({
      cfg,
      store,
      adapter: new FakeDispatchAdapter(),
      hooks,
      announce: announcer(),
      now,
    });
    expect(orders).toHaveLength(1);
    await vi.waitFor(() => expect(slack.posts).toHaveLength(1));
    expect(slack.posts[0]!.text.split("\n")[0]).toBe(
      "👀 *<https://github.com/exampleorg/example-app/pull/5263|#5263 Add rate limiting>* — review started for <@U_ALICE>",
    );
    expect(slack.posts[0]!.text.split("\n")[1]).toContain(
      "_round 1 · first review · 1 files, +120/−34 · lenses: ",
    );
    expect(store.slackThreadForPr(5263)).toBeDefined();
  });

  it(
    "dispatches exactly as before when no announcer is wired",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queuedPr(5263);
      const orders = await dispatchOnce({
        cfg,
        store,
        adapter: new FakeDispatchAdapter(),
        hooks,
        now,
      });
      expect(orders).toHaveLength(1);
      expect(store.allSlackThreads()).toEqual([]);
    },
  );

  it(
    "a Slack outage never stalls the pump — the round still dispatches",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      slack.throwAlways = true;
      queuedPr(5263);
      const orders = await dispatchOnce({
        cfg,
        store,
        adapter: new FakeDispatchAdapter(),
        hooks,
        announce: announcer(),
        now,
      });
      expect(orders).toHaveLength(1);
      expect(store.runningRounds()).toHaveLength(1);
      await vi.waitFor(() => expect(store.slackPost("pickup:5263")).toMatchObject({ ok: 0 }));
    },
  );

  it(
    "a slow Slack never holds the pump — later PRs dispatch before the pickup lands",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      // A blackholed or rate-limited Slack takes tens of seconds per post
      // (bounded retries + Retry-After). The announcement is fire-and-forget:
      // the per-PR lane keeps its order, the pump never waits on it.
      let release!: () => void;
      slack.hold = new Promise<void>((r) => (release = r));
      queuedPr(5263);
      queuedPr(5264);
      const orders = await dispatchOnce({
        cfg,
        store,
        adapter: new FakeDispatchAdapter(),
        hooks,
        announce: announcer(),
        now,
      });
      expect(orders.map((o) => o.pr).sort()).toEqual([5263, 5264]);
      expect(slack.posts).toHaveLength(0);
      release();
      await vi.waitFor(() => expect(slack.posts).toHaveLength(2));
      expect(store.slackThreadForPr(5263)).toBeDefined();
      expect(store.slackThreadForPr(5264)).toBeDefined();
    },
  );
});

describe("verdict hooks", () => {
  function watcher(announce?: SlackAnnouncer): VerdictWatcher {
    return new VerdictWatcher({
      cfg,
      store,
      adapter: new FakeVerdictAdapter(),
      hooks,
      verdictDir: dir,
      announce,
      now,
      // No transcripts: a session dir that does not exist (zero usage).
      usage: { globalStoreDir: null, sessionDirFor: (pr) => join(dir, "no-sessions", `pr-${pr}`) },
      partialWrite: { windowMs: 0 },
    });
  }

  function reviewingRound(pr: number): number {
    store.upsertPr({
      number: pr,
      state: "reviewing",
      head_sha: "abcdef1234567890",
      title: "Add rate limiting",
      author: "alice",
      trigger_ts: null,
      stale_recheck: 0,
      migration_gate: 0,
    });
    return store.startRound(pr, "first", ["pass-baseline"], cfg.daemon.round_deadline_min);
  }

  function writeVerdict(pr: number, roundNo: number, body: Record<string, unknown>): string {
    const name = `pr-${pr}-round-${roundNo}.json`;
    writeFileSync(join(dir, name), JSON.stringify(body));
    return name;
  }

  it("posts the verdict in-thread with the duration read back off the round row", async () => {
    store.upsertSlackThread({ pr: 5263, channel: "C_REVIEW", root_ts: "1699999999.0001" });
    reviewingRound(5263);
    clock = new Date("2026-08-17T09:14:00.000Z"); // 14 minutes later
    writeVerdict(5263, 1, {
      pr: 5263,
      round_no: 1,
      verdict: "APPROVE",
      head_sha: "abcdef1234567890",
      finished_at: clock.toISOString(),
      summary: "Nothing blocking; the retry loop is bounded now.",
    });
    await watcher(announcer()).sweep();
    expect(slack.posts).toEqual([
      {
        thread_ts: "1699999999.0001",
        text:
          "<@U_ALICE> ✅ *APPROVED* — round 1, 14 min\n" +
          "Nothing blocking; the retry loop is bounded now.\n" +
          "<https://github.com/exampleorg/example-app/pull/5263|review on GitHub>",
      },
    ]);
  });

  it("drops the summary line when the verdict file carries none", async () => {
    store.upsertSlackThread({ pr: 5263, channel: "C_REVIEW", root_ts: "1699999999.0001" });
    reviewingRound(5263);
    writeVerdict(5263, 1, {
      pr: 5263,
      round_no: 1,
      verdict: "REQUEST_CHANGES",
      head_sha: "abcdef1234567890",
      finished_at: clock.toISOString(),
    });
    await watcher(announcer()).sweep();
    expect(slack.posts[0]!.text.split("\n")).toHaveLength(2);
  });

  it("announces a malformed verdict as an anomaly, never as an approval", async () => {
    store.upsertSlackThread({ pr: 5263, channel: "C_REVIEW", root_ts: "1699999999.0001" });
    reviewingRound(5263);
    writeFileSync(join(dir, "pr-5263-round-1.json"), "{not json");
    await watcher(announcer()).sweep();
    expect(slack.posts[0]).toEqual({
      thread_ts: "1699999999.0001",
      text: "⚠️ #5263 round 1 ended without a usable verdict — nothing was posted and no approval was implied.",
    });
  });

  it("announces an overdue round from the deadline sweep", async () => {
    store.upsertSlackThread({ pr: 5263, channel: "C_REVIEW", root_ts: "1699999999.0001" });
    reviewingRound(5263);
    clock = new Date("2026-08-17T23:00:00.000Z");
    await watcher(announcer()).checkDeadlines();
    expect(slack.posts[0]!.text).toBe(
      `⏱ #5263 round 1 blew its ${cfg.daemon.round_deadline_min}-min deadline — ` +
        "no verdict was posted, and no approval was implied. <@U_MAT>",
    );
  });

  it("announces a supersede in the newest-one wording, never a dismissal", async () => {
    store.upsertSlackThread({ pr: 5263, channel: "C_REVIEW", root_ts: "1699999999.0001" });
    reviewingRound(5263);
    store.startRound(5263, "re-review", ["pass-baseline"], cfg.daemon.round_deadline_min);
    clock = new Date("2026-08-17T23:00:00.000Z");
    await watcher(announcer()).checkDeadlines();
    expect(slack.posts[0]!.text).toBe(
      "♻️ the round-1 review is superseded by round 2 (`abcdef1`) — read the newest one",
    );
    expect(slack.posts[0]!.text).not.toContain("dismiss");
  });

  it("applies verdicts unchanged with no announcer, and survives a Slack outage", async () => {
    reviewingRound(5263);
    writeVerdict(5263, 1, {
      pr: 5263,
      round_no: 1,
      verdict: "APPROVE",
      head_sha: "abcdef1234567890",
      finished_at: clock.toISOString(),
      summary: "ok",
    });
    await watcher().sweep();
    expect(store.roundsFor(5263)[0]!.verdict).toBe("APPROVE");

    slack.throwAlways = true;
    reviewingRound(6000);
    writeVerdict(6000, 1, {
      pr: 6000,
      round_no: 1,
      verdict: "APPROVE",
      head_sha: "abcdef1234567890",
      finished_at: clock.toISOString(),
      summary: "ok",
    });
    await watcher(announcer()).sweep();
    expect(store.roundsFor(6000)[0]!.verdict).toBe("APPROVE");
    expect(store.slackPost("verdict:6000:1")).toMatchObject({ ok: 0 });
  });
});
