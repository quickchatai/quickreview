// The optional escalation feature (ratified by the owner 2026-08-31).
//
// OFF BY DEFAULT. With `[escalation] enabled = false` — what every shipped
// config carries — nothing here runs: no rule is evaluated, no note is
// rendered into any prompt, no mutation is built. `tests/escalation.test.ts`
// pins that as a property, not a hope.
//
// ---------------------------------------------------------------------------
// THE TWO INVARIANTS, AND HOW THEY ARE STRUCTURAL RATHER THAN PROMPTED
// ---------------------------------------------------------------------------
//
// 1. THE REVIEWER STILL DECIDES. Escalation is additive notification beside a
//    finished verdict; it never defers, never parks, never hands the review
//    back. Manifesto belief 2 and the decision are untouched.
//
//    Enforced by SHAPE, not by discipline: nothing in this module's public
//    surface returns, produces or contains a `Verdict`. `deliverEscalations`
//    resolves to `EscalationOutcome[]` — a delivery record — so there is no
//    channel through which a verdict could be withheld, altered or postponed.
//    The one caller (`src/verdicts.ts`) invokes it AFTER the verdict has been
//    applied and the PR transitioned, wrapped so a throw cannot reach the
//    verdict path. `tests/escalation.test.ts` re-reads this source and fails
//    if the word `Verdict` ever appears in an exported signature here, and
//    `tests/verdicts.test.ts` pins the verdict landed with escalation on
//    against the same round with it off.
//
// 2. ESCALATE A QUESTION, NEVER A REVIEW. The human is never asked to "review
//    this PR". They are pointed at one thing — a file and line range, a
//    migration, a named decision — the smallest thing that actually needs
//    their eyes. Handing someone a whole review is what this system exists to
//    stop; an escalation that does it has failed even when it fired on exactly
//    the right PR.
//
//    Enforced five ways — four braces and one belt. (a) `EscalationScope` is a
//    discriminated union with no "the whole PR" member. (b)
//    `validateEscalationRequest` refuses a scope whose path or decision is
//    blank — an escalation with nothing to look at is not an escalation.
//    (c) a `code`/`migration` path must be a file THIS PR ACTUALLY TOUCHES,
//    compared exactly against the diff: without that, `path: "the entire diff"`
//    and `path: "**"` both passed, which is how a whole-PR escalation was
//    still spellable until the review found it. (d) the comment body is
//    RENDERED from the scope by `renderEscalationComment`, and `decision` — the
//    other free-text slot — is capped to a NAME, not a paragraph. (e) the belt:
//    both free-text slots, `question` and `decision`, go through
//    `asksForWholeReview`. That last one is a heuristic over natural language
//    and will never be complete; it is the belt precisely because (a)–(d) are
//    the braces.
//
// This is the discipline the codebase already has twice — `[check this]`
// inline comments and the `### For a human to double-check` review section
// both hand a person a small, minutes-verifiable job beside a finished verdict
// (see `src/severity.ts`). Escalation is that mechanism WITH A NAMED
// RECIPIENT, not a new one, and the rendered text deliberately reads like
// them.
//
// ---------------------------------------------------------------------------
// TRIGGERS
// ---------------------------------------------------------------------------
//
// * Operator-defined DETERMINISTIC rules always fire. Paths touched, a PR
//   label, a severity floor, a named check failing — `evaluateEscalationRules`
//   is a pure function over facts the daemon already has, inspectable and
//   testable with no LLM anywhere near it.
// * The PR's session MAY ALSO escalate on its own judgement, when the operator
//   turned that on. It is bounded three ways and must stay so: it can only
//   reach a login in `[escalation] targets` (filtered here, daemon-side, not
//   asked of the model), it can never replace a verdict (invariant 1), and it
//   rides the same per-PR cap, the same dedup ledger and the same mutation
//   gate as everything else.
//
// ---------------------------------------------------------------------------
// DELIVERY
// ---------------------------------------------------------------------------
//
// One path, daemon-owned, for both trigger kinds and both shapes — which is
// what makes the target bound and the scope check structural instead of
// prompt-level.
//
// * `comment` (the default): a gated `create_review` with `event: "COMMENT"`
//   and `reviewPurpose: "escalation"` — the same mechanically-authored gated
//   comment the migration pre-check already posts. No new mutation
//   kind, no new posting route, and (like the pre-check) it never claims the
//   head, because it carries no verdict.
// * `review_request`: the comment, PLUS the `request_reviewer` gate kind, so
//   the PR enters that person's review-requested queue. GitHub's own UI frames
//   that as "review this pull request" — precisely the framing invariant 2
//   rules out — so the comment is NOT optional on this shape: it is what
//   carries the narrow ask. `deliverEscalations` posts the comment first and
//   requests only after it succeeded.
//
// Both ride the ONE MutationGate. `request_reviewer` is an ORDINARY kind:
// suppressed in dry-run like everything else, never `forceLive`, never in
// `APP_SELF_CONFIG_KINDS`.
import type { EscalationConfig, EscalationRule, EscalationSeverityFloor } from "./config.js";
import type { GateResult } from "./gate.js";

