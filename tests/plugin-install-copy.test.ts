// `qcr plugin install|update|uninstall` for the hosts with no install verb,
// Cursor and opencode, at the bin's front door (src/qcrbin.ts runBin →
// src/plugincli.ts), in a temp HOME and data home. The render is copied
// where the host loads it: Cursor's `~/.cursor/plugins/local/qcr`, and
// opencode's global skills folder, `$XDG_CONFIG_HOME/opencode/skills`. The
// fake `cursor-agent` and `opencode` on the temp PATH only make the host
// found; no verb of theirs is ever run, and each records a call if one is.
//
// What it holds: the copy equals the render, which stays in the data home at
// the running release; uninstall leaves the home exactly as it was before the
// install, keeping whatever the person put there, inside the copy's folders
// too; an install never writes over a path it did not write; update rewrites
// the copy at this release, deletes what an older release wrote and this one
// does not, and touches only the hosts with an install; `--to all` installs
// into every host found (Cursor by its config directory alone) and names each
// one skipped as not found, and with none found exits 0 and says so;
// `--from all` reaches a copy whose host is gone.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

let dir: string;
let home: string;
let bin: string;
let data: string;
let out: string[];
let err: string[];
const KEYS = ["PATH", "HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "QCR_NO_UPDATE_NOTICE"];
const saved: Record<string, string | undefined> = {};
let savedCwd: string;

interface CopyCase {
  host: "cursor" | "opencode";
  label: string;
  /** The executable that makes the host found. */
  exe: string;
  /** The folder the host loads QuickReview from. */
  dest(): string;
  /** Where each rendered file lands, by its path in the render. */
  target(renderPath: string): string;
  /** The person's own files there before any install, under HOME. */
  theirs: Record<string, string>;
  /** A file the person adds inside a folder of the copy. */
  inside(): string;
  /** A path of the person's own where the copy would land. */
  inTheWay(): string;
}

const CASES: CopyCase[] = [
  {
    host: "cursor",
    label: "Cursor",
    exe: "cursor-agent",
    dest: () => join(home, ".cursor", "plugins", "local", "qcr"),
    target: (p) => join(home, ".cursor", "plugins", "local", "qcr", p),
    theirs: {
      ".cursor/mcp.json": "{}\n",
      ".cursor/plugins/local/other/.cursor-plugin/plugin.json": '{"name":"other"}\n',
    },
    inside: () => join(home, ".cursor", "plugins", "local", "qcr", "skills", "notes.md"),
    inTheWay: () => join(home, ".cursor", "plugins", "local", "qcr", "README.md"),
  },
  {
    host: "opencode",
    label: "opencode",
    exe: "opencode",
    dest: () => join(home, ".config", "opencode", "skills"),
    target: (p) => join(home, ".config", "opencode", p),
    theirs: {
      ".config/opencode/opencode.json": "{}\n",
      ".config/opencode/skills/mine/SKILL.md": "---\nname: mine\n---\n",
    },
    inside: () => join(home, ".config", "opencode", "skills", "qcr-review", "notes.md"),
    inTheWay: () => join(home, ".config", "opencode", "skills", "qcr-scan", "SKILL.md"),
  },
];

const byHost = (host: string): CopyCase => CASES.find((c) => c.host === host)!;

/** A fake host executable that records a call, which nothing should make. */
const fake = (exe: string): void =>
  writeFileSync(
    join(bin, exe),
    `#!/bin/sh\necho "$*" >> '${join(dir, `${exe}-ran.log`)}'\nexit 1\n`,
    { mode: 0o755 },
  );
const ran = (): string[] => readdirSync(dir).filter((f) => f.endsWith("-ran.log"));

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "plugin-copy-")));
  home = join(dir, "home");
  bin = join(dir, "bin");
  data = join(dir, "data");
  mkdirSync(home);
  mkdirSync(bin);
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.PATH = bin;
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  process.env.XDG_DATA_HOME = data;
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

