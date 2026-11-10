// The model route (packages/pi-plugin/src/modelroute.ts): which provider and
// model a review runs on, as a pure rule over an inventory, and the SDK
// host's use of it for a session spec (pisdk.ts resolveModel).
//
// The providers in the rule's own tables are made up on purpose: the rule
// names none, so its cases must not lean on one either. The one real pair is
// in the cases that hold the answers the two-provider twin gave.
import { describe, expect, it } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  RouteRefused,
  credentialClass,
  expiryClock,
  modelIdOf,
  moveToCredentialed,
  providersInAuthJson,
  resolvePin,
  resolveRoute,
  routeModelSpec,
  routeModelSpecForLogin,
  routeProvider,
  splitProvider,
  twinProvider,
  type CatalogModel,
  type CredentialOrigin,
  type ModelChoice,
  type ModelRoute,
  type ProviderInventory,
  type RouteInput,
  type RouteRefusal,
  type SkippedLogin,
} from "@quickchatai/pi-quickreview/src/modelroute.js";
import {
  resolveModel,
  type ModelSource,
  type RouteMove,
} from "@quickchatai/pi-quickreview/src/engine/pisdk.js";

// ---- a made-up catalog ---------------------------------------------------------

/** A model the pick rule accepts unless a field says otherwise. */
function model(provider: string, id: string, o: Partial<CatalogModel> = {}): CatalogModel {
  return {
    provider,
    id,
    reasoning: true,
    contextWindow: 200_000,
    cost: { input: 1, output: 4 },
    ...o,
  };
}

function entry(
  provider: string,
  models: CatalogModel[],
  o: { origin?: CredentialOrigin; piDefaultId?: string; piDefaultUnread?: boolean } = {},
): ProviderInventory {
  return {
    provider,
    name: `${provider.toUpperCase()} Inc`,
    credential: { kind: "api_key", origin: o.origin ?? "stored", subscription: false },
    models,
    ...(o.piDefaultId !== undefined ? { piDefaultId: o.piDefaultId } : {}),
    ...(o.piDefaultUnread ? { piDefaultUnread: true } : {}),
  };
}

/** A stand-in for pi's `--model` parser over a catalog: an exact
 * `provider/id[:level]`, or an id pi does not know on a provider it does
 * (kept as a custom id), else an error. */
function parser(catalog: readonly CatalogModel[]): RouteInput["resolveText"] {
  return (text) => {
    const colon = text.lastIndexOf(":");
    const level = colon > 0 ? text.slice(colon + 1) : undefined;
    const base =
      level !== undefined && /^(low|medium|high)$/.test(level) ? text.slice(0, colon) : text;
    const slash = base.indexOf("/");
    const provider = base.slice(0, slash);
    const id = base.slice(slash + 1);
    const thinking = base === text ? {} : { thinking: level! };
    const hit = catalog.find((m) => m.provider === provider && m.id === id);
    if (hit) return { model: hit, ...thinking };
    const anchor = catalog.find((m) => m.provider === provider);
    if (slash > 0 && anchor) return { model: { ...anchor, id }, custom: true, ...thinking };
    return { error: `Model "${text}" not found.` };
  };
}

const ALPHA = [model("alpha", "alpha-5.1"), model("alpha", "alpha-4.2")];
const BETA = [model("beta", "beta-6.0", { cost: { input: 2, output: 8 } })];
const GAMMA = [model("gamma", "gamma-5.1")];
const CATALOG = [...ALPHA, ...BETA, ...GAMMA, model("delta", "alpha-5.1")];

function input(o: Partial<RouteInput> & { inventory: ProviderInventory[] }): RouteInput {
  return { skipped: [], resolveText: parser(CATALOG), ...o };
}