// ---- what to look at ------------------------------------------------------

/**
 * The thing a human is being pointed at. A discriminated union with no
 * "whole PR" member — that omission is invariant 2's first line of defence:
 * a whole-PR escalation cannot be spelled, so it cannot be built.
 */
export type EscalationScope =
  | { kind: "code"; path: string; start_line?: number; end_line?: number }
  | { kind: "migration"; path: string; migration?: string }
  | { kind: "decision"; decision: string; path?: string };

/**
 * Stable identity of a scope, for the dedup ledger.
 *
 * LINE NUMBERS ARE DELIBERATELY NOT IN THE KEY (review). The unit a
 * human experiences is "you were pointed at this file" — keying on the line
 * range would make an escalation at lines 12–30 and one at 14–32 two distinct
 * asks producing near-identical notes, which is the nag the ledger exists to
 * prevent. Two genuinely different places in one file cost one escalation
 * between them; `max_per_pr` was going to bound that anyway.
 */
export function scopeKey(scope: EscalationScope): string {
  switch (scope.kind) {
    case "code":
      return `code:${scope.path}`;
    case "migration":
      return `migration:${scope.path}`;
    case "decision":
      // The decision text IS the identity here, and it is capped and
      // whitespace-collapsed by normalizeScope, so it cannot drift by spacing.
      return `decision:${scope.decision}:${scope.path ?? ""}`;
  }
}

/** The scope as one operator-facing phrase — the "Look at:" line. */
export function renderScope(scope: EscalationScope): string {
  switch (scope.kind) {
    case "code": {
      const lines =
        scope.start_line && scope.end_line && scope.end_line !== scope.start_line
          ? `, lines ${scope.start_line}–${scope.end_line}`
          : scope.start_line
            ? `, line ${scope.start_line}`
            : "";
      return `\`${scope.path}\`${lines}`;
    }
    case "migration":
      return scope.migration ? `migration \`${scope.migration}\` (\`${scope.path}\`)` : `the migration in \`${scope.path}\``;
    case "decision":
      return scope.path ? `the decision "${scope.decision}" (\`${scope.path}\`)` : `the decision "${scope.decision}"`;
  }
}

/**
 * Coerce a scope out of whatever a session wrote (or a rule assembled).
 * Returns null when there is nothing concrete to look at — which is the
 * refusal invariant 2 asks for, expressed as a value rather than a throw.
 */
export function normalizeScope(raw: unknown): EscalationScope | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const num = (v: unknown): number | undefined => {
    const n = typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : typeof v === "number" ? v : NaN;
    return Number.isInteger(n) && n > 0 ? n : undefined;
  };
  const kind = str(r.kind).toLowerCase();
  const path = str(r.path);
  if (kind === "migration") {
    if (!path) return null;
    const migration = str(r.migration).slice(0, 80);
    return migration ? { kind: "migration", path, migration } : { kind: "migration", path };
  }
  if (kind === "decision") {
    // Capped and whitespace-collapsed HERE, so `decision` cannot become a
    // paragraph-length free-text field carrying a whole-review ask — the
    // review's exploit. `validateEscalationRequest` additionally puts
    // it through `asksForWholeReview`, exactly like `question`.
    const decision = str(r.decision).replace(/\s+/g, " ").slice(0, MAX_ESCALATION_DECISION);
    if (!decision) return null;
    return path ? { kind: "decision", decision, path } : { kind: "decision", decision };
  }
  // Default and by far the common case: a place in the code.
  if (!path) return null;
  const start = num(r.start_line);
  // An end without a start is meaningless — the old `end ?? start` was dead
  // code inside a branch that already required `end` (review) and let
  // a lone `end_line` through to sit in the scope rendering nothing.
  const end = start === undefined ? undefined : num(r.end_line);
  return {
    kind: "code",
    path,
    ...(start !== undefined ? { start_line: start } : {}),
    ...(end !== undefined ? { end_line: Math.max(end, start!) } : {}),
  };
}

// ---- the request ----------------------------------------------------------

