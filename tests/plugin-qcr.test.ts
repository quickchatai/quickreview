// The qcr Claude Code plugin (plugins/qcr, P6.13): skills that call the qcr
// host wrapper with --json, and /qcr-setup. No docker, no gh, no model, no
// network: the scripts run against a fake qcr, docker and gh on PATH that log
// every call, and against the recorded payloads of tests/fixtures/json-contract
// (the goldens the schemas are validated with) plus a few forged ones.
//
//   - qcr-json passes a payload through only when every top-level object leads
//     with a schema_version it knows, and refuses (exit 3, nothing on stdout)
//     any other; it adds --json once and keeps qcr's own exit status;
//   - the SKILL.md files parse as pi/Claude read them, name the one caller, and
//     never call qcr bare;
//   - qcr-setup checks Docker, then pull auth, then the wrapper, then login, in
//     that order, skips what is done, and hands a terminal-only step to the
//     human (exit 10) without running it.
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSkillFrontmatter } from "./helpers/skill-frontmatter.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = join(root, "plugins", "qcr");
const QCR_JSON = join(PLUGIN, "scripts", "qcr-json");
const SETUP = join(PLUGIN, "scripts", "qcr-setup.sh");
const GOLDEN = join(root, "tests", "fixtures", "json-contract");
const FORGED = join(root, "tests", "fixtures", "plugin-qcr");
const TOKEN = "ghp_PLUGIN_SECRET_0123456789";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), "plugin-qcr-"));
  dirs.push(d);
  return d;
};

// ---- qcr-json -------------------------------------------------------------------

