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
// The last part of the file (the two-provider twin and the login-file
// reader) is what the routes that have not moved to `resolveRoute` still
// call. It goes when its last caller does.

import { compareModels, listPrice, pickModel, type ModelPick } from "./modelpick.js";
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

function skippedNotices(skipped: readonly SkippedLogin[]): string[] {
  return skipped.map(
    (l) =>
      `skipped ${l.name}: its login expires at ${expiryClock(l.expiresAt)} and nothing here renews it`,
  );
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

// ---- the twin: for the routes that have not moved to resolveRoute ---------------
//
// pi offers three OpenAI logins on two providers, `openai-codex` (the legacy
// OAuth login) and `openai` (the newer OAuth login, or an API key), and both
// serve the same model ids. A spec whose named provider has no usable
// credential while its twin has one runs on the twin. `moveToCredentialed`
// above gives the same answer for the pair with no name in it.

/** The OpenAI providers, each the other's twin. */
export const OPENAI_PROVIDERS: readonly string[] = ["openai-codex", "openai"];

/** The provider that serves the same models on another OpenAI login, or
 * undefined for a provider outside the family. */
export function twinProvider(provider: string): string | undefined {
  if (provider === "openai-codex") return "openai";
  if (provider === "openai") return "openai-codex";
  return undefined;
}

/** A spec taken apart at its first `/`: `provider/rest`, where `rest` is the
 * model id with any `:thinking` suffix left on. Null for a bare id. */
export function splitProvider(spec: string): { provider: string; rest: string } | null {
  const at = spec.indexOf("/");
  if (at <= 0 || at === spec.length - 1) return null;
  return { provider: spec.slice(0, at), rest: spec.slice(at + 1) };
}

/** The model id of a spec's `rest`: the `:thinking` suffix dropped. */
export function modelIdOf(rest: string): string {
  const colon = rest.lastIndexOf(":");
  return colon > 0 ? rest.slice(0, colon) : rest;
}

export interface ProviderProbe {
  /** Does this provider have a usable credential? */
  hasCredential(provider: string): boolean;
  /** Does this provider serve this model id? Omitted: assume it does (the
   * OpenAI twins carry the same catalog). */
  hasModel?(provider: string, modelId: string): boolean;
}

/** The provider to run `provider`'s model `modelId` on: `provider` itself when
 * it has a credential (or when nothing better exists), else its OpenAI twin
 * when the twin has one and serves the model. */
export function routeProvider(provider: string, modelId: string, probe: ProviderProbe): string {
  if (probe.hasCredential(provider)) return provider;
  const twin = twinProvider(provider);
  if (twin === undefined || !probe.hasCredential(twin)) return provider;
  if (probe.hasModel && !probe.hasModel(twin, modelId)) return provider;
  return twin;
}

/** A whole spec (`provider/id[:thinking]`) rerouted by `routeProvider`; a spec
 * with no provider prefix is returned as given. */
export function routeModelSpec(spec: string, probe: ProviderProbe): string {
  const parts = splitProvider(spec);
  if (parts === null) return spec;
  const provider = routeProvider(parts.provider, modelIdOf(parts.rest), probe);
  return provider === parts.provider ? spec : `${provider}/${parts.rest}`;
}

/** The providers a pi `auth.json` holds a credential for: every entry of type
 * "oauth" or "api_key" (pi's two stored credential shapes; an api_key's `key`
 * may be a literal, an env name or a `!command`, all of which count). An API key
 * in `OPENAI_API_KEY` counts for `openai`, as pi's own env lookup does. Text
 * that does not parse holds nothing. */
export function providersInAuthJson(
  raw: string | null,
  env: Readonly<Record<string, string | undefined>> = {},
): Set<string> {
  const out = new Set<string>();
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === "object" && parsed !== null)
        for (const [name, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v !== "object" || v === null) continue;
          const type = (v as Record<string, unknown>)["type"];
          if (type === "oauth") out.add(name);
          else if (type === "api_key") {
            const key = (v as Record<string, unknown>)["key"];
            if (typeof key === "string" && key.trim() !== "") out.add(name);
          }
        }
    } catch {
      // an unreadable login holds no credential
    }
  }
  if ((env["OPENAI_API_KEY"] ?? "").trim() !== "") out.add("openai");
  return out;
}

/** `routeModelSpec` over a login file's text (null: no file) and the env the
 * pi will run with: for a host that starts a CLI pi on a login it holds as a
 * file (a takeover's or a debug round's borrowed copy). */
export function routeModelSpecForLogin(
  spec: string,
  authJson: string | null,
  env: Readonly<Record<string, string | undefined>> = {},
): string {
  const have = providersInAuthJson(authJson, env);
  return routeModelSpec(spec, { hasCredential: (p) => have.has(p) });
}
