// status.json `archive` (docs/archiving.md §11): the block's
// backlog is NULL until the first plan completes (never 0); the total reader
// answers absent / unreadable / read and never throws; `qcr status` prints the
// line every time; the daemon publishes the block through its injected cached
// dependency and records its first healthy reconcile; `qcr archive status`
// renders the detail and refuses an unknown flag.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Archiver, archivePolicy } from "../src/archive/archiver.js";
import type { ArchivePlan } from "../src/archive/plan.js";
import {
  NO_ARCHIVE_BLOCK_NOTE,
  archiveLedgerSummary,
  archiveStatusJson,
  readArchiveBlockFile,
  renderArchiveReport,
} from "../src/archive/report.js";
import {
  archiveAttention,
  archiveStatusLine,
  pendingArchiveStatus,
  readArchiveStatus,
  type ArchiveStatus,
} from "../src/archive/status.js";
import { ARCHIVE_USAGE, parseArchiveArgs, renderStatus } from "../src/cli.js";
import { ARCHIVE_DEFAULTS, loadConfig } from "../src/config.js";
import { createDaemon, type DaemonAdapter } from "../src/daemon.js";
import { buildStatusSnapshot, StateStore, type StatusSnapshot } from "../src/state.js";
import { stubSessionHooks } from "../src/stubs.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const T0 = Date.parse("2026-10-21T12:00:00.000Z");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A block as a planning archiver publishes it. */
function planned(over: Partial<ArchiveStatus> = {}): ArchiveStatus {
  return {
    ...pendingArchiveStatus("plan"),
    state: "plan",
    last_tick_at: "2026-10-21T12:00:00.000Z",
    last_success_at: "2026-10-21T12:00:00.000Z",
    plan_at: "2026-10-21T12:00:00.000Z",
    backlog: { prs: 485, bytes: 3_700_000_000, event_rows: 1_100_000, delivery_rows: 113_566 },
    totals: {
      prs: 0,
      files: 0,
      bytes_in: 0,
      bytes_out: 0,
      event_rows: 0,
      delivery_rows: 0,
      duplicates_removed: 0,
    },
    disk: { archive_free: 44 * 1024 ** 3, state_free: 44 * 1024 ** 3, headroom: 2 * 1024 ** 3 },
    verify_failures_24h: 0,
    restores: { pending: 0, done: 0, failed: 0 },
    held_prs: {
      count: 2,
      first: [
        { pr: 5546, reason: "failure_open" },
        { pr: 5682, reason: "tmux_alive" },
      ],
    },
    orphans: { count: 1, first: ["pr-7"] },
    freelist_pages: 0,
    max_sync_span_ms: 4.2,
    ...over,
  };
}

