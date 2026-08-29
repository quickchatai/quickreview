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
}

export interface TuiConfig {
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
  /** awaiting_author/awaiting_human older than this is nag-worthy. */
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
  awaiting_human_stale_h: number;
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
  "pr.awaiting_human_stale": { enabled: false, cooldown_min: 1440 },
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
  awaiting_human_stale_h: 72,
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
   * dynamic same-day feedback addendum. "" ⇒ no profile: exactly the generic
   * addenda set. Loaded once at daemon assembly (src/wire.ts) — a malformed
   * pack fails the boot loudly, never a silent skip.
   */
  profile: string;
}

export const REVIEW_DEFAULTS: ReviewConfig = {
  escalation_mention_default: "",
  profile: "",
};

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

/** Per-model spend rates, keyed by bare model id (e.g. "gpt-5.6-sol"). */
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
}

/** Defaults for the tiered [models] knobs — older configs keep parsing. */
export const MODELS_TIER_DEFAULTS: Pick<
  ModelsConfig,
  "tiers" | "risk_passes" | "validate_tier" | "small_diff_lines" | "pricing"
> = {
  tiers: {
    "terra-med": "openai-codex/gpt-5.6-terra:medium",
    "sol-med": "openai-codex/gpt-5.6-sol:medium",
    "sol-high": "openai-codex/gpt-5.6-sol:high",
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
  /** ov.conf `embedding.dense` (OpenAI embeddings ENABLED, no `vlm`). */
  embedding_model: string;
  embedding_dimension: number;
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
  embedding_model: "text-embedding-3-small",
  embedding_dimension: 1536,
};

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

export interface Config {
  dry_run: boolean;
  ops: OpsConfig;
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
  };
  models: ModelsConfig;
  pi: { package: string; version: string; session_dir: string };
  openviking: OpenVikingConfig;
  memory: MemoryConfig;
  tui: TuiConfig;
  companion: CompanionConfig;
  sink: SinkConfig;
  backfill: BackfillConfig;
  guards: GuardsConfig;
  recheck: RecheckConfig;
  review: ReviewConfig;
  slack: SlackConfig;
  owner: OwnerConfig;
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
  model: "openai-codex/gpt-5.6-sol",
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
    throw new Error(`config.toml [sink]: kind must be "wayfinder", "github" or "none" (got ${JSON.stringify(sink.kind)})`);
  }
  sink.root = sink.root ? expandHome(sink.root) : companion.tracker_dir;
  if (sink.kind === "wayfinder") {
    if (!sink.root.trim()) throw new Error("config.toml [sink]: kind = \"wayfinder\" requires a `root` (or a [companion] tracker_dir to default from)");
    if (!sink.effort.trim()) throw new Error("config.toml [sink]: kind = \"wayfinder\" requires a non-empty `effort`");
    if (!sink.parent.trim()) throw new Error("config.toml [sink]: kind = \"wayfinder\" requires a non-empty `parent`");
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
export function resolveCompanionPaths(c: CompanionConfig, root: string = sandboxRoot()): CompanionConfig {
  return {
    ...c,
    repo_dir: c.repo_dir ? expandHome(c.repo_dir) : root,
    tracker_dir: expandHome(c.tracker_dir),
    tracker_docs_dir: expandHome(c.tracker_docs_dir),
    reviewed_repo_dir: expandHome(c.reviewed_repo_dir),
    evidence_dir: c.evidence_dir ? expandHome(c.evidence_dir) : resolve(root, "evidence"),
    feed_dir: c.feed_dir ? expandHome(c.feed_dir) : resolve(root, "state", "companion", "feed"),
    alerts_dir: c.alerts_dir ? expandHome(c.alerts_dir) : resolve(root, "state", "companion", "alerts"),
    ssh_dir: expandHome(c.ssh_dir),
    build_context: c.build_context ? expandHome(c.build_context) : resolve(root, "docker", "companion"),
  };
}

function req(obj: Record<string, unknown>, key: string): unknown {
  const v = obj[key];
  if (v === undefined) throw new Error(`config.toml: missing key '${key}'`);
  return v;
}

export function parseConfig(toml: string): Config {
  const raw = parse(toml) as Record<string, any>;
  const github: GithubConfig = { ...(req(raw, "github") as GithubConfig) };
  const companion = resolveCompanionPaths({ ...COMPANION_DEFAULTS, ...((raw.companion ?? {}) as Partial<CompanionConfig>) });
  // [ops] is optional so older configs keep parsing; [eod] and
  // [slack.policy] timezones default from it below, own-section value wins.
  const ops: OpsConfig = {
    timezone: assertIanaTimeZone(
      String(((raw.ops ?? {}) as Partial<OpsConfig>).timezone ?? OPS_DEFAULTS.timezone),
      "[ops] timezone",
    ),
  };
  const cfg: Config = {
    dry_run: Boolean(req(raw, "dry_run")),
    ops,
    github,
    server: { ...(req(raw, "server") as Config["server"]) },
// Both knobs default so legacy configs keep parsing.
    daemon: {
      max_self_requeues: DEFAULT_MAX_SELF_REQUEUES,
      expire_overdue_after_h: 24,
      session_command_start_lease_s: DEFAULT_SESSION_COMMAND_START_LEASE_S,
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
    caps: { ...(req(raw, "caps") as Config["caps"]) },
    models: parseModels(req(raw, "models") as Record<string, any>),
    pi: { ...(req(raw, "pi") as Config["pi"]) },
    openviking: resolveOpenVikingPaths({ ...OPENVIKING_DEFAULTS, ...((raw.openviking ?? {}) as Partial<OpenVikingConfig>) }),
    memory: { ...MEMORY_DEFAULTS, ...((raw.memory ?? {}) as Partial<MemoryConfig>) },
    tui: { ...TUI_DEFAULTS, ...((raw.tui ?? {}) as Partial<TuiConfig>) },
    companion,
    sink: parseSink((raw.sink ?? {}) as Record<string, any>, companion),
    backfill: { ...backfillDefaults(github), ...((raw.backfill ?? {}) as Partial<BackfillConfig>) },
    guards: { ...GUARDS_DEFAULTS, ...((raw.guards ?? {}) as Partial<GuardsConfig>) },
    recheck: { ...RECHECK_DEFAULTS, ...((raw.recheck ?? {}) as Partial<RecheckConfig>) },
    review: { ...REVIEW_DEFAULTS, ...((raw.review ?? {}) as Partial<ReviewConfig>) },
    slack: parseSlack((raw.slack ?? {}) as Record<string, any>, ops.timezone),
    owner: { ...OWNER_DEFAULTS, ...((raw.owner ?? {}) as Partial<OwnerConfig>) },
  };
  // Legacy alias: a set `[slack] legacy_owner_slack_id` feeds
  // [owner] slack_id when that is empty; a conflicting pair is an error that
  // names the NEW key. After this fold nothing reads the legacy key.
  const legacyOwnerSlackId = String((raw.slack as Record<string, any> | undefined)?.legacy_owner_slack_id ?? "").trim();
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
    "repo", "app_slug", "bot_login", "review_team",
    "trigger_label", "in_progress_label", "reviewed_label", "improvement_label",
    "issue_label", "secrets_dir",
  ] as const) req(cfg.github as unknown as Record<string, unknown>, k);
  cfg.github.secrets_dir = expandHome(cfg.github.secrets_dir);
  const firstPass = cfg.daemon.round_first_pass_max_min ?? DEFAULT_ROUND_FIRST_PASS_MAX_MIN;
  const passes = cfg.daemon.round_passes_max_min ?? DEFAULT_ROUND_PASSES_MAX_MIN;
  const running = cfg.daemon.session_command_running_max_min ?? DEFAULT_SESSION_COMMAND_RUNNING_MAX_MIN;
  const finalize = cfg.daemon.round_finalize_grace_min ?? DEFAULT_ROUND_FINALIZE_GRACE_MIN;
  if (!(firstPass > 0 && firstPass < passes && passes < running && finalize > 0 && finalize < running)) {
    throw new Error("config.toml: require 0 < round_first_pass_max_min < round_passes_max_min < session_command_running_max_min and 0 < round_finalize_grace_min < session_command_running_max_min");
  }
  // Shape checks are pure, so they fire on every parse (tests included);
  // the token-file check is I/O and lives in validateSlackConfig.
  checkSlackShape(cfg.slack, cfg.owner);
  return cfg;
}

