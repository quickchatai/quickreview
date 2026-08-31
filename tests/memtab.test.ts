// Memory & learning tab (FT-0129): render, verbs, proposal verdicts. Fake
// stores/ssh throughout; the App is driven through its public hooks exactly as
// the real key router does. Entry fixtures are spelled in the archived file's
// shape and parsed by the read-only reader — the shortest honest way to write
// entries with real tags, days and pin flags.
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TUI_DEFAULTS } from "../src/config.js";
import { App } from "../src/tui/app.js";
import { barHitKey, registeredKeys } from "../src/tui/cmdbar.js";
import type { DigestFetcher } from "../src/tui/digesttab.js";
import {
  feedbackInbox,
  feedbackPresentation,
  installMemoryLearningHooks,
  pinnedBudget,
  renderMemoryView,
  type MemTabState,
} from "../src/tui/memtab.js";
import { WayfinderIssueSink } from "../src/tui/issuesink.js";
import { legacyBlockHash as blockHash, parseLegacyMemory as parseMemory } from "../src/memory/legacy-file.js";
import type { MemoryEntry, MemoryOp, MemoryStore } from "../src/memory/store.js";
import type { MemoryHealth } from "../src/tui/memory.js";
import { renderDigestTab } from "../src/tui/digesttab.js";
import { Frame, displayWidth, stripAnsi } from "../src/tui/paint.js";
import type { RemoteResult } from "../src/tui/remote.js";

/** FT-0177: tab hooks hand back a Frame so the app can compose the companion
 * column beside it. These tests read the tab alone, so they render it. */
const renderScreen = (screen: string | Frame | undefined): string =>
  screen === undefined ? "" : typeof screen === "string" ? screen : screen.render();

const SAMPLE = `<!-- 2026-08-19 18:13:54 [01a01ab3] -->
#false-positive #eod-learning lesson about merge bases.

#refuted lesson about External Apps.

<!-- 2026-08-20 09:01:42 [01a01b03] -->
#bug #operations [[stale-recheck]] stale recheck flag lingers on #5180.
`;

function fakeStreams() {
  const out = new EventEmitter() as unknown as NodeJS.WriteStream;
  let buf = "";
  (out as unknown as { columns: number }).columns = 110;
  (out as unknown as { rows: number }).rows = 30;
  out.write = ((s: string) => ((buf += s), true)) as never;
  const input = new EventEmitter() as unknown as NodeJS.ReadStream;
  (input as unknown as { isTTY: boolean }).isTTY = false;
  input.resume = (() => input) as never;
  input.pause = (() => input) as never;
  return { out, input, written: () => buf };
}

class FakeMemory implements MemoryStore {
  applied: MemoryOp[] = [];
  constructor(private md: string = SAMPLE) {}
  read(): Promise<ReturnType<typeof parseMemory>> {
    return Promise.resolve(parseMemory(this.md));
  }
  search(): Promise<MemoryEntry[]> {
    return Promise.resolve([]);
  }
  apply(op: MemoryOp): Promise<{ ok: boolean; message: string }> {
    this.applied.push(op);
    return Promise.resolve({ ok: true, message: `ok: ${op.op}` });
  }
}

const fakeDigest: DigestFetcher = {
  list: () => Promise.resolve(["2026-08-19.md"]),
  read: () => Promise.resolve("# Review sandbox — 2026-08-19\n## Reviews\n- #5308 APPROVE"),
};

const okSsh = (_h: string, _argv: string[]): Promise<RemoteResult> => Promise.resolve({ ok: true, stdout: "", stderr: "", code: 0 });

function makeApp(): { app: App; written: () => string } {
  const { out, input, written } = fakeStreams();
  const app = new App(TUI_DEFAULTS, okSsh, out, input);
  app.tab = "digest";
  return { app, written };
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 5));
}

function install(app: App, mem: FakeMemory, extra: Parameters<typeof installMemoryLearningHooks>[1] = {}): MemTabState {
  return installMemoryLearningHooks(app, {
    memory: mem,
    digestFetcher: fakeDigest,
    fetchProposals: () =>
      Promise.resolve({
        proposals: [{ slug: "baseline-mergebase-2026-08-20", head: ["## Rationale", "3 refuted blockers"] }],
        improvements: [{ kind: "pr" as const, number: 12, title: "docs fix", state: "open" }],
      }),
    ...extra,
  });
}

