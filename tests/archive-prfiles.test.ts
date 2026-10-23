// Per-PR file archiving (docs/archiving.md §7) over a real temp
// root, through the real archiver in mode `on`:
//
//   (1) the happy path: three transcripts become gzips whose bytes and mtimes
//       are the originals', one bundle holds one verified record per small
//       file (the ledger snapshotted, a payload deduped with same_as, binary
//       bytes as base64), the manifest records it all, the live sources and
//       the emptied dirs are gone — and ledger.md, meta.json and the live
//       ledger are untouched;
//   (2) every eligibility clause holds the PR with its reason, nothing moved;
//   (9) the synchronous parts grow linearly with the PRs, and the work yields
//       per file and per chunk;
//  (10) the fences: no pi/session strings, no memory imports.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { archiveFile } from "../src/archive/gzfile.js";
import { settledIndex, type Manifest } from "../src/archive/manifest.js";
import { computePlan } from "../src/archive/plan.js";
import { SpanMeter, groupBy, PR_DIR } from "../src/archive/prfiles.js";
import { archiveRow } from "../src/archive/rows.js";
import {
  DAY,
  T0,
  bundleRecords,
  filesUnder,
  manifestOf,
  onArchiver,
  prFixture,
  put,
  recordBytes,
  sha,
  type PrFixture,
} from "./helpers/archive-pr.js";
import {
  LINEAR_HANG_GUARD_MS,
  LINEAR_RATIO_CEILING_10X,
  LINEAR_RATIO_CEILING_10X_RETAINED,
  measureScaling,
} from "./helpers/scaling.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const open: PrFixture[] = [];
const fixture = (o: Parameters<typeof prFixture>[0] = {}): PrFixture => {
  const f = prFixture(o);
  open.push(f);
  return f;
};
afterEach(() => {
  for (const f of open.splice(0)) f.close();
});

const fileHash = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");

/** Hash + mtime of every file outside archive/db (the DB phase's own). */
function treeState(root: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rel of filesUnder(root)) {
    if (/^state\/state\.db/.test(rel) || /^archive\/db\//.test(rel)) continue;
    out.set(rel, `${fileHash(join(root, rel))} ${statSync(join(root, rel)).mtimeMs}`);
  }
  return out;
}

