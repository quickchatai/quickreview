// The release image's one entrypoint (docker/entrypoint.sh): mode dispatch,
// executed against a fake app root - a scratch /opt/qcr with stub dist files,
// a fake tmux and a scratch HOME - so no image, no docker and no model is
// involved. What it pins:
//   - the dispatch: cli is the default, every mode name selects its mode, and
//     the qcr verbs that share a mode's name (install where, companion up) go
//     to the cli;
//   - every mode refuses to start when config.toml [pi] version differs from
//     the installed pi package;
//   - the daemon mode carries the bash-guard registration, its FATAL on a
//     missing extension and on a missing examples/subagent, and the 0444
//     reviewer stub; the per-call cli mode registers no bash-guard and
//     instead runs the model's tools as another uid (D32: the entrypoint's
//     privilege drop, the engine's setpriv launch, and - in a user namespace,
//     where available - the kernel refusing the tools the token holder's
//     /proc);
//   - <root>/state must be writable, and a cli mode's stdout is the command's.
import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig } from "../src/config.js";
import { loginInPi } from "../src/scanbox.js";
import { toolIsolation } from "../src/engine/procruntime.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRYPOINT = join(root, "docker", "entrypoint.sh");
const read = (rel: string): string => readFileSync(join(root, rel), "utf8");
const cfg = parseConfig(read("config.example.toml"));
const PKG = cfg.pi.package;
const VERSION = cfg.pi.version;
const MODES = ["install", "mint", "cli", "daemon", "worker", "tui", "companion", "login"] as const;

interface Rig {
  dir: string;
  app: string;
  home: string;
  bin: string;
  globalRoot: string;
  env: NodeJS.ProcessEnv;
}

const rigs: Rig[] = [];
afterEach(() => {
  for (const r of rigs.splice(0)) {
    // what the namespace's uids created is owned by uids the test is not
    if (r.dir.startsWith(NS_BASE)) spawnSync(NS[0]!, [...NS.slice(1), "rm", "-rf", r.dir]);
    if (existsSync(join(r.app, "state"))) chmodSync(join(r.app, "state"), 0o755);
    rmSync(r.dir, { recursive: true, force: true });
  }
});

function put(path: string, text: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode });
}

/** A scratch /opt/qcr holding the real script's inputs and stub dist files. */
function rig(base = tmpdir()): Rig {
  const dir = mkdtempSync(join(base, "qcr-entrypoint-"));
  const app = join(dir, "opt-qcr");
  const home = join(dir, "home");
  const bin = join(dir, "bin");
  const globalRoot = join(dir, "global");
  for (const d of [app, home, bin]) mkdirSync(d, { recursive: true });
  mkdirSync(join(app, "state"));
  for (const f of [
    "scripts/install-locator.sh",
    "scripts/install-wrapper.sh",
    "scripts/qcr-host.sh",
    "config.example.toml",
    "docker/vm/tmux.conf",
  ]) {
    mkdirSync(dirname(join(app, f)), { recursive: true });
    copyFileSync(join(root, f), join(app, f));
  }
  copyFileSync(join(root, "deploy/reviewer/AGENTS.override.md"), join(dir, "stub.md"));
  // the installed pi, and the global CLI with its subagent example
  for (const base of [join(app, "node_modules"), globalRoot]) {
    put(join(base, PKG, "package.json"), JSON.stringify({ version: VERSION }));
  }
  put(join(globalRoot, PKG, "examples/extensions/subagent/index.ts"), "");
  put(join(app, "extensions/bash-guard.ts"), "// stub\n");
  // dist stubs: each reports who ran, with which argv, on which stdout
  put(
    join(app, "dist/src/cli.js"),
    `console.log(JSON.stringify({ ran: "cli", argv: process.argv.slice(2) }));\n`,
  );
  put(
    join(app, "dist/src/wire.js"),
    `console.log(JSON.stringify({ ran: "wire", argv: process.argv.slice(2), openai: process.env.OPENAI_API_KEY ?? null }));\n`,
  );
  put(
    join(app, "dist/src/scanbox.js"),
    `export const loginInPi = (p) => ["sh", "-c", "echo login:" + (p ?? "none")];\n`,
  );
  put(join(app, "scripts/mint-token.sh"), "#!/bin/sh\necho ghs_faketoken\n", 0o755);
  put(
    join(app, "package.json"),
    JSON.stringify({
      version: "4.5.6",
      repository: { url: "git+https://github.com/Acme/Widgets.git" },
    }),
  );
  // a tmux that only says what it was asked, and has no session yet
  put(
    join(bin, "tmux"),
    `#!/bin/sh\necho "tmux $*" >> "${dir}/tmux.log"\n[ "$1" = has-session ] && exit 1\nexit 0\n`,
    0o755,
  );
  const r: Rig = {
    dir,
    app,
    home,
    bin,
    globalRoot,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      QCR_APP_ROOT: app,
      QCR_PI_GLOBAL_ROOT: globalRoot,
    },
  };
  rigs.push(r);
  return r;
}

function run(
  r: Rig,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): { status: number | null; stdout: string; stderr: string } {
  const out = spawnSync(ENTRYPOINT, args, {
    env: { ...r.env, ...env },
    encoding: "utf8",
    timeout: 30_000,
  });
  return { status: out.status, stdout: out.stdout, stderr: out.stderr };
}

/** A daemon's config home: the example config, as the locator will find it. */
function withConfig(r: Rig, text = read("config.example.toml")): NodeJS.ProcessEnv {
  const file = join(r.dir, "config-home", "config.toml");
  put(file, text);
  return { QCR_CONFIG: file };
}

