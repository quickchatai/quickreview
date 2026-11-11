// The home's setup checklist: what a fresh machine walks through before the
// home opens on its pull requests. It is the plugin's step registry
// (@quickchatai/pi-quickreview/src/setupchecklist.ts) with the app's steps
// registered onto it, as ADR 0001 names the seam:
//
//   pi_version, git   the plugin's own first-run checks: the card shows one
//                     only while it fails
//   login             "Sign in to a model provider": done when pi has a
//                     usable credential for any provider (its own inventory:
//                     a stored login, a key, the environment). Its run opens
//                     pi's own /login, with every provider pi offers, and
//                     auto-review's refresher paused around it
//                     (src/home/loginowner.ts LoginMenu); it starts by itself
//                     when it is the first thing missing
//   github            `gh` installed and signed in; one key checks again
//   repo              the repository: one of the person's recently pushed
//                     ones, or any owner/name or GitHub URL, written to the
//                     app config's `[github] repo` with the silent defaults
//                     (timezone, base branch, the owner's name and login)
//   review_model      optional, and the plugin's own step id: shown once a
//                     review's quote says two or more providers tie and
//                     nothing was chosen. Its run asks which provider reviews
//                     run on and remembers the answer beside pi's logins, as
//                     `/qcr-setup model` does; dismissing it keeps the order
//
// Each step's detect runs first, over what the home has just read (the
// HomeModel's slots), and a step already true is done with what was found.
// A step whose source cannot be read is Unknown: it stays pending, and is
// never a gap that holds the card up (invariant 9). The card shows while a
// step that a read showed to be missing is left; when the last one is done
// the panel turns into the home.
//
// Every step is one method here, called by a key (alt+n, ⏎ on the focused
// card) and by a `home_*` tool alike (src/home/setuptools.ts). The checklist
// lives in memory: every launch detects afresh.
import {
  AUTOMATIC,
  PLUGIN_SETUP_STEPS,
  pluginSetupSteps,
} from "@quickchatai/pi-quickreview/src/plugin/setup.js";
import type { PluginHost } from "@quickchatai/pi-quickreview/src/plugin/session.js";
import {
  SetupChecklist,
  StepRegistry,
  type Detection,
  type SetupStep,
  type StepReport,
} from "@quickchatai/pi-quickreview/src/setupchecklist.js";
import type { LoginMenu, LoginMenuEnd } from "./loginowner.js";
import { credentialHow, type HomeModel, type SetupGap } from "./model.js";
import type { GithubPort, Known, PiCredential, ReviewQuote } from "./ports.js";

/** The app's step ids, in their order on the card. The review model's is the
 * plugin's own: one step, on both checklists. */
export const HOME_STEPS = {
  login: "login",
  github: "github",
  repo: "repo",
  model: PLUGIN_SETUP_STEPS.model,
} as const;
export type HomeStepId = (typeof HOME_STEPS)[keyof typeof HOME_STEPS];
/** The steps the card always shows; the review model joins them only while
 * its question is open. */
const HOME_STEP_ORDER: readonly HomeStepId[] = [
  HOME_STEPS.login,
  HOME_STEPS.github,
  HOME_STEPS.repo,
];

/** The first step's title: any provider pi supports. */
export const SIGN_IN_TITLE = "Sign in to a model provider";
/** What the step says while pi has no credential. */
export const NO_CREDENTIAL = "pi has no model credential yet";

/** The plugin's steps the home runs as its first-run checks: pi and git
 * (gh is the github step's). The plugin's login, GitHub credential and repo
 * profile steps are the home's own steps' business, or Setup's. */
export const FIRST_RUN_CHECKS: readonly string[] = [PLUGIN_SETUP_STEPS.pi, PLUGIN_SETUP_STEPS.git];

/** Why a sign-in did not finish. */
export type LoginFailureKind =
  /** The person went back to the chat before pi had a credential. */
  | "left"
  /** pi's menu was left open past the home's ceiling. */
  | "timeout"
  /** This pi gave the home no way to open its menu. */
  | "unavailable"
  /** Auto-review's refresher could not be paused: nothing was opened. */
  | "failed";

