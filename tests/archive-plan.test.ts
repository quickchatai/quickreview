// The archive PLAN (docs/archiving.md §7.2, §13) over a real
// temp root: what a pass would move, per artifact class; the orphan reported
// and never touched; the reader-less event rows and the old deliveries
// counted through rowid windows; and PLAN MODE WRITES NOTHING — the tree's
// hash and the database's row census are the same after a plan tick.
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Archiver, archivePolicy } from "../src/archive/archiver.js";
import { renderArchiveReport } from "../src/archive/report.js";
import { SpanMeter } from "../src/archive/prfiles.js";
import {
  COUNT_WINDOW_ROWS,
  askLiveSessions,
  computePlan,
  type PlanMemo,
} from "../src/archive/plan.js";
import { ARCHIVE_DEFAULTS } from "../src/config.js";
import { StateStore } from "../src/state.js";
import { createWorkerLiveness } from "../src/workerliveness.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const T0 = Date.parse("2026-10-21T12:00:00.000Z");
const DAY = 86_400_000;

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function put(root: string, rel: string, bytes: number | string): string {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, typeof bytes === "number" ? "x".repeat(bytes) : bytes);
  return p;
}

interface Fixture {
  root: string;
  store: StateStore;
  at: (ms: number) => void;
}

/** A sandbox root: PR 100 closed 20 days ago with one file of every class;
 * PR 200 closed 3 days ago (waiting); PR 300 closed 20 days ago with an open
 * review failure (held); PR 400 open; PR 1000 closed 20 days ago with nothing
 * live (empty); `pi-sessions/pr-7`, an orphan with no registry row. */
