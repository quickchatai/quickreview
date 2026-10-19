// The Slack concierge, end to end through the PRODUCTION assembly. Style
// model: tests/e2e-dryrun.test.ts — real modules, fake everything at the edges. No live Slack, no tmux, no pi, no real fetch.
//
// Inbound is retired with the overseer: an inbound Slack message is recorded
// and refused (`dropped_no_overseer`) — no inject file, no origin record, no
// turn, no post. What stays is the outbound half:
//
//   a command file in commands/slack/<file>.json  { command: "slack_reply" }
//     → the tier-checked CommandWatcher validates + authorizes it
//     → exactly ONE post, in the right channel, in the right thread
//     → a `slack_posts` ledger row
//   announcements, and the connection signal (to the companion inbox)
//
// Plus the two invariants that make the feature safe to ship: a tier-denied
// command lands a `tier: ` reason and does nothing else, and NOT ONE GitHub
// fetch happens anywhere in the Slack path — this feature adds no GitHub
// mutation, so the MutationGate has nothing new to guard.
//
// The origin belt itself (a recorded Slack turn limits what `commands/` may do)
// still ships until its own removal, so its tests seed an origin record
// directly: nothing in production writes one any more.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseConfig, type Config } from "../src/config.js";
import { CommandWatcher, type CommandDeps } from "../src/commands.js";
import { StateStore } from "../src/state.js";
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
let inboxItems: Array<{ cls: string; text: string }>;

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
  // the handler is fire-and-forget; let the routing settle
  await new Promise((r) => setTimeout(r, 0));
}

