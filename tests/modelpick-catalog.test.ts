// The pick rule (packages/pi-plugin/src/modelpick.ts) over the installed pi's
// own catalog: for every built-in provider, how many models are candidates,
// what pi's default is, and which model a review with nothing pinned runs on.
//
// VERIFY-ON-PIN: a snapshot on purpose. The rule names no model, so this
// table is the one place that says what it picks today, and it changes
// whenever pi's catalog or pi's default table does. On a pi bump, read the
// diff row by row: a new flagship moving a row is the rule working; a row
// moving to a small tier or to another family is the rule misfiring.
//
// pi's default per provider is read by a deep import of its model-resolver
// table: the package exports only its root, so a file path is the way in. A
// test may do that; the core may not, and reads the same table through pi's
// root export instead.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";
import {
  candidatesOf,
  listPrice,
  pickModel,
  type PickableModel,
} from "@quickchatai/pi-quickreview/src/modelpick.js";

const root = join(import.meta.dirname, "..");
const { defaultModelPerProvider } = (await import(
  pathToFileURL(
    join(root, "node_modules/@earendil-works/pi-coding-agent/dist/core/model-resolver.js"),
  ).href
)) as { defaultModelPerProvider: Record<string, string | undefined> };

/** `provider, candidates, pi's default, the pick, how`. `how` is one of:
 * `default` (the newest is pi's default); `ratio n.nn` (the newest, at that
 * share of the default's list price); `unpriced default`, `no default` and
 * `default not in catalog` (the newest, with nothing to guard it against);
 * `guard: <id>` (pi's default, since that newest is priced far below it);
 * `no candidate` (pi's default, since no model passes the filter); `none`
 * (the provider has no model the rule can pick). */
type Row = [
  provider: string,
  candidates: number,
  piDefault: string | null,
  pick: string | null,
  how: string,
];

const PICKS: Row[] = [
  ["amazon-bedrock", 147, "us.anthropic.claude-opus-4-6-v1", "openai.gpt-6.1-sol", "ratio 0.40"],
  ["ant-ling", 1, "Ring-2.6-1T", "Ring-2.6-1T", "default"],
  ["anthropic", 14, "claude-opus-4-8", "claude-opus-5-5", "ratio 0.80"],
  ["azure", 20, "gpt-5.4", "gpt-6.1-sol", "ratio 0.69"],
  ["baseten", 8, "zai-org/GLM-5.2", "zai-org/GLM-5.3", "ratio 1.00"],
  ["cerebras", 2, "gpt-oss-120b", "qwen-3.8-27b", "ratio 2.25"],
  ["cloudflare-ai-gateway", 40, "workers-ai/@cf/moonshotai/kimi-k2.6", "gpt-6.1-sol", "ratio 2.42"],
  ["cloudflare-workers-ai", 13, "@cf/moonshotai/kimi-k2.6", "@cf/zai-org/glm-5.3", "ratio 1.17"],
  ["deepseek", 2, "deepseek-v4-pro", "deepseek-v4-pro", "default"],
  [
    "fireworks",
    20,
    "accounts/fireworks/models/kimi-k3",
    "accounts/fireworks/models/kimi-k3",
    "default",
  ],
  ["github-copilot", 26, "gpt-6.1-sol", "gpt-6.1-sol", "default"],
  ["google", 19, "gemini-3.1-pro-preview", "gemini-4-argon", "ratio 0.86"],
  ["google-vertex", 10, "gemini-3.1-pro-preview", "gemini-4-argon", "ratio 0.86"],
  ["groq", 5, "openai/gpt-oss-120b", "qwen/qwen3.8-27b", "ratio 6.40"],
  ["huggingface", 49, "moonshotai/Kimi-K2.6", "zai-org/GLM-5.3", "ratio 1.17"],
  ["kimi-coding", 2, "kimi-for-coding", "k3", "ratio 3.64"],
  ["meta", 4, "muse-spark-1.3", "muse-spark-1.3", "default"],
  ["minimax", 3, "MiniMax-M2.7", "MiniMax-M3.1-Flash", "ratio 0.50"],
  ["minimax-cn", 3, "MiniMax-M2.7", "MiniMax-M3.1-Flash", "ratio 0.48"],
  ["mistral", 11, "devstral-medium-latest", "zai-glm-5-3", "ratio 2.42"],
  ["moonshotai", 3, "kimi-k2.6", "kimi-k3", "ratio 3.64"],
  ["moonshotai-cn", 3, "kimi-k2.6", "kimi-k3", "ratio 3.60"],
  ["nvidia", 14, "nvidia/nemotron-3.5-super-vl-120b-a12b", "z-ai/glm-5.3", "unpriced default"],
  ["openai", 19, "gpt-5.5", "gpt-6.1-sol", "ratio 0.34"],
  ["openai-codex", 7, "gpt-6.1-sol", "gpt-6.1-sol", "default"],
  ["opencode", 69, "kimi-k2.6", "gpt-6.1-sol", "ratio 2.42"],
  ["opencode-go", 27, "kimi-k3", "kimi-k3", "guard: gpt-6-luna"],
  ["openrouter", 243, "moonshotai/kimi-k2.6", "openai/gpt-6.1-sol", "ratio 2.96"],
  ["qwen-token-plan", 18, "qwen3.7-max", "glm-5.3", "unpriced default"],
  ["qwen-token-plan-cn", 18, "qwen3.7-max", "glm-5.3", "unpriced default"],
  ["qwen-token-plan-individual", 8, "qwen3.8-max", "glm-5.2", "unpriced default"],
  ["radius", 30, "balanced", "gpt-6.1-sol", "ratio 0.67"],
  ["together", 14, "moonshotai/Kimi-K3", "zai-org/GLM-5.3", "ratio 0.32"],
  ["typesafe", 0, null, null, "none"],
  ["vercel-ai-gateway", 139, "zai/glm-5.1", "openai/gpt-6.1-sol", "ratio 2.07"],
  ["xai", 4, "grok-4.7", "grok-4.7", "default"],
  ["xiaomi", 2, "mimo-v2.6-pro", "mimo-v2.6-pro", "default"],
  ["xiaomi-token-plan-ams", 2, "mimo-v2.6-pro", "mimo-v2.6-pro", "default"],
  ["xiaomi-token-plan-cn", 2, "mimo-v2.6-pro", "mimo-v2.6-pro", "default"],
  ["xiaomi-token-plan-sgp", 2, "mimo-v2.6-pro", "mimo-v2.6-pro", "default"],
  ["zai", 4, "glm-5.3", "glm-5.3", "default"],
  ["zai-coding-cn", 2, "glm-5.3", "glm-5.3", "default"],
];

