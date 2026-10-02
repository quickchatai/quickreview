// Posting helpers — the review payload the PR session hands to the daemon.
//
// Everything here is pure assembly plus one gated submit. The ported summary
// format is preserved: verdict line → lenses line → severity sections → the
// "Start here" handoff guide on NEEDS_HUMAN → footer. Inline comments are anchor-
// validated (src/anchors.ts) and capped at 50; anything stripped or overflowing
// is appended to the body rather than dropped, and rather than failing the
// whole call.
//
// There is deliberately no path here that retracts a posted review — the
// never-retract invariant is structural (see src/gate.ts).
import type { GitHubAdapter } from "./github.js";
import type { GateResult } from "./gate.js";
import type { StateStore } from "./state.js";
import {
  firstSentence,
  isDefaultPosting,
  selectPosted,
  siteKey,
  type PolicyClass,
  type PostingPolicy,
  type WithholdWord,
} from "./postingpolicy.js";
import {
  checkAnchor,
  partitionByAnchor,
  runsByPath,
  ANCHOR_REASON_TEXT,
  type AnchorRequest,
  type Side,
} from "./anchors.js";
import {
  ASK_HUMAN_TAG,
  DEFERRED_TAG,
  isAskHumanFinding,
  isDeferredFinding,
  isFirstPartyDirectiveInjection,
  postTag,
  stripUngrammaticalTag,
  type PostTag,
  type Reachability,
  type Severity,
  type Verdict,
} from "./severity.js";

/** GitHub caps a single review at 50 inline comments (ported constraint). */
export const INLINE_COMMENT_CAP = 50;

/** The review-body footer, naming the configured bot identity (:
 * `[github] bot_login` — never a hardcoded login). "" degrades to the role. */
export function reviewFooter(botLogin?: string): string {
  return (
    `_Automated review by \`${botLogin?.trim() || "the review bot"}\` (quickreview sandbox). ` +
    "Reply to any comment to discuss; ask for a human reviewer if you want this escalated._"
  );
}

export interface Finding {
  severity: Severity;
  confidence: number;
  /** How often the triggering state arises. Absent ⇒ `routine`. */
  reachability?: Reachability;
  /** The pass's finding class (e.g. "injection"). Absent ⇒ no
   * kind-keyed gate applies. */
  kind?: string;
  path: string;
  /** Anchor end line (GitHub `line`). Absent ⇒ unanchorable ⇒ body-only. */
  line?: number;
  start_line?: number;
  side?: Side;
  title: string;
  body: string;
  lens: string;
}

export interface ReviewInput {
  pr: number;
  head_sha: string;
  verdict: Verdict;
  findings: Finding[];
  lenses: string[];
  /** Unified patch text per file (PR files API `patch`) — anchor validation. */
  patches?: Record<string, string>;
  /** Why the session could not decide — rendered under "Start here". */
  needs_human_reasons?: string[];
  /** AI_APPROVED soundness marker, rendered on NEEDS_HUMAN. */
  ai_approved?: boolean;
  /**
   * Prior findings still open and unchanged at this head (re-review).
   *
   * these are POINTED AT, never restated. 14.2% of the corpus's
   * findings were bookkeeping about the reviewer's own earlier findings —
   * output spent narrating itself, in a body the author pays to read, while
   * `state/ledgers/pr-<n>.md` already carries exactly that round-to-round state
   * and each of those findings already has a live thread carrying its full
   * reasoning. So the body renders ONE line saying how many are still open and
   * where they live. Nothing is dropped and no reasoning is lost: the original
   * threads are untouched, and a finding whose severity or evidence CHANGED is
   * not this — it is a new finding and posts as one.
   */
  carried_over?: string[];
  /**
   * the deterministically-picked teammate to @-mention in the ONE
   * escalation comment a first-party-directive review carries (dispatch picks
   * it: most recent human author of the touched directive files, falling back
   * to config `[review] escalation_mention_default`). Rendered only when the
   * findings actually contain a first-party directive injection.
   */
  escalation_mention?: string;
  /**
   * the configured `[github] bot_login`, rendered into the review
   * footer. Absent ⇒ the footer names the role ("the review bot") — never a
   * hardcoded personal login.
   */
  bot_login?: string;
  /**
   * The profile's `[posting]` policy (src/postingpolicy.ts). Absent or
   * all-default => today's assembly, byte for byte. Otherwise the findings are
   * cut to the policy BEFORE anchoring (blockers never) and what is cut is
   * returned as `withheld` for the findings record, never dropped silently.
   */
  policy?: PostingPolicy;
  /** The plain opening paragraph (the verdict `summary`): its first sentence
   * is the one sentence a `body = "verdict"` review carries. */
  summary?: string;
}

