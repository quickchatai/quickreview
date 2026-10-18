// The one-shot review: one `pi -p --mode json` main session with the
// production round order on stdin, the lens fan-out inside that process, the
// outputs rendered through the production review renderer, and one
// `--continue` when the outputs are missing or unreadable.
//
// Shared by the benchmark (src/bench/runner.ts reviewCase) and `qcr review`.
// It takes a prepared tree, its file list, a target description and an output
// directory; it knows nothing of bench cases, stores or prefetching. No
// daemon, tmux, inject bridge or memory: a process that exits when the round
// settles (CLAUDE.md rule 8's boundary: no GitHub credential reaches it).

import { spawn } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { DEFAULT_SUBAGENT_CACHE_STAGGER_MS, type Config } from "./config.js";
import {
  buildPassPlan,
  buildRoundOrder,
  optionalOrderOf,
  renderDeltaPatch,
  roundDeltaOf,
  sweepOrderOf,
  type FollowUpDecision,
  type FollowUpFullReason,
  type PassPlan,
} from "./dispatch.js";
import { parseLedgerCarry, settledFromLedger } from "./ledgercarry.js";
import type { CiLinter } from "./lintconfig.js";
import type { PriorFindingsList } from "./priorfindings.js";
import type { Ecosystem } from "./ecosystem.js";
import type { PrFileEntry } from "./github.js";
import { CONTEXT_PACK_FILE, readWorktreeFileForPack, renderContextPack } from "./contextpack.js";
import { identityVars } from "./include.js";
import { lensEnabled } from "./lenstuning.js";
import { MEMORY_LESS, type RoundMemory } from "./memory/context.js";
import { renderPassTasks } from "./passtasks.js";
import { loadProfileHeuristics } from "./profiles.js";
import { isDefaultPosting } from "./postingpolicy.js";
import {
  postedRenderOptions,
  renderPostedReview,
  type PostedRenderConfig,
} from "./reviewrender.js";
import { directiveVocabulary, isFirstPartyDirectivePath } from "./severity.js";
import type { PrStateRow } from "./state.js";
import {
  renderConversationSystemPrompt,
  renderGateNotes,
  renderRoundPrompt,
  roundTemplateFile,
  templateFileForOrder,
} from "./templates.js";
import type { PassPlanEntry, RoundOrder } from "./types.js";
import { findCiLinters } from "./lintconfig.js";
import { findStyleGuide } from "./styleguide.js";
import {
  benchAppendix,
  CASE_FILES,
  modelErrorKind,
  modelErrorsFromEvents,
  stagesFromEvents,
  usageFromEvents,
  type ModelErrors,
  type Stages,
} from "./bench/aacr.js";
import { caseCostUsd, eventLineCostUsd } from "./bench/cost.js";
import { GIT_ISOLATION_ENV } from "./bench/exec.js";
import { POLICED_ORIGINALS, type BenchPostingReport } from "./bench/benchposting.js";
import { apiKeyEnv } from "./bench/auth.js";
import { GITHUB_TOKEN_ENVS } from "./envstrip.js";

/** Cut a PR body to a UTF-8 byte budget. The body is the one unbounded input
 * in the order, and it appears twice (the intent note and the override). */
export function boundBody(body: string | null, maxBytes = 20_000): string | null {
  if (body === null || Buffer.byteLength(body, "utf8") <= maxBytes) return body;
  const cut = Buffer.from(body, "utf8")
    .subarray(0, maxBytes)
    .toString("utf8")
    .replace(/\uFFFD$/, "");
  return `${cut}\n…(truncated for the benchmark)`;
}

/** The PR's first-party agent-directive files (src/severity.ts), which the
 * round order names — the same for a first round and a follow-up. */
export function directiveFilesOf(cfg: Config, files: readonly PrFileEntry[]): string[] {
  const vocab = directiveVocabulary(cfg.review.directives);
  return files.filter((f) => isFirstPartyDirectivePath(f.filename, vocab)).map((f) => f.filename);
}

/** `[review] context_pack = "pack-first"`, as dispatch writes it:
 * the case's context pack beside its task dirs (`<case>/context-pack.md` —
 * where the glue looks for a task file's pack), and the order the task files
 * render from, which then points at it. Off ⇒ the order unchanged, no file. */
export function benchContextPack(
  cfg: Config,
  built: RoundOrder,
  files: PrFileEntry[],
  tree: string,
  caseDir: string,
  deltaPatch?: string,
): { order: RoundOrder; file?: { path: string; text: string } } {
  if (
    !cfg.review.task_files ||
    cfg.review.context_pack !== "pack-first" ||
    cfg.pi.subagent_cache_group <= 0
  )
    return { order: built };
  const path = join(caseDir, CONTEXT_PACK_FILE);
  const pack = renderContextPack({
    pr: built.pr,
    headSha: built.head_sha,
    mergeBase: built.merge_base,
    files,
    ...(deltaPatch ? { deltaPatch } : {}),
    readFile: (p) => readWorktreeFileForPack(tree, p),
    maxTokens: cfg.review.context_pack_max_tokens,
  });
  return { order: { ...built, context_pack_file: path }, file: { path, text: pack.text } };
}

/** Feed `onLine` each LF-terminated line of `input` (a trailing CR dropped, a
 * last unterminated line delivered at end). pi's JSON mode frames events by
 * LF alone: node's readline also splits on U+2028/U+2029 (which JSON leaves
 * unescaped inside strings) and on a bare CR, cutting one event into
 * fragments that parse as nothing, so the $ cap never saw their cost. */
export function onLfLines(input: Readable, onLine: (line: string) => void): void {
  const decoder = new StringDecoder("utf8");
  let rest = "";
  const emit = (line: string): void => onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  input.on("data", (chunk: Buffer | string) => {
    rest += typeof chunk === "string" ? chunk : decoder.write(chunk);
    let nl: number;
    while ((nl = rest.indexOf("\n")) !== -1) {
      const line = rest.slice(0, nl);
      rest = rest.slice(nl + 1);
      emit(line);
    }
  });
  input.on("end", () => {
    rest += decoder.end();
    if (rest !== "") emit(rest);
    rest = "";
  });
}