/** Where an escalation came from. Recorded on every delivery. */
export type EscalationOrigin = "rule" | "session";

export interface EscalationRequest {
  /** GitHub login, no leading "@". Always one of `[escalation] targets`. */
  target: string;
  /** WHAT to look at. */
  scope: EscalationScope;
  /** The narrow ask — one or two sentences about the scope, never about the PR. */
  question: string;
  /** WHY this person. From the rule's `why`, or the session's own reason. */
  why: string;
  origin: EscalationOrigin;
  /** The rule that fired, when `origin === "rule"`. */
  rule?: string;
}

/**
 * Why an escalation was refused. Every one is an ANSWER, never a throw:
 * escalation is notification, and a malformed one costs a log line and
 * nothing else — least of all a verdict.
 */
export type EscalationRefusal =
  | "disabled"
  | "no-target"
  | "target-not-configured"
  | "no-scope"
  /** A `code`/`migration` scope naming a file the PR does not touch. */
  | "path-not-in-diff"
  | "no-question"
  | "asks-for-whole-review"
  | "session-judgement-off"
  | "capped"
  | "already-delivered";

export type EscalationValidation =
  | { ok: true; request: EscalationRequest }
  | { ok: false; refusal: EscalationRefusal };

/** Longest question we will carry. A paragraph is not a narrow ask. */
export const MAX_ESCALATION_QUESTION = 400;

/** Longest `decision` name. A decision is a NAME, not an essay — and an
 * uncapped one was the review's route to a whole-review ask. */
export const MAX_ESCALATION_DECISION = 120;

/**
 * Invariant 2's belt, and it is only a belt.
 *
 * The braces are structural: the union has no whole-PR member, a `code`/
 * `migration` path must be a file the PR actually touches, the body is
 * rendered from the scope, and `decision` is capped. What is left is two short
 * free-text slots — `question` and `decision` — and this is what keeps a
 * whole-review ask out of them.
 *
 * The first version of this regex missed 7 of 7 natural phrasings the
 * reviewer tried ("Could you cast an eye over all of it?", "Please read
 * through the changes.", "Are you happy with everything here?"). The rewrite
 * is two rules rather than one pattern:
 *
 *   BREADTH   — a word that means "the lot": whole, entire, everything,
 *               all of it, a second pair of eyes, top to bottom, at all…
 *               These are damning on their own; nothing narrow needs them.
 *   ARTIFACT + ASK — naming the change as a whole (PR, diff, branch, the
 *               changes) TOGETHER with a review-ish verb. Either alone is
 *               fine: "does this change the semantics?" names no artifact in
 *               the whole sense, and "we reviewed the retry path" asks for
 *               nothing.
 *
 * It will never be complete — natural language is not a closed set — which is
 * exactly why it is the belt and not the braces.
 */
const BREADTH_RE =
  /\b(?:whole|entire|everything|overall|in general|as a whole|top to bottom|end[- ]to[- ]end|full review|at all|all of (?:it|this|them|these)|it all|(?:second|another|extra|fresh) (?:pair|set) of eyes|review it|look at it)\b/i;

const WHOLE_ARTIFACT_RE =
  /\b(?:pull\s*requests?|prs?|mrs?|merge\s*requests?|diffs?|branch|change\s?sets?|changes|patch|submission|the code here)\b/i;

const REVIEW_ASK_RE =
  /\b(?:review(?:ed|ing|s)?|look(?:ed|ing)?\s+(?:at|over|through)|read(?:ing)?\s+(?:through|over)|check(?:ing|s)?\s+(?:over|through)|cast\s+(?:an?\s+)?eye|eyes?|glance|skim|scan|go(?:ing)?\s+through|sign(?:ing|s)?\s+off|approv(?:e|al|ing)|happy\s+with|comfortable\s+with|opinion\s+on|thoughts\s+on|merged?|ship(?:s|ped|ping)?|bless)\b/i;

/**
 * Does this text ask for a review of the change rather than a look at one
 * thing? Applied to BOTH free-text slots — `question` and a `decision` name.
 */
export function asksForWholeReview(text: string): boolean {
  if (BREADTH_RE.test(text)) return true;
  return WHOLE_ARTIFACT_RE.test(text) && REVIEW_ASK_RE.test(text);
}

/**
 * Turn a candidate — a fired rule's assembly, or whatever a session wrote into
 * its verdict file — into a deliverable request, or refuse it.
 *
 * Every gate invariant 2 and the target bound need lives here, in one
 * function, so there is exactly one place to read and exactly one to test.
 */
