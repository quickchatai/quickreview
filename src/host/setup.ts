// `host setup --repo owner/name --auth user` (or `--auth installation
// --app-slug <slug>`), with an optional `--trigger label|all`: a host starts
// the reviewer for its operator.
//
// The verb itself is short. It checks what it can check at once, writes the
// config, starts switch-on's walk as a detached process and answers
// `started`; the walk (src/host/walk.ts) goes on without it and the board
// export's `setup` field says how far it has got. Everything is done under
// the checklist lock, which the verb takes and hands to the walk, so a second
// call while the first walk runs answers `running` and starts nothing.
//
// It acts on installs a host manages, and on no other. On a machine with no
// config yet it writes the marker itself (`[github] token_source = "host"`)
// with the auth mode beside it: the install is its host's from its first
// line. On a config that is already there and does not carry the marker it
// refuses, before anything is written: a host verb never turns an install
// that keeps its own credential into a host-managed one. (Without the marker
// the walk's account step would take the person's own route: run `gh`, and
// write its token over the file a host keeps.)
//
// `--trigger label|all` says which pull requests the reviewer picks up by
// itself (`[github] trigger`): the ones that carry the trigger label, or
// every one, which spends model usage on every pull request. It is written
// with the rest of the config. Left out, the config's own stays, and a new
// config's is `label`. `host set-trigger` changes it later, and its choice
// is the running daemon's to keep (src/host/trigger.ts): from then on it wins
// over this key, until a later setup writes another line here. The daemon
// keeps the line the choice was made over, and its next start drops a choice
// the config was set over since (src/triggerchoice.ts); a setup that restates
// that very line leaves the choice standing.
//
// What it refuses, in words, before anything is written:
//
//   an install no host      a config that is there and does not carry the
//   manages                 marker
//   a missing model login   the stack reviews on the login of the pi on this
//                           machine; with none there is nothing to share
//   another repository, or  a reviewer keeps the repository and the identity
//   another auth mode       it was first set up with: both the config and the
//                           checklist are asked what is on record
//   a token it cannot use   the token file is the GitHub credential here. It
//                           is read with one call, which is also where the
//                           repository's name and default branch come from.
//                           No `gh` is run
//
// The config is the shipped template with the repository in it, or the
// install's own with it (src/onboard/steps/hostconfig.ts). It never states
// another `dry_run` than it did: the reviewer comes up in dry-run because the
// template ships it so, and a later go-live is the only thing that moves it.
//
// `--auth installation` sets the reviewer up on an App installation's token
// that the host supplies in the token file, and needs `--app-slug`: the slug
// of the GitHub App the token belongs to. There is no App key on the machine
// to ask the App who it is, so the slug is the host's to name, and the verb
// checks it before anything is written: the token's own login (GraphQL's
// `viewer`; GitHub's user endpoint refuses an installation token and is
// never asked) must be the `<slug>[bot]` the slug implies. A slug that names
// another App is refused as `identity_mismatch`, since a reviewer that does
// not know its own login never recognises its own reviews. The config then
// states `auth = "installation"`, the slug and the login beside the marker,
// both as GitHub spells them: the check ignores case as GitHub does, and the
// reviewer's own-content checks do not.
import {
  githubSpelledSlug,
  hostTokenProblem,
  readHostMarker,
  readTokenFile,
  tokenIdentityProblem,
  tokenOwnLogin,
} from "@quickchatai/pi-quickreview/src/hosttoken.js";
import { APP_SLUG_RE, appBotLogin } from "@quickchatai/pi-quickreview/src/reviewconfig.js";
import { configFacts, modelLoginWord } from "../boardexport.js";
import { acquireChecklistLock } from "../onboard/checklistlock.js";
import { CHOICE_KEYS, REPO_SLUG_RE } from "../onboard/choices.js";
import { readChecklist } from "../onboard/engine.js";
import { api } from "../onboard/steps/githubapp.js";
import { renderHostConfig } from "../onboard/steps/hostconfig.js";
import { admit, notHostManaged } from "./admit.js";
import { refused, type HostAnswer, type TriggerWord } from "./outcomes.js";
import { lockOptions, type HostPorts } from "./ports.js";
import { updateHostRecord } from "./record.js";

export const SETUP_USAGE =
  "usage: qcr --schema 3 host setup --repo <owner/name> (--auth user | --auth installation --app-slug <slug>) [--trigger label|all]";

/** The auth modes the verb reads. */
export const SETUP_AUTH_MODES = ["user", "installation"] as const;
export type SetupAuth = (typeof SETUP_AUTH_MODES)[number];

