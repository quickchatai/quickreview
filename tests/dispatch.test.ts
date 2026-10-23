import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseConfig, sandboxRoot, type Config } from "../src/config.js";
import {
  ALL_PASSES,
  buildPassPlan,
  capacity,
  dispatchOnce as realDispatchOnce,
  queuedInOrder,
  roundTypeFor,
  validatorTier,
  type DispatchAdapter,
} from "../src/dispatch.js";
import type { GateResult } from "../src/gate.js";
import type { PrFileEntry } from "../src/github.js";
import { fingerprintRoundIntegrity } from "../src/execboundary.js";
import { recheckFingerprint } from "../src/recheck.js";
import { StateStore } from "../src/state.js";
import { applyEvent } from "../src/statemachine.js";
import { PASS_TIER_ORDER } from "../src/types.js";
import { renderRoundPrompt, roundTemplateFile } from "../src/templates.js";
import type { RoundOrder, SessionHooks } from "../src/types.js";
import type { ContextAssembler, MemoryRead, RoundMemory } from "../src/memory/context.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

// Every dispatch hashes the whole policy surface for the round's integrity
// baseline (hundreds of files, a loop turn each). Only the tests about that
// baseline need the real hash; the rest get a constant one.
const STUB_BASELINE = { digest: "stub", files: {} } as unknown as Awaited<
  ReturnType<typeof fingerprintRoundIntegrity>
>;
function dispatchOnce(
  deps: Parameters<typeof realDispatchOnce>[0],
  ...rest: unknown[]
): ReturnType<typeof realDispatchOnce> {
  return (realDispatchOnce as (...a: unknown[]) => ReturnType<typeof realDispatchOnce>)(
    { integrityFingerprint: async () => STUB_BASELINE, ...deps },
    ...rest,
  );
}

const baseCfg: Config = parseConfig(
  readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8"),
);

interface Call {
  fn: string;
  pr: number;
  arg?: string;
}

class FakeAdapter implements DispatchAdapter {
  calls: Call[] = [];
  files = new Map<number, PrFileEntry[]>();
  failLabelOn = new Set<number>();
  goneLabelOn = new Set<number>();
  /** PR → base branch; absent means "master". Set to throw via failGetPrOn. */
  baseRefs = new Map<number, string>();
  failGetPrOn = new Set<number>();
  /** `${base}..${head}` → delta files. Absent range ⇒ empty delta. */
  compares = new Map<string, PrFileEntry[]>();
  failCompare = false;

  async compareFiles(base: string, head: string): Promise<PrFileEntry[]> {
    this.calls.push({ fn: "compareFiles", pr: 0, arg: `${base}..${head}` });
    if (this.failCompare) throw new Error("compare boom");
    return this.compares.get(`${base}..${head}`) ?? [];
  }

  async getPr(n: number): Promise<{ base_ref: string }> {
    this.calls.push({ fn: "getPr", pr: n });
    if (this.failGetPrOn.has(n)) throw new Error("500 boom");
    return { base_ref: this.baseRefs.get(n) ?? "master" };
  }
  async listPrFiles(n: number): Promise<PrFileEntry[]> {
    this.calls.push({ fn: "listPrFiles", pr: n });
    return this.files.get(n) ?? [];
  }
  async addLabel(n: number, label: string): Promise<GateResult> {
    this.calls.push({ fn: "addLabel", pr: n, arg: label });
    return { executed: false, dryRunFile: "x" };
  }
  async removeLabel(n: number, label: string): Promise<GateResult> {
    this.calls.push({ fn: "removeLabel", pr: n, arg: label });
    if (this.failLabelOn.has(n)) throw new Error("404 label not present");
    if (this.goneLabelOn.has(n))
      throw new Error(
        `DELETE /repos/o/r/issues/${n}/labels/AI%20review%20requested → 404: {"message":"Label does not exist","status":"404"}`,
      );
    return { executed: false, dryRunFile: "x" };
  }
  async deleteTeamReviewRequest(n: number): Promise<GateResult> {
    this.calls.push({ fn: "deleteTeamReviewRequest", pr: n });
    return { executed: false, dryRunFile: "x" };
  }
  async createReview(n: number, payload: { event: string; body: string }): Promise<GateResult> {
    this.calls.push({ fn: "createReview", pr: n, arg: payload.event });
    return { executed: false, dryRunFile: "x" };
  }
}

function recordingHooks(): {
  hooks: SessionHooks;
  orders: Array<{ order: RoundOrder; prompt: string }>;
} {
  const orders: Array<{ order: RoundOrder; prompt: string }> = [];
  return {
    orders,
    hooks: {
      async dispatchRound(order, prompt) {
        orders.push({ order, prompt });
      },
      async inject() {},
      async archiveAndClose() {},
    },
  };
}

function file(filename: string, additions = 10, deletions = 0): PrFileEntry {
  return { filename, additions, deletions, status: "modified" };
}

let store: StateStore;
let adapter: FakeAdapter;

beforeEach(() => {
  store = new StateStore(":memory:");
  adapter = new FakeAdapter();
});

function queue(
  pr: number,
  triggerTs: string | null,
  over: Partial<{ title: string; head: string; provenance: "human" | "system" | null }> = {},
): void {
  store.upsertPr({
    number: pr,
    state: "queued",
    head_sha: over.head ?? `sha${pr}`,
    title: over.title ?? `PR ${pr}`,
    author: "alice",
    trigger_ts: triggerTs,
    trigger_provenance: over.provenance ?? null,
    stale_recheck: 0,
    migration_gate: 0,
  });
}

describe("queue ordering and capacity", () => {
  it(
    "is FIFO by trigger_ts, nulls last, PR number as tiebreak",
    { timeout: HEAVY_TIMEOUT_MS },
    () => {
      queue(3, "2026-08-13T10:00:00Z");
      queue(1, "2026-08-13T09:00:00Z");
      queue(2, null);
      queue(4, "2026-08-13T09:00:00Z");
      expect(queuedInOrder(store).map((p) => p.number)).toEqual([1, 4, 3, 2]);
    },
  );

  it("skips overseer-paused PRs entirely", () => {
    queue(1, "2026-08-13T09:00:00Z");
    queue(2, "2026-08-13T10:00:00Z");
    store.pausePr(1, { issuer: "operator", expires_at: null }, "test");
    expect(queuedInOrder(store).map((p) => p.number)).toEqual([2]);
    store.resumePr(1, "operator");
    expect(queuedInOrder(store).map((p) => p.number)).toEqual([1, 2]);
  });

  it("counts running rounds against max_concurrent_rounds", () => {
    const cap = baseCfg.daemon.max_concurrent_rounds;
    expect(capacity(store, baseCfg)).toBe(cap);
    for (let i = 0; i < cap; i++) store.startRound(100 + i, "first", ["pass-baseline"], 45);
    expect(capacity(store, baseCfg)).toBe(0);
  });
});

describe("the pump spends a slot only on a round that went running", () => {
  const oneSlot: Config = {
    ...baseCfg,
    daemon: { ...baseCfg.daemon, max_concurrent_rounds: 1 },
  };
  class FailingFiles extends FakeAdapter {
    failFilesOn = new Set<number>();
    onFiles: ((n: number) => void) | undefined;
    override async listPrFiles(n: number): Promise<PrFileEntry[]> {
      this.onFiles?.(n);
      if (this.failFilesOn.has(n)) throw new Error("files API 502");
      return super.listPrFiles(n);
    }
  }

  // MUTATION: slice the queue to `slots` before processing — the failing
  // oldest PR takes the only slot on every tick and the next never runs.
  it(
    "a PR that fails before its handoff does not starve the next one",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(201, "2026-08-13T09:00:00Z");
      queue(202, "2026-08-13T10:00:00Z");
      const failing = new FailingFiles();
      failing.failFilesOn.add(201);
      const { hooks, orders } = recordingHooks();

      await dispatchOnce({ cfg: oneSlot, store, adapter: failing, hooks });

      expect(orders.map((o) => o.order.pr)).toEqual([202]);
      expect(store.getPr(201)?.state).toBe("queued");
    },
  );

  // MUTATION: skip running PRs after the slice — the running one takes the
  // free slot and the PR behind it waits for its round to end.
  it(
    "a queued PR whose round is still running takes no slot from the PR behind it",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const twoSlots: Config = {
        ...baseCfg,
        daemon: { ...baseCfg.daemon, max_concurrent_rounds: 2 },
      };
      queue(203, "2026-08-13T09:00:00Z");
      store.startRound(203, "first", ["pass-baseline"], 45);
      queue(204, "2026-08-13T10:00:00Z");
      const { hooks, orders } = recordingHooks();

      await dispatchOnce({ cfg: twoSlots, store, adapter, hooks });

      expect(orders.map((o) => o.order.pr)).toEqual([204]);
    },
  );

  // MUTATION: drop the per-PR re-read — a drain engaged, or a PR closed,
  // while the pump prepared the PR before it still gets a round.
  it(
    "eligibility is read again when each PR's work starts: a drain or a close stops what comes after",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const threeSlots: Config = {
        ...baseCfg,
        daemon: { ...baseCfg.daemon, max_concurrent_rounds: 3 },
      };
      queue(205, "2026-08-13T09:00:00Z");
      queue(206, "2026-08-13T10:00:00Z");
      queue(207, "2026-08-13T11:00:00Z");
      const racing = new FailingFiles();
      racing.onFiles = (n) => {
        if (n === 205) store.setPrState(206, "closed");
      };
      const { hooks, orders } = recordingHooks();

      await dispatchOnce({ cfg: threeSlots, store, adapter: racing, hooks });
      expect(orders.map((o) => o.order.pr)).toEqual([205, 207]);
      expect(store.getPr(206)?.state).toBe("closed");

      for (const r of store.runningRounds()) store.finishRound(r.id, "APPROVE", null);
      queue(208, "2026-08-13T12:00:00Z");
      queue(209, "2026-08-13T13:00:00Z");
      racing.onFiles = (n) => {
        if (n === 208) store.engageDrain({ issuer: "operator", expires_at: null });
      };
      orders.length = 0;
      await dispatchOnce({ cfg: threeSlots, store, adapter: racing, hooks });
      expect(orders.map((o) => o.order.pr)).toEqual([208]);
      expect(store.getPr(209)?.state).toBe("queued");
    },
  );
});

describe("the round's context pack", () => {
  // MUTATION: only log when the pack write fails — the earlier attempt's pack
  // stays beside the task files, and every child reads it as this round's.
  it(
    "a pack that cannot be written leaves no earlier attempt's pack behind",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const cfg: Config = {
        ...baseCfg,
        review: { ...baseCfg.review, task_files: true, context_pack: "pack-first" },
        engine: { ...baseCfg.engine, lens_cache_group: 1 },
      };
      const passesDir = join(sandboxRoot(), "state", "pr-9301-round-1-passes");
      const packPath = join(passesDir, "context-pack.md");
      try {
        mkdirSync(passesDir, { recursive: true });
        writeFileSync(packPath, "STALE PACK from an earlier attempt");
        // The write's temp path is taken: the pack cannot be written.
        mkdirSync(`${packPath}.tmp`, { recursive: true });
        queue(9301, "2026-08-13T09:00:00Z");
        adapter.files.set(9301, [file("a.py")]);
        const { hooks, orders } = recordingHooks();

        await dispatchOnce({ cfg, store, adapter, hooks });

        expect(orders).toHaveLength(1);
        expect(orders[0]!.order.context_pack_file).toBeUndefined();
        expect(existsSync(packPath)).toBe(false);
      } finally {
        rmSync(passesDir, { recursive: true, force: true });
      }
    },
  );
});

describe("the context pack reads the worktree the round reviews", () => {
  // MUTATION: hand readWorktreeFileForPack the worktree as configured
  // (relative) — read against the process's cwd, every file is missing and
  // the pack carries none of their text.
  it(
    "resolves a relative worktree against the sandbox root, not the process's cwd",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const cfg: Config = {
        ...baseCfg,
        review: { ...baseCfg.review, task_files: true, context_pack: "pack-first" },
        engine: { ...baseCfg.engine, lens_cache_group: 1 },
      };
      const rel = "state/test-wt-pr-9302";
      const tree = join(sandboxRoot(), rel);
      const passesDir = join(sandboxRoot(), "state", "pr-9302-round-1-passes");
      const elsewhere = mkdtempSync(join(tmpdir(), "qcr-cwd-"));
      const cwd = process.cwd();
      try {
        mkdirSync(tree, { recursive: true });
        writeFileSync(join(tree, "a.py"), "PACK_MARKER_9302 = 1\n");
        queue(9302, "2026-08-13T09:00:00Z");
        adapter.files.set(9302, [file("a.py", 1, 0)]);
        const { hooks, orders } = recordingHooks();
        process.chdir(elsewhere);

        await dispatchOnce({ cfg, store, adapter, hooks, worktreeFor: () => rel });

        process.chdir(cwd);
        expect(orders).toHaveLength(1);
        const pack = orders[0]!.order.context_pack_file;
        expect(pack).toBeDefined();
        expect(readFileSync(pack!, "utf8")).toContain("PACK_MARKER_9302");
      } finally {
        process.chdir(cwd);
        rmSync(tree, { recursive: true, force: true });
        rmSync(passesDir, { recursive: true, force: true });
        rmSync(elsewhere, { recursive: true, force: true });
      }
    },
  );
});

it("honors an operator pause applied during its final preparation", async () => {
  queue(211, "2026-08-13T09:00:00Z");
  const { hooks, orders } = recordingHooks();
  await dispatchOnce({
    cfg: baseCfg,
    store,
    adapter: new FakeAdapter(),
    hooks,
    renderPrompt: (order) => {
      store.db.prepare("UPDATE pr_state SET paused=1 WHERE number=?").run(order.pr);
      return "prepared prompt";
    },
  });
  expect(orders).toEqual([]);
  expect(store.runningRounds()).toEqual([]);
  expect(store.getPr(211)?.paused).toBe(1);
});

it(
  "retains a withheld approval if its durable retry receipt cannot be recorded",
  { timeout: HEAVY_TIMEOUT_MS },
  async () => {
    queue(212, "2026-08-13T09:00:00Z");
    const head = store.getPr(212)!.head_sha;
    store.recordApprovalWithheld(212, { head_sha: head });
    const original = store.logEvent.bind(store);
    const spy = vi.spyOn(store, "logEvent").mockImplementation((kind, pr, payload) => {
      if (kind === "approval_retry_dispatched") throw new Error("retry receipt disk failure");
      return original(kind, pr, payload);
    });
    try {
      await dispatchOnce({
        cfg: baseCfg,
        store,
        adapter: new FakeAdapter(),
        hooks: recordingHooks().hooks,
      });
      expect(store.approvalWithheld(212)?.head_sha).toBe(head);
    } finally {
      spy.mockRestore();
    }
  },
);