export function validateEscalationRequest(
  raw: unknown,
  cfg: EscalationConfig,
  /**
   * The PR's changed files. A `code`/`migration` scope must name one of them:
   * without this check `path: "the entire diff"` and `path: "**"` both passed,
   * which is how a whole-PR escalation was still spellable (review).
   *
   * REQUIRED IN PRACTICE. `deliverEscalations` always passes it, and when the
   * file listing is unavailable it passes `[]` — so every path-bearing scope
   * is refused rather than waved through. Silence beats a whole-PR ask, and
   * that is the same direction every other unreadable fact takes here. The
   * parameter is optional only so `decision`-scoped unit cases and callers
   * with no diff in reach can still validate the rest.
   */
  changedPaths?: readonly string[],
): EscalationValidation {
  if (!cfg.enabled) return { ok: false, refusal: "disabled" };
  if (typeof raw !== "object" || raw === null) return { ok: false, refusal: "no-scope" };
  const r = raw as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

  const target = str(r.target).replace(/^@/, "");
  if (!target) return { ok: false, refusal: "no-target" };
  // THE BOUND. Filtered daemon-side against the operator's list — never asked
  // of the model, never negotiable by the text of a verdict file.
  if (!cfg.targets.includes(target)) return { ok: false, refusal: "target-not-configured" };

  const scope = normalizeScope(r.scope);
  if (!scope) return { ok: false, refusal: "no-scope" };
  // A path must be a REAL file in this PR's diff. Compared exactly against
  // what GitHub returned — no globbing, no prefix match, nothing an invented
  // string could satisfy.
  if (scope.kind !== "decision" && changedPaths !== undefined && !changedPaths.includes(scope.path)) {
    return { ok: false, refusal: "path-not-in-diff" };
  }
  // A decision NAME goes through the same whole-review check as the question:
  // it is the other free-text slot, and it is the one that reads as the
  // headline of the note.
  if (scope.kind === "decision" && asksForWholeReview(scope.decision)) {
    return { ok: false, refusal: "asks-for-whole-review" };
  }

  const question = str(r.question).replace(/\s+/g, " ").slice(0, MAX_ESCALATION_QUESTION);
  if (!question) return { ok: false, refusal: "no-question" };
  if (asksForWholeReview(question)) return { ok: false, refusal: "asks-for-whole-review" };

  const origin: EscalationOrigin = str(r.origin) === "rule" ? "rule" : "session";
  if (origin === "session" && !cfg.session_judgement) return { ok: false, refusal: "session-judgement-off" };

  const why = str(r.why).replace(/\s+/g, " ").slice(0, MAX_ESCALATION_QUESTION);
  const rule = str(r.rule);
  return {
    ok: true,
    request: {
      target,
      scope,
      question,
      why: why || "named by the operator as the person to ask about this",
      origin,
      ...(rule ? { rule } : {}),
    },
  };
}

// ---- the deterministic triggers -------------------------------------------

/** Everything a rule may key on. Every field is what the daemon already knows
 * at the end of a round; nothing here is a model's opinion. */
export interface EscalationFacts {
  /** Repo-relative paths the PR touches. Empty ⇒ path rules cannot fire. */
  changed_paths: readonly string[];
  /** Labels on the PR. Empty ⇒ label rules cannot fire. */
  labels: readonly string[];
  /** Findings the round POSTED, with the severity each went out at. */
  findings: readonly { severity: string; path?: string | null; title?: string | null }[];
  /** Names of checks whose LATEST run at the head is not green. */
  failing_checks: readonly string[];
}

export const NO_FACTS: EscalationFacts = { changed_paths: [], labels: [], findings: [], failing_checks: [] };

const SEVERITY_ORDER: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3, NIT: 4 };

/** Is `severity` at or above `floor`? Unknown spellings never satisfy a floor
 * — a rule must not fire on a severity nobody can read. */
export function severityAtLeast(severity: string, floor: EscalationSeverityFloor): boolean {
  const s = SEVERITY_ORDER[severity.trim().toUpperCase()];
  return s !== undefined && s <= SEVERITY_ORDER[floor]!;
}

/**
 * Glob match, deliberately small: `*` matches within a path segment, `**`
 * across segments, everything else is literal. No dependency, and the whole
 * grammar fits in the config comment an operator reads.
 */
