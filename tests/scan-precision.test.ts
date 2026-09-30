// The scan-mode precision addendum (scan-loop, 2026-09-30): the recurring
// false-positive classes that adversarial skeptics refuted across three
// self-scan rounds (162 refuted findings — the analysis lives on the issue
// tracker, efforts/scan-and-setup/assets/improvement-loop/
// false-positive-classes.md), turned into a pre-report checklist for the scan
// build's stage-1 lens and the four deep lenses those findings came from.
//
// Pinned here: it rides the scan build and NO PR build (a PR build is
// byte-identical with and without the entry), it binds exactly the five
// lenses, it names every class, and it downgrades rather than drops.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig, type Config } from "../src/config.js";
import {
  PASS_ADDENDA,
  SCAN_MODE_ANCHOR_ADDENDUM,
  SCAN_PRECISION_ADDENDUM,
  SCAN_PRECISION_LENSES,
  VALIDATE_PASS,
  addendaForPass,
  buildAgents,
  type PassAddendum,
} from "../src/include.js";
import type { InstallEnv } from "../src/install.js";
import { buildScanAgents } from "../src/setup/scanbuild.js";

const sandbox = join(import.meta.dirname, "..");
const fixture: Config = parseConfig(readFileSync(resolve(sandbox, "tests/fixtures/config.toml"), "utf8"));

let dir: string;
let env: InstallEnv;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-scan-precision-"));
  env = { HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "xdg-config") };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function built(out: string): Map<string, string> {
  return new Map(readdirSync(out).map((f) => [f.replace(/\.md$/, ""), readFileSync(join(out, f), "utf8")]));
}

function prBuild(out: string, addenda: readonly PassAddendum[], ecosystem: "django" | "none"): Map<string, string> {
  buildAgents(join(sandbox, "agents"), join(dir, out), {
    root: sandbox,
    tiers: fixture.models.tiers,
    riskPasses: fixture.models.risk_passes,
    validateTier: fixture.models.validate_tier,
    addenda,
    ecosystem,
  });
  return built(join(dir, out));
}

const lensOf = (variant: string): string => variant.replace(/--.*$/, "");

describe("the scan precision addendum is a scan-mode registry entry", () => {
  it("binds exactly pass-scan and the four deep lenses, in scan mode only", () => {
    expect(SCAN_PRECISION_LENSES).toEqual([
      "pass-scan",
      "pass-contracts",
      "pass-data-safety",
      "pass-security",
      "pass-concurrency",
    ]);
    const entry = PASS_ADDENDA.find((a) => a.id === "scan-precision");
    expect(entry).toMatchObject({ mode: "scan", scope: SCAN_PRECISION_LENSES, text: SCAN_PRECISION_ADDENDUM });
    for (const lens of SCAN_PRECISION_LENSES) {
      expect(addendaForPass(lens).map((a) => a.id), lens).not.toContain("scan-precision");
      expect(addendaForPass(lens, PASS_ADDENDA, "django", "scan").map((a) => a.id), lens).toContain("scan-precision");
    }
    for (const other of ["pass-baseline", "pass-tests", VALIDATE_PASS]) {
      expect(addendaForPass(other, PASS_ADDENDA, "django", "scan").map((a) => a.id), other).not.toContain("scan-precision");
    }
  });

  it("leaves the scan-mode anchor rule the last word in the registry", () => {
    expect(PASS_ADDENDA.at(-1)?.id).toBe("scan-mode-anchor");
    const ids = PASS_ADDENDA.map((a) => a.id);
    expect(ids.indexOf("scan-precision")).toBe(ids.length - 3);
    expect(ids.indexOf("scan-skeptic-validate")).toBe(ids.length - 2);
  });
});

describe("the PR build does not change", () => {
  for (const ecosystem of ["django", "none"] as const) {
    it(`is byte-identical with and without the entry (${ecosystem})`, () => {
      const withEntry = prBuild("with", PASS_ADDENDA, ecosystem);
      const without = prBuild(
        "without",
        PASS_ADDENDA.filter((a) => a.id !== "scan-precision"),
        ecosystem,
      );
      expect(withEntry.size).toBeGreaterThan(20);
      expect([...withEntry.keys()].sort()).toEqual([...without.keys()].sort());
      for (const [name, body] of withEntry) expect(body, name).toBe(without.get(name));
      for (const [name, body] of withEntry) expect(body, name).not.toContain("Scan precision");
    });
  }
});

describe("the scan build carries it where the refuted findings came from", () => {
  it("in every variant of the five lenses, and in no other lens's", () => {
    const out = join(dir, "scan-agents");
    buildScanAgents(sandbox, out, fixture, { env });
    const agents = built(out);
    const seen = new Set<string>();
    for (const [name, body] of agents) {
      const lens = lensOf(name);
      if ((SCAN_PRECISION_LENSES as readonly string[]).includes(lens)) {
        seen.add(lens);
        expect(body, name).toContain(SCAN_PRECISION_ADDENDUM);
        // …before the anchor rule, which stays the final word on anchoring.
        expect(body.indexOf(SCAN_PRECISION_ADDENDUM), name).toBeLessThan(body.indexOf(SCAN_MODE_ANCHOR_ADDENDUM));
      } else {
        expect(body, name).not.toContain("Scan precision");
      }
    }
    expect([...seen].sort()).toEqual([...SCAN_PRECISION_LENSES].sort());
  });
});

describe("the addendum's content", () => {
  it("names each false-positive class", () => {
    for (const cls of [
      "Guarded elsewhere",
      "Unreachable in production",
      "Intended behaviour",
      "Same-principal input",
      "Self-written state",
      "Contrived concurrency",
      "Contrived fault or input",
      "No observable consequence",
      "Scale without cardinality",
      "External semantics",
    ]) {
      expect(SCAN_PRECISION_ADDENDUM, cls).toContain(`**${cls}`);
    }
  });

  it("requires the three checks before a finding is reported", () => {
    // a concrete triggering path from an entry point…
    expect(SCAN_PRECISION_ADDENDUM).toMatch(/entry point/);
    // …guards in callers and at the gate / validator…
    expect(SCAN_PRECISION_ADDENDUM).toMatch(/callers/);
    expect(SCAN_PRECISION_ADDENDUM).toMatch(/gate/);
    expect(SCAN_PRECISION_ADDENDUM).toMatch(/validator/);
    // …and the repository's recorded decisions before calling behaviour a defect.
    expect(SCAN_PRECISION_ADDENDUM).toContain("CLAUDE.md");
    expect(SCAN_PRECISION_ADDENDUM).toMatch(/ratified/);
  });

  it("downgrades rather than drops — dropping is a policy change it does not make", () => {
    expect(SCAN_PRECISION_ADDENDUM).toMatch(/downgrade/i);
    expect(SCAN_PRECISION_ADDENDUM).toContain("`P3`");
    expect(SCAN_PRECISION_ADDENDUM).toContain("`reachability: contrived`");
    expect(SCAN_PRECISION_ADDENDUM).toMatch(/never leave (it|a finding) out/i);
    expect(SCAN_PRECISION_ADDENDUM).not.toMatch(/\bdrop (it|the finding)\b/i);
    // A validator kills below 0.5 confidence, so "lower the confidence" would
    // be a drop by another route when `[scan] validator` is on.
    expect(SCAN_PRECISION_ADDENDUM).not.toMatch(/lowered `confidence`/);
    expect(SCAN_PRECISION_ADDENDUM).toMatch(/Do not lower `confidence` because a class matched/);
  });
});