export interface PiRun {
  code: number | null;
  timedOut: boolean;
  streamError: string | null;
  /** pi's own price for what this process spent (every lens child included). */
  spentUsd?: number;
  /** The process was killed because its spend reached `capUsd`. */
  capped?: boolean;
}

/** Process groups of the pi children runPi has running right now, so a signal
 * handler elsewhere (reviewdetach.ts runDetachedChild) can reach them: each pi
 * leads its own group, which a kill aimed at the driver's group never touches. */
const livePiGroups = new Set<number>();
let piHalted = false;

/** Signal every running pi's process group (its lens children with it). */
export function killPiGroups(sig: NodeJS.Signals): void {
  for (const pgid of livePiGroups) {
    try {
      process.kill(-pgid, sig);
    } catch {
      // already gone
    }
  }
}

/** The run is being stopped: no further pi is spawned by this process. */
export function haltPi(): void {
  piHalted = true;
}

/** The bench's ONE pi spawn (tests/single-shepherd.test.ts S2): the review
 * round and the defect judge (defectjudge.ts) both go through it. */
export function runPi(
  argv: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  eventsPath: string,
  stderrPath: string,
  timeoutMs: number,
  piBin: string,
  stdinText?: string,
  /** Hard stop: kill the process group once pi's own price for the run reaches
   * this many dollars. Omitted: no cap. */
  capUsd?: number,
): Promise<PiRun> {
  return new Promise((resolve) => {
    if (piHalted) {
      resolve({ code: null, timedOut: false, streamError: "stopped" });
      return;
    }
    const events = createWriteStream(eventsPath, { flags: "a" });
    const errs = createWriteStream(stderrPath, { flags: "a" });
    // detached: its own process group, so a timeout kills the lens children
    // with it rather than orphaning six pi processes on the model API.
    const child = spawn(piBin, argv, {
      cwd,
      env,
      stdio: [stdinText === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: true,
    });
    if (child.pid) livePiGroups.add(child.pid);
    let timedOut = false;
    let capped = false;
    let spent = 0;
    let streamError: string | null = null;
    const kill = (sig: NodeJS.Signals): void => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        // already gone
      }
    };
    // A full disk must end THIS case as a recorded failure, not throw out of
    // the CLI and lose every case after it.
    const onStreamError = (e: Error): void => {
      streamError = String(e);
      kill("SIGKILL");
    };
    events.on("error", onStreamError);
    errs.on("error", onStreamError);
    // The round order goes in on stdin: pi -p takes piped stdin as the prompt,
    // and an argv string caps at 128 KiB (MAX_ARG_STRLEN).
    // A pi that dies before reading its prompt (bad model, auth refusal)
    // EPIPEs this write asynchronously: unheard, that error kills the CLI.
    if (stdinText !== undefined && child.stdin) {
      child.stdin.on("error", (e) => onStreamError(new Error(`prompt delivery: ${String(e)}`)));
      child.stdin.end(stdinText);
    }
    // `*_update` events re-emit a lens child's whole transcript on every
    // update — the file grows quadratically. Nothing reads them: usage comes
    // from `message_end` and `tool_execution_end`.
    onLfLines(child.stdout!, (line) => {
      if (capUsd !== undefined && !capped) {
        spent += eventLineCostUsd(line);
        if (spent >= capUsd) {
          capped = true;
          kill("SIGTERM");
          setTimeout(() => kill("SIGKILL"), 5_000).unref();
        }
      }
      if (
        line.startsWith('{"type":"tool_execution_update"') ||
        line.startsWith('{"type":"message_update"')
      )
        return;
      events.write(line + "\n");
    });
    child.stderr!.pipe(errs);
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 15_000).unref();
    }, timeoutMs);
    child.on("error", (e) => {
      errs.write(`spawn error: ${String(e)}\n`);
    });
    // Resolve only once both files are flushed and closed: every caller reads
    // them synchronously the moment this resolves (the judge's answer is the
    // events file's LAST message_end).
    child.on("close", (code) => {
      clearTimeout(timer);
      if (child.pid) livePiGroups.delete(child.pid);
      let open = 2;
      const settled = (): void => {
        if (--open === 0) resolve({ code, timedOut, streamError, spentUsd: spent, capped });
      };
      for (const s of [events, errs]) {
        if (s.closed) settled();
        else {
          s.once("close", settled);
          s.end();
        }
      }
    });
  });
}

/**
 * The bench's render step (`[review] render_outputs`): the SAME two calls the
 * live route's scripts/render-review.sh makes (src/reviewrendercli.ts
 * renderRound) — `postedRenderOptions(cfg)` then `renderPostedReview` — with
 * the case's outcome as the fallback verdict, summary and lenses line. Pinned
 * equal to the live route by tests/dedup-parity.test.ts.
 */
export function renderBenchOutputs(
  record: unknown,
  outcome: Record<string, unknown> | undefined,
  cfg: PostedRenderConfig,
): ReturnType<typeof renderPostedReview> {
  const passes = Array.isArray(outcome?.["passes"])
    ? (outcome["passes"] as Array<Record<string, unknown>>)
        .map((p) => String(p["name"] ?? ""))
        .filter((n) => n && n !== "pass-validate")
    : [];
  return renderPostedReview(
    record,
    postedRenderOptions(cfg, {
      verdict: typeof outcome?.["verdict"] === "string" ? outcome["verdict"] : null,
      summary: typeof outcome?.["summary"] === "string" ? outcome["summary"] : null,
      lensesApplied: passes.length ? passes.join(", ") : null,
    }),
  );
}