describe("a PR closed while its own round is prepared", () => {
  // MUTATION: drop the closed check before the handoff — the closed PR gets a
  // session, a prompt and a running round.
  it(
    "is never handed off: no order, no running round, still closed",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(210, "2026-08-13T09:00:00Z");
      class Closing extends FakeAdapter {
        override async listPrFiles(n: number): Promise<PrFileEntry[]> {
          store.setPrState(n, "closed");
          return super.listPrFiles(n);
        }
      }
      const { hooks, orders } = recordingHooks();

      await dispatchOnce({ cfg: baseCfg, store, adapter: new Closing(), hooks });

      expect(orders).toEqual([]);
      expect(store.runningRounds()).toEqual([]);
      expect(store.getPr(210)?.state).toBe("closed");
    },
  );
});

describe("a PR that leaves the queue while its round is prepared", () => {
  // MUTATION: drop the queued re-read before startRound — a round row is
  // written and handed off for a PR an older round's late verdict settled.
  it(
    "starts no round: no row, no order, the settled state stands",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(211, "2026-08-13T09:00:00Z");
      class Settling extends FakeAdapter {
        override async listPrFiles(n: number): Promise<PrFileEntry[]> {
          // A late verdict on the orphan-swept older round lands meanwhile.
          store.setPrState(n, "awaiting_author");
          return super.listPrFiles(n);
        }
      }
      const settling = new Settling();
      const { hooks, orders } = recordingHooks();

      await dispatchOnce({ cfg: baseCfg, store, adapter: settling, hooks });

      expect(orders).toEqual([]);
      expect(store.roundsFor(211)).toEqual([]);
      expect(store.getPr(211)?.state).toBe("awaiting_author");
      expect(
        settling.calls.filter(
          (c) => c.fn === "removeLabel" && c.arg === baseCfg.github.in_progress_label,
        ),
      ).toHaveLength(1);
    },
  );
});

describe("roundTypeFor", () => {
  it("first → staleness → re-review", () => {
    const row = { stale_recheck: 0 } as any;
    expect(roundTypeFor(row, 0)).toBe("first");
    expect(roundTypeFor(row, 2)).toBe("re-review");
    expect(roundTypeFor({ stale_recheck: 1 } as any, 2)).toBe("staleness");
  });
});

describe("pre-fanout recovery dispatch", () => {
  it(
    "binds one daemon recovery instruction to the exact ordinary successor order",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(5467, "2026-09-02T15:00:00Z", { head: "recovery-head" });
      const completed = store.startRound(5467, "first", ["pass-baseline"], 75);
      store.finishRound(completed, "REQUEST_CHANGES", null);
      const prior = store.startRound(5467, "re-review", ["pass-baseline"], 75);
      store.createSessionCommand({
        id: "cmd-old",
        pr: 5467,
        session: "pr-5467",
        kind: "round",
        round_no: 2,
        payload_sha256: "a".repeat(64),
        payload_path: "/payload/old.md",
        inject_path: "/inject/old.md",
        next_check_at: "2026-09-02T15:00:00Z",
      });
      store.failPendingSessionCommand("cmd-old", "pre-fanout stall");
      store.markRoundCancelled(prior, "pre-fanout stall", "infrastructure_failure");
      store.recordRoundRecoveryInstruction({
        pr: 5467,
        target_round_no: 3,
        target_head_sha: "recovery-head",
        stage: "first_pass_start",
        source_incident_id: null,
        source_command_id: "cmd-old",
        source_round_no: 2,
        immediate_attempt: 2,
        retry_epoch: 1,
      });
      adapter.files.set(5467, [file("backend/service.py", 20, 3)]);
      const { hooks, orders } = recordingHooks();
      const template = readFileSync(resolve(process.cwd(), "prompts/round-re-review.md"), "utf8");

      await dispatchOnce({
        cfg: baseCfg,
        store,
        adapter,
        hooks,
        renderPrompt: (order, memory) => renderRoundPrompt(template, order, memory),
      });

      expect(orders).toHaveLength(1);
      expect(orders[0]!.order).toMatchObject({
        pr: 5467,
        round_no: 3,
        head_sha: "recovery-head",
        recovery: {
          stage: "first_pass_start",
          source_command_id: "cmd-old",
          source_round_no: 2,
          target_head_sha: "recovery-head",
          retry_epoch: 1,
        },
      });
      expect(orders[0]!.prompt).toContain("RECOVERY — PRE-FANOUT STALL");
      expect(orders[0]!.prompt).toContain("launch every planned discovery pass");
    },
  );

  it(
    "never applies an orphaned recovery instruction to a newer prepared head",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(5468, "2026-09-02T15:00:00Z", { head: "old-head" });
      const prior = store.startRound(5468, "first", ["pass-baseline"], 75);
      store.createSessionCommand({
        id: "cmd-old-head",
        pr: 5468,
        session: "pr-5468",
        kind: "round",
        round_no: 1,
        payload_sha256: "b".repeat(64),
        payload_path: "/payload/old-head.md",
        inject_path: "/inject/old-head.md",
        next_check_at: "2026-09-02T15:00:00Z",
      });
      store.failPendingSessionCommand("cmd-old-head", "pre-fanout stall");
      store.markRoundCancelled(prior, "pre-fanout stall", "infrastructure_failure");
      store.recordRoundRecoveryInstruction({
        pr: 5468,
        target_round_no: 2,
        target_head_sha: "old-head",
        stage: "first_pass_start",
        source_incident_id: null,
        source_command_id: "cmd-old-head",
        source_round_no: 1,
        immediate_attempt: 2,
        retry_epoch: 0,
      });
      queue(5468, "2026-09-02T15:01:00Z", { head: "new-head" });
      adapter.files.set(5468, [file("backend/service.py", 20, 3)]);
      const { hooks, orders } = recordingHooks();

      await dispatchOnce({ cfg: baseCfg, store, adapter, hooks });

      expect(orders).toHaveLength(1);
      expect(orders[0]!.order).toMatchObject({ round_no: 2, head_sha: "new-head" });
      expect(orders[0]!.order.recovery).toBeUndefined();
      const mismatch = store.db
        .prepare(
          "SELECT payload FROM events WHERE kind='round_recovery_instruction_not_applied' AND pr=5468",
        )
        .get() as { payload: string };
      expect(JSON.parse(mismatch.payload)).toMatchObject({
        stored_head_sha: "old-head",
        prepared_head_sha: "new-head",
      });
    },
  );
});

describe("recording at round start", () => {
  it(
    "stamps the diffstat off the files list and the pr_state trigger_ts",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(21, "2026-08-13T09:00:00Z");
      adapter.files.set(21, [file("a.ts", 12, 3), file("b.ts", 4, 40)]);
      const { hooks } = recordingHooks();

      await dispatchOnce({ cfg: baseCfg, store, adapter, hooks });

      const round = store.roundsFor(21)[0]!;
      expect(round).toMatchObject({
        additions: 16,
        deletions: 43,
        changed_files: 2,
        backfilled: 0,
      });
      // trigger_ts survives even though the dispatch transition clears pr_state's.
      expect(round.trigger_ts).toBe("2026-08-13T09:00:00Z");
      expect(store.getPr(21)!.trigger_ts).toBeNull();
      // No extra GitHub call: the diffstat comes off the one files fetch.
      expect(adapter.calls.filter((c) => c.fn === "listPrFiles")).toHaveLength(1);
    },
  );

  // The git-config baseline is taken by dispatch itself. Every other test
  // injects the baseline straight into the round row, so without this one,
  // deleting dispatch's call would leave the suite green while the integrity
  // check never ran for any real round.
  it(
    "takes the git-config fingerprint when the round starts",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(29, "2026-08-13T09:00:00Z");
      adapter.files.set(29, [file("a.ts", 1, 1)]);
      const { hooks } = recordingHooks();

      await realDispatchOnce({ cfg: baseCfg, store, adapter, hooks });

      const round = store.roundsFor(29)[0]!;
      const fp = store.roundGitConfig(round.id) as
        { digest?: unknown; files?: Record<string, string> } | undefined;
      expect(
        fp,
        "dispatch must record a baseline, or verdicts has nothing to compare",
      ).toBeTruthy();
      expect(typeof fp!.digest).toBe("string");
      // The clone's own config and the PINNED global file are both in it — the
      // pin concentrates the target onto one file, so leaving it unwatched would
      // trade a search path for a single unguarded door.
      const watched = Object.keys(fp!.files ?? {});
      expect(watched.some((p) => p.endsWith("/.git/config"))).toBe(true);
      expect(watched.some((p) => p.endsWith("/pihome/.gitconfig"))).toBe(true);
      // …and this system's own policy surface under the sandbox root —
      // the guards' config, the sanctioned scripts and the compiled guard.
      expect(watched.some((p) => p.endsWith("/config.toml"))).toBe(true);
      expect(watched.some((p) => p.endsWith("/scripts"))).toBe(true);
      expect(watched.some((p) => p.endsWith("/dist"))).toBe(true);
    },
  );

  // The baseline is async and awaited inside the one serialized dispatch
  // pump. A read that never returns must cost a
  // bounded wait and an UNCHECKED round (no baseline — never judged), not
  // every later PR undispatched.
  // MUTATION: await the fingerprint without `withinBudget` in dispatch.ts —
  // this test never finishes.
  it("a baseline read that never returns leaves the round unchecked, and the pump moves on", async () => {
    queue(31, "2026-08-13T09:00:00Z");
    adapter.files.set(31, [file("a.ts", 1, 1)]);
    const { hooks, orders } = recordingHooks();

    await dispatchOnce({
      cfg: baseCfg,
      store,
      adapter,
      hooks,
      // The real fingerprint over a filesystem whose reads hang.
      integrityFingerprint: (opts) =>
        fingerprintRoundIntegrity(opts, {
          readFile: () => new Promise<Buffer>(() => undefined),
          readDir: () => [],
          sha256: (data) => String(data),
        }),
      integrityBudgetMs: 20,
    });

    const round = store.roundsFor(31)[0]!;
    expect(orders.map((o) => o.order.pr)).toEqual([31]); // handed to the session
    expect(store.roundGitConfig(round.id)).toBeUndefined(); // unchecked, never "changed"
    const ev = store
      .recentEvents(50)
      .find((e) => e.kind === "round_integrity_unchecked" && e.pr === 31);
    expect(JSON.parse(ev!.payload!)).toEqual({
      round_id: round.id,
      stage: "baseline",
      reason: "budget",
      budget_ms: 20,
    });
  });

  // The audit trail — which tier held the veto in this round.
  it(
    "records the validator's tier on the round row and the dispatch event",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(23, "2026-08-13T09:00:00Z");
      adapter.files.set(23, [file("auth/permissions.py", 10, 2)]);
      const { hooks, orders } = recordingHooks();

      await dispatchOnce({ cfg: baseCfg, store, adapter, hooks });

      const round = store.roundsFor(23)[0]!;
      const planned = orders[0]!.order.pass_plan.find((p) => p.lens === "pass-validate")!;
      expect(round.validate_tier).toBe(planned.tier);
      expect(round.validate_tier).toBe("sol-high");
      expect(JSON.parse(round.pass_plan!)).toEqual(orders[0]!.order.pass_plan);
      const addable = JSON.parse(round.addable_passes!) as Array<{ lens: string; tier: string }>;
      expect(addable).toContainEqual({ lens: "pass-concurrency", tier: "sol-med" });
      expect(
        addable
          .filter((p) => baseCfg.models.risk_passes.includes(p.lens as never))
          .every((p) => p.tier === "sol-high"),
      ).toBe(true);
      const dispatched = store.recentEvents(50).find((e) => e.kind === "round_dispatched")!;
      expect(JSON.parse(dispatched.payload ?? "{}").validate_tier).toBe("sol-high");
    },
  );

  // A round whose profile switched the validator off has no
  // validator, so the round row must not claim one ran at the configured tier.
  // MUTATION: restore `?? cfg.models.validate_tier` on dispatch's validateTier
  // and this fails.
  it(
    "records a NULL validator tier when the profile switched the validator off",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(24, "2026-08-13T09:00:00Z");
      adapter.files.set(24, [file("auth/permissions.py", 10, 2)]);
      const { hooks, orders } = recordingHooks();
      const off: Config = { ...baseCfg, lenses: { "pass-validate": { enabled: false } } };

      await dispatchOnce({ cfg: off, store, adapter, hooks });

      expect(orders[0]!.order.pass_plan.some((p) => p.lens === "pass-validate")).toBe(false);
      const round = store.roundsFor(24)[0]!;
      expect(round.validate_tier).toBeNull();
      const dispatched = store.recentEvents(50).find((e) => e.kind === "round_dispatched")!;
      expect(JSON.parse(dispatched.payload ?? "{}").validate_tier).toBeNull();
    },
  );

  it(
    "counts only daemon-run rounds when choosing first vs re-review",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      // A backfilled (imported) round must not flip the next live round to
      // "re-review" — its template references a settled digest that never existed.
      store.db
        .prepare(
          `INSERT INTO rounds (pr, round_no, round_type, lenses, verdict, started_at, deadline_at, finished_at, status, backfilled)
         VALUES (?, 0, 'backfill', '', 'REQUEST_CHANGES', '2026-07-01T10:00:00Z', '2026-07-01T10:00:00Z', '2026-07-01T10:00:00Z', 'done', 1)`,
        )
        .run(22);
      expect(store.priorRoundCount(22)).toBe(0);

      queue(22, "2026-08-13T09:00:00Z");
      const { hooks, orders } = recordingHooks();
      await dispatchOnce({ cfg: baseCfg, store, adapter, hooks });

      expect(orders[0]!.order.round_type).toBe("first");
      // …and a real prior round still yields a re-review.
      store.finishRound(store.runningRounds()[0]!.id, "REQUEST_CHANGES", 1);
      expect(store.priorRoundCount(22)).toBe(1);
      queue(22, "2026-08-13T11:00:00Z");
      await dispatchOnce({ cfg: baseCfg, store, adapter, hooks });
      expect(orders[1]!.order.round_type).toBe("re-review");
    },
  );

  it(
    "a failed (cancelled, verdict-less) round does not age the PR — next round is still 'first' with review_no 1",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      // Rounds that die before posting anything must not make the next one a
      // "re-review" with the nit cap active. Failed rounds advance round_no
      // (the audit sequence) but must not advance the review age.
      queue(31, "2026-08-13T09:00:00Z");
      const { hooks, orders } = recordingHooks();
      await dispatchOnce({ cfg: baseCfg, store, adapter, hooks });
      store.markRoundCancelled(store.runningRounds()[0]!.id, "session lost");
      expect(store.priorRoundCount(31)).toBe(0);

      queue(31, "2026-08-13T10:00:00Z");
      await dispatchOnce({ cfg: baseCfg, store, adapter, hooks });
      const order = orders[1]!.order;
      expect(order.round_no).toBe(2); // audit sequence keeps counting
      expect(order.round_type).toBe("first"); // review age does not
      expect(order.review_no).toBe(1);
    },
  );
});

