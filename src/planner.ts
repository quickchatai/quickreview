// The review planner: which lenses a round runs, at which tier, in which
// order, and the round order the session is handed — deterministic, no LLM.
// It plans a first round from the PR's files, and a FOLLOW-UP round from the
// PR-owned change since the last reviewed head (docs/follow-up-rounds.md).
//
// The review core: the bot's queue (src/dispatch.ts) calls it, and so do
// `qcr review` (src/reviewdelta.ts), the one-shot prompts (src/engine/
// prompts.ts) and the bench's replays — the same plan everywhere. It reads
// nothing but its arguments, and a follow-up decision reads the PR's history
// through `FollowUpHistory`, a port the bot fills from its state store.
import type { Config } from "./config.js";
import { REVIEW_DEFAULTS } from "./config.js";
import { coverageEligible } from "./coverage.js";
import { DJANGO_ECOSYSTEM, type Ecosystem } from "./ecosystem.js";
import { promptTargetsFor } from "./escalationprompt.js";
import { deltaFollowUpEnabled } from "./followup-mode.js";
import type { PrFileEntry } from "./github.js";
import {
  INTENT_PASS,
  passTier,
  selectLenses,
  selectSubLenses,
  SWEEP_PASS,
  sweepGroups,
  isLightSweepFile,
  baselineGroups,
  baselineSplitLines,
  BEHAVIOUR_DELTA_PASS,
  behaviourDeltaGroups,
  CODE_FILE_RE,
  TESTS_PASS,
  STYLE_PASS,
  LINT_CONFORMANCE_PASS,
  selectQualityLenses,
  QUALITY_PASSES,
  qualityReason,
} from "./heuristics.js";
import type { HeuristicsExtension } from "./heuristics.js";
import { VALIDATE_PASS } from "./include.js";
import { LENS_PLANNING } from "./lensplanning.js";
import { flooredTier, lensEnabled } from "./lenstuning.js";
import { lintersForFiles, type CiLinter } from "./lintconfig.js";
import { detectLoosenedAssertions, loosenedReason } from "./loosenedtests.js";
import type { MigrationCollision } from "./migrations.js";
import { ALL_PASSES } from "./passes.js";
import { isDefaultPosting } from "./postingpolicy.js";
import { roundPostingKey } from "./postingkey.js";
import { deltaAsPrFiles, type PrOwnedDelta, type PrOwnedDeltaFile } from "./prdelta.js";
import type { PriorFindingsList } from "./priorfindings.js";
import { assignPriorFindings } from "./priortasks.js";
import type { PrStateRow } from "./state.js";
import { PASS_TIER_ORDER } from "./types.js";
import type {
  LedgerCarry,
  PassPlanEntry,
  PassTier,
  PriorAssignment,
  RoundDelta,
  RoundOrder,
  RoundRecoveryContext,
  RoundType,
} from "./types.js";
import type { WorktreeFacts } from "./worktrees.js";

/** A plan's lens names, each once, in plan order — the compatibility list
 * the rounds table, the event log and every order carry (a lens with several
 * rows, the sweep, once). */
export function lensesOf(plan: readonly PassPlanEntry[]): string[] {
  return [...new Set(plan.map((p) => p.lens))];
}

/** The head a round reviews: the prepared tree's, else the PR row's (a
 * caller with no worktree seam). The one rule the round row, the posting key
 * and the prompt all name their head by. */
export function reviewedHeadOf(
  tree: Pick<PreparedTree, "head_sha"> | undefined,
  row: Pick<PrStateRow, "head_sha">,
): string {
  return tree?.head_sha || row.head_sha;
}

/** raisable_to lists the higher rungs only — a session may raise a pass, never
 * lower it. */
function raisableFrom(lens: string, tier: PassTier): string[] {
  return PASS_TIER_ORDER.slice(PASS_TIER_ORDER.indexOf(tier) + 1).map((t) => `${lens}--${t}`);
}

/**
 * The tier the round's validator runs at: its own tier, the configured
 * `validate_tier` under the profile's `min_tier` for it, whatever tier or
 * effort any lens runs at. It is never raised to match a lens: a finding the
 * validator cannot stand behind is kept as `doubted` in the findings record
 * (never posted, shown in the TUI), not discarded, so a cheaper validator
 * cannot make a stronger lens's finding vanish. Lens tiers are deliberately
 * not an input.
 */
export function validatorTier(cfg: Pick<Config, "lenses" | "models">): PassTier {
  return flooredTier(cfg.lenses, VALIDATE_PASS, cfg.models.validate_tier);
}

/**
 * The tier a lens ADDED by the session runs at (the round templates' add
 * rule): a risk pass exists only as `sol-high`; every other lens at `sol-med`,
 * or at the profile's `min_tier` for it when that is higher.
 */
export function addTierOf(cfg: Config, lens: string): PassTier {
  return cfg.models.risk_passes.includes(lens)
    ? "sol-high"
    : flooredTier(cfg.lenses, lens, "sol-med");
}

/** The facts a prepared worktree hands the round — the tree's own, less
 * where it lives. */
export type PreparedTree = Omit<WorktreeFacts, "path">;

/** What `buildPassPlan` returns. */
export interface PassPlan {
  pass_plan: PassPlanEntry[];
  addable_lenses: string[];
  sweep_unswept: string[];
  /** Files the behaviour-delta lens would read but its group cap left out —
   * present only when the cap cut something, so a capped lens never reads
   * as covering the change. */
  behaviour_unread?: string[];
}

/** Deterministic per-round pass plan (agent = `${lens}--${tier}`):
 * - risk passes are always "sol-high", single variant, not raisable;
 * - pass-validate runs at validatorTier() — its own configured tier, never
 *   raised to match a lens — is not raisable, and is always last;
 * - every other selected lens gets the passTier() tier and may be raised to
 *   any higher tier's variant (ascending order).
 * addable_lenses = every known pass not already in the plan.
 * The rows come back in launch order, slowest first (`slowestFirst`).
 *
 * The profile's per-lens tuning (`cfg.lenses`) wins over all of
 * that: a `min_tier` floors the lens's row (and so its `raisable_to`) and the
 * sweep rows; `enabled = false` removes a lens from the plan AND the addable
 * list whatever selected it — the validator included, when the round
 * has no validator row at all; `enabled = true` on a lever-gated lens switches
 * it on whatever its `[review]` lever says. */
