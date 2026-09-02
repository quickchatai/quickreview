// Severity → posting-tag mapping (spec §5): P0/P1 → [blocker]; P2 → [blocker]
// iff confidence ≥ 0.8 else [question]; P3 → [question] (or [nit] when the
// finding is a nit-class polish item). Nits and questions never block.
//
// adds a third axis, `reachability` — how often the triggering state
// actually arises, as opposed to how bad it is (severity) or whether the claim
// is true (confidence). It is applied as a gate BEFORE the severity mapping and
// can only ever weaken a tag: `contrived` never blocks at any severity,
// `plausible` demotes P2 to a question, `routine` (and an absent field) leaves
// the mapping exactly as it was. The blocker bar itself does not move — a
// `routine` P0/P1 blocks today as it always did.
//
// introduced first-party directive provenance (the owner, 2026-08-19):
// the reviewed repo's OWN agent-directive files (.claude/**, prompts/**,
// AGENTS.md/CLAUDE.md and kin — `isFirstPartyDirectivePath`). What that
// provenance DOES was reshaped by (the owner, 2026-08-25): routine
// first-party instructions — directive text inside a directive file doing its
// job — are suppressed at the lens/validator layer and never reach this map as
// a finding. A kind=injection candidate that DOES survive has proved an
// obvious malicious payload or a concrete untrusted-source→model path, and
// its first-party location softens nothing: `postTag` maps it by severity
// exactly like any other finding, so a P0/P1 blocks. The verdict is decided on
// the merits (the NEEDS_HUMAN park first routed to was retired in
//), and the review additionally carries exactly one short
// security-attention comment @-mentioning a deterministically-picked teammate
// (rendered by posting.ts `renderDirectiveEscalationComment`, mention picked
// in dispatch.ts). Third-party/vendored directive content keeps the P1 bright
// line unchanged.

import type { Verdict as VerdictType } from "./types.js";

export type Severity = "P0" | "P1" | "P2" | "P3" | "nit";
export type PostTag = "blocker" | "question" | "nit";

/** How often the state a finding depends on actually arises. */
export type Reachability = "routine" | "plausible" | "contrived";

export const REACHABILITY_VALUES: readonly Reachability[] = ["routine", "plausible", "contrived"];

/** Findings that omit the axis are read as `routine` — the legacy
 * behaviour, so an un-upgraded pass can never accidentally soften a blocker. */
export function normalizeReachability(value: string | undefined | null): Reachability {
  return REACHABILITY_VALUES.includes(value as Reachability) ? (value as Reachability) : "routine";
}

// ---- first-party directive provenance ---------------------------

/** The directive-path vocabulary the predicate below walks. lifts it
 * into config as an EXTEND-only surface: `[review.directives]` `extra_*` keys
 * ADD entries and nothing can remove the built-ins. Replacement is
 * deliberately not offered — dropping, say, `CLAUDE.md` from the vocabulary
 * would silently re-enable auto-blocking on first-party directive edits,
 * which is's ratified behaviour drifting by config typo. A repo whose
 * tree genuinely uses one of these names for something else loses at most an
 * escalation comment; the reverse mistake loses a ratified guarantee. */
export interface DirectiveVocabulary {
  /** Path segments that mark VENDORED/third-party content: a directive file
   * under one of these keeps the injection bright line — it was not authored
   * in-repo through the PR flow. Matched lowercased. */
  vendoredSegments: Set<string>;
  /** Basenames that are agent-directive files wherever they sit in the tree. */
  basenames: Set<string>;
  /** Directory segments whose whole subtree is agent-directive content. */
  dirSegments: Set<string>;
  /** Root-level directory names whose subtree is directive content AT THE
   * REPO ROOT ONLY — a nested `foo/prompts/` is an ordinary source dir. */
  rootDirs: Set<string>;
  /** Exact repo-relative file paths that are directive files. */
  files: Set<string>;
}

/** Config-shaped EXTENSIONS to the built-in vocabulary (all optional; the
 * shape [review.directives] parses into — see src/config.ts). */
export interface DirectiveVocabularyExtras {
  extra_vendored_segments?: string[];
  extra_basenames?: string[];
  extra_dir_segments?: string[];
  extra_root_dirs?: string[];
  extra_files?: string[];
}

/** The compiled-in vocabulary — today's exact lists; the shipped default. */
export const DEFAULT_DIRECTIVE_VOCABULARY: DirectiveVocabulary = {
  vendoredSegments: new Set(["node_modules", "vendor", "vendors", "vendored", "third_party", "third-party", "external"]),
  basenames: new Set(["AGENTS.md", "AGENT.md", "CLAUDE.md", ".cursorrules"]),
  dirSegments: new Set([".claude", ".cursor"]),
  rootDirs: new Set(["prompts"]),
  files: new Set([".github/copilot-instructions.md"]),
};

