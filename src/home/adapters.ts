// The home's real ports (src/home/ports.ts), and the one function that turns
// a process's environment into the home's options: the env shim
// (extensions/cli/home.ts) calls `homeOptionsFromEnv(process.env)`.
//
//   pi login   the auth file of the pi home the chat runs in: pi's own
//              agent dir ($PI_CODING_AGENT_DIR, else ~/.pi/agent), read the
//              way pi reads it, so the login line and the chat cannot
//              disagree. Provider ids only, never a token.
//   GitHub     `gh`: the account, the repository's open PRs, the browser.
//   repository `[github] repo` of the install's config.toml, read again on
//              every refresh.
//   clock      Date.now.
//   reviews    the app's detached review runs, its review state and the
//              daemon's status (src/home/reviews.ts), as the person: their
//              environment, so the run uses their own pi login.
//
//   auto-review, memory
//              this machine's compose stack (src/home/autoreview.ts,
//              src/home/memory.ts): the containers, the daemon's own
//              status.json, and the switches over the wizard's steps.
//   login owner
//              the same pi agent dir: whether auto-review's refresher holds
//              the login (its lock beside auth.json, shared into the stack)
//              and whether its record says the login expired
//              (src/home/loginowner.ts).
//
//   spend      the app's detached runs' costs and the daemon's recorded
//              costs (src/home/spend.ts): unknown when either can't be read.
//
// The stack these drive is a compose project with the wizard's state under it
// (`homeStackRoot`): a checkout or the image is its own, an app installed by
// a package manager gets one in its state home, never inside the package.
import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { loginSummary } from "@quickchatai/pi-quickreview/src/engine/auth.js";
import { assetRoot } from "@quickchatai/pi-quickreview/src/assetroot.js";
import { postSavedReview } from "@quickchatai/pi-quickreview/src/savedpost.js";
import { HOME_DEFAULTS, sandboxRoot, type HomeToolSet } from "../config.js";
import { loadOneShotConfig, locateConfig, stackRoot, stateHome } from "../homes.js";
import type { OnboardAdapters, ProcessRunner } from "../onboard/engine.js";
import { openStepMemoryForward } from "../onboard/stepforward.js";
import { composeAutoReview, serviceState } from "./autoreview.js";
import { hostLoginOwner } from "./loginowner.js";
import { DAEMON_SERVICE } from "../onboard/steps/compose.js";
import { daemonSnapshot } from "./daemonstatus.js";
import { composeMemory } from "./memory.js";
import { realSpendPort } from "./spend.js";
import { composeAdvanced, type AdvancedPort } from "./advanced.js";
import { checkoutTune, type TunePort } from "./tune.js";
import { stepRunner } from "./switchon.js";
import { piAgentDir } from "../piagentdir.js";
import { qcrChild, realDetachSeams, reviewsPort } from "./reviews.js";
import {
  known,
  unknown,
  type AutoReviewPort,
  type GithubPort,
  type HomeAdapters,
  type Known,
  type MemoryPort,
  type OpenPull,
  type PiLoginPort,
  type RepoPort,
  type ReviewsPort,
  type SpendPort,
} from "./ports.js";

/** The launch hands the child pi its model and tool set in these. */
export const HOME_MODEL_ENV = "QCR_HOME_MODEL";
export const HOME_TOOLS_ENV = "QCR_HOME_TOOLS";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** The command is not installed. */
  missing?: boolean;
}

export interface Runner {
  run(cmd: string, args: readonly string[]): Promise<RunResult>;
}

export const execRunner: Runner = {
  run: (cmd, args) =>
    new Promise((resolve) => {
      execFile(cmd, [...args], { timeout: 30_000, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: unknown }) | null;
        resolve({
          code: e === null ? 0 : typeof e.code === "number" ? e.code : 1,
          stdout: String(stdout),
          stderr: e && !stderr ? String(e.message) : String(stderr),
          ...(e?.code === "ENOENT" ? { missing: true } : {}),
        });
      });
    }),
};

