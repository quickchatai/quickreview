// ledger-pin's compaction hook against pi 1.0.0's real contract. pi silently
// ignores any field it does not read (a top-level `instructions`, `summary`,
// `retainedTail` or `details` on the hook result does nothing), so the
// contract here is not restated from memory: it is parsed out of verbatim
// excerpts of pi 1.0.0's shipped dist (tests/fixtures/pi-1.0.0/, provenance and sha256s in
// their headers), so a hook result that drifts from what pi reads fails here.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import {
  createLedgerPin,
  ledgerPinConfigFromEnv,
  type CompactFn,
  fenceFor,
  LEDGER_ENTRY_TYPE,
  PIN_CLOSE,
  PIN_OPEN,
  pinnedBlock,
  pinnedCompaction,
  stripPinned,
} from "../extensions/ledger-pin.js";

type PiCompactionPreparation = SessionBeforeCompactEvent["preparation"];
type PiEventContext = Pick<ExtensionContext, "modelRegistry" | "model" | "thinkingLevel">;
type PiEventHandler = (event: Record<string, unknown>, ctx?: PiEventContext) => unknown;

const FIXTURES = resolve(process.cwd(), "tests", "fixtures", "pi-1.0.0");
const CONTRACT = readFileSync(join(FIXTURES, "compaction-contract.d.ts.txt"), "utf8");
const CONSUMER = readFileSync(join(FIXTURES, "agent-session-compact.js.txt"), "utf8");

/** `{ name: optional? }` for each member of `export interface <name> … {…}`. */
function interfaceFields(name: string): Map<string, boolean> {
  const m = new RegExp(`export interface ${name}(?:<[^>]*>)? \\{([\\s\\S]*?)\\n\\}`).exec(CONTRACT);
  if (!m) throw new Error(`interface ${name} not in the fixture`);
  const fields = new Map<string, boolean>();
  for (const line of (m[1] as string).split("\n")) {
    const f = /^\s{4}(\w+)(\??):/.exec(line);
    if (f) fields.set(f[1] as string, f[2] === "?");
  }
  return fields;
}

const RESULT_KEYS = interfaceFields("SessionBeforeCompactResult");
const COMPACTION_FIELDS = interfaceFields("CompactionResult");
/** The fields pi's own compact() copies off an extension's compaction. */
const CONSUMED = [...CONSUMER.matchAll(/extensionCompaction\.(\w+)/g)].map((m) => m[1] as string);

const OWN =
  "LEDGER PR #42 @ abc1234\nF1 [P1/0.9][delivery] a.py:3 — x → open thread:9\nSETTLED: T1: conceded";
const META = "PR #42 — the title";

function prep(over: Partial<PiCompactionPreparation> = {}): PiCompactionPreparation {
  return {
    firstKeptEntryId: "e-17",
    tokensBefore: 123_456,
    messagesToSummarize: [],
    turnPrefixMessages: [],
    isSplitTurn: false,
    ...over,
  } as PiCompactionPreparation;
}

/** A partial ctx: the fake model and registry carry only what ledger-pin reads. */
function ctxWith(over: Partial<Record<keyof PiEventContext, unknown>> = {}): PiEventContext {
  return {
    model: { provider: "openai-codex", id: "gpt-6.1-sol" },
    thinkingLevel: "high",
    modelRegistry: {
      getApiKeyAndHeaders: vi.fn(async () => ({
        ok: true as const,
        apiKey: "tok",
        headers: { "x-h": "1" },
        baseUrl: "https://base.example",
        env: { E: "1" },
      })),
      streamSimple: vi.fn(() => "stream"),
    },
    ...over,
  } as unknown as PiEventContext;
}

const defaultSummary = (): CompactFn =>
  vi.fn(async (p: PiCompactionPreparation) => ({
    summary: "## Goal\npi's own default summary\n\n<read-files>\na.py\n</read-files>",
    firstKeptEntryId: p.firstKeptEntryId,
    tokensBefore: p.tokensBefore,
    usage: { input: 1, output: 2 },
    details: { readFiles: ["a.py"], modifiedFiles: [] },
  })) as unknown as CompactFn;

describe("the pi 1.0.0 contract fixture (parsed, not restated)", () => {
  it("a session_before_compact result is { cancel?, compaction? } and nothing else", () => {
    expect([...RESULT_KEYS.entries()]).toEqual([
      ["cancel", true],
      ["compaction", true],
    ]);
  });

  it("CompactionResult requires summary, firstKeptEntryId and tokensBefore", () => {
    const required = [...COMPACTION_FIELDS].filter(([, opt]) => !opt).map(([k]) => k);
    expect(required).toEqual(["summary", "firstKeptEntryId", "tokensBefore"]);
  });

  it("pi copies exactly these fields off an extension's compaction", () => {
    expect(new Set(CONSUMED)).toEqual(
      new Set(["summary", "firstKeptEntryId", "tokensBefore", "usage", "details"]),
    );
    expect(CONSUMER).toMatch(/if \(result\?\.compaction\)/);
    expect(CONSUMER).toMatch(/if \(result\?\.cancel\)/);
  });

  it("compact() is a package-root export and appendEntry takes (customType, data?)", () => {
    expect(CONTRACT).toMatch(
      /export \{[^}]*\bcompact\b[^}]*\} from "\.\/core\/compaction\/index\.js"/,
    );
    expect(CONTRACT).toContain("appendEntry<T = unknown>(customType: string, data?: T): void;");
    expect(CONSUMER).toContain("appendEntry: (customType, data) =>");
  });
});

