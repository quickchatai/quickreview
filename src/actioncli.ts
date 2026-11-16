// `qcr action`: the QuickReview GitHub Action set up in a repository, from the
// npm CLI.
//
//   qcr action install [--on comment,label,push,manual] [--secret NAME]
//                      [--repo OWNER/NAME] [--local] [--force] [--yes] [--json]
//   qcr action workflow [--on …] [--secret NAME] [--json]
//   qcr action
//
// `workflow` prints the workflow (src/actionworkflow.ts) and writes nothing.
// `install` does what a person would do by hand, in order, and says each step:
//
//   1. the repository: --repo, else this checkout's origin on github.com;
//   2. gh: installed, logged in to github.com, and a token with the `repo` and
//      `workflow` scopes (a workflow file cannot be pushed without
//      `workflow`); missing, it says what to run and stops before any write,
//      unless --local, which needs gh for nothing but the secret and the label;
//   3. the triggers: --on, else asked, else comment and manual;
//   4. the secret's name: --secret, else the environment key the model route
//      here uses (`qcr model --json`), else asked, else a usage error;
//   5. the secret's value: kept when the repository has the secret; else the
//      local value of that name, on gh's stdin and never in an argv; else gh
//      asks for it on the terminal; else the command is printed;
//   6. the label qcr-review, with the `label` trigger ("already exists" is
//      fine);
//   7. the workflow, `.github/workflows/quickreview.yml`: by default a branch
//      from the default branch's head, the file put there with the contents
//      API, and a pull request, all on GitHub without touching the checkout;
//      with --local, written into this checkout. An existing file is replaced
//      only with --force;
//   8. what was done and what comes next.
//
// Every write asks first unless --yes; with no terminal and no --yes nobody
// can say yes, so the write is not made and its command is printed instead. A
// step that cannot be done prints the command for the person and the run goes
// on where it can. `--json` prints one object. Exit 0 when every step was
// done or printed, 1 when one failed, 2 for usage.
//
// These are GitHub writes outside the one mutation gate (AGENTS.md invariant
// 1), and they are its named exception, recorded in ADR 0003
// (docs/adr/0003-setup-writes-through-gh.md): the person's own gh, on their
// command, after asking. The gate is the reviewer's: its dry_run ships true,
// and the install would then record and not send. The exception is closed:
// this module runs gh only through `runGh`, whose calls are the closed list in
// `ghCallAllowed`, and any other gh call throws before it runs
// (tests/action-install.test.ts drives every path against that list). The
// bot's own writes are untouched.
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  ACTION_DOCS_URL,
  DEFAULT_RECIPES,
  RECIPES,
  RECIPE_SAYS,
  REVIEW_LABEL,
  WORKFLOW_PATH,
  parseRecipes,
  renderWorkflow,
  secretNameProblem,
  type Recipe,
} from "./actionworkflow.js";
import { parseRepoInput } from "./home/setup.js";
import { writeInCheckout } from "./home/tune.js";
import type { ModelCliJson } from "./modelcli.js";

export const ACTION_USAGE = [
  "usage: qcr action install [--on comment,label,push,manual] [--secret NAME] [--repo OWNER/NAME]",
  "                          [--local] [--force] [--yes] [--json]",
  "       qcr action workflow [--on comment,label,push,manual] [--secret NAME] [--json]",
].join("\n");

/** `qcr action` with no verb, or `--help`. */
export const ACTION_HELP = [
  "qcr action: review pull requests in GitHub Actions with the QuickReview Action.",
  "",
  ACTION_USAGE,
  "",
  "  install   store your model's API key as a repository secret and open a pull request",
  `            that adds ${WORKFLOW_PATH}, asking before each write`,
  "  workflow  print the workflow, write nothing",
  "",
  `Triggers (--on, comma-separated; default ${DEFAULT_RECIPES.join(",")}):`,
  ...RECIPES.map((r) => `  ${r.padEnd(8)}  ${RECIPE_SAYS[r]}`),
  "",
  "  --secret NAME  the repository secret that holds the model's API key, named as the",
  "                 environment variable your provider documents (default: the key qcr model uses here)",
  "  --repo R       the repository, OWNER/NAME (default: this checkout's origin)",
  "  --local        write the workflow into this checkout instead of opening a pull request",
  "  --force        replace a workflow that is already there",
  "  --yes          make every write without asking",
  "  --json         print one JSON object",
  "",
  `Docs: ${ACTION_DOCS_URL}`,
].join("\n");

