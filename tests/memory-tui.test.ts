// FT-0546 S1 — a memory outage REACHES A PERSON through the TUI, from
// status.json and never from OpenViking: the board-level banner, the desktop
// notification through the existing alert pipeline, ONE issue-tracker ticket
// for an incident older than 2 h, and the companion's view. Temp dirs, fake
// fetch; no network, no daemon.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { boardAnswer, memoryLine } from "../extensions/tui-view.js";
import type { MemoryStatus } from "../src/memory/health.js";
import type { StatusSnapshot } from "../src/state.js";
import { maybeWriteMemoryAlert, parseAlert, type AlertBadge } from "../src/tui/alerts.js";
import {
  alertSegment,
  alertZone,
  memorySegment,
  renderBoard,
  topBar,
  type BoardView,
} from "../src/tui/board.js";
import { buildTuiView } from "../src/tui/feed.js";
import {
  MEMORY_INCIDENT_LINE,
  maybeFileMemoryIncident,
  newIncidentFilerMemo,
} from "../src/tui/memincident.js";
import { TuiMemoryStore } from "../src/tui/memory.js";
import { sliceDisplay, stripAnsi } from "../src/tui/paint.js";

const NOW = new Date("2026-10-06T14:05:00.000Z");
const SINCE = "2026-10-06T12:00:00.000Z";
const HOURS = 3_600_000;

function block(over: Partial<MemoryStatus> = {}): MemoryStatus {
  return {
    enabled: true,
    state: "auth_failed",
    since: SINCE,
    last_ok_at: null,
    last_error: {
      at: SINCE,
      op: "probe:daemon",
      status: 401,
      code: "UNAUTHENTICATED",
      message: "Invalid API Key",
    },
    last_probe_at: "2026-10-06T14:04:00.000Z",
    probe_ms: 4,
    credentials: {
      daemon: {
        result: "auth_failed",
        status: 401,
        code: "UNAUTHENTICATED",
        ms: 4,
        detail: "Invalid API Key",
        at: SINCE,
        source: "probe",
      },
      sessions: { result: "ok", status: 200, code: "", ms: 3, at: SINCE, source: "probe" },
    },
    requests: {
      probe: { total: 63, ok: 0, absent: 0, conflict: 0, auth_failed: 63, failed: 0 },
    },
    gaps: {},
    incident: { kind: "auth_failed", since: SINCE },
    provision: { state: "ok", created: [], errors: [] },
    ...over,
  };
}

function snap(memory?: MemoryStatus): StatusSnapshot {
  return {
    written_at: NOW.toISOString(),
    dry_run: false,
    prs: [],
    running_rounds: 0,
    max_concurrent_rounds: 4,
    total_spend_usd: 0,
    today_spend_usd: 1.5,
    heartbeat: NOW.toISOString(),
    ...(memory ? { memory } : {}),
  };
}

