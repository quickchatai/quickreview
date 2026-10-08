// Round usage and the exec-policy audit, measured through
// the transcript index since H2 — these are the pre-H2
// `measureRoundUsage` / `collectWindowLines` cases, unchanged in what they
// expect. The index's own contract (equivalence with the old reads, the loop
// turns, the offsets, unknown) is tests/transcriptindex.test.ts.
import { describe, expect, it } from "vitest";
import { TranscriptIndex, type TranscriptMeasureOpts } from "../src/transcriptindex.js";
import { auditExecViolations, estimateUsd, type RoundUsage } from "../src/usage.js";
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
    });
  });

  it("includes global-store files by mtime window (whole file) and flags passes_included", async () => {
    const startMs = Date.parse(START);
    const fs = fakeFs(
      {
        "/s/pr-7/a.jsonl": msg(START, 10, 1),
        "/g/deep/nested/pass1.jsonl": [
          modelChange("openai-codex", "gpt-mini"),
          msg("not-a-timestamp", 100, 10),
        ].join("\n"),
        "/g/old/pass0.jsonl": msg(START, 7777, 777),
      },
      {
        "/g/deep/nested/pass1.jsonl": startMs + 60_000, // inside window
        "/g/old/pass0.jsonl": startMs - 60_000, // before window — excluded
      },
    );
    const usage = await measureRoundUsage({
      sessionDir: "/s/pr-7",
      globalStoreDir: "/g",
      startedAt: START,
      finishedAt: END,
      fs,
    });
    // Global-store files count in full even when their line timestamps do not parse.
    expect(usage.tokens_in).toBe(110);
    expect(usage.tokens_out).toBe(11);
    expect(usage.passes_included).toBe(true);
    expect(usage.models["openai-codex/gpt-mini"]).toEqual({ in: 100, out: 10 });
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

describe("estimateUsd", () => {
  const pricing = { "gpt-5.6-sol": { input_per_mtok: 2, output_per_mtok: 8 } };

  it("prices per-mtok and tolerates a provider prefix on the model key", () => {
    const est = estimateUsd(
      { "openai-codex/gpt-5.6-sol": { in: 1_000_000, out: 500_000 } },
      pricing,
    );
    expect(est).toBeCloseTo(2 + 4, 9);
  });

  it("returns null when any model in play has no price entry", () => {
    const models = { "openai-codex/gpt-5.6-sol": { in: 1, out: 1 }, mysterious: { in: 1, out: 1 } };
    expect(estimateUsd(models, pricing)).toBeNull();
    expect(estimateUsd({ mysterious: { in: 1, out: 0 } }, {})).toBeNull();
  });

  it("returns 0 for no models in play", () => {
    expect(estimateUsd({}, {})).toBe(0);
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