// A qcr that prints a recorded payload, logs its argv and exits FAKE_RC.
const FAKE_QCR = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DIR/argv"
if [ -n "\${FAKE_PAYLOAD-}" ]; then cat "$FAKE_PAYLOAD"; fi
exit "\${FAKE_RC-0}"
`;

function qcrJson(
  args: string[],
  o: { payload?: string; rc?: number } = {},
): { status: number | null; stdout: string; stderr: string; argv: string[] } {
  const dir = scratch();
  const fake = join(dir, "qcr");
  writeFileSync(fake, FAKE_QCR, { mode: 0o755 });
  const out = spawnSync("sh", [QCR_JSON, ...args], {
    env: {
      PATH: process.env["PATH"]!,
      TMPDIR: dir,
      QCR_BIN: fake,
      FAKE_DIR: dir,
      ...(o.payload !== undefined ? { FAKE_PAYLOAD: o.payload } : {}),
      FAKE_RC: String(o.rc ?? 0),
    },
    encoding: "utf8",
  });
  const argvFile = join(dir, "argv");
  const argv = existsSync(argvFile)
    ? readFileSync(argvFile, "utf8").split("\n").filter(Boolean)
    : [];
  // the temp payload is gone after the call
  expect(readdirSync(dir).filter((f) => f.startsWith("qcr-json."))).toEqual([]);
  return { status: out.status, stdout: out.stdout, stderr: out.stderr, argv };
}

const golden = (name: string): string => join(GOLDEN, name);

describe("qcr-json — known schema versions", () => {
  const cases: Array<[string, string[], string]> = [
    ["review", ["review", "--preview"], "review-preview.json"],
    ["review", ["review", "--diff", "-", "--preview"], "review-diff-preview.json"],
    ["review", ["review"], "review-done.json"],
    ["review", ["review", "start", "feature"], "review-start.json"],
    ["review", ["review", "status", "run1001000"], "review-status-running.json"],
    ["review", ["review", "status", "run1001000"], "review-status-done.json"],
    ["review", ["review", "stop", "run1001000"], "review-stop.json"],
    ["review", ["review"], "review-refused.json"],
    ["scan", ["scan", "preview"], "scan-preview.json"],
    ["scan", ["scan", "status"], "scan-status.json"],
    ["scan", ["scan", "findings"], "scan-findings.json"],
    ["scan", ["scan", "start", "--key", "K"], "scan-refused.json"],
    ["version", ["version"], "version.json"],
  ];
  for (const [, args, file] of cases) {
    it(`passes ${file} through byte for byte`, () => {
      const r = qcrJson(args, { payload: golden(file) });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toBe(readFileSync(golden(file), "utf8"));
    });
  }

  it("keeps qcr's own exit status beside a valid payload", () => {
    const r = qcrJson(["review"], { payload: golden("review-partial.json"), rc: 1 });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe(readFileSync(golden("review-partial.json"), "utf8"));
  });

  it("does not read a nested result's schema_version", () => {
    const r = qcrJson(["review", "status", "r1"], {
      payload: join(FORGED, "review-nested-v2.json"),
    });
    expect(r.status, r.stderr).toBe(0);
  });
});

describe("qcr-json — refuses what it does not know", () => {
  it("an unknown review version: exit 3, nothing on stdout, the reason on stderr", () => {
    const r = qcrJson(["review", "--preview"], { payload: join(FORGED, "review-schema-v2.json") });
    expect(r.status).toBe(3);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/review schema_version 2/);
    expect(r.stderr).toMatch(/understands 1/);
    expect(r.stderr).toMatch(/qcr update/);
  });

  it("an unknown scan and version schema, likewise", () => {
    const s = qcrJson(["scan", "preview"], { payload: join(FORGED, "scan-schema-v2.json") });
    expect([s.status, s.stdout]).toEqual([3, ""]);
    const v = qcrJson(["version"], { payload: join(FORGED, "version-schema-v2.json") });
    expect([v.status, v.stdout]).toEqual([3, ""]);
  });

  it("refuses a stream when any payload in it is unknown", () => {
    const r = qcrJson(["review", "status", "r1"], {
      payload: join(FORGED, "review-stream.ndjson"),
    });
    expect([r.status, r.stdout]).toEqual([3, ""]);
    expect(r.stderr).toMatch(/schema_version 2/);
  });

  it("refuses an object that does not lead with schema_version", () => {
    const r = qcrJson(["review"], { payload: join(FORGED, "review-no-version.json") });
    expect([r.status, r.stdout]).toEqual([3, ""]);
    expect(r.stderr).toMatch(/schema_version none/);
  });

  it("a v1 review payload is not accepted as a different family's version", () => {
    // each family has its own list; scan 1 and review 1 happen to be equal today,
    // so the check is that the list is read per verb
    const src = readFileSync(QCR_JSON, "utf8");
    expect(src).toMatch(/KNOWN_review="1"/);
    expect(src).toMatch(/KNOWN_scan="1"/);
    expect(src).toMatch(/KNOWN_version="1"/);
  });

  it("no payload at all: qcr's failing status if it failed, else 4", () => {
    const failed = qcrJson(["review"], { rc: 7 });
    expect([failed.status, failed.stdout]).toEqual([7, ""]);
    expect(failed.stderr).toMatch(/exited 7/);
    const silent = qcrJson(["review"], {});
    expect([silent.status, silent.stdout]).toEqual([4, ""]);
  });

  it("only review, scan and version, else usage (2) and qcr is not run", () => {
    const r = qcrJson(["daemon"]);
    expect(r.status).toBe(2);
    expect(r.argv).toEqual([]);
  });
});

describe("qcr-json — what it runs", () => {
  it("adds --json exactly once", () => {
    const a = qcrJson(["review", "--preview"], { payload: golden("review-preview.json") });
    expect(a.argv).toEqual(["review --preview --json"]);
    const b = qcrJson(["review", "--json", "--preview"], {
      payload: golden("review-preview.json"),
    });
    expect(b.argv).toEqual(["review --json --preview"]);
  });

  it("keeps arguments with spaces whole", () => {
    const dir = scratch();
    const fake = join(dir, "qcr");
    writeFileSync(
      fake,
      `#!/bin/sh\nprintf '[%s]' "$@" > "${dir}/argv"\ncat "${golden("review-preview.json")}"\n`,
      {
        mode: 0o755,
      },
    );
    const out = spawnSync("sh", [QCR_JSON, "review", "--base", "release v2"], {
      env: { PATH: process.env["PATH"]!, QCR_BIN: fake },
      encoding: "utf8",
    });
    expect(out.status).toBe(0);
    expect(readFileSync(join(dir, "argv"), "utf8")).toBe("[review][--base][release v2][--json]");
  });
});

// ---- the skills -----------------------------------------------------------------

const SKILLS = ["qcr-review", "qcr-scan", "qcr-setup"] as const;
const skillText = (n: string): string =>
  readFileSync(join(PLUGIN, "skills", n, "SKILL.md"), "utf8");

