// The companion without Docker: chosen only when Docker does not answer, run
// on the host with the very extensions the container's pi loads (the guards
// among them), and said to be unsandboxed. Nothing here spawns docker, tmux
// or pi: every runner is a recording fake.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COMPANION_DEFAULTS, resolveCompanionPaths, type CompanionConfig } from "../src/config.js";
import {
  CompanionLifecycle,
  CONTAINER,
  LENS,
  MEMORY,
  type CompanionFs,
  type DockerResult,
  type DockerRunner,
} from "../src/tui/companion.js";
import {
  chooseCompanionKind,
  NATIVE_TMUX_LABEL,
  NativeCompanion,
  nativeAgentDir,
  nativePathMap,
  nativeRunner,
  probeDocker,
  SelectingCompanion,
  toHostPaths,
  UNSANDBOXED_WARNING,
} from "../src/tui/nativecompanion.js";
import { CompanionSidebar, paintSidebar, type SidebarView } from "../src/tui/sidebar.js";
import { stripAnsi } from "../src/tui/paint.js";

const APP = "/host/app";
const AGENT = "/host/home/.pi/agent";
const CONFIG_HOME = "/host/home/.config/qcr/default";

const CFG: CompanionConfig = resolveCompanionPaths(
  {
    ...COMPANION_DEFAULTS,
    repo_dir: "/host/checkout",
    tracker_dir: "/host/tracker",
    tracker_docs_dir: "/host/tracker-docs",
    reviewed_repo_dir: "/host/reviewed",
    feed_dir: "/host/feed",
    alerts_dir: "/host/alerts",
    evidence_dir: "/host/evidence",
    ssh_dir: "/host/.ssh",
  },
  APP,
);

const OK: DockerResult = { ok: true, stdout: "", stderr: "", code: 0 };
const FAIL: DockerResult = { ok: false, stdout: "", stderr: "nope", code: 1 };

const NO_FS: CompanionFs = { exists: () => false, read: () => undefined, mode: () => undefined };
const noDocker: DockerRunner = async () => FAIL;

function containerLc(): CompanionLifecycle {
  return new CompanionLifecycle(CFG, noDocker, { HOME: "/host/home" }, () => {}, NO_FS);
}

/** A `run(bin, argv)` fake: records every call, answers from `answer`. */
function fakeRun(answer: (bin: string, argv: string[]) => DockerResult = () => OK) {
  const calls: Array<[string, string[]]> = [];
  const run = async (bin: string, argv: string[]): Promise<DockerResult> => {
    calls.push([bin, argv]);
    return answer(bin, argv);
  };
  return { run, calls };
}

function native(answer?: (bin: string, argv: string[]) => DockerResult) {
  const lc = containerLc();
  const { run, calls } = fakeRun(answer);
  const made: string[][] = [];
  const nc = new NativeCompanion(lc, {
    appRoot: APP,
    agentDir: AGENT,
    configHome: CONFIG_HOME,
    piBin: () => "/host/app/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
    run,
    ensureDirs: (ps) => made.push(ps),
    exists: (p) => p === `${APP}/docker/vm/tmux.conf`,
  });
  return { lc, nc, calls, made };
}

/** Every `--extension <path>` value in an argv. */
function extensions(argv: string[]): string[] {
  const out: string[] = [];
  argv.forEach((a, i) => {
    if (a === "--extension") out.push(argv[i + 1]!);
  });
  return out;
}

