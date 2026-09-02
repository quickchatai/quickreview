// The single GitHub mutation gate. Every write to GitHub — REST, GraphQL or
// git push — is described as a MutationIntent and passed through execute().
// In dry-run (config.dry_run, the default until cutover) the intent is written
// to state/dryrun/ instead of being executed. There is deliberately no
// review-dismissal intent kind: the never-dismiss invariant is structural.
//
// "or git push" is load-bearing and was NOT true until: the improvement
// branch push consulted the gate only in dry-run. It is true now — a git intent
// carries a `GitPerformer` (see below) and the gate, not the call site, decides
// whether it runs.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type MutationKind =
  | "add_label"
  | "remove_label"
  | "delete_team_review_request"
  // Reviewer nomination, returned 2026-08-31 as the optional escalation
  // feature's second delivery shape (ratified rule-10 amendment).
  // It is an ORDINARY kind and nothing about it is special-cased: fully
  // gated, suppressed in dry-run like everything else, never `forceLive`,
  // never in APP_SELF_CONFIG_KINDS. It is reachable only from
  // `src/escalation.ts`, only when `[escalation] enabled = true` (off by
  // default) and only towards a login the operator listed in
  // `[escalation] targets`. It never defers, replaces or withholds a verdict:
  // the review is decided and posted on the merits first, and the request is
  // additive notification beside it.
  | "request_reviewer"
  | "create_review"
  | "create_review_comment_reply"
  // Resolve only a bot-owned inline thread after the adapter verifies both
  // the PR and root author. This never dismisses or changes a review verdict.
  | "resolve_own_review_thread"
  | "create_issue"
  | "create_pull"
  | "push_branch"
  // Post-review cleanup (the owner, 2026-08-13): the bot supersedes ITS OWN
  // stale non-APPROVED reviews after posting a new one. The adapter enforces
  // owner+state guards; dismissing an approval or another identity's review
  // remains structurally impossible.
  | "supersede_own_review"
  // App-self-config class (ratified rule-1 amendment, the owner, 2026-08-30,
  //): re-point the GitHub App's OWN webhook URL
  // (JWT-authed PATCH /app/hook/config). Touches only the App's own
  // configuration — never the reviewed repo. See APP_SELF_CONFIG_KINDS.
  | "update_own_webhook_url";

/**
 * The same set at RUNTIME. The union above is erased at compile time, so on
 * its own it stops honest call sites and nothing else — a hand-rolled intent
 * (or one that crosses a JSON boundary) sailed straight through. Every intent
 * is now checked against this list, which makes a kind that is not on it — a
 * review dismissal, say — unreachable in fact and not merely in the type
 * system.
 */
export const MUTATION_KINDS: readonly MutationKind[] = [
  "add_label",
  "remove_label",
  "delete_team_review_request",
  "request_reviewer",
  "create_review",
  "create_review_comment_reply",
  "resolve_own_review_thread",
  "create_issue",
  "create_pull",
  "push_branch",
  "supersede_own_review",
  "update_own_webhook_url",
];

/**
 * The app-self-config gate class (ratified by the owner, 2026-08-30, in-session,
 * as a rule-1 amendment — recorded in spec): mutations that touch
 * ONLY the GitHub App's own configuration and can never reach the reviewed
 * repo. The gate EXECUTES this class even when `dry_run = true`, loudly
 * logged every time, because new users run dry-run during exactly the window
 * the webhook self-heal matters.
 *
 * The class is a CLOSED SET, pinned exactly like the forceLive bypass: it
 * contains exactly `update_own_webhook_url`, and tests/gate.test.ts asserts
 * deep equality against that one-element list, so adding a second kind fails
 * a test. Widening it is the owner's call, never an in-flight improvement.
 * `forceLive` semantics are untouched — the gate still throws on forceLive
 * for anything but `supersede_own_review`, this kind included.
 */
export const APP_SELF_CONFIG_KINDS = ["update_own_webhook_url"] as const satisfies readonly MutationKind[];

/** The class as a TYPE, so a `Record<MutationKind, …>` elsewhere can exclude
 * it deliberately (the App-manifest permission map: these are JWT-authed and
 * need no installation permission at all) instead of forgetting it. */
export type AppSelfConfigKind = (typeof APP_SELF_CONFIG_KINDS)[number];