const settings = (r: Rig): { extensions: string[]; [k: string]: unknown } =>
  JSON.parse(readFileSync(join(r.home, ".pi/agent/settings.json"), "utf8")) as {
    extensions: string[];
  };
const GUARD = (r: Rig): string => join(r.app, "extensions/bash-guard.ts");

describe("dispatch", () => {
  it("cli is the default, and stdout is the command's alone", () => {
    const r = rig();
    const out = run(r, ["version", "--json"]);
    expect(out.status, out.stderr).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ ran: "cli", argv: ["version", "--json"] });
    // the provisioning said what it did, on stderr
    expect(out.stderr).toContain("pi extensions registered");
  });

  it("an explicit cli mode drops its own name; a flag first is still the cli", () => {
    const r = rig();
    expect(JSON.parse(run(r, ["cli", "review", "--preview"]).stdout).argv).toEqual([
      "review",
      "--preview",
    ]);
    expect(JSON.parse(run(r, ["--help"]).stdout).argv).toEqual(["--help"]);
  });

  it("the qcr verbs that share a mode's name go to the cli when they have arguments", () => {
    const r = rig();
    expect(JSON.parse(run(r, ["install", "where"]).stdout).argv).toEqual(["install", "where"]);
    expect(JSON.parse(run(r, ["install", "migrate"]).stdout).argv).toEqual(["install", "migrate"]);
    expect(JSON.parse(run(r, ["companion", "up"]).stdout).argv).toEqual(["companion", "up"]);
    // tui is both; it reaches the cli's tui verb with its arguments
    expect(JSON.parse(run(r, ["tui", "overseer"]).stdout).argv).toEqual(["tui", "overseer"]);
  });

  it("worker is a stub: nothing on stdout, a refusal on stderr", () => {
    const out = run(rig(), ["worker"]);
    expect(out.status).toBe(64);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("not shipped");
  });

  it("install prints the pinned installer on stdout and nothing else", () => {
    const out = run(rig(), ["install"]);
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toContain("ghcr.io/acme/widgets:4.5.6");
    expect(out.stdout).toContain('mv -f "$tmp" "$dest/qcr"');
  });
  it("mint prints the token and nothing else, and touches no state", () => {
    const r = rig();
    rmSync(join(r.app, "state"), { recursive: true });
    const out = run(r, ["mint"]);
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toBe("ghs_faketoken\n");
    expect(existsSync(join(r.app, "state"))).toBe(false);
  });

  it("login hands pi's /login script to sh, with the provider", () => {
    const r = rig();
    expect(run(r, ["login"]).stdout).toBe("login:none\n");
    expect(run(r, ["login", "openai-codex"]).stdout).toBe("login:openai-codex\n");
  });

  it("login runs the script scanbox builds: pi's own /login in a tmux session", () => {
    // the stub above stands in for dist/src/scanbox.js; the real one:
    const [sh, c, script] = loginInPi("openai-codex");
    expect([sh, c]).toEqual(["sh", "-c"]);
    expect(script).toContain("tmux new-session -d -s");
    expect(script).toContain("/login openai-codex");
    expect(read("docker/entrypoint.sh")).toContain("loginInPi(process.argv[2] || undefined)[2]");
  });
});

describe("the pi pin", () => {
  it.each(MODES)("%s refuses to start when the installed pi is not the pinned version", (mode) => {
    const r = rig();
    put(join(r.app, "node_modules", PKG, "package.json"), JSON.stringify({ version: "9.9.9" }));
    const out = run(r, [mode], withConfig(r));
    expect(out.status, mode).not.toBe(0);
    expect(out.stderr).toContain("pi version mismatch");
    expect(out.stderr).toContain(`[pi] version is ${VERSION}`);
    expect(out.stderr).toContain("9.9.9 is installed");
    // nothing ran: no provisioning, no handover, no tmux
    expect(out.stdout).toBe("");
    expect(existsSync(join(r.home, ".pi"))).toBe(false);
    expect(existsSync(join(r.dir, "tmux.log"))).toBe(false);
  });

  it("the config that is read is the located one, not the baked example", () => {
    const r = rig();
    const bumped = read("config.example.toml").replace(
      `version = "${VERSION}"`,
      'version = "1.3.1"  # a config that moved ahead of the image',
    );
    expect(bumped).not.toBe(read("config.example.toml"));
    const bad = run(r, ["version"], withConfig(r, bumped));
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain("[pi] version is 1.3.1");
    // …and without a config at all, the baked example answers
    expect(run(r, ["version"]).status).toBe(0);
  });

  it("a missing pi is a refusal too", () => {
    const r = rig();
    rmSync(join(r.app, "node_modules", PKG), { recursive: true });
    const out = run(r, ["version"]);
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain("pi is not installed");
  });

  it("a package name that is not an npm name never becomes a path", () => {
    const r = rig();
    const evil = read("config.example.toml").replace(`package = "${PKG}"`, 'package = "../../x"');
    const out = run(r, ["version"], withConfig(r, evil));
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain("is not an npm package name");
  });

  it("the daemon names a config that is not there instead of falling back", () => {
    const r = rig();
    const out = run(r, ["daemon"], { QCR_CONFIG: join(r.dir, "nope", "config.toml") });
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain("FATAL: config not found");
    expect(out.stderr).toContain("nope/config.toml");
  });
});

describe("state", () => {
  it.skipIf(process.getuid?.() === 0)(
    "an unwritable <root>/state is FATAL, in every mode that writes",
    () => {
      const r = rig();
      chmodSync(join(r.app, "state"), 0o555);
      const out = run(r, ["version"]);
      expect(out.status).not.toBe(0);
      expect(out.stderr).toContain("state is not writable");
    },
  );

  it("<root>/state is created when the app root lacks it, and no symlink is made", () => {
    const r = rig();
    rmSync(join(r.app, "state"), { recursive: true });
    expect(run(r, ["version"]).status).toBe(0);
    expect(statSync(join(r.app, "state")).isDirectory()).toBe(true);
  });
});

