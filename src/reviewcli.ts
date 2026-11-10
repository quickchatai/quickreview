// `qcr review` — a daemonless review from a terminal. This module is the
// terminal's side of it: argv, the homes, the config, the prompts on stdin and
// the printing. The review itself is core, `review()` / `preview()` in
// packages/pi-plugin/src/reviewapi.ts: it previews the price first, runs automatically under the
// repo's configured limit (otherwise asks), runs the shared one-shot core
// (packages/pi-plugin/src/oneshot.ts) on the host, stops hard at the price it showed, and returns
// the findings grouped by severity.
//
// Re-review: the state kept per target (packages/pi-plugin/src/reviewstate.ts) makes a second run
// on an unchanged head free, and a run after a push a delta review over the
// production follow-up plan (packages/pi-plugin/src/reviewdelta.ts) with the open findings handed
// over to verify and never repeated; a rewrite or a doubtful delta is a full
// review.
//
// A unified diff is a target too (`--diff -` reads stdin, `--diff FILE` a
// file): no repository is needed, one around the working directory is only
// read for context, nothing is written to git, and with no PR behind it there
// is nothing to post to.
//
// The detached run (src/reviewdetach.ts) re-runs this verb in a child; a PR
// keys its state with its own target key.
//
// The model. A review runs on what pi has a credential for
// (packages/pi-plugin/src/modelroute.ts), and this module is where that is
// found out for a terminal, once the review has a plan (`routeRun`):
//
//   1. the remembered choice and pi's saved provider are read from pi's
//      agent dir, beside the login;
//   2. the login is borrowed for this run's window: a login that cannot last
//      the run is left out, so it is never picked or asked about;
//   3. one host is built with those and the pin (`--model`, else the
//      config's `[models] model`), and asked for its route;
//   4. when two providers tie and a person is at the terminal, they are
//      asked once, the answer is remembered, and the route is resolved again;
//   5. the route goes to the review, for the preview, the key and the one
//      line that names the model; the run's sessions are that same host's.
//
// A preview starts nothing, so its host exists for the route alone and is
// gone before the preview is printed. `--model` is the whole review's model
// for one run: every tier and lens the config pins to a model of its own
// runs on it too, and the preview says how many it replaced.
//
// Exit codes follow `qcr scan`: 0 done; 1 refused, declined, failed or
// stopped short (partial); 2 usage.
import { mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  isPinned,
  splitModelSpec,
  stripPins,
  type CoreConfig,
} from "@quickchatai/pi-quickreview/src/reviewconfig.js";
import { borrowedCredentials } from "@quickchatai/pi-quickreview/src/engine/auth.js";
import { readModelChoice, writeModelChoice } from "@quickchatai/pi-quickreview/src/modelchoice.js";
import {
  credentialWords,
  skippedNotice,
  type ModelChoice,
  type ModelRoute,
  type RouteInput,
  type RouteResult,
  type SkippedLogin,
} from "@quickchatai/pi-quickreview/src/modelroute.js";
import type { PiHost, PiHostOptions } from "@quickchatai/pi-quickreview/src/engine/pisdk.js";
import type { ReviewRuntimeOptions } from "@quickchatai/pi-quickreview/src/engine/reviewruntime.js";
import type { Ecosystem } from "@quickchatai/pi-quickreview/src/ecosystem.js";
import type { ReviewMemoryPort } from "@quickchatai/pi-quickreview/src/memoryport.js";
import type { ProfilePlace } from "@quickchatai/pi-quickreview/src/profilelookup.js";
import type { PrCredentialDeps, PrFetchRequest } from "@quickchatai/pi-quickreview/src/prtarget.js";
import {
  FALLBACK_DESTINATIONS,
  loadDefaultDestinationsIn,
  planDestinations,
  saveDefaultDestinationsIn,
  type Destination,
  type DestinationMenuItem,
  type DestinationPick,
} from "@quickchatai/pi-quickreview/src/reviewdest.js";
import type { OneShotResult } from "@quickchatai/pi-quickreview/src/oneshot.js";
import type { RoundSpec } from "@quickchatai/pi-quickreview/src/engine/round.js";
import { BUDGET_EXIT_CODE } from "@quickchatai/pi-quickreview/src/engine/budget.js";
import { prepareHostRun } from "./hostroute.js";
import type { Runtime } from "@quickchatai/pi-quickreview/src/engine/port.js";
import type { EngineRouteRuntime } from "@quickchatai/pi-quickreview/src/engine/lens/wave.js";
import { lazyReviewRuntime } from "@quickchatai/pi-quickreview/src/engine/reviewruntime.js";
import { markSdkRoute } from "@quickchatai/pi-quickreview/src/engine/livesessions.js";
import {
  REVIEW_SCHEMA_VERSION,
  withSchemaVersion,
} from "@quickchatai/pi-quickreview/src/contract.js";
import {
  preview,
  review,
  type ReviewData,
  type ReviewHostRequest,
  type ReviewHostRun,
  type ReviewIo,
  type ReviewOptions,
  type ReviewResult,
  type ReviewRoute,
  type ReviewRouted,
  type ReviewTarget,
} from "@quickchatai/pi-quickreview/src/reviewapi.js";
import { reviewHome } from "./reviewhome.js";
import { parseReviewArgs, REVIEW_USAGE, type ReviewCommand } from "./reviewargs.js";

