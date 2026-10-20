// Restore (docs/archiving.md §8.2–§8.4):
//
//   (6) a slow restore makes a birth await it; a failing restore raises the
//       `archive_restore_failed` wake, the birth goes ahead and the receipt
//       guard stays armed; the restore is idempotent; a re-archive after a
//       re-close REUSES the archived copies (no recompress) and the manifest
//       only appends. Plus: the tick restores a reopened PR first, even while
//       draining; a birth never waits past the bound; the transcripts and the
//       payloads come back with their original bytes and mtimes, and nothing
//       else returns to a live path.
//
// Plus what keeps a restore honest: a gzip that decompresses to the wrong
// bytes, or a manifest gone missing beside archived files, is a failure
// (never "restored"); a failed file leaves no `.restore-partial` behind; a
// live mount short of its headroom writes nothing; a crash mid-file is swept
// at the next start; a file that appears at the target is never replaced;
// and the tick's restores obey every load hold but the drain.
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { anomalySeverity } from "../src/anomalies.js";
import { StrictMutex } from "../src/archive/archiver.js";
import { archiveRow } from "../src/archive/rows.js";
import { restorePr } from "../src/archive/restore.js";
import type { DaemonLoadStatus } from "../src/eventloop.js";
import {
  DAY,
  T0,
  filesUnder,
  line,
  manifestOf,
  okLoad,
  onArchiver,
  prFixture,
  put,
  reopen,
  lifecycleRig,
  type PrFixture,
} from "./helpers/archive-pr.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const open: PrFixture[] = [];
afterEach(() => {
  for (const f of open.splice(0)) f.close();
});

async function archived(): Promise<PrFixture> {
  const f = prFixture();
  open.push(f);
  const a = onArchiver(f);
  await a.tick();
  a.stop();
  expect(archiveRow(f.store, f.pr)?.state).toBe("archived");
  for (const rel of f.transcripts) expect(existsSync(join(f.root, rel))).toBe(false);
  return f;
}

const payload = (f: PrFixture): string => `state/session-commands/cmd-${f.pr}-1.md`;
const restorePartials = (f: PrFixture): string[] =>
  filesUnder(f.root).filter((p) => p.endsWith(".restore-partial"));
const turns = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

