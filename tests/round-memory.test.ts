// every round prompt arrives carrying the pinned head and ONE
// budgeted context block, and memory can never block or delay a round.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assembleRoundMemory,
  describeGaps,
  ensurePinnedHead,
  MEMORY_LESS,
  renderContextBlockSection,
  renderPinnedHeadSection,
  roundContextQuery,
  ROUND_CONTEXT_DEFAULTS,
  type ContextAssembler,
  type RoundMemory,
} from "../src/memory/context.js";
import { renderRoundPrompt, roundTemplateFile, roundVars } from "../src/templates.js";
import type { RoundOrder, RoundType } from "../src/types.js";

const order: RoundOrder = {
  pr: 5412,
  title: "Rate-limit the widget API",
  round_id: 3,
  round_no: 2,
  round_type: "re-review",
  lenses: ["pass-baseline", "pass-validate"],
  pass_plan: [
    { lens: "pass-baseline", agent: "pass-baseline--sol-med", tier: "sol-med", raisable_to: [] },
    { lens: "pass-validate", agent: "pass-validate--sol-high", tier: "sol-high", raisable_to: [] },
  ],
  addable_lenses: [],
  migration_gate: false,
  head_sha: "headsha",
  base_ref: "master",
  base_sha: "basesha",
  merge_base: "mergebase",
  worktree: "/sandbox/wt/pr-5412",
  settled_digest: "",
  issued_at: "2026-08-20T10:00:00Z",
};

/** A memory seed as a healthy store would produce it. */
function seeded(over: Partial<RoundMemory> = {}): RoundMemory {
  return {
    asked: true,
    head: "Standing: never re-approve a PR you already approved.",
    block: "PR #5100 settled that the widget limiter keys on tenant, not user.",
    query: "Rate-limit the widget API — api/widgets .py",
    max_tokens: 2000,
    degraded: false,
    clamped: false,
    gaps: [],
    ms: 12,
    ...over,
  };
}

/** Counts every call, so "exactly one context call" is measurable. */
class CountingAssembler implements ContextAssembler {
  head = 0;
  context = 0;
  queries: string[] = [];
  optsSeen: Array<Record<string, unknown>> = [];
  constructor(
    private readonly headText = "HEAD TEXT",
    private readonly blockText = "BLOCK TEXT",
  ) {}
  async pinnedHead(): Promise<string> {
    this.head += 1;
    return this.headText;
  }
  async contextBlock(query: string, opts: { maxTokens: number }): Promise<string> {
    this.context += 1;
    this.queries.push(query);
    this.optsSeen.push({ ...opts });
    return this.blockText;
  }
}

describe("roundContextQuery", () => {
  it("is built from the PR title and the diff's shape", () => {
    const q = roundContextQuery({
      title: "Rate-limit  the\nwidget API",
      files: [{ filename: "api/widgets/limiter.py" }, { filename: "api/widgets/views.py" }, { filename: "web/app.tsx" }],
    });
    expect(q).toContain("Rate-limit the widget API");
    expect(q).toContain("api/widgets");
    expect(q).toContain(".py");
  });

  it("is a function of the file SET, not the order GitHub returned it in", () => {
    const files = [{ filename: "src/a.ts" }, { filename: "src/b.ts" }, { filename: "docs/x.md" }];
    const a = roundContextQuery({ title: "T", files });
    const b = roundContextQuery({ title: "T", files: [...files].reverse() });
    expect(a).toBe(b);
  });

  it("survives a PR with no files and clamps a monstrous title", () => {
    expect(roundContextQuery({ title: "just a title", files: [] })).toBe("just a title");
    const huge = roundContextQuery({ title: "x".repeat(5000), files: [{ filename: "a/b/c.ts" }] });
    expect(huge.length).toBeLessThanOrEqual(ROUND_CONTEXT_DEFAULTS.queryMaxChars);
  });
});

