// One rule on every route.
//
// Which model a review runs on is decided in one place (resolveRoute,
// packages/pi-plugin/src/modelroute.ts) over one inventory read off pi's
// registry (registryInventory, packages/pi-plugin/src/engine/pisdk.ts). Several
// surfaces reach it, each by its own path, and a person who runs two of them
// on one machine must be told the same model by both. This fence resolves one
// pi home through each path and holds the answers equal:
//
//   the host      PiHost.route() on a host over the pi home itself, with the
//                 borrowed login and the route inputs (how a bot worker's and
//                 `qcr review`'s host resolve);
//   the registry  registryInventory + textResolver + resolveRoute over a pi
//                 registry facade (what an extension inside a running pi is
//                 handed);
//   the plugin    the pi plugin's own sequence inside a running pi: the
//                 extension's host auth over the pi's registry
//                 (packages/pi-plugin/extensions/quickreview.ts `hostAuth`)
//                 and the plugin's reading of the remembered choice
//                 (packages/pi-plugin/src/plugin/login.ts `routeInPi`), which
//                 is how /qcr-review, /qcr-scan and /qcr-setup resolve;
//   the CLI       `qcr model --json` (src/modelcli.ts), which resolves on a
//                 private copy of the home's catalog.
//
// The leg that is not built yet joins here as it lands: the worker's own
// sequence.
//
// Five homes, one per thing that decides a route: one provider, several,
// a remembered answer, the guard (pi's default standing in for a newest
// version priced far below it), and a model that exists only in the catalog
// overlay pi stored in the home.
//
// Every home is a temp dir; a provider's credential is a key in the home's
// own files (`models.json`, `auth.json`) or in the secrets dir's model env, so
// each leg reads it the way it really would. Nothing is sent anywhere.
//
// MUTATION: drop the models-store copy in routeHost (take "models-store.json"
// out of CATALOG_FILES in packages/pi-plugin/src/reviewhost.ts) — the CLI's
// private copy has never heard of the overlay model, the overlay case differs
// and this fails.
//
// MUTATION: drop `choice` from what routeInPi asks the host's route for
// (packages/pi-plugin/src/plugin/login.ts) — the plugin leg forgets the
// remembered answer, the remembered case differs and this fails.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import { builtinProviders, getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { ModelRegistry, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { hostAuth } from "@quickchatai/pi-quickreview/extensions/quickreview.js";
import { borrowedCredentials } from "@quickchatai/pi-quickreview/src/engine/auth.js";
import {
  PiHost,
  piDefaultModelId,
  piSavedProvider,
  registryInventory,
  textResolver,
  type PiHostOptions,
} from "@quickchatai/pi-quickreview/src/engine/pisdk.js";
import { MODEL_CHOICE_FILE, readModelChoice } from "@quickchatai/pi-quickreview/src/modelchoice.js";
import { listPrice, pickModel } from "@quickchatai/pi-quickreview/src/modelpick.js";
import { routeInPi } from "@quickchatai/pi-quickreview/src/plugin/login.js";
import {
  resolveRoute,
  type ModelRoute,
  type RouteResult,
} from "@quickchatai/pi-quickreview/src/modelroute.js";
import {
  cmdModel,
  REVIEW_WINDOW_MS,
  type ModelCliDeps,
  type ModelCliJson,
} from "../src/modelcli.js";
import { MODEL_ENV_DIR, modelEnvFrom } from "../src/modelenv.js";
import { FAKE_ROUTE_MODEL, writeFakeProvider } from "./helpers/fake-openai.js";
import { useOfflineGuard } from "./pi-canary/harness.js";

useOfflineGuard();

/** A built-in provider, keyed here through the model env or the login file. */
const BUILTIN = "deepseek";
const BUILTIN_ENV = "DEEPSEEK_API_KEY";
/** Never listened on: no leg sends a request. */
const NOWHERE = "http://127.0.0.1:9/v1";
/** A config that pins nothing. */
const UNPINNED: ModelCliDeps["models"] = {
  model: "",
  tiers: { light: ":medium", standard: ":medium", deep: ":high" },
};
/** The same config under `[models] effort` or a review preset: every spec
 * carries the level, and `[models] model` still names no model. */
const UNPINNED_AT_A_LEVEL: ModelCliDeps["models"] = {
  model: ":high",
  tiers: { light: ":high", standard: ":high", deep: ":high" },
};

let dir: string;
let home: string;
let secrets: string;
const hosts: PiHost[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "route-parity-"));
  home = join(dir, "pi-home");
  secrets = join(dir, "secrets");
  mkdirSync(home, { recursive: true });
  mkdirSync(secrets, { recursive: true });
});

