// Deploy tab — argv construction, BUILD_SHA parsing, the pure line renderer,
// and key routing. All runners are fakes; nothing spawns, nothing sshes.
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RELEASE_IMAGE_REPO } from "../src/onboard/steps/compose.js";
import { TUI_DEFAULTS } from "../src/config.js";
import { App } from "../src/tui/app.js";
import {
  CONFIG_FINGERPRINT_ARGV,
  DIRTY_ARGV,
  HEAD_ARGV,
  PUBLISHED_VERSIONS_ARGV,
  RealDeployFetcher,
  UPDATE_STATUS_ARGV,
  configFingerprintArgv,
  deployKeys,
  deployLines,
  diffStatArgv,
  installDeployHooks,
  logArgv,
  parseBuildSha,
  parsePublishedVersions,
  parseUpdateStatus,
  planArgv,
  releasePackage,
  renderDeployTab,
  versionRevArgv,
  type DeployDrainSender,
  type DeployState,
  type LocalRunner,
} from "../src/tui/deploytab.js";
import { stripAnsi } from "../src/tui/paint.js";
import { layoutProbeArgv, resetLayoutCache } from "../src/tui/layout.js";
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

const RELEASE_REPORT = JSON.stringify({
  layout: "release",
  daemon: { container: "quickreview-sandbox", build_sha: "aaa1111", layout: "release" },
  drain: { draining: null, running_rounds: null },
  last_run: {
    version: "1.0.0",
    at: "2026-08-14T12:00:00Z",
    result: "ok",
    step: "done",
    detail: "",
  },
});

