// Typed access to config.toml — the single source of every runtime knob.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import {
  locateConfig,
  locateSecrets,
  missingConfigMessage,
  strandedCheckoutConfig,
} from "./install.js";
import { globProblem } from "./glob.js";
import type { LensTuningMap } from "./lenstuning.js";
import type { PostingPolicy } from "./postingpolicy.js";
import { ALL_PASSES } from "./passes.js";
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
  /** Always an absolute-or-given path after parse: an empty (or the old
   * default `~/.config/quickreview-bot`) value is resolved by the install
   * locator to `<config home>/secrets` (the old dir itself is never
   * read). A value the operator set is taken as given. */
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

/** Directory name of the base clone: `[github] clone_dir` when set, else the
 * repo slug's basename ("owner/name" → "name"; a URL's trailing path segment,
 * `.git` stripped), e.g. "acme/webapp" ⇒ "webapp". */
export function githubCloneDir(g: GithubConfig): string {
  // ?? "": hand-rolled test configs predating omit both keys.
  const explicit = (g.clone_dir ?? "").trim();
  if (explicit) return explicit;
  const tail = (g.repo ?? "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .split("/")
    .pop();
  return tail || "repo";
}

/**: where the daemon container lives relative to the TUI. `"ssh"` is
 * the VM topology (every remote op rides `ssh <ssh_host> …`); `"local"` is the
 * laptop topology (the SAME commands run against local docker directly, and no
 * ssh process is ever spawned). Always explicit — never inferred from a magic
 * ssh_host value. */
export type TuiTarget = "ssh" | "local";

export interface TuiConfig {
  /** Transport for every TUI remote op (see TuiTarget). Default "ssh". */
  target: TuiTarget;
  /** ssh alias of the box running the container. Ignored when target = "local". */
  ssh_host: string;
  container: string;
  remote_state_dir: string;
  remote_sandbox_root: string;
  sudo_docker: boolean;
  poll_interval_s: number;
  /** DATA STALE banner when status.json's written_at ages past this — sized
   * to the daemon's ~30s write cadence, not the TUI's fetch cadence. */
  stale_after_s: number;
  msg_timeout_s: number;
  /** Per-remote-read budget for the finished-round evidence copier.
   * Every artefact fetch is killed at this age, so a wedged ssh control master
   * costs one sweep and nothing else — never the poll, never the paint loop. */
  evidence_timeout_s: number;
  /** L1: the evidence sweep's pace — the minimum gap between the end of
   * one `qcr why` exec and the start of the next (each costs the container
   * ~0.5–1 s of CPU), whatever the poll cadence. Clamped to 5–600 s
   * (`evidenceWhyIntervalMs`, src/tui/evidence.ts); the pacing cannot be
   * switched off. */
  evidence_why_interval_s: number;
}

/** The local companion container. Host paths are expanded; empty
 * strings mean "derive from the sandbox root" at parse time. */
export interface CompanionConfig {
  /** `qcr tui` starts the companion unless this is off or --no-companion. */
  enabled: boolean;
  container_name: string;
  image: string;
  /** Named volume for the companion's own pihome (OAuth, sessions, memory). */
  pihome_volume: string;
  /** tmux session name inside the container. */
  session: string;
  model: string;
  /** Host path of the review-sandbox repo → /workspace (rw). */
  repo_dir: string;
  /** Host path of the issue tracker → /tracker (rw, actor `companion`). */
  tracker_dir: string;
  /** Host path of the tracker's protocol docs → /tracker-docs (READ-ONLY).
   * Sits outside `tracker_dir`, so it needs its own mount: without it the
   * companion drives wayfinder from a summary instead of the real adapter. */
  tracker_docs_dir: string;
  /** Host path of the REVIEWED repo → /reviewed-repo (a generic container
   * path), READ-ONLY. The companion reads the code a review is about; it
   * can never write to it, and rule 8's boundary is otherwise unchanged (no
   * GitHub, no gate, no deploy.sh, no VM credential). A missing checkout
   * simply drops the mount — under-equipped, never broken. */
  reviewed_repo_dir: string;
  /** Host dir the TUI copies finished-round evidence into → /evidence,
   * READ-ONLY. The companion reads transcripts, ledgers, prompts and
   * verdicts as plain files; it gains NO ssh, no credential and no new reach —
   * the TUI holds the VM access and does all the fetching. Read-only because
   * this is a RECORD: the companion reads history, it never rewrites it.
   * Empty ⇒ `<sandbox root>/evidence` (gitignored); the default lives outside
   * the repo because the store grows without bound and is kept indefinitely. */
  evidence_dir: string;
  /** Host dir the TUI writes ambient snapshots into → /feed. */
  feed_dir: string;
  /** Host dir the companion writes alert files into → /alerts. */
  alerts_dir: string;
  /** Host ssh config dir mounted read-only (VM reads + inject). */
  ssh_dir: string;
  /** Docker build context for the companion image (auto-built when missing). */
  build_context: string;
  // --- watcher knobs. C1 seeds sane defaults; C2 owns the full set. ---
  /** A round overdue by more than this is worth waking the operator for. */
  overdue_grace_min: number;
  /** status.json older than this counts as a stale-daemon alert. */
  stale_alert_s: number;
  /** A PR sitting in awaiting_author longer than this is nag-worthy. */
  awaiting_age_h: number;
  /** Minimum gap between two alerts about the same subject. */
  cooldown_min: number;
}

/** [backfill] — knobs for the one-shot GitHub history importer.
 * Every default is derived from [github] at parse time; the section exists so
 * a re-run against a renamed label/identity needs no code change. */
export interface BackfillConfig {
  /** Review author to import (GraphQL `reviews(author:)`, with the [bot] suffix). */
  bot_login: string;
  /** The same identity as a timeline *actor* — GraphQL drops the [bot] suffix. */
  bot_actor: string;
  /** Label whose presence marks a PR as part of the bot-review era. */
  reviewed_label: string;
  /** Label a human adds to request a review — a trigger candidate. */
  trigger_label: string;
  /** Label the bot adds when a round starts — the fallback trigger candidate. */
  in_progress_label: string;
  /** Team slug whose review request is a trigger (bare slug, no org prefix). */
  review_team_slug: string;
  /** Per-PR detail queries in flight at once (kept small on purpose). */
  concurrency: number;
  /** Search pages per enumeration query (100 hits each; search caps at 1,000). */
  max_search_pages: number;
}

// ---- [slack] — the Slack concierge ------------------------------
// TOKENS ARE NEVER IN CONFIG. `bot_token_file` / `app_token_file` name flat
// files under [github].secrets_dir, read the way every other secret is
// (PiSessionManager.secret / TokenMinter): the config carries the file NAME.

/** One announcement cause: may it speak at all, and how often. */
export interface SlackCausePolicy {
  enabled: boolean;
  /** 0 = no cooldown (every occurrence fires). */
  cooldown_min: number;
}

export interface SlackPolicyConfig {
  /** Channel-wide model turns per policy day (RATIFIED at 80). */
  daily_turns: number;
  /** Per-person model turns per policy day (RATIFIED at 20). */
  per_user_daily_turns: number;
  /** Daemon posts into any ONE thread per policy day. */
  thread_replies_per_day: number;
  /** Author ping-pong courtesy limit before the bot goes quiet in-thread. */
  soft_exchange_limit: number;
  /** Rolling-hour ceiling on announcements (they bypass turn caps, not this). */
  announcements_per_hour: number;
  /** Cooldown for a cause with no explicit [slack.policy.causes] entry. */
  default_cooldown_min: number;
  /** The day boundary for every cap here — DST-correct via src/eod.ts. */
  timezone: string;
  pickup_grace_min: number;
  downtime_notice_min: number;
  heartbeat_interval_min: number;
  storm_corrections: number;
  awaiting_author_stale_h: number;
  /** RATIFIED "never": verdicts stay in-thread, never reply_broadcast. */
  broadcast_verdicts: "never" | "always";
  causes: Record<string, SlackCausePolicy>;
}

export interface SlackConfig {
  enabled: boolean;
  /** The ONE channel id the concierge lives in; empty ⇒ cannot enable. */
  channel: string;
  channel_kind: "public" | "private";
  /** File name under [github].secrets_dir holding the xoxb- bot token. */
  bot_token_file: string;
  /** File name under [github].secrets_dir holding the xapp- socket token. */
  app_token_file: string;
  post_min_interval_ms: number;
  reconnect_backoff_ms: number[];
  server_ping_timeout_ms: number;
  catchup_max_age_s: number;
  max_reply_chars: number;
  name_cache_ttl_s: number;
  /** Slack member id → GitHub login. The ONLY source of own-PR rights. */
  users: Record<string, string>;
  policy: SlackPolicyConfig;
}

/** Per-cause defaults. Absent causes fall back to `default_cooldown_min`. */
export const SLACK_CAUSE_DEFAULTS: Record<string, SlackCausePolicy> = {
  "round.overdue": { enabled: true, cooldown_min: 60 },
  "round.malformed_verdict": { enabled: true, cooldown_min: 60 },
  "review.failed_loud": { enabled: true, cooldown_min: 60 },
  "pr.not_picked_up": { enabled: true, cooldown_min: 120 },
  "daemon.up": { enabled: true, cooldown_min: 0 },
  "daemon.stopping": { enabled: true, cooldown_min: 0 },
  "slack.cap_reached": { enabled: true, cooldown_min: 0 },
  "reconcile.storm": { enabled: false, cooldown_min: 180 },
  "digest.eod": { enabled: false, cooldown_min: 0 },
  "pr.awaiting_author_stale": { enabled: false, cooldown_min: 1440 },
};

export const SLACK_POLICY_DEFAULTS: SlackPolicyConfig = {
  daily_turns: 80,
  per_user_daily_turns: 20,
  thread_replies_per_day: 6,
  soft_exchange_limit: 3,
  announcements_per_hour: 20,
  default_cooldown_min: 60,
  // Effective value comes from [slack.policy] timezone, else [ops] timezone
  // (parseSlack) — this static default (= OPS_DEFAULTS.timezone, declared
  // below) only reaches direct constructions that bypass parseConfig.
  timezone: "UTC",
  pickup_grace_min: 20,
  downtime_notice_min: 5,
  heartbeat_interval_min: 5,
  storm_corrections: 5,
  awaiting_author_stale_h: 48,
  broadcast_verdicts: "never",
  causes: SLACK_CAUSE_DEFAULTS,
};

/** [slack] is optional in config.toml, exactly like [tui] / [companion]. */
export const SLACK_DEFAULTS: SlackConfig = {
  enabled: false,
  channel: "",
  channel_kind: "public",
  bot_token_file: "slack_bot_token",
  app_token_file: "slack_app_token",
  post_min_interval_ms: 1100,
  reconnect_backoff_ms: [1000, 2000, 5000, 15000, 30000],
  server_ping_timeout_ms: 30000,
  catchup_max_age_s: 300,
  max_reply_chars: 3000,
  name_cache_ttl_s: 86400,
  users: {},
  policy: SLACK_POLICY_DEFAULTS,
};

/**
 * [guards] — the posting-time guards. Every one is ON by default:
 * each answers a documented incident from the predecessor system, and a knob
 * exists only so a guard can be taken out of the path deliberately, in one
 * place, rather than by editing the gate.
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
  /** A head with ZERO check-runs also withholds approval (the owner,
   * 2026-08-19): in a CI-running repo that is a conflicted PR or CI that has
   * not started — no execution evidence. Off by default so a repo with no CI
   * at all is never wedged (the original `none` exemption). */
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
 * [recheck] — the post-approval delta recheck. One knob per trigger,
 * so a noisy trigger can be taken out of the path deliberately, in one place.
 * All on: the uphold-by-default design is what makes the broad set affordable.
 */
export interface RecheckConfig {
  enabled: boolean;
  /** A push landing after an approve — the core case. */
  on_push: boolean;
  /** CI completing at the approved head; an adverse conclusion is evidence. */
  on_ci: boolean;
  /** The base branch moving under an approved PR (the noisiest by far). */
  on_base_advance: boolean;
}

export const RECHECK_DEFAULTS: RecheckConfig = {
  enabled: true,
  on_push: true,
  on_ci: true,
  on_base_advance: true,
};

/**
 * [review] — review-content knobs. Distinct from [guards] (posting-
 * time refusals) and [recheck] (post-approval triggers): these shape what a
 * review says, not whether it posts.
 */
/**
 * [review.directives] — EXTENSIONS to the first-party directive-path
 * vocabulary (`src/severity.ts DEFAULT_DIRECTIVE_VOCABULARY`). Extend-only by
 * design: config ADDS names, nothing can remove a built-in — dropping, say,
 * `CLAUDE.md` would silently re-enable auto-blocking on first-party directive
 * edits, drifting's ratified behaviour by config typo. The shape
 * mirrors `severity.ts DirectiveVocabularyExtras`.
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

export interface ReviewConfig {
  /**
   * Fallback @-mention for the first-party-directive escalation comment when
   * git history yields no attributable human author login for the touched
   * directive files. "" ⇒ the comment renders without an @ (addressed to
   * "a maintainer") — it still posts.
   */
  escalation_mention_default: string;
  /**
   * Repo profile: names a directory under `profiles/` — the
   * install's config home first, then the checkout's generic examples
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
   * plan alone (the pre-2026-09 behaviour). */
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
  /**: over this many changed lines (heuristics.ts
   * `baselineSplitLines` — the sweep's sizing: prose half, lockfiles,
   * generated and vendored files nothing) pass-baseline is planned as 2–3
   * rows, each STARTING from one group of the change's files with the whole
   * PR as its charter (heuristics.ts `baselineGroups`). 0 ⇒ never: one row,
   * as before. At 2000 only the largest live PRs split (2026-10-09 study:
   * 2,600–3,000-line PRs, where the lone baseline row ran 500 s and set the
   * round's critical path); every PR under it plans byte-identically. */
  baseline_split_lines: number;
  /** The loosened-test hint (src/loosenedtests.ts, owner decision
   * 2026-10-03): weakened assertions in the PR's test files are found
   * deterministically and named in pass-tests' plan reason; their presence
   * also plans pass-tests. Off ⇒ the reason and the plan are as before. */
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
  /**: the tests lens (`agents/pass-tests.md`) on every PR that
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
   * killing it for a small consequence (`validate-demote-not-kill`, 2026-09-27).
   * On by default; off reproduces the earlier validator for a benchmark. */
  validate_demote: boolean;
  /** Passes never planned and never addable this round (cost tuning,
   * 2026-09-29). `[]` (the default) plans every lens selection picks. Names
   * must be known passes; `pass-validate` is refused here — switching the
   * validator off is the profile's `enabled = false`. Not a preset
   * lever. */
  skip_lenses: string[];
  /** The validator's consequence rules (`validate-consequence-rule`,
   * 2026-09-29): intent/contract appeals, dead code, CI-enabled lint rules and
   * merges judged by consequence. Off by default; opt-in for a benchmark arm. */
  validate_consequence_rule: boolean;
  /** Review latency levers (bench/aacr/PERF.md §6, 2026-10-02). None changes
   * which lenses run or what they are asked; each removes serial time.
   *
   * `wide_lens_fanout`: a batched `tasks:[…]` lens launch runs as wide as
   * `[pi] subagent_max_concurrency`, not native pi's in-call four
   * (extensions/subagents.ts, `QCR_SUBAGENT_WIDE_FANOUT`). */
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
   * candidates (by file); 1 = one validator, the pre-2026-10 shape. */
  validator_shards: number;
  /** `dedup_merge` (docs/duplicate-merge.md): candidates are grouped
   * deterministically before the validator (the `cluster_findings` tool,
   * src/dedup.ts), the validator judges each group as one root cause or
   * splits it, and a post-check at render time merges two posted findings
   * that are one root cause posted twice. Off ⇒ every round order, built
   * agent and rendered review is byte-identical to before. */
  dedup_merge: boolean;
  /** `coverage_check` (src/coverage.ts, 2026-10-03): after the lenses
   * return, every changed non-test source file no lens raised a finding on
   * gets a targeted pass-sweep row (at most two, packed by line budget), each
   * saying why. Off ⇒ the round order renders exactly as before. */
  coverage_check: boolean;
  /** `follow_up` (docs/follow-up-rounds.md): `"delta"` ⇒ every round
   * after the first is a FOLLOW-UP round — prior findings verified, the
   * PR-owned change since the last reviewed head reviewed, one pre-approval
   * sweep when owed — falling back to today's full re-review on any doubt.
   * `"full"` ⇒ every later round is today's full re-review, byte for byte. */
  follow_up: "delta" | "full";
  /** Above this share of the PR's diff lines (additions + deletions), the
   * delta is too large to be worth a follow-up round: the round runs in full. */
  follow_up_max_delta_ratio: number;
  /** false ⇒ a follow-up round never plans the pre-approval sweep. */
  follow_up_sweep: boolean;
  /** After a POSTED approval the sweep is owed only when the PR-owned change
   * since it reaches this many lines (additions + deletions); 0 ⇒ never.
   * Measured 2026-10-09: the post-approval blockers live re-reviews
   * found outside the change sat behind 618–1204-line pushes, while 47 of
   * the 69 post-approval rounds changed fewer than 500 lines. */
  follow_up_post_approval_sweep_lines: number;
  /** A follow-up delta of at most this many lines (additions + deletions)
   * gets a LEAN plan: no per-file pass-sweep rows (pass-baseline reads a small
   * change whole) and the quality and style lenses offered as addable instead
   * of planned (they judged the PR in round 1; on a fix push they mostly
   * re-raise nits). 0 ⇒ never lean. Measured 2026-10-09: a
   * follow-up round's time tracks its agent count, and 138-line deltas were
   * fanning out to 15–20 agents. */
  follow_up_small_delta_lines: number;
}

