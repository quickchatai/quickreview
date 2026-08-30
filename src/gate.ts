// The single GitHub mutation gate. Every write to GitHub — REST, GraphQL or
// git push — is described as a MutationIntent and passed through execute().
// In dry-run (config.dry_run, the default until cutover) the intent is written
// to state/dryrun/ instead of being executed. There is deliberately no
// review-dismissal intent kind: the never-dismiss invariant is structural.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type MutationKind =
  | "add_label"
  | "remove_label"
  | "delete_team_review_request"
  // "request_reviewer" was retired on 2026-08-18 with the escalation
  // mechanics. Its absence from this union is the enforcement: no call site
  // can nominate a human reviewer on GitHub, because no such kind exists.
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
 * is now checked against this list, which makes a retired kind such as
 * `request_reviewer` unreachable in fact and not merely in the type system.
 */
export const MUTATION_KINDS: readonly MutationKind[] = [
  "add_label",
  "remove_label",
  "delete_team_review_request",
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

export interface MutationIntent {
  kind: MutationKind;
  /** REST method+path for API intents; "git" for pushes. */
  method: "POST" | "PATCH" | "PUT" | "DELETE" | "git";
  path: string;
  body?: unknown;
  /** Human-readable one-liner for the dry-run record / event log. */
  note: string;
  pr?: number;
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

/** A guard's answer: refuse (`block`), or let it through — optionally with a
 * rewritten intent (the human-approval downgrade posts a COMMENT instead of a
 * REQUEST_CHANGES). Returning `{}` means "no opinion". */
export interface GuardDecision {
  block?: string;
  intent?: MutationIntent;
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

  async execute(intentIn: MutationIntent): Promise<GateResult> {
    let intent = intentIn;
    // Checked before anything else — an unknown kind is never recorded to
    // state/dryrun/ either, so a retired kind cannot even leave evidence
    // suggesting the daemon still performs it.
    if (!(MUTATION_KINDS as readonly string[]).includes(intent.kind)) {
      throw new Error(`gate: unknown mutation kind "${intent.kind}" — refusing to execute or record it`);
    }
    if (intent.forceLive && intent.kind !== "supersede_own_review") {
      throw new Error(`forceLive is not allowed for kind ${intent.kind}`);
    }
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
      if (decision.intent) intent = decision.intent;
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
    const response = await this.executor(intent);
    const executed: GateResult = { executed: true, response };
    await this.guard?.after?.(intent, executed);
    return executed;
  }
}