describe("buildPassPlan", () => {
  it("tierFiles: the tier (and its migration floor) comes from the given files, the selection from the plan's", () => {
    const small = [file("app/api/views.py", 3, 1)];
    const whole = [...small, file("app/big.py", 900, 0), file("app/core/migrations/0042_x.py", 5)];
    const alone = buildPassPlan(baseCfg, small);
    const tiered = buildPassPlan(baseCfg, small, undefined, undefined, undefined, [], [], {
      tierFiles: whole,
    });
    // Same lenses — the selection reads `files` only.
    expect(tiered.pass_plan.map((p) => p.lens)).toEqual(alone.pass_plan.map((p) => p.lens));
    const def = (plan: typeof alone.pass_plan) =>
      plan
        .filter((p) => p.raisable_to.length > 0 && !["pass-sweep", "pass-intent"].includes(p.lens))
        .map((p) => p.tier);
    expect(new Set(def(alone.pass_plan))).toEqual(new Set(["terra-med"]));
    expect(new Set(def(tiered.pass_plan))).toEqual(new Set(["sol-med"]));
    // No tierFiles ⇒ exactly the plan built from the selection's files alone.
    expect(buildPassPlan(baseCfg, small, undefined, undefined, undefined, [], [], {})).toEqual(
      alone,
    );
  });

  // Deterministic knobs regardless of config.toml churn.
  const planCfg: Config = {
    ...baseCfg,
    models: {
      ...baseCfg.models,
      risk_passes: ["pass-security", "pass-prod-risk", "pass-data-safety"],
      validate_tier: "terra-med",
      small_diff_lines: 150,
      // The shipped pins (DEFAULT_PASS_TIERS) are cleared: this block exercises
      // the UNPINNED tier heuristics; the pins are pinned in lens-knobs.test.ts.
      pass_tiers: {},
    },
  };

  // The threading is profile-agnostic, so it runs on the generic
  // example-django pack every tree ships (the same Django settings/DRF
  // predicates) — never skipped, in any tree.
  it("threads the profile heuristics extension into selection", async () => {
    const { loadProfileHeuristics } = await import("../src/profiles.js");
    const qc = loadProfileHeuristics(resolve(import.meta.dirname, ".."), "example-django");
    const files = [file("project/settings_prod.py", 12, 1)];
    // Without the extension the settings glob is not in the generic core…
    expect(buildPassPlan(planCfg, files).pass_plan.map((p) => p.lens)).not.toContain(
      "pass-security",
    );
    // …with it, the profile predicate selects the lens through the plan.
    const withExt = buildPassPlan(planCfg, files, undefined, undefined, qc).pass_plan.map(
      (p) => p.lens,
    );
    expect(withExt).toContain("pass-security");
    expect(withExt).toContain("pass-backcompat");
  });

  it("pins risk passes to sol-high with no raise ladder", () => {
    const { pass_plan } = buildPassPlan(planCfg, [
      file("infra/main.tf", 120, 5),
      file("auth/permissions.py", 10, 2),
      file("app/migrations/0007_add_index.py", 30, 0),
    ]);
    for (const lens of ["pass-security", "pass-prod-risk", "pass-data-safety"]) {
      const entry = pass_plan.find((p) => p.lens === lens)!;
      expect(entry).toMatchObject({
        lens,
        agent: `${lens}--sol-high`,
        tier: "sol-high",
        raisable_to: [],
      });
    }
  });

  it("runs pass-validate at cfg.models.validate_tier when nothing outranks it, never raisable", () => {
    // A tiny quiet diff: every lens is terra-med, so the floor stands.
    const { pass_plan } = buildPassPlan(planCfg, [file("README.md", 3, 1)]);
    expect(pass_plan[pass_plan.length - 1]).toEqual({
      lens: "pass-validate",
      agent: "pass-validate--terra-med",
      tier: "terra-med",
      raisable_to: [],
    });
    const solValidate = buildPassPlan(
      { ...planCfg, models: { ...planCfg.models, validate_tier: "sol-high" } },
      [file("README.md", 3, 1)],
    ).pass_plan;
    expect(solValidate[solValidate.length - 1]!.agent).toBe("pass-validate--sol-high");
    expect(solValidate[solValidate.length - 1]!.raisable_to).toEqual([]);
  });

  // The validator's veto is a mark (the finding is kept as `doubted`, never
  // deleted), so the validator is never raised to the hottest lens: it runs
  // at its own configured tier.
  it("runs pass-validate at its own tier, never raised to a lens's", () => {
    // A risk lens (sol-high) alongside a terra-med validator.
    const risky = buildPassPlan(planCfg, [file("auth/permissions.py", 10, 2)]).pass_plan;
    expect(risky.find((p) => p.lens === "pass-security")!.tier).toBe("sol-high");
    expect(risky.find((p) => p.lens === "pass-validate")).toEqual({
      lens: "pass-validate",
      agent: "pass-validate--terra-med",
      tier: "terra-med",
      raisable_to: [],
    });
    // A big non-risk diff lands the lenses on sol-med — the validator stays.
    const medium = buildPassPlan(planCfg, [file("app/service.py", 200, 0)]).pass_plan;
    expect(medium.find((p) => p.lens === "pass-validate")!.tier).toBe("terra-med");
  });

  it("the validator's tier is independent of the plan, whatever the plan", () => {
    const sets: PrFileEntry[][] = [
      [file("README.md", 3, 1)],
      [file("app/service.py", 200, 0)],
      [file("auth/permissions.py", 10, 2)],
      [file("infra/main.tf", 120, 5), file("app/migrations/0007_add_index.py", 30, 0)],
      [file("frontend/App.tsx", 40, 4), file("app/api/routes.py", 10, 1)],
    ];
    for (const files of sets) {
      const { pass_plan } = buildPassPlan(planCfg, files);
      expect(pass_plan.at(-1)!.lens).toBe("pass-validate");
      expect(pass_plan.at(-1)!.tier).toBe(validatorTier(planCfg));
    }
  });

  it("the shipped config pins the validator at the top tier", () => {
    expect(baseCfg.models.validate_tier).toBe("sol-high");
    expect(PASS_TIER_ORDER.at(-1)).toBe("sol-high");
  });

  it("validatorTier is the configured tier under the profile's min_tier, never lowered", () => {
    expect(validatorTier(planCfg)).toBe(planCfg.models.validate_tier);
    const floored = { ...planCfg, lenses: { "pass-validate": { min_tier: "sol-med" as const } } };
    expect(validatorTier(floored)).toBe("sol-med");
    const high = {
      ...planCfg,
      models: { ...planCfg.models, validate_tier: "sol-high" as const },
      lenses: { "pass-validate": { min_tier: "terra-med" as const } },
    };
    expect(validatorTier(high)).toBe("sol-high");
  });

  it("gives non-risk lenses the heuristic tier with an ascending raise ladder", () => {
    // Small quiet diff → terra-med, raisable through sol-med to sol-high.
    const small = buildPassPlan(planCfg, [file("README.md", 3, 1)]);
    expect(small.pass_plan[0]).toMatchObject({
      lens: "pass-baseline",
      agent: "pass-baseline--terra-med",
      tier: "terra-med",
      raisable_to: ["pass-baseline--sol-med", "pass-baseline--sol-high"],
    });
    // Diff at/over small_diff_lines → sol-med, only sol-high above it.
    const big = buildPassPlan(planCfg, [file("app/service.py", 200, 0)]);
    expect(big.pass_plan[0]).toMatchObject({
      lens: "pass-baseline",
      agent: "pass-baseline--sol-med",
      tier: "sol-med",
      raisable_to: ["pass-baseline--sol-high"],
    });
    // Migration gate forces sol-med even on a tiny diff (for non-risk lenses).
    const gated = buildPassPlan(planCfg, [file("app/migrations/0001_init.py", 5, 0)]);
    expect(gated.pass_plan[0]!.tier).toBe("sol-med");
  });

  it("addable_lenses = every known pass not already planned", () => {
    const { pass_plan, addable_lenses } = buildPassPlan(planCfg, [file("README.md", 3, 1)]);
    expect(pass_plan.map((p) => p.lens)).toEqual(["pass-baseline", "pass-validate"]);
    expect(addable_lenses).toEqual(
      ALL_PASSES.filter((l) => l !== "pass-baseline" && l !== "pass-validate"),
    );
    expect(addable_lenses).not.toContain("pass-validate");
  });

  // The concurrency lens is addable-only: a read-modify-write race has no
  // filename (such findings span unrelated modules), so
  // no path predicate may plan it. It reaches a round only through the add
  // protocol, when the session names the read-then-write it suspects.
  describe("pass-concurrency", () => {
    it("is a known pass, so it is always in the addable set", () => {
      expect(ALL_PASSES).toContain("pass-concurrency");
      const { addable_lenses } = buildPassPlan(planCfg, [file("README.md", 3, 1)]);
      expect(addable_lenses).toContain("pass-concurrency");
    });

    it("is NEVER planned by path selection — not on any surface", () => {
      const surfaces: PrFileEntry[][] = [
        [file("app/messages_update.py", 200, 10)],
        [file("app/chat.py", 40, 3)],
        [file("app/models.py", 200, 0)],
        [file("app/shopping_handler.py", 120, 5)],
        [file("app/scraper.py", 80, 2)],
        [file("app/router.py", 200, 0)],
        [file("app/article_update.py", 60, 1)],
        [file("app/views.py", 300, 20)],
        [file("app/migrations/0042_add_col.py", 5, 0)],
        [file("app/tasks/retrain.py", 200, 0)],
        [file("src/components/Thing.tsx", 90, 4)],
        [file("app/serializers/user.py", 200, 0), file("project/settings_prod.py", 12, 1)],
        [file("README.md", 3, 1)],
      ];
      for (const files of surfaces) {
        const { pass_plan, addable_lenses } = buildPassPlan(planCfg, files, {
          body:
            "This PR introduces a token-bucket rate limiter for the public API. " +
            "Requests over the limit receive a 429 with a Retry-After header, and " +
            "the bucket refills once per second per client key.",
        });
        const label = files.map((f) => f.filename).join(",");
        expect(
          pass_plan.map((p) => p.lens),
          label,
        ).not.toContain("pass-concurrency");
        expect(addable_lenses, label).toContain("pass-concurrency");
      }
    });

    it("is not a risk pass — it needs no config entry and stays tier-laddered", () => {
      expect(planCfg.models.risk_passes).not.toContain("pass-concurrency");
      expect(baseCfg.models.risk_passes).not.toContain("pass-concurrency");
    });
  });

  // The ask-your-human lens is addable-only too: no path predicate
  // finds "code whose intent was never written down", and whether the answer
  // is in the repo at all is only visible once the diff has been read.
  describe("pass-ask-human", () => {
    // Clears the default preset's 60-word substance bar.
    const body =
      "This PR introduces a token-bucket rate limiter for the public API. " +
      "Requests over the limit receive a 429 with a Retry-After header, and " +
      "the bucket refills once per second per client key. The limiter lives " +
      "in the middleware layer so every public route shares it, the per-key " +
      "budget comes from settings, and a burst allowance keeps short spikes " +
      "from being rejected while a sustained flood is throttled.";

    it("is a known pass, so it is always in the addable set", () => {
      expect(ALL_PASSES).toContain("pass-ask-human");
      const { addable_lenses } = buildPassPlan(planCfg, [file("README.md", 3, 1)]);
      expect(addable_lenses).toContain("pass-ask-human");
    });

    it("is NEVER planned by path selection — not on any surface, thin body or thick", () => {
      const surfaces: PrFileEntry[][] = [
        [file("app/service.py", 200, 0)],
        [file("app/views.py", 300, 20)],
        [file("app/migrations/0042_add_col.py", 5, 0)],
        [file("src/components/Thing.tsx", 90, 4)],
        [file("project/settings_prod.py", 12, 1)],
        [file("README.md", 3, 1)],
      ];
      for (const files of surfaces) {
        for (const intent of [{ body }, { body: "" }, undefined]) {
          const { pass_plan, addable_lenses } = buildPassPlan(planCfg, files, intent);
          const label = `${files.map((f) => f.filename).join(",")} / body=${intent?.body?.length ?? "none"}`;
          expect(
            pass_plan.map((p) => p.lens),
            label,
          ).not.toContain("pass-ask-human");
          expect(addable_lenses, label).toContain("pass-ask-human");
        }
      }
    });

    it("is not a risk pass — it needs no config entry and stays tier-laddered", () => {
      expect(planCfg.models.risk_passes).not.toContain("pass-ask-human");
      expect(baseCfg.models.risk_passes).not.toContain("pass-ask-human");
    });
  });

  // pass-intent: selected on the PR body's substance, priced at the
  // cheapest tier whatever the round's default, raisable like any other lens.
  describe("pass-intent", () => {
    // Clears the default preset's 60-word substance bar.
    const body =
      "This PR introduces a token-bucket rate limiter for the public API. " +
      "Requests over the limit receive a 429 with a Retry-After header, and " +
      "the bucket refills once per second per client key. The limiter lives " +
      "in the middleware layer so every public route shares it, the per-key " +
      "budget comes from settings, and a burst allowance keeps short spikes " +
      "from being rejected while a sustained flood is throttled.";

    it("starts at terra-med even when the round's default tier is sol-med", () => {
      // 200 changed lines ⇒ defaultTier sol-med; intent stays terra-med.
      const { pass_plan } = buildPassPlan(planCfg, [file("app/service.py", 200, 0)], { body });
      const intent = pass_plan.find((p) => p.lens === "pass-intent")!;
      expect(intent).toMatchObject({
        lens: "pass-intent",
        agent: "pass-intent--terra-med",
        tier: "terra-med",
        raisable_to: ["pass-intent--sol-med", "pass-intent--sol-high"],
      });
      // The validator runs at its own tier, whatever the lenses run at.
      const validate = pass_plan.find((p) => p.lens === "pass-validate")!;
      expect(validate.tier).toBe(planCfg.models.validate_tier);
    });

    it("is skipped (and stays addable) when the body is thin or absent", () => {
      for (const intentArg of [undefined, {}, { body: "fixes the bug" }] as const) {
        const { pass_plan, addable_lenses } = buildPassPlan(
          planCfg,
          [file("app/service.py", 200, 0)],
          intentArg,
        );
        expect(pass_plan.map((p) => p.lens)).not.toContain("pass-intent");
        expect(addable_lenses).toContain("pass-intent");
      }
    });
  });

  // The judgment lenses ride the default tier ladder and stay
  // raisable, exactly like any non-risk lens; pin the plan entries so a
  // future tier change cannot ship silently.
  describe("judgment lenses", () => {
    it("plans simplicity + backcompat at the round's default tier, raisable", () => {
      // 200 changed serializer lines ⇒ default sol-med; selects contracts,
      // backcompat (wire surface) and simplicity (size).
      const { pass_plan } = buildPassPlan(planCfg, [file("app/serializers/user.py", 200, 0)]);
      expect(pass_plan.find((p) => p.lens === "pass-backcompat")).toMatchObject({
        lens: "pass-backcompat",
        agent: "pass-backcompat--sol-med",
        tier: "sol-med",
        raisable_to: ["pass-backcompat--sol-high"],
      });
      expect(pass_plan.find((p) => p.lens === "pass-simplicity")).toMatchObject({
        lens: "pass-simplicity",
        agent: "pass-simplicity--sol-med",
        tier: "sol-med",
        raisable_to: ["pass-simplicity--sol-high"],
      });
    });

    it("plans placement at terra-med on a small new-file diff", () => {
      // 40 lines: over the default preset's 30-line new-file floor.
      const added = { ...file("src/tools/new_helper.py", 40, 0), status: "added" };
      const { pass_plan } = buildPassPlan(planCfg, [added]);
      expect(pass_plan.find((p) => p.lens === "pass-placement")).toMatchObject({
        lens: "pass-placement",
        agent: "pass-placement--terra-med",
        tier: "terra-med",
        raisable_to: ["pass-placement--sol-med", "pass-placement--sol-high"],
      });
      // A tiny added helper does not buy the size-keyed lenses.
      expect(pass_plan.map((p) => p.lens)).not.toContain("pass-simplicity");
    });
  });
});

