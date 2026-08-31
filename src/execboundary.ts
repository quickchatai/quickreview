// The exec boundary's OUTCOME layer.
//
// Everything else in this system that defends the exec boundary asks about an
// ATTEMPT: `extensions/bash-guard.ts` inspects a command string, `usage.ts`
// re-reads those strings after the fact. hardened the command-string
// guard over four adversarial rounds, and each of the first three looked
// complete to its author and to a green suite while a live bypass stood:
//
//   1. `gh pr review --approve` closed; `gh api … --input` left open — the
//      channel the retro says the predecessor used for EVERY review it posted.
//   2. that closed and `git -c` closed; `gh api -fevent=APPROVE` (same flag,
//      different form) and `git --git-dir=` (same family, third mechanism) left.
//   3. both made structural; `HOME` / `XDG_CONFIG_HOME` — the implicit config
//      search path behind the explicit pointers — left.
//   4. those closed.
//
// The pattern is not "the lists were short". It is that a guard which must
// enumerate every way a general-purpose tool reaches `exec` will be wrong
// again, and that nothing else in the system would have noticed. This module
// asks a different question, and it is the only question in the codebase whose
// answer does not depend on knowing how the write was made:
//
//   **Is there a review on GitHub, authored by the bot, that this daemon has
//   no record of posting?**
//
// A review is the terminal harm of the whole class — bypasses 1 and 2 existed
// to post one, and bypasses 3, 4 and 5 grant the arbitrary execution from which
// one can be posted. GitHub is the authority here, exactly as `reconcile.ts`
// already treats it for every other fact; the read is free, because the comment
// sweep already fetches full review bodies for the same PRs.
//
// FALSIFIABLE CLAIM, stated as a claim so it can be shown false rather than as
// a reassurance: *for a review at a PR's current head, authored by the bot, at
// least one of four local traces exists whenever the daemon or a sanctioned
// script produced it* — the posting marker in the body, a `rounds` row
// carrying its review id, the `reviewed_heads` mark the shell route stamps, or
// a `migration_collision_comment` event. A review at the current head with
// none of them was produced by something else. The claim is testable in both
// directions and this module's tests exercise both.
//
// Known limits, recorded rather than papered over:
//   · It is bounded to the CURRENT head. `reviewed_heads` is one row per PR
//     (upsert), so an older head's legitimate review has no surviving trace and
//     auditing history would be all noise.
//   · `guard_stamp_reviewed_head` in scripts/guards.sh swallows its own
//     failures (`2>/dev/null || true`). A silently failed stamp presents here
//     as an unaccounted review. That is the right way round: a broken ledger
//     and an ungated write are both faults, and the message says so.
//   · It detects; it never blocks. A detector that could wedge a review would
//     be traded away the first time it misfired.

/** A review as GitHub reports it — the subset this audit needs. */
export interface AuditedReview {
  id: number;
  user: string;
  user_type?: string;
  state: string;
  body: string;
  commit_id: string;
  submitted_at: string | null;
}

/** Every local trace that can account for a bot review, gathered by the caller. */
export interface PostingTraces {
  /** `rounds.gh_review_id` for this PR — the per-review ledger. */
  reviewIds: ReadonlySet<number>;
  /** The `reviewed_heads` mark: what the daemon or the shell route last posted. */
  reviewedHead?: { head_sha: string; posted_event: string | null } | undefined;
  /** The PR has had a mechanical migration-collision COMMENT posted through the
   * gate. That route deliberately does NOT stamp `reviewed_heads`, so
   * it needs its own trace. */
  migrationPrecheck: boolean;
}

export interface UngatedReview {
  review_id: number;
  state: string;
  commit_id: string;
  submitted_at: string | null;
}

/** The posting receipt marker: `<!-- qcr-post:v1:<pr>:<round>:<head> -->`.
 * Matched loosely on the prefix — the exact key is verified elsewhere, and a
 * malformed key is not evidence that the sanctioned route was NOT used. */
const POSTING_MARKER_RE = /<!--\s*qcr-post:/;

function isBotAuthored(review: AuditedReview, botLogin: string, appSlug?: string): boolean {
  if (review.user_type === "Bot") return true;
  const login = review.user.toLowerCase();
  return login === botLogin.toLowerCase() || (appSlug !== undefined && login === `${appSlug.toLowerCase()}[bot]`);
}

/**
 * Bot-authored reviews at `headSha` that no local trace accounts for.
 *
 * Pure: the caller gathers the traces and decides what to do with the answer.
 * `PENDING` reviews are skipped — they are drafts GitHub has not submitted, and
 * the bot never creates one.
 */
export function auditUngatedReviews(
  reviews: readonly AuditedReview[],
  headSha: string,
  traces: PostingTraces,
  opts: { botLogin: string; appSlug?: string },
): UngatedReview[] {
  const head = headSha.toLowerCase();
  const out: UngatedReview[] = [];
  for (const r of reviews) {
    if (!isBotAuthored(r, opts.botLogin, opts.appSlug)) continue;
    const state = (r.state ?? "").toUpperCase();
    if (state === "PENDING" || state === "DISMISSED") continue;
    if ((r.commit_id ?? "").toLowerCase() !== head) continue;
    if (POSTING_MARKER_RE.test(r.body ?? "")) continue;
    if (traces.reviewIds.has(r.id)) continue;
    // The shell route's mark. For an APPROVE the mark must ALSO say APPROVE:
    // an approval is the one outcome the whole gate exists to control, and
    // "some review was posted at this head" is not evidence that an approval
    // was among them.
    const mark = traces.reviewedHead;
    if (mark && mark.head_sha.toLowerCase() === head) {
      if (state !== "APPROVED") continue;
      if ((mark.posted_event ?? "").toUpperCase() === "APPROVE") continue;
    }
    // The gate's mechanical pre-check COMMENT, which stamps no mark by design.
    if (state === "COMMENTED" && traces.migrationPrecheck) continue;
    out.push({ review_id: r.id, state, commit_id: r.commit_id, submitted_at: r.submitted_at });
  }
  return out;
}

/** An unaccounted APPROVE is the severe case: rule 1, the CI hard-gate and
 * every posting guard are bypassed at once. Anything else is still reported,
 * but only this escalates to an overseer anomaly. */
export function hasUngatedApproval(found: readonly UngatedReview[]): boolean {
  return found.some((r) => r.state === "APPROVED");
}

/** The operator-facing line. Deliberately names BOTH readings — an ungated
 * write and a failed local stamp are different faults with the same shape here,
 * and asserting the wrong one would send the reader down the wrong path. */
export function ungatedReviewMessage(pr: number, found: readonly UngatedReview[]): string {
  const list = found.map((r) => `${r.state} review ${r.review_id} at ${r.commit_id.slice(0, 7)}`).join("; ");
  return [
    `EXEC BOUNDARY — PR #${pr}: ${found.length} bot-authored review(s) at the current head with no local posting record: ${list}.`,
    "Two readings, both faults: (a) something posted to GitHub outside the mutation gate and the posting guards —",
    "check the round's session transcript and the exec_policy_violation events; or (b) the daemon posted it and the",
    "reviewed_heads stamp failed silently (scripts/guards.sh swallows that error), which breaks guard 2 for this PR.",
    "Rule out (a) first. No review is dismissed or edited by this check — it only reports.",
  ].join("\n");
}
