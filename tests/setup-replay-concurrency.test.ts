// createSetup resolves every tool's concurrency from the env it was handed.
import { describe, expect, it, vi } from "vitest";

const built: Array<number | undefined> = [];

vi.mock("../extensions/setup-replay.js", async (orig) => {
  const real = await orig<typeof import("../extensions/setup-replay.js")>();
  return {
    ...real,
    buildReplay: (_repo: string, _env: unknown, concurrency?: number) => {
      built.push(concurrency);
      return {} as never;
    },
    replayToolDefinitions: () => [],
  };
});

import { createSetup } from "../extensions/setup.js";

describe("createSetup replay concurrency", () => {
  it("takes the replay cap from the injected env, not process.env", () => {
    const prev = process.env.QCR_SUBAGENT_MAX_CONCURRENCY;
    process.env.QCR_SUBAGENT_MAX_CONCURRENCY = "2";
    try {
      const pi = { registerTool: () => {}, on: () => {} };
      createSetup({
        env: { ...process.env, QCR_SUBAGENT_MAX_CONCURRENCY: "7" },
        cwd: process.cwd(),
      })(pi as never);
    } finally {
      if (prev === undefined) delete process.env.QCR_SUBAGENT_MAX_CONCURRENCY;
      else process.env.QCR_SUBAGENT_MAX_CONCURRENCY = prev;
    }
    expect(built).toEqual([7]);
  });
});
