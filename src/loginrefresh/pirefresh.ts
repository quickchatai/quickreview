// pi-ai's own OAuth refresh for a provider: the one file in the refresher that
// touches pi. The flows come from pi-ai's public provider registry (its
// `providers/all` subpath), so there is no table of names here: a provider pi
// has an OAuth login for is refreshed by pi's own flow, exactly as pi itself
// would, and one pi has no flow for is said to have none (`NoOAuthFlow`, which
// the refresher notes and skips). The daemon never imports this module: it
// spawns main.js, which does.
//
// VERIFY-ON-PIN (pi-ai 1.4.0): `builtinProviders()` returns every built-in
// provider, and one with an OAuth login carries `auth.oauth`, whose
// `refresh(credential, signal)` returns the new credential. A bump that moves
// or renames them makes the refresh fail loudly (a `login_refresh_failed`
// anomaly, or a build that does not compile), never silently.
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { NoOAuthFlow, type RefreshFn } from "./refresher.js";

export const piOAuthRefresh: RefreshFn = async (provider, credential, signal) => {
  const flow = builtinProviders().find((p) => p.id === provider)?.auth.oauth;
  if (flow === undefined) throw new NoOAuthFlow(provider);
  return await flow.refresh(credential, signal);
};