describe("the choice", () => {
  it("Docker answering is the container; anything else is native", async () => {
    expect(await chooseCompanionKind(async () => true)).toBe("docker");
    expect(await chooseCompanionKind(async () => false)).toBe("native");
    expect(
      await chooseCompanionKind(async () => {
        throw new Error("spawn docker ENOENT");
      }),
    ).toBe("native");
  });

  it("asks `docker info` and wants a server version back", async () => {
    const seen: string[][] = [];
    const answering: DockerRunner = async (argv) => {
      seen.push(argv);
      return { ...OK, stdout: "27.3.1\n" };
    };
    expect(await probeDocker(answering)).toBe(true);
    expect(seen).toEqual([["info", "--format", "{{.ServerVersion}}"]]);
    expect(await probeDocker(async () => OK)).toBe(false);
    expect(await probeDocker(noDocker)).toBe(false);
  });

  it("chooses once, at the bring-up; the runner and the lifecycle follow the choice", async () => {
    const lc = containerLc();
    let probes = 0;
    let told = 0;
    const dockerCalls: string[][] = [];
    const docker: DockerRunner = async (argv) => {
      dockerCalls.push(argv);
      return OK;
    };
    const { nc, calls } = native();
    const sel = new SelectingCompanion(lc, docker, {
      dockerUp: async () => {
        probes++;
        return false;
      },
      makeNative: () => nc,
      onNative: () => told++,
    });
    // Before the choice, nothing is asked and the seam is the container's.
    expect(sel.kind).toBeUndefined();
    await sel.runner(["exec", CFG.container_name, "tmux", "has-session", "-t", CFG.session]);
    expect(dockerCalls).toHaveLength(1);
    expect(probes).toBe(0);
    await Promise.all([sel.select(), sel.select()]);
    expect(sel.kind).toBe("native");
    expect(probes).toBe(1);
    expect(told).toBe(1);
    // After it, the same seam reaches the host's tmux, never docker.
    await sel.runner(["exec", CFG.container_name, "tmux", "has-session", "-t", CFG.session]);
    expect(dockerCalls).toHaveLength(1);
    expect(calls.at(-1)).toEqual([
      "tmux",
      ["-L", NATIVE_TMUX_LABEL, "has-session", "-t", CFG.session],
    ]);
  });

  it("with Docker up it is the container companion, exactly as before", async () => {
    const lc = containerLc();
    let made = 0;
    const sel = new SelectingCompanion(lc, noDocker, {
      dockerUp: async () => true,
      makeNative: () => {
        made++;
        return native().nc;
      },
    });
    expect(await sel.select()).toBe("docker");
    expect(made).toBe(0);
    expect(sel.hostInjectDir()).toBe(lc.hostInjectDir());
  });
});

