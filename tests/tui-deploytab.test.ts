// Deploy tab — argv construction, BUILD_SHA parsing, the pure line renderer,
// and key routing. All runners are fakes; nothing spawns, nothing sshes.
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { TUI_DEFAULTS } from "../src/config.js";
import { App } from "../src/tui/app.js";
import {
  DIRTY_ARGV,
  HEAD_ARGV,
  PLAN_ARGV,
  RealDeployFetcher,
  buildShaArgv,
  deployLines,
  diffStatArgv,
  installDeployHooks,
  logArgv,
  parseBuildSha,
  type DeployDrainSender,
  type DeployState,
  type LocalRunner,
} from "../src/tui/deploytab.js";
import { stripAnsi } from "../src/tui/paint.js";
import { MemoryDeployCeremonyStore } from "../src/tui/deploy-ceremony.js";
import type { RemoteResult } from "../src/tui/remote.js";

const ok = (stdout: string): RemoteResult => ({ ok: true, stdout, stderr: "", code: 0 });
const fail = (stderr = ""): RemoteResult => ({ ok: false, stdout: "", stderr, code: 1 });

function fakeStreams() {
  const out = new EventEmitter() as any;
  let buf = "";
  out.columns = 100;
  out.rows = 24;
  out.write = (s: string) => ((buf += s), true);
  const input = new EventEmitter() as any;
  input.isTTY = false;
  input.resume = () => {};
  input.pause = () => {};
  input.setRawMode = () => {};
  return { out, input, written: () => buf, type: (s: string | Buffer) => input.emit("data", Buffer.from(s)) };
}

const emptyState = (over: Partial<DeployState> = {}): DeployState => ({
  loaded: true,
  loading: false,
  dirty: [],
  plan: [],
  scroll: 0,
  ...over,
});

describe("deploy tab argv + parsing", () => {
  it("reads BUILD_SHA through docker exec like the digest tab", () => {
    const argv = buildShaArgv(TUI_DEFAULTS);
    expect(argv.slice(0, 4)).toEqual(["sudo", "docker", "exec", "quickreview-sandbox"]);
    expect(argv[argv.length - 1]).toContain("cat '/opt/quickreview/sandbox/BUILD_SHA'");
  });

  it("builds read-only local git argvs against the deployed sha", () => {
    expect(logArgv("abc1234")).toEqual(["git", "log", "--oneline", "abc1234..HEAD"]);
    expect(diffStatArgv("abc1234")).toEqual(["git", "diff", "--stat", "abc1234..HEAD"]);
    expect(HEAD_ARGV).toContain("rev-parse");
    expect(DIRTY_ARGV).toContain("--porcelain");
    expect(PLAN_ARGV).toEqual(["bash", "scripts/deploy.sh", "--dry-run", "sync"]);
  });

  it("parses BUILD_SHA lines and rejects garbage", () => {
    expect(parseBuildSha("540a9d0 2026-08-14T13:10:00Z sync\n")).toEqual({ sha: "540a9d0", at: "2026-08-14T13:10:00Z", mode: "sync" });
    expect(parseBuildSha("540a9d0\n")).toEqual({ sha: "540a9d0", at: undefined, mode: undefined });
    expect(parseBuildSha("")).toBeUndefined();
    expect(parseBuildSha("not-a-sha here\n")).toBeUndefined();
  });
});

