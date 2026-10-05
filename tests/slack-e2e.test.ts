// The Slack concierge, end to end through the PRODUCTION assembly (
// S5b). Style model: tests/e2e-dryrun.test.ts — real modules, fake everything
// at the edges. No live Slack, no tmux, no pi, no real fetch.
//
// The loop under test is the whole feature:
//
//   inbound Slack message
//     → SlackRouter (channel/echo/subtype/dedupe/staleness/cap)
//     → overseer inject file carrying the `<!-- qcr:slack v1 -->` envelope
//     → origin record on disk (the rights, written down, next to the inject)
//     → overseer writes commands/slack/<file>.json  { command: "slack_reply" }
//     → the tier-checked CommandWatcher validates + authorizes it
//     → exactly ONE post, in the right channel, in the right thread
//     → a `slack_posts` ledger row
//
// Plus the two invariants that make the feature safe to ship: a tier-denied
// command lands a `tier: ` reason and does nothing else, and NOT ONE GitHub
// fetch happens anywhere in the Slack path — this feature adds no GitHub
// mutation, so the MutationGate has nothing new to guard.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseConfig, type Config } from "../src/config.js";
import type { CommandDeps } from "../src/commands.js";
import { StateStore } from "../src/state.js";
import { SLACK_INJECT_MARKER } from "../src/slack/router.js";
import type { SlackInboundEvent, SlackInboundHandler, SlackTransport } from "../src/slack/types.js";
import { startSlack, type SlackRuntime } from "../src/wire.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shipped = readFileSync(join(root, "tests/fixtures/config.toml"), "utf8");

const CHANNEL = "C0CONCIERGE";
const OWNER = "U0OWNER";
const ALICE = "U0ALICE";
const PR = 4242;

let clock = new Date("2026-08-17T09:00:00.000Z");
const now = (): Date => new Date(clock);
const slackTs = (d: Date, seq: number): string =>
  `${Math.floor(d.getTime() / 1000)}.${String(seq).padStart(6, "0")}`;

let dir: string;
let store: StateStore;
let cfg: Config;
let runtime: SlackRuntime;
let transport: FakeTransport;
let fetchSpy: ReturnType<typeof vi.fn>;
let injectSeq = 0;
let overseerWakes: string[];

interface FakeTransport extends SlackTransport {
  posts: Array<{ channel: string; text: string; thread_ts?: string }>;
  handler: SlackInboundHandler | null;
  stopped: number;
}

function fakeTransport(): FakeTransport {
  const posts: Array<{ channel: string; text: string; thread_ts?: string }> = [];
  let seq = 100;
  const t: FakeTransport = {
    posts,
    handler: null,
    stopped: 0,
    async postMessage(a) {
      posts.push(a);
      return { ok: true, ts: slackTs(now(), ++seq) };
    },
    async updateMessage(a) {
      return { ok: true, ts: a.ts };
    },
    async usersInfo(id) {
      return { id, display_name: id === ALICE ? "Alice Nowak" : "Morgan", is_bot: false };
    },
    async authTest() {
      return { user_id: "U0BOT", bot_id: "B0BOT", team_id: "T0" };
    },
    async pinsAdd() {
      return { ok: true };
    },
    async startSocket(h) {
      t.handler = h;
    },
    async stopSocket() {
      t.stopped += 1;
    },
    numConnections: 1,
  };
  return t;
}

/** The command handlers the daemon wires. Any GitHub-touching one FAILS the
 * test if reached: a tier-denied command must never get this far. */
function commandDeps(): CommandDeps {
  const forbidden = (what: string) => () => {
    throw new Error(`${what} must never run from a denied Slack turn`);
  };
  return {
    rerunRound: () => ({ ok: true, requeued: PR }),
    restartSession: forbidden("restart-session"),
    pausePr: () => ({ ok: true }),
    resumePr: () => ({ ok: true }),
    flagOwner: () => ({ ok: true }),
    fileImprovementPr: forbidden("file-improvement-pr"),
    fileIssue: forbidden("file-issue"),
    resolveTerminalFailure: forbidden("resolve-terminal-failure"),
  };
}

/** Stand-in for PiSessionManager.injectOverseerFile: a real file, a real path. */
async function injectOverseerFile(message: string): Promise<string> {
  const d = join(dir, "inject", "overseer");
  mkdirSync(d, { recursive: true });
  const path = join(d, `2026-08-17T09-00-00-${String(++injectSeq).padStart(4, "0")}.md`);
  writeFileSync(path, message);
  return path;
}

function event(over: Partial<SlackInboundEvent> = {}): SlackInboundEvent {
  const ts = slackTs(now(), 1);
  return {
    event_id: `Ev${injectSeq}${Math.random().toString(36).slice(2, 8)}`,
    type: "message",
    channel: CHANNEL,
    ts,
    user: ALICE,
    text: "any news on the review for 4242?",
    event_ts: ts,
    ...over,
  };
}