export { parseReviewArgs, REVIEW_USAGE, type ReviewCommand } from "./reviewargs.js";

export function reviewHelp(): string {
  return [
    REVIEW_USAGE,
    "",
    "Review code in the terminal, with no daemon. The estimated price is previewed",
    "first; a review under the repo's limit starts at once, above it qcr asks, and",
    "the run stops hard at the cap shown (twice the estimate). In the GitHub Action",
    "(QCR_ROUTE=action, or GITHUB_ACTIONS=true) nothing is asked and nothing is",
    "capped unless --limit is given; then the run stops hard at that limit.",
    "",
    "Targets",
    "  (none), branch    the current branch against its base (default)",
    "  <PR number|URL>   a pull request, fetched into a scratch tree and reviewed read-only;",
    "                    a PR on another repo than this directory's needs --repo OWNER/NAME",
    "  --uncommitted     the uncommitted working tree (staged, unstaged and new files) against HEAD;\n                    never posted anywhere",
    "  --diff FILE       a unified diff read from FILE, or from stdin with `--diff -`; the repository around\n                    the working directory is optional (read as context, never written to) and the\n                    diff has no PR, so it is never posted anywhere",
    "",
    "Options",
    "  --repo OWNER/NAME the repository of a PR number (default: this directory's origin)",
    "  --base REF        the base to review against (default: origin's default branch, main, master)",
    "  --preview         show the plan, the price and the key; start nothing",
    "  --key K           start over the limit without asking, quoting the key a preview showed",
    "  --limit USD       the limit for this run, over the repo's own (in the Action: the hard stop)",
    "  --model MODEL     the model the whole review runs on, for this run: provider/id, an id pi\n                    knows, or either with a :level (as pi's own --model reads it). It replaces\n                    every tier and lens model the config pins; `qcr model use` keeps a choice",
    "  --full            review the whole branch again, ignoring what an earlier review left",
    "  --security        ask for a security review on top of the plan: every lens of the security family\n                    is planned (never one the profile switched off), as /qcr-review --security asks",
    "  --json            one JSON object instead of text (the agent destination)",
    "  --to DEST         where the result goes, for this run: terminal, file, json, pr (comma-separated;\n                    pr posts a comment-only review to the PR and needs a PR target)",
    "  --out FILE        write the markdown report to FILE (implies file)",
    "  --debug-pi        run the round inside pi's own interactive UI, to watch it live: the lenses run as",
    "                    this pi's in-process sessions, and the round starts from the /qcr-round command.\n                    Needs a terminal, posts nothing, and finished sessions stay openable (qcr open)",
    "",
    "Destinations: with none given, the repo's saved default is used; with none saved, an",
    'interactive run asks every time, and an answer marked "always" is kept as this repo\'s default',
    "(in the install's state home), which skips the question from then on. A run with no terminal",
    "(piped, --json, CI) prints the terminal text plus JSON and never waits.",
    "",
    "Posting (--to pr, or saved as the default) sends one review whose event is always",
    "COMMENT, never an approval or a change request. Every comment says it came from qcr",
    "and carries the hidden finding markers, and findings already on the PR are skipped.",
    "It posts as the credential the PR was read with, or the source named by `post_as`",
    "(app, handoff, gh, env:GITHUB_TOKEN, env:GH_TOKEN) in `.git/qcr-review.json`. The post goes",
    "through the mutation gate: with `dry_run = true` in the install's config the review is",
    "recorded under state/dryrun/ and nothing is sent.",
    "",
    "The review runs on a model pi has a credential for: a login made with `qcr login`, or a",
    "provider's API key in the environment. The preview names the model and why; with several",
    "providers `qcr model` shows which one runs and `qcr model use <provider>` changes it.",
    "",
    "A PR is read with the first GitHub credential found: the App if configured, then a",
    "token handed to the container as a file, then GITHUB_TOKEN/GH_TOKEN, then `gh auth token`",
    "(run `gh auth login` to set that up).",
    "",
    "A second run on an unchanged head spends nothing. After a push it reviews only",
    "the change since the last reviewed head and does not repeat findings that are",
    "still open; a history rewrite or a delta it cannot trust is reviewed in full.",
    "",
    "Detached runs (for plugins): `qcr review start <target…> --json` returns at once with a",
    "run id; `qcr review status [RUN_ID] [--wait [--timeout S]] --json` reports progress and,",
    "when done, the findings JSON; `qcr review stop [RUN_ID]` cancels. Two reviews of the same",
    "target at once are refused. Exit codes: 0 done, 1 refused, 2 usage, 3 wait timeout.",
    "",
    "The repo's limit and price rates live in `.git/qcr-review.json` (auto_limit_usd,",
    "usd_base, usd_per_lens, usd_per_kline). Exit codes: 0 done; 1 refused, declined or stopped",
    "short (partial coverage); 2 usage.",
  ].join("\n");
}

export type { ReviewRoute };

/** The route a process runs on: the Action sets QCR_ROUTE=action (or runs under
 * GITHUB_ACTIONS), anything else is a person at a terminal. */
