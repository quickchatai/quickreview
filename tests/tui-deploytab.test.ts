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
    expect(text).toContain("this tab never deploys");
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
});
