// The profile's posting policy — `[posting]` in profile.toml.
//
// What a review POSTS is a separate question from what it FINDS. The lenses,
// the validator, the blocker bar, the reachability gate, red-CI, NIT SCOPE and
// the validator's doubt-not-kill mark decide what is TRUE and how severe; this
// section decides only how much of the survivors reaches the PR, for a repo
// (or a benchmark) that wants a handful of comments per PR rather than every
// true one:
//
//   [posting]
//   max_comments = 4          # findings posted per round; 0 = no cap (default)
//   nits = "off"              # post (default) | off
//   questions = "blocking"    # post (default) | blocking (P0–P2 only) | off
//   repeat_sites = false      # true (default): a finding may post at each site
//   body = "verdict"          # full (default) | verdict (verdict line + one sentence)
//   comment_style = "concise" # full (default) | concise (one claim, ≤3 sentences)
//
// Inherited through `extends` like every scalar (per key, the nearest profile
// that sets it wins — src/profiles.ts `loadProfilePosting`) and overlaid on the
// config as `cfg.posting` by `applyProfilePosting`. Absent or all-default ⇒
// NOTHING changes: no round-order note, no addendum, no enforcement — pinned
// byte for byte by tests/posting-default-identity.test.ts.
//
// Three places carry it, and the third is what makes it a policy rather than
// a hope:
//   1. the round order — a POSTING POLICY note before step 6
//      (`renderPostingPolicyNote`, `{{posting_policy_note}}`);
//   2. the validator — a generated addendum (`postingPolicyAddenda`, composed
//      through the addendum registry like the lens-ceiling ones, rule 6) that
//      has it SELECT what posts by a senior reviewer's judgement and mark the
//      rest `withheld`;
//   3. mechanically after the session — `selectPosted`, applied by
//      src/posting.ts `assembleReview` and by the benchmark export
//      (src/bench/benchposting.ts), so a session that over-posts is still cut.
//      What it cuts is recorded `withheld` with a word, never dropped silently.
//
// Two invariants no setting moves: a `[blocker]` is NEVER withheld (the
// blocker bar does not move — a budget is filled around the blockers, never
// out of them), and nothing a policy withholds is deleted from the findings
// record.
import { VALIDATE_PASS, type PassAddendum } from "./include.js";

export type NitsPolicy = "post" | "off";
export type QuestionsPolicy = "post" | "blocking" | "off";
export type BodyPolicy = "full" | "verdict";
export type CommentStyle = "full" | "concise";

export interface PostingPolicy {
  /** Findings posted per round (inline + body together, one root cause
   * counted once); 0 = no cap. */
  max_comments: number;
  nits: NitsPolicy;
  questions: QuestionsPolicy;
  /** false ⇒ one finding posts once, at its best site. */
  repeat_sites: boolean;
  body: BodyPolicy;
  comment_style: CommentStyle;
}

/** Today's behaviour, key for key. */
export const DEFAULT_POSTING_POLICY: Readonly<PostingPolicy> = Object.freeze({
  max_comments: 0,
  nits: "post",
  questions: "post",
  repeat_sites: true,
  body: "full",
  comment_style: "full",
});

export const POSTING_KEYS = [
  "max_comments",
  "nits",
  "questions",
  "repeat_sites",
  "body",
  "comment_style",
] as const;

/** A budget is a handful of comments, not a second inline cap (GitHub's is 50). */
export const MAX_COMMENTS_LIMIT = 50;

/** The words a withheld finding carries in the findings record. */
export const WITHHOLD_WORDS = [
  "over-budget",
  "nits-off",
  "questions-off",
  "question-not-blocking",
  "repeat-site",
] as const;
export type WithholdWord = (typeof WITHHOLD_WORDS)[number];

/** Ids the compiled posting addenda take — a profile pack may not claim them. */
export const POSTING_ADDENDUM_IDS = ["posting-policy-validate"] as const;