/** What a child did. */
export interface ActionRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export interface ActionRunOptions {
  cwd: string;
  /** Written to the child's stdin; absent, stdin is /dev/null. */
  input?: string;
  /** Hand the terminal over (stdin, stdout and stderr inherited), so the child
   * asks the person itself; nothing is captured. */
  terminal?: boolean;
}

export interface ActionDeps {
  env: Readonly<Record<string, string | undefined>>;
  /** The directory the checkout is read from. */
  cwd: string;
  /** Is there a person at a terminal to ask (stdin and stdout)? */
  isTTY: boolean;
  run: (cmd: string, args: readonly string[], opts: ActionRunOptions) => ActionRunResult;
  /** Ask the person one question; null when nobody answered (the input
   * closed). Called only when `isTTY`. */
  prompt: (question: string) => Promise<string | null>;
  out: (line: string) => void;
  err: (line: string) => void;
  /** The environment key the model route here uses (`qcr model --json`:
   * an `env-key` credential's label), or null. */
  routeKey: () => Promise<string | null>;
}

/** A gh call that has not answered in this long is a failure. */
const GH_TIMEOUT_MS = 120_000;

/** The env key in what `qcr model --json` printed, or null. */
export function routeKeyOf(printed: string | undefined): string | null {
  let state: Partial<ModelCliJson> | null;
  try {
    state = JSON.parse(printed ?? "null") as Partial<ModelCliJson> | null;
  } catch {
    return null;
  }
  const cred = state?.route?.credential;
  return cred?.origin === "env-key" && typeof cred.label === "string" ? cred.label : null;
}

export function actionDeps(): ActionDeps {
  return {
    env: process.env,
    cwd: process.cwd(),
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    run: (cmd, args, opts) => {
      const o: SpawnSyncOptionsWithStringEncoding = opts.terminal
        ? { cwd: opts.cwd, encoding: "utf8", stdio: "inherit" }
        : {
            cwd: opts.cwd,
            encoding: "utf8",
            stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
            timeout: GH_TIMEOUT_MS,
            ...(opts.input === undefined ? {} : { input: opts.input }),
          };
      const r = spawnSync(cmd, [...args], o);
      return {
        status: r.status,
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
        ...(r.error ? { error: r.error } : {}),
      };
    },
    prompt: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await new Promise<string | null>((resolve) => {
          rl.once("close", () => resolve(null));
          void rl.question(question).then(resolve, () => resolve(null));
        });
      } finally {
        rl.close();
      }
    },
    out: (l) => console.log(l),
    err: (l) => console.error(l),
    // What `qcr model` resolves: the same borrow, environment and rule.
    routeKey: async () => {
      const { runModelCli } = await import("./modelcli.js");
      const printed: string[] = [];
      await runModelCli([], true, process.env, { out: (l) => printed.push(l), err: () => {} });
      return routeKeyOf(printed[0]);
    },
  };
}

// ---- gh, through one door -------------------------------------------------------

const same = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** `-f key=value` pairs, and nothing else. */
const onlyFields = (xs: readonly string[]): boolean =>
  xs.length % 2 === 0 && xs.every((x, i) => (i % 2 === 0 ? x === "-f" : /^[a-z_]+=/.test(x)));

/** `--repo <repo>` among `xs`. */
const namesRepo = (xs: readonly string[], repo: string): boolean => {
  const i = xs.indexOf("--repo");
  return i >= 0 && xs[i + 1] === repo;
};

/**
 * Is `args` a gh call this verb makes on `repo`? The closed list (ADR 0003):
 * `--version`, `auth status`, `secret list`, `secret set`, `label create`,
 * `api` GET on `repos/R`, `repos/R/contents/…` and `repos/R/git/ref/heads/…`,
 * `api -X POST repos/R/git/refs`, `api -X PUT repos/R/contents/…`, and
 * `pr create`, each on `repo` alone.
 */