export function buildPassPlan(
  cfg: Config,
  files: PrFileEntry[],
  intent?: { title?: string | null; body?: string | null },
  /** Whose tier-forcing gate applies. Default Django; `none` never forces
   * sol-med off a migrations path. */
  ecosystem: Ecosystem = DJANGO_ECOSYSTEM,
  /** Profile lens-heuristics extension; absent ⇒ generic core. */
  heuristics?: HeuristicsExtension,
  /** The repo's written style guide references (src/styleguide.ts); empty or
   * absent ⇒ the style lens only on the profile's guide, if any. */
  styleGuide: readonly string[] = [],
  /** The linters and formatters a CI job of the repo runs (src/lintconfig.ts);
   * empty or absent ⇒ no lint-conformance row. */
  ciLinters: readonly CiLinter[] = [],
  /** `tierFiles` — the files the round's default TIER is chosen from, when
   * the plan is built over fewer files than the PR (a follow-up round plans
   * from the delta, but a small fix push keeps the PR's tier and its
   * migration floor). Absent ⇒ `files`. */
  opts: { tierFiles?: PrFileEntry[] } = {},
): PassPlan {
  const tierBasis = opts.tierFiles ?? files;
  const defaultTier = passTier(tierBasis, {
    migrationGate: ecosystem.migrationGate(tierBasis),
    smallDiffLines: cfg.models.small_diff_lines,
  });
  const risk = new Set(cfg.models.risk_passes);
  // The profile's switch for one lens — explicit `enabled` wins,
  // otherwise the `[review]` lever that gates it (true for an ungated lens).
  const on = (lens: string, lever = true): boolean => lensEnabled(cfg.lenses, lens, lever);
  // The plan explains why each lens was chosen — the path-shaped lenses
  // included, not only sub-lenses.
  const reasons0 = new Map<string, string>();
  const selected0 = selectLenses(
    files,
    intent,
    heuristics,
    {
      intentMinWords: cfg.review.intent_min_words,
      placementMinCodeFiles: cfg.review.placement_min_code_files,
      placementMinNewFileLines: cfg.review.placement_min_new_file_lines,
    },
    reasons0,
  );
  // Sub-lenses ride after the path-selected lenses, each with the reason its
  // trigger fired (`[review] sublenses`).
  const sub = selectSubLenses(files, intent).filter(
    (s) => on(s.lens, cfg.review.sublenses) && !selected0.includes(s.lens),
  );
  const whyOf = new Map<string, string>([
    ...reasons0,
    ...sub.map((s) => [s.lens, s.why] as [string, string]),
  ]);
  // Existing tests are consumers of every code change, and the PR's own
  // tests are claims about the code — one lens reads both.
  // The loosened-test hint: weakened assertions
  // found deterministically in the PR's test files are handed to the lens.
  const loosened = cfg.review.loosened_test_hint ? detectLoosenedAssertions(files) : [];
  const tests =
    on(TESTS_PASS, cfg.review.tests_lens) &&
    (files.some((f) => CODE_FILE_RE.test(f.filename)) || loosened.length > 0)
      ? [TESTS_PASS]
      : [];
  // The code-quality lenses: maintainability, duplication, abstraction — never
  // style, which rides only on the repo's own written guide.
  const quality = selectQualityLenses(files, cfg.review.quality_min_added_lines).filter(
    (l) => on(l, cfg.review.quality_lenses) && !selected0.includes(l),
  );
  if (tests.length)
    whyOf.set(
      TESTS_PASS,
      "the PR changes code: existing tests are its consumers, and its own tests are claims" +
        (loosened.length ? `; and ${loosenedReason(loosened)}` : ""),
    );
  for (const l of quality) whyOf.set(l, qualityReason(files, cfg.review.quality_min_added_lines));
  // A guide the repo writes wins; the profile's drafted guide is
  // the standard only when the repo writes none.
  const profileGuide = cfg.lenses?.[STYLE_PASS]?.guide;
  const style =
    on(STYLE_PASS, cfg.review.style_lens) &&
    (styleGuide.length > 0 || profileGuide !== undefined) &&
    files.some((f) => CODE_FILE_RE.test(f.filename))
      ? [STYLE_PASS]
      : [];
  if (style.length)
    whyOf.set(
      STYLE_PASS,
      styleGuide.length > 0
        ? `the repo's written style guide: ${styleGuide.join(", ")}`
        : `this repo's profile style guide (\`${profileGuide!.file}\`, in your instructions) — the repo writes none of its own`,
    );
  // Lint conformance only where a CI job runs a linter whose
  // rules cover a changed file — the plan names the tools and their CI files.
  const coveredLinters = lintersForFiles(
    ciLinters,
    files.filter((f) => f.status !== "removed").map((f) => f.filename),
  );
  const lint =
    on(LINT_CONFORMANCE_PASS, cfg.review.lint_conformance) && coveredLinters.length > 0
      ? [LINT_CONFORMANCE_PASS]
      : [];
  if (lint.length)
    whyOf.set(
      LINT_CONFORMANCE_PASS,
      `CI runs ${coveredLinters
        .map(
          (l) =>
            `${l.tool} (${l.ci.join(", ")}${l.configs.length ? `; config ${l.configs.join(", ")}` : ""})`,
        )
        .join("; ")} on the changed files`,
    );
  // `[review] skip_lenses` (cost tuning): a listed lens is neither planned
  // nor addable. pass-validate is refused at config parse, and is re-appended
  // unconditionally here besides.
  const skip = new Set((cfg.review.skip_lenses ?? []).filter((l) => l !== VALIDATE_PASS));
  // `enabled = false` is the last word on every lens, whatever selected it —
  // a profile-level subtraction, separate from the ADD-only heuristics.
  const lenses = [
    ...[...selected0, ...sub.map((s) => s.lens), ...tests, ...quality, ...style, ...lint].filter(
      (l) => !skip.has(l),
    ),
    VALIDATE_PASS,
  ].filter((l) => on(l));
  // `[models.pass_tiers]`: a pinned lens runs at its pinned tier on every PR,
  // whatever the diff size, and is not raisable (config refuses a pin on a
  // risk pass or on pass-validate). A profile `min_tier` still floors it.
  const pins: Readonly<Record<string, PassTier>> = cfg.models.pass_tiers ?? {};
  // pass-intent starts at terra-med whatever the round's default:
  // reading comprehension over two short texts, not a judgment over production
  // risk. It is NOT pinned — the session may raise it like any other lens.
  // A profile `min_tier` floors whatever this picks (it never lowers one).
  const tierOf = (lens: string): PassTier =>
    flooredTier(
      cfg.lenses,
      lens,
      risk.has(lens)
        ? "sol-high"
        : (pins[lens] ?? (lens === INTENT_PASS ? "terra-med" : defaultTier)),
    );
  // The sweep's rows run at the cheapest tier unless pinned (`[models.pass_tiers]`)
  // or floored by the profile.
  const sweepOn = on(SWEEP_PASS, cfg.review.sweep) && !skip.has(SWEEP_PASS);
  const sweepTier = flooredTier(cfg.lenses, SWEEP_PASS, pins[SWEEP_PASS] ?? "terra-med");
  // The validator runs at its own tier — never raised to match a lens,
  // pinned or not.
  const validate = validatorTier(cfg);
  const pass_plan = lenses.map((lens): PassPlanEntry => {
    const pinned = lens === VALIDATE_PASS || risk.has(lens) || pins[lens] !== undefined;
    const tier: PassTier = lens === VALIDATE_PASS ? validate : tierOf(lens);
    // Every planned lens says why: the signal that fired, else the lens's
    // documented planning rule.
    const why = whyOf.get(lens) ?? (lens !== VALIDATE_PASS ? LENS_PLANNING[lens]?.when : undefined);
    return {
      lens,
      agent: `${lens}--${tier}`,
      tier,
      raisable_to: pinned ? [] : raisableFrom(lens, tier),
      ...(why !== undefined ? { why } : {}),
      ...(lens === BASELINE_PASS || risk.has(lens) ? { required: true as const } : {}),
    };
  });
  // On a very large change pass-baseline — one row, and the round's
  // critical path once the fan-out launches in one turn — is planned as 2–3
  // rows, each STARTING from one group of the change's files; every row keeps
  // the whole PR as its charter (`[review] baseline_split_lines`, 0 = never).
  // At or under the threshold nothing here runs.
  const baselineAt = pass_plan.findIndex((p) => p.lens === BASELINE_PASS);
  const baselineSplit =
    baselineAt < 0
      ? []
      : baselineGroups(
          files,
          cfg.review.baseline_split_lines ?? REVIEW_DEFAULTS.baseline_split_lines,
        );
  if (baselineSplit.length > 1) {
    const row = pass_plan[baselineAt]!;
    const lines = baselineSplitLines(files);
    pass_plan.splice(
      baselineAt,
      1,
      ...baselineSplit.map((focus, i): PassPlanEntry => ({
        ...row,
        why: `pass-baseline split ${i + 1} of ${baselineSplit.length}: the change is ${lines} changed lines, over [review] baseline_split_lines (${cfg.review.baseline_split_lines}) — this row starts from its files; its charter stays whole`,
        focus,
      })),
    );
  }
  // The sweep (`[review] sweep`): one row per group of
  // changed files, at the cheapest tier — its job is attention, line by line,
  // not deep reasoning. Appended: `slowestFirst` below puts the validator
  // last whatever is appended after it.
  let sweep_unswept: string[] = [];
  if (sweepOn) {
    const { groups, unswept } = sweepGroups(
      files,
      cfg.review.sweep_max_groups,
      cfg.review.sweep_group_files,
      cfg.review.sweep_group_lines,
      cfg.review.sweep_wide_files,
    );
    sweep_unswept = unswept;
    // `[review] sweep_light_tier`: a row holding no production
    // code — tests, prose, config/data only — runs at the light tier when it
    // is below the sweep's own (the profile's floor still applies).
    const light = cfg.review.sweep_light_tier
      ? flooredTier(cfg.lenses, SWEEP_PASS, cfg.review.sweep_light_tier)
      : undefined;
    const lightApplies =
      light !== undefined && PASS_TIER_ORDER.indexOf(light) < PASS_TIER_ORDER.indexOf(sweepTier);
    const rows = groups.map((focus): PassPlanEntry => {
      const isLight = lightApplies && focus.every(isLightSweepFile);
      const tier = isLight ? light : sweepTier;
      return {
        lens: SWEEP_PASS,
        agent: `${SWEEP_PASS}--${tier}`,
        tier,
        raisable_to:
          pins[SWEEP_PASS] !== undefined && !isLight ? [] : raisableFrom(SWEEP_PASS, tier),
        why: `every changed line of ${focus.length === 1 ? focus[0] : `${focus.length} changed files`}, read one by one${isLight ? " (tests, prose or config only: the light tier, [review] sweep_light_tier)" : ""}`,
        focus,
      };
    });
    pass_plan.push(...rows);
  }
  // The behaviour-delta lens: one row per group of files the
  // PR modifies or deletes code in, at the round's tier — comparing base and
  // head is reasoning, not attention. Appended, as the sweep's rows are.
  let behaviour_unread: string[] = [];
  if (on(BEHAVIOUR_DELTA_PASS, cfg.review.behaviour_delta) && !skip.has(BEHAVIOUR_DELTA_PASS)) {
    const { groups, unread } = behaviourDeltaGroups(
      files,
      cfg.review.behaviour_delta_max_groups,
      cfg.review.sweep_group_lines,
    );
    const tier = tierOf(BEHAVIOUR_DELTA_PASS);
    const rows = groups.map((focus): PassPlanEntry => ({
      lens: BEHAVIOUR_DELTA_PASS,
      agent: `${BEHAVIOUR_DELTA_PASS}--${tier}`,
      tier,
      raisable_to:
        pins[BEHAVIOUR_DELTA_PASS] !== undefined ? [] : raisableFrom(BEHAVIOUR_DELTA_PASS, tier),
      why: `base behaviour is at risk in ${focus.length === 1 ? focus[0] : `${focus.length} files`}: removed or replaced guards, conditions, calls, returns or values, or existing code wrapped in a new branch`,
      focus,
    }));
    pass_plan.push(...rows);
    behaviour_unread = unread;
  }
  const selected = new Set(pass_plan.map((p) => p.lens));
  const addable_lenses = [...new Set([...ALL_PASSES, ...cfg.models.risk_passes])].filter(
    (l) => !selected.has(l) && on(l) && !skip.has(l),
  );
  return {
    pass_plan: slowestFirst(pass_plan, files, risk),
    addable_lenses,
    sweep_unswept,
    ...(behaviour_unread.length > 0 ? { behaviour_unread } : {}),
  };
}

