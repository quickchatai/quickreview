// wiring: the companion action channel driving a REAL App — the
// buildTuiDriver mapping (docs/tui-actions-wiring.md, applied) plus the
// filter consumption invariant: render and verb handlers share ONE filtered
// ordering, so selection movement and x/p/e can never address a hidden row.
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TUI_DEFAULTS } from "../src/config.js";
import type { StatusSnapshot } from "../src/state.js";
import { processTuiActions } from "../src/tui/actions.js";
import { App } from "../src/tui/app.js";
import { renderBoard } from "../src/tui/board.js";
import type { DeployFetcher } from "../src/tui/deploytab.js";
import { installDeployHooks } from "../src/tui/deploytab.js";
import type { DigestFetcher } from "../src/tui/digesttab.js";
import { applyMemoryFilter } from "../src/tui/filters.js";
import { FeedWriter } from "../src/tui/feed.js";
import { buildTuiDriver, chainOnPoll } from "../src/tui/index.js";
import type { CompanionSidebar } from "../src/tui/sidebar.js";
import { decodeKey } from "../src/tui/keys.js";
import { installMemoryLearningHooks, type MemTabState } from "../src/tui/memtab.js";
import { timelineOrder } from "../src/tui/memory.js";
import { legacyBlockHash as blockHash, parseLegacyMemory as parseMemory } from "../src/memory/legacy-file.js";
import type { MemoryEntry, MemoryOp, MemoryStore } from "../src/memory/store.js";
import { installMetricsHooks, type MetricsFetcher } from "../src/tui/metricstab.js";
import { Frame, stripAnsi } from "../src/tui/paint.js";

/**: tab hooks hand back a Frame so the app can compose the companion
 * column beside it. These tests read the tab alone, so they render it. */
const renderScreen = (screen: string | Frame | undefined): string =>
  screen === undefined ? "" : typeof screen === "string" ? screen : screen.render();
import type { RemoteResult } from "../src/tui/remote.js";

// ---- harness (the memtab.test.ts pattern) ----------------------------------

function fakeStreams() {
  const out = new EventEmitter() as unknown as NodeJS.WriteStream;
  let buf = "";
  (out as unknown as { columns: number }).columns = 110;
  (out as unknown as { rows: number }).rows = 30;
  out.write = ((s: string) => ((buf += s), true)) as never;
  const input = new EventEmitter() as unknown as NodeJS.ReadStream;
  (input as unknown as { isTTY: boolean }).isTTY = false;
  input.resume = (() => input) as never;
  input.pause = (() => input) as never;
  return { out, input, written: () => buf };
}

const SAMPLE = `<!-- 2026-08-19 18:13:54 [01a01ab3] -->
#false-positive #eod-learning lesson about merge bases.

#refuted lesson about External Apps.

<!-- 2026-08-20 09:01:42 [01a01b03] -->
#bug #operations [[stale-recheck]] stale recheck flag lingers on #5180.
`;

class FakeMemory implements MemoryStore {
  applied: MemoryOp[] = [];
  read(): Promise<MemoryEntry[]> {
    return Promise.resolve(parseMemory(SAMPLE));
  }
  search(query: string): Promise<MemoryEntry[]> {
    const q = query.toLowerCase();
    return Promise.resolve(parseMemory(SAMPLE).filter((e) => e.text.toLowerCase().includes(q)));
  }
  apply(op: MemoryOp): Promise<{ ok: boolean; message: string }> {
    this.applied.push(op);
    return Promise.resolve({ ok: true, message: `ok: ${op.op}` });
  }
}

const fakeDigest: DigestFetcher = {
  // ASCENDING, like production: parseDigestList sorts lexicographically and
  // DigestState.back counts back from the NEWEST (= last) file.
  list: () => Promise.resolve(["2026-08-19.md", "2026-08-20.md"]),
  read: (f) => Promise.resolve(`# digest ${f}`),
};

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

