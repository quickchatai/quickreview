// There is no park state (`awaiting_human`): a PR is never handed to a human,
// so no state, panel, key binding, legend entry, board filter or metric may
// represent one. A writerless state is not harmless — its readers render an
// always-empty panel, key registrations eat keystrokes over an empty
// selection, and a metric that is structurally zero reads as a measurement.
//
// These tests are the fence. The load-bearing one is the FIRST: every member of
// `PrLifecycleState` must be REACHABLE from `INITIAL_STATE` by a walk over the
// real transition function. That is the general form of "a state that cannot
// exist should not be representable", so re-adding a writerless state fails
// here rather than on a screen.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { INITIAL_STATE, transition, type SmEvent } from "../src/statemachine.js";
import type { PrLifecycleState } from "../src/state.js";
import { parseTuiAction } from "../src/tui/actions.js";
import { MUTED } from "../src/tui/design.js";
import type { MetricsWindow } from "../src/metrics.js";
import { RETIRED_STATES, STATE_GLYPHS } from "../src/tui/model.js";
import { FG, legendLine, stateColor, verdictChip, verdictColor } from "../src/tui/theme.js";
import { CompanionSidebar } from "../src/tui/sidebar.js";
import type { DockerRunner } from "../src/tui/companion.js";
import type { Tab } from "../src/tui/app.js";
import { stripAnsi } from "../src/tui/paint.js";
import { learningRig, type Rig } from "./helpers/tui-rig.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

/** The union's members read out of the SOURCE, not restated here — otherwise
 * adding a writerless member back would pass every test below by simply not
 * being in the list. */
