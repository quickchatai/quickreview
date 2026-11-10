// Canary 13: what pi's registry facade says about a credential.
//
// VERIFY-ON-PIN: the route's inventory (packages/pi-plugin/src/engine/pisdk.ts
// `registryInventory`) sorts every provider's credential into a class from
// three public reads of pi's ModelRegistry, and the order of a route leans on
// the class. Held here against the real pi, through that facade only:
//
//   - a credential in pi's store reports `stored`, whatever its type;
//   - a key in the environment reports `environment` with the variable's own
//     name as the label, which is how a key is told from an ambient cloud
//     identity;
//   - a stored OAuth login reports `isUsingOAuth` even when its token has
//     expired, and nothing refreshes it: reading the inventory never spends
//     the person's refresh token and never reaches out;
//   - a `models.json` key spelled as a variable is the one credential whose
//     status and availability look in different places: the status in the
//     process's environment, availability (and the request) in the host's
//     auth context. So the inventory takes availability as the credential
//     test and reads "not configured" of an available provider as that key.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  PiHost,
  credentialOrigin,
  registryInventory,
} from "@quickchatai/pi-quickreview/src/engine/pisdk.js";
import { useOfflineGuard } from "./harness.js";

useOfflineGuard();

/** A provider with a stored API key, one with a stored (expired) OAuth login
 * that is a subscription, one keyed from the environment, and one with nothing. */
const STORED_KEY = "deepseek";
const STORED_OAUTH = "anthropic";
const ENV_KEYED = "groq";
const ENV_NAME = "GROQ_API_KEY";
const BARE = "xai";
/** A custom provider whose models.json key names a variable that only the
 * host's environment holds. */
const CUSTOM = "canary-custom";
const CUSTOM_ENV = "QCR_CANARY_13_KEY";

type Stored =
  | { type: "api_key"; key: string }
  | { type: "oauth"; access: string; refresh: string; expires: number };

/** A read-only store that records every write pi asks of it. */
function store(data: Record<string, Stored>) {
  const writes: string[] = [];
  return {
    writes,
    credentials: {
      async read(providerId: string) {
        const c = data[providerId];
        return c ? structuredClone(c) : undefined;
      },
      async list() {
        return Object.entries(data).map(([providerId, c]) => ({ providerId, type: c.type }));
      },
      async modify(providerId: string): Promise<undefined> {
        writes.push(`modify ${providerId}`);
        throw new Error("canary 13: the store is read-only");
      },
      async delete(providerId: string): Promise<void> {
        writes.push(`delete ${providerId}`);
        throw new Error("canary 13: the store is read-only");
      },
    },
  };
}

let dir: string;
let host: PiHost | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-canary-status-"));
});

