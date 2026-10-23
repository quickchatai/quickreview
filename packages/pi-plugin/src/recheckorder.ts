// The post-approval recheck's order: what woke it, the delta's file
// classes and the one question handed to the session. The core renders it
// (packages/pi-plugin/src/templates.ts); src/recheck.ts builds it and re-exports these.

/** What woke the recheck. `author_reply` is listed because it is a decided
 * trigger — its handling is "hand it to ping-pong and do nothing else". */
export type RecheckTrigger = "push" | "ci" | "base_advance" | "author_reply";

/** Why a file was judged not worth re-reviewing. */
export type TrivialReason =
  | "base-merge"
  | "migration-renumber"
  | "pure-rename"
  | "version-bump"
  | "formatting"
  | "no-content-change";

export interface FileClass {
  filename: string;
  class: "trivial" | "significant";
  /** The trivial rule that fired, or "content" for a real change. */
  reason: TrivialReason | "content";
}

/** The recheck's own order kind — deliberately NOT a RoundOrder: no round is
 * started, no pass plan exists, and the session is asked one question. */
export interface RecheckOrder {
  pr: number;
  title: string;
  trigger: RecheckTrigger;
  /** Always APPROVE — the only standing verdict this path can act on. */
  standing_verdict: "APPROVE";
  last_reviewed_sha: string;
  head_sha: string;
  worktree: string;
  evidence: string;
  files: FileClass[];
  /** Files hand-resolved inside merge commits of this delta — the session
   * must audit each against BOTH merge parents. */
  resolved_files: string[];
  /** Relative name of the decision file the session must write. */
  decision_file: string;
  issued_at: string;
}