describe("dispatchOnce", () => {
  it(
    "dispatches in FIFO order and stops at the concurrency cap",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const cfg = { ...baseCfg, daemon: { ...baseCfg.daemon, max_concurrent_rounds: 2 } };
      queue(11, "2026-08-13T09:00:00Z");
      queue(12, "2026-08-13T09:30:00Z");
      queue(13, "2026-08-13T10:00:00Z");
      const { hooks, orders } = recordingHooks();

      const dispatched = await dispatchOnce({ cfg, store, adapter, hooks });
      expect(dispatched.map((o) => o.pr)).toEqual([11, 12]);
      expect(orders.map((o) => o.order.pr)).toEqual([11, 12]);
      expect(store.getPr(11)!.state).toBe("reviewing");
      expect(store.getPr(13)!.state).toBe("queued");
      expect(store.runningRounds()).toHaveLength(2);

      // The cap holds on the next pump until a round finishes.
      expect(await dispatchOnce({ cfg, store, adapter, hooks })).toHaveLength(0);
      store.finishRound(store.runningRounds()[0]!.id, "APPROVE", 1.5);
      const next = await dispatchOnce({ cfg, store, adapter, hooks });
      expect(next.map((o) => o.pr)).toEqual([13]);
    },
  );

  it(
    "consumes both triggers and flags the round in progress",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(21, "2026-08-13T09:00:00Z");
      const { hooks } = recordingHooks();
      await dispatchOnce({ cfg: baseCfg, store, adapter, hooks });
      expect(adapter.calls).toEqual([
        { fn: "removeLabel", pr: 21, arg: baseCfg.github.trigger_label },
        { fn: "deleteTeamReviewRequest", pr: 21 },
        { fn: "addLabel", pr: 21, arg: baseCfg.github.in_progress_label },
        { fn: "getPr", pr: 21 }, // base branch, for the worktree fetch
        { fn: "listPrFiles", pr: 21 },
      ]);
    },
  );

  it(
    "still dispatches when trigger consumption partially fails",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(22, "2026-08-13T09:00:00Z");
      adapter.failLabelOn.add(22);
      const { hooks, orders } = recordingHooks();
      const dispatched = await dispatchOnce({ cfg: baseCfg, store, adapter, hooks });
      expect(dispatched).toHaveLength(1);
      expect(orders).toHaveLength(1);
      const logged = store.db
        .prepare("SELECT payload FROM events WHERE kind = 'trigger_consume_failed'")
        .all() as Array<{ payload: string }>;
      expect(JSON.parse(logged[0]!.payload).which).toBe("label");
    },
  );

  it(
    "treats a GitHub 404 on label removal as already-consumed, not a failure",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(23, "2026-08-13T09:00:00Z");
      adapter.goneLabelOn.add(23);
      const { hooks, orders } = recordingHooks();
      const dispatched = await dispatchOnce({ cfg: baseCfg, store, adapter, hooks });
      expect(dispatched).toHaveLength(1);
      expect(orders).toHaveLength(1);
      expect(
        store.db
          .prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'trigger_consume_failed'")
          .get(),
      ).toEqual({ c: 0 });
      const already = store.db
        .prepare("SELECT payload FROM events WHERE kind = 'trigger_already_consumed'")
        .all() as Array<{ payload: string }>;
      expect(JSON.parse(already[0]!.payload).which).toBe("label");
      const round = store.db
        .prepare("SELECT payload FROM events WHERE kind = 'round_dispatched'")
        .get() as { payload: string };
      expect(JSON.parse(round.payload).triggers_consumed).toContain("label");
    },
  );

  // MUTATION: push every trigger whose call resolved, whatever the gate
  // answered — round_dispatched claims a dry run consumed both triggers.
  it(
    "reports as consumed only the triggers the gate really removed",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(24, "2026-08-13T09:00:00Z");
      queue(25, "2026-08-13T09:00:01Z");
      class Live extends FakeAdapter {
        override async removeLabel(n: number, label: string): Promise<GateResult> {
          await super.removeLabel(n, label);
          return { executed: true };
        }
        override async deleteTeamReviewRequest(n: number): Promise<GateResult> {
          await super.deleteTeamReviewRequest(n);
          return { executed: true };
        }
      }
      const { hooks } = recordingHooks();
      // The fake's dry-run gate records every mutation instead of executing it.
      await dispatchOnce({
        cfg: { ...baseCfg, daemon: { ...baseCfg.daemon, max_concurrent_rounds: 1 } },
        store,
        adapter,
        hooks,
      });
      await dispatchOnce({ cfg: baseCfg, store, adapter: new Live(), hooks });

      const consumed = (
        store.db
          .prepare("SELECT pr, payload FROM events WHERE kind = 'round_dispatched' ORDER BY pr")
          .all() as Array<{ pr: number; payload: string }>
      ).map((r) => [r.pr, JSON.parse(r.payload).triggers_consumed]);
      expect(consumed).toEqual([
        [24, []],
        [25, ["label", "team_request"]],
      ]);
      const notExecuted = (
        store.db
          .prepare(
            "SELECT payload FROM events WHERE kind = 'trigger_consume_not_executed' AND pr = 24",
          )
          .all() as Array<{ payload: string }>
      ).map((r) => JSON.parse(r.payload));
      expect(notExecuted).toEqual([
        { which: "label", dry_run: true },
        { which: "team_request", dry_run: true },
      ]);
    },
  );

  it(
    "never dispatches a PR that already has a running round (one worktree, one round)",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(24, "2026-08-13T09:00:00Z");
      queue(25, "2026-08-13T09:01:00Z");
      store.startRound(24, "first", ["pass-baseline"], 45); // round in flight, PR requeued behind it
      const { hooks, orders } = recordingHooks();
      const dispatched = await dispatchOnce({ cfg: baseCfg, store, adapter, hooks });
      expect(dispatched.map((o) => o.pr)).toEqual([25]);
      expect(orders.map((o) => o.order.pr)).toEqual([25]);
      expect(adapter.calls.filter((c) => c.pr === 24)).toHaveLength(0);
    },
  );

  it(
    "never dispatches a round behind an active ordinary session command",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(26, "2026-08-13T09:00:00Z");
      queue(27, "2026-08-13T09:01:00Z");
      store.createSessionCommand({
        id: "cmd-26",
        pr: 26,
        session: "pr-26",
        kind: "wake",
        round_no: null,
        payload_sha256: "a".repeat(64),
        payload_path: "/state/cmd-26.md",
        inject_path: "/inject/pr-26/cmd-26.md",
        next_check_at: "2026-08-13T09:02:00Z",
      });
      const { hooks, orders } = recordingHooks();
      const dispatched = await dispatchOnce({ cfg: baseCfg, store, adapter, hooks });
      expect(dispatched.map((o) => o.pr)).toEqual([27]);
      expect(orders.map((o) => o.order.pr)).toEqual([27]);
      expect(adapter.calls.filter((c) => c.pr === 26)).toHaveLength(0);
    },
  );

  it(
    "never dispatches a round ahead of an older held conversational wake",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(28, "2026-08-13T09:00:00Z");
      queue(29, "2026-08-13T09:01:00Z");
      store.holdWake(28, "operator-recovered author reply", "operator_recovered:wake:cmd-28");
      const { hooks, orders } = recordingHooks();

      const dispatched = await dispatchOnce({ cfg: baseCfg, store, adapter, hooks });

      expect(dispatched.map((o) => o.pr)).toEqual([29]);
      expect(orders.map((o) => o.order.pr)).toEqual([29]);
      expect(store.heldWakes(28)).toHaveLength(1);
      expect(adapter.calls.filter((c) => c.pr === 28)).toHaveLength(0);
    },
  );

  it(
    "builds the round order from the files API: lenses and the migration gate",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(31, "2026-08-13T09:00:00Z", { title: "Terraform the ingest cluster", head: "abc123" });
      adapter.files.set(31, [
        file("infra/main.tf", 120, 5),
        file("app/migrations/0007_add_index.py", 30, 0),
        file("app/serializers/routes.py", 40, 2),
        file("tests/test_routes.py", 400, 0), // test file: excluded from prod stats
      ]);
      const { hooks, orders } = recordingHooks();
      const [order] = await dispatchOnce({ cfg: baseCfg, store, adapter, hooks });

      expect(order).toBeDefined();
      expect(order!.pr).toBe(31);
      expect(order!.round_no).toBe(1);
      expect(order!.round_type).toBe("first");
      expect(order!.head_sha).toBe("abc123");
      expect(order!.title).toBe("Terraform the ingest cluster");
      expect(order!.worktree).toBe("wt/pr-31");
      expect(order!.lenses).toContain("pass-baseline");
      expect(order!.lenses).toContain("pass-prod-risk");
      expect(order!.lenses).toContain("pass-data-safety");
      expect(order!.lenses).toContain("pass-contracts");
      expect(order!.lenses[order!.lenses.length - 1]).toBe("pass-validate");
      expect(order!.migration_gate).toBe(true);
      // No escalation heuristic: an infra-shaped diff carries no flag.
      expect((order as unknown as Record<string, unknown>).escalation_worthy).toBeUndefined();
      expect((order as unknown as Record<string, unknown>).escalation_reasons).toBeUndefined();
      // pass_plan mirrors lenses in order (a lens with several rows — the sweep,
      // one row per file group — once); addable = the known passes not planned.
      expect([...new Set(order!.pass_plan.map((p) => p.lens))]).toEqual(order!.lenses);
      expect(order!.addable_lenses).toEqual(ALL_PASSES.filter((l) => !order!.lenses.includes(l)));

      const row = store.getPr(31)!;
      expect(row.migration_gate).toBe(1);
      expect(orders[0]!.prompt).toContain('"pr": 31'); // default renderer = JSON
    },
  );

  it("leaves a small tidy PR ungated", { timeout: HEAVY_TIMEOUT_MS }, async () => {
    queue(32, "2026-08-13T09:00:00Z");
    adapter.files.set(32, [file("README.md", 3, 1)]);
    const { hooks } = recordingHooks();
    const [order] = await dispatchOnce({ cfg: baseCfg, store, adapter, hooks });
    expect(order!.migration_gate).toBe(false);
    expect(order!.lenses).toEqual(["pass-baseline", "pass-validate"]);
    // Shipped default (DEFAULT_PASS_TIERS): baseline is pinned at sol-high on
    // every PR, so it is not raisable.
    expect(order!.pass_plan[0]).toMatchObject({
      lens: "pass-baseline",
      agent: "pass-baseline--sol-high",
      tier: "sol-high",
      raisable_to: [],
    });
  });

  // ---- worktree facts in the order -----------------------------------------

  it(
    "carries the prepared tree's base facts into the order",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(60, "2026-08-13T09:00:00Z", { head: "snapshot-sha" });
      adapter.baseRefs.set(60, "release/2026-08");
      const asked: Array<[number, string]> = [];
      const { hooks } = recordingHooks();
      const [order] = await dispatchOnce({
        cfg: baseCfg,
        store,
        adapter,
        hooks,
        prepareWorktree: async (pr, baseRef) => {
          asked.push([pr, baseRef]);
          return {
            head_sha: "snapshot-sha",
            base_ref: baseRef,
            base_sha: "base-tip",
            merge_base: "fork-point",
          };
        },
      });
      // The PR's OWN base branch is what gets fetched, not a hardcoded master.
      expect(asked).toEqual([[60, "release/2026-08"]]);
      expect(order!.base_ref).toBe("release/2026-08");
      expect(order!.base_sha).toBe("base-tip");
      expect(order!.merge_base).toBe("fork-point");
    },
  );

  it(
    "prefers the tree's real sha over the PR row snapshot and logs the drift",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(61, "2026-08-13T09:00:00Z", { head: "stale-snapshot" });
      const { hooks } = recordingHooks();
      const [order] = await dispatchOnce({
        cfg: baseCfg,
        store,
        adapter,
        hooks,
        // A push landed between the reconcile snapshot and the fetch.
        prepareWorktree: async () => ({
          head_sha: "pushed-sha",
          base_ref: "master",
          base_sha: "b",
          merge_base: "m",
        }),
      });
      expect(order!.head_sha).toBe("pushed-sha");
      const drift = store.db
        .prepare("SELECT payload FROM events WHERE kind = 'head_drift'")
        .all() as Array<{ payload: string }>;
      expect(drift).toHaveLength(1);
      expect(JSON.parse(drift[0]!.payload)).toMatchObject({
        expected: "stale-snapshot",
        actual: "pushed-sha",
      });
    },
  );

  it(
    "hands the worktree the row's API head, and records a pull ref that lagged it (#6075)",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(63, "2026-08-13T09:00:00Z", { head: "api-head" });
      const { hooks } = recordingHooks();
      const asked: string[] = [];
      const [order] = await dispatchOnce({
        cfg: baseCfg,
        store,
        adapter,
        hooks,
        prepareWorktree: async (_pr, _base, expectedHead) => {
          asked.push(expectedHead);
          return {
            head_sha: "api-head",
            base_ref: "master",
            base_sha: "b",
            merge_base: "m",
            pull_ref_sha: "stale-pull-ref",
          };
        },
      });
      expect(asked).toEqual(["api-head"]);
      expect(order!.head_sha).toBe("api-head");
      const lag = store.db
        .prepare("SELECT payload FROM events WHERE kind = 'pull_ref_lagged'")
        .all() as Array<{ payload: string }>;
      expect(lag).toHaveLength(1);
      expect(JSON.parse(lag[0]!.payload)).toMatchObject({
        pull_ref: "stale-pull-ref",
        head: "api-head",
      });
      expect(
        store.db.prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'head_drift'").get(),
      ).toMatchObject({ c: 0 });
    },
  );

  it(
    "logs no drift when the tree matches the snapshot",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(62, "2026-08-13T09:00:00Z", { head: "same-sha" });
      const { hooks } = recordingHooks();
      await dispatchOnce({
        cfg: baseCfg,
        store,
        adapter,
        hooks,
        prepareWorktree: async () => ({
          head_sha: "same-sha",
          base_ref: "master",
          base_sha: "b",
          merge_base: "m",
        }),
      });
      expect(
        store.db.prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'head_drift'").get(),
      ).toMatchObject({ c: 0 });
    },
  );

  it(
    "still dispatches when the base-ref lookup fails — degraded, not blocked",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(63, "2026-08-13T09:00:00Z", { head: "abc" });
      adapter.failGetPrOn.add(63);
      const { hooks } = recordingHooks();
      const [order] = await dispatchOnce({
        cfg: baseCfg,
        store,
        adapter,
        hooks,
        prepareWorktree: async (_pr, baseRef) => ({
          head_sha: "abc",
          base_ref: baseRef,
          base_sha: "",
          merge_base: "",
        }),
      });
      expect(order).toBeDefined();
      expect(order!.base_ref).toBe("");
    },
  );

  it(
    "falls back to the row sha with empty base facts when there is no worktree seam",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(64, "2026-08-13T09:00:00Z", { head: "row-sha" });
      const { hooks } = recordingHooks();
      const [order] = await dispatchOnce({ cfg: baseCfg, store, adapter, hooks });
      expect(order!.head_sha).toBe("row-sha");
      expect(order!.base_ref).toBe("");
      expect(order!.merge_base).toBe("");
    },
  );

  it(
    "uses the injected prompt renderer and settled digest",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(33, "2026-08-13T09:00:00Z");
      const { hooks, orders } = recordingHooks();
      await dispatchOnce({
        cfg: baseCfg,
        store,
        adapter,
        hooks,
        renderPrompt: (o) => `ROUND ${o.round_no} for #${o.pr}`,
        settledDigest: () => "SETTLED: thread 12 (perf, conceded)",
      });
      expect(orders[0]!.prompt).toBe("ROUND 1 for #33");
      expect(orders[0]!.order.settled_digest).toBe("SETTLED: thread 12 (perf, conceded)");
    },
  );

  // The ledger carry re-hands the PR's ledger on the order and
  // supplies the settled digest; an explicit settledDigest still wins.
  it(
    "carries the PR's ledger and takes the settled digest from it",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(34, "2026-08-13T09:00:00Z");
      queue(35, "2026-08-13T09:01:00Z");
      const { hooks, orders } = recordingHooks();
      const carry = {
        source: "/r/state/ledgers/pr-34.md",
        header: "LEDGER PR #34 @ abc1234",
        text: "LEDGER PR #34 @ abc1234\nSETTLED: T1: conceded",
        truncated: false,
        total_chars: 44,
      };
      const asked: number[] = [];
      await dispatchOnce({
        cfg: { ...baseCfg, daemon: { ...baseCfg.daemon, max_concurrent_rounds: 5 } },
        store,
        adapter,
        hooks,
        ledgerCarry: (pr) => {
          asked.push(pr);
          return pr === 34 ? { carry, settled: "- T1: conceded" } : { settled: "" };
        },
      });
      const by = new Map(orders.map((o) => [o.order.pr, o.order]));
      expect(asked.sort()).toEqual([34, 35]);
      expect(by.get(34)!.ledger_carry).toEqual(carry);
      expect(by.get(34)!.settled_digest).toBe("- T1: conceded");
      // No ledger ⇒ no field at all (the order renders as it would without a carry).
      expect("ledger_carry" in by.get(35)!).toBe(false);
      expect(by.get(35)!.settled_digest).toBe("");
    },
  );

  it(
    "an explicit settledDigest supplier beats the ledger's SETTLED items",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(36, "2026-08-13T09:00:00Z");
      const { hooks, orders } = recordingHooks();
      await dispatchOnce({
        cfg: baseCfg,
        store,
        adapter,
        hooks,
        settledDigest: () => "explicit",
        ledgerCarry: () => ({ settled: "- from ledger" }),
      });
      expect(orders[0]!.order.settled_digest).toBe("explicit");
    },
  );

  // The nit treadmill's stopping rule must reach the passes through
  // their task strings, and passes are blank slates — so the dispatched round
  // prompt itself must carry the verbatim NIT SCOPE block from round 3 onward,
  // rendered through the REAL shipped templates.
  it(
    "arms the NIT SCOPE task-string block in the dispatched prompt from round 3, not before",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const templates = new Map(
        (["first", "re-review", "staleness"] as const).map((rt) => [
          rt,
          readFileSync(resolve(process.cwd(), "prompts", roundTemplateFile(rt)), "utf8"),
        ]),
      );
      const renderPrompt = (o: RoundOrder) => renderRoundPrompt(templates.get(o.round_type)!, o);
      const { hooks, orders } = recordingHooks();
      queue(89, "2026-08-13T09:00:00Z", { head: "h1" });
      await dispatchOnce({ cfg: baseCfg, store, adapter, hooks, renderPrompt });
      store.finishRound(store.runningRounds()[0]!.id, "REQUEST_CHANGES", 1);
      queue(89, "2026-08-13T10:00:00Z", { head: "h2" });
      await dispatchOnce({ cfg: baseCfg, store, adapter, hooks, renderPrompt });
      store.finishRound(store.runningRounds()[0]!.id, "REQUEST_CHANGES", 1);
      queue(89, "2026-08-13T11:00:00Z", { head: "h3" });
      await dispatchOnce({ cfg: baseCfg, store, adapter, hooks, renderPrompt });

      expect(orders.map((o) => [o.order.round_no, o.order.round_type])).toEqual([
        [1, "first"],
        [2, "re-review"],
        [3, "re-review"],
      ]);
      // Rounds 1–2: no armed block in what the session was handed.
      expect(orders[0]!.prompt).not.toContain("NIT SCOPE: this is review");
      expect(orders[1]!.prompt).not.toContain("NIT SCOPE: this is review");
      // Round 3: the verbatim block, round number stated, rule + exemption whole.
      const p3 = orders[2]!.prompt;
      expect(p3).toContain("fenced block below VERBATIM into every lens pass's task string");
      expect(p3).toContain("NIT SCOPE: this is review 3 of this PR");
      expect(p3).toContain("inside the current delta");
      expect(p3).toContain("P0–P2 findings are exempt");
      expect(p3).toContain("running non-blocking thread");
    },
  );

  it("numbers rounds per PR and marks a stale recheck", { timeout: HEAVY_TIMEOUT_MS }, async () => {
    queue(41, "2026-08-13T09:00:00Z");
    const { hooks } = recordingHooks();
    await dispatchOnce({ cfg: baseCfg, store, adapter, hooks });
    store.finishRound(store.runningRounds()[0]!.id, "APPROVE", 0.5);
    applyEvent(store, 41, { type: "verdict", verdict: "APPROVE" }, {}, {});
    applyEvent(store, 41, { type: "stale_detected" }, {}, {});
    expect(store.getPr(41)!.stale_recheck).toBe(1);

    const [second] = await dispatchOnce({ cfg: baseCfg, store, adapter, hooks });
    expect(second!.round_no).toBe(2);
    expect(second!.round_type).toBe("staleness");
    expect(store.getPr(41)!.stale_recheck).toBe(0);
  });

  it("never dispatches a PR that is not queued", { timeout: HEAVY_TIMEOUT_MS }, async () => {
    store.upsertPr({
      number: 51,
      state: "awaiting_author",
      head_sha: "x",
      title: "t",
      author: "alice",
      trigger_ts: "2026-08-13T09:00:00Z",
      stale_recheck: 0,
      migration_gate: 0,
    });
    const { hooks } = recordingHooks();
    expect(await dispatchOnce({ cfg: baseCfg, store, adapter, hooks })).toHaveLength(0);
    expect(adapter.calls).toHaveLength(0);
  });

  it(
    "serializes concurrent pumps so one PR gets one round and the cap holds",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const cfg = { ...baseCfg, daemon: { ...baseCfg.daemon, max_concurrent_rounds: 1 } };
      queue(58, "2026-08-13T09:00:00Z");
      queue(59, "2026-08-13T09:01:00Z");
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { hooks, orders } = recordingHooks();
      const original = hooks.dispatchRound;
      hooks.dispatchRound = async (order, prompt) => {
        await blocked;
        await original(order, prompt);
      };

      const first = dispatchOnce({ cfg, store, adapter, hooks });
      const joined = dispatchOnce({ cfg, store, adapter, hooks });
      release();
      expect((await first).map((o) => o.pr)).toEqual([58]);
      expect(await joined).toEqual([]);
      expect(orders.map((o) => o.order.pr)).toEqual([58]);
      expect(store.runningRounds()).toHaveLength(1);
      expect(store.getPr(59)!.state).toBe("queued");
      expect(adapter.calls.filter((c) => c.fn === "removeLabel" && c.pr === 58)).toHaveLength(1);
    },
  );

  it(
    "discards a provisional round and leaves the PR queued when session dispatch fails",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(60, "2026-08-13T09:00:00Z");
      const hooks = recordingHooks().hooks;
      hooks.dispatchRound = async () => {
        throw new Error("worktree index.lock");
      };

      expect(await dispatchOnce({ cfg: baseCfg, store, adapter, hooks })).toEqual([]);
      expect(store.getPr(60)!.state).toBe("queued");
      expect(store.runningRounds()).toEqual([]);
      expect(
        store.db.prepare("SELECT COUNT(*) AS c FROM rounds WHERE pr = 60").get(),
      ).toMatchObject({
        c: 0,
      });
      const failure = store.db
        .prepare("SELECT payload FROM events WHERE kind = 'dispatch_failed' AND pr = 60")
        .get() as { payload: string };
      expect(JSON.parse(failure.payload)).toMatchObject({
        round_id: 1,
        error: expect.stringContaining("index.lock"),
      });
    },
  );

  it(
    "retains the round when a durable command exists before bookkeeping fails",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(63, "2026-08-13T09:00:00Z");
      const hooks = recordingHooks().hooks;
      hooks.dispatchRound = async (order) => {
        store.createSessionCommand({
          id: "cmd-retained",
          pr: order.pr,
          session: `pr-${order.pr}`,
          kind: "round",
          round_no: order.round_no,
          payload_sha256: "a".repeat(64),
          payload_path: "/state/cmd-retained.md",
          inject_path: "/inject/pr-63/cmd-retained.md",
          next_check_at: "2026-08-13T09:02:00Z",
        });
        throw new Error("post-handoff bookkeeping failed");
      };

      expect(await dispatchOnce({ cfg: baseCfg, store, adapter, hooks })).toEqual([]);
      expect(store.getPr(63)?.state).toBe("reviewing");
      expect(store.runningRounds()).toHaveLength(1);
      expect(store.blockingSessionCommand("pr-63")?.id).toBe("cmd-retained");
      const failure = store.db
        .prepare("SELECT payload FROM events WHERE kind='dispatch_failed' AND pr=63")
        .get() as { payload: string };
      expect(JSON.parse(failure.payload)).toMatchObject({ retained_command: true });
    },
  );

  // MUTATION: drop the label removal from dispatch's catch — the failed PR
  // keeps advertising a review in progress that no round owns.
  it(
    "a preparation that fails before any round owns the review takes its in-progress label off; a retained round keeps it",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(64, "2026-08-13T09:00:00Z");
      const failing = new (class extends FakeAdapter {
        override async listPrFiles(): Promise<PrFileEntry[]> {
          throw new Error("files API 502");
        }
      })();
      expect(
        await dispatchOnce({
          cfg: baseCfg,
          store,
          adapter: failing,
          hooks: recordingHooks().hooks,
        }),
      ).toEqual([]);
      const labels = (a: FakeAdapter, pr: number): string[] =>
        a.calls
          .filter((c) => c.pr === pr && (c.fn === "addLabel" || c.fn === "removeLabel"))
          .map((c) => `${c.fn}:${c.arg}`);
      expect(labels(failing, 64)).toEqual([
        `removeLabel:${baseCfg.github.trigger_label}`,
        `addLabel:${baseCfg.github.in_progress_label}`,
        `removeLabel:${baseCfg.github.in_progress_label}`,
      ]);

      store.setPrState(64, "tracked");
      queue(65, "2026-08-13T09:00:00Z");
      const hooks = recordingHooks().hooks;
      hooks.dispatchRound = async (order) => {
        store.createSessionCommand({
          id: "cmd-retained-65",
          pr: order.pr,
          session: `pr-${order.pr}`,
          kind: "round",
          round_no: order.round_no,
          payload_sha256: "a".repeat(64),
          payload_path: "/state/cmd-retained-65.md",
          inject_path: "/inject/pr-65/cmd-retained-65.md",
          next_check_at: "2026-08-13T09:02:00Z",
        });
        throw new Error("post-handoff bookkeeping failed");
      };
      await dispatchOnce({ cfg: baseCfg, store, adapter, hooks });
      expect(labels(adapter, 65)).toEqual([
        `removeLabel:${baseCfg.github.trigger_label}`,
        `addLabel:${baseCfg.github.in_progress_label}`,
      ]);
    },
  );

  it("one failing PR does not stall the pump", { timeout: HEAVY_TIMEOUT_MS }, async () => {
    queue(61, "2026-08-13T09:00:00Z");
    queue(62, "2026-08-13T09:30:00Z");
    const bad = new (class extends FakeAdapter {
      override async listPrFiles(n: number): Promise<PrFileEntry[]> {
        if (n === 61) throw new Error("files API 502");
        return [];
      }
    })();
    const { hooks } = recordingHooks();
    const dispatched = await dispatchOnce({ cfg: baseCfg, store, adapter: bad, hooks });
    expect(dispatched.map((o) => o.pr)).toEqual([62]);
    expect(
      store.db.prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'dispatch_failed'").get(),
    ).toMatchObject({ c: 1 });
  });
});

