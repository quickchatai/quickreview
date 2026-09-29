// piInvocation (src/setup/caserunner.ts) — how the case runner starts pi.
// A live smoke scan found every case spawning the HOST script instead of pi:
// the old rule reused `process.argv[1]` whenever that file existed, which is
// true of any node host (a driver script, vitest, the TUI). argv[1] may now be
// reused only when it is verifiably pi's own CLI entry — a `bin` of the pi
// package — and everything else resolves to `pi` on the PATH.
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMPANION_AGENTS_DIR } from "../extensions/setup.js";
import { isPiCliEntry, piCaseRunner, piInvocation, type SpawnFn } from "../src/setup/caserunner.js";

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
    expect(piInvocation({ argv1: link, execPath: NODE })).toEqual({ command: NODE, prefix: [link] });
  });

  it("a string-valued bin counts; a non-bin file of the pi package does not", () => {
    const root = fakePackage("@earendil-works/pi-coding-agent", "dist/cli.js");
    expect(isPiCliEntry(join(root, "dist", "cli.js"))).toBe(true);
    expect(isPiCliEntry(join(root, "dist", "other.js"))).toBe(false);
  });

  it("another package's bin is not pi, nor is a missing file, nor a bun-compiled virtual path", () => {
    const root = fakePackage("vitest", { vitest: "dist/cli.js" });
    expect(piInvocation({ argv1: join(root, "dist", "cli.js"), execPath: NODE })).toEqual({ command: "pi", prefix: [] });
    expect(piInvocation({ argv1: join(dir, "missing.js"), execPath: NODE })).toEqual({ command: "pi", prefix: [] });
    expect(piInvocation({ argv1: "/$bunfs/root/pi", execPath: NODE })).toEqual({ command: "pi", prefix: [] });
    expect(piInvocation({ argv1: undefined, execPath: NODE })).toEqual({ command: "pi", prefix: [] });
  });

  it("a runner built with no invocation spawns pi, not the host", async () => {
    const calls: string[] = [];
    const spawn: SpawnFn = (command) => {
      calls.push(command);
      const child = new EventEmitter() as EventEmitter & ReturnType<SpawnFn>;
      Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
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
