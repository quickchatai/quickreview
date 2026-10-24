// pi-ai's own OAuth refresh for a provider: the one file in the refresher that
// touches pi. Deep-imported by file path (the package's export map publishes no
// OAuth flow), like the SDK host's dispatcher (packages/pi-plugin/src/engine/pisdk.ts), so the
// refresh is exactly what pi itself would do. The daemon never imports this
// module: it spawns main.js, which does.
//
// VERIFY-ON-PIN (pi-ai 1.3.0, re-read at 1.4.0): `dist/auth/oauth/load.js` exports the loaders
// below, each resolving to an `OAuthAuth` whose `refresh(credential, signal)`
// returns the new credential. A bump that moves or renames them makes the
// refresh fail loudly (a `login_refresh_failed` anomaly), never silently.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { RefreshFn } from "./refresher.js";

const PI_AI = "@earendil-works/pi-ai";

/** A provider id (its key in auth.json) to the pi-ai loader of its OAuth flow. */
export const OAUTH_LOADERS: Readonly<Record<string, string>> = {
  anthropic: "loadAnthropicOAuth",
  "openai-codex": "loadOpenAICodexOAuth",
  // pi 1.4's "Sign in with ChatGPT" (the provider `openai`, type oauth): a
  // newer OpenAI login is refreshed by the same owner.
  openai: "loadOpenAIChatGPTOAuth",
  "github-copilot": "loadGitHubCopilotOAuth",
  openrouter: "loadOpenRouterOAuth",
  "kimi-coding": "loadKimiCodingOAuth",
  meta: "loadMetaOAuth",
  xai: "loadXaiOAuth",
};

/** The installed pi-ai package directory, found on the module search path. */
export function piAiDir(): string {
  const req = createRequire(import.meta.url);
  for (const base of req.resolve.paths(PI_AI) ?? []) {
    const dir = join(base, PI_AI);
    if (existsSync(join(dir, "package.json"))) return dir;
  }
  throw new Error(`${PI_AI} not found on the module search path`);
}

interface OAuthFlow {
  refresh(credential: unknown, signal: AbortSignal): Promise<Record<string, unknown>>;
}

export const piOAuthRefresh: RefreshFn = async (provider, credential, signal) => {
  const loaderName = OAUTH_LOADERS[provider];
  if (!loaderName) throw new Error(`no pi-ai OAuth flow is known for provider ${provider}`);
  const file = join(piAiDir(), "dist", "auth", "oauth", "load.js");
  const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  const loader = mod[loaderName];
  if (typeof loader !== "function")
    throw new Error(
      `pi-ai's ${loaderName} is gone from ${file}: the pinned pi drifted (VERIFY-ON-PIN)`,
    );
  const flow = await (loader as () => Promise<OAuthFlow>)();
  const fresh = await flow.refresh(credential, signal);
  return fresh;
};
