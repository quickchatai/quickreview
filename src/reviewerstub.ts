// Where the reviewer stub (D34) lives and what pi loads it as. Neutral: the SDK
// session factories (src/engine/roundsdk.ts) and the bot worker (src/botworker.ts)
// need the two names, and neither may import src/hostroute.ts for them (its
// closure reaches the state store, which a worker never opens).
import { existsSync } from "node:fs";
import { join } from "node:path";

/** The reviewer stub, relative to the production tree. */
export const REVIEWER_STUB = join("deploy", "reviewer", "AGENTS.override.md");

/** The name pi loads it under from the cwd (first of its candidates). */
export const HOST_CONTEXT_STUB = "AGENTS.override.md";

/** Where the reviewer stub is under `root`, or null when it is in neither place.
 * A checkout keeps it at `deploy/reviewer/`; the release and bench images
 * install it at the tree's root under the name pi loads (docker/Dockerfile,
 * bench/aacr/Dockerfile). */
export function findReviewerStub(root: string): string | null {
  for (const source of [join(root, REVIEWER_STUB), join(root, HOST_CONTEXT_STUB)])
    if (existsSync(source)) return source;
  return null;
}

/** As `findReviewerStub`, failing loudly: a context file is never dropped silently. */
export function reviewerStubSource(root: string): string {
  const source = findReviewerStub(root);
  if (source) return source;
  throw new Error(
    `the reviewer context stub is missing at ${join(root, REVIEWER_STUB)} and ${join(root, HOST_CONTEXT_STUB)}`,
  );
}