describe("restore before birth (acceptance 6)", () => {
  it(
    "a slow restore makes the birth await it — the session is born only once the files are back",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = await archived();
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const a = onArchiver(
        f,
        {},
        {
          step: async (name) => {
            if (name === "restored_file") await gate;
          },
        },
      );
      const rig = lifecycleRig(f);
      rig.m.setBeforeBirth((pr) => a.beforeBirth(pr));
      const atBirth: boolean[] = [];
      rig.onBirth = () => atBirth.push(f.transcripts.every((t) => existsSync(join(f.root, t))));
      reopen(f);
      const birth = rig.m.ensurePrSession(f.pr, "T", "wt/pr");
      await turns(50);
      expect(rig.births).toEqual([]);
      expect(archiveRow(f.store, f.pr)?.state).toBe("restoring");
      release();
      await birth;
      expect(rig.births).toEqual([`pr-${f.pr}`]);
      expect(atBirth).toEqual([true]);
      expect(archiveRow(f.store, f.pr)?.state).toBe("restored");
      a.stop();
    },
  );

  it(
    "the transcripts and the payloads come back byte-identical with their original mtimes; nothing else returns",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = await archived();
      reopen(f);
      const a = onArchiver(f);
      await a.beforeBirth(f.pr);
      a.stop();
      for (const rel of f.transcripts) {
        expect(readFileSync(join(f.root, rel)).equals(f.bytes.get(rel)!), rel).toBe(true);
        expect(Math.abs(statSync(join(f.root, rel)).mtimeMs - f.mtimes.get(rel)!)).toBeLessThan(1);
      }
      expect(readFileSync(join(f.root, payload(f))).equals(f.bytes.get(payload(f))!)).toBe(true);
      for (const rel of f.small.filter((r) => r !== payload(f)))
        expect(existsSync(join(f.root, rel)), rel).toBe(false);
      const restore = manifestOf(f).entries.find((e) => e.kind === "restore")!;
      expect(restore).toMatchObject({ trigger: "reopen", files: 4 });
      expect(
        f.store.db
          .prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'archive_pr_restored'")
          .get(),
      ).toEqual({ n: 1 });
    },
  );

  it(
    "a failing restore raises the wake, the birth proceeds, and the guard stays armed",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = await archived();
      // Corrupt one archived transcript.
      const gz = join(
        f.root,
        "archive",
        `pr-${f.pr}`,
        "transcripts",
        `${f.transcripts[1]!.split("/").pop()}.gz`,
      );
      writeFileSync(gz, "not a gzip at all");
      const a = onArchiver(f);
      const rig = lifecycleRig(f);
      rig.m.setBeforeBirth((pr) => a.beforeBirth(pr));
      reopen(f);
      await rig.m.ensurePrSession(f.pr, "T", "wt/pr");
      expect(rig.births).toEqual([`pr-${f.pr}`]);
      expect(archiveRow(f.store, f.pr)).toMatchObject({ state: "restore_failed" });
      expect(archiveRow(f.store, f.pr)!.last_error).toMatch(/not restored/);
      const wakes = f.store.anomalies().filter((x) => x.kind === "archive_restore_failed");
      expect(wakes).toHaveLength(1);
      expect(wakes[0]!.pr).toBe(f.pr);
      expect(anomalySeverity("archive_restore_failed")).toBe("wake");
      // A second birth inside the retry window does not retry (nor wake again).
      await a.beforeBirth(f.pr);
      expect(f.store.anomalies().filter((x) => x.kind === "archive_restore_failed")).toHaveLength(
        1,
      );
      // The two good transcripts did come back.
      expect(existsSync(join(f.root, f.transcripts[0]!))).toBe(true);
      expect(existsSync(join(f.root, f.transcripts[1]!))).toBe(false);
      // The failed file left no `.restore-partial` in the LIVE session dir.
      expect(restorePartials(f)).toEqual([]);
      a.stop();
    },
  );

  it(
    "a gzip that decompresses cleanly to the WRONG bytes is never placed: restore_failed, the wake, and the guard stays armed",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = await archived();
      const gz = join(
        f.root,
        "archive",
        `pr-${f.pr}`,
        "transcripts",
        `${f.transcripts[1]!.split("/").pop()}.gz`,
      );
      writeFileSync(gz, gzipSync(Buffer.from("other bytes")));
      const a = onArchiver(f);
      const rig = lifecycleRig(f);
      rig.m.setBeforeBirth((pr) => a.beforeBirth(pr));
      reopen(f);
      await rig.m.ensurePrSession(f.pr, "T", "wt/pr");
      a.stop();
      expect(rig.births).toEqual([`pr-${f.pr}`]);
      expect(existsSync(join(f.root, f.transcripts[1]!))).toBe(false);
      expect(restorePartials(f)).toEqual([]);
      expect(archiveRow(f.store, f.pr)).toMatchObject({ state: "restore_failed" });
      expect(archiveRow(f.store, f.pr)!.last_error).toMatch(/the manifest records/);
      expect(f.store.anomalies().filter((x) => x.kind === "archive_restore_failed")).toHaveLength(
        1,
      );
    },
  );

  it(
    "a MISSING manifest beside archived files is a lost record — restore_failed, never 'nothing to restore'",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = await archived();
      rmSync(join(f.root, "archive", `pr-${f.pr}`, "manifest.json"));
      reopen(f);
      const a = onArchiver(f);
      await a.beforeBirth(f.pr);
      a.stop();
      expect(archiveRow(f.store, f.pr)).toMatchObject({ state: "restore_failed" });
      expect(archiveRow(f.store, f.pr)!.last_error).toMatch(/manifest\.json is missing/);
      expect(f.store.anomalies().filter((x) => x.kind === "archive_restore_failed")).toHaveLength(
        1,
      );
    },
  );

  it("…while a row that never moved a byte (no manifest, no archive file, no counts) restores as nothing", async () => {
    const f = prFixture();
    open.push(f);
    // A pass armed the guard and stopped before its first file.
    f.store.db
      .prepare(
        "INSERT INTO archive_prs (pr, state, max_mtime_ms, updated_at) VALUES (?, 'archiving', ?, ?)",
      )
      .run(f.pr, f.mtimes.get(f.transcripts[2]!)!, new Date(T0).toISOString());
    reopen(f);
    const a = onArchiver(f);
    await a.beforeBirth(f.pr);
    a.stop();
    expect(archiveRow(f.store, f.pr)?.state).toBe("restored");
    expect(f.store.anomalies().filter((x) => x.kind === "archive_restore_failed")).toEqual([]);
  });

  it(
    "the LIVE mount short of the headroom: nothing is written, restore_failed and the wake — the birth still proceeds",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = await archived();
      const GB = 1024 ** 3;
      const a = onArchiver(
        f,
        {},
        {
          // The archive mount has plenty; the state mount (where restored
          // files land) is 100 bytes over the headroom — less than any file.
          statfs: async (p: string) => ({
            bavail: p.endsWith(`${sep}state`) ? 2 * GB + 100 : 1e12,
            bsize: 1,
          }),
        },
      );
      const rig = lifecycleRig(f);
      rig.m.setBeforeBirth((pr) => a.beforeBirth(pr));
      reopen(f);
      await rig.m.ensurePrSession(f.pr, "T", "wt/pr");
      a.stop();
      expect(rig.births).toEqual([`pr-${f.pr}`]);
      for (const rel of [...f.transcripts, payload(f)])
        expect(existsSync(join(f.root, rel)), rel).toBe(false);
      expect(restorePartials(f)).toEqual([]);
      expect(archiveRow(f.store, f.pr)).toMatchObject({ state: "restore_failed" });
      expect(archiveRow(f.store, f.pr)!.last_error).toMatch(/disk_low/);
      expect(f.store.anomalies().filter((x) => x.kind === "archive_restore_failed")).toHaveLength(
        1,
      );
    },
  );
  it(
    "a restore that outlasts the bound never holds the birth past it",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = await archived();
      const a = onArchiver(
        f,
        {},
        {
          restoreWaitMs: 30,
          step: async (name) => {
            if (name === "restored_file") await new Promise(() => {});
          },
        },
      );
      const rig = lifecycleRig(f);
      rig.m.setBeforeBirth((pr) => a.beforeBirth(pr));
      reopen(f);
      const t = Date.now();
      await rig.m.ensurePrSession(f.pr, "T", "wt/pr");
      expect(rig.births).toEqual([`pr-${f.pr}`]);
      expect(Date.now() - t).toBeLessThan(4000);
      // Still restoring: the guard stays armed meanwhile.
      expect(archiveRow(f.store, f.pr)?.state).toBe("restoring");
      a.stop();
    },
  );

  it("no archive row, or a restored one, returns at once — and the hook is a no-op outside mode on", async () => {
    const f = prFixture();
    open.push(f);
    const a = onArchiver(f);
    let done = false;
    await a.beforeBirth(f.pr).then(() => (done = true));
    expect(done).toBe(true);
    const plan = onArchiver(f, { mode: "plan" });
    f.store.db
      .prepare("INSERT INTO archive_prs (pr, state, updated_at) VALUES (?, 'archived', ?)")
      .run(f.pr, new Date(T0).toISOString());
    reopen(f);
    await plan.beforeBirth(f.pr);
    expect(archiveRow(f.store, f.pr)?.state).toBe("archived");
  });
});

