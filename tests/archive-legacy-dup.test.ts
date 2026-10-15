// The legacy `archive/pr-<n>/session.jsonl` copies (docs/
// archiving.md §7.5, acceptance 7). `archiveSession` copied the newest JSONL
// there at close — before the tmux kill, so it can be a strict byte-prefix of
// the transcript. Once that transcript is archived and verified, a copy equal
// to it, or to a prefix of it, is a PROVEN duplicate: removed, with a
// `duplicate_removed` manifest entry. Anything else is gzipped and kept.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { archiveRow } from "../src/archive/rows.js";
import {
  manifestOf,
  onArchiver,
  prFixture,
  put,
  reopen,
  sha,
  type PrFixture,
} from "./helpers/archive-pr.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const open: PrFixture[] = [];
afterEach(() => {
  for (const f of open.splice(0)) f.close();
});

/** The fixture with its transcripts, then a legacy copy made of `legacy`. */
function withLegacy(
  legacy: (f: PrFixture) => Buffer | string,
  prep?: (f: PrFixture) => void,
): PrFixture {
  const f = prFixture();
  open.push(f);
  prep?.(f);
  put(f.root, `archive/pr-${f.pr}/session.jsonl`, legacy(f));
  return f;
}

const gzName = (f: PrFixture, i: number): string =>
  `transcripts/${f.transcripts[i]!.slice(`state/pi-sessions/pr-${f.pr}/`.length)}.gz`;
const legacyPath = (f: PrFixture): string => join(f.root, "archive", `pr-${f.pr}`, "session.jsonl");
const marks = (f: PrFixture): number =>
  Number(
    (
      f.store.db
        .prepare("SELECT value FROM archive_marks WHERE name = 'duplicates.removed'")
        .get() as { value: number } | undefined
    )?.value ?? 0,
  );

async function tick(f: PrFixture): Promise<ReturnType<ReturnType<typeof onArchiver>["status"]>> {
  const a = onArchiver(f);
  try {
    await a.tick();
    return a.status();
  } finally {
    a.stop();
  }
}

