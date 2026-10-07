// the delivery switch, the bounded prefetch, the operator's kill
// switch, the shadow ledger and its report. Every I/O is faked: the engine is
// an object, the clock is driven by hand, the state database is in memory.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authorizeCommand,
  COMMAND_WHITELIST,
  CommandWatcher,
  executeCommand,
  OPERATOR_COMMANDS,
  processOperatorSeal,
  validateCommand,
  type CommandDeps,
  type OperatorSeal,
} from "../src/commands.js";
import { parseLessonsSubcommand } from "../src/cli.js";
import {
  MEMORY_DEFAULTS,
  parseConfig,
  parseMemory,
  type Config,
  type TuiConfig,
} from "../src/config.js";
import { dispatchOnce, type DispatchAdapter } from "../src/dispatch.js";
import { enforceFindingsRecord } from "../src/findingsrecord.js";
import type { GateResult } from "../src/gate.js";
import type { PrFileEntry } from "../src/github.js";
import { Learner } from "../src/learner/learner.js";
import { LessonLedger } from "../src/lessonledger.js";
import {
  FindSlots,
  PREFETCH_MAX_IN_FLIGHT,
  prefetchLessons,
  RoundLessonSelector,
  type PrefetchTimer,
} from "../src/lessonselect.js";
import {
  bucketOf,
  lessonDeliveryStatus,
  markRound,
  matchShadow,
  renderShadowReport,
  shadowReport,
} from "../src/lessonshadow.js";
import type { ContextAssembler } from "../src/memory/context.js";
import {
  MemoryHealthMonitor,
  memoryStatusLine,
  pendingMemoryStatus,
  type ProbeAnswer,
} from "../src/memory/health.js";
import {
  planFinds,
  type FindHit,
  type LessonEngine,
  type RoleSelection,
  type SelectedLesson,
} from "../src/memory/selection.js";
import { lessonDeliveryPhrase, type LessonDeliveryStatus } from "../src/memory/shadowstatus.js";
import { buildFindBody, OpenVikingClient, type HttpFetch } from "../src/openviking/client.js";
import { lessonFindClient, openVikingLessonEngine } from "../src/openviking/lessonfind.js";
import { OutcomeCapture } from "../src/outcomes.js";
import { StateStore } from "../src/state.js";
import type { RemoteResult, SshRunner } from "../src/tui/remote.js";
import { lessonsHeadline } from "../src/tui/feedbacktab.js";
import { stripAnsi } from "../src/tui/paint.js";
import { LessonSwitchSender, lessonSwitchPayload, lessonUriOf } from "../src/tui/lessonswitch.js";
import type { RoundOrder, SessionHooks } from "../src/types.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const ROOT = "viking://user/reviewer/memories";
const EXP = `${ROOT}/experiences`;

function lessonText(
  kind: string,
  cls = "baseline.scope",
  lens = "pass-baseline",
  paths = "**",
): string {
  return `#lesson kind=${kind} lens=${lens} class=${cls} paths=${paths} evidence=pr:1\nBody.`;
}

function eventsOf(store: StateStore, kind: string): Array<Record<string, unknown>> {
  return (
    store.db.prepare("SELECT payload FROM events WHERE kind = ? ORDER BY id").all(kind) as Array<{
      payload: string;
    }>
  ).map((e) => JSON.parse(e.payload) as Record<string, unknown>);
}

/** An engine whose answers the test scripts, counting every call. */
class FakeEngine implements LessonEngine {
  finds: Array<{ area: string; query: string; timeoutMs: number }> = [];
  retiredCalls = 0;
  constructor(
    private readonly answer: (
      area: string,
      query: string,
    ) => Promise<{ ok: true; hits: FindHit[] } | { ok: false; reason: string }>,
    private readonly retired: () => Promise<readonly string[]> = async () => [],
  ) {}
  root(): string {
    return ROOT;
  }
  find(area: string, query: string, opts: { limit: number; timeoutMs: number }) {
    this.finds.push({ area, query, timeoutMs: opts.timeoutMs });
    return this.answer(area, query);
  }
  retiredUris(): Promise<readonly string[]> {
    this.retiredCalls += 1;
    return this.retired();
  }
}

const never = <T>(): Promise<T> => new Promise<T>(() => {});

function manualTimer(): { timer: PrefetchTimer; fire: () => void; asked: number[] } {
  const asked: number[] = [];
  let fire: () => void = () => {};
  const timer: PrefetchTimer = (ms) => {
    asked.push(ms);
    let resolveIt!: () => void;
    const promise = new Promise<void>((r) => (resolveIt = r));
    fire = resolveIt;
    return { promise, cancel: () => {} };
  };
  return { timer, fire: () => fire(), asked };
}

/** Every timer the prefetch asks for, fired together (several rounds). */
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

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