export function routeFromEnv(env: NodeJS.ProcessEnv): ReviewRoute {
  return env["QCR_ROUTE"] === "action" || env["GITHUB_ACTIONS"] === "true" ? "action" : "laptop";
}

export interface ReviewCliDeps {
  /** The repository (or a directory in it) to review. */
  cwd: string;
  /** Who is asking. "laptop" (default) previews the estimate, asks above the
   * limit and stops hard at twice the estimate. "action" never asks and has no
   * cap of its own: only a `--limit` stops the run. */
  route?: ReviewRoute;
  out: (line: string) => void;
  /** Ask a yes/no question of the person at the terminal. Null: nobody to ask. */
  confirm: ((question: string) => Promise<boolean>) | null;
  /** Ask the person where this run's result goes (the destination menu,
   * packages/pi-plugin/src/reviewdest.ts `destinationMenu`); null: they
   * declined. Absent: the session is not interactive, so the destination
   * question is never asked. */
  pick?: (question: string, menu: DestinationMenuItem[]) => Promise<DestinationPick | null>;
  /** The production tree (prompts/, extensions/, agents/). */
  root: string;
  /** Where profiles are looked up before the checkout's generic examples: the
   * install's homes (src/homes.ts `homeProfilePlaces`). Absent: the
   * examples alone. */
  profileHomes?: readonly ProfilePlace[];
  /** The operator's pi agent dir (its login): only read. The run's pi gets a
   * private agent dir of its own (src/hostroute.ts). */
  agentDir: string;
  cfg: CoreConfig;
  ecosystem: Ecosystem;
  /** Hosts the review session (`[engine] runtime`, the SDK): a runtime, or
   * what builds one for the run, handed the model side the route resolved
   * (the borrowed login, the route, the host it was resolved on). */
  runtime: Runtime | ((host: ReviewRunHost) => Runtime);
  /** What the run's model is resolved from (`routeRun`). Absent: the review
   * says nothing of its model, and its sessions run on what the config pins
   * and the runtime resolves. */
  models?: ReviewModelDeps;
  /** Runs the round inside interactive pi (`--debug-pi`, src/engine/debugpi.ts).
   * Absent: there is no terminal for it, and the flag is refused. */
  debugPi?: (spec: RoundSpec) => Promise<OneShotResult>;
  /** Where each run keeps its throwaway tree and its files. */
  runsDir: string;
  /** Where a dry-run install records the review it would have posted: under
   * the state home, never inside the installed package. */
  dryrunDir: string;
  /** The review home: each repo's delta history and saved destination.
   * Absent: the install's (src/reviewhome.ts), read when the run starts. */
  storeDir?: string | null;
  timeoutMs: number;
  /** The install's memory, injected by the host (the app's OpenViking memory,
   * src/reviewmemory.ts). Absent or null: the review runs without memory and
   * says so once. */
  memory?: ReviewMemoryPort | null;
  log?: (line: string) => void;
  /** The diff on standard input, for `--diff -`. Absent: stdin is not available. */
  readStdin?: () => Promise<string>;
  /** Test seams for a PR target: the credential sources and where GitHub is. */
  pr?: PrCredentialDeps & Pick<PrFetchRequest, "fetchFn" | "gitBase" | "apiBase">;
  /** Where a warning is said before the run (stderr). */
  warn?: (line: string) => void;
}

/** What the run's runtime is handed of the model side: the login the route
 * borrowed, the route's inputs, and the host the route was resolved on. */
export type ReviewRunHost = Pick<ReviewRuntimeOptions, "credentials" | "route" | "prebuilt">;

/** What `qcr review` resolves its model from, beside pi's agent dir. */
export interface ReviewModelDeps {
  /** This process's environment: where pi looks for a provider's key. */
  env: Readonly<Record<string, string | undefined>>;
  /** Where a host's private agent dir is made, and removed again: the state
   * home's tmp. */
  tmpDir: string;
  /** The install's config file, for a refusal that names a pin in it; null
   * when the shipped defaults stand in. */
  configPath: string | null;
  /** Ask the person which provider runs the review: the question and one row
   * per provider, the first being the one the order takes. Resolves the row's
   * index, or null when they gave no answer. Null: nobody to ask. */
  choose: ((question: string, rows: readonly string[]) => Promise<number | null>) | null;
  /** The run host's options beside the login and the route: whether it owns
   * this process, and the home its tool fence keeps out. */
  host?: Pick<ReviewRuntimeOptions, "ownsProcess" | "homeDir" | "fenceDirs">;
  /** Runs once on each host's new model runtime: a test registers its
   * provider here. */
  configureModels?: PiHostOptions["configureModels"];
  now?: () => number;
}

/** One run's model side: what `review()` asks for the route, what the
 * runtime and the run's isolation are handed after it, and what to release. */
interface RouteRun {
  route: () => Promise<ReviewRouted>;
  host: () => ReviewRunHost;
  prepareHost: (req: ReviewHostRequest) => ReviewHostRun;
  close: () => void;
}

/** The route's result with pi's display names where the borrow could only
 * give ids: it reads a login file and knows no provider's name. */