const firstLine = (s: string): string => s.trim().split("\n")[0]?.trim() || "no output";
const isMissingFile = (err: unknown): boolean =>
  (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The providers pi holds a login for in `agentDir`. No auth file is no
 * login; a file that cannot be read or parsed is unknown. */
export function piLoginPort(
  agentDir: string,
  read: (p: string) => string = (p) => readFileSync(p, "utf8"),
): PiLoginPort {
  return {
    providers: async () => {
      const path = join(agentDir, "auth.json");
      let raw: string;
      try {
        raw = read(path);
      } catch (err) {
        return isMissingFile(err) ? known([]) : unknown(`can't read ${path}: ${message(err)}`);
      }
      try {
        return known(Object.keys(loginSummary(raw)));
      } catch (err) {
        return unknown(`can't parse ${path}: ${message(err)}`);
      }
    },
  };
}

/** gh's words for "you are not signed in". */
const SIGNED_OUT = /gh auth login|not logged in|authentication required|HTTP 401|bad credentials/i;

const PR_FIELDS =
  "number,title,author,updatedAt,isDraft,additions,deletions,changedFiles,headRefName,headRefOid";

export function githubPort(runner: Runner): GithubPort {
  const why = (r: RunResult): string =>
    r.missing ? "gh is not installed" : `gh failed: ${firstLine(r.stderr)}`;
  return {
    user: async () => {
      const r = await runner.run("gh", ["api", "user", "--jq", ".login"]);
      if (r.code === 0 && r.stdout.trim() !== "") return known(r.stdout.trim());
      if (!r.missing && SIGNED_OUT.test(r.stderr)) return known(null);
      return unknown(why(r));
    },
    openPulls: async (repo) => {
      const r = await runner.run("gh", [
        "pr",
        "list",
        "-R",
        repo,
        "--state",
        "open",
        "--limit",
        "200",
        "--json",
        PR_FIELDS,
      ]);
      if (r.code !== 0) return unknown(why(r));
      try {
        return known(parsePulls(r.stdout));
      } catch (err) {
        return unknown(`gh's answer is not a pull request list: ${message(err)}`);
      }
    },
    openInBrowser: async (repo, pr) => {
      const r = await runner.run("gh", ["pr", "view", String(pr), "-R", repo, "--web"]);
      return r.code === 0 ? { ok: true } : { ok: false, why: why(r) };
    },
  };
}

/** `gh pr list --json` rows as OpenPulls; throws on a row of the wrong shape. */
export function parsePulls(json: string): OpenPull[] {
  const rows = JSON.parse(json) as unknown;
  if (!Array.isArray(rows)) throw new Error("not an array");
  return rows.map((r: Record<string, unknown>) => {
    if (typeof r["number"] !== "number" || typeof r["title"] !== "string")
      throw new Error("a row without a number or title");
    const author = r["author"] as { login?: unknown } | null | undefined;
    const num = (k: string): number => (typeof r[k] === "number" ? r[k] : 0);
    return {
      number: r["number"],
      title: r["title"],
      author: typeof author?.login === "string" ? author.login : "ghost",
      updatedAt: typeof r["updatedAt"] === "string" ? r["updatedAt"] : "",
      isDraft: r["isDraft"] === true,
      additions: num("additions"),
      deletions: num("deletions"),
      changedFiles: num("changedFiles"),
      headRefName: typeof r["headRefName"] === "string" ? r["headRefName"] : "",
      headSha: typeof r["headRefOid"] === "string" ? r["headRefOid"] : "",
    };
  });
}

/** `[github] repo` of the config at `configPath()`, located again on every
 * read. No config file, or an empty repo, is no repository. */
export function repoPort(
  configPath: () => string,
  read: (p: string) => string = (p) => readFileSync(p, "utf8"),
): RepoPort {
  return {
    repo: async () => {
      let path: string;
      let raw: string;
      try {
        path = configPath();
        raw = read(path);
      } catch (err) {
        return isMissingFile(err) ? known(null) : unknown(message(err));
      }
      let repo: unknown;
      try {
        repo = (
          (parse(raw) as Record<string, unknown>)["github"] as Record<string, unknown> | undefined
        )?.["repo"];
      } catch (err) {
        return unknown(`${path} is not valid TOML: ${message(err)}`);
      }
      if (repo === undefined || repo === "") return known(null);
      return typeof repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(repo.trim())
        ? known(repo.trim())
        : unknown(`${path}: [github] repo is not "owner/name" (${JSON.stringify(repo)})`);
    },
  };
}

const NOT_YET = "the home cannot read it yet";
const notYet = async (): Promise<Known<never>> => unknown(NOT_YET);

/** The ports that have no adapter yet: each answers unknown. */
export const unbuiltPorts: {
  autoReview: AutoReviewPort;
  memory: MemoryPort;
  spend: SpendPort;
} = {
  autoReview: { status: notYet },
  memory: { status: notYet },
  spend: { totals: notYet },
};

/** The reviewer as the person: the app's own bin and registry, the install's
 * state home and config, in the environment the home runs in; auto-review's
 * rounds from the daemon of the compose stack at `stack.root`. */
export function realReviewsPort(
  env: Readonly<Record<string, string | undefined>>,
  stack: { root: string; runner: ProcessRunner },
): ReviewsPort {
  const state = stateHome(env);
  const appRoot = sandboxRoot();
  // the home's own working directory (src/home/launch.ts `homePaths`)
  const cwd = join(state, "home");
  const proc = { execPath: process.execPath, bin: join(appRoot, "bin", "qcr.js"), cwd, env };
  const config = () => loadOneShotConfig({ root: assetRoot(), env }).cfg;
  return reviewsPort({
    registry: join(state, "review", "detached"),
    reportsDir: join(cwd, "reviews"),
    reviewHome: join(state, "review"),
    snapshot: () => daemonSnapshot(stack.runner, stack.root),
    qcr: qcrChild(proc),
    detach: realDetachSeams(proc),
    post: async (file) => {
      const r = await postSavedReview(file, {
        config: config(),
        dryrunDir: join(state, "review", "dryrun"),
        github: { env },
      });
      return { failed: r.failed, line: r.line };
    },
    dryRun: () => config().dry_run,
    now: () => Date.now(),
  });
}

/** The wizard's adapters for switch-on's steps, over the app root. */
export function stepAdapters(root: string, configPath: () => string) {
  return (log: (line: string) => void): OnboardAdapters => ({
    fetch: (input, init) => fetch(input, init),
    runner: stepRunner,
    clock: () => new Date(),
    host: {
      nodeVersion: process.version,
      uid: typeof process.getuid === "function" ? process.getuid() : null,
      inContainer: existsSync("/.dockerenv"),
    },
    paths: { stateDir: join(root, "state"), configPath: configPath() },
    log,
    memoryForward: (req) => openStepMemoryForward(req),
  });
}

export function realHomeAdapters(o: {
  agentDir: string;
  configPath: () => string;
  reviews: ReviewsPort;
  runner?: Runner;
  /** The app root, the compose project of this machine's stack: given, the
   * auto-review and memory ports read and switch it. */
  root?: string;
  /** The spend line's port (src/home/spend.ts); absent, its stub. */
  spend?: SpendPort;
}): HomeAdapters {
  const repo = repoPort(o.configPath);
  const stack =
    o.root === undefined
      ? null
      : {
          root: o.root,
          configPath: o.configPath,
          runner: stepRunner,
          stepAdapters: stepAdapters(o.root, o.configPath),
        };
  const daemonRuns = stack
    ? async (): Promise<boolean | null> => {
        const s = await serviceState(stack.runner, stack.root, DAEMON_SERVICE);
        return s.kind === "known" ? s.value !== "stopped" : null;
      }
    : undefined;
  return {
    login: piLoginPort(o.agentDir),
    loginOwner: hostLoginOwner({
      loginDir: o.agentDir,
      now: () => Date.now(),
      ...(daemonRuns ? { daemonRuns } : {}),
    }),
    github: githubPort(o.runner ?? execRunner),
    repo,
    clock: { now: () => Date.now() },
    reviews: o.reviews,
    ...unbuiltPorts,
    ...(o.spend ? { spend: o.spend } : {}),
    ...(stack
      ? {
          // switch-on shares the home's login with the stack (src/onboard/steps/loginshare.ts)
          autoReview: composeAutoReview({ ...stack, loginDir: o.agentDir, now: () => Date.now() }),
          memory: composeMemory({
            ...stack,
            repo: async () => {
              const r = await repo.repo();
              return r.kind === "known" ? r.value : null;
            },
          }),
        }
      : {}),
  };
}

/** What a compose project needs from the app: the stack, the tunnel
 * wrappers' build context, and the config template the steps fill from. */
export const STACK_FILES: readonly string[] = [
  "docker-compose.yml",
  join("docker", "tunnel"),
  "config.example.toml",
];

/** The compose project the home's switches drive: src/homes.ts `stackRoot`,
 * the one rule every surface that reads the stack uses. */
export function homeStackRoot(
  env: Readonly<Record<string, string | undefined>>,
  pkgRoot: string = sandboxRoot(),
): string {
  return stackRoot(env, pkgRoot);
}

/** Give a stack outside the package the package's own STACK_FILES, again on
 * every launch, so an update brings the stack that matches the app. The
 * person's state there (`.env`, `state/`) is never touched. A copy that
 * fails is left to the compose-file check, which says what is missing. */
export function seedStack(root: string, pkgRoot: string): void {
  if (root === pkgRoot) return;
  for (const f of STACK_FILES) {
    const from = join(pkgRoot, f);
    if (!existsSync(from)) continue;
    try {
      mkdirSync(root, { recursive: true });
      cpSync(from, join(root, f), { recursive: true, force: true });
    } catch {
      // the compose-file check names it
    }
  }
}

/** The home's options from a process's environment: the env shim's one call. */
export function homeOptionsFromEnv(env: Readonly<Record<string, string | undefined>>): {
  adapters: HomeAdapters;
  model: string;
  tools: HomeToolSet;
  tune: TunePort;
  advanced: AdvancedPort;
} {
  const model = (env[HOME_MODEL_ENV] ?? "").trim() || HOME_DEFAULTS.model;
  const tools: HomeToolSet = env[HOME_TOOLS_ENV] === "full" ? "full" : "reviewer";
  const root = homeStackRoot(env);
  seedStack(root, sandboxRoot());
  const configPath = (): string => locateConfig({ env }).path;
  return {
    adapters: realHomeAdapters({
      agentDir: piAgentDir(env),
      configPath,
      reviews: realReviewsPort(env, { root, runner: stepRunner }),
      root,
      spend: realSpendPort({
        registry: join(stateHome(env), "review", "detached"),
        root,
        runner: stepRunner,
      }),
    }),
    model,
    tools,
    tune: checkoutTune({ env, root: assetRoot, configPath, runner: stepRunner }),
    advanced: composeAdvanced({
      root,
      env,
      stepAdapters: stepAdapters(root, configPath),
    }),
  };
}
