// Round usage and the exec-policy audit, measured through the transcript
// index: the `measureRoundUsage` / `collectWindowLines` cases. The index's own
// contract (equivalence with a direct read, the loop turns, the offsets,
// unknown) is tests/transcriptindex.test.ts.
import { describe, expect, it } from "vitest";
import { TranscriptIndex, type TranscriptMeasureOpts } from "../src/transcriptindex.js";
import { auditExecViolations, type RoundUsage } from "../src/usage.js";
import { MemoryTranscriptFs } from "./helpers/memory-transcript-fs.js";

const T = (iso: string): string => new Date(iso).toISOString();
const START = "2026-08-14T10:00:00.000Z";
const END = "2026-08-14T10:30:00.000Z";

const msg = (ts: string, input: number, output: number): string =>
  JSON.stringify({
    type: "message",
    timestamp: ts,
    message: { role: "assistant", usage: { input, output } },
  });
const userMsg = (ts: string): string =>
  JSON.stringify({
    type: "message",
    timestamp: ts,
    message: { role: "user", usage: { input: 999, output: 999 } },
  });
const modelChange = (provider: string, modelId: string): string =>
  JSON.stringify({ type: "model_change", provider, modelId, timestamp: START });

/** In-memory fs over a flat path→content map (dirs implied by prefixes).
 * A file with no mtime given was written at the window's end — in scope. */
function fakeFs(
  files: Record<string, string>,
  mtimes: Record<string, number> = {},
): MemoryTranscriptFs {
  return new MemoryTranscriptFs(files, mtimes, Date.parse(END));
}

/** The round's usage through a fresh index; a known answer is expected. */
async function measureRoundUsage(
  opts: TranscriptMeasureOpts & { fs: MemoryTranscriptFs },
): Promise<RoundUsage> {
  const { fs, ...window } = opts;
  const measured = await new TranscriptIndex({ fs }).measure(window);
  expect(measured.unreadable).toEqual([]);
  return measured.usage!;
}