afterEach(() => {
  for (const h of hosts.splice(0)) h.dispose();
  rmSync(dir, { recursive: true, force: true });
});

// ---- what a home is made of ------------------------------------------------------

/** The custom provider `local` in the home's models.json (class: a key pi holds). */
const withLocal = (): void => writeFakeProvider(home, NOWHERE, { routable: true });

/** A key for `name` in the secrets dir's model env. */
function modelEnvKey(name: string): void {
  mkdirSync(join(secrets, MODEL_ENV_DIR), { recursive: true });
  writeFileSync(join(secrets, MODEL_ENV_DIR, name), "not-a-key\n");
}

/** A stored API key for `provider` in the home's login file. */
function storedKey(provider: string): void {
  writeFileSync(
    join(home, "auth.json"),
    JSON.stringify({ [provider]: { type: "api_key", key: "not-a-key" } }),
  );
}

// ---- the legs ---------------------------------------------------------------------

/** What every leg reads of the home, the way each really reads it. */
function inputs() {
  const borrowed = borrowedCredentials({ srcDir: home, needMs: REVIEW_WINDOW_MS, owner: false });
  const choice = readModelChoice(home).choice;
  const saved = piSavedProvider(home);
  return {
    credentials: borrowed.credentials,
    authEnv: modelEnvFrom(secrets),
    route: {
      skipped: borrowed.skipped,
      ...(choice ? { choice } : {}),
      ...(saved !== undefined
        ? { piProvider: { provider: saved, from: "pi-settings" as const } }
        : {}),
    },
  };
}

async function hostOver(options: Partial<PiHostOptions>): Promise<PiHost> {
  const h = await PiHost.create({
    agentDir: home,
    settings: { compaction: { enabled: false }, retry: { enabled: false } },
    ...options,
  });
  hosts.push(h);
  return h;
}

/** The host: its own route. */
async function viaHost(): Promise<RouteResult> {
  const { credentials, authEnv, route } = inputs();
  return (await hostOver({ credentials, authEnv, route })).route();
}

/** The registry: the inventory and pi's parser over a facade, then the rule. */
async function viaRegistry(): Promise<RouteResult> {
  const { credentials, authEnv, route } = inputs();
  // A host with no route inputs of its own stands in for the running pi whose
  // registry an extension is handed.
  const pi = await hostOver({ credentials, authEnv });
  await pi.inventory();
  const registry = new ModelRegistry(pi.modelRuntime);
  return resolveRoute({
    inventory: registryInventory(registry),
    resolveText: textResolver(registry),
    ...route,
  });
}

/** The plugin: the extension's host auth over a running pi's registry, then
 * the plugin's own sequence (the choice file read from the pi's agent dir).
 * The pi's session is on no model, as pi's settings name no provider here. */
async function viaPlugin(): Promise<RouteResult> {
  const { credentials, authEnv } = inputs();
  // A host with no route inputs of its own stands in for the running pi.
  const pi = await hostOver({ credentials, authEnv });
  await pi.inventory();
  const ctx = { model: undefined, modelRegistry: new ModelRegistry(pi.modelRuntime) };
  const auth = hostAuth(ctx as unknown as ExtensionCommandContext, home);
  const routed = await routeInPi({
    host: { agentDir: home, auth },
    resolve: auth.route!,
    // Nobody to ask: the order decides, as on the other legs.
    ui: { interactive: false, select: async () => undefined, notify: () => {} },
    ask: false,
    what: "review",
    warn: () => {},
  });
  return routed.result;
}

/** The CLI: `qcr model --json`, over a config whose `[models]` is `models`. */
async function viaCli(models: ModelCliDeps["models"]): Promise<ModelCliJson> {
  const out: string[] = [];
  await cmdModel([], true, {
    env: {},
    agentDir: home,
    tmpDir: join(dir, "state", "tmp"),
    models,
    configPath: null,
    secretsDir: secrets,
    daemon: false,
    out: (l) => out.push(l),
    err: () => {},
  });
  expect(out).toHaveLength(1);
  return JSON.parse(out[0]!) as ModelCliJson;
}

/** A route as JSON carries it: what the CLI's answer is compared in. */
const plain = (route: ModelRoute): unknown => JSON.parse(JSON.stringify(route));

/** Resolve the home through every leg, hold the answers equal, and return it.
 * `models` is the config the CLI leg reads: one that pins nothing. */
