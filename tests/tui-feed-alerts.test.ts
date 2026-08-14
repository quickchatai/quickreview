// Slice C2: ambient feed writer, alert pipeline, companion surfaces.
// I/O is a temp dir per test; nothing spawns docker, notify-send, ssh or pi.
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
import { FeedWriter, eventKey, type FeedEvent } from "../src/tui/feed.js";
import { stripAnsi } from "../src/tui/paint.js";
import type { PtyLike } from "../src/tui/attach.js";
import { WAKE_THROTTLE_MS, parseWake, resolveFeedDir, shouldWake, wakeMessage } from "../extensions/companion-wake.js";

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

  it("wakes on the first write, then only on meaningful change", () => {
    const w = new FeedWriter(dir);
    expect(w.write(snap(), [], "ok").meaningful).toBe(true);
    rmSync(w.wakePath);

    // A pure timestamp/heartbeat tick is not news.
    const tick = w.write(snap({ written_at: "2026-08-14T10:00:30Z", heartbeat: "2026-08-14T10:00:30Z", total_spend_usd: 2 }), [], "ok");
    expect(tick.meaningful).toBe(false);
    expect(existsSync(w.wakePath)).toBe(false);

    // A state transition is.
    const moved = w.write(
      snap({ prs: [{ number: 5012, state: "awaiting_author", title: "t", head_sha: "abc", stale_recheck: false, rounds: 1, last_verdict: "REQUEST_CHANGES" }] }),
      [],
      "ok",
    );
    expect(moved.meaningful).toBe(true);
    expect(moved.gist).toContain("#5012 reviewing→awaiting_author");
    expect(JSON.parse(readFileSync(w.wakePath, "utf8")).gist).toContain("#5012");
  });

  it("wakes on new events and on a health flip", () => {
    const w = new FeedWriter(dir);
    w.write(snap(), [], "ok");
    const withEvent = w.write(snap(), [ev("2026-08-14T10:01:00Z")], "ok");
    expect(withEvent.meaningful).toBe(true);
    expect(withEvent.gist).toContain("1 new event");
    const flip = w.write(snap(), [ev("2026-08-14T10:01:00Z")], "stale");
    expect(flip.meaningful).toBe(true);
    expect(flip.gist).toContain("daemon ok→stale");
  });
});

// ---- companion-side wake extension (pure parts; pi itself is never loaded) --

describe("companion-wake extension", () => {
  it("reads the marker written by FeedWriter and phrases a one-line wake", () => {
    const w = new FeedWriter(dir);
    const res = w.write(snap(), [ev("2026-08-14T10:00:00Z")], "ok");
    const parsed = parseWake(readFileSync(w.wakePath, "utf8"));
    expect(parsed.gist).toBe(res.gist);
    expect(wakeMessage(parsed.gist)).toBe(`feed updated: ${res.gist}`);
  });

  it("degrades a torn/garbled marker to a wake without a gist", () => {
    expect(parseWake("{half-writ").gist).toBe("");
    expect(wakeMessage("")).toBe("feed updated: board changed");
  });

  it("never wakes twice on the same marker, and never faster than the throttle", () => {
    const t0 = 1_000_000;
    expect(shouldWake(t0, 0, "m1", "")).toBe(true); // first wake of a session
    expect(shouldWake(t0 + 1_000, t0, "m1", "m1")).toBe(false); // same marker re-notified
    expect(shouldWake(t0 + 1_000, t0, "m2", "m1")).toBe(false); // new marker, throttled
    expect(shouldWake(t0 + WAKE_THROTTLE_MS, t0, "m2", "m1")).toBe(true);
    expect(WAKE_THROTTLE_MS).toBe(60_000);
  });

  it("takes the feed dir from the container env, defaulting to /feed", () => {
    expect(resolveFeedDir({ QCR_FEED_DIR: "/feed-x" })).toBe("/feed-x");
    expect(resolveFeedDir({})).toBe("/feed");
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
    expect(alertSegment({ ...badge, latest: { ...badge.latest!, tier: "notice" } }, false)).toContain("\x1b[38;2;86;182;194m"); // FG.accent
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
    expect(frame.zones.some((z) => z.y1 === 1 && JSON.stringify(z.action) === JSON.stringify({ t: "tab", tab: "companion" }))).toBe(true);
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
    const spawned: string[][] = [];
    const pty: PtyLike = { write: () => {}, resize: () => {}, kill: () => {}, onData: () => {}, onExit: () => {} };
    installCompanionTabHooks(app, {
      lifecycle,
      available,
      out: s.out,
      input: s.input,
      spawner: (argv) => {
        spawned.push(argv);
        return pty;
      },
    });
    // run() installs the input listener; the poller's ssh always fails here.
    const running = app.run();
    return { app, s, spawned, close: () => (app.quit(), running) };
  }

  it("attaches the LOCAL container argv — docker exec -it, no ssh", async () => {
    const h = harness();
    h.app.openCompanion();
    await Promise.resolve();
    expect(h.app.tab).toBe("companion");
    expect(h.spawned).toEqual([["exec", "-it", "qcr-companion", "tmux", "attach", "-t", "companion"]]);
    expect(h.spawned[0]).not.toContain("ssh");
    await h.close();
  });

  it("'c' and '3' open the companion tab", async () => {
    for (const key of ["c", "3"]) {
      const h = harness();
      h.s.type(key);
      expect(h.app.tab).toBe("companion");
      await h.close();
    }
  });

  it("an alert-tier badge gives ⏎ to the companion, Esc gives it back", async () => {
    const h = harness();
    h.app.setAlertBadge({ count: 1, folds: 0, latest: { tier: "alert", title: "t", cause: "c", pr: 5012, ts: "x" } });
    expect(h.app.view.alertFocus).toBe(true);
    h.s.type("\x1b"); // Esc acknowledges
    expect(h.app.view.alertFocus).toBe(false);
    h.app.setAlertBadge({ count: 2, folds: 0, latest: { tier: "alert", title: "t", cause: "c", pr: 5012, ts: "x" } });
    h.s.type("\r");
    expect(h.app.tab).toBe("companion");
    expect(h.app.view.alertFocus).toBe(false);
    await h.close();
  });

  it("a notice-tier badge never steals ⏎", async () => {
    const h = harness();
    h.app.setAlertBadge({ count: 1, folds: 0, latest: { tier: "notice", title: "t", cause: "c", pr: 5012, ts: "x" } });
    expect(h.app.view.alertFocus).toBeFalsy();
    await h.close();
  });

  it("renders a resting screen when the companion is disabled, and never attaches", async () => {
    const h = harness(false);
    h.app.openCompanion();
    await Promise.resolve();
    expect(h.spawned).toEqual([]);
    expect(stripAnsi(h.s.written())).toContain("disabled (--no-companion)");
    await h.close();
  });
});
