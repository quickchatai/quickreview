// Writes that stick: a memory write that does not land on the first try is
// retried, ledgered or re-owed — never silently gone. Pinned here:
//
//   * a busy 409 is retried (jittered, ≤10 s); a precondition 409 is not;
//   * a named `note` is created at its deterministic address, and a replay
//     finds its own entry instead of minting a second one;
//   * the ledger records memory_state/attempts/last_error/uri; a write that
//     committed but timed out is backfilled EXACTLY once; a signal received
//     before the engine was ready ends up written; the pump writes ≤20 a tick
//     and only while memory is healthy; legacy losses (rows with no memory
//     state) are backfilled without duplicating entries that landed after all;
//   * `memory_write_backlog` wakes past 2 h;
//   * a drain DEFERS the EOD sweep — across a restart too — and a failed
//     inject is retried 3× before `eod_inject_failed` wakes.
//
// The vendored extension's half (patch 0006) is pinned in
// tests/openviking-fork.test.ts. All I/O is faked.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnomalyWakePolicy, detailKeyedKinds, wakeKinds } from "../src/anomalies.js";
import { MEMORY_DEFAULTS } from "../src/config.js";
import { EOD_DEFAULTS, startEodTimer } from "../src/eod.js";
import { startEodPinWatch } from "../src/eodpinwatch.js";
import {
  FEEDBACK_EVENTS_CATEGORY,
  FEEDBACK_MEMORY_MAX_ATTEMPTS,
  FeedbackEngine,
  FeedbackMemoryPump,
  MEMORY_WRITE_BACKLOG_KIND,
  feedbackEntryName,
  legacyFeedbackEntry,
  ledgerFeedbackSignal,
  memoryEntryFor,
  memoryEntryForRow,
  type FeedbackEvent,
} from "../src/feedback.js";
import {
  feedbackWritesPhrase,
  memoryStatusLine,
  pendingMemoryStatus,
} from "../src/memory/health.js";
import type { MemoryEntry, MemoryOp, MemoryStore, MemoryWriteResult } from "../src/memory/store.js";
import {
  BUSY_RETRY_DEFAULTS,
  OpenVikingClient,
  busyRetryDelay,
  isBusyConflict,
  type HttpFetch,
  type OvRequestRecord,
} from "../src/openviking/client.js";
import { OpenVikingStore, entryFrom, sha256Prefixed } from "../src/openviking/store.js";
import { StateStore } from "../src/state.js";
import { listedFileStat } from "./helpers/ov-listing.js";

const TZ = "Europe/Warsaw";
const KEY = "cWNy.cmV2aWV3ZXI.a2V5LWZvci10ZXN0cy1vbmx5LW5vdC1hLXJlYWwta2V5";
const BASE = "http://127.0.0.1:1933";
const ROOT = "viking://user/reviewer/memories";

// ---- an HTTP fake with the REAL batch-write semantics ------------------------

interface BatchBody {
  root_uri: string;
  operations: Array<{
    uri: string;
    content: string;
    precondition: { kind: string; base_hash?: string };
  }>;
  wait: boolean;
}

function json(status: number, body: unknown) {
  const raw = JSON.stringify(body);
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(raw),
  });
}

const BUSY = {
  status: "error",
  result: null,
  error: {
    code: "CONFLICT",
    message: "resource is busy and cannot be written now: viking://user/reviewer/memories/events",
    details: { conflict_type: "path_busy", retryable: true, uri: `${ROOT}/events` },
  },
};

const PRECONDITION = {
  status: "error",
  result: null,
  error: {
    code: "CONFLICT",
    message: "Batch write replace precondition failed; content hash changed.",
    details: { resource: `${ROOT}/events/x.md` },
  },
};

/** The handful of endpoints the store speaks, with OpenViking 0.4.15's own
 * batch-write semantics (storage/content_write.py): identical bytes on an
 * existing target are `unchanged` (no conflict, whatever the precondition);
 * `create_if_absent` on DIFFERENT bytes is a precondition 409; the root must
 * exist; and `busyNext` answers that many writes with the busy 409. */
class FakeServer {
  files = new Map<string, string>();
  dirs = new Set<string>([`${ROOT}/experiences`]);
  calls: Array<{ path: string; body: unknown }> = [];
  busyNext = 0;

  readonly fetch: HttpFetch = async (url, init) => {
    const u = new URL(url);
    const body: unknown = init.body === undefined ? undefined : JSON.parse(init.body);
    this.calls.push({ path: u.pathname, body });
    if (u.pathname === "/api/v1/content/batch-write") return this.batchWrite(body as BatchBody);
    if (u.pathname === "/api/v1/fs/mkdir") {
      const uri = (body as { uri: string }).uri;
      if (this.dirs.has(uri))
        return json(409, {
          status: "error",
          error: { code: "CONFLICT", message: "already exists" },
        });
      this.dirs.add(uri);
      return json(200, { status: "ok", result: { uri } });
    }
    if (u.pathname === "/api/v1/fs/attrs/set_tags") return json(200, { status: "ok", result: {} });
    if (u.pathname === "/api/v1/content/read") {
      const c = this.files.get(u.searchParams.get("uri") ?? "");
      return c === undefined
        ? json(404, { status: "error", error: { code: "NOT_FOUND", message: "nope" } })
        : json(200, { status: "ok", result: c });
    }
    if (u.pathname === "/api/v1/fs/ls") {
      const prefix = `${u.searchParams.get("uri")}/`;
      const rows: unknown[] = [];
      const subdirs = new Set<string>();
      for (const [k, content] of this.files) {
        if (!k.startsWith(prefix)) continue;
        const rest = k.slice(prefix.length);
        if (rest.includes("/")) subdirs.add(rest.split("/")[0]!);
        else rows.push({ uri: k, name: rest, isDir: false, ...listedFileStat(content) });
      }
      for (const d of subdirs)
        rows.push({ uri: `${prefix}${d}`, name: d, isDir: true, size: 0, modTime: "" });
      return json(200, { status: "ok", result: rows });
    }
    return json(404, { status: "error", error: { code: "NOT_FOUND", message: "no route" } });
  };

  private batchWrite(req: BatchBody) {
    if (this.busyNext > 0) {
      this.busyNext -= 1;
      return json(409, BUSY);
    }
    if (!this.dirs.has(req.root_uri))
      return json(404, { status: "error", error: { code: "NOT_FOUND", message: req.root_uri } });
    const unchanged: string[] = [];
    const pending: BatchBody["operations"] = [];
    for (const op of req.operations) {
      const existing = this.files.get(op.uri);
      if (existing !== undefined && existing === op.content) {
        unchanged.push(op.uri);
        continue;
      }
      if (op.precondition.kind === "create_if_absent" && existing !== undefined) {
        return json(409, {
          status: "error",
          error: {
            code: "CONFLICT",
            message: "Batch write create precondition failed; target already exists.",
          },
        });
      }
      if (
        op.precondition.kind === "replace_if_hash" &&
        sha256Prefixed(existing ?? "") !== op.precondition.base_hash
      )
        return json(409, PRECONDITION);
      pending.push(op);
    }
    const created: string[] = [];
    const updated: string[] = [];
    for (const op of pending) {
      (this.files.has(op.uri) ? updated : created).push(op.uri);
      this.files.set(op.uri, op.content);
    }
    return json(200, {
      status: "ok",
      result: { root_uri: req.root_uri, created, updated, unchanged },
    });
  }
}

function client(
  server: FakeServer,
  extra: Partial<ConstructorParameters<typeof OpenVikingClient>[0]> = {},
) {
  const sleeps: number[] = [];
  const records: OvRequestRecord[] = [];
  const gaps: string[] = [];
  let clock = 0;
  const c = new OpenVikingClient({
    baseUrl: BASE,
    apiKey: KEY,
    fetchFn: server.fetch,
    clock: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    random: () => 0.5,
    onRequest: (r) => records.push(r),
    onGap: (g) => gaps.push(`${g.op}:${g.code}`),
    ...extra,
  });
  return { client: c, sleeps, records, gaps };
}

// ---- 1. the 409 classification ----------------------------------------------

