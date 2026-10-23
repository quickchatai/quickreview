// The companion inbox replaces every overseer wake (P8.18). Two halves:
//
//   * the inbox itself — durable (a file per item, written atomically),
//     deduped by id, bounded, with the four-field item shape the TUI reads;
//   * the sources — each of them writes EXACTLY ONE item: the anomaly sink
//     (incl. authwatch's `pi_auth_expired` and the refresher's
//     `login_refresh_failed`), the daily heartbeat, the 18:00 EOD timer, the
//     pinned-area watch's anomaly, the self-requeue notice and the Slack
//     connection signal. No source wakes anything else.
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AnomalyWakePolicy, startHeartbeat } from "../src/anomalies.js";
import {
  CompanionInbox,
  INBOX_MAX_TEXT_CHARS,
  companionInboxDir,
  inboxClassForAnomaly,
  type InboxClass,
} from "../src/companioninbox.js";
import { startEodTimer } from "../src/eod.js";
import { startEodPinWatch, type PinnedEntryView } from "../src/eodpinwatch.js";
import { StateStore } from "../src/state.js";
import { EXTENSION_DIRS, SRC_DIRS } from "./helpers/source-trees.js";

let root: string;
let clock: Date;
let logs: string[];
let inbox: CompanionInbox;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qcr-inbox-"));
  clock = new Date("2026-08-20T09:00:00.000Z");
  logs = [];
  inbox = new CompanionInbox({ root, now: () => clock, log: (m) => void logs.push(m) });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("the inbox directory and the item shape", () => {
  it("lives at <root>/inject/companion-inbox/ and holds { id, class, text, created_at }", () => {
    expect(inbox.dir).toBe(join(root, "inject", "companion-inbox"));
    expect(companionInboxDir(root)).toBe(inbox.dir);
    const item = inbox.add("anomaly", "something broke");
    expect(Object.keys(item).sort()).toEqual(["class", "created_at", "id", "text"]);
    expect(item).toMatchObject({
      class: "anomaly",
      text: "something broke",
      created_at: "2026-08-20T09:00:00.000Z",
    });
    const onDisk = JSON.parse(readFileSync(join(inbox.dir, `${item.id}.json`), "utf8"));
    expect(onDisk).toEqual(item);
    expect(readdirSync(inbox.dir)).toEqual([`${item.id}.json`]); // no torn tmp left behind
  });

  it("is created lazily: nothing exists until the first item", () => {
    expect(inbox.list()).toEqual([]);
    expect(() => readdirSync(inbox.dir)).toThrow();
  });

  it("lists oldest first and acks by deleting", () => {
    inbox.add("anomaly", "first");
    clock = new Date("2026-08-20T09:01:00.000Z");
    const second = inbox.add("login", "second");
    expect(inbox.list().map((i) => i.text)).toEqual(["first", "second"]);
    expect(inbox.ack(second.id)).toBe(true);
    expect(inbox.ack(second.id)).toBe(false); // already gone
    expect(inbox.list().map((i) => i.text)).toEqual(["first"]);
    expect(inbox.ack("../../etc/passwd")).toBe(false);
  });

  it("skips a file that is not an item, without deleting it", () => {
    inbox.add("anomaly", "real");
    writeFileSync(join(inbox.dir, "junk.json"), "{not json");
    writeFileSync(join(inbox.dir, "notes.txt"), "hello");
    expect(inbox.list().map((i) => i.text)).toEqual(["real"]);
    expect(readdirSync(inbox.dir)).toContain("junk.json");
  });
});

