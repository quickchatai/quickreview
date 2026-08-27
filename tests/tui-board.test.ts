import { BAD_BG } from "../src/tui/design.js";
import { describe, expect, it } from "vitest";
import type { WhyPayload } from "../src/cli.js";
import type { StatusSnapshot } from "../src/state.js";
import { piPaneSize, piRows, renderBoard, topBar, detailLines, type BoardView } from "../src/tui/board.js";
import { decodeKey, decodeInputKey } from "../src/tui/keys.js";
import { displayWidth, fit, rule, sanitizeText, stripAnsi, truncate, wrap } from "../src/tui/paint.js";
import { captureArgv, statusArgv, whyArgv, eventsArgv, progressArgv, attachArgv, type SshRunner } from "../src/tui/remote.js";
import { PiMirror } from "../src/tui/pipane.js";
import { TUI_DEFAULTS } from "../src/config.js";

const snapshot: StatusSnapshot = {
  written_at: "2026-08-13T12:00:00Z",
  dry_run: true,
  prs: [
    { number: 5012, state: "reviewing", title: "fix(crm): retry send_message", head_sha: "a2e380ff11", stale_recheck: 0 },
    { number: 5049, state: "awaiting_author", title: "feat(remote-api): dispatch", head_sha: "bb11223344", stale_recheck: 0 },
  ],
  running_rounds: 3,
  max_concurrent_rounds: 12,
  total_spend_usd: 20,
  today_spend_usd: 4.12,
  heartbeat: "2026-08-13T12:00:00Z",
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
  ...over,
});

describe("paint primitives", () => {
  it("truncates with an ellipsis and pads to width", () => {
    expect(truncate("hello world", 8)).toBe("hello w…");
    expect(truncate("short", 8)).toBe("short");
    expect(fit("ab", 5)).toBe("ab   ");
    expect(displayWidth(fit("界面测试", 6))).toBe(6); // CJK counts 2 cells
  });

  it("strips ANSI before measuring", () => {
    expect(displayWidth("\x1b[1mbold\x1b[0m")).toBe(4);
    expect(stripAnsi("\x1b[38;2;1;2;3mx\x1b[0m")).toBe("x");
  });

  it("builds a rule of exactly the requested width", () => {
    const r = rule(40, "┌", "┐", ["quickreview", "DRY-RUN"]);
    expect(displayWidth(r)).toBe(40);
    expect(r).toContain("quickreview ── DRY-RUN");
  });
});

describe("topBar", () => {
  it("shows dry-run, health, rounds and today spend", () => {
    const bar = stripAnsi(topBar(view(), 100));
    expect(bar).toContain("DRY-RUN");
    expect(bar).toContain("daemon ok (hb 2s)");
    expect(bar).toContain("rounds 3/12");
    expect(bar).toContain("today $4.12");
  });

  it("replaces health with the stale banner", () => {
    const bar = stripAnsi(topBar(view({ health: { kind: "stale", dataAgeS: 42 } }), 100));
    expect(bar).toContain("DATA STALE (42s)");
  });

  it("marks LIVE loudly when dry_run is off", () => {
    const bar = topBar(view({ dryRun: false }), 100);
    expect(stripAnsi(bar)).toContain("LIVE");
    expect(bar).toContain(BAD_BG); // red truth chip (design.badge)
  });
});