/** The first-party directive paths this review's surviving injection findings
 * sit on, in finding order, deduplicated. means these are proven
 * malicious/source-to-sink cases, not routine directive prose. */
export function directiveEscalationFiles(
  findings: readonly Finding[],
  vocab?: import("./severity.js").DirectiveVocabulary,
): string[] {
  const files: string[] = [];
  for (const f of findings) {
    if (isFirstPartyDirectiveInjection(f.kind, f.path, vocab) && !files.includes(f.path))
      files.push(f.path);
  }
  return files;
}

/**
 * The ONE escalation comment: max three sentences, an explicit
 * @-mention, and the named files containing the proved injection. One comment
 * total, however many directive files the PR touches. It is a comment inside
 * the gated review — never a GitHub reviewer nomination (`request_reviewer`
 * stays a rejected non-kind; CLAUDE.md rule 10).
 */
export function renderDirectiveEscalationComment(
  mention: string,
  files: readonly string[],
): string {
  const at = mention ? `@${mention.replace(/^@/, "")}` : "a maintainer";
  const list = files.map((f) => `\`${f}\``).join(", ");
  const part =
    files.length === 1 ? `the agent-directive file ${list}` : `the agent-directive files ${list}`;
  return (
    `${at} — this PR edits ${part}, which instructs the team's own automated agents, ` +
    "and the review found a concrete malicious or untrusted-source injection path there. " +
    "Please inspect that security finding before merge; its ordinary severity and verdict remain in force."
  );
}

export interface InlineComment extends AnchorRequest {
  path: string;
  line: number;
  side: Side;
  body: string;
}

export interface ReviewPayload {
  commit_id: string;
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  body: string;
  comments: InlineComment[];
}

export interface AssembledReview {
  pr: number;
  payload: ReviewPayload;
  /** Findings that ended up in the body instead of inline, with the reason. */
  overflow: Array<{ finding: Finding; reason: string }>;
  tags: Map<Finding, PostTag>;
  /** Titles that arrived with a tag outside the closed grammar.
   * Stripped from the payload, kept here so the escape is countable. */
  ungrammatical: Array<{ finding: Finding; tag: string }>;
  /** Findings the posting policy kept off the PR, each with its word,
   * recorded `withheld` in the findings record. Empty without a policy. */
  withheld: Array<{ finding: Finding; word: WithholdWord }>;
}

export function eventForVerdict(v: Verdict): ReviewPayload["event"] {
  // NEEDS_HUMAN posts the complete review as a COMMENT — the merge decision is
  // the human's (ported).
  return v === "APPROVE" ? "APPROVE" : v === "REQUEST_CHANGES" ? "REQUEST_CHANGES" : "COMMENT";
}

function verdictLine(v: Verdict, counts: Record<PostTag, number>): string {
  const label =
    v === "APPROVE" ? "Approved" : v === "REQUEST_CHANGES" ? "Changes requested" : "Needs a human";
  const parts: string[] = [];
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (counts.blocker) parts.push(plural(counts.blocker, "blocker"));
  if (counts.nit) parts.push(plural(counts.nit, "nit"));
  if (counts.question) parts.push(plural(counts.question, "question"));
  return `**Verdict: ${label}** — ${parts.length ? parts.join(", ") : "no findings"}.`;
}

/**
 * The one line that replaces the old "Previously deferred, unchanged" section
 *. It states the fact and names where the reasoning lives; it never
 * repeats a title, a severity or a rationale, because all three are already on
 * the thread the reader can click.
 */
export function carriedOverLine(count: number): string {
  return (
    `_${count} finding${count === 1 ? "" : "s"} from earlier rounds ${count === 1 ? "is" : "are"} still open on ` +
    "their existing threads; nothing about them has changed this round._"
  );
}

function ref(f: Finding): string {
  return f.line ? `\`${f.path}:${f.line}\`` : `\`${f.path}\``;
}

function bullet(f: Finding): string {
  return `- ${ref(f)} — ${stripUngrammaticalTag(f.title).title} _(${f.severity}/${f.confidence.toFixed(2)}, ${f.lens})_`;
}

/**
 * Findings whose title arrived wearing a tag outside the closed grammar
 *. The tag is stripped before posting — an invented tag is a finding
 * that escapes the machinery keyed on the real one — and reported here so the
 * escape is countable rather than silent.
 */
