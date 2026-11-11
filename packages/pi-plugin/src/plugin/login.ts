// The model a run inside a user's pi is on, and the login it borrows for it.
//
// A review or a scan inside pi runs on what that pi has a credential for.
// The running pi resolves the route over its own model registry (the host's
// `route`, which the extension builds: extensions/quickreview.ts), with the
// pin the run names (`--model`, else the config's `[models] model`) and the
// choice remembered beside pi's logins (../modelchoice.ts). When two
// providers tie and a person is there, they are asked once, through pi's own
// select, and the answer is remembered. An answer the agent dir will not
// keep holds for the run it was given in: the caller is handed it back
// (`unkept`) and gives it to every later resolve of that run (`held`).
//
// Once the route is known the login is borrowed for it, and only for it:
//   - the host pi is asked to renew each stored login the run is on that
//     would not last the run's window (its own model runtime, under its own
//     lock, written to its own storage);
//   - the run then holds a refresh-disabled copy of exactly those providers'
//     logins, in memory (../engine/auth.ts `borrowedCredentials`, as an owner
//     route: the host pi renews while the run goes, so a login shorter than
//     the run is kept, and the copy takes the newer token from the host's
//     file when pi asks for a refresh);
//   - a login of the route that is still too short after the host was asked
//     is a refusal before anything runs, in the route's own words.
// Nothing here refreshes a login: a rotated token never leaves the host. A
// person's pi holds other logins too, which neither ride along nor refuse
// the run.
//
// The run's own host is then handed the route as fixed, with the model
// object the running pi resolved, so the two never name different models.
//
// A host that hands no registry (`route` absent) names no model: the run's
// own host resolves one from the whole borrowed login.
import type { Api, CredentialStore, Model } from "@earendil-works/pi-ai";
import { borrowedCredentials, PI_REFRESH_MARGIN_MS, type LoginSummary } from "../engine/auth.js";
import { readModelChoice, writeModelChoice } from "../modelchoice.js";
import {
  credentialWords,
  moveToCredentialed,
  splitProvider,
  type ModelChoice,
  type ModelRoute,
  type ProviderInventory,
  type RouteInput,
  type RouteRefusal,
  type RouteResult,
  type SkippedLogin,
} from "../modelroute.js";
import { splitModelSpec, type CoreConfig } from "../reviewconfig.js";

/** What a run asks the running pi's route for. */
export interface HostRouteAsk {
  /** `--model`, else the config's `[models] model` when it names a model. */
  pin?: RouteInput["pin"];
  /** The remembered choice. */
  choice?: ModelChoice;
}

/** The route as the running pi resolved it over its own registry. */
export interface HostRouted {
  /** The route, or why there is none. */
  result: RouteResult;
  /** The providers the running pi has a credential for that a run can borrow. */
  inventory: readonly ProviderInventory[];
  /** pi's own model object for the route: the run's host is handed it, so an
   * id its own catalog lacks still runs. */
  model?: Model<Api>;
  /** pi's display name for a provider id. */
  nameOf: (provider: string) => string;
  /** What the person should hear beside a refusal (the provider this pi
   * session is on cannot be borrowed). A route carries the same lines in its
   * own notices. */
  notes: readonly string[];
}

/** What the plugin asks of the host pi's auth, by shape (the extension wires
 * it to `ctx.modelRegistry` and the host's auth file). */
export interface HostAuth {
  /** The host's stored logins, each with its type and expiry; never a token. */
  logins(): LoginSummary;
  /** Does pi have any credential for `provider` (a login, a stored key, an
   * environment key)? */
  configured(provider: string): boolean;
  /** Ask the host pi to make `provider`'s OAuth token valid for at least
   * `minValidityMs` more: it refreshes it if not. Rejects when it cannot. */
  refresh(provider: string, minValidityMs: number): Promise<void>;
  /** The run's route over the running pi's own model registry. Absent: the
   * host hands no registry, so no model is named before the run and the
   * run's own host resolves one. */
  route?(ask: HostRouteAsk): HostRouted;
}

// ---- the borrow ----------------------------------------------------------------

export type BorrowResult =
  | {
      ok: true;
      /** The run's login: a refresh-disabled copy, in memory. */
      credentials: CredentialStore;
      /** Stored logins left out as too short, for a run that named no
       * providers: its own host leaves them out of its route. */
      skipped: SkippedLogin[];
    }
  | { ok: false; refusal: Extract<RouteRefusal, { code: "login-too-short" }> };