describe("detailLines", () => {
  const why: WhyPayload = {
    pr: 5012,
    known: true,
    state: "reviewing",
    title: "fix(crm): retry send_message",
    head_sha: "a2e380ff11",
    trigger_ts: "2026-08-13T14:02:00Z",
    spend_usd: 1.3,
    rounds: [
      { round_no: 1, round_type: "initial", status: "done", verdict: "REQUEST_CHANGES", started_at: "", finished_at: "", spend_usd: 0.5, lenses: "a" },
      { round_no: 2, round_type: "rework", status: "running", verdict: null, started_at: "", finished_at: null, spend_usd: null, lenses: "b" },
    ],
    threads: { open: 2, total: 2 },
    ledger: "F1 [P1/0.9][delivery] tasks.py:88 open\n",
  };

  it("renders header facts, ledger, rounds and threads", () => {
    const lines = detailLines(why, snapshot.prs[0], 60).map(stripAnsi);
    // The esc-worthy fact went with the escalation heuristic (2026-08-18).
    expect(lines[1]).toBe("reviewing · round 2");
    expect(lines[2]).toContain("spend $1.30 · head a2e380f · trig");
    expect(lines).toContain("F1 [P1/0.9][delivery] tasks.py:88 open");
    expect(lines.find((l) => l.startsWith("▍ROUNDS"))).toContain("r1 RC · r2 …");
    expect(lines.find((l) => l.startsWith("▍THREADS"))).toContain("2 known");
  });

  it("shows a loading line until the payload matches the selection", () => {
    const lines = detailLines(undefined, snapshot.prs[0], 60).map(stripAnsi);
    expect(lines[1]).toBe("loading detail…");
  });

  it("shows round timing, parent activity, every planned lens, and verdict progress", () => {
    const live: WhyPayload = {
      ...why,
      rounds: [{
        round_no: 14,
        round_type: "re-review",
        status: "running",
        verdict: null,
        started_at: "2026-08-27T09:34:54Z",
        deadline_at: "2026-08-27T10:49:54Z",
        finished_at: null,
        spend_usd: null,
        lenses: "pass-baseline,pass-security,pass-validate",
        validate_tier: "sol-high",
      }],
    };
    const lines = detailLines(
      live,
      snapshot.prs[0],
      76,
      new Date("2026-08-27T10:04:54Z"),
      {
        version: 1,
        pr: 5012,
        session: "pr-5012",
        run_started_at: "2026-08-27T09:34:55Z",
        updated_at: "2026-08-27T10:04:53Z",
        parent_status: "active",
        last_activity_at: "2026-08-27T10:04:50Z",
        last_activity: "pass-security · grep: bearer",
        active_tool: "subagent: pass-security",
        agents: [
          { agent: "pass-baseline", status: "completed", duration_ms: 120_000, tool_count: 7 },
          { agent: "pass-security", status: "running", duration_ms: 30_000, tool_count: 2, current_tool: "grep: bearer" },
          { agent: "pass-architecture", status: "completed", duration_ms: 60_000, tool_count: 5 },
        ],
      },
    ).map(stripAnsi);
    expect(lines).toContain("▍CURRENT REVIEW round 14 · 30m elapsed · 45m left");
    expect(lines).toContain("  parent ACTIVE · signal 1s ago · subagent: pass-security");
    expect(lines).toContain("  ✓ pass-baseline · done in 2m · 7 tools");
    expect(lines).toContain("  ⟳ pass-security · running 30s · grep: bearer");
    expect(lines).toContain("  ○ pass-validate · pending · sol-high");
    expect(lines).toContain("  ✓ pass-architecture · done in 1m · 5 tools · added");
    expect(lines).toContain("  ○ final verdict · pending");
    expect(lines).toContain("  last activity 4s ago · pass-security · grep: bearer");
  });

  it("never invents pending agent state when the progress signal is absent", () => {
    const live: WhyPayload = {
      ...why,
      rounds: [{ ...why.rounds[1]!, deadline_at: "2026-08-27T10:49:54Z", lenses: "pass-baseline,pass-validate" }],
    };
    const lines = detailLines(live, snapshot.prs[0], 76, new Date("2026-08-27T10:04:54Z")).map(stripAnsi);
    expect(lines).toContain("  ? parent · live progress unavailable");
    expect(lines).toContain("  ? pass-baseline · unknown");
    expect(lines).toContain("  ? pass-validate · unknown");
  });

  // a cancelled round used to render as a bare "—", identical to
  // every other verdictless round. It now says which kind of cancellation.
  describe("cancelled rounds name their cause", () => {
    const withRounds = (rounds: WhyPayload["rounds"]): string[] =>
      detailLines({ ...why, rounds }, snapshot.prs[0], 60).map(stripAnsi);

    it("marks the round and spells the cause out underneath", () => {
      const lines = withRounds([
        { round_no: 1, round_type: "initial", status: "cancelled", verdict: null, started_at: "", finished_at: "", spend_usd: null, lenses: "a", cancel_cause: "orphan_sweep" },
        { round_no: 2, round_type: "rework", status: "cancelled", verdict: null, started_at: "", finished_at: "", spend_usd: null, lenses: "b", cancel_cause: "deadline_overrun" },
      ]);
      expect(lines.find((l) => l.startsWith("▍ROUNDS"))).toContain("r1 ✕ · r2 ✕");
      expect(lines).toContain("  ✕ r1 cancelled — orphan sweep (redeploy)");
      expect(lines).toContain("  ✕ r2 cancelled — stopped dead");
    });

    it("an older daemon's payload (no cause) reads as unclassified, never as benign", () => {
      const lines = withRounds([
        { round_no: 1, round_type: "initial", status: "cancelled", verdict: null, started_at: "", finished_at: "", spend_usd: null, lenses: "a" },
      ]);
      expect(lines).toContain("  ✕ r1 cancelled — unclassified");
    });

    it("adds nothing for a PR with no cancelled round", () => {
      expect(withRounds(why.rounds).filter((l) => l.includes("cancelled"))).toEqual([]);
    });
  });
});