/** Run the bin; its exit code, with the logs cleared for the next run. */
async function qcr(...argv: string[]): Promise<number> {
  out.length = 0;
  err.length = 0;
  process.exitCode = undefined;
  await runBin(argv);
  return Number(process.exitCode ?? 0);
}

async function qcrJson(...argv: string[]): Promise<{ code: number; rows: PluginRow[] }> {
  const code = await qcr(...argv, "--json");
  return { code, rows: (JSON.parse(out.join("\n")) as { hosts: PluginRow[] }).hosts };
}

const rowOf = (rows: PluginRow[], host: string): PluginRow | undefined =>
  rows.find((r) => r.host === host);

/** Every path under `at`, a folder as `/` and a file as its content. */
function tree(at: string): Record<string, string> {
  const seen: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (lstatSync(p).isDirectory()) {
        seen[`${p.slice(at.length)}/`] = "/";
        walk(p);
      } else seen[p.slice(at.length)] = readFileSync(p, "utf8");
    }
  };
  if (existsSync(at)) walk(at);
  return seen;
}

function writeTheirs(c: CopyCase): void {
  for (const [rel, content] of Object.entries(c.theirs)) {
    mkdirSync(dirname(join(home, rel)), { recursive: true });
    writeFileSync(join(home, rel), content);
  }
}

const hostRender = (c: CopyCase, version = VERSION): Record<string, string> =>
  render(loadSource(), c.host, { version, contract: TEMPLATE_CONTRACT });
/** The rendered files the host loads: every one for Cursor, the skills for
 * opencode. */
const copied = (c: CopyCase, version = VERSION): [string, string][] =>
  Object.entries(hostRender(c, version)).filter(
    ([p]) => c.host === "cursor" || p.startsWith("skills/"),
  );
const renderDir = (c: CopyCase, version = VERSION): string =>
  join(data, "qcr", "plugins", c.host, version);
const recordOf = (c: CopyCase): string => join(data, "qcr", "plugins", `${c.host}.copy.json`);

function expectCopyAt(c: CopyCase, version = VERSION): void {
  for (const [p, content] of copied(c, version))
    expect(readFileSync(c.target(p), "utf8"), p).toBe(content);
}