describe("the happy path (acceptance 1)", () => {
  it(
    "a PR closed 15 days: transcripts gzipped with their mtimes, one verified bundle, sources and emptied dirs gone, the ledgers untouched",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = fixture();
      const keep = new Map(f.untouched.map((rel) => [rel, treeState(f.root).get(rel)!]));
      const a = onArchiver(f);
      try {
        const tick = await a.tick();
        expect(tick.state).toBe("idle");
        const dir = join(f.root, "archive", `pr-${f.pr}`);
        // Transcripts: one gzip each, its bytes and its mtime the original's.
        for (const rel of f.transcripts) {
          const name = rel.slice(`state/pi-sessions/pr-${f.pr}/`.length);
          const gz = join(dir, "transcripts", `${name}.gz`);
          expect(gunzipSync(readFileSync(gz)).equals(f.bytes.get(rel)!), rel).toBe(true);
          expect(Math.abs(statSync(gz).mtimeMs - f.mtimes.get(rel)!)).toBeLessThan(1);
          expect(existsSync(join(f.root, rel)), `${rel} left the live tree`).toBe(false);
        }
        // The bundle: one record per small file (+ the ledger snapshot), each
        // hashing to the source's bytes.
        const bundles = readdirSync(dir).filter((n) => /^state-.+\.jsonl\.gz$/.test(n));
        expect(bundles).toHaveLength(1);
        const records = bundleRecords(f);
        expect([...records.keys()].sort()).toEqual(
          [...f.small, `state/ledgers/pr-${f.pr}.md`].sort(),
        );
        for (const rel of f.small) {
          const r = records.get(rel)!;
          expect(r.sha256, rel).toBe(sha(f.bytes.get(rel)!));
          expect(recordBytes(records, rel).equals(f.bytes.get(rel)!), rel).toBe(true);
          expect(existsSync(join(f.root, rel)), `${rel} left the live tree`).toBe(false);
        }
        // The payload is byte-identical to its round prompt: stored once.
        expect(records.get(`state/session-commands/cmd-${f.pr}-1.md`)).toMatchObject({
          same_as: `state/round-prompts/pr-${f.pr}-round-1.md`,
          session_command: { id: `cmd-${f.pr}-1`, status: "acked", payload_sha256_ok: true },
        });
        expect(records.get(`state/pr-${f.pr}-round-1-passes/out.bin`)).toMatchObject({
          enc: "base64",
        });
        expect(records.get(`state/ledgers/pr-${f.pr}.md`)).toMatchObject({ snapshot: true });
        // The manifest records it all, every removal stamped.
        const m = manifestOf(f);
        const kinds = m.entries.map((e) => e.kind);
        expect(kinds.filter((k) => k === "transcript")).toHaveLength(3);
        expect(kinds.filter((k) => k === "bundle")).toHaveLength(1);
        for (const e of m.entries.filter((x) => x.kind === "transcript"))
          expect(e.source_removed_at).toBeTruthy();
        expect(m.entries.find((e) => e.kind === "bundle")!.sources_removed_at).toBeTruthy();
        expect(m.entries.find((e) => e.kind === "bundle")!.kept).toBeUndefined();
        // Emptied dirs are gone; the ledgers and meta.json are untouched.
        for (const d of [
          `state/pi-sessions/pr-${f.pr}`,
          `state/pr-${f.pr}-round-1-passes`,
          `inject/pr-${f.pr}`,
        ])
          expect(existsSync(join(f.root, d)), d).toBe(false);
        const after = treeState(f.root);
        for (const [rel, state] of keep) expect(after.get(rel), rel).toBe(state);
        // The ledger: archived, with the totals; the event and the status.
        expect(archiveRow(f.store, f.pr)).toMatchObject({
          state: "archived",
          transcript_files: 3,
          state_files: f.small.length,
        });
        expect(archiveRow(f.store, f.pr)!.max_mtime_ms).toBe(
          Math.max(...f.transcripts.map((t) => f.mtimes.get(t)!)),
        );
        const ev = f.store.db
          .prepare("SELECT payload FROM events WHERE kind = 'archive_pr_archived' AND pr = ?")
          .all(f.pr) as Array<{ payload: string }>;
        expect(ev).toHaveLength(1);
        expect(JSON.parse(ev[0]!.payload)).toMatchObject({
          transcripts: 3,
          stale_inject: [`inject/pr-${f.pr}/stale.md`],
        });
        expect(a.status().files).toMatchObject({
          outcome: "done",
          prs_archived: 1,
          transcripts: 3,
          verify_failures: 0,
        });
        // A second tick finds nothing left: no new manifest entry, no bundle.
        f.clock.ms += 16 * 60_000;
        await a.tick();
        expect(manifestOf(f).entries).toHaveLength(m.entries.length);
      } finally {
        a.stop();
      }
    },
  );

  it(
    "a per-round file a session wrote beside the daemon's (`pr-<n>-round-<k>-body.md`) leaves with the bundle; an unclaimed state/pr-<n>-* file stays live (rehearsal 2026-10-08)",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = fixture();
      const body = `state/pr-${f.pr}-round-3-body.md`;
      const notes = `state/pr-${f.pr}-notes.md`;
      put(f.root, body, "the review body the session drafted\n");
      put(f.root, notes, "claimed by no class\n");
      const a = onArchiver(f);
      try {
        await a.tick();
        expect(archiveRow(f.store, f.pr)).toMatchObject({
          state: "archived",
          state_files: f.small.length + 1,
        });
        expect(existsSync(join(f.root, body))).toBe(false);
        expect(bundleRecords(f).get(body)).toMatchObject({ class: "round_files" });
        expect(readFileSync(join(f.root, notes), "utf8")).toBe("claimed by no class\n");
      } finally {
        a.stop();
      }
    },
  );

  it(
    "an eligible PR with nothing live gets a zero-file archived row and no manifest",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = fixture();
      f.store.upsertPr({
        number: 77,
        state: "closed",
        head_sha: "x",
        title: "foreign",
        author: "a",
        trigger_ts: null,
        stale_recheck: 0,
        migration_gate: 0,
      });
      f.store.db
        .prepare("UPDATE pr_state SET updated_at = ? WHERE number = 77")
        .run(new Date(T0 - 30 * DAY).toISOString());
      const a = onArchiver(f);
      try {
        await a.tick();
        expect(archiveRow(f.store, 77)).toMatchObject({ state: "archived", transcript_files: 0 });
        expect(existsSync(join(f.root, "archive", "pr-77", "manifest.json"))).toBe(false);
      } finally {
        a.stop();
      }
    },
  );
});

