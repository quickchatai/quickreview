// `qcr plugin install|update|uninstall` for Claude Code, at the bin's front
// door (src/qcrbin.ts runBin → src/plugincli.ts), against a fake `claude` on
// a temp PATH. The fake records every argv with its cwd and keeps the state
// the real CLI keeps (the marketplace's folder, the installs per scope, a
// project install's project), answering as Claude Code 2.1.303 answered in a
// throwaway HOME (the probe is in src/plugincli.ts's header): a marketplace
// add re-points the name, an install of an installed plugin changes nothing,
// a project scope's update and uninstall work only from inside that project.
//
// What it holds: the render lands in the data home at the running release,
// the only folder any argv names; user and project scope; a re-install; an
// update that re-points every scope and deletes the older render; an
// uninstall through Claude Code's own verbs; a failing claude; a claude not
// on PATH; and the usage errors, which run nothing.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadSource,
  render,
  renderedDiff,
  TEMPLATE_CONTRACT,
  writeRendered,
} from "../plugins/qcr/render.mjs";
import { binRoute, runBin } from "../src/qcrbin.js";
import type { PluginRow } from "../src/plugincli.js";

const ROOT = resolve(import.meta.dirname, "..");
const VERSION = (
  JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }
).version;
const ID = "qcr@quickreview-local";