function routed(o: Partial<RouteInput> & { inventory: ProviderInventory[] }): ModelRoute {
  const r = resolveRoute(input(o));
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.refusal)}`);
  return r.route;
}

function refused(o: Partial<RouteInput> & { inventory: ProviderInventory[] }): RouteRefusal {
  const r = resolveRoute(input(o));
  if (r.ok) throw new Error(`routed: ${r.route.spec}`);
  return r.refusal;
}

const ask = (provider: string): ModelChoice => ({
  provider,
  model: null,
  via: "ask",
  no_estimate_ok: [],
});
const use = (provider: string, id: string | null = null): ModelChoice => ({
  provider,
  model: id,
  via: "use",
  no_estimate_ok: [],
});
const short = (provider: string): SkippedLogin => ({
  provider,
  name: `${provider.toUpperCase()} Inc`,
  expiresAt: new Date(2030, 0, 1, 14, 25).getTime(),
});

describe("resolveRoute: with nothing pinned", () => {
  it("nothing at all is refused, and each empty case has its own code", () => {
    expect(refused({ inventory: [] })).toEqual({ code: "no-credential" });
    expect(refused({ inventory: [], skipped: [short("alpha")] })).toEqual({
      code: "login-too-short",
      logins: [short("alpha")],
    });
    // A credential pi has, none of whose models reasons: not "no credential".
    const dull = entry("alpha", [model("alpha", "alpha-5.1", { reasoning: false })]);
    expect(refused({ inventory: [dull] })).toEqual({ code: "no-model", providers: ["alpha"] });
  });

  it("one usable provider is the route, on its newest model, and nobody is asked", () => {
    const r = routed({ inventory: [entry("alpha", ALPHA)] });
    expect(r).toMatchObject({
      provider: "alpha",
      modelId: "alpha-5.1",
      providerName: "ALPHA Inc",
      spec: "alpha/alpha-5.1",
      thinking: null,
      source: "only-credential",
      pick: "newest",
      piDefaultId: null,
      custom: false,
      movedFrom: null,
      priced: true,
      ask: false,
      alternatives: [],
      notices: [],
    });
  });

  // MUTATION: sort by provider id before the credential class in
  // usableProviders — the first case picks `alpha` and this fails.
  it("a stored login goes before an environment key, which goes before an ambient identity", () => {
    const stored = entry("gamma", GAMMA, { origin: "stored" });
    const env = entry("beta", BETA, { origin: "env-key" });
    const ambient = entry("alpha", ALPHA, { origin: "ambient" });
    const r = routed({ inventory: [ambient, env, stored] });
    expect(r).toMatchObject({ provider: "gamma", source: "credential-order", ask: false });
    expect(r.alternatives.map((a) => a.provider)).toEqual(["beta", "alpha"]);
    expect(routed({ inventory: [ambient, env] }).provider).toBe("beta");
    for (const origin of ["stored", "runtime", "models-json"] as const)
      expect(credentialClass(origin)).toBe(0);
    expect(credentialClass("env-key")).toBe(1);
    expect(credentialClass("ambient")).toBe(2);
  });

  it("within a class the newer picked model wins, then the dearer, then the provider id", () => {
    // beta-6.0 against alpha-5.1: the version.
    expect(routed({ inventory: [entry("alpha", ALPHA), entry("beta", BETA)] }).provider).toBe(
      "beta",
    );
    // The same version: the higher list price.
    const dear = entry("zeta", [model("zeta", "zeta-5.1", { cost: { input: 3, output: 9 } })]);
    expect(routed({ inventory: [entry("alpha", ALPHA), dear] }).provider).toBe("zeta");
    // Equal picks (one key, two providers): the id.
    const twin = entry("alpha-cn", [model("alpha-cn", "alpha-5.1")]);
    expect(routed({ inventory: [twin, entry("alpha", ALPHA)] }).provider).toBe("alpha");
  });

  it("the provider pi itself is on goes first, whatever its class", () => {
    const r = routed({
      inventory: [entry("beta", BETA), entry("alpha", ALPHA, { origin: "env-key" })],
      piProvider: { provider: "alpha", from: "pi-settings" },
    });
    expect(r).toMatchObject({ provider: "alpha", source: "pi-provider", ask: false });
    // A saved provider with no usable credential decides nothing.
    const other = routed({
      inventory: [entry("beta", BETA), entry("alpha", ALPHA)],
      piProvider: { provider: "gamma", from: "pi-settings" },
    });
    expect(other).toMatchObject({ provider: "beta", source: "credential-order" });
  });

  // MUTATION: set `ask` whenever two providers are usable — the stored login
  // beside an environment key asks and the second case fails.
  it("asks only when two or more providers tie in the best credential class", () => {
    const two = routed({ inventory: [entry("alpha", ALPHA), entry("beta", BETA)] });
    expect(two.ask).toBe(true);
    // The first option of the question is the one the order takes.
    expect([two.provider, ...two.alternatives.map((a) => a.provider)]).toEqual(["beta", "alpha"]);
    const mixed = routed({
      inventory: [entry("alpha", ALPHA), entry("beta", BETA, { origin: "env-key" })],
    });
    expect(mixed).toMatchObject({ provider: "alpha", ask: false });
    expect(mixed.alternatives).toEqual([
      {
        provider: "beta",
        providerName: "BETA Inc",
        modelId: "beta-6.0",
        spec: "beta/beta-6.0",
        credential: { kind: "api_key", origin: "env-key", subscription: false },
        priced: true,
      },
    ]);
    // pi's own provider goes first and the tie is still a question.
    const piFirst = routed({
      inventory: [entry("alpha", ALPHA), entry("beta", BETA)],
      piProvider: { provider: "alpha", from: "pi-session" },
    });
    expect(piFirst).toMatchObject({ provider: "alpha", source: "pi-provider", ask: true });
  });

  it("the answer to an earlier question wins among the usable providers", () => {
    const r = routed({
      inventory: [entry("alpha", ALPHA), entry("beta", BETA)],
      choice: ask("alpha"),
      piProvider: { provider: "beta", from: "pi-settings" },
    });
    expect(r).toMatchObject({
      provider: "alpha",
      modelId: "alpha-5.1",
      source: "remembered",
      pick: "newest",
      ask: false,
      notices: [],
    });
  });

  // MUTATION: refuse when the remembered provider is not usable — this fails.
  it("an answer whose provider is not usable here falls through, says so and does not ask again", () => {
    const r = routed({
      inventory: [entry("alpha", ALPHA), entry("beta", BETA)],
      choice: ask("gamma"),
    });
    expect(r).toMatchObject({ provider: "beta", source: "credential-order", ask: false });
    expect(r.notices).toEqual([
      "the provider you chose earlier (gamma) has no usable credential here",
    ]);
    // pi's name for it, when a skipped login carries one.
    const named = routed({
      inventory: [entry("alpha", ALPHA)],
      choice: ask("gamma"),
      skipped: [short("gamma")],
    });
    expect(named.source).toBe("only-credential");
    expect(named.notices).toEqual([
      "skipped GAMMA Inc: its login expires at 14:25 and nothing here renews it",
      "the provider you chose earlier (GAMMA Inc) has no usable credential here",
    ]);
  });

  it("says once what the pick leaned on: pi's default, a guard, a default it could not read", () => {
    // The newest is not pi's default: the route names pi's.
    const newer = routed({ inventory: [entry("alpha", ALPHA, { piDefaultId: "alpha-4.2" })] });
    expect(newer).toMatchObject({ modelId: "alpha-5.1", pick: "newest", piDefaultId: "alpha-4.2" });
    expect(newer.notices).toEqual([]);
    // The newest is priced far below pi's default: the default runs.
    const guarded = routed({
      inventory: [
        entry(
          "alpha",
          [
            model("alpha", "alpha-9-mini", { cost: { input: 0.1, output: 0.4 } }),
            model("alpha", "alpha-5.1", { cost: { input: 5, output: 20 } }),
          ],
          { piDefaultId: "alpha-5.1" },
        ),
      ],
    });
    expect(guarded).toMatchObject({ modelId: "alpha-5.1", pick: "pi-default", piDefaultId: null });
    expect(guarded.notices).toEqual([
      "pi's default on ALPHA Inc runs, since the newest version (alpha-9-mini) is priced far below it",
    ]);
    const unread = routed({ inventory: [entry("alpha", ALPHA, { piDefaultUnread: true })] });
    expect(unread.notices).toEqual([
      "pi's default for alpha could not be read: picked by version only",
    ]);
  });

  it("a model pi has no price for is a route, marked unpriced", () => {
    const free = entry("alpha", [model("alpha", "alpha-5.1", { cost: { input: 0, output: 0 } })]);
    expect(routed({ inventory: [free] }).priced).toBe(false);
  });
});

describe("resolveRoute: a choice the person stated", () => {
  it("a provider alone holds like a pin, with the model by the rule", () => {
    const r = routed({
      inventory: [entry("alpha", ALPHA), entry("beta", BETA)],
      choice: use("alpha"),
      piProvider: { provider: "beta", from: "pi-settings" },
    });
    expect(r).toMatchObject({
      provider: "alpha",
      modelId: "alpha-5.1",
      source: "choice",
      pick: "newest",
      ask: false,
    });
    expect(r.alternatives.map((a) => a.provider)).toEqual(["beta"]);
  });

  // MUTATION: run a stated model through the candidate filter — the model
  // that does not reason is refused and this fails.
  it("a named model runs as named, unfiltered: the one way onto a provider the rule cannot pick on", () => {
    const dull = model("alpha", "alpha-plain", { reasoning: false, contextWindow: 8000 });
    const r = resolveRoute({
      inventory: [entry("alpha", [dull])],
      skipped: [],
      choice: use("alpha", "alpha-plain"),
      resolveText: parser([dull]),
    });
    expect(r).toMatchObject({
      ok: true,
      route: { spec: "alpha/alpha-plain", source: "choice", pick: "pinned", custom: false },
    });
  });

  it("a provider with no model the rule accepts is `no-model` for that provider", () => {
    const dull = entry("alpha", [model("alpha", "alpha-5.1", { reasoning: false })]);
    expect(refused({ inventory: [dull, entry("beta", BETA)], choice: use("alpha") })).toEqual({
      code: "no-model",
      providers: ["alpha"],
    });
  });

  // MUTATION: call moveToCredentialed for a stated choice — `delta` serves
  // the id, the run moves there and this fails.
  it("is never moved to another provider: no credential is a refusal that names the choice", () => {
    expect(
      refused({
        inventory: [entry("delta", [model("delta", "alpha-5.1")])],
        choice: use("alpha", "alpha-5.1"),
      }),
    ).toEqual({
      code: "pin-no-credential",
      pin: "alpha/alpha-5.1",
      provider: "alpha",
      from: "choice",
      candidates: [],
    });
    expect(refused({ inventory: [entry("beta", BETA)], choice: use("alpha") })).toEqual({
      code: "pin-no-credential",
      pin: "alpha",
      provider: "alpha",
      from: "choice",
      candidates: [],
    });
  });

  it("a login left out as too short is refused as that, and a model pi does not know as that", () => {
    expect(
      refused({
        inventory: [entry("beta", BETA)],
        choice: use("alpha"),
        skipped: [short("alpha")],
      }),
    ).toEqual({ code: "login-too-short", logins: [short("alpha")] });
    expect(refused({ inventory: [entry("alpha", ALPHA)], choice: use("omega", "x") })).toEqual({
      code: "pin-unknown",
      pin: "omega/x",
      detail: 'Model "omega/x" not found.',
    });
  });
});

describe("resolvePin: a pin is pi's parse of the text, then the one move rule", () => {
  it("a pin on a credentialed provider is the route, with the level its suffix named", () => {
    const r = routed({
      inventory: [entry("alpha", ALPHA), entry("beta", BETA)],
      pin: { text: "alpha/alpha-4.2:high", from: "flag" },
      // A pin outranks everything else that could decide.
      choice: use("beta"),
      piProvider: { provider: "beta", from: "pi-settings" },
    });
    expect(r).toMatchObject({
      provider: "alpha",
      modelId: "alpha-4.2",
      spec: "alpha/alpha-4.2",
      thinking: "high",
      source: "flag",
      pick: "pinned",
      piDefaultId: null,
      movedFrom: null,
      ask: false,
    });
    expect(r.alternatives.map((a) => a.spec)).toEqual(["beta/beta-6.0"]);
    expect(
      routed({
        inventory: [entry("alpha", ALPHA)],
        pin: { text: "alpha/alpha-5.1", from: "config" },
      }),
    ).toMatchObject({ source: "config", thinking: null });
  });

  it("an id pi does not know on a provider it does is sent as written, and shown as custom", () => {
    const r = routed({
      inventory: [entry("alpha", ALPHA)],
      pin: { text: "alpha/my-deployment", from: "config" },
    });
    expect(r).toMatchObject({ spec: "alpha/my-deployment", custom: true, pick: "pinned" });
  });

  it("a text pi cannot read is `pin-unknown`, with pi's own sentence", () => {
    expect(
      refused({ inventory: [entry("alpha", ALPHA)], pin: { text: "omega/x", from: "flag" } }),
    ).toEqual({ code: "pin-unknown", pin: "omega/x", detail: 'Model "omega/x" not found.' });
  });

  it("a pin on a login left out as too short is refused as that, never moved", () => {
    const r = resolvePin({
      ...input({
        inventory: [entry("delta", [model("delta", "alpha-5.1")])],
        skipped: [short("alpha"), short("beta")],
      }),
      pin: { text: "alpha/alpha-5.1", from: "config" },
    });
    expect(r).toEqual({
      ok: false,
      refusal: { code: "login-too-short", logins: [short("alpha")] },
    });
  });

  it("a pin whose provider has no credential moves to the one provider that serves the id", () => {
    const r = routed({
      inventory: [entry("delta", [model("delta", "alpha-5.1")]), entry("beta", BETA)],
      pin: { text: "alpha/alpha-5.1:medium", from: "config" },
    });
    expect(r).toMatchObject({
      provider: "delta",
      spec: "delta/alpha-5.1",
      movedFrom: "alpha",
      thinking: "medium",
      source: "config",
      pick: "pinned",
      custom: false,
    });
  });

  it("no provider serves it, or several unrelated ones do: refused, with the candidates named", () => {
    expect(
      refused({ inventory: [entry("beta", BETA)], pin: { text: "alpha/alpha-5.1", from: "flag" } }),
    ).toEqual({
      code: "pin-no-credential",
      pin: "alpha/alpha-5.1",
      provider: "alpha",
      from: "flag",
      candidates: [],
    });
    expect(
      refused({
        inventory: [
          entry("zeta", [model("zeta", "alpha-5.1")]),
          entry("delta", [model("delta", "alpha-5.1")]),
        ],
        pin: { text: "alpha/alpha-5.1", from: "config" },
      }),
    ).toEqual({
      code: "pin-no-credential",
      pin: "alpha/alpha-5.1",
      provider: "alpha",
      from: "config",
      candidates: ["delta", "zeta"],
    });
  });
});

describe("moveToCredentialed: the same model id on another credentialed provider", () => {
  const serving = (provider: string, id: string, origin: CredentialOrigin = "stored") =>
    entry(provider, [model(provider, id)], { origin });
  const named = { provider: "alpha-legacy", id: "alpha-5.1" };

  it("no other provider serves the id: no move", () => {
    expect(moveToCredentialed(named, [])).toBeNull();
    expect(moveToCredentialed(named, [serving("beta", "beta-6.0")])).toBeNull();
    // The named provider itself is never its own candidate.
    expect(moveToCredentialed(named, [serving("alpha-legacy", "alpha-5.1")])).toBeNull();
  });

  // MUTATION: match a candidate by its id's last segment — `beta` serves
  // `vendor/alpha-5.1` and the first case moves there; this fails.
  it("the id is an exact, case-sensitive string: no leaf match, no near match", () => {
    for (const id of ["vendor/alpha-5.1", "alpha-5-1", "Alpha-5.1", "alpha-5.1-fast"])
      expect(moveToCredentialed(named, [serving("beta", id)]), id).toBeNull();
  });

  it("exactly one candidate: it, whoever it is", () => {
    expect(moveToCredentialed(named, [serving("beta", "alpha-5.1")])).toEqual({ provider: "beta" });
  });

  // MUTATION: take the first candidate by provider id — `aaa` wins over the
  // family and the first case fails; drop the ambiguity and the second fails.
  it("the named provider's own family goes first; unrelated candidates are not a guess to make", () => {
    const family = serving("alpha", "alpha-5.1");
    const others = [serving("aaa", "alpha-5.1"), serving("zeta", "alpha-5.1")];
    expect(moveToCredentialed(named, [...others, family])).toEqual({ provider: "alpha" });
    expect(moveToCredentialed(named, others)).toEqual({ ambiguous: ["aaa", "zeta"] });
  });

  it("several of the family: the best credential class, then the provider id", () => {
    expect(
      moveToCredentialed(named, [
        serving("alpha", "alpha-5.1", "env-key"),
        serving("alpha-cloud", "alpha-5.1", "stored"),
      ]),
    ).toEqual({ provider: "alpha-cloud" });
    expect(
      moveToCredentialed(named, [
        serving("alpha-cloud", "alpha-5.1"),
        serving("alpha", "alpha-5.1"),
      ]),
    ).toEqual({ provider: "alpha" });
  });

  it("the remembered provider breaks a tie between unrelated candidates, and only when it is one", () => {
    const others = [serving("aaa", "alpha-5.1"), serving("zeta", "alpha-5.1")];
    expect(moveToCredentialed(named, others, "zeta")).toEqual({ provider: "zeta" });
    expect(moveToCredentialed(named, others, "beta")).toEqual({ ambiguous: ["aaa", "zeta"] });
  });

  // The answers the two-provider twin gave, with no name in the rule.
  it("the pair: each of the two logins of one vendor runs the other's pin", () => {
    const id = "gpt-6.1-sol";
    expect(moveToCredentialed({ provider: "openai-codex", id }, [serving("openai", id)])).toEqual({
      provider: "openai",
    });
    expect(moveToCredentialed({ provider: "openai", id }, [serving("openai-codex", id)])).toEqual({
      provider: "openai-codex",
    });
    // Three logins serve the id: the family, not the alphabet.
    expect(
      moveToCredentialed({ provider: "openai-codex", id }, [
        serving("github-copilot", id),
        serving("openai", id),
      ]),
    ).toEqual({ provider: "openai" });
  });
});

describe("what a refusal and an expiry say", () => {
  it("RouteRefused carries the refusal, and its message names what was refused", () => {
    const refusal: RouteRefusal = {
      code: "pin-no-credential",
      pin: "alpha/alpha-5.1",
      provider: "alpha",
      from: "config",
      candidates: ["delta", "zeta"],
    };
    const e = new RouteRefused(refusal);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("RouteRefused");
    expect(e.refusal).toEqual(refusal);
    expect(e.message).toBe(
      "the run is pinned to alpha/alpha-5.1, and pi has no credential for alpha; the same model is also served by delta, zeta: name one",
    );
    expect(new RouteRefused({ code: "no-credential" }).message).toBe("pi has no model credential");
    expect(new RouteRefused({ code: "login-too-short", logins: [short("alpha")] }).message).toBe(
      "the ALPHA Inc login expires at 14:25, inside this run, and nothing here renews it",
    );
  });

  it("an expiry is a wall-clock time, and a login that never expires says never", () => {
    expect(expiryClock(new Date(2030, 5, 1, 9, 5).getTime())).toBe("09:05");
    // pi writes the largest safe integer for a login that does not expire.
    expect(expiryClock(Number.MAX_SAFE_INTEGER)).toBe("never");
    expect(expiryClock(Number.POSITIVE_INFINITY)).toBe("never");
    expect(expiryClock(Number.NaN)).toBe("never");
  });
});

const has = (...providers: string[]) => ({ hasCredential: (p: string) => providers.includes(p) });

describe("the twin (until its last caller moves): routeProvider", () => {
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

  // The twin knows one pair and nothing else. The rule that replaces it
  // (`moveToCredentialed`, above) moves any provider, by family or to a sole
  // candidate.
  it("the twin itself knows no other pair", () => {
    expect(routeProvider("anthropic", "x", has("openai", "openai-codex"))).toBe("anthropic");
  });
});

describe("the twin: routeModelSpec", () => {
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

describe("the twin: providersInAuthJson", () => {
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
  const ID = "gpt-6.1-sol";
  const pi = (provider: string, id: string): Model<Api> => ({ provider, id }) as Model<Api>;

  /** A host by shape: pi's catalog serves the id on the two logins of the
   * pair, and `credentials` are the providers the host has a credential for. */
  function host(
    credentials: string[],
    o: { serves?: string[]; skipped?: SkippedLogin[]; prefer?: string } = {},
  ) {
    const serves = o.serves ?? ["openai", "openai-codex"];
    const moves: RouteMove[] = [];
    const source: ModelSource = {
      getModel: (provider, id) =>
        serves.includes(provider) && id === ID ? pi(provider, id) : undefined,
      inventory: async () =>
        credentials.filter((p) => serves.includes(p)).map((p) => entry(p, [model(p, ID)])),
      routeModel: async () => pi("route", "route-model"),
      ...(o.skipped ? { skipped: o.skipped } : {}),
      ...(o.prefer !== undefined ? { prefer: o.prefer } : {}),
      moved: (move) => void moves.push(move),
    };
    return { source, moves };
  }

  it("the production login: openai-codex stays openai-codex", async () => {
    const h = host(["openai-codex", "openai"]);
    const m = await resolveModel(h.source, `openai-codex/${ID}`);
    expect(m).toMatchObject({ provider: "openai-codex", id: ID });
    expect(h.moves).toEqual([]);
  });

  // MUTATION: make resolveModel look the spec up as given again — this fails.
  it("only a Sign in with ChatGPT login or an OpenAI key: the same model on openai", async () => {
    const h = host(["openai"]);
    const m = await resolveModel(h.source, `openai-codex/${ID}`);
    expect(m).toMatchObject({ provider: "openai", id: ID });
    expect(h.moves).toEqual([{ from: "openai-codex", to: "openai", id: ID }]);
    // And the other way round.
    const back = await resolveModel(host(["openai-codex"]).source, `openai/${ID}`);
    expect(back).toMatchObject({ provider: "openai-codex", id: ID });
  });

  it("no login at all: refused before a session exists, naming the pin", async () => {
    const refusal = await resolveModel(host([]).source, `openai-codex/${ID}`).then(
      () => null,
      (e: unknown) => e,
    );
    expect(refusal).toBeInstanceOf(RouteRefused);
    expect((refusal as RouteRefused).refusal).toEqual({
      code: "pin-no-credential",
      pin: `openai-codex/${ID}`,
      provider: "openai-codex",
      from: "config",
      candidates: [],
    });
  });

  // MUTATION: restore the twin's "only the pair moves" in resolveModel — the
  // first case stays on the provider with no credential and this fails.
  it("any provider moves by the one rule: to a sole candidate, to its family, never by a guess", async () => {
    const serves = ["anthropic", "github-copilot", "openai", "openai-codex", "opencode"];
    // One other provider serves the id: it.
    const sole = host(["github-copilot"], { serves });
    expect(await resolveModel(sole.source, `anthropic/${ID}`)).toMatchObject({
      provider: "github-copilot",
    });
    expect(sole.moves).toEqual([{ from: "anthropic", to: "github-copilot", id: ID }]);
    // Three logins serve the pair's id: the family, not the alphabet.
    const three = host(["github-copilot", "openai", "opencode"], { serves });
    expect(await resolveModel(three.source, `openai-codex/${ID}`)).toMatchObject({
      provider: "openai",
    });
    // Unrelated candidates: refused, and the refusal names them.
    const guess = host(["github-copilot", "opencode"], { serves });
    await expect(resolveModel(guess.source, `anthropic/${ID}`)).rejects.toMatchObject({
      refusal: { code: "pin-no-credential", candidates: ["github-copilot", "opencode"] },
    });
    expect(guess.moves).toEqual([]);
    // The remembered provider is the tie-break.
    const preferred = host(["github-copilot", "opencode"], { serves, prefer: "opencode" });
    expect(await resolveModel(preferred.source, `anthropic/${ID}`)).toMatchObject({
      provider: "opencode",
    });
  });

  it("a login left out as too short is refused as that, never moved", async () => {
    const h = host(["openai"], { skipped: [short("openai-codex")] });
    await expect(resolveModel(h.source, `openai-codex/${ID}`)).rejects.toMatchObject({
      refusal: { code: "login-too-short", logins: [short("openai-codex")] },
    });
    expect(h.moves).toEqual([]);
  });

  it("an unknown model is still refused as unknown, with or without a credential", async () => {
    await expect(resolveModel(host(["openai"]).source, "openai-codex/nope")).rejects.toThrow(
      /not known to the host/,
    );
    await expect(resolveModel(host(["openai"]).source, "openai/nope")).rejects.toThrow(
      /not known to the host/,
    );
    await expect(resolveModel(host([]).source, "nope/none")).rejects.toThrow(
      /not known to the host/,
    );
    await expect(resolveModel(host(["openai"]).source, "bare-id")).rejects.toThrow(
      /not known to the host/,
    );
  });

  it("a model object is itself, and no model at all is the host's route", async () => {
    const h = host([]);
    const given = pi("anywhere", "anything");
    expect(await resolveModel(h.source, given)).toBe(given);
    expect(await resolveModel(h.source, undefined)).toMatchObject({ id: "route-model" });
    expect(await resolveModel(h.source, "")).toMatchObject({ id: "route-model" });
  });
});
