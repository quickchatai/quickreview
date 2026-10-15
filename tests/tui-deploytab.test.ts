// Deploy tab — argv construction, BUILD_SHA parsing, the pure line renderer,
// and key routing. All runners are fakes; nothing spawns, nothing sshes.
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { TUI_DEFAULTS } from "../src/config.js";
import { App } from "../src/tui/app.js";
import {
  CONFIG_FINGERPRINT_ARGV,
  DIRTY_ARGV,
  HEAD_ARGV,
  PLAN_ARGV,
  RealDeployFetcher,
  buildShaArgv,
  configFingerprintArgv,
  deployKeys,
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
import { configDrift, configDriftText, parseConfigFingerprint } from "../src/tui/confighome.js";
import type { RemoteResult } from "../src/tui/remote.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

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
  return {
    out,
    input,
    written: () => buf,
    type: (s: string | Buffer) => input.emit("data", Buffer.from(s)),
  };
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
    expect(parseBuildSha("540a9d0 2026-08-14T13:10:00Z sync\n")).toEqual({
      sha: "540a9d0",
      at: "2026-08-14T13:10:00Z",
      mode: "sync",
    });
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
    expect(st.deployed).toMatchObject({ sha: "aaa1111" });
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
    expect(st.deployed).toBe("absent"); // the VM answered: no marker file
    expect(st.commits).toBeUndefined();
    expect(st.dirty).toEqual([" M src/x.ts"]);
    // the refusal is shown verbatim as the plan
    expect(st.plan.join("\n")).toContain("refusing to deploy");
    expect(localCalls.some((c) => c.includes("log"))).toBe(false);
  });

  it("answers empty only for a MISSING marker — a marker it cannot read fails the exec", () => {
    const script = buildShaArgv(TUI_DEFAULTS).at(-1)!;
    expect(script).toBe(
      "if [ -e '/opt/quickreview/sandbox/BUILD_SHA' ]; then cat '/opt/quickreview/sandbox/BUILD_SHA'; fi",
    );
    expect(script).not.toContain("|| true");
  });

  it("a range read that fails replaces the previous load's commits and diffstat", async () => {
    const results: Record<string, RemoteResult> = {
      [HEAD_ARGV.join(" ")]: ok("bbb2222\n"),
      [DIRTY_ARGV.join(" ")]: ok(""),
      [PLAN_ARGV.join(" ")]: ok("plan\n"),
      [logArgv("aaa1111").join(" ")]: ok("bbb2222 fix the thing\n"),
      [diffStatArgv("aaa1111").join(" ")]: ok(" src/x.ts | 2 +-\n"),
    };
    const { f } = fetcherWith(ok("aaa1111 2026-08-14T12:00:00Z sync\n"), results);
    const st: Partial<DeployState> = {};
    Object.assign(st, await f.load());
    expect(st.commits).toEqual(["bbb2222 fix the thing"]);
    delete results[logArgv("aaa1111").join(" ")];
    delete results[diffStatArgv("aaa1111").join(" ")];
    // The tab merges every load over the last one (Object.assign).
    Object.assign(st, await f.load());
    expect(st.commits).toBeUndefined();
    expect(st.diffstat).toBeUndefined();
  });

  // A missing marker answers empty output, so an
  // ok/empty answer is a VM with no marker; a failed exec is a VM we could not
  // ask. The two stay apart: neither the tab nor the companion feed may read
  // an unasked VM as "no marker".
  it("an ssh that never answered is NOT a VM with no marker", async () => {
    const { f, localCalls } = fetcherWith(fail("ssh: connect timed out"), {
      [HEAD_ARGV.join(" ")]: ok("bbb2222\n"),
      [DIRTY_ARGV.join(" ")]: ok(""),
      [PLAN_ARGV.join(" ")]: ok("plan\n"),
    });
    const st = await f.load();
    expect(st.deployed).toBeUndefined();
    expect(st.containerStatus).toBeUndefined();
    expect(localCalls.some((c) => c.includes("log"))).toBe(false);
  });

  // The read SUCCEEDED here — the content is the problem — so it is neither a
  // missing marker nor an ssh failure, and neither of those sentences is true.
  it("a marker that exists but is garbage is unparseable — not absent, not unread", async () => {
    const { f, localCalls } = fetcherWith(ok("not-a-sha here\n"), {
      [HEAD_ARGV.join(" ")]: ok("bbb2222\n"),
      [DIRTY_ARGV.join(" ")]: ok(""),
      [PLAN_ARGV.join(" ")]: ok(""),
    });
    expect((await f.load()).deployed).toBe("unparseable");
    expect(localCalls.some((c) => c.includes("log"))).toBe(false);
  });
});