export function ghCallAllowed(args: readonly string[], repo: string): boolean {
  const r = `repos/${repo}`;
  const [a, b, ...rest] = args;
  const safePath = (p: string | undefined): p is string =>
    p !== undefined && !/(^|\/)\.\.?(\/|$|\?)/.test(p) && !p.includes("//");
  if (args.length === 1) return a === "--version";
  if (a === "auth" && b === "status")
    return rest.length === 0 || same(rest, ["--hostname", "github.com"]);
  if (a === "secret" && b === "list") return same(rest, ["--repo", repo, "--app", "actions"]);
  if (a === "secret" && b === "set")
    return (
      rest[0] !== undefined &&
      secretNameProblem(rest[0]) === null &&
      same(rest.slice(1), ["--repo", repo, "--app", "actions"])
    );
  if (a === "label" && b === "create") return rest[0] === REVIEW_LABEL && namesRepo(rest, repo);
  if (a === "pr" && b === "create") return namesRepo(rest, repo);
  if (a === "api") {
    // a GET carries no field: gh turns a call with fields into a POST
    if (args.length === 2)
      return (
        safePath(b) &&
        (b === r || b.startsWith(`${r}/contents/`) || b.startsWith(`${r}/git/ref/heads/`))
      );
    if (b === "-X") {
      const [method, path, ...fields] = rest;
      if (!safePath(path) || !onlyFields(fields)) return false;
      if (method === "POST") return path === `${r}/git/refs`;
      if (method === "PUT") return path.startsWith(`${r}/contents/`);
    }
  }
  return false;
}

/** Run gh for `repo`: the one way this module reaches it. A call outside
 * `ghCallAllowed` throws before anything runs. */
export function runGh(
  deps: ActionDeps,
  repo: string,
  args: readonly string[],
  opts: { input?: string; terminal?: boolean } = {},
): ActionRunResult {
  if (!ghCallAllowed(args, repo))
    throw new Error(`\`gh ${args.join(" ")}\` is not a call qcr action makes`);
  return deps.run("gh", args, { cwd: deps.cwd, ...opts });
}

const ran = (r: ActionRunResult): boolean => r.error === undefined && r.status === 0;

/** What a failed child said, in one line. */
function said(r: ActionRunResult): string {
  if (r.error) return r.error.message;
  const last = (s: string): string =>
    s
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "")
      .pop() ?? "";
  return last(r.stderr) || last(r.stdout) || `exit ${r.status ?? "on a signal"}`;
}

const notFound = (r: ActionRunResult): boolean =>
  /\bHTTP 404\b/.test(r.stderr) || /"status"\s*:\s*"404"/.test(r.stdout);

function objectOf(r: ActionRunResult): Record<string, unknown> | null {
  try {
    const v = JSON.parse(r.stdout) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** A command as a person would type it. */
const shell = (args: readonly string[]): string =>
  args.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(" ");

/** The token's scopes from `gh auth status`, for the active account; null
 * when gh lists none (a fine-grained token has no scopes to list). */
export function tokenScopes(text: string): string[] | null {
  const accounts: Array<{ active: boolean; scopes: string[] | null }> = [];
  for (const line of text.split("\n")) {
    if (/Logged in to /.test(line)) accounts.push({ active: false, scopes: null });
    const cur = accounts[accounts.length - 1];
    if (cur === undefined) continue;
    if (/Active account:\s*true/.test(line)) cur.active = true;
    const m = /Token scopes:\s*(.*)$/.exec(line);
    if (m) {
      const list = m[1]!
        .split(",")
        .map((s) => s.trim().replace(/^'|'$/g, ""))
        .filter((s) => s !== "" && s !== "none");
      cur.scopes = list.length > 0 ? list : null;
    }
  }
  const pick = accounts.find((a) => a.active) ?? accounts[0];
  return pick?.scopes ?? null;
}

/** The secret names `gh secret list` printed (one per line, the name first). */
export function secretNames(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.trim().split(/\s+/)[0] ?? "")
    .filter((n) => n !== "")
    .map((n) => n.toUpperCase());
}

// ---- the verb ---------------------------------------------------------------------

interface Parsed {
  verb: "install" | "workflow";
  on: Recipe[] | null;
  secret: string | null;
  repo: string | null;
  local: boolean;
  force: boolean;
  yes: boolean;
}

function parse(args: readonly string[]): Parsed | string {
  const [verb, ...rest] = args;
  if (verb !== "install" && verb !== "workflow")
    return verb === undefined ? "a verb is needed" : `unknown verb ${JSON.stringify(verb)}`;
  const p: Parsed = {
    verb,
    on: null,
    secret: null,
    repo: null,
    local: false,
    force: false,
    yes: false,
  };
  const valued = verb === "install" ? ["--on", "--secret", "--repo"] : ["--on", "--secret"];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    const eq = a.indexOf("=");
    const flag = a.startsWith("--") && eq > 0 ? a.slice(0, eq) : a;
    if (valued.includes(flag)) {
      const value = flag === a ? rest[++i] : a.slice(eq + 1);
      if (value === undefined || value === "") return `${flag} needs a value`;
      if (flag === "--on") {
        if (p.on !== null) return "--on is given twice";
        const on = parseRecipes(value);
        if (typeof on === "string") return on;
        p.on = on;
      } else if (flag === "--secret") {
        if (p.secret !== null) return "--secret is given twice";
        const why = secretNameProblem(value);
        if (why !== null) return why;
        p.secret = value;
      } else {
        if (p.repo !== null) return "--repo is given twice";
        p.repo = value;
      }
    } else if (verb === "install" && a === "--local") p.local = true;
    else if (verb === "install" && a === "--force") p.force = true;
    else if (verb === "install" && (a === "--yes" || a === "-y")) p.yes = true;
    else return `${verb} does not take ${JSON.stringify(a)}`;
  }
  return p;
}

