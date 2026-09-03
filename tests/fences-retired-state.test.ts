// audit assertion #10: the retired-state sweep over `src/`.
//
// The audit proposed `expect(grepProduction("awaiting_human")).toEqual(
// [reconcileMigrationPath])` — the park is retired, nothing
// transitions into `awaiting_human`, and reconcile's migration of legacy rows
// is meant to be its one remaining reader.
//
// It was not. Thirty-one mentions survived across eleven modules: a metrics
// count that is structurally always zero and reported as a measurement, a
// digest panel that renders permanently empty, a Slack cause that TELLS an
// operator a PR is parked, a theme colour, two config knobs. That is
// MC-11/12/13 and [A1]/[B1]-[B4]/[D1]-[D3], and removing them was
// LANDED. Three mentions remain and all three are TOMBSTONES: two
// comments recording what went and why, and the `RETIRED_STATES` marker that
// keeps a legacy row from an older daemon rendering blank. Not the audit's
// proposed end state (that was reconcile's migration, itself now gone), but
// the same thing it was after: nothing left that a reader could mistake for a
// live park.
//
// So this fence does not assert the end state — it PINS THE CURRENT SURFACE by
// exact count, per file. Which makes it two useful things at once:
//
//   * a ratchet: a new `awaiting_human` reader anywhere fails here;
//   * and's checklist, which went red the moment that ticket landed
//     and named, file by file, exactly what was left. Landing order was
//     → →, so it was red BY DESIGN on that merge and
//     the numbers were edited down as the surfaces went. The ratchet is what
//     the record is for now.
//
// [T3] in tests/fences.test.ts covers the union member itself; this covers the
// readers, which is where the findings actually live.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? tsFiles(join(dir, e.name))
      : e.name.endsWith(".ts")
        ? [join(dir, e.name)]
        : [],
  );
}

describe("[#10] the retired park's readers are counted, not assumed gone", () => {
  /**
   * file → mentions, and what they are. Counts include comments deliberately:
   * a comment that describes the park as live is MC-43-class stale prose and
   * was part of what removed, so hiding it would have understated the
   * job. Both survivors are the other kind — a tombstone, which says the
   * park is GONE. Keeping them counted is the point: a tombstone that quietly
   * turns back into live prose is caught here.
   *
   * MUTATION: add one `awaiting_human` reference to any listed file, or to a
   * file not listed — either fails, naming the file and both counts.
   */
  const PARK_READERS: ReadonlyArray<{ file: string; n: number; what: string }> = [
    {
      file: "src/reconcile.ts",
      n: 1,
      what: "a TOMBSTONE comment: the legacy-row migration that used to run here is gone, and it records when it last fired.",
    },
    {
      file: "src/tui/model.ts",
      n: 1,
      what: "the `RETIRED_STATES` tombstone, so a legacy row arriving from an older daemon still renders marked rather than blank.",
    },
  ];

  it("no module reads awaiting_human that is not on the record, and none reads it more often", () => {
    const found = new Map<string, number>();
    for (const f of tsFiles(join(ROOT, "src"))) {
      const n = (readFileSync(f, "utf8").match(/awaiting_human/g) ?? []).length;
      if (n > 0) found.set(relative(ROOT, f), n);
    }
    expect(
      found.size,
      "no mention found at all — the scan broke and this asserts nothing",
    ).toBeGreaterThan(0);
    for (const r of PARK_READERS)
      expect(r.what.length, `${r.file} needs a description`).toBeGreaterThan(20);

    const actual = [...found.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([f, n]) => `${f}:${n}`);
    const recorded = PARK_READERS.slice()
      .sort((a, b) => a.file.localeCompare(b.file))
      .map((r) => `${r.file}:${r.n}`);

    expect(
      actual,
      "the awaiting_human surface changed. GROWN means a new reader of a state nothing can enter — do not add one. " +
        "SHRUNK means is doing its work: edit the counts down (and delete the entry at zero); when the list " +
        "is empty, replace it with `expect(actual).toEqual([])` and delete this record.",
    ).toEqual(recorded);
  });

  it("the total is the number the audit will be measured against", () => {
    const total = tsFiles(join(ROOT, "src")).reduce(
      (n, f) => n + (readFileSync(f, "utf8").match(/awaiting_human/g) ?? []).length,
      0,
    );
    expect(
      total,
      "two mentions across two modules, both tombstones — cut 28, took the digest tab's with the old tab",
    ).toBe(2);
  });
});