function withNames(
  result: RouteResult,
  skipped: readonly SkippedLogin[],
  nameOf: (provider: string) => string,
): RouteResult {
  const rename = (l: SkippedLogin): SkippedLogin => ({ ...l, name: nameOf(l.provider) });
  if (!result.ok)
    return result.refusal.code === "login-too-short"
      ? { ok: false, refusal: { ...result.refusal, logins: result.refusal.logins.map(rename) } }
      : result;
  const said = new Map(skipped.map((l) => [skippedNotice(l), skippedNotice(rename(l))]));
  return {
    ok: true,
    route: { ...result.route, notices: result.route.notices.map((n) => said.get(n) ?? n) },
  };
}

/** The rows of the provider question: the model each provider would run,
 * whose credential it is, and what is not known about its price. */
export function providerRows(route: ModelRoute): string[] {
  const options = [route, ...route.alternatives];
  const width = Math.max(...options.map((x) => x.spec.length));
  return options.map((x) =>
    [
      x.spec.padEnd(width),
      `${x.providerName}, ${credentialWords(x.credential)}`,
      ...(x.priced ? [] : ["no list price"]),
    ].join("    "),
  );
}

/**
 * The model side of one run (the header's five steps). `route` is what
 * `review()` asks once it has a plan; nothing is read or built before that.
 *
 * `sessions` says the run's sessions are this process's: the host the route
 * is resolved on is then built over a private agent dir of its own, which the
 * run goes on to fill and run in, so the model shown is the model run on. A
 * preview starts nothing and a debug round's pi is a child reading its own
 * copy of the login: for those the host exists for the route alone.
 */
function routeRun(o: {
  models: ReviewModelDeps;
  root: string;
  /** pi's agent dir: the login, the remembered choice and pi's saved provider. */
  agentDir: string;
  /** The run's window: what a borrowed login has to outlast. */
  needMs: number;
  pin: RouteInput["pin"] | undefined;
  sessions: boolean;
  /** A person may be asked which provider (never for a preview or JSON). */
  ask: boolean;
  /** Lines for the preview under the model line. */
  notes: readonly string[];
  say: (line: string) => void;
}): RouteRun {
  const m = o.models;
  /** What is open now: the host, and for a run's host its agent dir. */
  let open: { host: PiHost; agentDir?: string; done: () => void } | undefined;
  let handed: ReviewRunHost = {};
  const close = (): void => {
    const was = open;
    open = undefined;
    was?.done();
  };

  const route = async (): Promise<ReviewRouted> => {
    const remembered = readModelChoice(o.agentDir);
    if (remembered.notice !== undefined) o.say(`note: ${remembered.notice}`);
    // Throws when the login file is there and cannot be read: an unknown
    // store is never taken for an empty one.
    const borrowed = borrowedCredentials({
      srcDir: o.agentDir,
      needMs: o.needMs,
      // Nothing renews the login for a review at a terminal.
      owner: false,
      ...(m.now ? { now: m.now } : {}),
    });
    // Loaded here, not at the top: the pi SDK is needed only once a route is asked for.
    const [{ PiHost: Host, piSavedProvider }, { routeHost, seedHostAgentDir }, sdk] =
      await Promise.all([
        import("@quickchatai/pi-quickreview/src/engine/pisdk.js"),
        import("@quickchatai/pi-quickreview/src/reviewhost.js"),
        import("@quickchatai/pi-quickreview/src/engine/reviewsdk.js"),
      ]);
    const saved = piSavedProvider(o.agentDir);
    const inputsFor = (choice: ModelChoice | undefined): NonNullable<PiHostOptions["route"]> => ({
      skipped: borrowed.skipped,
      ...(o.pin ? { pin: o.pin } : {}),
      ...(choice ? { choice } : {}),
      ...(saved !== undefined
        ? { piProvider: { provider: saved, from: "pi-settings" as const } }
        : {}),
    });
    const configure = m.configureModels ? { configureModels: m.configureModels } : {};
    /** Build the host for `choice` in place of the one open now. */
    const build = async (choice: ModelChoice | undefined): Promise<PiHost> => {
      close();
      const inputs = inputsFor(choice);
      handed = { credentials: borrowed.credentials, route: inputs };
      if (!o.sessions) {
        const made = await routeHost({
          srcAgentDir: o.agentDir,
          tmpDir: m.tmpDir,
          credentials: borrowed.credentials,
          authEnv: m.env,
          route: inputs,
          ...configure,
        });
        open = { host: made.host, done: () => made.dispose() };
        return made.host;
      }
      mkdirSync(m.tmpDir, { recursive: true, mode: 0o700 });
      const scratch = mkdtempSync(join(m.tmpDir, "review-"));
      const remove = (): void => rmSync(scratch, { recursive: true, force: true });
      try {
        const agentDir = join(scratch, "agent");
        seedHostAgentDir({ root: o.root, srcAgentDir: o.agentDir, agentDir });
        const host = await Host.create({
          ...sdk.reviewHostOptions(
            {
              ...m.host,
              processEnv: m.env,
              // The login's own home is fenced by name: the choice file is there too.
              fenceDirs: [o.agentDir, ...(m.host?.fenceDirs ?? [])],
              credentials: borrowed.credentials,
              route: inputs,
            },
            { agentDir, needMs: o.needMs },
          ),
          ...configure,
        });
        open = {
          host,
          agentDir,
          done: () => {
            host.dispose();
            remove();
          },
        };
        handed = { ...handed, prebuilt: (dir) => (dir === agentDir ? host : undefined) };
        return host;
      } catch (e) {
        remove();
        throw e;
      }
    };

    let choice = remembered.choice;
    let host = await build(choice);
    let result = await host.route();
    // Two providers tie and a person is here: ask once, remember the answer,
    // and resolve again with it.
    if (result.ok && result.route.ask && o.ask && m.choose) {
      const options = [result.route, ...result.route.alternatives];
      const picked = await m.choose(
        "pi can run this review on more than one provider:",
        providerRows(result.route),
      );
      const answer = picked === null ? undefined : options[picked];
      if (answer !== undefined) {
        const written = writeModelChoice(o.agentDir, {
          provider: answer.provider,
          model: null,
          via: "ask",
        });
        // A choice that cannot be kept still holds for this run.
        o.say(
          written.ok
            ? `Remembered: ${answer.providerName}. qcr model use <provider> changes it.`
            : written.error,
        );
        choice = {
          provider: answer.provider,
          model: null,
          via: "ask",
          no_estimate_ok: remembered.noEstimateOk,
        };
        host = await build(choice);
        result = await host.route();
      }
    }
    const names = new Map(host.modelRuntime.getProviders().map((p) => [p.id, p.name]));
    const nameOf = (provider: string): string => names.get(provider) ?? provider;
    const inventory = await host.inventory();
    // A host that runs no session has said all it is for.
    if (!o.sessions) close();
    return {
      result: withNames(result, borrowed.skipped, nameOf),
      inventory,
      ...(choice !== undefined ? { prefer: choice.provider } : {}),
      skipped: borrowed.skipped,
      surface: "app",
      facts: {
        agentDir: o.agentDir,
        needMs: o.needMs,
        configPath: m.configPath,
        nameOf,
        ...(m.now ? { now: m.now } : {}),
      },
      notes: o.notes,
    };
  };

  return {
    route,
    host: () => handed,
    prepareHost: (req) => {
      const agentDir = open?.agentDir;
      // The run's own host is built: its agent dir is the run's, and the login
      // stays in the host's memory. Otherwise pi is a child and reads a copy.
      return agentDir !== undefined
        ? prepareHostRun({ ...req, agentDir, auth: "injected", keepAgentDir: true })
        : prepareHostRun(req);
    },
    close,
  };
}

