// Owner-only cleanup for durable review failure debt whose PR is already
// terminal on GitHub. This module has no mutation/session/dispatch
// dependency by construction: one authoritative read classifies the PR, then
// one StateStore transaction terminalizes the exact command + incident.
import type { TerminalFailurePayload } from "./commands.js";
import type { PrDisposition } from "./github.js";
import type { FileOutcome } from "./improvements.js";
import type { StateStore } from "./state.js";

export interface TerminalFailureDeps {
  store: StateStore;
  getPrDisposition(pr: number): Promise<PrDisposition>;
}

export async function resolveTerminalFailure(
  deps: TerminalFailureDeps,
  input: TerminalFailurePayload,
): Promise<FileOutcome> {
  let disposition: PrDisposition;
  try {
    disposition = await deps.getPrDisposition(input.pr);
  } catch (error) {
    return {
      ok: false,
      reason: `could not prove terminal GitHub state for PR #${input.pr}: ${String(error)}`,
    };
  }
  if (disposition.kind === "open") {
    return { ok: false, reason: `GitHub says PR #${input.pr} is still open` };
  }
  if (disposition.kind === "closed" && disposition.head_sha !== input.head_sha) {
    return {
      ok: false,
      reason: `GitHub closed PR #${input.pr} head ${disposition.head_sha} != expected failure head ${input.head_sha}`,
    };
  }
  return deps.store.resolveTerminalReviewFailure({
    ...input,
    disposition: disposition.kind,
  });
}