describe("the backlog is null until the first plan completes — never 0", () => {
  it("before the archiver exists, before its first tick, while held, after a failed plan", async () => {
    expect(pendingArchiveStatus("plan")).toMatchObject({ state: "unknown", backlog: null });
    const store = new StateStore(":memory:");
    let healthy: Date | null = null;
    let fail = true;
    const plan = (): ArchivePlan =>
      ({
        computed_at: new Date(T0).toISOString(),
        backlog: { prs: 0, bytes: 0, event_rows: 0, delivery_rows: 0 },
        held: [],
        orphans: [],
        max_sync_span_ms: 1,
        took_ms: 1,
      }) as unknown as ArchivePlan;
    const a = new Archiver({
      store,
      cfg: { ...ARCHIVE_DEFAULTS },
      root: "/sandbox",
      sessionsRoot: "/sandbox/state/pi-sessions",
      firstHealthyReconcileAt: () => healthy,
      statfs: async () => ({ bavail: 1e12, bsize: 1 }),
      plan: async () => {
        if (fail) throw new Error("listing failed");
        return plan();
      },
      now: () => new Date(T0),
      schedule: () => () => {},
    });
    try {
      expect(a.status()).toMatchObject({ state: "unknown", backlog: null, held_prs: null });
      await a.tick();
      expect(a.status()).toMatchObject({ state: "held", backlog: null });
      healthy = new Date(T0 - 3_600_000);
      await a.tick();
      expect(a.status()).toMatchObject({ state: "failed", backlog: null, plan_at: null });
      fail = false;
      await a.tick();
      // A plan that found NOTHING is a real 0 — only now.
      expect(a.status()).toMatchObject({
        state: "plan",
        backlog: { prs: 0, bytes: 0, event_rows: 0, delivery_rows: 0 },
        held_prs: { count: 0, first: [] },
        orphans: { count: 0, first: [] },
      });
    } finally {
      store.close();
    }
  });

  it("totals and restores come from the archive ledger; free pages from state.db's header", () => {
    const store = new StateStore(":memory:");
    try {
      const ins = store.db.prepare(
        `INSERT INTO archive_prs (pr, state, archived_at, transcript_files, state_files, bytes_in, bytes_out, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'x')`,
      );
      ins.run(1, "archived", "2026-10-20T00:00:00.000Z", 3, 10, 1000, 300);
      ins.run(2, "restored", "2026-10-19T00:00:00.000Z", 1, 2, 100, 30);
      ins.run(3, "restore_failed", "2026-10-19T00:00:00.000Z", 0, 0, 0, 0);
      ins.run(4, "archived", "2026-10-19T00:00:00.000Z", 0, 0, 0, 0);
      store.upsertPr({
        number: 4,
        state: "tracked", // reopened, not restored yet
        head_sha: "a",
        title: "t",
        author: "a",
        trigger_ts: null,
        stale_recheck: 0,
        migration_gate: 0,
      });
      store.db
        .prepare(
          "INSERT INTO archived_event_counts (kind, day, n) VALUES ('webhook_event', '2026-08-21', 12)",
        )
        .run();
      store.db
        .prepare("INSERT INTO archive_marks (name, value) VALUES ('deliveries.archived_rows', 5)")
        .run();
      const a = new Archiver({
        store,
        cfg: { ...ARCHIVE_DEFAULTS },
        root: "/sandbox",
        sessionsRoot: "/sandbox/state/pi-sessions",
        firstHealthyReconcileAt: () => null,
        now: () => new Date(T0),
      });
      expect(a.status()).toMatchObject({
        totals: {
          prs: 4,
          files: 16,
          bytes_in: 1100,
          bytes_out: 330,
          event_rows: 12,
          delivery_rows: 5,
          duplicates_removed: 0,
        },
        restores: { pending: 1, done: 1, failed: 1 },
        freelist_pages: 0,
      });
    } finally {
      store.close();
    }
  });
});