const FP_A = { config: "a".repeat(64), profiles: "b".repeat(64) };
const FP_B = { config: "a".repeat(64), profiles: "c".repeat(64) };

describe("config home vs the VM", () => {
  it("fingerprints the shipped home inside the container, and the local one with the same script", () => {
    const argv = configFingerprintArgv(TUI_DEFAULTS);
    expect(argv.slice(0, 4)).toEqual(["sudo", "docker", "exec", "quickreview-sandbox"]);
    const script = argv[argv.length - 1]!;
    expect(script).toContain(
      "bash '/opt/quickreview/sandbox/scripts/config-fingerprint.sh' --located '/opt/quickreview/sandbox'",
    );
    // a VM that predates the script was never shipped a home — a fact, said as one
    expect(script).toContain("else echo none");
    expect(CONFIG_FINGERPRINT_ARGV).toEqual([
      "bash",
      "scripts/config-fingerprint.sh",
      "--located",
      ".",
    ]);
  });

  it("parses the script's two answers and nothing else", () => {
    expect(parseConfigFingerprint(`config=${"a".repeat(64)} profiles=${"b".repeat(64)}\n`)).toEqual(
      FP_A,
    );
    expect(parseConfigFingerprint("none\n")).toBe("none");
    expect(parseConfigFingerprint("")).toBe("unparseable");
    expect(parseConfigFingerprint("bash: no such file")).toBe("unparseable");
  });

  it("compares honestly: an unread or garbled end is unknown, never 'same' and never 'changed'", () => {
    expect(configDrift(FP_A, FP_A)).toEqual({ kind: "same" });
    expect(configDrift(FP_B, FP_A)).toEqual({ kind: "changed", config: false, profiles: true });
    expect(configDrift({ ...FP_A, config: "d".repeat(64) }, FP_A)).toEqual({
      kind: "changed",
      config: true,
      profiles: false,
    });
    expect(configDrift("none", FP_A)).toEqual({ kind: "no-home" });
    expect(configDrift(FP_A, "none")).toEqual({ kind: "never-shipped" });
    for (const [l, d] of [
      [undefined, FP_A],
      ["unparseable", FP_A],
      [FP_A, undefined],
      [FP_A, "unparseable"],
    ] as const)
      expect(configDrift(l, d).kind).toBe("unknown");
    expect(configDriftText(configDrift(FP_B, FP_A))).toBe("profile changed, not deployed");
  });

  it("the fetcher reads both ends — the VM over ssh, this machine locally", async () => {
    const shipped = `config=${"a".repeat(64)} profiles=${"b".repeat(64)}\n`;
    const local = `config=${"a".repeat(64)} profiles=${"c".repeat(64)}\n`;
    const ssh = async (_h: string, argv: string[]) =>
      argv.join(" ").includes("config-fingerprint.sh") ? ok(shipped) : ok("");
    const f = new RealDeployFetcher(TUI_DEFAULTS, ssh, async (argv) =>
      argv.join(" ") === CONFIG_FINGERPRINT_ARGV.join(" ") ? ok(local) : ok(""),
    );
    const st = await f.load();
    expect(st.configDeployed).toEqual(FP_A);
    expect(st.configLocal).toEqual(FP_B);
    const text = stripAnsi(deployLines({ ...emptyState(), ...st }, 100).join("\n"));
    expect(text).toContain("CONFIG");
    expect(text).toContain("profile changed, not deployed");
    // an ssh that never answered leaves the VM end unread → unknown
    const dead = new RealDeployFetcher(
      TUI_DEFAULTS,
      async () => fail("timeout"),
      async () => ok(local),
    );
    const unread = await dead.load();
    expect(unread.configDeployed).toBeUndefined();
    expect(stripAnsi(deployLines({ ...emptyState(), ...unread }, 100).join("\n"))).toContain(
      "unknown — the VM's config home could not be read",
    );
  });

  it("'nothing to deploy' needs the config home compared and equal, not just the commit", () => {
    const at = (over: Partial<DeployState>) =>
      stripAnsi(
        deployLines(
          emptyState({ deployed: { sha: "aaa1111" }, head: "aaa1111", commits: [], ...over }),
          100,
        ).join("\n"),
      );
    expect(at({ configLocal: FP_A, configDeployed: FP_A })).toContain("nothing to deploy");
    const behind = at({ configLocal: FP_B, configDeployed: FP_A });
    expect(behind).not.toContain("nothing to deploy");
    expect(behind).toContain("config home is behind");
    expect(at({ configLocal: FP_A, configDeployed: "none" })).toContain("config home is behind");
    const unknown = at({});
    expect(unknown).not.toContain("nothing to deploy");
    expect(unknown).toContain("whether its config home matches is not known");
  });
});

