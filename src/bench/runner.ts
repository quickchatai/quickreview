// AACR-Bench review runner — one production review round per case, offline,
// inside the `qcr-bench` sandbox (bench/aacr/Dockerfile).
//
// What is PRODUCTION here, byte for byte: the persona
// (prompts/conversation-system.md), the round order (prompts/round-first.md
// through the production renderer), the pass plan (buildRoundOrder →
// buildPassPlan), the built lens + validator agents (buildAgents with
// PASS_ADDENDA and, if chosen, a profile's addenda), the models and tiers
// (config.toml [models]) and the pi extensions a PR session loads for its
// review work (subagents glue + ledger-pin; bash-guard globally, as the VM
// registers it).
//
// What is NOT, and why:
//   - memory: off. A benchmark of a foreign repo must not read the deployed
//     repo's memory, and a PR session's memory extension would also WRITE its turns
//     into reviewer memory (vendor/openviking-pi syncTurns).
//   - inject-bridge / tmux: a benchmark round is one `pi -p` process that
//     exits when the agent settles; there is no daemon to deliver wakes.
//   - GitHub/CI/posting: replaced by `benchAppendix` (see aacr.ts header).
//   - profile: generic ("") by default — the deployed profile's Django house
//     rules would be noise on a Rust PR. `--profile <config.toml [review]
//     profile>` measures production as deployed.

import {
  normalizePassPhase,
  normalizeSweepClaim,
  sweepSkippedOnApprove,
  sweepStatusOf,
  type SweepClaim,
  type SweepStatus,
} from "../sweepstatus.js";
import {
  jsonProblem,
  missingOutputs,
  readJson,
  runOneShot,
  unparseableOutputs,
  PI_RUN_FILES,
  type PiRun,
} from "../oneshot.js";
import {
  boundBody,
  renderFollowUpOneShotPrompts,
  renderOneShotPrompts,
  type OneShotPrompts,
} from "../engine/prompts.js";
import { renderBenchOutputs } from "../engine/render.js";

// The prompts, render and context moved to src/engine/; their callers still
// import them from here.
export { boundBody, jsonProblem, missingOutputs, renderBenchOutputs, unparseableOutputs };
export type { PiRun };
export {
  applyConfigOverrides,
  OPEN_MAP_KEYS,
  withAuthModels,
  withPresetInToml,
} from "../engine/context.js";
export { benchConfig, contextFor } from "../reviewcontext.js";
import type { Runtime, SessionSpec } from "../engine/port.js";
import { publishChangedResult } from "./publication.js";
import {} from "../reviewrender.js";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {} from "node:child_process";
import {} from "node:readline";
import { dirname, join } from "node:path";
import {
  REVIEW_DEFAULTS,
  type Config,
  type EngineRuntimeKind,
  type LensRuntimeKind,
} from "../config.js";
import {} from "../dispatch.js";
import type { PrOwnedDelta } from "../worktrees.js";
import { benchDelta, benchPriorFindings, decideBenchFollowUp } from "./followup.js";
import type { Ecosystem } from "../ecosystem.js";
import type { PrFileEntry } from "../github.js";
import {} from "../contextpack.js";
import { prepareDependencySources, renderDependencyNote } from "../depsources.js";
import {
  assessOverrides,
  overrideReader,
  resolveOverrides,
  type Customisation,
} from "../profileoverrides.js";
import type { LensTuning } from "../lenstuning.js";
import { homeProfileLookup } from "../install.js";
import type { ProfileLookup } from "../profiles.js";
import { isDefaultPosting, type PostingPolicy } from "../postingpolicy.js";
// The round's lens agents are built by the core (`qcr review` builds them too).
import { buildBenchAgents } from "../engine/roundagents.js";
export { buildBenchAgents };
import { enforceBenchPosting, POLICED_ORIGINALS, type BenchPostingReport } from "./benchposting.js";
import {} from "../severity.js";
import type { PassPlanEntry } from "../types.js";
import {} from "../templates.js";
import {
  CASE_FILES,
  filesFromGitDiff,
  bodyPostedFindings,
  type ModelErrors,
  parseSessionComments,
  reanchorLeftComments,
  patchFromGitDiff,
  safeId,
  toOcrResult,
  type Stages,
  VARIANTS,
  type BenchCase,
  type BenchComment,
  type PrefetchMeta,
  type Variant,
} from "./aacr.js";
import { GIT_ISOLATION_ENV, must, run } from "./exec.js";
import { dropMetricsFiles } from "./report.js";
import { authFingerprint } from "./auth.js";

export interface RunnerOptions {
  /** The production tree inside the image (`/opt/quickreview/sandbox`) — the
   * session's cwd, exactly as on the VM. */
  root: string;
  /** Prefetched per-instance object stores (read-only mount). */
  store: string;
  /** This run's output dir (the one host bind mount that is written). */
  outDir: string;
  /** pi's agent dir for this run: a PRIVATE tmpfs dir holding a copy of the
   * shared login with its refresh token disabled (src/bench/auth.ts). */
  agentDir: string;
  timeoutMs: number;
  /** Hosts the review session: the SDK runtime. Required to review a case in
   * this process (a pooled run hosts each case in a process of its own). */
  runtime?: Runtime;
  keepTree?: boolean;
  log?: (line: string) => void;
}

export interface CaseSummary {
  instance_id: string;
  /** `no-verdict`: the round wrote its files but decided nothing (its pass
   * infrastructure failed) — not a review, so `--resume` runs it again. */
  status: "ok" | "no-verdict" | "no-output" | "timeout" | "failed";
  error?: string;
  /** What produced this case: `--resume` re-runs a case whose fingerprint
   * differs from the current run's, so one run never mixes builds. */
  fingerprint?: RunFingerprint;
  verdict: string | null;
  duration_seconds: number;
  usage: { input: number; output: number; cacheRead: number; children: number };
  planned_lenses: string[];
  executed_passes: string[];
  comments: {
    total: number;
    by_tag: Record<string, number>;
    left_side: number;
    /** LEFT-side comments moved to the head side of their hunk. */
    reanchored?: number;
    unparseable: number;
    /** Posted in the review body (no valid inline anchor) — scored too. */
    body: number;
  };
  pr_meta: { title: boolean; body: boolean; base_ref_source: string };
  diff: { files: number; additions: number; deletions: number };
  continued: boolean;
  /** pi's stderr warnings/errors, deduplicated — a degraded run (settings
   * ignored, an extension that failed to load) must be visible in the report,
   * not only in a log nobody opens. */
  warnings: string[];
  /** Failed model calls by kind (aacr.ts modelErrorsFromEvents, plus pi's
   * stderr): how arm.sh tells the shared login pushing back from a review
   * that genuinely failed. Absent on older summaries. */
  model_errors?: ModelErrors;
  /** What the profile's `[posting]` policy did to the session's output
   * (src/bench/benchposting.ts). Absent at the default posting. */
  posting?: BenchPostingReport;
  /** A follow-up replay case — what it ran as (delta or full, and
   * why). Absent on every other case. */
  follow_up?: CaseFollowUp;
  /** Per-phase subagent totals (aacr.ts stagesFromEvents; the per-call rows
   * are in the case's stages.json). Absent on older summaries. */
  stages?: Stages["phases"];
}

