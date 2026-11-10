// No old tier name is emitted.
//
// The tiers are `light`, `standard`, `deep`. The names they had before
// (`LEGACY_TIER_NAMES` in packages/pi-plugin/src/types.ts) are read on every
// input for good and written nowhere. This fence holds the second half on the
// things a planned round puts in front of a session, a person or a host
// plugin: the round order, its prompt, its lens task files, the built agents,
// the round's `status.json` row, and the `lenses` a review's `--json` carries.
//
// It walks no tracked files on purpose. The old names are in the source and
// the docs deliberately (the legacy map, the parse warning that lists them,
// the glossary's Avoid line, the profiles page), so a text ban over the tree
// would guard nothing the rule asks for. Every check here reads what the code
// produced, and each one first proves it is looking at something: a surface
// that names no tier at all cannot pass by being empty.
//
// MUTATION: return "sol-high" from RISK_TIER (packages/pi-plugin/src/types.ts:
// `export const RISK_TIER = "sol-high" as PassTier`) - this fails: the config
// names the risk tier, so it no longer loads and nothing here runs.
// MUTATION: in buildPassPlan (packages/pi-plugin/src/planner.ts) name a risk
// row's agent `${lens}--sol-high` - the order, the prompt, the task files and
// the review's lenses carry it, and both round cases fail.
// MUTATION: return `stored` unfolded from shownTier (src/state.ts) - the
// stored-row case fails.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { parseConfig, sandboxRoot, type Config } from "../src/config.js";
import { dispatchOnce, type DispatchAdapter } from "../src/dispatch.js";
import type { fingerprintRoundIntegrity } from "../src/execboundary.js";
import type { PrFileEntry } from "../src/github.js";
import { StateStore, buildStatusSnapshot, writeStatusJson } from "../src/state.js";
import type { GateResult } from "@quickchatai/pi-quickreview/src/gate.js";
import {
  PASS_ADDENDA,
  buildAgents,
  configAddenda,
  identityVars,
} from "@quickchatai/pi-quickreview/src/include.js";
import { lensTuningAddenda, roundAgentModels } from "@quickchatai/pi-quickreview/src/lenstuning.js";
import { postingPolicyAddenda } from "@quickchatai/pi-quickreview/src/postingpolicy.js";
import {
  LEGACY_TIER_NAMES,
  PASS_TIER_ORDER,
  RISK_TIER,
  type RoundOrder,
  type SessionHooks,
} from "@quickchatai/pi-quickreview/src/types.js";
import { FIXTURE_CONFIG, TARGET, mkRoot, mkTree } from "./helpers/round-rig.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

vi.stubEnv("QCR_CONFIG", FIXTURE_CONFIG);
const { benchConfig } = await import("../src/bench/runner.js");
const { ecosystemFor } = await import("@quickchatai/pi-quickreview/src/ecosystem.js");
const { renderOneShotPrompts } = await import("@quickchatai/pi-quickreview/src/engine/prompts.js");

const ROOT = resolve(import.meta.dirname, "..");
const cfg: Config = parseConfig(readFileSync(FIXTURE_CONFIG, "utf8"));

const tmp = mkdtempSync(join(tmpdir(), "fences-tier-names-"));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

/** An old name anywhere in a text: bare (`"tier": "sol-high"`) or as an
 * agent's suffix (`pass-x--sol-high`). */
const OLD = new RegExp(Object.keys(LEGACY_TIER_NAMES).join("|"));
/** A built agent's name in the ladder's spelling. */
const AGENT = new RegExp(`pass-[a-z-]+--(?:${PASS_TIER_ORDER.join("|")})(?![a-z-])`);

/** The lines of `text` that carry an old name, for a failure that says where. */
const oldNames = (text: string): string[] => text.split("\n").filter((line) => OLD.test(line));

/** Every surface names a tier in the ladder's spelling and none in the old. */
function expectLadderOnly(surfaces: Array<[name: string, text: string]>): void {
  expect(surfaces.length).toBeGreaterThan(0);
  for (const [name, text] of surfaces) {
    expect(AGENT.test(text), `${name}: names no built agent, so it proves nothing`).toBe(true);
    expect(oldNames(text), `${name}: an old tier name is emitted`).toEqual([]);
  }
}

/** A diff that plans every rung: small enough to start at the base tier, on
 * a path a risk pass is planned for, with rows the session may raise through
 * the rung between. */
const FILES: PrFileEntry[] = [
  { filename: "src/auth/session.py", additions: 20, deletions: 2, status: "modified" },
  { filename: "tests/test_session.py", additions: 10, deletions: 0, status: "modified" },
];