export type NitPolicy = "strict" | "open";

/**
 * `[review] preset` — three named review configurations, measured on the
 * defect benchmark (bench/aacr/RESULTS.md, 2026-09-27):
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

/** The lean lever plan — `default` and `low` share it. */
const LEAN_LEVERS: PresetLevers = {
  sublenses: true,
  sweep: true,
  sweep_max_groups: 6,
  sweep_group_files: 5,
  sweep_group_lines: 500,
  sweep_wide_files: 40,
  behaviour_delta: true,
  behaviour_delta_max_groups: 3,
  loosened_test_hint: true,
  intent_min_words: 60,
  placement_min_code_files: 8,
  placement_min_new_file_lines: 30,
  dependency_sources: true,
  tests_lens: true,
  quality_lenses: true,
  quality_min_added_lines: 20,
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
};

/**
 * [escalation] — the optional, OFF-BY-DEFAULT escalation feature (,
 * ratified 2026-08-31; rule-10 amendment).
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

const ESCALATION_SEVERITY_FLOORS: readonly string[] = ["P0", "P1", "P2", "P3"];
const ESCALATION_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/**
 * Parse and VALIDATE `[escalation]`.
 *
 * The half-configured state the ticket forbids is made unrepresentable here
 * rather than only in the wizard: a config with the feature on and no target,
 * or with a rule pointing at a login that is not a target, or with a rule that
 * declares no condition, fails to LOAD. A hand-edited config gets the same
 * refusal the interview does.
 *
 * With `enabled = false` NOTHING below the early return is checked, so a
 * half-filled table that is switched off really is a draft — it cannot wedge
 * daemon startup, which it could before the review caught it. The
 * whole validation set fires the moment the operator flips the switch.
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
  // SWITCHED OFF IS A DRAFT — and that is checked FIRST, before any shape
  // rule, because "draft" has to mean it (review, F8). Nothing below
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
 * [owner] — the system's ONE accountable human, as a configured role
 *. Every identity surface renders from here: Slack fallback prose,
 * the companion day-open role label, the pinned-memory head framing, and the
 * escalation-mention fallback. Empty values degrade to neutral wording
 * ("the owner" / "the operator"), never to a hardcoded personal name.
 */