/** `store`, answering for `providers` alone. */
function only(store: CredentialStore, providers: readonly string[]): CredentialStore {
  const used = new Set(providers);
  return {
    read: async (id, options) => (used.has(id) ? store.read(id, options) : undefined),
    list: async (options) => (await store.list(options)).filter((c) => used.has(c.providerId)),
    modify: (id, fn, options) => store.modify(id, fn, options),
    delete: (id, options) => store.delete(id, options),
  };
}

/**
 * Borrow the host pi's login for one run of `needMs`. The host is first asked
 * to renew each stored login the run is on that would not last it. A failed
 * renewal is not the answer: the borrow that follows is. It keeps a login the
 * host renews while the run goes, and leaves out one that has run out; a
 * provider the run is on whose login was left out refuses the run.
 *
 * With `providers`, the run holds exactly their logins. Without (a host that
 * resolved no route), it holds the whole login, less what cannot last.
 *
 * Throws `AuthUnreadable` when the login file is there and cannot be read: an
 * unknown store is never taken for an empty one.
 */
export async function borrowLogin(o: {
  /** The host pi's agent dir: its login is read there, never written. */
  agentDir: string;
  host: Pick<HostAuth, "logins" | "refresh">;
  /** The providers the run's sessions are on (`routeProviders`). */
  providers?: readonly string[];
  needMs: number;
  /** The stretch at the end of a login's life in which pi itself would
   * refresh it; default pi's own. */
  marginMs?: number;
  /** pi's display name for a provider id; omitted, the id is the name. */
  nameOf?: (provider: string) => string;
  now?: () => number;
}): Promise<BorrowResult> {
  const now = o.now ?? Date.now;
  const margin = o.marginMs ?? PI_REFRESH_MARGIN_MS;
  const want = o.needMs + margin;
  const used = (provider: string): boolean =>
    o.providers === undefined || o.providers.includes(provider);
  for (const [provider, login] of Object.entries(o.host.logins())) {
    if (!used(provider) || login.type !== "oauth" || login.expires === null) continue;
    if (login.expires >= now() + want) continue;
    try {
      await o.host.refresh(provider, want);
    } catch {
      // The borrow below reads what the host's file holds now.
    }
  }
  const borrowed = borrowedCredentials({
    srcDir: o.agentDir,
    needMs: o.needMs,
    marginMs: margin,
    ...(o.now ? { now: o.now } : {}),
    // The host pi renews its login while the run goes.
    owner: true,
    renew: (provider) => o.host.refresh(provider, want),
  });
  if (o.providers === undefined)
    return { ok: true, credentials: borrowed.credentials, skipped: borrowed.skipped };
  const short = borrowed.skipped
    .filter((l) => used(l.provider))
    .map((l) => ({ ...l, name: o.nameOf?.(l.provider) ?? l.name }));
  if (short.length > 0) return { ok: false, refusal: { code: "login-too-short", logins: short } };
  return { ok: true, credentials: only(borrowed.credentials, o.providers), skipped: [] };
}

/**
 * The providers one run's sessions are on: the route's own, then the
 * provider of every spec the config pins to a model of its own (a tier, a
 * lens), where that spec will run: on the provider it names when pi has a
 * credential for it, else on the one the route's move rule sends it to
 * (../modelroute.ts `moveToCredentialed`). A spec the rule cannot place keeps
 * the provider it names: there is no login to borrow for it, and the run
 * refuses that session when it opens.
 */
export function routeProviders(
  route: Pick<ModelRoute, "provider">,
  cfg: Pick<CoreConfig, "models">,
  on: { inventory: readonly ProviderInventory[]; prefer?: string },
): string[] {
  const out = [route.provider];
  const m = cfg.models;
  for (const spec of [m.model, ...Object.values(m.tiers), ...Object.values(m.pass_models)]) {
    const named = splitProvider(splitModelSpec(spec).model);
    if (named === null) continue;
    let provider = named.provider;
    if (!on.inventory.some((e) => e.provider === provider)) {
      const move = moveToCredentialed({ provider, id: named.rest }, on.inventory, on.prefer);
      if (move !== null && "provider" in move) provider = move.provider;
    }
    if (!out.includes(provider)) out.push(provider);
  }
  return out;
}

// ---- the route of one run --------------------------------------------------------

/** The rows of the provider question, and of /qcr-setup model: the model each
 * provider would run, whose credential it is, and what is not known about its
 * price. The first is the one the order takes. */
export function providerRows(route: ModelRoute): string[] {
  const options = [route, ...route.alternatives];
  const width = Math.max(...options.map((x) => x.spec.length));
  return options.map((x) =>
    [
      x.spec.padEnd(width),
      `${x.providerName}, ${credentialWords(x.credential)}`,
      ...(x.priced ? [] : ["no list price"]),
    ].join("    "),
  );
}

/** What the run's own host is handed: the borrowed login and the route, with
 * the model object the running pi resolved it to. */
