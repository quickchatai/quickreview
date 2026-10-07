// the schema (docs/archiving.md §8.1, §9.2, §9.4, §9.7): the
// archive tables and `bot_comments_pr` exist after construction (on a fresh
// database and on one that predates them), `rounds_pr_round` — added by the
// boot-stall fix — is declared exactly once, and the heartbeat's
// round-stats query is an index walk, structurally (the query plan, not a
// clock).
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROUND_STATS_SQL, StateStore } from "../src/state.js";

const SRC = join(import.meta.dirname, "..", "src");

function srcFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? srcFiles(p) : p.endsWith(".ts") ? [p] : [];
  });
}

const plan = (store: StateStore, sql: string, ...args: unknown[]): string =>
  (store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>)
    .map((r) => r.detail)
    .join(" | ");

const objects = (store: StateStore, type: "table" | "index"): string[] =>
  (
    store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = ? ORDER BY name")
      .all(type) as Array<{
      name: string;
    }>
  ).map((r) => r.name);

describe("the archive tables and indexes exist after construction", () => {
  it("archive_prs, archive_marks, archived_event_counts and bot_comments_pr", () => {
    const store = new StateStore(":memory:");
    try {
      expect(objects(store, "table")).toEqual(
        expect.arrayContaining(["archive_prs", "archive_marks", "archived_event_counts"]),
      );
      expect(objects(store, "index")).toEqual(
        expect.arrayContaining(["bot_comments_pr", "rounds_pr_round"]),
      );
      const cols = (t: string): string[] =>
        (store.db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map(
          (c) => c.name,
        );
      expect(cols("archive_prs")).toEqual([
        "pr",
        "state",
        "passes",
        "started_at",
        "archived_at",
        "restored_at",
        "transcript_files",
        "state_files",
        "bytes_in",
        "bytes_out",
        "max_mtime_ms",
        "last_error",
        "updated_at",
      ]);
      expect(cols("archive_marks")).toEqual(["name", "value"]);
      expect(cols("archived_event_counts")).toEqual(["kind", "day", "n"]);
    } finally {
      store.close();
    }
  });

  it("archive_prs takes only the five states §8.1 names", () => {
    const store = new StateStore(":memory:");
    try {
      const ins = store.db.prepare(
        "INSERT INTO archive_prs (pr, state, updated_at) VALUES (?, ?, '2026-10-21T00:00:00.000Z')",
      );
      ["archiving", "archived", "restoring", "restored", "restore_failed"].forEach((s, i) =>
        ins.run(i + 1, s),
      );
      expect(() => ins.run(99, "deleted")).toThrow(/CHECK constraint failed/);
      // A watermark stays an integer (no type affinity forces it to text).
      store.db
        .prepare("INSERT INTO archive_marks (name, value) VALUES ('events.last_id', 42)")
        .run();
      expect(store.db.prepare("SELECT typeof(value) AS t FROM archive_marks").get()).toEqual({
        t: "integer",
      });
    } finally {
      store.close();
    }
  });

  it("a database that predates them gains them at the next construction — and keeps its rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "qcr-archive-schema-"));
    try {
      const path = join(dir, "state.db");
      const old = new StateStore(path);
      old.db
        .prepare("INSERT INTO bot_comments (comment_id, pr, posted_at) VALUES (1, 7, 'x')")
        .run();
      old.db.exec(
        "DROP TABLE archive_prs; DROP TABLE archive_marks; DROP TABLE archived_event_counts; DROP INDEX bot_comments_pr;",
      );
      old.close();
      const store = new StateStore(path);
      try {
        expect(objects(store, "table")).toEqual(
          expect.arrayContaining(["archive_prs", "archive_marks", "archived_event_counts"]),
        );
        expect(objects(store, "index")).toContain("bot_comments_pr");
        expect(store.db.prepare("SELECT COUNT(*) AS n FROM bot_comments").get()).toEqual({ n: 1 });
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("rounds_pr_round is declared once (it came with the boot-stall fix)", () => {
  it("one CREATE INDEX for it in src/, and one index on rounds(pr, round_no)", () => {
    const decls = srcFiles(SRC).flatMap((f) =>
      [...readFileSync(f, "utf8").matchAll(/CREATE INDEX IF NOT EXISTS rounds_pr_round\b/g)].map(
        () => f,
      ),
    );
    expect(decls).toEqual([join(SRC, "state.ts")]);
    const store = new StateStore(":memory:");
    try {
      const onPrRound = (
        store.db.prepare("PRAGMA index_list(rounds)").all() as Array<{ name: string }>
      ).filter((ix) => {
        const cols = (
          store.db.prepare(`PRAGMA index_info(${ix.name})`).all() as Array<{ name: string }>
        ).map((c) => c.name);
        return cols.join(",") === "pr,round_no";
      });
      expect(onPrRound.map((i) => i.name)).toEqual(["rounds_pr_round"]);
      // And bot_comments_pr is declared once too.
      const botDecls = srcFiles(SRC).flatMap((f) =>
        [...readFileSync(f, "utf8").matchAll(/CREATE INDEX IF NOT EXISTS bot_comments_pr\b/g)].map(
          () => f,
        ),
      );
      expect(botDecls).toEqual([join(SRC, "state.ts")]);
    } finally {
      store.close();
    }
  });
});

describe("the heartbeat's round stats and the bot-comment count are index walks (§9.7)", () => {
  it("ROUND_STATS_SQL — the outer GROUP BY and the latest-verdict subquery both use rounds_pr_round", () => {
    const store = new StateStore(":memory:");
    try {
      const detail = plan(store, ROUND_STATS_SQL);
      expect(detail).toMatch(/SCAN rounds USING INDEX rounds_pr_round/);
      expect(detail).toMatch(/SEARCH r2 USING INDEX rounds_pr_round \(pr=\?\)/);
      // Never a bare full scan of rounds, never a temp B-tree for the GROUP BY.
      expect(detail).not.toMatch(/SCAN rounds(?! USING)/);
      expect(detail).not.toMatch(/TEMP B-TREE/);
    } finally {
      store.close();
    }
  });

  it("ROUND_STATS_SQL is the query the heartbeat runs (no inline copy drifted from it)", () => {
    const text = readFileSync(join(SRC, "state.ts"), "utf8");
    const fn = text.slice(text.indexOf("export function buildStatusSnapshot("));
    expect(fn.slice(0, fn.indexOf("\n}\n"))).toContain("prepare(ROUND_STATS_SQL)");
    expect(text.split("(SELECT verdict FROM rounds r2 WHERE r2.pr = rounds.pr").length - 1).toBe(1);
  });

  it("the per-PR bot-comment count searches bot_comments_pr", () => {
    const store = new StateStore(":memory:");
    try {
      expect(plan(store, "SELECT COUNT(*) AS c FROM bot_comments WHERE pr = ?", 1)).toMatch(
        /SEARCH bot_comments USING COVERING INDEX bot_comments_pr \(pr=\?\)/,
      );
    } finally {
      store.close();
    }
  });
});
