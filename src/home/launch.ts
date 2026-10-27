// A bare `qcr`: the home. The app's pinned pi (src/picli.ts), with the plugin
// and the home's extension loaded, on the person's own pi home.
//
//   pi home    the person's own: $PI_CODING_AGENT_DIR as the person set it,
//              else ~/.pi/agent. The launch never sets it, so the chat, the
//              panel's login line (which reads the same dir) and every review
//              use one login.
//   quiet      no logo, resource list, trust prompt, changelog or model
//              warning, and nothing written to the person's global pi
//              settings: the quiet start is project settings in the home's
//              own working directory (in the app's state home), the per-run
//              trust flag `--approve`, and an explicit `--model`. The
//              project settings also carry the pinned pi's version as the
//              last changelog seen, or pi would record it in the global
//              settings on a first run.
//   resume     the sessions live in the state home (`--session-dir`), and
//              `--continue` opens the most recent one there, or a new one.
//   tools      `[home] tools = "reviewer"` (the default) names the allowed
//              tools (src/home/toolnames.ts) and starts no MCP server;
//              "full" leaves pi's own defaults.
//   GitHub     the person's own `gh`. In the image (scripts/qcr-host.sh's
//              home mode) there is no gh config: the wrapper hands the token
//              over as a file (packages/pi-plugin/src/ghcred.ts), and the
//              home passes it to pi as GH_TOKEN, in its environment only.
//
// `-ne` keeps the person's own extensions out: a plugin they installed in pi
// themselves would otherwise register its commands twice.
//
// Everything effectful is injected; `homeRunDeps()` is the real assembly.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "smol-toml";
import { HOME_DEFAULTS, parseHomeSection, type HomeConfig } from "../config.js";
import { pluginPackageDir } from "../coreext.js";
import { locateConfig, stateHome } from "../homes.js";
import { handedToken } from "@quickchatai/pi-quickreview/src/ghcred.js";
import { piCliPath, piPackageDir } from "../picli.js";
import { HOME_MODEL_ENV, HOME_TOOLS_ENV } from "./adapters.js";
import { reviewerToolAllowlist } from "./toolnames.js";

type Env = Readonly<Record<string, string | undefined>>;

/** The home's places in the state home. */
export function homePaths(state: string): { cwd: string; settings: string; sessions: string } {
  const cwd = join(state, "home");
  return {
    cwd,
    settings: join(cwd, ".pi", "settings.json"),
    sessions: join(cwd, "sessions"),
  };
}

/** The env shim pi loads for the home, in the app at `appRoot`. */
export function homeExtensionPath(appRoot: string): string {
  return join(appRoot, "extensions", "cli", "home.ts");
}

/** The home's project settings, over whatever the file already holds. */
export function homeProjectSettings(
  existing: unknown,
  piVersion: string | null,
): Record<string, unknown> {
  const base =
    typeof existing === "object" && existing !== null && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  return {
    ...base,
    quietStartup: true,
    ...(piVersion === null ? {} : { lastChangelogVersion: piVersion }),
  };
}

export interface HomeLaunchInput {
  piCli: string;
  pluginDir: string;
  appRoot: string;
  stateHome: string;
  home: HomeConfig;
  env: Env;
  /** A GitHub token handed over to this process, or null: the person's gh. */
  githubToken?: string | null;
}

export interface HomeLaunch {
  /** pi's CLI entry and its arguments, run by this node. */
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
}

/** What a bare `qcr` runs. */
export function homeLaunch(o: HomeLaunchInput): HomeLaunch {
  const p = homePaths(o.stateHome);
  const tools =
    o.home.tools === "reviewer" ? ["--tools", reviewerToolAllowlist().join(","), "--no-mcp"] : [];
  return {
    args: [
      o.piCli,
      "--approve",
      "--no-extensions",
      "-e",
      o.pluginDir,
      "-e",
      homeExtensionPath(o.appRoot),
      "--model",
      o.home.model,
      ...tools,
      "--session-dir",
      p.sessions,
      "--continue",
    ],
    cwd: p.cwd,
    // PI_CODING_AGENT_DIR passes through as the person set it, or stays unset
    env: {
      ...o.env,
      PI_SKIP_VERSION_CHECK: "1",
      [HOME_MODEL_ENV]: o.home.model,
      [HOME_TOOLS_ENV]: o.home.tools,
      ...(o.githubToken ? { GH_TOKEN: o.githubToken } : {}),
    },
  };
}

