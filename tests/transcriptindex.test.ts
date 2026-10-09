// The transcript index (H2, the 2026-10-08 health check). Until this
// slice every round end read every top-level .jsonl of the PR's pi session dir
// with `readFileSync` and JSON-parsed every line, twice (usage, then the
// exec-policy audit), on the daemon's own thread — the 16.8 s loop stall of
// 08:51:31Z. These pin the slice's contract:
//
//   1. the answers are the old ones EXACTLY — usage, cost (to the last float
//      bit), per-model attribution and the classified audit — over multi-file
//      dirs, the global store, any chunk size, and a file appended between
//      calls; the oracle below IS the old code, byte for byte;
//   2. a 50 MB session dir is read as many event-loop turns, never more than
//      one chunk parsed between two turns;
//   3. a session file whose mtime predates the round is not read, and a file
//      already measured is resumed from its offset;
//   4. what cannot be read makes the usage UNKNOWN, never a partial sum —
//      and what is not there (gone since the listing, or not a regular file)
//      is absent, never unknown.
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  nodeTranscriptFs,
  TranscriptIndex,
  type TranscriptFs,
  type TranscriptMeasureOpts,
} from "../src/transcriptindex.js";
import { auditExecViolationDetails, type ExecViolation, type RoundUsage } from "../src/usage.js";
import { MemoryTranscriptFs } from "./helpers/memory-transcript-fs.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

// ---- the oracle: the pre-H2 measurement, verbatim -------------------------
// `src/usage.ts` at 75c9aa50 (sumFile, jsonlFilesUnder, measureRoundUsage,
// collectWindowLines), over the real filesystem, synchronously — exactly what
// the daemon ran. Only its `defaultFs` is inlined; nothing else is changed.

interface OldJsonlRecord {
  type?: unknown;
  timestamp?: unknown;
  provider?: unknown;
  modelId?: unknown;
  message?: {
    role?: unknown;
    usage?: {
      input?: unknown;
      output?: unknown;
      cacheRead?: unknown;
      reasoning?: unknown;
      cost?: { total?: unknown };
    };
  };
  [k: string]: unknown;
}

function oldParseTs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v !== "string") return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

function oldNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function oldSumFile(
  text: string,
  windowMs: { start: number; end: number } | null,
  acc: RoundUsage,
): void {
  let model = "unknown";
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: OldJsonlRecord;
    try {
      rec = JSON.parse(trimmed) as OldJsonlRecord;
    } catch {
      continue;
    }
    if (typeof rec !== "object" || rec === null) continue;
    if (typeof rec.modelId === "string" && rec.modelId.length > 0) {
      model =
        typeof rec.provider === "string" && rec.provider.length > 0
          ? `${rec.provider}/${rec.modelId}`
          : rec.modelId;
    }
    if (rec.type !== "message") continue;
    const msg = rec.message;
    if (typeof msg !== "object" || msg === null) continue;
    if (msg.role !== "assistant") continue;
    const usage = msg.usage;
    if (typeof usage !== "object" || usage === null) continue;
    if (windowMs) {
      const ts = oldParseTs(rec.timestamp);
      if (ts === null) continue;
      if (ts < windowMs.start || ts > windowMs.end) continue;
    }
    const tin = oldNum(usage.input);
    const tout = oldNum(usage.output) + oldNum(usage.reasoning);
    const cache = oldNum(usage.cacheRead);
    const costTotal = usage.cost && typeof usage.cost === "object" ? usage.cost.total : undefined;
    if (typeof costTotal === "number" && Number.isFinite(costTotal)) {
      acc.cost_usd = (acc.cost_usd ?? 0) + costTotal;
    }
    if (tin === 0 && tout === 0 && cache === 0) continue;
    acc.tokens_in += tin;
    acc.tokens_out += tout;
    acc.tokens_cache_read += cache;
    const m = (acc.models[model] ??= { in: 0, out: 0 });
    m.in += tin;
    m.out += tout;
  }
}

const isDirSync = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

function oldJsonlFilesUnder(dir: string, depth = 6): string[] {
  if (depth < 0) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    const path = join(dir, name);
    if (name.endsWith(".jsonl")) out.push(path);
    else if (isDirSync(path)) out.push(...oldJsonlFilesUnder(path, depth - 1));
  }
  return out;
}

