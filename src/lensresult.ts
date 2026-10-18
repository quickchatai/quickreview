// LensResult v1 and the lens ledger: the shape one lens pass reports, and the
// per-round `lens-ledger.jsonl` that records every lens (and cache warm-up)
// session the engine ran. NEUTRAL on purpose: no imports, no I/O. The daemon
// side (usage.ts feeds est_usd) and the bench consumers (cost.ts, aacr.ts,
// whatif.ts) and the pi extensions all read these shapes, so the module must
// not live under src/engine/ — the daemon may not import that tree.
//
// LensResult v1 is the SUBSET of pi's native subagent result that consumers
// read: `agent`, `model`, `usage{input,output,cacheRead,cost}`, the child's
// `messages` (with timestamps), `exitCode`, `stopReason`, `errorMessage`,
// `timedOut`. v1 adds one field the native shape never had, `id`: the lens
// run's identity, equal to the `id` of its ledger line. It is how a consumer
// counts a lens ONCE when it can see the same run twice (a `lens_wave` result
// returning a wave the engine already launched, a later `lens_wave` call
// repeating it, the ledger beside the transcript). A result with no `id` is
// the native shape: every such result counts, exactly as before.
//
// Tool names (owner ruling D3): the engine routes expose `lens` and
// `lens_wave`; the tmux bot still runs `subagent` and `launch_plan`. A consumer
// accepts all four (`isLensTool`) until the old pair is retired.

/** The tools whose result carries lens children in `details.results`. */
export const LENS_TOOL = "lens";
export const LENS_WAVE_TOOL = "lens_wave";
/** The tmux bot's spellings (pi's native subagent tool and the glue's
 * launch_plan, which returns the same result). */
export const LEGACY_LENS_TOOLS: readonly string[] = ["subagent", "launch_plan"];

const LENS_TOOLS: ReadonlySet<string> = new Set([
  LENS_TOOL,
  LENS_WAVE_TOOL,
  ...LEGACY_LENS_TOOLS,
]);

/** Whether `name` is a tool whose result lists lens children. */
export function isLensTool(name: unknown): boolean {
  return typeof name === "string" && LENS_TOOLS.has(name);
}

/** One child's summed usage over its turns; `cost` is a NUMBER (the sum of each
 * turn's cost.total), as the native result reports it. */
export interface LensUsage {
  input: number;
  output: number;
  cacheRead: number;
  cost: number;
}

/** One message of the child's transcript. Only the fields consumers read are
 * typed; the rest of a pi message rides along untyped. */
export interface LensMessage {
  role: string;
  /** Epoch ms. */
  timestamp?: number;
  content?: unknown;
  [k: string]: unknown;
}

export interface LensResult {
  /** The run's identity (= its ledger line's `id`). Absent in the native shape. */
  id?: string;
  agent: string;
  model: string;
  usage: LensUsage;
  messages: LensMessage[];
  /** 0 = finished clean; -1 = still running (parallel mode, live updates). */
  exitCode: number;
  stopReason?: string;
  errorMessage?: string;
  timedOut?: boolean;
}

export type LensLedgerKind = "lens" | "warmup";

/** One line of a round's `lens-ledger.jsonl`. `timestamp` (ISO) is the run's
 * END and is also the line's window stamp for usage.ts. A `warmup` line is a
 * cache warm-up session: real spend with no tool result of its own. */