/** The text of a `--diff` argument: stdin for "-", else the file. */
async function readDiffInput(
  source: string,
  deps: Pick<ReviewCliDeps, "cwd" | "readStdin">,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  try {
    if (source === "-") {
      if (!deps.readStdin) return { ok: false, error: "--diff -: standard input is not available" };
      return { ok: true, text: await deps.readStdin() };
    }
    return { ok: true, text: readFileSync(resolve(deps.cwd, source), "utf8") };
  } catch (err) {
    return {
      ok: false,
      error:
        `the diff could not be read from ${source === "-" ? "standard input" : source}: ${err instanceof Error ? err.message : String(err)}`.slice(
          0,
          300,
        ),
    };
  }
}

/** The review target the parsed flags name. */
function targetOf(
  cmd: Extract<ReviewCommand, { help: false }>,
  deps: Pick<ReviewCliDeps, "cwd" | "readStdin">,
): ReviewTarget {
  if (cmd.pr !== undefined)
    return { kind: "pr", pr: cmd.pr, ...(cmd.repo !== undefined ? { repo: cmd.repo } : {}) };
  if (cmd.diff !== undefined) {
    const source = cmd.diff;
    return {
      kind: "diff",
      name: source,
      diff: async () => {
        const read = await readDiffInput(source, deps);
        if (!read.ok) throw new Error(read.error);
        return read.text;
      },
    };
  }
  if (cmd.uncommitted) return { kind: "uncommitted" };
  return { kind: "branch", ...(cmd.base !== undefined ? { base: cmd.base } : {}) };
}

/** Run one `qcr review`; resolves its exit code. Parses the flags, runs
 * `review()` or `preview()` (packages/pi-plugin/src/reviewapi.ts) with the terminal's ports, and
 * prints the result where it goes: the text for a person, the JSON object for
 * an agent, or both. */