describe("the tick restores first (§8.3)", () => {
  it(
    "a PR reopened while nothing was born is restored by the next tick — even while draining",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = await archived();
      reopen(f);
      f.store.engageDrain({ issuer: "operator", expires_at: null });
      const a = onArchiver(f);
      const tick = await a.tick();
      a.stop();
      expect(tick).toMatchObject({ state: "held", held_reason: "draining" });
      expect(archiveRow(f.store, f.pr)?.state).toBe("restored");
      for (const rel of f.transcripts) expect(existsSync(join(f.root, rel))).toBe(true);
    },
  );
});

describe("the tick's restores obey every hold but the drain (§10)", () => {
  it(
    "a stalled loop holds the tick's restores; once it clears, the next tick restores",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = await archived();
      reopen(f);
      let stalled = true;
      const a = onArchiver(
        f,
        {},
        {
          load: () =>
            stalled
              ? { ...okLoad(), event_loop: { state: "stalled" } as DaemonLoadStatus["event_loop"] }
              : okLoad(),
        },
      );
      try {
        expect(await a.tick()).toMatchObject({ state: "held", held_reason: "loop_stalled" });
        expect(archiveRow(f.store, f.pr)?.state).toBe("archived");
        for (const rel of f.transcripts) expect(existsSync(join(f.root, rel))).toBe(false);
        stalled = false;
        f.clock.ms += 60_000;
        await a.tick();
        expect(archiveRow(f.store, f.pr)?.state).toBe("restored");
        for (const rel of f.transcripts) expect(existsSync(join(f.root, rel))).toBe(true);
      } finally {
        a.stop();
      }
    },
  );

  it(
    "one PR whose archive dir cannot be read at crash recovery does not stop the tick: the quiet anomaly, and the other PR's restore runs",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = await archived();
      reopen(f);
      // Another PR a crash left `archiving`, whose archive dir is not a dir.
      f.store.db
        .prepare("INSERT INTO archive_prs (pr, state, updated_at) VALUES (9999, 'archiving', ?)")
        .run(new Date(T0).toISOString());
      put(f.root, "archive/pr-9999", "not a directory");
      const a = onArchiver(f);
      try {
        expect((await a.tick()).state).not.toBe("failed");
        expect(archiveRow(f.store, f.pr)?.state).toBe("restored");
        const quiet = f.store.anomalies().filter((x) => x.kind === "archive_verify_failed");
        expect(quiet).toHaveLength(1);
        expect(quiet[0]!.detail).toMatch(/crash recovery: pr-9999/);
        // Retried each tick, quietly: no second anomaly inside the window.
        f.clock.ms += 60_000;
        expect((await a.tick()).state).not.toBe("failed");
        expect(f.store.anomalies().filter((x) => x.kind === "archive_verify_failed")).toHaveLength(
          1,
        );
      } finally {
        a.stop();
      }
    },
  );
});

