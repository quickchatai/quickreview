// `qcr plugin install|update|uninstall` for the hosts that install through a
// verb of their own: Codex, Copilot CLI, Gemini CLI and Antigravity, at the
// bin's front door (src/qcrbin.ts runBin → src/plugincli.ts), against fake
// `codex`, `copilot`, `gemini` and `agy` executables on a temp PATH. Each fake
// records every argv (and Gemini's workspace-trust variable) and keeps the
// state the real CLI keeps, answering as the real one answered in a throwaway
// HOME (the probes are in src/plugincli.ts's header): Codex refuses a
// marketplace add from another folder until the name is removed; Copilot
// refuses any add of a registered name; Gemini refuses an install over an
// installed extension and prompts for folder trust without the variable;
// Antigravity is from its docs.
//
// What it holds, per host: the render lands in the data home at the running
// release and is the folder the host's verbs are given; a re-install; an
// install and an update over an older release, which re-point the host and
// delete the older render; an uninstall through the host's own verbs; a
// failing host, reported on its own row; `--project`, a skip with the
// reason that runs nothing; and the invoke line the summary prints.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
import { runBin } from "../src/qcrbin.js";
import type { PluginRow } from "../src/plugincli.js";

const ROOT = resolve(import.meta.dirname, "..");
const VERSION = (
  JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }
).version;
const OLD = "1.0.0";
const MKT = "quickreview-local";
const ID = `qcr@${MKT}`;

// What every fake does first: log the call, load its state, and fail when
// its fail file names the verb. Node, so it can keep JSON state; the shebang
// names this node, so the temp PATH needs nothing else on it.
const preamble = (name: string, words: string): string => `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const D = process.env.FAKE_DIR;
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(D, "${name}-argv.log"), JSON.stringify({ argv, trust: process.env.GEMINI_CLI_TRUST_WORKSPACE ?? null }) + "\\n");
const stateFile = path.join(D, "${name}-state.json");
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : {};
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
const failFile = path.join(D, "${name}-fail");
const fail = fs.existsSync(failFile) ? fs.readFileSync(failFile, "utf8").trim() : null;
const die = (m) => { console.error(m); process.exit(1); };
const json = (o) => { console.log(JSON.stringify(o, null, 2)); process.exit(0); };
const read = (dir, rel) => JSON.parse(fs.readFileSync(path.join(dir, rel), "utf8"));
const verb = ${words};
`;

const FAKE_CODEX = `${preamble("codex", `argv.slice(0, argv[1] === "marketplace" ? 3 : 2).join(" ")`)}
if (fail !== null && verb.endsWith(fail)) die("Error: the fake codex was told to fail " + fail);
const m = state.marketplace ?? null;
switch (verb) {
  case "plugin list":
    json({ installed: m && state.installed ? [{ pluginId: state.installed.id, name: "qcr", marketplaceName: m.name, version: state.installed.version, installed: true, enabled: true }] : [], available: [] });
  case "plugin marketplace list":
    json({ marketplaces: m ? [{ name: m.name, root: m.path, marketplaceSource: { sourceType: "local", source: m.path } }] : [] });
  case "plugin marketplace add": {
    const dir = argv[3];
    if (!fs.existsSync(dir)) die("Error: failed to resolve local marketplace source path: No such file or directory (os error 2)");
    const name = read(dir, ".claude-plugin/marketplace.json").name;
    if (m && m.path === dir) json({ marketplaceName: name, installedRoot: dir, alreadyAdded: true });
    if (m) die("Error: marketplace '" + name + "' is already added from a different source; remove it before adding this source");
    state.marketplace = { name, path: dir };
    save();
    json({ marketplaceName: name, installedRoot: dir, alreadyAdded: false });
  }
  case "plugin marketplace remove":
    if (!m || m.name !== argv[3]) die("Error: marketplace \`" + argv[3] + "\` is not configured or installed");
    state.marketplace = null;
    save();
    json({ marketplaceName: argv[3], installedRoot: null });
  case "plugin add": {
    const [plugin, mkt] = argv[2].split("@");
    if (!m || m.name !== mkt) die("Error: plugin \`" + plugin + "\` was not found in marketplace \`" + mkt + "\`");
    state.installed = { id: argv[2], version: read(m.path, "qcr/.codex-plugin/plugin.json").version };
    save();
    json({ pluginId: argv[2], name: plugin, marketplaceName: mkt, version: state.installed.version });
  }
  case "plugin remove":
    state.installed = null;
    save();
    json({ pluginId: argv[2], name: "qcr", marketplaceName: argv[2].split("@")[1] });
  default:
    die("fake codex: unknown command " + argv.join(" "));
}
`;

