// The review config: the config.toml sections the review core reads, their
// defaults and their parsers. The schema of every other surface (ops,
// ingress, Slack, TUI, companion, memory, archive, …) and the install's homes
// stay in src/config.ts, which re-exports everything here and parses the
// whole file through these same section parsers.
//
// `parseCoreConfig` reads just these sections: what a one-shot review needs,
// with no install home, no secrets lookup and no app section. Where a caller
// wants the located secrets dir or a deprecation said, it does that itself.
import { parse } from "smol-toml";
import { globProblem } from "./glob.js";
import {
  INTENT_MIN_SUBSTANCE_WORDS,
  PLACEMENT_MIN_NEW_FILE_LINES,
  PLACEMENT_MIN_PROD_FILES,
  QUALITY_MIN_ADDED_LINES,
  SWEEP_MAX_FILES_PER_GROUP,
  SWEEP_MAX_LINES_PER_GROUP,
  SWEEP_WIDE_FILES_PER_GROUP,
} from "./heuristics.js";
import type { LensTuningMap } from "./lenstuning.js";
import type { PostingPolicy } from "./postingpolicy.js";
import { ALL_PASSES, SCAN_DEEP_FLOOR_LENSES, SCAN_DEEP_LENSES } from "./passes.js";
import { PASS_TIER_ORDER, type PassTier } from "./types.js";

export interface GithubConfig {
  repo: string;
  app_slug: string;
  bot_login: string;
  review_team: string;
  trigger_label: string;
  in_progress_label: string;
  reviewed_label: string;
  improvement_label: string;
  issue_label: string;
  /** Always an absolute-or-given path after parse: an empty (or the legacy
   * default `~/.config/quickreview-bot`) value is resolved by the install
   * locator to `<config home>/secrets` (the legacy dir itself is never read).
   * A value the operator set is taken as given. */
  secrets_dir: string;
  /** The reviewed repo's default branch: the base the improvement
   * filer targets, the branch replay diffs against, and the fixture base for
   * CLI ops. Default "main"; a repo whose default is "master" sets it. PR rounds do NOT
   * read this — a round's base is always the PR's own `base_ref` from the
   * GitHub API. */
  base_branch: string;
  /** Directory name of the base clone under the sandbox root.
   * "" (the default) derives from the repo slug's basename via
   * `githubCloneDir` — "owner/name" ⇒ "name". */
  clone_dir: string;
}

/**
 * [guards] — the posting-time guards. Every one but `no_checks_is_red` is on
 * by default; a knob exists only so a guard can be taken out of the path
 * deliberately, in one place, rather than by editing the gate.
 */
export interface GuardsConfig {
  /** A non-author human APPROVED at the head ⇒ post COMMENT, not REQUEST_CHANGES. */
  downgrade_on_human_approval: boolean;
  /** Same head as the last review and no author reply since ⇒ post nothing. */
  skip_unchanged_head: boolean;
  /** Re-read the PR immediately before every posting mutation; merged/closed ⇒ refuse. */
  recheck_pr_state_before_post: boolean;
  /** No green CI at this head ⇒ APPROVE is unavailable; the review posts as a
   * COMMENT with approval withheld. */
  block_approve_on_red_ci: boolean;
  /** A head with ZERO check-runs also withholds approval: in a CI-running
   * repo that is a conflicted PR or CI that has not started — no execution
   * evidence. Off by default so a repo with no CI at all is never wedged (the
   * `none` exemption). */
  no_checks_is_red: boolean;
  /** The head the review is ABOUT must still be the PR's live head at posting
   * time: a push landing between the round's validation and
   * its posting step otherwise lands a stale review against the new head. */
  refuse_on_head_drift: boolean;
}

export const GUARDS_DEFAULTS: GuardsConfig = {
  downgrade_on_human_approval: true,
  skip_unchanged_head: true,
  recheck_pr_state_before_post: true,
  block_approve_on_red_ci: true,
  no_checks_is_red: false,
  refuse_on_head_drift: true,
};

/**
 * [review.directives] — EXTENSIONS to the first-party directive-path
 * vocabulary (`src/severity.ts DEFAULT_DIRECTIVE_VOCABULARY`). Extend-only by
 * design: config ADDS names, nothing can remove a built-in — dropping, say,
 * `CLAUDE.md` would silently re-enable auto-blocking on first-party directive
 * edits by config typo. The shape mirrors
 * `severity.ts DirectiveVocabularyExtras`.
 */
export interface ReviewDirectivesConfig {
  /** Extra vendored/third-party path segments (matched case-insensitively). */
  extra_vendored_segments: string[];
  /** Extra directive-file basenames (any depth), e.g. "COPILOT.md". */
  extra_basenames: string[];
  /** Extra directory segments whose whole subtree is directive content. */
  extra_dir_segments: string[];
  /** Extra ROOT-level directory names (bind at the repo root only). */
  extra_root_dirs: string[];
  /** Extra exact repo-relative directive file paths. */
  extra_files: string[];
}

export const REVIEW_DIRECTIVES_DEFAULTS: ReviewDirectivesConfig = {
  extra_vendored_segments: [],
  extra_basenames: [],
  extra_dir_segments: [],
  extra_root_dirs: [],
  extra_files: [],
};

/**
 * [review] — review-content knobs. Distinct from [guards] (posting-time
 * refusals) and [recheck] (post-approval triggers): these shape what a review
 * says, not whether it posts.
 */
