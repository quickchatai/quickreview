// [T8] — no production-dead module hides behind its own tests.
//
// Checked at module rather than symbol granularity: at symbol granularity the
// allowlist would run to hundreds of entries (pure helpers legitimately
// exercised only through their own unit tests), and an allowlist nobody reads
// teaches the reader to skim. At module granularity the set is small, and
// every entry is worth knowing about.
//
// Reachability from the real entrypoints, not "somebody imports it" — for the
// same reason [T3] uses a BFS: a dead module imported by another dead module
// looks alive, and a module whose only importer is dead is itself dead.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const ROOT = join(import.meta.dirname, "..");

/**
 * Comments removed before the import scan.
 *
 * Without this the fence would read a commented-out import as a live edge,
 * and a planted orphan plus one commented-out import line in `wire.ts`
 * would pass clean — the likeliest artefact of someone commenting an import
 * while cutting a module.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? tsFiles(join(dir, e.name))
      : e.name.endsWith(".ts")
        ? [join(dir, e.name)]
        : [],
  );
}

describe("[T8] every src/ module is reachable from a real entrypoint", () => {
  /**
   * The modules nothing in production can reach, each with what it is
   * and who drives it. Set equality both ways: a new orphan fails, and a
   * module that stops being an orphan fails too, so an entry cannot outlive
   * its reason.
   *
   * MUTATION: delete the `import … from "./severity.js"` lines that make
   * severity reachable — it appears here. Wire `posting.ts` into `wire.ts` —
   * its entry has to go.
   */
  const NOT_REACHED_FROM_PRODUCTION: ReadonlyArray<{ file: string; why: string }> = [
    {
      file: "src/posting.ts",
      why:
        "the manifesto audit's structural finding: ~950 lines of review-assembly law — the " +
        "severity-to-tag mapping's caller, anchor validation, the [check this] grammar — that execute ONLY in " +
        "tests, because sessions post through scripts/*.sh instead. The audit's sharpest sentence about it is " +
        "'the tested guard is not the enforcing guard'. Delete, wire up, or keep as the specification the shell " +
        "mirrors is the largest single question the inventory raised and has its own decision to make. Until it " +
        "does, this entry is the debt being VISIBLE rather than silent, which is the whole point of [T8].",
    },
    {
      file: "src/engine/envmap.ts",
      why:
        "the table classifying every QCR_* and OPENVIKING_* name the extensions carry (P1.2). It is read " +
        "only by tests/extension-envmap.test.ts until the SDK session builder (P2) and the extension " +
        "factories (P3) take it. Delete this entry with the first import.",
    },
    {
      file: "src/piauthcopy.ts",
      why:
        "a re-export of src/engine/auth.ts (P2.10). The scan container imports it by path " +
        "(`dist/src/piauthcopy.js`, src/scanbox.ts LOGIN_SUMMARY_SCRIPT), a driver this static scan cannot " +
        "follow. Delete it, and point the script at engine/auth.js, with the companion rebuild.",
    },
    {
      file: "src/scanauth.ts",
      why:
        "a re-export of src/engine/auth.ts (P2.10). The scan container imports it by path " +
        "(`dist/src/scanauth.js`, src/scanbox.ts SCAN_AUTH_COPY_SCRIPT), a driver this static scan cannot " +
        "follow. Delete it, and point the script at engine/auth.js, with the companion rebuild.",
    },
    {
      file: "src/reviewrendercli.ts",
      why:
        "the `[review] render_outputs` renderer's command line. Driven by scripts/render-review.sh, which a " +
        "round session runs and which execs it out of dist/ — a real driver this static scan cannot follow.",
    },
    {
      file: "src/memory/import.ts",
      why:
        "the one-time curated import. Driven by scripts/import-pi-memory.mjs, which loads it out of dist/ " +
        "at runtime — a real driver this static scan cannot follow, not an orphan.",
    },
    {
      file: "src/memory/legacy-file.ts",
      why: "the READ-ONLY reader over the archived MEMORY.md that the import above consumes. Same driver, same reason.",
    },
  ];

  it(
    "only the recorded modules are unreachable from wire.ts, cli.ts or an extension",
    { timeout: HEAVY_TIMEOUT_MS },
    () => {
      const files = tsFiles(join(ROOT, "src"));
      const importsOf = (f: string): string[] =>
        [...stripComments(readFileSync(f, "utf8")).matchAll(/["'](\.[^"']+)\.js["']/g)]
          .map((m) => join(f, "..", `${m[1]!}.ts`))
          .filter((p) => files.includes(p));

      // The roots: the two process entrypoints, the operator one-shots, and
      // whatever the pi extensions reach into. `smoke-session.ts` is a root
      // rather than an orphan because `npm run smoke:session` launches it;
      // `bench/cli.ts` because the qcr-bench sandbox image's entrypoint
      // (bench/aacr/in-container.sh) launches it; `openviking/sidecar-main.ts`
      // because the memory image's entrypoint (docker/memory/entrypoint.sh)
      // execs it out of dist/.
      const roots = [
        "src/wire.ts",
        "src/cli.ts",
        "src/smoke-session.ts",
        "src/bench/cli.ts",
        "src/openviking/sidecar-main.ts",
      ].map((p) => join(ROOT, p));
      for (const f of tsFiles(join(ROOT, "extensions"))) {
        for (const m of stripComments(readFileSync(f, "utf8")).matchAll(
          /["'](\.[^"']+)\.js["']/g,
        )) {
          const p = join(f, "..", `${m[1]!}.ts`);
          if (files.includes(p)) roots.push(p);
        }
      }
      for (const r of roots) {
        expect(
          files,
          `${relative(ROOT, r)} is named as an entrypoint but does not exist`,
        ).toContain(r);
      }

      const seen = new Set<string>();
      const queue = [...roots];
      while (queue.length > 0) {
        const f = queue.shift()!;
        if (seen.has(f)) continue;
        seen.add(f);
        queue.push(...importsOf(f));
      }
      // If the graph walk breaks, everything is "unreachable" and the equality
      // below fails loudly rather than passing on an empty set — but a partial
      // break could still look plausible, so pin that most of src/ IS reached.
      expect(
        seen.size,
        "the module graph walk reached almost nothing — the import scan broke",
      ).toBeGreaterThan(files.length / 2);

      const unreachable = files
        .filter((f) => !seen.has(f))
        .map((f) => relative(ROOT, f))
        .sort();
      for (const e of NOT_REACHED_FROM_PRODUCTION)
        expect(e.why.length, `${e.file} needs a reason`).toBeGreaterThan(40);

      expect(
        unreachable,
        "a module under src/ is not reachable from any entrypoint — it runs only in its own tests. Wire it, delete it, " +
          "or record it with what drives it. If one DROPPED off the list, delete its entry: it is live now.",
      ).toEqual(NOT_REACHED_FROM_PRODUCTION.map((e) => e.file).sort());
    },
  );
});
