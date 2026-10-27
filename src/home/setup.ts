// The home's setup checklist: what a fresh machine walks through before the
// home opens on its pull requests. It is the plugin's step registry
// (@quickchatai/pi-quickreview/src/setupchecklist.ts) with the app's steps
// registered onto it, as ADR 0001 names the seam:
//
//   pi_version, git   the plugin's own first-run checks: the card shows one
//                     only while it fails
//   login             pi's own device-code login for the provider the chat
//                     runs on (openai-codex): it starts by itself, the card
//                     shows the URL and the code, and it retries cleanly
//   github            `gh` installed and signed in; one key checks again
//   repo              the repository: one of the person's recently pushed
//                     ones, or any owner/name or GitHub URL, written to the
//                     app config's `[github] repo` with the silent defaults
//                     (timezone, base branch, the owner's name and login)
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
import { providerLabel, type HomeModel, type SetupGap } from "./model.js";
import type { GithubPort, Known } from "./ports.js";

/** The app's step ids, in their order on the card. */
export const HOME_STEPS = { login: "login", github: "github", repo: "repo" } as const;
export type HomeStepId = (typeof HOME_STEPS)[keyof typeof HOME_STEPS];
const HOME_STEP_ORDER: readonly HomeStepId[] = [
  HOME_STEPS.login,
  HOME_STEPS.github,
  HOME_STEPS.repo,
];

/** The plugin's steps the home runs as its first-run checks: pi and git
 * (gh is the github step's). The plugin's login, GitHub credential and repo
 * profile steps are the home's own steps' business, or Setup's. */
export const FIRST_RUN_CHECKS: readonly string[] = [PLUGIN_SETUP_STEPS.pi, PLUGIN_SETUP_STEPS.git];

/** What the person types at a device-code page. */
export interface DeviceCode {
  userCode: string;
  verificationUri: string;
  expiresInSeconds?: number;
}

export type LoginFailureKind =
  "expired" | "denied" | "cancelled" | "not_enabled" | "unavailable" | "failed";

export type LoginOutcome = { ok: true } | { ok: false; kind: LoginFailureKind; why: string };

/** pi's own device-code login (src/home/devicelogin.ts). Never throws. */
export interface DeviceLoginPort {
  login(o: {
    provider: string;
    signal: AbortSignal;
    onCode(code: DeviceCode): void;
  }): Promise<LoginOutcome>;
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
  /** pi's device login. Absent: the extension builds it from pi's session. */
  deviceLogin?: DeviceLoginPort;
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
  /** The device login: its code once pi has one, the last failure. */
  login: { running: boolean; code?: DeviceCode; failure?: { kind: LoginFailureKind; why: string } };
  /** The provider the login is for, as a person names it. */
  provider: string;
  done: number;
  total: number;
}

export const PASTE_REPO = "Paste any repository…";

/** The providers whose login the card runs as pi's device-code flow. Any
 * other provider the chat runs on signs in with pi's own /login. */
export const DEVICE_LOGIN_PROVIDERS: ReadonlySet<string> = new Set(["openai-codex"]);

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

/** A device login in flight. */
interface Signing {
  ac: AbortController;
  code?: DeviceCode;
  onCode?: (c: DeviceCode) => void;
}

export interface HomeSetupOptions {
  model: HomeModel;
  /** The home's GitHub port: the github step's re-check reads it. */
  github: GithubPort;
  ports: HomeSetupPorts;
  /** pi's device login, once pi's session exists. */
  deviceLogin(): DeviceLoginPort | undefined;
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

  private loginTitle(): string {
    return `Sign in to ${providerLabel(this.m.chatProvider())}`;
  }

  private loginFacts(): Facts {
    const label = providerLabel(this.m.chatProvider());
    const signed = this.m.signedIn();
    if (signed === true)
      return { found: `${label === "OpenAI" ? "ChatGPT" : label} · signed in with pi` };
    if (signed === false) return { missing: `pi has no ${label} login yet` };
    const l = this.m.state.login;
    return { unknown: l.kind === "unknown" ? `can't read pi's login: ${l.why}` : "still reading" };
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
    return id === "login"
      ? this.loginFacts()
      : id === "github"
        ? this.githubFacts()
        : this.repoFacts();
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
    ): SetupStep => ({
      id,
      title,
      order,
      explain,
      detect: async () => this.detected(id),
      run,
      verify: async () => report(title, this.facts(id)),
    });
    return [
      step(
        HOME_STEPS.login,
        "Sign in",
        10,
        "pi's own device-code login, for the provider the chat runs on.",
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
    ];
  }

  // ---- the steps' runs --------------------------------------------------