/** The provider's chat models, as the rule reads them. */
function chatModels(provider: string): PickableModel[] {
  return getBuiltinModels(provider as Parameters<typeof getBuiltinModels>[0]);
}

function rowOf(provider: string): Row {
  const models = chatModels(provider);
  const piDefaultId = defaultModelPerProvider[provider];
  const candidates = candidatesOf(models, piDefaultId).length;
  const got = pickModel(models, piDefaultId);
  if (got === null) return [provider, candidates, piDefaultId ?? null, null, "none"];
  const def = models.find((m) => m.id === piDefaultId);
  const how = got.guarded
    ? `guard: ${got.newest?.id}`
    : got.pick === "pi-default"
      ? "no candidate"
      : got.model.id === piDefaultId
        ? "default"
        : piDefaultId === undefined
          ? "no default"
          : def === undefined
            ? "default not in catalog"
            : listPrice(def) > 0
              ? `ratio ${(listPrice(got.model) / listPrice(def)).toFixed(2)}`
              : "unpriced default";
  return [provider, candidates, piDefaultId ?? null, got.model.id, how];
}

describe("the pick rule over pi's catalog", () => {
  // MUTATION: set GUARD_RATIO to 0.5 in modelpick.ts — the `openai` row
  // (0.34) and the `together` row (0.32) fall back to pi's default and this
  // fails. Set it to 0.01 and the `opencode-go` row runs the small tier.
  // MUTATION: return `ranked` unfiltered from withoutVariants — the
  // `vercel-ai-gateway`, `fireworks`, `baseten` and `xiaomi` rows pick a
  // speed tier and this fails.
  it("every built-in provider picks the model the table names", () => {
    const providers = [...getBuiltinProviders()].sort();
    expect(providers.map(rowOf)).toEqual(PICKS);
  });

  // Stated apart from the table, so a re-snapshot of the table cannot move
  // one of these without this test saying so.
  // MUTATION: set GUARD_RATIO to 0.5 in modelpick.ts — `openai` falls back
  // to pi's older default and this fails.
  it("reproduces the picks the rule was chosen for", () => {
    const pick = (provider: string): string | undefined =>
      pickModel(chatModels(provider), defaultModelPerProvider[provider])?.model.id;
    for (const provider of ["openai", "azure", "radius", "opencode", "cloudflare-ai-gateway"])
      expect(pick(provider), provider).toBe("gpt-6.1-sol");
    for (const provider of ["github-copilot", "openai-codex"])
      expect(pick(provider), provider).toBe("gpt-6.1-sol");
    expect(pick("anthropic")).toBe("claude-opus-5-5");
    expect(pick("google")).toBe("gemini-4-argon");
    expect(pick("xai")).toBe("grok-4.7");
    expect(pick("deepseek")).toBe("deepseek-v4-pro");
    // The one aggregator whose newest version is a small tier: the guard
    // sends it to pi's default.
    expect(pick("opencode-go")).toBe(defaultModelPerProvider["opencode-go"]);
  });
});
