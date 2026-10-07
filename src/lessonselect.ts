// The ROUND'S LESSON SELECTION (S9a): one bounded prefetch through
// OpenViking per round, the deterministic selection over what it returned
// (src/memory/selection.ts), and the record in the shadow ledger
// (src/lessonledger.ts) — behind `[memory] delivery`.
//
// WHEN. Under `shadow` (the shipped value) dispatch.ts calls `start(order,
// files)` once per round, AFTER the round was handed to its session (the
// order, its task files, the memory seed and the prompt are all done).
// `start` is synchronous, never throws and is never awaited: NOTHING the
// session sees depends on the selection, so it has no reason to run any
// earlier — and starting it after the seed means its finds never queue ahead
// of the round's own memory call on the server's one-thread embedder. The
// round prompt, the task files and the built agents are byte-identical to
// `off` (pinned by tests/lesson-byte-identity.test.ts). Under `on` see
// DELIVERY below.
//
// THE PREFETCH. ONE phase per round under a hard budget (`[memory]
// delivery_budget_ms`, at most 2 s): the planned finds (one per plan row,
// identical queries asked once, plus the main session's cases — the cases
// find first) go out at most `PREFETCH_MAX_IN_FLIGHT` at a time, across every
// round the selector runs, and the store's retired list beside them. Every
// find embeds its query on that one-thread embedder, which the round seed,
// the sessions' 500 ms recall and the /ready probe also wait on: the shadow
// prefetch may hold at most two places in its queue, never twenty. Each find
// is given what is LEFT of the round's budget as its HTTP deadline, so none
// outlives the phase. At the deadline whatever arrived is used and every find
// still out — or never sent, still waiting for a slot — is a TIMEOUT: it
// delivers nothing, is recorded on its row and the round, and is logged. A
// find that answers after the deadline is ignored, never merged in late.
//
// THE SWITCHES, read on every round:
//   `[memory] delivery = "off"`  — `start` returns at once: no engine call,
//                                  no ledger row.
//   the operator's `lessons-off` — no engine call; the round is recorded
//                                  `lessons_off` so the ledger shows it.
//   `suppress-lesson <uri>`      — that URI is never selected.
// The kill switch lives in state.db (commands/operator/ only).
//
// DELIVERY (`[memory] delivery = "on"`, S9b). The round's prompt, its
// task files and its lessons files are rendered FROM the selection, so under
// `on` dispatch does not `start` it after the handoff: it AWAITS `select`
// beside the memory seed, under the same ≤ 2 s budget, which is inside the
// seed's own deadline. The budget's clock starts at once, but no lesson find
// is SENT before the round's own context search was (`after`: dispatch opens
// it when the assembler reports the search issued, or when the seed settles,
// whichever is first) — so the round's search is never queued behind a lesson
// find on the one-thread embedder, and the round still waits for the slower
// of the two, never their sum. The selection is the SAME run `shadow` records
// (the same ledger rows, the same marks); `on` only also hands its texts
// back. `select` is total: a throw, a closed ledger or a dead engine is
// `null`, and the round renders as if nothing were selected. A round whose
// handoff fails is `discard`ed: its ledger rows go with it, and a selection
// still in flight records nothing. `repoFacts` is the recheck's and the
// ping-pong wake's: one bounded find, the repo-fact lessons for the touched
// paths, rendered — "" unless `on`.
import type { MemoryDelivery } from "./config.js";
import type { LessonLedger, LessonRoundState } from "./lessonledger.js";
import { markRound } from "./lessonshadow.js";
import { lessonFromCandidate, renderRepoFactsSection } from "./memory/delivery.js";
import { EXPERIENCES_AREA } from "./memory/layout.js";
import {
  FIND_LIMITS,
  planFinds,
  repoFactsQuery,
  selectRepoFacts,
  selectRound,
  type FindOutcome,
  type LessonEngine,
  type PlannedFind,
  type RoleSelection,
  type SelectionRow,
} from "./memory/selection.js";
import type { RoundOrder } from "./types.js";

/** A timer the prefetch races against — injected so a test drives it with a
 * fake clock. `cancel` must make `promise` never settle (or be ignored). */
export type PrefetchTimer = (ms: number) => { promise: Promise<void>; cancel(): void };