export interface OwnerConfig {
  /** Display name for rendered prose. "" ⇒ neutral wording. */
  name: string;
  /**
   * Slack member id (U…). When [slack] is enabled it must be non-empty and a
   * key of [slack.users] — the rules that used to bind `legacy_owner_slack_id`.
   * Legacy alias on INPUT only: a set `[slack] legacy_owner_slack_id` feeds this
   * when it is empty; nothing reads the legacy key after load.
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

/** [models] — role models plus the tiered pass-model scheme (replaces the
 * old per-pass [models.passes] override map). */
export interface ModelsConfig {
  default: string;
  conversation: string;
  overseer: string;
  /** PassTier → full model spec ("provider/model:thinking"). */
  tiers: Record<PassTier, string>;
  /** Passes always run at sol-high, single variant, not raisable. */
  risk_passes: string[];
  /** The tier pass-validate runs at (amended): no longer
   * raised to the round's highest lens tier — a validity veto is a `doubted`
   * mark now, not a deletion. Only the profile's `min_tier` for the validator
   * moves it, and only upward. */
  validate_tier: PassTier;
  /** Diffs under this many changed lines start at terra-med (heuristics). */
  small_diff_lines: number;
  /** Spend rates keyed by bare model id; consumed by spend accounting. */
  pricing: Record<string, ModelPricing>;
  /** ONE reasoning-effort setting for the whole review (`""` = off: every
   * role and tier keeps the level its own spec names). When set, the thinking
   * suffix of EVERY model spec above — default, conversation, overseer and all
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
  /** Per-lens tier pins (`[models.pass_tiers]`, 2026-09-29): pass name → tier.
   * A pinned lens runs at that tier on every PR whatever the diff size — the
   * plan names that tier, the lens is not raisable, and every built variant
   * of it carries that tier's spec. The default is `DEFAULT_PASS_TIERS`
   * (baseline, sweep, behaviour-delta at sol-high); a config entry replaces
   * a lens's default pin. Not
   * for pass-validate (its knob is `validate_tier`) nor for a risk pass
   * (always sol-high). A profile `min_tier` still floors a pin, and the
   * validator never follows a pinned lens's tier. */
  pass_tiers: Record<string, PassTier>;
}

/** pi's thinking levels, ascending (pi 0.87.1, unchanged at 0.99.1 and 1.0.0 — VERIFY-ON-PIN). */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** `[models] effort` — `""` leaves every spec as written. */
export type ReviewEffort = "" | "low" | "medium" | "high";

/** Replace (or add) the `:thinking` suffix of one model spec. */
export function withThinking(spec: string, level: ThinkingLevel): string {
  const m = new RegExp(`^(.+):(${THINKING_LEVELS.join("|")})$`).exec(spec);
  return `${m ? (m[1] as string) : spec}:${level}`;
}

/** Apply `[models] effort` to every spec the review runs on. Pure. */
export function applyReviewEffort(models: ModelsConfig): ModelsConfig {
  if (models.effort === "") return models;
  const level: ThinkingLevel = models.effort === "high" ? models.effort_max : models.effort;
  const tiers = Object.fromEntries(
    Object.entries(models.tiers).map(([t, spec]) => [t, withThinking(spec, level)]),
  ) as Record<PassTier, string>;
  return {
    ...models,
    default: withThinking(models.default, level),
    conversation: withThinking(models.conversation, level),
    overseer: withThinking(models.overseer, level),
    tiers,
  };
}

function parseEffort(raw: unknown): ReviewEffort {
  const v = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (v === "") return "";
  if (v === "low" || v === "high") return v;
  if (v === "med" || v === "medium") return "medium";
  throw new Error(`config.toml [models] effort must be "", "low", "medium" or "high" (got "${v}")`);
}

function parseEffortMax(raw: unknown): ThinkingLevel {
  const v = String(raw ?? "max")
    .trim()
    .toLowerCase();
  if ((THINKING_LEVELS as readonly string[]).includes(v) && v !== "off") return v as ThinkingLevel;
  throw new Error(`config.toml [models] effort_max must be a pi thinking level (got "${v}")`);
}

/**
 * The shipped per-lens tier pins (owner decision 2026-10-03, after the
 * decisions validation: the same 30 PRs at default vs high effort gave +6
 * AACR defects, +3 medium on the miss set, no high-severity loss, for +18%
 * cost per PR). The three lenses that read the whole diff line by line run at
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
> = {
  pass_tiers: { ...DEFAULT_PASS_TIERS },
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

/**
 * OpenViking (github.com/volcengine/OpenViking) — the context store the daemon
 * runs as a SECOND process inside the container, on loopback :1933.
 *
 * Three invariants live in this block rather than in prose:
 *
 *   * `version` + `llama_cpp_python_version` are the TRIPLE-MIRRORED pins —
 *     this block == `deploy/ansible/group_vars/all.yml` == the Dockerfile venv
 *     layer, exactly like the `[pi]` pin. `tests/openviking.test.ts` fails on
 *     drift, and the running server's self-reported version is drift-checked
 *     against `version` in the heartbeat.
 *   * `host` is loopback and the port is NEVER published out of the container
 *     (the playbook's `published_ports` carries only the webhook port).
 *   * every path here is a CONTAINER path; on a dev PC the binary is absent,
 *     which the supervisor treats as "unavailable", not as a crash loop.
 */
export interface OpenVikingConfig {
  /** Off ⇒ the supervisor is never constructed and status.json says so. */
  enabled: boolean;
  /** The pinned server version (mirror 1 of 3). */
  version: string;
  /** Pinned llama-cpp-python: an OPTIONAL extra openviking does not declare,
   * without which the default local dense embedder raises
   * EmbeddingConfigurationError at startup (verified against 0.4.15). */
  llama_cpp_python_version: string;
  /** Upstream base commit of the vendored pi extension. Pinned beside the
   * server version so `tests/openviking-fork.test.ts` gates drift instead of
   * letting a bump rebase silently onto new upstream behaviour. */
  extension_commit: string;
  /** OpenViking user the daemon and review sessions act as. Their key is
   * confined to this user server-side — that confinement is what keeps
   * companion memory out of a posted review. */
  user: string;
  /** Tenant account; empty ⇒ derived from the key. */
  account: string;
  /** Secret FILE NAME under [github].secrets_dir holding the reviewer USER
   * key. Never an ADMIN or ROOT key: ADMIN grants no cross-user data access
   * and can list every user key in plaintext. */
  reviewer_key_file: string;
  /** ov.conf `server.auth_mode`. `api_key` is the ratified posture:
   * every request carries a USER key the server CONFINES to its own tree, and
   * that confinement is the only thing keeping companion memory out of a
   * posted review. `dev` bypasses authentication entirely — it is a local
   * development escape hatch, never the deployed value. MIRRORED into
   * `deploy/ansible/group_vars/all.yml` (`openviking_auth_mode`), which the
   * entrypoint template renders; `tests/openviking.test.ts` and the
   * `scripts/deploy.sh` preflight both fail on drift. */
  auth_mode: string;
  /** Secret FILE NAME under the container's secrets mount holding the
   * server's OWN root key — the credential ov.conf needs to run in `api_key`
   * mode and to mint users at boot. It is the server's, never a client's: no
   * daemon surface, no review session and no companion process ever reads it
   * (`writeOvcliConf` refuses it as a session credential and the bash guard
   * refuses to read the files that hold it). Mirrored as
   * `openviking_root_key_file`. */
  root_key_file: string;
  /** The OpenViking users boot provisioning ENSURES exist — created if
   * absent, left exactly as they are if present. Never rotated: a rotation
   * would orphan the keys already distributed to the companion's PC. Mirrored
   * as `openviking_provision_users` (comma-joined). */
  provision_users: string[];
  request_timeout_ms: number;
  /** Tighter than `request_timeout_ms`: a search sits on the round-build
   * path, where the deadline in [memory] is the real guard. 8000 since
   * H3 (was 2500 — shorter than one document embedding on the live
   * VM). Clamped to `SEARCH_TIMEOUT_BOUNDS_MS`; a seed that sent its search
   * late passes its time left, and the search takes the shorter. */
  search_timeout_ms: number;
  /** Where an entry lands when the writer names no category. */
  default_category: string;
  read_cache_ttl_ms: number;
  host: string;
  port: number;
  /** `openviking-server` inside the image's venv. */
  bin: string;
  /** `~/.openviking` is symlinked here at boot — it must sit on the state
   * volume so memory survives an image rebuild. */
  home: string;
  /** Empty ⇒ `<home>/ov.conf` (the path the boot template writes). */
  config_file: string;
  /** Empty ⇒ `<home>/workspace` (ov.conf `storage.workspace`). */
  workspace: string;
  /** ov.conf `server.workers` — one worker on a 2-CPU cap. */
  workers: number;
  /** ov.conf `queue_workers.*.max_concurrent` — reduced from the shipped
   * defaults (4/4/8) for the same 2-CPU cap — and, since S3,
   * `embedding.max_concurrent` too (the server's default is 10). */
  queue_concurrency: number;
  /** Health-poll cadence; the heartbeat reports the CACHED sample, so
   * status.json writing never waits on the network. */
  health_interval_s: number;
  /** The supervisor's `/health` + `/ready` probe and the local embedder's
   * `/health` probe. `/ready` runs an embedding, so it queues behind a case
   * batch's embeddings: 6000 since H3 (was 2000; ~28 `/ready` flaps
   * on 2026-10-08, one of which tipped memory health degraded). It is the
   * timeout behind memory health's "serving" half (`memoryServing`). Clamped
   * to `HEALTH_TIMEOUT_BOUNDS_MS`. */
  health_timeout_ms: number;
  /** Restart backoff ladder; the last entry is the ceiling. The supervisor
   * never gives up — a memory engine that stays down is worse than a slow
   * retry, and every call site already degrades memory-less. */
  restart_backoff_ms: number[];
  /** A child that stayed up this long resets the backoff ladder. */
  restart_reset_after_s: number;
  /** Which embedder memory runs (S4). `local` is the shipped
   * default: the LOCAL ENGLISH EMBEDDER (`LOCAL_EMBEDDING`) — a loopback
   * service inside the container, so no memory text leaves the machine.
   * `openai` is the explicit hosted opt-in and needs `embedding_key_file` in
   * the secrets dir. Mirrored as `openviking_embedding_provider`. This is the
   * operator's word, not ov.conf's: under `local` the entrypoint renders
   * ov.conf's OpenAI-COMPATIBLE provider with `api_base` on loopback
   * (`ovConfEmbedder`). */
  embedding_provider: EmbeddingProvider;
  /** ov.conf `embedding.dense.model` / `.dimension`. Under `local` they are
   * the local embedder's model and its fixed dimension (`LOCAL_EMBEDDING`);
   * under `openai` the operator names the hosted model and its dimension. */
  embedding_model: string;
  embedding_dimension: number;
  /** Secrets-dir file name of the HOSTED embeddings credential — deliberately
   * NOT `openai_api_key` (pi's model credential), so the two can be set
   * independently. Read only by the ov.conf render, only under `openai`. */
  embedding_key_file: string;
  /** The local embedder's MODEL FILE pin (S4, rule 7): the GGUF the
   * image downloads at BUILD time from `local_embedder_url`, verified against
   * `local_embedder_sha256` there and again by the service at every start.
   * TRIPLE-MIRRORED like `version`: this block == group_vars
   * (`openviking_local_embedder_*`) == both Dockerfiles' model layer —
   * `tests/openviking.test.ts`, `tests/docker-daemon.test.ts` and the
   * `scripts/deploy.sh` preflight refuse on drift. The file's basename is
   * `<LOCAL_EMBEDDING.model>.gguf`; the image carries the file whatever the
   * provider, so a hosted opt-in can come back to local without a rebuild. */
  local_embedder_file: string;
  local_embedder_url: string;
  local_embedder_sha256: string;
  /** The service listens on 127.0.0.1 at this port — never published; ov.conf's
   * `api_base` names it. Mirrored as `openviking_local_embedder_port`. */
  local_embedder_port: number;
  /** llama.cpp threads for the service. One is the budget the model was chosen
   * on (~25 ms for a round's context query): the container has two CPUs and a
   * review round to run. Mirrored as `openviking_local_embedder_threads`. */
  local_embedder_threads: number;
}

export const EMBEDDING_PROVIDERS = ["local", "openai"] as const;
export type EmbeddingProvider = (typeof EMBEDDING_PROVIDERS)[number];

/**
 * The LOCAL ENGLISH EMBEDDER (S4, the owner's ruling R5): the model
 * `embedding_provider = "local"` runs, served on loopback by
 * `scripts/openviking-embedder.py` from the GGUF the image pins. Chosen by an
 * offline retrieval evaluation over the reviewer's own memory
 * (docs/memory-embeddings.md: MRR@10 0.56 against 0.34 for the engine's
 * built-in Chinese-first model; ~25 ms per round query on one thread). The
 * service's model table (`--describe`) carries the same name and dimension
 * plus the query instruction; `tests/openviking-embedder.test.ts` holds the
 * two together. Mirrored by `LOCAL_EMBEDDER` in scripts/openviking-reembed.mjs.
 */
export const LOCAL_EMBEDDING = Object.freeze({ model: "bge-small-en-v1.5-f16", dimension: 384 });
/** The engine's BUILT-IN local embedder — what `local` meant from until
 * S4, and what every store embedded in that time was built under. A
 * config.toml that still spells it under `local` (the previous release
 * REQUIRED exactly this) is read as the current local embedder rather than
 * refused: the daemon must not stop booting over a value it used to demand.
 * The re-embed migration carries the store across. */
export const RETIRED_LOCAL_EMBEDDING = Object.freeze({
  model: "bge-small-zh-v1.5-f16",
  dimension: 512,
});
/** What an `openai` opt-in runs unless the operator names another model. */
export const HOSTED_EMBEDDING = Object.freeze({ model: "text-embedding-3-small", dimension: 1536 });

/** ov.conf's `embedding.dense.provider` under `local`: the engine's OpenAI-
 * COMPATIBLE client — its async embedder — pointed at the loopback service.
 * The wire format, never a destination. */
export const LOCAL_EMBEDDER_WIRE_PROVIDER = "openai";

/** `http://127.0.0.1:<port>/v1` — ov.conf's `api_base` under `local`. */
export function localEmbedderBaseUrl(c: Pick<OpenVikingConfig, "local_embedder_port">): string {
  return `http://127.0.0.1:${c.local_embedder_port}/v1`;
}

/** What ov.conf's `embedding.dense` must say for this config: provider,
 * model and dimension as the ENGINE spells them (the record its vector
 * collection stores), plus the loopback `api_base` under `local`. The
 * daemon's drift check holds the rendered ov.conf to it. */
export interface OvConfEmbedder {
  provider: string;
  model: string;
  dimension: number;
  api_base?: string;
}

export function ovConfEmbedder(
  c: Pick<
    OpenVikingConfig,
    "embedding_provider" | "embedding_model" | "embedding_dimension" | "local_embedder_port"
  >,
): OvConfEmbedder {
  if (c.embedding_provider === "local")
    return {
      provider: LOCAL_EMBEDDER_WIRE_PROVIDER,
      model: c.embedding_model,
      dimension: c.embedding_dimension,
      api_base: localEmbedderBaseUrl(c),
    };
  return {
    provider: c.embedding_provider,
    model: c.embedding_model,
    dimension: c.embedding_dimension,
  };
}

/** [openviking] is optional in config.toml — the defaults ARE the shipped
 * configuration, exactly like [tui]/[companion]. */
/** Round-seeding knobs: how much memory rides each round prompt and
 * how long the daemon is willing to wait for it. Every value is defaulted —
 * an absent `[memory]` block is a supported configuration, and a store that
 * misses the deadline costs the round its context, never the round. */
export interface MemoryConfig {
  /** Token budget for the assembled context block. */
  context_tokens: number;
  /** Deadline for the head + block assembly, after which the round proceeds
   * memory-less. 9000 since H3 (was 3000 — shorter than one document
   * embedding on the live VM); the seed's wait for the case writer's
   * embedding tail is inside it. Clamped to `CONTEXT_TIMEOUT_BOUNDS_MS`. */
  context_timeout_ms: number;
  /** The embedding tail of one written finding case (ms, H3): after
   * a case batch's write returns the server goes on embedding it for about
   * this long a case, and a round seed starting inside that waits for it —
   * within its own `context_timeout_ms`. Clamped to 0…30000; 0 turns the
   * tail off. */
  case_embed_tail_ms: number;
  /** Memory health (S1, `src/memory/health.ts`): how often the
   * daemon's AUTHENTICATED probe lists the reviewer memories root with each
   * credential in use (its key file and the sessions' ovcli.conf). Replaces
   * the per-round `alert_cooldown_min` (an alert that never woke anyone; a
   * leftover key in a live config.toml is ignored). */
  probe_interval_s: number;
  /** No authenticated answer for this long ⇒ `down` (wakes `memory_down`). */
  down_after_min: number;
  /** After boot, a server still warming up reads `unknown`, not degraded,
   * for this long. Never applies to an authentication failure. */
  boot_grace_min: number;
  /** An outage that lasts re-wakes the overseer this often. */
  rewake_h: number;
  /** The TUI files ONE tracker ticket for a memory incident older than this
   * (sourced from status.json, never from memory). */
  incident_ticket_after_min: number;
  /** Writes that stick (S2): how often the backfill pump writes the
   * [feedback] signals memory still owes (at most 20 a tick, only while
   * memory health reads healthy). */
  backfill_interval_s: number;
  /** An owed signal older than this wakes `memory_write_backlog` (and again
   * every `rewake_h` while the backlog lasts). */
  write_backlog_after_min: number;
  /** Finding cases (S7, src/cases.ts): how often the case writer
   * syncs the cases state.db says are owed and, only while memory health
   * reads healthy, writes up to 2 of them (one batch-write, never started
   * while a round reads memory — F2) and backfills two more PRs. */
  cases_interval_s: number;
  /** How far back the case backfill reaches: PRs with a finding posted in
   * the last this-many days get their cases written (resumable, a few PRs a
   * tick, only while memory reads healthy). 0 turns the backfill off. */
  cases_backfill_days: number;
  /** The learner (S8, src/learner/learner.ts). The miner runs this
   * many minutes before the EOD sweep (and on `qcr lessons mine`). */
  lessons_mine_lead_min: number;
  /** How far back a mine reads human outcomes (fates, the feedback ledger,
   * recall sources). */
  lessons_mine_days: number;
  /** No `eod-curation-receipt` this long after the EOD sweep was delivered
   * wakes `eod_curation_missing`. */
  lessons_receipt_wait_min: number;
  /** An offered candidate still undecided this many ops days later EXPIRES —
   * recorded on the row, in an event and in the packet. */
  lessons_expiry_ops_days: number;
  /** At most this many candidates are offered for the FIRST time per EOD
   * packet (misses first); the rest wait for a later one. Carried candidates
   * are never capped. */
  lessons_packet_new_max: number;
  /** A bot-approved merged PR's later commits are read this long after the
   * merge (post-merge recall, read-only git on the base clone). */
  lessons_recall_window_days: number;
  /** The window a cluster's recurrence and counterweight count over. */
  lessons_recurrence_days: number;
  /** The digests whose "Learnings" never reached memory — the one-time
   * backfill into candidates (inclusive, YYYY-MM-DD). */
  lessons_digest_backfill_from: string;
  lessons_digest_backfill_to: string;
  /** How many items the round's context search may draw from each area it
   * searches. Since S5 a round searches `experiences/` ONLY
   * (`ROUND_SEARCH_AREAS`, src/memory/layout.ts): any other key here is
   * ignored with one log line (src/openviking/context.ts
   * `roundSearchQuotas`), and a missing or non-positive `experiences` count
   * takes the default — the search is never left to the server's own balance
   * across every scope (see the comment in config.toml). */
  context_quotas: Record<string, number>;
  /**
   * How curated lessons and past finding cases reach a review (S9):
   *   `off`    — nothing runs: no selection, no shadow ledger;
   *   `shadow` — the SHIPPED value: every round selects lessons and cases
   *              through OpenViking (one bounded prefetch, never delaying the
   *              round) and the shadow ledger records what WOULD have been
   *              delivered and which posted findings a delivered dont-raise
   *              lesson would have touched — and NO prompt, task file or
   *              agent changes;
   *   `on`     — delivery (S9b): the same selection, AWAITED beside the
   *              round's memory seed within the same budget, and rendered —
   *              each lens's task file, the lessons files of the validator
   *              and the lenses a session adds, the main session's "Lessons
   *              in force" index and past-review cases (the bleed rule
   *              reworded), the validator's `lesson-shape` addendum, and the
   *              repo facts for the paths a recheck or an author reply
   *              touches. A round that selects nothing renders as `off`.
   * The owner switches it to `on` after reading `qcr lessons shadow-report`.
   */
  delivery: MemoryDelivery;
  /** The round's ONE lesson prefetch may take at most this long (ms) when the
   * round WAITS for it — under `on` — then whatever arrived is used and every
   * find still out is a recorded timeout. Clamped to 1…2000: the contract's
   * hard ceiling is 2 s. */
  delivery_budget_ms: number;
  /** The same prefetch's budget (ms) when NOTHING waits for it — under
   * `shadow`, where it starts after the round's handoff (F2): looser,
   * so a shadow selection behind a busy embedder still records what it would
   * have delivered. Clamped to 1…20000 — it holds the selector's two places
   * in the embedder queue for at most that long. */
  shadow_budget_ms: number;
}

/** H3: the three memory timeouts are BOUNDED — memory must never
 * hold a round past a budget an operator can read off the config, and a
 * mistyped 0 must not turn every seed memory-less. Inclusive ms. */
export const CONTEXT_TIMEOUT_BOUNDS_MS = { min: 100, max: 15_000 } as const;
export const SEARCH_TIMEOUT_BOUNDS_MS = { min: 100, max: 15_000 } as const;
export const HEALTH_TIMEOUT_BOUNDS_MS = { min: 100, max: 20_000 } as const;
export const CASE_EMBED_TAIL_MAX_MS = 30_000;

/** `v` as an integer inside `bounds`, or `fallback` when it is not a finite
 * number at all. */
function clampMs(v: unknown, bounds: { min: number; max: number }, fallback: number): number {
  const n = typeof v === "number" ? v : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(bounds.min, Math.min(bounds.max, Math.floor(n)));
}

/** The values `[memory] delivery` takes (S9). */
export const MEMORY_DELIVERY_MODES = ["off", "shadow", "on"] as const;
export type MemoryDelivery = (typeof MEMORY_DELIVERY_MODES)[number];
/** The contract's hard ceiling on the lesson prefetch (S9). */
export const LESSON_PREFETCH_MAX_MS = 2000;
/** The shadow prefetch's ceiling and default (F2). The default covers
 * the live VM's measured worst case — a find's 2.5 s p90 behind a case batch
 * already on the embedder (two ~3.4 s embeddings, src/cases.ts). */
export const LESSON_SHADOW_PREFETCH_MAX_MS = 20_000;
export const LESSON_SHADOW_PREFETCH_DEFAULT_MS = 10_000;

/**
 * The [memory] block, defaults filled and the S9 delivery switch checked: an
 * unknown `delivery` value REFUSES to load (a misspelt `"onn"` must not
 * quietly mean shadow, or off), and the prefetch budget is clamped to the
 * contract's ceiling.
 */
export function parseMemory(raw: Record<string, unknown>): MemoryConfig {
  const m = { ...MEMORY_DEFAULTS, ...(raw as Partial<MemoryConfig>) };
  if (!(MEMORY_DELIVERY_MODES as readonly unknown[]).includes(m.delivery))
    throw new Error(
      `[memory] delivery must be one of ${MEMORY_DELIVERY_MODES.map((v) => `"${v}"`).join(", ")} (got ${JSON.stringify(m.delivery)})`,
    );
  const budget = Number(m.delivery_budget_ms);
  m.delivery_budget_ms = Number.isFinite(budget)
    ? Math.max(1, Math.min(LESSON_PREFETCH_MAX_MS, Math.floor(budget)))
    : LESSON_PREFETCH_MAX_MS;
  const shadow = Number(m.shadow_budget_ms);
  m.shadow_budget_ms = Number.isFinite(shadow)
    ? Math.max(1, Math.min(LESSON_SHADOW_PREFETCH_MAX_MS, Math.floor(shadow)))
    : LESSON_SHADOW_PREFETCH_DEFAULT_MS;
  m.context_timeout_ms = clampMs(
    m.context_timeout_ms,
    CONTEXT_TIMEOUT_BOUNDS_MS,
    MEMORY_DEFAULTS.context_timeout_ms,
  );
  m.case_embed_tail_ms = clampMs(
    m.case_embed_tail_ms,
    { min: 0, max: CASE_EMBED_TAIL_MAX_MS },
    MEMORY_DEFAULTS.case_embed_tail_ms,
  );
  return m;
}

export const MEMORY_DEFAULTS: MemoryConfig = {
  context_tokens: 2000,
  context_timeout_ms: 9000,
  case_embed_tail_ms: 4000,
  probe_interval_s: 120,
  down_after_min: 10,
  boot_grace_min: 5,
  rewake_h: 6,
  incident_ticket_after_min: 120,
  backfill_interval_s: 60,
  write_backlog_after_min: 120,
  cases_interval_s: 120,
  cases_backfill_days: 60,
  lessons_mine_lead_min: 15,
  lessons_mine_days: 45,
  lessons_receipt_wait_min: 180,
  lessons_expiry_ops_days: 7,
  lessons_packet_new_max: 40,
  lessons_recall_window_days: 14,
  lessons_recurrence_days: 90,
  lessons_digest_backfill_from: "2026-08-31",
  lessons_digest_backfill_to: "2026-10-02",
  context_quotas: { experiences: 24 },
  delivery: "shadow",
  delivery_budget_ms: LESSON_PREFETCH_MAX_MS,
  shadow_budget_ms: LESSON_SHADOW_PREFETCH_DEFAULT_MS,
};

export const OPENVIKING_DEFAULTS: OpenVikingConfig = {
  enabled: true,
  version: "0.4.15",
  llama_cpp_python_version: "0.3.35",
  extension_commit: "d436baa23c83938b22bb0aab08b0ce48568b5ff4",
  user: "reviewer",
  account: "",
  reviewer_key_file: "openviking_reviewer_key",
  auth_mode: "api_key",
  root_key_file: "openviking_root_key",
  provision_users: ["reviewer", "companion"],
  request_timeout_ms: 10000,
  search_timeout_ms: 8000,
  default_category: "experiences",
  read_cache_ttl_ms: 15000,
  host: "127.0.0.1",
  port: 1933,
  bin: "/opt/openviking/venv/bin/openviking-server",
  home: "/opt/quickreview/state/openviking",
  config_file: "", // → <home>/ov.conf
  workspace: "", // → <home>/workspace
  workers: 1,
  queue_concurrency: 2,
  health_interval_s: 30,
  health_timeout_ms: 6000,
  restart_backoff_ms: [1000, 2000, 5000, 15000, 30000, 60000],
  restart_reset_after_s: 120,
  embedding_provider: "local",
  embedding_model: LOCAL_EMBEDDING.model,
  embedding_dimension: LOCAL_EMBEDDING.dimension,
  embedding_key_file: "openai_embeddings_api_key",
  local_embedder_file: `/opt/openviking/models/${LOCAL_EMBEDDING.model}.gguf`,
  local_embedder_url: `https://huggingface.co/CompendiumLabs/bge-small-en-v1.5-gguf/resolve/d32f8c040ea3b516330eeb75b72bcc2d3a780ab7/${LOCAL_EMBEDDING.model}.gguf`,
  local_embedder_sha256: "f0b2fef971e8366438bfd2d9aefea1b0115919389448806d290237f638bae999",
  local_embedder_port: 1934,
  local_embedder_threads: 1,
};

/**
 * The [openviking] block, defaults filled and the embedder checked.
 *
 * The embedder is validated at LOAD time because the boot validates it too,
 * and a memory engine that refuses to start is a silent outage: an unknown
 * provider, a non-positive dimension, a `local` model/dimension that is not
 * the local embedder's, or a local model-file pin that does not name that
 * model are all config errors here.
 */
export function parseOpenViking(raw: Record<string, unknown>): OpenVikingConfig {
  const merged = { ...OPENVIKING_DEFAULTS, ...(raw as Partial<OpenVikingConfig>) };
  // H3: bounded, never a tight loop or an unbounded wait.
  merged.search_timeout_ms = clampMs(
    merged.search_timeout_ms,
    SEARCH_TIMEOUT_BOUNDS_MS,
    OPENVIKING_DEFAULTS.search_timeout_ms,
  );
  merged.health_timeout_ms = clampMs(
    merged.health_timeout_ms,
    HEALTH_TIMEOUT_BOUNDS_MS,
    OPENVIKING_DEFAULTS.health_timeout_ms,
  );
  // The defaults are the LOCAL embedder: a hosted opt-in that omits the model
  // runs HOSTED_EMBEDDING, never the local model (which no hosted API serves).
  // A named hosted model with no dimension has no default to fall back on.
  if (merged.embedding_provider !== "local") {
    if (raw.embedding_model === undefined) {
      merged.embedding_model = HOSTED_EMBEDDING.model;
      if (raw.embedding_dimension === undefined)
        merged.embedding_dimension = HOSTED_EMBEDDING.dimension;
    } else if (raw.embedding_dimension === undefined) {
      if (merged.embedding_model !== HOSTED_EMBEDDING.model)
        throw new Error(
          `config.toml: [openviking] embedding_model = "${String(merged.embedding_model)}" needs its embedding_dimension set too`,
        );
      merged.embedding_dimension = HOSTED_EMBEDDING.dimension;
    }
  } else if (
    merged.embedding_model === RETIRED_LOCAL_EMBEDDING.model &&
    (raw.embedding_dimension === undefined ||
      merged.embedding_dimension === RETIRED_LOCAL_EMBEDDING.dimension)
  ) {
    // the previous release REQUIRED this spelling under `local`.
    // It now means the local embedder that replaced it — the boot renders the
    // same, and the re-embed migration moves the store across.
    merged.embedding_model = LOCAL_EMBEDDING.model;
    merged.embedding_dimension = LOCAL_EMBEDDING.dimension;
  }
  if (!(EMBEDDING_PROVIDERS as readonly string[]).includes(merged.embedding_provider)) {
    throw new Error(
      `config.toml: [openviking] embedding_provider must be one of ${EMBEDDING_PROVIDERS.join(", ")} (got '${String(merged.embedding_provider)}')`,
    );
  }
  if (!Number.isInteger(merged.embedding_dimension) || merged.embedding_dimension <= 0) {
    throw new Error(
      `config.toml: [openviking] embedding_dimension must be a positive integer (got '${String(merged.embedding_dimension)}')`,
    );
  }
  if (
    merged.embedding_provider === "local" &&
    (merged.embedding_model !== LOCAL_EMBEDDING.model ||
      merged.embedding_dimension !== LOCAL_EMBEDDING.dimension)
  ) {
    throw new Error(
      `config.toml: [openviking] embedding_provider = "local" runs the local English embedder, ${LOCAL_EMBEDDING.model} at ${LOCAL_EMBEDDING.dimension} dims — ` +
        `the only local model the image pins; set embedding_model/embedding_dimension to it, or opt into a hosted provider`,
    );
  }
  if (
    typeof merged.embedding_key_file !== "string" ||
    merged.embedding_key_file.trim() === "" ||
    merged.embedding_key_file.includes("/")
  ) {
    throw new Error(
      "config.toml: [openviking] embedding_key_file must be a bare file name inside the secrets dir",
    );
  }
  checkLocalEmbedderPin(merged);
  return resolveOpenVikingPaths(merged);
}

/** The local embedder's model-file pin and service knobs (S4). The
 * file and the URL must both name `LOCAL_EMBEDDING.model`: a pin for another
 * model would put a file the service's model table does not describe under a
 * name the vector store trusts. */
function checkLocalEmbedderPin(c: OpenVikingConfig): void {
  const gguf = `${LOCAL_EMBEDDING.model}.gguf`;
  const file = c.local_embedder_file;
  if (typeof file !== "string" || !file.startsWith("/") || !file.endsWith(`/${gguf}`)) {
    throw new Error(
      `config.toml: [openviking] local_embedder_file must be an absolute container path ending in /${gguf} (got '${String(file)}')`,
    );
  }
  const url = c.local_embedder_url;
  if (typeof url !== "string" || !url.startsWith("https://") || !url.endsWith(`/${gguf}`)) {
    throw new Error(
      `config.toml: [openviking] local_embedder_url must be an https URL ending in /${gguf} (got '${String(url)}')`,
    );
  }
  if (
    typeof c.local_embedder_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(c.local_embedder_sha256)
  ) {
    throw new Error(
      "config.toml: [openviking] local_embedder_sha256 must be the file's sha256, 64 lowercase hex digits",
    );
  }
  const port = c.local_embedder_port;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === c.port) {
    throw new Error(
      `config.toml: [openviking] local_embedder_port must be a TCP port other than the server's own ${c.port} (got '${String(port)}')`,
    );
  }
  const threads = c.local_embedder_threads;
  if (!Number.isInteger(threads) || threads < 1 || threads > 16) {
    throw new Error(
      `config.toml: [openviking] local_embedder_threads must be an integer in 1..16 (got '${String(threads)}')`,
    );
  }
}

