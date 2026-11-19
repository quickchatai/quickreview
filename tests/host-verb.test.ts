// `qcr --schema 3 host <verb>` through both doors: the bin's front door
// (runBin) and the image's entry (src/cli.ts `main`). The verbs' ports are
// swapped for a scratch world (no Docker, no GitHub, no process started), and
// everything on the way to them is real: the flag, the routing, the contract
// the payload is stamped with, stdout and the exit code. What each verb does
// is its own suite; what it prints is tests/host-contract.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import type { HostIo } from "../src/host/cli.js";
import type { HostPorts } from "../src/host/ports.js";
import { runBin } from "../src/qcrbin.js";
import { forgetRequestedContract } from "../src/schemaflag.js";
import { hostWorld, setUpConfig, type HostWorld } from "./helpers/host-rig.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

/** The ports the verbs run over in this file, set by each test. */
const world = vi.hoisted(() => ({ ports: undefined as unknown }));

vi.mock("../src/host/cli.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/host/cli.js")>();
  return {
    ...real,
    cmdHost: (args: readonly string[], io: HostIo = {}) =>
      real.cmdHost(args, { ...io, ports: world.ports as HostPorts }),
  };
});

describe("qcr --schema 3 host, at the doors", () => {
  let w: HostWorld;
  let out: string[];
  let err: string[];

  beforeEach(() => {
    w = hostWorld();
    w.writeConfig(setUpConfig());
    world.ports = w.ports;
    out = [];
    err = [];
    vi.spyOn(console, "log").mockImplementation((l: unknown) => void out.push(String(l)));
    vi.spyOn(console, "error").mockImplementation((l: unknown) => void err.push(String(l)));
    process.exitCode = undefined;
  });

  afterEach(() => {
    w.close();
    vi.restoreAllMocks();
    forgetRequestedContract();
    process.exitCode = undefined;
  });

  const printed = (): Record<string, unknown> => {
    expect(out).toHaveLength(1);
    return JSON.parse(out[0]!) as Record<string, unknown>;
  };

  // MUTATION: drop the `host` case from the front door's route — the verb
  // falls through to the app's usage, stdout holds no payload, and this fails.
  it("the front door runs the verb and prints its answer in contract 3", async () => {
    await runBin(["--schema", "3", "host", "review-now", "7"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(printed()).toEqual({ schema_version: 3, verb: "review-now", state: "queued", pr: 7 });
    expect(err).toEqual([]);
    expect(w.daemon.written).toHaveLength(1);
  });

  it("a refusal is printed too, with a non-zero exit, and nothing else on stdout", async () => {
    await runBin(["--schema", "3", "host", "setup", "--repo", "acme/other", "--auth", "user"]);
    expect(process.exitCode).toBe(1);
    expect(printed()).toMatchObject({
      schema_version: 3,
      verb: "setup",
      state: "refused",
      reason: "repo_mismatch",
    });
    expect(w.launched).toEqual([]);
  });

  it("a contract with no host family is refused before the verb: exit 3, empty stdout", async () => {
    await runBin(["--schema", "2", "host", "review-now", "7"]);
    expect(process.exitCode).toBe(3);
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/^qcr --schema: contract 2 has no host payload/);
    expect(w.calls).toEqual([]);
  });

  // The image's `qcr` runs dist/src/cli.js, never the front door. There the
  // verbs refuse for the place (tests/host-fences.test.ts); the door itself
  // is the same.
  // MUTATION: drop the `host` case from src/cli.ts main — the usage prints
  // instead of an answer, and this fails.
  it("the image's entry reaches the same verbs", { timeout: HEAVY_TIMEOUT_MS }, async () => {
    w.inImage = true;
    await main(["--schema", "3", "host", "go-live"]);
    expect(process.exitCode).toBe(1);
    expect(printed()).toMatchObject({
      schema_version: 3,
      verb: "go-live",
      state: "refused",
      reason: "not_on_host",
    });
  });
});