function oldMeasureRoundUsage(opts: TranscriptMeasureOpts): RoundUsage {
  const acc: RoundUsage = {
    tokens_in: 0,
    tokens_out: 0,
    tokens_cache_read: 0,
    cost_usd: null,
    models: {},
    passes_included: false,
    // child usage from subagent tool results is new; no fixture here
    // carries one, so the old answer has none.
    children_included: false,
  };
  const start = oldParseTs(opts.startedAt);
  const end = oldParseTs(opts.finishedAt);
  if (start === null || end === null) return acc;
  const window = { start, end };
  let names: string[] = [];
  try {
    names = readdirSync(opts.sessionDir);
  } catch {
    names = [];
  }
  for (const name of names.filter((n) => n.endsWith(".jsonl")).sort()) {
    try {
      oldSumFile(readFileSync(join(opts.sessionDir, name), "utf8"), window, acc);
    } catch {
      /* unreadable file — best-effort */
    }
  }
  if (opts.globalStoreDir) {
    for (const path of oldJsonlFilesUnder(opts.globalStoreDir)) {
      try {
        const mtime = statSync(path).mtimeMs;
        if (mtime < start || mtime > end) continue;
        oldSumFile(readFileSync(path, "utf8"), null, acc);
        acc.passes_included = true;
      } catch {
        /* best-effort */
      }
    }
  }
  return acc;
}

function oldCollectWindowLines(opts: TranscriptMeasureOpts): string[] {
  const start = oldParseTs(opts.startedAt);
  const end = oldParseTs(opts.finishedAt);
  if (start === null || end === null) return [];
  const out: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(opts.sessionDir);
  } catch {
    names = [];
  }
  for (const name of names.filter((n) => n.endsWith(".jsonl")).sort()) {
    let text: string;
    try {
      text = readFileSync(join(opts.sessionDir, name), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const ts = oldParseTs((JSON.parse(trimmed) as OldJsonlRecord).timestamp);
        if (ts === null || ts < start || ts > end) continue;
      } catch {
        continue;
      }
      out.push(trimmed);
    }
  }
  if (opts.globalStoreDir) {
    for (const path of oldJsonlFilesUnder(opts.globalStoreDir)) {
      try {
        const mtime = statSync(path).mtimeMs;
        if (mtime < start || mtime > end) continue;
        for (const line of readFileSync(path, "utf8").split("\n")) {
          const trimmed = line.trim();
          if (trimmed) out.push(trimmed);
        }
      } catch {
        /* best-effort */
      }
    }
  }
  return out;
}

/** What the daemon recorded before H2: the usage, and the audit over the
 * collected window lines. */
function oldMeasure(opts: TranscriptMeasureOpts): {
  usage: RoundUsage;
  violations: ExecViolation[];
} {
  return {
    usage: oldMeasureRoundUsage(opts),
    violations: auditExecViolationDetails(oldCollectWindowLines(opts)),
  };
}

// ---- fixtures ---------------------------------------------------------------

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qcr-transcripts-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const START = "2026-08-14T10:00:00.000Z";
const END = "2026-08-14T10:30:00.000Z";
const at = (min: number, sec = 0): string =>
  new Date(Date.parse(START) + min * 60_000 + sec * 1000).toISOString();

const header = (ts: string): string =>
  JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: ts, cwd: "/opt/quickreview" });
const modelChange = (ts: string, provider: string, modelId: string): string =>
  JSON.stringify({ type: "model_change", id: "m", timestamp: ts, provider, modelId });
const assistant = (
  ts: string | number | undefined,
  usage: Record<string, unknown>,
  content: unknown[] = [{ type: "text", text: "Reviewing the diff — ł ą ś 😀" }],
): string =>
  JSON.stringify({
    type: "message",
    id: "a",
    ...(ts === undefined ? {} : { timestamp: ts }),
    message: { role: "assistant", content, usage },
  });
const bashCall = (ts: string, command: string): string =>
  assistant(ts, { input: 3, output: 1 }, [
    { type: "toolCall", id: "t", name: "bash", arguments: { command } },
  ]);
const writeCall = (ts: string, path: string): string =>
  assistant(ts, { input: 2, output: 1 }, [
    { type: "toolCall", id: "w", name: "write", arguments: { path, content: "x" } },
  ]);
const toolResult = (ts: string, bytes: number): string =>
  JSON.stringify({
    type: "message",
    id: "r",
    timestamp: ts,
    message: {
      role: "toolResult",
      toolName: "bash",
      content: [{ type: "text", text: `ł😀 ${"o".repeat(bytes)}\nline two` }],
    },
  });
