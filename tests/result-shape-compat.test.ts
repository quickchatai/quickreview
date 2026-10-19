// LensResult v1 and the lens ledger (src/lensresult.ts) against the consumers
// that read lens results: caseCostUsd / EventCostMeter (bench/cost.ts),
// stagesFromEvents and usageFromEvents (bench/aacr.ts), lensOutputsFromEvents
// (bench/whatif.ts) and the round usage that feeds est_usd (usage.ts, through
// the transcript index).
//
// What is pinned here:
//   1. every committed pi-events.jsonl (the whatif cases cut from a real run,
//      and the hand-built old-shape stream) reads BYTE-IDENTICAL to
//      golden.json, which was recorded before the consumers learned the new
//      names — the native `subagent` / `launch_plan` shape must not move;
//   2. the new shape (`lens` / `lens_wave`, results carrying `id`, plus the
//      lens-ledger) counts each lens ONCE, however many carriers repeat it,
//      and still counts a cache warm-up, which only the ledger records;
//   3. the ledger line round-trips and a foreign or malformed line is no line.
//
// Regenerate golden.json ONLY for a deliberate change to the old shape's
// readings: `UPDATE_GOLDEN=1 npx vitest run tests/result-shape-compat.test.ts`.
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { caseCostUsd, eventLineCostUsd, EventCostMeter } from "../src/bench/cost.js";
import { stagesFromEvents, usageFromEvents } from "../src/bench/aacr.js";
import { lensOutputsFromEvents } from "../src/bench/whatif.js";
import { TranscriptIndex } from "../src/transcriptindex.js";
import {
  isLensTool,
  ledgerLineOf,
  LensOnce,
  parseLedger,
  parseLedgerLine,
  serializeLedgerLine,
} from "../src/lensresult.js";
import { MemoryTranscriptFs } from "./helpers/memory-transcript-fs.js";

const FIXTURES = join(import.meta.dirname, "fixtures");
const COMPAT = join(FIXTURES, "result-shape-compat");
const WHATIF_CASES = join(FIXTURES, "bench-whatif", "source", "cases");
const GOLDEN = join(COMPAT, "golden.json");
const START = "2026-08-14T10:00:00.000Z";
const END = "2026-08-14T10:30:00.000Z";

const linesOf = (path: string): string[] => readFileSync(path, "utf8").split("\n");

/** The old-shape case dirs: the whatif cases and the hand-built stream. */
function oldShapeCases(): Record<string, string> {
  const out: Record<string, string> = {
    "old-shape": join(COMPAT, "old-shape"),
  };
  for (const name of readdirSync(WHATIF_CASES).sort())
    if (existsSync(join(WHATIF_CASES, name, "pi-events.jsonl")))
      out[`whatif/${name}`] = join(WHATIF_CASES, name);
  return out;
}

/** Everything the consumers read out of one case dir. */
async function snapshot(dir: string): Promise<unknown> {
  const events = linesOf(join(dir, "pi-events.jsonl"));
  const meter = new EventCostMeter();
  const running = events.map((l) => meter.add(l));
  const session = join(dir, "session.jsonl");
  let usage: unknown = null;
  if (existsSync(session)) {
    const fs = new MemoryTranscriptFs(
      { "/s/pr-1/session.jsonl": readFileSync(session, "utf8") },
      {},
      Date.parse(END),
    );
    usage = (
      await new TranscriptIndex({ fs }).measure({
        sessionDir: "/s/pr-1",
        startedAt: START,
        finishedAt: END,
      })
    ).usage;
  }
  return {
    stages: stagesFromEvents(events),
    cost: caseCostUsd(dir),
    eventUsage: usageFromEvents(events),
    outputs: lensOutputsFromEvents(events),
    lineCosts: events.map((l) => eventLineCostUsd(l)),
    running,
    total: meter.totalUsd,
    usage,
  };
}

describe("old shape — byte-identical to the recorded golden", () => {
  it("reads every committed pi-events.jsonl as before", async () => {
    const got: Record<string, unknown> = {};
    for (const [name, dir] of Object.entries(oldShapeCases())) got[name] = await snapshot(dir);
    const text = `${JSON.stringify(got, null, 2)}\n`;
    if (process.env["UPDATE_GOLDEN"]) writeFileSync(GOLDEN, text);
    expect(text).toBe(readFileSync(GOLDEN, "utf8"));
  });
});

// ---- the new shape ---------------------------------------------------------
// new-shape/: the old-shape stream with `lens` / `lens_wave` and LensResult v1
// ids (L1..L4), a SECOND lens_wave call returning the same wave (c1b), and a
// lens-ledger that lists L1..L4 again plus a cache warm-up (W1, $0.002) that no
// tool result reports.
const NEW = join(COMPAT, "new-shape");
const OLD = join(COMPAT, "old-shape");

