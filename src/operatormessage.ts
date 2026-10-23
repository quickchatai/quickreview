// The operator's message to an idle PR, as the answer worker receives it
// (P8.17, rule 9's second exception).
//
// The daemon writes the message into the command's payload (the bytes the
// worker verifies against the sha256 recorded at dispatch) so the one thing that
// decides what the worker may do, `may_post`, rides the same sealed bytes as the
// words. The first line is the header; a payload without it is read as a message
// that may NOT post. The operator's own text follows the daemon's framing and
// cannot reach the header: it is composed after it.
//
// Neutral by fence: shapes and two small functions, no engine, no pi, no store.

/** The longest reply kept, in characters: the answer's result file and the worker's
 * `done` event (the wire line is 1 MiB). */
export const MAX_REPLY_CHARS = 100_000;

const HEADER_RE = /^<!-- qcr-operator-message may_post=(0|1) -->\n/;

/** What the session is told when the operator did not let it post. */
const READ_ONLY_BRIEF = [
  "This is a message from the human operator to you, the PR's reviewer. It is not a round, a wake or a verdict. Answer it in this conversation.",
  "",
  "Your tools are read-only (read, grep, find, ls and memory lookups). You cannot post to GitHub, run a command or change a file, and nothing you write reaches the PR: your reply goes to the operator alone. You have no lens tool and you commit no verdict.",
].join("\n");

/** What the session is told when the operator marked the message may-post. */
const MAY_POST_BRIEF = [
  "This is a message from the human operator to you, the PR's reviewer. It is not a round, a wake or a verdict. Answer it in this conversation.",
  "",
  "The operator has marked this message may-post: you also have the bash tool, for the post scripts only (scripts/post-review.sh, scripts/reply-thread.sh and scripts/approve-pr.sh). Post, reply or approve only what the message below asks for, never anything else; the approval keeps its guards and a refusal stands. You have no lens tool and you commit no verdict. Say in your reply what you posted, or that you posted nothing.",
].join("\n");

/** The payload for one operator message. */
export function operatorMessagePayload(text: string, mayPost: boolean): string {
  const brief = mayPost ? MAY_POST_BRIEF : READ_ONLY_BRIEF;
  return `<!-- qcr-operator-message may_post=${mayPost ? 1 : 0} -->\n${brief}\n\n--- the operator's message ---\n${text.trimEnd()}\n`;
}

/** Whether a payload is an operator's message that may post. Anything else,
 * including a payload with no header, may not. */
export function operatorMayPost(payload: string): boolean {
  return HEADER_RE.exec(payload)?.[1] === "1";
}

/** Whether `payload` is an operator message payload at all. */
export function isOperatorMessage(payload: string): boolean {
  return HEADER_RE.test(payload);
}