const user = (ts: string): string =>
  JSON.stringify({
    type: "message",
    id: "u",
    timestamp: ts,
    message: { role: "user", content: [{ type: "text", text: "go" }], usage: { input: 999 } },
  });

/** A session file covering before, inside and after the window, with every
 * shape the old reader had a rule for. Costs are floats whose sum depends on
 * the order they are added in. */
function sessionLines(tag: string): string[] {
  return [
    header(at(-30)),
    modelChange(at(-30), "openai-codex", `gpt-6.1-sol-${tag}`),
    user(at(-29)),
    assistant(at(-20), { input: 1000, output: 100, cost: { total: 0.1 } }), // before
    bashCall(at(-19), "python3 before-window.py"), // before: not audited
    assistant(at(0), { input: 10, output: 1, cacheRead: 7, cost: { total: 0.1 } }), // at start
    assistant(Date.parse(at(1)), { input: 11, output: 2, reasoning: 5, cost: { total: 0.2 } }), // epoch-ms ts
    "{not json at all",
    "",
    "   ",
    "null",
    "42",
    '"a string"',
    JSON.stringify([{ name: "bash", arguments: { command: "npm test" } }]), // an array line
    assistant(undefined, { input: 5000, output: 5000 }), // no timestamp: never in a window
    toolResult(at(2), 300),
    bashCall(at(3), "git diff | head"), // a read
    bashCall(at(4), "uv run pytest tests/"), // interpreter
    bashCall(at(5), "gh pr review 5849 --approve"), // github write
    writeCall(at(6), "wt/pr-5849/.git/config"), // git config surface
    writeCall(at(7), "config.toml"), // policy surface
    modelChange(at(8), "openai-codex", `gpt-mini-${tag}`),
    assistant(at(9), { input: 3, output: 0, cost: { total: 0.30000000000000004 } }),
    assistant(at(10), { input: 0, output: 0, cacheRead: 0, cost: { total: 0.7 } }), // cost only
    assistant(at(11), { input: 1, output: 1, cost: { total: Number.NaN } }), // not finite
    assistant(at(12), { input: 1, output: 1, cost: 5 }), // not an object
    bashCall(at(13), "uv run pytest tests/"), // a repeat: deduplicated
    JSON.stringify({
      type: "message",
      timestamp: at(14),
      provider: "anthropic",
      modelId: `same-line-${tag}`,
      message: { role: "assistant", usage: { input: 9, output: 9 } },
    }), // modelId and usage on one line: attributed to the NEW model
    assistant(at(30), { input: 30, output: 3, cost: { total: 0.05 } }), // at end
    assistant(at(31), { input: 7777, output: 777, cost: { total: 9 } }), // after
    bashCall(at(32), "make after-window"), // after: not audited
  ];
}

function writeSession(dir: string, name: string, lines: string[], trailingNewline = true): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, lines.join("\n") + (trailingNewline ? "\n" : ""));
  return path;
}

/** A global store: nested pass transcripts, one inside the window by mtime,
 * one before it, and a directory a `.jsonl` name does not make a file. */
function writeGlobalStore(dir: string): void {
  const inside = writeSession(join(dir, "--opt-quickreview--", "deep"), "pass-a.jsonl", [
    modelChange(at(1), "openai-codex", "gpt-pass"),
    assistant("not-a-timestamp", { input: 100, output: 10, cost: { total: 0.25 } }),
    bashCall(at(2), "node evil.js"),
    JSON.stringify([{ name: "bash", arguments: { command: "cargo build" } }]),
  ]);
  const old = writeSession(join(dir, "old"), "pass-0.jsonl", [
    assistant(at(1), { input: 5555, output: 555 }),
  ]);
  writeSession(dir, "pass-b.jsonl", [assistant(at(3), { input: 40, output: 4 })], false);
  const t = (iso: string): Date => new Date(iso);
  utimesSync(inside, t(at(15)), t(at(15)));
  utimesSync(join(dir, "pass-b.jsonl"), t(at(16)), t(at(16)));
  utimesSync(old, t(at(-60)), t(at(-60)));
}

const window = (sessionDir: string, globalStoreDir?: string): TranscriptMeasureOpts => ({
  sessionDir,
  ...(globalStoreDir ? { globalStoreDir } : {}),
  startedAt: START,
  finishedAt: END,
});

async function measured(idx: TranscriptIndex, opts: TranscriptMeasureOpts) {
  const m = await idx.measure(opts);
  expect(m.unreadable).toEqual([]);
  return { usage: m.usage, violations: m.violations };
}

