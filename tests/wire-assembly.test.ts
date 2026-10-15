// Source-level checks of the production assembly (src/wire.ts) that no
// in-process daemon can see: what onStart logs and retains for shutdown.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const wire = readFileSync(join(process.cwd(), "src", "wire.ts"), "utf8");

describe("wire.ts: the EOD timer's deferred fire", () => {
  it("never claims a drain lifted — a day also waits behind an earlier sweep", () => {
    const fire = /onDeferredFire: \(date\) => \{[\s\S]*?\n {8}\},/.exec(wire)?.[0] ?? "";
    expect(fire).toContain("eod_deferred_fired");
    expect(fire).not.toMatch(/drain that deferred it/);
    expect(fire).toMatch(/no drain or sweep holds it now/);
  });
});

describe("wire.ts: the lesson kill switch's agents rebuild", () => {
  it("a failed rebuild is reported in the command's answer, never as a validator already rebuilt", () => {
    const handler = /lessonSwitch\(change, file\) \{[\s\S]*?\n {8}\},/.exec(wire)?.[0] ?? "";
    expect(handler).toMatch(/catch \(err\) \{\s*rebuildFailed = true;/);
    expect(handler).toMatch(/rebuildFailed\s*\?\s*\{ agents_rebuild:/);
  });

  it("the 5-minute agents tick is the retry (dayScopedRebuild retries a stale build)", () => {
    expect(wire).toMatch(
      /const dayCheck = setInterval\(\(\) => \{\s*try \{\s*agentsDay\.tick\(\);/,
    );
  });
});

describe("wire.ts: onStart's intervals stop with the daemon", () => {
  it("the overseer rotation and the agents day check are cleared in onStop", () => {
    expect(wire).toMatch(/rotation\.unref\?\.\(\);\s*intervals\.push\(rotation\);/);
    expect(wire).toMatch(/dayCheck\.unref\?\.\(\);\s*intervals\.push\(dayCheck\);/);
    const stop = wire.slice(wire.indexOf("async onStop("));
    expect(stop).toMatch(/for \(const t of intervals\) clearInterval\(t\);/);
  });
});