describe("the plugin's files", () => {
  it("plugin.json and marketplace.json name the same plugin and path", () => {
    const plugin = JSON.parse(
      readFileSync(join(PLUGIN, ".claude-plugin", "plugin.json"), "utf8"),
    ) as {
      name: string;
    };
    const market = JSON.parse(
      readFileSync(join(root, ".claude-plugin", "marketplace.json"), "utf8"),
    ) as {
      plugins: Array<{ name: string; source: string }>;
    };
    expect(plugin.name).toBe("qcr");
    expect(market.plugins).toEqual([
      expect.objectContaining({ name: "qcr", source: "./plugins/qcr" }),
    ]);
    expect(existsSync(join(root, market.plugins[0]!.source, ".claude-plugin", "plugin.json"))).toBe(
      true,
    );
  });

  it("the scripts are executable", () => {
    for (const s of [QCR_JSON, SETUP]) expect(spawnSync("test", ["-x", s]).status, s).toBe(0);
  });

  for (const name of SKILLS) {
    it(`${name}: front matter parses and the name matches its folder`, () => {
      const fm = parseSkillFrontmatter(skillText(name));
      const field = (k: string) => fm.fields.get(k);
      expect(field("name")?.value).toBe(name);
      expect(field("description")?.resolvesTo).toBe("string");
      expect(field("description")!.value.length).toBeGreaterThan(40);
      expect(fm.comments).toBe(0);
    });
  }

  it("review and scan call qcr only through qcr-json, and say to refuse an unknown schema", () => {
    for (const name of ["qcr-review", "qcr-scan"]) {
      const t = skillText(name);
      expect(t).toContain("${CLAUDE_PLUGIN_ROOT}/scripts/qcr-json");
      expect(t).toMatch(/schema_version/);
      expect(t).toMatch(/exits 3/);
      // every command line in a code block goes through the caller
      const bare = t.split("\n").filter((l) => /^\s*(qcr|\$\s*qcr)\s+(review|scan)\b/.test(l));
      expect(bare, name).toEqual([]);
    }
  });

  it("the review skill previews before it runs and posts only on --to pr", () => {
    const t = skillText("qcr-review");
    expect(t).toMatch(/--preview/);
    expect(t).toMatch(/Wait for a go/);
    expect(t).toMatch(/only with `--to pr`/);
    expect(t).not.toMatch(/--post/);
  });

  it("the setup skill names the four steps in order and the exit codes", () => {
    const t = skillText("qcr-setup");
    const at = ["Docker", "Pull access", "The wrapper", "Login"].map((s) => t.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(t).toContain("gh auth refresh -s read:packages");
    expect(t).toMatch(/exits 10/);
  });
});

// ---- qcr-setup ------------------------------------------------------------------

// One log for every fake: `docker …`, `gh …`, `qcr …`, one call per line.
const FAKE_DOCKER = `#!/bin/sh
echo "docker $*" >> "$FAKE_LOG"
case "$1" in
  info) [ -z "\${FAKE_DOCKER_DOWN-}" ] || exit 1; exit 0 ;;
  image) [ -n "\${FAKE_LOCAL_IMAGE-}" ]; exit $? ;;
  manifest)
    # a tag that exists only on this machine is not in any registry
    [ -z "\${FAKE_LOCAL_IMAGE-}" ] || { echo "no such manifest" >&2; exit 1; }
    if [ -f "$FAKE_DIR/logged-in" ] && [ -n "\${FAKE_AFTER_LOGIN_ERR-}" ]; then echo "$FAKE_AFTER_LOGIN_ERR" >&2; exit 1; fi
    if [ -f "$FAKE_DIR/logged-in" ] || [ -z "\${FAKE_NO_PULL-}" ]; then exit 0; fi
    echo "unauthorized" >&2; exit 1 ;;
  login) cat > "$FAKE_DIR/login-stdin"; : > "$FAKE_DIR/logged-in"; exit 0 ;;
  run) ;;
  *) echo "fake docker: unexpected $*" >&2; exit 99 ;;
esac
case " $* " in
  *" --entrypoint test "*) [ -n "\${FAKE_LOGIN_PRESENT-}" ]; exit $? ;;
esac
last=
for a in "$@"; do last=$a; done
if [ "$last" = install ]; then
  out=
  prev=
  for a in "$@"; do
    case "$prev" in -v) out=\${a%:/out} ;; esac
    prev=$a
  done
  [ -n "$out" ] || { echo "fake docker: install without -v dir:/out" >&2; exit 98; }
  cp "$FAKE_DIR/fake-qcr" "$out/qcr"
  chmod 755 "$out/qcr"
  exit 0
fi
exit 97
`;
const FAKE_GH = `#!/bin/sh
echo "gh $*" >> "$FAKE_LOG"
case "$1 $2" in
  "auth refresh") exit 0 ;;
  "auth token") printf '%s\\n' "${TOKEN}"; exit 0 ;;
  "api user") printf 'octocat\\n'; exit 0 ;;
esac
exit 2
`;
// The qcr the image installs: answers version --json (schema from FAKE_VERSION_FILE), logs login.
const FAKE_INSTALLED_QCR = `#!/bin/sh
echo "qcr $*" >> "$FAKE_LOG"
case "$1" in
  version)
    case " $* " in
      *" --json "*) cat "$FAKE_VERSION_FILE" ;;
      *) echo "qcr 0.1.0" ;;
    esac ;;
  login) exit 0 ;;
  *) exit 2 ;;
esac
`;

interface SetupRig {
  home: string;
  dest: string;
  log: () => string[];
  run: (o?: { env?: Record<string, string>; omit?: string[]; onPath?: boolean }) => {
    status: number | null;
    stdout: string;
    stderr: string;
  };
  readFile: (rel: string) => string | null;
}

function setupRig(): SetupRig {
  const dir = scratch();
  const home = join(dir, "home");
  const fakebin = join(dir, "fakebin");
  const tools = join(dir, "tools");
  for (const d of [home, fakebin, tools]) mkdirSync(d, { recursive: true });
  // The tools the scripts use, and nothing else: no real docker, gh or qcr.
  for (const t of [
    "awk",
    "cat",
    "cp",
    "chmod",
    "dirname",
    "head",
    "id",
    "mkdir",
    "mktemp",
    "rm",
    "sed",
    "sh",
    "uname",
  ]) {
    const p = spawnSync("sh", ["-c", `command -v ${t}`], { encoding: "utf8" }).stdout.trim();
    if (p !== "") symlinkSync(p, join(tools, t));
  }
  writeFileSync(join(dir, "fake-qcr"), FAKE_INSTALLED_QCR, { mode: 0o755 });
  writeFileSync(join(dir, "log"), "");
  const dest = join(home, ".local", "bin");
  return {
    home,
    dest,
    log: () => readFileSync(join(dir, "log"), "utf8").split("\n").filter(Boolean),
    readFile: (rel) => (existsSync(join(dir, rel)) ? readFileSync(join(dir, rel), "utf8") : null),
    run: (o = {}) => {
      const omit = new Set(o.omit ?? []);
      if (!omit.has("docker")) writeFileSync(join(fakebin, "docker"), FAKE_DOCKER, { mode: 0o755 });
      if (!omit.has("gh")) writeFileSync(join(fakebin, "gh"), FAKE_GH, { mode: 0o755 });
      if (o.onPath) writeFileSync(join(fakebin, "qcr"), FAKE_INSTALLED_QCR, { mode: 0o755 });
      const out = spawnSync(join(tools, "sh"), [SETUP], {
        env: {
          PATH: `${fakebin}:${tools}`,
          HOME: home,
          TMPDIR: dir,
          FAKE_DIR: dir,
          FAKE_LOG: join(dir, "log"),
          FAKE_VERSION_FILE: join(GOLDEN, "version.json"),
          ...o.env,
        },
        encoding: "utf8",
        input: "",
      });
      return { status: out.status, stdout: out.stdout, stderr: out.stderr };
    },
  };
}

/** The log's lines that start a given tool, in order. */
const calls = (log: string[], prefix: string): string[] => log.filter((l) => l.startsWith(prefix));
const idx = (log: string[], needle: string | RegExp): number =>
  log.findIndex((l) => (typeof needle === "string" ? l.includes(needle) : needle.test(l)));

describe("qcr-setup — step 1, Docker", () => {
  it("no docker: exit 1, says so, touches nothing", () => {
    const rig = setupRig();
    const r = rig.run({ omit: ["docker"] });
    // fakebin has no docker; with the omit the file is never written
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/docker is not installed/);
    expect(rig.log()).toEqual([]);
    expect(existsSync(rig.dest)).toBe(false);
  });

  it("a daemon that does not answer: exit 1 before any pull or install", () => {
    const rig = setupRig();
    const r = rig.run({ env: { FAKE_DOCKER_DOWN: "1" } });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/daemon does not answer/);
    expect(rig.log()).toEqual(["docker info"]);
  });
});