const FAKE_COPILOT = `${preamble("copilot", `argv.slice(0, argv[1] === "marketplace" ? 3 : 2).join(" ")`)}
if (fail !== null && verb.endsWith(fail)) die("Failed: Error: the fake copilot was told to fail " + fail);
const m = state.marketplace ?? null;
const say = (l) => { console.log(l); process.exit(0); };
const builtin = { name: "browser-use", marketplace: "", version: "0.0.4", enabled: false, source: "builtin" };
switch (verb) {
  case "plugin list":
    json([...(m && state.enabled ? [{ name: "qcr", marketplace: m.name, version: read(m.path, "qcr/.github/plugin/plugin.json").version, enabled: true, source: "live", installedFrom: m.path }] : []), builtin]);
  case "plugin marketplace list":
    json([...(m ? [{ name: m.name, source: "Local: " + m.path, isDefault: false }] : []), { name: "awesome-copilot", source: "GitHub: github/awesome-copilot", isDefault: true }]);
  case "plugin marketplace add": {
    const name = read(argv[3], ".github/plugin/marketplace.json").name;
    if (m && m.name === name) die("Failed to add marketplace: Error: Request plugins.marketplaces.add failed with message: Marketplace \\"" + name + "\\" already registered");
    state.marketplace = { name, path: argv[3] };
    save();
    say("Marketplace \\"" + name + "\\" added successfully.");
  }
  case "plugin marketplace remove":
    if (!m || m.name !== argv[3]) die("Failed to remove marketplace: Error: Marketplace \\"" + argv[3] + "\\" is not registered");
    state.marketplace = null;
    save();
    say("Marketplace \\"" + argv[3] + "\\" removed successfully.");
  case "plugin install": {
    const mkt = argv[2].split("@")[1];
    if (!m || m.name !== mkt) die("Failed to install plugin: Error: Request plugins.install failed with message: Marketplace \\"" + mkt + "\\" not found");
    state.enabled = true;
    save();
    say("Plugin \\"qcr\\" installed successfully. Installed 3 skills.");
  }
  case "plugin uninstall":
    state.enabled = false;
    save();
    say("Plugin \\"" + argv[2] + "\\" disabled. It is still on disk — nothing was removed.");
  default:
    die("fake copilot: unknown command " + argv.join(" "));
}
`;

// Gemini prints every message on stderr, after its consent notice, and an
// empty list there too.
// MUTATION: read a listing from stdout alone in askJson — Gemini's empty
// list reads as no answer, and its install and update rows fail.
const FAKE_GEMINI = `${preamble("gemini", `argv.slice(0, 2).join(" ")`)}
const i = state.installed ?? null;
const said = (l) => { console.error(l); process.exit(0); };
if (verb === "extensions install") {
  if (process.env.GEMINI_CLI_TRUST_WORKSPACE !== "true") die("Do you want to trust this folder and continue with the installation? [y/N]: (stdin is closed)");
  if (!argv.includes("--consent")) die("Do you want to continue? [Y/n]: (stdin is closed)");
  console.error("You have consented to the following:");
}
if (fail !== null && verb.endsWith(fail)) die("the fake gemini was told to fail " + fail);
switch (verb) {
  case "extensions list":
    if (argv.slice(2).join(" ") !== "-o json") die("fake gemini: list wants -o json");
    // an empty list goes to stderr, as Gemini CLI 0.61.0 prints it
    if (!i) { console.error("[]"); process.exit(0); }
    json([{ name: "qcr", version: i.version, path: "/gemini/extensions/qcr", installMetadata: { source: i.source, type: "local" }, isActive: true }]);
  case "extensions install":
    if (i) die("Extension \\"qcr\\" is already installed. Please uninstall it first.");
    state.installed = { version: read(argv[2], "gemini-extension.json").version, source: argv[2] };
    save();
    said("Extension \\"qcr\\" installed successfully and enabled.");
  case "extensions uninstall":
    if (!i) die("Failed to uninstall \\"" + argv[2] + "\\": Extension not found.");
    state.installed = null;
    save();
    said("Extension \\"qcr\\" successfully uninstalled.");
  default:
    die("fake gemini: unknown command " + argv.join(" "));
}
`;