describe("deploy tab argv + parsing", () => {
  it("builds read-only local git argvs between the two revisions", () => {
    expect(logArgv("abc1234", "def5678")).toEqual(["git", "log", "--oneline", "abc1234..def5678"]);
    expect(diffStatArgv("abc1234", "def5678")).toEqual([
      "git",
      "diff",
      "--stat",
      "abc1234..def5678",
    ]);
    expect(HEAD_ARGV).toContain("rev-parse");
    expect(DIRTY_ARGV).toContain("--porcelain");
    expect(versionRevArgv("1.2.3")).toEqual(["git", "rev-parse", "--short", "v1.2.3^{commit}"]);
  });

  it("the plan is deploy.sh's own --dry-run release <version>, never sync or rebuild", () => {
    expect(planArgv("1.2.3")).toEqual([
      "bash",
      "scripts/deploy.sh",
      "--dry-run",
      "release",
      "1.2.3",
    ]);
    expect(planArgv("1.2.3-rc.1").slice(-2)).toEqual(["release", "1.2.3-rc.1"]);
  });

  it("asks the updater for the VM's version and revision, read-only, over ssh", () => {
    expect(UPDATE_STATUS_ARGV).toEqual(["sudo", "qcr-update", "status", "--json"]);
    expect(parseUpdateStatus(RELEASE_REPORT)).toEqual({
      layout: "release",
      revision: "aaa1111",
      version: "1.0.0",
      at: "2026-08-14T12:00:00Z",
    });
    // a last run that did not finish ok says nothing about the running version
    const failed = JSON.parse(RELEASE_REPORT);
    failed.last_run.result = "rescued";
    expect(parseUpdateStatus(JSON.stringify(failed))).toEqual({
      layout: "release",
      revision: "aaa1111",
    });
    expect(parseUpdateStatus('{"layout":"legacy","daemon":null,"last_run":null}')).toEqual({
      layout: "legacy",
    });
    expect(parseUpdateStatus("not json")).toBeUndefined();
    expect(parseUpdateStatus('{"layout":"weird"}')).toBeUndefined();
    expect(parseUpdateStatus("[]")).toBeUndefined();
  });

  it("lists published versions from a read-only gh api call, newest first, tags only", () => {
    expect(PUBLISHED_VERSIONS_ARGV.slice(0, 2)).toEqual(["gh", "api"]);
    const { org, name } = releasePackage(RELEASE_IMAGE_REPO);
    expect(org).not.toBe("");
    expect(name).not.toBe("");
    expect(PUBLISHED_VERSIONS_ARGV.join(" ")).toContain(
      `orgs/${org}/packages/container/${name}/versions`,
    );
    // the package is the daemon image's repository, not a second spelling of it
    expect(RELEASE_IMAGE_REPO).toBe(`ghcr.io/${org}/${name}`);
    // no verb that mutates
    expect(PUBLISHED_VERSIONS_ARGV).not.toContain("-X");
    expect(PUBLISHED_VERSIONS_ARGV).not.toContain("--method");
    expect(
      parsePublishedVersions("latest\n1.2.3\n1.10.0\n1.2.3\nsha256-abc\n1.2.3-rc.1\n0.9.9\n"),
    ).toEqual(["1.10.0", "1.2.3", "1.2.3-rc.1", "0.9.9"]);
    expect(parsePublishedVersions("")).toEqual([]);
  });

  it("orders prereleases by semver precedence: numeric identifiers numerically, before alphanumeric ones", () => {
    expect(
      parsePublishedVersions("1.2.3-rc.9\n1.2.3-rc.10\n1.2.3-rc.2\n1.2.3-alpha\n1.2.3-alpha.1\n1.2.3-1\n1.2.3\n"),
    ).toEqual([
      "1.2.3",
      "1.2.3-rc.10",
      "1.2.3-rc.9",
      "1.2.3-rc.2",
      "1.2.3-alpha.1",
      "1.2.3-alpha",
      "1.2.3-1",
    ]);
  });

  it("the finished-deploy bar does not offer to close a log that awaiting-lift keeps open", () => {
    const run = { kind: "deploy", running: false, code: 0, lines: [] } as unknown as DeployState["run"];
    const awaiting = deployKeys(emptyState({ run, deployPhase: "awaiting-lift" })).bar;
    expect(awaiting.map((b) => b.key)).toEqual(["x"]);
    expect(awaiting[0]!.label).not.toContain("close log");
    expect(deployKeys(emptyState({ run })).bar[0]!.label).toContain("close log");
  });

  it("the plan view clamps its scroll to the last page instead of painting blank", () => {
    const at = (scroll: number): string =>
      stripAnsi(renderDeployTab(emptyState({ scroll }), false, 100, 60).render());
    const top = at(0);
    expect(at(9999)).toBe(top);
  });

  it("parses the bare CI build stamp `qcr metrics` reads, and rejects garbage", () => {
    const full = "0123456789abcdef0123456789abcdef01234567";
    expect(parseBuildSha(`${full}\n`)).toEqual({ sha: full, at: undefined, mode: undefined });
    expect(parseBuildSha("unstamped\n")).toBeUndefined();
    expect(parseBuildSha("")).toBeUndefined();
  });

  it("no deploy argv anywhere in the deploy surface spells sync or rebuild", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const files = [
      "../src/tui/deploytab.ts",
      "../src/tui/deploy-process.ts",
      "../scripts/tui-deploy-runner.mjs",
      "../src/onboard/steps/deploysh.ts",
      "../src/onboard/steps/vmdeploy.ts",
      "../src/onboard/steps/transport.ts",
    ];
    for (const rel of files) {
      const text = readFileSync(join(here, rel), "utf8");
      // an argv/command spelling: deploy.sh followed by a gone verb, or a gone verb as a mode literal
      expect(text, rel).not.toMatch(/deploy\.sh["',\s\]]+(--dry-run["',\s]+)?(sync|rebuild)\b/);
      expect(text, rel).not.toMatch(/(deployCommandLine|deployArgv)\([^)]*"(sync|rebuild)"/);
      expect(text, rel).not.toMatch(/deploymentMode[^\n]*"(sync|rebuild)"/);
    }
  });
});

describe("RealDeployFetcher", () => {
  const PLAN_121 = planArgv("1.2.1").join(" ");
  function fetcherWith(
    report: RemoteResult,
    local: Record<string, RemoteResult>,
    published = "1.2.1\n1.0.0\n",
  ) {
    const localCalls: string[][] = [];
    const localRunner: LocalRunner = async (argv) => {
      localCalls.push(argv);
      if (argv.join(" ") === PUBLISHED_VERSIONS_ARGV.join(" ")) return ok(published);
      return local[argv.join(" ")] ?? fail();
    };
    const sshCalls: string[][] = [];
    const f = new RealDeployFetcher(
      TUI_DEFAULTS,
      async (_h, argv) => {
        sshCalls.push(argv);
        return argv.join(" ") === UPDATE_STATUS_ARGV.join(" ") ? report : ok("");
      },
      localRunner,
    );
    return { f, localCalls, sshCalls };
  }

  it("addresses the config fingerprint at the resolved container root, probing the layout first", async () => {
    resetLayoutCache();
    try {
      const sshCalls: string[] = [];
      const f = new RealDeployFetcher(
        TUI_DEFAULTS,
        async (_h, argv) => {
          sshCalls.push(argv.join(" "));
          if (argv.join(" ") === layoutProbeArgv(TUI_DEFAULTS).join(" "))
            return ok("0123456789abcdef release\n");
          return ok("");
        },
        async () => fail(),
      );
      await f.load();
      const fp = sshCalls.find((c) => c.includes("config-fingerprint.sh"))!;
      expect(fp).toContain("/opt/qcr/scripts/config-fingerprint.sh");
      expect(fp).not.toContain("/opt/quickreview/sandbox");
    } finally {
      resetLayoutCache();
    }
  });

  it("shows the running version and revision against the newest published version, with the commits between", async () => {
    const { f, sshCalls } = fetcherWith(ok(RELEASE_REPORT), {
      [HEAD_ARGV.join(" ")]: ok("bbb2222\n"),
      [DIRTY_ARGV.join(" ")]: ok(""),
      [PLAN_121]: ok("plan — deploy.sh release 1.2.1\n"),
      [versionRevArgv("1.2.1").join(" ")]: ok("ccc3333\n"),
      [logArgv("aaa1111", "ccc3333").join(" ")]: ok("ccc3333 fix the thing\n"),
      [diffStatArgv("aaa1111", "ccc3333").join(" ")]: ok(" src/x.ts | 2 +-\n"),
    });
    const st = await f.load();
    expect(sshCalls.some((c) => c.join(" ") === UPDATE_STATUS_ARGV.join(" "))).toBe(true);
    expect(st.layout).toBe("release");
    expect(st.deployed).toEqual({ sha: "aaa1111", version: "1.0.0", at: "2026-08-14T12:00:00Z" });
    expect(st.versions).toEqual(["1.2.1", "1.0.0"]);
    expect(st.version).toBe("1.2.1");
    expect(st.versionRev).toBe("ccc3333");
    expect(st.commits).toEqual(["ccc3333 fix the thing"]);
    expect(st.diffstat).toEqual([" src/x.ts | 2 +-"]);
    expect(st.plan.join("\n")).toContain("deploy.sh release 1.2.1");
  });

  it("a typed version beats the newest published one, and is not required to be published", async () => {
    const { f, localCalls } = fetcherWith(ok(RELEASE_REPORT), {
      [HEAD_ARGV.join(" ")]: ok("bbb2222\n"),
      [DIRTY_ARGV.join(" ")]: ok(""),
      [planArgv("9.9.9").join(" ")]: ok("plan 9.9.9\n"),
    });
    const st = await f.load("9.9.9");
    expect(st.version).toBe("9.9.9");
    expect(localCalls.some((c) => c.join(" ") === planArgv("9.9.9").join(" "))).toBe(true);
    // its tag is not in the checkout: the commits are unknown, not zero
    expect(st.versionRev).toBeUndefined();
    expect(st.commits).toBeUndefined();
  });

  it("an unreadable published listing leaves a typed version working and the list unknown", async () => {
    const localRunner: LocalRunner = async (argv) =>
      argv[0] === "gh" ? fail("gh: not logged in") : ok("");
    const f = new RealDeployFetcher(TUI_DEFAULTS, async () => ok(RELEASE_REPORT), localRunner);
    const none = await f.load();
    expect(none.versions).toBeUndefined();
    expect(none.version).toBeUndefined();
    expect(none.plan.join("\n")).toContain("no version chosen");
    const typed = await f.load("1.4.0");
    expect(typed.version).toBe("1.4.0");
  });

  it("a version that is not a release spelling never reaches deploy.sh", async () => {
    const { f, localCalls } = fetcherWith(ok(RELEASE_REPORT), {});
    const st = await f.load("latest; rm -rf /");
    expect(st.plan.join("\n")).toContain("is not a release version");
    expect(localCalls.some((c) => c.includes("deploy.sh"))).toBe(false);
  });

  it("the legacy layout is read as legacy: no release to show, no commit list", async () => {
    const { f, localCalls } = fetcherWith(
      ok('{"layout":"legacy","daemon":{"build_sha":"","layout":""},"last_run":null}'),
      {
        [PLAN_121]: ok("plan\n"),
        [versionRevArgv("1.2.1").join(" ")]: ok("ccc3333\n"),
      },
    );
    const st = await f.load();
    expect(st.layout).toBe("legacy");
    expect(st.deployed).toBe("absent");
    expect(st.commits).toBeUndefined();
    expect(localCalls.some((c) => c.includes("log"))).toBe(false);
  });

  it("an ssh that never answered is NOT a VM with no release", async () => {
    const localCalls: string[][] = [];
    const f = new RealDeployFetcher(
      TUI_DEFAULTS,
      async () => fail("ssh: connect timed out"),
      async (argv) => {
        localCalls.push(argv);
        return argv[0] === "gh" ? ok("1.2.1\n") : ok("");
      },
    );
    const st = await f.load();
    expect(st.deployed).toBeUndefined();
    expect(st.layout).toBeUndefined();
    expect(st.containerStatus).toBeUndefined();
    expect(localCalls.some((c) => c.includes("log"))).toBe(false);
  });

  // The read SUCCEEDED here — the content is the problem — so it is neither a
  // VM with no release nor an ssh failure, and neither of those sentences is true.
  it("a report that is read but is not the updater's is unparseable — not absent, not unread", async () => {
    const { f } = fetcherWith(ok("sudo: qcr-update: command not found\n"), {});
    const st = await f.load();
    expect(st.deployed).toBe("unparseable");
    expect(st.layout).toBeUndefined();
  });

  it("a range read that fails replaces the previous load's commits and diffstat", async () => {
    const results: Record<string, RemoteResult> = {
      [HEAD_ARGV.join(" ")]: ok("bbb2222\n"),
      [DIRTY_ARGV.join(" ")]: ok(""),
      [PLAN_121]: ok("plan\n"),
      [versionRevArgv("1.2.1").join(" ")]: ok("ccc3333\n"),
      [logArgv("aaa1111", "ccc3333").join(" ")]: ok("ccc3333 fix the thing\n"),
      [diffStatArgv("aaa1111", "ccc3333").join(" ")]: ok(" src/x.ts | 2 +-\n"),
    };
    const { f } = fetcherWith(ok(RELEASE_REPORT), results);
    const st: Partial<DeployState> = {};
    Object.assign(st, await f.load());
    expect(st.commits).toEqual(["ccc3333 fix the thing"]);
    delete results[logArgv("aaa1111", "ccc3333").join(" ")];
    delete results[diffStatArgv("aaa1111", "ccc3333").join(" ")];
    // The tab merges every load over the last one (Object.assign).
    Object.assign(st, await f.load());
    expect(st.commits).toBeUndefined();
    expect(st.diffstat).toBeUndefined();
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
          emptyState({
            deployed: { sha: "aaa1111", version: "1.2.1" },
            version: "1.2.1",
            layout: "release",
            commits: [],
            ...over,
          }),
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
  it("says nothing-to-deploy when the VM already runs the chosen version", () => {
    const text = stripAnsi(
      deployLines(
        emptyState({
          deployed: { sha: "aaa1111", version: "1.2.1" },
          version: "1.2.1",
          versions: ["1.2.1"],
          layout: "release",
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
    expect(text).toContain("./scripts/deploy.sh release 1.2.1");
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
      deployed: { sha: "aaa1111", at: "2026-08-14T12:00:00Z", version: "1.0.0" },
      version: "1.2.1",
      versionRev: "ccc3333",
      layout: "release",
      head: "ccc3333",
      dirty: ["?? notes.txt"],
      commits: ["ccc3333 tui deploy tab", "bbb2222 fix dispatch"],
      diffstat: [" 2 files changed"],
      plan: ["plan — deploy.sh release 1.2.1"],
    });
    const text = stripAnsi(deployLines(st, 90).join("\n"));
    expect(text).toContain("PENDING (2)");
    expect(text).toContain("ccc3333 tui deploy tab");
    expect(text).toContain("dirty — 1 uncommitted (deploy.sh will refuse)");
    expect(text).toContain("plan — deploy.sh release 1.2.1");
    // the running version and revision against the chosen one
    expect(text).toContain("1.0.0");
    expect(text).toContain("rev aaa1111");
    expect(text).toContain("1.2.1");
    expect(text).toContain("rev ccc3333");
    expect(text).toContain("aaa1111..ccc3333");
  });

  it("renders 'no marker' and 'could not read' as different sentences, and an unread HEAD as unknown", () => {
    const absent = stripAnsi(
      deployLines(emptyState({ deployed: "absent", head: "ccc3333" }), 90).join("\n"),
    );
    expect(absent).toContain("runs no release image yet");
    expect(absent).not.toContain("could not be read");
    const unread = stripAnsi(
      deployLines(emptyState({ deployed: undefined, head: undefined }), 90).join("\n"),
    );
    expect(unread).toContain("could not be read");
    expect(unread).not.toContain("runs no release image yet");
    expect(unread).toContain("HEAD unknown");
    // A corrupt marker was READ — blaming ssh/docker for it would be false.
    const corrupt = stripAnsi(
      deployLines(emptyState({ deployed: "unparseable", head: "ccc3333" }), 160).join("\n"),
    );
    expect(corrupt).toContain("names no build stamp");
    expect(corrupt).not.toContain("could not be read");
    expect(corrupt).not.toContain("runs no release image yet");
    expect(corrupt).not.toContain("nothing to deploy");
  });

  it("flags a deployed sha unknown to local git instead of pretending 0 pending", () => {
    const text = stripAnsi(
      deployLines(
        emptyState({
          deployed: { sha: "deadbee", version: "1.0.0" },
          version: "1.2.1",
          versionRev: "ccc3333",
          layout: "release",
        }),
        90,
      ).join("\n"),
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
      app.hooks.deployRun = (_a, _id, _v, _data, exit) => {
        deploys++;
        exit(0);
        return { kill: () => {} };
      };
      const st = installDeployHooks(
        app,
        {
          load: async () => ({
            dirty: [],
            plan: [],
            head: "abc1234",
            layout: "release" as const,
            version: "1.2.3",
          }),
        },
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
      {
        load: async () => ({
          dirty: [],
          plan: [],
          head: "abc1234",
          layout: "release" as const,
          version: "1.2.3",
        }),
      },
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
    second.hooks.deployRun = (_a, _id, _v, _d, exit) => {
      deploys++;
      exit(0);
      return { kill: () => {} };
    };
    const restored = installDeployHooks(
      second,
      {
        load: async () => ({
          dirty: [],
          plan: [],
          head: "abc1234",
          layout: "release" as const,
          version: "1.2.3",
        }),
      },
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
      target_version: "1.2.3",
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
    app.hooks.deployRun = (_a, _id, _v, _d, exit) => {
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
    for (const finish of finishLoads)
      finish({
        dirty: [],
        plan: [],
        head: "abc1234",
        layout: "release" as const,
        version: "1.2.3",
      });
    await settle();
    // The App's own poll (a fake ssh with no status.json) has since marked the
    // daemon unreachable: a sync never starts without a fresh quiet status.
    expect(app.view.health.kind).toBe("unreachable");
    expect(deploys).toBe(0);
    publishStatus(app, 0);
    expect(finishLoads).toHaveLength(3);
    finishLoads[2]!({
      dirty: [],
      plan: [],
      head: "abc1234",
      layout: "release" as const,
      version: "1.2.3",
    });
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
      {
        load: async () => ({
          dirty: [],
          plan: [],
          head: "abc1234",
          layout: "release" as const,
          version: "1.2.3",
        }),
      },
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
      {
        load: async () => ({
          dirty: [],
          plan: [],
          head: "abc1234",
          layout: "release" as const,
          version: "1.2.3",
        }),
      },
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
      target_version: "1.2.3",
      pre_deploy_snapshot_at: "2026-08-28T12:00:00Z",
      deploy_run_id: "deploy-run-1234",
      updated_at: "2026-08-28T12:00:01Z",
    });
    const streams = fakeStreams();
    const app = new App(TUI_DEFAULTS, async () => ok(""), streams.out, streams.input);
    const attached: string[] = [];
    let finish: ((code: number | null) => void) | undefined;
    app.hooks.deployRun = (_a, runId, _v, _data, onExit) => {
      attached.push(runId);
      finish = onExit;
      return { kill: () => {} };
    };
    const st = installDeployHooks(
      app,
      {
        load: async () => ({
          dirty: [],
          plan: [],
          head: "abc1234",
          layout: "release" as const,
          version: "1.2.3",
        }),
      },
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
      {
        load: async () => ({
          dirty: [],
          plan: [],
          head: "abc1234",
          layout: "release" as const,
          version: "1.2.3",
        }),
      },
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
      {
        load: async () => ({
          dirty: [],
          plan: [],
          head: "abc1234",
          layout: "release" as const,
          version: "1.2.3",
        }),
      },
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
      {
        load: async () => ({
          dirty: [],
          plan: [],
          head: "abc1234",
          layout: "release" as const,
          version: "1.2.3",
        }),
      },
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
      {
        load: async () => ({
          dirty: [],
          plan: [],
          head: "abc1234",
          layout: "release" as const,
          version: "1.2.3",
        }),
      },
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
      {
        load: async () => ({
          dirty: [],
          plan: [],
          head: "abc1234",
          layout: "release" as const,
          version: "1.2.3",
        }),
      },
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
    app.hooks.deployRun = (_a, _id, _v, _data, exit) => {
      exit(1);
      return { kill: () => {} };
    };
    const st = installDeployHooks(
      app,
      {
        load: async () => ({
          dirty: [],
          plan: [],
          head: "abc1234",
          layout: "release" as const,
          version: "1.2.3",
        }),
      },
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
    app.hooks.deployRun = (_a, _id, _v, _d, exit) => {
      deploys++;
      exit(0);
      return { kill: () => {} };
    };
    const pending: Array<(value: any) => void> = [];
    let lazy = true;
    const fetcher = {
      load: () => {
        if (lazy)
          return Promise.resolve({
            dirty: [],
            plan: [],
            head: "abc1234",
            layout: "release" as const,
            version: "1.2.3",
          });
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
    pending[0]!({
      dirty: [],
      plan: [],
      head: "abc1234",
      layout: "release" as const,
      version: "1.2.3",
    });
    await settle();
    expect(deploys).toBe(0);
    expect(st.deployPhase).toBe("waiting-rounds");
    publishStatus(app, 0); // fresh again → preflight again → sync
    expect(pending).toHaveLength(2);
    pending[1]!({
      dirty: [],
      plan: [],
      head: "abc1234",
      layout: "release" as const,
      version: "1.2.3",
    });
    await settle();
    expect(deploys).toBe(1);
    app.quit();
    await run;
  });

  it("r after a failed sync keeps the result on screen so x can still acknowledge it", async () => {
    const store = new MemoryDeployCeremonyStore();
    const streams = fakeStreams();
    const app = new App(TUI_DEFAULTS, async () => ok(""), streams.out, streams.input);
    app.hooks.deployRun = (_a, _id, _v, _data, exit) => {
      exit(1);
      return { kill: () => {} };
    };
    let loads = 0;
    const st = installDeployHooks(
      app,
      {
        load: async () => (
          loads++,
          { dirty: [], plan: [], head: "abc1234", layout: "release" as const, version: "1.2.3" }
        ),
      },
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
        {
          dirty: [],
          plan: ["plan — deploy.sh release 1.2.3"],
          deployed: "absent" as const,
          head: "abc1234",
        }
      ),
    });
    const run = app.run();
    streams.type("5");
    expect(app.tab).toBe("deploy");
    await new Promise((r) => setTimeout(r, 0)); // lazy load settles
    expect(loads).toBe(1);
    expect(stripAnsi(streams.written())).toContain("runs no release image yet");
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
    app.hooks.deployRun = (_a, _id, _v, _onData, onExit) => {
      deploys++;
      onExit(0);
      return { kill: () => {} };
    };
    let clock = 1000;
    const st = installDeployHooks(
      app,
      {
        load: async () => ({
          dirty: [],
          plan: [],
          head: "abc1234",
          layout: "release" as const,
          version: "1.2.3",
        }),
      },
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
    app.hooks.deployRun = (_a, _id, _v, _onData, onExit) => {
      deploys++;
      onExit(0);
      return { kill: () => {} };
    };
    let clock = 1000;
    const st = installDeployHooks(
      app,
      {
        load: async () => ({
          dirty: [],
          plan: [],
          head: "abc1234",
          layout: "release" as const,
          version: "1.2.3",
        }),
      },
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
    app.hooks.deployRun = (_a, _id, _v, onData, onExit) => {
      dataFn = onData;
      exitFn = onExit;
      return { kill: () => {} };
    };
    const clock = 1000;
    const st = installDeployHooks(
      app,
      {
        load: async () => ({
          dirty: [],
          plan: [],
          head: "abc1234",
          layout: "release" as const,
          version: "1.2.3",
        }),
      },
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
    app.hooks.deployRun = (_a, _id, _v, _onData, onExit) => {
      exitFn = onExit;
      return { kill: () => killed++ };
    };
    const st = installDeployHooks(
      app,
      {
        load: async () => ({
          dirty: [],
          plan: [],
          head: "abc1234",
          layout: "release" as const,
          version: "1.2.3",
        }),
      },
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
    app.hooks.deployRun = (_a, _id, _v, _d, onExit) => (onExit(0), { kill: () => {} });
    const st = installDeployHooks(
      app,
      {
        load: async () => ({
          dirty: [],
          plan: [],
          head: "abc1234",
          layout: "release" as const,
          version: "1.2.3",
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

describe("deploy tab version choice and the legacy refusal", () => {
  const loaded = (over: Record<string, unknown> = {}) => ({
    dirty: [],
    plan: [],
    head: "abc1234",
    layout: "release" as const,
    version: "1.2.3",
    versions: ["1.2.3", "1.2.0"],
    ...over,
  });

  it("refuses to arm on a legacy-layout VM and points at the cutover wizard", async () => {
    const streams = fakeStreams();
    const app = new App(TUI_DEFAULTS, async () => ok(""), streams.out, streams.input);
    const drainCalls: boolean[] = [];
    const st = installDeployHooks(
      app,
      { load: async () => loaded({ layout: "legacy" as const, deployed: "absent" as const }) },
      () => 1000,
      { set: async (on) => (drainCalls.push(on), { ok: true, draining: on }) },
    );
    const run = app.run();
    streams.type("5");
    await settle();
    streams.type("D");
    streams.type("D");
    await settle();
    expect(st.armedAt).toBeUndefined();
    expect(st.run).toBeUndefined();
    expect(drainCalls).toEqual([]);
    expect(app.view.noticeLine).toContain("cutover");
    expect(stripAnsi(streams.written())).toContain("scripts/cutover.sh");
    app.quit();
    await run;
  });

  it("refuses on an unread layout: a deploy is not started on a guess", async () => {
    const streams = fakeStreams();
    const app = new App(TUI_DEFAULTS, async () => ok(""), streams.out, streams.input);
    const drainCalls: boolean[] = [];
    const st = installDeployHooks(
      app,
      { load: async () => loaded({ layout: undefined }) },
      () => 1000,
      { set: async (on) => (drainCalls.push(on), { ok: true, draining: on }) },
    );
    const run = app.run();
    streams.type("5");
    await settle();
    streams.type("D");
    streams.type("D");
    await settle();
    expect(st.run).toBeUndefined();
    expect(drainCalls).toEqual([]);
    expect(app.view.noticeLine).toContain("has not been read");
    app.quit();
    await run;
  });

  it("refuses with no version chosen", async () => {
    const streams = fakeStreams();
    const app = new App(TUI_DEFAULTS, async () => ok(""), streams.out, streams.input);
    const st = installDeployHooks(
      app,
      { load: async () => loaded({ version: undefined }) },
      () => 1000,
    );
    const run = app.run();
    streams.type("5");
    await settle();
    streams.type("D");
    expect(st.armedAt).toBeUndefined();
    expect(app.view.noticeLine).toContain("no deploy version chosen");
    app.quit();
    await run;
  });

  it("V prompts for a version, validates it and reloads for it; the release runs with that version", async () => {
    const streams = fakeStreams();
    const app = new App(TUI_DEFAULTS, async () => ok(""), streams.out, streams.input);
    const loadsFor: Array<string | undefined> = [];
    const shipped: string[] = [];
    app.hooks.deployRun = (_a, _id, version, _d, exit) => {
      shipped.push(version);
      exit(0);
      return { kill: () => {} };
    };
    const st = installDeployHooks(
      app,
      {
        load: async (version) => (loadsFor.push(version), loaded({ version: version ?? "1.2.3" })),
      },
      () => 1000,
      quietDrain(),
    );
    const run = app.run();
    streams.type("5");
    await settle();
    expect(loadsFor).toEqual([undefined]);
    expect(deployKeys(st).bar.map((b) => b.key)).toEqual(["D", "V"]);
    streams.type("V");
    expect(app.view.inputBox?.target).toContain("published: 1.2.3 1.2.0");
    // a bad spelling is refused and nothing reloads
    for (const ch of "latest") streams.type(ch);
    streams.type("\r");
    expect(app.view.noticeLine).toContain("not a release version");
    expect(loadsFor).toEqual([undefined]);
    streams.type("V");
    // the prompt starts from the current choice; clear it, then type
    for (let i = 0; i < "1.2.3".length; i++) streams.type("\x7f");
    for (const ch of "v1.4.0") streams.type(ch);
    streams.type("\r");
    await settle();
    expect(st.version).toBe("1.4.0");
    expect(loadsFor).toEqual([undefined, "1.4.0"]);
    streams.type("D");
    streams.type("D");
    await settle();
    publishStatus(app, 0);
    await settle();
    expect(shipped).toEqual(["1.4.0"]);
    app.quit();
    await run;
  });

  it("a version chosen while a load is pending is loaded after it, not overwritten by it", async () => {
    const streams = fakeStreams();
    const app = new App(TUI_DEFAULTS, async () => ok(""), streams.out, streams.input);
    const loadsFor: Array<string | undefined> = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const st = installDeployHooks(
      app,
      {
        load: async (version) => {
          loadsFor.push(version);
          if (loadsFor.length === 1) await gate;
          return loaded({ version: version ?? "1.2.3" });
        },
      },
      () => 1000,
      quietDrain(),
    );
    const run = app.run();
    streams.type("5");
    await settle();
    expect(loadsFor).toEqual([undefined]);
    streams.type("V");
    for (const ch of "1.4.0") streams.type(ch);
    streams.type("\r");
    release();
    await settle();
    expect(st.version).toBe("1.4.0");
    expect(loadsFor).toEqual([undefined, "1.4.0"]);
    app.quit();
    await run;
  });

  it("will not start the release if the chosen version changed while draining", async () => {
    const store = new MemoryDeployCeremonyStore();
    store.write({
      version: 1,
      phase: "waiting-rounds",
      target_version: "1.2.3",
      updated_at: "2026-08-28T12:00:01Z",
    });
    const streams = fakeStreams();
    const app = new App(TUI_DEFAULTS, async () => ok(""), streams.out, streams.input);
    let deploys = 0;
    app.hooks.deployRun = () => (deploys++, { kill: () => {} });
    // the reload returns a different version than the ceremony targets
    const st = installDeployHooks(
      app,
      { load: async () => loaded({ version: "1.9.9" }) },
      () => 2000,
      quietDrain(),
      store,
    );
    const run = app.run();
    publishStatus(app, 0);
    await settle();
    publishStatus(app, 0);
    await settle();
    expect(deploys).toBe(0);
    expect(st.deployPhase).toBe("deploy-failed");
    expect(st.run?.lines.join("\n")).toContain("chosen version changed from 1.2.3 to 1.9.9");
    app.quit();
    await run;
  });
});

it("sanitizes a live partial deployment progress line", async () => {
  const { renderDeployTab } = await import("../src/tui/deploytab.js");
  const st = emptyState({
    run: { kind: "deploy", lines: [], partial: "old\rnew\x1b[2J", running: true },
  });
  const text = renderDeployTab(st, true, 100, 24).lines.join("\n");
  expect(text).not.toContain("\r");
  expect(text).not.toContain("\x1b[2J");
});
