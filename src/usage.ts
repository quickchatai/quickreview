// Round usage measurement from pi session JSONLs. Verdict files
// self-report spend_usd but the models copy the template's example figure, so
// real accounting reads the session store instead: per-session dirs at
// <root>/<cfg.pi.session_dir>/<session>/*.jsonl. Lines are JSON records; the
// interesting ones are {type:"message", timestamp, message:{role, usage:{input,
// output, ...}}} (assistant messages carry usage) and model_change records
// {provider, modelId} which set the attribution for subsequent messages.
//
// The subagent tool's isolated child processes do NOT get --session-dir, so their
// transcripts land in the pi HOME global store (~/.pi/agent/sessions, in the
// container /home/review/.pi/agent/sessions). Those files carry no session
// marker we control, so they are matched by file mtime falling inside the
// round window — strictly best-effort, surfaced via `passes_included`.
//
// Everything here is pure logic over injectable fs reads: malformed lines,
// missing dirs and unreadable files are skipped, never thrown.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface UsageFs {
  /** Directory entries (names, not paths). Missing dir → throw or [] — both fine. */
  readDir?: (dir: string) => string[];
  readFile?: (path: string) => string;
  /** mtime in epoch ms — the global-store window match. */
  statMtimeMs?: (path: string) => number;
  /** Directory probe for global-store recursion. */
  isDir?: (path: string) => boolean;
}

export interface MeasureRoundUsageOpts extends UsageFs {
  sessionDir: string;
  /** pi HOME global session store (pass transcripts). Optional, best-effort. */
  globalStoreDir?: string;
  /** ISO round window, inclusive on both ends. */
  startedAt: string;
  finishedAt: string;
}

export interface ModelUsage {
  in: number;
  out: number;
}

export interface RoundUsage {
  tokens_in: number;
  /** Output tokens INCLUDING reasoning tokens (pi reports them separately). */
  tokens_out: number;
  tokens_cache_read: number;
  /** Sum of pi's own per-record usage.cost.total (USD) — the primary cost
   * source, verified live on the VM. Null when no record in the window
   * carried a cost object. */
  cost_usd: number | null;
  models: Record<string, ModelUsage>;
  /** True when at least one global-store (pass/subagent) file matched. */
  passes_included: boolean;
}

const defaultFs: Required<UsageFs> = {
  readDir: (dir) => readdirSync(dir),
  readFile: (path) => readFileSync(path, "utf8"),
  statMtimeMs: (path) => statSync(path).mtimeMs,
  isDir: (path) => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
};

function fsOf(opts: UsageFs): Required<UsageFs> {
  return {
    readDir: opts.readDir ?? defaultFs.readDir,
    readFile: opts.readFile ?? defaultFs.readFile,
    statMtimeMs: opts.statMtimeMs ?? defaultFs.statMtimeMs,
    isDir: opts.isDir ?? defaultFs.isDir,
  };
}

interface JsonlRecord {
  type?: unknown;
  timestamp?: unknown;
  provider?: unknown;
  modelId?: unknown;
  message?: {
    role?: unknown;
    // Live-verified shape (VM): {input, output, cacheRead, cacheWrite,
    // reasoning, totalTokens, cost: {input, output, cacheRead, cacheWrite, total}}.
    usage?: { input?: unknown; output?: unknown; cacheRead?: unknown; reasoning?: unknown; cost?: { total?: unknown } };
  };
  [k: string]: unknown;
}

function parseTs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v !== "string") return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Accumulate one file's records. `windowMs` = null means "whole file counts"
 * (global-store files already matched by mtime). */