describe("RealDeployFetcher", () => {
  function fetcherWith(marker: RemoteResult, local: Record<string, RemoteResult>) {
    const localCalls: string[][] = [];
    const localRunner: LocalRunner = async (argv) => {
      localCalls.push(argv);
      return local[argv.join(" ")] ?? fail();
    };
    const f = new RealDeployFetcher(TUI_DEFAULTS, async () => marker, localRunner);
    return { f, localCalls };
  }

  it("diffs local HEAD against the deployed sha when the marker exists", async () => {
    const { f } = fetcherWith(ok("aaa1111 2026-08-14T12:00:00Z sync\n"), {
      [HEAD_ARGV.join(" ")]: ok("bbb2222\n"),
      [DIRTY_ARGV.join(" ")]: ok(""),
      [PLAN_ARGV.join(" ")]: ok("plan — deploy.sh sync\n"),
      [logArgv("aaa1111").join(" ")]: ok("bbb2222 fix the thing\n"),
      [diffStatArgv("aaa1111").join(" ")]: ok(" src/x.ts | 2 +-\n"),
    });
    const st = await f.load();
    expect(st.deployed?.sha).toBe("aaa1111");
    expect(st.head).toBe("bbb2222");
    expect(st.commits).toEqual(["bbb2222 fix the thing"]);
    expect(st.diffstat).toEqual([" src/x.ts | 2 +-"]);
  });

  it("degrades to marker-unknown without local git calls against it", async () => {
    const { f, localCalls } = fetcherWith(ok(""), {
      [HEAD_ARGV.join(" ")]: ok("bbb2222\n"),
      [DIRTY_ARGV.join(" ")]: ok(" M src/x.ts\n"),
      [PLAN_ARGV.join(" ")]: fail("deploy.sh: refusing to deploy — the working tree is dirty:\n"),
    });
    const st = await f.load();
    expect(st.deployed).toBeUndefined();
    expect(st.commits).toBeUndefined();
    expect(st.dirty).toEqual([" M src/x.ts"]);
    // the refusal is shown verbatim as the plan
    expect(st.plan.join("\n")).toContain("refusing to deploy");
    expect(localCalls.some((c) => c.includes("log"))).toBe(false);
  });
});

describe("deployLines", () => {
  it("says nothing-to-deploy when the VM already runs HEAD and the tree is clean", () => {
    const text = stripAnsi(deployLines(emptyState({ deployed: { sha: "aaa1111" }, head: "aaa1111", commits: [], diffstat: [] }), 90).join("\n"));
    expect(text).toContain("nothing to deploy");
    expect(text).toContain("./scripts/deploy.sh sync");
    expect(text).toContain("press D twice");
  });

  it("shows the armed banner after the first D", () => {
    const text = stripAnsi(deployLines(emptyState({ armedAt: 123 }), 90).join("\n"));
    expect(text).toContain("ARMED");
    expect(text).toContain("press D again");
  });

  it("lists pending commits, dirty files and the plan", () => {
    const st = emptyState({
      deployed: { sha: "aaa1111", at: "2026-08-14T12:00:00Z", mode: "sync" },
      head: "ccc3333",
      dirty: ["?? notes.txt"],
      commits: ["ccc3333 tui deploy tab", "bbb2222 fix dispatch"],
      diffstat: [" 2 files changed"],
      plan: ["plan — deploy.sh sync"],
    });
    const text = stripAnsi(deployLines(st, 90).join("\n"));
    expect(text).toContain("PENDING (2)");
    expect(text).toContain("ccc3333 tui deploy tab");
    expect(text).toContain("dirty — 1 uncommitted (deploy.sh will refuse)");
    expect(text).toContain("plan — deploy.sh sync");
  });

  it("flags a deployed sha unknown to local git instead of pretending 0 pending", () => {
    const text = stripAnsi(deployLines(emptyState({ deployed: { sha: "deadbee" }, head: "ccc3333" }), 90).join("\n"));
    expect(text).toContain("unknown to local git");
    expect(text).not.toContain("PENDING");
  });
});

let statusSeq = 0;
function freshStatus(runningRounds: number, draining = true): any {
  const now = new Date(Date.UTC(2026, 7, 28, 12, 0, statusSeq++)).toISOString();
  return {
    written_at: now,
    heartbeat: now,
    dry_run: false,
    prs: [],
    running_rounds: runningRounds,
    max_concurrent_rounds: 12,
    total_spend_usd: 0,
    today_spend_usd: 0,
    ...(draining ? { draining: true, drained_deliveries: 0, drain_failed_loud: 0 } : {}),
  };
}

