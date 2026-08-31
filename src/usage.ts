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
// The guard's TOKENISER — not its policy. The rules below stay an
// independent implementation on purpose (see execViolationKind).
import { splitShellSegments } from "../extensions/bash-guard.js";
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

/**
 * The post-hoc audit's vocabulary (widened).
 *
 * It used to be ONE pattern — interpreters — which meant that **not one of the
 * chains proven to execute or POST across's four adversarial rounds
 * would have produced a single audit line.** `gh pr review --approve`,
 * `gh api … --input`, `gh api -fevent=APPROVE`, `git -c alias.x=!cmd x`,
 * `git --git-dir=<dir> diff`, `HOME=<dir> git diff` — every one of them was
 * invisible here while it was live. The guard blocked them, eventually; the
 * audit would not have known if it hadn't.
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
   * exec mode — the four primitives the first review found this audit
   * blind to. */
  | "reader_write_or_exec";

/** Interpreters — the original rule, unchanged. */
const EXEC_VIOLATION_RE = /\b(?:python3?|pytest|uv|npm|npx|node|make|pip3?|poetry|cargo|go (?:run|test))\b/;

/** A `gh api` call that will not be a GET: an explicit mutating method, or any
 * body-carrying flag (gh promotes GET→POST when a body is present — the
 * `--input` form is the one the predecessor used for every review it posted). */
const GH_API_WRITE_RE =
  /\bgh\s+(?:-\S+\s+)*api\b[^\n]*?(?:-X\s*(?:POST|PATCH|PUT|DELETE)|--method[=\s]+(?:POST|PATCH|PUT|DELETE)|--input\b|--input=|--field\b|--field=|--raw-field\b|--raw-field=|(?:^|\s)-[A-Za-z]*[fF](?:\s|=|[A-Za-z_]+=))/i;

/** A `gh` subcommand that is not one of the read verbs. Expressed as the
 * complement of the read set rather than as a list of write verbs, so a verb
 * `gh` grows tomorrow is audited by default instead of being invisible until
 * someone remembers it. */
const GH_SUBCOMMAND_RE = /\bgh\s+(?:-\S+\s+)*([a-z-]+)(?:\s+(?:-\S+\s+)*([a-z-]+))?/;
const GH_AUDIT_READ_NAMESPACES = new Set(["api", "search", "status", "version", "help", "auth"]);
const GH_AUDIT_READ_VERBS = new Set(["view", "list", "diff", "checks", "status", "get-url", "download"]);

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
 * run — the family that produced rounds 2, 3 and 4. Both the option forms and
 * the environment-prefix twins, because the twins were round 2's and round 4's
 * whole point. */
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

/** The same surface as a bash WRITE: a redirection target, or `sed -i`'s. A
 * bare mention is not enough — `git show HEAD:.gitattributes` is a legitimate
 * read of a file the PR touched, and auditing it as a config write would be
 * the kind of routine false line that teaches an operator to skip the event. */
const GIT_CONFIG_SURFACE_WRITE_RE =
  /(?:>>?\s*\S*(?:\.git\/\S*|\.gitconfig|git\/config|\.gitattributes)|\bsed\s+(?:-\S+\s+)*-[a-zA-Z]*i\S*(?:\s+\S+)*?\s+\S*(?:\.git\/\S*|\.gitconfig|git\/config|\.gitattributes))/;

/**
 * Programs whose ARGUMENTS are search patterns and paths, never commands.
 *
 * Without this the audit read every grep pattern as if it were a command, and
 * fired on the reads that ARE the job here: `rg -n PATH= Dockerfile`,
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
  "rg", "grep", "egrep", "fgrep", "ag", "ack", "cat", "head", "tail", "nl", "wc",
  "jq", "cut", "tr", "uniq", "sort", "ls", "echo", "printf", "diff", "comm",
  "column", "find", "basename", "dirname", "stat", "awk", "sed", "xargs", "test",
]);

/**
 * The write/exec MODES of the four programs that are allowlisted for reading
 * (round 2). The first review found the audit blind to four of the five
 * write primitives that reach `<clone>/.git/config`, so layers 2 and 3 failed
 * in exactly the same place — which undercuts the point of having both.
 *
 * Honest about what this is: the same SHAPE as `checkReaderModes` in the guard,
 * as a separate coarse implementation over whole segments. Independence buys
 * less here than it does elsewhere in this file, and claiming otherwise would
 * be the kind of overstatement this ticket exists to stop.
 *
 * The fifth primitive — `T=.git/config; cat p >> $T` — is deliberately NOT
 * here. Its target is a variable, so no reader of command strings can ever see
 * it; that one is caught by the round-boundary integrity check in
 * `execboundary.ts`, which is why that check exists.
 */
