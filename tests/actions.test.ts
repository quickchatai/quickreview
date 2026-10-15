// The companion → TUI action channel: strict schema parse, instant
// execution against the TuiDriver seam, archive-before-execute idempotency,
// result files, bounded housekeeping.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACTION_TEXT_MAX,
  executeTuiAction,
  parseTuiAction,
  processTuiActions,
  type TuiAction,
  type TuiDriver,
} from "../src/tui/actions.js";

function mockDriver(overrides: Partial<TuiDriver> = {}): {
  calls: Array<[string, ...unknown[]]>;
  driver: TuiDriver;
} {
  const calls: Array<[string, ...unknown[]]> = [];
  const driver: TuiDriver = {
    switchTab: (tab) => calls.push(["switchTab", tab]),
    selectPr: (pr) => calls.push(["selectPr", pr]),
    metricsWindow: (w) => calls.push(["metricsWindow", w]),
    metricsPr: (pr) => calls.push(["metricsPr", pr]),
    digestDay: (date) => calls.push(["digestDay", date]),
    memoryView: (opts) => calls.push(["memoryView", opts]),
    setBoardFilter: (f) => calls.push(["setBoardFilter", f]),
    setMemoryFilter: (tag) => calls.push(["setMemoryFilter", tag]),
    msgSession: (session, text) => {
      calls.push(["msgSession", session, text]);
      return Promise.resolve(`✓ msg ${session} delivered`);
    },
    overseerInject: (text) => {
      calls.push(["overseerInject", text]);
      return Promise.resolve("✓ msg overseer delivered");
    },
    deployTab: (action) => calls.push(["deployTab", action]),
    memoryPin: (entry, pin) => {
      calls.push(["memoryPin", entry, pin]);
      return Promise.resolve(`moved ${entry}`);
    },
    ...overrides,
  };
  return { calls, driver };
}

const ok = (obj: unknown): TuiAction => {
  const res = parseTuiAction(JSON.stringify(obj));
  if (!res.ok) throw new Error(`expected ok, got: ${res.error}`);
  return res.action;
};

const err = (obj: unknown): string => {
  const res = parseTuiAction(typeof obj === "string" ? obj : JSON.stringify(obj));
  if (res.ok) throw new Error(`expected refusal for ${JSON.stringify(obj)}`);
  return res.error;
};

