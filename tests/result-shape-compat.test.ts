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