function order(over: Partial<RoundOrder> = {}): RoundOrder {
  return {
    pr: 42,
    title: "Tidy the guide",
    round_id: 7,
    round_no: 1,
    round_type: "first",
    lenses: ["pass-baseline", "pass-validate"],
    pass_plan: [
      { lens: "pass-baseline", agent: "pass-baseline--sol-med", tier: "sol-med", raisable_to: [] },
      {
        lens: "pass-validate",
        agent: "pass-validate--sol-high",
        tier: "sol-high",
        raisable_to: [],
      },
    ],
    addable_lenses: [],
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

// ---- the switch ------------------------------------------------------------------

describe("[memory] delivery — the switch", () => {
  it("ships as shadow with the 2 s budget; the fixture config parses to it", () => {
    expect(MEMORY_DEFAULTS.delivery).toBe("shadow");
    expect(MEMORY_DEFAULTS.delivery_budget_ms).toBe(2000);
    const cfg = parseConfig(
      readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8"),
    );
    expect(cfg.memory.delivery).toBe("shadow");
    const example = parseConfig(
      readFileSync(resolve(process.cwd(), "config.example.toml"), "utf8"),
    );
    expect(example.memory.delivery).toBe("shadow");
    expect(example.memory.delivery_budget_ms).toBe(2000);
  });

  it("refuses a misspelt value and clamps the budget to the contract's 2 s ceiling", () => {
    expect(() => parseMemory({ delivery: "onn" })).toThrow(/\[memory\] delivery must be one of/);
    expect(() => parseMemory({ delivery: true })).toThrow(/delivery/);
    for (const v of ["off", "shadow", "on"]) expect(parseMemory({ delivery: v }).delivery).toBe(v);
    expect(parseMemory({ delivery_budget_ms: 5000 }).delivery_budget_ms).toBe(2000);
    expect(parseMemory({ delivery_budget_ms: 0 }).delivery_budget_ms).toBe(1);
    expect(parseMemory({ delivery_budget_ms: 750 }).delivery_budget_ms).toBe(750);
  });
});

// ---- the prefetch -----------------------------------------------------------------

describe("prefetchLessons — ONE bounded phase", () => {
  const finds = planFinds({
    title: "T",
    rows: [
      { row: 0, lens: "pass-baseline", agent: "a" },
      { row: 1, lens: "pass-security", agent: "b" },
    ],
    prFiles: ["x.py"],
  }).finds;

  it("uses what arrived at the deadline; a find still out is a timeout, and a late answer changes nothing", async () => {
    let late!: (v: { ok: true; hits: FindHit[] }) => void;
    const engine = new FakeEngine(async (_area, query) => {
      if (query.includes("security")) return new Promise((r) => (late = r));
      return { ok: true, hits: [{ uri: `${EXP}/a.md`, score: 1, text: lessonText("look-for") }] };
    });
    const t = manualTimer();
    let settled = false;
    const p = prefetchLessons(engine, finds, {
      budgetMs: 2000,
      timer: t.timer,
      clock: () => 5_000,
    }).then((r) => {
      settled = true;
      return r;
    });
    await new Promise((r) => setImmediate(r));
    expect(settled).toBe(false);
    expect(t.asked).toEqual([2000]);
    // No time has passed: every find is told the whole budget as its own
    // deadline.
    expect(engine.finds.every((f) => f.timeoutMs === 2000)).toBe(true);
    t.fire();
    const res = await p;
    const statuses = finds.map((f) => res.outcomes.get(f.key)!.status);
    expect(statuses.filter((s) => s === "timeout")).toHaveLength(1);
    expect(statuses.filter((s) => s === "ok")).toHaveLength(finds.length - 1);
    late({ ok: true, hits: [] });
    await new Promise((r) => setImmediate(r));
    expect(finds.map((f) => res.outcomes.get(f.key)!.status)).toEqual(statuses);
  });

  it("resolves as soon as everything answered — the budget is a ceiling, not a wait", async () => {
    const engine = new FakeEngine(
      async () => ({ ok: true, hits: [] }),
      async () => [`${EXP}/r.md`],
    );
    const t = manualTimer();
    const res = await prefetchLessons(engine, finds, { budgetMs: 2000, timer: t.timer });
    expect([...res.outcomes.values()].every((o) => o.status === "ok")).toBe(true);
    expect(res.retired).toEqual([`${EXP}/r.md`]);
  });

  it("is total: a throwing or refusing engine is `unreadable`, a missing retired list is null", async () => {
    const engine = new FakeEngine(
      async (_a, q) => {
        if (q.includes("security")) throw new Error("boom");
        return { ok: false, reason: "find 401: Invalid API Key" };
      },
      () => Promise.reject(new Error("sweep failed")),
    );
    const t = manualTimer();
    const res = await prefetchLessons(engine, finds, { budgetMs: 100, timer: t.timer });
    const outs = [...res.outcomes.values()];
    expect(outs.every((o) => o.status === "unreadable")).toBe(true);
    expect(outs.map((o) => (o.status === "unreadable" ? o.reason : "")).join("|")).toMatch(/boom/);
    expect(outs.map((o) => (o.status === "unreadable" ? o.reason : "")).join("|")).toMatch(
      /Invalid API Key/,
    );
    expect(res.retired).toBeNull();
  });
});

describe("prefetchLessons — never more than PREFETCH_MAX_IN_FLIGHT finds on the embedder", () => {
  // Six distinct finds: the cases find and five rows.
  const six = planFinds({
    title: "T",
    rows: Array.from({ length: 5 }, (_, i) => ({ row: i, lens: `pass-l${i}`, agent: "a" })),
    prFiles: ["x.py"],
  }).finds;

  it("holds two places at once; each later find is told what is LEFT of the budget; one still waiting at the deadline is never sent", async () => {
    expect(six).toHaveLength(6);
    expect(PREFETCH_MAX_IN_FLIGHT).toBe(2);
    let now = 0;
    const answer: Array<() => void> = [];
    const engine = new FakeEngine(
      () =>
        new Promise((r) =>
          answer.push(() => r({ ok: true, hits: [] })),
        ),
    );
    const t = manualTimer();
    const p = prefetchLessons(engine, six, { budgetMs: 2000, timer: t.timer, clock: () => now });
    await flush();
    // The cases find (planned first) and the first row — and nothing else.
    expect(engine.finds.map((f) => f.area)).toEqual(["finding-cases", "experiences"]);
    expect(engine.finds.map((f) => f.timeoutMs)).toEqual([2000, 2000]);
    now = 500;
    answer.shift()!();
    await flush();
    expect(engine.finds).toHaveLength(3);
    expect(engine.finds[2]!.timeoutMs).toBe(1500);
    now = 1900;
    answer.shift()!();
    await flush();
    expect(engine.finds).toHaveLength(4);
    expect(engine.finds[3]!.timeoutMs).toBe(100);
    t.fire();
    const res = await p;
    await flush();
    // Two still waiting for a slot at the deadline: never sent, timeouts.
    expect(engine.finds).toHaveLength(4);
    expect(res.sent).toBe(4);
    const statuses = six.map((f) => res.outcomes.get(f.key)!.status);
    expect(statuses).toEqual(["ok", "ok", "timeout", "timeout", "timeout", "timeout"]);
    // A late answer to a find that was out changes nothing.
    answer.splice(0).forEach((a) => a());
    await flush();
    expect(six.map((f) => res.outcomes.get(f.key)!.status)).toEqual(statuses);
  });

  it("a hung find gives its place back at the deadline — the slots never leak", async () => {
    const slots = new FindSlots(2);
    const engine = new FakeEngine(() => never());
    const t = manualTimer();
    const p = prefetchLessons(engine, six, { budgetMs: 2000, timer: t.timer, slots });
    await flush();
    expect(slots.inFlight()).toBe(2);
    t.fire();
    await p;
    await flush();
    expect(slots.inFlight()).toBe(0);
    expect(engine.finds).toHaveLength(2);
  });

  it("one selector's rounds SHARE the places: two rounds together still hold two", async () => {
    const store = new StateStore(":memory:");
    const ledger = new LessonLedger(store);
    const engine = new FakeEngine(() => never());
    const t = manualTimers();
    const s = new RoundLessonSelector({
      ledger,
      mode: () => "shadow",
      engine: () => engine,
      budgetMs: 2000,
      timer: t.timer,
    });
    s.start(order({ round_id: 7 }), [{ filename: "docs/guide.md" }]);
    s.start(order({ pr: 43, round_id: 8 }), [{ filename: "backend/x.py" }]);
    await flush();
    expect(engine.finds).toHaveLength(PREFETCH_MAX_IN_FLIGHT);
    t.fireAll();
    await s.idle();
    expect(engine.finds).toHaveLength(PREFETCH_MAX_IN_FLIGHT);
    for (const id of [7, 8]) {
      const row = ledger.roundRow(id)!;
      expect(row.state).toBe("timeout");
      expect(row.timeouts).toBe(row.finds);
    }
    store.close();
  });
});

describe("a shadow find aborted at the budget never reaches memory health", () => {
  const T = Date.parse("2026-10-07T10:00:00Z");
  const OK: ProbeAnswer = { result: "ok", status: 200, code: "", ms: 3 };
  /** A server slower than any budget: every request ends only when its own
   * deadline aborts it. */
  const slow: HttpFetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    });

  async function healthyMonitor(): Promise<MemoryHealthMonitor> {
    const m = new MemoryHealthMonitor({
      probes: { daemon: async () => OK, sessions: async () => OK },
      wake: () => {},
      now: () => new Date(T),
    });
    await m.probeNow();
    expect(m.currentState()).toBe("healthy");
    return m;
  }

  it(
    "the lesson client has no observer: six aborted finds leave health HEALTHY — through the daemon's shared client they read DEGRADED",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const finds = planFinds({
        title: "T",
        rows: Array.from({ length: 5 }, (_, i) => ({ row: i, lens: `pass-l${i}`, agent: "a" })),
        prFiles: ["x.py"],
      }).finds;
      const base = { baseUrl: "http://127.0.0.1:1933", apiKey: "k".repeat(16), fetchFn: slow };

      // Production: the lesson engine's OWN client — even handed the
      // observers, it drops them.
      const health = await healthyMonitor();
      let gaps = 0;
      const lessonClient = lessonFindClient({
        ...base,
        ...({
          onRequest: (r: Parameters<MemoryHealthMonitor["recordRequest"]>[0]) =>
            health.recordRequest(r),
          onGap: () => (gaps += 1),
        } as object),
      });
      const res = await prefetchLessons(
        openVikingLessonEngine(lessonClient, { retiredUris: async () => [] }),
        finds,
        { budgetMs: 40, slots: new FindSlots(6) },
      );
      expect(res.sent).toBe(6);
      expect([...res.outcomes.values()].every((o) => o.status !== "ok")).toBe(true);
      await new Promise((r) => setTimeout(r, 30));
      expect(health.currentState()).toBe("healthy");
      expect(health.status().requests["find"]).toBeUndefined();
      expect(gaps).toBe(0);

      // The control: the same aborts through an OBSERVED client degrade it —
      // which is exactly what the lesson client exists to prevent.
      const shared = await healthyMonitor();
      const observed = new OpenVikingClient({
        ...base,
        onRequest: (r) => shared.recordRequest(r),
      });
      await prefetchLessons(
        openVikingLessonEngine(observed, { retiredUris: async () => [] }),
        finds,
        { budgetMs: 40, slots: new FindSlots(6) },
      );
      await new Promise((r) => setTimeout(r, 30));
      expect(shared.currentState()).toBe("degraded");
    },
  );
});

// ---- the selector ---------------------------------------------------------------

