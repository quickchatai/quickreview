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
// pi's NATIVE subagent children run without a saved session (or in a temp
// session dir removed when they exit), so they leave no transcript anywhere
// the walk reads; counting the main session alone undercounts a round many
// times over. Their usage IS in the parent's transcript: the `subagent` / `launch_plan`
// tool result carries `details.results[]`, each child's model and its summed
// `usage` (input, output, cacheRead, cost — native runSingleAgent). Each child
// counts there, once (`childUsage`), surfaced via `children_included`.
//
// This file owns WHAT a transcript line contributes — its usage and its
// exec-policy audit items (`parseTranscriptLine`) — and how contributions add
// up (`addLineUsage`). READING the transcripts is `transcriptindex.ts`: async,
// chunked, each line parsed once for both consumers, each byte read
// once per daemon lifetime. Everything here is pure: malformed lines are
// skipped, never thrown.
// The guard's TOKENISER — not its policy. The rules below stay an
// independent implementation on purpose (see execViolationKind).
import {
  normalizeRedirections,
  redirectTargets,
  splitShellSegments,
} from "../extensions/bash-guard.js";

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
  /** True when at least one child's usage counted from a subagent or
   * launch_plan tool result. */
  children_included: boolean;
}

/** The zero a round's usage starts from. */
export function emptyRoundUsage(): RoundUsage {
  return {
    tokens_in: 0,
    tokens_out: 0,
    tokens_cache_read: 0,
    cost_usd: null,
    models: {},
    passes_included: false,
    children_included: false,
  };
}

interface JsonlRecord {
  type?: unknown;
  timestamp?: unknown;
  provider?: unknown;
  modelId?: unknown;
  message?: {
    role?: unknown;
    toolName?: unknown;
    details?: { results?: unknown };
    // Live-verified shape (VM): {input, output, cacheRead, cacheWrite,
    // reasoning, totalTokens, cost: {input, output, cacheRead, cacheWrite, total}}.
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

/** An ISO string or epoch ms; anything else is no timestamp. */
export function parseTs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v !== "string") return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** The model attribution a file starts with, before any model_change. */
export const UNKNOWN_MODEL = "unknown";

/** One assistant message's usage, attributed to the model in effect. */
export interface LineUsage {
  model: string;
  tin: number;
  /** output + reasoning — reasoning is output we paid for. */
  tout: number;
  cache: number;
  /** pi's own `usage.cost.total`, when the record carries a finite one. */
  cost: number | null;
}

/** What one transcript line contributes to the round's two measures. A line
 * that contributes to neither is not represented at all. */
export interface LineContribution {
  /** The record's top-level timestamp — the round-window filter for a
   * session-dir line. Null when it has none (such a line never counts in a
   * window, and counts in a whole-file read). */
  ts: number | null;
  usage?: LineUsage;
  /** Each lens child's usage, from a subagent / launch_plan tool result. */
  childUsage?: LineUsage[];
  /** Its exec-policy audit items, in the order the audit meets them. */
  audit?: ExecViolation[];
}

/**
 * Parse one transcript line — ONCE, for both consumers. `model` is
 * the attribution in effect before the line; the result carries the one in
 * effect after it (a `modelId` record re-keys attribution for everything after
 * it, including an assistant message on the same line).
 *
 * The rules: for usage, a non-object record contributes nothing, only an
 * assistant message with a usage object counts, and a finite
 * `usage.cost.total` is the primary cost; for the audit (as
 * `auditExecViolationDetails`), any value JSON.parse returns is walked, and
 * the window reads its top-level `timestamp`.
 */
export function parseTranscriptLine(
  line: string,
  model: string,
): { model: string; contribution: LineContribution | null } {
  const trimmed = line.trim();
  if (!trimmed) return { model, contribution: null };
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return { model, contribution: null }; // malformed line — skipped, never thrown
  }
  // A JSON `null` record, like any value without a `timestamp`, reads as no
  // timestamp.
  const ts = value === null ? null : parseTs((value as { timestamp?: unknown }).timestamp);
  let usage: LineUsage | undefined;
  let childUsage: LineUsage[] = [];
  if (typeof value === "object" && value !== null) {
    const rec = value as JsonlRecord;
    // model_change records re-key attribution for everything after them.
    if (typeof rec.modelId === "string" && rec.modelId.length > 0) {
      model =
        typeof rec.provider === "string" && rec.provider.length > 0
          ? `${rec.provider}/${rec.modelId}`
          : rec.modelId;
    }
    usage = assistantUsage(rec, model);
    childUsage = childUsageOf(rec);
  }
  const audit = auditItemsOf(value);
  if (usage === undefined && audit.length === 0 && childUsage.length === 0)
    return { model, contribution: null };
  return {
    model,
    contribution: {
      ts,
      ...(usage !== undefined ? { usage } : {}),
      ...(childUsage.length > 0 ? { childUsage } : {}),
      ...(audit.length > 0 ? { audit } : {}),
    },
  };
}

/** The tools whose result carries the lens children's usage (native pi's
 * subagent tool and the glue's launch_plan, which returns the same result). */
