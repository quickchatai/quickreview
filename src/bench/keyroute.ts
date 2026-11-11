// The benchmark's credential route. It is the bench's alone: no shipped module
// imports this file (the package leaves `src/bench/` out), and a review outside
// the bench runs on whatever credential pi has, with no switch and no rewrite.
//
// The published bench runs used a ChatGPT login; an outsider re-running the
// benchmark brings an API key instead. `QCR_BENCH_AUTH=api-key`:
//   - every `openai-codex/` model spec (the ChatGPT-login provider) of the
//     bench's config is rewritten to `openai/`, the same model id on the public
//     OpenAI API (`withAuthModels`, applied by the bench's `contextFor`,
//     src/bench/runner.ts);
//   - a pi child process the bench starts sees the provider's key, by NAME from
//     the environment (`apiKeyEnv`), never on argv. A case the bench hosts in
//     its own process needs no copy: pi looks the key up in that process's
//     environment.
//
// A bench plan keeps explicit pins, so the names here are the plans' own.
import type { CoreConfig } from "@quickchatai/pi-quickreview/src/reviewconfig.js";

export type BenchAuthMode = "login" | "api-key";

/** The review providers an API-key run can use besides OpenAI/Anthropic, and
 * the key variable each one's pi reads (src/bench/auth.ts `BENCH_PROVIDERS`
 * adds the models.json a bench sandbox gets). */
export const KEY_ROUTE_PROVIDERS = {
  digitalocean: "DIGITALOCEAN_API_KEY",
  google: "GEMINI_API_KEY",
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

/** Every model spec of the config as it runs on the bench's credential route:
 * on the API-key route `openai-codex/` → `openai/`, the same model on the
 * public API; on the login route the config unchanged. A spec that names no
 * model (an unpinned config's `""` or bare level) names no provider and stays. */
export function withAuthModels<C extends Pick<CoreConfig, "models">>(
  cfg: C,
  mode: BenchAuthMode = benchAuthMode(),
): C {
  if (mode !== "api-key") return cfg;
  const out = structuredClone(cfg);
  const m = out.models;
  m.model = modelForAuth(m.model, mode);
  for (const k of Object.keys(m.tiers) as (keyof typeof m.tiers)[])
    m.tiers[k] = modelForAuth(m.tiers[k], mode);
  for (const pass of Object.keys(m.pass_models))
    m.pass_models[pass] = modelForAuth(m.pass_models[pass]!, mode);
  return out;
}

/** The API keys a pi child process may see on the key route — read from the
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