describe("daemon mode", () => {
  it("registers bash-guard in pi's global settings, pre-trusts the app root and execs wire.js", () => {
    const r = rig();
    const out = run(r, ["daemon"], withConfig(r));
    expect(out.status, out.stderr).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({ ran: "wire", argv: [] });
    const s = settings(r);
    expect(s.extensions[0]).toBe(GUARD(r));
    expect(s.extensions.slice(1)).toEqual([
      "-builtin:mcp",
      "-builtin:codemode",
      "-builtin:tool-search",
      "-builtin:llama.cpp",
    ]);
    expect(s.defaultProjectTrust).toBe("always");
    const trust = JSON.parse(readFileSync(join(r.home, ".pi/agent/trust.json"), "utf8")) as Record<
      string,
      boolean
    >;
    expect(trust[r.app]).toBe(true);
    // the native subagent extension's user-scope agents dir -> the built agents
    expect(readlinkSync(join(r.home, ".pi/agent/agents"))).toBe(join(r.app, "state/agents"));
    expect(readFileSync(join(r.dir, "tmux.log"), "utf8")).toBe(
      "tmux start-server\ntmux has-session -t main\ntmux new-session -d -s main\n",
    );
  });

  it("is idempotent and prunes an extension that is no longer on disk", () => {
    const r = rig();
    put(
      join(r.home, ".pi/agent/settings.json"),
      JSON.stringify({ extensions: ["/gone/pi-memory/index.ts"], theme: "mine" }),
    );
    run(r, ["daemon"], withConfig(r));
    const first = settings(r);
    expect(first.extensions).not.toContain("/gone/pi-memory/index.ts");
    expect(first["theme"]).toBe("mine");
    run(r, ["daemon"], withConfig(r));
    expect(settings(r).extensions).toEqual(first.extensions);
  });

  it("FATAL on a missing bash-guard: a silently unregistered guard would mean unguarded sessions", () => {
    const r = rig();
    rmSync(GUARD(r));
    const out = run(r, ["daemon"], withConfig(r));
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain(`FATAL: pi extension missing: ${GUARD(r)}`);
    expect(out.stdout).toBe("");
    expect(existsSync(join(r.dir, "tmux.log"))).toBe(false);
  });

  it("FATAL when the global pi lacks examples/extensions/subagent", () => {
    const r = rig();
    rmSync(join(r.globalRoot, PKG, "examples"), { recursive: true });
    const out = run(r, ["daemon"], withConfig(r));
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain(`FATAL: pi ${VERSION} does not ship examples/extensions/subagent`);
  });

  it("FATAL when the global pi CLI is not the pinned version", () => {
    const r = rig();
    put(join(r.globalRoot, PKG, "package.json"), JSON.stringify({ version: "1.2.0" }));
    const out = run(r, ["daemon"], withConfig(r));
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain(`the global pi CLI is 1.2.0, not the pinned ${VERSION}`);
  });

  it("installs the reviewer context stub 0444 into the app root, never anywhere else", () => {
    const r = rig();
    const src = join(r.app, "deploy/reviewer/AGENTS.override.md");
    mkdirSync(dirname(src), { recursive: true });
    copyFileSync(join(r.dir, "stub.md"), src);
    const out = run(r, ["daemon"], withConfig(r));
    expect(out.status, out.stderr).toBe(0);
    const dest = join(r.app, "AGENTS.override.md");
    expect(readFileSync(dest, "utf8")).toBe(read("deploy/reviewer/AGENTS.override.md"));
    expect(statSync(dest).mode & 0o777).toBe(0o444);
    // a stale copy is replaced; one already right is left alone
    chmodSync(dest, 0o644);
    writeFileSync(dest, "stale\n");
    run(r, ["daemon"], withConfig(r));
    expect(readFileSync(dest, "utf8")).toBe(read("deploy/reviewer/AGENTS.override.md"));
    expect(statSync(dest).mode & 0o777).toBe(0o444);
    const before = statSync(dest).mtimeMs;
    run(r, ["daemon"], withConfig(r));
    expect(statSync(dest).mtimeMs).toBe(before);
    expect(existsSync(join(r.app, "AGENTS.md"))).toBe(false);
  });

  it("an image that baked the stub in place (read-only, same bytes) boots without touching it", () => {
    const r = rig();
    const dest = join(r.app, "AGENTS.override.md");
    copyFileSync(join(r.dir, "stub.md"), dest);
    chmodSync(dest, 0o444);
    chmodSync(r.app, 0o555);
    try {
      const out = run(r, ["daemon"], withConfig(r));
      expect(out.status, out.stderr).toBe(0);
      expect(out.stderr).not.toContain("WARNING: reviewer context stub");
    } finally {
      chmodSync(r.app, 0o755);
    }
  });

  it("with no stub anywhere it says so and boots (sessions load the full guide)", () => {
    const r = rig();
    const out = run(r, ["daemon"], withConfig(r));
    expect(out.status, out.stderr).toBe(0);
    expect(out.stderr).toContain("WARNING: reviewer context stub not found");
  });

  it("wires the git credential helper to mint-token.sh and the OpenAI key from the secrets mount", () => {
    const r = rig();
    const secrets = join(r.dir, "secrets");
    put(join(secrets, "openai_api_key"), "sk-test\n");
    const out = run(r, ["daemon"], { ...withConfig(r), QCR_SECRETS_MOUNT: secrets });
    expect(out.status, out.stderr).toBe(0);
    expect(JSON.parse(out.stdout).openai).toBe("sk-test");
    const gitconfig = readFileSync(join(r.home, ".gitconfig"), "utf8");
    expect(gitconfig).toContain(`${r.app}/scripts/mint-token.sh`);
    // <config home>/secrets -> the mount, where the install locator looks
    expect(readlinkSync(join(r.home, ".config/qcr/default/secrets"))).toBe(secrets);
  });

  it("starts no OpenViking and builds nothing at boot", () => {
    const text = read("docker/entrypoint.sh");
    expect(text).not.toMatch(/openviking-server|openviking-provision|openviking-reembed/);
    expect(text).not.toMatch(/npm (ci|run build|install)/);
    expect(text).not.toMatch(/\bln\b[^\n]*\bstate\b/);
  });
});

