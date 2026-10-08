// H3 — round seeds stop running memory-less.
//
// The 2026-10-08 health check: 3 of 15 round seeds since boot (5 of 32 since
// the profile deploy) ran with NO memory, each logging "context unreadable
// (search transport: timeout)". In the three logged today, a case-writer
// batch was SENT 1–3 s before the seed (08:33:38.6 → seed 08:33:39.2, both
// backfill cases; 09:08:14.9 → 09:08:17.6, backfill again), and OpenViking
// embeds a written batch AFTER the write returns, on the one-thread local
// embedder: the seed's query (request 62856040) finished 8.5 s after it was
// sent, 6 s after the daemon's 2.5 s search timeout gave up. F2's round
// window only stops a batch STARTING once a seed has begun.
//
// The fix, one block per acceptance criterion:
//
//   1. With a review round running or queued, the case writer runs no
//      backfill and no late-activity step and writes no history case; it
//      resumes when no round is in flight — in tests/memory-cases.test.ts
//      beside the writer's other tests, with `reviewsInFlight` here.
//   2. A batch just written holds a seed's search for the batch's EMBEDDING
//      TAIL — inside the seed's (longer) budget, never past it: the
//      round-activity tracker, the assembly, dispatch, the OpenViking
//      assembler's per-request bound.
//   3. The budgets are longer, bounded and named in config.example.toml; a
//      search past the budget still leaves the round memory-less, logged.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CASE_DEFAULTS } from "../src/cases.js";
import {
  CASE_EMBED_TAIL_MAX_MS,
  CONTEXT_TIMEOUT_BOUNDS_MS,
  HEALTH_TIMEOUT_BOUNDS_MS,
  MEMORY_DEFAULTS,
  OPENVIKING_DEFAULTS,
  SEARCH_TIMEOUT_BOUNDS_MS,
  loadConfig,
  parseConfig,
  parseMemory,
  parseOpenViking,
  type Config,
} from "../src/config.js";
import { dispatchOnce, reviewsInFlight, type DispatchAdapter } from "../src/dispatch.js";
import type { GateResult } from "../src/gate.js";
import type { PrFileEntry } from "../src/github.js";
import {
  ROUND_CONTEXT_DEFAULTS,
  assembleRoundMemory,
  type ContextAssembler,
  type MemoryRead,
} from "../src/memory/context.js";
import { EMBEDDING_TAIL_MAX_MS, RoundMemoryActivity } from "../src/memory/roundactivity.js";
import {
  DEFAULT_SEARCH_TIMEOUT_MS,
  OpenVikingContextAssembler,
} from "../src/openviking/context.js";
import { StateStore } from "../src/state.js";
import type { SessionHooks } from "../src/types.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const never = <T>(): Promise<T> => new Promise<T>(() => {});
const read = (text: string): MemoryRead => ({ status: "read", text });

afterEach(() => vi.useRealTimers());

// ---- 2. the embedding tail, on the round-activity tracker --------------------------------