describe("RoundLessonSelector", () => {
  let store: StateStore;
  let ledger: LessonLedger;
  beforeEach(() => {
    store = new StateStore(":memory:");
    ledger = new LessonLedger(store);
  });
  afterEach(() => store.close());

  function selector(
    engine: LessonEngine | null,
    mode: "off" | "shadow" | "on" = "shadow",
    timer?: PrefetchTimer,
  ) {
    return new RoundLessonSelector({
      ledger,
      mode: () => mode,
      engine: () => engine,
      budgetMs: 2000,
      ...(timer ? { timer } : {}),
    });
  }

  it("`off` runs NOTHING: no engine call, no ledger row", async () => {
    const engine = new FakeEngine(async () => ({ ok: true, hits: [] }));
    const s = selector(engine, "off");
    s.start(order(), [{ filename: "docs/guide.md" }]);
    await s.idle();
    expect(engine.finds).toEqual([]);
    expect(ledger.roundRow(7)).toBeUndefined();
  });

  it("`shadow` and `on` select and record — rows, validator, cases — with the event", async () => {
    for (const mode of ["shadow", "on"] as const) {
      const engine = new FakeEngine(async (area) =>
        area === "experiences"
          ? {
              ok: true,
              hits: [
                { uri: `${EXP}/20261001T000000-dr.md`, score: 0.3, text: lessonText("dont-raise") },
                { uri: `${EXP}/20261001T000000-lf.md`, score: 0.9, text: lessonText("look-for") },
              ],
            }
          : { ok: true, hits: [] },
      );
      const s = selector(engine, mode);
      s.start(order({ round_id: mode === "on" ? 8 : 7 }), [{ filename: "docs/guide.md" }]);
      await s.idle();
      const row = ledger.roundRow(mode === "on" ? 8 : 7)!;
      expect(row).toMatchObject({
        mode,
        state: "selected",
        finds: 3,
        answered: 3,
        timeouts: 0,
        retired_list: 1,
      });
      const sel = ledger.selections(row.round_id);
      expect(sel.map((x) => `${x.role}:${x.row}`)).toEqual(["row:0", "validator:1", "cases:-1"]);
      expect(sel[0]!.lessons.map((l) => l.uri).sort()).toEqual([
        `${EXP}/20261001T000000-dr.md`,
        `${EXP}/20261001T000000-lf.md`,
      ]);
      expect(sel[1]!.lessons.map((l) => l.uri)).toEqual([`${EXP}/20261001T000000-dr.md`]);
    }
    expect(eventsOf(store, "lesson_selection").map((e) => e["state"])).toEqual([
      "selected",
      "selected",
    ]);
  });

  it("suppressed, retired (list or header) and moved lessons are NEVER selected, for any role", async () => {
    const hits: FindHit[] = [
      { uri: `${EXP}/s.md`, score: 0.99, text: lessonText("dont-raise") },
      { uri: `${EXP}/r.md`, score: 0.99, text: lessonText("dont-raise") },
      { uri: `${EXP}/h.md`, score: 0.99, text: `#retired ${lessonText("dont-raise")}` },
      { uri: `${EXP}/m.md`, score: 0.99, text: "#retired #moved moved-to=events/x.md\nmoved" },
      { uri: `${EXP}/ok.md`, score: 0.01, text: lessonText("dont-raise") },
    ];
    const engine = new FakeEngine(
      async (area) => ({ ok: true, hits: area === "experiences" ? hits : [] }),
      async () => [`${EXP}/r.md`],
    );
    ledger.apply({ action: "suppress", uri: `${EXP}/s.md` }, "op-1.json");
    const s = selector(engine);
    s.start(order(), [{ filename: "docs/guide.md" }]);
    await s.idle();
    const all = ledger.selections(7).flatMap((x) => x.lessons.map((l) => l.uri));
    expect(new Set(all)).toEqual(new Set([`${EXP}/ok.md`]));
    expect(ledger.roundRow(7)!.suppressed).toBe(1);
    expect(ledger.selections(7)[0]!.dropped).toEqual({ suppressed: 1, retired: 2, moved: 1 });
    // Unsuppressed, it is selected again on the very next round.
    expect(ledger.apply({ action: "unsuppress", uri: `${EXP}/s.md` }, "op-1b.json").changed).toBe(
      true,
    );
    s.start(order({ round_id: 9, round_no: 2 }), [{ filename: "docs/guide.md" }]);
    await s.idle();
    expect(ledger.roundRow(9)!.suppressed).toBe(0);
    expect(new Set(ledger.selections(9).flatMap((x) => x.lessons.map((l) => l.uri)))).toEqual(
      new Set([`${EXP}/s.md`, `${EXP}/ok.md`]),
    );
  });

  it("the operator's kill switch: no engine call, the round recorded lessons_off; on again selects again", async () => {
    const engine = new FakeEngine(async () => ({ ok: true, hits: [] }));
    ledger.apply({ action: "off" }, "op-2.json");
    const s = selector(engine);
    s.start(order(), [{ filename: "docs/guide.md" }]);
    await s.idle();
    expect(engine.finds).toEqual([]);
    expect(ledger.roundRow(7)).toMatchObject({ state: "lessons_off", finds: 0 });
    expect(ledger.selections(7)).toEqual([]);
    ledger.apply({ action: "on" }, "op-3.json");
    s.start(order({ round_id: 9, round_no: 2 }), [{ filename: "docs/guide.md" }]);
    await s.idle();
    expect(engine.finds.length).toBeGreaterThan(0);
    expect(ledger.roundRow(9)!.state).toBe("selected");
  });

  it("no engine yet (daemon starting): recorded unreadable, never a throw", async () => {
    const s = selector(null);
    s.start(order(), [{ filename: "a.py" }]);
    await s.idle();
    expect(ledger.roundRow(7)).toMatchObject({ state: "unreadable", refused: 3 });
    expect(ledger.roundRow(7)!.note).toMatch(/not built yet/);
  });

  it("start never throws, whatever breaks under it", async () => {
    const s = new RoundLessonSelector({
      ledger,
      mode: () => {
        throw new Error("cfg");
      },
      engine: () => null,
      budgetMs: 10,
    });
    expect(() => s.start(order(), [])).not.toThrow();
    const closed = new StateStore(":memory:");
    const l2 = new LessonLedger(closed);
    closed.close();
    const s2 = new RoundLessonSelector({
      ledger: l2,
      mode: () => "shadow",
      engine: () => null,
      budgetMs: 10,
    });
    expect(() => s2.start(order(), [])).not.toThrow();
    await s2.idle();
  });
});

// ---- dispatch is never delayed ------------------------------------------------------

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

describe("the budget and its timeout never delay a round (fake clock)", () => {
  afterEach(() => vi.useRealTimers());

  it(
    "the round is DISPATCHED while every find hangs; the 2 s deadline then records the timeout",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      vi.useFakeTimers({ now: new Date("2026-10-07T10:00:00Z") });
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
      const engine = new FakeEngine(
        () => never(),
        () => never(),
      );
      const logs: string[] = [];
      const selector = new RoundLessonSelector({
        ledger,
        mode: () => "shadow",
        engine: () => engine,
        budgetMs: cfg.memory.delivery_budget_ms,
        log: (m) => logs.push(m),
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
      // No timer is advanced: if dispatch waited on the prefetch, this await
      // would never resolve and the test would time out.
      const orders = await dispatchOnce({
        cfg,
        store,
        adapter: new MiniAdapter(),
        hooks,
        lessons: selector,
      });
      expect(orders).toHaveLength(1);
      expect(prompts).toHaveLength(1);
      expect(engine.finds.length).toBeGreaterThan(0);
      expect(ledger.roundRow(orders[0]!.round_id)).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1999);
      expect(ledger.roundRow(orders[0]!.round_id)).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await selector.idle();
      const row = ledger.roundRow(orders[0]!.round_id)!;
      expect(row).toMatchObject({ state: "timeout", answered: 0, retired_list: 0 });
      expect(row.timeouts).toBe(row.finds);
      expect(row.prefetch_ms).toBe(2000);
      expect(
        ledger
          .selections(row.round_id)
          .every((s) => s.status === "timeout" && s.lessons.length === 0),
      ).toBe(true);
      // …and LOGGED, once, with the event carrying the same count.
      const timeoutLogs = logs.filter((m) => /prefetch deadline/.test(m));
      expect(timeoutLogs).toHaveLength(1);
      expect(timeoutLogs[0]).toMatch(
        new RegExp(
          `prefetch deadline \\(2000 ms\\) passed with ${row.finds} of ${row.finds} find\\(s\\) out`,
        ),
      );
      expect(timeoutLogs[0]).toContain("the round was not delayed");
      const ev = eventsOf(store, "lesson_selection")[0]!;
      expect(ev).toMatchObject({ state: "timeout", timeouts: row.finds, finds: row.finds });
      expect(ev["sent"]).toBe(Math.min(row.finds, PREFETCH_MAX_IN_FLIGHT));
      store.close();
    },
  );

  it(
    "the lesson finds go out only AFTER the round's memory seed and its handoff",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
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
      const calls: string[] = [];
      const engine = new FakeEngine(async (area) => {
        calls.push(`find:${area}`);
        return { ok: true, hits: [] };
      });
      const assembler: ContextAssembler = {
        pinnedHead: async () => {
          calls.push("seed:head");
          return { status: "read", text: "" };
        },
        contextBlock: async () => {
          calls.push("seed:block");
          return { status: "read", text: "" };
        },
      };
      const selector = new RoundLessonSelector({
        ledger,
        mode: () => "shadow",
        engine: () => engine,
        budgetMs: cfg.memory.delivery_budget_ms,
      });
      const hooks: SessionHooks = {
        async dispatchRound() {
          calls.push("handoff");
        },
        async inject() {},
        async injectOverseer() {},
        async archiveAndClose() {},
      };
      const orders = await dispatchOnce({
        cfg,
        store,
        adapter: new MiniAdapter(),
        hooks,
        memory: { assembler, timeoutMs: 3000 },
        lessons: selector,
      });
      await selector.idle();
      expect(orders).toHaveLength(1);
      const firstFind = calls.findIndex((c) => c.startsWith("find:"));
      expect(firstFind, calls.join(" → ")).toBeGreaterThan(0);
      expect(calls.slice(0, firstFind)).toEqual(
        expect.arrayContaining(["seed:head", "seed:block", "handoff"]),
      );
      expect(calls.slice(firstFind).every((c) => c.startsWith("find:"))).toBe(true);
      expect(ledger.roundRow(orders[0]!.round_id)!.state).toBe("selected");
      store.close();
    },
  );
});