describe("new shape — each lens counts once", () => {
  const events = linesOf(join(NEW, "pi-events.jsonl"));
  const oldEvents = linesOf(join(OLD, "pi-events.jsonl"));

  it("prices the events as the old shape: a repeated wave and the ledger add nothing", () => {
    const meter = new EventCostMeter();
    for (const l of events) meter.add(l);
    const old = new EventCostMeter();
    for (const l of oldEvents) old.add(l);
    expect(meter.totalUsd).toBeCloseTo(old.totalUsd, 12);
    expect(meter.totalUsd).toBeCloseTo(0.181, 12);
    // The ledger's L1..L4 are owned by the tool results; only the warm-up adds.
    for (const l of linesOf(join(NEW, "lens-ledger.jsonl"))) meter.add(l);
    expect(meter.totalUsd).toBeCloseTo(0.183, 12);
  });

  it("caseCostUsd reads the ledger beside the events", () => {
    expect(caseCostUsd(NEW)?.usd).toBeCloseTo(0.183, 12);
    expect(caseCostUsd(NEW)?.source).toBe("pi");
  });

  it("counts a lens the ledger alone reports (its tool result was lost), once", () => {
    const meter = new EventCostMeter();
    const ledger = linesOf(join(NEW, "lens-ledger.jsonl"));
    for (const l of ledger) meter.add(l);
    for (const l of ledger) meter.add(l); // the file read twice
    expect(meter.totalUsd).toBeCloseTo(0.002 + 0.05 + 0.04 + 0.03 + 0.025, 12);
    // The events afterwards: every id is owned by the ledger already.
    const before = meter.totalUsd;
    for (const l of events) if (!l.includes('"message_end"')) meter.add(l);
    expect(meter.totalUsd).toBeCloseTo(before, 12);
  });

  it("a live lens_wave update does not double the end that replaces it", () => {
    const meter = new EventCostMeter();
    const running = events.map((l) => meter.add(l));
    // Update half-price, then the end: net 0.09 for the wave, none for c1b.
    expect(running.reduce((a, b) => a + b, 0)).toBeCloseTo(meter.totalUsd, 12);
  });

  it("native results with no id still count on every call", () => {
    const run = (id: string) =>
      JSON.stringify({
        type: "tool_execution_end",
        toolName: "subagent",
        toolCallId: id,
        result: { details: { results: [{ agent: "pass-a", usage: { cost: 0.5 } }] } },
      });
    const meter = new EventCostMeter();
    meter.add(run("a"));
    meter.add(run("b"));
    expect(meter.totalUsd).toBe(1);
  });

  it("stagesFromEvents: the repeat call adds no usage, cost, agents or children", () => {
    const got = stagesFromEvents(events);
    const old = stagesFromEvents(oldEvents);
    expect(got.calls.map((c) => [c.agents.length, c.children])).toEqual([
      [2, 2],
      [0, 0], // lens_wave joining the same wave again
      [1, 1],
      [1, 1],
    ]);
    expect(got.phases.delta).toMatchObject({ agents: 3, usage: old.phases.delta.usage });
    expect(got.phases.sweep).toMatchObject({ agents: 1, usage: old.phases.sweep.usage });
    expect(got.phases.delta.cost).toBeCloseTo(old.phases.delta.cost, 12);
    expect(got.phases.sweep.cost).toBeCloseTo(old.phases.sweep.cost, 12);
    expect(got.calls[2]!.kind).toBe("validate");
    // A lens_wave has no args: its agents come from its results.
    expect(got.calls[0]!.agents).toEqual(["pass-baseline--terra-med", "pass-security--terra-med"]);
  });

  it("usageFromEvents counts four children, not six", () => {
    const got = usageFromEvents(events);
    expect(got).toEqual(usageFromEvents(oldEvents));
    expect(got.children).toBe(4);
  });

  it("lensOutputsFromEvents lists each lens once", () => {
    const got = lensOutputsFromEvents(events);
    expect(got.map((o) => o.agent)).toEqual(lensOutputsFromEvents(oldEvents).map((o) => o.agent));
    expect(got).toHaveLength(4);
  });

  it("round usage: results and ledger are one run each, the warm-up is extra", async () => {
    const files: Record<string, string> = {
      "/s/pr-1/session.jsonl": readFileSync(join(NEW, "session.jsonl"), "utf8"),
      "/s/pr-1/lens-ledger.jsonl": readFileSync(join(NEW, "lens-ledger.jsonl"), "utf8"),
    };
    const fs = new MemoryTranscriptFs(files, {}, Date.parse(END));
    const measured = await new TranscriptIndex({ fs }).measure({
      sessionDir: "/s/pr-1",
      startedAt: START,
      finishedAt: END,
    });
    const oldSession = new MemoryTranscriptFs(
      { "/s/pr-1/session.jsonl": readFileSync(join(OLD, "session.jsonl"), "utf8") },
      {},
      Date.parse(END),
    );
    const old = (
      await new TranscriptIndex({ fs: oldSession }).measure({
        sessionDir: "/s/pr-1",
        startedAt: START,
        finishedAt: END,
      })
    ).usage!;
    const u = measured.usage!;
    expect(u.tokens_in).toBe(old.tokens_in + 500);
    expect(u.tokens_out).toBe(old.tokens_out + 5);
    expect(u.tokens_cache_read).toBe(old.tokens_cache_read);
    expect(u.cost_usd).toBeCloseTo(old.cost_usd! + 0.002, 12);
    expect(u.children_included).toBe(true);
  });

  it("round usage: the same lens in two lens_wave results counts once, without the ledger", async () => {
    const fs = new MemoryTranscriptFs(
      { "/s/pr-1/session.jsonl": readFileSync(join(NEW, "session.jsonl"), "utf8") },
      {},
      Date.parse(END),
    );
    const u = (
      await new TranscriptIndex({ fs }).measure({
        sessionDir: "/s/pr-1",
        startedAt: START,
        finishedAt: END,
      })
    ).usage!;
    expect(u.cost_usd).toBeCloseTo(0.181, 12);
  });
});