export interface ReviewConfig {
  /**
   * Fallback @-mention for the first-party-directive escalation comment when
   * git history yields no attributable human author login for the touched
   * directive files. "" ⇒ the comment renders without an @ (addressed to
   * "a maintainer") — it still posts.
   */
  escalation_mention_default: string;
  /**
   * Repo profile: names a directory under `profiles/` — the install's config
   * home first, then the checkout's generic examples
   * (`src/install.ts locateProfile`; a non-plain name is refused) — whose
   * house-rule addenda pack (`profiles/<name>/addenda/*.md`) is composed onto
   * the built pass bodies AFTER the built-in generic registry and BEFORE the
   * dynamic same-day feedback addendum — and whose optional
   * `heuristics.toml` extends lens selection with repo-shaped predicates.
   * "" ⇒ no profile: exactly the generic addenda set and the generic
   * selection core. Loaded once at daemon assembly (src/wire.ts) — a
   * malformed pack or heuristics file fails the boot loudly, never a silent
   * skip.
   */
  profile: string;
  /** Directive-path vocabulary extensions — see the type above. */
  directives: ReviewDirectivesConfig;
  /** The named review configuration (`REVIEW_PRESETS`): the reasoning level
   * and every lever below in one word. A key set explicitly in `[review]` (or
   * `[models] effort`) overrides what the preset would give it. */
  preset: ReviewPreset;
  /** Content-triggered sub-lenses (`SUBLENS_TRIGGERS` in src/heuristics.ts):
   * narrow passes, each a fixed procedure, planned when the diff or the PR
   * text shows the shape its procedure exists for. Off ⇒ the path-shaped
   * plan alone. */
  sublenses: boolean;
  /** The per-file sweep (`agents/pass-sweep.md`): changed files are grouped
   * into a few small batches and each batch gets its own line-by-line pass —
   * the local slips a whole-PR reading skims past. */
  sweep: boolean;
  /** At most this many sweep passes per round; files beyond them are listed
   * as not swept. */
  sweep_max_groups: number;
  /** Files and changed lines per sweep group (heuristics.ts sweepGroups). */
  sweep_group_files: number;
  sweep_group_lines: number;
  /** Files per sweep group on a WIDE change — more files than
   * `sweep_group_files × sweep_max_groups` — packed by `sweep_group_lines`
   * instead (heuristics.ts SWEEP_WIDE_FILES_PER_GROUP). 0 = off. */
  sweep_wide_files: number;
  /** The behaviour-delta lens (`agents/pass-behaviour-delta.md`): base versus
   * head on every modified or deleted line of non-test code, one row per group
   * of modifying files packed by `sweep_group_lines` changed lines, at most
   * `behaviour_delta_max_groups` rows (heuristics.ts behaviourDeltaGroups). */
  behaviour_delta: boolean;
  behaviour_delta_max_groups: number;
  /** Over this many changed lines (heuristics.ts `baselineSplitLines` — the
   * sweep's sizing: prose half, lockfiles, generated and vendored files
   * nothing) pass-baseline is planned as 2–3 rows, each STARTING from one
   * group of the change's files with the whole PR as its charter
   * (heuristics.ts `baselineGroups`). 0 ⇒ never: one row. At 2000 only the
   * largest PRs split — those where a lone baseline row sets the round's
   * critical path; every PR under it plans as one row. */
  baseline_split_lines: number;
  /** The loosened-test hint (src/loosenedtests.ts): weakened assertions in
   * the PR's test files are found deterministically and named in pass-tests'
   * plan reason; their presence also plans pass-tests. Off ⇒ neither. */
  loosened_test_hint: boolean;
  /** Selection cost knobs (heuristics.ts SelectionTuning): pass-intent's
   * substance bar in words, and when pass-placement runs — this many code
   * files, or a new code file with this many added lines. */
  intent_min_words: number;
  placement_min_code_files: number;
  placement_min_new_file_lines: number;
  /** Unpack the sources of the third-party packages this PR touches, at
   * their locked versions, so passes can read what a library actually does
   * (src/depsources.ts). Download-and-unpack only — nothing is installed or
   * run. */
  dependency_sources: boolean;
  /** The tests lens (`agents/pass-tests.md`) on every PR that
   * changes code — which existing tests the change breaks, and whether the
   * PR's own tests exercise the code or mock the failure point away. */
  tests_lens: boolean;
  /** The code-quality lenses (`agents/pass-maintainability.md`,
   * `pass-duplication.md`, `pass-abstraction.md`; heuristics.ts
   * QUALITY_PASSES) on every PR whose non-test code adds at least
   * `quality_min_added_lines` lines. Style is none of them. */
  quality_lenses: boolean;
  quality_min_added_lines: number;
  /** The style lens (`agents/pass-style.md`) — planned only when the repo has
   * a written style guide (src/styleguide.ts), and judging only against it. */
  style_lens: boolean;
  /** The lint-conformance sub-lens (`agents/pass-lint-conformance.md`) —
   * planned only when a CI job of the repo runs a linter or formatter whose
   * rules cover a changed file (src/lintconfig.ts), reporting only changed
   * lines that would fail that job. */
  lint_conformance: boolean;
  /** How many nits a review may post. `strict` (the default, production's
   * behaviour): the validator drops true-but-trivial candidates (`below-bar`),
   * a nit must name the change it asks for, and review volume comes
   * out of nits. `open`: none of those limits — every true nit posts. Meant
   * for benchmarks whose references reward nits; a repo that wants every nit
   * can set it too. Style still needs the repo's written guide either way. */
  nits: NitPolicy;
  /** The validator demotes a confirmed, actionable observation instead of
   * killing it for a small consequence (`validate-demote-not-kill`).
   * On by default; off reproduces the earlier validator for a benchmark. */
  validate_demote: boolean;
  /** Passes never planned and never addable this round (cost tuning). `[]`
   * (the default) plans every lens selection picks. Names must be known
   * passes; `pass-validate` is refused here — switching the validator off is
   * the profile's `enabled = false`. Not a preset lever. */
  skip_lenses: string[];
  /** The validator's consequence rules (`validate-consequence-rule`):
   * intent/contract appeals, dead code, CI-enabled lint rules and
   * merges judged by consequence. Off by default; opt-in for a benchmark arm. */
  validate_consequence_rule: boolean;
  /** Review latency levers (bench/aacr/PERF.md §6). None changes
   * which lenses run or what they are asked; each removes serial time.
   *
   * `wide_lens_fanout`: a batched `tasks:[…]` lens launch runs as wide as
   * `[engine] lens_max_concurrency`.
   * Deprecated: it steered only the retired native glue, and is a no-op on an
   * SDK session, where our lens tool sets its own width. */
  wide_lens_fanout: boolean;
  /** `task_files`: the daemon (or the bench) writes each plan row's complete
   * lens task to a file (src/passtasks.ts), so the session launches a lens
   * with a short pointer instead of generating its whole task string. */
  task_files: boolean;
  /** `render_outputs`: the posted review body and inline-comments JSON are
   * rendered deterministically from the findings record (src/reviewrender.ts)
   * instead of being written out by the session a second time. */
  render_outputs: boolean;
  /** `validator_shards`: how many `pass-validate` children split the
   * candidates (by file); 1 = one validator. */
  validator_shards: number;
  /** `dedup_merge` (docs/duplicate-merge.md): candidates are grouped
   * deterministically before the validator (the `cluster_findings` tool,
   * src/dedup.ts), the validator judges each group as one root cause or
   * splits it, and a post-check at render time merges two posted findings
   * that are one root cause posted twice. Off ⇒ none of that: no grouping,
   * no merge. */
  dedup_merge: boolean;
  /** `coverage_check` (src/coverage.ts): after the lenses return, every
   * changed non-test source file no lens raised a finding on gets a targeted
   * pass-sweep row (at most two, packed by line budget), each saying why. Off
   * ⇒ no coverage rows. */
  coverage_check: boolean;
  /** `follow_up` (docs/follow-up-rounds.md): `"delta"` ⇒ every round after
   * the first is a FOLLOW-UP round — prior findings verified, the PR-owned
   * change since the last reviewed head reviewed, one pre-approval sweep when
   * owed — falling back to a full re-review on any doubt. `"full"` ⇒ every
   * later round is a full re-review. */
  follow_up: "delta" | "full";
  /** Above this share of the PR's diff lines (additions + deletions), the
   * delta is too large to be worth a follow-up round: the round runs in full. */
  follow_up_max_delta_ratio: number;
  /** false ⇒ a follow-up round never plans the pre-approval sweep. */
  follow_up_sweep: boolean;
  /** After a POSTED approval the sweep is owed only when the PR-owned change
   * since it reaches this many lines (additions + deletions); 0 ⇒ never.
   * The default of 500 reflects measurement: post-approval blockers outside
   * the change sat behind 600+-line pushes, while most post-approval rounds
   * change fewer than 500 lines. */
  follow_up_post_approval_sweep_lines: number;
  /** A follow-up delta of at most this many lines (additions + deletions)
   * gets a LEAN plan: no per-file pass-sweep rows (pass-baseline reads a small
   * change whole) and the quality and style lenses offered as addable instead
   * of planned (they judged the PR in round 1; on a fix push they mostly
   * re-raise nits). 0 ⇒ never lean. A follow-up round's time tracks its
   * agent count, and small deltas otherwise fan out to 15–20 agents. */
  follow_up_small_delta_lines: number;
  /** `context_pack` (src/contextpack.ts): `"pack-first"` ⇒ the
   * daemon writes the round's CONTEXT PACK (the diff, the change since the
   * last review, the most-changed files' full text) beside its task files, and
   * every lens session carries it at the very start of its prompt, ahead of its
   * lens instructions (src/engine/lens/leaf-cache.ts) — one shared, cached prefix
   * instead of every lens re-reading the same text uncached. `"off"` ⇒ no
   * pack. Takes effect only with `[engine] lens_cache_group` > 0 (an unshared
   * pack would cost more, not less). On by default: measured ~40% cheaper,
   * with verdicts and recall unchanged. */
  context_pack: "off" | "pack-first";
  /** The pack's size cap in tokens (≈4 characters each). */
  context_pack_max_tokens: number;
  /** A benchmark lever until measured: a pass-sweep row whose files are ALL
   * tests, prose or config/data (heuristics.ts `isLightSweepFile`) runs at
   * this tier instead of the sweep's own. `""` ⇒ off: every sweep row at the
   * sweep's tier. A profile `min_tier`
   * for pass-sweep still floors it, and a tier at or above the sweep's own
   * changes nothing. */
  sweep_light_tier: "" | PassTier;
  /** The validator answers with a DECISION TABLE keyed by
   * candidate id instead of restating every survivor — only a finding whose
   * text it changed is written out in full (`validate-compact-output`
   * addendum; the session's half is `{{validator_output_note}}`). What it
   * decides is unchanged. `false` ⇒ the frozen output format. */
  validate_compact: boolean;
  /** Who sizes a FOLLOW-UP round.
   * `"session"` ⇒ every follow-up round plans the lean core (pass-baseline,
   * the risk lenses, behaviour-delta, the validator) and offers the full
   * plan's per-file sweep rows and quality/style lenses as OPTIONAL rows the
   * main session runs, partly runs or skips — and it decides whether an owed
   * pre-approval sweep is needed — each with a stated reason, logged.
   * `"rules"` ⇒ fixed rules: the lean plan only at or under
   * `follow_up_small_delta_lines`, the pre-approval sweep always run when
   * owed and the round would approve. */
  follow_up_extent: "session" | "rules";
}

export type NitPolicy = "strict" | "open";

/**
 * `[review] preset` — three named review configurations, measured on the
 * defect benchmark (bench/aacr/RESULTS.md):
 *
 *   - `default` — the measured best value. Every lever on with the lean plan:
 *     on ten PRs no change was designed from it found 81% of the real defects
 *     (weighted 86%) against 71% before the levers, for $1.02 vs $0.90 a PR and
 *     the same ~6 minutes.
 *   - `max` — every model at its highest reasoning level and the full lever
 *     plan (every intent and placement pass, small sweep groups). Measured on
 *     smoke10 with the pre-lever plan: 72% of defects vs 44-51%, at ~$2 and ~18
 *     minutes a PR. For the PRs that warrant it.
 *   - `low` — every model at low reasoning, the default plan. Half the cost
 *     and time of `default` (~$0.52, ~3.5 min a PR on fresh10) for about the
 *     recall the review had BEFORE the levers (69% vs 71% of real defects),
 *     with fewer high-severity finds and less accurate comments (73%).
 */
export type ReviewPreset = "low" | "default" | "max";

