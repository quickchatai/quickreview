// piInvocation (src/setup/caserunner.ts) — how the case runner starts pi.
// `process.argv[1]` exists under any node host (a driver script, vitest, the
// TUI), so reusing it blindly would spawn the host script instead of pi.
// argv[1] is reused only when it is verifiably pi's own CLI entry — a `bin` of
// the pi package — and everything else resolves to `pi` on the PATH.
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMPANION_AGENTS_DIR } from "../extensions/setup.js";
import {
  isPiCliEntry,
  leafEnv,
  piCaseRunner,
  piInvocation,
  type SpawnFn,
} from "../src/setup/caserunner.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-caseinv-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A scratch install of a package `name` with a `bin` entry at dist/cli.js. */
function fakePackage(name: string, bin: unknown = { pi: "dist/cli.js" }): string {
  const root = join(dir, "node_modules", ...name.split("/"));
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name, bin }));
  writeFileSync(join(root, "dist", "cli.js"), "#!/usr/bin/env node\n");
  writeFileSync(join(root, "dist", "other.js"), "");
  return root;
}

const NODE = "/usr/bin/node";

describe("piInvocation — resolves pi, never the host script", () => {
  it("this very host (vitest, a non-pi node process whose argv[1] exists) resolves to pi on the PATH", () => {
    expect(piInvocation()).toEqual({ command: "pi", prefix: [] });
  });

  it("a node driver script as host resolves to pi on the PATH", () => {
    const driver = join(dir, "driver.mjs");
    writeFileSync(driver, "");
    expect(piInvocation({ argv1: driver, execPath: NODE })).toEqual({ command: "pi", prefix: [] });
  });

  it("pi's own CLI entry is reused under the running runtime — directly and through a .bin symlink", () => {
    const root = fakePackage("@earendil-works/pi-coding-agent");
    const cli = join(root, "dist", "cli.js");
    expect(piInvocation({ argv1: cli, execPath: NODE })).toEqual({ command: NODE, prefix: [cli] });
    mkdirSync(join(dir, "node_modules", ".bin"));
    const link = join(dir, "node_modules", ".bin", "pi");
    symlinkSync(cli, link);
    expect(piInvocation({ argv1: link, execPath: NODE })).toEqual({
      command: NODE,
      prefix: [link],
    });
  });

  it("a string-valued bin counts; a non-bin file of the pi package does not", () => {
    const root = fakePackage("@earendil-works/pi-coding-agent", "dist/cli.js");
    expect(isPiCliEntry(join(root, "dist", "cli.js"))).toBe(true);
    expect(isPiCliEntry(join(root, "dist", "other.js"))).toBe(false);
  });

  it("another package's bin is not pi, nor is a missing file, nor a bun-compiled virtual path", () => {
    const root = fakePackage("vitest", { vitest: "dist/cli.js" });
    expect(piInvocation({ argv1: join(root, "dist", "cli.js"), execPath: NODE })).toEqual({
      command: "pi",
      prefix: [],
    });
    expect(piInvocation({ argv1: join(dir, "missing.js"), execPath: NODE })).toEqual({
      command: "pi",
      prefix: [],
    });
    expect(piInvocation({ argv1: "/$bunfs/root/pi", execPath: NODE })).toEqual({
      command: "pi",
      prefix: [],
    });
    expect(piInvocation({ argv1: undefined, execPath: NODE })).toEqual({
      command: "pi",
      prefix: [],
    });
  });

  it("a runner built with no invocation spawns pi, not the host", async () => {
    const calls: string[] = [];
    const spawn: SpawnFn = (command) => {
      calls.push(command);
      const child = new EventEmitter() as EventEmitter & ReturnType<SpawnFn>;
      Object.assign(child, {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: () => true,
      });
      setTimeout(() => child.emit("close", 1), 0);
      return child;
    };
    await piCaseRunner({ agentsDir: COMPANION_AGENTS_DIR, cwd: dir, spawn }).run(
      { id: "c", unit: "u", agent: "pass-survey", files: [], prompt: "p" },
      new AbortController().signal,
    );
    expect(calls).toEqual(["pi"]);
  });
});

