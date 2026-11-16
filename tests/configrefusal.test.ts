// A config refusal at an entry that bypasses the `qcr` bin's front door (the
// daemon's wire.js, the image's cli.js): one line on stderr and exit 1, never
// a stack; anything else propagates unchanged. tests/cli-bin.test.ts runs the
// two built entries on a bad config.
import { describe, expect, it } from "vitest";
import { ConfigError } from "@quickchatai/pi-quickreview/src/configerror.js";
import { isConfigRefusal, runRefusingConfig } from "../src/configrefusal.js";
import { MissingConfigError } from "../src/missingconfig.js";

function io() {
  const said: string[] = [];
  const exits: number[] = [];
  return {
    said,
    exits,
    io: { say: (l: string) => void said.push(l), exit: (c: number) => void exits.push(c) },
  };
}

describe("runRefusingConfig", () => {
  // MUTATION: drop the ConfigError arm from isConfigRefusal — this fails.
  it("turns a config that does not load into `<prefix>: <message>` and exit 1", async () => {
    const t = io();
    await runRefusingConfig(
      "[quickreviewd]",
      () =>
        Promise.reject(
          new ConfigError("/c.toml", '/c.toml [models] validate_tier: unknown tier "ultra"'),
        ),
      t.io,
    );
    expect(t.said).toEqual([
      '[quickreviewd]: /c.toml [models] validate_tier: unknown tier "ultra"',
    ]);
    expect(t.exits).toEqual([1]);
  });

  it("and a missing live config the same way", async () => {
    const t = io();
    await runRefusingConfig(
      "qcr status",
      () => Promise.reject(new MissingConfigError("no config at /x")),
      t.io,
    );
    expect(t.said).toEqual(["qcr status: no config at /x"]);
    expect(t.exits).toEqual([1]);
  });

  it("lets any other error propagate, and says nothing", async () => {
    const t = io();
    await expect(
      runRefusingConfig("qcr", () => Promise.reject(new Error("something else")), t.io),
    ).rejects.toThrow("something else");
    expect(t.said).toEqual([]);
    expect(t.exits).toEqual([]);
  });

  it("is silent when main succeeds", async () => {
    const t = io();
    await runRefusingConfig("qcr", () => Promise.resolve(), t.io);
    expect(t.said).toEqual([]);
    expect(t.exits).toEqual([]);
    expect(isConfigRefusal(new Error("x"))).toBe(false);
  });
});
