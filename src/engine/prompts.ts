// The one-shot review's prompts: the first round's and a follow-up round's
// order and system prompt for a target, rendered by the production renderers
// (dispatch.ts buildRoundOrder, templates.ts). Pure: the files the order names
// are returned for the runner to write; nothing here runs a session.
//
// Shared by the benchmark (src/bench/runner.ts), `qcr review` and the engine.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
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
} from "../dispatch.js";
import { parseLedgerCarry, settledFromLedger } from "../ledgercarry.js";
import type { CiLinter } from "../lintconfig.js";
import type { PriorFindingsList } from "../priorfindings.js";
import type { Ecosystem } from "../ecosystem.js";
import type { PrFileEntry } from "../github.js";
import { CONTEXT_PACK_FILE, readWorktreeFileForPack, renderContextPack } from "../contextpack.js";
import { identityVars } from "../include.js";
import { lensRuntimeOf } from "../launchvocab.js";
import { lensEnabled } from "../lenstuning.js";
import { MEMORY_LESS, type RoundMemory } from "../memory/context.js";
import { renderPassTasks } from "../passtasks.js";
import { loadProfileHeuristics, type ProfileLookup } from "../profiles.js";
import { directiveVocabulary, isFirstPartyDirectivePath } from "../severity.js";
import type { PrStateRow } from "../state.js";
import {
  renderConversationSystemPrompt,
  renderGateNotes,
  renderRoundPrompt,
  roundTemplateFile,
  templateFileForOrder,
} from "../templates.js";
import type { PassPlanEntry, RoundOrder } from "../types.js";
import { findCiLinters } from "../lintconfig.js";
import { findStyleGuide } from "../styleguide.js";
import { benchAppendix } from "../bench/aacr.js";

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
  /** Reads a shipped `prompts/` file instead of the disk: where a profile's
   * replacement is served (src/profileoverrides.ts). Absent: the file itself. */
  readFile?: (path: string) => string;
  /** The profile loaders' lookup, carrying the repo profile's layer. */
  profileLookup?: ProfileLookup;
}): OneShotPrompts {
  const { root, cfg, target, tree } = args;
  const readPrompt = (name: string): string => {
    const path = join(root, "prompts", name);
    return args.readFile ? args.readFile(path) : readFileSync(path, "utf8");
  };
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
    heuristics: loadProfileHeuristics(root, cfg.review.profile, args.profileLookup),
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
        ...lensRuntimeOf(cfg),
        pass_task_files: taskFiles.map((t) => ({ row: t.row, agent: t.agent, path: t.path })),
      }
    : { ...unrendered, ...lensRuntimeOf(cfg) };
  const template = readPrompt(roundTemplateFile("first"));
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
      ...lensRuntimeOf(cfg),
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
    readPrompt("conversation-system.md"),
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
  /** Reads a shipped `prompts/` file instead of the disk: where a profile's
   * replacement is served (src/profileoverrides.ts). Absent: the file itself. */
  readFile?: (path: string) => string;
  /** The profile loaders' lookup, carrying the repo profile's layer. */
  profileLookup?: ProfileLookup;
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
  const readPrompt = (name: string): string => {
    const path = join(root, "prompts", name);
    return args.readFile ? args.readFile(path) : readFileSync(path, "utf8");
  };
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
  const heuristics = loadProfileHeuristics(root, cfg.review.profile, args.profileLookup);
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
    ...lensRuntimeOf(cfg),
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
  const template = readPrompt(templateFileForOrder(order));
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
      ...lensRuntimeOf(cfg),
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
    readPrompt("conversation-system.md"),
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