function oneOf<T extends string>(
  at: string,
  key: string,
  value: unknown,
  allowed: readonly T[],
): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value))
    return value as T;
  throw new Error(
    `${at} ${key} must be one of ${allowed.map((a) => `"${a}"`).join(", ")} (got ${JSON.stringify(value)})`,
  );
}

/**
 * Parse one profile's `[posting]` table. `where` names the file in every
 * error. Anything malformed throws — an unknown key, a wrong type, a value out
 * of range: a profile that asks for a policy this cannot honour fails the boot,
 * never reviews as if it had.
 */
export function parsePostingTable(where: string, raw: unknown): Partial<PostingPolicy> {
  const at = `${where} [posting]`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new Error(`${at} must be a table`);
  const out: Partial<PostingPolicy> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    switch (key) {
      case "max_comments":
        if (
          typeof value !== "number" ||
          !Number.isInteger(value) ||
          value < 0 ||
          value > MAX_COMMENTS_LIMIT
        )
          throw new Error(
            `${at} max_comments must be a whole number from 0 (no cap) to ${MAX_COMMENTS_LIMIT} (got ${JSON.stringify(value)})`,
          );
        out.max_comments = value;
        break;
      case "nits":
        out.nits = oneOf(at, key, value, ["post", "off"] as const);
        break;
      case "questions":
        out.questions = oneOf(at, key, value, ["post", "blocking", "off"] as const);
        break;
      case "repeat_sites":
        if (typeof value !== "boolean")
          throw new Error(
            `${at} repeat_sites must be true or false (got ${JSON.stringify(value)})`,
          );
        out.repeat_sites = value;
        break;
      case "body":
        out.body = oneOf(at, key, value, ["full", "verdict"] as const);
        break;
      case "comment_style":
        out.comment_style = oneOf(at, key, value, ["full", "concise"] as const);
        break;
      default:
        throw new Error(`${at} unknown key "${key}" — allowed: ${POSTING_KEYS.join(", ")}`);
    }
  }
  return out;
}

/** The whole policy: the keys a chain set, over the shipped defaults. */
export function resolvePostingPolicy(partial: Partial<PostingPolicy>): PostingPolicy {
  return { ...DEFAULT_POSTING_POLICY, ...partial };
}

/** True when the policy changes nothing — absent counts as default. */
export function isDefaultPosting(p: PostingPolicy | undefined): boolean {
  if (p === undefined) return true;
  return POSTING_KEYS.every((k) => p[k] === DEFAULT_POSTING_POLICY[k]);
}

/** The config with the profile's posting policy overlaid. An all-default
 * policy is NOT attached, so a default build carries no `posting` key at all. */
export function applyProfilePosting<C extends { posting?: PostingPolicy }>(
  cfg: C,
  partial: Partial<PostingPolicy>,
): C {
  const policy = resolvePostingPolicy(partial);
  if (isDefaultPosting(policy)) {
    const { posting: _drop, ...rest } = cfg;
    return rest as C;
  }
  return { ...cfg, posting: policy };
}

// ---- the round order --------------------------------------------------------