/** Derived paths: `config_file`/`workspace` default off `home`, so the three
 * never drift apart in a hand-edited config. */
export function resolveOpenVikingPaths(c: OpenVikingConfig): OpenVikingConfig {
  const home = expandHome(c.home);
  return {
    ...c,
    home,
    config_file: c.config_file ? expandHome(c.config_file) : join(home, "ov.conf"),
    workspace: c.workspace ? expandHome(c.workspace) : join(home, "workspace"),
  };
}

/** `http://host:port` — the one place the base URL is spelled. */
export function openVikingBaseUrl(c: OpenVikingConfig): string {
  return `http://${c.host}:${c.port}`;
}

/**
 * [ops] — the operations timezone: the ONE knob that defines whose
 * calendar day the system runs on. Every day-scoped feature derives its day
 * from here — the [feedback] same-day addendum + agent-rebuild rollover,
 * metrics day buckets, TUI alert fold memory and companion day rollover —
 * and the two sections that already carried their own zone ([eod] and
 * [slack.policy] `timezone`) now DEFAULT from it, each still individually
 * overridable in its own section.
 */
export interface OpsConfig {
  /** IANA zone (e.g. "Europe/Warsaw") of the operator's day. */
  timezone: string;
}

/** Neutral default — a config that never names a zone runs on UTC days. */
export const OPS_DEFAULTS: OpsConfig = { timezone: "UTC" };