describe("the native spawn loads the container's guards", () => {
  // MUTATION: drop or reorder an extension in NativeCompanion.piArgv — this fails.
  it("every extension the container's pi loads, in the same order, from the app root", () => {
    const { lc, nc } = native();
    const container = extensions(lc.piArgv());
    const host = extensions(nc.piArgv());
    expect(host).toEqual(container.map((p) => p.replace(CONTAINER.app, APP)));
    expect(host).toContain(`${APP}/extensions/cli/companion-guard.ts`);
    expect(host).toContain(`${APP}/extensions/inline-bash.ts`);
    expect(host).toContain(LENS.extension.replace(CONTAINER.app, APP));
    expect(host).toContain(MEMORY.extension.replace(CONTAINER.app, APP));
    expect(host).toContain(`${APP}/extensions/cli/inject-bridge.ts`);
    expect(host).toContain(`${APP}/extensions/cli/tui-view.ts`);
  });

  it("runs the pinned pi, the image's system prompt, and its own session dir", () => {
    const { nc } = native();
    const argv = nc.piArgv();
    expect(argv[0]).toBe(
      "/host/app/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
    );
    expect(argv[argv.indexOf("--system-prompt") + 1]).toBe(`${APP}/prompts/companion.md`);
    expect(argv[argv.indexOf("--session-dir") + 1]).toBe(`${AGENT}/sessions/${CFG.session}`);
    expect(argv).toContain("--approve");
  });

  it("the guard's root is the checkout, and every routing var names a host path", () => {
    const { nc } = native();
    const env = nc.piEnvPrefix();
    expect(env[0]).toBe("env");
    expect(env).toContain(`QCR_ROOT=${CFG.repo_dir}`);
    expect(env).toContain(`QCR_INJECT_DIR=${CFG.repo_dir}/inject/${CFG.session}`);
    expect(env).toContain(`QCR_FEED_DIR=${CFG.feed_dir}`);
    expect(env).toContain(`QCR_ALERTS_DIR=${CFG.alerts_dir}`);
    expect(env).toContain(`QCR_TRACKER_DIR=${CFG.tracker_dir}`);
    expect(env).toContain(`QCR_REVIEWED_REPO=${CFG.reviewed_repo_dir}`);
    expect(env).toContain(`PI_CODING_AGENT_DIR=${AGENT}`);
    expect(env).toContain(`QCR_CONFIG_HOME=${CONFIG_HOME}`);
  });

  it("no container path survives into the spawn", () => {
    const { nc } = native();
    const argv = nc.spawnArgv().slice(2).join("\n");
    for (const p of [
      CONTAINER.app,
      CONTAINER.piHome,
      CONTAINER.workspace,
      CONTAINER.feed,
      CONTAINER.alerts,
      CONTAINER.tracker,
      CONTAINER.reviewedRepo,
      CONTAINER.configHome,
      CONTAINER.stateHome,
      CONTAINER.githubRead,
    ])
      expect(argv).not.toMatch(new RegExp(`(^|[\\s='"])${p}(/|\\s|$)`, "m"));
  });

  it("spawns pi in its own tmux server, in the checkout, with the image's tmux config", async () => {
    const { nc, calls } = native((bin, argv) =>
      bin === "tmux" && argv.includes("has-session") ? FAIL : OK,
    );
    expect(await nc.spawnPi()).toBe(true);
    const [bin, argv] = calls.find(([, a]) => a.includes("new-session"))!;
    expect(bin).toBe("tmux");
    expect(argv.slice(0, 4)).toEqual(["-L", NATIVE_TMUX_LABEL, "-f", `${APP}/docker/vm/tmux.conf`]);
    expect(argv).toEqual(
      expect.arrayContaining(["new-session", "-d", "-s", CFG.session, "-c", CFG.repo_dir]),
    );
    expect(extensions(argv)).toContain(`${APP}/extensions/cli/companion-guard.ts`);
  });

  it("adopts a live session instead of spawning a twin", async () => {
    const { nc, calls } = native();
    expect(await nc.spawnPi()).toBe(false);
    expect(calls.some(([, a]) => a.includes("new-session"))).toBe(false);
  });

  it("ensureUp says it is unsandboxed, needs tmux, and makes the host dirs", async () => {
    const lines: string[] = [];
    const { nc, made } = native();
    expect(await nc.ensureUp((l) => lines.push(l))).toBe("native");
    expect(lines[0]).toBe(UNSANDBOXED_WARNING);
    expect(made.flat()).toEqual(
      expect.arrayContaining([CFG.feed_dir, CFG.alerts_dir, `${AGENT}/sessions/${CFG.session}`]),
    );
    const noTmux = native((bin) => (bin === "tmux" ? FAIL : OK));
    await expect(noTmux.nc.ensureUp()).rejects.toThrow(/install tmux/);
  });

  it("quit ends the session, as docker stop does", async () => {
    const { nc, calls } = native();
    await nc.gracefulStop();
    expect(calls).toEqual([["tmux", ["-L", NATIVE_TMUX_LABEL, "kill-session", "-t", CFG.session]]]);
  });
});

