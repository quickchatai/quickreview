// Prompt cleanup (2026-10-03): what reaches a model carries no
// provenance — no reviewed-repo PR numbers, no tracker ids, no dated asides,
// no owner's or teammate's name. Scanned on the BUILT lens bodies and the
// RENDERED round orders (what the model sees), never on the sources, whose
// fence markers and code comments may keep their history.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig, type Config } from "../src/config.js";
import { buildRoundOrder } from "../src/dispatch.js";
import { NONE_ECOSYSTEM } from "../src/ecosystem.js";
import type { PrFileEntry } from "../src/github.js";
import { PASS_ADDENDA, buildAgents, configAddenda } from "../src/include.js";
import type { PrStateRow } from "../src/state.js";
import { renderRecheckPrompt, renderRoundPrompt, ROUND_TEMPLATE_FILES } from "../src/templates.js";
import type { RoundType } from "../src/types.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const sandbox = join(import.meta.dirname, "..");
const cfg: Config = parseConfig(readFileSync(resolve(sandbox, "tests/fixtures/config.toml"), "utf8"));

const LEAKS: Array<[string, RegExp]> = [
  ["a PR number", /#(?!1234\b)\d{4,}/], // `#1234` is the placeholder spelling
  ["a tracker id", /\bFT-\d{4}\b/],
  ["a dated aside", /\b20\d\d-\d\d-\d\d\b/],
  ["a person's name", /\b(the owner|Priya|Alex)\b/i],
];

function leaks(text: string): string[] {
  return LEAKS.flatMap(([what, re]) => {
    const m = re.exec(text);
    return m ? [`${what}: …${text.slice(Math.max(0, m.index - 40), m.index + 30)}…`] : [];
  });
}

const FILES = [
  { filename: "src/api/orders.py", status: "modified", additions: 120, deletions: 10, changes: 130, patch: "@@ -1,3 +1,4 @@\n+import os\n def f():\n-    pass\n+    return os.environ['X']\n" },
  { filename: "tests/test_orders.py", status: "added", additions: 30, deletions: 0, changes: 30, patch: "@@ -0,0 +1 @@\n+def test_x(): pass\n" },
] as unknown as PrFileEntry[];

describe("no provenance reaches a model", () => {
  it("built lens bodies", { timeout: HEAVY_TIMEOUT_MS }, () => {
    const dir = mkdtempSync(join(tmpdir(), "qcr-provenance-"));
    try {
      buildAgents(join(sandbox, "agents"), dir, {
        root: sandbox,
        tiers: cfg.models.tiers,
        addenda: [...PASS_ADDENDA, ...configAddenda(cfg.review)],
      });
      const files = readdirSync(dir);
      expect(files.length).toBeGreaterThan(20);
      for (const f of files) expect(leaks(readFileSync(join(dir, f), "utf8")), f).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rendered round orders and the recheck template", { timeout: HEAVY_TIMEOUT_MS }, () => {
    for (const [rt, file] of Object.entries(ROUND_TEMPLATE_FILES)) {
      const order = buildRoundOrder({
        cfg,
        row: { number: 7, title: "Orders: read X", head_sha: "abc" } as unknown as PrStateRow,
        files: FILES,
        roundId: 1,
        roundNo: rt === "first" ? 1 : 3,
        reviewNo: rt === "first" ? 1 : 3,
        roundType: rt as RoundType,
        worktree: "/wt",
        settledDigest: "",
        issuedAt: "ISSUED",
        ecosystem: NONE_ECOSYSTEM,
        prBody: "Reads X from the environment so orders can be routed by region.",
      });
      const text = renderRoundPrompt(readFileSync(join(sandbox, "prompts", file), "utf8"), order, undefined, undefined, NONE_ECOSYSTEM);
      expect(leaks(text), rt).toEqual([]);
    }
    expect(typeof renderRecheckPrompt).toBe("function");
    const recheck = readFileSync(join(sandbox, "prompts", "round-recheck.md"), "utf8")
      .replace(/<!--[^\n]*-->/g, "")
      .replace(/^> [^\n]*$/gm, "");
    expect(leaks(recheck), "round-recheck.md").toEqual([]);
  });

  it("companion and overseer prompts", () => {
    for (const f of ["companion.md", "slack-overseer-appendix.md", "overseer-system.md", "conversation-system.md", "eod-sweep.md"]) {
      const text = readFileSync(join(sandbox, "prompts", f), "utf8")
        .replace(/^[ \t]*<!--[ \t]*\/?RATIFIED[^\n]*$/gm, "")
        .replace(/\n> Sandbox file:[^\n]*\n(?:>[^\n]*\n)*/, "\n");
      expect(leaks(text), f).toEqual([]);
    }
  });
});