describe("per-call modes register no bash-guard (D32; the uid split is checked below)", () => {
  it.each([
    ["cli", ["version"]],
    ["login", ["login"]],
  ] as const)("%s registers only the built-in disables", (_name, args) => {
    const r = rig();
    expect(run(r, [...args]).status).toBe(0);
    const s = settings(r);
    expect(s.extensions).toEqual([
      "-builtin:mcp",
      "-builtin:codemode",
      "-builtin:tool-search",
      "-builtin:llama.cpp",
    ]);
    expect(s.defaultProjectTrust).toBe("always");
    expect(s["tuiMode"]).toBe("regular");
  });

  it("the bash-guard registration is the daemon mode's alone", () => {
    const text = read("docker/entrypoint.sh");
    const daemon = text.slice(
      text.indexOf("mode_daemon() {"),
      text.indexOf("# The companion's pi settings"),
    );
    expect(text.match(/extensions\/bash-guard\.ts/g)).toHaveLength(2); // the knob, and a comment
    expect(daemon).toContain('QCR_PI_REQUIRE_EXT="$APP/extensions/bash-guard.ts"');
  });
});

// A user namespace in which this test process is root and a range of other uids
// exists, so the privilege drop and the setpriv launch run for real. Absent on
// a host that forbids unprivileged namespaces: those tests skip.
const NS = [
  "unshare",
  "--user",
  "--map-user=0",
  "--map-users=auto",
  "--map-group=0",
  "--map-groups=auto",
  "--",
];
const hasNs = ((): boolean => {
  if (!existsSync("/dev/shm")) return false;
  const o = spawnSync(
    NS[0]!,
    [...NS.slice(1), "setpriv", "--reuid=1000", "--regid=1000", "--clear-groups", "id", "-u"],
    {
      encoding: "utf8",
    },
  );
  return o.status === 0 && o.stdout.trim() === "1000";
})();

/** Where a namespace rig lives: the namespace's uids cannot walk the test tmp
 * dir's path (it sits under a home directory), but they can walk /dev/shm. */
const NS_BASE = "/dev/shm";
const nsRig = (): Rig => {
  const r = rig(NS_BASE);
  // the test runner's PATH may lead through a home directory they cannot walk
  r.env["PATH"] = `${r.bin}:/usr/local/bin:/usr/bin:/bin`;
  return r;
};

/** The script, copied inside the rig, which the namespace's uids must traverse. */
function nsEntrypoint(r: Rig): string {
  chmodSync(r.dir, 0o755);
  const copy = join(r.app, "docker/entrypoint.sh");
  copyFileSync(ENTRYPOINT, copy);
  chmodSync(copy, 0o755);
  return copy;
}

