import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COMPANION_DEFAULTS, parseConfig, resolveCompanionPaths, type CompanionConfig } from "../src/config.js";
import { CompanionLifecycle, CONTAINER, type DockerResult, type DockerRunner } from "../src/tui/companion.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CFG: CompanionConfig = resolveCompanionPaths(
  {
    ...COMPANION_DEFAULTS,
    repo_dir: "/host/review-sandbox",
    tracker_dir: "/host/tracker",
    feed_dir: "/host/feed",
    alerts_dir: "/host/alerts",
    ssh_dir: "/host/.ssh",
  },
  root,
);

const OK: DockerResult = { ok: true, stdout: "", stderr: "", code: 0 };
const FAIL: DockerResult = { ok: false, stdout: "", stderr: "No such object: qcr-companion", code: 1 };

/** Records every docker call and answers from a scripted table. */
function fakeDocker(answers: Array<(argv: string[]) => DockerResult | undefined>): {
  runner: DockerRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const runner: DockerRunner = async (argv) => {
    calls.push(argv);
    for (const a of answers) {
      const r = a(argv);
      if (r) return r;
    }
    return FAIL;
  };
  return { runner, calls };
}

const inspect = (running: boolean | "absent") => (argv: string[]) =>
  argv[0] === "inspect"
    ? running === "absent"
      ? FAIL
      : { ...OK, stdout: `${String(running)}\n` }
    : undefined;
const okFor = (verb: string) => (argv: string[]) => (argv[0] === verb ? OK : undefined);
const noDirs = (): void => {};

function lifecycle(answers: Parameters<typeof fakeDocker>[0], env: NodeJS.ProcessEnv = {}) {
  const { runner, calls } = fakeDocker(answers);
  return { lc: new CompanionLifecycle(CFG, runner, env, noDirs), calls };
}

/** ensureUp() resolves the memory wiring first (docker network …).
 * That is its own test file (companion-memory.test.ts); the lifecycle
 * assertions below are about the container, so the network calls are filtered
 * out rather than repeated in every expectation. */
const containerCalls = (calls: string[][]): string[][] => calls.filter((c) => c[0] !== "network");

describe("companion config", () => {
  it("defaults the whole [companion] section when config.toml omits the keys", () => {
    const cfg = parseConfig(readFileSync(resolve(root, "config.toml"), "utf8")).companion;
    expect(cfg.enabled).toBe(true);
    expect(cfg.container_name).toBe("qcr-companion");
    expect(cfg.image).toBe("qcr-companion");
    expect(cfg.pihome_volume).toBe("companion-pihome");
    expect(cfg.session).toBe("companion");
    expect(cfg.cooldown_min).toBe(20);
    expect(cfg.overdue_grace_min).toBe(30);
    expect(cfg.awaiting_age_h).toBe(24);
    expect(cfg.stale_alert_s).toBeGreaterThan(0);
  });

  it("derives empty host paths from the sandbox root and expands ~", () => {
    const cfg = resolveCompanionPaths({ ...COMPANION_DEFAULTS, tracker_dir: "~/t" }, "/root");
    expect(cfg.repo_dir).toBe("/root");
    expect(cfg.feed_dir).toBe("/root/state/companion/feed");
    expect(cfg.alerts_dir).toBe("/root/state/companion/alerts");
    expect(cfg.tracker_dir.startsWith("/")).toBe(true);
    expect(cfg.tracker_dir.endsWith("/t")).toBe(true);
  });

  it("honors an explicit [companion] override", () => {
    const base = readFileSync(resolve(root, "config.toml"), "utf8");
    // Inject into the [companion] table itself — appended bare keys would join
    // whatever table happens to be last in config.toml ([backfill]).
    const withOverrides = base.replace("[companion]", `[companion]\ncontainer_name = "other"\nenabled = false\ncooldown_min = 5`);
    const cfg = parseConfig(withOverrides).companion;
    expect(cfg.container_name).toBe("other");
    expect(cfg.enabled).toBe(false);
    expect(cfg.cooldown_min).toBe(5);
  });
});

