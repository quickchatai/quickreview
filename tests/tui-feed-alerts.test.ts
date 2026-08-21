// Slice C2: ambient feed writer, alert pipeline, companion surfaces.
// I/O is a temp dir per test; nothing spawns docker, notify-send, ssh or pi.
import { FG } from "../src/tui/theme.js";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMPANION_DEFAULTS, TUI_DEFAULTS, resolveCompanionPaths } from "../src/config.js";
import type { StatusSnapshot } from "../src/state.js";
import { App } from "../src/tui/app.js";
import {
  AlertConsumer,
  AlertPolicy,
  overseerMessage,
  parseAlert,
  statusLine,
  type AlertBadge,
  type AlertRecord,
  type AlertSinks,
} from "../src/tui/alerts.js";
import { alertSegment, alertZone, topBar, renderBoard, type BoardView } from "../src/tui/board.js";
import { CompanionLifecycle, type DockerRunner } from "../src/tui/companion.js";
import { installCompanionTabHooks } from "../src/tui/companiontab.js";
import { EVENT_TAIL_CAP, FeedWriter, eventKey, type FeedEvent } from "../src/tui/feed.js";
import { stripAnsi } from "../src/tui/paint.js";
import { CompanionSidebar } from "../src/tui/sidebar.js";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-c2-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function snap(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    written_at: "2026-08-14T10:00:00Z",
    dry_run: true,
    prs: [{ number: 5012, state: "reviewing", title: "t", head_sha: "abc", stale_recheck: false, rounds: 1, last_verdict: null }],
    running_rounds: 1,
    total_spend_usd: 1,
    heartbeat: "2026-08-14T10:00:00Z",
    ...overrides,
  };
}

const ev = (ts: string, kind = "dispatch", pr: number | null = 5012): FeedEvent => ({ ts, kind, pr, payload: null });

// ---- feed writer ------------------------------------------------------------

