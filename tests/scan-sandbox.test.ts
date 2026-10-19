// The scan sandbox (src/scanbox.ts): `qcr scan start` with `[scan] sandbox =
// "docker"` runs its driver in a throwaway container from the companion image.
// Docker is a port here — every call is recorded and answered from a script —
// so these tests pin the exact argv (the mount list above all), the env, every
// refusal, the started handshake over the state home, and the build stamp;
// `qcr scan login` / `doctor`, the image's build, its ignore list and its
// one-shot entrypoint mode are pinned beside them.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  COMPANION_DEFAULTS,
  parseConfig,
  SCAN_IMAGE_DEFAULT,
  resolveCompanionPaths,
  type ScanSandboxConfig,
} from "../src/config.js";
import { appStamp, BAKED_PATHS } from "../src/appstamp.js";
import {
  DRIVER_LOG_ENV,
  IN_SANDBOX_ENV,
  SCANBOX,
  STAMP_LABEL,
  STARTED_FILE_ENV,
  dockerDetach,
  buildScanImage,
  effectiveSandbox,
  renderDoctor,
  scanDoctor,
  SCAN_AUTH_COPY_SCRIPT,
  loginInPi,
  scanLoginRoute,
  scanMounts,
  scanRunArgv,
  writeStartedFile,
  type ScanBoxPlan,
} from "../src/scanbox.js";
import { SCAN_AUTH_SRC_ENV, SCAN_CASE_AUTH_BUDGET_MS } from "../src/engine/auth.js";
import { scanEnv } from "../src/scancli.js";
import {
  CompanionLifecycle,
  imageBuildProblem,
  IN_COMPANION_ENV,
  MEMORY,
  PUBLIC_DNS,
  type DockerResult,
  type DockerRunner,
} from "../src/tui/companion.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureToml = readFileSync(resolve(root, "tests/fixtures/config.toml"), "utf8");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-scanbox-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const OK: DockerResult = { ok: true, stdout: "", stderr: "", code: 0 };
const fail = (stderr: string): DockerResult => ({ ok: false, stdout: "", stderr, code: 1 });

/** Records every docker call; answers from the first matching rule, else a
 * failure naming the call. */
function fakeDocker(rules: Array<(argv: string[]) => DockerResult | undefined>): {
  docker: DockerRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    docker: async (argv) => {
      calls.push(argv);
      for (const r of rules) {
        const a = r(argv);
        if (a) return a;
      }
      return fail(`unscripted: docker ${argv.join(" ")}`);
    },
  };
}

const SANDBOX: ScanSandboxConfig = {
  sandbox: "docker",
  sandbox_set: false,
  pihome_volume: "companion-pihome",
  image: "qcr-companion",
};

