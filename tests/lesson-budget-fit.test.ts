// Shadow selection that fits its budget. Per-row lesson finds queue behind
// the one-thread embedder (which the case writer's embeddings also hold), so
// most of them miss a 2 s budget. Three properties, one block each:
//
//   * TWO finds a round (the cases, and ONE lesson find sized to the corpus),
//     every per-row decision made locally — the pure equivalence proof is in
//     tests/lesson-selection.test.ts; here the selector, end to end;
//   * the budget follows the mode (`shadow_budget_ms` under shadow, the ≤ 2 s
//     `delivery_budget_ms` under on);
//   * the memory WINDOWS the case writer yields to — the selector's around
//     every prefetch, dispatch's from the seed until the selection takes over
//     (the case writer's half is in tests/memory-cases.test.ts).
//
// Every I/O is faked: the engine is an object, the clock is driven by hand,
// the state database is in memory.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LESSON_SHADOW_PREFETCH_DEFAULT_MS,
  LESSON_SHADOW_PREFETCH_MAX_MS,
  MEMORY_DEFAULTS,
  parseConfig,
  parseMemory,
  type Config,
} from "../src/config.js";
import { dispatchOnce, type DispatchAdapter } from "../src/dispatch.js";
import type { GateResult } from "@quickchatai/pi-quickreview/src/gate.js";
import type { PrFileEntry } from "../src/github.js";
import { LessonLedger } from "../src/lessonledger.js";
import { prefetchLessons, RoundLessonSelector, type PrefetchTimer } from "../src/lessonselect.js";
import type { ContextAssembler } from "../src/memory/context.js";
import { RoundMemoryActivity } from "../src/memory/roundactivity.js";
import {
  lessonFindLimit,
  selectRound,
  type FindHit,
  type FindOutcome,
  type LessonEngine,
  type RoleSelection,
} from "../src/memory/selection.js";
import { StateStore } from "../src/state.js";
import type {
  PassPlanEntry,
  RoundOrder,
  SessionHooks,
} from "@quickchatai/pi-quickreview/src/types.js";
import {
  caseCorpus,
  CORPUS_PR,
  CORPUS_PR_FILES,
  CORPUS_ROOT,
  lessonCorpus,
} from "./helpers/lesson-corpus.js";
import { s9aPlanFinds } from "./helpers/s9a-per-row-plan.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

/** An engine whose answers the test scripts, recording every find. */
class FakeEngine implements LessonEngine {
  finds: Array<{ area: string; query: string; limit: number; timeoutMs: number; open: string[] }> =
    [];
  constructor(
    private readonly answer: (
      area: string,
      query: string,
    ) => Promise<{ ok: true; hits: FindHit[] } | { ok: false; reason: string }>,
    private readonly opts: {
      corpus?: number | null;
      retired?: () => Promise<readonly string[]>;
      activity?: RoundMemoryActivity;
    } = {},
  ) {}
  root(): string {
    return CORPUS_ROOT;
  }
  find(area: string, query: string, o: { limit: number; timeoutMs: number }) {
    this.finds.push({
      area,
      query,
      limit: o.limit,
      timeoutMs: o.timeoutMs,
      open: this.opts.activity?.openLabels() ?? [],
    });
    return this.answer(area, query);
  }
  retiredUris(): Promise<readonly string[]> {
    return this.opts.retired ? this.opts.retired() : Promise.resolve([]);
  }
  corpusSize(area: string): number | null {
    if (this.opts.corpus === undefined) return null;
    return area === "experiences" ? this.opts.corpus : null;
  }
}

/** The whole corpus of the area, whatever the query or the limit. */
const wholeCorpus = async (area: string) => ({
  ok: true as const,
  hits: area === "experiences" ? lessonCorpus() : caseCorpus(),
});

const never = <T>(): Promise<T> => new Promise<T>(() => {});
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

function manualTimers(): { timer: PrefetchTimer; fireAll: () => void; asked: number[] } {
  const asked: number[] = [];
  const fires: Array<() => void> = [];
  const timer: PrefetchTimer = (ms) => {
    asked.push(ms);
    let resolveIt!: () => void;
    const promise = new Promise<void>((r) => (resolveIt = r));
    fires.push(resolveIt);
    return { promise, cancel: () => {} };
  };
  return { timer, fireAll: () => fires.forEach((f) => f()), asked };
}