describe("readArchiveStatus — total over whatever JSON is there", () => {
  it("absent, unreadable, read", () => {
    expect(readArchiveStatus(undefined)).toEqual({ kind: "absent" });
    const ok = JSON.parse(JSON.stringify(planned()));
    expect(readArchiveStatus(ok)).toEqual({ kind: "read", view: ok });
    expect(
      readArchiveStatus(JSON.parse(JSON.stringify(pendingArchiveStatus("off")))),
    ).toMatchObject({
      kind: "read",
      view: { mode: "off", state: "unknown", backlog: null },
    });
    expect(readArchiveStatus(null)).toEqual({
      kind: "unreadable",
      why: "the archive block is null, not an object",
    });
    expect(readArchiveStatus({ ...ok, state: "vacuuming" })).toEqual({
      kind: "unreadable",
      why: 'state "vacuuming" is not one this build knows',
    });
    expect(readArchiveStatus({ ...ok, mode: "auto" })).toMatchObject({ kind: "unreadable" });
    expect(readArchiveStatus({ ...ok, backlog: { ...ok.backlog, bytes: "3.7 GB" } })).toEqual({
      kind: "unreadable",
      why: 'backlog.bytes is "3.7 GB", not a number',
    });
    expect(readArchiveStatus({ ...ok, held_prs: { count: 1, first: [{ pr: "x" }] } })).toEqual({
      kind: "unreadable",
      why: "held_prs.first is unreadable",
    });
    expect(readArchiveStatus({ ...ok, orphans: { count: 1, first: [7] } })).toEqual({
      kind: "unreadable",
      why: "orphans is unreadable",
    });
  });

  it("never throws: every key set to every wrong shape, and every key deleted", () => {
    const ok = JSON.parse(JSON.stringify(planned())) as Record<string, unknown>;
    const wrongs: unknown[] = [
      undefined,
      null,
      0,
      -1,
      "x",
      true,
      [],
      {},
      { count: "1" },
      Number.NaN,
    ];
    for (const key of Object.keys(ok)) {
      for (const w of wrongs) {
        const mutated = { ...ok, [key]: w };
        const r = readArchiveStatus(mutated);
        expect(["read", "unreadable"], `${key} = ${String(w)}`).toContain(r.kind);
        expect(() => archiveStatusLine(mutated)).not.toThrow();
      }
      const { [key]: _gone, ...without } = ok;
      expect(() => readArchiveStatus(without)).not.toThrow();
    }
    for (const v of [0, "x", [], true, () => 1, Symbol("s")])
      expect(readArchiveStatus(v).kind).toBe("unreadable");
  });
});

describe("the file phase's block", () => {
  const files = {
    last_run_at: "2026-10-21T12:00:00.000Z",
    outcome: "done",
    held_reason: null,
    prs_started: 2,
    prs_archived: 2,
    prs_partial: 0,
    prs_held: 0,
    transcripts: 5,
    state_files: 40,
    bytes_in: 3 * 1024 * 1024,
    bytes_out: 900 * 1024,
    removed: 45,
    duplicates_removed: 1,
    verify_failures: 0,
  };

  it("is read back whole; absent (an older daemon) and null read as null; a bad field is unreadable", () => {
    const ok = JSON.parse(JSON.stringify({ ...planned(), mode: "on", state: "idle", files }));
    expect(readArchiveStatus(ok)).toEqual({ kind: "read", view: ok });
    const { files: _f, ...older } = ok;
    expect(readArchiveStatus(older)).toMatchObject({ kind: "read", view: { files: null } });
    expect(readArchiveStatus({ ...ok, files: { ...files, removed: "45" } })).toEqual({
      kind: "unreadable",
      why: 'files.removed is "45", not a number',
    });
  });

  it("rides the qcr status line: what moved, a hold, a failure — and nothing before it has run", () => {
    const on = { ...planned(), mode: "on" as const, state: "idle" as const };
    expect(archiveStatusLine({ ...on, files })).toContain(
      "files: 2 PR(s) archived last run (3.0 MB → 900.0 KB, 45 live file(s) removed, 1 legacy duplicate(s); done)",
    );
    expect(
      archiveStatusLine({
        ...on,
        files: { ...files, outcome: "held", held_reason: "births_unknown", prs_started: 0 },
      }),
    ).toContain("files HELD (births_unknown)");
    expect(archiveStatusLine({ ...on, files: { ...files, verify_failures: 2 } })).toContain(
      "2 VERIFY FAILURE(S)",
    );
    expect(archiveStatusLine({ ...on, files: null })).not.toContain("files");
  });
});

