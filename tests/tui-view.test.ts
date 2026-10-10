// The companion sees the operator's view.
//
// Two halves and one boundary:
//   * the TUI PUBLISHES its view to /feed as plain files (screen.txt +
//     view.json), on the poll and on every repaint, throttled — and never as a
//     chat turn;
//   * a local pi extension EXPOSES those files as read-only `tui_*` tools;
//   * the boundary that makes the second half legal at all: the tools read
//     state the TUI already fetched. They can never become a fetcher, because
//     the module has nothing to fetch with. That is asserted here against the
//     source, so a future edit that adds an ssh/spawn/fetch path fails loudly.
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TUI_DEFAULTS } from "../src/config.js";
import type { StatusSnapshot } from "../src/state.js";
import { App } from "../src/tui/app.js";
import { CompanionLifecycle } from "../src/tui/companion.js";
import {
  FeedWriter,
  SCREEN_MAX_CHARS,
  VIEW_MIN_INTERVAL_MS,
  buildTuiView,
  clampScreen,
  type TuiView,
} from "../src/tui/feed.js";
import {
  STALE_AFTER_MS,
  TOOL_NAMES,
  boardAnswer,
  deployAnswer,
  freshness,
  readFeedFile,
  resolveFeedDir,
  screenAnswer,
  toolDefinitions,
  activate,
} from "../extensions/tui-view.js";
import type { Pi, PiToolDefinition } from "@earendil-works/pi-coding-agent";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-ft231-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function snap(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    written_at: "2026-08-25T10:00:00Z",
    dry_run: false,
    prs: [
      {
        number: 5012,
        state: "reviewing",
        title: "add a thing",
        head_sha: "abc1234",
        stale_recheck: false,
        rounds: 2,
        last_verdict: null,
      },
      {
        number: 5013,
        state: "queued",
        title: "another",
        head_sha: "def5678",
        stale_recheck: true,
        rounds: 0,
        last_verdict: null,
      },
      {
        number: 5014,
        state: "closed",
        title: "gone",
        head_sha: "0000000",
        stale_recheck: false,
        rounds: 1,
        last_verdict: "APPROVE",
      },
    ],
    running_rounds: 1,
    max_concurrent_rounds: 3,
    total_spend_usd: 12.5,
    today_spend_usd: 1.25,
    heartbeat: "2026-08-25T10:00:00Z",
    ...overrides,
  } as StatusSnapshot;
}

const DEPLOY = {
  loaded: true,
  deployed: { sha: "aaa1111", at: "2026-08-24T09:00:00Z", mode: "sync" },
  head: "bbb2222",
  dirty: ["src/tui/app.ts"],
  commits: ["bbb2222 fix the thing", "ccc3333 and another"],
  diffstat: [" src/a.ts | 2 +-", " 2 files changed, 4 insertions(+)"],
  containerStatus: "Up 2 hours",
};

const NOW = new Date("2026-08-25T10:00:05Z");

/** The published config-home fact for a deploy state. */
function v_configHome(deploy: Parameters<typeof buildTuiView>[0]["deploy"]): string | null {
  return buildTuiView({ now: NOW, tab: "deploy", deploy }).deploy.config_home;
}

// ---- half 1: what the TUI publishes ----------------------------------------

