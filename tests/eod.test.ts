import { describe, expect, it } from "vitest";
import {
  localWallClockToInstant,
  nextEodFire,
  renderEodPrompt,
  startEodTimer,
  zoneDateString,
  zoneOffsetMs,
  zonedParts,
} from "../src/eod.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const TZ = "Europe/Warsaw";

function warsawWall(d: Date): string {
  const p = zonedParts(d, TZ);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

describe("zone helpers", () => {
  it("reads Warsaw wall clock and offsets on both sides of DST", () => {
    // 2026-03-29 is the last Sunday of March; 2026-10-25 the last Sunday of October.
    expect(zoneOffsetMs(new Date("2026-03-28T12:00:00Z"), TZ)).toBe(3_600_000); // CET
    expect(zoneOffsetMs(new Date("2026-03-30T12:00:00Z"), TZ)).toBe(7_200_000); // CEST
    expect(zoneOffsetMs(new Date("2026-10-26T12:00:00Z"), TZ)).toBe(3_600_000); // back to CET
    expect(zoneDateString(new Date("2026-08-13T22:30:00Z"), TZ)).toBe("2026-08-14");
  });
});

describe("nextEodFire — same day vs next day", () => {
  it("fires today when now is before 18:00 Warsaw", () => {
    const now = new Date("2026-08-13T09:00:00Z"); // 11:00 Warsaw (CEST)
    const fire = nextEodFire(now, "18:00", TZ);
    expect(fire.toISOString()).toBe("2026-08-13T16:00:00.000Z");
    expect(warsawWall(fire)).toBe("2026-08-13 18:00");
  });

  it("rolls to tomorrow when now is after 18:00 Warsaw", () => {
    const now = new Date("2026-08-13T16:00:01Z"); // one second past the fire
    const fire = nextEodFire(now, "18:00", TZ);
    expect(fire.toISOString()).toBe("2026-08-14T16:00:00.000Z");
  });

  it("rolls to tomorrow when now is exactly the fire instant", () => {
    const now = new Date("2026-08-13T16:00:00Z");
    expect(nextEodFire(now, "18:00", TZ).toISOString()).toBe("2026-08-14T16:00:00.000Z");
  });
});

describe("DST: spring forward (last Sunday of March 2026 = 03-29)", () => {
  it("fires exactly once per local day at 18:00 across the transition", () => {
    const fires: Date[] = [];
    let cursor = new Date("2026-03-27T00:00:00Z");
    for (let i = 0; i < 4; i++) {
      const fire = nextEodFire(cursor, "18:00", TZ);
      fires.push(fire);
      cursor = new Date(fire.getTime() + 1000);
    }
    expect(fires.map(warsawWall)).toEqual([
      "2026-03-27 18:00",
      "2026-03-28 18:00",
      "2026-03-29 18:00",
      "2026-03-30 18:00",
    ]);
    // CET 18:00 = 17:00Z; CEST 18:00 = 16:00Z. The flip happens on the 29th.
    expect(fires.map((f) => f.toISOString())).toEqual([
      "2026-03-27T17:00:00.000Z",
      "2026-03-28T17:00:00.000Z",
      "2026-03-29T16:00:00.000Z",
      "2026-03-30T16:00:00.000Z",
    ]);
    // The transition day is 23h long between fires; the others 24h.
    const gaps = fires.slice(1).map((f, i) => (f.getTime() - fires[i]!.getTime()) / 3_600_000);
    expect(gaps).toEqual([24, 23, 24]);
  });
});

describe("DST: fall back (last Sunday of October 2026 = 10-25)", () => {
  it("fires exactly once per local day at 18:00 across the transition", () => {
    const fires: Date[] = [];
    let cursor = new Date("2026-10-23T00:00:00Z");
    for (let i = 0; i < 4; i++) {
      const fire = nextEodFire(cursor, "18:00", TZ);
      fires.push(fire);
      cursor = new Date(fire.getTime() + 1000);
    }
    expect(fires.map(warsawWall)).toEqual([
      "2026-10-23 18:00",
      "2026-10-24 18:00",
      "2026-10-25 18:00",
      "2026-10-26 18:00",
    ]);
    expect(fires.map((f) => f.toISOString())).toEqual([
      "2026-10-23T16:00:00.000Z",
      "2026-10-24T16:00:00.000Z",
      "2026-10-25T17:00:00.000Z",
      "2026-10-26T17:00:00.000Z",
    ]);
    const gaps = fires.slice(1).map((f, i) => (f.getTime() - fires[i]!.getTime()) / 3_600_000);
    expect(gaps).toEqual([24, 25, 24]);
  });

  it(
    "no local calendar day is skipped or doubled over a full year",
    { timeout: HEAVY_TIMEOUT_MS },
    () => {
      const seen: string[] = [];
      let cursor = new Date("2026-01-01T00:00:00Z");
      for (let i = 0; i < 365; i++) {
        const fire = nextEodFire(cursor, "18:00", TZ);
        seen.push(zoneDateString(fire, TZ));
        expect(warsawWall(fire).endsWith("18:00")).toBe(true);
        cursor = new Date(fire.getTime() + 1000);
      }
      expect(new Set(seen).size).toBe(seen.length);
    },
  );
});

describe("ambiguous / nonexistent wall clocks", () => {
  it("picks the first occurrence of a repeated hour (fall back, 02:30)", () => {
    const fire = localWallClockToInstant(2026, 10, 25, 2, 30, TZ);
    expect(fire.toISOString()).toBe("2026-10-25T00:30:00.000Z"); // still CEST
    expect(warsawWall(fire)).toBe("2026-10-25 02:30");
  });

  it("shifts a nonexistent wall clock forward (spring gap, 02:30)", () => {
    const fire = localWallClockToInstant(2026, 3, 29, 2, 30, TZ);
    expect(warsawWall(fire)).toBe("2026-03-29 03:30");
  });
});

describe("startEodTimer", () => {
  it("renders the prompt with the local date and reschedules", async () => {
    let clock = new Date("2026-03-29T10:00:00Z"); // 12:00 Warsaw, transition day
    const timers: Array<{ cb: () => void; ms: number }> = [];
    const injected: string[] = [];
    const fired: string[] = [];

    const timer = startEodTimer({
      timeHHMM: "18:00",
      timeZone: TZ,
      now: () => clock,
      readPrompt: () => "sweep for {{date}} — {{date}}",
      injectOverseer: async (m) => {
        injected.push(m);
      },
      setTimer: (cb, ms) => {
        timers.push({ cb, ms });
        return timers.length - 1;
      },
      clearTimer: () => {},
      onFire: (d) => fired.push(d),
    });

    expect(timer.nextFire().toISOString()).toBe("2026-03-29T16:00:00.000Z");
    expect(timers[0]!.ms).toBe(6 * 3_600_000);

    clock = new Date("2026-03-29T16:00:00Z");
    timers[0]!.cb();
    await new Promise((r) => setTimeout(r, 0));

    expect(injected).toEqual(["sweep for 2026-03-29 — 2026-03-29"]);
    expect(fired).toEqual(["2026-03-29"]);
    expect(timer.nextFire().toISOString()).toBe("2026-03-30T16:00:00.000Z");
    expect(timers).toHaveLength(2);
    timer.stop();
  });

  it("re-arms without firing when woken early (chunked long waits)", async () => {
    let clock = new Date("2026-08-13T09:00:00Z");
    const timers: Array<{ cb: () => void; ms: number }> = [];
    const injected: string[] = [];
    const timer = startEodTimer({
      timeHHMM: "18:00",
      timeZone: TZ,
      now: () => clock,
      readPrompt: () => "x {{date}}",
      injectOverseer: async (m) => {
        injected.push(m);
      },
      setTimer: (cb, ms) => {
        timers.push({ cb, ms });
        return timers.length - 1;
      },
      clearTimer: () => {},
    });
    clock = new Date("2026-08-13T12:00:00Z");
    timers[0]!.cb();
    await new Promise((r) => setTimeout(r, 0));
    expect(injected).toEqual([]);
    expect(timers).toHaveLength(2);
    expect(timers[1]!.ms).toBe(4 * 3_600_000);
    timer.stop();
  });

  it("renderEodPrompt substitutes every {{date}}", () => {
    expect(renderEodPrompt("a {{date}} b {{date}}", "2026-08-13")).toBe(
      "a 2026-08-13 b 2026-08-13",
    );
  });

  it("renderEodPrompt resolves the identity variables and fails loudly on an unknown one", () => {
    // Neutral role wording by default; identityVars(cfg) in production.
    expect(renderEodPrompt("for {{owner_name}} of {{repo}}", "2026-08-13")).toBe(
      "for the owner of the reviewed repository",
    );
    expect(
      renderEodPrompt("for {{owner_name}}", "2026-08-13", undefined, { owner_name: "Ada" }),
    ).toBe("for Ada");
    // No unexpanded {{…}} may ever reach the overseer session.
    expect(() => renderEodPrompt("bad {{mystery}}", "2026-08-13")).toThrow(/unknown placeholder/);
  });

  it("the real eod-sweep.md renders with no unexpanded {{…}}", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const template = readFileSync(resolve(import.meta.dirname, "../prompts/eod-sweep.md"), "utf8");
    const out = renderEodPrompt(template, "2026-08-29");
    expect(out).not.toContain("{{");
    expect(out).toContain("digest/2026-08-29.md");
  });

  it("appends dayContext to the fired prompt, and a throwing dayContext never loses the sweep", async () => {
    let clock = new Date("2026-08-13T09:00:00Z");
    const timers: Array<{ cb: () => void; ms: number }> = [];
    const injected: string[] = [];
    const missing: string[] = [];
    let boom = false;
    const timer = startEodTimer({
      timeHHMM: "18:00",
      timeZone: TZ,
      now: () => clock,
      readPrompt: () => "sweep {{date}}",
      dayContext: (d) => {
        if (boom) throw new Error("db gone");
        return `cancelled: none (${d})`;
      },
      onContextMissing: (d, why) => missing.push(`${d}: ${String(why)}`),
      injectOverseer: async (m) => {
        injected.push(m);
      },
      setTimer: (cb, ms) => {
        timers.push({ cb, ms });
        return timers.length - 1;
      },
      clearTimer: () => {},
    });
    clock = new Date("2026-08-13T16:00:00Z");
    timers[0]!.cb();
    await new Promise((r) => setTimeout(r, 0));
    expect(injected).toHaveLength(1);
    expect(injected[0]).toContain("sweep 2026-08-13");
    expect(injected[0]).toContain("## Daemon-measured context for 2026-08-13");
    expect(injected[0]).toContain("cancelled: none (2026-08-13)");

    boom = true;
    clock = new Date("2026-08-14T16:00:00Z");
    timers[1]!.cb();
    await new Promise((r) => setTimeout(r, 0));
    expect(injected).toHaveLength(2); // still fired
    expect(injected[1]).toBe("sweep 2026-08-14");
    expect(missing).toEqual(["2026-08-14: Error: db gone"]);
    timer.stop();
  });

  // The learner builds the day's outcomes packet in dayContext —
  // asynchronously — and answers the digest's pointer line beside the
  // curation instructions, which render as their own section.
  it("awaits an async dayContext; its curation renders as its own section, the pointer under the digest's lines", async () => {
    let clock = new Date("2026-08-13T09:00:00Z");
    const timers: Array<{ cb: () => void; ms: number }> = [];
    const injected: string[] = [];
    const timer = startEodTimer({
      timeHHMM: "18:00",
      timeZone: TZ,
      now: () => clock,
      readPrompt: () => "sweep {{date}}",
      memoryLayout: "the layout",
      dayContext: async (d) => {
        await new Promise((r) => setTimeout(r, 5));
        return {
          lines: `cancelled: none\noutcomes packet: state/eod/${d}/outcomes.md — 2 candidates`,
          curation: "Decide every candidate, then write the receipt.",
        };
      },
      injectOverseer: async (m) => {
        injected.push(m);
      },
      setTimer: (cb, ms) => {
        timers.push({ cb, ms });
        return timers.length - 1;
      },
      clearTimer: () => {},
    });
    clock = new Date("2026-08-13T16:00:00Z");
    timers[0]!.cb();
    await new Promise((r) => setTimeout(r, 30));
    expect(injected).toEqual([
      [
        "sweep 2026-08-13",
        "",
        "## Reviewer memory layout",
        "",
        "the layout",
        "",
        "## Outcomes to curate",
        "",
        "Decide every candidate, then write the receipt.",
        "",
        "## Daemon-measured context for 2026-08-13",
        "",
        "Carry these lines into today's digest verbatim (under Spend):",
        "",
        "cancelled: none",
        "outcomes packet: state/eod/2026-08-13/outcomes.md — 2 candidates",
        "",
      ].join("\n"),
    ]);
    timer.stop();
  });

  it("a dayContext that never answers costs its context, never the sweep — and says so", async () => {
    let clock = new Date("2026-08-13T09:00:00Z");
    const timers: Array<{ cb: () => void; ms: number }> = [];
    const injected: string[] = [];
    const missing: string[] = [];
    const timer = startEodTimer({
      timeHHMM: "18:00",
      timeZone: TZ,
      now: () => clock,
      readPrompt: () => "sweep {{date}}",
      dayContext: () => new Promise<string>(() => {}),
      dayContextTimeoutMs: 20,
      onContextMissing: (d, why) => missing.push(`${d}: ${String(why)}`),
      injectOverseer: async (m) => {
        injected.push(m);
      },
      setTimer: (cb, ms) => {
        timers.push({ cb, ms });
        return timers.length - 1;
      },
      clearTimer: () => {},
    });
    clock = new Date("2026-08-13T16:00:00Z");
    timers[0]!.cb();
    await new Promise((r) => setTimeout(r, 60));
    expect(injected).toEqual(["sweep 2026-08-13"]);
    expect(missing).toEqual(["2026-08-13: no answer within 20 ms"]);
    timer.stop();
  });
});