describe("the one line `qcr status` prints", () => {
  it("says what it knows, and UNKNOWN for what it does not", () => {
    expect(archiveStatusLine(undefined)).toBe(
      "archive: NOT REPORTED (this daemon predates the archive block)",
    );
    expect(archiveStatusLine({ state: "x" })).toMatch(/^archive: UNKNOWN \(unreadable block: /);
    expect(archiveStatusLine(pendingArchiveStatus("plan"))).toBe(
      "archive: mode plan — UNKNOWN, not ticked yet; backlog UNKNOWN (no plan has completed yet)",
    );
    // Before the first tick, a failed or stranded restore the ledger already
    // shows is said all the same.
    expect(
      archiveStatusLine({
        ...pendingArchiveStatus("plan"),
        restores: { pending: 2, done: 0, failed: 1 },
      }),
    ).toBe(
      "archive: mode plan — UNKNOWN, not ticked yet; backlog UNKNOWN (no plan has completed yet); 1 RESTORE(S) FAILED; 2 REOPENED PR(S) AWAITING RESTORE — mode is plan, so no tick or birth restores them: run `qcr archive restore <pr>`",
    );
    expect(archiveStatusLine({ ...pendingArchiveStatus("plan"), state: "off" })).toContain(
      "archive: off",
    );
    expect(
      archiveStatusLine({
        ...pendingArchiveStatus("plan"),
        state: "held",
        held_reason: "draining",
      }),
    ).toBe("archive: mode plan — HELD (draining); backlog UNKNOWN (no plan has completed yet)");
    expect(
      archiveStatusLine({
        ...pendingArchiveStatus("plan"),
        state: "held",
        held_reason: "start_delay",
        held_until: "2026-10-21T12:10:00.000Z",
      }),
    ).toContain(
      "HELD (start delay after the first healthy reconcile) until 2026-10-21T12:10:00.000Z",
    );
    expect(archiveStatusLine(planned())).toBe(
      "archive: mode plan — planning only, nothing moved; backlog 485 PR(s) · 3.4 GB · 1.10M event row(s) · 113.6k delivery row(s) (planned 2026-10-21T12:00:00.000Z); 2 closed PR(s) held; 1 orphan session dir(s)",
    );
    expect(archiveStatusLine(planned({ state: "failed", last_error: "EACCES" }))).toMatch(
      /^archive: mode plan — FAILED at .*: EACCES; backlog 485/,
    );
  });

  it("a reopened PR awaiting its restore is said — loudly, with the verb, when the mode will never restore it", () => {
    const restores = { pending: 2, done: 0, failed: 0 };
    // Plan mode after an `on` period: no tick or birth restores it.
    expect(archiveStatusLine(planned({ restores }))).toContain(
      "2 REOPENED PR(S) AWAITING RESTORE — mode is plan, so no tick or birth restores them: run `qcr archive restore <pr>`",
    );
    // Off arms nothing, and still says it.
    expect(archiveStatusLine({ ...planned({ restores }), mode: "off", state: "off" })).toBe(
      'archive: off ([archive] mode = "off" — nothing armed); 2 REOPENED PR(S) AWAITING RESTORE — mode is off, so no tick or birth restores them: run `qcr archive restore <pr>`',
    );
    // On: the next birth or tick restores it; said quietly.
    const on = archiveStatusLine({ ...planned({ restores }), mode: "on", state: "idle" });
    expect(on).toContain("2 reopened PR(s) awaiting restore");
    expect(on).not.toContain("qcr archive restore");
    expect(archiveStatusLine(planned())).not.toMatch(/awaiting restore/i);
  });

  it("archiveAttention: what the board's banner and the companion carry — disk holds, failed and stranded restores, repeated verify failures; nothing else", () => {
    expect(archiveAttention(planned())).toEqual([]);
    expect(archiveAttention(planned({ state: "held", held_reason: "draining" }))).toEqual([]);
    expect(archiveAttention(planned({ state: "held", held_reason: "disk_low" }))).toEqual([
      "HELD: free disk below the headroom",
    ]);
    expect(archiveAttention(planned({ state: "held", held_reason: "disk_unknown" }))).toEqual([
      "HELD: free disk UNKNOWN",
    ]);
    expect(
      archiveAttention(
        planned({ restores: { pending: 1, done: 0, failed: 2 }, verify_failures_24h: 3 }),
      ),
    ).toEqual([
      "2 RESTORE(S) FAILED",
      "1 REOPENED PR(S) AWAITING RESTORE (mode plan: qcr archive restore <pr>)",
      "3 VERIFY FAILURES in 24h",
    ]);
    // In mode on a pending restore is the next tick's or birth's: no banner.
    expect(
      archiveAttention({
        ...planned({ restores: { pending: 1, done: 0, failed: 0 } }),
        mode: "on",
      }),
    ).toEqual([]);
    expect(archiveAttention(planned({ verify_failures_24h: 2 }))).toEqual([]);
  });

  it("a DB run the live checkpoint stopped says what it moved — never 'nothing deleted'", () => {
    const db = {
      last_run_at: "2026-10-21T12:00:00.000Z",
      outcome: "skipped",
      skipped_reason: "checkpoint_failed",
      events_moved: 1500,
      deliveries_moved: 0,
      batch_rows: 750,
      sync_ms: 40,
      months_open: 1,
      months_sealed: 0,
    };
    const line = archiveStatusLine({ ...planned(), mode: "on", state: "idle", db });
    expect(line).toContain(
      "db STOPPED (checkpoint_failed: the live checkpoint off the loop failed) at 2026-10-21T12:00:00.000Z after 1500 event / 0 delivery row(s) moved",
    );
    expect(line).not.toContain("nothing deleted");
    expect(
      archiveStatusLine({
        ...planned(),
        mode: "on",
        state: "idle",
        db: { ...db, skipped_reason: "live_busy", events_moved: 0 },
      }),
    ).toContain("db SKIPPED (live_busy) at 2026-10-21T12:00:00.000Z, nothing deleted");
  });

  it("a skip confined to one table still reports the rows the other table moved", () => {
    const line = archiveStatusLine({
      ...planned(),
      mode: "on",
      state: "idle",
      db: {
        last_run_at: "2026-10-21T12:00:00.000Z",
        outcome: "skipped",
        skipped_reason: "archive_busy",
        events_moved: 0,
        deliveries_moved: 900,
        batch_rows: 450,
        sync_ms: 30,
        months_open: 1,
        months_sealed: 0,
      },
    });
    expect(line).toContain(
      "db SKIPPED (archive_busy) at 2026-10-21T12:00:00.000Z, 0 event / 900 delivery row(s) moved",
    );
    expect(line).not.toContain("nothing deleted");
  });

  it("renderStatus prints it on every snapshot, right after the event-loop line", () => {
    const base: StatusSnapshot = {
      written_at: "2026-10-21T12:00:00.000Z",
      dry_run: false,
      prs: [],
      running_rounds: 0,
      total_spend_usd: 0,
      heartbeat: "2026-10-21T12:00:00.000Z",
    };
    const absent = renderStatus(base).split("\n");
    expect(absent[2]).toContain("memory:");
    expect(absent[3]).toMatch(/^daemon event loop:/);
    expect(absent[4]).toBe("archive: NOT REPORTED (this daemon predates the archive block)");
    expect(renderStatus({ ...base, archive: planned() }).split("\n")[4]).toMatch(
      /^archive: mode plan — planning only, nothing moved; backlog 485 PR\(s\)/,
    );
    // A block this build cannot read is a line, never a crash.
    expect(
      renderStatus({ ...base, archive: { state: 7 } as unknown as ArchiveStatus }).split("\n")[4],
    ).toMatch(/^archive: UNKNOWN \(unreadable block/);
  });
});

describe("the daemon publishes the block and records its first healthy reconcile", () => {
  it("buildStatusSnapshot carries the block when given, and omits it when not", () => {
    const store = new StateStore(":memory:");
    try {
      expect(buildStatusSnapshot(store, false).archive).toBeUndefined();
      const snap = buildStatusSnapshot(
        store,
        false,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        planned(),
      );
      expect(JSON.parse(JSON.stringify(snap)).archive).toEqual(planned());
    } finally {
      store.close();
    }
  });

  function stubDaemon(
    root: string,
    store: StateStore,
    archiveStatus?: () => ArchiveStatus,
    opts: { listOpenPrs?: () => Promise<unknown[]>; now?: () => Date } = {},
  ) {
    for (const d of ["state", "state/dryrun", "verdict", "inject"])
      mkdirSync(join(root, d), { recursive: true });
    const adapter = {
      searchLabelTriggered: async () => [],
      searchTeamTriggered: async () => [],
      listOpenPrs: opts.listOpenPrs ?? (async () => []),
      stalenessScan: async () => [],
      listBotReviewComments: async () => [],
    } as unknown as DaemonAdapter;
    return createDaemon({
      cfg: loadConfig(join(process.cwd(), "tests/fixtures/config.toml")),
      root,
      store,
      adapter,
      hooks: stubSessionHooks(root),
      listen: false,
      log: () => {},
      now: opts.now ?? (() => new Date(T0)),
      eventLoop: { setTimer: () => "never", clearTimer: () => {} },
      ...(archiveStatus ? { archiveStatus } : {}),
    });
  }

  it(
    "status.json carries the injected block; the first healthy reconcile is null before start and stamped after",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const root = mkdtempSync(join(tmpdir(), "qcr-archive-daemon-"));
      dirs.push(root);
      const store = new StateStore(":memory:");
      try {
        const daemon = stubDaemon(root, store, () => planned());
        expect(daemon.firstHealthyReconcileAt()).toBeNull();
        await daemon.start();
        expect(daemon.firstHealthyReconcileAt()?.toISOString()).toBe(new Date(T0).toISOString());
        const snap = JSON.parse(
          readFileSync(join(root, "state", "status.json"), "utf8"),
        ) as StatusSnapshot;
        expect(snap.archive).toEqual(planned());
        await daemon.stop();
      } finally {
        store.close();
      }
    },
  );

  it(
    "only a pass with NO step error stamps the first healthy reconcile — and the first stamp stays",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const root = mkdtempSync(join(tmpdir(), "qcr-archive-daemon-"));
      dirs.push(root);
      const store = new StateStore(":memory:");
      const clock = { ms: T0 };
      let failing = true;
      try {
        const daemon = stubDaemon(root, store, undefined, {
          now: () => new Date(clock.ms),
          listOpenPrs: async () => {
            if (failing) throw new Error("502 Bad Gateway");
            return [];
          },
        });
        // The boot pass errs (listOpenPrs is a step error): no stamp.
        await daemon.start();
        expect(daemon.firstHealthyReconcileAt()).toBeNull();
        // A later clean pass stamps ITS end, not the boot's.
        failing = false;
        clock.ms = T0 + 5 * 60_000;
        await daemon.reconcile();
        expect(daemon.firstHealthyReconcileAt()?.toISOString()).toBe(
          new Date(T0 + 5 * 60_000).toISOString(),
        );
        // Another clean pass — and an erring one — leave the first stamp alone.
        clock.ms = T0 + 10 * 60_000;
        await daemon.reconcile();
        failing = true;
        clock.ms = T0 + 15 * 60_000;
        await daemon.reconcile();
        expect(daemon.firstHealthyReconcileAt()?.toISOString()).toBe(
          new Date(T0 + 5 * 60_000).toISOString(),
        );
        await daemon.stop();
      } finally {
        store.close();
      }
    },
  );

  it(
    "a throwing archive read never stops the heartbeat — the block is simply absent",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const root = mkdtempSync(join(tmpdir(), "qcr-archive-daemon-"));
      dirs.push(root);
      const store = new StateStore(":memory:");
      try {
        const daemon = stubDaemon(root, store, () => {
          throw new Error("ledger unreadable");
        });
        await daemon.start();
        const snap = JSON.parse(
          readFileSync(join(root, "state", "status.json"), "utf8"),
        ) as StatusSnapshot;
        expect(snap.heartbeat).toBeDefined();
        expect(snap.archive).toBeUndefined();
        await daemon.stop();
      } finally {
        store.close();
      }
    },
  );
});