describe("the native runner", () => {
  const map: Array<[string, string]> = [
    [`${CONTAINER.piHome}/agent`, AGENT],
    [CONTAINER.piHome, "/host/home/.pi"],
    [CONTAINER.workspace, "/host/checkout"],
  ];

  it("rewrites the rollover's scripts, never what the operator types", async () => {
    const { run, calls } = fakeRun();
    const r = nativeRunner(CFG.container_name, map, { run });
    await r([
      "exec",
      CFG.container_name,
      "sh",
      "-c",
      `d='${CONTAINER.piHome}/agent/sessions/companion'; mkdir -p '${CONTAINER.piHome}/archive/x'`,
    ]);
    expect(calls[0]).toEqual([
      "sh",
      ["-c", `d='${AGENT}/sessions/companion'; mkdir -p '/host/home/.pi/archive/x'`],
    ]);
    await r([
      "exec",
      CFG.container_name,
      "tmux",
      "send-keys",
      "-t",
      "companion",
      "-l",
      "cat /workspace/x",
    ]);
    expect(calls[1]![1]).toContain("cat /workspace/x");
  });

  it("refuses anything that wants a container", async () => {
    const { run, calls } = fakeRun();
    const r = nativeRunner(CFG.container_name, map, { run });
    expect((await r(["inspect", CFG.container_name])).ok).toBe(false);
    expect((await r(["exec", CFG.container_name, "cat", "/etc/passwd"])).ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("rewrites a container path only where it stands as a path", () => {
    expect(toHostPaths("QCR_ROOT=/workspace", map)).toBe("QCR_ROOT=/host/checkout");
    expect(toHostPaths("/workspace/inject/companion", map)).toBe("/host/checkout/inject/companion");
    expect(toHostPaths("/workspaces/other", map)).toBe("/workspaces/other");
    expect(toHostPaths("openai-codex/workspace", map)).toBe("openai-codex/workspace");
    expect(toHostPaths(`${CONTAINER.piHome}/agent/x`, map)).toBe(`${AGENT}/x`);
  });

  it("maps no ssh or tmux-socket mount: on the host, ssh is the host's own", () => {
    const lc = containerLc();
    const dests = nativePathMap(lc, { appRoot: APP, agentDir: AGENT, configHome: CONFIG_HOME }).map(
      ([d]) => d,
    );
    expect(dests.some((d) => d.includes(".ssh") || d.startsWith("/run/"))).toBe(false);
    expect(dests).toContain(CONTAINER.app);
  });

  it("uses the user's own pi agent dir, or the one PI_CODING_AGENT_DIR names", () => {
    expect(nativeAgentDir({ HOME: "/h" })).toBe("/h/.pi/agent");
    expect(nativeAgentDir({ HOME: "/h", PI_CODING_AGENT_DIR: "/x/agent" })).toBe("/x/agent");
  });
});

describe("the column says so", () => {
  const VIEW = (header: Partial<SidebarView["header"]>): SidebarView => ({
    header: { up: true, piUp: true, day: "2026-10-23", lastWake: "—", memory: "ok", ...header },
    lines: ["x"],
    focused: false,
    available: true,
    offset: 0,
    alerts: [],
  });

  it("an unsandboxed companion and memory off for want of Docker, in the header", () => {
    const text = stripAnsi(
      paintSidebar(
        VIEW({ unsandboxed: true, memory: "off", memoryNote: "memory off (no Docker)" }),
        80,
        20,
      ).join("\n"),
    );
    expect(text).toContain("companion unsandboxed");
    expect(text).toContain("memory off (no Docker)");
  });

  it("the sidebar carries the flags it was told, and only those", () => {
    const sb = new CompanionSidebar(
      { container_name: CFG.container_name, session: CFG.session },
      noDocker,
      { available: () => true },
    );
    expect(sb.view().header.unsandboxed).toBeUndefined();
    sb.setHeader({ unsandboxed: true, memory: "off", memoryNote: "memory off (no Docker)" });
    expect(sb.view().header).toMatchObject({
      unsandboxed: true,
      memory: "off",
      memoryNote: "memory off (no Docker)",
    });
  });
});

describe("the TUI wires it", () => {
  const index = readFileSync(join(process.cwd(), "src", "tui", "index.ts"), "utf8");

  it("chooses in the bring-up, keeps the containerised TUI on its wrapper-run container", () => {
    expect(index).toMatch(
      /const selecting = socketMode\s*\? undefined\s*: new SelectingCompanion\(/,
    );
    expect(index).toMatch(/const companionDocker = selecting\s*\? selecting\.runner/);
    expect(index).toMatch(/selecting \?\?\s*laptopLifecycle\(/);
    // The column says it: the header flag and a notice, when native is chosen.
    expect(index).toMatch(
      /onNative: \(\) => \{\s*app\.sidebar\?\.setHeader\(\{ unsandboxed: true \}\);/,
    );
  });

  it("a local engine with no Docker is memory off, said in the column", () => {
    expect(index).toMatch(
      /offReason: async \(\) => \(\(await dockerUp\(\)\) \? undefined : MEMORY_OFF_NO_DOCKER\)/,
    );
    expect(index).toMatch(/memoryNote: noDocker \? MEMORY_OFF_NO_DOCKER : undefined/);
  });
});