/** Built-ins ∪ the configured extras — EXTEND-only by construction. */
export function directiveVocabulary(extras: DirectiveVocabularyExtras = {}): DirectiveVocabulary {
  const d = DEFAULT_DIRECTIVE_VOCABULARY;
  return {
    vendoredSegments: new Set([...d.vendoredSegments, ...(extras.extra_vendored_segments ?? []).map((s) => s.toLowerCase())]),
    basenames: new Set([...d.basenames, ...(extras.extra_basenames ?? [])]),
    dirSegments: new Set([...d.dirSegments, ...(extras.extra_dir_segments ?? [])]),
    rootDirs: new Set([...d.rootDirs, ...(extras.extra_root_dirs ?? [])]),
    files: new Set([...d.files, ...(extras.extra_files ?? [])]),
  };
}

/**
 * Is `path` a FIRST-PARTY agent-directive file of the reviewed repo —
 * `.claude/**`, top-level `prompts/**`, an `AGENTS.md`/`CLAUDE.md` (and kin)
 * at any depth — and NOT under a vendored tree? The predicate is deliberately
 * path-shaped and shared: dispatch uses it to pick the escalation mention,
 * the tag mapping below uses it to keep such findings off the blocker bar.
 * `vocab` defaults to the compiled-in vocabulary, so every call without
 * config in reach behaves exactly as before.
 */
export function isFirstPartyDirectivePath(
  path: string | undefined | null,
  vocab: DirectiveVocabulary = DEFAULT_DIRECTIVE_VOCABULARY,
): boolean {
  if (!path) return false;
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return false;
  if (segments.some((s) => vocab.vendoredSegments.has(s.toLowerCase()))) return false;
  const basename = segments[segments.length - 1] as string;
  if (vocab.basenames.has(basename)) return true;
  if (segments.some((s) => vocab.dirSegments.has(s))) return true;
  // Root dirs bind at the repo root only — a nested `foo/prompts/` is an
  // ordinary source directory in most trees.
  if (vocab.rootDirs.has(segments[0] as string)) return true;
  if (vocab.files.has(segments.join("/"))) return true;
  return false;
}

/** The gate condition: an injection-kind finding anchored on a
 * first-party directive path. Findings without a `kind` are never gated. */
export function isFirstPartyDirectiveInjection(
  kind: string | undefined | null,
  path: string | undefined | null,
  vocab: DirectiveVocabulary = DEFAULT_DIRECTIVE_VOCABULARY,
): boolean {
  return kind?.trim().toLowerCase() === "injection" && isFirstPartyDirectivePath(path, vocab);
}

export interface PostTagContext {
  /** The finding's `kind` field, when the pass emitted one. */
  kind?: string | null;
  /** The finding's anchored path. */
  path?: string | null;
}

export function postTag(
  severity: Severity,
  confidence: number,
  reachability?: Reachability | null,
  ctx?: PostTagContext,
): PostTag {
  // routine first-party instructions are suppressed before this
  // posting map. A kind=injection candidate that survives has proved an
  // obvious malicious payload or a concrete untrusted-source→model path, so
  // the file's first-party location cannot soften it. `ctx` remains part of
  // the interface for telemetry/callers and the deterministic mention route.
  void ctx;
  const reach = normalizeReachability(reachability);
  // Reachability gate — never blocks something the base mapping wouldn't.
  if (reach === "contrived") return severity === "nit" ? "nit" : "question";
  if (reach === "plausible" && severity === "P2") return "question";
  switch (severity) {
    case "P0":
    case "P1":
      return "blocker";
    case "P2":
      return confidence >= 0.8 ? "blocker" : "question";
    case "P3":
      return "question";
    case "nit":
      return "nit";
  }
}

export type { Verdict } from "./types.js";

export interface VerdictInput {
  hasBlockers: boolean;
  /** LEGACY input: the session's own "I cannot decide this" call, which used
   * to park a PR. retired the park — a NEEDS_HUMAN verdict is still
   * ACCEPTED (older prompts and containers emit it; `normalizeVerdict` folds
   * ESCALATE into it) and the daemon lands it as `tracked`: review posted, no
   * approval, the AI keeps driving. No daemon-side criteria feed it. */
  needsHuman: boolean;
  /** Legacy input retained for older callers/containers.
   * removed its verdict effect: routine first-party instructions produce no
   * finding, while a surviving malicious/path-proven injection follows the
   * ordinary blocker map. */
  firstPartyDirectiveInjection?: boolean;
}

/** Verdict logic: any [blocker] ⇒ REQUEST_CHANGES; an explicit legacy
 * cannot-decide call ⇒ NEEDS_HUMAN; else APPROVE. Directive location alone
 * never changes the merits verdict. */