// ---- 1. the old answers, exactly --------------------------------------------

describe("the answers are the pre-H2 answers, exactly", () => {
  it(
    "a multi-file session dir and a nested global store, at every chunk size",
    {
      timeout: HEAVY_TIMEOUT_MS,
    },
    async () => {
      const sessionDir = join(root, "sessions", "pr-5849");
      writeSession(sessionDir, "2026-08-14T09-00-00_b.jsonl", sessionLines("b"));
      writeSession(sessionDir, "2026-08-14T08-00-00_a.jsonl", sessionLines("a"));
      // The live file: its last line is still being written (no newline).
      writeSession(sessionDir, "2026-08-14T09-30-00_c.jsonl", sessionLines("c"), false);
      writeFileSync(join(sessionDir, "notes.txt"), assistant(at(1), { input: 1, output: 1 }));
      mkdirSync(join(sessionDir, "nested"), { recursive: true });
      writeSession(join(sessionDir, "nested"), "x.jsonl", sessionLines("nested")); // not read: top level only
      const globalStoreDir = join(root, "pihome-sessions");
      writeGlobalStore(globalStoreDir);

      const opts = window(sessionDir, globalStoreDir);
      const want = oldMeasure(opts);
      // The fixture really exercises what it claims to.
      expect(want.usage.passes_included).toBe(true);
      expect(Object.keys(want.usage.models).length).toBeGreaterThan(4);
      expect(want.violations.map((v) => v.kind)).toEqual(
        expect.arrayContaining([
          "interpreter",
          "github_write",
          "git_config_surface_write",
          "policy_surface_write",
        ]),
      );
      expect(want.usage.cost_usd).not.toBe(0.1 + 0.2 + 0.30000000000000004 + 0.7 + 0.05); // order matters

      for (const chunkBytes of [7, 64, 333, 4096, 1 << 20]) {
        const got = await measured(new TranscriptIndex({ chunkBytes }), opts);
        expect(got, `chunkBytes=${chunkBytes}`).toEqual(want);
        // Bit-identical floats, not merely close.
        expect(
          Object.is(got.usage!.cost_usd, want.usage.cost_usd),
          `chunkBytes=${chunkBytes}`,
        ).toBe(true);
      }
    },
  );

  it("a file appended between calls — and any window over what was kept", async () => {
    const sessionDir = join(root, "sessions", "pr-5850");
    const live = writeSession(sessionDir, "live.jsonl", sessionLines("r1"), false);
    const globalStoreDir = join(root, "g");
    writeGlobalStore(globalStoreDir);
    const idx = new TranscriptIndex({ chunkBytes: 100 });
    const round1 = window(sessionDir, globalStoreDir);
    expect(await measured(idx, round1)).toEqual(oldMeasure(round1));

    // The partial last line is completed, then round 2 appends its own lines.
    const later = (min: number): string => new Date(Date.parse(END) + min * 60_000).toISOString();
    appendFileSync(
      live,
      `\n${[
        modelChange(later(1), "openai-codex", "gpt-r2"),
        assistant(later(2), { input: 21, output: 2, cost: { total: 0.11 } }),
        bashCall(later(3), "perl -e 1"),
        toolResult(later(4), 5000),
      ].join("\n")}\n${assistant(later(5), { input: 99, output: 9 }).slice(0, 40)}`,
    );
    const round2: TranscriptMeasureOpts = {
      sessionDir,
      globalStoreDir,
      startedAt: later(0),
      finishedAt: later(10),
    };
    expect(await measured(idx, round2)).toEqual(oldMeasure(round2));
    expect(idx.stats().incremental_scans).toBe(1);
    // Round 1's window again, now served from the kept lines.
    expect(await measured(idx, round1)).toEqual(oldMeasure(round1));
    // A window spanning both rounds.
    const both = { ...round2, startedAt: START };
    expect(await measured(idx, both)).toEqual(oldMeasure(both));
    // The partial line finished at last.
    appendFileSync(live, `${assistant(later(5), { input: 99, output: 9 }).slice(40)}\n`);
    expect(await measured(idx, round2)).toEqual(oldMeasure(round2));
  });

  it("a file replaced, shrunk or rewritten before its offset is read again from 0", async () => {
    const sessionDir = join(root, "s");
    const path = writeSession(sessionDir, "f.jsonl", sessionLines("v1"));
    const idx = new TranscriptIndex({ chunkBytes: 256 });
    const opts = window(sessionDir);
    expect(await measured(idx, opts)).toEqual(oldMeasure(opts));
    // Rewritten in place, same length, different bytes near the end.
    const text = readFileSync(path, "utf8").replace("make after-window", "make AFTER-window");
    writeFileSync(path, text.replace("gpt-mini-v1", "gpt-MINI-v1"));
    expect(await measured(idx, opts)).toEqual(oldMeasure(opts));
    // Shrunk.
    writeSession(sessionDir, "f.jsonl", sessionLines("v2").slice(0, 10));
    expect(await measured(idx, opts)).toEqual(oldMeasure(opts));
    // Replaced by a new file (a new inode).
    rmSync(path);
    writeSession(sessionDir, "f.jsonl", sessionLines("v3"));
    expect(await measured(idx, opts)).toEqual(oldMeasure(opts));
    expect(idx.stats().full_scans).toBeGreaterThanOrEqual(4);
  });

  it("concurrent round ends over one cold file share ONE read, and agree", async () => {
    const sessionDir = join(root, "s");
    writeSession(sessionDir, "f.jsonl", sessionLines("c"));
    const idx = new TranscriptIndex({ chunkBytes: 512 });
    const a = window(sessionDir);
    const b = { ...a, startedAt: at(5) };
    const [ra, rb] = await Promise.all([measured(idx, a), measured(idx, b)]);
    expect(ra).toEqual(oldMeasure(a));
    expect(rb).toEqual(oldMeasure(b));
    expect(idx.stats().full_scans).toBe(1);
  });

  it("an unparseable window and a missing session dir measure zero, as before", async () => {
    const idx = new TranscriptIndex();
    const missing = window(join(root, "none"));
    expect(await idx.measure(missing)).toEqual({
      ...oldMeasure(missing),
      unreadable: [],
    });
    const garbage = { ...missing, startedAt: "garbage" };
    expect(await idx.measure(garbage)).toEqual({ ...oldMeasure(garbage), unreadable: [] });
  });

  it("a kept-file cap only costs reads, never answers", async () => {
    const sessionDir = join(root, "s");
    writeSession(sessionDir, "a.jsonl", sessionLines("a"));
    writeSession(sessionDir, "b.jsonl", sessionLines("b"));
    const idx = new TranscriptIndex({ maxFiles: 1, maxRecords: 5 });
    const opts = window(sessionDir);
    expect(await measured(idx, opts)).toEqual(oldMeasure(opts));
    expect(await measured(idx, opts)).toEqual(oldMeasure(opts));
    expect(idx.stats().files).toBe(1);
  });
});

