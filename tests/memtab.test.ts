// `[2] memory` (FT-0129, re-laid-out FT-0398): the day-grouped timeline, the
// reading pane and its verbs, the forward rows, and the honest states of a
// store that may not answer. Fake stores/ssh throughout; the App is driven
// through its installed TabHooks exactly as the real key router does.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  legacyBlockHash as blockHash,
  parseLegacyMemory as parseMemory,
} from "../src/memory/legacy-file.js";
import type { MemoryEntry, MemoryStore } from "../src/memory/store.js";
import { WayfinderIssueSink } from "../src/tui/issuesink.js";
import type { MemoryHealth } from "../src/tui/memory.js";
import {
  dayJump,
  groupStarts,
  memoryKeys,
  memoryOrder,
  memoryRows,
  pinnedBudget,
} from "../src/tui/memtab.js";
import { displayWidth, stripAnsi } from "../src/tui/paint.js";
import { FakeMemory, SAMPLE, learningRig, settle, type Rig } from "./helpers/tui-rig.js";

const screenOf = (rig: Rig, cols = 110, rows = 30): string =>
  stripAnsi(rig.app.hooks.tabs.memory!.screen(rig.app, cols, rows).render());
const key = (
  rig: Rig,
  k: Parameters<NonNullable<typeof rig.app.hooks.tabs.memory>["key"]>[1],
): boolean => rig.app.hooks.tabs.memory!.key(rig.app, k);

async function loaded(over: Parameters<typeof learningRig>[0] = {}): Promise<Rig> {
  const rig = learningRig(over);
  rig.app.tab = "memory";
  rig.app.hooks.tabs.memory!.screen(rig.app, 110, 30); // kicks the loads
  await settle();
  return rig;
}

describe("the day-grouped timeline", () => {
  const entries = parseMemory(SAMPLE);

  it("orders newest first with pinned floated, and groups rows under a header per day", () => {
    const ordered = memoryOrder(entries, null);
    expect(ordered.map((e) => e.id)).toEqual(["01a01b03", "01a01ab3", "01a01ab3"]);
    const rows = memoryRows(ordered);
    expect(rows.map((r) => (r.kind === "group" ? `# ${r.label}` : `${r.index}`))).toEqual([
      "# 2026-08-20",
      "0",
      "# 2026-08-19",
      "1",
      "2",
    ]);
  });

  it("a pinned entry heads its own group whatever its day", () => {
    const pinned = parseMemory(
      `<!-- 2026-08-10 08:00:00 [aa] -->\n#pinned a standing rule\n\n${SAMPLE}`,
    );
    const rows = memoryRows(memoryOrder(pinned, null));
    expect(rows[0]).toEqual({ kind: "group", label: "pinned" });
    expect(rows[1]).toMatchObject({ kind: "entry", index: 0 });
    expect(rows[2]).toEqual({ kind: "group", label: "2026-08-20" });
  });

  it("[ and ] jump between the first entries of the groups, and stop at the ends", () => {
    const ordered = memoryOrder(entries, null);
    expect(groupStarts(ordered)).toEqual([0, 1]);
    expect(dayJump(ordered, 0, 1)).toBe(1); // older
    expect(dayJump(ordered, 2, -1)).toBe(0); // newer, from the middle of a group
    expect(dayJump(ordered, 1, 1)).toBeUndefined(); // nothing older
    expect(dayJump(ordered, 0, -1)).toBeUndefined(); // nothing newer
  });

  it("offers a day key only when there is a day that way (the bar is state-derived)", async () => {
    const rig = await loaded();
    const keysOf = (): string[] =>
      memoryKeys(rig.learning.store, rig.learning.memory).bar.map((b) => b.key);
    expect(keysOf()).toEqual(["[", "n", "W"]); // on the newest day: older only
    expect(key(rig, { kind: "older" })).toBe(true);
    expect(rig.learning.memory.sel).toBe(1);
    expect(keysOf()).toEqual(["]", "n", "W"]); // on the oldest: newer only
    expect(key(rig, { kind: "older" })).toBe(false); // a boundary is not a dead key: unregistered AND unconsumed
  });

  it("paints the group headers, the count and the title", async () => {
    const rig = await loaded();
    const screen = screenOf(rig);
    expect(screen).toContain("memory · 2026-08-20");
    expect(screen).toContain("MEMORY (3)");
    expect(screen).toMatch(/── 2026-08-20 ─/);
    expect(screen).toMatch(/── 2026-08-19 ─/);
    expect(screen).toContain("[2 memory]");
    expect(screen).not.toContain("memory & learning");
    expect(screen).not.toContain("[v view]");
  });
});

