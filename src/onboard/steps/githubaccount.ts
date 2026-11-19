// GitHub account — the wizard's GitHub question, and the whole of the
// own-account route.
//
// Two ways for the daemon to reach GitHub, and this step asks which
// (`github_auth`, answered as its input like topology's `choice`):
//
//   user  the person's OWN GitHub account — the gh sign-in already on this
//         machine (on a Boxes VM the Boxes GitHub connector signs gh in).
//         No App to create, no secrets to paste, any repo the account can
//         reach. Polling only: webhooks are delivered to Apps, so the
//         reconcile poll is the one trigger path. Reviews post AS the person,
//         as COMMENT events with the verdict stated in the body.
//   app   a GitHub App (the github_app step, order 40): its own bot identity,
//         webhooks, the trigger label. The step only records the answer.
//
// The DEFAULT is "user" whenever `gh auth token` works here: the person
// already signed in, and that is the fast path. Without a working gh and no
// answer, the step offers both and records nothing — it never picks the App
// route for anyone.
//
// The "user" route, end to end (each a ✓/✗ line):
//   1. the token, through the same code as `qcr github-token sync`
//      (src/githubtoken.ts): `gh auth token` with the gh THIS environment
//      resolves, `GET /user` for the login, then `<secrets>/github_token`
//      written atomically 0600. The login and the token's kind are reported,
//      never the token;
//   2. the refresher: an idempotent user crontab entry every 20 minutes,
//      running absolute node + cli.js with `--gh <the resolved gh>` and the
//      secrets dir (cron's PATH and env are not the wizard's). No crontab ⇒
//      said plainly, with what lapses (a `ghu_` token in 8 h) and the manual
//      command;
//   3. the repo: picked from the repos the account reaches (`repo` input; the
//      15 most recently pushed are offered), then `GET /repos/{o}/{r}` proves
//      the account can read it — enough to comment and review;
//   4. the trigger labels, created exactly as the github_app step creates them
//      (label DEFINITIONS, POST /repos/{o}/{r}/labels, before the daemon
//      runs: never a review, a PR label, a comment or a push) with the person's
//      token, when the account may (triage or better); otherwise skipped with
//      the reason, since "review this one PR now" needs no label;
//   5. config.toml: `[github] auth = "user"`, `bot_login = <login>`,
//      `app_slug = ""`, and `[ingress] shape = "polling"` (the route forbids any
//      other shape, so the file is never left in a state the loader refuses).
//
// Exactly one of github_account / github_app is enabled once the route is
// answered; while it is unanswered both are, and this step (order 33) is the
// one that answers.
//
// A HOST-MANAGED install (`[github] token_source = "host"` in config.toml) has
// no question and no sign-in: a host writes `<secrets>/github_token` and
// keeps it fresh, and owns the identity and the repository. There the step
//   * runs no `gh` and reads no GH_TOKEN / GITHUB_TOKEN, and never writes
//     the token file: it proves the file's token (`GET /user`, then the
//     repository read) and reports the login;
//   * installs no crontab entry: the host is the refresher;
//   * takes the repository it is handed, recorded or configured, and lists
//     none to pick from;
//   * creates no label: the host's token may be read-only until the reviewer
//     posts, and nothing before the first posted review needs one;
//   * writes the same config the "user" route owns, leaving the marker as it is.
// Its verify re-proves the token and names the host, never a command, as the
// one that puts a failure right. The App route is refused there in words.
//
// On such an install the host also names the IDENTITY, in the mode it writes
// beside the marker, and the step's `github_auth` input does not choose it:
//
//   auth = "user"          the person's own account, as above.
//   auth = "installation"  an App installation: the token in the file is one
//                          the host minted for a GitHub App it holds the key
//                          of, and `[github] app_slug` names that App. The
//                          third route. Its token cannot ask GitHub's user
//                          endpoint and is never sent there:
//     * the token is proved with a read of the configured repository;
//     * who the token is comes from GraphQL's `viewer`, and must be the
//       login the slug implies (`<slug>[bot]`). A slug that names another
//       App than the token's is said plainly and fails the step: the
//       reviewer would otherwise never recognise its own reviews;
//     * the config the route owns is `auth = "installation"`, the slug, the
//       derived `bot_login` and `[ingress] shape = "polling"`;
//     * no App is created and none is asked who it is: the github_app and
//       app_slug_reconcile steps are off on this route, which has no App key.
//   The route is recorded as `installation`, is never offered as an answer,
//   and is refused in words on an install no host manages.
import {
  CHOICE_KEYS,
  GITHUB_AUTH_ANSWERS,
  GITHUB_AUTH_CHOICES,
  REPO_SLUG_RE,
  botLoginFor,
  githubAuthOf,
  memberOf,
  type GithubAuth,
} from "../choices.js";
import {
  readTextOrNull,
  writeAtomic,
  type CheckResult,
  type OnboardingStep,
  type StepContext,
  type StepReport,
} from "../engine.js";
import {
  CRON_MARKER,
  GITHUB_TOKEN_FILE,
  cronEntryState,
  cronLine,
  defaultCliPath,
  githubLogin,
  installCronEntry,
  readPersonToken,
  resolveGhPath,
  syncCommandLine,
  syncGithubToken,
  type TokenKind,
} from "../../githubtoken.js";
import { configExamplePathFor } from "./llmauth.js";
import { deliverConfigChange } from "./configdelivery.js";
import { api, ensureLabel, labelSpecs, parseRepoSlug, type RepoSlug } from "./githubapp.js";
import {
  ingressBlock,
  optionFor,
  patchTomlSection,
  readTomlKey,
  secretsDirFor,
  setTomlKey,
} from "./ingress.js";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  HOST_MANAGED,
  githubSpelledSlug,
  hostTokenProblem,
  readTokenFile,
  tokenIdentityProblem,
  tokenOwnLogin,
} from "@quickchatai/pi-quickreview/src/hosttoken.js";
import { APP_SLUG_RE } from "@quickchatai/pi-quickreview/src/reviewconfig.js";