function unionMembers(): string[] {
  const src = readFileSync(resolve(process.cwd(), "src/state.ts"), "utf8");
  const decl = /export type PrLifecycleState =([^;]*);/.exec(src)?.[1];
  if (decl === undefined)
    throw new Error("PrLifecycleState declaration not found — the fence cannot read the union");
  return [...decl.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
}

const ALL_STATES = unionMembers() as PrLifecycleState[];

/** Every event shape the daemon can construct (statemachine.ts `SmEvent`). */
const ALL_EVENTS: SmEvent[] = [
  { type: "track" },
  { type: "trigger", source: "label" },
  { type: "stale_detected" },
  { type: "dispatched" },
  { type: "verdict", verdict: "APPROVE" },
  { type: "verdict", verdict: "REQUEST_CHANGES" },
  { type: "verdict", verdict: "NEEDS_HUMAN" },
  { type: "round_overdue", standing: "APPROVE" },
  { type: "round_overdue", standing: "REQUEST_CHANGES" },
  { type: "round_overdue", standing: null },
  { type: "author_reply" },
  { type: "synchronize" },
  { type: "human_requested" },
  { type: "closed" },
  { type: "reopened" },
];

/**
 * THE WALK. A BFS from `INITIAL_STATE` over whatever step function it is
 * given — parameterized so the island test below can drive THIS code rather
 * than a copy of it. An island test with its own inlined BFS would stay green
 * if this function were weakened to the "does any arrow point at S" form; it
 * would guard a hand-written walk, not the fence.
 *
 * Reachability, not "is any arrow pointing at it". The weaker question passes
 * for a pair of writerless states that only produce each other: `limbo_a ⇄
 * limbo_b` both have an incoming arrow, and no PR can ever be in either.
 *
 * Identity results do not count as *discovery* — they are the `to === from`
 * case that adds nothing to the frontier. An unreachable state that answers
 * events with itself (as `awaiting_human` did for `track`, `author_reply` and
 * `synchronize`) would look produced if self-arrows counted.
 */
function reachableFrom(step: (from: string, ev: SmEvent) => string): Set<string> {
  const seen = new Set<string>([INITIAL_STATE]);
  const frontier: string[] = [INITIAL_STATE];
  while (frontier.length > 0) {
    const from = frontier.pop()!;
    for (const ev of ALL_EVENTS) {
      const to = step(from, ev);
      if (!seen.has(to)) {
        seen.add(to);
        frontier.push(to);
      }
    }
  }
  return seen;
}

/** The states a real PR can end up in, walked over the REAL transition
 * function. `INITIAL_STATE` is imported, so this cannot drift from the daemon. */
function producibleStates(): Set<string> {
  return reachableFrom((from, ev) => transition(from as PrLifecycleState, ev));
}

describe("the lifecycle union has no unreachable member", () => {
  // THE fence: a state in the union with no writer anywhere in src/ is still
  // rendered by every surface below. The union is read from the source and
  // the producible set is DERIVED by driving the real transition function over
  // the whole event × state matrix, so a member added without a writer fails
  // here rather than on a screen.
  it("every PrLifecycleState is REACHABLE from the initial state", () => {
    const producible = producibleStates();
    for (const state of ALL_STATES) expect([state, producible.has(state)]).toEqual([state, true]);
  });

  // The fence walks a graph, so it has to be shown to REJECT an unreachable
  // one — otherwise "everything is reachable" could just mean the walk is
  // wrong. Two states that only produce EACH OTHER have incoming arrows and
  // are still unreachable; the weaker "does anything point at it" question
  // passes them.
  //
  // This drives `reachableFrom` — the same function `producibleStates()` uses.
  // Weakening the walk turns this test red, which is the whole point: a copy
  // of the algorithm asserting things about itself proves nothing about the
  // fence.
  it("rejects a mutually-producing pair that no PR can reach", () => {
    const island = (from: string, ev: SmEvent): string => {
      if (from === "limbo_a") return ev.type === "track" ? "limbo_b" : "limbo_a";
      if (from === "limbo_b") return ev.type === "track" ? "limbo_a" : "limbo_b";
      return from; // the real states never leave home in this toy machine
    };
    const seen = reachableFrom(island);
    expect(seen.has("limbo_a")).toBe(false);
    expect(seen.has("limbo_b")).toBe(false);
    // …and the walk did do its job on the reachable side, so an empty result
    // cannot be what made the two assertions above pass.
    expect(seen.has(INITIAL_STATE)).toBe(true);
  });

  it("reads a non-empty union, so the fence cannot pass by finding nothing", () => {
    expect(ALL_STATES.sort()).toEqual([
      "awaiting_author",
      "closed",
      "queued",
      "reviewing",
      "tracked",
    ]);
  });
});

// The claim this file can honestly make is about LIVE state surfaces. It is
// deliberately not "no surface anywhere mentions the string": the metrics tab's
// TIME IN STATE card is derived from the `pr_transition` event log, which holds
// real transitions into the park on a live install, and those are history.
// Erasing them would be falsifying the record. The rule for that one surface is
// the next describe: history must READ as history.
describe("no LIVE state surface renders a state the state machine cannot produce", () => {
  const producible = producibleStates();

  it("the board's glyph table names only producible states", () => {
    for (const state of Object.keys(STATE_GLYPHS))
      expect([state, producible.has(state)]).toEqual([state, true]);
  });

  it("the board's colour table answers for every producible state and nothing retired", () => {
    for (const state of ALL_STATES) expect(stateColor(state)).not.toBe(stateColor("no-such-state"));
    // The magenta is the NEEDS_HUMAN *verdict* colour only — a verdict
    // spelling older rounds still carry — never a state's.
    expect(stateColor("awaiting_human")).toBe(stateColor("no-such-state"));
  });

  // The one survivor of the park's vocabulary, and the scenario it is for:
  // `NEEDS_HUMAN` is still a legal verdict SPELLING (older recorded rounds
  // carry it, `normalizeVerdict` folds `ESCALATE` into it, and the optional
  // escalation feature keeps the word live). The magenta is its colour and
  // nothing else's — which is why the FG key is named `needs_human`, not
  // `awaiting_human`.
  it("the NEEDS_HUMAN verdict still chips and colours — the verdict survived, the state did not", () => {
    expect(stripAnsi(verdictChip("NEEDS_HUMAN"))).toBe("⚑H");
    expect(stripAnsi(verdictChip("ESCALATE"))).toBe("⚑H");
    expect(verdictChip("NEEDS_HUMAN")).toContain(FG.needs_human);
    expect(verdictColor("NEEDS_HUMAN")).toBe(FG.needs_human);
    expect(verdictColor("ESCALATE")).toBe(FG.needs_human);
    // Distinct from every other verdict, and from the "unknown verdict" default.
    for (const other of ["APPROVE", "REQUEST_CHANGES", "COMMENT", null]) {
      expect([String(other), verdictColor(other)]).not.toEqual([String(other), FG.needs_human]);
    }
  });

  it("the board legend advertises no ⚑ needs-you row", () => {
    const legend = stripAnsi(legendLine());
    expect(legend).not.toContain("needs-you");
    expect(legend).not.toContain("⚑");
    expect(legend).toContain("author");
  });

  it("the companion's board_filter refuses the retired state and accepts the live ones", () => {
    const filter = (state: string): boolean =>
      parseTuiAction(JSON.stringify({ verb: "board_filter", params: { state } })).ok;
    for (const state of Object.keys(STATE_GLYPHS))
      expect([state, filter(state)]).toEqual([state, true]);
    expect(filter("awaiting_human")).toBe(false);
  });

  it("no live surface module in this list mentions the retired state", () => {
    for (const file of [
      "src/metrics.ts",
      "src/slack/messages.ts",
      "src/tui/theme.ts",
      "src/tui/metricstab.ts",
      "src/tui/memtab.ts",
      "src/tui/actions.ts",
    ]) {
      const src = readFileSync(resolve(process.cwd(), file), "utf8");
      expect([file, src.includes("awaiting_human")]).toEqual([file, false]);
    }
    // Hand-listed on purpose, and therefore NOT a claim about every module.
    // Two live files legitimately carry the string and are absent above:
    // `src/tui/digesttab.ts` (a tombstone comment saying what the panel was)
    // and `src/reconcile.ts` (the same, for the deleted migration). Prose that
    // says a thing is GONE is not a surface that renders it — but a title
    // claiming "no module anywhere" would have been false, which is how a
    // green test starts meaning less than it says.
  });

  it("`model.ts` carries the name exactly once, inside the RETIRED_STATES table", () => {
    // `model.ts` is exempt from the sweep above only because it declares the
    // registry the metrics card reads. Exempting a file is cheap; exempting it
    // for a SECOND reason is how this rots — so the exemption is bounded to
    // one occurrence, inside the registry literal.
    const src = readFileSync(resolve(process.cwd(), "src/tui/model.ts"), "utf8");
    const mentions = src.match(/awaiting_human/g) ?? [];
    expect(mentions).toHaveLength(1);
    expect(src).toMatch(/RETIRED_STATES[\s\S]{0,200}awaiting_human/);
    expect(Object.keys(RETIRED_STATES)).toEqual(["awaiting_human"]);
  });
});

describe("historical dwell is kept, and reads as history", () => {
  it("a retired state is not a lifecycle state and has no board glyph", () => {
    for (const retired of Object.keys(RETIRED_STATES)) {
      expect([retired, (ALL_STATES as string[]).includes(retired)]).toEqual([retired, false]);
      expect([retired, retired in STATE_GLYPHS]).toEqual([retired, false]);
      expect([retired, producibleStates().has(retired)]).toEqual([retired, false]);
    }
  });

  // Built through the REAL aggregation, from the same shape of intervals the
  // `pr_transition` log yields, so the test cannot pass on a hand-made window
  // the daemon would never produce.
  const historicalWindow = async (): Promise<MetricsWindow> => {
    const { computeWindow } = await import("../src/metrics.js");
    return computeWindow({
      rounds: [],
      events: [],
      comments: [],
      threads: [],
      intervals: [
        { pr: 101, state: "awaiting_human", start: "2026-08-14T11:45:00.000Z", seconds: 900 },
        { pr: 102, state: "awaiting_author", start: "2026-08-14T10:00:00.000Z", seconds: 26_000 },
      ],
      resolvedPrs: new Map(),
      since: null,
      nowIso: "2026-08-14T12:01:00.000Z",
    });
  };

  it("the daemon still COMPUTES the historical bucket — the data is not deleted with the state", async () => {
    const bucket = (await historicalWindow()).time_in_state.find(
      (r) => r.state === "awaiting_human",
    );
    expect(bucket?.total_s).toBe(900);
  });

  it("the metrics TIME IN STATE card labels a retired bucket with its retirement, and mutes it", async () => {
    const { metricsCards } = await import("../src/tui/metricstab.js");
    const card = metricsCards(await historicalWindow(), [], 24).find(
      (c) => c.title === "TIME IN STATE",
    )!;
    const rows = card.body(60);
    const plain = rows.map(stripAnsi).join("\n");
    // Marked, and the mark is a PREFIX so the ~16-cell label column cannot
    // truncate it away — a marker that vanishes at real widths is not one.
    expect(plain).toContain("† awaiting_human");
    // The date rides the value column, where there is room for it.
    expect(plain).toContain("retired 2026-08-19");
    // The live bucket beside it is NOT marked — otherwise the marker is noise.
    expect(plain).toContain("awaiting_author");
    expect(plain).not.toContain("† awaiting_author");
    // …and it is painted MUTED rather than in a state hue: ordinary text
    // would read exactly like a current state.
    const retiredRow = rows.find((l) => stripAnsi(l).includes("awaiting_human"))!;
    expect(retiredRow).toContain(MUTED);
    expect(retiredRow).not.toContain(FG.needs_human);
    // The card explains the glyph on its own subtitle — the mark is useless
    // if the reader has to guess what it means.
    expect(card.subtitle).toContain("† = retired state, history only");
    // And the mark survives the TRUNCATING path, where a suffix mark would be
    // cut off. 45 is chosen deliberately: below ~40 `hbar`'s `avail < 3` fallback fires and
    // returns `fit(label + " " + value)` with no label column at all, so a
    // narrower pin would not exercise the truncation it claims to.
    const narrow = card.body(45).map(stripAnsi);
    const narrowRow = narrow.find((l) => l.includes("†"))!;
    expect(narrowRow).toContain("awaiting_h"); // …the retired row, still named
    expect(narrowRow).toContain("…"); // proof the label column really truncated
    expect(narrowRow).toContain("retired 2026-08-19");
  });
});

// The container runs the BUILD, not the sources above, so probe the compiled
// artifact. `dist/` is not cleaned between builds, so a module deleted from src can linger there — which is exactly the
// case worth catching.
describe("the compiled artifact agrees with the source", () => {
  const distPath = (rel: string): string => resolve(process.cwd(), "dist", rel);

  it(
    "the built glyph table and legend carry no retired state",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const model = (await import(distPath("src/tui/model.js"))) as {
        STATE_GLYPHS: Record<string, string>;
      };
      const theme = (await import(distPath("src/tui/theme.js"))) as { legendLine: () => string };
      const producible = producibleStates();
      for (const state of Object.keys(model.STATE_GLYPHS))
        expect([state, producible.has(state)]).toEqual([state, true]);
      expect(stripAnsi(theme.legendLine())).not.toContain("needs-you");
    },
  );

  it(
    "the built digest view renders no awaiting panel and no zones",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const dt = (await import(distPath("src/tui/digesttab.js"))) as {
        renderDigestTab: (
          st: unknown,
          dryRun: boolean,
          today: string,
          cols: number,
          rows: number,
        ) => { lines: string[]; zones: unknown[] };
      };
      const frame = dt.renderDigestTab(
        { files: [], back: 0, scroll: 0, loaded: true },
        false,
        "2026-08-31",
        120,
        24,
      );
      expect(stripAnsi(frame.lines.join("\n"))).not.toContain("AWAITING YOU");
      expect(frame.zones).toEqual([]);
    },
  );

  it(
    "the built installDigestHooks twin is gone, not merely unused",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const dt = (await import(distPath("src/tui/digesttab.js"))) as Record<string, unknown>;
      expect(dt["installDigestHooks"]).toBeUndefined();
    },
  );
});