/** The lenses `slowestFirst` launches last within their tier: conditional
 * lenses that read the change for one narrow concern. */
const CHEAP_LAST_PASSES: ReadonlySet<string> = new Set([
  INTENT_PASS,
  ...QUALITY_PASSES,
  STYLE_PASS,
  LINT_CONFORMANCE_PASS,
]);

/**
 * The plan's rows in LAUNCH order — the expected-slowest first.
 *
 * The session launches a turn's rows in table order, and the lens runner
 * (src/engine/lens/runlens.ts) runs them under a process-wide cap in that order,
 * so a 15–27 row plan runs in waves: a slow row listed late starts in the
 * last wave and sets the round's critical path (typically pass-baseline,
 * sol-high sweep and behaviour-delta rows). The order:
 * pass-baseline; then by tier, highest first; within a tier the risk passes,
 * then the focused rows (behaviour-delta, then sweep) by the changed lines
 * their focus covers, larger first, then every other lens, then the cheap
 * conditional lenses (`CHEAP_LAST_PASSES`); pass-validate stays last. Ties
 * keep their planned order (a stable sort).
 *
 * Only the ORDER moves — the same rows, each byte-identical. Every consumer
 * that indexes rows (the task files, `lenses`, lesson rows, the recorded
 * pass_plan) reads this one array, so they agree. Exported for
 * `planFollowUp`, which splices a carried row into an already-ordered plan.
 */