describe("a restore's own crash safety (§7.6, §8.2)", () => {
  it(
    "a crash between a file's .restore-partial and its rename: the next start removes the stray, then the restore completes",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = await archived();
      reopen(f);
      let fired = false;
      const a = onArchiver(
        f,
        {},
        {
          step: (name) => {
            if (fired || name !== "restore_partial_written") return;
            fired = true;
            // The process dies here: nothing after this line runs.
            a.stop();
            throw new Error("crash");
          },
        },
      );
      await a.beforeBirth(f.pr);
      expect(fired).toBe(true);
      expect(archiveRow(f.store, f.pr)?.state).toBe("restoring");
      expect(restorePartials(f)).toHaveLength(1);
      const logs: string[] = [];
      const b = onArchiver(f, {}, { log: (m) => logs.push(m) });
      try {
        await b.tick();
      } finally {
        b.stop();
      }
      expect(logs.some((l) => /crash recovery removed 1 stray temporary file/.test(l))).toBe(true);
      expect(restorePartials(f)).toEqual([]);
      expect(archiveRow(f.store, f.pr)?.state).toBe("restored");
      for (const rel of [...f.transcripts, payload(f)])
        expect(readFileSync(join(f.root, rel)).equals(f.bytes.get(rel)!), rel).toBe(true);
    },
  );

  it(
    "a file that appears at the target while it is being restored is never replaced",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = await archived();
      reopen(f);
      const target = f.transcripts[0]!;
      const theirs = line("a file someone else wrote meanwhile");
      const logs: string[] = [];
      const a = onArchiver(
        f,
        {},
        {
          log: (m) => logs.push(m),
          step: (name, info) => {
            if (name === "restore_partial_written" && info.target === join(f.root, target))
              put(f.root, target, theirs);
          },
        },
      );
      await a.beforeBirth(f.pr);
      a.stop();
      expect(readFileSync(join(f.root, target), "utf8")).toBe(theirs);
      expect(restorePartials(f)).toEqual([]);
      const restore = manifestOf(f).entries.find((e) => e.kind === "restore")!;
      expect(restore.live_differs).toEqual([target]);
      // The live file differs; nothing says it is the newer one.
      const done = logs.find((m) => m.includes(`pr-${f.pr} restored`))!;
      expect(done).toContain("1 differing live file(s) left as found");
      expect(done).not.toContain("newer");
      for (const rel of f.transcripts.slice(1))
        expect(readFileSync(join(f.root, rel)).equals(f.bytes.get(rel)!), rel).toBe(true);
    },
  );
});