/** The remembered model choice, as the home writes it: the plugin's choice
 * file beside pi's logins (extensions/home.ts). */
export interface ModelChoicePort {
  /** Remember `provider` as the person's stated choice; null hands the pick
   * back to QuickReview. */
  write(provider: string | null): { ok: true } | { ok: false; why: string };
}

/** The repository pick and what it writes. */
export interface RepoChoice {
  repo: string;
  /** The repository's default branch, as GitHub says. */
  baseBranch: string | null;
  /** The machine's IANA timezone. */
  timezone: string | null;
  ownerName: string | null;
  ownerLogin: string | null;
}

export type RepoWrite = { ok: true; path: string; wrote: string[] } | { ok: false; why: string };

export interface RepoPickPort {
  /** The person's recently pushed repositories, owner/name. */
  recent(): Promise<Known<readonly string[]>>;
  /** What GitHub shows of `repo`: its canonical name and default branch. */
  describe(
    repo: string,
  ): Promise<{ ok: true; repo: string; defaultBranch: string | null } | { ok: false; why: string }>;
  /** The `gh` account's login and name. */
  profile(): Promise<Known<{ login: string; name: string | null }>>;
  /** Write the choice where the home's repo port reads it. */
  write(choice: RepoChoice): Promise<RepoWrite>;
}

/** What the setup is built over, beside the home's own ports. */
export interface HomeSetupPorts {
  /** The first-run checks' facts: the plugin's steps read the running pi's
   * version and PATH from a PluginHost. Absent: no first-run checks. */
  firstRun?: { host: PluginHost; range: string };
  repos?: RepoPickPort;
  /** The machine's IANA timezone, or null. */
  timezone?: () => string | null;
}

/** pi's dialogs, for the repository pick. */
export interface SetupUi {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder: string): Promise<string | undefined>;
}

/** One row of the card, as the card draws it. */
export interface SetupStepView {
  id: HomeStepId;
  title: string;
  state: "done" | "pending" | "running";
  /** What was found, for a done step. */
  found?: string;
  /** Why it is not done yet, as its detect said. */
  missing?: string;
  /** Its source could not be read: neither done nor missing. */
  unknown?: string;
  /** The next step: the one alt+n runs. */
  next: boolean;
}

export interface SetupView {
  /** First-run checks that fail, in order. */
  checks: Array<{ id: string; title: string; why: string; next: boolean }>;
  steps: SetupStepView[];
  /** The sign-in: how pi's menu was opened while it is, the last failure. */
  login: {
    running: boolean;
    how?: "opened" | "prefilled";
    failure?: { kind: LoginFailureKind; why: string };
  };
  done: number;
  total: number;
}

export const PASTE_REPO = "Paste any repository…";

/** owner/name from what a person pastes: owner/name, a github.com URL (a PR
 * or file URL too), or a git remote. Null when it is none of those. */