function eventsOf(store: StateStore, kind: string): Array<Record<string, unknown>> {
  return (
    store.db.prepare("SELECT payload FROM events WHERE kind = ? ORDER BY id").all(kind) as Array<{
      payload: string;
    }>
  ).map((e) => JSON.parse(e.payload) as Record<string, unknown>);
}

/** A round on the corpus PR: six discovery rows (two sharing a lens, two
 * sweep rows with their own focus), the validator, three lenses to add. */
function order(over: Partial<RoundOrder> = {}): RoundOrder {
  const row = (lens: string, focus?: string[]): PassPlanEntry => ({
    lens,
    agent: `${lens}--sol-med`,
    tier: "sol-med",
    raisable_to: [],
    ...(focus ? { focus } : {}),
  });
  return {
    pr: CORPUS_PR,
    title: "Tidy the guide",
    round_id: 7,
    round_no: 1,
    round_type: "first",
    lenses: ["pass-baseline", "pass-security", "pass-sweep", "pass-ui", "pass-validate"],
    pass_plan: [
      row("pass-baseline"),
      row("pass-security"),
      row("pass-sweep", ["docs/guide.md"]),
      row("pass-sweep", ["backend/api/views.py"]),
      row("pass-ui"),
      row("pass-baseline"),
      row("pass-validate"),
    ],
    addable_lenses: ["pass-concurrency", "pass-data-safety"],
    migration_gate: false,
    head_sha: "h",
    base_ref: "master",
    base_sha: "b",
    merge_base: "m",
    worktree: "wt/pr-42",
    settled_digest: "",
    issued_at: "2026-10-07T10:00:00Z",
    ...over,
  };
}

const FILES = CORPUS_PR_FILES.map((filename) => ({ filename }));

// ---- the budget follows the mode ----------------------------------------------------------

