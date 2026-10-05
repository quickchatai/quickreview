// Ledger carry (MC-18): every round order re-hands the PR's ledger
// from ledger-pin's mirror, bounded, saying where it came from; the ledger's
// SETTLED items become the order's settled digest. Absent / unreadable /
// foreign ledger ⇒ no section and an empty digest, never an error.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LEDGER_CARRY_MAX_CHARS,
  parseLedgerCarry,
  readLedgerCarry,
  SETTLED_DIGEST_MAX_CHARS,
  settledFromLedger,
} from "../src/ledgercarry.js";
import { renderLedgerNote, renderRoundPrompt, roundTemplateFile } from "../src/templates.js";
import type { RoundOrder, RoundType } from "../src/types.js";

const SOURCE = "/opt/quickreview/state/ledgers/pr-412.md";
const LEDGER = [
  "LEDGER PR #412 @ abc1234",
  "F1 [P1/0.9][delivery] api/limits.py:40 — limiter resets per request → open thread:77",
  "F2 [P2/0.6][baseline] api/views.py:12 — `cache.get` unchecked → fixed@abc1234",
  "SETTLED: T3: retry cap is intended | T5: naming conceded",
  "COMMITMENTS: author adds a test for the reset",
].join("\n");

const order: RoundOrder = {
  pr: 412,
  title: "Add rate limiting",
  round_id: 7,
  round_no: 2,
  round_type: "re-review",
  lenses: ["pass-security", "pass-validate"],
  pass_plan: [
    { lens: "pass-security", agent: "pass-security--sol-high", tier: "sol-high", raisable_to: [] },
    { lens: "pass-validate", agent: "pass-validate--terra-med", tier: "terra-med", raisable_to: [] },
  ],
  addable_lenses: [],
  migration_gate: false,
  head_sha: "deadbeef",
  base_ref: "master",
  base_sha: "basetip",
  merge_base: "forkpoint",
  worktree: "/sandbox/wt/pr-412",
  settled_digest: "",
  issued_at: "2026-10-05T10:00:00Z",
};

const ROUND_TYPES: RoundType[] = ["first", "re-review", "staleness"];
const template = (rt: RoundType): string =>
  readFileSync(resolve(process.cwd(), "prompts", roundTemplateFile(rt)), "utf8");

describe("parseLedgerCarry", () => {
  it("carries this PR's ledger verbatim with its header and source", () => {
    const carry = parseLedgerCarry(`\n${LEDGER}\n\n`, 412, SOURCE)!;
    expect(carry).toEqual({
      source: SOURCE,
      header: "LEDGER PR #412 @ abc1234",
      text: LEDGER,
      truncated: false,
      total_chars: LEDGER.length,
    });
  });

  it("accepts a header that lost its sha (still this PR's ledger)", () => {
    expect(parseLedgerCarry("LEDGER PR #412\nF1 open", 412, SOURCE)?.header).toBe("LEDGER PR #412");
  });

  it("refuses an empty file, a headerless one and another PR's", () => {
    expect(parseLedgerCarry("", 412, SOURCE)).toBeUndefined();
    expect(parseLedgerCarry("   \n", 412, SOURCE)).toBeUndefined();
    expect(parseLedgerCarry("notes without a header", 412, SOURCE)).toBeUndefined();
    expect(parseLedgerCarry("LEDGER PR #5288 @ 8c2edc01\nsibling", 412, SOURCE)).toBeUndefined();
  });

  it("cuts an oversize ledger at a line boundary under the cap and says so", () => {
    const big = `LEDGER PR #412 @ abc1234\n${Array.from({ length: 400 }, (_, i) => `F${i} [P2/0.5][baseline] f.py:${i} — finding ${i} → open`).join("\n")}`;
    expect(big.length).toBeGreaterThan(LEDGER_CARRY_MAX_CHARS);
    const carry = parseLedgerCarry(big, 412, SOURCE)!;
    expect(carry.truncated).toBe(true);
    expect(carry.total_chars).toBe(big.length);
    expect(carry.text.length).toBeLessThanOrEqual(LEDGER_CARRY_MAX_CHARS);
    expect(big.startsWith(`${carry.text}\n`)).toBe(true);
  });
});

describe("settledFromLedger", () => {
  it("lists each SETTLED item on its own line", () => {
    expect(settledFromLedger(LEDGER)).toBe("- T3: retry cap is intended\n- T5: naming conceded");
  });

  it("is empty when the ledger settles nothing", () => {
    expect(settledFromLedger("LEDGER PR #1 @ abcdefa\nF1 open")).toBe("");
    expect(settledFromLedger("LEDGER PR #1 @ abcdefa\nSETTLED: —")).toBe("");
    expect(settledFromLedger("LEDGER PR #1 @ abcdefa\nSETTLED: none")).toBe("");
  });

  it("stays under its cap and says how many items it left in the ledger", () => {
    const items = Array.from({ length: 200 }, (_, i) => `T${i}: settled reason number ${i}`);
    const out = settledFromLedger(`LEDGER PR #1 @ abcdefa\nSETTLED: ${items.join(" | ")}`);
    expect(out.length).toBeLessThanOrEqual(SETTLED_DIGEST_MAX_CHARS + 60);
    expect(out).toMatch(/- … \d+ more settled item\(s\) in the ledger$/);
    expect(out.startsWith("- T0: settled reason number 0\n")).toBe(true);
  });
});