export const GITHUB_ACCOUNT_STEP_ID = "github_account";

/** A string input or choice, else "" — never an object's stringification. */
function textOf(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** How many of the account's repos the offer lists. */
export const REPO_OFFER_SIZE = 15;

export interface GithubAccountStepOptions {
  apiBase?: string;
  /** Where GH_TOKEN / GITHUB_TOKEN are read when there is no gh. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Secrets dir; default: the one resolution every step uses. */
  secretsDir?: string;
  /** Absolute node and cli.js for the crontab entry. */
  nodePath?: string;
  cliPath?: string;
}

function log(ctx: StepContext, line: string): void {
  ctx.adapters.log?.(`${GITHUB_ACCOUNT_STEP_ID}: ${line}`);
}

/** The route an input names. "installation" is read (so it can be refused
 * in words, or met by the mode a host wrote) and is never offered. */
function routeAnswer(input: Readonly<Record<string, unknown>>): GithubAuth | null {
  const raw = textOf(input.github_auth).trim().toLowerCase();
  if (raw === "own" || raw === "account" || raw === "personal" || raw === "me") return "user";
  if (raw === "github_app" || raw === "github-app") return "app";
  return memberOf(GITHUB_AUTH_CHOICES, raw);
}

/** "owner/name", a github.com URL of the repo (or of anything inside it). */
export function parseRepoAnswer(value: unknown): RepoSlug | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  const url =
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:[/?#].*)?$/.exec(
      v,
    );
  if (url) return parseRepoSlug(`${url[1]}/${url[2]}`);
  return parseRepoSlug(v.replace(/\.git$/, ""));
}

interface RepoRow {
  full_name: string;
  pushed_at: string;
  private: boolean;
  canPush: boolean;
}

/** The repos the account reaches, most recently pushed first. */
export async function listAccountRepos(
  fetchFn: typeof fetch,
  apiBase: string,
  token: string,
): Promise<{ rows: RepoRow[]; problem: string }> {
  const r = await api(
    fetchFn,
    `${apiBase}/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (r.status !== 200 || !Array.isArray(r.body))
    return { rows: [], problem: `GET /user/repos answered HTTP ${r.status}` };
  const rows: RepoRow[] = [];
  for (const raw of r.body as Array<Record<string, unknown>>) {
    if (typeof raw.full_name !== "string" || raw.archived === true) continue;
    const perms = (raw.permissions ?? {}) as Record<string, unknown>;
    rows.push({
      full_name: raw.full_name,
      pushed_at: typeof raw.pushed_at === "string" ? raw.pushed_at : "",
      private: raw.private === true,
      canPush: perms.push === true || perms.admin === true || perms.maintain === true,
    });
  }
  rows.sort((a, b) => b.pushed_at.localeCompare(a.pushed_at));
  return { rows, problem: "" };
}

export interface RepoAccess {
  ok: boolean;
  /** May the account create label definitions (triage or better)? */
  canLabel: boolean;
  check: CheckResult;
}

/** `GET /repos/{o}/{r}` with the person's token: can they read it (enough to
 * comment and review), and may they manage its labels? */
export async function repoAccess(
  fetchFn: typeof fetch,
  apiBase: string,
  token: string,
  repo: RepoSlug,
): Promise<RepoAccess> {
  const slug = `${repo.owner}/${repo.name}`;
  const r = await api(fetchFn, `${apiBase}/repos/${repo.owner}/${repo.name}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (r.status === 404 || r.status === 403)
    return {
      ok: false,
      canLabel: false,
      check: {
        name: "repo access",
        ok: false,
        detail:
          `your account cannot see ${slug} (HTTP ${r.status}) — check the spelling, or ask for access to it. If it belongs to ` +
          "an organisation that restricts third-party access, the org must allow the GitHub CLI (or your Boxes connector)",
      },
    };
  if (r.status !== 200)
    return {
      ok: false,
      canLabel: false,
      check: {
        name: "repo access",
        ok: false,
        detail: `could not read ${slug} with your account (HTTP ${r.status}) — run this step again`,
      },
    };
  const body = (r.body ?? {}) as Record<string, unknown>;
  const perms = (body.permissions ?? {}) as Record<string, unknown>;
  if (body.archived === true)
    return {
      ok: false,
      canLabel: false,
      check: {
        name: "repo access",
        ok: false,
        detail: `${slug} is archived — nobody can comment on its pull requests; pick another repository`,
      },
    };
  const pull = perms.pull === true || perms.triage === true || perms.push === true;
  const canLabel =
    perms.triage === true || perms.push === true || perms.maintain === true || perms.admin === true;
  if (!pull && Object.keys(perms).length > 0)
    return {
      ok: false,
      canLabel: false,
      check: {
        name: "repo access",
        ok: false,
        detail: `your account can see ${slug} but has no read access to it, so it cannot review there — ask for access`,
      },
    };
  return {
    ok: true,
    canLabel,
    check: {
      name: "repo access",
      ok: true,
      detail:
        `your account reads ${slug}${canLabel ? " and can manage its labels" : ""} — enough to review its pull requests and ` +
        "comment on them, as you",
    },
  };
}

function offerRoutes(ghWorks: boolean): CheckResult {
  return {
    name: "github_auth",
    ok: false,
    detail:
      "How should the reviewer reach GitHub? Read both out, then run this step again with the answer.\n" +
      "  user: your own GitHub account (RECOMMENDED, fastest) — the gh sign-in on this machine; no App to create, any repo " +
      "you can reach. It checks for work by polling (no webhooks), and reviews post as you, as comments that state the verdict.\n" +
      "  app: a GitHub App — its own bot identity, webhooks and the trigger label; you create and install it in a browser.\n" +
      (ghWorks
        ? ""
        : 'No working gh sign-in was found here (`gh auth token` gave nothing), so for "user" sign in first with ' +
          "`gh auth login` — or set GH_TOKEN — then run this step again.\n") +
      'Call this step with github_auth: "user" or github_auth: "app".',
  };
}

/** What a failure on a host-managed install ends with: whose it is to fix. */
const HOST_FIXES =
  "this install's GitHub credential is managed by its host, which writes the token file and keeps it fresh";
const HOST_FIXES_SENTENCE = `${HOST_FIXES[0]!.toUpperCase()}${HOST_FIXES.slice(1)}`;

/** The config edits the installation route owns: the mode, the App's slug,
 * the login it implies, and polling. Returns the new text, or a reason. */
function installationConfig(text: string, slug: string): string | string[] {
  let next: string | null = text;
  for (const [key, value] of [
    ["auth", "installation"],
    ["app_slug", slug],
    ["bot_login", botLoginFor(slug)],
  ] as const) {
    next = next === null ? null : setTomlKey(next, "github", key, value);
  }
  if (next === null) return ["config.toml has no [github] table to write the route into"];
  const polling = optionFor("polling")!;
  return patchTomlSection(next, "ingress", ingressBlock(polling));
}

/** `GET /repos/{o}/{r}` with an installation token: is the repository one the
 * installation reaches, under that name, and open to review? The answer's
 * `permissions` are not read: they describe a person's role, and an
 * installation's access is what its host minted the token with. */
export async function installationRepoRead(
  fetchFn: typeof fetch,
  apiBase: string,
  token: string,
  repo: RepoSlug,
): Promise<CheckResult> {
  const slug = `${repo.owner}/${repo.name}`;
  const r = await api(fetchFn, `${apiBase}/repos/${repo.owner}/${repo.name}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const no = (detail: string): CheckResult => ({ name: "repo access", ok: false, detail });
  if (r.status === 401)
    return no(
      `GitHub rejected the token in the token file (HTTP 401) when reading ${slug}: ${HOST_FIXES}`,
    );
  if (r.status === 404 || r.status === 403)
    return no(
      `the installation token cannot read ${slug} (HTTP ${r.status}): the App is not installed on it, the repository is no ` +
        `longer among the ones the installation selects, or the token was minted for another one. ${HOST_FIXES_SENTENCE}`,
    );
  if (r.status !== 200)
    return no(
      `could not read ${slug} with the installation token (HTTP ${r.status}); run this step again`,
    );
  const body = (r.body ?? {}) as Record<string, unknown>;
  if (body.archived === true) return no(`${slug} is archived: nobody can review its pull requests`);
  const name = typeof body.full_name === "string" ? body.full_name : slug;
  if (name.toLowerCase() !== slug.toLowerCase())
    return no(
      `${slug} is not where GitHub keeps that repository now (it answers as ${name}): it was renamed or moved`,
    );
  return {
    name: "repo access",
    ok: true,
    detail: `the installation token reads ${slug}: the token is proved with this read, and GitHub's user endpoint is never asked`,
  };
}

/** The config edits the "user" route owns. Returns the new text, or a reason. */
function userConfig(text: string, login: string): string | string[] {
  let next: string | null = text;
  for (const [key, value] of [
    ["auth", "user"],
    ["bot_login", login],
    ["app_slug", ""],
  ] as const) {
    next = next === null ? null : setTomlKey(next, "github", key, value);
  }
  if (next === null) return ["config.toml has no [github] table to write the route into"];
  const polling = optionFor("polling")!;
  return patchTomlSection(next, "ingress", ingressBlock(polling));
}

/** Read config.toml, seeding it from the shipped template on a fresh install:
 * no earlier step writes one (the model step, order 30, writes no file). */
function configText(ctx: StepContext): { text: string | null; seeded: boolean; detail: string } {
  const path = ctx.adapters.paths.configPath;
  const text = readTextOrNull(path);
  if (text !== null) return { text, seeded: false, detail: "" };
  const example = readTextOrNull(configExamplePathFor(ctx.adapters.paths.stateDir));
  if (example === null)
    return {
      text: null,
      seeded: false,
      detail: `neither ${path} nor config.example.toml exists — is this a complete QuickReview install?`,
    };
  return { text: example, seeded: true, detail: "" };
}

function mode(path: string): number | null {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return null;
  }
}

