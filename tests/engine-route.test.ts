// The pi-facing half of the model route (packages/pi-plugin/src/engine/pisdk.ts):
// the inventory read off pi's registry facade, pi's `--model` parser shaped
// for the rule, pi's saved provider, and the host's own route: what a session
// with no model runs on, what a pin does, and where a spec moves when the
// provider it names has no credential. Then the host that exists only to
// name a route (packages/pi-plugin/src/reviewhost.ts routeHost).
//
// Every host here is the real pi over a temp agent dir, on pi-ai's faux
// provider and a custom `models.json` provider. Nothing is sent anywhere.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxProvider, type Api, type FauxProviderHandle, type Model } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { ModelRegistry, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  PiHost,
  piSavedProvider,
  registryInventory,
  textResolver,
  type PiHostOptions,
  type RouteRegistry,
} from "@quickchatai/pi-quickreview/src/engine/pisdk.js";
import { RouteRefused, type ModelRoute } from "@quickchatai/pi-quickreview/src/modelroute.js";
import {
  CATALOG_FILES,
  copyCatalogFiles,
  routeHost,
} from "@quickchatai/pi-quickreview/src/reviewhost.js";
import { FAKE_ROUTE_MODEL, writeFakeProvider } from "./helpers/fake-openai.js";
import { ROUTABLE_FAUX_MODEL, routableFaux } from "./helpers/priced-faux.js";
import { useOfflineGuard } from "./pi-canary/harness.js";

useOfflineGuard();

/** A built-in provider with no credential anywhere in these tests, and one of
 * its model ids, for the cases that need "a provider pi knows and cannot use". */
const BUILTIN = "deepseek";
const BUILTIN_ID = getBuiltinModels(BUILTIN)[0]!.id;
const BUILTIN_ENV = "DEEPSEEK_API_KEY";
/** Never listened on: no test here sends a request. */
const NOWHERE = "http://127.0.0.1:9/v1";

let dir: string;
const hosts: PiHost[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "engine-route-"));
});

afterEach(() => {
  for (const h of hosts.splice(0)) h.dispose();
  rmSync(dir, { recursive: true, force: true });
});

/** A host over a fresh agent dir. The environment pi reads credentials from
 * is empty unless the case names one: the developer's own keys never count. */
async function host(options: Partial<PiHostOptions> = {}): Promise<PiHost> {
  const h = await PiHost.create({
    agentDir: join(dir, `agent-${hosts.length}`),
    authEnv: {},
    settings: { compaction: { enabled: false }, retry: { enabled: false } },
    ...options,
  });
  hosts.push(h);
  return h;
}

/** `configureModels` that registers one faux provider. */
const withFaux =
  (faux: FauxProviderHandle) =>
  (runtime: ModelRuntime): void =>
    runtime.registerNativeProvider(faux.provider);