describe("sanitizeText + wrap (foreign-text hygiene)", () => {
  it("strips CR so GitHub CRLF bodies cannot rehome the cursor", () => {
    expect(sanitizeText("line one\r\nline two\r")).toBe("line one\nline two\n");
  });
  it("expands tabs and drops other control bytes", () => {
    expect(sanitizeText("a\tb")).toBe("a  b");
    expect(sanitizeText("x\x00y\x08z\x07w")).toBe("xyzw");
  });
  it("word-wraps at cell width, preserving paragraph breaks", () => {
    expect(wrap("alpha beta gamma", 11)).toEqual(["alpha beta", "gamma"]);
    expect(wrap("one\n\ntwo", 20)).toEqual(["one", "", "two"]);
  });
  it("hard-breaks a word longer than the width", () => {
    expect(wrap("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });
  it("counts CJK as two cells when wrapping", () => {
    expect(wrap("\u6c49\u5b57\u6c49\u5b57", 4)).toEqual(["\u6c49\u5b57", "\u6c49\u5b57"]);
  });
});

describe("detailLines keeps foreign text inside the pane", () => {
  const whyBase: WhyPayload = {
    pr: 5012,
    known: true,
    state: "reviewing",
    title: "fix(crm): retry send_message",
    head_sha: "a2e380ff11",
    trigger_ts: "2026-08-13T14:02:00Z",
    spend_usd: 1.3,
    rounds: [],
    threads: { open: 0, total: 0 },
    ledger: null,
  };
  it("wraps a long CRLF description instead of truncating rightwards", () => {
    const d: WhyPayload = {
      ...whyBase,
      description: "First sentence of the body.\r\nSecond line that is quite long and would previously vanish off the right edge of the pane entirely.",
    };
    const lines = detailLines(d, snapshot.prs[0], 30);
    const flat = lines.map(stripAnsi);
    expect(flat.some((l) => l.includes("First sentence"))).toBe(true);
    expect(flat.some((l) => l.includes("right edge"))).toBe(true);
    for (const l of lines) expect(displayWidth(l)).toBeLessThanOrEqual(30);
    for (const l of lines) expect(l.includes("\r")).toBe(false);
  });
  it("comments render as head line + wrapped indented body, never overwide", () => {
    const d: WhyPayload = {
      ...whyBase,
      comments: [{ author: "alice", created_at: "2026-08-14T00:00:00Z", body: "A very long comment body\r\nwith CRLF endings that keeps going and going well past the pane width to prove wrapping works." }],
    };
    const lines = detailLines(d, snapshot.prs[0], 28, new Date("2026-08-14T01:00:00Z"));
    for (const l of lines) expect(displayWidth(l)).toBeLessThanOrEqual(28);
    const flat = lines.map(stripAnsi);
    expect(flat.some((l) => l.startsWith("  A very long"))).toBe(true);
  });
});

describe("adaptive layout", () => {
  it("sizes the list column to the longest PR row, clamped to 45% of the width", async () => {
    const { listWidth } = await import("../src/tui/board.js");
    const prs = snapshot.prs;
    const w = listWidth(prs, 120);
    // widest row incl. author/age/round columns and the legend floor
    expect(w).toBeGreaterThanOrEqual(43);
    expect(w).toBeLessThanOrEqual(Math.floor(120 * 0.45));
    expect(listWidth(prs, 60)).toBe(27); // clamp: 45% of 60
  });

  it("gives the live pi mirror half the screen, never starving the body", async () => {
    const { piRows } = await import("../src/tui/board.js");
    expect(piRows(24)).toBe(10); // 21 usable / 2
    expect(piRows(40)).toBe(18);
    expect(piRows(14)).toBe(6); // floor
    expect(piRows(11)).toBe(4); // squeezed: body keeps 3 rows
  });

  it("the body reaches the command bar now the companion strip is retired", () => {
    // Frame geometry: top bar (0), body 1..rows-4, command bar rows-3..rows-2,
    // bottom border rows-1. The 7 strip rows the board used to give up are the
    // sidebar's problem now — it is a column, not a band.
    for (const rows of [24, 40]) {
      const frame = renderBoard(view({ pi: { pr: 5012, lines: ["pi output"], missing: false, stale: false, offset: 0 } }), 120, rows);
      expect(frame.meta["bodyRows"]! + frame.meta["piRows"]!).toBe(rows - 4);
      expect(frame.meta["piTop"]! + frame.meta["piRows"]! - 1).toBe(rows - 4); // last body row
      expect(frame.lines[rows - 4]!.startsWith("│")).toBe(true); // still content, not chrome
      expect(stripAnsi(frame.lines[rows - 3]!)).toContain("1 board"); // the command bar
      for (const z of frame.zones) expect(z.y2).toBeLessThanOrEqual(rows - 3); // terminal rows are 1-based
    }
  });

  it("centers the events overlay band on the screen", async () => {
    const { eventsOverlayBand } = await import("../src/tui/board.js");
    expect(eventsOverlayBand(24)).toEqual({ top: 5, height: 14 });
    expect(eventsOverlayBand(48)).toEqual({ top: 10, height: 28 });
  });

  it("shows full titles and more events on a tall wide terminal", () => {
    const events = Array.from({ length: 8 }, (_, i) => ({ ts: `t${i}`, text: `10:00:0${i} event_${i}`, anomaly: false }));
    const text = renderBoard(view({ events, eventsFocus: true }), 140, 48).lines.map(stripAnsi).join("\n");
    expect(text).toContain("fix(crm): retry send_message"); // uncropped title
    expect(text).toContain("event_7"); // more than 3 event lines visible
  });
});

describe("renderBoard", () => {
  it("renders the full frame with list, detail and the live pi mirror", () => {
    const frame = renderBoard(
      view({
        events: [{ ts: "21:24:11", text: "21:24:11 verdict_applied #5049 (APPROVE)", anomaly: false }],
        pi: { pr: 5012, lines: ["> reading tasks.py", "thinking…"], missing: false, stale: false, offset: 0 },
      }),
      100,
      24,
    );
    const text = frame.lines.map(stripAnsi).join("\n");
    expect(text).toContain("PRS (2)");
    expect(text).toContain("▶ #5012");
    expect(text).toContain("fix(crm)");
    expect(text).toContain("✎ #5049");
    expect(text).toContain("PI pr-5012 · live mirror · click to type");
    expect(text).toContain("> reading tasks.py");
    expect(text).toContain("1 board");
    expect(text).toContain("2 memory");
    expect(frame.lines.length).toBe(24);
    // The demoted EVENTS strip is gone until `e` asks for it.
    expect(text).not.toContain("EVENTS");
    expect(text).not.toContain("verdict_applied #5049");
  });

  it("keeps every row at the terminal width", () => {
    const frame = renderBoard(view(), 90, 24);
    for (const line of frame.lines) expect(displayWidth(line)).toBe(90);
  });

  it("keeps every row at the terminal width at 30 / 100 / 220 cols, mirror and overlay included", () => {
    const events = Array.from({ length: 20 }, (_, i) => ({ ts: `t${i}`, text: `10:00:0${i} verdict_applied #504${i % 10}`, anomaly: i % 3 === 0 }));
    const pi = {
      pr: 5012,
      lines: ["\x1b[32mgreen line that runs on and on and on past any sane pane width\x1b[0m", "plain"],
      missing: false,
      stale: false,
    };
    for (const cols of [30, 100, 220]) {
      for (const over of [{}, { eventsFocus: true }, { detailFull: true }, { piFocus: true, piPr: 5012 }, { piFocus: true, piPr: 5012, pi: { ...pi, offset: 9 } }]) {
        const frame = renderBoard(view({ events, pi, ...over }), cols, 30);
        for (const line of frame.lines) expect(displayWidth(line)).toBe(cols);
      }
    }
  });

  it("shows the tail of the capture and passes SGR colors through", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line_${i}`);
    lines[39] = "\x1b[31mlast line\x1b[0m";
    const frame = renderBoard(view({ pi: { pr: 5012, lines, missing: false, stale: false, offset: 0 } }), 100, 24);
    const raw = frame.lines.join("\n");
    expect(raw).toContain("\x1b[31mlast line");
    const text = frame.lines.map(stripAnsi).join("\n");
    expect(text).toContain("last line");
    expect(text).toContain("line_32"); // tail, not head
    expect(text).not.toContain("line_0 ");
  });

  it("falls back to a no-session line, keeping the last capture marked (stale)", () => {
    const gone = renderBoard(view({ pi: { pr: 5012, lines: [], missing: true, stale: false, offset: 0 } }), 100, 24).lines.map(stripAnsi).join("\n");
    expect(gone).toContain("no pi session for #5012");
    expect(gone).not.toContain("(stale)");

    const stale = renderBoard(view({ pi: { pr: 5012, lines: ["old output"], missing: true, stale: true, offset: 0 } }), 100, 24).lines.map(stripAnsi).join("\n");
    expect(stale).toContain("no pi session for #5012 · (stale)");
    expect(stale).toContain("old output");
  });

  it("ignores a mirror belonging to another PR (selection moved, capture in flight)", () => {
    const text = renderBoard(view({ pi: { pr: 5049, lines: ["other pr"], missing: false, stale: false, offset: 0 } }), 100, 24).lines.map(stripAnsi).join("\n");
    expect(text).toContain("PI pr-5012 · connecting…");
    expect(text).not.toContain("other pr");
  });

  it("declares the whole pane region as one focus zone (never an attach zone)", () => {
    const frame = renderBoard(view({ pi: { pr: 5012, lines: ["x"], missing: false, stale: false, offset: 0 } }), 100, 24);
    const piTop = frame.meta["piTop"]!;
    const zone = frame.zones.find((z) => (z.action as { t: string }).t === "pi-focus");
    expect(zone).toBeDefined();
    expect(zone!.y1).toBe(piTop + 1); // divider row included — the whole region
    expect(zone!.y2).toBe(piTop + frame.meta["piRows"]!);
    expect(frame.zones.some((z) => (z.action as { t: string }).t === "attach")).toBe(false);
  });

  it("accents the header and divider while the pane owns the keyboard", () => {
    const pi = { pr: 5012, lines: ["x"], missing: false, stale: false, offset: 0 };
    const frame = renderBoard(view({ pi, piFocus: true, piPr: 5012 }), 100, 24);
    const text = frame.lines.map(stripAnsi).join("\n");
    expect(text).toContain("PI pr-5012 · focused · Ctrl-q back to board");
    expect(text).not.toContain("click to type");
    expect(frame.lines[frame.meta["piTop"]!]).toContain("━"); // heavy divider cue
  });

  it("shows the scrollback offset and drops that many lines off the tail", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line_${i}`);
    const text = renderBoard(view({ pi: { pr: 5012, lines, missing: false, stale: false, offset: 6 } }), 100, 24)
      .lines.map(stripAnsi)
      .join("\n");
    expect(text).toContain("↑ 6 lines back · End live");
    expect(text).toContain("line_33"); // 39 - 6
    expect(text).not.toContain("line_34");
  });

  it("keeps painting the locked session when the pane is focused elsewhere", () => {
    const pi = { pr: 5049, lines: ["locked output"], missing: false, stale: false, offset: 0 };
    const text = renderBoard(view({ pi, piFocus: true, piPr: 5049, selected: 0 }), 100, 24)
      .lines.map(stripAnsi)
      .join("\n");
    expect(text).toContain("PI pr-5049 · focused");
    expect(text).toContain("locked output");
  });

  it("toggles the events overlay on e, with its own scroll and jump zones", () => {
    const events = Array.from({ length: 6 }, (_, i) => ({ ts: `t${i}`, text: `10:00:0${i} verdict_applied #504${i}`, anomaly: false }));
    const closed = renderBoard(view({ events }), 100, 24).lines.map(stripAnsi).join("\n");
    expect(closed).not.toContain("EVENTS");

    const frame = renderBoard(view({ events, eventsFocus: true }), 100, 24);
    const text = frame.lines.map(stripAnsi).join("\n");
    expect(text).toContain("EVENTS");
    expect(text).toContain("j/k scroll · e/Esc close");
    expect(text).toContain("verdict_applied #5040");
    expect(frame.zones.some((z) => (z.action as { t: string; pr?: number }).t === "event-jump")).toBe(true);
    // The command bar keeps its constant "e events" button while it is open.
    const wide = renderBoard(view({ events, eventsFocus: true }), 220, 24).lines.map(stripAnsi).join("\n");
    expect(wide).toContain("e events");

    const scrolled = renderBoard(view({ events, eventsFocus: true, eventsScroll: 2 }), 100, 24).lines.map(stripAnsi).join("\n");
    expect(scrolled).not.toContain("verdict_applied #5040");
    expect(scrolled).toContain("verdict_applied #5042");
  });

  it("renders the help overlay over the board", () => {
    const text = renderBoard(view({ help: true }), 100, 30).lines.map(stripAnsi).join("\n");
    expect(text).toContain("KEYS");
    expect(text).toContain("Ctrl-q");
    expect(text).not.toContain("PRS (2)");
  });

  it("renders full-height detail on w", () => {
    const text = renderBoard(view({ detailFull: true }), 100, 24).lines.map(stripAnsi).join("\n");
    expect(text).toContain("#5012");
    expect(text).toContain("w back");
    expect(text).not.toContain("EVENTS");
  });

  it("renders the quick-message input box in place of the events strip", () => {
    const text = renderBoard(view({ inputBox: { target: "#5012 (pi session pr-5012)", text: "also check" } }), 100, 24)
      .lines.map(stripAnsi)
      .join("\n");
    expect(text).toContain("MSG → #5012 (pi session pr-5012)");
    expect(text).toContain("> also check");
    expect(text).toContain("⏎ send · Esc cancel");
  });
});

describe("key decoding", () => {
  it("decodes navigation and action keys", () => {
    expect(decodeKey(Buffer.from("j"))).toEqual({ kind: "down" });
    expect(decodeKey(Buffer.from("\x1b[A"))).toEqual({ kind: "up", arrow: true });
    expect(decodeKey(Buffer.from("\r"))).toEqual({ kind: "enter" });
    expect(decodeKey(Buffer.from("q"))).toEqual({ kind: "quit" });
    expect(decodeKey(Buffer.from("\x03"))).toEqual({ kind: "quit" });
    expect(decodeKey(Buffer.from("M"))).toEqual({ kind: "main-session" });
    expect(decodeKey(Buffer.from("?"))).toEqual({ kind: "help" });
    expect(decodeKey(Buffer.from("a"))).toEqual({ kind: "attach" }); // ⏎'s twin
  });

  it("keeps printable text as chars in the input box, reserving control keys", () => {
    expect(decodeInputKey(Buffer.from("q"))).toEqual({ kind: "char", ch: "q" });
    expect(decodeInputKey(Buffer.from("\x1b\r"))).toEqual({ kind: "alt-enter" });
    expect(decodeInputKey(Buffer.from("\x7f"))).toEqual({ kind: "backspace" });
    expect(decodeInputKey(Buffer.from("\x1b"))).toEqual({ kind: "escape" });
  });
});

describe("remote argv builders", () => {
  it("reads status.json from the host state volume without docker", () => {
    expect(statusArgv(TUI_DEFAULTS)).toEqual(["cat", "/opt/quickreview/state/status.json"]);
  });

  it("runs read-only CLI calls inside the container with sudo docker", () => {
    expect(whyArgv(TUI_DEFAULTS, 5012)).toEqual(["sudo", "docker", "exec", "quickreview-sandbox", "node", "dist/src/cli.js", "why", "5012", "--json"]);
    expect(eventsArgv(TUI_DEFAULTS, 20)).toContain("--tail");
    expect(progressArgv(TUI_DEFAULTS, 5012)).toEqual(["cat", "/opt/quickreview/state/round-progress/pr-5012.json"]);
  });

  it("drops sudo when configured off", () => {
    expect(whyArgv({ ...TUI_DEFAULTS, sudo_docker: false }, 1)[0]).toBe("docker");
  });

  it("builds the interactive attach argv with -tt and -it", () => {
    expect(attachArgv(TUI_DEFAULTS, "pr-5012")).toEqual([
      "-tt", "my-vm", "sudo", "docker", "exec", "-it", "quickreview-sandbox", "tmux",
      "set-window-option", "-t", "pr-5012", "window-size", "latest", ";",
      "attach", "-t", "pr-5012",
    ]);
  });

  it("hands sizing back to the client before attaching, or attach inherits the mirror's rectangle", () => {
    // The mirror's resize-window pins the session to the board pane and flips
    // window-size to `manual` (verified on the VM). Attaching full-screen
    // without undoing that opens a small window marooned in a big terminal.
    const argv = attachArgv(TUI_DEFAULTS, "pr-5012");
    expect(argv.indexOf("set-window-option")).toBeLessThan(argv.indexOf("attach"));
    expect(argv).toContain("latest");
  });
});

describe("the mirrored pi session gets the board's real geometry", () => {
  // A tmux session the daemon created detached sits at 80×24 forever, so pi
  // wrapped its output at 80 columns however wide the board painted the
  // mirror: the text crowded into the left of the pane and a selection drawn
  // over the empty remainder picked up nothing (reported 2026-08-21).
  it("is the painted rectangle: two chrome rows off, borders and the leading space off the width", () => {
    expect(piPaneSize(100, 24)).toEqual({ cols: 96, rows: piRows(24) - 2 });
    expect(piPaneSize(200, 60)).toEqual({ cols: 196, rows: piRows(60) - 2 });
  });

  it("has no rectangle to offer when the pane is squeezed out of existence", () => {
    expect(piPaneSize(100, 6)).toBeUndefined(); // piRows floors to 0 here
    expect(piPaneSize(3, 40)).toBeUndefined();
    expect(piPaneSize(0, 0)).toBeUndefined();
  });

  it("folds resize-window into the capture, ahead of it and in one invocation", () => {
    // One invocation matters: a separate resize could land after the capture
    // and the mirror would paint a frame laid out for the previous size.
    const argv = captureArgv(TUI_DEFAULTS, "pr-5012", undefined, { cols: 96, rows: 8 });
    expect(argv.indexOf("resize-window")).toBeLessThan(argv.indexOf("capture-pane"));
    expect(argv.slice(argv.indexOf("resize-window"))).toEqual([
      "resize-window", "-t", "pr-5012", "-x", "96", "-y", "8", ";",
      "capture-pane", "-e", "-p", "-J", "-t", "pr-5012",
    ]);
  });

  it("captures exactly as before when no rectangle is known yet", () => {
    // First capture can precede the first paint; it must not invent a size.
    expect(captureArgv(TUI_DEFAULTS, "pr-5012")).not.toContain("resize-window");
  });

  it("keeps the last usable rectangle rather than sending a degenerate one", () => {
    const seen: string[][] = [];
    const ssh: SshRunner = async (_h, argv) => {
      seen.push(argv);
      return { ok: true, stdout: "pane", stderr: "", code: 0 };
    };
    const mirror = new PiMirror(TUI_DEFAULTS, ssh);
    mirror.setViewport({ cols: 96, rows: 8 });
    mirror.setViewport(undefined); // board collapsed to nothing mid-resize
    mirror.setViewport({ cols: 0, rows: 8 });
    return mirror.fetch(5012).then(() => {
      expect(seen[0]).toContain("resize-window");
      expect(seen[0]?.slice(seen[0].indexOf("-x"), seen[0].indexOf("-x") + 4)).toEqual(["-x", "96", "-y", "8"]);
    });
  });
});