describe("body-row width contract", () => {
  it("renders every line at EXACTLY cols cells, bar included, at two widths", async () => {
    const rig = await loaded();
    for (const cols of [100, 111]) {
      const frame = rig.app.hooks.tabs.memory!.screen(rig.app, cols, 28);
      for (const line of frame.lines) expect(displayWidth(line)).toBe(cols);
    }
  });

  it("the body reaches the command bar, however many rows the bar took", async () => {
    const rig = await loaded();
    for (const cols of [70, 120]) {
      const rows = 40;
      const frame = rig.app.hooks.tabs.memory!.screen(rig.app, cols, rows);
      const plain = frame.lines.map(stripAnsi);
      const barTop = plain.findIndex((l) => l.includes("[1 board]"));
      expect(barTop).toBeGreaterThan(0);
      expect(plain[barTop - 1]!.startsWith("│")).toBe(true); // content right above the bar
      expect(plain[rows - 1]!.startsWith("└")).toBe(true);
    }
  });
});

describe("the reading pane", () => {
  it("shows the selected entry in full with its verbs beside it, the defect flags and the store rows", async () => {
    const rig = await loaded();
    const screen = screenOf(rig, 140, 40);
    expect(screen).toContain("ENTRY 2026-08-20 09:01:42");
    expect(screen).toContain("[e edit]");
    expect(screen).toContain("[p pin]");
    expect(screen).toContain("[x retire]");
    expect(screen).toContain("stale recheck flag lingers on #5180");
    expect(screen).toContain("DEFECT FLAGS (1)");
    expect(screen).toContain("MEMORY STORE");
    // Proposals, tickets and bot PRs live on their own surfaces now.
    expect(screen).not.toContain("RUBRIC PROPOSALS");
    expect(screen).not.toContain("FEEDBACK TICKETS");
    expect(screen).not.toContain("BOT PRs");
  });

  it("warns when pinned entries outgrow the injection head budget", async () => {
    const md = `<!-- 2026-08-20 08:00:00 [aa] -->\n#pinned ${"x".repeat(2000)}\n`;
    expect(pinnedBudget(parseMemory(md)).over).toBe(true);
    const rig = await loaded({ mem: new FakeMemory(md) });
    expect(screenOf(rig)).toContain("⚠ pinned");
  });

  it("tags are not printed twice in the list line", async () => {
    const rig = await loaded();
    expect(screenOf(rig, 140, 40)).not.toMatch(/#bug #operations #bug #operations/);
  });
});

describe("management verbs", () => {
  it("retire needs x twice; the first only arms, and is painted as the confirmation", async () => {
    const rig = await loaded();
    expect(key(rig, { kind: "char", ch: "x" })).toBe(true);
    expect(rig.mem.applied).toHaveLength(0);
    expect(rig.learning.memory.confirmRetire).toBeDefined();
    expect(screenOf(rig, 140, 40)).toContain("[x CONFIRM retire]");
    key(rig, { kind: "char", ch: "x" });
    await settle();
    expect(rig.mem.applied).toHaveLength(1);
    expect(rig.mem.applied[0]).toMatchObject({ op: "retire" });
  });

  it("any other key disarms a pending retire", async () => {
    const rig = await loaded();
    key(rig, { kind: "char", ch: "x" });
    key(rig, { kind: "down", arrow: true });
    key(rig, { kind: "char", ch: "x" });
    expect(rig.mem.applied).toHaveLength(0); // re-armed on the new selection instead
  });

  it("p pins the selected (unpinned) entry with the right address", async () => {
    const rig = await loaded();
    key(rig, { kind: "char", ch: "p" });
    await settle();
    const newest = parseMemory(SAMPLE).find((e) => e.id === "01a01b03")!; // timeline floats newest first
    expect(rig.mem.applied[0]).toMatchObject({
      op: "pin",
      id: newest.id,
      ts: newest.ts,
      block: 0,
      expect: blockHash(newest.text),
    });
  });

  it("e opens a prefilled edit prompt; submit applies the edit", async () => {
    const rig = await loaded();
    expect(key(rig, { kind: "events" })).toBe(true);
    expect(rig.app.view.inputBox).toBeDefined();
    expect(rig.app.view.inputBox!.text).toContain("stale recheck flag");
    const send = (s: string): void =>
      (rig.app as unknown as { handleInput(b: Buffer): void }).handleInput(Buffer.from(s));
    send(" AMENDED");
    send("\r");
    await settle();
    expect(rig.mem.applied[0]).toMatchObject({ op: "edit" });
    expect((rig.mem.applied[0] as { text: string }).text).toContain("AMENDED");
  });

  it("n prompts for a new manual entry", async () => {
    const rig = await loaded();
    key(rig, { kind: "char", ch: "n" });
    const send = (s: string): void =>
      (rig.app as unknown as { handleInput(b: Buffer): void }).handleInput(Buffer.from(s));
    send("never trust a resolved checkmark");
    send("\r");
    await settle();
    expect(rig.mem.applied[0]).toMatchObject({
      op: "add",
      text: "never trust a resolved checkmark",
    });
  });

  it("with no entry selected, e/p/x are neither offered nor consumed — they are the companion's", async () => {
    const rig = await loaded({ mem: new FakeMemory("") });
    const live = memoryKeys(rig.learning.store, rig.learning.memory);
    expect(live.inline).toEqual([]);
    expect(key(rig, { kind: "events" })).toBe(false);
    expect(key(rig, { kind: "char", ch: "p" })).toBe(false);
    expect(key(rig, { kind: "char", ch: "x" })).toBe(false);
    expect(rig.app.view.inputBox).toBeUndefined();
  });

  it("F clears the tag filter, and is this tab's only while one is set", async () => {
    const rig = await loaded();
    expect(key(rig, { kind: "char", ch: "F" })).toBe(false);
    rig.learning.memory.filter = "bug";
    expect(screenOf(rig)).toContain("MEMORY (1)");
    expect(screenOf(rig)).toContain("⛉ #bug — F clears");
    expect(memoryKeys(rig.learning.store, rig.learning.memory).inline).toContain("F");
    expect(key(rig, { kind: "char", ch: "F" })).toBe(true);
    expect(rig.learning.memory.filter).toBeNull();
    expect(screenOf(rig)).toContain("MEMORY (3)");
  });

  it("a filter that matches nothing says so as a FILTERED empty, not an empty store", async () => {
    const rig = await loaded();
    rig.learning.memory.filter = "nonesuch";
    const screen = screenOf(rig);
    expect(screen).toContain("none matching — F clears #nonesuch");
    expect(screen).not.toContain("none yet");
  });

  it("auto-files #bug entries through the wayfinder sink on memory load", async () => {
    const root = mkdtempSync(join(tmpdir(), "memtab-tracker-"));
    mkdirSync(join(root, ".ids"), { recursive: true });
    mkdirSync(join(root, "efforts/review-sandbox/tickets"), { recursive: true });
    writeFileSync(join(root, ".ids", "0100"), "x\n");
    const mem = new FakeMemory();
    await loaded({
      mem,
      sink: new WayfinderIssueSink({ root, effort: "review-sandbox", parent: "FT-0026" }, mem),
    });
    const tickets = readdirSync(join(root, "efforts/review-sandbox/tickets"));
    expect(tickets).toHaveLength(1);
    expect(
      readFileSync(join(root, "efforts/review-sandbox/tickets", tickets[0]!), "utf8"),
    ).toContain("by qcr-tui");
    rmSync(root, { recursive: true, force: true });
  });

  it("a reload re-binds the selection to the same ENTRY, not the same ordinal", async () => {
    const mem = new FakeMemory();
    const rig = await loaded({ mem });
    key(rig, { kind: "down" });
    expect(rig.learning.memory.sel).toBe(1);
    // A newer entry lands; the timeline reorders and the old ordinal now
    // points at a different entry.
    mem.md = `<!-- 2026-08-21 10:00:00 [cc] -->\n#eod newest of all.\n\n${SAMPLE}`;
    rig.learning.store.reloadMemory();
    await settle();
    expect(rig.learning.memory.sel).toBe(2);
    // Ordinal 1 was the LATER block of the two entries that share a second
    // (newest first within a timestamp); after the reload it is ordinal 2.
    expect(memoryOrder(rig.learning.store.entries, null)[2]!.text).toContain(
      "lesson about External Apps",
    );
  });
});

describe("mouse operation (FT-0129 UX)", () => {
  it("clicking a timeline row selects it and the detail pane shows the FULL text", async () => {
    const rig = await loaded();
    const frame = rig.app.hooks.tabs.memory!.screen(rig.app, 140, 40); // paint captures zones
    const row = frame.zones.find(
      (z) =>
        (z.action as { t: string; i?: number }).t === "mem" && (z.action as { i: number }).i === 1,
    )!;
    expect(rig.app.hooks.tabs.memory!.click!(rig.app, row.x1, row.y1)).toBe(true);
    const screen = screenOf(rig, 140, 40);
    expect(rig.learning.memory.sel).toBe(1);
    expect(screen).toContain("ENTRY 2026-08-19 18:13:54");
    expect(screen).toContain("#refuted lesson about External Apps.");
  });

  it("verb buttons act: two clicks on [x retire] retire the selected entry", async () => {
    const rig = await loaded();
    const screen = screenOf(rig, 140, 40);
    const rowText = screen.split("\n")[2]!; // verbs row (terminal y 3)
    const x = rowText.indexOf("[x retire]") + 2;
    rig.app.hooks.tabs.memory!.click!(rig.app, x, 3);
    expect(rig.mem.applied).toHaveLength(0); // armed only
    const rowText2 = screenOf(rig, 140, 40).split("\n")[2]!;
    expect(rowText2).toContain("[x CONFIRM retire]");
    const x2 = rowText2.indexOf("[x CONFIRM retire]") + 2;
    rig.app.hooks.tabs.memory!.click!(rig.app, x2, 3);
    await settle();
    expect(rig.mem.applied[0]).toMatchObject({ op: "retire" });
  });
});

describe("quit vs late async repaints (ghost-frame regression)", () => {
  it("a load resolving after quit paints nothing onto the restored screen", async () => {
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
    const rig = learningRig({ memory: slowMemory });
    rig.app.tab = "memory";
    const running = rig.app.run(); // installs streams, starts poller
    rig.app.hooks.tabs.memory!.screen(rig.app, 110, 30); // kicks the slow load
    rig.app.quit();
    await running; // teardown done — terminal restored
    const at = rig.streams.written().length;
    release(); // the load resolves late and calls app.repaint()
    await settle();
    expect(rig.streams.written().length).toBe(at); // not one more byte on the normal screen
  });
});

// FT-0164: the tab runs on OpenViking, which can be unreachable. An empty
// timeline and an unreachable store MUST NOT look alike — an empty tab reads
// as a healthy tab with nothing in it, and the operator would act on it.
class UnhealthyMemory implements MemoryStore {
  constructor(
    private readonly h: MemoryHealth,
    private readonly entries: MemoryEntry[] = [],
  ) {}
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

const DEAD =
  "cannot reach OpenViking at http://127.0.0.1:1933 (connect ECONNREFUSED) — check: systemctl --user status qcr-memory-forward";

describe("memory unreachable (FT-0164)", () => {
  it("paints an explicit failure banner with the reason, never 'none yet' — and the defect count reads unknown", async () => {
    const rig = await loaded({
      memory: new UnhealthyMemory({ ok: false, namespaces: [], error: DEAD }),
    });
    const screen = screenOf(rig);
    expect(rig.learning.store.memError).toBe(DEAD);
    expect(screen).toContain("MEMORY UNREACHABLE");
    expect(screen).toContain("qcr-memory-forward");
    expect(screen).not.toContain("none yet");
    expect(screen).toContain("DEFECT FLAGS (—)");
  });

  it("an EMPTY but healthy store says so, with no banner anywhere", async () => {
    const rig = await loaded({ memory: new UnhealthyMemory({ ok: true, namespaces: [] }) });
    const screen = screenOf(rig);
    expect(rig.learning.store.memError).toBeUndefined();
    expect(screen).toContain("none yet — memory holds no entries");
    expect(screen).toContain("DEFECT FLAGS (0)");
    expect(screen).not.toContain("UNREACHABLE");
  });

  it("one tree down shows a warning beside the other tree's entries", async () => {
    const rig = await loaded({
      memory: new UnhealthyMemory(
        { ok: false, namespaces: [], warning: "companion memory unreachable — no answer" },
        parseMemory(SAMPLE),
      ),
    });
    const screen = screenOf(rig);
    expect(screen).toContain("MEMORY (3)");
    expect(screen).toContain("companion memory unreachable");
    expect(screen).toContain("memory degraded");
  });

  it("the error state still renders every row at exactly `cols` cells", async () => {
    const rig = await loaded({
      memory: new UnhealthyMemory({ ok: false, namespaces: [], error: DEAD }),
    });
    for (const cols of [100, 111]) {
      for (const line of rig.app.hooks.tabs.memory!.screen(rig.app, cols, 28).lines)
        expect(displayWidth(line)).toBe(cols);
    }
  });

  it("never auto-files off an unreachable store — an empty read is not 'no defects'", async () => {
    const root = mkdtempSync(join(tmpdir(), "memtab-dead-"));
    mkdirSync(join(root, ".ids"), { recursive: true });
    mkdirSync(join(root, "efforts/review-sandbox/tickets"), { recursive: true });
    await loaded({
      memory: new UnhealthyMemory({ ok: false, namespaces: [], error: DEAD }, parseMemory(SAMPLE)),
      sink: new WayfinderIssueSink({ root, effort: "review-sandbox", parent: "FT-0026" }),
    });
    expect(readdirSync(join(root, "efforts/review-sandbox/tickets"))).toHaveLength(0);
    rmSync(root, { recursive: true, force: true });
  });
});

// FT-0170 — the memory forward runs in the TUI process, and the tab is where
// its state is visible and its web UI is reachable.
describe("memory forward on the tab", () => {
  const UP = {
    state: "owned" as const,
    detail: "started by this TUI — closes on quit",
    baseUrl: "http://127.0.0.1:1933",
    studioUrl: "http://127.0.0.1:1933/studio",
  };
  const DOWN = {
    state: "failed" as const,
    detail: "could not bind 127.0.0.1:1933",
    baseUrl: "http://127.0.0.1:1933",
    studioUrl: "http://127.0.0.1:1933/studio",
  };
  const stubForward = (status: typeof UP | typeof DOWN) => ({
    view: () => status,
    ensure: () => Promise.resolve(status),
  });

  it("shows the studio URL when the forward is up", async () => {
    const rig = await loaded({ forward: stubForward(UP) });
    const screen = screenOf(rig);
    expect(screen).toContain("MEMORY STORE");
    expect(screen).toContain("owned");
    expect(screen).toContain("http://127.0.0.1:1933/studio");
    expect(screen).toContain("W studio");
  });

  it("offers no URL when the forward is down — a dead link is worse than none", async () => {
    const rig = await loaded({ forward: stubForward(DOWN) });
    const screen = screenOf(rig);
    expect(screen).toContain("failed");
    expect(screen).not.toContain("/studio");
    expect(screen).toContain("no web UI while the forward is down");
  });

  it("W opens the studio URL through the app's browser hook", async () => {
    const rig = await loaded({ forward: stubForward(UP) });
    const opened: string[] = [];
    rig.app.hooks.openUrl = (url) => opened.push(url);
    key(rig, { kind: "char", ch: "W" });
    expect(opened).toEqual(["http://127.0.0.1:1933/studio"]);
  });

  it("W with the forward down opens nothing and says why", async () => {
    const rig = await loaded({ forward: stubForward(DOWN) });
    const opened: string[] = [];
    rig.app.hooks.openUrl = (url) => opened.push(url);
    key(rig, { kind: "char", ch: "W" });
    expect(opened).toEqual([]);
    expect(rig.learning.store.status).toContain("no web UI");
  });

  it("clicking the studio row opens the same URL the key does", async () => {
    const rig = await loaded({ forward: stubForward(UP) });
    const opened: string[] = [];
    rig.app.hooks.openUrl = (url) => opened.push(url);
    const frame = rig.app.hooks.tabs.memory!.screen(rig.app, 110, 30);
    const zone = frame.zones.find(
      (z) =>
        (z.action as { t: string; url?: string }).t === "url" &&
        (z.action as { url?: string }).url?.includes("/studio"),
    );
    expect(zone, "the studio row must be a click target, not just a key").toBeDefined();
    rig.app.hooks.tabs.memory!.click!(rig.app, zone!.x1, zone!.y1);
    expect(opened).toEqual(["http://127.0.0.1:1933/studio"]);
  });

  it("the forward is brought up BEFORE memory is read, so a refresh can fix the transport", async () => {
    const order: string[] = [];
    const mem = new FakeMemory();
    const read = mem.read.bind(mem);
    mem.read = () => {
      order.push("read");
      return read();
    };
    await loaded({
      mem,
      forward: {
        view: () => UP,
        ensure: () => {
          order.push("ensure");
          return Promise.resolve(UP);
        },
      },
    });
    expect(order[0]).toBe("ensure");
    expect(order).toContain("read");
  });

  it("paints the forward as it stands at THIS paint — an owned forward's relay counts move between memory reloads (FT-0546 F1)", async () => {
    let counts = "relays 1/6 open, 0 waiting";
    const now = () => ({ ...UP, detail: `ours · ${counts}` });
    const rig = await loaded({ forward: { view: now, ensure: () => Promise.resolve(now()) } });
    expect(screenOf(rig)).toContain("relays 1/6 open, 0 waiting");
    // A relayout starts queueing; no memory reload happens in between.
    counts = "relays 6/6 open, 3 waiting";
    const screen = screenOf(rig);
    expect(screen).toContain("relays 6/6 open, 3 waiting");
    expect(screen).not.toContain("relays 1/6 open");
  });

  it("W is a registered memory-tab key — the companion column must not swallow it", async () => {
    const rig = await loaded();
    expect(rig.app.registeredKeys().has("W")).toBe(true);
  });
});