export function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** Why a session's JSON output file cannot be used: `undefined` when it parses,
 * `"missing"` when absent, otherwise the parser's message. */
export function jsonProblem(path: string): string | undefined {
  if (!existsSync(path)) return "missing";
  try {
    JSON.parse(readFileSync(path, "utf8"));
    return undefined;
  } catch (err) {
    return String(err instanceof Error ? err.message : err).slice(0, 300);
  }
}

/** The BENCHMARK MODE files a scorer reads as JSON: the outcome always; the
 * findings record when the bench renders the posted review from it, else the
 * session's own comments. */
function scoredOutputs(renderOutputs: boolean): string[] {
  return renderOutputs
    ? [CASE_FILES.findings, CASE_FILES.outcome]
    : [CASE_FILES.comments, CASE_FILES.outcome];
}

/** The scored BENCHMARK MODE files the session wrote that do not parse. A
 * missing file is not listed here (`missingOutputs` lists it). */
export function unparseableOutputs(caseDir: string, renderOutputs: boolean): string[] {
  const names = scoredOutputs(renderOutputs);
  const out: string[] = [];
  for (const n of names) {
    const p = jsonProblem(join(caseDir, n));
    if (p !== undefined && p !== "missing") out.push(`${n} is not valid JSON (${p})`);
  }
  return out;
}

/** The scored BENCHMARK MODE files the session has not written. */
export function missingOutputs(caseDir: string, renderOutputs: boolean): string[] {
  return scoredOutputs(renderOutputs).filter((n) => !existsSync(join(caseDir, n)));
}

/** The session's event stream and stderr in a case dir. */
export const PI_RUN_FILES = ["pi-events.jsonl", "pi-stderr.log"] as const;

// ---- the target and the prompts ---------------------------------------------

/** What is being reviewed, in the words the production round order takes. */
export interface OneShotTarget {
  repo: string;
  number: number;
  title: string | null;
  body: string | null;
  headSha: string;
  baseRef: string;
  baseSha: string;
  mergeBase: string;
  /** The title the round order carries when `title` is null. */
  fallbackTitle?: string;
}

export interface OneShotPrompts {
  system: string;
  order: string;
  plannedLenses: string[];
  passPlan: PassPlanEntry[];
  /** `[review] task_files`: the lens task files the order points at, for the
   * runner to write before the session starts. */
  taskFiles: Array<{ path: string; text: string }>;
  /** The context pack, for the runner to write (absent => remove any stale one). */
  contextPack?: { path: string; text: string };
  /** Every other file the order names (a follow-up's delta patch, prior
   * findings, sweep tasks, pinned ledger), for the runner to write. */
  extraFiles?: Array<{ path: string; text: string }>;
}

/** The first round's order + system prompt for a target: production renderers. */
export function renderOneShotPrompts(args: {
  root: string;
  cfg: Config;
  ecosystem: Ecosystem;
  target: OneShotTarget;
  tree: string;
  caseDir: string;
  files: PrFileEntry[];
  issuedAt: string;
  /** The rendered third-party-sources block, "" when none (depsources.ts). */
  dependencyNote?: string;
  /** The round's memory seed (src/reviewmemory.ts); absent => memory-less. */
  memory?: RoundMemory;
}): OneShotPrompts {
  const { root, cfg, target, tree } = args;
  const identity = { ...identityVars(cfg), repo: target.repo };
  const title = target.title ?? target.fallbackTitle ?? `${target.repo}#${target.number}`;
  const body = boundBody(target.body);
  const directiveFiles = directiveFilesOf(cfg, args.files);
  const row = {
    number: target.number,
    state: "reviewing",
    head_sha: target.headSha,
    title,
    author: "",
  } as unknown as PrStateRow;
  const built = buildRoundOrder({
    cfg,
    row,
    files: args.files,
    roundId: 1,
    roundNo: 1,
    reviewNo: 1,
    roundType: "first",
    worktree: tree,
    settledDigest: "",
    issuedAt: args.issuedAt,
    tree: {
      head_sha: target.headSha,
      base_ref: target.baseRef,
      base_sha: target.baseSha,
      merge_base: target.mergeBase,
    },
    ...(body !== null ? { prBody: body } : {}),
    ...(directiveFiles.length
      ? { firstPartyDirectives: { files: directiveFiles, mention: "maintainer" } }
      : {}),
    ecosystem: args.ecosystem,
    heuristics: loadProfileHeuristics(root, cfg.review.profile),
    ...(args.dependencyNote ? { dependencyNote: args.dependencyNote } : {}),
    // The repo's written style guide, as production finds it (dispatch.ts).
    ...(lensEnabled(cfg.lenses, "pass-style", cfg.review.style_lens)
      ? { styleGuide: findStyleGuide(tree) }
      : {}),
    // The linters a CI job of the repo runs, as production finds them.
    ...(lensEnabled(cfg.lenses, "pass-lint-conformance", cfg.review.lint_conformance)
      ? { ciLinters: findCiLinters(tree) }
      : {}),
  });
  // `[review] task_files`, as production writes them (dispatch.ts): one
  // complete lens task per discovery row, in the output dir.
  // Rendered here, written by the runner (this stays pure).
  const packed = benchContextPack(cfg, built, args.files, tree, args.caseDir);
  const taskFiles = cfg.review.task_files
    ? renderPassTasks(packed.order, renderGateNotes(built, args.ecosystem)).map((t) => ({
        ...t,
        path: join(args.caseDir, "tasks", t.file),
      }))
    : [];
  // The runner renders comments.json and review.md itself after the session
  // (`[review] render_outputs`, benchAppendix), so the order never carries
  // production's render-review.sh note: there is no scripts/.
  const { render_outputs: _renderedByRunner, ...unrendered } = built;
  const order: RoundOrder = taskFiles.length
    ? {
        ...unrendered,
        pass_task_files: taskFiles.map((t) => ({ row: t.row, agent: t.agent, path: t.path })),
      }
    : unrendered;
  const template = readFileSync(join(root, "prompts", roundTemplateFile("first")), "utf8");
  const rendered = renderRoundPrompt(
    template,
    order,
    args.memory ?? MEMORY_LESS,
    cfg.owner.name,
    args.ecosystem,
    identity,
  );
  const orderText =
    rendered +
    "\n\n" +
    benchAppendix({
      repo: target.repo,
      pr: target.number,
      headSha: target.headSha,
      mergeBase: target.mergeBase,
      caseDir: args.caseDir,
      title: target.title,
      body,
      ...(cfg.review.render_outputs ? { renderOutputs: true } : {}),
    });
  const system = renderConversationSystemPrompt(
    readFileSync(join(root, "prompts", "conversation-system.md"), "utf8"),
    { pr: target.number, title, worktree: tree },
    identity,
  );
  return {
    system,
    order: orderText,
    plannedLenses: order.pass_plan.map((p) => p.agent),
    passPlan: order.pass_plan,
    taskFiles: taskFiles.map((t) => ({ path: t.path, text: t.text })),
    ...(packed.file ? { contextPack: packed.file } : {}),
  };
}