function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "qcr-archive-plan-"));
  roots.push(root);
  mkdirSync(join(root, "state"), { recursive: true });
  let now = T0;
  const store = new StateStore(join(root, "state", "state.db"), () => new Date(now));
  const at = (ms: number): void => {
    now = ms;
  };
  const pr = (n: number, state: "closed" | "tracked", closedDaysAgo?: number): void => {
    at(T0 - (closedDaysAgo ?? 1) * DAY);
    store.upsertPr({
      number: n,
      state,
      head_sha: "abc",
      title: `pr ${n}`,
      author: "a",
      trigger_ts: null,
      stale_recheck: 0,
      migration_gate: 0,
    });
    if (state === "closed") store.logEvent("pr_closed", n, { merged: true });
    at(T0);
  };
  pr(100, "closed", 20);
  pr(200, "closed", 3);
  pr(300, "closed", 20);
  pr(400, "tracked");
  pr(1000, "closed", 20);

  // PR 100 — one file of every §7.2 class.
  put(root, "state/pi-sessions/pr-100/2026-10-01_a.jsonl", 1000);
  put(root, "state/pi-sessions/pr-100/nested/2026-10-02_b.jsonl", 500);
  put(root, "state/pi-sessions/pr-100/notes.txt", 7); // not a transcript
  put(root, "state/round-prompts/pr-100-round-1.md", 30);
  put(root, "state/findings/pr-100-round-1.json", 40);
  put(root, "state/posting-receipts/pr-100-round-1.json", 50);
  put(root, "state/posting-receipts/pr-100-round-1.json.dryrun-1700000000", 51);
  put(root, "state/pr-100-round-1-passes/tasks/pass-baseline.md", 60);
  put(root, "state/pr-100-round-1-review.md", 61);
  put(root, "state/pr-100-round-1-comments.json", 62);
  put(root, "state/session-prompts/pr-100.md", 70);
  put(root, "state/sessions/pr-100.json", 71);
  put(root, "state/sessions/pr-100.bridge-3.json", 72);
  put(root, "state/round-progress/pr-100.json", 73);
  put(root, "state/round-progress/pr-100.jsonl", 74); // the transition log
  put(root, "state/round-progress/pr-100.jsonl.1", 75); // its rotated generation
  put(root, "inject/pr-100/.done/w1.md", 80);
  put(root, "inject/pr-100/.terminal/w2.md", 81);
  put(root, "inject/pr-100/w3.md.operator-recovery-1", 82);
  const stale = put(root, "inject/pr-100/stale.md", 83);
  put(root, "verdict/processed/20261001T000000Z-pr-100-round-1.json", 90);
  put(root, "verdict/failed/20261001T000000Z-pr-100-thread-1-comment-2.json", 91);
  // The per-round worker trees (P8.16): the LiveEvent logs and the lens passes' JSONLs.
  put(root, "state/live/pr-100/r1/main.jsonl", 20);
  put(root, "state/live/pr-100/r1/lens-L1.jsonl", 21);
  put(root, "state/lens/pr-100/r1/lens-sessions/L1/2026-10-01T10-00-00-000Z_x.jsonl", 200);
  put(root, "state/lens/pr-100/r1/lens-ledger.jsonl", 22);
  put(root, "state/live/pr-400/r1/main.jsonl", 23); // an open PR's: not in the plan
  put(root, "state/ledgers/pr-100.md", 95);
  put(root, "archive/pr-100/session.jsonl", 900);
  put(root, "archive/pr-100/ledger.md", 10);
  put(root, "archive/pr-100/meta.json", 10);
  const payload = put(root, "state/session-commands/cmd-100.md", 100);
  const cmd = (id: string, path: string, inject: string, status: string): void => {
    store.createSessionCommand({
      id,
      pr: 100,
      session: "pr-100",
      kind: "wake",
      round_no: null,
      payload_sha256: "0".repeat(64),
      payload_path: path,
      inject_path: inject,
      next_check_at: new Date(T0).toISOString(),
    });
    store.db.prepare("UPDATE session_commands SET status = ? WHERE id = ?").run(status, id);
  };
  cmd("cmd-100", payload, stale, "acked");
  // A payload outside state/session-commands/ is never counted (§7.2).
  cmd(
    "cmd-out",
    put(root, "elsewhere/cmd-out.md", 999),
    join(root, "inject/pr-100/.done/zz.md"),
    "acked",
  );
  // PR 200 (waiting), PR 300 (held), PR 7 (orphan), the overseer (not a PR).
  put(root, "state/pi-sessions/pr-200/x.jsonl", 200);
  put(root, "state/pi-sessions/pr-300/x.jsonl", 300);
  put(root, "state/pi-sessions/pr-7/old.jsonl", 7000);
  put(root, "state/pi-sessions/overseer/o.jsonl", 10);
  store.db
    .prepare(
      `INSERT INTO review_failures (incident_id, pr, head_sha, stage, detail, attempts, retry_cap,
         failed_at, updated_at, next_action, work_owed)
       VALUES ('rf-300', 300, 'abc', 'first_pass_start', 'd', 1, 2, ?, ?, 'operator', 1)`,
    )
    .run(new Date(T0 - 19 * DAY).toISOString(), new Date(T0 - 19 * DAY).toISOString());

  // Rows: old reader-less events (counted), old fact events (never), young
  // ones (never); old and young deliveries.
  at(T0 - 40 * DAY);
  store.logEvent("webhook_event", null, { guid: "g" });
  store.logEvent("pingpong_decision_failed", 100, {});
  store.logEvent("verdict_applied", 100, {}); // a fact kind — stays live
  store.recordDelivery("old-1", "pull_request", "closed");
  at(T0 - 20 * DAY);
  store.recordDelivery("old-2", "pull_request", "closed");
  at(T0 - 2 * DAY);
  store.logEvent("webhook_event", null, { guid: "young" });
  store.recordDelivery("young-1", "pull_request", "opened");
  at(T0);
  return { root, store, at };
}

const sessionsRoot = (f: Fixture): string => join(f.root, "state", "pi-sessions");

function plan(f: Fixture, extra: Partial<Parameters<typeof computePlan>[0]> = {}) {
  return computePlan({
    store: f.store,
    root: f.root,
    sessionsRoot: sessionsRoot(f),
    now: () => new Date(T0),
    afterDays: 14,
    eventsAfterDays: 35,
    liveSessions: async () => [],
    birthInFlight: () => false,
    ...extra,
  });
}

/** Every path under `root` with its type, size, mtime and content hash —
 * state.db and its WAL excepted (the census covers the database). */