/**
 * Provenance of a MECHANICALLY-authored review — one the daemon composed
 * itself, as opposed to the round's substantive review, which the session
 * writes. Absent means substantive.
 *
 * Both members are COMMENT-event reviews that state a fact and ask for
 * nothing: the migration-number collision remedy, and the
 * escalation note pointing one named person at one named thing. Neither
 * carries a verdict, so neither may claim the head (guards.ts `after`).
 *
 * THAT IS ENFORCED, NOT DESCRIBED (review). A `reviewPurpose` buys two
 * exemptions — it never claims the head, and the escalation purpose is exempt
 * from guard 2 — so a purpose riding an APPROVE would be an approval that
 * skips the no-new-evidence guard AND never marks the head it approved.
 * `execute()` therefore refuses any purposed intent that is not a
 * `create_review` with `event: "COMMENT"`, before and after the guards.
 */
export type ReviewPurpose = "migration_precheck" | "escalation";

export interface MutationIntent {
  kind: MutationKind;
  /** REST method+path for API intents; "git" for pushes. */
  method: "POST" | "PATCH" | "PUT" | "DELETE" | "git";
  path: string;
  body?: unknown;
  /** Human-readable one-liner for the dry-run record / event log. */
  note: string;
  pr?: number;
  /** Internal provenance for a mechanically-authored review. Absent means a
   * substantive review. It never enters the GitHub body; posting guards use
   * it only to keep mechanical pre-check output from claiming the head. */
  reviewPurpose?: ReviewPurpose;
  /** Execute even in dry-run. Only `supersede_own_review` may set this: the
   * session-side posting leakage is accepted (the owner, 2026-08-13), so the
   * cleanup of that leakage must be real too. Noise-reducing only. */
  forceLive?: boolean;
}

export interface GateResult {
  executed: boolean;
  dryRunFile?: string;
  response?: unknown;
  /** Set when a guard refused the mutation. Nothing was executed and
   * nothing was recorded — the reason is a short tag ("pr-merged", …). */
  blocked?: string;
}

export type MutationExecutor = (intent: MutationIntent) => Promise<unknown>;

/**
 * How a `method: "git"` intent is actually performed.
 *
 * A git push cannot go through the REST executor — `GitHubAdapter.executeMutation`
 * throws on `method === "git"` — so before `src/improvements.ts`
 * consulted the gate ONLY in dry-run and shelled straight to `git push` in
 * live mode: the one mode where the push is real was the one mode the gate
 * never saw. That is the shape rule 1 forbids, and this header claimed
 * otherwise ("REST, GraphQL or git push").
 *
 * The decision taken instead of softening the header: the gate genuinely
 * mediates the push. The caller — which is the only thing that knows which
 * scratch worktree the push must run in — hands the gate a performer, and the
 * GATE, never the call site, decides whether it runs: the kind check, the
 * `forceLive` check, the guards and the dry-run branch all run first, exactly
 * as they do for a REST mutation.
 *
 * The seam cannot widen. `execute` throws if a performer accompanies any method
 * other than `"git"` OR any kind other than `push_branch` — `method` is a free
 * field with no relation to `kind`, so the method check alone would let any
 * kind ride the performer. Both are checked again on the intent a guard hands
 * back (`admit` runs twice), and a guard cannot change either field in the
 * first place (`GUARD_REWRITABLE_FIELDS`).
 */
export type GitPerformer = () => Promise<unknown>;

/** A guard's answer: refuse (`block`), or let it through — optionally with a
 * rewritten intent (the human-approval downgrade posts a COMMENT instead of a
 * REQUEST_CHANGES). Returning `{}` means "no opinion". A rewrite may differ
 * from the admitted intent in `body` and `note` ONLY (GUARD_REWRITABLE_FIELDS);
 * the gate refuses any other difference. */
export interface GuardDecision {
  block?: string;
  intent?: MutationIntent;
}

/**
 * The ONLY fields a guard may rewrite. Everything else on a
 * MutationIntent is the mutation's IDENTITY — `kind` selects the gate's policy
 * (the kind list, the forceLive exception, the app-self-config class),
 * `method` + `path` are what the executor actually sends, `pr` is what the
 * `after` hooks stamp, and `reviewPurpose` and `forceLive` each buy an
 * exemption — and a guard has no business with any of it.
 *
 * Why a closed list of what MAY change, rather than checks on what must not:
 * the gate admits an intent, lets the guards rewrite it, then executes what
 * came back. Before that rewrite was re-checked for `reviewPurpose`
 * and for the git performer's method/kind and for nothing else, so a guard
 * that returned `kind: "dismiss_review"` executed it, one that returned
 * `kind: "update_own_webhook_url"` executed FOR REAL in dry-run, and one that
 * added `forceLive` to a `create_review` did the same. No shipped guard did
 * any of that — guards 1 and 4 rewrite `body` and `note` and nothing else,
 * which is the whole of what a guard is for: soften WHAT IS SAID and how the
 * record describes it, never WHAT IS DONE — but rule 2 is meant to be
 * structural, and a re-check that enumerates the fields it thought of is the
 * shape that left this seam open. So a guard's authority is stated positively
 * and exhaustively. A field added to MutationIntent later is identity by
 * default and stays un-rewritable until someone puts it here on purpose.
 */
