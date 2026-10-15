// The undelivered-recheck sweep must never block the daemon's event loop.
// Every recheck claim re-proves its receipt from the PR's session transcript;
// decoding a whole transcript per claim, synchronously, inside an `async` loop
// whose `await`s never leave the microtask queue stalls the loop for minutes
// at live scale. These pin, at the scale of the live data's shape: what the
// sweep may read, that it reads each byte once, that it yields, and the
// cheaper paths around it (the rounds index, the `/health` pipeline block,
// one reconcile at a time, the boot pass).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, parseConfig, type Config } from "../src/config.js";
import { createDaemon, RECONCILE_OVERDUE_INTERVALS, type DaemonAdapter } from "../src/daemon.js";
import type { GateResult } from "../src/gate.js";
import type { PrRef } from "../src/github.js";
import { ReceiptIndex } from "../src/receiptscan.js";
import type { RoundStageSupervisorHealth } from "../src/session-command-supervisor.js";
import { reconcileOnce, type ReconcileAdapter } from "../src/reconcile.js";
import { buildPipelineStatus, buildStatusSnapshot, StateStore } from "../src/state.js";
import { recheckPromptMarker, type SessionHooks } from "../src/types.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const cfg: Config = parseConfig(
  readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8"),
);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-boot-stall-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function ref(number: number): PrRef {
  return {
    number,
    title: `PR ${number}`,
    author: "alice",
    head_sha: `sha${number}`,
    base_ref: "master",
    updated_at: "2026-10-07T09:00:00Z",
    state: "open",
    draft: false,
    merged: false,
    labels: [],
  } as PrRef;
}

function seed(store: StateStore, number: number, state: "tracked" | "closed"): void {
  store.upsertPr({
    number,
    state,
    head_sha: `sha${number}`,
    title: `PR ${number}`,
    author: "alice",
    trigger_ts: null,
    stale_recheck: 0,
    migration_gate: 0,
  });
}

/** A turn counter: how many real event-loop iterations ran while `fn` did. */
async function countingTurns<T>(fn: () => Promise<T>): Promise<{ out: T; turns: number }> {
  let turns = 0;
  let on = true;
  const tick = (): void => {
    turns++;
    if (on) setImmediate(tick);
  };
  setImmediate(tick);
  try {
    const out = await fn();
    return { out, turns };
  } finally {
    on = false;
  }
}