export function pathMatches(pattern: string, path: string): boolean {
  const rx = pattern
    .split(/(\*\*\/|\*\*|\*|\?)/)
    .map((part) => {
      if (part === "**/") return "(?:.*/)?";
      if (part === "**") return ".*";
      if (part === "*") return "[^/]*";
      if (part === "?") return "[^/]";
      return part.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${rx}$`).test(path);
}

/** Did this rule's conditions all hold? A rule with no condition never fires
 * (config validation refuses one, so this is belt). */
export function ruleFires(rule: EscalationRule, facts: EscalationFacts): boolean {
  let declared = 0;
  if (rule.paths.length > 0) {
    declared++;
    if (!facts.changed_paths.some((p) => rule.paths.some((pat) => pathMatches(pat, p)))) return false;
  }
  if (rule.labels.length > 0) {
    declared++;
    const have = new Set(facts.labels.map((l) => l.toLowerCase()));
    if (!rule.labels.some((l) => have.has(l.toLowerCase()))) return false;
  }
  if (rule.failing_checks.length > 0) {
    declared++;
    const failing = new Set(facts.failing_checks.map((c) => c.toLowerCase()));
    if (!rule.failing_checks.some((c) => failing.has(c.toLowerCase()))) return false;
  }
  if (rule.min_severity) {
    declared++;
    if (!facts.findings.some((f) => severityAtLeast(String(f.severity ?? ""), rule.min_severity as EscalationSeverityFloor))) {
      return false;
    }
  }
  return declared > 0;
}

/**
 * The scope a fired rule points at. A rule names a CLASS of thing, so the
 * scope is derived from the fact that actually matched — the touched file, the
 * finding's anchor, the failing check — never "the PR".
 */
export function scopeForRule(rule: EscalationRule, facts: EscalationFacts): EscalationScope | null {
  if (rule.paths.length > 0) {
    const hit = facts.changed_paths.find((p) => rule.paths.some((pat) => pathMatches(pat, p)));
    if (hit) return /(^|\/)migrations?\//i.test(hit) ? { kind: "migration", path: hit } : { kind: "code", path: hit };
  }
  if (rule.min_severity) {
    const hit = facts.findings.find((f) => severityAtLeast(String(f.severity ?? ""), rule.min_severity as EscalationSeverityFloor));
    if (hit?.path) return { kind: "code", path: hit.path };
    if (hit?.title) return { kind: "decision", decision: hit.title.slice(0, 120) };
  }
  if (rule.failing_checks.length > 0) {
    const hit = facts.failing_checks.find((c) => rule.failing_checks.some((n) => n.toLowerCase() === c.toLowerCase()));
    if (hit) return { kind: "decision", decision: `the failing check "${hit}"` };
  }
  if (rule.labels.length > 0) {
    const hit = facts.labels.find((l) => rule.labels.some((n) => n.toLowerCase() === l.toLowerCase()));
    if (hit) return { kind: "decision", decision: `what the "${hit}" label is asking for here` };
  }
  return null;
}

/** The question a fired rule asks. Narrow by construction — it names the
 * scope and the rule, and asks for a judgement on that one thing. The wording
 * deliberately avoids every whole-artifact noun, so a rule-built question can
 * never trip its own `asksForWholeReview` check. */
export function questionForRule(rule: EscalationRule, scope: EscalationScope): string {
  return `Your rule "${rule.name}" fires here. Is ${renderScope(scope)} right, in your judgement?`;
}

/**
 * Evaluate the operator's rules. Pure: same facts in, same escalations out,
 * no I/O, no model. This is the function `tests/escalation.test.ts` drives to
 * prove the deterministic half is inspectable without an LLM.
 */
export function evaluateEscalationRules(cfg: EscalationConfig, facts: EscalationFacts): EscalationRequest[] {
  if (!cfg.enabled) return [];
  const out: EscalationRequest[] = [];
  for (const rule of cfg.rules) {
    if (!ruleFires(rule, facts)) continue;
    const scope = scopeForRule(rule, facts);
    if (!scope) continue; // nothing concrete to point at ⇒ no escalation (invariant 2)
    const candidate = {
      target: rule.to,
      scope,
      question: questionForRule(rule, scope),
      why: rule.why,
      origin: "rule" as const,
      rule: rule.name,
    };
    // Validated against the SAME facts the scope came from — so a rule firing
    // on a finding anchored outside the diff is refused here rather than
    // pointing a person at a file this PR does not touch.
    const v = validateEscalationRequest(candidate, cfg, facts.changed_paths);
    if (v.ok) out.push(v.request);
  }
  return out;
}

// ---- the rendered note ----------------------------------------------------

/** The marker every escalation comment opens with — one grammar, greppable,
 * and never confusable with the three finding markers in `src/severity.ts`. */
export const ESCALATION_TAG = "[one thing to look at]";

export interface EscalationRenderContext {
  /** The verdict the round already reached, on the merits. Stated in the note
   * so the recipient can see the review is DONE — read, never consulted. */
  verdict: string;
  /** Round number, for the "already posted" sentence. */
  round_no?: number;
  /** True when the review-request shape is also being used, so the note can
   * say what GitHub's queue entry does and does not mean. */
  review_requested?: boolean;
  /**
   * Did the ROUND'S OWN review actually reach GitHub? From the
   * posting receipt, not inferred.
   *
   * This matters more here than anywhere else (review): the escalation
   * note is the one posting exempt from guard 2, so the case where the round's
   * own review was refused is exactly the case where this note still goes out.
   * Telling a named human "the review is posted" when it is not would send
   * them looking for something that is not there. Unknown (`undefined`) is
   * treated as not-confirmed: the note says DECIDED, which the daemon knows,
   * and claims nothing about GitHub.
   */
  review_posted?: boolean;
}

/**
 * The escalation body. Composed from the scope — the only free-text slots are
 * `question` and `why`, both validated and capped. There is no code path by
 * which this renders "please review this PR".
 */
export function renderEscalationComment(req: EscalationRequest, ctx: EscalationRenderContext): string {
  const round = ctx.round_no ? ` (round ${ctx.round_no})` : "";
  const lines = [
    `${ESCALATION_TAG} @${req.target} — one specific thing, not a review of this pull request.`,
    "",
    `**Look at:** ${renderScope(req.scope)}`,
    `**Why you:** ${req.why}`,
    `**The question:** ${req.question}`,
    "",
    ctx.review_posted
      ? `This review is already decided and posted${round} — the verdict is **${ctx.verdict}** and it does not `
        + "wait on you. This note asks only for your eyes on the item above."
      : `This review is already decided${round} — the verdict is **${ctx.verdict}** and it does not wait on you. `
        + "This note asks only for your eyes on the item above. (The review itself is not confirmed on this pull "
        + "request yet; if you cannot find it, that is why, and it is not something you need to chase.)",
  ];
  if (ctx.review_requested) {
    lines.push(
      "",
      "_You will also see this pull request in your review-requested queue: that is how the "
        + "notification is delivered, and GitHub words it as \"review this pull request\". It is not what is "
        + "being asked. The item above is._",
    );
  }
  if (req.origin === "rule" && req.rule) {
    lines.push("", `_Escalated by the configured rule \`${req.rule}\`._`);
  }
  return lines.join("\n");
}