describe("body-row width contract (review P2: rows were cols+1 wide)", () => {
  for (const cols of [100, 111]) {
    it(`digest view + memory view render every line at EXACTLY ${cols} cells`, () => {
      const rows = 28;
      const digest = renderDigestTab({ files: ["2026-08-19.md"], back: 0, content: "# d", scroll: 0, awaitingSelected: 0, loaded: true }, [], true, "2026-08-19", cols, rows);
      for (const line of digest.lines) expect(displayWidth(line)).toBe(cols);
      const st: MemTabState = {
        view: "memory",
        digest: { files: [], back: 0, scroll: 0, awaitingSelected: 0, loaded: true },
        entries: parseMemory(SAMPLE),
        memLoaded: true,
        focus: "timeline",
        sel: 0,
        propSel: 0,
        scroll: 0,
        proposals: [{ slug: "tighten-nits", head: ["# tighten"] }],
        improvements: [],
        propLoaded: true,
      ticketsLoaded: true,
        filedTotal: 0,
      };
      const memory = renderMemoryView(st, false, undefined, cols, rows);
      for (const line of memory.lines) expect(displayWidth(line)).toBe(cols);
    });
  }

  it("both views paint the body down to rows-4 now the companion strip is retired (FT-0177)", () => {
    // top bar (0) + body 1..rows-4 + command bar rows-3..rows-2 + border rows-1.
    const rows = 40;
    const content = Array.from({ length: 60 }, (_, i) => `digest line ${i}`).join("\n");
    const digest = renderDigestTab(
      { files: ["2026-08-19.md"], back: 0, content, scroll: 0, awaitingSelected: 0, loaded: true },
      [],
      true,
      "2026-08-19",
      120,
      rows,
    );
    // bodyRows = rows - 4 = 36 lines painted from frame row 1, so the last
    // body row carries the 36th digest line (index 35).
    expect(stripAnsi(digest.lines[rows - 4]!)).toContain("digest line 35");
    expect(stripAnsi(digest.lines[rows - 3]!)).toContain("1 board"); // the command bar

    const st: MemTabState = {
      view: "memory",
      digest: { files: [], back: 0, scroll: 0, awaitingSelected: 0, loaded: true },
      entries: parseMemory(SAMPLE),
      memLoaded: true,
      focus: "timeline",
      sel: 0,
      propSel: 0,
      scroll: 0,
      proposals: [],
      improvements: [],
      propLoaded: true,
      ticketsLoaded: true,
      filedTotal: 0,
    };
    const memory = renderMemoryView(st, false, undefined, 120, rows);
    expect(memory.lines[rows - 4]!.startsWith("│")).toBe(true); // content, not chrome
    expect(stripAnsi(memory.lines[rows - 3]!)).toContain("1 board");
  });
});

