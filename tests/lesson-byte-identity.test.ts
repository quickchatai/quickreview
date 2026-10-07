// NO DELIVERY YET: under every value of `[memory] delivery` the
// round prompts, the lens task files, the built agents and the bench are
// byte-identical to today. The selection runs (and finds lessons) under
// `shadow` and `on`; nothing it found reaches anything a session reads.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseCaseSet, type PrefetchMeta } from "../src/bench/aacr.js";
import { renderCasePrompts, runFingerprint } from "../src/bench/runner.js";
import { parseConfig, sandboxRoot, type Config, type MemoryDelivery } from "../src/config.js";
import { dispatchOnce, type DispatchAdapter } from "../src/dispatch.js";
import { ecosystemFor } from "../src/ecosystem.js";
import type { GateResult } from "../src/gate.js";
import type { PrFileEntry } from "../src/github.js";
import {
  buildAgents,
  configAddenda,
  identityVars,
  PASS_ADDENDA,
  passTierModels,
} from "../src/include.js";
import { lensModelOverrides, lensTuningAddenda } from "../src/lenstuning.js";
import { LessonLedger } from "../src/lessonledger.js";
import { RoundLessonSelector } from "../src/lessonselect.js";
import type { ContextAssembler } from "../src/memory/context.js";
import type { FindHit, LessonEngine } from "../src/memory/selection.js";
import { postingPolicyAddenda } from "../src/postingpolicy.js";
import { StateStore } from "../src/state.js";
import { buildWakeMessage } from "../src/pingpong.js";
import { runRecheck, type DeltaFile } from "../src/recheck.js";
import {
  RECHECK_TEMPLATE_FILE,
  renderRecheckPrompt,
  renderRoundPrompt,
  roundTemplateFile,
} from "../src/templates.js";
import type { RoundOrder, RoundType, SessionHooks } from "../src/types.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const ROOT = resolve(process.cwd());
const MEM = "viking://user/reviewer/memories";
const MODES: MemoryDelivery[] = ["off", "shadow", "on"];
/** A PR number no other test uses: dispatch writes this PR's task files under
 * the sandbox's state/ dir, removed after the file. */
const PR = 987_654;

function cfgFor(mode: MemoryDelivery): Config {
  const cfg = parseConfig(readFileSync(join(ROOT, "tests/fixtures/config.toml"), "utf8"));
  cfg.memory.delivery = mode;
  cfg.review.task_files = true;
  return cfg;
}

/** An engine with a lesson for every lens and a case for every file — so the
 * selection has something to select, and a leak would show. */
const engine: LessonEngine = {
  root: () => MEM,
  async find(area): Promise<{ ok: true; hits: FindHit[] }> {
    if (area === "experiences")
      return {
        ok: true,
        hits: [
          {
            uri: `${MEM}/experiences/20261001T000000-dr.md`,
            score: 0.8,
            text: "#lesson kind=dont-raise lens=pass-baseline,pass-validate class=baseline.scope paths=** evidence=pr:1\nDo not raise pre-existing scope.",
          },
          {
            uri: `${MEM}/experiences/20261001T000000-lf.md`,
            score: 0.7,
            text: "#lesson kind=look-for lens=pass-baseline class=missed.backend paths=backend/** evidence=pr:2\nLook for missing tenant filters.",
          },
        ],
      };
    return {
      ok: true,
      hits: [
        {
          uri: `${MEM}/finding-cases/case-1-r1-aaaa.md`,
          score: 0.6,
          text: "#case kind=case case=1-r1-aaaa pr=1 round=1 rounds=1 lens=pass-baseline path=backend/api/views.py fate=fixed replies=2\nA finding…",
        },
      ],
    };
  },
  retiredUris: async () => [],
};

const assembler: ContextAssembler = {
  pinnedHead: async () => ({ status: "read", text: "Standing: never re-approve." }),
  contextBlock: async () => ({ status: "read", text: "PR #5100 settled the limiter key." }),
};