export const realTimer: PrefetchTimer = (ms) => {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => {
    handle = setTimeout(resolve, ms);
    (handle as unknown as { unref?: () => void }).unref?.();
  });
  return {
    promise,
    cancel: () => {
      if (handle !== undefined) clearTimeout(handle);
    },
  };
};

/** At most this many lesson finds in flight at once — per selector, so
 * across every round it runs. Each find embeds its query on the server's
 * one-thread local embedder (the queue the round's memory seed, the
 * sessions' 500 ms recall and the /ready probe also wait in). */
export const PREFETCH_MAX_IN_FLIGHT = 2;

/** A counting semaphore over the finds in flight. A waiter is handed a slot
 * in FIFO order as one frees; nothing here ever times out — the prefetch
 * releases every slot it took by its own deadline. */
export class FindSlots {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  readonly max: number;

  constructor(max: number) {
    this.max = Math.max(1, Math.floor(max));
  }

  acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiting.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiting.shift();
    if (next) next();
  }

  /** Finds holding a slot right now. */
  inFlight(): number {
    return this.active;
  }
}

export interface PrefetchResult {
  /** Every planned find's outcome AT THE DEADLINE — `timeout` for one still
   * out or never sent. Late answers never change it. */
  outcomes: Map<string, FindOutcome>;
  /** The retired list, or null when it had not arrived by the deadline. */
  retired: string[] | null;
  /** Finds actually sent to the engine before the deadline. */
  sent: number;
  ms: number;
}

/**
 * The bounded prefetch. The finds go out in plan order, at most
 * `slots.max` at a time, beside the retired list; the phase resolves when
 * all have answered or at `budgetMs`, whichever is first. Each find's own
 * deadline is what is left of the budget. A find still waiting for a slot at
 * the deadline is never sent. Total: a throwing or misbehaving engine is an
 * `unreadable` outcome.
 */
export async function prefetchLessons(
  engine: LessonEngine,
  finds: readonly PlannedFind[],
  opts: {
    budgetMs: number;
    timer?: PrefetchTimer;
    clock?: () => number;
    /** Shared slots (the selector's, across rounds); a fresh
     * `PREFETCH_MAX_IN_FLIGHT` set when absent. */
    slots?: FindSlots;
    /** No find is sent before this settles (either way) — the round's own
     * context search under `on` (S9b). The budget's clock is NOT held: a
     * find still waiting here at the deadline is never sent. */
    after?: PromiseLike<unknown>;
  },
): Promise<PrefetchResult> {
  const clock = opts.clock ?? Date.now;
  const timer = opts.timer ?? realTimer;
  const slots = opts.slots ?? new FindSlots(PREFETCH_MAX_IN_FLIGHT);
  const started = clock();
  const arrived = new Map<string, FindOutcome>();
  const holder: { retired: string[] | null } = { retired: null };
  // The phase's end — the deadline, or everything answered — as ONE promise
  // every in-flight find races, so no slot is held past it.
  let expired = false;
  let expire!: () => void;
  const ended = new Promise<void>((resolve) => (expire = resolve));
  const end = (): void => {
    if (expired) return;
    expired = true;
    expire();
  };
  let sent = 0;
  const gate =
    opts.after === undefined
      ? null
      : Promise.resolve(opts.after).then(
          () => undefined,
          () => undefined,
        );
  const ask = async (f: PlannedFind): Promise<void> => {
    if (gate) {
      // Held behind the round's own search, holding no slot; the deadline
      // still runs, and a find it passes here is never sent.
      await Promise.race([gate, ended]);
      if (expired) return;
    }
    await slots.acquire();
    try {
      if (expired) return; // never sent: the deadline passed while it waited
      sent += 1;
      const left = Math.max(1, opts.budgetMs - Math.max(0, clock() - started));
      const call = Promise.resolve()
        .then(() => engine.find(f.area, f.query, { limit: f.limit, timeoutMs: left }))
        .then(
          (a) => {
            if (expired) return;
            arrived.set(
              f.key,
              a && a.ok === true
                ? { status: "ok", hits: Array.isArray(a.hits) ? a.hits : [] }
                : {
                    status: "unreadable",
                    reason: ((): string => {
                      const r = (a as { reason?: unknown } | null | undefined)?.reason;
                      return typeof r === "string" && r !== "" ? r : "no answer";
                    })(),
                  },
            );
          },
          (err: unknown) => {
            if (!expired) arrived.set(f.key, { status: "unreadable", reason: `error: ${String(err)}` });
          },
        );
      await Promise.race([call, ended]);
    } finally {
      slots.release();
    }
  };
  // In plan order: a slot that frees goes to the next planned find.
  const tasks = finds.map((f) => ask(f));
  const retired = Promise.resolve()
    .then(() => engine.retiredUris())
    .then(
      (uris) => {
        if (expired) return;
        holder.retired = Array.isArray(uris)
          ? uris.filter((u): u is string => typeof u === "string")
          : [];
      },
      () => {
        /* no list: the entries' own `#retired`/`#moved` headers still exclude */
      },
    );
  const deadline = timer(opts.budgetMs);
  void deadline.promise.then(end);
  try {
    await Promise.race([Promise.all([...tasks, retired]), ended]);
  } finally {
    deadline.cancel();
    end();
  }
  // The snapshot: what had arrived by now, and nothing that lands later.
  const outcomes = new Map<string, FindOutcome>();
  for (const f of finds) outcomes.set(f.key, arrived.get(f.key) ?? { status: "timeout" });
  return {
    outcomes,
    retired: holder.retired === null ? null : [...holder.retired],
    sent,
    ms: Math.max(0, clock() - started),
  };
}