type PresetLevers = Pick<
  ReviewConfig,
  | "sublenses"
  | "sweep"
  | "sweep_max_groups"
  | "sweep_group_files"
  | "sweep_group_lines"
  | "sweep_wide_files"
  | "behaviour_delta"
  | "behaviour_delta_max_groups"
  | "loosened_test_hint"
  | "intent_min_words"
  | "placement_min_code_files"
  | "placement_min_new_file_lines"
  | "dependency_sources"
  | "tests_lens"
  | "quality_lenses"
  | "quality_min_added_lines"
  | "style_lens"
  | "lint_conformance"
>;

/** The lean lever plan — `default` and `low` share it. Its thresholds are the
 * selection's own defaults (src/heuristics.ts), named once there. */
const LEAN_LEVERS: PresetLevers = {
  sublenses: true,
  sweep: true,
  sweep_max_groups: 6,
  // 8 files, so the 500-line budget binds first on most groups: a 5-file cap
  // cut nearly half the sweep rows at a median of 78 changed lines, and 8
  // plans ~17% fewer rows with none unswept.
  sweep_group_files: SWEEP_MAX_FILES_PER_GROUP,
  sweep_group_lines: SWEEP_MAX_LINES_PER_GROUP,
  sweep_wide_files: SWEEP_WIDE_FILES_PER_GROUP,
  behaviour_delta: true,
  behaviour_delta_max_groups: 3,
  loosened_test_hint: true,
  intent_min_words: INTENT_MIN_SUBSTANCE_WORDS,
  placement_min_code_files: PLACEMENT_MIN_PROD_FILES,
  placement_min_new_file_lines: PLACEMENT_MIN_NEW_FILE_LINES,
  dependency_sources: true,
  tests_lens: true,
  quality_lenses: true,
  quality_min_added_lines: QUALITY_MIN_ADDED_LINES,
  style_lens: true,
  lint_conformance: true,
};

export const REVIEW_PRESETS: Readonly<
  Record<ReviewPreset, { effort: ReviewEffort; levers: PresetLevers }>
> = {
  default: { effort: "", levers: LEAN_LEVERS },
  low: { effort: "low", levers: LEAN_LEVERS },
  max: {
    effort: "high",
    levers: {
      ...LEAN_LEVERS,
      sweep_max_groups: 8,
      sweep_group_files: 3,
      sweep_group_lines: 400,
      behaviour_delta_max_groups: 4,
      intent_min_words: 20,
      placement_min_code_files: 4,
      placement_min_new_file_lines: 0,
    },
  },
};

export function parsePreset(raw: unknown): ReviewPreset {
  const v = String(raw ?? "default")
    .trim()
    .toLowerCase();
  if (v === "low" || v === "default" || v === "max") return v;
  throw new Error(`config.toml [review] preset must be "low", "default" or "max" (got "${v}")`);
}

export const REVIEW_DEFAULTS: ReviewConfig = {
  escalation_mention_default: "",
  profile: "",
  directives: REVIEW_DIRECTIVES_DEFAULTS,
  preset: "default",
  ...LEAN_LEVERS,
  nits: "strict",
  validate_demote: true,
  skip_lenses: [],
  validate_consequence_rule: false,
  wide_lens_fanout: true,
  task_files: true,
  render_outputs: true,
  validator_shards: 1,
  dedup_merge: true,
  coverage_check: true,
  follow_up: "delta",
  follow_up_max_delta_ratio: 0.6,
  follow_up_sweep: true,
  follow_up_post_approval_sweep_lines: 500,
  follow_up_small_delta_lines: 150,
  baseline_split_lines: 2000,
  context_pack: "pack-first",
  context_pack_max_tokens: 40000,
  sweep_light_tier: "",
  validate_compact: true,
  follow_up_extent: "session",
};

/**
 * [escalation] — the optional, OFF-BY-DEFAULT escalation feature (CLAUDE.md
 * rule 10).
 *
 * Two invariants bound everything this table can express, and neither is a
 * knob:
 *
 *   1. The reviewer STILL DECIDES. An escalation is additive notification
 *      posted BESIDE a finished verdict. Nothing here can withhold, defer or
 *      replace one — `src/escalation.ts` has no verdict in its return type and
 *      is called only after the verdict has been applied.
 *   2. It escalates a QUESTION, never a review. Every escalation names one
 *      thing to look at (a file and line range, a migration, a named
 *      decision) and why that person. There is no way to configure "ask
 *      someone to review this PR" — the comment body is rendered from the
 *      scope, not written free-hand.
 *
 * With `enabled = false` (the default, and what every shipped config carries)
 * nothing in this table is read and BEHAVIOUR is identical to a build without
 * the feature. (Not byte-identical prompt text: the `{{escalation_note}}`
 * placeholder renders empty and leaves a blank line, exactly as the sibling
 * `{{directive_note}}` already does. `tests/escalation.test.ts` pins that
 * whitespace is the ONLY difference.)
 */
export type EscalationShape = "comment" | "review_request";

/** A severity threshold a rule may key on. Matches `src/severity.ts Severity`
 * minus "nit", which is never worth a person's attention by definition. */
export type EscalationSeverityFloor = "P0" | "P1" | "P2" | "P3";

/**
 * One operator-defined DETERMINISTIC trigger. No LLM judgement takes part in
 * evaluating one: given the round's facts, `evaluateEscalationRules` is a pure
 * function and `tests/escalation.test.ts` drives it directly.
 *
 * A rule fires when EVERY condition it declares is met (conditions AND
 * together) — a rule that declares none never fires, and configuration
 * validation refuses it rather than shipping a rule that silently does
 * nothing.
 */
export interface EscalationRule {
  /** Stable name — it appears in the event log and in the posted note. */
  name: string;
  /** The GitHub login to escalate to. MUST be one of `targets`. */
  to: string;
  /** Why this person, in the operator's own words — rendered verbatim. */
  why: string;
  /** Glob-ish path patterns; fires when the PR touches a matching file. */
  paths: string[];
  /** PR labels; fires when the PR carries one of them. */
  labels: string[];
  /** Fires when the round posted a finding at or above this severity. */
  min_severity: EscalationSeverityFloor | "";
  /** Check-run names; fires when the LATEST run of one is not green. */
  failing_checks: string[];
}

export const ESCALATION_RULE_DEFAULTS: EscalationRule = {
  name: "",
  to: "",
  why: "",
  paths: [],
  labels: [],
  min_severity: "",
  failing_checks: [],
};

export interface EscalationConfig {
  /** OFF by default. False ⇒ no rule is evaluated, no note is rendered into
   * any prompt, and no escalation mutation is ever built. */
  enabled: boolean;
  /**
   * How an escalation is delivered. `comment` (the default) posts a gated
   * COMMENT review @-mentioning the person with the narrow ask.
   * `review_request` ALSO puts the PR in that person's review-requested queue
   * (the `request_reviewer` gate kind) — GitHub's own UI frames that as
   * "review this pull request", which is exactly the framing this feature
   * rules out, so the accompanying comment is still posted and still carries
   * the narrow ask. `comment` is the shape that matches the intent.
   */
  shape: EscalationShape;
  /** The CLOSED set of logins any escalation may reach. A session-judgement
   * escalation naming anyone else is dropped and logged; it is not an error
   * the session can talk its way past. */
  targets: string[];
  /** May the PR's session ALSO escalate on its own judgement, bounded to
   * `targets`? Off by default — the deterministic rules stand alone. */
  session_judgement: boolean;
  /** Hard cap on escalations delivered per PR, across all rounds. */
  max_per_pr: number;
  /** The deterministic triggers. */
  rules: EscalationRule[];
}

export const ESCALATION_DEFAULTS: EscalationConfig = {
  enabled: false,
  shape: "comment",
  targets: [],
  session_judgement: false,
  max_per_pr: 2,
  rules: [],
};

export const ESCALATION_SEVERITY_FLOORS: readonly string[] = ["P0", "P1", "P2", "P3"];
/** A GitHub login: letters, digits and single inner dashes, at most 39. */
export const ESCALATION_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/**
 * Parse and VALIDATE `[escalation]`.
 *
 * A half-configured live state is made unrepresentable here
 * rather than only in the wizard: a config with the feature on and no target,
 * or with a rule pointing at a login that is not a target, or with a rule that
 * declares no condition, fails to LOAD. A hand-edited config gets the same
 * refusal the interview does.
 *
 * With `enabled = false` NOTHING below the early return is checked, so a
 * half-filled table that is switched off really is a draft — it cannot wedge
 * daemon startup. The whole validation set fires the moment the operator
 * flips the switch.
 */