// Antigravity is not probed: this fake follows its documented verbs.
const FAKE_AGY = `${preamble("agy", `argv.slice(0, 2).join(" ")`)}
if (fail !== null && verb.endsWith(fail)) die("the fake agy was told to fail " + fail);
const i = state.installed ?? null;
const say = (l) => { console.log(l); process.exit(0); };
switch (verb) {
  case "plugin list":
    json(i ? [{ name: "qcr", path: i.source, enabled: true }] : []);
  case "plugin install":
    if (i) die("plugin qcr is already installed");
    read(argv[2], "plugin.json");
    state.installed = { source: argv[2] };
    save();
    say("Installed plugin qcr");
  case "plugin uninstall":
    if (!i) die("plugin " + argv[2] + " is not installed");
    state.installed = null;
    save();
    say("Uninstalled plugin qcr");
  default:
    die("fake agy: unknown command " + argv.join(" "));
}
`;

type FakeState = Record<string, unknown>;

interface HostCase {
  host: "codex" | "copilot" | "gemini" | "antigravity";
  exe: string;
  label: string;
  fake: string;
  /** What the person types. */
  invoke: string[];
  /** The verb a failing install fails at, as the fake names it. */
  installVerb: string;
  /** The argv of a fresh install, of one over an older release at `old`,
   * and of an uninstall, given the render `dir`. */
  fresh(dir: string): string[];
  over(dir: string): string[];
  uninstall: string[];
  /** The fake's state as an install of `version` from `dir` left it. */
  installedAt(dir: string, version: string): FakeState;
  /** The folder the host loads QuickReview from, or null. */
  loads(s: FakeState): string | null;
  /** Nothing of QuickReview's is left in the host. */
  clean(s: FakeState): boolean;
}

const rec = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
const pathOf = (v: unknown): string | null => {
  const p = rec(v)?.["path"] ?? rec(v)?.["source"];
  return typeof p === "string" ? p : null;
};

const HOSTS: HostCase[] = [
  {
    host: "codex",
    exe: "codex",
    label: "Codex",
    fake: FAKE_CODEX,
    invoke: ["$qcr:review", "$qcr:scan", "$qcr:setup"],
    installVerb: "plugin add",
    fresh: (dir) => [
      "plugin list --json",
      "plugin marketplace list --json",
      `plugin marketplace add ${dir} --json`,
      `plugin add ${ID} --json`,
    ],
    over: (dir) => [
      "plugin list --json",
      "plugin marketplace list --json",
      `plugin marketplace remove ${MKT} --json`,
      `plugin marketplace add ${dir} --json`,
      `plugin add ${ID} --json`,
    ],
    uninstall: [
      "plugin list --json",
      "plugin marketplace list --json",
      `plugin remove ${ID} --json`,
      `plugin marketplace remove ${MKT} --json`,
    ],
    installedAt: (dir, version) => ({
      marketplace: { name: MKT, path: dir },
      installed: { id: ID, version },
    }),
    loads: (s) =>
      rec(s["installed"])?.["version"] !== undefined ? pathOf(s["marketplace"]) : null,
    clean: (s) => s["marketplace"] === null && s["installed"] === null,
  },
  {
    host: "copilot",
    exe: "copilot",
    label: "Copilot CLI",
    fake: FAKE_COPILOT,
    invoke: ["/qcr-review", "/qcr-scan", "/qcr-setup"],
    installVerb: "plugin install",
    fresh: (dir) => [
      "plugin list --json",
      "plugin marketplace list --json",
      `plugin marketplace add ${dir}`,
      `plugin install ${ID}`,
    ],
    over: (dir) => [
      "plugin list --json",
      "plugin marketplace list --json",
      `plugin marketplace remove ${MKT}`,
      `plugin marketplace add ${dir}`,
      `plugin install ${ID}`,
    ],
    uninstall: [
      "plugin list --json",
      "plugin marketplace list --json",
      `plugin uninstall ${ID}`,
      `plugin marketplace remove ${MKT}`,
    ],
    installedAt: (dir) => ({ marketplace: { name: MKT, path: dir }, enabled: true }),
    loads: (s) => (s["enabled"] === true ? pathOf(s["marketplace"]) : null),
    clean: (s) => s["marketplace"] === null && s["enabled"] === false,
  },
  {
    host: "gemini",
    exe: "gemini",
    label: "Gemini CLI",
    fake: FAKE_GEMINI,
    invoke: ["/qcr:review", "/qcr:scan", "/qcr:setup"],
    installVerb: "extensions install",
    fresh: (dir) => ["extensions list -o json", `extensions install ${dir} --consent`],
    over: (dir) => [
      "extensions list -o json",
      "extensions uninstall qcr",
      `extensions install ${dir} --consent`,
    ],
    uninstall: ["extensions list -o json", "extensions uninstall qcr"],
    installedAt: (dir, version) => ({ installed: { version, source: dir } }),
    loads: (s) => pathOf(s["installed"]),
    clean: (s) => s["installed"] === null,
  },
  {
    host: "antigravity",
    exe: "agy",
    label: "Antigravity",
    fake: FAKE_AGY,
    invoke: ["/qcr:review", "/qcr:scan", "/qcr:setup"],
    installVerb: "plugin install",
    fresh: (dir) => ["plugin list --json", `plugin install ${dir}`],
    over: (dir) => ["plugin list --json", "plugin uninstall qcr", `plugin install ${dir}`],
    uninstall: ["plugin list --json", "plugin uninstall qcr"],
    installedAt: (dir) => ({ installed: { source: dir } }),
    loads: (s) => pathOf(s["installed"]),
    clean: (s) => s["installed"] === null,
  },
];

