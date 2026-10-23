// pass-concurrency in a scan. The PR-round build carries a trigger rule —
// "your task string must NAME THE SHAPE … if it names no concrete
// read-then-write, say so in one line and return NONE" — and a scan case has
// no session to name one: its "Why this case" line only says why the row was
// planned ("files this lens has never deep-read"). With that rule in the scan
// build the lens reads nothing and returns NONE, while the ledger records the
// files as deep-read.
//
// Pinned here: the trigger stays in every PR build and leaves the scan build;
// the scan build carries a scan-only rule that makes the focus files the
// anchor, and it binds pass-concurrency alone.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig, type Config } from "../src/config.js";
import {
  CONCURRENCY_PASS,
  CONCURRENCY_SCAN_ADDENDUM,
  PASS_ADDENDA,
  SCAN_MODE_ANCHOR_ADDENDUM,
  addendaForPass,
  buildAgents,
} from "../src/include.js";
import { homeProfileLookup, type InstallEnv } from "../src/install.js";
import { buildScanAgents } from "../src/setup/scanbuild.js";

const sandbox = join(import.meta.dirname, "..");
const fixture: Config = parseConfig(
  readFileSync(resolve(sandbox, "tests/fixtures/config.toml"), "utf8"),
);
const TRIGGER_MARKER =
  "## You were added on demand — your task string must NAME THE SHAPE (sandbox rule)";

let dir: string;
let env: InstallEnv;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-scan-concurrency-"));
  env = { HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "xdg-config") };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function built(out: string): Map<string, string> {
  return new Map(
    readdirSync(out).map((f) => [f.replace(/\.md$/, ""), readFileSync(join(out, f), "utf8")]),
  );
}

describe("the PR-round trigger rule is a PR-build rule", () => {
  it("still composes into every PR build of pass-concurrency, and the scan rule never does", () => {
    const ids = addendaForPass(CONCURRENCY_PASS).map((a) => a.id);
    expect(ids).toContain("concurrency-trigger");
    expect(ids).not.toContain("concurrency-scan");
    const out = join(dir, "pr");
    buildAgents(join(sandbox, "agents"), out, {
      root: sandbox,
      tiers: fixture.models.tiers,
      riskPasses: fixture.models.risk_passes,
      validateTier: fixture.models.validate_tier,
      addenda: PASS_ADDENDA,
    });
    const variants = [...built(out)].filter(([n]) => n.startsWith(`${CONCURRENCY_PASS}--`));
    expect(variants.length).toBeGreaterThan(0);
    for (const [name, body] of variants) {
      expect(body, name).toContain(TRIGGER_MARKER);
      expect(body, name).not.toContain(CONCURRENCY_SCAN_ADDENDUM);
    }
  });

  it("is left out of a scan build, where the scan rule replaces it — for pass-concurrency alone", () => {
    const ids = addendaForPass(CONCURRENCY_PASS, PASS_ADDENDA, "django", "scan").map((a) => a.id);
    expect(ids).not.toContain("concurrency-trigger");
    expect(ids).toContain("concurrency-scan");
    expect(PASS_ADDENDA.find((a) => a.id === "concurrency-scan")).toMatchObject({
      scope: [CONCURRENCY_PASS],
      mode: "scan",
    });

    const out = join(dir, "scan");
    buildScanAgents(sandbox, out, fixture, homeProfileLookup(env));
    const agents = built(out);
    let seen = 0;
    for (const [name, body] of agents) {
      if (name.startsWith(`${CONCURRENCY_PASS}--`)) {
        seen++;
        expect(body, name).not.toContain(TRIGGER_MARKER);
        expect(body, name).toContain(CONCURRENCY_SCAN_ADDENDUM);
        // The anchor rule stays the final word.
        expect(body.indexOf(CONCURRENCY_SCAN_ADDENDUM), name).toBeLessThan(
          body.indexOf(SCAN_MODE_ANCHOR_ADDENDUM),
        );
        // It still reads: the tools a reading needs are there.
        expect(body, name).toMatch(/^tools: .*\bread\b/m);
      } else {
        expect(body, name).not.toContain(CONCURRENCY_SCAN_ADDENDUM);
      }
    }
    expect(seen).toBeGreaterThan(0);
  });
});

describe("the scan rule's content", () => {
  it("makes the focus files the anchor: read them in full and find the shapes there", () => {
    expect(CONCURRENCY_SCAN_ADDENDUM).toMatch(/focus files/);
    expect(CONCURRENCY_SCAN_ADDENDUM).toMatch(/in full/);
    expect(CONCURRENCY_SCAN_ADDENDUM).toMatch(/read-then-write/);
  });

  it("says the case's reason line is not a missing shape, and supersedes the seed's 'the session named it' premise", () => {
    expect(CONCURRENCY_SCAN_ADDENDUM).toContain("Why this case");
    expect(CONCURRENCY_SCAN_ADDENDUM).toMatch(/supersedes/i);
    expect(CONCURRENCY_SCAN_ADDENDUM).toMatch(/no session/i);
  });

  it("allows NONE only after reading, with what was checked", () => {
    expect(CONCURRENCY_SCAN_ADDENDUM).toMatch(/`NONE`/);
    expect(CONCURRENCY_SCAN_ADDENDUM).toMatch(/only after/i);
    expect(CONCURRENCY_SCAN_ADDENDUM).toMatch(/not a reading/i);
  });
});