describe("the undelivered-recheck sweep at the live data's shape", () => {
  it(
    "asks only claims that can still be lost, reads each transcript byte once, and yields throughout",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      // The live snapshot's proportions, scaled down: most claims on CLOSED
      // PRs, a third no-op claims, a few dozen open PRs whose claims are half
      // delivered — and session transcripts that every claim of a PR shares.
      const store = new StateStore(":memory:");
      const sessions = join(dir, "pi-sessions");
      const OPEN = 40;
      const CLOSED = 20;
      const PER_OPEN = 10; // nudged claims per open PR, half delivered
      const NOOP_PER_OPEN = 8; // no-op claims per open PR (never carry a token)
      const PER_CLOSED = 60;
      const FILE = 256 * 1024;
      const old = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
      const filler = `${JSON.stringify({ type: "toolResult", text: "x".repeat(250) })}\n`;
      const claim = (pr: number, fp: string, nudge: boolean): void => {
        store.claimRecheck(pr, fp, {
          head_sha: `sha${pr}`,
          trigger: "push",
          reason: nudge ? "3 changed file(s) this review" : "noop:trivial-delta",
          nudge,
        });
        store.db
          .prepare("UPDATE rechecks SET created_at = ? WHERE pr = ? AND fingerprint = ?")
          .run(old, pr, fp);
      };
      const transcript = (pr: number, tokens: string[]): number => {
        mkdirSync(join(sessions, `pr-${pr}`), { recursive: true });
        const body =
          filler.repeat(Math.ceil(FILE / filler.length)) +
          tokens.map((t) => `${JSON.stringify({ message: { role: "user", text: t } })}\n`).join("");
        writeFileSync(join(sessions, `pr-${pr}`, "session.jsonl"), body);
        return Buffer.byteLength(body);
      };
      let openBytes = 0;
      const open: PrRef[] = [];
      for (let i = 0; i < OPEN; i++) {
        const pr = 6000 + i;
        seed(store, pr, "tracked");
        open.push(ref(pr));
        const delivered: string[] = [];
        for (let k = 0; k < PER_OPEN; k++) {
          claim(pr, `base_advance:${pr}:${k}`, true);
          if (k % 2 === 0) delivered.push(recheckPromptMarker(pr, `base_advance:${pr}:${k}`));
        }
        for (let k = 0; k < NOOP_PER_OPEN; k++) claim(pr, `push:noop${k}`, false);
        openBytes += transcript(pr, delivered);
      }
      for (let i = 0; i < CLOSED; i++) {
        const pr = 5000 + i;
        seed(store, pr, "closed");
        for (let k = 0; k < PER_CLOSED; k++) claim(pr, `push:${k}`, true);
        transcript(pr, []); // a session dir nobody deletes — must never be read
      }

      const index = new ReceiptIndex();
      const asked: number[] = [];
      const hooks: SessionHooks = {
        async dispatchRound() {},
        async inject() {},
        async injectOverseer() {},
        async archiveAndClose() {},
        async injectPending() {
          return false;
        },
        async wakeReceiptPresent(pr, marker, since) {
          asked.push(pr);
          return (await index.present(join(sessions, `pr-${pr}`), marker, since)).answer;
        },
      };
      const adapter: ReconcileAdapter = {
        searchLabelTriggered: async () => [],
        searchTeamTriggered: async () => [],
        listOpenPrs: async () => open,
        getPr: async (n) => ref(n),
        listBotReviewComments: async () => [],
      };
      const total = OPEN * (PER_OPEN + NOOP_PER_OPEN) + CLOSED * PER_CLOSED;
      expect(store.db.prepare("SELECT COUNT(*) AS n FROM rechecks").get()).toEqual({ n: total });

      const first = await countingTurns(() => reconcileOnce({ cfg, store, adapter, hooks }));
      // Only the open PRs' real nudges were asked about…
      expect(first.out.receipt_sweep).toEqual({
        asked: OPEN * PER_OPEN,
        delivered: (OPEN * PER_OPEN) / 2,
        released: (OPEN * PER_OPEN) / 2,
        carried: 0,
      });
      expect(asked.every((pr) => pr >= 6000)).toBe(true);
      // …each transcript was read ONCE for all ten of its claims, and no
      // closed PR's transcript at all.
      const read = index.stats().bytes_read;
      expect(read).toBe(openBytes);
      expect(index.stats().full_scans).toBe(OPEN);
      // And other work ran all through it: a real turn per claim at least.
      expect(first.turns).toBeGreaterThanOrEqual(OPEN * PER_OPEN);

      // The next pass has nothing left to prove: delivered claims are recorded,
      // undelivered ones released, no-op and closed-PR claims never in scope.
      asked.length = 0;
      const second = await reconcileOnce({ cfg, store, adapter, hooks });
      expect(second.receipt_sweep).toMatchObject({ asked: 0, delivered: 0, released: 0 });
      expect(asked).toEqual([]);
      expect(index.stats().bytes_read).toBe(read);
      // Every no-op claim and every closed PR's claim is still there.
      expect(store.db.prepare("SELECT COUNT(*) AS n FROM rechecks WHERE nudged = 0").get()).toEqual(
        { n: OPEN * NOOP_PER_OPEN },
      );
      expect(store.db.prepare("SELECT COUNT(*) AS n FROM rechecks WHERE pr < 6000").get()).toEqual({
        n: CLOSED * PER_CLOSED,
      });
      store.close();
    },
  );
});

describe("the rechecks migration (boot stall)", () => {
  it("backfills no-op claims as un-nudged once, from the reason they were written with", () => {
    const path = join(dir, "state.db");
    // A pre-migration store: the rechecks table as it was.
    const legacy = new Database(path);
    legacy.exec(`CREATE TABLE rechecks (
      pr INTEGER NOT NULL, fingerprint TEXT NOT NULL, head_sha TEXT NOT NULL,
      trigger TEXT NOT NULL, reason TEXT, created_at TEXT NOT NULL,
      PRIMARY KEY (pr, fingerprint))`);
    const put = legacy.prepare(
      "INSERT INTO rechecks (pr, fingerprint, head_sha, trigger, reason, created_at) VALUES (?, ?, 'h', 'push', ?, '2026-10-06T11:07:00Z')",
    );
    put.run(5841, "push:a", "noop:trivial-delta");
    put.run(5841, "push:b", "dispatch-short-circuit:empty-delta");
    put.run(5841, "push:c", "3 changed file(s) this review");
    put.run(5841, "push:d", null);
    legacy.close();

    const store = new StateStore(path);
    const nudged = Object.fromEntries(
      store.rechecksFor(5841).map((r) => [r.fingerprint, r.nudged]),
    );
    expect(nudged).toEqual({ "push:a": 0, "push:b": 0, "push:c": 1, "push:d": 1 });
    expect(store.rechecksFor(5841).every((r) => r.receipt_at === null)).toBe(true);
    const backfills = () =>
      store.db
        .prepare("SELECT payload FROM events WHERE kind = 'recheck_claims_unnudged_backfilled'")
        .all() as Array<{ payload: string }>;
    expect(backfills().map((e) => JSON.parse(e.payload))).toEqual([{ count: 2 }]);
    store.close();

    // Idempotent: a second boot neither re-runs it nor re-marks a row.
    const again = new StateStore(path);
    expect(
      again.db
        .prepare(
          "SELECT COUNT(*) AS n FROM events WHERE kind = 'recheck_claims_unnudged_backfilled'",
        )
        .get(),
    ).toEqual({ n: 1 });
    again.close();
  });
});

