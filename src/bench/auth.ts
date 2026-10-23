// The benchmark's pi login: a ChatGPT login volume, READ-ONLY, never refreshed.
//
// The login volume (default: the operator's companion's) is reused. Sharing its
// agent/ dir read-write would let a prompt-injected review write the
// companion's persistent pi config — AGENTS.md, skills/, extensions/, bin/ —
// which the companion loads with its much wider authority. So the companion's
// dir is mounted read-only at `/pi-agent-src`, and every case gets a private
// copy of the access token in a tmpfs agent dir, with the refresh token
// replaced by a value no OAuth server accepts (src/engine/auth.ts, the copy the
// scan sandbox takes too). The sandbox therefore:
//   - never writes anything the companion reads;
//   - never refreshes, so it can never rotate (and invalidate) the companion's
//     grant — which a second refresher would do;
//   - picks up a token the companion refreshed, because the copy is re-taken
//     from the live read-only source before every case.
// The price: a run cannot outlive the access token. `syncBenchAuth` checks the
// remaining life against the case budget BEFORE the case starts and stops the
// run with a clear instruction, instead of failing case after case.

import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  AuthExpiring,
  authCopyFrom,
  BENCH_AUTH_WORDS,
  copyPiAuth,
  DISABLED_REFRESH,
} from "../engine/auth.js";
import { benchSettings } from "../pibuiltins.js";
import {
  benchAuthMode,
  benchProvider,
  KEY_ROUTE_PROVIDERS,
  type BenchAuthMode,
  type BenchProviderId,
} from "../engine/keyroute.js";

// The credential route itself (the mode, the model rewrite, the keys a pi
// process sees) and the sandbox's pi settings are the one-shot round's, so
// core (src/engine/keyroute.ts, src/pibuiltins.ts); the bench's callers still
// import them here.
export { BENCH_RETRY, benchSettings } from "../pibuiltins.js";
export {
  apiKeyEnv,
  benchAuthMode,
  benchProvider,
  modelForAuth,
  type BenchAuthMode,
  type BenchProviderId,
} from "../engine/keyroute.js";

// The API-key route: the published runs used the login above; an outsider
// re-running the benchmark brings their own API key instead.
// `QCR_BENCH_AUTH=api-key` (set by bench.sh from the host's QCR_BENCH_AUTH):
//   - no login is mounted or read: the sandbox's agent dir gets an EMPTY
//     auth.json, so pi resolves every provider's key from the environment
//     (OPENAI_API_KEY / ANTHROPIC_API_KEY, passed by --env-file, never argv);
//   - every `openai-codex/` model spec (the ChatGPT-login provider) is
//     rewritten to `openai/` — the same model id on the public OpenAI API;
//   - every run fingerprint carries `auth: "api-key"`, so a keyed run never
//     resumes over, or is mixed with, a login run.

/** The benchmark's custom provider. Credentials remain environment references. */
export function digitalOceanModels() {
  return {
    providers: {
      digitalocean: {
        baseUrl: "https://inference.do-ai.run/v1",
        api: "openai-completions",
        apiKey: "${DIGITALOCEAN_API_KEY}",
        // Limits and $/1M prices from DigitalOcean's model catalog and pricing
        // pages (2026-10-13); maxTokens is the output budget pi asks for.
        models: [
          {
            id: "glm-5.3-flash",
            name: "GLM-5.3 Flash (DigitalOcean)",
            reasoning: true,
            input: ["text"],
            contextWindow: 1048576,
            maxTokens: 65536,
            cost: { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 },
          },
          {
            id: "gemma-4-31B-it",
            name: "Gemma 4 31B (DigitalOcean)",
            reasoning: true,
            input: ["text"],
            contextWindow: 256000,
            maxTokens: 8192,
            cost: { input: 0.18, output: 0.5, cacheRead: 0.036, cacheWrite: 0 },
          },
          {
            id: "deepseek-v4.1-flash",
            name: "DeepSeek V4.1 Flash (DigitalOcean)",
            reasoning: true,
            input: ["text"],
            contextWindow: 1048576,
            maxTokens: 65536,
            cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
            // DigitalOcean refuses `none`, `minimal` and `medium` for this
            // model (400 "… reasoning effort is not supported"); it takes low,
            // high, xhigh and max. Every tier's level is sent as the nearest
            // one it accepts at or above it — never less reasoning than asked.
            thinkingLevelMap: { off: null, minimal: "low", medium: "high" },
          },
        ],
      },
    },
  };
}

