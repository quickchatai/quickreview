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
import { partitionByAnchor, ANCHOR_REASON_TEXT, type AnchorRequest, type Side } from "./anchors.js";
import { isFirstPartyDirectiveInjection, postTag, type PostTag, type Reachability, type Severity, type Verdict } from "./severity.js";

/** GitHub caps a single review at 50 inline comments (ported constraint). */
export const INLINE_COMMENT_CAP = 50;

export const REVIEW_FOOTER =
  "_Automated review by `example-review[bot]` (quickreview sandbox). " +
  "Reply to any comment to discuss; ask for a human reviewer if you want this escalated._";

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
  /** Prior findings still open and unchanged (re-review sections). */
  deferred?: string[];
  /**
   * the deterministically-picked teammate to @-mention in the ONE
   * escalation comment a first-party-directive review carries (dispatch picks
   * it: most recent human author of the touched directive files, falling back
   * to config `[review] escalation_mention_default`). Rendered only when the
   * findings actually contain a first-party directive injection.
   */
  escalation_mention?: string;
}

/** The first-party directive paths this review's injection findings sit on,
 * in finding order, deduplicated. Non-empty ⇒ the review parks
 * (NEEDS_HUMAN) and carries exactly one escalation comment. */
export function directiveEscalationFiles(findings: readonly Finding[]): string[] {
  const files: string[] = [];
  for (const f of findings) {
    if (isFirstPartyDirectiveInjection(f.kind, f.path) && !files.includes(f.path)) files.push(f.path);
  }
  return files;
}

/**
 * The ONE escalation comment: max three sentences, an explicit
 * @-mention, and the named part needing extra human approval. One comment
 * total, however many directive files the PR touches. It is a comment inside
 * the gated review — never a GitHub reviewer nomination (`request_reviewer`
 * stays a rejected non-kind; CLAUDE.md rule 10).
 */
