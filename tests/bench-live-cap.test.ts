// The $ cap bites on a lens call's LIVE spend. A `subagent`/`launch_plan` call
// reports its children's cost on every tool_execution_update and the final
// figure on tool_execution_end: the meter counts the largest live value per
// toolCallId, and the end replaces it, never adding to it.
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventCostMeter, eventLineCostUsd } from "../src/bench/cost.js";
import { runPi } from "./helpers/pi-cli-runtime.js";

const child = (cost: number) => ({ usage: { cost: { total: cost } } });
const update = (id: string, costs: number[], name = "subagent") =>
  JSON.stringify({
    type: "tool_execution_update",
    toolName: name,
    toolCallId: id,
    partialResult: { details: { results: costs.map(child) } },
  });
const end = (id: string, costs: number[], name = "subagent") =>
  JSON.stringify({
    type: "tool_execution_end",
    toolName: name,
    toolCallId: id,
    result: { details: { results: costs.map(child) } },
  });
const message = (cost: number) =>
  JSON.stringify({
    type: "message_end",
    message: { role: "assistant", usage: { cost: { total: cost } } },
  });

describe("EventCostMeter", () => {
  it("counts a call's largest live value, never the sum of its updates", () => {
    const m = new EventCostMeter();
    m.add(update("t1", [0.25]));
    m.add(update("t1", [0.5, 0.25]));
    m.add(update("t1", [0.5])); // a smaller, reordered update adds nothing
    expect(m.totalUsd).toBeCloseTo(0.75);
  });

  it("lets tool_execution_end replace the live value, up or down", () => {
    const m = new EventCostMeter();
    m.add(update("t1", [1]));
    m.add(update("t2", [0.5]));
    m.add(end("t1", [0.75]));
    expect(m.totalUsd).toBeCloseTo(1.25);
    m.add(end("t2", [0.5, 0.5]));
    expect(m.totalUsd).toBeCloseTo(1.75);
  });

  it("prices a reused toolCallId after its end as a new call", () => {
    const m = new EventCostMeter();
    m.add(end("t1", [1]));
    m.add(end("t1", [2]));
    expect(m.totalUsd).toBeCloseTo(3);
  });

  it("keeps calls apart by toolCallId and adds message_end prices", () => {
    const m = new EventCostMeter();
    expect(m.add(message(0.5))).toBe(0.5);
    m.add(update("a", [1], "launch_plan"));
    m.add(update("b", [2]));
    m.add(end("a", [1], "launch_plan"));
    expect(m.totalUsd).toBeCloseTo(3.5);
  });

  it("ignores other tools, other lines and non-JSON", () => {
    const m = new EventCostMeter();
    m.add(update("t1", [9], "bash"));
    m.add(`{"type":"message_update"}`);
    m.add("not json");
    m.add("");
    expect(m.totalUsd).toBe(0);
  });

  it("prices an end with no earlier update exactly as the stateless line does", () => {
    expect(eventLineCostUsd(end("t1", [0.25, 0.5]))).toBeCloseTo(0.75);
    expect(new EventCostMeter().add(end("t1", [0.25, 0.5]))).toBeCloseTo(0.75);
  });
});

function fakePi(dir: string, lines: string[], endAfterMs: number, tail?: string): string {
  const bin = join(dir, "pi");
  const script = [
    `#!${process.execPath}`,
    `const lines = ${JSON.stringify(lines)};`,
    `for (const l of lines) process.stdout.write(l + "\\n");`,
    `setTimeout(() => { ${tail === undefined ? "" : `process.stdout.write(${JSON.stringify(tail)} + "\\n");`} }, ${endAfterMs});`,
  ].join("\n");
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  return bin;
}

describe("runPi's live cap", () => {
  it("kills a pi whose growing update details pass the cap before tool_execution_end", async () => {
    const dir = mkdtempSync(join(tmpdir(), "live-cap-"));
    const bin = fakePi(
      dir,
      [update("t1", [0.4]), update("t1", [0.8]), update("t1", [1.2])],
      30_000,
      end("t1", [1.2]),
    );
    const events = join(dir, "e.jsonl");
    const t0 = Date.now();
    const r = await runPi(
      [],
      process.env,
      dir,
      events,
      join(dir, "e.err"),
      60_000,
      bin,
      undefined,
      1,
    );
    expect(r.capped).toBe(true);
    expect(r.spentUsd).toBeCloseTo(1.2);
    expect(Date.now() - t0).toBeLessThan(20_000);
    // The quadratic update lines still stay out of the file, and no end was
    // ever written: the cap fired on the live figure alone.
    expect(readFileSync(events, "utf8")).toBe("");
  });

  it("does not cap on a call whose end comes in under the live figure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "live-cap-"));
    const bin = fakePi(dir, [update("t1", [0.4]), update("t1", [0.8]), end("t1", [0.7])], 0);
    const events = join(dir, "e.jsonl");
    const r = await runPi(
      [],
      process.env,
      dir,
      events,
      join(dir, "e.err"),
      60_000,
      bin,
      undefined,
      5,
    );
    expect(r.capped).toBe(false);
    expect(r.spentUsd).toBeCloseTo(0.7);
    expect(readFileSync(events, "utf8")).toBe(end("t1", [0.7]) + "\n");
  });
});