/** Gemini models pi 1.0.0's bundled catalog predates, added to its BUILT-IN
 * `google` provider (pi: "a `models` entry adds or replaces a model with the
 * same ID on that provider") — the native Gemini API, `GEMINI_API_KEY`, pi's
 * own Google request handling. Limits and list prices from Google's Gemini API
 * pricing page (2026-10-14; the introductory rates, which double on
 * 2026-12-01). Thinking levels as pi lists them for the Gemini Pro line:
 * low/medium/high, no off/minimal/xhigh/max. */
export function googleModels() {
  return {
    providers: {
      google: {
        models: [
          {
            id: "gemini-4-argon",
            name: "Gemini 4 Argon",
            api: "google-generative-ai",
            reasoning: true,
            input: ["text"],
            contextWindow: 1048576,
            maxTokens: 65536,
            cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 },
            thinkingLevelMap: { off: null, minimal: null, xhigh: null, max: null },
          },
        ],
      },
    },
  };
}

/** The review providers an API-key bench run can use besides OpenAI/Anthropic:
 * the key a sandbox's pi needs (by name; the value rides bench.sh's --env-file)
 * and the models.json the sandbox gets. */
export const BENCH_PROVIDERS = {
  digitalocean: { keyVar: KEY_ROUTE_PROVIDERS.digitalocean, models: digitalOceanModels },
  google: { keyVar: KEY_ROUTE_PROVIDERS.google, models: googleModels },
} as const satisfies Record<BenchProviderId, { keyVar: string; models: () => unknown }>;

/** Spread into an arm's fingerprint: empty on the login route (so every
 * published fingerprint is unchanged), `{ auth: "api-key" }` on the key route. */
export function authFingerprint(mode: BenchAuthMode = benchAuthMode()): {
  auth?: "api-key";
  inference?: { provider: BenchProviderId; config_sha256: string };
} {
  const provider = benchProvider();
  return mode === "api-key"
    ? {
        auth: "api-key",
        ...(provider
          ? {
              inference: {
                provider,
                config_sha256: createHash("sha256")
                  .update(JSON.stringify(BENCH_PROVIDERS[provider].models()))
                  .digest("hex"),
              },
            }
          : {}),
      }
    : {};
}

export { AuthExpiring, DISABLED_REFRESH };

/**
 * The sandbox copy of a pi `auth.json` (src/engine/auth.ts `authCopyFrom`):
 * every OAuth entry's refresh token replaced, everything else kept, and the
 * earliest OAuth expiry so the caller can refuse a case that would outlive it.
 */
export function benchAuthFrom(raw: string): { json: string; expiresAt: number | null } {
  const { json, expiresAt } = authCopyFrom(raw);
  return { json, expiresAt };
}

/**
 * Refresh the sandbox's agent dir from the read-only source. Throws
 * `AuthExpiring` when the token would expire inside `needMs` — the operator's
 * fix is to use the companion once (it refreshes its own login), then resume.
 */
export function syncBenchAuth(o: {
  srcDir: string;
  dstDir: string;
  root: string;
  needMs: number;
  now?: () => number;
  /** Default: `benchAuthMode()` — the key route reads no login at all. */
  mode?: BenchAuthMode;
}): { expiresAt: number | null } {
  // Each sandbox owns this file. Switching routes must not keep an earlier
  // provider active (pi loads models.json independently of auth.json).
  const provider = benchProvider();
  if (!provider) rmSync(join(o.dstDir, "models.json"), { force: true });
  if ((o.mode ?? benchAuthMode()) === "api-key") {
    // No login: an empty auth.json, so pi takes each provider's key from the
    // environment. Nothing is read from srcDir (bench.sh mounts nothing there).
    mkdirSync(o.dstDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(o.dstDir, "auth.json"), "{}\n", { mode: 0o600 });
    chmodSync(join(o.dstDir, "auth.json"), 0o600);
    writeBenchSettings(o.dstDir, o.root);
    if (provider) {
      writeFileSync(
        join(o.dstDir, "models.json"),
        JSON.stringify(BENCH_PROVIDERS[provider].models(), null, 2) + "\n",
        { mode: 0o600 },
      );
      chmodSync(join(o.dstDir, "models.json"), 0o600);
    }
    return { expiresAt: null };
  }
  const { expiresAt } = copyPiAuth({
    srcDir: o.srcDir,
    dstDir: o.dstDir,
    needMs: o.needMs,
    ...(o.now ? { now: o.now } : {}),
    words: BENCH_AUTH_WORDS,
  });
  writeBenchSettings(o.dstDir, o.root);
  return { expiresAt };
}

/** The sandbox's pi settings and project trust (`benchSettings`), into its
 * agent dir — the same on either credential route. */
function writeBenchSettings(dstDir: string, root: string): void {
  const { settings, trust } = benchSettings(root);
  writeFileSync(join(dstDir, "settings.json"), settings);
  writeFileSync(join(dstDir, "trust.json"), trust);
}