class Adapter implements DispatchAdapter {
  async listPrFiles(): Promise<PrFileEntry[]> {
    return [
      { filename: "backend/api/views.py", additions: 40, deletions: 3, status: "modified" },
      { filename: "docs/guide.md", additions: 12, deletions: 0, status: "modified" },
    ];
  }
  async getPr(): Promise<{ base_ref: string; body?: string }> {
    return {
      base_ref: "master",
      body: "Adds tenant scoping to the views API and documents it in the guide.",
    };
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

interface Rendered {
  prompt: string;
  order: string;
  tasks: Array<{ path: string; text: string }>;
  selected: number;
}

async function renderRound(mode: MemoryDelivery, type: RoundType): Promise<Rendered> {
  const cfg = cfgFor(mode);
  const store = new StateStore(":memory:");
  try {
    if (type !== "first") {
      const r = store.startRound(PR, "first", ["pass-baseline"], 45);
      store.finishRound(r, "REQUEST_CHANGES", null);
    }
    store.upsertPr({
      number: PR,
      state: "queued",
      head_sha: `head-${type}`,
      title: "Scope the views API by tenant",
      author: "alice",
      trigger_ts: "2026-10-07T09:00:00Z",
      trigger_provenance: null,
      stale_recheck: type === "staleness" ? 1 : 0,
      migration_gate: 0,
    });
    const ledger = new LessonLedger(store);
    const selector = new RoundLessonSelector({
      ledger,
      mode: () => cfg.memory.delivery,
      engine: () => engine,
      budgetMs: cfg.memory.delivery_budget_ms,
    });
    const prompts: string[] = [];
    const hooks: SessionHooks = {
      async dispatchRound(_o, prompt) {
        prompts.push(prompt);
      },
      async inject() {},
      async injectOverseer() {},
      async archiveAndClose() {},
    };
    const eco = ecosystemFor("django");
    const identity = identityVars(cfg);
    const orders = await dispatchOnce({
      cfg,
      store,
      adapter: new Adapter(),
      hooks,
      ecosystem: eco,
      // The production renderer (wire.ts): the round type's template.
      renderPrompt: (o: RoundOrder, memory) =>
        renderRoundPrompt(
          readFileSync(join(ROOT, "prompts", roundTemplateFile(o.round_type)), "utf8"),
          o,
          memory,
          cfg.owner.name,
          eco,
          identity,
        ),
      memory: { assembler, timeoutMs: 3000 },
      lessons: selector,
      now: () => new Date("2026-10-07T10:00:00Z"),
    });
    await selector.idle();
    expect(orders).toHaveLength(1);
    const order = orders[0]!;
    expect(order.round_type).toBe(type);
    const selected = ledger
      .selections(order.round_id)
      .reduce((n, s) => n + s.lessons.length + s.cases.length, 0);
    return {
      prompt: prompts[0]!,
      order: JSON.stringify(order),
      tasks: (order.pass_task_files ?? []).map((t) => ({
        path: t.path,
        text: readFileSync(t.path, "utf8"),
      })),
      selected,
    };
  } finally {
    store.close();
  }
}

afterAll(() => {
  for (const name of readdirSync(join(sandboxRoot(), "state"), { withFileTypes: true }))
    if (name.name.startsWith(`pr-${PR}-`))
      rmSync(join(sandboxRoot(), "state", name.name), { recursive: true, force: true });
});

describe("byte-identity under every value of [memory] delivery", () => {
  for (const type of ["first", "re-review", "staleness"] as RoundType[]) {
    it(
      `the ${type} round's prompt, order and task files are the same under off, shadow and on`,
      { timeout: HEAVY_TIMEOUT_MS },
      async () => {
        const out: Partial<Record<MemoryDelivery, Rendered>> = {};
        for (const mode of MODES) out[mode] = await renderRound(mode, type);
        const off = out.off!;
        // The selection really ran, and really found lessons and cases, where
        // the switch says it runs — and nothing under `off`.
        expect(off.selected).toBe(0);
        expect(out.shadow!.selected).toBeGreaterThan(0);
        expect(out.on!.selected).toBeGreaterThan(0);
        expect(off.tasks.length).toBeGreaterThan(0);
        for (const mode of ["shadow", "on"] as const) {
          expect(out[mode]!.prompt, `${type} prompt under ${mode}`).toBe(off.prompt);
          expect(out[mode]!.order, `${type} order under ${mode}`).toBe(off.order);
          expect(out[mode]!.tasks, `${type} task files under ${mode}`).toEqual(off.tasks);
        }
        // No lesson text reached anything a session reads.
        for (const r of Object.values(out)) {
          expect(r!.prompt).not.toContain("pre-existing scope");
          expect(r!.prompt).not.toContain("tenant filters");
          for (const t of r!.tasks)
            expect(t.text).not.toMatch(/Lessons from this repo|tenant filters/);
        }
      },
    );
  }

  it(
    "the recheck prompt (the production renderer, through runRecheck) and the ping-pong wake are the same under every value",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      // S9b gives these two the repo-fact lessons for the touched paths under
      // `on`; until then — and under `shadow` forever — not one byte moves.
      const OLD = "1".repeat(40);
      const HEAD = "2".repeat(40);
      const delta: DeltaFile[] = [
        {
          filename: "backend/api/views.py",
          additions: 3,
          deletions: 1,
          status: "modified",
          patch: "@@\n-a()\n+b()",
        },
      ];
      const recheck: string[] = [];
      const wakes: string[] = [];
      for (const mode of MODES) {
        const cfg = cfgFor(mode);
        const store = new StateStore(":memory:");
        try {
          store.upsertPr({
            number: PR,
            state: "tracked",
            head_sha: HEAD,
            title: "Scope the views API by tenant",
            author: "alice",
            trigger_ts: null,
            stale_recheck: 0,
            migration_gate: 0,
          });
          store.recordReviewedHead(PR, { head_sha: OLD, verdict: "APPROVE", round_no: 1 });
          const identity = identityVars(cfg);
          const injected: string[] = [];
          const outcome = await runRecheck(
            {
              cfg,
              store,
              adapter: {
                getPr: async () => ({
                  base_ref: "master",
                  head_sha: HEAD,
                  state: "open",
                  merged: false,
                }),
                listPrFiles: async () => delta,
                compareFiles: async () => delta,
              },
              inject: async (_pr, message) => {
                injected.push(message);
              },
              // The production renderer (wire.ts `renderRecheck`).
              renderPrompt: (o) =>
                renderRecheckPrompt(
                  readFileSync(join(ROOT, "prompts", RECHECK_TEMPLATE_FILE), "utf8"),
                  o,
                  identity,
                ),
              worktreeFor: (n) => `wt/pr-${n}`,
              now: () => new Date("2026-10-07T10:00:00Z"),
              log: () => {},
            },
            { pr: PR, trigger: "push", head_sha: HEAD },
          );
          expect(outcome, mode).toMatchObject({ action: "recheck", delivered: "injected" });
          expect(injected).toHaveLength(1);
          recheck.push(injected[0]!);
        } finally {
          store.close();
        }
        // The ping-pong wake, as daemon.ts builds it for an author reply.
        wakes.push(
          buildWakeMessage(
            {
              pr: PR,
              comment_id: 77,
              in_reply_to_id: 70,
              body: "This scope check is intentional — see the guide.",
              author: "alice",
            },
            { head_sha: HEAD, worktree: `wt/pr-${PR}` },
            { allowed: true, final: false, exchanges: 1 },
          ),
        );
      }
      expect(recheck[0]).toContain("backend/api/views.py");
      for (const i of [1, 2]) {
        expect(recheck[i], `recheck under ${MODES[i]}`).toBe(recheck[0]);
        expect(wakes[i], `ping-pong under ${MODES[i]}`).toBe(wakes[0]);
      }
      for (const text of [...recheck, ...wakes])
        expect(text).not.toMatch(/pre-existing scope|tenant filters|Lessons from this repo/);
    },
  );

  it(
    "the built agents are the same under off, shadow and on",
    { timeout: HEAVY_TIMEOUT_MS },
    () => {
      const tmp = mkdtempSync(join(tmpdir(), "qcr-lesson-agents-"));
      try {
        const builds = MODES.map((mode) => {
          const cfg = cfgFor(mode);
          const out = join(tmp, mode);
          // The production composition (wire.ts), minus the same-day feedback
          // addendum (no feedback in this fixture).
          buildAgents(join(ROOT, "agents"), out, {
            root: ROOT,
            tiers: cfg.models.tiers,
            riskPasses: cfg.models.risk_passes,
            validateTier: cfg.models.validate_tier,
            vars: identityVars(cfg),
            ecosystem: "django",
            models: passTierModels(
              cfg.models.pass_tiers,
              cfg.models.tiers,
              lensModelOverrides(cfg.models, cfg.lenses),
            ),
            addenda: [
              ...PASS_ADDENDA,
              ...configAddenda(cfg.review),
              ...lensTuningAddenda(cfg.lenses),
              ...postingPolicyAddenda(cfg.posting),
            ],
          });
          const files = readdirSync(out).sort();
          return new Map(files.map((f) => [f, readFileSync(join(out, f), "utf8")]));
        });
        expect(builds[0]!.size).toBeGreaterThan(5);
        expect([...builds[1]!.entries()]).toEqual([...builds[0]!.entries()]);
        expect([...builds[2]!.entries()]).toEqual([...builds[0]!.entries()]);
        // No lesson addendum exists yet (S9b composes one BESIDE the feedback one).
        expect(PASS_ADDENDA.map((a) => a.id).filter((id) => /lesson/i.test(id))).toEqual([]);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  );

  it(
    "the bench's round (system prompt, order, task files) and its fingerprint are the same under every value",
    { timeout: HEAVY_TIMEOUT_MS },
    () => {
      const SMOKE = JSON.parse(
        readFileSync(join(ROOT, "bench", "aacr", "sets", "smoke10.json"), "utf8"),
      );
      const c = parseCaseSet(SMOKE).cases[0]!;
      const meta: PrefetchMeta = {
        instance_id: c.instance_id,
        repo: c.repo,
        pr: c.pr,
        base_commit: c.base_commit,
        head_commit: c.head_commit,
        merge_base: "c".repeat(40),
        base_ref: "master",
        base_ref_source: "github-api",
        title: "Enforce all pyflake lint rules",
        body: "A body long enough to be a body.",
        depth: 50,
        diff: { files: 2, additions: 60, deletions: 5 },
        fetched_at: "2026-09-25T00:00:00Z",
      };
      const files = [
        { filename: "comfy/model.py", additions: 40, deletions: 5, status: "modified" },
        { filename: "tests/test_model.py", additions: 20, deletions: 0, status: "added" },
      ];
      const renders = MODES.map((mode) => {
        const cfg = cfgFor(mode);
        cfg.review.profile = "";
        return {
          r: renderCasePrompts({
            root: ROOT,
            cfg,
            ecosystem: ecosystemFor("none"),
            c,
            meta,
            tree: "/opt/quickreview/sandbox/wt/x",
            caseDir: "/bench-out/cases/x",
            files,
            issuedAt: "2026-09-25T00:00:00Z",
          }),
          fp: runFingerprint(cfg, ""),
        };
      });
      for (const x of renders.slice(1)) {
        expect(x.r.system).toBe(renders[0]!.r.system);
        expect(x.r.order).toBe(renders[0]!.r.order);
        expect(x.r.taskFiles).toEqual(renders[0]!.r.taskFiles);
        expect(x.fp).toEqual(renders[0]!.fp);
      }
    },
  );
});
