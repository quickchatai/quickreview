// The wizard's streaming runner (the long `docker compose up --build` seam):
// each output stream keeps its own partial line, so a stdout line still being
// written is never spliced onto a line stderr completes in the meantime.
import { describe, expect, it } from "vitest";
import { nodeStreamRunner } from "../src/onboard/steps/compose.js";

describe("nodeStreamRunner", () => {
  it("keeps stdout's unfinished line apart from a stderr line that lands in between", async () => {
    const script = [
      'process.stdout.write("building ");',
      'setTimeout(() => process.stderr.write("warning: slow mirror\\n"), 100);',
      'setTimeout(() => process.stdout.write("layer 3\\n"), 300);',
    ].join("\n");
    const lines: string[] = [];
    const result = await nodeStreamRunner.run(process.execPath, ["-e", script], (line) =>
      lines.push(line),
    );
    expect(result.code).toBe(0);
    expect(lines.sort()).toEqual(["building layer 3", "warning: slow mirror"]);
    expect(result.stdout).toBe("building layer 3\n");
    expect(result.stderr).toBe("warning: slow mirror\n");
  });

  it("flushes each stream's trailing partial line on its own at close", async () => {
    const script = 'process.stdout.write("out-tail"); process.stderr.write("err-tail");';
    const lines: string[] = [];
    await nodeStreamRunner.run(process.execPath, ["-e", script], (line) => lines.push(line));
    expect(lines.sort()).toEqual(["err-tail", "out-tail"]);
  });
});