export function ungrammaticalTags(
  findings: readonly Finding[],
): Array<{ finding: Finding; tag: string }> {
  const out: Array<{ finding: Finding; tag: string }> = [];
  for (const f of findings) {
    const { stripped } = stripUngrammaticalTag(f.title);
    if (stripped) out.push({ finding: f, tag: stripped });
  }
  return out;
}

export function inlineBody(f: Finding, tag: PostTag): string {
  // an ask-your-human question leads with its own marker, BEFORE the
  // ordinary posting tag — the first line is a routing instruction to the PR
  // author's AI implementer ("put this to a person, do not answer it
  // yourself"), and the reviewed repo's directives key on it appearing there.
  // The severity tag stays on the same line so a blocking question still reads
  // as a blocker. It is never `[check this]`, whose meaning is unchanged.
  // a deferral leads with `[deferred]` — the finding is real and this
  // PR is not where it gets fixed. It is a THIRD marker, never a spelling of
  // either other one, and exactly one marker ever rides a comment: when a
  // question is being deferred, the deferral is the outer state and the one
  // that says what happens next.
  const deferred = isDeferredFinding(f.kind);
  const askHuman = !deferred && isAskHumanFinding(f.kind, f.lens);
  const marker = deferred ? `${DEFERRED_TAG} ` : askHuman ? `${ASK_HUMAN_TAG} ` : "";
  // the tag grammar is closed. A title that arrived carrying its own
  // bracketed tag loses it here — a duplicate of the one about to be minted, or
  // an invented one that would escape every consumer keyed on the real grammar.
  // Only the label goes; the finding's words are untouched.
  const title = stripUngrammaticalTag(f.title).title;
  const head = `${marker}[${tag}] ${title}`;
  // Reachability is shown only when it is not `routine` — that is exactly when
  // it explains a tag the severity alone would not have produced.
  const reach = f.reachability && f.reachability !== "routine" ? ` · ${f.reachability}` : "";
  const tail = `_${f.severity} · confidence ${f.confidence.toFixed(2)}${reach} · lens ${f.lens}_`;
  return `${head}\n\n${f.body}\n\n${tail}`;
}

/** Assemble the full review POST payload from a round's surviving findings. */
export function assembleReview(full: ReviewInput): AssembledReview {
  const tags = new Map<Finding, PostTag>();
  for (const f of full.findings)
    tags.set(f, postTag(f.severity, f.confidence, f.reachability, { kind: f.kind, path: f.path }));

  // 0. the profile's posting policy: the budget, the tag rules and one site
  //    per finding, over the findings in the order the session ranked them.
  //    A no-op (the same input) without a policy. Within one severity the
  //    budget prefers a finding on a changed line (`changedLine`).
  const runs = full.policy && full.patches ? runsByPath(full.patches) : undefined;
  const selection = selectPosted(
    full.findings,
    (f) => ({
      cls: tags.get(f) as PolicyClass,
      severity: f.severity,
      key: siteKey(stripUngrammaticalTag(f.title).title),
      ...(runs && f.line !== undefined
        ? {
            changedLine: checkAnchor(runs, {
              path: f.path,
              side: f.side ?? "RIGHT",
              line: f.line,
              ...(f.start_line !== undefined ? { start_line: f.start_line } : {}),
            }).ok,
          }
        : {}),
    }),
    full.policy,
  );
  const input: ReviewInput =
    selection.withheld.length > 0 ? { ...full, findings: selection.kept } : full;

  // 1. anchorable candidates vs. findings with no anchor at all
  const overflow: AssembledReview["overflow"] = [];
  const candidates: Finding[] = [];
  for (const f of input.findings) {
    if (f.line === undefined || f.side === undefined)
      overflow.push({ finding: f, reason: "no anchor claimed" });
    else candidates.push(f);
  }

  // 2. anchor validation — invalid comments are stripped into the body
  let anchored = candidates;
  if (input.patches) {
    const requests = candidates.map((f) => ({
      path: f.path,
      side: f.side as Side,
      line: f.line as number,
      ...(f.start_line !== undefined ? { start_line: f.start_line } : {}),
      finding: f,
    }));
    const { accepted, rejected } = partitionByAnchor(requests, input.patches);
    anchored = accepted.map((r) => r.finding);
    for (const r of rejected)
      overflow.push({ finding: r.comment.finding, reason: ANCHOR_REASON_TEXT[r.reason] });
  }

  // 3. the 50-inline cap; the remainder overflows to the body
  const inline = anchored.slice(0, INLINE_COMMENT_CAP);
  for (const f of anchored.slice(INLINE_COMMENT_CAP)) {
    overflow.push({ finding: f, reason: `over the ${INLINE_COMMENT_CAP}-inline-comment cap` });
  }

  const comments: InlineComment[] = inline.map((f) => ({
    path: f.path,
    line: f.line as number,
    side: f.side as Side,
    ...(f.start_line !== undefined ? { start_line: f.start_line } : {}),
    body: inlineBody(f, tags.get(f) as PostTag),
  }));

  return {
    pr: input.pr,
    payload: {
      commit_id: input.head_sha,
      event: eventForVerdict(input.verdict),
      body: renderBody(input, tags, overflow),
      comments,
    },
    overflow,
    tags,
    ungrammatical: ungrammaticalTags(input.findings),
    withheld: selection.withheld.map(({ item, word }) => ({ finding: item, word })),
  };
}