function parseSlack(raw: Record<string, any>, defaultTimezone: string): SlackConfig {
  const rawPolicy = (raw.policy ?? {}) as Record<string, any>;
  const causes: Record<string, SlackCausePolicy> = { ...SLACK_CAUSE_DEFAULTS };
  for (const [cause, v] of Object.entries((rawPolicy.causes ?? {}) as Record<string, Partial<SlackCausePolicy>>)) {
    causes[cause] = {
      enabled: v.enabled ?? causes[cause]?.enabled ?? true,
      cooldown_min: Number(v.cooldown_min ?? causes[cause]?.cooldown_min ?? SLACK_POLICY_DEFAULTS.default_cooldown_min),
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
    policy: { ...SLACK_POLICY_DEFAULTS, timezone: defaultTimezone, ...(policyScalars as Partial<SlackPolicyConfig>), causes },
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
    fail(`[owner] slack_id '${owner.slack_id}' must appear as a key in [slack.users] (it is the only source of own-PR rights)`);
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
      throw new Error(`config.toml [slack]: ${which} token file '${path}' is missing or empty — Slack cannot start`);
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
  return {
    default: String(req(raw, "default")),
    conversation: String(req(raw, "conversation")),
    overseer: String(req(raw, "overseer")),
    tiers: { ...MODELS_TIER_DEFAULTS.tiers, ...((raw.tiers ?? {}) as Partial<Record<PassTier, string>>) },
    risk_passes: (raw.risk_passes ?? MODELS_TIER_DEFAULTS.risk_passes) as string[],
    validate_tier: (raw.validate_tier ?? MODELS_TIER_DEFAULTS.validate_tier) as PassTier,
    small_diff_lines: Number(raw.small_diff_lines ?? MODELS_TIER_DEFAULTS.small_diff_lines),
    pricing: (raw.pricing ?? {}) as Record<string, ModelPricing>,
  };
}

/** Full model spec ("provider/model:thinking") for a pass tier. */
export function tierModel(cfg: Config, tier: PassTier): string {
  return cfg.models.tiers[tier];
}