function treeHash(root: string, skip?: RegExp): string {
  const lines: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const p = join(dir, e.name);
      const rel = relative(root, p);
      if (/^state\/state\.db(-wal|-shm)?$/.test(rel)) continue;
      if (skip?.test(rel)) continue;
      const st = statSync(p);
      if (e.isDirectory()) {
        lines.push(`d ${rel} ${st.mtimeMs}`);
        walk(p);
      } else
        lines.push(
          `f ${rel} ${st.size} ${st.mtimeMs} ${createHash("sha256").update(readFileSync(p)).digest("hex")}`,
        );
    }
  };
  walk(root);
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/** Every table's row count, and the connection's change counter. */
function census(store: StateStore): Record<string, number> {
  const out: Record<string, number> = {};
  for (const { name } of store.db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as Array<{ name: string }>)
    out[name] = (store.db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n;
  out["(total_changes)"] = (
    store.db.prepare("SELECT total_changes() AS n").get() as { n: number }
  ).n;
  return out;
}

describe("the plan — what a pass would move (§7.2)", () => {
  it(
    "tallies every artifact class of an eligible PR, holds and waits the others, reports the orphan",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = fixture();
      try {
        const p = await plan(f);
        expect(p.registry).toEqual({
          prs: 5,
          open: 1,
          closed: 4,
          waiting: 1,
          eligible: 2,
          held: 1,
          archived: 0,
        });
        expect(p.candidates.map((c) => c.pr)).toEqual([100]);
        expect(p.empty).toEqual([1000]);
        expect(p.held).toEqual([{ pr: 300, reason: "failure_open", reasons: ["failure_open"] }]);
        expect(p.orphans).toEqual(["pr-7"]);
        expect(p.artifacts).toEqual({
          transcripts: { files: 2, bytes: 1500 },
          round_prompts: { files: 1, bytes: 30 },
          session_commands: { files: 1, bytes: 100 },
          findings: { files: 1, bytes: 40 },
          posting_receipts: { files: 2, bytes: 101 },
          round_files: { files: 3, bytes: 183 },
          session_files: { files: 6, bytes: 435 },
          inject_done: { files: 3, bytes: 243 },
          stale_injects: { files: 1, bytes: 83 },
          verdicts: { files: 2, bytes: 181 },
          live_logs: { files: 2, bytes: 41 },
          lens_sessions: { files: 2, bytes: 222 },
        });
        const bytes = 1500 + 30 + 100 + 40 + 101 + 183 + 435 + 243 + 83 + 181 + 41 + 222;
        expect(p.candidates[0]).toMatchObject({ files: 26, bytes });
        expect(p.ledger_snapshots).toEqual({ files: 1, bytes: 95 });
        expect(p.legacy_copies).toEqual({ files: 1, bytes: 900 });
        expect(p.backlog).toEqual({ prs: 2, bytes, event_rows: 2, delivery_rows: 2 });
        expect(p.events.by_kind).toEqual({ webhook_event: 1, pingpong_decision_failed: 1 });
        expect(p.workers).toBe("answered");
        expect(p.births_observed).toBe(true);
        expect(p.same_device).toBe(true);
      } finally {
        f.store.close();
      }
    },
  );

  it("an empty PR's ledger and legacy copy are tallied: its pass snapshots and checks them", async () => {
    const f = fixture();
    try {
      put(f.root, "state/ledgers/pr-1000.md", 33);
      put(f.root, "archive/pr-1000/session.jsonl", 400);
      const p = await plan(f);
      expect(p.empty).toEqual([1000]);
      expect(p.ledger_snapshots).toEqual({ files: 2, bytes: 95 + 33 });
      expect(p.legacy_copies).toEqual({ files: 2, bytes: 900 + 400 });
      // Still not backlog bytes: nothing of it leaves the live tree as a file.
      expect(p.backlog.prs).toBe(2);
    } finally {
      f.store.close();
    }
  });

  it("the store listings' sorts are inside the plan's measured spans", async () => {
    const f = fixture();
    const measured: string[] = [];
    const spy = vi.spyOn(SpanMeter.prototype, "measure").mockImplementation(function <T>(
      this: SpanMeter,
      fn: () => T,
    ): T {
      measured.push(new Error().stack ?? "");
      return fn();
    });
    try {
      put(f.root, "pihome/sessions/d/old.jsonl", 10);
      await plan(f, { piGlobalDir: join(f.root, "pihome", "sessions") });
      expect(measured.some((st) => st.includes("listOverseer"))).toBe(true);
      expect(measured.some((st) => st.includes("listPiGlobal"))).toBe(true);
    } finally {
      spy.mockRestore();
      f.store.close();
    }
  });

  it(
    "any per-round state/ entry a session wrote is a round file; a state/pr-<n>-* entry no class claims is REPORTED and kept (rehearsal 2026-10-08)",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = fixture();
      try {
        put(f.root, "state/pr-100-round-3-body.md", 44); // a session's own round file
        put(f.root, "state/pr-100-notes.md", 12); // claimed by no class
        put(f.root, "state/pr-1000-scratch/x.txt", 5); // the "empty" PR's, a dir
        put(f.root, "state/pr-200-other.md", 9); // PR 200 is inside the window
        const p = await plan(f);
        expect(p.artifacts.round_files).toEqual({ files: 4, bytes: 183 + 44 });
        expect(p.unclassified).toEqual({
          files: 2,
          bytes: 17,
          first: ["state/pr-100-notes.md", "state/pr-1000-scratch/x.txt"],
        });
        // Kept live: never counted as backlog or as a candidate's file.
        expect(p.candidates[0]).toMatchObject({ files: 27 });
        expect(p.empty).toEqual([1000]);
        const text = renderArchiveReport({
          block: undefined,
          statusNote: "x",
          ledger: { by_state: {}, archived_event_rows: 0, marks: {} },
          policy: archivePolicy(ARCHIVE_DEFAULTS),
          plan: p,
        });
        expect(text).toMatch(
          /KEPT LIVE, no class claims them: 2 state\/pr-<n>-\* file\(s\) of eligible PRs, .* — state\/pr-100-notes\.md, state\/pr-1000-scratch\/x\.txt/,
        );
      } finally {
        f.store.close();
      }
    },
  );

  it("worker liveness that cannot be asked holds every candidate (`worker_unknown`) — never read as none alive", async () => {
    const f = fixture();
    try {
      const p = await plan(f, { liveSessions: async () => null });
      expect(p.workers).toBe("unknown");
      expect(p.candidates).toEqual([]);
      expect(p.held.map((h) => [h.pr, h.reasons])).toEqual([
        [100, ["worker_unknown"]],
        [300, ["worker_unknown", "failure_open"]],
        [1000, ["worker_unknown"]],
      ]);
      expect(p.backlog.prs).toBe(0);
    } finally {
      f.store.close();
    }
  });

  it("an unreadable lease directory holds every candidate; an absent one is an answer — through the real liveness reader", async () => {
    const f = fixture();
    try {
      const runDir = join(f.root, "run-probe");
      mkdirSync(runDir, { recursive: true });
      // No lease dir: no worker ever ran here.
      const none = createWorkerLiveness({ runDir });
      expect(none.liveSessions()).toEqual([]);
      // `workers` is a file, not a dir: the leases cannot be listed.
      writeFileSync(join(runDir, "workers"), "");
      const broken = createWorkerLiveness({ runDir });
      const p = await plan(f, { liveSessions: async () => broken.liveSessions() });
      expect(p.workers).toBe("unknown");
      expect(p.candidates).toEqual([]);
      expect(p.held.map((h) => h.pr)).toEqual([100, 300, 1000]);
      expect(p.held.every((h) => h.reasons.includes("worker_unknown"))).toBe(true);
    } finally {
      f.store.close();
    }
  });

  it("a liveness ask that never answers is UNKNOWN past the deadline — the plan settles, every candidate held", async () => {
    const f = fixture();
    try {
      const t0 = Date.now();
      const p = await plan(f, {
        liveSessions: () => new Promise<never>(() => {}),
        liveSessionsDeadlineMs: 20,
      });
      expect(Date.now() - t0).toBeLessThan(4000);
      expect(p.workers).toBe("unknown");
      expect(p.candidates).toEqual([]);
      expect(p.held.find((h) => h.pr === 100)?.reasons).toEqual(["worker_unknown"]);
    } finally {
      f.store.close();
    }
  });

  it("the bounded liveness ask: an answer passes through, a throw is UNKNOWN, an abort rejects at once", async () => {
    expect(await askLiveSessions(async () => ["pr-1"], 1000)).toEqual(["pr-1"]);
    expect(await askLiveSessions(async () => null, 1000)).toBeNull();
    expect(
      await askLiveSessions(async () => {
        throw new Error("leases unreadable");
      }, 1000),
    ).toBeNull();
    expect(
      await askLiveSessions(() => {
        throw new Error("sync throw");
      }, 1000),
    ).toBeNull();
    const ac = new AbortController();
    const hung = askLiveSessions(() => new Promise<never>(() => {}), 60_000, ac.signal);
    ac.abort(new Error("stopped"));
    await expect(hung).rejects.toThrow("stopped");
    // An already-aborted signal never even asks.
    let asked = false;
    await expect(
      askLiveSessions(
        async () => {
          asked = true;
          return [];
        },
        1000,
        ac.signal,
      ),
    ).rejects.toThrow("stopped");
    expect(asked).toBe(false);
  });

  it("the archiver's stop() settles a tick hung on the liveness ask — the mutex is released, nothing failed", async () => {
    const f = fixture();
    try {
      const archiver = new Archiver({
        store: f.store,
        cfg: { ...ARCHIVE_DEFAULTS, mode: "plan" },
        root: f.root,
        sessionsRoot: sessionsRoot(f),
        firstHealthyReconcileAt: () => new Date(T0 - 3_600_000),
        liveSessions: () => new Promise<never>(() => {}),
        statfs: async () => ({ bavail: 1e9, bsize: 4096 }),
        now: () => new Date(T0),
        schedule: () => () => {},
      });
      const tick = archiver.tick();
      for (let i = 0; i < 20 && archiver.status().state !== "running"; i++)
        await new Promise((r) => setImmediate(r));
      expect(archiver.status().state).toBe("running");
      archiver.stop();
      const t = await tick;
      expect(t.planned).toBe(false);
      expect(t.state).not.toBe("failed");
      expect(archiver.status().last_error).toBeNull();
      expect(archiver.status().running_since).toBeNull();
    } finally {
      f.store.close();
    }
  });

  it("a running worker and an in-flight birth hold their PR; a CLI plan says births are not observed", async () => {
    const f = fixture();
    try {
      const p = await plan(f, {
        liveSessions: async () => ["pr-100", "overseer"],
        birthInFlight: (pr) => pr === 1000,
      });
      expect(p.held.map((h) => [h.pr, h.reason])).toEqual([
        [100, "worker_alive"],
        [300, "failure_open"],
        [1000, "birth_in_flight"],
      ]);
      // No births seam — a CLI process cannot see the daemon's.
      const cli = await computePlan({
        store: f.store,
        root: f.root,
        sessionsRoot: sessionsRoot(f),
        now: () => new Date(T0),
        afterDays: 14,
        eventsAfterDays: 35,
        liveSessions: async () => [],
      });
      expect(cli.births_observed).toBe(false);
    } finally {
      f.store.close();
    }
  });

  it("a top-level inject wake with a NON-terminal row holds the PR (pending_inject)", async () => {
    const f = fixture();
    try {
      f.store.db
        .prepare("UPDATE session_commands SET status = 'pending' WHERE id = 'cmd-100'")
        .run();
      const p = await plan(f);
      expect(p.held.find((h) => h.pr === 100)?.reasons).toEqual([
        "command_active",
        "pending_inject",
      ]);
    } finally {
      f.store.close();
    }
  });

  it("a live directory it cannot list fails the plan — never read as empty", async () => {
    const f = fixture();
    try {
      // A FILE where a directory should be: readdir fails ENOTDIR.
      rmSync(join(f.root, "state", "findings"), { recursive: true });
      writeFileSync(join(f.root, "state", "findings"), "not a dir");
      await expect(plan(f)).rejects.toThrow(/ENOTDIR/);
    } finally {
      f.store.close();
    }
  });
});