// ---- the operator's kill switch: the sealed channel only ---------------------------

describe("lessons-off / lessons-on / suppress-lesson / unsuppress-lesson — operator only", () => {
  const URI = `${EXP}/20261001T000000-x.md`;

  it("are not in the session vocabulary, and a session cannot spell them", () => {
    for (const c of OPERATOR_COMMANDS) expect(COMMAND_WHITELIST).not.toContain(c);
    for (const raw of [
      { command: "lessons-off" },
      { command: "lessons-on" },
      { command: "suppress-lesson", uri: URI },
      { command: "unsuppress-lesson", uri: URI },
    ]) {
      const v = validateCommand(raw);
      expect(v.ok, raw.command).toBe(false);
      if (!v.ok) expect(v.reason).toMatch(/OPERATOR's alone/);
      expect(validateCommand(raw, { issuer: "session" }).ok).toBe(false);
      expect(validateCommand(raw, { issuer: "operator" }).ok).toBe(true);
    }
  });

  it("strict schemas from the operator channel", () => {
    const op = { issuer: "operator" as const };
    expect(validateCommand({ command: "lessons-off", uri: URI }, op)).toEqual({
      ok: false,
      reason: "unknown field(s): uri",
    });
    for (const bad of [
      "experiences/x.md",
      "viking://user/reviewer/memories/../x.md",
      `${URI} `,
      "viking://resources/x.md",
    ])
      expect(validateCommand({ command: "suppress-lesson", uri: bad }, op).ok, bad).toBe(false);
    expect(validateCommand({ command: "suppress-lesson", uri: URI }, op)).toEqual({
      ok: true,
      command: { command: "suppress-lesson", uri: URI },
    });
  });

  it("executeCommand refuses any issuer but the operator, and Slack can never authorize them", async () => {
    const calls: unknown[] = [];
    const deps = {
      lessonSwitch: (c: unknown) => (calls.push(c), { ok: true }),
    } as unknown as CommandDeps;
    const res = await executeCommand({ command: "lessons-off" }, deps);
    expect(res.ok).toBe(false);
    expect(
      await executeCommand({ command: "lessons-off" }, deps, { file: "f", issuer: "session" }),
    ).toMatchObject({ ok: false });
    expect(calls).toEqual([]);
    const op = { file: "f", issuer: "operator" as const };
    expect(await executeCommand({ command: "suppress-lesson", uri: URI }, deps, op)).toEqual({
      ok: true,
    });
    await executeCommand({ command: "unsuppress-lesson", uri: URI }, deps, op);
    await executeCommand({ command: "lessons-off" }, deps, op);
    await executeCommand({ command: "lessons-on" }, deps, op);
    // Each command maps to ITS change — an unsuppress is never a suppress.
    expect(calls).toEqual([
      { action: "suppress", uri: URI },
      { action: "unsuppress", uri: URI },
      { action: "off" },
      { action: "on" },
    ]);
    const owner = { tier: "owner", source: "slack", slack_user: "U1", authorized_prs: [] } as never;
    expect(authorizeCommand({ command: "lessons-on" }, owner)).toMatchObject({ ok: false });
    expect(authorizeCommand({ command: "lessons-on" }, null)).toMatchObject({ ok: false });
  });

  describe("through the CommandWatcher", () => {
    let root: string;
    let store: StateStore;
    let ledger: LessonLedger;
    const sealed: OperatorSeal = {
      euid: 1001,
      gids: [1001],
      stat: (p) =>
        p.endsWith(".json")
          ? { uid: 0, gid: 0, mode: 0o644, kind: "file" }
          : { uid: 0, gid: 0, mode: 0o755, kind: "dir" },
    };
    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "qcr-lessonswitch-"));
      mkdirSync(join(root, "commands"), { recursive: true });
      store = new StateStore(":memory:");
      ledger = new LessonLedger(store);
    });
    afterEach(() => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    });
    const deps = (): CommandDeps =>
      ({
        lessonSwitch: (
          change: Parameters<NonNullable<CommandDeps["lessonSwitch"]>>[0],
          file: string,
        ) => {
          const r = ledger.apply(change, file);
          return {
            ok: true,
            changed: r.changed,
            lessons_off: r.lessons_off,
            suppressed: r.suppressed.length,
          };
        },
      }) as unknown as CommandDeps;
    const result = (dir: string, name: string) =>
      JSON.parse(readFileSync(join(dir, "results", `${name}.result.json`), "utf8")) as Record<
        string,
        unknown
      >;

    it("the SEALED operator directory flips the switch, stored in state.db", async () => {
      const op = join(root, "commands", "operator");
      mkdirSync(op);
      writeFileSync(join(op, "k1.json"), JSON.stringify({ command: "lessons-off" }));
      writeFileSync(join(op, "k2.json"), JSON.stringify({ command: "suppress-lesson", uri: URI }));
      const w = new CommandWatcher({
        dir: op,
        operator: sealed,
        deps: deps(),
        store,
        sweepIntervalMs: 0,
      });
      await w.sweep();
      w.stop();
      expect(result(join(root, "commands"), "k1")).toMatchObject({
        ok: true,
        issuer: "operator",
        lessons_off: true,
      });
      expect(result(join(root, "commands"), "k2")).toMatchObject({ ok: true, suppressed: 1 });
      expect(ledger.switchState()).toMatchObject({ lessons_off: true, suppressed: [URI] });
      expect(eventsOf(store, "lesson_switch_changed").map((e) => e["action"])).toEqual([
        "off",
        "suppress",
      ]);
      // A fresh ledger over the same database reads the same switch.
      expect(new LessonLedger(store).lessonsOff()).toBe(true);

      // The other half: unsuppress and lessons-on undo them, in state.db.
      writeFileSync(join(op, "k3.json"), JSON.stringify({ command: "unsuppress-lesson", uri: URI }));
      writeFileSync(join(op, "k4.json"), JSON.stringify({ command: "lessons-on" }));
      const w2 = new CommandWatcher({
        dir: op,
        operator: sealed,
        deps: deps(),
        store,
        sweepIntervalMs: 0,
      });
      await w2.sweep();
      expect(result(join(root, "commands"), "k3")).toMatchObject({
        ok: true,
        issuer: "operator",
        changed: true,
        suppressed: 0,
      });
      expect(result(join(root, "commands"), "k4")).toMatchObject({
        ok: true,
        changed: true,
        lessons_off: false,
      });
      expect(ledger.switchState()).toMatchObject({ lessons_off: false, suppressed: [] });
      // Unsuppressing what is not suppressed changes nothing, and says so.
      writeFileSync(join(op, "k5.json"), JSON.stringify({ command: "unsuppress-lesson", uri: URI }));
      await w2.sweep();
      w2.stop();
      expect(result(join(root, "commands"), "k5")).toMatchObject({ ok: true, changed: false });
      // Every operator command is in the audit trail, with whether it changed anything.
      expect(
        eventsOf(store, "lesson_switch_changed").map((e) => `${String(e["action"])}:${String(e["changed"])}`),
      ).toEqual(["off:true", "suppress:true", "unsuppress:true", "on:true", "unsuppress:false"]);
    });

    it("a SESSION's command directory cannot spell them", async () => {
      const dir = join(root, "commands");
      writeFileSync(join(dir, "s1.json"), JSON.stringify({ command: "lessons-off" }));
      const w = new CommandWatcher({ dir, deps: deps(), store, log: () => {} });
      await w.sweep();
      w.stop();
      expect(result(dir, "s1")).toMatchObject({
        ok: false,
        issuer: "session",
        reason: expect.stringMatching(/OPERATOR's alone/),
      });
      expect(ledger.lessonsOff()).toBe(false);
    });

    it("an UNSEALED operator directory is a session's: refused, loudly", async () => {
      const op = join(root, "commands", "operator");
      mkdirSync(op);
      writeFileSync(join(op, "u1.json"), JSON.stringify({ command: "lessons-off" }));
      const w = new CommandWatcher({
        dir: op,
        operator: processOperatorSeal(),
        deps: deps(),
        store,
        sweepIntervalMs: 0,
        log: () => {},
      });
      await w.sweep();
      w.stop();
      expect(result(join(root, "commands"), "u1")).toMatchObject({ ok: false, issuer: "session" });
      expect(eventsOf(store, "operator_channel_unsealed")).toHaveLength(1);
      expect(ledger.lessonsOff()).toBe(false);
    });
  });

  it("the CLI client's payload is the daemon-validated shape; an id expands to the reviewer's URI", () => {
    expect(JSON.parse(lessonSwitchPayload({ command: "lessons-off" }))).toEqual({
      command: "lessons-off",
    });
    expect(() => lessonSwitchPayload({ command: "suppress-lesson", uri: "bogus" })).toThrow(/uri/);
    expect(lessonUriOf("experiences/x.md", "reviewer")).toBe(`${EXP}/x.md`);
    expect(lessonUriOf(`${EXP}/y.md`, "reviewer")).toBe(`${EXP}/y.md`);
    expect(parseLessonsSubcommand(["shadow-report", "--days", "30"])).toEqual({
      kind: "shadow-report",
      days: 30,
    });
    expect(parseLessonsSubcommand(["shadow-report"])).toEqual({ kind: "shadow-report", days: 14 });
    expect(parseLessonsSubcommand(["off"])).toEqual({ kind: "switch", command: "lessons-off" });
    expect(parseLessonsSubcommand(["suppress", "experiences/x.md"])).toEqual({
      kind: "switch",
      command: "suppress-lesson",
      target: "experiences/x.md",
    });
    expect(parseLessonsSubcommand(["mine"])).toBeNull();
    expect(() => parseLessonsSubcommand(["shadow-report", "--dayz", "3"])).toThrow();
    expect(() => parseLessonsSubcommand(["suppress"])).toThrow();
  });

  describe("the CLI client (`qcr lessons off|on|suppress|unsuppress`)", () => {
    const tui = {
      ssh_host: "my-vm",
      container: "quickreview-sandbox",
      sudo_docker: true,
      remote_sandbox_root: "/opt/quickreview/sandbox",
      remote_state_dir: "/opt/quickreview/state",
      msg_timeout_s: 30,
    } as unknown as TuiConfig;

    /** Records every ssh call; the result probe answers from `results`. */
    function runner(results: string[]): {
      ssh: SshRunner;
      calls: Array<{ argv: string[]; stdin?: string }>;
    } {
      const calls: Array<{ argv: string[]; stdin?: string }> = [];
      const ssh: SshRunner = async (_host, argv, opts) => {
        calls.push({ argv, ...(opts?.stdin !== undefined ? { stdin: opts.stdin } : {}) });
        const probe = argv.some((a) => a.includes("result.json"));
        return {
          ok: true,
          stdout: probe ? (results.shift() ?? "pending") : "",
          stderr: "",
          code: 0,
        } satisfies RemoteResult;
      };
      return { ssh, calls };
    }

    function sender(ssh: SshRunner, now: () => Date = () => new Date("2026-10-07T10:00:00Z")) {
      return new LessonSwitchSender(tui, ssh, now, async () => {});
    }

    it("writes AS ROOT into commands/operator/, the payload on stdin, and reports the daemon's own answer", async () => {
      const { ssh, calls } = runner([
        "pending",
        JSON.stringify({ ok: true, issuer: "operator", changed: true, suppressed: 1 }),
      ]);
      const out = await sender(ssh).send({ command: "suppress-lesson", uri: URI });
      expect(out).toEqual({ ok: true, changed: true, suppressed: 1, issuer: "operator" });
      const write = calls[0]!;
      expect(write.argv.slice(0, 7)).toEqual(["sudo", "docker", "exec", "-i", "-u", "0", "quickreview-sandbox"]);
      expect(write.argv.join(" ")).toContain("commands/operator");
      // Nothing about the request rides the command line.
      expect(write.argv.join(" ")).not.toContain(URI);
      expect(JSON.parse(write.stdin!)).toEqual({ command: "suppress-lesson", uri: URI });
      // The receipt is read back, never inferred from the write.
      expect(calls.slice(1).every((c) => c.argv.some((a) => a.includes("result.json")))).toBe(true);
      expect(calls).toHaveLength(3);
    });

    it("an UNSEALED operator directory comes back as a session's refusal, never as success", async () => {
      const { ssh } = runner([
        JSON.stringify({
          ok: false,
          issuer: "session",
          reason: "command 'lessons-off' is the OPERATOR's alone",
        }),
      ]);
      const out = await sender(ssh).send({ command: "lessons-off" });
      expect(out).toMatchObject({ ok: false, issuer: "session" });
      expect(out.reason).toMatch(/OPERATOR's alone/);
    });

    it("lessons-off reports the switch; a failed write and a silent daemon are failures", async () => {
      const ok = runner([JSON.stringify({ ok: true, issuer: "operator", lessons_off: true })]);
      expect(await sender(ok.ssh).send({ command: "lessons-off" })).toEqual({
        ok: true,
        lessons_off: true,
        issuer: "operator",
      });
      const failing: SshRunner = async () => ({
        ok: false,
        stdout: "",
        stderr: "daemon commands dir missing",
        code: 1,
      });
      expect(await sender(failing).send({ command: "lessons-on" })).toMatchObject({
        ok: false,
        reason: expect.stringContaining("daemon commands dir missing"),
      });
      // The deadline: the daemon never answers.
      let t = Date.parse("2026-10-07T10:00:00Z");
      const silent = runner([]);
      const s = new LessonSwitchSender(tui, silent.ssh, () => new Date(t), async (ms) => {
        t += ms;
      });
      expect(await s.send({ command: "lessons-on" })).toMatchObject({
        ok: false,
        reason: expect.stringContaining("no result before timeout"),
      });
      // A command the daemon's validator would refuse is never written at all.
      const none = runner([]);
      expect(
        await sender(none.ssh).send({ command: "suppress-lesson", uri: "experiences/x.md" }),
      ).toMatchObject({ ok: false });
      expect(none.calls).toEqual([]);
    });
  });
});