function view(memory?: MemoryStatus, over: Partial<BoardView> = {}): BoardView {
  return {
    health: { kind: "ok", heartbeatAgeS: 2 },
    dryRun: false,
    events: [],
    selected: 0,
    eventsFocus: false,
    eventsScroll: 0,
    help: false,
    snapshot: snap(memory),
    now: NOW,
    ...over,
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

// ---- the board banner --------------------------------------------------------

describe("the board-level memory banner (from status.json)", () => {
  it("an auth failure is loud, right after the daemon health, with its age and which key", () => {
    const bar = stripAnsi(topBar(view(block()), 200));
    expect(bar).toContain("⛔ MEMORY AUTH FAILED 2h05m · daemon key refused");
    expect(bar.indexOf("MEMORY AUTH FAILED")).toBeGreaterThan(bar.indexOf("daemon ok"));
    expect(bar.indexOf("MEMORY AUTH FAILED")).toBeLessThan(bar.indexOf("rounds"));
  });

  it("names the sessions' key, or both", () => {
    const sess = block({
      credentials: {
        daemon: { result: "ok", status: 200, code: "", ms: 1, at: SINCE, source: "probe" },
        sessions: {
          result: "no_key",
          status: 0,
          code: "no_key",
          ms: 0,
          at: SINCE,
          source: "probe",
        },
      },
    });
    expect(stripAnsi(topBar(view(sess), 200))).toContain("sessions' key refused");
    const both = block({
      credentials: {
        daemon: block().credentials.daemon,
        sessions: {
          result: "auth_failed",
          status: 401,
          code: "X",
          ms: 0,
          at: SINCE,
          source: "probe",
        },
      },
    });
    expect(stripAnsi(topBar(view(both), 200))).toContain("both keys refused");
  });

  it("down and degraded are loud too", () => {
    expect(
      stripAnsi(
        topBar(view(block({ state: "down", incident: { kind: "down", since: SINCE } })), 200),
      ),
    ).toContain("⛔ MEMORY DOWN 2h05m · no authenticated answer");
    expect(
      stripAnsi(
        topBar(
          view(block({ state: "degraded", since: "2026-10-06T14:00:00.000Z", incident: null })),
          200,
        ),
      ),
    ).toContain("▲ MEMORY DEGRADED 5m");
  });

  it("healthy paints nothing — and unknown or unreported is never painted healthy", () => {
    expect(memorySegment(snap(block({ state: "healthy", incident: null })), NOW)).toBeUndefined();
    // Unknown and an older daemon's missing block: a short dim mark, at the END.
    for (const m of [block({ state: "unknown", incident: null }), undefined]) {
      const seg = memorySegment(snap(m), NOW)!;
      expect(seg.loud).toBe(false);
      expect(stripAnsi(seg.text)).toBe("mem ?");
      const bar = stripAnsi(topBar(view(m), 200));
      expect(bar.indexOf("mem ?")).toBeGreaterThan(bar.indexOf("today"));
    }
    expect(stripAnsi(memorySegment(snap({ ...block(), enabled: false }), NOW)!.text)).toBe(
      "mem off",
    );
    // No snapshot at all: the board already says it knows nothing.
    expect(memorySegment(undefined, NOW)).toBeUndefined();
  });

  it("the quiet mark never shifts the alert badge's click zone", () => {
    const badge: AlertBadge = {
      count: 1,
      folds: 0,
      latest: { tier: "alert", title: "x overdue", cause: "c", pr: 1, ts: "t" },
    };
    for (const m of [undefined, block()]) {
      const v = view(m, { alerts: badge });
      const zone = alertZone(v, 220)!;
      // Zones are DISPLAY columns (the loud banner's ⛔ is two cells wide).
      const bar = stripAnsi(topBar(v, 220));
      expect(sliceDisplay(bar, zone.x1 - 1, zone.x2)).toBe(stripAnsi(alertSegment(badge, false)));
    }
  });

  it("is on the board's first line — outside the memory tab", () => {
    const frame = renderBoard(view(block()), 200, 30);
    expect(stripAnsi(frame.lines[0]!)).toContain("MEMORY AUTH FAILED");
  });
});

// ---- the desktop notification ------------------------------------------------

describe("the desktop notification (the existing alert pipeline)", () => {
  it("writes ONE alert-tier file per transition into auth_failed/down", () => {
    const dir = tempDir("qcr-memalert-");
    const mem = { lastWritten: "" };
    const name = maybeWriteMemoryAlert(dir, block(), true, mem, () => NOW)!;
    expect(name).toMatch(/memory-auth-failed\.json$/);
    const parsed = parseAlert(readFileSync(join(dir, name), "utf8"), name, () => NOW);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.alert.tier).toBe("alert");
      expect(parsed.alert.cause).toBe("memory-auth-failed");
      expect(parsed.alert.body).toContain("memory: AUTH FAILED for 2h05m");
    }
    // Every later poll of the same transition writes nothing.
    expect(maybeWriteMemoryAlert(dir, block(), true, mem, () => NOW)).toBeUndefined();
    expect(readdirSync(dir)).toHaveLength(1);
    // A new transition (down) notifies again.
    const down = block({ state: "down", since: "2026-10-06T14:00:00.000Z" });
    expect(maybeWriteMemoryAlert(dir, down, true, mem, () => NOW)).toMatch(/memory-down\.json$/);
  });

  it("recovery re-arms it", () => {
    const dir = tempDir("qcr-memalert-");
    const mem = { lastWritten: "" };
    maybeWriteMemoryAlert(dir, block(), true, mem, () => NOW);
    maybeWriteMemoryAlert(dir, block({ state: "healthy", incident: null }), true, mem, () => NOW);
    expect(maybeWriteMemoryAlert(dir, block(), true, mem, () => NOW)).toBeDefined();
  });

  it("never from stale data, a healthy or degraded block, or no block", () => {
    const dir = tempDir("qcr-memalert-");
    const mem = { lastWritten: "" };
    expect(maybeWriteMemoryAlert(dir, block(), false, mem, () => NOW)).toBeUndefined();
    expect(
      maybeWriteMemoryAlert(dir, block({ state: "degraded" }), true, mem, () => NOW),
    ).toBeUndefined();
    expect(maybeWriteMemoryAlert(dir, undefined, true, mem, () => NOW)).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);
  });
});