describe("RoundMemoryActivity — the case writer's embedding tail (H3)", () => {
  it("quiet with no batch: answers 0 at once, and busy-for is 0", async () => {
    const a = new RoundMemoryActivity();
    expect(a.embedderBusyForMs()).toBe(0);
    await expect(a.whenEmbedderQuiet(5000)).resolves.toBe(0);
  });

  it("a batch still out has no known end; once it settles, the tail runs from THEN", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-08T08:33:38.600Z") });
    const a = new RoundMemoryActivity();
    const settle = a.embeddingSent();
    expect(a.embedderBusyForMs()).toBeNull();
    let waited: number | null = null;
    void a.whenEmbedderQuiet(20_000).then((ms) => (waited = ms));
    // The write is out for 2 s (the 08:33 batch's write took 2.07 s)…
    await vi.advanceTimersByTimeAsync(2000);
    expect(waited).toBeNull();
    // …returns, and the server goes on embedding its two cases for ~8 s.
    settle(8000);
    expect(a.embedderBusyForMs()).toBe(8000);
    await vi.advanceTimersByTimeAsync(7999);
    expect(waited).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(waited).toBe(10_000);
    expect(a.embedderBusyForMs()).toBe(0);
    // Quiet now: the next seed does not wait at all.
    await expect(a.whenEmbedderQuiet(20_000)).resolves.toBe(0);
  });

  it("never waits past the caller's bound — a tail longer than it, or a batch never settled", async () => {
    vi.useFakeTimers();
    const a = new RoundMemoryActivity();
    a.embeddingSent()(30_000);
    let waited: number | null = null;
    void a.whenEmbedderQuiet(6000).then((ms) => (waited = ms));
    await vi.advanceTimersByTimeAsync(6000);
    expect(waited).toBe(6000);

    const b = new RoundMemoryActivity();
    b.embeddingSent(); // never settled: a write whose answer never came
    let held: number | null = null;
    void b.whenEmbedderQuiet(1500).then((ms) => (held = ms));
    await vi.advanceTimersByTimeAsync(1500);
    expect(held).toBe(1500);
    // A zero bound never waits, whatever is out.
    await expect(b.whenEmbedderQuiet(0)).resolves.toBe(0);
    await expect(b.whenEmbedderQuiet(Number.NaN)).resolves.toBe(0);
  });

  it("two batches: the longer tail wins; each settle is idempotent; an absurd tail is capped", async () => {
    vi.useFakeTimers();
    const a = new RoundMemoryActivity();
    const s1 = a.embeddingSent();
    const s2 = a.embeddingSent();
    s1(4000);
    // One batch still out: no known end yet.
    expect(a.embedderBusyForMs()).toBeNull();
    s1(60_000); // a second settle of the same batch changes nothing
    s2(1000);
    expect(a.embedderBusyForMs()).toBe(4000);
    a.embeddingSent()(10 * EMBEDDING_TAIL_MAX_MS);
    expect(a.embedderBusyForMs()).toBe(EMBEDDING_TAIL_MAX_MS);
    a.embeddingSent()(Number.NaN);
    expect(a.embedderBusyForMs()).toBe(EMBEDDING_TAIL_MAX_MS);
  });

  it("the tail runs on a MONOTONIC clock: a wall clock stepped back after the batch neither stretches it nor holds seeds", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-08T09:08:15.000Z") });
    const a = new RoundMemoryActivity();
    a.embeddingSent()(8000);
    // NTP steps the wall clock an hour back the moment the write returns.
    vi.setSystemTime(new Date("2026-10-08T08:08:15.000Z"));
    expect(a.embedderBusyForMs()).toBe(8000);
    let waited: number | null = null;
    void a.whenEmbedderQuiet(20_000).then((ms) => (waited = ms));
    await vi.advanceTimersByTimeAsync(8000);
    expect(waited).toBe(8000);
    await expect(a.whenEmbedderQuiet(20_000)).resolves.toBe(0);

    // An injected clock that steps back is still capped at one tail's worth.
    let t = 1_000_000;
    const b = new RoundMemoryActivity({ now: () => t });
    b.embeddingSent()(4000);
    t -= 3_600_000;
    expect(b.embedderBusyForMs()).toBe(EMBEDDING_TAIL_MAX_MS);
  });

  it("the tail is independent of the windows: a window never waits on it, and it never holds a case batch", async () => {
    const a = new RoundMemoryActivity();
    a.embeddingSent()(60_000);
    expect(a.busy()).toBe(false);
    await expect(a.whenIdle(10)).resolves.toBe(true);
  });
});

// ---- 2. the seed waits for the tail, inside its budget ---------------------------------

