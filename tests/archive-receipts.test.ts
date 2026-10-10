// Archived is never absent (docs/archiving.md §8.1; a delivered prompt is a
// receipt, and an unreadable receipt is unknown, never loss). A PR is
// archived, then reopened, and its reborn session writes a fresh JSONL that
// does not hold a pre-close wake's marker. The receipt for that
// wake must read UNKNOWN — never false — so reconcile's claim sweep keeps the
// claim; after the restore the marker is found in the restored file; and a
// wake sent after the reopen is answered from the live files as before.
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import type { PrRef } from "../src/github.js";
import { PLAN_REFRESH_MS } from "../src/archive/archiver.js";
import { archiveRow, armArchiveRow } from "../src/archive/rows.js";
import { RECEIPT_SCOPE_SLACK_MS } from "../src/receiptscan.js";
import { reconcileOnce, type ReconcileAdapter } from "../src/reconcile.js";
import { recheckPromptMarker, type SessionHooks } from "../src/types.js";
import {
  DAY,
  T0,
  line,
  onArchiver,
  prFixture,
  put,
  reopen,
  sessionRig,
  type PrFixture,
} from "./helpers/archive-pr.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const cfg = parseConfig(readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8"));

const open: PrFixture[] = [];
afterEach(() => {
  for (const f of open.splice(0)) f.close();
});

/** GitHub says the PR is open again; nothing else. */
function github(pr: number): ReconcileAdapter {
  const ref: PrRef = {
    number: pr,
    title: `pr ${pr}`,
    author: "a",
    head_sha: "abc",
    base_ref: "master",
    updated_at: new Date(T0).toISOString(),
    state: "open",
    draft: false,
    merged: false,
    labels: [],
  };
  return {
    searchLabelTriggered: async () => [],
    searchTeamTriggered: async () => [],
    listOpenPrs: async () => [ref],
    getPr: async () => ref,
    stalenessScan: async () => [],
    listChecks: async () => [],
    listBotReviewComments: async () => [],
    getRequestedReviewers: async () => ({ users: [], teams: [] }),
  } as unknown as ReconcileAdapter;
}

const FP = "fp-push-deadbeef";

/** The fixture, a pre-close recheck claim whose nudge DID land (its marker
 * is in the first transcript), archived by a real archiver. */
async function archivedWithClaim(): Promise<{ f: PrFixture; marker: string; claimMs: number }> {
  const f = prFixture();
  open.push(f);
  const marker = recheckPromptMarker(f.pr, FP);
  const t0 = f.transcripts[0]!;
  const p = join(f.root, t0);
  const mtime = f.mtimes.get(t0)!;
  // The claim was made an hour before that transcript's last write; the
  // nudge's marker is in it.
  const claimMs = mtime - 3_600_000;
  f.clock.ms = claimMs;
  f.store.claimRecheck(f.pr, FP, { head_sha: "h1", trigger: "push", reason: "delta" });
  f.clock.ms = T0;
  writeFileSync(p, Buffer.concat([f.bytes.get(t0)!, Buffer.from(line(`nudge ${marker}`))]));
  utimesSync(p, mtime / 1000, mtime / 1000);
  f.bytes.set(t0, readFileSync(p));
  const a = onArchiver(f);
  await a.tick();
  a.stop();
  expect(archiveRow(f.store, f.pr)?.state).toBe("archived");
  return { f, marker, claimMs };
}

const released = (f: PrFixture): number =>
  (
    f.store.db
      .prepare(
        "SELECT COUNT(*) AS n FROM events WHERE kind = 'reconcile_correction' AND payload LIKE '%recheck-claim-released-undelivered%'",
      )
      .get() as { n: number }
  ).n;

