// The one-shot route's security inputs (packages/pi-plugin/src/engine/prompts.ts):
// a host's `--security` request plans the whole family through the same
// planner as the daemon, the chain's `compose` task is written into
// `tasks-post/` (a directory the engine's wave never lists) and never into
// `tasks/`, and the threat model is read through the host's reader first.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { SECURITY_FAMILY } from "@quickchatai/pi-quickreview/src/passes.js";
import { FILES, FIXTURE_CONFIG, TARGET, mkRoot, mkTree } from "./helpers/round-rig.js";

vi.stubEnv("QCR_CONFIG", FIXTURE_CONFIG);
const { benchConfig } = await import("../src/bench/runner.js");
const { ecosystemFor } = await import("@quickchatai/pi-quickreview/src/ecosystem.js");
const { oneShotThreatModel, renderOneShotPrompts } =
  await import("@quickchatai/pi-quickreview/src/engine/prompts.js");

const CHAIN = "pass-sec-exploit-chain";

describe("a one-shot round's security inputs", () => {
  const tmp = mkdtempSync(join(tmpdir(), "security-oneshot-"));
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  const root = mkRoot(tmp, "root");
  const tree = mkTree(tmp, "tree");
  const caseDir = join(tmp, "out");

  const render = (security: boolean) => {
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
      issuedAt: "2026-10-19T00:00:00.000Z",
      ...(security ? { securityRequest: { by: "operator", source: "operator" as const } } : {}),
    });
  };

  /**
   * MUTATION: drop the `extraFiles.push` of the post-discovery tasks in
   * renderOneShotPrompts (or write them under `tasks/`) — this fails.
   */
  it("a request plans the family; compose's task is written into tasks-post/, never tasks/", () => {
    const p = render(true);
    const family = p.passPlan.filter((r) => SECURITY_FAMILY.includes(r.lens));
    expect(family.length).toBeGreaterThan(0);
    expect(p.passPlan.some((r) => r.strategy === "compose")).toBe(false);
    const post = (p.extraFiles ?? []).filter((f) => f.path.includes(`${sep}tasks-post${sep}`));
    expect(post).toHaveLength(1);
    expect(post[0]!.path.startsWith(join(caseDir, "tasks-post"))).toBe(true);
    expect(post[0]!.text).toContain(CHAIN);
    expect(p.taskFiles.length).toBeGreaterThan(0);
    for (const t of p.taskFiles) expect(t.path.startsWith(join(caseDir, "tasks"))).toBe(true);
    expect(p.taskFiles.some((t) => t.path.includes("tasks-post"))).toBe(false);
  });

  it("without a request, a change no trigger fires on writes no post-discovery task", () => {
    const p = render(false);
    expect(p.passPlan.some((r) => SECURITY_FAMILY.includes(r.lens))).toBe(false);
    expect((p.extraFiles ?? []).some((f) => f.path.includes("tasks-post"))).toBe(false);
  });

  it("the threat model: the host's reader first; a reader that throws or returns nothing is none", () => {
    const cfg = benchConfig("");
    const text = "# Threat model\n\n## Assets\n\n- the orders table\n";
    expect(oneShotThreatModel(root, cfg, { readRepoThreatModel: () => text })?.source).toBe("repo");
    const boom = (): string => {
      throw new Error("no base");
    };
    expect(oneShotThreatModel(root, cfg, { readRepoThreatModel: boom })).toBeNull();
    expect(oneShotThreatModel(root, cfg, { readRepoThreatModel: () => null })).toBeNull();
    expect(oneShotThreatModel(root, cfg, {})).toBeNull();
  });
});