class Adapter implements DispatchAdapter {
  async getPr(): Promise<{ base_ref: string }> {
    return { base_ref: "main" };
  }
  async listPrFiles(): Promise<PrFileEntry[]> {
    return FILES;
  }
  async compareFiles(): Promise<PrFileEntry[]> {
    return [];
  }
  async addLabel(): Promise<GateResult> {
    return { executed: false, dryRunFile: "x" };
  }
  async removeLabel(): Promise<GateResult> {
    return { executed: false, dryRunFile: "x" };
  }
  async deleteTeamReviewRequest(): Promise<GateResult> {
    return { executed: false, dryRunFile: "x" };
  }
  async createReview(): Promise<GateResult> {
    return { executed: false, dryRunFile: "x" };
  }
}

/** The files an order points a session at, by the field that names them. */
function taskFilesOf(order: RoundOrder): string[] {
  return [
    ...(order.pass_task_files ?? []),
    ...(order.sweep_task_files ?? []),
    ...(order.optional_task_files ?? []),
    ...(order.post_task_files ?? []),
  ].map((t) => t.path);
}

describe("no old tier name is emitted", () => {
  it(
    "a round the daemon plans: the order, its prompt, its task files and its status.json row",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const pr = 9411;
      const passesDir = join(sandboxRoot(), "state", `pr-${pr}-round-1-passes`);
      const store = new StateStore(":memory:");
      store.upsertPr({
        number: pr,
        state: "queued",
        head_sha: "a".repeat(40),
        title: "Orders: tenant check",
        author: "alice",
        trigger_ts: "2026-08-13T09:00:00Z",
        trigger_provenance: null,
        stale_recheck: 0,
        migration_gate: 0,
      });
      const sent: Array<{ order: RoundOrder; prompt: string }> = [];
      const hooks: SessionHooks = {
        async dispatchRound(order, prompt) {
          sent.push({ order, prompt });
        },
        async inject() {},
        async archiveAndClose() {},
      };
      try {
        await dispatchOnce({
          cfg: { ...cfg, review: { ...cfg.review, task_files: true } },
          store,
          adapter: new Adapter(),
          hooks,
          // The policy-surface hash is not what this fence reads.
          integrityFingerprint: async () =>
            ({ digest: "stub", files: {} }) as unknown as Awaited<
              ReturnType<typeof fingerprintRoundIntegrity>
            >,
        });
        expect(sent).toHaveLength(1);
        const { order, prompt } = sent[0]!;

        // The plan reaches every rung, so no rung's name goes unlooked at.
        const planned = new Set([
          ...order.pass_plan.map((p) => p.tier),
          ...order.pass_plan.flatMap((p) =>
            p.raisable_to.map((a) => a.slice(a.lastIndexOf("--") + 2)),
          ),
        ]);
        expect([...planned].sort()).toEqual([...PASS_TIER_ORDER].sort());
        expect(order.pass_plan.some((p) => p.tier === RISK_TIER)).toBe(true);

        const tasks = taskFilesOf(order);
        expect(tasks.length).toBeGreaterThan(0);
        expectLadderOnly([
          ["the round order", JSON.stringify(order, null, 1)],
          ["the round prompt", prompt],
          ["the task file names", tasks.join("\n")],
          ...tasks.map((p): [string, string] => [
            `task file ${p}`,
            `${p}\n${readFileSync(p, "utf8")}`,
          ]),
        ]);

        // The row a board reads: what the daemon writes to status.json.
        const dir = join(tmp, "status");
        writeStatusJson(dir, buildStatusSnapshot(store, true));
        const status = readFileSync(join(dir, "status.json"), "utf8");
        const row = (
          JSON.parse(status) as { prs: Array<{ current_round?: { validate_tier?: unknown } }> }
        ).prs[0]!;
        expect(PASS_TIER_ORDER as readonly unknown[]).toContain(row.current_round?.validate_tier);
        expect(oldNames(status), "status.json: an old tier name is emitted").toEqual([]);

        // The stored round, as the daemon wrote it.
        const stored = store.roundsFor(pr)[0]!;
        expect(oldNames(JSON.stringify(stored, null, 1)), "the rounds row").toEqual([]);
      } finally {
        rmSync(passesDir, { recursive: true, force: true });
      }
    },
  );

  it("a round stored under an old name shows the ladder's name in status.json", () => {
    const store = new StateStore(":memory:");
    store.upsertPr({
      number: 8,
      state: "reviewing",
      head_sha: "b".repeat(40),
      title: "PR 8",
      author: "alice",
      trigger_ts: null,
      trigger_provenance: null,
      stale_recheck: 0,
      migration_gate: 0,
    });
    for (const [older, tier] of Object.entries(LEGACY_TIER_NAMES)) {
      const id = store.startRound(8, "first", ["pass-baseline"], 45, { validate_tier: older });
      const status = JSON.stringify(buildStatusSnapshot(store, true), null, 1);
      expect(status).toContain(`"validate_tier": "${tier}"`);
      expect(oldNames(status), `a row stored as ${older}`).toEqual([]);
      store.finishRound(id, "APPROVE", null);
    }
  });

  it("a `qcr review` round: the plan, the prompts, the task files and the lenses its --json carries", () => {
    const root = mkRoot(tmp, "root");
    const tree = mkTree(tmp, "tree");
    const review = benchConfig("");
    review.review.task_files = true;
    const prompts = renderOneShotPrompts({
      root,
      cfg: review,
      ecosystem: ecosystemFor("none"),
      target: TARGET,
      tree,
      caseDir: join(tmp, "out"),
      files: FILES,
      issuedAt: "2026-10-19T00:00:00.000Z",
    });
    // `lenses` in a review's `--json` is this array (reviewapi.ts reads
    // `prompts.plannedLenses` into the preview and every later payload).
    expect(prompts.plannedLenses.length).toBeGreaterThan(2);
    for (const lens of prompts.plannedLenses) expect(lens).toMatch(AGENT);
    expect(prompts.taskFiles.length).toBeGreaterThan(0);
    expectLadderOnly([
      ["lenses", prompts.plannedLenses.join("\n")],
      ["the plan", JSON.stringify(prompts.passPlan, null, 1)],
      ["the round order", prompts.order],
      ...prompts.taskFiles.map((t): [string, string] => [
        `task file ${t.path}`,
        `${t.path}\n${t.text}`,
      ]),
    ]);
    expect(oldNames(prompts.system), "the system prompt").toEqual([]);
  });

  it("the built agents: every file's name, frontmatter and body", () => {
    const out = join(tmp, "agents");
    buildAgents(join(ROOT, "agents"), out, {
      root: ROOT,
      tiers: cfg.models.tiers,
      riskPasses: cfg.models.risk_passes,
      validateTier: cfg.models.validate_tier,
      vars: identityVars(cfg),
      models: roundAgentModels(cfg),
      addenda: [
        ...PASS_ADDENDA,
        ...configAddenda(cfg.review),
        ...lensTuningAddenda(cfg.lenses),
        ...postingPolicyAddenda(cfg.posting),
      ],
    });
    const files = readdirSync(out).sort();
    expect(files.length).toBeGreaterThan(20);
    // One variant per rung at least, and nothing built under any other suffix.
    for (const tier of PASS_TIER_ORDER)
      expect(
        files.some((f) => f.endsWith(`--${tier}.md`)),
        tier,
      ).toBe(true);
    const suffix = new RegExp(`--(?:${PASS_TIER_ORDER.join("|")})\\.md$`);
    expect(files.filter((f) => f.includes("--") && !suffix.test(f))).toEqual([]);
    expectLadderOnly(
      files
        .filter((f) => suffix.test(f))
        .map((f): [string, string] => [f, `${f}\n${readFileSync(join(out, f), "utf8")}`]),
    );
  });

  it("the recorded --json payloads of a review and a scan", () => {
    // tests/fixtures/json-contract is what the verbs printed, recorded by
    // tests/json-contract.test.ts's own switch; a payload that names a tier
    // names it in the ladder's spelling.
    const dir = join(ROOT, "tests", "fixtures", "json-contract");
    const payloads = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(payloads.length).toBeGreaterThan(5);
    const done = readFileSync(join(dir, "review-done.json"), "utf8");
    expect(AGENT.test(done), "review-done.json names its lenses").toBe(true);
    for (const f of payloads) expect(oldNames(readFileSync(join(dir, f), "utf8")), f).toEqual([]);
  });

  it("the matcher sees an old name bare and as an agent's suffix, and no model id", () => {
    // Without this the fence could pass by matching nothing.
    expect(oldNames('{ "tier": "sol-high" }')).toHaveLength(1);
    expect(oldNames("run `pass-sweep--terra-med` next")).toHaveLength(1);
    expect(oldNames("01-pass-baseline--sol-med.md")).toHaveLength(1);
    expect(oldNames("model: openai-codex/gpt-5.6-sol:high")).toEqual([]);
    expect(oldNames(PASS_TIER_ORDER.map((t) => `pass-x--${t}`).join("\n"))).toEqual([]);
  });
});