describe("idempotent, and a re-archive reuses (acceptance 6)", () => {
  it(
    "restoring twice changes nothing the second time; files already present are left alone",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = await archived();
      reopen(f);
      const deps = {
        store: f.store,
        root: f.root,
        sessionsRoot: join(f.root, "state", "pi-sessions"),
        now: () => new Date(f.clock.ms),
        bytesPerS: 1e9,
        log: () => {},
      };
      // A crash after two files landed, before the restore entry and the row.
      class Crash extends Error {}
      let n = 0;
      await expect(
        restorePr(
          {
            ...deps,
            step: (name) => {
              if (name === "restored_file" && ++n === 2) throw new Crash("crash");
            },
          },
          f.pr,
          "reopen",
        ),
      ).rejects.toThrow("crash");
      expect(archiveRow(f.store, f.pr)?.state).toBe("restoring");
      const landed = f.transcripts.filter((t) => existsSync(join(f.root, t)));
      expect(landed.length).toBeGreaterThan(0);
      const inos = landed.map((t) => statSync(join(f.root, t)).ino);
      const entries = manifestOf(f).entries.length;
      // Run again: the files already present with their recorded bytes are left
      // alone; the rest come back; one restore entry.
      const again = await restorePr(deps, f.pr, "reopen");
      expect(again).toMatchObject({ outcome: "restored", present: 2, restored: 2 });
      expect(landed.map((t) => statSync(join(f.root, t)).ino)).toEqual(inos);
      expect(manifestOf(f).entries).toHaveLength(entries + 1);
      for (const rel of [...f.transcripts, payload(f)])
        expect(readFileSync(join(f.root, rel)).equals(f.bytes.get(rel)!), rel).toBe(true);
      // Already restored: nothing at all, and nothing written.
      expect((await restorePr(deps, f.pr, "reopen")).outcome).toBe("none");
      expect(manifestOf(f).entries).toHaveLength(entries + 1);
    },
  );

  it(
    "a re-archive after a re-close reuses the archived copies (no recompress) and the manifest only appends",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = await archived();
      const dir = join(f.root, "archive", `pr-${f.pr}`);
      const gzStat = new Map(
        f.transcripts.map((t) => {
          const st = statSync(
            join(dir, "transcripts", `${t.slice(`state/pi-sessions/pr-${f.pr}/`.length)}.gz`),
          );
          return [t, `${st.ino} ${st.mtimeMs} ${st.size}`];
        }),
      );
      reopen(f);
      const a = onArchiver(f);
      await a.beforeBirth(f.pr);
      a.stop();
      const before = manifestOf(f);
      // Closed again, and 15 days pass (the window counts from the restore).
      f.store.db.prepare("UPDATE pr_state SET state = 'closed' WHERE number = ?").run(f.pr);
      f.store.logEvent("pr_closed", f.pr, { merged: true });
      f.clock.ms = T0 + 15 * DAY;
      const b = onArchiver(f);
      await b.tick();
      b.stop();
      expect(archiveRow(f.store, f.pr)?.state).toBe("archived");
      for (const t of f.transcripts) expect(existsSync(join(f.root, t))).toBe(false);
      expect(existsSync(join(f.root, payload(f)))).toBe(false);
      // The gzips were not written again.
      for (const [t, st] of gzStat) {
        const now = statSync(
          join(dir, "transcripts", `${t.slice(`state/pi-sessions/pr-${f.pr}/`.length)}.gz`),
        );
        expect(`${now.ino} ${now.mtimeMs} ${now.size}`, t).toBe(st);
      }
      // The manifest only appended: every earlier entry as it was, then the
      // reuse entries (the three transcripts and the payload).
      const after = manifestOf(f);
      expect(after.entries.slice(0, before.entries.length)).toEqual(before.entries);
      const added = after.entries.slice(before.entries.length);
      expect(added.filter((e) => e.kind === "transcript" && e.reused === true)).toHaveLength(3);
      expect(added.filter((e) => e.kind === "reused" && e.source === payload(f))).toHaveLength(1);
      expect(added.some((e) => e.kind === "bundle")).toBe(false);
      for (const e of added.filter((x) => x.kind === "transcript" || x.kind === "reused"))
        expect(e.source_removed_at).toBeTruthy();
      // A second reopen restores the reused copies again.
      reopen(f);
      const c = onArchiver(f);
      await c.beforeBirth(f.pr);
      c.stop();
      for (const rel of f.transcripts)
        expect(readFileSync(join(f.root, rel)).equals(f.bytes.get(rel)!), rel).toBe(true);
    },
  );
});