describe("the always-zero metric is gone from the computation and from every surface", () => {
  it("the window header carries no awaiting_you field and the text output prints no count of nothing", async () => {
    const { computeMetrics, renderMetrics } = await import("../src/metrics.js");
    const { StateStore } = await import("../src/state.js");
    const store = new StateStore(":memory:");
    const payload = computeMetrics(store, { now: () => new Date("2026-08-14T12:00:00Z") });
    for (const w of [payload.windows.d7, payload.windows.d30, payload.windows.all]) {
      expect(Object.keys(w.header)).not.toContain("awaiting_you");
    }
    expect(renderMetrics(payload).toLowerCase()).not.toContain("awaiting you");
    store.close();
  });
});

// ---- six keystrokes the memory tab does not claim ---------------------------

function harness(
  tab: Tab = "memory",
): Rig & { sent: string[][]; type: (t: string) => void; running: Promise<void> } {
  const rig = learningRig({ cols: 140, rows: 40 });
  const sent: string[][] = [];
  const docker: DockerRunner = async (argv) => {
    if (argv.includes("send-keys")) sent.push(argv);
    return { ok: true, stdout: "", stderr: "", code: 0 };
  };
  rig.app.sidebar = new CompanionSidebar(
    { container_name: "qcr-companion", session: "companion" },
    docker,
    { available: () => true },
  );
  rig.app.tab = tab;
  return { ...rig, sent, type: rig.streams.type, running: rig.app.run() };
}

