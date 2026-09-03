// `[4] tickets` (FT-0398): the tracker projection as its own surface. The four
// states of the read are the point — not scanned, no tracker, scan failed,
// read — and the bar offers only what the state can answer.
import { describe, expect, it } from "vitest";
import { displayWidth, stripAnsi } from "../src/tui/paint.js";
import { ticketsKeys, visibleTickets } from "../src/tui/ticketstab.js";
import type { TrackerTicket } from "../src/tui/trackertickets.js";
import { learningRig, settle, type Rig } from "./helpers/tui-rig.js";

const ticket = (id: string, status = "open", lines = 3): TrackerTicket => ({
  id,
  title: `Ticket ${id}`,
  status,
  role: "ready-for-human",
  category: "—",
  updated: "2026-08-25T18:00:00Z",
  path: `/tracker/${id}.md`,
  body: `# Ticket ${id}\n\n${Array.from({ length: lines }, (_, i) => `line ${i}`).join("\n")}`,
});

const screenOf = (rig: Rig, cols = 120, rows = 30): string =>
  stripAnsi(rig.app.hooks.tabs.tickets!.screen(rig.app, cols, rows).render());
const key = (
  rig: Rig,
  k: Parameters<NonNullable<typeof rig.app.hooks.tabs.tickets>["key"]>[1],
): boolean => rig.app.hooks.tabs.tickets!.key(rig.app, k);

describe("the four states of the read", () => {
  it("before the scan the count is unknown and the bar offers nothing to filter", () => {
    const rig = learningRig({ readTickets: () => [ticket("FT-0300")] });
    // The scan is a filesystem walk and runs behind the first frame — nobody
    // has called reloadTickets yet.
    expect(rig.learning.store.tickets).toEqual({ kind: "unread" });
    const screen = screenOf(rig);
    expect(screen).toContain("TICKETS (—)");
    expect(screen).toContain("not read yet");
    expect(screen).not.toContain("TICKETS (0");
    expect(ticketsKeys(rig.learning.store, rig.learning.tickets).bar).toEqual([]);
  });

  it("no tracker configured is said, not shown as an empty list", () => {
    const rig = learningRig({ readTickets: undefined });
    expect(rig.learning.store.tickets).toEqual({ kind: "unconfigured" });
    const screen = screenOf(rig);
    expect(screen).toContain("could not read — no tracker configured");
    expect(screen).not.toContain("none yet");
    // …and `r` cannot turn it into a read.
    rig.learning.store.reloadTickets();
    expect(rig.learning.store.tickets).toEqual({ kind: "unconfigured" });
  });

  it("a throwing scan is UNREADABLE, never latched as read-and-empty, and a later scan recovers", () => {
    let broken = true;
    const rig = learningRig({
      readTickets: () => {
        if (broken) throw new Error("ENOENT: tracker dir");
        return [ticket("FT-0301")];
      },
    });
    rig.learning.store.reloadTickets();
    expect(rig.learning.store.tickets).toMatchObject({
      kind: "unreadable",
      reason: "ENOENT: tracker dir",
    });
    expect(screenOf(rig)).toContain("could not read — ENOENT: tracker dir");
    broken = false;
    rig.learning.store.reloadTickets();
    expect(rig.learning.store.tickets).toMatchObject({ kind: "read" });
    expect(screenOf(rig)).toContain("FT-0301 [open] Ticket FT-0301");
  });

  it("read and empty says what would fill it", () => {
    const rig = learningRig({ readTickets: () => [] });
    rig.learning.store.reloadTickets();
    const screen = screenOf(rig, 200);
    expect(screen).toContain("TICKETS (0 actionable / 0 total)");
    expect(screen).toContain("none yet — adjudication files a ticket only when something changes");
  });
});

describe("the list and the pane", () => {
  function readRig(): Rig {
    const rig = learningRig({
      readTickets: () => [
        ticket("FT-0300", "resolved"),
        ticket("FT-0301"),
        ticket("FT-0302", "claimed", 80),
      ],
    });
    rig.app.tab = "tickets";
    rig.learning.store.reloadTickets();
    return rig;
  }

  it("shows actionable tickets first and by default, with the selected one's whole body on the right", () => {
    const rig = readRig();
    const screen = screenOf(rig);
    expect(screen).toContain("TICKETS (2 actionable / 3 total)");
    expect(screen).toContain("FT-0301 [open] Ticket FT-0301");
    expect(screen).toContain("FT-0302 [claimed] Ticket FT-0302");
    expect(screen).not.toContain("FT-0300 [resolved]");
    expect(screen).toContain("line 0"); // the body
    expect(visibleTickets(rig.learning.store.tickets, false).map((t) => t.id)).toEqual([
      "FT-0301",
      "FT-0302",
    ]);
  });

  it("c shows the closed ones too and is painted as the other half of the toggle", () => {
    const rig = readRig();
    expect(ticketsKeys(rig.learning.store, rig.learning.tickets).bar.map((b) => b.label)).toContain(
      "c show all",
    );
    expect(key(rig, { kind: "char", ch: "c" })).toBe(true);
    expect(screenOf(rig)).toContain("FT-0300 [resolved]");
    expect(ticketsKeys(rig.learning.store, rig.learning.tickets).bar.map((b) => b.label)).toContain(
      "c actionable",
    );
  });

  it("with every ticket closed the default list is a FILTERED empty, not an empty tracker", () => {
    const rig = learningRig({ readTickets: () => [ticket("FT-0300", "resolved")] });
    rig.learning.store.reloadTickets();
    const screen = screenOf(rig);
    expect(screen).toContain("none matching — c shows all 1");
    expect(screen).not.toContain("none yet");
  });

  it("j/k choose a ticket (and say so), the wheel and [ / ] scroll its body", async () => {
    const rig = readRig();
    key(rig, { kind: "down" });
    expect(rig.learning.tickets.sel).toBe(1);
    expect(rig.app.view.noticeLine).toContain("ticket open → FT-0302");
    screenOf(rig, 120, 24); // the frame is painted before the next key: how far the body can scroll comes from the paint
    key(rig, { kind: "down", wheel: true });
    expect(rig.learning.tickets.sel).toBe(1); // the wheel reads, it does not choose
    expect(rig.learning.tickets.scroll).toBe(3);
    key(rig, { kind: "newer" });
    expect(rig.learning.tickets.scroll).toBe(8);
    key(rig, { kind: "older" });
    expect(rig.learning.tickets.scroll).toBe(3);
    expect(screenOf(rig, 120, 24)).toContain("more lines");
    await settle();
  });

  it("clicking a row selects it", () => {
    const rig = readRig();
    const frame = rig.app.hooks.tabs.tickets!.screen(rig.app, 120, 30);
    const row = frame.zones.find(
      (z) =>
        (z.action as { t: string; i: number }).t === "ticket" &&
        (z.action as { i: number }).i === 1,
    )!;
    expect(rig.app.hooks.tabs.tickets!.click!(rig.app, row.x1, row.y1)).toBe(true);
    expect(rig.learning.tickets.sel).toBe(1);
  });

  it("renders every line at exactly cols cells in every state", () => {
    for (const rig of [
      readRig(),
      learningRig({ readTickets: undefined }),
      learningRig({ readTickets: () => [] }),
    ]) {
      for (const cols of [90, 121]) {
        for (const line of rig.app.hooks.tabs.tickets!.screen(rig.app, cols, 26).lines)
          expect(displayWidth(line)).toBe(cols);
      }
    }
  });
});