// ---- a follow-up round ---------------------------------------------------------

/** What a follow-up round ran as: delta or full, and why. */
export interface FollowUpReport {
  round_no: number;
  review_no: number;
  /** `delta`: the follow-up round; `full`: a full re-review. */
  scope: "delta" | "full";
  /** Why the round runs in full (dispatch's `followup_full_round` reasons). */
  reason?: string;
  detail?: Record<string, unknown>;
  delta_lines?: number;
  delta_files?: number;
  conflicted?: string[];
  sweep_owed?: boolean;
  prior_findings: number;
}

/** The follow-up decision: production's `planFollowUp` answer. */
export type FollowUpChoice =
  | { kind: "delta"; decision: FollowUpDecision }
  | { kind: "full"; reason: FollowUpFullReason; detail?: Record<string, unknown> };

export interface FollowUpOneShotPrompts extends OneShotPrompts {
  followUp: FollowUpReport;
  sweepPlan?: PassPlanEntry[];
}

export interface FollowUpOneShotArgs {
  root: string;
  cfg: Config;
  ecosystem: Ecosystem;
  target: OneShotTarget;
  tree: string;
  caseDir: string;
  files: PrFileEntry[];
  issuedAt: string;
  dependencyNote?: string;
  roundNo: number;
  reviewNo: number;
  /** The head the previous round reviewed. */
  prevHead: string;
  /** The ledger the previous round left, when there is one. */
  ledger?: string;
  /** The follow-up decision, given the whole target's plan. */
  decide: (ctx: {
    heuristics: ReturnType<typeof loadProfileHeuristics>;
    fullPlan: PassPlan;
    styleGuide: string[];
    ciLinters: CiLinter[];
  }) => FollowUpChoice;
  /** The prior findings note and sidecar; the sidecar is written at `sidecarPath`. */
  prior: (sidecarPath: string) => { note: string; sidecar: string; list: PriorFindingsList };
  /** How many prior findings the full-round report counts. */
  priorCount: number;
}

/**
 * The order of a follow-up replay case: production's round k, built
 * from the same pieces dispatch uses — the full plan, `decide`
 * (dispatch's `planFollowUp`), the delta patch and order delta, the prior
 * findings note, the sweep's task files — rendered from the template
 * `templateFileForOrder` picks. Any doubt runs a full re-review.
 */
