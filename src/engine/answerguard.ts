// What an idle-PR answer worker's bash may not do. Its tools are read-only
// repo tools plus chat; when the operator marks the message may-post it also gets
// the bash tool, for the post scripts (rule 1: through the daemon's one gate). The
// exec policy (packages/pi-plugin/extensions/bash-guard.ts) already confines that bash. This adds the
// one thing the answer worker is never given, a verdict: an answer is not a round.
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

/** `scripts/commit-verdict.sh`, however a command line spells the path, shell-quoted included. */
export const COMMIT_VERDICT_RE = /(?:^|[\s/;&|("'])commit-verdict\.sh(?:[\s;&|)"']|$)/;

export const ANSWER_VERDICT_REASON =
  "an answer to the operator commits no verdict: a verdict belongs to a round";

/** True when `command` would commit a round's verdict. */
export const commitsVerdict = (command: string): boolean => COMMIT_VERDICT_RE.test(command);

export function createAnswerGuard(): ExtensionFactory {
  return (pi: ExtensionAPI): void => {
    pi.on("tool_call", (event) => {
      if (event.toolName !== "bash") return;
      const command = (event.input as { command?: unknown } | undefined)?.command;
      if (typeof command === "string" && commitsVerdict(command))
        return { block: true, reason: ANSWER_VERDICT_REASON };
      return;
    });
  };
}