// ---- 2. never one synchronous span ---------------------------------------------

describe("a 50 MB session dir is read as many event-loop turns", () => {
  // ~1 KB lines: an assistant turn (usage) and a tool result, alternating.
  const block = [
    assistant(at(5), { input: 10, output: 2, cost: { total: 0.5 } }),
    toolResult(at(5), 700),
  ].join("\n");
  const blocks = Math.ceil((25 << 20) / (Buffer.byteLength(block) + 1)); // per file
  const content = `${block}\n`.repeat(blocks);
  const totalBytes = 2 * Buffer.byteLength(content); // two files

  // Twice: over the real filesystem (the production path), and over one whose
  // reads resolve without ever giving the loop a turn — so the turn after each
  // chunk is provably the index's own `yieldToLoop`, not an accident of I/O.
  // MUTATION: in src/transcriptindex.ts yield only every other chunk — the
  // second case reads 2 chunks between turns.
  it.each([
    [
      "the real filesystem",
      (): { fs?: TranscriptFs; sessionDir: string } => {
        const sessionDir = join(root, "sessions", "pr-big");
        mkdirSync(sessionDir, { recursive: true });
        writeFileSync(join(sessionDir, "a.jsonl"), content);
        writeFileSync(join(sessionDir, "b.jsonl"), content);
        return { sessionDir };
      },
    ],
    [
      "reads that never yield",
      (): { fs?: TranscriptFs; sessionDir: string } => ({
        fs: new MemoryTranscriptFs(
          { "/big/a.jsonl": content, "/big/b.jsonl": content },
          {},
          Date.parse(END),
        ),
        sessionDir: "/big",
      }),
    ],
  ])(
    "%s: a turn after every chunk, never two chunks parsed between two turns",
    { timeout: HEAVY_TIMEOUT_MS },
    async (_name, setup) => {
      expect(totalBytes).toBeGreaterThanOrEqual(50 << 20);
      const { fs, sessionDir } = setup();
      const chunk = 1 << 20;
      const idx = new TranscriptIndex({ chunkBytes: chunk, ...(fs ? { fs } : {}) });
      let turns = 0;
      let maxChunksBetweenTurns = 0;
      let lastChunks = 0;
      let ticking = true;
      const tick = (): void => {
        turns++;
        const chunks = idx.stats().chunks;
        maxChunksBetweenTurns = Math.max(maxChunksBetweenTurns, chunks - lastChunks);
        lastChunks = chunks;
        if (ticking) setImmediate(tick);
      };
      setImmediate(tick);
      const m = await idx.measure(window(sessionDir));
      ticking = false;

      expect(m.unreadable).toEqual([]);
      expect(m.usage!.tokens_in).toBe(2 * blocks * 10);
      expect(m.usage!.tokens_out).toBe(2 * blocks * 2);
      const chunks = idx.stats().chunks;
      expect(chunks).toBeGreaterThanOrEqual(Math.floor(totalBytes / chunk));
      // A turn of the loop after every chunk…
      expect(turns).toBeGreaterThanOrEqual(chunks);
      // …and no synchronous span parsed more than one chunk.
      expect(maxChunksBetweenTurns).toBe(1);
      expect(idx.stats().bytes_read).toBe(totalBytes);
    },
  );
});