describe("qcr archive status", () => {
  it("takes `status` and `--plan` only — an unknown token is refused", () => {
    expect(parseArchiveArgs(["status"])).toEqual({ verb: "status", plan: false });
    expect(parseArchiveArgs(["status", "--plan"])).toEqual({ verb: "status", plan: true });
    expect(() => parseArchiveArgs([])).toThrow(ARCHIVE_USAGE);
    expect(() => parseArchiveArgs(["status", "--pln"])).toThrow(ARCHIVE_USAGE);
    // The operator verbs are parsed in tests/archive-operator.test.ts; a
    // stray token after one is refused all the same.
    expect(() => parseArchiveArgs(["run", "now"])).toThrow(ARCHIVE_USAGE);
  });

  it("renders the block, the policy, the ledger — and the plan detail", () => {
    const store = new StateStore(":memory:");
    try {
      const tally = (files: number, bytes: number) => ({ files, bytes });
      const plan = {
        computed_at: "2026-10-21T12:00:00.000Z",
        took_ms: 2100,
        after_days: 14,
        events_after_days: 35,
        files_cutoff: "2026-10-07T12:00:00.000Z",
        registry: {
          prs: 745,
          open: 49,
          closed: 696,
          waiting: 199,
          eligible: 485,
          held: 12,
          archived: 0,
        },
        candidates: [],
        empty: [9],
        held: [{ pr: 5546, reason: "failure_open", reasons: ["failure_open"] }],
        orphans: ["pr-1", "pr-2"],
        artifacts: {
          transcripts: tally(1200, 3_700_000_000),
          round_prompts: tally(800, 50_000_000),
          session_commands: tally(2000, 60_000_000),
          findings: tally(700, 5_000_000),
          posting_receipts: tally(600, 2_000_000),
          round_files: tally(4000, 60_000_000),
          session_files: tally(1400, 9_000_000),
          inject_done: tally(3000, 50_000_000),
          stale_injects: tally(3, 3000),
          verdicts: tally(2500, 9_000_000),
          live_logs: tally(0, 0),
          lens_sessions: tally(0, 0),
        },
        ledger_snapshots: tally(480, 2_000_000),
        legacy_copies: tally(470, 1_700_000_000),
        events: {
          rows: 1_100_000,
          by_kind: { pingpong_decision_failed: 900_000 },
          cutoff: "2026-09-16T12:00:00.000Z",
          from_id: 0,
          examined: 1_100_400,
          windows: 551,
        },
        deliveries: {
          rows: 113_566,
          cutoff: "2026-10-07T12:00:00.000Z",
          from_id: 0,
          examined: 114_000,
          windows: 57,
        },
        backlog: { prs: 486, bytes: 3_945_003_000, event_rows: 1_100_000, delivery_rows: 113_566 },
        births_observed: false,
        tmux: "answered",
        same_device: false,
        max_sync_span_ms: 6.4,
      } as ArchivePlan;
      const out = renderArchiveReport({
        block: planned(),
        statusNote: null,
        ledger: archiveLedgerSummary(store),
        policy: archivePolicy(ARCHIVE_DEFAULTS),
        plan,
      });
      expect(out).toContain("archive: mode plan — planning only, nothing moved");
      expect(out).toContain(
        "policy: mode plan · files and deliveries after 14 d · events after 35 d · every 60 s · start delay 10 min · tick budget 20 s · ≤ 5 PR(s)/tick · ≤ 8.0 MB/s · headroom 2.0 GB · DB batch 500 rows · gzip 6",
      );
      expect(out).toContain("ledger: archive_prs empty; archived event rows 0");
      expect(out).toMatch(
        /registry: 745 PR\(s\) — 49 open, 696 closed: 199 inside the 14-day window, 485 eligible, 12 held/,
      );
      expect(out).toMatch(/transcripts\s+1200\s+file\(s\)\s+3\.4 GB/);
      expect(out).toContain("held (1): #5546 failure_open");
      expect(out).toContain(
        "orphans — pi-sessions dirs with no registry row, never touched (2): pr-1, pr-2",
      );
      expect(out).toContain("session births: not visible from a CLI process");
      expect(out).toContain("archive/ and state/ on one device: no");
      expect(
        renderArchiveReport({
          block: undefined,
          statusNote: "no status.json yet — is the daemon running?",
          ledger: archiveLedgerSummary(store),
          policy: archivePolicy(ARCHIVE_DEFAULTS),
          plan: null,
        }).split("\n")[0],
      ).toBe("archive: no status.json yet — is the daemon running?");
    } finally {
      store.close();
    }
  });
});