/** The origin record a Slack turn used to leave: the belt's only input. */
function seedSlackTurn(ev: SlackInboundEvent, tier: "owner" | "author"): void {
  runtime.origins.write(`event-${ev.event_id}`, {
    event_id: ev.event_id,
    slack_user: ev.user ?? "",
    tier,
    authorized_prs: tier === "author" ? [PR] : [],
  });
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
  inboxItems = [];
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
    writeInbox: async (text, cls) => {
      inboxItems.push({ cls, text });
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
    "refuses an inbound message: one row, no inject, no origin, no post, no GitHub call",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const ev = event();
      const postsBefore = transport.posts.length;
      await deliver(ev);

      // recorded, and refused with the reason that names the retirement
      expect(store.slackEvent(ev.event_id)?.disposition).toBe("dropped_no_overseer");
      expect(store.slackEvent(ev.event_id)?.injected_at).toBeNull();
      // nothing was handed to a session and no rights record was written
      expect(existsSync(join(dir, "inject"))).toBe(false);
      expect(runtime.origins.latestAny()).toBeNull();
      // the model never speaks, and the bot does not answer the channel
      expect(transport.posts).toHaveLength(postsBefore);
      expect(inboxItems).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it("refuses the owner's inbound message too, and a redelivery stays one row", async () => {
    const ev = event({ user: OWNER });
    await deliver(ev);
    await deliver(ev);
    expect(store.slackEvent(ev.event_id)).toMatchObject({
      tier: "owner",
      disposition: "dropped_no_overseer",
    });
    expect(existsSync(join(dir, "inject"))).toBe(false);
  });

  it(
    "a command file still posts one threaded reply and ledgers it",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const ev = event();
      await deliver(ev);
      seedSlackTurn(ev, "author");

      writeSlackCommand("reply-1", {
        command: "slack_reply",
        thread: ev.ts,
        text: "Round 2 is running now — verdict in ~10 min.",
      });
      await runtime.commands.sweep();

      // exactly one post, right channel, right thread, right text
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

      // ledgered under the command file's own idem key (one post per file),
      // named by the directory that served it
      const row = store.slackPost("reply:slack/reply-1");
      expect(row).toMatchObject({ kind: "reply", thread_ts: ev.ts, ok: 1 });
      expect(row?.ts).toMatch(/^\d{10}\.\d{6}$/); // the delivered message's ts, as a string

      // not one GitHub call anywhere in that loop
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it("refuses a second post for the same command file (replayed sweep)", async () => {
    const ev = event();
    await deliver(ev);
    seedSlackTurn(ev, "author");
    writeSlackCommand("reply-2", { command: "slack_reply", thread: ev.ts, text: "once" });
    await runtime.commands.sweep();
    // The processed file is archived; re-writing the SAME name is a replay.
    writeSlackCommand("reply-2", { command: "slack_reply", thread: ev.ts, text: "once" });
    await runtime.commands.sweep();

    expect(transport.posts.filter((p) => p.thread_ts === ev.ts)).toHaveLength(1);
    expect(resultFile("reply-2")).toMatchObject({ ok: false });
    expect(String(resultFile("reply-2").reason)).toContain(
      "already posted (idem_key reply:slack/reply-2)",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("treats a new sealed operator file version as fresh while repeated sweeps stay deduplicated", async () => {
    const ev = event();
    await deliver(ev);
    seedSlackTurn(ev, "author");
    const operator = join(dir, "commands", "operator");
    mkdirSync(operator, { recursive: true });
    const path = join(operator, "reply.json");
    const body = JSON.stringify({ command: "slack_reply", thread: ev.ts, text: "operator reply" });
    const watcher = new CommandWatcher({
      dir: operator,
      scope: "operator",
      deps: { ...commandDeps(), slackReply: runtime.slackReply },
      store,
      operator: {
        euid: 1001,
        gids: [1001],
        stat: (p) =>
          p.endsWith(".json")
            ? { uid: 0, gid: 0, mode: 0o644, kind: "file" }
            : { uid: 0, gid: 0, mode: 0o755, kind: "dir" },
      },
    });
    try {
      writeFileSync(path, body);
      await watcher.sweep();
      await watcher.sweep();
      expect(transport.posts.filter((p) => p.thread_ts === ev.ts)).toHaveLength(1);
      const replacement = join(operator, "replacement.tmp");
      writeFileSync(replacement, body);
      renameSync(replacement, path);
      await watcher.sweep();
      await watcher.sweep();
      expect(transport.posts.filter((p) => p.thread_ts === ev.ts)).toHaveLength(2);
      const replies = ledger().filter((row) => row.kind === "reply");
      expect(replies).toHaveLength(2);
      expect(new Set(replies.map((row) => row.idem_key)).size).toBe(2);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      watcher.stop();
    }
  });

  it("a same-named reply served from commands/ is a different delivery, not a replay", async () => {
    const ev = event();
    await deliver(ev);
    seedSlackTurn(ev, "author");
    writeSlackCommand("reply-3", { command: "slack_reply", thread: ev.ts, text: "from slack/" });
    await runtime.commands.sweep();
    // What the commands/ watcher hands the same handler for its reply-3.json.
    const out = await runtime.slackReply({
      thread: ev.ts,
      text: "from commands/",
      file: "reply-3",
    });

    expect(out).toMatchObject({ ok: true });
    expect(transport.posts.filter((p) => p.thread_ts === ev.ts).map((p) => p.text)).toEqual([
      "from slack/",
      "from commands/",
    ]);
  });
});

describe("tier enforcement in the production path", () => {
  it("denies file-issue from an author-tier turn: a `tier: ` reason, no GitHub call, no post", async () => {
    const ev = event();
    await deliver(ev);
    seedSlackTurn(ev, "author");
    expect(runtime.origins.latest()?.tier).toBe("author");

    const postsBefore = transport.posts.length;
    // A deferral's ticket is filed by the review session
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
    seedSlackTurn(event({ user: OWNER, text: "re-run 4242 please" }), "owner");
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
    // The WHOLE message, not a substring: a broken round-type label would
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

  it("routes the duplicate-consumer signal to the companion inbox, never to the channel", async () => {
    const postsBefore = transport.posts.length;
    runtime.announcer.noteConnections(3);
    await vi.waitFor(() => expect(inboxItems).toHaveLength(1));
    expect(inboxItems[0]?.cls).toBe("anomaly");
    expect(inboxItems[0]?.text).toContain("3 connections");
    expect(transport.posts).toHaveLength(postsBefore);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