let dir: string;
let bin: string;
let data: string;
let out: string[];
let err: string[];
const KEYS = [
  "PATH",
  "HOME",
  "XDG_DATA_HOME",
  "FAKE_DIR",
  "QCR_NO_UPDATE_NOTICE",
  "GEMINI_CLI_TRUST_WORKSPACE",
];
const saved: Record<string, string | undefined> = {};
let savedCwd: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "plugin-hosts-")));
  bin = join(dir, "bin");
  data = join(dir, "data");
  mkdirSync(bin);
  mkdirSync(join(dir, "fake"));
  for (const h of HOSTS) writeFileSync(join(bin, h.exe), h.fake, { mode: 0o755 });
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.PATH = bin;
  // a temp HOME: Cursor is found by its ~/.cursor, and is given a copy there
  process.env.HOME = join(dir, "home");
  process.env.XDG_DATA_HOME = data;
  process.env.FAKE_DIR = join(dir, "fake");
  process.env.QCR_NO_UPDATE_NOTICE = "1";
  delete process.env.GEMINI_CLI_TRUST_WORKSPACE;
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

interface Call {
  argv: string[];
  trust: string | null;
}
const logOf = (h: HostCase): string => join(dir, "fake", `${h.exe}-argv.log`);
const calls = (h: HostCase): Call[] =>
  existsSync(logOf(h))
    ? readFileSync(logOf(h), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Call)
    : [];
const argvs = (h: HostCase): string[] => calls(h).map((c) => c.argv.join(" "));
const clearLog = (h: HostCase): void => writeFileSync(logOf(h), "");
const fakeState = (h: HostCase): FakeState =>
  JSON.parse(readFileSync(join(dir, "fake", `${h.exe}-state.json`), "utf8")) as FakeState;
const setState = (h: HostCase, s: FakeState): void =>
  writeFileSync(join(dir, "fake", `${h.exe}-state.json`), JSON.stringify(s));
const failAt = (h: HostCase, verb: string): void =>
  writeFileSync(join(dir, "fake", `${h.exe}-fail`), verb);
const renderDir = (h: HostCase, version = VERSION): string =>
  join(data, "qcr", "plugins", h.host, version);
const hostRender = (h: HostCase, version = VERSION) =>
  render(loadSource(), h.host, { version, contract: TEMPLATE_CONTRACT });

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

const rowOf = (rows: PluginRow[], h: HostCase): PluginRow | undefined =>
  rows.find((r) => r.host === h.host);

/** An older release installed as the installer would have left it: its
 * render, and the host loading it. */
function olderInstall(h: HostCase): string {
  const old = renderDir(h, OLD);
  writeRendered(hostRender(h, OLD), old);
  setState(h, h.installedAt(old, OLD));
  return old;
}

