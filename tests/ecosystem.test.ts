// The ecosystem pre-check seam.
//
// Django behind the seam renders its round-prompt prose (the migration gate
// and the degraded pre-check note) byte-for-byte as pinned below, and its
// pre-check behaves unchanged (the regression net in
// migration-precheck.test.ts runs against the seam's default); `none` is a
// first-class configured-off, structurally distinct from a degraded Django
// check. The invariant this file guards for the Django case: migration
// renumber posts as a COMMENT, never a blocker — and the check gets more
// reliable, never quieter.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parseConfig, type Config } from "../src/config.js";
import { dispatchOnce, buildPassPlan, type DispatchAdapter } from "../src/dispatch.js";
import {
  DJANGO_ECOSYSTEM,
  NONE_ECOSYSTEM,
  ecosystemFor,
  type EcosystemPreCheckIo,
} from "../src/ecosystem.js";
import type { GateResult } from "../src/gate.js";
import type { PrFileEntry } from "../src/github.js";
import { AnomalyWakePolicy } from "../src/anomalies.js";
import { loadProfileEcosystem } from "../src/profiles.js";
import { StateStore } from "../src/state.js";
import { renderRoundPrompt, roundVars } from "../src/templates.js";
import type { RoundOrder, SessionHooks } from "../src/types.js";
import { stageFixtureProfile } from "./helpers/tracked-profiles.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const cfg: Config = parseConfig(
  readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8"),
);

// ---- byte-identity fixtures -------------------------------------------------
// The Django prompt prose, captured verbatim. These literals are the proof:
// if the seam ever renders different bytes for the Django case, this file —
// not the seam — is the record of what the prompt says.
const EXPECTED_GATE_ON =
  "MIGRATION GATE: this PR touches migrations — pass-data-safety must judge the ORM operations and any supplied generated SQL for destructive mutation, concrete rebuild/locking risk, backfill safety, and rolling-deploy ordering. Ordinary Django ORM operations are acceptable and must not be rewritten as handwritten SQL merely for reviewability. Only a concrete migration hazard blocks; missing generated SQL or an unproven database algorithm does not.";
const EXPECTED_GATE_OFF = "no migration gate on this round";
const EXPECTED_DEGRADED_NOTE = [
  "",
  "",
  "MIGRATION PRE-CHECK DID NOT RUN — CHECK COLLISIONS YOURSELF. The daemon",
  "normally checks this PR's migration numbers against the base branch before",
  "each round and posts the renumber remedy itself as a COMMENT. This round the",
  "migration pre-check did not run (the base branch facts were unavailable or",
  "the base read failed), so nothing has been checked and nothing has been",
  "posted. YOU must check base-branch migration-number collisions yourself this",
  "round: compare every migration this PR adds against the base branch's",
  "migrations, and report a number the base already occupies as a normal",
  "finding — with the remedy (the free target number and the exact",
  "`dependencies` entry) stated. This lifts, for this round only, the standing",
  "rule that base-branch numbering collisions are handled daemon-side.",
].join("\n");

const order: RoundOrder = {
  pr: 412,
  title: "Add rate limiting",
  round_id: 7,
  round_no: 2,
  round_type: "re-review",
  lenses: ["pass-baseline", "pass-validate"],
  pass_plan: [
    {
      lens: "pass-baseline",
      agent: "pass-baseline--sol-med",
      tier: "sol-med",
      raisable_to: ["pass-baseline--sol-high"],
    },
    { lens: "pass-validate", agent: "pass-validate--sol-high", tier: "sol-high", raisable_to: [] },
  ],
  addable_lenses: ["pass-ui"],
  migration_gate: true,
  head_sha: "deadbeef",
  base_ref: "master",
  base_sha: "basetip",
  merge_base: "forkpoint",
  worktree: "/sandbox/wt/pr-412",
  settled_digest: "T1: author fixed at abc123",
  issued_at: "2026-08-13T10:00:00Z",
};

const collision = {
  app: "backend/chat",
  app_label: "chat",
  pr_path: "backend/chat/migrations/0042_x.py",
  number: 42,
  base_path: "backend/chat/migrations/0042_add_widget_flag.py",
  target_number: 43,
  target_path: "backend/chat/migrations/0043_x.py",
  dependency_name: "0042_add_widget_flag",
  dependency: '("chat", "0042_add_widget_flag")',
  kind: "base-collision" as const,
};

