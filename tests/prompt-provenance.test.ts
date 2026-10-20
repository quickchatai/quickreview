// What reaches a model carries no
// provenance — no reviewed-repo PR numbers, no tracker ids, no dated asides,
// no owner's or teammate's name. Scanned on the BUILT lens bodies and the
// RENDERED round orders (what the model sees), never on the sources, whose
// fence markers and code comments are not model-facing.
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
import {
  FOLLOW_UP_TEMPLATE_FILE,
  RECHECK_TEMPLATE_FILE,
  renderConversationSystemPrompt,
  renderRecheckPrompt,
  renderRoundPrompt,
  ROUND_TEMPLATE_FILES,
} from "../src/templates.js";
import type { RoundType } from "../src/types.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const sandbox = join(import.meta.dirname, "..");
const cfg: Config = parseConfig(
  readFileSync(resolve(sandbox, "tests/fixtures/config.toml"), "utf8"),
);

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
  {
    filename: "src/api/orders.py",
    status: "modified",
    additions: 120,
    deletions: 10,
    changes: 130,
    patch: "@@ -1,3 +1,4 @@\n+import os\n def f():\n-    pass\n+    return os.environ['X']\n",
  },
  {
    filename: "tests/test_orders.py",
    status: "added",
    additions: 30,
    deletions: 0,
    changes: 30,
    patch: "@@ -0,0 +1 @@\n+def test_x(): pass\n",
  },
] as unknown as PrFileEntry[];

describe("no provenance reaches a model", () => {
  // Mutation: put a tracker id back into a lens heading outside its fence, or
  // stop stripping the RATIFIED marker lines in buildAgents → this fails.
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

  // Mutation: put a tracker id back in renderDirectiveEscalationNote, or
  // a dated aside back into a round template outside its fence → this fails.
  it(
    "rendered round orders, with and without first-party directives",
    { timeout: HEAVY_TIMEOUT_MS },
    () => {
      for (const directives of [undefined, { files: ["CLAUDE.md"], mention: "maintainer" }])
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
            ...(directives ? { firstPartyDirectives: directives } : {}),
          });
          const text = renderRoundPrompt(
            readFileSync(join(sandbox, "prompts", file), "utf8"),
            order,
            undefined,
            undefined,
            NONE_ECOSYSTEM,
          );
          if (directives) expect(text, rt).toContain("FIRST-PARTY DIRECTIVES");
          expect(leaks(text), `${rt}${directives ? " + directives" : ""}`).toEqual([]);
        }
    },
  );

  // The follow-up template, with every block it renders filled in.
  // Mutation: put a ticket id into the step-4b prose or renderDeltaNote → fails.
  it(
    "the follow-up round order, every follow-up block filled",
    { timeout: HEAVY_TIMEOUT_MS },
    () => {
      const order = buildRoundOrder({
        cfg,
        row: { number: 7, title: "Orders: read X", head_sha: "abc" } as unknown as PrStateRow,
        files: FILES,
        roundId: 1,
        roundNo: 3,
        reviewNo: 3,
        roundType: "re-review",
        worktree: "/wt",
        settledDigest: "",
        issuedAt: "ISSUED",
        ecosystem: NONE_ECOSYSTEM,
        prBody: "Reads X from the environment so orders can be routed by region.",
      });
      const text = renderRoundPrompt(
        readFileSync(join(sandbox, "prompts", FOLLOW_UP_TEMPLATE_FILE), "utf8"),
        {
          ...order,
          scope: "delta",
          prior_findings_note: "PRIOR FINDINGS TO VERIFY — none open.",
          delta: {
            from_sha: "a".repeat(40),
            tree: "b".repeat(40),
            lines: 3,
            patch_file: "/state/pr-7-round-3-delta.patch",
            files: [
              { path: "src/api/orders.py", status: "modified", ranges: [[1, 3]], conflict: true },
            ],
          },
          sweep_plan: order.pass_plan,
        },
        undefined,
        undefined,
        NONE_ECOSYSTEM,
      );
      expect(text).toContain("PRE-APPROVAL SWEEP");
      expect(leaks(text)).toEqual([]);
    },
  );

  // Mutation: drop stripModelDocs from renderRecheckPrompt (the header lists
  // {{evidence}}, rendered twice) or from either system-prompt renderer → this
  // fails on the RATIFIED marker lines or the doc header.
  it("the recheck order and the session system prompts, as production renders them", () => {
    const recheck = renderRecheckPrompt(
      readFileSync(join(sandbox, "prompts", RECHECK_TEMPLATE_FILE), "utf8"),
      {
        pr: 7,
        title: "Orders",
        trigger: "push",
        standing_verdict: "APPROVE",
        last_reviewed_sha: "aaaaaaa",
        head_sha: "bbbbbbb",
        worktree: "/wt",
        evidence: "EVIDENCE-ONCE",
        files: [{ filename: "src/a.ts", class: "significant", reason: "content" }],
        resolved_files: [],
        decision_file: "pr-7-recheck-bbbbbbb.json",
        issued_at: "ISSUED",
      },
    );
    expect(recheck.split("EVIDENCE-ONCE").length - 1).toBe(1);
    const conversation = renderConversationSystemPrompt(
      readFileSync(join(sandbox, "prompts", "conversation-system.md"), "utf8"),
      { pr: 7, title: "Orders", worktree: "/wt" },
    );
    for (const [name, text] of [
      ["recheck", recheck],
      ["conversation-system", conversation],
    ] as const) {
      expect(text, name).not.toContain("RATIFIED");
      expect(text, name).not.toContain("Sandbox file:");
      expect(leaks(text), name).toEqual([]);
    }
  });

  // These reach pi byte for byte (the companion's --system-prompt, the
  // companion's registered skills), so
  // they are scanned raw. Mutation: put "Feedback-PR: 5270" back in a skill.
  it("files a model reads raw: companion prompt, companion skills", () => {
    const raw = ["prompts/companion.md"];
    const skills = join(sandbox, "skills", "companion");
    for (const d of readdirSync(skills)) raw.push(join("skills", "companion", d, "SKILL.md"));
    expect(raw.length).toBeGreaterThanOrEqual(7);
    // The replay skill's contamination cutoff is an operational value the
    // instrument checks (src/regression.ts), not a dated aside.
    const OPERATIONAL = new Map([["skills/companion/replay/SKILL.md", "`2026-03-01`"]]);
    for (const f of raw) {
      const text = readFileSync(join(sandbox, f), "utf8");
      const allowed = OPERATIONAL.get(f);
      if (allowed) expect(text, f).toContain(allowed);
      expect(leaks(allowed ? text.replaceAll(allowed, "") : text), f).toEqual([]);
    }
  });
});