export function parseEscalation(raw: Record<string, any>): EscalationConfig {
  const rawRules = Array.isArray(raw.rules) ? (raw.rules as Record<string, any>[]) : [];
  const cfg: EscalationConfig = {
    ...ESCALATION_DEFAULTS,
    ...(raw as Partial<EscalationConfig>),
    targets: (Array.isArray(raw.targets) ? raw.targets : [])
      .map((t: unknown) => String(t).trim().replace(/^@/, ""))
      .filter(Boolean),
    rules: rawRules.map((r) => ({
      ...ESCALATION_RULE_DEFAULTS,
      ...r,
      to: String(r.to ?? "")
        .trim()
        .replace(/^@/, ""),
      name: String(r.name ?? "").trim(),
      why: String(r.why ?? "").trim(),
      paths: (Array.isArray(r.paths) ? r.paths : [])
        .map((p: unknown) => String(p).trim())
        .filter(Boolean),
      labels: (Array.isArray(r.labels) ? r.labels : [])
        .map((l: unknown) => String(l).trim())
        .filter(Boolean),
      failing_checks: (Array.isArray(r.failing_checks) ? r.failing_checks : [])
        .map((c: unknown) => String(c).trim())
        .filter(Boolean),
      min_severity: String(r.min_severity ?? "")
        .trim()
        .toUpperCase() as EscalationRule["min_severity"],
    })),
  };
  // Switched off is a draft — checked FIRST, before any shape rule, because
  // "draft" has to mean it. Nothing below
  // this line is read while the feature is off, so a half-written rule an
  // operator is still thinking about must not wedge daemon startup. Every one
  // of these checks fires the moment they flip `enabled = true`, and the
  // onboarding step runs the real parser over the text it is about to write,
  // so a draft is never a way to smuggle a broken live config past validation.
  if (!cfg.enabled) return cfg;
  if (cfg.shape !== "comment" && cfg.shape !== "review_request") {
    throw new Error(
      `config.toml [escalation]: shape must be "comment" or "review_request" (got ${JSON.stringify(cfg.shape)})`,
    );
  }
  if (!Number.isInteger(cfg.max_per_pr) || cfg.max_per_pr < 1) {
    throw new Error(
      `config.toml [escalation]: max_per_pr must be a positive integer (got ${JSON.stringify(cfg.max_per_pr)})`,
    );
  }
  for (const t of cfg.targets) {
    if (!ESCALATION_LOGIN_RE.test(t)) {
      throw new Error(
        `config.toml [escalation]: targets entry ${JSON.stringify(t)} is not a GitHub login`,
      );
    }
  }
  const seenNames = new Set<string>();
  for (const r of cfg.rules) {
    if (!r.name) throw new Error("config.toml [[escalation.rules]]: every rule needs a `name`");
    if (seenNames.has(r.name))
      throw new Error(
        `config.toml [[escalation.rules]]: duplicate rule name ${JSON.stringify(r.name)}`,
      );
    seenNames.add(r.name);
    if (r.min_severity && !ESCALATION_SEVERITY_FLOORS.includes(r.min_severity)) {
      throw new Error(
        `config.toml [[escalation.rules]] ${r.name}: min_severity must be P0, P1, P2 or P3 (got ${JSON.stringify(r.min_severity)})`,
      );
    }
    if (r.paths.length + r.labels.length + r.failing_checks.length === 0 && !r.min_severity) {
      throw new Error(
        `config.toml [[escalation.rules]] ${r.name}: declares no condition — it could never fire`,
      );
    }
    if (!r.why)
      throw new Error(
        `config.toml [[escalation.rules]] ${r.name}: needs a \`why\` saying why this person`,
      );
  }
  if (cfg.targets.length === 0) {
    throw new Error(
      "config.toml [escalation]: enabled = true with no `targets` — escalation on with nobody to escalate to is not a configuration",
    );
  }
  if (cfg.rules.length === 0 && !cfg.session_judgement) {
    throw new Error(
      "config.toml [escalation]: enabled = true with no rules and session_judgement = false — nothing could ever escalate",
    );
  }
  for (const r of cfg.rules) {
    if (!cfg.targets.includes(r.to)) {
      throw new Error(
        `config.toml [[escalation.rules]] ${r.name}: to = ${JSON.stringify(r.to)} is not in [escalation] targets — every escalation target is declared once, in one place`,
      );
    }
  }
  return cfg;
}

/**
 * [owner] — the system's ONE accountable human, as a configured role. Every
 * identity surface renders from here: Slack fallback prose,
 * the companion day-open role label, the pinned-memory head framing, and the
 * escalation-mention fallback. Empty values degrade to neutral wording
 * ("the owner" / "the operator"), never to a hardcoded personal name.
 */
export interface OwnerConfig {
  /** Display name for rendered prose. "" ⇒ neutral wording. */
  name: string;
  /**
   * Slack member id (U…). When [slack] is enabled it must be non-empty and a
   * key of [slack.users]. Legacy alias on INPUT only: a set
   * `[slack] legacy_owner_slack_id` feeds this when it is empty; nothing reads the
   * legacy key after load.
   */
  slack_id: string;
  /** GitHub login; the fallback for [review] escalation_mention_default when
   * that knob is unset. */
  github_login: string;
}

export const OWNER_DEFAULTS: OwnerConfig = {
  name: "",
  slack_id: "",
  github_login: "",
};

/** Per-model spend rates, keyed by bare model id (e.g. "gpt-6-sol"). */
export interface ModelPricing {
  input_per_mtok: number;
  output_per_mtok: number;
}

/** [models] — role models plus the tiered pass-model scheme. */
export interface ModelsConfig {
  default: string;
  conversation: string;
  /** PassTier → full model spec ("provider/model:thinking"). */
  tiers: Record<PassTier, string>;
  /** Passes always run at sol-high, single variant, not raisable. */
  risk_passes: string[];
  /** The tier pass-validate runs at — never raised to the round's highest
   * lens tier, because a validity veto is a `doubted` mark, not a deletion.
   * Only the profile's `min_tier` for the validator moves it, and only
   * upward. */
  validate_tier: PassTier;
  /** Diffs under this many changed lines start at terra-med (heuristics). */
  small_diff_lines: number;
  /** Spend rates keyed by bare model id; consumed by spend accounting. */
  pricing: Record<string, ModelPricing>;
  /** ONE reasoning-effort setting for the whole review (`""` = off: every
   * role and tier keeps the level its own spec names). When set, the thinking
   * suffix of EVERY model spec above — default, conversation and all
   * three tiers — is replaced: `low` → `:low`, `medium` → `:medium`, `high` →
   * the model's highest level (`effort_max`). Applied once, at parse time, so
   * every consumer (sessions, the agents build, the bench) sees the same
   * specs. */
  effort: ReviewEffort;
  /** The level `effort = "high"` means — the highest a model accepts. pi
   * 0.87.1 (and 0.99.1, also for gpt-6.1-sol) lists `minimal…high, xhigh, max` for gpt-6-sol (model catalog,
   * VERIFY-ON-PIN); a model that tops out lower needs this set to its own
   * ceiling. */
  effort_max: ThinkingLevel;
  /** Per-lens tier pins (`[models.pass_tiers]`): pass name → tier.
   * A pinned lens runs at that tier on every PR whatever the diff size — the
   * plan names that tier, the lens is not raisable, and every built variant
   * of it carries that tier's spec. The default is `DEFAULT_PASS_TIERS`
   * (baseline, sweep, behaviour-delta at sol-high); a config entry replaces
   * a lens's default pin. Not
   * for pass-validate (its knob is `validate_tier`) nor for a risk pass
   * (always sol-high). A profile `min_tier` still floors a pin, and the
   * validator never follows a pinned lens's tier. */
  pass_tiers: Record<string, PassTier>;
  /** Per-lens MODEL overrides (`[models.pass_models]`): pass name →
   * model spec. Every built variant of that lens runs on that model, at the
   * thinking level it would otherwise have had (its tier, a pin, the
   * profile's `effort`) unless the spec names its own. Empty by default — a
   * benchmark lever (a smaller model for the quality lenses) until measured.
   * Never for pass-validate nor a risk pass. */
  pass_models: Record<string, string>;
}

/** pi's thinking levels, ascending (pi 0.87.1, unchanged at 0.99.1 and 1.0.0 — VERIFY-ON-PIN). */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** `[models] effort` — `""` leaves every spec as written. */
export type ReviewEffort = "" | "low" | "medium" | "high";

/** "provider/model:thinking" → its model and its pi thinking level, or a
 * null level when the spec carries no suffix. */
export function splitModelSpec(spec: string): { model: string; thinking: string | null } {
  const m = new RegExp(`^(.+):(${THINKING_LEVELS.join("|")})$`).exec(spec);
  return m ? { model: m[1] as string, thinking: m[2] as string } : { model: spec, thinking: null };
}

/** Replace (or add) the `:thinking` suffix of one model spec. */
export function withThinking(spec: string, level: ThinkingLevel): string {
  return `${splitModelSpec(spec).model}:${level}`;
}

/** The thinking level an effort setting names: `high` is the model's
 * ceiling (`[models] effort_max`) — the one reading of `[models] effort`, a
 * lens's profile `effort` and `[scan] effort` alike. */
export function effortLevel(
  effort: Exclude<ReviewEffort, "">,
  effortMax: ThinkingLevel,
): ThinkingLevel {
  return effort === "high" ? effortMax : effort;
}

