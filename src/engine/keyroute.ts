// The credential route a one-shot round runs on. Shared by the bench and
// `qcr review`, so it is core; the bench's login handling and its provider
// catalogs stay in src/bench/auth.ts.
//
// The published bench runs used a ChatGPT login; an outsider re-running the
// benchmark brings an API key instead. `QCR_BENCH_AUTH=api-key`:
//   - every `openai-codex/` model spec (the ChatGPT-login provider) is
//     rewritten to `openai/`, the same model id on the public OpenAI API;
//   - a pi process sees the provider's key, by NAME from the environment
//     (`apiKeyEnv`), never on argv.
import { RUNTIME_KEY_ENVS } from "./auth.js";

export type BenchAuthMode = "login" | "api-key";

/** The review providers an API-key run can use besides OpenAI/Anthropic, and
 * the key each one's pi needs (src/bench/auth.ts `BENCH_PROVIDERS` adds the
 * models.json a bench sandbox gets). */
export const KEY_ROUTE_PROVIDERS = {
  digitalocean: RUNTIME_KEY_ENVS["digitalocean"]!,
  google: RUNTIME_KEY_ENVS["google"]!,
} as const;
export type BenchProviderId = keyof typeof KEY_ROUTE_PROVIDERS;

export function benchProvider(env: NodeJS.ProcessEnv = process.env): BenchProviderId | undefined {
  const provider = env["QCR_BENCH_PROVIDER"];
  if (!provider) return undefined;
  if (Object.hasOwn(KEY_ROUTE_PROVIDERS, provider)) return provider as BenchProviderId;
  throw new Error(
    `QCR_BENCH_PROVIDER must be ${Object.keys(KEY_ROUTE_PROVIDERS).join(" | ")} or unset`,
  );
}

/** The sandbox's credential route, from `QCR_BENCH_AUTH` (unset = login). */
export function benchAuthMode(env: NodeJS.ProcessEnv = process.env): BenchAuthMode {
  const v = (env["QCR_BENCH_AUTH"] ?? "").trim();
  if (v === "" || v === "login") return "login";
  if (v === "api-key") return "api-key";
  throw new Error(`QCR_BENCH_AUTH must be login | api-key (got "${v}")`);
}

/** A pi model spec as it runs under `mode`: the ChatGPT-login provider
 * `openai-codex/` becomes the public API's `openai/` on the key route;
 * every other spec (and every spec on the login route) is unchanged. */
export function modelForAuth(spec: string, mode: BenchAuthMode = benchAuthMode()): string {
  return mode === "api-key" ? spec.replace(/^openai-codex\//, "openai/") : spec;
}

/** The API keys a pi process may see on the key route — read from the
 * container's environment (bench.sh's --env-file), passed on by NAME only.
 * Empty on the login route, so nothing changes there. */
export function apiKeyEnv(
  mode: BenchAuthMode = benchAuthMode(),
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if (mode !== "api-key") return {};
  const out: Record<string, string> = {};
  const provider = benchProvider(env);
  const keys = provider ? [KEY_ROUTE_PROVIDERS[provider]] : ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"];
  for (const k of keys) {
    const v = env[k];
    if (v) out[k] = v;
  }
  return out;
}