const CHILD_RESULT_TOOLS = new Set(["subagent", "launch_plan"]);

/** Each child's usage in a subagent / launch_plan tool result, attributed to
 * the child's model without its `:<thinking>` suffix (the pricing table's
 * key). VERIFY-ON-PIN (pi 1.0.0, examples/extensions/subagent): a result's
 * `usage` is the child's sum over its turns — input, output, cacheRead, and
 * `cost` as a NUMBER (the sum of each turn's cost.total). */
function childUsageOf(rec: JsonlRecord): LineUsage[] {
  if (rec.type !== "message") return [];
  const msg = rec.message;
  if (typeof msg !== "object" || msg === null || msg.role !== "toolResult") return [];
  if (typeof msg.toolName !== "string" || !CHILD_RESULT_TOOLS.has(msg.toolName)) return [];
  const results = msg.details?.results;
  if (!Array.isArray(results)) return [];
  const out: LineUsage[] = [];
  for (const r of results) {
    if (typeof r !== "object" || r === null) continue;
    const { usage, model } = r as { usage?: Record<string, unknown>; model?: unknown };
    if (typeof usage !== "object" || usage === null) continue;
    const cost = usage.cost;
    out.push({
      model: typeof model === "string" && model ? model.replace(/:[a-z]+$/, "") : UNKNOWN_MODEL,
      tin: num(usage.input),
      tout: num(usage.output),
      cache: num(usage.cacheRead),
      cost: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
    });
  }
  return out;
}

function assistantUsage(rec: JsonlRecord, model: string): LineUsage | undefined {
  if (rec.type !== "message") return undefined;
  const msg = rec.message;
  if (typeof msg !== "object" || msg === null) return undefined;
  if (msg.role !== "assistant") return undefined;
  const usage = msg.usage;
  if (typeof usage !== "object" || usage === null) return undefined;
  const costTotal = usage.cost && typeof usage.cost === "object" ? usage.cost.total : undefined;
  return {
    model,
    tin: num(usage.input),
    tout: num(usage.output) + num(usage.reasoning), // reasoning is output we paid for
    cache: num(usage.cacheRead),
    cost: typeof costTotal === "number" && Number.isFinite(costTotal) ? costTotal : null,
  };
}

/** Add one in-window assistant message to the round's usage — in file order,
 * so the floating-point sums (which are order-sensitive) come out the same
 * bit for bit however the transcripts are read. */