describe("a restore cut short, then a re-close: nothing is compressed twice (rehearsal 2026-10-08)", () => {
  const reclose = async (f: PrFixture, steps: string[], logs: string[] = []): Promise<void> => {
    f.store.db.prepare("UPDATE pr_state SET state = 'closed' WHERE number = ?").run(f.pr);
    f.store.logEvent("pr_closed", f.pr, { merged: true });
    f.clock.ms = T0 + 15 * DAY;
    const b = onArchiver(
      f,
      {},
      {
        step: (name, info) => {
          if (typeof info.src === "string") steps.push(`${name} ${info.src}`);
        },
        log: (m) => logs.push(m),
      },
    );
    await b.tick();
    b.stop();
    expect(archiveRow(f.store, f.pr)?.state).toBe("archived");
  };
  const gzNames = (f: PrFixture): string[] =>
    filesUnder(join(f.root, "archive", `pr-${f.pr}`, "transcripts")).filter((n) =>
      n.endsWith(".gz"),
    );

  it(
    "files an interrupted restore put back are recorded by the pass that completes it — the re-archive reuses them, no transcript is read into a gzip again",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = await archived();
      reopen(f);
      const deps = {
        store: f.store,
        root: f.root,
        sessionsRoot: join(f.root, "state", "pi-sessions"),
        now: () => new Date(f.clock.ms),
        bytesPerS: 1e9,
        log: () => {},
      };
      // Killed after two files landed: no restore entry, no row update.
      let n = 0;
      await expect(
        restorePr(
          {
            ...deps,
            step: (name) => {
              if (name === "restored_file" && ++n === 2) throw new Error("killed");
            },
          },
          f.pr,
          "reopen",
        ),
      ).rejects.toThrow("killed");
      const landed = f.transcripts.filter((t) => existsSync(join(f.root, t)));
      expect(landed.length).toBe(2);
      const again = await restorePr(deps, f.pr, "reopen");
      expect(again).toMatchObject({ outcome: "restored", present: 2, restored: 2 });
      // The restore entry carries the files found back, with their NEW inodes.
      const restore = manifestOf(f)
        .entries.filter((e) => e.kind === "restore")
        .pop()!;
      const restored = restore.restored as Array<Record<string, unknown>>;
      for (const t of landed)
        expect(restored.find((r) => r.source === t)).toMatchObject({
          present: true,
          ino: statSync(join(f.root, t)).ino,
        });
      expect(restore.files).toBe(2);
      // Re-closed, past the window: every transcript is reused, none read
      // into a .partial, and there is no second gzip of any.
      const before = gzNames(f);
      const steps: string[] = [];
      await reclose(f, steps);
      expect(steps.filter((x) => x.startsWith("partial_written"))).toEqual([]);
      expect(gzNames(f)).toEqual(before);
      const added = manifestOf(f).entries.filter(
        (e) => e.kind === "transcript" && e.reused === true,
      );
      expect(added.map((e) => e.source).sort()).toEqual([...f.transcripts].sort());
      for (const t of f.transcripts) expect(existsSync(join(f.root, t))).toBe(false);
    },
  );

  it(
    "the belt: a transcript whose inode changed with its bytes unchanged (a tree copy) is compressed, found equal to its archived copy, and its new gzip dropped for a reused entry",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = await archived();
      reopen(f);
      const a = onArchiver(f);
      await a.beforeBirth(f.pr);
      a.stop();
      // A copy of the tree: same bytes, same mtime, a new inode. The copy is
      // made while the original still holds its inode, then renamed over it,
      // so the filesystem cannot hand the old inode number back.
      const t = f.transcripts[1]!;
      const p = join(f.root, t);
      const bytes = readFileSync(p);
      const { ino, mtime } = statSync(p);
      const copy = `${p}.copy`;
      writeFileSync(copy, bytes);
      utimesSync(copy, mtime, mtime);
      renameSync(copy, p);
      expect(statSync(p).ino).not.toBe(ino);
      const before = gzNames(f);
      const logs: string[] = [];
      await reclose(f, [], logs);
      // No .v2: one gzip per transcript, as before.
      expect(gzNames(f)).toEqual(before);
      expect(gzNames(f).some((n) => /\.v\d+\.gz$/.test(n))).toBe(false);
      const base = `transcripts/${t.slice(`state/pi-sessions/pr-${f.pr}/`.length)}.gz`;
      const mine = manifestOf(f).entries.filter((e) => e.kind === "transcript" && e.source === t);
      expect(mine.at(-1)).toMatchObject({ reused: true, archive: base, ino: expect.any(Number) });
      expect(mine.at(-1)!.source_removed_at).toBeTruthy();
      expect(logs.some((l) => /holds the bytes .* already does: reused/.test(l))).toBe(true);
      expect(existsSync(p)).toBe(false);
      // The row counts the archive's files once.
      expect(archiveRow(f.store, f.pr)).toMatchObject({ transcript_files: 3 });
    },
  );
});