// ---- the prompt-side half -------------------------------------------------

/**
 * The targets a round order carries, or none.
 *
 * A round order gets this list ONLY when the feature is enabled AND the
 * operator turned session judgement on — so with escalation off (the default)
 * the field is absent, the note below renders `""`, and the round prompt is
 * identical in behaviour to a build without the feature (whitespace aside —
 * see the pin in tests/escalation.test.ts).
 */
export function promptTargetsFor(cfg: EscalationConfig): string[] | undefined {
  if (!cfg.enabled || !cfg.session_judgement || cfg.targets.length === 0) return undefined;
  return [...cfg.targets];
}

/**
 * The round-prompt block, rendered into `{{escalation_note}}` by
 * `src/templates.ts`.
 *
 * The deterministic rules need no prompt at all: the daemon evaluates and
 * delivers them itself. This block exists only so a session that MAY escalate
 * on its own judgement knows the shape, the bound and — above all — that
 * escalating never changes its job.
 */
export function renderEscalationPromptNote(targets: readonly string[] | undefined): string {
  if (!targets || targets.length === 0) return "";
  return [
    "ESCALATION (optional, and it never changes your job).",
    "",
    "You always decide this PR on the merits and post the review — escalation is a note that goes",
    "out BESIDE your verdict, never instead of it, and never a reason to withhold or defer one.",
    "",
    "If one specific thing in this change genuinely needs a named person's eyes, add an",
    "`escalations` array to your verdict file. Each entry:",
    "",
    "```json",
    '{ "target": "<one of the logins below>",',
    '  "scope": { "kind": "code", "path": "<repo-relative file>", "start_line": 12, "end_line": 30 },',
    '  "question": "<one or two sentences about THAT code>",',
    '  "why": "<why this person>" }',
    "```",
    "",
    `Targets you may name (any other login is dropped by the daemon): ${targets.map((t) => `@${t}`).join(", ")}`,
    "",
    "`scope.kind` is `code` (path plus line range), `migration` (path, optionally the migration",
    "id) or `decision` (a named decision). There is no way to escalate \"the PR\" and you must not",
    "try: an entry with no concrete scope, or a question that asks someone to review the change,",
    "is dropped. Think of it exactly as a `[check this]` item with a name on it — the smallest",
    "thing that actually needs a person, phrased so they can answer it in minutes.",
    "",
    "Escalating is rare. Omitting the array entirely is the normal outcome.",
  ].join("\n");
}