/** What `select` hands dispatch under `on`: the round's records (as the
 * ledger stored them) and the selected entries' texts, by URI. */
export interface RoundSelectionResult {
  selections: RoleSelection[];
  texts: Map<string, string>;
}

/** A recheck's or an author reply's ask for repo facts (S9b). */
export interface RepoFactsQuery {
  pr: number;
  title: string;
  /** The paths it touches: the recheck delta's significant files, or the
   * replied thread's file. */
  paths: readonly string[];
  head_sha?: string | null;
  purpose: "recheck" | "pingpong";
}

/** The hook dispatch.ts calls — the whole of what dispatch knows. */
export interface RoundLessonHook {
  /** Start this round's selection. Synchronous, never throws, never awaited:
   * nothing in the round waits for it. The `off`/`shadow` path. */
  start(order: RoundOrder, files: ReadonlyArray<{ filename: string }>): void;
  /** True when the round's lessons are DELIVERED (`[memory] delivery =
   * "on"`, read per round): dispatch then awaits `select` beside the memory
   * seed instead of calling `start`. Absent or false ⇒ the S9a path. */
  delivering?(): boolean;
  /** The round's selection, awaited — bounded by the prefetch budget, total
   * (null on any failure: the round renders as if nothing were selected).
   * `after`: no find is sent before it settles (the round's own context
   * search); the budget runs from the call regardless. */
  select?(
    order: RoundOrder,
    files: ReadonlyArray<{ filename: string }>,
    opts?: { after?: PromiseLike<unknown> },
  ): Promise<RoundSelectionResult | null>;
  /** The round was discarded before its handoff completed (dispatch's
   * provisional round): its ledger rows go, and a selection still in flight
   * for it records nothing — the report never counts a round that never ran.
   * Must not throw. */
  discard?(roundId: number): void;
  /** The repo-fact lessons for the paths a recheck or an author reply
   * touches, rendered as a section to append — "" unless delivering, and on
   * any failure. Bounded by the prefetch budget; never rejects. */
  repoFacts?(q: RepoFactsQuery): Promise<string>;
}

export interface RoundLessonSelectorDeps {
  ledger: LessonLedger;
  /** `[memory] delivery`, read per round. */
  mode: () => MemoryDelivery;
  /** The engine, late-bound (wire.ts builds it once secrets are readable);
   * null ⇒ the round is recorded `unreadable` ("not built yet"). */
  engine: () => LessonEngine | null;
  /** `[memory] delivery_budget_ms` (≤ 2000). */
  budgetMs: number;
  /** Finds in flight at once across every round — `PREFETCH_MAX_IN_FLIGHT`
   * when absent. */
  maxInFlight?: number;
  /** A replay's temporal hold-out: only lessons created before this day. */
  asOf?: string | null;
  /** The reviewed repo's `owner/name` — the repo facts' evidence links. */
  repo?: string;
  timer?: PrefetchTimer;
  clock?: () => number;
  log?: (msg: string, extra?: unknown) => void;
}

