// The credential-aware model route (packages/pi-plugin/src/modelroute.ts) and
// the SDK host's use of it (pisdk.ts resolveModel): an OpenAI spec runs on the
// OpenAI login that exists, and the provider it names wins when its login is
// there — so an install on the legacy Codex login runs exactly as before.
import { describe, expect, it } from "vitest";
import {
  modelIdOf,
  providersInAuthJson,
  routeModelSpec,
  routeModelSpecForLogin,
  routeProvider,
  splitProvider,
  twinProvider,
} from "@quickchatai/pi-quickreview/src/modelroute.js";
import { resolveModel } from "@quickchatai/pi-quickreview/src/engine/pisdk.js";

const has = (...providers: string[]) => ({ hasCredential: (p: string) => providers.includes(p) });

describe("routeProvider", () => {
  it("the OpenAI providers are each other's twin, and nothing else has one", () => {
    expect(twinProvider("openai-codex")).toBe("openai");
    expect(twinProvider("openai")).toBe("openai-codex");
    expect(twinProvider("anthropic")).toBeUndefined();
  });

  // MUTATION: return the twin whenever it has a credential — the first case fails.
  it("the named provider wins when its login exists", () => {
    expect(routeProvider("openai-codex", "gpt-6.1-sol", has("openai-codex", "openai"))).toBe(
      "openai-codex",
    );
    expect(routeProvider("openai", "gpt-6.1-sol", has("openai", "openai-codex"))).toBe("openai");
  });

  it("an OpenAI model with no login of its own runs on the twin's", () => {
    expect(routeProvider("openai-codex", "gpt-6.1-sol", has("openai"))).toBe("openai");
    expect(routeProvider("openai", "gpt-6.1-sol", has("openai-codex"))).toBe("openai-codex");
  });

  it("stays put when the twin has no login either, or does not serve the model", () => {
    expect(routeProvider("openai-codex", "gpt-6.1-sol", has())).toBe("openai-codex");
    expect(
      routeProvider("openai-codex", "codex-only", {
        hasCredential: (p) => p === "openai",
        hasModel: (_p, id) => id !== "codex-only",
      }),
    ).toBe("openai-codex");
  });

  it("never moves a model off a provider outside the OpenAI family", () => {
    expect(routeProvider("anthropic", "x", has("openai", "openai-codex"))).toBe("anthropic");
  });
});

describe("routeModelSpec", () => {
  it("keeps the thinking suffix and everything after the provider", () => {
    expect(routeModelSpec("openai-codex/gpt-6.1-sol:medium", has("openai"))).toBe(
      "openai/gpt-6.1-sol:medium",
    );
    expect(routeModelSpec("openai-codex/gpt-6.1-sol:medium", has("openai-codex"))).toBe(
      "openai-codex/gpt-6.1-sol:medium",
    );
    expect(routeModelSpec("gpt-6.1-sol", has("openai"))).toBe("gpt-6.1-sol");
  });

  it("takes a spec apart at its first slash", () => {
    expect(splitProvider("openrouter/openai/gpt-x")).toEqual({
      provider: "openrouter",
      rest: "openai/gpt-x",
    });
    expect(splitProvider("/x")).toBeNull();
    expect(modelIdOf("gpt-6.1-sol:high")).toBe("gpt-6.1-sol");
  });
});

describe("providersInAuthJson", () => {
  it("an oauth entry and a non-empty api key count; anything else does not", () => {
    const raw = JSON.stringify({
      "openai-codex": { type: "oauth", access: "a", refresh: "r", expires: 1 },
      openai: { type: "api_key", key: "sk-x" },
      anthropic: { type: "api_key", key: "  " },
      broken: "x",
    });
    expect([...providersInAuthJson(raw)].sort()).toEqual(["openai", "openai-codex"]);
  });

  it("OPENAI_API_KEY counts for openai; an unreadable login holds nothing", () => {
    expect([...providersInAuthJson(null, { OPENAI_API_KEY: "sk-x" })]).toEqual(["openai"]);
    expect([...providersInAuthJson("not json")]).toEqual([]);
  });

  it("routes a spec over a login file", () => {
    const chatgpt = JSON.stringify({ openai: { type: "oauth", expires: 1 } });
    expect(routeModelSpecForLogin("openai-codex/gpt-6.1-sol", chatgpt)).toBe("openai/gpt-6.1-sol");
    expect(routeModelSpecForLogin("openai-codex/gpt-6.1-sol", null)).toBe(
      "openai-codex/gpt-6.1-sol",
    );
  });
});

describe("the SDK host's resolveModel", () => {
  /** A ModelRuntime by shape: both OpenAI providers serve gpt-6.1-sol. */
  function runtime(credentials: string[]) {
    const checked: string[] = [];
    return {
      checked,
      getModel: (provider: string, id: string) =>
        ["openai", "openai-codex"].includes(provider) && id === "gpt-6.1-sol"
          ? ({ provider, id } as never)
          : undefined,
      checkAuth: async (provider: string) => {
        checked.push(provider);
        return credentials.includes(provider)
          ? ({ source: "OAuth", type: "oauth" } as never)
          : undefined;
      },
    };
  }

  it("the production login: openai-codex stays openai-codex", async () => {
    const m = await resolveModel(runtime(["openai-codex"]), "openai-codex/gpt-6.1-sol");
    expect(m).toMatchObject({ provider: "openai-codex", id: "gpt-6.1-sol" });
  });

  // MUTATION: make resolveModel look the spec up as given again — this fails.
  it("only a Sign in with ChatGPT login or an OpenAI key: the same model on openai", async () => {
    const m = await resolveModel(runtime(["openai"]), "openai-codex/gpt-6.1-sol");
    expect(m).toMatchObject({ provider: "openai", id: "gpt-6.1-sol" });
  });

  it("no login at all: the spec's own model, for pi's own credential error", async () => {
    const m = await resolveModel(runtime([]), "openai-codex/gpt-6.1-sol");
    expect(m).toMatchObject({ provider: "openai-codex" });
  });

  it("a provider outside the family is never asked about and never moved", async () => {
    const r = {
      ...runtime(["openai"]),
      getModel: (provider: string, id: string) => ({ provider, id }) as never,
    };
    const m = await resolveModel(r, "anthropic/claude-x");
    expect(m).toMatchObject({ provider: "anthropic" });
    expect(r.checked).toEqual([]);
  });

  it("an unknown model is still refused", async () => {
    await expect(resolveModel(runtime(["openai"]), "openai-codex/nope")).rejects.toThrow(
      /not known to the host/,
    );
  });
});
