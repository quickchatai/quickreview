// The escalation onboarding step's config surgery: a re-run
// rewrites only the rules the interview owns and never eats a hand-written
// rule — whatever valid TOML spelling that rule's header uses.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { OnboardingEngine, type OnboardAdapters } from "../src/onboard/engine.js";
import { ESCALATION_STEP_ID, escalationStep } from "../src/onboard/steps/escalation.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLE = readFileSync(join(repoRoot, "config.example.toml"), "utf8");

let root: string;
let configPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qcr-esc-step-"));
  configPath = join(root, "config.toml");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function adapters(): OnboardAdapters {
  return {
    fetch: (async () => {
      throw new Error("no network in this suite");
    }) as unknown as typeof fetch,
    runner: { run: async () => ({ code: 127, stdout: "", stderr: "" }) },
    clock: () => new Date("2026-09-30T12:00:00Z"),
    host: { nodeVersion: "v22.5.1", uid: 1000 },
    paths: { stateDir: join(root, "state"), configPath },
  };
}

/** The example config with `rule` spliced in right after the [escalation]
 * table's last key — where an operator adds one by hand. */
function withHandRule(rule: string): string {
  const at = EXAMPLE.indexOf("max_per_pr = 2\n", EXAMPLE.indexOf("[escalation]"));
  const cut = at + "max_per_pr = 2\n".length;
  const text = `${EXAMPLE.slice(0, cut)}${rule}${EXAMPLE.slice(cut)}`;
  parseConfig(text); // the fixture itself is a loadable config
  return text;
}

async function rerun(rule: string) {
  writeFileSync(configPath, withHandRule(rule));
  const engine = new OnboardingEngine([escalationStep()], adapters());
  const result = await engine.runStep(ESCALATION_STEP_ID, {
    enable: "yes",
    targets: "alice",
    why: "owns the schema",
    paths: "db/**",
  });
  expect(result.ok, result.failures.join("; ")).toBe(true);
  return parseConfig(readFileSync(configPath, "utf8"));
}

describe("escalation step: a re-run never eats a hand-written rule", () => {
  it("keeps a rule whose header is indented (valid TOML)", async () => {
    const cfg = await rerun(
      [
        "  [[escalation.rules]]",
        '  name = "hand"',
        '  to = "alice"',
        '  why = "she wrote the billing module"',
        '  paths = ["billing/**"]',
        "",
      ].join("\n"),
    );
    expect(cfg.escalation.rules.map((r) => r.name).sort()).toEqual(["hand", "onboarding:alice"]);
    expect(cfg.escalation.rules.find((r) => r.name === "hand")!.paths).toEqual(["billing/**"]);
  });

  it("keeps a rule whose header carries a trailing comment — once, not twice", async () => {
    const cfg = await rerun(
      [
        "[[escalation.rules]] # mine, keep it",
        'name = "hand"',
        'to = "alice"',
        'why = "she wrote the billing module"',
        'paths = ["billing/**"]',
        "",
      ].join("\n"),
    );
    expect(cfg.escalation.rules.map((r) => r.name).sort()).toEqual(["hand", "onboarding:alice"]);
  });
});
