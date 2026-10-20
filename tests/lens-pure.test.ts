// The lens tool's pure parts, which tests/subagents.test.ts and
// tests/subagents-deadline.test.ts pinned through the retired native glue:
// the weighted semaphore, the per-pass deadline, the scope pin, and the
// `[engine] lens_*` settings that replaced `[pi] subagent_*`.
import { readFileSync } from "node:fs";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LENS_PASS_DEADLINE_MIN,
  ENGINE_DEFAULTS,
  LENS_RUNTIME_KINDS,
  parseConfig,
} from "../src/config.js";
import {
  PASS_DEADLINE_ENV,
  passTimeoutMessage,
  resolvePassDeadlineMs,
  runUnderDeadline,
} from "../src/engine/lens/deadline.js";
import { lensAgentsDir } from "../src/engine/lens/round-lens.js";
import { WeightedSemaphore } from "../src/engine/lens/semaphore.js";

const tick = () => new Promise<void>((r) => setTimeout(r, 5));
const DEADLINE_MS = 120;

describe("WeightedSemaphore", () => {
  it("bounds concurrent holders and wakes waiters FIFO", async () => {
    const sem = new WeightedSemaphore(2);
    await sem.acquire(1);
    await sem.acquire(1);
    let third = false;
    const p = sem.acquire(1).then(() => {
      third = true;
    });
    await tick();
    expect(third).toBe(false);
    sem.release(1);
    await p;
    expect(third).toBe(true);
    expect(sem.held).toBe(2);
  });

  it("weighted acquire holds several permits at once", async () => {
    const sem = new WeightedSemaphore(6);
    await sem.acquire(4);
    expect(sem.held).toBe(4);
    let entered = false;
    const p = sem.acquire(4).then(() => {
      entered = true;
    });
    await tick();
    expect(entered).toBe(false); // only 2 free
    sem.release(4);
    await p;
    expect(sem.held).toBe(4);
  });

  it("never deadlocks on a weight above the permit count (clamped)", async () => {
    const sem = new WeightedSemaphore(2);
    await sem.acquire(10); // clamped to 2
    expect(sem.held).toBe(2);
    sem.release(10);
    expect(sem.held).toBe(0);
  });
});

describe("resolvePassDeadlineMs", () => {
  it("reads minutes from the env; absent, 0 or garbage means no deadline", () => {
    expect(resolvePassDeadlineMs({})).toBeUndefined();
    expect(resolvePassDeadlineMs({ [PASS_DEADLINE_ENV]: "0" })).toBeUndefined();
    expect(resolvePassDeadlineMs({ [PASS_DEADLINE_ENV]: "8x" })).toBeUndefined();
    expect(resolvePassDeadlineMs({ [PASS_DEADLINE_ENV]: "-1" })).toBeUndefined();
    expect(resolvePassDeadlineMs({ [PASS_DEADLINE_ENV]: "999" })).toBeUndefined();
    expect(resolvePassDeadlineMs({ [PASS_DEADLINE_ENV]: "8" })).toBe(480_000);
    expect(resolvePassDeadlineMs({ [PASS_DEADLINE_ENV]: "0.5" })).toBe(30_000);
  });

  it("names the pass and the deadline in the failure text", () => {
    expect(passTimeoutMessage("pass-security--sol-high", 480_000)).toBe(
      "pass pass-security--sol-high timed out after 8 min (retried once)",
    );
  });
});