/** Whether a finished case should be re-run: anything but `ok`, except a case
 * that can never run (not prefetched — a re-run fails the same way). */
export function retryable(s: Pick<CaseSummary, "status" | "error">): boolean {
  return s.status !== "ok" && !/not prefetched/.test(s.error ?? "");
}

/** The one machine-readable line a case ends with; arm.sh's scheduler reads
 * it (and nothing inside the run dir) to decide retries, rate-limit pauses
 * and its adaptive concurrency. `limited` counts rate-limit, overload and
 * usage-limit errors; `quota=N` (only when N > 0) says N of them were the
 * plan's usage window running out, which stops new launches outright. */
export function limitedModelErrors(s: Pick<CaseSummary, "model_errors">): number {
  const e = s.model_errors;
  return e ? e.rate_limited + e.overloaded + (e.usage_limit ?? 0) : 0;
}

export function resultLine(s: CaseSummary, skipped = false): string {
  const e = s.model_errors;
  const quota = e?.usage_limit ?? 0;
  const limited = limitedModelErrors(s);
  return `result: ${s.instance_id} ${s.status} retry=${retryable(s) ? 1 : 0} limited=${limited}${quota ? ` quota=${quota}` : ""}${skipped ? " skipped" : ""}`;
}

export interface RunFingerprint {
  qcr_commit: string;
  profile: string;
  /** `--config` levers this run set ("" = the shipped config). */
  overrides?: string;
  /** Present only on the API-key route (src/bench/auth.ts authFingerprint). */
  auth?: "api-key";
  inference?: { provider: "digitalocean" | "google"; config_sha256: string };
  conversation: string;
  tiers: Record<string, string>;
  validate_tier: string;
  pi: string;
  /** `[models] effort` and what "high" meant for this run. */
  effort?: { effort: string; effort_max: string };
  /** The review preset and the levers it resolved to (explicit keys included). */
  preset?: string;
  levers?: {
    sublenses: boolean;
    sweep: boolean;
    sweep_max_groups: number;
    sweep_group_files?: number;
    sweep_group_lines?: number;
    sweep_wide_files?: number;
    intent_min_words?: number;
    placement_min_code_files?: number;
    placement_min_new_file_lines?: number;
    dependency_sources: boolean;
    tests_lens: boolean;
    quality_lenses?: boolean;
    quality_min_added_lines?: number;
    style_lens?: boolean;
    nits?: string;
    validate_demote?: boolean;
    skip_lenses?: string[];
    validate_consequence_rule?: boolean;
    /** The follow-up knobs, recorded only when they differ from the shipped
     * default, so a run at the default keeps its fingerprint. */
    follow_up?: string;
    follow_up_max_delta_ratio?: number;
    follow_up_sweep?: boolean;
    /** The baseline split threshold, recorded only when it differs
     * from the shipped default (2000). */
    baseline_split_lines?: number;
    /** Each set only when it differs from the shipped default: a light sweep
     * tier is named, or the validator's compact decision table is off. */
    sweep_light_tier?: string;
    validate_compact?: boolean;
  };
  /** The profile's resolved per-lens tuning. Absent when untuned, so an
   * untuned run's fingerprint carries no tuning field. A profile style guide
   * is recorded by name and content hash. */
  lenses?: Record<string, FingerprintLensTuning>;
  /** Per-lens tier pins (`[models.pass_tiers]`) and the risk passes. */
  pass_tiers?: Record<string, string>;
  /** Per-lens model overrides (`[models.pass_models]`). Absent when
   * none, so a run without one keeps its fingerprint. */
  pass_models?: Record<string, string>;
  risk_passes?: string[];
  /** The profile's `[posting]` policy. Absent at the default posting, so a run
   * without one keeps its fingerprint. */
  posting?: PostingPolicy;
  /** Present only on an SDK run (`[engine] runtime = "sdk"`, the config default
   * since P7.12), with the lens tool it ran and `wave: true` when the engine
   * started the planned discovery wave (`[pi] engine_wave`, also the default).
   * A proc run keeps its fingerprint, and `--resume` never mixes a case reviewed
   * on one host, lens tool or wave setting with one reviewed on another. */
  engine?: { runtime: "sdk"; lens_runtime: LensRuntimeKind; wave?: true };
  /** Set only on a run whose profile replaced shipped agents or prompts and
   * was allowed to (`--allow-customised`); an uncustomised run keeps its
   * fingerprint. */
  customised?: true;
  profile_overrides?: Array<{ path: string; origin: string; sha256: string }>;
  /** sha256 of the whole effective `[review]` table and the subagent
   * settings the case's pi runs under: a setting none of the named fields
   * above records (task files, rendered outputs, the context pack, a lever
   * added later) still tells two configurations apart. */
  settings_sha256?: string;
}

/** The settings `settings_sha256` covers. */
function reviewSettingsDigest(cfg: Config): string {
  const settings = {
    review: cfg.review,
    subagents: {
      max_concurrency: cfg.engine.lens_max_concurrency,
      cache_group: cfg.engine.lens_cache_group,
      cache_stagger_ms: cfg.engine.lens_cache_stagger_ms,
    },
  };
  return createHash("sha256").update(JSON.stringify(settings)).digest("hex");
}

type FingerprintLensTuning = Omit<LensTuning, "guide"> & {
  guide?: { file: string; sha256: string };
};

function fingerprintLenses(
  lenses: Readonly<Record<string, LensTuning>>,
): Record<string, FingerprintLensTuning> {
  const out: Record<string, FingerprintLensTuning> = {};
  for (const [lens, { guide, ...rest }] of Object.entries(lenses)) {
    out[lens] = {
      ...structuredClone(rest),
      ...(guide
        ? {
            guide: {
              file: guide.file,
              sha256: createHash("sha256").update(guide.text).digest("hex"),
            },
          }
        : {}),
    };
  }
  return out;
}