describe("deployLines", () => {
  it("says nothing-to-deploy when the VM already runs HEAD and the tree is clean", () => {
    const text = stripAnsi(
      deployLines(
        emptyState({
          deployed: { sha: "aaa1111" },
          head: "aaa1111",
          commits: [],
          diffstat: [],
          configLocal: FP_A,
          configDeployed: FP_A,
        }),
        90,
      ).join("\n"),
    );
    expect(text).toContain("nothing to deploy");
    expect(text).toContain("./scripts/deploy.sh sync");
    expect(text).toContain("press D twice");
  });

  it("shows the armed banner after the first D", () => {
    const text = stripAnsi(deployLines(emptyState({ armedAt: 123 }), 90).join("\n"));
    expect(text).toContain("ARMED");
    expect(text).toContain("press D again");
  });

  it("an armed stop/start names S, never D", () => {
    for (const kind of ["stop", "start"] as const) {
      const text = stripAnsi(
        deployLines(emptyState({ armedAt: 123, armedKind: kind }), 120).join("\n"),
      );
      expect(text).toContain(`press S again to ${kind} the VM app`);
      expect(text).not.toContain("press D again");
    }
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

  it("renders 'no marker' and 'could not read' as different sentences, and an unread HEAD as unknown", () => {
    const absent = stripAnsi(
      deployLines(emptyState({ deployed: "absent", head: "ccc3333" }), 90).join("\n"),
    );
    expect(absent).toContain("no BUILD_SHA on the VM yet");
    expect(absent).not.toContain("could not be read");
    const unread = stripAnsi(
      deployLines(emptyState({ deployed: undefined, head: undefined }), 90).join("\n"),
    );
    expect(unread).toContain("could not be read");
    expect(unread).not.toContain("no BUILD_SHA on the VM yet");
    expect(unread).toContain("HEAD unknown");
    // A corrupt marker was READ — blaming ssh/docker for it would be false.
    const corrupt = stripAnsi(
      deployLines(emptyState({ deployed: "unparseable", head: "ccc3333" }), 160).join("\n"),
    );
    expect(corrupt).toContain("corrupt marker");
    expect(corrupt).not.toContain("could not be read");
    expect(corrupt).not.toContain("no BUILD_SHA on the VM yet");
    expect(corrupt).not.toContain("nothing to deploy");
  });

  it("flags a deployed sha unknown to local git instead of pretending 0 pending", () => {
    const text = stripAnsi(
      deployLines(emptyState({ deployed: { sha: "deadbee" }, head: "ccc3333" }), 90).join("\n"),
    );
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

const settle = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0));
};

function quietDrain(rounds = 0): DeployDrainSender {
  return {
    set: async (on) =>
      on
        ? { ok: true, draining: true, running_rounds: rounds }
        : { ok: true, draining: false, dropped_deliveries: 0 },
  };
}

describe("deploy tab drain orchestration", () => {
  it(
    "engages drain, visibly waits through running rounds, then deploys exactly once at zero",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const streams = fakeStreams();
      const app = new App(TUI_DEFAULTS, async () => ok(""), streams.out, streams.input);
      const drainCalls: boolean[] = [];
      const drain: DeployDrainSender = {
        set: async (on) => {
          drainCalls.push(on);
          return {
            ok: true,
            draining: on,
            running_rounds: on ? 2 : undefined,
            dropped_deliveries: on ? undefined : 0,
          };
        },
      };
      let deploys = 0;
      app.hooks.deployRun = (_a, _id, _data, exit) => {
        deploys++;
        exit(0);
        return { kill: () => {} };
      };
      const st = installDeployHooks(
        app,
        { load: async () => ({ dirty: [], plan: [], head: "abc1234" }) },
        () => 1000,
        drain,
      );
      const run = app.run();
      streams.type("5");
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
      // With the finished log on screen `D` is not offered (deployKeys) — the
      // bar says `x close log` — so the key is not this tab's and does nothing.
      streams.type("D");
      streams.type("D");
      expect(deploys).toBe(1);
      expect(deployKeys(st).bar.map((b) => b.key)).toEqual(["x"]);
      streams.type("x");
      expect(st.run).toBeDefined();
      expect(app.view.noticeLine).toContain("has not auto-lifted yet");
      publishStatus(app, 0, false);
      expect(st.deployPhase).toBe("done");
      expect(app.view.noticeLine).toContain("drain lifted");
      expect(drainCalls).toEqual([true]); // the healthy daemon boot owns the lift
      app.quit();
      await run;
    },
  );

  it("restores an owned drain after hot reload and continues only when the board reaches zero", async () => {
    const store = new MemoryDeployCeremonyStore();
    const firstStreams = fakeStreams();
    const first = new App(TUI_DEFAULTS, async () => ok(""), firstStreams.out, firstStreams.input);
    const drain = quietDrain(2);
    installDeployHooks(
      first,
      { load: async () => ({ dirty: [], plan: [], head: "abc1234" }) },
      () => 1000,
      drain,
      store,
    );
    const firstRun = first.run();
    firstStreams.type("5");
    await settle();
    firstStreams.type("D");
    firstStreams.type("D");
    await settle();
    expect(store.read()?.phase).toBe("waiting-rounds");
    first.quit();
    await firstRun;

    const secondStreams = fakeStreams();
    const second = new App(
      TUI_DEFAULTS,
      async () => ok(""),
      secondStreams.out,
      secondStreams.input,
    );
    let deploys = 0;
    second.hooks.deployRun = (_a, _id, _d, exit) => {
      deploys++;
      exit(0);
      return { kill: () => {} };
    };
    const restored = installDeployHooks(
      second,
      { load: async () => ({ dirty: [], plan: [], head: "abc1234" }) },
      () => 2000,
      drain,
      store,
    );
    const secondRun = second.run();
    secondStreams.type("5");
    await settle();
    expect(restored.deployPhase).toBe("waiting-rounds");
    publishStatus(second, 1);
    expect(deploys).toBe(0);
    publishStatus(second, 0);
    await settle();
    expect(deploys).toBe(1);
    second.quit();
    await secondRun;
  });

  it("will not resume a zero-round drain until the restored target HEAD is loaded", async () => {
    const store = new MemoryDeployCeremonyStore();
    store.write({
      version: 1,
      phase: "waiting-rounds",
      target_head: "abc1234",
      updated_at: "2026-08-28T12:00:01Z",
    });
    const finishLoads: Array<(value: any) => void> = [];
    const fetcher = {
      load: () =>
        new Promise<any>((resolve) => {
          finishLoads.push(resolve);
        }),
    };
    const streams = fakeStreams();
    const app = new App(TUI_DEFAULTS, async () => ok(""), streams.out, streams.input);
    let deploys = 0;
    app.hooks.deployRun = (_a, _id, _d, exit) => {
      deploys++;
      exit(0);
      return { kill: () => {} };
    };
    const st = installDeployHooks(app, fetcher, () => 2000, quietDrain(), store);
    const run = app.run();
    publishStatus(app, 0);
    await settle();
    expect(deploys).toBe(0);
    expect(st.deployPhase).toBe("waiting-rounds");
    expect(finishLoads).toHaveLength(2); // eager restore + zero-round preflight refresh
    for (const finish of finishLoads) finish({ dirty: [], plan: [], head: "abc1234" });
    await settle();
    // The App's own poll (a fake ssh with no status.json) has since marked the
    // daemon unreachable: a sync never starts without a fresh quiet status.
    expect(app.view.health.kind).toBe("unreachable");
    expect(deploys).toBe(0);
    publishStatus(app, 0);
    expect(finishLoads).toHaveLength(3);
    finishLoads[2]!({ dirty: [], plan: [], head: "abc1234" });
    await settle();
    expect(deploys).toBe(1);
    app.quit();
    await run;
  });

  it("persists an abort requested during drain acknowledgement across hot reload", async () => {
    const store = new MemoryDeployCeremonyStore();
    const firstStreams = fakeStreams();
    const first = new App(TUI_DEFAULTS, async () => ok(""), firstStreams.out, firstStreams.input);
    const never = new Promise<any>(() => {});
    const pendingDrain: DeployDrainSender = { set: async () => never };
    installDeployHooks(
      first,
      { load: async () => ({ dirty: [], plan: [], head: "abc1234" }) },
      () => 1000,
      pendingDrain,
      store,
    );
    const firstRun = first.run();
    firstStreams.type("5");
    await settle();
    firstStreams.type("D");
    firstStreams.type("D");
    firstStreams.type("x");
    expect(store.read()?.phase).toBe("abort-requested");
    first.quit();
    await firstRun;

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
    const second = new App(
      TUI_DEFAULTS,
      async () => ok(""),
      secondStreams.out,
      secondStreams.input,
    );
    let deploys = 0;
    second.hooks.deployRun = () => {
      deploys++;
      return { kill: () => {} };
    };
    const restored = installDeployHooks(
      second,
      { load: async () => ({ dirty: [], plan: [], head: "abc1234" }) },
      () => 2000,
      resumedDrain,
      store,
    );
    const secondRun = second.run();
    await settle();
    await settle();
    expect(calls).toEqual([true, false]);
    expect(restored.deployPhase).toBe("aborted");
    expect(deploys).toBe(0);
    expect(store.read()).toBeUndefined();
    second.quit();
    await secondRun;
  });

  it("re-attaches to the same durable sync after the mandatory hot reload", async () => {
    const store = new MemoryDeployCeremonyStore();
    store.write({
      version: 1,
      phase: "syncing",
      target_head: "abc1234",
      pre_deploy_snapshot_at: "2026-08-28T12:00:00Z",
      deploy_run_id: "deploy-run-1234",
      updated_at: "2026-08-28T12:00:01Z",
    });
    const streams = fakeStreams();
    const app = new App(TUI_DEFAULTS, async () => ok(""), streams.out, streams.input);
    const attached: string[] = [];
    let finish: ((code: number | null) => void) | undefined;
    app.hooks.deployRun = (_a, runId, _data, onExit) => {
      attached.push(runId);
      finish = onExit;
      return { kill: () => {} };
    };
    const st = installDeployHooks(
      app,
      { load: async () => ({ dirty: [], plan: [], head: "abc1234" }) },
      () => 2000,
      quietDrain(),
      store,
    );
    const run = app.run();
    streams.type("5");
    await settle();
    expect(st.deployPhase).toBe("syncing");
    expect(st.run?.running).toBe(true);
    expect(attached).toEqual(["deploy-run-1234"]);
    finish!(0);
    expect(st.deployPhase).toBe("awaiting-lift");
    expect(store.read()?.deploy_run_id).toBe("deploy-run-1234");
    app.quit();
    await run;
  });

  it("never starts deploy when the daemon refuses the drain", async () => {
    const streams = fakeStreams();
    const app = new App(TUI_DEFAULTS, async () => ok(""), streams.out, streams.input);
    let deploys = 0;
    app.hooks.deployRun = () => {
      deploys++;
      return { kill: () => {} };
    };
    const drain: DeployDrainSender = { set: async () => ({ ok: false, reason: "tier refused" }) };
    const st = installDeployHooks(
      app,
      { load: async () => ({ dirty: [], plan: [], head: "abc1234" }) },
      () => 1000,
      drain,
    );
    const run = app.run();
    streams.type("5");
    await settle();
    streams.type("D");
    streams.type("D");
    await settle();
    expect(deploys).toBe(0);
    expect(st.deployPhase).toBe("drain-failed");
    expect(stripAnsi(streams.written())).toContain("tier refused");
    app.quit();
    await run;
  });

  it("never starts deploy on a drain the daemon BOUNDED because the operator channel was unsealed", async () => {
    // The receipt is ok and draining, but stamped issuer "session": the daemon
    // found commands/operator/ writable by its own uid and gave the deploy
    // tab a 30-minute session drain that can lapse mid-sync. MUTATION: drop
    // the `result.issuer === "session"` branch in startDrain — the phase
    // lands on "waiting-rounds" and the written text says nothing.
    const streams = fakeStreams();
    const app = new App(TUI_DEFAULTS, async () => ok(""), streams.out, streams.input);
    let deploys = 0;
    app.hooks.deployRun = () => {
      deploys++;
      return { kill: () => {} };
    };
    const drain: DeployDrainSender = {
      set: async () => ({
        ok: true,
        draining: true,
        running_rounds: 0,
        issuer: "session",
        expires_at: "2026-09-02T10:30:00.000Z",
      }),
    };
    const st = installDeployHooks(
      app,
      { load: async () => ({ dirty: [], plan: [], head: "abc1234" }) },
      () => 1000,
      drain,
    );
    const run = app.run();
    streams.type("5");
    await settle();
    streams.type("D");
    streams.type("D");
    await settle();
    publishStatus(app, 0);
    await settle();
    expect(deploys).toBe(0);
    expect(st.deployPhase).toBe("drain-failed");
    expect(stripAnsi(streams.written())).toContain("NOT sealed");
    // The run's own lines carry the whole reason (the pane truncates to width).
    expect(st.run?.lines.join("\n")).toContain("lapses 2026-09-02T10:30:00.000Z");
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
    app.hooks.deployRun = () => {
      deploys++;
      return { kill: () => {} };
    };
    const st = installDeployHooks(
      app,
      { load: async () => ({ dirty: [], plan: [], head: "abc1234" }) },
      () => 1000,
      drain,
    );
    const run = app.run();
    streams.type("5");
    await settle();
    streams.type("D");
    streams.type("D");
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
    app.hooks.deployRun = () => {
      deploys++;
      return { kill: () => {} };
    };
    const st = installDeployHooks(
      app,
      { load: async () => ({ dirty: [], plan: [], head: "abc1234" }) },
      () => 1000,
      quietDrain(2),
      store,
    );
    const run = app.run();
    streams.type("5");
    await settle();
    streams.type("D");
    streams.type("D");
    await settle();
    publishStatus(app, 2, true);
    expect(store.read()?.drain_observed).toBe(true);
    publishStatus(app, 0, false);
    expect(st.deployPhase).toBe("aborted");
    expect(deploys).toBe(0);
    expect(store.read()).toBeUndefined();
    expect(app.view.noticeLine).toContain("operator lifted the drain");
    app.quit();
    await run;
  });

  it("recognizes an external drain-off even before the first ON snapshot arrives", async () => {
    const store = new MemoryDeployCeremonyStore();
    const streams = fakeStreams();
    const app = new App(TUI_DEFAULTS, async () => ok(""), streams.out, streams.input);
    let deploys = 0;
    app.hooks.deployRun = () => {
      deploys++;
      return { kill: () => {} };
    };
    const st = installDeployHooks(
      app,
      { load: async () => ({ dirty: [], plan: [], head: "abc1234" }) },
      () => 1000,
      quietDrain(2),
      store,
    );
    const run = app.run();
    streams.type("5");
    await settle();
    streams.type("D");
    streams.type("D");
    await settle();
    publishStatus(app, 0, false); // may still be the pre-command status generation
    expect(st.deployPhase).toBe("waiting-rounds");
    publishStatus(app, 0, false); // a newer undrained generation proves override
    expect(st.deployPhase).toBe("aborted");
    expect(deploys).toBe(0);
    expect(store.read()).toBeUndefined();
    app.quit();
    await run;
  });

  it("a failed sync leaves the drain standing until x acknowledges a safe retry", async () => {
    const store = new MemoryDeployCeremonyStore();
    const streams = fakeStreams();
    const app = new App(TUI_DEFAULTS, async () => ok(""), streams.out, streams.input);
    const calls: boolean[] = [];
    const drain: DeployDrainSender = {
      set: async (on) => {
        calls.push(on);
        return {
          ok: true,
          draining: on,
          running_rounds: on ? 0 : undefined,
          dropped_deliveries: on ? undefined : 0,
        };
      },
    };
    app.hooks.deployRun = (_a, _id, _data, exit) => {
      exit(1);
      return { kill: () => {} };
    };
    const st = installDeployHooks(
      app,
      { load: async () => ({ dirty: [], plan: [], head: "abc1234" }) },
      () => 1000,
      drain,
      store,
    );
    const run = app.run();
    streams.type("5");
    await settle();
    streams.type("D");
    streams.type("D");
    await settle();
    publishStatus(app, 0);
    await settle();
    expect(st.deployPhase).toBe("deploy-failed");
    expect(calls).toEqual([true]);
    expect(stripAnsi(streams.written())).toContain("drain remains ON");
    expect(store.read()?.phase).toBe("deploy-failed");
    streams.type("x");
    expect(store.read()).toBeUndefined();
    expect(app.view.noticeLine).toContain("drain state unchanged");
    streams.type("D");
    expect(st.armedAt).toBeDefined();
    app.quit();
    await run;
  });
});

describe("deploy tab drain orchestration — revalidation and refresh", () => {
  it("a sync waits when the status goes stale while the preflight refresh runs", async () => {
    const streams = fakeStreams();
    const app = new App(TUI_DEFAULTS, async () => ok(""), streams.out, streams.input);
    let deploys = 0;
    app.hooks.deployRun = (_a, _id, _d, exit) => {
      deploys++;
      exit(0);
      return { kill: () => {} };
    };
    const pending: Array<(value: any) => void> = [];
    let lazy = true;
    const fetcher = {
      load: () => {
        if (lazy) return Promise.resolve({ dirty: [], plan: [], head: "abc1234" });
        return new Promise<any>((resolve) => pending.push(resolve));
      },
    };
    const st = installDeployHooks(app, fetcher, () => 1000, quietDrain(1));
    const run = app.run();
    streams.type("5");
    await settle();
    streams.type("D");
    streams.type("D");
    await settle();
    expect(st.deployPhase).toBe("waiting-rounds");
    lazy = false;
    publishStatus(app, 0); // zero rounds → the preflight refresh starts
    expect(pending).toHaveLength(1);
    app.view.health = { kind: "stale", dataAgeS: 600 };
    app.hooks.onPoll?.(app);
    pending[0]!({ dirty: [], plan: [], head: "abc1234" });
    await settle();
    expect(deploys).toBe(0);
    expect(st.deployPhase).toBe("waiting-rounds");
    publishStatus(app, 0); // fresh again → preflight again → sync
    expect(pending).toHaveLength(2);
    pending[1]!({ dirty: [], plan: [], head: "abc1234" });
    await settle();
    expect(deploys).toBe(1);
    app.quit();
    await run;
  });

  it("r after a failed sync keeps the result on screen so x can still acknowledge it", async () => {
    const store = new MemoryDeployCeremonyStore();
    const streams = fakeStreams();
    const app = new App(TUI_DEFAULTS, async () => ok(""), streams.out, streams.input);
    app.hooks.deployRun = (_a, _id, _data, exit) => {
      exit(1);
      return { kill: () => {} };
    };
    let loads = 0;
    const st = installDeployHooks(
      app,
      { load: async () => (loads++, { dirty: [], plan: [], head: "abc1234" }) },
      () => 1000,
      quietDrain(0),
      store,
    );
    const run = app.run();
    streams.type("5");
    await settle();
    streams.type("D");
    streams.type("D");
    await settle();
    publishStatus(app, 0);
    await settle();
    expect(st.deployPhase).toBe("deploy-failed");
    const before = loads;
    streams.type("r");
    await settle();
    expect(loads).toBeGreaterThan(before); // r still refreshes
    expect(st.run).toBeDefined();
    expect(st.deployPhase).toBe("deploy-failed");
    expect(deployKeys(st).bar.map((b) => b.key)).toEqual(["x"]);
    streams.type("x");
    expect(store.read()).toBeUndefined();
    streams.type("D");
    expect(st.armedAt).toBeDefined();
    app.quit();
    await run;
  });
});

describe("deploy tab keys", () => {
  it("opens on 5, scrolls with j/k, refreshes on r, and 1 returns to the board", async () => {
    const streams = fakeStreams();
    const app = new App(TUI_DEFAULTS, async () => ok(""), streams.out, streams.input);
    let loads = 0;
    const st = installDeployHooks(app, {
      load: async () => (
        loads++,
        { dirty: [], plan: ["plan — deploy.sh sync"], deployed: "absent" as const, head: "abc1234" }
      ),
    });
    const run = app.run();
    streams.type("5");
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
    app.hooks.deployRun = (_a, _id, _onData, onExit) => {
      deploys++;
      onExit(0);
      return { kill: () => {} };
    };
    let clock = 1000;
    const st = installDeployHooks(
      app,
      { load: async () => ({ dirty: [], plan: [], head: "abc1234" }) },
      () => clock,
      quietDrain(),
    );
    const run = app.run();
    streams.type("5");
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
    expect(deployKeys(st).bar.map((b) => b.key)).toEqual(["x"]); // a finished log on screen: only `x close log` is offered
    app.quit();
    await run;
  });

  it("clicking THE button arms then deploys; a click elsewhere disarms", async () => {
    const streams = fakeStreams();
    const app = new App(TUI_DEFAULTS, async () => ok(""), streams.out, streams.input);
    let deploys = 0;
    app.hooks.deployRun = (_a, _id, _onData, onExit) => {
      deploys++;
      onExit(0);
      return { kill: () => {} };
    };
    let clock = 1000;
    const st = installDeployHooks(
      app,
      { load: async () => ({ dirty: [], plan: [], head: "abc1234" }) },
      () => clock,
      quietDrain(),
    );
    const run = app.run();
    streams.type("5");
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
    app.hooks.deployRun = (_a, _id, onData, onExit) => {
      dataFn = onData;
      exitFn = onExit;
      return { kill: () => {} };
    };
    const clock = 1000;
    const st = installDeployHooks(
      app,
      { load: async () => ({ dirty: [], plan: [], head: "abc1234" }) },
      () => clock,
      quietDrain(),
    );
    const run = app.run();
    streams.type("5");
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
    app.hooks.deployRun = (_a, _id, _onData, onExit) => {
      exitFn = onExit;
      return { kill: () => killed++ };
    };
    const st = installDeployHooks(
      app,
      { load: async () => ({ dirty: [], plan: [], head: "abc1234" }) },
      () => 1000,
      quietDrain(),
    );
    const run = app.run();
    streams.type("5");
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
      "sudo",
      "docker",
      "ps",
      "-a",
      "--filter",
      "name=quickreview-sandbox",
      "--format",
      "{{.Status}}",
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
    const st = installDeployHooks(
      app,
      { load: async () => ({ dirty: [], plan: [], head: "abc1234", containerStatus: status }) },
      () => 1000,
    );
    const run = app.run();
    streams.type("5");
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
    app.hooks.deployRun = (_a, _id, _d, onExit) => (onExit(0), { kill: () => {} });
    const st = installDeployHooks(
      app,
      {
        load: async () => ({
          dirty: [],
          plan: [],
          head: "abc1234",
          containerStatus: "Up 5 minutes",
        }),
      },
      () => 1000,
    );
    const run = app.run();
    streams.type("5");
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
