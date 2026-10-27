// The home's state and its actions, over the ports (src/home/ports.ts). No
// pi here: extensions/home.ts registers each action as a key and as a
// `home_*` tool, and src/home/panel.ts draws the state. Every action is one
// method, so a key and a tool can never do two different things.
//
// Detection reads every port at once; a slot is pending until its read lands,
// then known or unknown. The setup gaps are the setup checklist's
// (src/home/setup.ts), which detects over these slots once a read has landed
// (the `onRead` hook) and before the first notice: only what a read showed to
// be missing is a gap; a source that could not be read is Unknown, never a
// gap and never a zero (invariant 9).
//
// The review button: `review` previews the PR, starts a detached
// run with the preview's key (so a one-key review always starts and its hard
// stop caps it), polls its status into a Run (src/home/review.ts) and, once
// it is done, applies the person's posting rule. Runs survive the home: when
// it opens it re-attaches to the repo's running and finished runs. The PR the
// cursor rests on is priced after PRICE_REST_MS, one preview at a time, cached
// by its head: a preview for a PR the cursor has left gives way to the next.
import type { HomeToolSet } from "../config.js";
import { KEEP_IT_HERE, postAnswer } from "@quickchatai/pi-quickreview/src/plugin/messages.js";
import type { PostingRule } from "@quickchatai/pi-quickreview/src/plugin/settings.js";
import {
  PENDING,
  known,
  unknown,
  type AutoReviewStatus,
  type HomeAdapters,
  type Known,
  type LoginHealth,
  type MemoryControl,
  type MemoryState,
  type OpenPull,
  type Outcome,
  type PrReview,
  type ReviewQuote,
  type ReviewRunStatus,
  type Slot,
  type SpendTotals,
} from "./ports.js";
import {
  attachedRun,
  foldStatus,
  plannedRun,
  quoteRun,
  reviewMessage,
  runReview,
  type Run,
} from "./review.js";
import { switchAutoReview, switchMemory, type Ask, type SwitchHost } from "./switches.js";
import { money, plural } from "./words.js";

export type NoticeKind = "info" | "ok" | "warn";
export interface Notice {
  text: string;
  kind: NoticeKind;
}

/** What a read showed to be missing: a setup checklist step's id. */
export type SetupGap = string;

export interface HomeState {
  /** The providers pi holds a login for, in the chat's pi home. */
  login: Slot<readonly string[]>;
  /** The `gh` account; null when signed out. */
  github: Slot<string | null>;
  /** The configured repository; null when none is chosen. */
  repo: Slot<string | null>;
  pulls: Slot<readonly OpenPull[]>;
  /** The reviews the person ran (the home's runs, the app's review state). */
  reviews: Slot<ReadonlyMap<number, PrReview>>;
  /** Auto-review's rounds, per PR. */
  autoRounds: Slot<ReadonlyMap<number, PrReview>>;
  autoReview: Slot<AutoReviewStatus>;
  /** What auto-review picks up besides a review request: the trigger
   * label; null when the port does not report it. */
  trigger: Slot<string> | null;
  memory: Slot<MemoryState>;
  spend: Slot<SpendTotals>;
  /** Who refreshes the login and whether it expired (src/home/loginowner.ts);
   * null when the home has no such port. */
  loginHealth: Slot<LoginHealth> | null;
}

/** After a re-login, auto-review's own "login expired" is taken as old news
 * for this long: its status lags the refresher's by a poll or two. */
export const RELOGIN_GRACE_MS = 5 * 60_000;

/** The two lists, from the open pull requests and their latest reviews. */
export interface HomeLists {
  /** Open PRs with no review known, newest first. */
  toReview: readonly OpenPull[];
  /** Open PRs with a review, newest first; null when the reviews are unknown. */
  reviewed: ReadonlyArray<{ pull: OpenPull; review: PrReview }> | null;
}

export interface HomeModelOptions {
  adapters: HomeAdapters;
  /** The launch's model, `provider/id`: its provider is the one counted until
   * pi says which model the chat runs on. */
  model: string;
  tools: HomeToolSet;
  /** Something the panel shows changed. */
  onChange?: () => void;
  /** Run `fn` once after `ms`; the returned function cancels it. */
  after?: (ms: number, fn: () => void) => () => void;
  /** Ask the person to pick one option; undefined when nobody answered. */
  ask?: (question: string, options: string[]) => Promise<string | undefined>;
  /** Put a message in the chat. */
  send?: (message: { content: string; details: Record<string, unknown> }) => void;
  /** The person's posting rule (pi's settings, `quickreview.posting`). */
  postingRule?: () => PostingRule;
  /** The setup checklist's gaps (src/home/setup.ts); none without one. */
  gaps?: () => SetupGap[];
  /** Every read has landed: the checklist detects over it, before the
   * first notice. */
  onRead?: () => Promise<void>;
}