describe("rows — counted in rowid windows, never a full kind or ts scan", () => {
  /** A bare root and a store holding only `old` rows 40 days back (every
   * third an `anomaly`, a kind that stays live) then `young` rows a day back,
   * in id order as the daemon writes them. */
  function rowsFixture(old: number, young: number): Fixture {
    const root = mkdtempSync(join(tmpdir(), "qcr-archive-rows-"));
    roots.push(root);
    const store = new StateStore(":memory:", () => new Date(T0));
    const insert = store.db.prepare(
      "INSERT INTO events (ts, kind, pr, payload) VALUES (?, ?, NULL, NULL)",
    );
    store.db.transaction(() => {
      for (let i = 0; i < old; i++)
        insert.run(
          new Date(T0 - 40 * DAY + i).toISOString(),
          i % 3 === 0 ? "anomaly" : "recheck_noop",
        );
      for (let i = 0; i < young; i++)
        insert.run(new Date(T0 - DAY + i).toISOString(), "recheck_noop");
    })();
    return { root, store, at: () => {} };
  }

  it(
    "counts across many windows, stops at the young boundary, and a memo re-reads only what aged since",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const old = 2 * COUNT_WINDOW_ROWS + 500;
      const young = 3 * COUNT_WINDOW_ROWS;
      const f = rowsFixture(old, young);
      try {
        const memo: PlanMemo = {};
        const expected = Array.from({ length: old }, (_, i) => i).filter((i) => i % 3 !== 0).length;
        const first = await plan(f, { memo });
        expect(first.events.rows).toBe(expected);
        expect(first.events.by_kind).toEqual({ recheck_noop: expected });
        // It stopped at the first window holding a young row: three windows of
        // the 7,500 rows, never the whole table.
        expect(first.events.windows).toBe(3);
        expect(first.events.examined).toBe(3 * COUNT_WINDOW_ROWS);
        // Again with the memo: the same answer, from one window only.
        const second = await plan(f, { memo });
        expect(second.events.rows).toBe(expected);
        expect(second.events.examined).toBe(COUNT_WINDOW_ROWS);
        // Time passes: the young rows age past the cut-off, and only they are read.
        const later = await plan(f, { memo, now: () => new Date(T0 + 40 * DAY) });
        expect(later.events.rows).toBe(expected + young);
        // Resumed after the settled prefix (two full windows), to the end.
        expect(later.events.examined).toBe(old + young - 2 * COUNT_WINDOW_ROWS);
        // The mover's watermark is where a count starts (and a moved watermark
        // never reuses the memo).
        f.store.db
          .prepare("INSERT INTO archive_marks (name, value) VALUES ('events.last_id', ?)")
          .run(old);
        const after = await plan(f, { memo });
        expect(after.events.from_id).toBe(old);
        expect(after.events.rows).toBe(0);
      } finally {
        f.store.close();
      }
    },
  );

  it(
    "a watermark that moved discards the memo even at the SAME cut-off — never the memo's moved rows",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const old = 2 * COUNT_WINDOW_ROWS + 500;
      const f = rowsFixture(old, COUNT_WINDOW_ROWS);
      try {
        const memo: PlanMemo = {};
        // A plan at `now`: the memo settles the whole old prefix it read.
        await plan(f, { memo });
        const settledAt = memo.events!.settledTo;
        expect(settledAt).toBe(2 * COUNT_WINDOW_ROWS);
        // The mover took ids 1..1000. Same `now`, same memo — so the cut-off
        // clause alone would let the memo through; only the watermark
        // equality refuses it.
        const moved = 1000;
        f.store.db
          .prepare("INSERT INTO archive_marks (name, value) VALUES ('events.last_id', ?)")
          .run(moved);
        const p = await plan(f, { memo });
        expect(p.events.from_id).toBe(moved);
        // Ids are 1-based in insertion order: id = i + 1. Only the rows above
        // the watermark are backlog — the moved prefix is never counted again.
        const expected = Array.from({ length: old }, (_, i) => i).filter(
          (i) => i + 1 > moved && i % 3 !== 0,
        ).length;
        expect(p.events.rows).toBe(expected);
        expect(memo.events!.watermark).toBe(moved);
      } finally {
        f.store.close();
      }
    },
  );

  it("each window is one rowid-range read (the query plans prove it)", () => {
    const store = new StateStore(":memory:");
    try {
      const detail = (sql: string): string =>
        (store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(0, 10) as Array<{ detail: string }>)
          .map((r) => r.detail)
          .join(" | ");
      expect(detail("SELECT id, ts, kind FROM events WHERE id > ? ORDER BY id LIMIT ?")).toMatch(
        /SEARCH events USING INTEGER PRIMARY KEY \(rowid>\?\)/,
      );
      expect(
        detail(
          "SELECT rowid, received_at, NULL FROM deliveries WHERE rowid > ? ORDER BY rowid LIMIT ?",
        ),
      ).toMatch(/SEARCH deliveries USING INTEGER PRIMARY KEY \(rowid>\?\)/);
    } finally {
      store.close();
    }
  });
});

