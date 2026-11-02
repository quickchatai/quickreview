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
const { renderDeltaRound } = await import("@quickchatai/pi-quickreview/src/reviewdelta.js");
const { emptyState } = await import("@quickchatai/pi-quickreview/src/reviewstate.js");

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

  /**
   * The plugin's re-review: `/qcr-review --security` on a target reviewed
   * before plans the delta round through renderDeltaRound
   * (packages/pi-plugin/src/reviewdelta.ts). MUTATION: drop `...ctx.security`
   * from its planFollowUp call (or the `securityRequest` pass-through) — the
   * delta round plans no family row, and this fails.
   */
  it("a request reaches the delta round of a re-review", () => {
    const cfg = benchConfig("");
    const files = [{ ...FILES[0]!, additions: 200 }];
    const state = emptyState(TARGET.repo);
    state.rounds.push({
      round_no: 1,
      head_sha: "c".repeat(40),
      base_sha: TARGET.baseSha,
      merge_base: TARGET.mergeBase,
      reviewed_at: "2026-10-19T00:00:00.000Z",
      verdict: "APPROVE",
      scope: "full",
      cost_usd: null,
    });
    const delta = {
      ok: true as const,
      tree: "t".repeat(40),
      files: [
        {
          path: "src/a.ts",
          status: "modified",
          additions: 1,
          deletions: 0,
          ranges: [[1, 1]] as Array<[number, number]>,
          whole_file: false,
          patch: "@@ -1 +1,2 @@\n+export const b = 2;\n",
        },
      ],
      lines: 1,
      conflicted: [],
    };
    const render = (security: boolean) =>
      renderDeltaRound({
        root,
        cfg,
        ecosystem: ecosystemFor("none"),
        target: TARGET,
        tree,
        caseDir: join(tmp, security ? "delta-asked" : "delta-plain"),
        files,
        issuedAt: "2026-10-19T00:00:00.000Z",
        state,
        delta,
        ...(security ? { securityRequest: { by: "", source: "operator" as const } } : {}),
      });
    const asked = render(true);
    expect(asked.followUp.scope).toBe("delta");
    const family = new Set(
      asked.passPlan.filter((r) => SECURITY_FAMILY.includes(r.lens)).map((r) => r.lens),
    );
    expect(family.has("pass-sec-access")).toBe(true);
    const plain = render(false);
    expect(plain.followUp.scope).toBe("delta");
    expect(plain.passPlan.some((r) => SECURITY_FAMILY.includes(r.lens))).toBe(false);
  });
});