/** The same Intl-based check the EOD machinery relies on (src/eod.ts builds
 * an Intl.DateTimeFormat per zone): an unknown zone throws RangeError at
 * formatter construction, so validate at parse time rather than at 18:00. */
export function assertIanaTimeZone(tz: string, where: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new Error(`config.toml: ${where} '${tz}' is not a valid IANA timezone`);
  }
  return tz;
}

/**
 * [ingress] — the webhook ingress shape. `tunnel-file` turns on the
 * hostname-file watcher: a tunnel sidecar writes its assigned bare
 * public hostname (e.g. `abc.trycloudflare.com`, trailing newline tolerated)
 * to `hostname_file`, and the daemon re-points the App's own webhook URL when
 * it changes — through the app-self-config gate class, which executes even in
 * dry-run (ratified rule-1 amendment, 2026-08-30). `none` (the default, and
 * what an absent section means) starts nothing at all.
 */
export interface IngressConfig {
  /** "none" ⇒ no watcher is ever constructed; "tunnel-file" ⇒ self-heal on. */
  shape: "none" | "tunnel-file";
  /** File the tunnel sidecar writes the bare public hostname into. Empty ⇒
   * `<root>/state/ingress/hostname` (see ingressHostnameFile). */
  hostname_file: string;
  /** Settle time after a file change before the re-point runs — quick-tunnel
   * sidecars write, then sometimes rewrite, within a second or two. */
  debounce_ms: number;
  /** The reliable path: a periodic sweep backs up fs.watch (the fast path),
   * exactly like the verdict watcher. */
  sweep_interval_s: number;
}

export const INGRESS_DEFAULTS: IngressConfig = {
  shape: "none",
  hostname_file: "",
  debounce_ms: 3000,
  sweep_interval_s: 300,
};

/** The hostname file's resolved path — the one place the default is spelled. */
export function ingressHostnameFile(cfg: Config, root: string): string {
  const configured = cfg.ingress.hostname_file.trim();
  return configured ? expandHome(configured) : join(root, "state", "ingress", "hostname");
}

export interface Config {
  dry_run: boolean;
  /**: the selected profile's resolved per-lens tuning
   * (`[lenses.<pass>]` in profile.toml, src/lenstuning.ts). config.toml never
   * sets it: `applyProfileTuning` overlays it after parsing, which is what
   * makes the profile win over config.toml, the preset and the defaults.
   * Absent or empty ⇒ untuned. */
  lenses?: LensTuningMap;
  /** The selected profile's posting policy (`[posting]` in profile.toml,
   * src/postingpolicy.ts), overlaid by `applyProfilePosting`. Absent ⇒ today's
   * behaviour; an all-default policy is never attached. */
  posting?: PostingPolicy;
  ops: OpsConfig;
  ingress: IngressConfig;
  github: GithubConfig;
  server: { hostname: string; port: number };
  daemon: {
    poll_interval_s: number;
    max_concurrent_rounds: number;
    round_deadline_min: number;
    overseer_rotation_days: number;
    /**: how many times the daemon may self-requeue a stuck round
     * (overdue + no verdict + session dead) per PR head. Past the cap the
     * round terminalizes through the existing overdue-anomaly park. Optional
     * so hand-rolled test configs keep compiling; readers default to
     * DEFAULT_MAX_SELF_REQUEUES. */
    max_self_requeues?: number;
    /**: minutes after dispatch before a running round with no prompt
     * receipt (#5362) counts as lost and is recovered. Optional; readers
     * default to DEFAULT_ROUND_STALL_GRACE_MIN. */
    round_stall_grace_min?: number;
    /** #5362: how many times a round's prompt may be RE-DELIVERED before the
     * expensive recovery takes over. Separate from `max_self_requeues` on
     * purpose — redelivery costs one file write and keeps the round, the
     * session and the conversation, where a self-requeue burns a round and
     * (for a live session) kills it. Optional; readers default to
     * DEFAULT_MAX_PROMPT_REDELIVERIES. */
    max_prompt_redeliveries?: number;
    /** daemon→Pi stage bounds. Optional only for old configs; the
     * parser supplies the exported defaults so production always has finite
     * values. Progress telemetry never changes any of them. */
    session_command_start_lease_s?: number;
    /** Maximum wall time from tmux birth to a generation-matched inject-bridge
     * startup receipt. Tmux existence alone is never delivery readiness. */
    session_bridge_ready_timeout_s?: number;
    session_command_running_max_min?: number;
    /** round execution milestones, all anchored to durable command
     * start. They never renew from heartbeat/activity telemetry. */
    round_first_pass_max_min?: number;
    round_passes_max_min?: number;
    round_finalize_grace_min?: number;
    /** H1a: once a round's review is CONFIRMED posted, a stage limit
     * no longer cancels it — the session's tail (ledger, findings record,
     * verdict file) gets this long after the posting to finish, and a round
     * still without a verdict then is settled from the posting receipt. Never
     * a self-requeue, so never a second posting. Readers default to
     * DEFAULT_ROUND_POSTED_TAIL_GRACE_MIN. */
    round_posted_tail_grace_min?: number;
    /**: the extra minutes a follow-up round whose pre-approval sweep
     * is OWED gets for its passes and its hard cap — the sweep is a whole
     * round-1 plan run after the delta's. Readers default to
     * DEFAULT_FOLLOW_UP_SWEEP_EXTRA_MIN. */
    follow_up_sweep_extra_min?: number;
    posting_receipt_grace_s?: number;
    session_command_unknown_grace_s?: number;
    session_command_unknown_max_checks?: number;
    session_command_max_start_retries?: number;
    /** H1b: how long a compaction the session's inject bridge reports
     * running may hold a waiting command's start lease open. pi refuses every
     * prompt while it compacts, so a command queued behind one is late, not
     * lost; past this bound a compaction still "running" is no reason to wait,
     * and the bounded redelivery → kill-and-replay recovery takes over.
     * Readers default to DEFAULT_SESSION_COMPACTION_MAX_S. */
    session_compaction_max_s?: number;
    round_stage_supervisor_stale_s?: number;
    /** L2: the daemon's event-loop watch (src/eventloop.ts). All
     * optional — `eventLoopPolicy` defaults each (300 s window, a 10 s single
     * delay or a 2 s p99 over a full window is a stall, one wake per 60 min,
     * "CPU starved" from 20% of CFS periods throttled) and clamps a number
     * into range; a non-number falls back to the default. */
    event_loop_window_s?: number;
    event_loop_stall_max_s?: number;
    event_loop_stall_p99_s?: number;
    event_loop_wake_cooldown_min?: number;
    event_loop_starved_throttle_ratio?: number;
    /** Zombie-round expiry horizon: a round stuck `overdue` for
     * longer than this — and whose PR has since verdicted or closed, so a
     * rerun would never touch it — moves to terminal `expired`.
     * 0 disables the sweep. */
    expire_overdue_after_h: number;
  };
  eod: {
    time: string;
    timezone: string;
    /** Daily overseer heartbeat wall time; same zone as `time`. */
    heartbeat_time: string;
    /** Watch the pinned area across the sweep and raise an anomaly
     * if curation touched it. Off ⇒ the EOD inject is byte-identical to
     * legacy behaviour. */
    pinned_watchdog: boolean;
    /** How long after the inject the watchdog keeps looking, when the day's
     * digest never appears to close the window early. */
    pinned_watchdog_window_min: number;
  };
  caps: {
    improvement_pr_max_lines: number;
    improvement_pr_max_files: number;
    improvement_pr_per_day: number;
    improvement_pr_per_week: number;
    issues_per_day: number;
    /** Path prefixes a bot improvement PR may never touch (lift of
     * the src/improvements.ts hardcode). A configured value REPLACES the
     * list (it is repo-shape, not an invariant — `migrations/` is Django's
     * name for the concept); the shipped default is today's exact list, and
     * `.env`-named files are refused unconditionally regardless of this
     * knob. */
    improvement_pr_deny_prefixes: string[];
  };
  models: ModelsConfig;
  pi: {
    package: string;
    version: string;
    session_dir: string;
    /** Process-wide subagent fan-out cap the glue extension enforces per
     * session (rides the command line as
     * QCR_SUBAGENT_MAX_CONCURRENCY). Default 4 — the companion/desktop
     * number; the VM config sets 6, the old pi-subagents config.json value. */
    subagent_max_concurrency: number;
  };
  openviking: OpenVikingConfig;
  memory: MemoryConfig;
  tui: TuiConfig;
  companion: CompanionConfig;
  sink: SinkConfig;
  backfill: BackfillConfig;
  guards: GuardsConfig;
  recheck: RecheckConfig;
  review: ReviewConfig;
  escalation: EscalationConfig;
  levers: LeversConfig;
  slack: SlackConfig;
  owner: OwnerConfig;
  /**: the whole-repo scan's defaults. The repo profile's `[scan]`
   * table overrides the keys in `SCAN_PROFILE_KEYS` (`applyProfileScan`,
   * src/profiles.ts) — the profile wins, as for per-lens tuning. */
  scan: ScanConfig;
  /**: the closed-PR archiver (`src/archive/`). Optional in the file;
   * the parser fills every key. */
  archive: ArchiveConfig;
}

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
   * default (owner ruling 2026-09-30: the scan validator is the skeptic, on by
   * default — amending the spec's original cost choice of off); a profile
   * may switch it off. It sorts every finding into a validity tier —
   * confirmed / likely / doubtful — and kills none: a refuted finding is
   * kept, marked doubtful. Its cost is part of every case's measured price. */
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
}

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
};

