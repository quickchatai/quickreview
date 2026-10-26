// The ports the scan engine and the unit cut run over, by shape: the
// reviewed checkout read-only, the state home as a rooted filesystem, and the
// case runner that runs one case as a background subagent. Every effect of
// the engine goes through one of these, so a host decides where each one
// lands: the app's companion and `qcr scan` driver, or the pi plugin's
// /qcr-scan in the person's own pi.

/** The reviewed checkout, read-only (the companion mounts it `:ro`). Every
 * method is total: an unreadable checkout answers null, never throws. */
export interface RepoReader {
  /** Where the checkout is, for messages. */
  readonly location: string;
  /** Repo-relative paths of every tracked file, or null when there is no
   * readable checkout. */
  listFiles(): string[] | null;
  /** A file's text, or null (missing, binary, over the reader's size cap). */
  read(rel: string): string | null;
  /** A file's line count (0 for an empty file), or null when unreadable. */
  lines(rel: string): number | null;
  /** The checked-out commit, or null when it cannot be read. */
  head(): string | null;
  /** Commits touching each file over the recent history — the survey's
   * "most-changed" sample. Optional and total: absent or null when
   * the history cannot be read, which only empties that one reason. */
  changeCounts?(): Record<string, number> | null;
}

/** The filesystem rooted at the install's state home — PC-only, never shipped.
 * Paths are relative to that root; the implementation refuses any that would
 * leave it. The same shape roots the config home (`SetupPorts.config`). */
export interface StateFs {
  readonly location: string;
  /** The file's text, or null when it does not exist. Throws only when it
   * exists and cannot be read — the caller reports that, never overwrites. */
  read(rel: string): string | null;
  /** tmp+rename atomic write; creates parent directories. */
  write(rel: string, text: string): void;
}

/** One case: a unit (or part of one) handed to background pi subagents inside
 * the companion. */
export interface CaseSpec {
  id: string;
  unit: string;
  agent: string;
  files: string[];
  prompt: string;
}

/** How a case ended: the lens's final answer and what it cost (null when
 * the runner could not tell), or why there is none. A failed or aborted case
 * may still have spent money: `cost_usd` on a failure is what it spent before
 * it ended (0 when it never started, null or absent when the runner cannot
 * tell) — a caller holding a budget counts it. */
export type CaseOutcome =
  | {
      ok: true;
      output: string;
      cost_usd: number | null;
      /** The files the case's file-read tool calls opened (`read`, and
       * `grep` given a `path`), in call order, each resolved to the absolute
       * path the call opened (against the case's working directory, which is
       * not the scanned tree) — `[]` when it read nothing. Absent when the
       * runner cannot tell, which is unknown, never "read nothing". The scan
       * judges a lens that read none of its focus files as no reading at all. */
      reads?: string[];
      /** Where the runner kept the case's event stream, relative to its
       * transcript directory; absent when it kept none. */
      transcript?: string;
    }
  | { ok: false; reason: string; cost_usd?: number | null; transcript?: string };

/** Runs cases as background subagents (survey, scan). The
 * engine decides what runs when and how many at once; the runner runs one
 * case to its end. Resolves for every outcome — a failed or aborted case is
 * `{ok:false}`, never a rejection. `onCost`, when given, hears the case's
 * running cost each time the runner learns more of it, so a caller with a
 * hard cap can abort a case mid-flight rather than after the fact. */
export interface CaseRunner {
  run(
    spec: CaseSpec,
    signal: AbortSignal,
    onCost?: (spentSoFar: number) => void,
  ): Promise<CaseOutcome>;
}

/** A refusal: why nothing was done. */
export type Refusal = { ok: false; errors: string[] };
