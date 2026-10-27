// A bare `qcr` opens the home (src/home/launch.ts): what it runs, where, with
// which settings, and what it never touches. Every effect is a fake: nothing
// here starts pi or writes outside a map of paths.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HOME_DEFAULTS, parseConfig, parseHomeSection } from "../src/config.js";
import {
  homeLaunch,
  homePaths,
  homeProjectSettings,
  readHomeConfig,
  runHome,
  type HomeRunDeps,
} from "../src/home/launch.js";
import { HOME_TOOL_NAMES } from "../src/home/toolnames.js";

const ROOT = resolve(import.meta.dirname, "..");
const STATE = "/state/qcr/default";
const APP = "/app";
const PI = "/app/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";
const PLUGIN = "/app/node_modules/@quickchatai/pi-quickreview";

interface Ran {
  cmd: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string | undefined>;
}

function fakeDeps(o: {
  env?: Record<string, string | undefined>;
  files?: Record<string, string>;
  home?: ReturnType<HomeRunDeps["homeConfig"]>;
  piCli?: () => string;
  githubToken?: string | null;
}): { deps: HomeRunDeps; ran: Ran[]; files: Map<string, string>; writes: string[]; err: string[] } {
  const files = new Map(Object.entries(o.files ?? {}));
  const ran: Ran[] = [];
  const writes: string[] = [];
  const err: string[] = [];
  const deps: HomeRunDeps = {
    env: o.env ?? { HOME: "/home/person", PATH: "/usr/bin" },
    appRoot: APP,
    stateHome: STATE,
    piCli: o.piCli ?? (() => PI),
    pluginDir: () => PLUGIN,
    piVersion: () => "1.4.0",
    githubToken: () => o.githubToken ?? null,
    homeConfig: () => o.home ?? { home: { ...HOME_DEFAULTS } },
    readFile: (p) => {
      const t = files.get(p);
      if (t === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
      return t;
    },
    writeFile: (p, t) => {
      writes.push(p);
      files.set(p, t);
    },
    mkdir: () => {},
    run: (cmd, args, opts) => {
      ran.push({ cmd, args, cwd: opts.cwd, env: opts.env });
      return { status: 0 };
    },
    execPath: "/usr/bin/node",
    err: (l) => err.push(l),
  };
  return { deps, ran, files, writes, err };
}

const flag = (args: readonly string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};

describe("the home's launch", () => {
  const launch = (home = { ...HOME_DEFAULTS }, env: Record<string, string | undefined> = {}) =>
    homeLaunch({ piCli: PI, pluginDir: PLUGIN, appRoot: APP, stateHome: STATE, home, env });

  it("runs the pinned pi with the plugin and the home's extension, and nothing else", () => {
    const l = launch();
    expect(l.args[0]).toBe(PI);
    expect(l.args).toContain("--no-extensions");
    const loaded = l.args.flatMap((a, i) => (a === "-e" ? [l.args[i + 1]] : []));
    expect(loaded).toEqual([PLUGIN, join(APP, "extensions", "cli", "home.ts")]);
  });

  // MUTATION: drop --approve or --model — the start is no longer quiet.
  it("starts quietly: the per-run trust flag and an explicit model", () => {
    const l = launch();
    expect(l.args).toContain("--approve");
    expect(flag(l.args, "--model")).toBe("openai-codex/gpt-6.1-sol");
    expect(l.env["PI_SKIP_VERSION_CHECK"]).toBe("1");
    expect(flag(launch({ model: "anthropic/claude-x", tools: "reviewer" }).args, "--model")).toBe(
      "anthropic/claude-x",
    );
  });

  // MUTATION: drop --continue — a relaunch starts a new session.
  it("resumes the last home session: one session dir in the state home, and --continue", () => {
    const a = launch();
    const b = launch();
    expect(flag(a.args, "--session-dir")).toBe(join(STATE, "home", "sessions"));
    expect(a.args).toContain("--continue");
    expect(a.cwd).toBe(join(STATE, "home"));
    expect(b).toEqual(a);
  });

  // MUTATION: set PI_CODING_AGENT_DIR to a scratch dir — this fails.
  it("runs on the person's own pi home: the agent dir passes through as set, or stays unset", () => {
    expect("PI_CODING_AGENT_DIR" in launch().env).toBe(false);
    expect(launch(undefined, { PI_CODING_AGENT_DIR: "/srv/pi" }).env["PI_CODING_AGENT_DIR"]).toBe(
      "/srv/pi",
    );
  });

  // MUTATION: drop the GH_TOKEN spread in homeLaunch — the image's home has no gh.
  it("passes a handed-over GitHub token to pi as GH_TOKEN, and none otherwise", () => {
    const l = homeLaunch({
      piCli: PI,
      pluginDir: PLUGIN,
      appRoot: APP,
      stateHome: STATE,
      home: { ...HOME_DEFAULTS },
      env: {},
      githubToken: "ghs_handed",
    });
    expect(l.env["GH_TOKEN"]).toBe("ghs_handed");
    expect(l.args.join(" ")).not.toContain("ghs_handed");
    expect("GH_TOKEN" in launch().env).toBe(false);
    const f = fakeDeps({ githubToken: "ghs_handed" });
    runHome(f.deps);
    expect(f.ran[0]!.env["GH_TOKEN"]).toBe("ghs_handed");
  });

  it("is reviewer-only by default: read tools, the plugin's and the home's, no MCP", () => {
    const l = launch();
    const tools = flag(l.args, "--tools")!.split(",");
    expect(tools).toEqual(["read", "grep", "find", "ls", "qcr_*", ...HOME_TOOL_NAMES]);
    for (const t of ["bash", "edit", "write"]) expect(tools).not.toContain(t);
    expect(l.args).toContain("--no-mcp");
    expect(l.env["QCR_HOME_TOOLS"]).toBe("reviewer");
    expect(l.env["QCR_HOME_MODEL"]).toBe("openai-codex/gpt-6.1-sol");
  });

  it('[home] tools = "full" gives every pi tool', () => {
    const l = launch({ ...HOME_DEFAULTS, tools: "full" });
    expect(l.args).not.toContain("--tools");
    expect(l.args).not.toContain("--no-mcp");
    expect(l.env["QCR_HOME_TOOLS"]).toBe("full");
  });
});

describe("the quiet start's settings", () => {
  it("are project settings in the home's working directory, merged over what is there", () => {
    expect(homePaths(STATE).settings).toBe(join(STATE, "home", ".pi", "settings.json"));
    expect(homeProjectSettings({ theme: "dark", quietStartup: false }, "1.4.0")).toEqual({
      theme: "dark",
      quietStartup: true,
      lastChangelogVersion: "1.4.0",
    });
    expect(homeProjectSettings("not an object", null)).toEqual({ quietStartup: true });
  });

  // MUTATION: write the quiet start to the agent dir's settings.json — this fails.
  it("writes nothing but its own project settings, and nothing in the person's pi home", () => {
    const f = fakeDeps({
      env: { HOME: "/home/person", PI_CODING_AGENT_DIR: "/home/person/.pi/agent" },
    });
    expect(runHome(f.deps)).toBe(0);
    expect(f.writes).toEqual([join(STATE, "home", ".pi", "settings.json")]);
    expect(JSON.parse(f.files.get(f.writes[0]!)!)).toEqual({
      quietStartup: true,
      lastChangelogVersion: "1.4.0",
    });
    for (const w of f.writes) expect(w.startsWith(STATE)).toBe(true);
  });

  it("leaves the file alone when it already says so", () => {
    const settings = join(STATE, "home", ".pi", "settings.json");
    const f = fakeDeps({});
    runHome(f.deps);
    const again = fakeDeps({ files: { [settings]: f.files.get(settings)! } });
    runHome(again.deps);
    expect(again.writes).toEqual([]);
  });

  it("runs pi in the home's working directory with the launch's argv", () => {
    const f = fakeDeps({});
    runHome(f.deps);
    expect(f.ran).toHaveLength(1);
    expect(f.ran[0]!.cmd).toBe("/usr/bin/node");
    expect(f.ran[0]!.args[0]).toBe(PI);
    expect(f.ran[0]!.cwd).toBe(join(STATE, "home"));
  });

  it("says why and starts nothing when pi is not installed", () => {
    const f = fakeDeps({
      piCli: () => {
        throw new Error("pi SDK package not found");
      },
    });
    expect(runHome(f.deps)).toBe(1);
    expect(f.err.join("\n")).toMatch(/qcr: pi SDK package not found/);
    expect(f.ran).toEqual([]);
  });

  it("opens on the defaults, and says so, when [home] is wrong", () => {
    const f = fakeDeps({
      home: { home: { ...HOME_DEFAULTS }, problem: "config.toml [home]: tools …" },
    });
    expect(runHome(f.deps)).toBe(0);
    expect(f.err.join("\n")).toMatch(/the home opens on its defaults/);
  });
});

describe("[home] in the config", () => {
  const read = (files: Record<string, string>) => (p: string) => {
    const t = files[p];
    if (t === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return t;
  };
  const env = { QCR_CONFIG: "/cfg/config.toml" };

  it("defaults every key", () => {
    expect(parseHomeSection(undefined)).toEqual({
      model: "openai-codex/gpt-6.1-sol",
      tools: "reviewer",
    });
    expect(readHomeConfig(env, read({}))).toEqual({ home: HOME_DEFAULTS });
  });

  it("reads model and tools, and refuses a value of the wrong kind", () => {
    expect(
      readHomeConfig(
        env,
        read({ "/cfg/config.toml": '[home]\nmodel = "anthropic/claude-x"\ntools = "full"\n' }),
      ),
    ).toEqual({ home: { model: "anthropic/claude-x", tools: "full" } });
    expect(() => parseHomeSection({ tools: "all" })).toThrow(/tools must be "reviewer" or "full"/);
    expect(() => parseHomeSection({ model: "gpt" })).toThrow(/model must be "provider\/id"/);
    const bad = readHomeConfig(env, read({ "/cfg/config.toml": '[home]\ntools = "all"\n' }));
    expect(bad.home).toEqual(HOME_DEFAULTS);
    expect(bad.problem).toMatch(/tools must be/);
  });

  it("reads [home] alone: a config the daemon would refuse still opens the home", () => {
    expect(
      readHomeConfig(env, read({ "/cfg/config.toml": '[home]\ntools = "full"\n[caps]\n' })),
    ).toEqual({
      home: { model: HOME_DEFAULTS.model, tools: "full" },
    });
  });

  it("the shipped example sets the defaults, and the full config parses them", () => {
    const example = readFileSync(join(ROOT, "config.example.toml"), "utf8");
    expect(parseConfig(example).home).toEqual(HOME_DEFAULTS);
  });
});