describe("[memory] shadow_budget_ms — the budget follows the mode", () => {
  afterEach(() => vi.useRealTimers());

  it("ships at 10 s, clamped to 1…20 s, beside the unchanged ≤ 2 s delivery budget; the example spells it", () => {
    expect(LESSON_SHADOW_PREFETCH_DEFAULT_MS).toBe(10_000);
    expect(LESSON_SHADOW_PREFETCH_MAX_MS).toBe(20_000);
    expect(MEMORY_DEFAULTS).toMatchObject({ shadow_budget_ms: 10_000, delivery_budget_ms: 2000 });
    expect(parseMemory({}).shadow_budget_ms).toBe(10_000);
    expect(parseMemory({ shadow_budget_ms: 60_000 }).shadow_budget_ms).toBe(20_000);
    expect(parseMemory({ shadow_budget_ms: 0 }).shadow_budget_ms).toBe(1);
    expect(parseMemory({ shadow_budget_ms: 4500.7 }).shadow_budget_ms).toBe(4500);
    expect(parseMemory({ shadow_budget_ms: "soon" }).shadow_budget_ms).toBe(10_000);
    // The delivery budget's own ceiling is untouched by it.
    expect(
      parseMemory({ shadow_budget_ms: 15_000, delivery_budget_ms: 9000 }).delivery_budget_ms,
    ).toBe(2000);
    const example = parseConfig(
      readFileSync(resolve(process.cwd(), "config.example.toml"), "utf8"),
    );
    expect(example.memory.shadow_budget_ms).toBe(10_000);
    const fixture = parseConfig(
      readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8"),
    );
    expect(fixture.memory.shadow_budget_ms).toBe(10_000);
  });

  it("`start` (shadow: nothing waits) runs under the shadow budget; `select` (on: the round waits) and the repo facts under the delivery budget", async () => {
    const store = new StateStore(":memory:");
    const ledger = new LessonLedger(store);
    const engine = new FakeEngine(wholeCorpus, { corpus: 90 });
    for (const [mode, call, expected] of [
      ["shadow", "start", 10_000],
      ["on", "select", 2000],
      ["on", "repoFacts", 2000],
    ] as const) {
      const t = manualTimers();
      const s = new RoundLessonSelector({
        ledger,
        mode: () => mode,
        engine: () => engine,
        budgetMs: 2000,
        shadowBudgetMs: 10_000,
        timer: t.timer,
      });
      if (call === "start") {
        s.start(order({ round_id: 11 }), FILES);
        await s.idle();
      } else if (call === "select") {
        await s.select(order({ round_id: 12 }), FILES);
      } else {
        await s.repoFacts({
          pr: CORPUS_PR,
          title: "T",
          paths: ["docs/guide.md"],
          purpose: "recheck",
        });
      }
      expect(t.asked, `${mode}/${call}`).toEqual([expected]);
    }
    // The event carries the budget each run had.
    expect(eventsOf(store, "lesson_selection").map((e) => e["budget_ms"])).toEqual([10_000, 2000]);
    // No shadow budget configured: the delivery budget.
    const t = manualTimers();
    new RoundLessonSelector({
      ledger,
      mode: () => "shadow",
      engine: () => engine,
      budgetMs: 1500,
      timer: t.timer,
    }).start(order({ round_id: 13 }), FILES);
    await flush();
    expect(t.asked).toEqual([1500]);
    store.close();
  });

  it("finds as slow as the live p90 behind a case batch (2.5 s) now count under shadow — and still time out under on, where the round waits", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-07T12:14:00Z") });
    const store = new StateStore(":memory:");
    const ledger = new LessonLedger(store);
    const slow = new FakeEngine(
      (area) =>
        new Promise((r) => {
          setTimeout(() => void wholeCorpus(area).then(r), 2500);
        }),
      { corpus: 90 },
    );
    const selector = (mode: "shadow" | "on") =>
      new RoundLessonSelector({
        ledger,
        mode: () => mode,
        engine: () => slow,
        budgetMs: 2000,
        shadowBudgetMs: 10_000,
      });

    const shadow = selector("shadow");
    shadow.start(order({ round_id: 21 }), FILES);
    await vi.advanceTimersByTimeAsync(2500);
    await shadow.idle();
    expect(ledger.roundRow(21)).toMatchObject({
      mode: "shadow",
      state: "selected",
      finds: 2,
      answered: 2,
      timeouts: 0,
      prefetch_ms: 2500,
    });
    expect(ledger.selections(21).every((s) => s.status === "ok")).toBe(true);

    const on = selector("on");
    const pending = on.select(order({ round_id: 22 }), FILES);
    await vi.advanceTimersByTimeAsync(2000);
    const res = await pending;
    expect(res?.selections.every((s) => s.status === "timeout")).toBe(true);
    expect(ledger.roundRow(22)).toMatchObject({ mode: "on", state: "timeout", prefetch_ms: 2000 });
    await vi.advanceTimersByTimeAsync(1000);
    store.close();
  });
});

// ---- two finds a round, end to end --------------------------------------------------------

