// The native build, byte for byte (P4.5). The engine routes' tools (`lens`,
// `lens_wave`) join the names include.ts strips from a built agent's tool list;
// that must not move a single byte of what the tmux bot, the bench and the scan
// build out of the seeds. The golden holds the sha256 of every agent file each
// build writes and of the native execution-policy addendum, recorded before the
// strip learned the new names.
//
// Regenerate ONLY for a deliberate change to the native output (a reseed-class
// decision, rule 6): `UPDATE_GOLDEN=1 npx vitest run tests/built-agents-golden.test.ts`.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildBenchAgents } from "../src/bench/runner.js";
import { loadConfig, type Config } from "../src/config.js";
import {
  EXECUTION_POLICY_ADDENDUM,
  PASS_ADDENDA,
  buildAgents,
  configAddenda,
  identityVars,
} from "@quickchatai/pi-quickreview/src/include.js";
import { lensTuningAddenda, roundAgentModels } from "@quickchatai/pi-quickreview/src/lenstuning.js";
import { postingPolicyAddenda } from "@quickchatai/pi-quickreview/src/postingpolicy.js";
import { buildScanAgents } from "../src/setup/scanbuild.js";

const ROOT = resolve(import.meta.dirname, "..");
const GOLDEN = join(ROOT, "tests", "fixtures", "built-agents-golden.json");
const cfg: Config = loadConfig(join(ROOT, "tests", "fixtures", "config.toml"));

const tmp = mkdtempSync(join(tmpdir(), "built-agents-golden-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const sha = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");

/** sha256 of each file in a build's output dir, by file name. */
function digest(dir: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(dir)
      .sort()
      .map((f) => [f, sha(readFileSync(join(dir, f)))]),
  );
}

interface Golden {
  execution_policy: string;
  vm: Record<string, string>;
  bench: Record<string, string>;
  scan: Record<string, string>;
}

function builds(): Omit<Golden, "execution_policy"> {
  const vm = join(tmp, "vm");
  const bench = join(tmp, "bench");
  const scan = join(tmp, "scan");
  buildAgents(join(ROOT, "agents"), vm, {
    root: ROOT,
    tiers: cfg.models.tiers,
    riskPasses: cfg.models.risk_passes,
    validateTier: cfg.models.validate_tier,
    vars: identityVars(cfg),
    models: roundAgentModels(cfg),
    addenda: [
      ...PASS_ADDENDA,
      ...configAddenda(cfg.review),
      ...lensTuningAddenda(cfg.lenses),
      ...postingPolicyAddenda(cfg.posting),
    ],
  });
  buildBenchAgents(ROOT, cfg, bench);
  buildScanAgents(ROOT, scan, cfg);
  return { vm: digest(vm), bench: digest(bench), scan: digest(scan) };
}

describe("the native build is byte-identical", () => {
  it("every agent file of the vm, bench and scan builds, and the execution policy", () => {
    const actual: Golden = { execution_policy: sha(EXECUTION_POLICY_ADDENDUM), ...builds() };
    if (process.env["UPDATE_GOLDEN"] === "1")
      writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as Golden;
    expect(actual.execution_policy).toBe(golden.execution_policy);
    for (const build of ["vm", "bench", "scan"] as const) {
      expect(Object.keys(actual[build]), `${build}: the set of agent files`).toEqual(
        Object.keys(golden[build]),
      );
      expect(actual[build], `${build}: agent file bytes`).toEqual(golden[build]);
    }
    expect(Object.keys(golden.vm).length).toBeGreaterThan(20);
  });
});