export interface SetupArgs {
  repo: string;
  auth: SetupAuth;
  /** Which pull requests the reviewer picks up by itself, when the host
   * said. Left out, the config's own stays: `label` on a new install. */
  trigger?: TriggerWord;
  /** The App the installation token belongs to: with `installation`, always. */
  appSlug?: string;
}

/** The verb's arguments; a string says what is wrong with them. */
export function parseSetupArgs(args: readonly string[]): SetupArgs | string {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    const eq = arg.indexOf("=");
    const name = eq < 0 ? arg : arg.slice(0, eq);
    if (name !== "--repo" && name !== "--auth" && name !== "--app-slug" && name !== "--trigger")
      return `${JSON.stringify(arg)} is not an argument of host setup`;
    if (values.has(name)) return `${name} is given twice`;
    const value = eq < 0 ? args[++i] : arg.slice(eq + 1);
    if (value === undefined || value === "") return `${name} names nothing`;
    values.set(name, value);
  }
  const repo = values.get("--repo");
  const auth = values.get("--auth");
  const appSlug = values.get("--app-slug");
  const trigger = values.get("--trigger");
  if (repo === undefined) return "--repo is missing";
  if (!REPO_SLUG_RE.test(repo)) return `--repo ${JSON.stringify(repo)} is not owner/name`;
  if (auth === undefined) return "--auth is missing";
  if (auth !== "user" && auth !== "installation")
    return `--auth ${JSON.stringify(auth)} is neither user nor installation`;
  if (appSlug !== undefined && !APP_SLUG_RE.test(appSlug))
    return `--app-slug ${JSON.stringify(appSlug)} is not a GitHub App slug`;
  if (appSlug !== undefined && auth === "user")
    return "--app-slug goes with --auth installation: a person's account has no App";
  if (appSlug === undefined && auth === "installation")
    return "--auth installation needs --app-slug: the slug of the GitHub App the installation token belongs to";
  if (trigger !== undefined && trigger !== "label" && trigger !== "all")
    return `--trigger ${JSON.stringify(trigger)} is neither label nor all`;
  return {
    repo,
    auth,
    ...(appSlug !== undefined ? { appSlug } : {}),
    ...(trigger !== undefined ? { trigger } : {}),
  };
}

const sameRepo = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * Why this call names another reviewer than the one on record, or null. The
 * config says what the daemon runs on; the checklist says what setup was
 * first answered with.
 */
