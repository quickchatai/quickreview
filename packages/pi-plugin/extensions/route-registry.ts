// route-registry — the model route's reads of pi's model registry.
//
// Which providers have a credential and which models each can use (the
// inventory), pi's own default model per provider, and pi's own reading of a
// model text. Every one is a read of the registry facade pi hands out, so one
// function serves both places a route is resolved:
//
//   - an SDK host wraps its own runtime in a facade
//     (packages/pi-plugin/src/engine/pisdk.ts `PiHost.route`);
//   - an extension inside a running pi is handed one (`ctx.modelRegistry`):
//     the plugin's commands, and the login route of a CLI pi
//     (extensions/login-route.ts).
//
// It is not an extension and hosts nothing: it sits beside the factories
// because it calls pi at runtime (`resolveCliModel`), which only they and the
// SDK host may, and because a pi process that loads an extension must never
// load the SDK host with it (tests/fences-engine.test.ts holds both). The
// rule these reads feed is pure and lives in ../src/modelroute.ts.
import type { Api, Model } from "@earendil-works/pi-ai";
import { resolveCliModel, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { CredentialOrigin, ProviderInventory, RouteInput } from "../src/modelroute.js";

/** The part of pi's ModelRegistry the inventory reads: its public methods
 * only. An SDK host wraps its own runtime in one; an extension inside a
 * running pi is handed one (`ctx.modelRegistry`). */
export interface RouteRegistry {
  getAll(): Model<Api>[];
  getAvailable(): Model<Api>[];
  getProviderAuthStatus(provider: string): {
    configured: boolean;
    source?: string;
    label?: string;
  };
  getProvider(provider: string): { auth: { oauth?: { isSubscription?: boolean } } } | undefined;
  getProviderDisplayName(provider: string): string;
  isUsingOAuth(model: Model<Api>): boolean;
}

/** An environment variable's name that says it carries a key or a token. */
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const KEY_WORD = /(^|_)(KEY|TOKEN)(_|$)/;

/**
 * Where pi found a provider's credential, from its auth status.
 *
 * VERIFY-ON-PIN (pi 1.4.0, canary 13): the status sources are `stored`,
 * `runtime`, `models_json_key`, `models_json_command`, `environment` and
 * `fallback`, and an `environment` status carries as its label what the
 * provider's own check named: the variable's name for a key or a token, a
 * phrase or a non-key variable for an ambient cloud identity (a profile, a
 * role, default credentials). The status of a key that `models.json` spells
 * as a variable is read from the process's environment, not from the auth
 * context the availability check and the request use, so it can say
 * "not configured" of a provider whose models are available: availability is
 * the credential test, and the status only sorts (`registryInventory`).
 */
export function credentialOrigin(status: { source?: string; label?: string }): CredentialOrigin {
  switch (status.source) {
    case "stored":
      return "stored";
    case "runtime":
      return "runtime";
    case "models_json_key":
    case "models_json_command":
      return "models-json";
    case "environment": {
      const label = status.label ?? "";
      return ENV_NAME.test(label) && KEY_WORD.test(label) ? "env-key" : "ambient";
    }
    default:
      return "ambient";
  }
}

/** Models by provider, in the order given. */
function byProvider(models: readonly Model<Api>[]): Map<string, Model<Api>[]> {
  const out = new Map<string, Model<Api>[]>();
  for (const m of models) {
    const list = out.get(m.provider);
    if (list) list.push(m);
    else out.set(m.provider, [m]);
  }
  return out;
}

/**
 * The inventory over pi's registry facade: every provider pi has a credential
 * for and at least one available model, in pi's own provider order. One
 * function for an SDK host and for a running pi, so the two cannot drift.
 * `exclude` names providers this surface cannot use.
 *
 * A provider has a credential when pi lists a model of it as available: pi
 * lists one only after the provider's own check found a credential where the
 * request will look for it. The auth status sorts that credential into its
 * class and is not a second test. The one status that says "not configured"
 * of an available provider is a `models.json` key spelled as a variable that
 * the host's environment holds and the process's does not (`credentialOrigin`),
 * which is a key in the environment.
 *
 * The facade reads pi's availability snapshot: the caller sees that it is
 * filled (a host refreshes offline; a running pi keeps it).
 */
export function registryInventory(
  registry: RouteRegistry,
  o: { exclude?: ReadonlySet<string> } = {},
): ProviderInventory[] {
  const all = byProvider(registry.getAll());
  const available = byProvider(registry.getAvailable());
  const out: ProviderInventory[] = [];
  for (const [provider, known] of all) {
    const models = available.get(provider);
    if (models === undefined || models.length === 0 || o.exclude?.has(provider)) continue;
    const status = registry.getProviderAuthStatus(provider);
    const oauth = registry.isUsingOAuth(models[0]!);
    const piDefault = piDefaultModelId(provider, known);
    out.push({
      provider,
      name: registry.getProviderDisplayName(provider),
      credential: {
        kind: oauth ? "oauth" : "api_key",
        origin: status.configured ? credentialOrigin(status) : "env-key",
        ...(status.label !== undefined ? { label: status.label } : {}),
        subscription: oauth && registry.getProvider(provider)?.auth.oauth?.isSubscription === true,
      },
      models,
      ...(piDefault.id !== undefined ? { piDefaultId: piDefault.id } : {}),
      ...(piDefault.unread ? { piDefaultUnread: true } : {}),
    });
  }
  return out;
}

/** Rides the clone pi makes of a provider's default model. */
const PROBE_ORIGIN = Symbol.for("qcr.route.origin");
/** An id no provider has, so pi falls back to its "custom model" path. */
const PROBE_ID = "qcr-default-probe-0000";
/** The first model of the list the probe hands pi: what pi falls back to when
 * it names no default for the provider. */
const PROBE_DECOY = "qcr-default-probe-decoy";

/**
 * pi's default model id for `provider`, given the provider's models.
 *
 * pi does not export its per-provider default table, and a file-path import
 * is refused inside a running pi. Its root export `resolveCliModel` reads the
 * table for us: asked for an id the provider does not have, it answers with a
 * "custom model" that is a shallow clone of the provider's default model, or
 * of the provider's first model when it names no default. So each model is
 * tagged with its own id under a symbol, a decoy goes first, and the tag on
 * the clone says which it was.
 *
 * `unread` when pi threw or the clone no longer carries the tag: the guard
 * then has no reference and the version pick stands. A provider with no
 * default (a custom `models.json` provider) is normal and is not `unread`.
 *
 * VERIFY-ON-PIN (pi 1.4.0, canary 12): `resolveCliModel` touches only
 * `getModels()` and `hasConfiguredAuth()` of the runtime it is given, and its
 * custom-id fallback spreads the default model (model-resolver.js
 * buildFallbackModel).
 */
export function piDefaultModelId(
  provider: string,
  models: readonly Model<Api>[],
): { id?: string; unread: boolean } {
  const first = models[0];
  if (first === undefined) return { unread: false };
  try {
    const list = [
      { ...first, id: PROBE_DECOY, name: PROBE_DECOY, [PROBE_ORIGIN]: PROBE_DECOY },
      ...models.map((m) => ({ ...m, [PROBE_ORIGIN]: m.id })),
    ];
    const r = resolveCliModel({
      cliProvider: provider,
      cliModel: PROBE_ID,
      modelRuntime: {
        getModels: () => list,
        hasConfiguredAuth: () => false,
      } as unknown as ModelRuntime,
    });
    const origin = (r.model as unknown as Record<symbol, unknown> | undefined)?.[PROBE_ORIGIN];
    if (typeof origin !== "string") return { unread: true };
    return origin === PROBE_DECOY ? { unread: false } : { id: origin, unread: false };
  } catch {
    return { unread: true };
  }
}

/** A text up to the end of its first sentence. A `.` inside a model id is
 * followed by more of the id, never by a space. */
function firstSentence(text: string): string {
  const m = /^[\s\S]*?[.!?](?=\s|$)/.exec(text.trim());
  return m ? m[0] : text.trim();
}

/**
 * pi's `--model` parser over a registry, shaped for `resolveRoute`: an exact
 * `provider/id`, a bare id one credentialed provider serves, a substring, a
 * `:level` suffix, and an id pi does not know on a provider it does (kept as
 * a custom id). A provider is usable to the parser when the inventory would
 * hold it: when pi lists a model of it as available.
 *
 * VERIFY-ON-PIN (pi 1.4.0, tests/engine-route.test.ts): `resolveCliModel`
 * answers with `model` and `thinkingLevel`, or with an `error` whose first
 * sentence states the fact and whose later ones name pi's own flags; a custom
 * id comes back as a model the catalog does not hold.
 */
export function textResolver(
  registry: Pick<RouteRegistry, "getAll" | "getAvailable">,
): RouteInput["resolveText"] {
  return (text) => {
    const unknown = `Model ${JSON.stringify(text)} not found.`;
    let r: ReturnType<typeof resolveCliModel>;
    try {
      const credentialed = new Set(registry.getAvailable().map((m) => m.provider));
      r = resolveCliModel({
        cliModel: text,
        modelRuntime: {
          getModels: () => registry.getAll(),
          hasConfiguredAuth: (provider: string) => credentialed.has(provider),
        } as unknown as ModelRuntime,
      });
    } catch (e) {
      return { error: firstSentence(e instanceof Error ? e.message : String(e)) };
    }
    const model = r.model;
    if (r.error !== undefined || model === undefined)
      return { error: firstSentence(r.error ?? unknown) };
    const known = registry.getAll().some((m) => m.provider === model.provider && m.id === model.id);
    return {
      model,
      ...(r.thinkingLevel !== undefined ? { thinking: r.thinkingLevel } : {}),
      ...(known ? {} : { custom: true }),
    };
  };
}
