// The 2026-08-14 usability batch: semantic theme, mouse decode + zones,
// rich PR rows, legend, section titles, GitHub links, detail enrichment.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WhyPayload } from "../src/cli.js";
import { enrichWhy } from "../src/cli.js";
import type { StatusSnapshot } from "../src/state.js";
import { renderBoard, type BoardAction, type BoardView } from "../src/tui/board.js";
import { extractMouseEvents, hitTest, type Zone } from "../src/tui/mouse.js";
import { Frame, accentFrameRect, displayWidth, stripAnsi } from "../src/tui/paint.js";
import { FG, fmtAge, legendLine, osc8, prUrl, stateColor, verdictChip } from "../src/tui/theme.js";

const NOW = new Date("2026-08-14T12:00:00Z");

describe("focused pane frame", () => {
  it("accents the existing square without colouring or moving its content", () => {
    const frame = new Frame(12, 4);
    frame.set(0, "┌──────────┐");
    frame.set(1, "│ content  │");
    frame.set(2, "│ more     │");
    frame.set(3, "└──────────┘");
    accentFrameRect(frame, 0, 0, 11, 3, "\x1b[35m", "\x1b[0m");
    expect(stripAnsi(frame.lines.join("\n"))).toBe("┌──────────┐\n│ content  │\n│ more     │\n└──────────┘");
    expect(frame.lines[0]).toContain("\x1b[35m┌");
    expect(frame.lines[1]).toContain("\x1b[35m│");
    for (const line of frame.lines) expect(displayWidth(line)).toBe(12);
  });
});

const snapshot: StatusSnapshot = {
  written_at: "2026-08-14T12:00:00Z",
  dry_run: true,
  prs: [
    {
      number: 5265,
      state: "awaiting_human",
      title: "fix(ui): frame the buttons",
      head_sha: "19277cdff",
      stale_recheck: 0,
      author: "jbennett",
      updated_at: "2026-08-14T11:48:00Z",
      rounds: 3,
      last_verdict: "REQUEST_CHANGES",
    },
    {
      number: 5277,
      state: "reviewing",
      title: "fix(ci): sanitize branch names",
      head_sha: "786ebb790",
      stale_recheck: 0,
      author: "owner_legacy",
      updated_at: "2026-08-14T09:00:00Z",
      rounds: 1,
      last_verdict: null,
    },
  ],
  running_rounds: 1,
  max_concurrent_rounds: 12,
  total_spend_usd: 8,
  today_spend_usd: 7.5,
  heartbeat: "2026-08-14T12:00:00Z",
};

const view = (over: Partial<BoardView> = {}): BoardView => ({
  health: { kind: "ok", heartbeatAgeS: 2 },
  dryRun: true,
  snapshot,
  events: [],
  selected: 0,
  detailFull: false,
  eventsFocus: false,
  eventsScroll: 0,
  help: false,
  now: NOW,
  repo: "example-org/example-app",
  ...over,
});

describe("theme", () => {
  it("maps every lifecycle state to a distinct color", () => {
    const colors = ["reviewing", "queued", "awaiting_author", "awaiting_human", "tracked"].map(stateColor);
    expect(new Set(colors).size).toBe(colors.length);
  });

  it("renders verdict chips with their colors", () => {
    expect(stripAnsi(verdictChip("APPROVE"))).toBe("✓A");
    expect(stripAnsi(verdictChip("REQUEST_CHANGES"))).toBe("✗RC");
    expect(verdictChip("APPROVE")).toContain(FG.approve);
    expect(verdictChip(null)).toBe("");
  });

  it("formats ages at a glance", () => {
    expect(fmtAge("2026-08-14T11:59:15Z", NOW)).toBe("45s");
    expect(fmtAge("2026-08-14T11:48:00Z", NOW)).toBe("12m");
    expect(fmtAge("2026-08-14T09:00:00Z", NOW)).toBe("3h");
    expect(fmtAge("2026-08-12T09:00:00Z", NOW)).toBe("2d");
    expect(fmtAge(null, NOW)).toBe("—");
  });

  it("builds OSC-8 hyperlinks that strip to their text", () => {
    const link = osc8(prUrl("o/r", 7), "#7");
    expect(link).toContain("https://github.com/o/r/pull/7");
    expect(stripAnsi(link)).toBe("#7");
    expect(displayWidth(link)).toBe(2);
  });

  it("legend covers every glyph", () => {
    const plain = stripAnsi(legendLine());
    for (const g of ["▶", "●", "⚑", "✎", "·", "↻"]) expect(plain).toContain(g);
  });
});