export async function runReviewCli(
  rest: readonly string[],
  json: boolean,
  deps: ReviewCliDeps,
): Promise<number> {
  // Before the run settles where results go, the flags say: JSON, else the fallback.
  const fallback: readonly Destination[] = json ? ["json"] : FALLBACK_DESTINATIONS;
  const print = (r: Pick<ReviewResult, "text" | "data" | "destinations">): void => {
    const to = new Set(r.destinations ?? fallback);
    // A file-only destination still tells the terminal what happened.
    if (to.has("terminal") || !to.has("json")) deps.out(r.text);
    if (to.has("json")) deps.out(JSON.stringify(r.data));
  };
  const refuse = (code: number, errors: string[]): number => {
    print({
      text: errors.map((e) => `✗ ${e}`).join("\n"),
      data: withSchemaVersion(REVIEW_SCHEMA_VERSION, { ok: false, errors }) as ReviewData,
      destinations: null,
    });
    return code;
  };
  let cmd: ReviewCommand;
  try {
    cmd = parseReviewArgs(rest);
  } catch (err) {
    return refuse(2, [err instanceof Error ? err.message : String(err)]);
  }
  if (cmd.help) {
    deps.out(reviewHelp());
    return 0;
  }
  if (cmd.debugPi && (json || deps.debugPi === undefined))
    return refuse(2, [
      "--debug-pi runs the round inside pi's interactive UI and needs a terminal (not --json, not a detached run)",
    ]);
  const storeDir = deps.storeDir !== undefined ? deps.storeDir : reviewHome();
  // Where the result goes (packages/pi-plugin/src/reviewdest.ts): the flags,
  // else the repo's saved default, else the person is asked, every time, else
  // it is printed. A preview starts nothing and a debug round posts nothing,
  // so neither asks: they keep the flags alone.
  let destinations: Destination[] = [...(json ? (["json"] as const) : []), ...(cmd.to ?? [])];
  if (!cmd.preview && !cmd.debugPi) {
    const plan = planDestinations({
      explicit: [...(cmd.to ?? []), ...(cmd.out !== undefined ? (["file"] as const) : [])],
      json,
      interactive: deps.pick !== undefined,
      saved: loadDefaultDestinationsIn(storeDir, deps.cwd),
      target: { pr: cmd.pr !== undefined },
      surface: "terminal",
    });
    if (plan.kind === "fixed") destinations = plan.destinations;
    else {
      const picked = await deps.pick!("Where should the review go?", plan.menu);
      if (picked === null) return refuse(1, ["review cancelled: no destination was picked"]);
      destinations = picked.destinations;
      const say = deps.warn ?? ((l: string) => console.error(l));
      if (picked.remember && saveDefaultDestinationsIn(storeDir, deps.cwd, destinations))
        say("kept as this repo's default: pass --to to choose otherwise");
    }
  }
  const debug = cmd.debugPi && deps.debugPi !== undefined;
  // `--model` is the whole review's model for this run: every tier and lens
  // the config pins to a model of its own loses that model and keeps its
  // level. The main session names no model either and runs on the route, at
  // the level the flag names, else the config's; a debug round's pi is a
  // child that reads the flag's own text.
  let cfg = deps.cfg;
  const notes: string[] = [];
  if (cmd.model !== undefined) {
    const stripped = stripPins(deps.cfg);
    const level =
      splitModelSpec(cmd.model).thinking !== null
        ? null
        : splitModelSpec(deps.cfg.models.model).thinking;
    cfg = {
      ...stripped.cfg,
      models: {
        ...stripped.cfg.models,
        model: debug ? cmd.model : level !== null ? `:${level}` : "",
      },
    };
    if (stripped.replaced > 0)
      notes.push(
        `--model replaces ${stripped.replaced} pinned tier and lens model${stripped.replaced === 1 ? "" : "s"} for this run`,
      );
  }
  const say = deps.warn ?? ((l: string) => console.error(l));
  const routed =
    deps.models !== undefined
      ? routeRun({
          models: deps.models,
          root: deps.root,
          agentDir: deps.agentDir,
          needMs: deps.timeoutMs,
          pin:
            cmd.model !== undefined
              ? { text: cmd.model, from: "flag" }
              : isPinned(deps.cfg.models.model)
                ? { text: deps.cfg.models.model, from: "config" }
                : undefined,
          sessions: !cmd.preview && !debug,
          ask: !cmd.preview && !json,
          notes,
          say,
        })
      : undefined;
  const runtime = deps.runtime;
  const opts: ReviewOptions = {
    repoDir: deps.cwd,
    root: deps.root,
    agentDir: deps.agentDir,
    runsDir: deps.runsDir,
    dryrunDir: deps.dryrunDir,
    storeDir,
    config: cfg,
    ecosystem: deps.ecosystem,
    ...(deps.profileHomes ? { profileHomes: deps.profileHomes } : {}),
    // `qcr review` runs one review per process: its one runtime is that run's,
    // and what it holds goes with the process. It is asked for when the round
    // starts, after the route: the host the route was resolved on is its host.
    runtime: () => (typeof runtime === "function" ? runtime(routed?.host() ?? {}) : runtime),
    ...(routed ? { route: routed.route } : {}),
    prepareHost: routed ? routed.prepareHost : prepareHostRun,
    ...(debug ? { debugRound: deps.debugPi! } : {}),
    ...(deps.memory !== undefined ? { memory: deps.memory } : {}),
    destinations,
    ...(cmd.out !== undefined ? { reportFile: resolve(deps.cwd, cmd.out) } : {}),
    full: cmd.full,
    // `--security`: the person at the terminal asks for the whole security
    // family, as `/qcr-review --security` does; the terminal knows no login
    // to name, so the plan says who asked by role.
    ...(cmd.securityRequest ? { securityRequest: { by: "", source: "operator" as const } } : {}),
    limits: {
      ...(deps.route !== undefined ? { route: deps.route } : {}),
      ...(cmd.limit !== undefined ? { limitUsd: cmd.limit } : {}),
      ...(cmd.key !== undefined ? { key: cmd.key } : {}),
      timeoutMs: deps.timeoutMs,
    },
    ...(deps.pr ? { github: deps.pr } : {}),
  };
  const io: ReviewIo = {
    confirm: deps.confirm,
    // The preview and the memory notice go before the run, unless the output is JSON.
    ...(json ? {} : { progress: deps.out }),
    warn: deps.warn ?? ((l) => console.error(l)),
    ...(deps.log ? { log: deps.log } : {}),
  };
  const target = targetOf(cmd, deps);
  let result: ReviewResult;
  try {
    result = cmd.preview ? await preview(target, opts, io) : await review(target, opts, io);
  } finally {
    // The route's host and its private agent dir go with the run.
    routed?.close();
  }
  print(result);
  return result.exitCode;
}