describe("feedback adjudication inbox", () => {
  const memoryEntry = (text: string, ts = "2026-08-25 08:48:09"): MemoryEntry => ({
    id: `entry-${ts}`,
    ts,
    day: ts.slice(0, 10),
    block: 0,
    text,
    tags: text.split(/\s+/).filter((token) => token.startsWith("#")).map((token) => token.slice(1)),
    links: [],
    pinned: false,
    hash: `hash-${ts}`,
  });

  const raw = memoryEntry(
    '#feedback kind=feedback pr=5372 day=2026-08-25 signal=feedback_comment human [feedback] by pmercier on PR #5372 (reply to bot comment 3000000101, comment 3000000202): "This edge case is too unlikely to matter in production." — a review comment judged wrong',
  );
  const adjudication = memoryEntry(
    "#adjudication #feedback pr=5372 episode=comment-3000000202 attribution=review-defect changed=no adjudicated=2026-08-25\nAttribution: review-defect — severity exceeded reachability\nChanged: nothing",
    "2026-08-25 12:00:00",
  );
  const needsAttention = memoryEntry(
    "#feedback-review #feedback pr=5372 episode=comment-3000000202 status=needs-attention reviewed=2026-08-25\nReason: Exact finding cannot be mapped from the archived evidence; the owner must decide whether rarity makes it non-actionable.",
    "2026-08-25 11:00:00",
  );
  const actedOn = memoryEntry(
    "#feedback-action #feedback pr=5372 episode=comment-3000000202 action=landed acted=2026-08-25\nResult: commit abc123 adds reachability evidence to the finding record.",
    "2026-08-25 13:00:00",
  );

  it("generates a concrete title, summary, raw text and cautious candidate lesson", () => {
    const card = feedbackPresentation(raw, [raw]);
    expect(card).toMatchObject({
      episode: "comment-3000000202",
      processed: false,
      title: "Narrow edge case judged non-actionable",
      raw: "This edge case is too unlikely to matter in production.",
    });
    expect(card!.summary).toContain("too rare or narrow");
    expect(card!.learning).toContain("reachability and impact separately");
  });

  it("marks only an exact episode as processed and reads the recorded outcome", () => {
    const card = feedbackPresentation(raw, [raw, adjudication]);
    expect(card).toMatchObject({ processed: true, status: "settled" });
    expect(card!.learning).toContain("review-defect — severity exceeded reachability");
    expect(card!.learning).toContain("Changed: nothing");
  });

  it("distinguishes reviewed-but-inconclusive feedback from both unprocessed and settled", () => {
    const card = feedbackPresentation(raw, [raw, needsAttention]);
    expect(card).toMatchObject({ processed: true, status: "needs-attention" });
    expect(card!.learning).toContain("the owner must decide");
  });

  it("makes #feedback an inbox by hiding its disposition records", () => {
    expect(feedbackInbox([raw, adjudication, needsAttention], "feedback")).toEqual([raw]);
    expect(feedbackInbox([raw, adjudication, needsAttention], null)).toHaveLength(3);
    expect(feedbackPresentation(adjudication, [raw, adjudication])).toBeUndefined();
    expect(feedbackPresentation(needsAttention, [raw, needsAttention])).toBeUndefined();
    expect(feedbackPresentation(actedOn, [raw, actedOn])).toBeUndefined();
  });

  it("archives acted-on feedback from the inbox without deleting its record", () => {
    expect(feedbackPresentation(raw, [raw, adjudication, actedOn])).toMatchObject({ processed: true, status: "acted-on" });
    expect(feedbackInbox([raw, adjudication, actedOn], "feedback")).toEqual([]);
    expect(feedbackInbox([raw, adjudication, actedOn], "feedback", true)).toEqual([raw]);
    expect(feedbackInbox([raw, adjudication, actedOn], null)).toHaveLength(3);
  });

  it("renders date + generated title on the left and the structured card on the right", () => {
    const st: MemTabState = {
      view: "memory",
      digest: { files: [], back: 0, scroll: 0, awaitingSelected: 0, loaded: true },
      entries: [raw],
      memLoaded: true,
      focus: "timeline",
      sel: 0,
      propSel: 0,
      scroll: 0,
      proposals: [],
      improvements: [],
      propLoaded: true,
      ticketsLoaded: true,
      filedTotal: 0,
      memFilter: "feedback",
    };
    const screen = stripAnsi(renderMemoryView(st, false, undefined, 180, 52).render());
    expect(screen).toContain("2026-08-25 ○ #5372 · Narrow edge case judged non-actionable");
    expect(screen).toContain("UNPROCESSED — needs review");
    expect(screen).toContain("TITLE");
    expect(screen).toContain("SUMMARY");
    expect(screen).toContain("RAW FEEDBACK");
    expect(screen).toContain("WHAT WE CAN LEARN");
  });

  it("renders reviewed feedback needing the owner separately from settled feedback", () => {
    const st: MemTabState = {
      view: "memory",
      digest: { files: [], back: 0, scroll: 0, awaitingSelected: 0, loaded: true },
      entries: [raw, needsAttention],
      memLoaded: true,
      focus: "timeline",
      sel: 0,
      propSel: 0,
      scroll: 0,
      proposals: [],
      improvements: [],
      propLoaded: true,
      ticketsLoaded: true,
      filedTotal: 0,
      memFilter: "feedback",
    };
    const screen = stripAnsi(renderMemoryView(st, false, undefined, 180, 52).render());
    expect(screen).toContain("2026-08-25 ! #5372 · Narrow edge case judged non-actionable");
    expect(screen).toContain("PROCESSED · NEEDS ATTENTION");
  });

  it("opens actionable feedback-effort tickets with their complete body", () => {
    const body = `# Adjudicate one real episode\n\nId: FT-0227\nStatus: open\nRole: ready-for-human\nUpdated: 2026-08-25T18:00:00Z\n\n## Question\n\nSettle the complaint against all three evidence sources.`;
    const st: MemTabState = {
      view: "memory",
      digest: { files: [], back: 0, scroll: 0, awaitingSelected: 0, loaded: true },
      entries: [raw],
      memLoaded: true,
      focus: "tickets",
      sel: 0,
      propSel: 0,
      scroll: 0,
      proposals: [],
      improvements: [],
      propLoaded: true,
      ticketsLoaded: true,
      filedTotal: 0,
      memFilter: "feedback",
      tickets: [{
        id: "FT-0227",
        title: "Adjudicate one real episode",
        status: "open",
        role: "ready-for-human",
        category: "—",
        updated: "2026-08-25T18:00:00Z",
        path: "/tracker/FT-0227.md",
        body,
      }],
    };
    const screen = stripAnsi(renderMemoryView(st, false, undefined, 180, 52).render());
    expect(screen).toContain("FEEDBACK TICKETS (1 actionable / 1 total)");
    expect(screen).toContain("FT-0227 [open] Adjudicate one real episode");
    expect(screen).toContain("Settle the complaint against all three evidence sources.");
    expect(screen).toContain("[ / ] scroll ticket");
  });
});