describe("pinnedCompaction — a real compaction with the ledger appended verbatim", () => {
  it("returns only keys pi reads, every required field typed right, the ledger verbatim", async () => {
    const compactFn = defaultSummary();
    const pinned = pinnedBlock(META, OWN);
    const result = await pinnedCompaction(
      { preparation: prep(), customInstructions: "focus", signal: new AbortController().signal },
      ctxWith(),
      pinned,
      compactFn,
      () => {},
    );
    expect(result).toBeDefined();
    for (const key of Object.keys(result!)) expect(RESULT_KEYS.has(key)).toBe(true);
    const c = result!.compaction!;
    for (const key of Object.keys(c)) expect(COMPACTION_FIELDS.has(key)).toBe(true);
    for (const [field, optional] of COMPACTION_FIELDS)
      if (!optional) expect(c).toHaveProperty(field);
    expect(typeof c.summary).toBe("string");
    expect(c.firstKeptEntryId).toBe("e-17");
    expect(c.tokensBefore).toBe(123_456);
    // pi's default summary first, untouched; the pinned block after it.
    expect(c.summary.startsWith("## Goal\npi's own default summary")).toBe(true);
    expect(c.summary.endsWith(pinned)).toBe(true);
    expect(c.summary).toContain(`\n${OWN}\n`);
    expect(c.usage).toEqual({ input: 1, output: 2 });
    expect(c.details).toEqual({ readFiles: ["a.py"], modifiedFiles: [] });
  });

  it("calls pi's compact() the way pi's own _runDefaultCompaction does", async () => {
    const compactFn = defaultSummary();
    const ctx = ctxWith();
    const signal = new AbortController().signal;
    const old = `older summary\n\n${pinnedBlock(META, "LEDGER PR #42 @ 0000000\nstale")}`;
    await pinnedCompaction(
      { preparation: prep({ previousSummary: old }), customInstructions: "focus", signal },
      ctx,
      pinnedBlock(META, OWN),
      compactFn,
      () => {},
    );
    const call = (compactFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    // compact(preparation, model, apiKey, headers, customInstructions, signal, thinkingLevel, streamFn, env)
    expect(call).toHaveLength(9);
    const [p, model, apiKey, headers, custom, sig, thinking, streamFn, env] = call;
    // The previous pinned copy is stripped before the summariser sees it.
    expect((p as PiCompactionPreparation).previousSummary).toBe("older summary");
    expect((p as PiCompactionPreparation).firstKeptEntryId).toBe("e-17");
    expect(model).toEqual({
      provider: "openai-codex",
      id: "gpt-6.1-sol",
      baseUrl: "https://base.example",
    });
    expect(apiKey).toBe("tok");
    expect(headers).toEqual({ "x-h": "1" });
    expect(custom).toBe("focus");
    expect(sig).toBe(signal);
    expect(thinking).toBe("high");
    expect(env).toEqual({ E: "1" });
    // The stream function is the registry's streamSimple (pi's agent streamFn).
    expect((streamFn as (a: unknown, b: unknown, c: unknown) => unknown)("m", "c", "o")).toBe(
      "stream",
    );
    expect(ctx.modelRegistry!.streamSimple).toHaveBeenCalledWith("m", "c", "o");
  });

  it.each([
    [
      "no compact() export",
      (): Parameters<typeof pinnedCompaction> => [
        { preparation: prep() },
        ctxWith(),
        "P",
        undefined,
      ],
    ],
    [
      "no preparation",
      (): Parameters<typeof pinnedCompaction> => [{}, ctxWith(), "P", defaultSummary()],
    ],
    [
      "no model",
      (): Parameters<typeof pinnedCompaction> => [
        { preparation: prep() },
        ctxWith({ model: undefined }),
        "P",
        defaultSummary(),
      ],
    ],
    [
      "no registry",
      (): Parameters<typeof pinnedCompaction> => [
        { preparation: prep() },
        ctxWith({ modelRegistry: undefined }),
        "P",
        defaultSummary(),
      ],
    ],
    [
      "auth refused",
      (): Parameters<typeof pinnedCompaction> => [
        { preparation: prep() },
        ctxWith({
          modelRegistry: {
            getApiKeyAndHeaders: async () => ({ ok: false as const, error: "No API key" }),
            streamSimple: () => undefined,
          },
        }),
        "P",
        defaultSummary(),
      ],
    ],
    [
      "the summariser throws",
      (): Parameters<typeof pinnedCompaction> => [
        { preparation: prep() },
        ctxWith(),
        "P",
        (async () => {
          throw new Error("terminated");
        }) as unknown as CompactFn,
      ],
    ],
  ])(
    "%s ⇒ undefined (pi runs its default compaction), logged, never a cancel",
    async (_why, args) => {
      const log = vi.fn();
      const [event, ctx, pinned, fn] = args();
      expect(await pinnedCompaction(event, ctx, pinned, fn, log)).toBeUndefined();
      expect(log).toHaveBeenCalledTimes(1);
      expect(String(log.mock.calls[0]![0])).toContain("pi runs its default compaction");
    },
  );
});

describe("pinnedBlock / stripPinned", () => {
  it("fences the ledger with a fence longer than any backtick run inside it", () => {
    const ledger = "LEDGER PR #42 @ abc1234\nF1 quotes ```js\ncode``` and ````x````";
    expect(fenceFor(ledger)).toBe("`````");
    const block = pinnedBlock("", ledger);
    expect(block.startsWith(PIN_OPEN)).toBe(true);
    expect(block.endsWith(PIN_CLOSE)).toBe(true);
    expect(block).toContain(`\n\`\`\`\`\`\n${ledger}\n\`\`\`\`\`\n`);
  });

  it("strips every pinned copy and nothing else", () => {
    const s = `head\n\n${pinnedBlock(META, OWN)}\nmiddle\n${pinnedBlock("", OWN)}`;
    expect(stripPinned(s)).toBe("head\nmiddle");
    expect(stripPinned("no pin here\n")).toBe("no pin here");
    expect(stripPinned(`kept\n${PIN_OPEN}\nunterminated`)).toBe("kept");
  });
});

describe("the session_before_compact handler as registered", () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  const KEYS = ["QCR_PR", "QCR_SESSION_NAME", "QCR_LEDGER_FILE", "QCR_PR_META"];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qcr-ledger-compact-"));
    for (const k of KEYS) saved[k] = process.env[k];
    process.env.QCR_PR = "42";
    process.env.QCR_SESSION_NAME = "pr-42";
    process.env.QCR_LEDGER_FILE = join(dir, "pr-42.md");
    process.env.QCR_PR_META = META;
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function register(compactFn: CompactFn | undefined) {
    const handlers = new Map<string, PiEventHandler>();
    const appendEntry = vi.fn();
    const pi = { on: (e: string, h: PiEventHandler) => handlers.set(e, h), appendEntry };
    void createLedgerPin(
      ledgerPinConfigFromEnv(process.env, process.cwd(), { loadCompact: async () => compactFn }),
    )(pi as unknown as ExtensionAPI);
    return { handler: handlers.get("session_before_compact")!, appendEntry };
  }

  /** branchEntries in pi 1.0.0's SessionEntry message shape. */
  const entries = (...texts: string[]) =>
    texts.map((text, i) => ({
      type: "message",
      id: `e-${i}`,
      message: { role: "assistant", content: [{ type: "text", text }] },
    }));

  it("finds the newest own ledger in branchEntries, persists it with appendEntry(customType, data), pins it", async () => {
    const { handler, appendEntry } = register(defaultSummary());
    const newer = "LEDGER PR #42 @ fff9999\nF1 → fixed@fff9999\nSETTLED: T1: conceded";
    const result = (await handler(
      {
        type: "session_before_compact",
        preparation: prep(),
        branchEntries: entries(OWN, "chatter", newer),
        reason: "manual",
        willRetry: false,
        signal: new AbortController().signal,
      },
      ctxWith(),
    )) as { compaction: { summary: string } };
    expect(appendEntry).toHaveBeenCalledTimes(1);
    const [customType, data] = appendEntry.mock.calls[0]!;
    expect(typeof customType).toBe("string");
    expect(customType).toBe(LEDGER_ENTRY_TYPE);
    expect(data).toEqual({ pr: 42, ledger: newer, meta: META });
    expect(result.compaction.summary).toContain(`\n${newer}\n`);
    expect(result.compaction.summary).not.toContain("@ abc1234");
    expect(readFileSync(join(dir, "pr-42.md"), "utf8").trim()).toBe(newer);
  });

  it("no own ledger ⇒ no entry, no result: pi's default compaction, untouched", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const compactFn = defaultSummary();
    const { handler, appendEntry } = register(compactFn);
    const result = await handler(
      { preparation: prep(), branchEntries: entries("LEDGER PR #7 @ 1234567\nsibling") },
      ctxWith(),
    );
    expect(result).toBeUndefined();
    expect(appendEntry).not.toHaveBeenCalled();
    expect(compactFn).not.toHaveBeenCalled();
  });

  it("the package without compact() ⇒ undefined, but the ledger entry is still persisted", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { handler, appendEntry } = register(undefined);
    expect(
      await handler({ preparation: prep(), branchEntries: entries(OWN) }, ctxWith()),
    ).toBeUndefined();
    expect(appendEntry).toHaveBeenCalledWith(LEDGER_ENTRY_TYPE, {
      pr: 42,
      ledger: OWN,
      meta: META,
    });
  });
});
