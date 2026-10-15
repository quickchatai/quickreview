// The companion action channel driving a REAL App — the buildTuiDriver
// mapping (docs/tui-actions-wiring.md) plus the filter consumption invariant: render
// and verb handlers share ONE filtered ordering, so selection movement and
// x/p/e can never address a hidden row.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { StatusSnapshot } from "../src/state.js";
import { processTuiActions } from "../src/tui/actions.js";
import { renderBoard } from "../src/tui/board.js";
import type { DeployFetcher } from "../src/tui/deploytab.js";
import { installDeployHooks } from "../src/tui/deploytab.js";
import { applyMemoryFilter } from "../src/tui/filters.js";
import { FeedWriter } from "../src/tui/feed.js";
import { buildTuiDriver, chainOnPoll } from "../src/tui/index.js";
import type { CompanionSidebar } from "../src/tui/sidebar.js";
import { decodeKey } from "../src/tui/keys.js";
import { timelineOrder, type MemoryHealth } from "../src/tui/memory.js";
import {
  legacyBlockHash as blockHash,
  parseLegacyMemory as parseMemory,
} from "../src/memory/legacy-file.js";
import type { MemoryOp } from "../src/memory/store.js";
import { installMetricsHooks, type MetricsFetcher } from "../src/tui/metricstab.js";
import { stripAnsi } from "../src/tui/paint.js";
import { FakeMemory, learningRig, SAMPLE, settle, type Rig } from "./helpers/tui-rig.js";

class FakeMetrics implements MetricsFetcher {
  timelineCalls: number[] = [];
  overall(): ReturnType<MetricsFetcher["overall"]> {
    return Promise.resolve({ error: "fake fetcher — no dashboard" });
  }
  timeline(pr: number): ReturnType<MetricsFetcher["timeline"]> {
    this.timelineCalls.push(pr);
    return Promise.resolve({ error: "fake fetcher — no timeline" });
  }
}

const fakeDeploy: DeployFetcher = {
  load: () => Promise.resolve({ dirty: [], plan: ["plan"], containerStatus: "Up 2 hours" }),
};

const snapshot: StatusSnapshot = {
  written_at: "2026-08-20T12:00:00Z",
  dry_run: true,
  prs: [
    {
      number: 5012,
      state: "reviewing",
      title: "fix(crm): retry",
      head_sha: "aa11",
      stale_recheck: 0,
      author: "alice",
    },
    {
      number: 5049,
      state: "awaiting_author",
      title: "feat(remote-api): dispatch",
      head_sha: "bb22",
      stale_recheck: 0,
      author: "bob",
    },
    {
      number: 5100,
      state: "tracked",
      title: "chore: bump deps",
      head_sha: "cc33",
      stale_recheck: 0,
      author: "alice",
    },
  ],
  running_rounds: 0,
  total_spend_usd: 0,
  heartbeat: "2026-08-20T12:00:00Z",
};

interface WiredRig extends Rig {
  metricsView: ReturnType<typeof installMetricsHooks>;
  deployState: ReturnType<typeof installDeployHooks>;
  metrics: FakeMetrics;
  driver: ReturnType<typeof buildTuiDriver>;
}

function makeRig(mem?: FakeMemory): WiredRig {
  const rig = learningRig({
    fetchProposals: () => Promise.resolve({ proposals: [], improvements: [] }),
    ...(mem ? { mem } : {}),
  });
  rig.app.view.snapshot = snapshot;
  const metrics = new FakeMetrics();
  const metricsView = installMetricsHooks(rig.app, metrics);
  const deployState = installDeployHooks(rig.app, fakeDeploy);
  const driver = buildTuiDriver(rig.app, rig.learning, metricsView, deployState);
  return { ...rig, metricsView, deployState, metrics, driver };
}

const memoryScreen = (rig: Rig): string =>
  stripAnsi(rig.app.hooks.tabs.memory!.screen(rig.app, 110, 30).render());
