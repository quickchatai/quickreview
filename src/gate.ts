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
  | "supersede_own_review";

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
];

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
}

export type MutationExecutor = (intent: MutationIntent) => Promise<unknown>;

let seq = 0;

export class MutationGate {
  constructor(
    private readonly dryRun: boolean,
    private readonly dryrunDir: string,
    private readonly executor: MutationExecutor,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get isDryRun(): boolean {
    return this.dryRun;
  }

  async execute(intent: MutationIntent): Promise<GateResult> {
    // Checked before anything else — an unknown kind is never recorded to
    // state/dryrun/ either, so a retired kind cannot even leave evidence
    // suggesting the daemon still performs it.
    if (!(MUTATION_KINDS as readonly string[]).includes(intent.kind)) {
      throw new Error(`gate: unknown mutation kind "${intent.kind}" — refusing to execute or record it`);
    }
    if (intent.forceLive && intent.kind !== "supersede_own_review") {
      throw new Error(`forceLive is not allowed for kind ${intent.kind}`);
    }
    if (this.dryRun && !intent.forceLive) {
      mkdirSync(this.dryrunDir, { recursive: true });
      const ts = this.now().toISOString().replace(/[:.]/g, "-");
      const file = join(this.dryrunDir, `${ts}-${String(seq++).padStart(4, "0")}-${intent.kind}.json`);
      writeFileSync(file, JSON.stringify({ recorded_at: this.now().toISOString(), ...intent }, null, 2));
      return { executed: false, dryRunFile: file };
    }
    const response = await this.executor(intent);
    return { executed: true, response };
  }
}