export function runFingerprint(
  cfg: Config,
  profile: string,
  overrides = "",
  custom?: Customisation,
  /** What hosts the sessions, when it is not the process runtime. */
  host?: { runtime: EngineRuntimeKind; lens_runtime: LensRuntimeKind; engine_wave?: boolean },
): RunFingerprint {
  // A lever at its shipped default is left out, so a run fingerprints the
  // same as one from before the lever existed.
  const D = REVIEW_DEFAULTS;
  return {
    qcr_commit: process.env.QCR_BENCH_COMMIT ?? "unknown",
    profile,
    ...(overrides ? { overrides } : {}),
    ...authFingerprint(),
    conversation: cfg.models.conversation,
    tiers: { ...cfg.models.tiers },
    validate_tier: cfg.models.validate_tier,
    pass_tiers: { ...(cfg.models.pass_tiers ?? {}) },
    ...(Object.keys(cfg.models.pass_models ?? {}).length > 0
      ? { pass_models: { ...cfg.models.pass_models } }
      : {}),
    risk_passes: [...cfg.models.risk_passes],
    pi: cfg.pi.version,
    effort: { effort: cfg.models.effort, effort_max: cfg.models.effort_max },
    preset: cfg.review.preset,
    levers: {
      sublenses: cfg.review.sublenses,
      sweep: cfg.review.sweep,
      sweep_max_groups: cfg.review.sweep_max_groups,
      sweep_group_files: cfg.review.sweep_group_files,
      sweep_group_lines: cfg.review.sweep_group_lines,
      sweep_wide_files: cfg.review.sweep_wide_files,
      intent_min_words: cfg.review.intent_min_words,
      placement_min_code_files: cfg.review.placement_min_code_files,
      placement_min_new_file_lines: cfg.review.placement_min_new_file_lines,
      dependency_sources: cfg.review.dependency_sources,
      tests_lens: cfg.review.tests_lens,
      quality_lenses: cfg.review.quality_lenses,
      quality_min_added_lines: cfg.review.quality_min_added_lines,
      style_lens: cfg.review.style_lens,
      nits: cfg.review.nits,
      validate_demote: cfg.review.validate_demote,
      skip_lenses: [...(cfg.review.skip_lenses ?? [])],
      validate_consequence_rule: cfg.review.validate_consequence_rule ?? false,
      ...((cfg.review.follow_up ?? D.follow_up) !== D.follow_up
        ? { follow_up: cfg.review.follow_up }
        : {}),
      ...((cfg.review.follow_up_max_delta_ratio ?? D.follow_up_max_delta_ratio) !==
      D.follow_up_max_delta_ratio
        ? { follow_up_max_delta_ratio: cfg.review.follow_up_max_delta_ratio }
        : {}),
      ...((cfg.review.follow_up_sweep ?? D.follow_up_sweep) !== D.follow_up_sweep
        ? { follow_up_sweep: cfg.review.follow_up_sweep }
        : {}),
      ...((cfg.review.baseline_split_lines ?? D.baseline_split_lines) !== D.baseline_split_lines
        ? { baseline_split_lines: cfg.review.baseline_split_lines }
        : {}),
      ...(cfg.review.sweep_light_tier ? { sweep_light_tier: cfg.review.sweep_light_tier } : {}),
      ...(cfg.review.validate_compact === false ? { validate_compact: false } : {}),
    },
    ...(Object.keys(cfg.lenses ?? {}).length > 0 ? { lenses: fingerprintLenses(cfg.lenses!) } : {}),
    ...(isDefaultPosting(cfg.posting) ? {} : { posting: { ...cfg.posting! } }),
    ...(custom?.customised
      ? {
          customised: true as const,
          profile_overrides: custom.overrides.map((o) => ({
            path: o.path,
            origin: o.origin,
            sha256: o.sha256,
          })),
        }
      : {}),
    ...(host?.runtime === "sdk"
      ? {
          engine: {
            runtime: "sdk" as const,
            lens_runtime: host.lens_runtime,
            ...(host.engine_wave ? { wave: true as const } : {}),
          },
        }
      : {}),
    settings_sha256: reviewSettingsDigest(cfg),
  };
}

/**
 * The profile's replacements of shipped agents and prompts for a bench run.
 * A bench run measures the shipped files, so a profile that replaces any is
 * refused unless `allow` (`--allow-customised`); an allowed run is served the
 * replacements and records them in its fingerprint. With none, `readFile` is
 * absent and the run is exactly what it always was.
 */
export function benchCustomisation(
  root: string,
  profile: string,
  allow: boolean,
): { readFile?: (path: string) => string; lookup: ProfileLookup; custom: Customisation } {
  // The install's homes: the agents build looks the profile up there too.
  const lookup = homeProfileLookup();
  const set = resolveOverrides({ root, profile, lookup });
  const custom = assessOverrides(root, set);
  if (custom.customised && !allow)
    throw new Error(
      `bench: profile "${profile}" replaces shipped files, so this run would not measure them: ` +
        `${custom.overrides.map((o) => o.path).join(", ")}. Pass --allow-customised to run it anyway ` +
        "(the run is recorded as customised).",
    );
  const readFile = overrideReader(root, set);
  return { ...(readFile ? { readFile } : {}), lookup, custom };
}

/** Git reads no system or global configuration and never prompts — for the
 * harness's own git calls and the reviewer's alike. */
const GIT_ENV = { ...process.env, ...GIT_ISOLATION_ENV };

async function git(tree: string, args: string[]): Promise<string> {
  return must("git", ["-C", tree, ...args], { env: GIT_ENV, timeoutMs: 10 * 60_000 });
}

/**
 * Materialise the reviewed head as a fresh repo whose objects come from the
 * prefetched store through `alternates` (the store is mounted read-only, so
 * nothing can be written back into it) and whose only refs are the detached
 * head and `origin/<base_ref>` at the PR's base — the exact vocabulary the
 * round template uses. No other ref, so no later commit, is reachable.
 */