describe("CompanionLifecycle argv", () => {
  const { lc } = lifecycle([]);

  it("mounts pihome, repo, tracker, feed and alerts — and no credential", () => {
    const argv = lc.runArgv();
    expect(argv.slice(0, 4)).toEqual(["run", "--detach", "--name", "qcr-companion"]);
    const mounts = argv.filter((_, i) => argv[i - 1] === "--volume");
    // the ~/.ssh mount is gone for good — the companion's reach into
    // the VM is OpenViking memory over a HOST-owned forward, nothing else.
    expect(mounts).toEqual([
      `companion-pihome:${CONTAINER.piHome}`,
      `/host/review-sandbox:${CONTAINER.workspace}:rw`,
      `/host/tracker:${CONTAINER.tracker}:rw`,
      `/host/feed:${CONTAINER.feed}:rw`,
      `/host/alerts:${CONTAINER.alerts}:rw`,
    ]);
    expect(argv[argv.length - 1]).toBe("qcr-companion"); // image last
  });

  it("never forwards the ssh agent socket, even when the host has one", () => {
    const { lc: withAgent } = lifecycle([], { SSH_AUTH_SOCK: "/tmp/agent.sock" });
    const argv = withAgent.runArgv().join(" ");
    expect(argv).not.toContain("SSH_AUTH_SOCK");
    expect(argv).not.toContain("agent.sock");
    expect(argv).not.toContain(".ssh");
  });

  it("spawns pi inside tmux with the QCR_* vars on the command line", () => {
    const argv = lc.spawnArgv();
    expect(argv.slice(0, 8)).toEqual([
      "exec",
      "qcr-companion",
      "tmux",
      "new-session",
      "-d",
      "-s",
      "companion",
      "env",
    ]);
    // tmux panes inherit the SERVER env — the vars must ride the argv itself.
    expect(argv).toContain(`QCR_ROOT=${CONTAINER.workspace}`);
    expect(argv).toContain(`QCR_ALERTS_DIR=${CONTAINER.alerts}`);
    expect(argv).toContain(`QCR_FEED_DIR=${CONTAINER.feed}`);
    expect(argv).toContain("QCR_SESSION=companion");
    // inject-bridge resolves its session name from this one.
    expect(argv).toContain("QCR_SESSION_NAME=companion");
    expect(argv).toContain(`QCR_INJECT_DIR=${CONTAINER.workspace}/inject/companion`);
    const pi = argv.slice(argv.indexOf("pi"));
    expect(pi).toEqual([
      "pi",
      // the wake extension ships with the mounted repo.
      "--extension",
      `${CONTAINER.workspace}/extensions/companion-wake.ts`,
      "--extension",
      `${CONTAINER.workspace}/extensions/muted-theme.ts`,
      "--theme",
      `${CONTAINER.workspace}/extensions/muted-theme.json`,
      // the inject bridge delivers the day-open message.
      "--extension",
      `${CONTAINER.workspace}/extensions/inject-bridge.ts`,
      "--model",
      COMPANION_DEFAULTS.model,
      "--session-dir",
      `${CONTAINER.piHome}/agent/sessions/companion`,
      "--system-prompt",
      `${CONTAINER.workspace}/prompts/companion.md`,
      "--name",
      "companion",
    ]);
  });

  it("attaches locally through docker exec — no ssh in the argv", () => {
    expect(lc.attachArgv()).toEqual(["exec", "-it", "qcr-companion", "tmux", "attach", "-t", "companion"]);
    expect(lc.attachArgv()).not.toContain("ssh");
  });
});