/** The run id and container name the host wrapper hands a review container
 * (QCR_RUN_ID, QCR_REVIEW_CONTAINER), when both are well-formed. */
export function containerRunEnv(
  env: Readonly<Record<string, string | undefined>>,
): { id: string; name: string } | undefined {
  const id = env["QCR_RUN_ID"];
  const name = env["QCR_REVIEW_CONTAINER"];
  if (!id || !name) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) return undefined;
  return { id, name };
}

/** The runtime `[engine] runtime` selects for `qcr review`: the SDK runtime.
 * `[pi] lens_runtime = engine` is
 * the SDK runtime with our lens tools; with `[pi] engine_wave` the runtime
 * carries the board the round starts the planned wave on. */
export function selectReviewRuntime(
  cfg: Pick<CoreConfig, "engine" | "pi">,
  /** The model side the route resolved for the run. Omitted: the runtime
   * reads the login from the run's agent dir and resolves a model itself. */
  host: ReviewRunHost = {},
): EngineRouteRuntime {
  // A stop signal that arrives before the host is built already ends the run
  // as an SDK stop.
  markSdkRoute();
  return lazyReviewRuntime(cfg, {
    // `qcr review` owns its process: a wedged turn exits it, the round's
    // diagnostics go to stderr, and the fence knows this user's home.
    backstop: () => process.exit(BUDGET_EXIT_CODE),
    warn: (line) => console.error(line),
    homeDir: homedir(),
    ...host,
  });
}

