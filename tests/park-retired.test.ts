// the park is retired end to end, and stays retired.
//
// The park (`awaiting_human`) was killed as BEHAVIOUR: nothing has
// transitioned into it since 2026-08-19. Its readers outlived it by two weeks —
// a permanently empty `AWAITING YOU (0)` panel on ~45% of tab [2], six key
// registrations that silently ate keystrokes over its empty selection, a legend
// entry, a board-filter value, and a metric presented to the operator as a
// measurement that was structurally always zero.
//
// These tests are the fence. The load-bearing one is the FIRST: every member of
// `PrLifecycleState` must be PRODUCIBLE by the state machine. That is the
// general form of "a state that cannot exist should not be representable", so
// re-adding a writerless state fails here rather than being noticed two weeks
// later on a screen.
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TUI_DEFAULTS } from "../src/config.js";
import { transition, type SmEvent } from "../src/statemachine.js";
import type { PrLifecycleState } from "../src/state.js";
import { App } from "../src/tui/app.js";
import { registeredKeys } from "../src/tui/cmdbar.js";
import { parseTuiAction } from "../src/tui/actions.js";
import { STATE_GLYPHS } from "../src/tui/model.js";
import { legendLine, stateColor } from "../src/tui/theme.js";
import { CompanionSidebar } from "../src/tui/sidebar.js";
import type { DockerRunner } from "../src/tui/companion.js";
import { installMemoryLearningHooks, type MemTabState } from "../src/tui/memtab.js";
import type { DigestFetcher } from "../src/tui/digesttab.js";
import type { MemoryEntry, MemoryOp, MemoryStore } from "../src/memory/store.js";
import { stripAnsi } from "../src/tui/paint.js";

/** The union's members read out of the SOURCE, not restated here — otherwise
 * adding a writerless member back would pass every test below by simply not
 * being in the list. */