export function renderFollowUpOneShotPrompts(args: FollowUpOneShotArgs): FollowUpOneShotPrompts {
  const { root, cfg, target, tree } = args;
  const identity = { ...identityVars(cfg), repo: target.repo };
  const title = target.title ?? target.fallbackTitle ?? `${target.repo}#${target.number}`;
  const body = boundBody(target.body);
  const directiveFiles = directiveFilesOf(cfg, args.files);
  const row = {
    number: target.number,
    state: "reviewing",
    head_sha: target.headSha,
    title,
    author: "",
  } as unknown as PrStateRow;
  const heuristics = loadProfileHeuristics(root, cfg.review.profile);
  const styleGuide = lensEnabled(cfg.lenses, "pass-style", cfg.review.style_lens)
    ? findStyleGuide(tree)
    : [];
  const ciLinters = lensEnabled(cfg.lenses, "pass-lint-conformance", cfg.review.lint_conformance)
    ? findCiLinters(tree)
    : [];
  // The whole PR's plan, exactly as dispatch builds it before deciding.
  const fullPlan = buildPassPlan(
    cfg,
    args.files,
    { title, body: body ?? undefined },
    args.ecosystem,
    heuristics,
    styleGuide,
    ciLinters,
  );
  const decided = args.decide({ heuristics, fullPlan, styleGuide, ciLinters });
  const extraFiles: Array<{ path: string; text: string }> = [];
  // The ledger the PR session held when the round was dispatched: carried as
  // production's `ledger_carry` (and its SETTLED digest), and pinned as the
  // case's ledger file (QCR_LEDGER_FILE) by the caller.
  const ledgerPath = join(args.caseDir, "ledger.md");
  const ledgerCarry =
    args.ledger !== undefined
      ? parseLedgerCarry(args.ledger, target.number, ledgerPath)
      : undefined;
  const settledDigest =
    ledgerCarry && args.ledger !== undefined ? settledFromLedger(args.ledger.trim()) : "";
  if (args.ledger !== undefined) extraFiles.push({ path: ledgerPath, text: args.ledger });
  let followUpArg: Parameters<typeof buildRoundOrder>[0]["followUp"];
  let report: FollowUpReport;
  if (decided.kind === "delta") {
    const d = decided.decision;
    const patchPath = join(args.caseDir, "delta.patch");
    extraFiles.push({ path: patchPath, text: renderDeltaPatch(d.delta.files) });
    const prior = args.prior(join(args.caseDir, "prior.json"));
    extraFiles.push({ path: join(args.caseDir, "prior.json"), text: prior.sidecar });
    followUpArg = {
      delta: roundDeltaOf(d, patchPath),
      deltaFiles: d.deltaFiles,
      priorFindingsNote: prior.note,
      priorFindings: prior.list,
      ...(d.optionalPlan ? { optionalPlan: d.optionalPlan } : {}),
      ...(d.sweepPlan ? { sweepPlan: d.sweepPlan } : {}),
      ...(d.sweepUnswept ? { sweepUnswept: d.sweepUnswept } : {}),
      ...(d.sweepBehaviourUnread ? { sweepBehaviourUnread: d.sweepBehaviourUnread } : {}),
    };
    report = {
      round_no: args.roundNo,
      review_no: args.reviewNo,
      scope: "delta",
      delta_lines: d.delta.lines,
      delta_files: d.delta.files.length,
      ...(d.delta.conflicted.length ? { conflicted: d.delta.conflicted } : {}),
      sweep_owed: d.sweepPlan !== undefined,
      prior_findings: prior.list.findings.length,
    };
  } else {
    report = {
      round_no: args.roundNo,
      review_no: args.reviewNo,
      scope: "full",
      reason: decided.reason,
      ...(decided.detail ? { detail: decided.detail } : {}),
      prior_findings: args.priorCount,
    };
  }
  const built = buildRoundOrder({
    cfg,
    row,
    files: args.files,
    roundId: 1,
    roundNo: args.roundNo,
    reviewNo: args.reviewNo,
    roundType: "re-review",
    worktree: tree,
    settledDigest,
    ...(ledgerCarry ? { ledgerCarry } : {}),
    issuedAt: args.issuedAt,
    tree: {
      head_sha: target.headSha,
      base_ref: target.baseRef,
      base_sha: target.baseSha,
      merge_base: target.mergeBase,
    },
    ...(body !== null ? { prBody: body } : {}),
    ...(directiveFiles.length
      ? { firstPartyDirectives: { files: directiveFiles, mention: "maintainer" } }
      : {}),
    ecosystem: args.ecosystem,
    heuristics,
    ...(args.dependencyNote ? { dependencyNote: args.dependencyNote } : {}),
    ...(styleGuide.length ? { styleGuide } : {}),
    ...(ciLinters.length ? { ciLinters } : {}),
    plan: decided.kind === "delta" ? decided.decision.plan : fullPlan,
    ...(followUpArg ? { followUp: followUpArg } : {}),
  });
  const packed = benchContextPack(
    cfg,
    built,
    args.files,
    tree,
    args.caseDir,
    decided.kind === "delta" ? renderDeltaPatch(decided.decision.delta.files) : undefined,
  );
  const taskFiles = cfg.review.task_files
    ? renderPassTasks(packed.order, renderGateNotes(built, args.ecosystem)).map((t) => ({
        ...t,
        path: join(args.caseDir, "tasks", t.file),
      }))
    : [];
  // The sweep's own task files, from the same order dispatch renders them
  // from (`sweepOrderOf`), in their own directory.
  const sweepTasks =
    cfg.review.task_files && built.sweep_plan && built.sweep_plan.length > 0
      ? (() => {
          const sweepOrder = sweepOrderOf(packed.order, built.sweep_plan);
          return renderPassTasks(sweepOrder, renderGateNotes(sweepOrder, args.ecosystem)).map(
            (t) => ({ ...t, path: join(args.caseDir, "tasks-sweep", t.file) }),
          );
        })()
      : [];
  // The optional rows' task files, from the same order dispatch
  // renders them from (`optionalOrderOf`), in their own directory.
  const optionalTasks =
    cfg.review.task_files && built.optional_plan && built.optional_plan.length > 0
      ? (() => {
          const optionalOrder = optionalOrderOf(packed.order, built.optional_plan);
          return renderPassTasks(optionalOrder, renderGateNotes(optionalOrder, args.ecosystem)).map(
            (t) => ({ ...t, path: join(args.caseDir, "tasks-optional", t.file) }),
          );
        })()
      : [];
  const { render_outputs: _renderedByBench, ...unrendered } = built;
  const order = {
    ...unrendered,
    ...(taskFiles.length
      ? { pass_task_files: taskFiles.map((t) => ({ row: t.row, agent: t.agent, path: t.path })) }
      : {}),
    ...(sweepTasks.length
      ? { sweep_task_files: sweepTasks.map((t) => ({ row: t.row, agent: t.agent, path: t.path })) }
      : {}),
    ...(optionalTasks.length
      ? {
          optional_task_files: optionalTasks.map((t) => ({
            row: t.row,
            agent: t.agent,
            path: t.path,
          })),
        }
      : {}),
  };
  const template = readFileSync(join(root, "prompts", templateFileForOrder(order)), "utf8");
  const rendered = renderRoundPrompt(
    template,
    order,
    MEMORY_LESS,
    cfg.owner.name,
    args.ecosystem,
    identity,
  );
  const orderText =
    rendered +
    "\n\n" +
    benchAppendix({
      repo: target.repo,
      pr: target.number,
      headSha: target.headSha,
      mergeBase: target.mergeBase,
      caseDir: args.caseDir,
      title: target.title,
      body,
      ...(cfg.review.render_outputs ? { renderOutputs: true } : {}),
      roundNo: args.roundNo,
      privateReplay: true,
      prevHead: args.prevHead,
    });
  const system = renderConversationSystemPrompt(
    readFileSync(join(root, "prompts", "conversation-system.md"), "utf8"),
    { pr: target.number, title, worktree: tree },
    identity,
  );
  for (const t of sweepTasks) extraFiles.push({ path: t.path, text: t.text });
  for (const t of optionalTasks) extraFiles.push({ path: t.path, text: t.text });
  return {
    system,
    order: orderText,
    plannedLenses: order.pass_plan.map((p) => p.agent),
    passPlan: order.pass_plan,
    taskFiles: taskFiles.map((t) => ({ path: t.path, text: t.text })),
    ...(packed.file ? { contextPack: packed.file } : {}),
    extraFiles,
    followUp: report,
    ...(built.sweep_plan && built.sweep_plan.length > 0 ? { sweepPlan: built.sweep_plan } : {}),
  };
}