describe("D32: the model's tools run as another uid", () => {
  const ALLOW = { QCR_ALLOW_SHARED_TOOL_UID: "" };

  it("a cli start that is not root cannot split: it marks the uid as required and exports no tool uid", () => {
    const r = rig();
    put(
      join(r.app, "dist/src/cli.js"),
      `console.log(JSON.stringify({ uid: process.env.QCR_TOOL_UID ?? null, req: process.env.QCR_TOOL_UID_REQUIRED ?? null }));\n`,
    );
    const out = run(r, ["review"], { QCR_TOOL_UID: "1234", QCR_TOOL_GID: "1234", ...ALLOW });
    expect(out.status, out.stderr).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ uid: null, req: "1" });
  });

  it("only the cli mode asks for the split: the daemon and the companion are untouched", () => {
    const r = rig();
    const wire = JSON.parse(run(r, ["daemon"], withConfig(r)).stdout) as Record<string, unknown>;
    expect(wire["ran"]).toBe("wire");
    const text = read("docker/entrypoint.sh");
    expect(text).toContain('[ "$mode" = cli ] || return 0');
    expect(text).not.toMatch(/QCR_TOOL_UID_REQUIRED[^\n]*daemon/);
  });

  it("the engine's launch: setpriv to the tool uid, no capabilities, no new privileges", () => {
    const env = { QCR_TOOL_UID: "65534", QCR_TOOL_GID: "1000" };
    expect(toolIsolation("pi", ["-p", "--mode", "json"], env)).toEqual({
      bin: "setpriv",
      argv: [
        "--reuid=65534",
        "--regid=1000",
        "--clear-groups",
        "--inh-caps=-all",
        "--ambient-caps=-all",
        "--no-new-privs",
        "--",
        "pi",
        "-p",
        "--mode",
        "json",
      ],
    });
  });

  it("without the split nothing changes; with it required and absent, pi is refused", () => {
    expect(toolIsolation("pi", ["-p"], {})).toEqual({ bin: "pi", argv: ["-p"] });
    const refused = toolIsolation("pi", ["-p"], { QCR_TOOL_UID_REQUIRED: "1" });
    expect(refused).toHaveProperty("refused");
    expect((refused as { refused: string }).refused).toContain("--cap-add SETUID");
    // the owner's explicit acceptance of the shared uid
    expect(
      toolIsolation("pi", ["-p"], { QCR_TOOL_UID_REQUIRED: "1", QCR_ALLOW_SHARED_TOOL_UID: "1" }),
    ).toEqual({ bin: "pi", argv: ["-p"] });
  });

  it("a tool id that is not a non-zero number is refused, never passed to setpriv", () => {
    for (const bad of [
      { QCR_TOOL_UID: "0", QCR_TOOL_GID: "1000" },
      { QCR_TOOL_UID: "x", QCR_TOOL_GID: "1" },
      { QCR_TOOL_UID: "5" },
    ]) {
      expect(toolIsolation("pi", [], bad)).toHaveProperty("refused");
    }
  });

  it.skipIf(!hasNs)(
    "started as root it drops to the run uid with ambient setuid/setgid and exports the tool uid",
    () => {
      const r = nsRig();
      // the namespace's uids are not the test's own: the rig must be writable by them
      for (const d of [r.app, r.home, join(r.app, "state")]) chmodSync(d, 0o1777);
      const script = nsEntrypoint(r);
      put(
        join(r.app, "dist/src/cli.js"),
        `import { readFileSync } from "node:fs";
const status = readFileSync("/proc/self/status", "utf8");
const cap = (k) => status.split("\\n").find((l) => l.startsWith(k + ":")).split(/[ \t]+/)[1];
console.log(JSON.stringify({
  uid: process.getuid(), gid: process.getgid(), groups: process.getgroups(),
  toolUid: process.env.QCR_TOOL_UID, toolGid: process.env.QCR_TOOL_GID,
  required: process.env.QCR_TOOL_UID_REQUIRED ?? null, capAmb: cap("CapAmb"),
}));\n`,
      );
      const out = spawnSync(NS[0]!, [...NS.slice(1), script, "review"], {
        cwd: r.dir,
        env: { ...r.env, QCR_RUN_UID: "1000", QCR_RUN_GID: "1000", QCR_TOOL_UID: "0" },
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(out.status, out.stderr).toBe(0);
      const seen = JSON.parse(out.stdout) as Record<string, unknown>;
      expect(seen).toMatchObject({
        uid: 1000,
        gid: 1000,
        toolUid: "65534",
        toolGid: "1000",
        required: null,
      });
      // its gid, and the login group (P6.7) - nothing else
      expect(seen["groups"]).toEqual([4747, 1000]);
      expect(seen["capAmb"]).toBe("00000000000000c0"); // CAP_SETGID (6) and CAP_SETUID (7)
      // the files it provisioned are reachable by the tool uid through the shared gid
      expect(statSync(join(r.home, ".pi/agent/settings.json")).mode & 0o060).toBe(0o060);
    },
  );

  it.skipIf(!hasNs)("a tool uid equal to the run uid is refused at boot", () => {
    const r = nsRig();
    const out = spawnSync(NS[0]!, [...NS.slice(1), nsEntrypoint(r), "review"], {
      cwd: r.dir,
      env: { ...r.env, QCR_RUN_UID: "1000", QCR_RUN_GID: "1000", QCR_TOOLS_AS: "1000" },
      encoding: "utf8",
    });
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain("must differ from the run uid");
  });

  // The point of it all, end to end: a process like the Node one (run uid,
  // holding a secret in its environment, ambient setuid/setgid) starts "pi" the
  // way the engine does, and what pi runs cannot read that process.
  it.skipIf(!hasNs)("the kernel refuses the tools the token holder's /proc", () => {
    const probe =
      'echo "uid=$(id -u)"; grep -E "^(CapEff|CapPrm|CapAmb|NoNewPrivs):" /proc/self/status | tr -s "\\t " " "; ' +
      'cat "/proc/$HOLDER/environ" 2>&1 | head -c 200; echo; head -c 4 "/proc/$HOLDER/mem" 2>&1 | head -c 100';
    const iso = toolIsolation("sh", ["-c", probe], { QCR_TOOL_UID: "1001", QCR_TOOL_GID: "1000" });
    if ("refused" in iso) throw new Error(iso.refused);
    const holder = (launch: string[]): { status: number | null; stdout: string } => {
      const o = spawnSync(
        NS[0]!,
        [
          ...NS.slice(1),
          "setpriv",
          "--reuid=1000",
          "--regid=1000",
          "--clear-groups",
          "--inh-caps=+setuid,+setgid",
          "--ambient-caps=+setuid,+setgid",
          "--",
          "sh",
          "-c",
          // $$ is the holder, whose environment holds the secret; the launch
          // runs as its child, as pi does (the `;` stops sh exec'ing it)
          'HOLDER=$$ "$@"; exit $?',
          "holder",
          ...launch,
        ],
        {
          cwd: "/",
          env: { PATH: "/usr/bin:/bin", GITHUB_TOKEN: "ghs_secret" },
          encoding: "utf8",
          timeout: 30_000,
        },
      );
      return { status: o.status, stdout: o.stdout };
    };
    // control: the same probe, same uid as the holder - the secret is readable
    const same = holder(["sh", "-c", probe]);
    expect(same.stdout).toContain("uid=1000");
    expect(same.stdout).toContain("ghs_secret");
    // the split: other uid, nothing readable, no capabilities, no new privileges
    const split = holder([iso.bin, ...iso.argv]);
    expect(split.stdout).toContain("uid=1001");
    expect(split.stdout).not.toContain("ghs_secret");
    expect(split.stdout).toMatch(/Permission denied/);
    for (const cap of ["CapEff", "CapPrm", "CapAmb"])
      expect(split.stdout).toContain(`${cap}: 0000000000000000`);
    expect(split.stdout).toContain("NoNewPrivs: 1");
  });
});