describe("runUnderDeadline", () => {
  it("rethrows a non-deadline failure without retrying", async () => {
    let n = 0;
    await expect(
      runUnderDeadline(
        async () => {
          n++;
          throw new Error("boom");
        },
        undefined,
        DEADLINE_MS,
      ),
    ).rejects.toThrow("boom");
    expect(n).toBe(1);
  });

  it("reports each timeout and answers timed_out after the second", async () => {
    const seen: number[] = [];
    const hang = (signal: AbortSignal) =>
      new Promise<never>((_, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
      );
    const value = await runUnderDeadline(hang, undefined, 30, (n) => seen.push(n));
    expect(value).toBe("timed_out");
    expect(seen).toEqual([1, 2]);
  });
});

describe("lensAgentsDir", () => {
  it("the user scope reads the agent dir's agents; the project scope the nearest .pi/agents", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lens-agents-"));
    try {
      const agentDir = join(tmp, "agent");
      mkdirSync(join(tmp, "case", ".pi", "agents"), { recursive: true });
      mkdirSync(join(tmp, "case", "deep", "er"), { recursive: true });
      expect(lensAgentsDir({ PI_CODING_AGENT_DIR: agentDir }, tmp)).toBe(join(agentDir, "agents"));
      expect(
        lensAgentsDir(
          { PI_CODING_AGENT_DIR: agentDir, QCR_SUBAGENT_SCOPE: "project" },
          join(tmp, "case", "deep", "er"),
        ),
      ).toBe(join(tmp, "case", ".pi", "agents"));
      expect(() => lensAgentsDir({ PI_CODING_AGENT_DIR: "relative" }, tmp)).toThrow(/absolute/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("config.toml [engine] lens_* (the retired [pi] subagent_* keys)", () => {
  const toml = readFileSync(resolve(import.meta.dirname, "fixtures/config.toml"), "utf8");
  const withEngine = (lines: string) => `${toml}\n[engine]\n${lines}\n`;

  it("defaults: width 4, cache group 5, stagger 2500 ms, deadline 8 minutes", () => {
    const e = parseConfig(toml).engine;
    expect(e).toEqual(ENGINE_DEFAULTS);
    expect(e).toMatchObject({
      lens_max_concurrency: 4,
      lens_cache_group: 5,
      lens_cache_stagger_ms: 2500,
      lens_pass_deadline_min: DEFAULT_LENS_PASS_DEADLINE_MIN,
    });
    expect(DEFAULT_LENS_PASS_DEADLINE_MIN).toBe(8);
  });

  it("reads each key; 0 switches the deadline and the cache off", () => {
    const e = parseConfig(
      withEngine(
        "lens_max_concurrency = 12\nlens_cache_group = 0\nlens_cache_stagger_ms = 0\nlens_pass_deadline_min = 0",
      ),
    ).engine;
    expect(e).toMatchObject({
      lens_max_concurrency: 12,
      lens_cache_group: 0,
      lens_cache_stagger_ms: 0,
      lens_pass_deadline_min: 0,
    });
  });

  it("refuses a value out of range or of the wrong type", () => {
    for (const bad of [
      "lens_max_concurrency = 0",
      "lens_max_concurrency = 65",
      "lens_cache_group = -1",
      "lens_cache_stagger_ms = 2.5",
      "lens_pass_deadline_min = 241",
      'lens_pass_deadline_min = "8"',
    ])
      expect(() => parseConfig(withEngine(bad)), bad).toThrow(/\[engine\] lens_/);
  });

  it("refuses each [pi] subagent_* key with a retirement message naming its new home", () => {
    const moved = {
      subagent_max_concurrency: "lens_max_concurrency",
      subagent_cache_group: "lens_cache_group",
      subagent_cache_stagger_ms: "lens_cache_stagger_ms",
      subagent_pass_deadline_min: "lens_pass_deadline_min",
    };
    for (const [key, to] of Object.entries(moved)) {
      const text = toml.replace("[pi]", `[pi]\n${key} = 6`);
      expect(() => parseConfig(text), key).toThrow(
        new RegExp(`${key} is retired.*\\[engine\\] ${to}`),
      );
    }
  });

  it('refuses [pi] lens_runtime = "native" as retired; "engine" is the only kind', () => {
    expect(LENS_RUNTIME_KINDS).toEqual(["engine"]);
    const text = toml.replace("[pi]", '[pi]\nlens_runtime = "native"');
    expect(() => parseConfig(text)).toThrow(/lens_runtime = "native" is retired/);
    expect(parseConfig(toml).pi.lens_runtime).toBe("engine");
    expect(parseConfig(toml).pi.engine_wave).toBe(true);
  });
});