// ---- the run ----------------------------------------------------------------

export interface OneShotInput {
  /** The production tree (prompts/, extensions/, agents/). Where the session
   * runs unless `cwd` says otherwise (the bench: its project-scope lens
   * agents live under it). */
  root: string;
  /** Where pi runs, and so which context file, project settings and project
   * agents it discovers. Omitted: `root`. The host route (`qcr review`) passes
   * the run's own dir outside every checkout, holding the reviewer stub, so a
   * checkout never carries a context file of ours (src/hostroute.ts). */
  cwd?: string;
  /** Which lens agents the session resolves: "project" (the nearest
   * `.pi/agents` above the cwd, the bench's) or "user" (`<agentDir>/agents`,
   * the host route's). Omitted: "project". */
  agentScope?: "project" | "user";
  /** pi's agent dir for this run (its login). */
  agentDir: string;
  /** The prepared checkout of the target, at its head. */
  tree: string;
  /** The files the target changes. */
  files: PrFileEntry[];
  target: OneShotTarget;
  /** Where the session's files, the event stream and the rendered review go. */
  outDir: string;
  cfg: Config;
  ecosystem: Ecosystem;
  timeoutMs: number;
  piBin?: string;
  /** pi's spill dir. Omitted: `<outDir>/tmp`, removed when the run ends. A
   * given dir is the caller's to create and remove. */
  tmpDir?: string;
  /** Prompts rendered by the caller (a bench follow-up). Omitted: the first
   * round's, rendered here. */
  prompts?: OneShotPrompts;
  dependencyNote?: string;
  /** The memory seed for the first round's prompt (ignored with `prompts`). */
  memory?: RoundMemory;
  /** Names the run in log lines (default `repo#number`). */
  label?: string;
  /** The session name pi is given (default `oneshot-<number>`). */
  sessionName?: string;
  /** When the caller's clock started, so the continuation's budget counts
   * work done before the runner (default: now). */
  startedAt?: number;
  /** Hard stop in dollars: the session (lens children with it) is killed once
   * pi's own price for the round reaches this. The result says `capped`. */
  capUsd?: number;
  log?: (line: string) => void;
}

export interface OneShotResult {
  prompts: OneShotPrompts;
  plannedLenses: string[];
  piRun: PiRun;
  /** The one `--continue` ran. */
  continued: boolean;
  /** The round was stopped at `capUsd` before it finished. */
  capped: boolean;
  /** Why the round could not be read: no session to continue, or the output
   * stream failed. */
  error?: string;
  /** Distinct warning lines from pi's stderr, then usage and render problems. */
  warnings: string[];
  /** Absent when the event stream could not be read. */
  usage?: ReturnType<typeof usageFromEvents>;
  modelErrors?: ModelErrors;
  stages?: Stages["phases"];
  /** pi's own price for the whole round (every lens child included). */
  costUsd: number | null;
  /** outcome.json: verdict, passes, summary. */
  outcome?: Record<string, unknown>;
  /** The findings record, after the production post-checks. */
  findings?: unknown;
  /** The rendered review body (review.md); null when nothing was rendered. */
  review: string | null;
  /** The rendered inline comments (comments.json). */
  comments?: unknown[];
  /** `[posting]` policy applied inside the render step (non-default only). */
  renderedPosting?: BenchPostingReport;
}

/** Run the review. A round that fails is a returned outcome (`error`, absent
 * `outcome`), never a throw; only an unwritable output dir throws. */
