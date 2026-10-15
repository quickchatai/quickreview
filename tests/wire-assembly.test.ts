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