export function parseRepoInput(text: string): string | null {
  let s = text.trim();
  let wasUrl = false;
  const strip = (re: RegExp): void => {
    if (re.test(s)) {
      s = s.replace(re, "");
      wasUrl = true;
    }
  };
  strip(/^git@github\.com:/i);
  strip(/^(?:(?:https?|ssh|git):\/\/)?(?:[^@/]+@)?(?:www\.)?github\.com\//i);
  s = s.replace(/[?#].*$/, "").replace(/\/+$/, "");
  const parts = s.split("/");
  if (parts.length < 2 || (parts.length > 2 && !wasUrl)) return null;
  const owner = parts[0]!;
  const name = parts[1]!.replace(/\.git$/i, "");
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(owner)) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") return null;
  return `${owner}/${name}`;
}

/** A detect's answer, or Unknown: its source could not be read. */
type Facts = Detection | { unknown: string };

const asDetection = (f: Facts): Detection => ("unknown" in f ? { missing: f.unknown } : f);

const report = (name: string, f: Facts): StepReport =>
  "found" in f
    ? { ok: true, checks: [{ name, ok: true, detail: f.found }] }
    : {
        ok: false,
        checks: [{ name, ok: false, detail: "unknown" in f ? f.unknown : f.missing }],
      };

const refused = (name: string, detail: string): StepReport => ({
  ok: false,
  checks: [{ name, ok: false, detail }],
});

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A sign-in in flight. */
interface Signing {
  how?: "opened" | "prefilled";
  onOpen?: (how: "opened" | "prefilled") => void;
}

/** The review model's question, as a quote asked it. */
interface ModelAsk {
  providers: number;
  /** The model reviews would run on by the order; null when the quote named none. */
  spec: string | null;
}

/** One credential as the login step's facts say it. */
function credentialFact(c: PiCredential): string {
  if (c.from === "login") return `${c.name}, signed in with pi`;
  if (c.from === "environment") return `${c.name}, ${c.label ?? "a credential"} in the environment`;
  return `${c.name}, an API key in pi`;
}

export interface HomeSetupOptions {
  model: HomeModel;
  /** The home's GitHub port: the github step's re-check reads it. */
  github: GithubPort;
  ports: HomeSetupPorts;
  /** pi's own /login with the refresher held around it: the one the
   * re-login uses too. */
  menu: LoginMenu;
  /** Where the review model's answer is remembered. Absent: the step says
   * how to choose in a shell. */
  modelChoice?: ModelChoicePort;
  /** Something the card shows changed. */
  onChange?: () => void;
  /** The card should give way to the home, or the home to the card. */
  onPhase?: (phase: "setup" | "home") => void;
  /** Dialogs and a terminal exist: the login may start by itself. */
  interactive?: () => boolean;
}

export class HomeSetup {
  private readonly checklist: SetupChecklist;
  private readonly checkIds: readonly string[];
  /** Steps whose last detect could not read its source, and why. */
  private readonly unknownWhy = new Map<string, string>();
  private signing: Signing | null = null;
  private failure: { kind: LoginFailureKind; why: string } | null = null;
  /** The review model's question while it is open. */
  private asked: ModelAsk | null = null;
  /** The person answered it (a provider, automatic, or dismissed it): it is
   * not asked again in this session. */
  private decided = false;
  /** What they chose, as the step's found text. */
  private chosen: string | null = null;
  /** The model the latest quote said reviews run on. */
  private reviewSpec: string | null = null;
  private stepping = 0;
  private recentRepos: Promise<Known<readonly string[]>> | null = null;
  private synced = false;
  private autoStarted = false;
  private lastPhase: "setup" | "home" = "home";
  private closed = false;

  constructor(private readonly o: HomeSetupOptions) {
    const checks = o.ports.firstRun
      ? pluginSetupSteps({ host: o.ports.firstRun.host, range: o.ports.firstRun.range }).filter(
          (s) => FIRST_RUN_CHECKS.includes(s.id),
        )
      : [];
    this.checkIds = checks.map((s) => s.id);
    const registry = new StepRegistry(checks).register(...this.homeSteps());
    this.checklist = new SetupChecklist(registry, { clock: () => new Date() }, { file: null });
  }

  private get m(): HomeModel {
    return this.o.model;
  }

  private changed(): void {
    this.o.onChange?.();
  }

  // ---- what each step reads ---------------------------------------------

  private loginFacts(): Facts {
    const l = this.m.state.login;
    if (l.kind === "known") {
      if (l.value.length === 0) return { missing: NO_CREDENTIAL };
      if (l.value.length === 1) return { found: credentialFact(l.value[0]!) };
      const names = l.value.map((c) => c.name).join(", ");
      return {
        found: this.reviewSpec !== null ? `${names}; reviews run on ${this.reviewSpec}` : names,
      };
    }
    // pi's registry could not be read: unknown, never "no credential"
    return {
      unknown:
        l.kind === "unknown" ? `can't read pi's model credentials: ${l.why}` : "still reading",
    };
  }

  private modelFacts(): Facts {
    const a = this.asked;
    if (a === null) return { found: this.chosen ?? "QuickReview picks the provider" };
    return {
      missing: `${a.providers} providers signed in; reviews would run on ${a.spec ?? "the first in pi's order"}`,
    };
  }

  private which(cmd: string): string | null | undefined {
    return this.o.ports.firstRun?.host.runner.which(cmd);
  }

  private githubFacts(): Facts {
    if (this.which("gh") === null)
      return { missing: "gh is not installed: get it from https://cli.github.com" };
    const g = this.m.state.github;
    if (g.kind === "known")
      return g.value === null
        ? { missing: "gh is signed out: run `gh auth login` in a shell" }
        : { found: `@${g.value} · via gh` };
    return { unknown: g.kind === "unknown" ? `can't tell: ${g.why}` : "still reading" };
  }

  private repoFacts(): Facts {
    const r = this.m.state.repo;
    if (r.kind === "known")
      return r.value === null
        ? { missing: "no repository is chosen yet" }
        : { found: `${r.value} · from your qcr config` };
    return {
      unknown: r.kind === "unknown" ? `can't read your qcr config: ${r.why}` : "still reading",
    };
  }

  private facts(id: HomeStepId): Facts {
    return id === HOME_STEPS.login
      ? this.loginFacts()
      : id === HOME_STEPS.github
        ? this.githubFacts()
        : id === HOME_STEPS.repo
          ? this.repoFacts()
          : this.modelFacts();
  }

  /** detect: the facts, noting an Unknown so it never counts as a gap. */
  private detected(id: HomeStepId): Detection {
    const f = this.facts(id);
    if ("unknown" in f) this.unknownWhy.set(id, f.unknown);
    else this.unknownWhy.delete(id);
    return asDetection(f);
  }

  private homeSteps(): SetupStep[] {
    const step = (
      id: HomeStepId,
      title: string,
      order: number,
      explain: string,
      run: SetupStep["run"],
      optional = false,
    ): SetupStep => ({
      id,
      title,
      order,
      explain,
      ...(optional ? { optional: true } : {}),
      detect: async () => this.detected(id),
      run,
      verify: async () => report(title, this.facts(id)),
    });
    return [
      step(
        HOME_STEPS.login,
        SIGN_IN_TITLE,
        10,
        "pi's own /login, with every provider it supports: a login, or an API key. A provider key in the environment counts too.",
        () => this.runLogin(),
      ),
      step(
        HOME_STEPS.github,
        "Connect GitHub",
        11,
        "gh installed and signed in: the home reads the pull requests through it.",
        () => this.runGithub(),
      ),
      step(
        HOME_STEPS.repo,
        "Choose a repository",
        12,
        "The repository the home reviews, written to your qcr config's [github] repo.",
        (ctx) => this.runRepo(ctx.input["repo"]),
      ),
      step(
        HOME_STEPS.model,
        "Review model",
        13,
        "The provider reviews run on, while pi has a credential for more than one and nothing was chosen.",
        (ctx) => this.runModel(ctx.input["provider"]),
        true,
      ),
    ];
  }

  // ---- the steps' runs --------------------------------------------------

  /** Open pi's /login and wait for pi to have a credential. */
  private async runLogin(): Promise<StepReport> {
    const s = this.signing;
    const end = await this.o.menu.run({
      done: async () => (await this.m.readLogin()) === true,
      opened: (how) => {
        if (s !== null) {
          s.how = how;
          s.onOpen?.(how);
        }
        this.changed();
      },
    });
    if (end.kind === "done")
      return { ok: true, checks: [{ name: "login", ok: true, detail: "pi has a credential" }] };
    // a credential that was there all along (a key in the environment)
    if (end.kind === "no-menu" && (await this.m.readLogin()) === true)
      return { ok: true, checks: [{ name: "login", ok: true, detail: "pi has a credential" }] };
    this.failure = loginFailureOf(end);
    return refused("login", this.failure.why);
  }

  /** Remember the provider reviews run on; "" hands the pick back. */
  private async runModel(raw: unknown): Promise<StepReport> {
    const port = this.o.modelChoice;
    if (port === undefined)
      return refused(
        "model",
        "this home cannot remember a choice: run `qcr model use <provider>` in a shell",
      );
    if (typeof raw !== "string")
      return refused("model", "which provider? Choosing is the person's, in the home");
    const provider = raw.trim() === "" ? null : raw.trim();
    if (provider !== null && !this.hasCredential(provider))
      return refused("model", `pi has no credential for ${JSON.stringify(provider)}`);
    const wrote = port.write(provider);
    if (!wrote.ok) return refused("model", `couldn't remember the choice: ${wrote.why}`);
    this.asked = null;
    this.decided = true;
    this.chosen =
      provider === null
        ? "QuickReview picks the provider"
        : `${this.m.nameOf(provider)} · your choice`;
    return { ok: true, checks: [{ name: "model", ok: true, detail: this.chosen }] };
  }

  private hasCredential(provider: string): boolean {
    const l = this.m.state.login;
    return l.kind === "known" && l.value.some((c) => c.provider === provider);
  }

  private async runGithub(): Promise<StepReport> {
    if (this.which("gh") === null)
      return refused("github", "gh is not installed: get it from https://cli.github.com");
    let u: Known<string | null>;
    try {
      u = await this.o.github.user();
    } catch (err) {
      u = { kind: "unknown", why: message(err) };
    }
    if (u.kind === "unknown") return refused("github", `can't tell: ${u.why}`);
    return u.value === null
      ? refused("github", "gh is still signed out: run `gh auth login` in a shell")
      : { ok: true, checks: [{ name: "github", ok: true, detail: `@${u.value} · via gh` }] };
  }

  private async runRepo(raw: unknown): Promise<StepReport> {
    const repos = this.o.ports.repos;
    if (repos === undefined)
      return refused("repo", "this home cannot write your qcr config: set [github] repo in it");
    if (typeof raw !== "string" || raw.trim() === "")
      return refused("repo", "which repository? Give owner/name or a GitHub URL");
    const repo = parseRepoInput(raw);
    if (repo === null)
      return refused(
        "repo",
        `${JSON.stringify(raw.trim())} is not a repository: give owner/name or a GitHub URL`,
      );
    const seen = await repos.describe(repo);
    if (!seen.ok) return refused("repo", `GitHub can't show ${repo}: ${seen.why}`);
    const profile = await repos.profile();
    const wrote = await repos.write({
      repo: seen.repo,
      baseBranch: seen.defaultBranch,
      timezone: this.o.ports.timezone?.() ?? null,
      ownerLogin: profile.kind === "known" ? profile.value.login : null,
      ownerName: profile.kind === "known" ? profile.value.name : null,
    });
    if (!wrote.ok) return refused("repo", `couldn't write your qcr config: ${wrote.why}`);
    return {
      ok: true,
      checks: [{ name: "repo", ok: true, detail: `${seen.repo}, written to ${wrote.path}` }],
    };
  }

  // ---- what the home asks of it -----------------------------------------

  /** Detect again over what the home has just read: a done step is
   * re-verified, a pending one detected. The HomeModel calls it after every
   * read, before its first notice. */
  async sync(): Promise<void> {
    await this.checklist.reconcile();
    await this.checklist.detect();
    // the session ended while the reads were out: their answer lands into nothing
    if (this.closed) return;
    this.synced = true;
    if (this.isPending(HOME_STEPS.repo)) void this.recent();
    this.phased();
    this.maybeStartLogin();
    this.changed();
  }

  /** Tell the host when the card and the home change places. */
  private phased(): void {
    const phase = this.phase();
    if (phase === this.lastPhase) return;
    this.lastPhase = phase;
    this.o.onPhase?.(phase);
  }

  /** A review's quote landed (HomeModel's `onQuote`): the model it would run
   * on, and the review model's question the first time a quote asks it. */
  quoted(q: ReviewQuote): void {
    if (this.closed) return;
    this.reviewSpec = q.model;
    if (q.ask !== true || this.decided || this.asked !== null) return;
    this.asked = { providers: q.providers ?? 2, spec: q.model };
    // the step was done while nothing was asked: it is verified again, and pending now
    void this.sync();
  }

  private isPending(id: string): boolean {
    return this.checklist.list().find((l) => l.id === id)?.status === "pending";
  }

  /** The steps a read showed to be missing, in order: the setup checklist's
   * gaps. An Unknown is none. Empty before the first read. */
  gaps(): SetupGap[] {
    if (!this.synced) return [];
    return this.checklist
      .list()
      .filter((l) => l.status === "pending" && !l.optional && !this.unknownWhy.has(l.id))
      .map((l) => l.id);
  }

  /** The card while a gap is left, or while the review model's question is
   * open (it is optional: answering or dismissing it gives the home back);
   * then the home. */
  phase(): "setup" | "home" {
    return this.gaps().length > 0 || (this.synced && this.asked !== null) ? "setup" : "home";
  }

  /** A step is running: the card's spinner turns. */
  busy(): boolean {
    return this.signing !== null || this.stepping > 0;
  }

  /** The first pending step: what alt+n runs. A sign-in whose state could
   * not be read is never it: an unknown is no gap, and nothing to act on
   * (invariant 9, both halves). */
  private nextId(): string | undefined {
    return this.checklist
      .list()
      .find(
        (l) =>
          l.status === "pending" && !(l.id === HOME_STEPS.login && this.unknownWhy.has(l.id)),
      )?.id;
  }

  /** Read everything again after a step changed it. A read already in
   * flight may have started before the change, so it is joined and then read
   * once more. */
  private async reread(): Promise<void> {
    if (this.closed) return;
    if (this.m.busy()) await this.m.refresh();
    await this.m.refresh();
  }

  /** The login starts by itself when it is the first thing missing. */
  private maybeStartLogin(): void {
    if (this.autoStarted || this.closed || !(this.o.interactive?.() ?? false)) return;
    const gaps = this.gaps();
    if (gaps[0] !== HOME_STEPS.login) return;
    this.autoStarted = true;
    void this.signIn();
  }

  private async step(id: string, input?: Record<string, unknown>) {
    this.stepping++;
    this.changed();
    try {
      return await this.checklist.runStep(id, input);
    } finally {
      this.stepping--;
      this.changed();
    }
  }

  /** Run the next step (alt+n, ⏎ on the card, `home_setup_next`). */
  async next(ui?: SetupUi): Promise<string> {
    const id = this.nextId();
    if (id === undefined) return "setup is done: every step is";
    if (id === HOME_STEPS.login) return this.signIn();
    if (id === HOME_STEPS.github) return this.checkGithub();
    if (id === HOME_STEPS.repo) return this.chooseRepo(undefined, ui);
    if (id === HOME_STEPS.model) return this.chooseModel(ui);
    // a first-run check: look again
    const r = await this.step(id);
    if (r.ok) await this.reread();
    const title = this.checklist.list().find((l) => l.id === id)?.title ?? id;
    return r.ok ? `${title}: ok` : `${title}: ${r.failures.join("; ")}`;
  }

  /** Sign in with pi's own /login. The answer comes once pi's menu is open
   * (or the sign-in could not start): the sign-in itself goes on in the
   * background, until pi has a credential or the person leaves the menu. */
  async signIn(): Promise<string> {
    const s = this.signing;
    if (s !== null || this.o.menu.running())
      return s?.how === "prefilled"
        ? "Still waiting: /login is on the input line, press Enter to open pi's menu."
        : "Still waiting: pi's /login is open, sign in there.";
    const facts = this.loginFacts();
    // unknown is not "signed out": no sign-in is opened for a state the home cannot read
    if ("unknown" in facts)
      return `model login unknown (${facts.unknown}): nothing was opened. Read it again with home_refresh (alt+u).`;
    if (!this.isPending(HOME_STEPS.login))
      return `already signed in: ${"found" in facts ? facts.found : "done"}`;
    const signing: Signing = {};
    this.signing = signing;
    this.failure = null;
    this.changed();
    let answer!: (text: string) => void;
    const answered = new Promise<string>((r) => (answer = r));
    signing.onOpen = (how) => {
      const said =
        how === "opened"
          ? "pi's /login is open: pick a provider there and sign in, or paste an API key."
          : "/login is on the input line: press Enter to open pi's menu, then sign in or paste an API key.";
      this.m.say(said);
      answer(`${said} The home finishes the step once pi has a credential.`);
    };
    void this.checklist.runStep(HOME_STEPS.login).then(async (r) => {
      this.signing = null;
      if (r.ok) {
        await this.reread();
        const name = this.m.credential()?.name ?? "a model provider";
        this.m.say(`Signed in to ${name} with pi.`, "ok");
        answer(`signed in to ${name}`);
      } else {
        const f = this.failure;
        if (!this.closed) this.m.say(loginFailureText(f, "alt+n"), "warn");
        answer(`the sign-in did not finish: ${r.failures.join("; ")}`);
      }
      this.changed();
    });
    return answered;
  }

  /** The review model: ask which provider reviews run on (pi's dialog), and
   * remember the answer. Dismissing the list keeps the order. */
  async chooseModel(ui?: SetupUi): Promise<string> {
    const a = this.asked;
    if (a === null)
      return "there is no provider to choose: reviews run on one, or the choice is made (qcr model shows the route)";
    const l = this.m.state.login;
    const credentials = l.kind === "known" ? l.value : [];
    const facts = `${a.providers} providers signed in; reviews would run on ${a.spec ?? "the first in pi's order"}`;
    if (ui === undefined || credentials.length === 0)
      return `${facts}. Choosing is the person's: alt+n in the home, or \`qcr model use <provider>\` in a shell.`;
    const rows = credentials.map((c) => `${c.name}    ${credentialHow(c)}`);
    const pick = await ui.select("QuickReview: which provider do reviews run on?", [
      ...rows,
      AUTOMATIC,
    ]);
    if (pick === undefined) {
      // dismissed: the order stands, and the home comes back
      this.asked = null;
      this.decided = true;
      await this.sync();
      this.m.say(
        a.spec !== null
          ? `Reviews run on ${a.spec}. \`qcr model use <provider>\` in a shell changes it.`
          : "Reviews run on the provider QuickReview picks.",
      );
      return "no provider was chosen: the order stands";
    }
    const chosen = credentials[rows.indexOf(pick)];
    const r = await this.step(HOME_STEPS.model, { provider: chosen?.provider ?? "" });
    if (!r.ok) {
      const why = r.failures.join("; ").replace(/^model: /, "");
      this.m.say(`${why[0]?.toUpperCase() ?? ""}${why.slice(1)}.`, "warn");
      return why;
    }
    // every quote was priced for the route before the choice
    this.m.requote();
    await this.sync();
    this.m.say(
      chosen !== undefined
        ? `QuickReview will use ${chosen.name} from now on.`
        : "QuickReview picks the model again.",
      "ok",
    );
    return r.checks[0]?.detail ?? "the choice is remembered";
  }

  /** gh: check again (one key). */
  async checkGithub(): Promise<string> {
    const r = await this.step(HOME_STEPS.github);
    await this.reread();
    if (r.ok) {
      this.m.say(`Connected to GitHub as ${r.checks[0]?.detail ?? "you"}.`, "ok");
      return `GitHub: ${r.checks[0]?.detail ?? "signed in"}`;
    }
    const why = r.failures.join("; ");
    this.m.say(`${why.replace(/^github: /, "")}, then press alt+n to check again.`, "warn");
    return why;
  }

  /** The person's recently pushed repositories, read once. */
  recent(): Promise<Known<readonly string[]>> {
    const repos = this.o.ports.repos;
    if (repos === undefined)
      return Promise.resolve({ kind: "unknown", why: "this home cannot list them" });
    this.recentRepos ??= repos.recent().catch((err: unknown) => ({
      kind: "unknown" as const,
      why: message(err),
    }));
    return this.recentRepos;
  }

  /** Choose the repository: `repo` as given (owner/name or a URL), or, with
   * pi's dialogs, picked from the recent ones or pasted. */
  async chooseRepo(repo?: string, ui?: SetupUi): Promise<string> {
    let text = repo;
    if (text === undefined || text.trim() === "") {
      const recent = await this.recent();
      const names = recent.kind === "known" ? [...recent.value] : [];
      if (ui === undefined)
        return recent.kind === "known"
          ? `Which repository? Give owner/name or a GitHub URL as \`repo\`.${names.length ? ` Recently pushed: ${names.join(", ")}.` : ""}`
          : `Which repository? Give owner/name or a GitHub URL as \`repo\`. The recent ones are unknown: ${recent.why}.`;
      const pick = await ui.select(
        names.length ? "Choose a repository: your recently pushed ones" : "Choose a repository",
        [...names, PASTE_REPO],
      );
      if (pick === undefined) return "no repository was chosen";
      text =
        pick === PASTE_REPO ? await ui.input("Repository", "owner/name or a GitHub URL") : pick;
      if (text === undefined || text.trim() === "") return "no repository was chosen";
    }
    const r = await this.step(HOME_STEPS.repo, { repo: text });
    if (!r.ok) {
      const why = r.failures.join("; ").replace(/^repo: /, "");
      this.m.say(`${why[0]?.toUpperCase() ?? ""}${why.slice(1)}.`, "warn");
      return why;
    }
    await this.reread();
    const name = this.m.repo() ?? "the repository";
    const open = this.m.ordered().length;
    if (this.phase() === "home")
      this.m.say(`You're set. ${open} open pull request${open === 1 ? "" : "s"} in ${name}.`, "ok");
    return r.checks[0]?.detail ?? `repository set to ${name}`;
  }

  /** The session ends: nothing lands after it. A sign-in in flight stops
   * with its menu (the host closes the LoginMenu). */
  close(): void {
    this.closed = true;
  }

  /** What the card draws. */
  view(): SetupView {
    const lines = this.checklist.list();
    const next = this.nextId();
    const running = (id: string): boolean => id === HOME_STEPS.login && this.signing !== null;
    const checks = lines
      .filter((l) => this.checkIds.includes(l.id) && l.status === "pending")
      .map((l) => ({ id: l.id, title: l.title, why: l.note ?? l.explain, next: l.id === next }));
    const shown =
      this.asked !== null ? [...HOME_STEP_ORDER, HOME_STEPS.model] : HOME_STEP_ORDER;
    const steps = shown.map((id): SetupStepView => {
      const l = lines.find((x) => x.id === id);
      const title = l?.title ?? id;
      if (l?.status === "done") {
        const f = this.facts(id);
        return { id, title, state: "done", found: "found" in f ? f.found : "done", next: false };
      }
      const unknown = this.unknownWhy.get(id);
      const f = this.facts(id);
      return {
        id,
        title,
        state: running(id) ? "running" : "pending",
        ...(unknown !== undefined ? { unknown } : "missing" in f ? { missing: f.missing } : {}),
        next: id === next && !running(id),
      };
    });
    return {
      checks,
      steps,
      login: {
        running: this.signing !== null,
        ...(this.signing?.how ? { how: this.signing.how } : {}),
        ...(this.failure ? { failure: this.failure } : {}),
      },
      done: steps.filter((s) => s.state === "done").length,
      total: steps.length,
    };
  }
}

/** Why a sign-in that did not finish did not, from how pi's menu ended. */
function loginFailureOf(end: Exclude<LoginMenuEnd, { kind: "done" }>): {
  kind: LoginFailureKind;
  why: string;
} {
  switch (end.kind) {
    case "left":
      return { kind: "left", why: "pi's /login closed before pi had a model credential" };
    case "timeout":
      return { kind: "timeout", why: "pi's /login was open too long with no credential" };
    case "busy":
      return { kind: "failed", why: "another sign-in is in flight" };
    case "no-hold":
      return { kind: "failed", why: end.why };
    case "no-menu":
      return {
        kind: "unavailable",
        why: "this home cannot open pi's /login here: type /login to sign in with pi's own menu",
      };
    case "closed":
      return { kind: "failed", why: "the home has closed" };
  }
}

/** What a person reads after a sign-in that did not finish, with the key
 * that tries again. */
export function loginFailureText(
  f: { kind: LoginFailureKind; why: string } | null | undefined,
  key: string,
): string {
  switch (f?.kind) {
    case "left":
      return `pi's /login closed before pi had a model credential. ${key} opens it again.`;
    case "timeout":
      return `pi's /login was open a long time with no sign-in. ${key} opens it again.`;
    case "unavailable":
      return `${f.why[0]!.toUpperCase()}${f.why.slice(1)}, then ${key} checks again.`;
    case "failed":
      return `The sign-in did not start: ${f.why}. ${key} tries again.`;
    default:
      return `The sign-in did not finish. ${key} tries again.`;
  }
}