describe("nothing is touched while a clause holds the PR (acceptance 2)", () => {
  const cases: Array<{
    reason: string;
    setup: (f: PrFixture) => void;
    extra?: (f: PrFixture) => Parameters<typeof onArchiver>[2];
  }> = [
    {
      reason: "closed_recently",
      setup: (f) =>
        f.store.db
          .prepare("UPDATE events SET ts = ? WHERE kind = 'pr_closed'")
          .run(new Date(T0 - 13 * DAY).toISOString()),
    },
    {
      reason: "worker_alive",
      setup: () => {},
      extra: (f) => ({ liveSessions: async () => [`pr-${f.pr}`] }),
    },
    {
      reason: "birth_in_flight",
      setup: () => {},
      extra: (f) => ({ birthInFlight: (pr) => pr === f.pr }),
    },
    {
      reason: "round_running",
      setup: (f) => {
        f.store.startRound(f.pr, "re-review", ["pass-baseline"], 75);
      },
    },
    {
      reason: "command_active",
      setup: (f) => {
        f.store.createSessionCommand({
          id: "pending-1",
          pr: f.pr,
          session: `pr-${f.pr}`,
          kind: "wake",
          round_no: null,
          payload_sha256: "0".repeat(64),
          payload_path: join(f.root, "state/session-commands/pending-1.md"),
          inject_path: join(f.root, `inject/pr-${f.pr}/zz-not-a-file.md`),
          next_check_at: new Date(T0).toISOString(),
        });
      },
    },
    {
      // A top-level wake with no command row at all: undelivered, unknown.
      reason: "pending_inject",
      setup: (f) => {
        put(f.root, `inject/pr-${f.pr}/undelivered.md`, "a wake");
      },
    },
    {
      // …and one whose row is not terminal (a stuck round command of a
      // reopened-then-closed PR): held as well.
      reason: "pending_inject",
      setup: (f) => {
        const p = put(f.root, `inject/pr-${f.pr}/stuck.md`, "a wake");
        f.store.createSessionCommand({
          id: "stuck-1",
          pr: f.pr,
          session: `pr-${f.pr}-elsewhere`,
          kind: "wake",
          round_no: null,
          payload_sha256: "0".repeat(64),
          payload_path: join(f.root, "state/session-commands/stuck-1.md"),
          inject_path: p,
          next_check_at: new Date(T0).toISOString(),
        });
        // Not this PR's own active command (that is command_active): the row
        // names another PR, so only the inject clause sees it.
        f.store.db.prepare("UPDATE session_commands SET pr = 999 WHERE id = 'stuck-1'").run();
      },
    },
    {
      reason: "failure_open",
      setup: (f) =>
        f.store.db
          .prepare(
            `INSERT INTO review_failures (incident_id, pr, head_sha, stage, detail, attempts, retry_cap,
               failed_at, updated_at, next_action, work_owed)
             VALUES ('rf-1', ?, 'abc', 'first_pass_start', 'd', 1, 2, ?, ?, 'operator', 1)`,
          )
          .run(f.pr, new Date(T0 - DAY).toISOString(), new Date(T0 - DAY).toISOString()),
    },
  ];
  for (const [i, c] of cases.entries())
    it(
      `${i}. ${c.reason}: held with its reason, every file as it was`,
      { timeout: HEAVY_TIMEOUT_MS },
      async () => {
        const f = fixture();
        c.setup(f);
        const before = treeState(f.root);
        const a = onArchiver(f, {}, c.extra?.(f) ?? {});
        try {
          await a.tick();
          expect(treeState(f.root)).toEqual(before);
          const status = a.status();
          if (c.reason === "closed_recently") {
            // Inside the window: waiting, not held — and nothing archived.
            expect(a.lastPlan()!.registry.waiting).toBe(1);
          } else
            expect(status.held_prs!.first.find((h) => h.pr === f.pr)?.reason, c.reason).toBe(
              c.reason,
            );
          expect(archiveRow(f.store, f.pr)).toBeNull();
        } finally {
          a.stop();
        }
      },
    );

  it(
    "…and the pass's own fresh check holds a PR the plan offered (a birth that started since)",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = fixture();
      let birth = false;
      const a = onArchiver(f, {}, { birthInFlight: (pr) => birth && pr === f.pr });
      try {
        // Plan first (plan mode semantics are the same rule): then the birth.
        const plan = await computePlan({
          store: f.store,
          root: f.root,
          sessionsRoot: join(f.root, "state", "pi-sessions"),
          now: () => new Date(T0),
          afterDays: 14,
          eventsAfterDays: 35,
          liveSessions: async () => [],
          birthInFlight: () => false,
        });
        expect(plan.candidates.map((c) => c.pr)).toEqual([f.pr]);
        const before = treeState(f.root);
        birth = true;
        await a.tick();
        expect(treeState(f.root)).toEqual(before);
        expect(a.status().held_prs!.first).toContainEqual({ pr: f.pr, reason: "birth_in_flight" });
      } finally {
        a.stop();
      }
    },
  );
});

