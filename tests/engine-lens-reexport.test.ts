// P1.4: the lens pure parts live in src/engine/lens/ and extensions/subagents.ts
// re-exports them — one implementation, not a copy.
import { describe, expect, it } from "vitest";
import * as subagents from "../extensions/subagents.js";
import * as cacheGroup from "../src/engine/lens/cache-group.js";
import * as deadline from "../src/engine/lens/deadline.js";
import * as launchPlan from "../src/engine/lens/launch-plan.js";
import * as semaphore from "../src/engine/lens/semaphore.js";

describe("src/engine/lens re-exports", () => {
  it.each([
    ["deadline", deadline],
    ["semaphore", semaphore],
    ["cache-group", cacheGroup],
    ["launch-plan", launchPlan],
  ] as const)("%s: every export is the same binding subagents.ts exports", (_name, mod) => {
    const names = Object.keys(mod).filter((k) => k in subagents);
    expect(names.length).toBeGreaterThan(0);
    for (const k of names) {
      expect((subagents as Record<string, unknown>)[k]).toBe((mod as Record<string, unknown>)[k]);
    }
  });

  it("the named moves are all reachable from subagents.ts", () => {
    for (const k of [
      "runUnderDeadline",
      "timedOutResult",
      "WeightedSemaphore",
      "CacheGrouper",
      "planLaunch",
      "taskPointer",
      "resolveTaskDir",
      "listTaskFiles",
    ])
      expect(subagents, k).toHaveProperty(k);
  });
});