async function sameOnEveryRoute(models: ModelCliDeps["models"] = UNPINNED): Promise<ModelRoute> {
  const host = await viaHost();
  if (!host.ok) throw new Error(`the host has no route: ${JSON.stringify(host.refusal)}`);
  expect(await viaRegistry(), "the registry leg").toEqual(host);
  expect(await viaPlugin(), "the plugin leg").toEqual(host);
  const cli = await viaCli(models);
  expect(cli.config_pin, "the CLI leg").toBeNull();
  expect(cli.ok, "the CLI leg").toBe(true);
  expect(cli.route, "the CLI leg").toEqual(plain(host.route));
  return host.route;
}

describe("one rule on every route: the host, the registry, the plugin and qcr model agree", () => {
  it("one provider", async () => {
    withLocal();
    expect(await sameOnEveryRoute()).toMatchObject({
      spec: FAKE_ROUTE_MODEL,
      source: "only-credential",
      pick: "newest",
      alternatives: [],
    });
  });

  // The CLI leg reads a config under an effort setting here: its level-only
  // `[models] model` is no pin, so the leg still answers by the rule.
  // MUTATION: test the pin with `deps.models.model !== ""` in resolve() of
  // src/modelcli.ts — the CLI leg resolves ":high" as a pin, differs from the
  // host and this fails.
  it("several providers: the one pi holds a key for before the one keyed in the environment", async () => {
    withLocal();
    modelEnvKey(BUILTIN_ENV);
    const route = await sameOnEveryRoute(UNPINNED_AT_A_LEVEL);
    expect(route).toMatchObject({
      spec: FAKE_ROUTE_MODEL,
      source: "credential-order",
      ask: false,
      credential: { origin: "models-json" },
    });
    expect(route.alternatives.map((a) => [a.provider, a.credential.origin])).toEqual([
      [BUILTIN, "env-key"],
    ]);
  });

  it("a remembered answer", async () => {
    withLocal();
    modelEnvKey(BUILTIN_ENV);
    writeFileSync(
      join(home, MODEL_CHOICE_FILE),
      JSON.stringify({ version: 1, provider: BUILTIN, model: null, via: "ask" }),
    );
    const route = await sameOnEveryRoute();
    expect(route).toMatchObject({ provider: BUILTIN, source: "remembered", ask: false });
    expect(route.alternatives.map((a) => a.spec)).toEqual([FAKE_ROUTE_MODEL]);
  });

  // The provider is read off pi's catalog, never named: whichever one has a
  // newest version priced far below pi's own default for it. A pi whose catalog
  // holds none leaves the guard with no built-in case, and this one says so.
  it("the guard: pi's default stands where the newest version is priced far below it", async () => {
    const guarded = builtinProviders()
      .map((p) => {
        const models = getBuiltinModels(p.id as never) as Model<Api>[];
        const pick = pickModel(models, piDefaultModelId(p.id, models).id);
        return { provider: p.id, pick };
      })
      .find((x) => x.pick?.guarded === true);
    expect(guarded, "pi's catalog holds no provider whose pick is guarded").toBeDefined();
    storedKey(guarded!.provider);
    const route = await sameOnEveryRoute();
    expect(route).toMatchObject({
      provider: guarded!.provider,
      modelId: guarded!.pick!.model.id,
      pick: "pi-default",
      credential: { origin: "stored", kind: "api_key" },
    });
    expect(route.modelId).not.toBe(guarded!.pick!.newest!.id);
    expect(route.notices.join("\n")).toContain(guarded!.pick!.newest!.id);
  });

  it("a model that exists only in the catalog overlay pi stored in the home", async () => {
    const OVERLAY_ID = "qcr-overlay-99";
    // The dearest of the provider's own models, renamed to a version above all
    // of them: the newest by the rule, and nothing for the guard to hold back.
    const dearest = [...(getBuiltinModels(BUILTIN) as Model<Api>[])].sort(
      (a, b) => listPrice(b) - listPrice(a),
    )[0]!;
    writeFileSync(
      join(home, "models-store.json"),
      JSON.stringify({
        [BUILTIN]: {
          models: [{ ...dearest, id: OVERLAY_ID, name: "Overlay Only" }],
          lastModified: Date.UTC(2999, 0, 1),
          checkedAt: Date.now(),
        },
      }),
    );
    storedKey(BUILTIN);
    expect(getBuiltinModels(BUILTIN).some((m) => m.id === OVERLAY_ID)).toBe(false);
    expect(await sameOnEveryRoute()).toMatchObject({
      spec: `${BUILTIN}/${OVERLAY_ID}`,
      source: "only-credential",
      pick: "newest",
      custom: false,
    });
  });
});