/** What `install --json` prints. */
export interface InstallReport {
  ok: boolean;
  repo: string | null;
  on: Recipe[];
  secret: { name: string; state: "kept" | "set" | "printed" } | null;
  /** The label's step: null when the `label` trigger is not chosen. */
  label: "created" | "exists" | "printed" | null;
  workflow: { path: string; written: "pr" | "local" | null; pr_url: string | null };
  /** What the person does next, one step each. */
  next: string[];
  /** What failed, one line each. */
  errors: string[];
}

const BRANCH = "qcr/action-install";
const COMMIT_MESSAGE = "QuickReview: add the review workflow";
const PR_TITLE = "Add the QuickReview workflow";
const LABEL_DESCRIPTION = "Ask QuickReview for a review";
const LABEL_COLOR = "1d76db";

/** `qcr action …`: the exit code (0 done, 1 a step failed, 2 usage). */
export function cmdAction(
  args: readonly string[],
  json: boolean,
  deps: ActionDeps,
): Promise<number> {
  if (
    args.length === 0 ||
    (args.length === 1 && args[0] === "help") ||
    args.includes("--help") ||
    args.includes("-h")
  ) {
    deps.out(ACTION_HELP);
    return Promise.resolve(0);
  }
  const p = parse(args);
  if (typeof p === "string") {
    if (json) deps.out(JSON.stringify({ error: `qcr action: ${p}` }));
    else deps.err(`qcr action: ${p}\n${ACTION_USAGE}`);
    return Promise.resolve(2);
  }
  return p.verb === "workflow" ? workflow(p, json, deps) : install(p, json, deps);
}

/** A usage refusal found after parsing (exit 2). */
function refuse(verb: string, why: string, json: boolean, deps: ActionDeps): number {
  if (json) deps.out(JSON.stringify({ error: `qcr action ${verb}: ${why}` }));
  else deps.err(`qcr action ${verb}: ${why}`);
  return 2;
}

/** The route's env key, when it is one a secret can be named. */
async function routeSecret(deps: ActionDeps): Promise<string | null> {
  try {
    const k = await deps.routeKey();
    return k !== null && secretNameProblem(k) === null ? k : null;
  } catch {
    return null;
  }
}

async function workflow(p: Parsed, json: boolean, deps: ActionDeps): Promise<number> {
  const on = p.on ?? [...DEFAULT_RECIPES];
  const secret = p.secret ?? (await routeSecret(deps));
  if (secret === null)
    return refuse(
      "workflow",
      "pass --secret NAME, the repository secret that holds your model's API key (no key in this environment names one)",
      json,
      deps,
    );
  const text = renderWorkflow({ on, secretEnv: secret });
  if (json) {
    deps.out(JSON.stringify({ ok: true, on, secret, path: WORKFLOW_PATH, workflow: text }));
    return 0;
  }
  deps.out(text.replace(/\n$/, ""));
  if (p.secret === null)
    deps.err(
      `qcr action workflow: the secret is ${secret}, the key your model route uses here; --secret NAME names another`,
    );
  return 0;
}