// ---- the matcher, the marks, the report -----------------------------------------------

function sl(
  uri: string,
  kind: SelectedLesson["kind"],
  cls: string | null,
  lens: string[],
  paths: string[],
): SelectedLesson {
  return {
    uri,
    kind,
    class: cls,
    lens,
    paths,
    evidence: 1,
    format: cls ? "typed" : "legacy",
    tokens: 10,
    score: 0.5,
    created: "2026-10-01",
  };
}

const L1 = `${EXP}/20261001T000000-dr-docs.md`;
const L2 = `${EXP}/20261001T000000-legacy.md`;
const L3 = `${EXP}/20261001T000000-lookfor.md`;
const L4 = `${EXP}/20261001T000000-dr-security.md`;

function selections(): RoleSelection[] {
  const base = { query: "q", status: "ok" as const, cases: [], cuts: [], dropped: {} };
  return [
    {
      ...base,
      role: "row",
      row: 0,
      lens: "pass-baseline",
      agent: "a",
      lessons: [
        sl(L1, "dont-raise", "baseline.scope", ["pass-baseline"], ["docs/**"]),
        sl(L2, "dont-raise", null, ["pass-baseline"], []),
        sl(L3, "look-for", "missed.backend", ["pass-baseline"], []),
      ],
    },
    { ...base, role: "row", row: 1, lens: "pass-security", agent: "b", lessons: [] },
    {
      ...base,
      role: "validator",
      row: 2,
      lens: "pass-validate",
      agent: "v",
      lessons: [
        sl(L1, "dont-raise", "baseline.scope", ["pass-baseline"], ["docs/**"]),
        sl(L4, "dont-raise", "security", ["pass-security"], []),
      ],
    },
    { ...base, role: "cases", row: -1, lens: "", agent: null, lessons: [] },
  ];
}

function finding(
  key: string,
  lens: string,
  kind: string,
  path: string | null,
  over: Partial<{ severity: string; disposition: string }> = {},
) {
  return {
    key,
    path,
    line: 3,
    lens,
    severity: over.severity ?? "P2",
    kind,
    disposition: (over.disposition ?? "posted") as "posted",
  };
}