export interface LensLedgerLine {
  v: 1;
  kind: LensLedgerKind;
  id: string;
  timestamp: string;
  started_at?: string;
  duration_ms?: number;
  agent: string;
  model: string;
  usage: LensUsage;
  exitCode?: number;
  stopReason?: string;
  errorMessage?: string;
  timedOut?: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** A usage `cost` is a number, or (an assistant message's shape) `{total}`. */
function costOf(value: unknown): number {
  return finite(record(value) ? record(value)!["total"] : value);
}

/** The usage a result or ledger line carries, every field a finite number. */
export function lensUsageOf(value: unknown): LensUsage {
  const u = record(value);
  return {
    input: finite(u?.["input"]),
    output: finite(u?.["output"]),
    cacheRead: finite(u?.["cacheRead"]),
    cost: costOf(u?.["cost"]),
  };
}

/** The run id of a result or ledger line; null when it carries none. */
export function lensIdOf(value: unknown): string | null {
  const id = record(value)?.["id"];
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** The lens children a tool result's `details.results` lists — [] for any
 * other shape. `carrier` is the tool event's `result` or `partialResult`. */
export function lensResultsOf(carrier: unknown): unknown[] {
  const results = record(record(carrier)?.["details"])?.["results"];
  return Array.isArray(results) ? (results as unknown[]) : [];
}

/**
 * Count-once bookkeeping for a consumer that can meet one lens run through
 * several carriers. `claim(id)` is true the first time an id is seen and for
 * every result with no id (the native shape); false on a repeat. Use ONE per
 * measured scope (a case, a round) — never share across scopes.
 */
export class LensOnce {
  private readonly seen = new Set<string>();

  claim(id: string | null): boolean {
    if (id === null) return true;
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    return true;
  }
}

// ---- the ledger ------------------------------------------------------------

/** A ledger line for `result`, ending at `endedAtMs`. */
export function ledgerLineOf(
  kind: LensLedgerKind,
  id: string,
  result: Omit<LensResult, "id" | "messages"> & { messages?: unknown },
  timing: { endedAtMs: number; startedAtMs?: number },
): LensLedgerLine {
  return {
    v: 1,
    kind,
    id,
    timestamp: new Date(timing.endedAtMs).toISOString(),
    ...(timing.startedAtMs !== undefined
      ? {
          started_at: new Date(timing.startedAtMs).toISOString(),
          duration_ms: Math.max(0, timing.endedAtMs - timing.startedAtMs),
        }
      : {}),
    agent: result.agent,
    model: result.model,
    usage: lensUsageOf(result.usage),
    exitCode: result.exitCode,
    ...(result.stopReason !== undefined ? { stopReason: result.stopReason } : {}),
    ...(result.errorMessage !== undefined ? { errorMessage: result.errorMessage } : {}),
    ...(result.timedOut !== undefined ? { timedOut: result.timedOut } : {}),
  };
}

/** One JSONL line, newline-terminated, ready to append. */
export function serializeLedgerLine(line: LensLedgerLine): string {
  return `${JSON.stringify(line)}\n`;
}

/** A parsed record that is a v1 ledger line: `v` 1, a `kind` of lens or
 * warmup, a non-empty `id` and a `usage` object. Anything else — a session
 * record, a future version — is not one. */
export function ledgerLineFrom(value: unknown): LensLedgerLine | null {
  const r = record(value);
  if (!r || r["v"] !== 1) return null;
  if (r["kind"] !== "lens" && r["kind"] !== "warmup") return null;
  if (lensIdOf(r) === null || !record(r["usage"])) return null;
  if (typeof r["agent"] !== "string") return null;
  return {
    v: 1,
    kind: r["kind"],
    id: r["id"] as string,
    timestamp: typeof r["timestamp"] === "string" ? r["timestamp"] : "",
    ...(typeof r["started_at"] === "string" ? { started_at: r["started_at"] } : {}),
    ...(typeof r["duration_ms"] === "number" ? { duration_ms: r["duration_ms"] } : {}),
    agent: r["agent"],
    model: typeof r["model"] === "string" ? r["model"] : "unknown",
    usage: lensUsageOf(r["usage"]),
    ...(typeof r["exitCode"] === "number" ? { exitCode: r["exitCode"] } : {}),
    ...(typeof r["stopReason"] === "string" ? { stopReason: r["stopReason"] } : {}),
    ...(typeof r["errorMessage"] === "string" ? { errorMessage: r["errorMessage"] } : {}),
    ...(typeof r["timedOut"] === "boolean" ? { timedOut: r["timedOut"] } : {}),
  };
}

/** Parse one ledger line; null for a blank, malformed or foreign line —
 * never thrown. */
export function parseLedgerLine(text: string): LensLedgerLine | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return ledgerLineFrom(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

/** Every ledger line in `text`, in file order. Split on LF only: a U+2028 or
 * U+2029 inside a JSON string is not a record boundary. */
export function parseLedger(text: string): LensLedgerLine[] {
  const out: LensLedgerLine[] = [];
  for (const raw of text.split("\n")) {
    const line = parseLedgerLine(raw);
    if (line !== null) out.push(line);
  }
  return out;
}