/** The `[scan]` keys a repo profile may override — what is about THIS repo
 * (how hard to look, whether to validate, what is not worth reading), never
 * the install's operating limits. */
export const SCAN_PROFILE_KEYS = ["effort", "tier", "validator", "exclude"] as const;

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
        const e = String(v ?? "")
          .trim()
          .toLowerCase();
        if (e === "low" || e === "medium" || e === "high") out.effort = e;
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

/** `[scan]` from config.toml: the defaults, overlaid by what it sets. */
export function parseScan(raw: unknown): ScanConfig {
  return { ...SCAN_DEFAULTS, ...parseScanTable("config.toml", raw ?? {}) };
}

/**
 * `[levers]`: the bounds on a SESSION-issued `drain` / `pause-pr`.
 * The operator's own levers (`qcr drain on`, the deploy tab) are not bounded
 * by anything here — the deploy flow's drain stands until the new boot's
 * first healthy reconcile lifts it. Every number is minutes; the budgets are
 * counted per `[ops] timezone` day.
 */
export interface LeversConfig {
  /** Longest single session drain. */
  session_drain_max_min: number;
  /** Total session-drain minutes grantable per day; must be ≥ the cap. */
  session_drain_budget_min_per_day: number;
  /** Longest single session pause of one PR. */
  session_pause_max_min: number;
  /** Total session-pause minutes grantable per PR per day; must be ≥ the cap. */
  session_pause_budget_min_per_day: number;
}

export const LEVERS_DEFAULTS: LeversConfig = {
  session_drain_max_min: 30,
  session_drain_budget_min_per_day: 90,
  session_pause_max_min: 240,
  session_pause_budget_min_per_day: 480,
};

/** Parse `[levers]`; a bound that is not a positive integer, or a budget
 * smaller than its cap, refuses to load — a lever bound of zero or a budget
 * that can never fund one full grant is a misconfiguration, not a setting. */
export function parseLevers(raw: Record<string, any>): LeversConfig {
  const cfg: LeversConfig = { ...LEVERS_DEFAULTS, ...(raw as Partial<LeversConfig>) };
  for (const key of Object.keys(LEVERS_DEFAULTS) as Array<keyof LeversConfig>) {
    const v = cfg[key];
    if (!Number.isInteger(v) || v < 1) {
      throw new Error(
        `config.toml [levers]: ${key} must be a positive integer number of minutes (got ${JSON.stringify(v)})`,
      );
    }
  }
  if (cfg.session_drain_budget_min_per_day < cfg.session_drain_max_min) {
    throw new Error(
      "config.toml [levers]: session_drain_budget_min_per_day must be at least session_drain_max_min",
    );
  }
  if (cfg.session_pause_budget_min_per_day < cfg.session_pause_max_min) {
    throw new Error(
      "config.toml [levers]: session_pause_budget_min_per_day must be at least session_pause_max_min",
    );
  }
  return cfg;
}

/** The values `[archive] mode` takes (docs/archiving.md §12). */
export const ARCHIVE_MODES = ["off", "plan", "on"] as const;
export type ArchiveMode = (typeof ARCHIVE_MODES)[number];

/**
 * `[archive]` (docs/archiving.md): closed-PR history out of every
 * live path into a compressed archive under `<root>/archive/`, nothing of
 * analysis value deleted. Read by `src/archive/` (the archiver's policy) and
 * `qcr archive status`.
 */
export interface ArchiveConfig {
  /**
   *   `off`  — the archiver arms no timer at all;
   *   `plan` — the SHIPPED value: it computes what it would move (status.json
   *            `archive`, `qcr status`, `qcr archive status --plan`) and
   *            writes nothing;
   *   `on`   — it MOVES, every tick: it restores reopened PRs' transcripts
   *            and payloads first; then the old reader-less event rows and
   *            webhook deliveries into `archive/db/`, sealing finished months
   *            (S2); then each eligible closed PR's files into
   *            `archive/pr-<n>/`, removing each from the live tree once its
   *            copy is verified (S3); then the overseer's non-current
   *            transcripts and pi's day-old global session files (S4).
   *            Nothing is deleted that is not verified in the archive or a
   *            proven duplicate.
   */
  mode: ArchiveMode;
  /** Closed PRs' files and webhook deliveries leave the live tree this many
   * days after the close (clamped 7..3650). */
  after_days: number;
  /** The reader-less event kinds leave this many days after their row was
   * written (clamped 31..3650, so `qcr metrics` d30 stays exact). */
  events_after_days: number;
  /** The archiver's own timer (clamped 10..3600 s). */
  interval_s: number;
  /** No tick before the daemon's first healthy reconcile plus this (clamped
   * 0..1440 min). */
  start_delay_min: number;
  /** No new file is started after this much of a tick (clamped 1..300 s). */
  tick_budget_s: number;
  /** At most this many PRs a tick (clamped 1..100). */
  max_prs_per_tick: number;
  /** Input rate cap for compress + verify (clamped 1..200 MB/s). */
  max_mb_per_s: number;
  /** Free space kept on both the archive and the state mount (clamped
   * 0.5..1024 GB). */
  disk_headroom_gb: number;
  /** The DB mover's starting batch (clamped 100..2000 rows). */
  db_batch_rows: number;
  /** gzip level (clamped 1..9). */
  gzip_level: number;
}

export const ARCHIVE_DEFAULTS: Readonly<ArchiveConfig> = Object.freeze({
  mode: "plan",
  after_days: 14,
  events_after_days: 35,
  interval_s: 60,
  start_delay_min: 10,
  tick_budget_s: 20,
  max_prs_per_tick: 5,
  max_mb_per_s: 8,
  disk_headroom_gb: 2,
  db_batch_rows: 500,
  gzip_level: 6,
});

/** Each numeric `[archive]` key's range, and whether it is a whole number. */
export const ARCHIVE_LIMITS: Readonly<
  Record<Exclude<keyof ArchiveConfig, "mode">, readonly [min: number, max: number, int: boolean]>
> = Object.freeze({
  after_days: [7, 3650, true],
  events_after_days: [31, 3650, true],
  interval_s: [10, 3600, true],
  start_delay_min: [0, 1440, true],
  tick_budget_s: [1, 300, true],
  max_prs_per_tick: [1, 100, true],
  max_mb_per_s: [1, 200, false],
  disk_headroom_gb: [0.5, 1024, false],
  db_batch_rows: [100, 2000, true],
  gzip_level: [1, 9, true],
});

/**
 * Parse `[archive]`. An unknown `mode` REFUSES to load (a misspelt `"onn"`
 * must not quietly mean plan, or off), and so does a key that is not a
 * number; a number out of its range is CLAMPED into it (`ARCHIVE_LIMITS`).
 */
export function parseArchive(raw: Record<string, unknown>): ArchiveConfig {
  const mode = raw.mode ?? ARCHIVE_DEFAULTS.mode;
  if (!(ARCHIVE_MODES as readonly unknown[]).includes(mode))
    throw new Error(
      `config.toml [archive]: mode must be one of ${ARCHIVE_MODES.map((v) => `"${v}"`).join(", ")} (got ${JSON.stringify(mode)})`,
    );
  const out: ArchiveConfig = { ...ARCHIVE_DEFAULTS, mode: mode as ArchiveMode };
  for (const [key, [min, max, int]] of Object.entries(ARCHIVE_LIMITS) as Array<
    [Exclude<keyof ArchiveConfig, "mode">, readonly [number, number, boolean]]
  >) {
    const v = raw[key];
    if (v === undefined) continue;
    const n = typeof v === "bigint" ? Number(v) : v;
    if (typeof n !== "number" || !Number.isFinite(n))
      throw new Error(
        `config.toml [archive]: ${key} must be a number (got ${JSON.stringify(typeof v === "bigint" ? String(v) : v)})`,
      );
    out[key] = Math.min(max, Math.max(min, int ? Math.floor(n) : n));
  }
  return out;
}

/** Defaults for [backfill], derived from the already-parsed [github] block. */
export function backfillDefaults(github: GithubConfig): BackfillConfig {
  return {
    bot_login: github.bot_login,
    bot_actor: github.app_slug,
    reviewed_label: github.reviewed_label,
    trigger_label: github.trigger_label,
    in_progress_label: github.in_progress_label,
    review_team_slug: github.review_team.split("/")[1] ?? github.review_team,
    concurrency: 2,
    max_search_pages: 10,
  };
}

/** [tui] is optional in config.toml — the TUI is an operator convenience and
 * older configs must keep parsing. */
export const TUI_DEFAULTS: TuiConfig = {
  target: "ssh",
  ssh_host: "my-vm",
  container: "quickreview-sandbox",
  remote_state_dir: "/opt/quickreview/state",
  remote_sandbox_root: "/opt/quickreview/sandbox",
  sudo_docker: true,
  poll_interval_s: 3,
  stale_after_s: 90,
  msg_timeout_s: 30,
  evidence_timeout_s: 60,
  evidence_why_interval_s: 10,
};

/** [companion] is optional in config.toml, exactly like [tui]. */
export const COMPANION_DEFAULTS: CompanionConfig = {
  enabled: true,
  container_name: "qcr-companion",
  image: "qcr-companion",
  pihome_volume: "companion-pihome",
  session: "companion",
  model: "openai-codex/gpt-6.1-sol:medium",
  repo_dir: "", // → sandboxRoot()
  tracker_dir: "", // → /tracker (rw) when set; empty = no tracker mount
  tracker_docs_dir: "", // → /tracker-docs (ro) when set
  reviewed_repo_dir: "", // → /reviewed-repo (ro) when set and present
  evidence_dir: "~/.local/share/qcr/evidence", // → /evidence (ro),
  feed_dir: "", // → <root>/state/companion/feed
  alerts_dir: "", // → <root>/state/companion/alerts
  ssh_dir: "~/.ssh",
  build_context: "", // → <root>/docker/companion
  overdue_grace_min: 30,
  stale_alert_s: 300,
  awaiting_age_h: 24,
  cooldown_min: 20,
};

/**
 * the issue sink — where auto-filed defect flags (`#bug` memory
 * entries, §9) land. Three kinds:
 *
 *   `wayfinder` — tickets written into a filesystem wayfinder tracker on the
 *                 operator's PC (the legacy behaviour, with the effort
 *                 and parent lifted out of code literals into this block).
 *   `github`    — defects filed as issues on the reviewed repo. The TUI never
 *                 talks to GitHub: it writes a `file-issue` COMMAND into the
 *                 daemon's commands/ channel, so the daemon's MutationGate,
 *                 day caps and title dedup enforce the filing.
 *   `none`      — auto-filing off. The default when `[sink]` is absent:
 *                 unconfigured = off, the degrade-gracefully boundary the
 *                 filer has always had.
 */
export type IssueSinkKind = "wayfinder" | "github" | "none";

export interface SinkConfig {
  kind: IssueSinkKind;
  /** Wayfinder tracker root (also the ticket projection's root). Empty ⇒
   * defaults from `[companion] tracker_dir` — continuity: that dir has been
   * the one tracker path the TUI knew. */
  root: string;
  /** Wayfinder: the effort auto-filed tickets are written into. */
  effort: string;
  /** Wayfinder: the `Parent:` map id stamped into each filed ticket. */
  parent: string;
  /** The TUI [2]-tab read-only ticket projection's effort. Deliberately a
   * SEPARATE key: today's live board reads a different effort
   * ("review-feedback-loop") from the one the filer writes into
   * ("review-sandbox"). Empty ⇒ same as `effort`. */
  tickets_effort: string;
}