describe("CompanionLifecycle state machine", () => {
  it("adopts a running container without touching it", async () => {
    const { lc, calls } = lifecycle([inspect(true)]);
    expect(await lc.ensureUp()).toBe("adopted");
    expect(containerCalls(calls)).toHaveLength(1);
    expect(containerCalls(calls)[0]![0]).toBe("inspect");
  });

  it("starts an existing stopped container", async () => {
    const { lc, calls } = lifecycle([inspect(false), okFor("start")]);
    expect(await lc.ensureUp()).toBe("started");
    expect(containerCalls(calls).map((c) => c[0])).toEqual(["inspect", "start"]);
    expect(containerCalls(calls)[1]).toEqual(["start", "qcr-companion"]);
  });

  it("recreates an unstartable container (stale bind mounts after a reboot)", async () => {
    // Live incident 2026-08-14: the ssh-agent socket path is random per boot;
    // after a crash `docker start` fails forever on the recorded mount.
    const { lc, calls } = lifecycle([
      inspect(false),
      (argv) =>
        argv[0] === "start"
          ? { ok: false, stdout: "", stderr: "error mounting /home/user/.ssh/agent/s.dead to rootfs: not a directory", code: 1 }
          : undefined,
      okFor("rm"),
      okFor("image"),
      okFor("run"),
    ]);
    const progress: string[] = [];
    expect(await lc.ensureUp((l) => progress.push(l))).toBe("recreated");
    expect(containerCalls(calls).map((c) => c[0])).toEqual(["inspect", "start", "rm", "image", "run"]);
    expect(calls.find((c) => c[0] === "rm")).toEqual(["rm", "-f", "qcr-companion"]);
    expect(progress.some((l) => l.includes("recreating"))).toBe(true);
  });

  it("runs a fresh container when none exists (image already built)", async () => {
    const { lc, calls } = lifecycle([inspect("absent"), okFor("image"), okFor("run")]);
    expect(await lc.ensureUp()).toBe("created");
    expect(containerCalls(calls).map((c) => c[0])).toEqual(["inspect", "image", "run"]);
  });

  it("self-heals a missing image: builds it, then runs — never fails on first launch", async () => {
    const { lc, calls } = lifecycle([
      inspect("absent"),
      (argv) => (argv[0] === "image" ? { ok: false, stdout: "", stderr: "No such image", code: 1 } : undefined),
      okFor("build"),
      okFor("run"),
    ]);
    const progress: string[] = [];
    expect(await lc.ensureUp((l) => progress.push(l))).toBe("created");
    expect(containerCalls(calls).map((c) => c[0])).toEqual(["inspect", "image", "build", "run"]);
    const build = calls.find((c) => c[0] === "build")!;
    expect(build).toContain("-t");
    expect(build).toContain("qcr-companion");
    expect(build.some((a) => a.startsWith("COMPANION_UID="))).toBe(true);
    expect(progress.some((l) => l.includes("building"))).toBe(true);
  });

  it("is idempotent: a second TUI adopts, it never twins", async () => {
    let running = false;
    const { lc, calls } = lifecycle([
      (argv) => (argv[0] === "inspect" ? { ...OK, stdout: `${String(running)}\n` } : undefined),
      (argv) => {
        if (argv[0] !== "start") return undefined;
        running = true;
        return OK;
      },
    ]);
    expect(await lc.ensureUp()).toBe("started");
    expect(await lc.ensureUp()).toBe("adopted");
    expect(await lc.ensureUp()).toBe("adopted");
    expect(calls.filter((c) => c[0] === "run")).toHaveLength(0);
    expect(calls.filter((c) => c[0] === "start")).toHaveLength(1);
  });

  it("reports a docker run failure with the stderr tail", async () => {
    const { lc } = lifecycle([inspect("absent"), () => ({ ...FAIL, stderr: "boom: no image\n" })]);
    await expect(lc.ensureUp()).rejects.toThrow(/boom: no image/);
  });

  it("leaves a live pi session strictly alone", async () => {
    const { lc, calls } = lifecycle([(argv) => (argv[1] === "qcr-companion" && argv[2] === "tmux" ? OK : undefined)]);
    expect(await lc.spawnPi()).toBe(false);
    expect(calls).toHaveLength(1); // has-session only
  });

  it("spawns pi when the session is missing", async () => {
    const { lc, calls } = lifecycle([
      (argv) => (argv.includes("has-session") ? FAIL : undefined),
      (argv) => (argv.includes("new-session") ? OK : undefined),
    ]);
    expect(await lc.spawnPi()).toBe(true);
    expect(calls[1]).toContain("new-session");
  });

  it("stops gracefully with docker stop", async () => {
    const { lc, calls } = lifecycle([inspect(true), okFor("stop")]);
    await lc.gracefulStop();
    expect(containerCalls(calls)[1]).toEqual(["stop", "qcr-companion"]);
  });

  it("stopping an already-stopped container is a no-op (never a kill)", async () => {
    const { lc, calls } = lifecycle([inspect(false)]);
    await lc.gracefulStop();
    expect(containerCalls(calls)).toHaveLength(1);
    expect(calls.some((c) => c[0] === "kill" || c[0] === "rm")).toBe(false);
  });

  it("status distinguishes absent / stopped / running", async () => {
    expect(await lifecycle([inspect("absent")]).lc.status()).toEqual({ exists: false, running: false });
    expect(await lifecycle([inspect(false)]).lc.status()).toEqual({ exists: true, running: false });
    expect(await lifecycle([inspect(true)]).lc.status()).toEqual({ exists: true, running: true });
  });
});

