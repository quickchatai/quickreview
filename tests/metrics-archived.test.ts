// `qcr metrics` across a move (docs/archiving.md §9.4): the
// `all` window adds the `archived_event_counts` rollup back, so its totals
// are identical before and after the reader-less rows leave the live table,
// and labels them "(incl. N archived)"; d7 and d30 never see an archived row
// (events_after_days ≥ 31) and are unchanged to the last field.
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ARCHIVE_EVENT_KINDS } from "../src/archive/kinds.js";
import { computeMetrics, renderMetrics, type MetricsPayload } from "../src/metrics.js";
import { StateStore } from "../src/state.js";
import { opsLines } from "../src/tui/metricstab.js";
import { DAY, T0, iso, rig, seedEvents, type Rig } from "./helpers/archive-rows.js";

const rigs: Rig[] = [];
afterEach(() => {
  for (const r of rigs.splice(0)) r.close();
});

const now = (): Date => new Date(T0);
const strip = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");

describe("metrics across a move", () => {
  it("the `all` totals are identical before and after; d7 and d30 are unchanged; the archived rows are labelled", async () => {
    const r = await rig();
    rigs.push(r);
    const rows: Array<[string, string, number | null, unknown]> = [];
    // Old (archivable and fact kinds), a month old, last week, today.
    for (const [age, n] of [
      [60, 4],
      [40, 3],
      [20, 2],
      [3, 2],
      [0.1, 1],
    ] as const) {
      for (let i = 0; i < n; i++)
        for (const kind of [...ARCHIVE_EVENT_KINDS, "verdict_applied", "pr_closed", "anomaly"])
          rows.push([iso(T0 - age * DAY + i * 1000), kind, 1, { i }]);
    }
    seedEvents(r.store, rows);
    const before: MetricsPayload = computeMetrics(r.store, { now });
    expect(before.windows.all.events_archived).toBe(0);

    const res = await r.mover().run();
    expect(res.outcome).toBe("caught_up");
    const moved = res.events.moved;
    expect(moved).toBe((4 + 3) * ARCHIVE_EVENT_KINDS.size);
    // The rows really left: the live table no longer holds them.
    expect((r.store.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n).toBe(
      rows.length - moved,
    );

    const after = computeMetrics(r.store, { now });
    // `all`: the same tally, kind by kind, with the archived share named.
    expect(after.windows.all.events_by_kind).toEqual(before.windows.all.events_by_kind);
    expect(after.windows.all.events_archived).toBe(moved);
    // d7 and d30: unchanged to the last field.
    expect(after.windows.d7).toEqual(before.windows.d7);
    expect(after.windows.d30).toEqual(before.windows.d30);
    expect(after.windows.d7.events_archived).toBeUndefined();
    expect(after.windows.d30.events_archived).toBeUndefined();

    // The CLI's text and the TUI's EVENTS card both say what is archived.
    expect(renderMetrics(after)).toContain(`(incl. ${moved} archived)`);
    expect(renderMetrics(before)).not.toContain("archived");
    const card = (p: MetricsPayload, w: "d7" | "all"): string =>
      opsLines(p.ops, undefined, p.windows[w], 80, now()).map(strip).join("\n");
    expect(card(after, "all")).toContain(`(incl. ${moved} archived row(s)`);
    expect(card(after, "d7")).not.toContain("archived");
  });
});

describe("metrics read the live tally and the rollup in one snapshot", () => {
  it("a move committed (by another process) between the two reads is counted once, never twice", () => {
    const dir = mkdtempSync(join(tmpdir(), "qcr-metrics-snap-"));
    const path = join(dir, "state.db");
    const store = new StateStore(path, () => new Date(T0));
    const daemon = new Database(path, { timeout: 2000 });
    try {
      const rows: Array<[string, string, number | null, unknown]> = [];
      for (let i = 0; i < 5; i++) rows.push([iso(T0 - 60 * DAY + i), "webhook_event", null, null]);
      rows.push([iso(T0 - DAY), "verdict_applied", 1, null]);
      seedEvents(store, rows);
      const before = computeMetrics(store, { now });
      // The archiver's live transaction, as another connection commits it:
      // the rows leave and enter the rollup in one commit.
      const move = (): void => {
        daemon
          .transaction(() => {
            daemon.prepare("DELETE FROM events WHERE kind = 'webhook_event'").run();
            daemon
              .prepare(
                "INSERT INTO archived_event_counts (kind, day, n) VALUES ('webhook_event', ?, 5)",
              )
              .run(iso(T0 - 60 * DAY).slice(0, 10));
          })
          .immediate();
      };
      // It lands right after the live tally is read, before the rollup is.
      const prepare = store.db.prepare.bind(store.db);
      let fired = false;
      store.db.prepare = ((sql: string) => {
        const st = prepare(sql);
        if (!fired && sql === "SELECT ts, kind FROM events ORDER BY id") {
          const all = st.all.bind(st);
          st.all = ((...args: unknown[]) => {
            const out = all(...(args as []));
            fired = true;
            move();
            return out;
          }) as typeof st.all;
        }
        return st;
      }) as typeof store.db.prepare;
      const during = computeMetrics(store, { now });
      expect(fired).toBe(true);
      expect(during.windows.all.events_by_kind).toEqual(before.windows.all.events_by_kind);
      // And once it has settled, the rollup carries what left.
      store.db.prepare = prepare as typeof store.db.prepare;
      const after = computeMetrics(store, { now });
      expect(after.windows.all.events_by_kind).toEqual(before.windows.all.events_by_kind);
      expect(after.windows.all.events_archived).toBe(5);
    } finally {
      daemon.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