// ---- 3. not read, and resumed ---------------------------------------------------

/** The real filesystem, with every open recorded. */
function spyFs(): TranscriptFs & { opened: string[]; reads: { path: string; position: number }[] } {
  const opened: string[] = [];
  const reads: { path: string; position: number }[] = [];
  return {
    opened,
    reads,
    readdir: (dir) => nodeTranscriptFs.readdir(dir),
    stat: (path) => nodeTranscriptFs.stat(path),
    open: async (path) => {
      opened.push(path);
      const fh = await nodeTranscriptFs.open(path);
      return {
        read: (buffer, offset, length, position) => {
          reads.push({ path, position });
          return fh.read(buffer, offset, length, position);
        },
        close: () => fh.close(),
      };
    },
  };
}

describe("what is read: an old file not at all, a measured file from its offset", () => {
  it("a session file whose mtime predates the round's start is not opened", async () => {
    const sessionDir = join(root, "s");
    // An earlier conversation (a session killed and reborn before this round):
    // every line, and the file's mtime, an hour before the round.
    const old = writeSession(sessionDir, "2026-08-14T08-00_old.jsonl", [
      assistant(at(-62), { input: 1, output: 1 }),
      bashCall(at(-61), "python3 old.py"),
    ]);
    utimesSync(old, new Date(at(-60)), new Date(at(-60)));
    const live = writeSession(sessionDir, "2026-08-14T09-59_live.jsonl", sessionLines("live"));
    const fs = spyFs();
    const idx = new TranscriptIndex({ fs });
    const opts = window(sessionDir);
    expect(await measured(idx, opts)).toEqual(oldMeasure(opts));
    expect(fs.opened).toEqual([live]);
    expect(idx.stats().skipped_by_mtime).toBe(1);
    // Inside the slack it is read (coarse mtimes): a minute's grace.
    utimesSync(old, new Date(at(0, -30)), new Date(at(0, -30)));
    expect(await measured(idx, opts)).toEqual(oldMeasure(opts));
    expect(fs.opened).toContain(old);
  });

  it("a file already measured is resumed from its offset, never re-read from 0", async () => {
    const sessionDir = join(root, "s");
    const live = writeSession(sessionDir, "live.jsonl", sessionLines("x"));
    const size1 = statSync(live).size;
    const fs = spyFs();
    const idx = new TranscriptIndex({ fs, chunkBytes: 4096 });
    const opts = window(sessionDir);
    await measured(idx, opts);
    expect(idx.stats()).toMatchObject({ full_scans: 1, incremental_scans: 0, bytes_read: size1 });

    const added = `${[assistant(at(20), { input: 5, output: 5 }), bashCall(at(21), "ruby -e 1")].join("\n")}\n`;
    appendFileSync(live, added);
    fs.reads.length = 0;
    expect(await measured(idx, opts)).toEqual(oldMeasure(opts));
    expect(idx.stats()).toMatchObject({ full_scans: 1, incremental_scans: 1 });
    // The tail check (≤ 512 bytes before the old end), then only the new bytes.
    expect(Math.min(...fs.reads.map((r) => r.position))).toBe(size1 - 512);
    expect(idx.stats().bytes_read).toBe(size1 + 512 + Buffer.byteLength(added));

    // Unchanged since: answered without a byte read.
    const before = idx.stats().bytes_read;
    expect(await measured(idx, opts)).toEqual(oldMeasure(opts));
    expect(idx.stats().bytes_read).toBe(before);
    expect(idx.stats().hits).toBeGreaterThanOrEqual(1);

    // Grown with its mtime unmoved (a coarse clock, or two appends inside one
    // tick): the size alone says there is more to read.
    // MUTATION: drop `cached.scanned >= st.size` from the no-read check — red.
    const { atime, mtime } = statSync(live);
    appendFileSync(live, `${assistant(at(22), { input: 6, output: 6 })}\n`);
    utimesSync(live, atime, mtime);
    expect(await measured(idx, opts)).toEqual(oldMeasure(opts));
    expect(idx.stats().incremental_scans).toBe(2);
  });
});