describe("qcr-setup — the order on a fresh machine", () => {
  it("a manifest failure after login shows the registry's own error", () => {
    const rig = setupRig();
    const r = rig.run({
      env: {
        FAKE_NO_PULL: "1",
        QCR_SETUP_INTERACTIVE: "1",
        FAKE_AFTER_LOGIN_ERR: "manifest unknown: no such tag",
      },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("manifest unknown: no such tag");
  });

  it("Docker, then pull auth, then the wrapper, then login, then the version check", () => {
    const rig = setupRig();
    const r = rig.run({ env: { FAKE_NO_PULL: "1", QCR_SETUP_INTERACTIVE: "1" } });
    expect(r.status, r.stderr).toBe(0);
    const log = rig.log();
    const order = [
      idx(log, "docker info"),
      idx(log, "docker manifest inspect"),
      idx(log, "gh auth refresh -s read:packages"),
      idx(log, "docker login ghcr.io"),
      idx(log, /^docker run .* install$/),
      idx(log, "--entrypoint test"),
      idx(log, "qcr login"),
      idx(log, "qcr version --json"),
    ];
    expect(
      order.every((i) => i >= 0),
      JSON.stringify(log),
    ).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // the two ends of the pipe log in either order, so `gh auth token` only has to be there
    expect(idx(log, "gh auth token")).toBeGreaterThan(idx(log, "gh auth refresh"));
    // the token reaches docker login on stdin, never in an argument list
    expect(rig.readFile("login-stdin")).toBe(`${TOKEN}\n`);
    expect(log.join("\n")).not.toContain(TOKEN);
    expect(log[idx(log, "docker login")]).toBe("docker login ghcr.io -u octocat --password-stdin");
    // the wrapper landed in the mounted dir, and the run installs as the caller
    expect(existsSync(join(rig.dest, "qcr"))).toBe(true);
    const install = log[idx(log, /^docker run .* install$/)]!;
    expect(install).toContain(`-v ${rig.dest}:/out`);
    expect(install).toMatch(/--user \d+:\d+/);
    const pkgVersion = (
      JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }
    ).version;
    expect(install).toMatch(
      new RegExp(`ghcr\\.io/[^/ ]+/quickreview:${pkgVersion.replace(/\./g, "\\.")} install$`),
    );
    expect(install).not.toContain(":latest");
    expect(r.stdout).toMatch(/ready: qcr 0\.1\.0/);
    // no gh config, no docker.sock, no model: nothing but the one -v
    expect(log.join("\n")).not.toMatch(/docker\.sock|\.config\/gh/);
  });

  it("a named QCR_IMAGE is the image pulled, installed and handed to the installer to pin", () => {
    const rig = setupRig();
    const r = rig.run({ env: { QCR_IMAGE: "qcr-local:dev", FAKE_LOGIN_PRESENT: "1" } });
    expect(r.status, r.stderr).toBe(0);
    const install = rig.log()[idx(rig.log(), /^docker run .* install$/)]!;
    expect(install).toContain("-e QCR_IMAGE=qcr-local:dev");
    expect(install.endsWith("qcr-local:dev install")).toBe(true);
  });
});

describe("qcr-setup — the image to pull", () => {
  it("the default release tag is the plugin's and the package's version", () => {
    const sh = readFileSync(join(root, "plugins/qcr/scripts/qcr-setup.sh"), "utf8");
    const pinned = /^RELEASE_VERSION=(\S+)$/m.exec(sh)?.[1];
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
    const plugin = JSON.parse(
      readFileSync(join(root, "plugins/qcr/.claude-plugin/plugin.json"), "utf8"),
    ) as {
      version: string;
    };
    expect(pinned).toBe(pkg.version);
    expect(plugin.version).toBe(pkg.version);
    expect(sh).not.toMatch(/quickreview:latest/);
  });

  it("a local-only QCR_IMAGE skips the registry check and the gh path", () => {
    const rig = setupRig();
    const r = rig.run({
      env: {
        QCR_IMAGE: "qcr-local:dev",
        FAKE_LOCAL_IMAGE: "1",
        FAKE_LOGIN_PRESENT: "1",
        QCR_SETUP_INTERACTIVE: "0",
      },
    });
    expect(r.status, r.stderr).toBe(0);
    const log = rig.log();
    expect(idx(log, "docker image inspect qcr-local:dev")).toBeGreaterThanOrEqual(0);
    expect(idx(log, "docker manifest inspect")).toBe(-1);
    expect(calls(log, "gh ")).toEqual([]);
    expect(idx(log, "docker login")).toBe(-1);
    expect(existsSync(join(rig.dest, "qcr"))).toBe(true);
  });
});

describe("qcr-setup — what only the human can do", () => {
  it("no terminal and no pull access: prints the gh commands, exits 10, runs neither", () => {
    const rig = setupRig();
    const r = rig.run({ env: { FAKE_NO_PULL: "1", QCR_SETUP_INTERACTIVE: "0" } });
    expect(r.status).toBe(10);
    expect(r.stderr).toContain("gh auth refresh -s read:packages");
    expect(r.stderr).toContain("gh auth token | docker login ghcr.io");
    const log = rig.log();
    expect(calls(log, "gh ")).toEqual([]);
    expect(idx(log, "docker login")).toBe(-1);
    // pull auth comes before the wrapper: nothing was installed
    expect(idx(log, / install$/)).toBe(-1);
    expect(existsSync(rig.dest)).toBe(false);
  });

  it("pull access but no login and no terminal: installs, then exits 10 naming qcr login", () => {
    const rig = setupRig();
    const r = rig.run({ env: { QCR_SETUP_INTERACTIVE: "0" } });
    expect(r.status).toBe(10);
    expect(r.stderr).toContain(`${join(rig.dest, "qcr")} login`);
    expect(existsSync(join(rig.dest, "qcr"))).toBe(true);
    expect(calls(rig.log(), "qcr login")).toEqual([]);
  });

  it("the GitHub CLI missing when a pull needs it: exit 1 with the alternative", () => {
    const rig = setupRig();
    const r = rig.run({ omit: ["gh"], env: { FAKE_NO_PULL: "1", QCR_SETUP_INTERACTIVE: "1" } });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/GitHub CLI is not installed/);
    expect(r.stderr).toMatch(/read:packages/);
  });
});

