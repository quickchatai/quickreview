import { describe, expect, it } from "vitest";
import type { WhyPayload } from "../src/cli.js";
import type { StatusSnapshot } from "../src/state.js";
import { renderBoard, topBar, detailLines, type BoardView } from "../src/tui/board.js";
import { decodeKey, decodeInputKey } from "../src/tui/keys.js";
import { displayWidth, fit, rule, stripAnsi, truncate } from "../src/tui/paint.js";
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
    expect(lines[1]).toBe("state reviewing · round 2 · esc-worthy: no");
    expect(lines[2]).toContain("spend $1.30 · head a2e380f · trig 14:02");
    expect(lines).toContain("F1 [P1/0.9][delivery] tasks.py:88 open");
    expect(lines.find((l) => l.startsWith("ROUNDS"))).toBe("ROUNDS  r1 RC · r2 …");
    expect(lines.find((l) => l.startsWith("THREADS"))).toBe("THREADS 2 known");
  });

  it("shows a loading line until the payload matches the selection", () => {
    const lines = detailLines(undefined, snapshot.prs[0], 60).map(stripAnsi);
    expect(lines[1]).toBe("loading detail…");
  });
});

describe("renderBoard", () => {
  it("renders the full frame with list, detail and events", () => {
    const frame = renderBoard(
      view({ events: [{ ts: "21:24:11", text: "21:24:11 verdict_applied #5049 (APPROVE)", anomaly: false }] }),
      100,
      24,
    );
    const text = frame.lines.map(stripAnsi).join("\n");
    expect(text).toContain("PRS (2)");
    expect(text).toContain("▶ #5012 fix(crm)");
    expect(text).toContain("✎ #5049 feat(remote-api)");
    expect(text).toContain("EVENTS");
    expect(text).toContain("verdict_applied #5049");
    expect(text).toContain("[1]board [2]digest");
    expect(frame.lines.length).toBe(24);
  });

  it("keeps every row at the terminal width", () => {
    const frame = renderBoard(view(), 90, 24);
    for (const line of frame.lines) expect(displayWidth(line)).toBe(90);
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
