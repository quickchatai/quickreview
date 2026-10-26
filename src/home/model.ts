// The home's state and its actions, over the ports (src/home/ports.ts). No
// pi here: extensions/home.ts registers each action as a key and as a
// `home_*` tool, and src/home/panel.ts draws the state. Every action is one
// method, so a key and a tool can never do two different things.
//
// Detection reads every port at once; a slot is pending until its read lands,
// then known or unknown. The setup gaps are only the things a read showed to
// be missing (no login for the chat's provider, `gh` signed out, no
// repository): a source that could not be read is Unknown, never a gap and
// never a zero (invariant 9).
import type { HomeToolSet } from "../config.js";
import {
  PENDING,
  unknown,
  type AutoReviewStatus,
  type HomeAdapters,
  type Known,
  type MemoryControl,
  type MemoryState,
  type OpenPull,
  type PrReview,
  type Slot,
  type SpendTotals,
} from "./ports.js";
import { switchAutoReview, switchMemory, type Ask, type SwitchHost } from "./switches.js";

export type NoticeKind = "info" | "ok" | "warn";
export interface Notice {
  text: string;
  kind: NoticeKind;
}

/** What a read showed to be missing: the setup checklist's steps. */
export type SetupGap = "login" | "github" | "repo";

export interface HomeState {
  /** The providers pi holds a login for, in the chat's pi home. */
  login: Slot<readonly string[]>;
  /** The `gh` account; null when signed out. */
  github: Slot<string | null>;
  /** The configured repository; null when none is chosen. */
  repo: Slot<string | null>;
  pulls: Slot<readonly OpenPull[]>;
  reviews: Slot<ReadonlyMap<number, PrReview>>;
  autoReview: Slot<AutoReviewStatus>;
  /** What auto-review picks up besides a review request: the trigger
   * label; null when the port does not report it. */
  trigger: Slot<string> | null;
  memory: Slot<MemoryState>;
  spend: Slot<SpendTotals>;
}

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
}

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
    autoReview: PENDING,
    trigger: null,
    memory: PENDING,
    spend: PENDING,
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

  constructor(private readonly o: HomeModelOptions) {
    this.tools = o.tools;
    this.provider = providerOf(o.model);
    if (o.adapters.autoReview.trigger) this.state.trigger = PENDING;
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

  /** The setup steps a read showed to be needed. */
  gaps(): SetupGap[] {
    const out: SetupGap[] = [];
    if (this.signedIn() === false) out.push("login");
    if (this.state.github.kind === "known" && this.state.github.value === null) out.push("github");
    if (this.state.repo.kind === "known" && this.state.repo.value === null) out.push("repo");
    return out;
  }

  /** Is anything still being read? */
  busy(): boolean {
    return this.inFlight !== null;
  }

  repo(): string | null {
    const r = valueOf(this.state.repo);
    return typeof r === "string" ? r : null;
  }

  /** The lists, or null when the open pull requests are not known. */
  lists(): HomeLists | null {
    const pulls = valueOf(this.state.pulls);
    if (pulls === undefined) return null;
    const reviews = valueOf(this.state.reviews);
    const sorted = [...pulls].sort(newestFirst);
    if (reviews === undefined) return { toReview: sorted, reviewed: null };
    return {
      toReview: sorted.filter((p) => !reviews.has(p.number)),
      reviewed: sorted.flatMap((p) => {
        const review = reviews.get(p.number);
        return review ? [{ pull: p, review }] : [];
      }),
    };
  }

  /** Every listed pull request, in the panel's order: To review, then Reviewed. */
  ordered(): OpenPull[] {
    const l = this.lists();
    return l ? [...l.toReview, ...(l.reviewed ?? []).map((r) => r.pull)] : [];
  }

  selectedPull(): OpenPull | undefined {
    return this.ordered().find((p) => p.number === this.selected);
  }

  reviewOf(pr: number): PrReview | undefined {
    return valueOf(this.state.reviews)?.get(pr);
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
    ]);
    const repo = await safe(() => a.repo.repo());
    land("repo")(repo);
    if (repo.kind === "unknown") {
      const why = `can't read the repository from your qcr config: ${repo.why}`;
      this.state.pulls = unknown(why);
      this.state.reviews = unknown(why);
    } else if (repo.value === null) {
      this.state.pulls = unknown("no repository is chosen");
      this.state.reviews = unknown("no repository is chosen");
    } else {
      const name = repo.value;
      const [pulls, reviews] = await Promise.all([
        safe(() => a.github.openPulls(name)),
        safe(() => a.reviews.latest(name)),
      ]);
      this.state.pulls = pulls;
      this.state.reviews = reviews;
    }
    this.keepSelection();
    await side;
    this.greet();
    return this.summary();
  }

  /** The selection survives a refresh while its PR is listed; else the first row. */
  private keepSelection(): void {
    const rows = this.ordered();
    if (!rows.some((p) => p.number === this.selected)) this.selected = rows[0]?.number ?? null;
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
      to_review: l ? l.toReview.map(row) : null,
      reviewed: l?.reviewed ? l.reviewed.map((r) => ({ ...row(r.pull), review: r.review })) : null,
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
