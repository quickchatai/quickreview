// The lens tool's env: the names its config rides on (round.ts and the bench
// set them from `[engine] lens_*`; the companion's launch line sets the cap)
// and the readers that turn them back into numbers. Pure. The names keep their
// `QCR_SUBAGENT_` spelling: they predate the lens tool, and the env inventory
// (packages/pi-plugin/src/engine/envmap.ts) and every launch line already carry them.

/** Env var pinning the agent discovery scope (`user` | `project`); read by
 * `lensAgentsDir` (round-lens.ts). */
export const SCOPE_ENV = "QCR_SUBAGENT_SCOPE";

/** Env var carrying the process-wide cap on running lens sessions. */
export const CONCURRENCY_ENV = "QCR_SUBAGENT_MAX_CONCURRENCY";

/** Env var: sessions per shared cache key; 0 or unset ⇒ a random id each. */
export const CACHE_GROUP_ENV = "QCR_SUBAGENT_CACHE_GROUP";

/** Env var: how long a group's later sessions start after its first. */
export const CACHE_STAGGER_ENV = "QCR_SUBAGENT_CACHE_STAGGER_MS";

/** Default process-wide cap, the companion's desktop number. Equal to
 * `DEFAULT_LENS_MAX_CONCURRENCY` (config.ts; this file imports nothing from the
 * daemon), pinned by a test. */
export const DEFAULT_MAX_CONCURRENCY = 4;

/** Equal to `DEFAULT_LENS_CACHE_STAGGER_MS` (config.ts), pinned by a test. */
export const DEFAULT_CACHE_STAGGER_MS = 2500;

/** Resolve the process-wide cap from the environment (invalid/absent → 4).
 * Strict digits only — "1e3" or "6x" is a misconfiguration, and a
 * misconfiguration falls back to the safe default rather than whatever
 * parseInt salvages from the prefix. */
export function resolveMaxConcurrency(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = (env[CONCURRENCY_ENV] ?? "").trim();
  if (!/^\d{1,2}$/.test(raw)) return DEFAULT_MAX_CONCURRENCY;
  const n = Number.parseInt(raw, 10);
  return n >= 1 && n <= 64 ? n : DEFAULT_MAX_CONCURRENCY;
}

function nonNegativeInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function resolveCacheGroup(env: Record<string, string | undefined> = process.env): number {
  return nonNegativeInt(env[CACHE_GROUP_ENV], 0);
}

export function resolveCacheStagger(env: Record<string, string | undefined> = process.env): number {
  return nonNegativeInt(env[CACHE_STAGGER_ENV], DEFAULT_CACHE_STAGGER_MS);
}