/** A round's state from what its finds did. */
function roundState(finds: number, answered: number, timeouts: number): LessonRoundState {
  if (finds === 0 || answered === finds) return "selected";
  if (answered === 0 && timeouts === finds) return "timeout";
  if (answered === 0 && timeouts === 0) return "unreadable";
  return "partial";
}

export class RoundLessonSelector implements RoundLessonHook {
  private readonly pending = new Set<Promise<void>>();
  private readonly log: (msg: string, extra?: unknown) => void;
  /** One set of slots for every round this selector runs: two rounds
   * dispatched together still hold at most `maxInFlight` embedder places. */
  private readonly slots: FindSlots;
  /** Rounds dispatch discarded: a selection for one still in flight records
   * nothing. Round ids are never reused (AUTOINCREMENT), so this only grows
   * by a failed handoff. */
  private readonly discarded = new Set<number>();

  constructor(private readonly deps: RoundLessonSelectorDeps) {
    this.log = deps.log ?? (() => {});
    this.slots = new FindSlots(deps.maxInFlight ?? PREFETCH_MAX_IN_FLIGHT);
  }

  start(order: RoundOrder, files: ReadonlyArray<{ filename: string }>): void {
    try {
      const mode = this.deps.mode();
      if (mode === "off") return;
      const prFiles = files.map((f) => f.filename).filter((f) => typeof f === "string" && f !== "");
      const run: Promise<void> = this.run(order, prFiles, mode).then(
        () => undefined,
        (err: unknown) => {
          this.log(`lessons: #${order.pr} round ${order.round_no} selection failed (ignored)`, err);
        },
      );
      this.pending.add(run);
      void run.finally(() => this.pending.delete(run));
    } catch (err) {
      this.log(`lessons: #${order.pr} selection not started (ignored)`, err);
    }
  }

  /** `[memory] delivery = "on"`, read now (S9b). */
  delivering(): boolean {
    try {
      return this.deps.mode() === "on";
    } catch {
      return false;
    }
  }

  /**
   * The round's selection, AWAITED by dispatch under `on` (S9b): the same
   * run `start` makes — the same ledger rows — plus the selected entries'
   * texts. Bounded by the prefetch budget; total — any failure is `null`.
   */
  async select(
    order: RoundOrder,
    files: ReadonlyArray<{ filename: string }>,
    opts: { after?: PromiseLike<unknown> } = {},
  ): Promise<RoundSelectionResult | null> {
    try {
      const mode = this.deps.mode();
      if (mode === "off") return null;
      const prFiles = files.map((f) => f.filename).filter((f) => typeof f === "string" && f !== "");
      const texts = new Map<string, string>();
      const run = this.run(order, prFiles, mode, {
        texts,
        awaited: true,
        ...(opts.after !== undefined ? { after: opts.after } : {}),
      });
      const tracked: Promise<void> = run.then(
        () => undefined,
        () => undefined,
      );
      this.pending.add(tracked);
      void tracked.finally(() => this.pending.delete(tracked));
      const selections = await run;
      return { selections, texts };
    } catch (err) {
      this.log(
        `lessons: #${order.pr} round ${order.round_no} selection failed — the round is delivered no lessons`,
        err,
      );
      return null;
    }
  }