export function renderBody(
  input: ReviewInput,
  tags: Map<Finding, PostTag>,
  overflow: AssembledReview["overflow"],
): string {
  const counts: Record<PostTag, number> = { blocker: 0, question: 0, nit: 0 };
  for (const f of input.findings)
    counts[
      tags.get(f) ??
        postTag(f.severity, f.confidence, f.reachability, { kind: f.kind, path: f.path })
    ] += 1;

  const of = (tag: PostTag) => input.findings.filter((f) => tags.get(f) === tag);
  // `[posting] body = "verdict"`: the verdict line and one sentence. A kept
  // finding with no inline anchor is the one exception (one bullet line, so
  // a posted finding is never invisible), and the security-attention
  // comment stays, because that one is not optional.
  if (input.policy && !isDefaultPosting(input.policy) && input.policy.body === "verdict") {
    const short: string[] = [verdictLine(input.verdict, counts)];
    const sentence = firstSentence(input.summary ?? "");
    if (sentence) short.push("", sentence);
    if (overflow.length)
      short.push(
        "",
        ...overflow.map(
          ({ finding }) => `- ${ref(finding)} — ${stripUngrammaticalTag(finding.title).title}`,
        ),
      );
    const files = directiveEscalationFiles(input.findings);
    if (files.length > 0)
      short.push("", renderDirectiveEscalationComment(input.escalation_mention ?? "", files));
    short.push("", reviewFooter(input.bot_login));
    return short.join("\n");
  }
  const out: string[] = [
    verdictLine(input.verdict, counts),
    "",
    `_Lenses applied: ${input.lenses.join(", ")}._`,
  ];

  const section = (title: string, items: string[]) => {
    if (items.length === 0) return;
    out.push("", `### ${title}`, "", ...items);
  };
  section("Blockers", of("blocker").map(bullet));
  section("Nits", of("nit").map(bullet));
  section("Questions", of("question").map(bullet));

  // a POINTER, not a restatement — see ReviewInput.carried_over.
  if (input.carried_over?.length) {
    out.push("", carriedOverLine(input.carried_over.length));
  }

  if (overflow.length) {
    section(
      "Additional findings (not posted inline)",
      overflow.map(
        ({ finding, reason }) => `- ${bullet(finding).slice(2)} — _${reason}_\n\n  ${finding.body}`,
      ),
    );
  }

  // EXACTLY ONE security-attention comment per review carrying a
  // surviving first-party directive injection — rendered once here, however
  // many files it touches. It never softens the ordinary merits verdict.
  const directiveFiles = directiveEscalationFiles(input.findings);
  if (directiveFiles.length > 0) {
    section("Security attention — agent-directive injection", [
      renderDirectiveEscalationComment(input.escalation_mention ?? "", directiveFiles),
    ]);
  }

  if (input.verdict === "NEEDS_HUMAN") {
    const start: string[] = [];
    start.push(
      `The automated review could not decide this one, so it is parked for a person${
        input.ai_approved === undefined
          ? ""
          : input.ai_approved
            ? " (it found the PR otherwise sound: AI_APPROVED)"
            : " (it is not confident the PR is sound)"
      }.`,
      "",
      "**Why:**",
      ...(input.needs_human_reasons?.length
        ? input.needs_human_reasons.map((r) => `- ${r}`)
        : ["- reviewer judgment: not confident enough to decide alone"]),
      "",
      "**Validate before merging:**",
    );
    const top = of("blocker").concat(of("question")).slice(0, 5);
    start.push(
      ...(top.length
        ? top.map((f) => `- ${ref(f)} — ${f.title}`)
        : ["- the reasons above; the automated review found nothing blocking"]),
    );
    section("Start here", start);
  }

  out.push("", reviewFooter(input.bot_login));
  return out.join("\n");
}