const settle = (): Promise<unknown> => new Promise((r) => setTimeout(r, 10));
const literals = (sent: string[][]): string[] =>
  sent.filter((a) => a.includes("-l")).map((a) => a[a.length - 1]!);

describe("the six keys the awaiting panel registered now reach the companion column", () => {
  it("the memory tab no longer claims a m w g o M", async () => {
    const h = harness();
    await settle();
    const keys = h.app.registeredKeys();
    for (const k of ["a", "m", "w", "g", "o", "M"]) expect([k, keys.has(k)]).toEqual([k, false]);
    // These two are this tab's own.
    expect(keys.has("W")).toBe(true);
    expect(keys.has("n")).toBe(true);
    h.app.quit();
    await h.running;
  });

  for (const key of ["a", "m", "w", "g", "o", "M"]) {
    it(`\`${key}\` on the memory tab is typed into pi instead of being swallowed`, async () => {
      const h = harness();
      await settle();
      expect(h.app.tab).toBe("memory");
      h.type(key);
      await settle();
      expect(h.app.sidebar!.focused).toBe(true);
      expect(literals(h.sent)).toContain(key);
      // …and the board behind it was not operated on from a tab you cannot see.
      expect(h.app.tab).toBe("memory");
      expect(h.app.view.piFocus).toBeFalsy();
      expect(h.app.view.inputBox).toBeUndefined();
      h.app.sidebar!.blur();
      h.app.quit();
      await h.running;
    });
  }

  it("`a` toggles archived on the FEEDBACK tab, and only there — the inbox lives on its own surface now", async () => {
    const h = harness("feedback");
    await settle();
    h.type("a");
    await settle();
    // Claimed by the tab: it never reaches the column.
    expect(h.app.sidebar!.focused).toBe(false);
    expect(literals(h.sent)).not.toContain("a");
    expect(h.learning.feedback.showArchived).toBe(true);
    h.app.quit();
    await h.running;
  });

  // The arrow keys scroll the digest. Both halves need pinning: without this
  // test, gutting `down`/`up` in the digest key handler leaves the whole
  // suite green.
  it("j/k AND the arrows scroll the digest, and up clamps at the top", async () => {
    const h = harness("digest");
    await settle();
    expect(h.learning.store.digest.scroll).toBe(0);
    h.type("k"); // already at the top
    await settle();
    expect(h.learning.store.digest.scroll).toBe(0);
    h.type("j");
    h.type("j");
    await settle();
    expect(h.learning.store.digest.scroll).toBe(2);
    h.type(Buffer.from("\x1b[B").toString("utf8")); // ↓ scrolls now; it used to move a selection
    await settle();
    expect(h.learning.store.digest.scroll).toBe(3);
    h.type(Buffer.from("\x1b[A").toString("utf8")); // ↑
    await settle();
    expect(h.learning.store.digest.scroll).toBe(2);
    h.app.quit();
    await h.running;
  });

  // A live alert owns ⏎ from wherever you are. Every learning surface must
  // agree about that, or following an alert works or not depending on the view.
  for (const tab of ["memory", "digest", "tickets", "feedback"] as const) {
    it(`a live alert still owns ⏎ on the ${tab} tab`, async () => {
      const h = harness(tab);
      await settle();
      let opened = 0;
      (h.app as unknown as { openCompanion: () => void }).openCompanion = () => {
        opened += 1;
      };
      h.app.view.alertFocus = true;
      h.type("\r");
      await settle();
      expect(opened).toBe(1);
      h.app.quit();
      await h.running;
    });
  }

  it("⏎ on the memory tab does not focus the BOARD's pi pane", async () => {
    // ⏎ is not printable, so it can never reach the companion; the point is
    // only that it stops acting on a surface the operator is not looking at.
    const h = harness();
    await settle();
    h.app.view.snapshot = {
      written_at: "",
      dry_run: false,
      prs: [
        { number: 5265, state: "awaiting_author", title: "t", head_sha: "x", stale_recheck: 0 },
      ],
      running_rounds: 0,
      total_spend_usd: 0,
      heartbeat: "",
    } as never;
    h.app.selectPr(5265);
    h.type("\r");
    await settle();
    expect(h.app.tab).toBe("memory");
    expect(h.app.view.piFocus).toBeFalsy();
    h.app.quit();
    await h.running;
  });
});