  /**
   * The repo-fact lessons for the paths a recheck's delta or an author's
   * reply touches (S9b), rendered as a section to append to that prompt.
   * "" unless `on` with the kill switch on, and on any failure, a timeout or
   * nothing to say — so the prompt is byte-identical. One find, under the
   * round prefetch's budget and slots.
   */
  async repoFacts(q: RepoFactsQuery): Promise<string> {
    try {
      if (this.deps.mode() !== "on") return "";
      const paths = [...new Set(q.paths.filter((p) => typeof p === "string" && p !== ""))].sort();
      if (paths.length === 0) return "";
      const { ledger } = this.deps;
      if (ledger.lessonsOff()) return "";
      const engine = this.deps.engine();
      if (!engine) return "";
      const query = repoFactsQuery({ title: q.title, paths });
      const find: PlannedFind = {
        key: `facts\u0000${query}`,
        area: EXPERIENCES_AREA,
        query,
        limit: FIND_LIMITS.facts,
      };
      const pre = await prefetchLessons(engine, [find], {
        budgetMs: this.deps.budgetMs,
        slots: this.slots,
        ...(this.deps.timer ? { timer: this.deps.timer } : {}),
        ...(this.deps.clock ? { clock: this.deps.clock } : {}),
      });
      const o = pre.outcomes.get(find.key) ?? { status: "timeout" as const };
      let section = "";
      let uris: string[] = [];
      let cuts = 0;
      if (o.status === "ok") {
        const { selected, cuts: cut } = selectRepoFacts(o.hits, {
          root: engine.root(),
          files: paths,
          retired: new Set(pre.retired ?? []),
          suppressed: new Set(ledger.suppressedUris()),
          asOf: this.deps.asOf ?? null,
        });
        uris = selected.map((c) => c.uri);
        cuts = cut.length;
        section = renderRepoFactsSection(selected.map(lessonFromCandidate), {
          paths,
          repo: this.deps.repo ?? "",
          head_sha: q.head_sha ?? null,
        });
      } else if (o.status === "timeout") {
        this.log(
          `lessons: #${q.pr} ${q.purpose} repo facts — the find passed its deadline (${this.deps.budgetMs} ms); nothing delivered, nothing delayed past it`,
        );
      }
      ledger.store.logEvent("lesson_repo_facts", q.pr, {
        purpose: q.purpose,
        status: o.status,
        paths: paths.length,
        lessons: uris,
        cuts,
        prefetch_ms: pre.ms,
      });
      return section;
    } catch (err) {
      this.log(`lessons: #${q.pr} ${q.purpose} repo facts failed (ignored)`, err);
      return "";
    }
  }

  /**
   * Dispatch discarded this round before its handoff completed: drop its
   * ledger rows and let a selection still in flight for it record nothing,
   * so the shadow report and the status headline never count a round that
   * never ran. Total — a ledger that cannot be written is logged.
   */
  discard(roundId: number): void {
    try {
      this.discarded.add(roundId);
      const dropped = this.deps.ledger.discardRound(roundId);
      if (dropped.rounds + dropped.selections + dropped.marks > 0)
        this.log(
          `lessons: round ${roundId} discarded before its handoff — its selection record dropped (${dropped.selections} role(s))`,
        );
    } catch (err) {
      this.log(`lessons: round ${roundId} discarded, but its selection record could not be dropped (ignored)`, err);
    }
  }