export const GUARD_REWRITABLE_FIELDS = ["body", "note"] as const satisfies readonly (keyof MutationIntent)[];

/** See GUARD_REWRITABLE_FIELDS: every field outside that list must be
 * identical (`===`) before and after the guard, presence included — a guard
 * that ADDS `forceLive: true` differs from one that left it absent. */
function guardRewriteCheck(before: MutationIntent, after: MutationIntent): void {
  const fields = new Set([...Object.keys(before), ...Object.keys(after)] as (keyof MutationIntent)[]);
  for (const field of fields) {
    if ((GUARD_REWRITABLE_FIELDS as readonly string[]).includes(field)) continue;
    if (before[field] !== after[field]) {
      throw new Error(
        `gate: a guard may rewrite only ${GUARD_REWRITABLE_FIELDS.join(" and ")}; it changed "${field}" on ${before.kind} `
          + `(${JSON.stringify(before[field])} → ${JSON.stringify(after[field])}) — refusing to execute or record it`,
      );
    }
  }
}

/**
 * Posting-time guards, attached to the ONE gate so that no posting
 * route can reach GitHub around them. `before` runs ahead of the dry-run
 * branch and of the executor; `after` sees what actually happened.
 */
export interface MutationGuard {
  before(intent: MutationIntent): Promise<GuardDecision>;
  after?(intent: MutationIntent, result: GateResult): void | Promise<void>;
}

/** See ReviewPurpose: a purposed intent is a `create_review` COMMENT or it is
 * refused. Free function so `execute` can run it twice — once on the caller's
 * intent, once on whatever the guards handed back. */
function reviewPurposeCheck(intent: MutationIntent): void {
  if (!intent.reviewPurpose) return;
  const event = String((intent.body as { event?: unknown } | undefined)?.event ?? "").toUpperCase();
  if (intent.kind !== "create_review" || event !== "COMMENT") {
    throw new Error(
      `gate: reviewPurpose "${intent.reviewPurpose}" is only allowed on a create_review with event COMMENT, not ${intent.kind}/${event || "(no event)"}`,
    );
  }
}

/**
 * Admission: what the gate demands of ANY intent before it may execute or be
 * recorded. It runs on the caller's intent on entry, and again on whatever a
 * guard hands back. The second run is the invariant "only an
 * admitted intent executes", checked on the very object that executes rather
 * than inferred from GUARD_REWRITABLE_FIELDS. The two are deliberately
 * independent belts: the field list says what a guard MAY change, admission
 * says what may run at all — so widening the field list (should a guard ever
 * need to) does not loosen what runs.
 */
function admit(intent: MutationIntent, perform: GitPerformer | undefined): void {
  // Checked before anything else — an unknown kind is never recorded to
  // state/dryrun/ either, so a retired kind cannot even leave evidence
  // suggesting the daemon still performs it.
  if (!(MUTATION_KINDS as readonly string[]).includes(intent.kind)) {
    throw new Error(`gate: unknown mutation kind "${intent.kind}" — refusing to execute or record it`);
  }
  // The git performer exists for `method: "git"` and nothing else:
  // otherwise it would be a second executor, i.e. a way to run an arbitrary
  // mutation the REST executor never saw. Checked before the guards so the
  // refusal is unconditional.
  if (perform && intent.method !== "git") {
    throw new Error(`gate: a git performer is only allowed for method "git", not ${intent.method} (${intent.kind})`);
  }
  // `method` is a free field with no relation to `kind`, so the method check
  // alone would let any kind ride the performer. `push_branch` is the only
  // kind this system ever performs with git — and rule 4 already says the
  // only branches it pushes are `bot/improve-*`.
  if (perform && intent.kind !== "push_branch") {
    throw new Error(`gate: a git performer is only allowed for kind "push_branch", not ${intent.kind}`);
  }
  if (intent.forceLive && intent.kind !== "supersede_own_review") {
    throw new Error(`forceLive is not allowed for kind ${intent.kind}`);
  }
  // A reviewPurpose marks a MECHANICALLY-authored COMMENT (see ReviewPurpose):
  // it buys two exemptions, so it is confined to the one shape those
  // exemptions are safe for.
  reviewPurposeCheck(intent);
}