describe("two finds a round, through the selector", () => {
  it("asks the engine TWO finds, the lesson find sized to cover the corpus — and records exactly S9a's per-row selection", async () => {
    const store = new StateStore(":memory:");
    const ledger = new LessonLedger(store);
    const corpus = lessonCorpus();
    const engine = new FakeEngine(wholeCorpus, { corpus: corpus.length });
    const s = new RoundLessonSelector({
      ledger,
      mode: () => "shadow",
      engine: () => engine,
      budgetMs: 2000,
      shadowBudgetMs: 10_000,
    });
    const o = order();
    s.start(o, FILES);
    await s.idle();
    expect(engine.finds.map((f) => f.area)).toEqual(["finding-cases", "experiences"]);
    const lessonFind = engine.finds[1]!;
    expect(lessonFind.limit).toBe(lessonFindLimit(corpus.length));
    expect(lessonFind.limit).toBeGreaterThanOrEqual(corpus.length);
    expect(engine.finds[0]!.limit).toBe(40);
    expect(ledger.roundRow(o.round_id)).toMatchObject({ state: "selected", finds: 2, answered: 2 });

    // The reference: the per-row plan over the same whole-corpus engine.
    const rows = o.pass_plan.map((p, row) => ({
      row,
      lens: p.lens,
      agent: p.agent,
      ...(p.focus ? { focus: p.focus } : {}),
    }));
    const prFiles = [...CORPUS_PR_FILES];
    const plan = s9aPlanFinds({ title: o.title, rows, prFiles, addable: o.addable_lenses });
    const reference = selectRound({
      pr: o.pr,
      rows,
      prFiles,
      root: CORPUS_ROOT,
      plan,
      outcomes: new Map(
        plan.finds.map(
          (f) =>
            [
              f.key,
              {
                status: "ok",
                hits: f.area === "experiences" ? lessonCorpus() : caseCorpus(),
              } as FindOutcome,
            ] as const,
        ),
      ),
      retired: new Set(),
      suppressed: new Set(),
      addable: o.addable_lenses,
    });
    expect(plan.finds.length).toBeGreaterThan(5);
    const stripRef = (sel: RoleSelection[]) =>
      sel.map((r) => ({
        role: r.role,
        row: r.row,
        lens: r.lens,
        status: r.status,
        lessons: r.lessons,
        cases: r.cases,
        cuts: r.cuts,
        dropped: r.dropped,
      }));
    const recorded = ledger.selections(o.round_id).map((r) => ({
      role: r.role,
      row: r.row,
      lens: r.lens,
      status: r.status,
      lessons: r.lessons,
      cases: r.cases,
      cuts: r.cuts,
      dropped: r.dropped,
    }));
    expect(recorded).toEqual(stripRef(reference));
    // …and the event says what the find was sized from.
    expect(eventsOf(store, "lesson_selection")[0]).toMatchObject({
      finds: 2,
      sent: 2,
      answered: 2,
      corpus: corpus.length,
      limit: lessonFindLimit(corpus.length),
      budget_ms: 10_000,
    });
    store.close();
  });

  it("the store's count sizes the limit; an unknown count asks for the ceiling; a corpus past it is logged once, not every round", async () => {
    const store = new StateStore(":memory:");
    const ledger = new LessonLedger(store);
    const limitsLogged: number[] = [];
    let roundId = 100;
    const limitFor = async (corpus: number | null | undefined, rounds = 1): Promise<number[]> => {
      const engine = new FakeEngine(wholeCorpus, corpus === undefined ? {} : { corpus });
      const logs: string[] = [];
      const s = new RoundLessonSelector({
        ledger,
        mode: () => "shadow",
        engine: () => engine,
        budgetMs: 2000,
        log: (m) => logs.push(m),
      });
      for (let i = 0; i < rounds; i++) s.start(order({ round_id: (roundId += 1) }), FILES);
      await s.idle();
      limitsLogged.push(logs.filter((m) => /outgrows one find's limit/.test(m)).length);
      return engine.finds.filter((f) => f.area === "experiences").map((f) => f.limit);
    };
    expect(await limitFor(34)).toEqual([76]);
    expect(await limitFor(0)).toEqual([40]);
    expect(await limitFor(null)).toEqual([200]);
    expect(await limitFor(undefined)).toEqual([200]); // an engine that cannot count
    expect(await limitFor(500, 3)).toEqual([200, 200, 200]);
    expect(limitsLogged).toEqual([0, 0, 0, 0, 1]);
    store.close();
  });
});

// ---- the memory windows the case writer yields to -----------------------------------------

/** A tracker that records every window opening and closing, and how many
 * stayed open after each. */
class TracingActivity extends RoundMemoryActivity {
  trace: Array<{ ev: string; open: number }> = [];
  override begin(label = "round"): () => void {
    const end = super.begin(label);
    this.trace.push({ ev: `+${label}`, open: this.inFlight() });
    let closed = false;
    return () => {
      end();
      if (closed) return;
      closed = true;
      this.trace.push({ ev: `-${label}`, open: this.inFlight() });
    };
  }
}

describe("RoundMemoryActivity — the windows", () => {
  afterEach(() => vi.useRealTimers());

  it("windows nest; each end is idempotent; busy while any is open", () => {
    const a = new RoundMemoryActivity();
    expect(a.busy()).toBe(false);
    const e1 = a.begin("round #1");
    const e2 = a.begin("lessons #1");
    expect(a.inFlight()).toBe(2);
    expect(a.openLabels()).toEqual(["round #1", "lessons #1"]);
    e1();
    e1();
    expect(a.inFlight()).toBe(1);
    expect(a.busy()).toBe(true);
    e2();
    expect(a.busy()).toBe(false);
    e2();
    expect(a.inFlight()).toBe(0);
  });

  it("whenIdle: at once when idle, the moment the last window closes, false at its timeout", async () => {
    vi.useFakeTimers();
    const a = new RoundMemoryActivity();
    await expect(a.whenIdle(1000)).resolves.toBe(true);
    const end = a.begin();
    let settled: boolean | null = null;
    void a.whenIdle(5000).then((v) => (settled = v));
    await vi.advanceTimersByTimeAsync(4000);
    expect(settled).toBeNull();
    end();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    const end2 = a.begin();
    let late: boolean | null = null;
    void a.whenIdle(5000).then((v) => (late = v));
    await vi.advanceTimersByTimeAsync(5000);
    expect(late).toBe(false);
    end2();
  });
});

describe("the selector opens a window for every prefetch", () => {
  it("`start` returns with its window ALREADY open, and it closes when the run ends — deadline or answers", async () => {
    const store = new StateStore(":memory:");
    const ledger = new LessonLedger(store);
    const activity = new RoundMemoryActivity();
    const engine = new FakeEngine(() => never(), { corpus: 10, activity });
    const t = manualTimers();
    const s = new RoundLessonSelector({
      ledger,
      mode: () => "shadow",
      engine: () => engine,
      budgetMs: 2000,
      shadowBudgetMs: 10_000,
      timer: t.timer,
      activity,
    });
    s.start(order(), FILES);
    // Synchronously open: dispatch can close the round's own window behind it.
    expect(activity.openLabels()).toEqual([`lessons #${CORPUS_PR}`]);
    await flush();
    expect(engine.finds.every((f) => f.open.includes(`lessons #${CORPUS_PR}`))).toBe(true);
    expect(activity.busy()).toBe(true);
    t.fireAll();
    await s.idle();
    expect(activity.busy()).toBe(false);
    store.close();
  });

  it("repo facts, the kill switch and a dead engine open and close it too; a tracker that throws breaks nothing", async () => {
    const store = new StateStore(":memory:");
    const ledger = new LessonLedger(store);
    const activity = new RoundMemoryActivity();
    const engine = new FakeEngine(wholeCorpus, { corpus: 10, activity });
    const s = new RoundLessonSelector({
      ledger,
      mode: () => "on",
      engine: () => engine,
      budgetMs: 2000,
      activity,
    });
    await s.repoFacts({ pr: 9, title: "T", paths: ["docs/guide.md"], purpose: "pingpong" });
    expect(engine.finds.at(-1)!.open).toEqual(["pingpong #9"]);
    expect(engine.finds.at(-1)!.limit).toBe(lessonFindLimit(10));
    expect(activity.busy()).toBe(false);
    ledger.apply({ action: "off" }, "op-1.json");
    await s.select(order({ round_id: 31 }), FILES);
    expect(activity.busy()).toBe(false);
    ledger.apply({ action: "on" }, "op-2.json");
    const dead = new RoundLessonSelector({
      ledger,
      mode: () => "shadow",
      engine: () => {
        throw new Error("not built");
      },
      budgetMs: 2000,
      activity,
    });
    dead.start(order({ round_id: 32 }), FILES);
    await dead.idle();
    expect(activity.busy()).toBe(false);
    expect(ledger.roundRow(32)!.state).toBe("unreadable");

    const broken = new RoundLessonSelector({
      ledger,
      mode: () => "shadow",
      engine: () => engine,
      budgetMs: 2000,
      activity: {
        begin: () => {
          throw new Error("tracker broke");
        },
      },
    });
    expect(() => broken.start(order({ round_id: 33 }), FILES)).not.toThrow();
    await broken.idle();
    expect(ledger.roundRow(33)!.state).toBe("selected");
    store.close();
  });
});

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

// ---- the daemon's shutdown --------------------------------------------------------------
//
// A shadow budget (up to 20 s) does not fit docker's 10 s stop grace beside
// the server's own 5 s, so shutdown does not WAIT for a shadow selection: it
// cuts it, and records nothing — a record cut short by our own stop would
// read in the shadow report as the engine's `partial`/`unreadable`. An
// awaited selection (`on`, ≤ 2 s) is never cut: the round renders from it.

describe("the daemon's shutdown cuts a shadow selection — never an awaited one", () => {
  const twoFinds = [
    { key: "lessons", area: "experiences" as const, query: "q", limit: 40 },
    { key: "cases", area: "finding-cases" as const, query: "q", limit: 40 },
  ];

  it("prefetchLessons: the signal ends the phase like the deadline; already aborted sends nothing; after the last answer it is not a cut", async () => {
    // Mid-phase: the cases answered, the lessons still out.
    const engine = new FakeEngine((area) =>
      area === "experiences" ? never() : Promise.resolve({ ok: true as const, hits: [] }),
    );
    const t = manualTimers();
    const stop = new AbortController();
    const p = prefetchLessons(engine, twoFinds, {
      budgetMs: 10_000,
      timer: t.timer,
      signal: stop.signal,
    });
    await flush();
    expect(engine.finds).toHaveLength(2);
    stop.abort();
    // The deadline never fired: the signal alone ended it.
    const res = await p;
    expect(res.aborted).toBe(true);
    expect(res.outcomes.get("cases")!.status).toBe("ok");
    expect(res.outcomes.get("lessons")!.status).toBe("timeout");

    // Already aborted: no find sent, no retired list asked.
    let retiredAsked = 0;
    const quiet = new FakeEngine(wholeCorpus, {
      retired: async () => {
        retiredAsked += 1;
        return [];
      },
    });
    const gone = await prefetchLessons(quiet, twoFinds, {
      budgetMs: 10_000,
      timer: manualTimers().timer,
      signal: AbortSignal.abort(),
    });
    expect(quiet.finds).toEqual([]);
    expect(retiredAsked).toBe(0);
    expect(gone).toMatchObject({ sent: 0, aborted: true, retired: null });

    // Every find answered, only the retired list still out at the stop: the
    // selection is whole (the entries' own headers still exclude), so it is
    // not a cut — it records, `retired_list: 0`.
    const listOut = new AbortController();
    const pending = prefetchLessons(
      new FakeEngine(wholeCorpus, { retired: () => never() }),
      twoFinds,
      {
        budgetMs: 10_000,
        timer: manualTimers().timer,
        signal: listOut.signal,
      },
    );
    await flush();
    listOut.abort();
    expect(await pending).toMatchObject({ sent: 2, aborted: false, retired: null });

    // Everything answered before the stop: not a cut.
    const late = new AbortController();
    const done = await prefetchLessons(new FakeEngine(wholeCorpus), twoFinds, {
      budgetMs: 10_000,
      timer: manualTimers().timer,
      signal: late.signal,
    });
    late.abort();
    expect(done.aborted).toBe(false);
    // No signal at all: never a cut.
    const plain = await prefetchLessons(new FakeEngine(wholeCorpus), twoFinds, {
      budgetMs: 10_000,
      timer: manualTimers().timer,
    });
    expect(plain.aborted).toBe(false);
  });

  it("`stop` cuts a shadow selection in its prefetch at once — nothing recorded, logged, its window closed; no shadow selection starts after it", async () => {
    const store = new StateStore(":memory:");
    const ledger = new LessonLedger(store);
    const activity = new RoundMemoryActivity();
    const logs: string[] = [];
    // The cases answer; the lesson find hangs behind a busy embedder.
    const engine = new FakeEngine((area) =>
      area === "experiences" ? never() : Promise.resolve({ ok: true as const, hits: caseCorpus() }),
    );
    const t = manualTimers();
    const s = new RoundLessonSelector({
      ledger,
      mode: () => "shadow",
      engine: () => engine,
      budgetMs: 2000,
      shadowBudgetMs: 10_000,
      activity,
      timer: t.timer,
      log: (m) => logs.push(m),
    });
    s.start(order({ round_id: 51 }), FILES);
    await flush();
    expect(engine.finds).toHaveLength(2);
    expect(activity.busy()).toBe(true);
    s.stop();
    s.stop(); // idempotent
    // Settles with the 10 s deadline never fired.
    await s.idle();
    expect(t.asked).toEqual([10_000]);
    expect(ledger.roundRow(51)).toBeUndefined();
    expect(ledger.selections(51)).toEqual([]);
    expect(eventsOf(store, "lesson_selection")).toEqual([]);
    expect(
      logs.filter((m) =>
        /cut short by the daemon's shutdown \(1 of 2 find\(s\) answered\) — not recorded/.test(m),
      ),
    ).toHaveLength(1);
    expect(activity.busy()).toBe(false);

    // After the stop: nothing starts, nothing is asked, nothing recorded.
    s.start(order({ round_id: 52 }), FILES);
    await s.idle();
    expect(engine.finds).toHaveLength(2);
    expect(ledger.roundRow(52)).toBeUndefined();
    expect(logs.filter((m) => /the daemon is stopping; no shadow selection/.test(m))).toHaveLength(
      1,
    );
    expect(activity.busy()).toBe(false);
    store.close();
  });

  it("a shadow selection that finished before the stop is recorded as ever", async () => {
    const store = new StateStore(":memory:");
    const ledger = new LessonLedger(store);
    const s = new RoundLessonSelector({
      ledger,
      mode: () => "shadow",
      engine: () => new FakeEngine(wholeCorpus, { corpus: 10 }),
      budgetMs: 2000,
      shadowBudgetMs: 10_000,
      timer: manualTimers().timer,
    });
    s.start(order({ round_id: 53 }), FILES);
    await s.idle();
    s.stop();
    expect(ledger.roundRow(53)).toMatchObject({ state: "selected", finds: 2, answered: 2 });
    store.close();
  });

  it("an AWAITED selection (on) is not cut: it keeps its ≤ 2 s budget and is recorded", async () => {
    const store = new StateStore(":memory:");
    const ledger = new LessonLedger(store);
    const engine = new FakeEngine((area) =>
      area === "experiences" ? never() : Promise.resolve({ ok: true as const, hits: caseCorpus() }),
    );
    const t = manualTimers();
    const s = new RoundLessonSelector({
      ledger,
      mode: () => "on",
      engine: () => engine,
      budgetMs: 2000,
      shadowBudgetMs: 10_000,
      timer: t.timer,
    });
    let settled = false;
    const p = s.select(order({ round_id: 54 }), FILES).then((r) => {
      settled = true;
      return r;
    });
    await flush();
    s.stop();
    await flush();
    await flush();
    // Still waiting on its own budget — the stop did not end it.
    expect(settled).toBe(false);
    expect(t.asked).toEqual([2000]);
    t.fireAll();
    expect(await p).not.toBeNull();
    expect(ledger.roundRow(54)).toMatchObject({
      mode: "on",
      state: "partial",
      finds: 2,
      answered: 1,
      timeouts: 1,
    });
    store.close();
  });
});

describe("dispatch holds the round's window from the seed until the selection takes over", () => {
  function rig(opts: {
    mode: "shadow" | "on" | null;
    engine?: FakeEngine;
    handoff?: () => Promise<void>;
    timer?: PrefetchTimer;
  }) {
    const cfg: Config = parseConfig(
      readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8"),
    );
    cfg.review.task_files = false;
    const store = new StateStore(":memory:");
    const ledger = new LessonLedger(store);
    store.upsertPr({
      number: 42,
      state: "queued",
      head_sha: "h42",
      title: "Tidy the guide",
      author: "alice",
      trigger_ts: "2026-10-07T09:00:00Z",
      trigger_provenance: null,
      stale_recheck: 0,
      migration_gate: 0,
    });
    const activity = new TracingActivity();
    const seen: Record<string, string[]> = {};
    const assembler: ContextAssembler = {
      pinnedHead: async () => {
        seen["head"] = activity.openLabels();
        return { status: "read", text: "" };
      },
      contextBlock: async () => {
        seen["block"] = activity.openLabels();
        return { status: "read", text: "" };
      },
    };
    const hooks: SessionHooks = {
      async dispatchRound() {
        seen["handoff"] = activity.openLabels();
        if (opts.handoff) await opts.handoff();
      },
      async inject() {},
      async archiveAndClose() {},
    };
    const selector =
      opts.mode === null
        ? undefined
        : new RoundLessonSelector({
            ledger,
            mode: () => opts.mode!,
            engine: () => opts.engine ?? null,
            budgetMs: 2000,
            shadowBudgetMs: 10_000,
            activity,
            ...(opts.timer ? { timer: opts.timer } : {}),
          });
    const run = () =>
      dispatchOnce({
        cfg,
        store,
        adapter: new MiniAdapter(),
        hooks,
        memory: { assembler, timeoutMs: 3000, activity },
        ...(selector ? { lessons: selector } : {}),
      });
    return { store, ledger, activity, seen, selector, run };
  }

  /** From the first window's opening to the last one's closing, memory was
   * never idle — no gap a case batch could start in. */
  function noGap(trace: Array<{ ev: string; open: number }>): boolean {
    return trace.slice(0, -1).every((t) => t.open > 0) && trace.at(-1)!.open === 0;
  }

  it(
    "under shadow: open through the seed AND the handoff; the selector's window opens before the round's closes; idle once the selection ends",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const t = manualTimers();
      const activityEngine = new FakeEngine(() => never(), { corpus: 10 });
      const r = rig({ mode: "shadow", engine: activityEngine, timer: t.timer });
      const orders = await r.run();
      expect(orders).toHaveLength(1);
      expect(r.seen["head"]).toEqual(["round #42"]);
      expect(r.seen["block"]).toEqual(["round #42"]);
      expect(r.seen["handoff"]).toEqual(["round #42"]);
      // The round is dispatched; its selection is still out — and holding.
      expect(r.activity.openLabels()).toEqual(["lessons #42"]);
      expect(r.activity.trace.map((x) => x.ev)).toEqual([
        "+round #42",
        "+lessons #42",
        "-round #42",
      ]);
      t.fireAll();
      await r.selector!.idle();
      expect(r.activity.busy()).toBe(false);
      expect(noGap(r.activity.trace)).toBe(true);
      r.store.close();
    },
  );

  it(
    "under on: open through the seed and the awaited selection, closed BEFORE the handoff",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const r = rig({ mode: "on", engine: new FakeEngine(wholeCorpus, { corpus: 10 }) });
      const orders = await r.run();
      expect(orders).toHaveLength(1);
      expect(r.seen["head"]).toEqual(["round #42", "lessons #42"]);
      // The selection is in before the prompt renders: the handoff reads no
      // memory, so it holds no case batch (contrast shadow, above).
      expect(r.seen["handoff"]).toEqual([]);
      expect(r.activity.busy()).toBe(false);
      expect(r.activity.trace.map((x) => x.ev)).toEqual([
        "+round #42",
        "+lessons #42",
        "-lessons #42",
        "-round #42",
      ]);
      expect(noGap(r.activity.trace)).toBe(true);
      r.store.close();
    },
  );

  it(
    "no lesson hook: the window spans the seed and the handoff, then closes; a failed handoff never leaves it open",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const plain = rig({ mode: null });
      expect(await plain.run()).toHaveLength(1);
      expect(plain.seen["head"]).toEqual(["round #42"]);
      expect(plain.activity.busy()).toBe(false);
      plain.store.close();

      const failing = rig({
        mode: "shadow",
        engine: new FakeEngine(wholeCorpus, { corpus: 10 }),
        handoff: async () => {
          throw new Error("tmux refused");
        },
      });
      expect(await failing.run()).toEqual([]);
      expect(failing.seen["handoff"]).toEqual(["round #42"]);
      // The handoff threw before `start`: no selection, and no window left.
      expect(failing.activity.busy()).toBe(false);
      expect(failing.activity.trace.map((x) => x.ev)).toEqual(["+round #42", "-round #42"]);
      failing.store.close();
    },
  );
});