describe.each(CASES)("qcr plugin for $label, by copy", (c) => {
  beforeEach(() => {
    fake(c.exe);
    writeTheirs(c);
  });

  // MUTATION: copy into the data home's render alone (skip the copy loop) —
  // the host's folder holds nothing and this fails.
  it("install copies the render where the host loads it, and keeps the render in the data home", async () => {
    const before = tree(home);
    const { code, rows } = await qcrJson("plugin", "install", "--to", c.host);
    expect(code).toBe(0);
    expect(rows).toEqual([
      expect.objectContaining({
        host: c.host,
        outcome: "installed",
        scopes: ["user"],
        version: VERSION,
        dir: c.dest(),
        invoke: ["/qcr-review", "/qcr-scan", "/qcr-setup"],
      }),
    ]);
    expectCopyAt(c);
    expect(renderedDiff(hostRender(c), renderDir(c))).toEqual([]);
    // the person's own files are as they were
    const now = tree(home);
    for (const [p, v] of Object.entries(before)) expect(now[p], p).toBe(v);
    expect(ran()).toEqual([]);
  });

  it("a re-install at the same release succeeds, and the summary says how the host picks it up", async () => {
    expect(await qcr("plugin", "install", "--to", c.host)).toBe(0);
    const first = tree(home);
    expect(await qcr("plugin", "install", "--to", c.host)).toBe(0);
    expect(tree(home)).toEqual(first);
    const at = out.findIndex(
      (l) => l === `${c.label}: installed at user scope, release ${VERSION}`,
    );
    expect(at, out.join("\n")).toBeGreaterThanOrEqual(0);
    expect(out[at + 1]).toBe("  Type /qcr-review, /qcr-scan or /qcr-setup.");
    expect(out[at + 2]).toMatch(/^ {2}To pick it up: .+\.$/);
    if (c.host === "cursor") expect(out[at + 2]).toMatch(/re-index/);
  });

  // MUTATION: delete the destination folder whole in uninstall (rmSync
  // recursive) — the person's file inside it goes and this fails.
  it("uninstall deletes exactly what the install wrote: the home is as it was, the person's own files kept", async () => {
    const before = tree(home);
    expect(await qcr("plugin", "install", "--to", c.host)).toBe(0);
    const { code, rows } = await qcrJson("plugin", "uninstall", "--from", c.host);
    expect(code).toBe(0);
    expect(rows).toEqual([
      expect.objectContaining({ host: c.host, outcome: "removed", scopes: ["user"] }),
    ]);
    expect(tree(home)).toEqual(before);
    expect(existsSync(join(data, "qcr", "plugins", c.host))).toBe(false);
    expect(existsSync(recordOf(c))).toBe(false);

    // a file the person added inside the copy's folders outlives it
    expect(await qcr("plugin", "install", "--to", c.host)).toBe(0);
    writeFileSync(c.inside(), "mine\n");
    expect(await qcr("plugin", "uninstall", "--from", c.host)).toBe(0);
    expect(readFileSync(c.inside(), "utf8")).toBe("mine\n");
    for (const [p] of copied(c)) expect(existsSync(c.target(p)), p).toBe(false);
    rmSync(c.inside());
    for (let d = dirname(c.inside()); d !== home && readdirSync(d).length === 0; d = dirname(d))
      rmSync(d, { recursive: true });
    expect(tree(home)).toEqual(before);

    const again = await qcrJson("plugin", "uninstall", "--from", c.host);
    expect(again.code).toBe(0);
    expect(again.rows[0]!.outcome).toBe("skipped");
    expect(ran()).toEqual([]);
  });

  // MUTATION: drop the check for a path already there in the copy's land —
  // the person's file is written over or adopted and this fails.
  it("install never writes over a path it did not write: a failed row, exit 1, and nothing written", async () => {
    mkdirSync(dirname(c.inTheWay()), { recursive: true });
    writeFileSync(c.inTheWay(), "the person's own\n");
    const before = tree(home);
    const { code, rows } = await qcrJson("plugin", "install", "--to", c.host);
    expect(code).toBe(1);
    expect(rows).toEqual([
      expect.objectContaining({
        host: c.host,
        outcome: "failed",
        detail: expect.stringMatching(
          /is already there and qcr plugin did not write it/,
        ) as unknown,
      }),
    ]);
    expect(tree(home)).toEqual(before);
    expect(existsSync(join(data, "qcr"))).toBe(false);
    // nor does uninstall touch it
    expect(await qcr("plugin", "uninstall", "--from", c.host)).toBe(0);
    expect(tree(home)).toEqual(before);
  });

  // MUTATION: drop the unwrite of the older release's leftovers in the
  // copy's land — the older release's extra skill stays and this fails.
  it("update over an older release rewrites the copy and deletes what only the older one wrote", async () => {
    const pristine = tree(home);
    expect(await qcr("plugin", "install", "--to", c.host)).toBe(0);
    // what an older installer left: its render, its copy with one more
    // skill, and a record of both
    const old = renderDir(c, OLD);
    writeRendered(hostRender(c, OLD), old);
    rmSync(renderDir(c), { recursive: true });
    for (const [p, content] of copied(c, OLD)) writeFileSync(c.target(p), content);
    const legacy = c.target("skills/qcr-legacy/SKILL.md");
    mkdirSync(dirname(legacy));
    writeFileSync(legacy, "an older release's skill\n");
    const record = JSON.parse(readFileSync(recordOf(c), "utf8")) as {
      version: string;
      render: string;
      files: string[];
      dirs: string[];
    };
    writeFileSync(
      recordOf(c),
      JSON.stringify({
        version: OLD,
        render: old,
        files: [...record.files, legacy],
        dirs: [...record.dirs, dirname(legacy)],
      }),
    );

    const { code, rows } = await qcrJson("plugin", "update");
    expect(code).toBe(0);
    expect(rowOf(rows, c.host)).toEqual(
      expect.objectContaining({
        outcome: "updated",
        version: VERSION,
        dir: c.dest(),
        removed: [old],
        detail: expect.stringMatching(new RegExp(`\\(was ${OLD}\\)$`)) as unknown,
      }),
    );
    expectCopyAt(c);
    expect(existsSync(dirname(legacy))).toBe(false);
    expect(existsSync(old)).toBe(false);
    expect(renderedDiff(hostRender(c), renderDir(c))).toEqual([]);

    expect(await qcr("plugin", "uninstall", "--from", c.host)).toBe(0);
    expect(tree(home)).toEqual(pristine);
  });

  it("--project skips it with the reason and writes nothing", async () => {
    const before = tree(home);
    const { code, rows } = await qcrJson("plugin", "install", "--to", c.host, "--project");
    expect(code).toBe(0);
    expect(rows).toEqual([
      expect.objectContaining({
        host: c.host,
        outcome: "skipped",
        detail: expect.stringMatching(/project scope/) as unknown,
      }),
    ]);
    expect(tree(home)).toEqual(before);
    expect(existsSync(join(data, "qcr"))).toBe(false);
  });

  it("a record it cannot read is a failed row, and nothing is deleted", async () => {
    expect(await qcr("plugin", "install", "--to", c.host)).toBe(0);
    const installed = tree(home);
    writeFileSync(recordOf(c), "not json");
    const { code, rows } = await qcrJson("plugin", "uninstall", "--from", c.host);
    expect(code).toBe(1);
    expect(rowOf(rows, c.host)).toEqual(
      expect.objectContaining({
        outcome: "failed",
        detail: expect.stringMatching(/is not a record qcr plugin can read/) as unknown,
      }),
    );
    expect(tree(home)).toEqual(installed);
  });
});