/** The terminal side: the real repo, root, login and a prompt on stdin. */
export async function cmdReview(
  rest: string[],
  json: boolean,
  io: {
    out?: (line: string) => void;
    runsDir?: string;
    /** The install's memory, from its config; the host injects it (src/cli.ts
     * passes the app's, src/reviewmemory.ts). Absent: no memory. */
    memory?: (configPath: string) => ReviewMemoryPort | null;
  } = {},
): Promise<number> {
  // Detached runs for plugins (src/reviewdetach.ts): `start | status | stop`,
  // and the child `start` launches.
  if (rest[0] === "start" || rest[0] === "status" || rest[0] === "stop") {
    const verb = rest[0];
    const { randomBytes } = await import("node:crypto");
    const det = await import("./reviewdetach.js");
    const { stateHome } = await import("./homes.js");
    // In the release image the host wrapper makes the run a container of its own
    //: it names the container and the id, and starts the driver itself.
    const container = containerRunEnv(process.env);
    return det.runDetachedVerb(verb, rest.slice(1), json, {
      home: join(stateHome(), "review", "detached"),
      out: (l) => console.log(l),
      now: Date.now,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      newId: () =>
        container?.id ??
        `${new Date()
          .toISOString()
          .replace(/[^0-9]/g, "")
          .slice(0, 14)}-${randomBytes(3).toString("hex")}`,
      liveContainers: () => det.liveContainersFromEnv(process.env),
      alive: (pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      },
      kill: (pid, sig) => process.kill(-pid, sig),
      identify: (args) => det.identifyTarget(args, process.cwd()),
      launch: (l) =>
        container !== undefined
          ? { ok: true, pid: null, container: container.name }
          : det.launchDetached({
              ...det.detachedCommand(l),
              dir: l.dir,
              env: process.env,
            }),
      watch: (w) => {
        det.launchDetached({
          ...det.watchdogCommand(w),
          dir: w.dir,
          env: process.env,
          log: "watchdog.log",
        });
      },
    });
  }
  if (rest[0] === "--watchdog") {
    const [, dir, key, pid] = rest;
    if (!dir || !key || !/^\d+$/.test(pid ?? "")) return 2;
    const det = await import("./reviewdetach.js");
    await det.runWatchdog(
      { dir, key, pid: Number(pid) },
      {
        now: Date.now,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        alive: (p) => {
          try {
            process.kill(p, 0);
            return true;
          } catch {
            return false;
          }
        },
        kill: (pgid, sig) => process.kill(-pgid, sig),
      },
    );
    return 0;
  }
  if (rest[0] === "--container-run") {
    // The driver of a run the wrapper claimed: this container is the run.
    const container = containerRunEnv(process.env);
    if (!container || rest[1] !== container.id || rest.length !== 2) return 2;
    const { stateHome } = await import("./homes.js");
    const det = await import("./reviewdetach.js");
    const claimed = det.readContainerRun(
      join(stateHome(), "review", "detached"),
      container.id,
      container.name,
    );
    if (claimed === null) {
      console.error(`no claimed review run ${container.id} for this container`);
      return 1;
    }
    // Nobody reads this container's own output once it is gone: keep it with the run.
    const log = openSync(join(claimed.dir, "driver.log"), "a");
    for (const stream of [process.stdout, process.stderr])
      stream.write = (chunk: string | Uint8Array): boolean => {
        writeSync(log, typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
        return true;
      };
    let code = 1;
    await det.runDetachedChild({
      dir: claimed.dir,
      key: claimed.key,
      run: async (out) => {
        code = await cmdReview([...claimed.argv, "--json"], true, {
          out,
          runsDir: join(claimed.dir, "work"),
          ...(io.memory ? { memory: io.memory } : {}),
        });
        return code;
      },
    });
    return code;
  }
  if (rest[0] === "--detached-run") {
    const dir = rest[1];
    const key = rest[2];
    if (!dir || !key) return 2;
    const det = await import("./reviewdetach.js");
    let code = 1;
    await det.runDetachedChild({
      dir,
      key,
      run: async (out) => {
        code = await cmdReview(rest.slice(3), true, {
          out,
          runsDir: join(dir, "work"),
          ...(io.memory ? { memory: io.memory } : {}),
        });
        return code;
      },
    });
    return code;
  }
  const { assetRoot } = await import("@quickchatai/pi-quickreview/src/assetroot.js");
  const { homeProfilePlaces, loadOneShotConfig, stateHome } = await import("./homes.js");
  const { contextFrom } = await import("@quickchatai/pi-quickreview/src/engine/context.js");
  const { createInterface } = await import("node:readline/promises");
  const { homedir } = await import("node:os");
  const root = assetRoot();
  // The install's config, or the shipped defaults when it has none.
  const loaded = loadOneShotConfig({ root, warn: (l) => console.warn(l) });
  const profileHomes = homeProfilePlaces();
  const { cfg, ecosystem } = contextFrom(root, loaded, loaded.cfg.review.profile, "", {
    homes: profileHomes,
  });
  const interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY);
  const readStdin = async (): Promise<string> => {
    if (process.stdin.isTTY) throw new Error("standard input is a terminal: pipe a diff in");
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  };
  const agentDir =
    process.env["PI_CODING_AGENT_DIR"]?.trim() ||
    join(process.env["HOME"] || homedir(), ".pi", "agent");
  const route = routeFromEnv(process.env);
  // A stop that arrives while the route is being resolved, before any runtime
  // is built, already ends the run as an SDK stop.
  markSdkRoute();
  return runReviewCli(rest, json, {
    cwd: process.cwd(),
    readStdin,
    route,
    // The model: whatever pi has a credential for (the header's five steps).
    // Nothing is checked here ahead of the review: a run with no usable model
    // is refused where the route is resolved, in the route's own words.
    models: {
      env: process.env,
      tmpDir: join(stateHome(), "tmp"),
      configPath: loaded.path,
      choose: interactive
        ? async (question, rows) => {
            const rl = createInterface({ input: process.stdin, output: process.stderr });
            try {
              const list = rows.map((r, i) => `  ${i + 1}) ${r}`).join("\n");
              for (;;) {
                const a = (await rl.question(`${question}\n${list}\nWhich one? [1] `)).trim();
                if (a === "") return 0;
                if (/^\d+$/.test(a) && Number(a) >= 1 && Number(a) <= rows.length)
                  return Number(a) - 1;
              }
            } catch {
              // the terminal went away: the order's own pick runs, unremembered
              return null;
            } finally {
              rl.close();
            }
          }
        : null,
      host: { homeDir: homedir() },
    },
    out: io.out ?? ((l) => console.log(l)),
    confirm: interactive
      ? async (q) => {
          const rl = createInterface({ input: process.stdin, output: process.stderr });
          try {
            return /^y(es)?$/i.test((await rl.question(`${q} [y/N] `)).trim());
          } finally {
            rl.close();
          }
        }
      : null,
    ...(interactive
      ? {
          pick: async (q: string, menu: DestinationMenuItem[]): Promise<DestinationPick | null> => {
            const rl = createInterface({ input: process.stdin, output: process.stderr });
            try {
              const lines = menu.map((m, i) => `  ${i + 1}) ${m.label}`).join("\n");
              for (;;) {
                const a = (await rl.question(`${q}\n${lines}\n[1-${menu.length}, q to cancel] `))
                  .trim()
                  .toLowerCase();
                if (a === "q" || a === "quit") return null;
                const m = menu[Number(a) - 1];
                if (m) return m.pick;
              }
            } finally {
              rl.close();
            }
          },
        }
      : {}),
    root,
    profileHomes,
    agentDir,
    cfg,
    ecosystem,
    runtime: (host) => selectReviewRuntime(cfg, host),
    // A round inside interactive pi needs the whole terminal.
    ...(interactive && process.stdout.isTTY
      ? {
          debugPi: async (spec: RoundSpec): Promise<OneShotResult> =>
            (await import("./engine/debugpi.js")).runDebugRound(spec),
        }
      : {}),
    runsDir: io.runsDir ?? join(stateHome(), "review", "runs"),
    dryrunDir: join(stateHome(), "review", "dryrun"),
    // Memory reads the install's own config; the shipped defaults set none up.
    memory: loaded.path === null ? null : (io.memory?.(loaded.path) ?? null),
    timeoutMs: 60 * 60_000,
    log: (l) => console.error(l),
  });
}
