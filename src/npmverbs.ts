// The verbs an npm install of qcr adds beside the app's: `qcr login`,
// `qcr pi` and `qcr update`. Each runs the pinned pi or a package manager and
// nothing else: no state, no SQLite, no config beyond the homes.
//
//   qcr login [provider]  pi's own /login, in the pinned pi (src/picli.ts),
//                         into the user's pi agent dir. pi's UI is the flow:
//                         qcr types /login for the person and steps aside.
//   qcr pi [args]         the pinned pi with the qcr plugin preloaded
//                         (`-e <the plugin package's dir>`) and the app's
//                         own /selfimprove beside it (`-e` its shim,
//                         `APP_PI_EXTENSIONS`), args passed on.
//   qcr update            the package manager that installed qcr (npm, pnpm or
//                         bun) updates it globally. The release image keeps its
//                         own route (a release), and a checkout its git.
//
// Everything effectful is injected, so tests drive each verb with fakes;
// `npmVerbDeps()` is the real assembly.
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { pluginPackageDir } from "./coreext.js";
import { detectInstall, type Installer } from "./installkind.js";
import { readLogins } from "./loginhint.js";
import { piCliPath } from "./picli.js";

/** The npm package this CLI is published as. */
export const CLI_PACKAGE = "@quickchatai/quickreview";
// The plugin package and where it is installed live in a leaf of their own, so
// the session manager can find the core's extension files without these verbs.
export { PLUGIN_PACKAGE, pluginPackageDir } from "./coreext.js";
// How this qcr was installed lives in a leaf of its own, so the daemon can ask
// it (src/runhost.ts) without reaching the login verbs below.
export { IMAGE_APP_ROOT, detectInstall, type InstallKind, type Installer } from "./installkind.js";
/** The command that updates the CLI globally with `installer`. The plugin is
 * a dependency at the CLI's exact version, so it moves with it. */
export function updateCommand(installer: Installer, pkg: string = CLI_PACKAGE): string[] {
  const spec = `${pkg}@latest`;
  switch (installer) {
    case "npm":
      return ["npm", "install", "-g", spec];
    case "pnpm":
      return ["pnpm", "add", "-g", spec];
    case "bun":
      return ["bun", "add", "-g", spec];
  }
}

/** pi's agent dir: `$PI_CODING_AGENT_DIR`, else `~/.pi/agent`, as pi reads it. */
export function piAgentDir(env: Readonly<Record<string, string | undefined>>): string {
  const set = (env["PI_CODING_AGENT_DIR"] ?? "").trim();
  if (set !== "") return set;
  return join((env["HOME"] ?? "").trim() || homedir(), ".pi", "agent");
}

/** The providers pi holds a credential for in `agentDir`, from its auth.json;
 * empty when there is none or it cannot be read. Never a token. */
export function loggedInProviders(agentDir: string): string[] {
  return Object.keys(readLogins(agentDir));
}

/** Is `cmd` an executable on `path`? */
export function onPath(cmd: string, path: string | undefined): boolean {
  for (const dir of (path ?? "").split(delimiter)) {
    if (dir === "") continue;
    if (existsSync(join(dir, cmd))) return true;
  }
  return false;
}

export interface NpmVerbDeps {
  env: Readonly<Record<string, string | undefined>>;
  /** The CLI package's root (src/config.ts `sandboxRoot`). */
  pkgRoot: string;
  /** The pinned pi's CLI entry (src/picli.ts `piCliPath`). */
  piCli: () => string;
  /** The plugin package's directory (`pluginPackageDir`). */
  pluginDir: () => string;
  /** Run a child with the terminal handed over; its exit code (null: signalled). */
  run: (
    cmd: string,
    args: readonly string[],
    opts: { env?: NodeJS.ProcessEnv },
  ) => { status: number | null; error?: Error };
  /** Is this an interactive terminal (stdin and stdout)? */
  interactive: boolean;
  out: (line: string) => void;
  err: (line: string) => void;
  /** `node`: the pinned pi's entry is a script, run by this node. */
  execPath: string;
}

export function npmVerbDeps(pkgRoot: string): NpmVerbDeps {
  return {
    env: process.env,
    pkgRoot,
    piCli: () => piCliPath(),
    pluginDir: () => pluginPackageDir(),
    run: (cmd, args, opts) => {
      const o: SpawnSyncOptions = { stdio: "inherit", ...(opts.env ? { env: opts.env } : {}) };
      const r = spawnSync(cmd, [...args], o);
      return { status: r.status, ...(r.error ? { error: r.error } : {}) };
    },
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    out: (l) => console.log(l),
    err: (l) => console.error(l),
    execPath: process.execPath,
  };
}

/** The app's own extensions `qcr pi` loads beside the plugin, as paths under
 * the CLI package's root: the commands that are the app's, not the plugin's
 * (ADR 0001). */
export const APP_PI_EXTENSIONS: readonly string[] = ["extensions/cli/selfimprove.ts"];

/** `qcr pi [args]`: the pinned pi with the plugin and the app's own
 * extensions preloaded; pi's exit code. */