describe("buildTuiView — the derived state behind the frame", () => {
  it("leads with deploy state: the commit the VM runs, HEAD, dirt, and what is waiting to ship", () => {
    const v = buildTuiView({ now: NOW, tab: "deploy", snapshot: snap(), deploy: DEPLOY });
    // Deploy leads the view by design, not by accident of key order.
    expect(Object.keys(v)[1]).toBe("deploy");
    expect(v.deploy.deployed).toMatchObject({ sha: "aaa1111" });
    expect(v.deploy.head).toBe("bbb2222");
    expect(v.deploy.dirty_files).toBe(1);
    expect(v.deploy.pending_commit_count).toBe(2);
    expect(v.deploy.diffstat_summary).toContain("2 files changed");
    expect(v.deploy.container_status).toBe("Up 2 hours");
  });

  it("an unopened deploy tab is reported as not loaded, never as 'nothing to ship'", () => {
    const v = buildTuiView({ now: NOW, tab: "board", snapshot: snap() });
    expect(v.deploy.loaded).toBe(false);
    // Not `0`: that IS "nothing to ship" — the very claim the test's name
    // forbids, published to the companion as a number.
    expect(v.deploy.pending_commit_count).toBeNull();
    expect(deployAnswer(publish(v), NOW)).toContain("has not loaded");
  });

  it("summarises the board without copying it: counts by state, closed PRs excluded", () => {
    const v = buildTuiView({
      now: NOW,
      tab: "board",
      snapshot: snap(),
      health: { kind: "ok", heartbeatAgeS: 4 },
    });
    expect(v.board.total).toBe(2);
    expect(v.board.by_state).toEqual({ reviewing: 1, queued: 1, closed: 1 });
    expect(v.board.health).toBe("ok");
    expect(v.board.health_stale_s).toBe(4);
    expect(v.board.dry_run).toBe(false);
    // The projection stays small — the whole point of not widening snapshot.json.
    expect(JSON.stringify(v).length).toBeLessThan(4000);
  });

  it("publishes pipeline health and stable cause keys to the companion view", () => {
    const pipeline: NonNullable<StatusSnapshot["pipeline"]> = {
      healthy: false,
      failed_loud: 1,
      causes: [
        {
          key: "review-failure:cmd-1",
          pr: 5408,
          since: "2026-08-25T09:55:00Z",
          stage: "command_start",
          detail: "no start",
          next_action: "operator_unwedge",
        },
      ],
      recoveries: [
        {
          key: "review-failure:cmd-0",
          pr: 5407,
          recovered_at: "2026-08-25T09:59:00Z",
          recovery: "operator-rerun",
        },
      ],
    };
    const v = buildTuiView({
      now: NOW,
      tab: "board",
      snapshot: snap({ pipeline }),
      health: { kind: "pipeline_unhealthy", heartbeatAgeS: 4 },
    });
    expect(v.board.pipeline_healthy).toBe(false);
    expect(v.board.pipeline_causes).toEqual([{ key: "review-failure:cmd-1", pr: 5408 }]);
    expect(v.board.pipeline_recoveries).toEqual([{ key: "review-failure:cmd-0", pr: 5407 }]);
  });

  it("an unreachable daemon reports its kind and no bogus age", () => {
    const v = buildTuiView({
      now: NOW,
      tab: "board",
      health: { kind: "unreachable", sinceS: Number.POSITIVE_INFINITY },
    });
    expect(v.board.health).toBe("unreachable");
    expect(v.board.health_stale_s).toBeUndefined();
  });

  it("carries the selected row — the shared referent when he says 'this one'", () => {
    const v = buildTuiView({
      now: NOW,
      tab: "board",
      snapshot: snap(),
      selectedPr: 5013,
      panePr: 5013,
      paneFocused: true,
    });
    expect(v.selected).toMatchObject({
      number: 5013,
      title: "another",
      state: "queued",
      stale_recheck: true,
    });
    expect(v.pane).toEqual({ pr: 5013, focused: true });
  });

  it("a selection the snapshot no longer carries is still named, not silently dropped", () => {
    const v = buildTuiView({ now: NOW, tab: "board", snapshot: snap(), selectedPr: 9999 });
    expect(v.selected).toEqual({ number: 9999 });
  });
});