describe("assembleRoundMemory — the context search waits for the embedding tail, inside the budget", () => {
  /** An assembler that records WHEN (fake ms) each method was asked, and with
   * what. */
  function recorder(block: () => Promise<MemoryRead>) {
    const asked: { head?: number; block?: number; opts?: Record<string, unknown> } = {};
    const assembler: ContextAssembler = {
      pinnedHead: async () => {
        asked.head = Date.now();
        return read("");
      },
      contextBlock: async (_q, opts) => {
        asked.block = Date.now();
        asked.opts = { ...opts };
        return block();
      },
    };
    return { assembler, asked };
  }

  it("a batch written just before the seed: the head is read at once, the search sent once the tail ran out, the time left handed on", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const a = new RoundMemoryActivity();
    a.embeddingSent()(5000); // the batch's write just returned: ~5 s of embedding left
    const { assembler, asked } = recorder(async () => read("LESSONS"));
    const mem = await (async () => {
      const p = assembleRoundMemory(assembler, "q", {
        maxTokens: 100,
        timeoutMs: 9000,
        quiet: (max) => a.whenEmbedderQuiet(max),
      });
      await vi.advanceTimersByTimeAsync(9000);
      return p;
    })();
    expect(asked.head).toBe(1_000_000);
    expect(asked.block).toBe(1_005_000);
    expect(asked.opts).toEqual({ maxTokens: 100, timeoutMs: 4000 });
    expect(mem).toMatchObject({ block: "LESSONS", degraded: false, quiet_wait_ms: 5000 });
    expect(mem.ms).toBe(5000);
  });

  it("a tail longer than the budget allows: the search keeps its reserve — sent at budget − reserve — and a search that then hangs leaves the round memory-less AT the budget, logged", async () => {
    vi.useFakeTimers({ now: 2_000_000 });
    const a = new RoundMemoryActivity();
    a.embeddingSent()(30_000);
    const logs: string[] = [];
    const { assembler, asked } = recorder(() => never());
    const p = assembleRoundMemory(assembler, "q", {
      maxTokens: 100,
      timeoutMs: 9000,
      quiet: (max) => a.whenEmbedderQuiet(max),
      log: (m) => logs.push(m),
    });
    let settled = false;
    void p.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(8999);
    expect(settled).toBe(false);
    expect(asked.block).toBe(2_000_000 + 9000 - ROUND_CONTEXT_DEFAULTS.searchReserveMs);
    expect(asked.opts).toMatchObject({ timeoutMs: ROUND_CONTEXT_DEFAULTS.searchReserveMs });
    await vi.advanceTimersByTimeAsync(1);
    const mem = await p;
    // Never past the budget, and the unchanged contract: memory-less, a gap,
    // a log line.
    expect(mem.ms).toBe(9000);
    expect(mem).toMatchObject({
      degraded: true,
      block: "",
      gaps: [{ part: "context", reason: "timeout" }],
      quiet_wait_ms: 9000 - ROUND_CONTEXT_DEFAULTS.searchReserveMs,
    });
    expect(logs).toContain("memory: context timed out after 9000ms — round proceeds memory-less");
    expect(logs.some((l) => /waited 6000ms for the case writer's embedding tail/.test(l))).toBe(
      true,
    );
  });

  it("a budget at or under the reserve never waits — the live config's 3000 ms seeds exactly as before", async () => {
    vi.useFakeTimers({ now: 3_000_000 });
    let asked = 0;
    const quiet = async (max: number) => {
      asked += 1;
      return max;
    };
    const { assembler, asked: at } = recorder(async () => read("B"));
    const mem = await assembleRoundMemory(assembler, "q", {
      maxTokens: 10,
      timeoutMs: 3000,
      quiet,
    });
    expect(asked).toBe(0);
    expect(at.block).toBe(3_000_000);
    expect(at.opts).toEqual({ maxTokens: 10, timeoutMs: 3000 });
    expect(mem.quiet_wait_ms).toBe(0);
  });

  it("no tracker: asked exactly as before, no wait field; a wait that throws or answers nonsense is no wait", async () => {
    const { assembler, asked } = recorder(async () => read("B"));
    const plain = await assembleRoundMemory(assembler, "q", { maxTokens: 10, timeoutMs: 9000 });
    expect(asked.opts).toEqual({ maxTokens: 10 });
    expect(plain).not.toHaveProperty("quiet_wait_ms");

    for (const quiet of [
      () => Promise.reject(new Error("tracker broke")),
      () => {
        throw new Error("tracker broke synchronously");
      },
      async () => Number.NaN,
      async () => "soon" as unknown as number,
    ]) {
      const r = recorder(async () => read("B"));
      const mem = await assembleRoundMemory(r.assembler, "q", {
        maxTokens: 10,
        timeoutMs: 9000,
        quiet: quiet as (max: number) => Promise<number>,
      });
      expect(mem).toMatchObject({ block: "B", degraded: false, quiet_wait_ms: 0 });
    }
  });

  it("a wait that never answers is still bounded by the seed's deadline, and the search is never sent late", async () => {
    vi.useFakeTimers({ now: 4_000_000 });
    const { assembler, asked } = recorder(async () => read("B"));
    const p = assembleRoundMemory(assembler, "q", {
      maxTokens: 10,
      timeoutMs: 9000,
      quiet: () => never(),
    });
    await vi.advanceTimersByTimeAsync(9000);
    const mem = await p;
    expect(mem).toMatchObject({ degraded: true, gaps: [{ part: "context", reason: "timeout" }] });
    expect(mem.ms).toBe(9000);
    expect(asked.block).toBeUndefined();
    // The record says the seed spent its budget waiting, not that it never did.
    expect(mem.quiet_wait_ms).toBe(9000);
  });

  it("a zero reserve that lets the wait reach the deadline sends nothing after it", async () => {
    vi.useFakeTimers({ now: 5_000_000 });
    const a = new RoundMemoryActivity();
    a.embeddingSent()(30_000);
    const { assembler, asked } = recorder(async () => read("B"));
    const p = assembleRoundMemory(assembler, "q", {
      maxTokens: 10,
      timeoutMs: 2000,
      searchReserveMs: 0,
      quiet: (max) => a.whenEmbedderQuiet(max),
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect((await p).degraded).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(asked.block).toBeUndefined();
  });
});

describe("the OpenViking assembler: the search never outlives the seed's time left", () => {
  function assemblerWith(searchTimeoutMs?: number) {
    const sent: Array<{ timeoutMs: number | undefined }> = [];
    const client = {
      searchContext: (_q: string, o: { timeoutMs?: number }) => {
        sent.push({ timeoutMs: o.timeoutMs });
        return Promise.resolve({
          ok: true,
          status: 200,
          result: { entries: [], rendered: "", digest: "", stats: {} },
        });
      },
    };
    const store = { retiredUris: async () => [] as string[], pinnedSweep: async () => ({}) };
    const a = new OpenVikingContextAssembler({
      client: client as never,
      store: store as never,
      ...(searchTimeoutMs !== undefined ? { searchTimeoutMs } : {}),
    });
    return { a, sent };
  }

  it("the shorter of its own timeout and the time left; its own when none is given", async () => {
    const { a, sent } = assemblerWith(8000);
    await a.contextBlock("q", { maxTokens: 10 });
    await a.contextBlock("q", { maxTokens: 10, timeoutMs: 3000 });
    await a.contextBlock("q", { maxTokens: 10, timeoutMs: 20_000 });
    await a.contextBlock("q", { maxTokens: 10, timeoutMs: 0.4 });
    await a.contextBlock("q", { maxTokens: 10, timeoutMs: Number.NaN });
    expect(sent.map((s) => s.timeoutMs)).toEqual([8000, 3000, 8000, 1, 8000]);
  });

  it("its default mirrors [openviking] search_timeout_ms's", async () => {
    expect(DEFAULT_SEARCH_TIMEOUT_MS).toBe(OPENVIKING_DEFAULTS.search_timeout_ms);
    const { a, sent } = assemblerWith();
    await a.contextBlock("q", { maxTokens: 10 });
    expect(sent[0]!.timeoutMs).toBe(8000);
  });
});

// ---- 2 + 3. dispatch: the seed waits, inside its budget, and still never blocks --------

class MiniAdapter implements DispatchAdapter {
  async listPrFiles(): Promise<PrFileEntry[]> {
    return [{ filename: "docs/guide.md", additions: 5, deletions: 0, status: "modified" }];
  }
  async getPr(): Promise<{ base_ref: string; body?: string }> {
    return { base_ref: "master", body: "" };
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

describe("dispatch: the round seed waits out the embedding tail, within its budget", () => {
  function rig(opts: { block: () => Promise<MemoryRead>; timeoutMs: number; reserveMs: number }) {
    const cfg: Config = parseConfig(
      readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8"),
    );
    cfg.review.task_files = false;
    const store = new StateStore(":memory:");
    store.upsertPr({
      number: 42,
      state: "queued",
      head_sha: "h42",
      title: "Tidy the guide",
      author: "alice",
      trigger_ts: "2026-10-08T08:33:00Z",
      trigger_provenance: null,
      stale_recheck: 0,
      migration_gate: 0,
    });
    const activity = new RoundMemoryActivity();
    const seen: { blockAt?: number; busyAtBlock?: number | null; opts?: Record<string, unknown> } =
      {};
    const assembler: ContextAssembler = {
      pinnedHead: async () => read(""),
      contextBlock: async (_q, o) => {
        seen.blockAt = Date.now();
        seen.busyAtBlock = activity.embedderBusyForMs();
        seen.opts = { ...o };
        return opts.block();
      },
    };
    const prompts: string[] = [];
    const hooks: SessionHooks = {
      async dispatchRound(_order, prompt) {
        prompts.push(prompt);
      },
      async inject() {},
      async injectOverseer() {},
      async archiveAndClose() {},
    };
    const logs: string[] = [];
    const run = () =>
      dispatchOnce({
        cfg,
        store,
        adapter: new MiniAdapter(),
        hooks,
        memory: {
          assembler,
          timeoutMs: opts.timeoutMs,
          searchReserveMs: opts.reserveMs,
          activity,
        },
        log: (m) => logs.push(m),
      });
    const seeded = () =>
      (
        store.db
          .prepare("SELECT payload FROM events WHERE kind = 'round_memory_seeded'")
          .all() as Array<{ payload: string }>
      ).map((r) => JSON.parse(r.payload) as Record<string, unknown>);
    return { store, activity, seen, prompts, logs, run, seeded };
  }

  it(
    "a case batch still out when the seed starts: the search waits for it — sent no sooner — and the wait is on the round's record",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const r = rig({ block: async () => read("LESSON"), timeoutMs: 4000, reserveMs: 500 });
      // A batch the case writer sent a moment ago; its write answers 300 ms
      // into the seed, with a 300 ms tail.
      const settle = r.activity.embeddingSent();
      const original = r.activity.whenEmbedderQuiet.bind(r.activity);
      let askedAt = 0;
      r.activity.whenEmbedderQuiet = (max: number) => {
        askedAt = Date.now();
        setTimeout(() => settle(300), 300);
        return original(max);
      };
      expect(await r.run()).toHaveLength(1);
      expect(askedAt).toBeGreaterThan(0);
      // Sent only once the tail had run out — never into it.
      expect(r.seen.busyAtBlock).toBe(0);
      expect(r.seen.blockAt! - askedAt).toBeGreaterThanOrEqual(590);
      expect(r.seen.opts!["timeoutMs"]).toBeLessThanOrEqual(4000 - 590);
      const [ev] = r.seeded();
      expect(ev).toMatchObject({ degraded: false, block_chars: "LESSON".length });
      expect(ev!["quiet_wait_ms"]).toBeGreaterThanOrEqual(590);
      expect(ev!["quiet_wait_ms"]).toBeLessThanOrEqual(3500);
      expect(ev!["ms"]).toBeLessThanOrEqual(4000 + 1000);
      r.store.close();
    },
  );

  it(
    "nothing embedding: no wait at all, and the search gets the whole budget",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const r = rig({ block: async () => read("LESSON"), timeoutMs: 4000, reserveMs: 500 });
      expect(await r.run()).toHaveLength(1);
      const [ev] = r.seeded();
      expect(ev).toMatchObject({ degraded: false, quiet_wait_ms: 0 });
      expect(r.seen.opts!["timeoutMs"]).toBeGreaterThan(3000);
      r.store.close();
    },
  );

  it(
    "a batch that never settles and a search that never answers: the round still dispatches, memory-less, at its budget — logged",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const r = rig({ block: () => never(), timeoutMs: 1500, reserveMs: 500 });
      r.activity.embeddingSent(); // out, and never heard of again
      const started = Date.now();
      expect(await r.run()).toHaveLength(1);
      expect(Date.now() - started).toBeLessThan(1500 + 3000);
      const [ev] = r.seeded();
      expect(ev).toMatchObject({
        degraded: true,
        gaps: [{ part: "context", reason: "timeout" }],
      });
      expect(ev!["quiet_wait_ms"]).toBeGreaterThanOrEqual(990);
      expect(ev!["quiet_wait_ms"]).toBeLessThanOrEqual(1000);
      expect(ev!["ms"]).toBeGreaterThanOrEqual(1490);
      expect(ev!["ms"]).toBeLessThan(1500 + 1000);
      // The search was sent at budget − reserve, told it had the reserve left.
      expect(r.seen.opts!["timeoutMs"]).toBeLessThanOrEqual(510);
      expect(
        r.logs.some((l) => /#42 round 1 seeded memory-less \(context: timeout\)/.test(l)),
      ).toBe(true);
      expect(r.prompts).toHaveLength(1);
      expect(r.store.getPr(42)!.state).toBe("reviewing");
      r.store.close();
    },
  );
});

// ---- 1. what the case writer reads: review rounds in flight -----------------------------

describe("reviewsInFlight — running rounds, and queued PRs the pump would start", () => {
  function store() {
    const s = new StateStore(":memory:");
    const add = (n: number, state: "queued" | "tracked") =>
      s.upsertPr({
        number: n,
        state,
        head_sha: `h${n}`,
        title: `PR ${n}`,
        author: "alice",
        trigger_ts: state === "queued" ? "2026-10-08T08:00:00Z" : null,
        trigger_provenance: null,
        stale_recheck: 0,
        migration_gate: 0,
      });
    return { s, add };
  }

  it("idle: nothing running, nothing queued", () => {
    const { s, add } = store();
    add(1, "tracked");
    expect(reviewsInFlight(s)).toEqual({ running: 0, queued: 0 });
    s.close();
  });

  it("a running round (a provisional one included) and a queued PR both count", () => {
    const { s, add } = store();
    add(1, "tracked");
    s.startRound(1, "first", ["pass-baseline"], 60);
    expect(reviewsInFlight(s)).toEqual({ running: 1, queued: 0 });
    add(2, "queued");
    expect(reviewsInFlight(s)).toEqual({ running: 1, queued: 1 });
    s.close();
  });

  it("a paused PR, one held FAILED_LOUD and every queued PR under a drain wait on a person, not the pump — not in flight", () => {
    const { s, add } = store();
    add(3, "queued");
    s.pausePr(3, { issuer: "operator", expires_at: null }, "test");
    add(4, "queued");
    s.openReviewFailure({
      pr: 4,
      head_sha: "h4",
      stage: "command_start",
      detail: "no start",
      attempts: 1,
      retry_cap: 3,
    });
    expect(reviewsInFlight(s)).toEqual({ running: 0, queued: 0 });
    add(5, "queued");
    expect(reviewsInFlight(s)).toEqual({ running: 0, queued: 1 });
    s.engageDrain({ issuer: "operator", expires_at: null });
    expect(reviewsInFlight(s)).toEqual({ running: 0, queued: 0 });
    // A round already running still counts under a drain: it reads memory.
    add(6, "tracked");
    s.startRound(6, "first", ["pass-baseline"], 60);
    expect(reviewsInFlight(s)).toEqual({ running: 1, queued: 0 });
    s.close();
  });

  it("a queued PR behind a FAILED session command (no review failure yet) waits on recovery or the operator, not the pump — not in flight; behind a pending one or held wakes it is", () => {
    const { s, add } = store();
    const command = (pr: number, id: string) =>
      s.createSessionCommand({
        id,
        pr,
        session: `pr-${pr}`,
        kind: "wake",
        round_no: null,
        payload_sha256: "b".repeat(64),
        payload_path: `/state/session-commands/${id}.md`,
        inject_path: `/inject/pr-${pr}/wake--cmd-${id}.md`,
        next_check_at: "2026-10-08T08:05:00.000Z",
      });
    // #7: its ordinary wake's start recovery was exhausted — failed, and the
    // supervisor has not opened the FAILED_LOUD hold yet. The pump skips it
    // every tick until something else acts.
    add(7, "queued");
    command(7, "cmd-7");
    s.claimSessionCommand("cmd-7", "bridge-1", "2026-10-08T08:05:00.000Z");
    expect(s.failActiveSessionCommand("cmd-7", "start recovery exhausted")).toBe(true);
    expect(s.blockingSessionCommand("pr-7")?.status).toBe("failed");
    expect(s.openReviewFailure(7)).toBeUndefined();
    expect(reviewsInFlight(s)).toEqual({ running: 0, queued: 0 });
    // #8: a wake still being delivered drains on its own — in flight.
    add(8, "queued");
    command(8, "cmd-8");
    expect(s.blockingSessionCommand("pr-8")?.status).toBe("pending");
    expect(reviewsInFlight(s)).toEqual({ running: 0, queued: 1 });
    // #9: held wakes flush on their own too — in flight.
    add(9, "queued");
    s.holdWake(9, "a reply", "author_reply");
    expect(s.hasHeldWakes(9)).toBe(true);
    expect(reviewsInFlight(s)).toEqual({ running: 0, queued: 2 });
    // #7's recovery replays the same command: pending again, in flight again.
    expect(
      s.retrySessionCommand("cmd-7", {
        inject_path: "/inject/pr-7/wake--cmd-cmd-7.md",
        next_check_at: "2026-10-08T08:06:00.000Z",
      }),
    ).toBe(true);
    expect(reviewsInFlight(s)).toEqual({ running: 0, queued: 3 });
    s.close();
  });
});

// ---- 3. the budgets: longer, bounded, named ---------------------------------------------

describe("the memory budgets (H3): longer, bounded, named in config.example.toml", () => {
  it("ship at 9000 / 8000 / 6000 ms, with a 4000 ms tail a case; the module defaults agree", () => {
    expect(MEMORY_DEFAULTS.context_timeout_ms).toBe(9000);
    expect(MEMORY_DEFAULTS.case_embed_tail_ms).toBe(4000);
    expect(OPENVIKING_DEFAULTS.search_timeout_ms).toBe(8000);
    expect(OPENVIKING_DEFAULTS.health_timeout_ms).toBe(6000);
    expect(ROUND_CONTEXT_DEFAULTS.timeoutMs).toBe(MEMORY_DEFAULTS.context_timeout_ms);
    expect(DEFAULT_SEARCH_TIMEOUT_MS).toBe(OPENVIKING_DEFAULTS.search_timeout_ms);
    expect(CASE_DEFAULTS.embedTailMsPerCase).toBe(MEMORY_DEFAULTS.case_embed_tail_ms);
    // The search fits inside the seed, and the seed keeps its search reserve.
    expect(OPENVIKING_DEFAULTS.search_timeout_ms).toBeLessThan(MEMORY_DEFAULTS.context_timeout_ms);
    expect(ROUND_CONTEXT_DEFAULTS.searchReserveMs).toBeLessThan(MEMORY_DEFAULTS.context_timeout_ms);
    // The health probe stays well inside the 30 s poll it runs in.
    expect(OPENVIKING_DEFAULTS.health_timeout_ms).toBeLessThan(
      OPENVIKING_DEFAULTS.health_interval_s * 1000,
    );
  });

  it("an absent [memory] / [openviking] block parses to them", () => {
    expect(parseMemory({})).toMatchObject({ context_timeout_ms: 9000, case_embed_tail_ms: 4000 });
    expect(parseOpenViking({})).toMatchObject({ search_timeout_ms: 8000, health_timeout_ms: 6000 });
  });

  it("every one is clamped: a mistyped 0 never makes every seed memory-less, a huge one never holds a round", () => {
    const m = (raw: Record<string, unknown>) => parseMemory(raw);
    expect(m({ context_timeout_ms: 0 }).context_timeout_ms).toBe(CONTEXT_TIMEOUT_BOUNDS_MS.min);
    expect(m({ context_timeout_ms: 1e9 }).context_timeout_ms).toBe(CONTEXT_TIMEOUT_BOUNDS_MS.max);
    expect(m({ context_timeout_ms: 4500.7 }).context_timeout_ms).toBe(4500);
    expect(m({ context_timeout_ms: "9s" }).context_timeout_ms).toBe(9000);
    expect(m({ context_timeout_ms: 3000 }).context_timeout_ms).toBe(3000);
    expect(m({ case_embed_tail_ms: -5 }).case_embed_tail_ms).toBe(0);
    expect(m({ case_embed_tail_ms: 1e9 }).case_embed_tail_ms).toBe(CASE_EMBED_TAIL_MAX_MS);
    expect(m({ case_embed_tail_ms: Number.NaN }).case_embed_tail_ms).toBe(4000);
    const o = (raw: Record<string, unknown>) => parseOpenViking(raw);
    expect(o({ search_timeout_ms: 0 }).search_timeout_ms).toBe(SEARCH_TIMEOUT_BOUNDS_MS.min);
    expect(o({ search_timeout_ms: 1e9 }).search_timeout_ms).toBe(SEARCH_TIMEOUT_BOUNDS_MS.max);
    expect(o({ search_timeout_ms: "fast" }).search_timeout_ms).toBe(8000);
    expect(o({ health_timeout_ms: -1 }).health_timeout_ms).toBe(HEALTH_TIMEOUT_BOUNDS_MS.min);
    expect(o({ health_timeout_ms: 1e9 }).health_timeout_ms).toBe(HEALTH_TIMEOUT_BOUNDS_MS.max);
    // Bounded at all: the ceilings themselves are finite and modest.
    expect(CONTEXT_TIMEOUT_BOUNDS_MS.max).toBeLessThanOrEqual(15_000);
    expect(SEARCH_TIMEOUT_BOUNDS_MS.max).toBeLessThanOrEqual(CONTEXT_TIMEOUT_BOUNDS_MS.max);
  });

  it("config.example.toml names all four at the shipped values, and parses to them", () => {
    const text = readFileSync(resolve(process.cwd(), "config.example.toml"), "utf8");
    expect(text).toMatch(/^context_timeout_ms = 9000$/m);
    expect(text).toMatch(/^case_embed_tail_ms = 4000$/m);
    expect(text).toMatch(/^search_timeout_ms = 8000$/m);
    expect(text).toMatch(/^health_timeout_ms = 6000$/m);
    const cfg = loadConfig(resolve(process.cwd(), "config.example.toml"));
    expect(cfg.memory).toMatchObject({ context_timeout_ms: 9000, case_embed_tail_ms: 4000 });
    expect(cfg.openviking).toMatchObject({ search_timeout_ms: 8000, health_timeout_ms: 6000 });
  });

  it("wire.ts hands the seed the tracker, the case writer the tail and the rounds in flight", () => {
    const wire = readFileSync(resolve(process.cwd(), "src", "wire.ts"), "utf8");
    expect(wire).toMatch(/timeoutMs: cfg\.memory\.context_timeout_ms,/);
    expect(wire).toMatch(/searchTimeoutMs: cfg\.openviking\.search_timeout_ms,/);
    expect(wire).toMatch(
      /memory: \{\s*assembler: lateAssembler,[\s\S]*?activity: roundActivity,\s*\},/,
    );
    expect(wire).toMatch(
      /caseWriter = new CaseWriter\(\{[\s\S]*?rounds: roundActivity,[\s\S]*?embedTailMsPerCase: cfg\.memory\.case_embed_tail_ms,[\s\S]*?reviews: \(\) => reviewsInFlight\(d\.store\),[\s\S]*?\}\);/,
    );
  });
});