export async function prepareTree(store: string, tree: string, meta: PrefetchMeta): Promise<void> {
  rmSync(tree, { recursive: true, force: true });
  mkdirSync(tree, { recursive: true });
  await git(tree, ["init", "--quiet"]);
  writeFileSync(join(tree, ".git", "objects", "info", "alternates"), `${join(store, "objects")}\n`);
  const shallow = join(store, "shallow");
  if (existsSync(shallow)) writeFileSync(join(tree, ".git", "shallow"), readFileSync(shallow));
  await git(tree, ["update-ref", `refs/remotes/origin/${meta.base_ref}`, meta.base_commit]);
  // A follow-up case: the head the previous round reviewed — the
  // delta's from side. It is the PR's past, never its future.
  if (meta.prev_head) await git(tree, ["update-ref", "refs/bench/prev-head", meta.prev_head]);
  await git(tree, [
    "-c",
    "advice.detachedHead=false",
    "checkout",
    "--quiet",
    "--detach",
    meta.head_commit,
  ]);
}

/** The PR's changed files between the merge-base and the head, with each
 * file's hunks (as GitHub's `patch`) for the first 300. */
export async function changedFiles(tree: string, meta: PrefetchMeta): Promise<PrFileEntry[]> {
  const range = [meta.merge_base, meta.head_commit];
  const nameStatus = await git(tree, ["diff", "-z", "--name-status", "-M", ...range]);
  const numstat = await git(tree, ["diff", "-z", "--numstat", "-M", ...range]);
  const patches = new Map<string, string>();
  const first = filesFromGitDiff(nameStatus, numstat);
  // Per-file hunks for the lens probes, bounded: past 300 files a PR's patch
  // content stops changing which lenses fire.
  for (const f of first.slice(0, 300)) {
    // A renamed file's diff needs its old path too: restricted to the new one
    // alone, git sees no rename and reports every line as added.
    const paths = f.previous_filename ? [f.previous_filename, f.filename] : [f.filename];
    const d = await run("git", ["-C", tree, "diff", "-M", ...range, "--", ...paths], {
      env: GIT_ENV,
      maxBytes: 400_000,
    });
    const p = d.code === 0 ? patchFromGitDiff(d.stdout) : undefined;
    if (p !== undefined) patches.set(f.filename, p);
  }
  return filesFromGitDiff(nameStatus, numstat, patches);
}

/** The round order + system prompt this case runs — production renderers. */
export function renderCasePrompts(args: {
  root: string;
  cfg: Config;
  ecosystem: Ecosystem;
  c: BenchCase;
  meta: PrefetchMeta;
  tree: string;
  caseDir: string;
  files: PrFileEntry[];
  issuedAt: string;
  /** The rendered third-party-sources block, "" when none (depsources.ts). */
  dependencyNote?: string;
  /** A follow-up case: the PR-owned delta `benchDelta` computed over
   * the tree (undefined = none could be — the round runs in full). */
  followUpDelta?: PrOwnedDelta;
  /** A customised run's replacements (`benchCustomisation`). */
  readFile?: (path: string) => string;
}): CasePrompts {
  if (args.c.followup) return renderFollowUpPrompts(args);
  const { c, meta } = args;
  return renderOneShotPrompts({
    root: args.root,
    profileLookup: homeProfileLookup(),
    cfg: args.cfg,
    ecosystem: args.ecosystem,
    target: {
      repo: c.repo,
      number: c.pr,
      title: meta.title,
      body: meta.body,
      headSha: c.head_commit,
      baseRef: meta.base_ref,
      baseSha: meta.base_commit,
      mergeBase: meta.merge_base,
      fallbackTitle: `AACR-Bench ${c.repo}#${c.pr}`,
    },
    tree: args.tree,
    caseDir: args.caseDir,
    files: args.files,
    issuedAt: args.issuedAt,
    ...(args.dependencyNote ? { dependencyNote: args.dependencyNote } : {}),
    ...(args.readFile ? { readFile: args.readFile } : {}),
  });
}

export interface CasePrompts extends OneShotPrompts {
  /** A follow-up case only: what the round runs as; and the
   * pre-approval sweep's plan when one is owed. */
  followUp?: CaseFollowUp;
  sweepPlan?: PassPlanEntry[];
}

/** What a follow-up case ran as (CaseSummary.follow_up). */
export interface CaseFollowUp {
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
  /** What the session reported: each executed pass's phase, and
   * the sweep — its claim and the status production's `sweepStatusOf` gives
   * it (an APPROVE with the sweep owed and not `ran` is what production flags
   * as `followup_sweep_skipped`). Absent until the case has an outcome. */
  executed_phases?: Array<{ agent: string; phase: "delta" | "sweep" | null }>;
  sweep?: {
    claim: SweepClaim | null;
    status: SweepStatus;
    note?: string;
    sweep_passes: number | null;
    skipped: boolean;
  };
}

/**
 * A follow-up case's report of what the session ran: each executed
 * pass's `phase` and the sweep — its claim and the status production's
 * `sweepStatusOf` gives it, `skipped` when an APPROVE left an owed sweep
 * un-run (production's `followup_sweep_skipped`). Pure; a full-scope case is
 * returned unchanged.
 */
export function followUpOutcomeOf(
  fu: CaseFollowUp,
  outcome: Record<string, unknown>,
  verdict: string | null,
): CaseFollowUp {
  if (fu.scope !== "delta") return fu;
  const passes = Array.isArray(outcome["passes"])
    ? (outcome["passes"] as Array<Record<string, unknown>>)
    : null;
  const phaseOf = (p: Record<string, unknown>): "delta" | "sweep" | null =>
    normalizePassPhase(p["phase"]);
  const claim = normalizeSweepClaim(outcome["sweep"]);
  const sweepPasses = passes ? passes.filter((p) => phaseOf(p) === "sweep").length : null;
  const owed = fu.sweep_owed === true;
  const { status, note } = sweepStatusOf({
    owed,
    claim,
    sweepPasses,
    receiptSettled: false,
    verdict,
  });
  return {
    ...fu,
    ...(passes
      ? {
          executed_phases: passes.map((p) => ({
            agent: executedAgent(p),
            phase: phaseOf(p),
          })),
        }
      : {}),
    sweep: {
      claim,
      status,
      ...(note ? { note } : {}),
      sweep_passes: sweepPasses,
      skipped: sweepSkippedOnApprove(verdict, owed, status),
    },
  };
}

/**
 * The order of a follow-up replay case: production's round k, built by the
 * shared follow-up renderer (src/oneshot.ts) with the case's own answers to
 * what the daemon's state would supply (`decideBenchFollowUp`, the recorded
 * prior findings and ledger).
 */
