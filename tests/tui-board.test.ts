import { describe, expect, it } from "vitest";
import type { WhyPayload } from "../src/cli.js";
import type { StatusSnapshot } from "../src/state.js";
import { renderBoard, topBar, detailLines, type BoardView } from "../src/tui/board.js";
import { decodeKey, decodeInputKey } from "../src/tui/keys.js";
import { displayWidth, fit, rule, sanitizeText, stripAnsi, truncate, wrap } from "../src/tui/paint.js";
import { statusArgv, whyArgv, eventsArgv, attachArgv } from "../src/tui/remote.js";
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
    expect(bar).toContain("\x1b[41m"); // red background
  });
});

describe("detailLines", () => {
  const why: WhyPayload = {
    pr: 5012,
    known: true,
    state: "reviewing",
    title: "fix(crm): retry send_message",
    head_sha: "a2e380ff11",
    escalation_worthy: false,
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
    expect(lines[1]).toBe("reviewing · round 2 · esc-worthy: no");
    expect(lines[2]).toContain("spend $1.30 · head a2e380f · trig");
    expect(lines).toContain("F1 [P1/0.9][delivery] tasks.py:88 open");
    expect(lines.find((l) => l.startsWith("ROUNDS"))).toContain("r1 RC · r2 …");
    expect(lines.find((l) => l.startsWith("THREADS"))).toContain("2 known");
  });

  it("shows a loading line until the payload matches the selection", () => {
    const lines = detailLines(undefined, snapshot.prs[0], 60).map(stripAnsi);
    expect(lines[1]).toBe("loading detail…");
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
    escalation_worthy: false,
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
    expect(piRows(11)).toBe(5); // squeezed: body keeps 3 rows
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
    expect(text).toContain("2 digest");
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
    // Footer hint flips while it is open (visible once the bar has room).
    const wide = renderBoard(view({ events, eventsFocus: true }), 220, 24).lines.map(stripAnsi).join("\n");
    expect(wide).toContain("close events");

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
  });

  it("drops sudo when configured off", () => {
    expect(whyArgv({ ...TUI_DEFAULTS, sudo_docker: false }, 1)[0]).toBe("docker");
  });

  it("builds the interactive attach argv with -tt and -it", () => {
    expect(attachArgv(TUI_DEFAULTS, "pr-5012")).toEqual([
      "-tt", "my-vm", "sudo", "docker", "exec", "-it", "quickreview-sandbox", "tmux", "attach", "-t", "pr-5012",
    ]);
  });
});
