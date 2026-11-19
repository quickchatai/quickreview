// `host setup --repo owner/name --auth user|installation [--app-slug <slug>]`:
// a host starts the reviewer for its operator.
//
// The verb itself is short. It checks what it can check at once, writes the
// config, starts switch-on's walk as a detached process and answers
// `started`; the walk (src/host/walk.ts) goes on without it and the board
// export's `setup` field says how far it has got. Everything is done under
// the checklist lock, which the verb takes and hands to the walk, so a second
// call while the first walk runs answers `running` and starts nothing.
//
// What it refuses, in words, before anything is written:
//
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
// `--auth installation` is read and refused: the credential mode it names is
// not in this release.
import { hostTokenProblem, readTokenFile } from "@quickchatai/pi-quickreview/src/hosttoken.js";
import { configFacts, modelLoginWord } from "../boardexport.js";
import { acquireChecklistLock } from "../onboard/checklistlock.js";
import { CHOICE_KEYS, REPO_SLUG_RE } from "../onboard/choices.js";
import { readChecklist } from "../onboard/engine.js";
import { api } from "../onboard/steps/githubapp.js";
import { renderHostConfig } from "../onboard/steps/hostconfig.js";
import { admit } from "./admit.js";
import { refused, type HostAnswer } from "./outcomes.js";
import type { HostPorts } from "./ports.js";
import { updateHostRecord } from "./record.js";

export const SETUP_USAGE =
  "usage: qcr --schema 3 host setup --repo <owner/name> --auth user|installation [--app-slug <slug>]";

/** The auth modes the verb reads. */
export const SETUP_AUTH_MODES = ["user", "installation"] as const;
export type SetupAuth = (typeof SETUP_AUTH_MODES)[number];

/** A GitHub App slug, as GitHub writes one. */
const APP_SLUG_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/;

export interface SetupArgs {
  repo: string;
  auth: SetupAuth;
  appSlug?: string;
}

/** The verb's arguments; a string says what is wrong with them. */
export function parseSetupArgs(args: readonly string[]): SetupArgs | string {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    const eq = arg.indexOf("=");
    const name = eq < 0 ? arg : arg.slice(0, eq);
    if (name !== "--repo" && name !== "--auth" && name !== "--app-slug")
      return `${JSON.stringify(arg)} is not an argument of host setup`;
    if (values.has(name)) return `${name} is given twice`;
    const value = eq < 0 ? args[++i] : arg.slice(eq + 1);
    if (value === undefined || value === "") return `${name} names nothing`;
    values.set(name, value);
  }
  const repo = values.get("--repo");
  const auth = values.get("--auth");
  const appSlug = values.get("--app-slug");
  if (repo === undefined) return "--repo is missing";
  if (!REPO_SLUG_RE.test(repo)) return `--repo ${JSON.stringify(repo)} is not owner/name`;
  if (auth === undefined) return "--auth is missing";
  if (auth !== "user" && auth !== "installation")
    return `--auth ${JSON.stringify(auth)} is neither user nor installation`;
  if (appSlug !== undefined && !APP_SLUG_RE.test(appSlug))
    return `--app-slug ${JSON.stringify(appSlug)} is not a GitHub App slug`;
  if (appSlug !== undefined && auth === "user")
    return "--app-slug goes with --auth installation: a person's account has no App";
  return { repo, auth, ...(appSlug !== undefined ? { appSlug } : {}) };
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

/** The `setup` verb. */
export async function hostSetup(ports: HostPorts, args: readonly string[]): Promise<HostAnswer> {
  const no = admit(ports);
  if (no !== null) return no;
  const asked = parseSetupArgs(args);
  if (typeof asked === "string") return refused("usage", `${asked}. ${SETUP_USAGE}`);
  if (asked.auth === "installation")
    return refused(
      "unsupported_auth",
      "--auth installation is not supported by this release yet: a host-supplied installation token comes with a later one. Nothing changed",
    );

  const got = acquireChecklistLock(ports.stateDir, "setup", {
    pid: ports.pid,
    now: () => ports.now(),
    alive: (pid) => ports.alive(pid),
  });
  if (!got.ok)
    return got.held.holder === "setup"
      ? { state: "running" }
      : { state: "busy", holder: got.held.holder };
  const lock = got.lock;
  let handed = false;
  try {
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
    const mismatch = bindingMismatch(asked, existing, readChecklist(ports.stateDir)?.choices ?? {});
    if (mismatch !== null) return mismatch;

    const seen = await readRepository(ports, file.token, asked.repo);
    if (!seen.ok) return seen.answer;

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
