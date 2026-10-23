// pass-delivery in the whole-repo scan: its checks — the drop paths where a
// handler consumes its only delivery, redelivery, fetch windows and sources
// that lag each other — need no diff, so a scan may suggest it and run it.
// Pinned here: it is out of the diff-only set, stage 1 is told it may name
// it, stage 2 accepts a row of it, and its scan build carries the scan-mode
// recast while every PR build stays byte-identical.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig, type Config } from "../src/config.js";
import {
  PASS_ADDENDA,
  SCAN_DELIVERY_ADDENDUM,
  addendaForPass,
  buildAgents,
  type PassAddendum,
} from "../src/include.js";
import { homeProfileLookup, type InstallEnv } from "../src/install.js";
import {
  DIFF_ONLY_LENSES,
  parseScanAnswer,
  scanCasePrompt,
  SCAN_DEEP_LENSES,
} from "../src/setup/scan.js";
import { buildScanAgents } from "../src/setup/scanbuild.js";
import { stage2Lenses } from "../src/setup/stage2.js";

const sandbox = join(import.meta.dirname, "..");
const fixture: Config = parseConfig(
  readFileSync(resolve(sandbox, "tests/fixtures/config.toml"), "utf8"),
);

let dir: string;
let env: InstallEnv;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-scan-delivery-"));
  env = { HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "xdg-config") };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function built(out: string): Map<string, string> {
  return new Map(
    readdirSync(out).map((f) => [f.replace(/\.md$/, ""), readFileSync(join(out, f), "utf8")]),
  );
}

function prBuild(out: string, addenda: readonly PassAddendum[]): Map<string, string> {
  buildAgents(join(sandbox, "agents"), join(dir, out), {
    root: sandbox,
    tiers: fixture.models.tiers,
    riskPasses: fixture.models.risk_passes,
    validateTier: fixture.models.validate_tier,
    addenda,
  });
  return built(join(dir, out));
}

describe("pass-delivery is a lens a scan runs", () => {
  it("is out of the diff-only set, which keeps the lenses that need a diff, a PR body or a session", () => {
    expect(DIFF_ONLY_LENSES).not.toContain("pass-delivery");
    expect(SCAN_DEEP_LENSES).toContain("pass-delivery");
    expect(stage2Lenses(undefined)).toContain("pass-delivery");
    for (const l of [
      "pass-intent",
      "pass-claims",
      "pass-backcompat",
      "pass-rollout",
      "pass-widened",
      "pass-sweep",
      "pass-ask-human",
      "pass-validate",
    ])
      expect(SCAN_DEEP_LENSES, l).not.toContain(l);
  });

  it("stage 1 is told it may name it, and a suggestion naming it is kept", () => {
    const prompt = scanCasePrompt(
      {
        unit: "app",
        id: "app",
        part: 1,
        parts: 1,
        files: [{ path: "app/hooks.py", blob: "b", lines: 9 }],
        lines: 9,
      },
      { root: "/tree", sha: "s", caseId: "c" },
    );
    expect(prompt).toMatch(/Deep lenses you may name in SUGGEST: .*pass-delivery/);
    const a = parseScanAnswer(
      "FINDINGS pass-scan SCAN c @s\nNONE\n\nSUGGEST\n- lens: pass-delivery\n  files: app/hooks.py\n  reason: the webhook acks before the write\n",
    );
    expect(a.suggestions).toEqual([
      {
        lens: "pass-delivery",
        files: ["app/hooks.py"],
        reason: "the webhook acks before the write",
      },
    ]);
  });

  it("its scan-mode recast is a registry entry no PR build composes", () => {
    expect(PASS_ADDENDA.find((a) => a.id === "scan-delivery")).toEqual({
      id: "scan-delivery",
      scope: ["pass-delivery"],
      mode: "scan",
      text: SCAN_DELIVERY_ADDENDUM,
    });
    const ids = (mode: "pr" | "scan") =>
      addendaForPass("pass-delivery", PASS_ADDENDA, "django", mode).map((a) => a.id);
    expect(ids("pr")).not.toContain("scan-delivery");
    expect(ids("scan")).toContain("scan-delivery");
    // The recast names the lens's three checks on code as it stands.
    expect(SCAN_DELIVERY_ADDENDUM).toContain("Drop paths in this code");
    expect(SCAN_DELIVERY_ADDENDUM).toContain("**Redelivery.**");
    expect(SCAN_DELIVERY_ADDENDUM).toContain("Two sources that lag each other");
  });

  it("its scan build carries the recast; every PR build is byte-identical without it", () => {
    const out = join(dir, "scan");
    buildScanAgents(sandbox, out, fixture, homeProfileLookup(env));
    for (const [name, body] of built(out))
      expect(body.includes(SCAN_DELIVERY_ADDENDUM), name).toBe(name.startsWith("pass-delivery--"));
    expect(prBuild("pr", PASS_ADDENDA)).toEqual(
      prBuild(
        "pr-without",
        PASS_ADDENDA.filter((a) => a.id !== "scan-delivery"),
      ),
    );
  });
});