export async function runOneShot(i: OneShotInput): Promise<OneShotResult> {
  const log = i.log ?? (() => {});
  const label = i.label ?? `${i.target.repo}#${i.target.number}`;
  const started = i.startedAt ?? Date.now();
  const { cfg, outDir, tree, root } = i;
  const ownTmp = i.tmpDir === undefined;
  const tmpDir = i.tmpDir ?? join(outDir, "tmp");
  mkdirSync(outDir, { recursive: true });
  // What an earlier attempt wrote here is not this attempt's review.
  for (const f of [...Object.values(CASE_FILES), ...POLICED_ORIGINALS, ...PI_RUN_FILES])
    rmSync(join(outDir, f), { force: true });
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  try {
    const prompts =
      i.prompts ??
      renderOneShotPrompts({
        root,
        cfg,
        ecosystem: i.ecosystem,
        target: i.target,
        tree,
        caseDir: outDir,
        files: i.files,
        issuedAt: new Date().toISOString(),
        ...(i.dependencyNote ? { dependencyNote: i.dependencyNote } : {}),
        ...(i.memory ? { memory: i.memory } : {}),
      });
    // An earlier attempt's task files never leak into this one: launch_plan
    // launches every task file the dir holds.
    rmSync(join(outDir, "tasks"), { recursive: true, force: true });
    rmSync(join(outDir, CONTEXT_PACK_FILE), { force: true });
    for (const f of prompts.extraFiles ?? []) {
      mkdirSync(dirname(f.path), { recursive: true });
      writeFileSync(f.path, f.text);
    }
    if (prompts.contextPack) writeFileSync(prompts.contextPack.path, prompts.contextPack.text);
    if (prompts.taskFiles.length) {
      mkdirSync(join(outDir, "tasks"), { recursive: true });
      for (const t of prompts.taskFiles) writeFileSync(t.path, t.text);
    }
    const sysPath = join(outDir, "system-prompt.md");
    writeFileSync(sysPath, prompts.system);
    writeFileSync(join(outDir, "round-order.md"), prompts.order);
    writeFileSync(
      join(outDir, "files.json"),
      JSON.stringify(
        i.files.map(({ patch: _p, ...f }) => f),
        null,
        2,
      ),
    );
    const sessionName = i.sessionName ?? `oneshot-${i.target.number}`;
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      TMPDIR: tmpDir,
      LANG: "C.UTF-8",
      PI_CODING_AGENT_DIR: i.agentDir,
      QCR_SUBAGENT_SCOPE: i.agentScope ?? "project",
      QCR_SUBAGENT_MAX_CONCURRENCY: String(cfg.pi.subagent_max_concurrency),
      QCR_SUBAGENT_WIDE_FANOUT: cfg.review?.wide_lens_fanout === false ? "0" : "1",
      QCR_SUBAGENT_CACHE_GROUP: String(cfg.pi.subagent_cache_group ?? 0),
      QCR_SUBAGENT_CACHE_STAGGER_MS: String(
        cfg.pi.subagent_cache_stagger_ms ?? DEFAULT_SUBAGENT_CACHE_STAGGER_MS,
      ),
      QCR_LEAF_CACHE_EXT: join(root, "extensions", "leaf-cache.ts"),
      // This run's task dirs are its sanctioned launch_plan dirs
      // (production's live under state/pr-<n>-round-<k>-passes/).
      QCR_LAUNCH_PLAN_DIRS: [
        join(outDir, "tasks"),
        join(outDir, "tasks-optional"),
        join(outDir, "tasks-sweep"),
      ].join(delimiter),
      QCR_SANDBOX_ROOT: root,
      QCR_SESSION_NAME: sessionName,
      QCR_PR: String(i.target.number),
      QCR_PR_META: `PR #${i.target.number} — ${i.target.title ?? i.target.repo} (worktree ${tree})`,
      QCR_WORKTREE: tree,
      QCR_LEDGER_FILE: join(outDir, "ledger.md"),
      QCR_PI_VERSION: cfg.pi.version,
      ...GIT_ISOLATION_ENV,
      // An `anthropic/` model arm: pi's anthropic provider reads this key.
      ...(process.env.ANTHROPIC_API_KEY
        ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }
        : {}),
      // The API-key route (src/bench/auth.ts); nothing on the login route.
      ...apiKeyEnv(),
    };
    // No GitHub credential reaches a process whose model runs bash.
    for (const k of GITHUB_TOKEN_ENVS) delete env[k];
    const sessionDir = join(outDir, "session");
    // This attempt's session only: an earlier attempt's JSONL left here would
    // make `resumable` true and `--continue` would resume THAT conversation.
    rmSync(sessionDir, { recursive: true, force: true });
    // Host isolation: pi discovers nothing of its own. `-ne` leaves only the
    // extensions named below (so neither ~/.pi/agent, nor a project's `.pi/`,
    // nor a package can add one to the session) and `-ns` no skill; lens
    // children, which load only the agent dir's GLOBAL settings, get bash-guard
    // from there (the bench's and the host route's settings both register it).
    // `-nc` is deliberately absent: the cwd's context file is the reviewer stub.
    const base = [
      "--approve",
      "-ne",
      "-ns",
      "--model",
      cfg.models.conversation,
      "--session-dir",
      sessionDir,
      "--system-prompt",
      sysPath,
      "--extension",
      join(root, "extensions", "bash-guard.ts"),
      "--extension",
      join(root, "extensions", "ledger-pin.ts"),
      "--extension",
      join(root, "extensions", "subagents.ts"),
      // The live PR session's `cluster_findings` tool (src/sessions.ts
      // extensionPaths): the same grouping code on both routes.
      "--extension",
      join(root, "extensions", "finding-clusters.ts"),
      "--name",
      sessionName,
      "--mode",
      "json",
    ];
    const piBin = i.piBin ?? "pi";
    const events = join(outDir, PI_RUN_FILES[0]);
    const stderr = join(outDir, PI_RUN_FILES[1]);
    log(`review: ${label} — ${i.files.length} files, lenses ${prompts.plannedLenses.join(" ")}`);
    const cwd = i.cwd ?? root;
    let r = await runPi(
      [...base, "-p"],
      env,
      cwd,
      events,
      stderr,
      i.timeoutMs,
      piBin,
      prompts.order,
      i.capUsd,
    );
    const result: OneShotResult = {
      prompts,
      plannedLenses: prompts.plannedLenses,
      piRun: r,
      continued: false,
      capped: r.capped === true,
      warnings: [],
      costUsd: null,
      review: null,
    };
    const outcomePath = join(outDir, CASE_FILES.outcome);
    // One continuation, never more: the live system's answer to a round that
    // stopped short is redelivery, not a fresh review. Same session —
    // and only if there IS one: pi persists a session after its first
    // assistant message, and `--continue` on an empty session dir silently
    // starts a NEW session that would review with no round order at all.
    // A round whose files are there but do not parse stopped short too (a
    // model that broke its own JSON escaping): the same one continuation,
    // told which file and what the parser said. So did one that wrote its
    // outcome (the file written last) without a file the scorer reads.
    const broken = existsSync(outcomePath)
      ? unparseableOutputs(outDir, cfg.review.render_outputs)
      : [];
    const missing = existsSync(outcomePath)
      ? missingOutputs(outDir, cfg.review.render_outputs)
      : [];
    const resumable =
      existsSync(sessionDir) && readdirSync(sessionDir).some((f) => f.endsWith(".jsonl"));
    if (!r.timedOut && !r.streamError && !existsSync(outcomePath) && !resumable) {
      result.error = `pi exited ${String(r.code)} before any assistant message — nothing to continue`;
    }
    const stoppedShort = !existsSync(outcomePath) || broken.length > 0 || missing.length > 0;
    if (!r.timedOut && !r.streamError && !result.capped && stoppedShort && resumable) {
      const left = i.timeoutMs - (Date.now() - started);
      if (left > 120_000) {
        result.continued = true;
        log(
          broken.length
            ? `review: ${label} — ${broken.join("; ")}, one continuation`
            : missing.length
              ? `review: ${label} — ${missing.join(", ")} not written, one continuation`
              : `review: ${label} — no outcome.json yet, one continuation`,
        );
        r = await runPi(
          [
            ...base,
            "--continue",
            "-p",
            broken.length
              ? `Your BENCHMARK MODE files in ${outDir} cannot be read: ${broken.join("; ")}. Rewrite ${broken.length > 1 ? "them" : "it"} as valid JSON with the same content — plain double quotes, no escaped quotes around keys or values — and write ${CASE_FILES.outcome} last.`
              : cfg.review.render_outputs
                ? `You stopped before the BENCHMARK MODE files were complete. Finish the round now and write ${CASE_FILES.findings} (with the posting fields) and, last, ${CASE_FILES.outcome} in ${outDir}.`
                : `You stopped before the BENCHMARK MODE files were complete. Finish the round now and write ${CASE_FILES.comments}, ${CASE_FILES.review}, ${CASE_FILES.findings} and, last, ${CASE_FILES.outcome} in ${outDir}.`,
          ],
          env,
          cwd,
          events,
          stderr,
          left,
          piBin,
          undefined,
          i.capUsd === undefined ? undefined : Math.max(0, i.capUsd - (r.spentUsd ?? 0)),
        );
        result.piRun = r;
        result.capped = r.capped === true;
      }
    }
    result.warnings = [
      ...new Set(
        readFileSync(stderr, "utf8")
          .split("\n")
          .filter((l) => /warn|error|fatal|failed/i.test(l))
          .map((l) => l.trim().slice(0, 300)),
      ),
    ].slice(0, 20);
    if (r.streamError) result.error = `output stream failed: ${r.streamError}`;
    // Usage is telemetry: a failure to read it must never cost the review.
    try {
      const lines = readFileSync(events, "utf8").split("\n");
      result.usage = usageFromEvents(lines);
      result.modelErrors = modelErrorsFromEvents(lines);
      // Per-stage cost and time (stages.json; the per-phase totals ride along).
      const stages = stagesFromEvents(lines);
      writeFileSync(join(outDir, "stages.json"), JSON.stringify(stages, null, 2) + "\n");
      result.stages = stages.phases;
      // pi's own stderr reports what never reached a message (a refused
      // connection, a 429 before the first token).
      for (const w of result.warnings) {
        const kind = modelErrorKind(w);
        if (kind === "usage_limit")
          result.modelErrors.usage_limit = (result.modelErrors.usage_limit ?? 0) + 1;
        else if (kind === "rate_limited") result.modelErrors.rate_limited++;
        else if (kind === "overloaded") result.modelErrors.overloaded++;
      }
    } catch (err) {
      result.warnings.push(`usage unreadable: ${String(err).slice(0, 200)}`);
    }
    try {
      result.costUsd = caseCostUsd(outDir)?.usd ?? null;
    } catch {
      result.costUsd = null;
    }
    const outcome = readJson(outcomePath) as Record<string, unknown> | undefined;
    if (outcome !== undefined) result.outcome = outcome;
    // `[review] render_outputs`: comments.json and review.md rendered from the
    // findings record, as production's render-review.sh renders them. A
    // session that wrote its own files anyway is overruled: the record is the
    // source.
    if (cfg.review.render_outputs) {
      const record = readJson(join(outDir, CASE_FILES.findings));
      if (record !== undefined) {
        const out = renderBenchOutputs(record, outcome, cfg);
        writeFileSync(
          join(outDir, CASE_FILES.comments),
          JSON.stringify(out.rendered.comments, null, 2) + "\n",
        );
        writeFileSync(join(outDir, CASE_FILES.review), out.rendered.body);
        // The duplicate-merge post-check's and the posting policy's
        // dispositions, kept in the record (the session's own beside it).
        if (out.record !== record) {
          writeFileSync(join(outDir, POLICED_ORIGINALS[2]), JSON.stringify(record, null, 2) + "\n");
          writeFileSync(
            join(outDir, CASE_FILES.findings),
            JSON.stringify(out.record, null, 2) + "\n",
          );
        }
        // The `[posting]` cut ran inside the render step, as on the live
        // route — so a caller must not cut a second time.
        if (!isDefaultPosting(cfg.posting)) {
          result.renderedPosting = {
            kept: out.rendered.comments.length + out.rendered.in_body,
            withheld: out.withheld.map((w) => ({
              path: w.path ?? "",
              line: w.line ?? 0,
              source: w.inline ? ("inline" as const) : ("body" as const),
              cls: w.cls,
              severity: w.severity,
              word: w.word,
              title: w.title,
            })),
            body: cfg.posting!.body,
          };
          writeFileSync(
            join(outDir, POLICED_ORIGINALS[3]),
            JSON.stringify(result.renderedPosting, null, 2) + "\n",
          );
        }
        if (out.rendered.problems.length)
          result.warnings.push(
            ...out.rendered.problems.slice(0, 10).map((p) => `render: ${p}`.slice(0, 300)),
          );
      }
    }
    const findings = readJson(join(outDir, CASE_FILES.findings));
    if (findings !== undefined) result.findings = findings;
    const comments = readJson(join(outDir, CASE_FILES.comments));
    if (Array.isArray(comments)) result.comments = comments;
    const reviewPath = join(outDir, CASE_FILES.review);
    if (existsSync(reviewPath)) result.review = readFileSync(reviewPath, "utf8");
    return result;
  } finally {
    if (ownTmp) rmSync(tmpDir, { recursive: true, force: true });
  }
}
