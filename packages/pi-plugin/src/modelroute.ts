// Which model a review runs on.
//
// One route per run: a provider and one of its models, chosen from what pi has
// a usable credential for. This module is the rule, and it is pure: the caller
// hands it the inventory (which providers have a credential, and their
// models), what pins or remembers a choice, and pi's own reading of a model
// text. The SDK host builds those from pi's registry
// (packages/pi-plugin/src/engine/pisdk.ts) and an extension inside a running
// pi builds them from the same registry facade, so the two cannot disagree.
//
// The order, in `resolveRoute`:
//   1. a pin (`--model`, `[models] model`) is the route, or a refusal;
//   2. a choice the person stated holds like a pin;
//   3. otherwise the providers that have a model the pick rule accepts
//      (modelpick.ts) are the usable ones;
//   4. the answer to an earlier question wins among them;
//   5. one usable provider is the route;
//   6. several are ordered: the provider pi itself is on, a stored login
//      before an environment key before an ambient cloud credential, then
//      the newer and dearer picked model, then the provider id;
//   7. two or more in the best credential class is a question a host may ask.
//
// A spec that names a provider with no credential runs on another provider
// that serves the same model id when that choice is not a guess
// (`moveToCredentialed`): the same provider family, the remembered provider,
// or the only candidate. Several unrelated candidates are a refusal that
// names them. The rule names no provider and no model.
//
// The words are here too, so every surface says the same thing: the one line
// that names the route and why (`routeNotice`), and the five refusals
// (`refusalText`), each worded for the app's CLI or for the plugin inside pi.

import { compareModels, CONTEXT_FLOOR, listPrice, pickModel, type ModelPick } from "./modelpick.js";
import type { CoreConfig } from "./reviewconfig.js";

// ---- what the rule reads -------------------------------------------------------

/** What the rule reads of a pi model. A structural subset of pi-ai's Model,
 * so a catalog entry and a test literal both fit. */