afterEach(() => {
  host?.dispose();
  host = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function rig() {
  const s = store({
    [STORED_KEY]: { type: "api_key", key: "not-a-key" },
    // Expired long ago: a reader that refreshed would have to write.
    [STORED_OAUTH]: { type: "oauth", access: "not-a-token", refresh: "", expires: 1 },
  });
  host = await PiHost.create({
    agentDir: join(dir, "agent"),
    credentials: s.credentials as never,
    authEnv: { [ENV_NAME]: "not-a-key" },
  });
  return { ...s, registry: new ModelRegistry(host.modelRuntime), host };
}

describe("[canary 13] pi's auth status, through the registry facade", () => {
  it("a stored key and a stored login are `stored`; an env key is `environment`, labelled by its variable", async () => {
    const { registry } = await rig();
    expect(registry.getProviderAuthStatus(STORED_KEY)).toEqual({
      configured: true,
      source: "stored",
    });
    expect(registry.getProviderAuthStatus(STORED_OAUTH)).toEqual({
      configured: true,
      source: "stored",
    });
    expect(registry.getProviderAuthStatus(ENV_KEYED)).toEqual({
      configured: true,
      source: "environment",
      label: ENV_NAME,
    });
    expect(registry.getProviderAuthStatus(BARE)).toEqual({ configured: false });
  });

  it("an expired stored login is OAuth, is still available, and is not refreshed", async () => {
    const { registry, writes } = await rig();
    const model = registry.getAvailable().find((m) => m.provider === STORED_OAUTH);
    expect(model, "an expired login still lists its models").toBeDefined();
    expect(registry.isUsingOAuth(model!)).toBe(true);
    expect(registry.isUsingOAuth(registry.getAll().find((m) => m.provider === STORED_KEY)!)).toBe(
      false,
    );
    expect(registry.getProvider(STORED_OAUTH)?.auth.oauth?.isSubscription).toBe(true);
    expect(writes).toEqual([]);
  });

  // MUTATION: return "env-key" for every `environment` status in
  // credentialOrigin — the ambient rows below fail.
  it("the labels pi uses sort into a key in the environment or an ambient identity", () => {
    const env = (label?: string) =>
      credentialOrigin({ source: "environment", ...(label !== undefined ? { label } : {}) });
    for (const key of [ENV_NAME, "ANTHROPIC_OAUTH_TOKEN", "AWS_BEARER_TOKEN_BEDROCK", "HF_TOKEN"])
      expect(env(key), key).toBe("env-key");
    for (const ambient of [
      "AWS_PROFILE",
      "AWS access keys",
      "ECS task role",
      "web identity token",
      "gcloud application default credentials",
      "workload identity federation",
      undefined,
    ])
      expect(env(ambient), String(ambient)).toBe("ambient");
    expect(credentialOrigin({ source: "stored" })).toBe("stored");
    expect(credentialOrigin({ source: "runtime" })).toBe("runtime");
    expect(credentialOrigin({ source: "models_json_key" })).toBe("models-json");
    expect(credentialOrigin({ source: "models_json_command" })).toBe("models-json");
    expect(credentialOrigin({ source: "fallback" })).toBe("ambient");
  });

  // MUTATION: skip a provider whose status is not `configured` in
  // registryInventory — the last row fails. When the first row fails instead,
  // pi's status has started to read the auth context: the inventory's
  // "not configured means that key" reading has nothing left to cover.
  it("a models.json key spelled as a variable: the status looks in the process, availability in the host's environment", async () => {
    const agentDir = join(dir, "agent-envref");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          [CUSTOM]: {
            baseUrl: "http://127.0.0.1:9/v1",
            api: "openai-completions",
            apiKey: `\${${CUSTOM_ENV}}`,
            models: [{ id: "m", name: "m", reasoning: true, input: ["text"] }],
          },
        },
      }),
    );
    expect(process.env[CUSTOM_ENV]).toBeUndefined();
    host = await PiHost.create({ agentDir, authEnv: { [CUSTOM_ENV]: "not-a-key" } });
    const inventory = await host.inventory();
    const registry = new ModelRegistry(host.modelRuntime);
    expect(registry.getProviderAuthStatus(CUSTOM)).toEqual({ configured: false });
    expect(registry.getAvailable().map((m) => `${m.provider}/${m.id}`)).toEqual([`${CUSTOM}/m`]);
    expect(inventory.map((e) => [e.provider, e.credential])).toEqual([
      [CUSTOM, { kind: "api_key", origin: "env-key", subscription: false }],
    ]);
  });

  it("the inventory is those three providers, each in its class, read without a write", async () => {
    const { host: h, writes } = await rig();
    const inventory = await h.inventory();
    expect(Object.fromEntries(inventory.map((e) => [e.provider, e.credential]))).toEqual({
      [STORED_KEY]: { kind: "api_key", origin: "stored", subscription: false },
      [STORED_OAUTH]: { kind: "oauth", origin: "stored", subscription: true },
      [ENV_KEYED]: { kind: "api_key", origin: "env-key", label: ENV_NAME, subscription: false },
    });
    // The same read, as an extension inside a running pi makes it.
    expect(registryInventory(new ModelRegistry(h.modelRuntime))).toEqual(inventory);
    expect(writes).toEqual([]);
  });
});