// ---- the tracker ticket ------------------------------------------------------

describe("ONE issue-tracker ticket per incident older than 2 h", () => {
  function tracker() {
    const root = tempDir("qcr-tracker-");
    mkdirSync(join(root, ".ids"), { recursive: true });
    writeFileSync(join(root, ".ids", "0545"), "x\n");
    mkdirSync(join(root, "efforts", "review-sandbox", "tickets"), { recursive: true });
    return { root, effort: "review-sandbox", parent: "FT-0026" };
  }
  const opts = (memo = newIncidentFilerMemo(), now = NOW) => ({
    fresh: true,
    now,
    afterMs: 2 * HOURS,
    memo,
  });

  it("files nothing before the incident is 2 h old", () => {
    const paths = tracker();
    const early = new Date(Date.parse(SINCE) + 2 * HOURS - 1);
    expect(maybeFileMemoryIncident(paths, block(), opts(undefined, early))).toEqual({
      kind: "none",
    });
    expect(readdirSync(join(paths.root, "efforts", "review-sandbox", "tickets"))).toEqual([]);
  });

  it("files once past it — from status.json, as qcr-tui, deduped by the incident's start", () => {
    const paths = tracker();
    const memo = newIncidentFilerMemo();
    const out = maybeFileMemoryIncident(paths, block(), opts(memo));
    expect(out).toMatchObject({ kind: "filed", ticketId: "FT-0546" });
    const dir = join(paths.root, "efforts", "review-sandbox", "tickets");
    const files = readdirSync(dir);
    expect(files).toEqual(["FT-0546-reviewer-memory-auth-failed.md"]);
    const body = readFileSync(join(dir, files[0]!), "utf8");
    expect(body).toContain("Id: FT-0546");
    expect(body).toContain("Effort: review-sandbox");
    expect(body).toContain("Parent: FT-0026");
    expect(body).toContain("by qcr-tui");
    expect(body).toContain(`${MEMORY_INCIDENT_LINE} ${SINCE}`);
    expect(body).toContain("daemon key: auth_failed (401 UNAUTHENTICATED: Invalid API Key)");
    expect(body).toContain("sessions' ovcli.conf: ok");
    expect(body).toContain("probe 0/63 ok, 63 auth");

    // Every later poll: nothing new (this process remembers)…
    expect(maybeFileMemoryIncident(paths, block(), opts(memo))).toEqual({
      kind: "already",
      key: SINCE,
    });
    // …a fresh process (a TUI restart) finds the ticket by its line…
    expect(maybeFileMemoryIncident(paths, block(), opts())).toEqual({
      kind: "already",
      key: SINCE,
    });
    // …and an incident whose KIND changed is the same incident.
    const nowDown = block({ state: "down", incident: { kind: "down", since: SINCE } });
    expect(maybeFileMemoryIncident(paths, nowDown, opts())).toEqual({
      kind: "already",
      key: SINCE,
    });
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it("a NEW incident (a new start) files a new ticket", () => {
    const paths = tracker();
    maybeFileMemoryIncident(paths, block(), opts());
    const later = "2026-10-07T08:00:00.000Z";
    const second = block({ since: later, incident: { kind: "down", since: later }, state: "down" });
    expect(
      maybeFileMemoryIncident(
        paths,
        second,
        opts(undefined, new Date(Date.parse(later) + 3 * HOURS)),
      ),
    ).toMatchObject({ kind: "filed", ticketId: "FT-0547" });
  });

  it("never from stale data, a healthy block, or an incident it cannot date", () => {
    const paths = tracker();
    expect(maybeFileMemoryIncident(paths, block(), { ...opts(), fresh: false })).toEqual({
      kind: "none",
    });
    expect(
      maybeFileMemoryIncident(paths, block({ state: "healthy", incident: null }), opts()),
    ).toEqual({
      kind: "none",
    });
    expect(maybeFileMemoryIncident(paths, block({ incident: null }), opts())).toEqual({
      kind: "none",
    });
    expect(maybeFileMemoryIncident(paths, undefined, opts())).toEqual({ kind: "none" });
  });

  it("with no issue tracker configured it files nothing and says so ONCE", () => {
    const memo = newIncidentFilerMemo();
    const first = maybeFileMemoryIncident(undefined, block(), opts(memo));
    expect(first.kind).toBe("no-tracker");
    expect(maybeFileMemoryIncident(undefined, block(), opts(memo))).toEqual({ kind: "none" });
  });

  it("a broken tracker is a failed outcome, never a throw — retried every 5 min, not every poll", () => {
    const root = tempDir("qcr-tracker-");
    const paths = { root, effort: "e", parent: "FT-1" };
    const memo = newIncidentFilerMemo();
    // No `.ids/`: the id claim cannot run.
    expect(maybeFileMemoryIncident(paths, block(), opts(memo)).kind).toBe("failed");
    expect(
      maybeFileMemoryIncident(paths, block(), opts(memo, new Date(NOW.getTime() + 3000))),
    ).toEqual({
      kind: "none",
    });
    // Fixed tracker, five minutes on: it files.
    mkdirSync(join(root, ".ids"), { recursive: true });
    expect(
      maybeFileMemoryIncident(paths, block(), opts(memo, new Date(NOW.getTime() + 5 * 60_000)))
        .kind,
    ).toBe("filed");
  });
});

// ---- the companion's view ----------------------------------------------------

describe("the companion's view.json carries the block (null when unread)", () => {
  it("null with no snapshot, null for a daemon that reports no block, the block otherwise", () => {
    expect(buildTuiView({ now: NOW, tab: "board" }).memory).toBeNull();
    expect(buildTuiView({ now: NOW, tab: "board", snapshot: snap() }).memory).toBeNull();
    const b = block();
    const v = buildTuiView({
      now: NOW,
      tab: "board",
      snapshot: snap(b),
      tuiMemoryRequests: {
        "reviewer/ls": { total: 2, ok: 2, absent: 0, conflict: 0, auth_failed: 0, failed: 0 },
      },
    });
    expect(v.memory).toEqual(b);
    expect(v.memory_tui_requests).toEqual({
      "reviewer/ls": { total: 2, ok: 2, absent: 0, conflict: 0, auth_failed: 0, failed: 0 },
    });
  });

  it("the tui_board answer says UNKNOWN for a null block — never drops the line", () => {
    expect(memoryLine(null)).toMatch(/^reviewer memory: UNKNOWN/);
    expect(memoryLine(undefined)).toMatch(/^reviewer memory: UNKNOWN/);
    const line = memoryLine(block());
    expect(line).toContain("reviewer memory: AUTH_FAILED since 2026-10-06T12:00:00.000Z");
    expect(line).toContain("incident (auth_failed) open since 2026-10-06T12:00:00.000Z");
    expect(line).toContain("daemon key auth_failed 401 UNAUTHENTICATED");
    expect(line).toContain("sessions' key ok");

    const dir = tempDir("qcr-feed-");
    writeFileSync(
      join(dir, "view.json"),
      JSON.stringify(buildTuiView({ now: NOW, tab: "board", snapshot: snap() })),
    );
    expect(boardAnswer(dir, NOW)).toContain("reviewer memory: UNKNOWN");
  });
});

// ---- the TUI counts its own requests -----------------------------------------

describe("the TUI counts its own OpenViking requests per user/op", () => {
  it("counts every request its store makes, success and failure", async () => {
    let status = 200;
    const store = new TuiMemoryStore({
      baseUrl: "http://127.0.0.1:19330",
      key: () => "a-user-key-0123456789",
      fetchFn: async () => ({
        ok: status === 200,
        status,
        text: async () =>
          status === 200
            ? JSON.stringify({ status: "ok", result: [] })
            : JSON.stringify({
                status: "error",
                error: { code: "UNAUTHENTICATED", message: "Invalid API Key" },
              }),
      }),
    });
    await store.read();
    status = 401;
    await store.read();
    const counts = store.requestCounts();
    expect(counts["reviewer/ls"]).toMatchObject({ total: 2, ok: 1, auth_failed: 1 });
    expect(counts["companion/ls"]).toMatchObject({ total: 2, ok: 1, auth_failed: 1 });
  });
});