describe("matchShadow — lens, class and path, deterministically", () => {
  it("marks exactly the posted findings every precondition holds for, with why and where", () => {
    const rows = [
      finding("f1", "pass-baseline", "scope", "docs/a.md"),
      finding("f3", "pass-baseline", "scope", "backend/x.py"),
      finding("f4", "pass-baseline", "scope", "docs/c.md", { disposition: "killed" }),
      finding("f5", "pass-security", "scope-creep", "backend/y.py"),
      finding("f9", "pass-ui", "scope", "docs/g.md"),
      finding("f10", "pass-baseline", "correctness", "docs/h.md"),
    ].map((f) => ({
      finding_key: f.key,
      path: f.path,
      lens: f.lens,
      lens_ids: null,
      kind: f.kind,
      severity: f.severity,
      disposition: f.disposition,
    }));
    const marks = matchShadow(selections(), rows);
    expect(marks.map((m) => `${m.finding_key}→${m.lesson_uri.slice(EXP.length + 1)}`)).toEqual([
      "f1→20261001T000000-dr-docs.md",
      "f5→20261001T000000-dr-security.md",
    ]);
    expect(marks[0]).toMatchObject({
      finding_class: "baseline.scope",
      lesson_class: "baseline.scope",
      via: ["row:0", "validator"],
    });
    expect(marks[0]!.why).toContain("path docs/a.md matches docs/**");
    expect(marks[1]).toMatchObject({
      finding_class: "security.scope-creep",
      lesson_class: "security",
      via: ["validator"],
    });
    // The same input in another order gives the same marks.
    expect(matchShadow([...selections()].reverse(), [...rows].reverse())).toEqual(marks);
  });

  it("a legacy dont-raise lesson with no class marks nothing (its class cannot be checked)", () => {
    const only = [
      { ...selections()[0]!, lessons: [sl(L2, "dont-raise", null, ["pass-baseline"], [])] },
    ];
    expect(
      matchShadow(only, [
        {
          finding_key: "f",
          path: "a",
          lens: "pass-baseline",
          lens_ids: null,
          kind: "x",
          severity: "P2",
          disposition: "posted",
        },
      ]),
    ).toEqual([]);
  });

  it("a dont-raise lesson naming only pass-validate judges every lens's finding (the validator sees them all)", () => {
    const only = [
      {
        ...selections()[2]!,
        lessons: [sl(L4, "dont-raise", "baseline.scope", ["pass-validate"], [])],
      },
    ];
    const marks = matchShadow(only, [
      {
        finding_key: "f",
        path: "docs/a.md",
        lens: "pass-baseline",
        lens_ids: null,
        kind: "scope",
        severity: "P2",
        disposition: "posted",
      },
    ]);
    expect(marks.map((m) => m.finding_key)).toEqual(["f"]);
    expect(marks[0]!.why).toContain("the lesson names pass-validate");
    expect(marks[0]!.via).toEqual(["validator"]);
  });

  it("bucketOf: P0 exempt first, then the fate, then a set-aside review", () => {
    expect(bucketOf("P0", "fixed", false)).toBe("exempt_p0");
    expect(bucketOf("P1", "fixed", true)).toBe("harm");
    expect(bucketOf("P2", "refuted_conceded", false)).toBe("help_refuted");
    expect(bucketOf("P2", "unknown", true)).toBe("help_set_aside");
    expect(bucketOf("P2", "upheld_after_reply", false)).toBe("upheld");
    expect(bucketOf("P2", "upheld_after_reply", true)).toBe("upheld");
    expect(bucketOf("P2", "open_at_close", true)).toBe("help_set_aside");
    expect(bucketOf("P2", "open_at_close", false)).toBe("ignored");
    expect(bucketOf("P2", null, false)).toBe("unknown");
  });
});