/**
 * Pull the `escalations` array out of a verdict file, tolerantly.
 *
 * Deliberately total: anything unreadable comes back as `[]` with a note.
 * A malformed escalation must never fail a verdict — that would be invariant 1
 * lost at the parser.
 */
export function normalizeSessionEscalations(raw: unknown): { entries: unknown[]; note?: string } {
  if (raw === undefined || raw === null) return { entries: [] };
  if (!Array.isArray(raw)) return { entries: [], note: "escalations was not an array — ignored" };
  const entries = raw.filter((e) => typeof e === "object" && e !== null).slice(0, 10);
  const note = entries.length === raw.length ? undefined : `${raw.length - entries.length} escalation entr(ies) were not objects — ignored`;
  return { entries, ...(note ? { note } : {}) };
}

// ---- delivery -------------------------------------------------------------

/** The write half of the adapter, both calls gated. Optional methods mean an
 * adapter that cannot do a shape simply does not do it — never a throw. */
export interface EscalationAdapter {
  createReview(
    pr: number,
    payload: { commit_id: string; event: "COMMENT"; body: string },
    options?: { purpose?: "escalation" | "migration_precheck" },
  ): Promise<GateResult>;
  /** POST /repos/{o}/{r}/pulls/{n}/requested_reviewers — the `request_reviewer`
   * gate kind. Absent on adapters that predate the feature. */
  requestEscalationReview?(pr: number, logins: string[]): Promise<GateResult>;
}

/** The ledger slice: the per-PR cap and the never-twice dedup. */
export interface EscalationStore {
  logEvent(kind: string, pr: number | null, payload?: unknown): void;
  escalationDelivered(pr: number, key: string): boolean;
  escalationCount(pr: number): number;
  recordEscalation(pr: number, row: { target: string; scope_key: string; shape: string; origin: string; rule: string | null; round_no: number | null }): void;
}

export interface EscalationDeps {
  cfg: EscalationConfig;
  store: EscalationStore;
  adapter: EscalationAdapter;
  log?: (msg: string, extra?: unknown) => void;
}

export interface EscalationOutcome {
  target: string;
  scope_key: string;
  origin: EscalationOrigin;
  /** null ⇒ delivered; otherwise why it was not. */
  refused: EscalationRefusal | null;
  /** Did the comment actually reach GitHub (false in dry-run — the gate
   * recorded it instead, exactly like every other suppressed mutation). */
  comment_executed: boolean;
  /** Did the review request reach GitHub? Absent on the comment shape. */
  review_requested?: boolean;
}

/**
 * Deliver escalations for one round.
 *
 * NOTE THE RETURN TYPE. `EscalationOutcome[]` carries no verdict and no
 * "should the review wait" signal, because there is nothing this function may
 * say about the verdict — that is invariant 1 expressed as a type. The caller
 * has already applied the verdict before this runs.
 */
