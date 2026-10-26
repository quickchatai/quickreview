// The `qcr` bin's top-level error path: a filesystem refusal (EACCES, EPERM,
// EROFS) on a path, or a missing live config, is one line on stderr and exit
// 1, never a stack; any other error propagates unchanged. The app's `main` is faked to throw.
import { afterEach, describe, expect, it, vi } from "vitest";
import { MissingConfigError } from "../src/missingconfig.js";
import { runBin } from "../src/qcrbin.js";

const thrown: { err: unknown } = { err: null };
vi.mock("../src/cli.js", () => ({
  main: async () => {
    throw thrown.err;
  },
}));

describe("the bin's top-level error path", () => {
  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  // MUTATION: drop the fsDeniedLine branch from runBin's catch — the refusal
  // propagates as a stack and this fails.
  it("turns a filesystem refusal into one line on stderr and exit 1", async () => {
    const path = "/usr/lib/node_modules/@quickchatai/quickreview/state";
    thrown.err = Object.assign(new Error(`EACCES: permission denied, mkdir '${path}'`), {
      code: "EACCES",
      path,
      syscall: "mkdir",
    });
    const errs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((l: unknown) => void errs.push(String(l)));
    await runBin(["today"]);
    expect(process.exitCode).toBe(1);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain(`qcr today: ${path}: permission denied`);
    expect(errs[0]).not.toContain("\n");
  });

  // MUTATION: drop the MissingConfigError branch from runBin's catch — a
  // fresh install's first config-reading verb prints a stack and this fails.
  it("turns a missing config into one line on stderr and exit 1", async () => {
    thrown.err = new MissingConfigError(
      "no config at /h/.config/qcr/default/config.toml — the install's config home holds none (a bare `qcr` writes one when you choose a repository)",
    );
    const errs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((l: unknown) => void errs.push(String(l)));
    await runBin(["regression"]);
    expect(process.exitCode).toBe(1);
    expect(errs).toEqual([
      "qcr regression: no config at /h/.config/qcr/default/config.toml — the install's config home holds none (a bare `qcr` writes one when you choose a repository)",
    ]);
  });

  it("lets any other error propagate", async () => {
    thrown.err = new Error("something else");
    await expect(runBin(["today"])).rejects.toThrow("something else");
  });
});
