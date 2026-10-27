// What a review is of: the type a review's target is named by
// (packages/pi-plugin/src/reviewapi.ts runs it, the plugin's arguments build
// it), in a module of its own so naming a target never imports the review's
// runtime.

/** What is reviewed. */
export type ReviewTarget =
  /** The repo dir's current branch against its base (`base`, else origin's
   * default branch, main, master). `head` reviews that branch (or commit)
   * instead of HEAD; `uncommitted` adds the working tree's uncommitted edits
   * on top of HEAD's commits, reviewed as one (with `head`, the named branch
   * is its commits alone). A branch with uncommitted edits keeps no state:
   * its next review is a whole one. Never posted anywhere. */
  | { kind: "branch"; base?: string; head?: string; uncommitted?: boolean }
  /** The uncommitted working tree (staged, unstaged and new files) against
   * HEAD. Never posted anywhere. */
  | { kind: "uncommitted" }
  /** A pull request: `12`, `#12` or a github.com pull URL. A PR on another
   * repo than the repo dir's needs `repo` (owner/name). */
  | { kind: "pr"; pr: string | number; repo?: string }
  /** A unified diff: its text, or a reader the run calls when it gets there
   * (a reader's Error message is the refusal, word for word). `name` says
   * where it came from: a file name, or "-" (or nothing) for a piped diff.
   * The repo dir is optional and only read; a diff is never posted. */
  | { kind: "diff"; diff: string | (() => Promise<string>); name?: string };