export function slowestFirst(
  rows: readonly PassPlanEntry[],
  files: readonly PrFileEntry[],
  risk: ReadonlySet<string>,
): PassPlanEntry[] {
  const lines = new Map(files.map((f) => [f.filename, (f.additions ?? 0) + (f.deletions ?? 0)]));
  const weight = (p: PassPlanEntry): number =>
    (p.focus ?? []).reduce((n, f) => n + (lines.get(f) ?? 0), 0);
  const cls = (p: PassPlanEntry): number =>
    risk.has(p.lens)
      ? 0
      : p.lens === BEHAVIOUR_DELTA_PASS
        ? 1
        : p.lens === SWEEP_PASS
          ? 2
          : CHEAP_LAST_PASSES.has(p.lens)
            ? 4
            : 3;
  const key = (p: PassPlanEntry): number[] => [
    p.lens === VALIDATE_PASS ? 1 : 0,
    p.lens === BASELINE_PASS ? 0 : 1,
    -PASS_TIER_ORDER.indexOf(p.tier),
    cls(p),
    -weight(p),
  ];
  const keyed = rows.map((p, i) => ({ p, i, k: key(p) }));
  keyed.sort((a, b) => {
    for (let j = 0; j < a.k.length; j++) if (a.k[j] !== b.k[j]) return a.k[j]! - b.k[j]!;
    return a.i - b.i;
  });
  return keyed.map((e) => e.p);
}

/** Why a non-first round runs as a full re-review: every doubt is a full
 * round, never a quieter one. */
export type FollowUpFullReason =
  | "follow_up_full"
  | "no-reviewed-head"
  | "no-adapter"
  | "delta-too-large"
  | "baseline-unplanned"
  | "delta-threw"
  | "patch-write-failed"
  | Exclude<PrOwnedDelta, { ok: true }>["reason"];

/** A follow-up round's plan, decided before the round row exists. */
export interface FollowUpDecision {
  delta: Extract<PrOwnedDelta, { ok: true }>;
  /** The reviewed head the delta was computed from. */
  fromSha: string;
  deltaFiles: PrFileEntry[];
  plan: PassPlan;
  /** The pre-approval sweep's plan — the whole PR's full plan — when owed. */
  sweepPlan?: PassPlanEntry[];
  /** The full plan's files left over the per-round sweep cap — carried with
   * `sweepPlan`, so the sweep is told what it does not cover, as round 1 is. */
  sweepUnswept?: string[];
  sweepBehaviourUnread?: string[];
  /** `follow_up_extent = "session"`: the full delta plan's rows the
   * lean core left out — per-file sweep rows, quality and style lenses —
   * offered to the session as optional rows. */
  optionalPlan?: PassPlanEntry[];
}

/**
 * The reads a follow-up decision makes of the PR's review history — exactly
 * these, so the planner holds no store. The bot passes its state store, which
 * answers both.
 */
export interface FollowUpHistory {
  /** The PR's rounds (only these fields are read). */
  roundsFor(pr: number): ReadonlyArray<{
    backfilled: number;
    head_sha: string | null;
    merge_base: string | null;
    verdict: string | null;
    round_no: number;
  }>;
  /** Has a full look happened since the PR's first round? */
  fullLookSinceFirst(pr: number): boolean;
}

/** The PR-owned delta between two reviewed heads, as the decision asks for it. */
export type PrOwnedDeltaReader = (q: {
  pr: number;
  from: string;
  to: string;
  mergeBase: string;
  baseSha?: string;
  /** The merge base the reviewed round recorded, when known. */
  fromMergeBase?: string;
}) => Promise<PrOwnedDelta>;

/**
 * Decide whether a non-first round is a FOLLOW-UP round
 * (docs/follow-up-rounds.md), and plan it. Total: any doubt — the knob, no
 * reviewed-head mark, no git seam, a delta git could not compute, a delta
 * above `follow_up_max_delta_ratio` of the PR's diff lines, a delta plan
 * without pass-baseline — answers `{full: reason}`, and the caller runs a
 * full re-review.
 *
 * The plan is built over the DELTA's files with the intent text arms off
 * (the title and body did not change since the last review), its tier chosen
 * from the WHOLE PR. The sweep is owed as `followUpSweepOwed` decides (the
 * standing verdict not APPROVE and no full look since the first round, or a
 * large enough post-approval delta); its plan is
 * the whole PR's full plan, exactly as a full round would run it.
 */