describe("qcr-setup — skips what is done", () => {
  it("everything in place: no gh, no install, no login, ready", () => {
    const rig = setupRig();
    const r = rig.run({ onPath: true, env: { FAKE_LOGIN_PRESENT: "1" } });
    expect(r.status, r.stderr).toBe(0);
    const log = rig.log();
    expect(calls(log, "gh ")).toEqual([]);
    expect(idx(log, / install$/)).toBe(-1);
    expect(calls(log, "qcr login")).toEqual([]);
    expect(r.stdout).toMatch(/already holds a login/);
    expect(r.stdout).toMatch(/ready: qcr 0\.1\.0/);
  });

  it("a model API key in the environment stands in for a login", () => {
    const rig = setupRig();
    const r = rig.run({ onPath: true, env: { OPENAI_API_KEY: "sk-fake" } });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/OPENAI_API_KEY is set/);
    expect(calls(rig.log(), "qcr login")).toEqual([]);
    expect(idx(rig.log(), "--entrypoint test")).toBe(-1);
    // the key's value is never echoed
    expect(r.stdout + r.stderr + rig.log().join("\n")).not.toContain("sk-fake");
  });

  it("a wrapper whose schema this plugin does not know is not ready", () => {
    const rig = setupRig();
    const r = rig.run({
      onPath: true,
      env: { FAKE_LOGIN_PRESENT: "1", FAKE_VERSION_FILE: join(FORGED, "version-schema-v2.json") },
    });
    // step 3 sees an installed qcr that fails the check, reinstalls, and the final check still fails
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/qcr update/);
  });
});