function cronNote(kind: TokenKind, manual: string): string {
  const lapse =
    kind.prefix === "ghu_" || kind.prefix === "ghs_"
      ? `Your token is a ${kind.prefix} token, which GitHub expires within 8 hours: without a refresh the reviewer loses ` +
        "GitHub access then, until you run the command below again."
      : kind.expires === false
        ? `Your token is a ${kind.prefix} token, which does not expire — nothing lapses; run the command below only after you sign in again.`
        : `Your token is a ${kind.prefix} token; if it has an expiry, the reviewer loses GitHub access when it lapses.`;
  return `${lapse} The refresh command, to run by hand or from any scheduler:\n    ${manual}`;
}

/** Does config.toml carry the host-managed marker, `[github] token_source =
 * "host"`? No config, or one without the key, is an install that keeps its own. */
function hostManaged(ctx: StepContext): boolean {
  const text = readTextOrNull(ctx.adapters.paths.configPath);
  return text !== null && readTomlKey(text, "github", "token_source") === "host";
}

/** The identity a host wrote beside its marker: the installation route when
 * the config says `[github] auth = "installation"`, the person's own account
 * otherwise (the mode a marked config has always meant). */
function hostRoute(ctx: StepContext): Extract<GithubAuth, "user" | "installation"> {
  const text = readTextOrNull(ctx.adapters.paths.configPath);
  return text !== null && readTomlKey(text, "github", "auth") === "installation"
    ? "installation"
    : "user";
}

/** `[github] app_slug` as the config states it; null when it names no App. */
function configuredSlug(ctx: StepContext): string | null {
  const text = readTextOrNull(ctx.adapters.paths.configPath);
  const slug = (text === null ? null : readTomlKey(text, "github", "app_slug"))?.trim() ?? "";
  return APP_SLUG_RE.test(slug) ? slug : null;
}

/** The route is one only a host names; on an install that keeps its own
 * credential it is refused, in words. */