describe.each(HOSTS)("qcr plugin for $label", (h) => {
  // MUTATION: render into the package's own plugins/ instead of the data
  // home — the folder the host is given is not under XDG_DATA_HOME and this
  // fails.
  it("install renders into the data home at this release and installs it through the host's own verbs", async () => {
    const { code, rows } = await qcrJson("plugin", "install", "--to", h.host);
    expect(code).toBe(0);
    const dirGiven = renderDir(h);
    expect(argvs(h)).toEqual(h.fresh(dirGiven));
    expect(renderedDiff(hostRender(h), dirGiven)).toEqual([]);
    for (const c of calls(h)) for (const a of c.argv) expect(a.startsWith(ROOT)).toBe(false);
    expect(h.loads(fakeState(h))).toBe(dirGiven);
    expect(rows).toEqual([
      expect.objectContaining({
        host: h.host,
        outcome: "installed",
        scopes: ["user"],
        version: VERSION,
        dir: dirGiven,
        invoke: h.invoke,
      }),
    ]);
  });

  it("a re-install at the same release succeeds and keeps the host on the same folder", async () => {
    expect(await qcr("plugin", "install", "--to", h.host)).toBe(0);
    clearLog(h);
    const { code, rows } = await qcrJson("plugin", "install", "--to", h.host);
    expect(code).toBe(0);
    expect(rowOf(rows, h)?.outcome).toBe("installed");
    expect(argvs(h).filter((a) => a.includes("remove") || a.includes("uninstall"))).toEqual([]);
    expect(h.loads(fakeState(h))).toBe(renderDir(h));
  });

  // MUTATION: drop the re-point (codex and copilot: the marketplace remove
  // before the add; gemini and agy: the uninstall before the install) — the
  // fake refuses the add or the install and this fails.
  it("install over an older release re-points the host and deletes the older render", async () => {
    const old = olderInstall(h);
    const { code, rows } = await qcrJson("plugin", "install", "--to", h.host);
    expect(code).toBe(0);
    expect(argvs(h)).toEqual(h.over(renderDir(h)));
    expect(rowOf(rows, h)).toEqual(
      expect.objectContaining({ outcome: "updated", version: VERSION, removed: [old] }),
    );
    expect(h.loads(fakeState(h))).toBe(renderDir(h));
    expect(existsSync(old)).toBe(false);
  });

  it("update re-points an older install; with nothing installed it is skipped and only lists", async () => {
    const skipped = await qcrJson("plugin", "update");
    expect(skipped.code).toBe(0);
    expect(rowOf(skipped.rows, h)).toEqual(
      expect.objectContaining({ outcome: "skipped", detail: "QuickReview is not installed here" }),
    );
    expect(argvs(h).every((a) => a.includes("list"))).toBe(true);
    expect(existsSync(renderDir(h))).toBe(false);

    clearLog(h);
    const old = olderInstall(h);
    const { code, rows } = await qcrJson("plugin", "update");
    expect(code).toBe(0);
    expect(argvs(h)).toEqual(h.over(renderDir(h)));
    expect(rowOf(rows, h)).toEqual(
      expect.objectContaining({
        outcome: "updated",
        scopes: ["user"],
        version: VERSION,
        dir: renderDir(h),
        removed: [old],
      }),
    );
    expect(h.loads(fakeState(h))).toBe(renderDir(h));
  });

  // MUTATION: skip the host's uninstall verb in uninstall — the host still
  // loads QuickReview and this fails.
  it("uninstall removes it through the host's own verbs and deletes the renders", async () => {
    expect(await qcr("plugin", "install", "--to", h.host)).toBe(0);
    clearLog(h);
    const { code, rows } = await qcrJson("plugin", "uninstall", "--from", h.host);
    expect(code).toBe(0);
    expect(argvs(h)).toEqual(h.uninstall);
    expect(rows).toEqual([expect.objectContaining({ host: h.host, outcome: "removed" })]);
    expect(h.clean(fakeState(h))).toBe(true);
    expect(h.loads(fakeState(h))).toBeNull();
    expect(existsSync(join(data, "qcr", "plugins", h.host))).toBe(false);

    const again = await qcrJson("plugin", "uninstall", "--from", h.host);
    expect(again.code).toBe(0);
    expect(again.rows[0]!.outcome).toBe("skipped");
  });

  // MUTATION: ignore the install verb's exit code — the row says installed
  // and this fails.
  it("a failing host is a failed row with the host's own message, and exit 1", async () => {
    failAt(h, h.installVerb);
    const { code, ok, rows } = await qcrJson("plugin", "install", "--to", h.host);
    expect(code).toBe(1);
    expect(ok).toBe(false);
    expect(rows).toEqual([
      expect.objectContaining({
        host: h.host,
        outcome: "failed",
        detail: expect.stringMatching(new RegExp(`the fake ${h.exe} was told to fail`)) as unknown,
      }),
    ]);
    expect(await qcr("plugin", "install", "--to", h.host)).toBe(1);
    expect(out.join("\n")).toMatch(new RegExp(`^${h.label}: failed: .*told to fail`, "m"));
  });

  // MUTATION: drop the noProject skip in cmdPlugin — the host is given a
  // user install and this fails.
  it("--project skips it with the reason and runs nothing", async () => {
    const { code, rows } = await qcrJson("plugin", "install", "--to", h.host, "--project");
    expect(code).toBe(0);
    expect(rows).toEqual([
      expect.objectContaining({
        host: h.host,
        outcome: "skipped",
        scopes: [],
        detail: expect.stringMatching(/project scope/) as unknown,
      }),
    ]);
    expect(calls(h)).toEqual([]);
    expect(existsSync(join(data, "qcr"))).toBe(false);
    expect(await qcr("plugin", "install", "--to", h.host, "--project")).toBe(0);
    expect(out.join("\n")).toMatch(new RegExp(`^${h.label}: skipped: .*project scope`, "m"));
  });
});