describe("rounds is read by PR through an index (boot stall)", () => {
  it("every per-PR rounds read the stall paid for is an index search, not a scan", () => {
    const store = new StateStore(":memory:");
    const plan = (sql: string): string =>
      (store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(1) as Array<{ detail: string }>)
        .map((r) => r.detail)
        .join(" | ");
    // hasRunningRound — paid once per recheck claim per pass.
    expect(plan("SELECT COUNT(*) AS c FROM rounds WHERE pr = ? AND status = 'running'")).toMatch(
      /SEARCH rounds USING INDEX rounds_pr_round/,
    );
    // The status snapshot's latest-verdict subquery — every heartbeat.
    expect(
      plan(
        "SELECT verdict FROM rounds r2 WHERE r2.pr = ? AND verdict IS NOT NULL ORDER BY round_no DESC LIMIT 1",
      ),
    ).toMatch(/SEARCH r2 USING INDEX rounds_pr_round/);
    // The due-command check's round lookup — every supervisor scan.
    expect(
      plan("SELECT 1 FROM rounds r WHERE r.pr = ? AND r.round_no = 1 AND r.status = 'running'"),
    ).toMatch(/SEARCH r USING INDEX rounds_pr_round/);
    store.close();
  });
});

describe("GET /health serves the pipeline block alone (boot stall)", () => {
  it("is exactly the snapshot's pipeline block — absent, healthy and failing alike", () => {
    const store = new StateStore(":memory:");
    const at = new Date("2026-10-07T15:40:00.000Z");
    const healthy: RoundStageSupervisorHealth = {
      healthy: true,
      stale_after_s: 300,
      last_attempt_at: "2026-10-07T15:39:00.000Z",
      last_success_at: "2026-10-07T15:39:00.000Z",
      last_error_at: null,
      last_error: null,
    };
    const stale = { ...healthy, healthy: false, last_error: "lease stale" };
    const snap = (sup?: RoundStageSupervisorHealth) =>
      buildStatusSnapshot(
        store,
        false,
        undefined,
        () => at,
        2,
        undefined,
        undefined,
        undefined,
        sup,
      ).pipeline;
    expect(buildPipelineStatus(store, at)).toBeUndefined();
    expect(buildPipelineStatus(store, at)).toEqual(snap());
    expect(buildPipelineStatus(store, at, healthy)).toEqual(snap(healthy));
    expect(buildPipelineStatus(store, at, stale)).toEqual(snap(stale));
    seed(store, 42, "tracked");
    store.openReviewFailure({
      pr: 42,
      head_sha: "sha42",
      stage: "command_start",
      detail: "no start",
      attempts: 1,
      retry_cap: 3,
    });
    const failing = buildPipelineStatus(store, at, healthy);
    expect(failing).toMatchObject({ healthy: false, failed_loud: 1 });
    expect(failing).toEqual(snap(healthy));
    store.close();
  });
});