const okSsh = (_h: string, _argv: string[]): Promise<RemoteResult> => Promise.resolve({ ok: true, stdout: "", stderr: "", code: 0 });

const snapshot: StatusSnapshot = {
  written_at: "2026-08-20T12:00:00Z",
  dry_run: true,
  prs: [
    { number: 5012, state: "reviewing", title: "fix(crm): retry", head_sha: "aa11", stale_recheck: 0, author: "alice" },
    { number: 5049, state: "awaiting_author", title: "feat(remote-api): dispatch", head_sha: "bb22", stale_recheck: 0, author: "bob" },
    { number: 5100, state: "tracked", title: "chore: bump deps", head_sha: "cc33", stale_recheck: 0, author: "alice" },
  ],
  running_rounds: 0,
  total_spend_usd: 0,
  heartbeat: "2026-08-20T12:00:00Z",
};

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 5));
}

interface Rig {
  app: App;
  mem: FakeMemory;
  memState: MemTabState;
  metricsView: ReturnType<typeof installMetricsHooks>;
  deployState: ReturnType<typeof installDeployHooks>;
  metrics: FakeMetrics;
  driver: ReturnType<typeof buildTuiDriver>;
  written: () => string;
}

function makeRig(): Rig {
  const { out, input, written } = fakeStreams();
  const app = new App(TUI_DEFAULTS, okSsh, out, input);
  app.view.snapshot = snapshot;
  const mem = new FakeMemory();
  const memState = installMemoryLearningHooks(app, {
    memory: mem,
    digestFetcher: fakeDigest,
    fetchProposals: () => Promise.resolve({ proposals: [], improvements: [] }),
  });
  const metrics = new FakeMetrics();
  const metricsView = installMetricsHooks(app, metrics);
  const deployState = installDeployHooks(app, fakeDeploy);
  const driver = buildTuiDriver(app, memState, metricsView, deployState);
  return { app, mem, memState, metricsView, deployState, metrics, driver, written };
}

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
  it("switch_tab memory lands on the digest tab id, archives + writes a result", async () => {
    const { app, driver } = makeRig();
    const dir = actionDir();
    drop(dir, "2026-08-20T12-00-00-tab.json", { verb: "switch_tab", params: { tab: "memory" } });
    const done = await processTuiActions(dir, driver);
    expect(done).toHaveLength(1);
    expect(done[0]!.ok).toBe(true);
    expect(app.tab).toBe("digest");
    expect(readdirSync(join(dir, ".done"))).toContain("2026-08-20T12-00-00-tab.json");
    expect(readdirSync(dir)).toContain("2026-08-20T12-00-00-tab.result.json");
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

  it("memory_filter narrows the timeline render and labels it", async () => {
    const { app, memState, driver } = makeRig();
    app.tab = "digest";
    app.hooks.digestScreen!(app, 110, 30);
    await settle(); // memory loaded
    const dir = actionDir();
    drop(dir, "m.json", { verb: "memory_filter", params: { tag: "#false-positive" } });
    await processTuiActions(dir, driver);
    expect(memState.memFilter).toBe("false-positive");
    expect(memState.view).toBe("memory");
    const screen = stripAnsi(renderScreen(app.hooks.digestScreen!(app, 110, 30)));
    expect(screen).toContain("MEMORY (1)");
    expect(screen).toContain("⛉ #false-positive — F clears");
    expect(screen).not.toContain("stale recheck flag");
  });

  it("verbs address the filtered ordering: p pins the visible entry, not the unfiltered ordinal", async () => {
    const { app, mem, memState, driver } = makeRig();
    app.tab = "digest";
    app.hooks.digestScreen!(app, 110, 30);
    await settle();
    driver.setMemoryFilter("false-positive"); // unfiltered ordinal 0 is the #bug entry
    const want = applyMemoryFilter(timelineOrder(parseMemory(SAMPLE)), "false-positive")[0]!;
    app.hooks.digestKey!(app, decodeKey(Buffer.from("p")));
    await settle();
    expect(mem.applied).toHaveLength(1);
    const op = mem.applied[0]! as Extract<MemoryOp, { op: "pin" }>;
    expect(op.op).toBe("pin");
    expect(op.expect).toBe(blockHash(want.text));
    expect(memState.sel).toBe(0);
  });

  it("x x retires the filtered selection too", async () => {
    const { app, mem, driver } = makeRig();
    app.tab = "digest";
    app.hooks.digestScreen!(app, 110, 30);
    await settle();
    driver.setMemoryFilter("refuted");
    const want = applyMemoryFilter(timelineOrder(parseMemory(SAMPLE)), "refuted")[0]!;
    app.hooks.digestKey!(app, decodeKey(Buffer.from("x")));
    app.hooks.digestKey!(app, decodeKey(Buffer.from("x")));
    await settle();
    const op = mem.applied[0]! as Extract<MemoryOp, { op: "retire" }>;
    expect(op.op).toBe("retire");
    expect(op.expect).toBe(blockHash(want.text));
  });

  it("F on the memory tab clears the memory filter", async () => {
    const { app, memState, driver } = makeRig();
    app.tab = "digest";
    app.hooks.digestScreen!(app, 110, 30);
    await settle();
    driver.setMemoryFilter("bug");
    expect(app.hooks.digestKey!(app, decodeKey(Buffer.from("F")))).toBe(true);
    expect(memState.memFilter).toBeNull();
    const screen = stripAnsi(renderScreen(app.hooks.digestScreen!(app, 110, 30)));
    expect(screen).toContain("MEMORY (3)");
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
    driver.metricsPr(5012); // presses # 5 0 1 2 ⏎ (digits 1/2 decode as tab keys — keyChar folds them back)
    await settle();
    expect(app.tab).toBe("metrics");
    expect(metrics.timelineCalls).toEqual([5012]);
    expect(metricsView.drill?.pr).toBe(5012);
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

  it("deploy_tab abort with no run in flight is a FAILED result, not a stray x", async () => {
    const { deployState, driver } = makeRig();
    const dir = actionDir();
    drop(dir, "a.json", { verb: "deploy_tab", params: { action: "abort" } });
    const [r] = await processTuiActions(dir, driver);
    expect(r!.ok).toBe(false);
    expect(r!.message).toContain("no run in flight");
    expect(deployState.armedKind).toBeUndefined();
  });

  it("digest_day pages to the requested day in BOTH directions (ascending file order)", async () => {
    const { app, memState, driver } = makeRig();
    app.tab = "digest";
    app.hooks.digestScreen!(app, 110, 30);
    await settle(); // files listed ascending, back=0 = newest (2026-08-20)
    driver.digestDay("2026-08-19");
    await settle();
    expect(memState.digest.back).toBe(1);
    expect(memState.view).toBe("digest");
    expect(memState.digest.content).toContain("2026-08-19"); // the day actually loaded
    driver.digestDay("2026-08-20"); // and back newer again
    await settle();
    expect(memState.digest.back).toBe(0);
    expect(memState.digest.content).toContain("2026-08-20");
  });

  it("digest_day for an unknown day is a FAILED result", async () => {
    const { memState, driver } = makeRig();
    memState.digest.files = ["2026-08-19.md", "2026-08-20.md"];
    memState.digest.loaded = true;
    const dir = actionDir();
    drop(dir, "u.json", { verb: "digest_day", params: { date: "2026-07-01" } });
    const [r] = await processTuiActions(dir, driver);
    expect(r!.ok).toBe(false);
    expect(r!.message).toContain("no digest for 2026-07-01");
    expect(memState.digest.back).toBe(0);
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
    app.sidebar = { refresh: () => ((refreshes += 1), Promise.resolve()) } as unknown as CompanionSidebar;
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
});