export async function decideFollowUp(
  deps: {
    cfg: Config;
    history: FollowUpHistory;
    /** The PR-owned delta reader (`WorktreeManager.prOwnedDelta`). Absent ⇒
     * `{full: "no-adapter"}`. */
    prOwnedDelta?: PrOwnedDeltaReader;
    heuristics?: HeuristicsExtension;
  },
  args: {
    pr: number;
    markHead: string | null | undefined;
    tree: { head_sha: string; base_sha: string; merge_base: string } | undefined;
    files: PrFileEntry[];
    fullPlan: PassPlan;
    standing: string | null;
    /** An approval-withheld mark stood when this round was picked up: the
     * standing APPROVE never reached GitHub, so it is not an approval the
     * sweep may rely on (a withheld approval is an approval yet to be posted). */
    approvalWithheld?: boolean;
    ecosystem: Ecosystem;
    styleGuide: readonly string[];
    ciLinters: readonly CiLinter[];
  },
): Promise<
  | { kind: "delta"; decision: FollowUpDecision }
  | { kind: "full"; reason: FollowUpFullReason; detail?: Record<string, unknown> }
> {
  const { cfg, history } = deps;
  const full = (reason: FollowUpFullReason, detail?: Record<string, unknown>) =>
    ({ kind: "full", reason, ...(detail ? { detail } : {}) }) as const;
  if (!deltaFollowUpEnabled(cfg)) return full("follow_up_full");
  if (!args.markHead) return full("no-reviewed-head");
  if (!args.tree || !args.tree.merge_base || !deps.prOwnedDelta) return full("no-adapter");
  // The merge base the reviewed head's round recorded (the latest live round
  // dispatched to that head, a verdicted one first): a base force-pushed
  // since then is caught by `prOwnedDelta` as `base-rewound`. Unknown (a
  // round recorded before the column existed) ⇒ only the base-tip check runs.
  const atMark = history
    .roundsFor(args.pr)
    .filter((r) => r.backfilled === 0 && r.head_sha === args.markHead && r.merge_base)
    .sort(
      (a, b) => Number(b.verdict !== null) - Number(a.verdict !== null) || b.round_no - a.round_no,
    );
  const fromMergeBase = atMark[0]?.merge_base ?? undefined;
  let delta: PrOwnedDelta;
  try {
    delta = await deps.prOwnedDelta({
      pr: args.pr,
      from: args.markHead,
      to: args.tree.head_sha,
      mergeBase: args.tree.merge_base,
      ...(args.tree.base_sha ? { baseSha: args.tree.base_sha } : {}),
      ...(fromMergeBase ? { fromMergeBase } : {}),
    });
  } catch (err) {
    return full("delta-threw", { error: err instanceof Error ? err.message : String(err) });
  }
  if (!delta.ok) return full(delta.reason, delta.detail ? { detail: delta.detail } : undefined);
  return planFollowUp(cfg, deps.heuristics, {
    delta,
    fromSha: args.markHead,
    files: args.files,
    fullPlan: args.fullPlan,
    ecosystem: args.ecosystem,
    styleGuide: args.styleGuide,
    ciLinters: args.ciLinters,
    sweepOwed: (deltaLines) =>
      followUpSweepOwed(cfg, {
        standing: args.standing,
        approvalWithheld: args.approvalWithheld === true,
        fullLookSinceFirst: () => history.fullLookSinceFirst(args.pr),
        deltaLines,
      }),
  });
}

/**
 * Whether a follow-up round owes the pre-approval sweep, the
 * `[review] follow_up_sweep` knob aside. Before a posted approval (a withheld
 * one never reached GitHub, so it counts as none): owed until a full look has
 * happened since the first round. After a posted approval: owed only when the
 * change since it reaches `follow_up_post_approval_sweep_lines` — a large push
 * onto an approved PR is where live re-reviews found blockers outside the
 * change; a small one stays delta-only.
 */
export function followUpSweepOwed(
  cfg: Config,
  args: {
    standing: string | null;
    approvalWithheld: boolean;
    fullLookSinceFirst: () => boolean;
    deltaLines: number;
  },
): boolean {
  if (args.standing === "APPROVE" && !args.approvalWithheld) {
    const floor =
      cfg.review.follow_up_post_approval_sweep_lines ??
      REVIEW_DEFAULTS.follow_up_post_approval_sweep_lines;
    return floor > 0 && args.deltaLines >= floor;
  }
  return !args.fullLookSinceFirst();
}

/**
 * The PURE half of `decideFollowUp`: given a computed delta, plan
 * the follow-up round — or answer `{full: reason}`. The daemon reaches it
 * through `decideFollowUp`; the bench's follow-up replay (src/bench/
 * followup.ts) calls it directly with a delta computed by the same
 * `WorktreeManager.prOwnedDelta` over its replay tree, so the two never
 * disagree about what a follow-up round plans.
 *
 * `sweepOwed` is consulted only when the `[review] follow_up_sweep` knob is on
 * and the plan stands: the daemon's answer reads the standing verdict and the
 * store; the bench's is the recorded case's.
 */