describe("a restore has priority over a running pass (§8.3)", () => {
  it("the strict mutex serves a priority waiter before every ordinary one", async () => {
    const m = new StrictMutex();
    const order: string[] = [];
    const first = await m.acquire();
    const plain = m.acquire().then((r) => {
      order.push("plain");
      r();
    });
    const urgent = m.acquire(true).then((r) => {
      order.push("priority");
      r();
    });
    expect(m.priorityWaiting()).toBe(true);
    first();
    await Promise.all([plain, urgent]);
    expect(order).toEqual(["priority", "plain"]);
    expect(m.held()).toBe(false);
    expect(m.priorityWaiting()).toBe(false);
  });

  it(
    "a reopen during the PR's own pass: the pass yields at the next file, unlinks nothing, and the restore runs first",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = prFixture();
      open.push(f);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let held = false;
      let reached!: () => void;
      const atStep = new Promise<void>((r) => (reached = r));
      const a = onArchiver(
        f,
        {},
        {
          step: async (name, info) => {
            if (!held && name === "renamed" && info.src !== undefined) {
              held = true;
              reached();
              await gate;
            }
          },
        },
      );
      try {
        const tick = a.tick();
        await atStep;
        // The PR is reopened mid-pass and a birth asks for its restore.
        reopen(f);
        let born = false;
        const birth = a.beforeBirth(f.pr).then(() => (born = true));
        await new Promise((r) => setImmediate(r));
        expect(born).toBe(false);
        release();
        expect((await tick).state).toBe("idle");
        await birth;
        expect(born).toBe(true);
        // Nothing of the PR left the live tree; the restore settled the row.
        for (const rel of [...f.transcripts, ...f.small])
          expect(existsSync(join(f.root, rel)), rel).toBe(true);
        expect(archiveRow(f.store, f.pr)?.state).toBe("restored");
      } finally {
        a.stop();
      }
    },
  );
});