function policyLines(p: PostingPolicy, who: "session" | "validator"): string[] {
  const L: string[] = [];
  if (p.max_comments > 0)
    if (p.max_comments > 0) {
      L.push(
        `- **Budget: at most ${p.max_comments} posted finding${p.max_comments === 1 ? "" : "s"} this round** — inline comments and findings posted in the body counted together. Every surviving \`[blocker]\` posts whatever the budget (the blocker bar never moves; a budget is filled around the blockers, never out of them). Fill the rest by what a senior reviewer would insist on before merge: real bugs first — wrong behaviour, crashes, data loss, security, races — then the risks most likely to bite, then everything else.${who === "session" ? " `pass-validate` makes that selection in step 4 (its SELECTED/WITHHELD blocks); post what it selected." : ""}`,
      );
      // The budget counts root causes, not sites, and ties go to the defect on
      // a changed line.
      L.push(
        '- **One root cause, one comment — merge BEFORE you count.** Survivors that are the same defect at several sites — the same wrong assumption, the same missing guard, the same mistaken call repeated across functions or files — are ONE finding: post it once, at the site where the cause is clearest (the changed line that introduces it), and name the other sites in its text ("also at `path:line`, `path:line`"). It counts once against the budget. Distinct defects that merely sit near each other stay separate.',
      );
      L.push(
        "- **Within one severity, the changed line first.** Between two survivors of the same tag and severity, rank a defect on a line this PR changed — a wrong operator, a wrong variable, a missing check in the new code — above a consequence it has in code the PR did not touch.",
      );
    }
  if (p.nits === "off")
    L.push(
      "- **Nits: off.** No `[nit]` is posted. A surviving nit is recorded `withheld` (word `nits-off`).",
    );
  if (p.questions === "off")
    L.push(
      "- **Questions: off.** No `[question]` is posted. A surviving question is recorded `withheld` (word `questions-off`).",
    );
  if (p.questions === "blocking")
    L.push(
      "- **Questions: blocking only.** A `[question]` posts only when its severity is `P0`–`P2` — a likely defect the reachability gate turned into a question. A `P3` question is recorded `withheld` (word `question-not-blocking`). The reachability gate itself is unchanged.",
    );
  if (!p.repeat_sites)
    L.push(
      '- **One site per finding.** A finding that applies at several places posts ONCE, at its single best anchor; name the other sites in its text ("also at `path:line`"). Extra sites are recorded `withheld` (word `repeat-site`).',
    );
  if (p.body === "verdict")
    L.push(
      "- **Body: verdict only.** The review body is the verdict line and ONE plain sentence — no opening paragraph, no lenses line, no Blockers/Nits/Questions sections, no `<details>`. A selected finding with no valid inline anchor is the one exception: it goes in as a single bullet line `` - `path:line` — <title> ``.",
    );
  if (p.comment_style === "concise")
    L.push(
      "- **Concise comments.** Each posted comment is ONE claim: the tag-and-title line, then at most three sentences — what goes wrong, where, and under what condition — then the metadata tail. No scenario essays, no restated mechanism, no menu of fixes. A precise sentence satisfies the blocker self-sufficiency rule.",
    );
  return L;
}

/**
 * The POSTING POLICY note, rendered into `{{posting_policy_note}}` just before
 * step 6. "" for an absent or all-default policy, so a default round order is
 * byte-identical.
 */
export function renderPostingPolicyNote(p: PostingPolicy | undefined): string {
  if (p === undefined || isDefaultPosting(p)) return "";
  return [
    "",
    "",
    "**POSTING POLICY — this repo's profile (`[posting]`).** What is true and how severe is decided above, unchanged; this policy decides only how much of it is POSTED. It binds steps 6 and 7:",
    "",
    ...policyLines(p, "session"),
    '- **Nothing is lost.** Every survivor you do not post goes in the findings record with `"disposition": "withheld"`, its word, and the reason — kept, never deleted. The policy is also applied mechanically after you, so an over-budget review is cut lowest-ranked first and the cut is recorded the same way.',
  ].join("\n");
}

// ---- the validator ------------------------------------------------------------

/**
 * The addendum the policy compiles into for `pass-validate` — composed through
 * the addendum registry after the profile's own pack and its lens-ceiling
 * addenda (rule 6: the seed stays frozen). [] for an absent or all-default
 * policy.
 */