describe("readLedgerCarry", () => {
  it("absent or unreadable file ⇒ no carry, empty digest, no throw", () => {
    const missing = readLedgerCarry(SOURCE, 412, () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    expect(missing).toEqual({ settled: "" });
    const denied = readLedgerCarry(SOURCE, 412, () => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    });
    expect(denied).toEqual({ settled: "" });
  });

  it("another PR's ledger in the file ⇒ nothing (fail safe, like ledger-pin)", () => {
    expect(readLedgerCarry(SOURCE, 412, () => "LEDGER PR #9 @ 1234567\nSETTLED: T1: x")).toEqual({
      settled: "",
    });
  });

  it("this PR's ledger ⇒ carry and digest", () => {
    const got = readLedgerCarry(SOURCE, 412, () => `${LEDGER}\n`);
    expect(got.carry?.text).toBe(LEDGER);
    expect(got.settled).toBe("- T3: retry cap is intended\n- T5: naming conceded");
  });
});

describe("the rendered round order", () => {
  const carried = (): RoundOrder => {
    const { carry, settled } = readLedgerCarry(SOURCE, 412, () => LEDGER);
    return { ...order, settled_digest: settled, ...(carry ? { ledger_carry: carry } : {}) };
  };

  it("renders the YOUR LEDGER section with its source, verbatim and fenced", () => {
    const note = renderLedgerNote(carried());
    expect(note).toBe(
      [
        "",
        "**YOUR LEDGER, RE-HANDED BY THE DAEMON.** Read from",
        `\`${SOURCE}\`, the copy the ledger-pin extension mirrors from the`,
        "last ledger block you wrote (header `LEDGER PR #412 @ abc1234`). It is here because",
        "compaction or a session restart can drop it from this conversation. It is",
        "your checklist, not evidence: every open entry still needs verifying at",
        "`deadbeef`. If this conversation holds a NEWER ledger block, that",
        "block wins.",
        "",
        "```",
        LEDGER,
        "```",
      ].join("\n"),
    );
  });

  for (const rt of ROUND_TYPES) {
    it(`${roundTemplateFile(rt)}: present ⇒ the section and the SETTLED items render`, () => {
      const out = renderRoundPrompt(template(rt), { ...carried(), round_type: rt });
      expect(out).toContain("**YOUR LEDGER, RE-HANDED BY THE DAEMON.**");
      expect(out).toContain(`\`\`\`\n${LEDGER}\n\`\`\``);
      expect(out).toContain(`\`${SOURCE}\``);
      expect(out).toContain("**SETTLED**\n- T3: retry cap is intended\n- T5: naming conceded");
      // Placed with the recovery note, before the first instruction section.
      expect(out.indexOf("YOUR LEDGER")).toBeLessThan(out.indexOf("## 1."));
    });

    it(`${roundTemplateFile(rt)}: absent ⇒ no section, and byte-identical to an order without the field`, () => {
      const without = renderRoundPrompt(template(rt), { ...order, round_type: rt });
      expect(without).not.toContain("YOUR LEDGER");
      expect(without).toContain("**SETTLED**\n(nothing settled yet)");
      const { carry, settled } = readLedgerCarry(SOURCE, 412, () => {
        throw new Error("ENOENT");
      });
      const absent = renderRoundPrompt(template(rt), {
        ...order,
        round_type: rt,
        settled_digest: settled,
        ...(carry ? { ledger_carry: carry } : {}),
      });
      expect(absent).toBe(without);
    });

    it(`${roundTemplateFile(rt)}: oversize ⇒ cut, and the order says where the rest is`, () => {
      const big = `${LEDGER}\n${"F9 [P3/0.4][style] x.py:1 — long line → open\n".repeat(400)}`;
      const { carry, settled } = readLedgerCarry(SOURCE, 412, () => big);
      const out = renderRoundPrompt(template(rt), {
        ...order,
        round_type: rt,
        settled_digest: settled,
        ledger_carry: carry!,
      });
      expect(out).toContain(
        `TRUNCATED: this is the first ${carry!.text.length} of ${carry!.total_chars} characters.`,
      );
      expect(out).toContain(`Read the whole file, \`${SOURCE}\`, before step 1.`);
      const section = renderLedgerNote({ ...order, ledger_carry: carry! });
      expect(out).toContain(section);
      expect(section.length).toBeLessThan(LEDGER_CARRY_MAX_CHARS + 1200);
      expect(big.length).toBeGreaterThan(section.length + 5000);
    });
  }

  it("a ledger quoting a fenced block cannot close the section's fence", () => {
    const ledger = "LEDGER PR #412 @ abc1234\nF1 quotes ```py\nx = 1\n``` here";
    const { carry } = readLedgerCarry(SOURCE, 412, () => ledger);
    const note = renderLedgerNote({ ...order, ledger_carry: carry! });
    expect(note).toContain(`\n\`\`\`\`\n${ledger}\n\`\`\`\``);
  });
});

describe("the compaction promise in the round templates says what is true", () => {
  for (const rt of ROUND_TYPES) {
    it(`${roundTemplateFile(rt)}`, () => {
      const flat = template(rt).replace(/\s+/g, " ");
      expect(flat).toContain(
        "only the ledger survives compaction word for word: the compaction pins your last ledger block verbatim into its summary, and the next round's order hands it back to you from disk. Everything else survives only as a paraphrase, if at all.",
      );
      expect(template(rt)).toContain("{{recovery_note}}{{ledger_note}}");
    });
  }
});