function publishStatus(app: App, runningRounds: number, draining = true): void {
  app.view.snapshot = freshStatus(runningRounds, draining);
  app.view.health = { kind: "ok", heartbeatAgeS: 0 };
  app.hooks.onPoll?.(app);
}

const settle = async (): Promise<void> => { await new Promise((r) => setTimeout(r, 0)); };

function quietDrain(rounds = 0): DeployDrainSender {
  return {
    set: async (on) => on
      ? { ok: true, draining: true, running_rounds: rounds }
      : { ok: true, draining: false, dropped_deliveries: 0 },
  };
}

describe("deploy tab drain orchestration", () => {
  it("engages drain, visibly waits through running rounds, then deploys exactly once at zero", async () => {
    const streams = fakeStreams();
    const app = new App(TUI_DEFAULTS, async () => ok(""), streams.out, streams.input);
    const drainCalls: boolean[] = [];
    const drain: DeployDrainSender = {
      set: async (on) => {
        drainCalls.push(on);
        return { ok: true, draining: on, running_rounds: on ? 2 : undefined, dropped_deliveries: on ? undefined : 0 };
      },
    };
    let deploys = 0;
    app.hooks.deployRun = (_a, _data, exit) => { deploys++; exit(0); return { kill: () => {} }; };
    const st = installDeployHooks(app, { load: async () => ({ dirty: [], plan: [], head: "abc1234" }) }, () => 1000, drain);
    const run = app.run();
    streams.type("3");
    await settle();
    streams.type("D");
    streams.type("D");
    await settle();

    expect(drainCalls).toEqual([true]);
    expect(deploys).toBe(0);
    expect(st.deployPhase).toBe("waiting-rounds");
    expect(stripAnsi(streams.written())).toContain("DRAINING — 2 rounds finishing");

    publishStatus(app, 1);
    expect(deploys).toBe(0);
    expect(stripAnsi(streams.written())).toContain("DRAINING — 1 round finishing");
    publishStatus(app, 0);
    await settle();
    expect(deploys).toBe(1);
    publishStatus(app, 0);
    await settle();
    expect(deploys).toBe(1);
    expect(stripAnsi(streams.written())).toContain("healthy boot will auto-lift the drain");
    streams.type("D"); streams.type("D");
    expect(deploys).toBe(1);
    expect(app.view.noticeLine).toContain("close the previous deploy result");
    streams.type("x");
    expect(st.run).toBeDefined();
    expect(app.view.noticeLine).toContain("has not auto-lifted yet");
    publishStatus(app, 0, false);
    expect(st.deployPhase).toBe("done");
    expect(app.view.noticeLine).toContain("drain lifted");
    expect(drainCalls).toEqual([true]); // the healthy daemon boot owns the lift
    app.quit();
    await run;
  });

  it("restores an owned drain after hot reload and continues only when the board reaches zero", async () => {
    const store = new MemoryDeployCeremonyStore();
    const firstStreams = fakeStreams();
    const first = new App(TUI_DEFAULTS, async () => ok(""), firstStreams.out, firstStreams.input);
    const drain = quietDrain(2);
    installDeployHooks(first, { load: async () => ({ dirty: [], plan: [], head: "abc1234" }) }, () => 1000, drain, store);
    const firstRun = first.run();
    firstStreams.type("3"); await settle();
    firstStreams.type("D"); firstStreams.type("D"); await settle();
    expect(store.read()?.phase).toBe("waiting-rounds");
    first.quit(); await firstRun;

    const secondStreams = fakeStreams();
    const second = new App(TUI_DEFAULTS, async () => ok(""), secondStreams.out, secondStreams.input);
    let deploys = 0;
    second.hooks.deployRun = (_a, _d, exit) => { deploys++; exit(0); return { kill: () => {} }; };
    const restored = installDeployHooks(second, { load: async () => ({ dirty: [], plan: [], head: "abc1234" }) }, () => 2000, drain, store);
    const secondRun = second.run();
    secondStreams.type("3"); await settle();
    expect(restored.deployPhase).toBe("waiting-rounds");
    publishStatus(second, 1);
    expect(deploys).toBe(0);
    publishStatus(second, 0);
    await settle();
    expect(deploys).toBe(1);
    second.quit(); await secondRun;
  });

  it("will not resume a zero-round drain until the restored target HEAD is loaded", async () => {
    const store = new MemoryDeployCeremonyStore();
    store.write({ version: 1, phase: "waiting-rounds", target_head: "abc1234", updated_at: "2026-08-28T12:00:01Z" });
    const finishLoads: Array<(value: any) => void> = [];
    const fetcher = { load: () => new Promise<any>((resolve) => { finishLoads.push(resolve); }) };
    const streams = fakeStreams();
    const app = new App(TUI_DEFAULTS, async () => ok(""), streams.out, streams.input);
    let deploys = 0;
    app.hooks.deployRun = (_a, _d, exit) => { deploys++; exit(0); return { kill: () => {} }; };
    const st = installDeployHooks(app, fetcher, () => 2000, quietDrain(), store);
    const run = app.run();
    publishStatus(app, 0);
    await settle();
    expect(deploys).toBe(0);
    expect(st.deployPhase).toBe("waiting-rounds");
    expect(finishLoads).toHaveLength(2); // eager restore + zero-round preflight refresh
    for (const finish of finishLoads) finish({ dirty: [], plan: [], head: "abc1234" });
    await settle();
    expect(deploys).toBe(1);
    app.quit(); await run;
  });

  it("persists an abort requested during drain acknowledgement across hot reload", async () => {
    const store = new MemoryDeployCeremonyStore();
    const firstStreams = fakeStreams();
    const first = new App(TUI_DEFAULTS, async () => ok(""), firstStreams.out, firstStreams.input);
    const never = new Promise<any>(() => {});
    const pendingDrain: DeployDrainSender = { set: async () => never };
    installDeployHooks(first, { load: async () => ({ dirty: [], plan: [], head: "abc1234" }) }, () => 1000, pendingDrain, store);
    const firstRun = first.run();
    firstStreams.type("3"); await settle();
    firstStreams.type("D"); firstStreams.type("D");
    firstStreams.type("x");
    expect(store.read()?.phase).toBe("abort-requested");
    first.quit(); await firstRun;

    const calls: boolean[] = [];
    const resumedDrain: DeployDrainSender = {
      set: async (on) => {
        calls.push(on);
        return on
          ? { ok: true, draining: true, running_rounds: 2 }
          : { ok: true, draining: false, dropped_deliveries: 1 };
      },
    };
    const secondStreams = fakeStreams();
    const second = new App(TUI_DEFAULTS, async () => ok(""), secondStreams.out, secondStreams.input);
    let deploys = 0;
    second.hooks.deployRun = () => { deploys++; return { kill: () => {} }; };
    const restored = installDeployHooks(second, { load: async () => ({ dirty: [], plan: [], head: "abc1234" }) }, () => 2000, resumedDrain, store);
    const secondRun = second.run();
    await settle(); await settle();
    expect(calls).toEqual([true, false]);
    expect(restored.deployPhase).toBe("aborted");
    expect(deploys).toBe(0);
    expect(store.read()).toBeUndefined();
    second.quit(); await secondRun;
  });

  it("turns an interrupted sync into a durable ambiguous failure instead of repeating it", async () => {
    const store = new MemoryDeployCeremonyStore();
    store.write({ version: 1, phase: "syncing", target_head: "abc1234", pre_deploy_snapshot_at: "2026-08-28T12:00:00Z", updated_at: "2026-08-28T12:00:01Z" });
    const streams = fakeStreams();
    const app = new App(TUI_DEFAULTS, async () => ok(""), streams.out, streams.input);
    let deploys = 0;
    app.hooks.deployRun = () => { deploys++; return { kill: () => {} }; };
    const st = installDeployHooks(app, { load: async () => ({ dirty: [], plan: [], head: "abc1234" }) }, () => 2000, quietDrain(), store);
    const run = app.run();
    streams.type("3"); await settle();
    expect(st.deployPhase).toBe("deploy-failed");
    expect(deploys).toBe(0);
    streams.type("D"); streams.type("D");
    expect(deploys).toBe(0);
    expect(app.view.noticeLine).toContain("close the previous deploy result");
    app.quit(); await run;
  });

  it("never starts deploy when the daemon refuses the drain", async () => {
    const streams = fakeStreams();
    const app = new App(TUI_DEFAULTS, async () => ok(""), streams.out, streams.input);
    let deploys = 0;
    app.hooks.deployRun = () => { deploys++; return { kill: () => {} }; };
    const drain: DeployDrainSender = { set: async () => ({ ok: false, reason: "tier refused" }) };
    const st = installDeployHooks(app, { load: async () => ({ dirty: [], plan: [], head: "abc1234" }) }, () => 1000, drain);
    const run = app.run();
    streams.type("3");
    await settle();
    streams.type("D"); streams.type("D");
    await settle();
    expect(deploys).toBe(0);
    expect(st.deployPhase).toBe("drain-failed");
    expect(stripAnsi(streams.written())).toContain("tier refused");
    app.quit();
    await run;
  });

  it("x while rounds are draining lifts the drain and does not deploy", async () => {
    const streams = fakeStreams();
    const app = new App(TUI_DEFAULTS, async () => ok(""), streams.out, streams.input);
    const calls: boolean[] = [];
    const drain: DeployDrainSender = {
      set: async (on) => {
        calls.push(on);
        return on
          ? { ok: true, draining: true, running_rounds: 2 }
          : { ok: true, draining: false, dropped_deliveries: 3 };
      },
    };
    let deploys = 0;
    app.hooks.deployRun = () => { deploys++; return { kill: () => {} }; };
    const st = installDeployHooks(app, { load: async () => ({ dirty: [], plan: [], head: "abc1234" }) }, () => 1000, drain);
    const run = app.run();
    streams.type("3");
    await settle();
    streams.type("D"); streams.type("D");
    await settle();
    publishStatus(app, 2);
    streams.type("x");
    await settle();
    expect(calls).toEqual([true, false]);
    expect(deploys).toBe(0);
    expect(st.deployPhase).toBe("aborted");
    expect(app.view.noticeLine).toContain("review work resumed");
    app.quit();
    await run;
  });

  it("treats an explicit external drain-off as an operator cancellation", async () => {
    const store = new MemoryDeployCeremonyStore();
    const streams = fakeStreams();
    const app = new App(TUI_DEFAULTS, async () => ok(""), streams.out, streams.input);
    let deploys = 0;
    app.hooks.deployRun = () => { deploys++; return { kill: () => {} }; };
    const st = installDeployHooks(app, { load: async () => ({ dirty: [], plan: [], head: "abc1234" }) }, () => 1000, quietDrain(2), store);
    const run = app.run();
    streams.type("3"); await settle();
    streams.type("D"); streams.type("D"); await settle();
    publishStatus(app, 2, true);
    expect(store.read()?.drain_observed).toBe(true);
    publishStatus(app, 0, false);
    expect(st.deployPhase).toBe("aborted");
    expect(deploys).toBe(0);
    expect(store.read()).toBeUndefined();
    expect(app.view.noticeLine).toContain("operator lifted the drain");
    app.quit(); await run;
  });

  it("recognizes an external drain-off even before the first ON snapshot arrives", async () => {
    const store = new MemoryDeployCeremonyStore();
    const streams = fakeStreams();
    const app = new App(TUI_DEFAULTS, async () => ok(""), streams.out, streams.input);
    let deploys = 0;
    app.hooks.deployRun = () => { deploys++; return { kill: () => {} }; };
    const st = installDeployHooks(app, { load: async () => ({ dirty: [], plan: [], head: "abc1234" }) }, () => 1000, quietDrain(2), store);
    const run = app.run();
    streams.type("3"); await settle();
    streams.type("D"); streams.type("D"); await settle();
    publishStatus(app, 0, false); // may still be the pre-command status generation
    expect(st.deployPhase).toBe("waiting-rounds");
    publishStatus(app, 0, false); // a newer undrained generation proves override
    expect(st.deployPhase).toBe("aborted");
    expect(deploys).toBe(0);
    expect(store.read()).toBeUndefined();
    app.quit(); await run;
  });

  it("a failed sync leaves the drain standing rather than resuming blind", async () => {
    const streams = fakeStreams();
    const app = new App(TUI_DEFAULTS, async () => ok(""), streams.out, streams.input);
    const calls: boolean[] = [];
    const drain: DeployDrainSender = {
      set: async (on) => {
        calls.push(on);
        return { ok: true, draining: on, running_rounds: on ? 0 : undefined, dropped_deliveries: on ? undefined : 0 };
      },
    };
    app.hooks.deployRun = (_a, _data, exit) => { exit(1); return { kill: () => {} }; };
    const st = installDeployHooks(app, { load: async () => ({ dirty: [], plan: [], head: "abc1234" }) }, () => 1000, drain);
    const run = app.run();
    streams.type("3");
    await settle();
    streams.type("D"); streams.type("D");
    await settle();
    publishStatus(app, 0);
    await settle();
    expect(st.deployPhase).toBe("deploy-failed");
    expect(calls).toEqual([true]);
    expect(stripAnsi(streams.written())).toContain("drain remains ON");
    app.quit();
    await run;
  });
});