describe("the shadow report over a fixture joined with fates", () => {
  let store: StateStore;
  let ledger: LessonLedger;
  let clock: Date;
  beforeEach(() => {
    store = new StateStore(":memory:");
    clock = new Date("2026-10-05T10:00:00Z");
    ledger = new LessonLedger(store, () => clock);
    new OutcomeCapture({ store, botLogin: "bot" });
    new Learner({
      store,
      root: "/nonexistent",
      eodTime: "18:00",
      timeZone: "Europe/Warsaw",
      botLogin: "bot",
      baseBranch: "master",
    });
  });
  afterEach(() => store.close());

  function seed(): void {
    ledger.recordRound(
      {
        round_id: 11,
        pr: 100,
        round_no: 1,
        mode: "shadow",
        state: "selected",
        finds: 3,
        answered: 3,
        timeouts: 0,
        refused: 0,
        prefetch_ms: 140,
        retired_list: 1,
        suppressed: 0,
        as_of: null,
        note: null,
      },
      selections(),
    );
    store.recordRoundFindings({ pr: 100, round_id: 11, round_no: 1, head_sha: "h" }, [
      finding("f1", "pass-baseline", "scope", "docs/a.md"),
      finding("f2", "pass-baseline", "scope", "docs/b.md", { severity: "P1" }),
      finding("f3", "pass-baseline", "scope", "backend/x.py"),
      finding("f4", "pass-baseline", "scope", "docs/c.md", { disposition: "killed" }),
      finding("f5", "pass-security", "scope-creep", "backend/y.py"),
      finding("f6", "pass-baseline", "scope", "docs/d.md", { severity: "P0" }),
      finding("f7", "pass-baseline + pass-security", "scope", "docs/e.md"),
      finding("f8", "pass-baseline", "scope", "docs/f.md"),
    ] as never);
    const fate = (key: string, f: string) =>
      store.db
        .prepare(
          "INSERT INTO finding_outcomes (pr, round_no, finding_key, fate, human_replies, fate_changed_at, updated_at) VALUES (100, 1, ?, ?, 0, 'x', 'x')",
        )
        .run(key, f);
    fate("f1", "fixed");
    fate("f2", "refuted_conceded");
    fate("f6", "fixed");
    fate("f7", "upheld_after_reply");
    fate("f8", "unknown");
    store.db
      .prepare(
        "INSERT INTO review_outcomes (signal_id, pr, kind, round_no, gh_review_id, at, recorded_at) VALUES (1, 100, 'set_aside', 1, 9, 'x', 'x')",
      )
      .run();
  }

  function candidate(id: number, source: string, cls: string, pr: number, at: string): void {
    store.db
      .prepare(
        `INSERT INTO lesson_candidates (ref, source, kind, polarity, class, pr, summary, occurred_at, mined_at, updated_at)
         VALUES (?, ?, 'human_root_comment', 'look-for', ?, ?, 's', ?, 'x', 'x')`,
      )
      .run(`ref-${id}`, source, cls, pr, at);
  }

  it("markRound writes the marks when the findings land; harm / help / upheld / unknown / P0 are counted per finding", () => {
    seed();
    const marks = markRound(ledger, store, 100, 1)!;
    expect(marks.map((m) => `${m.finding_key}:${m.lesson_uri.slice(EXP.length + 1)}`)).toEqual([
      "f1:20261001T000000-dr-docs.md",
      "f2:20261001T000000-dr-docs.md",
      "f5:20261001T000000-dr-security.md",
      "f6:20261001T000000-dr-docs.md",
      "f7:20261001T000000-dr-docs.md",
      "f7:20261001T000000-dr-security.md",
      "f8:20261001T000000-dr-docs.md",
    ]);
    expect(ledger.marks(100, 1)).toHaveLength(7);
    expect(eventsOf(store, "lesson_shadow_marked")).toEqual([
      { round_no: 1, marks: 7, findings: 6 },
    ]);
    // Re-marking replaces, never doubles.
    markRound(ledger, store, 100, 1);
    expect(ledger.marks(100, 1)).toHaveLength(7);

    candidate(1, "recall", "missed.backend", 100, "2026-10-06T00:00:00Z");
    candidate(2, "recall", "missed.backend.api", 200, "2026-10-06T01:00:00Z");
    candidate(3, "recheck", "missed.backend", 100, "2026-10-06T02:00:00Z");
    candidate(4, "recall", "missed.backend", 100, "2026-09-01T00:00:00Z");
    candidate(5, "recall", "missed.frontend", 100, "2026-10-06T00:00:00Z");

    clock = new Date("2026-10-07T10:00:00Z");
    const r = shadowReport(ledger, { days: 7, mode: "shadow", now: () => clock });
    expect(r.rounds).toMatchObject({
      total: 1,
      selected: 1,
      with_timeouts: 0,
      prefetch_ms_p50: 140,
    });
    expect(r.marks).toBe(7);
    expect(r.findings).toEqual({
      total: 6,
      harm: 1, // f1: fixed
      help_refuted: 1, // f2: refuted
      help_set_aside: 2, // f5 (no fate row) and f8 (fate unknown) — their review was set aside
      upheld: 1, // f7: upheld beats the whole-review signal
      ignored: 0,
      unknown: 0,
      exempt_p0: 1, // f6 is P0 — fixed, but R2 never demotes a P0
    });
  });

  it("per lesson, per lens, the look-for misses, the unmeasurable — and the window", () => {
    seed();
    markRound(ledger, store, 100, 1);
    candidate(1, "recall", "missed.backend", 100, "2026-10-06T00:00:00Z");
    candidate(2, "recall", "missed.backend.api", 200, "2026-10-06T01:00:00Z");
    candidate(3, "recheck", "missed.backend", 100, "2026-10-06T02:00:00Z");
    candidate(4, "recall", "missed.backend", 100, "2026-09-01T00:00:00Z");
    candidate(5, "recall", "missed.frontend", 100, "2026-10-06T00:00:00Z");
    clock = new Date("2026-10-07T10:00:00Z");
    const r = shadowReport(ledger, { days: 7, mode: "shadow", now: () => clock });
    const docs = r.per_lesson.find((l) => l.uri === L1)!;
    expect(docs).toMatchObject({
      marks: 5,
      selected_rounds: 1,
      harm: 1,
      help_refuted: 1,
      upheld: 1,
      exempt_p0: 1,
      help_set_aside: 1,
    });
    const sec = r.per_lesson.find((l) => l.uri === L4)!;
    expect(sec).toMatchObject({ marks: 2, help_set_aside: 1, upheld: 1 });
    const baseline = r.per_lens.find((l) => l.lens === "pass-baseline")!;
    const security = r.per_lens.find((l) => l.lens === "pass-security")!;
    expect(baseline.marks).toBe(5); // f1 f2 f6 f7 f8
    expect(security.marks).toBe(2); // f5 f7 — f7 once though two lessons marked it
    expect(r.look_for).toEqual([
      {
        uri: L3,
        class: "missed.backend",
        selected_rounds: 1,
        first_selected_at: "2026-10-05T10:00:00.000Z",
        misses_after: 2, // the recheck reversal and the older one are not counted
        misses_on_selected_prs: 1,
      },
    ]);
    expect(r.unmeasurable_dont_raise).toEqual([L2]);
    const text = renderShadowReport(r);
    expect(text).toContain("would-demote: 7 mark(s) on 6 posted finding(s)");
    expect(text).toContain("harm 1 · help 3 (refuted 1, set aside 2)");
    expect(text).toContain("experiences/20261001T000000-dr-docs.md");
    expect(text).toContain("misses since 2026-10-05: 2 (on PRs it was selected for: 1)");
    expect(text).toContain("Dont-raise lessons with no class");
    // Outside the window, nothing.
    const later = shadowReport(ledger, {
      days: 1,
      mode: "shadow",
      now: () => new Date("2026-10-20T00:00:00Z"),
    });
    expect(later.marks).toBe(0);
    expect(later.rounds.total).toBe(0);
  });

  it("a finding posted again is ONE finding (its carried_to chain), and a set-aside counts only for its own round", () => {
    seed();
    // Round 2 of PR 100: f1 posted AGAIN (S6 carries round 1's row to it), and
    // a new finding g1 whose fate is unknown — round 2 was NOT set aside.
    ledger.recordRound(
      {
        round_id: 12,
        pr: 100,
        round_no: 2,
        mode: "shadow",
        state: "selected",
        finds: 3,
        answered: 3,
        timeouts: 0,
        refused: 0,
        prefetch_ms: 90,
        retired_list: 1,
        suppressed: 0,
        as_of: null,
        note: null,
      },
      selections(),
    );
    store.recordRoundFindings({ pr: 100, round_id: 12, round_no: 2, head_sha: "h2" }, [
      finding("f1b", "pass-baseline", "scope", "docs/a.md"),
      finding("g1", "pass-baseline", "scope", "docs/z.md"),
    ] as never);
    const insert = store.db.prepare(
      "INSERT INTO finding_outcomes (pr, round_no, finding_key, fate, human_replies, carried_to, fate_changed_at, updated_at) VALUES (100, 2, ?, ?, 0, NULL, 'x', 'x')",
    );
    insert.run("f1b", "fixed");
    insert.run("g1", "unknown");
    store.db
      .prepare(
        "UPDATE finding_outcomes SET carried_to = '2:f1b' WHERE pr = 100 AND round_no = 1 AND finding_key = 'f1'",
      )
      .run();
    markRound(ledger, store, 100, 1);
    markRound(ledger, store, 100, 2);
    expect(ledger.marks(100, 2).map((m) => m.finding_key).sort()).toEqual(["f1b", "g1"]);

    clock = new Date("2026-10-07T10:00:00Z");
    const r = shadowReport(ledger, { days: 7, mode: "shadow", now: () => clock });
    expect(r.marks).toBe(9); // mark ROWS: 7 in round 1, 2 in round 2
    expect(r.findings).toEqual({
      total: 7, // the six of round 1 (f1 and f1b one chain) + g1
      harm: 1, // the f1 → f1b chain, fixed once — not twice
      help_refuted: 1,
      help_set_aside: 2, // round 1's f5 and f8 only
      upheld: 1,
      ignored: 0,
      unknown: 1, // g1: round 2's review was not set aside
      exempt_p0: 1,
    });
    const docs = r.per_lesson.find((l) => l.uri === L1)!;
    expect(docs).toMatchObject({ marks: 6, harm: 1, unknown: 1, selected_rounds: 2 });
    expect(r.per_lens.find((l) => l.lens === "pass-baseline")!.marks).toBe(6);
    const s = lessonDeliveryStatus(ledger, "shadow", { now: () => clock });
    expect(s).toMatchObject({ rounds: 2, marks: 7, harm: 1, help: 3, unknown: 1 });
  });

  it("missing outcome tables read UNKNOWN, never harm or help", () => {
    const bare = new StateStore(":memory:");
    const l = new LessonLedger(bare, () => clock);
    l.recordRound(
      {
        round_id: 1,
        pr: 1,
        round_no: 1,
        mode: "shadow",
        state: "selected",
        finds: 1,
        answered: 1,
        timeouts: 0,
        refused: 0,
        prefetch_ms: 5,
        retired_list: 1,
        suppressed: 0,
        as_of: null,
        note: null,
      },
      selections(),
    );
    bare.recordRoundFindings({ pr: 1, round_id: 1, round_no: 1, head_sha: "h" }, [
      finding("f1", "pass-baseline", "scope", "docs/a.md"),
    ] as never);
    markRound(l, bare, 1, 1);
    const r = shadowReport(l, { days: 7, mode: "shadow", now: () => clock });
    expect(r.outcomes_available).toBe(false);
    expect(r.findings).toMatchObject({ total: 1, unknown: 1, harm: 0 });
    expect(renderShadowReport(r)).toContain("outcomes: UNAVAILABLE");
    bare.close();
  });

  it("the status headline and its clause in `qcr status`", () => {
    seed();
    markRound(ledger, store, 100, 1);
    const s = lessonDeliveryStatus(ledger, "shadow", { now: () => clock });
    expect(s).toMatchObject({
      delivery: "shadow",
      delivering: false,
      lessons_off: false,
      window_days: 7,
      rounds: 1,
      timeouts: 0,
      marks: 6,
      harm: 1,
      help: 3,
      unknown: 0,
    });
    expect(lessonDeliveryPhrase(s)).toBe(
      "; lessons shadow 7d: 1 rounds, 6 would-demote (harm 1, help 3, unknown 0)",
    );
    // `on` delivers — unless there is nothing to select from.
    const on = lessonDeliveryStatus(ledger, "on", { now: () => clock });
    expect(on.delivering).toBe(true);
    expect(lessonDeliveryPhrase(on)).toContain("; lessons on 7d: 1 rounds");
    expect(
      lessonDeliveryStatus(ledger, "on", { now: () => clock, selecting: false }).delivering,
    ).toBe(false);
    // …and not while the operator's kill switch is off.
    ledger.apply({ action: "off" }, "test");
    const killed = lessonDeliveryStatus(ledger, "on", { now: () => clock });
    expect(killed).toMatchObject({ delivering: false, lessons_off: true });
    ledger.apply({ action: "on" }, "test");
    expect(lessonDeliveryStatus(ledger, "on", { now: () => clock }).delivering).toBe(true);
    expect(lessonDeliveryPhrase({ ...s, delivery: "on" })).toContain(
      "on (nothing delivered — memory is off)",
    );
    expect(lessonDeliveryPhrase({ ...s, lessons_off: true, suppressed: 2 })).toBe(
      "; LESSONS OFF (operator kill switch), 2 suppressed",
    );
    expect(lessonDeliveryPhrase({ ...s, delivery: "off" })).toBe("; lessons delivery off");
    expect(lessonDeliveryPhrase(null)).toMatch(/UNKNOWN/);
    expect(lessonDeliveryPhrase(undefined)).toBe("");
    const line = memoryStatusLine({ ...pendingMemoryStatus(clock), lessons: s }, clock);
    expect(line).toContain("lessons shadow 7d: 1 rounds");
    expect(memoryStatusLine({ ...pendingMemoryStatus(clock), lessons: null }, clock)).toContain(
      "lessons UNKNOWN",
    );
  });
});

