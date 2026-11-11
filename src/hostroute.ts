// The host route's isolation for `qcr review`: the core isolation of a run
// (packages/pi-plugin/src/reviewhost.ts prepareReviewHost: a private agent dir, a cwd outside
// every checkout holding the reviewer stub), with the CLI's own words for a
// refused login and the install's profile homes when the caller names no
// lookup.
//
// The login reaches the run in one of two ways. A review's sessions run in
// this process, on a host that borrowed the login in memory before the route
// was chosen (src/reviewcli.ts): the agent dir then holds no login file
// (`auth: "injected"`), and the dir the host was built over is the one filled
// (`keepAgentDir`). A pi started as a child (`qcr open`, a debug round) reads
// a file: it gets the refresh-blanked copy, checked against its window.
import type { CoreConfig } from "@quickchatai/pi-quickreview/src/reviewconfig.js";
import { homeProfileLookup } from "./homes.js";
import type { ProfileLookup } from "@quickchatai/pi-quickreview/src/profiles.js";
import { HOST_CONTEXT_STUB, REVIEWER_STUB } from "@quickchatai/pi-quickreview/src/reviewerstub.js";
import { prepareReviewHost, type HostRun } from "@quickchatai/pi-quickreview/src/reviewhost.js";

// The two names live in a neutral module (the bot worker imports them without this file's closure).
export { HOST_CONTEXT_STUB, REVIEWER_STUB };
export {
  HOST_HTTP_IDLE_TIMEOUT_MS,
  ancestorContextFiles,
  hostSettings,
  type HostRun,
} from "@quickchatai/pi-quickreview/src/reviewhost.js";

/**
 * Prepare one run's private agent dir and cwd (packages/pi-plugin/src/reviewhost.ts). Throws
 * `AuthExpiring` (packages/pi-plugin/src/engine/auth.ts) when the operator's login would expire
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
  /** A profile's replacements for the lens agents (packages/pi-plugin/src/profileoverrides.ts). */
  profile?: { readFile?: (path: string) => string; lookup?: ProfileLookup };
  /** How the run's sessions get the login: the copy in the agent dir (the
   * default), or the host's own memory (`injected`: no login file is written). */
  auth?: "copy" | "injected";
  /** The agent dir exists and a host is built over it: it is filled, not remade. */
  keepAgentDir?: boolean;
  now?: () => number;
}): HostRun {
  return prepareReviewHost({
    ...o,
    profile: { ...o.profile, lookup: o.profile?.lookup ?? homeProfileLookup() },
    authWords: {
      missing: (src) => `no pi login at ${src} — run \`qcr login\` first`,
      expiring: ({ expiresAt, needMs }) =>
        `your pi login expires at ${new Date(expiresAt).toISOString()}, inside this review's ${Math.round(needMs / 60_000)}-minute budget. ` +
        "A review never refreshes it (that would rotate the login pi itself holds). Use pi once (`qcr login`) so it refreshes its own login, then run again.",
    },
  });
}
