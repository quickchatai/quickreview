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
  type DeployState,
  type LocalRunner,
} from "../src/tui/deploytab.js";
import { stripAnsi } from "../src/tui/paint.js";
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

describe("deploy tab keys", () => {
  it("opens on 4, scrolls with j/k, refreshes on r, and 1 returns to the board", async () => {
    const streams = fakeStreams();
    const app = new App(TUI_DEFAULTS, async () => ok(""), streams.out, streams.input);
    let loads = 0;
    const st = installDeployHooks(app, {
      load: async () => (loads++, { dirty: [], plan: ["plan — deploy.sh sync"], deployed: undefined, head: "abc1234" }),
    });
    const run = app.run();
    streams.type("4");
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
    const st = installDeployHooks(app, { load: async () => ({ dirty: [], plan: [] }) }, () => clock);
    const run = app.run();
    streams.type("4");
    await new Promise((r) => setTimeout(r, 0));

    streams.type("D");
    expect(st.armedAt).toBe(1000);
    streams.type("j"); // disarms
    expect(st.armedAt).toBeUndefined();
    expect(deploys).toBe(0);

    streams.type("D");
    clock += 2000; // inside the confirm window
    streams.type("D");
    expect(deploys).toBe(1);
    expect(st.armedAt).toBeUndefined();

    streams.type("D");
    clock += 10_000; // window expired: second D only re-arms
    streams.type("D");
    expect(deploys).toBe(1);
    expect(st.armedAt).toBeDefined();
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
    const st = installDeployHooks(app, { load: async () => ({ dirty: [], plan: [] }) }, () => clock);
    const run = app.run();
    streams.type("4");
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
    click(st.buttonZone!.x2, st.buttonZone!.y2); // second click inside the window deploys
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
    const st = installDeployHooks(app, { load: async () => ({ dirty: [], plan: [] }) }, () => clock);
    const run = app.run();
    streams.type("4");
    await new Promise((r) => setTimeout(r, 0));

    streams.type("D");
    streams.type("D");
    expect(st.run?.running).toBe(true);
    dataFn!("plan — deploy.sh sync\nrsync st"); // chunk split mid-line
    dataFn!("arted\x1b[32m ok\x1b[0m\n");
    expect(st.run?.lines).toEqual(["plan — deploy.sh sync", "rsync started ok"]); // ANSI stripped
    expect(stripAnsi(streams.written())).toContain("DEPLOYING…");
    expect(stripAnsi(streams.written())).toContain("rsync started ok");

    streams.type("D"); // ignored while running
    expect(st.armedAt).toBeUndefined();

    exitFn!(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(st.run?.running).toBe(false);
    expect(st.run?.code).toBe(0);
    expect(stripAnsi(streams.written())).toContain("DEPLOY OK");

    streams.type("x"); // close the log — back to the plan view
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
    const st = installDeployHooks(app, { load: async () => ({ dirty: [], plan: [] }) }, () => 1000);
    const run = app.run();
    streams.type("4");
    await new Promise((r) => setTimeout(r, 0));
    streams.type("D");
    streams.type("D");
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
