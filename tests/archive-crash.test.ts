// The per-file protocol under crash injection and interference
// (docs/archiving.md §7.3, §7.4, §7.6):
//
//   (3) a crash after each step — a partial written, a gzip renamed, a
//       manifest entry appended, k of n unlinks done — for a transcript and
//       for the bundle: the next start converges with no lost byte, no
//       duplicate gzip and no orphaned `.partial`;
//   (4) a byte flipped in the `.partial` (a transcript's or the bundle's)
//       keeps the source and counts a verify failure; a source appended to
//       mid-copy — or changed after its copy was recorded, right before its
//       unlink — is kept and archived as a new entry by the next pass; a
//       registry flip to tracked, a tmux session come alive or a wake dropped
//       before the unlink phase means zero unlinks.
//
// Plus the orphans (§7.6): a gzip renamed into place with no entry is adopted
// when it holds the source's bytes, kept under its own entry when it holds an
// earlier version, and redone only when it does not decompress — under its
// base name or a `.v<k>` one alike.
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { PLAN_REFRESH_MS } from "../src/archive/archiver.js";
import { archiveRow } from "../src/archive/rows.js";
import {
  T0,
  filesUnder,
  line,
  lostBytes,
  manifestOf,
  onArchiver,
  prFixture,
  put,
  type PrFixture,
} from "./helpers/archive-pr.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const open: PrFixture[] = [];
afterEach(() => {
  for (const f of open.splice(0)) f.close();
});
const fixture = (): PrFixture => {
  const f = prFixture();
  open.push(f);
  return f;
};

class Crash extends Error {}

/** A step seam that "kills the process" at the `nth` step matching `when`. */
function crashAt(
  when: (name: string, info: Record<string, unknown>) => boolean,
  nth = 1,
): (name: string, info: Record<string, unknown>) => void {
  let seen = 0;
  let fired = false;
  return (name, info) => {
    if (fired || !when(name, info)) return;
    seen += 1;
    if (seen === nth) {
      fired = true;
      throw new Crash(`crash at ${name}`);
    }
  };
}

const transcriptGzips = (f: PrFixture): string[] =>
  filesUnder(join(f.root, "archive", `pr-${f.pr}`, "transcripts")).filter((n) => n.endsWith(".gz"));
const bundles = (f: PrFixture): string[] =>
  readdirSync(join(f.root, "archive", `pr-${f.pr}`)).filter((n) => /^state-.+\.jsonl\.gz$/.test(n));
const partials = (f: PrFixture): string[] =>
  filesUnder(f.root).filter((p) => p.endsWith(".partial"));

async function crashThenRestart(
  f: PrFixture,
  step: ReturnType<typeof crashAt>,
): Promise<{ logs: string[] }> {
  const logs: string[] = [];
  const first = onArchiver(f, {}, { step, log: (m) => logs.push(m) });
  await first.tick();
  first.stop();
  // Nothing of value was lost at the crash point.
  expect(lostBytes(f)).toEqual([]);
  expect(logs.some((l) => /pass failed/.test(l))).toBe(true);
  expect(archiveRow(f.store, f.pr)?.state).toBe("archiving");
  // The next daemon start: recovery, then the PR's pass again.
  const second = onArchiver(f);
  await second.tick();
  second.stop();
  return { logs };
}

function converged(f: PrFixture): void {
  expect(lostBytes(f)).toEqual([]);
  expect(partials(f)).toEqual([]);
  expect(transcriptGzips(f)).toHaveLength(3);
  expect(bundles(f)).toHaveLength(1);
  for (const rel of [...f.transcripts, ...f.small])
    expect(existsSync(join(f.root, rel)), rel).toBe(false);
  const entries = manifestOf(f).entries;
  expect(entries.filter((e) => e.kind === "transcript")).toHaveLength(3);
  expect(entries.filter((e) => e.kind === "bundle")).toHaveLength(1);
  expect(new Set(entries.filter((e) => e.kind === "transcript").map((e) => e.source)).size).toBe(3);
  // Every removal is on the record — the ones a crashed run made included.
  for (const e of entries.filter((x) => x.kind === "transcript"))
    expect(e.source_removed_at).toBeTruthy();
  const bundle = entries.find((e) => e.kind === "bundle")!;
  expect(bundle.sources_removed_at).toBeTruthy();
  expect(bundle.kept).toBeUndefined();
  expect(entries.filter((e) => e.kind === "sources_removed")).toEqual([]);
  expect(archiveRow(f.store, f.pr)?.state).toBe("archived");
  // The row counts what the archive holds — the files the crashed run
  // archived (and the next pass only reused) included, so a PR converged
  // after a kill never reads 0 files and 0 bytes.
  const gz = entries
    .filter((e) => e.kind === "transcript")
    .reduce((n, e) => n + (e.gz_bytes as number), 0);
  expect(archiveRow(f.store, f.pr)).toMatchObject({
    transcript_files: 3,
    state_files: f.small.length,
    bytes_in:
      f.transcripts.reduce((n, t) => n + f.bytes.get(t)!.length, 0) + (bundle.bytes as number),
    bytes_out: gz + (bundle.gz_bytes as number),
  });
}