describe("the tick's restores yield to a priority restore (§8.3)", () => {
  it(
    "a birth's restore queued during the tick's restores runs next; the remaining reopened PRs wait for the next tick",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = await archived();
      reopen(f);
      // Two more reopened PRs whose passes armed the guard and moved nothing.
      for (const pr of [f.pr + 1, f.pr + 2]) {
        f.store.upsertPr({
          number: pr,
          state: "tracked",
          head_sha: "abc",
          title: `pr ${pr}`,
          author: "a",
          trigger_ts: null,
          stale_recheck: 0,
          migration_gate: 0,
        });
        f.store.db
          .prepare(
            "INSERT INTO archive_prs (pr, state, max_mtime_ms, updated_at) VALUES (?, 'archiving', 0, ?)",
          )
          .run(pr, new Date(T0).toISOString());
      }
      let birth = null as Promise<void> | null;
      const a = onArchiver(
        f,
        {},
        {
          step: async (name) => {
            // During the tick's first restore, a birth asks for the last PR's.
            if (name === "restored_file" && birth === null) birth = a.beforeBirth(f.pr + 2);
          },
        },
      );
      try {
        const tick = await a.tick();
        await birth;
        expect(tick.state).toBe("idle");
        const order = (
          f.store.db
            .prepare("SELECT pr FROM events WHERE kind = 'archive_pr_restored' ORDER BY id")
            .all() as Array<{ pr: number }>
        ).map((r) => r.pr);
        expect(order).toEqual([f.pr, f.pr + 2]);
        expect(archiveRow(f.store, f.pr + 1)?.state).toBe("archiving");
      } finally {
        a.stop();
      }
    },
  );
});

describe("the birth awaits the restore, and wire.ts connects it", () => {
  it("wire.ts hands the worker host the archiver's beforeBirth, and the birth awaits it", () => {
    const src = join(import.meta.dirname, "..", "src");
    const wire = readFileSync(join(src, "wire.ts"), "utf8");
    expect(wire).toMatch(/workerWorld\.host\.setBeforeBirth\(\(pr\) => archiveRef\.beforeBirth\(pr\)\);/);
    const lifecycle = readFileSync(join(src, "pr-session-lifecycle.ts"), "utf8");
    const birth = lifecycle.slice(lifecycle.indexOf("private async birth("));
    expect(birth.slice(0, birth.indexOf("\n  }\n"))).toMatch(
      /^[\s\S]{0,200}await this\.awaitBeforeBirth\(pr\);/,
    );
  });
});