export interface HomeRunDeps {
  env: Env;
  appRoot: string;
  stateHome: string;
  piCli(): string;
  pluginDir(): string;
  /** The installed pi's version, or null when it cannot be read. */
  piVersion(): string | null;
  /** The GitHub token handed over to this process, or null. */
  githubToken(): string | null;
  /** The config's `[home]`; a problem with it is said and the defaults used. */
  homeConfig(): { home: HomeConfig; problem?: string };
  readFile(path: string): string;
  writeFile(path: string, text: string): void;
  mkdir(path: string): void;
  /** Run a child with the terminal handed over; its exit code (null: signalled). */
  run(
    cmd: string,
    args: readonly string[],
    opts: { cwd: string; env: Record<string, string | undefined> },
  ): { status: number | null; error?: Error };
  execPath: string;
  err(line: string): void;
}

/** A bare `qcr`: open the home. pi's exit code. */
export function runHome(deps: HomeRunDeps): number {
  let piCli: string;
  let pluginDir: string;
  try {
    piCli = deps.piCli();
    pluginDir = deps.pluginDir();
  } catch (err) {
    deps.err(`qcr: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const { home, problem } = deps.homeConfig();
  if (problem) deps.err(`qcr: ${problem}; the home opens on its defaults.`);
  const p = homePaths(deps.stateHome);
  try {
    deps.mkdir(p.sessions);
    deps.mkdir(dirname(p.settings));
    let existing: unknown = undefined;
    let before: string | null = null;
    try {
      before = deps.readFile(p.settings);
      existing = JSON.parse(before);
    } catch {
      // no settings yet, or not ours to read: written fresh below
    }
    const text = `${JSON.stringify(homeProjectSettings(existing, deps.piVersion()), null, 2)}\n`;
    if (text !== before) deps.writeFile(p.settings, text);
  } catch (err) {
    deps.err(
      `qcr: can't prepare the home in ${p.cwd}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
  const launch = homeLaunch({
    piCli,
    pluginDir,
    appRoot: deps.appRoot,
    stateHome: deps.stateHome,
    home,
    env: deps.env,
    githubToken: deps.githubToken(),
  });
  const r = deps.run(deps.execPath, launch.args, { cwd: launch.cwd, env: launch.env });
  if (r.error) {
    deps.err(`qcr: pi could not start: ${r.error.message}`);
    return 1;
  }
  return r.status ?? 1;
}

/** The config's `[home]`, read on its own: the home opens even when the rest
 * of the config would not load. */
export function readHomeConfig(
  env: Env,
  read: (p: string) => string = (p) => readFileSync(p, "utf8"),
): { home: HomeConfig; problem?: string } {
  const path = locateConfig({ env }).path;
  let raw: string;
  try {
    raw = read(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT")
      return { home: { ...HOME_DEFAULTS } };
    return { home: { ...HOME_DEFAULTS }, problem: `can't read ${path}` };
  }
  try {
    return { home: parseHomeSection((parse(raw) as Record<string, unknown>)["home"]) };
  } catch (err) {
    return {
      home: { ...HOME_DEFAULTS },
      problem: `${path}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function homeRunDeps(appRoot: string, env: Env = process.env): HomeRunDeps {
  return {
    env,
    appRoot,
    stateHome: stateHome(env),
    piCli: () => piCliPath(),
    pluginDir: () => pluginPackageDir(),
    piVersion: () => {
      try {
        const pkg = JSON.parse(readFileSync(join(piPackageDir(), "package.json"), "utf8")) as {
          version?: unknown;
        };
        return typeof pkg.version === "string" ? pkg.version : null;
      } catch {
        return null;
      }
    },
    githubToken: handedToken,
    homeConfig: () => readHomeConfig(env),
    readFile: (p) => readFileSync(p, "utf8"),
    writeFile: (p, t) => writeFileSync(p, t),
    mkdir: (p) => mkdirSync(p, { recursive: true }),
    run: (cmd, args, opts) => {
      const r = spawnSync(cmd, [...args], { stdio: "inherit", cwd: opts.cwd, env: opts.env });
      return { status: r.status, ...(r.error ? { error: r.error } : {}) };
    },
    execPath: process.execPath,
    err: (l) => console.error(l),
  };
}
