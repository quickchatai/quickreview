// Production-assembly invariants for the Slack concierge (S5b).
//
// The subject is src/wire.ts — `startSlack()` and `buildLocalCommandWatcher()`,
// the two functions `createProductionDaemon().onStart` is made of. Everything
// below the seam is faked: no socket, no fetch, no tmux, no secrets on disk.
//
// The invariants, in the order a reviewer would want them:
//   disabled  ⇒ nothing constructed and NO SECRET READ AT ALL
//   enabled   ⇒ a missing token or a failing auth.test is a HARD boot error
//   enabled   ⇒ two command watchers, right dirs, right tier gates
//   shutdown  ⇒ the goodbye is posted, the socket stops, the heartbeat stops
//   off       ⇒ the daemon still starts and stops exactly as before
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseConfig, type Config, type SecretReader } from "../src/config.js";
import { createDaemon, type DaemonAdapter } from "../src/daemon.js";
import { CommandWatcher, type CommandDeps } from "../src/commands.js";
import { StateStore } from "../src/state.js";
import { OriginStore } from "../src/slack/origin.js";
import type { SlackInboundHandler, SlackTransport } from "../src/slack/types.js";
import type { SessionHooks } from "../src/types.js";
import { buildLocalCommandWatcher, daemonOriginWakes, startSlack, type SlackRuntime } from "../src/wire.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shipped = readFileSync(join(root, "tests/fixtures/config.toml"), "utf8");

const CHANNEL = "C0CONCIERGE";
const OWNER = "U0OWNER";

let clock = new Date("2026-08-17T09:00:00.000Z");
const now = (): Date => new Date(clock);

let dir: string;
let store: StateStore;
let cfg: Config;

/** A transport that records everything and talks to nothing. */
function fakeTransport(over: Partial<SlackTransport> = {}): SlackTransport & {
  posts: Array<{ channel: string; text: string; thread_ts?: string }>;
  updates: Array<{ ts: string; text: string }>;
  handler: SlackInboundHandler | null;
  stopped: number;
} {
  const posts: Array<{ channel: string; text: string; thread_ts?: string }> = [];
  const updates: Array<{ ts: string; text: string }> = [];
  let seq = 0;
  const t = {
    posts,
    updates,
    handler: null as SlackInboundHandler | null,
    stopped: 0,
    async postMessage(a: { channel: string; text: string; thread_ts?: string }) {
      posts.push(a);
      return { ok: true, ts: `1712345678.${String(++seq).padStart(6, "0")}` };
    },
    async updateMessage(a: { channel: string; ts: string; text: string }) {
      updates.push({ ts: a.ts, text: a.text });
      return { ok: true, ts: a.ts };
    },
    async usersInfo(id: string) {
      return { id, display_name: id, is_bot: false };
    },
    async authTest() {
      return { user_id: "U0BOT", bot_id: "B0BOT", team_id: "T0" };
    },
    async pinsAdd() {
      return { ok: true };
    },
    async startSocket(h: SlackInboundHandler) {
      t.handler = h;
    },
    async stopSocket() {
      t.stopped += 1;
    },
    numConnections: 1,
    ...over,
  };
  return t as never;
}

const noopCommandDeps: CommandDeps = {
  rerunRound: () => ({ ok: true }),
  restartSession: () => ({ ok: true }),
  markEscalationWorthy: () => ({ ok: true }),
  pausePr: () => ({ ok: true }),
  resumePr: () => ({ ok: true }),
  flagOwnerLegacy: () => ({ ok: true }),
  fileImprovementPr: () => ({ ok: true }),
  fileIssue: () => ({ ok: true }),
};

function wiring(over: Partial<Parameters<typeof startSlack>[0]> = {}): Parameters<typeof startSlack>[0] {
  return {
    cfg,
    root: dir,
    store,
    commandDeps: noopCommandDeps,
    injectOverseerFile: async () => join(dir, "inject", "overseer", "wake.md"),
    injectOverseer: async () => {},
    log: () => {},
    now,
    readSecret: (() => "xoxb-fake") as SecretReader,
    makeTransport: () => fakeTransport(),
    ...over,
  };
}

