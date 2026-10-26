// The home's ports: everything the home (extensions/home.ts) knows about the
// world comes through one of these. The env shim (extensions/cli/home.ts)
// builds the real ones (src/home/adapters.ts); tests build fakes.
//
// Every read answers a `Known<T>`: a value, or `unknown` with the reason. A
// source that cannot be read is never a zero, an empty list or a default
// (invariant 9): the panel renders it Unknown and the `home_status` tool
// reports it as null.
//
// The ports this ticket's home reads are pi login, GitHub, the repository
// and the clock. Reviews, auto-review, memory and spend are typed here so
// the panel's rows exist from the start; until each has its adapter, the
// stubs in adapters.ts answer unknown. Auto-review and memory carry their
// switches (FT-0673) as optional controls.

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
  findings: number;
  /** How many of the findings are high severity (P0, P1). */
  high: number;
  /** Who ran it: the person from the home, or auto-review. */
  by: "you" | "auto";
  /** When it finished, ms since the epoch. */
  at: number;
}

export interface ReviewsPort {
  /** The latest review per open pull request of `repo`, by number. A PR
   * absent from the map has no review. */
  latest(repo: string): Promise<Known<ReadonlyMap<number, PrReview>>>;
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
  /** What auto-review picks up besides a review request: the trigger label
   * (`[github] trigger_label`). Absent: the home does not say. */
  trigger?(): Promise<Known<string>>;
  /** The switch (src/home/autoreview.ts). Absent: the home only shows it. */
  control?: AutoReviewControl;
}

export type MemoryState = "off" | "starting" | "on";

export interface MemoryPort {
  status(): Promise<Known<MemoryState>>;
  /** The switch (src/home/memory.ts). Absent: the home only shows it. */
  control?: MemoryControl;
}

// ---- the switches -------------------------------------------------------

/** What a switch did, in plain words. */
export type SwitchResult = { ok: true; detail: string } | { ok: false; detail: string };

/** A round the daemon is running now. */
export interface RunningRound {
  pr: number;
  round: number;
}

/** The person's answers to switch-on's questions: every one theirs, asked
 * in the home (src/home/switches.ts). */
export interface SwitchOnAnswers {
  /** Memory with it: true turns it on, false keeps it off, null leaves it
   * as it is (it was not offered). */
  memory: boolean | null;
  /** The one explicit confirm. Only a person's answer in the home sets it;
   * it is what the go-live step is handed (invariant 6). */
  confirmed: true;
}

export interface SwitchOnOutcome {
  ok: boolean;
  /** Posting live after it: true, false (dry-run), null when unreadable. */
  live: boolean | null;
  /** What happened, for the notice. */
  detail: string;
  /** Each step that ran or was skipped, in order: `id: what it said`. */
  steps: readonly string[];
}

export interface AutoReviewControl {
  /** The machine checks (Docker, disk, ports): run before anything is asked. */
  machineChecks(): Promise<SwitchResult>;
  /** The config's `dry_run` now: whether the confirm is a go-live. */
  dryRun(): Promise<Known<boolean>>;
  /** Run switch-on's steps in order; `progress` gets each line as it comes. */
  switchOn(answers: SwitchOnAnswers, progress?: (line: string) => void): Promise<SwitchOnOutcome>;
  /** Go live from dry-run: the go-live step with the person's confirm. */
  goLive(answers: { confirmed: true }): Promise<SwitchResult>;
  /** The rounds running now, for switch-off's warning. */
  running(): Promise<Known<readonly RunningRound[]>>;
  /** Stop the daemon at once. Its data is kept, and memory is not touched. */
  switchOff(): Promise<SwitchResult>;
}

export interface MemoryControl {
  /** What memory costs to run, as the person reads it ("up to 4 GB of RAM"). */
  ramCost(): string;
  switchOn(progress?: (line: string) => void): Promise<SwitchResult>;
  /** Stop the memory engine. What it learned is kept. */
  switchOff(): Promise<SwitchResult>;
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