describe("PLAN MODE WRITES NOTHING (acceptance 6)", () => {
  it(
    "after a plan tick the temp root's tree hash and state.db's row census are unchanged",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = fixture();
      try {
        const archiver = new Archiver({
          store: f.store,
          cfg: { ...ARCHIVE_DEFAULTS, mode: "plan" },
          root: f.root,
          sessionsRoot: sessionsRoot(f),
          firstHealthyReconcileAt: () => new Date(T0 - 3_600_000),
          liveSessions: async () => [],
          birthInFlight: () => false,
          statfs: async () => ({ bavail: 1e9, bsize: 4096 }),
          now: () => new Date(T0),
          schedule: () => () => {},
        });
        const hash = treeHash(f.root);
        const rows = census(f.store);
        const tick = await archiver.tick();
        expect(tick).toEqual({ state: "plan", held_reason: null, planned: true });
        const status = archiver.status();
        expect(status.backlog).toMatchObject({ prs: 2, event_rows: 2, delivery_rows: 2 });
        expect(status.orphans).toEqual({ count: 1, first: ["pr-7"] });
        expect(treeHash(f.root)).toBe(hash);
        expect(census(f.store)).toEqual(rows);
        // The orphan was never touched, the legacy copy is where it was.
        expect(readFileSync(join(f.root, "state/pi-sessions/pr-7/old.jsonl"), "utf8")).toHaveLength(
          7000,
        );
        expect(statSync(join(f.root, "archive/pr-100/session.jsonl")).size).toBe(900);
      } finally {
        f.store.close();
      }
    },
  );

  it(
    "mode `on` without a births observer moves only the old reader-less event rows and deliveries — no per-PR file is touched (births unknown)",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = fixture();
      try {
        const archiver = new Archiver({
          store: f.store,
          cfg: { ...ARCHIVE_DEFAULTS, mode: "on" },
          root: f.root,
          sessionsRoot: sessionsRoot(f),
          firstHealthyReconcileAt: () => new Date(T0 - 3_600_000),
          liveSessions: async () => [],
          statfs: async () => ({ bavail: 1e9, bsize: 4096 }),
          now: () => new Date(T0),
          sleep: async () => {},
          schedule: () => () => {},
        });
        // archive/db/ made first, so the files landing in it leave archive/'s
        // own mtime alone.
        mkdirSync(join(f.root, "archive", "db"));
        const outsideDb = (): string => treeHash(f.root, /^archive\/db(\/|$)/);
        const hash = outsideDb();
        const kinds = (): string[] =>
          (
            f.store.db.prepare("SELECT kind FROM events ORDER BY id").all() as Array<{
              kind: string;
            }>
          )
            .map((r) => r.kind)
            .filter((k) => k !== "archive_pass");
        const before = kinds();
        expect((await archiver.tick()).state).toBe("idle");
        expect(archiver.status()).toMatchObject({
          mode: "on",
          state: "idle",
          db: { outcome: "caught_up", events_moved: 2, deliveries_moved: 2 },
          // The per-PR files move only where the daemon's
          // in-flight births can be read — here they cannot, so nothing moves.
          files: { outcome: "held", held_reason: "births_unknown", prs_started: 0 },
        });
        // The two old reader-less rows left; the fact kind and the young row stayed.
        const after = kinds();
        expect(before.length - after.length).toBe(2);
        expect(after).toContain("verdict_applied");
        expect(after.filter((k) => k === "webhook_event")).toHaveLength(1);
        expect(after).not.toContain("pingpong_decision_failed");
        // Deliveries: both old ones moved, the young (and newest) one stayed.
        expect(
          (f.store.db.prepare("SELECT guid FROM deliveries").all() as Array<{ guid: string }>).map(
            (r) => r.guid,
          ),
        ).toEqual(["young-1"]);
        // Every per-PR file, the legacy copy and the orphan exactly as they were.
        expect(outsideDb()).toBe(hash);
        expect(readdirSync(join(f.root, "archive", "db")).sort()).toEqual([
          "manifest.json",
          "state-2026-09.sqlite",
          "state-2026-09.sqlite-shm",
          "state-2026-09.sqlite-wal",
          "state-2026-10.sqlite",
          "state-2026-10.sqlite-shm",
          "state-2026-10.sqlite-wal",
        ]);
      } finally {
        f.store.close();
      }
    },
  );
});