export interface CatalogModel {
  provider: string;
  id: string;
  name?: string;
  api?: string;
  reasoning?: boolean;
  contextWindow?: number;
  /** USD per million tokens. */
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

/** Where pi found a provider's credential:
 *  - `stored`: pi's own login store (a login or a stored key);
 *  - `runtime`: a key handed to pi for this process only;
 *  - `models-json`: a key or a command in the person's `models.json`;
 *  - `env-key`: an API key or token in an environment variable;
 *  - `ambient`: a cloud identity the environment carries (a profile, a role,
 *    default credentials), which a shell may hold without anyone meaning a
 *    review to spend on it. */
export type CredentialOrigin = "stored" | "runtime" | "models-json" | "env-key" | "ambient";

export interface ProviderCredential {
  kind: "oauth" | "api_key";
  origin: CredentialOrigin;
  /** pi's own label for an environment source (an env name, or a phrase). */
  label?: string;
  /** An OAuth login backed by a provider subscription. */
  subscription: boolean;
}

/** One provider pi has a credential for that this surface can use. */
export interface ProviderInventory {
  provider: string;
  /** pi's display name, else the id. */
  name: string;
  credential: ProviderCredential;
  /** The chat models this credential can use (pi's available list for the provider). */
  models: readonly CatalogModel[];
  /** pi's default model id for the provider; undefined when pi names none. */
  piDefaultId?: string;
  /** pi's default could not be read at all: the guard has no reference. */
  piDefaultUnread?: boolean;
}

/** A stored login left out because it cannot last this run on this surface. */
export interface SkippedLogin {
  provider: string;
  name: string;
  /** When the login expires, in ms since the epoch. */
  expiresAt: number;
}

/** The remembered choice (modelchoice.ts keeps it in a file beside pi's logins).
 *  - `via: "ask"`: the answer to the question a host asked. A preference:
 *    `model` is null, and when its provider is not usable the run goes on by
 *    the order.
 *  - `via: "use"`: the person stated it. It holds like a pin; `model: null`
 *    means "this provider, model by the rule". */
export interface ModelChoice {
  provider: string;
  model: string | null;
  via: "ask" | "use";
  /** The models the person agreed to run with no price estimate. */
  no_estimate_ok: readonly string[];
}

/** What pi's own `--model` parser says about a text. */
export interface TextResolution {
  model?: CatalogModel;
  /** The level a `:suffix` named. */
  thinking?: string;
  /** pi kept the text as a custom id on a known provider. */
  custom?: boolean;
  error?: string;
}

export interface RouteInput {
  inventory: readonly ProviderInventory[];
  skipped: readonly SkippedLogin[];
  /** `--model`, else the config's pin. The text as given. */
  pin?: { text: string; from: "flag" | "config" };
  choice?: ModelChoice;
  /** The provider pi itself is on: its saved default, or (inside pi) the session's model. */
  piProvider?: { provider: string; from: "pi-settings" | "pi-session" };
  resolveText: (text: string) => TextResolution;
}

export type RouteSource =
  | "flag"
  | "config"
  | "choice"
  | "remembered"
  | "only-credential"
  | "pi-provider"
  | "credential-order";

/** Another usable provider, with the model it would run. */
export interface RouteAlternative {
  provider: string;
  providerName: string;
  modelId: string;
  spec: string;
  credential: ProviderCredential;
  priced: boolean;
}

export interface ModelRoute {
  provider: string;
  modelId: string;
  providerName: string;
  /** `provider/id`, never a level. */
  spec: string;
  /** The level a pin's `:suffix` named, for the main session only. */
  thinking: string | null;
  source: RouteSource;
  pick: "pinned" | "newest" | "pi-default";
  /** pi's own default on the provider when the pick differs from it. */
  piDefaultId: string | null;
  /** The id is not in pi's catalog: pi sends it as a custom id. */
  custom: boolean;
  /** The provider the pin named, when the run moved off it. */
  movedFrom: string | null;
  credential: ProviderCredential;
  /** pi has a non-zero list price for the model. */
  priced: boolean;
  /** Two or more providers tie in the best credential class and nothing decided: a host may ask. */
  ask: boolean;
  /** Every other usable provider with the model it would run, best first. */
  alternatives: readonly RouteAlternative[];
  /** One line per fact worth saying once. */
  notices: readonly string[];
}

export type RouteRefusal =
  | { code: "no-credential" }
  | { code: "login-too-short"; logins: readonly SkippedLogin[] }
  | { code: "no-model"; providers: readonly string[] }
  | {
      code: "pin-no-credential";
      pin: string;
      provider: string;
      from: "flag" | "config" | "choice";
      /** The other credentialed providers that serve the pinned id, when the
       * run would have had to guess among them. */
      candidates: readonly string[];
    }
  | { code: "pin-unknown"; pin: string; detail: string };

export type RouteResult = { ok: true; route: ModelRoute } | { ok: false; refusal: RouteRefusal };

/** A route that cannot be had, thrown where a result cannot be returned (a
 * session being opened). Carries the refusal, so a host can word it. */
export class RouteRefused extends Error {
  readonly refusal: RouteRefusal;
  constructor(refusal: RouteRefusal) {
    super(describeRefusal(refusal));
    this.name = "RouteRefused";
    this.refusal = refusal;
  }
}

/** The refusal in one plain sentence, with no surface's remedy in it. */
function describeRefusal(r: RouteRefusal): string {
  switch (r.code) {
    case "no-credential":
      return "pi has no model credential";
    case "login-too-short":
      return `the ${r.logins.map((l) => l.name).join(", ")} login expires at ${r.logins
        .map((l) => expiryClock(l.expiresAt))
        .join(", ")}, inside this run, and nothing here renews it`;
    case "no-model":
      return `pi has a credential for ${r.providers.join(", ")}, but none of their models passes the review's filter`;
    case "pin-no-credential":
      return (
        `the run is pinned to ${r.pin}, and pi has no credential for ${r.provider}` +
        (r.candidates.length > 0
          ? `; the same model is also served by ${r.candidates.join(", ")}: name one`
          : "")
      );
    case "pin-unknown":
      return `pi knows no model ${JSON.stringify(r.pin)} (${r.detail})`;
  }
}

/** A login's expiry as a wall-clock `HH:MM`, or `never` for a time no date
 * holds (pi writes the largest safe integer for a login that does not expire,
 * and a Date made from it is invalid). */
export function expiryClock(expiresAt: number): string {
  const d = new Date(expiresAt);
  if (!Number.isFinite(expiresAt) || Number.isNaN(d.getTime())) return "never";
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

// ---- the order -----------------------------------------------------------------

/** How much a credential says the person meant it for this: 0 for one pi
 * holds or was handed, 1 for an environment key, 2 for an ambient cloud
 * identity. Lower goes first. */
export function credentialClass(origin: CredentialOrigin): 0 | 1 | 2 {
  return origin === "env-key" ? 1 : origin === "ambient" ? 2 : 0;
}

/** A provider with the model the pick rule gives it. */
interface Usable {
  entry: ProviderInventory;
  picked: ModelPick<CatalogModel>;
}

/** The inventory entries that have a model the pick rule accepts, ordered:
 * `first` (the provider pi itself is on) when it is among them, then the
 * credential class, then the picked model (the pick rule's own comparator:
 * the newer version, then the higher list price), then the provider id. */
function usableProviders(inventory: readonly ProviderInventory[], first?: string): Usable[] {
  const usable: Usable[] = [];
  for (const entry of inventory) {
    const picked = pickModel(entry.models, entry.piDefaultId);
    if (picked !== null) usable.push({ entry, picked });
  }
  return usable.sort((a, b) => {
    if (first !== undefined && (a.entry.provider === first) !== (b.entry.provider === first))
      return a.entry.provider === first ? -1 : 1;
    const byClass =
      credentialClass(a.entry.credential.origin) - credentialClass(b.entry.credential.origin);
    if (byClass !== 0) return byClass;
    const byModel = compareModels(a.picked.model, b.picked.model);
    if (byModel !== 0) return byModel;
    return a.entry.provider < b.entry.provider ? -1 : a.entry.provider > b.entry.provider ? 1 : 0;
  });
}

const specOf = (provider: string, id: string): string => `${provider}/${id}`;

function alternativesOf(usable: readonly Usable[], provider: string): RouteAlternative[] {
  return usable
    .filter((u) => u.entry.provider !== provider)
    .map((u) => ({
      provider: u.entry.provider,
      providerName: u.entry.name,
      modelId: u.picked.model.id,
      spec: specOf(u.entry.provider, u.picked.model.id),
      credential: u.entry.credential,
      priced: listPrice(u.picked.model) > 0,
    }));
}

/** What a route says of a login it left out. */
export function skippedNotice(login: SkippedLogin): string {
  return `skipped ${login.name}: its login expires at ${expiryClock(login.expiresAt)} and nothing here renews it`;
}

function skippedNotices(skipped: readonly SkippedLogin[]): string[] {
  return skipped.map(skippedNotice);
}

/** The route on a provider's rule-picked model. */
function pickedRoute(
  u: Usable,
  source: RouteSource,
  usable: readonly Usable[],
  ask: boolean,
  notices: readonly string[],
): ModelRoute {
  const { entry, picked } = u;
  const said = [...notices];
  if (picked.guarded && picked.newest !== null)
    said.push(
      `pi's default on ${entry.name} runs, since the newest version (${picked.newest.id}) is priced far below it`,
    );
  if (entry.piDefaultUnread === true)
    said.push(`pi's default for ${entry.provider} could not be read: picked by version only`);
  return {
    provider: entry.provider,
    modelId: picked.model.id,
    providerName: entry.name,
    spec: specOf(entry.provider, picked.model.id),
    thinking: null,
    source,
    pick: picked.pick,
    piDefaultId:
      picked.pick === "newest" &&
      entry.piDefaultId !== undefined &&
      entry.piDefaultId !== picked.model.id
        ? entry.piDefaultId
        : null,
    custom: false,
    movedFrom: null,
    credential: entry.credential,
    priced: listPrice(picked.model) > 0,
    ask,
    alternatives: alternativesOf(usable, entry.provider),
    notices: said,
  };
}

/** The route on a model a pin or a stated choice names. */
function namedRoute(
  entry: ProviderInventory,
  model: CatalogModel,
  o: {
    source: RouteSource;
    thinking: string | null;
    custom: boolean;
    movedFrom: string | null;
    usable: readonly Usable[];
    notices: readonly string[];
  },
): ModelRoute {
  return {
    provider: entry.provider,
    modelId: model.id,
    providerName: entry.name,
    spec: specOf(entry.provider, model.id),
    thinking: o.thinking,
    source: o.source,
    pick: "pinned",
    piDefaultId: null,
    custom: o.custom,
    movedFrom: o.movedFrom,
    credential: entry.credential,
    priced: listPrice(model) > 0,
    ask: false,
    alternatives: alternativesOf(o.usable, entry.provider),
    notices: [...o.notices],
  };
}

const refuse = (refusal: RouteRefusal): RouteResult => ({ ok: false, refusal });

/**
 * The run's route, or why there is none. Pure, and it never asks: a host
 * that can ask does so when `route.ask` is set and resolves again with the
 * answer as `choice`.
 */
export function resolveRoute(input: RouteInput): RouteResult {
  if (input.pin !== undefined) return resolvePin({ ...input, pin: input.pin });
  const usable = usableProviders(input.inventory, input.piProvider?.provider);
  const notices = skippedNotices(input.skipped);
  const choice = input.choice;
  if (choice?.via === "use") return statedChoice(input, choice, usable, notices);

  if (usable.length === 0) {
    if (input.inventory.length > 0)
      return refuse({ code: "no-model", providers: input.inventory.map((e) => e.provider) });
    if (input.skipped.length > 0) return refuse({ code: "login-too-short", logins: input.skipped });
    return refuse({ code: "no-credential" });
  }

  // The answer to an earlier question. When its provider is not usable here
  // the run goes on by the order and does not ask again: the answer stands
  // for the day the credential is back.
  let asked = false;
  if (choice?.via === "ask") {
    const remembered = usable.find((u) => u.entry.provider === choice.provider);
    if (remembered !== undefined)
      return { ok: true, route: pickedRoute(remembered, "remembered", usable, false, notices) };
    notices.push(
      `the provider you chose earlier (${providerName(input, choice.provider)}) has no usable credential here`,
    );
    asked = true;
  }

  const first = usable[0]!;
  if (usable.length === 1)
    return { ok: true, route: pickedRoute(first, "only-credential", usable, false, notices) };
  // The best class present, which is not always the first provider's: the
  // provider pi is on goes first whatever its class.
  const bestClass = Math.min(...usable.map((u) => credentialClass(u.entry.credential.origin)));
  const tied = usable.filter((u) => credentialClass(u.entry.credential.origin) === bestClass);
  const source: RouteSource =
    input.piProvider !== undefined && first.entry.provider === input.piProvider.provider
      ? "pi-provider"
      : "credential-order";
  return {
    ok: true,
    route: pickedRoute(first, source, usable, !asked && tied.length >= 2, notices),
  };
}

/** pi's display name for a provider the inventory or the skipped logins hold, else the id. */
function providerName(input: Pick<RouteInput, "inventory" | "skipped">, provider: string): string {
  return (
    input.inventory.find((e) => e.provider === provider)?.name ??
    input.skipped.find((l) => l.provider === provider)?.name ??
    provider
  );
}

/** A choice the person stated: it holds like a pin, with no move to another
 * provider. With a model it runs that model unfiltered (the one way to run a
 * provider none of whose models the pick rule accepts); without, the rule
 * picks on that provider. */
function statedChoice(
  input: RouteInput,
  choice: ModelChoice,
  usable: readonly Usable[],
  notices: readonly string[],
): RouteResult {
  const pin = choice.model === null ? choice.provider : specOf(choice.provider, choice.model);
  const absent = (): RouteResult => {
    const logins = input.skipped.filter((l) => l.provider === choice.provider);
    return logins.length > 0
      ? refuse({ code: "login-too-short", logins })
      : refuse({
          code: "pin-no-credential",
          pin,
          provider: choice.provider,
          from: "choice",
          candidates: [],
        });
  };
  const entry = input.inventory.find((e) => e.provider === choice.provider);
  if (choice.model === null) {
    if (entry === undefined) return absent();
    const u = usable.find((x) => x.entry.provider === choice.provider);
    if (u === undefined) return refuse({ code: "no-model", providers: [choice.provider] });
    return { ok: true, route: pickedRoute(u, "choice", usable, false, notices) };
  }
  const r = input.resolveText(pin);
  if (r.error !== undefined || r.model === undefined)
    return refuse({ code: "pin-unknown", pin, detail: r.error ?? "no such model" });
  // pi reads `provider/id` as a hint and may answer with the same text as a
  // bare id on another provider when the named one has no credential. A
  // stated choice names its provider: that answer means "not usable here".
  if (entry === undefined || r.model.provider !== choice.provider) return absent();
  return {
    ok: true,
    route: namedRoute(entry, r.model, {
      source: "choice",
      thinking: null,
      custom: r.custom === true,
      movedFrom: null,
      usable,
      notices,
    }),
  };
}

/**
 * A pin (`--model`, the config's `model`) as a route: pi's own parse of the
 * text, then the one move rule. Nothing else.
 */
export function resolvePin(
  input: RouteInput & { pin: NonNullable<RouteInput["pin"]> },
): RouteResult {
  const { text, from } = input.pin;
  const r = input.resolveText(text);
  if (r.error !== undefined || r.model === undefined)
    return refuse({ code: "pin-unknown", pin: text, detail: r.error ?? "no such model" });
  const named = { provider: r.model.provider, id: r.model.id };
  const usable = usableProviders(input.inventory, input.piProvider?.provider);
  const base = {
    source: from,
    thinking: r.thinking ?? null,
    usable,
    notices: skippedNotices(input.skipped),
  } as const;
  const entry = input.inventory.find((e) => e.provider === named.provider);
  if (entry !== undefined)
    return {
      ok: true,
      route: namedRoute(entry, r.model, { ...base, custom: r.custom === true, movedFrom: null }),
    };
  // A login that exists and is too short is refused as such, never moved.
  const logins = input.skipped.filter((l) => l.provider === named.provider);
  if (logins.length > 0) return refuse({ code: "login-too-short", logins });
  const move = moveToCredentialed(named, input.inventory, input.choice?.provider);
  if (move !== null && "provider" in move) {
    const to = input.inventory.find((e) => e.provider === move.provider);
    const model = to?.models.find((m) => m.id === named.id);
    if (to !== undefined && model !== undefined)
      return {
        ok: true,
        route: namedRoute(to, model, { ...base, custom: false, movedFrom: named.provider }),
      };
  }
  return refuse({
    code: "pin-no-credential",
    pin: specOf(named.provider, named.id),
    provider: named.provider,
    from,
    candidates: move !== null && "ambiguous" in move ? move.ambiguous : [],
  });
}

/** The family a provider id belongs to: the text before its first `-`.
 * Two logins of one vendor share it; no name is written here. */
function familyOf(provider: string): string {
  const dash = provider.indexOf("-");
  return dash > 0 ? provider.slice(0, dash) : provider;
}

/**
 * Where a spec that names a provider with no credential may run instead.
 *
 * The candidates are the other credentialed providers whose available models
 * hold the same id, as an exact string: no leaf match, no fuzzy match. Among
 * them, in order: one of the named provider's own family (the best credential
 * class, then the id, when several); `prefer`, the remembered provider; the
 * only candidate. Several unrelated candidates are no move at all: a pin
 * states an intent, and among providers with other billing and other terms
 * the run does not guess.
 *
 * Null when no other provider serves the id. Call it only for a provider that
 * has no credential and no skipped login.
 */
export function moveToCredentialed(
  named: { provider: string; id: string },
  inventory: readonly ProviderInventory[],
  prefer?: string,
): { provider: string } | { ambiguous: readonly string[] } | null {
  const candidates = inventory.filter(
    (e) => e.provider !== named.provider && e.models.some((m) => m.id === named.id),
  );
  if (candidates.length === 0) return null;
  const family = candidates
    .filter((e) => familyOf(e.provider) === familyOf(named.provider))
    .sort(
      (a, b) =>
        credentialClass(a.credential.origin) - credentialClass(b.credential.origin) ||
        (a.provider < b.provider ? -1 : 1),
    );
  if (family[0] !== undefined) return { provider: family[0].provider };
  if (prefer !== undefined && candidates.some((e) => e.provider === prefer))
    return { provider: prefer };
  if (candidates.length === 1) return { provider: candidates[0]!.provider };
  return { ambiguous: candidates.map((e) => e.provider).sort() };
}

// ---- the words -----------------------------------------------------------------

/** Who is speaking: the app's CLI (`qcr`), or the plugin inside a running pi. */
export type RouteSurface = "app" | "plugin";

/** How a person changes the route, on each surface. */
const CHANGE_IT: Readonly<Record<RouteSurface, string>> = {
  app: "qcr model use <provider[/model]>",
  plugin: "/qcr-setup model",
};

/** How a person names one model (`provider/id`), on each surface. */
const nameIt = (surface: RouteSurface, spec: string): string =>
  surface === "app" ? `qcr model use ${spec}` : `--model ${spec}`;

/** What lists the usable models, on each surface. */
const LIST_IT: Readonly<Record<RouteSurface, string>> = {
  app: "qcr model",
  plugin: "/qcr-setup model",
};

/** The stretch at the end of a login's life in which pi renews it when it is
 * opened (pi's own five minutes). */
const PI_RENEWS_INSIDE_MS = 5 * 60_000;

/** A credential in a few words: where pi found it. A value is never part of
 * it; an environment source is named by pi's own label. */
export function credentialWords(credential: ProviderCredential): string {
  switch (credential.origin) {
    case "stored":
      return credential.kind === "oauth"
        ? `signed in with pi${credential.subscription ? " (subscription)" : ""}`
        : "an API key stored in pi";
    case "runtime":
      return "a key handed to pi for this run";
    case "models-json":
      return "a key in pi's models.json";
    case "env-key":
      return credential.label ?? "an environment key";
    case "ambient":
      return credential.label ?? "an ambient credential";
  }
}

/** How many providers the route was picked among. */
const providerCount = (route: ModelRoute): number => 1 + route.alternatives.length;

/** Why the order put this provider first among several. */
function orderReason(route: ModelRoute, surface: RouteSurface): string {
  if (route.source === "pi-provider")
    return surface === "plugin"
      ? `this pi session is on ${route.providerName}`
      : `pi itself starts on ${route.providerName}`;
  const own = credentialClass(route.credential.origin);
  // The same class as another provider's: the picked models decided.
  if (route.alternatives.some((a) => credentialClass(a.credential.origin) <= own))
    return "it has the newest model";
  if (own === 1) return "an environment key comes first";
  return route.credential.kind === "oauth"
    ? "a stored login comes first"
    : "a key pi holds comes first";
}

/**
 * Why the route is what it is, in a phrase: the `why:` of `qcr model` and of
 * the plugin's setup step. `configPath` is where the config that pins it is.
 */
export function routeWhy(
  route: ModelRoute,
  surface: RouteSurface,
  facts: { configPath?: string | null } = {},
): string {
  const moved =
    route.movedFrom !== null
      ? `; it runs on ${route.providerName}, since pi has no credential for ${route.movedFrom}`
      : "";
  switch (route.source) {
    case "flag":
      return `--model on this run${moved}`;
    case "config":
      return `pinned by [models] model${facts.configPath ? ` in ${facts.configPath}` : ""}${moved}`;
    case "choice":
      return `you chose it (${surface === "app" ? "qcr model use" : "/qcr-setup model"})`;
    case "remembered":
      return "you picked it when asked";
    case "only-credential":
      return "the one provider pi has a usable credential for";
    case "pi-provider":
      return `pi has credentials for ${providerCount(route)} providers; ${orderReason(route, surface)}`;
    case "credential-order": {
      const reason = orderReason(route, surface);
      return reason === "it has the newest model"
        ? `the newest model among ${providerCount(route)} providers`
        : reason;
    }
  }
}

/** How the model was picked on its provider, or null for a model a pin or a
 * choice named. */
export function routePicked(route: ModelRoute): string | null {
  if (route.pick === "pinned") return null;
  if (route.pick === "pi-default") return `pi's default on ${route.providerName}`;
  return (
    `the newest version on ${route.providerName}` +
    (route.piDefaultId !== null ? ` (pi's own default there: ${route.piDefaultId})` : "")
  );
}

/**
 * The route in lines a person reads once: the first names the model and why
 * it is the one (and how to change it, on this surface); each further line
 * is one of the route's own notices (a login left out, pi's default standing
 * in for the newest version, a default that could not be read).
 */
export function routeNoticeLines(route: ModelRoute, surface: RouteSurface): string[] {
  const how = CHANGE_IT[surface];
  let head: string;
  if (route.movedFrom !== null)
    head =
      `model: ${route.modelId} runs on ${route.providerName}: ${route.movedFrom}, which ` +
      `${route.source === "flag" ? "--model" : "the config"} names, has no credential here`;
  else
    switch (route.source) {
      case "flag":
        head = `model: ${route.spec} (pinned by --model)`;
        break;
      case "config":
        head = `model: ${route.spec} (pinned by [models] model)`;
        break;
      case "choice":
        head = `model: ${route.spec} (your choice; ${how} changes it)`;
        break;
      case "remembered":
        head = `model: ${route.spec} (you picked ${route.providerName} when asked; ${how} changes it)`;
        break;
      case "only-credential":
        head = `model: ${route.spec} (the provider pi has a credential for)`;
        break;
      case "pi-provider":
      case "credential-order":
        head =
          `model: ${route.spec} (picked among ${providerCount(route)} providers pi has credentials for: ` +
          `${orderReason(route, surface)}). Change it: ${how}, or --model for one run`;
        break;
    }
  const more: string[] = [];
  if (route.piDefaultId !== null)
    more.push(
      `pi's own default there is ${route.piDefaultId}: ` +
        nameIt(surface, specOf(route.provider, route.piDefaultId)),
    );
  if (route.custom) more.push(`not in pi's catalog for ${route.providerName}: sent as written`);
  // A cloud identity the shell happens to carry is named before anything is spent on it.
  if (route.credential.origin === "ambient" && route.credential.label !== undefined)
    more.push(`credential: ${route.credential.label}`);
  return [[head, ...more].join(". "), ...route.notices];
}

/** `routeNoticeLines` as one text, a line each. */
export function routeNotice(route: ModelRoute, surface: RouteSurface): string {
  return routeNoticeLines(route, surface).join("\n");
}

/** What a refusal's words may need beyond the refusal itself. */
export interface RefusalFacts {
  /** The pi agent dir the credentials were looked for in. */
  agentDir?: string;
  /** How long the run may last: the budget a login had to outlive. */
  needMs?: number;
  /** Where the config that holds the pin is. */
  configPath?: string | null;
  /** pi's display name for a provider id; omitted, the id is the name. */
  nameOf?: (provider: string) => string;
  now?: () => number;
}

/** "a", "a and b", "a, b and c". */
function listed(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * Why there is no route and what to do about it, for a person: one text per
 * refusal code, worded for the surface it is said on. The app's texts name
 * `qcr login` and the plugin's `/login`, which the host skills key on.
 */
export function refusalText(
  refusal: RouteRefusal,
  surface: RouteSurface,
  facts: RefusalFacts = {},
): string {
  const nameOf = facts.nameOf ?? ((provider: string): string => provider);
  switch (refusal.code) {
    case "no-credential":
      return surface === "plugin"
        ? "pi has no model credential. Run /login in pi, then /qcr-review again."
        : `pi has no model credential${facts.agentDir ? ` (agent dir ${facts.agentDir})` : ""}. ` +
            "Run `qcr login` and sign in to any provider, or set a provider's API key in the environment, then run this again.";
    case "login-too-short": {
      const now = (facts.now ?? Date.now)();
      const each = refusal.logins.map(
        (l) =>
          `your ${l.name} login ${l.expiresAt <= now ? "expired" : "expires"} at ${expiryClock(l.expiresAt)}`,
      );
      const ahead = refusal.logins.some((l) => l.expiresAt > now);
      const budget =
        facts.needMs !== undefined
          ? `this review's ${Math.round(facts.needMs / 60_000)}-minute budget`
          : "this review's budget";
      const fact = `${listed(each)}${ahead ? `, inside ${budget},` : ""} and `;
      if (surface === "plugin")
        return (
          `${fact}pi did not renew it. ` +
          "Sign in again with /login, or use another credential: a provider key in the environment."
        );
      // pi renews a login inside its last minutes or past its expiry, and
      // only when it is opened.
      const renewable = refusal.logins.some((l) => l.expiresAt - now < PI_RENEWS_INSIDE_MS);
      return (
        `${fact}nothing here renews it. ` +
        "Run the review inside pi (/qcr-review), where pi renews it, or use another credential: `qcr login`, or a provider key in the environment." +
        (renewable ? " Open pi once and it renews the login." : "")
      );
    }
    case "no-model": {
      const names = refusal.providers.map(nameOf);
      return (
        `pi has a credential for ${listed(names)}, but none of ${names.length === 1 ? "its" : "their"} models ` +
        `passes the review's filter (a model that reasons, ${Math.round(CONTEXT_FLOOR / 1000)}k context). Name one: ` +
        (surface === "plugin"
          ? "--model <provider>/<id>, or [models] model"
          : "qcr model use <provider>/<id>")
      );
    }
    case "pin-no-credential": {
      const by =
        refusal.from === "flag"
          ? "--model"
          : refusal.from === "config"
            ? `[models] model${facts.configPath ? ` in ${facts.configPath}` : ""}`
            : surface === "plugin"
              ? "/qcr-setup model"
              : "qcr model use";
      const drop =
        refusal.from === "flag"
          ? "omit --model"
          : refusal.from === "config"
            ? "remove model from [models]"
            : surface === "plugin"
              ? "/qcr-setup model"
              : "qcr model reset";
      const signIn = surface === "plugin" ? "/login in pi" : `\`qcr login ${refusal.provider}\``;
      const id = refusal.pin.startsWith(`${refusal.provider}/`)
        ? refusal.pin.slice(refusal.provider.length + 1)
        : refusal.pin;
      return (
        `this review is pinned to ${refusal.pin} (${by}), and pi has no credential for ${refusal.provider}. ` +
        `Sign in with ${signIn}, or drop the pin (${drop}).` +
        (refusal.candidates.length > 0
          ? ` ${id} is also served by ${refusal.candidates.join(", ")}: name one.`
          : "")
      );
    }
    case "pin-unknown":
      return (
        `pi knows no model ${JSON.stringify(refusal.pin)} (${refusal.detail.replace(/[.!?]+$/, "")}). ` +
        `${LIST_IT[surface]} lists what is usable.`
      );
  }
}

// ---- the specs a config pins ---------------------------------------------------

/** The providers the review's sessions run on: every model spec's
 * `provider/` prefix, in first-seen order. */
export function reviewProviders(cfg: Pick<CoreConfig, "models">): string[] {
  const m = cfg.models;
  const specs = [m.model, ...Object.values(m.tiers), ...Object.values(m.pass_models)];
  const out: string[] = [];
  for (const spec of specs) {
    const slash = spec.indexOf("/");
    if (slash <= 0) continue;
    const p = spec.slice(0, slash);
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** A spec taken apart at its first `/`: `provider/rest`, where `rest` is the
 * model id with any `:thinking` suffix left on. Null for a bare id. */
export function splitProvider(spec: string): { provider: string; rest: string } | null {
  const at = spec.indexOf("/");
  if (at <= 0 || at === spec.length - 1) return null;
  return { provider: spec.slice(0, at), rest: spec.slice(at + 1) };
}
