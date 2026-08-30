// CLAUDE.md hard rule 6 made structural.
//
// `prompts/` + `agents/` seeded content is canonical — byte-identical to the
// in-repo seeds/ copies (lineage) — and must never be rewritten
// in-tree. Per-pass model
// overrides go through `config.toml [models.passes]`, applied at agent build
// time by `src/include.ts`, never by editing the seed.
//
// Two layers:
//   1. Hermetic: sha256 of every seeded file against a checked-in manifest.
//   2. Provenance: byte-for-byte comparison against the in-repo canonical
//      copies under seeds/ (previously the external assets
//      dir, present only on the original machine). Runs unconditionally, on
//      any machine, with no environment variable.
// Plus a guard that the files we DO own never sneak into the manifest.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface SeedManifest {
  source: string;
  algorithm: string;
  files: Record<string, string>;
}

const manifest = JSON.parse(
  readFileSync(join(repoRoot, "tests/fixtures/seed-manifest.json"), "utf8"),
) as SeedManifest;

const RULE_6 =
  "CLAUDE.md hard rule 6: prompts/ + agents/ seeded content is canonical " +
  "(byte-identical to the seeds/ canonical copies, lineage) and must " +
  "never be rewritten. " +
  "Per-pass model overrides go through config.toml [models.passes]. " +
  "A genuinely ratified reseed refreshes seeds/ and regenerates " +
  "tests/fixtures/seed-manifest.json in the same commit.";

/**
 * Seeds that have RATIFIED divergence from the original lineage.
 *
 * Rule 6 freezes the seeds against *unilateral* rewriting, not against the
 * owner. A file listed here was re-seeded on the owner's explicit order; it
 * stays pinned by the manifest (so any FURTHER drift is still caught), and
 * the entry records the departure from the original lineage. Since
 * the provenance baseline is the in-repo seeds/ copy — refreshed by every
 * ratified reseed — so the registry no longer exempts anything from the
 * byte-identity comparison below; it is the lineage record.
 *
 * The registry lives in tests/fixtures/ratified-divergence.json:
 * each entry is a seeded path with its ratification notes. Two writers only —
 * a human recording a ratified reseed, and the TUI's rubric-accept path
 * (the owner's accept click IS the ratification; the TUI appends the entry,
 * refreshes seeds/, re-pins the manifest hash, and commits). Adding an entry
 * any other way is a rule-6 violation, not a fix.
 */
interface DivergenceRegistry {
  files: Record<string, string[]>;
}
const divergence = JSON.parse(
  readFileSync(join(repoRoot, "tests/fixtures/ratified-divergence.json"), "utf8"),
) as DivergenceRegistry;
const RATIFIED_DIVERGENCE = new Set<string>(Object.keys(divergence.files));

/** Files that are OURS to edit — they must never be frozen by the manifest. */
const NON_SEEDED = [
  // agents/pass-intent.md is OURS: created after the seeding,
  // never part of the frozen set — it must not be pinned by the manifest.
  "agents/pass-intent.md",
  // The judgment lenses (2026-08-20 review-tuning): same
  // post-seed provenance as pass-intent, ours to edit, never in the manifest.
  "agents/pass-placement.md",
  "agents/pass-simplicity.md",
  "agents/pass-backcompat.md",
  // the on-demand concurrency lens — post-seed, ours, addable-only.
  "agents/pass-concurrency.md",
  // the ask-your-human lens — post-seed, ours, addable-only.
  "agents/pass-ask-human.md",
  "prompts/round-first.md",
  "prompts/round-re-review.md",
  "prompts/round-staleness.md",
  "prompts/round-recheck.md",
  "prompts/companion.md",
  "prompts/companion-day-open.md",
  // the first-run greeting + calibration interview — post-seed, ours.
  "prompts/companion-first-run.md",
  "prompts/slack-overseer-appendix.md",
  // the onboarding wizard's system prompt — post-seed, ours to edit.
  "prompts/onboarding.md",
] as const;

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const seededPaths = Object.keys(manifest.files).sort();

