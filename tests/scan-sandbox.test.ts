// The scan sandbox (src/scanbox.ts): `qcr scan start` with `[scan] sandbox =
// "docker"` runs its driver in a throwaway container from the companion image.
// Docker is a port here — every call is recorded and answered from a script —
// so these tests pin the exact argv (the mount list above all), the env, every
// refusal, the started handshake over the state home, and the build stamp;
// `qcr scan login` / `doctor`, the image's build, its ignore list and its
// one-shot entrypoint mode are pinned beside them.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  COMPANION_DEFAULTS,
  parseConfig,
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
  renderDoctor,
  scanDoctor,
  scanLoginArgv,
  scanMounts,
  scanRunArgv,
  writeStartedFile,
  type ScanBoxPlan,
} from "../src/scanbox.js";
import { scanEnv } from "../src/scancli.js";
import {
  CompanionLifecycle,
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
  pihome_volume: "scan-pihome",
  image: "qcr-companion",
};

describe("[scan] sandbox, pihome_volume and image", () => {
  it("default to the docker sandbox, the scan-pihome volume and the companion image", () => {
    const cfg = parseConfig(fixtureToml);
    expect(cfg.scan_sandbox).toEqual({
      sandbox: "docker",
      pihome_volume: "scan-pihome",
      image: cfg.companion.image,
    });
  });

  it("follow the companion image when [companion] image is renamed and [scan] image is not", () => {
    const toml = fixtureToml.replace("[companion]", '[companion]\nimage = "my-companion"');
    expect(parseConfig(toml).scan_sandbox.image).toBe("my-companion");
  });

  it("are read from [scan], beside its other keys, and kept out of the scan settings", () => {
    const cfg = parseConfig(
      `${fixtureToml}\n[scan]\nsandbox = "host"\npihome_volume = "v2"\nimage = "img:1"\ndepth = "deep"\n`,
    );
    expect(cfg.scan_sandbox).toEqual({ sandbox: "host", pihome_volume: "v2", image: "img:1" });
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
    expect(table).toMatch(/^pihome_volume = "scan-pihome"/m);
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

  it("builds from the app root with the companion Dockerfile, stamped", async () => {
    expect(cfg.build_context).toBe("/host/rs");
    const { docker, calls } = fakeDocker([(a) => (a[0] === "build" ? OK : undefined)]);
    const lc = new CompanionLifecycle(
      cfg,
      docker,
      { HOME: "/host/home" },
      () => {},
      { exists: () => true, read: () => undefined, mode: () => undefined },
      () => "0123456789abcdef",
    );
    await lc.buildImage();
    const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
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
        "BUILD_SHA=0123456789abcdef",
        "/host/rs",
      ],
    ]);
  });

  it("refuses to build before the app is built — the image copies dist/", async () => {
    const { docker, calls } = fakeDocker([]);
    const lc = new CompanionLifecycle(
      cfg,
      docker,
      { HOME: "/host/home" },
      () => {},
      { exists: () => false, read: () => undefined, mode: () => undefined },
      () => "s",
    );
    await expect(lc.buildImage()).rejects.toThrow(/npm run build/);
    expect(calls).toEqual([]);
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
  pihomeVolume: "scan-pihome",
  reviewedRepo: "/host/app",
  gitDirs: [],
  stateHome: "/host/state",
  configMirror: "/host/opstate/scan-config",
  profiles: "/host/config/profiles",
  install: "default",
  token: "tok1",
  memory: {
    network: MEMORY.network,
    endpoint: "http://198.51.100.1:1933",
    keysFile: "/host/keys.env",
    notes: [],
  },
};

describe("the scan container's argv", () => {
  it("mounts the reviewed repo read-only, the state home, the scan pi home and the config — nothing else", () => {
    expect(scanMounts(PLAN)).toEqual([
      { dest: "/reviewed-repo", source: "/host/app", mode: "ro" },
      { dest: "/qcr-state", source: "/host/state", mode: "rw" },
      { dest: "/home/companion/.pi", source: "scan-pihome" },
      { dest: "/qcr-config/live", source: "/host/opstate/scan-config", mode: "ro" },
      { dest: "/qcr-config/profiles", source: "/host/config/profiles", mode: "ro" },
    ]);
    const dests = scanMounts(PLAN).map((m) => m.dest);
    for (const never of ["/workspace", "/tracker", "/github-read", "/evidence", "/feed", "/alerts"])
      expect(dests).not.toContain(never);
  });

  it("a worktree's git dir is mounted read-only where it sits, so git resolves it", () => {
    const m = scanMounts({ ...PLAN, gitDirs: ["/host/main/.git"] });
    expect(m[1]).toEqual({ dest: "/host/main/.git", source: "/host/main/.git", mode: "ro" });
    expect(m).toHaveLength(6);
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
      "--volume",
      "/host/app:/reviewed-repo:ro",
      "--volume",
      "/host/state:/qcr-state:rw",
      "--volume",
      "scan-pihome:/home/companion/.pi",
      "--volume",
      "/host/opstate/scan-config:/qcr-config/live:ro",
      "--volume",
      "/host/config/profiles:/qcr-config/profiles:ro",
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
      "--env-file",
      "/host/keys.env",
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
  });

  it("memory-less wiring: no network, no memory env — the scan still runs", () => {
    const argv = scanRunArgv({ ...PLAN, memory: { network: "", endpoint: "", notes: [] } }, [
      "start",
      "--key",
      "K",
    ]);
    expect(argv).not.toContain("--network");
    expect(argv.join(" ")).not.toMatch(/OPENVIKING|--env-file/);
  });

  it("`qcr scan login` opens pi interactively over the scan pi home, in a throwaway container", () => {
    expect(scanLoginArgv(SANDBOX)).toEqual([
      "run",
      "--rm",
      "-it",
      ...PUBLIC_DNS.flatMap((d) => ["--dns", d]),
      "--volume",
      "scan-pihome:/home/companion/.pi",
      "qcr-companion",
      "pi",
    ]);
  });
});

// ---- the launch -----------------------------------------------------------------

describe("the sandboxed launch", () => {
  const RUN = { id: "scan-1", mode: "stage1", sha: "a".repeat(40), cases: [], cap_usd: 1 };

  function setup(
    rules: Array<(argv: string[]) => DockerResult | undefined>,
    over: Partial<Parameters<typeof dockerDetach>[0]> = {},
  ) {
    const env = { HOME: dir } as NodeJS.ProcessEnv;
    const home = join(dir, ".local/state/qcr/default");
    const repo = join(dir, "app");
    mkdirSync(repo, { recursive: true });
    const config = join(dir, "config.toml");
    writeFileSync(config, "# the live config\n");
    const { docker, calls } = fakeDocker(rules);
    let t = 0;
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
        t += ms;
      },
      now: () => t,
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
    const run = calls.find((c) => c[0] === "run")!;
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
        "the image qcr-companion was built from other code (stamp old0; this checkout is s1) — run `qcr companion rebuild`",
      ],
    });
    expect(calls.some((c) => c[0] === "run")).toBe(false);
  });

  it("refuses an image with no stamp, a missing image and an unreachable docker", async () => {
    expect(await setup([stamped("<no value>")]).detach(["start", "--key", "K"])).toEqual({
      ok: false,
      errors: ["the image qcr-companion carries no build stamp — run `qcr companion rebuild`"],
    });
    const missing = setup([
      (a) => (a[0] === "image" ? fail("Error: No such image: qcr-companion") : undefined),
    ]);
    expect(await missing.detach(["start", "--key", "K"])).toEqual({
      ok: false,
      errors: ["the image qcr-companion is not built — run `qcr companion rebuild`"],
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
    const run = calls.find((c) => c[0] === "run")!;
    expect(run[run.indexOf("--name") + 1]).toBe("qcr-scan-work-tok1");
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
        ...over,
      }),
      repo,
    };
  }
  const all = [
    (a: string[]) => (a[0] === "version" ? { ...OK, stdout: "27.1.0\n" } : undefined),
    (a: string[]) => (a[0] === "image" ? { ...OK, stdout: "s1\n" } : undefined),
    (a: string[]) => (a[0] === "volume" ? { ...OK, stdout: "[]" } : undefined),
    (a: string[]) => (a[0] === "run" ? { ...OK, stdout: "OK\n" } : undefined),
  ];

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
    expect(calls.find((c) => c[0] === "run")).toEqual([
      "run",
      "--rm",
      ...PUBLIC_DNS.flatMap((d) => ["--dns", d]),
      "--volume",
      "scan-pihome:/home/companion/.pi",
      "qcr-companion",
      "pi",
      "-p",
      "--no-session",
      "--no-extensions",
      "--model",
      "openai-codex/gpt-6.1-sol:medium",
      "Reply with the single word OK.",
    ]);
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
    expect(image).toMatchObject({ ok: false, fix: "qcr companion rebuild" });
  });

  it("no volume yet is not logged in — and no container is run to find out", async () => {
    const { report, calls } = doctor([
      all[0]!,
      all[1]!,
      (a) => (a[0] === "volume" ? fail("Error: no such volume: scan-pihome") : undefined),
    ]);
    const r = await report;
    expect(r.checks.find((c) => c.check === "pihome")).toMatchObject({
      ok: false,
      fix: "qcr scan login",
    });
    expect(calls.some((c) => c[0] === "run")).toBe(false);
  });

  it("a pi that does not answer is not logged in", async () => {
    const r = await doctor([
      ...all.slice(0, 3),
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