/** Every method throws: proof that NONE_ECOSYSTEM's preCheck touches nothing. */
function untouchableIo(): EcosystemPreCheckIo {
  const boom = (what: string) => (): never => {
    throw new Error(`configured-off preCheck touched ${what}`);
  };
  return {
    logEvent: boom("logEvent"),
    migrationCollisionCommented: boom("migrationCollisionCommented"),
    createReview: boom("createReview") as unknown as EcosystemPreCheckIo["createReview"],
    listBaseMigrations: boom("listBaseMigrations") as unknown as (s: string) => Promise<string[]>,
    log: boom("log"),
  };
}

const round = {
  pr: 9,
  files: [{ filename: "backend/chat/migrations/0042_x.py" }],
  head_sha: "headsha",
  base_ref: "master",
  base_sha: "basesha",
};

describe("the seam's two implementations", () => {
  it("none: preCheck answers off and performs NO I/O at all", async () => {
    await expect(NONE_ECOSYSTEM.preCheck(untouchableIo(), round)).resolves.toEqual({
      status: "off",
    });
  });

  it("none: the tier-forcing migration gate never fires, even on migrations paths", () => {
    expect(
      NONE_ECOSYSTEM.migrationGate([
        { filename: "app/migrations/0007_x.py", additions: 5, deletions: 0 },
      ]),
    ).toBe(false);
  });

  it("none: no migration-gate prose in any state — gate on/off, degraded, collisions", () => {
    expect(NONE_ECOSYSTEM.gateNote({ migration_gate: true })).toBe("");
    expect(NONE_ECOSYSTEM.gateNote({ migration_gate: false })).toBe("");
    expect(
      NONE_ECOSYSTEM.gateNote({ migration_gate: true, migration_precheck_degraded: true }),
    ).toBe("");
    expect(
      NONE_ECOSYSTEM.gateNote({ migration_gate: true, migration_collisions: [collision] }),
    ).toBe("");
  });

  it("django: gate fires on migrations paths (today's heuristic)", () => {
    expect(
      DJANGO_ECOSYSTEM.migrationGate([
        { filename: "app/migrations/0007_x.py", additions: 5, deletions: 0 },
      ]),
    ).toBe(true);
    expect(
      DJANGO_ECOSYSTEM.migrationGate([{ filename: "src/models.py", additions: 5, deletions: 0 }]),
    ).toBe(false);
  });

  // The off/degraded distinction IS the outcome union: the same "cannot read
  // the base" situation is `degraded` for Django (never quieter — the caller
  // raises the anomaly and un-muzzles the lens) and `off` for none (silence
  // by configuration). One boolean could not say both.
  it("off and degraded are different answers to the same situation", async () => {
    const events: string[] = [];
    const io: EcosystemPreCheckIo = {
      logEvent: (kind) => {
        events.push(kind);
      },
      migrationCollisionCommented: () => "not_commented",
      createReview: async () => ({ ok: true }) as unknown as GateResult,
      // no listBaseMigrations — the base is unreadable
    };
    await expect(DJANGO_ECOSYSTEM.preCheck(io, round)).resolves.toEqual({ status: "degraded" });
    expect(events).toEqual(["migration_precheck_skipped"]);
    await expect(NONE_ECOSYSTEM.preCheck(untouchableIo(), round)).resolves.toEqual({
      status: "off",
    });
  });

  it("django: a PR with no migrations and no base reader is checked-empty, not degraded", async () => {
    const io: EcosystemPreCheckIo = {
      logEvent: () => {},
      migrationCollisionCommented: () => "not_commented",
      createReview: async () => ({ ok: true }) as unknown as GateResult,
    };
    await expect(
      DJANGO_ECOSYSTEM.preCheck(io, { ...round, files: [{ filename: "src/views.py" }] }),
    ).resolves.toEqual({ status: "checked", collisions: [] });
  });

  // The dedupe's third answer. A comment row the ledger cannot read
  // means a comment WAS posted at a fingerprint nobody can recover, so posting
  // again risks the exact duplicate the read exists to prevent. The COMMENT is
  // withheld, loudly, and the check still counts as RUN: the collisions ride
  // the round order into the gate note, so the session still hears them.
  it("django: an unreadable comment row WITHHOLDS the comment — no gated write, and the check still ran", async () => {
    const events: Array<{ kind: string; payload: unknown }> = [];
    let posted = 0;
    const io: EcosystemPreCheckIo = {
      logEvent: (kind, _pr, payload) => {
        events.push({ kind, payload });
      },
      migrationCollisionCommented: () => "unknown",
      createReview: async () => {
        posted += 1;
        return { ok: true } as unknown as GateResult;
      },
      listBaseMigrations: async () => ["backend/chat/migrations/0042_add_widget_flag.py"],
    };
    const outcome = await DJANGO_ECOSYSTEM.preCheck(io, round);
    expect(posted).toBe(0);
    expect(outcome.status).toBe("checked");
    expect(outcome.status === "checked" ? outcome.collisions : []).toHaveLength(1);
    expect(events.map((e) => e.kind)).toEqual([
      "migration_collision_detected",
      "migration_collision_comment_withheld",
    ]);
    expect(events[1]!.payload).toMatchObject({
      fingerprint: expect.any(String),
      reason: "unreadable_comment_row",
    });
  });

  it("ecosystemFor maps names to the two implementations", () => {
    expect(ecosystemFor("django")).toBe(DJANGO_ECOSYSTEM);
    expect(ecosystemFor("none")).toBe(NONE_ECOSYSTEM);
  });
});