async function install(p: Parsed, json: boolean, deps: ActionDeps): Promise<number> {
  const report: InstallReport = {
    ok: true,
    repo: null,
    on: p.on ?? [],
    secret: null,
    label: null,
    workflow: { path: WORKFLOW_PATH, written: null, pr_url: null },
    next: [],
    errors: [],
  };
  const say = (line: string): void => {
    if (!json) deps.out(line);
  };
  const fail = (line: string): void => {
    report.errors.push(line);
    if (!json) deps.err(`qcr action install: ${line}`);
  };
  const finish = (): number => {
    report.ok = report.errors.length === 0;
    if (json) deps.out(JSON.stringify(report));
    else if (report.next.length > 0) {
      say("");
      say("Next:");
      for (const n of report.next) say(`  - ${n}`);
    }
    return report.ok ? 0 : 1;
  };
  /** true: yes; false: no; null: nobody to ask (no terminal, no --yes). */
  const confirm = async (question: string): Promise<boolean | null> => {
    if (p.yes) return true;
    if (!deps.isTTY) return null;
    const a = await deps.prompt(`${question} [y/N] `);
    return a !== null && /^y(es)?$/i.test(a.trim());
  };
  const notAsked = (yes: boolean | null, what: string): void => {
    if (yes === null) say(`Not ${what}: there is no terminal to ask, and --yes was not given.`);
    else say(`Not ${what}.`);
  };

  // 1. The repository.
  let repo: string | null;
  if (p.repo !== null) {
    repo = parseRepoInput(p.repo);
    if (repo === null)
      return refuse(
        "install",
        `${JSON.stringify(p.repo)} is not a GitHub repository: pass --repo OWNER/NAME`,
        json,
        deps,
      );
    say(`Repository: ${repo}.`);
  } else {
    const origin = deps.run("git", ["remote", "get-url", "origin"], { cwd: deps.cwd });
    repo = ran(origin) ? parseRepoInput(origin.stdout.trim()) : null;
    if (repo === null)
      return refuse(
        "install",
        "this directory has no origin remote on github.com: pass --repo OWNER/NAME",
        json,
        deps,
      );
    say(`Repository: ${repo}, this checkout's origin.`);
  }
  report.repo = repo;

  // 2. gh: installed, logged in, and its token's scopes. Nothing is written
  // without it, except the workflow under --local.
  let ghProblem: string | null = null;
  let ghFix = "";
  const version = runGh(deps, repo, ["--version"]);
  if (!ran(version)) {
    ghProblem = "gh, the GitHub CLI, is not installed here, or it did not run";
    ghFix = "install gh, the GitHub CLI, then run: gh auth login";
  } else {
    const status = runGh(deps, repo, ["auth", "status", "--hostname", "github.com"]);
    if (!ran(status)) {
      ghProblem = "gh is not logged in to github.com";
      ghFix = "gh auth login";
    } else {
      const scopes = tokenScopes(`${status.stdout}\n${status.stderr}`);
      // a workflow file is pushed only with `workflow`; --local pushes nothing
      const needed = p.local ? ["repo"] : ["repo", "workflow"];
      const missing = scopes === null ? [] : needed.filter((sc) => !scopes.includes(sc));
      if (scopes === null)
        say(
          `gh lists no scopes for its token (a fine-grained token?): it needs write access to ${repo}'s secrets, contents, pull requests and workflows.`,
        );
      if (missing.length > 0) {
        ghProblem = `gh's token lacks the ${missing.join(" and ")} scope${missing.length > 1 ? "s" : ""}`;
        ghFix = `gh auth refresh -h github.com -s ${missing.join(",")}`;
      } else say("gh: logged in to github.com.");
    }
  }
  const ghUsable = ghProblem === null;
  if (ghProblem !== null && !p.local) {
    fail(ghProblem);
    report.next.push(ghFix, "then run qcr action install again");
    say("Nothing was written.");
    return finish();
  }
  if (ghProblem !== null) {
    report.next.push(ghFix);
    say(`${ghProblem}: the secret and the label are printed as commands to run.`);
  }

  // 3. The triggers.
  let asked = p.on;
  if (asked === null && deps.isTTY) asked = await askRecipes(deps);
  const on: Recipe[] = asked ?? [...DEFAULT_RECIPES];
  if (asked === null)
    say(
      `Triggers: ${on.join(", ")}, the default (--on ${RECIPES.join(",")} chooses any of the four).`,
    );
  else say(`Triggers: ${on.join(", ")}.`);
  report.on = on;

  // 4. The secret's name.
  let named = p.secret;
  if (named === null) {
    named = await routeSecret(deps);
    if (named !== null)
      say(`Secret: ${named}, the key your model route uses here (--secret NAME names another).`);
  } else say(`Secret: ${named}.`);
  if (named === null && deps.isTTY) named = await askSecretName(deps);
  if (named === null)
    return refuse(
      "install",
      "pass --secret NAME, the repository secret that holds your model's API key (no key in this environment names one)",
      json,
      deps,
    );
  const secret: string = named;

  // 5. The secret's value.
  const setArgs = ["secret", "set", secret, "--repo", repo, "--app", "actions"];
  const printSecret = (): void => {
    report.secret = { name: secret, state: "printed" };
    report.next.push(`store your model's API key as the repository secret: gh ${shell(setArgs)}`);
  };
  if (!ghUsable) printSecret();
  else {
    const list = runGh(deps, repo, ["secret", "list", "--repo", repo, "--app", "actions"]);
    const local = deps.env[secret];
    if (!ran(list)) {
      fail(`could not list ${repo}'s Actions secrets: ${said(list)}`);
      printSecret();
    } else if (secretNames(list.stdout).includes(secret)) {
      report.secret = { name: secret, state: "kept" };
      say(`The repository already has the secret ${secret}: kept.`);
    } else if (local !== undefined && local !== "") {
      const yes = await confirm(`Store your local ${secret} as the repository secret ${secret}?`);
      if (yes === true) {
        say(`Storing your local ${secret} as the repository secret ${secret} on ${repo}.`);
        const set = runGh(deps, repo, setArgs, { input: local });
        if (ran(set)) report.secret = { name: secret, state: "set" };
        else {
          fail(`gh could not store the secret ${secret}: ${said(set)}`);
          printSecret();
        }
      } else {
        notAsked(yes, `storing ${secret}`);
        printSecret();
      }
    } else if (deps.isTTY) {
      const yes = await confirm(
        `Store the repository secret ${secret} on ${repo} now? gh asks for its value.`,
      );
      if (yes === true) {
        const set = runGh(deps, repo, setArgs, { terminal: true });
        if (ran(set)) report.secret = { name: secret, state: "set" };
        else {
          fail(`gh did not store the secret ${secret}: ${said(set)}`);
          printSecret();
        }
      } else {
        notAsked(yes, `storing ${secret}`);
        printSecret();
      }
    } else {
      say(`${secret} is not set here, and there is no terminal for gh to ask for it.`);
      printSecret();
    }
  }

  // 6. The label.
  if (on.includes("label")) {
    const labelArgs = [
      "label",
      "create",
      REVIEW_LABEL,
      "--repo",
      repo,
      "--description",
      LABEL_DESCRIPTION,
      "--color",
      LABEL_COLOR,
    ];
    const printLabel = (): void => {
      report.label = "printed";
      report.next.push(`create the label: gh ${shell(labelArgs)}`);
    };
    if (!ghUsable) printLabel();
    else {
      const yes = await confirm(`Create the label ${REVIEW_LABEL} on ${repo}?`);
      if (yes === true) {
        const made = runGh(deps, repo, labelArgs);
        if (ran(made)) {
          report.label = "created";
          say(`Label ${REVIEW_LABEL}: created.`);
        } else if (/already exists/i.test(`${made.stderr}\n${made.stdout}`)) {
          report.label = "exists";
          say(`Label ${REVIEW_LABEL}: already there.`);
        } else {
          fail(`gh could not create the label ${REVIEW_LABEL}: ${said(made)}`);
          printLabel();
        }
      } else {
        notAsked(yes, `creating the label ${REVIEW_LABEL}`);
        printLabel();
      }
    }
  }

  // 7. The workflow.
  const text = renderWorkflow({ on, secretEnv: secret });
  const byHand = `qcr action workflow --on ${on.join(",")} --secret ${secret} > ${WORKFLOW_PATH}`;
  if (p.local) await writeLocal(p, deps, text, byHand, { report, say, fail, confirm, notAsked });
  else
    await openPr(p, deps, repo, on, secret, text, byHand, { report, say, fail, confirm, notAsked });

  // 8. What comes next.
  if (report.workflow.written !== null) {
    report.next.push(...on.map((r) => `then: ${RECIPE_SAYS[r]}`));
    if (on.includes("comment") || on.includes("manual"))
      report.next.push(
        "a comment or a manual run starts a review only once the workflow is on the default branch",
      );
  }
  return finish();
}

