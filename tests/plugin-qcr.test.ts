// The qcr Claude Code plugin: its skills as the one skill source renders them
// for Claude Code (plugins/qcr/render.mjs; every host's render is
// tests/plugin-render.test.ts), which call qcr as `qcr --schema 1 …` (the
// contract flag itself is tests/schema-flag.test.ts), and the Docker-era
// /qcr-setup script, which stays until the installer replaces it. No docker,
// no gh, no model, no network: the script runs against a fake qcr, docker and
// gh on PATH that log every call, and against the recorded version payload of
// tests/fixtures/json-contract.
//
//   - the rendered SKILL.md files parse as pi/Claude read them, call qcr only
//     with the plugin's contract, and never bare;
//   - the setup skill checks qcr's contract, then the login, with no Docker;
//   - qcr-setup.sh checks Docker, then pull auth, then the wrapper, then login,
//     in that order, skips what is done, and hands a terminal-only step to the
//     human (exit 10) without running it.
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSkillFrontmatter } from "./helpers/skill-frontmatter.js";
import { loadSource, render, TEMPLATE_CONTRACT } from "../plugins/qcr/render.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = join(root, "plugins", "qcr");
const SETUP = join(PLUGIN, "scripts", "qcr-setup.sh");
const GOLDEN = join(root, "tests", "fixtures", "json-contract");
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

// ---- the skills -----------------------------------------------------------------

const SKILLS = ["review", "scan", "setup"] as const;
const CLAUDE = render(loadSource(), "claude", {
  version: (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string })
    .version,
  contract: TEMPLATE_CONTRACT,
});
const skillText = (n: string): string => CLAUDE[`qcr/skills/${n}/SKILL.md`]!;

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

  it("the setup script is executable", () => {
    expect(spawnSync("test", ["-x", SETUP]).status).toBe(0);
  });

  // MUTATION: restore plugins/qcr/scripts/qcr-json, or name it in a template — this fails.
  it("has no schema wrapper of its own: qcr reads the contract flag itself", () => {
    expect(existsSync(join(PLUGIN, "scripts", "qcr-json"))).toBe(false);
    for (const name of SKILLS) expect(skillText(name), name).not.toContain("qcr-json");
    expect(readFileSync(SETUP, "utf8")).not.toContain("qcr-json");
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

  // MUTATION: drop `--schema {{schema}}` from one command in the host table of
  // plugins/qcr/templates/review.md — this fails.
  it("review and scan call qcr only with contract 1, and say what a refusal looks like", () => {
    for (const [name, verb] of [
      ["review", "review"],
      ["scan", "scan"],
    ] as const) {
      const t = skillText(name);
      expect(t).toContain(`qcr --schema 1 ${verb}`);
      expect(t).toMatch(/schema_version/);
      expect(t).toMatch(/exits 3 with nothing on stdout/);
      // every command in a code span or block that runs the verb carries the contract
      const code = [...t.matchAll(/```[\s\S]*?```|`[^`\n]+`/g)].map((m) => m[0]);
      const runs = code.filter((c) => /\bqcr\b[^`]*\b(review|scan)\b/.test(c));
      expect(runs.length, name).toBeGreaterThan(2);
      const bare = runs.filter((c) => !/\bqcr --schema 1 (review|scan)\b/.test(c));
      expect(bare, name).toEqual([]);
    }
  });

  it("the review skill previews before it runs and posts only on --to pr", () => {
    const t = skillText("review");
    expect(t).toMatch(/--preview/);
    expect(t).toMatch(/Wait for a go/);
    expect(t).toMatch(/only with `--to pr`/);
    expect(t).not.toMatch(/--post/);
  });

  // MUTATION: put the Docker steps back in plugins/qcr/templates/setup.md's
  // host body — this fails.
  it("the setup skill checks qcr's contract, then the login, and offers the npm install", () => {
    const t = skillText("setup");
    const at = ["qcr --schema 1 version", "auth.json", "`qcr login`"].map((s) => t.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(t).toContain("npm i -g @quickchatai/quickreview");
    expect(t).not.toMatch(/docker|ghcr|CLAUDE_PLUGIN_ROOT|qcr-setup\.sh/i);
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
// The qcr the image installs: answers \`--schema N version\` for the contracts in
// FAKE_CONTRACTS (default 1) with FAKE_VERSION_FILE, refuses another N with 3,
// and, as a qcr from before the flag would, any --schema with 2 under
// FAKE_NO_SCHEMA_FLAG. Logs every call.
const FAKE_INSTALLED_QCR = `#!/bin/sh
echo "qcr $*" >> "$FAKE_LOG"
case "$1" in
  --schema)
    [ -z "\${FAKE_NO_SCHEMA_FLAG-}" ] || { echo "unknown command: --schema" >&2; exit 2; }
    case " \${FAKE_CONTRACTS-1} " in
      *" $2 "*) ;;
      *) echo "qcr --schema: this qcr does not print contract $2" >&2; exit 3 ;;
    esac
    [ "$3" = version ] || exit 2
    cat "$FAKE_VERSION_FILE" ;;
  version) echo "qcr 0.1.0" ;;
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
      idx(log, "qcr --schema 1 version"),
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

  // MUTATION: make the final check `"$QCR" version` again — this fails.
  for (const [what, env] of [
    ["a qcr that does not print contract 1", { FAKE_CONTRACTS: "2" }],
    ["a qcr from before the --schema flag", { FAKE_NO_SCHEMA_FLAG: "1" }],
  ] as const) {
    it(`${what} is not ready`, () => {
      const rig = setupRig();
      const r = rig.run({ onPath: true, env: { FAKE_LOGIN_PRESENT: "1", ...env } });
      // step 3 sees an installed qcr that fails the check, reinstalls, and the final check still fails
      expect(r.status).toBe(1);
      expect(idx(rig.log(), / install$/)).toBeGreaterThanOrEqual(0);
      expect(r.stderr).toMatch(/--schema 1 version/);
      expect(r.stderr).toMatch(/qcr update/);
    });
  }
});