// ---- the gated submit ----------------------------------------------------

export interface SubmitDeps {
  adapter: Pick<GitHubAdapter, "createReview">;
  store: Pick<StateStore, "registerBotComment" | "logEvent">;
}

export interface SubmitResult {
  result: GateResult;
  payload: ReviewPayload;
  /** Comment ids registered into the bot registry from the POST response. */
  registered: number[];
  /**
   * True when no ids could be registered from the response (dry-run, or a
   * response without a comments array) — the reconcile poll backfills the
   * registry via listBotReviewComments.
   */
  needs_backfill: boolean;
}

/**
 * Post one review through the gate and register every posted comment id in the
 * bot-comment registry (author-reply detection depends on it).
 * In dry-run nothing is posted and no ids exist — the intent is recorded.
 */
export async function submitReview(
  deps: SubmitDeps,
  review: AssembledReview,
  /** Round this review belongs to — linked onto every registered comment so
   * review depth (comments per round) is measurable. */
  roundNo?: number | null,
): Promise<SubmitResult> {
  const { pr, payload } = review;
  // an invented tag never reaches GitHub (it was stripped at assembly)
  // but it must never vanish silently either — the whole defect is a finding
  // that escapes its own machinery unnoticed.
  if (review.ungrammatical.length > 0) {
    deps.store.logEvent("review_tag_outside_grammar", pr, {
      count: review.ungrammatical.length,
      tags: review.ungrammatical.map((u) => u.tag),
    });
  }
  const result = await deps.adapter.createReview(pr, payload);
  const registered: number[] = [];

  if (!result.executed) {
    deps.store.logEvent("review_post_intent", pr, {
      event: payload.event,
      inline: payload.comments.length,
      overflow: review.overflow.length,
      dryrun_file: result.dryRunFile ?? null,
    });
    return { result, payload, registered, needs_backfill: true };
  }

  const res = result.response as { id?: number; comments?: Array<{ id?: number }> } | undefined;
  if (typeof res?.id === "number") {
    deps.store.registerBotComment(res.id, pr, "review", roundNo ?? null);
  }
  for (const c of res?.comments ?? []) {
    if (typeof c?.id === "number") {
      deps.store.registerBotComment(c.id, pr, "review_comment", roundNo ?? null);
      registered.push(c.id);
    }
  }
  deps.store.logEvent("review_posted", pr, {
    event: payload.event,
    inline: payload.comments.length,
    registered: registered.length,
  });
  return {
    result,
    payload,
    registered,
    needs_backfill: registered.length < payload.comments.length,
  };
}

// ---- the APPROVE path (scripts/approve-pr.sh semantics) ------------------

export type ApprovalStep = "create_review" | "remove_label" | "delete_team_review_request";

export interface ApprovalAction {
  step: ApprovalStep;
  describe: string;
  run: (
    adapter: Pick<GitHubAdapter, "createReview" | "removeLabel" | "deleteTeamReviewRequest">,
  ) => Promise<GateResult>;
}

export interface ApprovalContext {
  pr: number;
  payload: ReviewPayload;
  /** config.github.trigger_label — the label trigger to consume. */
  trigger_label: string;
}

/**
 * The ordered mutations of `scripts/approve-pr.sh`: post the APPROVE review,
 * then clear *both* triggers (the label and the team review request) so the PR
 * cannot be re-dispatched by a stale trigger. The daemon executes them in
 * order through the one gate; a failure at any step leaves the later steps
 * unexecuted (the reconcile poll re-derives the truth).
 */
export function approvalActions(ctx: ApprovalContext): ApprovalAction[] {
  if (ctx.payload.event !== "APPROVE") {
    throw new Error(`approvalActions called with a ${ctx.payload.event} payload`);
  }
  return [
    {
      step: "create_review",
      describe: `approve #${ctx.pr}`,
      run: (a) => a.createReview(ctx.pr, ctx.payload),
    },
    {
      step: "remove_label",
      describe: `remove "${ctx.trigger_label}" from #${ctx.pr}`,
      run: (a) => a.removeLabel(ctx.pr, ctx.trigger_label),
    },
    {
      step: "delete_team_review_request",
      describe: `clear the team review request on #${ctx.pr}`,
      run: (a) => a.deleteTeamReviewRequest(ctx.pr),
    },
  ];
}