/** Deliver an event exactly as the socket would, and wait for the routing. */
async function deliver(ev: SlackInboundEvent): Promise<void> {
  expect(transport.handler).toBeTypeOf("function");
  void transport.handler!(ev);
  await vi.waitFor(() => expect(store.slackEvent(ev.event_id)).toBeDefined());
  // the handler is fire-and-forget; let the inject + origin write settle
  await new Promise((r) => setTimeout(r, 0));
}

function writeSlackCommand(name: string, body: Record<string, unknown>): string {
  const d = join(dir, "commands", "slack");
  mkdirSync(d, { recursive: true });
  const path = join(d, `${name}.json`);
  writeFileSync(path, JSON.stringify(body));
  return path;
}

function resultFile(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(dir, "commands", "slack", "results", `${name}.result.json`), "utf8"),
  );
}

function ledger(): Array<Record<string, unknown>> {
  return store.db
    .prepare("SELECT idem_key, kind, pr, thread_ts, ok, ts FROM slack_posts ORDER BY rowid")
    .all() as never;
}

beforeEach(async () => {
  clock = new Date("2026-08-17T09:00:00.000Z");
  injectSeq = 0;
  overseerWakes = [];
  dir = mkdtempSync(join(tmpdir(), "qcr-slack-e2e-"));
  mkdirSync(join(dir, "state"), { recursive: true });
  store = new StateStore(":memory:", now);
  cfg = parseConfig(shipped);
  cfg.slack.enabled = true;
  cfg.slack.channel = CHANNEL;
  cfg.owner.slack_id = OWNER;
  cfg.slack.users = { [OWNER]: "mhale", [ALICE]: "alice-gh" };
  store.upsertPr({
    number: PR,
    state: "reviewing",
    head_sha: "0f1e2d3c",
    title: "fix(webhooks): stop dropping retries on 5xx",
    author: "alice-gh",
    trigger_ts: null,
    stale_recheck: 0,
    migration_gate: 0,
  });

  // Nothing in the Slack path may reach GitHub. A spy, not a stub: any call is
  // a failure, and the assertion is repeated in every test below.
  fetchSpy = vi.fn(async () => {
    throw new Error("no HTTP request may leave the Slack path");
  });
  vi.stubGlobal("fetch", fetchSpy);

  transport = fakeTransport();
  runtime = (await startSlack({
    cfg,
    root: dir,
    store,
    commandDeps: commandDeps(),
    injectOverseerFile,
    injectOverseer: async (m) => {
      overseerWakes.push(m);
    },
    log: () => {},
    now,
    readSecret: () => "token",
    makeTransport: () => transport,
  }))!;
});

