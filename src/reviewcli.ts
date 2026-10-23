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
// Exit codes follow `qcr scan`: 0 done; 1 refused, declined, failed or
// stopped short (partial); 2 usage.
import { existsSync, openSync, readFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CoreConfig } from "@quickchatai/pi-quickreview/src/reviewconfig.js";
import type { Ecosystem } from "@quickchatai/pi-quickreview/src/ecosystem.js";
import type { ReviewMemoryPort } from "@quickchatai/pi-quickreview/src/memoryport.js";
import type { ProfilePlace } from "@quickchatai/pi-quickreview/src/profilelookup.js";
import type { PrCredentialDeps, PrFetchRequest } from "@quickchatai/pi-quickreview/src/prtarget.js";
import {
  FALLBACK_DESTINATIONS,
  parseDestinations,
  type Destination,
  type DestinationChoice,
} from "@quickchatai/pi-quickreview/src/reviewdest.js";
import type { OneShotResult } from "@quickchatai/pi-quickreview/src/oneshot.js";
import type { RoundSpec } from "@quickchatai/pi-quickreview/src/engine/round.js";
import { BUDGET_EXIT_CODE } from "@quickchatai/pi-quickreview/src/engine/budget.js";
import { prepareHostRun } from "./hostroute.js";
import type { Runtime } from "@quickchatai/pi-quickreview/src/engine/port.js";
import { selectRuntime } from "@quickchatai/pi-quickreview/src/engine/select.js";
import {
  LensWave,
  type EngineRoute,
  type EngineRouteRuntime,
} from "@quickchatai/pi-quickreview/src/engine/lens/wave.js";
import { markSdkRoute } from "@quickchatai/pi-quickreview/src/engine/livesessions.js";
import {
  REVIEW_SCHEMA_VERSION,
  withSchemaVersion,
} from "@quickchatai/pi-quickreview/src/contract.js";
import {
  preview,
  review,
  type ReviewData,
  type ReviewIo,
  type ReviewOptions,
  type ReviewResult,
  type ReviewRoute,
  type ReviewTarget,
} from "@quickchatai/pi-quickreview/src/reviewapi.js";
import { reviewHome } from "./reviewhome.js";

export const REVIEW_USAGE =
  "usage: qcr review start|status|stop (detached runs, see `qcr review start --help`) | qcr review [branch | --uncommitted | --diff FILE|- | <PR number|URL>] [--repo OWNER/NAME] [--base REF] [--preview] [--key K] [--limit USD] [--full] [--to DEST] [--out FILE] [--debug-pi] [--json] | --help";

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
    "  --full            review the whole branch again, ignoring what an earlier review left",
    "  --json            one JSON object instead of text (the agent destination)",
    "  --to DEST         where the result goes, for this run: terminal, file, json, pr (comma-separated;\n                    pr posts a comment-only review to the PR and needs a PR target)",
    "  --out FILE        write the markdown report to FILE (implies file)",
    "  --debug-pi        run the round inside pi's own interactive UI, to watch it live: the lenses run as",
    "                    this pi's in-process sessions, and the round starts from the /qcr-round command.\n                    Needs a terminal, posts nothing, and finished sessions stay openable (qcr open)",
    "",
    "Destinations: with none given, the repo's saved default is used; with none saved, an",
    "interactive run asks and saves the answer for this repo (in the install's state home), and a run",
    "with no terminal prints the terminal text plus JSON and never waits.",
    "",
    "Posting (--to pr, or saved as the default) sends one review whose event is always",
    "COMMENT, never an approval or a change request. Every comment says it came from qcr",
    "and carries the hidden finding markers, and findings already on the PR are skipped.",
    "It posts as the credential the PR was read with, or the source named by `post_as`",
    "(app, handoff, gh, env:GITHUB_TOKEN, env:GH_TOKEN) in `.git/qcr-review.json`. The post goes",
    "through the mutation gate: with `dry_run = true` in the install's config the review is",
    "recorded under state/dryrun/ and nothing is sent.",
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

export type ReviewCommand =
  | { help: true }
  | {
      help: false;
      uncommitted: boolean;
      /** `--diff`: a file to read the diff from, or "-" for stdin. */
      diff?: string;
      pr?: string;
      repo?: string;
      base?: string;
      preview: boolean;
      key?: string;
      limit?: number;
      full: boolean;
      to?: Destination[];
      out?: string;
      /** `--debug-pi`: the round runs inside interactive pi. */
      debugPi: boolean;
    };

const usage = (why?: string): Error => new Error(why ? `${REVIEW_USAGE}\n(${why})` : REVIEW_USAGE);

/** `qcr review`'s arguments (`--json` taken off before). An unknown token is
 * refused, so a mistyped flag never runs something else. */