export interface RunLogin {
  credentials: CredentialStore;
  route: { fixed: ModelRoute; model?: Model<Api> };
  /** The providers whose logins the run holds. */
  providers: readonly string[];
}

/** One run's model side, as resolved inside pi. */
export interface RunRouted {
  /** The route, or why there is none (a login the host could not renew
   * included). */
  result: RouteResult;
  inventory: readonly ProviderInventory[];
  /** The remembered provider. */
  prefer?: string;
  nameOf: (provider: string) => string;
  /** What the person should hear beside a refusal. */
  notes: readonly string[];
  /** What the run's host is handed. Absent for a plan, and with no route. */
  login?: RunLogin;
  /** The answer the person gave here that the agent dir would not keep: the
   * caller holds it for what follows the question in the same run (a scan's
   * start after its plan), as `held`. */
  unkept?: ModelChoice;
}

/** The part of the session's UI the provider question needs (session.ts
 * `SessionUi`). */
interface AskUi {
  interactive: boolean;
  select(title: string, options: string[], signal?: AbortSignal): Promise<string | undefined>;
  notify(message: string, level: "info" | "warning" | "error"): void;
}

/**
 * Resolve one run's route inside pi, asking once when two providers tie and
 * a person may be asked, and borrow the login for it when the run starts.
 */
export async function routeInPi(o: {
  /** The host pi: its agent dir (the login, the remembered choice) and auth. */
  host: { agentDir: string; auth: Pick<HostAuth, "logins" | "refresh"> };
  /** The host's route (`host.auth.route`), which the caller found present. */
  resolve: NonNullable<HostAuth["route"]>;
  ui: AskUi;
  pin?: RouteInput["pin"];
  /** A person may be asked which provider: never for a plan or JSON. */
  ask: boolean;
  /** The answer an earlier question of this run got that could not be
   * written (`unkept`): it stands in while the agent dir remembers none. */
  held?: ModelChoice;
  /** What runs, in the question: "review" or "scan". */
  what: string;
  /** The run the login is borrowed for. Omitted: a plan, which borrows nothing. */
  run?: { needMs: number; cfg: Pick<CoreConfig, "models"> };
  signal?: AbortSignal;
  warn: (line: string) => void;
}): Promise<RunRouted> {
  const { agentDir } = o.host;
  const remembered = readModelChoice(agentDir);
  if (remembered.notice !== undefined) o.warn(remembered.notice);
  let choice = remembered.choice ?? o.held;
  let unkept: ModelChoice | undefined;
  const resolve = (): HostRouted =>
    o.resolve({ ...(o.pin ? { pin: o.pin } : {}), ...(choice ? { choice } : {}) });
  let got = resolve();
  if (got.result.ok && got.result.route.ask && o.ask && o.ui.interactive) {
    const options = [got.result.route, ...got.result.route.alternatives];
    const rows = providerRows(got.result.route);
    const picked = await o.ui.select(
      `QuickReview: which provider runs the ${o.what}?`,
      rows,
      o.signal,
    );
    const answer = picked === undefined ? undefined : options[rows.indexOf(picked)];
    if (answer !== undefined) {
      const written = writeModelChoice(agentDir, {
        provider: answer.provider,
        model: null,
        via: "ask",
      });
      // A choice that cannot be kept still holds for this run.
      if (written.ok)
        o.ui.notify(
          `QuickReview will use ${answer.providerName} from now on. /qcr-setup model changes it.`,
          "info",
        );
      else o.ui.notify(written.error, "warning");
      choice = {
        provider: answer.provider,
        model: null,
        via: "ask",
        no_estimate_ok: remembered.noEstimateOk,
      };
      if (!written.ok) unkept = choice;
      got = resolve();
    }
  }
  const base = {
    inventory: got.inventory,
    ...(choice !== undefined ? { prefer: choice.provider } : {}),
    nameOf: got.nameOf,
    notes: got.notes,
    ...(unkept !== undefined ? { unkept } : {}),
  };
  if (!got.result.ok || o.run === undefined) return { result: got.result, ...base };
  const route = got.result.route;
  const providers = routeProviders(route, o.run.cfg, base);
  const borrowed = await borrowLogin({
    agentDir,
    host: o.host.auth,
    providers,
    needMs: o.run.needMs,
    nameOf: got.nameOf,
  });
  if (!borrowed.ok) return { result: { ok: false, refusal: borrowed.refusal }, ...base };
  return {
    result: got.result,
    ...base,
    login: {
      credentials: borrowed.credentials,
      route: { fixed: route, ...(got.model !== undefined ? { model: got.model } : {}) },
      providers,
    },
  };
}
