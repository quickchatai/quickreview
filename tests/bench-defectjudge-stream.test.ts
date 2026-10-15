// The defect judge (src/bench/defectjudge.ts) over a pi whose output stream
// failed: the round records that failure, not a model that wrote no JSON.
// The one pi spawn (runner.ts runJudgeSession) is mocked; temp dirs only.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { judgeCase, roundFile } from "../src/bench/defectjudge.js";

vi.mock("../src/bench/runner.js", () => ({
  runJudgeSession: vi.fn(async () => ({
    code: null,
    timedOut: false,
    streamError: "Error: ENOSPC: no space left on device, write",
  })),
}));

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("a judge round whose pi output stream failed", () => {
  it("records the stream failure as the round's error", async () => {
    dir = mkdtempSync(join(tmpdir(), "defectjudge-stream-"));
    const [j] = await judgeCase({
      pr: { instance_id: "o__r@1", repo: "o/r", title: "T", merge_base: "mb", head: "hd" },
      defects: [
        {
          id: "D1",
          title: "t",
          statement: "s",
          sites: [{ path: "a.py", from_line: 1, to_line: 1 }],
          kind: "bug",
          severity: "high",
          evidence: "a.py:1",
        },
      ],
      review: { verdict: null, body: null, comments: [] },
      outDir: dir,
      rounds: 1,
      defectSetVersion: "1",
      resume: false,
      log: () => {},
      pi: { root: "/x", cwd: dir, model: "m", env: {}, timeoutMs: 1000 },
    });
    expect(j!.error).toContain("ENOSPC");
    expect(JSON.parse(readFileSync(roundFile(dir, "o__r@1", 1), "utf8")).error).toContain(
      "output stream failed",
    );
  });
});
