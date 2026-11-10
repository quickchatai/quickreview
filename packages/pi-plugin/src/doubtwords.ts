// The validator's validity vetoes — a leaf, so every reader of a validator's
// answer (the daemon's findings record, the setup replay) holds one list
// without loading the daemon's state.
/**
 * The kill words that are a doubt about the CLAIM itself — the
 * validator's validity vetoes, as opposed to a repeat, scope, bar or shape
 * kill. The validator lists these under DOUBTED (the
 * `validate-doubt-not-kill` addendum in packages/pi-plugin/src/include.ts); a `killed` entry
 * carrying one is folded onto `doubted` at parse time anyway, so a session
 * still on an older prompt cannot make a doubted finding vanish as a kill.
 * `partial-chain` is the exploit chain's doubt: a chain with two or more
 * unproven hops (the `validate-sec-evidence` addendum; secevidence.ts) is
 * kept for the next round's `delta`, never posted and never killed.
 */
export const DOUBT_WORDS: readonly string[] = [
  "refuted",
  "unverifiable",
  "bad-anchor",
  "partial-chain",
];