/** Apply `[models] effort` to every spec the review runs on. Pure. */
export function applyReviewEffort(models: ModelsConfig): ModelsConfig {
  if (models.effort === "") return models;
  const level = effortLevel(models.effort, models.effort_max);
  const tiers = Object.fromEntries(
    Object.entries(models.tiers).map(([t, spec]) => [t, withThinking(spec, level)]),
  ) as Record<PassTier, string>;
  return {
    ...models,
    default: withThinking(models.default, level),
    conversation: withThinking(models.conversation, level),
    tiers,
  };
}

export function parseEffort(raw: unknown): ReviewEffort {
  const v = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (v === "") return "";
  const effort = normalizeEffort(v);
  if (effort !== null) return effort;
  throw new Error(`config.toml [models] effort must be "", "low", "medium" or "high" (got "${v}")`);
}

/** The nonempty effort vocabulary every effort knob shares — `low`,
 * `medium` (alias `med`) and `high`, case- and space-insensitive — or null for
 * anything else. What an empty value means is each knob's own call. */
export function normalizeEffort(raw: unknown): "low" | "medium" | "high" | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (v === "low" || v === "medium" || v === "high") return v;
  return v === "med" ? "medium" : null;
}

function parseEffortMax(raw: unknown): ThinkingLevel {
  const v = String(raw ?? "max")
    .trim()
    .toLowerCase();
  if ((THINKING_LEVELS as readonly string[]).includes(v) && v !== "off") return v as ThinkingLevel;
  throw new Error(`config.toml [models] effort_max must be a pi thinking level (got "${v}")`);
}

/**
 * The shipped per-lens tier pins (measured: high effort on these lenses found
 * more defects with no high-severity loss, for ~18% more cost per PR). The
 * three lenses that read the whole diff line by line run at
 * the `sol-high` tier — gpt-6.1-sol at high effort — on every PR; every other
 * lens keeps its planned tier. A config's own `[models.pass_tiers]` entry for
 * one of them replaces its pin (e.g. `"pass-baseline" = "sol-med"`), and a
 * profile lowers its thinking with `[lenses.<pass>] effort = "medium"`.
 */
export const DEFAULT_PASS_TIERS: Readonly<Record<string, PassTier>> = Object.freeze({
  "pass-baseline": "sol-high",
  "pass-sweep": "sol-high",
  "pass-behaviour-delta": "sol-high",
});

/** `[engine] lens_pass_deadline_min` when the file does not set it: a
 * healthy pass takes 20-100 s and the slowest about 4 min, so 8 min only
 * ever cuts a stalled one. */
export const DEFAULT_LENS_PASS_DEADLINE_MIN = 8;

/** `[engine] lens_cache_stagger_ms`'s default — every reader's fallback too
 * (`src/engine/lens/env.ts` keeps the env reader's copy, pinned equal by a
 * test). */
export const DEFAULT_LENS_CACHE_STAGGER_MS = 2500;

/** `[engine] lens_max_concurrency` when the file does not set it: the
 * companion's desktop number. */
export const DEFAULT_LENS_MAX_CONCURRENCY = 4;

/** `[engine] lens_cache_group` when the file does not set it. */
export const DEFAULT_LENS_CACHE_GROUP = 5;

/** What hosts a pi session (`[engine] runtime`): the pi SDK, in-process
 * (src/engine/sdkruntime.ts), the one adapter. The `proc` runtime, pi as a
 * child process, is retired and refused (`parseEngine`). A route that has no
 * SDK host yet refuses `sdk` (src/engine/select.ts). */
export type EngineRuntimeKind = "sdk";
export const ENGINE_RUNTIME_KINDS: readonly EngineRuntimeKind[] = ["sdk"];

/** Who launches the lenses (`[pi] lens_runtime`): `engine`, our lens tool and
 * discovery wave, the only kind. pi's own subagent glue (`native`) is retired
 * and refused (`parsePiLensRuntime`). */
export type LensRuntimeKind = "engine";
export const LENS_RUNTIME_KINDS: readonly LensRuntimeKind[] = ["engine"];

/** `[engine]`: which runtime hosts pi sessions, and how its lens tool runs the
 * passes (the width, the shared prompt cache and the per-pass deadline that
 * `[pi] subagent_*` used to carry). */
export interface EngineConfig {
  runtime: EngineRuntimeKind;
  /** Process-wide cap on a round's concurrently running lens sessions
   * (rides the lens tool's env as QCR_SUBAGENT_MAX_CONCURRENCY). */
  lens_max_concurrency: number;
  /** Lens sessions share a provider PROMPT CACHE in groups of this many (one
   * pi session id, the provider's cache key, per group); 0 ⇒ a random id per
   * session, which gets no cache hits. */
  lens_cache_group: number;
  /** How long a group's later sessions wait after its first one started, so
   * the cache is written before they ask. */
  lens_cache_stagger_ms: number;
  /** Per-pass deadline in minutes: a pass still running at the deadline is
   * aborted and retried ONCE with a fresh deadline, and a second timeout fails
   * that pass alone. 0 ⇒ no deadline. */
  lens_pass_deadline_min: number;
}

export const ENGINE_DEFAULTS: EngineConfig = {
  runtime: "sdk",
  lens_max_concurrency: DEFAULT_LENS_MAX_CONCURRENCY,
  lens_cache_group: DEFAULT_LENS_CACHE_GROUP,
  lens_cache_stagger_ms: DEFAULT_LENS_CACHE_STAGGER_MS,
  lens_pass_deadline_min: DEFAULT_LENS_PASS_DEADLINE_MIN,
};

/** The `[pi]` lens default: the engine's planned wave is on. */
function piLensDefaults(): { lens_runtime: LensRuntimeKind; engine_wave: boolean } {
  return { lens_runtime: "engine", engine_wave: true };
}

/** The `[pi]` keys that moved to `[engine]` and are refused where they stand. */
const RETIRED_PI_KEYS: Readonly<Record<string, string>> = {
  subagent_max_concurrency: "lens_max_concurrency",
  subagent_cache_group: "lens_cache_group",
  subagent_cache_stagger_ms: "lens_cache_stagger_ms",
  subagent_pass_deadline_min: "lens_pass_deadline_min",
};

/** Refuse a value outside a closed set. A typo must not silently become the
 * default runtime. */
function oneOf<T extends string>(where: string, v: unknown, allowed: readonly T[]): T {
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v))
    throw new Error(
      `config.toml ${where} must be one of ${allowed.join(" | ")} (got ${JSON.stringify(v)})`,
    );
  return v as T;
}

export function parseEngine(raw: Record<string, unknown>): EngineConfig {
  const e = { ...ENGINE_DEFAULTS, ...raw };
  if ((e.runtime as unknown) === "proc")
    throw new Error(
      'config.toml [engine] runtime = "proc" is retired: pi runs in-process on the SDK (the one adapter); delete the key or set it to "sdk"',
    );
  const runtime = oneOf("[engine] runtime", e.runtime, ENGINE_RUNTIME_KINDS);
  const whole = (key: keyof EngineConfig, min: number, max: number): number => {
    const v = e[key];
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max)
      throw new Error(
        `config.toml [engine] ${key} must be a whole number ${min}-${max} (got ${JSON.stringify(v)})`,
      );
    return v;
  };
  return {
    runtime,
    lens_max_concurrency: whole("lens_max_concurrency", 1, 64),
    lens_cache_group: whole("lens_cache_group", 0, 1000),
    lens_cache_stagger_ms: whole("lens_cache_stagger_ms", 0, 600_000),
    lens_pass_deadline_min: whole("lens_pass_deadline_min", 0, 240),
  };
}

/** Refuse the `[pi]` keys the lens settings left behind, naming where they went. */
function refuseRetiredPiKeys(pi: Record<string, unknown>): void {
  for (const [key, to] of Object.entries(RETIRED_PI_KEYS))
    if (key in pi)
      throw new Error(
        `config.toml [pi] ${key} is retired with pi's native subagent glue: delete it, and set [engine] ${to} if the default does not suit`,
      );
}

function parsePiLensRuntime<T extends { lens_runtime: unknown; engine_wave: unknown }>(pi: T): T {
  if (pi.lens_runtime === "native")
    throw new Error(
      'config.toml [pi] lens_runtime = "native" is retired: pi\'s own subagent glue is gone and the engine\'s lens tool is the only one; delete the key or set it to "engine"',
    );
  oneOf("[pi] lens_runtime", pi.lens_runtime, LENS_RUNTIME_KINDS);
  if (typeof pi.engine_wave !== "boolean")
    throw new Error(
      `config.toml [pi] engine_wave must be true or false (got ${JSON.stringify(pi.engine_wave)})`,
    );
  // A wave only the engine route can launch: a typo must not run the main
  // session's own launch while the config says the engine's.
  if (pi.engine_wave && pi.lens_runtime !== "engine")
    throw new Error('config.toml [pi] engine_wave = true needs lens_runtime = "engine"');
  return pi;
}

