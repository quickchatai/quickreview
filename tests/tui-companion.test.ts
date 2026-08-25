import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COMPANION_DEFAULTS, parseConfig, resolveCompanionPaths, type CompanionConfig } from "../src/config.js";
import {
  CompanionLifecycle,
  CONTAINER,
  type CompanionFs,
  type DockerResult,
  type DockerRunner,
} from "../src/tui/companion.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CFG: CompanionConfig = resolveCompanionPaths(
  {
    ...COMPANION_DEFAULTS,
    repo_dir: "/host/review-sandbox",
    tracker_dir: "/host/tracker",
    // a path that does not exist on any machine running this suite —
    // so the default lifecycle() (real fs) is the MISSING-checkout case, and
    // the present case is opted into explicitly via withRepo().
    reviewed_repo_dir: "/host/example-app",
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

/** Same, but with the reviewed-repo checkout PRESENT on the host.
 * The fs seam answers for that one path only, so nothing else changes. */
function withRepo(answers: Parameters<typeof fakeDocker>[0], env: NodeJS.ProcessEnv = {}) {
  const { runner, calls } = fakeDocker(answers);
  const fs: CompanionFs = {
    exists: (p) => p === CFG.reviewed_repo_dir,
    read: () => undefined,
    mode: () => undefined,
  };
  return { lc: new CompanionLifecycle(CFG, runner, env, noDirs, fs), calls };
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
      // the tracker's protocol doc lives OUTSIDE tracker_dir, so it
      // needs its own mount — read-only, because the companion follows the
      // protocol and never rewrites it.
      `${CFG.tracker_docs_dir}:${CONTAINER.trackerDocs}:ro`,
      // the finished-round evidence store, read-only. The TUI holds
      // the VM access and writes it; the companion only reads.
      `${CFG.evidence_dir}:${CONTAINER.evidence}:ro`,
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
      // Rule 7 / pr-5334: the companion never blocks on pi's "Trust project
      // folder?" modal either. This is the same flag sessions.ts passes, and
      // its absence here is why the companion prompted on every start.
      "--approve",
      // Ambient feed changes stay in /feed and never become synthetic turns.
      "--extension",
      `${CONTAINER.workspace}/extensions/muted-theme.ts`,
      "--theme",
      `${CONTAINER.workspace}/extensions/muted-theme.json`,
      // the inject bridge delivers the day-open message.
      "--extension",
      `${CONTAINER.workspace}/extensions/inject-bridge.ts`,
      // the read-only tui_* tools over what the TUI published to
      // /feed. Reads only — it cannot fetch (see extensions/tui-view.ts).
      "--extension",
      `${CONTAINER.workspace}/extensions/tui-view.ts`,
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

describe("the reviewed repo, read-only", () => {
  /** `docker inspect` as the real format string renders it. */
  const inspectWith = (running: boolean, mounts: Record<string, string>) => (argv: string[]) =>
    argv[0] === "inspect"
      ? { ...OK, stdout: [String(running), ...Object.entries(mounts).map(([d, s]) => `${d}=${s}`), ""].join("\n") }
      : undefined;

  const BASE: Record<string, string> = {
    [CONTAINER.piHome]: "companion-pihome",
    [CONTAINER.workspace]: "/host/review-sandbox",
    [CONTAINER.tracker]: "/host/tracker",
    [CONTAINER.trackerDocs]: CFG.tracker_docs_dir,
    // read-only evidence store — part of the expected mount set, so a
    // container created before it drifts and is recreated.
    [CONTAINER.evidence]: CFG.evidence_dir,
    [CONTAINER.feed]: "/host/feed",
    [CONTAINER.alerts]: "/host/alerts",
  };

  it("mounts example-app READ-ONLY when the checkout is there", () => {
    const argv = withRepo([]).lc.runArgv();
    const mounts = argv.filter((_, i) => argv[i - 1] === "--volume");
    expect(mounts).toContain(`/host/example-app:${CONTAINER.reviewedRepo}:ro`);
    // `:ro` is the entire guarantee that reading the reviewed code can never
    // become writing it — rule 8's boundary is structural, not prompted.
    expect(mounts.some((m) => m.startsWith("/host/example-app:") && m.endsWith(":rw"))).toBe(false);
    expect(argv[argv.length - 1]).toBe("qcr-companion"); // image still last
  });

  it("drops the mount when the checkout is missing — under-equipped, never broken", async () => {
    // Default lifecycle() runs on the real fs, and /host/example-app is not
    // on any machine: this IS the missing-checkout case.
    const { lc, calls } = lifecycle([inspect("absent"), okFor("image"), okFor("run")]);
    expect(lc.runArgv().join(" ")).not.toContain(CONTAINER.reviewedRepo);
    const progress: string[] = [];
    // The container still comes up — a missing checkout must never be fatal.
    expect(await lc.ensureUp((l) => progress.push(l))).toBe("created");
    expect(calls.some((c) => c[0] === "run")).toBe(true);
    // …and it says so at boot rather than leaving the gap implicit.
    expect(progress.some((l) => l.includes("no reviewed repo at /host/example-app"))).toBe(true);
  });

  it("says which way it went at boot when the checkout IS there", async () => {
    const { lc } = withRepo([inspect(true)]);
    const progress: string[] = [];
    await lc.ensureUp((l) => progress.push(l));
    expect(progress.some((l) => l.includes(`${CONTAINER.reviewedRepo} (read-only)`))).toBe(true);
  });

  it("recreates a container created BEFORE the mount existed", async () => {
    // Bind mounts freeze at creation, so the container the owner is already
    // running carries the old set; `docker start` would silently resurrect a
    // companion that cannot read the reviewed code at all.
    const { lc, calls } = withRepo([inspectWith(true, BASE), okFor("rm"), okFor("image"), okFor("run")]);
    const progress: string[] = [];
    expect(await lc.ensureUp((l) => progress.push(l))).toBe("recreated");
    expect(containerCalls(calls).map((c) => c[0])).toEqual(["inspect", "rm", "image", "run"]);
    expect(progress.some((l) => l.includes(`missing ${CONTAINER.reviewedRepo}`))).toBe(true);
    // The recreate must actually carry the mount, or it recreates forever.
    expect(calls.find((c) => c[0] === "run")!).toContain(`/host/example-app:${CONTAINER.reviewedRepo}:ro`);
  });

  it("adopts a container that already carries it — no recreate loop", async () => {
    const { lc, calls } = withRepo([
      inspectWith(true, { ...BASE, [CONTAINER.reviewedRepo]: "/host/example-app" }),
    ]);
    expect(await lc.ensureUp()).toBe("adopted");
    expect(containerCalls(calls).map((c) => c[0])).toEqual(["inspect"]);
  });

  it("recreates when the mount points at a different checkout", async () => {
    const { lc, calls } = withRepo([
      inspectWith(false, { ...BASE, [CONTAINER.reviewedRepo]: "/host/old-example-app" }),
      okFor("rm"),
      okFor("image"),
      okFor("run"),
    ]);
    const progress: string[] = [];
    expect(await lc.ensureUp((l) => progress.push(l))).toBe("recreated");
    expect(progress.some((l) => l.includes("points at /host/old-example-app"))).toBe(true);
  });

  it("treats the mount as STALE once the checkout goes away", async () => {
    // Symmetry matters: expectedMounts() and runArgv() share one condition, so
    // a container holding a mount whose source no longer exists is drift too.
    const { lc, calls } = lifecycle([
      inspectWith(false, { ...BASE, [CONTAINER.reviewedRepo]: "/host/example-app" }),
      okFor("rm"),
      okFor("image"),
      okFor("run"),
    ]);
    const progress: string[] = [];
    expect(await lc.ensureUp((l) => progress.push(l))).toBe("recreated");
    expect(progress.some((l) => l.includes(`stale ${CONTAINER.reviewedRepo}`))).toBe(true);
  });

  it("defaults the config key to the usual local checkout and expands ~", () => {
    expect(COMPANION_DEFAULTS.reviewed_repo_dir).toBe("~/src/example-app");
    const cfg = resolveCompanionPaths({ ...COMPANION_DEFAULTS, reviewed_repo_dir: "~/qc" }, "/root");
    expect(cfg.reviewed_repo_dir.startsWith("/")).toBe(true);
    expect(cfg.reviewed_repo_dir.endsWith("/qc")).toBe(true);
    // config.toml documents it as a commented default, like every other knob.
    expect(readFileSync(resolve(root, "config.toml"), "utf8")).toContain("# reviewed_repo_dir =");
  });

  it("the entrypoint reports the mount either way, and never fabricates it", () => {
    const entrypoint = readFileSync(resolve(root, "docker/companion/entrypoint.sh"), "utf8");
    expect(entrypoint).toContain("/example-app is not mounted");
    expect(entrypoint).toContain("READ-ONLY at /example-app");
    // An invented empty dir reads as "the code says nothing" — worse than a
    // plainly absent mount. Never mkdir it.
    expect(entrypoint).not.toMatch(/mkdir[^\n]*\/example-app/);
  });

  it("tells the companion it has it, and that it is read-only", () => {
    const prompt = readFileSync(resolve(root, "prompts/companion.md"), "utf8");
    expect(prompt).toContain(CONTAINER.reviewedRepo);
    expect(prompt).toMatch(/READ-ONLY at `\/example-app`/);
    expect(prompt).toMatch(/Never\*\* write to `\/example-app`/);
  });

  it("alert family 3 does not lean on the retired awaiting_human state", () => {
    const prompt = readFileSync(resolve(root, "prompts/companion.md"), "utf8");
    expect(prompt).not.toMatch(/sitting in `awaiting_human`/);
    expect(prompt).toContain("`awaiting_human` itself is retired,");
    // The live concept: repeated non-decision / the legacy tracked landing.
    expect(prompt).toContain("stuck on repeated non-decision");
  });
});

describe("mount drift", () => {
  /** `docker inspect` as the real format string renders it: running flag on
   * line 1, then one `dest=source` line per mount. */
  const inspectWith = (running: boolean, mounts: Record<string, string>) => (argv: string[]) =>
    argv[0] === "inspect"
      ? {
          ...OK,
          stdout: [
            String(running),
            ...Object.entries(mounts).map(([dest, source]) => `${dest}=${source}`),
            "",
          ].join("\n"),
        }
      : undefined;

  const CURRENT: Record<string, string> = {
    [CONTAINER.piHome]: "companion-pihome",
    [CONTAINER.workspace]: "/host/review-sandbox",
    [CONTAINER.tracker]: "/host/tracker",
    [CONTAINER.trackerDocs]: CFG.tracker_docs_dir,
    // read-only evidence store — part of the expected mount set, so a
    // container created before it drifts and is recreated.
    [CONTAINER.evidence]: CFG.evidence_dir,
    [CONTAINER.feed]: "/host/feed",
    [CONTAINER.alerts]: "/host/alerts",
  };

  it("adopts a running container whose mounts already match", async () => {
    const { lc, calls } = lifecycle([inspectWith(true, CURRENT)]);
    expect(await lc.ensureUp()).toBe("adopted");
    expect(containerCalls(calls).map((c) => c[0])).toEqual(["inspect"]);
  });

  it("recreates a RUNNING container that is missing a mount", async () => {
    const { [CONTAINER.trackerDocs]: _gone, ...stale } = CURRENT;
    const { lc, calls } = lifecycle([inspectWith(true, stale), okFor("rm"), okFor("image"), okFor("run")]);
    const progress: string[] = [];
    expect(await lc.ensureUp((l) => progress.push(l))).toBe("recreated");
    expect(containerCalls(calls).map((c) => c[0])).toEqual(["inspect", "rm", "image", "run"]);
    expect(progress.some((l) => l.includes(`missing ${CONTAINER.trackerDocs}`))).toBe(true);
  });

  it("recreates a container carrying a STALE mount — the legacy ssh case", async () => {
    // The live container on the owner's PC predates and still has
    // ~/.ssh + an agent socket bound in. `docker start` would resurrect that
    // boundary breach silently; rule 8 is meant to be structural.
    const { lc, calls } = lifecycle([
      inspectWith(false, { ...CURRENT, "/home/companion/.ssh": "/home/user/.ssh", "/ssh-agent": "/tmp/a.sock" }),
      okFor("rm"),
      okFor("image"),
      okFor("run"),
    ]);
    const progress: string[] = [];
    expect(await lc.ensureUp((l) => progress.push(l))).toBe("recreated");
    expect(containerCalls(calls).map((c) => c[0])).toEqual(["inspect", "rm", "image", "run"]);
    expect(progress.some((l) => l.includes("stale /home/companion/.ssh"))).toBe(true);
    expect(progress.some((l) => l.includes("stale /ssh-agent"))).toBe(true);
  });

  it("recreates when a mount points at the wrong host path", async () => {
    const { lc, calls } = lifecycle([
      inspectWith(false, { ...CURRENT, [CONTAINER.tracker]: "/host/old-tracker" }),
      okFor("rm"),
      okFor("image"),
      okFor("run"),
    ]);
    const progress: string[] = [];
    expect(await lc.ensureUp((l) => progress.push(l))).toBe("recreated");
    expect(progress.some((l) => l.includes("points at /host/old-tracker"))).toBe(true);
  });

  it("compares a NAMED VOLUME by name, not by its _data path", async () => {
    // Docker reports a volume's Source as /var/lib/docker/volumes/<name>/_data
    // (or the daemon's data-root), which never equals the NAME the run argv
    // asks for. Comparing Source made drift fire on EVERY start: the container
    // was recreated each time, and the docker exec that followed raced the
    // fresh container ("is not running") and reported the companion down —
    // which is why the sidebar kept vanishing on startup.
    const asDockerReports = (running: boolean) => (argv: string[]) =>
      argv[0] === "inspect"
        ? {
            ...OK,
            // The format string asks for `.Name` on volumes, so a correct
            // implementation sees the NAME here.
            stdout: [
              String(running),
              `${CONTAINER.piHome}=companion-pihome`,
              `${CONTAINER.workspace}=/host/review-sandbox`,
              `${CONTAINER.tracker}=/host/tracker`,
              `${CONTAINER.trackerDocs}=${CFG.tracker_docs_dir}`,
              `${CONTAINER.evidence}=${CFG.evidence_dir}`,
              `${CONTAINER.feed}=/host/feed`,
              `${CONTAINER.alerts}=/host/alerts`,
              "",
            ].join("\n"),
          }
        : undefined;
    const { lc, calls } = lifecycle([asDockerReports(true)]);
    expect(await lc.ensureUp()).toBe("adopted"); // NOT "recreated"
    expect(containerCalls(calls).map((c) => c[0])).toEqual(["inspect"]);
    // And the format string is the mechanism — assert it asks for the name.
    const fmt = calls.find((c) => c[0] === "inspect")![2]!;
    expect(fmt).toContain("{{if .Name}}{{.Name}}{{else}}{{.Source}}{{end}}");
  });

  it("never concludes 'drifted' from an inspect it could not read", async () => {
    // A format change, an old docker, a truncated answer: seeing nothing must
    // mean 'no opinion', never 'recreate'. Destroying a container on a parse
    // failure would be far worse than running one with a stale mount.
    const { lc, calls } = lifecycle([inspect(true)]);
    expect(await lc.ensureUp()).toBe("adopted");
    expect(containerCalls(calls).map((c) => c[0])).toEqual(["inspect"]);
    expect(lc.mountDrift(new Map())).toEqual([]);
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
    const none = new Map<string, string>();
    expect(await lifecycle([inspect("absent")]).lc.status()).toEqual({ exists: false, running: false, mounts: none });
    expect(await lifecycle([inspect(false)]).lc.status()).toEqual({ exists: true, running: false, mounts: none });
    expect(await lifecycle([inspect(true)]).lc.status()).toEqual({ exists: true, running: true, mounts: none });
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

  // Rule 7: the reviewer never blocks on interactive pi input — and neither
  // does the companion. All three layers, or the "Trust project folder?" modal
  // comes back the moment one regresses. The companion shipped with only the
  // settings layer and prompted on every start until 2026-08-21.
  it("carries all three trust layers, and pre-trusts /workspace not /opt/quickreview", () => {
    // ② the settings belt
    expect(entrypoint).toContain('cfg.defaultProjectTrust = "always"');
    // ③ the trust-store braces, at the path the repo is ACTUALLY mounted on
    // here — seeding the VM's path would look right and fix nothing.
    expect(entrypoint).toContain('trust["/workspace"] = true');
    expect(entrypoint).not.toContain('trust["/opt/quickreview"]');
    // ① the spawn flag
    expect(new CompanionLifecycle(CFG, async () => OK, {}, { exists: () => false, read: () => undefined, mode: () => undefined }).piArgv()).toContain("--approve");
  });

  // the image's HOME and the code's mount destination are ONE fact
  // split across two files. They drifted for a week — `USER companion` resolved
  // through uid 1000 back to node:22's own user, so $HOME was /home/node while
  // the volume was mounted at /home/companion/.pi, and pi's OAuth token lived
  // on the writable layer where a recreate destroyed it.
  it("mounts the pihome volume at the HOME pi actually uses", () => {
    // The explicit ENV is the whole fix — without it docker picks the wrong
    // passwd entry for the duplicated uid.
    expect(dockerfile).toMatch(/^ENV HOME=\/home\/companion$/m);
    expect(CONTAINER.home).toBe("/home/companion");
    // …and the volume must sit INSIDE that home, or auth.json misses it again.
    expect(CONTAINER.piHome.startsWith(`${CONTAINER.home}/`)).toBe(true);
    expect(dockerfile).toContain(`VOLUME ["${CONTAINER.piHome}"]`);
    // The session dir the spawn names must be on the volume too — that is the
    // only reason the conversation survived when the token did not.
    const pi = new CompanionLifecycle(CFG, async () => OK, {}, { exists: () => false, read: () => undefined, mode: () => undefined }).piArgv();
    const sessionDir = pi[pi.indexOf("--session-dir") + 1]!;
    expect(sessionDir.startsWith(`${CONTAINER.piHome}/`)).toBe(true);
    // And the entrypoint says so out loud when it is not a mount point.
    expect(entrypoint).toContain("/proc/mounts");
    expect(entrypoint).toContain("NOT a mount point");
  });

  // 2026-08-21: the vendored mattpocock set is REGISTERED, not just readable.
  // `.claude/skills` is not one of pi's own lookup paths, so without the
  // settings `skills` array the 25 skills were plain files the system prompt
  // had to name one at a time — no descriptions in context, no invocation,
  // no progressive disclosure.
  it("registers the vendored skill set with pi, guarded on the dir existing", () => {
    expect(entrypoint).toContain('const skillsDir = "/workspace/.claude/skills"');
    expect(entrypoint).toMatch(/if \(!Array\.isArray\(cfg\.skills\)\) cfg\.skills = \[\]/);
    // Degrade, never wedge: an unmounted /workspace leaves the companion
    // under-equipped, not unable to start.
    expect(entrypoint).toMatch(/fs\.existsSync\(skillsDir\)/);
    // Dedupe — the volume carries settings.json across every restart.
    expect(entrypoint).toMatch(/cfg\.skills\.includes\(skillsDir\)/);
    // `/skill:<name>` from pi's own input line: the companion column is a
    // terminal, so the owner's `/` commands land in pi. Unconditional, because
    // seed-only-if-absent is how keys stopped landing once pi wrote settings.
    expect(entrypoint).toContain("cfg.enableSkillCommands = true");
    const guard = entrypoint.indexOf("const skillsDir");
    expect(guard).toBeGreaterThan(0);
    expect(entrypoint.indexOf("fs.writeFileSync(path,")).toBeGreaterThan(guard);
  });

  // A registration pointing at nothing is worse than none: it reads as done.
  it("points at a directory that really carries SKILL.md folders", () => {
    const dir = resolve(root, ".claude/skills");
    expect(existsSync(dir)).toBe(true);
    const skills = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .filter((e) => existsSync(resolve(dir, e.name, "SKILL.md")));
    expect(skills.length).toBeGreaterThan(20);
    expect(skills.map((e) => e.name)).toContain("wayfinder");
    // The two wayfinder leans on, named in prompts/companion.md.
    expect(skills.map((e) => e.name)).toEqual(expect.arrayContaining(["grilling", "domain-modeling"]));
  });

  // our OWN skills are a SECOND registered directory. `.claude/skills`
  // is a pinned vendored copy re-copied wholesale on an upstream bump, so a
  // companion skill we author cannot live there.
  it("registers our own skills tree as a second entry, guarded independently", () => {
    expect(entrypoint).toContain('const ourSkillsDir = "/workspace/skills/companion"');
    expect(entrypoint).toMatch(/fs\.existsSync\(ourSkillsDir\)/);
    expect(entrypoint).toMatch(/cfg\.skills\.includes\(ourSkillsDir\)/);
    expect(entrypoint).toMatch(/cfg\.skills\.push\(ourSkillsDir\)/);
    // The vendored entry keeps its own guard and its own push — one missing
    // dir must never take the other registration down with it.
    expect(entrypoint).toMatch(/cfg\.skills\.push\(skillsDir\)/);
    const vendored = entrypoint.indexOf("const skillsDir");
    const ours = entrypoint.indexOf("const ourSkillsDir");
    expect(vendored).toBeGreaterThan(0);
    expect(ours).toBeGreaterThan(vendored);
    expect(entrypoint.indexOf("fs.writeFileSync(path,")).toBeGreaterThan(ours);
    // Degrade loudly and separately: "the vendored set is there" must never
    // read as "adjudicate is there".
    expect(entrypoint).toMatch(/if \(!ourSkillsPresent\) console\.log/);
  });

  // A registration pointing at nothing is worse than none (same rule as the
  // vendored set): the directory has to really carry the skill.
  it("ships the adjudicate skill in the directory it registers", () => {
    const dir = resolve(root, "skills/companion");
    expect(existsSync(dir)).toBe(true);
    const skill = resolve(dir, "adjudicate/SKILL.md");
    expect(existsSync(skill)).toBe(true);
    const body = readFileSync(skill, "utf8");
    // pi selects a skill from its description alone (§4).
    expect(body).toMatch(/^---\nname: adjudicate\ndescription: .+/);
    // The doctrine's load-bearing rules, pinned so a rewrite cannot quietly
    // drop one. Prose is hard-wrapped, so match on a flattened copy
    // — a phrase pin must not fail on where the line happened to break.
    const flat = body.replace(/\s+/g, " ");
    expect(flat).toMatch(/survive contact with the code/i);
    expect(flat).toMatch(/falsifier/i);
    expect(flat).toMatch(/never a confidence number/i);
    expect(flat).toMatch(/counter-case is mandatory/i);
    expect(flat).toMatch(/#adjudication/);
    // the ratifying turn, and that it dies with the session.
    expect(flat).toMatch(/void at session end/i);
  });

  // Rule 9: lens passes are leaves. A charting/planning skill set is nothing a
  // reviewer session should be able to reach for mid-round, so the VM image
  // deliberately does NOT get this registration.
  it("keeps the skill set off the VM image — reviewer passes are leaves", () => {
    const vmEntrypoint = readFileSync(resolve(root, "deploy/ansible/templates/entrypoint.sh.j2"), "utf8");
    expect(vmEntrypoint).not.toMatch(/settings\.skills/);
    expect(vmEntrypoint).not.toMatch(/enableSkillCommands/);
    expect(vmEntrypoint).not.toMatch(/\.claude\/skills/);
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
    expect(entrypoint).toMatch(/wait "\$child" \|\| true/);
    expect(entrypoint.trimEnd().endsWith("exit 0")).toBe(true);
    expect(entrypoint).not.toContain("exec pi");
  });

  // PID 1 has NO default signal dispositions, so `exec sleep infinity`
  // ignored SIGTERM outright and every `docker stop` burned its full 10s
  // timeout before SIGKILL — measured at 10.1s. The TUI runs that stop after
  // restoring the terminal, so it read as a hung shell on every quit.
  it("gives PID 1 a SIGTERM handler, so `docker stop` is immediate", () => {
    expect(entrypoint).toMatch(/trap term TERM INT/);
    expect(entrypoint).toMatch(/sleep infinity &/);
    // `exec sleep` is the regression: it makes sleep PID 1, and sleep installs
    // no handler, so the signal is ignored rather than defaulted. Mechanism,
    // not mention — the comment explaining WHY it is gone names it, and must
    // be allowed to; a command line reintroducing it must not.
    const commands = entrypoint.split("\n").filter((l) => !/^\s*#/.test(l));
    expect(commands.join("\n")).not.toContain("exec sleep");
  });
});