const INSTALLATION_NEEDS_HOST: CheckResult = {
  name: "github_auth",
  ok: false,
  detail:
    'the "installation" route is an App installation token that a host supplies ([github] token_source = "host"), and ' +
    'this install keeps its own GitHub credential: nothing here can mint such a token. Run this step with github_auth: "user" ' +
    '(your own account) or github_auth: "app" (a GitHub App created here). Nothing changed',
};

export function githubAccountStep(opts: GithubAccountStepOptions = {}): OnboardingStep {
  const apiBase = opts.apiBase ?? "https://api.github.com";
  const env = opts.env ?? process.env;

  function secretsDir(ctx: StepContext): string {
    return opts.secretsDir ?? secretsDirFor(ctx.adapters, ctx.choices);
  }

  /** The host-managed route: prove the token the host wrote, and write the
   * config the route owns. No gh, no crontab, no token write, no label. */
  async function runHost(ctx: StepContext): Promise<StepReport> {
    const checks: CheckResult[] = [
      {
        name: "route",
        ok: true,
        detail: `your GitHub identity and repository are ${HOST_MANAGED}: there is no sign-in here, and nothing to pick`,
      },
    ];
    const file = readTokenFile(secretsDir(ctx));
    if (!file.ok) {
      checks.push({ name: "token", ok: false, detail: hostTokenProblem(file) });
      return { ok: false, checks };
    }
    log(ctx, "proving the GitHub token this install's host wrote");
    const who = await githubLogin(ctx.adapters.fetch, file.token, apiBase);
    if (!who.ok) {
      checks.push({
        name: "token",
        ok: false,
        detail:
          who.status === 401
            ? `GitHub rejected the token in ${file.path} (${who.detail}): ${HOST_FIXES}`
            : `could not check the token in ${file.path} with GitHub (${who.detail}); run this step again`,
      });
      return { ok: false, checks };
    }
    const login = who.login;
    checks.push({
      name: "token",
      ok: true,
      detail:
        `the token your host wrote signs in as ${login}${who.expiry ? `, expiring ${who.expiry}` : ""} ` +
        `(${file.path}). The token itself is never shown or logged`,
    });
    checks.push({
      name: "refresh",
      ok: true,
      detail: "your host keeps the token fresh: no crontab entry is installed, and no `gh` is used",
    });

    const currentText = readTextOrNull(ctx.adapters.paths.configPath);
    const configured = currentText ? readTomlKey(currentText, "github", "repo") : null;
    const repo =
      parseRepoAnswer(ctx.input.repo) ??
      parseRepoAnswer(ctx.choices[CHOICE_KEYS.accountRepo]) ??
      (configured && REPO_SLUG_RE.test(configured) ? parseRepoSlug(configured) : null);
    if (repo === null) {
      checks.push({
        name: "repo",
        ok: false,
        detail: `no repository is set yet: the repository is ${HOST_MANAGED}, which sets it before the reviewer starts`,
      });
      return { ok: false, checks, data: { route: "user", login, cron: "host", gh_path: null } };
    }
    const access = await repoAccess(ctx.adapters.fetch, apiBase, file.token, repo);
    checks.push(access.check);
    if (!access.ok) return { ok: false, checks };
    checks.push({
      name: "labels",
      ok: true,
      detail:
        "the trigger labels are not created here: the token your host wrote may be read-only until the reviewer posts, " +
        "and reviewing one pull request needs no label",
    });

    const source = configText(ctx);
    if (source.text === null) {
      checks.push({ name: "config", ok: false, detail: source.detail });
      return { ok: false, checks };
    }
    const next = userConfig(source.text, login);
    if (Array.isArray(next)) {
      checks.push({ name: "config", ok: false, detail: next.join("; ") });
      return { ok: false, checks };
    }
    const changed = source.seeded || next !== source.text;
    if (changed) writeAtomic(ctx.adapters.paths.configPath, next);
    checks.push({
      name: "config",
      ok: true,
      detail:
        `[github] auth = "user", bot_login = "${login}", app_slug = "" and [ingress] shape = "polling" ` +
        `${changed ? `written to ${ctx.adapters.paths.configPath}` : "already in place"}; token_source = "host" is left as your host set it`,
    });
    const delivery = await deliverConfigChange(
      ctx,
      undefined,
      (changed && !source.seeded) || ctx.data.restart_owed === true,
      GITHUB_ACCOUNT_STEP_ID,
    );
    checks.push(...delivery.checks);

    const slug = `${repo.owner}/${repo.name}`;
    ctx.recordChoice(CHOICE_KEYS.githubAuth, "user");
    ctx.recordChoice(CHOICE_KEYS.accountLogin, login);
    ctx.recordChoice(CHOICE_KEYS.accountRepo, slug);
    ctx.recordChoice(CHOICE_KEYS.botLogin, login);
    return {
      ok: checks.every((c) => c.ok),
      checks,
      data: {
        route: "user",
        login,
        repo: slug,
        // "host": no crontab entry exists for verify to look for
        cron: "host",
        gh_path: null,
        labels: false,
        restart_owed: delivery.restartOwed,
      },
    };
  }

  /** Who the token file's token is, against the login the slug implies,
   * and the slug as GitHub spells it when the token is that App's (null
   * otherwise). The match ignores case, as GitHub does; the reviewer's
   * own-content checks do not, so the config states GitHub's spelling. */
  async function identityCheck(
    ctx: StepContext,
    token: string,
    slug: string,
  ): Promise<{ check: CheckResult; spelled: string | null }> {
    const expected = botLoginFor(slug);
    const who = await tokenOwnLogin(ctx.adapters.fetch, token, apiBase);
    if (!who.ok)
      return {
        check: {
          name: "identity",
          ok: false,
          detail:
            who.status === 401
              ? `GitHub rejected the token in the token file (HTTP 401): ${HOST_FIXES}`
              : `could not check that the token posts as ${expected} (${who.detail}); run this step again`,
        },
        spelled: null,
      };
    const problem = tokenIdentityProblem(expected, who.login);
    const spelled = problem === null ? githubSpelledSlug(slug, who.login) : null;
    return spelled !== null
      ? {
          check: {
            name: "identity",
            ok: true,
            detail: `the token posts as ${who.login}, the login [github] app_slug = "${slug}" implies`,
          },
          spelled,
        }
      : {
          check: {
            name: "identity",
            ok: false,
            detail: `${problem ?? `the token in the token file acts as ${who.login}, which is not an App's bot login`}. [github] app_slug is "${slug}"; the host that manages this install names the App, and must name the one its token belongs to`,
          },
          spelled: null,
        };
  }

  /** The installation route: prove the token the host wrote with a read of
   * the repository, check it is the identity the slug names, and write the
   * config the route owns. No gh, no crontab, no token write, no label, no
   * App key, and never GitHub's user endpoint. */
  async function runInstallation(ctx: StepContext): Promise<StepReport> {
    const checks: CheckResult[] = [
      {
        name: "route",
        ok: true,
        detail:
          `your GitHub identity and repository are ${HOST_MANAGED}: the reviewer posts as a GitHub App's bot, on an ` +
          "installation token your host supplies. There is no sign-in here, nothing to pick, and no App key on this machine",
      },
    ];
    const namedSlug = configuredSlug(ctx);
    if (namedSlug === null) {
      checks.push({
        name: "app",
        ok: false,
        detail: `[github] app_slug names no GitHub App: on this route the App is ${HOST_MANAGED}, which writes its slug before the reviewer starts`,
      });
      return { ok: false, checks };
    }
    const file = readTokenFile(secretsDir(ctx));
    if (!file.ok) {
      checks.push({ name: "token", ok: false, detail: hostTokenProblem(file) });
      return { ok: false, checks };
    }
    const data = {
      route: "installation",
      app_slug: namedSlug,
      cron: "host",
      gh_path: null,
    };
    const currentText = readTextOrNull(ctx.adapters.paths.configPath);
    const configured = currentText ? readTomlKey(currentText, "github", "repo") : null;
    const repo =
      parseRepoAnswer(ctx.input.repo) ??
      parseRepoAnswer(ctx.choices[CHOICE_KEYS.accountRepo]) ??
      (configured && REPO_SLUG_RE.test(configured) ? parseRepoSlug(configured) : null);
    if (repo === null) {
      checks.push({
        name: "repo",
        ok: false,
        detail: `no repository is set yet: the repository is ${HOST_MANAGED}, which sets it before the reviewer starts`,
      });
      return { ok: false, checks, data };
    }
    log(ctx, "proving the installation token this install's host wrote");
    const access = await installationRepoRead(ctx.adapters.fetch, apiBase, file.token, repo);
    checks.push(access);
    if (!access.ok) return { ok: false, checks, data };
    const identity = await identityCheck(ctx, file.token, namedSlug);
    checks.push(identity.check);
    if (identity.spelled === null) return { ok: false, checks, data };
    // from here the slug is GitHub's spelling of it
    const slug = identity.spelled;
    checks.push({
      name: "refresh",
      ok: true,
      detail: "your host keeps the token fresh: no crontab entry is installed, and no `gh` is used",
    });
    checks.push({
      name: "labels",
      ok: true,
      detail:
        "the trigger labels are not created here: the token your host wrote may be read-only until the reviewer posts, " +
        "and reviewing one pull request needs no label",
    });

    const source = configText(ctx);
    if (source.text === null) {
      checks.push({ name: "config", ok: false, detail: source.detail });
      return { ok: false, checks };
    }
    const next = installationConfig(source.text, slug);
    if (Array.isArray(next)) {
      checks.push({ name: "config", ok: false, detail: next.join("; ") });
      return { ok: false, checks };
    }
    const changed = source.seeded || next !== source.text;
    if (changed) writeAtomic(ctx.adapters.paths.configPath, next);
    const login = botLoginFor(slug);
    checks.push({
      name: "config",
      ok: true,
      detail:
        `[github] auth = "installation", app_slug = "${slug}", bot_login = "${login}" and [ingress] shape = "polling" ` +
        `${changed ? `written to ${ctx.adapters.paths.configPath}` : "already in place"}; token_source = "host" is left as your host set it`,
    });
    const delivery = await deliverConfigChange(
      ctx,
      undefined,
      (changed && !source.seeded) || ctx.data.restart_owed === true,
      GITHUB_ACCOUNT_STEP_ID,
    );
    checks.push(...delivery.checks);

    const repoSlug = `${repo.owner}/${repo.name}`;
    ctx.recordChoice(CHOICE_KEYS.githubAuth, "installation");
    ctx.recordChoice(CHOICE_KEYS.accountRepo, repoSlug);
    ctx.recordChoice(CHOICE_KEYS.appSlug, slug);
    ctx.recordChoice(CHOICE_KEYS.botLogin, login);
    return {
      ok: checks.every((c) => c.ok),
      checks,
      data: {
        ...data,
        app_slug: slug,
        login,
        repo: repoSlug,
        labels: false,
        restart_owed: delivery.restartOwed,
      },
    };
  }

  /** Verify on the installation route: the token file is there and private,
   * still reads the repository, and is still the identity the config names. */
  async function verifyInstallation(ctx: StepContext): Promise<StepReport> {
    const checks: CheckResult[] = [];
    const path = join(secretsDir(ctx), GITHUB_TOKEN_FILE);
    const file = readTokenFile(secretsDir(ctx));
    if (!file.ok)
      return { ok: false, checks: [{ name: "token", ok: false, detail: hostTokenProblem(file) }] };
    const m = mode(path);
    checks.push(
      m !== null && (m & 0o077) === 0
        ? {
            name: "token-file",
            ok: true,
            detail: `${path} is private to you (mode ${m.toString(8)})`,
          }
        : {
            name: "token-file",
            ok: false,
            detail: `${path} is readable by others (mode ${m?.toString(8) ?? "unknown"}): the host that manages this install writes it, and must write it 0600`,
          },
    );
    const text = readTextOrNull(ctx.adapters.paths.configPath) ?? "";
    const auth = readTomlKey(text, "github", "auth");
    const bot = readTomlKey(text, "github", "bot_login");
    const slug = configuredSlug(ctx);
    checks.push(
      auth === "installation" && slug !== null && bot === botLoginFor(slug)
        ? {
            name: "config",
            ok: true,
            detail: `[github] auth = "installation", app_slug = "${slug}", bot_login = "${bot}"`,
          }
        : {
            name: "config",
            ok: false,
            detail:
              `config.toml says auth = ${JSON.stringify(auth ?? "(absent: app)")}, app_slug = ${JSON.stringify(slug ?? "")}, ` +
              `bot_login = ${JSON.stringify(bot ?? "")}: on this route bot_login is the slug's "<slug>[bot]" — run this step again`,
          },
    );
    const repo =
      parseRepoAnswer(ctx.choices[CHOICE_KEYS.accountRepo]) ??
      parseRepoSlug(readTomlKey(text, "github", "repo") ?? "");
    if (repo) {
      const access = await installationRepoRead(ctx.adapters.fetch, apiBase, file.token, repo);
      checks.push(access);
      if (access.ok && slug !== null) {
        const identity = await identityCheck(ctx, file.token, slug);
        checks.push(identity.check);
        // a config that names the App in another case than GitHub's is not
        // one the reviewer recognises its own reviews by
        if (identity.spelled !== null && identity.spelled !== slug)
          checks.push({
            name: "identity-spelling",
            ok: false,
            detail: `[github] app_slug is "${slug}", but GitHub spells the App's login ${identity.spelled}[bot], and the reviewer recognises its own reviews by that exact spelling: run this step again`,
          });
      }
    } else {
      checks.push({
        name: "repo",
        ok: false,
        detail: `no repository is set: the repository is ${HOST_MANAGED}`,
      });
    }
    return { ok: checks.every((c) => c.ok), checks };
  }

  async function runUser(ctx: StepContext, switching: boolean): Promise<StepReport> {
    const checks: CheckResult[] = [];
    if (switching)
      checks.push({
        name: "route",
        ok: true,
        detail:
          "switched to your own account. Your App and its secrets are left exactly where they are — nothing is deleted; " +
          'switching back is this step with github_auth: "app"',
      });
    const dir = secretsDir(ctx);

    // 1. the token, through the one sync implementation.
    const gh = await resolveGhPath(ctx.adapters.runner);
    log(ctx, `reading your GitHub sign-in (${gh ?? "gh on PATH"}, then GH_TOKEN/GITHUB_TOKEN)`);
    const synced = await syncGithubToken({
      runner: ctx.adapters.runner,
      env,
      fetch: ctx.adapters.fetch,
      secretsDir: dir,
      gh,
      apiBase,
    });
    if (!synced.ok) {
      checks.push({ name: "token", ok: false, detail: synced.problem });
      return { ok: false, checks };
    }
    const login = synced.login;
    checks.push({
      name: "token",
      ok: true,
      detail:
        `signed in as ${login} — a ${synced.kind.prefix} ${synced.kind.label}${synced.expiry ? `, expiring ${synced.expiry}` : ""}` +
        `; written to ${synced.path} (0600). The token itself is never shown or logged`,
    });

    // 2. the refresher.
    const node = opts.nodePath ?? process.execPath;
    const cli = opts.cliPath ?? defaultCliPath();
    const words = { node, cli, gh, secretsDir: dir };
    const manual = syncCommandLine(words);
    let cron: string;
    if (ctx.adapters.host.inContainer) {
      cron = "skipped";
      checks.push({
        name: "refresh",
        ok: true,
        detail:
          "this wizard runs inside a container, where a crontab entry would not outlive it — add the refresh on the host " +
          `instead. ${cronNote(synced.kind, manual)}`,
      });
    } else {
      const outcome = await installCronEntry({
        runner: ctx.adapters.runner,
        line: cronLine(words),
        scratchDir: join(ctx.adapters.paths.stateDir, "onboarding"),
      });
      cron = outcome.kind;
      if (outcome.kind === "installed" || outcome.kind === "unchanged")
        checks.push({
          name: "refresh",
          ok: true,
          detail:
            `${outcome.kind === "installed" ? "added" : "already present:"} a user crontab entry that refreshes the token file every ` +
            `20 minutes (marked "${CRON_MARKER}"), running ${gh ?? "gh from PATH"} — the gh this wizard found signed in`,
        });
      else if (outcome.kind === "no-crontab")
        checks.push({
          name: "refresh",
          ok: true,
          detail: `this machine has no \`crontab\`, so no automatic refresh was installed. ${cronNote(synced.kind, manual)}`,
        });
      else
        checks.push({
          name: "refresh",
          ok: false,
          detail: `could not install the refresh entry (${outcome.detail}). ${cronNote(synced.kind, manual)}`,
        });
    }

    // 3. the repo.
    const token = readFileSync(synced.path, "utf8");
    const recorded = ctx.choices[CHOICE_KEYS.accountRepo];
    const currentText = readTextOrNull(ctx.adapters.paths.configPath);
    const configured = currentText ? readTomlKey(currentText, "github", "repo") : null;
    const repo =
      parseRepoAnswer(ctx.input.repo) ??
      parseRepoAnswer(recorded) ??
      (configured && REPO_SLUG_RE.test(configured) ? parseRepoSlug(configured) : null);
    if (repo === null) {
      const typed = typeof ctx.input.repo === "string" && ctx.input.repo.trim() !== "";
      const listed = await listAccountRepos(ctx.adapters.fetch, apiBase, token);
      const offer = listed.rows
        .slice(0, REPO_OFFER_SIZE)
        .map(
          (r) =>
            `  ${r.full_name}${r.private ? " (private)" : ""}${r.canPush ? "" : " (read only)"}`,
        );
      checks.push({
        name: "repo",
        ok: false,
        detail:
          (typed
            ? `"${String(ctx.input.repo)}" is not a repository — give it as "owner/name" or its GitHub URL.\n`
            : "") +
          (offer.length > 0
            ? `Which repository should the reviewer review? Your ${offer.length} most recently pushed:\n${offer.join("\n")}\n`
            : `Which repository should the reviewer review?${listed.problem ? ` (the list could not be read: ${listed.problem})` : ""}\n`) +
          'Run this step again with repo: "owner/name" (any repo your account can read, listed or not).',
      });
      return {
        ok: false,
        checks,
        data: { route: "user", login, token_kind: synced.kind.prefix, cron, gh_path: gh },
      };
    }
    const access = await repoAccess(ctx.adapters.fetch, apiBase, token, repo);
    checks.push(access.check);
    if (!access.ok) return { ok: false, checks };

    // 4. the trigger labels — the github_app step's own idempotent creation.
    if (access.canLabel) {
      for (const label of labelSpecs(currentText, ctx.choices))
        checks.push(await ensureLabel(ctx.adapters.fetch, apiBase, token, repo, label, true));
    } else {
      checks.push({
        name: "labels",
        ok: true,
        detail:
          `your account cannot manage labels on ${repo.owner}/${repo.name}, so the trigger labels were not created. Nothing ` +
          "needs them now — the last step reviews one PR directly. A maintainer can create them later for label-triggered reviews",
      });
    }
    if (!checks.every((c) => c.ok)) return { ok: false, checks };

    // 5. the config the route owns.
    const source = configText(ctx);
    if (source.text === null) {
      checks.push({ name: "config", ok: false, detail: source.detail });
      return { ok: false, checks };
    }
    const next = userConfig(source.text, login);
    if (Array.isArray(next)) {
      checks.push({ name: "config", ok: false, detail: next.join("; ") });
      return { ok: false, checks };
    }
    const changed = source.seeded || next !== source.text;
    if (changed) writeAtomic(ctx.adapters.paths.configPath, next);
    checks.push({
      name: "config",
      ok: true,
      detail:
        `[github] auth = "user", bot_login = "${login}", app_slug = "" and [ingress] shape = "polling" ` +
        `${changed ? `written to ${ctx.adapters.paths.configPath}` : "already in place"} — no App secrets are needed on this route`,
    });
    const delivery = await deliverConfigChange(
      ctx,
      undefined,
      (changed && !source.seeded) || ctx.data.restart_owed === true,
      GITHUB_ACCOUNT_STEP_ID,
    );
    checks.push(...delivery.checks);

    const slug = `${repo.owner}/${repo.name}`;
    ctx.recordChoice(CHOICE_KEYS.githubAuth, "user");
    ctx.recordChoice(CHOICE_KEYS.accountLogin, login);
    ctx.recordChoice(CHOICE_KEYS.accountRepo, slug);
    ctx.recordChoice(CHOICE_KEYS.botLogin, login);
    return {
      ok: checks.every((c) => c.ok),
      checks,
      data: {
        route: "user",
        login,
        repo: slug,
        token_kind: synced.kind.prefix,
        cron,
        gh_path: gh,
        labels: access.canLabel,
        restart_owed: delivery.restartOwed,
      },
    };
  }

  async function verifyUser(ctx: StepContext): Promise<StepReport> {
    const checks: CheckResult[] = [];
    const path = join(secretsDir(ctx), GITHUB_TOKEN_FILE);
    const token = (readTextOrNull(path) ?? "").trim();
    // A host-managed install: no command here writes the file, so a failure
    // names the host and never one.
    const managed = hostManaged(ctx);
    if (token === "") {
      return {
        ok: false,
        checks: [
          {
            name: "token",
            ok: false,
            detail: managed
              ? `${path} is missing or empty: ${HOST_FIXES}`
              : `${path} is missing or empty — run this step (or \`qcr github-token sync\`) to write it`,
          },
        ],
      };
    }
    const m = mode(path);
    checks.push(
      m !== null && (m & 0o077) === 0
        ? {
            name: "token-file",
            ok: true,
            detail: `${path} is private to you (mode ${m.toString(8)})`,
          }
        : {
            name: "token-file",
            ok: false,
            detail: managed
              ? `${path} is readable by others (mode ${m?.toString(8) ?? "unknown"}): the host that manages this install writes it, and must write it 0600`
              : `${path} is readable by others (mode ${m?.toString(8) ?? "unknown"}) — \`chmod 600 ${path}\`, or run this step again`,
          },
    );
    const who = await githubLogin(ctx.adapters.fetch, token, apiBase);
    const login = textOf(ctx.choices[CHOICE_KEYS.accountLogin]);
    checks.push(
      !who.ok
        ? {
            name: "token",
            ok: false,
            detail: managed
              ? `the token in ${path} no longer works (${who.detail}): ${HOST_FIXES}`
              : `the token in ${path} no longer works (${who.detail}) — run \`qcr github-token sync\` or this step again`,
          }
        : login !== "" && who.login !== login
          ? {
              name: "token",
              ok: false,
              detail: `the token file is ${who.login}'s, but onboarding recorded ${login} — run this step again`,
            }
          : { name: "token", ok: true, detail: `the token file signs in as ${who.login}` },
    );
    const text = readTextOrNull(ctx.adapters.paths.configPath) ?? "";
    const auth = readTomlKey(text, "github", "auth");
    const bot = readTomlKey(text, "github", "bot_login");
    checks.push(
      auth === "user" && (login === "" || bot === login)
        ? { name: "config", ok: true, detail: `[github] auth = "user", bot_login = "${bot ?? ""}"` }
        : {
            name: "config",
            ok: false,
            detail: `config.toml says auth = ${JSON.stringify(auth ?? "(absent: app)")}, bot_login = ${JSON.stringify(bot ?? "")} — run this step again`,
          },
    );
    const gh = typeof ctx.data.gh_path === "string" ? ctx.data.gh_path : null;
    if (ctx.data.cron === "installed" || ctx.data.cron === "unchanged") {
      const state = await cronEntryState(ctx.adapters.runner, gh);
      checks.push(
        state === "present"
          ? {
              name: "refresh",
              ok: true,
              detail: `the crontab refresh entry is in place (${gh ?? "gh from PATH"})`,
            }
          : {
              name: "refresh",
              ok: false,
              detail:
                state === "stale"
                  ? `the crontab refresh entry runs a different gh than ${gh} — run this step again`
                  : "the crontab refresh entry is gone — run this step again to put it back",
            },
      );
    }
    const repo = parseRepoAnswer(ctx.choices[CHOICE_KEYS.accountRepo]);
    if (repo && who.ok)
      checks.push((await repoAccess(ctx.adapters.fetch, apiBase, token, repo)).check);
    return { ok: checks.every((c) => c.ok), checks };
  }

  return {
    id: GITHUB_ACCOUNT_STEP_ID,
    title: "GitHub: your own account, or a GitHub App",
    explain:
      "How the reviewer reaches GitHub. The fast path is your own account — the gh sign-in already on this machine (a Boxes " +
      "VM has one): no App to create, nothing to paste, any repo you can reach; it polls for work, and its reviews post as " +
      "you, as comments stating the verdict. The alternative is a GitHub App (webhooks, its own bot identity). Call this tool " +
      "with no arguments: where gh is signed in it goes straight down the own-account route, saves your token (0600, never " +
      "shown), sets up its refresh, and lists your repositories to pick one from — then call it again with repo.",
    // 33: after the model step (30), which writes no file, BEFORE the interview (35)
    // — which asks the App questions only on the App route and reads the
    // repo and login this step records — and before the App step (40).
    order: 33,
    enabled: (choices) => githubAuthOf(choices) !== "app",
    parameters: {
      type: "object",
      properties: {
        github_auth: {
          type: "string",
          enum: GITHUB_AUTH_ANSWERS,
          description:
            '"user" = your own GitHub account (recommended; the default when gh is signed in here); "app" = a GitHub App. ' +
            "Omit to take the default.",
        },
        repo: {
          type: "string",
          description:
            'The repository to review, "owner/name" or its GitHub URL. Omit on the first call to get your recent repositories listed.',
        },
      },
    },

    async run(ctx): Promise<StepReport> {
      const recorded = githubAuthOf(ctx.choices);
      const answered = routeAnswer(ctx.input);
      const typed =
        typeof ctx.input.github_auth === "string" && ctx.input.github_auth.trim() !== "";
      // A host-managed install: the route is not a question, and no gh is run
      // to answer it. Asking for the App route is refused, in words.
      if (hostManaged(ctx)) {
        if (answered === "app")
          return {
            ok: false,
            checks: [
              {
                name: "github_auth",
                ok: false,
                detail: `who reviews is ${HOST_MANAGED} ([github] token_source = "host"): a GitHub App is not set up from here. Nothing changed`,
              },
            ],
          };
        // The identity is the one the host wrote beside its marker; the
        // answer does not choose between the two a host can supply.
        return hostRoute(ctx) === "installation" ? runInstallation(ctx) : runHost(ctx);
      }
      if (typed && answered === null) return { ok: false, checks: [offerRoutes(true)] };
      // Only a host supplies an installation token: typed here, or left on
      // record by an install that lost its marker, it is no route to walk.
      if ((answered ?? recorded) === "installation")
        return { ok: false, checks: [INSTALLATION_NEEDS_HOST] };
      let route = answered ?? recorded;
      let defaulted = false;
      if (route === null) {
        // The default: "user" where this machine's gh is signed in.
        const gh = await resolveGhPath(ctx.adapters.runner);
        const probe = await readPersonToken({ runner: ctx.adapters.runner, env: {}, gh });
        if (!probe.ok) return { ok: false, checks: [offerRoutes(false)] };
        route = "user";
        defaulted = true;
      }
      const switching = recorded !== null && recorded !== route;
      if (route === "app") {
        ctx.recordChoice(CHOICE_KEYS.githubAuth, "app");
        const checks: CheckResult[] = [
          {
            name: "route",
            ok: true,
            detail:
              "a GitHub App — the github_app step creates it next (one click in your browser), installs it on your repo and " +
              "creates the trigger labels",
          },
        ];
        // A config left on the own-account route would keep the daemon there.
        const text = readTextOrNull(ctx.adapters.paths.configPath);
        if (text !== null && readTomlKey(text, "github", "auth") === "user") {
          const next = setTomlKey(text, "github", "auth", "app");
          if (next !== null) writeAtomic(ctx.adapters.paths.configPath, next);
          checks.push({
            name: "config",
            ok: true,
            detail: '[github] auth = "app" — your token file is left in place, unused',
          });
        }
        return { ok: true, checks, data: { route: "app" } };
      }
      const report = await runUser(ctx, switching);
      if (defaulted)
        report.checks.unshift({
          name: "route",
          ok: true,
          detail:
            'your own GitHub account (the default: gh is signed in here). For a GitHub App instead, run this step with github_auth: "app"',
        });
      return report;
    },

    async verify(ctx): Promise<StepReport> {
      const route = githubAuthOf(ctx.choices);
      if (route === "installation") return verifyInstallation(ctx);
      if (route === "user") return verifyUser(ctx);
      if (route === "app")
        return {
          ok: true,
          checks: [
            {
              name: "route",
              ok: true,
              detail: "the GitHub App route — the github_app step verifies the App",
            },
          ],
        };
      // Unanswered: a checklist from before the question existed, whose App
      // credentials are on disk, is the App route in all but the record.
      const dir = secretsDir(ctx);
      const legacyApp = ["app_id", "app.pem", "webhook_secret"].every((f) =>
        existsSync(join(dir, f)),
      );
      return legacyApp
        ? {
            ok: true,
            checks: [
              {
                name: "route",
                ok: true,
                detail: `App credentials are in ${dir}, so this install is on the GitHub App route; run this step to record it or to switch`,
              },
            ],
          }
        : {
            ok: false,
            checks: [
              { name: "github_auth", ok: false, detail: "not answered yet — run this step" },
            ],
          };
    },
  };
}