  /** Resolves when every selection started so far has settled — for tests
   * and an orderly shutdown; nothing in a round awaits it. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  /** One round's selection, end to end. Exposed for tests; `start` and
   * `select` are the production entries. `texts`, when given, is filled with
   * every selected entry's text (S9b's delivery); `after` holds every find
   * until it settles; `awaited` — the round waits for this run (`select`,
   * under `on`), which only changes what the log says a timeout cost. */
  async run(
    order: RoundOrder,
    prFiles: readonly string[],
    mode: MemoryDelivery,
    opts: { texts?: Map<string, string>; after?: PromiseLike<unknown>; awaited?: boolean } = {},
  ): Promise<RoleSelection[]> {
    const { ledger } = this.deps;
    const { texts } = opts;
    const base = {
      round_id: order.round_id,
      pr: order.pr,
      round_no: order.round_no,
      mode,
      as_of: this.deps.asOf ?? null,
    };
    if (ledger.lessonsOff()) {
      ledger.recordRound(
        {
          ...base,
          state: "lessons_off",
          finds: 0,
          answered: 0,
          timeouts: 0,
          refused: 0,
          prefetch_ms: null,
          retired_list: 0,
          suppressed: ledger.suppressedUris().length,
          note: "the operator's kill switch is OFF (qcr lessons off) — no selection",
        },
        [],
      );
      ledger.store.logEvent("lesson_selection", order.pr, {
        round_id: order.round_id,
        round_no: order.round_no,
        mode,
        state: "lessons_off",
      });
      return [];
    }
    const suppressed = ledger.suppressedUris();
    const rows: SelectionRow[] = order.pass_plan.map((p, row) => ({
      row,
      lens: p.lens,
      agent: p.agent,
      ...(p.focus ? { focus: p.focus } : {}),
    }));
    // The lenses the session may add get a selection too (S9b — their
    // lessons file): one shared find, planned last.
    const addable = order.addable_lenses ?? [];
    const plan = planFinds({ title: order.title, rows, prFiles, addable });
    const engine = (() => {
      try {
        return this.deps.engine();
      } catch {
        return null;
      }
    })();
    let outcomes: Map<string, FindOutcome>;
    let retired: string[] | null = null;
    let ms: number | null = null;
    let sent = 0;
    let note: string | null = null;
    let root = "";
    if (!engine) {
      const why = "the memory engine is not built yet (daemon starting, or memory switched off)";
      note = why;
      outcomes = new Map<string, FindOutcome>(
        plan.finds.map((f) => [f.key, { status: "unreadable", reason: why }]),
      );
    } else {
      root = (() => {
        try {
          return engine.root();
        } catch {
          return "";
        }
      })();
      const pre = await prefetchLessons(engine, plan.finds, {
        budgetMs: this.deps.budgetMs,
        slots: this.slots,
        ...(this.deps.timer ? { timer: this.deps.timer } : {}),
        ...(this.deps.clock ? { clock: this.deps.clock } : {}),
        ...(opts.after !== undefined ? { after: opts.after } : {}),
      });
      outcomes = pre.outcomes;
      retired = pre.retired;
      ms = pre.ms;
      sent = pre.sent;
    }
    const selections = selectRound({
      pr: order.pr,
      title: order.title,
      rows,
      prFiles,
      root,
      plan,
      outcomes,
      retired: new Set(retired ?? []),
      suppressed: new Set(suppressed),
      asOf: this.deps.asOf ?? null,
      addable,
      ...(texts ? { texts } : {}),
    });
    const statuses = [...outcomes.values()].map((o) => o.status);
    const answered = statuses.filter((s) => s === "ok").length;
    const timeouts = statuses.filter((s) => s === "timeout").length;
    const refused = statuses.filter((s) => s === "unreadable").length;
    const state = roundState(plan.finds.length, answered, timeouts);
    if (this.discarded.has(order.round_id)) {
      // Dispatch discarded the round while its finds were out (a failed
      // handoff): nothing ran, so nothing is recorded.
      this.log(
        `lessons: #${order.pr} round ${order.round_no} was discarded before its handoff — its selection is not recorded`,
      );
      return selections;
    }
    ledger.recordRound(
      {
        ...base,
        state,
        finds: plan.finds.length,
        answered,
        timeouts,
        refused,
        prefetch_ms: ms,
        retired_list: retired === null ? 0 : 1,
        suppressed: suppressed.length,
        note,
      },
      selections,
    );
    const lessons = new Set(selections.flatMap((s) => s.lessons.map((l) => l.uri))).size;
    const cases = selections.reduce((n, s) => n + s.cases.length, 0);
    ledger.store.logEvent("lesson_selection", order.pr, {
      round_id: order.round_id,
      round_no: order.round_no,
      mode,
      state,
      finds: plan.finds.length,
      sent,
      answered,
      timeouts,
      refused,
      prefetch_ms: ms,
      lessons,
      cases,
      cuts: selections.reduce((n, s) => n + s.cuts.length, 0),
    });
    if (timeouts > 0) {
      const unsent = Math.max(0, plan.finds.length - sent);
      this.log(
        `lessons: #${order.pr} round ${order.round_no} prefetch deadline (${this.deps.budgetMs} ms) passed with ${timeouts} of ${plan.finds.length} find(s) out` +
          (unsent > 0
            ? ` (${unsent} never sent — at most ${this.slots.max} in flight${opts.after !== undefined ? ", none before the round's own memory search" : ""})`
            : "") +
          // Under `on` the round WAITED for this run (`select`, beside the
          // seed) — up to the budget, never past it; under `shadow` it ran
          // after the handoff and delayed nothing.
          (opts.awaited
            ? ` — the round waited up to the budget (${this.deps.budgetMs} ms, beside its memory seed) and got no lessons from those finds`
            : " — those deliver nothing; the round was not delayed"),
      );
    }
    else if (refused > 0)
      this.log(
        `lessons: #${order.pr} round ${order.round_no} memory refused ${refused} of ${plan.finds.length} find(s)${note ? ` (${note})` : ""}`,
      );
    // The findings record normally lands long after this; if it is already
    // there (a replayed record), mark the round now.
    try {
      if (ledger.store.findingsForRound(order.pr, order.round_no).length > 0)
        markRound(ledger, ledger.store, order.pr, order.round_no);
    } catch (err) {
      this.log(
        `lessons: #${order.pr} round ${order.round_no} shadow marking failed (ignored)`,
        err,
      );
    }
    return selections;
  }
}