describe("the daemon's reconcile (boot stall)", () => {
  const PR = 7001;
  let root: string;
  beforeEach(() => {
    root = join(dir, "root");
    for (const d of ["state", "state/dryrun", "verdict", "inject"])
      mkdirSync(join(root, d), { recursive: true });
  });

  function adapter(over: Partial<Record<string, unknown>> = {}): DaemonAdapter {
    const gate = async (): Promise<GateResult> => ({ executed: false });
    return {
      searchLabelTriggered: async () => [],
      searchTeamTriggered: async () => [],
      listOpenPrs: async () => [ref(PR)],
      getPr: async () => ref(PR),
      stalenessScan: async () => [],
      listBotReviewComments: async () => [],
      getRequestedReviewers: async () => ({ users: [], teams: [] }),
      listPrFiles: async () => [],
      addLabel: gate,
      removeLabel: gate,
      deleteTeamReviewRequest: gate,
      createReview: gate,
      ...over,
    } as unknown as DaemonAdapter;
  }

  it(
    "never runs two passes at once: a second call waits for the first, then runs its own",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const store = new StateStore(":memory:");
      let inFlight = 0;
      let maxInFlight = 0;
      let calls = 0;
      let release!: () => void;
      const gateOpen = new Promise<void>((r) => (release = r));
      const daemon = createDaemon({
        cfg: { ...loadConfig(resolve(process.cwd(), "tests/fixtures/config.toml")), dry_run: true },
        root,
        store,
        adapter: adapter({
          listOpenPrs: async () => {
            calls++;
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            if (calls === 1) await gateOpen;
            inFlight--;
            return [ref(PR)];
          },
        }),
        listen: false,
        log: () => {},
      });
      try {
        const a = daemon.reconcile();
        const b = daemon.reconcile();
        await new Promise((r) => setTimeout(r, 20));
        expect(calls).toBe(1); // the second pass has not started
        release();
        await Promise.all([a, b]);
        expect(calls).toBe(2); // …and still ran, after the first
        expect(maxInFlight).toBe(1);
      } finally {
        await daemon.stop();
        store.close();
      }
    },
  );

  /** Poll until `cond` holds, up to `ms` — real timers, so a test under load
   * waits rather than fails, and a real hang still fails. */
  async function until(cond: () => boolean, ms = 10_000): Promise<boolean> {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) return false;
      await new Promise((r) => setTimeout(r, 10));
    }
    return true;
  }
  const overdueAnomalies = (store: StateStore): number =>
    store.db
      .prepare("SELECT payload FROM events WHERE kind = 'anomaly'")
      .all()
      .filter((r) => String((r as { payload: string }).payload).includes("reconcile_pass_overdue"))
      .length;

  it(
    "a dispatch pump that never settles does not hold the next reconcile pass back",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      // The pump runs after the reconcile guard is released: dispatch's own
      // lock makes every pump wait for one already running, so a guard held
      // across the pass's trailing `await pump()` would let a worktree fetch
      // hung on a dead connection hold every later pass, the backstop and the
      // receipt sweep with it.
      const QUEUED = 7002;
      const store = new StateStore(":memory:");
      store.upsertPr({
        number: QUEUED,
        state: "queued",
        head_sha: `sha${QUEUED}`,
        title: `PR ${QUEUED}`,
        author: "alice",
        trigger_ts: "2026-10-07T09:00:00Z",
        stale_recheck: 0,
        migration_gate: 0,
      });
      let calls = 0;
      let prepared = 0;
      const lines: string[] = [];
      const daemon = createDaemon({
        cfg: { ...loadConfig(resolve(process.cwd(), "tests/fixtures/config.toml")), dry_run: true },
        root,
        store,
        adapter: adapter({
          listOpenPrs: async () => {
            calls++;
            return [ref(PR), ref(QUEUED)];
          },
          getPr: async (n: number) => ref(n),
        }),
        // The fetch that never answers: the pump that reaches it never settles.
        prepareWorktree: () => {
          prepared++;
          return new Promise(() => {});
        },
        listen: false,
        log: (m) => lines.push(m),
      });
      try {
        void daemon.pump();
        expect(await until(() => prepared === 1)).toBe(true);
        void daemon.reconcile(); // its pass completes, then its pump waits forever
        expect(await until(() => lines.some((l) => l.startsWith("reconcile: open=")))).toBe(true);
        void daemon.reconcile();
        // The second pass runs now — not after the hung pump, and not after the
        // overdue bound (three 300 s poll intervals).
        expect(await until(() => calls === 2)).toBe(true);
        expect(overdueAnomalies(store)).toBe(0);
      } finally {
        // Nothing here waits on the hung pump; the store stays open under it.
        await daemon.stop();
      }
    },
  );

  it(
    "a reconcile pass that never settles is abandoned after the overdue bound, and the poll goes on",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const base = loadConfig(resolve(process.cwd(), "tests/fixtures/config.toml"));
      const intervalS = 0.2;
      const store = new StateStore(":memory:");
      const startedAt: number[] = [];
      const lines: string[] = [];
      const daemon = createDaemon({
        cfg: { ...base, dry_run: true, daemon: { ...base.daemon, poll_interval_s: intervalS } },
        root,
        store,
        adapter: adapter({
          listOpenPrs: async () => {
            startedAt.push(performance.now());
            // The first tick's pass hangs forever; every other pass answers.
            if (startedAt.length === 2) await new Promise(() => {});
            return [ref(PR)];
          },
        }),
        listen: false,
        log: (m) => lines.push(m),
      });
      try {
        await daemon.start(); // the boot pass: call 1
        expect(await until(() => startedAt.length >= 3)).toBe(true);
        // Ticks during the hung pass were skipped while it was not overdue:
        // the next pass started no sooner than three intervals after it.
        expect(startedAt[2]! - startedAt[1]!).toBeGreaterThanOrEqual(
          RECONCILE_OVERDUE_INTERVALS * intervalS * 1000 - 100,
        );
        expect(overdueAnomalies(store)).toBe(1);
        expect(lines.some((l) => l.includes("no longer waited for"))).toBe(true);
      } finally {
        await daemon.stop();
        // Every pass but the hung one logs its summary: let one that started
        // before the stop finish. The store is never closed under a pass.
        await until(
          () =>
            lines.filter((l) => l.startsWith("reconcile: open=")).length >= startedAt.length - 1,
          5_000,
        );
      }
    },
  );

  it(
    "a boot whose first pass never settles still installs the periodic timers",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      // start() awaits the boot pass; the poll, the recovery scans and the
      // status heartbeat must not wait behind it.
      const base = loadConfig(resolve(process.cwd(), "tests/fixtures/config.toml"));
      const intervalS = 0.2;
      const store = new StateStore(":memory:");
      let calls = 0;
      const lines: string[] = [];
      const daemon = createDaemon({
        cfg: { ...base, dry_run: true, daemon: { ...base.daemon, poll_interval_s: intervalS } },
        root,
        store,
        adapter: adapter({
          listOpenPrs: async () => {
            calls++;
            // The boot pass hangs forever; every later pass answers.
            if (calls === 1) await new Promise(() => {});
            return [ref(PR)];
          },
        }),
        listen: false,
        log: (m) => lines.push(m),
      });
      let started = false;
      void daemon.start().then(() => (started = true));
      try {
        expect(await until(() => calls >= 2)).toBe(true);
        expect(started).toBe(false); // the boot pass is still pending
        expect(overdueAnomalies(store)).toBe(1);
      } finally {
        await daemon.stop();
        await until(
          () => lines.filter((l) => l.startsWith("reconcile: open=")).length >= calls - 1,
          5_000,
        );
      }
    },
  );

  it(
    "the boot's first pass lifts the drain without the receipt sweep; the next pass runs it",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const store = new StateStore(":memory:");
      seed(store, PR, "tracked");
      store.engageDrain({ issuer: "operator", expires_at: null });
      store.claimRecheck(PR, "push:lost", { head_sha: `sha${PR}`, trigger: "push", reason: "x" });
      store.db
        .prepare("UPDATE rechecks SET created_at = ? WHERE pr = ?")
        .run(new Date(Date.now() - 2 * 60 * 60_000).toISOString(), PR);
      const asked: string[] = [];
      const daemon = createDaemon({
        cfg: { ...loadConfig(resolve(process.cwd(), "tests/fixtures/config.toml")), dry_run: true },
        root,
        store,
        adapter: adapter(),
        hooks: {
          async dispatchRound() {},
          async inject() {},
          async injectOverseer() {},
          async archiveAndClose() {},
          async injectPending() {
            return false;
          },
          async wakeReceiptPresent(_pr, marker) {
            asked.push(marker);
            return false; // provably never delivered
          },
        },
        listen: false,
        log: () => {},
      });
      await daemon.start();
      try {
        expect(store.drainState().draining).toBe(false); // lifted by the boot pass
        expect(asked).toEqual([]); // …which never read a transcript
        expect(store.hasRecheck(PR, "push:lost")).toBe(true);
        await daemon.reconcile();
        expect(asked).toEqual([recheckPromptMarker(PR, "push:lost")]);
        expect(store.hasRecheck(PR, "push:lost")).toBe(false);
      } finally {
        await daemon.stop();
        store.close();
      }
    },
  );
});