describe("renderMemoryView", () => {
  it("shows timeline, proposals, improvements, defects", async () => {
    const { app } = makeApp();
    const mem = new FakeMemory();
    const st = install(app, mem);
    app.hooks.digestScreen!(app, 110, 30);
    await settle();
    st.view = "memory";
    const screen = stripAnsi(renderScreen(app.hooks.digestScreen!(app, 110, 30)));
    expect(screen).toContain("memory & learning");
    expect(screen).toContain("MEMORY (3)");
    expect(screen).toContain("RUBRIC PROPOSALS (1)");
    expect(screen).toContain("baseline-mergebase-2026-08-20");
    expect(screen).toContain("PR #12 [open]");
    expect(screen).toContain("DEFECT FLAGS (1)");
  });

  it("warns when pinned entries outgrow the injection head budget", () => {
    const entries = parseMemory(`<!-- 2026-08-20 08:00:00 [aa] -->\n#pinned ${"x".repeat(2000)}\n`);
    expect(pinnedBudget(entries).over).toBe(true);
    const st: MemTabState = {
      view: "memory",
      digest: { files: [], back: 0, scroll: 0, awaitingSelected: 0, loaded: true },
      entries,
      memLoaded: true,
      focus: "timeline",
      sel: 0,
      propSel: 0,
      scroll: 0,
      proposals: [],
      improvements: [],
      propLoaded: true,
      ticketsLoaded: true,
      filedTotal: 0,
    };
    const screen = stripAnsi(renderMemoryView(st, false, undefined, 100, 24).render());
    expect(screen).toContain("⚠ pinned");
  });
});

describe("management verbs", () => {
  it("v toggles between digest and memory views", async () => {
    const { app } = makeApp();
    const st = install(app, new FakeMemory());
    app.hooks.digestScreen!(app, 110, 30);
    await settle();
    expect(st.view).toBe("digest");
    app.hooks.digestKey!(app, { kind: "char", ch: "v" });
    expect(st.view).toBe("memory");
  });

  it("a toggles acted-on records in the feedback view", async () => {
    const { app } = makeApp();
    const st = install(app, new FakeMemory());
    app.hooks.digestScreen!(app, 110, 30);
    await settle();
    st.view = "memory";
    st.memFilter = "feedback";
    expect(st.feedbackShowArchived).toBeFalsy();
    app.hooks.digestKey!(app, { kind: "attach" }); // decoded `a`
    expect(st.feedbackShowArchived).toBe(true);
    app.hooks.digestKey!(app, { kind: "attach" });
    expect(st.feedbackShowArchived).toBe(false);
  });

  it("retire needs x twice; the first only arms", async () => {
    const { app } = makeApp();
    const mem = new FakeMemory();
    const st = install(app, mem);
    app.hooks.digestScreen!(app, 110, 30);
    await settle();
    st.view = "memory";
    app.hooks.digestKey!(app, { kind: "char", ch: "x" });
    expect(mem.applied).toHaveLength(0);
    expect(st.confirmRetire).toBeDefined();
    app.hooks.digestKey!(app, { kind: "char", ch: "x" });
    await settle();
    expect(mem.applied).toHaveLength(1);
    expect(mem.applied[0]).toMatchObject({ op: "retire" });
  });

  it("any other key disarms a pending retire", async () => {
    const { app } = makeApp();
    const mem = new FakeMemory();
    const st = install(app, mem);
    app.hooks.digestScreen!(app, 110, 30);
    await settle();
    st.view = "memory";
    app.hooks.digestKey!(app, { kind: "char", ch: "x" });
    app.hooks.digestKey!(app, { kind: "down", arrow: true });
    app.hooks.digestKey!(app, { kind: "char", ch: "x" });
    expect(mem.applied).toHaveLength(0); // re-armed on the new selection instead
  });

  it("p pins the selected (unpinned) entry with the right address", async () => {
    const { app } = makeApp();
    const mem = new FakeMemory();
    const st = install(app, mem);
    app.hooks.digestScreen!(app, 110, 30);
    await settle();
    st.view = "memory";
    app.hooks.digestKey!(app, { kind: "char", ch: "p" });
    await settle();
    const entries = parseMemory(SAMPLE);
    const newest = entries.find((e) => e.id === "01a01b03")!; // timeline floats newest first
    expect(mem.applied[0]).toMatchObject({ op: "pin", id: newest.id, ts: newest.ts, block: 0, expect: blockHash(newest.text) });
  });

  it("e opens a prefilled edit prompt; submit applies the edit", async () => {
    const { app } = makeApp();
    const mem = new FakeMemory();
    const st = install(app, mem);
    app.hooks.digestScreen!(app, 110, 30);
    await settle();
    st.view = "memory";
    app.hooks.digestKey!(app, { kind: "events" });
    expect(app.view.inputBox).toBeDefined();
    expect(app.view.inputBox!.text).toContain("stale recheck flag");
    // Submit through the real input path: append text + enter.
    const send = (s: string): void => (app as unknown as { handleInput(b: Buffer): void }).handleInput(Buffer.from(s));
    send(" AMENDED");
    send("\r");
    await settle();
    expect(mem.applied[0]).toMatchObject({ op: "edit" });
    expect((mem.applied[0] as { text: string }).text).toContain("AMENDED");
  });

  it("n prompts for a new manual entry", async () => {
    const { app } = makeApp();
    const mem = new FakeMemory();
    const st = install(app, mem);
    app.hooks.digestScreen!(app, 110, 30);
    await settle();
    st.view = "memory";
    app.hooks.digestKey!(app, { kind: "char", ch: "n" });
    const send = (s: string): void => (app as unknown as { handleInput(b: Buffer): void }).handleInput(Buffer.from(s));
    send("never trust a resolved checkmark");
    send("\r");
    await settle();
    expect(mem.applied[0]).toMatchObject({ op: "add", text: "never trust a resolved checkmark" });
  });

  it("mouse wheel scrolls the open ticket body instead of selecting the next ticket", async () => {
    const { app } = makeApp();
    const mkTicket = (id: string) => ({
      id,
      title: `Ticket ${id}`,
      status: "open",
      role: "ready-for-human",
      category: "—",
      updated: "2026-08-25T18:00:00Z",
      path: `/tracker/${id}.md`,
      body: Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n"),
    });
    const st = install(app, new FakeMemory(), { readTickets: () => [mkTicket("FT-0300"), mkTicket("FT-0301")] });
    app.hooks.digestScreen!(app, 110, 30);
    await settle();
    st.view = "memory";
    st.focus = "tickets";
    st.ticketSel = 0;
    st.ticketScroll = 0;

    app.hooks.digestKey!(app, { kind: "down", wheel: true } as never);

    expect(st.ticketSel).toBe(0);
    expect(st.ticketScroll).toBeGreaterThan(0);
  });

  it("A accepts and R (with reason) rejects the selected proposal", async () => {
    const { app } = makeApp();
    const accept = vi.fn().mockResolvedValue({ ok: true, message: "accepted" });
    const reject = vi.fn().mockResolvedValue({ ok: true, message: "rejected" });
    const st = install(app, new FakeMemory(), { accept, reject });
    app.hooks.digestScreen!(app, 110, 30);
    await settle();
    st.view = "memory";
    app.hooks.digestKey!(app, { kind: "char", ch: "t" }); // focus feedback tickets
    app.hooks.digestKey!(app, { kind: "char", ch: "t" }); // focus proposals
    app.hooks.digestKey!(app, { kind: "char", ch: "A" });
    await settle();
    expect(accept).toHaveBeenCalledWith(app, "baseline-mergebase-2026-08-20");
    app.hooks.digestKey!(app, { kind: "char", ch: "R" });
    const send = (s: string): void => (app as unknown as { handleInput(b: Buffer): void }).handleInput(Buffer.from(s));
    send("not evidence-backed");
    send("\r");
    await settle();
    expect(reject).toHaveBeenCalledWith(app, "baseline-mergebase-2026-08-20", "not evidence-backed");
  });

  it("auto-files #bug entries through the wayfinder sink on memory load", async () => {
    const root = mkdtempSync(join(tmpdir(), "memtab-tracker-"));
    mkdirSync(join(root, ".ids"), { recursive: true });
    mkdirSync(join(root, "efforts/review-sandbox/tickets"), { recursive: true });
    writeFileSync(join(root, ".ids", "0100"), "x\n");
    const { app } = makeApp();
    const mem = new FakeMemory();
    install(app, mem, { sink: new WayfinderIssueSink({ root, effort: "review-sandbox", parent: "FT-0026" }, mem) });
    app.hooks.digestScreen!(app, 110, 30);
    await settle();
    const tickets = readdirSync(join(root, "efforts/review-sandbox/tickets"));
    expect(tickets).toHaveLength(1);
    expect(readFileSync(join(root, "efforts/review-sandbox/tickets", tickets[0]!), "utf8")).toContain("by qcr-tui");
    rmSync(root, { recursive: true, force: true });
  });
});

