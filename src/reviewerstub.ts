// Where the reviewer stub (D34) lives and what pi loads it as. Neutral: the SDK
// session factories (src/engine/roundsdk.ts) and the bot worker (src/botworker.ts)
// need the two names, and neither may import src/hostroute.ts for them (its
// closure reaches the state store, which a worker never opens).
import { join } from "node:path";

/** The reviewer stub, relative to the production tree. */
export const REVIEWER_STUB = join("deploy", "reviewer", "AGENTS.override.md");

/** The name pi loads it under from the cwd (first of its candidates). */
export const HOST_CONTEXT_STUB = "AGENTS.override.md";
