// `qcr --schema 3 board` through both doors: the bin's front door (runBin)
// and the image's entry (src/cli.ts `main`). The verb's own ports are swapped
// for fakes (no Docker here), and everything on the way to it is real: the
// flag, the routing, the contract it is stamped with, stdout and the exit
// code. The export itself is tests/board-export.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardIo, BoardPorts } from "../src/boardexport.js";
import { main } from "../src/cli.js";
import { known } from "../src/home/ports.js";
import { runBin } from "../src/qcrbin.js";
import { forgetRequestedContract } from "../src/schemaflag.js";
import { BoardWorld, at, fakeBoardPorts } from "./helpers/board-rig.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

/** The ports the verb reads in this file, set by each test. */
const world = vi.hoisted(() => ({ ports: undefined as unknown }));

vi.mock("../src/boardexport.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/boardexport.js")>();
  return {
    ...real,
    cmdBoard: (args: readonly string[], io: BoardIo = {}) =>
      real.cmdBoard(args, { ...io, ports: world.ports as BoardPorts }),
  };
});

describe("qcr --schema 3 board, at the doors", () => {
  let w: BoardWorld;
  let out: string[];
  let err: string[];

  beforeEach(() => {
    w = new BoardWorld();
    w.pr(1, { state: "queued", trigger_ts: at(-30) });
    const text = w.boardText();
    world.ports = fakeBoardPorts({ boardFile: async () => known(text) });
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

  // MUTATION: drop the `board` case from the front door's route — the verb
  // falls through to nothing, stdout is empty, and this fails.
  it("the front door prints the board in contract 3, and nothing on stderr", async () => {
    await runBin(["--schema", "3", "board"]);
    expect(process.exitCode ?? 0).toBe(0);
    const board = printed();
    expect(Object.keys(board)[0]).toBe("schema_version");
    expect(board).toMatchObject({
      schema_version: 3,
      repo: "acme/webapp",
      reviewer: "on",
      reviewing: [{ number: 1, state: "queued" }],
    });
    expect(err).toEqual([]);
  });

  it("a contract with no board is refused before the verb: exit 3, empty stdout", async () => {
    await runBin(["--schema", "2", "board"]);
    expect(process.exitCode).toBe(3);
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/^qcr --schema: contract 2 has no board payload/);
  });

  it("a board that cannot be built: a non-zero exit and empty stdout", async () => {
    world.ports = fakeBoardPorts({
      now: () => {
        throw new Error("no clock");
      },
    });
    await runBin(["--schema", "3", "board"]);
    expect(process.exitCode).toBe(1);
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
  });

  // The image's wrapper runs dist/src/cli.js, never the front door.
  // MUTATION: drop the `board` case from src/cli.ts main — the usage prints
  // instead of a board, and this fails.
  it("the image's entry prints the same board", { timeout: HEAVY_TIMEOUT_MS }, async () => {
    await main(["--schema", "3", "board"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(printed()).toMatchObject({ schema_version: 3, reviewing: [{ number: 1 }] });
    expect(err).toEqual([]);
  });
});