describe("qcr plugin across every host", () => {
  // MUTATION: land the copy in update whether or not a record's copy is
  // there — Cursor is given a copy it never had and this fails.
  it("update with no --to touches only the hosts with a QuickReview install", async () => {
    fake("cursor-agent");
    fake("opencode");
    writeTheirs(byHost("cursor"));
    writeTheirs(byHost("opencode"));
    expect(await qcr("plugin", "install", "--to", "opencode")).toBe(0);
    const cursorBefore = tree(join(home, ".cursor"));
    const opencodeBefore = tree(join(home, ".config"));

    const { code, rows } = await qcrJson("plugin", "update");
    expect(code).toBe(0);
    expect(rowOf(rows, "opencode")).toEqual(
      expect.objectContaining({ outcome: "updated", version: VERSION }),
    );
    expect(rowOf(rows, "cursor")).toEqual(
      expect.objectContaining({ outcome: "skipped", detail: "QuickReview is not installed here" }),
    );
    expect(tree(join(home, ".cursor"))).toEqual(cursorBefore);
    expect(tree(join(home, ".config"))).toEqual(opencodeBefore);
    expect(existsSync(join(data, "qcr", "plugins", "cursor"))).toBe(false);
    expect(existsSync(recordOf(byHost("cursor")))).toBe(false);
    for (const h of ["claude", "codex", "copilot", "gemini", "antigravity"])
      expect(rowOf(rows, h)?.outcome, h).toBe("skipped");
    expect(ran()).toEqual([]);
  });

  // An opencode whose XDG_CONFIG_HOME is moved is a profile of its own: it
  // shares the data home, never the default profile's copy record.
  // MUTATION: drop `profile` from opencodeInstaller — the moved profile's
  // update reads the default's record, deletes the default's copy, and this
  // fails.
  it("an opencode profile with its own XDG_CONFIG_HOME leaves the default profile's copy alone", async () => {
    fake("opencode");
    const c = byHost("opencode");
    expect(await qcr("plugin", "install", "--to", "opencode")).toBe(0);
    const before = tree(join(home, ".config"));
    process.env.XDG_CONFIG_HOME = join(dir, "config-b");

    const updated = await qcrJson("plugin", "update");
    expect(rowOf(updated.rows, "opencode")).toEqual(
      expect.objectContaining({ outcome: "skipped", detail: "QuickReview is not installed here" }),
    );
    const removed = await qcrJson("plugin", "uninstall", "--from", "opencode");
    expect(rowOf(removed.rows, "opencode")?.outcome).toBe("skipped");
    expect(tree(join(home, ".config"))).toEqual(before);
    expect(existsSync(recordOf(c))).toBe(true);
    expect(existsSync(renderDir(c))).toBe(true);
    expect(ran()).toEqual([]);
  });

  // MUTATION: drop the config-directory lookup from the copy host's locate —
  // Cursor, with no executable on PATH, is skipped and this fails.
  it("--to all installs into every host found, Cursor by its config directory alone, and names each one not found", async () => {
    fake("opencode");
    writeTheirs(byHost("cursor"));
    const { code, rows } = await qcrJson("plugin", "install", "--to", "all");
    expect(code).toBe(0);
    expect(rows.map((r) => [r.host, r.outcome, r.outcome === "skipped" ? r.detail : ""])).toEqual([
      ["claude", "skipped", "claude is not on PATH"],
      ["codex", "skipped", "codex is not on PATH"],
      ["copilot", "skipped", "copilot is not on PATH"],
      ["cursor", "installed", ""],
      ["opencode", "installed", ""],
      ["gemini", "skipped", "gemini is not on PATH"],
      ["antigravity", "skipped", "agy is not on PATH"],
    ]);
    expectCopyAt(byHost("cursor"));
    expectCopyAt(byHost("opencode"));

    expect(await qcr("plugin", "install", "--to", "all")).toBe(0);
    const said = out.join("\n");
    expect(said).toMatch(/^Claude Code: skipped: claude is not on PATH$/m);
    expect(said).toMatch(/^Antigravity: skipped: agy is not on PATH$/m);
    expect(said).toMatch(/^Cursor: installed at user scope, release /m);
    expect(said).toMatch(/^opencode: installed at user scope, release /m);
  });

  it("--to all with no host found exits 0, says so, and writes nothing", async () => {
    const { code, rows } = await qcrJson("plugin", "install", "--to", "all");
    expect(code).toBe(0);
    expect(rows.every((r) => r.outcome === "skipped")).toBe(true);
    expect(rowOf(rows, "cursor")?.detail).toBe(
      `neither cursor-agent nor cursor is on PATH, and there is no ${join(home, ".cursor")}`,
    );
    expect(await qcr("plugin", "install", "--to", "all")).toBe(0);
    expect(out).toEqual([
      `qcr plugin install: no coding-agent CLI found (looked for claude, codex, copilot, cursor-agent, cursor, ${join(home, ".cursor")}, opencode, gemini, agy).`,
    ]);
    expect(tree(home)).toEqual({});
    expect(existsSync(join(data, "qcr"))).toBe(false);
  });

  // MUTATION: drop the record lookup for update and uninstall in cmdPlugin —
  // opencode, gone from PATH, is skipped as not found and its copy stays.
  it("--from all removes every copy, one whose host is gone from PATH too", async () => {
    fake("opencode");
    writeTheirs(byHost("cursor"));
    writeTheirs(byHost("opencode"));
    const before = tree(home);
    expect(await qcr("plugin", "install", "--to", "all")).toBe(0);
    renameSync(join(bin, "opencode"), join(dir, "opencode-gone"));
    const { code, rows } = await qcrJson("plugin", "uninstall", "--from", "all");
    expect(code).toBe(0);
    expect(rowOf(rows, "cursor")?.outcome).toBe("removed");
    expect(rowOf(rows, "opencode")?.outcome).toBe("removed");
    expect(tree(home)).toEqual(before);
    expect(readdirSync(join(data, "qcr", "plugins"))).toEqual([]);
  });
});