// The second half of the honest-unknown rule, at the surface where it costs
// most: this object is handed to a model that repeats it to the operator in
// prose. A dropped key renders as nothing, and nothing reads as "nothing to
// report", so an ssh that never answered would become a VM with no deployed
// commit.
// The deliverable is the RENDERED line, so the tests below read what the
// `tui_deploy` tool actually says.
describe("a failed read reaches the companion as UNKNOWN, never as an absent line", () => {
  // The deploy tab loaded, but the VM never answered and local git failed:
  // every one of these is a fact the TUI tried to fetch and could not.
  const UNREAD = {
    loaded: true,
    deployed: undefined,
    head: undefined,
    dirty: undefined,
    containerStatus: undefined,
  };

  it("publishes null for each unread field — never a dropped key", () => {
    const v = buildTuiView({ now: NOW, tab: "deploy", deploy: UNREAD });
    expect(v.deploy.deployed).toBeNull();
    expect(v.deploy.head).toBeNull();
    expect(v.deploy.container_status).toBeNull();
    // Serialised, the keys survive — `undefined` would have vanished here.
    expect(Object.keys(JSON.parse(JSON.stringify(v.deploy)) as object)).toEqual(
      expect.arrayContaining(["deployed", "head", "container_status"]),
    );
  });

  it("…and tui_deploy RENDERS each as an explicit UNKNOWN — the line the companion actually reads", () => {
    const answer = deployAnswer(
      publish(buildTuiView({ now: NOW, tab: "deploy", deploy: UNREAD })),
      NOW,
    );
    expect(answer).toContain("VM is running: UNKNOWN");
    expect(answer).toContain("local HEAD: UNKNOWN");
    expect(answer).toContain("container: UNKNOWN");
    expect(answer).not.toMatch(/never deployed|no container/);
    // An uncompared config home is UNKNOWN too — never "deployed".
    expect(v_configHome(UNREAD)).toBeNull();
    expect(answer).toContain("config home vs the VM: UNKNOWN");
  });

  it("publishes the tab's config-home sentence — the same words the tab paints", () => {
    const fpA = { config: "a".repeat(64), profiles: "b".repeat(64) };
    const fpB = { config: "a".repeat(64), profiles: "c".repeat(64) };
    const changed = { ...DEPLOY, configLocal: fpB, configDeployed: fpA };
    expect(v_configHome(changed)).toBe("profile changed, not deployed");
    const answer = deployAnswer(
      publish(buildTuiView({ now: NOW, tab: "deploy", deploy: changed })),
      NOW,
    );
    expect(answer).toContain("config home vs the VM: profile changed, not deployed");
    // one end unread → null, whichever end it is
    expect(v_configHome({ ...DEPLOY, configLocal: fpA })).toBeNull();
    expect(v_configHome({ ...DEPLOY, configDeployed: fpA })).toBeNull();
    expect(v_configHome({ ...DEPLOY, configLocal: fpA, configDeployed: "unparseable" })).toBeNull();
    expect(v_configHome({ ...DEPLOY, configLocal: fpA, configDeployed: fpA })).toContain(
      "config home deployed",
    );
  });

  it("genuine absence is its own sentence: a VM with no marker, a container docker does not list", () => {
    const v = buildTuiView({
      now: NOW,
      tab: "deploy",
      deploy: { loaded: true, deployed: "absent", head: "bbb2222", dirty: [], containerStatus: "" },
    });
    expect(v.deploy.deployed).toBe("absent");
    expect(v.deploy.container_status).toBe("");
    const answer = deployAnswer(publish(v), NOW);
    expect(answer).toContain("never deployed to it");
    expect(answer).toContain("docker lists no container");
    expect(answer).not.toMatch(/VM is running: UNKNOWN|local HEAD: UNKNOWN|container: UNKNOWN/);
    // (With no marker there is nothing to diff against, so the pending count
    // is honestly unknown.)
  });

  it("a marker the TUI read but could not parse is its own sentence — not 'never deployed', not 'could not read'", () => {
    const v = buildTuiView({
      now: NOW,
      tab: "deploy",
      deploy: {
        loaded: true,
        deployed: "unparseable",
        head: "bbb2222",
        dirty: [],
        containerStatus: "Up 2 hours",
      },
    });
    expect(v.deploy.deployed).toBe("unparseable");
    const answer = deployAnswer(publish(v), NOW);
    expect(answer).toContain("VM is running: UNKNOWN");
    expect(answer).toContain("corrupt marker");
    expect(answer).not.toContain("never deployed");
    expect(answer).not.toContain("VM is running: UNKNOWN (the TUI has not been able to read this)");
    // (No sha to diff against, so the pending count is honestly UNKNOWN.)
  });

  it("the renderer holds the line on its own: a loaded view.json missing the keys entirely still says UNKNOWN", () => {
    writeFileSync(
      join(dir, "view.json"),
      JSON.stringify({
        written_at: NOW.toISOString(),
        deploy: { loaded: true, dirty_files: 0, pending_commits: [], pending_commit_count: 0 },
      }),
    );
    const answer = deployAnswer(dir, NOW);
    expect(answer).toContain("VM is running: UNKNOWN");
    expect(answer).toContain("local HEAD: UNKNOWN");
    expect(answer).toContain("container: UNKNOWN");
  });
});