describe("first-party directive escalation pick", () => {
  const tree = {
    head_sha: "sha70",
    base_ref: "master",
    base_sha: "basetip",
    merge_base: "forkpoint",
  };

  it(
    "puts the directive files and the git-picked mention on the order, deterministically and logged",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(70, "2026-08-13T10:00:00Z", { head: "sha70" });
      adapter.files.set(70, [file(".claude/skills/uja/SKILL.md"), file("src/app.py")]);
      const { hooks, orders } = recordingHooks();
      const lookups: Array<{ sha: string; paths: string[] }> = [];
      await dispatchOnce({
        cfg: baseCfg,
        store,
        adapter,
        hooks,
        prepareWorktree: async () => tree,
        directiveAuthor: async (sha, paths) => {
          lookups.push({ sha, paths });
          return { login: "alex", name: "Alex", email: "7+alex@users.noreply.github.com" };
        },
      });
      // The lookup runs at the MERGE BASE over the directive files only — the
      // PR's own commits can never elect the PR author as their own approver.
      expect(lookups).toEqual([{ sha: "forkpoint", paths: [".claude/skills/uja/SKILL.md"] }]);
      expect(orders[0]!.order.first_party_directives).toEqual({
        files: [".claude/skills/uja/SKILL.md"],
        mention: "alex",
      });
      const ev = store.db
        .prepare("SELECT payload FROM events WHERE kind = 'escalation_mention_selected'")
        .get() as { payload: string };
      expect(JSON.parse(ev.payload)).toMatchObject({
        mention: "alex",
        source: "git-log",
        sha: "forkpoint",
      });
    },
  );

  it(
    "falls back to config [review].escalation_mention_default when git yields no login",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(71, "2026-08-13T10:00:00Z", { head: "sha70" });
      adapter.files.set(71, [file("CLAUDE.md")]);
      const { hooks, orders } = recordingHooks();
      await dispatchOnce({
        cfg: baseCfg,
        store,
        adapter,
        hooks,
        prepareWorktree: async () => tree,
        directiveAuthor: async () => null,
      });
      expect(orders[0]!.order.first_party_directives).toEqual({
        files: ["CLAUDE.md"],
        mention: baseCfg.review.escalation_mention_default,
      });
      const ev = store.db
        .prepare("SELECT payload FROM events WHERE kind = 'escalation_mention_selected'")
        .get() as { payload: string };
      expect(JSON.parse(ev.payload)).toMatchObject({ source: "config-default" });
    },
  );

  it(
    "falls back to [owner] github_login when the [review] knob is unset",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const cfg = structuredClone(baseCfg);
      cfg.review.escalation_mention_default = "";
      queue(74, "2026-08-13T10:00:00Z", { head: "sha70" });
      adapter.files.set(74, [file("CLAUDE.md")]);
      const { hooks, orders } = recordingHooks();
      await dispatchOnce({
        cfg,
        store,
        adapter,
        hooks,
        prepareWorktree: async () => tree,
        directiveAuthor: async () => null,
      });
      expect(orders[0]!.order.first_party_directives).toEqual({
        files: ["CLAUDE.md"],
        mention: cfg.owner.github_login, // "example-owner" from the fixture
      });
    },
  );

  it(
    "degrades to the fallback — never a lost round — when the author lookup throws or is absent",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(72, "2026-08-13T10:00:00Z", { head: "sha70" });
      adapter.files.set(72, [file("prompts/system.md")]);
      const { hooks, orders } = recordingHooks();
      const dispatched = await dispatchOnce({
        cfg: baseCfg,
        store,
        adapter,
        hooks,
        prepareWorktree: async () => tree,
        directiveAuthor: async () => {
          throw new Error("git exploded");
        },
      });
      expect(dispatched).toHaveLength(1);
      expect(orders[0]!.order.first_party_directives!.mention).toBe(
        baseCfg.review.escalation_mention_default,
      );

      // No seam at all (stub-wired core): same fallback.
      queue(73, "2026-08-13T11:00:00Z", { head: "sha70" });
      adapter.files.set(73, [file("AGENTS.md")]);
      const second = recordingHooks();
      await dispatchOnce({ cfg: baseCfg, store, adapter, hooks: second.hooks });
      expect(second.orders[0]!.order.first_party_directives!.mention).toBe(
        baseCfg.review.escalation_mention_default,
      );
    },
  );

  it(
    "a PR touching no directive file carries no field and logs no pick",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(74, "2026-08-13T10:00:00Z", { head: "sha70" });
      adapter.files.set(74, [
        file("src/app.py"),
        file("backend/prompts/nested.md"),
        file("node_modules/x/CLAUDE.md"),
      ]);
      const { hooks, orders } = recordingHooks();
      await dispatchOnce({
        cfg: baseCfg,
        store,
        adapter,
        hooks,
        prepareWorktree: async () => tree,
        directiveAuthor: async () => ({ login: "alex", name: "Alex", email: "e" }),
      });
      expect(orders[0]!.order.first_party_directives).toBeUndefined();
      expect(
        store.db
          .prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'escalation_mention_selected'")
          .get(),
      ).toMatchObject({ c: 0 });
    },
  );
});

