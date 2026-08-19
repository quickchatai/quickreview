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
  /** Channel-wide model turns per Warsaw day (RATIFIED at 80). */
  daily_turns: number;
  /** Per-person model turns per Warsaw day (RATIFIED at 20). */
  per_user_daily_turns: number;
  /** Daemon posts into any ONE thread per Warsaw day. */
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
  legacy_owner_slack_id: string;
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
  timezone: "Europe/Warsaw",
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
  legacy_owner_slack_id: "",
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
}

export const GUARDS_DEFAULTS: GuardsConfig = {
  downgrade_on_human_approval: true,
  skip_unchanged_head: true,
  recheck_pr_state_before_post: true,
  block_approve_on_red_ci: true,
  no_checks_is_red: false,
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

export interface Config {
  dry_run: boolean;
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
  };
  eod: { time: string; timezone: string };
  caps: {
    improvement_pr_max_lines: number;
    improvement_pr_max_files: number;
    improvement_pr_per_day: number;
    improvement_pr_per_week: number;
    issues_per_day: number;
  };
  models: ModelsConfig;
  pi: { package: string; version: string; session_dir: string };
  tui: TuiConfig;
  companion: CompanionConfig;
  backfill: BackfillConfig;
  guards: GuardsConfig;
  recheck: RecheckConfig;
  slack: SlackConfig;
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
  feed_dir: "", // → <root>/state/companion/feed
  alerts_dir: "", // → <root>/state/companion/alerts
  ssh_dir: "~/.ssh",
  build_context: "", // → <root>/docker/companion
  overdue_grace_min: 30,
  stale_alert_s: 300,
  awaiting_age_h: 24,
  cooldown_min: 20,
};

/** Default self-requeue budget per PR head when [daemon] carries no
 * `max_self_requeues` — the brief's recommended N=2. */
export const DEFAULT_MAX_SELF_REQUEUES = 2;

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
  const cfg: Config = {
    dry_run: Boolean(req(raw, "dry_run")),
    github,
    server: { ...(req(raw, "server") as Config["server"]) },
    daemon: { max_self_requeues: DEFAULT_MAX_SELF_REQUEUES, ...(req(raw, "daemon") as Config["daemon"]) },
    eod: { ...(req(raw, "eod") as Config["eod"]) },
    caps: { ...(req(raw, "caps") as Config["caps"]) },
    models: parseModels(req(raw, "models") as Record<string, any>),
    pi: { ...(req(raw, "pi") as Config["pi"]) },
    tui: { ...TUI_DEFAULTS, ...((raw.tui ?? {}) as Partial<TuiConfig>) },
    companion: resolveCompanionPaths({ ...COMPANION_DEFAULTS, ...((raw.companion ?? {}) as Partial<CompanionConfig>) }),
    backfill: { ...backfillDefaults(github), ...((raw.backfill ?? {}) as Partial<BackfillConfig>) },
    guards: { ...GUARDS_DEFAULTS, ...((raw.guards ?? {}) as Partial<GuardsConfig>) },
    recheck: { ...RECHECK_DEFAULTS, ...((raw.recheck ?? {}) as Partial<RecheckConfig>) },
    slack: parseSlack((raw.slack ?? {}) as Record<string, any>),
  };
  for (const k of [
    "repo", "app_slug", "bot_login", "review_team",
    "trigger_label", "in_progress_label", "reviewed_label", "improvement_label",
    "issue_label", "secrets_dir",
  ] as const) req(cfg.github as unknown as Record<string, unknown>, k);
  cfg.github.secrets_dir = expandHome(cfg.github.secrets_dir);
  // Shape checks are pure, so they fire on every parse (tests included);
  // the token-file check is I/O and lives in validateSlackConfig.
  checkSlackShape(cfg.slack);
  return cfg;
}

function parseSlack(raw: Record<string, any>): SlackConfig {
  const rawPolicy = (raw.policy ?? {}) as Record<string, any>;
  const causes: Record<string, SlackCausePolicy> = { ...SLACK_CAUSE_DEFAULTS };
  for (const [cause, v] of Object.entries((rawPolicy.causes ?? {}) as Record<string, Partial<SlackCausePolicy>>)) {
    causes[cause] = {
      enabled: v.enabled ?? causes[cause]?.enabled ?? true,
      cooldown_min: Number(v.cooldown_min ?? causes[cause]?.cooldown_min ?? SLACK_POLICY_DEFAULTS.default_cooldown_min),
    };
  }
  const { causes: _drop, ...policyScalars } = rawPolicy;
  const slack: SlackConfig = {
    ...SLACK_DEFAULTS,
    ...(raw as Partial<SlackConfig>),
    users: { ...((raw.users ?? {}) as Record<string, string>) },
    policy: { ...SLACK_POLICY_DEFAULTS, ...(policyScalars as Partial<SlackPolicyConfig>), causes },
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
 * all is required — the concierge is simply not there. */
function checkSlackShape(slack: SlackConfig): void {
  if (!slack.enabled) return;
  const fail = (msg: string): never => {
    throw new Error(`config.toml [slack]: ${msg}`);
  };
  if (!slack.channel.trim()) fail("enabled = true requires a non-empty `channel`");
  if (slack.channel_kind !== "public" && slack.channel_kind !== "private") {
    fail(`channel_kind must be "public" or "private" (got ${JSON.stringify(slack.channel_kind)})`);
  }
  if (!slack.legacy_owner_slack_id.trim()) fail("enabled = true requires a non-empty `legacy_owner_slack_id`");
  if (!(slack.legacy_owner_slack_id in slack.users)) {
    fail(`legacy_owner_slack_id '${slack.legacy_owner_slack_id}' must appear as a key in [slack.users] (it is the only source of own-PR rights)`);
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
  checkSlackShape(cfg.slack);
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
