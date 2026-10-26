// The `qcr` bin's front door and the verbs an npm install adds: where each
// argv goes (src/qcrbin.ts; the home's own launch is tests/home-launch.test.ts), `qcr pi`, `qcr login` and `qcr update`
// (src/npmverbs.ts), and the SQLite hint (src/sqlitehint.ts). Every child is
// a fake: nothing here starts pi, tmux or a package manager.
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { binRoute } from "../src/qcrbin.js";
import {
  APP_PI_EXTENSIONS,
  cmdLogin,
  cmdPi,
  cmdUpdate,
  detectInstall,
  pluginPackageDir,
  updateCommand,
  type NpmVerbDeps,
} from "../src/npmverbs.js";
import { isSqliteUnavailable, sqliteHint } from "../src/sqlitehint.js";

const ROOT = resolve(import.meta.dirname, "..");
mkdirSync(join(ROOT, "node_modules", ".cache"), { recursive: true });
const tmp = mkdtempSync(join(ROOT, "node_modules", ".cache", "qcr-bin-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

interface Ran {
  cmd: string;
  args: readonly string[];
  env?: NodeJS.ProcessEnv;
}

function fakeDeps(o: {
  env?: Record<string, string | undefined>;
  pkgRoot?: string;
  interactive?: boolean;
  onRun?: (r: Ran) => number | null;
}): { deps: NpmVerbDeps; ran: Ran[]; out: string[]; err: string[] } {
  const ran: Ran[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const deps: NpmVerbDeps = {
    env: o.env ?? { PATH: join(tmp, "empty-path"), HOME: join(tmp, "home") },
    pkgRoot: o.pkgRoot ?? "/usr/lib/node_modules/@quickchatai/quickreview",
    piCli: () => "/pkg/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
    pluginDir: () => "/pkg/node_modules/@quickchatai/pi-quickreview",
    run: (cmd, args, opts) => {
      const r: Ran = { cmd, args, ...(opts.env ? { env: opts.env } : {}) };
      ran.push(r);
      return { status: o.onRun ? o.onRun(r) : 0 };
    },
    interactive: o.interactive ?? true,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    execPath: "/usr/bin/node",
  };
  return { deps, ran, out, err };
}

describe("the bin's routes", () => {
  // MUTATION: route the empty argv to the TUI again — this fails.
  it("a bare qcr opens the home, and qcr home does too", () => {
    expect(binRoute([])).toEqual({ route: "home" });
    expect(binRoute(["home"])).toEqual({ route: "home" });
  });

  it("qcr tui still opens the admin TUI, through the app's main", () => {
    expect(binRoute(["tui"])).toEqual({ route: "app", argv: ["tui"] });
    expect(binRoute(["tui", "12"])).toEqual({ route: "app", argv: ["tui", "12"] });
  });

  it("the npm verbs are its own, with --json taken off", () => {
    expect(binRoute(["version", "--json"])).toEqual({ route: "version", args: [], json: true });
    expect(binRoute(["--json", "review", "--preview"])).toEqual({
      route: "review",
      args: ["--preview"],
      json: true,
    });
    expect(binRoute(["login", "anthropic"])).toEqual({
      route: "login",
      args: ["anthropic"],
      json: false,
    });
    expect(binRoute(["update"])).toEqual({ route: "update", args: [], json: false });
  });

  // MUTATION: strip --json before the pi route — pi loses its own flag.
  it("qcr pi passes every argument to pi, --json included", () => {
    expect(binRoute(["pi", "--mode", "json", "--json"])).toEqual({
      route: "pi",
      args: ["--mode", "json", "--json"],
    });
  });

  it("every other verb goes to the app's main as it came", () => {
    expect(binRoute(["status"])).toEqual({ route: "app", argv: ["status"] });
    expect(binRoute(["why", "7", "--json"])).toEqual({
      route: "app",
      argv: ["why", "7", "--json"],
    });
    expect(binRoute(["message", "7", "--json", "words"])).toEqual({
      route: "app",
      argv: ["message", "7", "--json", "words"],
    });
    expect(binRoute(["--help"])).toEqual({ route: "help" });
  });
});

describe("qcr pi", () => {
  // The plugin carries /qcr-review, /qcr-scan and /qcr-setup; /selfimprove
  // is the app's, loaded beside it (ADR 0001). MUTATION: drop either -e — pi
  // starts without the plugin, or without /selfimprove, and this fails.
  it("runs the pinned pi with the plugin and the app's /selfimprove preloaded, and the args passed on", () => {
    const f = fakeDeps({ onRun: () => 3 });
    expect(cmdPi(["--model", "x/y", "hello"], f.deps)).toBe(3);
    expect(f.ran).toEqual([
      {
        cmd: "/usr/bin/node",
        args: [
          "/pkg/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
          "-e",
          "/pkg/node_modules/@quickchatai/pi-quickreview",
          "-e",
          "/usr/lib/node_modules/@quickchatai/quickreview/extensions/cli/selfimprove.ts",
          "--model",
          "x/y",
          "hello",
        ],
      },
    ]);
  });

  // The path is under the package root an npm install ships (`files` holds
  // extensions/). MUTATION: name a shim that does not exist — this fails.
  it("names app extensions that exist in the package", () => {
    expect(APP_PI_EXTENSIONS.length).toBeGreaterThan(0);
    for (const e of APP_PI_EXTENSIONS) expect(existsSync(join(ROOT, e)), e).toBe(true);
  });

  it("says so when pi is not installed", () => {
    const f = fakeDeps({});
    f.deps.piCli = () => {
      throw new Error("pi SDK package not found");
    };
    expect(cmdPi([], f.deps)).toBe(1);
    expect(f.err.join("\n")).toMatch(/qcr pi: pi SDK package not found/);
    expect(f.ran).toEqual([]);
  });

  it("finds the plugin package this CLI depends on", () => {
    expect(realpathSync(pluginPackageDir())).toBe(
      realpathSync(join(ROOT, "packages", "pi-plugin")),
    );
  });
});

describe("qcr login", () => {
  it("is interactive: with no terminal it starts nothing", async () => {
    const f = fakeDeps({ interactive: false });
    expect(await cmdLogin([], f.deps)).toBe(1);
    expect(f.err.join("\n")).toMatch(/interactive/);
    expect(f.ran).toEqual([]);
  });

  it("refuses a provider that is not a plain name", async () => {
    const f = fakeDeps({});
    expect(await cmdLogin(["x'; rm -rf /"], f.deps)).toBe(2);
    expect(f.ran).toEqual([]);
  });

  // Without tmux, pi opens in the terminal and the person types /login; the
  // login lands in pi's agent dir, which the verb then reads.
  it("opens the pinned pi into the user's agent dir and reports the login", async () => {
    const home = join(tmp, "login-home");
    const agentDir = join(home, ".pi", "agent");
    const f = fakeDeps({
      env: { PATH: join(tmp, "no-tmux"), HOME: home },
      onRun: () => {
        mkdirSync(agentDir, { recursive: true });
        writeFileSync(
          join(agentDir, "auth.json"),
          JSON.stringify({ "openai-codex": { type: "oauth", expires: 1, access: "SECRET" } }),
        );
        return 0;
      },
    });
    expect(await cmdLogin([], f.deps)).toBe(0);
    // MUTATION: drop "--no-approve" from cmdLogin's no-tmux run — this fails.
    expect(f.ran).toEqual([{ cmd: "/usr/bin/node", args: [f.deps.piCli(), "--no-approve"] }]);
    const said = f.out.join("\n");
    expect(said).toMatch(/type \/login/);
    expect(said).toMatch(/logged in to openai-codex/);
    expect(said).not.toContain("SECRET");
  });

  it("fails when pi was quit without a login", async () => {
    const f = fakeDeps({ env: { PATH: join(tmp, "no-tmux"), HOME: join(tmp, "nologin-home") } });
    expect(await cmdLogin([], f.deps)).toBe(1);
    expect(f.err.join("\n")).toMatch(/no login/);
  });

  it("with tmux on the PATH, types /login for the person outside any tmux it runs in", async () => {
    const bin = join(tmp, "tmux-path");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "tmux"), "");
    const home = join(tmp, "tmux-home");
    const agentDir = join(home, ".pi", "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "oauth" } }));
    const f = fakeDeps({ env: { PATH: bin, HOME: home, TMUX: "/tmp/tmux-1/default,1,0" } });
    expect(await cmdLogin(["anthropic"], f.deps)).toBe(0);
    expect(f.ran).toHaveLength(1);
    expect(f.ran[0]!.cmd).toBe("sh");
    expect(f.ran[0]!.args[1]).toContain("@earendil-works/pi-coding-agent/dist/bundle/cli.js");
    expect(f.ran[0]!.args[1]).toMatch(/\/login anthropic/);
    expect(f.ran[0]!.env?.["TMUX"]).toBeUndefined();
  });
});

describe("qcr update", () => {
  const env = {};
  it("knows the package manager from where qcr is installed", () => {
    expect(detectInstall("/usr/lib/node_modules/@quickchatai/quickreview", env)).toEqual({
      kind: "global",
      installer: "npm",
      root: "/usr/lib/node_modules/@quickchatai/quickreview",
    });
    expect(
      detectInstall(
        "/home/u/.local/share/pnpm/global/5/node_modules/@quickchatai/quickreview",
        env,
      ),
    ).toMatchObject({ kind: "global", installer: "pnpm" });
    expect(
      detectInstall("/home/u/.bun/install/global/node_modules/@quickchatai/quickreview", env),
    ).toMatchObject({ kind: "global", installer: "bun" });
    expect(detectInstall("/work/app/node_modules/@quickchatai/quickreview", env)).toMatchObject({
      kind: "local",
      installer: "npm",
    });
    expect(
      detectInstall("/work/app/node_modules/@quickchatai/quickreview", {
        npm_config_user_agent: "pnpm/9.0.0 npm/? node/v22.0.0 linux x64",
      }),
    ).toMatchObject({ kind: "local", installer: "pnpm" });
  });

  it("a checkout and the release image are their own kinds", () => {
    expect(detectInstall("/home/u/src/quickreview", env)).toEqual({
      kind: "checkout",
      root: "/home/u/src/quickreview",
    });
    expect(detectInstall("/opt/qcr", env)).toEqual({ kind: "image" });
    expect(
      detectInstall("/usr/lib/node_modules/@quickchatai/quickreview", {
        QCR_IMAGE_TOOL_UID: "65534",
      }),
    ).toEqual({ kind: "image" });
  });

  it("each manager's global update of the CLI", () => {
    expect(updateCommand("npm")).toEqual([
      "npm",
      "install",
      "-g",
      "@quickchatai/quickreview@latest",
    ]);
    expect(updateCommand("pnpm")).toEqual(["pnpm", "add", "-g", "@quickchatai/quickreview@latest"]);
    expect(updateCommand("bun")).toEqual(["bun", "add", "-g", "@quickchatai/quickreview@latest"]);
  });

  // MUTATION: run npm for a bun install — the bun-installed qcr never moves.
  it("runs the installing manager's update for a global install", () => {
    const f = fakeDeps({
      pkgRoot: "/home/u/.bun/install/global/node_modules/@quickchatai/quickreview",
    });
    expect(cmdUpdate([], f.deps)).toBe(0);
    expect(f.ran).toEqual([{ cmd: "bun", args: ["add", "-g", "@quickchatai/quickreview@latest"] }]);
  });

  it("runs nothing for a checkout or a project's own dependency, and says how", () => {
    const co = fakeDeps({ pkgRoot: "/home/u/src/quickreview" });
    expect(cmdUpdate([], co.deps)).toBe(1);
    expect(co.err.join("\n")).toMatch(/git pull/);
    const local = fakeDeps({ pkgRoot: "/work/app/node_modules/@quickchatai/quickreview" });
    expect(cmdUpdate([], local.deps)).toBe(1);
    expect(local.err.join("\n")).toMatch(/dependency of a project/);
    expect([...co.ran, ...local.ran]).toEqual([]);
  });
});

describe("the SQLite hint", () => {
  it("recognises the driver failing to load, and nothing else", () => {
    expect(isSqliteUnavailable(new Error("Could not locate the bindings file. Tried: …"))).toBe(
      true,
    );
    expect(
      isSqliteUnavailable(
        Object.assign(new Error("Cannot find package 'better-sqlite3' imported from /x/state.js"), {
          code: "ERR_MODULE_NOT_FOUND",
        }),
      ),
    ).toBe(true);
    expect(isSqliteUnavailable(new Error("no config at /x/config.toml"))).toBe(false);
  });

  it("names the verbs that still work", () => {
    const h = sqliteHint("status", new Error("Could not locate the bindings file"));
    expect(h).toMatch(/^qcr status: this needs the state database/);
    expect(h).toMatch(/qcr review/);
    expect(h).toMatch(/qcr login/);
  });
});