describe("system re-trigger short-circuit", () => {
  const OLD = "aaa1111111111111111111111111111111111111";
  const NEW = "bbb2222222222222222222222222222222222222";

  /** A prior VERDICTED round + the reviewed-head mark — the re-review shape. */
  function reviewed(pr: number, head: string, verdict = "APPROVE"): void {
    const id = store.startRound(pr, "first", ["pass-baseline"], 60);
    store.finishRound(id, verdict, null);
    store.recordReviewedHead(pr, { head_sha: head, verdict, round_no: 1 });
  }

  /** skip_unchanged_head OFF so the daemon's unchanged-head skip cannot mask
   * the short-circuit under test. */
  const cfg: Config = { ...baseCfg, guards: { ...baseCfg.guards, skip_unchanged_head: false } };

  function shortCircuitEvents(
    pr: number,
  ): Array<{ reason: string; delta_class: string; standing_verdict: string }> {
    return (
      store.db
        .prepare("SELECT payload FROM events WHERE pr = ? AND kind = 'dispatch_short_circuit'")
        .all(pr) as Array<{ payload: string }>
    ).map(
      (r) =>
        JSON.parse(r.payload) as { reason: string; delta_class: string; standing_verdict: string },
    );
  }

  it(
    "unchanged-head system re-trigger short-circuits — the #5308 r2 case",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(41, "2026-08-19T10:00:00Z", { head: OLD, provenance: "system" });
      reviewed(41, OLD, "APPROVE");
      const { hooks, orders } = recordingHooks();

      expect(await dispatchOnce({ cfg, store, adapter, hooks })).toEqual([]);

      expect(orders).toEqual([]);
      expect(store.priorRoundCount(41)).toBe(1); // no new round
      expect(store.getPr(41)!.state).toBe("tracked"); // as the APPROVE uphold leaves it
      expect(shortCircuitEvents(41)).toMatchObject([
        { reason: "unchanged-head", delta_class: "empty", standing_verdict: "APPROVE" },
      ]);
      // The trigger is consumed but the PR is never painted "in progress".
      const fns = adapter.calls.map((c) => `${c.fn}:${c.pr}`);
      expect(fns).toContain("removeLabel:41");
      expect(fns).toContain("deleteTeamReviewRequest:41");
      expect(adapter.calls.filter((c) => c.fn === "addLabel")).toEqual([]);
    },
  );

  it(
    "a clean base merge touching no PR-owned files short-circuits — the #5308 r6 case",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(42, "2026-08-19T10:00:00Z", { head: NEW, provenance: "system" });
      reviewed(42, OLD, "APPROVE");
      adapter.files.set(42, [file("mine.ts")]);
      adapter.compares.set(`${OLD}..${NEW}`, [
        file("base/other.py", 30, 4),
        file("base/second.py", 8, 1),
      ]);
      const { hooks, orders } = recordingHooks();

      expect(await dispatchOnce({ cfg: baseCfg, store, adapter, hooks })).toEqual([]);

      expect(orders).toEqual([]);
      expect(store.priorRoundCount(42)).toBe(1);
      expect(store.getPr(42)!.state).toBe("tracked");
      const [ev] = shortCircuitEvents(42);
      expect(ev).toMatchObject({
        reason: "trivial-delta",
        delta_class: "trivial",
        standing_verdict: "APPROVE",
      });
      // Terminal for this head: the reconcile push-backstop's exact fingerprint
      // is claimed, so the same question is never re-asked every sweep.
      expect(store.hasRecheck(42, recheckFingerprint({ trigger: "push" }, NEW))).toBe(true);
    },
  );

  // A compare GitHub truncated at 300 files,
  // or a PR file list cut at its cap, is not evidence of "base-merge only".
  it(
    "a truncated compare or PR file list never short-circuits the round",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(46, "2026-08-19T10:00:00Z", { head: NEW, provenance: "system" });
      reviewed(46, OLD, "APPROVE");
      adapter.files.set(46, [file("mine.ts")]);
      adapter.compares.set(
        `${OLD}..${NEW}`,
        Object.assign(
          Array.from({ length: 300 }, (_, i) => file(`base/f${i}.py`, 1, 1)),
          { truncated: true },
        ),
      );
      const { hooks, orders } = recordingHooks();
      expect(await dispatchOnce({ cfg: baseCfg, store, adapter, hooks })).toHaveLength(1);
      expect(orders).toHaveLength(1);
      expect(shortCircuitEvents(46)).toEqual([]);

      queue(47, "2026-08-19T10:00:00Z", { head: NEW, provenance: "system" });
      reviewed(47, OLD, "APPROVE");
      adapter.files.set(47, Object.assign([file("mine.ts")], { truncated: true }));
      adapter.compares.set(`${OLD}..${NEW}`, [file("owned_past_the_cap.py", 30, 4)]);
      expect(await dispatchOnce({ cfg: baseCfg, store, adapter, hooks })).toHaveLength(1);
      expect(shortCircuitEvents(47)).toEqual([]);
    },
  );

  // A push restoring a reviewed file to its base content drops it from the
  // current diff; ownership read only there would call the reversion a base
  // merge and skip the round.
  it(
    "a push reverting a reviewed file is never a base-merge short-circuit",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(47, "2026-08-19T10:00:00Z", { head: NEW, provenance: "system" });
      reviewed(47, OLD, "APPROVE");
      adapter.files.set(47, [file("api.py")]);
      adapter.compares.set(`master..${OLD}`, [file("auth.py"), file("api.py")]);
      adapter.compares.set(`${OLD}..${NEW}`, [file("auth.py", 0, 2)]);
      const { hooks, orders } = recordingHooks();

      expect(await dispatchOnce({ cfg: baseCfg, store, adapter, hooks })).toHaveLength(1);
      expect(orders).toHaveLength(1);
      expect(shortCircuitEvents(47)).toEqual([]);
    },
  );

  it(
    "a significant delta dispatches the full round as today",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(43, "2026-08-19T10:00:00Z", { head: NEW, provenance: "system" });
      reviewed(43, OLD, "APPROVE");
      adapter.files.set(43, [file("mine.ts")]);
      adapter.compares.set(`${OLD}..${NEW}`, [file("mine.ts", 12, 3)]); // PR-owned content change
      const { hooks, orders } = recordingHooks();

      expect(await dispatchOnce({ cfg: baseCfg, store, adapter, hooks })).toHaveLength(1);
      expect(orders).toHaveLength(1);
      expect(shortCircuitEvents(43)).toEqual([]);
    },
  );

  it(
    "human provenance never short-circuits, even on an empty delta",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(44, "2026-08-19T10:00:00Z", { head: NEW, provenance: "human" });
      reviewed(44, OLD, "APPROVE");
      const { hooks } = recordingHooks();
      expect(await dispatchOnce({ cfg: baseCfg, store, adapter, hooks })).toHaveLength(1);
      expect(shortCircuitEvents(44)).toEqual([]);
    },
  );

  it(
    "legacy null provenance never short-circuits (full round is the safe default)",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(45, "2026-08-19T10:00:00Z", { head: NEW, provenance: null });
      reviewed(45, OLD, "APPROVE");
      const { hooks } = recordingHooks();
      expect(await dispatchOnce({ cfg: baseCfg, store, adapter, hooks })).toHaveLength(1);
    },
  );

  it("first reviews never short-circuit", { timeout: HEAVY_TIMEOUT_MS }, async () => {
    queue(46, "2026-08-19T10:00:00Z", { head: NEW, provenance: "system" });
    const { hooks } = recordingHooks();
    expect(await dispatchOnce({ cfg: baseCfg, store, adapter, hooks })).toHaveLength(1);
    expect(shortCircuitEvents(46)).toEqual([]);
  });

  it(
    "a withheld approval at this head still dispatches — the CI-gate retry must post",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(47, "2026-08-19T10:00:00Z", { head: OLD, provenance: "system" });
      reviewed(47, OLD, "APPROVE");
      store.recordApprovalWithheld(47, { head_sha: OLD });
      const { hooks } = recordingHooks();
      expect(await dispatchOnce({ cfg, store, adapter, hooks })).toHaveLength(1);
      expect(shortCircuitEvents(47)).toEqual([]);
    },
  );

  it(
    "an author reply pending on the mark blocks the unchanged-head skip",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(48, "2026-08-19T10:00:00Z", { head: OLD, provenance: "system" });
      reviewed(48, OLD, "APPROVE");
      store.noteAuthorReply(48, "2099-01-01T00:00:00.000Z");
      const { hooks } = recordingHooks();
      expect(await dispatchOnce({ cfg, store, adapter, hooks })).toHaveLength(1);
      expect(shortCircuitEvents(48)).toEqual([]);
    },
  );

  it(
    "standing REQUEST_CHANGES short-circuits back to awaiting_author and claims no recheck",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(49, "2026-08-19T10:00:00Z", { head: NEW, provenance: "system" });
      reviewed(49, OLD, "REQUEST_CHANGES");
      const { hooks } = recordingHooks();

      expect(await dispatchOnce({ cfg: baseCfg, store, adapter, hooks })).toEqual([]);
      expect(store.getPr(49)!.state).toBe("awaiting_author");
      expect(shortCircuitEvents(49)).toMatchObject([
        { reason: "empty-delta", standing_verdict: "REQUEST_CHANGES" },
      ]);
      // The rechecks table is the post-approval recheck's guard — untouched here.
      expect(store.rechecksFor(49)).toEqual([]);
    },
  );

  it(
    "carries a withheld approval to the new head on a trivial short-circuit",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(50, "2026-08-19T10:00:00Z", { head: NEW, provenance: "system" });
      reviewed(50, OLD, "APPROVE");
      store.recordApprovalWithheld(50, { head_sha: OLD, ci_state: "red", reason: "red-ci" });
      const { hooks } = recordingHooks();

      expect(await dispatchOnce({ cfg: baseCfg, store, adapter, hooks })).toEqual([]);
      expect(store.approvalWithheld(50)).toMatchObject({ head_sha: NEW });
      // The push question is answered without a wake: claimed un-nudged, so
      // the undelivered sweep never releases it.
      expect(store.rechecksFor(50)).toMatchObject([
        { fingerprint: recheckFingerprint({ trigger: "push" }, NEW), nudged: 0 },
      ]);
      expect(store.rechecksFor(50)[0]?.reason).toMatch(/^dispatch-short-circuit:/);
      expect(
        store.db
          .prepare(
            "SELECT COUNT(*) AS c FROM events WHERE pr = 50 AND kind = 'approval_withheld_carried'",
          )
          .get(),
      ).toEqual({ c: 1 });
    },
  );

  it(
    "an existing recheck claim is left untouched — no double-claim against the recheck",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(51, "2026-08-19T10:00:00Z", { head: NEW, provenance: "system" });
      reviewed(51, OLD, "APPROVE");
      const fp = recheckFingerprint({ trigger: "push" }, NEW);
      store.claimRecheck(51, fp, { head_sha: NEW, trigger: "push", reason: "real-recheck" });
      const { hooks } = recordingHooks();

      expect(await dispatchOnce({ cfg: baseCfg, store, adapter, hooks })).toEqual([]);
      const claims = store.rechecksFor(51);
      expect(claims).toHaveLength(1);
      expect(claims[0]).toMatchObject({ fingerprint: fp, reason: "real-recheck" });
    },
  );

  it(
    "a failed compare read falls back to the full round",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(52, "2026-08-19T10:00:00Z", { head: NEW, provenance: "system" });
      reviewed(52, OLD, "APPROVE");
      adapter.failCompare = true;
      const { hooks } = recordingHooks();

      expect(await dispatchOnce({ cfg: baseCfg, store, adapter, hooks })).toHaveLength(1);
      expect(shortCircuitEvents(52)).toEqual([]);
      expect(
        store.db
          .prepare(
            "SELECT COUNT(*) AS c FROM events WHERE pr = 52 AND kind = 'dispatch_classifier_failed'",
          )
          .get(),
      ).toEqual({ c: 1 });
    },
  );

  it(
    "an adapter without the compare seam never short-circuits a moved head",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(53, "2026-08-19T10:00:00Z", { head: NEW, provenance: "system" });
      reviewed(53, OLD, "APPROVE");
      const legacy = new FakeAdapter();
      (legacy as { compareFiles?: unknown }).compareFiles = undefined;
      const { hooks } = recordingHooks();

      expect(await dispatchOnce({ cfg: baseCfg, store, adapter: legacy, hooks })).toHaveLength(1);
      expect(shortCircuitEvents(53)).toEqual([]);
    },
  );

  it(
    "a hand-resolved merge conflict in the delta classifies significant — full round",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(54, "2026-08-19T10:00:00Z", { head: NEW, provenance: "system" });
      reviewed(54, OLD, "APPROVE");
      adapter.files.set(54, [file("mine.ts")]);
      adapter.compares.set(`${OLD}..${NEW}`, [file("base/other.py", 30, 4)]);
      const { hooks } = recordingHooks();

      const orders = await dispatchOnce({
        cfg: baseCfg,
        store,
        adapter,
        hooks,
        resolvedFilesInMerges: async () => ({ files: ["base/other.py"], degraded: false }),
      });
      expect(orders).toHaveLength(1);
      expect(shortCircuitEvents(54)).toEqual([]);
    },
  );

  it(
    "a degraded merge-verify keeps the delta-only classification but is never quiet",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(55, "2026-08-19T10:00:00Z", { head: NEW, provenance: "system" });
      reviewed(55, OLD, "APPROVE");
      adapter.files.set(55, [file("mine.ts")]);
      adapter.compares.set(`${OLD}..${NEW}`, [file("base/other.py", 30, 4)]);
      const { hooks } = recordingHooks();

      const orders = await dispatchOnce({
        cfg: baseCfg,
        store,
        adapter,
        hooks,
        resolvedFilesInMerges: async () => ({ files: [], degraded: true }),
      });
      expect(orders).toEqual([]); // delta-only classification: trivial base-merge
      expect(shortCircuitEvents(55)).toMatchObject([{ reason: "trivial-delta" }]);
      expect(
        store.db
          .prepare(
            "SELECT COUNT(*) AS c FROM events WHERE pr = 55 AND kind = 'recheck_merge_verify_degraded'",
          )
          .get(),
      ).toEqual({ c: 1 });
    },
  );
});