describe("[scan] sandbox, pihome_volume and image", () => {
  it("default to the docker sandbox, the companion's pi home volume and the scan image", () => {
    const cfg = parseConfig(fixtureToml);
    expect(cfg.scan_sandbox).toEqual({
      sandbox: "docker",
      sandbox_set: false,
      pihome_volume: cfg.companion.pihome_volume,
      image: SCAN_IMAGE_DEFAULT,
    });
    // Not the companion's image: that is the release image in companion mode
    // (P7.8), which the sandbox's one-shot entrypoint does not serve.
    expect(SCAN_IMAGE_DEFAULT).not.toBe(cfg.companion.image);
    expect(cfg.scan_sandbox.pihome_volume).toBe("companion-pihome");
  });

  it("follow the install's companion pi home when [companion] pihome_volume is renamed and [scan]'s is not", () => {
    const toml = fixtureToml.replace(
      "[companion]",
      '[companion]\npihome_volume = "companion-pihome-selfscan"',
    );
    expect(parseConfig(toml).scan_sandbox.pihome_volume).toBe("companion-pihome-selfscan");
  });

  it("keep the scan image when [companion] image is renamed", () => {
    const toml = fixtureToml.replace("[companion]", '[companion]\nimage = "my-companion"');
    expect(parseConfig(toml).scan_sandbox.image).toBe(SCAN_IMAGE_DEFAULT);
  });

  it("are read from [scan], beside its other keys, and kept out of the scan settings", () => {
    const cfg = parseConfig(
      `${fixtureToml}\n[scan]\nsandbox = "host"\npihome_volume = "v2"\nimage = "img:1"\ndepth = "deep"\n`,
    );
    expect(cfg.scan_sandbox).toEqual({
      sandbox: "host",
      sandbox_set: true,
      pihome_volume: "v2",
      image: "img:1",
    });
    expect(cfg.scan.depth).toBe("deep");
    expect(cfg.scan).not.toHaveProperty("sandbox");
    expect(cfg.scan).not.toHaveProperty("pihome_volume");
    expect(cfg.scan).not.toHaveProperty("image");
  });

  it("refuse a sandbox that is neither docker nor host, and an empty name", () => {
    expect(() => parseConfig(`${fixtureToml}\n[scan]\nsandbox = "vm"\n`)).toThrow(
      /\[scan\] sandbox must be "docker" or "host"/,
    );
    expect(() => parseConfig(`${fixtureToml}\n[scan]\npihome_volume = ""\n`)).toThrow(
      /\[scan\] pihome_volume must be a non-empty name/,
    );
    expect(() => parseConfig(`${fixtureToml}\n[scan]\nimage = 3\n`)).toThrow(
      /\[scan\] image must be a non-empty name/,
    );
  });

  it("are documented in config.example.toml's [scan]", () => {
    const example = readFileSync(resolve(root, "config.example.toml"), "utf8");
    const scan = example.slice(example.indexOf("\n[scan]\n"));
    const table = scan.slice(0, scan.indexOf("\n[", 2));
    expect(table).toMatch(/^sandbox = "docker"/m);
    expect(table).toMatch(/^#\s*pihome_volume = /m);
    expect(table).not.toContain("scan-pihome");
    expect(table).toMatch(/^#\s*image = /m);
    // And the example still parses with them.
    expect(parseConfig(example).scan_sandbox.sandbox).toBe("docker");
  });
});

describe("the build stamp", () => {
  function app(): string {
    const a = join(dir, "app");
    for (const [p, t] of Object.entries({
      "package.json": "{}",
      "dist/src/cli.js": "x",
      "agents/pass-a.md": "a",
      "prompts/p.md": "p",
      "node_modules/x/index.js": "ignored",
      "state/run.json": "ignored",
    })) {
      mkdirSync(dirname(join(a, p)), { recursive: true });
      writeFileSync(join(a, p), t);
    }
    return a;
  }

  it("is the same for the same baked files, and moves when one of them does", () => {
    const a = app();
    const s1 = appStamp(a);
    expect(s1).toMatch(/^[0-9a-f]{16}$/);
    expect(appStamp(a)).toBe(s1);
    writeFileSync(join(a, "node_modules/x/index.js"), "changed");
    writeFileSync(join(a, "state/run.json"), "changed");
    expect(appStamp(a)).toBe(s1);
    writeFileSync(join(a, "dist/src/cli.js"), "y");
    expect(appStamp(a)).not.toBe(s1);
  });

  it("covers what the image copies, and the image's ignore list admits exactly that", () => {
    expect([...BAKED_PATHS]).toEqual(
      expect.arrayContaining(["package.json", "package-lock.json", "dist", "agents", "prompts"]),
    );
    const ignore = readFileSync(resolve(root, ".dockerignore"), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("#"));
    expect(ignore[0]).toBe("*");
    expect(ignore.filter((l) => l.startsWith("!")).sort()).toEqual(
      BAKED_PATHS.map((p) => `!${p}`).sort(),
    );
    // What the stamp never descends, the image never copies.
    expect(ignore.slice(-2)).toEqual(["**/node_modules", "**/.git"]);
    const dockerfile = readFileSync(resolve(root, "docker/companion/Dockerfile"), "utf8");
    for (const p of BAKED_PATHS.filter((x) => x !== "docker/companion"))
      expect(dockerfile, p).toMatch(new RegExp(`^COPY [^\\n]*\\b${p}\\b`, "m"));
    expect(dockerfile).toContain(`LABEL ${STAMP_LABEL}="\${BUILD_SHA}"`);
    expect(dockerfile).toContain(`WORKDIR /workspace`);
    expect(dockerfile).toMatch(/npm ci --omit=dev/);
  });
});

describe("the companion image build", () => {
  const cfg = resolveCompanionPaths({ ...COMPANION_DEFAULTS, repo_dir: "/host/rs" }, "/host/rs");

  // The companion is the release image (P7.8): the scan sandbox's image is a
  // separate build (`qcr scan rebuild`, below), so a companion rebuild can
  // never replace the image the sandbox's one-shot entrypoint needs.
  it("builds from the app root with the release Dockerfile, stamped, with no uid baked in", async () => {
    expect(cfg.build_context).toBe("/host/rs");
    const { docker, calls } = fakeDocker([(a) => (a[0] === "build" ? OK : undefined)]);
    const lc = new CompanionLifecycle(
      cfg,
      docker,
      { HOME: "/host/home" },
      () => {},
      { exists: () => true, read: () => undefined, mode: () => undefined },
      () => "0123456789abcdef",
      "docker",
      // The assembled release context is the checkout itself here, so the
      // argv names the app root (the copy is tui-companion.test.ts's case).
      (ctx) => ctx,
    );
    await lc.buildImage();
    expect(calls).toEqual([
      [
        "build",
        "-t",
        COMPANION_DEFAULTS.image,
        "-f",
        "/host/rs/docker/Dockerfile",
        "--build-arg",
        "BUILD_SHA=0123456789abcdef",
        "/host/rs",
      ],
    ]);
  });

  it("refuses to build when the release Dockerfile is not under the build context", async () => {
    const { docker, calls } = fakeDocker([]);
    const lc = new CompanionLifecycle(
      cfg,
      docker,
      { HOME: "/host/home" },
      () => {},
      { exists: () => false, read: () => undefined, mode: () => undefined },
      () => "s",
    );
    expect(() => lc.checkBuildable()).toThrow(/release Dockerfile.*docker\/Dockerfile/);
    await expect(lc.buildImage()).rejects.toThrow(/release Dockerfile/);
    expect(calls).toEqual([]);
  });

  it("needs no host build: the release image compiles the app itself", () => {
    expect(imageBuildProblem("/ctx", (p) => p === "/ctx/docker/Dockerfile")).toBeNull();
  });
});

describe("the one-shot entrypoint mode", () => {
  const entrypoint = readFileSync(resolve(root, "docker/companion/entrypoint.sh"), "utf8");

  it("with a command: merges pi's settings, then execs it — no tmux, no sleep", () => {
    expect(entrypoint).toMatch(/if \[ "\$#" -gt 0 \]; then\s*\n\s*ENTRY_MODE=oneshot/);
    const exec = entrypoint.indexOf('exec "$@"');
    expect(exec).toBeGreaterThan(
      entrypoint.indexOf("PI_EXT_MERGE\n", entrypoint.indexOf("node <<")),
    );
    expect(exec).toBeLessThan(entrypoint.indexOf("tmux start-server"));
    expect(entrypoint).toContain(`"\${${DRIVER_LOG_ENV}:-}"`);
  });

  it("the pi-home durability guard is the companion's: a scan's tmpfs pi home is meant to vanish", () => {
    const guard = entrypoint.indexOf("if ! awk");
    const opener = entrypoint.lastIndexOf('if [ "$ENTRY_MODE" = companion ]; then', guard);
    expect(opener).toBeGreaterThan(-1);
    expect(entrypoint.slice(opener, guard)).not.toMatch(/\nfi\n/);
  });

  it("the one-shot merge skips the /workspace skills, agents and trust", () => {
    const m = /node <<'PI_EXT_MERGE'\n([\s\S]*?)\nPI_EXT_MERGE\n/.exec(entrypoint)!;
    const home = join(dir, "home");
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    execFileSync(process.execPath, ["-"], {
      input: m[1],
      env: { PATH: process.env.PATH ?? "", HOME: home, QCR_ENTRY_MODE: "oneshot" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const settings = JSON.parse(
      readFileSync(join(home, ".pi", "agent", "settings.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(settings["defaultProjectTrust"]).toBe("always");
    expect(settings["extensions"]).toContain("-builtin:mcp");
    expect(settings["skills"] ?? []).toEqual([]);
    expect(existsSync(join(home, ".pi", "agent", "agents"))).toBe(false);
    expect(existsSync(join(home, ".pi", "agent", "trust.json"))).toBe(false);
  });
});

// ---- the container --------------------------------------------------------------

const PLAN: ScanBoxPlan = {
  name: "qcr-scan-default-tok1",
  image: "qcr-companion",
  pihomeVolume: "companion-pihome",
  reviewedRepo: "/host/app",
  gitDirs: [],
  stateHome: "/host/state",
  configMirror: "/host/opstate/scan-config",
  profiles: "/host/config/profiles",
  install: "default",
  token: "tok1",
  keysFile: "/host/opstate/scan-memory-keys.env",
  memory: {
    network: MEMORY.network,
    endpoint: "http://198.51.100.1:1933",
    keysFile: "/host/keys.env",
    notes: [],
  },
};

describe("the scan container's argv", () => {
  it("mounts the reviewed repo read-only, the state home, the companion's login read-only and the config — nothing else", () => {
    expect(scanMounts(PLAN)).toEqual([
      { dest: "/reviewed-repo", source: "/host/app", mode: "ro" },
      { dest: "/qcr-state", source: "/host/state", mode: "rw" },
      { dest: "/pi-agent-src", source: "companion-pihome", subpath: "agent", mode: "ro" },
      { dest: "/pi-agent-src/sessions", source: "", tmpfs: true },
      { dest: "/home/companion/.pi", source: "", tmpfs: true, tmpfsMode: "1777" },
      { dest: "/qcr-config/live", source: "/host/opstate/scan-config", mode: "ro" },
      { dest: "/qcr-config/profiles", source: "/host/config/profiles", mode: "ro" },
    ]);
    // The companion's pi home is mounted read-only at the source path, and
    // never at the pi home: no mount of it can be written.
    const vols = scanMounts(PLAN).filter((m) => m.source === "companion-pihome");
    expect(vols).toEqual([expect.objectContaining({ dest: "/pi-agent-src", mode: "ro" })]);
    const dests = scanMounts(PLAN).map((m) => m.dest);
    for (const never of ["/workspace", "/tracker", "/github-read", "/evidence", "/feed", "/alerts"])
      expect(dests).not.toContain(never);
  });

  it("a worktree's git dir is mounted read-only where it sits, so git resolves it", () => {
    const m = scanMounts({ ...PLAN, gitDirs: ["/host/main/.git"] });
    expect(m[1]).toEqual({ dest: "/host/main/.git", source: "/host/main/.git", mode: "ro" });
    expect(m).toHaveLength(8);
  });

  it("runs the foreground driver in a removed-at-exit container, on the memory network", () => {
    const argv = scanRunArgv(PLAN, ["start", "--key", "K", "--sha", "abc"]);
    expect(argv).toEqual([
      "run",
      "--rm",
      "--detach",
      "--init",
      "--name",
      "qcr-scan-default-tok1",
      "--label",
      "qcr.scan=default",
      "--network",
      MEMORY.network,
      ...PUBLIC_DNS.flatMap((d) => ["--dns", d]),
      "--mount",
      "type=bind,src=/host/app,dst=/reviewed-repo,readonly",
      "--mount",
      "type=bind,src=/host/state,dst=/qcr-state",
      "--mount",
      "type=volume,src=companion-pihome,dst=/pi-agent-src,volume-subpath=agent,readonly",
      "--mount",
      "type=tmpfs,dst=/pi-agent-src/sessions",
      "--mount",
      "type=tmpfs,dst=/home/companion/.pi,tmpfs-mode=1777",
      "--mount",
      "type=bind,src=/host/opstate/scan-config,dst=/qcr-config/live,readonly",
      "--mount",
      "type=bind,src=/host/config/profiles,dst=/qcr-config/profiles,readonly",
      "--env",
      "QCR_ROOT=/opt/qcr",
      "--env",
      "QCR_CONFIG=/qcr-config/live/config.toml",
      "--env",
      "QCR_CONFIG_HOME=/qcr-config",
      "--env",
      "QCR_STATE_HOME=/qcr-state",
      "--env",
      "QCR_REVIEWED_REPO=/reviewed-repo",
      "--env",
      "QCR_INSTALL=default",
      "--env",
      `${IN_SANDBOX_ENV}=1`,
      "--env",
      `${STARTED_FILE_ENV}=/qcr-state/scan/started/tok1.json`,
      "--env",
      `${DRIVER_LOG_ENV}=/qcr-state/scan/driver.log`,
      "--env",
      `${SCAN_AUTH_SRC_ENV}=/pi-agent-src`,
      "--env",
      "PI_CODING_AGENT_DIR=/home/companion/.pi/agent",
      "--env",
      "OPENVIKING_URL=http://198.51.100.1:1933",
      "--env",
      "OPENVIKING_BASE_URL=http://198.51.100.1:1933",
      "--env",
      `OPENVIKING_USER=${MEMORY.user}`,
      "--env",
      `OPENVIKING_PEER_ID=${MEMORY.peerId}`,
      "--env",
      "QCR_MEMORY_ENDPOINT=http://198.51.100.1:1933",
      "--env",
      "QCR_MEMORY_ALERTS_DIR=/alerts",
      // The reviewer key alone, never the companion's whole key file.
      "--env-file",
      "/host/opstate/scan-memory-keys.env",
      "qcr-companion",
      "node",
      SCANBOX.cli,
      "scan",
      "start",
      "--key",
      "K",
      "--sha",
      "abc",
      "--foreground",
      "--json",
    ]);
    // No GitHub token, no ssh, no tracker reach the container.
    const flat = argv.join(" ");
    expect(flat).not.toMatch(/GITHUB|\.ssh|SSH_AUTH_SOCK|QCR_TRACKER_DIR|\/workspace/);
    expect(argv).not.toContain("/host/keys.env");
    expect(argv).not.toContain("--volume");
  });

  it("memory-less wiring: no network, no memory env — the scan still runs", () => {
    const argv = scanRunArgv(
      { ...PLAN, keysFile: undefined, memory: { network: "", endpoint: "", notes: [] } },
      ["start", "--key", "K"],
    );
    expect(argv).not.toContain("--network");
    expect(argv.join(" ")).not.toMatch(/OPENVIKING|--env-file/);
  });

  const companionOf = {
    container_name: "qcr-companion",
    pihome_volume: "companion-pihome",
    model: "openai-codex/gpt-6.1-sol:medium",
  };
  const LOGIN = loginInPi();
  const companionDocker =
    (state: string | null): DockerRunner =>
    async (a) =>
      a[0] === "inspect"
        ? state === null
          ? fail("Error: No such object: qcr-companion")
          : { ...OK, stdout: `${state}\n` }
        : fail("unscripted");

  it("`qcr scan login` opens pi with /login already typed and sent: every login pi offers", () => {
    const [sh, c, script] = loginInPi();
    expect([sh, c]).toEqual(["sh", "-c"]);
    expect(script).toMatch(/tmux new-session -d -s "\$s" pi/);
    // Keys go in once pi's input box is drawn, and again until its login
    // menu shows: an Enter sent while pi still starts is lost.
    expect(script).toContain("grep -cF '──────────'");
    expect(script).toContain("Select authentication");
    expect(script).toMatch(/tmux send-keys -t "\$s" -l '\/login'/);
    expect(script).not.toContain("/ commands");
    expect(script).toMatch(/exec tmux attach -t "\$s"/);
  });

  it("`qcr scan login --provider P` types /login P; a provider that is not a plain name is refused", () => {
    expect(loginInPi("anthropic")[2]).toMatch(/send-keys -t "\$s" -l '\/login anthropic'/);
    expect(() => loginInPi("x'; rm -rf /")).toThrow(/provider/);
  });

  it("`qcr scan login` with the companion running: pi inside the companion", async () => {
    const r = await scanLoginRoute(companionDocker("true"), SANDBOX, companionOf);
    expect(r.route).toBe("exec");
    expect(r.argv).toEqual(["exec", "-it", "qcr-companion", ...LOGIN]);
    expect(r.say).toMatch(/running/);
    expect(r.say).toMatch(/qcr-companion/);
  });

  it("`qcr scan login` with the companion stopped or absent: pi in a throwaway container over its pi home, read-write", async () => {
    for (const state of ["false", null]) {
      const r = await scanLoginRoute(companionDocker(state), SANDBOX, companionOf);
      expect(r.route).toBe("run");
      expect(r.argv).toEqual([
        "run",
        "--rm",
        "-it",
        ...PUBLIC_DNS.flatMap((d) => ["--dns", d]),
        "--mount",
        "type=volume,src=companion-pihome,dst=/home/companion/.pi",
        "--env",
        "QCR_PI_DEFAULT_MODEL=openai-codex/gpt-6.1-sol:medium",
        "qcr-companion",
        ...LOGIN,
      ]);
      expect(r.say).toMatch(/not running/);
      expect(r.say).toMatch(/companion-pihome/);
    }
  });

  it("`qcr scan login` over an overridden [scan] pihome_volume never execs into the companion", async () => {
    const r = await scanLoginRoute(
      companionDocker("true"),
      { ...SANDBOX, pihome_volume: "other-pihome" },
      companionOf,
      "anthropic",
    );
    expect(r.route).toBe("run");
    expect(r.argv).toContain("type=volume,src=other-pihome,dst=/home/companion/.pi");
    expect(r.argv.slice(-3)).toEqual(loginInPi("anthropic"));
  });
});

// ---- the launch -----------------------------------------------------------------

/** The launch tests' clock: their sleep advances it, a rule may too. */
const clock = { t: 0 };

/** The driver's `docker run`, not the read of the companion's login. */
const isDriverRun = (c: string[]): boolean => c[0] === "run" && c.includes("--detach");
/** The read of the companion's login: a one-shot over its pi home, read-only. */
const isLoginRead = (c: string[]): boolean => c[0] === "run" && c.includes("--input-type=module");
const loginAnswer =
  (summary: unknown) =>
  (a: string[]): DockerResult | undefined =>
    isLoginRead(a) ? { ...OK, stdout: `${JSON.stringify(summary)}\n` } : undefined;
const GOOD_LOGIN = { "openai-codex": { type: "oauth", expires: 1e15 } };

describe("the sandboxed launch", () => {
  const RUN = { id: "scan-1", mode: "stage1", sha: "a".repeat(40), cases: [], cap_usd: 1 };

  function setup(
    rules: Array<(argv: string[]) => DockerResult | undefined>,
    over: Partial<Parameters<typeof dockerDetach>[0]> = {},
    login: unknown = GOOD_LOGIN,
  ) {
    const env = { HOME: dir } as NodeJS.ProcessEnv;
    const home = join(dir, ".local/state/qcr/default");
    const repo = join(dir, "app");
    mkdirSync(repo, { recursive: true });
    const config = join(dir, "config.toml");
    writeFileSync(config, "# the live config\n");
    // The pi home volume exists unless a test's own rule says otherwise.
    const { docker, calls } = fakeDocker([
      loginAnswer(login),
      ...rules,
      (a) => (a[0] === "volume" && a[1] === "inspect" ? OK : undefined),
    ]);
    clock.t = 0;
    const detach = dockerDetach({
      docker,
      env,
      sandbox: SANDBOX,
      reviewedRepo: repo,
      appRoot: root,
      stamp: () => "s1",
      configSource: () => config,
      gitDirs: () => ({ ok: true, mounts: [] }),
      memory: async () => ({ network: "", endpoint: "", notes: [] }),
      token: () => "tok1",
      sleep: async (ms) => {
        clock.t += ms;
      },
      now: () => clock.t,
      timeoutMs: 10_000,
      pollMs: 500,
      ...over,
    });
    return { env, home, repo, calls, detach };
  }

  const stamped = (stamp: string) => (a: string[]) =>
    a[0] === "image" && a[1] === "inspect" ? { ...OK, stdout: `${stamp}\n` } : undefined;

  it("returns the driver's own started outcome, written to the state home, with the host log", async () => {
    let started = "";
    const { home, calls, detach } = setup([
      stamped("s1"),
      (a) => {
        if (a[0] !== "run") return undefined;
        // The driver inside writes its outcome where its env says.
        const inside = a.find((x) => x.startsWith(`${STARTED_FILE_ENV}=`))!.split("=")[1]!;
        started = join(home, inside.slice("/qcr-state/".length));
        writeStartedFile(started, {
          ok: true,
          run: RUN as never,
          log: "/qcr-state/scan/driver.log",
        });
        return { ...OK, stdout: "c0ffee\n" };
      },
    ]);
    const r = await detach(["start", "--key", "K"]);
    expect(r).toEqual({
      ok: true,
      run: RUN,
      log: join(home, "scan/driver.log"),
      container: "qcr-scan-default-tok1",
    });
    expect(existsSync(started)).toBe(false);
    expect(calls[0]).toEqual([
      "image",
      "inspect",
      "--format",
      `{{index .Config.Labels "${STAMP_LABEL}"}}`,
      "qcr-companion",
    ]);
    const run = calls.find(isDriverRun)!;
    expect(run.slice(-6)).toEqual(["scan", "start", "--key", "K", "--foreground", "--json"]);
    // The config the container reads is a copy of the live one.
    expect(
      readFileSync(join(dir, ".local/state/qcr-operator/default/scan-config/config.toml"), "utf8"),
    ).toBe("# the live config\n");
  });

  it("waits for the outcome while the container runs", async () => {
    let polls = 0;
    const { home, detach } = setup([
      stamped("s1"),
      (a) => (a[0] === "run" ? OK : undefined),
      (a) => {
        if (a[0] !== "inspect") return undefined;
        if (++polls === 3)
          writeStartedFile(join(home, "scan/started/tok1.json"), {
            ok: false,
            errors: ["the key does not match"],
          });
        return { ...OK, stdout: "true\n" };
      },
    ]);
    expect(await detach(["start", "--key", "K"])).toEqual({
      ok: false,
      errors: ["the key does not match"],
    });
    expect(polls).toBeGreaterThanOrEqual(3);
  });

  it("a container gone before it said it started is a refusal naming the driver log", async () => {
    const { home, detach } = setup([
      stamped("s1"),
      (a) => (a[0] === "run" ? OK : undefined),
      (a) =>
        a[0] === "inspect" ? fail("Error: No such object: qcr-scan-default-tok1") : undefined,
    ]);
    expect(await detach(["start", "--key", "K"])).toEqual({
      ok: false,
      errors: [
        `the scan container qcr-scan-default-tok1 exited before the driver started — see ${join(home, "scan/driver.log")}`,
      ],
    });
  });

  it("a driver silent past the timeout has its container removed, and is refused", async () => {
    const { calls, detach } = setup([
      stamped("s1"),
      (a) => (a[0] === "run" ? OK : undefined),
      (a) => (a[0] === "inspect" ? { ...OK, stdout: "true\n" } : undefined),
      (a) => (a[0] === "rm" ? OK : undefined),
    ]);
    const r = await detach(["start", "--key", "K"]);
    expect(r).toMatchObject({
      ok: false,
      errors: [
        expect.stringMatching(/did not say it started within 10s — its container was removed/),
      ],
    });
    expect(calls.at(-1)).toEqual(["rm", "-f", "qcr-scan-default-tok1"]);
  });

  it("refuses an image built from other code, and says how to rebuild it", async () => {
    const { calls, detach } = setup([stamped("old0")]);
    const r = await detach(["start", "--key", "K"]);
    expect(r).toEqual({
      ok: false,
      errors: [
        "the image qcr-companion was built from other code (stamp old0; this checkout is s1) — run `qcr scan rebuild`",
      ],
    });
    expect(calls.some((c) => c[0] === "run")).toBe(false);
  });

  it("refuses an image with no stamp, a missing image and an unreachable docker", async () => {
    expect(await setup([stamped("<no value>")]).detach(["start", "--key", "K"])).toEqual({
      ok: false,
      errors: ["the image qcr-companion carries no build stamp — run `qcr scan rebuild`"],
    });
    const missing = setup([
      (a) => (a[0] === "image" ? fail("Error: No such image: qcr-companion") : undefined),
    ]);
    expect(await missing.detach(["start", "--key", "K"])).toEqual({
      ok: false,
      errors: ["the image qcr-companion is not built — run `qcr scan rebuild`"],
    });
    const down = setup([
      (a) =>
        a[0] === "image"
          ? fail("Cannot connect to the Docker daemon at unix:///var/run/docker.sock")
          : undefined,
    ]);
    expect(await down.detach(["start", "--key", "K"])).toEqual({
      ok: false,
      errors: [
        'docker is not reachable (Cannot connect to the Docker daemon at unix:///var/run/docker.sock) — the scan sandbox needs it; or set [scan] sandbox = "host"',
      ],
    });
  });

  it("refuses without a reviewed repo, or a live config — before any docker call", async () => {
    const gone = setup([], { reviewedRepo: join(dir, "nowhere") });
    expect(await gone.detach(["start", "--key", "K"])).toEqual({
      ok: false,
      errors: [
        `no reviewed repo at ${join(dir, "nowhere")} — set [companion] reviewed_repo_dir (or QCR_REVIEWED_REPO)`,
      ],
    });
    expect(gone.calls).toEqual([]);
    const unset = setup([], { reviewedRepo: "" });
    expect((await unset.detach(["start", "--key", "K"])) as { errors: string[] }).toMatchObject({
      ok: false,
      errors: [expect.stringMatching(/^no reviewed repo is set/)],
    });
    const noConfig = setup([], { configSource: () => undefined });
    expect(await noConfig.detach(["start", "--key", "K"])).toEqual({
      ok: false,
      errors: [
        "no live config to hand the scan container — `qcr install where` shows where it is looked for",
      ],
    });
    expect(noConfig.calls).toEqual([]);
  });

  it("a refused docker run is a refusal with docker's reason", async () => {
    const { detach } = setup([
      stamped("s1"),
      (a) => (a[0] === "run" ? fail("docker: Error response from daemon: Conflict.") : undefined),
    ]);
    expect(await detach(["start", "--key", "K"])).toEqual({
      ok: false,
      errors: ["the scan container could not start: docker: Error response from daemon: Conflict."],
    });
  });

  it("names the container after the install and the token", async () => {
    const { calls, detach } = setup(
      [
        stamped("s1"),
        (a) => (a[0] === "run" ? OK : undefined),
        (a) => (a[0] === "inspect" ? fail("No such object") : undefined),
      ],
      { env: { HOME: dir, QCR_INSTALL: "work" } as NodeJS.ProcessEnv },
    );
    await detach(["start", "--key", "K"]);
    const run = calls.find(isDriverRun)!;
    expect(run[run.indexOf("--name") + 1]).toBe("qcr-scan-work-tok1");
  });

  it("refuses while the companion's pi home volume does not exist — never lets docker make it empty", async () => {
    const { calls, detach } = setup([
      stamped("s1"),
      (a) =>
        a[0] === "volume"
          ? fail("Error response from daemon: get companion-pihome: no such volume")
          : undefined,
    ]);
    expect(await detach(["start", "--key", "K"])).toEqual({
      ok: false,
      errors: [
        "the companion's pi home volume companion-pihome does not exist — run `qcr scan login` to log the companion's pi in",
      ],
    });
    expect(calls.some((c) => c[0] === "run")).toBe(false);
  });

  it("reads the companion's login read-only at the source path, never mounting it writable", async () => {
    const { calls, detach } = setup([
      stamped("s1"),
      (a) => (isDriverRun(a) ? OK : undefined),
      (a) => (a[0] === "inspect" ? fail("No such object") : undefined),
    ]);
    await detach(["start", "--key", "K"]);
    const read = calls.find(isLoginRead)!;
    expect(read).toBeDefined();
    const mounts = calls
      .filter((c) => c[0] === "run")
      .flatMap((c) => c.filter((_, i) => c[i - 1] === "--mount"))
      .filter((m) => m.includes("src=companion-pihome"));
    expect(mounts.length).toBeGreaterThanOrEqual(2);
    for (const m of mounts) {
      expect(m).toContain("dst=/pi-agent-src");
      expect(m.split(",")).toContain("readonly");
    }
    // The login read comes before the driver's run.
    expect(calls.findIndex(isLoginRead)).toBeLessThan(calls.findIndex(isDriverRun));
  });

  it("refuses when the companion's pi home holds no login, naming the fix", async () => {
    const { calls, detach } = setup([stamped("s1")], {}, {});
    const r = await detach(["start", "--key", "K"]);
    expect(r).toMatchObject({ ok: false });
    expect((r as { errors: string[] }).errors[0]).toMatch(/no pi login.*qcr scan login/);
    expect(calls.some(isDriverRun)).toBe(false);
  });

  it("refuses when the access token would not outlive a case, telling the operator to let the companion refresh", async () => {
    const { calls, detach } = setup(
      [stamped("s1")],
      {},
      { "openai-codex": { type: "oauth", expires: SCAN_CASE_AUTH_BUDGET_MS - 1 } },
    );
    const r = await detach(["start", "--key", "K"]);
    expect(r).toMatchObject({ ok: false });
    const why = (r as { errors: string[] }).errors[0]!;
    expect(why).toMatch(/never refreshes/);
    expect(why).toMatch(/open the companion/i);
    expect(why).toMatch(/qcr scan login/);
    expect(calls.some(isDriverRun)).toBe(false);
  });

  it("hands the container the reviewer key alone, in a 0600 file of its own", async () => {
    const keys = join(dir, "keys.env");
    writeFileSync(
      keys,
      "OPENVIKING_API_KEY=root\nOPENVIKING_COMPANION_KEY=comp\nOPENVIKING_REVIEWER_KEY=rev\n",
    );
    const { calls, detach } = setup(
      [
        stamped("s1"),
        (a) => (a[0] === "run" ? OK : undefined),
        (a) => (a[0] === "inspect" ? fail("No such object") : undefined),
      ],
      {
        memory: async () => ({
          network: MEMORY.network,
          endpoint: "http://198.51.100.1:1933",
          keysFile: keys,
          notes: [],
        }),
      },
    );
    await detach(["start", "--key", "K"]);
    const run = calls.find(isDriverRun)!;
    expect(run).not.toContain(keys);
    const file = run[run.indexOf("--env-file") + 1]!;
    expect(file).toBe(join(dir, ".local/state/qcr-operator/default/scan-memory-keys.env"));
    expect(readFileSync(file, "utf8")).toBe("OPENVIKING_REVIEWER_KEY=rev\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(run.join(" ")).toContain(`OPENVIKING_URL=http://198.51.100.1:1933`);
    expect(run.join(" ")).not.toMatch(/root|comp\b/);
  });

  it("no reviewer key: no env file at all", async () => {
    const keys = join(dir, "keys.env");
    writeFileSync(keys, "OPENVIKING_API_KEY=root\n");
    const { calls, detach } = setup(
      [
        stamped("s1"),
        (a) => (a[0] === "run" ? OK : undefined),
        (a) => (a[0] === "inspect" ? fail("No such object") : undefined),
      ],
      {
        memory: async () => ({ network: "", endpoint: "http://x:1", keysFile: keys, notes: [] }),
      },
    );
    await detach(["start", "--key", "K"]);
    expect(calls.find(isDriverRun)).not.toContain("--env-file");
  });

  it("an outcome written as the timeout struck is still the answer", async () => {
    const { home, detach } = setup([
      stamped("s1"),
      (a) => (a[0] === "run" ? OK : undefined),
      (a) => (a[0] === "inspect" ? { ...OK, stdout: "true\n" } : undefined),
      (a) => {
        if (a[0] !== "rm") return undefined;
        writeStartedFile(join(home, "scan/started/tok1.json"), { ok: false, errors: ["late"] });
        return OK;
      },
    ]);
    expect(await detach(["start", "--key", "K"])).toEqual({ ok: false, errors: ["late"] });
  });

  it("refuses a late successful receipt after forcibly removing its driver", async () => {
    const { home, detach } = setup([
      stamped("s1"),
      (a) => (a[0] === "run" ? OK : undefined),
      (a) => (a[0] === "inspect" ? { ...OK, stdout: "true\n" } : undefined),
      (a) => {
        if (a[0] !== "rm") return undefined;
        writeStartedFile(join(home, "scan/started/tok1.json"), {
          ok: true,
          run: { id: "late" },
        } as never);
        return OK;
      },
    ]);
    const outcome = await detach(["start", "--key", "K"]);
    expect(outcome.ok).toBe(false);
    expect(JSON.stringify(outcome)).toMatch(/removed/);
  });

  it("sweeps started files no launch can still be waiting for", async () => {
    const { home, detach } = setup([
      stamped("s1"),
      (a) => (a[0] === "run" ? fail("nope") : undefined),
    ]);
    const dirOf = join(home, "scan/started");
    mkdirSync(dirOf, { recursive: true });
    writeFileSync(join(dirOf, "old.json"), "{}");
    writeFileSync(join(dirOf, "old.json.7.tmp"), "{");
    writeFileSync(join(dirOf, "fresh.json"), "{}");
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(join(dirOf, "old.json"), old, old);
    utimesSync(join(dirOf, "old.json.7.tmp"), old, old);
    await detach(["start", "--key", "K"]);
    expect(readdirSync(dirOf)).toEqual(["fresh.json"]);
  });

  it("bounds the whole launch — docker run and the wait — to the timeout", async () => {
    const { calls, detach } = setup([
      stamped("s1"),
      (a) => {
        if (a[0] !== "run") return undefined;
        clock.t += 8_000; // a slow docker run
        return OK;
      },
      (a) => (a[0] === "inspect" ? { ...OK, stdout: "true\n" } : undefined),
      (a) => (a[0] === "rm" ? OK : undefined),
    ]);
    const r = await detach(["start", "--key", "K"]);
    expect(r).toMatchObject({ ok: false, errors: [expect.stringMatching(/within 10s/)] });
    expect(clock.t).toBeLessThanOrEqual(10_500);
    expect(calls.at(-1)).toEqual(["rm", "-f", "qcr-scan-default-tok1"]);
  });

  it("gives docker run only what is left of the bound, and removes a run that failed", async () => {
    const seen: Array<number | undefined> = [];
    const calls: string[][] = [];
    const { detach } = setup([], {
      docker: async (argv, o) => {
        calls.push(argv);
        if (argv[0] === "image") return { ...OK, stdout: "s1\n" };
        if (isLoginRead(argv)) return { ...OK, stdout: JSON.stringify(GOOD_LOGIN) };
        if (argv[0] === "run") {
          seen.push(o?.timeoutMs);
          return fail("docker timed out after 10000 ms");
        }
        return OK;
      },
    });
    expect(await detach(["start", "--key", "K"])).toMatchObject({ ok: false });
    expect(seen).toEqual([10_000]);
    expect(calls.at(-1)).toEqual(["rm", "-f", "qcr-scan-default-tok1"]);
  });

  it("refuses a host path docker's --mount cannot spell", async () => {
    const repo = join(dir, "a,b");
    mkdirSync(repo, { recursive: true });
    const { calls, detach } = setup([stamped("s1")], { reviewedRepo: repo });
    expect(await detach(["start", "--key", "K"])).toEqual({
      ok: false,
      errors: [
        `the path ${repo} holds a comma, which docker's --mount cannot take — move or link it`,
      ],
    });
    expect(calls.some((c) => c[0] === "run")).toBe(false);
  });
});

describe("the driver inside the sandbox", () => {
  it("assembles over the env the container set — never the [companion] tracker or checkout", () => {
    const env = scanEnv(
      {
        [IN_SANDBOX_ENV]: "1",
        QCR_REVIEWED_REPO: "/reviewed-repo",
        QCR_ROOT: "/opt/qcr",
      },
      "/reviewed-repo",
      () => ({ reviewed_repo_dir: "/host/app", tracker_dir: "/host/tracker" }),
    );
    expect(env.QCR_REVIEWED_REPO).toBe("/reviewed-repo");
    expect(env.QCR_TRACKER_DIR).toBeUndefined();
  });

  it("on the host the [companion] checkout and tracker still fill in", () => {
    const env = scanEnv({ QCR_ROOT: "/r" }, "/reviewed-repo", () => ({
      reviewed_repo_dir: "/host/app",
      tracker_dir: "/host/tracker",
    }));
    expect(env.QCR_REVIEWED_REPO).toBe("/host/app");
    expect(env.QCR_TRACKER_DIR).toBe("/host/tracker");
  });

  it("writes its started outcome atomically, whole", () => {
    const f = join(dir, "scan/started/t.json");
    writeStartedFile(f, { ok: false, errors: ["x"] });
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ ok: false, errors: ["x"] });
  });
});

// ---- doctor ---------------------------------------------------------------------

describe("qcr scan doctor", () => {
  function doctor(
    rules: Array<(argv: string[]) => DockerResult | undefined>,
    over: Partial<Parameters<typeof scanDoctor>[0]> = {},
  ) {
    const { docker, calls } = fakeDocker(rules);
    const repo = join(dir, "app");
    mkdirSync(repo, { recursive: true });
    return {
      calls,
      report: scanDoctor({
        sandbox: SANDBOX,
        docker,
        stamp: () => "s1",
        reviewedRepo: repo,
        gitDirs: () => ({ ok: true, mounts: [] }),
        cut: () => ({ saved: true, problems: [] }),
        model: "openai-codex/gpt-6.1-sol:medium",
        now: () => 0,
        ...over,
      }),
      repo,
    };
  }
  const HOUR = 3_600_000;
  const all = [
    (a: string[]) => (a[0] === "version" ? { ...OK, stdout: "27.1.0\n" } : undefined),
    (a: string[]) => (a[0] === "image" ? { ...OK, stdout: "s1\n" } : undefined),
    (a: string[]) => (a[0] === "volume" ? { ...OK, stdout: "[]" } : undefined),
    loginAnswer({ "openai-codex": { type: "oauth", expires: 3 * HOUR + 12 * 60_000 } }),
    (a: string[]) => (a[0] === "run" ? { ...OK, stdout: "OK\n" } : undefined),
  ];
  const probeOf = (calls: string[][]) => calls.find((c) => c[0] === "run" && !isLoginRead(c));

  it("passes every check on a ready machine, and says what it probed", async () => {
    const { report, calls, repo } = doctor(all);
    const r = await report;
    expect(r.ok).toBe(true);
    expect(r.sandbox).toBe("docker");
    expect(r.reviewed_repo).toBe(repo);
    expect(r.checks.map((c) => [c.check, c.ok])).toEqual([
      ["docker", true],
      ["image", true],
      ["pihome", true],
      ["reviewed_repo", true],
      ["unit_cut", true],
    ]);
    // The pi home check reports the login and its remaining life.
    const pihome = r.checks.find((c) => c.check === "pihome")!;
    expect(pihome.detail).toMatch(/companion-pihome/);
    expect(pihome.detail).toMatch(/openai-codex/);
    expect(pihome.detail).toMatch(/3h 12m/);
    // The login is read over a read-only mount at the source path.
    const read = calls.find(isLoginRead)!;
    expect(read).toContain(
      "type=volume,src=companion-pihome,dst=/pi-agent-src,volume-subpath=agent,readonly",
    );
    // The probe runs on a private, refresh-disabled copy — the scan's own route.
    expect(probeOf(calls)).toEqual([
      "run",
      "--rm",
      ...PUBLIC_DNS.flatMap((d) => ["--dns", d]),
      "--mount",
      "type=volume,src=companion-pihome,dst=/pi-agent-src,volume-subpath=agent,readonly",
      "--mount",
      "type=tmpfs,dst=/pi-agent-src/sessions",
      "--mount",
      "type=tmpfs,dst=/home/companion/.pi,tmpfs-mode=1777",
      "--env",
      `${SCAN_AUTH_SRC_ENV}=/pi-agent-src`,
      "--env",
      "PI_CODING_AGENT_DIR=/home/companion/.pi/agent",
      "qcr-companion",
      "sh",
      "-c",
      'node --input-type=module -e "$0" && exec pi "$@"',
      SCAN_AUTH_COPY_SCRIPT,
      "-p",
      "--no-session",
      "--no-extensions",
      "--model",
      "openai-codex/gpt-6.1-sol:medium",
      "Reply with the single word OK.",
    ]);
    // No probe ever mounts the companion's pi home writable.
    for (const c of calls.filter((x) => x[0] === "run"))
      for (const m of c.filter((_, i) => c[i - 1] === "--mount"))
        if (m.includes("src=companion-pihome")) expect(m.split(",")).toContain("readonly");
    expect(renderDoctor(r)).toMatch(/^✓ docker/m);
    expect(renderDoctor(r)).toMatch(/all checks pass/i);
  });

  it("a stamp mismatch fails the image check with the rebuild fix", async () => {
    const r = await doctor([
      all[0]!,
      (a) => (a[0] === "image" ? { ...OK, stdout: "s0\n" } : undefined),
      ...all.slice(2),
    ]).report;
    const image = r.checks.find((c) => c.check === "image")!;
    expect(r.ok).toBe(false);
    expect(image).toMatchObject({ ok: false, fix: "qcr scan rebuild" });
  });

  it("no volume yet is not logged in — and no container is run to find out", async () => {
    const { report, calls } = doctor([
      all[0]!,
      all[1]!,
      (a) => (a[0] === "volume" ? fail("Error: no such volume: companion-pihome") : undefined),
    ]);
    const r = await report;
    expect(r.checks.find((c) => c.check === "pihome")).toMatchObject({
      ok: false,
      fix: "qcr scan login",
    });
    expect(calls.some((c) => c[0] === "run")).toBe(false);
  });

  it("no login for the stage-1 model's provider fails, and no probe is run", async () => {
    const { report, calls } = doctor([
      ...all.slice(0, 3),
      loginAnswer({ anthropic: { type: "oauth", expires: 1e15 } }),
      ...all.slice(4),
    ]);
    const r = await report;
    expect(r.checks.find((c) => c.check === "pihome")).toMatchObject({
      ok: false,
      detail: expect.stringMatching(/no openai-codex login/),
      fix: "qcr scan login",
    });
    expect(probeOf(calls)).toBeUndefined();
  });

  it("an access token that would not outlive a case fails, saying to let the companion refresh", async () => {
    const r = await doctor([
      ...all.slice(0, 3),
      loginAnswer({ "openai-codex": { type: "oauth", expires: SCAN_CASE_AUTH_BUDGET_MS - 1 } }),
      ...all.slice(4),
    ]).report;
    const pihome = r.checks.find((c) => c.check === "pihome")!;
    expect(pihome.ok).toBe(false);
    expect(pihome.fix).toMatch(/open the companion/i);
    expect(pihome.fix).toMatch(/qcr scan login/);
  });

  it("a pi that does not answer is not logged in", async () => {
    const r = await doctor([
      ...all.slice(0, 4),
      (a) => (a[0] === "run" ? fail("No API key found for openai-codex") : undefined),
    ]).report;
    expect(r.checks.find((c) => c.check === "pihome")).toMatchObject({
      ok: false,
      fix: "qcr scan login",
    });
  });

  it("docker down: docker fails, image and pihome are not checked, the rest still are", async () => {
    const r = await doctor([
      (a) => (a[0] === "version" ? fail("Cannot connect to the Docker daemon") : undefined),
    ]).report;
    expect(r.checks.map((c) => [c.check, c.ok])).toEqual([
      ["docker", false],
      ["image", false],
      ["pihome", false],
      ["reviewed_repo", true],
      ["unit_cut", true],
    ]);
    expect(r.checks[1]!.detail).toMatch(/not checked/);
  });

  it("no reviewed repo, a repo git cannot read, and no saved cut each fail with their fix", async () => {
    const r1 = await doctor(all, { reviewedRepo: "" }).report;
    expect(r1.checks.find((c) => c.check === "reviewed_repo")).toMatchObject({ ok: false });
    const r2 = await doctor(all, { gitDirs: () => ({ ok: false, error: "not a git repository" }) })
      .report;
    expect(r2.checks.find((c) => c.check === "reviewed_repo")).toMatchObject({
      ok: false,
      detail: expect.stringMatching(/not a git repository/),
    });
    const r3 = await doctor(all, { cut: () => ({ saved: false, problems: [] }) }).report;
    expect(r3.checks.find((c) => c.check === "unit_cut")).toMatchObject({
      ok: false,
      fix: "qcr scan units propose, then qcr scan units show and qcr scan units save",
    });
  });

  it("with sandbox = host: pi on this machine is probed instead of docker", async () => {
    const pis: string[][] = [];
    const r = await doctor([], {
      sandbox: { ...SANDBOX, sandbox: "host" },
      hostPi: async (argv) => {
        pis.push(argv);
        return { ...OK, stdout: "OK" };
      },
    }).report;
    expect(r.checks.map((c) => c.check)).toEqual(["pi", "reviewed_repo", "unit_cut"]);
    expect(r.ok).toBe(true);
    expect(pis[0]).toEqual([
      "-p",
      "--no-session",
      "--no-extensions",
      "--model",
      "openai-codex/gpt-6.1-sol:medium",
      "Reply with the single word OK.",
    ]);
  });
});

describe("where the sandbox defaults to the host", () => {
  const docker =
    (up: boolean): DockerRunner =>
    async (a) =>
      a[0] === "version" ? (up ? { ...OK, stdout: "27\n" } : fail("Cannot connect")) : fail("x");

  it("inside the companion container (its env says so): host, with the reason", async () => {
    expect(
      await effectiveSandbox(SANDBOX, {
        env: { [IN_COMPANION_ENV]: "1" },
        exists: () => false,
        docker: docker(true),
      }),
    ).toEqual({
      sandbox: { ...SANDBOX, sandbox: "host" },
      note: "inside the companion container — [scan] sandbox defaults to host there",
    });
  });

  it("no docker and a /workspace mount: the companion container too", async () => {
    const r = await effectiveSandbox(SANDBOX, {
      env: {},
      exists: (p) => p === "/workspace",
      docker: docker(false),
    });
    expect(r.sandbox.sandbox).toBe("host");
    expect(r.note).toMatch(/companion container/);
  });

  it("docker reachable, or no /workspace: the configured default stands", async () => {
    expect(
      (await effectiveSandbox(SANDBOX, { env: {}, exists: () => true, docker: docker(true) }))
        .sandbox.sandbox,
    ).toBe("docker");
    expect(
      (await effectiveSandbox(SANDBOX, { env: {}, exists: () => false, docker: docker(false) }))
        .sandbox.sandbox,
    ).toBe("docker");
  });

  it("an explicit [scan] sandbox is never overridden", async () => {
    const set = { ...SANDBOX, sandbox_set: true };
    expect(
      await effectiveSandbox(set, {
        env: { [IN_COMPANION_ENV]: "1" },
        exists: () => true,
        docker: docker(false),
      }),
    ).toEqual({ sandbox: set });
  });

  it("the doctor says why", () => {
    const text = renderDoctor({
      ok: true,
      sandbox: "host",
      note: "inside the companion container — [scan] sandbox defaults to host there",
      reviewed_repo: "/r",
      checks: [],
    });
    expect(text.split("\n")[0]).toBe(
      "Scan sandbox: host (inside the companion container — [scan] sandbox defaults to host there)",
    );
  });

  it("the companion's pi carries the env that says so", () => {
    const cfg = resolveCompanionPaths({ ...COMPANION_DEFAULTS, repo_dir: "/host/rs" }, "/host/rs");
    const lc = new CompanionLifecycle(
      cfg,
      async () => OK,
      { HOME: "/host/home" },
      () => {},
    );
    expect(lc.piEnvPrefix()).toContain(`${IN_COMPANION_ENV}=1`);
  });
});

describe("qcr scan rebuild", () => {
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;

  it("builds [scan] image alone, stamped — no container is removed, stopped or started", async () => {
    const { docker, calls } = fakeDocker([(a) => (a[0] === "build" ? OK : undefined)]);
    const r = await buildScanImage({
      docker,
      image: "qcr-companion",
      buildContext: "/host/rs",
      exists: () => true,
      stamp: () => "abcd",
    });
    expect(r).toEqual({ ok: true, image: "qcr-companion", stamp: "abcd" });
    expect(calls).toEqual([
      [
        "build",
        "-t",
        "qcr-companion",
        "-f",
        "/host/rs/docker/companion/Dockerfile",
        "--build-arg",
        `COMPANION_UID=${uid}`,
        "--build-arg",
        "BUILD_SHA=abcd",
        "/host/rs",
      ],
    ]);
  });

  it("refuses before docker when the app is not built", async () => {
    const { docker, calls } = fakeDocker([]);
    const r = await buildScanImage({
      docker,
      image: "img",
      buildContext: "/host/rs",
      exists: () => false,
      stamp: () => "abcd",
    });
    expect(r).toMatchObject({ ok: false, errors: [expect.stringMatching(/npm run build/)] });
    expect(calls).toEqual([]);
  });

  it("a failed build is a refusal with docker's reason", async () => {
    const { docker } = fakeDocker([(a) => (a[0] === "build" ? fail("no space left") : undefined)]);
    expect(
      await buildScanImage({
        docker,
        image: "img",
        buildContext: "/c",
        exists: () => true,
        stamp: () => "s",
      }),
    ).toEqual({ ok: false, errors: ["docker build img failed: no space left"] });
  });
});