describe("the receipt guard (acceptance 5)", () => {
  it(
    "archived → reopened → a fresh JSONL without the marker: the pre-close claim reads UNKNOWN, survives reconcile, and reads TRUE after the restore",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const { f, marker, claimMs } = await archivedWithClaim();
      const rig = sessionRig(f);
      reopen(f);
      // The reborn session's own JSONL — written after the reopen, no marker.
      put(f.root, `state/pi-sessions/pr-${f.pr}/2026-10-21T12-00-00_new.jsonl`, line("hello"), T0);

      expect(await rig.m.wakeReceiptPresent(f.pr, marker, claimMs)).toBeNull();
      const unknownRows = (): Array<{ payload: string }> =>
        f.store.db
          .prepare("SELECT payload FROM events WHERE kind = 'receipt_archived_unknown' AND pr = ?")
          .all(f.pr) as Array<{ payload: string }>;
      const ev = unknownRows();
      expect(ev).toHaveLength(1);
      expect(JSON.parse(ev[0]!.payload)).toMatchObject({ marker, archive_state: "archived" });
      // Asked again (reconcile asks every pass): still UNKNOWN, logged once —
      // never a row per sweep for as long as the PR stays unrestored.
      expect(await rig.m.wakeReceiptPresent(f.pr, marker, claimMs)).toBeNull();
      expect(await rig.m.wakeReceiptPresent(f.pr, marker, claimMs)).toBeNull();
      expect(unknownRows()).toHaveLength(1);

      // A reconcile pass asks about the claim and keeps it.
      const hooks: SessionHooks = {
        async dispatchRound() {},
        async inject() {},
        async injectOverseer() {},
        async archiveAndClose() {},
        injectPending: async () => false,
        wakeReceiptPresent: (pr, m, since) => rig.m.wakeReceiptPresent(pr, m, since),
      };
      await reconcileOnce({
        cfg,
        store: f.store,
        adapter: github(f.pr),
        hooks,
        now: () => new Date(T0),
      });
      expect(f.store.hasRecheck(f.pr, FP)).toBe(true);
      expect(released(f)).toBe(0);

      // The restore (a birth would await it): the marker is back where it was.
      const a = onArchiver(f);
      await a.beforeBirth(f.pr);
      a.stop();
      expect(archiveRow(f.store, f.pr)?.state).toBe("restored");
      expect(await rig.m.wakeReceiptPresent(f.pr, marker, claimMs)).toBe(true);
      // …and a second reconcile pass records the delivery.
      await reconcileOnce({
        cfg,
        store: f.store,
        adapter: github(f.pr),
        hooks,
        now: () => new Date(T0),
      });
      expect(f.store.hasRecheck(f.pr, FP)).toBe(true);
      expect(released(f)).toBe(0);
    },
  );

  it(
    "a wake created AFTER the reopen is answered from the live files — false when absent, true when present — restore or not",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const { f } = await archivedWithClaim();
      const rig = sessionRig(f);
      reopen(f);
      const later = recheckPromptMarker(f.pr, "fp-after-reopen");
      const seen = recheckPromptMarker(f.pr, "fp-seen-after-reopen");
      put(
        f.root,
        `state/pi-sessions/pr-${f.pr}/2026-10-21T12-00-00_new.jsonl`,
        line(`accepted ${seen}`),
        T0 + 60_000,
      );
      expect(await rig.m.wakeReceiptPresent(f.pr, later, T0)).toBe(false);
      expect(await rig.m.wakeReceiptPresent(f.pr, seen, T0)).toBe(true);
      const a = onArchiver(f);
      await a.beforeBirth(f.pr);
      a.stop();
      expect(await rig.m.wakeReceiptPresent(f.pr, later, T0)).toBe(false);
    },
  );

  it("the guard arms when the row is committed — before the first byte leaves — and only over the archived window", async () => {
    const f = prFixture();
    open.push(f);
    const rig = sessionRig(f);
    const marker = recheckPromptMarker(f.pr, FP);
    // No archive row: a live false is a false (the transcripts are all there).
    expect(
      await rig.m.wakeReceiptPresent(f.pr, marker, f.mtimes.get(f.transcripts[0]!)! - DAY),
    ).toBe(false);
    // An `archiving` row (the guard armed, nothing moved yet): unknown.
    f.store.db
      .prepare(
        "INSERT INTO archive_prs (pr, state, max_mtime_ms, updated_at) VALUES (?, 'archiving', ?, ?)",
      )
      .run(f.pr, f.mtimes.get(f.transcripts[2]!)!, new Date(T0).toISOString());
    expect(
      await rig.m.wakeReceiptPresent(f.pr, marker, f.mtimes.get(f.transcripts[0]!)! - DAY),
    ).toBeNull();
    // A wake past every archived mtime (beyond the slack) is not in scope.
    const past = f.mtimes.get(f.transcripts[2]!)! + 61_000;
    put(f.root, `state/pi-sessions/pr-${f.pr}/late.jsonl`, line("x"), past + 1000);
    expect(await rig.m.wakeReceiptPresent(f.pr, marker, past)).toBe(false);
    // A live TRUE is true whatever the row says.
    const there = "<!-- qcr-transcript-0 -->";
    expect(
      await rig.m.wakeReceiptPresent(f.pr, there, f.mtimes.get(f.transcripts[0]!)! - DAY),
    ).toBe(true);
    // A restored row: the live files answer again.
    f.store.db.prepare("UPDATE archive_prs SET state = 'restored' WHERE pr = ?").run(f.pr);
    expect(
      await rig.m.wakeReceiptPresent(f.pr, marker, f.mtimes.get(f.transcripts[0]!)! - DAY),
    ).toBe(false);
  });

  it("the scope's edges: the slack counts, the boundary is inclusive, and an unreadable row is UNKNOWN", async () => {
    const f = prFixture();
    open.push(f);
    const rig = sessionRig(f);
    const marker = recheckPromptMarker(f.pr, FP);
    const max = f.mtimes.get(f.transcripts[2]!)!;
    f.store.db
      .prepare(
        "INSERT INTO archive_prs (pr, state, max_mtime_ms, updated_at) VALUES (?, 'archived', ?, ?)",
      )
      .run(f.pr, max, new Date(T0).toISOString());
    // The newest transcript is in every one of these scopes and lacks the
    // marker: the live scan says false each time.
    expect(RECEIPT_SCOPE_SLACK_MS).toBe(60_000);
    // Exactly at the edge (since − slack = max): in scope, UNKNOWN.
    expect(await rig.m.wakeReceiptPresent(f.pr, marker, max + 60_000)).toBeNull();
    // Inside the slack (since past max, but by less than the slack): UNKNOWN.
    expect(await rig.m.wakeReceiptPresent(f.pr, marker, max + 30_000)).toBeNull();
    // A read of the archive row that fails is UNKNOWN too — never a guess.
    const store = f.store as unknown as { archiveScope: (pr: number) => unknown };
    store.archiveScope = () => {
      throw new Error("SQLITE_IOERR");
    };
    expect(await rig.m.wakeReceiptPresent(f.pr, marker, max - DAY)).toBeNull();
    const last = (
      f.store.db
        .prepare(
          "SELECT payload FROM events WHERE kind = 'receipt_archived_unknown' AND pr = ? ORDER BY id DESC LIMIT 1",
        )
        .get(f.pr) as { payload: string }
    ).payload;
    expect(JSON.parse(last)).toMatchObject({
      marker,
      archive_state: "unreadable",
      max_mtime_ms: null,
    });
  });
});