  private async runLogin(): Promise<StepReport> {
    const provider = this.m.chatProvider();
    if (!DEVICE_LOGIN_PROVIDERS.has(provider)) {
      this.failure = {
        kind: "unavailable",
        why: `sign in to ${providerLabel(provider)} with pi's own /login`,
      };
      return refused("login", this.failure.why);
    }
    const port = this.o.deviceLogin();
    const s = this.signing;
    if (port === undefined || s === null) {
      this.failure = {
        kind: "unavailable",
        why: "this home cannot run pi's device login: type /login to sign in with pi's own menu",
      };
      return refused("login", this.failure.why);
    }
    const r = await port.login({
      provider,
      signal: s.ac.signal,
      onCode: (code) => {
        s.code = code;
        s.onCode?.(code);
        this.changed();
      },
    });
    if (r.ok)
      return { ok: true, checks: [{ name: "login", ok: true, detail: "signed in with pi" }] };
    this.failure = { kind: r.kind, why: r.why };
    return refused("login", r.why);
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
    const phase = this.phase();
    if (phase !== this.lastPhase) {
      this.lastPhase = phase;
      this.o.onPhase?.(phase);
    }
    this.maybeStartLogin();
    this.changed();
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

  /** The card while a gap is left, then the home. */
  phase(): "setup" | "home" {
    return this.gaps().length > 0 ? "setup" : "home";
  }

  /** A step is running: the card's spinner turns. */
  busy(): boolean {
    return this.signing !== null || this.stepping > 0;
  }

  /** The first pending step: what alt+n runs. */
  private nextId(): string | undefined {
    return this.checklist.list().find((l) => l.status === "pending")?.id;
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
    if (gaps[0] !== HOME_STEPS.login || !DEVICE_LOGIN_PROVIDERS.has(this.m.chatProvider())) return;
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
    // a first-run check: look again
    const r = await this.step(id);
    if (r.ok) await this.reread();
    const title = this.checklist.list().find((l) => l.id === id)?.title ?? id;
    return r.ok ? `${title}: ok` : `${title}: ${r.failures.join("; ")}`;
  }

  /** pi's device login. The answer comes once the code is shown (or the
   * login ended): the sign-in itself goes on in the background. */
  async signIn(): Promise<string> {
    const s = this.signing;
    if (s !== null)
      return s.code
        ? `Still waiting: open ${s.code.verificationUri} and enter ${s.code.userCode}.`
        : "The sign-in is starting: the code shows in a moment.";
    if (!this.isPending(HOME_STEPS.login)) {
      const f = this.loginFacts();
      return `already signed in: ${"found" in f ? f.found : "done"}`;
    }
    const signing: Signing = { ac: new AbortController() };
    this.signing = signing;
    this.failure = null;
    this.m.say(`Signing in to ${providerLabel(this.m.chatProvider())} with pi's device code.`);
    let answer!: (text: string) => void;
    const answered = new Promise<string>((r) => (answer = r));
    signing.onCode = (c) =>
      answer(
        `Open ${c.verificationUri} and enter the code ${c.userCode}. The home finishes the sign-in once you approve it.`,
      );
    void this.checklist.runStep(HOME_STEPS.login).then(async (r) => {
      this.signing = null;
      const label = providerLabel(this.m.chatProvider());
      if (r.ok) {
        await this.reread();
        this.m.say(`Signed in to ${label} with pi.`, "ok");
        answer(`signed in to ${label}`);
      } else {
        const f = this.failure;
        if (f?.kind !== "cancelled") this.m.say(loginFailureText(f, "alt+n"), "warn");
        answer(`the sign-in did not finish: ${r.failures.join("; ")}`);
      }
      this.changed();
    });
    return answered;
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

  /** The session ends: a login in flight stops with it. */
  close(): void {
    this.closed = true;
    this.signing?.ac.abort();
  }

  /** What the card draws. */
  view(): SetupView {
    const lines = this.checklist.list();
    const next = this.nextId();
    const running = (id: string): boolean => id === HOME_STEPS.login && this.signing !== null;
    const checks = lines
      .filter((l) => this.checkIds.includes(l.id) && l.status === "pending")
      .map((l) => ({ id: l.id, title: l.title, why: l.note ?? l.explain, next: l.id === next }));
    const steps = HOME_STEP_ORDER.map((id): SetupStepView => {
      const l = lines.find((x) => x.id === id);
      const title = id === HOME_STEPS.login ? this.loginTitle() : (l?.title ?? id);
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
        ...(this.signing?.code ? { code: this.signing.code } : {}),
        ...(this.failure ? { failure: this.failure } : {}),
      },
      provider: providerLabel(this.m.chatProvider()),
      done: steps.filter((s) => s.state === "done").length,
      total: steps.length,
    };
  }
}

/** What a person reads after a device login that did not finish, with the
 * key that tries again. */
export function loginFailureText(
  f: { kind: LoginFailureKind; why: string } | null | undefined,
  key: string,
): string {
  switch (f?.kind) {
    case "expired":
      return `The code expired before it was approved. ${key} gets a new one.`;
    case "denied":
      return `The sign-in was denied. ${key} tries again.`;
    case "not_enabled":
      return `Device-code login is off for this ChatGPT account: turn it on in ChatGPT → Settings → Security, then ${key} tries again.`;
    case "cancelled":
      return `The sign-in stopped. ${key} starts it again.`;
    case "unavailable":
      return `${f.why}.`;
    case "failed":
      return `The sign-in failed: ${f.why}. ${key} tries again.`;
    default:
      return `The sign-in did not finish. ${key} tries again.`;
  }
}
