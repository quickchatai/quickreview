// The one-shot route's state-machine request
// (packages/pi-plugin/src/engine/prompts.ts): a host's `--state-machines`
// plans the whole family through the same planner as the daemon, and each
// family row gets a task file like any other lens row.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { SECURITY_FAMILY, STATE_FAMILY } from "@quickchatai/pi-quickreview/src/passes.js";
import { FILES, FIXTURE_CONFIG, TARGET, mkRoot, mkTree } from "./helpers/round-rig.js";

vi.stubEnv("QCR_CONFIG", FIXTURE_CONFIG);
const { benchConfig } = await import("../src/bench/runner.js");
const { ecosystemFor } = await import("@quickchatai/pi-quickreview/src/ecosystem.js");
const { renderOneShotPrompts } = await import("@quickchatai/pi-quickreview/src/engine/prompts.js");

describe("a one-shot round's state-machine request", () => {
  const tmp = mkdtempSync(join(tmpdir(), "state-oneshot-"));
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  const root = mkRoot(tmp, "root");
  const tree = mkTree(tmp, "tree");
  const caseDir = join(tmp, "out");

  const render = (stateMachines: boolean) => {
    const cfg = benchConfig("");
    cfg.review.task_files = true;
    return renderOneShotPrompts({
      root,
      cfg,
      ecosystem: ecosystemFor("none"),
      target: TARGET,
      tree,
      caseDir,
      files: FILES,
      issuedAt: "2026-11-12T00:00:00.000Z",
      ...(stateMachines ? { stateRequest: { by: "", source: "operator" as const } } : {}),
    });
  };

  /**
   * MUTATION: drop `stateRequest` from planSecurityOf in engine/prompts.ts —
   * the request never reaches the planner and this fails.
   */
  it("a request plans the whole family, with a task for each row, and no security lens", () => {
    const p = render(true);
    const family = p.passPlan.filter((r) => STATE_FAMILY.includes(r.lens));
    expect(family.map((r) => r.lens).sort()).toEqual([...STATE_FAMILY].sort());
    for (const r of family)
      expect(r.why).toBe("a state-machine review was requested as the operator");
    expect(p.passPlan.some((r) => SECURITY_FAMILY.includes(r.lens))).toBe(false);
    for (const lens of STATE_FAMILY)
      expect(
        p.taskFiles.some((t) => t.text.includes(lens)),
        `a task names ${lens}`,
      ).toBe(true);
  });

  it("without a request, a change no trigger fires on plans no family row", () => {
    const p = render(false);
    expect(p.passPlan.some((r) => STATE_FAMILY.includes(r.lens))).toBe(false);
  });
});