describe("mouse decode", () => {
  it("decodes SGR clicks and wheel, stripping them from the byte stream", () => {
    const buf = Buffer.from("ab\x1b[<0;12;5Mcd\x1b[<64;3;4M\x1b[<0;12;5m");
    const { events, rest } = extractMouseEvents(buf);
    expect(events).toEqual([
      { kind: "click", x: 12, y: 5 },
      { kind: "wheel-up", x: 3, y: 4 },
      // release is reported now — it is what ends a selection and
      // triggers the copy. It used to be parsed and thrown away.
      { kind: "release", x: 12, y: 5 },
    ]);
    expect(rest.toString()).toBe("abcd");
  });

  it("decodes a drag (motion with the left button held) — bit 32", () => {
    // Without ?1002h there is no drag report at all, and with it the motion
    // events carry bit 32. `32` = left button held while moving.
    const { events } = extractMouseEvents(Buffer.from("\x1b[<32;7;9M"));
    expect(events).toEqual([{ kind: "drag", x: 7, y: 9 }]);
    // A drag is NOT a click: it must never fire a button or select a row.
    expect(events[0]!.kind).not.toBe("click");
  });

  it("passes non-mouse input through untouched", () => {
    const buf = Buffer.from("\x1b[13;2u");
    const { events, rest } = extractMouseEvents(buf);
    expect(events).toEqual([]);
    expect(rest).toBe(buf);
  });

  it("hit-tests zones, last-declared wins", () => {
    const zones: Zone<string>[] = [
      { x1: 1, y1: 2, x2: 30, y2: 2, action: "row" },
      { x1: 4, y1: 2, x2: 9, y2: 2, action: "number" },
    ];
    expect(hitTest(zones, 5, 2)).toBe("number");
    expect(hitTest(zones, 15, 2)).toBe("row");
    expect(hitTest(zones, 15, 3)).toBeUndefined();
  });
});

describe("rich board", () => {
  it("PR rows carry author, age, round count and verdict chip", () => {
    const text = renderBoard(view(), 140, 40).lines.map(stripAnsi).join("\n");
    expect(text).toContain("⚑ #5265 jbennett 12m r3 ✗RC fix(ui)");
    expect(text).toContain("▶ #5277 owner_legacy 3h r1 fix(ci)");
  });

  it("renders the colored legend under the list", () => {
    const text = renderBoard(view(), 140, 40).lines.map(stripAnsi).join("\n");
    expect(text).toContain("▶ reviewing");
    expect(text).toContain("⚑ needs-you");
  });

  it("declares zones: rows select, numbers open GitHub (bar clicks live in cmdbar)", () => {
    const frame = renderBoard(view(), 140, 40);
    const zones = frame.zones as Zone<BoardAction>[];
    const kinds = zones.map((z) => z.action.t);
    expect(kinds).toContain("select-pr");
    expect(kinds).toContain("open-github");
    // Sort order: reviewing first — #5277 is the first row (terminal row 3).
    expect(hitTest(zones, 20, 3)).toEqual({ t: "select-pr", pr: 5277 });
    expect(hitTest(zones, 5, 3)).toEqual({ t: "open-github", pr: 5277 });
    expect(hitTest(zones, 20, 4)).toEqual({ t: "select-pr", pr: 5265 });
  });

  it("embeds OSC-8 links on PR numbers when a repo is known", () => {
    const raw = renderBoard(view(), 140, 40).lines.join("\n");
    expect(raw).toContain("https://github.com/example-org/example-app/pull/5265");
  });

  it("detail pane renders description, labels and comments when enriched", async () => {
    const detail: WhyPayload = {
      pr: 5265,
      known: true,
      state: "awaiting_human",
      title: "fix(ui): frame the buttons",
      head_sha: "19277cdff",
      author: "jbennett",
      spend_usd: 1.2,
      rounds: [],
      threads: { open: 0, total: 0 },
      description: "Frames the CTA buttons as the visitor sees them.\nSecond line.",
      labels: ["AI review requested", "frontend"],
      comments: [{ author: "owner_legacy", body: "please also check mobile", created_at: "2026-08-14T11:00:00Z" }],
    };
    const text = renderBoard(view({ detail, selected: 1 }), 140, 44).lines.map(stripAnsi).join("\n");
    expect(text).toContain("DESCRIPTION");
    expect(text).toContain("Frames the CTA buttons");
    expect(text).toContain("[AI review requested]");
    expect(text).toContain("COMMENTS");
    expect(text).toContain("owner_legacy 1h ago");
    expect(text).toContain("  please also check mobile"); // body wraps on its own indented line now
    expect(text).toContain("by jbennett");
  });
});