describe("migration-gate prose byte-identity (django)", () => {
  it("renders the original Django GATE_ON bytes exactly", () => {
    expect(DJANGO_ECOSYSTEM.gateNote({ migration_gate: true })).toBe(EXPECTED_GATE_ON);
    expect(roundVars(order).migration_gate_note).toBe(EXPECTED_GATE_ON);
  });

  it("renders the original Django GATE_OFF bytes exactly", () => {
    expect(DJANGO_ECOSYSTEM.gateNote({ migration_gate: false })).toBe(EXPECTED_GATE_OFF);
    expect(roundVars({ ...order, migration_gate: false }).migration_gate_note).toBe(
      EXPECTED_GATE_OFF,
    );
  });

  it("renders the original Django degraded note bytes exactly (the un-muzzle key)", () => {
    expect(
      DJANGO_ECOSYSTEM.gateNote({ migration_gate: true, migration_precheck_degraded: true }),
    ).toBe(EXPECTED_GATE_ON + EXPECTED_DEGRADED_NOTE);
  });

  it("composes the collisions note after the gate line, as before", () => {
    const note = DJANGO_ECOSYSTEM.gateNote({
      migration_gate: true,
      migration_collisions: [collision],
    });
    expect(note.startsWith(EXPECTED_GATE_ON)).toBe(true);
    expect(note).toContain("MIGRATION NUMBERING — ALREADY HANDLED, DO NOT RAISE IT");
    expect(note).toContain("backend/chat/migrations/0043_x.py");
  });

  it("the templates' default ecosystem IS django: omitting the argument renders identical prompts", () => {
    const template = readFileSync(resolve(process.cwd(), "prompts/round-first.md"), "utf8");
    const explicit = renderRoundPrompt(template, order, undefined, undefined, DJANGO_ECOSYSTEM);
    const defaulted = renderRoundPrompt(template, order);
    expect(defaulted).toBe(explicit);
    expect(defaulted).toContain(EXPECTED_GATE_ON);
  });
});

describe("a none round prompt carries no migration-gate prose", () => {
  it("renders the real round template with an empty gate note", () => {
    const template = readFileSync(resolve(process.cwd(), "prompts/round-first.md"), "utf8");
    for (const o of [
      order,
      { ...order, migration_gate: false },
      { ...order, migration_precheck_degraded: true },
      { ...order, migration_collisions: [collision] },
    ]) {
      const prompt = renderRoundPrompt(template, o, undefined, undefined, NONE_ECOSYSTEM);
      expect(prompt).not.toContain("MIGRATION GATE");
      expect(prompt).not.toContain("no migration gate on this round");
      expect(prompt).not.toContain("MIGRATION PRE-CHECK DID NOT RUN");
      expect(prompt).not.toContain("ALREADY HANDLED");
      expect(roundVars(o, undefined, undefined, NONE_ECOSYSTEM).migration_gate_note).toBe("");
    }
  });
});

describe("the tier-forcing gate through the plan", () => {
  const migrationDiff = [
    { filename: "app/migrations/0007_x.py", additions: 5, deletions: 0, status: "added" },
  ];

  it("django forces sol-med on a small migrations diff; none leaves terra-med", () => {
    // The gate is a tier heuristic: run it UNPINNED (the shipped DEFAULT_PASS_TIERS
    // pin baseline at sol-high, which would mask it).
    const cfg0: Config = { ...cfg, models: { ...cfg.models, pass_tiers: {} } };
    const django = buildPassPlan(cfg0, migrationDiff, undefined, DJANGO_ECOSYSTEM);
    const none = buildPassPlan(cfg0, migrationDiff, undefined, NONE_ECOSYSTEM);
    expect(django.pass_plan.find((p) => p.lens === "pass-baseline")?.tier).toBe("sol-med");
    expect(none.pass_plan.find((p) => p.lens === "pass-baseline")?.tier).toBe("terra-med");
  });

  it("the default is django (the pre-seam behavior every historical caller means)", () => {
    expect(buildPassPlan(cfg, migrationDiff)).toEqual(
      buildPassPlan(cfg, migrationDiff, undefined, DJANGO_ECOSYSTEM),
    );
  });
});

