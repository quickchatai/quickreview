// Typed access to config.toml — the single source of every runtime knob.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";

export interface GithubConfig {
  repo: string;
  app_slug: string;
  bot_login: string;
  review_team: string;
  escalation_reviewer: string;
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

export interface Config {
  dry_run: boolean;
  github: GithubConfig;
  server: { hostname: string; port: number };
  daemon: {
    poll_interval_s: number;
    max_concurrent_rounds: number;
    round_deadline_min: number;
    overseer_rotation_days: number;
  };
  eod: { time: string; timezone: string };
  caps: {
    improvement_pr_max_lines: number;
    improvement_pr_max_files: number;
    improvement_pr_per_day: number;
    improvement_pr_per_week: number;
    issues_per_day: number;
  };
  models: { default: string; conversation: string; overseer: string; passes: Record<string, string> };
  pi: { package: string; version: string; session_dir: string };
  tui: TuiConfig;
  companion: CompanionConfig;
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
  overdue_grace_min: 30,
  stale_alert_s: 300,
  awaiting_age_h: 24,
  cooldown_min: 20,
};

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
  };
}

function req(obj: Record<string, unknown>, key: string): unknown {
  const v = obj[key];
  if (v === undefined) throw new Error(`config.toml: missing key '${key}'`);
  return v;
}

export function parseConfig(toml: string): Config {
  const raw = parse(toml) as Record<string, any>;
  const cfg: Config = {
    dry_run: Boolean(req(raw, "dry_run")),
    github: { ...(req(raw, "github") as GithubConfig) },
    server: { ...(req(raw, "server") as Config["server"]) },
    daemon: { ...(req(raw, "daemon") as Config["daemon"]) },
    eod: { ...(req(raw, "eod") as Config["eod"]) },
    caps: { ...(req(raw, "caps") as Config["caps"]) },
    models: { ...(req(raw, "models") as Omit<Config["models"], "passes">), passes: (raw.models?.passes ?? {}) as Record<string, string> },
    pi: { ...(req(raw, "pi") as Config["pi"]) },
    tui: { ...TUI_DEFAULTS, ...((raw.tui ?? {}) as Partial<TuiConfig>) },
    companion: resolveCompanionPaths({ ...COMPANION_DEFAULTS, ...((raw.companion ?? {}) as Partial<CompanionConfig>) }),
  };
  for (const k of [
    "repo", "app_slug", "bot_login", "review_team", "escalation_reviewer",
    "trigger_label", "in_progress_label", "reviewed_label", "improvement_label",
    "issue_label", "secrets_dir",
  ] as const) req(cfg.github as unknown as Record<string, unknown>, k);
  cfg.github.secrets_dir = expandHome(cfg.github.secrets_dir);
  return cfg;
}

let cached: Config | null = null;

export function loadConfig(path?: string): Config {
  if (cached && !path) return cached;
  const p = path ?? resolve(sandboxRoot(), "config.toml");
  const cfg = parseConfig(readFileSync(p, "utf8"));
  if (!path) cached = cfg;
  return cfg;
}

/** Model for a given pass agent, honoring the per-pass override knob. */
export function modelForPass(cfg: Config, passName: string): string {
  return cfg.models.passes[passName] ?? cfg.models.default;
}