describe("deploy tab keys", () => {
  it("opens on 3, scrolls with j/k, refreshes on r, and 1 returns to the board", async () => {
    const streams = fakeStreams();
    const app = new App(TUI_DEFAULTS, async () => ok(""), streams.out, streams.input);
    let loads = 0;
    const st = installDeployHooks(app, {
      load: async () => (loads++, { dirty: [], plan: ["plan — deploy.sh sync"], deployed: undefined, head: "abc1234" }),
    });
    const run = app.run();
    streams.type("3");
    expect(app.tab).toBe("deploy");
    await new Promise((r) => setTimeout(r, 0)); // lazy load settles
    expect(loads).toBe(1);
    expect(stripAnsi(streams.written())).toContain("no BUILD_SHA on the VM yet");
    streams.type("j");
    expect(st.scroll).toBe(1);
    streams.type("k");
    expect(st.scroll).toBe(0);
    streams.type("r");
    await new Promise((r) => setTimeout(r, 0));
    expect(loads).toBe(2);
    streams.type("1");
    expect(app.tab).toBe("board");
    app.quit();
    await run;
  });

  it("D D runs the deploy hook; D then any other key disarms", async () => {
    const streams = fakeStreams();
    const app = new App(TUI_DEFAULTS, async () => ok(""), streams.out, streams.input);
    let deploys = 0;
    app.hooks.deployRun = (_a, _onData, onExit) => {
      deploys++;
      onExit(0);
      return { kill: () => {} };
    };
    let clock = 1000;
    const st = installDeployHooks(app, { load: async () => ({ dirty: [], plan: [], head: "abc1234" }) }, () => clock, quietDrain());
    const run = app.run();
    streams.type("3");
    await new Promise((r) => setTimeout(r, 0));

    streams.type("D");
    expect(st.armedAt).toBe(1000);
    streams.type("j"); // disarms
    expect(st.armedAt).toBeUndefined();
    expect(deploys).toBe(0);

    streams.type("D");
    clock += 2000; // inside the confirm window
    streams.type("D");
    await settle();
    publishStatus(app, 0);
    await settle();
    expect(deploys).toBe(1);
    expect(st.armedAt).toBeUndefined();

    streams.type("D");
    clock += 10_000;
    streams.type("D");
    expect(deploys).toBe(1);
    expect(st.armedAt).toBeUndefined();
    expect(app.view.noticeLine).toContain("close the previous deploy result");
    app.quit();
    await run;
  });

  it("clicking THE button arms then deploys; a click elsewhere disarms", async () => {
    const streams = fakeStreams();
    const app = new App(TUI_DEFAULTS, async () => ok(""), streams.out, streams.input);
    let deploys = 0;
    app.hooks.deployRun = (_a, _onData, onExit) => {
      deploys++;
      onExit(0);
      return { kill: () => {} };
    };
    let clock = 1000;
    const st = installDeployHooks(app, { load: async () => ({ dirty: [], plan: [], head: "abc1234" }) }, () => clock, quietDrain());
    const run = app.run();
    streams.type("3");
    await new Promise((r) => setTimeout(r, 0)); // render → buttonZone measured
    expect(st.buttonZone).toBeDefined();
    const { x1, y1 } = st.buttonZone!;
    const click = (x: number, y: number) => streams.type(`\x1b[<0;${x};${y}M`);

    click(x1, y1); // arms
    expect(st.armedAt).toBe(1000);
    click(70, 15); // click away cancels
    expect(st.armedAt).toBeUndefined();
    expect(deploys).toBe(0);

    click(x1, y1);
    clock += 1000;
    click(st.buttonZone!.x2, st.buttonZone!.y2); // second click starts the drain ceremony
    await settle();
    publishStatus(app, 0);
    await settle();
    expect(deploys).toBe(1);
    expect(st.armedAt).toBeUndefined();
    app.quit();
    await run;
  });

  it("streams deploy.sh output into the pane and x closes the finished log", async () => {
    const streams = fakeStreams();
    const app = new App(TUI_DEFAULTS, async () => ok(""), streams.out, streams.input);
    let exitFn: ((code: number | null) => void) | undefined;
    let dataFn: ((chunk: string) => void) | undefined;
    app.hooks.deployRun = (_a, onData, onExit) => {
      dataFn = onData;
      exitFn = onExit;
      return { kill: () => {} };
    };
    let clock = 1000;
    const st = installDeployHooks(app, { load: async () => ({ dirty: [], plan: [], head: "abc1234" }) }, () => clock, quietDrain());
    const run = app.run();
    streams.type("3");
    await new Promise((r) => setTimeout(r, 0));

    streams.type("D");
    streams.type("D");
    await settle();
    publishStatus(app, 0);
    await settle();
    expect(st.run?.running).toBe(true);
    dataFn!("plan — deploy.sh sync\nrsync st"); // chunk split mid-line
    dataFn!("arted\x1b[32m ok\x1b[0m\n");
    expect(st.run?.lines.slice(-2)).toEqual(["plan — deploy.sh sync", "rsync started ok"]); // ANSI stripped
    expect(stripAnsi(streams.written())).toContain("DEPLOYING…");
    expect(stripAnsi(streams.written())).toContain("rsync started ok");

    streams.type("D"); // ignored while running
    expect(st.armedAt).toBeUndefined();

    exitFn!(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(st.run?.running).toBe(false);
    expect(st.run?.code).toBe(0);
    expect(stripAnsi(streams.written())).toContain("DEPLOY OK");

    publishStatus(app, 0, false); // new boot's healthy reconcile auto-lifts
    streams.type("x"); // close the completed ceremony — back to the plan view
    expect(st.run).toBeUndefined();
    app.quit();
    await run;
  });

  it("x aborts a live run via the handle", async () => {
    const streams = fakeStreams();
    const app = new App(TUI_DEFAULTS, async () => ok(""), streams.out, streams.input);
    let killed = 0;
    let exitFn: ((code: number | null) => void) | undefined;
    app.hooks.deployRun = (_a, _onData, onExit) => {
      exitFn = onExit;
      return { kill: () => killed++ };
    };
    const st = installDeployHooks(app, { load: async () => ({ dirty: [], plan: [], head: "abc1234" }) }, () => 1000, quietDrain());
    const run = app.run();
    streams.type("3");
    await new Promise((r) => setTimeout(r, 0));
    streams.type("D");
    streams.type("D");
    await settle();
    publishStatus(app, 0);
    await settle();
    expect(st.run?.running).toBe(true);
    streams.type("x");
    expect(killed).toBe(1);
    exitFn!(null); // SIGTERM lands as a null code
    await new Promise((r) => setTimeout(r, 0));
    expect(st.run?.code).toBeNull();
    expect(stripAnsi(streams.written())).toContain("DEPLOY FAILED (exit signal)");
    app.quit();
    await run;
  });
});

describe("power button (stop/start the VM app)", () => {
  it("builds status + power commands from config", async () => {
    const { containerStatusArgv, powerCommand } = await import("../src/tui/deploytab.js");
    expect(containerStatusArgv(TUI_DEFAULTS)).toEqual([
      "sudo", "docker", "ps", "-a", "--filter", "name=quickreview-sandbox", "--format", "{{.Status}}",
    ]);
    expect(powerCommand(TUI_DEFAULTS, "stop")).toBe("sudo docker stop quickreview-sandbox");
    expect(powerCommand(TUI_DEFAULTS, "start")).toBe("sudo docker start quickreview-sandbox");
  });

  it("S S stops a running container; the button flips to START when stopped", async () => {
    const streams = fakeStreams();
    const app = new App(TUI_DEFAULTS, async () => ok(""), streams.out, streams.input);
    const actions: string[] = [];
    let status = "Up 2 hours";
    app.hooks.powerRun = (_a, action, _onData, onExit) => {
      actions.push(action);
      status = action === "stop" ? "Exited (0) 1 second ago" : "Up 1 second";
      onExit(0);
      return { kill: () => {} };
    };
    const st = installDeployHooks(app, { load: async () => ({ dirty: [], plan: [], head: "abc1234", containerStatus: status }) }, () => 1000);
    const run = app.run();
    streams.type("3");
    await new Promise((r) => setTimeout(r, 0));
    expect(stripAnsi(streams.written())).toContain("■ STOP VM APP");
    expect(stripAnsi(streams.written())).toContain("VM: Up 2 hours");

    streams.type("S");
    expect(st.armedKind).toBe("stop");
    expect(stripAnsi(streams.written())).toContain("CLICK AGAIN TO STOP NOW");
    streams.type("S");
    expect(actions).toEqual(["stop"]);
    expect(stripAnsi(streams.written())).toContain("■ STOPPED");
    await new Promise((r) => setTimeout(r, 0)); // reload settles → status refreshed

    streams.type("x"); // close the log — plan view now shows START
    expect(stripAnsi(streams.written())).toContain("▶ START VM APP");
    streams.type("S");
    streams.type("S");
    expect(actions).toEqual(["stop", "start"]);
    app.quit();
    await run;
  });

  it("clicking the power zone arms it; arming one button disarms the other", async () => {
    const streams = fakeStreams();
    const app = new App(TUI_DEFAULTS, async () => ok(""), streams.out, streams.input);
    let powers = 0;
    app.hooks.powerRun = (_a, _action, _d, onExit) => (powers++, onExit(0), { kill: () => {} });
    app.hooks.deployRun = (_a, _d, onExit) => (onExit(0), { kill: () => {} });
    const st = installDeployHooks(app, { load: async () => ({ dirty: [], plan: [], head: "abc1234", containerStatus: "Up 5 minutes" }) }, () => 1000);
    const run = app.run();
    streams.type("3");
    await new Promise((r) => setTimeout(r, 0));
    const click = (x: number, y: number) => streams.type(`\x1b[<0;${x};${y}M`);

    expect(st.powerZone).toBeDefined();
    click(st.powerZone!.x1, st.powerZone!.y1); // arms stop
    expect(st.armedKind).toBe("stop");
    streams.type("D"); // pressing the OTHER button re-arms, never confirms
    expect(st.armedKind).toBe("deploy");
    expect(powers).toBe(0);
    click(st.powerZone!.x1, st.powerZone!.y1); // arm stop again
    click(st.powerZone!.x2, st.powerZone!.y2); // confirm inside the zone
    expect(powers).toBe(1);
    app.quit();
    await run;
  });
});