describe("qcr plugin across these hosts", () => {
  const byHost = (host: string): HostCase => HOSTS.find((h) => h.host === host)!;

  // MUTATION: give Copilot the `$` sigil in the renderer's SIGIL (or
  // drop the invoke line from the summary) — this fails.
  it("the summary prints each host's invoke line and how it picks the plugin up", async () => {
    expect(await qcr("plugin", "install", "--to", "all")).toBe(0);
    const said = out.join("\n");
    expect(said).toMatch(/^Claude Code: skipped: claude is not on PATH$/m);
    for (const [label, line] of [
      ["Codex", "  Type $qcr:review, $qcr:scan or $qcr:setup."],
      ["Copilot CLI", "  Type /qcr-review, /qcr-scan or /qcr-setup."],
      ["Gemini CLI", "  Type /qcr:review, /qcr:scan or /qcr:setup."],
      ["Antigravity", "  Type /qcr:review, /qcr:scan or /qcr:setup."],
    ] as const) {
      const at = out.findIndex((l) => l.startsWith(`${label}: installed at user scope, release `));
      expect(at, label).toBeGreaterThanOrEqual(0);
      expect(out[at + 1]).toBe(line);
      expect(out[at + 2]).toMatch(/^ {2}To pick it up: .+\.$/);
    }
  });

  it("a failure is reported on its own host's row; the others still install", async () => {
    failAt(byHost("codex"), "plugin add");
    const { code, ok, rows } = await qcrJson("plugin", "install", "--to", "all");
    expect(code).toBe(1);
    expect(ok).toBe(false);
    expect(rows.map((r) => [r.host, r.outcome])).toEqual([
      ["claude", "skipped"],
      ["codex", "failed"],
      ["copilot", "installed"],
      ["cursor", "skipped"],
      ["opencode", "skipped"],
      ["gemini", "installed"],
      ["antigravity", "installed"],
    ]);
  });

  // MUTATION: drop the env from Gemini's install — the fake gemini stops at
  // its folder-trust prompt and this fails; set it on process.env instead —
  // the list call carries it and this fails.
  it("Gemini's workspace-trust variable is set for the install call only", async () => {
    const g = byHost("gemini");
    olderInstall(g);
    expect(await qcr("plugin", "install", "--to", "gemini")).toBe(0);
    expect(calls(g).map((c) => [c.argv[1], c.trust])).toEqual([
      ["list", null],
      ["uninstall", null],
      ["install", "true"],
    ]);
    expect(process.env.GEMINI_CLI_TRUST_WORKSPACE).toBeUndefined();
  });

  it("--to all --project installs into none of them, each skipped with its reason", async () => {
    const { code, rows } = await qcrJson("plugin", "install", "--to", "all", "--project");
    expect(code).toBe(0);
    for (const h of HOSTS) {
      expect(rowOf(rows, h)?.outcome).toBe("skipped");
      expect(calls(h)).toEqual([]);
    }
  });
});
