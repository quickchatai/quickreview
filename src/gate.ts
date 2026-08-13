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
  | "request_reviewer"
  | "create_review"
  | "create_review_comment_reply"
  | "create_issue"
  | "create_pull"
  | "push_branch";

export interface MutationIntent {
  kind: MutationKind;
  /** REST method+path for API intents; "git" for pushes. */
  method: "POST" | "PATCH" | "PUT" | "DELETE" | "git";
  path: string;
  body?: unknown;
  /** Human-readable one-liner for the dry-run record / event log. */
  note: string;
  pr?: number;
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
    if (this.dryRun) {
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