// The companion memory-edit request channel that used to be tested here is
// RETIRED (FT-0167): since FT-0153 the companion reaches OpenViking directly
// over a host-owned forward, holding both USER keys, so there is no
// `/alerts/memedit` mediation left to exercise.

describe("mouse operation (FT-0129 UX)", () => {
  it("clicking a timeline row selects it and the detail pane shows the FULL text", async () => {
    const { app } = makeApp();
    const st = install(app, new FakeMemory());
    app.hooks.digestScreen!(app, 140, 40);
    await settle();
    st.view = "memory";
    app.hooks.digestScreen!(app, 140, 40); // paint captures zones
    // Row 1 of the list = frame row 2 = terminal y 3 (header above it).
    app.hooks.digestClick!(app, 4, 4);
    const screen = stripAnsi(renderScreen(app.hooks.digestScreen!(app, 140, 40)));
    expect(st.sel).toBe(1);
    expect(screen).toContain("ENTRY 2026-08-19 18:13:54");
    // The FULL selected text is readable in the pane (wrapped, not clipped).
    expect(screen).toContain("lesson about External Apps.");
    expect(screen).toContain("[e edit]");
    expect(screen).toContain("[x retire]");
  });

  it("verb buttons act: two clicks on [x retire] retire the selected entry", async () => {
    const { app } = makeApp();
    const mem = new FakeMemory();
    const st = install(app, mem);
    app.hooks.digestScreen!(app, 140, 40);
    await settle();
    st.view = "memory";
    const screen = stripAnsi(renderScreen(app.hooks.digestScreen!(app, 140, 40)));
    const rowText = screen.split("\n")[2]!; // verbs row (terminal y 3)
    const x = rowText.indexOf("[x retire]") + 2;
    app.hooks.digestClick!(app, x, 3);
    expect(mem.applied).toHaveLength(0); // armed only
    const rowText2 = stripAnsi(renderScreen(app.hooks.digestScreen!(app, 140, 40))).split("\n")[2]!;
    expect(rowText2).toContain("[x CONFIRM retire]");
    const x2 = rowText2.indexOf("[x CONFIRM retire]") + 2;
    app.hooks.digestClick!(app, x2, 3);
    await settle();
    expect(mem.applied[0]).toMatchObject({ op: "retire" });
  });

  it("proposal [accept] button fires accept on the clicked proposal", async () => {
    const { app } = makeApp();
    const accept = vi.fn().mockResolvedValue({ ok: true, message: "accepted" });
    const st = install(app, new FakeMemory(), { accept });
    app.hooks.digestScreen!(app, 140, 40);
    await settle();
    st.view = "memory";
    const screen = stripAnsi(renderScreen(app.hooks.digestScreen!(app, 140, 40)));
    const lines = screen.split("\n");
    const y = lines.findIndex((l) => l.includes("[accept]")) + 1;
    const x = lines[y - 1]!.indexOf("[accept]") + 2;
    app.hooks.digestClick!(app, x, y);
    await settle();
    expect(accept).toHaveBeenCalledWith(app, "baseline-mergebase-2026-08-20");
  });

  it("digest view: the bar's [v view] button is clickable and toggles", async () => {
    const { app } = makeApp();
    const st = install(app, new FakeMemory());
    app.hooks.digestScreen!(app, 140, 40);
    await settle();
    // The bar renders the button on row B; its hit range maps back to `v`,
    // which pressKey routes through the tab's own key handler.
    const screen = stripAnsi(renderScreen(app.hooks.digestScreen!(app, 140, 40)));
    const rowB = screen.split("\n")[38]!; // frame row rows-2
    const x = rowB.indexOf("[v view]") + 2; // 1-based terminal x of the `v`
    expect(x).toBeGreaterThan(2);
    expect(barHitKey("digest", x, 39, 140, 40)).toBe("v");
    app.pressKey("v");
    expect(st.view).toBe("memory");
  });

  it("tags are not printed twice in the list line", async () => {
    const { app } = makeApp();
    const st = install(app, new FakeMemory());
    app.hooks.digestScreen!(app, 140, 40);
    await settle();
    st.view = "memory";
    const screen = stripAnsi(renderScreen(app.hooks.digestScreen!(app, 140, 40)));
    expect(screen).not.toMatch(/#bug #operations #bug #operations/);
  });
});

describe("the [2] tab is VISIBLY Memory & learning (rename regression)", () => {
  it("digest view header and hints carry the rename and advertise v", async () => {
    const { app } = makeApp();
    install(app, new FakeMemory());
    app.hooks.digestScreen!(app, 110, 30);
    await settle();
    const screen = stripAnsi(renderScreen(app.hooks.digestScreen!(app, 110, 30)));
    expect(screen).toContain("memory & learning · digest");
    expect(screen).toContain("[v view]");
    expect(screen).toContain("[2 memory]");
    expect(screen).not.toContain("2 digest");
  });
});

describe("quit vs late async repaints (ghost-frame regression)", () => {
  it("a load resolving after quit paints nothing onto the restored screen", async () => {
    const { app, written } = makeApp();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slowMemory: MemoryStore = {
      read: async () => {
        await gate;
        return parseMemory(SAMPLE);
      },
      search: () => Promise.resolve([]),
      apply: () => Promise.resolve({ ok: true, message: "ok" }),
    };
    install(app, slowMemory as FakeMemory);
    const running = app.run(); // installs streams, starts poller
    app.hooks.digestScreen!(app, 110, 30); // kicks the slow load
    app.quit();
    await running; // teardown done — terminal restored
    const at = written().length;
    release(); // the load resolves late and calls app.repaint()
    await settle();
    expect(written().length).toBe(at); // not one more byte on the normal screen
  });

  it("a late attach resume after quit also paints nothing", async () => {
    const { app, written } = makeApp();
    install(app, new FakeMemory());
    const running = app.run();
    app.quit();
    await running;
    const at = written().length;
    app.resume();
    app.notice("late notice");
    await settle();
    expect(written().length).toBe(at);
  });
});

// FT-0164: the tab runs on OpenViking, which can be unreachable. An empty
// timeline and an unreachable store MUST NOT look alike — an empty tab reads
// as a healthy tab with nothing in it, and the operator would act on it.
class UnhealthyMemory implements MemoryStore {
  constructor(private readonly h: MemoryHealth, private readonly entries: MemoryEntry[] = []) {}
  read(): Promise<MemoryEntry[]> {
    return Promise.resolve(this.entries);
  }
  search(): Promise<MemoryEntry[]> {
    return Promise.resolve([]);
  }
  apply(): Promise<{ ok: boolean; message: string }> {
    return Promise.resolve({ ok: false, message: "memory write failed: no answer" });
  }
  health(): MemoryHealth {
    return this.h;
  }
}

const DEAD = "cannot reach OpenViking at http://127.0.0.1:1933 (connect ECONNREFUSED) — check: systemctl --user status qcr-memory-forward";

describe("memory unreachable (FT-0164)", () => {
  it("paints an explicit failure banner with the reason, never 'none yet'", async () => {
    const { app } = makeApp();
    const st = install(app, new UnhealthyMemory({ ok: false, namespaces: [], error: DEAD }) as unknown as FakeMemory);
    app.hooks.digestScreen!(app, 110, 30);
    await settle();
    st.view = "memory";
    const screen = stripAnsi(renderScreen(app.hooks.digestScreen!(app, 110, 30)));
    expect(st.memError).toBe(DEAD);
    expect(screen).toContain("MEMORY UNREACHABLE");
    expect(screen).toContain("qcr-memory-forward");
    expect(screen).not.toContain("none yet");
  });

  it("an EMPTY but healthy store says so, with no banner anywhere", async () => {
    const { app } = makeApp();
    const st = install(app, new UnhealthyMemory({ ok: true, namespaces: [] }) as unknown as FakeMemory);
    app.hooks.digestScreen!(app, 110, 30);
    await settle();
    st.view = "memory";
    const screen = stripAnsi(renderScreen(app.hooks.digestScreen!(app, 110, 30)));
    expect(st.memError).toBeUndefined();
    expect(screen).toContain("none yet");
    expect(screen).not.toContain("UNREACHABLE");
  });

  it("one tree down shows a warning beside the other tree's entries", async () => {
    const { app } = makeApp();
    const entries = parseMemory(SAMPLE);
    const store = new UnhealthyMemory({ ok: false, namespaces: [], warning: "companion memory unreachable — no answer" }, entries);
    const st = install(app, store as unknown as FakeMemory);
    app.hooks.digestScreen!(app, 110, 30);
    await settle();
    st.view = "memory";
    const screen = stripAnsi(renderScreen(app.hooks.digestScreen!(app, 110, 30)));
    expect(screen).toContain("MEMORY (3)");
    expect(screen).toContain("companion memory unreachable");
    expect(screen).toContain("memory degraded");
  });

  it("the error state still renders every row at exactly `cols` cells", () => {
    const st: MemTabState = {
      view: "memory",
      digest: { files: [], back: 0, scroll: 0, awaitingSelected: 0, loaded: true },
      entries: [],
      memLoaded: true,
      memError: DEAD,
      focus: "timeline",
      sel: 0,
      propSel: 0,
      scroll: 0,
      proposals: [],
      improvements: [],
      propLoaded: true,
      ticketsLoaded: true,
      filedTotal: 0,
    };
    for (const cols of [100, 111]) {
      const frame = renderMemoryView(st, false, undefined, cols, 28);
      for (const line of frame.lines) expect(displayWidth(line)).toBe(cols);
    }
  });

  it("never auto-files off an unreachable store — an empty read is not 'no defects'", async () => {
    const root = mkdtempSync(join(tmpdir(), "memtab-dead-"));
    mkdirSync(join(root, ".ids"), { recursive: true });
    mkdirSync(join(root, "efforts/review-sandbox/tickets"), { recursive: true });
    const { app } = makeApp();
    install(app, new UnhealthyMemory({ ok: false, namespaces: [], error: DEAD }, parseMemory(SAMPLE)) as unknown as FakeMemory, {
      sink: new WayfinderIssueSink({ root, effort: "review-sandbox", parent: "FT-0026" }),
    });
    app.hooks.digestScreen!(app, 110, 30);
    await settle();
    expect(readdirSync(join(root, "efforts/review-sandbox/tickets"))).toHaveLength(0);
    rmSync(root, { recursive: true, force: true });
  });
});

// FT-0170 — the memory forward runs in the TUI process, and the tab is where
// its state is visible and its web UI is reachable.
describe("memory forward on the tab", () => {
  const UP = { state: "owned" as const, detail: "started by this TUI — closes on quit", baseUrl: "http://127.0.0.1:1933", studioUrl: "http://127.0.0.1:1933/studio" };
  const DOWN = { state: "failed" as const, detail: "could not bind 127.0.0.1:1933", baseUrl: "http://127.0.0.1:1933", studioUrl: "http://127.0.0.1:1933/studio" };

  const stubForward = (status: typeof UP | typeof DOWN) => ({
    view: () => status,
    ensure: () => Promise.resolve(status),
  });

  const memoryState = (forward?: typeof UP | typeof DOWN): MemTabState => ({
    view: "memory",
    digest: { files: [], back: 0, scroll: 0, awaitingSelected: 0, loaded: true },
    entries: parseMemory(SAMPLE),
    memLoaded: true,
    focus: "timeline",
    sel: 0,
    propSel: 0,
    scroll: 0,
    proposals: [],
    improvements: [],
    propLoaded: true,
  ticketsLoaded: true,
    filedTotal: 0,
    ...(forward ? { forward } : {}),
  });

  it("shows the studio URL when the forward is up", () => {
    const screen = stripAnsi(renderMemoryView(memoryState(UP), false, undefined, 110, 30).render());
    expect(screen).toContain("MEMORY STORE");
    expect(screen).toContain("owned");
    expect(screen).toContain("http://127.0.0.1:1933/studio");
    expect(screen).toContain("W studio");
  });

  it("offers no URL when the forward is down — a dead link is worse than none", () => {
    const screen = stripAnsi(renderMemoryView(memoryState(DOWN), false, undefined, 110, 30).render());
    expect(screen).toContain("failed");
    expect(screen).not.toContain("/studio");
    expect(screen).toContain("no web UI while the forward is down");
  });

  it("keeps every row exactly cols wide with the forward rows present", () => {
    for (const cols of [100, 111]) {
      for (const st of [memoryState(UP), memoryState(DOWN), memoryState()]) {
        for (const line of renderMemoryView(st, false, undefined, cols, 28).lines) expect(displayWidth(line)).toBe(cols);
      }
    }
  });

  it("W opens the studio URL through the app's browser hook", async () => {
    const { app } = makeApp();
    const opened: string[] = [];
    app.hooks.openUrl = (url) => opened.push(url);
    const st = install(app, new FakeMemory(), { forward: stubForward(UP) });
    app.hooks.digestScreen!(app, 110, 30);
    await settle();
    st.view = "memory";
    app.hooks.digestKey!(app, { kind: "char", ch: "W" });
    expect(opened).toEqual(["http://127.0.0.1:1933/studio"]);
  });

  it("W with the forward down opens nothing and says why", async () => {
    const { app } = makeApp();
    const opened: string[] = [];
    app.hooks.openUrl = (url) => opened.push(url);
    const st = install(app, new FakeMemory(), { forward: stubForward(DOWN) });
    app.hooks.digestScreen!(app, 110, 30);
    await settle();
    st.view = "memory";
    app.hooks.digestKey!(app, { kind: "char", ch: "W" });
    expect(opened).toEqual([]);
    expect(st.status).toContain("no web UI");
  });

  it("clicking the studio row opens the same URL the key does", async () => {
    const { app } = makeApp();
    const opened: string[] = [];
    app.hooks.openUrl = (url) => opened.push(url);
    const st = install(app, new FakeMemory(), { forward: stubForward(UP) });
    app.hooks.digestScreen!(app, 110, 30);
    await settle();
    st.view = "memory";
    const frame = renderMemoryView(st, false, undefined, 110, 30);
    // Paint through the hook so the tab records the zones the click hit-tests.
    app.hooks.digestScreen!(app, 110, 30);
    const zone = frame.zones.find((z) => (z.action as { t: string; url?: string }).t === "url" && (z.action as { url?: string }).url?.includes("/studio"));
    expect(zone, "the studio row must be a click target, not just a key").toBeDefined();
    app.hooks.digestClick!(app, zone!.x1, zone!.y1);
    expect(opened).toEqual(["http://127.0.0.1:1933/studio"]);
  });

  it("the forward is brought up BEFORE memory is read, so a refresh can fix the transport", async () => {
    const { app } = makeApp();
    const order: string[] = [];
    const mem = new FakeMemory();
    const read = mem.read.bind(mem);
    mem.read = () => {
      order.push("read");
      return read();
    };
    install(app, mem, {
      forward: {
        view: () => UP,
        ensure: () => {
          order.push("ensure");
          return Promise.resolve(UP);
        },
      },
    });
    app.hooks.digestScreen!(app, 110, 30);
    await settle();
    expect(order[0]).toBe("ensure");
    expect(order).toContain("read");
  });

  it("W is a registered digest-tab key — the companion sidebar must not swallow it", () => {
    expect(registeredKeys("digest").has("W")).toBe(true);
  });
});

// W is claimed for the whole [2] tab by registeredKeys, so it must work in
// BOTH of its views — a key that is registered and then swallowed unhandled is
// worse than one that was never claimed.
describe("W works on the digest view too, not just the memory view", () => {
  it("opens the studio URL without switching views first", async () => {
    const { app } = makeApp();
    const opened: string[] = [];
    app.hooks.openUrl = (url) => opened.push(url);
    const st = install(app, new FakeMemory(), {
      forward: {
        view: () => ({ state: "owned" as const, detail: "d", baseUrl: "http://127.0.0.1:1933", studioUrl: "http://127.0.0.1:1933/studio" }),
        ensure: () => Promise.resolve({ state: "owned" as const, detail: "d", baseUrl: "http://127.0.0.1:1933", studioUrl: "http://127.0.0.1:1933/studio" }),
      },
    });
    app.hooks.digestScreen!(app, 110, 30);
    await settle();
    expect(st.view).toBe("digest");
    app.hooks.digestKey!(app, { kind: "char", ch: "W" });
    expect(opened).toEqual(["http://127.0.0.1:1933/studio"]);
  });
});