/** What the workflow steps share with the rest of `install`. */
interface Steps {
  report: InstallReport;
  say: (line: string) => void;
  fail: (line: string) => void;
  confirm: (question: string) => Promise<boolean | null>;
  notAsked: (yes: boolean | null, what: string) => void;
}

/** Is anything, a dangling link included, at `p`? */
function present(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** --local: the workflow written into this checkout. */
async function writeLocal(
  p: Parsed,
  deps: ActionDeps,
  text: string,
  byHand: string,
  s: Steps,
): Promise<void> {
  const top = deps.run("git", ["rev-parse", "--show-toplevel"], { cwd: deps.cwd });
  if (!ran(top)) {
    s.fail("--local writes into a git checkout, and this directory is not in one");
    return;
  }
  const root = top.stdout.trim();
  const target = join(root, WORKFLOW_PATH);
  const there = present(target);
  if (there && !p.force) {
    s.fail(`${target} is already there: pass --force to replace it`);
    return;
  }
  const yes = await s.confirm(`${there ? "Replace" : "Write"} ${target}?`);
  if (yes !== true) {
    s.notAsked(yes, `writing ${WORKFLOW_PATH}`);
    s.report.next.push(`write it yourself: ${byHand}`);
    return;
  }
  try {
    writeInCheckout(root, WORKFLOW_PATH, text);
  } catch (err) {
    s.fail(`could not write ${target}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  s.report.workflow.written = "local";
  s.say(`Wrote ${target}.`);
  s.report.next.push(
    `git add ${WORKFLOW_PATH}`,
    `git commit -m ${shell([COMMIT_MESSAGE])}`,
    "git push, then open a pull request with it (gh pr create)",
    "merge the pull request",
  );
}

/** The body of the pull request that adds the workflow. */
function prBody(on: readonly Recipe[], secret: string): string {
  return [
    `This adds \`${WORKFLOW_PATH}\`, which runs QuickReview: an AI code review of a pull request, posted as one comment-only review.`,
    "",
    "Once it is merged:",
    ...on.map((r) => `- ${RECIPE_SAYS[r]}`),
    "",
    `The review reads your model's API key from the repository secret \`${secret}\`. Every run is a full review on that key, and a re-run pays again. By default only people with write access to the repository can start one.`,
    "",
    `Docs: ${ACTION_DOCS_URL}`,
  ].join("\n");
}

/** The default: a branch, the file put on it, and a pull request, on GitHub. */
async function openPr(
  p: Parsed,
  deps: ActionDeps,
  repo: string,
  on: readonly Recipe[],
  secret: string,
  text: string,
  byHand: string,
  s: Steps,
): Promise<void> {
  const r = `repos/${repo}`;
  const cannot = (why: string): void => {
    s.fail(why);
    s.report.next.push(`or write the workflow yourself: ${byHand}`);
  };
  const info = runGh(deps, repo, ["api", r]);
  const base = ran(info) ? objectOf(info)?.["default_branch"] : undefined;
  if (typeof base !== "string" || base === "") {
    cannot(`could not read ${repo}'s default branch: ${said(info)}`);
    return;
  }
  const encoded = (ref: string): string => ref.split("/").map(encodeURIComponent).join("/");
  const existing = runGh(deps, repo, [
    "api",
    `${r}/contents/${WORKFLOW_PATH}?ref=${encodeURIComponent(base)}`,
  ]);
  let sha: string | null = null;
  if (ran(existing)) {
    const found = objectOf(existing)?.["sha"];
    if (typeof found !== "string") {
      cannot(`could not read ${WORKFLOW_PATH} on ${repo}'s ${base}`);
      return;
    }
    if (!p.force) {
      s.fail(`${repo} already has ${WORKFLOW_PATH} on ${base}: pass --force to replace it`);
      return;
    }
    sha = found;
  } else if (!notFound(existing)) {
    cannot(`could not read ${WORKFLOW_PATH} on ${repo}: ${said(existing)}`);
    return;
  }
  const head = runGh(deps, repo, ["api", `${r}/git/ref/heads/${encoded(base)}`]);
  const object = ran(head) ? objectOf(head)?.["object"] : undefined;
  const headSha =
    typeof object === "object" && object !== null
      ? (object as Record<string, unknown>)["sha"]
      : undefined;
  if (typeof headSha !== "string") {
    cannot(`could not read the head of ${repo}'s ${base}: ${said(head)}`);
    return;
  }
  let branch: string | null = null;
  for (let n = 1; n <= 20 && branch === null; n++) {
    const name = n === 1 ? BRANCH : `${BRANCH}-${n}`;
    const got = runGh(deps, repo, ["api", `${r}/git/ref/heads/${encoded(name)}`]);
    if (ran(got)) continue;
    if (!notFound(got)) {
      cannot(`could not check the branch ${name} on ${repo}: ${said(got)}`);
      return;
    }
    branch = name;
  }
  if (branch === null) {
    cannot(`the branches ${BRANCH} to ${BRANCH}-20 are all taken on ${repo}`);
    return;
  }
  const yes = await s.confirm(
    `Open a pull request on ${repo} that ${sha === null ? "adds" : "replaces"} ${WORKFLOW_PATH} (branch ${branch}, from ${base})?`,
  );
  if (yes !== true) {
    s.notAsked(yes, "opening the pull request");
    s.report.next.push(
      `open it later: qcr action install --on ${on.join(",")} --secret ${secret} --repo ${repo}`,
      `or write the workflow yourself: ${byHand}`,
    );
    return;
  }
  s.say(`Creating the branch ${branch} on ${repo}, from ${base}.`);
  const made = runGh(deps, repo, [
    "api",
    "-X",
    "POST",
    `${r}/git/refs`,
    "-f",
    `ref=refs/heads/${branch}`,
    "-f",
    `sha=${headSha}`,
  ]);
  if (!ran(made)) {
    cannot(`gh could not create the branch ${branch}: ${said(made)}`);
    return;
  }
  s.say(`Committing ${WORKFLOW_PATH} to ${branch}.`);
  const put = runGh(deps, repo, [
    "api",
    "-X",
    "PUT",
    `${r}/contents/${WORKFLOW_PATH}`,
    "-f",
    `message=${COMMIT_MESSAGE}`,
    "-f",
    `content=${Buffer.from(text, "utf8").toString("base64")}`,
    "-f",
    `branch=${branch}`,
    ...(sha === null ? [] : ["-f", `sha=${sha}`]),
  ]);
  if (!ran(put)) {
    cannot(
      `gh could not commit ${WORKFLOW_PATH} to ${branch} (the branch is there; delete it or run again): ${said(put)}`,
    );
    return;
  }
  s.say(`Opening the pull request.`);
  const pr = runGh(deps, repo, [
    "pr",
    "create",
    "--repo",
    repo,
    "--base",
    base,
    "--head",
    branch,
    "--title",
    PR_TITLE,
    "--body",
    prBody(on, secret),
  ]);
  if (!ran(pr)) {
    s.fail(`gh could not open the pull request: ${said(pr)}`);
    s.report.next.push(
      `open it yourself: gh ${shell(["pr", "create", "--repo", repo, "--base", base, "--head", branch, "--title", PR_TITLE])}`,
    );
    return;
  }
  const url =
    pr.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^https:\/\//.test(l))
      .pop() ?? null;
  s.report.workflow.written = "pr";
  s.report.workflow.pr_url = url;
  s.say(`Opened ${url ?? "the pull request"}: it adds ${WORKFLOW_PATH} on ${branch}.`);
  s.report.next.push(`merge the pull request${url === null ? "" : `: ${url}`}`);
}

/** The triggers, asked: numbers or names; Enter keeps the defaults. Null
 * when nobody answered. */
async function askRecipes(deps: ActionDeps): Promise<Recipe[] | null> {
  const rows = RECIPES.map(
    (r, i) =>
      `  ${i + 1}. ${r.padEnd(8)} ${RECIPE_SAYS[r]}${DEFAULT_RECIPES.includes(r) ? " [x]" : ""}`,
  );
  const question = [
    "Which triggers? Numbers or names, comma-separated; Enter keeps the ones marked [x].",
    ...rows,
    "> ",
  ].join("\n");
  for (let tries = 0; tries < 3; tries++) {
    const a = await deps.prompt(question);
    if (a === null) return null;
    const t = a.trim();
    if (t === "") return [...DEFAULT_RECIPES];
    const names = t
      .split(/[\s,]+/)
      .filter((x) => x !== "")
      .map((x) => (/^\d+$/.test(x) ? (RECIPES[Number(x) - 1] ?? x) : x));
    const on = parseRecipes(names.join(","));
    if (typeof on !== "string") return on;
    deps.err(on);
  }
  return null;
}

/** The secret's name, asked. Null when nobody answered. */
async function askSecretName(deps: ActionDeps): Promise<string | null> {
  for (let tries = 0; tries < 3; tries++) {
    const a = await deps.prompt(
      "The repository secret for your model's API key, named as the environment variable your provider documents (NAME_API_KEY): ",
    );
    if (a === null) return null;
    const name = a.trim();
    const why = secretNameProblem(name);
    if (why === null) return name;
    deps.err(why);
  }
  return null;
}