export function bindingMismatch(
  asked: SetupArgs,
  existing: string | null,
  choices: Readonly<Record<string, unknown>>,
): HostAnswer | null {
  const facts: ReturnType<typeof configFacts> = existing === null ? {} : configFacts(existing);
  const choice = (key: string): string | undefined => {
    const v = choices[key];
    return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
  };
  for (const recorded of [facts.repo, choice(CHOICE_KEYS.accountRepo), choice(CHOICE_KEYS.repo)])
    if (recorded !== undefined && !sameRepo(recorded, asked.repo))
      return refused(
        "repo_mismatch",
        `this reviewer is set up for ${recorded}, not ${asked.repo}: a reviewer keeps the repository it was set up with. Nothing changed`,
      );
  for (const recorded of [facts.identity?.mode, choice(CHOICE_KEYS.githubAuth)])
    if (recorded !== undefined && recorded !== asked.auth)
      return refused(
        "auth_mismatch",
        `this reviewer is set up with auth = "${recorded}", not "${asked.auth}": a reviewer keeps the identity it was set up with. Nothing changed`,
      );
  // The same mode under another App is another identity too. The checklist
  // says which App the walk proved; the config says it only once the mode on
  // record is this one (a template's or a person's `bot_login` names no App).
  if (asked.auth === "installation" && asked.appSlug !== undefined) {
    const login = appBotLogin(asked.appSlug);
    const proved = choice(CHOICE_KEYS.appSlug);
    const written = facts.identity?.mode === "installation" ? facts.identity.login : undefined;
    for (const recorded of [proved !== undefined ? appBotLogin(proved) : undefined, written])
      if (recorded !== undefined && recorded.toLowerCase() !== login.toLowerCase())
        return refused(
          "auth_mismatch",
          `this reviewer is set up to post as ${recorded}, not ${login}: a reviewer keeps the identity it was set up with. Nothing changed`,
        );
  }
  return null;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const isMissingFile = (err: unknown): boolean =>
  (err as NodeJS.ErrnoException | null)?.code === "ENOENT";

/** The repository as GitHub shows it to the token file's token. */
type RepositoryRead =
  { ok: true; repo: string; defaultBranch: string | null } | { ok: false; answer: HostAnswer };

async function readRepository(
  ports: HostPorts,
  token: string,
  repo: string,
): Promise<RepositoryRead> {
  const r = await api(ports.fetch, `${ports.apiBase}/repos/${repo}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const no = (answer: HostAnswer): RepositoryRead => ({ ok: false, answer });
  if (r.status === 0)
    return no(refused("github_unreachable", `GitHub could not be reached to read ${repo}`));
  if (r.status === 401)
    return no(
      refused(
        "github_token_rejected",
        "GitHub refused the token in the token file (HTTP 401): the host that manages it renews it",
      ),
    );
  if (r.status === 403 || r.status === 404)
    return no(
      refused(
        "repo_unreachable",
        `the token in the token file cannot read ${repo} (HTTP ${r.status})`,
      ),
    );
  if (r.status !== 200)
    return no(refused("github_unreachable", `GitHub answered HTTP ${r.status} for ${repo}`));
  const body = (r.body ?? {}) as Record<string, unknown>;
  const name = typeof body["full_name"] === "string" ? body["full_name"] : repo;
  if (!REPO_SLUG_RE.test(name) || !sameRepo(name, repo))
    return no(
      refused(
        "repo_unreachable",
        `${repo} is not where GitHub keeps that repository now: it has been renamed or moved`,
      ),
    );
  if (body["archived"] === true)
    return no(refused("repo_unreachable", `${repo} is archived: nothing can be reviewed there`));
  const branch = body["default_branch"];
  return {
    ok: true,
    repo: name,
    defaultBranch: typeof branch === "string" && branch !== "" ? branch : null,
  };
}

/** The App's slug as GitHub spells it, once the token is proved to be that
 * App's; otherwise why not. */
type IdentityRead = { ok: true; slug: string } | { ok: false; answer: HostAnswer };

/**
 * Is the token file's token the App `slug` names? Asked of GitHub once,
 * before anything is written: a token that cannot say who it is refuses the
 * setup as much as one that is another App's. The check ignores case, as
 * GitHub does; the slug it answers with is the one GitHub's login spells,
 * which is what the config states, since the reviewer recognises its own
 * reviews by a comparison that does not ignore it.
 */
async function identityRead(ports: HostPorts, token: string, slug: string): Promise<IdentityRead> {
  const expected = appBotLogin(slug);
  const no = (answer: HostAnswer): IdentityRead => ({ ok: false, answer });
  const who = await tokenOwnLogin(ports.fetch, token, ports.apiBase);
  if (!who.ok)
    return no(
      who.status === 401
        ? refused(
            "github_token_rejected",
            "GitHub refused the token in the token file (HTTP 401): the host that manages it renews it",
          )
        : refused(
            "github_unreachable",
            `${who.detail}, so it could not be checked that it posts as ${expected}. Nothing changed`,
          ),
    );
  const problem = tokenIdentityProblem(expected, who.login);
  const spelled = problem === null ? githubSpelledSlug(slug, who.login) : null;
  if (spelled !== null) return { ok: true, slug: spelled };
  return no(
    refused(
      "identity_mismatch",
      `${problem ?? `the token in the token file acts as ${who.login}, which is not an App's bot login`}. ` +
        `--app-slug ${slug} must be the slug of the App the token was minted for. Nothing changed`,
    ),
  );
}

const NOT_A_HOSTS = (ports: Pick<HostPorts, "configPath">): string =>
  `${ports.configPath} is the config of an install that keeps its own GitHub credential`;

/** Is there a config here that reads as TOML and does not carry the
 * host-managed marker? One that is absent, unreadable or not TOML says
 * nothing either way, and is judged under the lock as what it is. */
function keepsOwnCredential(ports: Pick<HostPorts, "read" | "configPath">): boolean {
  try {
    return readHostMarker(ports.read(ports.configPath))?.hostManaged === false;
  } catch {
    return false;
  }
}

/** The `setup` verb. */
export async function hostSetup(ports: HostPorts, args: readonly string[]): Promise<HostAnswer> {
  const no = admit(ports);
  if (no !== null) return no;
  const asked = parseSetupArgs(args);
  if (typeof asked === "string") return refused("usage", `${asked}. ${SETUP_USAGE}`);
  // Asked before the lock, so a refusal leaves no file behind on an install
  // that is not a host's, and again below on the text the config is written
  // from.
  if (keepsOwnCredential(ports)) return notHostManaged(NOT_A_HOSTS(ports));
  const got = acquireChecklistLock(ports.stateDir, "setup", lockOptions(ports));
  if (!got.ok)
    return got.held.holder === "setup"
      ? { state: "running" }
      : { state: "busy", holder: got.held.holder };
  const lock = got.lock;
  let handed = false;
  try {
    let existing: string | null;
    try {
      existing = ports.read(ports.configPath);
    } catch (err) {
      if (!isMissingFile(err))
        return refused(
          "config_unreadable",
          `can't read ${ports.configPath} (${message(err)}). Nothing changed`,
        );
      existing = null;
    }
    // A config that is there and reads as TOML either carries the marker or
    // is not this verb's to write. (One that is not TOML says nothing either
    // way, and is refused below as what it is.)
    if (existing !== null && readHostMarker(existing)?.hostManaged === false)
      return notHostManaged(NOT_A_HOSTS(ports));

    // the login the stack will review on
    const login = modelLoginWord({
      agentDir: ports.agentDir,
      read: (p) => ports.read(p),
      now: ports.now().getTime(),
      daemonRuns: null,
      pausedOnLogin: false,
    });
    if (login === "missing")
      return refused(
        "model_login_missing",
        `there is no model login in ${ports.agentDir} yet: sign in to a model provider on this machine first, then start again. Nothing changed`,
      );
    if (login === undefined)
      return refused(
        "model_login_unreadable",
        `the model login in ${ports.agentDir} cannot be read. Nothing changed`,
      );

    // the GitHub credential: the token file, never `gh`
    const file = readTokenFile(ports.secretsDir(), (p) => ports.read(p));
    if (!file.ok)
      return refused(
        file.reason === "missing" || file.reason === "empty"
          ? "github_token_missing"
          : "github_token_unreadable",
        `${hostTokenProblem(file)}. Nothing changed`,
      );

    const mismatch = bindingMismatch(asked, existing, readChecklist(ports.stateDir)?.choices ?? {});
    if (mismatch !== null) return mismatch;

    const seen = await readRepository(ports, file.token, asked.repo);
    if (!seen.ok) return seen.answer;

    // an installation's identity is the slug's: is the token that App's?
    // The config states the slug as GitHub spells it.
    let appSlug: string | undefined;
    if (asked.auth === "installation" && asked.appSlug !== undefined) {
      const who = await identityRead(ports, file.token, asked.appSlug);
      if (!who.ok) return who.answer;
      appSlug = who.slug;
    }

    let template: string;
    try {
      template = ports.template();
    } catch (err) {
      return refused(
        "config_invalid",
        `the shipped config template cannot be read (${message(err)}). Nothing changed`,
      );
    }
    const rendered = renderHostConfig(existing, template, {
      repo: seen.repo,
      baseBranch: seen.defaultBranch,
      timezone: ports.timezone(),
      auth: asked.auth,
      ...(asked.trigger !== undefined ? { trigger: asked.trigger } : {}),
      ...(asked.auth === "installation" && appSlug !== undefined ? { appSlug } : {}),
    });
    if (!rendered.ok) return refused("config_invalid", rendered.why);
    try {
      if (rendered.text !== existing) ports.write(ports.configPath, rendered.text);
    } catch (err) {
      return refused(
        "config_unreadable",
        `can't write ${ports.configPath} (${message(err)}). Nothing changed`,
      );
    }

    // from here the walk owns the work: its record first, then the process
    const at = ports.now().toISOString();
    updateHostRecord(ports.stateDir, (r) => ({
      ...r,
      setup: { state: "running", step: "machine_checks", started_at: at, updated_at: at },
    }));
    const failed = (why: string): HostAnswer => {
      const now = ports.now().toISOString();
      updateHostRecord(ports.stateDir, (r) => ({
        ...r,
        setup: { state: "failed", problem: "internal_error", started_at: at, updated_at: now },
      }));
      return refused("launch_failed", `the setup could not be started: ${why}`);
    };
    let child: ReturnType<HostPorts["launch"]>;
    try {
      ports.seedStack();
      child = ports.launch("setup", lock.record.token);
    } catch (err) {
      return failed(message(err));
    }
    if (!child.ok) return failed(child.error);
    if (!lock.handTo(child.pid)) return failed("the setup lock could not be handed to it");
    handed = true;
    return { state: "started" };
  } finally {
    if (!handed) lock.release();
  }
}