export function planFollowUp(
  cfg: Config,
  heuristics: HeuristicsExtension | undefined,
  args: {
    delta: Extract<PrOwnedDelta, { ok: true }>;
    fromSha: string;
    files: PrFileEntry[];
    fullPlan: PassPlan;
    ecosystem: Ecosystem;
    styleGuide: readonly string[];
    ciLinters: readonly CiLinter[];
    /** Handed the delta's line count. */
    sweepOwed: (deltaLines: number) => boolean;
  },
):
  | { kind: "delta"; decision: FollowUpDecision }
  | { kind: "full"; reason: FollowUpFullReason; detail?: Record<string, unknown> } {
  const { delta } = args;
  const prLines = args.files.reduce((n, f) => n + (f.additions ?? 0) + (f.deletions ?? 0), 0);
  const ratio = cfg.review.follow_up_max_delta_ratio ?? REVIEW_DEFAULTS.follow_up_max_delta_ratio;
  if (delta.lines > ratio * prLines)
    return {
      kind: "full",
      reason: "delta-too-large",
      detail: { delta_lines: delta.lines, pr_lines: prLines, ratio },
    };
  const deltaFiles = deltaAsPrFiles(delta.files) as PrFileEntry[];
  let plan = buildPassPlan(
    cfg,
    deltaFiles,
    undefined,
    args.ecosystem,
    heuristics,
    args.styleGuide,
    args.ciLinters,
    { tierFiles: args.files },
  );
  // The migration gate and the pre-check read the WHOLE PR, and their notes
  // name pass-data-safety (a degraded pre-check un-muzzles that lens, never
  // goes quiet). A PR whose migrations sit outside the delta
  // still gets the lens the gate names: the full plan's row rides the delta
  // plan, before the validator.
  if (
    args.ecosystem.migrationGate(args.files) &&
    !plan.pass_plan.some((p) => p.lens === DATA_SAFETY_PASS)
  ) {
    const carried = args.fullPlan.pass_plan.filter((p) => p.lens === DATA_SAFETY_PASS);
    if (carried.length > 0) {
      const at = plan.pass_plan.findIndex((p) => p.lens === VALIDATE_PASS);
      const rows = [...plan.pass_plan];
      rows.splice(at < 0 ? rows.length : at, 0, ...carried);
      plan = {
        ...plan,
        pass_plan: slowestFirst(rows, deltaFiles, new Set(cfg.models.risk_passes)),
        addable_lenses: plan.addable_lenses.filter((l) => l !== DATA_SAFETY_PASS),
      };
    }
  }
  // A small delta gets the LEAN plan (`[review] follow_up_small_delta_lines`):
  // pass-baseline reads it whole, so the per-file sweep rows add agents and
  // no coverage, and the quality and style lenses — which judged the PR in
  // round 1 — move to the addable list rather than leaving the round.
  // Under `follow_up_extent = "session"` every follow-up round plans the
  // lean core, and the rows it leaves out are offered as optional rows for
  // the session to run, partly run or skip — the small-delta threshold is the
  // session's call. Under `"rules"`, the lean plan at or under the threshold.
  let optionalPlan: PassPlanEntry[] = [];
  if ((cfg.review.follow_up_extent ?? REVIEW_DEFAULTS.follow_up_extent) === "session") {
    const lean = leanFollowUpPlan(plan);
    const kept = new Set(lean.pass_plan);
    optionalPlan = plan.pass_plan.filter((p) => !kept.has(p));
    const optionalLenses = new Set(optionalPlan.map((p) => p.lens));
    plan = {
      ...lean,
      sweep_unswept: plan.sweep_unswept,
      addable_lenses: lean.addable_lenses.filter((l) => !optionalLenses.has(l)),
    };
  } else {
    const smallDelta =
      cfg.review.follow_up_small_delta_lines ?? REVIEW_DEFAULTS.follow_up_small_delta_lines;
    if (smallDelta > 0 && delta.lines <= smallDelta) plan = leanFollowUpPlan(plan);
  }
  // pass-baseline carries every prior finding no other planned lens owns: a
  // follow-up plan without it (a profile switched it off) cannot verify them.
  if (!plan.pass_plan.some((p) => p.lens === BASELINE_PASS))
    return { kind: "full", reason: "baseline-unplanned" };
  // An owed sweep needs a plan to run: an empty full plan records nothing
  // owed rather than a sweep no round could ever satisfy.
  const sweepOwed =
    (cfg.review.follow_up_sweep ?? REVIEW_DEFAULTS.follow_up_sweep) &&
    args.fullPlan.pass_plan.length > 0 &&
    args.sweepOwed(delta.lines);
  return {
    kind: "delta",
    decision: {
      delta,
      fromSha: args.fromSha,
      deltaFiles,
      plan,
      ...(optionalPlan.length > 0 ? { optionalPlan } : {}),
      ...(sweepOwed
        ? {
            sweepPlan: args.fullPlan.pass_plan,
            ...(args.fullPlan.sweep_unswept.length > 0
              ? { sweepUnswept: args.fullPlan.sweep_unswept }
              : {}),
            ...(args.fullPlan.behaviour_unread?.length
              ? { sweepBehaviourUnread: args.fullPlan.behaviour_unread }
              : {}),
          }
        : {}),
    },
  };
}

const BASELINE_PASS = "pass-baseline";
const DATA_SAFETY_PASS = "pass-data-safety";

/** The lenses a lean follow-up plan offers as addable instead of planning. */
export const LEAN_ADDABLE_PASSES: readonly string[] = [...QUALITY_PASSES, STYLE_PASS];

/**
 * The LEAN follow-up plan: the plan without its per-file
 * pass-sweep rows, and with the quality and style lenses moved to
 * `addable_lenses`. Every other row — baseline, the triggered risk lenses,
 * the validator — is kept as planned, and so is a quality or style row the
 * plan marks `required` (one the operator made a risk pass): a required row
 * is an obligation, never an offer. No lens leaves the round: a session that
 * sees a quality or style question in the change adds the lens.
 */
export function leanFollowUpPlan(plan: PassPlan): PassPlan {
  const movable = (p: PassPlanEntry): boolean =>
    LEAN_ADDABLE_PASSES.includes(p.lens) && p.required !== true;
  const moved = lensesOf(plan.pass_plan.filter(movable));
  return {
    ...plan,
    pass_plan: plan.pass_plan.filter((p) => p.lens !== SWEEP_PASS && !movable(p)),
    addable_lenses: [
      ...plan.addable_lenses,
      ...moved.filter((l) => !plan.addable_lenses.includes(l)),
    ],
    sweep_unswept: [],
  };
}

/** A delta's files as one git-style patch (the hunks `prOwnedDelta` read,
 * each under its file header). */
export function renderDeltaPatch(files: readonly PrOwnedDeltaFile[]): string {
  const out: string[] = [];
  for (const f of files) {
    const oldPath = f.old_path ?? f.path;
    out.push(`diff --git a/${oldPath} b/${f.path}`);
    if (f.conflict)
      out.push(
        "# CONFLICT: the replay of the reviewed head conflicted here; the PR's own hunks follow",
      );
    if (f.binary) {
      out.push(`Binary files a/${oldPath} and b/${f.path} differ`);
      continue;
    }
    out.push(f.status === "added" ? "--- /dev/null" : `--- a/${oldPath}`);
    out.push(f.status === "removed" ? "+++ /dev/null" : `+++ b/${f.path}`);
    if (f.patch) out.push(f.patch.endsWith("\n") ? f.patch.slice(0, -1) : f.patch);
  }
  return out.length ? `${out.join("\n")}\n` : "";
}

