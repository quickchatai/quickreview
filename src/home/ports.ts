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
// stubs in adapters.ts answer unknown.

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