describe("linear, and never one long span (acceptance 9)", () => {
  /** A fake listing: `n` PR dirs plus noise. */
  function entries(n: number): Dirent[] {
    const out: Dirent[] = [];
    for (let i = 0; i < n; i++) {
      out.push({ name: `pr-${1000 + i}`, isFile: () => false, isDirectory: () => true } as Dirent);
      out.push({ name: `noise-${i}`, isFile: () => true, isDirectory: () => false } as Dirent);
    }
    return out;
  }

  it(
    "grouping a listing and looking up every PR grows linearly in the PRs (one readdir, a map lookup each)",
    { timeout: LINEAR_HANG_GUARD_MS },
    () => {
      const small = entries(2_000);
      const large = entries(20_000);
      const s = measureScaling(
        (list: Dirent[]) => {
          const g = groupBy(new SpanMeter(), "/r", list, PR_DIR, "dir");
          let n = 0;
          for (let i = 0; i < list.length / 2; i++) n += g.get(1000 + i)?.length ?? 0;
          if (n !== list.length / 2) throw new Error("lost a PR");
        },
        small,
        large,
      );
      expect(s.ratio).toBeLessThan(LINEAR_RATIO_CEILING_10X);
    },
  );

  it("the manifest index grows linearly in its entries", { timeout: LINEAR_HANG_GUARD_MS }, () => {
    const manifest = (n: number): Manifest => ({
      format: 1,
      subject: "pr-1",
      passes: [],
      entries: Array.from({ length: n }, (_, i) => ({
        pass: "p",
        kind: "bundle" as const,
        archive: `state-${i}.jsonl.gz`,
        records: 2,
        bytes: 2,
        gz_bytes: 2,
        verified_at: "x",
        files: [0, 1].map((k) => ({
          path: `state/f-${i}-${k}`,
          bytes: 1,
          mtime_ms: 1,
          dev: 1,
          ino: i * 2 + k,
          sha256: "s",
          class: "findings",
        })),
      })),
    });
    // The index is the run's result: 40,000 kept records on the large side, so
    // the retained-result ceiling (a quadratic index still reads ~100), and the
    // best of five interleaved samples per size.
    const s = measureScaling((m: Manifest) => settledIndex(m), manifest(2_000), manifest(20_000), {
      samples: 5,
    });
    expect(s.ratio, JSON.stringify(s)).toBeLessThan(LINEAR_RATIO_CEILING_10X_RETAINED);
  });

  it(
    "a transcript of several chunks is streamed with an event-loop turn per chunk",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = fixture();
      const src = put(f.root, "big.jsonl", Buffer.alloc(4 * 1024 * 1024 + 7, 0x61));
      let turns = 0;
      let on = true;
      const spin = (): void => {
        if (!on) return;
        turns += 1;
        setImmediate(spin);
      };
      setImmediate(spin);
      const st = statSync(src);
      const r = await archiveFile(src, join(f.root, "archive", "big.jsonl.gz"), {
        level: 6,
        bytesPerS: 1e12,
        identity: { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs },
      });
      on = false;
      expect(r.kind).toBe("ok");
      // Five 1 MiB chunks read, compressed, verified: well over one turn each.
      expect(turns).toBeGreaterThanOrEqual(5);
    },
  );

  it(
    "a PR pass takes an event-loop turn between every two files it archives",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = fixture();
      let turns = 0;
      let on = true;
      const spin = (): void => {
        if (!on) return;
        turns += 1;
        setImmediate(spin);
      };
      setImmediate(spin);
      const at: number[] = [];
      const a = onArchiver(
        f,
        {},
        {
          step: (name) => {
            if (name === "renamed") at.push(turns);
          },
        },
      );
      try {
        await a.tick();
      } finally {
        on = false;
        a.stop();
      }
      // Three transcripts and one bundle placed, with real turns between.
      expect(at).toHaveLength(4);
      for (let i = 1; i < at.length; i++) expect(at[i]!).toBeGreaterThan(at[i - 1]!);
    },
  );
});