describe("deduped", () => {
  it("an id written again while pending is a no-op that returns the first item", () => {
    const first = inbox.add("eod", "sweep v1", { id: "eod-2026-08-20" });
    clock = new Date("2026-08-20T09:30:00.000Z");
    const again = inbox.add("eod", "sweep v2", { id: "eod-2026-08-20" });
    expect(again).toEqual(first);
    expect(inbox.list()).toHaveLength(1);
    expect(inbox.list()[0]?.text).toBe("sweep v1");
  });

  it("without an id, identical class + text is one item and different text is another", () => {
    inbox.add("anomaly", "same");
    inbox.add("anomaly", "same");
    inbox.add("anomaly", "different");
    inbox.add("login", "same");
    expect(inbox.list()).toHaveLength(3);
  });

  it("after an ack the same item may arrive again", () => {
    const item = inbox.add("anomaly", "recurs");
    inbox.ack(item.id);
    inbox.add("anomaly", "recurs");
    expect(inbox.list()).toHaveLength(1);
  });

  it("refuses an id that is not a plain file stem", () => {
    expect(() => inbox.add("eod", "x", { id: "../escape" })).toThrow(/invalid item id/);
    expect(() => inbox.add("eod", "x", { id: "UPPER" })).toThrow(/invalid item id/);
  });
});

describe("bounded", () => {
  it("evicts the oldest routine item past the cap, and says so", () => {
    const small = new CompanionInbox({
      root,
      maxItems: 3,
      now: () => clock,
      log: (m) => void logs.push(m),
    });
    for (const n of [1, 2, 3, 4, 5]) {
      clock = new Date(clock.getTime() + 1000);
      small.add("anomaly", `a${n}`);
    }
    expect(small.list().map((i) => i.text)).toEqual(["a3", "a4", "a5"]);
    expect(logs.filter((l) => l.includes("evicted"))).toHaveLength(2);
  });

  it("keeps a login alert and an EOD sweep while any routine item can go instead", () => {
    const small = new CompanionInbox({
      root,
      maxItems: 3,
      now: () => clock,
      log: (m) => void logs.push(m),
    });
    small.add("eod", "sweep", { id: "eod-2026-08-19" });
    clock = new Date(clock.getTime() + 1000);
    small.add("login", "relogin");
    clock = new Date(clock.getTime() + 1000);
    small.add("anomaly", "noise 1");
    clock = new Date(clock.getTime() + 1000);
    small.add("anomaly", "noise 2");
    clock = new Date(clock.getTime() + 1000);
    small.add("heartbeat", "beat");
    expect(small.list().map((i) => i.class)).toEqual(["eod", "login", "heartbeat"]);
  });

  it("never evicts the item it just wrote", () => {
    const one = new CompanionInbox({ root, maxItems: 1, now: () => clock, log: () => {} });
    one.add("eod", "sweep", { id: "eod-2026-08-19" });
    clock = new Date(clock.getTime() + 1000);
    one.add("login", "relogin");
    expect(one.list().map((i) => i.class)).toEqual(["login"]);
  });

  it("caps one item's text and marks the cut", () => {
    const item = inbox.add("anomaly", "x".repeat(INBOX_MAX_TEXT_CHARS + 500));
    expect(item.text.length).toBeLessThan(INBOX_MAX_TEXT_CHARS + 100);
    expect(item.text).toContain("[truncated: 500 more characters]");
  });
});