describe("parseTuiAction — valid requests, every verb", () => {
  it("switch_tab", () => {
    for (const tab of ["board", "memory", "digest", "tickets", "deploy", "metrics", "feedback"]) {
      expect(ok({ verb: "switch_tab", params: { tab } })).toEqual({ verb: "switch_tab", tab });
    }
  });

  it("select_pr (number and digit-string coercion)", () => {
    expect(ok({ verb: "select_pr", params: { pr: 5312 } })).toEqual({
      verb: "select_pr",
      pr: 5312,
    });
    expect(ok({ verb: "select_pr", params: { pr: "5312" } })).toEqual({
      verb: "select_pr",
      pr: 5312,
    });
  });

  it("metrics — window xor pr", () => {
    for (const window of ["7d", "30d", "all"]) {
      expect(ok({ verb: "metrics", params: { window } })).toEqual({ verb: "metrics", window });
    }
    expect(ok({ verb: "metrics", params: { pr: 5312 } })).toEqual({ verb: "metrics", pr: 5312 });
  });

  it("digest_day", () => {
    expect(ok({ verb: "digest_day", params: { date: "2026-08-19" } })).toEqual({
      verb: "digest_day",
      date: "2026-08-19",
    });
  });

  it("memory_view — day and tag both optional, '#' stripped from the tag", () => {
    expect(ok({ verb: "memory_view", params: {} })).toEqual({ verb: "memory_view" });
    expect(ok({ verb: "memory_view" })).toEqual({ verb: "memory_view" }); // params itself optional
    expect(ok({ verb: "memory_view", params: { day: "2026-08-19", tag: "#pinned" } })).toEqual({
      verb: "memory_view",
      day: "2026-08-19",
      tag: "pinned",
    });
  });

  it("board_filter — author/state/both/clear", () => {
    expect(ok({ verb: "board_filter", params: { author: "jbennett" } })).toEqual({
      verb: "board_filter",
      filter: { author: "jbennett" },
    });
    expect(ok({ verb: "board_filter", params: { state: "reviewing" } })).toEqual({
      verb: "board_filter",
      filter: { state: "reviewing" },
    });
    expect(ok({ verb: "board_filter", params: { author: "a", state: "queued" } })).toEqual({
      verb: "board_filter",
      filter: { author: "a", state: "queued" },
    });
    expect(ok({ verb: "board_filter", params: { clear: true } })).toEqual({
      verb: "board_filter",
      filter: null,
    });
  });

  it("memory_filter — tag ('#' optional) and clear", () => {
    expect(ok({ verb: "memory_filter", params: { tag: "#bug" } })).toEqual({
      verb: "memory_filter",
      tag: "bug",
    });
    expect(ok({ verb: "memory_filter", params: { tag: "bug" } })).toEqual({
      verb: "memory_filter",
      tag: "bug",
    });
    expect(ok({ verb: "memory_filter", params: { clear: true } })).toEqual({
      verb: "memory_filter",
      tag: null,
    });
  });

  it("msg_session — the msg.ts session-name rule", () => {
    for (const session of ["pr-5312", "overseer", "main"]) {
      expect(ok({ verb: "msg_session", params: { session, text: "hi" } })).toEqual({
        verb: "msg_session",
        session,
        text: "hi",
      });
    }
  });

  it("overseer_inject", () => {
    expect(ok({ verb: "overseer_inject", params: { text: "check pr 5312" } })).toEqual({
      verb: "overseer_inject",
      text: "check pr 5312",
    });
  });

  it("deploy_tab", () => {
    for (const action of ["deploy", "stop", "start", "abort"]) {
      expect(ok({ verb: "deploy_tab", params: { action } })).toEqual({
        verb: "deploy_tab",
        action,
      });
    }
  });

  it("text at exactly the cap passes; trimming applies before the length check", () => {
    const text = "x".repeat(ACTION_TEXT_MAX);
    expect(ok({ verb: "overseer_inject", params: { text } })).toEqual({
      verb: "overseer_inject",
      text,
    });
    expect(ok({ verb: "msg_session", params: { session: "main", text: `  hi  ` } })).toEqual({
      verb: "msg_session",
      session: "main",
      text: "hi",
    });
  });
});

