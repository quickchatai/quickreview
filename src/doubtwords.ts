// The validator's validity vetoes — a leaf, so every reader of a validator's
// answer (the daemon's findings record, the setup replay) holds one list
// without loading the daemon's state.
/**
 * The kill words that are a doubt about the CLAIM itself — the
 * validator's validity vetoes, as opposed to a repeat, scope, bar or shape
 * kill. The validator lists these under DOUBTED (the
 * `validate-doubt-not-kill` addendum in src/include.ts); a `killed` entry
 * carrying one is folded onto `doubted` at parse time anyway, so a session
 * still on an older prompt cannot make a doubted finding vanish as a kill.
 */
export const DOUBT_WORDS: readonly string[] = ["refuted", "unverifiable", "bad-anchor"];