describe("every source writes exactly one item", () => {
  /** The anomaly sink exactly as daemon.ts wires it. */
  function wireSink(): { store: StateStore; policy: AnomalyWakePolicy } {
    const store = new StateStore(":memory:", () => clock);
    const policy = new AnomalyWakePolicy({
      writeInbox: inbox.writer(),
      now: () => clock,
      log: (m) => void logs.push(m),
    });
    store.setAnomalySink((sig) => policy.onAnomaly(sig));
    return { store, policy };
  }

  it("a wake-grade anomaly: one `anomaly` item carrying the call site's text", async () => {
    const { store, policy } = wireSink();
    store.logAnomaly("malformed", 42, 1, "verdict file is malformed", "ANOMALY (malformed) — #42");
    await tick();
    expect(inbox.list().map((i) => [i.class, i.text])).toEqual([
      ["anomaly", "ANOMALY (malformed) — #42"],
    ]);
    policy.stop();
    store.close();
  });

  it("a quiet anomaly writes none: it waits for the heartbeat", async () => {
    const { store, policy } = wireSink();
    store.logAnomaly("recheck_degraded", 42, 1, "merge-verify degraded");
    await tick();
    expect(inbox.list()).toEqual([]);
    policy.stop();
    store.close();
  });

  it("authwatch's `pi_auth_expired` and the refresher's `login_refresh_failed`: one `login` item each", async () => {
    const { store, policy } = wireSink();
    store.logAnomaly("pi_auth_expired", null, null, "token expired in 2 files", "PI AUTH EXPIRED");
    store.logAnomaly(
      "login_refresh_failed",
      null,
      null,
      "refresh token rejected",
      "LOGIN REFRESH FAILED",
    );
    await tick();
    // (same instant: the listing breaks the tie by id, so compare as a set)
    expect(
      inbox
        .list()
        .map((i) => `${i.class}: ${i.text}`)
        .sort(),
    ).toEqual(["login: LOGIN REFRESH FAILED", "login: PI AUTH EXPIRED"]);
    expect(inboxClassForAnomaly("pi_auth_expired")).toBe("login");
    expect(inboxClassForAnomaly("malformed")).toBe("anomaly");
    policy.stop();
    store.close();
  });

  it("the same anomaly repeating is still one item", async () => {
    const { store, policy } = wireSink();
    for (let i = 0; i < 3; i++) {
      store.logAnomaly("overdue", 7, 1, "deadline blown", "ANOMALY (overdue) — #7");
      await tick();
    }
    expect(inbox.list()).toHaveLength(1);
    policy.stop();
    store.close();
  });

  it("a failed write is retried by the policy and still ends as one item", async () => {
    const store = new StateStore(":memory:", () => clock);
    let fail = true;
    const timers: Array<() => void> = [];
    const write = inbox.writer();
    const policy = new AnomalyWakePolicy({
      writeInbox: async (m, c) => {
        if (fail) {
          fail = false;
          throw new Error("disk full");
        }
        await write(m, c);
      },
      now: () => clock,
      setTimer: (cb) => (timers.push(cb), timers.length),
      clearTimer: () => {},
      log: () => {},
    });
    store.setAnomalySink((sig) => policy.onAnomaly(sig));
    store.logAnomaly("overdue", 7, 1, "deadline blown", "ANOMALY (overdue) — #7");
    await tick();
    expect(inbox.list()).toEqual([]);
    timers[0]!();
    await tick();
    expect(inbox.list()).toHaveLength(1);
    policy.stop();
    store.close();
  });

  it("the daily heartbeat: one `heartbeat` item named for the day, once per day", async () => {
    const store = new StateStore(":memory:", () => clock);
    clock = new Date("2026-08-20T08:00:00.000Z"); // 10:00 Warsaw, after the 09:00 slot
    const hb = startHeartbeat({
      timeHHMM: "09:00",
      timeZone: "Europe/Warsaw",
      lastFired: () => store.lastHeartbeatDate(),
      recordFired: (date) => store.recordHeartbeat(date),
      writeInbox: inbox.heartbeatWriter(),
      now: () => clock,
      setTimer: () => 0,
      clearTimer: () => {},
    });
    await hb.booted;
    const items = inbox.list();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "heartbeat-2026-08-20", class: "heartbeat" });
    expect(items[0]?.text).toContain("HEARTBEAT — 2026-08-20");
    expect(store.lastHeartbeatDate()).toBe("2026-08-20");
    hb.stop();
    store.close();
  });

  it("the 18:00 EOD timer: one `eod` item with the render, retried writes stay one", async () => {
    let wall = new Date("2026-08-20T09:00:00Z");
    const timers: Array<{ cb: () => void; ms: number }> = [];
    let failures = 1;
    const write = inbox.eodWriter();
    const timer = startEodTimer({
      timeHHMM: "18:00",
      timeZone: "Europe/Warsaw",
      now: () => wall,
      readPrompt: () => "sweep {{date}}",
      dayContext: () => ({ lines: "DAY CONTEXT LINES" }),
      writeInbox: async (m, date) => {
        if (failures-- > 0) throw new Error("transient");
        await write(m, date);
      },
      retryBackoffMs: [10],
      setTimer: (cb, ms) => (timers.push({ cb, ms }), timers.length - 1),
      clearTimer: () => {},
    });
    wall = new Date("2026-08-20T16:00:00Z");
    timers[0]!.cb();
    await tick();
    // the first write failed; the timer's retry wait is armed
    expect(inbox.list()).toEqual([]);
    timers.at(-1)!.cb();
    await tick();
    await tick();
    const items = inbox.list();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "eod-2026-08-20", class: "eod" });
    expect(items[0]?.text).toContain("sweep 2026-08-20");
    expect(items[0]?.text).toContain("DAY CONTEXT LINES");
    timer.stop();
  });

  it("an EOD sweep left in the inbox while the companion is off is still there, whole, the next day", async () => {
    inbox.add("eod", "sweep for the 20th", { id: "eod-2026-08-20" });
    clock = new Date("2026-08-21T20:00:00.000Z");
    const later = new CompanionInbox({ root, now: () => clock });
    expect(later.list().map((i) => i.id)).toEqual(["eod-2026-08-20"]);
    expect(later.list()[0]?.created_at).toBe("2026-08-20T09:00:00.000Z");
  });

  it("the pinned-area watch: a changed pin area is one anomaly item, through the same sink", async () => {
    const { store, policy } = wireSink();
    const pin = (hash: string): PinnedEntryView => ({
      id: "b1",
      ts: "2026-08-20 09:00:00",
      block: 0,
      hash,
    });
    const reads = [[pin("h1")], [pin("EDITED")]];
    let at = 0;
    let wall = new Date("2026-08-20T16:00:00Z");
    const timers: Array<() => void> = [];
    const watch = startEodPinWatch({
      readPinned: async () => reads[Math.min(at++, reads.length - 1)]!,
      logAnomaly: (kind, pr, round, detail, message) =>
        store.logAnomaly(kind, pr, round, detail, message),
      timeZone: "Europe/Warsaw",
      windowMin: 90,
      now: () => wall,
      setTimer: (cb) => (timers.push(cb), timers.length),
      clearTimer: () => {},
    });
    await watch.wrapInject(inbox.eodWriter())("sweep", "2026-08-20");
    wall = new Date(wall.getTime() + 91 * 60_000);
    for (const cb of timers.splice(0)) cb();
    await watch.settled();
    await tick();
    const items = inbox.list();
    expect(items.map((i) => i.class).sort()).toEqual(["anomaly", "eod"]);
    expect(items.find((i) => i.class === "anomaly")?.text).toContain("eod_pinned_area_modified");
    watch.stop();
    policy.stop();
    store.close();
  });

  it("writes only inbox files: no other directory under inject/ appears", async () => {
    const { store, policy } = wireSink();
    store.logAnomaly("overdue", 7, 1, "deadline blown", "ANOMALY (overdue) — #7");
    await tick();
    expect(readdirSync(join(root, "inject"))).toEqual(["companion-inbox"]);
    policy.stop();
    store.close();
  });
});

describe("classes", () => {
  it("the four classes the companion prompt will handle", () => {
    const classes: InboxClass[] = ["anomaly", "heartbeat", "login", "eod"];
    for (const c of classes) expect(inbox.add(c, `item of ${c}`).class).toBe(c);
    expect(inbox.list()).toHaveLength(4);
  });
});

describe("no overseer wake is left", () => {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : path.endsWith(".ts") ? [path] : [];
    });

  it("nothing in src/ or extensions/ names the retired overseer inject, and SessionHooks lost it", () => {
    // spelled in two halves so this very file stays out of the repo-wide grep
    const retired = new RegExp(["inject", "Overseer"].join(""));
    const hits = [...SRC_DIRS, ...EXTENSION_DIRS]
      .flatMap((d) => walk(join(repo, d)))
      .filter((file) => retired.test(readFileSync(file, "utf8")));
    expect(hits).toEqual([]);
    expect(readFileSync(join(repo, "packages/pi-plugin/src/types.ts"), "utf8")).not.toMatch(
      retired,
    );
  });
});