/** Defaults for the tiered [models] knobs — older configs keep parsing. */
export const MODELS_TIER_DEFAULTS: Pick<
  ModelsConfig,
  | "tiers"
  | "risk_passes"
  | "validate_tier"
  | "small_diff_lines"
  | "pricing"
  | "effort"
  | "effort_max"
  | "pass_tiers"
  | "pass_models"
> = {
  pass_tiers: { ...DEFAULT_PASS_TIERS },
  pass_models: {},
  effort: "",
  effort_max: "max",
  tiers: {
    "terra-med": "openai-codex/gpt-6.1-sol:medium",
    "sol-med": "openai-codex/gpt-6.1-sol:medium",
    "sol-high": "openai-codex/gpt-6.1-sol:high",
  },
  risk_passes: ["pass-security", "pass-prod-risk", "pass-data-safety"],
  validate_tier: "sol-high",
  small_diff_lines: 150,
  pricing: {},
};

/** The values `[memory] delivery` takes. */
export const MEMORY_DELIVERY_MODES = ["off", "shadow", "on"] as const;
export type MemoryDelivery = (typeof MEMORY_DELIVERY_MODES)[number];

/**
 * `[scan]`: the companion's whole-repo scan. Read only by the scan
 * engine inside the companion (src/setup/) — nothing on the VM reads it.
 */
export interface ScanConfig {
  /** Stage 1's reasoning level for `pass-scan` (`high` = the model's
   * ceiling, `[models] effort_max`). */
  effort: Exclude<ReviewEffort, "">;
  /** Stage 1's tier — whose model `pass-scan` runs on, at `effort`. */
  tier: PassTier;
  /** Run the scan's SKEPTIC — `pass-validate` in scan mode — over each
   * case's candidates, at the tier of the lens that raised them. ON by
   * default; a profile may switch it off. It sorts every finding into a
   * validity tier — confirmed / likely / doubtful — and kills none: a
   * refuted finding is kept, marked doubtful. Its cost is part of every
   * case's measured price. */
  validator: boolean;
  /** Repo-relative globs never scanned (src/glob.ts), on top of tests,
   * migrations and what no pass reads (lockfiles, binaries, prose). */
  exclude: string[];
  /** Units the first-scan calibration run reads (spread across the size
   * range), before any stage-1 estimate is offered. */
  calibration_units: number;
  /** The calibration run's hard stop — it has no estimate to stop at. */
  calibration_max_usd: number;
  /** Stage-1 cases in flight at once (background subagents). */
  concurrency: number;
  /** One case reads at most this much; a bigger unit splits, name kept. */
  case_max_files: number;
  case_max_lines: number;
  /** Stage 2: a deep lens never measured at a row's tier, effort
   * and validator setting — no other lens measured there either, and no
   * factor learnable from a stage-2 measurement with the validator the other
   * way (stage2.ts `priceStage2Row`) — is priced at stage 1's measured rate
   * times this. A conservative stand-in
   * until the first stage-2 run measures the real one; the hard stop holds
   * whatever it says. */
  unmeasured_rate_factor: number;
  /** How hard the scan looks. `standard`: stage 1 is a cheap first look and
   * stage 2 runs only the rows the companion proposes. `deep`: stage 1 names a
   * deep lens for every focus file, every deep lens is told to dig past its
   * row's files, and a stage-2 proposal adds the deterministic FLOOR — every
   * `deep_lenses` lens over every file stage 1 reads. A deep reading is its own
   * coverage: a file read only at `standard` is read again. */
  depth: ScanDepth;
  /** The deep floor's lenses, each a lens a scan may run
   * (`SCAN_DEEP_LENSES`); one the profile switched off is skipped. */
  deep_lenses: string[];
}

/** How hard a scan looks — `[scan] depth`. */
export const SCAN_DEPTHS = ["standard", "deep"] as const;
export type ScanDepth = (typeof SCAN_DEPTHS)[number];

export const SCAN_DEFAULTS: ScanConfig = {
  effort: "low",
  tier: "sol-med",
  validator: true,
  exclude: [],
  calibration_units: 3,
  calibration_max_usd: 3,
  concurrency: 8,
  case_max_files: 30,
  case_max_lines: 3000,
  unmeasured_rate_factor: 4,
  depth: "standard",
  deep_lenses: [...SCAN_DEEP_FLOOR_LENSES],
};

/** The `[scan]` keys a repo profile may override — what is about THIS repo
 * (how hard to look, whether to validate, what is not worth reading), never
 * the install's operating limits. */
export const SCAN_PROFILE_KEYS = [
  "effort",
  "tier",
  "validator",
  "exclude",
  "depth",
  "deep_lenses",
] as const;

/**
 * Validate one `[scan]` table — config.toml's (every key) or a profile's
 * (`SCAN_PROFILE_KEYS` only). Returns just the keys it set; an unknown key or
 * a bad value throws naming `where`.
 */
