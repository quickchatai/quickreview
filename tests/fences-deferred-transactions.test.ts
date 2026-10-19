// Fence: a StateStore transaction that reads then writes takes the write lock
// up front.
//
// `db.transaction(fn)()` is a DEFERRED transaction. Under WAL it takes a read
// snapshot on its first read, and when a later write has to upgrade that
// snapshot while another connection holds the write lock, SQLite returns
// SQLITE_BUSY at once — busy_timeout is never consulted for an upgrade. The
// live bot hit exactly that (a second writer on state.db made a webhook
// accept throw), and `.immediate()` is the fix: BEGIN IMMEDIATE waits inside
// busy_timeout like an autocommit statement does.
// tests/state-cross-writer-busy.test.ts proves the behaviour; this file stops
// a new site from reintroducing it.
//
// The rule: in `src/`, a `.transaction(` that is invoked deferred (not
// `.immediate()` / `.exclusive()`) must not have a callback that both reads
// (Statement `get`/`all`/`iterate`/`pluck`, or a helper that does) and writes
// (Statement `run`, Database `exec`, or a helper that does). The scan is in
// tests/helpers/deferred-transactions.ts.
//
// The sites that predate the rule are in tests/deferred-transactions.allowlist.json,
// one entry per function with a one-line note: a ratchet. A new unlisted site
// fails; an entry whose site is gone (converted to `.immediate()`, or deleted)
// also fails until the entry is removed, so the list only shrinks.
//
// MUTATION: delete `.immediate()` from `acceptWebhookDelivery` in src/state.ts
// (the first fence below names it), or add a deferred read-then-write
// transaction anywhere in `src/` — either fails, naming the file and function.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";
import {
  isFlagged,
  programOfRepo,
  programOfSource,
  scanTransactions,
  type TxSite,
} from "./helpers/deferred-transactions.js";
import { HEAVY_TIMEOUT_MS, TYPECHECK_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const ROOT = join(import.meta.dirname, "..");

interface AllowEntry {
  file: string;
  fn: string;
  /** Sites in that function; absent means one. */
  count?: number;
  note: string;
}

const ALLOWLIST: readonly AllowEntry[] = JSON.parse(
  readFileSync(join(ROOT, "tests/deferred-transactions.allowlist.json"), "utf8"),
);

const keyOf = (s: { file: string; fn: string }): string => `${s.file}::${s.fn}`;

function countByKey(sites: readonly TxSite[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of sites) m.set(keyOf(s), (m.get(keyOf(s)) ?? 0) + 1);
  return m;
}

/** The scan, for a planted source text. */
function scanSource(text: string): TxSite[] {
  const rel = "src/planted.ts";
  const program: ts.Program = programOfSource(ROOT, rel, text);
  return scanTransactions(program, ROOT, (p) => p === rel);
}

const PRELUDE = `
import Database from "better-sqlite3";
const db = new Database(":memory:");
`;

describe("deferred read-then-write transactions are ratcheted", () => {
  let sites: TxSite[];
  beforeAll(() => {
    sites = scanTransactions(programOfRepo(ROOT), ROOT);
  }, TYPECHECK_TIMEOUT_MS);

  it("the scan sees src/'s transactions, and sees the immediate ones as immediate", () => {
    expect(
      sites.length,
      "far fewer transactions than src/ holds — the scan broke and asserts nothing",
    ).toBeGreaterThan(60);
    expect(sites.filter((s) => s.mode === "immediate").length).toBeGreaterThanOrEqual(8);
    expect(
      sites.filter(isFlagged).length,
      "the allowlist would be empty or the scan is blind",
    ).toBeGreaterThan(20);
  });

  it("the five sites that hit SQLITE_BUSY live stay immediate", () => {
    for (const fn of [
      "StateStore.acceptWebhookDelivery",
      "StateStore.webhookLocalOnce",
      "StateStore.observeTriggerLevel",
      "StateStore.recordRoundFanoutStarted",
      "PingPongLedger.recordReply",
    ]) {
      const here = sites.filter((s) => s.fn === fn);
      expect(here.length, `${fn}: no transaction found`).toBeGreaterThan(0);
      expect(
        here.map((s) => s.mode),
        fn,
      ).toEqual(here.map(() => "immediate"));
    }
  });

  it("no deferred transaction in src/ reads and then writes unless it is on the record", () => {
    const allowed = new Map(ALLOWLIST.map((e) => [keyOf(e), e.count ?? 1]));
    const actual = countByKey(sites.filter(isFlagged));
    const lines = (s: TxSite): string => `${s.file}:${s.line} ${s.fn}`;

    const fresh = sites
      .filter(isFlagged)
      .filter((s) => (actual.get(keyOf(s)) ?? 0) > (allowed.get(keyOf(s)) ?? 0))
      .map(lines);
    expect(
      fresh,
      "a deferred transaction that reads and then writes cannot wait in busy_timeout: when another " +
        "connection holds the write lock, the read-to-write upgrade throws SQLITE_BUSY at once. " +
        "Run it `.immediate()`. Do not add it to the allowlist.",
    ).toEqual([]);

    const stale = [...allowed]
      .filter(([k, n]) => (actual.get(k) ?? 0) < n)
      .map(([k, n]) => `${k} (allowlisted ${n}, found ${actual.get(k) ?? 0})`);
    expect(
      stale,
      "these allowlist entries no longer match a deferred read-then-write site — the site is fixed " +
        "or gone, so lower `count` or delete the entry in tests/deferred-transactions.allowlist.json",
    ).toEqual([]);
  });

  it("every allowlist entry names a function once and carries a one-line note", () => {
    expect(ALLOWLIST.length).toBeGreaterThan(0);
    expect(new Set(ALLOWLIST.map(keyOf)).size, "an entry is listed twice").toBe(ALLOWLIST.length);
    for (const e of ALLOWLIST) {
      expect(e.file.startsWith("src/"), keyOf(e)).toBe(true);
      expect(e.note.length, `${keyOf(e)} needs a note`).toBeGreaterThan(15);
      expect(e.note, `${keyOf(e)}: the note is one line`).not.toMatch(/\n/);
      if (e.count !== undefined) expect(e.count, keyOf(e)).toBeGreaterThan(1);
    }
    const sorted = [...ALLOWLIST].sort(
      (a, b) => a.file.localeCompare(b.file) || a.fn.localeCompare(b.fn),
    );
    expect(ALLOWLIST, "keep the list sorted by file, then function").toEqual(sorted);
  });
});

describe("the rule, on planted transactions", () => {
  it("catches a deferred transaction that reads then writes", { timeout: HEAVY_TIMEOUT_MS }, () => {
    const [site, ...rest] = scanSource(`${PRELUDE}
export function bump(id: number): void {
  db.transaction(() => {
    const row = db.prepare("SELECT n FROM t WHERE id = ?").get(id) as { n: number } | undefined;
    db.prepare("UPDATE t SET n = ? WHERE id = ?").run((row?.n ?? 0) + 1, id);
  })();
}`);
    expect(rest).toEqual([]);
    expect(site).toMatchObject({ fn: "bump", mode: "deferred" });
    expect(isFlagged(site!)).toBe(true);
  });

  it(
    "catches it through a helper, and through a transaction held in a variable",
    { timeout: HEAVY_TIMEOUT_MS },
    () => {
      const sites = scanSource(`${PRELUDE}
class Store {
  private current(id: number) { return db.prepare("SELECT n FROM t WHERE id = ?").get(id); }
  private put(id: number, n: number) { db.prepare("UPDATE t SET n = ? WHERE id = ?").run(n, id); }
  viaHelpers(id: number): void {
    db.transaction(() => { this.put(id, this.current(id) ? 1 : 0); })();
  }
  viaVariable(id: number): void {
    const tx = db.transaction(() => {
      db.prepare("SELECT 1").all();
      db.exec("DELETE FROM t");
    });
    tx();
  }
}`);
      expect(sites.map((s) => [s.fn, s.mode, isFlagged(s)])).toEqual([
        ["Store.viaHelpers", "deferred", true],
        ["Store.viaVariable", "deferred", true],
      ]);
    },
  );

  it(
    "passes the same body when it runs .immediate() or .exclusive()",
    { timeout: HEAVY_TIMEOUT_MS },
    () => {
      const sites = scanSource(`${PRELUDE}
function body(id: number): void {
  const row = db.prepare("SELECT n FROM t WHERE id = ?").get(id) as { n: number } | undefined;
  db.prepare("UPDATE t SET n = ? WHERE id = ?").run((row?.n ?? 0) + 1, id);
}
export function direct(id: number): void { db.transaction(() => body(id)).immediate(); }
export function exclusive(id: number): void { db.transaction(() => body(id)).exclusive(); }
export function held(id: number): void {
  const tx = db.transaction(() => body(id));
  tx.immediate();
}`);
      expect(sites.map((s) => [s.fn, s.mode, isFlagged(s)])).toEqual([
        ["direct", "immediate", false],
        ["exclusive", "exclusive", false],
        ["held", "immediate", false],
      ]);
      expect(sites.every((s) => s.reads.length > 0 && s.writes.length > 0)).toBe(true);
    },
  );

  it(
    "passes a deferred transaction that only reads, only writes, or only reads a Map",
    { timeout: HEAVY_TIMEOUT_MS },
    () => {
      const sites = scanSource(`${PRELUDE}
const cache = new Map<number, number>();
export function readOnly(): unknown { return db.transaction(() => db.prepare("SELECT 1").all())(); }
export function writeOnly(): void { db.transaction(() => { db.prepare("INSERT INTO t VALUES (1)").run(); })(); }
export function mapGet(id: number): void {
  db.transaction(() => {
    cache.get(id);
    db.prepare("INSERT INTO t VALUES (1)").run();
  })();
}`);
      expect(sites.map((s) => [s.fn, isFlagged(s)])).toEqual([
        ["readOnly", false],
        ["writeOnly", false],
        ["mapGet", false],
      ]);
    },
  );

  it("does not trust a callback it cannot see into", { timeout: HEAVY_TIMEOUT_MS }, () => {
    const [site] = scanSource(`${PRELUDE}
export function opaque(cb: () => void): void { db.transaction(cb)(); }`);
    expect(isFlagged(site!)).toBe(true);
  });
});
