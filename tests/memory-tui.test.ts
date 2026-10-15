// A memory outage reaches a person through the TUI, from
// status.json and never from OpenViking: the board-level banner, the desktop
// notification through the existing alert pipeline, ONE issue-tracker ticket
// for an incident older than 2 h, and the companion's view. Temp dirs, fake
// fetch; no network, no daemon.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { boardAnswer, memoryLine } from "../extensions/tui-view.js";
import type { CurationStatus } from "../src/learner/status.js";
import { memoryStatusLine, type MemoryStatus } from "../src/memory/health.js";
import type { StatusSnapshot } from "../src/state.js";
import {
  maybeWriteCurationAlert,
  maybeWriteMemoryAlert,
  parseAlert,
  type AlertBadge,
} from "../src/tui/alerts.js";
import {
  alertSegment,
  alertZone,
  curationSegment,
  memorySegment,
  renderBoard,
  topBar,
  type BoardView,
} from "../src/tui/board.js";
import { buildTuiView } from "../src/tui/feed.js";
import {
  CURATION_INCIDENT_LINE,
  MEMORY_INCIDENT_LINE,
  maybeFileCurationIncident,
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

  it("a ticket it cannot read fails the attempt — an incomplete scan never authorizes another ticket", () => {
    const paths = tracker();
    const dir = join(paths.root, "efforts", "review-sandbox", "tickets");
    mkdirSync(join(dir, "FT-0500-unreadable.md")); // EISDIR on read
    const out = maybeFileMemoryIncident(paths, block(), opts());
    expect(out.kind).toBe("failed");
    expect(readdirSync(dir)).toEqual(["FT-0500-unreadable.md"]);
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

// ---- memory that answers but cannot search ----------------------------------

describe("memory that answers but does not serve search reaches every surface", () => {
  const notServing = (over: Partial<MemoryStatus> = {}): MemoryStatus =>
    block({
      state: "down",
      since: "2026-10-06T13:55:00.000Z",
      last_ok_at: "2026-10-06T14:04:00.000Z",
      credentials: {
        daemon: { result: "ok", status: 200, code: "", ms: 3, at: SINCE, source: "probe" },
        sessions: { result: "ok", status: 200, code: "", ms: 3, at: SINCE, source: "probe" },
      },
      incident: { kind: "down", since: "2026-10-06T13:55:00.000Z" },
      serving: {
        ok: false,
        since: "2026-10-06T13:45:00.000Z",
        reason: "the local embedder is unavailable — model file not found: /m.gguf",
      },
      down_cause: "not_serving",
      ...over,
    });

  it("the board banner names the cause, never `no authenticated answer`", () => {
    const seg = stripAnsi(memorySegment(snap(notServing()), NOW)!.text);
    expect(seg).toBe("⛔ MEMORY DOWN 10m · search not serving");
    const degraded = stripAnsi(
      memorySegment(
        snap(notServing({ state: "degraded", down_cause: undefined, incident: null })),
        NOW,
      )!.text,
    );
    expect(degraded).toContain("▲ MEMORY DEGRADED");
    expect(degraded).toContain("· search not serving");
    // An unanswered outage keeps its words.
    expect(
      stripAnsi(memorySegment(snap(notServing({ down_cause: "unanswered" })), NOW)!.text),
    ).toContain("no authenticated answer");
  });

  it("the tracker ticket says it is not serving, and where the embedder's block is", () => {
    const root = tempDir("qcr-tracker-");
    mkdirSync(join(root, ".ids"), { recursive: true });
    writeFileSync(join(root, ".ids", "0545"), "x\n");
    mkdirSync(join(root, "efforts", "review-sandbox", "tickets"), { recursive: true });
    const paths = { root, effort: "review-sandbox", parent: "FT-0026" };
    const later = new Date(Date.parse("2026-10-06T13:55:00.000Z") + 3 * HOURS);
    const out = maybeFileMemoryIncident(paths, notServing(), {
      fresh: true,
      now: later,
      afterMs: 2 * HOURS,
      memo: newIncidentFilerMemo(),
    });
    expect(out).toMatchObject({ kind: "filed" });
    const dir = join(root, "efforts", "review-sandbox", "tickets");
    const body = readFileSync(join(dir, readdirSync(dir)[0]!), "utf8");
    expect(body).toContain(
      "- serving search: NO since 2026-10-06T13:45:00.000Z — the local embedder is unavailable",
    );
    expect(body).toMatch(/its `embedder` block — the local English embedder/);
  });

  it("the companion's line and the alert body carry the reason", () => {
    const line = memoryLine(notServing());
    expect(line).toContain("NOT serving search since 2026-10-06T13:45:00.000Z");
    expect(line).toContain("the local embedder is unavailable");
    const dir = tempDir("qcr-memalert-");
    const name = maybeWriteMemoryAlert(dir, notServing(), true, { lastWritten: "" }, () => NOW)!;
    const alert = JSON.parse(readFileSync(join(dir, name), "utf8")) as { body: string };
    expect(alert.body).toContain("answers, but has not served search");
    expect(alert.body).toContain("the local embedder is unavailable");
  });

  it("a block from a daemon that predates the check says so — never `yes`", () => {
    const { serving: _s, down_cause: _d, ...old } = notServing({ state: "down" });
    const root = tempDir("qcr-tracker-");
    mkdirSync(join(root, ".ids"), { recursive: true });
    writeFileSync(join(root, ".ids", "0545"), "x\n");
    mkdirSync(join(root, "efforts", "review-sandbox", "tickets"), { recursive: true });
    maybeFileMemoryIncident({ root, effort: "review-sandbox", parent: "FT-0026" }, old, {
      fresh: true,
      now: new Date(Date.parse("2026-10-06T13:55:00.000Z") + 3 * HOURS),
      afterMs: 2 * HOURS,
      memo: newIncidentFilerMemo(),
    });
    const dir = join(root, "efforts", "review-sandbox", "tickets");
    expect(readFileSync(join(dir, readdirSync(dir)[0]!), "utf8")).toContain(
      "- serving search: not reported (this daemon predates the serving check)",
    );
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

// ---- the day's EOD curation reaches a person the same way -------------------

describe("the EOD curation (status.json memory.curation) reaches a person", () => {
  const curation = (over: Partial<CurationStatus> = {}): CurationStatus => ({
    day: "2026-10-06",
    state: "missing",
    offered: 4,
    adopted: 0,
    declined: 0,
    verifying: 0,
    not_persisted: 0,
    expired_today: 0,
    open: 4,
    queued: 2,
    receipt_at: null,
    balance: {
      look_for: 1,
      dont_raise: 9,
      repo_fact: 0,
      convention: 0,
      unknown: 0,
      ratio: 0.11,
      typed: 3,
      as_of: SINCE,
    },
    ...over,
  });
  const healthy = (c: CurationStatus | null | undefined) =>
    block({
      state: "healthy",
      incident: null,
      last_error: null,
      ...(c === undefined ? {} : { curation: c }),
    });

  it("the board paints a missing receipt and unpersisted lessons loud — and nothing for a quiet day", () => {
    expect(stripAnsi(curationSegment(snap(healthy(curation())))!)).toBe(
      "⛔ EOD CURATION MISSING 2026-10-06 · 4 candidates, no receipt",
    );
    expect(
      stripAnsi(
        curationSegment(snap(healthy(curation({ state: "not_persisted", not_persisted: 2 }))))!,
      ),
    ).toBe("⛔ LESSONS NOT PERSISTED 2026-10-06 · 2");
    for (const quiet of ["received", "awaiting", "nothing", "no_packet", "packet_ready"] as const)
      expect(curationSegment(snap(healthy(curation({ state: quiet }))))).toBeUndefined();
    // Unread is UNKNOWN, never quiet (honest-unknown); a daemon that reports
    // no block at all (memory off, an older daemon) paints nothing.
    expect(stripAnsi(curationSegment(snap(healthy(null)))!)).toBe("curation ?");
    expect(stripAnsi(topBar(view(healthy(null)), 220))).toContain("curation ?");
    expect(curationSegment(snap(healthy(undefined)))).toBeUndefined();
    const bar = stripAnsi(topBar(view(healthy(curation())), 220));
    expect(bar).toContain("EOD CURATION MISSING");
    expect(bar.indexOf("EOD CURATION MISSING")).toBeLessThan(bar.indexOf("rounds"));
  });

  it("one desktop notification per (state, day), fresh snapshots only, re-armed by recovery", () => {
    const dir = tempDir("qcr-curalert-");
    const mem = { lastWritten: "" };
    const name = maybeWriteCurationAlert(dir, healthy(curation()), true, mem, () => NOW)!;
    expect(name).toMatch(/eod-curation-missing\.json$/);
    const parsed = parseAlert(readFileSync(join(dir, name), "utf8"), name, () => NOW);
    expect(parsed.ok && parsed.alert.cause).toBe("eod-curation-missing");
    expect(maybeWriteCurationAlert(dir, healthy(curation()), true, mem, () => NOW)).toBeUndefined();
    expect(
      maybeWriteCurationAlert(
        dir,
        healthy(curation({ state: "not_persisted", not_persisted: 1 })),
        true,
        mem,
        () => NOW,
      ),
    ).toMatch(/eod-lessons-not-persisted\.json$/);
    expect(
      maybeWriteCurationAlert(dir, healthy(curation({ state: "received" })), true, mem, () => NOW),
    ).toBeUndefined();
    expect(
      maybeWriteCurationAlert(dir, healthy(curation()), false, mem, () => NOW),
    ).toBeUndefined();
    expect(maybeWriteCurationAlert(dir, healthy(curation()), true, mem, () => NOW)).toBeDefined();
  });

  it("an older unresolved day rides beside the newest — on the board and in qcr status", () => {
    const c = curation({
      day: "2026-10-07",
      unresolved: [
        { day: "2026-10-07", state: "missing", count: 4, since: SINCE },
        { day: "2026-10-06", state: "missing", count: 3, since: SINCE },
      ],
    });
    expect(stripAnsi(curationSegment(snap(healthy(c)))!)).toBe(
      "⛔ EOD CURATION MISSING 2026-10-07 · 4 candidates, no receipt (+1 earlier unresolved day)",
    );
    expect(memoryStatusLine(healthy(c), NOW)).toContain(
      "EOD CURATION MISSING for 2026-10-07 (4 candidates, no receipt) (+1 earlier unresolved day)",
    );
    expect(memoryLine(healthy(c))).toContain(
      "EOD CURATION MISSING for 2026-10-07 (4 candidates, no receipt) (+1 earlier unresolved day)",
    );
  });

  it("ONE tracker ticket per curation incident older than 2 h — keyed by its oldest unresolved day", () => {
    const root = tempDir("qcr-tracker-");
    mkdirSync(join(root, ".ids"), { recursive: true });
    writeFileSync(join(root, ".ids", "0545"), "x\n");
    const dir = join(root, "efforts", "review-sandbox", "tickets");
    mkdirSync(dir, { recursive: true });
    const paths = { root, effort: "review-sandbox", parent: "FT-0026" };
    const incident = { day: "2026-10-05", state: "missing" as const, count: 3, since: SINCE };
    const c = curation({
      unresolved: [{ day: "2026-10-06", state: "missing", count: 4, since: SINCE }, incident],
      incident,
    });
    const opts = (now: Date, memo = newIncidentFilerMemo()) => ({
      fresh: true,
      now,
      afterMs: 2 * HOURS,
      memo,
    });
    expect(
      maybeFileCurationIncident(paths, healthy(c), opts(new Date(Date.parse(SINCE) + HOURS))),
    ).toEqual({ kind: "none" });
    const memo = newIncidentFilerMemo();
    const out = maybeFileCurationIncident(paths, healthy(c), opts(NOW, memo));
    expect(out).toMatchObject({ kind: "filed", ticketId: "FT-0546" });
    const files = readdirSync(dir);
    expect(files).toEqual(["FT-0546-eod-curation-missing.md"]);
    const body = readFileSync(join(dir, files[0]!), "utf8");
    expect(body).toContain(`${CURATION_INCIDENT_LINE} missing 2026-10-05`);
    expect(body).toContain("by qcr-tui");
    expect(body).toContain("2026-10-06 missing (4");
    expect(body).toContain("state/eod/2026-10-05/outcomes.md");
    // The same incident (a restart, another poll) is never filed twice…
    expect(maybeFileCurationIncident(paths, healthy(c), opts(NOW, memo)).kind).toBe("already");
    expect(maybeFileCurationIncident(paths, healthy(c), opts(NOW)).kind).toBe("already");
    // …nor from stale data, nor with nothing unresolved, nor beside the memory ticket.
    expect(maybeFileCurationIncident(paths, healthy(c), { ...opts(NOW), fresh: false })).toEqual({
      kind: "none",
    });
    expect(
      maybeFileCurationIncident(
        paths,
        healthy(curation({ unresolved: [], incident: null })),
        opts(NOW),
      ),
    ).toEqual({ kind: "none" });
    expect(readdirSync(dir)).toHaveLength(1);
    // A new incident (another oldest day) is a new ticket.
    const next = { day: "2026-10-09", state: "not_persisted" as const, count: 1, since: SINCE };
    expect(
      maybeFileCurationIncident(
        paths,
        healthy(curation({ state: "not_persisted", unresolved: [next], incident: next })),
        opts(NOW),
      ),
    ).toMatchObject({ kind: "filed", file: "FT-0547-eod-curation-lessons-not-persisted.md" });
  });

  it("qcr status and the companion's view say it — UNKNOWN when unread, the balance beside it", () => {
    expect(memoryStatusLine(healthy(curation()), NOW)).toContain(
      "EOD CURATION MISSING for 2026-10-06 (4 candidates, no receipt); lessons look-for:dont-raise 1:9",
    );
    expect(memoryStatusLine(healthy(null), NOW)).toContain("EOD curation UNKNOWN");
    expect(memoryStatusLine(healthy(undefined), NOW)).not.toContain("EOD");
    expect(memoryLine(healthy(curation({ state: "not_persisted", not_persisted: 3 })))).toContain(
      "EOD LESSONS NOT PERSISTED for 2026-10-06 (3); lessons look-for:dont-raise 1:9",
    );
    expect(memoryLine(healthy(null))).toContain("EOD curation UNKNOWN");
  });
});