describe("qcr tui args", () => {
  it("defaults to companion on + reload on with no target", async () => {
    const { parseTuiArgs } = await import("../src/tui/index.js");
    expect(parseTuiArgs([])).toEqual({
      target: undefined,
      companion: true,
      reload: true,
      resumeState: undefined,
      help: false,
    });
  });

  it("separates flags from the deep-link target", async () => {
    const { parseTuiArgs } = await import("../src/tui/index.js");
    expect(parseTuiArgs(["5012", "--no-companion"])).toMatchObject({ target: "5012", companion: false, reload: true });
    expect(parseTuiArgs(["--no-reload", "overseer"])).toMatchObject({ target: "overseer", reload: false });
    expect(parseTuiArgs(["--resume-state", "/s.json"])).toMatchObject({ target: undefined, resumeState: "/s.json" });
    expect(parseTuiArgs(["-h"]).help).toBe(true);
  });
});

describe("companion image", () => {
  const dockerfile = readFileSync(resolve(root, "docker/companion/Dockerfile"), "utf8");
  const entrypoint = readFileSync(resolve(root, "docker/companion/entrypoint.sh"), "utf8");
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
    pi: { package: string; version: string; extensions: Record<string, string> };
  };

  it("pins pi to the same version as package.json", () => {
    expect(dockerfile).toContain(`PI_VERSION=${pkg.pi.version}`);
    expect(dockerfile).toContain(`PI_PACKAGE=${pkg.pi.package}`);
  });

  // the retired engine must not creep back. pi-memory and qmd were
  // the hand-rolled memory engine's two npm dependencies; both went with it.
  // Re-installing either would put a SECOND memory engine in the companion:
  // one writing a local MEMORY.md nobody reads, and one hooking
  // `session_before_compact`, which extensions/ledger-pin.ts must own alone.
  it("installs NO memory extension — memory is OpenViking over the host forward", () => {
    expect(pkg.pi.extensions["pi-memory"]).toBeUndefined();
    // Mechanism, not mention: the historical note explaining WHY they are gone
    // is allowed to name them; an install layer is not.
    const installs = dockerfile.split("\n").filter((l) => /^\s*(RUN|&&)\s+npm install/.test(l));
    expect(installs.join("\n")).not.toMatch(/pi-memory|qmd/i);
    expect(dockerfile).not.toMatch(/^ARG (PI_MEMORY_SPEC|QMD_SPEC)=/m);
    // The one memory extension a companion pi loads is the vendored, patched
    // fork — passed per spawn from /workspace, never baked in.
    expect(dockerfile).toContain("openviking-pi");
  });

  it("registers no memory extension in the entrypoint either", () => {
    expect(entrypoint).not.toMatch(/require\.resolve\("pi-memory"/);
    expect(entrypoint).not.toMatch(/extensions\.push/);
    // The VM image dropped the same registration in the same slice.
    const vmEntrypoint = readFileSync(resolve(root, "deploy/ansible/templates/entrypoint.sh.j2"), "utf8");
    expect(vmEntrypoint).not.toMatch(/require\.resolve\("pi-memory"/);
    const vmDockerfile = readFileSync(resolve(root, "deploy/ansible/templates/Dockerfile.j2"), "utf8");
    expect(vmDockerfile).not.toMatch(/npm install -g \{\{ pi_memory_package \}\}/);
    expect(vmDockerfile).not.toMatch(/npm install -g \{\{ qmd_npm_package \}\}/);
    const gv = readFileSync(resolve(root, "deploy/ansible/group_vars/all.yml"), "utf8");
    expect(gv).not.toMatch(/^pi_memory_version:/m);
    expect(gv).not.toMatch(/^qmd_version:/m);
  });

  it("takes its uid from the host user — bind mounts are written, not just read", () => {
    // the first real container run failed "Permission denied" writing
    // /alerts because the image baked uid 1001.
    expect(dockerfile).toContain("ARG COMPANION_UID=");
    expect(dockerfile).toMatch(/useradd .*--non-unique --uid \$\{COMPANION_UID\} companion/);
  });

  it("writes the csi-u tmux config before starting the server", () => {
    const conf = entrypoint.indexOf("extended-keys-format csi-u");
    const start = entrypoint.indexOf("tmux start-server");
    expect(conf).toBeGreaterThan(0);
    expect(start).toBeGreaterThan(conf);
    expect(entrypoint).toContain("set -g extended-keys on");
    expect(entrypoint).toContain("terminal-features 'xterm*:extkeys'");
  });

  it("keeps the container alive rather than owning pi as PID 1", () => {
    expect(entrypoint.trimEnd().endsWith("exec sleep infinity")).toBe(true);
    expect(entrypoint).not.toContain("exec pi");
  });
});
