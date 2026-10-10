// `[archive]` (docs/archiving.md §12): the defaults, an unknown
// mode refusing to load, every number clamped into its range, the shipped
// example naming every key and parsing to the defaults, and a value in a
// config file reaching the archiver's policy.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { archivePolicy } from "../src/archive/archiver.js";
import {
  ARCHIVE_DEFAULTS,
  ARCHIVE_LIMITS,
  ARCHIVE_MODES,
  loadConfig,
  parseArchive,
  parseConfig,
} from "../src/config.js";

const EXAMPLE = join(process.cwd(), "config.example.toml");
const FIXTURE = join(process.cwd(), "tests/fixtures/config.toml");

describe("[archive] parsing", () => {
  it("an absent section is every default; the shipped mode is plan", () => {
    expect(parseArchive({})).toEqual(ARCHIVE_DEFAULTS);
    expect(ARCHIVE_DEFAULTS).toEqual({
      mode: "plan",
      after_days: 14,
      events_after_days: 35,
      interval_s: 60,
      start_delay_min: 10,
      tick_budget_s: 20,
      max_prs_per_tick: 5,
      max_mb_per_s: 8,
      disk_headroom_gb: 2,
      db_batch_rows: 500,
      gzip_level: 6,
    });
    // The suite's fixture carries no [archive]: the parser fills it.
    expect(loadConfig(FIXTURE).archive).toEqual(ARCHIVE_DEFAULTS);
  });

  it("every mode parses; an unknown one REFUSES to load", () => {
    for (const mode of ARCHIVE_MODES) expect(parseArchive({ mode }).mode).toBe(mode);
    expect(() => parseArchive({ mode: "bogus" })).toThrow(
      'config.toml [archive]: mode must be one of "off", "plan", "on" (got "bogus")',
    );
    expect(() => parseArchive({ mode: 1 })).toThrow(/mode must be one of/);
    const example = readFileSync(EXAMPLE, "utf8");
    const bad = example.replace(/^mode = "plan"(\s+# off \| plan \| on)/m, 'mode = "bogus"$1');
    expect(bad).not.toBe(example);
    expect(() => parseConfig(bad)).toThrow(/\[archive\]: mode must be one of/);
  });

  it("out-of-range numbers are clamped into range; whole-number keys are floored", () => {
    const low = parseArchive(
      Object.fromEntries(Object.keys(ARCHIVE_LIMITS).map((k) => [k, -1_000_000])),
    );
    const high = parseArchive(
      Object.fromEntries(Object.keys(ARCHIVE_LIMITS).map((k) => [k, 1_000_000])),
    );
    for (const [k, [min, max]] of Object.entries(ARCHIVE_LIMITS)) {
      expect(low[k as keyof typeof low], `${k} low`).toBe(min);
      expect(high[k as keyof typeof high], `${k} high`).toBe(max);
    }
    expect(parseArchive({ after_days: 1 }).after_days).toBe(7);
    expect(parseArchive({ events_after_days: 30 }).events_after_days).toBe(31);
    expect(parseArchive({ after_days: 14.9 }).after_days).toBe(14);
    expect(parseArchive({ max_mb_per_s: 2.5 }).max_mb_per_s).toBe(2.5);
    expect(parseArchive({ disk_headroom_gb: 0.75 }).disk_headroom_gb).toBe(0.75);
    expect(parseArchive({ gzip_level: 12 }).gzip_level).toBe(9);
    expect(parseArchive({ db_batch_rows: 10_000 }).db_batch_rows).toBe(2000);
    // A TOML integer too big for a double arrives as a bigint and clamps too.
    expect(parseArchive({ after_days: 10n ** 30n }).after_days).toBe(3650);
  });

  it("a key that is not a number refuses to load (never a silent default)", () => {
    expect(() => parseArchive({ after_days: "14" })).toThrow(
      'config.toml [archive]: after_days must be a number (got "14")',
    );
    expect(() => parseArchive({ gzip_level: true })).toThrow(/gzip_level must be a number/);
    expect(() => parseArchive({ interval_s: Number.NaN })).toThrow(/interval_s must be a number/);
  });
});

describe("config.example.toml", () => {
  it("names every [archive] key and parses to the defaults", () => {
    const text = readFileSync(EXAMPLE, "utf8");
    const section = text.slice(text.indexOf("\n[archive]\n"));
    const body = section.slice(0, section.indexOf("\n[", 2));
    for (const key of Object.keys(ARCHIVE_DEFAULTS))
      expect(body, `config.example.toml [archive] must name ${key}`).toMatch(
        new RegExp(`^${key} = `, "m"),
      );
    expect(loadConfig(EXAMPLE).archive).toEqual(ARCHIVE_DEFAULTS);
  });

  it("what `on` does is said as it is built: it removes closed PRs' files from the live tree (never 'only planned')", () => {
    // The operator reads these at the moment of the flip: the comment above
    // [archive] and the ArchiveConfig doc.
    const text = readFileSync(EXAMPLE, "utf8");
    const comment = text.slice(text.indexOf("# Archiving ("), text.indexOf("\n[archive]\n"));
    const doc = readFileSync(join(process.cwd(), "src", "config.ts"), "utf8");
    const modeDoc = doc.slice(
      doc.indexOf("export interface ArchiveConfig"),
      doc.indexOf("mode: ArchiveMode;"),
    );
    for (const [where, t] of [
      ["config.example.toml", comment.replace(/\n# /g, " ")],
      ["ArchiveConfig.mode", modeDoc.replace(/\n\s*\* +/g, " ")],
    ] as const) {
      expect(t, where).not.toMatch(/only planned|does not move the per-PR files|it plans them/);
      expect(t, where).toMatch(/restores? reopened PRs/);
      expect(t, where).toMatch(/archive\/pr-<n>\//);
      expect(t, where).toMatch(/remov\w+ (each )?from the live tree/i);
      expect(t, where).toMatch(/overseer's non-current transcripts/);
    }
  });

  it("a non-default value in a config file reaches the archiver's policy", () => {
    const dir = mkdtempSync(join(tmpdir(), "qcr-archive-cfg-"));
    try {
      const edited = readFileSync(EXAMPLE, "utf8")
        .replace(/^after_days = 14\b/m, "after_days = 30")
        .replace(/^start_delay_min = 10\b/m, "start_delay_min = 3")
        .replace(/^mode = "plan"(\s+# off)/m, 'mode = "off"$1');
      const path = join(dir, "config.toml");
      writeFileSync(path, edited);
      const policy = archivePolicy(loadConfig(path).archive);
      expect(policy).toMatchObject({ mode: "off", afterDays: 30, startDelayMs: 3 * 60_000 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
