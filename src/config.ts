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
}

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