export function cmdPi(args: readonly string[], deps: NpmVerbDeps): number {
  let pi: string;
  let plugin: string;
  try {
    pi = deps.piCli();
    plugin = deps.pluginDir();
  } catch (err) {
    deps.err(`qcr pi: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const app = APP_PI_EXTENSIONS.flatMap((e) => ["-e", join(deps.pkgRoot, e)]);
  const r = deps.run(deps.execPath, [pi, "-e", plugin, ...app, ...args], {});
  if (r.error) {
    deps.err(`qcr pi: pi could not start: ${r.error.message}`);
    return 1;
  }
  return r.status ?? 1;
}

export const LOGIN_USAGE = "usage: qcr login [provider]";

/** `qcr login [provider]`: pi's own /login in the pinned pi. With tmux, qcr
 * starts pi in a tmux session and types /login for the person (the companion's
 * `qcr scan login` route, src/pilogin.ts `loginInPi`); without it, pi opens
 * and the person types /login. Either way the login lands in pi's agent dir,
 * where every review reads it. */
export async function cmdLogin(args: readonly string[], deps: NpmVerbDeps): Promise<number> {
  if (args.length > 1 || args.some((a) => a.startsWith("-") && a !== "--help" && a !== "-h")) {
    deps.err(LOGIN_USAGE);
    return 2;
  }
  if (args[0] === "--help" || args[0] === "-h") {
    deps.out(
      [
        LOGIN_USAGE,
        "",
        "Opens pi's own /login in the pi qcr runs on, so the review sessions can use it.",
        "The login is kept in pi's agent dir ($PI_CODING_AGENT_DIR, default ~/.pi/agent).",
        'Any OpenAI login serves the default review models: "OpenAI Codex (legacy)" or "OpenAI"',
        '(Sign in with ChatGPT) under "Sign in with an account", or an OpenAI API key (at /login, or',
        "OPENAI_API_KEY in the environment). A key for another provider does not stand in for it:",
        "log in, or set the review's models in your qcr config.",
      ].join("\n"),
    );
    return 0;
  }
  const provider = args[0];
  if (provider !== undefined && !/^[A-Za-z0-9._-]+$/.test(provider)) {
    deps.err(`qcr login: ${JSON.stringify(provider)} is not a provider name`);
    return 2;
  }
  if (!deps.interactive) {
    deps.err("qcr login is interactive: run it in a terminal");
    return 1;
  }
  let pi: string;
  try {
    pi = deps.piCli();
  } catch (err) {
    deps.err(`qcr login: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const agentDir = piAgentDir(deps.env);
  const before = loggedInProviders(agentDir);
  let status: number | null;
  if (onPath("tmux", deps.env["PATH"])) {
    const { loginInPi } = await import("./pilogin.js");
    let argv: string[];
    try {
      argv = loginInPi(provider, pi);
    } catch (err) {
      deps.err(
        err instanceof Error ? err.message.replace(/^scan login/, "qcr login") : String(err),
      );
      return 1;
    }
    deps.out(`qcr login: opening pi with /login (pi's agent dir ${agentDir}); quit pi when done.`);
    // Inside tmux already: the login session is a session of its own, not nested.
    const env: NodeJS.ProcessEnv = { ...deps.env };
    delete env["TMUX"];
    const r = deps.run(argv[0]!, argv.slice(1), { env });
    if (r.error) {
      deps.err(`qcr login: tmux could not start: ${r.error.message}`);
      return 1;
    }
    status = r.status;
  } else {
    deps.out(
      `qcr login: opening pi — type /login${provider ? ` ${provider}` : ""} and pick your provider, then quit pi (the login lands in ${agentDir}).`,
    );
    // --no-approve as on the tmux route (src/pilogin.ts): a login needs
    // nothing from this folder, so pi neither asks to trust it nor trusts it.
    const r = deps.run(deps.execPath, [pi, "--no-approve"], {});
    if (r.error) {
      deps.err(`qcr login: pi could not start: ${r.error.message}`);
      return 1;
    }
    status = r.status;
  }
  const after = loggedInProviders(agentDir);
  const added = after.filter((p) => !before.includes(p));
  if (after.length === 0) {
    deps.err(`qcr login: pi holds no login in ${agentDir} yet; run qcr login again to log in.`);
    return 1;
  }
  deps.out(
    added.length > 0
      ? `qcr login: logged in to ${added.join(", ")} (pi's agent dir ${agentDir}).`
      : `qcr login: pi holds logins for ${after.join(", ")} (pi's agent dir ${agentDir}).`,
  );
  return status === 0 || status === null ? 0 : status;
}

/** `qcr update`: the package manager that installed qcr updates it. A local
 * (project) install, a checkout and the release image each say how they
 * update instead; nothing runs. */
export function cmdUpdate(args: readonly string[], deps: NpmVerbDeps): number {
  if (args.length > 0) {
    deps.err("usage: qcr update");
    return 2;
  }
  let root = deps.pkgRoot;
  try {
    root = realpathSync(root);
  } catch {
    // an unresolvable root is judged as given
  }
  const install = detectInstall(root, deps.env);
  switch (install.kind) {
    case "image":
      deps.err(
        "qcr update: this is the release image, which updates as a release, never in place.",
      );
      return 1;
    case "checkout":
      deps.err(
        `qcr update: this qcr runs from a checkout (${install.root}): update it with git pull, then npm run build.`,
      );
      return 1;
    case "local":
      deps.err(
        `qcr update: this qcr is a dependency of a project (${install.root}): update it there, with ${install.installer} (${updateCommand(install.installer).join(" ").replace(" -g", "")}).`,
      );
      return 1;
    case "global": {
      const argv = updateCommand(install.installer);
      deps.out(`qcr update: ${argv.join(" ")}`);
      const r = deps.run(argv[0]!, argv.slice(1), {});
      if (r.error) {
        deps.err(`qcr update: ${install.installer} could not start: ${r.error.message}`);
        return 1;
      }
      if (r.status === 0)
        deps.out(
          "qcr update: done. The pi plugin inside pi updates with pi (`pi update`), if you installed it there.",
        );
      return r.status ?? 1;
    }
  }
}
