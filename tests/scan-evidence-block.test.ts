// A scan finding's `evidence: |` block scalar — the shape the state-machine
// and security family prompts prescribe — is read as one multi-line value:
// its nested `name:` lines are the evidence, never sibling fields of the
// finding, and the candidate round-trips through the validator's grammar.
import { describe, expect, it } from "vitest";
import {
  candidateItem,
  evidenceQuotesAnchor,
  parseScanAnswer,
} from "@quickchatai/pi-quickreview/src/scan/scan.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const HEAD = "FINDINGS pass-sm-lifecycle SCAN c1 @abc123";

const STATE_ANSWER = [
  HEAD,
  "- path: src/orders.ts",
  "  line: 42",
  "  kind: state-machine",
  "  severity: P2",
  "  claim: a cancelled order can still be shipped",
  "  evidence: |",
  "    state-var:   src/orders.ts:12 — order.status",
  "    state:       status = cancelled",
  "    event:       src/orders.ts:40 — ship(order)",
  "    compare:     n/a",
  "    trace:       1. open --cancel--> cancelled (src/orders.ts:30)",
  "                 2. cancelled --ship--> shipped (src/orders.ts:42)",
  "",
  '    unguarded:   src/orders.ts:42 — `order.status = "shipped"` runs with no status check',
  "    path:        src/other.ts:9 — a nested hop, not the finding's own path",
  "    property:    absence — a cancelled order is never shipped",
  "    consequence: the customer is charged for a cancelled order",
  "    guards:      none in ship()",
  "    proof-gaps:  none",
  "  detail: ship() never reads status",
].join("\n");

const ANCHORED = ['  order.status = "shipped";'];

describe("scan evidence block scalar", () => {
  it("reads the nested lines as the evidence, not as fields of the finding", () => {
    const { candidates, dropped } = parseScanAnswer(STATE_ANSWER);
    expect(dropped).toBe(0);
    expect(candidates).toHaveLength(1);
    const c = candidates[0]!;
    // MUTATION: drop the block-scalar branch in parseItems — evidence is "|"
    // and every assertion below on its lines fails.
    expect(c.evidence).not.toBe("|");
    expect(c.evidence).toContain("state-var:   src/orders.ts:12 — order.status");
    expect(c.evidence).toContain("1. open --cancel--> cancelled (src/orders.ts:30)");
    expect(c.evidence).toContain("2. cancelled --ship--> shipped (src/orders.ts:42)");
    expect(c.evidence).toContain("unguarded:   src/orders.ts:42");
    expect(c.evidence).toContain("proof-gaps:  none");
    expect(c.evidence!.split("\n")[0]).toBe("state-var:   src/orders.ts:12 — order.status");
    // The nested `path:` is evidence; the finding keeps its own path.
    expect(c.path).toBe("src/orders.ts");
    expect(c.start).toBe(42);
    // The field after the block is the finding's again.
    expect(c.detail).toBe("ship() never reads status");
  });

  it("round-trips through the validator's grammar", () => {
    const c = parseScanAnswer(STATE_ANSWER).candidates[0]!;
    const item = candidateItem(c);
    expect(item).toContain("  evidence: |\n    state-var:");
    const again = parseScanAnswer(`${HEAD}\n${item}`).candidates;
    expect(again).toHaveLength(1);
    expect(again[0]!.evidence).toBe(c.evidence);
    expect(again[0]!.path).toBe("src/orders.ts");
    expect(again[0]!.detail).toBe(c.detail);
  });

  it("a backticked anchor quote inside the block counts as quoting the anchor", () => {
    const c = parseScanAnswer(STATE_ANSWER).candidates[0]!;
    expect(evidenceQuotesAnchor(c.evidence, ANCHORED)).toBe(true);
  });

  it("the security family's block reads the same way", () => {
    const answer = [
      "FINDINGS pass-sec-injection SCAN c1 @abc123",
      "- path: src/db.ts",
      "  line: 7-9",
      "  kind: injection",
      "  claim: user input reaches a raw query",
      "  evidence: |",
      "    source:      src/api.ts:3 — req.query.q, trust: untrusted",
      "    sink:        src/db.ts:8 — `db.raw(sql)`",
      "    path:        src/api.ts:3 -> src/db.ts:8",
      "    cwe:         CWE-89",
    ].join("\n");
    const c = parseScanAnswer(answer).candidates[0]!;
    expect(c.path).toBe("src/db.ts");
    expect(c.start).toBe(7);
    expect(c.end).toBe(9);
    expect(c.evidence).toBe(
      [
        "source:      src/api.ts:3 — req.query.q, trust: untrusted",
        "sink:        src/db.ts:8 — `db.raw(sql)`",
        "path:        src/api.ts:3 -> src/db.ts:8",
        "cwe:         CWE-89",
      ].join("\n"),
    );
  });

  // MUTATION: compute closeBlock's indent with Math.min(...lines) — the
  // spread overflows the call stack, and this fails.
  it(
    "a block of hundreds of thousands of lines is read, not thrown",
    { timeout: HEAVY_TIMEOUT_MS },
    () => {
      const body = Array.from({ length: 300_000 }, (_, i) => `    trace: ${i}`);
      const answer = [
        HEAD,
        "- path: src/orders.ts",
        "  line: 42",
        "  claim: a cancelled order can still be shipped",
        "  evidence: |",
        ...body,
        "  detail: ship() never reads status",
      ].join("\n");
      const c = parseScanAnswer(answer).candidates[0]!;
      expect(c.evidence!.split("\n")).toHaveLength(300_000);
      expect(c.evidence!.startsWith("trace: 0\n")).toBe(true);
      expect(c.detail).toBe("ship() never reads status");
    },
  );

  it("a single-line evidence keeps its legacy shape, continuation lines joined", () => {
    const answer = [
      HEAD,
      "- path: src/orders.ts",
      "  line: 42",
      "  claim: a cancelled order can still be shipped",
      '  evidence: L42 `order.status = "shipped"`',
      "    runs with no status check",
      "  fix: check status first",
    ].join("\n");
    const c = parseScanAnswer(answer).candidates[0]!;
    expect(c.evidence).toBe('L42 `order.status = "shipped"` runs with no status check');
    expect(c.fix).toBe("check status first");
    expect(candidateItem(c)).toContain(
      '  evidence: L42 `order.status = "shipped"` runs with no status check',
    );
    expect(evidenceQuotesAnchor(c.evidence, ANCHORED)).toBe(true);
  });
});