describe("legacy session.jsonl (acceptance 7)", () => {
  it(
    "equal to the transcript meta.json names: removed, a duplicate_removed entry (exact)",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = withLegacy((x) => x.bytes.get(x.transcripts[1]!)!);
      const legacyBytes = readFileSync(legacyPath(f));
      const status = await tick(f);
      expect(existsSync(legacyPath(f))).toBe(false);
      const dup = manifestOf(f).entries.find((e) => e.kind === "duplicate_removed")!;
      expect(dup).toMatchObject({
        path: "session.jsonl",
        match: "exact",
        duplicate_of: gzName(f, 1),
        bytes: legacyBytes.length,
        sha256: sha(legacyBytes),
      });
      // …and the bytes really are in the archive.
      expect(
        gunzipSync(readFileSync(join(f.root, "archive", `pr-${f.pr}`, gzName(f, 1)))).equals(
          legacyBytes,
        ),
      ).toBe(true);
      expect(marks(f)).toBe(1);
      expect(status.totals?.duplicates_removed).toBe(1);
      expect(status.files?.duplicates_removed).toBe(1);
      expect(archiveRow(f.store, f.pr)?.state).toBe("archived");
    },
  );

  it(
    "a byte-PREFIX of it (copied before the tmux kill): removed, match prefix",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = withLegacy((x) => {
        const b = x.bytes.get(x.transcripts[1]!)!;
        return b.subarray(0, Math.floor(b.length / 2) + 3);
      });
      const legacyBytes = readFileSync(legacyPath(f));
      await tick(f);
      expect(existsSync(legacyPath(f))).toBe(false);
      const dup = manifestOf(f).entries.find((e) => e.kind === "duplicate_removed")!;
      expect(dup).toMatchObject({
        match: "prefix",
        duplicate_of: gzName(f, 1),
        bytes: legacyBytes.length,
      });
      // Rebuildable: `zcat … | head -c N`.
      const whole = gunzipSync(readFileSync(join(f.root, "archive", `pr-${f.pr}`, gzName(f, 1))));
      expect(whole.subarray(0, legacyBytes.length).equals(legacyBytes)).toBe(true);
    },
  );

  it(
    "a copy that matches nothing is kept — gzipped as session-at-close, never removed unverified",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = withLegacy(
        () => '{"type":"message","text":"a copy of a file nobody has any more"}\n',
      );
      const legacyBytes = readFileSync(legacyPath(f));
      await tick(f);
      expect(existsSync(legacyPath(f))).toBe(false);
      const m = manifestOf(f);
      expect(m.entries.some((e) => e.kind === "duplicate_removed")).toBe(false);
      const kept = m.entries.find((e) => e.kind === "transcript" && e.legacy === true)!;
      expect(kept.source).toBe(`archive/pr-${f.pr}/session.jsonl`);
      expect(kept.archive).toMatch(/^transcripts\/session-at-close-\d{8}T\d{6}Z\.jsonl\.gz$/);
      expect(kept.source_removed_at).toBeTruthy();
      expect(
        gunzipSync(
          readFileSync(join(f.root, "archive", `pr-${f.pr}`, kept.archive as string)),
        ).equals(legacyBytes),
      ).toBe(true);
      expect(marks(f)).toBe(0);
      // A legacy copy is never restored to a live path.
      reopen(f);
      const a = onArchiver(f);
      await a.beforeBirth(f.pr);
      a.stop();
      expect(existsSync(legacyPath(f))).toBe(false);
      expect(archiveRow(f.store, f.pr)?.state).toBe("restored");
    },
  );

  it(
    "with no meta.json the NEWEST transcript is the one it is checked against",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = withLegacy(
        (x) => x.bytes.get(x.transcripts[2]!)!,
        (x) => rmSync(join(x.root, "archive", `pr-${x.pr}`, "meta.json")),
      );
      await tick(f);
      expect(manifestOf(f).entries.find((e) => e.kind === "duplicate_removed")).toMatchObject({
        match: "exact",
        duplicate_of: gzName(f, 2),
      });
    },
  );

  it(
    "…and a copy of an OLDER transcript is then not proven a duplicate: kept as a gzip",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = withLegacy(
        (x) => x.bytes.get(x.transcripts[0]!)!,
        (x) => rmSync(join(x.root, "archive", `pr-${x.pr}`, "meta.json")),
      );
      await tick(f);
      const m = manifestOf(f);
      expect(m.entries.some((e) => e.kind === "duplicate_removed")).toBe(false);
      expect(m.entries.some((e) => e.kind === "transcript" && e.legacy === true)).toBe(true);
    },
  );

  it(
    "meta.json naming the source under another root (the container's path) is matched by file name",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = withLegacy(
        (x) => x.bytes.get(x.transcripts[1]!)!,
        (x) =>
          put(
            x.root,
            `archive/pr-${x.pr}/meta.json`,
            JSON.stringify({
              session: `pr-${x.pr}`,
              archived_at: "2026-10-06T12:00:00.000Z",
              session_file: `/opt/quickreview/${x.transcripts[1]!}`,
            }),
          ),
      );
      await tick(f);
      expect(manifestOf(f).entries.find((e) => e.kind === "duplicate_removed")).toMatchObject({
        match: "exact",
        duplicate_of: gzName(f, 1),
      });
    },
  );

  // The duplicate's record is committed BEFORE its unlink: nothing after the
  // unlink could rebuild it (the copy is gone), so a crash on either side of
  // the unlink still leaves exactly one record and one count.
  for (const at of ["duplicate_recorded", "duplicate_unlinked"])
    it(
      `a crash at ${at}: the next pass converges on ONE duplicate_removed entry, counted once`,
      { timeout: HEAVY_TIMEOUT_MS },
      async () => {
        const f = withLegacy((x) => x.bytes.get(x.transcripts[1]!)!);
        const legacyBytes = readFileSync(legacyPath(f));
        let crashed = false;
        const first = onArchiver(
          f,
          {},
          {
            step: (name) => {
              if (crashed || name !== at) return;
              crashed = true;
              throw new Error(`crash at ${name}`);
            },
          },
        );
        await first.tick();
        first.stop();
        expect(crashed).toBe(true);
        expect(existsSync(legacyPath(f))).toBe(at === "duplicate_recorded");
        await tick(f);
        expect(existsSync(legacyPath(f))).toBe(false);
        const dups = manifestOf(f).entries.filter((e) => e.kind === "duplicate_removed");
        expect(dups).toHaveLength(1);
        expect(dups[0]).toMatchObject({
          match: "exact",
          duplicate_of: gzName(f, 1),
          bytes: legacyBytes.length,
          sha256: sha(legacyBytes),
        });
        expect(marks(f)).toBe(1);
        expect(archiveRow(f.store, f.pr)?.state).toBe("archived");
      },
    );
});