export function parseScanTable(
  where: string,
  raw: unknown,
  allowed: readonly string[] = Object.keys(SCAN_DEFAULTS),
): Partial<ScanConfig> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${where} [scan] must be a table`);
  }
  const out: Partial<ScanConfig> = {};
  const fail = (key: string, what: string, v: unknown): never => {
    throw new Error(`${where} [scan] ${key} ${what} (got ${JSON.stringify(v)})`);
  };
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!allowed.includes(key)) {
      throw new Error(`${where} [scan] unknown key "${key}" — allowed here: ${allowed.join(", ")}`);
    }
    switch (key) {
      case "effort": {
        const e = normalizeEffort(v);
        if (e) out.effort = e;
        else fail(key, 'must be "low", "medium" or "high"', v);
        break;
      }
      case "tier":
        if (typeof v === "string" && (PASS_TIER_ORDER as readonly string[]).includes(v))
          out.tier = v as PassTier;
        else fail(key, `must be one of ${PASS_TIER_ORDER.join(", ")}`, v);
        break;
      case "validator":
        if (typeof v === "boolean") out.validator = v;
        else fail(key, "must be true or false", v);
        break;
      case "exclude": {
        if (!Array.isArray(v)) fail(key, "must be an array of globs", v);
        for (const g of v as unknown[]) {
          const problem = globProblem(g);
          if (problem !== null) fail(key, `entry ${JSON.stringify(g)} ${problem}`, v);
        }
        out.exclude = [...(v as string[])];
        break;
      }
      case "calibration_max_usd":
        if (typeof v === "number" && Number.isFinite(v) && v > 0) out.calibration_max_usd = v;
        else fail(key, "must be a positive number of dollars", v);
        break;
      case "unmeasured_rate_factor":
        if (typeof v === "number" && Number.isFinite(v) && v >= 1) out.unmeasured_rate_factor = v;
        else fail(key, "must be a number of at least 1", v);
        break;
      case "depth":
        if (typeof v === "string" && (SCAN_DEPTHS as readonly string[]).includes(v))
          out.depth = v as ScanDepth;
        else fail(key, `must be ${SCAN_DEPTHS.map((d) => `"${d}"`).join(" or ")}`, v);
        break;
      case "deep_lenses": {
        if (!Array.isArray(v) || v.length === 0)
          fail(key, "must be a non-empty array of lens names", v);
        for (const l of v as unknown[]) {
          if (typeof l !== "string" || !SCAN_DEEP_LENSES.includes(l))
            fail(
              key,
              `entry ${JSON.stringify(l)} is not a lens a scan can run (one of: ${SCAN_DEEP_LENSES.join(", ")})`,
              v,
            );
        }
        out.deep_lenses = [...new Set(v as string[])];
        break;
      }
      default: {
        // The integer knobs.
        if (typeof v === "number" && Number.isInteger(v) && v >= 1) {
          (out as Record<string, unknown>)[key] = v;
        } else fail(key, "must be a positive integer", v);
      }
    }
  }
  return out;
}

/** The `[scan]` keys that say where a run is driven, not how it scans. */
export const SCAN_SANDBOX_KEYS = ["sandbox", "pihome_volume", "image"] as const;

/** `[scan]` from config.toml: the defaults, overlaid by what it sets. The
 * sandbox keys are parsed apart (`parseScanSandbox`). */
export function parseScan(raw: unknown): ScanConfig {
  const table =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? Object.fromEntries(
          Object.entries(raw as Record<string, unknown>).filter(
            ([k]) => !(SCAN_SANDBOX_KEYS as readonly string[]).includes(k),
          ),
        )
      : (raw ?? {});
  return { ...SCAN_DEFAULTS, ...parseScanTable("config.toml", table) };
}

/** A key the table must have: its value, or a throw naming it. */
export function req(obj: Record<string, unknown>, key: string): unknown {
  const v = obj[key];
  if (v === undefined) throw new Error(`config.toml: missing key '${key}'`);
  return v;
}

/** The overseer session is gone (P9.13): its two knobs are still ACCEPTED so a
 * live config does not break, read by nothing, and named here once at parse. */
export function configDeprecations(raw: Record<string, any>): string[] {
  const out: string[] = [];
  if (raw.models?.overseer !== undefined)
    out.push(
      "config.toml [models] overseer is deprecated and ignored: the overseer session was deleted. Remove the key.",
    );
  if (raw.daemon?.overseer_rotation_days !== undefined)
    out.push(
      "config.toml [daemon] overseer_rotation_days is deprecated and ignored: the overseer session was deleted. Remove the key.",
    );
  return out;
}

export function parseModels(
  raw: Record<string, any>,
  presetEffort: ReviewEffort = "",
): ModelsConfig {
  return applyReviewEffort({
    // `[models] effort` set explicitly wins over the preset's level.
    effort: raw.effort !== undefined ? parseEffort(raw.effort) : presetEffort,
    effort_max: parseEffortMax(raw.effort_max),
    default: String(req(raw, "default")),
    conversation: String(req(raw, "conversation")),
    tiers: {
      ...MODELS_TIER_DEFAULTS.tiers,
      ...((raw.tiers ?? {}) as Partial<Record<PassTier, string>>),
    },
    risk_passes: (raw.risk_passes ?? MODELS_TIER_DEFAULTS.risk_passes) as string[],
    validate_tier: (raw.validate_tier ?? MODELS_TIER_DEFAULTS.validate_tier) as PassTier,
    small_diff_lines: Number(raw.small_diff_lines ?? MODELS_TIER_DEFAULTS.small_diff_lines),
    pricing: (raw.pricing ?? {}) as Record<string, ModelPricing>,
    pass_tiers: { ...DEFAULT_PASS_TIERS, ...((raw.pass_tiers ?? {}) as Record<string, PassTier>) },
    pass_models: { ...((raw.pass_models ?? {}) as Record<string, string>) },
  });
}

/**
 * Validate the per-lens knobs — `[review] skip_lenses`,
 * `[review] validate_consequence_rule`, `[models.pass_tiers]` and
 * `[models.pass_models]`. Called by
 * `parseConfig` and again by the bench's `--config` overrides (which write
 * past the parser), so both routes refuse the same things.
 */
export function validateLensKnobs(cfg: Pick<CoreConfig, "review" | "models">): void {
  const known = new Set(ALL_PASSES);
  const skip: unknown = cfg.review.skip_lenses ?? [];
  if (!Array.isArray(skip) || skip.some((s) => typeof s !== "string"))
    throw new Error(
      `config.toml [review] skip_lenses must be an array of pass names (got ${JSON.stringify(skip)})`,
    );
  for (const s of skip as string[]) {
    if (s === "pass-validate")
      throw new Error(
        "config.toml [review] skip_lenses may not name pass-validate — switch the validator off in the profile ([lenses.pass-validate] enabled = false)",
      );
    if (!known.has(s)) throw new Error(`config.toml [review] skip_lenses: unknown pass "${s}"`);
  }
  if (
    cfg.review.validate_consequence_rule !== undefined &&
    typeof cfg.review.validate_consequence_rule !== "boolean"
  )
    throw new Error(
      `config.toml [review] validate_consequence_rule must be true or false (got ${JSON.stringify(cfg.review.validate_consequence_rule)})`,
    );
  if (!(PASS_TIER_ORDER as readonly unknown[]).includes(cfg.models.validate_tier))
    throw new Error(
      `config.toml [models] validate_tier: unknown tier ${JSON.stringify(cfg.models.validate_tier)} (one of ${PASS_TIER_ORDER.join(", ")})`,
    );
  const pins: unknown = cfg.models.pass_tiers ?? {};
  if (typeof pins !== "object" || pins === null || Array.isArray(pins))
    throw new Error("config.toml [models.pass_tiers] must be a table of pass = tier");
  const risk = new Set(cfg.models.risk_passes ?? []);
  if (risk.has("pass-validate"))
    throw new Error(
      "config.toml [models] risk_passes may not name pass-validate — use validate_tier",
    );
  for (const [pass, tier] of Object.entries(pins as Record<string, unknown>)) {
    if (!known.has(pass))
      throw new Error(`config.toml [models.pass_tiers]: unknown pass "${pass}"`);
    if (pass === "pass-validate")
      throw new Error(
        "config.toml [models.pass_tiers] may not pin pass-validate — use [models] validate_tier",
      );
    if (risk.has(pass))
      throw new Error(
        `config.toml [models.pass_tiers]: ${pass} is a risk pass (always sol-high) — remove it from [models] risk_passes first`,
      );
    if (!(PASS_TIER_ORDER as readonly unknown[]).includes(tier))
      throw new Error(
        `config.toml [models.pass_tiers] ${pass}: unknown tier ${JSON.stringify(tier)} (one of ${PASS_TIER_ORDER.join(", ")})`,
      );
  }
  const moved: unknown = cfg.models.pass_models ?? {};
  if (typeof moved !== "object" || moved === null || Array.isArray(moved))
    throw new Error("config.toml [models.pass_models] must be a table of pass = model spec");
  for (const [pass, model] of Object.entries(moved as Record<string, unknown>)) {
    if (!known.has(pass))
      throw new Error(`config.toml [models.pass_models]: unknown pass "${pass}"`);
    if (pass === "pass-validate")
      throw new Error(
        "config.toml [models.pass_models] may not move pass-validate — the validator's model is its tier's",
      );
    if (risk.has(pass))
      throw new Error(
        `config.toml [models.pass_models]: ${pass} is a risk pass — it always runs on the sol-high tier's model`,
      );
    if (typeof model !== "string" || !/^[\w.-]+\/[\w.:-]+$/.test(model))
      throw new Error(
        `config.toml [models.pass_models] ${pass}: ${JSON.stringify(model)} is not a "provider/model[:thinking]" spec`,
      );
  }
}

/** Full model spec ("provider/model:thinking") for a pass tier. */
export function tierModel(cfg: Pick<CoreConfig, "models">, tier: PassTier): string {
  return cfg.models.tiers[tier];
}

/** `[pi]`: the pinned pi and where its sessions live, and who launches a
 * round's lenses. */
export interface PiConfig {
  package: string;
  version: string;
  session_dir: string;
  /** Who launches a round's lenses: `engine`, our lens tool and discovery
   * wave on an SDK session, the only kind. */
  lens_runtime: LensRuntimeKind;
  /** `lens_runtime = engine` only: the round's engine starts the planned
   * discovery wave itself at round start (rule 9) and the main session joins
   * it through `lens_wave`. On by default with `lens_runtime = engine`; off:
   * the main session launches the wave, with the same tools. */
  engine_wave: boolean;
}

/**
 * The review config: the sections of config.toml the review core reads. The
 * app's `Config` (src/config.ts) extends it with every other surface's, so
 * whatever takes a `CoreConfig` takes the daemon's config as it is.
 */
export interface CoreConfig {
  dry_run: boolean;
  /** The selected profile's resolved per-lens tuning
   * (`[lenses.<pass>]` in profile.toml, src/lenstuning.ts). config.toml never
   * sets it: `applyProfileTuning` overlays it after parsing, which is what
   * makes the profile win over config.toml, the preset and the defaults.
   * Absent or empty ⇒ untuned. */
  lenses?: LensTuningMap;
  /** The selected profile's posting policy (`[posting]` in profile.toml,
   * src/postingpolicy.ts), overlaid by `applyProfilePosting`. Absent ⇒ the
   * default posting behaviour; an all-default policy is never attached. */
  posting?: PostingPolicy;
  github: GithubConfig;
  models: ModelsConfig;
  engine: EngineConfig;
  pi: PiConfig;
  guards: GuardsConfig;
  review: ReviewConfig;
  escalation: EscalationConfig;
  owner: OwnerConfig;
  /** The whole-repo scan's defaults. The repo profile's `[scan]`
   * table overrides the keys in `SCAN_PROFILE_KEYS` (`applyProfileScan`,
   * src/profiles.ts) — the profile wins, as for per-lens tuning. */
  scan: ScanConfig;
}

/** `[github]`: base_branch/clone_dir default so older configs keep parsing.
 * `secrets_dir` is as written; the reader that needs the secrets locates
 * them (src/homes.ts `locateSecrets`). */
export function parseGithubSection(raw: Record<string, any>): GithubConfig {
  return {
    base_branch: "main",
    clone_dir: "",
    ...(req(raw, "github") as Partial<GithubConfig>),
  } as GithubConfig;
}

/** The `[github]` keys every config names. */
const REQUIRED_GITHUB_KEYS = [
  "repo",
  "app_slug",
  "bot_login",
  "review_team",
  "trigger_label",
  "in_progress_label",
  "reviewed_label",
  "improvement_label",
  "issue_label",
] as const;

/** Refuse a `[github]` table that leaves out a key every config names. */
export function requireGithubKeys(github: GithubConfig): void {
  for (const k of REQUIRED_GITHUB_KEYS) req(github as unknown as Record<string, unknown>, k);
}

/** `[review] preset`. It shapes both [models] (reasoning level) and [review]
 * (the levers), so it is read before either is parsed. */
export function presetOf(raw: Record<string, any>): ReviewPreset {
  return parsePreset((raw.review as Record<string, unknown> | undefined)?.preset);
}

