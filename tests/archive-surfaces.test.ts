// What a person sees of the archiver (docs/archiving.md §11): beside the
// `qcr status` line, the TUI board's top-bar banner and the companion's view. A reopened PR whose
// archived files no tick or birth will restore (mode not `on`) keeps its
// receipts UNKNOWN and its pre-close recheck claims standing — that must be
// on a surface, not only in a SQL count. Every reader is total over parsed
// JSON: an unreadable block is UNKNOWN, never silence and never a throw.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { archiveLine, boardAnswer } from "../extensions/tui-view.js";
import { pendingArchiveStatus, type ArchiveStatus } from "../src/archive/status.js";
import type { StatusSnapshot } from "../src/state.js";
import { archiveSegment, renderBoard, topBar, type BoardView } from "../src/tui/board.js";
import { buildTuiView } from "../src/tui/feed.js";
import { stripAnsi } from "../src/tui/paint.js";

const NOW = new Date("2026-10-21T12:00:00.000Z");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function block(over: Partial<ArchiveStatus> = {}): ArchiveStatus {
  return {
    ...pendingArchiveStatus("plan"),
    state: "plan",
    last_tick_at: NOW.toISOString(),
    plan_at: NOW.toISOString(),
    backlog: { prs: 3, bytes: 1000, event_rows: 0, delivery_rows: 0 },
    restores: { pending: 0, done: 0, failed: 0 },
    verify_failures_24h: 0,
    ...over,
  };
}

function snap(archive?: unknown): StatusSnapshot {
  return {
    written_at: NOW.toISOString(),
    dry_run: false,
    prs: [],
    running_rounds: 1,
    max_concurrent_rounds: 4,
    total_spend_usd: 0,
    today_spend_usd: 0,
    heartbeat: NOW.toISOString(),
    ...(archive !== undefined ? { archive: archive as ArchiveStatus } : {}),
  };
}

function view(archive?: unknown): BoardView {
  return {
    health: { kind: "ok", heartbeatAgeS: 2 },
    dryRun: false,
    events: [],
    selected: 0,
    eventsFocus: false,
    eventsScroll: 0,
    help: false,
    snapshot: snap(archive),
    now: NOW,
  };
}

const stranded = block({ restores: { pending: 1, done: 0, failed: 0 } });

describe("the board's archive banner", () => {
  it("a reopened PR no tick will restore (mode plan) is loud on the bar, with the verb", () => {
    const bar = stripAnsi(topBar(view(stranded), 260));
    expect(bar).toContain(
      "⛔ ARCHIVE 1 REOPENED PR(S) AWAITING RESTORE (mode plan: qcr archive restore <pr>)",
    );
    expect(stripAnsi(renderBoard(view(stranded), 260, 30).lines[0]!)).toContain("ARCHIVE");
  });

  it("held for disk, a failed restore and repeated verify failures are loud too; one banner", () => {
    const seg = stripAnsi(
      archiveSegment(
        snap(
          block({
            state: "held",
            held_reason: "disk_low",
            restores: { pending: 0, done: 2, failed: 1 },
            verify_failures_24h: 4,
          }),
        ),
      )!,
    );
    expect(seg).toBe(
      "⛔ ARCHIVE HELD: free disk below the headroom · 1 RESTORE(S) FAILED · 4 VERIFY FAILURES in 24h",
    );
  });

  it("a quiet archiver, an `on` archiver whose restore the next tick runs, an older daemon, no snapshot: nothing", () => {
    expect(archiveSegment(snap(block()))).toBeUndefined();
    expect(
      archiveSegment(snap({ ...stranded, mode: "on", state: "idle" } satisfies ArchiveStatus)),
    ).toBeUndefined();
    expect(archiveSegment(snap())).toBeUndefined();
    expect(archiveSegment(undefined)).toBeUndefined();
    expect(stripAnsi(topBar(view(block()), 260))).not.toContain("ARCHIVE");
  });

  it("a block this build cannot read is a dim `archive ?` — never nothing, never a throw out of the paint", () => {
    for (const bad of [
      null,
      "x",
      { mode: "on", state: "dreaming" },
      { ...stranded, restores: 7 },
    ]) {
      expect(stripAnsi(archiveSegment(snap(bad))!), JSON.stringify(bad)).toBe("archive ?");
      expect(() => renderBoard(view(bad), 220, 30)).not.toThrow();
    }
  });
});

describe("the companion's view", () => {
  it("view.json carries the `qcr status` line and what needs a person; null with no snapshot", () => {
    expect(buildTuiView({ now: NOW, tab: "board" }).archive).toBeNull();
    expect(buildTuiView({ now: NOW, tab: "board", snapshot: snap() }).archive).toEqual({
      line: "archive: NOT REPORTED (this daemon predates the archive block)",
      attention: [],
    });
    const v = buildTuiView({ now: NOW, tab: "board", snapshot: snap(stranded) }).archive!;
    expect(v.line).toContain("1 REOPENED PR(S) AWAITING RESTORE — mode is plan");
    expect(v.attention).toEqual([
      "1 REOPENED PR(S) AWAITING RESTORE (mode plan: qcr archive restore <pr>)",
    ]);
    expect(buildTuiView({ now: NOW, tab: "board", snapshot: snap({ mode: 1 }) }).archive).toEqual({
      line: expect.stringMatching(/^archive: UNKNOWN \(unreadable block: /),
      attention: [],
    });
  });

  it("tui_board says it — attention first — and says UNKNOWN when it cannot, never dropping the line", () => {
    expect(archiveLine(undefined)).toBe(
      "archive: UNKNOWN (this TUI build publishes no archive field)",
    );
    expect(archiveLine(null)).toMatch(/^archive: UNKNOWN \(the TUI has not been able to read it/);
    expect(archiveLine({ line: 7 })).toBe("archive: UNKNOWN (an unreadable line)");
    const dir = mkdtempSync(join(tmpdir(), "qcr-archive-view-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, "view.json"),
      JSON.stringify(buildTuiView({ now: NOW, tab: "board", snapshot: snap(stranded) })),
    );
    const answer = boardAnswer(dir, NOW);
    expect(answer).toContain(
      "archive NEEDS ATTENTION: 1 REOPENED PR(S) AWAITING RESTORE (mode plan: qcr archive restore <pr>)",
    );
    expect(answer).toContain("archive: mode plan — planning only, nothing moved");
    writeFileSync(join(dir, "view.json"), JSON.stringify(buildTuiView({ now: NOW, tab: "board" })));
    expect(boardAnswer(dir, NOW)).toContain(
      "archive: UNKNOWN (the TUI has not been able to read it",
    );
  });
});