describe("qcr archive status --json — the reader's verdict, never a bare null", () => {
  function statusFile(content: string | null): string {
    const dir = mkdtempSync(join(tmpdir(), "qcr-archive-json-"));
    dirs.push(dir);
    const p = join(dir, "status.json");
    if (content !== null) writeFileSync(p, content);
    return p;
  }
  const json = (path: string, store: StateStore) => {
    const r = readArchiveBlockFile(path);
    return JSON.parse(
      JSON.stringify(
        archiveStatusJson({
          ...r,
          ledger: archiveLedgerSummary(store),
          policy: archivePolicy(ARCHIVE_DEFAULTS),
          plan: null,
        }),
      ),
    ) as Record<string, unknown>;
  };

  it("absent, unreadable and read are told apart — and each says why", () => {
    const store = new StateStore(":memory:");
    try {
      // status.json exists, the daemon predates the block.
      const old = json(statusFile(JSON.stringify({ heartbeat: "x" })), store);
      expect(old.archive).toBeNull();
      expect(old.archive_read).toEqual({ kind: "absent" });
      expect(old.status_note).toBe(NO_ARCHIVE_BLOCK_NOTE);
      // No status.json at all.
      const none = json(statusFile(null), store);
      expect(none.archive_read).toEqual({ kind: "absent" });
      expect(none.status_note).toBe("no status.json yet — is the daemon running?");
      // status.json that does not parse.
      const torn = json(statusFile("{ not json"), store);
      expect(torn.archive).toBeNull();
      expect((torn.archive_read as { kind: string }).kind).toBe("unreadable");
      expect(torn.status_note).toMatch(/^status\.json is unreadable: /);
      // A block the reader refuses: the raw block, and why.
      const bad = json(statusFile(JSON.stringify({ archive: null })), store);
      expect(bad.archive).toBeNull();
      expect(bad.archive_read).toEqual({
        kind: "unreadable",
        why: "the archive block is null, not an object",
      });
      expect(bad.status_note).toBeNull();
      // A good block: read, as published.
      const good = json(statusFile(JSON.stringify({ archive: planned() })), store);
      expect(good.archive).toEqual(planned());
      expect(good.archive_read).toEqual({ kind: "read" });
      expect(good.status_note).toBeNull();
    } finally {
      store.close();
    }
  });

  it("the text route keeps NOT REPORTED for a status.json with no block", () => {
    const store = new StateStore(":memory:");
    try {
      const r = readArchiveBlockFile(statusFile(JSON.stringify({ heartbeat: "x" })));
      expect(
        renderArchiveReport({
          block: r.block,
          statusNote: r.statusNote,
          ledger: archiveLedgerSummary(store),
          policy: archivePolicy(ARCHIVE_DEFAULTS),
          plan: null,
        }).split("\n")[0],
      ).toBe("archive: NOT REPORTED (this daemon predates the archive block)");
    } finally {
      store.close();
    }
  });
});
