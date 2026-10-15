// extensions/onboarding.ts — the wizard's pi tool belt over the engine.
// Driven with a fake engine assembly (fake adapters, temp dirs) —
// no pi, no docker, no network. The load-bearing property: finish_and_exit
// NEVER triggers shutdown while anything is red, and on green it writes the
// first-run marker and shuts down exactly once.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import activate, { renderChecks, toolDefinitions } from "../extensions/onboarding.js";
import {
  OnboardingEngine,
  firstRunMarkerPath,
  type OnboardAdapters,
} from "../src/onboard/engine.js";
import { preflightStep } from "../src/onboard/steps/preflight.js";
import type { PiToolDefinition, PiToolResult } from "@earendil-works/pi-coding-agent";

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "qcr-onboard-ext-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  vi.useRealTimers();
});

function fakeAdapters(opts: { dockerOk?: boolean } = {}): OnboardAdapters {
  const dockerOk = opts.dockerOk ?? true;
  return {
    fetch: (() => {
      throw new Error("no network in tests");
    }) as unknown as typeof fetch,
    runner: {
      run: async (cmd, args) => {
        if (cmd !== "docker") return { code: 127, stdout: "", stderr: "not found" };
        if (args[0] === "--version")
          return dockerOk
            ? { code: 0, stdout: "Docker 27\n", stderr: "" }
            : { code: 127, stdout: "", stderr: "no docker" };
        return { code: 0, stdout: "Compose v2\n", stderr: "" };
      },
    },
    clock: () => new Date("2026-08-30T12:00:00Z"),
    host: { nodeVersion: "v22.5.1", uid: 1000 },
    paths: { stateDir, configPath: join(dirname(stateDir), "config.toml") },
  };
}

function belt(opts: { dockerOk?: boolean } = {}): {
  defs: PiToolDefinition[];
  shutdown: ReturnType<typeof vi.fn>;
} {
  const engine = new OnboardingEngine([preflightStep()], fakeAdapters(opts));
  const shutdown = vi.fn();
  return { defs: toolDefinitions(engine, shutdown), shutdown };
}

function textOf(result: PiToolResult): string {
  return result.content.map((c) => c.text).join("\n");
}

async function call(defs: PiToolDefinition[], name: string): Promise<PiToolResult> {
  const def = defs.find((d) => d.name === name);
  expect(def, `tool ${name} registered`).toBeDefined();
  return def!.execute("id", {});
}

describe("tool belt shape", () => {
  it("registers one tool per engine step plus status and finish_and_exit, tool-name-safe", () => {
    const { defs } = belt();
    const names = defs.map((d) => d.name);
    expect(names).toEqual(["onboard_preflight", "onboard_status", "finish_and_exit"]);
    for (const n of names) expect(n).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it("renderChecks marks green and red lines distinctly", () => {
    const out = renderChecks([
      { name: "node", ok: true, detail: "Node v22" },
      { name: "docker", ok: false, detail: "missing" },
    ]);
    expect(out).toContain("✓ node — Node v22");
    expect(out).toContain("✗ docker — missing");
  });
});

describe("step + status tools", () => {
  it("onboard_preflight runs the step and reports per-check lines", async () => {
    const { defs } = belt();
    const out = textOf(await call(defs, "onboard_preflight"));
    expect(out).toMatch(/completed and recorded/);
    expect(out).toMatch(/✓ uid/);
  });

  it("a disabled step's tool says why it was refused, never 'fix the red checks'", async () => {
    const step = { ...preflightStep(), enabled: () => false };
    const engine = new OnboardingEngine([step], fakeAdapters());
    const out = textOf(await call(toolDefinitions(engine, vi.fn()), "onboard_preflight"));
    expect(out).toContain('Step "preflight" REFUSED');
    expect(out).toContain("disabled by the recorded choices");
    expect(out).not.toContain("red checks");
  });

  it("onboard_status re-verifies and renders the checklist", async () => {
    const { defs } = belt();
    await call(defs, "onboard_preflight");
    const out = textOf(await call(defs, "onboard_status"));
    expect(out).toMatch(/\[done\] preflight/);
  });
});

describe("finish_and_exit", () => {
  it("refuses while red: returns the failures, no shutdown, no marker", async () => {
    vi.useFakeTimers();
    const { defs, shutdown } = belt({ dockerOk: false });
    const out = textOf(await call(defs, "finish_and_exit"));
    expect(out).toMatch(/Not finished/);
    expect(out).toMatch(/docker/);
    await vi.advanceTimersByTimeAsync(1000);
    expect(shutdown).not.toHaveBeenCalled();
    expect(existsSync(firstRunMarkerPath(stateDir))).toBe(false);
  });

  it("green: writes the first-run marker and triggers the deferred shutdown with the tool ctx", async () => {
    vi.useFakeTimers();
    const { defs, shutdown } = belt();
    await call(defs, "onboard_preflight");
    const finish = defs.find((d) => d.name === "finish_and_exit")!;
    const ctx = { shutdown: () => {} };
    const out = textOf(await finish.execute("id", {}, undefined, undefined, ctx));
    expect(out).toMatch(/complete/);
    expect(existsSync(firstRunMarkerPath(stateDir))).toBe(true);
    expect(shutdown).not.toHaveBeenCalled(); // deferred — the result lands first
    await vi.advanceTimersByTimeAsync(1000);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledWith(ctx);
  });
});

describe("activation degradations", () => {
  it("a pi without registerTool registers nothing and does not throw (never wedges)", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => activate({ on: () => {}, sendUserMessage: () => {} } as never)).not.toThrow();
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });
});
