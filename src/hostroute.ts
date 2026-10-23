// The host route's isolation for `qcr review`: the core isolation of a run
// (src/reviewhost.ts prepareReviewHost: a private agent dir with a
// refresh-blanked copy of the login, a cwd outside every checkout holding the
// reviewer stub), with the CLI's own words for a refused login and the
// install's profile homes when the caller names no lookup.
import type { CoreConfig } from "./reviewconfig.js";
import { homeProfileLookup } from "./homes.js";
import type { ProfileLookup } from "./profiles.js";
import { HOST_CONTEXT_STUB, REVIEWER_STUB } from "./reviewerstub.js";
import { prepareReviewHost, type HostRun } from "./reviewhost.js";

// The two names live in a neutral module (the bot worker imports them without this file's closure).
export { HOST_CONTEXT_STUB, REVIEWER_STUB };
export {
  HOST_HTTP_IDLE_TIMEOUT_MS,
  ancestorContextFiles,
  hostSettings,
  type HostRun,
} from "./reviewhost.js";

/**
 * Prepare one run's private agent dir and cwd (src/reviewhost.ts). Throws
 * `AuthExpiring` (src/engine/auth.ts) when the operator's login would expire
 * inside `needMs`, and a plain Error when the cwd would sit inside a checkout.
 * `srcAgentDir` is only read.
 */
export function prepareHostRun(o: {
  root: string;
  /** The operator's pi agent dir (its login). Read, never written. */
  srcAgentDir: string;
  /** Where the private agent dir goes: `<runDir>/agent`. */
  agentDir: string;
  /** The run's out dir: pi's cwd. */
  cwd: string;
  cfg: CoreConfig;
  needMs: number;
  /** Checkouts the cwd must stay out of: the qcr tree, the reviewed repo. */
  checkouts: readonly string[];
  /** A profile's replacements for the lens agents (src/profileoverrides.ts). */
  profile?: { readFile?: (path: string) => string; lookup?: ProfileLookup };
  now?: () => number;
}): HostRun {
  return prepareReviewHost({
    ...o,
    profile: { ...o.profile, lookup: o.profile?.lookup ?? homeProfileLookup() },
    authWords: {
      missing: (src) => `no pi login at ${src} — run \`qcr scan login\` first`,
      expiring: ({ expiresAt, needMs }) =>
        `your pi login expires at ${new Date(expiresAt).toISOString()}, inside this review's ${Math.round(needMs / 60_000)}-minute budget. ` +
        "A review never refreshes it (that would rotate the login pi itself holds). Use pi once (`qcr scan login`) so it refreshes its own login, then run again.",
    },
  });
}