describe("tool names (D3)", () => {
  it("accepts the old pair and the new pair, nothing else", () => {
    for (const n of ["subagent", "launch_plan", "lens", "lens_wave"])
      expect(isLensTool(n)).toBe(true);
    for (const n of ["bash", "lens_waves", "", undefined, 3]) expect(isLensTool(n)).toBe(false);
  });
});

describe("lens ledger lines", () => {
  const result = {
    agent: "pass-security--terra-med",
    model: "gpt-6.1-sol:med",
    usage: { input: 10, output: 2, cacheRead: 5, cost: 0.01 },
    exitCode: 0,
    stopReason: "stop",
    timedOut: false,
  };

  it("round-trips a lens and a warm-up line", () => {
    const lens = ledgerLineOf("lens", "L9", result, { startedAtMs: 1_000, endedAtMs: 3_500 });
    expect(lens).toMatchObject({ v: 1, kind: "lens", id: "L9", duration_ms: 2_500 });
    const warm = ledgerLineOf("warmup", "W9", result, { endedAtMs: 4_000 });
    const text = serializeLedgerLine(lens) + serializeLedgerLine(warm);
    expect(parseLedger(text)).toEqual([lens, warm]);
  });

  it("splits on LF only: U+2028 in an error message is not a boundary", () => {
    const line = ledgerLineOf(
      "lens",
      "L1",
      { ...result, errorMessage: "bad news here" },
      { endedAtMs: 1_000 },
    );
    const parsed = parseLedger(serializeLedgerLine(line));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.errorMessage).toBe("bad news here");
  });

  it("is no line: blank, malformed, a session record, another version or kind, no id", () => {
    const good = serializeLedgerLine(ledgerLineOf("lens", "L1", result, { endedAtMs: 1_000 }));
    const obj = JSON.parse(good) as Record<string, unknown>;
    for (const bad of [
      "",
      "{not json",
      "[]",
      JSON.stringify({ type: "message", message: { role: "assistant" } }),
      JSON.stringify({ ...obj, v: 2 }),
      JSON.stringify({ ...obj, kind: "other" }),
      JSON.stringify({ ...obj, id: "" }),
      JSON.stringify({ ...obj, usage: undefined }),
    ])
      expect(parseLedgerLine(bad)).toBeNull();
    expect(parseLedgerLine(good)).not.toBeNull();
  });

  it("LensOnce: ids count once, an absent id always counts", () => {
    const once = new LensOnce();
    expect([
      once.claim("a"),
      once.claim("a"),
      once.claim(null),
      once.claim(null),
      once.claim("b"),
    ]).toEqual([true, false, true, true, true]);
  });
});

describe("src/lensresult.ts is neutral", () => {
  // The daemon-side usage.ts imports it, so it must stay outside src/engine/
  // (the P2.1 fence) and depend on nothing itself.
  it("has no imports, and the daemon-side consumers import it", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "src", "lensresult.ts"), "utf8");
    expect(src).not.toMatch(/^\s*(import|export)\b[^;]*\bfrom\s/m);
    expect(src).not.toMatch(/\bimport\s*\(/);
    for (const f of ["usage.ts", "transcriptindex.ts"])
      expect(readFileSync(join(import.meta.dirname, "..", "src", f), "utf8")).toContain(
        '"./lensresult.js"',
      );
  });
});
