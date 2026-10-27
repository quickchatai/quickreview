// The borrowed login: a review inside a user's pi runs on that pi's own
// login, and only that pi ever refreshes it.
//
// Before a run, each provider the review's models name is checked against the
// host pi:
//   - an OAuth login that would not last the run's window is refreshed by the
//     host pi itself (its model registry, under its own lock, written to its
//     own storage), so a token near the end of its life is renewed rather
//     than the run refused;
//   - a provider pi has no credential for at all fails the run with a hint
//     that names pi's /login. A key for some other provider is never a reason
//     to run on another model: the review runs on the models its config
//     names, or not at all. The one exception is the OpenAI family: an
//     `openai-codex/` model runs on an `openai` login (and back) when only
//     that one exists (modelroute.ts), the same model id on either.
// The run then reads a refresh-disabled copy of the login (engine/auth.ts):
// nothing in it can refresh, so a rotated token never leaves the host.
import type { LoginSummary } from "../engine/auth.js";
import { routeProvider } from "../modelroute.js";

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
}

export type BorrowResult =
  | {
      ok: true;
      refreshed: string[];
      /** The providers the run uses, each OpenAI one on the login that exists:
       * the run's login copy carries exactly these. */
      providers: string[];
    }
  | { ok: false; error: string };

/** The hint for a provider pi has no credential for. */
export function noLoginHint(provider: string, keyed: readonly string[]): string {
  const keys =
    keyed.length > 0
      ? ` pi has a key for ${keyed.join(", ")}, and the review does not switch models to use it: to review on that provider, set the review's models to it in your qcr config.`
      : "";
  return (
    `the review runs on ${provider}, and this pi has no login for it. ` +
    `Run /login ${provider} in pi, then /qcr-review again.${keys}`
  );
}

/** The providers a run actually uses for the review's `providers`: each one
 * itself, or its OpenAI twin when only the twin has a credential
 * (modelroute.ts). One reading for the setup checklist and `borrowLogin`, so
 * setup never calls a login missing that a review can run on. */
export function routedProviders(
  providers: readonly string[],
  host: Pick<HostAuth, "logins" | "configured">,
): string[] {
  const logins = host.logins();
  const out: string[] = [];
  for (const named of providers) {
    const p = routeProvider(named, "", {
      hasCredential: (q) => logins[q] !== undefined || host.configured(q),
    });
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** Can a run use `provider` at all: an OAuth login (pi refreshes a short one
 * before the run), or any other credential pi has. */
export function canUseProvider(
  provider: string,
  host: Pick<HostAuth, "logins" | "configured">,
): boolean {
  return host.logins()[provider]?.type === "oauth" || host.configured(provider);
}

/**
 * Make sure every provider the review needs is usable for `needMs` from now,
 * refreshing a short OAuth login through the host. `marginMs` is added to the
 * window the host must cover.
 */
export async function borrowLogin(o: {
  providers: readonly string[];
  host: HostAuth;
  needMs: number;
  marginMs: number;
  now?: () => number;
}): Promise<BorrowResult> {
  const now = o.now ?? Date.now;
  const want = o.needMs + o.marginMs;
  const refreshed: string[] = [];
  let logins = o.host.logins();
  const providers = routedProviders(o.providers, o.host);
  for (const p of providers) {
    const login = logins[p];
    if (login?.type === "oauth") {
      if (login.expires !== null && login.expires >= now() + want) continue;
      try {
        await o.host.refresh(p, want);
      } catch (err) {
        return {
          ok: false,
          error: `pi could not refresh your ${p} login (${err instanceof Error ? err.message : String(err)}). Run /login ${p} in pi, then /qcr-review again.`,
        };
      }
      logins = o.host.logins();
      const after = logins[p];
      if (after?.type !== "oauth" || after.expires === null || after.expires < now() + want)
        return {
          ok: false,
          error: `your ${p} login does not last this review's ${Math.round(o.needMs / 60_000)} minutes even after pi refreshed it. Run /login ${p} in pi, then /qcr-review again.`,
        };
      refreshed.push(p);
      continue;
    }
    if (o.host.configured(p)) continue;
    const keyed = Object.entries(logins)
      .filter(([name, l]) => name !== p && l.type === "api_key")
      .map(([name]) => name);
    return { ok: false, error: noLoginHint(p, keyed) };
  }
  return { ok: true, refreshed, providers };
}