describe("measureRoundUsage — through the transcript index", () => {
  it("sums assistant usage inside the window, inclusive of both boundary timestamps", async () => {
    const fs = fakeFs({
      "/s/pr-7/a.jsonl": [
        msg(T("2026-08-14T09:59:59.999Z"), 1000, 100), // just before — excluded
        msg(START, 10, 1), // at start — included
        msg(T("2026-08-14T10:15:00Z"), 20, 2), // inside — included
        msg(END, 30, 3), // at end — included
        msg(T("2026-08-14T10:30:00.001Z"), 5000, 500), // just after — excluded
      ].join("\n"),
    });
    const usage = await measureRoundUsage({
      sessionDir: "/s/pr-7",
      startedAt: START,
      finishedAt: END,
      fs,
    });
    expect(usage.tokens_in).toBe(60);
    expect(usage.tokens_out).toBe(6);
    expect(usage.passes_included).toBe(false);
  });

  it("attributes usage to models via model_change records and skips malformed lines and non-assistant roles", async () => {
    const fs = fakeFs({
      "/s/pr-7/a.jsonl": [
        msg(START, 10, 1), // before any model_change → "unknown"
        modelChange("openai-codex", "gpt-5.6-sol"),
        "{not json at all",
        userMsg(START),
        JSON.stringify({ type: "message", timestamp: START }), // no message body
        msg(END, 40, 4),
      ].join("\n"),
    });
    const usage = await measureRoundUsage({
      sessionDir: "/s/pr-7",
      startedAt: START,
      finishedAt: END,
      fs,
    });
    expect(usage.tokens_in).toBe(50);
    expect(usage.tokens_out).toBe(5);
    expect(usage.models).toEqual({
      unknown: { in: 10, out: 1 },
      "openai-codex/gpt-5.6-sol": { in: 40, out: 4 },
    });
  });

  it("returns zeros for a missing session dir and never throws", async () => {
    const fs = fakeFs({});
    const usage = await measureRoundUsage({
      sessionDir: "/nope",
      startedAt: START,
      finishedAt: END,
      fs,
    });
    expect(usage).toEqual({
      tokens_in: 0,
      tokens_out: 0,
      tokens_cache_read: 0,
      cost_usd: null,
      models: {},
      passes_included: false,
      children_included: false,
    });
  });

  it("sums pi's real cost fields: cacheRead, reasoning-inclusive output and usage.cost.total", async () => {
    const rich = (ts: string): string =>
      JSON.stringify({
        type: "message",
        timestamp: ts,
        message: {
          role: "assistant",
          usage: {
            input: 100,
            output: 20,
            cacheRead: 5000,
            cacheWrite: 700,
            reasoning: 30,
            totalTokens: 5850,
            cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.002, total: 0.033 },
          },
        },
      });
    const fs = fakeFs({
      "/s/pr-7/a.jsonl": [rich(START), rich(END), msg(END, 10, 1)].join("\n"), // last line: no cost object
    });
    const usage = await measureRoundUsage({
      sessionDir: "/s/pr-7",
      startedAt: START,
      finishedAt: END,
      fs,
    });
    expect(usage.tokens_in).toBe(210);
    expect(usage.tokens_out).toBe(101); // (20+30)*2 + 1 — reasoning counts as output
    expect(usage.tokens_cache_read).toBe(10_000);
    expect(usage.cost_usd).toBeCloseTo(0.066, 9); // only records that carry cost
  });

  it("leaves cost_usd null when no record carries a cost object", async () => {
    const fs = fakeFs({ "/s/pr-7/a.jsonl": msg(START, 10, 1) });
    const usage = await measureRoundUsage({
      sessionDir: "/s/pr-7",
      startedAt: START,
      finishedAt: END,
      fs,
    });
    expect(usage.cost_usd).toBeNull();
  });

  it("returns zeros on an unparseable window", async () => {
    const fs = fakeFs({ "/s/a.jsonl": msg(START, 10, 1) });
    const usage = await measureRoundUsage({
      sessionDir: "/s",
      startedAt: "garbage",
      finishedAt: END,
      fs,
    });
    expect(usage.tokens_in).toBe(0);
  });
});