export function postingPolicyAddenda(p: PostingPolicy | undefined): PassAddendum[] {
  if (p === undefined || isDefaultPosting(p)) return [];
  const text = [
    "",
    "## Posting policy: select what posts (this repo's profile)",
    "This repo's profile limits what one review POSTS. It changes nothing in your audit: re-derive, kill, doubt, demote and cap exactly as above, and the blocker bar, the reachability gate and every severity stay where they are. Only AFTER the audit, apply this to the SURVIVORS:",
    "",
    ...policyLines(p, "validator"),
    "",
    "Output two blocks after your survivors, in addition to KILLED (and DOUBTED):",
    "",
    "```",
    "SELECTED",
    "- <lens> <path:line> — <one line: why a senior reviewer would insist on it>",
    "WITHHELD",
    "- <lens> <path:line> — <word> — <one-line reason>",
    "```",
    "",
    `SELECTED is the survivors to post, most important first. WITHHELD is every other survivor with its word (${WITHHOLD_WORDS.map((w) => `\`${w}\``).join(", ")}): the session records each one in the findings record as \`withheld\` — never posted, never deleted. Withholding is not a kill: do not move a withheld finding's severity or confidence, and never withhold a \`[blocker]\`.`,
    ...(p.comment_style === "concise"
      ? [
          "",
          "For every SELECTED survivor, write its finding text as the posted comment should read: one claim, at most three sentences — what goes wrong, where, and the condition.",
        ]
      : []),
    "",
  ].join("\n");
  return [{ id: "posting-policy-validate", scope: [VALIDATE_PASS], text }];
}

// ---- mechanical enforcement ---------------------------------------------------

/** The posting class of one posted item. `check` is the marker-led human
 * items (`[check this]`, `[ask your human]`, `[deferred]`) and anything
 * untagged. */
export type PolicyClass = "blocker" | "question" | "nit" | "check";

/** What the enforcement needs to know about one posted item. */
export interface PolicyView {
  cls: PolicyClass;
  /** `P0`…`P3` / `nit`, or null when unknown. */
  severity: string | null;
  /** The finding's identity across sites: its title, normalised. Two items
   * with one key are the same finding at two sites. */
  key: string;
  /** Does the item sit on a line this PR changed? `undefined` when the diff
   * is not known. Within one class and severity the budget prefers a changed
   * line, then unknown, then unchanged code. */
  changedLine?: boolean;
}

const changedRank = (c: boolean | undefined): number => (c === true ? 0 : c === undefined ? 1 : 2);

const CLASS_RANK: Record<PolicyClass, number> = { blocker: 0, question: 1, check: 2, nit: 3 };
const SEVERITY_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3, NIT: 4 };

function sevRank(s: string | null): number {
  return s === null ? 5 : (SEVERITY_RANK[s.trim().toUpperCase()] ?? 5);
}

/** Normalise a finding title into a repeat-site key: no tags, no markers, no
 * code spans' backticks, lowercase, collapsed whitespace. */