const READER_MODE_AUDIT: Readonly<Record<string, RegExp>> = {
  find: /(?:^|\s)-(?:exec|execdir|ok|okdir|delete|fprintf|fprint|fprint0|fls)(?:\s|$)/,
  sort: /(?:^|\s)(?:--(?:output|compress-program)(?:=|\s)|-(?!-)[a-zA-Z]*o(?:\s|$))/,
  sed: /(?:^|\s)(?:--(?:in-place|file)|-(?!-)[a-zA-Z]*[if])|['"\s](?:[0-9$,]|\/[^/]*\/)*\s*[wWe]\s/,
  awk: /\bsystem\s*\(|\|\s*&?\s*getline|\b(?:print|printf)\b[^;}\n]*>>?\s*["'$(]/,
};

/** The first real program token in a segment: `VAR=val` prefixes, `env` and its
 * flags, and redirection remnants skipped — the same shape the bash guard's
 * `checkSegment` uses to find what a segment actually runs. */
function segmentProgram(segment: string): string | null {
  for (const raw of segment.trim().split(/\s+/)) {
    const t = raw.replace(/^['"(]+|['")]+$/g, "");
    if (t.length === 0) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue;
    if (t === "env" || (t.startsWith("-") && t.length <= 3)) continue;
    if (/^\d*[<>]/.test(t)) continue;
    return t.slice(t.lastIndexOf("/") + 1);
  }
  return null;
}

/** Which rule, if any, this ONE segment trips. */
function segmentViolationKind(segment: string): ExecViolationKind | null {
  // The redirection/`sed -i` surface rule runs on every segment, reader or not:
  // its subject is the segment's own write target, not a quoted pattern.
  if (GIT_CONFIG_SURFACE_WRITE_RE.test(segment)) return "git_config_surface_write";
  const prog = segmentProgram(segment);
  if (prog !== null) {
    // Checked BEFORE the reader skip below: these programs are readers by
    // default and writers on a flag, and the flag is the whole point.
    if (READER_MODE_AUDIT[prog]?.test(segment)) return "reader_write_or_exec";
    if (AUDIT_READERS.has(prog)) return null;
  }
  if (GH_API_WRITE_RE.test(segment) || GITHUB_DIRECT_WRITE_RE.test(segment)) return "github_write";
  const gh = GH_SUBCOMMAND_RE.exec(segment);
  if (gh) {
    const ns = gh[1]!;
    const verb = gh[2];
    if (!GH_AUDIT_READ_NAMESPACES.has(ns) && verb !== undefined && !GH_AUDIT_READ_VERBS.has(verb)) return "github_write";
  }
  if (GIT_WRITE_RE.test(segment)) return "git_write";
  if (GIT_CONFIG_INJECTION_RE.test(segment)) return "git_config_injection";
  if (EXEC_VIOLATION_RE.test(segment)) return "interpreter";
  return null;
}

/**
 * Which rule, if any, this command trips — decided PER SHELL SEGMENT.
 *
 * Whole-command matching was the bug: a pattern in an argument to `rg` is not a
 * command, and treating it as one produced eight false positives on ordinary
 * review reads. Segmenting reuses the guard's splitter — the TOKENISER, not its
 * policy; the rules above stay an independent implementation on purpose, so
 * this reader and the guard do not fail in the same places.
 */
export function execViolationKind(cmd: string): ExecViolationKind | null {
  const normalized = cmd.replace(/\d*>&\d*/g, " ");
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
const WRITE_TOOL_NAMES = new Set(["write", "edit", "multi_edit", "multiedit", "str_replace", "create", "write_file", "apply_patch"]);

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
    const commands: string[] = [];
    bashCommandsIn(rec, commands);
    for (const cmd of commands) {
      const kind = execViolationKind(cmd);
      if (kind && !seen.has(cmd)) seen.set(cmd, kind);
    }
    const targets: string[] = [];
    writeTargetsIn(rec, targets);
    for (const target of targets) {
      if (!GIT_CONFIG_SURFACE_PATH_RE.test(target)) continue;
      const key = `write ${target}`;
      if (!seen.has(key)) seen.set(key, "git_config_surface_write");
    }
  }
  return [...seen].map(([command, kind]) => ({ command, kind }));
}

/** Bash commands in the given JSONL lines that ran a forbidden executor.
 * Deduplicated, order-preserving; malformed lines skipped. */
export function auditExecViolations(lines: string[]): string[] {
  return auditExecViolationDetails(lines).map((v) => v.command);
}
