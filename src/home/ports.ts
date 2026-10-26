// The home's ports: everything the home (extensions/home.ts) knows about the
// world comes through one of these. The env shim (extensions/cli/home.ts)
// builds the real ones (src/home/adapters.ts); tests build fakes.
//
// Every read answers a `Known<T>`: a value, or `unknown` with the reason. A
// source that cannot be read is never a zero, an empty list or a default
// (invariant 9): the panel renders it Unknown and the `home_status` tool
// reports it as null.
//
// The home reads pi login, GitHub, the repository, the clock and the reviews
// (the app's detached runs, its per-target review state and the daemon's
// rounds). Auto-review, memory and spend are typed here so the panel's rows
// exist from the start; until each has its adapter, the stubs in adapters.ts
// answer unknown.

/** A read that worked, or one that did not and why. */
export type Known<T> = { kind: "known"; value: T } | { kind: "unknown"; why: string };

/** A read still in flight: the panel shows it as being checked. */
export type Pending = { kind: "pending" };

/** A slot of the home's state: not read yet, read, or unreadable. */
export type Slot<T> = Pending | Known<T>;

export const known = <T>(value: T): Known<T> => ({ kind: "known", value });
export const unknown = (why: string): Known<never> => ({ kind: "unknown", why });
export const PENDING: Pending = { kind: "pending" };

/** The pi login of the pi home the chat runs in. */
export interface PiLoginPort {
  /** The providers pi holds a credential for in that home's auth file; an
   * empty list when it holds none. Provider ids only, never a token. */
  providers(): Promise<Known<readonly string[]>>;
}

/** One open pull request, as `gh pr list --json` gives it. */
export interface OpenPull {
  number: number;
  title: string;
  author: string;
  /** ISO time of the last update. */
  updatedAt: string;
  isDraft: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  headRefName: string;
  /** The head commit: a price is cached by it. Empty when gh gave none. */
  headSha: string;
}

export interface GithubPort {
  /** The `gh` account's login; null when `gh` is not signed in. */
  user(): Promise<Known<string | null>>;
  /** The repository's open pull requests (closed and merged ones never). */
  openPulls(repo: string): Promise<Known<readonly OpenPull[]>>;
  /** Open one pull request in the person's browser. */
  openInBrowser(repo: string, pr: number): Promise<{ ok: true } | { ok: false; why: string }>;
}

/** The repository the home reviews (the app config's `[github] repo`). */
export interface RepoPort {
  /** `owner/name`; null when no repository is configured. */
  repo(): Promise<Known<string | null>>;
}

export interface ClockPort {
  /** Milliseconds since the epoch. */
  now(): number;
}

/** The latest review of one pull request. */
export interface PrReview {
  /** How many findings it raised; null when its source does not say
   * (auto-review's status counts rounds, not findings). */
  findings: number | null;
  /** How many of the findings are high severity (P0, P1); null as above. */
  high: number | null;
  /** Who ran it: the person from the home, or auto-review. */
  by: "you" | "auto";
  /** When it finished, ms since the epoch. */
  at: number;
  /** The findings themselves, when the review's result is at hand. */
  list?: readonly ReviewFinding[];
  /** The review's markdown report, when it wrote one. */
  report?: string;
  /** How long it took, and what it cost (null: the result does not say). */
  tookMs?: number;
  costUsd?: number | null;
}

/** One finding as the home shows it. */
export interface ReviewFinding {
  /** The reviewer's severity, as written: P0 … P3, nit. */
  severity: string;
  path: string | null;
  line: number | null;
  title: string;
  /** The lens agent that raised it. */
  lens: string | null;
}

/** The reviewer's preview of one pull request: its plan, its price and the
 * key that starts it over the repo's limit. */
export interface ReviewQuote {
  estimateUsd: number;
  /** The hard stop; null: none. */
  capUsd: number | null;
  key: string;
  /** The lens agents the plan runs, the validator among them. */
  lenses: readonly string[];
  files: number;
  /** The head the quote is of. */
  headSha: string | null;
}