describe("fences (acceptance 10)", () => {
  const dir = join(import.meta.dirname, "..", "src", "archive");
  const sources = readdirSync(dir)
    .filter((n) => n.endsWith(".ts"))
    .map((n) => [n, readFileSync(join(dir, n), "utf8")] as const);

  it("the S3 modules exist and are in the fenced set", () => {
    const names = sources.map(([n]) => n);
    for (const n of [
      "prfiles.ts",
      "gzfile.ts",
      "bundle.ts",
      "manifest.ts",
      "restore.ts",
      "prarchive.ts",
      "rows.ts",
    ])
      expect(names).toContain(n);
  });

  it("no single-shepherd S2 string in src/archive/ (no pi spawn, no session-less pi)", () => {
    const offenders = sources
      .filter(([, t]) => /["'`]pi["'`]\s*,|piBin|--no-session/.test(t))
      .map(([n]) => n);
    expect(offenders).toEqual([]);
  });

  it("src/archive/ imports nothing from memory/ or openviking/", () => {
    const offenders = sources
      .filter(([, t]) => /from\s+["'][^"']*\/(memory|openviking)\//.test(t))
      .map(([n]) => n);
    expect(offenders).toEqual([]);
  });

  it("…and never writes a wake: no inject drop-box writer outside the inventory's one path constructor", () => {
    for (const [n, t] of sources) {
      // The single-shepherd fence's own comment stripping.
      const code = t
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*)/.test(l))
        .map((l) => l.replace(/\/\/.*$/, ""))
        .join("\n");
      if (n === "prfiles.ts") continue;
      expect(/["']inject["']|inject\//.test(code), n).toBe(false);
    }
  });
});
