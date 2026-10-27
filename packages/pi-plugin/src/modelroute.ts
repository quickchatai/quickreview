// Which provider a model spec runs on, given the logins that exist.
//
// pi offers three OpenAI logins, and they land on two providers:
//   - "OpenAI Codex (legacy)" (an OAuth login) is the provider `openai-codex`;
//   - "Sign in with ChatGPT" (pi 1.4's newer OAuth login) is the provider `openai`;
//   - an OpenAI API key (stored by /login, or OPENAI_API_KEY) is also `openai`.
// Both providers serve the same model ids (pi-ai's catalogs carry gpt-6.1-sol
// on each), so one login is as good as the other for a review. The shipped
// specs name `openai-codex/…`, the route the production install logged in
// with, and stay that way: this module only reroutes a spec whose named
// provider has no usable credential while its twin has one. The provider a
// spec names always wins when its credential exists, so an install that works
// today runs exactly as before.
//
// Pure: the caller says which providers have a credential. The SDK host asks
// pi's own ModelRuntime (packages/pi-plugin/src/engine/pisdk.ts); a CLI pi is
// rerouted by its own extension from pi's model registry
// (extensions/login-route.ts); a host that only has a login FILE (the companion
// entrypoint's default model) reads it with `providersInAuthJson`.

import type { CoreConfig } from "./reviewconfig.js";

/** The providers the review's sessions run on: every model spec's
 * `provider/` prefix, in first-seen order. */
export function reviewProviders(cfg: Pick<CoreConfig, "models">): string[] {
  const m = cfg.models;
  const specs = [
    m.conversation,
    m.default,
    ...Object.values(m.tiers),
    ...Object.values(m.pass_models),
  ];
  const out: string[] = [];
  for (const spec of specs) {
    const slash = spec.indexOf("/");
    if (slash <= 0) continue;
    const p = spec.slice(0, slash);
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** The OpenAI providers, each the other's twin. */
export const OPENAI_PROVIDERS: readonly string[] = ["openai-codex", "openai"];

/** The provider that serves the same models on another OpenAI login, or
 * undefined for a provider outside the family. */
export function twinProvider(provider: string): string | undefined {
  if (provider === "openai-codex") return "openai";
  if (provider === "openai") return "openai-codex";
  return undefined;
}

/** A spec taken apart at its first `/`: `provider/rest`, where `rest` is the
 * model id with any `:thinking` suffix left on. Null for a bare id. */
export function splitProvider(spec: string): { provider: string; rest: string } | null {
  const at = spec.indexOf("/");
  if (at <= 0 || at === spec.length - 1) return null;
  return { provider: spec.slice(0, at), rest: spec.slice(at + 1) };
}

/** The model id of a spec's `rest`: the `:thinking` suffix dropped. */
export function modelIdOf(rest: string): string {
  const colon = rest.lastIndexOf(":");
  return colon > 0 ? rest.slice(0, colon) : rest;
}

export interface ProviderProbe {
  /** Does this provider have a usable credential? */
  hasCredential(provider: string): boolean;
  /** Does this provider serve this model id? Omitted: assume it does (the
   * OpenAI twins carry the same catalog). */
  hasModel?(provider: string, modelId: string): boolean;
}

/** The provider to run `provider`'s model `modelId` on: `provider` itself when
 * it has a credential (or when nothing better exists), else its OpenAI twin
 * when the twin has one and serves the model. */
export function routeProvider(provider: string, modelId: string, probe: ProviderProbe): string {
  if (probe.hasCredential(provider)) return provider;
  const twin = twinProvider(provider);
  if (twin === undefined || !probe.hasCredential(twin)) return provider;
  if (probe.hasModel && !probe.hasModel(twin, modelId)) return provider;
  return twin;
}

/** A whole spec (`provider/id[:thinking]`) rerouted by `routeProvider`; a spec
 * with no provider prefix is returned as given. */
export function routeModelSpec(spec: string, probe: ProviderProbe): string {
  const parts = splitProvider(spec);
  if (parts === null) return spec;
  const provider = routeProvider(parts.provider, modelIdOf(parts.rest), probe);
  return provider === parts.provider ? spec : `${provider}/${parts.rest}`;
}

/** The providers a pi `auth.json` holds a credential for: every entry of type
 * "oauth" or "api_key" (pi's two stored credential shapes; an api_key's `key`
 * may be a literal, an env name or a `!command`, all of which count). An API key
 * in `OPENAI_API_KEY` counts for `openai`, as pi's own env lookup does. Text
 * that does not parse holds nothing. */
export function providersInAuthJson(
  raw: string | null,
  env: Readonly<Record<string, string | undefined>> = {},
): Set<string> {
  const out = new Set<string>();
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === "object" && parsed !== null)
        for (const [name, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v !== "object" || v === null) continue;
          const type = (v as Record<string, unknown>)["type"];
          if (type === "oauth") out.add(name);
          else if (type === "api_key") {
            const key = (v as Record<string, unknown>)["key"];
            if (typeof key === "string" && key.trim() !== "") out.add(name);
          }
        }
    } catch {
      // an unreadable login holds no credential
    }
  }
  if ((env["OPENAI_API_KEY"] ?? "").trim() !== "") out.add("openai");
  return out;
}

/** `routeModelSpec` over a login file's text (null: no file) and the env the
 * pi will run with: for a host that starts a CLI pi on a login it holds as a
 * file (a takeover's or a debug round's borrowed copy). */
export function routeModelSpecForLogin(
  spec: string,
  authJson: string | null,
  env: Readonly<Record<string, string | undefined>> = {},
): string {
  const have = providersInAuthJson(authJson, env);
  return routeModelSpec(spec, { hasCredential: (p) => have.has(p) });
}