export function addLineUsage(acc: RoundUsage, u: LineUsage): void {
  if (u.cost !== null) acc.cost_usd = (acc.cost_usd ?? 0) + u.cost; // pi's own accounting — primary
  if (u.tin === 0 && u.tout === 0 && u.cache === 0) return;
  acc.tokens_in += u.tin;
  acc.tokens_out += u.tout;
  acc.tokens_cache_read += u.cache;
  const m = (acc.models[u.model] ??= { in: 0, out: 0 });
  m.in += u.tin;
  m.out += u.tout;
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
export function estimateUsd(
  models: Record<string, ModelUsage>,
  pricing: Record<string, ModelPricing>,
): number | null {
  let usd = 0;
  for (const [model, usage] of Object.entries(models)) {
    const bare = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
    const price = pricing[model] ?? pricing[bare];
    if (!price) return null;
    usd +=
      (usage.in / 1_000_000) * price.input_per_mtok +
      (usage.out / 1_000_000) * price.output_per_mtok;
  }
  return usd;
}

// ---- exec-policy audit -----------------------------------------------------

/**
 * The post-hoc audit's vocabulary. Interpreters alone are not enough: chains
 * such as `gh pr review --approve`, `gh api … --input`,
 * `gh api -fevent=APPROVE`, `git -c alias.x=!cmd x`,
 * `git --git-dir=<dir> diff` and `HOME=<dir> git diff` execute or POST
 * without one, so each class below has its own kind.
 *
 * What this is and is not. It is TELEMETRY: a durable event and an overseer
 * line, not a control. It is deliberately an INDEPENDENT implementation rather
 * than a call into `extensions/bash-guard.ts` — a shared implementation shares
 * its blind spots, and the point of a second reader is that it fails
 * differently. It is coarse and high-recall by design: a false line costs an
 * operator ten seconds, a missing line costs the incident.
 *
 * It cannot see what leaves no recognisable spelling. That bound is real and
 * is why this is the third layer and not the second: the config-scope pin
 * (`sessionGitConfigPins`) and the write-boundary veto (`checkWritePath`) are
 * what make the innocent-command form impossible rather than merely visible.
 */
export type ExecViolationKind =
  | "interpreter"
  | "github_write"
  | "git_write"
  | "git_config_injection"
  | "git_config_surface_write"
  /** A read-only-allowlisted program (awk/sed/sort/find) used in a write or
   * exec mode, and git's read verbs in theirs: `--output=<file>` (the diff
   * options' file write) and `git grep -O<cmd>`. */
  | "reader_write_or_exec"
  /** A write landing on THIS system's own policy surface — config.toml,
   * scripts/, dist/, extensions/, prompts/agents/seeds, .pi/. The
   * one-level-out analogue of `git_config_surface_write`. */
  | "policy_surface_write"
  /** A write landing on a MEMORY-SCOPE file — the recall hint
   * (`recall-hints/<session>.json`) or the retired list
   * (`retired-uris.json`) a session's own memory recall reads.
   * Writing either widens what that recall may reach. */
  | "memory_scope_write"
  /** A write landing on a WAKE-DELIVERY file — an inject dir, the inject
   * bridge's `.done/`, or a wake file by its name. The daemon reads a wake's
   * move into `.done/` as "this turn is running". */
  | "delivery_surface_write"
  /** A session env-prefix that relocates this system's policy inputs
   * (`QCR_CONFIG=` and kin), at the top level or laundered inside a
   * `bash -c '…'` payload. */
  | "policy_relocation";

/** Interpreters. */
const EXEC_VIOLATION_RE =
  /\b(?:python3?|pytest|uv|npm|npx|node|make|pip3?|poetry|cargo|go (?:run|test)|[gmn]?awk|perl|ruby|php)\b/;

/** A `gh api` call that will not be a GET: an explicit mutating method, or any
 * body-carrying flag (gh promotes GET→POST when a body is present — the
 * `--input` form is the one the predecessor used for every review it posted). */
const GH_API_WRITE_RE =
  /\bgh\s+(?:-\S+\s+)*api\b[^\n]*?(?:-X\s*(?:POST|PATCH|PUT|DELETE)|--method[=\s]+(?:POST|PATCH|PUT|DELETE)|--input\b|--input=|--field\b|--field=|--raw-field\b|--raw-field=|(?:^|\s)-[A-Za-z]*[fF](?:\s|=|[A-Za-z_]+=))/i;

/** An explicit `-X`/`--method` on a `gh api` call. As in the guard's
 * `ghApiEffectiveMethod`, the explicit method WINS — a body flag only promotes
 * gh's default GET — so `gh api search/issues --method GET -f q=…` is a read,
 * and the LAST explicit method is the one gh sends. A quoted method
 * (`--method "GET"`) is the same token to the guard's tokenizer. */
const GH_API_EXPLICIT_METHOD_RE = /(?:^|\s)(?:-X\s*|--method[=\s]+)['"]?([A-Za-z]+)/gi;

/** Does this `gh api` segment send something other than GET/HEAD? */
function ghApiWrites(segment: string): boolean {
  if (!GH_API_WRITE_RE.test(segment)) return false;
  const api = /\bgh\s+(?:-\S+\s+)*api\b/.exec(segment);
  const args = api ? segment.slice(api.index + api[0].length) : segment;
  let explicit: string | null = null;
  for (const m of args.matchAll(GH_API_EXPLICIT_METHOD_RE)) explicit = m[1]!.toUpperCase();
  return explicit === null || (explicit !== "GET" && explicit !== "HEAD");
}

/** A `gh` subcommand that is not one of the read verbs. Expressed as the
 * complement of the read set rather than as a list of write verbs, so a verb
 * `gh` grows tomorrow is audited by default instead of being invisible until
 * someone remembers it. */
const GH_SUBCOMMAND_RE = /\bgh\s+(?:-\S+\s+)*([a-z-]+)(?:\s+(?:-\S+\s+)*([a-z-]+))?/;
const GH_AUDIT_READ_NAMESPACES = new Set(["api", "search", "status", "version", "help", "auth"]);
const GH_AUDIT_READ_VERBS = new Set([
  "view",
  "list",
  "diff",
  "checks",
  "status",
  "get-url",
  "download",
]);

/** A write reaching GitHub by some route other than `gh` — the shape a fifth
 * channel would take. `curl`/`wget` are not on the guard's allowlist, so this
 * fires only for something that already got past it. A method or a request
 * body is required: `gh api repos/o/n/pulls/5/reviews` is a legitimate GET and
 * must not be audited as a write. */
const GITHUB_DIRECT_WRITE_RE =
  /(?:api\.github\.com[^\n]*?(?:-X\s*(?:POST|PATCH|PUT|DELETE)|--request[=\s]+(?:POST|PATCH|PUT|DELETE)|(?:^|\s)(?:-d|--data|--data-raw|--data-binary|--json)\b)|(?:-X\s*(?:POST|PATCH|PUT|DELETE)|--request[=\s]+(?:POST|PATCH|PUT|DELETE))[^\n]*api\.github\.com)/i;

/** `git` verbs that write. Plain reads (`git diff`, `git log`, `git show`)
 * must NOT match — the audit runs on every round and a read-shaped false line
 * every time would train the operator to ignore the whole event. */
const GIT_WRITE_RE =
  /\bgit\s+(?:-\S+\s+|-[cC]\s+\S+\s+)*(?:push|send-pack|commit|merge|rebase|reset|revert|cherry-pick|am|apply|checkout|switch|restore|clean|stash|init|clone|update-ref|update-index|symbolic-ref|filter-branch|fast-import|gc|prune|notes|mv|rm|add)\b/;

/** Anything that changes WHICH CONFIG GIT READS, or names a program for it to
 * run. Both the option forms and their environment-prefix twins: either one
 * alone is bypassed by the other. */
const GIT_CONFIG_INJECTION_RE =
  /(?:\bgit\s+(?:-\S+\s+)*-c\s|--config-env[=\s]|--git-dir[=\s]|--work-tree[=\s]|--exec-path[=\s]|--upload-pack[=\s]|--receive-pack[=\s]|(?:^|[\s;&|(])(?:GIT_CONFIG[A-Z0-9_]*|GIT_DIR|GIT_COMMON_DIR|GIT_WORK_TREE|GIT_EXEC_PATH|GIT_EXTERNAL_DIFF|GIT_PAGER|PAGER|GIT_SSH|GIT_SSH_COMMAND|GIT_ASKPASS|GIT_EDITOR|GIT_SEQUENCE_EDITOR|GIT_PROXY_COMMAND|GIT_TEMPLATE_DIR|HOME|XDG_CONFIG_HOME|LD_PRELOAD|LD_AUDIT|BASH_ENV|ENV|PATH|SHELL|IFS|NODE_OPTIONS|PYTHONSTARTUP|PERL5OPT)=)/;

/**
 * A write landing on git's configuration surface — the class no command guard
 * can see from the command that EXPLOITS it, because that command is a plain
 * `git diff`. The write itself, however, is right there in the transcript, and
 * it is visible whether it came from bash or from the write TOOL (see
 * `writeTargetsIn`). This is the audit's only genuinely enumeration-free rule:
 * it keys on git's own documented config locations, not on an attack.
 */
const GIT_CONFIG_SURFACE_PATH_RE = /(?:^|\/)(?:\.git\/|\.gitconfig$|git\/config$|\.gitattributes$)/;

/** The operators that WRITE the word after them: a redirection (`>`, `>>`,
 * every other spelling folded onto those by `normalizeRedirections`) and the
 * diff options' `--output=<file>` / `--output <file>`, which `git log`,
 * `git show` and `git diff` write into (the guard refuses it; this is what
 * makes a write that got past it visible). */
const WRITE_OPERATOR = String.raw`(?:>>?|--output[=\s])\s*`;

/** The same surface as a bash WRITE: a redirection target, or `sed -i`'s. A
 * bare mention is not enough — `git show HEAD:.gitattributes` is a legitimate
 * read of a file the PR touched, and auditing it as a config write would be
 * the kind of routine false line that teaches an operator to skip the event. */
const GIT_CONFIG_SURFACE_WRITE_RE =
  /(?:(?:>>?|--output[=\s])\s*\S*(?:\.git\/\S*|\.gitconfig|git\/config|\.gitattributes)|\bsed\s+(?:-\S+\s+)*-[a-zA-Z]*i\S*(?:\s+\S+)*?\s+\S*(?:\.git\/\S*|\.gitconfig|git\/config|\.gitattributes))/;

/**
 * A write landing on THIS system's own policy surface — the same
 * SHAPE as `GIT_CONFIG_SURFACE_WRITE_RE`, one level out: a redirection or a
 * `sed -i` whose target is `config.toml`, an agent-context file
 * (`AGENTS.md`/`AGENTS.override.md`/`CLAUDE.md` and their `.MD` spellings —
 * the guard's `POLICY_SURFACE_FILES`), `scripts/`, `dist/`, `extensions/`
 * or a frozen-seed dir. A bare mention is not enough — a review session greps
 * and reads these paths all day, and auditing a read would be the routine false
 * line that teaches an operator to skip the event. Mirrors `isPolicySurface` in
 * the guard, kept an independent implementation on purpose. */
const POLICY_SURFACE_TARGET = String.raw`(?:\S*\/)?(?:(?:config\.toml|AGENTS\.override\.md|AGENTS\.MD|AGENTS\.md|CLAUDE\.MD|CLAUDE\.md)|(?:scripts|dist|extensions|prompts|agents|seeds|\.pi)\/\S+)`;
const POLICY_SURFACE_WRITE_RE = new RegExp(
  String.raw`(?:` +
    WRITE_OPERATOR +
    POLICY_SURFACE_TARGET +
    String.raw`|\bsed\s+(?:-\S+\s+)*-[a-zA-Z]*i\S*(?:\s+\S+)*?\s+` +
    POLICY_SURFACE_TARGET +
    String.raw`)`,
);

/** The same policy surface as a WRITE-TOOL target path: `config.toml`
 * or an agent-context file at any depth, or anything under scripts/dist/extensions/prompts/agents/seeds/.pi
 * (the built `state/agents/…` included — `agents/` follows a slash). */
const POLICY_SURFACE_PATH_RE =
  /(?:^|\/)(?:config\.toml|AGENTS\.override\.md|AGENTS\.MD|AGENTS\.md|CLAUDE\.MD|CLAUDE\.md)$|(?:^|\/)(?:scripts|dist|extensions|prompts|agents|seeds|\.pi)\//;

/**
 * A write landing on a MEMORY-SCOPE file — the same SHAPE again:
 * a redirection or a `sed -i` whose target is the recall hint dir
 * (`recall-hints/`) or the retired list (`retired-uris.json`), at any prefix.
 * A review session never writes either; the daemon does, every round. Mirrors
 * `isMemoryScopeSurface` in the guard, kept an independent implementation on
 * purpose.
 */
const MEMORY_SCOPE_TARGET = String.raw`(?:\S*\/)?(?:recall-hints(?:\/\S*)?|retired-uris\.json(?:\.tmp-\S*)?)(?=[\s;&|()<>]|$)`;
const MEMORY_SCOPE_WRITE_RE = new RegExp(
  String.raw`(?:` +
    WRITE_OPERATOR +
    MEMORY_SCOPE_TARGET +
    String.raw`|\bsed\s+(?:-\S+\s+)*-[a-zA-Z]*i\S*(?:\s+\S+)*?\s+` +
    MEMORY_SCOPE_TARGET +
    String.raw`)`,
);

/** The same memory-scope files as a WRITE-TOOL target path: the hint dir and
 * anything in it, the retired list and its atomic-write temp — the guard's
 * shapes, so the audit flags exactly what the guard refuses (a
 * `docs/recall-hints.md` or a `retired-uris.json.bak` is neither). */
const MEMORY_SCOPE_PATH_RE = /(?:^|\/)(?:recall-hints(?:\/|$)|retired-uris\.json(?:\.tmp-[^/]*)?$)/;

/**
 * A write landing on a WAKE-DELIVERY file — the same SHAPE once more: a
 * redirection or a `sed -i` whose target is under an `inject` dir or a
 * `.done` dir, or is named like a wake file (`<ISO stamp>-<seq>….md`), at any
 * prefix. Mirrors `isDeliverySurface` in the guard, kept an independent
 * implementation on purpose.
 */
const WAKE_FILE_NAME = String.raw`\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d{4,}(?:--cmd-[^/\s]*)?\.md(?:\.tmp-[^/\s]*)?`;
const DELIVERY_TARGET =
  String.raw`(?:\S*\/)?(?:inject(?:\/\S*)?|\.done(?:\/\S*)?|` +
  WAKE_FILE_NAME +
  String.raw`)(?=[\s;&|()<>]|$)`;
const DELIVERY_WRITE_RE = new RegExp(
  String.raw`(?:` +
    WRITE_OPERATOR +
    DELIVERY_TARGET +
    String.raw`|\bsed\s+(?:-\S+\s+)*-[a-zA-Z]*i\S*(?:\s+\S+)*?\s+` +
    DELIVERY_TARGET +
    String.raw`)`,
);

/** The same wake-delivery files as a WRITE-TOOL target path — the guard's
 * shapes. */
const DELIVERY_PATH_RE = new RegExp(
  String.raw`(?:^|\/)(?:inject(?:\/|$)|\.done(?:\/|$)|` + WAKE_FILE_NAME + String.raw`$)`,
);

/**
 * A write target spelled as a PATTERN: bash expands a
 * redirection target before it opens the file, so `> retired-uri[s].json`,
 * `> recall-hint?/pr-1.json`, `> config.tom?` and `> recall-hint{s..s}/…`
 * write the protected file while no literal name above matches. Each pattern
 * component (a brace group widened to `*`) is tried against the protected
 * component names and the substituted paths are classified by the path
 * rules — the guard's `protectedPatternHit` is the same idea, and this is an
 * independent implementation of it on purpose.
 */
const PATTERN_SYNTAX_RE = /[*?[]|\{[^{}]*(?:,|\.\.)[^{}]*\}/;
const SURFACE_COMPONENT_NAMES: readonly string[] = [
  ".git",
  ".gitconfig",
  "git",
  "config",
  ".gitattributes",
  "config.toml",
  "AGENTS.override.md",
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
  "scripts",
  "dist",
  "extensions",
  "prompts",
  "agents",
  "seeds",
  ".pi",
  "recall-hints",
  "retired-uris.json",
  "retired-uris.json.tmp-1",
  "inject",
  ".done",
  "2026-01-01T00-00-00-000Z-0000.md",
];

/** A shell pattern component as an anchored regex: `*`, `?`, `[…]`/`[!…]`. */
function componentPatternRe(c: string): RegExp {
  let re = "";
  for (let i = 0; i < c.length; i++) {
    const ch = c[i]!;
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else if (ch === "[" && c.indexOf("]", i + 2) > 0) {
      const close = c.indexOf("]", i + 2);
      const body = c.slice(i + 1, close);
      re += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`.replace(/\\/g, "\\\\");
      i = close;
    } else re += ch.replace(/[.+^${}()|\\/[\]]/g, "\\$&");
  }
  try {
    return new RegExp(`^${re}$`);
  } catch {
    return /^$/;
  }
}

/** Which protected surface a write-tool target path is, if any. */
function surfacePathKind(path: string): ExecViolationKind | null {
  if (GIT_CONFIG_SURFACE_PATH_RE.test(path)) return "git_config_surface_write";
  if (MEMORY_SCOPE_PATH_RE.test(path)) return "memory_scope_write";
  if (DELIVERY_PATH_RE.test(path)) return "delivery_surface_write";
  if (POLICY_SURFACE_PATH_RE.test(path)) return "policy_surface_write";
  return null;
}

/** The surface a PATTERN write target can expand onto, if any. */
function patternTargetKind(target: string): ExecViolationKind | null {
  if (!PATTERN_SYNTAX_RE.test(target)) return null;
  const parts = target.replace(/\{[^{}]*(?:,|\.\.)[^{}]*\}/g, "*").split("/");
  let paths = [""];
  for (const [k, part] of parts.entries()) {
    const options = [part];
    if (/[*?[]/.test(part)) {
      const re = componentPatternRe(part);
      for (const n of SURFACE_COMPONENT_NAMES) if (re.test(n)) options.push(n);
    }
    paths = paths.flatMap((p) => options.map((o) => (k === 0 ? o : `${p}/${o}`)));
    // Too broad to enumerate: a pattern this wide over a write is itself the
    // line — the policy surface is the widest set it could reach.
    if (paths.length > 512) return "policy_surface_write";
  }
  for (const p of paths) {
    const kind = surfacePathKind(p);
    if (kind !== null) return kind;
  }
  return null;
}

/** Every `--output` target in one (dequoted) segment. The redirection
 * targets come from the guard's quote-aware `redirectTargets` — its
 * tokeniser, borrowed like `splitShellSegments`, so a `>` inside a quoted
 * grep pattern is no write here either. */
const OUTPUT_TARGET_RE = /--output[=\s]\s*([^\s;&|()<>]+)/g;

/** A session env-prefix that relocates this system's own policy inputs — the
 * `QCR_` inputs the guard refuses in `POLICY_RELOCATING_ENV` (`QCR_INSTALL`
 * included: it names the config home the locator reads). Matched as
 * an assignment prefix at a command position (or after a separator), so a
 * laundered `bash -c 'sanctioned ; QCR_CONFIG=… script'` is seen: the string is
 * right there in the segment whether it is quoted or not. Independent of the
 * guard's own list by design. */
const POLICY_RELOCATION_RE =
  /(?:^|[\s;&|(])QCR_(?:CONFIG|INSTALL|STATE_DB|DRYRUN_DIR|POSTING_RECEIPT_DIR)=/;

/**
 * Programs whose ARGUMENTS are search patterns and paths, never commands.
 *
 * Without this the audit would read every grep pattern as if it were a
 * command, and fire on the reads that ARE the job here: `rg -n PATH= Dockerfile`,
 * `grep -n ENV= .env.example`, `rg -n 'gh pr create' .github/workflows/ci.yml`,
 * `grep -n 'git push' scripts/deploy.sh`. Reviewing a PR that touches a
 * Dockerfile, a workflow or a deploy script means grepping for exactly those
 * tokens. A routine false line teaches the operator to skip the event, which is
 * worse than silence — so the content rules do not run against a reader's
 * arguments at all.
 *
 * This does NOT make a reader invisible: its own write/exec modes are checked
 * first (below), and every OTHER segment of the pipeline is classified
 * normally, so `python3 evil.py | grep x` is still caught on its first segment.
 */
const AUDIT_READERS: ReadonlySet<string> = new Set([
  "rg",
  "grep",
  "egrep",
  "fgrep",
  "ag",
  "ack",
  "cat",
  "head",
  "tail",
  "nl",
  "wc",
  "jq",
  "cut",
  "tr",
  "uniq",
  "sort",
  "ls",
  "echo",
  "printf",
  "diff",
  "comm",
  "column",
  "find",
  "basename",
  "dirname",
  "stat",
  "sed",
  "xargs",
  "test",
  // Not `awk`: it is off the guard's ALLOWED set, so an awk invocation in a
  // transcript is itself a policy violation, classified as the interpreter it
  // is.
]);

/**
 * The write/exec MODES of the programs that are allowlisted for reading.
 * Without them the audit would be blind to the very write primitives (e.g.
 * onto `<clone>/.git/config`) that the guard's reader-mode check stops, so a
 * gap in that check would go unseen — which undercuts the point of having
 * both layers.
 *
 * This is the same SHAPE as `checkReaderModes` in the guard, as a separate
 * coarse implementation over whole segments; independence buys less here than
 * it does elsewhere in this file.
 *
 * The variable-target write — `T=.git/config; cat p >> $T` — is deliberately
 * NOT here. Its target is a variable, so no reader of command strings can ever see
 * it; that one is caught by the round-boundary integrity check in
 * `execboundary.ts`, which is why that check exists.
 *
 * `awk` has no entry: the same indirection defeats any pattern for it
 * (`print "cmd" | c`), so awk is off the guard's ALLOWED set entirely and any
 * awk at all is an `interpreter` line.
 */
const READER_MODE_AUDIT: Readonly<Record<string, RegExp>> = {
  find: /(?:^|\s)-(?:exec|execdir|ok|okdir|delete|fprintf|fprint|fprint0|fls)(?:\s|$)/,
  sort: /(?:^|\s)(?:--(?:output|compress-program)(?:=|\s)|-(?!-)[a-zA-Z]*o(?:\s|$))/,
  sed: /(?:^|\s)(?:--(?:in-place|file)|-(?!-)[a-zA-Z]*[if])|['"\s](?:[0-9$,]|\/[^/]*\/)*\s*[wWe]\s/,
  // The diff options' `--output=<file>` on any verb, and
  // `git grep`'s `--open-files-in-pager[=<cmd>]` / `-O<cmd>` (any unique
  // abbreviation of the long form; `-O` ending a short cluster).
  git: /(?:^|\s)--output(?:=|\s|$)|\bgit\s+(?:-C\s+\S+\s+|-\S+\s+)*grep\b.*?\s(?:--op[a-z-]*(?:=|\s|$)|-[A-Za-z]*O)/,
};

/** The first real program token in a segment: `VAR=val` prefixes, `env` and its
 * flags, and redirection remnants skipped — the same shape the bash guard's
 * `checkSegment` uses to find what a segment actually runs. */
function segmentProgram(segment: string): string | null {
  // `xargs` RUNS the program named after it, so it is resolved through rather
  // than treated as the program — the guard's `checkProgram` recurses for the
  // same reason. Without this, `… | xargs awk '{print}'` would classify as
  // `xargs`, which is on AUDIT_READERS, and the whole segment would be
  // skipped.
  let sawXargs = false;
  for (const raw of segment.trim().split(/\s+/)) {
    const t = raw.replace(/^['"(]+|['")]+$/g, "");
    if (t.length === 0) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue;
    if (t === "env" || (t.startsWith("-") && t.length <= 3)) continue;
    if (/^\d*[<>]/.test(t)) continue;
    const base = t.slice(t.lastIndexOf("/") + 1);
    if (sawXargs) {
      if (t.startsWith("-") || t === "{}") continue; // xargs' own flags
      return base;
    }
    if (base === "xargs") {
      sawXargs = true;
      continue;
    }
    return base;
  }
  return sawXargs ? "xargs" : null; // bare `xargs` runs echo
}

/** Whether `segment` opens ANSI-C (`$'…'`) or locale (`$"…"`) quoting
 * outside quotes — where it can spell any option; inside quotes `$'`/`$"` is
 * literal. */
function opensAnsiOrLocaleQuote(segment: string): boolean {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!;
    if (quote === "'") {
      if (c === "'") quote = null;
    } else if (c === "\\") {
      i++;
    } else if (quote === '"') {
      if (c === '"') quote = null;
    } else if (c === "$" && (segment[i + 1] === "'" || segment[i + 1] === '"')) {
      return true;
    } else if (c === "'" || c === '"') {
      quote = c;
    }
  }
  return false;
}

/** Which rule, if any, this ONE segment trips. */
function segmentViolationKind(segment: string): ExecViolationKind | null {
  // The redirection/`sed -i` surface rules run on every segment, reader or not:
  // their subject is the segment's own write target, not a quoted pattern. They
  // read the target with its quoting removed, as bash would open it — `>
  // con"fig".toml` and `> config\.toml` are `config.toml`.
  const bare = segment.replace(/["'\\]/g, "");
  if (GIT_CONFIG_SURFACE_WRITE_RE.test(bare)) return "git_config_surface_write";
  if (MEMORY_SCOPE_WRITE_RE.test(bare)) return "memory_scope_write";
  if (DELIVERY_WRITE_RE.test(bare)) return "delivery_surface_write";
  if (POLICY_SURFACE_WRITE_RE.test(bare)) return "policy_surface_write";
  // The same surfaces once more, over the writes bash would actually perform:
  // every unquoted redirection's target with its
  // quoting removed as bash removes it (`> $'retired-uris.json'`), and every
  // `--output` target — each named literally, or as a PATTERN bash expands
  // (`> retired-uri[s].json`).
  for (const target of [
    ...redirectTargets(segment),
    ...[...bare.matchAll(OUTPUT_TARGET_RE)].map((m) => m[1]!),
  ]) {
    const kind = surfacePathKind(target) ?? patternTargetKind(target);
    if (kind !== null) return kind;
  }
  const prog = segmentProgram(segment);
  if (prog !== null) {
    // Checked BEFORE the reader skip below: these programs are readers by
    // default and writers on a flag, and the flag is the whole point. git's
    // rule reads the DEQUOTED segment, as git receives its options
    // (`--out"put"=…` is `--output=…`).
    if (READER_MODE_AUDIT[prog]?.test(prog === "git" ? bare : segment))
      return "reader_write_or_exec";
    if (AUDIT_READERS.has(prog)) return null;
  }
  // A policy-relocation env prefix (`QCR_CONFIG=` and kin) — checked AFTER the
  // reader skip so `grep QCR_CONFIG=x file` (a read of a config) does not trip
  // it, but a `bash -c '… ; QCR_CONFIG=… script'` (prog is `bash`, not a
  // reader) still does.
  if (POLICY_RELOCATION_RE.test(segment)) return "policy_relocation";
  // gh is judged as it receives its words, like the guard: on the dequoted
  // segment too, and a gh or git segment opening `$'…'`/`$"…"` quoting —
  // which can spell any flag — is flagged until shown otherwise.
  if (ghApiWrites(segment) || ghApiWrites(bare) || GITHUB_DIRECT_WRITE_RE.test(segment))
    return "github_write";
  if (prog === "gh" && opensAnsiOrLocaleQuote(segment)) return "github_write";
  if (prog === "git" && opensAnsiOrLocaleQuote(segment)) return "git_config_injection";
  const gh = GH_SUBCOMMAND_RE.exec(segment);
  if (gh) {
    const ns = gh[1]!;
    const verb = gh[2];
    if (!GH_AUDIT_READ_NAMESPACES.has(ns) && verb !== undefined && !GH_AUDIT_READ_VERBS.has(verb))
      return "github_write";
  }
  if (GIT_WRITE_RE.test(segment)) return "git_write";
  if (GIT_CONFIG_INJECTION_RE.test(segment)) return "git_config_injection";
  if (EXEC_VIOLATION_RE.test(segment)) return "interpreter";
  return null;
}

/**
 * Which rule, if any, this command trips — decided PER SHELL SEGMENT.
 *
 * Not whole-command matching: a pattern in an argument to `rg` is not a
 * command, and treating it as one produces false positives on ordinary review
 * reads. Segmenting reuses the guard's splitter — the TOKENISER, not its
 * policy; the rules above stay an independent implementation on purpose, so
 * this reader and the guard do not fail in the same places.
 */
export function execViolationKind(cmd: string): ExecViolationKind | null {
  // The guard's redirection normaliser, borrowed like its splitter: `&>f`,
  // `>&f`, `{v}>f`, `1<>f` and `>|f` all become `>f`, so a write the guard
  // refuses is spelled the same way when this audit reads it back.
  const normalized = normalizeRedirections(cmd);
  for (const segment of splitShellSegments(normalized)) {
    if (segment.trim().length === 0) continue;
    const kind = segmentViolationKind(segment);
    if (kind !== null) return kind;
  }
  return null;
}

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

/** Tool names that write a file, as recorded in the transcript. Mirrors
 * WRITE_TOOLS in extensions/bash-guard.ts — deliberately broad. */
const WRITE_TOOL_NAMES = new Set([
  "write",
  "edit",
  "multi_edit",
  "multiedit",
  "str_replace",
  "create",
  "write_file",
  "apply_patch",
]);

/**
 * Every write-TOOL target in a record. The bash-only collector above is why
 * the audit was blind to the decisive half of all four bypasses: the command
 * they ran was innocent, and the payload was a file written with the ordinary
 * write tool, which never appears in a bash command at all.
 */
function writeTargetsIn(value: unknown, out: string[], depth = 8): void {
  if (depth < 0 || typeof value !== "object" || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) writeTargetsIn(item, out, depth - 1);
    return;
  }
  const obj = value as Record<string, unknown>;
  const toolName = obj.toolName ?? obj.name ?? obj.tool;
  if (typeof toolName === "string" && WRITE_TOOL_NAMES.has(toolName)) {
    for (const argsKey of ["arguments", "input", "args", "params"]) {
      const args = obj[argsKey];
      if (typeof args === "object" && args !== null) {
        const a = args as Record<string, unknown>;
        for (const pathKey of ["path", "file_path", "filePath"]) {
          const p = a[pathKey];
          if (typeof p === "string") out.push(p);
        }
      }
    }
    for (const pathKey of ["path", "file_path", "filePath"]) {
      const p = obj[pathKey];
      if (typeof p === "string") out.push(p);
    }
  }
  for (const v of Object.values(obj)) writeTargetsIn(v, out, depth - 1);
}

export interface ExecViolation {
  command: string;
  kind: ExecViolationKind;
}

/** One parsed record's audit items — its bash commands, then its write-tool
 * targets, each that trips a rule — in the order the audit meets them. A
 * write target's key is `write <path>`. */
export function auditItemsOf(rec: unknown): ExecViolation[] {
  const out: ExecViolation[] = [];
  const commands: string[] = [];
  bashCommandsIn(rec, commands);
  for (const command of commands) {
    const kind = execViolationKind(command);
    if (kind) out.push({ command, kind });
  }
  const targets: string[] = [];
  writeTargetsIn(rec, targets);
  for (const target of targets) {
    const kind = surfacePathKind(target);
    if (kind !== null) out.push({ command: `write ${target}`, kind });
  }
  return out;
}

/** Every policy-forbidden action visible in the given JSONL lines, classified.
 * Deduplicated by command, order-preserving; malformed lines skipped. */
export function auditExecViolationDetails(lines: string[]): ExecViolation[] {
  const seen = new Map<string, ExecViolationKind>();
  for (const line of lines) {
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    for (const item of auditItemsOf(rec))
      if (!seen.has(item.command)) seen.set(item.command, item.kind);
  }
  return [...seen].map(([command, kind]) => ({ command, kind }));
}

/** Bash commands in the given JSONL lines that ran a forbidden executor.
 * Deduplicated, order-preserving; malformed lines skipped. */
export function auditExecViolations(lines: string[]): string[] {
  return auditExecViolationDetails(lines).map((v) => v.command);
}