// The fake: node, so it can keep JSON state; its shebang names this node, so
// the temp PATH needs nothing else on it.
const FAKE_CLAUDE = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const [stateFile, logFile, fail] = [process.env.FAKE_CLAUDE_STATE, process.env.FAKE_CLAUDE_LOG, process.env.FAKE_CLAUDE_FAIL];
const argv = process.argv.slice(2);
fs.appendFileSync(logFile, JSON.stringify({ argv, cwd: process.cwd() }) + "\\n");
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : { marketplace: null, installs: [] };
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
const say = (o, code) => { console.log(JSON.stringify(o)); process.exit(code); };
const failed = (message, failureCode) => { console.log(JSON.stringify({ outcome: "failed", message, failureCode })); console.error("✘ " + message); process.exit(1); };
const verb = argv.slice(0, argv[1] === "marketplace" ? 3 : 2).join(" ");
if (fail !== undefined && verb.endsWith(fail)) failed("the fake claude was told to fail " + fail, "boom");
const scopeOf = () => argv[argv.indexOf("-s") + 1] ?? "user";
const here = () => fs.realpathSync(process.cwd());
const at = (scope) => state.installs.findIndex((e) => e.scope === scope && (scope === "user" || e.projectPath === here()));
const folderVersion = () => JSON.parse(fs.readFileSync(path.join(state.marketplace.path, "qcr", ".claude-plugin", "plugin.json"), "utf8")).version;
switch (verb) {
  case "plugin list":
    console.log(JSON.stringify(state.installs.map((e) => ({ id: e.id, version: e.version, scope: e.scope, enabled: true, ...(e.projectPath ? { projectPath: e.projectPath } : {}) })), null, 2));
    process.exit(0);
  case "plugin marketplace list":
    console.log(JSON.stringify(state.marketplace ? [{ name: state.marketplace.name, source: "directory", path: state.marketplace.path }] : [], null, 2));
    process.exit(0);
  case "plugin marketplace add": {
    const dir = argv[3];
    if (!fs.existsSync(dir)) failed("Path does not exist: " + dir, "invalid_source");
    const name = JSON.parse(fs.readFileSync(path.join(dir, ".claude-plugin", "marketplace.json"), "utf8")).name;
    state.marketplace = { name, path: dir };
    save();
    say({ command: "marketplace-add", outcome: "ok", marketplace: name, message: "Successfully added marketplace: " + name }, 0);
  }
  case "plugin marketplace remove":
    if (!state.marketplace || state.marketplace.name !== argv[3]) failed("Marketplace '" + argv[3] + "' not found", "not_configured");
    state.marketplace = null;
    save();
    say({ command: "marketplace-remove", outcome: "ok", message: "Successfully removed marketplace: " + argv[3] }, 0);
  case "plugin install": {
    if (!state.marketplace) failed("Plugin not found in any marketplace", "not_found");
    const scope = scopeOf();
    const i = at(scope);
    if (i >= 0) say({ command: "install", outcome: "ok", message: "Plugin is already installed (scope: " + scope + ")", installedVersion: state.installs[i].version }, 0);
    state.installs.push({ id: argv[2], version: folderVersion(), scope, ...(scope === "user" ? {} : { projectPath: here() }) });
    save();
    say({ command: "install", outcome: "ok", message: "Successfully installed plugin: " + argv[2] + " (scope: " + scope + ")" }, 0);
  }
  case "plugin update": {
    const scope = scopeOf();
    const i = at(scope);
    if (i < 0) failed("Plugin is not installed at scope " + scope, "not_installed_at_scope");
    const from = state.installs[i].version;
    const to = folderVersion();
    state.installs[i].version = to;
    save();
    say({ command: "update", outcome: "ok", message: from === to ? "qcr is already at the latest version (" + to + ")." : "Plugin \\"qcr\\" updated from " + from + " to " + to + " for scope " + scope + ". Restart to apply changes." }, 0);
  }
  case "plugin uninstall": {
    const scope = scopeOf();
    const i = at(scope);
    if (i < 0) failed("Plugin is not installed at scope " + scope, "not_installed_at_scope");
    state.installs.splice(i, 1);
    save();
    say({ command: "uninstall", outcome: "ok", message: "Successfully uninstalled plugin: qcr (scope: " + scope + ")" }, 0);
  }
  default:
    console.error("fake claude: unknown command " + argv.join(" "));
    process.exit(2);
}
`;

interface Call {
  argv: string[];
  cwd: string;
}

interface FakeState {
  marketplace: { name: string; path: string } | null;
  installs: Array<{ id: string; version: string; scope: string; projectPath?: string }>;
}

let dir: string;
let bin: string;
let data: string;
let project: string;
let out: string[];
let err: string[];
const KEYS = [
  "PATH",
  "XDG_DATA_HOME",
  "FAKE_CLAUDE_STATE",
  "FAKE_CLAUDE_LOG",
  "FAKE_CLAUDE_FAIL",
  "QCR_NO_UPDATE_NOTICE",
];
const saved: Record<string, string | undefined> = {};
let savedCwd: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "plugin-claude-")));
  bin = join(dir, "bin");
  data = join(dir, "data");
  project = join(dir, "project");
  mkdirSync(bin);
  mkdirSync(project);
  writeFileSync(join(bin, "claude"), FAKE_CLAUDE, { mode: 0o755 });
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.PATH = bin;
  process.env.XDG_DATA_HOME = data;
  process.env.FAKE_CLAUDE_STATE = join(dir, "claude-state.json");
  process.env.FAKE_CLAUDE_LOG = join(dir, "claude-argv.log");
  delete process.env.FAKE_CLAUDE_FAIL;
  process.env.QCR_NO_UPDATE_NOTICE = "1";
  savedCwd = process.cwd();
  process.chdir(dir);
  out = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation((l: unknown) => void out.push(String(l)));
  vi.spyOn(console, "error").mockImplementation((l: unknown) => void err.push(String(l)));
  process.exitCode = undefined;
});

afterEach(() => {
  process.chdir(savedCwd);
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
  process.exitCode = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const calls = (): Call[] =>
  existsSync(process.env.FAKE_CLAUDE_LOG!)
    ? readFileSync(process.env.FAKE_CLAUDE_LOG!, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Call)
    : [];
const argvs = (): string[] => calls().map((c) => c.argv.join(" "));
const fakeState = (): FakeState =>
  JSON.parse(readFileSync(process.env.FAKE_CLAUDE_STATE!, "utf8")) as FakeState;
const renderDir = (version = VERSION): string => join(data, "qcr", "plugins", "claude", version);
const claudeRender = (version = VERSION) =>
  render(loadSource(), "claude", { version, contract: TEMPLATE_CONTRACT });

/** Run the bin; its exit code, with the logs cleared for the next run. */
async function qcr(...argv: string[]): Promise<number> {
  out.length = 0;
  err.length = 0;
  process.exitCode = undefined;
  await runBin(argv);
  return Number(process.exitCode ?? 0);
}

async function qcrJson(
  ...argv: string[]
): Promise<{ code: number; rows: PluginRow[]; ok: boolean }> {
  const code = await qcr(...argv, "--json");
  const payload = JSON.parse(out.join("\n")) as { ok: boolean; hosts: PluginRow[] };
  return { code, rows: payload.hosts, ok: payload.ok };
}

/** An older release installed as the installer would have left it: its
 * render, the marketplace on it, and installs at `scopes`. */
function olderInstall(version: string, scopes: Array<"user" | "project">): string {
  const old = renderDir(version);
  writeRendered(claudeRender(version), old);
  const state: FakeState = {
    marketplace: { name: "quickreview-local", path: old },
    installs: scopes.map((scope) => ({
      id: ID,
      version,
      scope,
      ...(scope === "project" ? { projectPath: project } : {}),
    })),
  };
  writeFileSync(process.env.FAKE_CLAUDE_STATE!, JSON.stringify(state));
  return old;
}

describe("qcr plugin's route", () => {
  it("is the bin's own, with --json taken off", () => {
    expect(binRoute(["plugin", "install", "--to", "claude", "--json"])).toEqual({
      route: "plugin",
      args: ["install", "--to", "claude"],
      json: true,
    });
  });
});

describe("qcr plugin install --to claude", () => {
  // MUTATION: render into the package's own plugins/ instead of the data
  // home — the folder claude is given is not under XDG_DATA_HOME and this fails.
  it("renders into the data home at this release and installs it at user scope", async () => {
    expect(await qcr("plugin", "install", "--to", "claude")).toBe(0);
    const dirGiven = renderDir();
    expect(argvs()).toEqual([
      "plugin list --json",
      `plugin marketplace add ${dirGiven} --json`,
      `plugin install ${ID} -s user --json`,
    ]);
    // the folder is exactly the render, and no argv names the package
    expect(renderedDiff(claudeRender(), dirGiven)).toEqual([]);
    for (const c of calls()) for (const a of c.argv) expect(a.startsWith(ROOT)).toBe(false);
    expect(fakeState().installs).toEqual([{ id: ID, version: VERSION, scope: "user" }]);
    const said = out.join("\n");
    expect(said).toMatch(/^Claude Code: installed at user scope, release /);
    expect(said).toContain("/qcr:review, /qcr:scan or /qcr:setup");
    expect(said).toContain("/reload-plugins");
  });

  it("installs at the project scope with --project, from the project", async () => {
    process.chdir(project);
    const { code, rows } = await qcrJson("plugin", "install", "--to", "claude", "--project");
    expect(code).toBe(0);
    expect(rows).toEqual([
      expect.objectContaining({
        host: "claude",
        outcome: "installed",
        scopes: ["project"],
        version: VERSION,
        dir: renderDir(),
        invoke: ["/qcr:review", "/qcr:scan", "/qcr:setup"],
      }),
    ]);
    const install = calls().find((c) => c.argv[1] === "install")!;
    expect(install.argv).toEqual(["plugin", "install", ID, "-s", "project", "--json"]);
    expect(install.cwd).toBe(project);
    expect(fakeState().installs).toEqual([
      { id: ID, version: VERSION, scope: "project", projectPath: project },
    ]);
  });

  it("a re-install at the same release keeps the folder and changes nothing", async () => {
    expect(await qcr("plugin", "install", "--to", "claude")).toBe(0);
    const before = readdirSync(renderDir(), { recursive: true }).sort();
    const { code, rows } = await qcrJson("plugin", "install", "--to", "claude");
    expect(code).toBe(0);
    expect(rows[0]!.outcome).toBe("installed");
    expect(argvs().filter((a) => a.startsWith("plugin update"))).toEqual([]);
    expect(readdirSync(renderDir(), { recursive: true }).sort()).toEqual(before);
    expect(fakeState().installs).toHaveLength(1);
  });

  // MUTATION: drop the `plugin update` after the install — the older release
  // stays installed and this fails.
  it("over an older release, re-points it, updates it and deletes the older render", async () => {
    const old = olderInstall("1.0.0", ["user"]);
    const { code, rows } = await qcrJson("plugin", "install", "--to", "claude");
    expect(code).toBe(0);
    expect(rows[0]).toEqual(
      expect.objectContaining({ outcome: "updated", version: VERSION, removed: [old] }),
    );
    expect(argvs()).toContain(`plugin update ${ID} -s user --json`);
    expect(fakeState().installs).toEqual([{ id: ID, version: VERSION, scope: "user" }]);
    expect(existsSync(old)).toBe(false);
  });
});

describe("qcr plugin update", () => {
  // MUTATION: keep every render in tidy (return before deleting) — the
  // older release's folder stays and this fails.
  it("re-renders at this release, re-points every scope from its own place, and tidies", async () => {
    const old = olderInstall("1.0.0", ["user", "project"]);
    const { code, rows } = await qcrJson("plugin", "update");
    expect(code).toBe(0);
    expect(rows).toEqual([
      expect.objectContaining({
        host: "claude",
        outcome: "updated",
        scopes: ["user", "project"],
        version: VERSION,
        dir: renderDir(),
        removed: [old],
      }),
    ]);
    expect(fakeState().marketplace?.path).toBe(renderDir());
    expect(fakeState().installs.map((e) => e.version)).toEqual([VERSION, VERSION]);
    const project_ = calls().find(
      (c) => c.argv.join(" ") === `plugin update ${ID} -s project --json`,
    );
    expect(project_?.cwd).toBe(project);
    expect(existsSync(old)).toBe(false);
    expect(readdirSync(join(data, "qcr", "plugins", "claude"))).toEqual([VERSION]);
  });

  it("skips a claude with nothing installed, and touches nothing", async () => {
    const { code, rows } = await qcrJson("plugin", "update");
    expect(code).toBe(0);
    expect(rows).toEqual([expect.objectContaining({ host: "claude", outcome: "skipped" })]);
    expect(
      argvs().filter((a) => !a.startsWith("plugin list") && !a.includes("list --json")),
    ).toEqual([]);
    expect(existsSync(join(data, "qcr", "plugins", "claude", VERSION))).toBe(false);
  });
});

describe("qcr plugin uninstall --from claude", () => {
  // MUTATION: skip the `marketplace remove` — the marketplace stays declared
  // and this fails.
  it("removes every scope's install, the marketplace and the renders through claude's own verbs", async () => {
    expect(await qcr("plugin", "install", "--to", "claude")).toBe(0);
    process.chdir(project);
    expect(await qcr("plugin", "install", "--to", "claude", "--project")).toBe(0);
    process.chdir(dir);
    writeFileSync(process.env.FAKE_CLAUDE_LOG!, "");
    const { code, rows } = await qcrJson("plugin", "uninstall", "--from", "claude");
    expect(code).toBe(0);
    expect(rows).toEqual([
      expect.objectContaining({ host: "claude", outcome: "removed", scopes: ["user", "project"] }),
    ]);
    const un = calls().filter((c) => c.argv[1] === "uninstall");
    expect(un.map((c) => [c.argv.join(" "), c.cwd])).toEqual([
      [`plugin uninstall ${ID} -s user --json`, dir],
      [`plugin uninstall ${ID} -s project --json`, project],
    ]);
    expect(argvs()).toContain("plugin marketplace remove quickreview-local --json");
    expect(fakeState()).toEqual({ marketplace: null, installs: [] });
    expect(existsSync(join(data, "qcr", "plugins", "claude"))).toBe(false);

    // a second uninstall has nothing to do
    const again = await qcrJson("plugin", "uninstall", "--from", "all");
    expect(again.code).toBe(0);
    expect(again.rows[0]!.outcome).toBe("skipped");
  });
});

describe("when claude fails or is missing", () => {
  // MUTATION: ignore the install's exit code — the row says installed and
  // this fails.
  it("a failing claude is a failed row, with claude's own message, and exit 1", async () => {
    process.env.FAKE_CLAUDE_FAIL = "install";
    expect(await qcr("plugin", "install", "--to", "claude")).toBe(1);
    expect(out.join("\n")).toMatch(
      /^Claude Code: failed: the fake claude was told to fail install$/m,
    );
    const { code, ok, rows } = await qcrJson("plugin", "install", "--to", "all");
    expect(code).toBe(1);
    expect(ok).toBe(false);
    expect(rows[0]!.outcome).toBe("failed");
  });

  it("a failing list stops before anything is pointed", async () => {
    process.env.FAKE_CLAUDE_FAIL = "list";
    expect(await qcr("plugin", "update")).toBe(1);
    expect(argvs()).toEqual(["plugin list --json"]);
  });

  it("a claude not on PATH is skipped, and --to all with no host found says so, exit 0", async () => {
    process.env.PATH = join(dir, "empty");
    const named = await qcrJson("plugin", "install", "--to", "claude");
    expect(named.code).toBe(0);
    expect(named.rows).toEqual([
      expect.objectContaining({
        host: "claude",
        outcome: "skipped",
        detail: "claude is not on PATH",
      }),
    ]);
    expect(await qcr("plugin", "install", "--to", "all")).toBe(0);
    expect(out.join("\n")).toMatch(/no coding-agent CLI found on PATH/);
    expect(existsSync(join(data, "qcr"))).toBe(false);
  });
});

describe("usage", () => {
  // MUTATION: let parse take an unknown flag — `install --to claude --bogus`
  // runs claude and this fails.
  it.each([
    [[]],
    [["frobnicate"]],
    [["install"]],
    [["install", "--to"]],
    [["install", "--to", "codex"]],
    [["install", "--to", "claude", "--bogus"]],
    [["install", "--from", "claude"]],
    [["install", "--to", "claude", "--to", "claude"]],
    [["update", "--to", "claude"]],
    [["update", "--project"]],
    [["uninstall"]],
    [["uninstall", "--from", "claude", "--project"]],
  ])("qcr plugin %j is a usage error that runs nothing", async (args) => {
    expect(await qcr("plugin", ...args)).toBe(2);
    expect(err.join("\n")).toMatch(/^qcr plugin: [\s\S]*usage: qcr plugin install/);
    expect(calls()).toEqual([]);
    expect(await qcr("plugin", ...args, "--json")).toBe(2);
    expect(JSON.parse(out.join("\n"))).toHaveProperty("error");
  });

  it("qcr plugin --help prints the usage and the hosts, exit 0", async () => {
    expect(await qcr("plugin", "--help")).toBe(0);
    expect(out.join("\n")).toMatch(/usage: qcr plugin install --to <host\|all>/);
    expect(out.join("\n")).toMatch(/hosts: claude/);
  });
});