/** One lens of a running review, from its live log. */
export interface LiveLens {
  /** The lens agent (`pass-security--sol-high`). */
  agent: string;
  /** running, completed, failed, or another word the log uses. */
  status: string;
  toolCount: number;
  durationMs: number;
  currentTool?: string;
  currentTarget?: string;
  /** The lens's activity as one line (packages/pi-plugin/src/live/lensline.ts). */
  line: string;
}

export type ReviewRunState = "running" | "done" | "failed" | "stopped";

/** A detached review run, as `qcr review status` reports it. */
export interface ReviewRunStatus {
  runId: string;
  state: ReviewRunState;
  /** The pull request it reviews, when it is one. */
  repo: string | null;
  pr: number | null;
  /** When it was started, ms since the epoch. */
  startedAt: number;
  /** When it ended, ms since the epoch (the result's time); absent while it runs. */
  endedAt?: number;
  /** Where its report is written. */
  report?: string;
  /** While it runs: the lenses its live log names, and what the round says
   * it is doing. Absent until the log exists. */
  live?: { lastActivity: string; lenses: readonly LiveLens[] };
  /** Once it has ended: what its result says. */
  result?: {
    findings: readonly ReviewFinding[];
    /** What it cost; null when the result does not say. */
    costUsd: number | null;
    /** The finished review kept for a later post (the result's `post_ready`). */
    postFile?: string;
    /** It posted already (its own `--to pr`). */
    posted?: boolean;
  };
  /** Why it failed or stopped. */
  errors: readonly string[];
}

export type Outcome<T> = ({ ok: true } & T) | { ok: false; why: string };

/** The reviewer, as the home drives it: the app's detached runs. */
export interface ReviewsPort {
  /** The latest review per open pull request of `repo` the person ran (the
   * home's finished runs and the app's per-target review state), by number.
   * A PR absent from the map has no review. */
  latest(repo: string): Promise<Known<ReadonlyMap<number, PrReview>>>;
  /** The daemon's rounds per pull request of `repo` (auto-review's half of
   * the Reviewed list). */
  autoRounds(repo: string): Promise<Known<ReadonlyMap<number, PrReview>>>;
  /** Price one pull request: the reviewer's own preview. A stop abandons it. */
  preview(
    repo: string,
    pr: number,
    o?: { signal?: AbortSignal },
  ): Promise<Outcome<{ quote: ReviewQuote }>>;
  /** Start a detached review with the preview's key, writing its report to a
   * file in the state home. It never posts. */
  start(repo: string, pr: number, key: string): Promise<Outcome<{ runId: string; report: string }>>;
  status(runId: string): Promise<Known<ReviewRunStatus>>;
  stop(runId: string): Promise<Outcome<object>>;
  /** Every run of `repo` the registry holds, oldest first: what the home
   * re-attaches to when it opens. */
  runs(repo: string): Promise<Known<readonly ReviewRunStatus[]>>;
  /** Post a finished review kept for later: one comment-only review through
   * the gate, with the install's dry_run. `line` says what happened. */
  post(postFile: string): Promise<Outcome<{ line: string }>>;
  /** The install keeps dry_run on: a post is recorded, not sent. */
  dryRun(): Promise<Known<boolean>>;
}

/** Auto-review's label (FT-0665): Unknown is the port answering unknown. */
export type AutoReviewState = "off" | "starting" | "on-live" | "on-dry" | "paused-login" | "broken";

export interface AutoReviewStatus {
  state: AutoReviewState;
  /** Why it is broken or paused, in plain words. */
  cause?: string;
  /** The daemon's last poll, ms since the epoch. */
  checkedAt?: number;
}

export interface AutoReviewPort {
  status(): Promise<Known<AutoReviewStatus>>;
}

export type MemoryState = "off" | "starting" | "on";

export interface MemoryPort {
  status(): Promise<Known<MemoryState>>;
}

/** Dollars spent on reviews. */
export interface SpendTotals {
  today: number;
  month: number;
}

export interface SpendPort {
  totals(): Promise<Known<SpendTotals>>;
}

/** Every port the home reads. */
export interface HomeAdapters {
  login: PiLoginPort;
  github: GithubPort;
  repo: RepoPort;
  clock: ClockPort;
  reviews: ReviewsPort;
  autoReview: AutoReviewPort;
  memory: MemoryPort;
  spend: SpendPort;
}