// ---- dispatch with a none ecosystem ----------------------------------------

class RecordingAdapter implements DispatchAdapter {
  reviews: Array<{ pr: number; event: string }> = [];
  files: PrFileEntry[] = [];
  baseAsked = 0;
  async getPr(): Promise<{ base_ref: string }> {
    return { base_ref: "master" };
  }
  async listPrFiles(): Promise<PrFileEntry[]> {
    return this.files;
  }
  async addLabel(): Promise<GateResult> {
    return { ok: true } as unknown as GateResult;
  }
  async removeLabel(): Promise<GateResult> {
    return { ok: true } as unknown as GateResult;
  }
  async deleteTeamReviewRequest(): Promise<GateResult> {
    return { ok: true } as unknown as GateResult;
  }
  async createReview(n: number, payload: { event: string }): Promise<GateResult> {
    this.reviews.push({ pr: n, event: payload.event });
    return { ok: true } as unknown as GateResult;
  }
}

function hooks(orders: RoundOrder[], prompts?: string[]): SessionHooks {
  return {
    async dispatchRound(o, prompt) {
      orders.push(o);
      prompts?.push(prompt);
    },
    async inject() {},
    async injectOverseer() {},
    async archiveAndClose() {},
  };
}

let store: StateStore;
let adapter: RecordingAdapter;
let orders: RoundOrder[];

beforeEach(() => {
  store = new StateStore(":memory:");
  adapter = new RecordingAdapter();
  orders = [];
  store.upsertPr({
    number: 41,
    state: "queued",
    head_sha: "headsha",
    title: "PR 41",
    author: "alice",
    trigger_ts: "2026-08-18T09:00:00Z",
    stale_recheck: 0,
    migration_gate: 1,
  });
});

const tree = async () => ({
  head_sha: "headsha",
  base_ref: "master",
  base_sha: "basesha",
  merge_base: "mb",
});

describe("dispatch with ecosystem none — clean configured-off", () => {
  it(
    "runs no pre-check, posts nothing, logs nothing, never reads the base, and un-forces the gate",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      adapter.files = [
        {
          filename: "backend/chat/migrations/0042_x.py",
          additions: 20,
          deletions: 0,
          status: "added",
        },
      ];
      const overseer: string[] = [];
      const policy = new AnomalyWakePolicy({
        injectOverseer: async (m) => {
          overseer.push(m);
        },
      });
      store.setAnomalySink((sig) => policy.onAnomaly(sig));
      const prompts: string[] = [];
      const template = readFileSync(resolve(process.cwd(), "prompts/round-first.md"), "utf8");

      await dispatchOnce({
        cfg,
        store,
        adapter,
        hooks: hooks(orders, prompts),
        ecosystem: NONE_ECOSYSTEM,
        renderPrompt: (o) => renderRoundPrompt(template, o, undefined, undefined, NONE_ECOSYSTEM),
        prepareWorktree: tree,
        listBaseMigrations: async () => {
          adapter.baseAsked++;
          return ["backend/chat/migrations/0042_taken.py"];
        },
      });

      // The round dispatched — configured-off costs nothing.
      expect(orders).toHaveLength(1);
      // No pre-check ran: the base was never read, nothing was posted.
      expect(adapter.baseAsked).toBe(0);
      expect(adapter.reviews).toEqual([]);
      // Not degraded, no collisions, gate off — a first-class off, not a fault.
      expect(orders[0]?.migration_precheck_degraded).toBe(false);
      expect(orders[0]?.migration_collisions).toEqual([]);
      expect(orders[0]?.migration_gate).toBe(false);
      // No migration_* events, no anomaly, no overseer wake.
      const migrationEvents = store
        .recentEvents(200)
        .filter((e) => e.kind.startsWith("migration_"));
      expect(migrationEvents).toEqual([]);
      expect(store.anomalies()).toEqual([]);
      expect(overseer).toEqual([]);
      // And the prompt carries no migration-gate prose — the lens is NOT
      // un-muzzled (the addendum's withdrawal binds absent the degraded note).
      expect(prompts[0]).not.toContain("MIGRATION GATE");
      expect(prompts[0]).not.toContain("MIGRATION PRE-CHECK DID NOT RUN");
      expect(prompts[0]).not.toContain("ALREADY HANDLED");
    },
  );

  it(
    "stays silent even in the exact setup where django degrades (no base reader)",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      adapter.files = [
        {
          filename: "backend/chat/migrations/0042_x.py",
          additions: 20,
          deletions: 0,
          status: "added",
        },
      ];
      const overseer: string[] = [];
      const policy = new AnomalyWakePolicy({
        injectOverseer: async (m) => {
          overseer.push(m);
        },
      });
      store.setAnomalySink((sig) => policy.onAnomaly(sig));

      await dispatchOnce({
        cfg,
        store,
        adapter,
        hooks: hooks(orders),
        ecosystem: NONE_ECOSYSTEM,
        prepareWorktree: tree,
        // no listBaseMigrations — the django-degraded setup
      });

      expect(orders[0]?.migration_precheck_degraded).toBe(false);
      expect(store.anomalies()).toEqual([]);
      expect(overseer).toEqual([]);
      expect(store.recentEvents(200).filter((e) => e.kind.startsWith("migration_"))).toEqual([]);
    },
  );

  it(
    "an explicitly-passed django ecosystem still degrades loudly in that setup — the distinction is the wiring, not luck",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      adapter.files = [
        {
          filename: "backend/chat/migrations/0042_x.py",
          additions: 20,
          deletions: 0,
          status: "added",
        },
      ];

      await dispatchOnce({
        cfg,
        store,
        adapter,
        hooks: hooks(orders),
        ecosystem: DJANGO_ECOSYSTEM,
        prepareWorktree: tree,
        // no listBaseMigrations
      });

      expect(orders[0]?.migration_precheck_degraded).toBe(true);
      expect(orders[0]?.migration_gate).toBe(true);
      expect(store.anomalies().map((a) => a.kind)).toEqual(["migration_precheck_degraded"]);
    },
  );
});