describe("clampScreen — plain text, never escape sequences", () => {
  it("strips SGR, OSC-8 hyperlinks and stray control bytes; keeps newlines", () => {
    const painted = "[1;32mgreen[0m\n]8;;https://xlink]8;;\nbell";
    const { body, truncated } = clampScreen(painted);
    expect(body).toBe("green\nlink\nbell");
    expect(body).not.toMatch(//);
    expect(truncated).toBe(false);
  });

  it("bounds an absurd frame rather than handing over an unbounded read", () => {
    const { body, truncated } = clampScreen("x".repeat(SCREEN_MAX_CHARS + 500));
    expect(truncated).toBe(true);
    expect(body.length).toBeLessThan(SCREEN_MAX_CHARS + 100);
    expect(body).toContain("truncated");
  });
});

describe("FeedWriter.writeView", () => {
  it("writes screen.txt + view.json atomically, leaving no .tmp behind", () => {
    const w = new FeedWriter(dir);
    const v = buildTuiView({
      now: NOW,
      tab: "board",
      snapshot: snap(),
      deploy: DEPLOY,
      screen: "[1mBOARD[0m\nrow",
    });
    expect(w.writeView(v, "[1mBOARD[0m\nrow", 1_000)).toBe(true);
    expect(readFileSync(w.screenPath, "utf8")).toBe("BOARD\nrow");
    expect((JSON.parse(readFileSync(w.viewPath, "utf8")) as TuiView).deploy.deployed).toMatchObject(
      { sha: "aaa1111" },
    );
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("throttles bursts of repaints, then writes again once the window passes", () => {
    const w = new FeedWriter(dir);
    const v = buildTuiView({ now: NOW, tab: "board" });
    expect(w.writeView(v, "one", 1_000)).toBe(true);
    expect(w.writeView(v, "two", 1_000 + VIEW_MIN_INTERVAL_MS - 1)).toBe(false);
    expect(readFileSync(w.screenPath, "utf8")).toBe("one");
    expect(w.writeView(v, "two", 1_000 + VIEW_MIN_INTERVAL_MS)).toBe(true);
    expect(readFileSync(w.screenPath, "utf8")).toBe("two");
  });

  it("a tab with no composed frame leaves the last screen alone rather than blanking it", () => {
    const w = new FeedWriter(dir);
    const v = buildTuiView({ now: NOW, tab: "board" });
    w.writeView(v, "painted", 1_000);
    w.writeView(v, undefined, 9_000);
    expect(readFileSync(w.screenPath, "utf8")).toBe("painted");
  });

  it("publishes files only — nothing here can inject a companion chat turn", () => {
    const w = new FeedWriter(dir);
    w.writeView(buildTuiView({ now: NOW, tab: "board" }), "x", 1_000);
    // No wake marker under any name: the feed is files only.
    expect(readdirSync(dir).sort()).toEqual(["screen.txt", "view.json"]);
  });
});

describe("App.screenText / afterRepaint", () => {
  function harness(cols = 80, rows = 12) {
    const out = new EventEmitter() as unknown as NodeJS.WriteStream;
    (out as unknown as { columns: number }).columns = cols;
    (out as unknown as { rows: number }).rows = rows;
    out.write = (() => true) as never;
    const input = new EventEmitter() as unknown as NodeJS.ReadStream;
    (input as unknown as { isTTY: boolean }).isTTY = false;
    input.resume = (() => input) as never;
    input.pause = (() => input) as never;
    const app = new App(
      TUI_DEFAULTS,
      async () => ({ ok: true, stdout: "", stderr: "", code: 0 }),
      out,
      input,
    );
    return { app, running: app.run() };
  }

  it("returns the whole last painted frame as plain text — what is on screen, no escapes", async () => {
    const h = harness();
    h.app.view.snapshot = snap();
    h.app.repaint();
    const text = h.app.screenText();
    expect(text).toBeDefined();
    expect(text).not.toMatch(//);
    expect(text).toContain("5012");
    h.app.quit();
    await h.running;
  });

  it("fires afterRepaint on every repaint, and a publisher that throws never breaks the paint", async () => {
    const h = harness();
    let fired = 0;
    h.app.afterRepaint = () => {
      fired++;
      throw new Error("publisher exploded");
    };
    expect(() => h.app.repaint()).not.toThrow();
    expect(fired).toBeGreaterThan(0);
    h.app.quit();
    await h.running;
  });
});

// ---- half 2: the tools ------------------------------------------------------

/** Publish a view (and optional screen) into the temp feed dir, as the TUI would. */
function publish(view: TuiView, screen?: string): string {
  writeFileSync(join(dir, "view.json"), JSON.stringify(view, null, 2));
  if (screen !== undefined) writeFileSync(join(dir, "screen.txt"), screen);
  return dir;
}

describe("tui_* tools — the read surface", () => {
  it("registers exactly three read verbs, none of which takes a parameter", () => {
    const defs = toolDefinitions(dir, () => NOW);
    expect(defs.map((d) => d.name)).toEqual([...TOOL_NAMES]);
    for (const d of defs) {
      expect(d.name.startsWith("tui_")).toBe(true);
      // No parameter means no host to name, no command to pass, no path to
      // traverse. The fence is in the schema, not only in the prose.
      expect(d.parameters).toMatchObject({ type: "object", properties: {} });
      expect(Object.keys((d.parameters as { properties: object }).properties)).toEqual([]);
      expect(d.description).toContain("Read-only");
    }
  });

  it("tui_screen hands back exactly what is on screen", () => {
    const v = buildTuiView({ now: NOW, tab: "board", screen: "BOARD\n  #5012 reviewing" });
    const answer = screenAnswer(publish(v, "BOARD\n  #5012 reviewing"), NOW);
    expect(answer).toContain("BOARD");
    expect(answer).toContain("#5012 reviewing");
    expect(answer).toContain("Live — as of");
  });

  it("tui_deploy answers the question the whole ticket started from", () => {
    const answer = deployAnswer(
      publish(buildTuiView({ now: NOW, tab: "deploy", deploy: DEPLOY })),
      NOW,
    );
    expect(answer).toContain("VM is running: aaa1111");
    expect(answer).toContain("local HEAD: bbb2222");
    expect(answer).toContain("commits waiting to ship: 2");
    expect(answer).toContain("ccc3333 and another");
  });

  it("tui_board summarises without dumping the board", () => {
    const v = buildTuiView({
      now: NOW,
      tab: "board",
      snapshot: snap(),
      selectedPr: 5012,
      health: { kind: "ok", heartbeatAgeS: 2 },
    });
    const answer = boardAnswer(publish(v), NOW);
    expect(answer).toContain("daemon health: ok");
    expect(answer).toContain("open PRs: 2");
    expect(answer).toContain("5012");
    expect(answer).toContain("snapshot.json");
  });

  it("a stale view SAYS it is stale instead of presenting old state as current", () => {
    const v = buildTuiView({ now: NOW, tab: "board", deploy: DEPLOY });
    const later = new Date(NOW.getTime() + STALE_AFTER_MS + 60_000);
    const answer = deployAnswer(publish(v), later);
    expect(answer.startsWith("STALE")).toBe(true);
    expect(answer).toContain("The TUI is closed");
    // …and it still reports what it has, rather than refusing.
    expect(answer).toContain("aaa1111");
  });

  it("an unknown age is reported as possibly stale, never as fresh", () => {
    expect(freshness(undefined, NOW)).toContain("Age unknown");
    expect(freshness("not-a-date", NOW)).toContain("Age unknown");
    expect(freshness(NOW.toISOString(), NOW)).toContain("Live");
  });

  it("no published view = 'the TUI is not running, and I cannot fetch it'", () => {
    const missing = readFeedFile(dir, "view.json");
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain("cannot fetch");
    expect(screenAnswer(dir, NOW)).toContain("cannot fetch");
    expect(deployAnswer(dir, NOW)).toContain("cannot fetch");
  });

  it("a torn view.json is an honest refusal, not a crash", () => {
    writeFileSync(join(dir, "view.json"), "{ not json");
    expect(() => boardAnswer(dir, NOW)).not.toThrow();
    expect(boardAnswer(dir, NOW)).toContain("unreadable");
  });

  it("resolves the feed dir from QCR_FEED_DIR, the var the companion is spawned with", () => {
    expect(resolveFeedDir({ QCR_FEED_DIR: "/feed" } as NodeJS.ProcessEnv)).toBe("/feed");
    expect(resolveFeedDir({ QCR_ROOT: "/workspace" } as NodeJS.ProcessEnv)).toBe(
      "/workspace/state/companion/feed",
    );
  });

  it("registers through pi, and degrades to registering nothing when registerTool is absent", () => {
    const registered: PiToolDefinition[] = [];
    const pi = {
      on: () => {},
      sendUserMessage: () => {},
      registerTool: (d: PiToolDefinition) => registered.push(d),
    } as unknown as Pi;
    activate(pi, { QCR_FEED_DIR: dir } as NodeJS.ProcessEnv);
    expect(registered.map((d) => d.name)).toEqual([...TOOL_NAMES]);
    // A pi without the API must leave the companion starting, not wedged.
    expect(() =>
      activate(
        { on: () => {}, sendUserMessage: () => {} } as unknown as Pi,
        {} as NodeJS.ProcessEnv,
      ),
    ).not.toThrow();
  });
});

// ---- the boundary (root CLAUDE.md rule 8) -----------------------------------

describe("the tools read already-fetched state and can NEVER become a fetcher", () => {
  const source = readFileSync(new URL("../extensions/tui-view.ts", import.meta.url), "utf8");
  /** The forbidden-token checks run against CODE, not prose: the header
   * comment names the very things it forbids (that is the point of it). */
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

  it("imports nothing that could reach the VM, the network, or a subprocess", () => {
    // The TUI's own reach is real (ssh to the VM, deploy.sh sync). The
    // companion holds no VM credential, so a `tui_*` tool that could trigger a
    // fetch would launder the operator's access through a read verb.
    for (const forbidden of [
      "node:child_process",
      "node:net",
      "node:http",
      "node:https",
      "node:dgram",
      "node:worker_threads",
    ]) {
      expect(code).not.toContain(forbidden);
    }
    for (const forbidden of [
      "remote.js",
      "../src/",
      "ssh",
      "execFile",
      "spawn(",
      "fetch(",
      "createConnection",
      "require(",
    ]) {
      expect(code).not.toContain(forbidden);
    }
    const imports = [...code.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["@earendil-works/pi-coding-agent", "node:fs", "node:path"]);
  });

  it("touches the filesystem only to READ two fixed filenames — it never writes", () => {
    for (const forbidden of [
      "writeFileSync",
      "appendFileSync",
      "mkdirSync",
      "rmSync",
      "renameSync",
      "unlinkSync",
      "createWriteStream",
    ]) {
      expect(code).not.toContain(forbidden);
    }
    // No traversal: the filenames are constants, never assembled from input.
    const defs = toolDefinitions(dir, () => NOW);
    for (const d of defs)
      expect(Object.keys((d.parameters as { properties: object }).properties)).toEqual([]);
  });

  it("answers a missing/stale file rather than refreshing it — staleness is information, a refresh would be reach", () => {
    const v = buildTuiView({ now: NOW, tab: "board", deploy: DEPLOY });
    const before = readdirSync(publish(v)).sort();
    deployAnswer(dir, new Date(NOW.getTime() + 10 * 60_000));
    screenAnswer(dir, NOW);
    boardAnswer(dir, NOW);
    // Reading changed nothing on disk: no request file, no marker, no channel.
    expect(readdirSync(dir).sort()).toEqual(before);
  });

  it("the companion is spawned with the extension, pointed at the feed dir it can read", () => {
    const pi = new CompanionLifecycle(
      {
        container_name: "qcr-companion",
        session: "companion",
        model: "openai-codex/gpt-5.6-sol",
        repo_dir: "/repo",
      } as never,
      async () => ({ ok: true, stdout: "", stderr: "", code: 0 }),
      {},
      // 4th parameter is `ensureDirs`, NOT the fs seam. Passing the seam in
      // this slot would leave `fs` on its real-filesystem default and read the
      // host's disk instead of the injected stub — not hermetic on a machine
      // where the fixture paths exist.
      () => {},
      { exists: () => false, read: () => undefined, mode: () => undefined },
    );
    expect(pi.piArgv()).toContain("/workspace/extensions/tui-view.ts");
    expect(pi.piEnvPrefix().some((v) => v.startsWith("QCR_FEED_DIR="))).toBe(true);
  });
});
