import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendProgressLog,
  lensForAgent,
  parseRoundProgress,
  progressLogPath,
  roundExecutionStage,
} from "@quickchatai/pi-quickreview/src/round-progress.js";
import { LEGACY_TIER_NAMES, PASS_TIER_ORDER } from "@quickchatai/pi-quickreview/src/types.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the posting boundary tier vocabulary", () => {
  const names = [...PASS_TIER_ORDER, ...Object.keys(LEGACY_TIER_NAMES)];

  // MUTATION: replace sol-high by sol-low in the Python suffix — this fails.
  it("keeps the Python suffix mirror equal to the authoritative tier registry, both spellings", () => {
    const source = readFileSync(
      join(import.meta.dirname, "..", "scripts", "required-passes.py"),
      "utf8",
    );
    const suffix = source.match(/TIER_SUFFIX = re\.compile\(r"--\(\?:([^)]*)\)\$"\)/)?.[1];
    expect(suffix?.split("|").sort()).toEqual([...names].sort());
  });

  // A plan row stores the lens; the progress sidecar reports the agent the
  // session launched, under whichever spelling its transcript carries.
  // MUTATION: build TIER_SUFFIX in round-progress.ts from PASS_TIER_ORDER
  // alone — the other spelling keeps its suffix and this fails.
  it("lensForAgent strips a tier suffix in either spelling, and nothing else", () => {
    for (const tier of names) expect(lensForAgent(`pass-baseline--${tier}`)).toBe("pass-baseline");
    expect(lensForAgent("pass-baseline")).toBe("pass-baseline");
    expect(lensForAgent("pass-baseline--sol-max")).toBe("pass-baseline--sol-max");
    // Only the last suffix is the tier's.
    expect(lensForAgent(`pass-x--${names[0]}--${names.at(-1)}`)).toBe(`pass-x--${names[0]}`);
  });
});

describe("round progress reader", () => {
  it("rejects malformed milestone ordering while retaining legacy display snapshots", () => {
    const legacy = {
      version: 1,
      pr: 5408,
      session: "pr-5408",
      run_started_at: "2026-08-28T09:00:00Z",
      updated_at: "2026-08-28T09:01:00Z",
      parent_status: "active" as const,
      last_activity_at: "2026-08-28T09:01:00Z",
      last_activity: "working",
      agents: [],
    };
    expect(parseRoundProgress(JSON.stringify(legacy))?.version).toBe(1);
    expect(
      roundExecutionStage(
        {
          ...legacy,
          version: 2,
          command_id: "cmd-1",
          command_sha256: "a".repeat(64),
          command_accepted_at: "2026-08-28T09:00:10Z",
          preparing_at: "2026-08-28T09:00:10Z",
          last_activity: "compact context read",
        },
        ["pass-baseline"],
      ),
    ).toBe("preparing");
    expect(
      parseRoundProgress(
        JSON.stringify({
          ...legacy,
          version: 2,
          command_id: "cmd-1",
          command_sha256: "a".repeat(64),
          command_accepted_at: "2026-08-28T09:00:10Z",
          preparing_at: "2026-08-28T09:00:10Z",
          first_lens_started_at: "2026-08-28T09:00:05Z",
          fanout_started_at: "2026-08-28T09:00:05Z",
        }),
      ),
    ).toBeUndefined();
  });

  it("is bounded: past the cap it rotates once to .jsonl.1", () => {
    const root = mkdtempSync(join(tmpdir(), "qcr-progress-"));
    dirs.push(root);
    const path = progressLogPath(join(root, "pr-1.json"));
    expect(path).toBe(join(root, "pr-1.jsonl"));
    const line = (n: number) => ({
      at: new Date(n * 1000).toISOString(),
      pr: 1,
      session: "pr-1",
      run_started_at: new Date(0).toISOString(),
      event: "parent_start" as const,
    });
    const size = Buffer.byteLength(`${JSON.stringify(line(1))}\n`);
    for (let n = 1; n <= 7; n++) appendProgressLog(path, line(n), size * 3);
    // 1-3 filled the first file, 4-6 the second (1-3 rotated, later replaced), 7 starts a third.
    const read = (p: string) =>
      readFileSync(p, "utf8")
        .trimEnd()
        .split("\n")
        .map((l) => Date.parse(JSON.parse(l).at) / 1000);
    expect(read(`${path}.1`)).toEqual([4, 5, 6]);
    expect(read(path)).toEqual([7]);
    expect(existsSync(`${path}.2`)).toBe(false);
  });
});