describe("parseTuiAction — refusals, never a throw", () => {
  it("garbage shapes", () => {
    expect(err("not json {{{")).toBe("not JSON");
    expect(err(42)).toBe("not an object");
    expect(err(null)).toBe("not an object");
    expect(err({ params: {} })).toBe("missing verb");
    expect(err({ verb: "select_pr", params: [1] })).toBe("params must be an object");
    expect(err({ verb: "make_coffee", params: {} })).toContain("unknown verb 'make_coffee'");
  });

  it("switch_tab refuses unknown tabs (incl. the retired 'changes' and 'companion')", () => {
    // The changes register lives in the `feedback` tab; `changes` is refused,
    // not aliased.
    for (const tab of ["changes", "companion", "Board", "", 5, undefined]) {
      expect(err({ verb: "switch_tab", params: { tab } })).toContain("switch_tab");
    }
  });

  it("select_pr refuses non-positive and non-numeric", () => {
    for (const pr of [0, -1, 1.5, "abc", "12x", "", null, undefined]) {
      expect(err({ verb: "select_pr", params: { pr } })).toContain("select_pr");
    }
    // A digit string meets the numeric bar too. MUTATION: return Number(v)
    // for any digit string — red.
    for (const pr of ["0", "000", "9".repeat(400)]) {
      expect(err({ verb: "select_pr", params: { pr } })).toContain("select_pr");
      expect(err({ verb: "metrics", params: { pr } })).toContain("positive integer");
    }
  });

  it("metrics refuses neither, both, and bad values", () => {
    expect(err({ verb: "metrics", params: {} })).toContain("exactly one");
    expect(err({ verb: "metrics", params: { window: "7d", pr: 5 } })).toContain("exactly one");
    expect(err({ verb: "metrics", params: { window: "1d" } })).toContain("7d|30d|all");
    expect(err({ verb: "metrics", params: { pr: "many" } })).toContain("positive integer");
  });

  it("digest_day / memory_view refuse malformed dates", () => {
    for (const date of ["2026-8-19", "19-08-2026", "2026-08-19T00:00:00Z", "today", 20260819]) {
      expect(err({ verb: "digest_day", params: { date } })).toContain("YYYY-MM-DD");
    }
    expect(err({ verb: "memory_view", params: { day: "yesterday" } })).toContain("YYYY-MM-DD");
    expect(err({ verb: "memory_view", params: { tag: "" } })).toContain("tag");
    expect(err({ verb: "memory_view", params: { tag: "#" } })).toContain("tag");
  });

  it("board_filter refuses empty filters and unknown states", () => {
    expect(err({ verb: "board_filter", params: {} })).toContain("author and/or state");
    expect(err({ verb: "board_filter", params: { clear: false } })).toContain(
      "author and/or state",
    );
    expect(err({ verb: "board_filter", params: { author: "" } })).toContain("author");
    expect(err({ verb: "board_filter", params: { author: "x".repeat(101) } })).toContain("author");
    expect(err({ verb: "board_filter", params: { state: "Reviewing" } })).toContain("state");
    expect(err({ verb: "board_filter", params: { state: "open" } })).toContain("state");
  });

  it("memory_filter refuses a missing/empty tag", () => {
    expect(err({ verb: "memory_filter", params: {} })).toContain("tag");
    expect(err({ verb: "memory_filter", params: { tag: "  " } })).toContain("tag");
  });

  it("msg_session enforces the isValidSessionName rule", () => {
    for (const session of ["pr-x", "pr5312", "pr-", "root", "overseer2", "MAIN", "", 5]) {
      expect(err({ verb: "msg_session", params: { session, text: "hi" } })).toContain("session");
    }
  });

  it("text caps at 2000 chars, empty/whitespace refused", () => {
    const over = "x".repeat(ACTION_TEXT_MAX + 1);
    expect(err({ verb: "msg_session", params: { session: "main", text: over } })).toContain("2000");
    expect(err({ verb: "msg_session", params: { session: "main", text: "" } })).toContain("2000");
    expect(err({ verb: "msg_session", params: { session: "main", text: "   " } })).toContain(
      "2000",
    );
    expect(err({ verb: "overseer_inject", params: { text: over } })).toContain("2000");
    expect(err({ verb: "overseer_inject", params: {} })).toContain("2000");
  });

  it("deploy_tab refuses unknown actions", () => {
    for (const action of ["restart", "DEPLOY", "", undefined]) {
      expect(err({ verb: "deploy_tab", params: { action } })).toContain("deploy_tab");
    }
  });
});

describe("executeTuiAction — driver dispatch + traces", () => {
  it("routes every verb to the right driver method and returns a one-line trace", async () => {
    const { calls, driver } = mockDriver();
    const traces = await Promise.all([
      executeTuiAction({ verb: "switch_tab", tab: "metrics" }, driver),
      executeTuiAction({ verb: "switch_tab", tab: "feedback" }, driver),
      executeTuiAction({ verb: "select_pr", pr: 5312 }, driver),
      executeTuiAction({ verb: "metrics", window: "30d" }, driver),
      executeTuiAction({ verb: "metrics", pr: 5312 }, driver),
      executeTuiAction({ verb: "digest_day", date: "2026-08-19" }, driver),
      executeTuiAction({ verb: "memory_view", day: "2026-08-19", tag: "bug" }, driver),
      executeTuiAction({ verb: "board_filter", filter: { author: "j", state: "queued" } }, driver),
      executeTuiAction({ verb: "board_filter", filter: null }, driver),
      executeTuiAction({ verb: "memory_filter", tag: "bug" }, driver),
      executeTuiAction({ verb: "memory_filter", tag: null }, driver),
      executeTuiAction({ verb: "msg_session", session: "pr-5312", text: "hello" }, driver),
      executeTuiAction({ verb: "overseer_inject", text: "look" }, driver),
      executeTuiAction({ verb: "deploy_tab", action: "stop" }, driver),
    ]);
    expect(calls).toEqual([
      ["switchTab", "metrics"],
      ["switchTab", "feedback"],
      ["selectPr", 5312],
      ["metricsWindow", "30d"],
      ["metricsPr", 5312],
      ["digestDay", "2026-08-19"],
      ["memoryView", { day: "2026-08-19", tag: "bug" }],
      ["setBoardFilter", { author: "j", state: "queued" }],
      ["setBoardFilter", null],
      ["setMemoryFilter", "bug"],
      ["setMemoryFilter", null],
      ["msgSession", "pr-5312", "hello"],
      ["overseerInject", "look"],
      ["deployTab", "stop"],
    ]);
    expect(traces).toEqual([
      "companion ▸ tab → metrics",
      "companion ▸ tab → feedback",
      "companion ▸ board → #5312",
      "companion ▸ metrics window → 30d",
      "companion ▸ metrics → #5312 timeline",
      "companion ▸ digest → 2026-08-19",
      "companion ▸ memory view · 2026-08-19 · #bug",
      "companion ▸ board filter → author:j · state:queued",
      "companion ▸ board filter cleared",
      "companion ▸ memory filter → #bug",
      "companion ▸ memory filter cleared",
      "companion ▸ msg pr-5312 (5 chars) → ✓ msg pr-5312 delivered",
      "companion ▸ overseer inject (4 chars) → ✓ msg overseer delivered",
      "companion ▸ deploy tab → stop",
    ]);
  });

  it("memory_view with no params still opens the view", () => {
    const { calls, driver } = mockDriver();
    expect(executeTuiAction({ verb: "memory_view" }, driver)).toBe("companion ▸ memory view");
    expect(calls).toEqual([["memoryView", {}]]);
  });
});