beforeEach(() => {
  clock = new Date("2026-08-17T09:00:00.000Z");
  dir = mkdtempSync(join(tmpdir(), "qcr-slack-wire-"));
  mkdirSync(join(dir, "state"), { recursive: true });
  store = new StateStore(":memory:", now);
  cfg = parseConfig(shipped);
  cfg.slack.enabled = true;
  cfg.slack.channel = CHANNEL;
  cfg.owner.slack_id = OWNER;
  cfg.slack.users = { [OWNER]: "mhale" };
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe("slack off", () => {
  it("constructs nothing, reads no secret and builds no transport", async () => {
    cfg.slack.enabled = false;
    const readSecret = vi.fn(() => "xoxb-should-never-be-read");
    const makeTransport = vi.fn(() => fakeTransport());

    const runtime = await startSlack(wiring({ readSecret: readSecret as never, makeTransport: makeTransport as never }));

    expect(runtime).toBeUndefined();
    expect(readSecret).not.toHaveBeenCalled();
    expect(makeTransport).not.toHaveBeenCalled();
  });

  it("leaves the legacy command watcher exactly as it was before", () => {
    const watcher = buildLocalCommandWatcher({ root: dir, deps: noopCommandDeps, store, slack: null, log: () => {} });
    const opts = (watcher as unknown as { opts: { dir: string; tier?: unknown; deps: CommandDeps } }).opts;
    expect(opts.dir).toBe(join(dir, "commands"));
    expect(opts.tier).toBeUndefined();
    expect(opts.deps.slackReply).toBeUndefined();
  });

  it("the daemon still starts and stops with Slack off", async () => {
    cfg.slack.enabled = false;
    for (const d of ["state", "state/dryrun", "verdict", "inject"]) mkdirSync(join(dir, d), { recursive: true });
    const adapter = {
      searchLabelTriggered: async () => [],
      searchTeamTriggered: async () => [],
      searchAwaitingEscalationReviewer: async () => [],
      listOpenPrs: async () => [],
      stalenessScan: async () => [],
    } as unknown as DaemonAdapter;
    let announceResolved = 0;
    const daemon = createDaemon({
      cfg,
      root: dir,
      store,
      adapter,
      listen: false,
      log: () => {},
      announce: () => {
        announceResolved += 1;
        return undefined;
      },
    });
    await daemon.start();
    await daemon.stop();
    // The lazy seam is harmless when it resolves to nothing.
    expect(announceResolved).toBeGreaterThanOrEqual(0);
    expect(store.recentEvents(50).some((e) => e.kind === "daemon_start")).toBe(true);
    expect(store.recentEvents(50).some((e) => e.kind === "daemon_stop")).toBe(true);
  });
});

describe("slack on — boot", () => {
  it("throws at boot when a token file is missing or empty", async () => {
    const readSecret: SecretReader = (path) => (path.endsWith("slack_bot_token") ? undefined : "xapp-fake");
    await expect(startSlack(wiring({ readSecret }))).rejects.toThrow(/bot token file .* is missing or empty/);
  });

  it("throws at boot when auth.test cannot name us — a bot that cannot filter its echoes must not run", async () => {
    await expect(
      startSlack(wiring({ makeTransport: () => fakeTransport({ authTest: async () => undefined }) })),
    ).rejects.toThrow(/auth\.test failed/);
  });

  it("reads both tokens from the secrets dir, never from config or env", async () => {
    const seen: string[] = [];
    const readSecret: SecretReader = (path) => {
      seen.push(path);
      return "tok";
    };
    const runtime = await startSlack(wiring({ readSecret }));
    expect(runtime).toBeDefined();
    expect(seen).toContain(join(cfg.github.secrets_dir, "slack_bot_token"));
    expect(seen).toContain(join(cfg.github.secrets_dir, "slack_app_token"));
    await runtime!.stop("test");
  });
});

describe("slack on — the two command watchers", () => {
  let runtime: SlackRuntime;

  beforeEach(async () => {
    runtime = (await startSlack(wiring()))!;
  });
  afterEach(async () => {
    await runtime.stop("test");
  });

  it("puts the tier-checked watcher on commands/slack with a fail-closed gate", () => {
    const opts = (runtime.commands as unknown as { opts: { dir: string; tier: { dir: string; currentOrigin: () => unknown }; deps: CommandDeps } }).opts;
    expect(opts.dir).toBe(join(dir, "commands", "slack"));
    expect(opts.tier.dir).toBe("slack");
    expect(opts.tier.currentOrigin()).toBeNull(); // no live turn yet
    expect(opts.deps.slackReply).toBeDefined();
  });

  it("gives the legacy watcher the local belt and the same reply handler", () => {
    const watcher = buildLocalCommandWatcher({ root: dir, deps: noopCommandDeps, store, slack: runtime, log: () => {} });
    const opts = (watcher as unknown as { opts: { dir: string; tier: { dir: string; currentOrigin: () => unknown }; deps: CommandDeps } }).opts;
    expect(opts.dir).toBe(join(dir, "commands"));
    expect(opts.tier.dir).toBe("local");
    expect(opts.deps.slackReply).toBe(runtime.slackReply);
  });

  it("subscribes to the socket — the only inbound transport", () => {
    const t = runtime.transport as unknown as { handler: SlackInboundHandler | null };
    expect(t.handler).toBeTypeOf("function");
  });
});

describe("slack on — shutdown", () => {
  it("posts the stopping notice, stops the socket and stops the heartbeat", async () => {
    vi.useFakeTimers();
    const transport = fakeTransport();
    const runtime = (await startSlack(wiring({ makeTransport: () => transport })))!;

    // The pinned heartbeat posted once at boot; later ticks EDIT that message.
    expect(transport.posts.filter((p) => p.text.includes("review daemon"))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(cfg.slack.policy.heartbeat_interval_min * 60_000 + 1_000);
    const editsWhileLive = transport.updates.length;
    expect(editsWhileLive).toBeGreaterThan(0);

    await runtime.stop("SIGTERM");

    expect(transport.stopped).toBe(1);
    const goodbye = transport.posts.at(-1);
    expect(goodbye?.channel).toBe(CHANNEL);
    expect(goodbye?.text).toContain("review daemon stopping (SIGTERM)");

    await vi.advanceTimersByTimeAsync(cfg.slack.policy.heartbeat_interval_min * 60_000 * 3);
    expect(transport.updates.length).toBe(editsWhileLive); // heartbeat is dead
  });

  it("cannot be delayed by a Slack post that never resolves", async () => {
    vi.useFakeTimers();
    const transport = fakeTransport({ postMessage: () => new Promise(() => {}) as never });
    const runtime = (await startSlack(wiring({ makeTransport: () => transport })))!;
    const stopped = runtime.stop("SIGTERM");
    // The announcer's own bound (3s) is the only thing between us and a hang.
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(stopped).resolves.toBeUndefined();
    expect(transport.stopped).toBe(1);
  });
});

describe("state layout", () => {
  it("keeps origin records under state/slack/origin", async () => {
    const runtime = (await startSlack(wiring()))!;
    runtime.origins.write("wake.md", { event_id: "Ev1", slack_user: OWNER, tier: "owner_legacy", authorized_prs: [] });
    expect(runtime.origins.latest()?.event_id).toBe("Ev1");
    expect(runtime.origins.path("wake.md")).toBe(join(dir, "state", "slack", "origin", "wake.json"));
    await runtime.stop("test");
  });

  it("ships config.toml with [slack] enabled = false", () => {
    expect(parseConfig(shipped).slack.enabled).toBe(false);
  });
});

// ---- G1: who caused this turn, on BOTH sides -------------------------------
//
// The legacy-dir belt used to fire on wall-clock recency: an unexpired non-M
// origin refused `commands/`, an expired one released it. Both edges were bugs
// — waiting out 15 minutes was an escalation to tier M, and one guest message
// every 15 minutes blocked the daemon's OWN pipeline (EOD improvements/issues,
// anomaly wakes). Cause is now explicit on both sides.

describe("origin cause, not recency (the belt)", () => {
  const noHooks: SessionHooks = {
    dispatchRound: async () => {},
    inject: async () => {},
    archiveAndClose: async () => {},
    injectOverseer: async () => {},
  };

  /** The legacy watcher as production builds it, over a given runtime. */
  function legacy(runtime: SlackRuntime, deps: CommandDeps): CommandWatcher {
    return buildLocalCommandWatcher({ root: dir, deps, store, slack: runtime, log: () => {} });
  }

  const legacyResult = (name: string): Record<string, unknown> =>
    JSON.parse(readFileSync(join(dir, "commands", "results", `${name}.result.json`), "utf8"));

  function writeLegacyCommand(name: string, body: Record<string, unknown>): void {
    mkdirSync(join(dir, "commands"), { recursive: true });
    writeFileSync(join(dir, "commands", `${name}.json`), JSON.stringify(body));
  }

  it("the legacy gate reads the latest origin REGARDLESS of expiry", async () => {
    const runtime = (await startSlack(wiring()))!;
    runtime.origins.write("wake.md", { event_id: "Ev1", slack_user: "U0GUEST", tier: "anyone", authorized_prs: [] });
    clock = new Date("2026-08-17T09:20:00.000Z"); // +20 min: the TTL is 15
    expect(runtime.origins.latest()).toBeNull(); // the Slack dir sees nothing live…
    const watcher = legacy(runtime, noopCommandDeps);
    const gate = (watcher as unknown as { opts: { tier: { currentOrigin: () => unknown } } }).opts.tier;
    expect(gate.currentOrigin()).toMatchObject({ event_id: "Ev1", source: "slack", tier: "anyone" });
    await runtime.stop("test");
  });

  it("an EXPIRED slack origin still refuses a tier-M command in the legacy dir", async () => {
    const runtime = (await startSlack(wiring()))!;
    runtime.origins.write("wake.md", { event_id: "Ev1", slack_user: "U0GUEST", tier: "anyone", authorized_prs: [] });
    clock = new Date("2026-08-17T09:31:00.000Z"); // long past the TTL

    const fileIssue = vi.fn(() => ({ ok: true }));
    writeLegacyCommand("late", { command: "file-issue", title: "t", body: "b" });
    await legacy(runtime, { ...noopCommandDeps, fileIssue }).sweep();

    const r = legacyResult("late");
    expect(r.ok).toBe(false);
    expect(String(r.reason)).toMatch(/^tier: this turn was caused by a Slack message from U0GUEST/);
    expect(fileIssue).not.toHaveBeenCalled();
    await runtime.stop("test");
  });

  it("a daemon wake clears the belt, and the very same command then runs", async () => {
    const runtime = (await startSlack(wiring()))!;
    runtime.origins.write("wake.md", { event_id: "Ev1", slack_user: "U0GUEST", tier: "anyone", authorized_prs: [] });
    clock = new Date("2026-08-17T09:20:00.000Z");

    const fileIssue = vi.fn(() => ({ ok: true }));
    writeLegacyCommand("blocked", { command: "file-issue", title: "t", body: "b" });
    await legacy(runtime, { ...noopCommandDeps, fileIssue }).sweep();
    expect(legacyResult("blocked").ok).toBe(false);

    // The daemon wakes the overseer itself — through the wrapped hooks, exactly
    // as createProductionDaemon hands them to the daemon.
    const wakes: string[] = [];
    const { hooks } = daemonOriginWakes({
      hooks: { ...noHooks, injectOverseer: async (m) => void wakes.push(m) },
      origins: runtime.origins,
      enabled: true,
    });
    await hooks.injectOverseer("anomaly: verdict file is malformed");
    expect(wakes).toHaveLength(1);
    expect(runtime.origins.latestAny()).toMatchObject({ source: "local", tier: "owner_legacy", slack_user: "" });

    // The wrap must forward the optional liveness/kill hooks: dropping
    // sessionAlive here left the stuck-round detector blind in
    // production (found 2026-08-19) — every stuck round parked.
    const probed: number[] = [];
    const killedPrs: number[] = [];
    const { hooks: fullHooks } = daemonOriginWakes({
      hooks: {
        ...noHooks,
        sessionAlive: async (pr: number) => (probed.push(pr), true),
        killSession: async (pr: number) => void killedPrs.push(pr),
      },
      origins: runtime.origins,
      enabled: true,
    });
    expect(fullHooks.sessionAlive).toBeDefined();
    expect(fullHooks.killSession).toBeDefined();
    await fullHooks.sessionAlive!(42);
    await fullHooks.killSession!(43);
    expect(probed).toEqual([42]);
    expect(killedPrs).toEqual([43]);

    writeLegacyCommand("blocked", { command: "file-issue", title: "t", body: "b" });
    await legacy(runtime, { ...noopCommandDeps, fileIssue }).sweep();
    expect(legacyResult("blocked")).toMatchObject({ ok: true });
    expect(fileIssue).toHaveBeenCalledTimes(1);
    await runtime.stop("test");
  });

  it("the EOD sweep cannot be DoSed by one cheap message every 15 minutes", async () => {
    const runtime = (await startSlack(wiring()))!;
    const fileIssue = vi.fn(() => ({ ok: true }));
    const fileImprovementPr = vi.fn(() => ({ ok: true }));
    const deps = { ...noopCommandDeps, fileIssue, fileImprovementPr };

    // A guest keeps the channel warm all afternoon.
    for (let i = 0; i < 8; i++) {
      clock = new Date(Date.parse("2026-08-17T14:00:00.000Z") + i * 14 * 60_000);
      runtime.origins.write(`chat-${i}.md`, {
        event_id: `Ev${i}`,
        slack_user: "U0GUEST",
        tier: "anyone",
        authorized_prs: [],
      });
    }

    // 18:00 Warsaw: the EOD timer wakes the overseer through the wrapped hooks…
    clock = new Date("2026-08-17T16:00:00.000Z");
    const { wake } = daemonOriginWakes({ hooks: noHooks, origins: runtime.origins, enabled: true });
    await wake("eod-sweep", "run the EOD sweep");

    // …and its improvement/issue commands land in the legacy dir and RUN.
    writeLegacyCommand("eod-issue", { command: "file-issue", title: "flaky test", body: "…" });
    writeLegacyCommand("eod-pr", { command: "file-improvement-pr", branch: "bot/improve-x", title: "t", body: "b", slug: "x" });
    await legacy(runtime, deps).sweep();

    expect(legacyResult("eod-issue")).toMatchObject({ ok: true });
    expect(legacyResult("eod-pr")).toMatchObject({ ok: true });
    expect(fileIssue).toHaveBeenCalledTimes(1);
    expect(fileImprovementPr).toHaveBeenCalledTimes(1);
    await runtime.stop("test");
  });

  it("a Slack turn stamps a SLACK origin — the router keeps the un-wrapped inject path", async () => {
    const origins = new OriginStore(join(dir, "state", "slack", "origin"), now);
    const runtime = (await startSlack(wiring({ origins })))!;
    const ts = "1755431234.000100";
    await runtime.router.handle({
      event_id: "EvRouted",
      type: "message",
      channel: CHANNEL,
      ts,
      user: "U0GUEST",
      text: "any news?",
      event_ts: `${Math.floor(clock.getTime() / 1000)}.000100`,
    });
    expect(origins.latestAny()).toMatchObject({ source: "slack", slack_user: "U0GUEST", tier: "anyone" });
    // …and the belt is on for the legacy dir while that turn is the cause.
    const watcher = legacy(runtime, noopCommandDeps);
    const gate = (watcher as unknown as { opts: { tier: { currentOrigin: () => unknown } } }).opts.tier;
    expect(gate.currentOrigin()).toMatchObject({ source: "slack" });
    await runtime.stop("test");
  });

  it("the Slack dir still fails closed with no origin, and with an expired one", async () => {
    const runtime = (await startSlack(wiring()))!;
    const gate = (runtime.commands as unknown as { opts: { tier: { currentOrigin: () => unknown } } }).opts.tier;
    expect(gate.currentOrigin()).toBeNull();
    runtime.origins.write("wake.md", { event_id: "Ev1", slack_user: "U0GUEST", tier: "anyone", authorized_prs: [] });
    expect(gate.currentOrigin()).not.toBeNull();
    clock = new Date("2026-08-17T09:20:00.000Z");
    expect(gate.currentOrigin()).toBeNull(); // expiry still denies HERE

    const deps = { ...noopCommandDeps, fileIssue: vi.fn(() => ({ ok: true })) };
    mkdirSync(join(dir, "commands", "slack"), { recursive: true });
    writeFileSync(join(dir, "commands", "slack", "x.json"), JSON.stringify({ command: "file-issue", title: "t", body: "b" }));
    const watcher = new CommandWatcher({
      dir: join(dir, "commands", "slack"),
      tier: { dir: "slack", currentOrigin: () => runtime.origins.latest() },
      deps,
      store,
      log: () => {},
    });
    await watcher.sweep();
    const r = JSON.parse(readFileSync(join(dir, "commands", "slack", "results", "x.result.json"), "utf8"));
    expect(r.ok).toBe(false);
    expect(String(r.reason)).toMatch(/^tier: no live Slack origin/);
    expect(deps.fileIssue).not.toHaveBeenCalled();
    await runtime.stop("test");
  });
});