/** The order's view of a delta (types.ts `RoundDelta`). */
export function roundDeltaOf(d: FollowUpDecision, patchFile: string): RoundDelta {
  return {
    from_sha: d.fromSha,
    tree: d.delta.tree,
    lines: d.delta.lines,
    files: d.delta.files.map((f) => ({
      path: f.path,
      ...(f.old_path !== undefined ? { old_path: f.old_path } : {}),
      status: f.status,
      ranges: f.ranges.map(([a, b]) => [a, b] as [number, number]),
      ...(f.whole_file ? { whole_file: true } : {}),
      ...(f.conflict ? { conflict: true } : {}),
    })),
    patch_file: patchFile,
  };
}

/** The order the follow-up round's OPTIONAL rows render their task files
 * from: the follow-up order itself — the change since the last
 * review stays their scope — with `optional_plan` as its plan. Prior
 * findings ride the core rows only (their assignment indexes `pass_plan`),
 * so none ride here. Pure. */
export function optionalOrderOf(order: RoundOrder, optionalPlan: PassPlanEntry[]): RoundOrder {
  const { prior_assignments: _p, optional_plan: _o, optional_task_files: _f, ...rest } = order;
  return {
    ...rest,
    pass_plan: optionalPlan,
    lenses: lensesOf(optionalPlan),
  };
}

/** The order the pre-approval sweep's task files render from: the
 * follow-up order minus its follow-up fields, planned with the whole PR's
 * full plan — exactly the order a full round would hand its lenses. Pure;
 * the daemon and the bench's follow-up replay render the sweep's tasks from
 * it alike. */
export function sweepOrderOf(order: RoundOrder, sweepPlan: PassPlanEntry[]): RoundOrder {
  const {
    scope: _s,
    delta: _d,
    prior_findings_note: _p,
    sweep_plan: _sp,
    sweep_plan_unswept: _su,
    sweep_plan_behaviour_unread: _bu,
    sweep_task_files: _st,
    // The delta plan's facts, not the whole PR's: the sweep carries its own.
    sweep_unswept: _du,
    behaviour_unread: _db,
    coverage_files: _cf,
    ...whole
  } = order;
  return {
    ...whole,
    pass_plan: sweepPlan,
    lenses: lensesOf(sweepPlan),
    ...(order.sweep_plan_unswept && order.sweep_plan_unswept.length > 0
      ? { sweep_unswept: order.sweep_plan_unswept }
      : {}),
    ...(order.sweep_plan_behaviour_unread?.length
      ? { behaviour_unread: order.sweep_plan_behaviour_unread }
      : {}),
  };
}