describe("FeedWriter", () => {
  it("writes the snapshot verbatim and atomically (no .tmp left behind)", () => {
    const w = new FeedWriter(dir);
    const s = snap();
    w.write(s, [], "ok");
    expect(JSON.parse(readFileSync(w.snapshotPath, "utf8"))).toEqual(s);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("appends only new events, dedup by ts+kind+pr", () => {
    const w = new FeedWriter(dir);
    w.write(snap(), [ev("2026-08-14T10:00:00Z"), ev("2026-08-14T10:00:01Z", "verdict")], "ok");
    const second = w.write(snap(), [ev("2026-08-14T10:00:01Z", "verdict"), ev("2026-08-14T10:00:00Z"), ev("2026-08-14T10:00:02Z", "verdict")], "ok");
    expect(second.appended).toBe(1);
    const lines = readFileSync(w.eventsPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(new Set(lines.map((l) => eventKey(JSON.parse(l) as FeedEvent))).size).toBe(3);
  });

  it("seeds its seen-set from an existing tail, so a TUI restart re-appends nothing", () => {
    const first = new FeedWriter(dir);
    first.write(snap(), [ev("2026-08-14T10:00:00Z")], "ok");
    const restarted = new FeedWriter(dir);
    const res = restarted.write(snap(), [ev("2026-08-14T10:00:00Z")], "ok");
    expect(res.appended).toBe(0);
    expect(readFileSync(restarted.eventsPath, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("stores state changes and events without ever creating a chat wake", () => {
    const w = new FeedWriter(dir);
    // Remove a marker left by the retired implementation; start() must clean it.
    writeFileSync(join(dir, "wake"), "legacy");
    w.write(snap(), [], "ok");
    w.write(
      snap({ prs: [{ number: 5012, state: "awaiting_author", title: "t", head_sha: "abc", stale_recheck: false, rounds: 1, last_verdict: "REQUEST_CHANGES" }] }),
      [ev("2026-08-14T10:01:00Z")],
      "stale",
    );
    expect(readdirSync(dir)).not.toContain("wake");
    expect(readFileSync(w.eventsPath, "utf8")).toContain("2026-08-14T10:01:00Z");
  });

  it("bounds an old event journal as short-term state", () => {
    const lines = Array.from({ length: EVENT_TAIL_CAP + 1 }, (_, i) => JSON.stringify(ev(`2026-08-14T10:${String(i).padStart(6, "0")}Z`)));
    writeFileSync(join(dir, "events.jsonl"), lines.join("\n") + "\n");
    const w = new FeedWriter(dir);
    w.start();
    expect(readFileSync(w.eventsPath, "utf8").trim().split("\n")).toHaveLength(EVENT_TAIL_CAP / 2);
  });
});

// ---- alert schema -----------------------------------------------------------

describe("alert schema", () => {
  const body = (o: Record<string, unknown>): string => JSON.stringify(o);

  it("parses the prompt's exact schema", () => {
    const r = parseAlert(body({ tier: "alert", cause: "round-overdue", pr: 5012, title: "round 3 overdue", body: "40m past deadline", ts: "2026-08-14T12:00:00Z" }), "a.json");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.alert).toMatchObject({ tier: "alert", cause: "round-overdue", pr: 5012, file: "a.json" });
  });

  it("coerces a digit-string pr and accepts pr: null", () => {
    const r = parseAlert(body({ tier: "notice", cause: "c", pr: "5012", title: "t" }), "a.json");
    expect(r.ok && r.alert.pr).toBe(5012);
    const n = parseAlert(body({ tier: "notice", cause: "c", pr: null, title: "t" }), "a.json");
    expect(n.ok && n.alert.pr).toBe(null);
  });

  it("rejects every off-schema shape with a reason", () => {
    expect(parseAlert("{not json", "a.json")).toMatchObject({ ok: false });
    expect(parseAlert(body({ tier: "URGENT", cause: "c", title: "t" }), "a.json")).toMatchObject({ ok: false, error: expect.stringContaining("tier") });
    expect(parseAlert(body({ tier: "alert", cause: "", title: "t" }), "a.json")).toMatchObject({ ok: false, error: expect.stringContaining("cause") });
    expect(parseAlert(body({ tier: "alert", cause: "c" }), "a.json")).toMatchObject({ ok: false, error: expect.stringContaining("title") });
    expect(parseAlert(body({ tier: "alert", cause: "c", title: "t", pr: "not-a-number" }), "a.json")).toMatchObject({ ok: false, error: expect.stringContaining("pr") });
  });

  it("trims an over-long title rather than dropping the alert", () => {
    const r = parseAlert(body({ tier: "notice", cause: "c", title: "x".repeat(120) }), "a.json");
    expect(r.ok && r.alert.title.length).toBe(60);
  });
});

// ---- policy: cooldown, fold, escalation ------------------------------------

describe("AlertPolicy", () => {
  const rec = (tier: "notice" | "alert", cause = "round-overdue"): AlertRecord => ({ tier, cause, pr: 5012, title: "t", body: "b", ts: "", file: "f.json" });

  it("routes a fresh cause and folds repeats inside the cooldown", () => {
    let t = new Date("2026-08-14T10:00:00Z");
    const p = new AlertPolicy(20, () => t);
    expect(p.decide(rec("notice"))).toEqual({ action: "route", bypass: false });
    t = new Date("2026-08-14T10:05:00Z");
    expect(p.decide(rec("notice"))).toEqual({ action: "fold", count: 1 });
    expect(p.decide(rec("notice"))).toEqual({ action: "fold", count: 2 });
    expect(p.totalFolds()).toBe(2);
    // …and routes again once the window has passed.
    t = new Date("2026-08-14T10:25:00Z");
    expect(p.decide(rec("notice"))).toEqual({ action: "route", bypass: false });
  });

  it("lets a notice→alert escalation break the cooldown exactly once a day", () => {
    let t = new Date("2026-08-14T10:00:00Z");
    const p = new AlertPolicy(120, () => t);
    p.decide(rec("notice"));
    t = new Date("2026-08-14T10:05:00Z");
    expect(p.decide(rec("alert"))).toEqual({ action: "route", bypass: true });
    t = new Date("2026-08-14T10:06:00Z");
    expect(p.decide(rec("alert"))).toMatchObject({ action: "fold" });
    // A second escalation attempt after folding back to notice is not a new bypass.
    p.decide(rec("notice"));
    expect(p.decide(rec("alert"))).toMatchObject({ action: "fold" });
  });

  // the boundary is Europe/Warsaw, not UTC — 21:50Z in summer is
  // 23:50 local, 22:05Z is already the next day.
  it("forgets its daily memory across a Warsaw day boundary", () => {
    let t = new Date("2026-08-14T21:50:00Z");
    const p = new AlertPolicy(120, () => t);
    p.decide(rec("notice"));
    t = new Date("2026-08-14T22:05:00Z");
    expect(p.decide(rec("notice"))).toEqual({ action: "route", bypass: false });
    expect(p.totalFolds()).toBe(0);
  });

  it("keeps causes independent", () => {
    const t = new Date("2026-08-14T10:00:00Z");
    const p = new AlertPolicy(120, () => t);
    expect(p.decide(rec("notice", "a"))).toMatchObject({ action: "route" });
    expect(p.decide(rec("notice", "b"))).toMatchObject({ action: "route" });
  });
});

// ---- consumer: routing per tier + malformed surfacing ----------------------

function fakeSinks(): { sinks: AlertSinks; notices: string[]; notified: string[][]; injected: string[]; badges: AlertBadge[] } {
  const notices: string[] = [];
  const notified: string[][] = [];
  const injected: string[] = [];
  const badges: AlertBadge[] = [];
  return {
    notices,
    notified,
    injected,
    badges,
    sinks: {
      notice: (t) => notices.push(stripAnsi(t)),
      badge: (b) => badges.push({ ...b }),
      notify: (title, body) => notified.push([title, body]),
      inject: (text) => injected.push(text),
    },
  };
}

function dropAlert(d: string, name: string, obj: unknown): void {
  writeFileSync(join(d, name), typeof obj === "string" ? obj : JSON.stringify(obj));
}

describe("AlertConsumer", () => {
  it("routes a notice to the status line only", () => {
    const f = fakeSinks();
    const c = new AlertConsumer(dir, new AlertPolicy(20), f.sinks);
    dropAlert(dir, "2026-08-14T10-00-00Z-quiet.json", { tier: "notice", cause: "awaiting-aging", pr: 5012, title: "PR #5012 waiting 2d", body: "b", ts: "2026-08-14T10:00:00Z" });
    c.scanOnce();
    expect(f.notices).toHaveLength(1);
    expect(f.notified).toEqual([]);
    expect(f.injected).toEqual([]);
    expect(f.badges.at(-1)).toMatchObject({ count: 1, latest: { tier: "notice" } });
  });

  it("routes an alert to the status line + notify-send + an overseer inject", () => {
    const f = fakeSinks();
    const c = new AlertConsumer(dir, new AlertPolicy(20), f.sinks);
    dropAlert(dir, "2026-08-14T10-00-00Z-stuck.json", { tier: "alert", cause: "round-overdue", pr: 5012, title: "round 3 overdue", body: "40m past deadline", ts: "2026-08-14T10:00:00Z" });
    c.scanOnce();
    expect(f.notified).toEqual([["round 3 overdue", "40m past deadline"]]);
    expect(f.injected).toHaveLength(1);
    expect(f.injected[0]).toContain("[companion alert]");
    expect(f.injected[0]).toContain("PR #5012");
    expect(f.notices[0]).toContain("round 3 overdue");
  });

  it("folds a repeat into a counter instead of re-notifying", () => {
    const f = fakeSinks();
    let t = new Date("2026-08-14T10:00:00Z");
    const c = new AlertConsumer(dir, new AlertPolicy(60, () => t), f.sinks, () => t);
    dropAlert(dir, "a1.json", { tier: "alert", cause: "daemon-stale", pr: null, title: "status.json stale", body: "b", ts: "x" });
    c.scanOnce();
    t = new Date("2026-08-14T10:10:00Z");
    dropAlert(dir, "a2.json", { tier: "alert", cause: "daemon-stale", pr: null, title: "status.json stale", body: "b", ts: "x" });
    c.scanOnce();
    expect(f.notified).toHaveLength(1); // no second KDE popup
    expect(f.injected).toHaveLength(1); // and no second overseer inject
    expect(f.notices.at(-1)).toContain("×2");
    expect(f.badges.at(-1)).toMatchObject({ count: 1, folds: 1 });
  });

  it("surfaces a malformed file by name and never swallows it", () => {
    const f = fakeSinks();
    const c = new AlertConsumer(dir, new AlertPolicy(20), f.sinks);
    dropAlert(dir, "broken.json", "{oops");
    c.scanOnce();
    expect(f.notices[0]).toContain("broken.json");
    expect(f.notices[0]).toContain("malformed");
    expect(f.notified).toEqual([]);
    expect(f.badges).toEqual([]);
  });

  it("archives every processed file into .done/, so a rescan is a no-op", () => {
    const f = fakeSinks();
    const c = new AlertConsumer(dir, new AlertPolicy(20), f.sinks);
    dropAlert(dir, "a1.json", { tier: "notice", cause: "c", pr: null, title: "t", body: "", ts: "x" });
    dropAlert(dir, "bad.json", "nope");
    c.scanOnce();
    expect(c.pending()).toEqual([]);
    expect(readdirSync(join(dir, ".done")).sort()).toEqual(["a1.json", "bad.json"]);
    const before = f.notices.length;
    c.scanOnce();
    expect(f.notices).toHaveLength(before);
  });

  it("formats the overseer message and the status line", () => {
    const a: AlertRecord = { tier: "alert", cause: "round-overdue", pr: 5012, title: "round 3 overdue", body: "40m past deadline", ts: "x", file: "f.json" };
    expect(overseerMessage(a).startsWith("[companion alert] round 3 overdue (PR #5012)")).toBe(true);
    expect(overseerMessage(a)).toContain("cause: round-overdue");
    expect(stripAnsi(statusLine(a, 0))).toBe("▲ #5012 round 3 overdue");
    expect(stripAnsi(statusLine(a, 2))).toContain("(×3)");
  });
});

// ---- TUI surfaces -----------------------------------------------------------

function baseView(): BoardView {
  return {
    health: { kind: "ok", heartbeatAgeS: 2 },
    dryRun: true,
    events: [],
    selected: 0,
    detailFull: false,
    eventsFocus: false,
    eventsScroll: 0,
    help: false,
    snapshot: snap(),
    now: new Date("2026-08-14T10:00:00Z"),
  };
}

describe("alert badge in the top bar", () => {
  const badge: AlertBadge = { count: 2, folds: 3, latest: { tier: "alert", title: "round 3 overdue", cause: "round-overdue", pr: 5012, ts: "x" } };

  it("renders count, PR, title and the fold counter", () => {
    const view = { ...baseView(), alerts: badge };
    const bar = stripAnsi(topBar(view, 120));
    expect(bar).toContain("▲ 2 #5012 round 3 overdue +3");
  });

  it("themes by tier", () => {
    expect(alertSegment(badge, false)).toContain("\x1b[38;2;224;108;117m"); // FG.anomaly
    expect(alertSegment({ ...badge, latest: { ...badge.latest!, tier: "notice" } }, false)).toContain(FG.accent); // FG.accent
    expect(alertSegment(badge, false)).toBe(alertSegment(badge, false));
    expect(alertSegment({ count: 0, folds: 0 }, false)).toBe("");
  });

  it("declares a click zone over exactly the badge text", () => {
    const view = { ...baseView(), alerts: badge };
    const zone = alertZone(view, 120)!;
    const bar = stripAnsi(topBar(view, 120));
    const seg = stripAnsi(alertSegment(badge, false));
    expect(bar.slice(zone.x1 - 1, zone.x2)).toBe(seg);
    const frame = renderBoard(view, 120, 30);
    expect(frame.zones.some((z) => z.y1 === 1 && JSON.stringify(z.action) === JSON.stringify({ t: "companion" }))).toBe(true);
  });

  it("has no zone when there is no alert", () => {
    expect(alertZone(baseView(), 120)).toBeUndefined();
  });
});

function fakeStreams() {
  const out = new EventEmitter() as any;
  let buf = "";
  out.columns = 100;
  out.rows = 24;
  out.write = (s: string) => ((buf += s), true);
  const input = new EventEmitter() as any;
  input.isTTY = false;
  input.resume = () => {};
  input.pause = () => {};
  input.setRawMode = () => {};
  return { out, input, written: () => buf, type: (s: string) => input.emit("data", Buffer.from(s)) };
}

const CFG = resolveCompanionPaths({ ...COMPANION_DEFAULTS, repo_dir: "/host/repo", feed_dir: "/host/feed", alerts_dir: "/host/alerts" }, "/host/repo");

describe("companion tab", () => {
  const noDocker: DockerRunner = async () => ({ ok: false, stdout: "", stderr: "", code: 1 });

  function harness(available = true) {
    const s = fakeStreams();
    const app = new App(TUI_DEFAULTS, async () => ({ ok: false, stdout: "", stderr: "", code: 1 }), s.out, s.input);
    const lifecycle = new CompanionLifecycle(CFG, noDocker, {});
    // the companion IS the sidebar column — there is no pty to spawn
    // and no screen to take over, so the harness wires the column instead.
    app.sidebar = new CompanionSidebar(CFG, noDocker, { available: () => available });
    installCompanionTabHooks(app, {
      lifecycle,
      available: () => available,
      failure: () => (available ? undefined : "docker build qcr-companion failed: boom"),
    });
    // run() installs the input listener; the poller's ssh always fails here.
    const running = app.run();
    return { app, s, close: () => (app.quit(), running) };
  }

  it("takes the keyboard in the column — never full-screen, never a tab change", async () => {
    const h = harness();
    h.app.openCompanion();
    await Promise.resolve();
    expect(h.app.tab).toBe("board"); //: the companion is not a tab
    // nor is it a screen. Asking for the companion focuses the
    // column that is already painted; nothing is spawned, nothing suspends.
    expect(h.app.sidebar?.focused).toBe(true);
    expect(h.app.isBusy()).toBe(true); // focused input owns the keyboard
    await h.close();
  });

  it("expands a collapsed column rather than focusing something invisible", async () => {
    const h = harness();
    h.app.sidebar!.toggleCollapse();
    expect(h.app.sidebar?.collapsed).toBe(true);
    h.app.openCompanion();
    await Promise.resolve();
    expect(h.app.sidebar?.collapsed).toBe(false);
    expect(h.app.sidebar?.focused).toBe(true);
    await h.close();
  });

  it("the companion tab keys are retired: 3 is deploy now, c is no tab at all", async () => {
    const h = harness();
    h.s.type("3");
    expect(h.app.tab).toBe("deploy");
    h.s.type("1");
    h.s.type("c");
    expect(h.app.tab).toBe("board");
    // `c` opens no tab — it is an unregistered printable, so it hands the
    // keyboard to the companion column and the character goes to PI (:
    // there is no TUI-side draft for it to land in).
    expect(h.app.sidebar?.focused).toBe(true);
    expect("input" in (h.app.sidebar as unknown as Record<string, unknown>)).toBe(false);
    await h.close();
  });

  it("an alert-tier badge gives ⏎ to the companion, Esc gives it back", async () => {
    const h = harness();
    h.app.setAlertBadge({ count: 1, folds: 0, latest: { tier: "alert", title: "t", cause: "c", pr: 5012, ts: "x" } });
    expect(h.app.view.alertFocus).toBe(true);
    h.s.type("\x1b"); // Esc acknowledges
    expect(h.app.view.alertFocus).toBe(false);
    h.app.setAlertBadge({ count: 2, folds: 0, latest: { tier: "alert", title: "t", cause: "c", pr: 5012, ts: "x" } });
    h.s.type("\r");
    await Promise.resolve();
    expect(h.app.sidebar?.focused).toBe(true); // ⏎ followed the alert into the companion
    expect(h.app.view.alertFocus).toBe(false);
    await h.close();
  });

  it("a notice-tier badge never steals ⏎", async () => {
    const h = harness();
    h.app.setAlertBadge({ count: 1, folds: 0, latest: { tier: "notice", title: "t", cause: "c", pr: 5012, ts: "x" } });
    expect(h.app.view.alertFocus).toBeFalsy();
    await h.close();
  });

  it("surfaces the REAL failure when the companion is down, never a mislabel", async () => {
    const h = harness(false);
    h.app.openCompanion();
    await Promise.resolve();
    expect(h.app.sidebar?.focused).toBe(false);
    expect(h.app.view.noticeLine).toContain("not running: docker build qcr-companion failed: boom");
    expect(h.app.view.noticeLine).not.toContain("disabled (--no-companion)");
    await h.close();
  });

  it("⏎ on a failed companion runs retry and focuses the column once it heals", async () => {
    const s = fakeStreams();
    const app = new App(TUI_DEFAULTS, async () => ({ ok: false, stdout: "", stderr: "", code: 1 }), s.out, s.input);
    const lifecycle = new CompanionLifecycle(CFG, noDocker, {});
    let up = false;
    app.sidebar = new CompanionSidebar(CFG, noDocker, { available: () => up });
    installCompanionTabHooks(app, {
      lifecycle,
      available: () => up,
      failure: () => (up ? undefined : "image missing"),
      retry: async () => {
        up = true; // the retry path healed the startup
      },
    });
    const running = app.run();
    app.openCompanion();
    for (let i = 0; i < 100 && !app.sidebar.focused; i++) await new Promise((r) => setTimeout(r, 5));
    expect(up).toBe(true);
    expect(app.sidebar.focused).toBe(true); // healed, then focused
    app.quit();
    await running;
  });
});