async function routeOf(h: PiHost): Promise<ModelRoute> {
  const r = await h.route();
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.refusal)}`);
  return r.route;
}

const session = (h: PiHost, model?: string | Model<Api>) =>
  h.makeSession({ cwd: dir, env: {}, tools: [], ...(model !== undefined ? { model } : {}) });

describe("registryInventory: what pi has a credential for, in its class", () => {
  it("a host with no credential has an empty inventory, and no route", async () => {
    const h = await host();
    expect(await h.inventory()).toEqual([]);
    expect(await h.route()).toEqual({ ok: false, refusal: { code: "no-credential" } });
  });

  // MUTATION: map a `models_json_key` status to "ambient" in credentialOrigin —
  // the custom provider's row fails.
  it("each way pi can hold a credential lands in its origin", async () => {
    const agentDir = join(dir, "agent-classes");
    writeFakeProvider(agentDir, NOWHERE, { routable: true });
    const faux = routableFaux();
    const h = await host({
      agentDir,
      authEnv: { [BUILTIN_ENV]: "not-a-key" },
      configureModels: async (runtime) => {
        runtime.registerNativeProvider(faux.provider);
        await runtime.setRuntimeApiKey("groq", "not-a-key");
      },
    });
    const inventory = await h.inventory();
    expect(Object.fromEntries(inventory.map((e) => [e.provider, e.credential]))).toEqual({
      // A key in the person's models.json.
      local: { kind: "api_key", origin: "models-json", subscription: false },
      // A key handed to pi for this process.
      groq: { kind: "api_key", origin: "runtime", subscription: false },
      // A key in the environment the host named.
      [BUILTIN]: { kind: "api_key", origin: "env-key", label: BUILTIN_ENV, subscription: false },
      // A provider that needs no key: nothing says a key was meant.
      faux: { kind: "api_key", origin: "ambient", subscription: false },
    });
    const local = inventory.find((e) => e.provider === "local")!;
    expect(local.name).toBe("local");
    expect(local.models.map((m) => m.id)).toEqual(["m", "r"]);
    // A custom provider has no default in pi's table, which is normal.
    expect(local.piDefaultId).toBeUndefined();
    expect(local.piDefaultUnread).toBeUndefined();
    expect(inventory.find((e) => e.provider === BUILTIN)!.piDefaultId).toBeDefined();
  });

  // pi answers a provider handed to it with a background pass over its
  // availability, and drops a pass a later one supersedes. The inventory is
  // read off that snapshot, so it waits until the snapshot agrees with pi.
  // MUTATION: return after the first pass in PiHost's settleAvailability — the
  // superseded pass leaves the snapshot without the provider and this fails.
  it("holds a provider handed to pi the moment before it is read", async () => {
    const h = await host();
    h.modelRuntime.registerNativeProvider(routableFaux().provider);
    expect((await h.inventory()).map((e) => e.provider)).toEqual(["faux"]);
    const keyed = await host();
    void keyed.modelRuntime.setRuntimeApiKey(BUILTIN, "not-a-key");
    keyed.modelRuntime.registerNativeProvider(routableFaux().provider);
    expect((await keyed.inventory()).map((e) => e.provider).sort()).toEqual([BUILTIN, "faux"]);
  });

  it("leaves out a provider the surface cannot use, and one whose status is not configured", async () => {
    const faux = routableFaux();
    const h = await host({
      authEnv: { [BUILTIN_ENV]: "not-a-key" },
      configureModels: withFaux(faux),
    });
    await h.inventory();
    const registry = new ModelRegistry(h.modelRuntime);
    expect(registryInventory(registry).map((e) => e.provider)).toEqual([BUILTIN, "faux"]);
    expect(
      registryInventory(registry, { exclude: new Set(["faux"]) }).map((e) => e.provider),
    ).toEqual([BUILTIN]);
    const unconfigured: RouteRegistry = {
      getAll: () => registry.getAll(),
      getAvailable: () => registry.getAvailable(),
      getProviderAuthStatus: () => ({ configured: false }),
      getProvider: (p) => registry.getProvider(p),
      getProviderDisplayName: (p) => registry.getProviderDisplayName(p),
      isUsingOAuth: (m) => registry.isUsingOAuth(m),
    };
    expect(registryInventory(unconfigured)).toEqual([]);
  });
});

describe("PiHost.route: one route per host", () => {
  // The rig as it has always been: pi-ai's faux model does not reason.
  it("a provider none of whose models the rule accepts is `no-model`, and a session with no model is refused", async () => {
    const faux = fauxProvider();
    const h = await host({ configureModels: withFaux(faux) });
    expect(await h.route()).toEqual({
      ok: false,
      refusal: { code: "no-model", providers: ["faux"] },
    });
    const refusal = await session(h).then(
      () => null,
      (e: unknown) => e,
    );
    expect(refusal).toBeInstanceOf(RouteRefused);
    expect((refusal as RouteRefused).refusal.code).toBe("no-model");
    // A session that names its model is untouched by the route.
    const pinned = await session(h, faux.getModel());
    expect(pinned.model?.id).toBe("faux-1");
  });

  // MUTATION: make resolveModel throw for an empty model again — this fails.
  it("a session with no model, or an empty one, runs on the route", async () => {
    const faux = routableFaux();
    const h = await host({ configureModels: withFaux(faux) });
    expect(await routeOf(h)).toMatchObject({
      provider: "faux",
      modelId: ROUTABLE_FAUX_MODEL.id,
      spec: `faux/${ROUTABLE_FAUX_MODEL.id}`,
      source: "only-credential",
      pick: "newest",
      priced: false,
      ask: false,
      credential: { origin: "ambient" },
    });
    expect((await session(h)).model?.id).toBe(ROUTABLE_FAUX_MODEL.id);
    expect((await session(h, "")).model?.id).toBe(ROUTABLE_FAUX_MODEL.id);
    // Resolved once: the same answer object every time.
    expect(await h.route()).toBe(await h.route());
  });

  it("orders several providers by credential class and lists the rest", async () => {
    const agentDir = join(dir, "agent-order");
    writeFakeProvider(agentDir, NOWHERE, { routable: true });
    const faux = routableFaux();
    const h = await host({ agentDir, configureModels: withFaux(faux) });
    const route = await routeOf(h);
    expect(route).toMatchObject({
      spec: FAKE_ROUTE_MODEL,
      source: "credential-order",
      priced: true,
      ask: false,
    });
    expect(route.alternatives.map((a) => a.spec)).toEqual([`faux/${ROUTABLE_FAUX_MODEL.id}`]);
    expect((await session(h)).model).toMatchObject({ provider: "local", id: "r" });
  });

  it("takes the remembered answer, pi's own provider and the skipped logins it is handed", async () => {
    const agentDir = join(dir, "agent-inputs");
    writeFakeProvider(agentDir, NOWHERE, { routable: true });
    const faux = routableFaux();
    const skipped = [{ provider: "elsewhere", name: "Elsewhere", expiresAt: 0 }];
    const h = await host({
      agentDir,
      configureModels: withFaux(faux),
      route: {
        choice: { provider: "faux", model: null, via: "ask", no_estimate_ok: [] },
        piProvider: { provider: "local", from: "pi-settings" },
        skipped,
      },
    });
    const route = await routeOf(h);
    expect(route).toMatchObject({ provider: "faux", source: "remembered" });
    expect(route.notices).toHaveLength(1);
    expect(route.notices[0]).toMatch(/^skipped Elsewhere: its login expires at /);
  });

  it("a pin is the route, on a model the rule would not pick and on an id pi does not know", async () => {
    const faux = fauxProvider();
    const pinned = await host({
      configureModels: withFaux(faux),
      route: { pin: { text: "faux/faux-1:high", from: "flag" } },
    });
    expect(await routeOf(pinned)).toMatchObject({
      spec: "faux/faux-1",
      thinking: "high",
      source: "flag",
      pick: "pinned",
      custom: false,
    });
    expect((await session(pinned)).model?.id).toBe("faux-1");

    const custom = await host({
      configureModels: withFaux(fauxProvider()),
      route: { pin: { text: "faux/my-deployment", from: "config" } },
    });
    expect(await routeOf(custom)).toMatchObject({
      spec: "faux/my-deployment",
      source: "config",
      custom: true,
    });
    // pi runs a custom id as written: the session's model carries it.
    expect((await session(custom)).model).toMatchObject({ provider: "faux", id: "my-deployment" });

    const unknown = await host({
      configureModels: withFaux(fauxProvider()),
      route: { pin: { text: "no-such-provider/x", from: "flag" } },
    });
    expect(await unknown.route()).toMatchObject({
      ok: false,
      refusal: { code: "pin-unknown", pin: "no-such-provider/x" },
    });
  });

  // MUTATION: resolve a `fixed` route over the host's own inventory — the host
  // has no credential for it, the route is refused and this fails.
  it("a route an earlier step resolved is used as it is, with the model it was resolved to", async () => {
    const faux = fauxProvider();
    const elsewhere = { ...faux.getModel(), id: "known-elsewhere-9" } as Model<Api>;
    const fixed: ModelRoute = {
      provider: "faux",
      modelId: "known-elsewhere-9",
      providerName: "Faux",
      spec: "faux/known-elsewhere-9",
      thinking: null,
      source: "pi-provider",
      pick: "newest",
      piDefaultId: null,
      custom: false,
      movedFrom: null,
      credential: { kind: "api_key", origin: "stored", subscription: false },
      priced: false,
      ask: false,
      alternatives: [],
      notices: [],
    };
    const h = await host({ configureModels: withFaux(faux), route: { fixed, model: elsewhere } });
    expect(await h.route()).toEqual({ ok: true, route: fixed });
    // The host's own catalog lacks the id: the handed model runs.
    expect((await session(h)).model?.id).toBe("known-elsewhere-9");
    // An id the host's catalog does hold is the host's own object.
    const own = await host({
      configureModels: withFaux(faux),
      route: { fixed: { ...fixed, modelId: "faux-1", spec: "faux/faux-1" }, model: elsewhere },
    });
    expect((await session(own)).model?.id).toBe("faux-1");
    // With neither, the session says which model it could not find.
    const neither = await host({ configureModels: withFaux(faux), route: { fixed } });
    await expect(session(neither)).rejects.toThrow(/"faux\/known-elsewhere-9" is not known/);
  });
});

describe("a spec whose provider has no credential", () => {
  /** A custom provider that serves a built-in provider's model id under the same id. */
  function sameIdElsewhere(agentDir: string): void {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            baseUrl: NOWHERE,
            api: "openai-completions",
            apiKey: "not-a-key",
            models: [{ id: BUILTIN_ID, name: BUILTIN_ID, contextWindow: 200000, maxTokens: 4000 }],
          },
        },
      }),
    );
  }

  // MUTATION: return the spec's own model when its provider has no credential
  // in resolveModel — the session stays on the provider with no key and this fails.
  it("runs on the one credentialed provider that serves the same id, and the host records the move once", async () => {
    const agentDir = join(dir, "agent-move");
    sameIdElsewhere(agentDir);
    const h = await host({ agentDir });
    expect(h.moves()).toEqual([]);
    const a = await session(h, `${BUILTIN}/${BUILTIN_ID}`);
    const b = await session(h, `${BUILTIN}/${BUILTIN_ID}`);
    expect(a.model).toMatchObject({ provider: "local", id: BUILTIN_ID });
    expect(b.model).toMatchObject({ provider: "local", id: BUILTIN_ID });
    expect(h.moves()).toEqual([{ from: BUILTIN, to: "local", id: BUILTIN_ID }]);
  });

  it("stays where it is named when that provider has a credential", async () => {
    const agentDir = join(dir, "agent-stay");
    sameIdElsewhere(agentDir);
    const h = await host({ agentDir, authEnv: { [BUILTIN_ENV]: "not-a-key" } });
    expect((await session(h, `${BUILTIN}/${BUILTIN_ID}`)).model?.provider).toBe(BUILTIN);
    expect(h.moves()).toEqual([]);
  });

  it("is refused, naming the spec, when no credentialed provider serves the id", async () => {
    const h = await host({ configureModels: withFaux(routableFaux()) });
    const refusal = await session(h, `${BUILTIN}/${BUILTIN_ID}`).then(
      () => null,
      (e: unknown) => e,
    );
    expect(refusal).toBeInstanceOf(RouteRefused);
    expect((refusal as RouteRefused).refusal).toEqual({
      code: "pin-no-credential",
      pin: `${BUILTIN}/${BUILTIN_ID}`,
      provider: BUILTIN,
      from: "config",
      candidates: [],
    });
    // A name pi has never heard of is not a credential question.
    await expect(session(h, "no-such-provider/x")).rejects.toThrow(/not known to the host/);
    await expect(session(h, "faux/no-such-model")).rejects.toThrow(/not known to the host/);
  });
});

// VERIFY-ON-PIN: one row per wording of pi's `--model` parser the route leans on.
describe("textResolver: pi's own parse of a model text", () => {
  async function resolver(authEnv: Record<string, string> = {}) {
    const h = await host({ authEnv, configureModels: withFaux(fauxProvider()) });
    await h.inventory();
    return textResolver(new ModelRegistry(h.modelRuntime));
  }

  it("an exact `provider/id`, with the level its suffix names", async () => {
    const resolve = await resolver();
    const plain = resolve(`${BUILTIN}/${BUILTIN_ID}`);
    expect(plain.model).toMatchObject({ provider: BUILTIN, id: BUILTIN_ID });
    expect(plain).not.toHaveProperty("thinking");
    expect(plain).not.toHaveProperty("custom");
    expect(plain).not.toHaveProperty("error");
    const levelled = resolve(`${BUILTIN}/${BUILTIN_ID}:high`);
    expect(levelled.model).toMatchObject({ provider: BUILTIN, id: BUILTIN_ID });
    expect(levelled.thinking).toBe("high");
  });

  it("a bare id one provider serves", async () => {
    const resolve = await resolver();
    expect(resolve("faux-1").model).toMatchObject({ provider: "faux", id: "faux-1" });
  });

  it("an id pi does not know on a provider it does is kept as a custom id", async () => {
    const resolve = await resolver();
    const r = resolve(`${BUILTIN}/my-own-deployment`);
    expect(r.model).toMatchObject({ provider: BUILTIN, id: "my-own-deployment" });
    expect(r.custom).toBe(true);
    expect(r.error).toBeUndefined();
  });

  // MUTATION: return pi's whole error from textResolver — its second sentence
  // names a flag of pi's own and the `not.toMatch` rows fail.
  it("an error is pi's first sentence, without the flags only pi has", async () => {
    const resolve = await resolver();
    const unknown = resolve("no-such-model-anywhere-zz");
    expect(unknown.model).toBeUndefined();
    expect(unknown.error).toBe('Model "no-such-model-anywhere-zz" not found.');
    // An id several providers serve, none of them credentialed here.
    const shared = getBuiltinModels("openai").find((m) =>
      getBuiltinModels("openai-codex").some((c) => c.id === m.id),
    )!.id;
    const ambiguous = resolve(shared);
    expect(ambiguous.error).toMatch(
      new RegExp(`^Model "${shared.replace(/\./g, "\\.")}" is ambiguous across providers: .+\\.$`),
    );
    expect(ambiguous.error).toContain(`openai/${shared}`);
    for (const error of [unknown.error, ambiguous.error]) {
      expect(error).not.toMatch(/--list-models|--provider|Use /);
      expect(error!.split(". ")).toHaveLength(1);
    }
    expect(resolve("").error).toBe('Model "" not found.');
  });

  it("a credential picks between providers that serve the same bare id", async () => {
    const shared = getBuiltinModels("openai").find((m) =>
      getBuiltinModels("openai-codex").some((c) => c.id === m.id),
    )!.id;
    const resolve = await resolver({ OPENAI_API_KEY: "not-a-key" });
    expect(resolve(shared).model).toMatchObject({ provider: "openai", id: shared });
  });
});

describe("piSavedProvider: the provider pi itself starts on", () => {
  const settings = (agentDir: string, body: string): void => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), body);
  };

  it("is the global setting of the agent dir it is given", () => {
    const agentDir = join(dir, "pi-home");
    settings(agentDir, JSON.stringify({ defaultProvider: "alpha", defaultModel: "alpha-5.1" }));
    expect(piSavedProvider(agentDir)).toBe("alpha");
  });

  it("is undefined when there is none, or the file cannot be read", () => {
    expect(piSavedProvider(join(dir, "no-such-home"))).toBeUndefined();
    const empty = join(dir, "empty-home");
    settings(empty, "{}");
    expect(piSavedProvider(empty)).toBeUndefined();
    const broken = join(dir, "broken-home");
    settings(broken, "{oops");
    expect(piSavedProvider(broken)).toBeUndefined();
    const blank = join(dir, "blank-home");
    settings(blank, JSON.stringify({ defaultProvider: " " }));
    expect(piSavedProvider(blank)).toBeUndefined();
  });

  // MUTATION: create the SettingsManager with the project trusted — the
  // project file's provider is read and this fails.
  it("never reads a project's settings, even one under the agent dir", () => {
    const agentDir = join(dir, "pi-home-project");
    settings(agentDir, "{}");
    settings(join(agentDir, ".pi"), JSON.stringify({ defaultProvider: "from-a-project" }));
    expect(piSavedProvider(agentDir)).toBeUndefined();
  });

  it("leaves the settings file as it was", () => {
    const agentDir = join(dir, "pi-home-untouched");
    const body = JSON.stringify({ defaultProvider: "alpha" });
    settings(agentDir, body);
    piSavedProvider(agentDir);
    expect(readFileSync(join(agentDir, "settings.json"), "utf8")).toBe(body);
    expect(readdirSync(agentDir)).toEqual(["settings.json"]);
  });
});

describe("routeHost: a host that only names the route", () => {
  const OVERLAY_ID = "qcr-overlay-only-model";

  /** A pi home with a custom provider and a stored catalog overlay. */
  function piHome(): string {
    const src = join(dir, "pi-home");
    writeFakeProvider(src, NOWHERE, { routable: true });
    writeFileSync(
      join(src, "models-store.json"),
      JSON.stringify({
        [BUILTIN]: {
          models: [{ ...getBuiltinModels(BUILTIN)[0]!, id: OVERLAY_ID, name: "Overlay Only" }],
          lastModified: Date.UTC(2999, 0, 1),
          checkedAt: Date.now(),
        },
      }),
    );
    writeFileSync(join(src, "auth.json"), "{}\n");
    writeFileSync(join(src, "settings.json"), "{}\n");
    return src;
  }

  it("resolves the route over the source's catalog, in a private dir it removes", async () => {
    const src = piHome();
    const before = readdirSync(src).sort();
    const tmpDir = join(dir, "state", "tmp");
    const made = await routeHost({ srcAgentDir: src, tmpDir, authEnv: {} });
    try {
      expect(made.agentDir.startsWith(join(tmpDir, "route-"))).toBe(true);
      expect(statSync(tmpDir).mode & 0o777).toBe(0o700);
      expect(statSync(made.agentDir).mode & 0o777).toBe(0o700);
      // The catalog files and nothing else of the source: no login, no settings.
      for (const name of CATALOG_FILES) {
        expect(readFileSync(join(made.agentDir, name), "utf8")).toBe(
          readFileSync(join(src, name), "utf8"),
        );
        expect(statSync(join(made.agentDir, name)).mode & 0o777).toBe(0o600);
      }
      expect(existsSync(join(made.agentDir, "auth.json"))).toBe(false);
      expect(existsSync(join(made.agentDir, "settings.json"))).toBe(false);
      expect(await made.host.route()).toMatchObject({
        ok: true,
        route: { spec: FAKE_ROUTE_MODEL, source: "only-credential" },
      });
    } finally {
      made.dispose();
      made.dispose();
    }
    expect(existsSync(made.agentDir)).toBe(false);
    expect(readdirSync(src).sort()).toEqual(before);
  });

  // MUTATION: drop "models-store.json" from CATALOG_FILES — the host has
  // never heard of the overlay model, the pin is a custom id and this fails.
  it("knows a model that exists only in the source's stored overlay", async () => {
    const made = await routeHost({
      srcAgentDir: piHome(),
      tmpDir: join(dir, "tmp"),
      authEnv: { [BUILTIN_ENV]: "not-a-key" },
      route: { pin: { text: `${BUILTIN}/${OVERLAY_ID}`, from: "config" } },
    });
    try {
      expect(await made.host.route()).toMatchObject({
        ok: true,
        route: { provider: BUILTIN, modelId: OVERLAY_ID, custom: false, source: "config" },
      });
      expect(made.host.modelRuntime.getModel(BUILTIN, OVERLAY_ID)).toBeDefined();
    } finally {
      made.dispose();
    }
  });

  it("a source with no catalog files is a host on pi's built-in catalog", async () => {
    const made = await routeHost({
      srcAgentDir: join(dir, "no-such-home"),
      tmpDir: join(dir, "tmp"),
      authEnv: {},
    });
    try {
      expect(await made.host.route()).toEqual({ ok: false, refusal: { code: "no-credential" } });
    } finally {
      made.dispose();
    }
  });

  it("copyCatalogFiles removes a copy whose source is gone", () => {
    const src = piHome();
    const dst = join(dir, "dst");
    mkdirSync(dst);
    copyCatalogFiles(src, dst);
    expect(readdirSync(dst).sort()).toEqual([...CATALOG_FILES].sort());
    rmSync(join(src, "models-store.json"));
    copyCatalogFiles(src, dst);
    expect(readdirSync(dst)).toEqual(["models.json"]);
  });
});
