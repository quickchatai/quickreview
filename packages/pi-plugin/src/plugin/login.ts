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
// A config that pins no model names no provider. The run is then on
// whichever provider the login holds, so the whole login is borrowed: every
// stored login is made to last the same way, and one the host cannot renew is
// left out, since nothing says the review needs it.
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
       * the run's login copy carries exactly these. For a review that names
       * no provider: the stored logins that last the run, and empty when pi
       * stores none (the copy is then the whole login, which is nothing). */
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

/** What `borrowLogin` is asked. */
interface BorrowRequest {
  /** The providers the review's pinned models name. Empty: the review names
   * none, and the whole login is borrowed. */
  providers: readonly string[];
  host: HostAuth;
  needMs: number;
  marginMs: number;
  now?: () => number;
}

/**
 * Make one stored OAuth login last `want` more milliseconds, asking the host
 * pi to refresh it when it would not. Resolves to whether pi refreshed it,
 * or to the reason it cannot last.
 */
async function lastOrRefresh(
  o: BorrowRequest,
  provider: string,
  want: number,
): Promise<{ refreshed: boolean } | { error: string }> {
  const now = o.now ?? Date.now;
  const held = o.host.logins()[provider];
  if (held?.type === "oauth" && held.expires !== null && held.expires >= now() + want)
    return { refreshed: false };
  try {
    await o.host.refresh(provider, want);
  } catch (err) {
    return {
      error: `pi could not refresh your ${provider} login (${err instanceof Error ? err.message : String(err)}). Run /login ${provider} in pi, then /qcr-review again.`,
    };
  }
  const after = o.host.logins()[provider];
  if (after?.type !== "oauth" || after.expires === null || after.expires < now() + want)
    return {
      error: `your ${provider} login does not last this review's ${Math.round(o.needMs / 60_000)} minutes even after pi refreshed it. Run /login ${provider} in pi, then /qcr-review again.`,
    };
  return { refreshed: true };
}

/**
 * The whole login, for a review that names no provider: every stored key,
 * and every stored OAuth login that lasts the run or that pi refreshed to
 * last it. A login pi cannot renew is left out, not a refusal: the review
 * runs on another one. Only when pi stores logins and none of them can last
 * is the run refused, with the first one's reason. A pi that stores no login
 * borrows nothing, and a key in the environment is then the route.
 */
async function borrowWholeLogin(o: BorrowRequest, want: number): Promise<BorrowResult> {
  const refreshed: string[] = [];
  const kept: string[] = [];
  let firstError: string | undefined;
  for (const [provider, login] of Object.entries(o.host.logins())) {
    if (login.type !== "oauth") {
      kept.push(provider);
      continue;
    }
    const lasting = await lastOrRefresh(o, provider, want);
    if ("error" in lasting) {
      firstError ??= lasting.error;
      continue;
    }
    if (lasting.refreshed) refreshed.push(provider);
    kept.push(provider);
  }
  if (kept.length === 0 && firstError !== undefined) return { ok: false, error: firstError };
  return { ok: true, refreshed, providers: kept };
}

/**
 * Make sure every provider the review needs is usable for `needMs` from now,
 * refreshing a short OAuth login through the host. `marginMs` is added to the
 * window the host must cover. An empty `providers` is the whole login
 * (`borrowWholeLogin`), never no login at all.
 */
export async function borrowLogin(o: BorrowRequest): Promise<BorrowResult> {
  const want = o.needMs + o.marginMs;
  if (o.providers.length === 0) return borrowWholeLogin(o, want);
  const refreshed: string[] = [];
  const providers = routedProviders(o.providers, o.host);
  for (const p of providers) {
    if (o.host.logins()[p]?.type === "oauth") {
      const lasting = await lastOrRefresh(o, p, want);
      if ("error" in lasting) return { ok: false, error: lasting.error };
      if (lasting.refreshed) refreshed.push(p);
      continue;
    }
    if (o.host.configured(p)) continue;
    const keyed = Object.entries(o.host.logins())
      .filter(([name, l]) => name !== p && l.type === "api_key")
      .map(([name]) => name);
    return { ok: false, error: noLoginHint(p, keyed) };
  }
  return { ok: true, refreshed, providers };
}