// ---- profile selection ------------------------------------------------------

describe("loadProfileEcosystem", () => {
  const repoRoot = process.cwd();

  it("reads the shipped profiles: quickchat and example-django are django, minimal is none", () => {
    // The quickchat pack's frozen fixture copy; dropped from the
    // assembled snapshots, where this expectation does not apply.
    if (stageFixtureProfile(repoRoot, "quickchat")) {
      expect(loadProfileEcosystem(repoRoot, "quickchat")).toBe("django");
    }
    expect(loadProfileEcosystem(repoRoot, "example-django")).toBe("django");
    expect(loadProfileEcosystem(repoRoot, "minimal")).toBe("none");
  });

  it('no profile selected ("") means none', () => {
    expect(loadProfileEcosystem(repoRoot, "")).toBe("none");
  });

  it("an absent profile.toml or absent ecosystem key means none", () => {
    const root = mkdtempSync(join(tmpdir(), "qcr-eco-"));
    mkdirSync(join(root, "profiles", "bare"), { recursive: true });
    expect(
      loadProfileEcosystem(root, "bare", {
        env: { QCR_CONFIG: join(root, "config.toml"), HOME: root },
      }),
    ).toBe("none"); // no file at all
    writeFileSync(join(root, "profiles", "bare", "profile.toml"), "# no ecosystem key\n");
    expect(
      loadProfileEcosystem(root, "bare", {
        env: { QCR_CONFIG: join(root, "config.toml"), HOME: root },
      }),
    ).toBe("none"); // file, no key
    expect(
      loadProfileEcosystem(root, "missing-profile-dir", {
        env: { QCR_CONFIG: join(root, "config.toml"), HOME: root },
      }),
    ).toBe("none");
  });

  it("an unknown ecosystem value fails the boot loudly", () => {
    const root = mkdtempSync(join(tmpdir(), "qcr-eco-"));
    mkdirSync(join(root, "profiles", "p"), { recursive: true });
    writeFileSync(join(root, "profiles", "p", "profile.toml"), 'ecosystem = "rails"\n');
    expect(() =>
      loadProfileEcosystem(root, "p", {
        env: { QCR_CONFIG: join(root, "config.toml"), HOME: root },
      }),
    ).toThrow(/unknown ecosystem "rails"/);
  });

  it("invalid TOML fails the boot loudly, never a silent none", () => {
    const root = mkdtempSync(join(tmpdir(), "qcr-eco-"));
    mkdirSync(join(root, "profiles", "p"), { recursive: true });
    writeFileSync(join(root, "profiles", "p", "profile.toml"), "ecosystem = [broken\n");
    expect(() =>
      loadProfileEcosystem(root, "p", {
        env: { QCR_CONFIG: join(root, "config.toml"), HOME: root },
      }),
    ).toThrow(/not valid TOML/);
  });
});