export function parseReviewArgs(rest: readonly string[]): ReviewCommand {
  let help = false;
  let uncommitted = false;
  let diff: string | undefined;
  let preview = false;
  let full = false;
  let base: string | undefined;
  let pr: string | undefined;
  let repo: string | undefined;
  let key: string | undefined;
  let limit: number | undefined;
  let to: Destination[] | undefined;
  let out: string | undefined;
  let debugPi = false;
  const value = (i: number, flag: string): string => {
    const v = rest[i + 1];
    if (v === undefined || v.startsWith("--")) throw usage(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--help" || a === "-h") help = true;
    else if (a === "--preview") preview = true;
    else if (a === "--full") full = true;
    else if (a === "--debug-pi") debugPi = true;
    else if (a === "--base") base = value(i++, a);
    else if (a === "--diff") {
      // "-" is stdin; a file whose name begins with "-" is written ./-name
      const v = rest[i + 1];
      if (v === undefined || (v !== "-" && v.startsWith("-")))
        throw usage("--diff needs a file, or - for stdin");
      diff = v;
      i++;
    } else if (a === "--repo") repo = value(i++, a);
    else if (a === "--key") key = value(i++, a);
    else if (a === "--to") {
      try {
        to = parseDestinations(value(i++, a));
      } catch (err) {
        throw usage(err instanceof Error ? err.message : String(err));
      }
    } else if (a === "--out") out = value(i++, a);
    else if (a === "--limit") {
      const n = Number(value(i++, a));
      if (!Number.isFinite(n) || n <= 0)
        throw usage("--limit must be a positive number of dollars");
      limit = n;
    } else if (a === "branch") continue;
    else if (a === "--uncommitted") uncommitted = true;
    else if (/^#?\d+$/.test(a) || /^https?:\/\//.test(a)) {
      if (pr !== undefined) throw usage("one PR at a time");
      pr = a;
    } else throw usage(`unknown argument ${a}`);
  }
  if (help) return { help: true };
  if (uncommitted && base !== undefined)
    throw usage("--uncommitted reviews against HEAD; --base does not apply");
  if (uncommitted && rest.includes("branch"))
    throw usage("choose one target: branch or --uncommitted");
  if (uncommitted && pr !== undefined) throw usage("choose one target: --uncommitted or a PR");
  if (diff !== undefined) {
    if (uncommitted || pr !== undefined || rest.includes("branch"))
      throw usage("choose one target: branch, --uncommitted, --diff or a PR");
    if (base !== undefined) throw usage("--diff carries its own changes; --base does not apply");
    if (repo !== undefined) throw usage("--repo goes with a PR number or URL");
  }
  if (debugPi && preview) throw usage("--debug-pi runs a round; a preview starts nothing");
  if (debugPi && to?.includes("pr")) throw usage("a debug round posts nothing: drop --to pr");
  if (pr !== undefined && base !== undefined) throw usage("--base applies to a branch, not a PR");
  if (pr === undefined && repo !== undefined) throw usage("--repo goes with a PR number or URL");
  return {
    help: false,
    uncommitted,
    ...(diff !== undefined ? { diff } : {}),
    ...(pr !== undefined ? { pr } : {}),
    ...(repo !== undefined ? { repo } : {}),
    preview,
    full,
    debugPi,
    ...(base !== undefined ? { base } : {}),
    ...(key !== undefined ? { key } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(to !== undefined ? { to } : {}),
    ...(out !== undefined ? { out } : {}),
  };
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
  /** Ask the person to pick one option. Absent: the session is not interactive,
   * so the destination question is never asked. */
  choose?: (question: string, options: DestinationChoice[]) => Promise<Destination>;
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
  /** Hosts the review session (`[engine] runtime`, the SDK). */
  runtime: Runtime;
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
  const opts: ReviewOptions = {
    repoDir: deps.cwd,
    root: deps.root,
    agentDir: deps.agentDir,
    runsDir: deps.runsDir,
    dryrunDir: deps.dryrunDir,
    storeDir: deps.storeDir !== undefined ? deps.storeDir : reviewHome(),
    config: deps.cfg,
    ecosystem: deps.ecosystem,
    ...(deps.profileHomes ? { profileHomes: deps.profileHomes } : {}),
    // `qcr review` runs one review per process: its one runtime is that run's,
    // and what it holds goes with the process.
    runtime: () => deps.runtime,
    prepareHost: prepareHostRun,
    ...(cmd.debugPi && deps.debugPi !== undefined ? { debugRound: deps.debugPi } : {}),
    ...(deps.memory !== undefined ? { memory: deps.memory } : {}),
    destinations: [...(json ? (["json"] as const) : []), ...(cmd.to ?? [])],
    ...(cmd.out !== undefined ? { reportFile: resolve(deps.cwd, cmd.out) } : {}),
    full: cmd.full,
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
    ...(deps.choose ? { choose: deps.choose } : {}),
    // The preview and the memory notice go before the run, unless the output is JSON.
    ...(json ? {} : { progress: deps.out }),
    warn: deps.warn ?? ((l) => console.error(l)),
    ...(deps.log ? { log: deps.log } : {}),
  };
  const target = targetOf(cmd, deps);
  const result = cmd.preview ? await preview(target, opts, io) : await review(target, opts, io);
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

/** The CLI entry the detached driver re-runs: `cli` beside this module. Read
 * from where this module is, not from `process.argv[1]`, which is whatever the
 * person launched (a bin symlink, a wrapper, a test runner). */
export function detachedEntry(metaUrl: string = import.meta.url): string {
  return fileURLToPath(new URL(`./cli${extname(fileURLToPath(metaUrl))}`, metaUrl));
}

/** The process `qcr review start` detaches: this node, this entry, the run's
 * directory and key, the review's own arguments. */
export function detachedCommand(
  l: { dir: string; key: string; argv: readonly string[] },
  o: { entry?: string; execPath?: string; execArgv?: readonly string[] } = {},
): { command: string; args: string[] } {
  return {
    command: o.execPath ?? process.execPath,
    args: [
      ...(o.execArgv ?? process.execArgv),
      o.entry ?? detachedEntry(),
      "review",
      "--detached-run",
      l.dir,
      l.key,
      ...l.argv,
      "--json",
    ],
  };
}

/** The watchdog `qcr review start` detaches beside the run: this node, this
 * entry, the run's directory, key and driver pid. */
export function watchdogCommand(
  w: { dir: string; key: string; pid: number },
  o: { entry?: string; execPath?: string; execArgv?: readonly string[] } = {},
): { command: string; args: string[] } {
  return {
    command: o.execPath ?? process.execPath,
    args: [
      ...(o.execArgv ?? process.execArgv),
      o.entry ?? detachedEntry(),
      "review",
      "--watchdog",
      w.dir,
      w.key,
      String(w.pid),
    ],
  };
}

/** The runtime `[engine] runtime` selects for `qcr review`: the SDK runtime.
 * `[pi] lens_runtime = engine` is
 * the SDK runtime with our lens tools; with `[pi] engine_wave` the runtime
 * carries the board the round starts the planned wave on. */
export function selectReviewRuntime(cfg: Pick<CoreConfig, "engine" | "pi">): EngineRouteRuntime {
  const engine = cfg.pi.lens_runtime === "engine";
  return selectRuntime(cfg.engine.runtime, "review", () => {
    // The SDK host loads on the first session, not at startup: a preview, a
    // refusal and `review status` never pay for the pi SDK. A stop signal that
    // arrives before it is built already ends the run as an SDK stop.
    markSdkRoute();
    const wave = new LensWave();
    let host: Promise<EngineRouteRuntime> | undefined;
    const load = (): Promise<EngineRouteRuntime> =>
      (host ??= import("@quickchatai/pi-quickreview/src/engine/reviewsdk.js").then((m) =>
        m.reviewSdkRuntime({
          ...(engine ? { engine: { wave, plannedWave: cfg.pi.engine_wave } } : {}),
          // `qcr review` owns its process: a wedged turn exits it, the round's
          // diagnostics go to stderr, and the fence knows this user's home.
          backstop: () => process.exit(BUDGET_EXIT_CODE),
          warn: (line) => console.error(line),
          homeDir: homedir(),
        }),
      ));
    const engineLens: EngineRoute = {
      wave,
      runner: { run: async (request) => (await load()).engineLens!.runner.run(request) },
      plannedWave: cfg.pi.engine_wave,
    };
    return {
      create: async (spec) => (await load()).create(spec),
      resume: async (file, spec) => (await load()).resume(file, spec),
      // The round reads this before any session exists, so it is named here and
      // reaches the runner the host builds.
      ...(engine ? { engineLens } : {}),
    };
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
              ...detachedCommand(l),
              dir: l.dir,
              env: process.env,
            }),
      watch: (w) => {
        det.launchDetached({
          ...watchdogCommand(w),
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
  if (!existsSync(join(agentDir, "auth.json")) && !json)
    console.error(
      `note: no pi login at ${agentDir} — run \`qcr scan login\` first if the review fails`,
    );
  let runtime: Runtime;
  try {
    runtime = selectReviewRuntime(cfg);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  return runReviewCli(rest, json, {
    cwd: process.cwd(),
    readStdin,
    route: routeFromEnv(process.env),
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
          choose: async (q: string, options: DestinationChoice[]): Promise<Destination> => {
            const rl = createInterface({ input: process.stdin, output: process.stderr });
            try {
              const menu = options.map((o, i) => `  ${i + 1}) ${o.label}`).join("\n");
              for (;;) {
                const a = (
                  await rl.question(
                    `${q}\n${menu}\nThis is saved for this repo. [1-${options.length}] `,
                  )
                ).trim();
                const o = options[Number(a) - 1] ?? options.find((x) => x.value === a);
                if (o) return o.value;
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
    runtime,
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