describe("lens children's usage, from the parent's tool results", () => {
  const costed = (ts: string, input: number, output: number, cost: number): string =>
    JSON.stringify({
      type: "message",
      timestamp: ts,
      message: { role: "assistant", usage: { input, output, cost: { total: cost } } },
    });
  const toolResult = (ts: string, toolName: string, results: unknown[]): string =>
    JSON.stringify({
      type: "message",
      timestamp: ts,
      message: {
        role: "toolResult",
        toolName,
        content: [],
        details: { mode: "parallel", results },
      },
    });
  const child = (
    model: string,
    input: number,
    output: number,
    cacheRead: number,
    cost: number,
  ) => ({
    agent: "pass-x",
    model,
    usage: { input, output, cacheRead, cacheWrite: 0, cost, contextTokens: 0, turns: 3 },
  });

  it("counts each child of a subagent or launch_plan result once, under its model without the thinking suffix", async () => {
    const fs = fakeFs({
      "/s/pr-7/a.jsonl": [
        modelChange("openai-codex", "gpt-6.1-sol"),
        costed(START, 100, 10, 0.1),
        toolResult(T("2026-08-14T10:10:00Z"), "launch_plan", [
          child("openai-codex/gpt-6.1-sol:high", 1000, 100, 5000, 0.5),
          child("openai-codex/gpt-6.1-sol:medium", 2000, 200, 0, 1.25),
        ]),
        toolResult(T("2026-08-14T10:20:00Z"), "subagent", [
          child("openai-codex/gpt-6.1-terra:medium", 300, 30, 0, 0.05),
        ]),
        // Not a child-bearing tool, and a result past the window: neither counts.
        toolResult(T("2026-08-14T10:21:00Z"), "read", [child("m", 9999, 9, 0, 9)]),
        toolResult(T("2026-08-14T10:31:00Z"), "subagent", [child("m", 9999, 9, 0, 9)]),
      ].join("\n"),
    });
    const usage = await measureRoundUsage({
      sessionDir: "/s/pr-7",
      startedAt: START,
      finishedAt: END,
      fs,
    });
    expect(usage.cost_usd).toBeCloseTo(0.1 + 0.5 + 1.25 + 0.05, 10);
    expect(usage.tokens_in).toBe(100 + 1000 + 2000 + 300);
    expect(usage.tokens_out).toBe(10 + 100 + 200 + 30);
    expect(usage.tokens_cache_read).toBe(5000);
    expect(usage.children_included).toBe(true);
    expect(usage.models).toEqual({
      "openai-codex/gpt-6.1-sol": { in: 3100, out: 310 },
      "openai-codex/gpt-6.1-terra": { in: 300, out: 30 },
    });
  });

  // MUTATION: cut every `:suffix` off a child's model again
  // (`replace(/:[a-z]+$/, "")`) — the id that ends in a routing suffix is
  // counted under the bare id beside it and this fails.
  it("cuts only a thinking level off a child's model: an id that holds a colon stays whole", async () => {
    const fs = fakeFs({
      "/s/pr-7/a.jsonl": toolResult(START, "subagent", [
        child("made-up/pro-5:free:high", 100, 10, 0, 0.1),
        child("made-up/pro-5:nitro", 200, 20, 0, 0.2),
        child("made-up/pro-5", 400, 40, 0, 0.4),
        child("made-up/pro-5:medium", 800, 80, 0, 0.8),
      ]),
    });
    const usage = await measureRoundUsage({
      sessionDir: "/s/pr-7",
      startedAt: START,
      finishedAt: END,
      fs,
    });
    expect(usage.models).toEqual({
      "made-up/pro-5:free": { in: 100, out: 10 },
      "made-up/pro-5:nitro": { in: 200, out: 20 },
      "made-up/pro-5": { in: 1200, out: 120 },
    });
  });

  it("a round with no child results is the main session's alone, as before", async () => {
    const fs = fakeFs({ "/s/pr-7/a.jsonl": costed(START, 100, 10, 0.1) });
    const usage = await measureRoundUsage({
      sessionDir: "/s/pr-7",
      startedAt: START,
      finishedAt: END,
      fs,
    });
    expect(usage.children_included).toBe(false);
    expect(usage.cost_usd).toBeCloseTo(0.1, 10);
  });

  it("a malformed child entry is skipped, never thrown", async () => {
    const fs = fakeFs({
      "/s/pr-7/a.jsonl": toolResult(START, "subagent", [null, "x", { model: "m" }, { usage: 3 }]),
    });
    const usage = await measureRoundUsage({
      sessionDir: "/s/pr-7",
      startedAt: START,
      finishedAt: END,
      fs,
    });
    expect(usage.tokens_in).toBe(0);
    expect(usage.cost_usd).toBeNull();
  });
});