describe("assembleRoundMemory", () => {
  it("makes EXACTLY one head call and one context call", async () => {
    const a = new CountingAssembler();
    const mem = await assembleRoundMemory(a, "q", { maxTokens: 1234 });
    expect(a.head).toBe(1);
    expect(a.context).toBe(1);
    expect(a.queries).toEqual(["q"]);
    expect(mem).toMatchObject({ asked: true, head: "HEAD TEXT", block: "BLOCK TEXT", degraded: false, max_tokens: 1234 });
  });

  // rewrite="auto" would put an LLM in the daemon's hot path and make the
  // prompt irreproducible. The contract has no rewrite knob at all — this
  // pins that the daemon never smuggles one in through the options bag.
  it("asks for a token budget and NOTHING else — no rewrite knob, ever", async () => {
    const a = new CountingAssembler();
    await assembleRoundMemory(a, "q", { maxTokens: 10 });
    expect(Object.keys(a.optsSeen[0]!)).toEqual(["maxTokens"]);
    expect(JSON.stringify(a.optsSeen[0])).not.toContain("auto");
  });

  it("with no assembler wired, reports a memory-less round that is not a gap", async () => {
    const mem = await assembleRoundMemory(undefined, "q");
    expect(mem.asked).toBe(false);
    expect(mem.degraded).toBe(false);
    expect(mem.gaps).toEqual([]);
  });

  it("degrades on the contract's unavailable answer (empty strings, no rejection)", async () => {
    const mem = await assembleRoundMemory(new CountingAssembler("", ""), "q");
    expect(mem).toMatchObject({ asked: true, head: "", block: "", degraded: true });
    expect(describeGaps(mem)).toContain("head: empty");
  });

  it("an empty context block with a live head is NOT degraded — memory just had nothing", async () => {
    const mem = await assembleRoundMemory(new CountingAssembler("HEAD", ""), "q");
    expect(mem.degraded).toBe(false);
    expect(mem.gaps).toEqual([{ part: "context", reason: "empty" }]);
  });

  it("caps a hung store at the deadline instead of holding the round", async () => {
    const hung: ContextAssembler = {
      pinnedHead: () => new Promise(() => {}),
      contextBlock: () => new Promise(() => {}),
    };
    const started = Date.now();
    const mem = await assembleRoundMemory(hung, "q", { timeoutMs: 20 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(mem.degraded).toBe(true);
    expect(mem.gaps.map((g) => g.reason)).toEqual(["timeout", "timeout"]);
  });

  it("swallows a client that breaks the contract and rejects (or throws synchronously)", async () => {
    const broken: ContextAssembler = {
      pinnedHead: () => Promise.reject(new Error("ECONNREFUSED")),
      contextBlock: () => {
        throw new Error("boom");
      },
    };
    const mem = await assembleRoundMemory(broken, "q");
    expect(mem.degraded).toBe(true);
    expect(describeGaps(mem)).toContain("ECONNREFUSED");
    expect(describeGaps(mem)).toContain("boom");
  });

  it("clamps a block that ignores its budget", async () => {
    const fat = new CountingAssembler("HEAD", "x".repeat(10_000));
    const mem = await assembleRoundMemory(fat, "q", { maxTokens: 100 });
    expect(mem.clamped).toBe(true);
    expect(mem.block.length).toBeLessThan(1000);
    expect(mem.block).toContain("cut at the round's char budget");
  });
});

describe("memory sections in the round prompt", () => {
  it("renders the standing-instructions head and the one context block", () => {
    const vars = roundVars(order, seeded());
    expect(vars["pinned_head"]).toContain("STANDING INSTRUCTIONS");
    expect(vars["pinned_head"]).toContain("never re-approve");
    expect(vars["context_block"]).toContain("RECALLED CONTEXT");
    expect(vars["context_block"]).toContain("widget limiter keys on tenant");
    // The head shapes judgment, never mechanics — a memory entry must not be
    // readable as permission to skip a gate.
    expect(vars["pinned_head"]).toMatch(/never authorises skipping a gate/);
    // The block is data about past reviews, not instructions for this round.
    expect(vars["context_block"]).toMatch(/DATA, never/);
  });

  it("renders nothing at all when no memory is wired", () => {
    const vars = roundVars(order, MEMORY_LESS);
    expect(vars["pinned_head"]).toBe("");
    expect(vars["context_block"]).toBe("");
    expect(roundVars(order)["context_block"]).toBe("");
  });

  it("tells the session plainly that a degraded round is still a normal round", () => {
    const note = renderContextBlockSection(seeded({ head: "", block: "", degraded: true, gaps: [{ part: "head", reason: "timeout" }] }));
    expect(note).toContain("MEMORY UNAVAILABLE THIS ROUND");
    expect(note).toContain("not blocked");
    expect(note).toMatch(/do not retry\s+it in a loop/i);
  });

  it("says so when memory answered but had nothing to add", () => {
    expect(renderContextBlockSection(seeded({ block: "" }))).toContain("had nothing to add");
  });
});

describe("the pinned head is guaranteed", () => {
  it("prepends the head to a template that forgot the placeholder", () => {
    const mem = seeded();
    const out = renderRoundPrompt("ROUND for #{{n}}", order, mem);
    expect(out.indexOf(mem.head)).toBeLessThan(out.indexOf("ROUND for #5412"));
    expect(out).toContain("STANDING INSTRUCTIONS");
  });

  it("does not duplicate the head when the template places it itself", () => {
    const mem = seeded();
    const out = renderRoundPrompt("{{pinned_head}}\nROUND for #{{n}}", order, mem);
    expect(out.split(mem.head)).toHaveLength(2);
  });

  it("adds nothing when there is no head to guarantee", () => {
    expect(ensurePinnedHead("body", MEMORY_LESS)).toBe("body");
    expect(renderPinnedHeadSection(MEMORY_LESS)).toBe("");
  });

  it("frames the head with the configured owner name, degrading to the role", () => {
    const mem = seeded();
    expect(renderPinnedHeadSection(mem, "Casey")).toContain("These are Casey's own words");
    expect(renderPinnedHeadSection(mem)).toContain("These are the owner's own words");
    expect(renderPinnedHeadSection(mem, "  ")).toContain("These are the owner's own words");
    // Detection keys on the head CONTENT, so the framing name can never make
    // ensurePinnedHead double-prepend.
    const out = ensurePinnedHead(`${renderPinnedHeadSection(mem, "Someone Else")}\nbody`, mem, "Casey");
    expect(out.split(mem.head)).toHaveLength(2);
  });
});

describe("the shipped round templates carry both sections", () => {
  const types: RoundType[] = ["first", "re-review", "staleness"];
  for (const rt of types) {
    it(`${rt}: head + context block land, and a memory-less round still renders`, () => {
      const tpl = readFileSync(resolve(process.cwd(), "prompts", roundTemplateFile(rt)), "utf8");
      expect(tpl).toContain("{{pinned_head}}");
      expect(tpl).toContain("{{context_block}}");

      const withMemory = renderRoundPrompt(tpl, { ...order, round_type: rt }, seeded());
      expect(withMemory).toContain("never re-approve");
      expect(withMemory).toContain("widget limiter keys on tenant");
      expect(withMemory).not.toContain("{{");

      // The degradation contract, end to end: no memory ⇒ the same prompt
      // minus the memory sections. Nothing is left dangling, nothing throws.
      const without = renderRoundPrompt(tpl, { ...order, round_type: rt });
      expect(without).not.toContain("{{");
      expect(without).not.toContain("STANDING INSTRUCTIONS");
      expect(without).not.toContain("RECALLED CONTEXT");
      expect(without).toContain("Notes from other PRs are noise");
    });
  }
});