const memoryKey = (rig: Rig, k: string): boolean =>
  rig.app.hooks.tabs.memory!.key(rig.app, decodeKey(Buffer.from(k)));

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function actionDir(): string {
  const root = mkdtempSync(join(tmpdir(), "qcr-tui-actions-"));
  tmps.push(root);
  const dir = join(root, "tui-actions");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function drop(dir: string, name: string, body: unknown): void {
  writeFileSync(join(dir, name), JSON.stringify(body));
}

// ---- the tests --------------------------------------------------------------

describe("actions wiring: the watcher on a real App", () => {
  it("switch_tab memory lands on the memory tab — the verb's name IS the tab's — and archives + writes a result", async () => {
    const { app, driver } = makeRig();
    const dir = actionDir();
    drop(dir, "2026-08-20T12-00-00-tab.json", { verb: "switch_tab", params: { tab: "memory" } });
    const done = await processTuiActions(dir, driver);
    expect(done).toHaveLength(1);
    expect(done[0]!.ok).toBe(true);
    expect(app.tab).toBe("memory");
    expect(readdirSync(join(dir, ".done"))).toContain("2026-08-20T12-00-00-tab.json");
    expect(readdirSync(dir)).toContain("2026-08-20T12-00-00-tab.result.json");
  });

  it("switch_tab reaches every one of the seven, and the retired `changes` is refused", async () => {
    const { app, driver } = makeRig();
    for (const tab of ["digest", "tickets", "feedback", "deploy", "metrics", "board"] as const) {
      driver.switchTab(tab);
      expect(app.tab).toBe(tab);
    }
    const dir = actionDir();
    drop(dir, "old.json", { verb: "switch_tab", params: { tab: "changes" } });
    const [r] = await processTuiActions(dir, driver);
    expect(r!.ok).toBe(false);
    expect(r!.message).toContain("switch_tab needs tab");
  });

  it("select_pr jumps to the board and selects the PR", async () => {
    const { app, driver } = makeRig();
    app.tab = "metrics";
    const dir = actionDir();
    drop(dir, "a.json", { verb: "select_pr", params: { pr: "5049" } });
    const [r] = await processTuiActions(dir, driver);
    expect(r!.trace).toContain("#5049");
    expect(app.tab).toBe("board");
    expect(app.currentPr()).toBe(5049);
  });

  it("board_filter hides non-matching rows and paints the indicator", async () => {
    const { app, driver } = makeRig();
    const dir = actionDir();
    drop(dir, "f.json", { verb: "board_filter", params: { author: "alice" } });
    await processTuiActions(dir, driver);
    expect(app.view.boardFilter).toEqual({ author: "alice" });
    const screen = stripAnsi(renderBoard(app.view, 110, 30).render());
    expect(screen).toContain("PRS (2)");
    expect(screen).toContain("#5012");
    expect(screen).toContain("#5100");
    expect(screen).not.toContain("#5049");
    expect(screen).toContain("author:alice — F clears");
  });

  it("selection movement walks the FILTERED list — never a hidden row", () => {
    const { app, driver } = makeRig();
    driver.selectPr(5012);
    driver.setBoardFilter({ author: "alice" });
    app.pressKey("j"); // next visible under the filter is #5100, not #5049
    expect(app.currentPr()).toBe(5100);
    expect(app.selectedSession()).toBe("pr-5100");
    app.pressKey("j"); // end of the filtered list — stays put
    expect(app.currentPr()).toBe(5100);
  });

  it("F on the board clears the filter", () => {
    const { app, driver } = makeRig();
    driver.setBoardFilter({ state: "reviewing" });
    expect(stripAnsi(renderBoard(app.view, 110, 30).render())).not.toContain("#5049");
    app.pressKey("F");
    expect(app.view.boardFilter).toBeNull();
    expect(stripAnsi(renderBoard(app.view, 110, 30).render())).toContain("#5049");
  });

  it("F keeps the highlighted row, the selected PR and the session on one PR", () => {
    const { app, driver } = makeRig();
    driver.setBoardFilter({ author: "bob" });
    driver.selectPr(5049); // the only row under the filter — ordinal 0
    app.pressKey("F");
    expect(app.view.boardFilter).toBeNull();
    expect(app.currentPr()).toBe(5049);
    expect(app.selectedPrNumber()).toBe(5049);
    expect(app.selectedSession()).toBe("pr-5049");
  });

  // MUTATION: store the requested PR before reselect falls back — red (the
  // highlighted row and the mirrored session part ways).
  it("selecting a PR the board does not list is refused; the selection stays on one PR", () => {
    const { app, driver } = makeRig();
    driver.selectPr(5100);
    driver.setBoardFilter({ author: "alice" });
    driver.switchTab("memory");
    expect(() => driver.selectPr(5049)).toThrow(/not on the board/);
    expect(app.tab).toBe("memory"); // a refused action changes nothing on screen
    expect(app.view.noticeLine).toContain("#5049 is not on the board");
    expect(app.currentPr()).toBe(5100);
    expect(app.selectedPrNumber()).toBe(5100);
    expect(app.selectedSession()).toBe("pr-5100");
  });

  it("a filter that hides the selected PR moves the selection to a listed one", () => {
    const { app, driver } = makeRig();
    driver.selectPr(5049);
    driver.setBoardFilter({ author: "alice" });
    expect(app.currentPr()).toBe(app.selectedPrNumber());
    expect(app.currentPr()).not.toBe(5049);
  });

  it("memory_filter narrows the timeline render and labels it", async () => {
    const rig = makeRig();
    rig.app.tab = "memory";
    memoryScreen(rig);
    await settle(); // memory loaded
    const dir = actionDir();
    drop(dir, "m.json", { verb: "memory_filter", params: { tag: "#false-positive" } });
    await processTuiActions(dir, rig.driver);
    expect(rig.learning.memory.filter).toBe("false-positive");
    expect(rig.app.tab).toBe("memory");
    const screen = memoryScreen(rig);
    expect(screen).toContain("MEMORY (1)");
    expect(screen).toContain("⛉ #false-positive — F clears");
    expect(screen).not.toContain("stale recheck flag");
  });

  it("verbs address the filtered ordering: p pins the visible entry, not the unfiltered ordinal", async () => {
    const rig = makeRig();
    rig.app.tab = "memory";
    memoryScreen(rig);
    await settle();
    rig.driver.setMemoryFilter("false-positive"); // unfiltered ordinal 0 is the #bug entry
    const want = applyMemoryFilter(timelineOrder(parseMemory(SAMPLE)), "false-positive")[0]!;
    memoryKey(rig, "p");
    await settle();
    expect(rig.mem.applied).toHaveLength(1);
    const op = rig.mem.applied[0]! as Extract<MemoryOp, { op: "pin" }>;
    expect(op.op).toBe("pin");
    expect(op.expect).toBe(blockHash(want.text));
    expect(rig.learning.memory.sel).toBe(0);
  });

  it("x x retires the filtered selection too", async () => {
    const rig = makeRig();
    rig.app.tab = "memory";
    memoryScreen(rig);
    await settle();
    rig.driver.setMemoryFilter("refuted");
    const want = applyMemoryFilter(timelineOrder(parseMemory(SAMPLE)), "refuted")[0]!;
    memoryKey(rig, "x");
    memoryKey(rig, "x");
    await settle();
    const op = rig.mem.applied[0]! as Extract<MemoryOp, { op: "retire" }>;
    expect(op.op).toBe("retire");
    expect(op.expect).toBe(blockHash(want.text));
  });

  it("F on the memory tab clears the memory filter", async () => {
    const rig = makeRig();
    rig.app.tab = "memory";
    memoryScreen(rig);
    await settle();
    rig.driver.setMemoryFilter("bug");
    expect(memoryKey(rig, "F")).toBe(true);
    expect(rig.learning.memory.filter).toBeNull();
    expect(memoryScreen(rig)).toContain("MEMORY (3)");
  });

  it("memory_view jumps to a day's first entry and filters; a day with no entry is a FAILED result", async () => {
    const rig = makeRig();
    rig.app.tab = "board";
    memoryScreen(rig);
    await settle();
    rig.driver.memoryView({ day: "2026-08-19" });
    expect(rig.app.tab).toBe("memory");
    expect(rig.learning.memory.sel).toBe(1); // the newest 2026-08-19 entry, after the one 2026-08-20 row
    expect(memoryScreen(rig)).toContain("memory · 2026-08-19");
    rig.driver.memoryView({ tag: "bug" });
    expect(rig.learning.memory.filter).toBe("bug");
    expect(rig.learning.memory.sel).toBe(0);
    const dir = actionDir();
    drop(dir, "d.json", { verb: "memory_view", params: { day: "2026-07-01" } });
    const [r] = await processTuiActions(dir, rig.driver);
    expect(r!.ok).toBe(false);
    expect(r!.message).toContain("no memory entries on 2026-07-01");
  });

  it("metrics window maps 7d→d7 and resets the drill", async () => {
    const { app, metricsView, driver } = makeRig();
    metricsView.drill = { pr: 1, loading: false };
    metricsView.scroll = 4;
    const dir = actionDir();
    drop(dir, "w.json", { verb: "metrics", params: { window: "7d" } });
    await processTuiActions(dir, driver);
    expect(app.tab).toBe("metrics");
    expect(metricsView.window).toBe("d7");
    expect(metricsView.drill).toBeUndefined();
    expect(metricsView.scroll).toBe(0);
  });

  it("metrics pr drives the tab's own #-entry keys into a timeline fetch", async () => {
    const { app, metricsView, metrics, driver } = makeRig();
    driver.metricsPr(5012); // presses # 5 0 1 2 ⏎ (digits 1/2/5 decode as tab keys — keyChar folds them back)
    await settle();
    expect(app.tab).toBe("metrics");
    expect(metrics.timelineCalls).toEqual([5012]);
    expect(metricsView.drill?.pr).toBe(5012);
  });

  it("metrics pr opens the requested timeline when another one is already open", async () => {
    const { metricsView, metrics, driver } = makeRig();
    driver.metricsPr(5012);
    await settle();
    const dir = actionDir();
    drop(dir, "p.json", { verb: "metrics", params: { pr: 5049 } });
    const [r] = await processTuiActions(dir, driver);
    await settle();
    expect(r!.ok).toBe(true);
    expect(metrics.timelineCalls).toEqual([5012, 5049]);
    expect(metricsView.drill?.pr).toBe(5049);
  });

  it("deploy_tab stop/start refuses a request mismatching the observed container state — as a FAILED result", async () => {
    const { deployState, driver } = makeRig();
    deployState.containerStatus = "Exited (0) 2 hours ago";
    const dir = actionDir();
    drop(dir, "d.json", { verb: "deploy_tab", params: { action: "stop" } });
    const [r] = await processTuiActions(dir, driver);
    expect(r!.ok).toBe(false);
    expect(r!.message).toContain("deploy_tab stop refused");
    expect(deployState.run).toBeUndefined();
    expect(deployState.armedKind).toBeUndefined();
  });

  it("deploy_tab deploy with a previous result on screen is a FAILED result, not keystrokes for the companion", async () => {
    const { deployState, driver } = makeRig();
    deployState.run = { kind: "deploy", lines: ["done"], partial: "", running: false };
    const dir = actionDir();
    drop(dir, "d.json", { verb: "deploy_tab", params: { action: "deploy" } });
    const [r] = await processTuiActions(dir, driver);
    expect(r!.ok).toBe(false);
    expect(r!.message).toContain("previous result is still on screen");
    expect(deployState.armedKind).toBeUndefined();
  });

  it("deploy_tab deploy the tab refuses (target not loaded) is a FAILED result naming why", async () => {
    const { deployState, driver } = makeRig();
    const dir = actionDir();
    drop(dir, "d.json", { verb: "deploy_tab", params: { action: "deploy" } });
    const [r] = await processTuiActions(dir, driver);
    expect(r!.ok).toBe(false);
    expect(r!.message).toContain("deploy target is still loading");
    expect(deployState.run).toBeUndefined();
  });

  it("deploy_tab abort with no run in flight is a FAILED result, not a stray x", async () => {
    const { deployState, driver } = makeRig();
    const dir = actionDir();
    drop(dir, "a.json", { verb: "deploy_tab", params: { action: "abort" } });
    const [r] = await processTuiActions(dir, driver);
    expect(r!.ok).toBe(false);
    expect(r!.message).toContain("no run in flight");
    expect(deployState.armedKind).toBeUndefined();
  });

  it("digest_day pages the digest tab to the requested day in BOTH directions (ascending file order)", async () => {
    const rig = makeRig();
    rig.app.tab = "digest";
    rig.app.hooks.tabs.digest!.screen(rig.app, 110, 30);
    await settle(); // files listed ascending, back=0 = newest (2026-08-20)
    rig.driver.digestDay("2026-08-19");
    await settle();
    expect(rig.app.tab).toBe("digest");
    expect(rig.learning.store.digest.back).toBe(1);
    expect(rig.learning.store.digest.content).toContain("2026-08-19"); // the day actually loaded
    rig.driver.digestDay("2026-08-20"); // and back newer again
    await settle();
    expect(rig.learning.store.digest.back).toBe(0);
    expect(rig.learning.store.digest.content).toContain("2026-08-20");
  });

  it("digest_day for an unknown day — or before the listing has happened — is a FAILED result", async () => {
    const rig = makeRig();
    const dir = actionDir();
    drop(dir, "u.json", { verb: "digest_day", params: { date: "2026-07-01" } });
    const [r] = await processTuiActions(dir, rig.driver);
    expect(r!.ok).toBe(false);
    expect(r!.message).toContain("no digest for 2026-07-01");
    expect(rig.learning.store.digest.back).toBe(0);
  });

  it("actions are REFUSED while an operator input box is open — the draft is untouched", async () => {
    const { app, driver } = makeRig();
    app.openMessageBox("pr-5012");
    app.view.inputBox!.text = "half-typed operator draft";
    const dir = actionDir();
    drop(dir, "b.json", { verb: "select_pr", params: { pr: 5049 } });
    const [r] = await processTuiActions(dir, driver);
    expect(r!.ok).toBe(false);
    expect(r!.message).toContain("action refused");
    expect(app.view.inputBox).toBeDefined();
    expect(app.view.inputBox!.text).toBe("half-typed operator draft");
    expect(app.tab).toBe("board");
    expect(app.currentPr()).not.toBe(5049);
  });

  it("runTui's onPoll composition: installing the FeedWriter wrapper must not kill the sidebar-refresh wrapper", () => {
    const { app } = makeRig();
    let refreshes = 0;
    app.sidebar = {
      refresh: () => ((refreshes += 1), Promise.resolve()),
    } as unknown as CompanionSidebar;
    // The exact chain runTui builds, in order: sidebar refresh first, feed next.
    chainOnPoll(app, (a) => void a.sidebar?.refresh());
    const root = mkdtempSync(join(tmpdir(), "qcr-feed-"));
    tmps.push(root);
    const feedDir = join(root, "feed");
    const feed = new FeedWriter(feedDir);
    chainOnPoll(app, (a) => {
      const snap = a.view.snapshot;
      if (!snap) return;
      feed.write(snap, a.rawEvents, a.view.health.kind);
    });
    app.hooks.onPoll!(app);
    expect(refreshes).toBe(1); // the sidebar mirror still refreshes…
    expect(readdirSync(feedDir)).toContain("snapshot.json"); // …and the feed wrote
  });

  it("memory_pin pins through the TUI's ONE store, with the hash a fresh read carries", async () => {
    const rig = makeRig();
    const target = (await rig.mem.read()).find((e) => e.text.includes("stale recheck flag"))!;
    const dir = actionDir();
    drop(dir, "2026-10-07T10-00-00-pin.json", {
      verb: "memory_pin",
      params: { entry: target.id, pin: true },
    });
    const [res] = await processTuiActions(dir, rig.driver);
    expect(res!.ok).toBe(true);
    expect(res!.trace).toMatch(/^companion ▸ memory pin → /);
    const op = rig.mem.applied.at(-1) as MemoryOp & { expect?: string };
    expect(op).toMatchObject({ op: "pin", id: target.id, ts: target.ts, expect: target.hash });
    // No keystroke, no tab change: a memory write is not a synthesized key.
    expect(rig.app.tab).toBe("board");

    // An entry memory does not hold is a FAILED result, and nothing is written.
    const before = rig.mem.applied.length;
    drop(dir, "2026-10-07T10-00-01-pin.json", {
      verb: "memory_pin",
      params: { entry: "reviewer:experiences/no-such.md", pin: true },
    });
    const [missing] = await processTuiActions(dir, rig.driver);
    expect(missing!.ok).toBe(false);
    expect(missing!.message).toMatch(/no memory entry/);
    expect(rig.mem.applied).toHaveLength(before);
  });

  it("memory_pin unpins a pinned entry, and an entry already where it was asked to be is answered, not rewritten", async () => {
    const pinnedMd = `<!-- 2026-10-01 09:00:00 [0a0a0a0a] -->
#pinned #manual never approve a migration without the base check.
`;
    const mem = new FakeMemory(pinnedMd);
    const rig = makeRig(mem);
    const [target] = await mem.read();
    expect(target!.pinned).toBe(true);
    const dir = actionDir();
    drop(dir, "2026-10-07T10-00-00-pin.json", {
      verb: "memory_pin",
      params: { entry: target!.id, pin: true },
    });
    drop(dir, "2026-10-07T10-00-01-unpin.json", {
      verb: "memory_pin",
      params: { entry: target!.id, pin: false },
    });
    const [already, unpinned] = await processTuiActions(dir, rig.driver);
    expect(already!.ok).toBe(true);
    expect(already!.message).toContain("is already pinned");
    expect(unpinned!.ok).toBe(true);
    expect(unpinned!.trace).toMatch(/^companion ▸ memory unpin → /);
    // The ONLY op this channel ever hands the store is pin or unpin (the
    // companion boundary, CLAUDE.md rule 8).
    expect(mem.applied.map((o) => o.op)).toEqual(["unpin"]);
  });

  // MUTATION: drop `if (!res.ok) throw new Error(res.message)` from the
  // driver's `memoryPin` (src/tui/index.ts) — the store's refusal is written
  // to the result file as a SUCCESS, its message as the trace. The result
  // file must carry the store's answer.
  it("memory_pin carries the store's REFUSAL into a failed result — a stale hash is never reported as done", async () => {
    /** A store that refuses every write, as a moved-under-you entry does. */
    class RefusingMemory extends FakeMemory {
      override apply(op: MemoryOp): Promise<{ ok: boolean; message: string }> {
        this.applied.push(op);
        return Promise.resolve({
          ok: false,
          message: "refused: the entry changed since you read it",
        });
      }
    }
    const mem = new RefusingMemory();
    const rig = makeRig(mem);
    let reloads = 0;
    const reload = rig.learning.store.reloadMemory.bind(rig.learning.store);
    rig.learning.store.reloadMemory = () => {
      reloads += 1;
      reload();
    };
    const target = (await mem.read()).find((e) => e.text.includes("stale recheck flag"))!;
    const dir = actionDir();
    drop(dir, "2026-10-07T10-00-00-pin.json", {
      verb: "memory_pin",
      params: { entry: target.id, pin: true },
    });
    const [res] = await processTuiActions(dir, rig.driver);
    expect(res!.ok).toBe(false);
    expect(res!.message).toMatch(/changed since you read it/);
    expect(res!.trace).toBeUndefined();
    // The file the companion reads says the same.
    const written = JSON.parse(
      readFileSync(join(dir, "2026-10-07T10-00-00-pin.result.json"), "utf8"),
    ) as { ok: boolean; message: string };
    expect(written.ok).toBe(false);
    expect(written.message).toMatch(/changed since you read it/);
    // It was attempted once, as a pin, and the tab's view re-read memory after
    // it, so what the operator sees is what the store holds.
    expect(mem.applied.map((o) => o.op)).toEqual(["pin"]);
    expect(reloads).toBe(1);
  });

  it("memory_pin never answers 'no such entry' from a read that did not read everything (honest-unknown)", async () => {
    /** A store whose last read could not see one namespace whole. */
    class PartialMemory extends FakeMemory {
      constructor(private readonly h: MemoryHealth) {
        super();
      }
      health(): MemoryHealth {
        return this.h;
      }
    }
    const cases: Array<{ health: MemoryHealth; ref: string; expect: RegExp }> = [
      // The reviewer tree did not answer at all.
      {
        health: {
          ok: false,
          namespaces: [
            { user: "reviewer", ok: false, reason: "cannot reach OpenViking", unreadable: 0 },
            { user: "companion", ok: true, unreadable: 0 },
          ],
          warning: "reviewer memory unreachable",
        },
        ref: "reviewer:experiences/no-such.md",
        expect: /memory not fully readable .*reviewer: cannot reach OpenViking/,
      },
      // It answered, but listed entries it could not read — by URI this time.
      {
        health: {
          ok: true,
          namespaces: [
            {
              user: "reviewer",
              ok: true,
              reason: "2 of 9 reviewer entries could not be read",
              unreadable: 2,
            },
            { user: "companion", ok: true, unreadable: 0 },
          ],
        },
        ref: "viking://user/reviewer/memories/experiences/no-such.md",
        expect: /memory not fully readable .*2 of 9 reviewer entries could not be read/,
      },
      // Only the OTHER tree is degraded: "no such entry" is still a fact.
      {
        health: {
          ok: false,
          namespaces: [
            { user: "reviewer", ok: true, unreadable: 0 },
            { user: "companion", ok: false, reason: "no key", unreadable: 0 },
          ],
        },
        ref: "reviewer:experiences/no-such.md",
        expect: /no memory entry/,
      },
    ];
    for (const [i, c] of cases.entries()) {
      const mem = new PartialMemory(c.health);
      const rig = makeRig(mem);
      const dir = actionDir();
      drop(dir, `2026-10-07T10-00-0${i}-pin.json`, {
        verb: "memory_pin",
        params: { entry: c.ref, pin: true },
      });
      const [res] = await processTuiActions(dir, rig.driver);
      expect(res!.ok, c.ref).toBe(false);
      expect(res!.message, c.ref).toMatch(c.expect);
      expect(mem.applied).toHaveLength(0);
    }
  });
});