export const SINK_DEFAULTS: SinkConfig = {
  kind: "none",
  root: "",
  effort: "",
  parent: "",
  tickets_effort: "",
};

/** [sink] parse + validation. Misconfig is loud at boot, not a quiet no-op:
 * a `wayfinder` sink missing its effort or parent would otherwise silently
 * file nothing (or file into a nameless effort) forever. */
function parseSink(raw: Record<string, any>, companion: CompanionConfig): SinkConfig {
  const sink: SinkConfig = { ...SINK_DEFAULTS, ...(raw as Partial<SinkConfig>) };
  if (!["wayfinder", "github", "none"].includes(sink.kind)) {
    throw new Error(
      `config.toml [sink]: kind must be "wayfinder", "github" or "none" (got ${JSON.stringify(sink.kind)})`,
    );
  }
  sink.root = sink.root ? expandHome(sink.root) : companion.tracker_dir;
  if (sink.kind === "wayfinder") {
    if (!sink.root.trim())
      throw new Error(
        'config.toml [sink]: kind = "wayfinder" requires a `root` (or a [companion] tracker_dir to default from)',
      );
    if (!sink.effort.trim())
      throw new Error('config.toml [sink]: kind = "wayfinder" requires a non-empty `effort`');
    if (!sink.parent.trim())
      throw new Error('config.toml [sink]: kind = "wayfinder" requires a non-empty `parent`');
  }
  return sink;
}

/** The ticket projection's effort — its own key when set, else the filer's.
 * Empty ⇒ the projection has nothing configured to read. */
export function sinkTicketsEffort(cfg: Config): string {
  return cfg.sink.tickets_effort.trim() || cfg.sink.effort.trim();
}

/** Default lost-prompt grace when [daemon] carries no
 * `round_stall_grace_min`: long enough that a slow first tool call is never
 * mistaken for a dropped prompt, far shorter than the round deadline. */
export const DEFAULT_ROUND_STALL_GRACE_MIN = 10;

/** Default self-requeue budget per PR head when [daemon] carries no
 * `max_self_requeues` — the brief's recommended N=2. */
export const DEFAULT_MAX_SELF_REQUEUES = 2;

/** Default prompt-redelivery budget per round (#5362). Two is enough to cover
 * a delivery that raced a busy session and one that raced a session restart;
 * a third failure is no longer a delivery problem, so escalating beats
 * re-sending the same file forever. */
export const DEFAULT_MAX_PROMPT_REDELIVERIES = 2;

/** finite daemon→Pi stage bounds. The 45-minute hard run cap is above
 * the measured 23.4-minute live maximum yet materially below the 75-minute
 * defense-in-depth round deadline. */
export const DEFAULT_SESSION_COMMAND_START_LEASE_S = 120;
export const DEFAULT_SESSION_BRIDGE_READY_TIMEOUT_S = 30;
export const DEFAULT_SESSION_COMMAND_RUNNING_MAX_MIN = 45;
export const DEFAULT_ROUND_FIRST_PASS_MAX_MIN = 5;
export const DEFAULT_ROUND_PASSES_MAX_MIN = 35;
export const DEFAULT_ROUND_FINALIZE_GRACE_MIN = 5;
/** H1a: measured posting→verdict tails ran to 6.5 min (210 rounds,
 * 2026-10-01…08); 15 is over twice that and still well inside the 75-minute
 * round deadline. */
export const DEFAULT_ROUND_POSTED_TAIL_GRACE_MIN = 15;
/**: `[daemon] follow_up_sweep_extra_min`'s default. */
export const DEFAULT_FOLLOW_UP_SWEEP_EXTRA_MIN = 20;
export const DEFAULT_POSTING_RECEIPT_GRACE_S = 120;
export const DEFAULT_SESSION_COMMAND_UNKNOWN_GRACE_S = 60;
export const DEFAULT_SESSION_COMMAND_UNKNOWN_MAX_CHECKS = 1;
export const DEFAULT_SESSION_COMMAND_MAX_START_RETRIES = 2;
/** H1b: the post-verdict compaction on #5849 (2026-10-08) took 73 s
 * with the container CPU-starved; ten minutes is several times the worst seen
 * and still well inside the 75-minute round deadline. */
export const DEFAULT_SESSION_COMPACTION_MAX_S = 600;
export const DEFAULT_ROUND_STAGE_SUPERVISOR_STALE_S = 180;

export function sandboxRoot(): string {
  // Robust under both dist/src (built) and src (vitest): walk up to package.json.
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    if (existsSync(resolve(dir, "package.json"))) return dir;
    dir = resolve(dir, "..");
  }
  throw new Error("sandbox root not found (no package.json above module dir)");
}

export function expandHome(p: string): string {
  return p.startsWith("~/") || p === "~" ? resolve(homedir(), p.slice(2)) : p;
}

/** Absolute host paths for every companion mount; "" means derive from root. */
export function resolveCompanionPaths(
  c: CompanionConfig,
  root: string = sandboxRoot(),
): CompanionConfig {
  return {
    ...c,
    repo_dir: c.repo_dir ? expandHome(c.repo_dir) : root,
    tracker_dir: c.tracker_dir ? expandHome(c.tracker_dir) : "",
    tracker_docs_dir: c.tracker_docs_dir ? expandHome(c.tracker_docs_dir) : "",
    reviewed_repo_dir: expandHome(c.reviewed_repo_dir),
    evidence_dir: c.evidence_dir ? expandHome(c.evidence_dir) : resolve(root, "evidence"),
    feed_dir: c.feed_dir ? expandHome(c.feed_dir) : resolve(root, "state", "companion", "feed"),
    alerts_dir: c.alerts_dir
      ? expandHome(c.alerts_dir)
      : resolve(root, "state", "companion", "alerts"),
    ssh_dir: expandHome(c.ssh_dir),
    build_context: c.build_context
      ? expandHome(c.build_context)
      : resolve(root, "docker", "companion"),
  };
}

function req(obj: Record<string, unknown>, key: string): unknown {
  const v = obj[key];
  if (v === undefined) throw new Error(`config.toml: missing key '${key}'`);
  return v;
}

/**
 * `[caps]` parsed with each numeric cap CHECKED, not cast. This
 * section used to be spread into `Config["caps"]` through an `as`, so a key
 * missing from an operator's file reached `checkDiffstat` as `undefined` —
 * and `files > undefined` is `false`, i.e. the cap passed. A cap the daemon
 * cannot compare against is a startup refusal: the improvement channel is the
 * one place this system pushes code, and it must never run uncapped.
 */
export function parseCaps(raw: Record<string, unknown>): Config["caps"] {
  const cap = (key: string): number => {
    const v = raw[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw new Error(
        `config.toml [caps]: ${key} must be a non-negative number (got ${JSON.stringify(v)})`,
      );
    }
    return v;
  };
  const isStrings = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((x) => typeof x === "string");
  const denyPrefixes = (): string[] => {
    const prefixes = raw.improvement_pr_deny_prefixes;
    if (prefixes === undefined) return [...IMPROVEMENT_DENY_PREFIXES_DEFAULT];
    if (isStrings(prefixes)) return [...prefixes];
    throw new Error(
      `config.toml [caps]: improvement_pr_deny_prefixes must be an array of strings (got ${JSON.stringify(prefixes)})`,
    );
  };
  return {
    improvement_pr_max_lines: cap("improvement_pr_max_lines"),
    improvement_pr_max_files: cap("improvement_pr_max_files"),
    improvement_pr_per_day: cap("improvement_pr_per_day"),
    improvement_pr_per_week: cap("improvement_pr_per_week"),
    issues_per_day: cap("issues_per_day"),
    improvement_pr_deny_prefixes: denyPrefixes(),
  };
}

/** The shipped improvement-PR path denylist: the exact pre-lift
 * hardcode. Lives here (not in improvements.ts) so config carries the default
 * without a runtime import cycle. */
export const IMPROVEMENT_DENY_PREFIXES_DEFAULT: readonly string[] = [
  "migrations/",
  "infra/",
  "ansible/",
  ".github/workflows/",
];