// Round-memory seeding at dispatch: the pinned head and ONE budgeted
// context block reach the prompt, the call happens exactly once per round, and
// a memory outage can neither block nor delay a review.
describe("round-memory seeding", () => {
  const read = (text: string): MemoryRead => ({ status: "read", text });
  const unreadable = (reason: string): MemoryRead => ({ status: "unreadable", reason });

  class Assembler implements ContextAssembler {
    heads = 0;
    contexts = 0;
    queries: string[] = [];
    constructor(
      private readonly head: MemoryRead = read("STANDING: approvals are final."),
      private readonly block: MemoryRead = read("PRECEDENT: #4000 settled the retry budget."),
    ) {}
    async pinnedHead(): Promise<MemoryRead> {
      this.heads += 1;
      return this.head;
    }
    async contextBlock(query: string, _opts: { maxTokens: number }): Promise<MemoryRead> {
      this.contexts += 1;
      this.queries.push(query);
      return this.block;
    }
  }

  function anomalies(pr: number): string[] {
    return (
      store.db
        .prepare("SELECT payload FROM events WHERE pr = ? AND kind = 'anomaly'")
        .all(pr) as Array<{ payload: string }>
    ).map((r) => (JSON.parse(r.payload) as { kind: string }).kind);
  }

  function memoryEvents(pr: number): Array<Record<string, unknown>> {
    return (
      store.db
        .prepare("SELECT payload FROM events WHERE pr = ? AND kind = 'round_memory_seeded'")
        .all(pr) as Array<{
        payload: string;
      }>
    ).map((r) => JSON.parse(r.payload) as Record<string, unknown>);
  }

  it(
    "seeds the dispatched prompt with the head and the block, through the real template",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(70, "2026-08-20T09:00:00Z", { title: "Cap the retry budget" });
      adapter.files.set(70, [file("api/retries.py")]);
      const assembler = new Assembler();
      const { hooks, orders } = recordingHooks();
      const tpl = readFileSync(
        resolve(process.cwd(), "prompts", roundTemplateFile("first")),
        "utf8",
      );

      await dispatchOnce({
        cfg: baseCfg,
        store,
        adapter,
        hooks,
        memory: { assembler },
        renderPrompt: (o, mem) => renderRoundPrompt(tpl, o, mem),
      });

      expect(orders).toHaveLength(1);
      expect(orders[0]!.prompt).toContain("STANDING: approvals are final.");
      expect(orders[0]!.prompt).toContain("PRECEDENT: #4000 settled the retry budget.");
      // The query is derived from the PR's title and diff shape, at the sha the
      // worktree was prepared to.
      expect(assembler.queries[0]).toContain("Cap the retry budget");
      expect(assembler.queries[0]).toContain("api");
      expect(memoryEvents(70)).toMatchObject([
        { degraded: false, round_no: 1, head_state: "populated" },
      ]);
    },
  );

  it(
    "makes EXACTLY one context call per round — never one per pass, never two per round",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(71, "2026-08-20T09:00:00Z");
      queue(72, "2026-08-20T09:30:00Z");
      adapter.files.set(71, [
        file("a.ts"),
        file("b.ts"),
        file("ui/c.tsx"),
        file("migrations/0001_x.py"),
      ]);
      adapter.files.set(72, [file("d.ts")]);
      const assembler = new Assembler();
      const { hooks, orders } = recordingHooks();

      await dispatchOnce({ cfg: baseCfg, store, adapter, hooks, memory: { assembler } });

      expect(orders).toHaveLength(2);
      // Two rounds — two calls, whatever the pass plan looked like.
      expect(orders[0]!.order.pass_plan.length).toBeGreaterThan(2);
      expect(assembler.contexts).toBe(2);
      expect(assembler.heads).toBe(2);
    },
  );

  // The acceptance criterion: with the store unreachable the round still
  // renders and dispatches, memory-less, and it is not delayed while it waits.
  it(
    "dispatches memory-less and on time when the store never answers",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(73, "2026-08-20T09:00:00Z");
      adapter.files.set(73, [file("a.ts")]);
      const hung: ContextAssembler = {
        pinnedHead: () => new Promise(() => {}),
        contextBlock: () => new Promise(() => {}),
      };
      const { hooks, orders } = recordingHooks();
      const tpl = readFileSync(
        resolve(process.cwd(), "prompts", roundTemplateFile("first")),
        "utf8",
      );

      const seeded: RoundMemory[] = [];
      const started = Date.now();
      const dispatched = await dispatchOnce({
        cfg: baseCfg,
        store,
        adapter,
        hooks,
        memory: { assembler: hung, timeoutMs: 25, onSeeded: (m) => seeded.push(m) },
        renderPrompt: (o, mem) => renderRoundPrompt(tpl, o, mem),
      });
      const elapsed = Date.now() - started;

      // Dispatched, complete, and bounded by the memory deadline — not by the
      // store's silence.
      expect(dispatched).toHaveLength(1);
      expect(elapsed).toBeLessThan(2000);
      expect(orders[0]!.prompt).toContain("MEMORY UNAVAILABLE THIS ROUND");
      expect(orders[0]!.prompt).toContain("Run the full 7-step round");
      expect(store.getPr(73)!.state).toBe("reviewing");
      // Logged AND handed to memory health: the gap is never silent. The
      // timeout never reached any client observer — the seed callback is the
      // only place the monitor sees it.
      expect(memoryEvents(73)).toMatchObject([{ degraded: true }]);
      expect(seeded).toHaveLength(1);
      expect(seeded[0]).toMatchObject({ degraded: true });
      // No per-round anomaly: the health monitor owns telling a person.
      expect(anomalies(73)).toEqual([]);
    },
  );

  it(
    "a store that breaks its contract and throws still costs nothing but memory",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(74, "2026-08-20T09:00:00Z");
      adapter.files.set(74, [file("a.ts")]);
      const broken: ContextAssembler = {
        pinnedHead: () => Promise.reject(new Error("ECONNREFUSED 127.0.0.1:1933")),
        contextBlock: () => Promise.reject(new Error("ECONNREFUSED 127.0.0.1:1933")),
      };
      const { hooks, orders } = recordingHooks();

      await dispatchOnce({ cfg: baseCfg, store, adapter, hooks, memory: { assembler: broken } });

      expect(orders).toHaveLength(1);
      expect(memoryEvents(74)).toMatchObject([{ degraded: true }]);
      expect(JSON.stringify(memoryEvents(74)[0]!["gaps"])).toContain("ECONNREFUSED");
    },
  );

  // The path every adopter takes first: a healthy store with nothing
  // pinned yet. The round is seeded normally, told memory had nothing to add,
  // and the operator hears nothing — EMPTY IS NOT DEGRADED.
  it(
    "a fresh install (healthy store, nothing pinned) is NOT degraded: no unavailable note, no anomaly",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(78, "2026-08-20T09:00:00Z");
      adapter.files.set(78, [file("a.ts")]);
      const fresh = new Assembler(read(""), read(""));
      const { hooks, orders } = recordingHooks();
      const tpl = readFileSync(
        resolve(process.cwd(), "prompts", roundTemplateFile("first")),
        "utf8",
      );

      await dispatchOnce({
        cfg: baseCfg,
        store,
        adapter,
        hooks,
        memory: { assembler: fresh },
        renderPrompt: (o, mem) => renderRoundPrompt(tpl, o, mem),
      });

      expect(orders).toHaveLength(1);
      expect(orders[0]!.prompt).not.toContain("MEMORY UNAVAILABLE");
      expect(orders[0]!.prompt).not.toContain("STANDING INSTRUCTIONS");
      expect(orders[0]!.prompt).toContain("had nothing to add");
      expect(memoryEvents(78)).toMatchObject([
        { degraded: false, gaps: [], head_state: "empty", head_chars: 0, block_chars: 0 },
      ]);
      expect(anomalies(78)).toEqual([]);
    },
  );

  // Empty is not degraded, but one empty state must still be loud: a store
  // that answers "nothing pinned" on an install whose previous round carried
  // standing instructions (a container recreated without its volume). The
  // transition itself gets one anomaly; a fresh install never sees it, and it
  // never repeats.
  it(
    "populated → empty with the store readable raises pinned_head_emptied exactly once",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const tpl = readFileSync(
        resolve(process.cwd(), "prompts", roundTemplateFile("first")),
        "utf8",
      );
      const { hooks, orders } = recordingHooks();
      const injected: string[] = [];
      store.setAnomalySink((signal) => injected.push(signal.injectMessage ?? ""));
      const run = async (pr: number, ts: string, assembler: ContextAssembler) => {
        queue(pr, ts);
        adapter.files.set(pr, [file("a.ts")]);
        await dispatchOnce({
          cfg: baseCfg,
          store,
          adapter,
          hooks,
          memory: { assembler },
          renderPrompt: (o, mem) => renderRoundPrompt(tpl, o, mem),
        });
      };

      await run(80, "2026-08-20T09:00:00Z", new Assembler());
      expect(anomalies(80)).toEqual([]);

      // The volume is gone: the store is up and answers "nothing pinned".
      await run(81, "2026-08-20T09:10:00Z", new Assembler(read(""), read("")));
      expect(memoryEvents(81)).toMatchObject([{ degraded: false, head_state: "empty" }]);
      expect(anomalies(81)).toEqual(["pinned_head_emptied"]);
      expect(injected).toHaveLength(1);
      expect(injected[0]).toContain("pinned area is EMPTY");
      expect(injected[0]).toContain("#80");
      expect(injected[0]).toContain(String("STANDING: approvals are final.".length));
      // The round itself was normal: no unavailable note, dispatched.
      expect(orders[1]!.prompt).not.toContain("MEMORY UNAVAILABLE");

      // Still empty next round: the baseline is now the empty row — no repeat.
      await run(82, "2026-08-20T09:20:00Z", new Assembler(read(""), read("")));
      expect(anomalies(82)).toEqual([]);
      expect(injected).toHaveLength(1);
    },
  );

  it(
    "an unreadable round between the two does not hide the transition — the baseline is the last READ head",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const { hooks } = recordingHooks();
      const run = async (pr: number, ts: string, assembler: ContextAssembler) => {
        queue(pr, ts);
        adapter.files.set(pr, [file("a.ts")]);
        await dispatchOnce({ cfg: baseCfg, store, adapter, hooks, memory: { assembler } });
      };
      await run(83, "2026-08-20T09:00:00Z", new Assembler());
      await run(
        84,
        "2026-08-20T09:10:00Z",
        new Assembler(unreadable("connect ECONNREFUSED"), read("")),
      );
      // The unreadable round is recorded (and told to memory health), but
      // raises no per-round anomaly.
      expect(memoryEvents(84)).toMatchObject([{ degraded: true, head_state: "unread" }]);
      expect(anomalies(84)).toEqual([]);
      await run(85, "2026-08-20T09:20:00Z", new Assembler(read(""), read("")));
      expect(anomalies(85)).toEqual(["pinned_head_emptied"]);
    },
  );

  it(
    "an UNREADABLE store still degrades, tells memory health what is missing, and raises no per-round anomaly",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(79, "2026-08-20T09:00:00Z");
      adapter.files.set(79, [file("a.ts")]);
      const dead = new Assembler(
        unreadable("ls viking://user/reviewer/memories: connect ECONNREFUSED 127.0.0.1:1933"),
        read(""),
      );
      const { hooks, orders } = recordingHooks();
      const tpl = readFileSync(
        resolve(process.cwd(), "prompts", roundTemplateFile("first")),
        "utf8",
      );
      const injected: string[] = [];
      store.setAnomalySink((signal) => injected.push(signal.injectMessage ?? ""));
      const seeded: RoundMemory[] = [];

      await dispatchOnce({
        cfg: baseCfg,
        store,
        adapter,
        hooks,
        memory: { assembler: dead, onSeeded: (m) => seeded.push(m) },
        renderPrompt: (o, mem) => renderRoundPrompt(tpl, o, mem),
      });

      expect(orders).toHaveLength(1);
      expect(orders[0]!.prompt).toContain("MEMORY UNAVAILABLE THIS ROUND");
      expect(store.getPr(79)!.state).toBe("reviewing");
      expect(memoryEvents(79)).toMatchObject([
        {
          degraded: true,
          head_state: "unread",
          gaps: [{ part: "head", reason: expect.stringContaining("unreadable: ls viking://") }],
        },
      ]);
      // What memory health is told names what is actually missing — here the
      // head only; the context search answered (with nothing), so it is not
      // claimed lost — and carries the reason.
      expect(seeded).toHaveLength(1);
      expect(seeded[0]!.gaps).toEqual([
        { part: "head", reason: expect.stringContaining("ECONNREFUSED") },
      ]);
      // The operator hears it from the health monitor on a TRANSITION, not
      // from dispatch once per round.
      expect(anomalies(79)).toEqual([]);
      expect(injected).toEqual([]);
    },
  );

  it(
    "publishes the round's own context query as the PR session's recall hint, before memory is asked",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(88, "2026-08-20T09:00:00Z");
      adapter.files.set(88, [file("backend/app/views.py"), file("backend/app/urls.py")]);
      const { hooks, orders } = recordingHooks();
      const asm = new Assembler();
      const published: Array<{ pr: number; query: string; asked: number }> = [];
      await dispatchOnce({
        cfg: baseCfg,
        store,
        adapter,
        hooks,
        memory: {
          assembler: asm,
          publishQuery: (pr, query) => published.push({ pr, query, asked: asm.contexts }),
        },
      });
      expect(orders).toHaveLength(1);
      // The same query the round's context block is asked for — PR-derived
      // (title + diff shape), published before the store is consulted.
      expect(published).toEqual([{ pr: 88, query: asm.queries[0]!, asked: 0 }]);
      expect(published[0]!.query).toContain("backend/app");
    },
  );

  it(
    "a throwing recall-hint publisher costs nothing: the round still seeds and dispatches",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(89, "2026-08-20T09:00:00Z");
      adapter.files.set(89, [file("a.ts")]);
      const { hooks, orders } = recordingHooks();
      const asm = new Assembler();
      await dispatchOnce({
        cfg: baseCfg,
        store,
        adapter,
        hooks,
        memory: {
          assembler: asm,
          publishQuery: () => {
            throw new Error("disk full");
          },
        },
      });
      expect(orders).toHaveLength(1);
      expect(asm.contexts).toBe(1);
      expect(memoryEvents(89)).toHaveLength(1);
    },
  );

  it(
    "a throwing health observer costs nothing: the round still dispatches",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(86, "2026-08-20T09:00:00Z");
      adapter.files.set(86, [file("a.ts")]);
      const { hooks, orders } = recordingHooks();
      await dispatchOnce({
        cfg: baseCfg,
        store,
        adapter,
        hooks,
        memory: {
          assembler: new Assembler(),
          onSeeded: () => {
            throw new Error("observer bug");
          },
        },
      });
      expect(orders).toHaveLength(1);
      expect(memoryEvents(86)).toHaveLength(1);
    },
  );

  it(
    "while the store stays down the per-round record does not thin, and dispatch itself raises no memory anomaly",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const down = new Assembler(
        unreadable("connect ECONNREFUSED"),
        unreadable("connect ECONNREFUSED"),
      );
      const { hooks } = recordingHooks();
      for (const [pr, ts] of [
        [75, "2026-08-20T09:00:00Z"],
        [76, "2026-08-20T09:10:00Z"],
      ] as const) {
        queue(pr, ts);
        adapter.files.set(pr, [file("a.ts")]);
      }

      const seeded: RoundMemory[] = [];
      await dispatchOnce({
        cfg: baseCfg,
        store,
        adapter,
        hooks,
        memory: { assembler: down, onSeeded: (m) => seeded.push(m) },
      });

      expect(memoryEvents(75)).toHaveLength(1);
      expect(memoryEvents(76)).toHaveLength(1);
      // Every round reaches memory health; the bounding of the ALERT is the
      // monitor's (transition + every 6 h), not dispatch's.
      expect(seeded.map((m) => m.degraded)).toEqual([true, true]);
      expect(
        store.db.prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'anomaly'").get(),
      ).toEqual({ c: 0 });
    },
  );

  it(
    "with no memory wired at all, dispatch behaves exactly as before",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(77, "2026-08-20T09:00:00Z");
      adapter.files.set(77, [file("a.ts")]);
      const { hooks, orders } = recordingHooks();
      const tpl = readFileSync(
        resolve(process.cwd(), "prompts", roundTemplateFile("first")),
        "utf8",
      );

      await dispatchOnce({
        cfg: baseCfg,
        store,
        adapter,
        hooks,
        renderPrompt: (o, mem) => renderRoundPrompt(tpl, o, mem),
      });

      expect(orders).toHaveLength(1);
      expect(orders[0]!.prompt).not.toContain("STANDING INSTRUCTIONS");
      expect(orders[0]!.prompt).not.toContain("MEMORY UNAVAILABLE");
      expect(memoryEvents(77)).toEqual([]);
    },
  );
});