describe("seed integrity (hard rule 6)", () => {
  it("manifest covers exactly the seeded set: 4 prompts + 9 pass agents", () => {
    expect(seededPaths).toEqual([
      "agents/pass-baseline.md",
      "agents/pass-contracts.md",
      "agents/pass-data-safety.md",
      "agents/pass-delivery.md",
      "agents/pass-prod-risk.md",
      "agents/pass-security.md",
      "agents/pass-statelessness.md",
      "agents/pass-ui.md",
      "agents/pass-validate.md",
      "prompts/conversation-system.md",
      "prompts/eod-sweep.md",
      "prompts/overseer-system.md",
      "prompts/pass-common.md",
    ]);
    expect(manifest.algorithm).toBe("sha256");
  });

  it.each(seededPaths)("%s is unmodified (sha256 matches the manifest)", (rel) => {
    const abs = join(repoRoot, rel);
    expect(existsSync(abs), `${rel} is missing from the tree. ${RULE_6}`).toBe(true);
    const actual = sha256(abs);
    expect(
      actual,
      `SEED DRIFT: ${rel} no longer matches its checked-in hash ` +
        `(manifest ${manifest.files[rel]}, on disk ${actual}). ${RULE_6}`,
    ).toBe(manifest.files[rel]);
  });

  it("does not freeze the files we own", () => {
    for (const rel of NON_SEEDED) {
      expect(
        seededPaths,
        `${rel} is ours to edit and must NOT be pinned by the seed manifest — ` +
          `freezing it would block legitimate edits. ${RULE_6}`,
      ).not.toContain(rel);
    }
  });

  it("every ratified-divergence entry is a real seeded path with a ratification note", () => {
    // A typo here would silently exempt nothing (harmless) or, worse, look like
    // cover for a file that was never actually ratified. Keep it honest.
    for (const rel of RATIFIED_DIVERGENCE) {
      expect(
        seededPaths,
        `${rel} is listed as a ratified divergence but is not a seeded file`,
      ).toContain(rel);
      const notes = divergence.files[rel] ?? [];
      expect(notes.length, `${rel} has no ratification note — who ratified it, when?`).toBeGreaterThan(0);
      for (const note of notes) {
        // new notes are role-worded ("owner"); the personal spelling
        // on the legacy notes is history and must keep validating.
        expect(note, `${rel}: ratification note must carry a date and a ratifier ('owner'; 'the owner' grandfathered)`).toMatch(
          /^\d{4}-\d{2}-\d{2} .*(?:the owner|owner)/,
        );
      }
    }
  });

  it("the non-seeded prompts actually exist (guards a rename going unnoticed)", () => {
    // slack-overseer-appendix.md and round-recheck.md were created
    // by later slices; the other round/companion templates predate them. All
    // are ours — this only catches silent deletion.
    for (const rel of NON_SEEDED) {
      expect(existsSync(join(repoRoot, rel)), `${rel} vanished from the tree`).toBe(true);
    }
  });
});

// ---- provenance layer: byte-identity vs the in-repo canonical copies --------
//
// the canonical seed copies live in seeds/ (same relative layout as
// the tree), so this layer runs unconditionally on every machine — no
// environment variable, no external checkout. Until it compared
// against the assets dir in the issue tracker, which only the
// original machine had; seeds/ carries that lineage forward in-repo.
//
// The RATIFIED_DIVERGENCE interaction, deliberately: the divergence-exempt
// files (conversation-system, overseer-system, eod-sweep) diverge from the
// ORIGINAL assets, but seeds/ was copied from the CURRENT tree —
// whose shas the manifest already pins — so byte-identity vs seeds/ holds for
// ALL 13 files and nothing is filtered out here. The registry keeps meaning
// "diverged from the original lineage" (each entry says who ratified the
// reseed and when); it no longer exempts anything from this comparison.
// A future ratified reseed — a human recording one, or the TUI's
// rubric-accept path (`recordRatification`) — refreshes the seeds/ copy AND
// re-pins the manifest sha in the same commit.

const seedsDir = join(repoRoot, "seeds");

describe("seed provenance vs in-repo canonical copies (seeds/)", () => {
  it.each(seededPaths)("%s is byte-identical to its seeds/ canonical copy", (rel) => {
    const canonical = join(seedsDir, rel);
    expect(existsSync(canonical), `${rel} has no canonical copy under seeds/`).toBe(true);
    const ours = readFileSync(join(repoRoot, rel));
    const theirs = readFileSync(canonical);
    expect(
      ours.equals(theirs),
      `SEED DRIFT: ${rel} differs from seeds/${rel}. ${RULE_6}`,
    ).toBe(true);
  });

  it.each(seededPaths)("seeds/%s matches the manifest sha (the canonical copy cannot drift)", (rel) => {
    // The guard on the copy itself: editing seeds/ instead of the seed would
    // otherwise make the byte-identity comparison above vacuous.
    const canonical = join(seedsDir, rel);
    expect(existsSync(canonical), `seeds/${rel} is missing`).toBe(true);
    const actual = sha256(canonical);
    expect(
      actual,
      `CANONICAL-COPY DRIFT: seeds/${rel} no longer matches the manifest ` +
        `(manifest ${manifest.files[rel]}, on disk ${actual}). The seeds/ copy is the ` +
        `provenance baseline — it changes only in a ratified reseed that re-pins the manifest. ${RULE_6}`,
    ).toBe(manifest.files[rel]);
  });

  it("no seeds/ file is missing from the manifest", () => {
    const tracked = new Set(seededPaths);
    const found = readdirSync(seedsDir, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => join(d.parentPath, d.name).slice(seedsDir.length + 1))
      .filter((rel) => rel.endsWith(".md"));
    for (const rel of found) {
      expect(tracked, `seeds/${rel} exists but is not tracked by the seed manifest`).toContain(rel);
    }
  });
});
