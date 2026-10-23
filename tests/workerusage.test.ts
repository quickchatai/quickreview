// The daemon keeps what a worker reports it spent: `usage` events as they
// come, `done` as the closing figure, nothing for a body that is not a spend.
import { describe, expect, it } from "vitest";
import { usageOfEvent, workerUsageHandler } from "../src/workerusage.js";
import type { RequestContext } from "../src/ipc/server.js";

describe("worker usage events", () => {
  it("reads total and lens spend; only done closes", () => {
    const body = { total_usd: 1.25, lens_usd: 0.75, lens_runs: 3, turns: 2 };
    expect(usageOfEvent("usage", body)).toEqual({ est_usd: 1.25, lens_usd: 0.75, final: false });
    expect(usageOfEvent("done", body)).toEqual({ est_usd: 1.25, lens_usd: 0.75, final: true });
  });

  it("keeps nothing from other kinds or a body that is not a spend", () => {
    expect(usageOfEvent("progress", { total_usd: 1 })).toBeNull();
    expect(usageOfEvent("usage", null)).toBeNull();
    expect(usageOfEvent("usage", { total_usd: "1" })).toBeNull();
    expect(usageOfEvent("usage", { total_usd: -1 })).toBeNull();
    expect(usageOfEvent("done", { total_usd: Number.NaN })).toBeNull();
    expect(usageOfEvent("usage", { total_usd: 1, lens_usd: "x" })).toEqual({
      est_usd: 1,
      lens_usd: null,
      final: false,
    });
  });

  it("stores it against the reporting command", () => {
    const seen: unknown[] = [];
    const handle = workerUsageHandler({
      recordCommandUsage: (id, usage) => (seen.push([id, usage]), true),
    });
    const ctx = { commandId: "cmd-9" } as RequestContext;
    handle(ctx, "usage", { total_usd: 0.5, lens_usd: 0 });
    handle(ctx, "ready", { total_usd: 9 });
    expect(seen).toEqual([["cmd-9", { est_usd: 0.5, lens_usd: 0, final: false }]]);
  });
});
