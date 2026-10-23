// The answer worker's verdict check (src/engine/answerguard.ts): a command line that
// runs scripts/commit-verdict.sh is refused however the path is spelled.
import { describe, expect, it } from "vitest";
import { commitsVerdict } from "../src/engine/answerguard.js";

describe("commitsVerdict", () => {
  it.each([
    "scripts/commit-verdict.sh pr-7-round-1.json",
    "bash scripts/commit-verdict.sh x",
    "./commit-verdict.sh",
    'bash "scripts/commit-verdict.sh" pr-7-round-1.json',
    "bash 'scripts/commit-verdict.sh' pr-7-round-1.json",
    'bash scripts/"commit-verdict.sh" x',
  ])("flags %s", (cmd) => {
    expect(commitsVerdict(cmd)).toBe(true);
  });

  it.each(["scripts/post-review.sh x", "cat commit-verdict.shx", "echo my-commit-verdict.sh.bak"])(
    "leaves %s alone",
    (cmd) => {
      expect(commitsVerdict(cmd)).toBe(false);
    },
  );
});
