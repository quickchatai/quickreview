import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendProgressLog,
  parseRoundProgress,
  progressLogPath,
  roundExecutionStage,
} from "../src/round-progress.js";
import { PASS_TIER_ORDER } from "../src/types.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the posting boundary tier vocabulary", () => {
  // MUTATION: replace sol-high by sol-low in the Python suffix — this fails.
  it("keeps the Python suffix mirror equal to the authoritative tier registry", () => {
    const source = readFileSync(
      join(import.meta.dirname, "..", "scripts", "required-passes.py"),
      "utf8",
    );
    const suffix = source.match(/TIER_SUFFIX = re\.compile\(r"--\(\?:([^)]*)\)\$"\)/)?.[1];
    expect(suffix?.split("|")).toEqual([...PASS_TIER_ORDER]);
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