// ---- the TUI's feedback tab: the same headline, honest-unknown -----------------------

describe("the [7] feedback tab's LESSONS line", () => {
  const S: LessonDeliveryStatus = {
    delivery: "shadow",
    delivering: false,
    lessons_off: false,
    suppressed: 0,
    window_days: 7,
    rounds: 12,
    timeouts: 1,
    unreadable: 0,
    marks: 4,
    harm: 1,
    help: 2,
    unknown: 1,
    as_of: "2026-10-07T10:00:00.000Z",
  };
  const snap = (memory: unknown) =>
    ({ written_at: "x", dry_run: false, prs: [], ...(memory === undefined ? {} : { memory }) }) as never;
  const text = (h: { title: string; lines: string[] }) =>
    stripAnsi([h.title, ...h.lines].join("\n"));

  it("paints the headline; never a zero for what it cannot read", () => {
    expect(text(lessonsHeadline(snap({ ...pendingMemoryStatus(), lessons: S })))).toBe(
      "LESSONS (shadow, 7d)\nlessons shadow 7d: 12 rounds, 1 prefetch timeouts, 4 would-demote (harm 1, help 2, unknown 1)",
    );
    const unknowns = [
      text(lessonsHeadline(undefined)),
      text(lessonsHeadline(snap(undefined))),
      text(lessonsHeadline(snap(pendingMemoryStatus()))),
      text(lessonsHeadline(snap({ ...pendingMemoryStatus(), lessons: null }))),
    ];
    expect(unknowns[0]).toContain("not read yet");
    expect(unknowns[1]).toContain("reports no memory block");
    expect(unknowns[2]).toContain("predates S9a");
    expect(unknowns[3]).toContain("lessons UNKNOWN");
    for (const u of unknowns) {
      expect(u).toContain("LESSONS (—)");
      expect(u).not.toMatch(/\b0 would-demote|harm 0/);
    }
    expect(text(lessonsHeadline(snap({ ...pendingMemoryStatus(), lessons: { ...S, lessons_off: true } })))).toContain(
      "LESSONS OFF (operator kill switch)",
    );
    expect(text(lessonsHeadline(snap({ ...pendingMemoryStatus(), lessons: { ...S, delivery: "off" } })))).toContain(
      "lessons delivery off",
    );
  });

  it("under `on` the title says whether anything is delivered — never `shadow`, which runs the ledger", () => {
    const on = text(
      lessonsHeadline(snap({ ...pendingMemoryStatus(), lessons: { ...S, delivery: "on", delivering: true } })),
    );
    expect(on.split("\n")[0]).toBe("LESSONS (on, 7d)");
    // `on` with no selector (memory off): nothing selected, nothing delivered.
    const idle = text(
      lessonsHeadline(snap({ ...pendingMemoryStatus(), lessons: { ...S, delivery: "on", delivering: false } })),
    );
    expect(idle.split("\n")[0]).toBe("LESSONS (on — nothing delivered, 7d)");
    expect(idle).toContain("lessons on (nothing delivered — memory is off)");
    expect(idle).not.toContain("shadow");
    expect(text(lessonsHeadline(snap({ ...pendingMemoryStatus(), lessons: S }))).split("\n")[0]).toBe(
      "LESSONS (shadow, 7d)",
    );
  });

  it("the installed tab paints it from the app's snapshot", async () => {
    const { installLearningTabs } = await import("../src/tui/learning.js");
    const { TUI_DEFAULTS } = await import("../src/config.js");
    const view: Record<string, unknown> = {};
    const app = {
      cfg: TUI_DEFAULTS,
      hooks: { tabs: {} as Record<string, unknown> },
      view,
      notice: () => {},
      repaint: () => {},
    };
    installLearningTabs(app as never, {
      memory: { read: async () => [], apply: async () => ({ ok: true }) } as never,
      digestFetcher: { list: async () => [], read: async () => "" },
      readTickets: () => [],
      changes: {
        register: undefined,
        refresh: async () => undefined,
        revert: async () => ({ ok: false, message: "no" }),
      } as never,
    });
    const tab = app.hooks.tabs["feedback"] as {
      screen: (a: unknown, cols: number, rows: number) => { lines: string[] };
    };
    const paint = () => stripAnsi(tab.screen(app, 200, 70).lines.join("\n"));
    expect(paint()).toContain("LESSONS (—)");
    view["snapshot"] = snap({ ...pendingMemoryStatus(), lessons: S });
    expect(paint()).toContain("4 would-demote (harm 1, help 2, unknown 1)");
  });
});

// ---- the findings record tells the shadow ledger -------------------------------------

describe("enforceFindingsRecord → onRecorded", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qcr-findings-hook-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("is told once the rows landed; a throwing hook never loses the record", async () => {
    const store = new StateStore(":memory:");
    writeFileSync(
      join(dir, "pr-5-round-2.json"),
      JSON.stringify({
        pr: 5,
        round_no: 2,
        findings: [{ key: "f1", lens: "pass-baseline", disposition: "posted" }],
      }),
    );
    const told: unknown[] = [];
    await enforceFindingsRecord(
      {
        store,
        findingsDir: dir,
        inject: async () => {},
        onRecorded: (t) => told.push({ ...t, rows: store.findingsForRound(5, 2).length }),
      },
      { pr: 5, roundNo: 2, roundId: 3, headSha: "h", planned: [] },
    );
    expect(told).toEqual([{ pr: 5, roundNo: 2, roundId: 3, rows: 1 }]);
    const res = await enforceFindingsRecord(
      {
        store,
        findingsDir: dir,
        inject: async () => {},
        onRecorded: () => {
          throw new Error("boom");
        },
      },
      { pr: 5, roundNo: 2, roundId: 3, headSha: "h", planned: [] },
    );
    expect(res).toBe("recorded");
    store.close();
  });
});

// ---- the engine adapter and the client's find ----------------------------------------

describe("/search/find — the client and the engine adapter", () => {
  it("the body is the query, the area(s) and the limit — no session, no threshold, no LLM knob", () => {
    expect(
      buildFindBody("q", { targetUri: `${ROOT}/experiences`, limit: 20, timeoutMs: 5 }),
    ).toEqual({
      query: "q",
      target_uri: `${ROOT}/experiences`,
      limit: 20,
    });
    expect(buildFindBody("q", { targetUri: [`${ROOT}/a`, `${ROOT}/b`] })).toEqual({
      query: "q",
      target_uri: [`${ROOT}/a`, `${ROOT}/b`],
    });
  });

  it("reads the memories bucket (abstract, else overview) and the adapter scopes to the area", async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    let status = 200;
    const fetchFn: HttpFetch = async (url, init) => {
      seen.push({ url, body: JSON.parse(init.body ?? "{}") });
      const body =
        status === 200
          ? {
              status: "ok",
              result: {
                memories: [
                  { uri: `${EXP}/a.md`, score: 0.7, abstract: lessonText("look-for") },
                  { uri: `${EXP}/b.md`, score: 0.4, abstract: "", overview: "ov" },
                  { uri: "", score: 1, abstract: "x" },
                ],
                resources: [{ uri: "viking://resources/r", score: 0.9, abstract: "r" }],
              },
            }
          : { status: "error", error: { code: "UNAVAILABLE", message: "down" } };
      return { ok: status === 200, status, text: async () => JSON.stringify(body) };
    };
    const client = new OpenVikingClient({
      baseUrl: "http://127.0.0.1:1933",
      apiKey: "k".repeat(16),
      fetchFn,
    });
    const engine = openVikingLessonEngine(client, { retiredUris: async () => [`${EXP}/z.md`] });
    expect(engine.root()).toBe(ROOT);
    const res = await engine.find("experiences", "the query", { limit: 20, timeoutMs: 2000 });
    expect(seen[0]).toEqual({
      url: "http://127.0.0.1:1933/api/v1/search/find",
      body: { query: "the query", target_uri: `${ROOT}/experiences`, limit: 20 },
    });
    expect(res).toEqual({
      ok: true,
      hits: [
        { uri: `${EXP}/a.md`, score: 0.7, text: lessonText("look-for") },
        { uri: `${EXP}/b.md`, score: 0.4, text: "ov" },
      ],
    });
    status = 503;
    expect(await engine.find("finding-cases", "q", { limit: 40, timeoutMs: 2000 })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("UNAVAILABLE"),
    });
    expect(await engine.retiredUris()).toEqual([`${EXP}/z.md`]);
  });
});