/** How long the cursor rests on a PR before the home prices it. */
export const PRICE_REST_MS = 500;
/** How often a running review's status is read. */
export const STATUS_POLL_MS = 2000;

/** "about $1.33, stops at $2.66", or what is not known of it. */
export function priceWords(est: number | null, cap: number | null): string {
  if (est === null) return "price unknown";
  return `about ${money(est)}${cap === null ? ", no hard stop" : `, stops at ${money(cap)}`}`;
}

const noTimer = (): (() => void) => () => {};

/** The provider of a `provider/id` model. */
export function providerOf(model: string): string {
  return model.split("/")[0] ?? model;
}

/** The provider as a person names it. */
export function providerLabel(provider: string): string {
  return provider === "openai-codex" || provider === "openai" ? "OpenAI" : provider;
}

export function pullUrl(repo: string, pr: number): string {
  return `https://github.com/${repo}/pull/${pr}`;
}

/** A short age: 5m, 3h, 2d. */
export function ago(thenMs: number, nowMs: number): string {
  if (!Number.isFinite(thenMs)) return "?";
  const m = Math.max(0, (nowMs - thenMs) / 60_000);
  return m < 60
    ? `${Math.round(m)}m`
    : m < 1440
      ? `${Math.round(m / 60)}h`
      : `${Math.round(m / 1440)}d`;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A port's answer; a port that throws instead of answering is unknown. */
async function safe<T>(read: () => Promise<Known<T>>): Promise<Known<T>> {
  try {
    return await read();
  } catch (err) {
    return unknown(message(err));
  }
}

/** An action port's outcome; one that throws is a refusal with its message. */
async function attempt<T>(act: () => Promise<Outcome<T>>): Promise<Outcome<T>> {
  try {
    return await act();
  } catch (err) {
    return { ok: false, why: message(err) };
  }
}

const later = (a: PrReview | undefined, b: PrReview | undefined): PrReview | undefined =>
  a === undefined ? b : b === undefined ? a : b.at > a.at ? b : a;

const newestFirst = (a: OpenPull, b: OpenPull): number => b.number - a.number;

const valueOf = <T>(s: Slot<T>): T | undefined => (s.kind === "known" ? s.value : undefined);
const nullable = <T>(s: Slot<T>): T | null => (s.kind === "known" ? s.value : null);

export class HomeModel {
  readonly state: HomeState = {
    login: PENDING,
    github: PENDING,
    repo: PENDING,
    pulls: PENDING,
    reviews: PENDING,
    autoRounds: PENDING,
    autoReview: PENDING,
    trigger: null,
    memory: PENDING,
    spend: PENDING,
    loginHealth: null,
  };
  /** Slots a switch shows its own state in while it runs (src/home/switches.ts):
   * a refresh does not overwrite them until released. */
  private readonly held = new Set<keyof HomeState>();
  /** The selected pull request's number. */
  selected: number | null = null;
  notice: Notice | null = null;
  readonly tools: HomeToolSet;
  private provider: string;
  private inFlight: Promise<string> | null = null;
  private greeted = false;
  private pullsWarned = false;
  /** The latest run per PR this home started or re-attached to. */
  readonly runs = new Map<number, Run>();
  /** Quotes by PR, each for the head it priced. */
  private quotes = new Map<number, { sha: string; q: Slot<ReviewQuote> }>();
  /** The pending rest timer's cancel. */
  private pricer: (() => void) | null = null;
  /** The one background preview in flight. */
  private pricing: { pr: number; stop: AbortController } | null = null;
  private timers = new Set<() => void>();
  /** PRs whose review the person stopped before it had a run id. */
  private stopping = new Set<number>();
  private attachedTo: string | null = null;
  private disposed = false;
  /** pi refused the chat for its login: the error it showed. */
  private chatLoginError: string | null = null;
  /** When the person last signed in again, ms since the epoch. */
  private reloggedAt: number | null = null;
  private readonly after: (ms: number, fn: () => void) => () => void;

  constructor(private readonly o: HomeModelOptions) {
    this.tools = o.tools;
    this.provider = providerOf(o.model);
    this.after = o.after ?? noTimer;
    if (o.adapters.autoReview.trigger) this.state.trigger = PENDING;
    if (o.adapters.loginOwner) this.state.loginHealth = PENDING;
  }

  /** The session ended: no timer fires and no preview runs. Runs go on. */
  dispose(): void {
    this.disposed = true;
    this.pricer?.();
    this.pricer = null;
    this.pricing?.stop.abort();
    this.pricing = null;
    for (const cancel of this.timers) cancel();
    this.timers.clear();
  }

  private changed(): void {
    this.o.onChange?.();
  }

  now(): number {
    return this.o.adapters.clock.now();
  }

  /** The provider the chat's model runs on: the one login that counts. */
  chatProvider(): string {
    return this.provider;
  }

  /** pi chose another model (at start, or the person's /model). */
  setChatModel(provider: string | undefined): void {
    if (provider === undefined || provider === this.provider) return;
    this.provider = provider;
    this.changed();
  }

  /** Signed in for the chat's provider: true, false, or null when the auth
   * file could not be read. A login under another provider is not one. */
  signedIn(): boolean | null {
    const l = this.state.login;
    return l.kind === "known" ? l.value.includes(this.provider) : null;
  }

  // ---- one login per box (src/home/loginowner.ts) -------------------------

  /** pi refused the chat for its login (extensions/home.ts reads its error). */
  loginFailed(why: string): void {
    if (this.chatLoginError === why) return;
    this.chatLoginError = why;
    this.changed();
  }

  /** pi answered the chat: the login works. */
  chatAnswered(): void {
    if (this.chatLoginError === null) return;
    this.chatLoginError = null;
    this.changed();
  }

  /** The person signed in again: what said the old login failed is past. */
  signedInAgain(): void {
    this.chatLoginError = null;
    this.reloggedAt = this.now();
    this.changed();
  }

  /** Why the login no longer works ("login expired"), or null while nothing
   * says so. */
  loginExpired(): string | null {
    if (this.chatLoginError !== null) return "login expired";
    const h = this.state.loginHealth;
    if (
      h?.kind === "known" &&
      h.value.expired !== undefined &&
      !(this.reloggedAt !== null && (h.value.checkedAt ?? 0) < this.reloggedAt)
    )
      return h.value.expired;
    const a = this.state.autoReview;
    if (
      a.kind === "known" &&
      a.value.state === "paused-login" &&
      a.value.cause === "login expired" &&
      !(this.reloggedAt !== null && this.now() - this.reloggedAt < RELOGIN_GRACE_MS)
    )
      return "login expired";
    return null;
  }

  /** Who refreshes the login now; null when that is not known. */
  refreshedBy(): "auto-review" | "home" | null {
    const h = this.state.loginHealth;
    return h?.kind === "known" ? h.value.refresher : null;
  }

  /** The setup steps a read showed to be needed: the checklist's gaps. */
  gaps(): SetupGap[] {
    return this.o.gaps?.() ?? [];
  }

  /** Is anything still being read? */
  busy(): boolean {
    return (
      this.inFlight !== null ||
      this.pricing !== null ||
      [...this.runs.keys()].some((pr) => this.isRunning(pr))
    );
  }

  repo(): string | null {
    const r = valueOf(this.state.repo);
    return typeof r === "string" ? r : null;
  }

  /** The lists, or null when the open pull requests are not known. */
  lists(): HomeLists | null {
    const pulls = valueOf(this.state.pulls);
    if (pulls === undefined) return null;
    const sorted = [...pulls].sort(newestFirst);
    if (valueOf(this.state.reviews) === undefined) return { toReview: sorted, reviewed: null };
    return {
      toReview: sorted.filter((p) => this.reviewOf(p.number) === undefined),
      reviewed: sorted.flatMap((p) => {
        const review = this.reviewOf(p.number);
        return review ? [{ pull: p, review }] : [];
      }),
    };
  }

  /** Why auto-review's half of the Reviewed list is unknown; null when known. */
  autoUnknown(): string | null {
    const a = this.state.autoRounds;
    return a.kind === "unknown" ? a.why : null;
  }

  /** Every listed pull request, in the panel's order: To review, then Reviewed. */
  ordered(): OpenPull[] {
    const l = this.lists();
    return l ? [...l.toReview, ...(l.reviewed ?? []).map((r) => r.pull)] : [];
  }

  selectedPull(): OpenPull | undefined {
    return this.ordered().find((p) => p.number === this.selected);
  }

  /** The latest review of `pr`: this home's finished run, the person's own
   * reviews, or auto-review's, whichever finished last. */
  reviewOf(pr: number): PrReview | undefined {
    const run = this.runs.get(pr);
    const mine = run?.stage === "done" ? runReview(run) : undefined;
    return later(
      later(valueOf(this.state.reviews)?.get(pr), valueOf(this.state.autoRounds)?.get(pr)),
      mine,
    );
  }

  /** Is a review of `pr` under way (pricing, starting or running)? */
  isRunning(pr: number): boolean {
    const r = this.runs.get(pr);
    return r !== undefined && r.stage !== "done" && r.stage !== "failed";
  }

  /** The PR's price, for its head: pending while it is being priced, null
   * before it was asked for. */
  quoteOf(p: OpenPull): Slot<ReviewQuote> | null {
    const e = this.quotes.get(p.number);
    return e !== undefined && e.sha === p.headSha ? e.q : null;
  }

  say(text: string, kind: NoticeKind = "info"): void {
    this.notice = { text, kind };
    this.changed();
  }

  // ---- the actions ------------------------------------------------------

  /** Read every source again. A refresh already running is joined. */
  refresh(): Promise<string> {
    this.inFlight ??= this.detect().finally(() => {
      this.inFlight = null;
      this.changed();
    });
    return this.inFlight;
  }

  private async detect(): Promise<string> {
    const a = this.o.adapters;
    const land =
      <K extends keyof HomeState>(key: K) =>
      (v: HomeState[K]): void => {
        if (this.held.has(key)) return;
        this.state[key] = v;
        this.changed();
      };
    const side = Promise.all([
      safe(() => a.login.providers()).then(land("login")),
      safe(() => a.github.user()).then(land("github")),
      safe(() => a.autoReview.status()).then(land("autoReview")),
      safe(() => a.memory.status()).then(land("memory")),
      a.autoReview.trigger
        ? safe(() => a.autoReview.trigger!()).then(land("trigger"))
        : Promise.resolve(),
      safe(() => a.spend.totals()).then(land("spend")),
      a.loginOwner
        ? safe(() => a.loginOwner!.health()).then(land("loginHealth"))
        : Promise.resolve(),
    ]);
    const repo = await safe(() => a.repo.repo());
    land("repo")(repo);
    if (repo.kind === "unknown") {
      const why = `can't read the repository from your qcr config: ${repo.why}`;
      this.state.pulls = unknown(why);
      this.state.reviews = unknown(why);
      this.state.autoRounds = unknown(why);
    } else if (repo.value === null) {
      this.state.pulls = unknown("no repository is chosen");
      this.state.reviews = unknown("no repository is chosen");
      this.state.autoRounds = unknown("no repository is chosen");
    } else {
      const name = repo.value;
      const [pulls, reviews, autoRounds] = await Promise.all([
        safe(() => a.github.openPulls(name)),
        safe(() => a.reviews.latest(name)),
        safe(() => a.reviews.autoRounds(name)),
        this.attach(name),
      ]);
      this.state.pulls = pulls;
      this.state.reviews = reviews;
      this.state.autoRounds = autoRounds;
    }
    this.keepSelection();
    await side;
    // the checklist never throws (a step's detect that does is a missing)
    await this.o.onRead?.();
    this.greet();
    return this.summary();
  }

  /** The selection survives a refresh while its PR is listed; else the first row. */
  private keepSelection(): void {
    const rows = this.ordered();
    if (!rows.some((p) => p.number === this.selected)) this.selected = rows[0]?.number ?? null;
    this.rested();
  }

  /** The first notice, once everything has been read. */
  private greet(): void {
    const repo = this.repo();
    if (this.state.pulls.kind === "unknown" && repo !== null) {
      this.pullsWarned = true;
      this.say(`Couldn't read ${repo}'s pull requests: ${this.state.pulls.why}.`, "warn");
      return;
    }
    if (this.pullsWarned) {
      // the list came back: the warning about it no longer holds
      this.pullsWarned = false;
      const open = this.ordered().length;
      this.say(`${open} open pull request${open === 1 ? "" : "s"}.`, "ok");
      return;
    }
    if (this.greeted) return;
    this.greeted = true;
    const gaps = this.gaps();
    if (gaps.length > 0) {
      this.say("Not set up yet: the steps above say what is missing.", "warn");
      return;
    }
    const user = nullable(this.state.github);
    const found = [
      this.signedIn() ? `your ${providerLabel(this.provider)} login` : null,
      user ? `GitHub @${user}` : null,
      repo ? `${repo} from your qcr config` : null,
    ].filter((x): x is string => x !== null);
    const open = this.ordered().length;
    this.say(
      found.length === 3
        ? `Found ${found[0]}, ${found[1]} and ${found[2]}: you're set. ${open} open pull request${open === 1 ? "" : "s"}.`
        : `${open} open pull request${open === 1 ? "" : "s"}.`,
      "ok",
    );
  }

  private summary(): string {
    const l = this.lists();
    if (l === null) {
      const p = this.state.pulls;
      return p.kind === "unknown" ? `pull requests unknown: ${p.why}` : "still reading";
    }
    return `${l.toReview.length} to review, ${l.reviewed === null ? "reviewed unknown" : `${l.reviewed.length} reviewed`}`;
  }

  /** Move the selection by `by` rows through both lists. */
  move(by: number): string {
    const rows = this.ordered();
    if (rows.length === 0) return "there is no pull request to move to";
    const at = rows.findIndex((p) => p.number === this.selected);
    const next = rows[Math.max(0, Math.min(rows.length - 1, (at < 0 ? 0 : at) + Math.trunc(by)))]!;
    this.selected = next.number;
    this.rested();
    this.changed();
    return `selected #${next.number} ${next.title}`;
  }

  /** Select one listed pull request (a hover or a click does this). */
  select(pr: number): string {
    const p = this.ordered().find((x) => x.number === pr);
    if (!p) {
      const repo = this.repo();
      return `#${pr} is not listed: it is not an open pull request${repo ? ` in ${repo}` : ""}, or the list is not known`;
    }
    if (this.selected !== pr) {
      this.selected = pr;
      this.rested();
      this.changed();
    }
    return `selected #${p.number} ${p.title}`;
  }

  /** Open a pull request (by default the selected one) in the browser. */
  async openPr(pr?: number): Promise<string> {
    const repo = this.repo();
    if (repo === null) {
      const r = this.state.repo;
      return r.kind === "unknown"
        ? `the repository is unknown (${r.why}), so there is nothing to open`
        : "no repository is chosen, so there is nothing to open";
    }
    const n = pr ?? this.selected;
    if (n === null) return "no pull request is selected";
    const url = pullUrl(repo, n);
    const r = await this.o.adapters.github
      .openInBrowser(repo, n)
      .catch((err: unknown) => ({ ok: false as const, why: message(err) }));
    if (r.ok) {
      this.say(`Opened #${n} in your browser.`, "ok");
      return `opened ${url} in the browser`;
    }
    this.say(`Couldn't open a browser (${r.why}). The pull request is at ${url}`, "warn");
    return `couldn't open a browser (${r.why}); the pull request is at ${url}`;
  }

  // ---- the review button ------------------------------------------------

  /** A PR's price for the model: null until it is quoted. */
  private priceOf(p: OpenPull): Record<string, unknown> | null {
    const q = this.quoteOf(p);
    if (q === null || q.kind === "pending") return null;
    return q.kind === "known"
      ? { estimate_usd: q.value.estimateUsd, cap_usd: q.value.capUsd }
      : { unknown_because: q.why };
  }

  private pullOf(pr: number): OpenPull | undefined {
    return this.ordered().find((p) => p.number === pr);
  }

  /** The cursor came to rest on a PR: price it in a moment, unless its head
   * is priced already. A rest on another PR first cancels this one's. */
  private rested(): void {
    this.pricer?.();
    this.pricer = null;
    const p = this.selectedPull();
    if (this.disposed || !p || this.quoteOf(p) !== null || this.isRunning(p.number)) return;
    this.pricer = this.after(PRICE_REST_MS, () => {
      this.pricer = null;
      void this.priceSelected();
    });
  }

  /** Give way: the background preview in flight stops, and its PR is left
   * unpriced (the next rest on it prices it again). */
  private yieldPricing(): void {
    const p = this.pricing;
    if (p === null) return;
    p.stop.abort();
    this.pricing = null;
    if (this.quotes.get(p.pr)?.q.kind === "pending") this.quotes.delete(p.pr);
  }

  /** Price the PR the cursor rests on: one preview at a time. */
  private async priceSelected(): Promise<void> {
    const repo = this.repo();
    const p = this.selectedPull();
    if (repo === null || !p || this.quoteOf(p) !== null || this.isRunning(p.number)) return;
    this.yieldPricing();
    const stop = new AbortController();
    this.pricing = { pr: p.number, stop };
    this.quotes.set(p.number, { sha: p.headSha, q: PENDING });
    this.changed();
    const r = await attempt(() =>
      this.o.adapters.reviews.preview(repo, p.number, { signal: stop.signal }),
    );
    if (this.pricing?.stop === stop) this.pricing = null;
    if (stop.signal.aborted) return;
    this.quotes.set(p.number, { sha: p.headSha, q: r.ok ? known(r.quote) : unknown(r.why) });
    this.changed();
  }

  /** ⏎ (or alt+r): review the selected PR, or show its review when it has
   * one and none is running. */
  enter(): Promise<string> {
    const p = this.selectedPull();
    if (p && !this.isRunning(p.number) && this.reviewOf(p.number))
      return Promise.resolve(this.showReview(p.number));
    return this.review();
  }

  /** Refused before anything starts: why the review button cannot act. */
  private cannotAct(pr: number | undefined): string | OpenPull {
    const repo = this.repo();
    if (repo === null) {
      const r = this.state.repo;
      return r.kind === "unknown"
        ? `the repository is unknown (${r.why}), so there is nothing to review`
        : "no repository is chosen, so there is nothing to review";
    }
    const gaps = this.gaps();
    if (gaps.length > 0) return `finish setup first: ${gaps.join(", ")}`;
    const n = pr ?? this.selected;
    if (n === null) return "no pull request is selected";
    return (
      this.pullOf(n) ??
      `#${n} is not listed: it is not an open pull request in ${repo}, or the list is not known`
    );
  }

  /** Review a pull request (by default the selected one) in the background:
   * preview it, start a detached run with the preview's key, follow it. The
   * run writes its report to a file and never posts by itself. */
  async review(pr?: number): Promise<string> {
    const target = this.cannotAct(pr);
    if (typeof target === "string") return target;
    const repo = this.repo()!;
    const n = target.number;
    const running = this.runs.get(n);
    if (running && this.isRunning(n))
      return `#${n} is already being reviewed${running.runId ? ` (run ${running.runId})` : ""}`;
    const run = plannedRun(n, this.now());
    this.runs.set(n, run);
    this.stopping.delete(n);
    this.selected = n;
    this.pricer?.();
    this.pricer = null;
    this.yieldPricing();
    this.say(`Pricing the review of #${n}…`);
    const fail = (why: string): string => {
      run.stage = "failed";
      run.error = why;
      run.ended = this.now();
      this.say(`#${n} was not reviewed: ${why}. It can be reviewed again.`, "warn");
      return `the review of #${n} did not start: ${why}`;
    };
    const reviews = this.o.adapters.reviews;
    const pre = await attempt(() => reviews.preview(repo, n));
    this.quotes.set(n, { sha: target.headSha, q: pre.ok ? known(pre.quote) : unknown(pre.why) });
    if (!pre.ok) return fail(`the preview failed: ${pre.why}`);
    if (this.stopping.delete(n)) return fail("you stopped it");
    quoteRun(run, pre.quote);
    run.now = "starting the review";
    this.changed();
    const st = await attempt(() => reviews.start(repo, n, pre.quote.key));
    if (!st.ok) return fail(st.why);
    run.runId = st.runId;
    run.report = st.report;
    run.now = "fetching the pull request";
    this.say(`Reviewing #${n} in the background — ${priceWords(run.est, run.cap)}. Keep chatting.`);
    if (this.stopping.delete(n)) void this.stopReview(n);
    this.follow(run);
    return `the review of #${n} started (run ${st.runId}, ${priceWords(run.est, run.cap)}); it writes its report to ${st.report} and posts nothing by itself`;
  }

  /** Poll a run's status until it is over. */
  private follow(run: Run): void {
    if (this.disposed) return;
    const cancel = this.after(STATUS_POLL_MS, () => {
      this.timers.delete(cancel);
      void this.poll(run);
    });
    this.timers.add(cancel);
  }

  private async poll(run: Run): Promise<void> {
    if (this.disposed || run.runId === undefined) return;
    const id = run.runId;
    const s = await safe(() => this.o.adapters.reviews.status(id));
    if (this.disposed || this.runs.get(run.pr) !== run) return;
    if (s.kind === "unknown") {
      run.now = `can't read its status: ${s.why}`;
      this.changed();
      return this.follow(run);
    }
    const over = foldStatus(run, s.value, this.now());
    this.changed();
    if (!over) return this.follow(run);
    await this.finished(run);
  }

  /** A run this home followed is over: say how, then the posting rule. */
  private async finished(run: Run): Promise<void> {
    const n = run.pr;
    if (run.stage === "failed") {
      this.say(
        `#${n} was not reviewed: ${run.error ?? "unknown"}. It can be reviewed again.`,
        "warn",
      );
      return;
    }
    const high = run.findings.filter((f) => f.sev === "high").length;
    this.selected = n;
    this.say(
      `#${n} reviewed — ${plural(run.findings.length, "finding")}${high ? `, ${high} high` : ""}. ${"⏎"} shows them.`,
      "ok",
    );
    await this.offerPost(run);
  }

  /** After a finished review the person's posting rule applies: never, always,
   * or ask with "No, keep it here" first. Nobody to ask is a no. */
  private async offerPost(run: Run): Promise<void> {
    const file = run.postFile;
    const repo = this.repo();
    if (file === undefined || repo === null) return;
    const rule = this.o.postingRule?.() ?? "ask";
    const n = run.pr;
    if (rule === "never") return;
    if (rule === "always") {
      this.say(`Posting the review of #${n} to GitHub, as your posting rule says…`);
      return this.postNow(n, file);
    }
    const ask = this.o.ask;
    if (ask === undefined) return;
    // the review first, so the question is about something the person has read
    this.showReview(n);
    const dry = await safe(() => this.o.adapters.reviews.dryRun());
    const yes =
      dry.kind === "known"
        ? postAnswer(dry.value)
        : "Yes, post it as a comment-only review (your install's dry_run decides whether it is sent)";
    let picked: string | undefined;
    try {
      picked = await ask(`Post the review of #${n} (${repo}) on GitHub as a comment-only review?`, [
        KEEP_IT_HERE,
        yes,
      ]);
    } catch {
      picked = undefined;
    }
    if (picked !== yes) {
      this.say(`The review of #${n} stays here: nothing was posted.`);
      return;
    }
    await this.postNow(n, file);
  }

  private async postNow(n: number, file: string): Promise<void> {
    const r = await attempt(() => this.o.adapters.reviews.post(file));
    this.say(r.ok ? r.line : `The review of #${n} was not posted: ${r.why}`, r.ok ? "ok" : "warn");
  }

  /** Put a reviewed PR's findings in the chat as a message. */
  showReview(pr?: number): string {
    const n = pr ?? this.selected;
    if (n === null) return "no pull request is selected";
    const review = this.reviewOf(n);
    if (!review) return `#${n} has no review yet`;
    const title = this.pullOf(n)?.title ?? "";
    const content = reviewMessage({ pr: n, title, review });
    if (!this.o.send) return content;
    this.o.send({
      content,
      details: { repo: this.repo(), pr: n, by: review.by, findings: review.list ?? null },
    });
    return `the review of #${n} is in the chat`;
  }

  /** Stop the review of a pull request (by default the selected one). The PR
   * is reviewable again once its status says it stopped. */
  async stopReview(pr?: number): Promise<string> {
    const n = pr ?? this.selected;
    if (n === null) return "no pull request is selected";
    const run = this.runs.get(n);
    if (!run || !this.isRunning(n)) return `no review of #${n} is running`;
    if (run.runId === undefined) {
      // still pricing or starting: it stops as soon as it has a run
      this.stopping.add(n);
      this.say(`Stopping the review of #${n}…`);
      return `the review of #${n} stops as soon as it starts`;
    }
    const r = await attempt(() => this.o.adapters.reviews.stop(run.runId!));
    if (!r.ok) {
      this.say(`Couldn't stop the review of #${n}: ${r.why}`, "warn");
      return `couldn't stop the review of #${n}: ${r.why}`;
    }
    this.say(`Stopping the review of #${n}…`);
    return `stopped the review of #${n} (run ${run.runId})`;
  }

  /** On opening (and on a new repository): the registry's runs of `repo`.
   * A running one is followed, a finished or failed one shown; nothing is
   * asked about a run that ended while the home was closed. */
  private async attach(repo: string): Promise<void> {
    if (this.attachedTo === repo) return;
    this.attachedTo = repo;
    const r = await safe(() => this.o.adapters.reviews.runs(repo));
    if (r.kind === "unknown" || this.disposed) return;
    const latest = new Map<number, ReviewRunStatus>();
    for (const s of r.value) if (s.pr !== null && s.repo === repo) latest.set(s.pr, s);
    for (const [pr, s] of latest) {
      if (this.runs.has(pr)) continue;
      const run = attachedRun(s);
      foldStatus(run, s, this.now());
      this.runs.set(pr, run);
      if (s.state === "running") this.follow(run);
    }
    this.changed();
  }

  // ---- the switches (src/home/switches.ts) ------------------------------

  /** Can the home switch auto-review / memory, or only show them? */
  canSwitch(what: "autoReview" | "memory"): boolean {
    return this.o.adapters[what].control !== undefined;
  }

  /** Memory's switch, when the home has one. */
  memoryControl(): MemoryControl | undefined {
    return this.o.adapters.memory.control;
  }

  /** The trigger label, when known. */
  trigger(): string | null {
    const t = this.state.trigger;
    return t?.kind === "known" ? t.value : null;
  }

  private switchHost(): SwitchHost {
    const hold = (slot: "autoReview" | "memory", v: Known<unknown>): void => {
      (this.state as unknown as Record<string, unknown>)[slot] = v;
      this.held.add(slot);
      this.changed();
    };
    return {
      autoReview: () => this.state.autoReview,
      memory: () => this.state.memory,
      trigger: () => this.trigger(),
      repo: () => this.repo(),
      say: (text, kind) => this.say(text, kind),
      hold,
      release: (slot) => {
        this.held.delete(slot);
      },
      refresh: () => this.refresh(),
    };
  }

  /** Switch auto-review on or off: every question asked through `ask`. */
  switchAutoReview(ask: Ask | undefined): Promise<string> {
    return switchAutoReview(this.switchHost(), this.o.adapters, ask);
  }

  /** Switch memory on or off: its own switch, auto-review untouched. */
  switchMemory(ask: Ask | undefined): Promise<string> {
    return switchMemory(this.switchHost(), this.o.adapters, ask);
  }

  /** The login's owner and health, for the model: null when unknown. */
  private loginOwnerStatus(h: Slot<LoginHealth>): Record<string, unknown> {
    const expired = this.loginExpired();
    return {
      refreshed_by: this.refreshedBy(),
      expired: expired !== null ? true : h.kind === "known" ? false : null,
      ...(h.kind === "unknown" ? { refresher_unknown_because: h.why } : {}),
    };
  }

  /** What the panel shows, for the model: an unknown source is null, never
   * absent and never zero. */
  status(): Record<string, unknown> {
    const l = this.lists();
    const why = <T>(s: Slot<T>): string | null => (s.kind === "unknown" ? s.why : null);
    const auto = this.state.autoReview;
    return {
      repo: nullable(this.state.repo),
      login: {
        provider: this.provider,
        signed_in: this.signedIn(),
        ...(why(this.state.login) ? { unknown_because: why(this.state.login) } : {}),
        ...(this.state.loginHealth ? this.loginOwnerStatus(this.state.loginHealth) : {}),
      },
      github: {
        user: nullable(this.state.github),
        signed_in: this.state.github.kind === "known" ? this.state.github.value !== null : null,
      },
      tools: this.tools,
      setup_needed: this.gaps(),
      auto_review: auto.kind === "known" ? auto.value : null,
      ...(auto.kind === "unknown" ? { auto_review_unknown_because: auto.why } : {}),
      ...(this.state.trigger
        ? { auto_review_picks_up: { trigger_label: this.trigger(), review_requests: true } }
        : {}),
      memory: nullable(this.state.memory),
      spend: nullable(this.state.spend),
      to_review: l ? l.toReview.map((p) => ({ ...row(p), price: this.priceOf(p) })) : null,
      reviewed: l?.reviewed ? l.reviewed.map((r) => ({ ...row(r.pull), review: r.review })) : null,
      ...(l?.reviewed && this.autoUnknown() !== null
        ? { auto_reviews_unknown_because: this.autoUnknown() }
        : {}),
      reviewing: [...this.runs.values()]
        .filter((r) => this.isRunning(r.pr))
        .map((r) => ({
          number: r.pr,
          run_id: r.runId ?? null,
          stage: r.stage,
          estimate_usd: r.est,
          cap_usd: r.cap,
          lenses: r.lenses.map((x) => ({ name: x.name, state: x.state, tools: x.tools })),
        })),
      ...(why(this.state.pulls) ? { pull_requests_unknown_because: why(this.state.pulls) } : {}),
      selected: this.selected,
    };
  }
}

function row(p: OpenPull): Record<string, unknown> {
  return {
    number: p.number,
    title: p.title,
    author: p.author,
    updated_at: p.updatedAt,
    draft: p.isDraft,
    branch: p.headRefName,
  };
}