export function renderDirectiveEscalationComment(mention: string, files: readonly string[]): string {
  const at = mention ? `@${mention.replace(/^@/, "")}` : "a maintainer";
  const list = files.map((f) => `\`${f}\``).join(", ");
  const part = files.length === 1 ? `the agent-directive file ${list}` : `the agent-directive files ${list}`;
  return (
    `${at} — this PR edits ${part}, which instructs the team's own automated agents, ` +
    "so the automated review will not decide it alone. " +
    "Please give that part an explicit human approval (the rest of the review is posted as usual and nothing here blocks the merge)."
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
}

export function eventForVerdict(v: Verdict): ReviewPayload["event"] {
  // NEEDS_HUMAN posts the complete review as a COMMENT — the merge decision is
  // the human's (ported).
  return v === "APPROVE" ? "APPROVE" : v === "REQUEST_CHANGES" ? "REQUEST_CHANGES" : "COMMENT";
}

function verdictLine(v: Verdict, counts: Record<PostTag, number>): string {
  const label = v === "APPROVE" ? "Approved" : v === "REQUEST_CHANGES" ? "Changes requested" : "Needs a human";
  const parts: string[] = [];
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (counts.blocker) parts.push(plural(counts.blocker, "blocker"));
  if (counts.nit) parts.push(plural(counts.nit, "nit"));
  if (counts.question) parts.push(plural(counts.question, "question"));
  return `**Verdict: ${label}** — ${parts.length ? parts.join(", ") : "no findings"}.`;
}

function ref(f: Finding): string {
  return f.line ? `\`${f.path}:${f.line}\`` : `\`${f.path}\``;
}

function bullet(f: Finding): string {
  return `- ${ref(f)} — ${f.title} _(${f.severity}/${f.confidence.toFixed(2)}, ${f.lens})_`;
}

export function inlineBody(f: Finding, tag: PostTag): string {
  const head = `[${tag}] ${f.title}`;
  // Reachability is shown only when it is not `routine` — that is exactly when
  // it explains a tag the severity alone would not have produced.
  const reach = f.reachability && f.reachability !== "routine" ? ` · ${f.reachability}` : "";
  const tail = `_${f.severity} · confidence ${f.confidence.toFixed(2)}${reach} · lens ${f.lens}_`;
  return `${head}\n\n${f.body}\n\n${tail}`;
}

/** Assemble the full review POST payload from a round's surviving findings. */
export function assembleReview(input: ReviewInput): AssembledReview {
  const tags = new Map<Finding, PostTag>();
  for (const f of input.findings) tags.set(f, postTag(f.severity, f.confidence, f.reachability, { kind: f.kind, path: f.path }));

  // 1. anchorable candidates vs. findings with no anchor at all
  const overflow: AssembledReview["overflow"] = [];
  const candidates: Finding[] = [];
  for (const f of input.findings) {
    if (f.line === undefined || f.side === undefined) overflow.push({ finding: f, reason: "no anchor claimed" });
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
    for (const r of rejected) overflow.push({ finding: r.comment.finding, reason: ANCHOR_REASON_TEXT[r.reason] });
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
  };
}

export function renderBody(
  input: ReviewInput,
  tags: Map<Finding, PostTag>,
  overflow: AssembledReview["overflow"],
): string {
  const counts: Record<PostTag, number> = { blocker: 0, question: 0, nit: 0 };
  for (const f of input.findings)
    counts[tags.get(f) ?? postTag(f.severity, f.confidence, f.reachability, { kind: f.kind, path: f.path })] += 1;

  const of = (tag: PostTag) => input.findings.filter((f) => tags.get(f) === tag);
  const out: string[] = [verdictLine(input.verdict, counts), "", `_Lenses applied: ${input.lenses.join(", ")}._`];

  const section = (title: string, items: string[]) => {
    if (items.length === 0) return;
    out.push("", `### ${title}`, "", ...items);
  };
  section("Blockers", of("blocker").map(bullet));
  section("Nits", of("nit").map(bullet));
  section("Questions", of("question").map(bullet));

  if (input.deferred?.length) {
    section("Previously deferred, unchanged", input.deferred.map((d) => `- ${d}`));
  }

  if (overflow.length) {
    section(
      "Additional findings (not posted inline)",
      overflow.map(({ finding, reason }) => `- ${bullet(finding).slice(2)} — _${reason}_\n\n  ${finding.body}`),
    );
  }

  // EXACTLY ONE escalation comment per review carrying first-party
  // directive injection findings — rendered once here, however many directive
  // files the PR touches. It rides the one gated review mutation (dry-run
  // records it in state/dryrun/ with the rest of the payload).
  const directiveFiles = directiveEscalationFiles(input.findings);
  if (directiveFiles.length > 0) {
    section("Human approval needed — agent-directive change", [
      renderDirectiveEscalationComment(input.escalation_mention ?? "", directiveFiles),
    ]);
  }

  if (input.verdict === "NEEDS_HUMAN") {
    const start: string[] = [];
    start.push(
      `The automated review could not decide this one, so it is parked for a person${
        input.ai_approved === undefined ? "" : input.ai_approved ? " (it found the PR otherwise sound: AI_APPROVED)" : " (it is not confident the PR is sound)"
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

  out.push("", REVIEW_FOOTER);
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
  deps.store.logEvent("review_posted", pr, { event: payload.event, inline: payload.comments.length, registered: registered.length });
  return { result, payload, registered, needs_backfill: registered.length < payload.comments.length };
}

// ---- the APPROVE path (scripts/approve-pr.sh semantics) ------------------

export type ApprovalStep = "create_review" | "remove_label" | "delete_team_review_request";

export interface ApprovalAction {
  step: ApprovalStep;
  describe: string;
  run: (adapter: Pick<GitHubAdapter, "createReview" | "removeLabel" | "deleteTeamReviewRequest">) => Promise<GateResult>;
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
