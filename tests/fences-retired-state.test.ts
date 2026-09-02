// audit assertion #10: the retired-state sweep over `src/`.
//
// The audit proposed `expect(grepProduction("awaiting_human")).toEqual(
// [reconcileMigrationPath])` — the park is retired, nothing
// transitions into `awaiting_human`, and reconcile's migration of legacy rows
// is meant to be its one remaining reader.
//
// It is not. Thirty-one mentions survive across eleven modules: a metrics count
// that is structurally always zero and reported as a measurement, a digest
// panel that renders permanently empty, a Slack cause that TELLS an operator a
// PR is parked, a theme colour, two config knobs. That is MC-11/12/13 and
// [A1]/[B1]-[B4]/[D1]-[D3], and removing them is.
//
// So this fence does not assert the end state — it PINS THE CURRENT SURFACE by
// exact count, per file. Which makes it two useful things at once:
//
//   * a ratchet: a new `awaiting_human` reader anywhere fails here;
//   * and's checklist, which goes red the moment that ticket starts
//     and names, file by file, exactly what is left. Landing order is
//     → →, so this is red BY DESIGN on that merge,
//     and the fix is to edit the numbers down to zero as the surfaces go.
//
// [T3] in tests/fences.test.ts covers the union member itself; this covers the
// readers, which is where the findings actually live.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? tsFiles(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );
}

describe("[#10] the retired park's readers are counted, not assumed gone", () => {
  /**
   * file → mentions, and what they are. Counts include comments deliberately:
   * a comment that describes the park as live is MC-43-class stale prose and
   * is part of what removes, so hiding it would understate the job.
   *
   * MUTATION: add one `awaiting_human` reference to any listed file, or to a
   * file not listed — either fails, naming the file and both counts.
   */
  const PARK_READERS: ReadonlyArray<{ file: string; n: number; what: string }> = [
    {
      file: "src/reconcile.ts",
      n: 9,
      what: "the ONE legitimate reader: migrating legacy rows out of the retired state, and logging each one. Survives.",
    },
    { file: "src/slack/messages.ts", n: 4, what: "MC-12 — live operator-facing text asserting a handover that cannot happen." },
    { file: "src/config.ts", n: 4, what: "the `awaiting_human_stale` Slack cause and its `_h` knob — parsed, disabled by default, inert." },
    { file: "src/tui/theme.ts", n: 3, what: "a colour for a state nothing can enter." },
    { file: "src/tui/model.ts", n: 3, what: "board model plumbing for the dead state." },
    { file: "src/tui/metricstab.ts", n: 2, what: "the `⚑ n awaiting you` stat — [D2], structurally always zero." },
    { file: "src/metrics.ts", n: 2, what: "MC-11 — an `awaitingYou` count reported as a measurement and structurally always zero." },
    { file: "src/types.ts", n: 1, what: "MC-43 — the `Verdict` doc comment still describing the park." },
    { file: "src/state.ts", n: 1, what: "the `PrLifecycleState` union member itself — [T3] in fences.test.ts owns this one." },
    { file: "src/statemachine.ts", n: 1, what: "the transition table's comment recording that nothing returns it." },
    { file: "src/slack/announce.ts", n: 1, what: "the announce path's cause plumbing for the dead Slack cause." },
  ];

  it("no module reads awaiting_human that is not on the record, and none reads it more often", () => {
    const found = new Map<string, number>();
    for (const f of tsFiles(join(ROOT, "src"))) {
      const n = (readFileSync(f, "utf8").match(/awaiting_human/g) ?? []).length;
      if (n > 0) found.set(relative(ROOT, f), n);
    }
    expect(found.size, "no mention found at all — the scan broke and this asserts nothing").toBeGreaterThan(0);
    for (const r of PARK_READERS) expect(r.what.length, `${r.file} needs a description`).toBeGreaterThan(20);

    const actual = [...found.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([f, n]) => `${f}:${n}`);
    const recorded = PARK_READERS.slice()
      .sort((a, b) => a.file.localeCompare(b.file))
      .map((r) => `${r.file}:${r.n}`);

    expect(
      actual,
      "the awaiting_human surface changed. GROWN means a new reader of a state nothing can enter — do not add one. "
        + "SHRUNK means is doing its work: edit the counts down (and delete the entry at zero); when the list "
        + "is empty, replace it with `expect(actual).toEqual([])` and delete this record.",
    ).toEqual(recorded);
  });

  it("the total is the number the audit will be measured against", () => {
    const total = tsFiles(join(ROOT, "src")).reduce(
      (n, f) => n + (readFileSync(f, "utf8").match(/awaiting_human/g) ?? []).length,
      0,
    );
    expect(total, "thirty-one mentions across eleven modules, for a state nothing can transition into").toBe(31);
  });
});
