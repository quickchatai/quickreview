// A clean quit stops the companion container — including one whose bring-up
// was still inside the day rollover or the pi spawn when the quit-time grace
// ran out. The container is running from the moment `ensureUp` returns, so
// "fully up" is the wrong question for shutdown; "did this start put a
// container up" is the right one.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { stopCompanionOnQuit } from "../src/tui/index.js";

describe("stopCompanionOnQuit", () => {
  it("stops a container ensureUp started even though the bring-up never reached companionUp", async () => {
    const stop = vi.fn(async () => {});
    const lines: string[] = [];
    await stopCompanionOnQuit({ containerStarted: true, stop, write: (l) => lines.push(l) });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(lines.join("")).toContain("stopping the companion container");
  });

  it("does nothing when no container was brought up by this start", async () => {
    const stop = vi.fn(async () => {});
    await stopCompanionOnQuit({ containerStarted: false, stop, write: () => {} });
    expect(stop).not.toHaveBeenCalled();
  });

  it("a failing stop never fails the quit (leaving it running is harmless)", async () => {
    const stop = vi.fn(async () => {
      throw new Error("docker stop failed");
    });
    await expect(
      stopCompanionOnQuit({ containerStarted: true, stop, write: () => {} }),
    ).resolves.toBeUndefined();
  });

  it("runTui marks the container started as soon as ensureUp returns, and quits on THAT flag", () => {
    const src = readFileSync(new URL("../src/tui/index.ts", import.meta.url), "utf8");
    const ensure = src.indexOf("await companion.ensureUp(");
    const mark = src.indexOf("companionContainerStarted = true", ensure);
    const rollover = src.indexOf("await rollover.run()", ensure);
    expect(ensure).toBeGreaterThan(0);
    expect(mark).toBeGreaterThan(ensure);
    expect(mark).toBeLessThan(rollover);
    expect(src).toMatch(
      /stopCompanionOnQuit\(\{\s*containerStarted: companionContainerStarted \|\| companionUp/,
    );
  });
});
