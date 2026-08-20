// CLAUDE.md hard rule 6 made structural.
//
// `prompts/` + `agents/` seeded content is canonical — byte-identical to the
// assets — and must never be rewritten in-tree. Per-pass model
// overrides go through `config.toml [models.passes]`, applied at agent build
// time by `src/include.ts`, never by editing the seed.
//
// Two layers:
//   1. Hermetic: sha256 of every seeded file against a checked-in manifest.
//      CI has no issue-tracker checkout, so this is the layer that always runs.
//   2. Provenance: when the assets dir is present on this machine,
//      compare byte-for-byte against it too. Skipped visibly when absent.
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
  "(byte-identical to the assets) and must never be rewritten. " +
  "Per-pass model overrides go through config.toml [models.passes]. " +
  "If you genuinely re-seeded from the assets dir, regenerate " +
  "tests/fixtures/seed-manifest.json in the same commit.";

/**
 * Seeds that have RATIFIED divergence from the assets.
 *
 * Rule 6 freezes the seeds against *unilateral* rewriting, not against the owner.
 * A file listed here was re-seeded on his explicit order; it stays pinned by the
 * manifest (so any FURTHER drift is still caught) but is exempt from the
 * byte-identity comparison against the original asset.
 *
 * The registry lives in tests/fixtures/ratified-divergence.json:
 * each entry is a seeded path with its ratification notes. Two writers only —
 * a human recording a ratified reseed, and the TUI's rubric-accept path
 * (the owner's accept click IS the ratification; the TUI appends the entry,
 * re-pins the manifest hash, and commits). Adding an entry any other way is
 * a rule-6 violation, not a fix.
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
  "prompts/round-first.md",
  "prompts/round-re-review.md",
  "prompts/round-staleness.md",
  "prompts/round-recheck.md",
  "prompts/companion.md",
  "prompts/companion-day-open.md",
  "prompts/slack-overseer-appendix.md",
] as const;

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * The assets dir is flat (basenames only); it lives in the issue tracker, which
 * is absent in CI and may sit at either of the two historically-quoted paths.
 * `QCR_FT0037_ASSETS` overrides for anyone with a checkout elsewhere.
 */
function findAssetsDir(): string | null {
  const candidates = [
    process.env["QCR_FT0037_ASSETS"],
    "~/src/tracker/efforts/review-sandbox/assets",
    "~/src/tracker/assets",
  ].filter((c): c is string => typeof c === "string" && c.length > 0);
  return candidates.find((c) => existsSync(c)) ?? null;
}

const seededPaths = Object.keys(manifest.files).sort();
const assetsDir = findAssetsDir();

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
        expect(note, `${rel}: ratification note must carry a date and 'the owner'`).toMatch(/^\d{4}-\d{2}-\d{2} .*the owner/);
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

// ---- provenance layer: only runnable where the issue tracker is checked out --

const haveAssets = assetsDir !== null;

const provenancePaths = seededPaths.filter((p) => !RATIFIED_DIVERGENCE.has(p));

describe.skipIf(!haveAssets)(`seed provenance vs assets (${assetsDir ?? "ABSENT — skipped"})`, () => {
  it.each(provenancePaths)("%s is byte-identical to the asset", (rel) => {
    const asset = join(assetsDir as string, rel.split("/").pop() as string);
    expect(existsSync(asset), `${rel} has no counterpart in ${assetsDir}`).toBe(true);
    const ours = readFileSync(join(repoRoot, rel));
    const theirs = readFileSync(asset);
    expect(
      ours.equals(theirs),
      `SEED DRIFT: ${rel} differs from ${asset}. ${RULE_6}`,
    ).toBe(true);
  });

  it("no asset is missing from the manifest", () => {
    const basenames = new Set(seededPaths.map((p) => p.split("/").pop() as string));
    const assetFiles = readdirSync(assetsDir as string).filter((f) => f.endsWith(".md"));
    for (const f of assetFiles) {
      expect(basenames, `${f} exists in the assets dir but is not tracked by the seed manifest`).toContain(f);
    }
  });
});

if (!haveAssets) {
  // Make the skip visible in the report rather than silently passing.
  describe("seed provenance vs assets", () => {
    it.skip("SKIPPED: assets dir not on this machine (set QCR_FT0037_ASSETS to enable)", () => {});
  });
}