// pi stamps a cost of exactly 0 on a call of a model it has no price for. A
// window with such a call has no dollar figure: not $0, and not the sum of the
// calls that did have a price.
describe("a call pi stamped at zero for its tokens is unpriced, never free", () => {
  const costed = (ts: string, input: number, output: number, cost: number): string =>
    JSON.stringify({
      type: "message",
      timestamp: ts,
      message: { role: "assistant", usage: { input, output, cost: { total: cost } } },
    });
  const lensResult = (ts: string, cost: number, input = 500): string =>
    JSON.stringify({
      type: "message",
      timestamp: ts,
      message: {
        role: "toolResult",
        toolName: "subagent",
        content: [],
        details: {
          mode: "parallel",
          results: [
            {
              agent: "pass-x",
              model: "some-provider/some-model:medium",
              usage: { input, output: 50, cacheRead: 0, cacheWrite: 0, cost, turns: 2 },
            },
          ],
        },
      },
    });
  const measure = (lines: string[]): Promise<RoundUsage> =>
    measureRoundUsage({
      sessionDir: "/s/pr-7",
      startedAt: START,
      finishedAt: END,
      fs: fakeFs({ "/s/pr-7/a.jsonl": lines.join("\n") }),
    });

  // MUTATION: drop the `unpriced_calls` branch from addLineUsage (sum u.cost as
  // before) - cost_usd is 0 here and this fails.
  it("a window of zero-cost calls with tokens has no cost: null, and the calls are counted", async () => {
    const usage = await measure([costed(START, 1000, 100, 0), costed(END, 2000, 200, 0)]);
    expect(usage.cost_usd).toBeNull();
    expect(usage.unpriced_calls).toBe(2);
    // The tokens are still measured: that is what makes the round "unknown".
    expect(usage.tokens_in).toBe(3000);
    expect(usage.tokens_out).toBe(300);
  });

  it("one unpriced call makes the whole window unknown, whichever side of it the priced calls are", async () => {
    for (const lines of [
      [costed(START, 100, 10, 0.4), costed(END, 1000, 100, 0)],
      [costed(START, 1000, 100, 0), costed(END, 100, 10, 0.4)],
    ]) {
      const usage = await measure(lines);
      expect(usage.cost_usd).toBeNull();
      expect(usage.unpriced_calls).toBe(1);
    }
  });

  it("an unpriced lens child does the same to its parent's window", async () => {
    const usage = await measure([costed(START, 100, 10, 0.4), lensResult(END, 0)]);
    expect(usage.cost_usd).toBeNull();
    expect(usage.unpriced_calls).toBe(1);
    expect(usage.children_included).toBe(true);
  });

  it("a zero with no tokens is a call that never reached the model: it cost nothing and hides nothing", async () => {
    const usage = await measure([costed(START, 100, 10, 0.4), costed(END, 0, 0, 0)]);
    expect(usage.cost_usd).toBeCloseTo(0.4, 10);
    expect(usage.unpriced_calls).toBeUndefined();
  });

  it("a priced window says nothing about unpriced calls", async () => {
    const usage = await measure([costed(START, 100, 10, 0.4), lensResult(END, 0.2)]);
    expect(usage.cost_usd).toBeCloseTo(0.6, 10);
    expect(usage.unpriced_calls).toBeUndefined();
  });
});

describe("auditExecViolations", () => {
  const toolCall = (command: string): string =>
    JSON.stringify({
      type: "message",
      timestamp: START,
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "bash", arguments: { command } }],
      },
    });

  it("flags exec-pattern bash commands and ignores read-only ones", () => {
    const lines = [
      toolCall("git diff | head"),
      toolCall("python3 manage.py test"),
      toolCall("uv run pytest tests/"),
      toolCall("rg -n foo src/"),
      toolCall("go test ./..."),
      "half a { record",
    ];
    expect(auditExecViolations(lines)).toEqual([
      "python3 manage.py test",
      "uv run pytest tests/",
      "go test ./...",
    ]);
  });

  it("dedupes repeated commands and ignores non-bash tools", () => {
    const other = JSON.stringify({ toolName: "read", arguments: { command: "npm test" } });
    const lines = [toolCall("npm test"), toolCall("npm test"), other];
    expect(auditExecViolations(lines)).toEqual(["npm test"]);
  });

  it("audits the round window's lines (window-filtered)", async () => {
    const fs = fakeFs({
      "/s/pr-7/a.jsonl": [
        toolCall("node evil.js"),
        JSON.stringify({
          type: "message",
          timestamp: "2026-08-14T09:00:00Z",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", name: "bash", arguments: { command: "make all" } }],
          },
        }),
      ].join("\n"),
    });
    const { violations } = await new TranscriptIndex({ fs }).measure({
      sessionDir: "/s/pr-7",
      startedAt: START,
      finishedAt: END,
    });
    // "make all" ran before the window.
    expect(violations).toEqual([{ command: "node evil.js", kind: "interpreter" }]);
  });
});