/** Build the round order for one PR — pure once the files list is in hand. */
export function buildRoundOrder(args: {
  cfg: Config;
  row: PrStateRow;
  files: PrFileEntry[];
  roundId: number;
  roundNo: number;
  /** Prior VERDICTED rounds + 1 — the PR's review age. Drives the nit cap;
   * failed (cancelled/overdue) rounds advance round_no but not this. */
  reviewNo?: number;
  roundType: RoundType;
  worktree: string;
  settledDigest: string;
  /** The PR's mirrored ledger; absent ⇒ no `ledger_carry`. */
  ledgerCarry?: LedgerCarry;
  issuedAt: string;
  /** Facts established by preparing the worktree. Absent only for callers with
   * no worktree seam (the stub-wired daemon core and unit tests), which fall
   * back to the PR row's sha and an unknown base. */
  tree?: PreparedTree;
  /** Collisions the pre-check found — delivered as a COMMENT unless
   * `migrationCollisionsUndelivered` says the COMMENT did not reach the PR. */
  migrationCollisions?: MigrationCollision[];
  /** True when the collisions' COMMENT was withheld, refused or failed: the
   * gate note then hands the remedy to the session. */
  migrationCollisionsUndelivered?: boolean;
  /** True when the PR touches migrations and the pre-check could NOT run —
   * the prompt must tell the session to check collisions itself. */
  migrationPrecheckDegraded?: boolean;
  /** First-party directive files + the picked escalation mention. */
  firstPartyDirectives?: { files: string[]; mention: string };
  /** The PR body as GitHub returned it: pass-intent's whole intent
   * artifact and the substance-bar input. Absent (stub-wired core, unit tests
   * without an adapter body) ⇒ the intent lens is never selected. */
  prBody?: string;
  /** The round's ecosystem. Absent ⇒ Django. */
  ecosystem?: Ecosystem;
  /** Exact predecessor identity for a pre-fanout recovery successor. */
  recovery?: RoundRecoveryContext;
  /** Profile lens-heuristics extension; absent ⇒ generic core. */
  heuristics?: HeuristicsExtension;
  /** The names the order launches lenses in (`SessionHooks.lensRuntime`): the
   * worker host's engine tools. Absent ⇒ native, the tmux host's. */
  lensRuntime?: "engine";
  /** The rendered third-party-sources block (src/depsources.ts). */
  dependencyNote?: string;
  /** The repo's written style guide references (src/styleguide.ts). */
  styleGuide?: readonly string[];
  /** The linters a CI job of the repo runs (src/lintconfig.ts). */
  ciLinters?: readonly CiLinter[];
  /** The plan, already built by the caller (dispatch builds it once and
   * records the same plan on the round row). Absent ⇒ built here from
   * `files`, the PR body, the style guide and the linters. */
  plan?: PassPlan;
  /** A FOLLOW-UP round's facts: the delta, the prior findings note, the owed
   * sweep's plan. The coverage check then holds the round to the delta's
   * files. Absent ⇒ a full round's order. */
  followUp?: {
    delta: RoundDelta;
    deltaFiles: PrFileEntry[];
    priorFindingsNote: string;
    /** The listed prior findings: each is assigned to the plan row that owns
     * it and written into that row's task file. Absent (the list could not be
     * assembled) ⇒ the session assigns them. */
    priorFindings?: Pick<PriorFindingsList, "findings" | "round_no">;
    /** The optional rows the session decides (`optional_plan`). */
    optionalPlan?: PassPlanEntry[];
    sweepPlan?: PassPlanEntry[];
    sweepUnswept?: string[];
    sweepBehaviourUnread?: string[];
  };
}): RoundOrder {
  const eco = args.ecosystem ?? DJANGO_ECOSYSTEM;
  const { pass_plan, addable_lenses, sweep_unswept, behaviour_unread } =
    args.plan ??
    buildPassPlan(
      args.cfg,
      args.files,
      { title: args.row.title, body: args.prBody },
      eco,
      args.heuristics,
      args.styleGuide ?? [],
      args.ciLinters ?? [],
    );
  const headSha = reviewedHeadOf(args.tree, args.row);
  // An addable lens the profile floors above the add rule's own
  // variant is named with its variant in the prompt.
  const addable_tiers = Object.fromEntries(
    addable_lenses
      .filter((l) => !args.cfg.models.risk_passes.includes(l))
      .map((l) => [l, addTierOf(args.cfg, l)] as const)
      .filter(([, t]) => t !== "sol-med"),
  );
  return {
    pr: args.row.number,
    title: args.row.title,
    round_id: args.roundId,
    round_no: args.roundNo,
    posting_key: roundPostingKey(args.row.number, args.roundNo, headSha),
    ...(args.reviewNo !== undefined ? { review_no: args.reviewNo } : {}),
    round_type: args.roundType,
    // Kept for compatibility with the rounds table / event log: always the
    // pass_plan's lens names in plan order (a lens with several rows — the
    // sweep — once).
    lenses: lensesOf(pass_plan),
    pass_plan,
    addable_lenses,
    ...(Object.keys(addable_tiers).length > 0 ? { addable_tiers } : {}),
    ...(sweep_unswept.length > 0 ? { sweep_unswept } : {}),
    ...(behaviour_unread && behaviour_unread.length > 0 ? { behaviour_unread } : {}),
    ...(args.dependencyNote ? { dependency_note: args.dependencyNote } : {}),
    ...(args.cfg.review.nits === "open" ? { nit_policy: "open" as const } : {}),
    ...(isDefaultPosting(args.cfg.posting) ? {} : { posting_policy: args.cfg.posting }),
    // `[review] render_outputs` (src/reviewrender.ts): the round renders its
    // posted review from the findings record. Absent ⇒ the session writes
    // both files itself.
    ...(args.cfg.review?.render_outputs ? { render_outputs: true } : {}),
    // `[review] dedup_merge` (src/templates.ts renderDedupNote): only when
    // the plan has a validator to hand the groups to.
    ...(args.cfg.review?.dedup_merge && pass_plan.some((p) => p.lens === "pass-validate")
      ? { dedup_merge: true }
      : {}),
    // `[review] validate_compact` (src/templates.ts
    // renderValidatorOutputNote): only when the plan has a validator.
    ...(args.cfg.review?.validate_compact && pass_plan.some((p) => p.lens === "pass-validate")
      ? { validate_compact: true }
      : {}),
    // `[review] coverage_check` (src/coverage.ts): only when the plan has a
    // sweep to launch for the uncovered files and there is a file to hold it to.
    ...(() => {
      if (!args.cfg.review?.coverage_check || !pass_plan.some((p) => p.lens === "pass-sweep"))
        return {};
      // A follow-up round's coverage is the delta's — the rest of
      // the PR was covered by the round that reviewed it.
      const coverage_files = coverageEligible(args.followUp?.deltaFiles ?? args.files);
      return coverage_files.length > 0 ? { coverage_files } : {};
    })(),
    // `[review] validator_shards` (templates.ts renderValidatorShardNote):
    // only above 1, and only when the plan has a validator to shard.
    ...((args.cfg.review?.validator_shards ?? 1) > 1
      ? { validator_shards: args.cfg.review.validator_shards }
      : {}),
    migration_gate: eco.migrationGate(args.files),
    migration_collisions: args.migrationCollisions ?? [],
    ...(args.migrationCollisionsUndelivered && (args.migrationCollisions ?? []).length > 0
      ? { migration_collisions_undelivered: true }
      : {}),
    migration_precheck_degraded: args.migrationPrecheckDegraded ?? false,
    ...(args.firstPartyDirectives !== undefined
      ? { first_party_directives: args.firstPartyDirectives }
      : {}),
    // Absent unless escalation is enabled AND session judgement is on, so the
    // default install's order (and prompt) carries no escalation targets.
    ...((): { escalation_targets?: string[] } => {
      const targets = promptTargetsFor(args.cfg.escalation);
      return targets ? { escalation_targets: targets } : {};
    })(),
    ...(args.recovery?.target_head_sha === headSha ? { recovery: args.recovery } : {}),
    head_sha: headSha,
    base_ref: args.tree?.base_ref ?? "",
    base_sha: args.tree?.base_sha ?? "",
    merge_base: args.tree?.merge_base ?? "",
    worktree: args.worktree,
    settled_digest: args.settledDigest,
    ...(args.ledgerCarry ? { ledger_carry: args.ledgerCarry } : {}),
    issued_at: args.issuedAt,
    ...(args.lensRuntime ? { lens_runtime: args.lensRuntime } : {}),
    ...(args.prBody !== undefined ? { pr_body: args.prBody } : {}),
    ...(args.followUp
      ? {
          scope: "delta" as const,
          delta: args.followUp.delta,
          prior_findings_note: args.followUp.priorFindingsNote,
          ...((args.cfg.review.follow_up_extent ?? REVIEW_DEFAULTS.follow_up_extent) === "session"
            ? { follow_up_extent: "session" as const }
            : {}),
          ...(args.followUp.optionalPlan && args.followUp.optionalPlan.length > 0
            ? { optional_plan: args.followUp.optionalPlan }
            : {}),
          ...((): { prior_assignments?: PriorAssignment[] } => {
            const list = args.followUp.priorFindings;
            if (!list || list.findings.length === 0) return {};
            const assigned = assignPriorFindings(
              list,
              pass_plan,
              new Set(args.followUp.delta.files.map((f) => f.path)),
            );
            return assigned.length > 0 ? { prior_assignments: assigned } : {};
          })(),
          ...(args.followUp.sweepPlan && args.followUp.sweepPlan.length > 0
            ? {
                sweep_plan: args.followUp.sweepPlan,
                ...(args.followUp.sweepUnswept && args.followUp.sweepUnswept.length > 0
                  ? { sweep_plan_unswept: args.followUp.sweepUnswept }
                  : {}),
                ...(args.followUp.sweepBehaviourUnread?.length
                  ? { sweep_plan_behaviour_unread: args.followUp.sweepBehaviourUnread }
                  : {}),
              }
            : {}),
        }
      : {}),
  };
}