describe("crash injection — the next start converges (acceptance 3)", () => {
  const cases: Array<[string, ReturnType<typeof crashAt> | (() => ReturnType<typeof crashAt>)]> = [
    [
      "a transcript's partial written",
      () => crashAt((n, i) => n === "partial_written" && i.src !== undefined),
    ],
    [
      "a transcript's gzip renamed (no entry yet)",
      () => crashAt((n, i) => n === "renamed" && i.src !== undefined),
    ],
    [
      "a transcript's manifest entry appended",
      () => crashAt((n, i) => n === "manifest_appended" && i.source !== undefined),
    ],
    [
      "the bundle's partial written",
      () => crashAt((n, i) => n === "partial_written" && i.src === undefined),
    ],
    [
      "the bundle renamed (no entry yet)",
      () => crashAt((n, i) => n === "renamed" && i.src === undefined),
    ],
    [
      "the bundle's manifest entry appended",
      () => crashAt((n, i) => n === "manifest_appended" && i.bundle !== undefined),
    ],
    ["1 of n unlinks done", () => crashAt((n) => n === "unlinked", 1)],
    ["5 of n unlinks done", () => crashAt((n) => n === "unlinked", 5)],
  ];
  for (const [name, make] of cases)
    it(`after ${name}`, { timeout: HEAVY_TIMEOUT_MS }, async () => {
      const f = fixture();
      await crashThenRestart(f, (make as () => ReturnType<typeof crashAt>)());
      converged(f);
    });

  it("an orphan gzip is ADOPTED, not compressed again", { timeout: HEAVY_TIMEOUT_MS }, async () => {
    const f = fixture();
    let placed: { ino: number; mtimeMs: number } | null = null;
    const step = crashAt((n, i) => {
      if (n === "renamed" && i.src !== undefined && !placed) {
        const st = statSync(i.dest as string);
        placed = { ino: st.ino, mtimeMs: st.mtimeMs };
        return true;
      }
      return false;
    });
    const logs: string[] = [];
    const first = onArchiver(f, {}, { step });
    await first.tick();
    first.stop();
    const second = onArchiver(f, {}, { log: (m) => logs.push(m) });
    await second.tick();
    second.stop();
    converged(f);
    const gz = join(
      f.root,
      "archive",
      `pr-${f.pr}`,
      "transcripts",
      `${f.transcripts[0]!.split("/").pop()}.gz`,
    );
    expect(statSync(gz).ino).toBe(placed!.ino);
    expect(logs.some((l) => /adopted the orphan gzip/.test(l))).toBe(true);
  });

  it(
    "an orphan gzip that decompresses to OTHER bytes is never adopted as the source's copy: kept under its own entry, the source archived anew",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = fixture();
      const t0 = f.transcripts[0]!;
      const other = Buffer.from(line("an earlier version of this transcript"));
      const step = crashAt((n, i) => {
        if (n !== "renamed" || i.src !== join(f.root, t0)) return false;
        writeFileSync(i.dest as string, gzipSync(other));
        return true;
      });
      const first = onArchiver(f, {}, { step });
      await first.tick();
      first.stop();
      const logs: string[] = [];
      const second = onArchiver(f, {}, { log: (m) => logs.push(m) });
      await second.tick();
      second.stop();
      expect(logs.some((l) => /adopted the orphan gzip/.test(l))).toBe(false);
      expect(logs.some((l) => /holds an earlier version/.test(l))).toBe(true);
      const dir = join(f.root, "archive", `pr-${f.pr}`);
      const entries = manifestOf(f).entries.filter(
        (e) => e.kind === "transcript" && e.source === t0,
      );
      // The orphan, kept: its own bytes, no live identity.
      expect(entries[0]).toMatchObject({ adopted: true, dev: null, ino: null });
      expect(gunzipSync(readFileSync(join(dir, entries[0]!.archive as string))).equals(other)).toBe(
        true,
      );
      // The source's own copy, under the next name — the original bytes.
      const latest = entries[entries.length - 1]!;
      expect(latest.archive).toMatch(/\.v2\.gz$/);
      expect(
        gunzipSync(readFileSync(join(dir, latest.archive as string))).equals(f.bytes.get(t0)!),
      ).toBe(true);
      expect(existsSync(join(f.root, t0))).toBe(false);
      // Every gzip on disk is referenced; nothing is orphaned or partial.
      const referenced = new Set(manifestOf(f).entries.map((e) => e.archive as string));
      for (const gz of transcriptGzips(f))
        expect(referenced.has(`transcripts/${gz}`), gz).toBe(true);
      expect(partials(f)).toEqual([]);
      expect(archiveRow(f.store, f.pr)?.state).toBe("archived");
    },
  );

  it(
    "an orphan gzip that does not even decompress is removed and the file archived again",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = fixture();
      const step = crashAt((n, i) => {
        if (n !== "renamed" || i.src !== join(f.root, f.transcripts[0]!)) return false;
        writeFileSync(i.dest as string, "not a gzip at all");
        return true;
      });
      const first = onArchiver(f, {}, { step });
      await first.tick();
      first.stop();
      const second = onArchiver(f);
      await second.tick();
      second.stop();
      converged(f);
    },
  );

  it(
    "a crash after a VERSIONED gzip's rename: the next pass adopts that orphan — no second copy under the next name",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = fixture();
      // Pass 1 stops after the first transcript's entry (its source kept).
      const first = onArchiver(
        f,
        {},
        { step: crashAt((n, i) => n === "manifest_appended" && i.source !== undefined) },
      );
      await first.tick();
      first.stop();
      // The transcripts grow (their archived copy is now an older version).
      const more = line("appended after the first copy");
      for (const rel of f.transcripts) appendFileSync(join(f.root, rel), more);
      const grown = new Map(f.transcripts.map((rel) => [rel, readFileSync(join(f.root, rel))]));
      // Pass 2 crashes right after the new version's gzip is renamed into
      // place under its `.v2` name, before its entry.
      const second = onArchiver(
        f,
        {},
        { step: crashAt((n, i) => n === "renamed" && String(i.dest).endsWith(".v2.gz")) },
      );
      await second.tick();
      second.stop();
      const logs: string[] = [];
      const third = onArchiver(f, {}, { log: (m) => logs.push(m) });
      await third.tick();
      third.stop();
      expect(logs.some((l) => /adopted the orphan gzip transcripts\/.*\.v2\.gz/.test(l))).toBe(
        true,
      );
      const dir = join(f.root, "archive", `pr-${f.pr}`);
      const referenced = new Set(manifestOf(f).entries.map((e) => e.archive as string));
      const gzs = transcriptGzips(f);
      for (const gz of gzs) expect(referenced.has(`transcripts/${gz}`), gz).toBe(true);
      expect(gzs.filter((g) => g.includes(".v3."))).toEqual([]);
      const t0 = f.transcripts[0]!;
      const name = t0.slice(`state/pi-sessions/pr-${f.pr}/`.length);
      expect(
        gunzipSync(readFileSync(join(dir, "transcripts", `${name}.gz`))).equals(f.bytes.get(t0)!),
      ).toBe(true);
      expect(
        gunzipSync(
          readFileSync(join(dir, "transcripts", name.replace(/\.jsonl$/, ".jsonl.v2.gz"))),
        ).equals(grown.get(t0)!),
      ).toBe(true);
      for (const rel of f.transcripts) expect(existsSync(join(f.root, rel)), rel).toBe(false);
      expect(partials(f)).toEqual([]);
      expect(archiveRow(f.store, f.pr)?.state).toBe("archived");
    },
  );

  it(
    "a stray .partial a crash left is deleted at the next start, before any new work",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = fixture();
      const first = onArchiver(f, {}, { step: crashAt((n) => n === "partial_written") });
      await first.tick();
      first.stop();
      expect(partials(f).length).toBeGreaterThan(0);
      const second = onArchiver(f);
      await second.tick();
      second.stop();
      expect(partials(f)).toEqual([]);
    },
  );
});