// ---- 4. unknown, never a partial sum ------------------------------------------

describe("an unreadable transcript makes the usage UNKNOWN", () => {
  it("a `.jsonl` that cannot be stat'ed or opened (EACCES) — the rest still audited", async () => {
    const base = Date.parse(END);
    const lines = sessionLines("ok").join("\n");
    const fs = new MemoryTranscriptFs(
      { "/s/a-live.jsonl": lines, "/s/b-denied.jsonl": lines, "/s/c-denied.jsonl": lines },
      {},
      base,
    );
    fs.statErrors.set("/s/b-denied.jsonl", "EACCES");
    fs.failOpen("/s/c-denied.jsonl", "EACCES");
    const m = await new TranscriptIndex({ fs }).measure(window("/s"));
    expect(m.usage).toBeNull();
    expect(m.unreadable).toEqual([
      { path: "/s/b-denied.jsonl", reason: expect.stringContaining("EACCES") },
      { path: "/s/c-denied.jsonl", reason: expect.stringContaining("EACCES") },
    ]);
    // What WAS read is still audited.
    const sessionDir = join(root, "s");
    writeSession(sessionDir, "a-live.jsonl", sessionLines("ok"));
    expect(m.violations).toEqual(oldMeasure(window(sessionDir)).violations);
  });

  it("a read that fails mid-file, an unlistable dir, an unreadable store subdir", async () => {
    const base = Date.parse(END);
    const fs = new MemoryTranscriptFs(
      {
        "/s/a.jsonl": sessionLines("a").join("\n"),
        "/s/b.jsonl": sessionLines("b").join("\n"),
        "/g/sub/p.jsonl": assistant(at(1), { input: 1, output: 1 }),
      },
      { "/g/sub/p.jsonl": Date.parse(at(2)) },
      base,
    );
    const idx = new TranscriptIndex({ fs, chunkBytes: 64 });
    const ok = await idx.measure({ ...window("/s", "/g") });
    expect(ok.unreadable).toEqual([]);
    expect(ok.usage).not.toBeNull();

    fs.failRead("/s/b.jsonl", "EIO");
    fs.append("/s/b.jsonl", "\n", base + 1); // changed, so it is read again
    const eio = await idx.measure(window("/s"));
    expect(eio.usage).toBeNull();
    expect(eio.unreadable).toEqual([
      { path: "/s/b.jsonl", reason: expect.stringContaining("EIO") },
    ]);

    fs.listErrors.set("/s", "EACCES");
    const denied = await idx.measure(window("/s"));
    expect(denied.usage).toBeNull();
    expect(denied.unreadable[0]).toMatchObject({ path: "/s" });
    fs.listErrors.delete("/s");

    fs.listErrors.set("/g/sub", "EACCES");
    fs.failRead("/s/b.jsonl", "");
    const store = await idx.measure(window("/s", "/g"));
    expect(store.usage).toBeNull();
    expect(store.unreadable).toEqual([
      { path: "/g/sub", reason: expect.stringContaining("EACCES") },
    ]);
  });

  it("an absent session dir or store is NOT unknown — there is simply nothing there", async () => {
    const m = await new TranscriptIndex().measure(
      window(join(root, "none"), join(root, "nostore")),
    );
    expect(m.unreadable).toEqual([]);
    expect(m.usage).toMatchObject({ tokens_in: 0, tokens_out: 0, passes_included: false });
  });

  // The review of H2: the daemon's own pi-global archiver gzips and
  // UNLINKS store files a day old while this walk awaits between its listing
  // and each stat — files that can never be inside a round's window. Gone is
  // absent, as a missing dir is; the old synchronous walk skipped them too.
  // MUTATION: push ENOENT from `statListed` (or from `readListed`) into
  // `unreadable` — red.
  it("a listed file gone before its stat or its open is absent, not unknown", async () => {
    const base = Date.parse(END);
    const inWindow = Date.parse(at(15));
    const files = {
      "/s/a.jsonl": sessionLines("a").join("\n"),
      "/s/b-gone-before-stat.jsonl": sessionLines("b").join("\n"),
      "/s/c-gone-before-open.jsonl": sessionLines("c").join("\n"),
      "/g/live/pass.jsonl": assistant(at(1), { input: 40, output: 4 }),
      "/g/old/p.jsonl": assistant(at(1), { input: 5555, output: 555 }),
    };
    const mtimes = { "/g/live/pass.jsonl": inWindow, "/g/old/p.jsonl": inWindow };
    const fs = new MemoryTranscriptFs(files, mtimes, base);
    fs.afterReaddir = (dir) => {
      if (dir === "/s") fs.remove("/s/b-gone-before-stat.jsonl");
      if (dir === "/g/old") fs.remove("/g/old/p.jsonl"); // the archiver, mid-walk
    };
    fs.afterStat = (path) => {
      if (path === "/s/c-gone-before-open.jsonl") fs.remove(path);
    };
    const m = await new TranscriptIndex({ fs }).measure(window("/s", "/g"));
    expect(m.unreadable).toEqual([]);

    // Exactly what the files still there measure.
    const rest = new MemoryTranscriptFs(
      { "/s/a.jsonl": files["/s/a.jsonl"], "/g/live/pass.jsonl": files["/g/live/pass.jsonl"] },
      mtimes,
      base,
    );
    const want = await new TranscriptIndex({ fs: rest }).measure(window("/s", "/g"));
    expect(want.unreadable).toEqual([]);
    expect(m.usage).toEqual(want.usage);
    expect(m.usage).toMatchObject({ passes_included: true });
    expect(m.violations).toEqual(want.violations);

    // ENOTDIR is absence too; any other code is not.
    const notDir = new MemoryTranscriptFs({ "/s/a.jsonl": files["/s/a.jsonl"] }, {}, base);
    notDir.statErrors.set("/s/a.jsonl", "ENOTDIR");
    expect(await new TranscriptIndex({ fs: notDir }).measure(window("/s"))).toMatchObject({
      unreadable: [],
      usage: { tokens_in: 0 },
    });
  });

  // A `.jsonl` that is not a regular file holds no transcript: the old reader
  // skipped it (readFileSync failed with EISDIR, or the store walk did), and a
  // FIFO would block a read forever. Absent — exactly the old answer — in the
  // session dir and in the store; a dangling link likewise.
  // MUTATION: in `statListed`, report a non-file as unreadable — red.
  it("a `.jsonl` that is not a regular file, or a dangling link, is the old answer: skipped", async () => {
    const sessionDir = join(root, "s");
    writeSession(sessionDir, "a-live.jsonl", sessionLines("ok"));
    mkdirSync(join(root, "elsewhere"));
    symlinkSync(join(root, "elsewhere"), join(sessionDir, "b-dir-link.jsonl"));
    symlinkSync(join(root, "nowhere.jsonl"), join(sessionDir, "c-dangling.jsonl"));
    const globalStoreDir = join(root, "g");
    writeGlobalStore(globalStoreDir);
    const dirNamedJsonl = join(globalStoreDir, "sub", "not-a-file.jsonl");
    mkdirSync(dirNamedJsonl, { recursive: true });
    writeSession(dirNamedJsonl, "inner.jsonl", [assistant(at(1), { input: 3, output: 3 })]);
    utimesSync(dirNamedJsonl, new Date(at(15)), new Date(at(15))); // inside the window
    symlinkSync(join(root, "nowhere-2.jsonl"), join(globalStoreDir, "dangling.jsonl"));

    const opts = window(sessionDir, globalStoreDir);
    const m = await new TranscriptIndex().measure(opts);
    expect(m.unreadable).toEqual([]);
    expect({ usage: m.usage, violations: m.violations }).toEqual(oldMeasure(opts));
  });
});