describe("live pi mirror pane", () => {
  const pane = { pr: 5277, lines: ["\x1b[36m▌ pi\x1b[0m reading src/tasks.py", "…thinking"], missing: false, stale: false, offset: 0 };

  it("fills the lower half with the selected session, colors intact", () => {
    const frame = renderBoard(view({ pi: pane }), 140, 40);
    const text = frame.lines.map(stripAnsi).join("\n");
    expect(text).toContain("PI pr-5277 · live mirror · click to type"); // #5277 sorts first (reviewing)
    expect(text).toContain("reading src/tasks.py");
    expect(frame.lines.join("\n")).toContain("\x1b[36m▌ pi");
    // The pane really is the lower half, not a strip.
    expect(frame.meta["piRows"]).toBe(18);
    expect(frame.meta["piTop"]).toBe(40 - 4 - 18 + 1);
  });

  it("clicking anywhere in the pane focuses it in place — never a full-screen attach", () => {
    const frame = renderBoard(view({ pi: pane }), 140, 40);
    const zones = frame.zones as Zone<BoardAction>[];
    expect(hitTest(zones, 50, 30)).toEqual({ t: "pi-focus" });
    expect(hitTest(zones, 4, frame.meta["piTop"]! + 1)).toEqual({ t: "pi-focus" }); // divider row too
    expect(hitTest(zones, 20, 3)).toEqual({ t: "select-pr", pr: 5277 }); // list untouched
    expect(zones.some((z) => (z.action as { t: string }).t === "attach")).toBe(false);
  });

  it("the events overlay sits on top of the mirror and takes its clicks", () => {
    const zones = renderBoard(view({ pi: pane, eventsFocus: true, events: [{ ts: "t", text: "10:00:00 round_done #5265", anomaly: false }] }), 140, 40)
      .zones as Zone<BoardAction>[];
    expect(hitTest(zones, 50, 10)).toEqual({ t: "event-jump", pr: 5265 }); // band top row 8 → first event on frame row 9
  });
});

describe("enrichWhy", () => {
  it("degrades silently when GitHub is unreachable (no secrets locally)", async () => {
    const payload: WhyPayload = { pr: 1, known: false, spend_usd: 0, rounds: [], threads: { open: 0, total: 0 } };
    // Point the credential lookup at an empty dir: on a machine that DOES
    // carry the real app credential this would otherwise hit the network.
    const noSecrets = mkdtempSync(join(tmpdir(), "qcr-nosecrets-"));
    const out = await enrichWhy(payload, noSecrets);
    expect(out.pr).toBe(1);
    // Either enriched (container) or identical (no credentials) — never a throw.
    expect(out.known).toBe(false);
  });
});