function renderFollowUpPrompts(args: Parameters<typeof renderCasePrompts>[0]): CasePrompts {
  const { c, meta } = args;
  const fu = c.followup!;
  return renderFollowUpOneShotPrompts({
    root: args.root,
    profileLookup: homeProfileLookup(),
    ...(args.readFile ? { readFile: args.readFile } : {}),
    cfg: args.cfg,
    ecosystem: args.ecosystem,
    target: {
      repo: c.repo,
      number: c.pr,
      title: meta.title,
      body: meta.body,
      headSha: c.head_commit,
      baseRef: meta.base_ref,
      baseSha: meta.base_commit,
      mergeBase: meta.merge_base,
      fallbackTitle: `AACR-Bench ${c.repo}#${c.pr}`,
    },
    tree: args.tree,
    caseDir: args.caseDir,
    files: args.files,
    issuedAt: args.issuedAt,
    ...(args.dependencyNote ? { dependencyNote: args.dependencyNote } : {}),
    roundNo: fu.round_no,
    reviewNo: fu.review_no,
    prevHead: fu.prev_head,
    ...(fu.ledger !== undefined ? { ledger: fu.ledger } : {}),
    decide: (ctx) =>
      decideBenchFollowUp(args.cfg, ctx.heuristics, c, {
        delta: args.followUpDelta,
        files: args.files,
        fullPlan: ctx.fullPlan,
        ecosystem: args.ecosystem,
        styleGuide: ctx.styleGuide,
        ciLinters: ctx.ciLinters,
      }),
    prior: (sidecarPath) => benchPriorFindings(c, sidecarPath),
    priorCount: fu.prior_findings.length,
  });
}

/**
 * The defect judge's session (src/bench/defectjudge.ts): no session, no
 * skills/templates/context files, no project-local files, no extension but the
 * no-exec bash guard, and only the \`read\` and \`bash\` tools. The judge reads
 * code to check a claim; it never runs it and never writes.
 */
export function judgeSessionSpec(
  root: string,
  model: string,
  rest: Pick<SessionSpec, "cwd" | "env" | "eventsFile" | "stderrFile" | "limits">,
): SessionSpec {
  return {
    ...rest,
    model,
    tools: ["read", "bash"],
    extensions: [join(root, "extensions", "cli", "bash-guard.ts")],
    cliFlags: [
      "--no-approve",
      "--no-extensions",
      "--no-skills",
      "--no-context-files",
      "--no-prompt-templates",
      "--no-themes",
      "--no-session",
    ],
  };
}

/** One judge session on the injected runtime. */
export async function runJudgeSession(
  prompt: string,
  o: {
    root: string;
    cwd: string;
    model: string;
    env: NodeJS.ProcessEnv;
    eventsPath: string;
    timeoutMs: number;
    runtime?: Runtime;
  },
): Promise<PiRun> {
  if (o.runtime === undefined) throw new Error("the defect judge needs a runtime");
  const session = await o.runtime.create(
    judgeSessionSpec(o.root, o.model, {
      cwd: o.cwd,
      env: o.env,
      eventsFile: o.eventsPath,
      stderrFile: o.eventsPath.replace(/\.jsonl$/, ".stderr.log"),
      limits: { timeoutMs: o.timeoutMs },
    }),
  );
  try {
    return await session.prompt(prompt);
  } finally {
    await session.dispose();
  }
}

/** An attempt starts by removing what an earlier attempt wrote into the case
 * dir — the session's files, the posting policy's originals, the kept
 * patches, the event stream (the cost reader prices it whatever the
 * attempt's outcome) — so nothing this attempt did not produce is read as
 * its review, by the scorer, a results rebuild or the defect judge. */
export function clearAttemptFiles(caseDir: string): void {
  for (const f of [
    ...Object.values(CASE_FILES),
    ...POLICED_ORIGINALS,
    HEAD_PATCHES_FILE,
    ...PI_RUN_FILES,
  ])
    rmSync(join(caseDir, f), { force: true });
}

/** Review one case end to end and write its scored result files. A case that
 * fails is a recorded outcome, never a throw; only the case dir itself being
 * unwritable (its creation, the result and summary writes) throws. */