describe("companion mode", () => {
  it("provisions pi, starts the tmux server, stays alive, and stops promptly on SIGTERM", async () => {
    const r = rig();
    const child = spawn(ENTRYPOINT, ["companion"], {
      env: { ...r.env, QCR_PI_DEFAULT_MODEL: "openai-codex/gpt-5:high" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const exited = new Promise<number | null>((res) => child.on("exit", (code) => res(code)));
    const log = join(r.dir, "tmux.log");
    for (let i = 0; i < 200 && !existsSync(log); i++) await new Promise((r2) => setTimeout(r2, 50));
    expect(existsSync(log), stderr).toBe(true);
    expect(readFileSync(log, "utf8")).toContain("tmux start-server");
    const s = settings(r) as {
      extensions: string[];
      defaultModel?: string;
      enableSkillCommands?: boolean;
    };
    // the companion registers no global extension: companion-guard rides argv
    expect(s.extensions).toEqual([
      "-builtin:mcp",
      "-builtin:codemode",
      "-builtin:tool-search",
      "-builtin:llama.cpp",
    ]);
    expect(s.defaultModel).toBe("gpt-5");
    expect(s.enableSkillCommands).toBe(true);
    expect(readFileSync(join(r.home, ".tmux.conf"), "utf8")).toContain(
      "extended-keys-format csi-u",
    );
    expect(child.exitCode).toBeNull();
    child.kill("SIGTERM");
    expect(await exited).toBe(0);
  });

  it("runs the image's code: agents linked at the image's agent set, no pi subagent example needed", async () => {
    const r = rig();
    // The global CLI of this rig has no examples/extensions/subagent: the
    // companion loads our lens tool, so the boot must not ask for it.
    rmSync(join(r.globalRoot, PKG, "examples"), { recursive: true, force: true });
    const child = spawn(ENTRYPOINT, ["companion"], {
      env: r.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const exited = new Promise<number | null>((res) => child.on("exit", (code) => res(code)));
    const log = join(r.dir, "tmux.log");
    for (let i = 0; i < 200 && !existsSync(log); i++) await new Promise((r2) => setTimeout(r2, 50));
    expect(existsSync(log), stderr).toBe(true);
    // The lens tool reads <agent dir>/agents; it is the image's set, not /workspace's.
    expect(readlinkSync(join(r.home, ".pi/agent/agents"))).toBe(
      join(r.app, "docker/companion/agents"),
    );
    child.kill("SIGTERM");
    expect(await exited).toBe(0);
  });
});

describe("D35: the tmux socket and the TUI's identity", () => {
  it("companion mode with QCR_TMUX_SOCKET starts the server on that socket and keeps it up with no session", async () => {
    const r = rig();
    const socket = join(r.dir, "tmux", "companion.sock");
    const child = spawn(ENTRYPOINT, ["companion"], {
      env: { ...r.env, QCR_TMUX_SOCKET: socket },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const exited = new Promise<number | null>((res) => child.on("exit", (code) => res(code)));
    const log = join(r.dir, "tmux.log");
    for (let i = 0; i < 200 && !existsSync(log); i++) await new Promise((r2) => setTimeout(r2, 50));
    expect(existsSync(log)).toBe(true);
    // one invocation: the server and the option that stops it exiting empty
    expect(readFileSync(log, "utf8")).toContain(
      `tmux -S ${socket} start-server ; set -s exit-empty off`,
    );
    expect(readFileSync(log, "utf8")).not.toContain("tmux start-server");
    expect(existsSync(dirname(socket))).toBe(true);
    child.kill("SIGTERM");
    expect(await exited).toBe(0);
  });

  it("a stale socket left in the volume by an earlier run is removed before the server starts", async () => {
    const r = rig();
    const socket = join(r.dir, "tmux", "companion.sock");
    put(socket, "stale");
    const child = spawn(ENTRYPOINT, ["companion"], {
      env: { ...r.env, QCR_TMUX_SOCKET: socket },
      stdio: ["ignore", "ignore", "ignore"],
    });
    const exited = new Promise<number | null>((res) => child.on("exit", (code) => res(code)));
    const log = join(r.dir, "tmux.log");
    for (let i = 0; i < 200 && !existsSync(log); i++) await new Promise((r2) => setTimeout(r2, 50));
    expect(existsSync(socket)).toBe(false);
    child.kill("SIGTERM");
    await exited;
  });

  // the cli stub of a rig prints argv only; this one prints what the TUI would see
  const seeIdentity = (r: Rig): void =>
    put(
      join(r.app, "dist/src/cli.js"),
      `console.log(JSON.stringify({ argv: process.argv.slice(2), preload: process.env.LD_PRELOAD ?? null, passwd: process.env.NSS_WRAPPER_PASSWD ?? null, group: process.env.NSS_WRAPPER_GROUP ?? null }));\n`,
    );
  /** A getent that knows nobody, as the image does for a caller's own uid. */
  const unknownUid = (r: Rig): void => put(join(r.bin, "getent"), "#!/bin/sh\nexit 2\n", 0o755);

  it("the tui mode gives ssh a passwd entry for a uid the image does not know", () => {
    const r = rig();
    seeIdentity(r);
    unknownUid(r);
    const lib = join(r.dir, "libnss_wrapper.so");
    put(lib, "");
    const out = run(r, ["tui", "--no-reload"], { QCR_NSS_WRAPPER_LIB: lib });
    expect(out.status, out.stderr).toBe(0);
    const seen = JSON.parse(out.stdout) as Record<string, string | string[] | null>;
    expect(seen["argv"]).toEqual(["tui", "--no-reload"]);
    expect(seen["preload"]).toBe(lib);
    const passwd = readFileSync(String(seen["passwd"]), "utf8");
    // the home the wrapper mounts ~/.ssh under, and the caller's own ids
    expect(passwd).toContain(
      `qcr:x:${process.getuid!()}:${process.getgid!()}:qcr:${r.home}:/bin/sh`,
    );
    expect(readFileSync(String(seen["group"]), "utf8")).toContain(`qcr:x:${process.getgid!()}:`);
  });

  it("does nothing when the uid is already known, and says so when the library is missing", () => {
    const r = rig();
    seeIdentity(r);
    const known = JSON.parse(run(r, ["tui"]).stdout) as Record<string, unknown>;
    expect(known["preload"]).toBeNull();
    unknownUid(r);
    const none = run(r, ["tui"], { QCR_NSS_WRAPPER_LIB: join(r.dir, "missing.so") });
    // never fatal, never a LD_PRELOAD of a file that is not there, and said
    expect(none.status, none.stderr).toBe(0);
    expect((JSON.parse(none.stdout) as Record<string, unknown>)["preload"]).toBeNull();
    expect(none.stderr).toContain("nss_wrapper is not usable");
  });

  it("only the tui mode asks for it: the cli mode never preloads anything", () => {
    const r = rig();
    seeIdentity(r);
    unknownUid(r);
    const lib = join(r.dir, "libnss_wrapper.so");
    put(lib, "");
    const out = JSON.parse(run(r, ["review"], { QCR_NSS_WRAPPER_LIB: lib }).stdout) as Record<
      string,
      unknown
    >;
    expect(out["preload"]).toBeNull();
  });

  it("the Dockerfile ships nss_wrapper and the tmux socket dir, writable by any uid", () => {
    const df = read("docker/Dockerfile");
    expect(df).toContain("libnss-wrapper");
    expect(df).toContain("install -d -m 1777 /run/qcr-tmux");
    expect(df).not.toMatch(/docker\.sock/);
  });
});

describe("the image wires it", () => {
  it("the Dockerfile bakes the entrypoint executable, the tmux config and a writable state dir", () => {
    const df = read("docker/Dockerfile");
    expect(df).toContain("COPY docker/entrypoint.sh ./docker/entrypoint.sh");
    expect(df).toContain("COPY docker/vm/tmux.conf ./docker/vm/tmux.conf");
    expect(df).toContain("install -d -m 1777 /opt/qcr/state");
    expect(df).toContain("chmod 0555 /opt/qcr/docker/entrypoint.sh");
    expect(df).toMatch(/^ENTRYPOINT \["\/opt\/qcr\/docker\/entrypoint\.sh"\]$/m);
    expect(statSync(ENTRYPOINT).mode & 0o111).not.toBe(0);
  });

  it("the state dir is created after the tree is made read-only, so the chmod does not strip it", () => {
    const df = read("docker/Dockerfile");
    expect(df.indexOf("install -d -m 1777 /opt/qcr/state")).toBeGreaterThan(
      df.indexOf("chmod -R a+rX,go-w /opt/qcr"),
    );
  });
});

describe("the token handoff (D39)", () => {
  it("records Yama's ptrace_scope in the debug log, and only there", () => {
    const r = rig();
    const quiet = run(r, ["version"]);
    expect(quiet.stderr).not.toContain("ptrace_scope");
    const loud = run(r, ["version"], { QCR_DEBUG: "1" });
    expect(loud.stderr).toMatch(/debug: kernel\.yama\.ptrace_scope=(\d+|absent)/);
    expect(loud.stdout).not.toContain("ptrace_scope");
  });

  it("never reads, prints or exports the token file's path: the Node process takes it", () => {
    const r = rig();
    const out = run(r, ["version"], { QCR_GH_TOKEN_FILE: join(r.dir, "does-not-exist") });
    expect(out.status, out.stderr).toBe(0);
    expect(out.stderr).not.toContain("does-not-exist");
  });

  it("the image carries no GitHub token env: not in the Dockerfile, not in the entrypoint", () => {
    for (const f of ["docker/Dockerfile", "docker/entrypoint.sh"]) {
      const text = read(f).replace(/^\s*#.*$/gm, "");
      expect(text, f).not.toMatch(/\b(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN)\b/);
    }
  });
});

const hasDist = existsSync(join(root, "dist/src/cli.js"));
describe.skipIf(!hasDist)("the real cli, through the entrypoint (no model)", () => {
  it("review --preview --json on a fixture repo", () => {
    const r = rig();
    const repo = join(r.dir, "repo");
    mkdirSync(repo);
    const git = (...a: string[]): void => {
      const o = spawnSync("git", ["-C", repo, ...a], { encoding: "utf8" });
      if (o.status !== 0) throw new Error(`git ${a.join(" ")}: ${o.stderr}`);
    };
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "a.txt"), "a\n");
    git("add", ".");
    git("commit", "-qm", "base");
    git("checkout", "-qb", "feat");
    writeFileSync(join(repo, "a.txt"), "a\nb\n");
    git("commit", "-qam", "feat");
    // the real app root: the built dist, the real pi in node_modules
    const out = spawnSync(ENTRYPOINT, ["review", "--preview", "--json"], {
      cwd: repo,
      env: {
        PATH: process.env.PATH,
        HOME: r.home,
        QCR_APP_ROOT: root,
        QCR_CONFIG: join(root, "config.example.toml"),
      },
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(out.status, out.stderr).toBe(0);
    const payload = JSON.parse(out.stdout) as {
      schema_version: number;
      ok: boolean;
      preview: { branch: string };
    };
    expect(payload.schema_version).toBe(1);
    expect(payload.ok).toBe(true);
    expect(payload.preview.branch).toBe("feat");
  });
});

// The login volume outlives the uid that wrote it (P6.7): `qcr login` runs as
// the caller, a review later runs as whichever uid the wrapper hands it. The
// login mode leaves every entry in the fixed login group (4747) at 0660/2770,
// and the cli mode keeps that group, so no uid change loses the OAuth login.
describe("the login volume is shared through a fixed group", () => {
  const GROUP = 4747;
  const ls = (path: string): string[] => ["sh", "-c", `stat -c '%u:%g:%a' ${path}`];

  /** A rig whose pi home is the login volume: a new volume copies the image's
   * agent dir, which the Dockerfile makes 0777 so any uid can log in. */
  function loginRig(): { r: Rig; script: string; agent: string } {
    const r = nsRig();
    for (const d of [r.app, r.home, join(r.app, "state")]) chmodSync(d, 0o1777);
    const agent = join(r.home, ".pi/agent");
    mkdirSync(agent, { recursive: true });
    for (const d of [join(r.home, ".pi"), agent]) chmodSync(d, 0o777);
    // what pi does on a login: a 0600 credential file, and a subdirectory
    put(
      join(r.app, "dist/src/scanbox.js"),
      `export const loginInPi = () => ["sh", "-c",
  "umask 077; echo '{\\"openai-codex\\":{\\"type\\":\\"oauth\\",\\"by\\":'$(id -u)'}}' > $HOME/.pi/agent/auth.json; mkdir -p $HOME/.pi/agent/sessions; echo s > $HOME/.pi/agent/sessions/one"];\n`,
    );
    return { r, script: nsEntrypoint(r), agent };
  }

  /** Run `argv` inside the namespace as uid:gid with the login group (or none). */
  const as = (
    uid: number,
    argv: string[],
    groups: string = String(GROUP),
    cwd?: string,
  ): { status: number | null; stdout: string; stderr: string } => {
    const o = spawnSync(
      NS[0]!,
      [
        ...NS.slice(1),
        "setpriv",
        `--reuid=${uid}`,
        `--regid=${uid}`,
        groups ? `--groups=${groups}` : "--clear-groups",
        ...argv,
      ],
      { encoding: "utf8", timeout: 30_000, cwd },
    );
    return { status: o.status, stdout: o.stdout, stderr: o.stderr };
  };

  /** `qcr login` under `uid`, in the login group, as the wrapper starts it. */
  const loginAs = (uid: number, rig: { r: Rig; script: string }): void => {
    const { r, script } = rig;
    const env = ["env", `HOME=${r.home}`, `PATH=${r.env["PATH"]}`, `QCR_APP_ROOT=${r.app}`];
    const o = as(
      uid,
      [...env, `QCR_PI_GLOBAL_ROOT=${r.globalRoot}`, script, "login"],
      String(GROUP),
      r.dir,
    );
    expect(o.status, o.stderr).toBe(0);
  };

  it.skipIf(!hasNs)(
    "a login under uid A is readable by a run under uid B, and re-loginable by uid C",
    () => {
      const rg = loginRig();
      const auth = join(rg.agent, "auth.json");
      // uid A logs in: pi writes 0600, owned by A, in A's own group
      loginAs(1000, rg);
      expect(as(1000, ls(auth)).stdout.trim()).toBe(`1000:${GROUP}:660`);
      expect(as(1000, ls(join(rg.agent, "sessions"))).stdout.trim()).toBe(`1000:${GROUP}:2770`);
      expect(as(1000, ls(join(rg.agent, "sessions/one"))).stdout.trim()).toBe(`1000:${GROUP}:660`);
      // a run under uid B, which holds the login group, reads it
      const read = as(1001, ["cat", auth]);
      expect(read.status, read.stderr).toBe(0);
      expect(read.stdout).toContain("openai-codex");
      // without the group nothing reads it: the tools' uid, any other uid
      expect(as(1001, ["cat", auth], "").status).not.toBe(0);
      expect(as(1002, ["cat", auth], "").status).not.toBe(0);
      // uid C logs in again over A's files: the volume survives a uid change
      loginAs(1002, rg);
      expect(as(1002, ls(auth)).stdout.trim()).toBe(`1000:${GROUP}:660`);
      expect(as(1001, ["cat", auth]).stdout).toContain('"by":1002');
    },
  );

  it.skipIf(!hasNs)(
    "the cli mode, started as root and dropped to uid B, keeps the login group",
    () => {
      const rg = loginRig();
      loginAs(1000, rg);
      put(
        join(rg.r.app, "dist/src/cli.js"),
        `import { readFileSync } from "node:fs";
console.log(JSON.stringify({ uid: process.getuid(), groups: process.getgroups(),
  auth: readFileSync(process.env.HOME + "/.pi/agent/auth.json", "utf8").length > 0 }));\n`,
      );
      const out = spawnSync(NS[0]!, [...NS.slice(1), rg.script, "review"], {
        cwd: rg.r.dir,
        env: { ...rg.r.env, QCR_RUN_UID: "1001", QCR_RUN_GID: "1001" },
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(out.status, out.stderr).toBe(0);
      const seen = JSON.parse(out.stdout) as { uid: number; groups: number[]; auth: boolean };
      expect(seen.uid).toBe(1001);
      expect(seen.groups).toContain(GROUP);
      expect(seen.auth).toBe(true);
    },
  );

  it("a login group that is not a non-zero number is refused at boot", () => {
    const text = read("docker/entrypoint.sh");
    expect(text).toContain('LOGIN_GID="${QCR_LOGIN_GID:-4747}"');
    const r = rig();
    const out = run(r, ["login"], { QCR_LOGIN_GID: "login" });
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain("QCR_LOGIN_GID");
  });
});