describe("the client tells a busy 409 from a precondition 409", () => {
  it("classifies on details.conflict_type alone — the status and code are the same", () => {
    expect(isBusyConflict(409, BUSY.error)).toBe(true);
    expect(isBusyConflict(409, PRECONDITION.error)).toBe(false);
    expect(isBusyConflict(409, { code: "CONFLICT", message: "resource is busy" })).toBe(false);
    expect(isBusyConflict(500, BUSY.error)).toBe(false);
    expect(isBusyConflict(409, null)).toBe(false);
  });

  it("RETRIES a busy answer with jittered backoff and lands the write", async () => {
    const server = new FakeServer();
    server.dirs.add(`${ROOT}/events`);
    server.busyNext = 2;
    const { client: c, sleeps, records, gaps } = client(server);
    const uri = `${ROOT}/events/a.md`;
    const res = await c.batchWrite({
      root_uri: `${ROOT}/events`,
      operations: [{ uri, content: "x\n", precondition: { kind: "create_if_absent" } }],
      wait: false,
    });
    expect(res.ok).toBe(true);
    expect(server.files.get(uri)).toBe("x\n");
    expect(sleeps).toEqual([busyRetryDelay(0, () => 0.5), busyRetryDelay(1, () => 0.5)]);
    // Each retried busy answer is an ANSWER (the server is up and took the
    // key) — counted, never a failure and never a gap.
    expect(records.map((r) => r.outcome)).toEqual(["conflict", "conflict", "ok"]);
    expect(gaps).toEqual([]);
  });

  it("gives up within the bound and returns busy — never conflict", async () => {
    const server = new FakeServer();
    server.dirs.add(`${ROOT}/events`);
    server.busyNext = 99;
    const { client: c, sleeps, records, gaps } = client(server);
    const res = await c.batchWrite({
      root_uri: `${ROOT}/events`,
      operations: [
        { uri: `${ROOT}/events/a.md`, content: "x\n", precondition: { kind: "create_if_absent" } },
      ],
      wait: false,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.busy).toBe(true);
    expect(res.conflict).toBe(false);
    expect(res.message).toContain("still busy");
    expect(sleeps.length).toBeLessThanOrEqual(BUSY_RETRY_DEFAULTS.retries);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(BUSY_RETRY_DEFAULTS.budgetMs);
    // The exhausted busy is the one failure: one gap, one failed record.
    expect(gaps).toEqual(["batch_write:path_busy"]);
    expect(records.at(-1)!.outcome).toBe("failed");
  });

  it("never retries a precondition 409 — it stays a refusal", async () => {
    const server = new FakeServer();
    server.files.set(`${ROOT}/experiences/x.md`, "old\n");
    const { client: c, sleeps } = client(server);
    const res = await c.batchWrite({
      root_uri: `${ROOT}/experiences`,
      operations: [
        {
          uri: `${ROOT}/experiences/x.md`,
          content: "new\n",
          precondition: { kind: "replace_if_hash", base_hash: sha256Prefixed("stale\n") },
        },
      ],
      wait: false,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.conflict).toBe(true);
    expect(res.busy).toBe(false);
    expect(sleeps).toEqual([]);
    expect(server.calls.filter((c2) => c2.path === "/api/v1/content/batch-write")).toHaveLength(1);
  });

  it("bounds the whole retry by the time budget, not just the count", async () => {
    const server = new FakeServer();
    server.busyNext = 99;
    // Each request itself takes 4 s: the budget, not the retry count, stops it.
    let clock = 0;
    const slow: HttpFetch = async (url, init) => {
      clock += 4000;
      return server.fetch(url, init);
    };
    const sleeps: number[] = [];
    const c = new OpenVikingClient({
      baseUrl: BASE,
      apiKey: KEY,
      fetchFn: slow,
      clock: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      random: () => 1,
    });
    const res = await c.batchWrite({
      root_uri: `${ROOT}/events`,
      operations: [
        { uri: `${ROOT}/events/a.md`, content: "x\n", precondition: { kind: "create_if_absent" } },
      ],
      wait: false,
    });
    expect(res.ok).toBe(false);
    expect(clock).toBeLessThanOrEqual(BUSY_RETRY_DEFAULTS.budgetMs + 4000);
    expect(sleeps.length).toBeLessThan(BUSY_RETRY_DEFAULTS.retries);
  });

  it("jitters each wait into [½, 1] of a capped exponential step", () => {
    for (let retry = 0; retry < 6; retry += 1) {
      const step = Math.min(BUSY_RETRY_DEFAULTS.capMs, BUSY_RETRY_DEFAULTS.baseMs * 2 ** retry);
      expect(busyRetryDelay(retry, () => 0)).toBe(Math.round(step / 2));
      expect(busyRetryDelay(retry, () => 1)).toBe(step);
    }
  });

  it("a busy mkdir is NOT a directory that exists (only the precondition 409 is)", async () => {
    const busyOnce = new FakeServer();
    let first = true;
    const f: HttpFetch = async (url, init) =>
      new URL(url).pathname === "/api/v1/fs/mkdir" && first
        ? ((first = false), json(409, BUSY))
        : busyOnce.fetch(url, init);
    const c = new OpenVikingClient({
      baseUrl: BASE,
      apiKey: KEY,
      fetchFn: f,
      busyRetry: { retries: 0 },
    });
    expect(await c.mkdir(`${ROOT}/events`)).toBe(false);
    expect(await c.mkdir(`${ROOT}/events`)).toBe(true); // created now
    expect(await c.mkdir(`${ROOT}/events`)).toBe(true); // "already exists" — fine
  });
});

// ---- 2. a named note: the idempotent writer's address -------------------------

describe("a named note is created at exactly its address, or found there", () => {
  let server: FakeServer;
  let store: OpenVikingStore;
  beforeEach(() => {
    server = new FakeServer();
    store = new OpenVikingStore({
      client: client(server).client,
      now: () => new Date("2026-10-06T10:00:00Z"),
    });
  });

  it("writes create_if_absent at <category>/<name>.md and says where", async () => {
    const res = await store.apply({
      op: "note",
      text: "#feedback kind=feedback hi",
      name: "fb-x-1-2",
      category: "events",
    });
    expect(res).toMatchObject({ ok: true, uri: `${ROOT}/events/fb-x-1-2.md` });
    const write = server.calls.find(
      (c) =>
        c.path === "/api/v1/content/batch-write" &&
        (c.body as BatchBody).root_uri.endsWith("/events"),
    )!;
    expect((write.body as BatchBody).operations[0]!.precondition).toEqual({
      kind: "create_if_absent",
    });
    // The events/ root did not exist: it was made once and the write retried.
    expect(server.dirs.has(`${ROOT}/events`)).toBe(true);
    expect([...server.files.keys()]).toEqual([`${ROOT}/events/fb-x-1-2.md`]);
  });

  it("a REPLAY of the same bytes finds its own entry — one entry, never two", async () => {
    const op: MemoryOp = {
      op: "note",
      text: "#feedback same",
      name: "fb-a-1-1",
      category: "events",
    };
    expect((await store.apply(op)).ok).toBe(true);
    const again = await store.apply(op);
    expect(again.ok).toBe(true);
    expect(again.message).toContain("already present");
    expect(server.files.size).toBe(1);
  });

  it("an entry already there with OTHER bytes is kept, untouched, and reported existed", async () => {
    server.dirs.add(`${ROOT}/events`);
    server.files.set(`${ROOT}/events/fb-a-1-1.md`, "#feedback the older rendering\n");
    const res = await store.apply({
      op: "note",
      text: "#feedback a newer rendering",
      name: "fb-a-1-1",
      category: "events",
    });
    expect(res).toMatchObject({ ok: true, existed: true });
    expect(server.files.get(`${ROOT}/events/fb-a-1-1.md`)).toBe("#feedback the older rendering\n");
    expect(server.files.size).toBe(1);
  });

  it("a busy directory is retried and the named write lands", async () => {
    server.dirs.add(`${ROOT}/events`);
    server.busyNext = 1;
    const res = await store.apply({
      op: "note",
      text: "#feedback busy once",
      name: "fb-b-1-1",
      category: "events",
    });
    expect(res.ok).toBe(true);
    expect(server.files.has(`${ROOT}/events/fb-b-1-1.md`)).toBe(true);
  });

  it("a directory still busy after the client's last retry is a FAILURE — never `existed`", async () => {
    // Only the precondition 409 means "an entry is already there". A busy
    // answer the retries could not get past wrote nothing; reading it as
    // `existed` would mark a feedback row written with no entry anywhere.
    server.dirs.add(`${ROOT}/events`);
    server.busyNext = 99;
    const res = await store.apply({
      op: "note",
      text: "#feedback stays busy",
      name: "fb-c-1-1",
      category: "events",
    });
    expect(res.ok).toBe(false);
    expect(res.existed).toBeUndefined();
    expect(res.message).toContain("still busy");
    expect(server.files.size).toBe(0);
  });

  it("refuses an address it cannot spell", async () => {
    for (const bad of [
      { name: "../escape", category: "events" },
      { name: "a b", category: "events" },
      { name: "ok", category: "Events/../x" },
      { name: "ok", category: "" },
      // No name: the AREA alone must be spellable (CATEGORY_RE).
      { category: "../escape" },
      { category: "Events" },
    ]) {
      const res = await store.apply({ op: "note", text: "#x y", ...bad });
      expect(res.ok).toBe(false);
    }
    expect(server.files.size).toBe(0);
    expect(server.calls.filter((c) => c.path === "/api/v1/content/batch-write")).toEqual([]);
  });

  it("a plain note still lands under a fresh name in the default area", async () => {
    const res = await store.apply({ op: "note", text: "#x plain" });
    expect(res.ok).toBe(true);
    expect([...server.files.keys()][0]).toMatch(/\/experiences\/20261006T100000-[0-9a-f]{8}\.md$/);
  });
});

// ---- 3. the ledger records what memory owes ----------------------------------

const comment = (id: number, pr = 5583): FeedbackEvent => ({
  kind: "feedback_comment",
  pr,
  comment_id: id,
  in_reply_to_id: null,
  author: "a-teammate",
  body: "[feedback] you should assume whoever deploys will publish the prompt change",
  scope: "issue_comment",
});

/** A seam fake with the store's named-note semantics, and dials. */
class FakeMemory implements MemoryStore {
  entries = new Map<string, string>();
  applied: MemoryOp[] = [];
  /** Resolve this many applies only after the test lets them (they still LAND). */
  hold = 0;
  private released: Array<() => void> = [];
  refuse: string | null = null;
  throwNext = 0;

  async read(): Promise<MemoryEntry[]> {
    return [...this.entries.entries()].map(([id, text]) =>
      entryFrom(id, text, "2026-10-06T00:00:00Z"),
    );
  }
  async search(): Promise<MemoryEntry[]> {
    return this.read();
  }
  uriOf(id: string): string {
    return `${ROOT}/${id}`;
  }
  release(): void {
    for (const r of this.released.splice(0)) r();
  }
  async apply(op: MemoryOp): Promise<MemoryWriteResult> {
    this.applied.push(op);
    if (this.throwNext > 0) {
      this.throwNext -= 1;
      throw new Error("ECONNREFUSED 127.0.0.1:1933");
    }
    if (this.refuse) return { ok: false, message: this.refuse };
    if (op.op !== "note") return { ok: false, message: "unsupported" };
    const id = `${op.category ?? "experiences"}/${op.name ?? `n${this.entries.size}`}.md`;
    const prior = this.entries.get(id);
    const body = `${op.text.trim()}\n`;
    const result: MemoryWriteResult =
      prior === undefined || prior === body
        ? {
            ok: true,
            message: prior === undefined ? `wrote ${id}` : `already present: ${id}`,
            uri: this.uriOf(id),
          }
        : { ok: true, existed: true, message: `kept ${id}`, uri: this.uriOf(id) };
    if (prior === undefined) this.entries.set(id, body); // it LANDS, whenever the answer comes back
    if (this.hold > 0) {
      this.hold -= 1;
      await new Promise<void>((r) => this.released.push(r));
    }
    return result;
  }
}

describe("feedback_signals records the memory write (memory_state/attempts/last_error/uri)", () => {
  let store: StateStore;
  beforeEach(() => {
    store = new StateStore(":memory:");
  });
  afterEach(() => store.close());

  it("a written signal names its deterministic entry in events/", async () => {
    const memory = new FakeMemory();
    const engine = new FeedbackEngine({ store, timezone: TZ, rebuildAgents: vi.fn(), memory });
    expect(await engine.ingest(comment(9))).toBe("recorded");
    const row = store.pendingFeedbackMemory(10)[0];
    expect(row).toBeUndefined();
    const all = store.feedbackSignalsSince("");
    expect(all).toHaveLength(1);
    const r = all[0]!;
    expect(r.memory_state).toBe("written");
    expect(r.memory_attempts).toBe(1);
    expect(r.memory_last_error).toBeNull();
    const name = feedbackEntryName(r);
    expect(name).toMatch(new RegExp(`^\\d{8}T\\d{6}-fb-feedback_comment-5583-${r.id}$`));
    expect(r.memory_uri).toBe(`${ROOT}/${FEEDBACK_EVENTS_CATEGORY}/${name}.md`);
    const op = memory.applied[0] as Extract<MemoryOp, { op: "note" }>;
    expect(op).toMatchObject({ op: "note", category: "events", name });
    // The entry is the signal's rendering, from the ledger row alone.
    expect(op.text).toBe(memoryEntryForRow(r));
    expect(op.text).toBe(memoryEntryFor(comment(9), r.day));
  });

  it("a failed write leaves the row OWED with its error, never lost", async () => {
    const memory = new FakeMemory();
    memory.refuse = "memory write failed: UNAUTHENTICATED Invalid API Key";
    const engine = new FeedbackEngine({ store, timezone: TZ, rebuildAgents: vi.fn(), memory });
    await engine.ingest(comment(9));
    const owed = store.pendingFeedbackMemory(10);
    expect(owed).toHaveLength(1);
    expect(owed[0]).toMatchObject({ memory_state: "pending", memory_attempts: 1 });
    expect(owed[0]!.memory_last_error).toContain("Invalid API Key");
    const ev = store.recentEvents(10).find((e) => e.kind === "feedback_memory_write_failed")!;
    expect(JSON.parse(ev.payload!)).toMatchObject({ signal: owed[0]!.id, attempt: 1 });
  });

  it("memory switched off ledgers the row `skipped` and writes nothing", async () => {
    const memory = new FakeMemory();
    const engine = new FeedbackEngine({
      store,
      timezone: TZ,
      rebuildAgents: vi.fn(),
      memory,
      memoryEnabled: false,
    });
    await engine.ingest(comment(9));
    expect(memory.applied).toEqual([]);
    const r = store.feedbackSignalsSince("")[0]!;
    expect(r.memory_state).toBe("skipped");
    expect(r.memory_last_error).toContain("enabled = false");
    expect(store.feedbackMemoryBacklog().pending).toBe(0);
  });

  it("only a PENDING row moves — a late answer cannot undo a settled one", () => {
    const row = store.recordFeedbackSignalRow({
      kind: "merged_over_block",
      pr: 1,
      day: "2026-10-06",
    })!;
    expect(store.markFeedbackMemory(row.id, { state: "written", uri: "u" })).toBe(true);
    expect(store.markFeedbackMemory(row.id, { state: "pending", error: "late timeout" })).toBe(
      false,
    );
    expect(store.feedbackSignal(row.id)).toMatchObject({
      memory_state: "written",
      memory_uri: "u",
      memory_last_error: null,
    });
  });
});

describe("every signal kind renders the same entry from its ledger row as from its event", () => {
  // The ingest and every backfill render from the ROW (memoryEntryForRow),
  // so a field the row loses is a field every entry loses — written and
  // backfilled alike.
  const events: FeedbackEvent[] = [
    comment(11),
    {
      kind: "feedback_comment",
      pr: 5583,
      comment_id: 12,
      in_reply_to_id: 11,
      author: "b-teammate",
      body: "[feedback] inline reply",
      scope: "review_comment",
    },
    { kind: "review_set_aside", pr: 5584, review_id: 9001, by: "c-teammate", stale: false },
    { kind: "merged_over_block", pr: 5585 },
    { kind: "bot_comment_deleted", pr: 5586, comment_id: 4242 },
    { kind: "trigger_withdrawn", pr: 5587, by: "d-teammate" },
  ];

  it.each(events.map((e) => [e.kind, e] as const))("%s", (_kind, e) => {
    const store = new StateStore(":memory:");
    const res = ledgerFeedbackSignal(store, e, { timezone: TZ });
    expect(res.result).toBe("recorded");
    const row = res.row!;
    expect(memoryEntryForRow(row)).toBe(memoryEntryFor(e, row.day));
    store.close();
  });

  it("covers every kind the event union has", () => {
    expect(new Set(events.map((e) => e.kind))).toEqual(
      new Set([
        "feedback_comment",
        "review_set_aside",
        "merged_over_block",
        "bot_comment_deleted",
        "trigger_withdrawn",
      ]),
    );
  });
});

describe("a write the store could not land stays OWED, end to end", () => {
  it("a directory busy past every retry leaves the row pending with that error", async () => {
    const store = new StateStore(":memory:");
    const server = new FakeServer();
    server.dirs.add(`${ROOT}/events`);
    server.busyNext = 1_000;
    const memory = new OpenVikingStore({
      client: client(server).client,
      now: () => new Date("2026-10-06T10:00:00Z"),
    });
    const engine = new FeedbackEngine({ store, timezone: TZ, rebuildAgents: vi.fn(), memory });
    expect(await engine.ingest(comment(9))).toBe("recorded");
    const row = store.feedbackSignalsSince("")[0]!;
    expect(row.memory_state).toBe("pending");
    expect(row.memory_uri).toBeNull();
    expect(row.memory_last_error).toContain("still busy");
    expect(server.files.size).toBe(0);
    store.close();
  });
});

describe("a commit that times out is backfilled EXACTLY once", () => {
  it("the deadline leaves the row pending; the replay finds the landed entry", async () => {
    const store = new StateStore(":memory:");
    const memory = new FakeMemory();
    memory.hold = 1; // the write LANDS but its answer outlives the deadline
    const engine = new FeedbackEngine({
      store,
      timezone: TZ,
      rebuildAgents: vi.fn(),
      memory,
      memoryTimeoutMs: 5,
    });
    await engine.ingest(comment(9));
    expect(store.pendingFeedbackMemory(5)).toHaveLength(1);
    expect(store.pendingFeedbackMemory(5)[0]!.memory_last_error).toContain("timed out");
    expect(memory.entries.size).toBe(1); // it did land
    memory.release();

    const pump = new FeedbackMemoryPump({ store, memory, healthy: () => true, wake: vi.fn() });
    const tick = await pump.tick();
    expect(tick).toMatchObject({ attempted: 1, written: 1 });
    expect(memory.entries.size).toBe(1); // the replay did NOT mint a second entry
    expect(store.feedbackSignalsSince("")[0]).toMatchObject({
      memory_state: "written",
      memory_attempts: 2,
    });
    // And nothing is owed any more: a second tick writes nothing.
    expect(await pump.tick()).toMatchObject({ attempted: 0, written: 0 });
    store.close();
  });
});

describe("a signal received before the engine is ready ends up written", () => {
  it("is ledgered pending (never dropped), and the pump writes it", async () => {
    const store = new StateStore(":memory:");
    const res = ledgerFeedbackSignal(store, comment(9), { timezone: TZ });
    expect(res.result).toBe("recorded");
    expect(res.row).toMatchObject({ memory_state: "pending", memory_attempts: 0 });
    // A redelivery is still a duplicate, engine or not.
    expect(ledgerFeedbackSignal(store, comment(9), { timezone: TZ }).result).toBe("duplicate");
    const memory = new FakeMemory();
    const pump = new FeedbackMemoryPump({ store, memory, healthy: () => true, wake: vi.fn() });
    expect(await pump.tick()).toMatchObject({ written: 1 });
    expect(store.feedbackSignalsSince("")[0]!.memory_state).toBe("written");
    store.close();
  });

  it("wire.ts ledgers a pre-engine signal instead of dropping it", async () => {
    const { readFileSync } = await import("node:fs");
    const wire = readFileSync(join(process.cwd(), "src", "wire.ts"), "utf8");
    expect(wire).not.toContain("signal before engine ready — dropped");
    expect(wire).toMatch(/if \(!feedback\) \{[\s\S]*?ledgerFeedbackSignal\(daemon\.store, e,/);
    // Memory switched off: the boot-gap row is `skipped`, never owed to a
    // pump that does not exist.
    expect(wire).toMatch(
      /ledgerFeedbackSignal\(daemon\.store, e, \{[^}]*memoryEnabled: cfg\.openviking\.enabled,/,
    );
    // A boot-gap signal reaches the same-day addendum: it is remembered…
    expect(wire).toMatch(/if \(res\.result === "recorded"\) feedbackLedgeredEarly = true;/);
    // …and the agents are rebuilt once the engine exists.
    expect(wire).toMatch(
      /new FeedbackEngine\(\{[\s\S]{0,800}?if \(feedbackLedgeredEarly\) \{\s*try \{\s*rebuildAgents\(\);/,
    );
  });
});

describe("the backfill pump", () => {
  let store: StateStore;
  let clock: Date;
  beforeEach(() => {
    clock = new Date("2026-10-06T08:00:00Z");
    store = new StateStore(":memory:", () => clock);
  });
  afterEach(() => store.close());

  it("writes nothing while memory is not healthy — and still checks the backlog", async () => {
    ledgerFeedbackSignal(store, comment(1), { timezone: TZ, now: clock });
    const memory = new FakeMemory();
    const pump = new FeedbackMemoryPump({
      store,
      memory,
      healthy: () => false,
      wake: vi.fn(),
      now: () => clock,
    });
    expect(await pump.tick()).toMatchObject({ held: true, attempted: 0, pending: 1 });
    expect(memory.applied).toEqual([]);
  });

  it("writes at most 20 rows a tick, oldest first", async () => {
    for (let i = 1; i <= 25; i += 1)
      ledgerFeedbackSignal(store, comment(i), { timezone: TZ, now: clock });
    const memory = new FakeMemory();
    const pump = new FeedbackMemoryPump({
      store,
      memory,
      healthy: () => true,
      wake: vi.fn(),
      now: () => clock,
    });
    expect(await pump.tick()).toMatchObject({ written: 20, pending: 5 });
    const firstNames = memory.applied.map((o) => (o as { name?: string }).name ?? "");
    expect(firstNames[0]).toContain("-fb-feedback_comment-5583-1");
    expect(await pump.tick()).toMatchObject({ written: 5, pending: 0 });
    expect(memory.entries.size).toBe(25);
  });

  it("ends a tick early when memory plainly refuses writes", async () => {
    for (let i = 1; i <= 10; i += 1)
      ledgerFeedbackSignal(store, comment(i), { timezone: TZ, now: clock });
    const memory = new FakeMemory();
    memory.refuse = "memory write failed: transport";
    const pump = new FeedbackMemoryPump({
      store,
      memory,
      healthy: () => true,
      wake: vi.fn(),
      now: () => clock,
    });
    expect(await pump.tick()).toMatchObject({ attempted: 3, written: 0 });
  });

  it("wakes memory_write_backlog when the oldest owed row passes 2 h — once, then every 6 h", async () => {
    ledgerFeedbackSignal(store, comment(1), { timezone: TZ, now: clock });
    const wake = vi.fn();
    const memory = new FakeMemory();
    let healthy = false;
    const pump = new FeedbackMemoryPump({
      store,
      memory,
      healthy: () => healthy,
      healthState: () => (healthy ? "healthy" : "down"),
      wake,
      now: () => clock,
    });
    clock = new Date("2026-10-06T09:59:00Z");
    await pump.tick();
    expect(wake).not.toHaveBeenCalled();
    clock = new Date("2026-10-06T10:01:00Z");
    await pump.tick();
    expect(wake).toHaveBeenCalledTimes(1);
    const [kind, detail, message] = wake.mock.calls[0]!;
    expect(kind).toBe(MEMORY_WRITE_BACKLOG_KIND);
    expect(detail).toContain("1 feedback signal(s) owed to memory");
    expect(message).toContain("Memory health: down");
    expect(message).toContain("Nothing is lost");
    clock = new Date("2026-10-06T15:00:00Z");
    await pump.tick();
    expect(wake).toHaveBeenCalledTimes(1);
    clock = new Date("2026-10-06T16:02:00Z");
    await pump.tick();
    expect(wake).toHaveBeenCalledTimes(2);
    // Memory recovers: the row is written and the backlog clears.
    healthy = true;
    expect(await pump.tick()).toMatchObject({ written: 1, pending: 0 });
    expect(wake).toHaveBeenCalledTimes(2);
  });

  it("gives a row up after the cap — failed, one wake for the tick", async () => {
    ledgerFeedbackSignal(store, comment(1), { timezone: TZ, now: clock });
    ledgerFeedbackSignal(store, comment(2), { timezone: TZ, now: clock });
    const wake = vi.fn();
    const memory = new FakeMemory();
    memory.refuse = "memory write failed: HTTP 413 payload too large";
    const pump = new FeedbackMemoryPump({
      store,
      memory,
      healthy: () => true,
      wake,
      now: () => clock,
      maxAttempts: 2,
    });
    await pump.tick();
    expect(store.feedbackMemoryBacklog()).toMatchObject({ pending: 2, failed: 0 });
    await pump.tick();
    expect(store.feedbackMemoryBacklog()).toMatchObject({ pending: 0, failed: 2 });
    const giveUps = wake.mock.calls.filter(([, detail]) => String(detail).startsWith("gave up"));
    expect(giveUps).toHaveLength(1);
    expect(giveUps[0]![1]).toContain("gave up on 2 feedback signal(s)");
    expect(giveUps[0]![2]).toContain("memory_state = failed");
    // A given-up row is not retried by this pump before a day has passed.
    memory.refuse = null;
    expect(await pump.tick()).toMatchObject({ attempted: 0 });
    expect(FEEDBACK_MEMORY_MAX_ATTEMPTS).toBeGreaterThanOrEqual(10);
  });

  it("a given-up row goes back in the queue — on a start's first healthy tick, and daily", async () => {
    ledgerFeedbackSignal(store, comment(1), { timezone: TZ, now: clock });
    const wake = vi.fn();
    const memory = new FakeMemory();
    memory.refuse = "memory write failed: HTTP 500 events/ refused";
    const deps = {
      store,
      memory,
      healthy: () => true,
      wake,
      now: () => clock,
      maxAttempts: 2,
    };
    const pump = new FeedbackMemoryPump(deps);
    await pump.tick();
    await pump.tick();
    expect(store.feedbackMemoryBacklog()).toMatchObject({ pending: 0, failed: 1 });
    expect(wake.mock.calls.at(-1)![2]).toContain("go back in the queue");
    // The cause is fixed (a deploy). The same process waits for the daily
    // re-queue; the give-up is never a permanent exclusion.
    memory.refuse = null;
    clock = new Date(clock.getTime() + 23 * 3_600_000);
    expect(await pump.tick()).toMatchObject({ attempted: 0 });
    clock = new Date(clock.getTime() + 2 * 3_600_000);
    expect(await pump.tick()).toMatchObject({ requeued: 1, written: 1, pending: 0 });
    const row = store.feedbackSignalsSince("")[0]!;
    expect(row.memory_state).toBe("written");
    expect(store.recentEvents(50).some((e) => e.kind === "feedback_memory_requeued")).toBe(true);

    // A restart re-queues at once: a deploy is what usually fixes the cause.
    ledgerFeedbackSignal(store, comment(2), { timezone: TZ, now: clock });
    memory.refuse = "memory write failed: HTTP 500 events/ refused";
    const again = new FeedbackMemoryPump(deps);
    await again.tick();
    await again.tick();
    expect(store.feedbackMemoryBacklog()).toMatchObject({ failed: 1 });
    memory.refuse = null;
    const restarted = new FeedbackMemoryPump(deps);
    expect(await restarted.tick()).toMatchObject({ requeued: 1, written: 1 });
    expect(store.feedbackMemoryBacklog()).toMatchObject({ pending: 0, failed: 0 });
  });

  it("re-queued rows are owed from the re-queue, not from the signal's date", async () => {
    ledgerFeedbackSignal(store, comment(1), { timezone: TZ, now: clock });
    const memory = new FakeMemory();
    memory.refuse = "memory write failed: HTTP 500";
    const wake = vi.fn();
    const pump = new FeedbackMemoryPump({
      store,
      memory,
      healthy: () => true,
      wake,
      now: () => clock,
      maxAttempts: 1,
    });
    await pump.tick(); // given up at once
    clock = new Date(clock.getTime() + 30 * 24 * 3_600_000); // a month on
    await pump.tick(); // re-queued, fails again (attempt 1 of 1 → failed)
    wake.mockClear();
    const restarted = new FeedbackMemoryPump({
      store,
      memory,
      healthy: () => true,
      wake,
      now: () => clock,
      maxAttempts: 5,
    });
    await restarted.tick(); // re-queued now: owed for 0 minutes
    expect(store.feedbackMemoryBacklog()).toMatchObject({ pending: 1 });
    expect(store.feedbackMemoryBacklog().oldest_pending_at).toBe(clock.toISOString());
    expect(
      wake.mock.calls.filter(
        ([kind, d]) => kind === MEMORY_WRITE_BACKLOG_KIND && !String(d).startsWith("gave up"),
      ),
    ).toEqual([]);
  });

  it("does not judge the backlog while memory health is UNKNOWN (its boot grace)", async () => {
    ledgerFeedbackSignal(store, comment(1), { timezone: TZ, now: clock });
    const wake = vi.fn();
    let state = "unknown";
    const pump = new FeedbackMemoryPump({
      store,
      memory: new FakeMemory(),
      healthy: () => state === "healthy",
      healthState: () => state,
      wake,
      now: () => clock,
    });
    clock = new Date("2026-10-06T11:00:00Z"); // owed for 3 h
    expect(await pump.tick()).toMatchObject({ held: true, pending: 1 });
    expect(wake).not.toHaveBeenCalled();
    state = "down"; // measured now
    await pump.tick();
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("a restart inside a backlog keeps the re-wake cadence — the last wake is in state.db", async () => {
    ledgerFeedbackSignal(store, comment(1), { timezone: TZ, now: clock });
    const wake = vi.fn();
    const deps = {
      store,
      memory: new FakeMemory(),
      healthy: () => false,
      healthState: () => "down",
      wake,
      now: () => clock,
    };
    clock = new Date("2026-10-06T10:01:00Z");
    await new FeedbackMemoryPump(deps).tick();
    expect(wake).toHaveBeenCalledTimes(1);
    expect(store.feedbackBacklogWokenAt()).toBe("2026-10-06T10:01:00.000Z");
    // The daemon restarts half an hour later: no second wake.
    clock = new Date("2026-10-06T10:31:00Z");
    await new FeedbackMemoryPump(deps).tick();
    expect(wake).toHaveBeenCalledTimes(1);
    // Six hours after the first one, it wakes again.
    clock = new Date("2026-10-06T16:02:00Z");
    await new FeedbackMemoryPump(deps).tick();
    expect(wake).toHaveBeenCalledTimes(2);
    // The backlog clears: the record says so, and a NEW backlog wakes on its
    // own 2 h clock, not suppressed by the old wake.
    const healthy = new FeedbackMemoryPump({
      ...deps,
      healthy: () => true,
      healthState: () => "healthy",
    });
    expect(await healthy.tick()).toMatchObject({ written: 1, pending: 0 });
    expect(store.feedbackBacklogWokenAt()).toBeNull();
    ledgerFeedbackSignal(store, comment(2), { timezone: TZ, now: clock });
    clock = new Date("2026-10-06T18:03:00Z");
    await new FeedbackMemoryPump(deps).tick();
    expect(wake).toHaveBeenCalledTimes(3);
  });

  it("never rejects — a throwing store is a failed attempt", async () => {
    ledgerFeedbackSignal(store, comment(1), { timezone: TZ, now: clock });
    const memory = new FakeMemory();
    memory.throwNext = 1;
    const pump = new FeedbackMemoryPump({
      store,
      memory,
      healthy: () => true,
      wake: vi.fn(),
      now: () => clock,
    });
    await expect(pump.tick()).resolves.toMatchObject({ attempted: 1, written: 0 });
    expect(store.pendingFeedbackMemory(5)[0]!.memory_last_error).toContain("ECONNREFUSED");
  });

  it("is wired: healthy-gated, configured cadence and threshold, stopped on shutdown", async () => {
    const { readFileSync } = await import("node:fs");
    const wire = readFileSync(join(process.cwd(), "src", "wire.ts"), "utf8");
    expect(wire).toMatch(
      /new FeedbackMemoryPump\(\{[\s\S]*?healthy: \(\) => health\.currentState\(\) === "healthy"/,
    );
    expect(wire).toContain("cfg.memory.backfill_interval_s");
    expect(wire).toContain("cfg.memory.write_backlog_after_min");
    expect(wire).toMatch(/feedbackPump\.start\(\)/);
    expect(wire).toMatch(/feedbackPump\?\.stop\(\)/);
    // Legacy rows are checked against a complete sweep, never a collapsed read.
    expect(wire).toMatch(/complete: sweep\.unread\.length === 0/);
    expect(MEMORY_DEFAULTS).toMatchObject({
      backfill_interval_s: 60,
      write_backlog_after_min: 120,
    });
  });
});

// ---- 4. the legacy losses ----------------------------------------------------

describe("the 2026-08-31..10-02 losses are backfilled without duplicates", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qcr-s2-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A legacy database: rows with no memory state, and the failure events
   * the old sink logged right after a failed write. */
  function legacyDb(): string {
    const path = join(dir, "state.db");
    let t = new Date("2026-09-11T10:00:00Z");
    const s = new StateStore(path, () => t);
    const insert = (kind: string, pr: number, extra: Record<string, unknown>, at: string) => {
      t = new Date(at);
      s.db
        .prepare(
          `INSERT INTO feedback_signals (kind, pr, comment_id, review_id, scope, author, body, day, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          kind,
          pr,
          extra["comment_id"] ?? null,
          extra["review_id"] ?? null,
          extra["scope"] ?? "",
          extra["author"] ?? null,
          extra["body"] ?? null,
          at.slice(0, 10),
          at,
        );
    };
    // August: written fine (no failure event).
    insert("merged_over_block", 5300, {}, "2026-08-25T09:00:00.000Z");
    // September: Invalid API Key — never written.
    insert(
      "feedback_comment",
      5583,
      { comment_id: 701, scope: "issue_comment", author: "a", body: "[feedback] publish it" },
      "2026-09-11T10:00:00.000Z",
    );
    t = new Date("2026-09-11T10:00:01.000Z");
    s.logEvent("feedback_memory_write_failed", 5583, {
      kind: "feedback_comment",
      error: "Error: UNAUTHENTICATED: Invalid API Key",
    });
    // October: timed out — and its entry LANDED after all.
    insert("review_set_aside", 5840, { review_id: 9001, author: "b" }, "2026-10-04T12:00:00.000Z");
    t = new Date("2026-10-04T12:00:10.000Z");
    s.logEvent("feedback_memory_write_failed", 5840, {
      kind: "review_set_aside",
      error: "Error: memory write timed out after 10000ms",
    });
    // Pretend the columns were never there.
    s.db.prepare("UPDATE feedback_signals SET memory_state = NULL, memory_attempts = 0").run();
    s.db.prepare("DELETE FROM events WHERE kind = 'feedback_memory_ledger_migrated'").run();
    s.close();
    return path;
  }

  it("the boot migration marks exactly the failed rows owed, the rest written", () => {
    const path = legacyDb();
    const s = new StateStore(path, () => new Date("2026-10-06T08:00:00Z"));
    const rows = s.feedbackSignalsSince("");
    expect(rows.map((r) => [r.pr, r.memory_state])).toEqual([
      [5300, "written"],
      [5583, "pending"],
      [5840, "pending"],
    ]);
    expect(rows[1]!.memory_last_error).toContain("Invalid API Key");
    expect(rows[1]!.memory_uri).toBeNull();
    expect(s.feedbackLegacyCutoff()).toBe("2026-10-06T08:00:00.000Z");
    s.close();
    // Idempotent: a second boot classifies nothing.
    const again = new StateStore(path, () => new Date("2026-10-07T08:00:00Z"));
    expect(again.feedbackLegacyCutoff()).toBe("2026-10-06T08:00:00.000Z");
    expect(again.feedbackMemoryBacklog().pending).toBe(2);
    again.close();
  });

  it("backfills the lost one and FINDS the one that landed — no duplicate", async () => {
    const path = legacyDb();
    const s = new StateStore(path, () => new Date("2026-10-06T08:00:00Z"));
    const memory = new FakeMemory();
    // The timed-out October write that landed, under the old random name.
    const landed = s.feedbackSignalsSince("").find((r) => r.pr === 5840)!;
    memory.entries.set(
      "experiences/20261004T120003-1a2b3c4d.md",
      `#feedback #operations ${memoryEntryForRow(landed)!.replace(/^#feedback #operations /, "")}\n`,
    );
    const pump = new FeedbackMemoryPump({ store: s, memory, healthy: () => true, wake: vi.fn() });
    const tick = await pump.tick();
    expect(tick).toMatchObject({ found: 1, written: 1 });
    expect(memory.entries.size).toBe(2);
    const rows = s.feedbackSignalsSince("");
    expect(rows.find((r) => r.pr === 5840)).toMatchObject({
      memory_state: "written",
      memory_uri: `${ROOT}/experiences/20261004T120003-1a2b3c4d.md`,
    });
    const sept = rows.find((r) => r.pr === 5583)!;
    expect(sept.memory_state).toBe("written");
    // Dated by the SIGNAL, not by the backfill.
    expect(sept.memory_uri).toContain(
      `/events/20260911T100000-fb-feedback_comment-5583-${sept.id}.md`,
    );
    s.close();
  });

  it("a partial read makes pre-S2 rows wait (saying why) and lets newer rows through", async () => {
    const path = legacyDb();
    const s = new StateStore(path, () => new Date("2026-10-06T08:00:00Z"));
    ledgerFeedbackSignal(s, comment(42, 6000), {
      timezone: TZ,
      now: new Date("2026-10-06T09:00:00Z"),
    });
    const memory = new FakeMemory();
    const pump = new FeedbackMemoryPump({
      store: s,
      memory,
      healthy: () => true,
      wake: vi.fn(),
      readEntries: async () => ({ entries: [], complete: false }),
    });
    expect(await pump.tick()).toMatchObject({ written: 1, found: 0 });
    const rows = s.feedbackSignalsSince("");
    expect(rows.find((r) => r.pr === 6000)!.memory_state).toBe("written");
    for (const r of rows.filter((x) => x.pr === 5583 || x.pr === 5840)) {
      expect(r.memory_state).toBe("pending");
      expect(r.memory_last_error).toContain("waiting for a complete memory read");
    }
    s.close();
  });

  /** A legacy database built by `build`: `row` inserts a feedback row at an
   * instant, `failed` logs the old sink's failure event at one. */
  function preS2Db(
    build: (
      row: (kind: string, pr: number, extra: Record<string, unknown>, at: string) => void,
      failed: (pr: number, kind: string, at: string, extra?: Record<string, unknown>) => void,
    ) => void,
  ): string {
    const path = join(dir, "state.db");
    let t = new Date("2026-08-01T00:00:00Z");
    const s = new StateStore(path, () => t);
    build(
      (kind, pr, extra, at) => {
        s.db
          .prepare(
            `INSERT INTO feedback_signals (kind, pr, comment_id, review_id, scope, author, body, day, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            kind,
            pr,
            extra["comment_id"] ?? null,
            extra["review_id"] ?? null,
            extra["scope"] ?? "",
            extra["author"] ?? null,
            extra["body"] ?? null,
            at.slice(0, 10),
            at,
          );
      },
      (pr, kind, at, extra = {}) => {
        t = new Date(at);
        s.logEvent("feedback_memory_write_failed", pr, {
          kind,
          error: `Error: lost ${at}`,
          ...extra,
        });
      },
    );
    s.db.prepare("UPDATE feedback_signals SET memory_state = NULL, memory_attempts = 0").run();
    s.db.prepare("DELETE FROM events WHERE kind = 'feedback_memory_ledger_migrated'").run();
    s.close();
    return path;
  }

  it("the migration gives each failure event its OWN row — the newest unclaimed one at or before it", () => {
    const fb = (id: number) => ({
      comment_id: id,
      scope: "issue_comment",
      author: "a",
      body: "[feedback] x",
    });
    const path = preS2Db((row, failed) => {
      // One PR, three signals over six weeks; only the middle one failed.
      row("feedback_comment", 5583, fb(1), "2026-08-20T09:00:00.000Z"); // A
      row("feedback_comment", 5583, fb(2), "2026-09-11T10:00:00.000Z"); // B
      failed(5583, "feedback_comment", "2026-09-11T10:00:01.000Z");
      row("feedback_comment", 5583, fb(3), "2026-10-04T12:00:00.000Z"); // C
      // Two comments from ONE review submission, interpreted concurrently:
      // both rows precede both failure events.
      row("feedback_comment", 5600, fb(10), "2026-09-20T08:00:00.000Z");
      row("feedback_comment", 5600, fb(11), "2026-09-20T08:00:00.200Z");
      failed(5600, "feedback_comment", "2026-09-20T08:00:10.000Z");
      failed(5600, "feedback_comment", "2026-09-20T08:00:10.100Z");
      // A failure that names its own signal is never a legacy row's.
      row("feedback_comment", 5700, fb(20), "2026-09-25T08:00:00.000Z");
      failed(5700, "feedback_comment", "2026-09-25T08:00:05.000Z", { signal: 999, attempt: 2 });
    });
    const s = new StateStore(path, () => new Date("2026-10-06T08:00:00Z"));
    const by = new Map(s.feedbackSignalsSince("").map((r) => [r.comment_id, r.memory_state]));
    expect(Object.fromEntries(by)).toEqual({
      1: "written",
      2: "pending",
      3: "written",
      10: "pending",
      11: "pending",
      20: "written",
    });
    s.close();
  });

  it("legacy losses are owed SINCE THE MIGRATION — a September loss queued today does not wake at once", async () => {
    const path = legacyDb();
    let clock = new Date("2026-10-06T08:00:00Z");
    const s = new StateStore(path, () => clock);
    expect(s.feedbackMemoryBacklog().oldest_pending_at).toBe("2026-10-06T08:00:00.000Z");
    const wake = vi.fn();
    const deps = {
      store: s,
      memory: new FakeMemory(),
      healthy: () => false,
      healthState: () => "down",
      wake,
      now: () => clock,
    };
    clock = new Date("2026-10-06T08:05:00Z");
    await new FeedbackMemoryPump(deps).tick();
    expect(wake).not.toHaveBeenCalled();
    clock = new Date("2026-10-06T10:01:00Z"); // owed for 2 h now
    await new FeedbackMemoryPump(deps).tick();
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake.mock.calls[0]![1]).toContain("waited 2h01m");
    s.close();
  });

  it("a partial read never starves newer rows behind a FULL batch of pre-S2 rows", async () => {
    const path = preS2Db((row, failed) => {
      for (let i = 0; i < 25; i += 1) {
        const at = new Date(Date.parse("2026-09-01T08:00:00.000Z") + i * 3_600_000).toISOString();
        row(
          "feedback_comment",
          6100 + i,
          { comment_id: 100 + i, scope: "issue_comment", author: "a", body: "[feedback] x" },
          at,
        );
        failed(6100 + i, "feedback_comment", new Date(Date.parse(at) + 1000).toISOString());
      }
    });
    const s = new StateStore(path, () => new Date("2026-10-06T08:00:00Z"));
    expect(s.feedbackMemoryBacklog().pending).toBe(25);
    ledgerFeedbackSignal(s, comment(42, 6000), {
      timezone: TZ,
      now: new Date("2026-10-06T09:00:00Z"),
    });
    const memory = new FakeMemory();
    const pump = new FeedbackMemoryPump({
      store: s,
      memory,
      healthy: () => true,
      wake: vi.fn(),
      readEntries: async () => ({ entries: [], complete: false }),
    });
    expect(await pump.tick()).toMatchObject({ written: 1, found: 0 });
    const rows = s.feedbackSignalsSince("");
    expect(rows.find((r) => r.pr === 6000)!.memory_state).toBe("written");
    const legacy = rows.filter((r) => r.pr !== 6000);
    expect(legacy).toHaveLength(25);
    for (const r of legacy) expect(r.memory_state).toBe("pending");
    // The first batch was told why it waits.
    expect(
      legacy.filter((r) =>
        (r.memory_last_error ?? "").includes("waiting for a complete memory read"),
      ),
    ).toHaveLength(20);
    s.close();
  });

  it("matches a legacy entry by its header tags and id — quoted prose cannot fake one", () => {
    const s = new StateStore(":memory:");
    const row = s.recordFeedbackSignalRow({
      kind: "feedback_comment",
      pr: 7,
      comment_id: 55,
      scope: "issue_comment",
      author: "x",
      body: "[feedback] y",
      day: "2026-09-02",
    })!;
    const mk = (id: string, text: string) => entryFrom(id, text, "");
    expect(
      legacyFeedbackEntry(row, [
        mk(
          "experiences/a.md",
          "#feedback kind=feedback pr=7 day=2026-09-02 signal=feedback_comment … comment 55 …",
        ),
      ])?.id,
    ).toBe("experiences/a.md");
    // Another comment the same day on the same PR is not this one.
    expect(
      legacyFeedbackEntry(row, [
        mk(
          "experiences/b.md",
          "#feedback kind=feedback pr=7 day=2026-09-02 signal=feedback_comment … comment 550 …",
        ),
      ]),
    ).toBeNull();
    // Tags quoted in a body are prose, not a header.
    expect(
      legacyFeedbackEntry(row, [
        mk(
          "experiences/c.md",
          "#bug something said kind=feedback pr=7 day=2026-09-02 signal=feedback_comment comment 55",
        ),
      ]),
    ).toBeNull();
    s.close();
  });
});

// ---- 5. the status a person reads -----------------------------------------------

describe("the memory block says what memory still owes", () => {
  it("renders an owed backlog in the status line, and nothing when none is owed", () => {
    const now = new Date("2026-10-06T12:00:00Z");
    const base = pendingMemoryStatus(now);
    expect(feedbackWritesPhrase(undefined, now)).toBe("");
    expect(feedbackWritesPhrase({ pending: 0, failed: 0, oldest_pending_at: null }, now)).toBe("");
    // A ledger the daemon could not read is UNKNOWN — never the same "" as
    // nothing owed (honest-unknown: a dropped clause reads as "all clear").
    expect(feedbackWritesPhrase(null, now)).toContain("[feedback] memory backlog UNKNOWN");
    expect(memoryStatusLine({ ...base, feedback_writes: null }, now)).toContain(
      "[feedback] memory backlog UNKNOWN",
    );
    const line = memoryStatusLine(
      {
        ...base,
        feedback_writes: { pending: 3, failed: 1, oldest_pending_at: "2026-10-06T09:00:00Z" },
      },
      now,
    );
    expect(line).toContain("3 [feedback] signals owed to memory (oldest 3h00m)");
    expect(line).toContain("1 given up");
  });

  it("wire.ts carries the ledger's backlog into status.json", async () => {
    const { readFileSync } = await import("node:fs");
    const wire = readFileSync(join(process.cwd(), "src", "wire.ts"), "utf8");
    expect(wire).toMatch(/feedback_writes: \{\s*pending: b\.pending,/);
    // An unreadable ledger is published as null (UNKNOWN), never dropped.
    expect(wire).toMatch(
      /catch \(err\) \{[\s\S]{0,200}?return \{ \.\.\.base, feedback_writes: null \};/,
    );
  });
});

// ---- 6. the wake kinds ------------------------------------------------------------

describe("the two S2 wake kinds", () => {
  it("are WAKE kinds; the backlog keys its dedup on the detail", () => {
    expect(wakeKinds()).toContain("memory_write_backlog");
    expect(wakeKinds()).toContain("eod_inject_failed");
    expect(detailKeyedKinds()).toContain("memory_write_backlog");
  });

  it("a give-up minutes after a backlog wake still reaches the overseer", () => {
    const injected: string[] = [];
    const policy = new AnomalyWakePolicy({ injectOverseer: async (m) => void injected.push(m) });
    const store = new StateStore(":memory:");
    store.setAnomalySink((sig) => policy.onAnomaly(sig));
    store.logAnomaly(
      "memory_write_backlog",
      null,
      null,
      "3 feedback signal(s) owed to memory; oldest #1 waited 2h01m",
      "BACKLOG",
    );
    store.logAnomaly(
      "memory_write_backlog",
      null,
      null,
      "gave up on 1 feedback signal(s) (#4): 413",
      "GAVE UP",
    );
    expect(injected).toEqual(["BACKLOG", "GAVE UP"]);
    store.close();
  });
});

// ---- 7. the EOD sweep: deferred, not skipped; retried, then loud ----------------

function eodHarness(opts: {
  draining: () => boolean;
  inject?: (m: string, date: string) => Promise<void>;
  deferred?: { load(): string[]; save(d: string[]): void };
  clock: { now: Date };
  sweepInFlight?: () => boolean;
  retryBackoffMs?: readonly number[];
}) {
  const timers: Array<{ cb: () => void; ms: number; cleared: boolean }> = [];
  const injected: string[] = [];
  const events: string[] = [];
  const timer = startEodTimer({
    timeHHMM: "18:00",
    timeZone: TZ,
    now: () => opts.clock.now,
    readPrompt: () => "sweep {{date}}",
    shouldHold: opts.draining,
    onHeld: (d, why) => events.push(why === "draining" ? `held ${d}` : `held ${d} behind a sweep`),
    ...(opts.sweepInFlight ? { sweepInFlight: opts.sweepInFlight } : {}),
    ...(opts.retryBackoffMs ? { retryBackoffMs: opts.retryBackoffMs } : {}),
    onDeferredFire: (d) => events.push(`deferred-fire ${d}`),
    onFire: (d) => events.push(`fired ${d}`),
    onError: () => events.push("error"),
    onInjectFailed: (d, _err, n) => events.push(`failed ${d} after ${n}`),
    injectOverseer:
      opts.inject ??
      (async (m) => {
        injected.push(m);
      }),
    ...(opts.deferred ? { deferred: opts.deferred } : {}),
    setTimer: (cb, ms) => {
      timers.push({ cb, ms, cleared: false });
      return timers.length - 1;
    },
    clearTimer: (h) => {
      const t = timers[h as number];
      if (t) t.cleared = true;
    },
  });
  /** Fire the newest live timer of this length. */
  const fire = async (ms?: number): Promise<void> => {
    const t = [...timers].reverse().find((x) => !x.cleared && (ms === undefined || x.ms === ms));
    if (!t) throw new Error(`no live timer${ms !== undefined ? ` of ${ms} ms` : ""}`);
    t.cleared = true;
    t.cb();
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
  };
  return { timer, timers, injected, events, fire };
}

describe("a drain DEFERS the EOD sweep — it fires once the drain lifts", () => {
  it("held at 18:00, persisted, fired by the poll after the lift — exactly once", async () => {
    const clock = { now: new Date("2026-08-25T09:00:00Z") };
    let draining = true;
    const s = new StateStore(":memory:");
    const h = eodHarness({
      draining: () => draining,
      clock,
      deferred: { load: () => s.eodDeferredDates(), save: (d) => s.recordEodDeferred(d) },
    });
    clock.now = new Date("2026-08-25T16:00:00Z"); // 18:00 CEST
    await h.fire(); // the daily timer
    expect(h.injected).toEqual([]);
    expect(h.events).toEqual(["held 2026-08-25"]);
    expect(s.eodDeferredDates()).toEqual(["2026-08-25"]);
    // Still draining a minute later: nothing.
    await h.fire(EOD_DEFAULTS.deferPollMs);
    expect(h.injected).toEqual([]);
    // The drain lifts: the next poll fires the deferred day.
    draining = false;
    await h.fire(EOD_DEFAULTS.deferPollMs);
    expect(h.injected).toEqual(["sweep 2026-08-25"]);
    expect(h.events).toContain("deferred-fire 2026-08-25");
    expect(s.eodDeferredDates()).toEqual([]);
    expect(h.timer.deferredDates()).toEqual([]);
    // No poll left armed: it fires once.
    expect(h.timers.filter((t) => !t.cleared && t.ms === EOD_DEFAULTS.deferPollMs)).toHaveLength(0);
    h.timer.stop();
    s.close();
  });

  it("survives a restart: a new timer over the same store fires the deferred day", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qcr-eod-"));
    try {
      const path = join(dir, "state.db");
      const first = new StateStore(path);
      first.recordEodDeferred(["2026-10-05"]);
      first.close();
      const s = new StateStore(path);
      const clock = { now: new Date("2026-10-06T07:00:00Z") };
      let draining = true;
      const h = eodHarness({
        draining: () => draining,
        clock,
        deferred: { load: () => s.eodDeferredDates(), save: (d) => s.recordEodDeferred(d) },
      });
      expect(h.timer.deferredDates()).toEqual(["2026-10-05"]);
      await h.fire(EOD_DEFAULTS.deferPollMs); // the boot's drain is still up
      expect(h.injected).toEqual([]);
      draining = false; // the boot's first healthy reconcile lifted it
      await h.fire(EOD_DEFAULTS.deferPollMs);
      expect(h.injected).toEqual(["sweep 2026-10-05"]);
      expect(s.eodDeferredDates()).toEqual([]);
      h.timer.stop();
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a shutdown during a deferred day's retries keeps it deferred for the next boot", async () => {
    const clock = { now: new Date("2026-10-06T07:00:00Z") };
    const s = new StateStore(":memory:");
    s.recordEodDeferred(["2026-10-05"]);
    const h = eodHarness({
      draining: () => false,
      clock,
      inject: async () => {
        throw new Error("overseer not up yet");
      },
      deferred: { load: () => s.eodDeferredDates(), save: (d) => s.recordEodDeferred(d) },
    });
    await h.fire(EOD_DEFAULTS.deferPollMs);
    expect(h.events).toEqual(["deferred-fire 2026-10-05", "error"]);
    h.timer.stop(); // the daemon shuts down inside the backoff
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
    expect(s.eodDeferredDates()).toEqual(["2026-10-05"]);
    s.close();
  });

  it("a shutdown during an ORDINARY day's retries keeps it owed — the next boot fires it", async () => {
    const clock = { now: new Date("2026-10-06T09:00:00Z") };
    const s = new StateStore(":memory:");
    const h = eodHarness({
      draining: () => false,
      clock,
      inject: async () => {
        throw new Error("overseer not up yet");
      },
      deferred: { load: () => s.eodDeferredDates(), save: (d) => s.recordEodDeferred(d) },
    });
    clock.now = new Date("2026-10-06T16:00:00Z"); // 18:00 CEST
    await h.fire(); // the daily timer: the inject fails, a retry waits
    expect(h.events).toEqual(["error"]);
    expect(s.eodDeferredDates()).toEqual(["2026-10-06"]);
    h.timer.stop(); // the daemon shuts down inside the backoff
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
    expect(s.eodDeferredDates()).toEqual(["2026-10-06"]);
    const next = eodHarness({
      draining: () => false,
      clock,
      deferred: { load: () => s.eodDeferredDates(), save: (d) => s.recordEodDeferred(d) },
    });
    await next.fire(EOD_DEFAULTS.deferPollMs);
    expect(next.injected).toEqual(["sweep 2026-10-06"]);
    expect(s.eodDeferredDates()).toEqual([]);
    next.timer.stop();
    s.close();
  });

  it("an ordinary day leaves the owed set once delivered, and once its retries are exhausted", async () => {
    const clock = { now: new Date("2026-10-06T09:00:00Z") };
    const s = new StateStore(":memory:");
    const h = eodHarness({
      draining: () => false,
      clock,
      deferred: { load: () => s.eodDeferredDates(), save: (d) => s.recordEodDeferred(d) },
    });
    clock.now = new Date("2026-10-06T16:00:00Z");
    await h.fire();
    expect(h.injected).toEqual(["sweep 2026-10-06"]);
    expect(s.eodDeferredDates()).toEqual([]);
    h.timer.stop();
    const failing = eodHarness({
      draining: () => false,
      clock,
      retryBackoffMs: [],
      inject: async () => {
        throw new Error("down");
      },
      deferred: { load: () => s.eodDeferredDates(), save: (d) => s.recordEodDeferred(d) },
    });
    clock.now = new Date("2026-10-07T16:00:00Z");
    await failing.fire(failing.timers.find((t) => !t.cleared)!.ms);
    expect(failing.events).toEqual(["error", "failed 2026-10-07 after 1"]);
    expect(s.eodDeferredDates()).toEqual([]);
    failing.timer.stop();
    s.close();
  });

  it("wire.ts persists the deferred day in state.db and no longer skips it", async () => {
    const { readFileSync } = await import("node:fs");
    const wire = readFileSync(join(process.cwd(), "src", "wire.ts"), "utf8");
    expect(wire).not.toContain("eod_skipped_draining");
    expect(wire).toMatch(
      /deferred: \{\s*load: \(\) => d\.store\.eodDeferredDates\(\),\s*save: \(dates\) => d\.store\.recordEodDeferred\(dates\),/,
    );
  });
});

describe("deferred days fire oldest first, ONE SWEEP at a time", () => {
  it("never starts a second day while one is still retrying — and the day's own hour waits too", async () => {
    const clock = { now: new Date("2026-10-06T07:00:00Z") };
    let fails = 1;
    const attempts: string[] = [];
    const h = eodHarness({
      draining: () => false,
      clock,
      retryBackoffMs: [5_000],
      inject: async (m) => {
        attempts.push(m);
        if (fails > 0) {
          fails -= 1;
          throw new Error("overseer not up yet");
        }
      },
      // Loaded out of order on purpose: the timer sorts them.
      deferred: { load: () => ["2026-10-05", "2026-10-04"], save: () => {} },
    });
    expect(h.timer.deferredDates()).toEqual(["2026-10-04", "2026-10-05"]);
    await h.fire(EOD_DEFAULTS.deferPollMs);
    expect(attempts).toEqual(["sweep 2026-10-04"]); // the OLDEST
    // 10-04 is in its retry wait. Today's 18:00 comes up meanwhile: it is
    // deferred behind the sweep in flight, not fired beside it.
    clock.now = new Date("2026-10-06T16:00:00Z");
    await h.fire(9 * 3_600_000);
    expect(h.events).toContain("held 2026-10-06 behind a sweep");
    expect(h.timer.deferredDates()).toEqual(["2026-10-04", "2026-10-05", "2026-10-06"]);
    // The poll that deferral armed runs while 10-04 is still retrying:
    // it starts nothing.
    await h.fire(EOD_DEFAULTS.deferPollMs);
    expect(attempts).toEqual(["sweep 2026-10-04"]);
    // The retry lands; then the rest, oldest first, one per poll.
    await h.fire(5_000);
    expect(attempts).toEqual(["sweep 2026-10-04", "sweep 2026-10-04"]);
    await h.fire(EOD_DEFAULTS.deferPollMs);
    await h.fire(EOD_DEFAULTS.deferPollMs);
    expect(attempts).toEqual([
      "sweep 2026-10-04",
      "sweep 2026-10-04",
      "sweep 2026-10-05",
      "sweep 2026-10-06",
    ]);
    expect(h.timer.deferredDates()).toEqual([]);
    h.timer.stop();
  });

  it("waits out the last sweep's pinned-area window, which is named after ITS day", async () => {
    const clock = { now: new Date("2026-10-06T07:00:00Z") };
    const watchTimers: Array<{ cb: () => void; ms: number; cleared: boolean }> = [];
    const digests = new Set<string>();
    const asked: string[] = [];
    const anomalies: string[] = [];
    const watch = startEodPinWatch({
      readPinned: async () => [],
      logAnomaly: (kind, _pr, _r, detail) => anomalies.push(`${kind}: ${detail}`),
      timeZone: TZ,
      digestReady: (date) => {
        asked.push(date);
        return digests.has(date);
      },
      now: () => clock.now,
      setTimer: (cb, ms) => {
        watchTimers.push({ cb, ms, cleared: false });
        return watchTimers.length - 1;
      },
      clearTimer: (h) => {
        const t = watchTimers[h as number];
        if (t) t.cleared = true;
      },
    });
    const delivered: Array<[string, string]> = [];
    const h = eodHarness({
      draining: () => false,
      clock,
      sweepInFlight: () => watch.isOpen(),
      inject: watch.wrapInject(async (m, date) => {
        delivered.push([m, date ?? "?"]);
      }),
      deferred: { load: () => ["2026-10-04", "2026-10-05"], save: () => {} },
    });
    await h.fire(EOD_DEFAULTS.deferPollMs);
    expect(delivered).toEqual([["sweep 2026-10-04", "2026-10-04"]]);
    // The window opened for 10-04 — not for today (10-06).
    expect(watch.isOpen()).toBe(true);
    expect(asked).toEqual(["2026-10-04"]);
    // The curator is still on 10-04: the next deferred day waits.
    await h.fire(EOD_DEFAULTS.deferPollMs);
    expect(delivered).toHaveLength(1);
    // 10-04's digest lands: its window closes on its own day's digest…
    digests.add("2026-10-04");
    const poll = [...watchTimers].reverse().find((t) => !t.cleared)!;
    poll.cleared = true;
    poll.cb();
    await watch.settled();
    expect(watch.isOpen()).toBe(false);
    expect(anomalies).toEqual([]); // judged on its own window: unchanged
    // …and 10-05 goes next, under its own date.
    await h.fire(EOD_DEFAULTS.deferPollMs);
    expect(delivered.at(-1)).toEqual(["sweep 2026-10-05", "2026-10-05"]);
    expect(asked.at(-1)).toBe("2026-10-05");
    h.timer.stop();
    watch.stop();
  });

  it("wire.ts holds the next sweep while the pin watch's window is open", async () => {
    const { readFileSync } = await import("node:fs");
    const wire = readFileSync(join(process.cwd(), "src", "wire.ts"), "utf8");
    expect(wire).toContain("sweepInFlight: () => pinWatch?.isOpen() === true,");
  });
});

describe("a failed EOD inject is retried 3×, then eod_inject_failed wakes", () => {
  it("retries with backoff and stops at the first success", async () => {
    const clock = { now: new Date("2026-10-06T09:00:00Z") };
    let fails = 2;
    const injected: string[] = [];
    const h = eodHarness({
      draining: () => false,
      clock,
      inject: async (m) => {
        if (fails > 0) {
          fails -= 1;
          throw new Error("no overseer session");
        }
        injected.push(m);
      },
    });
    clock.now = new Date("2026-10-06T16:00:00Z");
    await h.fire();
    expect(h.events).toEqual(["error"]);
    await h.fire(EOD_DEFAULTS.retryBackoffMs[0]);
    expect(h.events).toEqual(["error", "error"]);
    await h.fire(EOD_DEFAULTS.retryBackoffMs[1]);
    expect(injected).toEqual(["sweep 2026-10-06"]);
    expect(h.events).toEqual(["error", "error", "fired 2026-10-06"]);
    h.timer.stop();
  });

  it("all four attempts failing raises onInjectFailed once, and re-arms for tomorrow", async () => {
    const clock = { now: new Date("2026-10-06T09:00:00Z") };
    const h = eodHarness({
      draining: () => false,
      clock,
      inject: async () => {
        throw new Error("tmux gone");
      },
    });
    clock.now = new Date("2026-10-06T16:00:00Z");
    await h.fire();
    for (const ms of EOD_DEFAULTS.retryBackoffMs) await h.fire(ms);
    expect(EOD_DEFAULTS.retryBackoffMs).toHaveLength(3);
    expect(h.events.filter((e) => e === "error")).toHaveLength(4);
    expect(h.events.at(-1)).toBe("failed 2026-10-06 after 4");
    expect(h.timer.nextFire().toISOString()).toBe("2026-10-07T16:00:00.000Z");
    h.timer.stop();
  });

  it("wire.ts turns it into the eod_inject_failed WAKE", async () => {
    const { readFileSync } = await import("node:fs");
    const wire = readFileSync(join(process.cwd(), "src", "wire.ts"), "utf8");
    expect(wire).toMatch(
      /onInjectFailed: \(date, err, attempts\) => \{[\s\S]*?logAnomaly\(\s*"eod_inject_failed"/,
    );
  });
});