describe("interference (acceptance 4)", () => {
  it(
    "a byte flipped in the .partial keeps the source and counts a verify failure",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = fixture();
      const target = f.transcripts[0]!;
      const a = onArchiver(
        f,
        {},
        {
          step: (name, info) => {
            if (name !== "partial_written" || info.src !== join(f.root, target)) return;
            const p = info.partial as string;
            const buf = readFileSync(p);
            buf[Math.floor(buf.length / 2)] = buf[Math.floor(buf.length / 2)]! ^ 0xff;
            writeFileSync(p, buf);
          },
        },
      );
      try {
        await a.tick();
        expect(readFileSync(join(f.root, target)).equals(f.bytes.get(target)!)).toBe(true);
        expect(a.status().verify_failures_24h).toBe(1);
        expect(a.status().files).toMatchObject({
          verify_failures: 1,
          prs_archived: 0,
          prs_partial: 1,
        });
        expect(f.store.anomalies().map((x) => x.kind)).toContain("archive_verify_failed");
        expect(archiveRow(f.store, f.pr)?.state).toBe("archiving");
        expect(partials(f)).toEqual([]);
        // The other files moved; nothing was lost.
        expect(lostBytes(f)).toEqual([]);
        expect(existsSync(join(f.root, f.transcripts[1]!))).toBe(false);
      } finally {
        a.stop();
      }
    },
  );

  it(
    "a byte flipped in the BUNDLE's .partial keeps every small source and counts a verify failure",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = fixture();
      const a = onArchiver(
        f,
        {},
        {
          step: (name, info) => {
            if (name !== "partial_written" || info.src !== undefined) return;
            const p = info.partial as string;
            const buf = readFileSync(p);
            buf[Math.floor(buf.length / 2)] = buf[Math.floor(buf.length / 2)]! ^ 0xff;
            writeFileSync(p, buf);
          },
        },
      );
      try {
        await a.tick();
        for (const rel of f.small)
          expect(readFileSync(join(f.root, rel)).equals(f.bytes.get(rel)!), rel).toBe(true);
        expect(bundles(f)).toEqual([]);
        expect(partials(f)).toEqual([]);
        expect(a.status().files).toMatchObject({ verify_failures: 1, prs_archived: 0 });
        expect(f.store.anomalies().map((x) => x.kind)).toContain("archive_verify_failed");
        expect(archiveRow(f.store, f.pr)?.state).toBe("archiving");
        expect(lostBytes(f)).toEqual([]);
      } finally {
        a.stop();
      }
    },
  );

  it(
    "a source that changes AFTER its copy was recorded — appended, or rewritten — is never unlinked; the next pass archives the new bytes",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = fixture();
      const t0 = f.transcripts[0]!;
      const findings = `state/findings/pr-${f.pr}-round-1.json`;
      const more = line("written after the copy");
      const rewritten = '{"file":"rewritten after the copy"}\n';
      let changed = false;
      const a = onArchiver(
        f,
        {},
        {
          step: (name) => {
            if (changed || name !== "before_unlink") return;
            changed = true;
            appendFileSync(join(f.root, t0), more);
            writeFileSync(join(f.root, findings), rewritten);
            utimesSync(join(f.root, findings), (T0 + 5000) / 1000, (T0 + 5000) / 1000);
          },
        },
      );
      try {
        await a.tick();
        const t0Now = Buffer.concat([f.bytes.get(t0)!, Buffer.from(more)]);
        expect(readFileSync(join(f.root, t0)).equals(t0Now)).toBe(true);
        expect(readFileSync(join(f.root, findings), "utf8")).toBe(rewritten);
        expect(a.status().files!.removed).toBe(f.transcripts.length + f.small.length - 2);
        // The earlier copies are still in the archive; nothing was lost.
        expect(lostBytes(f)).toEqual([]);
        // Not complete: the row stays `archiving` (the guard armed).
        expect(archiveRow(f.store, f.pr)?.state).toBe("archiving");
        // The next pass archives the NEW bytes, under new entries.
        f.clock.ms += PLAN_REFRESH_MS;
        await a.tick();
        expect(existsSync(join(f.root, t0))).toBe(false);
        expect(existsSync(join(f.root, findings))).toBe(false);
        const dir = join(f.root, "archive", `pr-${f.pr}`);
        const latest = manifestOf(f)
          .entries.filter((e) => e.kind === "transcript" && e.source === t0)
          .pop()!;
        expect(latest.archive).toMatch(/\.v2\.gz$/);
        expect(gunzipSync(readFileSync(join(dir, latest.archive as string))).equals(t0Now)).toBe(
          true,
        );
        const second = bundles(f).sort()[1]!;
        const recs = gunzipSync(readFileSync(join(dir, second)))
          .toString("utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { path: string; content?: string });
        expect(recs.find((r) => r.path === findings)?.content).toBe(rewritten);
        expect(archiveRow(f.store, f.pr)?.state).toBe("archived");
      } finally {
        a.stop();
      }
    },
  );

  it(
    "a source appended to mid-copy is kept; the next pass archives it as a new entry",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = fixture();
      const target = f.transcripts[0]!;
      const more = '{"type":"message","text":"late"}\n';
      let appended = false;
      const a = onArchiver(
        f,
        {},
        {
          step: (name, info) => {
            if (appended || name !== "partial_written" || info.src !== join(f.root, target)) return;
            appended = true;
            appendFileSync(join(f.root, target), more);
          },
        },
      );
      try {
        await a.tick();
        // Kept, with the new bytes; nothing of this PR was unlinked this pass.
        const now = Buffer.concat([f.bytes.get(target)!, Buffer.from(more)]);
        expect(readFileSync(join(f.root, target)).equals(now)).toBe(true);
        for (const rel of f.transcripts) expect(existsSync(join(f.root, rel)), rel).toBe(true);
        expect(archiveRow(f.store, f.pr)?.state).toBe("archiving");
        // The next pass (after the next plan) archives the new bytes.
        f.clock.ms += PLAN_REFRESH_MS;
        await a.tick();
        expect(existsSync(join(f.root, target))).toBe(false);
        const entry = manifestOf(f).entries.find(
          (e) => e.kind === "transcript" && e.source === target,
        )!;
        expect(entry.bytes).toBe(now.length);
        const gz = join(f.root, "archive", `pr-${f.pr}`, entry.archive as string);
        expect(gunzipSync(readFileSync(gz)).equals(now)).toBe(true);
        expect(archiveRow(f.store, f.pr)?.state).toBe("archived");
      } finally {
        a.stop();
      }
    },
  );

  it(
    "a registry flip to tracked before the unlink phase: zero unlinks",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = fixture();
      const a = onArchiver(
        f,
        {},
        {
          step: (name) => {
            if (name === "before_unlink")
              f.store.db
                .prepare("UPDATE pr_state SET state = 'tracked' WHERE number = ?")
                .run(f.pr);
          },
        },
      );
      try {
        await a.tick();
        for (const rel of [...f.transcripts, ...f.small])
          expect(readFileSync(join(f.root, rel)).equals(f.bytes.get(rel)!), rel).toBe(true);
        expect(manifestOf(f).entries.some((e) => e.source_removed_at || e.sources_removed_at)).toBe(
          false,
        );
        expect(archiveRow(f.store, f.pr)?.state).toBe("archiving");
        expect(a.status().files).toMatchObject({ prs_held: 1, removed: 0 });
        expect(a.status().held_prs!.first).toContainEqual({ pr: f.pr, reason: "not_closed" });
      } finally {
        a.stop();
      }
    },
  );

  for (const [what, reason] of [
    ["the PR's tmux session came alive", "tmux_alive"],
    ["a wake was dropped into its inject dir", "pending_inject"],
  ] as const)
    it(
      `${what} while it was being copied: the fresh outside facts before the unlinks mean zero unlinks`,
      { timeout: HEAVY_TIMEOUT_MS },
      async () => {
        const f = fixture();
        let alive = false;
        const a = onArchiver(
          f,
          {},
          {
            liveSessions: async () => (alive ? [`pr-${f.pr}`] : []),
            step: (name) => {
              if (name !== "before_unlink") return;
              if (reason === "tmux_alive") alive = true;
              else put(f.root, `inject/pr-${f.pr}/late.md`, "a wake");
            },
          },
        );
        try {
          await a.tick();
          for (const rel of [...f.transcripts, ...f.small])
            expect(readFileSync(join(f.root, rel)).equals(f.bytes.get(rel)!), rel).toBe(true);
          expect(
            manifestOf(f).entries.some((e) => e.source_removed_at || e.sources_removed_at),
          ).toBe(false);
          expect(archiveRow(f.store, f.pr)?.state).toBe("archiving");
          expect(a.status().files).toMatchObject({ removed: 0 });
          expect(a.status().held_prs!.first).toContainEqual({ pr: f.pr, reason });
        } finally {
          a.stop();
        }
      },
    );

  it(
    "…and a reopen BETWEEN two unlinks stops the rest (the synchronous re-check before each)",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = fixture();
      const a = onArchiver(
        f,
        {},
        {
          step: (name, info) => {
            if (name === "unlinked" && info.k === 2)
              f.store.db
                .prepare("UPDATE pr_state SET state = 'tracked' WHERE number = ?")
                .run(f.pr);
          },
        },
      );
      try {
        await a.tick();
        expect(a.status().files).toMatchObject({ removed: 2 });
        expect(lostBytes(f)).toEqual([]);
        // Exactly two sources left the live tree.
        const gone = [...f.transcripts, ...f.small].filter((rel) => !existsSync(join(f.root, rel)));
        expect(gone).toHaveLength(2);
        expect(archiveRow(f.store, f.pr)?.state).toBe("archiving");
      } finally {
        a.stop();
      }
    },
  );
});