function sumFile(text: string, windowMs: { start: number; end: number } | null, acc: RoundUsage): void {
  let model = "unknown";
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: JsonlRecord;
    try {
      rec = JSON.parse(trimmed) as JsonlRecord;
    } catch {
      continue; // malformed line — skipped, never thrown
    }
    if (typeof rec !== "object" || rec === null) continue;
    // model_change records re-key attribution for everything after them.
    if (typeof rec.modelId === "string" && rec.modelId.length > 0) {
      model = typeof rec.provider === "string" && rec.provider.length > 0 ? `${rec.provider}/${rec.modelId}` : rec.modelId;
    }
    if (rec.type !== "message") continue;
    const msg = rec.message;
    if (typeof msg !== "object" || msg === null) continue;
    if (msg.role !== "assistant") continue;
    const usage = msg.usage;
    if (typeof usage !== "object" || usage === null) continue;
    if (windowMs) {
      const ts = parseTs(rec.timestamp);
      if (ts === null) continue; // no timestamp → cannot place in the window
      if (ts < windowMs.start || ts > windowMs.end) continue; // inclusive bounds
    }
    const tin = num(usage.input);
    const tout = num(usage.output) + num(usage.reasoning); // reasoning is output we paid for
    const cache = num(usage.cacheRead);
    const costTotal = usage.cost && typeof usage.cost === "object" ? usage.cost.total : undefined;
    if (typeof costTotal === "number" && Number.isFinite(costTotal)) {
      acc.cost_usd = (acc.cost_usd ?? 0) + costTotal; // pi's own accounting — primary
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

/** Recursively collect *.jsonl paths under `dir` (bounded depth, best-effort). */
function jsonlFilesUnder(dir: string, fs: Required<UsageFs>, depth = 6): string[] {
  if (depth < 0) return [];
  let names: string[];
  try {
    names = fs.readDir(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    const path = join(dir, name);
    if (name.endsWith(".jsonl")) out.push(path);
    else if (fs.isDir(path)) out.push(...jsonlFilesUnder(path, fs, depth - 1));
  }
  return out;
}

/** Token usage for one round: session-dir records inside [startedAt,
 * finishedAt] plus (best-effort) global-store files whose mtime falls inside
 * the window. Never throws. */
export function measureRoundUsage(opts: MeasureRoundUsageOpts): RoundUsage {
  const fs = fsOf(opts);
  const acc: RoundUsage = { tokens_in: 0, tokens_out: 0, tokens_cache_read: 0, cost_usd: null, models: {}, passes_included: false };
  const start = parseTs(opts.startedAt);
  const end = parseTs(opts.finishedAt);
  if (start === null || end === null) return acc;
  const window = { start, end };

  // 1. The session's own dir: line-level timestamp filter.
  let names: string[] = [];
  try {
    names = fs.readDir(opts.sessionDir);
  } catch {
    names = [];
  }
  for (const name of names.filter((n) => n.endsWith(".jsonl")).sort()) {
    try {
      sumFile(fs.readFile(join(opts.sessionDir, name)), window, acc);
    } catch {
      /* unreadable file — best-effort */
    }
  }

  // 2. Global store (pass subagents): whole files matched by mtime.
  if (opts.globalStoreDir) {
    for (const path of jsonlFilesUnder(opts.globalStoreDir, fs)) {
      try {
        const mtime = fs.statMtimeMs(path);
        if (mtime < start || mtime > end) continue;
        sumFile(fs.readFile(path), null, acc);
        acc.passes_included = true;
      } catch {
        /* best-effort */
      }
    }
  }
  return acc;
}

/** Raw JSONL lines for the round window — the exec-policy audit surface.
 * Session-dir lines are timestamp-filtered; global-store files matched by
 * mtime contribute all their lines. Never throws. */
export function collectWindowLines(opts: MeasureRoundUsageOpts): string[] {
  const fs = fsOf(opts);
  const start = parseTs(opts.startedAt);
  const end = parseTs(opts.finishedAt);
  if (start === null || end === null) return [];
  const out: string[] = [];

  let names: string[] = [];
  try {
    names = fs.readDir(opts.sessionDir);
  } catch {
    names = [];
  }
  for (const name of names.filter((n) => n.endsWith(".jsonl")).sort()) {
    let text: string;
    try {
      text = fs.readFile(join(opts.sessionDir, name));
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const ts = parseTs((JSON.parse(trimmed) as JsonlRecord).timestamp);
        if (ts === null || ts < start || ts > end) continue;
      } catch {
        continue;
      }
      out.push(trimmed);
    }
  }

  if (opts.globalStoreDir) {
    for (const path of jsonlFilesUnder(opts.globalStoreDir, fs)) {
      try {
        const mtime = fs.statMtimeMs(path);
        if (mtime < start || mtime > end) continue;
        for (const line of fs.readFile(path).split("\n")) {
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

// ---- pricing ---------------------------------------------------------------

export interface ModelPricing {
  input_per_mtok: number;
  output_per_mtok: number;
}

/** USD estimate over per-model token counts. Returns null when any model in
 * play has no price entry — an honest "unknown" beats a silent undercount.
 * Lookup tolerates the provider prefix: "openai-codex/gpt-x" matches either
 * the full key or a bare "gpt-x" pricing entry. */
export function estimateUsd(models: Record<string, ModelUsage>, pricing: Record<string, ModelPricing>): number | null {
  let usd = 0;
  for (const [model, usage] of Object.entries(models)) {
    const bare = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
    const price = pricing[model] ?? pricing[bare];
    if (!price) return null;
    usd += (usage.in / 1_000_000) * price.input_per_mtok + (usage.out / 1_000_000) * price.output_per_mtok;
  }
  return usd;
}

// ---- exec-policy audit -----------------------------------------------------

/** Programs whose appearance in a session bash command means the no-exec
 * policy was violated (post-hoc audit; the live guard is extensions/bash-guard). */
const EXEC_VIOLATION_RE = /\b(?:python3?|pytest|uv|npm|npx|node|make|pip3?|poetry|cargo|go (?:run|test))\b/;

/** Pull every bash toolCall command out of a record, wherever it nests. */
function bashCommandsIn(value: unknown, out: string[], depth = 8): void {
  if (depth < 0 || typeof value !== "object" || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) bashCommandsIn(item, out, depth - 1);
    return;
  }
  const obj = value as Record<string, unknown>;
  const toolName = obj.toolName ?? obj.name ?? obj.tool;
  if (toolName === "bash") {
    for (const argsKey of ["arguments", "input", "args", "params"]) {
      const args = obj[argsKey];
      if (typeof args === "object" && args !== null) {
        const cmd = (args as Record<string, unknown>).command;
        if (typeof cmd === "string") out.push(cmd);
      }
    }
    if (typeof obj.command === "string") out.push(obj.command);
  }
  for (const v of Object.values(obj)) bashCommandsIn(v, out, depth - 1);
}

/** Bash commands in the given JSONL lines that ran a forbidden executor.
 * Deduplicated, order-preserving; malformed lines skipped. */
export function auditExecViolations(lines: string[]): string[] {
  const violations = new Set<string>();
  for (const line of lines) {
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const commands: string[] = [];
    bashCommandsIn(rec, commands);
    for (const cmd of commands) {
      if (EXEC_VIOLATION_RE.test(cmd)) violations.add(cmd);
    }
  }
  return [...violations];
}