describe("the guard's floor, max_mtime_ms, is never lowered", () => {
  it("armArchiveRow raises it and never lowers it (a null leaves it as it was)", () => {
    const f = prFixture();
    open.push(f);
    const at = new Date(T0).toISOString();
    armArchiveRow(f.store, f.pr, { at, maxMtimeMs: 2000 });
    expect(archiveRow(f.store, f.pr)?.max_mtime_ms).toBe(2000);
    armArchiveRow(f.store, f.pr, { at, maxMtimeMs: 1000 });
    expect(archiveRow(f.store, f.pr)?.max_mtime_ms).toBe(2000);
    armArchiveRow(f.store, f.pr, { at, maxMtimeMs: null });
    expect(archiveRow(f.store, f.pr)?.max_mtime_ms).toBe(2000);
    armArchiveRow(f.store, f.pr, { at, maxMtimeMs: 3000 });
    expect(archiveRow(f.store, f.pr)?.max_mtime_ms).toBe(3000);
    expect(archiveRow(f.store, f.pr)?.passes).toBe(4);
  });

  it(
    "a pass that archives only an OLDER transcript (the newest went first) keeps the newest's mtime in scope",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = prFixture();
      open.push(f);
      const [t0, t1, t2] = f.transcripts as [string, string, string];
      // Pass 1: a byte flipped in the OLDEST transcript's .partial — it is
      // kept, the two newer ones leave.
      let flip = true;
      const a = onArchiver(
        f,
        {},
        {
          step: (name, info) => {
            if (!flip || name !== "partial_written" || info.src !== join(f.root, t0)) return;
            const p = info.partial as string;
            const buf = readFileSync(p);
            buf[Math.floor(buf.length / 2)] = buf[Math.floor(buf.length / 2)]! ^ 0xff;
            writeFileSync(p, buf);
          },
        },
      );
      try {
        await a.tick();
        expect(existsSync(join(f.root, t0))).toBe(true);
        expect(existsSync(join(f.root, t2))).toBe(false);
        // Pass 2 sees only the oldest transcript — and arms with ITS mtime.
        flip = false;
        f.clock.ms += PLAN_REFRESH_MS;
        await a.tick();
      } finally {
        a.stop();
      }
      expect(archiveRow(f.store, f.pr)).toMatchObject({
        state: "archived",
        max_mtime_ms: f.mtimes.get(t2)!,
      });
      // Reopened, a fresh JSONL: a pre-close wake whose marker sits in the
      // NEWEST archived transcript, asked from between the two mtimes.
      const rig = sessionRig(f);
      reopen(f);
      put(f.root, `state/pi-sessions/pr-${f.pr}/2026-10-21T12-00-00_new.jsonl`, line("hello"), T0);
      const marker = "<!-- qcr-transcript-2 -->";
      const since = f.mtimes.get(t1)!;
      expect(since - RECEIPT_SCOPE_SLACK_MS).toBeGreaterThan(f.mtimes.get(t0)!);
      expect(await rig.m.wakeReceiptPresent(f.pr, marker, since)).toBeNull();
      // Restored, the marker is found where it was.
      const b = onArchiver(f);
      await b.beforeBirth(f.pr);
      b.stop();
      expect(await rig.m.wakeReceiptPresent(f.pr, marker, since)).toBe(true);
    },
  );
});