export function parseConfig(toml: string): Config {
  const raw = parse(toml) as Record<string, any>;
  // base_branch/clone_dir default so older configs keep parsing;
  // the live config states both explicitly.
  const github: GithubConfig = {
    base_branch: "main",
    clone_dir: "",
    ...(req(raw, "github") as Partial<GithubConfig>),
  } as GithubConfig;
  // The review preset shapes both [models] (reasoning level) and [review]
  // (the levers), so it is read before either is parsed.
  const preset = parsePreset((raw.review as Record<string, unknown> | undefined)?.preset);
  const companion = resolveCompanionPaths({
    ...COMPANION_DEFAULTS,
    ...((raw.companion ?? {}) as Partial<CompanionConfig>),
  });
  // [ops] is optional so older configs keep parsing; [eod] and
  // [slack.policy] timezones default from it below, own-section value wins.
  const ops: OpsConfig = {
    timezone: assertIanaTimeZone(
      String(((raw.ops ?? {}) as Partial<OpsConfig>).timezone ?? OPS_DEFAULTS.timezone),
      "[ops] timezone",
    ),
  };
  // [ingress] is optional: absent ⇒ shape "none", nothing starts.
  const ingress: IngressConfig = {
    ...INGRESS_DEFAULTS,
    ...((raw.ingress ?? {}) as Partial<IngressConfig>),
  };
  if (!["none", "tunnel-file"].includes(ingress.shape)) {
    throw new Error(
      `config.toml [ingress]: shape must be "none" or "tunnel-file" (got ${JSON.stringify(ingress.shape)})`,
    );
  }
  const cfg: Config = {
    dry_run: Boolean(req(raw, "dry_run")),
    ops,
    ingress,
    github,
    server: { ...(req(raw, "server") as Config["server"]) },
    // Both knobs default so legacy configs keep parsing.
    daemon: {
      max_self_requeues: DEFAULT_MAX_SELF_REQUEUES,
      expire_overdue_after_h: 24,
      session_command_start_lease_s: DEFAULT_SESSION_COMMAND_START_LEASE_S,
      session_bridge_ready_timeout_s: DEFAULT_SESSION_BRIDGE_READY_TIMEOUT_S,
      session_command_running_max_min: DEFAULT_SESSION_COMMAND_RUNNING_MAX_MIN,
      round_first_pass_max_min: DEFAULT_ROUND_FIRST_PASS_MAX_MIN,
      round_passes_max_min: DEFAULT_ROUND_PASSES_MAX_MIN,
      round_finalize_grace_min: DEFAULT_ROUND_FINALIZE_GRACE_MIN,
      round_posted_tail_grace_min: DEFAULT_ROUND_POSTED_TAIL_GRACE_MIN,
      follow_up_sweep_extra_min: DEFAULT_FOLLOW_UP_SWEEP_EXTRA_MIN,
      posting_receipt_grace_s: DEFAULT_POSTING_RECEIPT_GRACE_S,
      session_command_unknown_grace_s: DEFAULT_SESSION_COMMAND_UNKNOWN_GRACE_S,
      session_command_unknown_max_checks: DEFAULT_SESSION_COMMAND_UNKNOWN_MAX_CHECKS,
      session_command_max_start_retries: DEFAULT_SESSION_COMMAND_MAX_START_RETRIES,
      session_compaction_max_s: DEFAULT_SESSION_COMPACTION_MAX_S,
      round_stage_supervisor_stale_s: DEFAULT_ROUND_STAGE_SUPERVISOR_STALE_S,
      ...(req(raw, "daemon") as Partial<Config["daemon"]>),
    } as Config["daemon"],
    // heartbeat_time defaults so legacy configs keep parsing; the
    // timezone defaults from [ops], own [eod] value wins.
    eod: {
      heartbeat_time: "09:00",
      pinned_watchdog: true,
      pinned_watchdog_window_min: 90,
      timezone: ops.timezone,
      ...(req(raw, "eod") as Partial<Config["eod"]>),
    } as Config["eod"],
    caps: parseCaps(req(raw, "caps") as Record<string, unknown>),
    models: parseModels(req(raw, "models") as Record<string, any>, REVIEW_PRESETS[preset].effort),
    pi: {
      subagent_max_concurrency: 4,
      ...(req(raw, "pi") as Omit<Config["pi"], "subagent_max_concurrency"> &
        Partial<Pick<Config["pi"], "subagent_max_concurrency">>),
    },
    openviking: parseOpenViking((raw.openviking ?? {}) as Record<string, unknown>),
    memory: parseMemory((raw.memory ?? {}) as Record<string, unknown>),
    tui: { ...TUI_DEFAULTS, ...((raw.tui ?? {}) as Partial<TuiConfig>) },
    companion,
    sink: parseSink((raw.sink ?? {}) as Record<string, any>, companion),
    backfill: { ...backfillDefaults(github), ...((raw.backfill ?? {}) as Partial<BackfillConfig>) },
    guards: { ...GUARDS_DEFAULTS, ...((raw.guards ?? {}) as Partial<GuardsConfig>) },
    recheck: { ...RECHECK_DEFAULTS, ...((raw.recheck ?? {}) as Partial<RecheckConfig>) },
    // [review.directives] merges under its own spread so a partial table
    // extends the defaults instead of clobbering the sibling keys.
    // The preset fills every lever the file does not set itself; an explicit
    // key always wins, so `preset = "max"` + `sweep = false` means exactly that.
    review: {
      ...REVIEW_DEFAULTS,
      ...REVIEW_PRESETS[preset].levers,
      ...((raw.review ?? {}) as Partial<ReviewConfig>),
      preset,
      directives: {
        ...REVIEW_DIRECTIVES_DEFAULTS,
        ...(((raw.review as Record<string, any> | undefined)?.directives ??
          {}) as Partial<ReviewDirectivesConfig>),
      },
    },
    escalation: parseEscalation((raw.escalation ?? {}) as Record<string, any>),
    levers: parseLevers((raw.levers ?? {}) as Record<string, any>),
    slack: parseSlack((raw.slack ?? {}) as Record<string, any>, ops.timezone),
    owner: { ...OWNER_DEFAULTS, ...((raw.owner ?? {}) as Partial<OwnerConfig>) },
    scan: parseScan(raw.scan),
    archive: parseArchive((raw.archive ?? {}) as Record<string, unknown>),
  };
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
  // Legacy alias: a set `[slack] legacy_owner_slack_id` feeds
  // [owner] slack_id when that is empty; a conflicting pair is an error that
  // names the NEW key. After this fold nothing reads the legacy key.
  const legacyOwnerSlackId = String(
    (raw.slack as Record<string, any> | undefined)?.legacy_owner_slack_id ?? "",
  ).trim();
  if (legacyOwnerSlackId) {
    if (!cfg.owner.slack_id.trim()) {
      cfg.owner.slack_id = legacyOwnerSlackId;
    } else if (cfg.owner.slack_id.trim() !== legacyOwnerSlackId) {
      throw new Error(
        "config.toml: legacy [slack] legacy_owner_slack_id and [owner] slack_id are both set and differ — set `[owner] slack_id` only",
      );
    }
  }
  for (const k of [
    "repo",
    "app_slug",
    "bot_login",
    "review_team",
    "trigger_label",
    "in_progress_label",
    "reviewed_label",
    "improvement_label",
    "issue_label",
  ] as const)
    req(cfg.github as unknown as Record<string, unknown>, k);
  // every secrets reader in the daemon reads THIS field, so the
  // install locator decides it here, once, for all of them.
  cfg.github.secrets_dir = locateSecrets({
    configured: typeof cfg.github.secrets_dir === "string" ? cfg.github.secrets_dir : "",
  }).path;
  if (cfg.tui.target !== "ssh" && cfg.tui.target !== "local") {
    throw new Error(
      `config.toml [tui]: target must be "ssh" or "local" (got ${JSON.stringify(cfg.tui.target)})`,
    );
  }
  const firstPass = cfg.daemon.round_first_pass_max_min ?? DEFAULT_ROUND_FIRST_PASS_MAX_MIN;
  const passes = cfg.daemon.round_passes_max_min ?? DEFAULT_ROUND_PASSES_MAX_MIN;
  const running =
    cfg.daemon.session_command_running_max_min ?? DEFAULT_SESSION_COMMAND_RUNNING_MAX_MIN;
  const finalize = cfg.daemon.round_finalize_grace_min ?? DEFAULT_ROUND_FINALIZE_GRACE_MIN;
  if (!(
    firstPass > 0 &&
    firstPass < passes &&
    passes < running &&
    finalize > 0 &&
    finalize < running
  )) {
    throw new Error(
      "config.toml: require 0 < round_first_pass_max_min < round_passes_max_min < session_command_running_max_min and 0 < round_finalize_grace_min < session_command_running_max_min",
    );
  }
  const postedTail = cfg.daemon.round_posted_tail_grace_min ?? DEFAULT_ROUND_POSTED_TAIL_GRACE_MIN;
  if (!(typeof postedTail === "number" && Number.isFinite(postedTail) && postedTail > 0)) {
    throw new Error("config.toml: require round_posted_tail_grace_min > 0");
  }
  const sweepExtra = cfg.daemon.follow_up_sweep_extra_min ?? DEFAULT_FOLLOW_UP_SWEEP_EXTRA_MIN;
  if (!(typeof sweepExtra === "number" && Number.isFinite(sweepExtra) && sweepExtra >= 0)) {
    throw new Error("config.toml: require follow_up_sweep_extra_min >= 0");
  }
  const compactionMax = cfg.daemon.session_compaction_max_s ?? DEFAULT_SESSION_COMPACTION_MAX_S;
  if (!(typeof compactionMax === "number" && Number.isFinite(compactionMax) && compactionMax > 0)) {
    throw new Error("config.toml: require session_compaction_max_s > 0");
  }
  // Shape checks are pure, so they fire on every parse (tests included);
  // the token-file check is I/O and lives in validateSlackConfig.
  checkSlackShape(cfg.slack, cfg.owner);
  return cfg;
}

function parseSlack(raw: Record<string, any>, defaultTimezone: string): SlackConfig {
  const rawPolicy = (raw.policy ?? {}) as Record<string, any>;
  const causes: Record<string, SlackCausePolicy> = { ...SLACK_CAUSE_DEFAULTS };
  for (const [cause, v] of Object.entries(
    (rawPolicy.causes ?? {}) as Record<string, Partial<SlackCausePolicy>>,
  )) {
    causes[cause] = {
      enabled: v.enabled ?? causes[cause]?.enabled ?? true,
      cooldown_min: Number(
        v.cooldown_min ?? causes[cause]?.cooldown_min ?? SLACK_POLICY_DEFAULTS.default_cooldown_min,
      ),
    };
  }
  const { causes: _drop, ...policyScalars } = rawPolicy;
  // `legacy_owner_slack_id` is the legacy alias for [owner] slack_id —
  // consumed by parseConfig's fold, never carried on the parsed shape.
  const { legacy_owner_slack_id: _legacyOwnerId, ...rawScalars } = raw;
  const slack: SlackConfig = {
    ...SLACK_DEFAULTS,
    ...(rawScalars as Partial<SlackConfig>),
    users: { ...((raw.users ?? {}) as Record<string, string>) },
    // The day boundary defaults from [ops]; an explicit
    // [slack.policy] timezone still wins.
    policy: {
      ...SLACK_POLICY_DEFAULTS,
      timezone: defaultTimezone,
      ...(policyScalars as Partial<SlackPolicyConfig>),
      causes,
    },
  };
  // Token *files* are names under secrets_dir, but an absolute or ~-rooted
  // override must still work — expand here so every reader sees one shape.
  slack.bot_token_file = expandHome(slack.bot_token_file);
  slack.app_token_file = expandHome(slack.app_token_file);
  return slack;
}

/** Absolute path of a Slack token file: a bare name resolves under
 * [github].secrets_dir, an absolute/~ path is taken as given. */
export function slackTokenPath(cfg: Config, which: "bot" | "app"): string {
  const name = which === "bot" ? cfg.slack.bot_token_file : cfg.slack.app_token_file;
  return isAbsolute(name) ? name : join(cfg.github.secrets_dir, name);
}

/** Pure (I/O-free) part of Slack boot validation. When disabled, nothing at
 * all is required — the concierge is simply not there. The owner's Slack id
 * (`[owner] slack_id`, legacy alias `[slack] legacy_owner_slack_id`)
 * carries the same rules the legacy key always had. */
function checkSlackShape(slack: SlackConfig, owner: OwnerConfig): void {
  if (!slack.enabled) return;
  const fail = (msg: string): never => {
    throw new Error(`config.toml [slack]: ${msg}`);
  };
  if (!slack.channel.trim()) fail("enabled = true requires a non-empty `channel`");
  if (slack.channel_kind !== "public" && slack.channel_kind !== "private") {
    fail(`channel_kind must be "public" or "private" (got ${JSON.stringify(slack.channel_kind)})`);
  }
  if (!owner.slack_id.trim()) fail("enabled = true requires a non-empty `[owner] slack_id`");
  if (!(owner.slack_id in slack.users)) {
    fail(
      `[owner] slack_id '${owner.slack_id}' must appear as a key in [slack.users] (it is the only source of own-PR rights)`,
    );
  }
}

/** How validation reads a secret file. Injectable so tests never need real
 * files; the default is the same read-and-trim every other secret gets. */
export type SecretReader = (path: string) => string | undefined;

export const fsSecretReader: SecretReader = (path) => {
  try {
    const v = readFileSync(path, "utf8").trim();
    return v.length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Full Slack boot validation — shape plus token-file presence. A missing or
 * empty token is a HARD startup error: the concierge never degrades silently
 * into a read-only half-presence in the channel. Disabled ⇒ nothing is read.
 */
export function validateSlackConfig(cfg: Config, deps: { readSecret?: SecretReader } = {}): void {
  checkSlackShape(cfg.slack, cfg.owner);
  if (!cfg.slack.enabled) return;
  const read = deps.readSecret ?? fsSecretReader;
  for (const which of ["bot", "app"] as const) {
    const path = slackTokenPath(cfg, which);
    if (!read(path)) {
      throw new Error(
        `config.toml [slack]: ${which} token file '${path}' is missing or empty — Slack cannot start`,
      );
    }
  }
}

let cached: Config | null = null;

/**
 * The live config's path for this process, decided by the install locator
 *: `$QCR_CONFIG`, else the install's config home — never the
 * checkout's `config.toml`. The ONE answer every no-argument
 * `loadConfig()` reads, and the one the daemon hands its sessions.
 */
export function liveConfigPath(): string {
  return locateConfig().path;
}

export function loadConfig(path?: string): Config {
  if (cached && !path) return cached;
  const p = path ?? liveConfigPath();
  if (!path && !existsSync(p)) {
    // A missing live config says where it was looked for, and — when the
    // checkout still strands one — how to move it.
    throw new Error(
      missingConfigMessage(locateConfig(), strandedCheckoutConfig({ root: sandboxRoot() })),
    );
  }
  const cfg = parseConfig(readFileSync(p, "utf8"));
  validateSlackConfig(cfg);
  if (!path) cached = cfg;
  return cfg;
}

function parseModels(raw: Record<string, any>, presetEffort: ReviewEffort = ""): ModelsConfig {
  return applyReviewEffort({
    // `[models] effort` set explicitly wins over the preset's level.
    effort: raw.effort !== undefined ? parseEffort(raw.effort) : presetEffort,
    effort_max: parseEffortMax(raw.effort_max),
    default: String(req(raw, "default")),
    conversation: String(req(raw, "conversation")),
    overseer: String(req(raw, "overseer")),
    tiers: {
      ...MODELS_TIER_DEFAULTS.tiers,
      ...((raw.tiers ?? {}) as Partial<Record<PassTier, string>>),
    },
    risk_passes: (raw.risk_passes ?? MODELS_TIER_DEFAULTS.risk_passes) as string[],
    validate_tier: (raw.validate_tier ?? MODELS_TIER_DEFAULTS.validate_tier) as PassTier,
    small_diff_lines: Number(raw.small_diff_lines ?? MODELS_TIER_DEFAULTS.small_diff_lines),
    pricing: (raw.pricing ?? {}) as Record<string, ModelPricing>,
    pass_tiers: { ...DEFAULT_PASS_TIERS, ...((raw.pass_tiers ?? {}) as Record<string, PassTier>) },
  });
}

/**
 * Validate the per-lens knobs — `[review] skip_lenses`,
 * `[review] validate_consequence_rule` and `[models.pass_tiers]`. Called by
 * `parseConfig` and again by the bench's `--config` overrides (which write
 * past the parser), so both routes refuse the same things.
 */
export function validateLensKnobs(cfg: Pick<Config, "review" | "models">): void {
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
}

/** Full model spec ("provider/model:thinking") for a pass tier. */
export function tierModel(cfg: Config, tier: PassTier): string {
  return cfg.models.tiers[tier];
}