function unionMembers(): string[] {
  const src = readFileSync(resolve(process.cwd(), "src/state.ts"), "utf8");
  const decl = /export type PrLifecycleState =([^;]*);/.exec(src)?.[1];
  if (decl === undefined) throw new Error("PrLifecycleState declaration not found — the fence cannot read the union");
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
 * The states the machine can actually land a PR on, DERIVED not asserted.
 *
 * Identity results are excluded deliberately: most events return `current`
 * unchanged, so counting those would make every state self-producing and the
 * fence would pass for a state nothing can ever enter — which is exactly the
 * bug (`awaiting_human` answered `track`, `author_reply` and `synchronize`
 * with itself for the entire two weeks it was unreachable). A state is
 * producible only if some event MOVES a PR into it, or it is the state a newly
 * tracked PR is created in.
 */
function producibleStates(): Set<string> {
  const out = new Set<string>(["tracked"]); // the state a newly-tracked PR is created in
  for (const from of ALL_STATES) {
    for (const ev of ALL_EVENTS) {
      const to = transition(from, ev);
      if (to !== from) out.add(to);
    }
  }
  return out;
}

describe("the lifecycle union has no unreachable member", () => {
  // THE fence, and the general form of what removed: `awaiting_human`
  // sat in the union for two weeks with no writer anywhere in src/, and every
  // surface below dutifully rendered it. The union is read from the source and
  // the producible set is DERIVED by driving the real transition function over
  // the whole event × state matrix, so a member added back without a writer
  // fails here rather than being noticed on a screen a fortnight later.
  it("every PrLifecycleState is produced by some transition", () => {
    const producible = producibleStates();
    for (const state of ALL_STATES) expect([state, producible.has(state)]).toEqual([state, true]);
  });

  it("reads a non-empty union, so the fence cannot pass by finding nothing", () => {
    expect(ALL_STATES.sort()).toEqual(["awaiting_author", "closed", "queued", "reviewing", "tracked"]);
  });
});

describe("no surface renders a state the state machine cannot produce", () => {
  const producible = producibleStates();

  it("the board's glyph table names only producible states", () => {
    for (const state of Object.keys(STATE_GLYPHS)) expect([state, producible.has(state)]).toEqual([state, true]);
  });

  it("the board's colour table answers for every producible state and nothing retired", () => {
    for (const state of ALL_STATES) expect(stateColor(state)).not.toBe(stateColor("no-such-state"));
    // The magenta survives, but as the NEEDS_HUMAN *verdict* colour only — a
    // verdict spelling older rounds still carry. It is no longer a state.
    expect(stateColor("awaiting_human")).toBe(stateColor("no-such-state"));
  });

  it("the board legend advertises no ⚑ needs-you row", () => {
    const legend = stripAnsi(legendLine());
    expect(legend).not.toContain("needs-you");
    expect(legend).not.toContain("⚑");
    expect(legend).toContain("author");
  });

  it("the companion's board_filter refuses the retired state and accepts the live ones", () => {
    const filter = (state: string): boolean => parseTuiAction(JSON.stringify({ verb: "board_filter", params: { state } })).ok;
    for (const state of Object.keys(STATE_GLYPHS)) expect([state, filter(state)]).toEqual([state, true]);
    expect(filter("awaiting_human")).toBe(false);
  });

  it("no live surface module mentions the retired state at all", () => {
    for (const file of [
      "src/metrics.ts",
      "src/slack/messages.ts",
      "src/tui/model.ts",
      "src/tui/theme.ts",
      "src/tui/metricstab.ts",
      "src/tui/memtab.ts",
      "src/tui/actions.ts",
    ]) {
      const src = readFileSync(resolve(process.cwd(), file), "utf8");
      expect([file, src.includes("awaiting_human")]).toEqual([file, false]);
    }
  });
});

// The container runs the BUILD, not the sources above (the standing practice
// out: probe the compiled artifact). `dist/` is not cleaned between
// builds, so a module deleted from src can linger there — which is exactly the
// case worth catching.
describe("the compiled artifact agrees with the source", () => {
  const distPath = (rel: string): string => resolve(process.cwd(), "dist", rel);

  it("the built glyph table and legend carry no retired state", async () => {
    const model = (await import(distPath("src/tui/model.js"))) as { STATE_GLYPHS: Record<string, string> };
    const theme = (await import(distPath("src/tui/theme.js"))) as { legendLine: () => string };
    const producible = producibleStates();
    for (const state of Object.keys(model.STATE_GLYPHS)) expect([state, producible.has(state)]).toEqual([state, true]);
    expect(stripAnsi(theme.legendLine())).not.toContain("needs-you");
  });

  it("the built digest view renders no awaiting panel and no zones", async () => {
    const dt = (await import(distPath("src/tui/digesttab.js"))) as {
      renderDigestTab: (st: unknown, dryRun: boolean, today: string, cols: number, rows: number) => { lines: string[]; zones: unknown[] };
    };
    const frame = dt.renderDigestTab({ files: [], back: 0, scroll: 0, loaded: true }, false, "2026-08-31", 120, 24);
    expect(stripAnsi(frame.lines.join("\n"))).not.toContain("AWAITING YOU");
    expect(frame.zones).toEqual([]);
  });

  it("the built installDigestHooks twin is gone, not merely unused", async () => {
    const dt = (await import(distPath("src/tui/digesttab.js"))) as Record<string, unknown>;
    expect(dt["installDigestHooks"]).toBeUndefined();
  });
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

// ---- the six freed keystrokes ----------------------------------------------

class SilentMemory {
  async read(): Promise<MemoryEntry[]> {
    return [];
  }
  async search(): Promise<MemoryEntry[]> {
    return [];
  }
  async apply(op: MemoryOp): Promise<{ ok: boolean; message: string }> {
    return { ok: true, message: `ok: ${op.op}` };
  }
}

const fakeDigest: DigestFetcher = {
  list: async () => [],
  read: async () => undefined,
};

function harness(): { app: App; mem: MemTabState; sent: string[][]; type: (t: string) => void; running: Promise<void> } {
  const out = new EventEmitter() as unknown as NodeJS.WriteStream;
  (out as unknown as { columns: number }).columns = 140;
  (out as unknown as { rows: number }).rows = 40;
  out.write = (() => true) as never;
  const input = new EventEmitter() as unknown as NodeJS.ReadStream;
  (input as unknown as { isTTY: boolean }).isTTY = false;
  input.resume = (() => input) as never;
  input.pause = (() => input) as never;
  const app = new App(TUI_DEFAULTS, async () => ({ ok: true, stdout: "", stderr: "", code: 0 }), out, input);
  const sent: string[][] = [];
  const docker: DockerRunner = async (argv) => {
    if (argv.includes("send-keys")) sent.push(argv);
    return { ok: true, stdout: "", stderr: "", code: 0 };
  };
  app.sidebar = new CompanionSidebar({ container_name: "qcr-companion", session: "companion" }, docker, { available: () => true });
  const mem = installMemoryLearningHooks(app, {
    memory: new SilentMemory() as unknown as MemoryStore,
    digestFetcher: fakeDigest,
    fetchProposals: async () => ({ proposals: [], improvements: [] }),
    readTickets: () => [],
  });
  app.tab = "digest";
  const type = (t: string): void => void (input as unknown as EventEmitter).emit("data", Buffer.from(t));
  return { app, mem, sent, type, running: app.run() };
}

const settle = (): Promise<unknown> => new Promise((r) => setTimeout(r, 10));
const literals = (sent: string[][]): string[] => sent.filter((a) => a.includes("-l")).map((a) => a[a.length - 1]!);

describe("the six keys the awaiting panel registered now reach the companion column", () => {
  it("registeredKeys('digest') no longer claims a m w g o M", () => {
    const keys = registeredKeys("digest");
    for (const k of ["a", "m", "w", "g", "o", "M"]) expect([k, keys.has(k)]).toEqual([k, false]);
    // The two that are genuinely this tab's still are.
    expect(keys.has("F")).toBe(true);
    expect(keys.has("W")).toBe(true);
  });

  for (const key of ["a", "m", "w", "g", "o", "M"]) {
    it(`\`${key}\` on tab [2] is typed into pi instead of being swallowed`, async () => {
      const h = harness();
      await settle();
      expect(h.app.tab).toBe("digest");
      h.type(key);
      await settle();
      expect(h.app.sidebar!.focused).toBe(true);
      expect(literals(h.sent)).toContain(key);
      // …and the board behind it was not operated on from a tab you cannot see.
      expect(h.app.tab).toBe("digest");
      expect(h.app.view.detailFull).toBeFalsy();
      h.app.sidebar!.blur();
      h.app.quit();
      await h.running;
    });
  }

  // Tab [2] has two views and each has its own handler. The digest view let
  // these keys fall through; the MEMORY view swallowed all six on purpose, "so
  // nothing falls to the board". With the board verbs guarded app-side that
  // reason is gone, and swallowing is now just eating a keystroke.
  for (const key of ["a", "m", "w", "g", "o", "M"]) {
    it(`\`${key}\` reaches the companion from the MEMORY view too`, async () => {
      const h = harness();
      await settle();
      h.type("v"); // digest view → memory view
      await settle();
      h.type(key);
      await settle();
      expect(h.app.sidebar!.focused).toBe(true);
      expect(literals(h.sent)).toContain(key);
      h.app.sidebar!.blur();
      h.app.quit();
      await h.running;
    });
  }

  it("`a` still toggles archived inside a #feedback timeline, and only there", async () => {
    const h = harness();
    await settle();
    h.type("v");
    await settle();
    h.mem.memFilter = "#feedback";
    h.type("a");
    await settle();
    // Claimed by the tab: it never reaches the column.
    expect(h.app.sidebar!.focused).toBe(false);
    expect(literals(h.sent)).not.toContain("a");
    h.app.quit();
    await h.running;
  });

  it("⏎ on tab [2] does not focus the BOARD's pi pane", async () => {
    // ⏎ is not printable, so it can never reach the companion; the point is
    // only that it stops acting on a surface the operator is not looking at.
    const h = harness();
    await settle();
    h.app.view.snapshot = {
      written_at: "",
      dry_run: false,
      prs: [{ number: 5265, state: "awaiting_author", title: "t", head_sha: "x", stale_recheck: 0 }],
      running_rounds: 0,
      total_spend_usd: 0,
      heartbeat: "",
    } as never;
    h.app.selectPr(5265);
    h.type("\r");
    await settle();
    expect(h.app.tab).toBe("digest");
    expect(h.app.view.piFocus).toBeFalsy();
    h.app.quit();
    await h.running;
  });
});