afterEach(async () => {
  await runtime.stop("test");
  vi.unstubAllGlobals();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the full concierge loop", () => {
  it(
    "carries one Slack message to one threaded reply, and ledgers it",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const ev = event();
      await deliver(ev);

      // (1) the turn was injected, once
      expect(store.slackEvent(ev.event_id)?.disposition).toBe("injected");

      // (2) the inject file exists and carries the trusted envelope
      const injects = readdirSync(join(dir, "inject", "overseer"));
      expect(injects).toHaveLength(1);
      const body = readFileSync(join(dir, "inject", "overseer", injects[0]!), "utf8");
      expect(body.startsWith(SLACK_INJECT_MARKER)).toBe(true);
      expect(body).toContain(`| thread | ${ev.ts} |`);
      expect(body).toContain("| tier | author |");
      expect(body).toContain("| github_login | alice-gh |");
      expect(body).toContain("> any news on the review for 4242?");

      // (3) the rights were written down next to it, under state/slack/origin
      const originPath = join(
        dir,
        "state",
        "slack",
        "origin",
        injects[0]!.replace(/\.md$/, ".json"),
      );
      expect(existsSync(originPath)).toBe(true);
      const origin = JSON.parse(readFileSync(originPath, "utf8"));
      expect(origin).toMatchObject({
        event_id: ev.event_id,
        slack_user: ALICE,
        tier: "author",
        authorized_prs: [PR],
      });
      expect(runtime.origins.latest()?.event_id).toBe(ev.event_id);

      // (4) the overseer answers by writing a command file into commands/slack/
      writeSlackCommand("reply-1", {
        command: "slack_reply",
        thread: ev.ts,
        text: "Round 2 is running now — verdict in ~10 min.",
      });
      await runtime.commands.sweep();

      // (5) exactly one post, right channel, right thread, right text
      const replies = transport.posts.filter((p) => p.thread_ts === ev.ts);
      expect(replies).toHaveLength(1);
      expect(replies[0]).toEqual({
        channel: CHANNEL,
        thread_ts: ev.ts,
        text: "Round 2 is running now — verdict in ~10 min.",
      });
      expect(resultFile("reply-1")).toMatchObject({
        ok: true,
        command: "slack_reply",
        thread: ev.ts,
      });

      // (6) ledgered under the command file's own idem key (one post per file)
      const row = store.slackPost("reply:reply-1");
      expect(row).toMatchObject({ kind: "reply", thread_ts: ev.ts, ok: 1 });
      expect(row?.ts).toMatch(/^\d{10}\.\d{6}$/); // the delivered message's ts, as a string

      // (7) not one GitHub call anywhere in that loop
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it("refuses a second post for the same command file (replayed sweep)", async () => {
    const ev = event();
    await deliver(ev);
    writeSlackCommand("reply-2", { command: "slack_reply", thread: ev.ts, text: "once" });
    await runtime.commands.sweep();
    // The processed file is archived; re-writing the SAME name is a replay.
    writeSlackCommand("reply-2", { command: "slack_reply", thread: ev.ts, text: "once" });
    await runtime.commands.sweep();

    expect(transport.posts.filter((p) => p.thread_ts === ev.ts)).toHaveLength(1);
    expect(resultFile("reply-2")).toMatchObject({ ok: false });
    expect(String(resultFile("reply-2").reason)).toContain(
      "already posted (idem_key reply:reply-2)",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("tier enforcement in the production path", () => {
  it("denies file-issue from an author-tier turn: a `tier: ` reason, no GitHub call, no post", async () => {
    const ev = event();
    await deliver(ev);
    expect(runtime.origins.latest()?.tier).toBe("author");

    const postsBefore = transport.posts.length;
    // (corrected): a deferral's ticket is filed by the review session
    // itself through the legacy command dir, so `file-issue` stays
    // owner-tier on Slack — an author-tier turn is refused outright, with a
    // `tier: ` reason, no GitHub call and no post.
    writeSlackCommand("issue-1", {
      command: "file-issue",
      title: "please fix CI",
      body: "it is red",
    });
    await runtime.commands.sweep();

    const result = resultFile("issue-1");
    expect(result.ok).toBe(false);
    expect(String(result.reason).startsWith("tier: ")).toBe(true);
    expect(String(result.reason)).toContain("requires tier owner");
    expect(transport.posts).toHaveLength(postsBefore);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(store.recentEvents(50).some((e) => e.kind === "command_rejected")).toBe(true);
  });

  it("fails closed when no Slack turn is live", async () => {
    writeSlackCommand("rerun-1", { command: "rerun-round", pr: PR });
    await runtime.commands.sweep();
    const result = resultFile("rerun-1");
    expect(result.ok).toBe(false);
    expect(String(result.reason)).toContain("no live Slack origin");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("lets the owner through the same door", async () => {
    await deliver(event({ user: OWNER, text: "re-run 4242 please" }));
    writeSlackCommand("rerun-2", { command: "rerun-round", pr: PR });
    await runtime.commands.sweep();
    expect(resultFile("rerun-2")).toMatchObject({ ok: true, command: "rerun-round" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("announcements own the thread", () => {
  it("opens the PR thread at pickup and threads the verdict under that root", async () => {
    await runtime.announcer.roundStarted({
      pr: PR,
      title: "fix(webhooks): stop dropping retries on 5xx",
      author: "alice-gh",
      head_sha: "0f1e2d3c",
      round_no: 1,
      round_type: "first",
      lenses: ["pass-baseline", "pass-validate"],
      additions: 18,
      deletions: 4,
      changed_files: 2,
    });

    const pickup = transport.posts.at(-1)!;
    expect(pickup.thread_ts).toBeUndefined(); // root-on-first-event
    // The WHOLE message, not a substring: a broken round-type label used to
    // render `· undefined ·` here and still contain "#4242".
    expect(pickup.text).toBe(
      `👀 *<https://github.com/${cfg.github.repo}/pull/${PR}|#${PR} fix(webhooks): stop dropping retries on 5xx>*` +
        ` — review started for <@${ALICE}>\n` +
        "_round 1 · first review · 2 files, +18/−4 · lenses: pass-baseline, pass-validate_",
    );
    const rootTs = store.slackThreadForPr(PR)?.root_ts;
    expect(rootTs).toBeTypeOf("string");

    await runtime.announcer.verdict({
      pr: PR,
      round_no: 1,
      verdict: "APPROVE",
      summary: "no blockers",
      duration_s: 540,
    });

    const verdictPost = transport.posts.at(-1)!;
    expect(verdictPost.thread_ts).toBe(rootTs);
    expect(
      ledger()
        .filter((r) => r.pr === PR)
        .map((r) => r.idem_key),
    ).toEqual([`pickup:${PR}`, `verdict:${PR}:1`]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("routes the duplicate-consumer signal to the overseer, never to the channel", async () => {
    const postsBefore = transport.posts.length;
    runtime.announcer.noteConnections(3);
    await vi.waitFor(() => expect(overseerWakes).toHaveLength(1));
    expect(overseerWakes[0]).toContain("3 connections");
    expect(transport.posts).toHaveLength(postsBefore);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