/** `[pi]`, with the lens runtime defaulted and checked and the retired keys refused. */
export function parsePiSection(raw: Record<string, any>): PiConfig {
  const pi = req(raw, "pi") as Record<string, unknown>;
  refuseRetiredPiKeys(pi);
  return parsePiLensRuntime({
    ...piLensDefaults(),
    ...(pi as Omit<PiConfig, "lens_runtime" | "engine_wave"> &
      Partial<Pick<PiConfig, "lens_runtime" | "engine_wave">>),
  });
}

/** `[guards]` over its defaults. */
export function parseGuardsSection(raw: Record<string, any>): GuardsConfig {
  return { ...GUARDS_DEFAULTS, ...((raw.guards ?? {}) as Partial<GuardsConfig>) };
}

/** `[owner]` over its defaults (the legacy Slack alias folds in later,
 * `foldLegacyOwnerSlackId`). */
export function parseOwnerSection(raw: Record<string, any>): OwnerConfig {
  return { ...OWNER_DEFAULTS, ...((raw.owner ?? {}) as Partial<OwnerConfig>) };
}

/** `[review]`. [review.directives] merges under its own spread so a partial
 * table extends the defaults instead of clobbering the sibling keys. The
 * preset fills every lever the file does not set itself; an explicit key
 * always wins, so `preset = "max"` + `sweep = false` means exactly that. */
export function parseReviewSection(raw: Record<string, any>, preset: ReviewPreset): ReviewConfig {
  return {
    ...REVIEW_DEFAULTS,
    ...REVIEW_PRESETS[preset].levers,
    ...((raw.review ?? {}) as Partial<ReviewConfig>),
    preset,
    directives: {
      ...REVIEW_DIRECTIVES_DEFAULTS,
      ...(((raw.review as Record<string, any> | undefined)?.directives ??
        {}) as Partial<ReviewDirectivesConfig>),
    },
  };
}

/** The checks on a parsed `[review]` (and the per-lens knobs), run once the
 * whole config is built. */
export function validateReviewSection(cfg: Pick<CoreConfig, "review" | "models">): void {
  validateLensKnobs(cfg);
  const shards = cfg.review.validator_shards;
  if (!Number.isInteger(shards) || shards < 1 || shards > 4) {
    throw new Error(
      `config.toml [review]: validator_shards must be an integer 1-4 (got ${JSON.stringify(shards)})`,
    );
  }
  if (typeof cfg.review.loosened_test_hint !== "boolean") {
    throw new Error(
      `config.toml [review]: loosened_test_hint must be true or false (got ${JSON.stringify(cfg.review.loosened_test_hint)})`,
    );
  }
  if (typeof cfg.review.coverage_check !== "boolean") {
    throw new Error(
      `config.toml [review]: coverage_check must be true or false (got ${JSON.stringify(cfg.review.coverage_check)})`,
    );
  }
  if (typeof cfg.review.dedup_merge !== "boolean") {
    throw new Error(
      `config.toml [review]: dedup_merge must be true or false (got ${JSON.stringify(cfg.review.dedup_merge)})`,
    );
  }
  if (cfg.review.follow_up !== "delta" && cfg.review.follow_up !== "full") {
    throw new Error(
      `config.toml [review]: follow_up must be "delta" or "full" (got ${JSON.stringify(cfg.review.follow_up)})`,
    );
  }
  {
    const ratio = cfg.review.follow_up_max_delta_ratio;
    if (!(typeof ratio === "number" && Number.isFinite(ratio) && ratio > 0 && ratio <= 1)) {
      throw new Error(
        `config.toml [review]: follow_up_max_delta_ratio must be a number in (0, 1] (got ${JSON.stringify(ratio)})`,
      );
    }
  }
  if (typeof cfg.review.follow_up_sweep !== "boolean") {
    throw new Error(
      `config.toml [review]: follow_up_sweep must be true or false (got ${JSON.stringify(cfg.review.follow_up_sweep)})`,
    );
  }
  {
    const n = cfg.review.follow_up_post_approval_sweep_lines;
    if (!(typeof n === "number" && Number.isInteger(n) && n >= 0)) {
      throw new Error(
        `config.toml [review]: follow_up_post_approval_sweep_lines must be a whole number >= 0 (got ${JSON.stringify(n)})`,
      );
    }
  }
  {
    const n = cfg.review.baseline_split_lines;
    if (!(typeof n === "number" && Number.isInteger(n) && n >= 0)) {
      throw new Error(
        `config.toml [review]: baseline_split_lines must be a whole number >= 0 (got ${JSON.stringify(n)})`,
      );
    }
  }
  if (
    cfg.review.sweep_light_tier !== "" &&
    !(PASS_TIER_ORDER as readonly unknown[]).includes(cfg.review.sweep_light_tier)
  ) {
    throw new Error(
      `config.toml [review]: sweep_light_tier must be "" or a tier (${PASS_TIER_ORDER.join(", ")}) (got ${JSON.stringify(cfg.review.sweep_light_tier)})`,
    );
  }
  if (cfg.review.follow_up_extent !== "session" && cfg.review.follow_up_extent !== "rules") {
    throw new Error(
      `config.toml [review]: follow_up_extent must be "session" or "rules" (got ${JSON.stringify(cfg.review.follow_up_extent)})`,
    );
  }
  if (typeof cfg.review.validate_compact !== "boolean") {
    throw new Error(
      `config.toml [review]: validate_compact must be true or false (got ${JSON.stringify(cfg.review.validate_compact)})`,
    );
  }
  if (cfg.review.context_pack !== "off" && cfg.review.context_pack !== "pack-first") {
    throw new Error(
      `config.toml [review]: context_pack must be "off" or "pack-first" (got ${JSON.stringify(cfg.review.context_pack)})`,
    );
  }
  for (const [key, n, min] of [
    ["[review] context_pack_max_tokens", cfg.review.context_pack_max_tokens, 1000],
  ] as const) {
    if (!(typeof n === "number" && Number.isInteger(n) && n >= min))
      throw new Error(
        `config.toml ${key} must be a whole number >= ${min} (got ${JSON.stringify(n)})`,
      );
  }
  {
    const n = cfg.review.follow_up_small_delta_lines;
    if (!(typeof n === "number" && Number.isInteger(n) && n >= 0)) {
      throw new Error(
        `config.toml [review]: follow_up_small_delta_lines must be a whole number >= 0 (got ${JSON.stringify(n)})`,
      );
    }
  }
  if (cfg.review.nits !== "strict" && cfg.review.nits !== "open") {
    throw new Error(
      `config.toml [review]: nits must be "strict" or "open" (got ${JSON.stringify(cfg.review.nits)})`,
    );
  }
}

/** Legacy alias: a set `[slack] legacy_owner_slack_id` feeds [owner] slack_id when
 * that is empty; a conflicting pair is an error that names the NEW key. After
 * this fold nothing reads the legacy key. */
export function foldLegacyOwnerSlackId(raw: Record<string, any>, owner: OwnerConfig): void {
  const legacyOwnerSlackId = String(
    (raw.slack as Record<string, any> | undefined)?.legacy_owner_slack_id ?? "",
  ).trim();
  if (legacyOwnerSlackId) {
    if (!owner.slack_id.trim()) {
      owner.slack_id = legacyOwnerSlackId;
    } else if (owner.slack_id.trim() !== legacyOwnerSlackId) {
      throw new Error(
        "config.toml: legacy [slack] legacy_owner_slack_id and [owner] slack_id are both set and differ — set `[owner] slack_id` only",
      );
    }
  }
}

/**
 * The review sections of a config.toml, parsed and checked exactly as the
 * whole-file parser (`parseConfig`, src/config.ts) parses them. The other
 * sections are not read, so a file that only names the review's sections is
 * a whole review config. `[github] secrets_dir` stays as written. `warn`
 * hears each deprecated key once.
 */
export function parseCoreConfig(
  toml: string,
  opts: { warn?: (line: string) => void } = {},
): CoreConfig {
  const raw = parse(toml) as Record<string, any>;
  for (const line of configDeprecations(raw)) opts.warn?.(`[quickreviewd] ${line}`);
  const github = parseGithubSection(raw);
  const preset = presetOf(raw);
  const engine = parseEngine((raw.engine ?? {}) as Record<string, unknown>);
  const cfg: CoreConfig = {
    dry_run: Boolean(req(raw, "dry_run")),
    github,
    models: parseModels(req(raw, "models") as Record<string, any>, REVIEW_PRESETS[preset].effort),
    engine,
    pi: parsePiSection(raw),
    guards: parseGuardsSection(raw),
    review: parseReviewSection(raw, preset),
    escalation: parseEscalation((raw.escalation ?? {}) as Record<string, any>),
    owner: parseOwnerSection(raw),
    scan: parseScan(raw.scan),
  };
  validateReviewSection(cfg);
  foldLegacyOwnerSlackId(raw, cfg.owner);
  requireGithubKeys(cfg.github);
  return cfg;
}
