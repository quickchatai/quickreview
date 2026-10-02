// The production composition of the `[posting]` policy, in one place for the
// tests: the overlay wire.ts/the bench apply, and the addenda they compose.
import type { Config } from "../../src/config.js";
import type { PassAddendum } from "../../src/include.js";
import { applyProfilePosting, postingPolicyAddenda } from "../../src/postingpolicy.js";
import { loadProfilePosting, type ProfileLookup } from "../../src/profiles.js";

export function applyPosting(
  cfg: Config,
  root: string,
  profile: string,
  lookup: ProfileLookup = {},
): Config {
  return applyProfilePosting(cfg, loadProfilePosting(root, profile, lookup));
}

export function addenda(cfg: Config): PassAddendum[] {
  return postingPolicyAddenda(cfg.posting);
}