export async function reviewCase(
  c: BenchCase,
  meta: PrefetchMeta,
  o: RunnerOptions,
  ctx: {
    cfg: Config;
    ecosystem: Ecosystem;
    fingerprint: RunFingerprint;
    readFile?: (path: string) => string;
  },
): Promise<CaseSummary> {
  const log = o.log ?? (() => {});
  if (o.runtime === undefined) throw new Error("reviewCase needs a runtime");
  const runtime = o.runtime;
  const safe = safeId(c.instance_id);
  const caseDir = join(o.outDir, "cases", safe);
  const tree = join(o.root, "wt", safe);
  // pi's spill files (bash output, subagent temp) land here, on the disk-backed
  // wt volume — not in /tmp, a tmpfs charged to the container's memory cap.
  const tmpDir = join(o.root, "wt", `${safe}.tmp`);
  mkdirSync(caseDir, { recursive: true });
  // Before anything can fail.
  clearAttemptFiles(caseDir);
  const started = Date.now();
  const summary: CaseSummary = {
    ...emptyCaseSummary(c, ctx.fingerprint),
    pr_meta: {
      title: meta.title !== null,
      body: meta.body !== null,
      base_ref_source: meta.base_ref_source,
    },
    diff: meta.diff,
  };
  let comments: BenchComment[] = [];
  try {
    await prepareTree(join(o.store, safe), tree, meta);
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    const files = await changedFiles(tree, meta);
    // The head-side patches, kept per case so a results rebuild re-anchors
    // LEFT comments exactly as this run does (collectComments).
    const headPatches: Record<string, string> = {};
    for (const f of files) if (f.patch !== undefined) headPatches[f.filename] = f.patch;
    writeFileSync(join(caseDir, HEAD_PATCHES_FILE), JSON.stringify(headPatches) + "\n");
    // Third-party sources, exactly as the daemon's dispatch unpacks them
    // (`[review] dependency_sources`): one cache per run container, on the
    // disk-backed wt volume, shared by concurrent cases. What was unpacked and
    // what was skipped is kept per case (deps.json) — the attribution record.
    rmSync(join(caseDir, "deps.json"), { force: true });
    let dependencyNote = "";
    if (ctx.cfg.review.dependency_sources) {
      const manifest = await prepareDependencySources(tree, files, {
        cacheDir: join(o.root, "wt", ".depcache"),
        log: (line) => log(`deps: ${c.instance_id}: ${line}`),
      });
      writeFileSync(join(caseDir, "deps.json"), JSON.stringify(manifest, null, 2));
      dependencyNote = renderDependencyNote(manifest);
    }
    // A follow-up case: the PR-owned delta, by production's own
    // `prOwnedDelta` over this tree. Total: a throw is a full round.
    let followUpDelta: PrOwnedDelta | undefined;
    if (c.followup) {
      try {
        followUpDelta = await benchDelta(tree, c, meta);
      } catch (err) {
        followUpDelta = {
          ok: false,
          reason: "diff-failed",
          detail: String(err instanceof Error ? err.message : err).slice(0, 200),
        };
      }
    }
    const prompts = renderCasePrompts({
      root: o.root,
      cfg: ctx.cfg,
      ecosystem: ctx.ecosystem,
      c,
      meta,
      tree,
      caseDir,
      files,
      issuedAt: new Date().toISOString(),
      dependencyNote,
      ...(followUpDelta ? { followUpDelta } : {}),
      ...(ctx.readFile ? { readFile: ctx.readFile } : {}),
    });
    summary.planned_lenses = prompts.plannedLenses;
    writeFileSync(join(caseDir, "pass-plan.json"), JSON.stringify(prompts.passPlan, null, 2));
    if (c.followup) {
      // An earlier attempt's ledger, patch or sweep tasks never leak into this one.
      for (const f of ["ledger.md", "delta.patch", "prior.json", "sweep-plan.json"])
        rmSync(join(caseDir, f), { force: true });
      rmSync(join(caseDir, "tasks-sweep"), { recursive: true, force: true });
      rmSync(join(caseDir, "tasks-optional"), { recursive: true, force: true });
      for (const f of prompts.extraFiles ?? []) {
        mkdirSync(dirname(f.path), { recursive: true });
        writeFileSync(f.path, f.text);
      }
      if (prompts.sweepPlan)
        writeFileSync(join(caseDir, "sweep-plan.json"), JSON.stringify(prompts.sweepPlan, null, 2));
      if (prompts.followUp) {
        summary.follow_up = prompts.followUp;
        log(
          `review: ${c.instance_id} — follow-up round ${prompts.followUp.round_no}: ${prompts.followUp.scope}${prompts.followUp.reason ? ` (${prompts.followUp.reason})` : ""}${prompts.followUp.sweep_owed ? ", sweep owed" : ""}`,
        );
      }
    }
    const shot = await runOneShot({
      root: o.root,
      agentDir: o.agentDir,
      tree,
      files,
      target: {
        repo: c.repo,
        number: c.pr,
        title: meta.title,
        body: meta.body,
        headSha: c.head_commit,
        baseRef: meta.base_ref,
        baseSha: meta.base_commit,
        mergeBase: meta.merge_base,
      },
      outDir: caseDir,
      cfg: ctx.cfg,
      ecosystem: ctx.ecosystem,
      timeoutMs: o.timeoutMs,
      runtime,
      tmpDir,
      prompts,
      label: c.instance_id,
      sessionName: `bench-${safe}`,
      startedAt: started,
      log,
    });
    const r = shot.piRun;
    summary.continued = shot.continued;
    if (shot.error !== undefined) summary.error = shot.error;
    summary.warnings = shot.warnings;
    if (shot.usage) summary.usage = shot.usage;
    if (shot.modelErrors) summary.model_errors = shot.modelErrors;
    if (shot.stages) summary.stages = shot.stages;
    const outcome = shot.outcome;
    const renderedPosting = shot.renderedPosting;
    const record = ctx.cfg.review.render_outputs ? shot.findings : undefined;
    // The profile's `[posting]` policy, applied to what the session wrote
    // exactly as production posting applies it: an over-posting session is
    // still cut, and what is cut is recorded `withheld` (originals kept beside).
    if (renderedPosting) {
      summary.posting = renderedPosting;
      log(
        `review: ${c.instance_id} — posting policy kept ${renderedPosting.kept} of ${renderedPosting.kept + renderedPosting.withheld.length} (${renderedPosting.withheld.map((w) => w.word).join(", ") || "nothing withheld"})`,
      );
    } else if (!isDefaultPosting(ctx.cfg.posting) && outcome !== undefined) {
      const policed = enforceBenchPosting(caseDir, ctx.cfg.posting!, headPatches);
      if (policed) {
        summary.posting = policed;
        log(
          `review: ${c.instance_id} — posting policy kept ${policed.kept} of ${policed.kept + policed.withheld.length} (${policed.withheld.map((w) => w.word).join(", ") || "nothing withheld"})`,
        );
      }
    }
    const rawComments = readJson(join(caseDir, CASE_FILES.comments));
    const collected = collectComments(caseDir);
    comments = collected.comments;
    summary.comments.reanchored = collected.reanchored;
    summary.comments.unparseable = collected.dropped;
    summary.comments.body = collected.body;
    summary.verdict = typeof outcome?.["verdict"] === "string" ? outcome["verdict"] : null;
    summary.executed_passes = Array.isArray(outcome?.["passes"])
      ? (outcome["passes"] as Array<Record<string, unknown>>).map((p) => executedAgent(p))
      : [];
    // A follow-up case keeps the session's own phase and sweep
    // report, read the way production's verdict tail reads it.
    if (summary.follow_up && outcome !== undefined)
      summary.follow_up = followUpOutcomeOf(summary.follow_up, outcome, summary.verdict);
    summary.status = r.timedOut
      ? "timeout"
      : r.streamError
        ? "failed"
        : outcome === undefined ||
            rawComments === undefined ||
            (ctx.cfg.review.render_outputs && record === undefined)
          ? "no-output"
          : summary.verdict === "APPROVE" || summary.verdict === "REQUEST_CHANGES"
            ? "ok"
            : "no-verdict";
    // A no-output round says why when the files are there but unreadable.
    if (summary.status === "no-output" && summary.error === undefined) {
      const still = [
        ...unparseableOutputs(caseDir, ctx.cfg.review.render_outputs),
        ...missingOutputs(caseDir, ctx.cfg.review.render_outputs).map(
          (name) => `${name} not written`,
        ),
      ];
      if (still.length) summary.error = still.join("; ").slice(0, 2000);
    }
  } catch (err) {
    summary.status = "failed";
    summary.error = String(err instanceof Error ? err.message : err).slice(0, 2000);
    log(`review: ${c.instance_id} FAILED — ${summary.error}`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    if (!o.keepTree) rmSync(tree, { recursive: true, force: true });
  }
  summary.duration_seconds = Math.round((Date.now() - started) / 1000);
  summary.comments = { ...summary.comments, ...commentTally(comments) };
  logDroppedMetrics(writeResults(o.outDir, c, comments, summary), log, `review: ${c.instance_id}`);
  // The summary is the case's completion mark (`--resume` skips an ok one),
  // so it is written after the result files it vouches for.
  writeFileSync(join(caseDir, "case-summary.json"), JSON.stringify(summary, null, 2) + "\n");
  const me = summary.model_errors;
  const errs =
    me && me.rate_limited + me.overloaded + (me.usage_limit ?? 0) + me.other > 0
      ? `; model errors: ${me.rate_limited} rate-limited, ${me.overloaded} overloaded, ${me.usage_limit ?? 0} usage-limit, ${me.other} other${summary.status !== "ok" && (me.usage_limit ?? 0) > 0 ? " — USAGE LIMIT REACHED" : summary.status !== "ok" && me.rate_limited + me.overloaded > 0 ? " — RATE-LIMITED" : ""}`
      : "";
  log(
    `review: ${c.instance_id} ${summary.status} — verdict ${summary.verdict ?? "none"}, ${comments.length} comment(s), ${summary.duration_seconds}s${errs}`,
  );
  return summary;
}

/** The case file holding the run's head-side patches by path. */
export const HEAD_PATCHES_FILE = "head-patches.json";

/** Everything this case POSTED, as scored comments: the inline comments the
 * session wrote, plus the findings its record marks posted that went into the
 * review body for want of an inline anchor. A comment the session anchored on
 * a DELETED line is moved to the head side of its hunk, from the patches the
 * run kept: every scorer the bench feeds reads head-side lines only, and the
 * comment was otherwise dropped whole (reanchorLeftComments). A case dir
 * without that file leaves LEFT comments where they are. The one reader of a
 * case dir's output, shared by a live run and `cli results` so a rebuild
 * scores the same. */
export function collectComments(caseDir: string): {
  comments: BenchComment[];
  dropped: number;
  body: number;
  reanchored: number;
} {
  const parsed = parseSessionComments(readJson(join(caseDir, CASE_FILES.comments)));
  let reviewMd = "";
  try {
    reviewMd = readFileSync(join(caseDir, CASE_FILES.review), "utf8");
  } catch {
    // no body written — body findings fall back to the record's own text
  }
  const inBody = bodyPostedFindings(
    readJson(join(caseDir, CASE_FILES.findings)),
    reviewMd,
    parsed.comments,
  );
  const rawPatches = readJson(join(caseDir, HEAD_PATCHES_FILE));
  const patches: Record<string, string> = {};
  if (typeof rawPatches === "object" && rawPatches !== null && !Array.isArray(rawPatches))
    for (const [path, patch] of Object.entries(rawPatches))
      if (typeof patch === "string") patches[path] = patch;
  const moved = reanchorLeftComments(
    [...parsed.comments.map((c) => ({ ...c, source: "inline" as const })), ...inBody],
    patches,
  );
  return {
    comments: moved.comments,
    dropped: parsed.dropped,
    body: inBody.length,
    reanchored: moved.reanchored,
  };
}

function caseResultFile(outDir: string, c: BenchCase, variant: string): string {
  return join(outDir, "results", variant, `${safeId(c.instance_id)}.json`);
}

function executedAgent(p: Record<string, unknown>): string {
  return `${String(p["name"])}--${String(p["tier"])}`;
}

/** The case summary and every variant's result file of one case. */
function caseFiles(outDir: string, c: BenchCase): [string, ...string[]] {
  return [
    join(outDir, "cases", safeId(c.instance_id), "case-summary.json"),
    ...Object.keys(VARIANTS).map((v) => caseResultFile(outDir, c, v)),
  ];
}

/** Remove one case's summary, result files and judge inputs (review body and
 * comments) — a retained input would be read as the next attempt's review. A variant whose result file
 * was there loses its metrics with it (they scored that file). Returns the
 * metrics files removed per variant. */
function removeCaseFiles(outDir: string, c: BenchCase): MetricsDropped {
  const dropped: MetricsDropped = [];
  rmSync(caseFiles(outDir, c)[0], { force: true });
  const caseDir = join(outDir, "cases", safeId(c.instance_id));
  for (const f of [CASE_FILES.review, CASE_FILES.comments])
    rmSync(join(caseDir, f), { force: true });
  for (const v of Object.keys(VARIANTS) as Variant[]) {
    const file = caseResultFile(outDir, c, v);
    if (!existsSync(file)) continue;
    dropped.push({ variant: v, metrics: dropMetricsFiles(join(outDir, "results", v)).length });
    rmSync(file, { force: true });
  }
  return dropped;
}

/** Per variant whose scorer input changed, how many metrics files went. */
type MetricsDropped = Array<{ variant: Variant; metrics: number }>;

function logDroppedMetrics(
  dropped: MetricsDropped,
  log: (line: string) => void,
  who: string,
): void {
  for (const d of dropped)
    if (d.metrics > 0)
      log(
        `${who}: ${d.variant}: ${d.metrics} metrics file(s) scored the old results — removed; re-run eval to score the new ones`,
      );
}

/** Every case whose summary records another fingerprint (or none, or cannot
 * be read) loses its summary and every variant's result file. A case with no
 * summary is left as it is: nothing claims it for any configuration. Returns
 * the dropped instance ids. */
export function dropForeignCases(
  outDir: string,
  cases: readonly BenchCase[],
  fingerprint: RunFingerprint,
  log: (line: string) => void,
): string[] {
  const dropped: string[] = [];
  for (const c of cases) {
    const files = caseFiles(outDir, c);
    if (!existsSync(files[0])) continue;
    let prior: CaseSummary | null = null;
    try {
      prior = JSON.parse(readFileSync(files[0], "utf8")) as CaseSummary;
    } catch {
      // an unreadable summary is no proof of this run's fingerprint
    }
    if (JSON.stringify(prior?.fingerprint ?? null) === JSON.stringify(fingerprint)) continue;
    log(
      `review: ${c.instance_id} was reviewed by a different build/profile — its result is dropped`,
    );
    logDroppedMetrics(removeCaseFiles(outDir, c), log, "review");
    dropped.push(c.instance_id);
  }
  return dropped;
}

/** The review command's case set-up before run.json is written: a fresh run
 * clears every case it owns; a resumed run keeps the cases this fingerprint
 * produced and drops the rest (dropForeignCases), so a run stopped partway
 * (AuthExpiring) leaves those cases missing rather than scored under the new
 * configuration's label. The fingerprint is the one the case containers
 * compute: bench.sh gives the init phase the same QCR_BENCH_AUTH. Returns the
 * dropped instance ids of a resume. */
export function prepareReviewCases(
  outDir: string,
  cases: readonly BenchCase[],
  opts: { resume: boolean; fingerprint: RunFingerprint },
  log: (line: string) => void,
): string[] {
  if (opts.resume) return dropForeignCases(outDir, cases, opts.fingerprint, log);
  for (const c of cases) logDroppedMetrics(removeCaseFiles(outDir, c), log, "review");
  return [];
}

/** The record of a case that was never prefetched: a failed summary carrying
 * the run's fingerprint (a resume under the same configuration keeps it) and
 * an EMPTY result file per variant — the scorer silently drops an instance
 * with no file from both denominators, so a skipped case would shrink the
 * benchmark instead of costing its references. */
export function recordUnprefetched(
  outDir: string,
  c: BenchCase,
  error: string,
  fingerprint: RunFingerprint,
): CaseSummary {
  const s: CaseSummary = { ...emptyCaseSummary(c, fingerprint), error };
  const caseDir = join(outDir, "cases", safeId(c.instance_id));
  mkdirSync(caseDir, { recursive: true });
  // No session ran: nothing an earlier attempt wrote is this one's review or
  // cost, and a results rebuild must find the same empty case.
  clearAttemptFiles(caseDir);
  writeResults(outDir, c, [], s);
  writeFileSync(
    join(outDir, "cases", safeId(c.instance_id), "case-summary.json"),
    JSON.stringify(s, null, 2) + "\n",
  );
  return s;
}

/** A case whose host process died, was killed or outlived its wall clock
 * (src/bench/casehost.ts): a failed case with an EMPTY result file, as an
 * unprefetched one has (the scorer would otherwise drop it from both
 * denominators). Unlike `recordUnprefetched` it keeps what the dead host wrote
 * into the case dir — the event stream above all, which the cost reader prices:
 * the caller cleared the attempt's files before the host started, so what is
 * there is this attempt's. */
export function recordHostFailure(
  outDir: string,
  c: BenchCase,
  error: string,
  fingerprint: RunFingerprint,
  durationSeconds: number,
): CaseSummary {
  const s: CaseSummary = {
    ...emptyCaseSummary(c, fingerprint),
    error,
    duration_seconds: durationSeconds,
  };
  const caseDir = join(outDir, "cases", safeId(c.instance_id));
  mkdirSync(caseDir, { recursive: true });
  // The scored review of this case is empty: the session files the dead host
  // wrote must not be collected into it by a results rebuild. The event
  // stream stays.
  for (const f of Object.values(CASE_FILES)) rmSync(join(caseDir, f), { force: true });
  writeResults(outDir, c, [], s);
  writeFileSync(join(caseDir, "case-summary.json"), JSON.stringify(s, null, 2) + "\n");
  return s;
}

/** A failed case's summary before anything is known of it — every count
 * zero, no verdict. Each route adds what it knows. */
function emptyCaseSummary(c: BenchCase, fingerprint: RunFingerprint): CaseSummary {
  return {
    instance_id: c.instance_id,
    status: "failed",
    fingerprint,
    verdict: null,
    duration_seconds: 0,
    usage: { input: 0, output: 0, cacheRead: 0, children: 0 },
    planned_lenses: [],
    executed_passes: [],
    comments: { total: 0, by_tag: {}, left_side: 0, unparseable: 0, body: 0 },
    pr_meta: { title: false, body: false, base_ref_source: "none" },
    diff: { files: 0, additions: 0, deletions: 0 },
    continued: false,
    warnings: [],
  };
}

/** The scored comments' counts: how many, how many stayed on the old side,
 * and how many per posting tag. One rule for a live run and a rebuild. */
function commentTally(
  comments: readonly BenchComment[],
): Pick<CaseSummary["comments"], "total" | "left_side" | "by_tag"> {
  const by_tag: Record<string, number> = {};
  for (const x of comments) by_tag[x.tag] = (by_tag[x.tag] ?? 0) + 1;
  return {
    total: comments.length,
    left_side: comments.filter((x) => x.side === "LEFT").length,
    by_tag,
  };
}

/** Write the scorer's input for every variant. A variant whose file for this
 * case is about to hold different bytes first loses its metrics (they scored
 * the old bytes) — before the write, so no interruption can leave new input
 * beside an old score. Returns those variants, with the metrics files each
 * lost. */
export function writeResults(
  outDir: string,
  c: BenchCase,
  comments: readonly BenchComment[],
  summary: CaseSummary,
): MetricsDropped {
  const changed: MetricsDropped = [];
  for (const variant of Object.keys(VARIANTS) as Variant[]) {
    const dir = join(outDir, "results", variant);
    mkdirSync(dir, { recursive: true });
    const result = toOcrResult(comments, {
      instance_id: c.instance_id,
      status: summary.status,
      variant,
      duration_seconds: summary.duration_seconds,
      usage: {
        input: summary.usage.input,
        output: summary.usage.output,
        cacheRead: summary.usage.cacheRead,
      },
      verdict: summary.verdict,
      unparseable: summary.comments.unparseable,
    });
    const file = join(dir, `${safeId(c.instance_id)}.json`);
    const text = JSON.stringify(result, null, 2) + "\n";
    publishChangedResult(file, text, () => {
      changed.push({ variant, metrics: dropMetricsFiles(dir).length });
    });
  }
  return changed;
}

/** `cli results`: rebuild every finished case's summary counts and scorer
 * inputs from its case dir. The harness scored the result files as they
 * were, so a variant whose file for any case changes has every metrics file
 * beside it removed (writeResults) — a report before the next eval shows no
 * score rather than a stale one. A variant whose files all come out
 * byte-identical keeps its metrics. */
export function rebuildResults(
  outDir: string,
  cases: readonly BenchCase[],
  log: (line: string) => void,
): void {
  for (const c of cases) {
    const dir = join(outDir, "cases", safeId(c.instance_id));
    const sPath = join(dir, "case-summary.json");
    if (!existsSync(sPath)) continue;
    const s = JSON.parse(readFileSync(sPath, "utf8")) as CaseSummary;
    const collected = collectComments(dir);
    // Refresh the per-case counts too, so the report describes exactly
    // what the rebuilt result files score.
    s.comments = {
      ...commentTally(collected.comments),
      unparseable: collected.dropped,
      body: collected.body,
      reanchored: collected.reanchored,
    };
    // The summary vouches for the result files, so it is written after them.
    logDroppedMetrics(writeResults(outDir, c, collected.comments, s), log, "results");
    writeFileSync(sPath, JSON.stringify(s, null, 2) + "\n");
  }
}
