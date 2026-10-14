// The benchmark's pi login: a ChatGPT login volume, READ-ONLY, never refreshed.
//
// The login volume (default: the operator's companion's) is reused. Sharing its
// agent/ dir read-write would let a prompt-injected review write the
// companion's persistent pi config — AGENTS.md, skills/, extensions/, bin/ —
// which the companion loads with its much wider authority. So the companion's
// dir is mounted read-only at `/pi-agent-src`, and every case gets a private
// copy of the access token in a tmpfs agent dir, with the refresh token
// replaced by a value no OAuth server accepts. The sandbox therefore:
//   - never writes anything the companion reads;
//   - never refreshes, so it can never rotate (and invalidate) the companion's
//     grant — which a second refresher would do;
//   - picks up a token the companion refreshed, because the copy is re-taken
//     from the live read-only source before every case.
// The price: a run cannot outlive the access token. `syncBenchAuth` checks the
// remaining life against the case budget BEFORE the case starts and stops the
// run with a clear instruction, instead of failing case after case.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { PI_DISABLED_BUILTINS } from "../pibuiltins.js";

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

export type BenchAuthMode = "login" | "api-key";

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
  digitalocean: { keyVar: "DIGITALOCEAN_API_KEY", models: digitalOceanModels },
  google: { keyVar: "GEMINI_API_KEY", models: googleModels },
} as const;
export type BenchProviderId = keyof typeof BENCH_PROVIDERS;

export function benchProvider(env: NodeJS.ProcessEnv = process.env): BenchProviderId | undefined {
  const provider = env["QCR_BENCH_PROVIDER"];
  if (!provider) return undefined;
  if (Object.hasOwn(BENCH_PROVIDERS, provider)) return provider as BenchProviderId;
  throw new Error(
    `QCR_BENCH_PROVIDER must be ${Object.keys(BENCH_PROVIDERS).join(" | ")} or unset`,
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
  const keys = provider ? [BENCH_PROVIDERS[provider].keyVar] : ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"];
  for (const k of keys) {
    const v = env[k];
    if (v) out[k] = v;
  }
  return out;
}

/** What a copied OAuth credential carries instead of the real refresh token. */
export const DISABLED_REFRESH = "bench-refresh-disabled";

export class AuthExpiring extends Error {}

/**
 * The sandbox copy of a pi `auth.json`: every OAuth entry's refresh token
 * replaced (not deleted — pi's credential guard expects the field to be a
 * string), everything else kept. Returns the earliest OAuth expiry so the
 * caller can refuse a case that would outlive it.
 */
export function benchAuthFrom(raw: string): { json: string; expiresAt: number | null } {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  let expiresAt: number | null = null;
  for (const v of Object.values(parsed)) {
    if (typeof v !== "object" || v === null) continue;
    const cred = v as Record<string, unknown>;
    if (cred["type"] !== "oauth") continue;
    cred["refresh"] = DISABLED_REFRESH;
    if (typeof cred["expires"] === "number") {
      expiresAt = expiresAt === null ? cred["expires"] : Math.min(expiresAt, cred["expires"]);
    }
  }
  return { json: JSON.stringify(parsed, null, 2) + "\n", expiresAt };
}

/** pi's agent-level retry for a benchmark sandbox — every session and every
 * lens child reads it (one agent dir). pi's own default (3 attempts, ≤ 60 s
 * apart) gives up inside two minutes, and a provider's overload window
 * (DigitalOcean "529 Platform overloaded", or a request timeout) is longer than
 * that: the lens is lost and the review posts without it. This backs off from
 * 5 s doubling to a 2-minute cap over 10 attempts — about 13 minutes of
 * patience per request — so a PR is processed fully and fails only when the
 * provider is really unavailable. Provider-level retries stay off (pi's advice:
 * they would hide quota and usage-limit errors from pi). */
export const BENCH_RETRY = { enabled: true, maxRetries: 10, baseDelayMs: 5_000, maxAgentDelayMs: 120_000 } as const;

/** pi's global settings for the sandbox — what the VM entrypoint provisions
 * (deploy/ansible/templates/entrypoint.sh.j2): bash-guard registered globally
 * so lens children load it too; pi's built-in extensions switched off
 * (src/pibuiltins.ts — the reviewed checkout is exactly the untrusted ground a
 * `.pi/mcp.json` would come from); every project trusted so no modal can stall
 * a run; /opt/quickreview pre-trusted; and the durable retry above. */
export function benchSettings(root: string): { settings: string; trust: string } {
  return {
    settings:
      JSON.stringify(
        {
          extensions: [join(root, "extensions", "bash-guard.ts"), ...PI_DISABLED_BUILTINS],
          defaultProjectTrust: "always",
          retry: BENCH_RETRY,
        },
        null,
        2,
      ) + "\n",
    trust: JSON.stringify({ "/opt/quickreview": true }, null, 2) + "\n",
  };
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
    const { settings, trust } = benchSettings(o.root);
    writeFileSync(join(o.dstDir, "settings.json"), settings);
    writeFileSync(join(o.dstDir, "trust.json"), trust);
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
  const src = join(o.srcDir, "auth.json");
  if (!existsSync(src)) {
    throw new AuthExpiring(
      `no pi login at ${src} — log pi in on the auth volume first (/login), or use your own API key: QCR_BENCH_AUTH=api-key (bench/aacr/README.md "Reproduce")`,
    );
  }
  const { json, expiresAt } = benchAuthFrom(readFileSync(src, "utf8"));
  const now = (o.now ?? Date.now)();
  if (expiresAt !== null && expiresAt < now + o.needMs) {
    throw new AuthExpiring(
      `the shared Codex access token expires at ${new Date(expiresAt).toISOString()}, inside this case's ${Math.round(o.needMs / 60_000)}-minute budget. ` +
        "The benchmark never refreshes it (that would invalidate the login's own grant). Use pi on that login volume once so it refreshes its own login, then re-run with --resume — or run on your own API key (QCR_BENCH_AUTH=api-key).",
    );
  }
  mkdirSync(o.dstDir, { recursive: true, mode: 0o700 });
  const tmp = join(o.dstDir, "auth.json.tmp");
  writeFileSync(tmp, json, { mode: 0o600 });
  renameSync(tmp, join(o.dstDir, "auth.json"));
  chmodSync(join(o.dstDir, "auth.json"), 0o600);
  const { settings, trust } = benchSettings(o.root);
  writeFileSync(join(o.dstDir, "settings.json"), settings);
  writeFileSync(join(o.dstDir, "trust.json"), trust);
  return { expiresAt };
}
