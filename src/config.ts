// Typed access to config.toml — the single source of every runtime knob.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import type { PassTier } from "./types.js";

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
  secrets_dir: string;
  /** The reviewed repo's default branch: the base the improvement
   * filer targets, the branch replay diffs against, and the fixture base for
   * CLI ops. Default "main"; example-app sets "master". PR rounds do NOT
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
 * `.git` stripped). The live config's repo ("example-org/example-app")
 * derives "example-app" — the legacy hardcode, now a derivation. */
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
  /** Host path of the REVIEWED repo (example-app) → /example-app,
   * READ-ONLY. The companion reads the code a review is about; it
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
   * Repo profile: names a directory under `profiles/` whose
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
  /** Unpack the sources of the third-party packages this PR touches, at
   * their locked versions, so passes can read what a library actually does
   * (src/depsources.ts). Download-and-unpack only — nothing is installed or
   * run. */
  dependency_sources: boolean;
}

export const REVIEW_DEFAULTS: ReviewConfig = {
  escalation_mention_default: "",
  profile: "",
  directives: REVIEW_DIRECTIVES_DEFAULTS,
  sublenses: false,
  sweep: false,
  sweep_max_groups: 6,
  dependency_sources: false,
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
  if (!Number.isFinite(cfg.max_per_pr) || cfg.max_per_pr < 1) {
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
  /** pass-validate's FLOOR tier. The validator holds a veto over
   * every lens finding, so dispatch raises it to the round's highest lens
   * tier; this knob can only make it start higher, never lower. */
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
   * 0.87.1 lists `minimal…high, xhigh, max` for gpt-6-sol (model catalog,
   * VERIFY-ON-PIN); a model that tops out lower needs this set to its own
   * ceiling. */
  effort_max: ThinkingLevel;
}

/** pi's thinking levels, ascending (pi 0.87.1 — VERIFY-ON-PIN). */
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
> = {
  effort: "",
  effort_max: "max",
  tiers: {
    "terra-med": "openai-codex/gpt-6-sol:medium",
    "sol-med": "openai-codex/gpt-6-sol:medium",
    "sol-high": "openai-codex/gpt-6-sol:high",
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
   * path, where the deadline in [memory] is the real guard. */
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
   * defaults (4/4/8) for the same 2-CPU cap. */
  queue_concurrency: number;
  /** Health-poll cadence; the heartbeat reports the CACHED sample, so
   * status.json writing never waits on the network. */
  health_interval_s: number;
  health_timeout_ms: number;
  /** Restart backoff ladder; the last entry is the ceiling. The supervisor
   * never gives up — a memory engine that stays down is worse than a slow
   * retry, and every call site already degrades memory-less. */
  restart_backoff_ms: number[];
  /** A child that stayed up this long resets the backoff ladder. */
  restart_reset_after_s: number;
  /** ov.conf `embedding.dense.provider`. `local` is the shipped
   * default — the server's own llama-cpp embedder, in the container, so no
   * memory text leaves the machine. `openai` is the explicit opt-in and needs
   * `embedding_key_file` in the secrets dir. Mirrored as
   * `openviking_embedding_provider`. */
  embedding_provider: EmbeddingProvider;
  /** ov.conf `embedding.dense.model` / `.dimension`. Under `local` they are
   * pinned to the ONE model 0.4.15 ships a spec for (the server refuses any
   * other dimension for it); under `openai` the operator names the hosted
   * model and its dimension. */
  embedding_model: string;
  embedding_dimension: number;
  /** Secrets-dir file name of the HOSTED embeddings credential — deliberately
   * NOT `openai_api_key` (pi's model credential), so the two can be set
   * independently. Read only by the ov.conf render, only under `openai`. */
  embedding_key_file: string;
}

export const EMBEDDING_PROVIDERS = ["local", "openai"] as const;
export type EmbeddingProvider = (typeof EMBEDDING_PROVIDERS)[number];

/** The server's built-in local dense embedder — the only local model
 * OpenViking 0.4.15 ships a spec for (`LOCAL_DENSE_MODEL_SPECS`), fixed at
 * 512 dims. Mirrored by `LOCAL_EMBEDDER` in scripts/openviking-reembed.mjs. */
export const LOCAL_EMBEDDING = Object.freeze({ model: "bge-small-zh-v1.5-f16", dimension: 512 });
/** What an `openai` opt-in runs unless the operator names another model. */
export const HOSTED_EMBEDDING = Object.freeze({ model: "text-embedding-3-small", dimension: 1536 });

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
   * memory-less. */
  context_timeout_ms: number;
  /** Minimum minutes between degraded-memory overseer anomalies. The gap is
   * logged every round regardless; only the alert is cooled down. */
  alert_cooldown_min: number;
  /** Which OpenViking scopes the round's context search may draw from, and how
   * many items each may contribute. Keys must be server quota buckets;
   * `src/openviking/client.ts` drops unknown ones with a gap. An EMPTY map
   * means "no quotas" — the server's own balance across every scope it has,
   * which is not what a review round wants (see the comment in config.toml). */
  context_quotas: Record<string, number>;
}

export const MEMORY_DEFAULTS: MemoryConfig = {
  context_tokens: 2000,
  context_timeout_ms: 3000,
  alert_cooldown_min: 60,
  context_quotas: { experiences: 24, resources: 8 },
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
  search_timeout_ms: 2500,
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
  health_timeout_ms: 2000,
  restart_backoff_ms: [1000, 2000, 5000, 15000, 30000, 60000],
  restart_reset_after_s: 120,
  embedding_provider: "local",
  embedding_model: LOCAL_EMBEDDING.model,
  embedding_dimension: LOCAL_EMBEDDING.dimension,
  embedding_key_file: "openai_embeddings_api_key",
};

/**
 * The [openviking] block, defaults filled and the embedder checked.
 *
 * The embedder is validated at LOAD time because the server validates it at
 * BOOT time, and a server that refuses to start is a silent memory outage: an
 * unknown provider, a non-positive dimension, or a `local` model/dimension the
 * server's one local spec does not match are all config errors here.
 */
export function parseOpenViking(raw: Record<string, unknown>): OpenVikingConfig {
  const merged = { ...OPENVIKING_DEFAULTS, ...(raw as Partial<OpenVikingConfig>) };
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
      `config.toml: [openviking] embedding_provider = "local" runs the server's built-in ${LOCAL_EMBEDDING.model} at ${LOCAL_EMBEDDING.dimension} dims — ` +
        `it is the only local model OpenViking 0.4.15 ships; set embedding_model/embedding_dimension to it, or opt into a hosted provider`,
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
  return resolveOpenVikingPaths(merged);
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
    posting_receipt_grace_s?: number;
    session_command_unknown_grace_s?: number;
    session_command_unknown_max_checks?: number;
    session_command_max_start_retries?: number;
    round_stage_supervisor_stale_s?: number;
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
};

/** [companion] is optional in config.toml, exactly like [tui]. */
export const COMPANION_DEFAULTS: CompanionConfig = {
  enabled: true,
  container_name: "qcr-companion",
  image: "qcr-companion",
  pihome_volume: "companion-pihome",
  session: "companion",
  model: "openai-codex/gpt-6-sol",
  repo_dir: "", // → sandboxRoot()
  tracker_dir: "~/src/tracker",
  tracker_docs_dir: "~/src/tracker-docs",
  reviewed_repo_dir: "~/src/example-app", // → /example-app (ro)
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
export const DEFAULT_POSTING_RECEIPT_GRACE_S = 120;
export const DEFAULT_SESSION_COMMAND_UNKNOWN_GRACE_S = 60;
export const DEFAULT_SESSION_COMMAND_UNKNOWN_MAX_CHECKS = 1;
export const DEFAULT_SESSION_COMMAND_MAX_START_RETRIES = 2;
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
    tracker_dir: expandHome(c.tracker_dir),
    tracker_docs_dir: expandHome(c.tracker_docs_dir),
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
      posting_receipt_grace_s: DEFAULT_POSTING_RECEIPT_GRACE_S,
      session_command_unknown_grace_s: DEFAULT_SESSION_COMMAND_UNKNOWN_GRACE_S,
      session_command_unknown_max_checks: DEFAULT_SESSION_COMMAND_UNKNOWN_MAX_CHECKS,
      session_command_max_start_retries: DEFAULT_SESSION_COMMAND_MAX_START_RETRIES,
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
    models: parseModels(req(raw, "models") as Record<string, any>),
    pi: {
      subagent_max_concurrency: 4,
      ...(req(raw, "pi") as Omit<Config["pi"], "subagent_max_concurrency"> &
        Partial<Pick<Config["pi"], "subagent_max_concurrency">>),
    },
    openviking: parseOpenViking((raw.openviking ?? {}) as Record<string, unknown>),
    memory: { ...MEMORY_DEFAULTS, ...((raw.memory ?? {}) as Partial<MemoryConfig>) },
    tui: { ...TUI_DEFAULTS, ...((raw.tui ?? {}) as Partial<TuiConfig>) },
    companion,
    sink: parseSink((raw.sink ?? {}) as Record<string, any>, companion),
    backfill: { ...backfillDefaults(github), ...((raw.backfill ?? {}) as Partial<BackfillConfig>) },
    guards: { ...GUARDS_DEFAULTS, ...((raw.guards ?? {}) as Partial<GuardsConfig>) },
    recheck: { ...RECHECK_DEFAULTS, ...((raw.recheck ?? {}) as Partial<RecheckConfig>) },
    // [review.directives] merges under its own spread so a partial table
    // extends the defaults instead of clobbering the sibling keys.
    review: {
      ...REVIEW_DEFAULTS,
      ...((raw.review ?? {}) as Partial<ReviewConfig>),
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
  };
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
    "secrets_dir",
  ] as const)
    req(cfg.github as unknown as Record<string, unknown>, k);
  cfg.github.secrets_dir = expandHome(cfg.github.secrets_dir);
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

export function loadConfig(path?: string): Config {
  if (cached && !path) return cached;
  const p = path ?? resolve(sandboxRoot(), "config.toml");
  const cfg = parseConfig(readFileSync(p, "utf8"));
  validateSlackConfig(cfg);
  if (!path) cached = cfg;
  return cfg;
}

function parseModels(raw: Record<string, any>): ModelsConfig {
  return applyReviewEffort({
    effort: parseEffort(raw.effort),
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
  });
}

/** Full model spec ("provider/model:thinking") for a pass tier. */
export function tierModel(cfg: Config, tier: PassTier): string {
  return cfg.models.tiers[tier];
}