describe("the scan leaf's isolation — argv and env", () => {
  /** What one case spawned: the fake child closes at once, failed. */
  async function spawned(
    opts: { root?: string; env?: NodeJS.ProcessEnv } = {},
  ): Promise<{ args: string[]; cwd: string; env: NodeJS.ProcessEnv | undefined }> {
    let seen: { args: string[]; cwd: string; env: NodeJS.ProcessEnv | undefined } | undefined;
    const spawn: SpawnFn = (_command, args, o) => {
      seen = { args, cwd: o.cwd, env: o.env };
      const child = new EventEmitter() as EventEmitter & ReturnType<SpawnFn>;
      Object.assign(child, {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: () => true,
      });
      setTimeout(() => child.emit("close", 1), 0);
      return child;
    };
    await piCaseRunner({
      agentsDir: COMPANION_AGENTS_DIR,
      cwd: "/opt/qcr",
      ...opts,
      spawn,
      invocation: { command: "pi", prefix: [] },
    }).run(
      { id: "c", unit: "u", agent: "pass-survey", files: [], prompt: "p" },
      new AbortController().signal,
    );
    if (!seen) throw new Error("the case runner never spawned pi");
    return seen;
  }

  it("loads no extension but bash-guard, no skill and no context file", async () => {
    const { args } = await spawned();
    for (const flag of ["-ne", "-ns", "-nc"]) expect(args).toContain(flag);
    expect(args).not.toContain("--no-extensions");
    const ext = args.flatMap((a, i) => (a === "--extension" || a === "-e" ? [args[i + 1]] : []));
    expect(ext).toEqual(["/opt/qcr/extensions/cli/bash-guard.ts"]);
    // the flags come before the prompt operand, which stays last
    expect(args.at(-1)).toBe("Task: p");
  });

  it("finds bash-guard under `root` when it is not the cwd", async () => {
    const { args } = await spawned({ root: "/srv/qcr" });
    expect(args[args.indexOf("--extension") + 1]).toBe("/srv/qcr/extensions/cli/bash-guard.ts");
  });

  it("starts pi with an allowlisted env, never the driver's, and no GitHub credential", async () => {
    const { env } = await spawned({
      env: {
        PATH: "/usr/bin",
        HOME: "/home/companion",
        LANG: "C.UTF-8",
        LC_ALL: "C",
        PI_CODING_AGENT_DIR: "/home/companion/.pi/agent",
        QCR_SANDBOX_ROOT: "/opt/qcr",
        OPENAI_API_KEY: "sk-model",
        GITHUB_TOKEN: "ghp_a",
        GH_TOKEN: "ghp_b",
        GH_ENTERPRISE_TOKEN: "ghp_c",
        QCR_GITHUB_READ_ENV: "/run/secrets/gh.env",
        DATABASE_URL: "postgres://x",
        AWS_SECRET_ACCESS_KEY: "nope",
        SSH_AUTH_SOCK: "/tmp/agent.sock",
      },
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/companion",
      LANG: "C.UTF-8",
      LC_ALL: "C",
      PI_CODING_AGENT_DIR: "/home/companion/.pi/agent",
      QCR_SANDBOX_ROOT: "/opt/qcr",
      OPENAI_API_KEY: "sk-model",
    });
  });

  it("with no env given it filters process.env", async () => {
    const was = { t: process.env.GITHUB_TOKEN, g: process.env.GH_TOKEN };
    process.env.GITHUB_TOKEN = "ghp_live";
    process.env.GH_TOKEN = "ghp_live2";
    try {
      const { env } = await spawned();
      expect(env).toBeDefined();
      expect(Object.keys(env!)).not.toContain("GITHUB_TOKEN");
      expect(Object.keys(env!)).not.toContain("GH_TOKEN");
      expect(env).toEqual(leafEnv(process.env));
    } finally {
      if (was.t === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = was.t;
      if (was.g === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = was.g;
    }
  });

  it("leafEnv drops a token env even when its name would otherwise match", () => {
    expect(leafEnv({ PATH: "/bin", GITHUB_TOKEN: "x", GH_ENTERPRISE_TOKEN: "y" })).toEqual({
      PATH: "/bin",
    });
  });
});