export function deriveVerdict(v: VerdictInput): VerdictType {
  if (v.hasBlockers) return "REQUEST_CHANGES";
  if (v.needsHuman) return "NEEDS_HUMAN";
  return "APPROVE";
}

/**
 * The "[check this]" inline-comment grammar (addendum, the owner
 * 2026-08-19): every "For a human to double-check" item is ALSO posted as an
 * inline review comment whose first line starts with this tag. The repo's
 * merge rule requires every conversation resolved, so each item opens a
 * thread a person must touch — and the reviewer never resolves one:
 * github.ts resolveOwnReviewThread refuses on this marker, so only the author
 * or another human can clear it.
 */
export const CHECK_THIS_TAG = "[check this]";
export const CHECK_THIS_RE = /^\s*(?:[*_`~>]|\[?!?\[)*\s*\[check this\]/i;

// ---- the "[ask your human]" grammar -----------------------------
//
// A SECOND, deliberately distinct marker — same shape, opposite addressee.
//
//   [check this]      → "a HUMAN should verify this before merge".
//                       Addressed to whoever reads the PR; the thread is
//                       structurally human-resolve-only (resolveOwnReviewThread
//                       refuses on it) because the repo's merge rule is what
//                       forces a person's eyes onto it.
//   [ask your human]  → "IMPLEMENTER: do not answer this yourself — put it to
//                       the person you are working for and bring the answer
//                       back here". Addressed to the PR author's AI agent.
//
// The two must never be conflated: overloading `[check this]` with a second
// meaning was rejected outright on (a third meaning had already been
// proposed for deferrals, and a marker that means three things routes nothing).
// Nothing here changes what `[check this]` means or how it is treated.
//
// RESOLUTION: an `[ask your human]` thread is AUTHOR-RESOLVABLE once answered —
// no new refusal in resolveOwnReviewThread, by decision (§5, which
// rejected borrowing `[check this]`'s human-only machinery: it "forces a person
// into every thread", and the thread's whole point is that the ANSWER, not the
// resolution, is what a human owes). The ordinary path already gives the right
// shape: the bot resolves one of its own threads only through ping-pong, i.e.
// only after the author has replied and the session judged the reply settles
// it. Rule 2 is untouched either way — resolving one's OWN finding thread after
// an answer is not dismissing a review, and no review-dismissal path exists.
export const ASK_HUMAN_TAG = "[ask your human]";
export const ASK_HUMAN_RE = /^\s*(?:[*_`~>]|\[?!?\[)*\s*\[ask your human\]/i;

/** The lens that mints the tag (dispatch.ts ALL_PASSES; agents/pass-ask-human.md). */
export const ASK_HUMAN_LENS = "pass-ask-human";

/**
 * Is this finding an ask-your-human question? Keyed on the lens tag (the
 * merge step concatenates lens tags, so a substring test is the honest one)
 * or on an explicit `kind: ask-human`.
 */
export function isAskHumanFinding(kind?: string | null, lens?: string | null): boolean {
  if (kind?.trim().toLowerCase() === "ask-human") return true;
  return (lens ?? "").toLowerCase().includes(ASK_HUMAN_LENS);
}

// ---- the "[deferred]" grammar -----------------------------------
//
// The THIRD marker, and the last one: "next iteration" was never the author
// proving the finding wrong — it was a cost decision (right finding, real fix,
// not worth an hour then), and that cost has collapsed now that the implementer
// is an AI. So a deferral stops being free: the review session files a ticket
// itself, in the round that deferred, through the daemon's existing capped
// issue path — no confirmation step. **No ticket, no deferral.**
//
// WHY A THIRD TAG RATHER THAN REUSING ONE OF THE TWO. The owner's decision
// (amendment): a deferral is neither of the other two things, and a
// marker that means three things routes nothing — the same argument that got
// `[ask your human]` its own tag on instead of a second meaning for
// `[check this]`. The three, side by side:
//
//   [check this]      → a HUMAN should VERIFY this before merge.
//                       Addressee: whoever reads the PR.
//                       Resolution: human only (structural refusal below).
//   [ask your human]  → the IMPLEMENTER must not answer this itself; put it to
//                       its person and bring the answer back.
//                       Addressee: the PR author's AI agent.
//                       Resolution: author-resolvable once answered.
//   [deferred]        → this finding is REAL and this PR is not where it gets
//                       fixed; the ticket is filed, here is its number.
//                       Addressee: nobody in particular — it states the
//                       finding's own STATE, which is why it is the one tag
//                       with no verb and no addressee in it.
//                       Resolution: human only (structural refusal below).
//
// Confusability was the design constraint, so the spelling avoids every word
// the other two use: no "this" (which `[check this]` owns and which would make
// a `[track this]`/`[fix this]` read as its sibling), no "human", no
// imperative. One word, a past participle, naming a status.
//
// RESOLUTION: an ignored deferral must not be quietly closable by the bot, or
// the whole mechanism is free again — so this marker takes the SAME structural
// refusal as `[check this]` (github.ts resolveOwnReviewThread), and the reviewed
// repo's merge rule then forces a person to look. Rule 2 is untouched: refusing
// to resolve is the safe direction, and no review-dismissal path exists here or
// anywhere else. Nothing about `[check this]` or `[ask your human]` changes.
//
// NOTHING HERE BLOCKS. A deferral never holds the merge gate and never forces a
// fix; it only stops a deferral being free. The falsifier the owner named is a
// backlog nobody works.
export const DEFERRED_TAG = "[deferred]";
export const DEFERRED_RE = /^\s*(?:[*_`~>]|\[?!?\[)*\s*\[deferred\]/i;

/** Is this finding a conscious deferral? Keyed on an explicit `kind`, the one
 * signal a session sets deliberately — there is no lens that mints deferrals
 * (the DECISION to defer belongs to the PR's session, after validation). */
export function isDeferredFinding(kind?: string | null): boolean {
  const k = kind?.trim().toLowerCase();
  return k === "deferred" || k === "deferral";
}

// ---- the closed tag grammar -------------------------------------
//
// 14.4% of the corpus's findings wore a tag this system does not define —
// `[start here 3/5]`, `[verified]`, and nine spellings of "blocker, now fixed".
// That is not a style problem. The tag is what the posting guards, the thread
// resolution refusals and every downstream consumer key on, so an invented tag
// is A FINDING THAT SILENTLY ESCAPES ITS OWN MACHINERY: a mis-tagged
// check-this, for instance, would not be protected by resolveOwnReviewThread.
//
// So the grammar is CLOSED and defined exactly once, here. Two kinds of tag:
//
//   * POSTING tags — the severity map's output, one per finding, always
//     present: `[blocker]`, `[question]`, `[nit]`.
//   * MARKER tags — a routing prefix that may precede the posting tag. Each has
//     one meaning and one resolution rule; see their definitions above.
//
// Nothing here weakens or strengthens a finding: it constrains the SPELLING of
// the tag, never the severity behind it. The blocker bar does not move.

/** The three posting tags, bare (no brackets) — `postTag`'s whole range. */
export const POSTING_TAG_WORDS: readonly PostTag[] = ["blocker", "question", "nit"];

/** Every sanctioned tag, bracketed, in one list: the three posting tags plus
 * the marker prefixes. This is THE grammar — a tag not on it is not one. */
export const SANCTIONED_TAGS: readonly string[] = [
  ...POSTING_TAG_WORDS.map((t) => `[${t}]`),
  CHECK_THIS_TAG,
  ASK_HUMAN_TAG,
  DEFERRED_TAG,
];

/** A leading `[…]` tag on a line, however it is spelled. Bounded length so a
 * markdown link or an array literal at the start of a title is not mistaken
 * for a tag. */
const LEADING_TAG_RE = /^\s*\[([^\]\n]{1,40})\]\s*/;

/** Is `raw` — with or without brackets, in any case, with internal whitespace
 * collapsed — one of the sanctioned tags? */
export function isSanctionedTag(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const inner = raw.trim().replace(/^\[|\]$/g, "").trim().replace(/\s+/g, " ").toLowerCase();
  return SANCTIONED_TAGS.includes(`[${inner}]`);
}

/**
 * Strip a leading tag from a finding TITLE when that tag is outside the
 * grammar.
 *
 * A title is not where a tag belongs — `inlineBody` mints the real one — so a
 * bracketed prefix on a title is either a duplicate of the sanctioned tag or an
 * invented one. Both are removed; the invented one is REPORTED, so the escape
 * shows up in telemetry instead of going out on the PR. A sanctioned marker
 * (`[check this]`, `[ask your human]`) is left alone: those are minted from the
 * finding's own fields and carry meaning.
 *
 * Only the tag is stripped. Not one word of the finding's reasoning is touched
 * — this cuts a wrong label, never a justification.
 */
export function stripUngrammaticalTag(title: string): { title: string; stripped: string | null } {
  const m = LEADING_TAG_RE.exec(title);
  if (!m) return { title, stripped: null };
  const inner = (m[1] ?? "").trim();
  if (isSanctionedTag(inner)) {
    // A sanctioned MARKER stays (it is a routing prefix); a duplicated POSTING
    // tag goes, because inlineBody is about to mint the authoritative one.
    const bare = inner.toLowerCase().replace(/\s+/g, " ");
    if (!POSTING_TAG_WORDS.includes(bare as PostTag)) return { title, stripped: null };
    return { title: title.slice(m[0].length), stripped: null };
  }
  return { title: title.slice(m[0].length), stripped: `[${inner}]` };
}