export async function deliverEscalations(
  deps: EscalationDeps,
  args: {
    pr: number;
    /** The verdict the round decided. INPUT ONLY — quoted into the note so the
     * recipient knows the review is finished. Never read to decide anything. */
    verdict: string;
    /** The head the round reviewed. The comment is anchored to it, so posting
     * guard 5 refuses a stale escalation exactly as it refuses a stale review
     * — and, because nothing is recorded on a refusal, a later round retries. */
    head_sha: string;
    round_no?: number;
    /** The PR's changed files, for the path-in-diff check. Pass `[]` when the
     * listing could not be read: every path-bearing scope is then refused,
     * which is the safe direction. */
    changed_paths?: readonly string[];
    /** Did the round's own review reach GitHub (receipt)? Rendered
     * into the note; see `EscalationRenderContext.review_posted`. */
    review_posted?: boolean;
    /** Candidates: fired rules and/or session-declared entries, unvalidated. */
    candidates: readonly unknown[];
  },
): Promise<EscalationOutcome[]> {
  const log = deps.log ?? (() => {});
  const { cfg, store, adapter } = deps;
  const outcomes: EscalationOutcome[] = [];
  if (!cfg.enabled || !args.head_sha) return outcomes;

  for (const raw of args.candidates) {
    const v = validateEscalationRequest(raw, cfg, args.changed_paths ?? []);
    if (!v.ok) {
      store.logEvent("escalation_refused", args.pr, { reason: v.refusal, round_no: args.round_no ?? null, candidate: raw });
      log(`escalation: #${args.pr} refused — ${v.refusal}`);
      outcomes.push({ target: "", scope_key: "", origin: "session", refused: v.refusal, comment_executed: false });
      continue;
    }
    const req = v.request;
    const key = scopeKey(req.scope);
    if (store.escalationDelivered(args.pr, `${req.target}|${key}`)) {
      outcomes.push({ target: req.target, scope_key: key, origin: req.origin, refused: "already-delivered", comment_executed: false });
      continue;
    }
    if (store.escalationCount(args.pr) >= cfg.max_per_pr) {
      store.logEvent("escalation_capped", args.pr, { target: req.target, scope_key: key, max_per_pr: cfg.max_per_pr });
      outcomes.push({ target: req.target, scope_key: key, origin: req.origin, refused: "capped", comment_executed: false });
      continue;
    }

    const wantsRequest = cfg.shape === "review_request";
    const body = renderEscalationComment(req, {
      verdict: args.verdict,
      ...(args.round_no !== undefined ? { round_no: args.round_no } : {}),
      review_requested: wantsRequest,
      ...(args.review_posted !== undefined ? { review_posted: args.review_posted } : {}),
    });
    const result = await adapter.createReview(
      args.pr,
      { commit_id: args.head_sha, event: "COMMENT", body },
      { purpose: "escalation" },
    );
    if (result.blocked) {
      // A posting guard refused (merged, closed, head drift). Nothing was
      // delivered and nothing is recorded, so a later round may try again.
      store.logEvent("escalation_blocked", args.pr, { target: req.target, scope_key: key, reason: result.blocked });
      outcomes.push({ target: req.target, scope_key: key, origin: req.origin, refused: null, comment_executed: false });
      continue;
    }

    // The review request rides ONLY behind a delivered comment: GitHub's queue
    // entry says "review this pull request", and the narrow ask must already
    // be on the PR before that framing reaches anyone.
    let requested = false;
    if (wantsRequest && adapter.requestEscalationReview) {
      const rr = await adapter.requestEscalationReview(args.pr, [req.target]);
      requested = rr.executed;
    }

    // ---- THE LEDGER RECORDS DELIVERIES, NOT ATTEMPTS (review) ------
    //
    // In dry-run the gate returns `{executed: false, dryRunFile}` with NO
    // `blocked`, so this point is reached having written a file and touched
    // nothing on GitHub. Recording that would have been a disaster of exactly
    // the shape the docs walk a new operator into: enable escalation, run the
    // documented dry-run bring-up, and `escalations_once` permanently owns
    // those (pr, target, scope_key) pairs — so when they go live the real
    // escalation comes back `already-delivered`, or `capped`, forever, fixable
    // only by hand-editing SQLite.
    //
    // So the ledger is keyed on what REACHED GITHUB, the same `result.executed`
    // test `guards.ts after()` uses before it stamps a reviewed head. A dry-run
    // escalation writes its intent to state/dryrun/ every round — which is what
    // dry-run is for — and consumes neither the dedup key nor the cap.
    if (!result.executed) {
      store.logEvent("escalation_not_executed", args.pr, {
        target: req.target,
        scope_key: key,
        shape: cfg.shape,
        origin: req.origin,
        round_no: args.round_no ?? null,
        dry_run_file: result.dryRunFile ?? null,
      });
      log(`escalation: #${args.pr} → @${req.target} recorded as an INTENT only (not executed) — nothing consumed`);
      outcomes.push({
        target: req.target,
        scope_key: key,
        origin: req.origin,
        refused: null,
        comment_executed: false,
        ...(wantsRequest ? { review_requested: requested } : {}),
      });
      continue;
    }

    store.recordEscalation(args.pr, {
      target: req.target,
      scope_key: key,
      shape: cfg.shape,
      origin: req.origin,
      rule: req.rule ?? null,
      round_no: args.round_no ?? null,
    });
    store.logEvent("escalation_delivered", args.pr, {
      target: req.target,
      scope_key: key,
      shape: cfg.shape,
      origin: req.origin,
      rule: req.rule ?? null,
      round_no: args.round_no ?? null,
      comment_executed: true,
      review_requested: requested,
    });
    log(`escalation: #${args.pr} → @${req.target} (${key}, ${cfg.shape}, ${req.origin})`);
    outcomes.push({
      target: req.target,
      scope_key: key,
      origin: req.origin,
      refused: null,
      comment_executed: true,
      ...(wantsRequest ? { review_requested: requested } : {}),
    });
  }
  return outcomes;
}