let seq = 0;

export class MutationGate {
  constructor(
    private readonly dryRun: boolean,
    private readonly dryrunDir: string,
    private readonly executor: MutationExecutor,
    private readonly now: () => Date = () => new Date(),
    private guard?: MutationGuard,
    private logFn: (msg: string, extra?: unknown) => void = (msg, extra) =>
      console.log(`[quickreviewd] ${msg}`, extra ?? ""),
  ) {}

  get isDryRun(): boolean {
    return this.dryRun;
  }

  /** Attach the posting guards. Production wiring needs the store and the
   * adapter, which only exist after the gate itself does — hence a setter
   * rather than a constructor-only dependency. */
  setGuard(guard: MutationGuard): void {
    this.guard = guard;
  }

  /** Attach the production logger (same late-binding shape as setGuard). The
   * default logs to the console, so the app-self-config loud line can never
   * be silenced by an unwired gate. */
  setLog(logFn: (msg: string, extra?: unknown) => void): void {
    this.logFn = logFn;
  }

  async execute(intentIn: MutationIntent, perform?: GitPerformer): Promise<GateResult> {
    let intent = intentIn;
    admit(intent, perform);
    // Posting-time guards run BEFORE the dry-run branch: a mutation a guard
    // refuses is neither executed nor recorded, so the dry-run evidence shows
    // the same behaviour the live path would have had.
    if (this.guard) {
      const decision = await this.guard.before(intent);
      if (decision.block) {
        const blocked: GateResult = { executed: false, blocked: decision.block };
        await this.guard.after?.(intent, blocked);
        return blocked;
      }
      if (decision.intent) {
        // A guard may soften the mutation (guards 1 and 4 rewrite the review
        // body and the note), never change which mutation it is: every field
        // outside GUARD_REWRITABLE_FIELDS must come back identical.
        guardRewriteCheck(intent, decision.intent);
        intent = decision.intent;
        // And what executes is re-admitted IN FULL — kind against
        // MUTATION_KINDS, forceLive against its single permitted kind, the
        // performer's method/kind, reviewPurpose against the rewritten body —
        // on the object that will execute, not inferred from the check above.
        // Only the reviewPurpose leg can still fail here today (guard 1 really
        // does rewrite the event); the rest is what keeps that true if the
        // field list is ever widened.
        admit(intent, perform);
      }
    }
    // The app-self-config class (see APP_SELF_CONFIG_KINDS): executes for real
    // even in dry-run — the ratified rule-1 amendment — and every execution is
    // loud. The intent's `note` names old and new URL, so the line does too.
    if ((APP_SELF_CONFIG_KINDS as readonly string[]).includes(intent.kind)) {
      this.logFn(
        `gate: APP-SELF-CONFIG "${intent.kind}" executing FOR REAL${this.dryRun ? " despite dry_run (ratified rule-1 amendment, 2026-08-30)" : ""} — ${intent.note}`,
      );
      const response = await this.executor(intent);
      const executed: GateResult = { executed: true, response };
      await this.guard?.after?.(intent, executed);
      return executed;
    }
    if (this.dryRun && !intent.forceLive) {
      mkdirSync(this.dryrunDir, { recursive: true });
      const ts = this.now().toISOString().replace(/[:.]/g, "-");
      const file = join(this.dryrunDir, `${ts}-${String(seq++).padStart(4, "0")}-${intent.kind}.json`);
      writeFileSync(file, JSON.stringify({ recorded_at: this.now().toISOString(), ...intent }, null, 2));
      const recorded: GateResult = { executed: false, dryRunFile: file };
      await this.guard?.after?.(intent, recorded);
      return recorded;
    }
    // A `method: "git"` intent runs its performer; everything else runs the
    // REST executor (which still throws on "git", so a git intent that arrives
    // without a performer cannot execute). By this line `intent` has passed
    // admission — twice, if a guard rewrote it — and the rewrite cannot have
    // touched `method` or `kind`, so the performer only ever runs against the
    // push_branch it was handed in for.
    const response = perform ? await perform() : await this.executor(intent);
    const executed: GateResult = { executed: true, response };
    await this.guard?.after?.(intent, executed);
    return executed;
  }
}