// ---- dispatch decides on a snapshot the webhook can move --------------------

describe("a newer push/re-request during trigger consumption is never settled away", () => {
  /** An adapter whose team-request DELETE lets a webhook land first: the
   * author pushes H2 and re-requests review while dispatch awaits GitHub. */
  class RacingAdapter extends FakeAdapter {
    onDelete: (() => void) | undefined;
    override async deleteTeamReviewRequest(n: number): Promise<GateResult> {
      this.onDelete?.();
      this.onDelete = undefined;
      return super.deleteTeamReviewRequest(n);
    }
  }
  const moveTo = (pr: number, head: string, ts: string) => () =>
    store.upsertPr({
      number: pr,
      state: "queued",
      head_sha: head,
      title: `PR ${pr}`,
      author: "alice",
      trigger_ts: ts,
      trigger_provenance: "human",
      stale_recheck: 0,
      migration_gate: 0,
    });

  it(
    "no-new-evidence skip: the PR stays queued at the new head with its trigger",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(91, "2026-09-30T09:00:00Z", { head: "h1" });
      store.recordReviewedHead(91, { head_sha: "h1", verdict: "REQUEST_CHANGES", round_no: 1 });
      const racing = new RacingAdapter();
      racing.onDelete = moveTo(91, "h2", "2026-09-30T09:00:05Z");
      const { hooks } = recordingHooks();

      await dispatchOnce({ cfg: baseCfg, store, adapter: racing, hooks });

      const row = store.getPr(91)!;
      expect(row.state).toBe("queued");
      expect(row.head_sha).toBe("h2");
      expect(row.trigger_ts).toBe("2026-09-30T09:00:05Z");
    },
  );

  it(
    "system short-circuit: the PR stays queued at the new head with its trigger",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const cfg: Config = { ...baseCfg, guards: { ...baseCfg.guards, skip_unchanged_head: false } };
      queue(92, "2026-09-30T09:00:00Z", { head: "h1", provenance: "system" });
      const id = store.startRound(92, "first", ["pass-baseline"], 60);
      store.finishRound(id, "APPROVE", null);
      store.recordReviewedHead(92, { head_sha: "h1", verdict: "APPROVE", round_no: 1 });
      const racing = new RacingAdapter();
      racing.onDelete = moveTo(92, "h2", "2026-09-30T09:00:05Z");
      const { hooks } = recordingHooks();

      await dispatchOnce({ cfg, store, adapter: racing, hooks });

      const row = store.getPr(92)!;
      expect(row.state).toBe("queued");
      expect(row.head_sha).toBe("h2");
      expect(row.trigger_ts).toBe("2026-09-30T09:00:05Z");
    },
  );
});

describe("a person's re-request that only upgrades the provenance during consumption", () => {
  // MUTATION: drop the provenance comparison from movedDuringConsume — the
  // short-circuit settles the PR and the person's ask never gets its round.
  it(
    "is never settled away by the system short-circuit: the next pump runs the round",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const cfg: Config = { ...baseCfg, guards: { ...baseCfg.guards, skip_unchanged_head: false } };
      queue(94, "2026-09-30T09:00:00Z", { head: "h1", provenance: "system" });
      const id = store.startRound(94, "first", ["pass-baseline"], 60);
      store.finishRound(id, "APPROVE", null);
      store.recordReviewedHead(94, { head_sha: "h1", verdict: "APPROVE", round_no: 1 });
      // The statemachine keeps a queued row's trigger time and upgrades only
      // its provenance when a person asks.
      class Upgrading extends FakeAdapter {
        upgraded = false;
        override async deleteTeamReviewRequest(n: number): Promise<GateResult> {
          if (!this.upgraded) {
            this.upgraded = true;
            store.upsertPr({ ...store.getPr(94)!, trigger_provenance: "human" });
          }
          return super.deleteTeamReviewRequest(n);
        }
      }
      const racing = new Upgrading();
      racing.files.set(94, [file("a.py")]);
      const { hooks, orders } = recordingHooks();

      expect(await dispatchOnce({ cfg, store, adapter: racing, hooks })).toEqual([]);
      expect(store.getPr(94)).toMatchObject({ state: "queued", trigger_provenance: "human" });

      await dispatchOnce({ cfg, store, adapter: racing, hooks });
      expect(orders).toHaveLength(1);
      expect(orders[0]!.order.head_sha).toBe("h1");
    },
  );
});

describe("a settlement without a round answers its head, and only while the row is still its to decide", () => {
  const OLD = "aaa1111111111111111111111111111111111111";
  const NEW = "bbb2222222222222222222222222222222222222";
  const owe = (pr: number, head: string): void => {
    const id = store.roundsFor(pr)[0]!.id;
    store.recordSuccessor({
      pr,
      predecessor_round_id: id,
      head_sha: head,
      provenance: "system",
      reason: "test",
    });
  };
  const events = (kind: string, pr: number): Array<Record<string, unknown>> =>
    (
      store.db
        .prepare("SELECT payload FROM events WHERE pr = ? AND kind = ?")
        .all(pr, kind) as Array<{ payload: string }>
    ).map((r) => JSON.parse(r.payload) as Record<string, unknown>);

  // MUTATION: drop settleSuccessor from the short-circuit — the obligation
  // stands and reconcile promotes the same head again on its next pass.
  it(
    "the system short-circuit settles the successor owed at the head it answers",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(140, "2026-08-19T10:00:00Z", { head: NEW, provenance: "system" });
      const id = store.startRound(140, "first", ["pass-baseline"], 60);
      store.finishRound(id, "APPROVE", null);
      store.recordReviewedHead(140, { head_sha: OLD, verdict: "APPROVE", round_no: 1 });
      owe(140, NEW);
      adapter.files.set(140, [file("mine.ts")]);
      adapter.compares.set(`${OLD}..${NEW}`, [file("base/other.py", 30, 4)]);
      const { hooks, orders } = recordingHooks();

      await dispatchOnce({ cfg: baseCfg, store, adapter, hooks });

      expect(orders).toEqual([]);
      expect(store.getPr(140)!.state).toBe("tracked");
      expect(store.successorFor(140)).toBeUndefined();
      expect(store.promoteSuccessor(140)).toBe(false);
    },
  );

  // MUTATION: drop settleSuccessor from the no-new-evidence skip.
  it(
    "the no-new-evidence skip settles the successor owed at its head",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(141, "2026-08-19T10:00:00Z", { head: "h1" });
      const id = store.startRound(141, "first", ["pass-baseline"], 60);
      store.finishRound(id, "REQUEST_CHANGES", null);
      store.recordReviewedHead(141, { head_sha: "h1", verdict: "REQUEST_CHANGES", round_no: 1 });
      owe(141, "h1");
      const { hooks, orders } = recordingHooks();

      await dispatchOnce({ cfg: baseCfg, store, adapter, hooks });

      expect(orders).toEqual([]);
      expect(store.getPr(141)!.state).toBe("awaiting_author");
      expect(store.successorFor(141)).toBeUndefined();
    },
  );

  // MUTATION: drop the queued-state check from movedDuringConsume — the skip
  // records a decision for a PR that closed meanwhile.
  it(
    "a PR closed during the consumption is not settled by the skip",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(142, "2026-08-19T10:00:00Z", { head: "h1" });
      store.recordReviewedHead(142, { head_sha: "h1", verdict: "REQUEST_CHANGES", round_no: 1 });
      class Closing extends FakeAdapter {
        override async deleteTeamReviewRequest(n: number): Promise<GateResult> {
          store.setPrState(142, "closed");
          return super.deleteTeamReviewRequest(n);
        }
      }
      const { hooks } = recordingHooks();

      await dispatchOnce({ cfg: baseCfg, store, adapter: new Closing(), hooks });

      expect(store.getPr(142)!.state).toBe("closed");
      expect(events("round_skipped_no_new_evidence", 142)).toEqual([]);
      expect(events("dispatch_settlement_superseded", 142)).toEqual([
        expect.objectContaining({ reason: "left_queue" }),
      ]);
    },
  );

  // MUTATION: drop the evidence re-read after the skip's consumption — the
  // author's reply is settled away and the PR returns to awaiting_author.
  it(
    "an author reply during the skip's consumption leaves the PR queued for the round it now owes",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(143, "2026-08-19T10:00:00Z", { head: "h1", provenance: "human" });
      const id = store.startRound(143, "first", ["pass-baseline"], 60);
      store.finishRound(id, "REQUEST_CHANGES", null);
      store.recordReviewedHead(143, { head_sha: "h1", verdict: "REQUEST_CHANGES", round_no: 1 });
      class Replying extends FakeAdapter {
        override async deleteTeamReviewRequest(n: number): Promise<GateResult> {
          store.noteAuthorReply(143, "2099-01-01T00:00:00.000Z");
          return super.deleteTeamReviewRequest(n);
        }
      }
      const racing = new Replying();
      racing.files.set(143, [file("a.py")]);
      const { hooks, orders } = recordingHooks();

      expect(await dispatchOnce({ cfg: baseCfg, store, adapter: racing, hooks })).toEqual([]);
      expect(store.getPr(143)!.state).toBe("queued");
      expect(events("round_skipped_no_new_evidence", 143)).toEqual([]);

      await dispatchOnce({ cfg: baseCfg, store, adapter: racing, hooks });
      expect(orders).toHaveLength(1);
    },
  );
});

describe("a later round with no git seam is today's full re-review, said out loud", () => {
  it(
    "logs followup_full_round {reason: no-adapter}, stamps scope full, and the order carries no follow-up field",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(77, "2026-10-08T10:00:00Z", { head: "h2" });
      const first = store.startRound(77, "first", ["pass-baseline"], 60);
      store.finishRound(first, "REQUEST_CHANGES", null);
      store.recordReviewedHead(77, { head_sha: "h1", verdict: "REQUEST_CHANGES", round_no: 1 });
      adapter.files.set(77, [file("a.py")]);
      const { hooks, orders } = recordingHooks();
      await dispatchOnce({ cfg: baseCfg, store, adapter, hooks });
      expect(orders).toHaveLength(1);
      expect(orders[0]!.order.round_type).toBe("re-review");
      expect(orders[0]!.order.scope).toBeUndefined();
      expect(store.roundsFor(77).at(-1)).toMatchObject({ scope: "full", head_sha: "h2" });
      const ev = store.db
        .prepare("SELECT payload FROM events WHERE pr = 77 AND kind = 'followup_full_round'")
        .all() as Array<{ payload: string }>;
      expect(ev.map((e) => JSON.parse(e.payload).reason)).toEqual(["no-adapter"]);
    },
  );
});

describe("the round's file facts describe the prepared head", () => {
  it(
    "a push landing before the worktree fetch is planned from the prepared head's files",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(93, "2026-09-30T09:00:00Z", { head: "h1" });
      adapter.files.set(93, [file("src/views.py")]);
      const { hooks } = recordingHooks();
      const [order] = await dispatchOnce({
        cfg: baseCfg,
        store,
        adapter,
        hooks,
        // The push adds a migration; the worktree fetch sees it.
        prepareWorktree: async () => {
          adapter.files.set(93, [file("src/views.py"), file("app/migrations/0042_x.py")]);
          return { head_sha: "h2", base_ref: "master", base_sha: "b", merge_base: "m" };
        },
      });
      expect(order!.head_sha).toBe("h2");
      expect(order!.migration_gate).toBe(true);
    },
  );
});
