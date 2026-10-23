// The CLI's review home: where `qcr review` keeps each repo's delta history
// and saved destination, `<state home>/review` (src/homes.ts). The store and
// the destinations themselves are core (src/reviewstore.ts,
// src/reviewdest.ts) and take the home as an argument; these are the same
// calls with the install's home filled in.
import { join } from "node:path";
import { stateHome, type InstallEnv } from "./homes.js";
import { openReviewStoreIn, type ReviewStore } from "./reviewstore.js";
import {
  loadDefaultDestinationsIn,
  saveDefaultDestinationsIn,
  type Destination,
} from "./reviewdest.js";

/** `<state home>/review`: the per-repo stores live under it. */
export function reviewHome(env: InstallEnv = process.env): string {
  return join(stateHome(env), "review");
}

/** The repo's store under the install's review home; null outside a git repo. */
export function openReviewStore(cwd: string, env: InstallEnv = process.env): ReviewStore | null {
  return openReviewStoreIn(reviewHome(env), cwd);
}

/** The repo's saved destinations under the install's review home. */
export function loadDefaultDestinations(cwd: string): Destination[] | null {
  return loadDefaultDestinationsIn(reviewHome(), cwd);
}

/** Keep the choice for this repo under the install's review home. */
export function saveDefaultDestinations(cwd: string, d: readonly Destination[]): boolean {
  return saveDefaultDestinationsIn(reviewHome(), cwd, d);
}