export function siteKey(title: string): string {
  return title
    .replace(/\[(blocker|question|nit|check this|ask your human|deferred)\]/gi, "")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export interface Selection<T> {
  kept: T[];
  withheld: Array<{ item: T; word: WithholdWord }>;
}

/**
 * Apply the policy to the items a round would post, in the order they would
 * post. Deterministic and order-preserving for what it keeps:
 *   1. tag rules — `nits = off`, `questions = off | blocking` (a question of
 *      unknown severity is kept: it cannot be shown non-blocking);
 *   2. repeat sites — of the items sharing a key, only the strongest (class,
 *      then severity, then the first posted) is kept; the rest are withheld;
 *   3. the budget — blockers always kept; the remaining slots go to the rest
 *      ranked by class (question, then marker items, then nits), then
 *      severity, then a changed line before an unknown one before unchanged
 *      code (`changedLine`), then the order the session posted them in (its
 *      own ranking). A slot is a root cause: the sites sharing a key (kept
 *      under `repeat_sites = true`) post on one slot.
 * A blocker is never withheld by any rule but a repeat site of itself.
 */
export function selectPosted<T>(
  items: readonly T[],
  view: (t: T) => PolicyView,
  p: PostingPolicy | undefined,
): Selection<T> {
  if (p === undefined || isDefaultPosting(p)) return { kept: [...items], withheld: [] };
  const withheld: Selection<T>["withheld"] = [];
  const pass1: Array<{ item: T; v: PolicyView; i: number }> = [];
  items.forEach((item, i) => {
    const v = view(item);
    if (v.cls === "nit" && p.nits === "off") return void withheld.push({ item, word: "nits-off" });
    if (v.cls === "question" && p.questions === "off")
      return void withheld.push({ item, word: "questions-off" });
    if (
      v.cls === "question" &&
      p.questions === "blocking" &&
      v.severity !== null &&
      sevRank(v.severity) > 2
    )
      return void withheld.push({ item, word: "question-not-blocking" });
    pass1.push({ item, v, i });
  });
  const pass2: typeof pass1 = [];
  if (!p.repeat_sites) {
    // The site that posts is the finding's strongest occurrence — by class,
    // then severity, then the session's order — so a blocker is never
    // withheld behind a weaker site of itself.
    const best = new Map<string, (typeof pass1)[number]>();
    for (const e of pass1) {
      if (e.v.key === "") continue;
      const b = best.get(e.v.key);
      if (
        b === undefined ||
        (CLASS_RANK[e.v.cls] - CLASS_RANK[b.v.cls] ||
          sevRank(e.v.severity) - sevRank(b.v.severity)) < 0
      )
        best.set(e.v.key, e);
    }
    for (const e of pass1) {
      if (e.v.key !== "" && best.get(e.v.key) !== e) {
        withheld.push({ item: e.item, word: "repeat-site" });
        continue;
      }
      pass2.push(e);
    }
  } else pass2.push(...pass1);
  if (p.max_comments <= 0) return { kept: pass2.map((e) => e.item), withheld };
  const blockers = pass2.filter((e) => e.v.cls === "blocker");
  const rest = pass2
    .filter((e) => e.v.cls !== "blocker")
    .sort(
      (a, b) =>
        CLASS_RANK[a.v.cls] - CLASS_RANK[b.v.cls] ||
        sevRank(a.v.severity) - sevRank(b.v.severity) ||
        changedRank(a.v.changedLine) - changedRank(b.v.changedLine) ||
        a.i - b.i,
    );
  // The budget counts ROOT CAUSES: under `repeat_sites = true` every site of
  // a finding (one key) posts on the slot its first site took.
  const slotted = new Set<string>();
  let used = 0;
  const hasSlot = (e: (typeof pass2)[number]): boolean => e.v.key !== "" && slotted.has(e.v.key);
  const take = (e: (typeof pass2)[number]): void => {
    if (hasSlot(e)) return;
    if (e.v.key !== "") slotted.add(e.v.key);
    used += 1;
  };
  const chosen = new Set<number>();
  for (const e of [...blockers, ...rest]) {
    if (e.v.cls === "blocker" || hasSlot(e) || used < p.max_comments) {
      take(e);
      chosen.add(e.i);
    } else withheld.push({ item: e.item, word: "over-budget" });
  }
  return { kept: pass2.filter((e) => chosen.has(e.i)).map((e) => e.item), withheld };
}

/** The first sentence of a paragraph of plain prose ("" when there is none). */
export function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat === "") return "";
  const m = /^(.+?[.!?])(\s|$)/.exec(flat);
  return (m ? m[1] : flat) as string;
}

export interface VerdictCounts {
  blocker: number;
  nit: number;
  question: number;
}

/** `**Verdict: <label>** — 2 blockers, 1 question.` over what actually posts. */
export function verdictLineFor(label: string, counts: VerdictCounts): string {
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const parts: string[] = [];
  if (counts.blocker) parts.push(plural(counts.blocker, "blocker"));
  if (counts.nit) parts.push(plural(counts.nit, "nit"));
  if (counts.question) parts.push(plural(counts.question, "question"));
  return `**Verdict: ${label}** — ${parts.length ? parts.join(", ") : "no findings"}.`;
}