describe("memory_pin — pin/unpin through the TUI's one store", () => {
  it("parses an id or a viking:// URI and an explicit pin flag", () => {
    expect(
      ok({ verb: "memory_pin", params: { entry: "reviewer:experiences/a.md", pin: true } }),
    ).toEqual({
      verb: "memory_pin",
      entry: "reviewer:experiences/a.md",
      pin: true,
    });
    expect(
      ok({
        verb: "memory_pin",
        params: { entry: " viking://user/reviewer/memories/preferences/pinned/a.md ", pin: false },
      }),
    ).toEqual({
      verb: "memory_pin",
      entry: "viking://user/reviewer/memories/preferences/pinned/a.md",
      pin: false,
    });
  });

  it("refuses a missing, spaced, traversing or oversized entry, and a pin that is not a boolean", () => {
    for (const entry of [undefined, "", "a b.md", "reviewer:../x.md", "x".repeat(301), 7])
      expect(err({ verb: "memory_pin", params: { entry, pin: true } })).toMatch(
        /memory_pin needs entry/,
      );
    for (const pin of [undefined, "true", 1])
      expect(
        err({ verb: "memory_pin", params: { entry: "reviewer:experiences/a.md", pin } }),
      ).toMatch(/memory_pin needs pin/);
  });

  // MUTATION: delete the `MEMORY_PIN_PARAMS` check in `parseTuiAction`
  // (src/tui/actions.ts) — every request below parses as a plain pin.
  it("is bounded to pin and unpin: a request that reads like any other memory write is REFUSED, never quietly pinned", () => {
    for (const extra of [
      { text: "rewrite it" },
      { op: "retire" },
      { content: "x" },
      { tags: ["#pinned"] },
      { expect: "sha256:abc" },
    ])
      expect(
        err({
          verb: "memory_pin",
          params: { entry: "reviewer:experiences/a.md", pin: true, ...extra },
        }),
      ).toMatch(/memory_pin takes only entry and pin/);
    // No other memory-writing verb exists on the channel.
    for (const verb of [
      "memory_write",
      "memory_retire",
      "memory_edit",
      "memory_add",
      "memory_note",
    ])
      expect(err({ verb, params: { entry: "reviewer:experiences/a.md" } })).toContain(
        `unknown verb '${verb}'`,
      );
  });

  // The driver is the whole side-effect surface; its ONE memory method is
  // memoryPin(entry, pin). MUTATION: add a second memory method to TuiDriver
  // (memoryRetire, memoryWrite, …) — this fails.
  it("the driver carries exactly one memory method, and it takes nothing but the entry and the pin flag", () => {
    const source = readFileSync(join(process.cwd(), "src", "tui", "actions.ts"), "utf8");
    const driver = /export interface TuiDriver \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? "";
    expect(driver, "TuiDriver interface not found").not.toBe("");
    const memoryMethods = [...driver.matchAll(/^\s*(memory\w*)\(/gm)].map((m) => m[1]);
    expect(memoryMethods.sort()).toEqual(["memoryPin", "memoryView"]);
    expect(driver).toMatch(/memoryPin\(entry: string, pin: boolean\): Promise<string>;/);
  });

  it("waits for the store's answer and reports it — a refusal is a FAILED result", async () => {
    const { calls, driver } = mockDriver();
    await expect(
      executeTuiAction(
        { verb: "memory_pin", entry: "reviewer:experiences/a.md", pin: true },
        driver,
      ),
    ).resolves.toBe("companion ▸ memory pin → moved reviewer:experiences/a.md");
    expect(calls).toEqual([["memoryPin", "reviewer:experiences/a.md", true]]);

    const dir = mkdtempSync(join(tmpdir(), "tui-actions-pin-"));
    try {
      writeFileSync(
        join(dir, "2026-10-07T10-00-00-pin.json"),
        JSON.stringify({
          verb: "memory_pin",
          params: { entry: "reviewer:experiences/a.md", pin: false },
        }),
      );
      const refusing = mockDriver({
        memoryPin: () => Promise.reject(new Error("refused: the entry changed since you read it")),
      });
      const [res] = await processTuiActions(dir, refusing.driver);
      expect(res).toMatchObject({
        ok: false,
        message: expect.stringMatching(/changed since you read it/),
      });
      const result = JSON.parse(
        readFileSync(join(dir, "2026-10-07T10-00-00-pin.result.json"), "utf8"),
      );
      expect(result.ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// A message's result says what became of it: the sender's last word, not
// that it was handed over. MUTATION: fire-and-forget the send and return the
// trace at once — red (the undelivered message reads ok).
describe("msg_session / overseer_inject — the result waits for delivery", () => {
  it("an undelivered message is a failed result, a delivered one carries its label", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tui-actions-msg-"));
    try {
      writeFileSync(
        join(dir, "2026-10-07T10-00-00-msg.json"),
        JSON.stringify({ verb: "msg_session", params: { session: "pr-7", text: "hi" } }),
      );
      writeFileSync(
        join(dir, "2026-10-07T10-00-01-ov.json"),
        JSON.stringify({ verb: "overseer_inject", params: { text: "look" } }),
      );
      const { driver } = mockDriver({
        msgSession: () => Promise.reject(new Error("✖ msg pr-7 undelivered (write failed)")),
      });
      const [msg, ov] = await processTuiActions(dir, driver);
      expect(msg).toMatchObject({ ok: false, message: expect.stringContaining("undelivered") });
      const result = JSON.parse(
        readFileSync(join(dir, "2026-10-07T10-00-00-msg.result.json"), "utf8"),
      );
      expect(result.ok).toBe(false);
      expect(ov).toMatchObject({ ok: true, message: expect.stringContaining("delivered") });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("processTuiActions — the sweep", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  const mkDir = (): string => {
    dir = mkdtempSync(join(tmpdir(), "tui-actions-"));
    return dir;
  };
  const drop = (name: string, body: unknown): void => {
    writeFileSync(join(dir, name), typeof body === "string" ? body : JSON.stringify(body));
  };

  it("missing dir → empty result, no throw", async () => {
    const { driver } = mockDriver();
    expect(await processTuiActions("/nonexistent/tui-actions", driver)).toEqual([]);
  });

  it("executes instantly — no confirm step between parse and driver call", async () => {
    mkDir();
    drop("2026-08-20T12-00-00Z-a.json", { verb: "select_pr", params: { pr: 7 } });
    const { calls, driver } = mockDriver();
    const done = await processTuiActions(dir, driver);
    expect(calls).toEqual([["selectPr", 7]]);
    expect(done).toEqual([
      {
        file: "2026-08-20T12-00-00Z-a.json",
        ok: true,
        message: "companion ▸ board → #7",
        trace: "companion ▸ board → #7",
      },
    ]);
  });

  it("archives to .done/ BEFORE executing (crash mid-execute must not re-run)", async () => {
    mkDir();
    const name = "2026-08-20T12-00-00Z-b.json";
    drop(name, { verb: "switch_tab", params: { tab: "board" } });
    let archivedAtExecute = false;
    const { driver } = mockDriver({
      switchTab: () => {
        archivedAtExecute = existsSync(join(dir, ".done", name)) && !existsSync(join(dir, name));
      },
    });
    await processTuiActions(dir, driver);
    expect(archivedAtExecute).toBe(true);
  });

  it("a driver throw records a failed result — and the request is NOT re-run next sweep", async () => {
    mkDir();
    const name = "2026-08-20T12-00-00Z-c.json";
    drop(name, { verb: "deploy_tab", params: { action: "deploy" } });
    const boom = mockDriver({
      deployTab: () => {
        throw new Error("mid-execute crash");
      },
    });
    const first = await processTuiActions(dir, boom.driver);
    expect(first).toEqual([
      { file: name, ok: false, message: "execute failed: mid-execute crash" },
    ]);
    const result = JSON.parse(
      readFileSync(join(dir, `${name.replace(/\.json$/, "")}.result.json`), "utf8"),
    );
    expect(result).toEqual({ ok: false, message: "execute failed: mid-execute crash", file: name });
    // Second sweep: archived request is not visible, nothing runs again.
    const second = mockDriver();
    expect(await processTuiActions(dir, second.driver)).toEqual([]);
    expect(second.calls).toEqual([]);
  });

  it("malformed/unknown requests produce a refused result and never touch the driver", async () => {
    mkDir();
    drop("2026-08-20T12-00-00Z-bad1.json", "not json {{");
    drop("2026-08-20T12-00-00Z-bad2.json", { verb: "reboot_vm", params: {} });
    drop("2026-08-20T12-00-00Z-bad3.json", {
      verb: "msg_session",
      params: { session: "pr-9", text: "x".repeat(2001) },
    });
    const { calls, driver } = mockDriver();
    const done = await processTuiActions(dir, driver);
    expect(calls).toEqual([]);
    expect(done.map((r) => r.ok)).toEqual([false, false, false]);
    expect(done[0]!.message).toBe("refused: not JSON");
    expect(done[1]!.message).toContain("unknown verb");
    expect(done[2]!.message).toContain("2000");
    for (const r of done) {
      const res = JSON.parse(
        readFileSync(join(dir, `${r.file.replace(/\.json$/, "")}.result.json`), "utf8"),
      );
      expect(res.ok).toBe(false);
      expect(existsSync(join(dir, ".done", r.file))).toBe(true);
    }
  });

  it("processes files in name (iso-ts) order and skips existing .result.json files", async () => {
    mkDir();
    drop("2026-08-20T12-00-02Z-later.json", { verb: "switch_tab", params: { tab: "deploy" } });
    drop("2026-08-20T12-00-01Z-earlier.json", { verb: "switch_tab", params: { tab: "board" } });
    writeFileSync(join(dir, "2026-08-20T11-00-00Z-old.result.json"), "{}");
    const { calls, driver } = mockDriver();
    const done = await processTuiActions(dir, driver);
    expect(done.map((r) => r.file)).toEqual([
      "2026-08-20T12-00-01Z-earlier.json",
      "2026-08-20T12-00-02Z-later.json",
    ]);
    expect(calls).toEqual([
      ["switchTab", "board"],
      ["switchTab", "deploy"],
    ]);
  });

  it("housekeeping: stale result files swept, .done/ capped to the newest 200", async () => {
    mkDir();
    // A result file past its 24h TTL and a fresh one.
    const stale = join(dir, "2026-08-18T00-00-00Z-old.result.json");
    writeFileSync(stale, "{}");
    const past = (Date.now() - 25 * 3600 * 1000) / 1000;
    utimesSync(stale, past, past);
    const fresh = join(dir, "2026-08-20T10-00-00Z-new.result.json");
    writeFileSync(fresh, "{}");
    // 205 archived requests already in .done/.
    mkdirSync(join(dir, ".done"), { recursive: true });
    for (let i = 0; i < 205; i++) {
      writeFileSync(
        join(dir, ".done", `2026-08-19T00-00-00Z-${String(i).padStart(4, "0")}.json`),
        "{}",
      );
    }
    drop("2026-08-20T12-00-00Z-tick.json", { verb: "switch_tab", params: { tab: "board" } });
    const { driver } = mockDriver();
    await processTuiActions(dir, driver);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    const done = readdirSync(join(dir, ".done"));
    expect(done.length).toBe(200); // 206 present after the sweep archived one, oldest 6 dropped
    expect(done).toContain("2026-08-20T12-00-00Z-tick.json");
    expect(done).not.toContain("2026-08-19T00-00-00Z-0000.json");
  });
});
